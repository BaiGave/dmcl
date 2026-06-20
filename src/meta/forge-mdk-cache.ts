import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_FILE = path.join(os.homedir(), ".dmcl", "forge-mdk-cache.json");

interface ForgeMdkCacheFile {
  version: 1;
  updatedAt: string;
  /** mcVersion → MDK 是否存在（仅写入已探测结果） */
  availability: Record<string, boolean>;
}

let memory: ForgeMdkCacheFile | null = null;

function load(): ForgeMdkCacheFile {
  if (memory) return memory;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as ForgeMdkCacheFile;
      if (raw.version === 1 && raw.availability) {
        memory = raw;
        return raw;
      }
    }
  } catch { /* fresh */ }
  memory = { version: 1, updatedAt: new Date().toISOString(), availability: {} };
  return memory;
}

function save(data: ForgeMdkCacheFile): void {
  memory = data;
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
}

export function getForgeMdkCached(mcVersion: string): boolean | undefined {
  return load().availability[mcVersion];
}

export function setForgeMdkCached(mcVersion: string, available: boolean): void {
  const data = load();
  if (data.availability[mcVersion] === available) return;
  data.availability[mcVersion] = available;
  data.updatedAt = new Date().toISOString();
  save(data);
}

/** 乐观保留未探测版本，仅排除已确认无 MDK 的版本 */
export function filterForgeVersionsUsingDiskCache(mcVersions: string[]): string[] {
  const availability = load().availability;
  return mcVersions.filter((mc) => availability[mc] !== false);
}

/** 增量刷新时只需探测：新出现的 MC 版本，或磁盘尚无结论的版本 */
export function forgeVersionsNeedingMdkProbe(
  mcVersions: string[],
  newMcVersions: ReadonlySet<string> = new Set(),
): string[] {
  const availability = load().availability;
  return mcVersions.filter(
    (mc) => newMcVersions.has(mc) || availability[mc] === undefined,
  );
}

export function forgeMdkCachePath(): string {
  return CACHE_FILE;
}
