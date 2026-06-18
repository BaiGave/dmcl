import { fetchJson } from "../core/http.js";
import { getMetaCache } from "./meta-cache.js";
import { META_ENDPOINTS } from "./sources.js";

export async function fetchForgePromos(): Promise<Record<string, string>> {
  const { data } = await getMetaCache().get();
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
