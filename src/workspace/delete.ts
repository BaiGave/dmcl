import fs from "node:fs";
import path from "node:path";
import { deleteVariantMeta } from "./project-meta.js";
import { getModDir, getProjectsRoot } from "./paths.js";

function normalize(p: string): string {
  return path.resolve(p);
}

const RM_OPTS: fs.RmDirOptions = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 300,
};

/** 仅允许删除 projects 根目录下或已登记的变体路径 */
export function assertDeletablePath(projectPath: string, registeredPaths: string[] = []): void {
  const resolved = normalize(projectPath);
  const projectsRoot = normalize(getProjectsRoot()) + path.sep;
  if (resolved.startsWith(projectsRoot)) return;

  for (const p of registeredPaths) {
    if (resolved === normalize(p)) return;
  }

  throw new Error(`不允许删除受保护路径外的目录：${resolved}`);
}

async function forceRemoveDir(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  await fs.promises.rm(dir, RM_OPTS);
}

function assertPathRemoved(resolved: string): void {
  if (fs.existsSync(resolved)) {
    throw new Error(`未能删除项目目录：${resolved}`);
  }
}

/** 递归删除变体项目目录；若模组目录在 projects 下且已空则一并删除 */
export async function deleteVariantProject(
  projectPath: string,
  modId?: string,
  registeredPaths: string[] = [],
): Promise<void> {
  assertDeletablePath(projectPath, registeredPaths);
  const resolved = normalize(projectPath);
  deleteVariantMeta(resolved);
  await forceRemoveDir(resolved);
  assertPathRemoved(resolved);

  if (!modId) return;
  const modDir = getModDir(modId);
  const projectsRoot = normalize(getProjectsRoot()) + path.sep;
  if (!normalize(modDir).startsWith(projectsRoot) || !fs.existsSync(modDir)) return;

  try {
    const remaining = fs.readdirSync(modDir);
    if (remaining.length === 0) {
      await forceRemoveDir(modDir);
    }
  } catch { /* 目录被占用时保留 */ }
}

/** 删除模组下所有变体目录，并强制删除模组根目录 */
export async function deleteModProjects(
  modId: string,
  variantPaths: string[],
): Promise<{ deleted: string[]; skipped: string[] }> {
  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const p of variantPaths) {
    const resolved = normalize(p);
    if (!fs.existsSync(resolved)) {
      skipped.push(resolved);
      continue;
    }
    try {
      assertDeletablePath(resolved, variantPaths);
      deleteVariantMeta(resolved);
      await forceRemoveDir(resolved);
      assertPathRemoved(resolved);
      deleted.push(resolved);
    } catch {
      skipped.push(resolved);
    }
  }

  const modDir = getModDir(modId);
  const projectsRoot = normalize(getProjectsRoot()) + path.sep;
  if (normalize(modDir).startsWith(projectsRoot)) {
    try {
      await forceRemoveDir(modDir);
    } catch {
      skipped.push(modDir);
    }
  }

  return { deleted, skipped };
}
