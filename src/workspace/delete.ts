import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProjectsRoot, getRepoRoot } from "./paths.js";
import { hasScaffoldMarker } from "../core/toolchain.js";
import { MOD_META_FILE } from "./project-meta.js";

/**
 * Deleting project files is limited to what DMCL itself created:
 * - only a registered variant folder, never its parents (the mod folder is removed only once it is empty);
 * - only folders carrying DMCL's scaffold marker (`.dmcl/scaffold.json`); imported projects are never deleted;
 * - never a folder holding Git history (DMCL's own empty `git init` is the only repository allowed);
 * - files go to the Recycle Bin / Trash, never a permanent recursive delete.
 */

/** Moves a file or folder to the Recycle Bin / Trash. The GUI passes Electron's `shell.trashItem`. */
export type TrashFn = (target: string) => Promise<void>;

export interface DeleteOptions {
  trash?: TrashFn;
}

export interface DeletableCheck {
  ok: boolean;
  reason?: string;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Folders skipped while looking for nested repositories: build outputs and caches, not source. */
const SKIP_GIT_SCAN = new Set(["build", ".gradle", "run", "runs", "out", "bin", "node_modules", ".dmcl", ".idea"]);
const GIT_SCAN_ENTRY_LIMIT = 20_000;

/**
 * Finds `.git` entries that hold history: a `.git` file (worktree or submodule pointer) or a repository
 * with at least one commit. An empty repository from DMCL's own `git init` does not count.
 */
export function findGitHistory(dir: string): string | null {
  let seen = 0;
  const visit = (current: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (++seen > GIT_SCAN_ENTRY_LIMIT) return path.join(current, "(too many files to verify)");
      const full = path.join(current, entry.name);
      if (entry.name === ".git") {
        if (!entry.isDirectory() || repositoryHasCommits(full)) return full;
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (depth >= 6 || SKIP_GIT_SCAN.has(entry.name.toLowerCase())) continue;
      const found = visit(full, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(path.resolve(dir), 0);
}

function repositoryHasCommits(gitDir: string): boolean {
  const refsHeads = path.join(gitDir, "refs", "heads");
  try {
    if (fs.existsSync(path.join(gitDir, "packed-refs"))) return true;
    if (fs.readdirSync(refsHeads).length > 0) return true;
    const objects = fs.readdirSync(path.join(gitDir, "objects")).filter((name) => /^[0-9a-f]{2}$/.test(name));
    return objects.length > 0;
  } catch {
    // Unreadable repository metadata: treat it as history to be safe.
    return true;
  }
}

function protectedRoots(): string[] {
  const roots = [os.homedir(), getProjectsRoot(), getRepoRoot()];
  return roots.filter(Boolean).map((p) => path.resolve(p));
}

/** Decides whether a variant folder may be deleted; `registeredPaths` are the variants DMCL knows. */
export function checkDeletableVariant(projectPath: string, registeredPaths: string[]): DeletableCheck {
  const resolved = path.resolve(projectPath);
  if (!registeredPaths.some((p) => samePath(p, resolved))) {
    return { ok: false, reason: `不是已登记的变体目录：${resolved}` };
  }
  if (path.parse(resolved).root === resolved || protectedRoots().some((root) => samePath(root, resolved))) {
    return { ok: false, reason: `受保护的目录：${resolved}` };
  }
  if (protectedRoots().some((root) => isInside(root, resolved))) {
    return { ok: false, reason: `目录包含 DMCL 或用户主目录：${resolved}` };
  }
  if (!fs.existsSync(resolved)) return { ok: true };
  if (fs.lstatSync(resolved).isSymbolicLink()) {
    return { ok: false, reason: `目录是链接，不删除：${resolved}` };
  }
  if (!hasScaffoldMarker(resolved)) {
    return { ok: false, reason: `不是 DMCL 生成的项目（缺少 .dmcl/scaffold.json），只移除登记：${resolved}` };
  }
  const git = findGitHistory(resolved);
  if (git) {
    return { ok: false, reason: `目录包含 Git 历史，DMCL 不删除：${git}` };
  }
  return { ok: true };
}

/** Throws when the variant folder may not be deleted. */
export function assertDeletablePath(projectPath: string, registeredPaths: string[]): void {
  const check = checkDeletableVariant(projectPath, registeredPaths);
  if (!check.ok) throw new Error(check.reason);
}

function runQuiet(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Recycle Bin outside Electron (CLI, scripts): VisualBasic FileSystem on Windows, `gio trash` elsewhere. */
export const defaultTrash: TrashFn = async (target) => {
  const resolved = path.resolve(target);
  if (process.platform === "win32") {
    const isDir = fs.statSync(resolved).isDirectory();
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; "
      + `[Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? "DeleteDirectory" : "DeleteFile"}`
      + "($env:DMCL_TRASH_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')";
    const code = await runQuiet("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      ...process.env,
      DMCL_TRASH_TARGET: resolved,
    });
    if (code !== 0) throw new Error(`无法移到回收站：${resolved}`);
    return;
  }
  const gio = spawnSync("gio", ["trash", resolved], { stdio: "ignore" });
  if (gio.status !== 0) throw new Error(`无法移到废纸篓（需要 gio）：${resolved}`);
};

async function trashPath(target: string, options: DeleteOptions): Promise<void> {
  await (options.trash ?? defaultTrash)(target);
  if (fs.existsSync(target)) throw new Error(`未能删除项目目录：${target}`);
}

/**
 * Removes the mod folder when deleting variants left it holding nothing but DMCL's `dmcl.mod.json`.
 * Only a folder directly under the projects root is considered; anything else stays.
 */
async function removeEmptyModDir(modDir: string, options: DeleteOptions): Promise<boolean> {
  const resolved = path.resolve(modDir);
  if (!isInside(resolved, getProjectsRoot()) || !samePath(path.dirname(resolved), getProjectsRoot())) return false;
  if (!fs.existsSync(resolved)) return false;
  const entries = fs.readdirSync(resolved);
  if (entries.some((name) => name !== MOD_META_FILE)) return false;
  await trashPath(resolved, options);
  return true;
}

/** Deletes one DMCL-generated variant folder (to the Recycle Bin), then its mod folder if that is now empty. */
export async function deleteVariantProject(
  projectPath: string,
  modDir: string | undefined,
  registeredPaths: string[],
  options: DeleteOptions = {},
): Promise<void> {
  assertDeletablePath(projectPath, registeredPaths);
  const resolved = path.resolve(projectPath);
  if (fs.existsSync(resolved)) await trashPath(resolved, options);
  if (modDir) await removeEmptyModDir(modDir, options).catch(() => false);
}

export interface DeleteModResult {
  deleted: string[];
  /** Folders that were left on disk, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/** Deletes every deletable variant folder of a mod; imported or Git-tracked folders are skipped, not deleted. */
export async function deleteModProjects(
  modDir: string | undefined,
  variantPaths: string[],
  onProgress?: (done: number, total: number, path: string) => void,
  options: DeleteOptions = {},
): Promise<DeleteModResult> {
  const result: DeleteModResult = { deleted: [], skipped: [] };
  const total = variantPaths.length;
  let done = 0;
  for (const variantPath of variantPaths) {
    const resolved = path.resolve(variantPath);
    try {
      if (!fs.existsSync(resolved)) {
        result.skipped.push({ path: resolved, reason: "目录不存在" });
      } else {
        assertDeletablePath(resolved, variantPaths);
        await trashPath(resolved, options);
        result.deleted.push(resolved);
      }
    } catch (err) {
      result.skipped.push({ path: resolved, reason: (err as Error).message });
    }
    onProgress?.(++done, total, resolved);
  }
  if (modDir) await removeEmptyModDir(modDir, options).catch(() => false);
  return result;
}
