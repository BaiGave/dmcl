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
  version: 2;
  scanDirs: string[];
  /** 用户「仅移除登记」的路径，扫描时跳过 */
  excludedPaths: string[];
}

export type MatrixCellStatus =
  | "built"
  | "failed"
  | "building"
  | "exists"
  | "verified"
  | "verification-failed"
  | "available"
  | "unsupported";

export interface MatrixCell {
  loader: LoaderId;
  mcVersion: string;
  status: MatrixCellStatus;
  variantId?: string;
  verification?: {
    state: "verified" | "build-only" | "failed" | "unknown";
    buildVerified: boolean;
    clientVerified: boolean;
    updatedAt?: string;
    failureSummary?: string;
  };
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
