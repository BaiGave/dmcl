import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gradleSpawn, killProcessTree } from "./gradle";

let verificationCancelled = false;
let currentProc: ChildProcess | null = null;
let currentIsWin = false;

export function killCurrentRunner(): void {
  verificationCancelled = true;
  if (currentProc) {
    killProcessTree(currentProc, currentIsWin);
    currentProc = null;
  }
}

export function setRunnerCancelled(cancelled: boolean): void {
  verificationCancelled = cancelled;
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

function streamProc(proc: ChildProcess, onLine: (line: string) => void): void {
  const emit = (data: Buffer) => {
    for (const line of data.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  };
  proc.stdout?.on("data", emit);
  proc.stderr?.on("data", emit);
}

export function runBuildOnly(targetDir: string, log: (line: string) => void): Promise<number> {
  const isWin = process.platform === "win32";
  const gradlew = path.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
  if (!fs.existsSync(gradlew)) {
    log("未找到 gradlew");
    return Promise.resolve(1);
  }

  log("正在构建（gradlew build）…");
  const { proc } = gradleSpawn(targetDir, ["build", "--no-daemon"]);
  currentProc = proc;
  currentIsWin = process.platform === "win32";
  streamProc(proc, log);

  return new Promise((resolve) => {
    proc.on("close", (code) => {
      currentProc = null;
      if (verificationCancelled) {
        log("已取消");
        resolve(1);
        return;
      }
      if (code === 0) log("✔ 构建成功");
      else log(`构建失败（退出码 ${code}）`);
      resolve(code ?? 1);
    });
    proc.on("error", (err) => {
      log(`构建启动失败: ${err.message}`);
      resolve(1);
    });
  });
}

export function runClientOnly(targetDir: string, log: (line: string) => void): Promise<number> {
  const isWin = process.platform === "win32";
  const gradlew = path.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
  if (!fs.existsSync(gradlew)) {
    log("未找到 gradlew");
    return Promise.resolve(1);
  }

  log("正在启动 Minecraft 客户端…");
  const { proc, isWin: win } = gradleSpawn(targetDir, ["runClient", "--no-daemon"]);
  currentProc = proc;
  currentIsWin = win;
  const logPath = path.join(targetDir, "run", "logs", "latest.log");
  const CLIENT_TIMEOUT_MS = 10 * 60 * 1000;

  let finished = false;
  let verified = false;

  const finish = (code: number): number => {
    if (finished) return code;
    finished = true;
    clearInterval(pollTimer);
    clearTimeout(timeoutTimer);
    if (pendingSuccessTimer) clearTimeout(pendingSuccessTimer);
    currentProc = null;
    killProcessTree(proc, win);
    if (verificationCancelled) {
      log("已取消");
      return 1;
    }
    if (code === 0) log("✔ 客户端验证通过");
    else log("客户端验证失败");
    return code;
  };

  streamProc(proc, (line) => {
    log(line);
    if (CLIENT_FAIL.some((p) => p.test(line))) finish(1);
  });

  let pendingSuccessTimer: ReturnType<typeof setTimeout> | null = null;

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
        log("✔ Minecraft 客户端已成功加载，正在关闭…");
        pendingSuccessTimer = setTimeout(() => finish(0), 2500);
      }
    } catch { /* ignore */ }
  }, 2000);

  const timeoutTimer = setTimeout(() => {
    if (!finished) {
      log("客户端验证超时（10 分钟）");
      finish(1);
    }
  }, CLIENT_TIMEOUT_MS);

  return new Promise((resolve) => {
    proc.on("close", (code) => {
      if (finished) return;
      if (verified) { resolve(finish(0)); return; }
      try {
        if (fs.existsSync(logPath) && CLIENT_SUCCESS.some((p) => p.test(fs.readFileSync(logPath, "utf8")))) {
          resolve(finish(0));
          return;
        }
      } catch { /* ignore */ }
      resolve(finish(code === 0 ? 1 : (code ?? 1)));
    });
    proc.on("error", (err) => {
      log(`客户端启动失败: ${err.message}`);
      resolve(finish(1));
    });
  });
}
