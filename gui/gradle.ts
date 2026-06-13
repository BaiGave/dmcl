import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

let verificationCancelled = false;
export function setVerificationCancelled(cancelled: boolean): void {
  verificationCancelled = cancelled;
}

/** 读取项目 gradle.properties 中的 org.gradle.java.home */
export function readJavaHomeFromProject(targetDir: string): string | null {
  try {
    const propsFile = path.join(targetDir, "gradle.properties");
    if (!fs.existsSync(propsFile)) return null;
    const content = fs.readFileSync(propsFile, "utf8");
    const m = content.match(/^[ \t]*org\.gradle\.java\.home[ \t]*=[ \t]*(.+)$/m);
    if (!m) return null;
    return m[1].trim().replace(/\\\\/g, "\\").replace(/\\:/g, ":");
  } catch {
    return null;
  }
}

export function buildGradleEnv(targetDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const javaHome = readJavaHomeFromProject(targetDir);
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
    env[pathKey] = `${path.join(javaHome, "bin")};${env[pathKey] ?? ""}`;
  }
  return env;
}

export function gradleSpawn(
  targetDir: string,
  tasks: string[],
): { proc: ChildProcess; isWin: boolean } {
  const isWin = process.platform === "win32";
  const cmd = isWin
    ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
    : "./gradlew";
  const cmdArgs = isWin
    ? ["/c", "gradlew.bat", ...tasks]
    : tasks;

  const proc = spawn(cmd, cmdArgs, {
    cwd: targetDir,
    env: buildGradleEnv(targetDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { proc, isWin };
}

export function killProcessTree(proc: ChildProcess, isWin: boolean): void {
  if (!proc.pid || proc.killed) return;
  try {
    if (isWin) {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch { /* ignore */ }
}

const CLIENT_SUCCESS = [
  /Sound engine started/i,
  /OpenGL Version/i,
  /Created: \d+x\d+.*atlas/i,
];
const CLIENT_FAIL = [
  /---- Minecraft Crash Report ----/,
  /Process 'command 'runClient'' finished with non-zero/i,
  /BUILD FAILED/i,
];

function shouldEmitGradleLine(line: string): boolean {
  return (
    line.startsWith(">") ||
    line.includes("Launching") ||
    line.includes("Running") ||
    line.includes("Download") ||
    line.includes("BUILD") ||
    line.includes("FAILURE") ||
    line.includes("Exception") ||
    line.includes("Error")
  );
}

function streamLines(
  proc: ChildProcess,
  res: ServerResponse,
  onLine?: (line: string) => void,
  emitAll = false,
): void {
  const emit = (data: Buffer) => {
    for (const line of data.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      onLine?.(trimmed);
      if (emitAll || shouldEmitGradleLine(trimmed)) res.write(trimmed + "\n");
    }
  };
  proc.stdout!.on("data", emit);
  proc.stderr!.on("data", emit);
}

/** gradlew build --no-daemon */
export function runBuild(
  targetDir: string,
  res: ServerResponse,
  onDone: (code: number) => void,
): ChildProcess {
  const sep = "─".repeat(40);
  res.write(`${sep}\n`);
  res.write("正在验证构建（首次需要下载 Minecraft 等依赖，约 5~20 分钟，请耐心等待）…\n");
  res.write(`${sep}\n`);

  const { proc } = gradleSpawn(targetDir, ["build", "--no-daemon"]);
  streamLines(proc, res, undefined, true);

  proc.on("close", (code) => {
    if (verificationCancelled) {
      res.write(`${sep}\n`);
      res.write("已取消\n");
      onDone(1);
      return;
    }
    res.write(`${sep}\n`);
    if (code === 0) {
      res.write("✔ 构建验证通过\n");
    } else {
      res.write(`构建失败（退出码 ${code}），请检查上方日志\n`);
    }
    onDone(code ?? 1);
  });

  proc.on("error", (err) => {
    res.write(`构建启动失败: ${err.message}\n`);
    onDone(1);
  });

  return proc;
}

/** gradlew runClient --no-daemon，检测 latest.log 确认游戏加载后自动关闭 */
export function runClientVerify(
  targetDir: string,
  res: ServerResponse,
  onDone: (code: number) => void,
): ChildProcess {
  const sep = "─".repeat(40);
  res.write(`${sep}\n`);
  res.write("正在启动 Minecraft 客户端验证（会弹出游戏窗口，加载成功后自动关闭）…\n");
  res.write(`${sep}\n`);

  const { proc, isWin } = gradleSpawn(targetDir, ["runClient", "--no-daemon"]);
  const logPath = path.join(targetDir, "run", "logs", "latest.log");
  const CLIENT_TIMEOUT_MS = 10 * 60 * 1000;

  let finished = false;
  let verified = false;
  let pendingSuccessTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    if (pendingSuccessTimer) clearTimeout(pendingSuccessTimer);
    if (verificationCancelled) {
      res.write(`${sep}\n`);
      res.write("已取消\n");
      onDone(1);
      return;
    }
    killProcessTree(proc, isWin);
    res.write(`${sep}\n`);
    if (code === 0) {
      res.write("✔ 客户端验证通过，项目可以直接使用！\n");
    } else {
      res.write("客户端验证失败，请检查上方日志\n");
    }
    onDone(code);
  };

  streamLines(proc, res, (line) => {
    if (CLIENT_FAIL.some((p) => p.test(line))) finish(1);
  });

  const pollTimer = setInterval(() => {
    if (finished || verified) return;
    try {
      if (!fs.existsSync(logPath)) return;
      const log = fs.readFileSync(logPath, "utf8");
      if (CLIENT_FAIL.some((p) => p.test(log))) {
        res.write("检测到游戏崩溃，验证失败\n");
        finish(1);
        return;
      }
      if (CLIENT_SUCCESS.some((p) => p.test(log))) {
        verified = true;
        res.write("✔ Minecraft 客户端已成功加载\n");
        res.write("正在自动关闭游戏窗口…\n");
        pendingSuccessTimer = setTimeout(() => finish(0), 2500);
      }
    } catch { /* ignore */ }
  }, 2000);

  const timeoutTimer = setTimeout(() => {
    if (!finished) {
      res.write("客户端验证超时（10 分钟），可能是网络慢或显卡/驱动问题\n");
      finish(1);
    }
  }, CLIENT_TIMEOUT_MS);

  proc.on("close", (code) => {
    if (finished) return;
    if (verificationCancelled) {
      finish(1);
      return;
    }
    // 进程提前退出且未检测到成功
    if (verified) {
      finish(0);
      return;
    }
    try {
      if (fs.existsSync(logPath)) {
        const log = fs.readFileSync(logPath, "utf8");
        if (CLIENT_SUCCESS.some((p) => p.test(log))) {
          finish(0);
          return;
        }
      }
    } catch { /* ignore */ }
    finish(code === 0 ? 1 : (code ?? 1));
  });

  proc.on("error", (err) => {
    res.write(`客户端启动失败: ${err.message}\n`);
    finish(1);
  });

  return proc;
}
