import { fetchJson, fetchText } from "../core/http.js";

const META = "https://meta.fabricmc.net/v2";

export async function fetchFabricGameVersions(): Promise<string[]> {
  const list = await fetchJson<Array<{ version: string; stable: boolean }>>(`${META}/versions/game`);
  return list.filter((v) => v.stable).map((v) => v.version);
}

export async function fetchFabricLoaderVersion(): Promise<string> {
  const list = await fetchJson<Array<{ version: string; stable: boolean }>>(`${META}/versions/loader`);
  return (list.find((v) => v.stable) ?? list[0]).version;
}

export async function fetchYarnVersion(mcVersion: string): Promise<string | null> {
  try {
    const list = await fetchJson<Array<{ version: string }>>(
      `${META}/versions/yarn/${encodeURIComponent(mcVersion)}?limit=1`,
    );
    return list[0]?.version ?? null;
  } catch {
    return null;
  }
}

/** Fabric API 版本：优先 Modrinth；国内网络不可达时退回官方 Maven 元数据 */
export async function fetchFabricApiVersion(mcVersion: string): Promise<string | null> {
  try {
    const url =
      `https://api.modrinth.com/v2/project/fabric-api/version` +
      `?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}` +
      `&loaders=${encodeURIComponent('["fabric"]')}`;
    const list = await fetchJson<Array<{ version_number: string }>>(url, { retries: 0, timeoutMs: 8_000 });
    if (list[0]?.version_number) return list[0].version_number;
  } catch {
    // 退回 Maven
  }
  try {
    const xml = await fetchText(
      "https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml",
    );
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    const matches = versions.filter((v) => v.endsWith(`+${mcVersion}`));
    return matches[matches.length - 1] ?? null;
  } catch {
    return null;
  }
}
