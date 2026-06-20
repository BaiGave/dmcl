import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoaderId, Logger, MappingsId, ProjectOptions } from "../types.js";
import { DEFAULT_MAPPINGS } from "../types.js";
import {
  runGradleBuild,
  runGradleBuildDiagnostics,
  runGradleClientVerify,
  type GradleCommandLogOptions,
} from "../core/build.js";
import {
  prewarmForgeMavenizerLibraries,
  prewarmForgeMavenizerMcpTools,
  prewarmForgeSlimeLauncherAssets,
} from "../core/forge-mavenizer.js";
import { ensureProjectToolchain } from "../core/toolchain.js";
import { withGradleBuildSlot, recommendGradleBuildConcurrency } from "../core/concurrency.js";
import { scaffoldProject, pascalCase } from "../core/scaffold.js";
import { applyVerificationFixes } from "./verification-fix.js";
import { detectProject } from "./detect.js";
import { repairCrossLoaderProject } from "./cross-loader.js";
import { getMetaCache, type MetaCacheData } from "../meta/meta-cache.js";
import { resolveMappings } from "../meta/mappings-cache.js";
import {
  readVersionVerificationIndex,
  recordVersionVerification,
  summarizeVersionVerification,
  type VersionVerificationFile,
  type VersionVerificationSummary,
} from "./version-verification.js";

const LOADERS: LoaderId[] = ["fabric", "neoforge", "forge"];
const DEFAULT_VERIFY_ROOT = path.join(os.homedir(), ".dmcl", "version-verification-projects");

export interface VersionVerificationTarget {
  loader: LoaderId;
  mcVersion: string;
  summary: VersionVerificationSummary;
}

export interface VersionVerificationPlanOptions {
  loader?: LoaderId;
  mcVersion?: string;
  /** true = 包含已 verified 的全部组合（全矩阵） */
  force?: boolean;
  includeFailed?: boolean;
  /** 规划前增量刷新上游元数据 */
  refreshMeta?: boolean;
}

export interface MatrixCombinationCounts {
  fabric: number;
  forge: number;
  neoforge: number;
  total: number;
}

export function summarizeMatrixCombinations(
  meta: Pick<MetaCacheData, "loaderVersions">,
): MatrixCombinationCounts {
  const fabric = meta.loaderVersions.fabric?.length ?? 0;
  const forge = meta.loaderVersions.forge?.length ?? 0;
  const neoforge = meta.loaderVersions.neoforge?.length ?? 0;
  return { fabric, forge, neoforge, total: fabric + forge + neoforge };
}

export interface VersionVerificationPlanContext {
  data: MetaCacheData;
  counts: MatrixCombinationCounts;
  plan: VersionVerificationTarget[];
  skippedVerified: number;
}

export interface VersionVerificationRunOptions extends VersionVerificationPlanOptions {
  limit?: number;
  rootDir?: string;
  mirror?: boolean;
  keepProjects?: boolean;
  buildRetries?: number;
  /** 并行 worker 数；>1 时启用矩阵并行验证 */
  parallel?: number;
  /** 仅 gradlew build，跳过 runClient */
  buildOnly?: boolean;
  /** 失败后根据日志自动修复并重试构建 */
  autoFix?: boolean;
}

export interface VersionVerificationRunResult {
  target: VersionVerificationTarget;
  projectPath: string;
  status: "verified" | "setup-failed" | "build-failed" | "client-failed";
  buildSuccess: boolean;
  clientSuccess: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  logPath?: string;
  failureSummary?: string;
}

export interface VersionVerificationBatchResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  reportPath: string;
  planned: number;
  executed: number;
  verified: number;
  failed: number;
  skipped: number;
  parallel: number;
  autoFix: boolean;
  buildOnly: boolean;
  results: VersionVerificationRunResult[];
}

function isPending(summary: VersionVerificationSummary, opts: VersionVerificationPlanOptions): boolean {
  if (opts.force) return true;
  if (summary.state === "verified") return false;
  if (summary.state === "failed") return opts.includeFailed !== false;
  return true;
}

