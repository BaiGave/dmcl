import fs from "node:fs";
import crypto from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import {
  detectJavaMajorAt,
  ensureJdkInCache,
  readMcVersionFromProject,
  type JdkLogger,
  type JdkOptions,
} from "./jdk.js";
import { UA } from "./http.js";

const AUX_JDK_MAJOR = 8;
const DMCL_MAVENIZER_JDK_DIR = "dmcl-jdk8";
const fallbackResolver = new dns.Resolver();
fallbackResolver.setServers(["1.1.1.1", "8.8.8.8"]);

const resilientLookup: LookupFunction = (hostname, options, callback) => {
  let pending = 2;
  let settled = false;
  let lastError: NodeJS.ErrnoException | null = null;
  const fail = (err: NodeJS.ErrnoException) => {
    lastError = err;
    pending--;
    if (!settled && pending === 0) callback(lastError, "", 0);
  };
  const succeed = (addresses: dns.LookupAddress[]) => {
    if (settled || addresses.length === 0) return;
    settled = true;
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };

  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) fail(err);
    else succeed(addresses as dns.LookupAddress[]);
  });
  fallbackResolver.resolve4(hostname, (err, addresses) => {
    if (err) fail(err);
    else succeed(addresses.map((address) => ({ address, family: 4 })));
  });
};

interface MojangLibraryArtifact {
  path: string;
  sha1: string;
  size: number;
  url: string;
}

interface MojangDownload {
  sha1: string;
  size: number;
  url: string;
}

interface MojangVersionJson {
  assetIndex?: {
    id: string;
    sha1: string;
    size: number;
    url: string;
  };
  libraries?: Array<{
    name?: string;
    rules?: Array<{
      action: "allow" | "disallow";
      os?: {
        name?: string;
        arch?: string;
        version?: string;
      };
    }>;
    downloads?: {
      artifact?: MojangLibraryArtifact;
    };
  }>;
  downloads?: Record<string, MojangDownload | undefined>;
}

interface MojangVersionManifest {
  versions?: Array<{
    id?: string;
    sha1?: string;
    url?: string;
  }>;
}

interface MojangAssetsIndex {
  objects?: Record<string, {
    hash: string;
    size: number;
  }>;
}

function throwIfCancelled(options?: JdkOptions): void {
  if (options?.isCancelled?.()) throw new Error("cancelled");
}

function javaExe(javaHome: string): string {
  return path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
}

function sha1File(file: string): string | null {
  try {
    const hash = crypto.createHash("sha1");
    hash.update(fs.readFileSync(file));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isChildOf(parent: string, child: string): boolean {
  const p = normalize(parent);
  const c = normalize(child);
  return c === p || c.startsWith(p + path.sep);
}

export function usesForgeGradle(targetDir: string): boolean {
  const buildFile = path.join(targetDir, "build.gradle");
  if (!fs.existsSync(buildFile)) return false;
  const content = fs.readFileSync(buildFile, "utf8");
  return /net\.minecraftforge\.gradle|minecraft\.dependency\(['"]net\.minecraftforge:forge/.test(content);
}

export function gradleUserHome(): string {
  return path.resolve(process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), ".gradle"));
}

export function forgeMavenizerCacheDir(): string {
  return path.join(gradleUserHome(), "caches", "minecraftforge", "forgegradle", "mavenizer", "caches");
}

function artifactCachePath(cacheDir: string, artifactPath: string): string {
  return path.join(cacheDir, "maven", "mojang", ...artifactPath.split("/"));
}

function sharedGradleArtifactPath(artifact: MojangLibraryArtifact): string | null {
  const parts = artifact.path.split("/");
  if (parts.length < 4) return null;
  const filename = parts.at(-1)!;
  const version = parts.at(-2)!;
  const module = parts.at(-3)!;
  const group = parts.slice(0, -3).join(".");
  const versionDir = path.join(
    gradleUserHome(),
    "caches",
    "modules-2",
    "files-2.1",
    group,
    module,
    version,
  );
  const exact = path.join(versionDir, artifact.sha1, filename);
  if (fs.existsSync(exact)) return exact;
  try {
    for (const hashDir of fs.readdirSync(versionDir, { withFileTypes: true })) {
      if (!hashDir.isDirectory()) continue;
      const candidate = path.join(versionDir, hashDir.name, filename);
      if (fs.existsSync(candidate) && sha1File(candidate) === artifact.sha1) return candidate;
    }
  } catch {
    // The dependency is not present in Gradle's shared module cache.
  }
  return null;
}

function artifactUrls(artifact: MojangLibraryArtifact): string[] {
  return Array.from(new Set([
    artifact.url,
    `https://maven.aliyun.com/repository/public/${artifact.path}`,
  ].filter(Boolean)));
}

function bmclPackageUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if ((parsed.hostname === "piston-meta.mojang.com" || parsed.hostname === "piston-data.mojang.com") &&
        parsed.pathname.startsWith("/v1/packages/")) {
      return `https://bmclapi2.bangbang93.com${parsed.pathname}`;
    }
  } catch {
    return null;
  }
  return null;
}

function bmclDataUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "piston-data.mojang.com" && parsed.pathname.startsWith("/v1/objects/")) {
      return `https://bmclapi2.bangbang93.com${parsed.pathname}`;
    }
  } catch {
    return null;
  }
  return null;
}

function assetIndexUrls(url: string): string[] {
  return Array.from(new Set([url, bmclPackageUrl(url)].filter((item): item is string => Boolean(item))));
}

function assetObjectUrls(hash: string): string[] {
  const rel = `${hash.slice(0, 2)}/${hash}`;
  return [
    `https://resources.download.minecraft.net/${rel}`,
    `https://bmclapi2.bangbang93.com/assets/${rel}`,
  ];
}

function minecraftAssetsDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), ".minecraft", "assets");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "minecraft", "assets");
  }
  return path.join(os.homedir(), ".minecraft", "assets");
}

function sharedAssetDirs(): string[] {
  return [
    path.join(gradleUserHome(), "caches", "neoformruntime", "assets"),
    path.join(gradleUserHome(), "caches", "fabric-loom", "assets"),
  ];
}

async function linkOrCopyFile(source: string, target: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.rm(target, { force: true }).catch(() => {});
  try {
    await fs.promises.link(source, target);
  } catch {
    await fs.promises.copyFile(source, target);
  }
}

function readMojangVersionJson(cacheDir: string, mcVersion: string): MojangVersionJson | null {
  const versionFile = path.join(cacheDir, "minecraft_tasks", mcVersion, "version.json");
  if (!fs.existsSync(versionFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(versionFile, "utf8")) as MojangVersionJson;
  } catch {
    return null;
  }
}

function currentMojangOs(): string {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "osx";
  return "linux";
}

export function mojangLibraryAppliesToCurrentOs(
  library: NonNullable<MojangVersionJson["libraries"]>[number],
): boolean {
  if (!library.rules?.length) return true;
  let allowed = false;
  for (const rule of library.rules) {
    const osRule = rule.os;
    let matches = true;
    if (osRule?.name && osRule.name !== currentMojangOs()) matches = false;
    if (osRule?.arch) {
      const arches = process.arch === "x64"
        ? ["x64", "x86_64", "amd64"]
        : process.arch === "ia32" ? ["x86", "i386", "ia32"] : [process.arch];
      if (!arches.some((arch) => new RegExp(osRule.arch!, "i").test(arch))) matches = false;
    }
    if (osRule?.version && !new RegExp(osRule.version).test(os.release())) matches = false;
    if (matches) allowed = rule.action === "allow";
  }
  return allowed;
}

function versionManifestUrls(): string[] {
  return [
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
  ];
}

