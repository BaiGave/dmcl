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
exports.cancelSourceJobs = cancelSourceJobs;
exports.handleWorkspaceApi = handleWorkspaceApi;
exports.initWorkspace = initWorkspace;
exports.ws = ws;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const build_queue_1 = require("./build-queue");
const variant_batch_job_1 = require("./variant-batch-job");
const mod_gen_lock_1 = require("./mod-gen-lock");
const dist_loader_1 = require("./dist-loader");
function parseLoaderParam(value) {
    if (value === "fabric" || value === "forge" || value === "neoforge")
        return value;
    return undefined;
}
function parseLimitParam(value) {
    if (!value)
        return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function resolveManagedMod(store, modModule, modKey, hints) {
    store.refresh({ force: true });
    let m = store.getMod(modKey) ?? store.findModByModId(modKey);
    if (!m)
        m = modModule.findModOnDisk(store, modKey);
    if (!m && hints?.projectPath)
        m = store.resolveMod(modKey, hints.projectPath);
    if (!m && hints?.modId)
        m = store.findModByModId(hints.modId);
    if (m) {
        store.refresh({ force: true });
        m = store.getMod(m.id) ?? m;
    }
    return m;
}
function compareMcVersion(a, b) {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
function sortVariantsForBuild(variants) {
    return [...variants].sort((a, b) => {
        const mc = compareMcVersion(b.mcVersion, a.mcVersion);
        if (mc !== 0)
            return mc;
        return a.loader.localeCompare(b.loader);
    });
}
function pickBuildableVariants(variants, opts) {
    const skipped = { queued: 0, missing: 0, filtered: 0 };
    const buildable = [];
    for (const v of variants) {
        if (opts.loader && v.loader !== opts.loader) {
            skipped.filtered++;
            continue;
        }
        if (opts.failedOnly && v.buildStatus !== "failed") {
            skipped.filtered++;
            continue;
        }
        if (!node_fs_1.default.existsSync(v.projectPath)) {
            skipped.missing++;
            continue;
        }
        if ((0, build_queue_1.isVariantQueued)(v.id)) {
            skipped.queued++;
            continue;
        }
        buildable.push(v);
    }
    return { buildable: sortVariantsForBuild(buildable), skipped };
}
let wsMod = null;
let minecraftSourcesMod = null;
async function ws() {
    if (!wsMod) {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        wsMod = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "index.js"));
    }
    return wsMod;
}
async function minecraftSources() {
    if (!minecraftSourcesMod) {
        minecraftSourcesMod = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("sources", "index.js"));
    }
    return minecraftSourcesMod;
}
async function cancelSourceJobs() {
    try {
        (await minecraftSources()).cancelMinecraftSourceTask();
    }
    catch {
        // App shutdown must continue even when the source module was never loaded.
    }
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
        const q = new URL(req.url ?? "/", "http://localhost").searchParams;
        store.refresh({ force: q.get("force") === "1" || q.get("force") === "true" });
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
    // GET /api/toolchain?loader=fabric&mcVersion=1.21.1[&projectPath=...]
    if (urlPath.startsWith("/api/toolchain") && method === "GET") {
        const q = new URL(urlPath, "http://localhost").searchParams;
        const loader = parseLoaderParam(q.get("loader"));
        const mcVersion = (q.get("mcVersion") ?? q.get("mc") ?? "").trim();
        const projectPath = (q.get("projectPath") ?? "").trim();
        if (projectPath) {
            const { resolveProjectToolchain } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("core", "toolchain.js"));
            const profile = resolveProjectToolchain(projectPath, mcVersion || undefined);
            json(res, profile ?? { error: "无法解析项目工具链" }, profile ? 200 : 404);
            return true;
        }
        if (!loader || !mcVersion) {
            json(res, { error: "缺少 loader 或 mcVersion" }, 400);
            return true;
        }
        const { resolveVersionToolchain } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("core", "toolchain.js"));
        json(res, resolveVersionToolchain(loader, mcVersion));
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
        const { getConcurrencySettingsPayload } = await Promise.resolve().then(() => __importStar(require("./concurrency-settings")));
        const { getGovernorStatus } = await Promise.resolve().then(() => __importStar(require("./concurrency-governor")));
        json(res, { ...getConcurrencySettingsPayload(), ...getGovernorStatus() });
        return true;
    }
    // POST /api/verify-project — 对已生成项目执行构建/客户端验证（流式输出）
    if (urlPath === "/api/verify-project" && method === "POST") {
        const body = (await readBody(req));
        const projectPath = body.projectPath ? node_path_1.default.resolve(body.projectPath) : "";
        if (!projectPath || !node_fs_1.default.existsSync(projectPath)) {
            json(res, { error: "项目路径无效或不存在" }, 400);
            return true;
        }
        const linked = store.findVariantByPath(projectPath);
        const projectsRoot = node_path_1.default.resolve(mod.getProjectsRoot());
        const allowed = linked
            || (projectPath.startsWith(projectsRoot + node_path_1.default.sep) || projectPath === projectsRoot);
        if (!allowed) {
            json(res, { error: "路径不在工作区允许范围内" }, 403);
            return true;
        }
        const variantId = body.variantId ?? linked?.variant.id;
        const detected = linked ? undefined : mod.detectProject(projectPath);
        const loader = (linked?.variant.loader ?? detected?.loader);
        const mcVersion = linked?.variant.mcVersion ?? detected?.mcVersion;
        if (!loader || !mcVersion) {
            json(res, { error: "无法推断加载器或 Minecraft 版本" }, 400);
            return true;
        }
        if (variantId)
            store.updateVariantBuildStatus(variantId, "building");
        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Transfer-Encoding": "chunked",
        });
        const log = (msg) => {
            if (!res.writableEnded)
                res.write(msg + "\n");
        };
        try {
            const result = await mod.verifyExistingProject(projectPath, loader, mcVersion, {
                buildOnly: body.buildOnly === true,
                autoFix: true,
                buildRetries: 2,
                gradleSlots: 1,
                log,
            });
            if (variantId) {
                store.updateVariantBuildStatus(variantId, result.success ? "success" : "failed");
            }
            if (result.success) {
                log(body.buildOnly ? "✔ 构建验证通过" : "✔ 验证完成");
                res.write("__EXIT__:0\n");
            }
            else {
                log(`错误：${result.failureSummary || "验证失败"}`);
                res.write("__EXIT__:1\n");
            }
        }
        catch (err) {
            if (variantId)
                store.updateVariantBuildStatus(variantId, "failed");
            log(`错误：${err.message}`);
            res.write("__EXIT__:1\n");
        }
        res.end();
        return true;
    }
    // GET /api/paths/default-variant?modId=&loader=&mc=
    if (urlPath.startsWith("/api/paths/default-variant") && method === "GET") {
        const q = new URL(urlPath, "http://localhost").searchParams;
        const modId = (q.get("modId") ?? "").trim();
        const loader = (q.get("loader") ?? "fabric");
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
        store.refresh();
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
        const body = (await readBody(req));
        const deleteFiles = body?.deleteFiles === true;
        const m = store.getMod(modMatch[1]);
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const wantsProgress = deleteFiles && m.variants.length > 1;
        let fileResult;
        if (deleteFiles) {
            if (wantsProgress) {
                res.writeHead(200, {
                    "Content-Type": "application/x-ndjson; charset=utf-8",
                    "Transfer-Encoding": "chunked",
                    "X-Content-Type-Options": "nosniff",
                });
                const paths = m.variants.map((v) => v.projectPath);
                fileResult = await mod.deleteModProjects(m.modId, paths, (done, total, p) => {
                    res.write(JSON.stringify({ type: "progress", done, total, path: p }) + "\n");
                });
                if (fileResult.skipped.length > 0) {
                    res.write(JSON.stringify({
                        type: "error",
                        error: `有 ${fileResult.skipped.length} 个项目目录未能删除，请关闭占用程序后重试`,
                        fileResult,
                    }) + "\n");
                    res.end();
                    return true;
                }
            }
            else {
                const deletedOnDisk = await mod.deleteModProjects(m.modId, m.variants.map((v) => v.projectPath));
                fileResult = deletedOnDisk;
                if (deletedOnDisk.skipped.length > 0) {
                    json(res, {
                        error: `有 ${deletedOnDisk.skipped.length} 个项目目录未能删除，请关闭占用程序后重试`,
                        fileResult: deletedOnDisk,
                    }, 500);
                    return true;
                }
            }
        }
        const ok = store.removeMod(modMatch[1]);
        mod.invalidateMatrixCache(m.modId);
        const payload = { ok, deleteFiles, fileResult, mods: store.getMods() };
        if (wantsProgress) {
            res.write(JSON.stringify({ type: "done", ...payload }) + "\n");
            res.end();
        }
        else {
            json(res, payload);
        }
        return true;
    }
    // GET /api/mods/:id/detail — 单次磁盘扫描 + 矩阵（详情页专用）
    const detailMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/detail$/);
    if (detailMatch && method === "GET") {
        store.refresh();
        const m = store.getMod(detailMatch[1]);
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const matrix = await mod.buildMatrix(m);
        const sources = await minecraftSources();
        const detailMod = {
            ...m,
            variants: m.variants.map((variant) => ({
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
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const matrix = await mod.buildMatrix(m);
        json(res, mod.serializeMatrixResult(matrix));
        return true;
    }
    // POST /api/mods/:id/variants
    const variantPostMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/variants$/);
    if (variantPostMatch && method === "POST") {
        const body = (await readBody(req));
        const modKey = decodeURIComponent(variantPostMatch[1]);
        let hintPath;
        if (body.modId && mod.isValidModId(body.modId)) {
            try {
                hintPath = mod.defaultVariantPath(body.modId, body.targetLoader, body.targetMc);
            }
            catch { /* ignore */ }
        }
        const m = resolveManagedMod(store, mod, modKey, {
            modId: body.modId,
            projectPath: hintPath,
        });
        if (!m) {
            json(res, {
                error: "工作区未找到该模组，请关闭弹窗后刷新模组列表再试",
                modKey,
                modId: body.modId,
            }, 404);
            return true;
        }
        let source = m.variants.find((v) => v.id === body.sourceVariantId);
        if (!source) {
            const onDisk = mod.findVariantOnDisk(store, body.sourceVariantId);
            if (onDisk && (onDisk.mod.id === m.id || onDisk.mod.modId === m.modId)) {
                source = onDisk.variant;
            }
        }
        if (!source) {
            json(res, { error: `源变体不存在：${body.sourceVariantId ?? ""}` }, 400);
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
            const variant = await (0, mod_gen_lock_1.withModVariantGenLock)(m.id, () => mod.generateVariant({
                mod: m,
                sourceVariant: source,
                targetLoader: body.targetLoader,
                targetMc: body.targetMc,
                mirror: body.mirror !== false,
            }, log));
            if (body.autoBuild) {
                store.updateVariantBuildStatus(variant.id, "building");
                (0, build_queue_1.enqueueBuild)({
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
        }
        catch (err) {
            res.write(`错误：${err.message}\n`);
            res.write("__EXIT__:1\n");
        }
        res.end();
        return true;
    }
    // POST /api/mods/:id/variants/batch — 服务端持久化批任务（支持 100+）
    const variantBatchMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/variants\/batch$/);
    if (variantBatchMatch && method === "POST") {
        const body = (await readBody(req));
        const modUuid = decodeURIComponent(variantBatchMatch[1]);
        store.refresh({ force: true });
        const m = store.getMod(modUuid);
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const targets = body.targets ?? [];
        if (!targets.length) {
            json(res, { error: "缺少 targets" }, 400);
            return true;
        }
        let sourceId = body.sourceVariantId;
        if (!sourceId) {
            sourceId = m.variants[0]?.id;
        }
        if (!sourceId) {
            json(res, { error: "请先至少有一个变体作为源码来源" }, 400);
            return true;
        }
        try {
            const job = await (0, variant_batch_job_1.startVariantBatchJob)({
                modUuid: m.id,
                modName: body.modName ?? m.displayName,
                sourceVariantId: sourceId,
                targets,
                buildOnly: body.buildOnly !== false,
                mirror: body.mirror !== false,
            });
            json(res, { ok: true, job }, 202);
        }
        catch (err) {
            json(res, { error: err.message }, 409);
        }
        return true;
    }
    // GET /api/batch-jobs/active
    if (urlPath === "/api/batch-jobs/active" && method === "GET") {
        await (0, variant_batch_job_1.ensureBatchJobsDir)();
        json(res, { job: (0, variant_batch_job_1.getActiveVariantBatchJob)() });
        return true;
    }
    // GET /api/batch-jobs/:id
    const batchJobMatch = urlPath.match(/^\/api\/batch-jobs\/([^/]+)$/);
    if (batchJobMatch && method === "GET") {
        await (0, variant_batch_job_1.ensureBatchJobsDir)();
        const job = (0, variant_batch_job_1.getVariantBatchJob)(decodeURIComponent(batchJobMatch[1]));
        if (!job) {
            json(res, { error: "任务不存在" }, 404);
            return true;
        }
        json(res, { job });
        return true;
    }
    // POST /api/batch-jobs/:id/cancel
    const batchCancelMatch = urlPath.match(/^\/api\/batch-jobs\/([^/]+)\/cancel$/);
    if (batchCancelMatch && method === "POST") {
        const job = (0, variant_batch_job_1.cancelVariantBatchJob)(decodeURIComponent(batchCancelMatch[1]));
        if (!job) {
            json(res, { error: "任务不存在" }, 404);
            return true;
        }
        json(res, { ok: true, job });
        return true;
    }
    // DELETE /api/mods/:modId/variants/:variantId
    const variantDelMatch = urlPath.match(/^\/api\/mods\/([^/]+)\/variants\/([^/]+)$/);
    if (variantDelMatch && method === "DELETE") {
        const body = (await readBody(req));
        const deleteFiles = body?.deleteFiles === true;
        const m = store.getMod(variantDelMatch[1]);
        if (!m) {
            json(res, { error: "模组不存在" }, 404);
            return true;
        }
        const variant = m.variants.find((v) => v.id === variantDelMatch[2]);
        if (!variant) {
            json(res, { error: "变体不存在" }, 404);
            return true;
        }
        if (deleteFiles) {
            try {
                await mod.deleteVariantProject(variant.projectPath, m.modId, m.variants.map((v) => v.projectPath));
            }
            catch (err) {
                json(res, { error: err.message }, 400);
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
        if (!body.loader || !["fabric", "forge", "neoforge"].includes(body.loader)) {
            json(res, { error: "无效的 loader" }, 400);
            return true;
        }
        let m = store.findModByModId(body.modId);
        if (!m) {
            try {
                const projectPath = node_path_1.default.resolve(body.projectPath);
                store.prepareVariantRegistration(projectPath);
                const modDir = mod.inferModDir(projectPath, body.modId);
                m = store.createMod({
                    modId: body.modId,
                    displayName: body.displayName,
                    modDir,
                });
            }
            catch (err) {
                json(res, { error: err.message }, 400);
                return true;
            }
        }
        else {
            store.prepareVariantRegistration(body.projectPath);
        }
        store.refresh({ force: true });
        m = store.findModByModId(body.modId) ?? m;
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
        const { getConcurrencySettingsPayload } = await Promise.resolve().then(() => __importStar(require("./concurrency-settings")));
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
        const body = (await readBody(req));
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
        }
        catch (err) {
            json(res, { error: err.message }, 409);
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
        const body = (await readBody(req));
        const { resetRunnerPool } = await Promise.resolve().then(() => __importStar(require("./gradle-runner")));
        const { applyConcurrencyUserSettings, resetConcurrencyToDefaults, } = await Promise.resolve().then(() => __importStar(require("./concurrency-governor")));
        const { getConcurrencySettingsPayload } = await Promise.resolve().then(() => __importStar(require("./concurrency-settings")));
        if (body.reset) {
            resetConcurrencyToDefaults();
        }
        else {
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
        store.updateVariantBuildStatus(buildMatch[1], "building");
        const jobId = (0, build_queue_1.enqueueBuild)({
            variantId: buildMatch[1],
            projectPath: found.variant.projectPath,
            type: body.runClient ? "build+run" : "build",
            loader: found.variant.loader,
            mcVersion: found.variant.mcVersion,
        });
        json(res, { jobId, queue: (0, build_queue_1.getQueueStatus)() });
        return true;
    }
    // POST /api/variants/:id/sources — 按当前变体自动准备 MC 与前置模组源码
    const sourceMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/sources$/);
    if (sourceMatch && method === "POST") {
        const found = store.getVariant(sourceMatch[1]);
        if (!found) {
            json(res, { error: "变体不存在" }, 404);
            return true;
        }
        if (!node_fs_1.default.existsSync(found.variant.projectPath)) {
            json(res, { error: "项目目录不存在，请先重新定位项目" }, 400);
            return true;
        }
        const body = (await readBody(req));
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
        }
        catch (err) {
            json(res, { error: err.message }, 409);
        }
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
        store.updateVariantBuildStatus(runMatch[1], "building");
        const jobId = (0, build_queue_1.enqueueBuild)({
            variantId: runMatch[1],
            projectPath: found.variant.projectPath,
            type: "run",
            loader: found.variant.loader,
            mcVersion: found.variant.mcVersion,
        });
        json(res, { jobId, queue: (0, build_queue_1.getQueueStatus)() });
        return true;
    }
    // GET /api/variants/:id/log — 最新构建日志（含实时 / 已保存 / Gradle 回退）
    const logContentMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/log$/);
    if (logContentMatch && method === "GET") {
        const variantId = decodeURIComponent(logContentMatch[1]);
        const payload = await (0, build_queue_1.getVariantBuildLogContent)(variantId);
        json(res, payload);
        return true;
    }
    // GET /api/variants/:id/logs
    const logsMatch = urlPath.match(/^\/api\/variants\/([^/]+)\/logs$/);
    if (logsMatch && method === "GET") {
        const logs = await (0, build_queue_1.listLogs)(logsMatch[1]);
        json(res, { logs });
        return true;
    }
    // GET /api/logs?path=...&variantId=...
    if (urlPath.startsWith("/api/logs?") && method === "GET") {
        const q = new URL(urlPath, "http://localhost").searchParams;
        const logPath = q.get("path");
        const variantId = q.get("variantId");
        if (!logPath || !variantId) {
            json(res, { error: "缺少 path 或 variantId" }, 400);
            return true;
        }
        const content = await (0, build_queue_1.readLog)(logPath, variantId);
        if (!content) {
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
        store.refresh({ force: true });
        const m = resolveManagedMod(store, mod, buildAllMatch[1]);
        if (!m) {
            json(res, { error: "工作区未找到该模组，请刷新模组列表后重试" }, 404);
            return true;
        }
        const { buildable, skipped } = pickBuildableVariants(m.variants, {
            loader: body.loader,
            failedOnly: body.failedOnly,
        });
        if (buildable.length === 0) {
            const parts = [];
            if (skipped.missing)
                parts.push(`${skipped.missing} 个路径不存在`);
            if (skipped.queued)
                parts.push(`${skipped.queued} 个已在队列`);
            if (skipped.filtered)
                parts.push(`${skipped.filtered} 个不符合筛选`);
            json(res, {
                error: parts.length ? `没有可构建的变体（${parts.join("，")}）` : "没有可构建的变体",
                skipped,
            }, 400);
            return true;
        }
        for (const v of buildable)
            store.updateVariantBuildStatus(v.id, "building");
        const jobType = body.runClient ? "build+run" : "build";
        const ids = (0, build_queue_1.enqueueBatch)(buildable.map((v) => ({
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
            queue: (0, build_queue_1.getQueueStatus)(),
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
    // GET /api/versions/:loader — 从 ~/.dmcl/meta-cache.json 读取
    const verMatch = urlPath.match(/^\/api\/versions\/([^/]+)$/);
    if (verMatch && method === "GET") {
        const { getMetaCache } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "meta-cache.js"));
        const loader = verMatch[1];
        if (!["fabric", "forge", "neoforge"].includes(loader)) {
            json(res, { error: "未知加载器" }, 400);
            return true;
        }
        const { data, fromCache, stale } = await getMetaCache().get({ strategy: "cache-first" });
        json(res, { loader, versions: data.loaderVersions[loader] ?? [], fromCache, stale, updatedAt: data.updatedAt });
        return true;
    }
    // GET /api/meta/status
    if (urlPath === "/api/meta/status" && method === "GET") {
        const { getMetaCache, META_CACHE_FILE } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "meta-cache.js"));
        json(res, { ...getMetaCache().getStatus(), cacheFile: META_CACHE_FILE });
        return true;
    }
    // GET /api/verification/status
    if (urlPath === "/api/verification/status" && method === "GET") {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const { readVersionVerificationIndex, summarizeVersionVerification, verificationFilePath, } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "version-verification.js"));
        const index = readVersionVerificationIndex();
        const records = Object.values(index.records);
        const counts = { verified: 0, "build-only": 0, failed: 0, unknown: 0 };
        for (const record of records) {
            const summary = summarizeVersionVerification(record);
            counts[summary.state]++;
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
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const q = new URL(urlPath, "http://localhost").searchParams;
        const loader = parseLoaderParam(q.get("loader"));
        const mcVersion = q.get("mc") ?? undefined;
        const limit = parseLimitParam(q.get("limit"));
        const force = q.get("force") === "1" || q.get("force") === "true";
        if (q.get("loader") && !loader) {
            json(res, { error: "未知加载器" }, 400);
            return true;
        }
        const { loadVersionVerificationPlan } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "version-verifier.js"));
        const plan = await loadVersionVerificationPlan({ loader, mcVersion, force });
        const shown = plan.slice(0, limit ?? 50);
        json(res, { planned: plan.length, shown: shown.length, targets: shown });
        return true;
    }
    // POST /api/verification/run or /api/verification/run-all
    if ((urlPath === "/api/verification/run" || urlPath === "/api/verification/run-all") &&
        method === "POST") {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const body = (await readBody(req));
        const loader = parseLoaderParam(body.loader);
        if (body.loader && !loader) {
            json(res, { error: "未知加载器" }, 400);
            return true;
        }
        const { runAllVersionVerifications, runVersionVerificationBatchParallel } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "version-verifier.js"));
        try {
            const options = {
                loader,
                mcVersion: body.mcVersion,
                limit: body.limit,
                force: body.force === true || urlPath === "/api/verification/run-all",
                refreshMeta: body.refreshMeta === true || urlPath === "/api/verification/run-all",
                rootDir: body.rootDir,
                mirror: body.mirror !== false,
                keepProjects: body.keepProjects === true,
                parallel: body.parallel,
                buildOnly: body.buildOnly === true,
                autoFix: body.autoFix === true,
            };
            const result = urlPath === "/api/verification/run-all"
                ? await runAllVersionVerifications(options)
                : await runVersionVerificationBatchParallel(options);
            json(res, result);
        }
        catch (err) {
            json(res, { error: err.message }, 500);
        }
        return true;
    }
    // POST /api/meta/refresh — 增量刷新（force=1 时为设置页全量刷新）
    if (urlPath === "/api/meta/refresh" && method === "POST") {
        const { getMetaCache } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "meta-cache.js"));
        const { invalidateMatrixCache } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "matrix.js"));
        const body = (await readBody(req));
        const force = body?.force === true || body?.force === "true" || body?.force === 1;
        try {
            const result = await getMetaCache().refreshDetailed({ force });
            invalidateMatrixCache();
            json(res, {
                ok: true,
                mode: result.mode,
                newReleaseCount: result.newReleaseCount,
                forgeMdkProbeCount: result.forgeMdkProbeCount,
                loadersRefreshed: ["fabric", "forge", "neoforge"],
                note: force
                    ? "已重拉全部上游元数据并重探全部 Forge MDK"
                    : "已重拉 Fabric / Forge / NeoForge 上游元数据；Forge 仅增量 MDK 探测，映射表仅为新增版本预取",
                updatedAt: result.data.updatedAt,
                loaderVersions: result.data.loaderVersions,
            });
        }
        catch (err) {
            json(res, { error: `刷新失败：${err.message}` }, 500);
        }
        return true;
    }
    // GET /api/mappings/status
    if (urlPath === "/api/mappings/status" && method === "GET") {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const { getMappingsCache, MAPPINGS_CACHE_FILE } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "mappings-cache.js"));
        json(res, { ...getMappingsCache().getStatus(), cacheFile: MAPPINGS_CACHE_FILE });
        return true;
    }
    // POST /api/mappings/refresh — 强制刷新单个 loader+mc 的映射缓存
    if (urlPath === "/api/mappings/refresh" && method === "POST") {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const body = (await readBody(req));
        const loader = body.loader;
        const mcVersion = body.mcVersion;
        if (!loader || !mcVersion || !["fabric", "forge", "neoforge"].includes(loader)) {
            json(res, { error: "缺少 loader 或 mcVersion" }, 400);
            return true;
        }
        const { getMappingsCache } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "mappings-cache.js"));
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
        }
        catch (err) {
            json(res, { error: `刷新失败：${err.message}` }, 500);
        }
        return true;
    }
    // POST /api/mappings/refresh-all — 刷新某加载器全部版本的映射缓存
    if (urlPath === "/api/mappings/refresh-all" && method === "POST") {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const body = (await readBody(req));
        const loader = body.loader;
        if (!loader || !["fabric", "forge", "neoforge"].includes(loader)) {
            json(res, { error: "缺少 loader" }, 400);
            return true;
        }
        const { getMetaCache } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "meta-cache.js"));
        const { getMappingsCache } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "mappings-cache.js"));
        const { data } = await getMetaCache().get({ strategy: "cache-first" });
        const versions = data.loaderVersions[loader] ?? [];
        const result = await getMappingsCache().prefetch({ [loader]: versions });
        json(res, { ok: true, loader, versionCount: versions.length, ...result });
        return true;
    }
    if (urlPath === "/api/mappings/warmup" && method === "POST") {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const body = (await readBody(req));
        const { prefetchMappings } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "mappings-cache.js"));
        if (body.loader && body.mcVersion) {
            prefetchMappings(body.loader, body.mcVersion).catch(() => { });
        }
        json(res, { ok: true });
        return true;
    }
    // GET /api/mappings/:loader/:mc — 从持久化缓存读取真实可用映射
    const mapMatch = urlPath.match(/^\/api\/mappings\/([^/]+)\/([^/]+)$/);
    if (mapMatch && method === "GET") {
        const projectRoot = node_path_1.default.resolve(__dirname, "..");
        const loader = mapMatch[1];
        const mcVersion = decodeURIComponent(mapMatch[2]);
        if (!["fabric", "forge", "neoforge"].includes(loader)) {
            json(res, { error: "未知加载器" }, 400);
            return true;
        }
        const { getMappingsCache, MAPPINGS_CACHE_FILE } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "mappings-cache.js"));
        const { entry, fromCache, pending } = await getMappingsCache().getOrFetch(loader, mcVersion);
        json(res, {
            loader,
            mcVersion,
            options: entry.options,
            default: entry.default,
            updatedAt: entry.updatedAt,
            fromCache,
            pending: pending === true,
            cacheFile: MAPPINGS_CACHE_FILE,
        });
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
async function initWorkspace(repoRoot, writableProjectsRoot) {
    const mod = await ws();
    mod.setRepoRoot(repoRoot);
    if (writableProjectsRoot)
        mod.setProjectsRoot(writableProjectsRoot);
    mod.ensureProjectsRoot();
    const store = mod.getWorkspace();
    const projectsRoot = mod.getProjectsRoot();
    if (!store.getScanDirs().includes(projectsRoot)) {
        store.addScanDir(projectsRoot);
    }
    mod.reconcileWorkspace(store);
    const projectRoot = node_path_1.default.resolve(__dirname, "..");
    (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("meta", "meta-cache.js"))
        .then(({ getMetaCache }) => {
        const cache = getMetaCache();
        cache.refreshIfStale();
        void cache.get({ strategy: "cache-first" }).catch(() => { });
    })
        .catch((err) => console.warn("[dmcl] 元数据缓存初始化跳过:", err));
}
