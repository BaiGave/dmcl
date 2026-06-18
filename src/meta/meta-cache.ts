import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoaderId } from "../types.js";
import { fetchReleaseVersions } from "./mojang.js";
import { fetchFabricGameVersionsRaw, fetchFabricLoaderVersionRaw } from "./fabric.js";
import { fetchForgePromosRaw } from "./forge.js";
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

async function fetchFreshMeta(): Promise<MetaCacheData> {
  const [releaseVersions, fabricGameVersions, fabricLoaderVersion, forgePromos, neoforgeVersions] =
    await Promise.all([
      fetchReleaseVersions(),
      fetchFabricGameVersionsRaw(),
      fetchFabricLoaderVersionRaw(),
      fetchForgePromosRaw(),
      fetchNeoForgeVersionsRaw(),
    ]);

  return {
    version: META_CACHE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    releaseVersions,
    fabricGameVersions,
    fabricLoaderVersion,
    forgePromos,
    neoforgeVersions,
    loaderVersions: computeLoaderVersions(
      releaseVersions,
      fabricGameVersions,
      forgePromos,
      neoforgeVersions,
    ),
  };
}

export class MetaCache {
  private data: MetaCacheData | null = null;
  private refreshInFlight: Promise<MetaCacheData> | null = null;

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
      void this.refresh().catch(() => {});
      return { data: this.data, fromCache: true, stale: true };
    }

    try {
      const data = await this.refresh();
      return { data, fromCache: false, stale: false };
    } catch (err) {
      if (this.data && allowStaleOnError) {
        return { data: this.data, fromCache: true, stale: true };
      }
      throw err;
    }
  }

  /** 启动时调用：有缓存且未过期则跳过；过期则后台刷新 */
  refreshIfStale(maxAgeMs = META_TTL_MS): void {
    if (this.data && !this.isStale(this.data, maxAgeMs)) return;
    void this.refresh().catch((err) => {
      console.warn("[dmcl] 元数据缓存刷新失败:", err instanceof Error ? err.message : err);
    });
  }

  async refresh(): Promise<MetaCacheData> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = fetchFreshMeta()
      .then((data) => {
        this.save(data);
        this.refreshInFlight = null;
        return data;
      })
      .catch((err) => {
        this.refreshInFlight = null;
        throw err;
      });

    return this.refreshInFlight;
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
