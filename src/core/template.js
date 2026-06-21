"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadAndExtract = downloadAndExtract;
exports.adaptTemplate = adaptTemplate;
const adm_zip_1 = __importDefault(require("adm-zip"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const http_js_1 = require("./http.js");
const fsutils_js_1 = require("./fsutils.js");
/** 下载 zip 并解压到目标目录；若 zip 仅含一个顶层目录（GitHub 归档）则自动剥掉 */
async function downloadAndExtract(url, targetDir) {
    const tmp = node_path_1.default.join(node_os_1.default.tmpdir(), `dmcl-${Date.now()}.zip`);
    try {
        await (0, http_js_1.downloadFile)(url, tmp);
        const zip = new adm_zip_1.default(tmp);
        const entries = zip.getEntries().filter((e) => !e.isDirectory);
        const roots = new Set(entries.map((e) => e.entryName.split("/")[0]));
        const strip = roots.size === 1 ? `${[...roots][0]}/` : "";
        for (const entry of entries) {
            const rel = strip && entry.entryName.startsWith(strip) ? entry.entryName.slice(strip.length) : entry.entryName;
            if (!rel)
                continue;
            const dest = node_path_1.default.join(targetDir, ...rel.split("/"));
            await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(dest), { recursive: true });
            await node_fs_1.default.promises.writeFile(dest, entry.getData());
        }
    }
    finally {
        await node_fs_1.default.promises.rm(tmp, { force: true });
    }
}
/** 通用模板改造：包名迁移 + 占位符替换 + 文件重命名 */
async function adaptTemplate(opts, tokens) {
    const target = opts.targetDir;
    const oldPkg = (await (0, fsutils_js_1.detectBasePackage)(target)) ?? "com.example";
    const newPkg = opts.group;
    const oldPath = oldPkg.split(".").join("/");
    const newPath = newPkg.split(".").join("/");
    // 顺序很重要：先替换完整包名（可能包含 modIdToken），再替换其余占位符
    await (0, fsutils_js_1.replaceInProject)(target, [
        [oldPkg, newPkg],
        [oldPath, newPath],
        [tokens.classToken, opts.className],
        [tokens.displayToken, opts.displayName],
        [tokens.modIdToken, opts.modId],
    ]);
    await (0, fsutils_js_1.movePathSegments)(target, oldPath, newPath);
    await (0, fsutils_js_1.renamePathsContaining)(target, tokens.classToken, opts.className);
    await (0, fsutils_js_1.renamePathsContaining)(target, tokens.modIdToken, opts.modId);
}
