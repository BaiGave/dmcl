import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ensureDmclHome, getDmclHome } from "./dmcl-home.js";
import os from "node:os";
import { readJavaHomeFromProject } from "./jdk.js";
import { hasScaffoldMarker } from "./scaffold-marker.js";

export { readJavaHomeFromProject } from "./jdk.js";

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

/** DMCL 可逐文件清理的 Gradle 缓存上限；JDK 和原生运行库不计入。 */
export const DMCL_GRADLE_CACHE_MAX_BYTES = 24 * 1024 ** 3;
const CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface DmclGradleCachePruneOptions {
  maxBytes?: number;
}

export interface DmclGradleCachePruneResult {
  scannedBytes: number;
  deletedBytes: number;
  remainingBytes: number;
  skipped: boolean;
}

interface CacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

let activeGradleProcesses = 0;
let lastCachePruneAt = 0;
let cachePruneInflight: Promise<DmclGradleCachePruneResult> | null = null;

async function collectRebuildableCacheFiles(dir: string, files: CacheFile[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    if ((await fs.promises.lstat(dir)).isSymbolicLink()) return;
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // Gradle trusts native-library extraction markers without checking the DLL.
      // Preserve the directory so pruning cannot leave a marker without its library.
      if (["jdks", "dmcl-jdk8", "native"].includes(entry.name.toLowerCase())) continue;
      await collectRebuildableCacheFiles(entryPath, files);
      continue;
    }
    if (!entry.isFile() || /\.(?:lock|lck)$/i.test(entry.name)) continue;
    try {
      const stat = await fs.promises.stat(entryPath);
      files.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Files can disappear while Gradle rotates its cache metadata.
    }
  }
}

/**
 * 删除最旧的可重新下载的依赖文件，避免 DMCL 自己的 Gradle 目录无限增长。
 * 只扫描 DMCL_HOME/cache 下 Gradle 目录的 modules-2/files-2.1；JDK、原生运行库、Wrapper、
 * transforms、旧分片与用户自己的 Gradle 目录都不动。
 */
export async function pruneDmclGradleCache(
  options: DmclGradleCachePruneOptions = {},
): Promise<DmclGradleCachePruneResult> {
  if (activeGradleProcesses > 0) {
    return { scannedBytes: 0, deletedBytes: 0, remainingBytes: 0, skipped: true };
  }
  if (cachePruneInflight) return cachePruneInflight;

  const now = Date.now();
  if (options.maxBytes === undefined && now - lastCachePruneAt < CACHE_PRUNE_INTERVAL_MS) {
    return { scannedBytes: 0, deletedBytes: 0, remainingBytes: 0, skipped: true };
  }

  const run = async (): Promise<DmclGradleCachePruneResult> => {
    // 只清理 DMCL 自己的 Gradle 目录里的依赖文件：Gradle 发现 files-2.1 中的文件缺失会重新下载，
    // 而删掉 Wrapper 发行版或 transforms 里的单个文件会让缓存损坏。用户的 ~/.gradle 与旧分片从不清理。
    const cacheRoot = path.resolve(path.join(getDmclHome(), "cache"));
    const roots = [
      path.join(cacheRoot, "gradle", "caches", "modules-2", "files-2.1"),
      path.join(cacheRoot, "source-gradle", "caches", "modules-2", "files-2.1"),
    ];
    const files: CacheFile[] = [];
    const realCacheRoot = await fs.promises.realpath(cacheRoot).catch(() => cacheRoot);
    for (const root of roots) {
      // 任何一级是链接（Junction）指向 DMCL 之外时都不跟随
      const real = await fs.promises.realpath(root).catch(() => null);
      if (!real) continue;
      const rel = path.relative(realCacheRoot, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      await collectRebuildableCacheFiles(root, files);
    }
    const scannedBytes = files.reduce((sum, file) => sum + file.size, 0);
    const maxBytes = options.maxBytes ?? DMCL_GRADLE_CACHE_MAX_BYTES;
    let remainingBytes = scannedBytes;
    let deletedBytes = 0;

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (remainingBytes <= maxBytes || activeGradleProcesses > 0) break;
      try {
        await fs.promises.rm(file.path, { force: true });
        remainingBytes -= file.size;
        deletedBytes += file.size;
      } catch {
        // Locked or concurrently replaced cache files are left for the next pass.
      }
    }

    lastCachePruneAt = Date.now();
    return { scannedBytes, deletedBytes, remainingBytes, skipped: false };
  };

  cachePruneInflight = run().finally(() => {
    cachePruneInflight = null;
  });
  return cachePruneInflight;
}

