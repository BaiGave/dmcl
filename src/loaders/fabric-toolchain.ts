import fs from "node:fs";
import path from "node:path";
import { patchProperties, walkFiles } from "../core/fsutils.js";
import { requiredJavaFor } from "../core/jdk.js";
import { pascalCase } from "../core/scaffold.js";
import { fetchFabricApiVersion, isFabricApiVersionPublished, fabricApiVersionTargetsMc } from "../meta/fabric.js";
import { isLegacy1xMc, isUnobfuscatedMc, mcFeatureNumber, supportsSplitSources } from "../meta/mc-version.js";
import { detectProject } from "../workspace/detect.js";
import { wantsSplitSources } from "../core/side-layout.js";
import type { Logger, ProjectOptions } from "../types.js";

/**
 * Fabric API 的历史 mod id 兼容：
 * - 1.19 及更早运行期识别为 `fabric`
 * - 1.20+ 与 26.x 识别为 `fabric-api`
 */
export function usesLegacyFabricApi(mcVersion: string): boolean {
  if (!isLegacy1xMc(mcVersion)) return false;
  return mcFeatureNumber(mcVersion) <= 19;
}

/** MC 1.18+ / 26+ 支持 splitEnvironmentSourceSets */
export { supportsSplitSources } from "../meta/mc-version.js";

/** MC 26+ 非混淆，使用 fabric-loom；更早版本使用 fabric-loom-remap */
export function usesRemapLoom(mcVersion: string): boolean {
  return !isUnobfuscatedMc(mcVersion);
}

function modJavaVersionEnum(major: number): string {
  if (major <= 8) return "VERSION_1_8";
  return `VERSION_${major}`;
}

function mixinCompatibilityLevel(mcVersion: string): string {
  const major = requiredJavaFor(mcVersion);
  return major <= 8 ? "JAVA_8" : `JAVA_${major}`;
}

function stripSlf4jFromJava(content: string): string {
  if (!content.includes("org.slf4j")) return content;
  let next = content.replace(/^import org\.slf4j\.[^\n]+\n/gm, "");
  next = next.replace(
    /\s*public static final Logger LOGGER = LoggerFactory\.getLogger\([^)]+\);\s*\n/g,
    "\n",
  );
  next = next.replace(/\s*LOGGER\.(info|warn|error|debug)\([^;]+;\s*\n/g, "\n");
  return next;
}

async function removePathIfExists(p: string): Promise<void> {
  if (fs.existsSync(p)) await fs.promises.rm(p, { recursive: true, force: true });
}

