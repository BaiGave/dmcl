import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

type BuildStatus = "unknown" | "success" | "failed" | "building";

export interface BuildJob {
  id: string;
  variantId: string;
  projectPath: string;
  type: "build" | "run" | "build+run";
}

type JobCallback = (event: {
  type: "start" | "progress" | "done" | "queue";
  job?: BuildJob;
  line?: string;
  success?: boolean;
  queueLength?: number;
}) => void;

let queue: BuildJob[] = [];
let running = false;
let currentJob: BuildJob | null = null;
let cancelled = false;
let listeners: JobCallback[] = [];

function projectRoot(): string {
  return path.resolve(__dirname, "..");
}

function logsBaseDir(): string {
  return path.join(os.homedir(), ".dmcl", "logs");
}

async function updateVariantStatus(variantId: string, status: BuildStatus): Promise<void> {
  try {
    const mod = await import(path.join(projectRoot(), "dist", "workspace", "store.js"));
    mod.getWorkspace().updateVariantBuildStatus(variantId, status);
  } catch { /* ignore */ }
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

export function getQueueStatus(): { running: boolean; current: BuildJob | null; pending: number } {
  return { running, current: currentJob, pending: queue.length };
}

export function cancelBuildQueue(): void {
  cancelled = true;
  queue.length = 0;
  void import("./gradle-runner").then((m) => m.killCurrentRunner());
}

export function resetBuildQueueCancel(): void {
  cancelled = false;
}

export function enqueueBuild(job: Omit<BuildJob, "id">): string {
  resetBuildQueueCancel();
  const entry: BuildJob = { ...job, id: randomUUID() };
  queue.push(entry);
  emit({ type: "queue", queueLength: queue.length });
  void processQueue();
  return entry.id;
}

export function enqueueBatch(jobs: Array<Omit<BuildJob, "id">>): string[] {
  return jobs.map((j) => enqueueBuild(j));
}

function saveLog(variantId: string, lines: string[]): string {
  const dir = path.join(logsBaseDir(), variantId);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${Date.now()}-${randomUUID()}.log`);
  fs.writeFileSync(logPath, lines.join("\n"), "utf8");
  return logPath;
}

export function listLogs(variantId: string): Array<{ name: string; path: string; mtime: number }> {
  const dir = path.join(logsBaseDir(), variantId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .map((name) => {
      const p = path.join(dir, name);
      return { name, path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function readLog(logPath: string): string {
  const resolved = path.resolve(logPath);
  const base = path.resolve(logsBaseDir());
  if (!resolved.startsWith(base + path.sep)) return "";
  if (!fs.existsSync(resolved)) return "";
  return fs.readFileSync(resolved, "utf8");
}

async function processQueue(): Promise<void> {
  if (running) return;
  running = true;

  while (queue.length > 0 && !cancelled) {
    const job = queue.shift()!;
    currentJob = job;
    emit({ type: "start", job });

    const lines: string[] = [];
    const logLine = (line: string) => {
      lines.push(line);
      emit({ type: "progress", job, line });
    };

    let success = false;
    try {
      const { runBuildOnly, runClientOnly } = await import("./gradle-runner");
      if (job.type === "build" || job.type === "build+run") {
        const code = await runBuildOnly(job.projectPath, logLine);
        if (code !== 0) {
          success = false;
        } else if (job.type === "build") {
          success = true;
        } else {
          const clientCode = await runClientOnly(job.projectPath, logLine);
          success = clientCode === 0;
        }
      } else {
        const code = await runClientOnly(job.projectPath, logLine);
        success = code === 0;
      }
    } catch (err) {
      logLine(`错误：${(err as Error).message}`);
      success = false;
    }

    if (cancelled) success = false;
    saveLog(job.variantId, lines);
    await updateVariantStatus(job.variantId, success ? "success" : "failed");

    emit({ type: "done", job, success });
    currentJob = null;
  }

  running = false;
}
