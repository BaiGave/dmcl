import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, dialog, shell } from "electron";
import {
  cancelBuildQueue,
  enqueueBatch,
  enqueueBuild,
  getQueueStatus,
  isVariantQueued,
  listLogs,
  readLog,
} from "./build-queue";
import { loadDist, repoDist } from "./dist-loader";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkspaceModule = any;

interface MinecraftSourcesModule {
  getMinecraftSourceStatus(): unknown;
  startMinecraftSourceTask(request: {
    scope: "single" | "all";
    loader: "fabric" | "forge" | "neoforge";
    mcVersion?: string;
    mapping?: "yarn" | "mojmap" | "parchment" | "mcp";
    force?: boolean;
    mirror?: boolean;
    projectPath?: string;
    projectModId?: string;
    includeDependencies?: boolean;
  }): unknown;
  cancelMinecraftSourceTask(): unknown;
  getProjectSourceStatus(projectPath: string): unknown;
}

interface WsVariant {
  id: string;
  loader: string;
  mcVersion: string;
  projectPath: string;
  buildStatus?: string;
}

interface VersionVerificationApiRecord {
  lastResultAt?: string;
}

function parseLoaderParam(value: string | null | undefined): "fabric" | "forge" | "neoforge" | undefined {
  if (value === "fabric" || value === "forge" || value === "neoforge") return value;
  return undefined;
}

