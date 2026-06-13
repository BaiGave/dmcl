import fs from "node:fs";
import path from "node:path";
import type { LoaderId, Logger, MappingsId, ProjectOptions } from "../types.js";
import { MAPPINGS_FOR_LOADER } from "../types.js";
import { scaffoldFabric } from "../loaders/fabric.js";
import { scaffoldForge } from "../loaders/forge.js";
import { scaffoldNeoForge } from "../loaders/neoforge.js";
import { applyChinaMirror } from "../core/mirror.js";
import { injectBuildscriptMirrors, injectMavenMirrors } from "../core/maven.js";
import { writeCursorConfig } from "../core/vscode.js";
import {
  detectJavaMajor,
  downloadWithFallback,
  extractJdk,
  fetchJdkDownloadUrl,
  findCachedJdk,
  injectJdkHome,
  jdkMirrorUrl,
  requiredJavaFor,
} from "../core/jdk.js";
import { spawnSync } from "node:child_process";
import os from "node:os";
import type { ManagedMod, ModVariant } from "./types.js";
import { defaultVariantPath } from "./paths.js";
import { getWorkspace } from "./store.js";

function pascalCase(input: string): string {
  const name = input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `Mod${name}`;
}

async function scaffold(opts: ProjectOptions, log: Logger): Promise<void> {
  await fs.promises.mkdir(opts.targetDir, { recursive: true });
  if (opts.loader === "fabric") await scaffoldFabric(opts, log);
  else if (opts.loader === "forge") await scaffoldForge(opts, log);
  else await scaffoldNeoForge(opts, log);

  if (opts.mirror) {
    await applyChinaMirror(opts.targetDir, log);
    await injectMavenMirrors(opts.targetDir, log);
    await injectBuildscriptMirrors(opts.targetDir, log);
  }
  await writeCursorConfig(opts.targetDir);
  const git = spawnSync("git", ["init", "-q"], { cwd: opts.targetDir });
  if (git.status === 0) log("已初始化 git 仓库");
}

async function ensureJdk(mcVersion: string, targetDir: string, log: Logger): Promise<void> {
  const java = requiredJavaFor(mcVersion);
  const detected = detectJavaMajor();
  if (detected !== null && detected >= java) return;

  const cached = findCachedJdk(java);
  if (cached) {
    log(`使用缓存的 JDK ${java}`);
    await injectJdkHome(targetDir, cached);
    return;
  }

  log(`自动下载 JDK ${java}…`);
  const asset = await fetchJdkDownloadUrl(java);
  if (!asset) throw new Error(`查询 JDK ${java} 下载地址失败`);

  const tmpDir = path.join(os.tmpdir(), `dmcl-jdk-${java}-${Date.now()}`);
  const zipDest = path.join(tmpDir, asset.filename);
  await fs.promises.mkdir(tmpDir, { recursive: true });
  await downloadWithFallback(
    [jdkMirrorUrl(java, asset.filename), asset.url],
    zipDest,
    asset.sizeBytes,
    () => {},
  );
  const jdkPath = await extractJdk(zipDest, java);
  await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await injectJdkHome(targetDir, jdkPath);
}

async function copyDir(src: string, dest: string): Promise<void> {
  if (!fs.existsSync(src)) return;
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else {
      await fs.promises.copyFile(from, to);
    }
  }
}

/** 从源变体复制业务代码到新项目 */
async function copySourceFromVariant(sourcePath: string, targetPath: string, log: Logger): Promise<void> {
  const pairs: Array<[string, string]> = [
    [path.join(sourcePath, "src", "main", "java"), path.join(targetPath, "src", "main", "java")],
    [path.join(sourcePath, "src", "main", "resources"), path.join(targetPath, "src", "main", "resources")],
  ];
  for (const [src, dest] of pairs) {
    if (fs.existsSync(src)) {
      await copyDir(src, dest);
      log(`已复制 ${path.relative(sourcePath, src)}`);
    }
  }
}

function pickMappings(loader: LoaderId, preferred?: MappingsId): MappingsId {
  const allowed = MAPPINGS_FOR_LOADER[loader];
  if (preferred && allowed.includes(preferred)) return preferred;
  return allowed[0];
}

export interface GenerateVariantInput {
  mod: ManagedMod;
  sourceVariant: ModVariant;
  targetLoader: LoaderId;
  targetMc: string;
  /** 省略时使用 projects/{modId}/ 下的默认路径 */
  parentDir?: string;
  mirror?: boolean;
  mappings?: MappingsId;
}

export async function generateVariant(
  input: GenerateVariantInput,
  log: Logger,
): Promise<ModVariant> {
  const { mod, sourceVariant, targetLoader, targetMc } = input;
  const targetDir = defaultVariantPath(mod.modId, targetLoader, targetMc);

  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`目录已存在且非空：${targetDir}`);
  }

  const mappings = pickMappings(targetLoader, input.mappings ?? sourceVariant.mappings);
  const opts: ProjectOptions = {
    loader: targetLoader,
    mcVersion: targetMc,
    modId: mod.modId,
    displayName: mod.displayName,
    className: pascalCase(mod.displayName),
    group: sourceVariant.group,
    targetDir,
    mirror: input.mirror !== false,
    mappings,
  };

  log(`正在生成 ${targetLoader} ${targetMc} 变体…`);
  await scaffold(opts, log);
  log("复制源码…");
  await copySourceFromVariant(sourceVariant.projectPath, targetDir, log);
  log("配置 JDK…");
  await ensureJdk(targetMc, targetDir, log);

  const store = getWorkspace();
  const variant = store.addVariant(mod.id, {
    loader: targetLoader,
    mcVersion: targetMc,
    projectPath: targetDir,
    modVersion: sourceVariant.modVersion,
    group: sourceVariant.group,
    mappings,
    buildStatus: "unknown",
    source: "dmcl",
  });

  log(`✔ 变体已创建：${targetDir}`);
  return variant;
}
