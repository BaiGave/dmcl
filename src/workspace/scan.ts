import type { DetectedProject } from "./types.js";
import { detectProject, scanDirectory } from "./detect.js";
import { inferModDir } from "./project-meta.js";
import { getWorkspace } from "./store.js";

export interface ImportResult {
  imported: number;
  skipped: number;
  mods: string[];
}

/** 将检测到的项目导入工作区，按 modId 自动归组；已排除的路径返回 null */
export function importDetectedProject(
  detected: DetectedProject,
): { modId: string; variantId: string; isNew: boolean } | null {
  const store = getWorkspace();
  if (store.isPathExcluded(detected.projectPath)) {
    return null;
  }

  const existing = store.findVariantByPath(detected.projectPath);

  if (existing) {
    return { modId: existing.mod.id, variantId: existing.variant.id, isNew: false };
  }

  let mod = store.findModByModId(detected.modId);
  let isNew = false;
  if (!mod) {
    const modDir = inferModDir(detected.projectPath, detected.modId);
    mod = store.createMod({
      modId: detected.modId,
      displayName: detected.displayName,
      modDir,
    });
    isNew = true;
  }

  const variant = store.addVariant(mod.id, {
    loader: detected.loader,
    mcVersion: detected.mcVersion,
    projectPath: detected.projectPath,
    modVersion: detected.modVersion,
    group: detected.group,
    mappings: detected.mappings,
    buildStatus: "unknown",
    source: "imported",
  });

  return { modId: mod.id, variantId: variant.id, isNew };
}

export function importFromPath(projectPath: string): { modId: string; variantId: string; isNew: boolean } | null {
  const detected = detectProject(projectPath);
  if (!detected) return null;
  const store = getWorkspace();
  store.removeExcludedPath(detected.projectPath);
  return importDetectedProject(detected);
}

export function scanAndImport(parentDir: string): ImportResult {
  const projects = scanDirectory(parentDir);
  let imported = 0;
  let skipped = 0;
  const mods: string[] = [];

  for (const p of projects) {
    const store = getWorkspace();
    if (store.isPathExcluded(p.projectPath)) {
      skipped++;
      continue;
    }
    if (store.findVariantByPath(p.projectPath)) {
      skipped++;
      continue;
    }
    const result = importDetectedProject(p);
    if (!result) {
      skipped++;
      continue;
    }
    imported++;
    if (!mods.includes(result.modId)) mods.push(result.modId);
  }

  return { imported, skipped, mods };
}

export function autoScan(): ImportResult {
  const store = getWorkspace();
  let total: ImportResult = { imported: 0, skipped: 0, mods: [] };

  for (const dir of store.getScanDirs()) {
    const r = scanAndImport(dir);
    total = {
      imported: total.imported + r.imported,
      skipped: total.skipped + r.skipped,
      mods: [...new Set([...total.mods, ...r.mods])],
    };
  }

  return total;
}
