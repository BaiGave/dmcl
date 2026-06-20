export type LoaderId = "fabric" | "forge" | "neoforge";
export type MappingsId = "yarn" | "mojmap" | "parchment" | "mcp";

/** 模组运行端与源码结构：双端一起 / 分源 / 仅客户端 / 仅服务端 */
export type SideLayoutId = "unified" | "split" | "client" | "server";

export const SIDE_LAYOUT_LABELS: Record<SideLayoutId, string> = {
  unified: "客户端 + 服务端一起（单源码集）",
  split: "客户端 / 通用分离（main + client）",
  client: "仅客户端",
  server: "仅服务端",
};

export const SIDE_LAYOUT_HINTS: Record<SideLayoutId, string> = {
  unified: "结构最简单，适合入门和小型双端模组；注意别把渲染、按键等客户端 API 写进会在服务端执行的代码。",
  split: "推荐大多数双端模组：Loom 在编译期隔离客户端代码，与 Fabric 官方模板一致，后期维护更安全。",
  client: "适合 HUD、渲染、按键等纯客户端功能；不能装在无客户端的专用服务器上。",
  server: "适合玩法机制、指令、数据逻辑等；玩家客户端不必安装（联机时只装服务端即可）。",
};

export const LOADER_LABELS: Record<LoaderId, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
};

export const MAPPINGS_LABELS: Record<MappingsId, string> = {
  yarn: "Yarn（社区映射）",
  mojmap: "官方默认映射",
  parchment: "Parchment（参数名映射）",
  mcp: "MCP（旧版 Forge 映射）",
};

/** 用户可选映射（经联网探测；不含对每个版本硬编码的 MojMap） */
export const MAPPINGS_FOR_LOADER: Record<LoaderId, MappingsId[]> = {
  fabric: ["yarn", "parchment"],
  forge: ["mcp", "parchment"],
  neoforge: ["parchment"],
};

/** 生成项目时的回退默认（Forge/NeoForge 模板内置官方映射） */
export const DEFAULT_MAPPINGS: Record<LoaderId, MappingsId> = {
  fabric: "yarn",
  forge: "mojmap",
  neoforge: "mojmap",
};

export interface ProjectOptions {
  loader: LoaderId;
  mcVersion: string;
  /** 模组 ID，全小写，如 mymod */
  modId: string;
  /** 模组显示名，如 My Mod */
  displayName: string;
  /** 主类名（PascalCase），如 MyMod */
  className: string;
  /** Java 包名 / Maven group，如 com.example.mymod */
  group: string;
  /** 生成目录（绝对路径） */
  targetDir: string;
  /** 是否使用国内镜像加速 */
  mirror: boolean;
  /** 映射表选择 */
  mappings: MappingsId;
  /** 运行端与源码结构；省略时按加载器与 MC 版本自动选择 */
  sideLayout?: SideLayoutId;
}

export type Logger = (msg: string) => void;
