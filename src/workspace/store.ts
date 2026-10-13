import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  BuildStatus,
  JobKind,
  ManagedMod,
  ModVariant,
  VariantResult,
  VariantStatus,
  WorkspaceData,
} from "./types.js";
import { invalidateMatrixCache } from "./matrix.js";
import { assertValidModId } from "./validate.js";
import {
  deleteVariantMeta,
  syncModMetaIdentity,
  ensureModMeta,
  ensureVariantMeta,
  inferModDir,
  readModMeta,
  readVariantMeta,
  writeModMeta,
  writeVariantMeta,
  type ModMetaFile,
  type VariantMetaFile,
} from "./project-meta.js";
import { detectProject } from "./detect.js";
import { findModOnDisk, syncWorkspaceFromDisk } from "./sync-from-disk.js";
import { getProjectsRoot, getModDir } from "./paths.js";

const DMCL_DIR = path.join(os.homedir(), ".dmcl");
const WORKSPACE_FILE = path.join(DMCL_DIR, "workspace.json");

function emptyWorkspace(): WorkspaceData {
  return { version: 2, scanDirs: [], excludedPaths: [] };
}

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

export function getDmclDir(): string {
  return DMCL_DIR;
}

/** @deprecated 构建日志已迁至各变体项目 .dmcl/logs/ */
export function getLogsDir(): string {
  return path.join(DMCL_DIR, "logs");
}

export class WorkspaceStore {
  private data: WorkspaceData;
  private modsCache: ManagedMod[] = [];
  private lastRefreshAt = 0;
  /** 短时间内的重复 refresh 合并为一次磁盘扫描 */
  static readonly REFRESH_DEBOUNCE_MS = 3_000;

  /** In-memory only: variants with a queued or running job. Never persisted, so a crash cannot leave them stuck. */
  private readonly activity = new Map<string, { state: "queued" | "running"; kind: JobKind; jobId: string }>();

  constructor() {
    this.data = this.load();
    this.modsCache = this.withStatus(syncWorkspaceFromDisk(this));
  }

  private withStatus(mods: ManagedMod[]): ManagedMod[] {
    for (const mod of mods) {
      for (const variant of mod.variants) {
        const active = this.activity.get(variant.id);
        variant.status = variantStatusOf(variant.lastResult, active, variant.buildStatus);
        if (active) variant.buildStatus = active.state === "running" && active.kind === "run" ? "running" : "building";
      }
    }
    return mods;
  }

  private load(): WorkspaceData {
    try {
      if (fs.existsSync(WORKSPACE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8")) as {
          version?: number;
          scanDirs?: string[];
          excludedPaths?: string[];
          mods?: unknown;
        };
        if ((raw.version === 1 || raw.version === 2) && Array.isArray(raw.scanDirs)) {
          if (!Array.isArray(raw.excludedPaths)) raw.excludedPaths = [];
          const data: WorkspaceData = {
            version: 2,
            scanDirs: raw.scanDirs,
            excludedPaths: raw.excludedPaths,
          };
          if (raw.version === 1 || raw.mods !== undefined) {
            fs.mkdirSync(DMCL_DIR, { recursive: true });
            fs.writeFileSync(
              WORKSPACE_FILE,
              JSON.stringify(data, null, 2),
              "utf8",
            );
          }
          return data;
        }
      }
    } catch { /* fresh */ }
    return emptyWorkspace();
  }

  save(): void {
    fs.mkdirSync(DMCL_DIR, { recursive: true });
    fs.writeFileSync(
      WORKSPACE_FILE,
      JSON.stringify({ version: 2, scanDirs: this.data.scanDirs, excludedPaths: this.data.excludedPaths }, null, 2),
      "utf8",
    );
  }

  refresh(opts?: { force?: boolean }): ManagedMod[] {
    this.pruneScanDirs();
    const now = Date.now();
    if (!opts?.force && now - this.lastRefreshAt < WorkspaceStore.REFRESH_DEBOUNCE_MS) {
      return this.modsCache;
    }
    this.lastRefreshAt = now;
    this.modsCache = this.withStatus(syncWorkspaceFromDisk(this));
    return this.modsCache;
  }

  /** 移除不存在目录、以及单元测试残留的 Temp 扫描路径 */
  private pruneScanDirs(): void {
    const tmpRoot = normalizePath(os.tmpdir());
    const before = this.data.scanDirs.length;
    this.data.scanDirs = this.data.scanDirs.filter((dir) => {
      const resolved = path.resolve(dir);
      if (!fs.existsSync(resolved)) return false;
      const norm = normalizePath(resolved);
      if (!norm.startsWith(tmpRoot + path.sep)) return true;
      const base = path.basename(resolved).toLowerCase();
      return !(base.startsWith("dmcl-sync-") || base.startsWith("dmcl-ws-"));
    });
    if (this.data.scanDirs.length !== before) this.save();
  }

