import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { downloadFile } from "../core/http.js";
import {
  buildGradleEnv,
  javaHomeEnvOverrides,
  killProcessTree,
  readJavaHomeFromProject,
  runGradleTask,
} from "../core/gradle.js";
import type { BuildJdk } from "../core/jdk.js";
import { resolveProjectGradleJdk } from "../core/toolchain.js";
import { scaffoldProject, pascalCase } from "../core/scaffold.js";
import { getMetaCache } from "../meta/meta-cache.js";
import { getMappingsCache } from "../meta/mappings-cache.js";
import { compareMcVersions, isUnobfuscatedMc } from "../meta/mc-version.js";
import type { LoaderId, Logger, MappingsId, ProjectOptions } from "../types.js";
import { detectLoomMappings } from "./project-build.js";
import {
  getMinecraftSourceUnitDir,
  getModSourceUnitDir,
  getProjectSourceRoot,
  getSourceGradleHome,
  getSourceJobsRoot,
  getSourceVaultRoot,
  listMinecraftSourceEntries,
  safeSourceSegment,
  sourceUnitReady,
} from "./paths.js";
import type {
  MinecraftSourceEntry,
  MinecraftSourceManifest,
  ModSourceEntry,
  ProjectSourceIndex,
  ProjectSourceStatus,
  RuntimeModSourceCandidate,
  SourceArtifactRecord,
  SourceCenterStatus,
  SourceTarget,
  SourceTaskRequest,
  SourceTaskSnapshot,
} from "./types.js";

const CFR_VERSION = "0.152";
const CFR_URLS = [
  `https://maven.aliyun.com/repository/public/org/benf/cfr/${CFR_VERSION}/cfr-${CFR_VERSION}.jar`,
  `https://repo1.maven.org/maven2/org/benf/cfr/${CFR_VERSION}/cfr-${CFR_VERSION}.jar`,
];
const MIN_MINECRAFT_JAVA_FILES = 100;
const MAX_TASK_LOGS = 240;

interface MaterializeOptions extends SourceTarget {
  projectPath: string;
  force?: boolean;
  /** JDK for CFR when the project does not configure one (the same JDK its Gradle run used). */
  javaHome?: string;
  isCancelled?: () => boolean;
  onProcess?: (proc: ChildProcess, isWin: boolean) => void;
  log?: Logger;
}

interface NativeArchive {
  role: string;
  file: string;
}

function gradleUserHomes(): string[] {
  return [...new Set([
    getSourceGradleHome(),
    process.env.GRADLE_USER_HOME,
    path.join(os.homedir(), ".gradle"),
  ].filter((value): value is string => !!value).map((value) => path.resolve(value)))];
}

function readProperties(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([^#!\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) out[match[1].trim()] = match[2].trim();
  }
  return out;
}

function readBuildGradle(projectPath: string): string {
  const file = path.join(projectPath, "build.gradle");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function forgeVersionFromProject(projectPath: string, mcVersion: string): string | undefined {
  const props = readProperties(path.join(projectPath, "gradle.properties"));
  if (props.forge_version) {
    return props.forge_version.startsWith(`${mcVersion}-`)
      ? props.forge_version.slice(mcVersion.length + 1)
      : props.forge_version;
  }
  const build = readBuildGradle(projectPath);
  const coordinate = /net\.minecraftforge:forge:([^'"\s)]+)/.exec(build)?.[1];
  if (coordinate) {
    return coordinate.startsWith(`${mcVersion}-`)
      ? coordinate.slice(mcVersion.length + 1)
      : coordinate;
  }
  const legacy = new RegExp(`\\bversion\\s*=\\s*['"]${mcVersion.replace(/\./g, "\\.")}-([^'"]+)['"]`).exec(build)?.[1];
  return legacy;
}

function loaderVersionFromProject(loader: LoaderId, projectPath: string, mcVersion: string): string | undefined {
  const props = readProperties(path.join(projectPath, "gradle.properties"));
  if (loader === "fabric") return props.loader_version;
  if (loader === "forge") return forgeVersionFromProject(projectPath, mcVersion);
  return props.neo_version ?? props.neoforge_version;
}

export function detectProjectMapping(
  projectPath: string,
  fallback: SourceTarget,
): Pick<SourceTarget, "mapping" | "mappingVersion"> {
  const props = readProperties(path.join(projectPath, "gradle.properties"));
  if (fallback.loader === "fabric") {
    // The `mappings …` line in the Loom script decides what the generated sources are named with.
    const declared = detectLoomMappings(projectPath, props, fallback.mcVersion);
    if (declared) return declared;
  }
  if (props.parchment_version || props.parchment_mappings_version) {
    return {
      mapping: "parchment",
      mappingVersion: props.parchment_version ?? props.parchment_mappings_version,
    };
  }
  if (fallback.loader === "fabric") {
    if (props.yarn_mappings) return { mapping: "yarn", mappingVersion: props.yarn_mappings };
    return fallback;
  }
  if (fallback.loader !== "forge") return fallback;

  const build = readBuildGradle(projectPath);
  const channelMapping = /\bmappings\s+channel\s*:\s*['"]([^'"]+)['"]\s*,\s*version\s*:\s*['"]([^'"]+)['"]/.exec(build);
  if (channelMapping) {
    const channel = channelMapping[1].toLowerCase();
    const mapping: MappingsId = channel === "snapshot" || channel === "stable" ? "mcp" : "mojmap";
    return { mapping, mappingVersion: `${channel}_${channelMapping[2]}` };
  }
  const legacyMapping = /\bmappings\s*=\s*['"]((?:snapshot|stable)[^'"]+)['"]/.exec(build);
  if (legacyMapping) return { mapping: "mcp", mappingVersion: legacyMapping[1] };
  return fallback;
}

function collectFiles(root: string, predicate: (file: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && predicate(full)) out.push(full);
    }
  };
  visit(root);
  return out;
}

function zipHasEntry(file: string, predicate: (entryName: string) => boolean): boolean {
  try {
    const zip = new AdmZip(file);
    return zip.getEntries().some((entry) => !entry.isDirectory && predicate(entry.entryName));
  } catch {
    return false;
  }
}

function isMinecraftSourceArchive(file: string): boolean {
  return zipHasEntry(file, (name) => name.startsWith("net/minecraft/") && name.endsWith(".java"));
}

function isMinecraftClassArchive(file: string): boolean {
  return zipHasEntry(file, (name) => name.startsWith("net/minecraft/") && name.endsWith(".class"));
}

function newest(files: string[]): string | null {
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

function findFabricSourceArchives(projectPath: string, mcVersion: string): NativeArchive[] {
  const roots = [
    path.join(projectPath, ".gradle", "loom-cache", "minecraftMaven", "net", "minecraft"),
    path.join(projectPath, "build", "loom-cache", "minecraftMaven", "net", "minecraft"),
  ];
  const matches = roots.flatMap((root) => collectFiles(root, (file) => {
    const name = path.basename(file).toLowerCase();
    return name.startsWith("minecraft-")
      && name.endsWith("-sources.jar")
      && name.includes(mcVersion.toLowerCase())
      && isMinecraftSourceArchive(file);
  }));

  const merged = newest(matches.filter((file) => /minecraft-merged/i.test(path.basename(file))));
  if (merged) return [{ role: "minecraft-merged-sources", file: merged }];

  const common = newest(matches.filter((file) => /minecraft-common/i.test(path.basename(file))));
  const client = newest(matches.filter((file) => /minecraft-client/i.test(path.basename(file))));
  const selected: NativeArchive[] = [];
  if (common) selected.push({ role: "minecraft-common-sources", file: common });
  if (client) selected.push({ role: "minecraft-client-sources", file: client });
  return selected;
}

function findNeoForgeSourceArchive(projectPath: string): NativeArchive[] {
  const candidates = collectFiles(path.join(projectPath, "build"), (file) =>
    file.toLowerCase().endsWith("-sources.jar"),
  ).filter(isMinecraftSourceArchive);
  const file = newest(candidates);
  return file ? [{ role: "neoforge-minecraft-sources", file }] : [];
}

function findForgeSourceArchives(projectPath: string, mcVersion: string): NativeArchive[] {
  const roots = [
    path.join(projectPath, ".gradle"),
    path.join(projectPath, "build"),
    ...gradleUserHomes().map((home) => path.join(home, "caches", "minecraft")),
  ];
  const candidates = roots.flatMap((root) => collectFiles(root, (file) => {
    const name = path.basename(file).toLowerCase();
    return name.endsWith(".jar")
      && (name.includes("source") || name.includes("decomp"))
      && file.toLowerCase().includes(mcVersion.toLowerCase())
      && isMinecraftSourceArchive(file);
  }));
  const file = newest(candidates);
  return file ? [{ role: "forge-minecraft-sources", file }] : [];
}

export function findNativeMinecraftSourceArchives(
  projectPath: string,
  loader: LoaderId,
  mcVersion: string,
): NativeArchive[] {
  if (loader === "fabric") return findFabricSourceArchives(projectPath, mcVersion);
  if (loader === "forge") return findForgeSourceArchives(projectPath, mcVersion);
  if (loader === "neoforge") return findNeoForgeSourceArchive(projectPath);
  return [];
}

function findForgeMappedJar(projectPath: string, mcVersion: string, mapping: MappingsId): string | null {
  const forgeVersion = forgeVersionFromProject(projectPath, mcVersion);
  if (!forgeVersion) return null;
  const roots = gradleUserHomes().map((home) => path.join(
    home, "caches", "forge_gradle", "minecraft_user_repo", "net", "minecraftforge", "forge",
  )).filter((root) => fs.existsSync(root));
  const prefix = `${mcVersion}-${forgeVersion}_mapped_`.toLowerCase();
  const dirs = roots.flatMap((root) => fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
    .map((entry) => path.join(root, entry.name)));
  const preferred = dirs.sort((a, b) => {
    const score = (dir: string) => {
      const name = path.basename(dir).toLowerCase();
      if (mapping === "parchment" && name.includes("parchment")) return 3;
      if (mapping === "mojmap" && name.includes("official")) return 3;
      if (mapping === "mcp" && (name.includes("snapshot") || name.includes("stable"))) return 3;
      if (name.includes("snapshot") || name.includes("stable")) return 2;
      return 1;
    };
    return score(b) - score(a);
  });
  for (const dir of preferred) {
    const exact = path.join(dir, `${path.basename(dir)}.jar`);
    if (fs.existsSync(exact) && isMinecraftClassArchive(exact)) return exact;
    const candidate = newest(collectFiles(dir, (file) => {
      const name = path.basename(file).toLowerCase();
      return name.endsWith(".jar")
        && !name.includes("launcher")
        && !name.includes("extra")
        && isMinecraftClassArchive(file);
    }));
    if (candidate) return candidate;
  }
  const oldCacheCandidates = gradleUserHomes().flatMap((home) => collectFiles(
    path.join(home, "caches", "minecraft"),
    (file) => file.toLowerCase().endsWith(".jar")
      && file.toLowerCase().includes(mcVersion.toLowerCase())
      && isMinecraftClassArchive(file),
  ));
  const oldMapped = newest(oldCacheCandidates);
  if (oldMapped) return oldMapped;
  return null;
}

function findProjectMappedJar(projectPath: string, loader: LoaderId, mcVersion: string): string | null {
  const roots = loader === "fabric"
    ? [
      path.join(projectPath, ".gradle", "loom-cache", "minecraftMaven", "net", "minecraft"),
      path.join(projectPath, "build", "loom-cache", "minecraftMaven", "net", "minecraft"),
    ]
    : [path.join(projectPath, "build")];
  const candidates = roots.flatMap((root) => collectFiles(root, (file) => {
    const name = path.basename(file).toLowerCase();
    return name.endsWith(".jar")
      && !name.endsWith("-sources.jar")
      && name.includes(mcVersion.toLowerCase())
      && isMinecraftClassArchive(file);
  }));
  return newest(candidates);
}

export function findMappedMinecraftJar(
  projectPath: string,
  loader: LoaderId,
  mcVersion: string,
  mapping: MappingsId,
): string | null {
  if (loader === "forge") return findForgeMappedJar(projectPath, mcVersion, mapping);
  return findProjectMappedJar(projectPath, loader, mcVersion);
}

export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function safeArchiveDestination(root: string, entryName: string): string | null {
  const parts = entryName.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) return null;
  const target = path.resolve(root, ...parts);
  const resolvedRoot = path.resolve(root);
  const norm = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (norm(target) !== norm(resolvedRoot) && !norm(target).startsWith(norm(resolvedRoot) + path.sep)) {
    return null;
  }
  return target;
}

export async function extractJavaSources(archive: string, srcDir: string): Promise<number> {
  const zip = new AdmZip(archive);
  let written = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith(".java")) continue;
    const target = safeArchiveDestination(srcDir, entry.entryName);
    if (!target) continue;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, entry.getData());
    written++;
  }
  return written;
}

