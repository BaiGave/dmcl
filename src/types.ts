export type LoaderId = "fabric" | "forge" | "neoforge";
export type MappingsId = "yarn" | "mojmap" | "parchment";

export const LOADER_LABELS: Record<LoaderId, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
};

export const MAPPINGS_LABELS: Record<MappingsId, string> = {
  yarn: "Yarn（社区映射，默认）",
  mojmap: "MojMap（官方映射）",
  parchment: "Parchment（MojMap + 参数名）",
};

/** 各加载器支持的映射表选项 */
export const MAPPINGS_FOR_LOADER: Record<LoaderId, MappingsId[]> = {
  fabric: ["yarn", "mojmap", "parchment"],
  forge: ["mojmap", "parchment"],
  neoforge: ["mojmap", "parchment"],
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
