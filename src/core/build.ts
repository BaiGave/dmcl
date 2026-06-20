import type { ChildProcess } from "node:child_process";
import type { Logger } from "../types.js";
import {
  attachLineStream,
  CLIENT_FAIL,
  CLIENT_SUCCESS,
  hasGradlew,
  runGradleBuildTask,
  runGradleClientTask,
  shouldEmitGradleLine,
} from "./gradle.js";

export interface GradleCommandLogOptions {
  onRawLine?: Logger;
  isCancelled?: () => boolean;
  onProc?: (proc: ChildProcess, isWin: boolean) => void;
}

/**
 * CLI：在项目目录运行 gradlew build。
 */
export async function runGradleBuild(
  targetDir: string,
  log: Logger,
  onComplete?: (ok: boolean) => void,
  options: GradleCommandLogOptions = {},
): Promise<number> {
  if (!hasGradlew(targetDir)) {
    log("未找到 gradlew，跳过构建验证");
    return 1;
  }

  log("运行首次构建（gradlew build）…");
  log("这会下载并反编译 Minecraft，可能需要 5~20 分钟");

  const gradleOpts = {
    isCancelled: options.isCancelled,
    onProc: options.onProc,
  };
  const code = await runGradleBuildTask(targetDir, (line) => {
    options.onRawLine?.(line);
    if (shouldEmitGradleLine(line)) log(line.substring(0, 240));
  }, gradleOpts);

  const ok = code === 0;
  log(ok ? "构建成功！" : `构建失败 (exit ${code})`);
  onComplete?.(ok);
  return code;
}

/** CLI diagnostic build: keeps stack traces and Gradle info lines for failure analysis. */
export async function runGradleBuildDiagnostics(
  targetDir: string,
  log: Logger,
  options: GradleCommandLogOptions = {},
): Promise<number> {
  if (!hasGradlew(targetDir)) {
    log("gradlew not found; cannot collect build diagnostics");
    return 1;
  }

  log("Collecting Gradle build diagnostics (build --stacktrace --info)...");
  const code = await runGradleBuildTask(targetDir, (line) => {
    options.onRawLine?.(line);
    if (shouldEmitGradleLine(line)) log(line.substring(0, 240));
  }, {
    tasks: ["build", "--stacktrace", "--info", "--no-daemon"],
    isCancelled: options.isCancelled,
    onProc: options.onProc,
  });

  log(code === 0 ? "Diagnostic build succeeded" : `Diagnostic build failed (exit ${code})`);
  return code;
}

/** CLI：启动 MC 客户端验证 */
export async function runGradleClientVerify(
  targetDir: string,
  log: Logger,
  onComplete?: (ok: boolean) => void,
  options: GradleCommandLogOptions = {},
): Promise<number> {
  if (!hasGradlew(targetDir)) {
    log("未找到 gradlew，跳过客户端验证");
    return 1;
  }

  log("启动 Minecraft 客户端验证（会弹出游戏窗口，加载成功后自动关闭）…");

  const code = await runGradleClientTask(targetDir, (line) => {
    options.onRawLine?.(line);
    if (shouldEmitGradleLine(line)) {
      log(line.substring(0, 120));
    }
  }, {
    mode: "verify",
    isCancelled: options.isCancelled,
    onProc: options.onProc,
  });

  const ok = code === 0;
  log(ok ? "客户端验证通过！" : "客户端验证失败");
  onComplete?.(ok);
  return code;
}

// 供 GUI 等复用
export {
  attachLineStream,
  CLIENT_FAIL,
  CLIENT_SUCCESS,
  gradleSpawn,
  hasGradlew,
  killProcessTree,
  readJavaHomeFromProject,
  buildGradleEnv,
  runGradleTask,
  runGradleBuildTask,
  runGradleClientTask,
  shouldEmitGradleLine,
} from "./gradle.js";
