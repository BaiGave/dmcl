"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWorkspaceApi = handleWorkspaceApi;
exports.initWorkspace = initWorkspace;
exports.ws = ws;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const build_queue_1 = require("./build-queue");
let wsMod = null;
async function ws() {
    if (!wsMod) {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        wsMod = await Promise.resolve(`${node_path_1.default.join(projectRoot, "dist", "workspace", "index.js")}`).then(s => __importStar(require(s)));
    }
    return wsMod;
}
async function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            try {
                resolve(JSON.parse(body));
            }
            catch {
                resolve({});
            }
        });
    });
}
function json(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
}
function notFound(res) {
    json(res, { error: "Not found" }, 404);
}
async function handleWorkspaceApi(req, res, urlPath, method) {
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
        const loader = (q.get("loader") ?? "fabric");
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
        const body = (await readBody(req));
        if (!body.path) {
            json(res, { error: "缺少 path" }, 400);
            return true;
        }
        const result = mod.relocateVariant(store, pathPatchMatch[1], body.path);
        if (!result.ok) {
            json(res, { error: result.error }, 400);
            return true;
        }
        json(res, { ok: true, variant: store.getVariant(pathPatchMatch[1])?.variant });
        return true;
    }
    // GET /api/mods/:id
    const modMatch = urlPath.match(/^\/api\/mods\/([^/]+)$/);
    if (modMatch && method === "GET") {
        mod.reconcileWorkspace(store);
        const m = store.getMod(modMatch[1]);
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        json(res, { mod: m });
        return true;
    }
    // PATCH /api/mods/:id
    if (modMatch && method === "PATCH") {
        const body = (await readBody(req));
        const updated = store.updateMod(modMatch[1], body);
        if (!updated) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
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
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const matrix = await mod.buildMatrix(m);
        json(res, matrix);
        return true;
    }
    // POST /api/mods/:id/variants
    const variantPostMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/variants$/);
    if (variantPostMatch && method === "POST") {
        const body = (await readBody(req));
        const m = store.getMod(variantPostMatch[1]);
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const source = m.variants.find((v) => v.id === body.sourceVariantId);
        if (!source) {
            json(res, { error: "源变体不存在" }, 404);
            return true;
        }
        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Transfer-Encoding": "chunked",
        });
        const lines = [];
        const log = (msg) => {
            lines.push(msg);
            res.write(msg + "\n");
        };
        try {
            const variant = await mod.generateVariant({
                mod: m,
                sourceVariant: source,
                targetLoader: body.targetLoader,
                targetMc: body.targetMc,
                mirror: body.mirror !== false,
            }, log);
            if (body.autoBuild) {
                store.updateVariantBuildStatus(variant.id, "building");
                (0, build_queue_1.enqueueBuild)({
                    variantId: variant.id,
                    projectPath: variant.projectPath,
                    type: "build+run",
                });
                log("已加入构建队列");
            }
            res.write(`__VARIANT__:${JSON.stringify(variant)}\n`);
            res.write("__EXIT__:0\n");
        }
        catch (err) {
            res.write(`错误：${err.message}\n`);
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
        const body = (await readBody(req));
        if (!body.path) {
            json(res, { error: "缺少 path" }, 400);
            return true;
        }
        const result = mod.importFromPath(body.path);
        if (!result) {
            json(res, { error: "无法识别为 mod 项目" }, 400);
            return true;
        }
        json(res, { ...result, mod: store.getMod(result.modId) });
        return true;
    }
    // POST /api/mods/scan
    if (urlPath === "/api/mods/scan" && method === "POST") {
        const body = (await readBody(req));
        if (body.path) {
            store.addScanDir(body.path);
            const result = mod.scanAndImport(body.path);
            json(res, result);
        }
        else {
            const result = mod.autoScan();
            json(res, result);
        }
        return true;
    }
    // POST /api/mods/register
    if (urlPath === "/api/mods/register" && method === "POST") {
        const body = (await readBody(req));
        let m = store.findModByModId(body.modId);
        if (!m) {
            try {
                m = store.createMod({ modId: body.modId, displayName: body.displayName });
            }
            catch (err) {
                json(res, { error: err.message }, 400);
                return true;
            }
        }
        const existing = store.findVariantByPath(body.projectPath);
        if (existing) {
            json(res, { mod: existing.mod, variant: existing.variant, existed: true });
            return true;
        }
        const variant = store.addVariant(m.id, {
            loader: body.loader,
            mcVersion: body.mcVersion,
            projectPath: node_path_1.default.resolve(body.projectPath),
            modVersion: body.modVersion ?? "0.1.0",
            group: body.group ?? `com.example.${body.modId}`,
            mappings: (body.mappings ?? "mojmap"),
            buildStatus: (body.buildStatus ?? "success"),
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
        const body = (await readBody(req));
        if (body.add) {
            store.addScanDir(body.add);
        }
        else if (body.remove) {
            store.removeScanDir(body.remove);
        }
        else if (body.dirs) {
            store.setScanDirs(body.dirs);
        }
        json(res, { ok: true, scanDirs: store.getScanDirs() });
        return true;
    }
    // DELETE /api/settings/scan-dirs — body: { path }
    if (urlPath === "/api/settings/scan-dirs" && method === "DELETE") {
        const body = (await readBody(req));
        if (!body.path) {
            json(res, { error: "缺少 path" }, 400);
            return true;
        }
        const ok = store.removeScanDir(body.path);
        json(res, { ok, scanDirs: store.getScanDirs() });
        return true;
    }
    // POST /api/variants/:id/build
    const buildMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/build$/);
    if (buildMatch && method === "POST") {
        const body = (await readBody(req));
        const found = store.getVariant(buildMatch[1]);
        if (!found) {
            json(res, { error: "变体不存在" }, 404);
            return true;
        }
        if (found.variant.pathMissing) {
            json(res, { error: "项目目录不存在，请先重新定位" }, 400);
            return true;
        }
        store.updateVariantBuildStatus(buildMatch[1], "building");
        const jobId = (0, build_queue_1.enqueueBuild)({
            variantId: buildMatch[1],
            projectPath: found.variant.projectPath,
            type: body.runClient ? "build+run" : "build",
        });
        json(res, { jobId, queue: (0, build_queue_1.getQueueStatus)() });
        return true;
    }
    // POST /api/variants/:id/run
    const runMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/run$/);
    if (runMatch && method === "POST") {
        const found = store.getVariant(runMatch[1]);
        if (!found) {
            json(res, { error: "变体不存在" }, 404);
            return true;
        }
        const jobId = (0, build_queue_1.enqueueBuild)({
            variantId: runMatch[1],
            projectPath: found.variant.projectPath,
            type: "run",
        });
        json(res, { jobId, queue: (0, build_queue_1.getQueueStatus)() });
        return true;
    }
    // GET /api/variants/:id/logs
    const logsMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/logs$/);
    if (logsMatch && method === "GET") {
        json(res, { logs: (0, build_queue_1.listLogs)(logsMatch[1]) });
        return true;
    }
    // GET /api/logs?path=...
    if (urlPath.startsWith("/api/logs?") && method === "GET") {
        const q = new URL(urlPath, "http://localhost").searchParams;
        const logPath = q.get("path");
        if (!logPath) {
            json(res, { error: "缺少 path" }, 400);
            return true;
        }
        const content = (0, build_queue_1.readLog)(logPath);
        if (!content && !node_fs_1.default.existsSync(node_path_1.default.resolve(logPath))) {
            json(res, { error: "日志不存在或路径非法" }, 403);
            return true;
        }
        json(res, { content });
        return true;
    }
    // GET /api/queue
    if (urlPath === "/api/queue" && method === "GET") {
        json(res, (0, build_queue_1.getQueueStatus)());
        return true;
    }
    // POST /api/queue/cancel
    if (urlPath === "/api/queue/cancel" && method === "POST") {
        (0, build_queue_1.cancelBuildQueue)();
        json(res, { ok: true });
        return true;
    }
    // POST /api/mods/:id/build-all
    const buildAllMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/build-all$/);
    if (buildAllMatch && method === "POST") {
        const body = (await readBody(req));
        const m = store.getMod(buildAllMatch[1]);
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const variants = m.variants.filter((v) => !body.loader || v.loader === body.loader);
        for (const v of variants)
            store.updateVariantBuildStatus(v.id, "building");
        const ids = (0, build_queue_1.enqueueBatch)(variants.map((v) => ({
            variantId: v.id,
            projectPath: v.projectPath,
            type: body.runClient ? "build+run" : "build",
        })));
        json(res, { jobIds: ids, count: ids.length, queue: (0, build_queue_1.getQueueStatus)() });
        return true;
    }
    // GET /api/export/catalog
    if (urlPath === "/api/export/catalog" && method === "GET") {
        json(res, mod.exportCatalog());
        return true;
    }
    // POST /api/export/catalog
    if (urlPath === "/api/export/catalog" && method === "POST") {
        const body = (await readBody(req));
        const dest = body.path ?? node_path_1.default.join(mod.getDmclDir(), "catalog.json");
        const resolved = node_path_1.default.resolve(dest);
        const dmclDir = node_path_1.default.resolve(mod.getDmclDir());
        if (!resolved.startsWith(dmclDir + node_path_1.default.sep) && resolved !== dmclDir) {
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
        const { supportedVersions } = await Promise.resolve(`${node_path_1.default.join(node_path_1.default.resolve(__dirname, ".."), "dist", "meta", "versions.js")}`).then(s => __importStar(require(s)));
        const loader = verMatch[1];
        const versions = await supportedVersions(loader);
        json(res, { loader, versions });
        return true;
    }
    // POST /api/open-cursor
    if (urlPath === "/api/open-cursor" && method === "POST") {
        const body = (await readBody(req));
        if (body.path) {
            (0, node_child_process_1.spawn)("cursor", [body.path], { detached: true, stdio: "ignore" });
        }
        json(res, { ok: true });
        return true;
    }
    return false;
}
async function initWorkspace(repoRoot) {
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
