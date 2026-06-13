import type { LoaderId } from "../types.js";
import { LOADER_LABELS } from "../types.js";
import { allLoaderVersions } from "../meta/versions.js";
import type { ManagedMod, MatrixCell, MatrixCellStatus } from "./types.js";

const LOADERS: LoaderId[] = ["fabric", "neoforge", "forge"];

function majorMinor(v: string): string {
  const parts = v.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : v;
}

/** 为模组详情页计算列版本：已有变体版本 + 同主次版本族 */
function pickMatrixVersions(mod: ManagedMod, allVersions: string[]): string[] {
  const existing = new Set(mod.variants.map((v) => v.mcVersion));
  const families = new Set(mod.variants.map((v) => majorMinor(v.mcVersion)));

  const picked = new Set<string>();
  for (const v of existing) picked.add(v);

  for (const v of allVersions) {
    if (families.has(majorMinor(v))) picked.add(v);
  }

  if (picked.size === 0) {
    return allVersions.slice(0, 8);
  }

  const order = new Map(allVersions.map((v, i) => [v, i]));
  return [...picked].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
}

export interface MatrixResult {
  loaders: Array<{ id: LoaderId; label: string }>;
  versions: string[];
  cells: MatrixCell[];
  supported: Record<LoaderId, Set<string>>;
}

export async function buildMatrix(mod: ManagedMod): Promise<MatrixResult> {
  const loaderVersions = await allLoaderVersions();
  const allMc = [...new Set(Object.values(loaderVersions).flat())];
  const versions = pickMatrixVersions(mod, allMc);

  const supported: Record<LoaderId, Set<string>> = {
    fabric: new Set(loaderVersions.fabric),
    forge: new Set(loaderVersions.forge),
    neoforge: new Set(loaderVersions.neoforge),
  };

  const cells: MatrixCell[] = [];

  for (const loader of LOADERS) {
    for (const mcVersion of versions) {
      const variant = mod.variants.find(
        (v) => v.loader === loader && v.mcVersion === mcVersion,
      );

      let status: MatrixCellStatus;
      if (variant) {
        if (variant.buildStatus === "building") status = "building";
        else if (variant.buildStatus === "success") status = "built";
        else if (variant.buildStatus === "failed") status = "failed";
        else status = "exists";
      } else if (supported[loader].has(mcVersion)) {
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

  return {
    loaders: LOADERS.map((id) => ({ id, label: LOADER_LABELS[id] })),
    versions,
    cells,
    supported: {
      fabric: supported.fabric,
      forge: supported.forge,
      neoforge: supported.neoforge,
    },
  };
}
