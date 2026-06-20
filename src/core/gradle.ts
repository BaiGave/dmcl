import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ensureDmclHome, getDmclHome } from "./dmcl-home.js";
import { detectJavaMajorAt } from "./jdk.js";

export const CLIENT_SUCCESS = [
  /Sound engine started/i,
  /OpenGL Version/i,
  /Created: \d+x\d+.*atlas/i,
];

export const CLIENT_FAIL = [
  /---- Minecraft Crash Report ----/,
  /Process 'command 'runClient'' finished with non-zero/i,
  /BUILD FAILED/i,
  /Incompatible mods found/i,
  /FormattedException.*incompatible/i,
  /有不兼容的模组/i,
];

/** 从 Fabric Loader 日志提取「模组不兼容」的简短说明 */
export function summarizeFabricIncompatibleModsError(log: string): string | null {
  if (!/Incompatible mods found|有不兼容的模组/i.test(log)) return null;

  const installedMc = log.match(/已经安装了的版本\s+([^\s！!]+)/)?.[1]
    ?? log.match(/found (?:version )?([\d.]+)/i)?.[1];
  const fabricApi = log.match(/模组 'Fabric API' \(fabric\)\s+(\S+)/)?.[1]
    ?? log.match(/'Fabric API' \(fabric\)\s+(\S+)/)?.[1];
  const requiredMc = log.match(/需要 'Minecraft' \(minecraft\) 的\s+([^\n]+)/)?.[1]
    ?? log.match(/requires (?:'Minecraft'|minecraft)[^\n]*?([\d.]+(?:\s*to\s*[\d.-]+)?)/i)?.[1];

  if (fabricApi && installedMc) {
    let summary = `Fabric API ${fabricApi} 与 Minecraft ${installedMc} 不兼容。`;
    if (requiredMc) summary += ` Fabric API 需要 MC ${requiredMc.trim()}。`;
    summary += " DMCL 会在启动客户端前自动修正 Fabric API 版本；若仍失败，请在设置中重新生成或手动执行 gradlew build。";
    return summary;
  }
  return "检测到 Fabric 模组依赖冲突（Incompatible mods）。请检查 Fabric API 与 Minecraft 版本是否匹配。";
}

export type LineHandler = (line: string) => void;

export interface GradleRunOptions {
  tasks?: string[];
  isCancelled?: () => boolean;
  onProc?: (proc: ChildProcess, isWin: boolean) => void;
  env?: NodeJS.ProcessEnv;
  /** Terminate Gradle and return exit code 124 after this many milliseconds. */
  timeoutMs?: number;
}

