/** 用于特性判断的版本号：1.21.4 → 21，26.1.2 → 26 */
export function mcFeatureNumber(mcVersion: string): number {
  const parts = mcVersion.split(".").map((p) => parseInt(p, 10) || 0);
  if (parts[0] === 1) return parts[1] ?? 0;
  return parts[0];
}

export function isLegacy1xMc(mcVersion: string): boolean {
  return mcVersion.startsWith("1.");
}

/** MC 26+ 官方取消混淆，Fabric 使用 fabric-loom（非 remap） */
export function isUnobfuscatedMc(mcVersion: string): boolean {
  return mcFeatureNumber(mcVersion) >= 26;
}

export function compareMcVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  const length = Math.max(aa.length, bb.length);
  for (let index = 0; index < length; index++) {
    const diff = (aa[index] ?? 0) - (bb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Forge 1.16.4 及更早的 MDK 默认使用 MCP snapshot/stable，而不是 MojMap。 */
export function usesLegacyForgeMcp(mcVersion: string): boolean {
  return compareMcVersions(mcVersion, "1.16.5") < 0;
}

/** MC 1.18+ / 26+ 支持 Fabric Loom splitEnvironmentSourceSets */
export function supportsSplitSources(mcVersion: string): boolean {
  return mcFeatureNumber(mcVersion) >= 18;
}