async function fetchVersionManifest(
  cacheDir: string,
  options?: JdkOptions,
): Promise<MojangVersionManifest> {
  const cachedCandidates = [
    path.join(cacheDir, "launcher_manifest.json"),
    path.join(gradleUserHome(), "caches", "fabric-loom", "mojang_versions_manifest.json"),
    path.join(gradleUserHome(), "caches", "neoformruntime", "artifacts", "minecraft_launcher_manifest.json"),
  ];
  for (const candidate of cachedCandidates) {
    try {
      const manifest = JSON.parse(await fs.promises.readFile(candidate, "utf8")) as MojangVersionManifest;
      if (manifest.versions?.length) return manifest;
    } catch {
      // Try the next cache or an upstream endpoint.
    }
  }

  const tmp = path.join(os.tmpdir(), `dmcl-version-manifest-${process.pid}-${Date.now()}.json`);
  let lastErr: Error | null = null;
  try {
    for (const url of versionManifestUrls()) {
      try {
        await downloadUrlToFile(url, tmp, options);
        return JSON.parse(await fs.promises.readFile(tmp, "utf8")) as MojangVersionManifest;
      } catch (err) {
        if (options?.isCancelled?.()) throw err;
        lastErr = err as Error;
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
      }
    }
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
  throw lastErr ?? new Error("Failed to download Minecraft version manifest");
}

export async function ensureForgeMavenizerVersionJson(
  targetDir: string,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<boolean> {
  if (!usesForgeGradle(targetDir)) return false;

  const mcVersion = readMcVersionFromProject(targetDir);
  if (!mcVersion) return false;

  const cacheDir = forgeMavenizerCacheDir();
  const versionDir = path.join(cacheDir, "minecraft_tasks", mcVersion);
  const versionFile = path.join(versionDir, "version.json");
  const markerFile = `${versionFile}.cache`;
  const marker = await fs.promises.readFile(markerFile, "utf8").catch(() => "");
  const cachedSha1 = /^versionjson=([0-9a-f]{40})$/mi.exec(marker)?.[1];
  if (cachedSha1 && sha1File(versionFile) === cachedSha1) {
    const launcherManifest = path.join(cacheDir, "launcher_manifest.json");
    if (fs.existsSync(launcherManifest)) {
      const now = new Date();
      await fs.promises.utimes(launcherManifest, now, now).catch(() => {});
    }
    return false;
  }

  const manifest = await fetchVersionManifest(cacheDir, options);
  const version = manifest.versions?.find((item) => item.id === mcVersion);
  if (!version?.url || !version.sha1) {
    throw new Error(`Minecraft ${mcVersion} is missing from the official version manifest`);
  }

  if (sha1File(versionFile) !== version.sha1) {
    const sharedCandidates = [
      path.join(gradleUserHome(), "caches", "fabric-loom", mcVersion, "mojang_minecraft_info.json"),
    ];
    const reusable = sharedCandidates.find((candidate) => sha1File(candidate) === version.sha1);
    if (reusable) {
      log(`Reusing SHA1-verified Minecraft ${mcVersion} metadata from shared Gradle cache`);
      await fs.promises.mkdir(versionDir, { recursive: true });
      await fs.promises.copyFile(reusable, versionFile);
    }
  }

  if (sha1File(versionFile) !== version.sha1) {
    log(`Prewarming Forge Mavenizer version metadata for Minecraft ${mcVersion}`);
    await downloadVerifiedFile(
      Array.from(new Set([version.url, bmclPackageUrl(version.url)].filter((url): url is string => Boolean(url)))),
      versionFile,
      version.sha1,
      0,
      `Minecraft ${mcVersion} version metadata`,
      options,
    );
  }

  await fs.promises.mkdir(versionDir, { recursive: true });
  await fs.promises.writeFile(markerFile, `versionjson=${version.sha1}\n`, "utf8");
  const launcherManifest = path.join(cacheDir, "launcher_manifest.json");
  if (fs.existsSync(launcherManifest)) {
    const now = new Date();
    await fs.promises.utimes(launcherManifest, now, now).catch(() => {});
  }
  return true;
}

async function prewarmForgeMavenizerVersionFiles(
  cacheDir: string,
  mcVersion: string,
  versionJson: MojangVersionJson,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<void> {
  const versionJsonFile = path.join(cacheDir, "minecraft_tasks", mcVersion, "version.json");
  const versionJsonSha1 = sha1File(versionJsonFile);
  if (!versionJsonSha1) return;

  const extensions: Record<string, string> = {
    client: "jar",
    server: "jar",
    client_mappings: "txt",
    server_mappings: "txt",
  };
  for (const [key, extension] of Object.entries(extensions)) {
    const download = versionJson.downloads?.[key];
    if (!download?.url || !download.sha1) continue;
    const target = path.join(cacheDir, "minecraft_tasks", mcVersion, `${key}.${extension}`);
    if (sha1File(target) !== download.sha1) {
      const loomName = key === "client"
        ? "minecraft-client.jar"
        : key === "server" ? "minecraft-server.jar" : null;
      const shared = loomName
        ? path.join(gradleUserHome(), "caches", "fabric-loom", mcVersion, loomName)
        : null;
      if (shared && sha1File(shared) === download.sha1) {
        log(`Reusing SHA1-verified Minecraft ${mcVersion} ${key} from shared Gradle cache`);
        await linkOrCopyFile(shared, target);
      } else {
        log(`Prewarming Minecraft ${mcVersion} ${key} for Forge Mavenizer`);
        await downloadVerifiedFile(
          Array.from(new Set([download.url, bmclDataUrl(download.url)].filter((url): url is string => Boolean(url)))),
          target,
          download.sha1,
          download.size,
          `Minecraft ${mcVersion} ${key}`,
          options,
        );
      }
    }
    await fs.promises.writeFile(`${target}.cache`, `manifest=${versionJsonSha1}\n`, "utf8");
  }
}

async function downloadVerifiedFile(
  urls: string[],
  dest: string,
  expectedSha1: string,
  expectedSize: number,
  label: string,
  options?: JdkOptions,
): Promise<void> {
  const tmp = `${dest}.dmcl-download`;
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      await downloadUrlToFile(url, tmp, options);
      const actual = sha1File(tmp);
      if (actual !== expectedSha1) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw new Error(`SHA1 mismatch for ${label}: expected ${expectedSha1}, got ${actual ?? "missing"}`);
      }
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.rm(dest, { force: true }).catch(() => {});
      await fs.promises.rm(`${dest}.sha1`, { force: true }).catch(() => {});
      await fs.promises.rename(tmp, dest);
      await fs.promises.writeFile(`${dest}.sha1`, expectedSha1, "utf8");
      return;
    } catch (err) {
      if (options?.isCancelled?.()) throw err;
      lastErr = err as Error;
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
  throw lastErr ?? new Error(`Failed to download ${label}`);
}

async function downloadUrlToFile(
  url: string,
  dest: string,
  options?: JdkOptions,
  redirects = 4,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.rm(dest, { force: true }).catch(() => {});

  return new Promise((resolve, reject) => {
    if (options?.isCancelled?.()) {
      reject(new Error("cancelled"));
      return;
    }

    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const req = client.get(parsed, {
      headers: { "user-agent": UA },
      lookup: resilientLookup,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, parsed).toString();
        downloadUrlToFile(next, dest, options, redirects - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
        return;
      }

      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve()));
      out.on("error", reject);
      res.on("error", reject);
    });

    const cancelTimer = setInterval(() => {
      if (options?.isCancelled?.()) req.destroy(new Error("cancelled"));
    }, 1000);
    req.setTimeout(120_000, () => req.destroy(new Error(`Download timeout: ${url}`)));
    req.on("error", (err) => {
      clearInterval(cancelTimer);
      fs.promises.rm(dest, { force: true }).catch(() => {});
      reject(err);
    });
    req.on("close", () => clearInterval(cancelTimer));
  });
}