/** 新版模板用于旧 MC 时：去掉 client 分源、slf4j、不兼容的示例 mixin */
async function adaptLegacyFabricSources(
  targetDir: string,
  opts: ProjectOptions,
  log: Logger,
): Promise<void> {
  if (supportsSplitSources(opts.mcVersion)) return;

  await removePathIfExists(path.join(targetDir, "src", "client"));

  for (const sub of ["client", "mixin"]) {
    await removePathIfExists(path.join(targetDir, "src", "main", "java", "com", "example", sub));
  }

  const mixinNames = new Set<string>();
  for (const file of await walkFiles(targetDir)) {
    if (!file.endsWith(".java")) continue;
    const base = path.basename(file);
    if (/ExampleMixin|ExampleModClient|ExampleClientMixin/.test(base)) {
      mixinNames.add(base.replace(/\.java$/, ""));
      await fs.promises.rm(file, { force: true });
      continue;
    }
    const raw = await fs.promises.readFile(file, "utf8");
    const stripped = stripSlf4jFromJava(raw);
    if (stripped !== raw) await fs.promises.writeFile(file, stripped, "utf8");
  }

  const resRoot = path.join(targetDir, "src", "main", "resources");
  if (fs.existsSync(resRoot)) {
    for (const entry of await fs.promises.readdir(resRoot)) {
      if (entry.includes("client") && entry.endsWith(".mixins.json")) {
        await fs.promises.rm(path.join(resRoot, entry), { force: true });
      }
    }
  }

  for (const file of await walkFiles(targetDir)) {
    if (!file.endsWith(".mixins.json")) continue;
    const doc = JSON.parse(await fs.promises.readFile(file, "utf8")) as {
      package?: string;
      mixins?: string[];
      compatibilityLevel?: string;
      overwrites?: unknown;
    };
    doc.compatibilityLevel = mixinCompatibilityLevel(opts.mcVersion);
    doc.mixins = (doc.mixins ?? []).filter((name) => !mixinNames.has(name));
    delete doc.overwrites;
    if (doc.package?.includes("example") && !doc.package.startsWith(opts.group)) {
      doc.package = `${opts.group}.mixin`;
    }
    await fs.promises.writeFile(file, JSON.stringify(doc, null, "\t") + "\n", "utf8");
  }

  const modJson = path.join(resRoot, "fabric.mod.json");
  if (fs.existsSync(modJson)) {
    const doc = JSON.parse(fs.readFileSync(modJson, "utf8")) as {
      mixins?: unknown[];
      entrypoints?: Record<string, string[]>;
    };
    if (Array.isArray(doc.mixins)) {
      doc.mixins = doc.mixins.filter((m) => typeof m === "string");
    }
    if (doc.entrypoints?.client) delete doc.entrypoints.client;
    fs.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
  }

  log("已适配旧版 MC 源码（移除 client 分源、slf4j 与不兼容示例 mixin）");
}

function mcFabricModJsonRange(mcVersion: string): string {
  const parts = mcVersion.split(".");
  if (parts.length >= 3) return `~${parts[0]}.${parts[1]}.${parts[2]}`;
  if (parts.length === 2) return `~${parts[0]}.${parts[1]}`;
  return `~${mcVersion}`;
}

