import fs from "node:fs";
import path from "node:path";
import type { LoaderId, Logger, MappingsId, ProjectOptions } from "../types.js";
import { DEFAULT_MAPPINGS, MAPPINGS_FOR_LOADER } from "../types.js";
import { scaffoldProject, pascalCase } from "../core/scaffold.js";
import { ensureForgeMavenizerJdkCache } from "../core/forge-mavenizer.js";
import {
  ensureProjectJdk,
} from "../core/jdk.js";
import type { ManagedMod, ModVariant } from "./types.js";
import { defaultVariantPath } from "./paths.js";
import { getWorkspace } from "./store.js";

async function ensureJdk(mcVersion: string, targetDir: string, log: Logger): Promise<void> {
  await ensureProjectJdk(targetDir, mcVersion, log);
  await ensureForgeMavenizerJdkCache(targetDir, log);
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
  return DEFAULT_MAPPINGS[loader];
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
  await scaffoldProject(opts, log);
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
