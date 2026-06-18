export type LoaderId = "fabric" | "forge" | "neoforge";
export type MappingsId = "yarn" | "mojmap" | "parchment";

export const LOADER_LABELS: Record<LoaderId, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
};

export const MAPPINGS_LABELS: Record<MappingsId, string> = {
  yarn: "Yarn（社区映射）",
  mojmap: "官方默认映射",
  parchment: "Parchment（参数名映射）",
};

/** 用户可选映射（经联网探测；不含对每个版本硬编码的 MojMap） */
export const MAPPINGS_FOR_LOADER: Record<LoaderId, MappingsId[]> = {
  fabric: ["yarn", "parchment"],
  forge: ["parchment"],
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
}

export type Logger = (msg: string) => void;