async function downloadVerifiedArtifact(
  artifact: MojangLibraryArtifact,
  dest: string,
  options?: JdkOptions,
): Promise<void> {
  const shared = sharedGradleArtifactPath(artifact);
  if (shared && sha1File(shared) === artifact.sha1) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(shared, dest);
    await fs.promises.writeFile(`${dest}.sha1`, artifact.sha1, "utf8");
    return;
  }
  await downloadVerifiedFile(
    artifactUrls(artifact),
    dest,
    artifact.sha1,
    artifact.size,
    artifact.path,
    options,
  );
}

function mavenArtifactPath(coordinate: string): string | null {
  const parts = coordinate.split(":");
  if (parts.length < 3 || parts.length > 4) return null;
  const [group, artifact, version, classifier] = parts;
  const filename = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  return [...group.split("."), artifact, version, filename].join("/");
}

async function resolveRemoteSha1(
  urls: string[],
  options?: JdkOptions,
): Promise<string> {
  const tmp = path.join(os.tmpdir(), `dmcl-sha1-${process.pid}-${Date.now()}.txt`);
  let lastErr: Error | null = null;
  try {
    for (const url of urls) {
      try {
        await downloadUrlToFile(`${url}.sha1`, tmp, options);
        const sha1 = (await fs.promises.readFile(tmp, "utf8")).trim().split(/\s+/)[0].toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error(`Invalid SHA1 response from ${url}.sha1`);
        return sha1;
      } catch (err) {
        lastErr = err as Error;
      }
    }
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
  throw lastErr ?? new Error("Unable to resolve artifact SHA1");
}

export async function prewarmForgeMavenizerMcpTools(
  targetDir: string,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<number> {
  if (!usesForgeGradle(targetDir)) return 0;
  const mcVersion = readMcVersionFromProject(targetDir);
  if (!mcVersion) return 0;

  const cacheDir = forgeMavenizerCacheDir();
  const configRoot = path.join(cacheDir, "maven", "forge", "de", "oceanlabs", "mcp", "mcp_config");
  let configs: string[] = [];
  try {
    for (const version of await fs.promises.readdir(configRoot)) {
      if (!version.startsWith(`${mcVersion}-`)) continue;
      const zip = path.join(configRoot, version, `mcp_config-${version}.zip`);
      if (fs.existsSync(zip)) configs.push(zip);
    }
  } catch {
    return 0;
  }
  configs = configs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (configs.length === 0) return 0;

  let parsed: { functions?: Record<string, { version?: string; repo?: string }> };
  try {
    const entry = new AdmZip(configs[0]).getEntry("config.json");
    if (!entry) return 0;
    parsed = JSON.parse(entry.getData().toString("utf8")) as typeof parsed;
  } catch {
    return 0;
  }

  let downloaded = 0;
  const seen = new Set<string>();
  for (const fn of Object.values(parsed.functions ?? {})) {
    if (!fn.version || !fn.repo || seen.has(fn.version)) continue;
    seen.add(fn.version);
    const relative = mavenArtifactPath(fn.version);
    if (!relative) continue;
    const destination = path.join(cacheDir, "maven", "mcp-tools", ...relative.split("/"));
    if (fs.existsSync(destination) && fs.existsSync(`${destination}.sha1`)) continue;

    const bases = Array.from(new Set([
      fn.repo.endsWith("/") ? fn.repo : `${fn.repo}/`,
      "https://maven.aliyun.com/repository/public/",
      "https://repo.maven.apache.org/maven2/",
    ]));
    const urls = bases.map((base) => `${base}${relative}`);
    const expectedSha1 = await resolveRemoteSha1(urls, options);
    log(`Prewarming Forge Mavenizer MCP tool ${fn.version}`);
    await downloadVerifiedFile(urls, destination, expectedSha1, 0, fn.version, options);
    downloaded++;
  }
  return downloaded;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

export async function prewarmForgeMavenizerLibraries(
  targetDir: string,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<{ total: number; cached: number; downloaded: number; missing: number }> {
  if (!usesForgeGradle(targetDir)) return { total: 0, cached: 0, downloaded: 0, missing: 0 };

  const mcVersion = readMcVersionFromProject(targetDir);
  if (!mcVersion) return { total: 0, cached: 0, downloaded: 0, missing: 0 };

  const cacheDir = forgeMavenizerCacheDir();
  await ensureForgeMavenizerVersionJson(targetDir, log, options);
  const versionJson = readMojangVersionJson(cacheDir, mcVersion);
  if (!versionJson?.libraries) return { total: 0, cached: 0, downloaded: 0, missing: 0 };
  await prewarmForgeMavenizerVersionFiles(cacheDir, mcVersion, versionJson, log, options);

  const artifacts = versionJson.libraries
    .filter(mojangLibraryAppliesToCurrentOs)
    .map((lib) => lib.downloads?.artifact)
    .filter((artifact): artifact is MojangLibraryArtifact => Boolean(
      artifact?.path && artifact.sha1 && artifact.url,
    ));
  let cached = 0;
  const missing = artifacts.filter((artifact) => {
    const dest = artifactCachePath(cacheDir, artifact.path);
    if (sha1File(dest) === artifact.sha1) {
      if (!fs.existsSync(`${dest}.sha1`)) fs.writeFileSync(`${dest}.sha1`, artifact.sha1, "utf8");
      cached++;
      return false;
    }
    return true;
  });

  if (missing.length === 0) return { total: artifacts.length, cached, downloaded: 0, missing: 0 };

  log(`Prewarming ${missing.length} Forge Mavenizer Minecraft libraries`);
  let downloaded = 0;
  await runPool(missing, 4, async (artifact) => {
    throwIfCancelled(options);
    await downloadVerifiedArtifact(artifact, artifactCachePath(cacheDir, artifact.path), options);
    downloaded++;
    if (downloaded === missing.length || downloaded % 10 === 0) {
      log(`Forge Mavenizer library cache ${downloaded}/${missing.length}`);
    }
  });

  return {
    total: artifacts.length,
    cached,
    downloaded,
    missing: missing.length - downloaded,
  };
}

export async function prewarmForgeSlimeLauncherAssets(
  targetDir: string,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<{ total: number; cached: number; downloaded: number; missing: number }> {
  if (!usesForgeGradle(targetDir)) return { total: 0, cached: 0, downloaded: 0, missing: 0 };

  const mcVersion = readMcVersionFromProject(targetDir);
  if (!mcVersion) return { total: 0, cached: 0, downloaded: 0, missing: 0 };

  const versionJson = readMojangVersionJson(forgeMavenizerCacheDir(), mcVersion);
  const assetIndex = versionJson?.assetIndex;
  if (!assetIndex?.id || !assetIndex.sha1 || !assetIndex.url) {
    return { total: 0, cached: 0, downloaded: 0, missing: 0 };
  }

  const assetsDir = minecraftAssetsDir();
  const indexFile = path.join(assetsDir, "indexes", `${assetIndex.id}.json`);
  if (sha1File(indexFile) !== assetIndex.sha1) {
    const archivedIndex = path.join(
      forgeMavenizerCacheDir(),
      "asset_indexes",
      `${assetIndex.sha1}.json`,
    );
    const sharedIndex = [archivedIndex, ...sharedAssetDirs()
      .map((dir) => path.join(dir, "indexes", `${assetIndex.id}.json`))]
      .find((candidate) => sha1File(candidate) === assetIndex.sha1);
    if (sharedIndex) {
      log(`Reusing SHA1-verified Minecraft assets index ${assetIndex.id}`);
      await fs.promises.mkdir(path.dirname(archivedIndex), { recursive: true });
      if (sharedIndex !== archivedIndex) await fs.promises.copyFile(sharedIndex, archivedIndex);
      await fs.promises.mkdir(path.dirname(indexFile), { recursive: true });
      await fs.promises.copyFile(archivedIndex, indexFile);
    } else {
      log(`Prewarming Forge Slime Launcher assets index ${assetIndex.id}`);
      await downloadVerifiedFile(
        assetIndexUrls(assetIndex.url),
        indexFile,
        assetIndex.sha1,
        assetIndex.size,
        `assets index ${assetIndex.id}`,
        options,
      );
      await fs.promises.mkdir(path.dirname(archivedIndex), { recursive: true });
      await fs.promises.copyFile(indexFile, archivedIndex);
    }
  }

  let index: MojangAssetsIndex;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as MojangAssetsIndex;
  } catch {
    return { total: 0, cached: 0, downloaded: 0, missing: 0 };
  }

  const objects = Object.values(index.objects ?? {});
  let cached = 0;
  const missing = objects.filter((asset) => {
    const dest = path.join(assetsDir, "objects", asset.hash.slice(0, 2), asset.hash);
    if (fs.existsSync(dest) && fs.statSync(dest).size === asset.size) {
      cached++;
      return false;
    }
    return true;
  });

  if (missing.length === 0) return { total: objects.length, cached, downloaded: 0, missing: 0 };

  log(`Prewarming ${missing.length} Forge Slime Launcher assets`);
  let downloaded = 0;
  await runPool(missing, 8, async (asset) => {
    throwIfCancelled(options);
    const dest = path.join(assetsDir, "objects", asset.hash.slice(0, 2), asset.hash);
    const shared = sharedAssetDirs()
      .map((dir) => path.join(dir, "objects", asset.hash.slice(0, 2), asset.hash))
      .find((candidate) => {
        try {
          return fs.statSync(candidate).size === asset.size && sha1File(candidate) === asset.hash;
        } catch {
          return false;
        }
      });
    if (shared) {
      await linkOrCopyFile(shared, dest);
    } else {
      await downloadVerifiedFile(
        assetObjectUrls(asset.hash),
        dest,
        asset.hash,
        asset.size,
        `asset ${asset.hash}`,
        options,
      );
    }
    downloaded++;
    if (downloaded === missing.length || downloaded % 100 === 0) {
      log(`Forge Slime Launcher asset cache ${downloaded}/${missing.length}`);
    }
  });

  return {
    total: objects.length,
    cached,
    downloaded,
    missing: missing.length - downloaded,
  };
}

async function ensureCachedAuxJdk(log: JdkLogger, options?: JdkOptions): Promise<string> {
  return ensureJdkInCache(AUX_JDK_MAJOR, log, options);
}

async function linkOrCopyJdk(source: string, target: string): Promise<"linked" | "copied"> {
  try {
    await fs.promises.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    return "linked";
  } catch {
    await fs.promises.cp(source, target, { recursive: true });
    return "copied";
  }
}

export async function ensureForgeMavenizerJdkCache(
  targetDir: string,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<void> {
  if (!usesForgeGradle(targetDir)) return;

  const jdkPath = await ensureCachedAuxJdk(log, options);
  const cacheDir = forgeMavenizerCacheDir();
  const target = path.join(cacheDir, DMCL_MAVENIZER_JDK_DIR);

  if (detectJavaMajorAt(target) === AUX_JDK_MAJOR && fs.existsSync(javaExe(target))) {
    log(`Forge Mavenizer auxiliary JDK ${AUX_JDK_MAJOR} is ready: ${target}`);
    await prewarmForgeMavenizerLibraries(targetDir, log, options);
    return;
  }

  if (!isChildOf(cacheDir, target)) {
    throw new Error(`Refusing to update Forge Mavenizer JDK outside cache: ${target}`);
  }

  await fs.promises.mkdir(cacheDir, { recursive: true });
  await fs.promises.rm(target, { recursive: true, force: true });
  const mode = await linkOrCopyJdk(jdkPath, target);

  if (detectJavaMajorAt(target) !== AUX_JDK_MAJOR) {
    throw new Error(`Forge Mavenizer auxiliary JDK ${AUX_JDK_MAJOR} was not installed correctly: ${target}`);
  }

  log(`Forge Mavenizer auxiliary JDK ${AUX_JDK_MAJOR} ${mode}: ${target}`);
  await prewarmForgeMavenizerLibraries(targetDir, log, options);
}
