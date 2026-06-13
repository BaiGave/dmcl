import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BuildStatus, ManagedMod, ModVariant, WorkspaceData } from "./types.js";
import { assertValidModId } from "./validate.js";

const DMCL_DIR = path.join(os.homedir(), ".dmcl");
const WORKSPACE_FILE = path.join(DMCL_DIR, "workspace.json");
const LOGS_DIR = path.join(DMCL_DIR, "logs");

function emptyWorkspace(): WorkspaceData {
  return { version: 1, scanDirs: [], excludedPaths: [], mods: [] };
}

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

export function getDmclDir(): string {
  return DMCL_DIR;
}

export function getLogsDir(): string {
  return LOGS_DIR;
}

export class WorkspaceStore {
  private data: WorkspaceData;

  constructor() {
    this.data = this.load();
  }

  private load(): WorkspaceData {
    try {
      if (fs.existsSync(WORKSPACE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8")) as WorkspaceData;
        if (raw.version === 1 && Array.isArray(raw.mods)) {
          if (!Array.isArray(raw.excludedPaths)) raw.excludedPaths = [];
          return raw;
        }
      }
    } catch { /* fresh */ }
    return emptyWorkspace();
  }

  save(): void {
    fs.mkdirSync(DMCL_DIR, { recursive: true });
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(this.data, null, 2), "utf8");
  }

  getData(): WorkspaceData {
    return this.data;
  }

  getMods(): ManagedMod[] {
    return this.data.mods;
  }

  getMod(id: string): ManagedMod | undefined {
    return this.data.mods.find((m) => m.id === id);
  }

  getVariant(variantId: string): { mod: ManagedMod; variant: ModVariant } | undefined {
    for (const mod of this.data.mods) {
      const variant = mod.variants.find((v) => v.id === variantId);
      if (variant) return { mod, variant };
    }
    return undefined;
  }

  getScanDirs(): string[] {
    return [...this.data.scanDirs];
  }

  setScanDirs(dirs: string[]): void {
    this.data.scanDirs = dirs;
    this.save();
  }

  addScanDir(dir: string): void {
    const resolved = path.resolve(dir);
    if (!this.data.scanDirs.includes(resolved)) {
      this.data.scanDirs.push(resolved);
      this.save();
    }
  }

  removeScanDir(dir: string): boolean {
    const resolved = path.resolve(dir);
    const idx = this.data.scanDirs.findIndex((d) => path.resolve(d) === resolved);
    if (idx < 0) return false;
    this.data.scanDirs.splice(idx, 1);
    this.save();
    return true;
  }

  getExcludedPaths(): string[] {
    return [...this.data.excludedPaths];
  }

  isPathExcluded(projectPath: string): boolean {
    const key = normalizePath(projectPath);
    return this.data.excludedPaths.some((p) => normalizePath(p) === key);
  }

  addExcludedPath(projectPath: string): void {
    const resolved = path.resolve(projectPath);
    const key = normalizePath(resolved);
    if (!this.data.excludedPaths.some((p) => normalizePath(p) === key)) {
      this.data.excludedPaths.push(resolved);
      this.save();
    }
  }

  removeExcludedPath(projectPath: string): boolean {
    const key = normalizePath(projectPath);
    const idx = this.data.excludedPaths.findIndex((p) => normalizePath(p) === key);
    if (idx < 0) return false;
    this.data.excludedPaths.splice(idx, 1);
    this.save();
    return true;
  }

  findModByModId(modId: string): ManagedMod | undefined {
    return this.data.mods.find((m) => m.modId === modId);
  }

  findVariantByPath(projectPath: string): { mod: ManagedMod; variant: ModVariant } | undefined {
    const resolved = path.resolve(projectPath);
    for (const mod of this.data.mods) {
      for (const variant of mod.variants) {
        if (path.resolve(variant.projectPath) === resolved) {
          return { mod, variant };
        }
      }
    }
    return undefined;
  }

