"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supportsSplitSources = void 0;
exports.usesLegacyFabricApi = usesLegacyFabricApi;
exports.usesRemapLoom = usesRemapLoom;
exports.patchBuildGradle = patchBuildGradle;
exports.adaptFabricToolchain = adaptFabricToolchain;
exports.ensureFabricApiVersion = ensureFabricApiVersion;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const fsutils_js_1 = require("../core/fsutils.js");
const jdk_js_1 = require("../core/jdk.js");
const scaffold_js_1 = require("../core/scaffold.js");
const fabric_js_1 = require("../meta/fabric.js");
const mc_version_js_1 = require("../meta/mc-version.js");
const detect_js_1 = require("../workspace/detect.js");
const side_layout_js_1 = require("../core/side-layout.js");
/**
 * Fabric API 的历史 mod id 兼容：
 * - 1.19 及更早运行期识别为 `fabric`
 * - 1.20+ 与 26.x 识别为 `fabric-api`
 */
function usesLegacyFabricApi(mcVersion) {
    if (!(0, mc_version_js_1.isLegacy1xMc)(mcVersion))
        return false;
    return (0, mc_version_js_1.mcFeatureNumber)(mcVersion) <= 19;
}
/** MC 1.18+ / 26+ 支持 splitEnvironmentSourceSets */
var mc_version_js_2 = require("../meta/mc-version.js");
Object.defineProperty(exports, "supportsSplitSources", { enumerable: true, get: function () { return mc_version_js_2.supportsSplitSources; } });
/** MC 26+ 非混淆，使用 fabric-loom；更早版本使用 fabric-loom-remap */
function usesRemapLoom(mcVersion) {
    return !(0, mc_version_js_1.isUnobfuscatedMc)(mcVersion);
}
function modJavaVersionEnum(major) {
    if (major <= 8)
        return "VERSION_1_8";
    return `VERSION_${major}`;
}
function mixinCompatibilityLevel(mcVersion) {
    const major = (0, jdk_js_1.requiredJavaFor)(mcVersion);
    return major <= 8 ? "JAVA_8" : `JAVA_${major}`;
}
function stripSlf4jFromJava(content) {
    if (!content.includes("org.slf4j"))
        return content;
    let next = content.replace(/^import org\.slf4j\.[^\n]+\n/gm, "");
    next = next.replace(/\s*public static final Logger LOGGER = LoggerFactory\.getLogger\([^)]+\);\s*\n/g, "\n");
    next = next.replace(/\s*LOGGER\.(info|warn|error|debug)\([^;]+;\s*\n/g, "\n");
    return next;
}
async function removePathIfExists(p) {
    if (node_fs_1.default.existsSync(p))
        await node_fs_1.default.promises.rm(p, { recursive: true, force: true });
}
/** 新版模板用于旧 MC 时：去掉 client 分源、slf4j、不兼容的示例 mixin */
async function adaptLegacyFabricSources(targetDir, opts, log) {
    if ((0, mc_version_js_1.supportsSplitSources)(opts.mcVersion))
        return;
    await removePathIfExists(node_path_1.default.join(targetDir, "src", "client"));
    for (const sub of ["client", "mixin"]) {
        await removePathIfExists(node_path_1.default.join(targetDir, "src", "main", "java", "com", "example", sub));
    }
    const mixinNames = new Set();
    for (const file of await (0, fsutils_js_1.walkFiles)(targetDir)) {
        if (!file.endsWith(".java"))
            continue;
        const base = node_path_1.default.basename(file);
        if (/ExampleMixin|ExampleModClient|ExampleClientMixin/.test(base)) {
            mixinNames.add(base.replace(/\.java$/, ""));
            await node_fs_1.default.promises.rm(file, { force: true });
            continue;
        }
        const raw = await node_fs_1.default.promises.readFile(file, "utf8");
        const stripped = stripSlf4jFromJava(raw);
        if (stripped !== raw)
            await node_fs_1.default.promises.writeFile(file, stripped, "utf8");
    }
    const resRoot = node_path_1.default.join(targetDir, "src", "main", "resources");
    if (node_fs_1.default.existsSync(resRoot)) {
        for (const entry of await node_fs_1.default.promises.readdir(resRoot)) {
            if (entry.includes("client") && entry.endsWith(".mixins.json")) {
                await node_fs_1.default.promises.rm(node_path_1.default.join(resRoot, entry), { force: true });
            }
        }
    }
    for (const file of await (0, fsutils_js_1.walkFiles)(targetDir)) {
        if (!file.endsWith(".mixins.json"))
            continue;
        const doc = JSON.parse(await node_fs_1.default.promises.readFile(file, "utf8"));
        doc.compatibilityLevel = mixinCompatibilityLevel(opts.mcVersion);
        doc.mixins = (doc.mixins ?? []).filter((name) => !mixinNames.has(name));
        delete doc.overwrites;
        if (doc.package?.includes("example") && !doc.package.startsWith(opts.group)) {
            doc.package = `${opts.group}.mixin`;
        }
        await node_fs_1.default.promises.writeFile(file, JSON.stringify(doc, null, "\t") + "\n", "utf8");
    }
    const modJson = node_path_1.default.join(resRoot, "fabric.mod.json");
    if (node_fs_1.default.existsSync(modJson)) {
        const doc = JSON.parse(node_fs_1.default.readFileSync(modJson, "utf8"));
        if (Array.isArray(doc.mixins)) {
            doc.mixins = doc.mixins.filter((m) => typeof m === "string");
        }
        if (doc.entrypoints?.client)
            delete doc.entrypoints.client;
        node_fs_1.default.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
    }
    log("已适配旧版 MC 源码（移除 client 分源、slf4j 与不兼容示例 mixin）");
}
function mcFabricModJsonRange(mcVersion) {
    const parts = mcVersion.split(".");
    if (parts.length >= 3)
        return `~${parts[0]}.${parts[1]}.${parts[2]}`;
    if (parts.length === 2)
        return `~${parts[0]}.${parts[1]}`;
    return `~${mcVersion}`;
}
function patchBuildGradle(content, opts) {
    const javaMajor = (0, jdk_js_1.requiredJavaFor)(opts.mcVersion);
    const javaEnum = modJavaVersionEnum(javaMajor);
    const remap = usesRemapLoom(opts.mcVersion);
    const split = (0, side_layout_js_1.wantsSplitSources)(opts);
    if (remap) {
        content = content.replace(/id\s+['"]net\.fabricmc\.fabric-loom['"]/, "id 'net.fabricmc.fabric-loom-remap'");
    }
    if (!split) {
        content = content.replace(/\n\s*splitEnvironmentSourceSets\(\)\s*\n/, "\n");
        content = content.replace(/mods\s*\{[\s\S]*?sourceSet sourceSets\.client[\s\S]*?\n\t\}/m, (block) => block.replace(/\n\s*sourceSet sourceSets\.client\s*\n/, "\n"));
    }
    content = content.replace(/tasks\.withType\(JavaCompile\)\.configureEach\s*\{[\s\S]*?\}/m, javaMajor <= 8
        ? ""
        : `tasks.withType(JavaCompile).configureEach {\n\tit.options.release = ${javaMajor}\n}`);
    content = content.replace(/sourceCompatibility\s*=\s*JavaVersion\.VERSION_\S+/g, `sourceCompatibility = JavaVersion.${javaEnum}`);
    content = content.replace(/targetCompatibility\s*=\s*JavaVersion\.VERSION_\S+/g, `targetCompatibility = JavaVersion.${javaEnum}`);
    if ((0, mc_version_js_1.isUnobfuscatedMc)(opts.mcVersion)) {
        content = content.replace(/\n\s*mappings[^\n]*\n/g, "\n");
    }
    else if (!content.includes("mappings ") && !content.includes("mappings(")) {
        const mappingsLine = opts.mappings === "yarn"
            ? `\tmappings "net.fabricmc:yarn:\${project.yarn_mappings}"\n`
            : `\tmappings loom.officialMojangMappings()\n`;
        content = content.replace(/(dependencies\s*\{[\s\S]*?minecraft[^\n]*\n)/, `$1${mappingsLine}`);
    }
    const depConfiguration = remap ? "modImplementation" : "implementation";
    content = content.replace(/\b(?:modImplementation|implementation)\b(?=\s+"net\.fabricmc)/g, depConfiguration);
    return content;
}
function patchFabricModJson(targetDir, opts, loaderVersion) {
    const file = node_path_1.default.join(targetDir, "src", "main", "resources", "fabric.mod.json");
    if (!node_fs_1.default.existsSync(file))
        return;
    const javaMajor = (0, jdk_js_1.requiredJavaFor)(opts.mcVersion);
    const doc = JSON.parse(node_fs_1.default.readFileSync(file, "utf8"));
    doc.depends ??= {};
    doc.depends.minecraft = mcFabricModJsonRange(opts.mcVersion);
    doc.depends.java = `>=${javaMajor}`;
    if (loaderVersion)
        doc.depends.fabricloader = `>=${loaderVersion}`;
    // fabric / fabric-api 由 syncFabricApiDependency 统一写入
    delete doc.depends["fabric-api"];
    delete doc.depends.fabric;
    if (!(0, mc_version_js_1.supportsSplitSources)(opts.mcVersion)) {
        if (doc.entrypoints?.client) {
            delete doc.entrypoints.client;
        }
        if (Array.isArray(doc.mixins)) {
            doc.mixins = doc.mixins.filter((m) => typeof m === "string");
        }
    }
    node_fs_1.default.writeFileSync(file, JSON.stringify(doc, null, "\t") + "\n", "utf8");
}
function stripFabricApi(targetDir, log) {
    const buildFile = node_path_1.default.join(targetDir, "build.gradle");
    if (node_fs_1.default.existsSync(buildFile)) {
        let content = node_fs_1.default.readFileSync(buildFile, "utf8");
        const next = content
            .replace(/\n\s*modImplementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
            .replace(/\n\s*implementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
            .replace(/\n\s*modImplementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n")
            .replace(/\n\s*implementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n");
        if (next !== content) {
            node_fs_1.default.writeFileSync(buildFile, next, "utf8");
            log("此版本无可用 Fabric API，已移除依赖");
        }
    }
    const modJson = node_path_1.default.join(targetDir, "src", "main", "resources", "fabric.mod.json");
    if (node_fs_1.default.existsSync(modJson)) {
        const doc = JSON.parse(node_fs_1.default.readFileSync(modJson, "utf8"));
        if (doc.depends) {
            delete doc.depends["fabric-api"];
            delete doc.depends.fabric;
            node_fs_1.default.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
        }
    }
    const props = node_path_1.default.join(targetDir, "gradle.properties");
    if (node_fs_1.default.existsSync(props)) {
        const content = node_fs_1.default.readFileSync(props, "utf8")
            .replace(/^\s*fabric_api_version\s*=.*\n/m, "")
            .replace(/^\s*fabric_version\s*=.*\n/m, "");
        node_fs_1.default.writeFileSync(props, content, "utf8");
    }
}
/** 同步 build.gradle 与 fabric.mod.json 中的 Fabric API 依赖 */
function syncFabricApiDependency(targetDir, opts, apiVersion, log) {
    const legacy = usesLegacyFabricApi(opts.mcVersion);
    const buildFile = node_path_1.default.join(targetDir, "build.gradle");
    let content = node_fs_1.default.readFileSync(buildFile, "utf8");
    content = content
        .replace(/\n\s*modImplementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
        .replace(/\n\s*implementation\s+"net\.fabricmc\.fabric-api:fabric-api:[^"]+"\s*\n/g, "\n")
        .replace(/\n\s*modImplementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n")
        .replace(/\n\s*implementation\s+"net\.fabricmc:fabric:[^"]+"\s*\n/g, "\n");
    const depConfiguration = usesRemapLoom(opts.mcVersion) ? "modImplementation" : "implementation";
    const dep = `\t${depConfiguration} "net.fabricmc.fabric-api:fabric-api:${apiVersion}"\n`;
    content = content.replace(/((?:modImplementation|implementation)\s+"net\.fabricmc:fabric-loader:[^"]+"\s*\n)/, `$1${dep}`);
    node_fs_1.default.writeFileSync(buildFile, content, "utf8");
    log(legacy
        ? `已配置 Fabric API ${apiVersion}（运行时 mod id: fabric）`
        : `已配置 Fabric API ${apiVersion}`);
    const modJson = node_path_1.default.join(targetDir, "src", "main", "resources", "fabric.mod.json");
    if (!node_fs_1.default.existsSync(modJson))
        return;
    const doc = JSON.parse(node_fs_1.default.readFileSync(modJson, "utf8"));
    doc.depends ??= {};
    delete doc.depends["fabric-api"];
    delete doc.depends.fabric;
    doc.depends[legacy ? "fabric" : "fabric-api"] = "*";
    node_fs_1.default.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
}
/** 按 MC 版本修正 Loom 插件、Java 兼容级别、映射与 fabric.mod.json */
async function adaptFabricToolchain(opts, log, versions) {
    const buildFile = node_path_1.default.join(opts.targetDir, "build.gradle");
    if (node_fs_1.default.existsSync(buildFile)) {
        const content = patchBuildGradle(node_fs_1.default.readFileSync(buildFile, "utf8"), opts);
        node_fs_1.default.writeFileSync(buildFile, content, "utf8");
        log(`已适配 build.gradle（Java ${(0, jdk_js_1.requiredJavaFor)(opts.mcVersion)}、Loom 插件）`);
    }
    patchFabricModJson(opts.targetDir, opts, versions.loaderVersion);
    const props = {};
    if (versions.loaderVersion)
        props.loader_version = versions.loaderVersion;
    if (versions.apiVersion) {
        props.fabric_api_version = versions.apiVersion;
        props.fabric_version = versions.apiVersion;
    }
    if (Object.keys(props).length > 0) {
        await (0, fsutils_js_1.patchProperties)(node_path_1.default.join(opts.targetDir, "gradle.properties"), props);
    }
    if (versions.apiVersion) {
        syncFabricApiDependency(opts.targetDir, opts, versions.apiVersion, log);
    }
    else {
        stripFabricApi(opts.targetDir, log);
    }
    await adaptLegacyFabricSources(opts.targetDir, opts, log);
}
function readGradleProps(targetDir) {
    const file = node_path_1.default.join(targetDir, "gradle.properties");
    if (!node_fs_1.default.existsSync(file))
        return {};
    const out = {};
    for (const line of node_fs_1.default.readFileSync(file, "utf8").split("\n")) {
        const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
        if (match)
            out[match[1]] = match[2].trim();
    }
    return out;
}
/** 启动客户端前修正 Fabric API 版本（修复旧项目或错误回退导致的 MC 不兼容） */
async function ensureFabricApiVersion(targetDir, log) {
    const detected = (0, detect_js_1.detectProject)(targetDir);
    if (!detected || detected.loader !== "fabric")
        return false;
    const props = readGradleProps(targetDir);
    const current = props.fabric_api_version ?? props.fabric_version ?? null;
    const resolved = await (0, fabric_js_1.fetchFabricApiVersion)(detected.mcVersion);
    if (!resolved || current === resolved)
        return false;
    log(`Fabric API 版本修正：${current ?? "(未设置)"} → ${resolved}（MC ${detected.mcVersion}）`);
    const opts = {
        loader: "fabric",
        mcVersion: detected.mcVersion,
        targetDir,
        modId: detected.modId,
        displayName: detected.displayName,
        className: (0, scaffold_js_1.pascalCase)(detected.displayName || detected.modId),
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
