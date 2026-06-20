import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoaderId, MappingsId } from "../types.js";
import { fetchYarnVersion } from "./fabric.js";
import { isUnobfuscatedMc, usesLegacyForgeMcp } from "./mc-version.js";
import { fetchParchmentVersion } from "./parchment.js";
import { MAPPINGS_FRESH_TTL_MS } from "./sources.js";

/** 需要联网探测的映射（不含硬编码 MojMap） */
const MAPPINGS_PROBE: Record<LoaderId, MappingsId[]> = {
  fabric: ["yarn", "parchment"],
  forge: ["parchment"],
  neoforge: ["parchment"],
};

export interface MappingOption {
  id: MappingsId;
  label: string;
  available: boolean;
  version?: string;
  /** Forge/NeoForge 无 Parchment 时的内置官方映射，不向用户展示为 MojMap */
  implicit?: boolean;
}

export interface MappingCacheEntry {
  loader: LoaderId;
  mcVersion: string;
  options: MappingOption[];
  default: MappingsId;
  updatedAt: string;
}

export const MAPPINGS_CACHE_FILE = path.join(os.homedir(), ".dmcl", "mappings-cache.json");

interface CacheFile {
  version: 1;
  entries: Record<string, MappingCacheEntry>;
}

function cacheKey(loader: LoaderId, mcVersion: string): string {
  return `${loader}:${mcVersion}`;
}

function emptyCache(): CacheFile {
  return { version: 1, entries: {} };
}

function implicitMojmapOption(label: string): MappingOption {
  return { id: "mojmap", label, available: true, implicit: true };
}

function buildDefaultMappingsEntry(loader: LoaderId, mcVersion: string): MappingCacheEntry {
  if (loader === "forge" && usesLegacyForgeMcp(mcVersion)) {
    return {
      loader,
      mcVersion,
      options: [{
        id: "mcp",
        label: "MCP（由 Forge MDK 选择 snapshot/stable）",
        available: true,
        implicit: true,
      }],
      default: "mcp",
      updatedAt: new Date().toISOString(),
    };
  }

  if (loader === "fabric" && isUnobfuscatedMc(mcVersion)) {
    return {
      loader,
      mcVersion,
      options: [implicitMojmapOption("官方未混淆")],
      default: "mojmap",
      updatedAt: new Date().toISOString(),
    };
  }

  const options: MappingOption[] = [implicitMojmapOption("官方默认")];
  if (loader === "fabric") {
    options.unshift({
      id: "yarn",
      label: "Yarn",
      available: false,
    });
  } else {
    options.unshift({
      id: "parchment",
      label: "Parchment",
      available: false,
    });
  }

  return {
    loader,
    mcVersion,
    options,
    default: loader === "fabric" ? "mojmap" : "mojmap",
    updatedAt: new Date().toISOString(),
  };
}

/** 不联网，立即返回可用默认项（供 UI 首屏展示） */
export function resolveMappingsQuick(loader: LoaderId, mcVersion: string): MappingCacheEntry {
  return buildDefaultMappingsEntry(loader, mcVersion);
}

export async function resolveMappings(loader: LoaderId, mcVersion: string): Promise<MappingCacheEntry> {
  if (loader === "forge" && usesLegacyForgeMcp(mcVersion)) {
    return buildDefaultMappingsEntry(loader, mcVersion);
  }

  if (loader === "fabric" && isUnobfuscatedMc(mcVersion)) {
    return buildDefaultMappingsEntry(loader, mcVersion);
  }

  const options: MappingOption[] = [];
  for (const id of MAPPINGS_PROBE[loader]) {
    if (id === "yarn") {
      const version = await fetchYarnVersion(mcVersion);
      if (version) options.push({ id, label: "Yarn", available: true, version });
    } else if (id === "parchment") {
      const version = await fetchParchmentVersion(mcVersion);
      if (version) options.push({ id, label: "Parchment", available: true, version });
    }
  }

  let defaultId: MappingsId;

  if (loader === "fabric") {
    const yarn = options.find((o) => o.id === "yarn");
    if (!options.some((o) => o.id === "mojmap")) {
      options.push(implicitMojmapOption("官方默认"));
    }
    defaultId = yarn?.id ?? "mojmap";
  } else if (options.length > 0) {
    defaultId = options[0].id;
  } else {
    options.push(implicitMojmapOption("官方默认"));
    defaultId = "mojmap";
  }

  return {
    loader,
    mcVersion,
    options,
    default: defaultId,
    updatedAt: new Date().toISOString(),
  };
}

export class MappingsCache {
  private data: CacheFile;
  private refreshInFlight = new Map<string, Promise<MappingCacheEntry>>();

  constructor() {
    this.data = this.load();
  }

