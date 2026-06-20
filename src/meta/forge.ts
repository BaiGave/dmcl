import { fetchJson } from "../core/http.js";
import { probeUrl } from "../core/http.js";
import { getMetaCache } from "./meta-cache.js";
import { META_ENDPOINTS } from "./sources.js";
import {
  filterForgeVersionsUsingDiskCache,
  getForgeMdkCached,
  setForgeMdkCached,
} from "./forge-mdk-cache.js";

const mdkAvailableCache = new Map<string, boolean>();

function rememberForgeMdk(mcVersion: string, ok: boolean): void {
  mdkAvailableCache.set(mcVersion, ok);
  setForgeMdkCached(mcVersion, ok);
}

export function forgeMdkCandidates(
  mcVersion: string,
  forgeVersion: string,
  mirror = true,
): string[] {
  const official = META_ENDPOINTS.forgeMdkZip(mcVersion, forgeVersion);
  if (!mirror) return [official];
  return [
    META_ENDPOINTS.forgeMdkZipBmcl(mcVersion, forgeVersion),
    official,
  ];
}

export type ForgeMdkResolve =
  | { status: "ok"; url: string; tried: string[] }
  | { status: "missing"; tried: string[] }
  | { status: "unreachable"; tried: string[] };

export async function resolveForgeMdkUrl(
  mcVersion: string,
  forgeVersion: string,
  mirror = true,
): Promise<ForgeMdkResolve> {
  const tried: string[] = [];
  let sawMissing = false;
  for (const url of forgeMdkCandidates(mcVersion, forgeVersion, mirror)) {
    tried.push(url);
    const probe = await probeUrl(url, { timeoutMs: 15_000, retries: 2 });
    if (probe === "ok") return { status: "ok", url, tried };
    if (probe === "missing") sawMissing = true;
  }
  if (sawMissing) return { status: "missing", tried };
  return { status: "unreachable", tried };
}

export async function isForgeMdkAvailable(mcVersion: string): Promise<boolean> {
  if (mdkAvailableCache.has(mcVersion)) return mdkAvailableCache.get(mcVersion)!;
  const disk = getForgeMdkCached(mcVersion);
  if (disk !== undefined) {
    mdkAvailableCache.set(mcVersion, disk);
    return disk;
  }
  const forgeVersion = await pickForgeVersion(mcVersion);
  if (!forgeVersion) {
    rememberForgeMdk(mcVersion, false);
    return false;
  }
  const resolved = await resolveForgeMdkUrl(mcVersion, forgeVersion, true);
  if (resolved.status === "ok") {
    rememberForgeMdk(mcVersion, true);
    return true;
  }
  if (resolved.status === "missing") {
    rememberForgeMdk(mcVersion, false);
    return false;
  }
  // 网络失败时不写入 false 缓存，避免把新版本误判为「无 MDK」
  return true;
}

export { filterForgeVersionsUsingDiskCache } from "./forge-mdk-cache.js";

export async function filterForgeVersionsWithMdk(
  mcVersions: string[],
  concurrency = 12,
): Promise<string[]> {  const kept: string[] = [];
  let index = 0;
  async function worker(): Promise<void> {
    while (index < mcVersions.length) {
      const i = index++;
      if (await isForgeMdkAvailable(mcVersions[i])) kept.push(mcVersions[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, mcVersions.length) }, () => worker()),
  );
  kept.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return kept;
}

export async function fetchForgePromos(): Promise<Record<string, string>> {
  const { data } = await getMetaCache().get({ strategy: "cache-first" });
  return data.forgePromos;
}

/** 强制从网络拉取 Forge promotions（仅供 meta-cache 刷新） */
export async function fetchForgePromosRaw(): Promise<Record<string, string>> {
  const data = await fetchJson<{ promos: Record<string, string> }>(META_ENDPOINTS.forgePromos);
  return data.promos;
}

/** Forge 支持的 MC 版本集合（出现在 promotions 里的版本） */
export async function forgeSupportedMcVersions(): Promise<Set<string>> {
  const promos = await fetchForgePromos();
  return new Set(Object.keys(promos).map((k) => k.replace(/-(latest|recommended)$/, "")));
}

/** 取某 MC 版本的 Forge 版本，优先 recommended */
export async function pickForgeVersion(mcVersion: string): Promise<string | null> {
  const promos = await fetchForgePromos();
  return promos[`${mcVersion}-recommended`] ?? promos[`${mcVersion}-latest`] ?? null;
}

export function forgeMdkUrl(mcVersion: string, forgeVersion: string): string {
  return META_ENDPOINTS.forgeMdkZip(mcVersion, forgeVersion);
}