export function patchBuildGradle(content: string, opts: ProjectOptions): string {
  const javaMajor = requiredJavaFor(opts.mcVersion);
  const javaEnum = modJavaVersionEnum(javaMajor);
  const remap = usesRemapLoom(opts.mcVersion);
  const split = wantsSplitSources(opts);

  if (remap) {
    content = content.replace(
      /id\s+['"]net\.fabricmc\.fabric-loom['"]/,
      "id 'net.fabricmc.fabric-loom-remap'",
    );
  }

  if (!split) {
    content = content.replace(/\n\s*splitEnvironmentSourceSets\(\)\s*\n/, "\n");
    content = content.replace(
      /mods\s*\{[\s\S]*?sourceSet sourceSets\.client[\s\S]*?\n\t\}/m,
      (block) => block.replace(/\n\s*sourceSet sourceSets\.client\s*\n/, "\n"),
    );
  }

  content = content.replace(
    /tasks\.withType\(JavaCompile\)\.configureEach\s*\{[\s\S]*?\}/m,
    javaMajor <= 8
      ? ""
      : `tasks.withType(JavaCompile).configureEach {\n\tit.options.release = ${javaMajor}\n}`,
  );

  content = content.replace(
    /sourceCompatibility\s*=\s*JavaVersion\.VERSION_\S+/g,
    `sourceCompatibility = JavaVersion.${javaEnum}`,
  );
  content = content.replace(
    /targetCompatibility\s*=\s*JavaVersion\.VERSION_\S+/g,
    `targetCompatibility = JavaVersion.${javaEnum}`,
  );

  if (isUnobfuscatedMc(opts.mcVersion)) {
    content = content.replace(/\n\s*mappings[^\n]*\n/g, "\n");
  } else if (!content.includes("mappings ") && !content.includes("mappings(")) {
    const mappingsLine = opts.mappings === "yarn"
      ? `\tmappings "net.fabricmc:yarn:\${project.yarn_mappings}"\n`
      : `\tmappings loom.officialMojangMappings()\n`;
    content = content.replace(
      /(dependencies\s*\{[\s\S]*?minecraft[^\n]*\n)/,
      `$1${mappingsLine}`,
    );
  }

  const depConfiguration = remap ? "modImplementation" : "implementation";
  content = content.replace(
    /\b(?:modImplementation|implementation)\b(?=\s+"net\.fabricmc)/g,
    depConfiguration,
  );

  return content;
}

function patchFabricModJson(targetDir: string, opts: ProjectOptions, loaderVersion: string | null): void {
  const file = path.join(targetDir, "src", "main", "resources", "fabric.mod.json");
  if (!fs.existsSync(file)) return;

  const javaMajor = requiredJavaFor(opts.mcVersion);
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as {
    depends?: Record<string, string>;
    entrypoints?: Record<string, string[]>;
    mixins?: unknown;
  };

  doc.depends ??= {};
  doc.depends.minecraft = mcFabricModJsonRange(opts.mcVersion);
  doc.depends.java = `>=${javaMajor}`;
  if (loaderVersion) doc.depends.fabricloader = `>=${loaderVersion}`;
  // fabric / fabric-api 由 syncFabricApiDependency 统一写入
  delete doc.depends["fabric-api"];
  delete doc.depends.fabric;

  if (!supportsSplitSources(opts.mcVersion)) {
    if (doc.entrypoints?.client) {
      delete doc.entrypoints.client;
    }
    if (Array.isArray(doc.mixins)) {
      doc.mixins = doc.mixins.filter((m) => typeof m === "string");
    }
  }

  fs.writeFileSync(file, JSON.stringify(doc, null, "\t") + "\n", "utf8");
}

function stripFabricApi(targetDir: string, log: Logger): void {
  const buildFile = path.join(targetDir, "build.gradle");
  if (fs.existsSync(buildFile)) {
    let content = fs.readFileSync(buildFile, "utf8");
    const next = content
      .replace(/\n\s*modImplementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
      .replace(/\n\s*implementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
      .replace(/\n\s*modImplementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n")
      .replace(/\n\s*implementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n");
    if (next !== content) {
      fs.writeFileSync(buildFile, next, "utf8");
      log("此版本无可用 Fabric API，已移除依赖");
    }
  }

  const modJson = path.join(targetDir, "src", "main", "resources", "fabric.mod.json");
  if (fs.existsSync(modJson)) {
    const doc = JSON.parse(fs.readFileSync(modJson, "utf8")) as { depends?: Record<string, string> };
    if (doc.depends) {
      delete doc.depends["fabric-api"];
      delete doc.depends.fabric;
      fs.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
    }
  }

  const props = path.join(targetDir, "gradle.properties");
  if (fs.existsSync(props)) {
    const content = fs.readFileSync(props, "utf8")
      .replace(/^\s*fabric_api_version\s*=.*\n/m, "")
      .replace(/^\s*fabric_version\s*=.*\n/m, "");
    fs.writeFileSync(props, content, "utf8");
  }
}

/** 同步 build.gradle 与 fabric.mod.json 中的 Fabric API 依赖 */
function syncFabricApiDependency(
  targetDir: string,
  opts: ProjectOptions,
  apiVersion: string,
  log: Logger,
): void {
  const legacy = usesLegacyFabricApi(opts.mcVersion);
  const buildFile = path.join(targetDir, "build.gradle");
  let content = fs.readFileSync(buildFile, "utf8");
  content = content
    .replace(/\n\s*modImplementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
    .replace(/\n\s*implementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
    .replace(/\n\s*modImplementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n")
    .replace(/\n\s*implementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n");

  const depConfiguration = usesRemapLoom(opts.mcVersion) ? "modImplementation" : "implementation";
  const dep = `\t${depConfiguration} "net.fabricmc.fabric-api:fabric-api:${apiVersion}"\n`;
  content = content.replace(
    /((?:modImplementation|implementation)\s+"net\.fabricmc:fabric-loader:[^"]+"\s*\n)/,
    `$1${dep}`,
  );
  fs.writeFileSync(buildFile, content, "utf8");
  log(legacy
    ? `已配置 Fabric API ${apiVersion}（运行时 mod id: fabric）`
    : `已配置 Fabric API ${apiVersion}`);

  const modJson = path.join(targetDir, "src", "main", "resources", "fabric.mod.json");
  if (!fs.existsSync(modJson)) return;
  const doc = JSON.parse(fs.readFileSync(modJson, "utf8")) as { depends?: Record<string, string> };
  doc.depends ??= {};
  delete doc.depends["fabric-api"];
  delete doc.depends.fabric;
  doc.depends[legacy ? "fabric" : "fabric-api"] = "*";
  fs.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
}

/** 按 MC 版本修正 Loom 插件、Java 兼容级别、映射与 fabric.mod.json */
export async function adaptFabricToolchain(
  opts: ProjectOptions,
  log: Logger,
  versions: { loaderVersion: string | null; apiVersion: string | null },
): Promise<void> {
  const buildFile = path.join(opts.targetDir, "build.gradle");
  if (fs.existsSync(buildFile)) {
    const content = patchBuildGradle(fs.readFileSync(buildFile, "utf8"), opts);
    fs.writeFileSync(buildFile, content, "utf8");
    log(`已适配 build.gradle（Java ${requiredJavaFor(opts.mcVersion)}、Loom 插件）`);
  }

  patchFabricModJson(opts.targetDir, opts, versions.loaderVersion);

  const props: Record<string, string | null | undefined> = {};
  if (versions.loaderVersion) props.loader_version = versions.loaderVersion;
  if (versions.apiVersion) {
    props.fabric_api_version = versions.apiVersion;
    props.fabric_version = versions.apiVersion;
  }
  if (Object.keys(props).length > 0) {
    await patchProperties(path.join(opts.targetDir, "gradle.properties"), props);
  }

  if (versions.apiVersion) {
    syncFabricApiDependency(opts.targetDir, opts, versions.apiVersion, log);
  } else {
    stripFabricApi(opts.targetDir, log);
  }

  await adaptLegacyFabricSources(opts.targetDir, opts, log);
}

function readGradleProps(targetDir: string): Record<string, string> {
  const file = path.join(targetDir, "gradle.properties");
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/** 启动客户端前修正 Fabric API 版本（修复旧项目或错误回退导致的 MC 不兼容） */
export async function ensureFabricApiVersion(targetDir: string, log: Logger): Promise<boolean> {
  const detected = detectProject(targetDir);
  if (!detected || detected.loader !== "fabric") return false;

  const props = readGradleProps(targetDir);
  const current = props.fabric_api_version ?? props.fabric_version ?? null;
  const resolved = await fetchFabricApiVersion(detected.mcVersion);
  if (!resolved) return false;

  const currentValid = current
    ? await isFabricApiVersionPublished(current) && fabricApiVersionTargetsMc(current, detected.mcVersion)
    : false;
  if (currentValid && current === resolved) return false;
  if (currentValid && current !== resolved) {
    // 当前版本可用且与解析结果不同时不强制覆盖（避免 Modrinth/Maven 排序差异误改）
    return false;
  }

  log(`Fabric API 版本修正：${current ?? "(未设置)"} → ${resolved}（MC ${detected.mcVersion}）`);

  const opts: ProjectOptions = {
    loader: "fabric",
    mcVersion: detected.mcVersion,
    targetDir,
    modId: detected.modId,
    displayName: detected.displayName,
    className: pascalCase(detected.displayName || detected.modId),
    group: detected.group,
    mirror: false,
    mappings: detected.mappings,
  };

  await adaptFabricToolchain(opts, log, {
    loaderVersion: props.loader_version ?? null,
    apiVersion: resolved,
  });
  return true;
}
