"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scaffoldFabric = scaffoldFabric;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const http_js_1 = require("../core/http.js");
const template_js_1 = require("../core/template.js");
const fsutils_js_1 = require("../core/fsutils.js");
const mappings_js_1 = require("../core/mappings.js");
const fabric_js_1 = require("../meta/fabric.js");
const mc_version_js_1 = require("../meta/mc-version.js");
const sources_js_1 = require("../meta/sources.js");
const fabric_toolchain_js_1 = require("./fabric-toolchain.js");
/** fabric-example-mod 按精确版本分支：优先 26.1.2 → 1.21.4 → 1.21 → master */
function branchCandidates(mcVersion) {
    const out = [mcVersion];
    const parts = mcVersion.split(".");
    if (parts.length >= 3) {
        out.push(`${parts[0]}.${parts[1]}`);
    }
    out.push("main");
    out.push("master");
    return out;
}
async function scaffoldFabric(opts, log) {
    let zipUrl = null;
    for (const branch of branchCandidates(opts.mcVersion)) {
        const url = sources_js_1.META_ENDPOINTS.fabricExampleBranchZip(branch);
        if (await (0, http_js_1.urlExists)(url)) {
            log(`使用官方模板分支 ${branch}`);
            zipUrl = url;
            break;
        }
    }
    // If no codeload branch matches, fall back to GitHub archive of default branch
    if (!zipUrl) {
        const archiveUrl = sources_js_1.META_ENDPOINTS.fabricExampleHeadZip;
        if (await (0, http_js_1.urlExists)(archiveUrl)) {
            log("未找到版本分支，使用 GitHub 默认归档模板");
            zipUrl = archiveUrl;
        }
    }
    if (!zipUrl)
        throw new Error("无法获取 Fabric 官方模板");
    log("下载模板…");
    await (0, template_js_1.downloadAndExtract)(zipUrl, opts.targetDir);
    // 元数据查询失败不应中断生成：模板自带的版本号仍然可用
    log("查询 Fabric 各组件版本…");
    const [loaderVersion, apiVersion] = await Promise.all([
        (0, fabric_js_1.fetchFabricLoaderForMc)(opts.mcVersion),
        (0, fabric_js_1.fetchFabricApiVersion)(opts.mcVersion),
    ]);
    if ((0, mc_version_js_1.isUnobfuscatedMc)(opts.mcVersion)) {
        opts.mappings = "mojmap";
    }
    let yarnVersion = null;
    if (opts.mappings === "yarn" && !(0, mc_version_js_1.isUnobfuscatedMc)(opts.mcVersion)) {
        yarnVersion = await (0, fabric_js_1.fetchYarnVersion)(opts.mcVersion).catch(() => null);
        if (!yarnVersion) {
            log("⚠ 此版本暂无 Yarn 映射，切换至 MojMap");
            opts.mappings = "mojmap";
        }
    }
    // 必须先做全局占位符替换，再补丁 properties，否则新写入的值会被二次替换
    log("替换模板占位符…");
    await (0, template_js_1.adaptTemplate)(opts, {
        modIdToken: "modid",
        classToken: "ExampleMod",
        displayToken: "Example Mod",
    });
    const gradleProps = node_path_1.default.join(opts.targetDir, "gradle.properties");
    // 只有 Yarn 模式才需要写入 yarn_mappings（模板已有默认值，这里用最新获取的值覆盖）
    // MojMap / Parchment 由 applyMappings 后续通过 mappings_variant 切换
    const yarnKV = opts.mappings === "yarn" && yarnVersion ? { yarn_mappings: yarnVersion } : {};
    const patched = await (0, fsutils_js_1.patchProperties)(gradleProps, {
        minecraft_version: opts.mcVersion,
        ...yarnKV,
        loader_version: loaderVersion,
        // 不同分支的键名不同，两个都尝试
        fabric_version: apiVersion,
        fabric_api_version: apiVersion,
        mod_version: "0.1.0",
        maven_group: opts.group,
        archives_base_name: opts.modId,
    });
    log(`已更新 gradle.properties（${patched.join(", ")}）`);
    // 映射表配置（在 properties 补丁之后，以免 mappings_variant 被覆盖）
    await (0, mappings_js_1.applyMappings)(opts, log);
    await (0, fabric_toolchain_js_1.adaptFabricToolchain)(opts, log, { loaderVersion, apiVersion });
    // 模板自带的 LICENSE 是 CC0 模板文件，提醒用户自行决定
    const licenseFile = node_path_1.default.join(opts.targetDir, "LICENSE");
    if (node_fs_1.default.existsSync(licenseFile)) {
        log("注意：模板附带 CC0 LICENSE，可按需修改");
    }
}
