import fs from "node:fs";
import path from "node:path";
import { walkFiles } from "./fsutils.js";
import { supportsSplitSources } from "../meta/mc-version.js";
import {
  SIDE_LAYOUT_LABELS,
  type LoaderId,
  type ProjectOptions,
  type SideLayoutId,
} from "../types.js";
import type { Logger } from "../types.js";

const VALID: SideLayoutId[] = ["unified", "split", "client", "server"];

export function parseSideLayout(raw: string | undefined): SideLayoutId | null {
  if (!raw) return null;
  return VALID.includes(raw as SideLayoutId) ? (raw as SideLayoutId) : null;
}

/** 默认单源码集（客户端与服务端逻辑写在一起） */
export function defaultSideLayout(_loader: LoaderId, _mcVersion: string): SideLayoutId {
  return "unified";
}

export function resolveSideLayout(opts: ProjectOptions): SideLayoutId {
  return opts.sideLayout ?? defaultSideLayout(opts.loader, opts.mcVersion);
}

/** 按 MC 版本解析实际生效的布局（如旧版 Fabric 不支持分源时回退为一起） */
export function effectiveSideLayout(opts: ProjectOptions): SideLayoutId {
  const layout = resolveSideLayout(opts);
  if (layout === "split" && opts.loader === "fabric" && !supportsSplitSources(opts.mcVersion)) {
    return "unified";
  }
  return layout;
}

/** Fabric 是否启用 Loom splitEnvironmentSourceSets */
export function wantsSplitSources(opts: ProjectOptions): boolean {
  if (opts.loader !== "fabric" || !supportsSplitSources(opts.mcVersion)) return false;
  const layout = effectiveSideLayout(opts);
  return layout === "split" || layout === "client";
}

async function removePathIfExists(p: string): Promise<void> {
  if (fs.existsSync(p)) await fs.promises.rm(p, { recursive: true, force: true });
}

const DEMO_MIXIN_FILE = /^(ExampleMixin|ExampleClientMixin|ClientMixin)\.java$/;

/** 移除 client 分源与示例 mixin，并同步清理 mixins 配置（避免类已删但 json 仍引用） */
async function removeFabricClientArtifacts(targetDir: string, group: string, log: Logger): Promise<void> {
  await removePathIfExists(path.join(targetDir, "src", "client"));

  const groupPath = group.split(".").join(path.sep);
  await removePathIfExists(path.join(targetDir, "src", "main", "java", groupPath, "client"));

  const removedMixinNames = new Set<string>();
  for (const file of await walkFiles(targetDir)) {
    if (!file.endsWith(".java")) continue;
    const base = path.basename(file);
    if (/ModClient\.java$/.test(base) || DEMO_MIXIN_FILE.test(base)) {
      removedMixinNames.add(base.replace(/\.java$/, ""));
      await fs.promises.rm(file, { force: true });
    }
  }

  const resRoot = path.join(targetDir, "src", "main", "resources");
  const removedMixinConfigs = new Set<string>();
  if (fs.existsSync(resRoot)) {
    for (const entry of await fs.promises.readdir(resRoot)) {
      if (entry.includes("client") && entry.endsWith(".mixins.json")) {
        removedMixinConfigs.add(entry);
        await fs.promises.rm(path.join(resRoot, entry), { force: true });
      }
    }
  }

  for (const file of await walkFiles(targetDir)) {
    if (!file.endsWith(".mixins.json")) continue;
    const doc = JSON.parse(await fs.promises.readFile(file, "utf8")) as {
      mixins?: string[];
      client?: string[];
    };
    doc.mixins = (doc.mixins ?? []).filter((name) => !removedMixinNames.has(name));
    if (Array.isArray(doc.client)) {
      doc.client = doc.client.filter((name) => !removedMixinNames.has(name));
      if (doc.client.length === 0) delete doc.client;
    }
    const remaining = (doc.mixins?.length ?? 0) + (doc.client?.length ?? 0);
    if (remaining === 0) {
      removedMixinConfigs.add(path.basename(file));
      await fs.promises.rm(file, { force: true });
      continue;
    }
    await fs.promises.writeFile(file, JSON.stringify(doc, null, "\t") + "\n", "utf8");
  }

  const modJson = path.join(resRoot, "fabric.mod.json");
  if (fs.existsSync(modJson)) {
    const doc = JSON.parse(fs.readFileSync(modJson, "utf8")) as {
      entrypoints?: Record<string, string[]>;
      mixins?: unknown[];
      environment?: string;
    };
    if (doc.entrypoints?.client) delete doc.entrypoints.client;
    if (Array.isArray(doc.mixins)) {
      doc.mixins = doc.mixins.filter((m) => {
        if (typeof m !== "string") return false;
        return !removedMixinConfigs.has(m);
      });
      if (doc.mixins.length === 0) delete doc.mixins;
    }
    delete doc.environment;
    fs.writeFileSync(modJson, JSON.stringify(doc, null, "\t") + "\n", "utf8");
  }

  log("已移除 Fabric 客户端示例与分源目录，并同步清理 mixin 配置");
}

