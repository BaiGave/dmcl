import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoaderId } from "../types.js";
import { fetchReleaseVersions } from "./mojang.js";
import { fetchFabricGameVersionsRaw, fetchFabricLoaderVersionRaw } from "./fabric.js";
import { fetchForgePromosRaw, filterForgeVersionsWithMdk } from "./forge.js";
import { filterForgeVersionsUsingDiskCache, forgeVersionsNeedingMdkProbe } from "./forge-mdk-cache.js";
import { fetchNeoForgeVersionsRaw } from "./neoforge.js";
import { computeLoaderVersions } from "./loader-support.js";
import { META_CACHE_SCHEMA_VERSION, META_FRESH_TTL_MS } from "./sources.js";

export const META_CACHE_FILE = path.join(os.homedir(), ".dmcl", "meta-cache.json");
/** MC 版本、加载器支持列表等元数据：每日刷新一次即可 */
export const META_TTL_MS = META_FRESH_TTL_MS;

export interface MetaCacheData {
  version: 1;
  updatedAt: string;
  releaseVersions: string[];
  fabricGameVersions: string[];
  fabricLoaderVersion: string;
  forgePromos: Record<string, string>;
  neoforgeVersions: string[];
  loaderVersions: Record<LoaderId, string[]>;
}

export interface MetaCacheGetOptions {
  strategy?: "fresh" | "cache-first";
  maxAgeMs?: number;
  allowStaleOnError?: boolean;
}

export interface MetaCacheGetResult {
  data: MetaCacheData;
  fromCache: boolean;
  stale: boolean;
}

export interface MetaCacheRefreshOptions {
  /** true = 设置页全量刷新（重探全部 Forge MDK）；false = 增量（仅新版本/未缓存 MDK） */
  force?: boolean;
}

export interface MetaCacheRefreshResult {
  data: MetaCacheData;
  mode: "full" | "incremental";
  newReleaseCount: number;
  forgeMdkProbeCount: number;
}

async function pullUpstreamMeta(): Promise<{
  releaseVersions: string[];
  fabricGameVersions: string[];
  fabricLoaderVersion: string;
  forgePromos: Record<string, string>;
  neoforgeVersions: string[];
}> {
  const [releaseVersions, fabricGameVersions, fabricLoaderVersion, forgePromos, neoforgeVersions] =
    await Promise.all([
      fetchReleaseVersions(),
      fetchFabricGameVersionsRaw(),
      fetchFabricLoaderVersionRaw(),
      fetchForgePromosRaw(),
      fetchNeoForgeVersionsRaw(),
    ]);
  return { releaseVersions, fabricGameVersions, fabricLoaderVersion, forgePromos, neoforgeVersions };
}

function buildMetaData(
  upstream: Awaited<ReturnType<typeof pullUpstreamMeta>>,
): { data: MetaCacheData; forgeRaw: string[] } {
  const loaderVersions = computeLoaderVersions(
    upstream.releaseVersions,
    upstream.fabricGameVersions,
    upstream.forgePromos,
    upstream.neoforgeVersions,
  );
  const forgeRaw = [...loaderVersions.forge];
  loaderVersions.forge = filterForgeVersionsUsingDiskCache(forgeRaw);
  return {
    data: {
      version: META_CACHE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      ...upstream,
      loaderVersions,
    },
    forgeRaw,
  };
}


export class MetaCache {
  private data: MetaCacheData | null = null;
  private refreshInFlight: Promise<MetaCacheRefreshResult> | null = null;

  constructor() {
    this.data = this.load();
  }

  private load(): MetaCacheData | null {
    try {
      if (fs.existsSync(META_CACHE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(META_CACHE_FILE, "utf8")) as MetaCacheData;
        if (raw.version === META_CACHE_SCHEMA_VERSION && raw.loaderVersions) return raw;
      }
    } catch { /* fresh */ }
    return null;
  }

