import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoaderId, Logger, MappingsId, ProjectOptions } from "../types.js";
import { DEFAULT_MAPPINGS } from "../types.js";
import { runGradleBuild, runGradleBuildDiagnostics, runGradleClientVerify } from "../core/build.js";
import {
  ensureForgeMavenizerJdkCache,
  prewarmForgeMavenizerLibraries,
  prewarmForgeMavenizerMcpTools,
  prewarmForgeSlimeLauncherAssets,
} from "../core/forge-mavenizer.js";
import { ensureProjectJdk } from "../core/jdk.js";
import { scaffoldProject, pascalCase } from "../core/scaffold.js";
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
  force?: boolean;
  includeFailed?: boolean;
}

export interface VersionVerificationRunOptions extends VersionVerificationPlanOptions {
  limit?: number;
  rootDir?: string;
  mirror?: boolean;
  keepProjects?: boolean;
  buildRetries?: number;
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

export async function loadVersionVerificationPlan(
  opts: VersionVerificationPlanOptions = {},
): Promise<VersionVerificationTarget[]> {
  const { data } = await getMetaCache().get({ strategy: "fresh" });
  return buildVersionVerificationPlan(data, readVersionVerificationIndex(), opts);
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
  if (t !== r && t.startsWith(r + path.sep)) {
    await fs.promises.rm(target, { recursive: true, force: true });
    return;
  }
  throw new Error(`Refusing to remove path outside verification root: ${target}`);
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
): Promise<boolean> {
  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const start = lines.length;
    const diagnostic = attempt > 1;
    capture(`\n===== Gradle build attempt ${attempt}/${attempts}${diagnostic ? " (diagnostic)" : ""} =====`);
    const code = diagnostic
      ? await runGradleBuildDiagnostics(projectPath, log, { onRawLine: capture })
      : await runGradleBuild(projectPath, log, undefined, { onRawLine: capture });

    if (code === 0) return true;

    const attemptLines = lines.slice(start);
    if (attempt < attempts) {
      const prewarmed = await prewarmForgeMavenizerLibraries(projectPath, capture);
      if (prewarmed.downloaded > 0) {
        log(`Prewarmed ${prewarmed.downloaded} Forge Mavenizer libraries before retry`);
      }
      const tools = await prewarmForgeMavenizerMcpTools(projectPath, capture);
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
): VersionVerificationRunResult["status"] {
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
    await ensureProjectJdk(projectPath, target.mcVersion, tee);
    await ensureForgeMavenizerJdkCache(projectPath, tee);
    setupComplete = true;
    buildSuccess = await runVerifiedBuild(projectPath, lines, log, capture, opts.buildRetries ?? 2);
    if (buildSuccess) {
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
  const summary = buildSuccess && clientSuccess ? undefined : summarizeVerificationFailure(failureLines, caught?.message);
  const record = recordVersionVerification({
    loader: target.loader,
    mcVersion: target.mcVersion,
    jobType: "build+run",
    projectPath,
    buildSuccess,
    clientSuccess: buildSuccess ? clientSuccess : undefined,
    failureSummary: summary,
  });
  const updatedTarget = { ...target, summary: summarizeVersionVerification(record) };
  const finishedMs = Date.now();

  if (!opts.keepProjects && buildSuccess && clientSuccess) {
    try {
      await removeChildDir(rootDir, projectPath);
    } catch (err) {
      log(`Unable to clean verified project ${projectPath}: ${(err as Error).message}`);
    }
  }

  return {
    target: updatedTarget,
    projectPath,
    status: runStatus(setupComplete, buildSuccess, clientSuccess),
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
    results,
  };
}

export async function runVersionVerificationBatch(
  opts: VersionVerificationRunOptions = {},
  log: Logger = () => {},
): Promise<VersionVerificationBatchResult> {
  const startedAt = new Date().toISOString();
  const rootDir = path.resolve(opts.rootDir ?? DEFAULT_VERIFY_ROOT);
  const reportFile = reportPath(rootDir, startedAt);
  const plan = await loadVersionVerificationPlan(opts);
  const limit = Math.max(0, opts.limit ?? plan.length);
  const selected = plan.slice(0, limit);
  const results: VersionVerificationRunResult[] = [];

  await writeBatchReport(reportFile, summarizeBatch(startedAt, reportFile, plan.length, selected.length, results));

  for (let index = 0; index < selected.length; index++) {
    const target = selected[index];
    log(`[${index + 1}/${selected.length}] ${target.loader} ${target.mcVersion}`);
    try {
      results.push(await verifyOneVersion(target, { ...opts, rootDir }, log));
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
        jobType: "build+run",
        projectPath,
        buildSuccess: false,
        failureSummary: error.message,
      });
      results.push({
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
      });
      log(`Unexpected verification failure: ${error.message}`);
    }
    await writeBatchReport(
      reportFile,
      summarizeBatch(startedAt, reportFile, plan.length, selected.length, results),
    );
  }

  const result = summarizeBatch(startedAt, reportFile, plan.length, selected.length, results);
  await writeBatchReport(reportFile, result);
  return result;
}

export async function runAllVersionVerifications(
  opts: Omit<VersionVerificationRunOptions, "limit"> = {},
  log: Logger = () => {},
): Promise<VersionVerificationBatchResult> {
  return runVersionVerificationBatch({ ...opts, limit: undefined }, log);
}
