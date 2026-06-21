"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAPPINGS = exports.MAPPINGS_FOR_LOADER = exports.MAPPINGS_LABELS = exports.LOADER_LABELS = exports.SIDE_LAYOUT_HINTS = exports.SIDE_LAYOUT_LABELS = void 0;
exports.SIDE_LAYOUT_LABELS = {
    unified: "客户端 + 服务端一起（单源码集）",
    split: "客户端 / 通用分离（main + client）",
    client: "仅客户端",
    server: "仅服务端",
};
exports.SIDE_LAYOUT_HINTS = {
    unified: "结构最简单，适合入门和小型双端模组；注意别把渲染、按键等客户端 API 写进会在服务端执行的代码。",
    split: "推荐大多数双端模组：Loom 在编译期隔离客户端代码，与 Fabric 官方模板一致，后期维护更安全。",
    client: "适合 HUD、渲染、按键等纯客户端功能；不能装在无客户端的专用服务器上。",
    server: "适合玩法机制、指令、数据逻辑等；玩家客户端不必安装（联机时只装服务端即可）。",
};
exports.LOADER_LABELS = {
    fabric: "Fabric",
    forge: "Forge",
    neoforge: "NeoForge",
};
exports.MAPPINGS_LABELS = {
    yarn: "Yarn（社区映射）",
    mojmap: "官方默认映射",
    parchment: "Parchment（参数名映射）",
    mcp: "MCP（旧版 Forge 映射）",
};
/** 用户可选映射（经联网探测；不含对每个版本硬编码的 MojMap） */
exports.MAPPINGS_FOR_LOADER = {
    fabric: ["yarn", "parchment"],
    forge: ["mcp", "parchment"],
    neoforge: ["parchment"],
};
/** 生成项目时的回退默认（Forge/NeoForge 模板内置官方映射） */
exports.DEFAULT_MAPPINGS = {
    fabric: "yarn",
    forge: "mojmap",
    neoforge: "mojmap",
};
