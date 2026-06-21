"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSideLayout = parseSideLayout;
exports.defaultSideLayout = defaultSideLayout;
exports.resolveSideLayout = resolveSideLayout;
exports.effectiveSideLayout = effectiveSideLayout;
exports.wantsSplitSources = wantsSplitSources;
exports.applySideLayout = applySideLayout;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const fsutils_js_1 = require("./fsutils.js");
const mc_version_js_1 = require("../meta/mc-version.js");
const types_js_1 = require("../types.js");
const VALID = ["unified", "split", "client", "server"];
function parseSideLayout(raw) {
    if (!raw)
        return null;
    return VALID.includes(raw) ? raw : null;
}
/** 默认单源码集（客户端与服务端逻辑写在一起） */
function defaultSideLayout(_loader, _mcVersion) {
    return "unified";
}
function resolveSideLayout(opts) {
    return opts.sideLayout ?? defaultSideLayout(opts.loader, opts.mcVersion);
}
/** 按 MC 版本解析实际生效的布局（如旧版 Fabric 不支持分源时回退为一起） */
function effectiveSideLayout(opts) {
    const layout = resolveSideLayout(opts);
    if (layout === "split" && opts.loader === "fabric" && !(0, mc_version_js_1.supportsSplitSources)(opts.mcVersion)) {
        return "unified";
    }
    return layout;
}
/** Fabric 是否启用 Loom splitEnvironmentSourceSets */
function wantsSplitSources(opts) {
    if (opts.loader !== "fabric" || !(0, mc_version_js_1.supportsSplitSources)(opts.mcVersion))
        return false;
    const layout = effectiveSideLayout(opts);
    return layout === "split" || layout === "client";
}
async function removePathIfExists(p) {
    if (node_fs_1.default.existsSync(p))
        await node_fs_1.default.promises.rm(p, { recursive: true, force: true });
}
const DEMO_MIXIN_FILE = /^(ExampleMixin|ExampleClientMixin|ClientMixin)\.java$/;
/** 移除 client 分源与示例 mixin，并同步清理 mixins 配置（避免类已删但 json 仍引用） */
async function removeFabricClientArtifacts(targetDir, group, log) {
    await removePathIfExists(node_path_1.default.join(targetDir, "src", "client"));
    const groupPath = group.split(".").join(node_path_1.default.sep);
    await removePathIfExists(node_path_1.default.join(targetDir, "src", "main", "java", groupPath, "client"));
    const removedMixinNames = new Set();
    for (const file of await (0, fsutils_js_1.walkFiles)(targetDir)) {
        if (!file.endsWith(".java"))
            continue;
        const base = node_path_1.default.basename(file);
        if (/ModClient\.java$/.test(base) || DEMO_MIXIN_FILE.test(base)) {
            removedMixinNames.add(base.replace(/\.java$/, ""));
            await node_fs_1.default.promises.rm(file, { force: true });
        }
    }
    const resRoot = node_path_1.default.join(targetDir, "src", "main", "resources");
    const removedMixinConfigs = new Set();
    if (node_fs_1.default.existsSync(resRoot)) {
        for (const entry of await node_fs_1.default.promises.readdir(resRoot)) {
            if (entry.includes("client") && entry.endsWith(".mixins.json")) {
                removedMixinConfigs.add(entry);
                await node_fs_1.default.promises.rm(node_path_1.default.join(resRoot, entry), { force: true });
            }
        }
    }
    for (const file of await (0, fsutils_js_1.walkFiles)(targetDir)) {
        if (!file.endsWith(".mixins.json"))
            continue;
        const doc = JSON.parse(await node_fs_1.default.promises.readFile(file, "utf8"));
        doc.mixins = (doc.mixins ?? []).filter((name) => !removedMixinNames.has(name));
        if (Array.isArray(doc.client)) {
            doc.client = doc.client.filter((name) => !removedMixinNames.has(name));
            if (doc.client.length === 0)
                delete doc.client;
        }
        const remaining = (doc.mixins?.length ?? 0) + (doc.client?.length ?? 0);
        if (remaining === 0) {
            removedMixinConfigs.add(node_path_1.default.basename(file));
            await node_fs_1.default.promises.rm(file, { force: true });
            continue;
        }
        await node_fs_1.default.promises.writeFile(file, JSON.stringify(doc, null, "\t") + "\n", "utf8");
    }
    const modJson = node_path_1.default.join(resRoot, "fabric.mod.json");
    if (node_fs_1.default.existsSync(modJson)) {
        const doc = JSON.parse(node_fs_1.default.readFileSync(modJson, "utf8"));
        if (doc.entrypoints?.client)
            delete doc.entrypoints.client;
        if (Array.isArray(doc.mixins)) {
            doc.mixins = doc.mixins.filter((m) => {
                if (typeof m !== "string")
                    return false;
                return !removedMixinConfigs.has(m);
            });
            if (doc.mixins.length === 0)
                delete doc.mixins;
        }
        delete doc.environment;
        node_fs_1.default.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
    }
    log("已移除 Fabric 客户端示例与分源目录，并同步清理 mixin 配置");
}
async function applyFabricSideLayout(opts, layout, log) {
    const modJsonPath = node_path_1.default.join(opts.targetDir, "src", "main", "resources", "fabric.mod.json");
    if (!node_fs_1.default.existsSync(modJsonPath))
        return;
    if (layout === "unified" || layout === "server") {
        await removeFabricClientArtifacts(opts.targetDir, opts.group, log);
    }
    if (layout === "client") {
        const doc = JSON.parse(node_fs_1.default.readFileSync(modJsonPath, "utf8"));
        doc.environment = "client";
        if (doc.entrypoints?.main)
            delete doc.entrypoints.main;
        node_fs_1.default.writeFileSync(modJsonPath, JSON.stringify(doc, null, "\t") + "\n", "utf8");
        log("已配置为仅客户端模组（fabric.mod.json environment=client）");
    }
    if (layout === "server") {
        log("已配置为仅服务端模组（保留 main 入口，移除客户端入口与示例）");
    }
    if (layout === "split") {
        log("已保留 Fabric 官方分源结构（main + client）");
    }
    if (layout === "unified") {
        log("已合并为单源码集（客户端与服务端逻辑均写在 src/main）");
    }
}
async function applyForgeSideLayout(opts, layout, log) {
    if (layout === "split") {
        log("Forge / NeoForge 使用单一 src/main 源码集（分源选项与此等效）");
    }
    for (const file of await (0, fsutils_js_1.walkFiles)(opts.targetDir)) {
        if (!file.endsWith(".java"))
            continue;
        let content = await node_fs_1.default.promises.readFile(file, "utf8");
        if (layout === "server") {
            if (/EventBusSubscriber[\s\S]*Dist\.CLIENT/.test(content) || /Dist\.CLIENT[\s\S]*EventBusSubscriber/.test(content)) {
                await node_fs_1.default.promises.rm(file, { force: true });
                log(`已移除客户端订阅类：${node_path_1.default.basename(file)}`);
                continue;
            }
            if (/Mod\.EventBusSubscriber\s*\([^)]*Dist\.CLIENT/.test(content)) {
                await node_fs_1.default.promises.rm(file, { force: true });
                log(`已移除客户端订阅类：${node_path_1.default.basename(file)}`);
                continue;
            }
        }
        if (layout === "client") {
            if (!/@Mod\s*\(/.test(content))
                continue;
            if (content.includes("dist = Dist.CLIENT"))
                continue;
            if (!content.includes("net.neoforged.api.distmarker.Dist") && !content.includes("net.minecraftforge.api.distmarker.Dist")) {
                const distImport = opts.loader === "neoforge"
                    ? "import net.neoforged.api.distmarker.Dist;\n"
                    : "import net.minecraftforge.api.distmarker.Dist;\n";
                content = content.replace(/^(package[^\n]+\n)/, `$1${distImport}`);
            }
            content = content.replace(/@Mod\s*\(\s*([^)]+)\s*\)/, (_, inner) => {
                if (/dist\s*=/.test(inner))
                    return `@Mod(${inner})`;
                const trimmed = inner.trim();
                if (/^[A-Za-z_][\w.]*$/.test(trimmed)) {
                    return `@Mod(value = ${trimmed}, dist = Dist.CLIENT)`;
                }
                return `@Mod(${inner}, dist = Dist.CLIENT)`;
            });
            await node_fs_1.default.promises.writeFile(file, content, "utf8");
            log("已配置为仅客户端模组（@Mod dist = Dist.CLIENT）");
            return;
        }
    }
}
/** 按用户选择调整模板中的运行端与源码结构 */
async function applySideLayout(opts, log) {
    const requested = resolveSideLayout(opts);
    const layout = effectiveSideLayout(opts);
    if (layout !== requested) {
        log(`⚠ 此 MC 版本不支持分源，运行端布局已由「${types_js_1.SIDE_LAYOUT_LABELS[requested]}」调整为「${types_js_1.SIDE_LAYOUT_LABELS[layout]}」`);
    }
    log(`运行端布局：${types_js_1.SIDE_LAYOUT_LABELS[layout]}`);
    if (opts.loader === "fabric") {
        await applyFabricSideLayout(opts, layout, log);
        return;
    }
    if (layout === "unified") {
        log("使用单一 src/main 源码集（客户端与服务端逻辑写在一起）");
        return;
    }
    await applyForgeSideLayout(opts, layout, log);
}
