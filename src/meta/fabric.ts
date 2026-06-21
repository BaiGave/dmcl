import { fetchJson, fetchText, probeUrl } from "../core/http.js";
import { getMetaCache } from "./meta-cache.js";
import { META_ENDPOINTS } from "./sources.js";

export async function fetchFabricGameVersionsRaw(): Promise<string[]> {
  const list = await fetchJson<Array<{ version: string; stable: boolean }>>(
    META_ENDPOINTS.fabricGameVersions,
  );
  return list.filter((v) => v.stable).map((v) => v.version);
}

export async function fetchFabricLoaderVersionRaw(): Promise<string> {
  const list = await fetchJson<Array<{ version: string; stable: boolean }>>(
    META_ENDPOINTS.fabricLoaderVersions,
  );
  return (list.find((v) => v.stable) ?? list[0]).version;
}

export async function fetchFabricLoaderVersion(): Promise<string> {
  const { data } = await getMetaCache().get({ strategy: "cache-first" });
  return data.fabricLoaderVersion;
}

/** 某 MC 版本对应的稳定 Fabric Loader（优先于全局最新版） */
export async function fetchFabricLoaderForMc(mcVersion: string): Promise<string | null> {
  try {
    const list = await fetchJson<Array<{ loader: { version: string; stable: boolean } }>>(
      META_ENDPOINTS.fabricLoaderForMc(mcVersion),
    );
    const stable = list.find((e) => e.loader.stable);
    return (stable ?? list[0])?.loader.version ?? null;
  } catch {
    return fetchFabricLoaderVersion().catch(() => null);
  }
}

export async function fetchYarnVersion(mcVersion: string): Promise<string | null> {
  try {
    const list = await fetchJson<Array<{ version: string }>>(
      META_ENDPOINTS.fabricYarnForMc(mcVersion),
    );
    return list[0]?.version ?? null;
  } catch {
    return null;
  }
}

interface ModrinthFabricVersion {
  version_number: string;
  game_versions: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSemverTriple(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const [a1, a2, a3] = parseSemverTriple(a);
  const [b1, b2, b3] = parseSemverTriple(b);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  return a3 - b3;
}

/**
 * Fabric API 版本号是否面向指定 MC 版本。
 * 支持 Maven（0.42.0+1.16）与 Modrinth/build（0.18.0+build.387-1.16.1）两种命名。
 * 禁止把 1.16.1 宽泛匹配到 +1.16（0.42.0+1.16 需要 MC 1.16.2+）。
 */
export function fabricApiVersionTargetsMc(version: string, mcVersion: string): boolean {
  const mc = escapeRegex(mcVersion);
  if (new RegExp(`\\+${mc}$`).test(version)) return true;
  if (new RegExp(`-${mc}$`).test(version)) return true;

  const parts = mcVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  if (parts.length === 3 && parts[0] === 1 && parts[1] === 16 && parts[2] >= 2) {
    if (/\+1\.16$/.test(version)) {
      return compareSemver(version.split("+")[0], "0.42.0") >= 0;
    }
  }
  return false;
}

function pickBestMavenFabricApiVersion(versions: string[], mcVersion: string): string | null {
  const exact = versions.filter((version) => fabricApiVersionTargetsMc(version, mcVersion));
  if (exact.length === 0) return null;

  if (mcVersion === "1.16") {
    const safe = exact.filter((version) => compareSemver(version.split("+")[0], "0.42.0") < 0);
    if (safe.length > 0) return safe[safe.length - 1];
  }

  return exact[exact.length - 1];
}

function fabricApiMavenPomUrl(version: string): string {
  return `https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/${encodeURIComponent(version)}/fabric-api-${encodeURIComponent(version)}.pom`;
}

export async function isFabricApiVersionPublished(version: string): Promise<boolean> {
  return (await probeUrl(fabricApiMavenPomUrl(version), { retries: 1, timeoutMs: 12_000 })) === "ok";
}

/** Fabric API 版本：优先 Modrinth（按 game_versions）；不可达时退回 Maven 元数据 */
export async function fetchFabricApiVersion(mcVersion: string): Promise<string | null> {
  let modrinthCandidate: string | null = null;
  try {
    const list = await fetchJson<ModrinthFabricVersion[]>(
      META_ENDPOINTS.fabricApiModrinth(mcVersion),
      { retries: 1, timeoutMs: 12_000 },
    );
    const tagged = list.find((entry) => entry.game_versions?.includes(mcVersion));
    if (tagged) modrinthCandidate = tagged.version_number;
    else {
      const matched = list.find((entry) => fabricApiVersionTargetsMc(entry.version_number, mcVersion));
      if (matched) modrinthCandidate = matched.version_number;
    }
  } catch {
    // 退回 Maven
  }

  if (modrinthCandidate && await isFabricApiVersionPublished(modrinthCandidate)) {
    return modrinthCandidate;
  }

  try {
    const xml = await fetchText(
      META_ENDPOINTS.fabricApiMavenMetadata,
      { retries: 1, timeoutMs: 12_000 },
    );
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
    const picked = pickBestMavenFabricApiVersion(versions, mcVersion);
    if (picked && await isFabricApiVersionPublished(picked)) return picked;
  } catch {
    return null;
  }
  return null;
}