  private load(): CacheFile {
    try {
      if (fs.existsSync(MAPPINGS_CACHE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(MAPPINGS_CACHE_FILE, "utf8")) as CacheFile;
        if (raw.version === 1 && raw.entries) return raw;
      }
    } catch { /* fresh */ }
    return emptyCache();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(MAPPINGS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(MAPPINGS_CACHE_FILE, JSON.stringify(this.data, null, 2), "utf8");
  }

  getEntry(loader: LoaderId, mcVersion: string): MappingCacheEntry | undefined {
    return this.data.entries[cacheKey(loader, mcVersion)];
  }

  isStale(entry: MappingCacheEntry): boolean {
    const age = Date.now() - new Date(entry.updatedAt).getTime();
    return age > MAPPINGS_FRESH_TTL_MS;
  }

  /** 缓存条目无有效探测结果时需重新拉取 */
  isIncomplete(entry: MappingCacheEntry): boolean {
    if (entry.loader === "forge") {
      const legacyMcp = usesLegacyForgeMcp(entry.mcVersion);
      if (legacyMcp) {
        return entry.default !== "mcp"
          || !entry.options.some((option) => option.id === "mcp" && option.available);
      }
      if (entry.default === "mcp" || entry.options.some((option) => option.id === "mcp")) return true;
    }
    if (entry.loader === "fabric") {
      if (isUnobfuscatedMc(entry.mcVersion)) return false;
      return entry.options.length === 0;
    }
    return false;
  }

  async refresh(loader: LoaderId, mcVersion: string): Promise<MappingCacheEntry> {
    const key = cacheKey(loader, mcVersion);
    const pending = this.refreshInFlight.get(key);
    if (pending) return pending;

    const task = resolveMappings(loader, mcVersion).then((entry) => {
      this.data.entries[key] = entry;
      this.save();
      this.refreshInFlight.delete(key);
      return entry;
    }).catch((err) => {
      this.refreshInFlight.delete(key);
      throw err;
    });

    this.refreshInFlight.set(key, task);
    return task;
  }

  /** 优先返回本地缓存；缺失时先给默认可选项并在后台探测 */
  async getOrFetch(
    loader: LoaderId,
    mcVersion: string,
  ): Promise<{ entry: MappingCacheEntry; fromCache: boolean; pending?: boolean }> {
    const existing = this.getEntry(loader, mcVersion);

    if (existing && !this.isIncomplete(existing)) {
      const stale = this.isStale(existing);
      if (stale) void this.refresh(loader, mcVersion).catch(() => {});
      return { entry: existing, fromCache: true };
    }

    if (existing && this.isIncomplete(existing)) {
      void this.refresh(loader, mcVersion).catch(() => {});
      return { entry: existing, fromCache: true, pending: true };
    }

    const quick = resolveMappingsQuick(loader, mcVersion);
    void this.refresh(loader, mcVersion).catch(() => {});
    return { entry: quick, fromCache: false, pending: true };
  }

  async prefetch(
    versionLists: Record<LoaderId, string[]>,
    concurrency = 4,
  ): Promise<{ fetched: number; errors: number; skipped: number }> {
    const tasks: Array<{ loader: LoaderId; mc: string }> = [];
    const loaders: LoaderId[] = ["fabric", "forge", "neoforge"];
    let skipped = 0;

    for (const loader of loaders) {
      for (const mc of versionLists[loader] ?? []) {
        const existing = this.getEntry(loader, mc);
        if (existing && !this.isStale(existing) && !this.isIncomplete(existing)) {
          skipped++;
          continue;
        }
        tasks.push({ loader, mc });
      }
    }

    let fetched = 0;
    let errors = 0;
    let idx = 0;
    const cache = this;

    const worker = async (): Promise<void> => {
      while (idx < tasks.length) {
        const i = idx++;
        const { loader, mc } = tasks[i];
        try {
          const entry = await resolveMappings(loader, mc);
          cache.data.entries[cacheKey(loader, mc)] = entry;
          fetched++;
        } catch {
          errors++;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(tasks.length, 1)) },
      () => worker(),
    );
    await Promise.all(workers);
    if (fetched > 0) cache.save();

    return { fetched, errors, skipped };
  }

  getStatus(): {
    entries: number;
    cacheFile: string;
    lastUpdated?: string;
  } {
    const times = Object.values(this.data.entries).map((e) => e.updatedAt);
    return {
      entries: times.length,
      cacheFile: MAPPINGS_CACHE_FILE,
      lastUpdated: times.length ? times.sort().reverse()[0] : undefined,
    };
  }
}

let singleton: MappingsCache | null = null;

export function getMappingsCache(): MappingsCache {
  if (!singleton) singleton = new MappingsCache();
  return singleton;
}

/** 按需预热：仅为指定 loader+mc 组合拉取映射（创建向导选版本时触发） */
export async function prefetchMappings(
  loader: LoaderId,
  mcVersion: string,
): Promise<MappingCacheEntry> {
  const { entry } = await getMappingsCache().getOrFetch(loader, mcVersion);
  return entry;
}
