"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.injectMavenMirrors = injectMavenMirrors;
exports.injectBuildscriptMirrors = injectBuildscriptMirrors;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const MIRRORS = [
    // BMCLAPI 镜像 S3 后端频繁 403，已移除。
    // 仅保留 Alibaba Maven 镜像。
    { name: "Alibaba", url: "https://maven.aliyun.com/repository/public" },
];
/** 从 openBrace 的 `{` 起找匹配的 `}`，跳过字符串与注释 */
function findMatchingBraceEnd(content, openBracePos) {
    let depth = 1;
    let i = openBracePos + 1;
    while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === "/" && content[i + 1] === "/") {
            i += 2;
            while (i < content.length && content[i] !== "\n")
                i++;
            continue;
        }
        if (ch === "/" && content[i + 1] === "*") {
            i += 2;
            while (i < content.length - 1 && !(content[i] === "*" && content[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++;
            while (i < content.length && content[i] !== quote) {
                if (content[i] === "\\")
                    i++;
                i++;
            }
            i++;
            continue;
        }
        if (ch === "{")
            depth++;
        else if (ch === "}")
            depth--;
        i++;
    }
    return i;
}
/**
 * 在 settings.gradle / build.gradle 中注入国内 Maven 镜像。
 * 策略：在已有的 repositories {} 顶部插入 mirror，覆盖默认 Maven Central。
 */
async function injectMavenMirrors(targetDir, log) {
    const settingsFile = node_path_1.default.join(targetDir, "settings.gradle");
    if (!node_fs_1.default.existsSync(settingsFile)) {
        log("未找到 settings.gradle，跳过 Maven 镜像注入");
        return;
    }
    let content = await node_fs_1.default.promises.readFile(settingsFile, "utf8");
    // 生成 mirror 代码片段
    const snippet = MIRRORS.map((m) => `        maven { name = "${m.name}"; url = "${m.url}" }`).join("\n");
    // 在 pluginManagement.repositories { 内部注入
    if (/pluginManagement\s*\{/.test(content)) {
        content = content.replace(/(pluginManagement\s*\{[\s\S]*?repositories\s*\{)/, `$1\n${snippet}`);
    }
    // 在 dependencyResolutionManagement.repositories { 内部注入
    if (/dependencyResolutionManagement\s*\{/.test(content)) {
        content = content.replace(/(dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{)/, `$1\n${snippet}`);
    }
    // 通用：第一个 repositories { 块注入（避免重复）
    if (!content.includes("Alibaba")) {
        content = content.replace(/(repositories\s*\{)/, `$1\n${snippet}`);
    }
    await node_fs_1.default.promises.writeFile(settingsFile, content, "utf8");
    log("Maven 仓库已切换至国内镜像（Alibaba）");
}
/**
 * 在 build.gradle 中注入国内镜像（适用于 Forge MDK 等使用 buildscript 的项目）。
 */
async function injectBuildscriptMirrors(targetDir, log) {
    const buildFile = node_path_1.default.join(targetDir, "build.gradle");
    if (!node_fs_1.default.existsSync(buildFile))
        return;
    let content = await node_fs_1.default.promises.readFile(buildFile, "utf8");
    if (content.includes("Alibaba"))
        return;
    const snippet = MIRRORS.map((m) => `        maven { url "${m.url}" }`).join("\n");
    const bsBlocks = [];
    let processed = "";
    let cursor = 0;
    const bsStart = /buildscript\s*\{/g;
    let match;
    while ((match = bsStart.exec(content)) !== null) {
        processed += content.slice(cursor, match.index);
        const openBrace = match.index + match[0].length - 1;
        const end = findMatchingBraceEnd(content, openBrace);
        const block = content.slice(match.index, end);
        const injected = block.replace(/(repositories\s*\{)/, `$1\n${snippet}`);
        bsBlocks.push(injected);
        processed += `__DMCL_BS_${bsBlocks.length - 1}__`;
        cursor = end;
        bsStart.lastIndex = end;
    }
    processed += content.slice(cursor);
    // Inject mirror into standalone repositories (not inside buildscript)
    processed = processed.replace(/(repositories\s*\{)/, `$1\n${snippet}`);
    // Reassemble: restore buildscript blocks
    content = processed.replace(/__DMCL_BS_(\d+)__/g, (_m, idx) => bsBlocks[Number(idx)]);
    await node_fs_1.default.promises.writeFile(buildFile, content, "utf8");
    log("build.gradle 已注入 Maven 镜像");
}
