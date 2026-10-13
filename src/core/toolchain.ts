import fs from "node:fs";
import path from "node:path";
import type { LoaderId } from "../types.js";
import { detectProjectLoader } from "../workspace/loader-detect.js";
import { applyChinaMirror } from "./mirror.js";
import {
  detectJavaMajorAt,
  ensureProjectJdk,
  resolveBuildJdk,
  gradleJvmRange,
  analyzeJdkNeed,
  readGradleVersion,
  readMcVersionFromProject,
  usesForgeGradleLegacy,
  type BuildJdk,
  type BuildJdkOptions,
  type JdkLogger,
  type JdkOptions,
} from "./jdk.js";
import { saveToolchainMetadata } from "./toolchain-metadata.js";
import { hasScaffoldMarker } from "./scaffold-marker.js";
import { ensureForgeMavenizerJdkCache, usesForgeGradle } from "./forge-mavenizer.js";
import { minimumGradleForJvm } from "./version-toolchain.js";

export type { VersionToolchainSpec } from "./version-toolchain.js";
export { minimumGradleForJvm, recommendedGradleVersion, resolveVersionToolchain } from "./version-toolchain.js";

export interface ProjectToolchain {
  mcVersion: string;
  loader: LoaderId | null;
  gradleVersion: string | null;
  loomVersion: string | null;
  compileJavaMajor: number;
  /** Gradle 守护进程应使用的 JDK 主版本 */
  gradleRuntimeJdkMajor: number;
  gradleJvmMin: number;
  gradleJvmMax: number;
  needsForgeMavenizer: boolean;
  forgeMavenizerJdkMajor: number;
  summary: string;
  incompatibleReason?: string;
  /** 当前 Wrapper 过旧时建议升级到的 Gradle 版本 */
  gradleUpgradeRecommended?: string;
}

export interface ScaffoldMarker {
  loader: LoaderId;
  mcVersion: string;
  createdAt: string;
  dmclVersion: string;
}

export { hasScaffoldMarker } from "./scaffold-marker.js";

export async function writeScaffoldMarker(
  targetDir: string,
  loader: LoaderId,
  mcVersion: string,
): Promise<void> {
  const marker: ScaffoldMarker = {
    loader,
    mcVersion,
    createdAt: new Date().toISOString(),
    dmclVersion: "0.1.0",
  };
  const dir = path.join(targetDir, ".dmcl");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, "scaffold.json"),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

