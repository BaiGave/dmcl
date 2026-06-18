import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BuildStatus, ModStatus, VariantSource } from "./types.js";

export const VARIANT_META_DIR = ".dmcl";
export const VARIANT_META_FILE = "variant.json";
export const MOD_META_FILE = "dmcl.mod.json";

export interface ModMetaFile {
  id: string;
  displayName: string;
  status: ModStatus;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VariantMetaFile {
  id: string;
  buildStatus: BuildStatus;
  lastBuiltAt?: string;
  source: VariantSource;
  createdAt: string;
}

export function variantMetaDir(projectPath: string): string {
  return path.join(path.resolve(projectPath), VARIANT_META_DIR);
}

export function variantMetaPath(projectPath: string): string {
  return path.join(variantMetaDir(projectPath), VARIANT_META_FILE);
}

export function variantLogsDir(projectPath: string): string {
  return path.join(variantMetaDir(projectPath), "logs");
}

export function readModMeta(modDir: string): ModMetaFile | null {
  const file = path.join(path.resolve(modDir), MOD_META_FILE);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as ModMetaFile;
  } catch {
    return null;
  }
}

export function writeModMeta(modDir: string, meta: ModMetaFile): void {
  const dir = path.resolve(modDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MOD_META_FILE), JSON.stringify(meta, null, 2), "utf8");
}

export function readVariantMeta(projectPath: string): VariantMetaFile | null {
  const file = variantMetaPath(projectPath);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as VariantMetaFile;
  } catch {
    return null;
  }
}

export function writeVariantMeta(projectPath: string, meta: VariantMetaFile): void {
  const dir = variantMetaDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, VARIANT_META_FILE), JSON.stringify(meta, null, 2), "utf8");
}

export function deleteVariantMeta(projectPath: string): void {
  const dir = variantMetaDir(projectPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function deleteModMeta(modDir: string): void {
  const file = path.join(path.resolve(modDir), MOD_META_FILE);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function ensureModMeta(
  modDir: string,
  modId: string,
  displayName: string,
): ModMetaFile {
  const existing = readModMeta(modDir);
  if (existing) return existing;
  const now = new Date().toISOString();
  const meta: ModMetaFile = {
    id: randomUUID(),
    displayName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  writeModMeta(modDir, meta);
  return meta;
}

export function ensureVariantMeta(
  projectPath: string,
  source: VariantSource = "imported",
): VariantMetaFile {
  const existing = readVariantMeta(projectPath);
  if (existing) return existing;
  const now = new Date().toISOString();
  const meta: VariantMetaFile = {
    id: randomUUID(),
    buildStatus: "unknown",
    source,
    createdAt: now,
  };
  writeVariantMeta(projectPath, meta);
  return meta;
}

/** 推断模组根目录：projects/{modId}/ 或单项目父目录 */
export function inferModDir(projectPath: string, modId: string): string {
  const resolved = path.resolve(projectPath);
  const parent = path.dirname(resolved);
  const folder = path.basename(parent);
  const variantDirPattern = /^(fabric|forge|neoforge)-\d+\.\d+/;
  if (variantDirPattern.test(path.basename(resolved)) || folder === modId) {
    return parent;
  }
  return resolved;
}
