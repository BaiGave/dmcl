"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyMappings = applyMappings;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const fsutils_js_1 = require("./fsutils.js");
const mc_version_js_1 = require("../meta/mc-version.js");
const parchment_js_1 = require("../meta/parchment.js");
/**
 * 根据 mappings 选择，修改项目的 gradle.properties 和 build.gradle / settings.gradle。
 * 调用时机：占位符替换之后，镜像注入之前。
 */
async function applyMappings(opts, log) {
    if (opts.loader === "fabric") {
        await applyFabricMappings(opts, log);
    }
    else {
        await applyParchmentForForge(opts, log);
    }
}
async function applyFabricMappings(opts, log) {
    if ((0, mc_version_js_1.isUnobfuscatedMc)(opts.mcVersion)) {
        log("此版本官方未混淆，无需配置映射表");
        return;
    }
    const propsFile = node_path_1.default.join(opts.targetDir, "gradle.properties");
    const settingsFile = node_path_1.default.join(opts.targetDir, "settings.gradle");
    // ---- Parchment 需要先检查可用性，再决定是否切 mappings_variant ----
    if (opts.mappings === "parchment") {
        const parchmentVer = await (0, parchment_js_1.fetchParchmentVersion)(opts.mcVersion);
        if (!parchmentVer) {
            log("⚠ 未找到该版本的 Parchment 映射，退回使用 MojMap");
            opts.mappings = "mojmap"; // 回退到 MojMap（Parchment 基于 MojMap，这是最近的回退）
            // 继续往下走到 mojmap 分支
        }
        else {
            log(`使用 Parchment ${parchmentVer}`);
            // Parchment = MojMap variant + 参数名，所以先切 mappings_variant
            await (0, fsutils_js_1.patchProperties)(propsFile, { mappings_variant: "minecraft" });
            log("已设置 mappings_variant=minecraft");
            // 追加 parchment 属性
            await (0, fsutils_js_1.patchProperties)(propsFile, {
                parchment_minecraft_version: opts.mcVersion,
                parchment_version: parchmentVer,
            });
            // settings.gradle 追加 parchment maven 仓库
            if (node_fs_1.default.existsSync(settingsFile)) {
                let settingsContent = await node_fs_1.default.promises.readFile(settingsFile, "utf8");
                if (!settingsContent.includes("parchmentmc")) {
                    settingsContent = settingsContent.replace(/(dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{)/, `$1\n        maven { url = "https://maven.parchmentmc.org/" }`);
                    await node_fs_1.default.promises.writeFile(settingsFile, settingsContent, "utf8");
                    log("已注入 Parchment Maven 仓库到 settings.gradle");
                }
            }
            return;
        }
    }
    // ---- MojMap（包括 Parchment 回退后走到这里） ----
    if (opts.mappings === "mojmap") {
        const patched = await (0, fsutils_js_1.patchProperties)(propsFile, { mappings_variant: "minecraft" });
        if (patched.length)
            log("已设置 mappings_variant=minecraft");
    }
    // Yarn：模板默认即 Yarn，无需改动
}
async function applyParchmentForForge(opts, log) {
    if (opts.mappings !== "parchment")
        return; // Forge/NeoForge 默认就是 MojMap
    const parchmentVer = await (0, parchment_js_1.fetchParchmentVersion)(opts.mcVersion);
    if (!parchmentVer) {
        log("⚠ 未找到该版本的 Parchment 映射，继续使用默认 MojMap");
        return;
    }
    log(`使用 Parchment ${parchmentVer}`);
    const propsFile = node_path_1.default.join(opts.targetDir, "gradle.properties");
    await (0, fsutils_js_1.patchProperties)(propsFile, {
        parchment_version: parchmentVer,
    });
    // Forge/NeoForge: 在 build.gradle 的 dependencies 块之前注入 parchment maven
    const buildFile = node_path_1.default.join(opts.targetDir, "build.gradle");
    if (node_fs_1.default.existsSync(buildFile)) {
        let content = await node_fs_1.default.promises.readFile(buildFile, "utf8");
        if (!content.includes("parchmentmc")) {
            const snippet = [
                "repositories {",
                "    maven { url = \"https://maven.parchmentmc.org/\" }",
                "}",
                "",
            ].join("\n");
            // 插入到文件顶部第一个 import/plugin/buildscript 之后
            const insertAfter = /(plugins\s*\{[\s\S]*?\})/;
            if (insertAfter.test(content)) {
                content = content.replace(insertAfter, `$1\n\n${snippet}`);
            }
            else {
                content = `${snippet}\n${content}`;
            }
            await node_fs_1.default.promises.writeFile(buildFile, content, "utf8");
            log("已注入 Parchment Maven 仓库到 build.gradle");
        }
    }
}
