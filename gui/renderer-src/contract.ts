/**
 * Shapes of the launch/job API the renderer consumes, plus normalisers that accept
 * both the job-based backend and the older build-queue backend.
 */

export type JobKind = "build" | "run";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobPhase = "queued" | "toolchain" | "configure" | "compile" | "assets" | "starting" | "in-game" | "exited";
export type VariantRunState = "unknown" | JobState;

/** Timestamps may arrive as ISO strings or epoch milliseconds. */
export type Timestamp = string | number;

export interface JobInfo {
  jobId: string;
  variantId: string;
  kind: JobKind;
  state: JobState;
  phase: JobPhase;
  startedAt: Timestamp | null;
  phaseStartedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  reason: string | null;
  logLineCount: number;
}

export interface JobLogChunk {
  lines: string[];
  next: number;
  done: boolean;
}

export interface VariantStatus {
  state: VariantRunState;
  kind: JobKind | null;
  at: Timestamp | null;
  reason: string | null;
  phaseReached: JobPhase | null;
  activeJobId: string | null;
}

export interface HostJob {
  kind: string;
  label: string;
  pid?: number | null;
  startedAt?: Timestamp | null;
  progress?: unknown;
  source: "linker" | "dmcl" | string;
}

export interface HostActivity {
  busy: boolean;
  jobs: HostJob[];
}

const JOB_STATES: readonly string[] = ["queued", "running", "succeeded", "failed", "cancelled"];
const PHASES: readonly string[] = ["queued", "toolchain", "configure", "compile", "assets", "starting", "in-game", "exited"];

export function isTerminal(state: VariantRunState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export function isActive(state: VariantRunState): boolean {
  return state === "queued" || state === "running";
}

export function toMillis(value: Timestamp | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asPhase(value: unknown): JobPhase | null {
  return typeof value === "string" && PHASES.includes(value) ? (value as JobPhase) : null;
}

function asKind(value: unknown): JobKind | null {
  return value === "build" || value === "run" ? value : null;
}

function asTimestamp(value: unknown): Timestamp | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/**
 * The variant's latest run state. Uses `variant.status` from the job backend when present,
 * otherwise maps the legacy `buildStatus` / `lastBuiltAt` fields.
 */
export function variantStatusOf(variant: Record<string, any>): VariantStatus {
  const s = variant && variant.status;
  if (s && typeof s === "object" && typeof s.state === "string") {
    const state = (s.state === "unknown" || JOB_STATES.includes(s.state) ? s.state : "unknown") as VariantRunState;
    return {
      state,
      kind: asKind(s.kind),
      at: asTimestamp(s.at),
      reason: str(s.reason),
      phaseReached: asPhase(s.phaseReached),
      activeJobId: str(s.activeJobId),
    };
  }
  const legacy = variant ? variant.buildStatus : undefined;
  const state: VariantRunState = legacy === "success" ? "succeeded"
    : legacy === "failed" ? "failed"
    : legacy === "building" ? "running"
    : "unknown";
  return {
    state,
    kind: null,
    at: asTimestamp(variant ? variant.lastBuiltAt : null),
    reason: null,
    phaseReached: null,
    activeJobId: null,
  };
}

/** Validates a `GET /api/jobs/:id` payload; null when it is not a job. */
export function parseJob(raw: unknown): JobInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const jobId = str(r.jobId);
  const state = typeof r.state === "string" && JOB_STATES.includes(r.state) ? (r.state as JobState) : null;
  if (!jobId || !state) return null;
  return {
    jobId,
    variantId: str(r.variantId) || "",
    kind: asKind(r.kind) || "run",
    state,
    phase: asPhase(r.phase) || (state === "queued" ? "queued" : "toolchain"),
    startedAt: asTimestamp(r.startedAt),
    phaseStartedAt: asTimestamp(r.phaseStartedAt),
    finishedAt: asTimestamp(r.finishedAt),
    reason: str(r.reason),
    logLineCount: typeof r.logLineCount === "number" ? r.logLineCount : 0,
  };
}

export function parseLogChunk(raw: unknown, from: number): JobLogChunk {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const lines = Array.isArray(r.lines) ? r.lines.map((l) => String(l)) : [];
  const next = typeof r.next === "number" ? r.next : from + lines.length;
  return { lines, next, done: r.done === true };
}

export function parseHostActivity(raw: unknown): HostActivity {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const jobs = Array.isArray(r.jobs)
    ? r.jobs.filter((j): j is Record<string, unknown> => !!j && typeof j === "object").map((j) => ({
      kind: String(j.kind ?? ""),
      label: String(j.label ?? j.kind ?? ""),
      pid: typeof j.pid === "number" ? j.pid : null,
      startedAt: asTimestamp(j.startedAt),
      progress: j.progress,
      source: typeof j.source === "string" ? j.source : "dmcl",
    }))
    : [];
  return { busy: r.busy === true || (r.busy === undefined && jobs.length > 0), jobs };
}
