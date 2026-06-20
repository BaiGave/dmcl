import fs from "node:fs";
import path from "node:path";
import { getIsolatedGradleHome } from "../core/gradle.js";
import { getDmclHome } from "../core/dmcl-home.js";
import type { LoaderId, MappingsId } from "../types.js";
import type { MinecraftSourceEntry, MinecraftSourceManifest } from "./types.js";

export const SOURCE_VAULT_VERSION = "v1";

export function safeSourceSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._+-]+/g, "_");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`无效的源码路径段：${value}`);
  }
  return normalized;
}

export function getSourceVaultRoot(): string {
  return path.join(getDmclHome(), "sources", SOURCE_VAULT_VERSION);
}

export function getSourceJobsRoot(): string {
  return path.join(getDmclHome(), "temp", "source-jobs");
}

/** 源码准备专用 Gradle 目录（与构建共用隔离根，避免用户 init.d 污染） */
export function getSourceGradleHome(): string {
  const dir = path.join(getIsolatedGradleHome(), "sources");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMinecraftSourceUnitDir(
  loader: LoaderId,
  mcVersion: string,
  mapping: MappingsId,
): string {
  return path.join(
    getSourceVaultRoot(),
    "minecraft",
    safeSourceSegment(loader),
    safeSourceSegment(mcVersion),
    safeSourceSegment(mapping),
  );
}

export function getModSourceUnitDir(
  loader: LoaderId,
  mcVersion: string,
  modId: string,
  modVersion: string,
  artifactHash: string,
): string {
  return path.join(
    getSourceVaultRoot(),
    "mods",
    safeSourceSegment(loader),
    safeSourceSegment(mcVersion),
    safeSourceSegment(modId),
    safeSourceSegment(modVersion),
    safeSourceSegment(artifactHash.slice(0, 16)),
  );
}

export function getProjectSourceRoot(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".dmcl", "sources");
}

export function sourceUnitReady(unitDir: string): boolean {
  return fs.existsSync(path.join(unitDir, "READY"))
    && fs.existsSync(path.join(unitDir, "manifest.json"))
    && fs.existsSync(path.join(unitDir, "src"));
}

function readEntry(unitDir: string): MinecraftSourceEntry | null {
  if (!sourceUnitReady(unitDir)) return null;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(unitDir, "manifest.json"), "utf8"),
    ) as MinecraftSourceManifest;
    if (manifest.schema !== 1 || manifest.javaFiles < 1) return null;
    return {
      minecraftVersion: manifest.minecraftVersion,
      loader: manifest.loader,
      loaderVersion: manifest.loaderVersion,
      mapping: manifest.mapping,
      mappingVersion: manifest.mappingVersion,
      sourceKind: manifest.sourceKind,
      javaFiles: manifest.javaFiles,
      generatedAt: manifest.generatedAt,
      path: unitDir,
      sourcePath: path.join(unitDir, manifest.relativeSourcePath),
    };
  } catch {
    return null;
  }
}

export function listMinecraftSourceEntries(): MinecraftSourceEntry[] {
  const root = path.join(getSourceVaultRoot(), "minecraft");
  if (!fs.existsSync(root)) return [];
  const entries: MinecraftSourceEntry[] = [];
  for (const loader of fs.readdirSync(root, { withFileTypes: true })) {
    if (!loader.isDirectory()) continue;
    const loaderDir = path.join(root, loader.name);
    for (const mc of fs.readdirSync(loaderDir, { withFileTypes: true })) {
      if (!mc.isDirectory()) continue;
      const mcDir = path.join(loaderDir, mc.name);
      for (const mapping of fs.readdirSync(mcDir, { withFileTypes: true })) {
        if (!mapping.isDirectory()) continue;
        const entry = readEntry(path.join(mcDir, mapping.name));
        if (entry) entries.push(entry);
      }
    }
  }
  return entries.sort((a, b) => {
    const byLoader = a.loader.localeCompare(b.loader);
    if (byLoader !== 0) return byLoader;
    return b.minecraftVersion.localeCompare(a.minecraftVersion, undefined, { numeric: true });
  });
}