export interface GradleClientOptions extends GradleRunOptions {
  mode: "verify" | "interactive";
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

/** 独立 Gradle 用户目录，避免用户全局 init.d 脚本破坏旧版 Gradle。 */
export function getIsolatedGradleHome(targetDir?: string): string {
  const base = path.join(getDmclHome(), "cache", "gradle");
  if (!targetDir) {
    fs.mkdirSync(base, { recursive: true });
    return base;
  }
  const javaHome = readJavaHomeFromProject(targetDir);
  let shard = "shared";
  if (javaHome) {
    const major = detectJavaMajorAt(javaHome);
    if (major != null) shard = `jvm-${major}`;
  }
  const dir = path.join(base, shard);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildGradleEnv(targetDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.GRADLE_USER_HOME = getIsolatedGradleHome(targetDir);
  ensureDmclHome();
  const javaHome = readJavaHomeFromProject(targetDir);
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
    env[pathKey] = `${path.join(javaHome, "bin")};${env[pathKey] ?? ""}`;
  }
  return env;
}

export function gradlewPath(targetDir: string): string {
  const isWin = process.platform === "win32";
  return path.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
}

export function hasGradlew(targetDir: string): boolean {
  return fs.existsSync(gradlewPath(targetDir));
}

export async function ensureGradlewExecutable(targetDir: string): Promise<void> {
  if (process.platform === "win32") return;
  const gradlew = path.join(targetDir, "gradlew");
  if (!fs.existsSync(gradlew)) return;
  try {
    await fs.promises.chmod(gradlew, 0o755);
  } catch { /* ignore */ }
}

export function gradleSpawn(
  targetDir: string,
  tasks: string[],
  envOverrides?: NodeJS.ProcessEnv,
): { proc: ChildProcess; isWin: boolean } {
  const isWin = process.platform === "win32";
  const cmd = isWin
    ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
    : "./gradlew";
  const cmdArgs = isWin ? ["/c", "gradlew.bat", ...tasks] : tasks;
  const proc = spawn(cmd, cmdArgs, {
    cwd: targetDir,
    env: { ...buildGradleEnv(targetDir), ...envOverrides },
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

export function attachLineStream(proc: ChildProcess, onLine: LineHandler): void {
  const attach = (stream: NodeJS.ReadableStream | null | undefined) => {
    if (!stream) return;
    let pending = "";
    stream.on("data", (data: Buffer | string) => {
      pending += data.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const complete = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (complete.length > 0) onLine(complete);
      }
    });
    stream.on("end", () => {
      const complete = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      if (complete.length > 0) onLine(complete);
      pending = "";
    });
  };
  attach(proc.stdout);
  attach(proc.stderr);
}

export function shouldEmitGradleLine(line: string): boolean {
  return (
    line.startsWith(">") ||
    line.includes("Launching") ||
    line.includes("Running") ||
    line.includes("Download") ||
    line.includes("download") ||
    line.includes("BUILD") ||
    line.includes("FAILURE") ||
    line.includes("Exception") ||
    line.includes("Error") ||
    line.includes("Caused by") ||
    line.includes("Could not") ||
    line.includes("Cannot") ||
    line.includes("Failed to") ||
    line.includes("Mavenizer") ||
    line.includes("mavenizer") ||
    line.includes("Slime Launcher") ||
    line.includes("Checking assets") ||
    line.includes("Processing Minecraft") ||
    line.includes("Cache miss") ||
    line.includes("HTTP") ||
    line.includes("timeout") ||
    line.includes("timed out") ||
    line.includes("DownloadUtils") ||
    /^\d+%/.test(line) ||
    line.includes("FAILED")
  );
}

function cancelledCode(opts?: GradleRunOptions): number | null {
  return opts?.isCancelled?.() ? 1 : null;
}

export async function runGradleTask(
  targetDir: string,
  tasks: string[],
  onLine: LineHandler,
  opts?: GradleRunOptions,
): Promise<number> {
  if (!hasGradlew(targetDir)) return 1;
  await ensureGradlewExecutable(targetDir);
  if (cancelledCode(opts) !== null) return 1;

  const { proc, isWin } = gradleSpawn(targetDir, tasks, opts?.env);
  opts?.onProc?.(proc, isWin);
  attachLineStream(proc, onLine);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessTree(proc, isWin);
        done(124);
      }, opts.timeoutMs);
      timer.unref?.();
    }
    proc.on("close", (code) => {
      if (opts?.isCancelled?.()) {
        done(1);
        return;
      }
      done(code ?? 1);
    });
    proc.on("error", () => done(1));
  });
}

/** gradlew build --no-daemon */
export async function runGradleBuildTask(
  targetDir: string,
  onLine: LineHandler,
  opts?: GradleRunOptions,
): Promise<number> {
  return runGradleTask(targetDir, opts?.tasks ?? ["build", "--no-daemon"], onLine, opts);
}

export function findClientLatestLogs(targetDir: string): string[] {
  const found = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.name === "latest.log" && path.basename(path.dirname(full)) === "logs") {
        found.add(full);
      }
    }
  };
  for (const rootName of ["run", "runs"]) {
    const runDir = path.join(targetDir, rootName);
    visit(runDir, 0);
    found.add(path.join(runDir, "logs", "latest.log"));
    found.add(path.join(runDir, "client", "logs", "latest.log"));
  }
  return [...found];
}

