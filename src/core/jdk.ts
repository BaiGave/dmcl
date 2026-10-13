import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { readBuildScripts, resolveGradleValue } from "./build-script.js";
import { readPropertiesFile } from "./properties.js";
import { fetchJson, UA } from "./http.js";
import { readToolchainMetadata } from "./toolchain-metadata.js";

export type JdkLogger = (msg: string) => void;

export interface JdkOptions {
  isCancelled?: () => boolean;
}

function throwIfCancelled(options?: JdkOptions): void {
  if (options?.isCancelled?.()) throw new Error("已取消");
}

const JDK_CACHE = path.join(os.homedir(), ".dmcl", "jdks");
/** 旧版缓存目录，只读兼容 */
const LEGACY_JDK_CACHE = path.join(os.homedir(), ".mcdev", "jdks");
const UA_HEADER = { "user-agent": UA };

interface AdoptiumAsset {
  binary: {
    os: string;
    architecture: string;
    image_type: string;
    package: { name: string; link: string; size: number };
  };
  version: { major: number; openjdk_version: string };
}

function currentOs(): string {
  const p = process.platform;
  if (p === "win32") return "windows";
  if (p === "darwin") return "mac";
  return "linux";
}

function currentArch(): string {
  const a = process.arch;
  if (a === "x64") return "x64";
  if (a === "arm64") return "aarch64";
  return a;
}

/** MC 版本 → 所需 Java 主版本 */
export function requiredJavaFor(mcVersion: string): number {
  const m = mcVersion.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return 21;
  const a = Number(m[1]);
  const b = Number(m[2] ?? 0);
  const c = Number(m[3] ?? 0);
  if (a >= 26) return 25;
  if (a !== 1) return 21;
  if (b >= 21) return 21;
  if (b === 20) return c >= 5 ? 21 : 17;
  if (b >= 18) return 17;
  if (b === 17) return 17;
  return 8;
}

/** 检测 PATH 中 java 的主版本号，检测不到返回 null */
export function detectJavaMajor(): number | null {
  try {
    const res = spawnSync("java", ["-version"], { encoding: "utf8", timeout: 15_000 });
    const out = `${res.stderr ?? ""}${res.stdout ?? ""}`;
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const major = Number(m[1]);
    return major === 1 ? Number(m[2] ?? 0) : major;
  } catch {
    return null;
  }
}

/** `JAVA_VERSION="21.0.5"` / `"1.8.0_402"` from a JDK's `release` file → 21 / 8 */
export function parseReleaseJavaMajor(release: string): number | null {
  const m = release.match(/^JAVA_VERSION="?(\d+)(?:\.(\d+))?/m);
  if (!m) return null;
  const major = Number(m[1]);
  return major === 1 ? Number(m[2] ?? 0) : major;
}

const javaMajorCache = new Map<string, { stamp: string; major: number | null }>();

/**
 * 检测指定 JAVA_HOME 下 java 的主版本号。先读 JDK 的 `release` 文件（无需启动 JVM），
 * 读不到再执行 `java -version`；结果按目录与 java 可执行文件的修改时间缓存。
 */
export function detectJavaMajorAt(javaHome: string): number | null {
  const bin = javaBinary(javaHome);
  let stamp: string;
  try {
    const stat = fs.statSync(bin);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const key = path.resolve(javaHome).toLowerCase();
  const cached = javaMajorCache.get(key);
  if (cached && cached.stamp === stamp) return cached.major;
  let major: number | null = null;
  try {
    major = parseReleaseJavaMajor(fs.readFileSync(path.join(javaHome, "release"), "utf8"));
  } catch {
    major = null;
  }
  major ??= spawnJavaVersion(bin);
  javaMajorCache.set(key, { stamp, major });
  return major;
}

function spawnJavaVersion(bin: string): number | null {
  try {
    const res = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 15_000 });
    const out = `${res.stderr ?? ""}${res.stdout ?? ""}`;
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const major = Number(m[1]);
    return major === 1 ? Number(m[2] ?? 0) : major;
  } catch {
    return null;
  }
}

/** 项目 gradle.properties 自己配置的 org.gradle.java.home */
function readGradlePropertiesJavaHome(targetDir: string): string | null {
  return readGradleProps(targetDir)["org.gradle.java.home"]?.trim() || null;
}