function trackGradleProcess(proc: ChildProcess): void {
  activeGradleProcesses++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeGradleProcesses = Math.max(0, activeGradleProcesses - 1);
  };
  proc.once("close", release);
  proc.once("error", release);
}

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

/**
 * Gradle 用户目录只有一个来源：
 * - 导入项目（无 `.dmcl/scaffold.json`）用用户自己的 Gradle 目录（GRADLE_USER_HOME，否则 ~/.gradle），
 *   与作者手动执行 gradlew 共用依赖缓存与 Wrapper 发行版，首次启动不必重新下载；
 * - DMCL 生成的项目用 DMCL 自己的一个目录（DMCL_HOME/cache/gradle），避免用户 init.d 脚本影响旧版 Gradle。
 * 不再按 JVM 分片；旧的 jvm-* / shared 分片只读保留，见 measureLegacyGradleShards。
 */
export interface GradleUserHome {
  path: string;
  kind: "user" | "dmcl";
}

export function dmclGradleHome(): string {
  const dir = path.join(getDmclHome(), "cache", "gradle");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function userGradleHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GRADLE_USER_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".gradle");
}

export function resolveGradleUserHome(targetDir?: string): GradleUserHome {
  if (targetDir && !hasScaffoldMarker(targetDir)) return { path: userGradleHome(), kind: "user" };
  return { path: dmclGradleHome(), kind: "dmcl" };
}

/** 项目 Gradle 进程使用的用户目录（见 resolveGradleUserHome）；无参数时为 DMCL 自己的目录 */
export function getIsolatedGradleHome(targetDir?: string): string {
  return resolveGradleUserHome(targetDir).path;
}

/** 旧版按 JVM 分片的 Gradle 目录（DMCL_HOME/cache/gradle/jvm-*、shared），已不再写入 */
const LEGACY_SHARD = /^(?:jvm-\d+|shared)$/i;

export interface LegacyGradleShard {
  path: string;
  bytes: number;
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(full)).size;
      } catch { /* rotated */ }
    }
  }
  return total;
}

