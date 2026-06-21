import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadDist, repoDist } from "./dist-loader";
import { getConcurrencyLimits } from "./concurrency-governor";
import { getGradleCore } from "./gradle-core-bridge";
import { withModVariantGenLock } from "./mod-gen-lock";
import { saveVariantBuildLog, appendVariantLiveLog, clearVariantLiveLog } from "./build-queue";

export type VariantBatchTargetStatus =
  | "pending"
  | "generating"
  | "verifying"
  | "done"
  | "failed"
  | "skipped"
  | "cancelled";

export type VariantBatchJobState = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface VariantBatchTarget {
  loader: string;
  mcVersion: string;
  status: VariantBatchTargetStatus;
  variantId?: string;
  projectPath?: string;
  message?: string;
  error?: string;
}

export interface VariantBatchJobSnapshot {
  id: string;
  modUuid: string;
  modName: string;
  sourceVariantId: string;
  state: VariantBatchJobState;
  buildOnly: boolean;
  mirror: boolean;
  phase: "generate" | "verify" | "done";
  targets: VariantBatchTarget[];
  total: number;
  completed: number;
  successes: number;
  failures: number;
  skipped: number;
  verifyParallel: number;
  /** 批验证实际 Gradle 并发（受全局信号量限制） */
  gradleParallel: number;
  startedAt: string;
  finishedAt?: string;
  lastError?: string;
}

type LoaderId = "fabric" | "forge" | "neoforge";
type WsVariant = {
  id: string;
  loader: string;
  mcVersion: string;
  projectPath: string;
};
type ManagedMod = {
  id: string;
  modId: string;
  displayName: string;
  variants: WsVariant[];
};

let jobsDir: string | null = null;
let runningJobId: string | null = null;
/** 真正在跑的 processor（cancel 后仍保持，直到 finally） */
const processingJobIds = new Set<string>();
const cancelRequested = new Set<string>();
const pendingBatchJobIds: string[] = [];

type TrackedProc = { proc: ChildProcess; isWin: boolean };
const activeVerifyProcs = new Map<string, TrackedProc[]>();

async function killJobVerifyProcs(jobId: string): Promise<void> {
  const list = activeVerifyProcs.get(jobId);
  if (!list?.length) return;
  const core = await getGradleCore();
  for (const { proc, isWin } of list) {
    core.killProcessTree(proc, isWin);
  }
  activeVerifyProcs.delete(jobId);
}

function trackVerifyProc(jobId: string, proc: ChildProcess, isWin: boolean): void {
  let list = activeVerifyProcs.get(jobId);
  if (!list) {
    list = [];
    activeVerifyProcs.set(jobId, list);
  }
  list.push({ proc, isWin });
}

async function enqueueBatchJob(jobId: string): Promise<void> {
  pendingBatchJobIds.push(jobId);
  await drainPendingBatchJobs();
}

async function drainPendingBatchJobs(): Promise<void> {
  if (runningJobId) return;
  while (pendingBatchJobIds.length > 0) {
    const nextId = pendingBatchJobIds.shift()!;
    const job = loadJobFromDisk(nextId);
    if (!job || job.state === "completed" || job.state === "cancelled") continue;
    await processVariantBatchJob(nextId);
  }
}

async function isForgeTargetAvailable(mcVersion: string): Promise<boolean> {
  const cacheMod = await loadDist<{ getForgeMdkCached: (mc: string) => boolean | undefined }>(
    repoDist("meta", "forge-mdk-cache.js"),
  );
  const cached = cacheMod.getForgeMdkCached(mcVersion);
  if (cached === false) return false;
  if (cached === true) return true;
  const forgeMod = await loadDist<{ isForgeMdkAvailable: (mc: string) => Promise<boolean> }>(
    repoDist("meta", "forge.js"),
  );
  return forgeMod.isForgeMdkAvailable(mcVersion);
}

async function workspaceModule(): Promise<any> {
  return loadDist(repoDist("workspace", "index.js"));
}

async function getStore(): Promise<any> {
  const mod = await loadDist(repoDist("workspace", "store.js"));
  return mod.getWorkspace();
}

async function resolveJobsDir(): Promise<string> {
  if (jobsDir) return jobsDir;
  const ws = await workspaceModule();
  jobsDir = path.join(ws.getDmclDir(), "batch-jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  return jobsDir;
}

function jobFile(id: string): string {
  return path.join(jobsDir!, `${id}.json`);
}

function persistJob(job: VariantBatchJobSnapshot): void {
  if (!jobsDir) return;
  fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2), "utf8");
}