  getData(): WorkspaceData {
    return this.data;
  }

  getMods(): ManagedMod[] {
    return this.modsCache;
  }

  getMod(id: string): ManagedMod | undefined {
    return this.modsCache.find((m) => m.id === id);
  }

  getVariant(variantId: string): { mod: ManagedMod; variant: ModVariant } | undefined {
    for (const mod of this.modsCache) {
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
    this.refresh({ force: true });
  }

  addScanDir(dir: string): void {
    const resolved = path.resolve(dir);
    if (!this.data.scanDirs.includes(resolved)) {
      this.data.scanDirs.push(resolved);
      this.save();
      this.refresh({ force: true });
    }
  }

  removeScanDir(dir: string): boolean {
    const resolved = path.resolve(dir);
    const idx = this.data.scanDirs.findIndex((d) => path.resolve(d) === resolved);
    if (idx < 0) return false;
    this.data.scanDirs.splice(idx, 1);
    this.save();
    this.refresh({ force: true });
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
      this.refresh({ force: true });
    }
  }

  removeExcludedPath(projectPath: string): boolean {
    const key = normalizePath(projectPath);
    const idx = this.data.excludedPaths.findIndex((p) => normalizePath(p) === key);
    if (idx < 0) return false;
    this.data.excludedPaths.splice(idx, 1);
    this.save();
    this.refresh({ force: true });
    return true;
  }

  findModByModId(modId: string, preferredModDir?: string): ManagedMod | undefined {
    const matches = this.modsCache.filter((m) => m.modId === modId);
    if (matches.length === 0) {
      return this.modsCache.find((m) =>
        m.variants.some((v) => {
          const modDir = inferModDir(v.projectPath, m.modId);
          return path.basename(modDir) === modId;
        }),
      );
    }
    if (matches.length === 1) return matches[0];

    if (preferredModDir) {
      const pref = normalizePath(preferredModDir);
      const preferred = matches.find((m) =>
        m.variants.some((v) => normalizePath(inferModDir(v.projectPath, m.modId)) === pref),
      );
      if (preferred) return preferred;
    }

    const canonicalDir = normalizePath(getModDir(modId));
    const canonical = matches.find((m) =>
      m.variants.some((v) => normalizePath(v.projectPath).startsWith(canonicalDir + path.sep)),
    );
    return canonical ?? matches[0];
  }

