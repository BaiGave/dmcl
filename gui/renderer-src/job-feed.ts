/**
 * Polls one job's state and log. Uses the job API (`/api/jobs/:id`, `/log?from=`) when the
 * backend has it, and otherwise reconstructs a job from the older per-variant live log.
 */
import { api, isMissingEndpoint, isNotFound } from "./api";
import { type JobInfo, type JobKind, type JobState, isTerminal, parseJob, parseLogChunk } from "./contract";
import { inferPhaseFromLine, type StepPhase } from "./phases";

export interface FeedUpdate {
  job: JobInfo;
  /** New lines since the previous update. */
  lines: string[];
  /** When true, discard what was shown before and use `lines` as the whole log. */
  reset?: boolean;
  /** True once nothing more will change. */
  finished: boolean;
}

export interface JobFeed {
  readonly legacy: boolean;
  next(): Promise<FeedUpdate>;
  cancel(): Promise<void>;
}

export type FetchJson = (path: string, opts?: { method?: string; body?: unknown }) => Promise<any>;

/** Session-wide result of probing `/api/jobs`; "unknown" until the first job request. */
let jobsApi: "unknown" | "yes" | "no" = "unknown";

export function jobsApiSupport(): "unknown" | "yes" | "no" {
  return jobsApi;
}

/** Test hook. */
export function resetJobsApiProbe(value: "unknown" | "yes" | "no" = "unknown"): void {
  jobsApi = value;
}

const enc = encodeURIComponent;

class ApiJobFeed implements JobFeed {
  readonly legacy = false;
  private from = 0;
  private logDone = false;

  constructor(private readonly jobId: string, private readonly fetchJson: FetchJson, private first: JobInfo | null = null) {}

  async next(): Promise<FeedUpdate> {
    const job = this.first || parseJob(await this.fetchJson("/api/jobs/" + enc(this.jobId)));
    this.first = null;
    if (!job) throw new Error("任务数据无效");
    let lines: string[] = [];
    if (!this.logDone) {
      const chunk = parseLogChunk(await this.fetchJson("/api/jobs/" + enc(this.jobId) + "/log?from=" + this.from), this.from);
      lines = chunk.lines;
      this.from = chunk.next;
      this.logDone = chunk.done;
    }
    return { job, lines, finished: isTerminal(job.state) && this.logDone };
  }

  async cancel(): Promise<void> {
    await this.fetchJson("/api/jobs/" + enc(this.jobId) + "/cancel", { method: "POST" });
  }
}

export interface LegacyContext {
  variantId: string;
  kind: JobKind;
  jobId?: string | null;
  /** Reads the variant's stored result once the live log is gone. */
  outcome: () => Promise<JobState>;
  /** Only show the saved log; there is no running job to follow. */
  staticOnly?: boolean;
}

/**
 * Older backend: the live log is the whole text of `/api/variants/:id/log` while
 * `source === "live"`; afterwards the saved log replaces it. Phases are inferred from lines.
 */
class LegacyJobFeed implements JobFeed {
  readonly legacy = true;
  private shown = 0;
  private seenLive = false;
  private idlePolls = 0;
  private phase: StepPhase | null = null;
  private readonly job: JobInfo;

  constructor(private readonly ctx: LegacyContext, private readonly fetchJson: FetchJson, now = Date.now()) {
    this.job = {
      jobId: ctx.jobId || "legacy:" + ctx.variantId,
      variantId: ctx.variantId,
      kind: ctx.kind,
      state: ctx.staticOnly ? "succeeded" : "queued",
      phase: "queued",
      startedAt: ctx.staticOnly ? null : now,
      phaseStartedAt: now,
      finishedAt: null,
      reason: null,
      logLineCount: 0,
    };
  }

  private advance(lines: readonly string[], now: number): void {
    for (const line of lines) {
      const next = inferPhaseFromLine(line, this.job.kind, this.phase);
      if (next) {
        this.phase = next;
        this.job.phase = next;
        this.job.phaseStartedAt = now;
      }
    }
  }

  async next(): Promise<FeedUpdate> {
    const now = Date.now();
    const payload = await this.fetchJson("/api/variants/" + enc(this.ctx.variantId) + "/log") as {
      content?: string; source?: string; hint?: string;
    };
    const content = typeof payload.content === "string" ? payload.content : "";
    const all = content ? content.split("\n") : [];

    if (this.ctx.staticOnly) {
      const lines = all.length ? all : [payload.hint || "暂无日志"];
      this.job.state = await this.ctx.outcome();
      this.job.phase = "exited";
      this.job.logLineCount = lines.length;
      return { job: { ...this.job }, lines, reset: true, finished: true };
    }

    if (payload.source === "live") {
      this.seenLive = true;
      if (this.job.state === "queued") {
        this.job.state = "running";
        this.job.phase = "toolchain";
        this.job.phaseStartedAt = now;
        this.phase = "toolchain";
      }
      const reset = all.length < this.shown;
      const fresh = reset ? all : all.slice(this.shown);
      this.shown = all.length;
      this.advance(fresh, now);
      this.job.logLineCount = all.length;
      return { job: { ...this.job }, lines: fresh, reset, finished: false };
    }

    // Not live: either still waiting in the queue, or finished and saved.
    if (!this.seenLive) {
      const queue = await this.fetchJson("/api/queue").catch(() => null) as { active?: number; pending?: number; running?: boolean } | null;
      const busy = !!queue && ((queue.active ?? 0) > 0 || (queue.pending ?? 0) > 0 || queue.running === true);
      this.idlePolls = busy ? 0 : this.idlePolls + 1;
      if (this.idlePolls < 3) return { job: { ...this.job }, lines: [], finished: false };
    }
    this.job.state = await this.ctx.outcome();
    this.job.finishedAt = now;
    if (this.job.phase === "queued") this.job.phase = "exited";
    const lines = all.length ? all : [];
    this.advance(lines, now);
    this.job.logLineCount = lines.length;
    return { job: { ...this.job }, lines, reset: lines.length > 0, finished: true };
  }

  async cancel(): Promise<void> {
    await this.fetchJson("/api/queue/cancel", { method: "POST" });
  }
}

export interface OpenFeedOptions {
  jobId?: string | null;
  legacy: LegacyContext;
  fetchJson?: FetchJson;
}

/**
 * Picks the feed for a job. Probes the job API once per session; a 404 switches to the
 * legacy feed. A job id the backend no longer knows (e.g. after restart) also falls back.
 */
export async function openJobFeed(opts: OpenFeedOptions): Promise<JobFeed> {
  const fetchJson = opts.fetchJson || api;
  if (opts.jobId && jobsApi !== "no") {
    try {
      const first = parseJob(await fetchJson("/api/jobs/" + enc(opts.jobId)));
      if (first) {
        jobsApi = "yes";
        return new ApiJobFeed(opts.jobId, fetchJson, first);
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // A JSON 404 means the job API exists but no longer knows this job (e.g. after a restart);
      // a plain 404 means the backend has no job API at all.
      if (isMissingEndpoint(err)) jobsApi = "no";
      else jobsApi = "yes";
    }
  }
  const staticOnly = !opts.jobId || jobsApi === "yes";
  return new LegacyJobFeed({ ...opts.legacy, staticOnly: opts.legacy.staticOnly ?? staticOnly }, fetchJson);
}
