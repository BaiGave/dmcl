import type { LoaderId } from "../types.js";
import { getMetaCache, type MetaCacheGetOptions } from "./meta-cache.js";

export async function supportedVersions(
  loader: LoaderId,
  opts?: MetaCacheGetOptions,
): Promise<string[]> {
  const { data } = await getMetaCache().get(opts);
  return data.loaderVersions[loader] ?? [];
}

export async function allLoaderVersions(
  opts?: MetaCacheGetOptions,
): Promise<Record<LoaderId, string[]>> {
  const { data } = await getMetaCache().get(opts);
  return data.loaderVersions;
}