  findVariantByPath(projectPath: string): { mod: ManagedMod; variant: ModVariant } | undefined {
    const resolved = path.resolve(projectPath);
    for (const mod of this.modsCache) {
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
    modDir: string;
  }): ManagedMod {
    assertValidModId(input.modId);
    const now = new Date().toISOString();
    const meta: ModMetaFile = {
      id: randomUUID(),
      displayName: input.displayName,
      description: input.description,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    writeModMeta(input.modDir, meta);
    this.refresh({ force: true });
    return this.getMod(meta.id) ?? {
      id: meta.id,
      modId: input.modId,
      displayName: input.displayName,
      description: input.description,
      status: meta.status,
      createdAt: now,
      updatedAt: now,
      variants: [],
    };
  }

  /** 注册变体前：取消排除、确保扫描目录包含项目 */
  prepareVariantRegistration(projectPath: string): void {
    const resolved = path.resolve(projectPath);
    this.removeExcludedPath(resolved);
    const projectsRoot = path.resolve(getProjectsRoot());
    if (!this.data.scanDirs.some((d) => path.resolve(d) === projectsRoot)) {
      this.addScanDir(projectsRoot);
    }
  }

  /** 按 uuid / modId / 磁盘扫描 / 项目路径解析模组 */
  resolveMod(modUuid: string, projectPath?: string): ManagedMod | undefined {
    let mod = this.getMod(modUuid) ?? findModOnDisk(this, modUuid);
    if (!mod) mod = this.findModByModId(modUuid);
    if (!mod && projectPath) {
      const detected = detectProject(projectPath);
      if (detected) {
        const modDir = inferModDir(projectPath, detected.modId);
        mod = this.findModByModId(detected.modId, modDir);
      }
    }
    return mod;
  }

  addVariant(modUuid: string, variant: Omit<ModVariant, "id" | "createdAt">): ModVariant {
    this.prepareVariantRegistration(variant.projectPath);
    this.refresh({ force: true });

    const mod = this.resolveMod(modUuid, variant.projectPath);
    if (!mod) throw new Error(`模组不存在：${modUuid}`);

    const existing = mod.variants.find(
      (v) => v.loader === variant.loader && v.mcVersion === variant.mcVersion,
    );
    if (existing) {
      if (normalizePath(existing.projectPath) === normalizePath(variant.projectPath)) {
        const meta = readVariantMeta(variant.projectPath) ?? ensureVariantMeta(
          variant.projectPath,
          variant.source,
        );
        if (variant.buildStatus && meta.buildStatus !== variant.buildStatus) {
          meta.buildStatus = variant.buildStatus;
          writeVariantMeta(variant.projectPath, meta);
        }
        this.refresh({ force: true });
        return this.getVariant(existing.id)?.variant ?? existing;
      }
      throw new Error(`变体已存在：${variant.loader} ${variant.mcVersion}`);
    }

    const now = new Date().toISOString();
    const meta: VariantMetaFile = {
      id: randomUUID(),
      buildStatus: variant.buildStatus,
      lastBuiltAt: variant.lastBuiltAt,
      source: variant.source,
      createdAt: now,
    };
    writeVariantMeta(variant.projectPath, meta);
    syncModMetaIdentity(inferModDir(variant.projectPath, mod.modId), mod.displayName);

    this.refresh({ force: true });
    const found = this.getVariant(meta.id);
    if (found) return found.variant;

    return { ...variant, id: meta.id, createdAt: now };
  }

  /**
   * Legacy status update. "building"/"running" only mark the variant busy in memory; final states are
   * written to .dmcl/variant.json. Prefer setVariantActivity + recordVariantResult.
   */
  updateVariantBuildStatus(
    variantId: string,
    buildStatus: BuildStatus,
    _modVersion?: string,
  ): void {
    const found = this.getVariant(variantId);
    if (!found) return;
    if (buildStatus === "building" || buildStatus === "running") {
      const previous = this.activity.get(variantId);
      this.activity.set(variantId, {
        state: buildStatus === "running" ? "running" : "queued",
        kind: previous?.kind ?? "build",
        jobId: previous?.jobId ?? "",
      });
      this.applyStatus(variantId);
      return;
    }
    this.activity.delete(variantId);
    const meta = readVariantMeta(found.variant.projectPath) ?? ensureVariantMeta(
      found.variant.projectPath,
      found.variant.source,
    );
    if (meta.buildStatus === buildStatus && buildStatus === "unknown") {
      this.applyStatus(variantId);
      return;
    }
    meta.buildStatus = buildStatus;
    const at = new Date().toISOString();
    if (buildStatus === "success" || buildStatus === "failed") meta.lastBuiltAt = at;
    if (buildStatus === "success" || buildStatus === "failed" || buildStatus === "cancelled") {
      // Keep the status object in step with legacy callers (batch verification, wizard registration).
      meta.lastResult = {
        kind: "build",
        state: buildStatus === "success" ? "succeeded" : buildStatus,
        at,
        reason: null,
        phaseReached: null,
      };
    }
    writeVariantMeta(found.variant.projectPath, meta);
    this.refresh({ force: true });
    invalidateMatrixCache(found.mod.id);
  }

  /** Marks a variant as having a queued/running job (null clears it). Memory only. */
  setVariantActivity(
    variantId: string,
    activity: { state: "queued" | "running"; kind: JobKind; jobId: string } | null,
  ): void {
    if (activity) this.activity.set(variantId, activity);
    else this.activity.delete(variantId);
    this.applyStatus(variantId);
  }

  /** Persists how a job ended and clears the variant's active state. */
  recordVariantResult(variantId: string, result: VariantResult): void {
    this.activity.delete(variantId);
    const found = this.getVariant(variantId);
    if (!found) return;
    const meta = readVariantMeta(found.variant.projectPath) ?? ensureVariantMeta(
      found.variant.projectPath,
      found.variant.source,
    );
    meta.lastResult = result;
    meta.buildStatus = result.state === "succeeded" ? "success" : result.state === "failed" ? "failed" : "cancelled";
    if (result.state !== "cancelled") meta.lastBuiltAt = result.at;
    writeVariantMeta(found.variant.projectPath, meta);
    this.refresh({ force: true });
    invalidateMatrixCache(found.mod.id);
  }

  /**
   * At startup nothing can be running: statuses an older DMCL persisted as "building"/"running"
   * (or left behind by a crash) become "cancelled" with a reason.
   */
  resetInterruptedStatuses(): number {
    this.activity.clear();
    let reset = 0;
    for (const mod of this.modsCache) {
      for (const variant of mod.variants) {
        const meta = readVariantMeta(variant.projectPath);
        if (!meta || (meta.buildStatus !== "building" && meta.buildStatus !== "running")) continue;
        meta.buildStatus = "cancelled";
        meta.lastResult = {
          kind: meta.lastResult?.kind ?? "build",
          state: "cancelled",
          at: new Date().toISOString(),
          reason: "DMCL 上次退出时任务被中断",
          phaseReached: meta.lastResult?.phaseReached ?? null,
        };
        writeVariantMeta(variant.projectPath, meta);
        reset++;
      }
    }
    if (reset > 0) {
      this.refresh({ force: true });
      invalidateMatrixCache();
    }
    return reset;
  }

  private applyStatus(variantId: string): void {
    const found = this.getVariant(variantId);
    if (!found) return;
    this.withStatus([found.mod]);
    invalidateMatrixCache(found.mod.id);
  }

  updateMod(id: string, patch: Partial<Pick<ManagedMod, "displayName" | "description" | "status">>): ManagedMod | undefined {
    const mod = this.getMod(id);
    if (!mod) return undefined;

    const modDir = mod.variants[0]
      ? inferModDir(mod.variants[0].projectPath, mod.modId)
      : null;
    if (!modDir) return undefined;

    const meta = readModMeta(modDir) ?? ensureModMeta(modDir, mod.modId, mod.displayName);
    if (patch.displayName !== undefined) meta.displayName = patch.displayName;
    if (patch.description !== undefined) meta.description = patch.description;
    if (patch.status !== undefined) meta.status = patch.status;
    meta.updatedAt = new Date().toISOString();
    writeModMeta(modDir, meta);
    this.refresh({ force: true });
    return this.getMod(id);
  }

  /**
   * Removes the mod from DMCL's list: its variant folders are excluded from scanning and their registration
   * (`.dmcl/variant.json`) is forgotten. Project files, other `.dmcl/` data and `dmcl.mod.json` stay on disk.
   */
  removeMod(id: string): boolean {
    const mod = this.getMod(id);
    if (!mod) return false;
    for (const v of mod.variants) {
      this.addExcludedPath(v.projectPath);
      deleteVariantMeta(v.projectPath);
    }
    invalidateMatrixCache(id);
    this.refresh({ force: true });
    return true;
  }

  /** Removes one variant from DMCL's list; see removeMod for what stays on disk. */
  removeVariant(modUuid: string, variantId: string): boolean {
    const found = this.getVariant(variantId);
    if (!found || found.mod.id !== modUuid) return false;

    this.addExcludedPath(found.variant.projectPath);
    deleteVariantMeta(found.variant.projectPath);
    invalidateMatrixCache(found.mod.id);
    this.refresh({ force: true });
    return true;
  }

  /** 文件夹已删的条目会在 refresh 时自动消失；此方法仅清理 excludedPaths 中的无效路径 */
  purgeMissingVariants(): number {
    let removed = 0;
    this.data.excludedPaths = this.data.excludedPaths.filter((p) => {
      if (fs.existsSync(p)) return true;
      removed++;
      return false;
    });
    if (removed > 0) this.save();
    this.refresh({ force: true });
    return removed;
  }

  updateVariantPath(variantId: string, projectPath: string): void {
    const found = this.getVariant(variantId);
    if (!found) return;
    const meta = readVariantMeta(found.variant.projectPath);
    if (meta) {
      deleteVariantMeta(found.variant.projectPath);
      writeVariantMeta(projectPath, meta);
    } else {
      ensureVariantMeta(projectPath, found.variant.source);
    }
    this.removeExcludedPath(projectPath);
    this.refresh({ force: true });
  }

  setVariantPathMissing(_variantId: string, _missing: boolean): void {
    // 已改为纯磁盘扫描，不再标记 pathMissing
  }
}

/** Active job first, else the last persisted result (legacy buildStatus when there is none). */
export function variantStatusOf(
  lastResult: VariantResult | undefined,
  active: { state: "queued" | "running"; kind: JobKind; jobId: string } | undefined,
  legacy?: BuildStatus,
): VariantStatus {
  if (active) {
    return {
      state: active.state,
      kind: active.kind,
      at: null,
      reason: null,
      phaseReached: lastResult?.phaseReached ?? null,
      activeJobId: active.jobId || null,
    };
  }
  if (lastResult) {
    return {
      state: lastResult.state,
      kind: lastResult.kind,
      at: lastResult.at,
      reason: lastResult.reason,
      phaseReached: lastResult.phaseReached,
      activeJobId: null,
    };
  }
  const legacyState: VariantStatus["state"] = legacy === "success" ? "succeeded"
    : legacy === "failed" ? "failed"
    : legacy === "cancelled" ? "cancelled"
    : "unknown";
  return { state: legacyState, kind: null, at: null, reason: null, phaseReached: null, activeJobId: null };
}

let singleton: WorkspaceStore | null = null;

export function getWorkspace(): WorkspaceStore {
  if (!singleton) singleton = new WorkspaceStore();
  return singleton;
}
