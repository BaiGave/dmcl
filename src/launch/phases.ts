/**
 * Job phases read from Gradle and game output. Pure functions so the GUI queue, the CLI check
 * script and tests share one interpretation of the log.
 *
 *   queued -> toolchain -> configure -> compile/assets -> starting -> in-game -> exited   (run)
 *   queued -> toolchain -> configure -> compile/assets -> exited                          (build)
 *
 * - queued:    waiting in the queue or for a Gradle/client slot
 * - toolchain: choosing/downloading the JDK, toolchain checks
 * - configure: Gradle is starting and configuring the build (before the first task)
 * - compile:   Gradle tasks are running (detail: the current `> Task :x`)
 * - assets:    a task downloading/preparing Minecraft assets or game files
 * - starting:  the run task started the game JVM; mods and resources are loading
 * - in-game:   the client reached the title screen (block atlas created)
 * - exited:    the process ended
 * compile and assets may alternate; nothing goes back once the game is starting.
 */
export type JobPhase = "queued" | "toolchain" | "configure" | "compile" | "assets" | "starting" | "in-game" | "exited";

export const PHASE_ORDER: JobPhase[] = ["queued", "toolchain", "configure", "compile", "assets", "starting", "in-game", "exited"];

export function phaseRank(phase: JobPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

/** The title screen: Minecraft stitched the block atlas (`Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas`). */
export const TITLE_SCREEN_LINE = /Created: \d+x\d+x\d+ minecraft:textures\/atlas\/blocks\.png-atlas/;

const RUN_TASK = /^> Task :(?:[\w-]+:)*run(?:Client|client)\b/;
const GRADLE_TASK = /^> Task :(\S+)/;
const CONFIGURE = /^> Configure project|^Starting a Gradle Daemon|^To honour the JVM settings|^Reusing configuration cache|^Calculating task graph|^Configuration cache entry/;
const ASSET_TASK = /asset|download(?:Client|Minecraft)|extractNatives|prepareClientRun|neoFormRuntime|createMinecraftArtifacts|mavenizer/i;
const GAME_OUTPUT = /\[(?:main|Render thread|modloading-worker-\d+|Worker-Main-\d+)\/(?:INFO|WARN|ERROR|DEBUG)\]|ModLauncher running|Loading Minecraft \S+ with Fabric Loader|Launching target '(?:neo)?forge|Setting user: /;
const CRASH = /---- Minecraft Crash Report ----|#@!@# Game crashed!|Exception in thread "main"/;
const INCOMPATIBLE = /Incompatible mods found|有不兼容的模组/;
const WENT_WRONG = /^\* What went wrong:/;

export interface LineAnalysis {
  /** New phase when this line moves the job on. */
  phase?: JobPhase;
  /** Short description of what is happening now (e.g. the current Gradle task). */
  detail?: string;
  /** Set when the line explains a failure. */
  failure?: string;
}

/** Tracks one Gradle run's output: phase, current task, failure reason. */
export class OutputTracker {
  phase: JobPhase;
  detail: string | undefined;
  failure: string | undefined;
  crashed = false;
  titleReached = false;
  private expectWentWrong = false;

  constructor(private readonly kind: "build" | "run", start: JobPhase = "configure") {
    this.phase = start;
  }

  /** Feeds one output line; returns what changed (if anything). */
  feed(line: string): LineAnalysis | null {
    const text = line.trim();
    if (!text) return null;

    if (this.expectWentWrong) {
      this.expectWentWrong = false;
      if (!this.failure) this.failure = text.slice(0, 300);
      return { failure: this.failure };
    }
    if (WENT_WRONG.test(text)) {
      this.expectWentWrong = true;
      return null;
    }
    if (CRASH.test(text)) {
      this.crashed = true;
      this.failure ??= "游戏崩溃（见日志中的 Crash Report）";
      return { failure: this.failure };
    }
    if (INCOMPATIBLE.test(text)) {
      this.failure ??= text.slice(0, 300);
      return { failure: this.failure };
    }

    if (this.kind === "run") {
      if (TITLE_SCREEN_LINE.test(text) && !this.titleReached) {
        this.titleReached = true;
        return this.move("in-game", "已进入标题界面");
      }
      if (RUN_TASK.test(text)) return this.move("starting", "正在启动游戏");
      if (this.inGradle() && GAME_OUTPUT.test(text)) return this.move("starting", "正在加载游戏");
    }
    const task = GRADLE_TASK.exec(text);
    if (task && this.inGradle()) {
      return this.move(ASSET_TASK.test(task[1]) ? "assets" : "compile", `> Task :${task[1]}`);
    }
    if (CONFIGURE.test(text) && this.inGradle()) return this.move("configure", text.slice(0, 120));
    return null;
  }

  private inGradle(): boolean {
    return phaseRank(this.phase) < phaseRank("starting");
  }

  private move(phase: JobPhase, detail?: string): LineAnalysis {
    const forward = phaseRank(phase) > phaseRank(this.phase);
    // compile <-> assets may alternate; configure never comes back after tasks started.
    const sideways = (phase === "compile" || phase === "assets") && (this.phase === "compile" || this.phase === "assets");
    const detailChanged = detail !== undefined && detail !== this.detail && phase === this.phase;
    if (!forward && !sideways && !detailChanged) return {};
    const changed = phase !== this.phase;
    this.phase = phase;
    this.detail = detail;
    return changed ? { phase, detail } : { detail };
  }
}

export type JobOutcomeStatus = "success" | "failed" | "cancelled";

/**
 * Decides how a launch ended.
 * - cancelled by the user (or DMCL closing): cancelled;
 * - stopAtTitle (smoke launch): success once the title screen was reached;
 * - otherwise success when the game reached the title screen and exited normally; a crash or a
 *   non-zero exit after that, or any exit before the title screen, is a failure.
 */
export function classifyRunExit(input: {
  cancelled: boolean;
  stoppedAtTitle: boolean;
  titleReached: boolean;
  exitCode: number | null;
  crashed: boolean;
  failure?: string;
}): { status: JobOutcomeStatus; reason?: string } {
  if (input.stoppedAtTitle && input.titleReached) return { status: "success" };
  if (input.cancelled) return { status: "cancelled", reason: "已取消" };
  if (input.titleReached) {
    if (input.crashed) return { status: "failed", reason: input.failure ?? "游戏崩溃" };
    if (input.exitCode && input.exitCode !== 0) {
      return { status: "failed", reason: input.failure ?? `游戏异常退出（退出码 ${input.exitCode}）` };
    }
    return { status: "success" };
  }
  if (input.failure) return { status: "failed", reason: input.failure };
  if (input.exitCode && input.exitCode !== 0) return { status: "failed", reason: `Gradle 退出码 ${input.exitCode}` };
  return { status: "failed", reason: "游戏未进入标题界面就退出了" };
}

export function classifyBuildExit(input: {
  cancelled: boolean;
  exitCode: number | null;
  failure?: string;
}): { status: JobOutcomeStatus; reason?: string } {
  if (input.cancelled) return { status: "cancelled", reason: "已取消" };
  if (input.exitCode === 0) return { status: "success" };
  return { status: "failed", reason: input.failure ?? `Gradle 退出码 ${input.exitCode ?? "?"}` };
}
