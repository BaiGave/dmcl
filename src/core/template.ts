import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadFile } from "./http.js";
import { detectBasePackage, movePathSegments, renamePathsContaining, replaceInProject } from "./fsutils.js";
import type { ProjectOptions } from "../types.js";

/** 下载 zip 并解压到目标目录；若 zip 仅含一个顶层目录（GitHub 归档）则自动剥掉 */
export async function downloadAndExtract(url: string, targetDir: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `dmcl-${Date.now()}.zip`);
  try {
    await downloadFile(url, tmp);
    const zip = new AdmZip(tmp);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    const roots = new Set(entries.map((e) => e.entryName.split("/")[0]));
    const strip = roots.size === 1 ? `${[...roots][0]}/` : "";
    for (const entry of entries) {
      const rel = strip && entry.entryName.startsWith(strip) ? entry.entryName.slice(strip.length) : entry.entryName;
      if (!rel) continue;
      const dest = path.join(targetDir, ...rel.split("/"));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, entry.getData());
    }
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export interface TemplateTokens {
  /** 模板中的占位模组 ID，如 modid / examplemod */
  modIdToken: string;
  /** 模板中的占位主类名，如 ExampleMod */
  classToken: string;
  /** 模板中的占位显示名，如 Example Mod */
  displayToken: string;
}

/** 通用模板改造：包名迁移 + 占位符替换 + 文件重命名 */
export async function adaptTemplate(opts: ProjectOptions, tokens: TemplateTokens): Promise<void> {
  const target = opts.targetDir;
  const oldPkg = (await detectBasePackage(target)) ?? "com.example";
  const newPkg = opts.group;
  const oldPath = oldPkg.split(".").join("/");
  const newPath = newPkg.split(".").join("/");

  // 顺序很重要：先替换完整包名（可能包含 modIdToken），再替换其余占位符
  await replaceInProject(target, [
    [oldPkg, newPkg],
    [oldPath, newPath],
    [tokens.classToken, opts.className],
    [tokens.displayToken, opts.displayName],
    [tokens.modIdToken, opts.modId],
  ]);
  await movePathSegments(target, oldPath, newPath);
  await renamePathsContaining(target, tokens.classToken, opts.className);
  await renamePathsContaining(target, tokens.modIdToken, opts.modId);
}