function countJavaFiles(root: string): number {
  return collectFiles(root, (file) => file.toLowerCase().endsWith(".java")).length;
}

function resolveUnitArtifact(unitDir: string, relativePath: string): string | null {
  const root = path.resolve(unitDir);
  const artifact = path.resolve(root, relativePath);
  const norm = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (norm(artifact) === norm(root) || !norm(artifact).startsWith(norm(root) + path.sep)) return null;
  return artifact;
}

async function repairMinecraftSourceUnit(unitDir: string, log?: Logger): Promise<boolean> {
  if (sourceUnitReady(unitDir)) return true;
  const manifestFile = path.join(unitDir, "manifest.json");
  if (!fs.existsSync(path.join(unitDir, "READY")) || !fs.existsSync(manifestFile)) return false;

  let manifest: MinecraftSourceManifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestFile, "utf8")) as MinecraftSourceManifest;
  } catch {
    return false;
  }
  if (manifest.schema !== 1 || !Array.isArray(manifest.artifacts)) return false;

  const sourceArchives = manifest.artifacts.filter((artifact) =>
    artifact.role.toLowerCase().includes("source") && artifact.path.toLowerCase().endsWith(".jar"),
  );
  for (const record of sourceArchives) {
    const archive = resolveUnitArtifact(unitDir, record.path);
    if (!archive || !fs.existsSync(archive) || !isMinecraftSourceArchive(archive)) continue;
    if (record.sha256 && await sha256File(archive) !== record.sha256) {
      log?.(`缓存源码包校验失败，已忽略：${path.basename(archive)}`);
      continue;
    }

    const repairRoot = `${unitDir}.repair-${randomUUID()}`;
    const repairSrc = path.join(repairRoot, "src");
    try {
      await fs.promises.mkdir(repairSrc, { recursive: true });
      const javaFiles = await extractJavaSources(archive, repairSrc);
      if (javaFiles < MIN_MINECRAFT_JAVA_FILES || !fs.existsSync(path.join(repairSrc, "net", "minecraft"))) {
        continue;
      }

      const finalSrc = path.join(unitDir, manifest.relativeSourcePath ?? "src");
      await fs.promises.rm(finalSrc, { recursive: true, force: true });
      await fs.promises.rename(repairSrc, finalSrc);
      manifest.javaFiles = javaFiles;
      await fs.promises.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      log?.(`已从缓存源码包恢复 ${javaFiles} 个 Java 文件`);
      return sourceUnitReady(unitDir);
    } finally {
      await fs.promises.rm(repairRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  return false;
}

function countReadySourceUnits(root: string, depth = 0): number {
  if (!fs.existsSync(root) || depth > 6) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, "READY")) && fs.existsSync(path.join(dir, "manifest.json"))) count++;
    else count += countReadySourceUnits(dir, depth + 1);
  }
  return count;
}

async function ensureCfr(): Promise<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const bundledCandidates = [
    process.env.DMCL_CFR_JAR,
    resourcesPath ? path.join(resourcesPath, "tools", "cfr.jar") : undefined,
    path.resolve(process.cwd(), "resources", "tools", "cfr.jar"),
  ].filter((candidate): candidate is string => !!candidate);
  for (const candidate of bundledCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1_000_000) return candidate;
  }

  const dir = path.join(getSourceVaultRoot(), "tools", "cfr", CFR_VERSION);
  const dest = path.join(dir, `cfr-${CFR_VERSION}.jar`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return dest;

  // Development compatibility: reuse the launcher extension's CFR when present.
  // Packaged DMCL uses resources/tools/cfr.jar prepared by scripts/fetch-cfr.mjs.
  const cursorExtensions = path.join(os.homedir(), ".cursor", "extensions");
  if (fs.existsSync(cursorExtensions)) {
    const extensionCandidates = fs.readdirSync(cursorExtensions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("minecraft-dev.minecraft-mod-launcher-"))
      .map((entry) => path.join(cursorExtensions, entry.name, "cfr-jar", "cfr.jar"))
      .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size > 1_000_000)
      .sort()
      .reverse();
    if (extensionCandidates[0]) return extensionCandidates[0];
  }

  await fs.promises.mkdir(dir, { recursive: true });
  const temp = `${dest}.download`;
  let lastError: Error | null = null;
  for (const url of CFR_URLS) {
    try {
      await downloadFile(url, temp);
      if (fs.statSync(temp).size < 1_000_000) throw new Error("下载文件过小");
      await fs.promises.rename(temp, dest);
      return dest;
    } catch (err) {
      lastError = err as Error;
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }
  throw new Error(`无法下载 CFR ${CFR_VERSION}：${lastError?.message ?? "未知错误"}`);
}