async function applyFabricSideLayout(opts: ProjectOptions, layout: SideLayoutId, log: Logger): Promise<void> {
  const modJsonPath = path.join(opts.targetDir, "src", "main", "resources", "fabric.mod.json");
  if (!fs.existsSync(modJsonPath)) return;

  if (layout === "unified" || layout === "server") {
    await removeFabricClientArtifacts(opts.targetDir, opts.group, log);
  }

  if (layout === "client") {
    const doc = JSON.parse(fs.readFileSync(modJsonPath, "utf8")) as {
      environment?: string;
      entrypoints?: Record<string, string[]>;
    };
    doc.environment = "client";
    if (doc.entrypoints?.main) delete doc.entrypoints.main;
    fs.writeFileSync(modJsonPath, JSON.stringify(doc, null, "\t") + "\n", "utf8");
    log("已配置为仅客户端模组（fabric.mod.json environment=client）");
  }

  if (layout === "server") {
    log("已配置为仅服务端模组（保留 main 入口，移除客户端入口与示例）");
  }

  if (layout === "split") {
    log("已保留 Fabric 官方分源结构（main + client）");
  }

  if (layout === "unified") {
    log("已合并为单源码集（客户端与服务端逻辑均写在 src/main）");
  }
}

async function applyForgeSideLayout(opts: ProjectOptions, layout: SideLayoutId, log: Logger): Promise<void> {
  if (layout === "split") {
    log("Forge / NeoForge 使用单一 src/main 源码集（分源选项与此等效）");
  }

  for (const file of await walkFiles(opts.targetDir)) {
    if (!file.endsWith(".java")) continue;
    let content = await fs.promises.readFile(file, "utf8");

    if (layout === "server") {
      if (/EventBusSubscriber[\s\S]*Dist\.CLIENT/.test(content) || /Dist\.CLIENT[\s\S]*EventBusSubscriber/.test(content)) {
        await fs.promises.rm(file, { force: true });
        log(`已移除客户端订阅类：${path.basename(file)}`);
        continue;
      }
      if (/Mod\.EventBusSubscriber\s*\([^)]*Dist\.CLIENT/.test(content)) {
        await fs.promises.rm(file, { force: true });
        log(`已移除客户端订阅类：${path.basename(file)}`);
        continue;
      }
    }

    if (layout === "client") {
      if (!/@Mod\s*\(/.test(content)) continue;
      if (content.includes("dist = Dist.CLIENT")) continue;
      if (!content.includes("net.neoforged.api.distmarker.Dist") && !content.includes("net.minecraftforge.api.distmarker.Dist")) {
        const distImport = opts.loader === "neoforge"
          ? "import net.neoforged.api.distmarker.Dist;\n"
          : "import net.minecraftforge.api.distmarker.Dist;\n";
        content = content.replace(/^(package[^\n]+\n)/, `$1${distImport}`);
      }
      content = content.replace(
        /@Mod\s*\(\s*([^)]+)\s*\)/,
        (_, inner: string) => {
          if (/dist\s*=/.test(inner)) return `@Mod(${inner})`;
          const trimmed = inner.trim();
          if (/^[A-Za-z_][\w.]*$/.test(trimmed)) {
            return `@Mod(value = ${trimmed}, dist = Dist.CLIENT)`;
          }
          return `@Mod(${inner}, dist = Dist.CLIENT)`;
        },
      );
      await fs.promises.writeFile(file, content, "utf8");
      log("已配置为仅客户端模组（@Mod dist = Dist.CLIENT）");
      return;
    }
  }
}

/** 按用户选择调整模板中的运行端与源码结构 */
export async function applySideLayout(opts: ProjectOptions, log: Logger): Promise<void> {
  const requested = resolveSideLayout(opts);
  const layout = effectiveSideLayout(opts);
  if (layout !== requested) {
    log(`⚠ 此 MC 版本不支持分源，运行端布局已由「${SIDE_LAYOUT_LABELS[requested]}」调整为「${SIDE_LAYOUT_LABELS[layout]}」`);
  }
  log(`运行端布局：${SIDE_LAYOUT_LABELS[layout]}`);

  if (opts.loader === "fabric") {
    await applyFabricSideLayout(opts, layout, log);
    return;
  }

  if (layout === "unified") {
    log("使用单一 src/main 源码集（客户端与服务端逻辑写在一起）");
    return;
  }

  await applyForgeSideLayout(opts, layout, log);
}