  private save(data: MetaCacheData): void {
    fs.mkdirSync(path.dirname(META_CACHE_FILE), { recursive: true });
    fs.writeFileSync(META_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
    this.data = data;
  }

  isStale(data: MetaCacheData, maxAgeMs = META_TTL_MS): boolean {
    const updatedAt = new Date(data.updatedAt).getTime();
    if (!Number.isFinite(updatedAt)) return true;
    return Date.now() - updatedAt > maxAgeMs;
  }

  getStatus(): {
    cacheFile: string;
    updatedAt?: string;
    stale: boolean;
    releaseCount: number;
    loaderCounts: Record<LoaderId, number>;
  } {
    const d = this.data;
    return {
      cacheFile: META_CACHE_FILE,
      updatedAt: d?.updatedAt,
      stale: !d || this.isStale(d),
      releaseCount: d?.releaseVersions.length ?? 0,
      loaderCounts: {
        fabric: d?.loaderVersions.fabric.length ?? 0,
        forge: d?.loaderVersions.forge.length ?? 0,
        neoforge: d?.loaderVersions.neoforge.length ?? 0,
      },
    };
  }

  /** 有缓存则立即返回；过期则在后台刷新 */
  async get(opts: MetaCacheGetOptions = {}): Promise<MetaCacheGetResult> {
    const strategy = opts.strategy ?? "fresh";
    const maxAgeMs = opts.maxAgeMs ?? META_TTL_MS;
    const allowStaleOnError = opts.allowStaleOnError ?? true;

    if (this.data && !this.isStale(this.data, maxAgeMs)) {
      return { data: this.data, fromCache: true, stale: false };
    }

    if (this.data && strategy === "cache-first") {
      void this.refresh({ force: false }).catch(() => {});
      return { data: this.data, fromCache: true, stale: true };
    }

    try {
      const data = await this.refresh({ force: false });
      return { data, fromCache: false, stale: false };
    } catch (err) {
      if (this.data && allowStaleOnError) {
        return { data: this.data, fromCache: true, stale: true };
      }
      throw err;
    }
  }

  /** 启动时调用：有缓存且未过期则跳过；过期则后台增量刷新 */
  refreshIfStale(maxAgeMs = META_TTL_MS): void {
    if (this.data && !this.isStale(this.data, maxAgeMs)) return;
    void this.refresh({ force: false }).catch((err) => {
      console.warn("[dmcl] 元数据缓存刷新失败:", err instanceof Error ? err.message : err);
    });
  }

  private scheduleForgeMdkRefresh(forgeToProbe: string[], fullForgeRaw: string[]): void {
    if (forgeToProbe.length === 0) return;
    void filterForgeVersionsWithMdk(forgeToProbe)
      .then(() => {
        if (!this.data) return;
        const filtered = filterForgeVersionsUsingDiskCache(fullForgeRaw);
        const current = this.data.loaderVersions.forge;
        if (current.length === filtered.length && current.every((v, i) => v === filtered[i])) return;
        this.patchLoaderVersions("forge", filtered);
      })
      .catch((err) => {
        console.warn("[dmcl] Forge MDK 后台校验失败:", err instanceof Error ? err.message : err);
      });
  }

  private scheduleMappingsPrefetch(
    before: Record<LoaderId, string[]> | null,
    after: Record<LoaderId, string[]>,
  ): void {
    if (!before) return;
    const tasks: Partial<Record<LoaderId, string[]>> = {};
    for (const loader of ["fabric", "forge", "neoforge"] as LoaderId[]) {
      const prev = new Set(before[loader] ?? []);
      const added = (after[loader] ?? []).filter((mc) => !prev.has(mc));
      if (added.length > 0) tasks[loader] = added;
    }
    if (Object.keys(tasks).length === 0) return;
    void import("./mappings-cache.js")
      .then(({ getMappingsCache }) => getMappingsCache().prefetch(
        tasks as Record<LoaderId, string[]>,
        3,
      ))
      .catch(() => {});
  }

  async refresh(options: MetaCacheRefreshOptions = {}): Promise<MetaCacheData> {
    const result = await this.refreshDetailed(options);
    return result.data;
  }

  async refreshDetailed(options: MetaCacheRefreshOptions = {}): Promise<MetaCacheRefreshResult> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const previous = this.data;
    const force = options.force === true;

    this.refreshInFlight = (async (): Promise<MetaCacheRefreshResult> => {
      const upstream = await pullUpstreamMeta();
      const { data, forgeRaw } = buildMetaData(upstream);
      const newReleases = previous
        ? upstream.releaseVersions.filter((v) => !previous.releaseVersions.includes(v))
        : upstream.releaseVersions;
      const forgeToProbe = force
        ? forgeRaw
        : forgeVersionsNeedingMdkProbe(forgeRaw, new Set(newReleases));

      this.save(data);
      this.scheduleForgeMdkRefresh(forgeToProbe, forgeRaw);
      this.scheduleMappingsPrefetch(previous?.loaderVersions ?? null, data.loaderVersions);

      return {
        data,
        mode: !previous || force ? "full" : "incremental",
        newReleaseCount: newReleases.length,
        forgeMdkProbeCount: forgeToProbe.length,
      };
    })()
      .then((result) => {
        this.refreshInFlight = null;
        return result;
      })
      .catch((err) => {
        this.refreshInFlight = null;
        throw err;
      });

    return this.refreshInFlight;
  }

  /** 后台 Forge MDK 校验完成后更新 forge 版本列表 */
  patchLoaderVersions(loader: LoaderId, versions: string[]): void {
    if (!this.data) return;
    this.data = {
      ...this.data,
      updatedAt: new Date().toISOString(),
      loaderVersions: {
        ...this.data.loaderVersions,
        [loader]: versions,
      },
    };
    this.save(this.data);
  }

  async getLoaderVersions(loader: LoaderId): Promise<string[]> {
    const { data } = await this.get();
    return data.loaderVersions[loader] ?? [];
  }

  async getAllLoaderVersions(): Promise<Record<LoaderId, string[]>> {
    const { data } = await this.get();
    return data.loaderVersions;
  }

  async getReleaseVersions(): Promise<string[]> {
    const { data } = await this.get();
    return data.releaseVersions;
  }
}

let singleton: MetaCache | null = null;

export function getMetaCache(): MetaCache {
  if (!singleton) singleton = new MetaCache();
  return singleton;
}