async function runCfr(
  projectPath: string,
  inputJar: string,
  outputDir: string,
  options: Pick<MaterializeOptions, "isCancelled" | "onProcess" | "log" | "javaHome">,
): Promise<void> {
  const cfr = await ensureCfr();
  const javaHome = readJavaHomeFromProject(projectPath) ?? options.javaHome;
  const java = javaHome
    ? path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  const args = [
    "-jar", cfr,
    inputJar,
    "--outputdir", outputDir,
    "--comments", "false",
    "--silent", "true",
    "--caseinsensitivefs", "true",
  ];
  await fs.promises.mkdir(outputDir, { recursive: true });
  options.log?.(`使用 CFR ${CFR_VERSION} 反编译已映射 JAR…`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(java, args, {
      cwd: projectPath,
      env: buildGradleEnv(projectPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.onProcess?.(proc, process.platform === "win32");
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
    });
    const timer = setInterval(() => {
      if (options.isCancelled?.()) killProcessTree(proc, process.platform === "win32");
    }, 500);
    proc.on("error", (err) => {
      clearInterval(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearInterval(timer);
      if (options.isCancelled?.()) {
        reject(new Error("已取消"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`CFR 退出码 ${code}：${stderr.trim().slice(-800)}`));
      }
    });
  });
}

async function copyArtifact(file: string, role: string, artifactDir: string): Promise<SourceArtifactRecord> {
  await fs.promises.mkdir(artifactDir, { recursive: true });
  const ext = path.extname(file) || ".jar";
  const dest = path.join(artifactDir, `${safeSourceSegment(role)}${ext}`);
  await fs.promises.copyFile(file, dest);
  const stat = await fs.promises.stat(dest);
  return {
    role,
    path: path.join("artifacts", path.basename(dest)).replace(/\\/g, "/"),
    sha256: await sha256File(dest),
    size: stat.size,
  };
}

function readableModSourcePath(sourceKind: ModSourceEntry["sourceKind"]): "source-code" | "decompiled-code" {
  return sourceKind === "cfr-decompile" ? "decompiled-code" : "source-code";
}

function modSourceLayout(
  sourceKind: ModSourceEntry["sourceKind"],
  sourceArchiveRetained = false,
): NonNullable<ModSourceEntry["layout"]> {
  return {
    stableSourcePath: "src",
    readableSourcePath: readableModSourcePath(sourceKind),
    sourceArchiveRetained,
  };
}

function isRetainedSourceArchiveArtifact(record: SourceArtifactRecord): boolean {
  if (record.role === "github-source" || record.role === "mod-sources" || record.role === "manual-source") {
    return true;
  }
  const name = path.basename(record.path).toLowerCase();
  return (name.endsWith(".zip") || name.endsWith(".jar")) && name.includes("source")
    && record.role !== "mod-original";
}

async function pruneLooseSourceArchiveArtifacts(unitDir: string): Promise<boolean> {
  const artifactDir = path.join(unitDir, "artifacts");
  if (!fs.existsSync(artifactDir)) return false;
  let changed = false;
  for (const item of await fs.promises.readdir(artifactDir, { withFileTypes: true })) {
    if (!item.isFile()) continue;
    const name = item.name.toLowerCase();
    if ((name.endsWith(".zip") || name.endsWith(".jar")) && name.includes("source") && name !== "mod-original.jar") {
      await fs.promises.rm(path.join(artifactDir, item.name), { force: true }).catch(() => {});
      changed = true;
    }
  }
  return changed;
}

async function writeModSourceLayoutReadme(
  unitDir: string,
  entry: Pick<ModSourceEntry, "sourceKind" | "layout">,
): Promise<void> {
  const readablePath = entry.layout?.readableSourcePath ?? readableModSourcePath(entry.sourceKind);
  const sourceDescription = entry.sourceKind === "cfr-decompile"
    ? "decompiled Java generated from artifacts/mod-original.jar by CFR"
    : "extracted upstream source code";
  const archivePolicy = entry.layout?.sourceArchiveRetained
    ? "A source archive is retained in artifacts/."
    : "Source archives are extracted and then removed from this unit.";
  const lines = [
    "# DMCL Mod Source Unit",
    "",
    `- Open \`${readablePath}/\` for ${sourceDescription}.`,
    "- `src/` is the stable compatibility path used by DMCL and project projections.",
    "- `artifacts/mod-original.jar` is kept for hash verification and reproducibility.",
    `- ${archivePolicy}`,
    "",
  ];
  await fs.promises.writeFile(path.join(unitDir, "README.md"), lines.join("\n"), "utf8");
}

async function ensureReadableModSourceLayout(unitDir: string, entry: ModSourceEntry): Promise<ModSourceEntry> {
  const layout = entry.layout ?? modSourceLayout(entry.sourceKind);
  const readablePath = layout.readableSourcePath;
  const stalePath = readablePath === "source-code" ? "decompiled-code" : "source-code";
  await fs.promises.rm(path.join(unitDir, stalePath), { recursive: true, force: true }).catch(() => {});
  await projectSourceLink(path.join(unitDir, "src"), path.join(unitDir, readablePath));
  await writeModSourceLayoutReadme(unitDir, { sourceKind: entry.sourceKind, layout });
  return { ...entry, layout };
}

async function normalizeModSourceUnitLayout(unitDir: string, entry: ModSourceEntry): Promise<ModSourceEntry> {
  const artifacts = entry.artifacts ?? [];
  const retainedArtifacts: SourceArtifactRecord[] = [];
  let changed = entry.layout?.sourceArchiveRetained !== false
    || entry.layout?.readableSourcePath !== readableModSourcePath(entry.sourceKind)
    || entry.sourcePath !== path.join(unitDir, "src")
    || entry.path !== unitDir;
  for (const artifact of artifacts) {
    if (isRetainedSourceArchiveArtifact(artifact)) {
      changed = true;
      await fs.promises.rm(path.join(unitDir, artifact.path), { force: true }).catch(() => {});
    } else {
      retainedArtifacts.push(artifact);
    }
  }
  if (await pruneLooseSourceArchiveArtifacts(unitDir)) changed = true;
  const normalized: ModSourceEntry = {
    ...entry,
    path: unitDir,
    sourcePath: path.join(unitDir, "src"),
    artifacts: retainedArtifacts,
    layout: modSourceLayout(entry.sourceKind, false),
  };
  await ensureReadableModSourceLayout(unitDir, normalized);
  if (changed) {
    await fs.promises.writeFile(
      path.join(unitDir, "manifest.json"),
      JSON.stringify(normalized, null, 2) + "\n",
      "utf8",
    );
  }
  return normalized;
}

async function commitStaging(staging: string, finalDir: string): Promise<void> {
  const previous = `${finalDir}.previous-${randomUUID()}`;
  await fs.promises.mkdir(path.dirname(finalDir), { recursive: true });
  if (fs.existsSync(finalDir)) await fs.promises.rename(finalDir, previous);
  try {
    let renamed = false;
    let renameError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.promises.rename(staging, finalDir);
        renamed = true;
        break;
      } catch (err) {
        renameError = err;
        if (!(["EPERM", "EBUSY", "EACCES"] as Array<string | undefined>).includes((err as NodeJS.ErrnoException).code)) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)));
      }
    }
    if (!renamed) {
      // Windows Defender / indexers can briefly lock a large extracted tree.
      // Copying into the final directory preserves correctness when directory rename stays unavailable.
      await fs.promises.rm(finalDir, { recursive: true, force: true });
      await fs.promises.cp(staging, finalDir, { recursive: true, force: true });
      await fs.promises.rm(staging, { recursive: true, force: true });
      if (!fs.existsSync(path.join(finalDir, "READY"))) throw renameError;
    }
    await fs.promises.rm(previous, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    await fs.promises.rm(finalDir, { recursive: true, force: true });
    if (fs.existsSync(previous)) await fs.promises.rename(previous, finalDir);
    throw err;
  }
}

