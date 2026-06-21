"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.usesForgeGradle = usesForgeGradle;
exports.gradleUserHome = gradleUserHome;
exports.forgeMavenizerCacheDir = forgeMavenizerCacheDir;
exports.mojangLibraryAppliesToCurrentOs = mojangLibraryAppliesToCurrentOs;
exports.ensureForgeMavenizerVersionJson = ensureForgeMavenizerVersionJson;
exports.prewarmForgeMavenizerMcpTools = prewarmForgeMavenizerMcpTools;
exports.prewarmForgeMavenizerLibraries = prewarmForgeMavenizerLibraries;
exports.prewarmForgeSlimeLauncherAssets = prewarmForgeSlimeLauncherAssets;
exports.ensureForgeMavenizerJdkCache = ensureForgeMavenizerJdkCache;
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_dns_1 = __importDefault(require("node:dns"));
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const adm_zip_1 = __importDefault(require("adm-zip"));
const jdk_js_1 = require("./jdk.js");
const http_js_1 = require("./http.js");
const gradle_js_1 = require("./gradle.js");
const AUX_JDK_MAJOR = 8;
const DMCL_MAVENIZER_JDK_DIR = "dmcl-jdk8";
const fallbackResolver = new node_dns_1.default.Resolver();
fallbackResolver.setServers(["1.1.1.1", "8.8.8.8"]);
const resilientLookup = (hostname, options, callback) => {
    let pending = 2;
    let settled = false;
    let lastError = null;
    const fail = (err) => {
        lastError = err;
        pending--;
        if (!settled && pending === 0)
            callback(lastError, "", 0);
    };
    const succeed = (addresses) => {
        if (settled || addresses.length === 0)
            return;
        settled = true;
        if (options.all)
            callback(null, addresses);
        else
            callback(null, addresses[0].address, addresses[0].family);
    };
    node_dns_1.default.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err)
            fail(err);
        else
            succeed(addresses);
    });
    fallbackResolver.resolve4(hostname, (err, addresses) => {
        if (err)
            fail(err);
        else
            succeed(addresses.map((address) => ({ address, family: 4 })));
    });
};
function throwIfCancelled(options) {
    if (options?.isCancelled?.())
        throw new Error("cancelled");
}
function javaExe(javaHome) {
    return node_path_1.default.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
}
function sha1File(file) {
    try {
        const hash = node_crypto_1.default.createHash("sha1");
        hash.update(node_fs_1.default.readFileSync(file));
        return hash.digest("hex");
    }
    catch {
        return null;
    }
}
function normalize(p) {
    const resolved = node_path_1.default.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function isChildOf(parent, child) {
    const p = normalize(parent);
    const c = normalize(child);
    return c === p || c.startsWith(p + node_path_1.default.sep);
}
function usesForgeGradle(targetDir) {
    const buildFile = node_path_1.default.join(targetDir, "build.gradle");
    if (!node_fs_1.default.existsSync(buildFile))
        return false;
    const content = node_fs_1.default.readFileSync(buildFile, "utf8");
    return /net\.minecraftforge\.gradle|minecraft\.dependency\(['"]net\.minecraftforge:forge/.test(content);
}
function gradleUserHome() {
    return (0, gradle_js_1.getIsolatedGradleHome)();
}
function forgeMavenizerCacheDir() {
    return node_path_1.default.join(gradleUserHome(), "caches", "minecraftforge", "forgegradle", "mavenizer", "caches");
}
function artifactCachePath(cacheDir, artifactPath) {
    return node_path_1.default.join(cacheDir, "maven", "mojang", ...artifactPath.split("/"));
}
function sharedGradleArtifactPath(artifact) {
    const parts = artifact.path.split("/");
    if (parts.length < 4)
        return null;
    const filename = parts.at(-1);
    const version = parts.at(-2);
    const module = parts.at(-3);
    const group = parts.slice(0, -3).join(".");
    const versionDir = node_path_1.default.join(gradleUserHome(), "caches", "modules-2", "files-2.1", group, module, version);
    const exact = node_path_1.default.join(versionDir, artifact.sha1, filename);
    if (node_fs_1.default.existsSync(exact))
        return exact;
    try {
        for (const hashDir of node_fs_1.default.readdirSync(versionDir, { withFileTypes: true })) {
            if (!hashDir.isDirectory())
                continue;
            const candidate = node_path_1.default.join(versionDir, hashDir.name, filename);
            if (node_fs_1.default.existsSync(candidate) && sha1File(candidate) === artifact.sha1)
                return candidate;
        }
    }
    catch {
        // The dependency is not present in Gradle's shared module cache.
    }
    return null;
}
function artifactUrls(artifact) {
    return Array.from(new Set([
        artifact.url,
        `https://maven.aliyun.com/repository/public/${artifact.path}`,
    ].filter(Boolean)));
}
function bmclPackageUrl(url) {
    try {
        const parsed = new URL(url);
        if ((parsed.hostname === "piston-meta.mojang.com" || parsed.hostname === "piston-data.mojang.com") &&
            parsed.pathname.startsWith("/v1/packages/")) {
            return `https://bmclapi2.bangbang93.com${parsed.pathname}`;
        }
    }
    catch {
        return null;
    }
    return null;
}
function bmclDataUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === "piston-data.mojang.com" && parsed.pathname.startsWith("/v1/objects/")) {
            return `https://bmclapi2.bangbang93.com${parsed.pathname}`;
        }
    }
    catch {
        return null;
    }
    return null;
}
function assetIndexUrls(url) {
    return Array.from(new Set([url, bmclPackageUrl(url)].filter((item) => Boolean(item))));
}
function assetObjectUrls(hash) {
    const rel = `${hash.slice(0, 2)}/${hash}`;
    return [
        `https://resources.download.minecraft.net/${rel}`,
        `https://bmclapi2.bangbang93.com/assets/${rel}`,
    ];
}
function minecraftAssetsDir() {
    if (process.platform === "win32") {
        return node_path_1.default.join(process.env.APPDATA ?? node_path_1.default.join(node_os_1.default.homedir(), "AppData", "Roaming"), ".minecraft", "assets");
    }
    if (process.platform === "darwin") {
        return node_path_1.default.join(node_os_1.default.homedir(), "Library", "Application Support", "minecraft", "assets");
    }
    return node_path_1.default.join(node_os_1.default.homedir(), ".minecraft", "assets");
}
function sharedAssetDirs() {
    return [
        node_path_1.default.join(gradleUserHome(), "caches", "neoformruntime", "assets"),
        node_path_1.default.join(gradleUserHome(), "caches", "fabric-loom", "assets"),
    ];
}
async function linkOrCopyFile(source, target) {
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(target), { recursive: true });
    await node_fs_1.default.promises.rm(target, { force: true }).catch(() => { });
    try {
        await node_fs_1.default.promises.link(source, target);
    }
    catch {
        await node_fs_1.default.promises.copyFile(source, target);
    }
}
function readMojangVersionJson(cacheDir, mcVersion) {
    const versionFile = node_path_1.default.join(cacheDir, "minecraft_tasks", mcVersion, "version.json");
    if (!node_fs_1.default.existsSync(versionFile))
        return null;
    try {
        return JSON.parse(node_fs_1.default.readFileSync(versionFile, "utf8"));
    }
    catch {
        return null;
    }
}
function currentMojangOs() {
    if (process.platform === "win32")
        return "windows";
    if (process.platform === "darwin")
        return "osx";
    return "linux";
}
function mojangLibraryAppliesToCurrentOs(library) {
    if (!library.rules?.length)
        return true;
    let allowed = false;
    for (const rule of library.rules) {
        const osRule = rule.os;
        let matches = true;
        if (osRule?.name && osRule.name !== currentMojangOs())
            matches = false;
        if (osRule?.arch) {
            const arches = process.arch === "x64"
                ? ["x64", "x86_64", "amd64"]
                : process.arch === "ia32" ? ["x86", "i386", "ia32"] : [process.arch];
            if (!arches.some((arch) => new RegExp(osRule.arch, "i").test(arch)))
                matches = false;
        }
        if (osRule?.version && !new RegExp(osRule.version).test(node_os_1.default.release()))
            matches = false;
        if (matches)
            allowed = rule.action === "allow";
    }
    return allowed;
}
function versionManifestUrls() {
    return [
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
        "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
    ];
}
async function fetchVersionManifest(cacheDir, options) {
    const cachedCandidates = [
        node_path_1.default.join(cacheDir, "launcher_manifest.json"),
        node_path_1.default.join(gradleUserHome(), "caches", "fabric-loom", "mojang_versions_manifest.json"),
        node_path_1.default.join(gradleUserHome(), "caches", "neoformruntime", "artifacts", "minecraft_launcher_manifest.json"),
    ];
    for (const candidate of cachedCandidates) {
        try {
            const manifest = JSON.parse(await node_fs_1.default.promises.readFile(candidate, "utf8"));
            if (manifest.versions?.length)
                return manifest;
        }
        catch {
            // Try the next cache or an upstream endpoint.
        }
    }
    const tmp = node_path_1.default.join(node_os_1.default.tmpdir(), `dmcl-version-manifest-${process.pid}-${Date.now()}.json`);
    let lastErr = null;
    try {
        for (const url of versionManifestUrls()) {
            try {
                await downloadUrlToFile(url, tmp, options);
                return JSON.parse(await node_fs_1.default.promises.readFile(tmp, "utf8"));
            }
            catch (err) {
                if (options?.isCancelled?.())
                    throw err;
                lastErr = err;
                await node_fs_1.default.promises.rm(tmp, { force: true }).catch(() => { });
            }
        }
    }
    finally {
        await node_fs_1.default.promises.rm(tmp, { force: true }).catch(() => { });
    }
    throw lastErr ?? new Error("Failed to download Minecraft version manifest");
}
async function ensureForgeMavenizerVersionJson(targetDir, log, options) {
    if (!usesForgeGradle(targetDir))
        return false;
    const mcVersion = (0, jdk_js_1.readMcVersionFromProject)(targetDir);
    if (!mcVersion)
        return false;
    const cacheDir = forgeMavenizerCacheDir();
    const versionDir = node_path_1.default.join(cacheDir, "minecraft_tasks", mcVersion);
    const versionFile = node_path_1.default.join(versionDir, "version.json");
    const markerFile = `${versionFile}.cache`;
    const marker = await node_fs_1.default.promises.readFile(markerFile, "utf8").catch(() => "");
    const cachedSha1 = /^versionjson=([0-9a-f]{40})$/mi.exec(marker)?.[1];
    if (cachedSha1 && sha1File(versionFile) === cachedSha1) {
        const launcherManifest = node_path_1.default.join(cacheDir, "launcher_manifest.json");
        if (node_fs_1.default.existsSync(launcherManifest)) {
            const now = new Date();
            await node_fs_1.default.promises.utimes(launcherManifest, now, now).catch(() => { });
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
            node_path_1.default.join(gradleUserHome(), "caches", "fabric-loom", mcVersion, "mojang_minecraft_info.json"),
        ];
        const reusable = sharedCandidates.find((candidate) => sha1File(candidate) === version.sha1);
        if (reusable) {
            log(`Reusing SHA1-verified Minecraft ${mcVersion} metadata from shared Gradle cache`);
            await node_fs_1.default.promises.mkdir(versionDir, { recursive: true });
            await node_fs_1.default.promises.copyFile(reusable, versionFile);
        }
    }
    if (sha1File(versionFile) !== version.sha1) {
        log(`Prewarming Forge Mavenizer version metadata for Minecraft ${mcVersion}`);
        await downloadVerifiedFile(Array.from(new Set([version.url, bmclPackageUrl(version.url)].filter((url) => Boolean(url)))), versionFile, version.sha1, 0, `Minecraft ${mcVersion} version metadata`, options);
    }
    await node_fs_1.default.promises.mkdir(versionDir, { recursive: true });
    await node_fs_1.default.promises.writeFile(markerFile, `versionjson=${version.sha1}\n`, "utf8");
    const launcherManifest = node_path_1.default.join(cacheDir, "launcher_manifest.json");
    if (node_fs_1.default.existsSync(launcherManifest)) {
        const now = new Date();
        await node_fs_1.default.promises.utimes(launcherManifest, now, now).catch(() => { });
    }
    return true;
}
async function prewarmForgeMavenizerVersionFiles(cacheDir, mcVersion, versionJson, log, options) {
    const versionJsonFile = node_path_1.default.join(cacheDir, "minecraft_tasks", mcVersion, "version.json");
    const versionJsonSha1 = sha1File(versionJsonFile);
    if (!versionJsonSha1)
        return;
    const extensions = {
        client: "jar",
        server: "jar",
        client_mappings: "txt",
        server_mappings: "txt",
    };
    for (const [key, extension] of Object.entries(extensions)) {
        const download = versionJson.downloads?.[key];
        if (!download?.url || !download.sha1)
            continue;
        const target = node_path_1.default.join(cacheDir, "minecraft_tasks", mcVersion, `${key}.${extension}`);
        if (sha1File(target) !== download.sha1) {
            const loomName = key === "client"
                ? "minecraft-client.jar"
                : key === "server" ? "minecraft-server.jar" : null;
            const shared = loomName
                ? node_path_1.default.join(gradleUserHome(), "caches", "fabric-loom", mcVersion, loomName)
                : null;
            if (shared && sha1File(shared) === download.sha1) {
                log(`Reusing SHA1-verified Minecraft ${mcVersion} ${key} from shared Gradle cache`);
                await linkOrCopyFile(shared, target);
            }
            else {
                log(`Prewarming Minecraft ${mcVersion} ${key} for Forge Mavenizer`);
                await downloadVerifiedFile(Array.from(new Set([download.url, bmclDataUrl(download.url)].filter((url) => Boolean(url)))), target, download.sha1, download.size, `Minecraft ${mcVersion} ${key}`, options);
            }
        }
        await node_fs_1.default.promises.writeFile(`${target}.cache`, `manifest=${versionJsonSha1}\n`, "utf8");
    }
}
async function downloadVerifiedFile(urls, dest, expectedSha1, expectedSize, label, options) {
    const tmp = `${dest}.dmcl-download`;
    let lastErr = null;
    for (const url of urls) {
        try {
            await downloadUrlToFile(url, tmp, options);
            const actual = sha1File(tmp);
            if (actual !== expectedSha1) {
                await node_fs_1.default.promises.rm(tmp, { force: true }).catch(() => { });
                throw new Error(`SHA1 mismatch for ${label}: expected ${expectedSha1}, got ${actual ?? "missing"}`);
            }
            await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(dest), { recursive: true });
            await node_fs_1.default.promises.rm(dest, { force: true }).catch(() => { });
            await node_fs_1.default.promises.rm(`${dest}.sha1`, { force: true }).catch(() => { });
            await node_fs_1.default.promises.rename(tmp, dest);
            await node_fs_1.default.promises.writeFile(`${dest}.sha1`, expectedSha1, "utf8");
            return;
        }
        catch (err) {
            if (options?.isCancelled?.())
                throw err;
            lastErr = err;
            await node_fs_1.default.promises.rm(tmp, { force: true }).catch(() => { });
        }
    }
    throw lastErr ?? new Error(`Failed to download ${label}`);
}
async function downloadUrlToFile(url, dest, options, redirects = 4) {
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(dest), { recursive: true });
    await node_fs_1.default.promises.rm(dest, { force: true }).catch(() => { });
    return new Promise((resolve, reject) => {
        if (options?.isCancelled?.()) {
            reject(new Error("cancelled"));
            return;
        }
        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? node_http_1.default : node_https_1.default;
        const req = client.get(parsed, {
            headers: { "user-agent": http_js_1.UA },
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
            const out = node_fs_1.default.createWriteStream(dest);
            res.pipe(out);
            out.on("finish", () => out.close(() => resolve()));
            out.on("error", reject);
            res.on("error", reject);
        });
        const cancelTimer = setInterval(() => {
            if (options?.isCancelled?.())
                req.destroy(new Error("cancelled"));
        }, 1000);
        req.setTimeout(120_000, () => req.destroy(new Error(`Download timeout: ${url}`)));
        req.on("error", (err) => {
            clearInterval(cancelTimer);
            node_fs_1.default.promises.rm(dest, { force: true }).catch(() => { });
            reject(err);
        });
        req.on("close", () => clearInterval(cancelTimer));
    });
}
async function downloadVerifiedArtifact(artifact, dest, options) {
    const shared = sharedGradleArtifactPath(artifact);
    if (shared && sha1File(shared) === artifact.sha1) {
        await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(dest), { recursive: true });
        await node_fs_1.default.promises.copyFile(shared, dest);
        await node_fs_1.default.promises.writeFile(`${dest}.sha1`, artifact.sha1, "utf8");
        return;
    }
    await downloadVerifiedFile(artifactUrls(artifact), dest, artifact.sha1, artifact.size, artifact.path, options);
}
function mavenArtifactPath(coordinate) {
    const parts = coordinate.split(":");
    if (parts.length < 3 || parts.length > 4)
        return null;
    const [group, artifact, version, classifier] = parts;
    const filename = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
    return [...group.split("."), artifact, version, filename].join("/");
}
async function resolveRemoteSha1(urls, options) {
    const tmp = node_path_1.default.join(node_os_1.default.tmpdir(), `dmcl-sha1-${process.pid}-${Date.now()}.txt`);
    let lastErr = null;
    try {
        for (const url of urls) {
            try {
                await downloadUrlToFile(`${url}.sha1`, tmp, options);
                const sha1 = (await node_fs_1.default.promises.readFile(tmp, "utf8")).trim().split(/\s+/)[0].toLowerCase();
                if (!/^[0-9a-f]{40}$/.test(sha1))
                    throw new Error(`Invalid SHA1 response from ${url}.sha1`);
                return sha1;
            }
            catch (err) {
                lastErr = err;
            }
        }
    }
    finally {
        await node_fs_1.default.promises.rm(tmp, { force: true }).catch(() => { });
    }
    throw lastErr ?? new Error("Unable to resolve artifact SHA1");
}
async function prewarmForgeMavenizerMcpTools(targetDir, log, options) {
    if (!usesForgeGradle(targetDir))
        return 0;
    const mcVersion = (0, jdk_js_1.readMcVersionFromProject)(targetDir);
    if (!mcVersion)
        return 0;
    const cacheDir = forgeMavenizerCacheDir();
    const configRoot = node_path_1.default.join(cacheDir, "maven", "forge", "de", "oceanlabs", "mcp", "mcp_config");
    let configs = [];
    try {
        for (const version of await node_fs_1.default.promises.readdir(configRoot)) {
            if (!version.startsWith(`${mcVersion}-`))
                continue;
            const zip = node_path_1.default.join(configRoot, version, `mcp_config-${version}.zip`);
            if (node_fs_1.default.existsSync(zip))
                configs.push(zip);
        }
    }
    catch {
        return 0;
    }
    configs = configs.sort((a, b) => node_fs_1.default.statSync(b).mtimeMs - node_fs_1.default.statSync(a).mtimeMs);
    if (configs.length === 0)
        return 0;
    let parsed;
    try {
        const entry = new adm_zip_1.default(configs[0]).getEntry("config.json");
        if (!entry)
            return 0;
        parsed = JSON.parse(entry.getData().toString("utf8"));
    }
    catch {
        return 0;
    }
    let downloaded = 0;
    const seen = new Set();
    for (const fn of Object.values(parsed.functions ?? {})) {
        if (!fn.version || !fn.repo || seen.has(fn.version))
            continue;
        seen.add(fn.version);
        const relative = mavenArtifactPath(fn.version);
        if (!relative)
            continue;
        const destination = node_path_1.default.join(cacheDir, "maven", "mcp-tools", ...relative.split("/"));
        if (node_fs_1.default.existsSync(destination) && node_fs_1.default.existsSync(`${destination}.sha1`))
            continue;
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
async function runPool(items, concurrency, worker) {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await worker(items[index], index);
        }
    });
    await Promise.all(workers);
}
async function prewarmForgeMavenizerLibraries(targetDir, log, options) {
    if (!usesForgeGradle(targetDir))
        return { total: 0, cached: 0, downloaded: 0, missing: 0 };
    const mcVersion = (0, jdk_js_1.readMcVersionFromProject)(targetDir);
    if (!mcVersion)
        return { total: 0, cached: 0, downloaded: 0, missing: 0 };
    const cacheDir = forgeMavenizerCacheDir();
    await ensureForgeMavenizerVersionJson(targetDir, log, options);
    const versionJson = readMojangVersionJson(cacheDir, mcVersion);
    if (!versionJson?.libraries)
        return { total: 0, cached: 0, downloaded: 0, missing: 0 };
    await prewarmForgeMavenizerVersionFiles(cacheDir, mcVersion, versionJson, log, options);
    const artifacts = versionJson.libraries
        .filter(mojangLibraryAppliesToCurrentOs)
        .map((lib) => lib.downloads?.artifact)
        .filter((artifact) => Boolean(artifact?.path && artifact.sha1 && artifact.url));
    let cached = 0;
    const missing = artifacts.filter((artifact) => {
        const dest = artifactCachePath(cacheDir, artifact.path);
        if (sha1File(dest) === artifact.sha1) {
            if (!node_fs_1.default.existsSync(`${dest}.sha1`))
                node_fs_1.default.writeFileSync(`${dest}.sha1`, artifact.sha1, "utf8");
            cached++;
            return false;
        }
        return true;
    });
    if (missing.length === 0)
        return { total: artifacts.length, cached, downloaded: 0, missing: 0 };
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
async function prewarmForgeSlimeLauncherAssets(targetDir, log, options) {
    if (!usesForgeGradle(targetDir))
        return { total: 0, cached: 0, downloaded: 0, missing: 0 };
    const mcVersion = (0, jdk_js_1.readMcVersionFromProject)(targetDir);
    if (!mcVersion)
        return { total: 0, cached: 0, downloaded: 0, missing: 0 };
    const versionJson = readMojangVersionJson(forgeMavenizerCacheDir(), mcVersion);
    const assetIndex = versionJson?.assetIndex;
    if (!assetIndex?.id || !assetIndex.sha1 || !assetIndex.url) {
        return { total: 0, cached: 0, downloaded: 0, missing: 0 };
    }
    const assetsDir = minecraftAssetsDir();
    const indexFile = node_path_1.default.join(assetsDir, "indexes", `${assetIndex.id}.json`);
    if (sha1File(indexFile) !== assetIndex.sha1) {
        const archivedIndex = node_path_1.default.join(forgeMavenizerCacheDir(), "asset_indexes", `${assetIndex.sha1}.json`);
        const sharedIndex = [archivedIndex, ...sharedAssetDirs()
                .map((dir) => node_path_1.default.join(dir, "indexes", `${assetIndex.id}.json`))]
            .find((candidate) => sha1File(candidate) === assetIndex.sha1);
        if (sharedIndex) {
            log(`Reusing SHA1-verified Minecraft assets index ${assetIndex.id}`);
            await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(archivedIndex), { recursive: true });
            if (sharedIndex !== archivedIndex)
                await node_fs_1.default.promises.copyFile(sharedIndex, archivedIndex);
            await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(indexFile), { recursive: true });
            await node_fs_1.default.promises.copyFile(archivedIndex, indexFile);
        }
        else {
            log(`Prewarming Forge Slime Launcher assets index ${assetIndex.id}`);
            await downloadVerifiedFile(assetIndexUrls(assetIndex.url), indexFile, assetIndex.sha1, assetIndex.size, `assets index ${assetIndex.id}`, options);
            await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(archivedIndex), { recursive: true });
            await node_fs_1.default.promises.copyFile(indexFile, archivedIndex);
        }
    }
    let index;
    try {
        index = JSON.parse(node_fs_1.default.readFileSync(indexFile, "utf8"));
    }
    catch {
        return { total: 0, cached: 0, downloaded: 0, missing: 0 };
    }
    const objects = Object.values(index.objects ?? {});
    let cached = 0;
    const missing = objects.filter((asset) => {
        const dest = node_path_1.default.join(assetsDir, "objects", asset.hash.slice(0, 2), asset.hash);
        if (node_fs_1.default.existsSync(dest) && node_fs_1.default.statSync(dest).size === asset.size) {
            cached++;
            return false;
        }
        return true;
    });
    if (missing.length === 0)
        return { total: objects.length, cached, downloaded: 0, missing: 0 };
    log(`Prewarming ${missing.length} Forge Slime Launcher assets`);
    let downloaded = 0;
    await runPool(missing, 8, async (asset) => {
        throwIfCancelled(options);
        const dest = node_path_1.default.join(assetsDir, "objects", asset.hash.slice(0, 2), asset.hash);
        const shared = sharedAssetDirs()
            .map((dir) => node_path_1.default.join(dir, "objects", asset.hash.slice(0, 2), asset.hash))
            .find((candidate) => {
            try {
                return node_fs_1.default.statSync(candidate).size === asset.size && sha1File(candidate) === asset.hash;
            }
            catch {
                return false;
            }
        });
        if (shared) {
            await linkOrCopyFile(shared, dest);
        }
        else {
            await downloadVerifiedFile(assetObjectUrls(asset.hash), dest, asset.hash, asset.size, `asset ${asset.hash}`, options);
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
async function ensureCachedAuxJdk(log, options) {
    return (0, jdk_js_1.ensureJdkInCache)(AUX_JDK_MAJOR, log, options);
}
async function linkOrCopyJdk(source, target) {
    try {
        await node_fs_1.default.promises.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
        return "linked";
    }
    catch {
        await node_fs_1.default.promises.cp(source, target, { recursive: true });
        return "copied";
    }
}
async function ensureForgeMavenizerJdkCache(targetDir, log, options) {
    if (!usesForgeGradle(targetDir))
        return;
    const jdkPath = await ensureCachedAuxJdk(log, options);
    const cacheDir = forgeMavenizerCacheDir();
    const target = node_path_1.default.join(cacheDir, DMCL_MAVENIZER_JDK_DIR);
    if ((0, jdk_js_1.detectJavaMajorAt)(target) === AUX_JDK_MAJOR && node_fs_1.default.existsSync(javaExe(target))) {
        log(`Forge Mavenizer auxiliary JDK ${AUX_JDK_MAJOR} is ready: ${target}`);
        await prewarmForgeMavenizerLibraries(targetDir, log, options);
        return;
    }
    if (!isChildOf(cacheDir, target)) {
        throw new Error(`Refusing to update Forge Mavenizer JDK outside cache: ${target}`);
    }
    await node_fs_1.default.promises.mkdir(cacheDir, { recursive: true });
    await node_fs_1.default.promises.rm(target, { recursive: true, force: true });
    const mode = await linkOrCopyJdk(jdkPath, target);
    if ((0, jdk_js_1.detectJavaMajorAt)(target) !== AUX_JDK_MAJOR) {
        throw new Error(`Forge Mavenizer auxiliary JDK ${AUX_JDK_MAJOR} was not installed correctly: ${target}`);
    }
    log(`Forge Mavenizer auxiliary JDK ${AUX_JDK_MAJOR} ${mode}: ${target}`);
    await prewarmForgeMavenizerLibraries(targetDir, log, options);
}