export function buildVersionVerificationPlan(
  meta: Pick<MetaCacheData, "releaseVersions" | "loaderVersions">,
  index: VersionVerificationFile,
  opts: VersionVerificationPlanOptions = {},
): VersionVerificationTarget[] {
  const targets: VersionVerificationTarget[] = [];
  const loaders = opts.loader ? [opts.loader] : LOADERS;

  for (const mcVersion of meta.releaseVersions) {
    if (opts.mcVersion && mcVersion !== opts.mcVersion) continue;
    for (const loader of loaders) {
      if (!meta.loaderVersions[loader]?.includes(mcVersion)) continue;
      const key = `${loader}:${mcVersion}`;
      const summary = summarizeVersionVerification(index.records[key]);
      if (isPending(summary, opts)) targets.push({ loader, mcVersion, summary });
    }
  }

  return targets;
}

export async function loadVersionVerificationContext(
  opts: VersionVerificationPlanOptions = {},
): Promise<VersionVerificationPlanContext> {
  const cache = getMetaCache();
  if (opts.refreshMeta) {
    await cache.refresh({ force: false });
  }
  const { data } = await cache.get({ strategy: "fresh" });
  const index = readVersionVerificationIndex();
  const counts = summarizeMatrixCombinations(data);
  const allTargets = buildVersionVerificationPlan(data, index, { ...opts, force: true });
  const plan = buildVersionVerificationPlan(data, index, opts);
  return {
    data,
    counts,
    plan,
    skippedVerified: Math.max(0, allTargets.length - plan.length),
  };
}

export async function loadVersionVerificationPlan(
  opts: VersionVerificationPlanOptions = {},
): Promise<VersionVerificationTarget[]> {
  const ctx = await loadVersionVerificationContext(opts);
  return ctx.plan;
}

async function cleanupStaleDeletingDirs(rootDir: string): Promise<void> {
  const root = path.resolve(rootDir);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.includes(".deleting-"))
    .map((entry) => fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {})));
}