  createMod(input: {
    modId: string;
    displayName: string;
    description?: string;
    status?: ManagedMod["status"];
  }): ManagedMod {
    assertValidModId(input.modId);
    const now = new Date().toISOString();
    const mod: ManagedMod = {
      id: randomUUID(),
      modId: input.modId,
      displayName: input.displayName,
      description: input.description,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
      variants: [],
    };
    this.data.mods.push(mod);
    this.save();
    return mod;
  }

  addVariant(modId: string, variant: Omit<ModVariant, "id" | "createdAt">): ModVariant {
    const mod = this.getMod(modId);
    if (!mod) throw new Error(`模组不存在：${modId}`);

    const existing = mod.variants.find(
      (v) => v.loader === variant.loader && v.mcVersion === variant.mcVersion,
    );
    if (existing) throw new Error(`变体已存在：${variant.loader} ${variant.mcVersion}`);

    const now = new Date().toISOString();
    const entry: ModVariant = {
      ...variant,
      id: randomUUID(),
      createdAt: now,
    };
    mod.variants.push(entry);
    mod.updatedAt = now;
    this.save();
    return entry;
  }

  updateVariantBuildStatus(
    variantId: string,
    buildStatus: BuildStatus,
    modVersion?: string,
  ): void {
    const found = this.getVariant(variantId);
    if (!found) return;
    found.variant.buildStatus = buildStatus;
    if (modVersion) found.variant.modVersion = modVersion;
    if (buildStatus === "success" || buildStatus === "failed") {
      found.variant.lastBuiltAt = new Date().toISOString();
    }
    found.mod.updatedAt = new Date().toISOString();
    this.save();
  }

  updateMod(id: string, patch: Partial<Pick<ManagedMod, "displayName" | "description" | "status">>): ManagedMod | undefined {
    const mod = this.getMod(id);
    if (!mod) return undefined;
    if (patch.displayName !== undefined) mod.displayName = patch.displayName;
    if (patch.description !== undefined) mod.description = patch.description;
    if (patch.status !== undefined) mod.status = patch.status;
    mod.updatedAt = new Date().toISOString();
    this.save();
    return mod;
  }

  removeMod(id: string): boolean {
    const idx = this.data.mods.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    for (const v of this.data.mods[idx].variants) {
      this.addExcludedPath(v.projectPath);
    }
    this.data.mods.splice(idx, 1);
    this.save();
    return true;
  }

  removeVariant(modId: string, variantId: string): boolean {
    const mod = this.getMod(modId);
    if (!mod) return false;
    const idx = mod.variants.findIndex((v) => v.id === variantId);
    if (idx < 0) return false;
    this.addExcludedPath(mod.variants[idx].projectPath);
    mod.variants.splice(idx, 1);
    mod.updatedAt = new Date().toISOString();
    if (mod.variants.length === 0) {
      this.data.mods = this.data.mods.filter((m) => m.id !== modId);
    }
    this.save();
    return true;
  }

  /** 移除所有路径已失效的变体（及空模组） */
  purgeMissingVariants(): number {
    let removed = 0;
    for (const mod of [...this.data.mods]) {
      const before = mod.variants.length;
      mod.variants = mod.variants.filter((v) => {
        if (v.pathMissing) {
          this.addExcludedPath(v.projectPath);
          removed++;
          return false;
        }
        return true;
      });
      if (mod.variants.length < before) {
        mod.updatedAt = new Date().toISOString();
      }
      if (mod.variants.length === 0) {
        this.data.mods = this.data.mods.filter((m) => m.id !== mod.id);
      }
    }
    if (removed > 0) this.save();
    return removed;
  }

  updateVariantPath(variantId: string, projectPath: string): void {
    const found = this.getVariant(variantId);
    if (!found) return;
    found.variant.projectPath = path.resolve(projectPath);
    found.mod.updatedAt = new Date().toISOString();
    this.save();
  }

  setVariantPathMissing(variantId: string, missing: boolean): void {
    const found = this.getVariant(variantId);
    if (!found) return;
    found.variant.pathMissing = missing;
    found.mod.updatedAt = new Date().toISOString();
    this.save();
  }
}

let singleton: WorkspaceStore | null = null;

export function getWorkspace(): WorkspaceStore {
  if (!singleton) singleton = new WorkspaceStore();
  return singleton;
}
