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
  listLogs,
  readLog,
} from "./build-queue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkspaceModule = any;

interface WsVariant {
  id: string;
  loader: string;
  mcVersion: string;
  projectPath: string;
}

let wsMod: WorkspaceModule | null = null;

async function ws(): Promise<WorkspaceModule> {
  if (!wsMod) {
    const projectRoot = path.resolve(__dirname, "..");
    wsMod = await import(path.join(projectRoot, "dist", "workspace", "index.js"));
  }
  return wsMod;
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
    mod.reconcileWorkspace(store);
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
    mod.reconcileWorkspace(store);
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

  // GET /api/paths/default-variant?modId=&loader=&mc=
  if (urlPath.startsWith("/api/paths/default-variant") && method === "GET") {
    const q = new URL(urlPath, "http://localhost").searchParams;
    const modId = q.get("modId") ?? "mymod";
    const loader = (q.get("loader") ?? "fabric") as "fabric" | "forge" | "neoforge";
    const mc = q.get("mc") ?? "1.21.4";
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
    mod.reconcileWorkspace(store);
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
    const ok = store.removeMod(modMatch[1]);
    json(res, { ok });
    return true;
  }

  // GET /api/mods/:id/matrix
  const matrixMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/matrix$/);
  if (matrixMatch && method === "GET") {
    const m = store.getMod(matrixMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }
    const matrix = await mod.buildMatrix(m);
    json(res, matrix);
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
    const ok = store.removeVariant(variantDelMatch[1], variantDelMatch[2]);
    json(res, { ok });
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

    let m = store.findModByModId(body.modId);
    if (!m) {
      try {
        m = store.createMod({ modId: body.modId, displayName: body.displayName });
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
      mappings: (body.mappings ?? "mojmap") as "yarn" | "mojmap" | "parchment",
      buildStatus: (body.buildStatus ?? "success") as "unknown" | "success" | "failed" | "building",
      source: "dmcl",
    });

    json(res, { mod: store.getMod(m.id), variant });
    return true;
  }

  // GET /api/settings
  if (urlPath === "/api/settings" && method === "GET") {
    json(res, {
      scanDirs: store.getScanDirs(),
      excludedPaths: store.getExcludedPaths(),
      dmclDir: mod.getDmclDir(),
      projectsRoot: mod.getProjectsRoot(),
      repoRoot: mod.getRepoRoot(),
    });
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
    if (found.variant.pathMissing) {
      json(res, { error: "项目目录不存在，请先重新定位" }, 400);
      return true;
    }
    store.updateVariantBuildStatus(buildMatch[1], "building");
    const jobId = enqueueBuild({
      variantId: buildMatch[1],
      projectPath: found.variant.projectPath,
      type: body.runClient ? "build+run" : "build",
    });
    json(res, { jobId, queue: getQueueStatus() });
    return true;
  }

  // POST /api/variants/:id/run
  const runMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/run$/);
  if (runMatch && method === "POST") {
    const found = store.getVariant(runMatch[1]);
    if (!found) { json(res, { error: "变体不存在" }, 404); return true; }
    const jobId = enqueueBuild({
      variantId: runMatch[1],
      projectPath: found.variant.projectPath,
      type: "run",
    });
    json(res, { jobId, queue: getQueueStatus() });
    return true;
  }

  // GET /api/variants/:id/logs
  const logsMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/logs$/);
  if (logsMatch && method === "GET") {
    json(res, { logs: listLogs(logsMatch[1]) });
    return true;
  }

  // GET /api/logs?path=...
  if (urlPath.startsWith("/api/logs?") && method === "GET") {
    const q = new URL(urlPath, "http://localhost").searchParams;
    const logPath = q.get("path");
    if (!logPath) { json(res, { error: "缺少 path" }, 400); return true; }
    const content = readLog(logPath);
    if (!content && !fs.existsSync(path.resolve(logPath))) {
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
    const body = (await readBody(req)) as { loader?: string; runClient?: boolean };
    const m = store.getMod(buildAllMatch[1]);
    if (!m) { json(res, { error: "模组不存在" }, 404); return true; }

    const variants = m.variants.filter((v: WsVariant) => !body.loader || v.loader === body.loader);
    for (const v of variants) store.updateVariantBuildStatus(v.id, "building");

    const ids = enqueueBatch(variants.map((v: WsVariant) => ({
      variantId: v.id,
      projectPath: v.projectPath,
      type: body.runClient ? "build+run" as const : "build" as const,
    })));

    json(res, { jobIds: ids, count: ids.length, queue: getQueueStatus() });
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

  // GET /api/versions/:loader
  const verMatch = urlPath.match(/^\/api\/versions\/([^/]+)$/);
  if (verMatch && method === "GET") {
    const { supportedVersions } = await import(path.join(path.resolve(__dirname, ".."), "dist", "meta", "versions.js"));
    const loader = verMatch[1] as "fabric" | "forge" | "neoforge";
    const versions = await supportedVersions(loader);
    json(res, { loader, versions });
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

export async function initWorkspace(repoRoot: string): Promise<void> {
  const mod = await ws();
  mod.setRepoRoot(repoRoot);
  mod.ensureProjectsRoot();
  const store = mod.getWorkspace();
  const projectsRoot = mod.getProjectsRoot();
  if (!store.getScanDirs().includes(projectsRoot)) {
    store.addScanDir(projectsRoot);
  }
  mod.reconcileWorkspace(store);
}

export { ws };