export async function materializeMinecraftSourcesFromProject(
  options: MaterializeOptions,
): Promise<MinecraftSourceEntry> {
  const finalDir = getMinecraftSourceUnitDir(options.loader, options.mcVersion, options.mapping);
  if (!options.force) {
    const ready = sourceUnitReady(finalDir) || await repairMinecraftSourceUnit(finalDir, options.log);
    if (ready) {
      const cached = listMinecraftSourceEntries().find((entry) => entry.path === finalDir);
      if (cached) return cached;
    }
  }

  const staging = `${finalDir}.partial-${randomUUID()}`;
  const srcDir = path.join(staging, "src");
  const artifactDir = path.join(staging, "artifacts");
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(srcDir, { recursive: true });

  const artifactRecords: SourceArtifactRecord[] = [];
  let sourceKind: MinecraftSourceManifest["sourceKind"];
  const nativeArchives = findNativeMinecraftSourceArchives(
    options.projectPath,
    options.loader,
    options.mcVersion,
  );

  try {
    if (nativeArchives.length > 0) {
      sourceKind = "loader-sources";
      options.log?.(`找到 ${nativeArchives.length} 个加载器原生 Minecraft 源码包`);
      for (const archive of nativeArchives) {
        if (options.isCancelled?.()) throw new Error("已取消");
        await extractJavaSources(archive.file, srcDir);
        artifactRecords.push(await copyArtifact(archive.file, archive.role, artifactDir));
      }
    } else {
      sourceKind = "cfr-decompile";
      const mappedJar = findMappedMinecraftJar(
        options.projectPath,
        options.loader,
        options.mcVersion,
        options.mapping,
      );
      if (!mappedJar) {
        throw new Error("未找到加载器生成的 Minecraft 源码包或已映射 JAR");
      }
      options.log?.(`已定位映射产物：${mappedJar}`);
      artifactRecords.push(await copyArtifact(mappedJar, "minecraft-mapped", artifactDir));
      await runCfr(options.projectPath, mappedJar, srcDir, options);
    }

    options.log?.("校验源码完整性…");
    const javaFiles = countJavaFiles(srcDir);
    const hasMinecraft = fs.existsSync(path.join(srcDir, "net", "minecraft"));
    if (!hasMinecraft || javaFiles < MIN_MINECRAFT_JAVA_FILES) {
      throw new Error(`源码完整性校验失败：仅找到 ${javaFiles} 个 Java 文件`);
    }

    const manifest: MinecraftSourceManifest = {
      schema: 1,
      minecraftVersion: options.mcVersion,
      loader: options.loader,
      loaderVersion: loaderVersionFromProject(options.loader, options.projectPath, options.mcVersion),
      mapping: options.mapping,
      mappingVersion: options.mappingVersion,
      sourceKind,
      decompiler: sourceKind === "cfr-decompile"
        ? { name: "CFR", version: CFR_VERSION }
        : undefined,
      javaFiles,
      generatedAt: new Date().toISOString(),
      relativeSourcePath: "src",
      artifacts: artifactRecords,
    };
    await fs.promises.writeFile(
      path.join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    await fs.promises.writeFile(path.join(staging, "READY"), `${manifest.generatedAt}\n`, "utf8");
    await commitStaging(staging, finalDir);
    return {
      minecraftVersion: manifest.minecraftVersion,
      loader: manifest.loader,
      loaderVersion: manifest.loaderVersion,
      mapping: manifest.mapping,
      mappingVersion: manifest.mappingVersion,
      sourceKind: manifest.sourceKind,
      javaFiles: manifest.javaFiles,
      generatedAt: manifest.generatedAt,
      path: finalDir,
      sourcePath: path.join(finalDir, "src"),
    };
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

interface ResolvedModDependency {
  group: string;
  name: string;
  version: string;
  file: string;
  modId: string;
  modName: string;
  modVersion: string;
}

function isLoaderPlatformDependency(group: string, name: string, modId: string): boolean {
  const normalizedGroup = group.toLowerCase();
  const normalizedName = name.toLowerCase();
  const normalizedModId = modId.toLowerCase();
  if (normalizedGroup === "net.fabricmc" && normalizedName === "fabric-loader") return true;
  if (normalizedGroup.startsWith("net.fabricmc.fabric-api")) return true;
  if (normalizedGroup.startsWith("net.neoforged") || normalizedGroup.startsWith("net.minecraftforge")) return true;
  return ["minecraft", "fabricloader", "forge", "neoforge", "java"].includes(normalizedModId);
}

function zipText(zip: AdmZip, entryName: string): string | null {
  const entry = zip.getEntry(entryName);
  if (!entry || entry.isDirectory) return null;
  try { return entry.getData().toString("utf8"); } catch { return null; }
}

export function detectModMetadata(file: string, fallbackName: string, fallbackVersion: string): {
  modId: string;
  modName: string;
  modVersion: string;
} | null {
  try {
    const zip = new AdmZip(file);
    const fabric = zipText(zip, "fabric.mod.json");
    if (fabric) {
      const parsed = JSON.parse(fabric) as { id?: string; name?: string; version?: string };
      if (parsed.id) return {
        modId: parsed.id,
        modName: parsed.name || parsed.id,
        modVersion: typeof parsed.version === "string" && !parsed.version.includes("${")
          ? parsed.version
          : fallbackVersion,
      };
    }

    const toml = zipText(zip, "META-INF/neoforge.mods.toml")
      ?? zipText(zip, "META-INF/mods.toml");
    if (toml) {
      const modId = /\bmodId\s*=\s*["']([^"']+)["']/.exec(toml)?.[1];
      if (modId) {
        const name = /\bdisplayName\s*=\s*["']([^"']+)["']/.exec(toml)?.[1];
        const declaredVersion = /\bversion\s*=\s*["']([^"']+)["']/.exec(toml)?.[1];
        return {
          modId,
          modName: name || modId,
          modVersion: declaredVersion && !declaredVersion.includes("${") ? declaredVersion : fallbackVersion,
        };
      }
    }

    const legacy = zipText(zip, "mcmod.info");
    if (legacy) {
      const parsed = JSON.parse(legacy) as Array<{ modid?: string; name?: string; version?: string }>;
      const first = Array.isArray(parsed) ? parsed.find((item) => item.modid) : undefined;
      if (first?.modid) return {
        modId: first.modid,
        modName: first.name || first.modid,
        modVersion: first.version && !first.version.includes("${") ? first.version : fallbackVersion,
      };
    }
  } catch { /* not a readable mod jar */ }
  return null;
}

export function detectModLicense(file: string): NonNullable<ModSourceEntry["license"]> {
  try {
    const zip = new AdmZip(file);
    const fabric = zipText(zip, "fabric.mod.json");
    if (fabric) {
      const parsed = JSON.parse(fabric) as { license?: string | string[] };
      if (typeof parsed.license === "string" && parsed.license.trim()) {
        return { id: parsed.license.trim(), source: "jar" };
      }
      if (Array.isArray(parsed.license) && parsed.license.length > 0) {
        return { id: parsed.license.join(", "), source: "jar" };
      }
    }

    const toml = zipText(zip, "META-INF/neoforge.mods.toml")
      ?? zipText(zip, "META-INF/mods.toml");
    if (toml) {
      const license = /\blicense\s*=\s*["']([^"']+)["']/.exec(toml)?.[1];
      if (license) return { id: license, source: "jar" };
    }

    const licenseEntry = zip.getEntries().find((entry) => {
      const base = path.basename(entry.entryName).toLowerCase();
      return !entry.isDirectory && (base === "license" || base.startsWith("license.") || base === "copying");
    });
    if (licenseEntry) return { name: path.basename(licenseEntry.entryName), source: "jar" };
  } catch { /* best effort */ }
  return { source: "unknown" };
}

interface JavaSourceSummary {
  packages: string[];
  topLevelTypes: Array<{
    packageName: string;
    name: string;
    kind: string;
    public: boolean;
    path: string;
  }>;
}

function summarizeJavaSources(srcDir: string, unitDir: string): JavaSourceSummary {
  const packages = new Set<string>();
  const topLevelTypes: JavaSourceSummary["topLevelTypes"] = [];
  const javaFiles = collectFiles(srcDir, (file) => file.toLowerCase().endsWith(".java"));
  for (const file of javaFiles) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const packageName = /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m.exec(content)?.[1] ?? "";
    if (packageName) packages.add(packageName);
    const type = /\b(public\s+)?(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/.exec(content);
    if (type) {
      topLevelTypes.push({
        packageName,
        kind: type[2],
        name: type[3],
        public: !!type[1],
        path: path.relative(unitDir, file).replace(/\\/g, "/"),
      });
    }
  }
  return {
    packages: [...packages].sort(),
    topLevelTypes: topLevelTypes.sort((a, b) => {
      const byPackage = a.packageName.localeCompare(b.packageName);
      if (byPackage !== 0) return byPackage;
      return a.name.localeCompare(b.name);
    }),
  };
}

function modSourceOrigin(dep: ResolvedModDependency): NonNullable<ModSourceEntry["origin"]> {
  return {
    provider: dep.group === "local" ? "local" : "gradle",
    group: dep.group,
    name: dep.name,
    version: dep.version,
    file: dep.file,
  };
}

async function writeModSourceIndex(
  unitDir: string,
  srcDir: string,
  entry: ModSourceEntry,
  dep?: Pick<ResolvedModDependency, "group" | "name" | "version">,
): Promise<string> {
  const indexDir = path.join(unitDir, "index");
  await fs.promises.mkdir(indexDir, { recursive: true });
  const summary = summarizeJavaSources(srcDir, unitDir);
  const metadata = {
    schema: 1,
    generatedAt: entry.generatedAt,
    mod: {
      modId: entry.modId,
      modName: entry.modName,
      modVersion: entry.modVersion,
      loader: entry.loader,
      minecraftVersion: entry.minecraftVersion,
    },
    source: {
      sourceKind: entry.sourceKind,
      confidence: entry.confidence,
      javaFiles: entry.javaFiles,
      license: entry.license,
      layout: entry.layout,
    },
    artifact: entry.artifact,
    origin: entry.origin,
    dependency: dep
      ? {
        group: dep.group,
        name: dep.name,
        version: dep.version,
      }
      : undefined,
    packages: summary.packages,
    topLevelTypes: summary.topLevelTypes,
  };
  await fs.promises.writeFile(
    path.join(indexDir, "metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8",
  );

  const publicTypes = summary.topLevelTypes.filter((item) => item.public).slice(0, 40);
  const allTypes = summary.topLevelTypes.slice(0, 40);
  const typeLines = (publicTypes.length > 0 ? publicTypes : allTypes)
    .map((item) => `- \`${item.packageName ? `${item.packageName}.` : ""}${item.name}\` (${item.kind}) - \`${item.path}\``);
  const report = [
    `# ${entry.modName} (${entry.modId})`,
    "",
    `- Version: \`${entry.modVersion}\``,
    `- Loader: \`${entry.loader}\``,
    `- Minecraft: \`${entry.minecraftVersion}\``,
    `- Source: \`${entry.sourceKind}\` (${entry.confidence ?? "unknown"} confidence)`,
    `- Source directory: \`${entry.layout?.readableSourcePath ?? readableModSourcePath(entry.sourceKind)}/\``,
    `- Artifact SHA-256: \`${entry.artifactSha256}\``,
    `- Origin: \`${entry.origin?.provider ?? "unknown"}\``,
    `- License: \`${entry.license?.id ?? entry.license?.name ?? "unknown"}\``,
    `- Java files: ${entry.javaFiles}`,
    "",
    "## API Surface Preview",
    "",
    typeLines.length > 0
      ? typeLines.join("\n")
      : "No top-level Java types were detected.",
    "",
    "## Notes",
    "",
    entry.sourceKind === "cfr-decompile"
      ? "This source was produced by CFR from the resolved mod jar. Use `decompiled-code/` as a read-only compatibility reference."
      : entry.sourceKind === "github-source"
        ? "This source was extracted from a GitHub source archive into `source-code/`; the archive is not retained after extraction."
        : "This source was extracted into `source-code/`; the source archive is not retained after extraction.",
    "",
  ].join("\n");
  const reportPath = path.join(indexDir, "api-report.md");
  await fs.promises.writeFile(reportPath, report, "utf8");
  return path.relative(unitDir, reportPath).replace(/\\/g, "/");
}

function dependencyResolverScript(): string {
  return `gradle.projectsEvaluated {
    def root = gradle.rootProject
    if (root.tasks.findByName("dmclPrintSourceDependencies") == null) {
        root.tasks.create(name: "dmclPrintSourceDependencies") {
            doLast {
                def wanted = ["compileClasspath", "runtimeClasspath", "modCompileClasspath", "clientCompileClasspath"]
                def emitted = [] as Set
                root.allprojects.each { p ->
                    p.configurations.findAll { wanted.contains(it.name) }.each { cfg ->
                        try {
                            cfg.resolvedConfiguration.resolvedArtifacts.each { art ->
                                def f = art.file
                                if (f != null && f.name.endsWith(".jar") && emitted.add(f.absolutePath)) {
                                    def id = art.moduleVersion.id
                                    println "DMCL_DEP|" + id.group + "|" + id.name + "|" + id.version + "|" + f.absolutePath
                                }
                            }
                        } catch (Throwable ignored) { }
                    }
                }
            }
        }
    }
}
`;
}

/** The project's own Gradle environment, with the chosen JDK applied to this process only. */
function gradleEnvFor(projectPath: string, javaHome?: string): NodeJS.ProcessEnv {
  const env = buildGradleEnv(projectPath);
  if (javaHome) Object.assign(env, javaHomeEnvOverrides(javaHome, env));
  return env;
}

function runtimeModRoots(projectPath: string): string[] {
  return [
    path.join(projectPath, "run", "mods"),
    path.join(projectPath, "mods"),
    path.join(projectPath, "runs", "client", "mods"),
  ];
}

function collectRuntimeModFiles(projectPath: string, selectedPaths?: string[]): string[] {
  const files = selectedPaths?.length
    ? selectedPaths.map((file) => path.resolve(file))
    : runtimeModRoots(projectPath).flatMap((root) => collectFiles(root, (file) => file.toLowerCase().endsWith(".jar")));
  return [...new Set(files)].filter((file) => fs.existsSync(file) && file.toLowerCase().endsWith(".jar"));
}

function resolveSelectedRuntimeMods(projectPath: string, selectedPaths?: string[]): ResolvedModDependency[] {
  const resolved: ResolvedModDependency[] = [];
  const seen = new Set<string>();
  for (const file of collectRuntimeModFiles(projectPath, selectedPaths)) {
    if (seen.has(file) || !zipHasEntry(file, (entry) => entry.endsWith(".class"))) continue;
    const fallback = path.basename(file, path.extname(file));
    const metadata = detectModMetadata(file, fallback, "local");
    if (!metadata || ["minecraft", "fabricloader", "forge", "neoforge", "java"].includes(metadata.modId.toLowerCase())) continue;
    seen.add(file);
    resolved.push({ group: "local", name: fallback, version: metadata.modVersion, file, ...metadata });
  }
  const unique = new Map<string, ResolvedModDependency>();
  for (const dependency of resolved) unique.set(`${dependency.modId}:${dependency.modVersion}`, dependency);
  return [...unique.values()];
}

async function resolveModDependencies(
  projectPath: string,
  options: Pick<MaterializeOptions, "isCancelled" | "onProcess" | "log" | "javaHome"> & {
    onDependencyProgress?: (found: number, prepared: number, failures: number) => void;
    runtimeModPaths?: string[];
    includeGradleDependencies?: boolean;
    includeRuntimeMods?: boolean;
  },
): Promise<ResolvedModDependency[]> {
  if (options.includeGradleDependencies === false) {
    return resolveSelectedRuntimeMods(projectPath, options.runtimeModPaths);
  }
  const dmclDir = path.join(projectPath, ".dmcl");
  const script = path.join(dmclDir, "source-resolver.gradle");
  await fs.promises.mkdir(dmclDir, { recursive: true });
  await fs.promises.writeFile(script, dependencyResolverScript(), "utf8");
  const resolved: ResolvedModDependency[] = [];
  const seen = new Set<string>();
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    options.log?.(`Gradle 正在解析前置模组依赖… 已等待 ${seconds} 秒`);
  }, 10_000);
  heartbeat.unref?.();
  const code = await runGradleTask(
    projectPath,
    ["dmclPrintSourceDependencies", "-I", script, "--no-daemon", "--max-workers=1", "-q"],
    (line) => {
      if (!line.startsWith("DMCL_DEP|")) {
        if (/FAILED|Error|Exception|Could not/i.test(line)) options.log?.(line);
        return;
      }
      const parts = line.split("|");
      const file = parts.slice(4).join("|");
      if (parts.length < 5 || !file || seen.has(file) || !fs.existsSync(file)) return;
      if (!zipHasEntry(file, (entry) => entry.endsWith(".class"))) return;
      const metadata = detectModMetadata(file, parts[2], parts[3]);
      if (!metadata) return;
      if (isLoaderPlatformDependency(parts[1], parts[2], metadata.modId)) return;
      seen.add(file);
      resolved.push({
        group: parts[1],
        name: parts[2],
        version: parts[3],
        file,
        ...metadata,
      });
      options.onDependencyProgress?.(resolved.length, 0, 0);
    },
    {
      isCancelled: options.isCancelled,
      onProc: options.onProcess,
      env: gradleEnvFor(projectPath, options.javaHome),
      timeoutMs: 90 * 1000,
    },
  ).finally(() => clearInterval(heartbeat));
  if (code === 124) options.log?.("Gradle 依赖解析超过 90 秒，已停止等待；项目源码入口不受影响");
  if (code !== 0) options.log?.(`依赖源码解析未完成（Gradle 退出码 ${code}），将仅准备 Minecraft 源码`);
  const localModRoots = options.includeRuntimeMods === false ? [] : [
    path.join(projectPath, "mods"),
    path.join(projectPath, "run", "mods"),
    path.join(projectPath, "runs", "client", "mods"),
  ];
  for (const file of localModRoots.flatMap((root) => collectFiles(root, (candidate) => candidate.toLowerCase().endsWith(".jar")))) {
    if (seen.has(file) || !zipHasEntry(file, (entry) => entry.endsWith(".class"))) continue;
    const fallback = path.basename(file, path.extname(file));
    const metadata = detectModMetadata(file, fallback, "local");
    if (!metadata || ["minecraft", "fabricloader", "forge", "neoforge", "java"].includes(metadata.modId.toLowerCase())) continue;
    seen.add(file);
    resolved.push({ group: "local", name: fallback, version: metadata.modVersion, file, ...metadata });
  }
  const unique = new Map<string, ResolvedModDependency>();
  for (const dependency of resolved) {
    const key = `${dependency.modId}:${dependency.modVersion}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, dependency);
      continue;
    }
    if (!findDependencySourcesArchive(existing) && findDependencySourcesArchive(dependency)) {
      unique.set(key, dependency);
    }
  }
  return [...unique.values()];
}

function findDependencySourcesArchive(dep: ResolvedModDependency): string | null {
  const roots = gradleUserHomes().map((home) => path.join(
    home,
    "caches", "modules-2", "files-2.1", dep.group, dep.name, dep.version,
  ));
  const candidates = roots.flatMap((root) => collectFiles(root, (file) => {
    const name = path.basename(file).toLowerCase();
    return name.endsWith("-sources.jar") && zipHasEntry(file, (entry) => entry.endsWith(".java"));
  }));
  return newest(candidates);
}

function readModSourceEntry(unitDir: string): ModSourceEntry | null {
  try {
    if (!sourceUnitReady(unitDir)) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(unitDir, "manifest.json"), "utf8")) as ModSourceEntry;
    if (!manifest.modId || manifest.javaFiles < 1) return null;
    return {
      ...manifest,
      path: unitDir,
      sourcePath: path.join(unitDir, "src"),
      layout: manifest.layout ?? modSourceLayout(manifest.sourceKind),
    };
  } catch {
    return null;
  }
}

export async function listProjectRuntimeMods(
  projectPath: string,
  loader: LoaderId,
  minecraftVersion: string,
): Promise<RuntimeModSourceCandidate[]> {
  const candidates: RuntimeModSourceCandidate[] = [];
  const runModsRoot = path.join(projectPath, "run", "mods");
  for (const file of collectFiles(runModsRoot, (candidate) => candidate.toLowerCase().endsWith(".jar"))) {
    const fallback = path.basename(file, path.extname(file));
    const metadata = detectModMetadata(file, fallback, "local");
    if (!metadata || !zipHasEntry(file, (entry) => entry.endsWith(".class"))) {
      candidates.push({
        file,
        relativePath: path.relative(projectPath, file),
        supported: false,
      });
      continue;
    }
    const artifactSha256 = await sha256File(file);
    const cached = readModSourceEntry(getModSourceUnitDir(
      loader,
      minecraftVersion,
      metadata.modId,
      metadata.modVersion,
      artifactSha256,
    ));
    const readableFolder = cached?.layout?.readableSourcePath
      ?? (cached?.sourceKind === "cfr-decompile" ? "decompiled-code" : "source-code");
    candidates.push({
      file,
      relativePath: path.relative(projectPath, file),
      modId: metadata.modId,
      modName: metadata.modName,
      modVersion: metadata.modVersion,
      artifactSha256,
      supported: true,
      source: cached ? {
        ready: true,
        sourceKind: cached.sourceKind,
        confidence: cached.confidence,
        sourcePath: path.join(cached.path, readableFolder),
        javaFiles: cached.javaFiles,
      } : { ready: false },
    });
  }
  return candidates.sort((a, b) => (a.modName ?? path.basename(a.file)).localeCompare(b.modName ?? path.basename(b.file)));
}

async function materializeModSource(
  projectPath: string,
  target: SourceTarget,
  dep: ResolvedModDependency,
  force: boolean,
  options: Pick<MaterializeOptions, "isCancelled" | "onProcess" | "log" | "javaHome">,
): Promise<ModSourceEntry> {
  const artifactSha256 = await sha256File(dep.file);
  const finalDir = getModSourceUnitDir(
    target.loader,
    target.mcVersion,
    dep.modId,
    dep.modVersion,
    artifactSha256,
  );
  const cached = !force ? readModSourceEntry(finalDir) : null;
  if (cached) return await normalizeModSourceUnitLayout(finalDir, cached);

  const staging = `${finalDir}.partial-${randomUUID()}`;
  const srcDir = path.join(staging, "src");
  const artifactDir = path.join(staging, "artifacts");
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(srcDir, { recursive: true });
  try {
    const sourcesArchive = findDependencySourcesArchive(dep);
    let sourceKind: ModSourceEntry["sourceKind"];
    const artifactRecords: SourceArtifactRecord[] = [];
    if (sourcesArchive) {
      sourceKind = "sources-jar";
      await extractJavaSources(sourcesArchive, srcDir);
    } else {
      sourceKind = "cfr-decompile";
      await runCfr(projectPath, dep.file, srcDir, options);
    }
    const originalArtifact = await copyArtifact(dep.file, "mod-original", artifactDir);
    artifactRecords.push(originalArtifact);
    const javaFiles = countJavaFiles(srcDir);
    if (javaFiles < 1) throw new Error(`${dep.modId} 未生成可读 Java 源码`);
    const generatedAt = new Date().toISOString();
    const artifactStat = await fs.promises.stat(dep.file);
    const entry: ModSourceEntry = {
      loader: target.loader,
      minecraftVersion: target.mcVersion,
      modId: dep.modId,
      modName: dep.modName,
      modVersion: dep.modVersion,
      artifactSha256,
      sourceKind,
      origin: modSourceOrigin(dep),
      artifact: {
        path: originalArtifact.path,
        sha256: artifactSha256,
        size: artifactStat.size,
        maven: dep.group === "local"
          ? undefined
          : { group: dep.group, name: dep.name, version: dep.version },
      },
      confidence: sourceKind === "sources-jar" ? "high" : "medium",
      license: detectModLicense(dep.file),
      artifacts: artifactRecords,
      layout: modSourceLayout(sourceKind, false),
      javaFiles,
      generatedAt,
      path: finalDir,
      sourcePath: path.join(finalDir, "src"),
    };
    entry.reportPath = await writeModSourceIndex(staging, srcDir, entry, dep);
    await fs.promises.writeFile(path.join(staging, "manifest.json"), JSON.stringify(entry, null, 2) + "\n", "utf8");
    await fs.promises.writeFile(path.join(staging, "READY"), `${generatedAt}\n`, "utf8");
    await commitStaging(staging, finalDir);
    return await ensureReadableModSourceLayout(finalDir, entry);
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

type ExternalSourceArchiveKind = Extract<
  ModSourceEntry["sourceKind"],
  "sources-jar" | "github-source" | "manual-source"
>;

export interface ExternalModSourceMaterializeOptions {
  loader: LoaderId;
  minecraftVersion: string;
  projectPath?: string;
  modId: string;
  modName: string;
  modVersion: string;
  artifactFile: string;
  sourceArchiveFile?: string;
  sourceArchiveKind?: ExternalSourceArchiveKind;
  origin?: ModSourceEntry["origin"];
  license?: ModSourceEntry["license"];
  confidence?: ModSourceEntry["confidence"];
  force?: boolean;
  /** JDK that runs CFR when the project does not configure one. */
  javaHome?: string;
  isCancelled?: () => boolean;
  onProcess?: (proc: ChildProcess, isWin: boolean) => void;
  log?: Logger;
}

export async function materializeExternalModSource(
  options: ExternalModSourceMaterializeOptions,
): Promise<ModSourceEntry> {
  const artifactSha256 = await sha256File(options.artifactFile);
  const finalDir = getModSourceUnitDir(
    options.loader,
    options.minecraftVersion,
    options.modId,
    options.modVersion,
    artifactSha256,
  );
  const cached = !options.force ? readModSourceEntry(finalDir) : null;
  if (cached) return await normalizeModSourceUnitLayout(finalDir, cached);

  const staging = `${finalDir}.partial-${randomUUID()}`;
  const srcDir = path.join(staging, "src");
  const artifactDir = path.join(staging, "artifacts");
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(srcDir, { recursive: true });

  try {
    const artifactRecords: SourceArtifactRecord[] = [];
    let sourceKind: ModSourceEntry["sourceKind"];
    if (options.sourceArchiveFile) {
      sourceKind = options.sourceArchiveKind ?? "sources-jar";
      await extractJavaSources(options.sourceArchiveFile, srcDir);
    } else {
      sourceKind = "cfr-decompile";
      await runCfr(
        options.projectPath && fs.existsSync(options.projectPath) ? options.projectPath : process.cwd(),
        options.artifactFile,
        srcDir,
        options,
      );
    }

    const originalArtifact = await copyArtifact(options.artifactFile, "mod-original", artifactDir);
    artifactRecords.push(originalArtifact);
    const javaFiles = countJavaFiles(srcDir);
    if (javaFiles < 1) throw new Error(`${options.modId} did not produce readable Java sources`);
    const generatedAt = new Date().toISOString();
    const artifactStat = await fs.promises.stat(options.artifactFile);
    const origin = options.origin ?? {
      provider: "manual" as const,
      file: options.artifactFile,
    };
    const entry: ModSourceEntry = {
      loader: options.loader,
      minecraftVersion: options.minecraftVersion,
      modId: options.modId,
      modName: options.modName,
      modVersion: options.modVersion,
      artifactSha256,
      sourceKind,
      origin,
      artifact: {
        path: originalArtifact.path,
        sha256: artifactSha256,
        size: artifactStat.size,
        maven: origin.provider === "gradle" && origin.group && origin.name && origin.version
          ? { group: origin.group, name: origin.name, version: origin.version }
          : undefined,
      },
      confidence: options.confidence
        ?? (sourceKind === "cfr-decompile" ? "medium" : "high"),
      license: options.license ?? detectModLicense(options.artifactFile),
      decompiler: sourceKind === "cfr-decompile" ? { name: "CFR", version: CFR_VERSION } : undefined,
      artifacts: artifactRecords,
      layout: modSourceLayout(sourceKind, false),
      javaFiles,
      generatedAt,
      path: finalDir,
      sourcePath: path.join(finalDir, "src"),
    };
    const dependency = origin.group && origin.name && origin.version
      ? { group: origin.group, name: origin.name, version: origin.version }
      : undefined;
    entry.reportPath = await writeModSourceIndex(staging, srcDir, entry, dependency);
    await fs.promises.writeFile(path.join(staging, "manifest.json"), JSON.stringify(entry, null, 2) + "\n", "utf8");
    await fs.promises.writeFile(path.join(staging, "READY"), `${generatedAt}\n`, "utf8");
    await commitStaging(staging, finalDir);
    return await ensureReadableModSourceLayout(finalDir, entry);
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Nearest enclosing Git work tree: its top directory and the shared Git directory that holds info/exclude. */
function findEnclosingGitRepo(start: string): { top: string; commonDir: string } | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    let gitDir: string | null = null;
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) gitDir = dotGit;
      else {
        const pointer = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (pointer) gitDir = path.resolve(dir, pointer);
      }
    } catch { /* no .git here */ }
    if (gitDir) {
      const commonDirFile = path.join(gitDir, "commondir");
      if (fs.existsSync(commonDirFile)) gitDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, "utf8").trim());
      return { top: dir, commonDir: gitDir };
    }
    if (path.dirname(dir) === dir) return null;
  }
}

function gitIgnores(top: string, target: string): boolean {
  return spawnSync("git", ["-C", top, "check-ignore", "-q", "--", target], {
    stdio: "ignore",
    timeout: 10_000,
  }).status === 0;
}

/**
 * Keeps the generated `.dmcl/` out of Git without touching tracked files.
 * Variants nested in a larger repository (Linker's apps/minecraft/*) are covered by that repository's own
 * ignore rules or, failing that, by its local info/exclude - never by a new .gitignore inside the project.
 */
async function ensureProjectGitExclude(projectPath: string): Promise<void> {
  const repo = findEnclosingGitRepo(projectPath);
  if (repo) {
    if (gitIgnores(repo.top, path.join(projectPath, ".dmcl", "sources", "index.json"))) return;
    const relative = path.relative(repo.top, path.resolve(projectPath)).split(path.sep).filter(Boolean).join("/");
    const entry = `/${relative ? `${relative}/` : ""}.dmcl/`;
    const exclude = path.join(repo.commonDir, "info", "exclude");
    await fs.promises.mkdir(path.dirname(exclude), { recursive: true });
    const current = fs.existsSync(exclude) ? await fs.promises.readFile(exclude, "utf8") : "";
    if (!current.split(/\r?\n/).some((line) => line.trim() === entry)) {
      await fs.promises.appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`, "utf8");
    }
    return;
  }
  const gitignore = path.join(projectPath, ".gitignore");
  const current = fs.existsSync(gitignore) ? await fs.promises.readFile(gitignore, "utf8") : "";
  if (!/(^|\n)\/?\.dmcl\/(\n|$)/.test(current)) {
    await fs.promises.appendFile(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}.dmcl/\n`, "utf8");
  }
}

async function projectSourceLink(target: string, linkPath: string): Promise<"link" | "copy"> {
  await fs.promises.rm(linkPath, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
  try {
    await fs.promises.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return "link";
  } catch {
    await fs.promises.cp(target, linkPath, { recursive: true, force: true });
    return "copy";
  }
}

function readableProjectModFolder(mod: ModSourceEntry): "source-code" | "decompiled-code" {
  return mod.layout?.readableSourcePath
    ?? (mod.sourceKind === "cfr-decompile" ? "decompiled-code" : "source-code");
}

async function projectModSourceLink(root: string, mod: ModSourceEntry): Promise<void> {
  const projectedModRoot = path.join(root, "mods", safeSourceSegment(mod.modId), safeSourceSegment(mod.modVersion));
  const readableFolder = readableProjectModFolder(mod);
  await projectSourceLink(mod.sourcePath, path.join(projectedModRoot, "src"));
  await projectSourceLink(mod.sourcePath, path.join(projectedModRoot, readableFolder));
  const indexPath = path.join(mod.path, "index");
  if (fs.existsSync(indexPath)) await projectSourceLink(indexPath, path.join(projectedModRoot, "index"));
  const sourceNote = [
    `# ${mod.modName} (${mod.modId})`,
    "",
    `- Version: \`${mod.modVersion}\``,
    `- Source kind: \`${mod.sourceKind}\``,
    `- Confidence: \`${mod.confidence ?? "unknown"}\``,
    `- Readable source directory: \`${readableFolder}/\``,
    "",
    "`src/` is DMCL's stable path. The named directory above states whether this is upstream source code or CFR decompiled code.",
  ].join("\n") + "\n";
  await fs.promises.writeFile(path.join(projectedModRoot, "SOURCE.md"), sourceNote, "utf8");
}

