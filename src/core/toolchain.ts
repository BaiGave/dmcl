import fs from "node:fs";
import path from "node:path";
import type { LoaderId } from "../types.js";
import { getProjectsRoot } from "../workspace/paths.js";
import { applyChinaMirror } from "./mirror.js";
import {
  detectJavaMajorAt,
  ensureProjectJdk,
  gradleJvmRange,
  pickJdkMajor,
  readGradleVersion,
  readJavaHomeFromProject,
  readLoomVersion,
  readMcVersionFromProject,
  requiredJavaFor,
  usesForgeGradleLegacy,
  type JdkLogger,
  type JdkOptions,
} from "./jdk.js";
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

export interface ToolchainMetadata {
  mcVersion: string;
  loader: LoaderId | null;
  gradleVersion: string | null;
  jdkMajor: number;
  compileJavaMajor: number;
  loomVersion: string | null;
  configuredAt: string;
}

export interface ScaffoldMarker {
  loader: LoaderId;
  mcVersion: string;
  createdAt: string;
  dmclVersion: string;
}

/** DMCL 脚手架或工作区项目才允许自动改 Gradle Wrapper */
export function isDmclManagedProject(targetDir: string): boolean {
  const resolved = path.resolve(targetDir);
  const dmclDir = path.join(resolved, ".dmcl");
  if (fs.existsSync(path.join(dmclDir, "scaffold.json"))) return true;
  if (fs.existsSync(path.join(dmclDir, "toolchain.json"))) return true;
  const projectsRoot = path.resolve(getProjectsRoot());
  return resolved === projectsRoot || resolved.startsWith(projectsRoot + path.sep);
}

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

function detectLoaderFromProject(targetDir: string): LoaderId | null {
  const propsFile = path.join(targetDir, "gradle.properties");
  const props: Record<string, string> = {};
  if (fs.existsSync(propsFile)) {
    for (const line of fs.readFileSync(propsFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
      if (m) props[m[1]] = m[2].trim();
    }
  }
  if (props.loader_version || props.yarn_mappings || props.fabric_version) return "fabric";
  if (props.neo_version) return "neoforge";
  const buildGradle = fs.existsSync(path.join(targetDir, "build.gradle"))
    ? fs.readFileSync(path.join(targetDir, "build.gradle"), "utf8")
    : "";
  if (buildGradle.includes("net.neoforged")) return "neoforge";
  if (usesForgeGradle(targetDir)) return "forge";
  if (fs.existsSync(path.join(targetDir, "src", "main", "resources", "fabric.mod.json"))) return "fabric";
  if (fs.existsSync(path.join(targetDir, "src", "main", "resources", "META-INF", "neoforge.mods.toml"))) {
    return "neoforge";
  }
  if (fs.existsSync(path.join(targetDir, "src", "main", "resources", "META-INF", "mods.toml"))) return "forge";
  return null;
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

  const loader = detectLoaderFromProject(targetDir);
  const gradleVersion = readGradleVersion(targetDir);
  const loomVersion = readLoomVersion(targetDir);
  const compileJavaMajor = usesForgeGradleLegacy(targetDir) ? 8 : requiredJavaFor(mc);
  const range = gradleVersion ? gradleJvmRange(gradleVersion) : { min: 17, max: 25 };
  const gradleRuntimeJdkMajor = pickJdkMajor(mc, targetDir);
  const needsForgeMavenizer = usesForgeGradle(targetDir);

  const bits: string[] = [];
  if (gradleVersion) bits.push(`Gradle ${gradleVersion}`);
  if (loomVersion) bits.push(`Loom ${loomVersion}`);
  bits.push(`Minecraft ${mc} → Java ${compileJavaMajor}`);
  if (needsForgeMavenizer) bits.push("Forge Mavenizer JDK 8");
  const summary = bits.join(" + ");

  let incompatibleReason: string | undefined;
  let gradleUpgradeRecommended: string | undefined;

  if (gradleRuntimeJdkMajor > range.max) {
    const targetGradle = minimumGradleForJvm(compileJavaMajor);
    if (gradleVersion && !gradleVersionAtLeast(gradleVersion, targetGradle)) {
      gradleUpgradeRecommended = targetGradle;
      incompatibleReason = `Gradle ${gradleVersion} 最高支持 Java ${range.max}，但 Minecraft ${mc} 需要 Java ${compileJavaMajor}；建议升级 Wrapper 至 ${targetGradle}`;
    } else {
      incompatibleReason = `Gradle ${gradleVersion ?? "unknown"} 最高支持 Java ${range.max}，但项目需要 Java ${gradleRuntimeJdkMajor}`;
    }
  }

  return {
    mcVersion: mc,
    loader,
    gradleVersion,
    loomVersion,
    compileJavaMajor,
    gradleRuntimeJdkMajor,
    gradleJvmMin: range.min,
    gradleJvmMax: range.max,
    needsForgeMavenizer,
    forgeMavenizerJdkMajor: 8,
    summary,
    incompatibleReason,
    gradleUpgradeRecommended,
  };
}

/** 当 Wrapper 过旧时自动升级 distributionUrl（仅 DMCL 托管项目） */
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
  if (!isDmclManagedProject(targetDir)) {
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

function toolchainMetadataPath(targetDir: string): string {
  return path.join(targetDir, ".dmcl", "toolchain.json");
}

export async function writeToolchainMetadata(
  targetDir: string,
  toolchain: ProjectToolchain,
): Promise<void> {
  const configuredHome = readJavaHomeFromProject(targetDir);
  const configuredMajor = configuredHome ? detectJavaMajorAt(configuredHome) : null;
  const meta: ToolchainMetadata = {
    mcVersion: toolchain.mcVersion,
    loader: toolchain.loader,
    gradleVersion: readGradleVersion(targetDir),
    jdkMajor: configuredMajor ?? toolchain.gradleRuntimeJdkMajor,
    compileJavaMajor: toolchain.compileJavaMajor,
    loomVersion: toolchain.loomVersion,
    configuredAt: new Date().toISOString(),
  };
  const dir = path.dirname(toolchainMetadataPath(targetDir));
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(
    toolchainMetadataPath(targetDir),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
}

/**
 * 全自动配置项目工具链：Gradle Wrapper 兼容 → JDK → Forge Mavenizer 缓存 → 元数据。
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

  await ensureProjectJdk(targetDir, toolchain.mcVersion, log, options);

  if (toolchain.needsForgeMavenizer) {
    await ensureForgeMavenizerJdkCache(targetDir, log, options);
  }

  toolchain = resolveProjectToolchain(targetDir, toolchain.mcVersion)!;
  await writeToolchainMetadata(targetDir, toolchain);
  log("✔ 项目工具链已就绪");
}