/** 统计旧分片占用（只读，不删除），供设置页提示用户手动清理 */
export async function measureLegacyGradleShards(): Promise<LegacyGradleShard[]> {
  const base = path.join(getDmclHome(), "cache", "gradle");
  let names: string[];
  try {
    names = (await fs.promises.readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && LEGACY_SHARD.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const shards: LegacyGradleShard[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    shards.push({ path: dir, bytes: await directoryBytes(dir) });
  }
  return shards;
}

/** 让子进程使用指定 JDK 的环境覆盖项（JAVA_HOME 与 PATH），不触碰项目文件 */
export function javaHomeEnvOverrides(
  javaHome: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "Path";
  return {
    JAVA_HOME: javaHome,
    [pathKey]: `${path.join(javaHome, "bin")}${path.delimiter}${base[pathKey] ?? ""}`,
  };
}

/**
 * 让 Gradle 与它派生的 JVM（守护进程、游戏客户端）把控制台输出编码为 UTF-8，
 * 中文 Windows 默认的 GBK 输出不再乱码。经 JAVA_TOOL_OPTIONS 传入，不改项目文件；
 * 不设置 file.encoding，编译与资源读取的行为保持不变。
 */
export const UTF8_CONSOLE_JVM_FLAGS = [
  "-Dstdout.encoding=UTF-8",
  "-Dstderr.encoding=UTF-8",
  "-Dsun.stdout.encoding=UTF-8",
  "-Dsun.stderr.encoding=UTF-8",
];

export function withUtf8ConsoleFlags(existing: string | undefined): string {
  const current = existing?.trim() ?? "";
  const missing = UTF8_CONSOLE_JVM_FLAGS.filter((flag) => !current.includes(flag.split("=")[0]));
  return [current, ...missing].filter(Boolean).join(" ");
}

/** 项目 Gradle 进程的环境：Gradle 用户目录、项目 JDK（经 JAVA_HOME）与 UTF-8 控制台输出 */
export function buildGradleEnv(targetDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  ensureDmclHome();
  env.GRADLE_USER_HOME = getIsolatedGradleHome(targetDir);
  const javaHome = readJavaHomeFromProject(targetDir);
  if (javaHome) Object.assign(env, javaHomeEnvOverrides(javaHome, env));
  env.JAVA_TOOL_OPTIONS = withUtf8ConsoleFlags(env.JAVA_TOOL_OPTIONS);
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
  // `.\` keeps this working when NoDefaultCurrentDirectoryInExePath=1 stops cmd from searching the project directory.
  const cmdArgs = isWin ? ["/c", ".\\gradlew.bat", ...tasks] : tasks;
  const proc = spawn(cmd, cmdArgs, {
    cwd: targetDir,
    env: { ...buildGradleEnv(targetDir), ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackGradleProcess(proc);
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

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
let consoleFallback: TextDecoder | null | undefined;

/** 非 UTF-8 行的回退解码：Windows 控制台代码页（中文系统为 GBK/GB18030），其他平台按 UTF-8 替换 */
function fallbackDecoder(): TextDecoder | null {
  if (consoleFallback !== undefined) return consoleFallback;
  const label = process.env.DMCL_CONSOLE_ENCODING?.trim() || (process.platform === "win32" ? "gb18030" : "");
  try {
    consoleFallback = label ? new TextDecoder(label) : null;
  } catch {
    consoleFallback = null;
  }
  return consoleFallback;
}

/** 按字节解码一行：优先 UTF-8，不合法时回退到控制台代码页（cmd.exe 自身的消息、未设置编码的旧 JVM） */
export function decodeProcessLine(bytes: Buffer): string {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return (fallbackDecoder() ?? new TextDecoder("utf-8")).decode(bytes);
  }
}

/**
 * 把子进程 stdout/stderr 切成完整行。按字节缓冲到换行再解码，多字节字符跨 chunk 不会被截断；
 * 每行单独判定 UTF-8 / 控制台代码页，混合编码的输出也能正确显示。
 */
export function attachLineStream(proc: ChildProcess, onLine: LineHandler): void {
  const attach = (stream: NodeJS.ReadableStream | null | undefined) => {
    if (!stream) return;
    let pending: Buffer = Buffer.alloc(0);
    const emit = (raw: Buffer) => {
      const end = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.length - 1 : raw.length;
      if (end > 0) onLine(decodeProcessLine(raw.subarray(0, end)));
    };
    stream.on("data", (data: Buffer | string) => {
      const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      let newline = pending.indexOf(0x0a, start);
      while (newline >= 0) {
        emit(pending.subarray(start, newline));
        start = newline + 1;
        newline = pending.indexOf(0x0a, start);
      }
      pending = start > 0 ? Buffer.from(pending.subarray(start)) : pending;
    });
    stream.on("end", () => {
      if (pending.length) emit(pending);
      pending = Buffer.alloc(0);
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
  await pruneDmclGradleCache();

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
  if (!hasGradlew(targetDir)) return 1;
  await ensureGradlewExecutable(targetDir);
  if (cancelledCode(opts) !== null) return 1;

  try {
    const { detectProject } = await import("../workspace/detect.js");
    const detected = detectProject(targetDir);
    if (detected?.loader === "fabric") {
      const { ensureFabricApiVersion } = await import("../loaders/fabric-toolchain.js");
      await ensureFabricApiVersion(targetDir, onLine);
    }
  } catch {
    // 修正失败不阻断构建，由 Gradle 报错后再走自动修复
  }

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
  await pruneDmclGradleCache();

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

  // 只有验证模式有超时；交互运行由用户关闭游戏或取消结束，玩多久都不会被强杀
  const verifyTimeoutMs = 10 * 60 * 1000;
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

    if (opts.mode === "verify") {
      timeoutTimer = setTimeout(() => {
        if (!settled) done(1);
      }, verifyTimeoutMs);
    }

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