function parseLimitParam(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function compareMcVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function sortVariantsForBuild(variants: WsVariant[]): WsVariant[] {
  return [...variants].sort((a, b) => {
    const mc = compareMcVersion(b.mcVersion, a.mcVersion);
    if (mc !== 0) return mc;
    return a.loader.localeCompare(b.loader);
  });
}

function pickBuildableVariants(
  variants: WsVariant[],
  opts: { loader?: string; failedOnly?: boolean },
): { buildable: WsVariant[]; skipped: { queued: number; missing: number; filtered: number } } {
  const skipped = { queued: 0, missing: 0, filtered: 0 };
  const buildable: WsVariant[] = [];

  for (const v of variants) {
    if (opts.loader && v.loader !== opts.loader) {
      skipped.filtered++;
      continue;
    }
    if (opts.failedOnly && v.buildStatus !== "failed") {
      skipped.filtered++;
      continue;
    }
    if (!fs.existsSync(v.projectPath)) {
      skipped.missing++;
      continue;
    }
    if (isVariantQueued(v.id)) {
      skipped.queued++;
      continue;
    }
    buildable.push(v);
  }

  return { buildable: sortVariantsForBuild(buildable), skipped };
}

let wsMod: WorkspaceModule | null = null;
let minecraftSourcesMod: MinecraftSourcesModule | null = null;

async function ws(): Promise<WorkspaceModule> {
  if (!wsMod) {
    const projectRoot = path.resolve(__dirname, "..");
    wsMod = await loadDist(repoDist("workspace", "index.js"));
  }
  return wsMod;
}

async function minecraftSources(): Promise<MinecraftSourcesModule> {
  if (!minecraftSourcesMod) {
    minecraftSourcesMod = await loadDist<MinecraftSourcesModule>(repoDist("sources", "index.js"));
  }
  return minecraftSourcesMod;
}

export async function cancelSourceJobs(): Promise<void> {
  try {
    (await minecraftSources()).cancelMinecraftSourceTask();
  } catch {
    // App shutdown must continue even when the source module was never loaded.
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

export async function handleWorkspaceApi(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  method: string,
): Promise<boolean> {
  const mod = await ws();
  const store = mod.getWorkspace();

  // GET /api/mods
  if (urlPath === "/api/mods" && method === "GET") {
    store.refresh();
    json(res, { mods: store.getMods() });
    return true;
  }

  // POST /api/mods/reconcile
  if (urlPath === "/api/mods/reconcile" && method === "POST") {
    const result = mod.reconcileWorkspace(store);
    json(res, { ...result, mods: store.getMods() });
    return true;
  }

  // POST /api/mods/purge-missing
  if (urlPath === "/api/mods/purge-missing" && method === "POST") {
    const removed = store.purgeMissingVariants();
    json(res, { removed, mods: store.getMods() });
    return true;
  }

  // GET /api/registry/projects
  if (urlPath === "/api/registry/projects" && method === "GET") {
    store.refresh();
    json(res, { projects: mod.listRegisteredProjects(store) });
    return true;
  }

  // GET /api/paths/info
  if (urlPath === "/api/paths/info" && method === "GET") {
    json(res, {
      repoRoot: mod.getRepoRoot(),
      projectsRoot: mod.getProjectsRoot(),
    });
    return true;
  }

  // GET /api/concurrency
  if (urlPath === "/api/concurrency" && method === "GET") {
    const { getConcurrencySettingsPayload } = await import("./concurrency-settings");
    const { getGovernorStatus } = await import("./concurrency-governor");
    json(res, { ...getConcurrencySettingsPayload(), ...getGovernorStatus() });
    return true;
  }

  // GET /api/paths/default-variant?modId=&loader=&mc=
  if (urlPath.startsWith("/api/paths/default-variant") && method === "GET") {
    const q = new URL(urlPath, "http://localhost").searchParams;
    const modId = (q.get("modId") ?? "").trim();
    const loader = (q.get("loader") ?? "fabric") as "fabric" | "forge" | "neoforge";
    const mc = q.get("mc") ?? "1.21.4";
    if (!mod.isValidModId(modId)) {
      json(res, {
        path: null,
        invalidModId: true,
        projectsRoot: mod.getProjectsRoot(),
        preview: `projects/{modId}/${loader}-${mc}/`,
      });
      return true;
    }
    const variantPath = mod.defaultVariantPath(modId, loader, mc);
    json(res, {
      path: variantPath,
      projectsRoot: mod.getProjectsRoot(),
      modDir: mod.getModDir(modId),
    });
    return true;
  }

  // PATCH /api/variants/:id/path
  const pathPatchMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/path$/);
  if (pathPatchMatch && method === "PATCH") {
    const body = (await readBody(req)) as { path: string };
    if (!body.path) { json(res, { error: "缺少 path" }, 400); return true; }
    const result = mod.relocateVariant(store, pathPatchMatch[1], body.path);
    if (!result.ok) { json(res, { error: result.error }, 400); return true; }
    json(res, { ok: true, variant: store.getVariant(pathPatchMatch[1])?.variant });
    return true;
  }

  // GET /api/mods/:id
  const modMatch = urlPath.match(/^\/api\/mods\/([^/]+)$/);
  if (modMatch && method === "GET") {
    store.refresh();
    const m = store.getMod(modMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }
    json(res, { mod: m });
    return true;
  }

  // PATCH /api/mods/:id
  if (modMatch && method === "PATCH") {
    const body = (await readBody(req)) as Record<string, string>;
    const updated = store.updateMod(modMatch[1], body);
    if (!updated) { json(res, { error: "模组不存在" }, 404); return true; }
    json(res, { mod: updated });
    return true;
  }

  // DELETE /api/mods/:id
  if (modMatch && method === "DELETE") {
    const body = (await readBody(req)) as { deleteFiles?: boolean };
    const deleteFiles = body?.deleteFiles === true;
    const m = store.getMod(modMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }

    let fileResult: { deleted: string[]; skipped: string[] } | undefined;
    if (deleteFiles) {
      const deletedOnDisk = await mod.deleteModProjects(
        m.modId,
        m.variants.map((v: WsVariant) => v.projectPath),
      );
      fileResult = deletedOnDisk;
      if (deletedOnDisk.skipped.length > 0) {
        json(res, {
          error: `有 ${deletedOnDisk.skipped.length} 个项目目录未能删除，请关闭占用程序后重试`,
          fileResult: deletedOnDisk,
        }, 500);
        return true;
      }
    }

    const ok = store.removeMod(modMatch[1]);
    mod.invalidateMatrixCache(m.modId);
    json(res, { ok, deleteFiles, fileResult, mods: store.getMods() });
    return true;
  }

  // GET /api/mods/:id/detail — 单次磁盘扫描 + 矩阵（详情页专用）
  const detailMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/detail$/);
  if (detailMatch && method === "GET") {
    store.refresh();
    const m = store.getMod(detailMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }
    const matrix = await mod.buildMatrix(m);
    const sources = await minecraftSources();
    const detailMod = {
      ...m,
      variants: m.variants.map((variant: WsVariant) => ({
        ...variant,
        sourceStatus: sources.getProjectSourceStatus(variant.projectPath),
      })),
    };
    json(res, {
      mod: detailMod,
      matrix: mod.serializeMatrixResult(matrix),
    });
    return true;
  }

  // GET /api/mods/:id/matrix
  const matrixMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/matrix$/);
  if (matrixMatch && method === "GET") {
    let m = store.getMod(matrixMatch[1]);
    if (!m) {
      store.refresh();
      m = store.getMod(matrixMatch[1]);
    }
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }
    const matrix = await mod.buildMatrix(m);
    json(res, mod.serializeMatrixResult(matrix));
    return true;
  }

  // POST /api/mods/:id/variants
  const variantPostMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/variants$/);
  if (variantPostMatch && method === "POST") {
    const body = (await readBody(req)) as {
      sourceVariantId: string;
      targetLoader: string;
      targetMc: string;
      parentDir?: string;
      mirror?: boolean;
      autoBuild?: boolean;
    };

    const m = store.getMod(variantPostMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }

    const source = m.variants.find((v: WsVariant) => v.id === body.sourceVariantId);
    if (!source) { json(res, { error: "源变体不存在" }, 404); return true; }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    });

    const lines: string[] = [];
    const log = (msg: string) => {
      lines.push(msg);
      res.write(msg + "\n");
    };

    try {
      const variant = await mod.generateVariant({
        mod: m,
        sourceVariant: source,
        targetLoader: body.targetLoader as "fabric" | "forge" | "neoforge",
        targetMc: body.targetMc,
        mirror: body.mirror !== false,
      }, log);

      if (body.autoBuild) {
        store.updateVariantBuildStatus(variant.id, "building");
        enqueueBuild({
          variantId: variant.id,
          projectPath: variant.projectPath,
          type: "build+run",
          loader: variant.loader,
          mcVersion: variant.mcVersion,
        });
        log("已加入构建队列");
      }

      res.write(`__VARIANT__:${JSON.stringify(variant)}\n`);
      res.write("__EXIT__:0\n");
    } catch (err) {
      res.write(`错误：${(err as Error).message}\n`);
      res.write("__EXIT__:1\n");
    }
    res.end();
    return true;
  }

  // DELETE /api/mods/:modId/variants/:variantId
  const variantDelMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/variants\/([^/]+)$/);
  if (variantDelMatch && method === "DELETE") {
    const body = (await readBody(req)) as { deleteFiles?: boolean };
    const deleteFiles = body?.deleteFiles === true;
    const m = store.getMod(variantDelMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }
    const variant = m.variants.find((v: WsVariant) => v.id === variantDelMatch[2]);
    if (!variant) { json(res, { error: "变体不存在" }, 404); return true; }

    if (deleteFiles) {
      try {
        await mod.deleteVariantProject(
          variant.projectPath,
          m.modId,
          m.variants.map((v: WsVariant) => v.projectPath),
        );
      } catch (err) {
        json(res, { error: (err as Error).message }, 400);
        return true;
      }
    }

    const ok = store.removeVariant(variantDelMatch[1], variantDelMatch[2]);
    if (!ok) {
      json(res, { error: "变体登记移除失败" }, 500);
      return true;
    }
    const updated = store.getMod(variantDelMatch[1]);
    json(res, {
      ok: true,
      deleteFiles,
      path: variant.projectPath,
      mod: updated ?? null,
      mods: store.getMods(),
    });
    return true;
  }

  // POST /api/mods/import
  if (urlPath === "/api/mods/import" && method === "POST") {
    const body = (await readBody(req)) as { path: string };
    if (!body.path) { json(res, { error: "缺少 path" }, 400); return true; }
    const result = mod.importFromPath(body.path);
    if (!result) { json(res, { error: "无法识别为 mod 项目" }, 400); return true; }
    json(res, { ...result, mod: store.getMod(result.modId) });
    return true;
  }

  // POST /api/mods/scan
  if (urlPath === "/api/mods/scan" && method === "POST") {
    const body = (await readBody(req)) as { path?: string };
    if (body.path) {
      store.addScanDir(body.path);
      const result = mod.scanAndImport(body.path);
      json(res, result);
    } else {
      const result = mod.autoScan();
      json(res, result);
    }
    return true;
  }

  // POST /api/mods/register
  if (urlPath === "/api/mods/register" && method === "POST") {
    const body = (await readBody(req)) as {
      modId: string;
      displayName: string;
      loader: string;
      mcVersion: string;
      projectPath: string;
      group?: string;
      mappings?: string;
      modVersion?: string;
      buildStatus?: string;
    };

    if (!body.loader || !["fabric", "forge", "neoforge"].includes(body.loader)) {
      json(res, { error: "无效的 loader" }, 400);
      return true;
    }

    let m = store.findModByModId(body.modId);
    if (!m) {
      try {
        const modDir = mod.inferModDir(path.resolve(body.projectPath), body.modId);
        m = store.createMod({
          modId: body.modId,
          displayName: body.displayName,
          modDir,
        });
      } catch (err) {
        json(res, { error: (err as Error).message }, 400);
        return true;
      }
    }

    const existing = store.findVariantByPath(body.projectPath);
    if (existing) {
      json(res, { mod: existing.mod, variant: existing.variant, existed: true });
      return true;
    }

    const variant = store.addVariant(m.id, {
      loader: body.loader as "fabric" | "forge" | "neoforge",
      mcVersion: body.mcVersion,
      projectPath: path.resolve(body.projectPath),
      modVersion: body.modVersion ?? "0.1.0",
      group: body.group ?? `com.example.${body.modId}`,
      mappings: (body.mappings ?? "mojmap") as "yarn" | "mojmap" | "parchment" | "mcp",
      buildStatus: (body.buildStatus ?? "success") as "unknown" | "success" | "failed" | "building",
      source: "dmcl",
    });

    json(res, { mod: store.getMod(m.id), variant });
    return true;
  }

  // GET /api/settings
  if (urlPath === "/api/settings" && method === "GET") {
    const { getConcurrencySettingsPayload } = await import("./concurrency-settings");
    json(res, {
      scanDirs: store.getScanDirs(),
      excludedPaths: store.getExcludedPaths(),
      dmclDir: mod.getDmclDir(),
      projectsRoot: mod.getProjectsRoot(),
      repoRoot: mod.getRepoRoot(),
      concurrency: getConcurrencySettingsPayload(),
    });
    return true;
  }

  // GET /api/sources/status — 源码仓库、已完成版本与当前后台任务
  if (urlPath === "/api/sources/status" && method === "GET") {
    const sources = await minecraftSources();
    json(res, sources.getMinecraftSourceStatus());
    return true;
  }

  // POST /api/sources/start — 单版本或当前加载器的全部版本
  if (urlPath === "/api/sources/start" && method === "POST") {
    const body = (await readBody(req)) as {
      scope?: "single" | "all";
      loader?: "fabric" | "forge" | "neoforge";
      mcVersion?: string;
      mapping?: "yarn" | "mojmap" | "parchment" | "mcp";
      force?: boolean;
      mirror?: boolean;
    };
    if (!body.scope || !["single", "all"].includes(body.scope)) {
      json(res, { error: "请选择源码获取范围" }, 400);
      return true;
    }
    if (!body.loader || !["fabric", "forge", "neoforge"].includes(body.loader)) {
      json(res, { error: "请选择加载器" }, 400);
      return true;
    }
    if (body.scope === "single" && !body.mcVersion) {
      json(res, { error: "请选择 Minecraft 版本" }, 400);
      return true;
    }
    try {
      const sources = await minecraftSources();
      const task = sources.startMinecraftSourceTask({
        scope: body.scope,
        loader: body.loader,
        mcVersion: body.mcVersion,
        mapping: body.mapping,
        force: body.force === true,
        mirror: body.mirror !== false,
      });
      json(res, { ok: true, task }, 202);
    } catch (err) {
      json(res, { error: (err as Error).message }, 409);
    }
    return true;
  }

  // POST /api/sources/cancel
  if (urlPath === "/api/sources/cancel" && method === "POST") {
    const sources = await minecraftSources();
    json(res, { ok: true, task: sources.cancelMinecraftSourceTask() });
    return true;
  }

  // POST /api/settings/concurrency
  if (urlPath === "/api/settings/concurrency" && method === "POST") {
    const body = (await readBody(req)) as {
      reset?: boolean;
      jobSlots?: number;
      gradleBuildConcurrency?: number;
      clientConcurrency?: number;
    };
    const { resetRunnerPool } = await import("./gradle-runner");
    const {
      applyConcurrencyUserSettings,
      resetConcurrencyToDefaults,
    } = await import("./concurrency-governor");
    const { getConcurrencySettingsPayload } = await import("./concurrency-settings");

    if (body.reset) {
      resetConcurrencyToDefaults();
    } else {
      applyConcurrencyUserSettings({
        jobSlots: body.jobSlots,
        gradleBuildConcurrency: body.gradleBuildConcurrency,
        clientConcurrency: body.clientConcurrency,
      });
    }
    resetRunnerPool();
    json(res, { ok: true, concurrency: getConcurrencySettingsPayload() });
    return true;
  }

  // POST /api/settings/scan-dirs
  if (urlPath === "/api/settings/scan-dirs" && method === "POST") {
    const body = (await readBody(req)) as { dirs?: string[]; add?: string; remove?: string };
    if (body.add) {
      store.addScanDir(body.add);
    } else if (body.remove) {
      store.removeScanDir(body.remove);
    } else if (body.dirs) {
      store.setScanDirs(body.dirs);
    }
    json(res, { ok: true, scanDirs: store.getScanDirs() });
    return true;
  }

  // DELETE /api/settings/scan-dirs — body: { path }
  if (urlPath === "/api/settings/scan-dirs" && method === "DELETE") {
    const body = (await readBody(req)) as { path: string };
    if (!body.path) { json(res, { error: "缺少 path" }, 400); return true; }
    const ok = store.removeScanDir(body.path);
    json(res, { ok, scanDirs: store.getScanDirs() });
    return true;
  }

  // POST /api/variants/:id/build
  const buildMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/build$/);
  if (buildMatch && method === "POST") {
    const body = (await readBody(req)) as { runClient?: boolean };
    const found = store.getVariant(buildMatch[1]);
    if (!found) { json(res, { error: "变体不存在" }, 404); return true; }
    store.updateVariantBuildStatus(buildMatch[1], "building");
    const jobId = enqueueBuild({
      variantId: buildMatch[1],
      projectPath: found.variant.projectPath,
      type: body.runClient ? "build+run" : "build",
      loader: found.variant.loader,
      mcVersion: found.variant.mcVersion,
    });
    json(res, { jobId, queue: getQueueStatus() });
    return true;
  }

  // POST /api/variants/:id/sources — 按当前变体自动准备 MC 与前置模组源码
  const sourceMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/sources$/);
  if (sourceMatch && method === "POST") {
    const found = store.getVariant(sourceMatch[1]);
    if (!found) { json(res, { error: "变体不存在" }, 404); return true; }
    if (!fs.existsSync(found.variant.projectPath)) {
      json(res, { error: "项目目录不存在，请先重新定位项目" }, 400);
      return true;
    }
    const body = (await readBody(req)) as { force?: boolean };
    try {
      const sources = await minecraftSources();
      const task = sources.startMinecraftSourceTask({
        scope: "single",
        loader: found.variant.loader,
        mcVersion: found.variant.mcVersion,
        mapping: found.variant.mappings,
        projectPath: found.variant.projectPath,
        projectModId: found.mod.modId,
        includeDependencies: true,
        force: body.force === true,
        mirror: true,
      });
      json(res, { ok: true, task }, 202);
    } catch (err) {
      json(res, { error: (err as Error).message }, 409);
    }
    return true;
  }

  // POST /api/variants/:id/run
  const runMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/run$/);
  if (runMatch && method === "POST") {
    const found = store.getVariant(runMatch[1]);
    if (!found) { json(res, { error: "变体不存在" }, 404); return true; }
    store.updateVariantBuildStatus(runMatch[1], "building");
    const jobId = enqueueBuild({
      variantId: runMatch[1],
      projectPath: found.variant.projectPath,
      type: "run",
      loader: found.variant.loader,
      mcVersion: found.variant.mcVersion,
    });
    json(res, { jobId, queue: getQueueStatus() });
    return true;
  }

  // GET /api/variants/:id/logs
  const logsMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/logs$/);
  if (logsMatch && method === "GET") {
    const logs = await listLogs(logsMatch[1]);
    json(res, { logs });
    return true;
  }

  // GET /api/logs?path=...&variantId=...
  if (urlPath.startsWith("/api/logs?") && method === "GET") {
    const q = new URL(urlPath, "http://localhost").searchParams;
    const logPath = q.get("path");
    const variantId = q.get("variantId");
    if (!logPath || !variantId) { json(res, { error: "缺少 path 或 variantId" }, 400); return true; }
    const content = await readLog(logPath, variantId);
    if (!content) {
      json(res, { error: "日志不存在或路径非法" }, 403);
      return true;
    }
    json(res, { content });
    return true;
  }

  // GET /api/queue
  if (urlPath === "/api/queue" && method === "GET") {
    json(res, getQueueStatus());
    return true;
  }

  // POST /api/queue/cancel
  if (urlPath === "/api/queue/cancel" && method === "POST") {
    cancelBuildQueue();
    json(res, { ok: true });
    return true;
  }

  // POST /api/mods/:id/build-all
  const buildAllMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/build-all$/);
  if (buildAllMatch && method === "POST") {
    const body = (await readBody(req)) as {
      loader?: string;
      runClient?: boolean;
      failedOnly?: boolean;
      includeMissingLoaders?: boolean;
    };
    store.refresh({ force: true });
    const m = store.getMod(buildAllMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }

    const { buildable, skipped } = pickBuildableVariants(m.variants as WsVariant[], {
      loader: body.loader,
      failedOnly: body.failedOnly,
    });

    if (buildable.length === 0) {
      const parts: string[] = [];
      if (skipped.missing) parts.push(`${skipped.missing} 个路径不存在`);
      if (skipped.queued) parts.push(`${skipped.queued} 个已在队列`);
      if (skipped.filtered) parts.push(`${skipped.filtered} 个不符合筛选`);
      json(res, {
        error: parts.length ? `没有可构建的变体（${parts.join("，")}）` : "没有可构建的变体",
        skipped,
      }, 400);
      return true;
    }

    for (const v of buildable) store.updateVariantBuildStatus(v.id, "building");

    const jobType = body.runClient ? "build+run" as const : "build" as const;
    const ids = enqueueBatch(buildable.map((v) => ({
      variantId: v.id,
      projectPath: v.projectPath,
      type: jobType,
      loader: v.loader,
      mcVersion: v.mcVersion,
    })));

    json(res, {
      jobIds: ids,
      count: ids.length,
      skipped,
      variants: buildable.map((v) => ({
        id: v.id,
        loader: v.loader,
        mcVersion: v.mcVersion,
      })),
      queue: getQueueStatus(),
    });
    return true;
  }

  // GET /api/export/catalog
  if (urlPath === "/api/export/catalog" && method === "GET") {
    json(res, mod.exportCatalog());
    return true;
  }

  // POST /api/export/catalog
  if (urlPath === "/api/export/catalog" && method === "POST") {
    const body = (await readBody(req)) as { path?: string };
    const dest = body.path ?? path.join(mod.getDmclDir(), "catalog.json");
    const resolved = path.resolve(dest);
    const dmclDir = path.resolve(mod.getDmclDir());
    if (!resolved.startsWith(dmclDir + path.sep) && resolved !== dmclDir) {
      json(res, { error: "仅允许写入 ~/.dmcl/ 目录" }, 403);
      return true;
    }
    const written = mod.writeCatalogExport(dest);
    json(res, { path: written, catalog: mod.exportCatalog() });
    return true;
  }

  // GET /api/versions/:loader — 从 ~/.dmcl/meta-cache.json 读取
  const verMatch = urlPath.match(/^\/api\/versions\/([^/]+)$/);
  if (verMatch && method === "GET") {
    const { getMetaCache } = await loadDist(repoDist("meta", "meta-cache.js"));
    const loader = verMatch[1] as "fabric" | "forge" | "neoforge";
    if (!["fabric", "forge", "neoforge"].includes(loader)) {
      json(res, { error: "未知加载器" }, 400);
      return true;
    }
    const { data, fromCache, stale } = await getMetaCache().get();
    json(res, { loader, versions: data.loaderVersions[loader] ?? [], fromCache, stale, updatedAt: data.updatedAt });
    return true;
  }

  // GET /api/meta/status
  if (urlPath === "/api/meta/status" && method === "GET") {
    const { getMetaCache, META_CACHE_FILE } = await loadDist(repoDist("meta", "meta-cache.js"));
    json(res, { ...getMetaCache().getStatus(), cacheFile: META_CACHE_FILE });
    return true;
  }

  // GET /api/verification/status
  if (urlPath === "/api/verification/status" && method === "GET") {
    const projectRoot = path.resolve(__dirname, "..");
    const {
      readVersionVerificationIndex,
      summarizeVersionVerification,
      verificationFilePath,
    } = await loadDist(repoDist("workspace", "version-verification.js"));
    const index = readVersionVerificationIndex();
    const records = Object.values(index.records) as VersionVerificationApiRecord[];
    const counts = { verified: 0, "build-only": 0, failed: 0, unknown: 0 };
    for (const record of records) {
      const summary = summarizeVersionVerification(record);
      counts[summary.state as keyof typeof counts]++;
    }
    records.sort((a, b) => (b.lastResultAt || "").localeCompare(a.lastResultAt || ""));
    json(res, {
      cacheFile: verificationFilePath(),
      total: records.length,
      counts,
      recent: records.slice(0, 20),
    });
    return true;
  }

  // GET /api/verification/plan?loader=&mc=&limit=&force=1
  if (urlPath.startsWith("/api/verification/plan") && method === "GET") {
    const projectRoot = path.resolve(__dirname, "..");
    const q = new URL(urlPath, "http://localhost").searchParams;
    const loader = parseLoaderParam(q.get("loader"));
    const mcVersion = q.get("mc") ?? undefined;
    const limit = parseLimitParam(q.get("limit"));
    const force = q.get("force") === "1" || q.get("force") === "true";
    if (q.get("loader") && !loader) {
      json(res, { error: "未知加载器" }, 400);
      return true;
    }
    const { loadVersionVerificationPlan } = await loadDist(repoDist("workspace", "version-verifier.js"));
    const plan = await loadVersionVerificationPlan({ loader, mcVersion, force });
    const shown = plan.slice(0, limit ?? 50);
    json(res, { planned: plan.length, shown: shown.length, targets: shown });
    return true;
  }

  // POST /api/verification/run or /api/verification/run-all
  if (
    (urlPath === "/api/verification/run" || urlPath === "/api/verification/run-all") &&
    method === "POST"
  ) {
    const projectRoot = path.resolve(__dirname, "..");
    const body = (await readBody(req)) as {
      loader?: string;
      mcVersion?: string;
      limit?: number;
      force?: boolean;
      rootDir?: string;
      mirror?: boolean;
      keepProjects?: boolean;
    };
    const loader = parseLoaderParam(body.loader);
    if (body.loader && !loader) {
      json(res, { error: "未知加载器" }, 400);
      return true;
    }
    const { runAllVersionVerifications, runVersionVerificationBatch } = await loadDist(
      repoDist("workspace", "version-verifier.js"),
    );
    try {
      const options = {
        loader,
        mcVersion: body.mcVersion,
        limit: body.limit,
        force: body.force === true,
        rootDir: body.rootDir,
        mirror: body.mirror !== false,
        keepProjects: body.keepProjects === true,
      };
      const result = urlPath === "/api/verification/run-all"
        ? await runAllVersionVerifications(options)
        : await runVersionVerificationBatch(options);
      json(res, result);
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
    return true;
  }

  // POST /api/meta/refresh — 手动刷新元数据缓存（同步等待完成）
  if (urlPath === "/api/meta/refresh" && method === "POST") {
    const { getMetaCache } = await loadDist(repoDist("meta", "meta-cache.js"));
    const { invalidateMatrixCache } = await loadDist(repoDist("workspace", "matrix.js"));
    try {
      const data = await getMetaCache().refresh();
      invalidateMatrixCache();
      json(res, {
        ok: true,
        updatedAt: data.updatedAt,
        loaderVersions: data.loaderVersions,
      });
    } catch (err) {
      json(res, { error: `刷新失败：${(err as Error).message}` }, 500);
    }
    return true;
  }

  // GET /api/mappings/status
  if (urlPath === "/api/mappings/status" && method === "GET") {
    const projectRoot = path.resolve(__dirname, "..");
    const { getMappingsCache, MAPPINGS_CACHE_FILE } = await loadDist(repoDist("meta", "mappings-cache.js"));
    json(res, { ...getMappingsCache().getStatus(), cacheFile: MAPPINGS_CACHE_FILE });
    return true;
  }

  // POST /api/mappings/refresh — 强制刷新单个 loader+mc 的映射缓存
  if (urlPath === "/api/mappings/refresh" && method === "POST") {
    const projectRoot = path.resolve(__dirname, "..");
    const body = (await readBody(req)) as { loader?: string; mcVersion?: string };
    const loader = body.loader as "fabric" | "forge" | "neoforge" | undefined;
    const mcVersion = body.mcVersion;
    if (!loader || !mcVersion || !["fabric", "forge", "neoforge"].includes(loader)) {
      json(res, { error: "缺少 loader 或 mcVersion" }, 400);
      return true;
    }
    const { getMappingsCache } = await loadDist(repoDist("meta", "mappings-cache.js"));
    try {
      const entry = await getMappingsCache().refresh(loader, mcVersion);
      json(res, {
        loader,
        mcVersion,
        options: entry.options,
        default: entry.default,
        updatedAt: entry.updatedAt,
        fromCache: false,
      });
    } catch (err) {
      json(res, { error: `刷新失败：${(err as Error).message}` }, 500);
    }
    return true;
  }

  // POST /api/mappings/refresh-all — 刷新某加载器全部版本的映射缓存
  if (urlPath === "/api/mappings/refresh-all" && method === "POST") {
    const projectRoot = path.resolve(__dirname, "..");
    const body = (await readBody(req)) as { loader?: string };
    const loader = body.loader as "fabric" | "forge" | "neoforge" | undefined;
    if (!loader || !["fabric", "forge", "neoforge"].includes(loader)) {
      json(res, { error: "缺少 loader" }, 400);
      return true;
    }
    const { getMetaCache } = await loadDist(repoDist("meta", "meta-cache.js"));
    const { getMappingsCache } = await loadDist(repoDist("meta", "mappings-cache.js"));
    const { data } = await getMetaCache().get();
    const versions = data.loaderVersions[loader] ?? [];
    const result = await getMappingsCache().prefetch({ [loader]: versions } as Record<"fabric" | "forge" | "neoforge", string[]>);
    json(res, { ok: true, loader, versionCount: versions.length, ...result });
    return true;
  }

  if (urlPath === "/api/mappings/warmup" && method === "POST") {
    const projectRoot = path.resolve(__dirname, "..");
    const body = (await readBody(req)) as { loader?: string; mcVersion?: string };
    const { prefetchMappings } = await loadDist(repoDist("meta", "mappings-cache.js"));
    if (body.loader && body.mcVersion) {
      prefetchMappings(body.loader as "fabric" | "forge" | "neoforge", body.mcVersion).catch(() => {});
    }
    json(res, { ok: true });
    return true;
  }

  // GET /api/mappings/:loader/:mc — 从持久化缓存读取真实可用映射
  const mapMatch = urlPath.match(/^\/api\/mappings\/([^/]+)\/([^/]+)$/);
  if (mapMatch && method === "GET") {
    const projectRoot = path.resolve(__dirname, "..");
    const loader = mapMatch[1] as "fabric" | "forge" | "neoforge";
    const mcVersion = decodeURIComponent(mapMatch[2]);
    if (!["fabric", "forge", "neoforge"].includes(loader)) {
      json(res, { error: "未知加载器" }, 400);
      return true;
    }
    const { getMappingsCache, MAPPINGS_CACHE_FILE } = await loadDist(repoDist("meta", "mappings-cache.js"));
    const { entry, fromCache } = await getMappingsCache().getOrFetch(loader, mcVersion);
    json(res, {
      loader,
      mcVersion,
      options: entry.options,
      default: entry.default,
      updatedAt: entry.updatedAt,
      fromCache,
      cacheFile: MAPPINGS_CACHE_FILE,
    });
    return true;
  }

  // POST /api/open-cursor
  if (urlPath === "/api/open-cursor" && method === "POST") {
    const body = (await readBody(req)) as { path: string };
    if (body.path) {
      spawn("cursor", [body.path], { detached: true, stdio: "ignore" });
    }
    json(res, { ok: true });
    return true;
  }

  return false;
}

export async function initWorkspace(repoRoot: string, writableProjectsRoot?: string): Promise<void> {
  const mod = await ws();
  mod.setRepoRoot(repoRoot);
  if (writableProjectsRoot) mod.setProjectsRoot(writableProjectsRoot);
  mod.ensureProjectsRoot();
  const store = mod.getWorkspace();
  const projectsRoot = mod.getProjectsRoot();
  if (!store.getScanDirs().includes(projectsRoot)) {
    store.addScanDir(projectsRoot);
  }
  mod.reconcileWorkspace(store);
  const projectRoot = path.resolve(__dirname, "..");
  loadDist(repoDist("meta", "meta-cache.js"))
    .then(({ getMetaCache }) => {
      const cache = getMetaCache();
      cache.refreshIfStale();
      void cache.get({ strategy: "cache-first" }).catch(() => {});
    })
    .catch((err) => console.warn("[dmcl] 元数据缓存初始化跳过:", err));
}

export { ws };
