export type LoaderId = "fabric" | "forge" | "neoforge";

export const LOADER_LABELS: Record<LoaderId, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
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
}

export type Logger = (msg: string) => void;
