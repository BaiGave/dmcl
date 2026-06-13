import type { LoaderId } from "../types.js";
import { fetchReleaseVersions } from "./mojang.js";
import { fetchFabricGameVersions } from "./fabric.js";
import { forgeSupportedMcVersions } from "./forge.js";
import { fetchNeoForgeVersions, pickNeoForgeVersion } from "./neoforge.js";

/** 某加载器官方支持的 MC 正式版列表（从新到旧） */
export async function supportedVersions(loader: LoaderId, releases?: string[]): Promise<string[]> {
  const all = releases ?? await fetchReleaseVersions();
  if (loader === "fabric") {
    const fab = new Set(await fetchFabricGameVersions());
    return all.filter((v) => fab.has(v));
  }
  if (loader === "forge") {
    const set = await forgeSupportedMcVersions();
    return all.filter((v) => set.has(v));
  }
  const versions = await fetchNeoForgeVersions();
  return all.filter((v) => pickNeoForgeVersion(versions, v) !== null);
}

export async function allLoaderVersions(): Promise<Record<LoaderId, string[]>> {
  const releases = await fetchReleaseVersions();
  const [fabric, forge, neoforge] = await Promise.all([
    supportedVersions("fabric", releases),
    supportedVersions("forge", releases),
    supportedVersions("neoforge", releases),
  ]);
  return { fabric, forge, neoforge };
}
