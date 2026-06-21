import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadDist, repoDist } from "./dist-loader";
import {
  getBuildConcurrencyInfo,
  getRunnerPool,
  type GradleRunner,
} from "./gradle-runner";
import { getGovernorStatus } from "./concurrency-governor";

function variantLogsDir(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".dmcl", "logs");
}

type BuildStatus = "unknown" | "success" | "failed" | "building";
type LoaderId = "fabric" | "forge" | "neoforge";

export interface BuildJob {
  id: string;
  variantId: string;
  projectPath: string;
  type: "build" | "run" | "build+run";
  loader?: string;
  mcVersion?: string;
}

function isLoaderId(value: string | undefined): value is LoaderId {
  return value === "fabric" || value === "forge" || value === "neoforge";
}

export function variantJobLabel(job: Pick<BuildJob, "loader" | "mcVersion">): string {
  if (job.loader && job.mcVersion) return `${job.loader} ${job.mcVersion}`;
  return "变体";
}

export interface BuildEvent {
  type: "start" | "progress" | "done" | "queue" | "cancelled";
  job?: BuildJob;
  line?: string;
  success?: boolean;
  queueLength?: number;
}

type JobCallback = (event: BuildEvent) => void;

let queue: BuildJob[] = [];
let activeJobs = new Map<string, BuildJob>();
let slotBusy: boolean[] = [];
let processorPromise: Promise<void> | null = null;
let cancelled = false;
/** 已被 cancelBuildQueue 收尾的任务，executeJob 不再重复 emit done */
const cancelledJobIds = new Set<string>();
let listeners: JobCallback[] = [];

let testRunnerPoolOverride: GradleRunner[] | null = null;

/** @internal 测试专用：注入 mock runner 池 */
export function setRunnerPoolForTests(pool: GradleRunner[] | null): void {
  testRunnerPoolOverride = pool;
}

/** @internal 测试专用：重置队列模块状态 */
export function resetBuildQueueForTests(): void {
  queue = [];
  activeJobs.clear();
  slotBusy = [];
  processorPromise = null;
  cancelled = false;
  cancelledJobIds.clear();
  listeners = [];
  testRunnerPoolOverride = null;
}

function poolForProcessor(): GradleRunner[] {
  return testRunnerPoolOverride ?? getRunnerPool();
}

function cancelProcessorRunners(): void {
  const pool = poolForProcessor();
  void Promise.all(pool.map((runner) => runner.cancel()));
  pool.forEach((runner, index) => {
    if (!slotBusy[index]) runner.reset();
  });
}

const concurrencyInfo = () => getBuildConcurrencyInfo();

async function updateVariantStatus(variantId: string, status: BuildStatus): Promise<void> {
  try {
    const mod = await loadDist(repoDist("workspace", "store.js"));
    mod.getWorkspace().updateVariantBuildStatus(variantId, status);
  } catch { /* ignore */ }
}

function summarizeFailure(lines: string[]): string | undefined {
  const text = lines.join("\n");
  if (/JDK 准备失败|org\.gradle\.java\.home|需要 Java \d+|incompatibleReason/i.test(text)) {
    const jdk = [...lines].reverse().find((line) =>
      /JDK|Java \d+|org\.gradle\.java\.home/i.test(line),
    );
    if (jdk) return jdk.slice(0, 240);
  }
  if (/Timeout waiting to lock|Could not acquire lock|Gradle build daemon|文件锁|file lock/i.test(text)) {
    return "Gradle 缓存文件锁争用（大批量并行构建时常见，可在设置中降低「Gradle 构建并发」后重试）";
  }
  if (/OutOfMemoryError|GC overhead|内存不足|insufficient memory/i.test(text)) {
    return "构建进程内存不足（大批量并行时常见，请降低 Gradle 构建并发或任务槽位数）";
  }
  const hit = [...lines].reverse().find((line) =>
    /BUILD FAILED|FAILURE|Exception|Error|Cannot|Could not/i.test(line)
  );
  return hit ? hit.slice(0, 240) : undefined;
}