async function writeProjectSourceReadme(root: string): Promise<void> {
  await fs.promises.writeFile(
    path.join(root, "README.md"),
    [
      "# DMCL Development Sources",
      "",
      "This directory is generated by DMCL and excluded from Git.",
      "",
      "- `minecraft/src/` contains Minecraft development sources when prepared.",
      "- `mods/<mod-id>/<mod-version>/source-code/` contains verified upstream sources or a sources jar.",
      "- `mods/<mod-id>/<mod-version>/decompiled-code/` contains CFR output from the exact runtime jar.",
      "- Each mod has `src/` as DMCL's stable path, plus `SOURCE.md` and `index/`.",
    ].join("\n") + "\n",
    "utf8",
  );
}

export function readProjectSourceIndex(root: string): ProjectSourceIndex | null {
  try {
    const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")) as ProjectSourceIndex;
    return index.schema === 1 && Array.isArray(index.mods) ? index : null;
  } catch {
    return null;
  }
}

function mergeProjectedMods(existing: ModSourceEntry[], incoming: ModSourceEntry[]): ModSourceEntry[] {
  const merged = new Map<string, ModSourceEntry>();
  for (const mod of existing) merged.set(`${mod.modId}\u0000${mod.modVersion}`, mod);
  for (const mod of incoming) merged.set(`${mod.modId}\u0000${mod.modVersion}`, mod);
  return [...merged.values()].sort((a, b) => {
    const byId = a.modId.localeCompare(b.modId);
    return byId !== 0 ? byId : b.modVersion.localeCompare(a.modVersion, undefined, { numeric: true });
  });
}