function safeVersionForPath(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function modIdFor(loader: LoaderId, mcVersion: string): string {
  const raw = `dmcl_${loader}_${mcVersion.replace(/[^a-zA-Z0-9]+/g, "_")}`.toLowerCase();
  return raw.slice(0, 64).replace(/_+$/g, "") || "dmcl_verify";
}

function childPath(rootDir: string, loader: LoaderId, mcVersion: string): string {
  return path.join(path.resolve(rootDir), `${loader}-${safeVersionForPath(mcVersion)}`);
}

async function removeChildDir(rootDir: string, targetDir: string): Promise<void> {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetDir);
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const r = norm(root);
  const t = norm(target);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error(`Refusing to remove path outside verification root: ${target}`);
  }
  if (!fs.existsSync(target)) return;

  // Windows 并行验证时 Gradle/杀毒可能短暂锁目录：先 rename 让出路径，再后台删除
  const pending = `${target}.deleting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await fs.promises.rename(target, pending);
      void fs.promises.rm(pending, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
        .catch(() => {});
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (attempt < 6 && (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        continue;
      }
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
      return;
    }
  }
}

async function resolveDefaultMappings(loader: LoaderId, mcVersion: string): Promise<MappingsId> {
  try {
    return (await resolveMappings(loader, mcVersion)).default;
  } catch {
    return DEFAULT_MAPPINGS[loader];
  }
}

const FAILURE_PATTERNS = [
  /Caused by:.*(HttpConnectTimeoutException|SocketTimeoutException|ConnectException|UnknownHostException|SSL|timed out|Connection reset|No route to host)/i,
  /(HttpConnectTimeoutException|SocketTimeoutException|HTTP connect timed out|connect timed out|Read timed out|UnknownHostException|Connection reset|No route to host)/i,
  /Failed to execute task .*/i,
  /Could not (resolve|get|find|download|read|write).*/i,
  /Cannot .*/i,
  /Process 'command .*' finished with non-zero exit value \d+/i,
  /BUILD FAILED.*/i,
  /FAILURE.*/i,
  /Exception|Error|failed/i,
];

const TRANSIENT_NETWORK_PATTERNS = [
  /HttpConnectTimeoutException/i,
  /SocketTimeoutException/i,
  /HTTP connect timed out/i,
  /connect timed out/i,
  /Read timed out/i,
  /Connection reset/i,
  /UnknownHostException/i,
  /No route to host/i,
  /Temporary failure/i,
  /Could not GET/i,
  /Could not HEAD/i,
];

export function summarizeVerificationFailure(lines: string[], fallback?: string): string | undefined {
  const reversed = [...lines].reverse();
  for (const pattern of FAILURE_PATTERNS) {
    const hit = reversed.find((line) => pattern.test(line));
    if (hit) return hit.slice(0, 240);
  }
  return fallback?.slice(0, 240);
}

export function isLikelyTransientBuildFailure(lines: string[]): boolean {
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => lines.some((line) => pattern.test(line)));
}

async function runVerifiedBuild(
  projectPath: string,
  lines: string[],
  log: Logger,
  capture: Logger,
  maxAttempts: number,
  gradleSlots: number,
  runOpts: Pick<GradleCommandLogOptions, "isCancelled" | "onProc"> = {},
): Promise<boolean> {
  const attempts = Math.max(1, maxAttempts);
  const jdkOpts = runOpts.isCancelled ? { isCancelled: runOpts.isCancelled } : undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (runOpts.isCancelled?.()) return false;
    const start = lines.length;
    const diagnostic = attempt > 1;
    capture(`\n===== Gradle build attempt ${attempt}/${attempts}${diagnostic ? " (diagnostic)" : ""} =====`);
    const code = await withGradleBuildSlot(gradleSlots, async () => (
      diagnostic
        ? await runGradleBuildDiagnostics(projectPath, log, { onRawLine: capture, ...runOpts })
        : await runGradleBuild(projectPath, log, undefined, { onRawLine: capture, ...runOpts })
    ));

    if (code === 0) return true;
    if (runOpts.isCancelled?.()) return false;

    const attemptLines = lines.slice(start);
    if (attempt < attempts) {
      if (runOpts.isCancelled?.()) return false;
      const prewarmed = await prewarmForgeMavenizerLibraries(projectPath, capture, jdkOpts);
      if (prewarmed.downloaded > 0) {
        log(`Prewarmed ${prewarmed.downloaded} Forge Mavenizer libraries before retry`);
      }
      const tools = await prewarmForgeMavenizerMcpTools(projectPath, capture, jdkOpts);
      if (tools > 0) log(`Prewarmed ${tools} Forge Mavenizer MCP tools before retry`);
      const reason = isLikelyTransientBuildFailure(attemptLines)
        ? "Transient network failure detected; retrying with Gradle diagnostics..."
        : "Build failed; retrying once with Gradle diagnostics...";
      capture(reason);
      log(reason);
    }
  }

  return false;
}

async function writeVerificationLog(
  rootDir: string,
  target: VersionVerificationTarget,
  lines: string[],
): Promise<string | undefined> {
  if (lines.length === 0) return undefined;
  const logsDir = path.join(path.resolve(rootDir), "_logs");
  await fs.promises.mkdir(logsDir, { recursive: true });
  const file = path.join(
    logsDir,
    `${Date.now()}-${target.loader}-${safeVersionForPath(target.mcVersion)}.log`,
  );
  await fs.promises.writeFile(file, lines.join("\n"), "utf8");
  return file;
}

async function appendClientDiagnostics(
  projectPath: string,
  lines: string[],
  startedMs: number,
): Promise<void> {
  const candidates: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (
        entry.name === "latest.log" ||
        entry.name === "debug.log" ||
        path.basename(dir) === "crash-reports"
      ) {
        candidates.push(full);
      }
    }
  };
  await Promise.all([
    visit(path.join(projectPath, "run"), 0),
    visit(path.join(projectPath, "runs"), 0),
  ]);

  for (const file of candidates) {
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.mtimeMs < startedMs - 5000) continue;
      lines.push(`\n===== Client diagnostic: ${path.relative(projectPath, file)} =====`);
      lines.push(await fs.promises.readFile(file, "utf8"));
    } catch {
      // Missing or locked diagnostics should not hide the primary build result.
    }
  }
}

function reportPath(rootDir: string, startedAt: string): string {
  const stamp = startedAt.replace(/[:.]/g, "-");
  return path.join(path.resolve(rootDir), "_reports", `${stamp}-verification-report.json`);
}

async function writeBatchReport(
  file: string,
  result: VersionVerificationBatchResult,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(result, null, 2) + "\n", "utf8");
}

function runStatus(
  setupComplete: boolean,
  buildSuccess: boolean,
  clientSuccess: boolean,
  buildOnly: boolean,
): VersionVerificationRunResult["status"] {
  if (buildOnly) {
    if (buildSuccess) return "verified";
    return setupComplete ? "build-failed" : "setup-failed";
  }
  if (buildSuccess && clientSuccess) return "verified";
  if (!setupComplete) return "setup-failed";
  return buildSuccess ? "client-failed" : "build-failed";
}

export async function verifyOneVersion(
  target: VersionVerificationTarget,
  opts: VersionVerificationRunOptions,
  log: Logger = () => {},
): Promise<VersionVerificationRunResult> {
  const rootDir = path.resolve(opts.rootDir ?? DEFAULT_VERIFY_ROOT);
  const projectPath = childPath(rootDir, target.loader, target.mcVersion);
  const lines: string[] = [];
  const capture = (line: string) => {
    lines.push(line);
  };
  const tee = (line: string) => {
    capture(line);
    log(line);
  };

  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let setupComplete = false;
  let buildSuccess = false;
  let clientSuccess = false;
  let caught: Error | undefined;
  let failureLines = lines;

  try {
    tee(`Verifying ${target.loader} ${target.mcVersion}`);
    await fs.promises.mkdir(rootDir, { recursive: true });
    await removeChildDir(rootDir, projectPath);

    const mappings = await resolveDefaultMappings(target.loader, target.mcVersion);
    const modId = modIdFor(target.loader, target.mcVersion);
    const project: ProjectOptions = {
      loader: target.loader,
      mcVersion: target.mcVersion,
      modId,
      displayName: `DMCL Verify ${target.loader} ${target.mcVersion}`,
      className: pascalCase(modId),
      group: `com.dmcl.verify.${modId.replace(/_/g, "")}`,
      targetDir: projectPath,
      mirror: opts.mirror !== false,
      mappings,
    };

    await scaffoldProject(project, tee);
    await ensureProjectToolchain(projectPath, target.mcVersion, tee);
    setupComplete = true;
    const gradleSlots = Math.max(1, opts.parallel ?? recommendGradleBuildConcurrency());
    buildSuccess = await runVerifiedBuild(
      projectPath,
      lines,
      log,
      capture,
      opts.buildRetries ?? 2,
      gradleSlots,
    );

    if (!buildSuccess && opts.autoFix) {
      capture("\n===== Auto-fix from failure log =====");
      const fix = await applyVerificationFixes(
        projectPath,
        target.loader,
        target.mcVersion,
        lines.join("\n"),
        tee,
      );
      if (fix.applied.length > 0) {
        tee(`已应用自动修复：${fix.applied.join("、")}`);
        for (const note of fix.notes) tee(note);
        buildSuccess = await runVerifiedBuild(projectPath, lines, log, capture, 1, gradleSlots);
      } else if (fix.notes.length > 0) {
        for (const note of fix.notes) tee(note);
      }
    }

    if (buildSuccess && !opts.buildOnly) {
      const clientStart = lines.length;
      const clientStartedMs = Date.now();
      await prewarmForgeSlimeLauncherAssets(projectPath, tee);
      capture("\n===== Gradle runClient verification =====");
      clientSuccess = await runGradleClientVerify(
        projectPath,
        log,
        undefined,
        { onRawLine: capture },
      ) === 0;
      if (!clientSuccess) {
        await appendClientDiagnostics(projectPath, lines, clientStartedMs);
        failureLines = lines.slice(clientStart);
      }
    }
  } catch (err) {
    caught = err instanceof Error ? err : new Error(String(err));
    tee(caught.stack ?? `Error: ${caught.message}`);
  }

  const logPath = await writeVerificationLog(rootDir, target, lines);
  const buildOnly = opts.buildOnly === true;
  const passed = buildOnly ? buildSuccess : (buildSuccess && clientSuccess);
  const summary = passed ? undefined : summarizeVerificationFailure(failureLines, caught?.message);
  const record = recordVersionVerification({
    loader: target.loader,
    mcVersion: target.mcVersion,
    jobType: buildOnly ? "build" : "build+run",
    projectPath,
    buildSuccess,
    clientSuccess: buildOnly ? undefined : (buildSuccess ? clientSuccess : undefined),
    failureSummary: summary,
  });
  const updatedTarget = { ...target, summary: summarizeVersionVerification(record) };
  const finishedMs = Date.now();

  if (!opts.keepProjects && passed) {
    try {
      await removeChildDir(rootDir, projectPath);
    } catch (err) {
      log(`Unable to clean verified project ${projectPath}: ${(err as Error).message}`);
    }
  }

  return {
    target: updatedTarget,
    projectPath,
    status: runStatus(setupComplete, buildSuccess, clientSuccess, buildOnly),
    buildSuccess,
    clientSuccess,
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: finishedMs - startedMs,
    logPath,
    failureSummary: summary,
  };
}

function summarizeBatch(
  startedAt: string,
  reportFile: string,
  planned: number,
  selected: number,
  results: VersionVerificationRunResult[],
  meta: Pick<VersionVerificationBatchResult, "parallel" | "autoFix" | "buildOnly">,
): VersionVerificationBatchResult {
  const finishedMs = Date.now();
  const startedMs = Date.parse(startedAt);
  return {
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: Number.isFinite(startedMs) ? finishedMs - startedMs : 0,
    reportPath: reportFile,
    planned,
    executed: results.length,
    verified: results.filter((r) => r.status === "verified").length,
    failed: results.filter((r) => r.status !== "verified").length,
    skipped: Math.max(0, planned - selected),
    parallel: meta.parallel,
    autoFix: meta.autoFix,
    buildOnly: meta.buildOnly,
    results,
  };
}

function batchMeta(opts: VersionVerificationRunOptions): Pick<VersionVerificationBatchResult, "parallel" | "autoFix" | "buildOnly"> {
  return {
    parallel: Math.max(1, opts.parallel ?? 1),
    autoFix: opts.autoFix === true,
    buildOnly: opts.buildOnly === true,
  };
}

async function verifyOneSafe(
  target: VersionVerificationTarget,
  opts: VersionVerificationRunOptions,
  rootDir: string,
  log: Logger,
): Promise<VersionVerificationRunResult> {
  try {
    return await verifyOneVersion(target, { ...opts, rootDir }, log);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const projectPath = childPath(rootDir, target.loader, target.mcVersion);
    const started = new Date().toISOString();
    const logPath = await writeVerificationLog(rootDir, target, [
      `Unexpected verification runner failure for ${target.loader} ${target.mcVersion}`,
      error.stack ?? error.message,
    ]);
    const record = recordVersionVerification({
      loader: target.loader,
      mcVersion: target.mcVersion,
      jobType: opts.buildOnly ? "build" : "build+run",
      projectPath,
      buildSuccess: false,
      failureSummary: error.message,
    });
    log(`Unexpected verification failure: ${error.message}`);
    return {
      target: { ...target, summary: summarizeVersionVerification(record) },
      projectPath,
      status: "setup-failed",
      buildSuccess: false,
      clientSuccess: false,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      logPath,
      failureSummary: error.message.slice(0, 240),
    };
  }
}

export async function runVersionVerificationBatchParallel(
  opts: VersionVerificationRunOptions = {},
  log: Logger = () => {},
): Promise<VersionVerificationBatchResult> {
  const startedAt = new Date().toISOString();
  const rootDir = path.resolve(opts.rootDir ?? DEFAULT_VERIFY_ROOT);
  await cleanupStaleDeletingDirs(rootDir);
  const reportFile = reportPath(rootDir, startedAt);
  const meta = batchMeta(opts);
  const ctx = await loadVersionVerificationContext(opts);
  const plan = ctx.plan;
  log(
    `矩阵规模：Fabric ${ctx.counts.fabric} · Forge ${ctx.counts.forge} · NeoForge ${ctx.counts.neoforge} · 合计 ${ctx.counts.total}`
      + (ctx.skippedVerified > 0 && !opts.force ? `（跳过已验证 ${ctx.skippedVerified}）` : ""),
  );
  const limit = Math.max(0, opts.limit ?? plan.length);
  const selected = plan.slice(0, limit);
  const runOpts = { ...opts, rootDir };

  const snapshot = (partial: VersionVerificationRunResult[]) =>
    summarizeBatch(startedAt, reportFile, plan.length, selected.length, partial, meta);

  await writeBatchReport(reportFile, snapshot([]));

  if (meta.parallel <= 1) {
    const results: VersionVerificationRunResult[] = [];
    for (let index = 0; index < selected.length; index++) {
      const target = selected[index];
      log(`[${index + 1}/${selected.length}] ${target.loader} ${target.mcVersion}`);
      results.push(await verifyOneSafe(target, runOpts, rootDir, log));
      await writeBatchReport(reportFile, snapshot(results));
    }
    const result = snapshot(results);
    await writeBatchReport(reportFile, result);
    return result;
  }

  log(`并行验证 ${selected.length} 个目标，worker=${meta.parallel}，Gradle 槽=${meta.parallel}`);
  const results: VersionVerificationRunResult[] = new Array(selected.length);
  let nextIndex = 0;

  async function worker(workerId: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150 * (workerId - 1)));
    for (;;) {
      const index = nextIndex++;
      if (index >= selected.length) return;
      const target = selected[index];
      log(`[w${workerId} ${index + 1}/${selected.length}] ${target.loader} ${target.mcVersion}`);
      results[index] = await verifyOneSafe(target, runOpts, rootDir, log);
      const done = results.filter(Boolean);
      await writeBatchReport(reportFile, snapshot(done));
    }
  }

  await Promise.all(
    Array.from({ length: meta.parallel }, (_, i) => worker(i + 1)),
  );

  const result = snapshot(results);
  await writeBatchReport(reportFile, result);
  return result;
}

export async function runVersionVerificationBatch(
  opts: VersionVerificationRunOptions = {},
  log: Logger = () => {},
): Promise<VersionVerificationBatchResult> {
  return runVersionVerificationBatchParallel({ ...opts, parallel: opts.parallel ?? 1 }, log);
}

export async function runAllVersionVerifications(
  opts: Omit<VersionVerificationRunOptions, "limit"> = {},
  log: Logger = () => {},
): Promise<VersionVerificationBatchResult> {
  return runVersionVerificationBatchParallel({ ...opts, limit: undefined }, log);
}

export interface VerifyExistingProjectOptions {
  buildOnly?: boolean;
  autoFix?: boolean;
  buildRetries?: number;
  gradleSlots?: number;
  log?: Logger;
  isCancelled?: () => boolean;
  onGradleProc?: (proc: ChildProcess, isWin: boolean) => void;
}

export interface VerifyExistingProjectResult {
  success: boolean;
  buildSuccess: boolean;
  clientSuccess?: boolean;
  failureSummary?: string;
}

/** 验证已生成的模组变体（批任务 / GUI 复用，含 Forge Mavenizer 预热与自动修复） */
export async function verifyExistingProject(
  projectPath: string,
  loader: LoaderId,
  mcVersion: string,
  options: VerifyExistingProjectOptions = {},
): Promise<VerifyExistingProjectResult> {
  const log = options.log ?? (() => {});
  const lines: string[] = [];
  const capture: Logger = (line) => {
    lines.push(line);
    log(line);
  };
  const buildOnly = options.buildOnly === true;
  const gradleSlots = Math.max(1, options.gradleSlots ?? 1);
  const runOpts: Pick<GradleCommandLogOptions, "isCancelled" | "onProc"> = {
    isCancelled: options.isCancelled,
    onProc: options.onGradleProc,
  };
  const jdkOpts = options.isCancelled ? { isCancelled: options.isCancelled } : undefined;

  if (options.isCancelled?.()) {
    return { success: false, buildSuccess: false, failureSummary: "已取消" };
  }

  const detected = detectProject(projectPath);
  if (detected && loader === "forge") {
    const props: Record<string, string> = {};
    const propsFile = path.join(projectPath, "gradle.properties");
    if (fs.existsSync(propsFile)) {
      for (const line of fs.readFileSync(propsFile, "utf8").split("\n")) {
        const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
        if (m) props[m[1]] = m[2].trim();
      }
    }
    await repairCrossLoaderProject(
      projectPath,
      props.mod_id ?? detected.modId,
      props.mod_name ?? detected.displayName,
      props.maven_group ?? props.mod_group_id ?? detected.group,
      loader,
      mcVersion,
      capture,
    );
  }

  if (options.isCancelled?.()) {
    return { success: false, buildSuccess: false, failureSummary: "已取消" };
  }

  try {
    await ensureProjectToolchain(projectPath, mcVersion, capture);
  } catch (err) {
    return {
      success: false,
      buildSuccess: false,
      failureSummary: (err as Error).message,
    };
  }

  if (loader === "forge") {
    await withGradleBuildSlot(gradleSlots, () =>
      prewarmForgeMavenizerMcpTools(projectPath, capture, jdkOpts),
    ).catch(() => {});
  }

  if (options.isCancelled?.()) {
    return { success: false, buildSuccess: false, failureSummary: "已取消" };
  }

  let buildSuccess = await runVerifiedBuild(
    projectPath,
    lines,
    log,
    capture,
    options.buildRetries ?? 2,
    gradleSlots,
    runOpts,
  );

  if (!buildSuccess && options.autoFix !== false && !options.isCancelled?.()) {
    capture("\n===== 自动修复 =====");
    const fix = await applyVerificationFixes(
      projectPath,
      loader,
      mcVersion,
      lines.join("\n"),
      capture,
    );
    if (fix.applied.length > 0) {
      capture(`已应用：${fix.applied.join("、")}`);
      buildSuccess = await runVerifiedBuild(projectPath, lines, log, capture, 1, gradleSlots, runOpts);
    } else if (fix.notes.length > 0) {
      for (const note of fix.notes) capture(note);
    }
  }

  let clientSuccess: boolean | undefined;
  if (buildSuccess && !buildOnly && !options.isCancelled?.()) {
    await prewarmForgeSlimeLauncherAssets(projectPath, capture);
    clientSuccess = await runGradleClientVerify(
      projectPath,
      log,
      undefined,
      { onRawLine: capture, ...runOpts },
    ) === 0;
  }

  if (options.isCancelled?.()) {
    return { success: false, buildSuccess: false, failureSummary: "已取消" };
  }

  const success = buildOnly ? buildSuccess : (buildSuccess && !!clientSuccess);
  return {
    success,
    buildSuccess,
    clientSuccess: buildOnly ? undefined : clientSuccess,
    failureSummary: success ? undefined : summarizeVerificationFailure(lines),
  };
}