async function recordBuildVerification(
  job: BuildJob,
  result: {
    buildSuccess?: boolean;
    clientSuccess?: boolean;
    failureSummary?: string;
  },
): Promise<void> {
  if (!isLoaderId(job.loader) || !job.mcVersion) return;
  try {
    const workspace = await loadDist(repoDist("workspace", "index.js"));
    workspace.recordVersionVerification({
      loader: job.loader,
      mcVersion: job.mcVersion,
      jobType: job.type,
      variantId: job.variantId,
      projectPath: job.projectPath,
      buildSuccess: result.buildSuccess,
      clientSuccess: result.clientSuccess,
      failureSummary: result.failureSummary,
    });
    workspace.invalidateMatrixCache();
  } catch {
    // Verification indexing must not break the build queue.
  }
}

export function onBuildEvent(cb: JobCallback): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function emit(event: Parameters<JobCallback>[0]): void {
  for (const cb of listeners) cb(event);
}

const JOB_TYPE_RANK: Record<BuildJob["type"], number> = {
  build: 1,
  run: 2,
  "build+run": 3,
};

/** 合并同一变体的构建意图：build+run ⊃ run ⊃ build */
export function mergeBuildJobType(
  existing: BuildJob["type"],
  incoming: BuildJob["type"],
): BuildJob["type"] {
  return JOB_TYPE_RANK[incoming] >= JOB_TYPE_RANK[existing] ? incoming : existing;
}

function findActiveJobByVariant(variantId: string): BuildJob | undefined {
  for (const job of activeJobs.values()) {
    if (job.variantId === variantId) return job;
  }
  return undefined;
}

function findQueuedJobByVariant(variantId: string): BuildJob | undefined {
  return queue.find((job) => job.variantId === variantId);
}

function applyJobFields(target: BuildJob, source: Omit<BuildJob, "id">): void {
  target.projectPath = source.projectPath;
  target.loader = source.loader;
  target.mcVersion = source.mcVersion;
}

function resumeQueueAfterEnqueue(): void {
  cancelled = false;
  if (activeJobs.size === 0) {
    cancelledJobIds.clear();
  }
  ensureProcessor();
}

function activeJobList(): BuildJob[] {
  return [...activeJobs.values()];
}

export function isVariantQueued(variantId: string): boolean {
  const active = findActiveJobByVariant(variantId);
  if (active && !cancelledJobIds.has(active.id)) return true;
  return queue.some((j) => j.variantId === variantId);
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
} {
  const active = activeJobs.size;
  const pending = queue.length;
  const total = active + pending;
  const activeList = activeJobList();
  const current = activeList[0] ?? null;
  let currentLabel: string | null = null;
  if (activeList.length === 1) {
    currentLabel = variantJobLabel(activeList[0]!);
  } else if (activeList.length > 1) {
    currentLabel = `${activeList.length} 个变体`;
  }
  const governor = getGovernorStatus();
  return {
    running: processorPromise !== null || active > 0 || (pending > 0 && !cancelled),
    current,
    currentLabel,
    pending,
    active,
    maxConcurrency: governor.gradleBuildMax,
    gradleBuildActive: governor.gradleBuildActive,
    gradleBuildMax: governor.gradleBuildMax,
    clientActive: governor.clientActive,
    clientMax: governor.clientMax,
    jobSlots: governor.jobSlots,
    physicalCores: concurrencyInfo().physicalCores,
    logicalCores: concurrencyInfo().logicalCores,
    total,
    position: total > 0 ? total : null,
  };
}

function finalizeCancelledJob(job: BuildJob): void {
  if (cancelledJobIds.has(job.id)) return;
  cancelledJobIds.add(job.id);
  emit({ type: "cancelled", job });
  emit({ type: "done", job, success: false });
  void updateVariantStatus(job.variantId, "failed");
}

