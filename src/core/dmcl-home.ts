import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DmclHomeResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execPath?: string;
  fileExists?: (file: string) => boolean;
}

/**
 * DMCL 的可写数据根目录。
 *
 * 优先级：DMCL_HOME > EXE 旁 portable.flag > 平台本地数据目录。
 * 该路径不依赖安装目录，打包到 Program Files 后仍然可写。
 */
export function resolveDmclHome(options: DmclHomeResolveOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const execPath = path.resolve(options.execPath ?? process.execPath);
  const fileExists = options.fileExists ?? fs.existsSync;

  const configured = env.DMCL_HOME?.trim();
  if (configured) return path.resolve(configured);

  const executableDir = path.dirname(execPath);
  if (fileExists(path.join(executableDir, "portable.flag"))) {
    return path.join(executableDir, "data");
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA
      ?? path.join(homeDir, "AppData", "Local");
    return path.join(localAppData, "DMCL");
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "DMCL");
  }
  const dataHome = env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share");
  return path.join(dataHome, "dmcl");
}

export function getDmclHome(): string {
  return resolveDmclHome();
}

export function ensureDmclHome(): string {
  const root = getDmclHome();
  fs.mkdirSync(root, { recursive: true });
  return root;
}
