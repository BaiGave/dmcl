import type { LoaderId, MappingsId } from "../types.js";

export type ModStatus = "active" | "paused" | "released";
export type BuildStatus = "unknown" | "success" | "failed" | "building";
export type VariantSource = "dmcl" | "imported";

export interface ModVariant {
  id: string;
  loader: LoaderId;
  mcVersion: string;
  projectPath: string;
  modVersion: string;
  group: string;
  mappings: MappingsId;
  buildStatus: BuildStatus;
  lastBuiltAt?: string;
  source: VariantSource;
  createdAt: string;
  /** 刷新时检测到项目目录不存在 */
  pathMissing?: boolean;
}

export interface ManagedMod {
  id: string;
  modId: string;
  displayName: string;
  description?: string;
  status: ModStatus;
  createdAt: string;
  updatedAt: string;
  variants: ModVariant[];
}

export interface WorkspaceData {
  version: 1;
  scanDirs: string[];
  /** 用户主动移除的路径，自动扫描时不再导入 */
  excludedPaths: string[];
  mods: ManagedMod[];
}

export type MatrixCellStatus =
  | "built"
  | "failed"
  | "building"
  | "exists"
  | "available"
  | "unsupported";

export interface MatrixCell {
  loader: LoaderId;
  mcVersion: string;
  status: MatrixCellStatus;
  variantId?: string;
}

export interface BuildLogEntry {
  id: string;
  variantId: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  logPath: string;
}

export interface WorkspaceSettings {
  defaultParentDir?: string;
  mirror: boolean;
}

export interface DetectedProject {
  loader: LoaderId;
  mcVersion: string;
  modId: string;
  displayName: string;
  modVersion: string;
  group: string;
  mappings: MappingsId;
  projectPath: string;
}
