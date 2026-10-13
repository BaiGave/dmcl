import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDist, repoDist } from "./dist-loader";
import { getConcurrencyLimits, getGovernorStatus } from "./concurrency-governor";
import { getDefaultRunner, type GradleRunner, type JobPhase, type StepContext, type StepResult } from "./gradle-runner";

/**
 * The job queue behind the GUI's build and launch buttons.
 *
 * - "build": explicit `gradlew build`;
 * - "run": launch = `gradlew runClient` only (compiles what it needs, no tests/full build);
 * - "build+run": build, then a smoke launch that stops at the title screen (new-variant verification).
 *
 * Every queued job starts at once and then waits for its slot in the process scheduler, so a launch
 * never waits behind unrelated builds and changing the limits never cancels running work. One job per
 * variant runs at a time. Jobs keep a bounded in-memory log for the API; finished jobs are saved to
 * `<variant>/.dmcl/logs/`.
 */

type LoaderId = "fabric" | "forge" | "neoforge";

export interface BuildJob {
  id: string;
  variantId: string;
  projectPath: string;
  type: "build" | "run" | "build+run";
  loader?: string;
  mcVersion?: string;
  /** run: close the client a moment after the title screen (smoke launch). */
  stopAtTitle?: boolean;
  /** Display name of the mod, for labels. */
  modName?: string;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** What GET /api/jobs/:id returns. */
export interface JobView {
  jobId: string;
  variantId: string;
  kind: "build" | "run";
  /** The queue's job type ("build+run" = build then smoke launch). */
  type: BuildJob["type"];
  state: JobState;
  phase: JobPhase;
  /** What is happening in the phase, e.g. the current Gradle task. */
  phaseDetail: string | null;
  /** ISO times. startedAt = when the job was requested. */
  startedAt: string;
  phaseStartedAt: string;
  finishedAt: string | null;
  reason: string | null;
  logLineCount: number;
  label: string;
  loader: string | null;
  mcVersion: string | null;
  projectPath: string;
  /** run: Gradle start to title screen. */
  timeToTitleMs: number | null;
  javaMajor: number | null;
}

export function variantJobLabel(job: Pick<BuildJob, "loader" | "mcVersion">): string {
  if (job.loader && job.mcVersion) return `${job.loader} ${job.mcVersion}`;
  return "变体";
}

export interface BuildEvent {
  type: "start" | "progress" | "phase" | "done" | "queue" | "cancelled";
  job?: BuildJob;
  view?: JobView;
  line?: string;
  success?: boolean;
  queueLength?: number;
}

type JobCallback = (event: BuildEvent) => void;

/** Persists variant activity/results; the GUI uses the workspace store, tests a fake. */
export interface VariantStatusSink {
  setActivity(variantId: string, activity: { state: "queued" | "running"; kind: "build" | "run"; jobId: string } | null): void;
  recordResult(variantId: string, result: {
    kind: "build" | "run";
    state: "succeeded" | "failed" | "cancelled";
    at: string;
    reason: string | null;
    phaseReached: string | null;
    startedAt?: string;
    durationMs?: number;
    timeToTitleMs?: number;
    javaMajor?: number | null;
    exitCode?: number | null;
  }): void;
}

const LOG_LINE_LIMIT = 20_000;
const LOG_PAGE_LIMIT = 2_000;
/** Finished jobs whose log stays in memory; older ones serve their log from the saved file. */
const FINISHED_IN_MEMORY_LOGS = 30;

interface JobRecord {
  job: BuildJob;
  state: JobState;
  phase: JobPhase;
  phaseDetail: string | null;
  requestedAt: number;
  phaseStartedAt: number;
  finishedAt: number | null;
  reason: string | null;
  /** Ring buffer: lines[i] has absolute index logBase + i. */
  lines: string[];
  logBase: number;
  timeToTitleMs: number | null;
  javaMajor: number | null;
  cancelRequested: boolean;
  /** Saved log file; once the in-memory lines are evicted, /log reads from it. */
  savedLogPath: string | null;
  logEvicted: boolean;
  /** Total line count, kept when the in-memory lines are evicted. */
  evictedLineCount: number;
}

const jobs = new Map<string, JobRecord>();
let order: string[] = [];
let listeners: JobCallback[] = [];
let runnerOverride: GradleRunner | null = null;
let sinkOverride: VariantStatusSink | null = null;

/** @internal tests: inject a runner */
export function setRunnerForTests(runner: GradleRunner | null): void {
  runnerOverride = runner;
}

/** @internal tests: inject the status sink */
export function setStatusSinkForTests(sink: VariantStatusSink | null): void {
  sinkOverride = sink;
}

/** @internal tests: reset module state */
export function resetBuildQueueForTests(): void {
  jobs.clear();
  order = [];
  listeners = [];
  runnerOverride = null;
  sinkOverride = null;
  liveLogsByVariant.clear();
}

function runner(): GradleRunner {
  return runnerOverride ?? getDefaultRunner();
}

let storeSink: Promise<VariantStatusSink | null> | null = null;
async function statusSink(): Promise<VariantStatusSink | null> {
  if (sinkOverride) return sinkOverride;
  storeSink ??= loadDist(repoDist("workspace", "store.js"))
    .then((mod: any) => {
      const store = mod.getWorkspace();
      return {
        setActivity: (variantId, activity) => store.setVariantActivity(variantId, activity),
        recordResult: (variantId, result) => store.recordVariantResult(variantId, result),
      } as VariantStatusSink;
    })
    .catch(() => null);
  return storeSink;
}

async function updateSink(fn: (sink: VariantStatusSink) => void): Promise<void> {
  try {
    const sink = await statusSink();
    if (sink) fn(sink);
  } catch {
    // Status bookkeeping must never break a job.
  }
}

export function onBuildEvent(cb: JobCallback): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function emit(event: BuildEvent): void {
  for (const cb of listeners) {
    try {
      cb(event);
    } catch { /* a listener must not break the queue */ }
  }
}

function kindOf(type: BuildJob["type"]): "build" | "run" {
  return type === "run" ? "run" : "build";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function jobLabel(job: BuildJob): string {
  const verb = job.type === "build" ? "build" : "runClient";
  const name = job.modName ?? path.basename(path.dirname(job.projectPath));
  return `DMCL ${verb} ${name} ${path.basename(job.projectPath)}`;
}

function toView(record: JobRecord): JobView {
  const { job } = record;
  return {
    jobId: job.id,
    variantId: job.variantId,
    kind: kindOf(job.type),
    type: job.type,
    state: record.state,
    phase: record.phase,
    phaseDetail: record.phaseDetail,
    startedAt: iso(record.requestedAt),
    phaseStartedAt: iso(record.phaseStartedAt),
    finishedAt: record.finishedAt === null ? null : iso(record.finishedAt),
    reason: record.reason,
    logLineCount: record.logEvicted ? record.evictedLineCount : record.logBase + record.lines.length,
    label: variantJobLabel(job),
    loader: job.loader ?? null,
    mcVersion: job.mcVersion ?? null,
    projectPath: job.projectPath,
    timeToTitleMs: record.timeToTitleMs,
    javaMajor: record.javaMajor,
  };
}

function isActive(record: JobRecord): boolean {
  return record.state === "queued" || record.state === "running";
}

function activeRecords(): JobRecord[] {
  return order.map((id) => jobs.get(id)!).filter((record) => record && isActive(record));
}

/** The job currently executing for a variant (started, not finished). */
function executingRecord(variantId: string): JobRecord | undefined {
  return activeRecords().find((record) => record.job.variantId === variantId && executing.has(record.job.id));
}

function waitingRecord(variantId: string): JobRecord | undefined {
  return activeRecords().find((record) => record.job.variantId === variantId && !executing.has(record.job.id));
}

const executing = new Set<string>();

// ---------------------------------------------------------------- public queries

export function getJob(jobId: string): JobView | null {
  const record = jobs.get(jobId);
  return record ? toView(record) : null;
}

/** Active jobs first (oldest first), then recently finished ones (newest first). */
export function listJobs(): JobView[] {
  const all = order.map((id) => jobs.get(id)!).filter(Boolean);
  const active = all.filter(isActive);
  const finished = all.filter((record) => !isActive(record)).reverse();
  return [...active, ...finished].map(toView);
}

export function getJobLog(jobId: string, from = 0): { lines: string[]; next: number; done: boolean } | null {
  const record = jobs.get(jobId);
  if (!record) return null;
  if (record.logEvicted) {
    let all: string[] = [];
    try {
      all = record.savedLogPath ? fs.readFileSync(record.savedLogPath, "utf8").split("\n") : [];
    } catch {
      all = [];
    }
    const begin = Math.max(0, Math.floor(Number.isFinite(from) ? from : 0) - record.logBase);
    const lines = all.slice(begin, begin + LOG_PAGE_LIMIT);
    const next = record.logBase + begin + lines.length;
    return { lines, next, done: begin + lines.length >= all.length };
  }
  const start = Math.max(record.logBase, Math.floor(Number.isFinite(from) ? from : 0));
  const offset = start - record.logBase;
  const lines = record.lines.slice(offset, offset + LOG_PAGE_LIMIT);
  const next = start + lines.length;
  return { lines, next, done: !isActive(record) && next >= record.logBase + record.lines.length };
}

export function isVariantQueued(variantId: string): boolean {
  return activeRecords().some((record) => record.job.variantId === variantId && !record.cancelRequested);
}

/** Active job of a variant, for status display. */
export function activeJobForVariant(variantId: string): JobView | null {
  const record = executingRecord(variantId) ?? waitingRecord(variantId);
  return record ? toView(record) : null;
}

export function getQueueStatus(): {
  running: boolean;
  current: BuildJob | null;
  currentLabel: string | null;
  pending: number;
  active: number;
  maxConcurrency: number;
  gradleBuildActive: number;
  gradleBuildMax: number;
  clientActive: number;
  clientMax: number;
  jobSlots: number;
  physicalCores: number;
  logicalCores: number;
  total: number;
  position: number | null;
  jobs: JobView[];
} {
  const activeList = activeRecords();
  const runningList = activeList.filter((record) => record.state === "running");
  const pending = activeList.length - runningList.length;
  let currentLabel: string | null = null;
  if (activeList.length === 1) currentLabel = variantJobLabel(activeList[0].job);
  else if (activeList.length > 1) currentLabel = `${activeList.length} 个任务`;
  const governor = getGovernorStatus();
  const limits = getConcurrencyLimits();
  return {
    running: activeList.length > 0,
    current: (runningList[0] ?? activeList[0])?.job ?? null,
    currentLabel,
    pending,
    active: runningList.length,
    maxConcurrency: governor.gradleBuildMax,
    gradleBuildActive: governor.gradleBuildActive,
    gradleBuildMax: governor.gradleBuildMax,
    clientActive: governor.clientActive,
    clientMax: governor.clientMax,
    jobSlots: governor.jobSlots,
    physicalCores: limits.physicalCores,
    logicalCores: limits.logicalCores,
    total: activeList.length,
    position: activeList.length > 0 ? activeList.length : null,
    jobs: activeList.map(toView),
  };
}

// ---------------------------------------------------------------- enqueue / cancel

const JOB_TYPE_RANK: Record<BuildJob["type"], number> = { build: 1, run: 2, "build+run": 3 };

/** Merges requests for a variant that has not started yet: build+run ⊃ run ⊃ build. */
export function mergeBuildJobType(existing: BuildJob["type"], incoming: BuildJob["type"]): BuildJob["type"] {
  return JOB_TYPE_RANK[incoming] >= JOB_TYPE_RANK[existing] ? incoming : existing;
}

/**
 * Queues a job and returns its id. A request for a variant whose job is still waiting is merged into
 * it; a request of the same kind as the variant's running job returns that job; otherwise the new job
 * waits until the variant's current job finished.
 */
export function enqueueBuild(input: Omit<BuildJob, "id">): string {
  const running = executingRecord(input.variantId);
  if (running && !running.cancelRequested && running.job.type === input.type) return running.job.id;
  const waiting = waitingRecord(input.variantId);
  if (waiting && !waiting.cancelRequested) {
    waiting.job.type = mergeBuildJobType(waiting.job.type, input.type);
    waiting.job.projectPath = input.projectPath;
    waiting.job.loader = input.loader ?? waiting.job.loader;
    waiting.job.mcVersion = input.mcVersion ?? waiting.job.mcVersion;
    waiting.job.stopAtTitle = waiting.job.type === "run" ? (input.stopAtTitle ?? waiting.job.stopAtTitle) : undefined;
    return waiting.job.id;
  }
  const now = Date.now();
  const job: BuildJob = { ...input, id: randomUUID() };
  const record: JobRecord = {
    job,
    state: "queued",
    phase: "queued",
    phaseDetail: null,
    requestedAt: now,
    phaseStartedAt: now,
    finishedAt: null,
    reason: null,
    lines: [],
    logBase: 0,
    timeToTitleMs: null,
    javaMajor: null,
    cancelRequested: false,
    savedLogPath: null,
    logEvicted: false,
    evictedLineCount: 0,
  };
  jobs.set(job.id, record);
  order.push(job.id);
  pruneFinished();
  void updateSink((sink) => sink.setActivity(job.variantId, { state: "queued", kind: kindOf(job.type), jobId: job.id }));
  emit({ type: "queue", job, view: toView(record), queueLength: activeRecords().length });
  schedule();
  return job.id;
}

export function enqueueBatch(list: Array<Omit<BuildJob, "id">>): string[] {
  return list.map((job) => enqueueBuild(job));
}

/** Cancels one job (queued or running); its process tree is stopped. Returns false if unknown/finished. */
export function cancelJob(jobId: string): boolean {
  const record = jobs.get(jobId);
  if (!record || !isActive(record)) return false;
  record.cancelRequested = true;
  if (!executing.has(jobId)) {
    // Never started: finish it right away.
    finish(record, { status: "cancelled", reason: "已取消", phaseReached: "queued" });
  }
  return true;
}

/** Cancels every active job (window close, quit). */
export function cancelBuildQueue(): void {
  for (const record of activeRecords()) cancelJob(record.job.id);
}

/**
 * Finished jobs stay queryable for the whole app session (GET /api/jobs/:id and its log); only the
 * in-memory log lines of older finished jobs are dropped in favour of their saved log file.
 */
function pruneFinished(): void {
  const finished = order.map((id) => jobs.get(id)!).filter((record) => !isActive(record) && !record.logEvicted);
  for (const record of finished.slice(0, Math.max(0, finished.length - FINISHED_IN_MEMORY_LOGS))) {
    if (!record.savedLogPath) continue;
    record.evictedLineCount = record.logBase + record.lines.length;
    record.lines = [];
    record.logEvicted = true;
  }
}

// ---------------------------------------------------------------- execution

function schedule(): void {
  for (const record of activeRecords()) {
    if (executing.has(record.job.id) || record.cancelRequested) continue;
    if (executingRecord(record.job.variantId)) continue;
    executing.add(record.job.id);
    void execute(record).finally(() => {
      executing.delete(record.job.id);
      schedule();
    });
  }
}

function appendLine(record: JobRecord, line: string): void {
  record.lines.push(line);
  if (record.lines.length > LOG_LINE_LIMIT) {
    const drop = record.lines.length - LOG_LINE_LIMIT;
    record.lines.splice(0, drop);
    record.logBase += drop;
  }
  appendLiveLog(record.job.variantId, line);
  emit({ type: "progress", job: record.job, line });
}

function contextFor(record: JobRecord): StepContext {
  return {
    log: (line) => appendLine(record, line),
    isCancelled: () => record.cancelRequested,
    phase: (phase, detail) => {
      if (!isActive(record)) return;
      const changed = phase !== record.phase;
      if (changed) {
        record.phase = phase;
        record.phaseStartedAt = Date.now();
      }
      record.phaseDetail = detail ?? (changed ? null : record.phaseDetail);
      if (phase !== "queued" && record.state === "queued") {
        record.state = "running";
        void updateSink((sink) => sink.setActivity(record.job.variantId, {
          state: "running",
          kind: kindOf(record.job.type),
          jobId: record.job.id,
        }));
        emit({ type: "start", job: record.job, view: toView(record) });
      }
      emit({ type: "phase", job: record.job, view: toView(record) });
    },
  };
}

async function execute(record: JobRecord): Promise<void> {
  const { job } = record;
  const ctx = contextFor(record);
  clearLiveLog(job.variantId);
  let result: StepResult;
  try {
    if (job.type === "run") {
      result = await runner().launch(job.projectPath, ctx, { stopAtTitle: job.stopAtTitle, label: jobLabel(job) });
    } else {
      result = await runner().build(job.projectPath, ctx, jobLabel(job));
      if (job.type === "build+run" && result.status === "success" && !record.cancelRequested) {
        const build = result;
        result = await runner().launch(job.projectPath, ctx, { stopAtTitle: true, label: jobLabel(job) });
        result.javaMajor ??= build.javaMajor;
      }
    }
  } catch (err) {
    appendLine(record, `错误：${(err as Error).message}`);
    result = { status: "failed", reason: (err as Error).message };
  }
  if (record.cancelRequested && result.status !== "success") result = { ...result, status: "cancelled", reason: "已取消" };
  finish(record, result);
}

function finish(record: JobRecord, result: StepResult): void {
  if (!isActive(record)) return;
  const { job } = record;
  const now = Date.now();
  const phaseReached = result.phaseReached ?? (record.phase === "queued" ? "queued" : record.phase);
  record.state = result.status === "success" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
  record.reason = result.status === "success" ? null : (result.reason ?? summarizeFailure(record.lines) ?? null);
  record.timeToTitleMs = result.timeToTitleMs ?? null;
  record.javaMajor = result.javaMajor ?? record.javaMajor;
  record.phase = "exited";
  record.phaseDetail = phaseReached;
  record.phaseStartedAt = now;
  record.finishedAt = now;

  const at = iso(now);
  const finalState = record.state as "succeeded" | "failed" | "cancelled";
  void updateSink((sink) => sink.recordResult(job.variantId, {
    kind: kindOf(job.type),
    state: finalState,
    at,
    reason: record.reason,
    phaseReached,
    startedAt: iso(record.requestedAt),
    durationMs: now - record.requestedAt,
    timeToTitleMs: result.timeToTitleMs,
    javaMajor: record.javaMajor,
    exitCode: result.exitCode,
  }));
  if (result.status !== "cancelled") void recordProjectVerification(job, result, record.reason);
  try {
    record.savedLogPath = saveLog(job.projectPath, record.lines);
    pruneFinished();
  } catch { /* project folder may be gone */ }
  clearLiveLog(job.variantId);
  if (result.status === "cancelled") emit({ type: "cancelled", job, view: toView(record) });
  emit({ type: "done", job, view: toView(record), success: result.status === "success" });
}

function summarizeFailure(lines: string[]): string | undefined {
  const text = lines.join("\n");
  if (/Timeout waiting to lock|Could not acquire lock|文件锁|file lock/i.test(text)) {
    return "Gradle 缓存文件锁争用（并行构建过多时常见，可在设置中降低「Gradle 构建并发」后重试）";
  }
  if (/OutOfMemoryError|GC overhead|内存不足|insufficient memory/i.test(text)) {
    return "构建进程内存不足（请降低并发后重试）";
  }
  const hit = [...lines].reverse().find((line) => /BUILD FAILED|FAILURE|Exception|Error|Cannot|Could not/i.test(line));
  return hit ? hit.slice(0, 240) : undefined;
}

function isLoaderId(value: string | undefined): value is LoaderId {
  return value === "fabric" || value === "forge" || value === "neoforge";
}

/** Results of user projects are keyed by project + variant, never by loader:mc (DMCL's template index). */
async function recordProjectVerification(job: BuildJob, result: StepResult, reason: string | null): Promise<void> {
  if (!isLoaderId(job.loader) || !job.mcVersion) return;
  const ok = result.status === "success";
  try {
    const workspace = await loadDist(repoDist("workspace", "index.js"));
    workspace.recordVersionVerification({
      scope: "project",
      loader: job.loader,
      mcVersion: job.mcVersion,
      jobType: job.type,
      variantId: job.variantId,
      projectPath: job.projectPath,
      buildSuccess: job.type === "run" ? undefined : (job.type === "build" ? ok : (ok || result.phaseReached === "starting" || result.phaseReached === "in-game")),
      clientSuccess: job.type === "build" ? undefined : ok,
      failureSummary: ok ? undefined : reason ?? undefined,
    });
  } catch {
    // Verification indexing must not break the queue.
  }
}

// ---------------------------------------------------------------- logs

function variantLogsDir(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".dmcl", "logs");
}

function saveLog(projectPath: string, lines: string[]): string | null {
  if (lines.length === 0 || !fs.existsSync(projectPath)) return null;
  const dir = variantLogsDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${Date.now()}-${randomUUID()}.log`);
  fs.writeFileSync(logPath, lines.join("\n"), "utf8");
  return logPath;
}

/** For batch jobs / external verification. */
export function saveVariantBuildLog(projectPath: string, lines: string[]): string | null {
  return saveLog(projectPath, lines);
}

const liveLogsByVariant = new Map<string, string[]>();

function appendLiveLog(variantId: string, line: string): void {
  let buf = liveLogsByVariant.get(variantId);
  if (!buf) {
    buf = [];
    liveLogsByVariant.set(variantId, buf);
  }
  buf.push(line);
  if (buf.length > 4000) buf.splice(0, buf.length - 4000);
}

function clearLiveLog(variantId: string): void {
  liveLogsByVariant.delete(variantId);
}

export function appendVariantLiveLog(variantId: string, line: string): void {
  appendLiveLog(variantId, line);
}

export function clearVariantLiveLog(variantId: string): void {
  clearLiveLog(variantId);
}

function tailFile(filePath: string, maxLines = 300): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(-maxLines).join("\n");
  } catch {
    return null;
  }
}

function extractProblemsReportText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stripped = fs.readFileSync(filePath, "utf8")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!stripped) return null;
    const tail = stripped.split("\n").map((l) => l.trim()).filter(Boolean).slice(-120).join("\n");
    return tail.length > 8000 ? tail.slice(-8000) : tail;
  } catch {
    return null;
  }
}

function findGradleFallbackLogs(projectPath: string): Array<{ label: string; content: string }> {
  const resolved = path.resolve(projectPath);
  const out: Array<{ label: string; content: string }> = [];
  for (const c of [
    { label: "run/logs/latest.log", file: path.join(resolved, "run", "logs", "latest.log") },
    { label: "runs/client/logs/latest.log", file: path.join(resolved, "runs", "client", "logs", "latest.log") },
  ]) {
    const content = tailFile(c.file);
    if (content?.trim()) out.push({ label: c.label, content });
  }
  const problemsText = extractProblemsReportText(path.join(resolved, "build", "reports", "problems", "problems-report.html"));
  if (problemsText) out.push({ label: "Gradle problems-report（摘要）", content: problemsText });
  return out;
}

export async function getVariantBuildLogContent(variantId: string): Promise<{
  content: string;
  source: "live" | "saved" | "fallback" | "none";
  fileName?: string;
  hint?: string;
}> {
  const live = liveLogsByVariant.get(variantId);
  if (live?.length) return { content: live.join("\n"), source: "live", hint: "任务进行中，显示实时输出" };

  const files = await listLogs(variantId);
  let readFailure: string | undefined;
  for (const file of files) {
    const content = await readLog(file.path, variantId);
    if (content) return { content, source: "saved", fileName: file.name };
    readFailure = file.path;
  }
  if (files.length > 0) {
    return {
      content: "",
      source: "none",
      hint: `找到 ${files.length} 个日志文件但无法读取${readFailure ? "：" + readFailure : ""}。请检查文件权限或路径是否有效。`,
    };
  }

  const projectPath = await resolveProjectPath(variantId);
  if (projectPath) {
    const fallbacks = findGradleFallbackLogs(projectPath);
    if (fallbacks.length > 0) {
      const combined = fallbacks.map((f) => `===== ${f.label} =====\n${f.content}`).join("\n\n");
      return { content: combined, source: "fallback", fileName: fallbacks[0].label };
    }
    return { content: "", source: "none", hint: `暂无构建日志。完成一次构建后日志会保存到：\n${variantLogsDir(projectPath)}` };
  }
  return { content: "", source: "none", hint: "未找到该变体项目路径" };
}

async function resolveProjectPath(variantId: string): Promise<string | null> {
  try {
    const mod = await loadDist(repoDist("workspace", "store.js"));
    return mod.getWorkspace().getVariant(variantId)?.variant.projectPath ?? null;
  } catch {
    return null;
  }
}

export async function listLogs(variantId: string): Promise<Array<{ name: string; path: string; mtime: number }>> {
  const projectPath = await resolveProjectPath(variantId);
  if (!projectPath) return [];
  const dir = variantLogsDir(projectPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .map((name) => {
      const p = path.join(dir, name);
      return { name, path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function isPathUnderDir(resolved: string, dir: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(resolved);
  const b = norm(path.resolve(dir));
  return r === b || r.startsWith(b + path.sep);
}

export async function readLog(logPath: string, variantId: string): Promise<string> {
  const resolved = path.resolve(logPath);
  const projectPath = await resolveProjectPath(variantId);
  if (!projectPath) return "";
  if (!isPathUnderDir(resolved, variantLogsDir(projectPath))) return "";
  if (!fs.existsSync(resolved)) return "";
  return fs.readFileSync(resolved, "utf8");
}
