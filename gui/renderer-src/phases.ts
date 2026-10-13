/** Phase stepper logic for a build/run job: which steps are done, active or failed, and how long each took. */
import { type JobInfo, type JobKind, type JobPhase, toMillis } from "./contract";
import { PHASE_LABELS } from "./status";

export type StepPhase = Exclude<JobPhase, "queued" | "exited">;
export type StepState = "pending" | "active" | "done" | "failed" | "cancelled" | "skipped";

export interface StepView {
  phase: StepPhase;
  label: string;
  state: StepState;
  /** Measured duration, or null when this step was not observed. */
  durationMs: number | null;
}

const RUN_STEPS: StepPhase[] = ["toolchain", "configure", "compile", "assets", "starting", "in-game"];
const BUILD_STEPS: StepPhase[] = ["toolchain", "configure", "compile", "assets"];

export function stepsForKind(kind: JobKind): StepPhase[] {
  return kind === "build" ? BUILD_STEPS : RUN_STEPS;
}

interface Span { start: number; end: number | null }

/**
 * Remembers when each phase was first seen. The job API only reports the current phase,
 * so per-phase durations are measured from the transitions this client observes.
 */
export class PhaseTimeline {
  private spans = new Map<JobPhase, Span>();
  private current: JobPhase | null = null;
  /** Highest step index ever observed for the given kind (-1 if none). */
  highest = -1;

  observe(job: JobInfo, now: number = Date.now()): void {
    const steps = stepsForKind(job.kind);
    const phaseStart = toMillis(job.phaseStartedAt) ?? now;
    if (job.phase !== this.current) {
      if (this.current) {
        const prev = this.spans.get(this.current);
        if (prev && prev.end === null) prev.end = Math.max(prev.start, phaseStart);
      }
      if (!this.spans.has(job.phase)) this.spans.set(job.phase, { start: phaseStart, end: null });
      this.current = job.phase;
    }
    const idx = steps.indexOf(job.phase as StepPhase);
    if (idx > this.highest) this.highest = idx;
    const finished = toMillis(job.finishedAt);
    if (finished !== null && job.state !== "running" && job.state !== "queued") {
      const span = this.spans.get(job.phase);
      if (span && span.end === null) span.end = Math.max(span.start, finished);
    }
  }

  duration(phase: JobPhase, now: number = Date.now()): number | null {
    const span = this.spans.get(phase);
    if (!span) return null;
    return (span.end ?? now) - span.start;
  }

  seen(phase: JobPhase): boolean {
    return this.spans.has(phase);
  }
}

/** Index of the step the job is in (or ended in); -1 while still queued. */
export function currentStepIndex(job: JobInfo, timeline?: PhaseTimeline): number {
  const steps = stepsForKind(job.kind);
  const idx = steps.indexOf(job.phase as StepPhase);
  if (idx >= 0) return idx;
  if (job.phase === "exited") {
    if (timeline && timeline.highest >= 0) return timeline.highest;
    return job.state === "succeeded" ? steps.length - 1 : -1;
  }
  return -1;
}

export function buildStepper(job: JobInfo, timeline: PhaseTimeline, now: number = Date.now()): StepView[] {
  const steps = stepsForKind(job.kind);
  const idx = currentStepIndex(job, timeline);
  const finishedOk = job.state === "succeeded";
  return steps.map((phase, i) => {
    let state: StepState;
    if (i < idx) state = "done";
    else if (i === idx) {
      state = job.state === "failed" ? "failed"
        : job.state === "cancelled" ? "cancelled"
        : finishedOk ? "done"
        : job.state === "queued" ? "pending"
        : "active";
    } else {
      state = finishedOk ? "skipped" : "pending";
    }
    let durationMs = timeline.duration(phase, now);
    if (durationMs === null && state === "active") {
      const started = toMillis(job.phaseStartedAt);
      durationMs = started !== null ? now - started : null;
    }
    return { phase, label: PHASE_LABELS[phase], state, durationMs: state === "pending" ? null : durationMs };
  });
}

/** Wall-clock time since the job started, frozen at finishedAt. */
export function totalElapsed(job: JobInfo, now: number = Date.now()): number | null {
  const start = toMillis(job.startedAt);
  if (start === null) return null;
  const end = toMillis(job.finishedAt) ?? now;
  return Math.max(0, end - start);
}

export const JOB_STATE_LABELS: Record<JobInfo["state"], string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** Headline for the panel: "编译中" while running, "已进入游戏" when the client is up. */
export function jobHeadline(job: JobInfo): string {
  if (job.state === "queued") return "排队中，等待空闲槽位";
  if (job.state === "running") {
    if (job.phase === "in-game") return "游戏运行中";
    if (job.phase === "queued") return "准备中";
    return PHASE_LABELS[job.phase] + "中";
  }
  if (job.state === "succeeded") return job.kind === "run" ? "游戏已正常退出" : "构建成功";
  if (job.state === "cancelled") return "已取消";
  return job.kind === "run" ? "启动失败" : "构建失败";
}

const LEGACY_PATTERNS: Array<[StepPhase, RegExp]> = [
  ["in-game", /Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas|Loaded \d+ advancements|Narrator library/i],
  ["starting", /> Task :[\w:-]*run(Client|Game)\b|Setting user: |Launching (?:target|wrapped minecraft)|ModLauncher running|Loading Minecraft \d|Backend library: LWJGL/i],
  ["assets", /> Task :[\w:-]*(processResources|downloadAssets|extractNatives|downloadNatives|prepareRun)/i],
  ["compile", /> Task :[\w:-]*(compile\w*|classes|jar|remapJar)\b/i],
  ["configure", /> Configure project|Evaluating settings|Configuring project|Fabric Loom:|ForgeGradle|NeoGradle|ModDevGradle|Starting Build/i],
  ["toolchain", /Starting a Gradle Daemon|Downloading https?:\/\/|JDK|Toolchain|java\.home|Welcome to Gradle/i],
];

/**
 * Infers a phase from one log line for the older backend that has no phase field.
 * Returns the matched phase only if it is later than `current` (phases never go back).
 */
export function inferPhaseFromLine(line: string, kind: JobKind, current: StepPhase | null): StepPhase | null {
  const steps = stepsForKind(kind);
  const currentIdx = current ? steps.indexOf(current) : -1;
  for (const [phase, re] of LEGACY_PATTERNS) {
    const idx = steps.indexOf(phase);
    if (idx < 0 || idx <= currentIdx) continue;
    if (re.test(line)) return phase;
  }
  return null;
}
