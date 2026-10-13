import { withClientSlot, withGradleBuildSlot, getConcurrencyLimits } from "./concurrency-governor";
import { getGradleCore, getLaunchCore, getProjectJdk, getJdkCore } from "./gradle-core-bridge";

/**
 * Runs one step of a job (build, launch, client check) for the build queue and the new-project wizard.
 * Each step waits for its slot in the process scheduler (Gradle builds / game clients), prepares the
 * JDK, then runs Gradle through the core session (phases, host activity registry, cancellation).
 */

export type JobPhase = "queued" | "toolchain" | "configure" | "compile" | "assets" | "starting" | "in-game" | "exited";

export interface StepContext {
  log(line: string): void;
  phase(phase: JobPhase, detail?: string): void;
  isCancelled(): boolean;
}

export interface StepResult {
  status: "success" | "failed" | "cancelled";
  reason?: string;
  phaseReached?: JobPhase;
  exitCode?: number | null;
  timeToTitleMs?: number;
  javaMajor?: number | null;
}

export interface LaunchOptions {
  /** Stop the client a moment after the title screen and count that as success (smoke launch). */
  stopAtTitle?: boolean;
  /** Label in the host activity registry. */
  label: string;
}

export interface GradleRunner {
  /** Explicit build: `gradlew build`. */
  build(targetDir: string, ctx: StepContext, label: string): Promise<StepResult>;
  /** Launch: only the client run task (`gradlew runClient`), which compiles what it needs. */
  launch(targetDir: string, ctx: StepContext, options: LaunchOptions): Promise<StepResult>;
}

/** Interactive play has no time limit; a smoke launch must reach the title screen within 10 minutes. */
const SMOKE_LAUNCH_TIMEOUT_MS = 10 * 60 * 1000;

function cancelledResult(): StepResult {
  return { status: "cancelled", reason: "已取消", phaseReached: "queued" };
}

async function prepareJdk(
  targetDir: string,
  ctx: StepContext,
): Promise<{ ok: true; javaMajor: number | null } | { ok: false; result: StepResult }> {
  ctx.phase("toolchain", "检查 JDK 与工具链");
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    ctx.log(line);
  };
  const ok = await (await getProjectJdk()).prepareProjectJdk(targetDir, log, { isCancelled: ctx.isCancelled });
  if (ctx.isCancelled()) return { ok: false, result: { ...cancelledResult(), phaseReached: "toolchain" } };
  if (!ok) {
    const reason = [...lines].reverse().find((line) => /JDK|Java|失败/.test(line)) ?? "JDK 准备失败";
    return { ok: false, result: { status: "failed", reason, phaseReached: "toolchain" } };
  }
  const jdk = await getJdkCore();
  const javaHome = jdk.readJavaHomeFromProject(targetDir);
  const javaMajor = javaHome ? jdk.detectJavaMajorAt(javaHome) : null;
  ctx.log(`Gradle 使用 Java ${javaMajor ?? "?"}${javaHome ? `：${javaHome}` : "（系统 JAVA_HOME）"}`);
  return { ok: true, javaMajor };
}

function waitNotice(ctx: StepContext, what: string) {
  return (status: { active: number; max: number; waiting: number }) => {
    ctx.phase("queued", `等待${what}（${status.active}/${status.max} 运行中）`);
    ctx.log(`排队：${what}已满（${status.active}/${status.max}），等待空闲…`);
  };
}

async function runSlotted(
  kind: "gradle" | "client",
  ctx: StepContext,
  operation: () => Promise<StepResult>,
): Promise<StepResult> {
  const withSlot = kind === "gradle" ? withGradleBuildSlot : withClientSlot;
  try {
    return await withSlot(operation, {
      isCancelled: ctx.isCancelled,
      onWait: waitNotice(ctx, kind === "gradle" ? " Gradle 构建槽位" : "客户端槽位"),
    });
  } catch (err) {
    if (ctx.isCancelled()) return cancelledResult();
    return { status: "failed", reason: (err as Error).message, phaseReached: "queued" };
  }
}

export function createGradleRunner(): GradleRunner {
  return {
    build: (targetDir, ctx, label) => runSlotted("gradle", ctx, async () => {
      if (ctx.isCancelled()) return cancelledResult();
      const jdk = await prepareJdk(targetDir, ctx);
      if (!jdk.ok) return jdk.result;
      const core = await getGradleCore();
      await core.ensureFabricApiVersionIfScaffolded(targetDir, ctx.log);
      await core.pruneDmclGradleCache().catch(() => undefined);
      ctx.log(`正在构建（gradlew build，Gradle 并发上限 ${getConcurrencyLimits().gradleBuildConcurrency}）…`);
      const result = await (await getLaunchCore()).runGradleSession(targetDir, {
        kind: "build",
        tasks: ["build", "--no-daemon", "--max-workers=1"],
        label,
        onLine: ctx.log,
        onPhase: ctx.phase,
        isCancelled: ctx.isCancelled,
      });
      ctx.log(result.status === "success" ? "✔ 构建成功" : `构建${result.status === "cancelled" ? "已取消" : "失败"}${result.reason ? `：${result.reason}` : ""}`);
      return { ...result, javaMajor: jdk.javaMajor };
    }),

    launch: (targetDir, ctx, options) => runSlotted("client", ctx, async () => {
      if (ctx.isCancelled()) return cancelledResult();
      const jdk = await prepareJdk(targetDir, ctx);
      if (!jdk.ok) return jdk.result;
      const core = await getGradleCore();
      await core.ensureFabricApiVersionIfScaffolded(targetDir, ctx.log);
      ctx.log(options.stopAtTitle
        ? "正在启动客户端（gradlew runClient，进入标题界面后自动关闭）…"
        : "正在启动客户端（gradlew runClient，只编译运行所需内容；关闭游戏后结束）…");
      const result = await (await getLaunchCore()).runGradleSession(targetDir, {
        kind: "run",
        tasks: ["runClient", "--no-daemon"],
        label: options.label,
        onLine: ctx.log,
        onPhase: ctx.phase,
        isCancelled: ctx.isCancelled,
        stopAtTitle: options.stopAtTitle,
        timeoutMs: options.stopAtTitle ? SMOKE_LAUNCH_TIMEOUT_MS : undefined,
      });
      if (result.timeToTitleMs !== undefined) {
        ctx.log(`✔ 已进入标题界面（Gradle 启动后 ${(result.timeToTitleMs / 1000).toFixed(1)} 秒）`);
      }
      ctx.log(result.status === "success" ? "✔ 客户端已结束" : `客户端${result.status === "cancelled" ? "已取消" : "失败"}${result.reason ? `：${result.reason}` : ""}`);
      return { ...result, javaMajor: jdk.javaMajor };
    }),
  };
}

let defaultRunner: GradleRunner | null = null;

export function getDefaultRunner(): GradleRunner {
  defaultRunner ??= createGradleRunner();
  return defaultRunner;
}
