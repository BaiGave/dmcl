import fs from "node:fs";
import path from "node:path";
import type { WorkspaceStore } from "./store.js";
import type { DetectedProject, ManagedMod, ModVariant } from "./types.js";
import { detectProject, scanDirectory } from "./detect.js";
import {
  ensureModMeta,
  ensureVariantMeta,
  inferModDir,
  readModMeta,
  readVariantMeta,
} from "./project-meta.js";

function hasGradleProject(dir: string): boolean {
  const gradlew = process.platform === "win32"
    ? path.join(dir, "gradlew.bat")
    : path.join(dir, "gradlew");
  return fs.existsSync(gradlew);
}

/** 从磁盘扫描结果重建内存中的模组列表（文件夹不存在则不会出现） */
export function syncWorkspaceFromDisk(store: WorkspaceStore): ManagedMod[] {
  const seenPaths = new Set<string>();
  const detected: DetectedProject[] = [];

  for (const scanDir of store.getScanDirs()) {
    if (!fs.existsSync(scanDir)) continue;
    for (const p of scanDirectory(scanDir)) {
      const key = path.resolve(p.projectPath).toLowerCase();
      if (seenPaths.has(key)) continue;
      if (store.isPathExcluded(p.projectPath)) continue;
      if (!hasGradleProject(p.projectPath)) continue;
      seenPaths.add(key);
      detected.push(p);
    }
  }

  const byModDir = new Map<string, DetectedProject[]>();
  for (const p of detected) {
    const modDir = path.resolve(inferModDir(p.projectPath, p.modId)).toLowerCase();
    const list = byModDir.get(modDir) ?? [];
    list.push(p);
    byModDir.set(modDir, list);
  }

  const mods: ManagedMod[] = [];

  for (const [, projects] of byModDir) {
    const modDir = inferModDir(projects[0].projectPath, projects[0].modId);
    const fileMeta = readModMeta(modDir);
    const modMeta = fileMeta ?? ensureModMeta(
      modDir,
      projects[0].modId,
      projects[0].displayName,
    );

    const variants: ModVariant[] = projects.map((p) => {
      const vMeta = readVariantMeta(p.projectPath) ?? ensureVariantMeta(
        p.projectPath,
        "imported",
      );
      return {
        id: vMeta.id,
        loader: p.loader,
        mcVersion: p.mcVersion,
        projectPath: path.resolve(p.projectPath),
        modVersion: p.modVersion,
        group: p.group,
        mappings: p.mappings,
        buildStatus: vMeta.buildStatus,
        lastBuiltAt: vMeta.lastBuiltAt,
        source: vMeta.source,
        createdAt: vMeta.createdAt,
      };
    });

    mods.push({
      id: modMeta.id,
      modId: projects[0].modId,
      displayName: modMeta.displayName,
      description: modMeta.description,
      status: modMeta.status,
      createdAt: modMeta.createdAt,
      updatedAt: modMeta.updatedAt,
      variants,
    });
  }

  mods.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return mods;
}

/** 按路径查找变体（扫描磁盘） */
export function findVariantOnDisk(
  store: WorkspaceStore,
  variantId: string,
): { mod: ManagedMod; variant: ModVariant } | undefined {
  for (const mod of syncWorkspaceFromDisk(store)) {
    const variant = mod.variants.find((v) => v.id === variantId);
    if (variant) return { mod, variant };
  }
  return undefined;
}

/** 按 uuid 查找模组 */
export function findModOnDisk(store: WorkspaceStore, modUuid: string): ManagedMod | undefined {
  return syncWorkspaceFromDisk(store).find((m) => m.id === modUuid);
}
