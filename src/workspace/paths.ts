import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoaderId } from "../types.js";
import { assertValidModId } from "./validate.js";

let repoRoot: string | null = null;
let projectsRoot: string | null = null;

/** 由 GUI 启动时注入；未注入时从 dist/workspace 向上推断仓库根目录 */
export function setRepoRoot(root: string): void {
  repoRoot = path.resolve(root);
}

/** 安装版注入可写数据目录；开发模式省略时仍使用仓库下的 projects。 */
export function setProjectsRoot(root: string): void {
  projectsRoot = path.resolve(root);
}

export function getRepoRoot(): string {
  if (repoRoot) return repoRoot;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

/** 所有模组项目的根目录：{repo}/projects */
export function getProjectsRoot(): string {
  return projectsRoot ?? path.join(getRepoRoot(), "projects");
}

/** 单个模组的目录：{repo}/projects/{modId} */
export function getModDir(modId: string): string {
  return path.join(getProjectsRoot(), modId);
}

/** 变体文件夹名：{loader}-{mcVersion}，如 fabric-1.21.4 */
export function variantFolderName(loader: LoaderId, mcVersion: string): string {
  return `${loader}-${mcVersion}`;
}

/** 变体项目默认绝对路径：{repo}/projects/{modId}/{loader}-{mc}/ */
export function defaultVariantPath(modId: string, loader: LoaderId, mcVersion: string): string {
  assertValidModId(modId);
  const target = path.join(getModDir(modId), variantFolderName(loader, mcVersion));
  const root = path.resolve(getProjectsRoot()) + path.sep;
  const resolved = path.resolve(target);
  if (!resolved.startsWith(root)) {
    throw new Error("变体路径超出 projects 目录");
  }
  return target;
}

/** 确保 projects 目录存在 */
export function ensureProjectsRoot(): string {
  const root = getProjectsRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** @deprecated 使用 variantFolderName */
export function variantDirName(modId: string, loader: LoaderId, mcVersion: string): string {
  return variantFolderName(loader, mcVersion);
}
