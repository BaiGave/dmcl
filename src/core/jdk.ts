import { spawnSync } from "node:child_process";

/** MC 版本 → 所需 Java 主版本 */
export function requiredJavaFor(mcVersion: string): number {
  const m = mcVersion.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return 21;
  const a = Number(m[1]);
  const b = Number(m[2] ?? 0);
  const c = Number(m[3] ?? 0);
  if (a >= 26) return 25; // 2026 起的新版本号方案
  if (a !== 1) return 21;
  if (b >= 21) return 21;
  if (b === 20) return c >= 5 ? 21 : 17;
  if (b >= 18) return 17;
  if (b === 17) return 16;
  return 8;
}

/** 检测 PATH 中 java 的主版本号，检测不到返回 null */
export function detectJavaMajor(): number | null {
  try {
    const res = spawnSync("java", ["-version"], { encoding: "utf8", timeout: 15_000 });
    const out = `${res.stderr ?? ""}${res.stdout ?? ""}`;
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const major = Number(m[1]);
    // 旧格式 1.8.0_xx → 8
    return major === 1 ? Number(m[2] ?? 0) : major;
  } catch {
    return null;
  }
}

export function adoptiumDownloadUrl(javaMajor: number): string {
  return `https://adoptium.net/zh-CN/temurin/releases/?version=${javaMajor}`;
}