function gradleVersionAtLeast(current: string, minimum: string): boolean {
  const parse = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(current);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

/**
 * 分析项目完整工具链需求（不修改磁盘、不下载）。
 */
export function resolveProjectToolchain(
  targetDir: string,
  mcVersion?: string,
): ProjectToolchain | null {
  const mc = mcVersion ?? readMcVersionFromProject(targetDir);
  if (!mc) return null;

  const loader = detectProjectLoader(targetDir);
  const need = analyzeJdkNeed(targetDir, mc);
  const { gradleVersion, loomVersion } = need;
  const compileJavaMajor = need.compileMajor;
  const gradleRuntimeJdkMajor = need.major;
  const gradleMaxJvm = gradleVersion ? gradleJvmRange(gradleVersion).max : 25;
  const needsForgeMavenizer = usesForgeGradle(targetDir);
  const summary = needsForgeMavenizer ? `${need.summary} + Forge Mavenizer JDK 8` : need.summary;

  let incompatibleReason = need.incompatibleReason;
  let gradleUpgradeRecommended: string | undefined;

  if (gradleRuntimeJdkMajor > gradleMaxJvm) {
    const targetGradle = minimumGradleForJvm(gradleRuntimeJdkMajor);
    if (gradleVersion && !gradleVersionAtLeast(gradleVersion, targetGradle)) {
      gradleUpgradeRecommended = targetGradle;
      incompatibleReason = `Gradle ${gradleVersion} 最高支持 Java ${gradleMaxJvm}，但项目需要 Java ${gradleRuntimeJdkMajor}；建议升级 Wrapper 至 ${targetGradle}`;
    }
  }

  return {
    mcVersion: mc,
    loader,
    gradleVersion,
    loomVersion,
    compileJavaMajor,
    gradleRuntimeJdkMajor,
    gradleJvmMin: need.minMajor,
    gradleJvmMax: need.maxMajor,
    needsForgeMavenizer,
    forgeMavenizerJdkMajor: 8,
    summary,
    incompatibleReason,
    gradleUpgradeRecommended,
  };
}

/** 当 Wrapper 过旧时自动升级 distributionUrl（仅 DMCL 脚手架项目） */
export async function ensureGradleWrapperCompatibility(
  targetDir: string,
  toolchain: ProjectToolchain,
  log: JdkLogger,
): Promise<boolean> {
  if (!toolchain.gradleUpgradeRecommended) return false;

  if (usesForgeGradleLegacy(targetDir)) {
    log("⚠ 旧版 ForgeGradle 项目跳过 Gradle Wrapper 自动升级");
    return false;
  }
  if (!hasScaffoldMarker(targetDir)) {
    log("⚠ 外部导入项目跳过 Gradle Wrapper 自动升级，请手动调整 gradle-wrapper.properties");
    return false;
  }

  const wrapperProps = path.join(targetDir, "gradle", "wrapper", "gradle-wrapper.properties");
  if (!fs.existsSync(wrapperProps)) {
    log("⚠ 未找到 gradle-wrapper.properties，无法自动升级 Gradle");
    return false;
  }

  const target = toolchain.gradleUpgradeRecommended;
  const current = toolchain.gradleVersion ?? "unknown";
  log(`工具链：Gradle ${current} 无法运行 Java ${toolchain.compileJavaMajor}，自动升级 Wrapper → ${target}`);

  const content = await fs.promises.readFile(wrapperProps, "utf8");
  const distMatch = content.match(/distributionUrl=.*gradle-[\d.]+-(bin|all)\.zip/);
  const distType = distMatch?.[1] ?? "bin";
  const replaced = content.replace(
    /distributionUrl=.*gradle-[\d.]+-(bin|all)\.zip/,
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${target}-${distType}.zip`,
  );
  if (replaced === content) {
    log("⚠ 无法解析 gradle-wrapper.properties 中的 distributionUrl");
    return false;
  }
  await fs.promises.writeFile(wrapperProps, replaced, "utf8");
  await applyChinaMirror(targetDir, log);
  log(`✔ Gradle Wrapper 已升级至 ${target}`);
  return true;
}

/** 记录工具链与选定 JDK；导入项目之后的 Gradle 调用由此经 JAVA_HOME 取得 JDK */
export async function writeToolchainMetadata(
  targetDir: string,
  toolchain: ProjectToolchain,
  javaHome: string,
): Promise<void> {
  await saveToolchainMetadata(targetDir, {
    mcVersion: toolchain.mcVersion,
    loader: toolchain.loader,
    gradleVersion: readGradleVersion(targetDir),
    jdkMajor: detectJavaMajorAt(javaHome) ?? toolchain.gradleRuntimeJdkMajor,
    javaHome,
    compileJavaMajor: toolchain.compileJavaMajor,
    loomVersion: toolchain.loomVersion,
    configuredAt: new Date().toISOString(),
  });
}

/**
 * 一次性 Gradle 调用（如源码准备）的工具链：分析需求并选定 JDK，但不修改项目文件，
 * 不写 gradle.properties、不升级 Wrapper；JDK 由调用方经环境传给该次 Gradle 进程。
 */
export async function resolveProjectGradleJdk(
  targetDir: string,
  mcVersion: string | undefined,
  log: JdkLogger = () => {},
  options?: BuildJdkOptions,
): Promise<BuildJdk> {
  const toolchain = resolveProjectToolchain(targetDir, mcVersion);
  if (!toolchain) throw new Error("无法从项目推断 Minecraft 版本");
  log(`工具链分析：需要 Java ${toolchain.gradleRuntimeJdkMajor}（${toolchain.summary}）`);
  if (toolchain.incompatibleReason) throw new Error(toolchain.incompatibleReason);
  const jdk = await resolveBuildJdk(targetDir, toolchain.mcVersion, log, options);
  if (toolchain.needsForgeMavenizer) await ensureForgeMavenizerJdkCache(targetDir, log, options);
  return jdk;
}

/**
 * 全自动配置项目工具链：Gradle Wrapper 兼容 → JDK → 元数据 → Forge Mavenizer 缓存。
 * 只有 DMCL 脚手架项目会写 gradle.properties；导入项目的 JDK 记在 .dmcl/toolchain.json。
 */
export async function ensureProjectToolchain(
  targetDir: string,
  mcVersion: string | undefined,
  log: JdkLogger = () => {},
  options?: JdkOptions,
): Promise<void> {
  let toolchain = resolveProjectToolchain(targetDir, mcVersion);
  if (!toolchain) {
    throw new Error("无法从项目推断 Minecraft 版本");
  }

  log(`工具链分析：需要 Java ${toolchain.gradleRuntimeJdkMajor}（${toolchain.summary}）`);

  if (toolchain.gradleUpgradeRecommended) {
    const upgraded = await ensureGradleWrapperCompatibility(targetDir, toolchain, log);
    if (upgraded) {
      toolchain = resolveProjectToolchain(targetDir, toolchain.mcVersion)!;
      log(`工具链重分析：Java ${toolchain.gradleRuntimeJdkMajor}（${toolchain.summary}）`);
    }
  }

  if (toolchain.incompatibleReason) {
    throw new Error(toolchain.incompatibleReason);
  }

  const scaffolded = hasScaffoldMarker(targetDir);
  const javaHome = await ensureProjectJdk(targetDir, toolchain.mcVersion, log, {
    ...options,
    writeGradleProperties: scaffolded,
  });
  // Mavenizer 缓存按项目 JDK 分片，需先记录选择
  await writeToolchainMetadata(targetDir, toolchain, javaHome);
  if (!scaffolded) log("导入项目不改 gradle.properties，启动 Gradle 时经 JAVA_HOME 传入所选 JDK");

  if (toolchain.needsForgeMavenizer) {
    await ensureForgeMavenizerJdkCache(targetDir, log, options);
  }

  log("✔ 项目工具链已就绪");
}
