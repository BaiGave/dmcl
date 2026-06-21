"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requiredJavaFor = requiredJavaFor;
exports.detectJavaMajor = detectJavaMajor;
exports.detectJavaMajorAt = detectJavaMajorAt;
exports.readJavaHomeFromProject = readJavaHomeFromProject;
exports.effectiveJvmMajor = effectiveJvmMajor;
exports.readGradleVersion = readGradleVersion;
exports.gradleJvmRange = gradleJvmRange;
exports.readMcVersionFromProject = readMcVersionFromProject;
exports.readLoomVersion = readLoomVersion;
exports.loomMinJvm = loomMinJvm;
exports.usesForgeGradleLegacy = usesForgeGradleLegacy;
exports.pickJdkMajor = pickJdkMajor;
exports.isJvmCompatible = isJvmCompatible;
exports.downloadAndInjectJdk = downloadAndInjectJdk;
exports.resolveProjectJdkNeed = resolveProjectJdkNeed;
exports.projectJdkIsReady = projectJdkIsReady;
exports.ensureProjectJdk = ensureProjectJdk;
exports.fetchJdkDownloadUrl = fetchJdkDownloadUrl;
exports.jdkMirrorUrl = jdkMirrorUrl;
exports.downloadWithFallback = downloadWithFallback;
exports.downloadWithProgress = downloadWithProgress;
exports.findCachedJdk = findCachedJdk;
exports.ensureJdkInCache = ensureJdkInCache;
exports.extractJdk = extractJdk;
exports.injectJdkHome = injectJdkHome;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const adm_zip_1 = __importDefault(require("adm-zip"));
const http_js_1 = require("./http.js");
function throwIfCancelled(options) {
    if (options?.isCancelled?.())
        throw new Error("已取消");
}
const JDK_CACHE = node_path_1.default.join(node_os_1.default.homedir(), ".dmcl", "jdks");
/** 旧版缓存目录，只读兼容 */
const LEGACY_JDK_CACHE = node_path_1.default.join(node_os_1.default.homedir(), ".mcdev", "jdks");
const UA_HEADER = { "user-agent": http_js_1.UA };
function currentOs() {
    const p = process.platform;
    if (p === "win32")
        return "windows";
    if (p === "darwin")
        return "mac";
    return "linux";
}
function currentArch() {
    const a = process.arch;
    if (a === "x64")
        return "x64";
    if (a === "arm64")
        return "aarch64";
    return a;
}
/** MC 版本 → 所需 Java 主版本 */
function requiredJavaFor(mcVersion) {
    const m = mcVersion.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m)
        return 21;
    const a = Number(m[1]);
    const b = Number(m[2] ?? 0);
    const c = Number(m[3] ?? 0);
    if (a >= 26)
        return 25;
    if (a !== 1)
        return 21;
    if (b >= 21)
        return 21;
    if (b === 20)
        return c >= 5 ? 21 : 17;
    if (b >= 18)
        return 17;
    if (b === 17)
        return 17;
    return 8;
}
/** 检测 PATH 中 java 的主版本号，检测不到返回 null */
function detectJavaMajor() {
    try {
        const res = (0, node_child_process_1.spawnSync)("java", ["-version"], { encoding: "utf8", timeout: 15_000 });
        const out = `${res.stderr ?? ""}${res.stdout ?? ""}`;
        const m = out.match(/version "(\d+)(?:\.(\d+))?/);
        if (!m)
            return null;
        const major = Number(m[1]);
        return major === 1 ? Number(m[2] ?? 0) : major;
    }
    catch {
        return null;
    }
}
/** 检测指定 JAVA_HOME 下 java 的主版本号 */
function detectJavaMajorAt(javaHome) {
    const bin = process.platform === "win32"
        ? node_path_1.default.join(javaHome, "bin", "java.exe")
        : node_path_1.default.join(javaHome, "bin", "java");
    if (!node_fs_1.default.existsSync(bin))
        return null;
    try {
        const res = (0, node_child_process_1.spawnSync)(bin, ["-version"], { encoding: "utf8", timeout: 15_000 });
        const out = `${res.stderr ?? ""}${res.stdout ?? ""}`;
        const m = out.match(/version "(\d+)(?:\.(\d+))?/);
        if (!m)
            return null;
        const major = Number(m[1]);
        return major === 1 ? Number(m[2] ?? 0) : major;
    }
    catch {
        return null;
    }
}
/** 读取项目 gradle.properties 中的 org.gradle.java.home */
function readJavaHomeFromProject(targetDir) {
    try {
        const propsFile = node_path_1.default.join(targetDir, "gradle.properties");
        if (!node_fs_1.default.existsSync(propsFile))
            return null;
        const content = node_fs_1.default.readFileSync(propsFile, "utf8");
        const m = content.match(/^[ \t]*org\.gradle\.java\.home[ \t]*=[ \t]*(.+)$/m);
        if (!m)
            return null;
        return m[1].trim().replace(/\\\\/g, "\\").replace(/\\:/g, ":");
    }
    catch {
        return null;
    }
}
/** Gradle 实际会使用的 JVM 主版本（优先项目配置，其次 JAVA_HOME，最后 PATH） */
function effectiveJvmMajor(targetDir) {
    const fromProps = readJavaHomeFromProject(targetDir);
    if (fromProps)
        return detectJavaMajorAt(fromProps);
    const envHome = process.env.JAVA_HOME;
    if (envHome)
        return detectJavaMajorAt(envHome);
    return detectJavaMajor();
}
function readGradleProps(targetDir) {
    const file = node_path_1.default.join(targetDir, "gradle.properties");
    if (!node_fs_1.default.existsSync(file))
        return {};
    const out = {};
    for (const line of node_fs_1.default.readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
        if (m)
            out[m[1]] = m[2].trim();
    }
    return out;
}
/** 从 gradle-wrapper.properties 解析 Gradle 版本 */
function readGradleVersion(targetDir) {
    const file = node_path_1.default.join(targetDir, "gradle", "wrapper", "gradle-wrapper.properties");
    if (!node_fs_1.default.existsSync(file))
        return null;
    const content = node_fs_1.default.readFileSync(file, "utf8");
    const m = content.match(/gradle-(\d+(?:\.\d+)+)-(?:bin|all)\.zip/);
    return m?.[1] ?? null;
}
/** 运行该 Gradle 版本所允许的 JVM 主版本范围 */
function gradleJvmRange(gradleVersion) {
    const parts = gradleVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const atLeast = (major, minor) => parts[0] > major || (parts[0] === major && (parts[1] ?? 0) >= minor);
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
function readMcVersionFromProject(targetDir) {
    const props = readGradleProps(targetDir);
    if (props.minecraft_version)
        return props.minecraft_version;
    const buildGradlePath = node_path_1.default.join(targetDir, "build.gradle");
    if (node_fs_1.default.existsSync(buildGradlePath)) {
        const content = node_fs_1.default.readFileSync(buildGradlePath, "utf8");
        const forge = content.match(/minecraft\s*\{[^}]*version\s*=\s*["']([^"']+)["']/s);
        if (forge)
            return forge[1].split("-")[0];
        const forgeDependency = content.match(/minecraft\.dependency\(["']net\.minecraftforge:forge:([^-+"']+)-[^"']+["']\)/);
        if (forgeDependency)
            return forgeDependency[1];
        const neo = content.match(/minecraft_version\s*=\s*["']([^"']+)["']/);
        if (neo)
            return neo[1];
    }
    const fabricJson = node_path_1.default.join(targetDir, "src", "main", "resources", "fabric.mod.json");
    if (node_fs_1.default.existsSync(fabricJson)) {
        try {
            const j = JSON.parse(node_fs_1.default.readFileSync(fabricJson, "utf8"));
            const dep = j.depends?.minecraft;
            if (typeof dep === "string") {
                const m = dep.match(/(\d+\.\d+(?:\.\d+)?)/);
                if (m)
                    return m[1];
            }
        }
        catch { /* ignore */ }
    }
    return null;
}
/** 从 gradle.properties 读取 Loom 版本 */
function readLoomVersion(targetDir) {
    return readGradleProps(targetDir).loom_version ?? null;
}
/** Loom Gradle 插件运行所需的最低 JVM 主版本 */
function loomMinJvm(loomVersion) {
    const m = loomVersion.match(/^(\d+)\.(\d+)/);
    if (!m)
        return 21;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major === 0)
        return minor >= 8 ? 17 : 16;
    if (major === 1 && minor < 7)
        return 17;
    return 21;
}
/** ForgeGradle 2.x / 3.x（非 FG7 dependency 语法） */
function usesForgeGradleLegacy(targetDir) {
    const buildFile = node_path_1.default.join(targetDir, "build.gradle");
    if (!node_fs_1.default.existsSync(buildFile))
        return false;
    const content = node_fs_1.default.readFileSync(buildFile, "utf8");
    if (/minecraft\.dependency\s*\(\s*['"]net\.minecraftforge:forge/.test(content))
        return false;
    if (/id\s*['"]net\.minecraftforge\.gradle['"]/.test(content))
        return false;
    return /net\.minecraftforge\.gradle|ForgeGradle:/.test(content);
}
/**
 * Gradle 进程应使用的 JDK 主版本。
 * 旧版 ForgeGradle 固定 Java 8；现代项目取 Gradle/Loom/MC 编译目标的最高需求。
 */
function pickJdkMajor(mcVersion, targetDir) {
    const gradleVer = readGradleVersion(targetDir);
    const range = gradleVer ? gradleJvmRange(gradleVer) : { min: 17, max: 25 };
    if (usesForgeGradleLegacy(targetDir))
        return 8;
    const loomVer = readLoomVersion(targetDir);
    const loomNeed = loomVer ? loomMinJvm(loomVer) : range.min;
    const compileNeed = requiredJavaFor(mcVersion);
    return Math.max(range.min, loomNeed, compileNeed);
}
/** 当前 JVM 是否可运行该项目的 Gradle（含 Loom 插件要求） */
function isJvmCompatible(targetDir) {
    const major = effectiveJvmMajor(targetDir);
    if (major === null)
        return false;
    const gradleVer = readGradleVersion(targetDir) ?? "8.0";
    const range = gradleJvmRange(gradleVer);
    if (major < range.min || major > range.max)
        return false;
    const mcVersion = readMcVersionFromProject(targetDir);
    if (mcVersion && !usesForgeGradleLegacy(targetDir) && major < requiredJavaFor(mcVersion))
        return false;
    const loomVer = readLoomVersion(targetDir);
    if (loomVer && major < loomMinJvm(loomVer))
        return false;
    return true;
}
async function downloadAndInjectJdk(javaMajor, targetDir, log, options) {
    const jdkPath = await ensureJdkInCache(javaMajor, log, options);
    throwIfCancelled(options);
    await injectJdkHome(targetDir, jdkPath);
    log("已配置 org.gradle.java.home");
}
/**
 * 分析项目构建所需的 JDK 主版本及原因（不检测系统 Java）。
 */
function resolveProjectJdkNeed(targetDir, mcVersion) {
    const major = pickJdkMajor(mcVersion, targetDir);
    const gradleVersion = readGradleVersion(targetDir);
    const loomVersion = readLoomVersion(targetDir);
    const compileNeed = usesForgeGradleLegacy(targetDir) ? 8 : requiredJavaFor(mcVersion);
    const range = gradleVersion ? gradleJvmRange(gradleVersion) : { min: 17, max: 25 };
    const bits = [];
    if (gradleVersion)
        bits.push(`Gradle ${gradleVersion}`);
    if (loomVersion)
        bits.push(`Loom ${loomVersion}`);
    bits.push(`Minecraft ${mcVersion} -> Java ${compileNeed}`);
    const summary = bits.length > 0 ? bits.join(" + ") : "项目工具链";
    const incompatibleReason = major > range.max
        ? `Gradle ${gradleVersion ?? "unknown"} supports running up to Java ${range.max}, but Minecraft ${mcVersion} needs Java ${compileNeed}`
        : undefined;
    return { major, gradleVersion, loomVersion, summary, incompatibleReason };
}
/** 项目 gradle.properties 是否已指向可用且在兼容范围内的 JDK */
function projectJdkIsReady(targetDir, neededMajor, mcVersion) {
    const configured = readJavaHomeFromProject(targetDir);
    if (!configured)
        return false;
    const bin = process.platform === "win32"
        ? node_path_1.default.join(configured, "bin", "java.exe")
        : node_path_1.default.join(configured, "bin", "java");
    if (!node_fs_1.default.existsSync(bin))
        return false;
    const major = detectJavaMajorAt(configured);
    if (major === null || major < neededMajor)
        return false;
    const gradleVer = readGradleVersion(targetDir);
    const range = gradleVer ? gradleJvmRange(gradleVer) : { min: 17, max: 25 };
    if (major > range.max)
        return false;
    if (mcVersion && !usesForgeGradleLegacy(targetDir)) {
        if (major < requiredJavaFor(mcVersion))
            return false;
    }
    else if (usesForgeGradleLegacy(targetDir) && major !== 8) {
        return false;
    }
    return true;
}
/**
 * 确保项目使用 DMCL 托管的 JDK：先分析需求，再查本地缓存，缺失则自动下载。
 * 不依赖用户系统是否已安装 Java。
 */
async function ensureProjectJdk(targetDir, mcVersion, log = () => { }, options) {
    throwIfCancelled(options);
    const need = resolveProjectJdkNeed(targetDir, mcVersion);
    log(`检查 JDK：此项目需要 Java ${need.major}（${need.summary}）`);
    if (need.incompatibleReason) {
        throw new Error(need.incompatibleReason);
    }
    if (projectJdkIsReady(targetDir, need.major, mcVersion)) {
        const home = readJavaHomeFromProject(targetDir);
        const configuredMajor = detectJavaMajorAt(home);
        log(`✔ 项目已配置 JDK ${configuredMajor ?? need.major}：${home}`);
        return;
    }
    const cached = findCachedJdk(need.major);
    if (cached) {
        log(`使用 DMCL 已缓存的 JDK ${need.major}：${cached}`);
        await injectJdkHome(targetDir, cached);
        log("已写入 org.gradle.java.home");
        return;
    }
    throwIfCancelled(options);
    log(`未检测到 JDK ${need.major}，开始自动下载（无需事先安装 Java）…`);
    const jdkPath = await ensureJdkInCache(need.major, log, options);
    throwIfCancelled(options);
    await injectJdkHome(targetDir, jdkPath);
    log("已写入 org.gradle.java.home");
}
/** 查询 Adoptium API 获取 JDK 下载链接 */
async function fetchJdkDownloadUrl(javaMajor) {
    try {
        const assets = await (0, http_js_1.fetchJson)(`https://api.adoptium.net/v3/assets/latest/${javaMajor}/hotspot`, { retries: 1 });
        const os = currentOs();
        const arch = currentArch();
        const match = assets.find((a) => a.binary.os === os &&
            a.binary.architecture === arch &&
            a.binary.image_type === "jdk");
        if (!match)
            return null;
        return {
            url: match.binary.package.link,
            filename: match.binary.package.name,
            sizeBytes: match.binary.package.size,
            versionLabel: match.version.openjdk_version,
        };
    }
    catch {
        return null;
    }
}
/**
 * 清华 TUNA 的 Adoptium 镜像地址（国内速度快且稳定）。
 * 路径格式：/Adoptium/{major}/jdk/{arch}/{os}/{filename}
 */
function jdkMirrorUrl(javaMajor, filename) {
    return `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${javaMajor}/jdk/${currentArch()}/${currentOs()}/${filename}`;
}
/** 依次尝试多个 URL 下载，全部失败才抛错 */
async function downloadWithFallback(urls, dest, totalBytes, onProgress, isCancelled) {
    let lastErr = null;
    for (const url of urls) {
        try {
            await downloadWithProgress(url, dest, totalBytes, onProgress, isCancelled);
            return;
        }
        catch (err) {
            if (isCancelled?.())
                throw err;
            lastErr = err;
        }
    }
    throw lastErr ?? new Error("下载失败");
}
/** 流式下载文件，每 2 MB 回调一次进度 */
async function downloadWithProgress(url, dest, totalBytes, onProgress, isCancelled) {
    const res = await fetch(url, { headers: UA_HEADER });
    if (!res.ok)
        throw new Error(`下载失败 HTTP ${res.status}：${url}`);
    if (!res.body)
        throw new Error("响应无 body");
    const reader = res.body.getReader();
    const chunks = [];
    let downloaded = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (isCancelled?.())
            throw new Error("已取消");
        const { done, value } = await reader.read();
        if (done)
            break;
        chunks.push(value);
        downloaded += value.length;
        // 镜像源文件大小可能与 API 报告值略有出入，封顶 100
        onProgress(Math.min(100, Math.round((downloaded / totalBytes) * 100)));
    }
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(dest), { recursive: true });
    await node_fs_1.default.promises.writeFile(dest, Buffer.concat(chunks));
}
/** 检查 ~/.dmcl/jdks 缓存，验证版本后返回路径 */
function findCachedJdk(javaMajor) {
    for (const base of [JDK_CACHE, LEGACY_JDK_CACHE]) {
        const dir = node_path_1.default.join(base, String(javaMajor));
        if (!node_fs_1.default.existsSync(node_path_1.default.join(dir, "bin")))
            continue;
        const major = detectJavaMajorAt(dir);
        if (major === javaMajor)
            return dir;
    }
    return null;
}
const jdkCacheInflight = new Map();
async function downloadJdkToCache(javaMajor, log, options) {
    throwIfCancelled(options);
    const existing = findCachedJdk(javaMajor);
    if (existing)
        return existing;
    const asset = await fetchJdkDownloadUrl(javaMajor);
    if (!asset) {
        throw new Error(`查询 JDK ${javaMajor} 下载地址失败，请手动安装：https://adoptium.net`);
    }
    const tmpDir = node_path_1.default.join(node_os_1.default.tmpdir(), `dmcl-jdk-${javaMajor}-${Date.now()}`);
    const zipDest = node_path_1.default.join(tmpDir, asset.filename);
    await node_fs_1.default.promises.mkdir(tmpDir, { recursive: true });
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
    await node_fs_1.default.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    if (detectJavaMajorAt(jdkPath) !== javaMajor) {
        throw new Error(`下载的 JDK 不是 Java ${javaMajor}：${jdkPath}`);
    }
    log(`JDK 已安装至 ${jdkPath}`);
    return jdkPath;
}
/** 确保 JDK 已缓存；同版本并发下载/解压只执行一次 */
async function ensureJdkInCache(javaMajor, log, options) {
    const cached = findCachedJdk(javaMajor);
    if (cached)
        return cached;
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
async function extractJdk(zipPath, javaMajor) {
    const dest = node_path_1.default.resolve(node_path_1.default.join(JDK_CACHE, String(javaMajor)));
    await node_fs_1.default.promises.mkdir(dest, { recursive: true });
    const zip = new adm_zip_1.default(zipPath);
    const entries = zip.getEntries();
    // 找到第一个目录条目作为根
    const firstDir = entries.find((e) => e.isDirectory && !e.entryName.startsWith("__"));
    const strip = firstDir ? `${firstDir.entryName}` : "";
    for (const entry of entries) {
        if (entry.isDirectory)
            continue;
        const rel = strip && entry.entryName.startsWith(strip)
            ? entry.entryName.slice(strip.length)
            : entry.entryName;
        if (!rel)
            continue;
        const target = node_path_1.default.resolve(dest, ...rel.split("/"));
        const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
        const t = norm(target);
        const d = norm(dest);
        if (!t.startsWith(d + node_path_1.default.sep) && t !== d)
            continue;
        await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(target), { recursive: true });
        await node_fs_1.default.promises.writeFile(target, entry.getData());
    }
    // 返回解压根目录
    return dest;
}
/** 将 org.gradle.java.home 注入项目的 gradle.properties */
async function injectJdkHome(targetDir, jdkPath) {
    const propsFile = node_path_1.default.join(targetDir, "gradle.properties");
    let content = "";
    if (node_fs_1.default.existsSync(propsFile)) {
        content = await node_fs_1.default.promises.readFile(propsFile, "utf8");
    }
    // 确保不以多余空行结尾
    const escaped = jdkPath.replace(/\\/g, "/");
    const marker = "org.gradle.java.home";
    if (content.includes(marker)) {
        content = content.replace(/^org\.gradle\.java\.home=.*$/m, `${marker}=${escaped}`);
    }
    else {
        content = `${content.trimEnd()}\n${marker}=${escaped}\n`;
    }
    await node_fs_1.default.promises.writeFile(propsFile, content, "utf8");
}
