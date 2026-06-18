import path from "node:path";
import type { WorkspaceStore } from "./store.js";
import { getProjectsRoot } from "./paths.js";

export interface ExternalProjectEntry {
  modId: string;
  modUuid: string;
  displayName: string;
  variantId: string;
  loader: string;
  mcVersion: string;
  projectPath: string;
  pathMissing: boolean;
  source: string;
  isBuiltin: boolean;
}

/** 列出所有已注册项目（含内置与外部） */
export function listRegisteredProjects(store: WorkspaceStore): ExternalProjectEntry[] {
  const projectsRoot = path.resolve(getProjectsRoot()).toLowerCase();
  const entries: ExternalProjectEntry[] = [];

  for (const mod of store.getMods()) {
    for (const v of mod.variants) {
      const resolved = path.resolve(v.projectPath);
      entries.push({
        modId: mod.modId,
        modUuid: mod.id,
        displayName: mod.displayName,
        variantId: v.id,
        loader: v.loader,
        mcVersion: v.mcVersion,
        projectPath: v.projectPath,
        pathMissing: false,
        source: v.source,
        isBuiltin: resolved.toLowerCase().startsWith(projectsRoot + path.sep)
          || resolved.toLowerCase() === projectsRoot,
      });
    }
  }

  return entries;
}
