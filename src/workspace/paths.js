"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setRepoRoot = setRepoRoot;
exports.setProjectsRoot = setProjectsRoot;
exports.getRepoRoot = getRepoRoot;
exports.getProjectsRoot = getProjectsRoot;
exports.getModDir = getModDir;
exports.variantFolderName = variantFolderName;
exports.defaultVariantPath = defaultVariantPath;
exports.ensureProjectsRoot = ensureProjectsRoot;
exports.variantDirName = variantDirName;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_url_1 = require("node:url");
const validate_js_1 = require("./validate.js");
let repoRoot = null;
let projectsRoot = null;
/** 由 GUI 启动时注入；未注入时从 dist/workspace 向上推断仓库根目录 */
function setRepoRoot(root) {
    repoRoot = node_path_1.default.resolve(root);
}
/** 安装版注入可写数据目录；开发模式省略时仍使用仓库下的 projects。 */
function setProjectsRoot(root) {
    projectsRoot = node_path_1.default.resolve(root);
}
function getRepoRoot() {
    if (repoRoot)
        return repoRoot;
    const here = node_path_1.default.dirname((0, node_url_1.fileURLToPath)(import.meta.url));
    return node_path_1.default.resolve(here, "..", "..");
}
/** 所有模组项目的根目录：{repo}/projects */
function getProjectsRoot() {
    return projectsRoot ?? node_path_1.default.join(getRepoRoot(), "projects");
}
/** 单个模组的目录：{repo}/projects/{modId} */
function getModDir(modId) {
    return node_path_1.default.join(getProjectsRoot(), modId);
}
/** 变体文件夹名：{loader}-{mcVersion}，如 fabric-1.21.4 */
function variantFolderName(loader, mcVersion) {
    return `${loader}-${mcVersion}`;
}
/** 变体项目默认绝对路径：{repo}/projects/{modId}/{loader}-{mc}/ */
function defaultVariantPath(modId, loader, mcVersion) {
    (0, validate_js_1.assertValidModId)(modId);
    const target = node_path_1.default.join(getModDir(modId), variantFolderName(loader, mcVersion));
    const root = node_path_1.default.resolve(getProjectsRoot()) + node_path_1.default.sep;
    const resolved = node_path_1.default.resolve(target);
    if (!resolved.startsWith(root)) {
        throw new Error("变体路径超出 projects 目录");
    }
    return target;
}
/** 确保 projects 目录存在 */
function ensureProjectsRoot() {
    const root = getProjectsRoot();
    node_fs_1.default.mkdirSync(root, { recursive: true });
    return root;
}
/** @deprecated 使用 variantFolderName */
function variantDirName(modId, loader, mcVersion) {
    return variantFolderName(loader, mcVersion);
}
