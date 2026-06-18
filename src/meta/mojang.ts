import { fetchJson } from "../core/http.js";
import { META_ENDPOINTS } from "./sources.js";

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: Array<{ id: string; type: string }>;
}

/** 返回所有正式版版本号，按从新到旧排列 */
export async function fetchReleaseVersions(): Promise<string[]> {
  const data = await fetchJson<VersionManifest>(META_ENDPOINTS.mojangVersionManifest);
  return data.versions.filter((v) => v.type === "release").map((v) => v.id);
}
