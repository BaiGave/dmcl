import { fetchText } from "../core/http.js";
import { META_ENDPOINTS } from "./sources.js";

/** 查询 Parchment 最新正式版，返回 null 表示该 MC 版本暂无 Parchment */
export async function fetchParchmentVersion(mcVersion: string): Promise<string | null> {
  try {
    const xml = await fetchText(
      META_ENDPOINTS.parchmentMetadata(mcVersion),
      { retries: 1, timeoutMs: 10_000 },
    );
    const m = xml.match(/<release>([^<]+)<\/release>/);
    if (!m) return null;
    const version = m[1].trim();
    if (version.endsWith("-SNAPSHOT")) return null;
    return version;
  } catch {
    return null;
  }
}
