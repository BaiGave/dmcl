import type { LoaderId } from "../types.js";
import { LOADER_LABELS } from "../types.js";
import { getMetaCache } from "../meta/meta-cache.js";
import type { ManagedMod, MatrixCell, MatrixCellStatus } from "./types.js";

const LOADERS: LoaderId[] = ["fabric", "forge", "neoforge"];
/** 矩阵列：各加载器支持版本的并集，按 Mojang 正式版发布时间从新到旧排序 */
function pickMatrixVersions(
  loaderVersions: Record<LoaderId, string[]>,
  releaseOrder: string[],
): string[] {
  const supportedUnion = new Set<string>();
  for (const loader of LOADERS) {
    for (const v of loaderVersions[loader]) supportedUnion.add(v);
  }
  return releaseOrder.filter((v) => supportedUnion.has(v));
}

export interface MatrixResult {
  loaders: Array<{ id: LoaderId; label: string }>;
  versions: string[];
  cells: MatrixCell[];
  supported: Record<LoaderId, Set<string>>;
}

/** 将矩阵结果转为可 JSON 序列化的对象（Set → string[]） */
export function serializeMatrixResult(result: MatrixResult): Omit<MatrixResult, "supported"> & {
  supported: Record<LoaderId, string[]>;
} {
  return {
    loaders: result.loaders,
    versions: result.versions,
    cells: result.cells,
    supported: {
      fabric: [...result.supported.fabric],
      forge: [...result.supported.forge],
      neoforge: [...result.supported.neoforge],
    },
  };
}

interface MatrixMeta {
  releaseOrder: string[];
  loaderVersions: Record<LoaderId, string[]>;
  versions: string[];
  supported: Record<LoaderId, Set<string>>;
}

let matrixMetaCache: { updatedAt: string; meta: MatrixMeta } | null = null;
const modMatrixCache = new Map<string, { modUpdatedAt: string; result: MatrixResult }>();

async function loadMatrixMeta(): Promise<MatrixMeta> {
  const { data } = await getMetaCache().get({ strategy: "cache-first" });
  if (matrixMetaCache && matrixMetaCache.updatedAt === data.updatedAt) {
    return matrixMetaCache.meta;
  }

  const loaderVersions = data.loaderVersions;
  const versions = pickMatrixVersions(loaderVersions, data.releaseVersions);
  const supported: Record<LoaderId, Set<string>> = {
    fabric: new Set(loaderVersions.fabric),
    forge: new Set(loaderVersions.forge),
    neoforge: new Set(loaderVersions.neoforge),
  };
  const meta: MatrixMeta = {
    releaseOrder: data.releaseVersions,
    loaderVersions,
    versions,
    supported,
  };
  matrixMetaCache = { updatedAt: data.updatedAt, meta };
  return meta;
}
export function invalidateMatrixCache(modId?: string): void {
  if (modId) modMatrixCache.delete(modId);
  else {
    modMatrixCache.clear();
    matrixMetaCache = null;
  }
}
function modMatrixCacheKey(mod: ManagedMod): string {
  const buildStates = mod.variants
    .map((v) => `${v.id}:${v.buildStatus}`)
    .sort()
    .join("|");
  return `${mod.updatedAt}\0${buildStates}`;
}

export async function buildMatrix(mod: ManagedMod): Promise<MatrixResult> {
  const cacheKey = modMatrixCacheKey(mod);
  const cached = modMatrixCache.get(mod.id);
  if (cached && cached.modUpdatedAt === cacheKey) {
    return cached.result;
  }

  const meta = await loadMatrixMeta();
  const cells: MatrixCell[] = [];

  for (const loader of LOADERS) {
    for (const mcVersion of meta.versions) {
      const variant = mod.variants.find(
        (v) => v.loader === loader && v.mcVersion === mcVersion,
      );

      let status: MatrixCellStatus;
      if (variant) {
        if (variant.buildStatus === "building") status = "building";
        else if (variant.buildStatus === "success") status = "built";
        else if (variant.buildStatus === "failed") status = "failed";
        else status = "exists";
      } else if (meta.supported[loader].has(mcVersion)) {
        status = "available";
      } else {
        status = "unsupported";
      }

      cells.push({
        loader,
        mcVersion,
        status,
        variantId: variant?.id,
      });
    }
  }

  const result: MatrixResult = {
    loaders: LOADERS.map((id) => ({ id, label: LOADER_LABELS[id] })),
    versions: meta.versions,
    cells,
    supported: meta.supported,
  };

  modMatrixCache.set(mod.id, { modUpdatedAt: cacheKey, result });
  return result;
}