export function cancelBuildQueue(): void {
  cancelled = true;
  const queuedVariantIds = queue.map((j) => j.variantId);
  queue.length = 0;
  cancelProcessorRunners();
  for (const job of activeJobs.values()) {
    finalizeCancelledJob(job);
  }
  for (const variantId of queuedVariantIds) {
    void updateVariantStatus(variantId, "unknown");
  }
}

export function enqueueBuild(job: Omit<BuildJob, "id">): string {
  const activeJob = findActiveJobByVariant(job.variantId);
  if (activeJob && !cancelledJobIds.has(activeJob.id)) {
    const mergedType = mergeBuildJobType(activeJob.type, job.type);
    if (mergedType !== activeJob.type) {
      activeJob.type = mergedType;
      applyJobFields(activeJob, job);
    }
    resumeQueueAfterEnqueue();
    return activeJob.id;
  }

  const existing = findQueuedJobByVariant(job.variantId);
  if (existing) {
    const mergedType = mergeBuildJobType(existing.type, job.type);
    if (mergedType !== existing.type) {
      existing.type = mergedType;
    }
    applyJobFields(existing, job);
    resumeQueueAfterEnqueue();
    return existing.id;
  }

  const entry: BuildJob = { ...job, id: randomUUID() };
  queue.push(entry);
  emit({ type: "queue", queueLength: queue.length });
  resumeQueueAfterEnqueue();
  return entry.id;
}

export function enqueueBatch(jobs: Array<Omit<BuildJob, "id">>): string[] {
  return jobs.map((j) => enqueueBuild(j));
}

