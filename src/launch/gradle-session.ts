import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import {
  attachLineStream,
  ensureGradlewExecutable,
  findClientLatestLogs,
  gradleSpawn,
  hasGradlew,
  killProcessTree,
} from "../core/gradle.js";
import { registerHostActivity, type ActivityRegistration } from "./host-activity.js";
import {
  OutputTracker,
  TITLE_SCREEN_LINE,
  classifyBuildExit,
  classifyRunExit,
  type JobOutcomeStatus,
  type JobPhase,
} from "./phases.js";

export interface GradleSessionOptions {
  kind: "build" | "run";
  /** Gradle tasks and flags, e.g. ["runClient", "--no-daemon"]. `--console=plain` is added. */
  tasks: string[];
  /** Label for the host activity registry, e.g. "DMCL runClient linker fabric-1.20.1". */
  label: string;
  onLine?: (line: string) => void;
  onPhase?: (phase: JobPhase, detail?: string) => void;
  isCancelled?: () => boolean;
  onProc?: (proc: ChildProcess, isWin: boolean) => void;
  /** run: stop the client a moment after the title screen and count that as success (smoke launch). */
  stopAtTitle?: boolean;
  /** Kill the process after this long (never set for interactive play). */
  timeoutMs?: number;
  /** Register in the machine-wide host activity registry (default true). */
  hostActivity?: boolean;
}

export interface GradleSessionResult {
  status: JobOutcomeStatus;
  reason?: string;
  exitCode: number | null;
  phaseReached: JobPhase;
  titleReached: boolean;
  /** From process start to the title screen line. */
  timeToTitleMs?: number;
  durationMs: number;
  pid?: number;
}

const STOP_AFTER_TITLE_MS = 2000;

/**
 * Runs one Gradle invocation with phase tracking, host activity registration and cancellation.
 * Used for both explicit builds and launches (`runClient` only - no full build first).
 */
export async function runGradleSession(targetDir: string, opts: GradleSessionOptions): Promise<GradleSessionResult> {
  const startedAt = Date.now();
  const tracker = new OutputTracker(opts.kind, "configure");
  const finish = (partial: Omit<GradleSessionResult, "durationMs" | "phaseReached" | "titleReached">): GradleSessionResult => ({
    ...partial,
    phaseReached: tracker.phase,
    titleReached: tracker.titleReached,
    durationMs: Date.now() - startedAt,
  });

  if (!hasGradlew(targetDir)) {
    return finish({ status: "failed", reason: "未找到 gradlew，请确认项目目录有效", exitCode: null });
  }
  await ensureGradlewExecutable(targetDir);
  if (opts.isCancelled?.()) return finish({ status: "cancelled", reason: "已取消", exitCode: null });

  const logBaselines = new Map<string, number>();
  if (opts.kind === "run") {
    for (const logPath of findClientLatestLogs(targetDir)) {
      try {
        logBaselines.set(logPath, fs.statSync(logPath).size);
      } catch {
        logBaselines.set(logPath, 0);
      }
    }
  }

  const { proc, isWin } = gradleSpawn(targetDir, [...opts.tasks, "--console=plain"]);
  opts.onProc?.(proc, isWin);
  opts.onPhase?.("configure", "Gradle 启动中");

  let activity: ActivityRegistration | null = null;
  if (opts.hostActivity !== false && proc.pid) {
    activity = registerHostActivity({
      pid: proc.pid,
      kind: opts.kind === "run" ? "game" : "build",
      label: opts.label,
      cwd: targetDir,
    });
  }

  let titleAt: number | undefined;
  let stoppedAtTitle = false;
  let killedForCancel = false;
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];

  const kill = () => killProcessTree(proc, isWin);
  const onTitle = () => {
    if (titleAt !== undefined) return;
    titleAt = Date.now();
    if (opts.stopAtTitle) {
      timers.push(setTimeout(() => {
        stoppedAtTitle = true;
        kill();
      }, STOP_AFTER_TITLE_MS));
    }
  };
  const announce = (phase?: JobPhase, detail?: string) => {
    if (!phase && detail === undefined) return;
    opts.onPhase?.(tracker.phase, tracker.detail);
    if (phase) activity?.update({ progress: tracker.detail ? `${phase}: ${tracker.detail}` : phase });
    if (phase === "in-game") onTitle();
  };

  attachLineStream(proc, (line) => {
    opts.onLine?.(line);
    const change = tracker.feed(line);
    if (change) announce(change.phase, change.detail);
  });

  // Cancellation, the title-screen fallback via latest.log, and the optional timeout.
  timers.push(setInterval(() => {
    if (opts.isCancelled?.() && !killedForCancel) {
      killedForCancel = true;
      kill();
    }
  }, 300));
  if (opts.kind === "run") {
    timers.push(setInterval(() => {
      if (tracker.titleReached) return;
      for (const [logPath, baseline] of logBaselines) {
        try {
          const stat = fs.statSync(logPath);
          if (stat.size <= baseline || stat.mtimeMs < startedAt - 3000) continue;
          const fd = fs.openSync(logPath, "r");
          try {
            const length = Math.min(stat.size - baseline, 8 * 1024 * 1024);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, stat.size - length);
            if (TITLE_SCREEN_LINE.test(buffer.toString("utf8"))) {
              // The game logs to latest.log only (not stdout): treat its atlas line as the title screen.
              tracker.feed("Created: 0x0x0 minecraft:textures/atlas/blocks.png-atlas");
              announce("in-game");
              return;
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch { /* log rotating or absent */ }
      }
    }, 2000));
  }
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timers.push(setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs));
  }
  for (const timer of timers) timer.unref?.();

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    proc.once("close", (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    });
    proc.once("error", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
  });
  for (const timer of timers) clearTimeout(timer);
  activity?.unregister();

  const cancelled = killedForCancel || !!opts.isCancelled?.();
  const timeToTitleMs = titleAt !== undefined ? titleAt - startedAt : undefined;
  const failure = timedOut ? `超时（${Math.round((opts.timeoutMs ?? 0) / 60000)} 分钟）` : tracker.failure;
  const outcome = opts.kind === "run"
    ? classifyRunExit({
      cancelled,
      stoppedAtTitle,
      titleReached: tracker.titleReached,
      exitCode,
      crashed: tracker.crashed,
      failure,
    })
    : classifyBuildExit({ cancelled, exitCode: timedOut ? 124 : exitCode, failure });
  return finish({ ...outcome, exitCode, timeToTitleMs, pid: proc.pid });
}
