"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeCursorConfig = writeCursorConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/** 生成 Cursor / VS Code 工作区配置与扩展推荐 */
async function writeCursorConfig(targetDir) {
    const dir = node_path_1.default.join(targetDir, ".vscode");
    await node_fs_1.default.promises.mkdir(dir, { recursive: true });
    const settings = {
        "java.import.gradle.enabled": true,
        "java.configuration.updateBuildConfiguration": "automatic",
        "files.eol": "\n",
    };
    const extensions = {
        recommendations: ["vscjava.vscode-java-pack", "vscjava.vscode-gradle"],
    };
    await node_fs_1.default.promises.writeFile(node_path_1.default.join(dir, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf8");
    await node_fs_1.default.promises.writeFile(node_path_1.default.join(dir, "extensions.json"), JSON.stringify(extensions, null, 2) + "\n", "utf8");
}
