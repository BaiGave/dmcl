import { fetchJson } from "../core/http.js";
import { GITHUB_DEFAULT_BRANCHES, META_ENDPOINTS } from "./sources.js";
import { getMetaCache } from "./meta-cache.js";

export async function fetchNeoForgeVersions(): Promise<string[]> {
  const { data } = await getMetaCache().get();
  return data.neoforgeVersions;
}

export async function fetchNeoForgeVersionsRaw(): Promise<string[]> {
  const data = await fetchJson<{ versions: string[] }>(META_ENDPOINTS.neoforgeVersions);
  return data.versions;
}

export function neoPrefixFor(mcVersion: string): string {
  if (mcVersion.startsWith("1.")) {
    const rest = mcVersion.slice(2);
    return rest.includes(".") ? rest : `${rest}.0`;
  }
  return mcVersion;
}

export function pickNeoForgeVersion(versions: string[], mcVersion: string): string | null {
  const prefix = neoPrefixFor(mcVersion);
  const expectedSegments = prefix.split(".").length + 1;
  const matches = versions.filter(
    (v) => v.startsWith(`${prefix}.`) && v.split(".").length === expectedSegments,
  );
  if (matches.length === 0) return null;
  const stable = matches.filter((v) => !/-(beta|alpha|rc)/.test(v));
  const pool = stable.length > 0 ? stable : matches;
  return pool[pool.length - 1];
}

function mdkBranchZips(repo: string): string[] {
  return GITHUB_DEFAULT_BRANCHES.map((branch) =>
    META_ENDPOINTS.neoforgeMdkBranchZip(repo, branch)
  );
}

export function neoMdkTemplateFamily(mcVersion: string): "NeoGradle" | "ModDevGradle" {
  const match = /^1\.20\.(\d+)$/.exec(mcVersion);
  if (match && Number.parseInt(match[1], 10) <= 5) return "NeoGradle";
  return "ModDevGradle";
}

export function neoMdkZipCandidates(mcVersion: string): string[] {
  const family = neoMdkTemplateFamily(mcVersion);
  const repos = [`MDK-${mcVersion}-${family}`];
  const parts = mcVersion.split(".");
  if (parts.length === 3 && family === "ModDevGradle") {
    repos.push(`MDK-${parts[0]}.${parts[1]}-ModDevGradle`);
  }
  return repos.flatMap(mdkBranchZips);
}

export function neoMdkFallbackCandidates(mcVersion: string): string[] {
  const parts = mcVersion.split(".");
  if (parts.length < 3) return [];
  const patch = Number.parseInt(parts[2], 10);
  if (Number.isNaN(patch)) return [];
  const minor = `${parts[0]}.${parts[1]}`;
  const family = neoMdkTemplateFamily(mcVersion);
  const nearbyPatches = family === "NeoGradle"
    ? [patch - 1, patch + 1, patch - 2, patch + 2].filter((value) => value >= 0)
    : [patch + 1, patch + 2];
  return nearbyPatches.flatMap((p) =>
    mdkBranchZips(`MDK-${minor}.${p}-${family}`)
  );
}
