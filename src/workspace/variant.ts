import fs from "node:fs";
import path from "node:path";
import type { LoaderId, Logger, MappingsId, ProjectOptions } from "../types.js";
import { DEFAULT_MAPPINGS, MAPPINGS_FOR_LOADER } from "../types.js";
import { scaffoldProject, pascalCase } from "../core/scaffold.js";
import { applyProjectIdentity } from "../core/project-identity.js";
import { ensureProjectToolchain } from "../core/toolchain.js";
import type { ManagedMod, ModVariant } from "./types.js";
import { defaultVariantPath } from "./paths.js";
import { detectProject } from "./detect.js";
import { getWorkspace } from "./store.js";
import { copySharedModAssets, stripForeignLoaderMetadata, repairCrossLoaderProject } from "./cross-loader.js";
import { inferModDir } from "./project-meta.js";

async function ensureJdk(mcVersion: string, targetDir: string, log: Logger): Promise<void> {
  await ensureProjectToolchain(targetDir, mcVersion, log);
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
  const store = getWorkspace();
  store.refresh({ force: true });

  const freshMod = store.resolveMod(mod.id, targetDir) ?? store.findModByModId(mod.modId);
  if (freshMod) {
    const already = freshMod.variants.find(
      (v) => v.loader === targetLoader && v.mcVersion === targetMc,
    );
    if (already) {
      log(`变体已存在，跳过：${already.projectPath}`);
      return already;
    }
  }

  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    const existing = detectProject(targetDir);
    if (existing) {
      if (existing.loader !== targetLoader || existing.mcVersion !== targetMc) {
        throw new Error(
          `目录已有项目但与目标不匹配：磁盘为 ${existing.loader} ${existing.mcVersion}，`
          + `目标为 ${targetLoader} ${targetMc}（${targetDir}）`,
        );
      }
      log(`目录已有项目，登记变体：${targetDir}`);
      store.prepareVariantRegistration(targetDir);
      store.refresh({ force: true });
      const linked = store.findVariantByPath(targetDir);
      if (linked) return linked.variant;
      const owner = store.resolveMod(mod.id, targetDir) ?? store.findModByModId(mod.modId, inferModDir(targetDir, mod.modId));
      if (!owner) throw new Error(`模组不存在：${mod.modId}（${mod.id}）`);
      return store.addVariant(owner.id, {
        loader: targetLoader,
        mcVersion: targetMc,
        projectPath: targetDir,
        modVersion: sourceVariant.modVersion,
        group: sourceVariant.group,
        mappings: pickMappings(targetLoader, input.mappings ?? sourceVariant.mappings),
        buildStatus: "unknown",
        source: "dmcl",
      });
    }
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
  let scaffolded = false;
  try {
    await scaffoldProject(opts, log);
    scaffolded = true;
    if (sourceVariant.loader === targetLoader) {
      log("复制源码…");
      await copySourceFromVariant(sourceVariant.projectPath, targetDir, log);
    } else {
      log("跨加载器：保留目标模板代码，仅复制共享资源…");
      stripForeignLoaderMetadata(targetDir, targetLoader);
      await copySharedModAssets(sourceVariant.projectPath, targetDir, mod.modId, log);
      if (targetLoader === "forge") {
        await repairCrossLoaderProject(
          targetDir,
          mod.modId,
          mod.displayName,
          sourceVariant.group,
          targetLoader,
          targetMc,
          log,
        );
      }
    }
    await applyProjectIdentity({
    targetDir,
    modId: mod.modId,
    displayName: mod.displayName,
    group: sourceVariant.group,
    loader: targetLoader,
    });
    log("已同步模组元数据（mod_id / 显示名）");
    log("配置 JDK…");
    await ensureJdk(targetMc, targetDir, log);

    store.refresh({ force: true });
    const byPath = store.findVariantByPath(targetDir);
    if (byPath) return byPath.variant;

    const owner = store.resolveMod(mod.id, targetDir) ?? store.findModByModId(mod.modId, inferModDir(targetDir, mod.modId));
    if (!owner) throw new Error(`模组不存在：${mod.modId}（${mod.id}）`);

    const variant = store.addVariant(owner.id, {
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
  } catch (err) {
    if (scaffolded && fs.existsSync(targetDir) && !detectProject(targetDir)) {
      await fs.promises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      log(`已清理未完成的生成目录：${targetDir}`);
    }
    throw err;
  }
}
