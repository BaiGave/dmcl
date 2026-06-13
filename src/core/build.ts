import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../types.js";

function readJavaHomeFromProject(targetDir: string): string | null {
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

function buildGradleEnv(targetDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const javaHome = readJavaHomeFromProject(targetDir);
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
    env[pathKey] = `${path.join(javaHome, "bin")};${env[pathKey] ?? ""}`;
  }
  return env;
}

function gradleSpawn(targetDir: string, tasks: string[]): { proc: ChildProcess; isWin: boolean } {
  const isWin = process.platform === "win32";
  const cmd = isWin
    ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
    : "./gradlew";
  const cmdArgs = isWin ? ["/c", "gradlew.bat", ...tasks] : tasks;
  const proc = spawn(cmd, cmdArgs, {
    cwd: targetDir,
    env: buildGradleEnv(targetDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { proc, isWin };
}

function killProcessTree(proc: ChildProcess, isWin: boolean): void {
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

/**
 * 在项目目录中运行 `gradlew build`，流式输出进度。
 * Windows 上必须经 cmd.exe 启动 .bat（Node 20+ 直接 spawn .bat 会抛 EINVAL）。
 */
export async function runGradleBuild(targetDir: string, log: Logger, onComplete?: (ok: boolean) => void): Promise<number> {
  const isWin = process.platform === "win32";
  const gradlew = path.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
  if (!fs.existsSync(gradlew)) {
    log("未找到 gradlew，跳过构建验证");
    return 1;
  }
  if (!isWin) {
    try { await fs.promises.chmod(gradlew, 0o755); } catch {}
  }

  log("运行首次构建（gradlew build）…");
  log("这会下载并反编译 Minecraft，可能需要 5~20 分钟");

  return runGradleTask(targetDir, ["build", "--no-daemon"], log, onComplete);
}

/** 启动 MC 客户端验证，检测到游戏加载成功后自动关闭 */
export async function runGradleClientVerify(targetDir: string, log: Logger, onComplete?: (ok: boolean) => void): Promise<number> {
  const isWin = process.platform === "win32";
  const gradlew = path.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
  if (!fs.existsSync(gradlew)) {
    log("未找到 gradlew，跳过客户端验证");
    return 1;
  }

  log("启动 Minecraft 客户端验证（会弹出游戏窗口，加载成功后自动关闭）…");

  const { proc, isWin: win } = gradleSpawn(targetDir, ["runClient", "--no-daemon"]);
  const logPath = path.join(targetDir, "run", "logs", "latest.log");
  const CLIENT_TIMEOUT_MS = 10 * 60 * 1000;

  return new Promise((resolve) => {
    let finished = false;
    let verified = false;

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      killProcessTree(proc, win);
      const ok = code === 0;
      log(ok ? "客户端验证通过！" : "客户端验证失败");
      onComplete?.(ok);
      resolve(code);
    };

    const update = (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (CLIENT_FAIL.some((p) => p.test(trimmed))) finish(1);
        if (trimmed.startsWith(">") || trimmed.includes("Launching") || trimmed.includes("Running")) {
          log(trimmed.substring(0, 120));
        }
      }
    };
    proc.stdout?.on("data", update);
    proc.stderr?.on("data", update);

    const pollTimer = setInterval(() => {
      if (finished || verified) return;
      try {
        if (!fs.existsSync(logPath)) return;
        const content = fs.readFileSync(logPath, "utf8");
        if (CLIENT_FAIL.some((p) => p.test(content))) {
          log("检测到游戏崩溃");
          finish(1);
          return;
        }
        if (CLIENT_SUCCESS.some((p) => p.test(content))) {
          verified = true;
          log("Minecraft 客户端已成功加载，正在关闭…");
          setTimeout(() => finish(0), 2500);
        }
      } catch { /* ignore */ }
    }, 2000);

    const timeoutTimer = setTimeout(() => {
      if (!finished) {
        log("客户端验证超时（10 分钟）");
        finish(1);
      }
    }, CLIENT_TIMEOUT_MS);

    proc.on("close", (code) => {
      if (finished) return;
      if (verified) { finish(0); return; }
      try {
        if (fs.existsSync(logPath) && CLIENT_SUCCESS.some((p) => p.test(fs.readFileSync(logPath, "utf8")))) {
          finish(0);
          return;
        }
      } catch { /* ignore */ }
      finish(code === 0 ? 1 : (code ?? 1));
    });

    proc.on("error", (err) => {
      log(`客户端启动失败：${err.message}`);
      finish(1);
    });
  });
}

function runGradleTask(
  targetDir: string,
  tasks: string[],
  log: Logger,
  onComplete?: (ok: boolean) => void,
): Promise<number> {
  const { proc } = gradleSpawn(targetDir, tasks);

  const update = (data: Buffer) => {
    for (const line of data.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(">") || trimmed.includes("BUILD") || trimmed.includes("FAILURE") ||
          /^\d+%/.test(trimmed) || trimmed.includes("Download") || trimmed.includes("FAILED")) {
        log(trimmed.substring(0, 120));
      }
    }
  };
  proc.stdout?.on("data", update);
  proc.stderr?.on("data", update);

  return new Promise((resolve) => {
    proc.on("close", (code) => {
      const ok = code === 0;
      log(ok ? "构建成功！" : `构建失败 (exit ${code})`);
      onComplete?.(ok);
      resolve(code ?? 1);
    });
    proc.on("error", (err) => {
      log(`构建启动失败：${err.message}`);
      onComplete?.(false);
      resolve(1);
    });
  });
}
