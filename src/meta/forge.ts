import { fetchJson } from "../core/http.js";

let promosCache: Record<string, string> | null = null;

export async function fetchForgePromos(): Promise<Record<string, string>> {
  if (!promosCache) {
    const data = await fetchJson<{ promos: Record<string, string> }>(
      "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
    );
    promosCache = data.promos;
  }
  return promosCache;
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
  const full = `${mcVersion}-${forgeVersion}`;
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-mdk.zip`;
}