/** DMCL 在 .dmcl/toolchain.json 记录的 JDK；目录中已没有 java 时视为未记录 */
function readRecordedJavaHome(targetDir: string): string | null {
  const javaHome = readToolchainMetadata(targetDir)?.javaHome;
  if (typeof javaHome !== "string" || !javaHome) return null;
  return fs.existsSync(javaBinary(javaHome)) ? javaHome : null;
}

/**
 * Gradle 在此项目使用的 JDK，构建、启动、缓存分片和反编译都以此为准：
 * 项目 gradle.properties 的 org.gradle.java.home 优先（Gradle 自身也以它为准），
 * 其次是 DMCL 记录的选择，由 buildGradleEnv 经 JAVA_HOME 传给 Gradle。
 */
export function readJavaHomeFromProject(targetDir: string): string | null {
  return readGradlePropertiesJavaHome(targetDir) ?? readRecordedJavaHome(targetDir);
}

/** Gradle 实际会使用的 JVM 主版本（优先项目配置，其次 JAVA_HOME，最后 PATH） */
export function effectiveJvmMajor(targetDir: string): number | null {
  const fromProps = readJavaHomeFromProject(targetDir);
  if (fromProps) return detectJavaMajorAt(fromProps);
  const envHome = process.env.JAVA_HOME;
  if (envHome) return detectJavaMajorAt(envHome);
  return detectJavaMajor();
}

/** 项目 gradle.properties（统一的 .properties 解析，兼容 CRLF） */
export function readGradleProps(targetDir: string): Record<string, string> {
  return readPropertiesFile(path.join(targetDir, "gradle.properties"));
}

/** 从 gradle-wrapper.properties 的 distributionUrl 解析 Gradle 版本 */
export function readGradleVersion(targetDir: string): string | null {
  const props = readPropertiesFile(path.join(targetDir, "gradle", "wrapper", "gradle-wrapper.properties"));
  const m = (props.distributionUrl ?? "").match(/gradle-(\d+(?:\.\d+)+(?:-[\w.]+?)?)-(?:bin|all)\.zip/);
  return m?.[1] ?? null;
}

/** `gradle/gradle-daemon-jvm.properties` 声明的守护进程 JVM 条件（Gradle 8.8+ 生效） */
export interface DaemonJvmCriteria {
  toolchainVersion: number;
  vendor?: string;
}

export function readDaemonJvmCriteria(targetDir: string): DaemonJvmCriteria | null {
  const props = readPropertiesFile(path.join(targetDir, "gradle", "gradle-daemon-jvm.properties"));
  const version = Number.parseInt(props.toolchainVersion ?? "", 10);
  if (!Number.isFinite(version) || version <= 0) return null;
  return props.toolchainVendor ? { toolchainVersion: version, vendor: props.toolchainVendor } : { toolchainVersion: version };
}

function gradleHonorsDaemonJvmCriteria(gradleVersion: string | null): boolean {
  if (!gradleVersion) return true;
  const [major = 0, minor = 0] = gradleVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return major > 8 || (major === 8 && minor >= 8);
}

/** 运行该 Gradle 版本所允许的 JVM 主版本范围 */
export function gradleJvmRange(gradleVersion: string): { min: number; max: number } {
  const parts = gradleVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const atLeast = (major: number, minor: number) =>
    parts[0] > major || (parts[0] === major && (parts[1] ?? 0) >= minor);
  const max = atLeast(9, 1) ? 25
    : atLeast(8, 14) ? 24
    : atLeast(8, 10) ? 23
    : atLeast(8, 8) ? 22
    : atLeast(8, 5) ? 21
    : atLeast(8, 3) ? 20
    : atLeast(7, 6) ? 19
    : atLeast(7, 5) ? 18
    : atLeast(7, 3) ? 17
    : atLeast(7, 0) ? 16
    : atLeast(6, 7) ? 15
    : atLeast(6, 3) ? 14
    : atLeast(6, 0) ? 13
    : atLeast(5, 4) ? 12
    : atLeast(5, 0) ? 11
    : atLeast(4, 7) ? 10
    : atLeast(4, 3) ? 9
    : 8;
  return { min: parts[0] >= 8 ? 17 : 8, max };
}

