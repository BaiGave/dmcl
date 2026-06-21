"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDmclHome = resolveDmclHome;
exports.getDmclHome = getDmclHome;
exports.ensureDmclHome = ensureDmclHome;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * DMCL 的可写数据根目录。
 *
 * 优先级：DMCL_HOME > EXE 旁 portable.flag > 平台本地数据目录。
 * 该路径不依赖安装目录，打包到 Program Files 后仍然可写。
 */
function resolveDmclHome(options = {}) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const homeDir = options.homeDir ?? node_os_1.default.homedir();
    const execPath = node_path_1.default.resolve(options.execPath ?? process.execPath);
    const fileExists = options.fileExists ?? node_fs_1.default.existsSync;
    const configured = env.DMCL_HOME?.trim();
    if (configured)
        return node_path_1.default.resolve(configured);
    const executableDir = node_path_1.default.dirname(execPath);
    if (fileExists(node_path_1.default.join(executableDir, "portable.flag"))) {
        return node_path_1.default.join(executableDir, "data");
    }
    if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA
            ?? node_path_1.default.join(homeDir, "AppData", "Local");
        return node_path_1.default.join(localAppData, "DMCL");
    }
    if (platform === "darwin") {
        return node_path_1.default.join(homeDir, "Library", "Application Support", "DMCL");
    }
    const dataHome = env.XDG_DATA_HOME ?? node_path_1.default.join(homeDir, ".local", "share");
    return node_path_1.default.join(dataHome, "dmcl");
}
function getDmclHome() {
    return resolveDmclHome();
}
function ensureDmclHome() {
    const root = getDmclHome();
    node_fs_1.default.mkdirSync(root, { recursive: true });
    return root;
}
