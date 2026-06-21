"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTextFile = isTextFile;
exports.walkFiles = walkFiles;
exports.replaceInProject = replaceInProject;
exports.movePathSegments = movePathSegments;
exports.renamePathsContaining = renamePathsContaining;
exports.removeEmptyDirs = removeEmptyDirs;
exports.patchProperties = patchProperties;
exports.detectBasePackage = detectBasePackage;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const TEXT_EXTENSIONS = new Set([
    ".java", ".kt", ".kts", ".groovy", ".gradle",
    ".json", ".json5", ".mcmeta", ".toml", ".properties",
    ".md", ".txt", ".cfg", ".yml", ".yaml", ".xml",
]);
function isTextFile(file) {
    return TEXT_EXTENSIONS.has(node_path_1.default.extname(file).toLowerCase());
}
async function walkFiles(dir) {
    const out = [];
    const entries = await node_fs_1.default.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = node_path_1.default.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === ".git")
                continue;
            out.push(...(await walkFiles(full)));
        }
        else {
            out.push(full);
        }
    }
    return out;
}
/** 在项目内所有文本文件中按顺序执行字符串替换 */
async function replaceInProject(root, replacements) {
    for (const file of await walkFiles(root)) {
        if (!isTextFile(file))
            continue;
        let content = await node_fs_1.default.promises.readFile(file, "utf8");
        let changed = false;
        for (const [from, to] of replacements) {
            if (from && content.includes(from)) {
                content = content.split(from).join(to);
                changed = true;
            }
        }
        if (changed)
            await node_fs_1.default.promises.writeFile(file, content, "utf8");
    }
}
/** 将路径中的包目录片段（如 com/example）迁移为新包目录 */
async function movePathSegments(root, fromSeg, toSeg) {
    if (fromSeg === toSeg)
        return;
    for (const file of await walkFiles(root)) {
        const rel = node_path_1.default.relative(root, file).split(node_path_1.default.sep).join("/");
        if (rel.startsWith(`${fromSeg}/`) || rel.includes(`/${fromSeg}/`)) {
            const newRel = rel.replace(`${fromSeg}/`, `${toSeg}/`);
            const dest = node_path_1.default.join(root, ...newRel.split("/"));
            await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(dest), { recursive: true });
            await node_fs_1.default.promises.rename(file, dest);
        }
    }
    await removeEmptyDirs(root);
}
/** 重命名文件/目录名中包含 token 的条目（先深后浅） */
async function renamePathsContaining(root, from, to) {
    if (from === to)
        return;
    const all = [];
    const collect = async (dir) => {
        for (const e of await node_fs_1.default.promises.readdir(dir, { withFileTypes: true })) {
            const full = node_path_1.default.join(dir, e.name);
            all.push({ p: full, depth: full.split(node_path_1.default.sep).length });
            if (e.isDirectory() && e.name !== ".git")
                await collect(full);
        }
    };
    await collect(root);
    all.sort((a, b) => b.depth - a.depth);
    for (const { p } of all) {
        const base = node_path_1.default.basename(p);
        if (base.includes(from)) {
            const dest = node_path_1.default.join(node_path_1.default.dirname(p), base.split(from).join(to));
            await node_fs_1.default.promises.rename(p, dest);
        }
    }
}
async function removeEmptyDirs(dir) {
    const entries = await node_fs_1.default.promises.readdir(dir, { withFileTypes: true });
    let empty = true;
    for (const e of entries) {
        const full = node_path_1.default.join(dir, e.name);
        if (e.isDirectory()) {
            const childEmpty = await removeEmptyDirs(full);
            if (childEmpty)
                await node_fs_1.default.promises.rmdir(full);
            else
                empty = false;
        }
        else {
            empty = false;
        }
    }
    return empty;
}
/** 修改 .properties 文件中已存在的键；不存在的键追加到文件末尾 */
async function patchProperties(file, entries) {
    if (!node_fs_1.default.existsSync(file))
        return [];
    let content = await node_fs_1.default.promises.readFile(file, "utf8");
    const patched = [];
    for (const [key, value] of Object.entries(entries)) {
        if (value == null)
            continue;
        const re = new RegExp(`^([ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*=).*$`, "m");
        if (re.test(content)) {
            content = content.replace(re, (_m, prefix) => `${prefix}${value}`);
            patched.push(key);
        }
        else {
            content = content.trimEnd() + `\n${key}=${value}\n`;
            patched.push(key);
        }
    }
    await node_fs_1.default.promises.writeFile(file, content, "utf8");
    return patched;
}
/** 扫描 .java 文件，返回最短的 package 声明作为模板根包名 */
async function detectBasePackage(root) {
    let shortest = null;
    for (const file of await walkFiles(root)) {
        if (node_path_1.default.extname(file) !== ".java")
            continue;
        const content = await node_fs_1.default.promises.readFile(file, "utf8");
        const m = content.match(/^\s*package\s+([\w.]+)\s*;/m);
        if (m && (shortest === null || m[1].length < shortest.length)) {
            shortest = m[1];
        }
    }
    return shortest;
}