/** gradlew runClient --no-daemon，支持验证模式与交互模式 */
export async function runGradleClientTask(
  targetDir: string,
  onLine: LineHandler,
  opts: GradleClientOptions,
): Promise<number> {
  if (!hasGradlew(targetDir)) return 1;
  await ensureGradlewExecutable(targetDir);
  if (cancelledCode(opts) !== null) return 1;

  try {
    const { ensureFabricApiVersion } = await import("../loaders/fabric-toolchain.js");
    await ensureFabricApiVersion(targetDir, onLine);
  } catch {
    // 修正失败不阻断启动，由 Loader 报错后再提示
  }

  const startedAt = Date.now();
  const logBaselines = new Map<string, number>();
  for (const logPath of findClientLatestLogs(targetDir)) {
    logBaselines.set(logPath, fs.existsSync(logPath) ? fs.statSync(logPath).size : 0);
  }

  const { proc, isWin } = gradleSpawn(targetDir, ["runClient", "--no-daemon"]);
  opts.onProc?.(proc, isWin);

  const timeoutMs = opts.mode === "verify" ? 10 * 60 * 1000 : 60 * 60 * 1000;
  let settled = false;
  let verified = false;
  let sawGameLaunch = false;
  let pendingSuccessTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (pendingSuccessTimer) clearTimeout(pendingSuccessTimer);
    pollTimer = null;
    timeoutTimer = null;
    pendingSuccessTimer = null;
  };

  const readFreshLog = (): string | null => {
    const fresh: string[] = [];
    for (const logPath of findClientLatestLogs(targetDir)) {
      try {
        if (!fs.existsSync(logPath)) continue;
        const stat = fs.statSync(logPath);
        const baseline = logBaselines.get(logPath) ?? 0;
        if (stat.mtimeMs < startedAt - 3000 && stat.size <= baseline) continue;
        const content = fs.readFileSync(logPath, "utf8");
        if (opts.mode === "verify" && stat.size <= baseline && !content.trim()) continue;
        fresh.push(content);
      } catch {
        // Log files may rotate while the client is starting.
      }
    }
    return fresh.length > 0 ? fresh.join("\n") : null;
  };

  return new Promise((resolve) => {
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (opts.mode === "verify" && proc.pid && !proc.killed) {
        killProcessTree(proc, isWin);
      }
      if (opts.isCancelled?.()) {
        resolve(1);
        return;
      }
      if (opts.mode === "interactive") {
        const elapsed = Date.now() - startedAt;
        if (code === 0 && elapsed < 15000 && !sawGameLaunch) {
          resolve(1);
          return;
        }
      }
      resolve(code);
    };

    attachLineStream(proc, (line) => {
      onLine(line);
      if (/Launching Minecraft|Starting Minecraft|Running program|runClient/i.test(line)) {
        sawGameLaunch = true;
      }
      if (opts.mode === "verify" && CLIENT_FAIL.some((p) => p.test(line))) done(1);
    });

    if (opts.mode === "verify") {
      pollTimer = setInterval(() => {
        if (settled || verified) return;
        const content = readFreshLog();
        if (!content) return;
        if (CLIENT_FAIL.some((p) => p.test(content))) {
          const summary = summarizeFabricIncompatibleModsError(content);
          if (summary) onLine(summary);
          done(1);
          return;
        }
        if (CLIENT_SUCCESS.some((p) => p.test(content))) {
          verified = true;
          pendingSuccessTimer = setTimeout(() => done(0), 2500);
        }
      }, 2000);
    }

    timeoutTimer = setTimeout(() => {
      if (!settled) {
        if (opts.mode === "interactive") killProcessTree(proc, isWin);
        done(1);
      }
    }, timeoutMs);

    proc.on("close", (code) => {
      if (settled) return;
      if (opts.mode === "verify" && verified) {
        done(0);
        return;
      }
      if (opts.mode === "verify") {
        const content = readFreshLog();
        if (content && CLIENT_SUCCESS.some((p) => p.test(content))) {
          done(0);
          return;
        }
        const summary = content ? summarizeFabricIncompatibleModsError(content) : null;
        if (summary) onLine(summary);
        done(code === 0 ? 1 : (code ?? 1));
        return;
      }
      done(code ?? 1);
    });

    proc.on("error", () => done(1));
  });
}
