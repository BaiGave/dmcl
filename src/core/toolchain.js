"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveVersionToolchain = exports.recommendedGradleVersion = exports.minimumGradleForJvm = void 0;
exports.isDmclManagedProject = isDmclManagedProject;
exports.writeScaffoldMarker = writeScaffoldMarker;
exports.resolveProjectToolchain = resolveProjectToolchain;
exports.ensureGradleWrapperCompatibility = ensureGradleWrapperCompatibility;
exports.writeToolchainMetadata = writeToolchainMetadata;
exports.ensureProjectToolchain = ensureProjectToolchain;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_js_1 = require("../workspace/paths.js");
const mirror_js_1 = require("./mirror.js");
const jdk_js_1 = require("./jdk.js");
const forge_mavenizer_js_1 = require("./forge-mavenizer.js");
const version_toolchain_js_1 = require("./version-toolchain.js");
var version_toolchain_js_2 = require("./version-toolchain.js");
Object.defineProperty(exports, "minimumGradleForJvm", { enumerable: true, get: function () { return version_toolchain_js_2.minimumGradleForJvm; } });
Object.defineProperty(exports, "recommendedGradleVersion", { enumerable: true, get: function () { return version_toolchain_js_2.recommendedGradleVersion; } });
Object.defineProperty(exports, "resolveVersionToolchain", { enumerable: true, get: function () { return version_toolchain_js_2.resolveVersionToolchain; } });
/** DMCL 脚手架或工作区项目才允许自动改 Gradle Wrapper */
function isDmclManagedProject(targetDir) {
    const resolved = node_path_1.default.resolve(targetDir);
    const dmclDir = node_path_1.default.join(resolved, ".dmcl");
    if (node_fs_1.default.existsSync(node_path_1.default.join(dmclDir, "scaffold.json")))
        return true;
    if (node_fs_1.default.existsSync(node_path_1.default.join(dmclDir, "toolchain.json")))
        return true;
    const projectsRoot = node_path_1.default.resolve((0, paths_js_1.getProjectsRoot)());
    return resolved === projectsRoot || resolved.startsWith(projectsRoot + node_path_1.default.sep);
}
async function writeScaffoldMarker(targetDir, loader, mcVersion) {
    const marker = {
        loader,
        mcVersion,
        createdAt: new Date().toISOString(),
        dmclVersion: "0.1.0",
    };
    const dir = node_path_1.default.join(targetDir, ".dmcl");
    await node_fs_1.default.promises.mkdir(dir, { recursive: true });
    await node_fs_1.default.promises.writeFile(node_path_1.default.join(dir, "scaffold.json"), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}
function detectLoaderFromProject(targetDir) {
    const propsFile = node_path_1.default.join(targetDir, "gradle.properties");
    const props = {};
    if (node_fs_1.default.existsSync(propsFile)) {
        for (const line of node_fs_1.default.readFileSync(propsFile, "utf8").split("\n")) {
            const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
            if (m)
                props[m[1]] = m[2].trim();
        }
    }
    if (props.loader_version || props.yarn_mappings || props.fabric_version)
        return "fabric";
    if (props.neo_version)
        return "neoforge";
    const buildGradle = node_fs_1.default.existsSync(node_path_1.default.join(targetDir, "build.gradle"))
        ? node_fs_1.default.readFileSync(node_path_1.default.join(targetDir, "build.gradle"), "utf8")
        : "";
    if (buildGradle.includes("net.neoforged"))
        return "neoforge";
    if ((0, forge_mavenizer_js_1.usesForgeGradle)(targetDir))
        return "forge";
    if (node_fs_1.default.existsSync(node_path_1.default.join(targetDir, "src", "main", "resources", "fabric.mod.json")))
        return "fabric";
    if (node_fs_1.default.existsSync(node_path_1.default.join(targetDir, "src", "main", "resources", "META-INF", "neoforge.mods.toml"))) {
        return "neoforge";
    }
    if (node_fs_1.default.existsSync(node_path_1.default.join(targetDir, "src", "main", "resources", "META-INF", "mods.toml")))
        return "forge";
    return null;
}
function gradleVersionAtLeast(current, minimum) {
    const parse = (v) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
    const a = parse(current);
    const b = parse(minimum);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        if (av > bv)
            return true;
        if (av < bv)
            return false;
    }
    return true;
}
/**
 * 分析项目完整工具链需求（不修改磁盘、不下载）。
 */
