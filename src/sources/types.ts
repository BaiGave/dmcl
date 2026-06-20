import type { LoaderId, MappingsId } from "../types.js";

export type SourceTaskScope = "single" | "all";
export type SourceTaskState = "running" | "completed" | "failed" | "cancelled";

export interface SourceTaskRequest {
  scope: SourceTaskScope;
  loader: LoaderId;
  mcVersion?: string;
  mapping?: MappingsId;
  force?: boolean;
  mirror?: boolean;
  /** 从现有模组变体准备源码；省略时使用临时脚手架。 */
  projectPath?: string;
  projectModId?: string;
  includeDependencies?: boolean;
}

export interface SourceTarget {
  loader: LoaderId;
  mcVersion: string;
  mapping: MappingsId;
  mappingVersion: string;
}

export interface SourceArtifactRecord {
  role: string;
  path: string;
  sha256: string;
  size: number;
}

export interface MinecraftSourceManifest {
  schema: 1;
  minecraftVersion: string;
  loader: LoaderId;
  loaderVersion?: string;
  mapping: MappingsId;
  mappingVersion: string;
  sourceKind: "loader-sources" | "cfr-decompile";
  decompiler?: { name: "CFR"; version: string };
  javaFiles: number;
  generatedAt: string;
  relativeSourcePath: "src";
  artifacts: SourceArtifactRecord[];
}

export interface MinecraftSourceEntry {
  minecraftVersion: string;
  loader: LoaderId;
  loaderVersion?: string;
  mapping: MappingsId;
  mappingVersion: string;
  sourceKind: MinecraftSourceManifest["sourceKind"];
  javaFiles: number;
  generatedAt: string;
  path: string;
  sourcePath: string;
}

export interface ModSourceEntry {
  loader: LoaderId;
  minecraftVersion: string;
  modId: string;
  modName: string;
  modVersion: string;
  artifactSha256: string;
  sourceKind: "sources-jar" | "cfr-decompile";
  javaFiles: number;
  path: string;
  sourcePath: string;
}

export interface ProjectSourceIndex {
  schema: 1;
  generatedAt: string;
  projectPath: string;
  minecraft: MinecraftSourceEntry;
  mods: ModSourceEntry[];
}

export interface ProjectSourceStatus {
  ready: boolean;
  rootPath: string;
  minecraftPath?: string;
  modCount: number;
  generatedAt?: string;
}

export interface SourceTaskSnapshot {
  id: string;
  state: SourceTaskState;
  scope: SourceTaskScope;
  loader: LoaderId;
  total: number;
  completed: number;
  successes: number;
  failures: number;
  skipped: number;
  current?: SourceTarget;
  currentPhase?: "planning" | "scaffolding" | "mapping" | "extracting" | "dependencies" | "linking" | "verifying";
  startedAt: string;
  finishedAt?: string;
  outputPath?: string;
  projectPath?: string;
  projectSourcesPath?: string;
  dependenciesFound?: number;
  dependenciesPrepared?: number;
  dependencyFailures?: number;
  lastError?: string;
  logs: string[];
}

export interface SourceCenterStatus {
  rootPath: string;
  relativeRoot: string;
  task: SourceTaskSnapshot | null;
  entries: MinecraftSourceEntry[];
  modEntries: number;
}