function loadJobFromDisk(id: string): VariantBatchJobSnapshot | null {
  if (!jobsDir) return null;
  const file = jobFile(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as VariantBatchJobSnapshot;
  } catch {
    return null;
  }
}

function computeVerifyParallel(
  total: number,
  hasForge: boolean,
): { workers: number; gradleParallel: number } {
  const limits = getConcurrencyLimits();
  const gradle = limits.gradleBuildConcurrency;
  const gradleParallel = 1;
  if (hasForge || total >= 48) return { workers: 1, gradleParallel };
  if (total >= 16) return { workers: Math.min(gradle, 2), gradleParallel };
  return { workers: Math.min(gradle, 3), gradleParallel };
}

function recomputeCounters(job: VariantBatchJobSnapshot): void {
  job.completed = 0;
  job.successes = 0;
  job.failures = 0;
  job.skipped = 0;
  for (const t of job.targets) {
    if (t.status === "done") {
      job.completed++;
      job.successes++;
    } else if (t.status === "failed" || t.status === "cancelled") {
      job.completed++;
      job.failures++;
    } else if (t.status === "skipped") {
      job.completed++;
      job.skipped++;
    }
  }
}

export async function ensureBatchJobsDir(): Promise<void> {
  await resolveJobsDir();
}

export function getVariantBatchJob(id: string): VariantBatchJobSnapshot | null {
  return loadJobFromDisk(id);
}

export function listVariantBatchJobs(limit = 20): VariantBatchJobSnapshot[] {
  if (!jobsDir || !fs.existsSync(jobsDir)) return [];
  return fs.readdirSync(jobsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(jobsDir!, f), "utf8")) as VariantBatchJobSnapshot;
      } catch {
        return null;
      }
    })
    .filter((j): j is VariantBatchJobSnapshot => !!j)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function getActiveVariantBatchJob(): VariantBatchJobSnapshot | null {
  if (processingJobIds.size > 0) {
    const id = runningJobId ?? [...processingJobIds][0];
    const live = loadJobFromDisk(id);
    if (live) return live;
  }
  if (runningJobId) {
    const live = loadJobFromDisk(runningJobId);
    if (live && live.state === "running") return live;
  }
  if (!jobsDir) return null;
  const jobs = listVariantBatchJobs(50);
  return jobs.find((j) => j.state === "running" || j.state === "pending") ?? null;
}

export function cancelVariantBatchJob(id: string): VariantBatchJobSnapshot | null {
  cancelRequested.add(id);
  void killJobVerifyProcs(id);
  const job = loadJobFromDisk(id);
  if (!job) return null;
  if (job.state === "completed" || job.state === "cancelled") return job;
  job.state = "cancelled";
  job.phase = "done";
  job.finishedAt = new Date().toISOString();
  for (const t of job.targets) {
    if (t.status === "pending" || t.status === "generating" || t.status === "verifying") {
      t.status = "cancelled";
      t.message = "已取消";
    }
  }
  recomputeCounters(job);
  persistJob(job);
  return job;
}

export async function startVariantBatchJob(input: {
  modUuid: string;
  modName: string;
  sourceVariantId: string;
  targets: Array<{ loader: string; mcVersion: string }>;
  buildOnly?: boolean;
  mirror?: boolean;
}): Promise<VariantBatchJobSnapshot> {
  await resolveJobsDir();

  const active = getActiveVariantBatchJob();
  if (active || processingJobIds.size > 0) {
    const ref = active ?? loadJobFromDisk(runningJobId ?? [...processingJobIds][0] ?? "");
    throw new Error(`已有批量任务进行中（${(ref?.successes ?? 0) + (ref?.failures ?? 0)}/${ref?.total ?? "?"}），请等待完成或取消后再试`);
  }

  if (!input.targets.length) {
    throw new Error("没有可创建的目标");
  }

  const buildOnly = input.buildOnly !== false;
  const hasForge = input.targets.some((t) => t.loader === "forge");
  const parallel = computeVerifyParallel(input.targets.length, hasForge);
  const job: VariantBatchJobSnapshot = {
    id: randomUUID(),
    modUuid: input.modUuid,
    modName: input.modName,
    sourceVariantId: input.sourceVariantId,
    state: "pending",
    buildOnly,
    mirror: input.mirror !== false,
    phase: "generate",
    targets: input.targets.map((t) => ({
      loader: t.loader,
      mcVersion: t.mcVersion,
      status: "pending",
      message: "等待中…",
    })),
    total: input.targets.length,
    completed: 0,
    successes: 0,
    failures: 0,
    skipped: 0,
    verifyParallel: parallel.workers,
    gradleParallel: parallel.gradleParallel,
    startedAt: new Date().toISOString(),
  };

  persistJob(job);
  void enqueueBatchJob(job.id);
  return job;
}

