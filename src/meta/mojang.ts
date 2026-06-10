import { fetchJson } from "../core/http.js";

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: Array<{ id: string; type: string }>;
}

/** 返回所有正式版版本号，按从新到旧排列 */
export async function fetchReleaseVersions(): Promise<string[]> {
  const data = await fetchJson<VersionManifest>(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  );
  return data.versions.filter((v) => v.type === "release").map((v) => v.id);
}