function resolveProjectToolchain(targetDir, mcVersion) {
    const mc = mcVersion ?? (0, jdk_js_1.readMcVersionFromProject)(targetDir);
    if (!mc)
        return null;
    const loader = detectLoaderFromProject(targetDir);
    const gradleVersion = (0, jdk_js_1.readGradleVersion)(targetDir);
    const loomVersion = (0, jdk_js_1.readLoomVersion)(targetDir);
    const compileJavaMajor = (0, jdk_js_1.usesForgeGradleLegacy)(targetDir) ? 8 : (0, jdk_js_1.requiredJavaFor)(mc);
    const range = gradleVersion ? (0, jdk_js_1.gradleJvmRange)(gradleVersion) : { min: 17, max: 25 };
    const gradleRuntimeJdkMajor = (0, jdk_js_1.pickJdkMajor)(mc, targetDir);
    const needsForgeMavenizer = (0, forge_mavenizer_js_1.usesForgeGradle)(targetDir);
    const bits = [];
    if (gradleVersion)
        bits.push(`Gradle ${gradleVersion}`);
    if (loomVersion)
        bits.push(`Loom ${loomVersion}`);
    bits.push(`Minecraft ${mc} → Java ${compileJavaMajor}`);
    if (needsForgeMavenizer)
        bits.push("Forge Mavenizer JDK 8");
    const summary = bits.join(" + ");
    let incompatibleReason;
    let gradleUpgradeRecommended;
    if (gradleRuntimeJdkMajor > range.max) {
        const targetGradle = (0, version_toolchain_js_1.minimumGradleForJvm)(compileJavaMajor);
        if (gradleVersion && !gradleVersionAtLeast(gradleVersion, targetGradle)) {
            gradleUpgradeRecommended = targetGradle;
            incompatibleReason = `Gradle ${gradleVersion} 最高支持 Java ${range.max}，但 Minecraft ${mc} 需要 Java ${compileJavaMajor}；建议升级 Wrapper 至 ${targetGradle}`;
        }
        else {
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
async function ensureGradleWrapperCompatibility(targetDir, toolchain, log) {
    if (!toolchain.gradleUpgradeRecommended)
        return false;
    if ((0, jdk_js_1.usesForgeGradleLegacy)(targetDir)) {
        log("⚠ 旧版 ForgeGradle 项目跳过 Gradle Wrapper 自动升级");
        return false;
    }
    if (!isDmclManagedProject(targetDir)) {
        log("⚠ 外部导入项目跳过 Gradle Wrapper 自动升级，请手动调整 gradle-wrapper.properties");
        return false;
    }
    const wrapperProps = node_path_1.default.join(targetDir, "gradle", "wrapper", "gradle-wrapper.properties");
    if (!node_fs_1.default.existsSync(wrapperProps)) {
        log("⚠ 未找到 gradle-wrapper.properties，无法自动升级 Gradle");
        return false;
    }
    const target = toolchain.gradleUpgradeRecommended;
    const current = toolchain.gradleVersion ?? "unknown";
    log(`工具链：Gradle ${current} 无法运行 Java ${toolchain.compileJavaMajor}，自动升级 Wrapper → ${target}`);
    const content = await node_fs_1.default.promises.readFile(wrapperProps, "utf8");
    const distMatch = content.match(/distributionUrl=.*gradle-[\d.]+-(bin|all)\.zip/);
    const distType = distMatch?.[1] ?? "bin";
    const replaced = content.replace(/distributionUrl=.*gradle-[\d.]+-(bin|all)\.zip/, `distributionUrl=https\\://services.gradle.org/distributions/gradle-${target}-${distType}.zip`);
    if (replaced === content) {
        log("⚠ 无法解析 gradle-wrapper.properties 中的 distributionUrl");
        return false;
    }
    await node_fs_1.default.promises.writeFile(wrapperProps, replaced, "utf8");
    await (0, mirror_js_1.applyChinaMirror)(targetDir, log);
    log(`✔ Gradle Wrapper 已升级至 ${target}`);
    return true;
}
function toolchainMetadataPath(targetDir) {
    return node_path_1.default.join(targetDir, ".dmcl", "toolchain.json");
}
async function writeToolchainMetadata(targetDir, toolchain) {
    const configuredHome = (0, jdk_js_1.readJavaHomeFromProject)(targetDir);
    const configuredMajor = configuredHome ? (0, jdk_js_1.detectJavaMajorAt)(configuredHome) : null;
    const meta = {
        mcVersion: toolchain.mcVersion,
        loader: toolchain.loader,
        gradleVersion: (0, jdk_js_1.readGradleVersion)(targetDir),
        jdkMajor: configuredMajor ?? toolchain.gradleRuntimeJdkMajor,
        compileJavaMajor: toolchain.compileJavaMajor,
        loomVersion: toolchain.loomVersion,
        configuredAt: new Date().toISOString(),
    };
    const dir = node_path_1.default.dirname(toolchainMetadataPath(targetDir));
    await node_fs_1.default.promises.mkdir(dir, { recursive: true });
    await node_fs_1.default.promises.writeFile(toolchainMetadataPath(targetDir), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
/**
 * 全自动配置项目工具链：Gradle Wrapper 兼容 → JDK → Forge Mavenizer 缓存 → 元数据。
 */
async function ensureProjectToolchain(targetDir, mcVersion, log = () => { }, options) {
    let toolchain = resolveProjectToolchain(targetDir, mcVersion);
    if (!toolchain) {
        throw new Error("无法从项目推断 Minecraft 版本");
    }
    log(`工具链分析：需要 Java ${toolchain.gradleRuntimeJdkMajor}（${toolchain.summary}）`);
    if (toolchain.gradleUpgradeRecommended) {
        const upgraded = await ensureGradleWrapperCompatibility(targetDir, toolchain, log);
        if (upgraded) {
            toolchain = resolveProjectToolchain(targetDir, toolchain.mcVersion);
            log(`工具链重分析：Java ${toolchain.gradleRuntimeJdkMajor}（${toolchain.summary}）`);
        }
    }
    if (toolchain.incompatibleReason) {
        throw new Error(toolchain.incompatibleReason);
    }
    await (0, jdk_js_1.ensureProjectJdk)(targetDir, toolchain.mcVersion, log, options);
    if (toolchain.needsForgeMavenizer) {
        await (0, forge_mavenizer_js_1.ensureForgeMavenizerJdkCache)(targetDir, log, options);
    }
    toolchain = resolveProjectToolchain(targetDir, toolchain.mcVersion);
    await writeToolchainMetadata(targetDir, toolchain);
    log("✔ 项目工具链已就绪");
}
