import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { fetchJson, UA } from "./http.js";

const JDK_CACHE = path.join(os.homedir(), ".mcdev", "jdks");
const UA_HEADER = { "user-agent": UA };

interface AdoptiumAsset {
  binary: {
    os: string;
    architecture: string;
    image_type: string;
    package: { name: string; link: string; size: number };
  };
  version: { major: number; openjdk_version: string };
}

function currentOs(): string {
  const p = process.platform;
  if (p === "win32") return "windows";
  if (p === "darwin") return "mac";
  return "linux";
}

function currentArch(): string {
  const a = process.arch;
  if (a === "x64") return "x64";
  if (a === "arm64") return "aarch64";
  return a;
}

/** MC 版本 → 所需 Java 主版本 */
export function requiredJavaFor(mcVersion: string): number {
  const m = mcVersion.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return 21;
  const a = Number(m[1]);
  const b = Number(m[2] ?? 0);
  const c = Number(m[3] ?? 0);
  if (a >= 26) return 25;
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
    return major === 1 ? Number(m[2] ?? 0) : major;
  } catch {
    return null;
  }
}

/** 查询 Adoptium API 获取 JDK 下载链接 */
export async function fetchJdkDownloadUrl(javaMajor: number): Promise<{
  url: string;
  filename: string;
  sizeBytes: number;
  versionLabel: string;
} | null> {
  try {
    const assets = await fetchJson<AdoptiumAsset[]>(
      `https://api.adoptium.net/v3/assets/latest/${javaMajor}/hotspot`,
      { retries: 1 },
    );
    const os = currentOs();
    const arch = currentArch();
    const match = assets.find(
      (a) =>
        a.binary.os === os &&
        a.binary.architecture === arch &&
        a.binary.image_type === "jdk",
    );
    if (!match) return null;
    return {
      url: match.binary.package.link,
      filename: match.binary.package.name,
      sizeBytes: match.binary.package.size,
      versionLabel: match.version.openjdk_version,
    };
  } catch {
    return null;
  }
}

/** 流式下载文件，每 2 MB 回调一次进度 */
export async function downloadWithProgress(
  url: string,
  dest: string,
  totalBytes: number,
  onProgress: (pct: number) => void,
): Promise<void> {
  const res = await fetch(url, { headers: UA_HEADER });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  if (!res.body) throw new Error("响应无 body");

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    onProgress(Math.round((downloaded / totalBytes) * 100));
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, Buffer.concat(chunks));
}

/** 检查缓存，返回已下载的 JDK 路径 */
export function findCachedJdk(javaMajor: number): string | null {
  const dir = path.join(JDK_CACHE, String(javaMajor));
  if (!fs.existsSync(path.join(dir, "bin"))) return null;
  return dir;
}

/** 解压 JDK zip，返回解压后的根目录路径 */
export async function extractJdk(zipPath: string, javaMajor: number): Promise<string> {
  const dest = path.join(JDK_CACHE, String(javaMajor));
  await fs.promises.mkdir(dest, { recursive: true });
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  // 找到第一个目录条目作为根
  const firstDir = entries.find((e) => e.isDirectory && !e.entryName.startsWith("__"));
  const strip = firstDir ? `${firstDir.entryName}` : "";
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const rel = strip && entry.entryName.startsWith(strip)
      ? entry.entryName.slice(strip.length)
      : entry.entryName;
    if (!rel) continue;
    const target = path.join(dest, ...rel.split("/"));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, entry.getData());
  }
  // 返回解压根目录
  return dest;
}

/** 将 org.gradle.java.home 注入项目的 gradle.properties */
export async function injectJdkHome(targetDir: string, jdkPath: string): Promise<void> {
  const propsFile = path.join(targetDir, "gradle.properties");
  let content = "";
  if (fs.existsSync(propsFile)) {
    content = await fs.promises.readFile(propsFile, "utf8");
  }
  // 确保不以多余空行结尾
  const escaped = jdkPath.replace(/\\/g, "/");
  const marker = "org.gradle.java.home";
  if (content.includes(marker)) {
    content = content.replace(/^org\.gradle\.java\.home=.*$/m, `${marker}=${escaped}`);
  } else {
    content = `${content.trimEnd()}\n${marker}=${escaped}\n`;
  }
  await fs.promises.writeFile(propsFile, content, "utf8");
}