const projectSourceWrites = new Map<string, Promise<unknown>>();

async function withProjectSourceWrite<T>(projectPath: string, write: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(projectPath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = projectSourceWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  projectSourceWrites.set(key, current);
  try {
    return await current;
  } finally {
    if (projectSourceWrites.get(key) === current) projectSourceWrites.delete(key);
  }
}

async function writeProjectSourceProjection(
  projectPath: string,
  minecraft: MinecraftSourceEntry,
  mods: ModSourceEntry[],
): Promise<string> {
  return withProjectSourceWrite(projectPath, () => writeProjectSourceProjectionUnlocked(projectPath, minecraft, mods));
}

async function writeProjectSourceProjectionUnlocked(
  projectPath: string,
  minecraft: MinecraftSourceEntry,
  mods: ModSourceEntry[],
): Promise<string> {
  const root = getProjectSourceRoot(projectPath);
  mods = mergeProjectedMods(readProjectSourceIndex(root)?.mods ?? [], mods);
  await fs.promises.rm(root, { recursive: true, force: true });
  await fs.promises.mkdir(root, { recursive: true });
  await ensureProjectGitExclude(projectPath);
  await projectSourceLink(minecraft.sourcePath, path.join(root, "minecraft", "src"));
  for (const mod of mods) {
    await projectModSourceLink(root, mod);
  }
  const index: ProjectSourceIndex = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    projectPath: path.resolve(projectPath),
    minecraft,
    mods,
  };
  await fs.promises.writeFile(path.join(root, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  await fs.promises.writeFile(
    path.join(root, "README.md"),
    "# DMCL 开发源码\n\n此目录由 DMCL 自动生成并已排除 Git 提交。`minecraft/src` 是当前 MC 源码，`mods` 保存前置模组源码入口。\n",
    "utf8",
  );
  await writeProjectSourceReadme(root);
  return root;
}

/**
 * Adds an adaptation-center source unit to the project's visible source tree.
 * Existing Minecraft and previously selected mod projections remain in place.
 */
export async function projectExternalModSource(projectPath: string, mod: ModSourceEntry): Promise<{
  rootPath: string;
  modSourcePath: string;
}> {
  return withProjectSourceWrite(projectPath, () => projectExternalModSourceUnlocked(projectPath, mod));
}

async function projectExternalModSourceUnlocked(projectPath: string, mod: ModSourceEntry): Promise<{
  rootPath: string;
  modSourcePath: string;
}> {
  const rootPath = getProjectSourceRoot(projectPath);
  const existing = readProjectSourceIndex(rootPath);
  await fs.promises.mkdir(rootPath, { recursive: true });
  await ensureProjectGitExclude(projectPath);
  await projectModSourceLink(rootPath, mod);
  const index: ProjectSourceIndex = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    projectPath: path.resolve(projectPath),
    minecraft: existing?.minecraft,
    mods: mergeProjectedMods(existing?.mods ?? [], [mod]),
  };
  await fs.promises.writeFile(path.join(rootPath, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  await writeProjectSourceReadme(rootPath);
  return {
    rootPath,
    modSourcePath: path.join(
      rootPath,
      "mods",
      safeSourceSegment(mod.modId),
      safeSourceSegment(mod.modVersion),
      readableProjectModFolder(mod),
    ),
  };
}

export function getProjectSourceStatus(projectPath: string): ProjectSourceStatus {
  const rootPath = getProjectSourceRoot(projectPath);
  try {
    const index = readProjectSourceIndex(rootPath);
    if (!index) throw new Error("Project source index is unavailable");
    const mods = (index.mods ?? []).map((mod) => {
      const reportPath = mod.reportPath;
      return {
        modId: mod.modId,
        modName: mod.modName,
        modVersion: mod.modVersion,
        sourceKind: mod.sourceKind,
        confidence: mod.confidence,
        license: mod.license,
        reportPath,
        reportFilePath: reportPath
          ? path.join(rootPath, "mods", safeSourceSegment(mod.modId), safeSourceSegment(mod.modVersion), reportPath)
          : undefined,
      };
    });
    const minecraftReady = !!index.minecraft && fs.existsSync(path.join(rootPath, "minecraft", "src"));
    return {
      ready: index.schema === 1 && (minecraftReady || mods.length > 0),
      rootPath,
      minecraftReady,
      minecraftPath: minecraftReady ? path.join(rootPath, "minecraft", "src") : undefined,
      modCount: index.mods?.length ?? 0,
      mods,
      generatedAt: index.generatedAt,
    };
  } catch {
    return { ready: false, rootPath, modCount: 0 };
  }
}

async function prepareProjectSources(
  projectPath: string,
  target: SourceTarget,
  minecraft: MinecraftSourceEntry,
  force: boolean,
  options: Pick<MaterializeOptions, "isCancelled" | "onProcess" | "log" | "javaHome"> & {
    onDependencyProgress?: (found: number, prepared: number, failures: number) => void;
    runtimeModPaths?: string[];
    includeGradleDependencies?: boolean;
    includeRuntimeMods?: boolean;
  },
): Promise<{ rootPath: string; mods: ModSourceEntry[]; failures: number }> {
  const existingMods = readProjectSourceIndex(getProjectSourceRoot(projectPath))?.mods ?? [];
  const initialRootPath = await writeProjectSourceProjection(projectPath, minecraft, existingMods);
  options.log?.(`项目源码入口已创建：${initialRootPath}`);
  const dependencies = await resolveModDependencies(projectPath, options);
  options.onDependencyProgress?.(dependencies.length, 0, 0);
  options.log?.(`检测到 ${dependencies.length} 个带模组元数据的 Gradle 依赖`);
  const mods: ModSourceEntry[] = [];
  let failures = 0;
  for (const dep of dependencies) {
    if (options.isCancelled?.()) throw new Error("已取消");
    try {
      options.log?.(`准备前置源码：${dep.modId} ${dep.modVersion}`);
      mods.push(await materializeModSource(projectPath, target, dep, force, options));
    } catch (err) {
      failures++;
      options.log?.(`${dep.modId} 源码准备失败：${(err as Error).message}`);
    }
    options.onDependencyProgress?.(dependencies.length, mods.length, failures);
  }
  const projectedMods = mergeProjectedMods(existingMods, mods);
  return {
    rootPath: await writeProjectSourceProjection(projectPath, minecraft, projectedMods),
    mods: projectedMods,
    failures,
  };
}

async function resolveTarget(
  loader: LoaderId,
  mcVersion: string,
  requested?: MappingsId,
): Promise<SourceTarget> {
  const { entry } = await getMappingsCache().getOrFetch(loader, mcVersion);
  let mapping = isUnobfuscatedMc(mcVersion) ? "mojmap" : (requested ?? entry.default);
  if (!entry.options.some((option) => option.id === mapping && option.available)) {
    mapping = entry.default;
  }
  const option = entry.options.find((candidate) => candidate.id === mapping);
  return {
    loader,
    mcVersion,
    mapping,
    mappingVersion: option?.version ?? mcVersion,
  };
}

export async function planSourceTargets(request: SourceTaskRequest): Promise<SourceTarget[]> {
  if (!(["fabric", "forge", "neoforge"] as string[]).includes(request.loader)) {
    throw new Error("未知加载器");
  }
  if (request.scope === "single") {
    if (!request.mcVersion) throw new Error("请选择 Minecraft 版本");
    return [await resolveTarget(request.loader, request.mcVersion, request.mapping)];
  }
  const { data } = await getMetaCache().get();
  const versions = data.loaderVersions[request.loader] ?? [];
  const targets: SourceTarget[] = [];
  for (const version of versions) targets.push(await resolveTarget(request.loader, version));
  return targets;
}

function sourceJobModId(target: SourceTarget): string {
  return `dmcl_source_${target.loader}_${target.mcVersion}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 60);
}

class MinecraftSourceManager {
  private task: SourceTaskSnapshot | null = null;
  private cancelRequested = false;
  private currentProcess: { proc: ChildProcess; isWin: boolean } | null = null;
  /** JDK chosen for the project being prepared; one choice serves the whole task. */
  private projectJdk: { key: string; jdk: Promise<BuildJdk> } | null = null;

  status(): SourceCenterStatus {
    fs.mkdirSync(getSourceVaultRoot(), { recursive: true });
    return {
      rootPath: getSourceVaultRoot(),
      relativeRoot: path.join("sources", "v1"),
      task: this.task ? { ...this.task, logs: [...this.task.logs] } : null,
      entries: listMinecraftSourceEntries(),
      modEntries: countReadySourceUnits(path.join(getSourceVaultRoot(), "mods")),
    };
  }

  start(request: SourceTaskRequest): SourceTaskSnapshot {
    if (this.task?.state === "running") throw new Error("已有源码任务正在运行");
    this.cancelRequested = false;
    this.projectJdk = null;
    this.task = {
      id: randomUUID(),
      state: "running",
      scope: request.scope,
      loader: request.loader,
      total: 0,
      completed: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      currentPhase: "planning",
      projectPath: request.projectPath ? path.resolve(request.projectPath) : undefined,
      startedAt: new Date().toISOString(),
      logs: [],
    };
    void this.run(request);
    return { ...this.task, logs: [] };
  }

  cancel(): SourceTaskSnapshot | null {
    if (!this.task || this.task.state !== "running") return this.task;
    this.cancelRequested = true;
    if (this.currentProcess) killProcessTree(this.currentProcess.proc, this.currentProcess.isWin);
    this.log("正在取消源码任务…");
    return { ...this.task, logs: [...this.task.logs] };
  }

  private log(line: string): void {
    if (!this.task) return;
    this.task.logs.push(line.slice(0, 600));
    if (this.task.logs.length > MAX_TASK_LOGS) this.task.logs.splice(0, this.task.logs.length - MAX_TASK_LOGS);
  }

  private trackProcess(proc: ChildProcess, isWin: boolean): void {
    this.currentProcess = { proc, isWin };
  }

  /** Picks the JDK for this project's Gradle runs without editing its files; passed to Gradle by environment. */
  private resolveJdk(
    projectPath: string,
    mcVersion: string,
    request: SourceTaskRequest,
    download = true,
  ): Promise<BuildJdk> {
    const key = `${path.resolve(projectPath)}|${mcVersion}`;
    if (this.projectJdk?.key !== key) {
      this.projectJdk = {
        key,
        jdk: resolveProjectGradleJdk(projectPath, mcVersion, (line) => this.log(line), {
          isCancelled: () => this.cancelRequested,
          javaHome: request.javaHome,
          download,
        }),
      };
    }
    return this.projectJdk.jdk;
  }

  private async prepareTarget(target: SourceTarget, request: SourceTaskRequest): Promise<MinecraftSourceEntry | null> {
    const outputDir = getMinecraftSourceUnitDir(target.loader, target.mcVersion, target.mapping);
    if (!request.force) {
      const wasReady = sourceUnitReady(outputDir);
      const ready = wasReady || await repairMinecraftSourceUnit(outputDir, (line) => this.log(line));
      if (ready) {
        if (wasReady) {
          this.log(`${target.mcVersion} 已存在，跳过`);
          return null;
        }
        const repaired = listMinecraftSourceEntries().find((entry) => entry.path === outputDir);
        if (repaired) {
          this.log(`${target.mcVersion} 的空源码缓存已自动修复`);
          return repaired;
        }
      }
    }

    const directProject = request.projectPath ? path.resolve(request.projectPath) : null;
    const jobsRoot = getSourceJobsRoot();
    const jobPath = directProject ?? path.join(
      jobsRoot,
      `${safeSourceSegment(target.loader)}-${safeSourceSegment(target.mcVersion)}-${safeSourceSegment(target.mapping)}`,
    );
    if (directProject) {
      if (!fs.existsSync(jobPath) || !fs.existsSync(path.join(jobPath, process.platform === "win32" ? "gradlew.bat" : "gradlew"))) {
        throw new Error("项目目录不存在或缺少 Gradle Wrapper");
      }
      this.log(`使用当前模组项目：${jobPath}`);
    } else {
      await fs.promises.mkdir(jobsRoot, { recursive: true });
      await fs.promises.rm(jobPath, { recursive: true, force: true });
    }
    if (this.cancelRequested) throw new Error("已取消");

    this.task!.currentPhase = "scaffolding";
    if (!directProject) {
      this.log(`准备 ${target.loader} ${target.mcVersion} / ${target.mapping} 开发环境…`);
      const modId = sourceJobModId(target);
      const project: ProjectOptions = {
        loader: target.loader,
        mcVersion: target.mcVersion,
        modId,
        displayName: `DMCL Sources ${target.mcVersion}`,
        className: pascalCase(modId),
        group: `com.dmcl.sources.${modId.replace(/_/g, "")}`,
        targetDir: jobPath,
        mirror: request.mirror !== false,
        mappings: target.mapping,
        sideLayout: "unified",
      };
      await scaffoldProject(project, (line) => this.log(line));
    }
    const actualMapping = detectProjectMapping(jobPath, target);
    const actualTarget: SourceTarget = { ...target, ...actualMapping };
    this.task!.current = actualTarget;

    if (directProject) {
      try {
        this.task!.currentPhase = "extracting";
        const existingArtifacts = await materializeMinecraftSourcesFromProject({
          ...actualTarget,
          projectPath: jobPath,
          force: request.force,
          javaHome: request.javaHome,
          isCancelled: () => this.cancelRequested,
          onProcess: (proc, isWin) => this.trackProcess(proc, isWin),
          log: (line) => this.log(line),
        });
        this.log(`直接复用项目映射产物：${existingArtifacts.javaFiles} 个 Java 文件`);
        return existingArtifacts;
      } catch (err) {
        this.log(`项目尚无可用映射产物，将运行 Gradle：${(err as Error).message}`);
      } finally {
        this.currentProcess = null;
      }
    }
    const jdk = await this.resolveJdk(jobPath, target.mcVersion, request);
    if (this.cancelRequested) throw new Error("已取消");

    this.task!.currentPhase = "mapping";
    const legacyForgeWorkspace = target.loader === "forge" && compareMcVersions(target.mcVersion, "1.13") < 0;
    const tasks = target.loader === "fabric"
      ? ["genSources", "--no-daemon", "--max-workers=1"]
      : legacyForgeWorkspace
        ? ["setupDecompWorkspace", "--no-daemon", "--max-workers=1"]
        : ["build", "--no-daemon", "--max-workers=1"];
    this.log(`运行 gradlew ${tasks[0]}，生成映射产物…`);
    const code = await runGradleTask(jobPath, tasks, (line) => {
      if (/Download|BUILD|FAILED|Processing|decomp|source|mapping|Minecraft|Error|Exception/i.test(line)) {
        this.log(line);
      }
    }, {
      isCancelled: () => this.cancelRequested,
      onProc: (proc, isWin) => this.trackProcess(proc, isWin),
      env: { GRADLE_USER_HOME: getSourceGradleHome(), ...javaHomeEnvOverrides(jdk.javaHome) },
    });
    this.currentProcess = null;
    if (this.cancelRequested) throw new Error("已取消");
    if (code !== 0) throw new Error(`Gradle 源码准备失败（退出码 ${code}）`);

    this.task!.currentPhase = "extracting";
    const result = await materializeMinecraftSourcesFromProject({
      ...actualTarget,
      projectPath: jobPath,
      force: request.force,
      javaHome: jdk.javaHome,
      isCancelled: () => this.cancelRequested,
      onProcess: (proc, isWin) => this.trackProcess(proc, isWin),
      log: (line) => this.log(line),
    });
    this.currentProcess = null;
    this.task!.currentPhase = "verifying";
    this.log(`完成：${result.javaFiles} 个 Java 文件`);
    if (!directProject) await fs.promises.rm(jobPath, { recursive: true, force: true }).catch(() => {});
    return result;
  }

  private async run(request: SourceTaskRequest): Promise<void> {
    if (!this.task) return;
    try {
      const planned = await planSourceTargets(request);
      // A project's build script decides the mapping; look units up under that name, not the loader default.
      const targets = request.projectPath
        ? planned.map((target) => ({ ...target, ...detectProjectMapping(path.resolve(request.projectPath!), target) }))
        : planned;
      this.task.total = targets.length;
      if (targets.length === 0) throw new Error("该加载器没有可处理的 Minecraft 版本");
      this.log(`计划处理 ${targets.length} 个版本`);
      for (const target of targets) {
        if (this.cancelRequested) break;
        this.task.current = target;
        let counted = false;
        try {
          const result = await this.prepareTarget(target, request);
          let minecraftEntry: MinecraftSourceEntry | undefined;
          if (result) {
            this.task.successes++;
            this.task.outputPath = result.sourcePath;
            minecraftEntry = result;
          } else {
            this.task.skipped++;
            this.task.outputPath = path.join(
              getMinecraftSourceUnitDir(target.loader, target.mcVersion, target.mapping),
              "src",
            );
            minecraftEntry = listMinecraftSourceEntries().find((entry) =>
              entry.loader === target.loader
              && entry.minecraftVersion === target.mcVersion
              && entry.mapping === target.mapping,
            );
          }

          if (request.projectPath) {
            if (!minecraftEntry) throw new Error("Minecraft 源码已存在但索引不可读");
            this.task.completed++;
            counted = true;
            const actualTarget = this.task.current ?? target;
            this.task.currentPhase = request.includeDependencies === false ? "linking" : "dependencies";
            const dependencyJdk = request.includeDependencies === false || request.includeGradleDependencies === false
              ? undefined
              : await this.resolveJdk(request.projectPath, target.mcVersion, request, false).catch((err: Error) => {
                this.log(`依赖解析将使用默认 JDK：${err.message}`);
                return undefined;
              });
            const projection = request.includeDependencies === false
              ? {
                rootPath: await writeProjectSourceProjection(
                  request.projectPath,
                  minecraftEntry,
                  readProjectSourceIndex(getProjectSourceRoot(request.projectPath))?.mods ?? [],
                ),
                mods: [] as ModSourceEntry[],
                failures: 0,
              }
              : await prepareProjectSources(
                request.projectPath,
                actualTarget,
                minecraftEntry,
                request.force === true,
                {
                  javaHome: dependencyJdk?.javaHome,
                  isCancelled: () => this.cancelRequested,
                  onProcess: (proc, isWin) => this.trackProcess(proc, isWin),
                  log: (line) => this.log(line),
                  onDependencyProgress: (found, prepared, failures) => {
                    if (!this.task) return;
                    this.task.dependenciesFound = found;
                    this.task.dependenciesPrepared = prepared;
                    this.task.dependencyFailures = failures;
                  },
                  runtimeModPaths: request.runtimeModPaths,
                  includeGradleDependencies: request.includeGradleDependencies,
                  includeRuntimeMods: request.includeRuntimeMods,
                },
              );
            this.currentProcess = null;
            this.task.currentPhase = "linking";
            this.task.dependenciesFound = projection.mods.length + projection.failures;
            this.task.dependenciesPrepared = projection.mods.length;
            this.task.dependencyFailures = projection.failures;
            this.task.projectSourcesPath = projection.rootPath;
            this.task.outputPath = projection.rootPath;
            this.log(`项目源码入口已准备：${projection.rootPath}`);
          }
        } catch (err) {
          if (this.cancelRequested || (err as Error).message === "已取消") break;
          this.task.failures++;
          this.task.lastError = (err as Error).message;
          this.log(`${target.mcVersion} 失败：${(err as Error).message}`);
        } finally {
          if (!counted) this.task.completed++;
        }
      }
      this.task.current = undefined;
      this.task.currentPhase = undefined;
      this.task.finishedAt = new Date().toISOString();
      if (this.cancelRequested) this.task.state = "cancelled";
      else if (request.projectPath && this.task.failures > 0) this.task.state = "failed";
      else if (this.task.failures > 0 && this.task.successes + this.task.skipped === 0) this.task.state = "failed";
      else this.task.state = "completed";
    } catch (err) {
      this.task.state = this.cancelRequested ? "cancelled" : "failed";
      this.task.lastError = (err as Error).message;
      this.task.finishedAt = new Date().toISOString();
      this.log((err as Error).message);
    } finally {
      this.currentProcess = null;
    }
  }
}

const sourceManager = new MinecraftSourceManager();

export function getMinecraftSourceManager(): MinecraftSourceManager {
  return sourceManager;
}

export function getMinecraftSourceStatus(): SourceCenterStatus {
  return sourceManager.status();
}

export function startMinecraftSourceTask(request: SourceTaskRequest): SourceTaskSnapshot {
  return sourceManager.start(request);
}

export function cancelMinecraftSourceTask(): SourceTaskSnapshot | null {
  return sourceManager.cancel();
}
