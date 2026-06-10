import fs from "node:fs";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".java", ".kt", ".kts", ".groovy", ".gradle",
  ".json", ".json5", ".mcmeta", ".toml", ".properties",
  ".md", ".txt", ".cfg", ".yml", ".yaml", ".xml",
]);

export function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      out.push(...(await walkFiles(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** 在项目内所有文本文件中按顺序执行字符串替换 */
export async function replaceInProject(root: string, replacements: Array<[from: string, to: string]>): Promise<void> {
  for (const file of await walkFiles(root)) {
    if (!isTextFile(file)) continue;
    let content = await fs.promises.readFile(file, "utf8");
    let changed = false;
    for (const [from, to] of replacements) {
      if (from && content.includes(from)) {
        content = content.split(from).join(to);
        changed = true;
      }
    }
    if (changed) await fs.promises.writeFile(file, content, "utf8");
  }
}

/** 将路径中的包目录片段（如 com/example）迁移为新包目录 */
export async function movePathSegments(root: string, fromSeg: string, toSeg: string): Promise<void> {
  if (fromSeg === toSeg) return;
  for (const file of await walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel.startsWith(`${fromSeg}/`) || rel.includes(`/${fromSeg}/`)) {
      const newRel = rel.replace(`${fromSeg}/`, `${toSeg}/`);
      const dest = path.join(root, ...newRel.split("/"));
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.rename(file, dest);
    }
  }
  await removeEmptyDirs(root);
}

/** 重命名文件/目录名中包含 token 的条目（先深后浅） */
export async function renamePathsContaining(root: string, from: string, to: string): Promise<void> {
  if (from === to) return;
  const all: Array<{ p: string; depth: number }> = [];
  const collect = async (dir: string) => {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      all.push({ p: full, depth: full.split(path.sep).length });
      if (e.isDirectory() && e.name !== ".git") await collect(full);
    }
  };
  await collect(root);
  all.sort((a, b) => b.depth - a.depth);
  for (const { p } of all) {
    const base = path.basename(p);
    if (base.includes(from)) {
      const dest = path.join(path.dirname(p), base.split(from).join(to));
      await fs.promises.rename(p, dest);
    }
  }
}

export async function removeEmptyDirs(dir: string): Promise<boolean> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  let empty = true;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const childEmpty = await removeEmptyDirs(full);
      if (childEmpty) await fs.promises.rmdir(full);
      else empty = false;
    } else {
      empty = false;
    }
  }
  return empty;
}

/** 修改 .properties 文件中已存在的键（不存在的键跳过） */
export async function patchProperties(file: string, entries: Record<string, string | null | undefined>): Promise<string[]> {
  if (!fs.existsSync(file)) return [];
  let content = await fs.promises.readFile(file, "utf8");
  const patched: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value == null) continue;
    const re = new RegExp(`^([ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*=).*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, (_m, prefix: string) => `${prefix}${value}`);
      patched.push(key);
    }
  }
  await fs.promises.writeFile(file, content, "utf8");
  return patched;
}

/** 扫描 .java 文件，返回最短的 package 声明作为模板根包名 */
export async function detectBasePackage(root: string): Promise<string | null> {
  let shortest: string | null = null;
  for (const file of await walkFiles(root)) {
    if (path.extname(file) !== ".java") continue;
    const content = await fs.promises.readFile(file, "utf8");
    const m = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    if (m && (shortest === null || m[1].length < shortest.length)) {
      shortest = m[1];
    }
  }
  return shortest;
}
