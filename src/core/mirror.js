"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyChinaMirror = applyChinaMirror;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/** 将 Gradle wrapper 分发地址切换为腾讯云镜像（国内下载提速明显） */
async function applyChinaMirror(targetDir, log) {
    const wrapperProps = node_path_1.default.join(targetDir, "gradle", "wrapper", "gradle-wrapper.properties");
    if (!node_fs_1.default.existsSync(wrapperProps)) {
        log("未找到 gradle-wrapper.properties，跳过镜像配置");
        return;
    }
    let content = await node_fs_1.default.promises.readFile(wrapperProps, "utf8");
    const before = content;
    content = content.replace(/services\.gradle\.org\/distributions/g, "mirrors.cloud.tencent.com/gradle");
    if (content !== before) {
        await node_fs_1.default.promises.writeFile(wrapperProps, content, "utf8");
        log("Gradle 下载源已切换至腾讯云镜像");
    }
}
