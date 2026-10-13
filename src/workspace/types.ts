import type { LoaderId, MappingsId } from "../types.js";

export type ModStatus = "active" | "paused" | "released";
/** Legacy single-word status (matrix, catalog export). "building" is never written to disk any more. */
export type BuildStatus = "unknown" | "success" | "failed" | "building" | "running" | "cancelled";

export type JobKind = "build" | "run";

/** How the last finished job of a variant ended; stored in .dmcl/variant.json. */
export interface VariantResult {
  kind: JobKind;
  state: "succeeded" | "failed" | "cancelled";
  /** ISO time the job finished. */
  at: string;
  reason: string | null;
  /** Furthest phase the job reached (see src/launch/phases.ts). */
  phaseReached: string | null;
  startedAt?: string;
  durationMs?: number;
  /** run: process start to title screen. */
  timeToTitleMs?: number;
  /** Major version of the JDK Gradle ran on. */
  javaMajor?: number | null;
  exitCode?: number | null;
}

/** What the GUI shows per variant: the active job if any, else the last result. */
export interface VariantStatus {
  state: "unknown" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  kind: JobKind | null;
  at: string | null;
  reason: string | null;
  phaseReached: string | null;
  activeJobId: string | null;
}
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
  /** Last finished build/run (persisted). */
  lastResult?: VariantResult;
  /** Active job or last result, for the GUI. */
  status?: VariantStatus;
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
