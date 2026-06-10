import { fetchJson } from "../core/http.js";

let versionsCache: string[] | null = null;

export async function fetchNeoForgeVersions(): Promise<string[]> {
  if (!versionsCache) {
    const data = await fetchJson<{ versions: string[] }>(
      "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
    );
    versionsCache = data.versions;
  }
  return versionsCache;
}

/**
 * MC 版本 → NeoForge 版本前缀：
 * 旧方案 1.21.4 → 21.4，1.21 → 21.0；新方案（26.x 起）版本号直接同名
 */
export function neoPrefixFor(mcVersion: string): string {
  if (mcVersion.startsWith("1.")) {
    const rest = mcVersion.slice(2);
    return rest.includes(".") ? rest : `${rest}.0`;
  }
  return mcVersion;
}

/** 选取某 MC 版本对应的最新 NeoForge 版本（优先正式版） */
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

/** NeoForge 官方 MDK 模板仓库候选（按优先级） */
export function neoMdkZipCandidates(mcVersion: string): string[] {
  const repos = [`MDK-${mcVersion}-ModDevGradle`];
  const parts = mcVersion.split(".");
  if (parts.length === 3) {
    repos.push(`MDK-${parts[0]}.${parts[1]}-ModDevGradle`);
  }
  return repos.flatMap((repo) => [
    `https://codeload.github.com/NeoForgeMDKs/${repo}/zip/refs/heads/main`,
    `https://codeload.github.com/NeoForgeMDKs/${repo}/zip/refs/heads/master`,
  ]);
}