/** 从项目文件推断 Minecraft 版本 */
export function readMcVersionFromProject(targetDir: string): string | null {
  const props = readGradleProps(targetDir);
  if (props.minecraft_version) return props.minecraft_version;

  const buildGradlePath = path.join(targetDir, "build.gradle");
  if (fs.existsSync(buildGradlePath)) {
    const content = fs.readFileSync(buildGradlePath, "utf8");
    const forge = content.match(/minecraft\s*\{[^}]*version\s*=\s*["']([^"']+)["']/s);
    if (forge) return forge[1].split("-")[0];
    const forgeDependency = content.match(/minecraft\.dependency\(["']net\.minecraftforge:forge:([^-+"']+)-[^"']+["']\)/);
    if (forgeDependency) return forgeDependency[1];
    const neo = content.match(/minecraft_version\s*=\s*["']([^"']+)["']/);
    if (neo) return neo[1];
  }

  const fabricJson = path.join(targetDir, "src", "main", "resources", "fabric.mod.json");
  if (fs.existsSync(fabricJson)) {
    try {
      const j = JSON.parse(fs.readFileSync(fabricJson, "utf8")) as {
        depends?: { minecraft?: string };
      };
      const dep = j.depends?.minecraft;
      if (typeof dep === "string") {
        const m = dep.match(/(\d+\.\d+(?:\.\d+)?)/);
        if (m) return m[1];
      }
    } catch { /* ignore */ }
  }
  return null;
}

const LOOM_PLUGIN_VERSION =
  /\bid\s*\(?\s*['"](?:net\.fabricmc\.)?fabric-loom(?:-remap)?['"]\s*\)?\s*version\s*\(?\s*(?:(['"])([^'"\r\n]+)\1|([A-Za-z_][\w.]*))/;

/** 读取 Loom 版本：gradle.properties 的 loom_version，或构建脚本里 `id 'fabric-loom' version '…'` */
export function readLoomVersion(targetDir: string): string | null {
  const props = readGradleProps(targetDir);
  if (props.loom_version) return props.loom_version;
  const declared = LOOM_PLUGIN_VERSION.exec(readBuildScripts(targetDir));
  if (!declared) return null;
  return resolveGradleValue(declared[2] ?? `\${${declared[3]}}`, props);
}

/** Loom Gradle 插件运行所需的最低 JVM 主版本 */
export function loomMinJvm(loomVersion: string): number {
  const m = loomVersion.match(/^(\d+)\.(\d+)/);
  if (!m) return 21;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === 0) return minor >= 8 ? 17 : 16;
  if (major === 1 && minor < 7) return 17;
  return 21;
}

/** ForgeGradle 2.x / 3.x（非 FG7 dependency 语法） */
export function usesForgeGradleLegacy(targetDir: string): boolean {
  const buildFile = path.join(targetDir, "build.gradle");
  if (!fs.existsSync(buildFile)) return false;
  const content = fs.readFileSync(buildFile, "utf8");
  if (/minecraft\.dependency\s*\(\s*['"]net\.minecraftforge:forge/.test(content)) return false;
  if (/id\s*['"]net\.minecraftforge\.gradle['"]/.test(content)) return false;
  return /net\.minecraftforge\.gradle|ForgeGradle:/.test(content);
}

/**
 * 项目 Gradle 进程的 JDK 需求：唯一的需求分析，构建、启动、源码准备与工具链记录都以此为准。
 * - 旧版 ForgeGradle 固定 Java 8；
 * - 项目声明了 `gradle/gradle-daemon-jvm.properties`（Gradle 8.8+）时，守护进程就跑在 toolchainVersion 上，
 *   直接选这个版本，避免 Gradle 另找或另起 JVM；
 * - 否则取 Gradle 运行下限、Loom 插件下限与 Minecraft 编译目标的最高值，上限是该 Gradle 能运行的最高 Java。
 */
export interface JdkNeed {
  /** 应传给 Gradle 的 JDK 主版本 */
  major: number;
  /** 可接受的 Gradle JVM 主版本范围（含两端） */
  minMajor: number;
  maxMajor: number;
  compileMajor: number;
  gradleVersion: string | null;
  loomVersion: string | null;
  daemonJvm: DaemonJvmCriteria | null;
  legacyForge: boolean;
  summary: string;
  incompatibleReason?: string;
}

export function analyzeJdkNeed(targetDir: string, mcVersion: string): JdkNeed {
  const gradleVersion = readGradleVersion(targetDir);
  const range = gradleVersion ? gradleJvmRange(gradleVersion) : { min: 17, max: 25 };
  const legacyForge = usesForgeGradleLegacy(targetDir);
  const loomVersion = readLoomVersion(targetDir);
  const compileMajor = legacyForge ? 8 : requiredJavaFor(mcVersion);
  const daemonJvm = gradleHonorsDaemonJvmCriteria(gradleVersion) ? readDaemonJvmCriteria(targetDir) : null;

  const bits: string[] = [];
  if (gradleVersion) bits.push(`Gradle ${gradleVersion}`);
  if (loomVersion) bits.push(`Loom ${loomVersion}`);
  bits.push(`Minecraft ${mcVersion} -> Java ${compileMajor}`);
  if (daemonJvm) bits.push(`gradle-daemon-jvm.properties -> Java ${daemonJvm.toolchainVersion}`);
  const summary = bits.join(" + ");

  if (legacyForge) {
    return { major: 8, minMajor: 8, maxMajor: 8, compileMajor, gradleVersion, loomVersion, daemonJvm, legacyForge, summary };
  }

  const loomNeed = loomVersion ? loomMinJvm(loomVersion) : range.min;
  const computed = Math.max(range.min, loomNeed, compileMajor);
  let incompatibleReason: string | undefined;
  if (daemonJvm) {
    const major = daemonJvm.toolchainVersion;
    if (major > range.max) {
      incompatibleReason = `Gradle ${gradleVersion ?? "unknown"} supports running up to Java ${range.max}, but gradle-daemon-jvm.properties asks for Java ${major}`;
    } else if (major < computed) {
      incompatibleReason = `gradle-daemon-jvm.properties asks for Java ${major}, but this build needs Java ${computed} or newer (${summary})`;
    }
    return {
      major, minMajor: major, maxMajor: major, compileMajor, gradleVersion, loomVersion, daemonJvm, legacyForge, summary, incompatibleReason,
    };
  }
  if (computed > range.max) {
    incompatibleReason = `Gradle ${gradleVersion ?? "unknown"} supports running up to Java ${range.max}, but Minecraft ${mcVersion} needs Java ${compileMajor}`;
  }
  return {
    major: computed, minMajor: computed, maxMajor: range.max, compileMajor, gradleVersion, loomVersion, daemonJvm, legacyForge, summary, incompatibleReason,
  };
}

/** JDK 主版本是否落在需求范围内 */
export function jdkSatisfiesNeed(major: number | null, need: Pick<JdkNeed, "minMajor" | "maxMajor">): boolean {
  return major !== null && major >= need.minMajor && major <= need.maxMajor;
}

/** Gradle 进程应使用的 JDK 主版本（见 analyzeJdkNeed） */
export function pickJdkMajor(mcVersion: string, targetDir: string): number {
  return analyzeJdkNeed(targetDir, mcVersion).major;
}

/** 当前 JVM 是否可运行该项目的 Gradle（含 Loom 插件与守护进程 JVM 要求） */
export function isJvmCompatible(targetDir: string): boolean {
  const mcVersion = readMcVersionFromProject(targetDir);
  if (!mcVersion) return effectiveJvmMajor(targetDir) !== null;
  return jdkSatisfiesNeed(effectiveJvmMajor(targetDir), analyzeJdkNeed(targetDir, mcVersion));
}

/** 分析项目构建所需的 JDK 主版本及原因（不检测系统 Java）；与 analyzeJdkNeed 相同 */
export function resolveProjectJdkNeed(targetDir: string, mcVersion: string): JdkNeed {
  return analyzeJdkNeed(targetDir, mcVersion);
}

/** 项目当前的 JDK（见 readJavaHomeFromProject）是否可用且满足需求 */
export function projectJdkIsReady(
  targetDir: string,
  neededMajor: number,
  mcVersion?: string,
): boolean {
  const configured = readJavaHomeFromProject(targetDir);
  if (!configured || !fs.existsSync(javaBinary(configured))) return false;
  const major = detectJavaMajorAt(configured);
  const mc = mcVersion ?? readMcVersionFromProject(targetDir);
  if (!mc) return major !== null && major >= neededMajor;
  const need = analyzeJdkNeed(targetDir, mc);
  return jdkSatisfiesNeed(major, { minMajor: Math.max(need.minMajor, neededMajor), maxMajor: need.maxMajor });
}

export interface ProjectJdkOptions extends JdkOptions {
  /** 把选定 JDK 写入项目 gradle.properties，仅用于 DMCL 脚手架项目；其他项目由调用方记录并在启动 Gradle 时传入 */
  writeGradleProperties?: boolean;
}

/**
 * 确保项目有满足需求的 JDK 并返回其目录（每次构建/启动都重新校验已记录的选择）。
 * 不依赖用户系统是否已安装 Java；导入项目自己配置的 org.gradle.java.home 不满足时报错，不改写。
 */
export async function ensureProjectJdk(
  targetDir: string,
  mcVersion: string,
  log: JdkLogger = () => {},
  options?: ProjectJdkOptions,
): Promise<string> {
  const scaffoldWrite = options?.writeGradleProperties === true;
  const own = readGradlePropertiesJavaHome(targetDir);
  if (scaffoldWrite && own) {
    // 脚手架项目的 gradle.properties 由 DMCL 维护：不满足时换掉，而不是报错
    const need = analyzeJdkNeed(targetDir, mcVersion);
    if (need.incompatibleReason) throw new Error(need.incompatibleReason);
    if (fs.existsSync(javaBinary(own)) && jdkSatisfiesNeed(detectJavaMajorAt(own), need)) {
      log(`✔ 项目已配置 JDK ${detectJavaMajorAt(own) ?? need.major}：${own}`);
      return own;
    }
  }
  const chosen = await selectBuildJdk(targetDir, mcVersion, log, options ?? {}, { ignoreProjectProperty: scaffoldWrite });
  if (scaffoldWrite && chosen.javaHome !== own) {
    await injectJdkHome(targetDir, chosen.javaHome);
    log("已写入 org.gradle.java.home");
  }
  return chosen.javaHome;
}

export interface BuildJdkOptions extends JdkOptions {
  /** 调用方明确指定的 JDK（如命令行 --java-home）；项目自己配置了 JDK 时以项目为准 */
  javaHome?: string;
  /** false: 只使用磁盘上已有的 JDK，不触发自动下载（默认 true） */
  download?: boolean;
}

export interface BuildJdk {
  javaHome: string;
  /** JDK 报告的主版本；无法检测时为 null */
  major: number | null;
  origin: "project" | "requested" | "dmcl";
}

function javaBinary(javaHome: string): string {
  return path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
}

/**
 * 为一次 Gradle 调用选择 JDK，只返回路径，不写入项目文件，也不记录选择。
 * 项目 gradle.properties 已配置 org.gradle.java.home 时原样沿用，不满足构建需求就报错而不是覆盖；
 * 否则沿用 DMCL 记录且仍满足需求的 JDK，再取调用方指定的 JDK，最后取 DMCL 缓存或自动下载的 JDK。
 */
export async function resolveBuildJdk(
  targetDir: string,
  mcVersion: string,
  log: JdkLogger = () => {},
  options: BuildJdkOptions = {},
): Promise<BuildJdk> {
  return selectBuildJdk(targetDir, mcVersion, log, options, { ignoreProjectProperty: false });
}

async function selectBuildJdk(
  targetDir: string,
  mcVersion: string,
  log: JdkLogger,
  options: BuildJdkOptions,
  mode: { ignoreProjectProperty: boolean },
): Promise<BuildJdk> {
  throwIfCancelled(options);
  const need = analyzeJdkNeed(targetDir, mcVersion);
  log(`检查 JDK：此构建需要 Java ${need.major}（${need.summary}）`);
  if (need.incompatibleReason) throw new Error(need.incompatibleReason);

  const allowed = need.minMajor === need.maxMajor ? `Java ${need.major}` : `Java ${need.minMajor}–${need.maxMajor}`;
  const accept = (javaHome: string, origin: BuildJdk["origin"], label: string): BuildJdk => {
    const hint = origin === "project" ? "；DMCL 不改写导入项目的 gradle.properties，请自行调整或删除这一行" : "";
    if (!fs.existsSync(javaBinary(javaHome))) throw new Error(`${label}不存在 java：${javaHome}${hint}`);
    const major = detectJavaMajorAt(javaHome);
    if (major !== null && !jdkSatisfiesNeed(major, need)) {
      throw new Error(`${label}是 Java ${major}，此构建需要 ${allowed}（${need.summary}）：${javaHome}${hint}`);
    }
    return { javaHome, major, origin };
  };

  const configured = mode.ignoreProjectProperty ? null : readGradlePropertiesJavaHome(targetDir);
  if (configured) {
    const chosen = accept(configured, "project", "项目 gradle.properties 配置的 org.gradle.java.home ");
    log(`沿用项目配置的 JDK ${chosen.major ?? "?"}：${configured}`);
    return chosen;
  }
  const recorded = readRecordedJavaHome(targetDir);
  if (recorded) {
    try {
      const chosen = accept(recorded, "dmcl", "DMCL 为此项目记录的 JDK ");
      log(`沿用 DMCL 为此项目选定的 JDK ${chosen.major ?? "?"}：${recorded}`);
      return chosen;
    } catch (err) {
      log(`${(err as Error).message}；改为重新选择`);
    }
  }
  if (options.javaHome) {
    const chosen = accept(path.resolve(options.javaHome), "requested", "指定的 JDK ");
    log(`使用指定的 JDK ${chosen.major ?? "?"}：${chosen.javaHome}`);
    return chosen;
  }

  const cached = findCachedJdk(need.major);
  if (cached) {
    log(`使用 DMCL 已缓存的 JDK ${need.major}：${cached}`);
    return { javaHome: cached, major: need.major, origin: "dmcl" };
  }
  throwIfCancelled(options);
  if (options.download === false) throw new Error(`没有可用的 Java ${need.major}，且未启用自动下载`);
  log(`未检测到 JDK ${need.major}，开始自动下载（无需事先安装 Java）…`);
  const downloaded = await ensureJdkInCache(need.major, log, options);
  throwIfCancelled(options);
  return { javaHome: downloaded, major: need.major, origin: "dmcl" };
}

/** 查询 Adoptium API 获取 JDK 下载链接 */
export async function fetchJdkDownloadUrl(javaMajor: number): Promise<{
  url: string;
  filename: string;
  sizeBytes: number;
  versionLabel: string;
} | null> {
  try {
    const assets = await fetchJson<AdoptiumAsset[]>(
      `https://api.adoptium.net/v3/assets/latest/${javaMajor}/hotspot`,
      { retries: 1 },
    );
    const os = currentOs();
    const arch = currentArch();
    const match = assets.find(
      (a) =>
        a.binary.os === os &&
        a.binary.architecture === arch &&
        a.binary.image_type === "jdk",
    );
    if (!match) return null;
    return {
      url: match.binary.package.link,
      filename: match.binary.package.name,
      sizeBytes: match.binary.package.size,
      versionLabel: match.version.openjdk_version,
    };
  } catch {
    return null;
  }
}

/**
 * 清华 TUNA 的 Adoptium 镜像地址（国内速度快且稳定）。
 * 路径格式：/Adoptium/{major}/jdk/{arch}/{os}/{filename}
 */
export function jdkMirrorUrl(javaMajor: number, filename: string): string {
  return `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${javaMajor}/jdk/${currentArch()}/${currentOs()}/${filename}`;
}

/** 依次尝试多个 URL 下载，全部失败才抛错 */
export async function downloadWithFallback(
  urls: string[],
  dest: string,
  totalBytes: number,
  onProgress: (pct: number) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      await downloadWithProgress(url, dest, totalBytes, onProgress, isCancelled);
      return;
    } catch (err) {
      if (isCancelled?.()) throw err;
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error("下载失败");
}

/** 流式下载文件，每 2 MB 回调一次进度 */
export async function downloadWithProgress(
  url: string,
  dest: string,
  totalBytes: number,
  onProgress: (pct: number) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  const res = await fetch(url, { headers: UA_HEADER });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  if (!res.body) throw new Error("响应无 body");

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isCancelled?.()) throw new Error("已取消");
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    // 镜像源文件大小可能与 API 报告值略有出入，封顶 100
    onProgress(Math.min(100, Math.round((downloaded / totalBytes) * 100)));
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, Buffer.concat(chunks));
}

/** 检查 ~/.dmcl/jdks 缓存，验证版本后返回路径 */
export function findCachedJdk(javaMajor: number): string | null {
  for (const base of [JDK_CACHE, LEGACY_JDK_CACHE]) {
    const dir = path.join(base, String(javaMajor));
    if (!fs.existsSync(path.join(dir, "bin"))) continue;
    const major = detectJavaMajorAt(dir);
    if (major === javaMajor) return dir;
  }
  return null;
}

const jdkCacheInflight = new Map<number, Promise<string>>();

async function downloadJdkToCache(
  javaMajor: number,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<string> {
  throwIfCancelled(options);
  const existing = findCachedJdk(javaMajor);
  if (existing) return existing;

  const asset = await fetchJdkDownloadUrl(javaMajor);
  if (!asset) {
    throw new Error(`查询 JDK ${javaMajor} 下载地址失败，请手动安装：https://adoptium.net`);
  }

  const tmpDir = path.join(os.tmpdir(), `dmcl-jdk-${javaMajor}-${Date.now()}`);
  const zipDest = path.join(tmpDir, asset.filename);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  log(`下载 JDK ${javaMajor} ${asset.versionLabel}（${(asset.sizeBytes / 1024 / 1024).toFixed(0)} MB）…`);
  let lastPct = -10;
  const urls = [jdkMirrorUrl(javaMajor, asset.filename), asset.url];
  await downloadWithFallback(urls, zipDest, asset.sizeBytes, (pct) => {
    if (pct >= lastPct + 10 || (pct === 100 && lastPct !== 100)) {
      lastPct = pct;
      log(`下载 JDK ${pct}%`);
    }
  }, options?.isCancelled);

  throwIfCancelled(options);
  log("解压 JDK…");
  const jdkPath = await extractJdk(zipDest, javaMajor);
  await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  if (detectJavaMajorAt(jdkPath) !== javaMajor) {
    throw new Error(`下载的 JDK 不是 Java ${javaMajor}：${jdkPath}`);
  }
  log(`JDK 已安装至 ${jdkPath}`);
  return jdkPath;
}

/** 确保 JDK 已缓存；同版本并发下载/解压只执行一次 */
export async function ensureJdkInCache(
  javaMajor: number,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<string> {
  const cached = findCachedJdk(javaMajor);
  if (cached) return cached;

  const inflight = jdkCacheInflight.get(javaMajor);
  if (inflight) {
    log(`等待 JDK ${javaMajor} 下载完成…`);
    return inflight;
  }

  const promise = downloadJdkToCache(javaMajor, log, options).finally(() => {
    jdkCacheInflight.delete(javaMajor);
  });
  jdkCacheInflight.set(javaMajor, promise);
  return promise;
}

/** 解压 JDK zip，返回解压后的根目录路径 */
export async function extractJdk(zipPath: string, javaMajor: number): Promise<string> {
  const dest = path.resolve(path.join(JDK_CACHE, String(javaMajor)));
  await fs.promises.mkdir(dest, { recursive: true });
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  // 找到第一个目录条目作为根
  const firstDir = entries.find((e) => e.isDirectory && !e.entryName.startsWith("__"));
  const strip = firstDir ? `${firstDir.entryName}` : "";
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const rel = strip && entry.entryName.startsWith(strip)
      ? entry.entryName.slice(strip.length)
      : entry.entryName;
    if (!rel) continue;
    const target = path.resolve(dest, ...rel.split("/"));
    const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const t = norm(target);
    const d = norm(dest);
    if (!t.startsWith(d + path.sep) && t !== d) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, entry.getData());
  }
  // 返回解压根目录
  return dest;
}

/** 将 org.gradle.java.home 注入项目的 gradle.properties */
export async function injectJdkHome(targetDir: string, jdkPath: string): Promise<void> {
  const propsFile = path.join(targetDir, "gradle.properties");
  let content = "";
  if (fs.existsSync(propsFile)) {
    content = await fs.promises.readFile(propsFile, "utf8");
  }
  // 确保不以多余空行结尾
  const escaped = jdkPath.replace(/\\/g, "/");
  const marker = "org.gradle.java.home";
  if (content.includes(marker)) {
    content = content.replace(/^org\.gradle\.java\.home=.*$/m, `${marker}=${escaped}`);
  } else {
    content = `${content.trimEnd()}\n${marker}=${escaped}\n`;
  }
  await fs.promises.writeFile(propsFile, content, "utf8");
}