export async function resumeVariantBatchJobs(): Promise<void> {
  await resolveJobsDir();
  const stale = listVariantBatchJobs(100)
    .filter((j) => j.state === "running" || j.state === "pending")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!stale.length) return;

  for (const job of stale) {
    for (const t of job.targets) {
      if (t.status === "generating" || t.status === "verifying") {
        t.status = "pending";
        t.message = "恢复任务…";
      }
    }
    job.state = "pending";
    persistJob(job);
    pendingBatchJobIds.push(job.id);
  }
  await drainPendingBatchJobs();
}

async function processVariantBatchJob(jobId: string): Promise<void> {
  if (processingJobIds.has(jobId)) return;
  if (runningJobId && runningJobId !== jobId) return;

  await resolveJobsDir();
  const job = loadJobFromDisk(jobId);
  if (!job || job.state === "completed" || job.state === "cancelled") return;

  processingJobIds.add(jobId);
  runningJobId = jobId;
  cancelRequested.delete(jobId);
  job.state = "running";
  persistJob(job);

  try {
    const ws = await workspaceModule();
    const store = await getStore();
    store.refresh({ force: true });

    let mod = store.getMod(job.modUuid) as ManagedMod | undefined;
    if (!mod) throw new Error("模组不存在");

    let source = mod.variants.find((v) => v.id === job.sourceVariantId);
    if (!source) {
      const onDisk = ws.findVariantOnDisk(store, job.sourceVariantId);
      if (onDisk) source = onDisk.variant;
    }
    if (!source) {
      throw new Error(`源变体不存在：${job.sourceVariantId}`);
    }

    // —— 阶段 1：串行生成（避免工作区元数据竞态）——
    job.phase = "generate";
    persistJob(job);

    for (let i = 0; i < job.targets.length; i++) {
      if (cancelRequested.has(jobId)) break;
      const target = job.targets[i];
      if (target.status === "done" || target.status === "skipped" || target.status === "failed") {
        continue;
      }

      target.status = "generating";
      target.message = "正在生成项目…";
      persistJob(job);

      if (target.loader === "forge") {
        try {
          const forgeOk = await isForgeTargetAvailable(target.mcVersion);
          if (!forgeOk) {
            target.status = "skipped";
            target.message = "Forge MDK 不可用，已跳过";
            recomputeCounters(job);
            persistJob(job);
            continue;
          }
        } catch (err) {
          target.status = "failed";
          target.error = `Forge MDK 探测失败：${(err as Error).message}`;
          target.message = target.error;
          recomputeCounters(job);
          persistJob(job);
          continue;
        }
      }

      store.refresh({ force: true });
      mod = store.getMod(job.modUuid) as ManagedMod;

      try {
        const variant = await withModVariantGenLock(job.modUuid, async () => {
          return ws.generateVariant({
            mod,
            sourceVariant: source!,
            targetLoader: target.loader as LoaderId,
            targetMc: target.mcVersion,
            mirror: job.mirror,
          }, (msg: string) => {
            if (/跳过|已存在/.test(msg)) target.message = msg;
          }) as WsVariant;
        });

        if (cancelRequested.has(jobId)) {
          target.status = "cancelled";
          target.message = "已取消";
        } else {
          target.variantId = variant.id;
          target.projectPath = variant.projectPath;
          if (/跳过|已存在/.test(target.message || "")) {
            target.message = target.message || "已存在，继续验证…";
          } else {
            target.message = "已生成，等待构建验证…";
          }
          target.status = "pending";
        }
      } catch (err) {
        if (cancelRequested.has(jobId)) {
          target.status = "cancelled";
          target.message = "已取消";
        } else {
          target.status = "failed";
          target.error = (err as Error).message;
          target.message = target.error;
        }
      }

      recomputeCounters(job);
      persistJob(job);
    }

    if (cancelRequested.has(jobId)) {
      job.state = "cancelled";
      job.phase = "done";
      job.finishedAt = new Date().toISOString();
      persistJob(job);
      return;
    }

    // —— 阶段 2：并行 Gradle 构建验证（受 governor 限流）——
    job.phase = "verify";
    const hasForge = job.targets.some((t) => t.loader === "forge");
    const parallel = computeVerifyParallel(job.total, hasForge);
    job.verifyParallel = parallel.workers;
    job.gradleParallel = parallel.gradleParallel;
    persistJob(job);

    const verifyIndices: number[] = [];
    for (let i = 0; i < job.targets.length; i++) {
      const t = job.targets[i];
      if (t.projectPath && t.status !== "failed" && t.status !== "done") {
        verifyIndices.push(i);
      }
    }

    let nextVerify = 0;
    const verifyParallel = job.verifyParallel;

    async function verifyWorker(): Promise<void> {
      while (!cancelRequested.has(jobId)) {
        const idx = nextVerify++;
        if (idx >= verifyIndices.length) return;

        const targetIndex = verifyIndices[idx];
        const target = job!.targets[targetIndex];
        if (!target.projectPath) continue;

        target.status = "verifying";
        target.message = "正在 Gradle 构建验证…";
        persistJob(job!);

        const lines: string[] = [];
        const log = (line: string) => {
          lines.push(line);
          if (target.variantId) appendVariantLiveLog(target.variantId, line);
          if (/正在|构建|Forge|Mavenizer|修复|失败|成功|✔|错误/i.test(line)) {
            target.message = line.length > 120 ? line.slice(0, 120) + "…" : line;
            persistJob(job!);
          }
        };

        try {
          if (target.variantId) {
            store.updateVariantBuildStatus(target.variantId, "building");
          }

          const wsIndex = await loadDist(repoDist("workspace", "index.js"));
          const result = await wsIndex.verifyExistingProject(
            target.projectPath,
            target.loader as LoaderId,
            target.mcVersion,
            {
              buildOnly: job!.buildOnly,
              autoFix: true,
              buildRetries: 2,
              gradleSlots: job!.gradleParallel ?? 1,
              log,
              isCancelled: () => cancelRequested.has(jobId),
              onGradleProc: (proc: ChildProcess, isWin: boolean) => trackVerifyProc(jobId, proc, isWin),
            },
          );

          if (cancelRequested.has(jobId)) {
            target.status = "cancelled";
            target.message = "已取消";
            if (target.variantId) store.updateVariantBuildStatus(target.variantId, "failed");
          } else if (result.success) {
            target.status = "done";
            target.message = job!.buildOnly ? "构建验证通过" : "创建并验证完成";
            target.error = undefined;
            if (target.variantId) store.updateVariantBuildStatus(target.variantId, "success");
          } else {
            throw new Error(result.failureSummary || "Gradle 构建验证失败");
          }
        } catch (err) {
          if (cancelRequested.has(jobId)) {
            target.status = "cancelled";
            target.message = "已取消";
            if (target.variantId) store.updateVariantBuildStatus(target.variantId, "failed");
          } else {
            target.status = "failed";
            target.error = (err as Error).message;
            target.message = target.error;
            if (target.variantId) store.updateVariantBuildStatus(target.variantId, "failed");
          }
        }

        recomputeCounters(job!);
        persistJob(job!);
        if (target.variantId) clearVariantLiveLog(target.variantId);
        if (lines.length > 0 && target.projectPath) {
          saveVariantBuildLog(target.projectPath, lines);
        }
      }
    }

    await Promise.all(
      Array.from({ length: verifyParallel }, () => verifyWorker()),
    );

    recomputeCounters(job);
    job.phase = "done";
    job.finishedAt = new Date().toISOString();
    if (cancelRequested.has(jobId)) {
      job.state = "cancelled";
    } else if (job.failures > 0 && job.successes === 0) {
      job.state = "failed";
      job.lastError = job.targets.find((t) => t.error)?.error;
    } else {
      job.state = "completed";
    }
    persistJob(job);
  } catch (err) {
    const failed = loadJobFromDisk(jobId);
    if (failed) {
      failed.state = "failed";
      failed.phase = "done";
      failed.lastError = (err as Error).message;
      failed.finishedAt = new Date().toISOString();
      persistJob(failed);
    }
  } finally {
    processingJobIds.delete(jobId);
    if (runningJobId === jobId) runningJobId = null;
    activeVerifyProcs.delete(jobId);
    void drainPendingBatchJobs();
  }
}
