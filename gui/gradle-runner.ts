import type { ChildProcess } from "node:child_process";
import { getConcurrencyLimits, withClientSlot, withGradleBuildSlot } from "./concurrency-governor";
import { getGradleCore, getProjectJdk } from "./gradle-core-bridge";
import { killProcessTree } from "./gradle";

export interface GradleRunner {
  runBuildOnly(targetDir: string, log: (line: string) => void): Promise<number>;
  runClientOnly(targetDir: string, log: (line: string) => void): Promise<number>;
  runClientInteractive(targetDir: string, log: (line: string) => void): Promise<number>;
  cancel(): Promise<void>;
  reset(): void;
  isCancelled(): boolean;
}

export function getBuildConcurrency(): number {
  return getConcurrencyLimits().jobSlots;
}

export function getBuildConcurrencyInfo() {
  return getConcurrencyLimits();
}

let runnerPool: GradleRunner[] | null = null;

export function resetRunnerPool(): void {
  const previous = runnerPool;
  runnerPool = null;
  if (previous) {
    void Promise.all(previous.map((runner) => runner.cancel()));
  }
}

export function getRunnerPool(): GradleRunner[] {
  const size = getBuildConcurrency();
  if (!runnerPool || runnerPool.length !== size) {
    if (runnerPool) {
      void Promise.all(runnerPool.map((runner) => runner.cancel()));
    }
    runnerPool = Array.from({ length: size }, () => createGradleRunner());
  }
  return runnerPool;
}

export async function cancelAllRunners(): Promise<void> {
  await Promise.all(getRunnerPool().map((runner) => runner.cancel()));
}

export function resetAllRunners(): void {
  for (const runner of getRunnerPool()) runner.reset();
}

export function createGradleRunner(): GradleRunner {
  let cancelled = false;
  let currentProc: ChildProcess | null = null;
  let currentIsWin = false;

  const trackProc = (proc: ChildProcess, isWin: boolean) => {
    currentProc = proc;
    currentIsWin = isWin;
  };

  const clearProc = (proc: ChildProcess | null) => {
    if (currentProc === proc) currentProc = null;
  };

  const prepareProjectJdk = async (
    targetDir: string,
    log: (line: string) => void,
  ): Promise<boolean> => {
    if (cancelled) return false;
    const jdk = await getProjectJdk();
    return jdk.prepareProjectJdk(targetDir, log, { isCancelled: () => cancelled });
  };

  const runBuildOnly = async (targetDir: string, log: (line: string) => void): Promise<number> =>
    withGradleBuildSlot(async () => {
      const core = await getGradleCore();
      if (!core.hasGradlew(targetDir)) {
        log("未找到 gradlew，请确认项目目录有效");
        return 1;
      }
      if (!(await prepareProjectJdk(targetDir, log)) || cancelled) {
        log("已取消");
        return 1;
      }

      log(`正在构建（gradlew build，Gradle 并发 ${getConcurrencyLimits().gradleBuildConcurrency} 路 · 槽内单 Worker）…`);
      let tracked: ChildProcess | null = null;
      const code = await core.runGradleBuildTask(targetDir, log, {
        tasks: ["build", "--no-daemon", "--max-workers=1"],
        isCancelled: () => cancelled,
        onProc: (proc, isWin) => { tracked = proc; trackProc(proc, isWin); },
      });
      clearProc(tracked);
      if (cancelled) {
        log("已取消");
        return 1;
      }
      if (code === 0) log("✔ 构建成功");
      else log(`构建失败（退出码 ${code}）`);
      return code;
    });

  const runClientInternal = async (
    targetDir: string,
    log: (line: string) => void,
    mode: "verify" | "interactive",
  ): Promise<number> =>
    withClientSlot(async () => {
      const core = await getGradleCore();
      if (!core.hasGradlew(targetDir)) {
        log("未找到 gradlew，请确认项目目录有效");
        return 1;
      }
      if (!(await prepareProjectJdk(targetDir, log)) || cancelled) {
        log("已取消");
        return 1;
      }

      log(mode === "verify"
        ? `正在启动 Minecraft 客户端（客户端验证并发 ${getConcurrencyLimits().clientConcurrency} 路）…`
        : "正在启动 Minecraft 客户端（游戏窗口将保持打开，关闭游戏后结束）…");
      let tracked: ChildProcess | null = null;
      const code = await core.runGradleClientTask(targetDir, log, {
        mode,
        isCancelled: () => cancelled,
        onProc: (proc, isWin) => { tracked = proc; trackProc(proc, isWin); },
      });
      clearProc(tracked);
      if (cancelled) {
        log("已取消");
        return 1;
      }
      if (mode === "interactive") {
        if (code === 0) log("✔ 客户端已正常退出");
        else if (code === 1) log("⚠ 进程很快退出且未检测到游戏启动，请查看 Gradle 日志或先执行构建");
        else log(`客户端异常退出（退出码 ${code}）`);
      } else if (code === 0) {
        log("✔ 客户端验证通过");
      } else {
        log("客户端验证失败");
      }
      return code;
    });

  return {
    runBuildOnly,
    runClientOnly: (targetDir, log) => runClientInternal(targetDir, log, "verify"),
    runClientInteractive: (targetDir, log) => runClientInternal(targetDir, log, "interactive"),
    isCancelled: () => cancelled,
    reset: () => {
      cancelled = false;
    },
    cancel: async () => {
      if (cancelled) return;
      cancelled = true;
      const proc = currentProc;
      if (!proc) return;
      try {
        await killProcessTree(proc, currentIsWin);
      } finally {
        clearProc(proc);
      }
    },
  };
}
