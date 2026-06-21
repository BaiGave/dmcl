import type { LoaderId } from "../types.js";
import { compareMcVersions, FABRIC_MIN_MC_VERSION } from "./mc-version.js";
import { pickNeoForgeVersion } from "./neoforge.js";

export function forgeMcVersionFromPromoKey(key: string): string {
  return key.replace(/-(latest|recommended)$/, "");
}

export function computeLoaderVersions(
  releaseVersions: string[],
  fabricGameVersions: string[],
  forgePromos: Record<string, string>,
  neoforgeVersions: string[],
): Record<LoaderId, string[]> {
  const fabricSet = new Set(fabricGameVersions);
  const forgeSet = new Set(Object.keys(forgePromos).map(forgeMcVersionFromPromoKey));

  return {
    fabric: releaseVersions.filter(
      (version) => fabricSet.has(version) && compareMcVersions(version, FABRIC_MIN_MC_VERSION) >= 0,
    ),
    forge: releaseVersions.filter((version) => forgeSet.has(version)),
    neoforge: releaseVersions.filter(
      (version) => pickNeoForgeVersion(neoforgeVersions, version) !== null,
    ),
  };
}
