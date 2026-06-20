export const LOADERS = [
  { id: "fabric", label: "Fabric", hint: "轻量、更新快" },
  { id: "forge", label: "Forge", hint: "经典生态" },
  { id: "neoforge", label: "NeoForge", hint: "现代分支" },
] as const;

export const LOADER_LABELS: Record<string, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
};

export const SIDE_LAYOUT_OPTIONS = [
  { id: "split", label: "客户端 / 通用分离（main + client）" },
  { id: "unified", label: "客户端 + 服务端一起（单源码集）" },
  { id: "client", label: "仅客户端" },
  { id: "server", label: "仅服务端" },
] as const;

export const SIDE_LAYOUT_HINTS: Record<string, string> = {
  unified: "结构最简单，适合入门和小型双端模组；注意别把渲染、按键等客户端 API 写进会在服务端执行的代码。",
  split: "推荐大多数双端模组：Loom 在编译期隔离客户端代码，与 Fabric 官方模板一致，后期维护更安全。",
  client: "适合 HUD、渲染、按键等纯客户端功能；不能装在无客户端的专用服务器上。",
  server: "适合玩法机制、指令、数据逻辑等；玩家客户端不必安装（联机时只装服务端即可）。",
};

/** 鼠标悬浮选项时显示的短提示 */
export const SIDE_LAYOUT_HOVER_TIPS: Record<string, string> = {
  unified: "适合新手 · 单源码集，入门首选",
  split: "适合中大型双端模组 · 编译期隔离客户端代码",
  client: "纯客户端功能 · 不能装专用服",
  server: "纯服务端玩法 · 客户端不必安装",
};

export const STATUS_LABELS: Record<string, string> = {
  active: "开发中",
  paused: "暂停",
  released: "已发布",
};
