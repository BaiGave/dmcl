import fs from "node:fs";
import path from "node:path";
import { LOADER_LABELS } from "../types.js";
import { getWorkspace } from "./store.js";

export interface CatalogEntry {
  modId: string;
  displayName: string;
  description?: string;
  status: string;
  variants: Array<{
    loader: string;
    loaderLabel: string;
    mcVersion: string;
    modVersion: string;
    buildStatus: string;
    lastBuiltAt?: string;
  }>;
  updatedAt: string;
}

export interface CatalogExport {
  exportedAt: string;
  modCount: number;
  mods: CatalogEntry[];
}

/** 导出开发中模组目录（JSON），可供静态页或对外展示 */
export function exportCatalog(): CatalogExport {
  const store = getWorkspace();
  const mods = store.getMods().map((mod): CatalogEntry => ({
    modId: mod.modId,
    displayName: mod.displayName,
    description: mod.description,
    status: mod.status,
    variants: mod.variants.map((v) => ({
      loader: v.loader,
      loaderLabel: LOADER_LABELS[v.loader],
      mcVersion: v.mcVersion,
      modVersion: v.modVersion,
      buildStatus: v.buildStatus,
      lastBuiltAt: v.lastBuiltAt,
    })),
    updatedAt: mod.updatedAt,
  }));

  return {
    exportedAt: new Date().toISOString(),
    modCount: mods.length,
    mods,
  };
}

export function writeCatalogExport(destPath: string): string {
  const data = exportCatalog();
  const resolved = path.resolve(destPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2), "utf8");
  return resolved;
}
