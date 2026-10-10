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
  /** Restrict dependency-source preparation to these runtime jars. */
  runtimeModPaths?: string[];
  /** Skip Gradle dependency resolution when preparing selected runtime jars. */
  includeGradleDependencies?: boolean;
  /** Include jars from local runtime mod folders in dependency preparation. */
  includeRuntimeMods?: boolean;
  /**
   * JDK for the Gradle and CFR runs when the project configures none.
   * Passed to those processes by environment; the project's files are never edited.
   */
  javaHome?: string;
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

export type SourceConfidence = "exact" | "high" | "medium" | "low";

export interface ModSourceOrigin {
  provider: "gradle" | "local" | "modrinth" | "curseforge" | "github" | "manual";
  group?: string;
  name?: string;
  version?: string;
  file?: string;
  url?: string;
  projectId?: string;
  projectSlug?: string;
  versionId?: string;
  repositoryUrl?: string;
  repositoryRef?: string;
  commitSha?: string;
}

export interface ModSourceArtifact {
  path: string;
  sha256: string;
  size: number;
  maven?: {
    group: string;
    name: string;
    version: string;
  };
}

export interface SourceLicenseInfo {
  id?: string;
  name?: string;
  source: "jar" | "platform" | "repository" | "unknown";
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
  sourceKind: "sources-jar" | "github-source" | "manual-source" | "cfr-decompile";
  origin?: ModSourceOrigin;
  artifact?: ModSourceArtifact;
  confidence?: SourceConfidence;
  license?: SourceLicenseInfo;
  decompiler?: { name: "CFR"; version: string };
  artifacts?: SourceArtifactRecord[];
  layout?: {
    stableSourcePath: "src";
    readableSourcePath: "source-code" | "decompiled-code";
    sourceArchiveRetained: boolean;
  };
  javaFiles: number;
  generatedAt?: string;
  path: string;
  sourcePath: string;
  reportPath?: string;
}

export interface ProjectSourceIndex {
  schema: 1;
  generatedAt: string;
  projectPath: string;
  /** Present once Minecraft sources have been prepared for this project. */
  minecraft?: MinecraftSourceEntry;
  mods: ModSourceEntry[];
}

export interface ProjectSourceStatus {
  ready: boolean;
  rootPath: string;
  minecraftReady?: boolean;
  minecraftPath?: string;
  modCount: number;
  mods?: Array<{
    modId: string;
    modName: string;
    modVersion: string;
    sourceKind: ModSourceEntry["sourceKind"];
    confidence?: SourceConfidence;
    license?: SourceLicenseInfo;
    reportPath?: string;
    reportFilePath?: string;
  }>;
  generatedAt?: string;
}

export interface RuntimeModSourceCandidate {
  file: string;
  relativePath: string;
  modId?: string;
  modName?: string;
  modVersion?: string;
  artifactSha256?: string;
  supported: boolean;
  source?: {
    ready: boolean;
    sourceKind?: ModSourceEntry["sourceKind"];
    confidence?: SourceConfidence;
    sourcePath?: string;
    javaFiles?: number;
  };
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