function saveLog(projectPath: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  const dir = variantLogsDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${Date.now()}-${randomUUID()}.log`);
  fs.writeFileSync(logPath, lines.join("\n"), "utf8");
  return logPath;
}

/** 供批任务 / 外部验证写入构建日志 */
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

/** 批任务 / 外部流程写入实时日志缓冲 */
export function appendVariantLiveLog(variantId: string, line: string): void {
  appendLiveLog(variantId, line);
}

export function clearVariantLiveLog(variantId: string): void {
  clearLiveLog(variantId);
}

function tailFile(filePath: string, maxLines = 300): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return null;
  }
}

function extractProblemsReportText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const html = fs.readFileSync(filePath, "utf8");
    const stripped = html
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
    const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);
    const tail = lines.slice(-120).join("\n");
    return tail.length > 8000 ? tail.slice(-8000) : tail;
  } catch {
    return null;
  }
}

function findGradleFallbackLogs(projectPath: string): Array<{ label: string; content: string }> {
  const resolved = path.resolve(projectPath);
  const out: Array<{ label: string; content: string }> = [];
  const textLogs: Array<{ label: string; file: string }> = [
    { label: "run/logs/latest.log", file: path.join(resolved, "run", "logs", "latest.log") },
    { label: "runs/client/logs/latest.log", file: path.join(resolved, "runs", "client", "logs", "latest.log") },
  ];
  for (const c of textLogs) {
    const content = tailFile(c.file);
    if (content?.trim()) out.push({ label: c.label, content });
  }
  const problemsFile = path.join(resolved, "build", "reports", "problems", "problems-report.html");
  const problemsText = extractProblemsReportText(problemsFile);
  if (problemsText) {
    out.push({ label: "Gradle problems-report（摘要）", content: problemsText });
  }
  return out;
}

export async function getVariantBuildLogContent(variantId: string): Promise<{
  content: string;
  source: "live" | "saved" | "fallback" | "none";
  fileName?: string;
  hint?: string;
}> {
  const live = liveLogsByVariant.get(variantId);
  if (live?.length) {
    return {
      content: live.join("\n"),
      source: "live",
      hint: "任务进行中，显示实时输出",
    };
  }

  const files = await listLogs(variantId);
  let readFailure: string | undefined;
  for (const file of files) {
    const content = await readLog(file.path, variantId);
    if (content) {
      return { content, source: "saved", fileName: file.name };
    }
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
    const logDir = variantLogsDir(projectPath);
    return {
      content: "",
      source: "none",
      hint: `暂无构建日志。完成一次构建后日志会保存到：\n${logDir}`,
    };
  }

  return { content: "", source: "none", hint: "未找到该变体项目路径" };
}

async function resolveProjectPath(variantId: string): Promise<string | null> {
  try {
    const mod = await loadDist(repoDist("workspace", "store.js"));
    const found = mod.getWorkspace().getVariant(variantId);
    return found?.variant.projectPath ?? null;
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
  const base = path.resolve(dir);
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(resolved);
  const b = norm(base);
  return r === b || r.startsWith(b + path.sep);
}

export async function readLog(logPath: string, variantId: string): Promise<string> {
  const resolved = path.resolve(logPath);
  const projectPath = await resolveProjectPath(variantId);
  if (!projectPath) return "";
  const allowedDir = variantLogsDir(projectPath);
  if (!isPathUnderDir(resolved, allowedDir)) return "";
  if (!fs.existsSync(resolved)) return "";
  return fs.readFileSync(resolved, "utf8");
}

async function executeJob(job: BuildJob, runner: GradleRunner): Promise<void> {
  const lines: string[] = [];
  clearLiveLog(job.variantId);
  const logLine = (line: string) => {
    lines.push(line);
    appendLiveLog(job.variantId, line);
    emit({ type: "progress", job, line });
  };

  let success = false;
  let buildSuccess: boolean | undefined;
  let clientSuccess: boolean | undefined;
  try {
    if (job.type === "build" || job.type === "build+run") {
      const code = await runner.runBuildOnly(job.projectPath, logLine);
      buildSuccess = code === 0;
      if (code !== 0) {
        success = false;
      } else if (job.type === "build") {
        success = true;
      } else if (!cancelled && !runner.isCancelled()) {
        const clientCode = await runner.runClientOnly(job.projectPath, logLine);
        clientSuccess = clientCode === 0;
        success = clientSuccess;
      }
    } else if (!cancelled && !runner.isCancelled()) {
      const code = await runner.runClientInteractive(job.projectPath, logLine);
      clientSuccess = code === 0;
      success = clientSuccess;
    }
  } catch (err) {
    logLine(`错误：${(err as Error).message}`);
    success = false;
  }

  saveLog(job.projectPath, lines);
  clearLiveLog(job.variantId);
  const alreadyFinalized = cancelledJobIds.has(job.id);
  if (!alreadyFinalized) {
    if (cancelled || runner.isCancelled()) success = false;
    await recordBuildVerification(job, {
      buildSuccess,
      clientSuccess,
      failureSummary: success ? undefined : summarizeFailure(lines),
    });
    await updateVariantStatus(job.variantId, success ? "success" : "failed");
    emit({ type: "done", job, success });
  }
  runner.reset();
}

function ensureProcessor(): void {
  if (processorPromise) return;
  processorPromise = runProcessor().finally(() => {
    processorPromise = null;
    if (queue.length > 0 && !cancelled) {
      ensureProcessor();
    }
  });
}

async function runProcessor(): Promise<void> {
  const pool = poolForProcessor();
  if (slotBusy.length !== pool.length) {
    slotBusy = Array.from({ length: pool.length }, () => false);
  }

  const inFlight = new Map<string, Promise<void>>();

  const startJobs = (): void => {
    if (cancelled) return;
    for (let slot = 0; slot < pool.length; slot++) {
      if (slotBusy[slot] || queue.length === 0) continue;
      const index = queue.findIndex((candidate) => !findActiveJobByVariant(candidate.variantId));
      if (index < 0) continue;
      const job = queue.splice(index, 1)[0]!;
      const runner = pool[slot]!;
      slotBusy[slot] = true;
      activeJobs.set(job.id, job);
      emit({ type: "start", job });

      const jobPromise = executeJob(job, runner).finally(() => {
        slotBusy[slot] = false;
        activeJobs.delete(job.id);
        inFlight.delete(job.id);
        startJobs();
      });
      inFlight.set(job.id, jobPromise);
    }
  };

  startJobs();
  while (inFlight.size > 0) {
    await Promise.race(inFlight.values());
    startJobs();
  }
}
