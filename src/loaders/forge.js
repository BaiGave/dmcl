"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scaffoldForge = scaffoldForge;
const node_path_1 = __importDefault(require("node:path"));
const http_js_1 = require("../core/http.js");
const template_js_1 = require("../core/template.js");
const fsutils_js_1 = require("../core/fsutils.js");
const mappings_js_1 = require("../core/mappings.js");
const forge_js_1 = require("../meta/forge.js");
async function scaffoldForge(opts, log) {
    const forgeVersion = await (0, forge_js_1.pickForgeVersion)(opts.mcVersion);
    if (!forgeVersion) {
        throw new Error(`Forge 不支持 Minecraft ${opts.mcVersion}`);
    }
    const url = (0, forge_js_1.forgeMdkUrl)(opts.mcVersion, forgeVersion);
    if (!(await (0, http_js_1.urlExists)(url))) {
        throw new Error(`该版本的 Forge MDK 不存在（过老的版本不提供 MDK）：${url}`);
    }
    log(`下载 Forge ${forgeVersion} MDK…`);
    await (0, template_js_1.downloadAndExtract)(url, opts.targetDir);
    // 必须先做全局占位符替换，再补丁 properties，否则新写入的值会被二次替换
    log("替换模板占位符…");
    await (0, template_js_1.adaptTemplate)(opts, {
        modIdToken: "examplemod",
        classToken: "ExampleMod",
        displayToken: "Example Mod",
    });
    const gradleProps = node_path_1.default.join(opts.targetDir, "gradle.properties");
    const patched = await (0, fsutils_js_1.patchProperties)(gradleProps, {
        mod_id: opts.modId,
        mod_name: opts.displayName,
        mod_group_id: opts.group,
        mod_version: "0.1.0",
        mod_authors: "YourName",
        mod_description: `${opts.displayName} - 使用 DMCL 生成`,
    });
    if (patched.length > 0)
        log(`已更新 gradle.properties（${patched.join(", ")}）`);
    await (0, mappings_js_1.applyMappings)(opts, log);
}
