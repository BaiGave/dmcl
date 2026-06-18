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
