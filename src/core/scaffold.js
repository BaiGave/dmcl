"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pascalCase = pascalCase;
exports.scaffoldProject = scaffoldProject;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const fabric_js_1 = require("../loaders/fabric.js");
const forge_js_1 = require("../loaders/forge.js");
const neoforge_js_1 = require("../loaders/neoforge.js");
const mirror_js_1 = require("./mirror.js");
const maven_js_1 = require("./maven.js");
const vscode_js_1 = require("./vscode.js");
const side_layout_js_1 = require("./side-layout.js");
const toolchain_js_1 = require("./toolchain.js");
function pascalCase(input) {
    const name = input
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("");
    return /^[A-Za-z]/.test(name) ? name : `Mod${name}`;
}
/** 下载模板、注入镜像、初始化 git — CLI 与变体生成共用 */
async function scaffoldProject(opts, log) {
    await node_fs_1.default.promises.mkdir(opts.targetDir, { recursive: true });
    if (opts.loader === "fabric")
        await (0, fabric_js_1.scaffoldFabric)(opts, log);
    else if (opts.loader === "forge")
        await (0, forge_js_1.scaffoldForge)(opts, log);
    else
        await (0, neoforge_js_1.scaffoldNeoForge)(opts, log);
    await (0, side_layout_js_1.applySideLayout)(opts, log);
    if (opts.mirror) {
        await (0, mirror_js_1.applyChinaMirror)(opts.targetDir, log);
        await (0, maven_js_1.injectMavenMirrors)(opts.targetDir, log);
        await (0, maven_js_1.injectBuildscriptMirrors)(opts.targetDir, log);
    }
    await (0, vscode_js_1.writeCursorConfig)(opts.targetDir);
    log("已生成 Cursor / VS Code 配置（.vscode）");
    await (0, toolchain_js_1.writeScaffoldMarker)(opts.targetDir, opts.loader, opts.mcVersion);
    const git = (0, node_child_process_1.spawnSync)("git", ["init", "-q"], { cwd: opts.targetDir });
    if (git.status === 0)
        log("已初始化 git 仓库");
}
