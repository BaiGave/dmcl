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
const electron_1 = require("electron");
const node_http_1 = require("node:http");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const gradle_1 = require("./gradle");
const gradle_runner_1 = require("./gradle-runner");
const workspace_api_1 = require("./workspace-api");
const dist_loader_1 = require("./dist-loader");
const build_queue_1 = require("./build-queue");
const variant_batch_job_1 = require("./variant-batch-job");
const APP_DISPLAY_NAME = "DMCL";
const APP_USER_MODEL_ID = "com.dmcl.workbench";
if (process.platform === "win32") {
    electron_1.app.setAppUserModelId(APP_USER_MODEL_ID);
}
electron_1.app.setName(APP_DISPLAY_NAME);
const PORT = 19089;
let mainWindow = null;
async function packagedProjectsRoot() {
    if (!electron_1.app.isPackaged)
        return undefined;
    const { resolveDmclHome } = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("core", "dmcl-home.js"));
    return node_path_1.default.join(resolveDmclHome({ execPath: process.execPath }), "projects");
}
const generateSessions = new Set();
let notificationBatch = { success: 0, failed: 0, labels: [], targetVariantId: null, failedVariantIds: [] };
let notificationBatchCancelled = false;
async function killChildProcess(proc) {
    if (proc.killed)
        return;
    try {
        await (0, gradle_1.killProcessTree)(proc, process.platform === "win32");
    }
    catch { /* ignore */ }
}
function cancelAllGenerateSessions() {
    for (const session of generateSessions) {
        session.cancelled = true;
        if (session.scaffoldChild)
            void killChildProcess(session.scaffoldChild);
        void session.runner.cancel();
    }
}
function killActiveChild() {
    cancelAllGenerateSessions();
    void (0, gradle_runner_1.cancelAllRunners)();
    (0, build_queue_1.cancelBuildQueue)();
    void (0, workspace_api_1.cancelSourceJobs)();
}
function parseGenerateArgs(args) {
    const out = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("--") && i + 1 < args.length) {
            out[a.replace(/^--/, "")] = args[i + 1];
            i++;
        }
    }
    return out;
}
async function registerGeneratedMod(args, success) {
    try {
        const parsed = parseGenerateArgs(args);
        if (!parsed.dir || !parsed.modid)
            return;
        const { ws } = await Promise.resolve().then(() => __importStar(require("./workspace-api")));
        const mod = await ws();
        const store = mod.getWorkspace();
        const projectPath = node_path_1.default.resolve(parsed.dir);
        store.prepareVariantRegistration(projectPath);
        let m = store.findModByModId(parsed.modid);
        if (!m) {
            const modDir = mod.inferModDir(projectPath, parsed.modid);
            m = store.createMod({
                modId: parsed.modid,
                displayName: parsed.name ?? parsed.modid,
                modDir,
            });
        }
        store.refresh({ force: true });
        m = store.findModByModId(parsed.modid) ?? m;
        const existing = store.findVariantByPath(parsed.dir);
        if (existing) {
            store.updateVariantBuildStatus(existing.variant.id, success ? "success" : "failed");
            return;
        }
        store.addVariant(m.id, {
            loader: (parsed.loader ?? "fabric"),
            mcVersion: parsed.mc ?? "1.21.4",
            projectPath,
            modVersion: "0.1.0",
            group: parsed.group ?? `com.example.${parsed.modid}`,
            mappings: (parsed.mappings ?? "mojmap"),
            buildStatus: success ? "success" : "failed",
            source: "dmcl",
        });
    }
    catch (err) {
        console.warn("注册模组失败:", err);
    }
}
function broadcastBuildEvent(event) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("build:event", event);
    }
}
function resetNotificationBatch() {
    notificationBatch = { success: 0, failed: 0, labels: [], targetVariantId: null, failedVariantIds: [] };
    notificationBatchCancelled = false;
}
function completeBuildNotificationBatch(event) {
    if (event.type === "queue" && notificationBatch.success + notificationBatch.failed === 0) {
        notificationBatchCancelled = false;
        return;
    }
    if (event.type === "cancelled") {
        notificationBatchCancelled = true;
        return;
    }
    if (event.type !== "done" || !event.job || notificationBatchCancelled)
        return;
    if (event.job.type === "run")
        return;
    if (event.success)
        notificationBatch.success++;
    else {
        notificationBatch.failed++;
        notificationBatch.failedVariantIds.push(event.job.variantId);
    }
    notificationBatch.targetVariantId = event.job.variantId;
    const label = (0, build_queue_1.variantJobLabel)(event.job);
    if (!notificationBatch.labels.includes(label))
        notificationBatch.labels.push(label);
    const queueStatus = (0, build_queue_1.getQueueStatus)();
    if (queueStatus.pending > 0 || queueStatus.active > 0)
        return;
    const summary = { ...notificationBatch, labels: [...notificationBatch.labels], failedVariantIds: [...notificationBatch.failedVariantIds] };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("build:summary", summary);
    }
    const shouldNotify = mainWindow && !mainWindow.isDestroyed()
        && (!mainWindow.isFocused() || mainWindow.isMinimized())
        && electron_1.Notification.isSupported();
    if (shouldNotify) {
        const hasFailure = summary.failed > 0;
        const body = hasFailure
            ? `${summary.success} 个成功，${summary.failed} 个失败`
            : `${summary.success} 个变体构建成功${summary.labels.length ? ` · ${summary.labels.slice(0, 2).join(" / ")}` : ""}`;
        const notification = new electron_1.Notification({
            title: hasFailure ? "DMCL · 构建有失败" : "DMCL · 构建完成",
            body,
        });
        notification.on("click", () => {
            if (!mainWindow || mainWindow.isDestroyed())
                return;
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
            const targetVariantId = summary.failedVariantIds[0] || summary.targetVariantId;
            mainWindow.webContents.send("notification:open", { targetVariantId, failed: hasFailure });
        });
        notification.show();
    }
    resetNotificationBatch();
}
(0, build_queue_1.onBuildEvent)((event) => {
    broadcastBuildEvent(event);
    completeBuildNotificationBatch(event);
});
function serveGui(req, res) {
    const rawUrl = req.url ?? "/";
    const urlObj = new URL(rawUrl, "http://localhost");
    const urlPath = urlObj.pathname;
    const method = req.method ?? "GET";
    // Workspace API
    (0, workspace_api_1.handleWorkspaceApi)(req, res, urlPath, method).then((handled) => {
        if (handled)
            return;
        const url = urlPath === "/" ? "/index.html" : urlPath;
        const guiDir = node_path_1.default.join(__dirname);
        const filePath = node_path_1.default.join(guiDir, node_path_1.default.normalize(url).replace(/^\/+/, ""));
        const resolvedFile = node_path_1.default.resolve(filePath);
        const resolvedGui = node_path_1.default.resolve(guiDir);
        if (!resolvedFile.startsWith(resolvedGui + node_path_1.default.sep) && resolvedFile !== resolvedGui) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }
        // API: run CLI generation + auto build verification
        if (urlPath === "/api/generate" && method === "POST") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                res.writeHead(200, {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Transfer-Encoding": "chunked",
                    "X-Content-Type-Options": "nosniff",
                });
                let args;
                let scaffoldOnly = false;
                try {
                    const parsed = JSON.parse(body);
                    args = parsed.args ?? [];
                    scaffoldOnly = !!parsed.scaffoldOnly;
                }
                catch {
                    args = [];
                }
                const dirIdx = args.indexOf("--dir");
                const targetDir = dirIdx >= 0 && dirIdx + 1 < args.length
                    ? node_path_1.default.resolve(args[dirIdx + 1])
                    : null;
                if (!args.includes("--yes") || !targetDir) {
                    res.write("错误：内部参数不完整（缺少 --yes 或 --dir），请重启应用后重试\n");
                    res.write("__EXIT__:1\n");
                    res.end();
                    return;
                }
                if (node_fs_1.default.existsSync(targetDir)) {
                    const stat = node_fs_1.default.statSync(targetDir);
                    if (!stat.isDirectory()) {
                        res.write(`错误：路径已存在但不是目录：${targetDir}\n`);
                        res.write("__EXIT__:1\n");
                        res.end();
                        return;
                    }
                    const entries = node_fs_1.default.readdirSync(targetDir);
                    if (entries.length > 0) {
                        res.write(`错误：目录已存在且非空：${targetDir}\n`);
                        res.write("请换一个模组 ID 或父目录，或删除该文件夹后重试\n");
                        res.write("__EXIT__:1\n");
                        res.end();
                        return;
                    }
                }
                const projectRoot = node_path_1.default.resolve(__dirname, "..");
                const nodeExe = process.execPath;
                const tsxModule = node_path_1.default.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
                const cliScript = node_path_1.default.join(projectRoot, "src", "index.ts");
                const session = {
                    cancelled: false,
                    scaffoldChild: null,
                    runner: (0, gradle_runner_1.createGradleRunner)(),
                };
                generateSessions.add(session);
                const child = (0, node_child_process_1.spawn)(nodeExe, [tsxModule, cliScript, ...args], {
                    cwd: projectRoot,
                    env: { ...process.env, FORCE_COLOR: "0", ELECTRON_RUN_AS_NODE: "1" },
                    stdio: ["ignore", "pipe", "pipe"],
                });
                session.scaffoldChild = child;
                const push = (data) => {
                    for (const line of data.toString("utf8").split("\n")) {
                        if (line.trim())
                            res.write(line.trim() + "\n");
                    }
                };
                child.stdout.on("data", push);
                child.stderr.on("data", push);
                const finish = (exitCode) => {
                    generateSessions.delete(session);
                    session.runner.reset();
                    res.write(`__EXIT__:${exitCode}\n`);
                    res.end();
                };
                child.on("close", (code) => {
                    session.scaffoldChild = null;
                    if (session.cancelled) {
                        res.write("已取消\n");
                        finish(1);
                        return;
                    }
                    if (code !== 0) {
                        registerGeneratedMod(args, false).then(() => finish(code ?? 1));
                        return;
                    }
                    if (scaffoldOnly || !targetDir) {
                        registerGeneratedMod(args, true).then(() => {
                            if (scaffoldOnly)
                                res.write("✔ 项目已生成（跳过构建验证）\n");
                            else
                                res.write("跳过构建验证：无法确定项目目录\n");
                            finish(0);
                        });
                        return;
                    }
                    void runVerificationWithRunner(session, targetDir, res, args, finish);
                });
                child.on("error", (err) => {
                    session.scaffoldChild = null;
                    generateSessions.delete(session);
                    res.write(`ERROR: ${err.message}\n`);
                    finish(1);
                });
            });
            return;
        }
        if (urlPath === "/api/cancel") {
            killActiveChild();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (urlPath === "/api/close") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            killActiveChild();
            if (mainWindow)
                mainWindow.close();
            return;
        }
        if (urlPath === "/api/open-folder" && method === "POST") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                let dirPath = "";
                try {
                    dirPath = JSON.parse(body).path;
                }
                catch { /* ignore */ }
                res.writeHead(200, { "Content-Type": "application/json" });
                if (dirPath)
                    electron_1.shell.openPath(dirPath);
                res.end(JSON.stringify({ ok: !!dirPath }));
            });
            return;
        }
        if (urlPath === "/api/default-dir") {
            Promise.resolve().then(() => __importStar(require("./workspace-api"))).then(async ({ ws }) => {
                const mod = await ws();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    path: mod.getProjectsRoot(),
                    projectsRoot: mod.getProjectsRoot(),
                }));
            }).catch(() => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ path: node_path_1.default.resolve(__dirname, "..", "projects") }));
            });
            return;
        }
        if (urlPath === "/api/select-dir") {
            electron_1.dialog.showOpenDialog(mainWindow, {
                properties: ["openDirectory", "createDirectory"],
                title: "选择目录",
            }).then((result) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                if (result.canceled || result.filePaths.length === 0) {
                    res.end(JSON.stringify({ canceled: true }));
                }
                else {
                    res.end(JSON.stringify({ path: result.filePaths[0] }));
                }
            }).catch((err) => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            });
            return;
        }
        if (!node_fs_1.default.existsSync(filePath)) {
            res.writeHead(404);
            res.end("404");
            return;
        }
        const ext = node_path_1.default.extname(filePath);
        const mime = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json",
            ".png": "image/png",
            ".svg": "image/svg+xml; charset=utf-8",
        };
        res.writeHead(200, {
            "Content-Type": mime[ext] ?? "text/plain",
            "Cache-Control": "no-cache",
        });
        node_fs_1.default.createReadStream(filePath).pipe(res);
    }).catch((err) => {
        if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
        }
    });
}
async function runVerificationWithRunner(session, targetDir, res, args, finish) {
    const log = (line) => {
        if (!res.writableEnded)
            res.write(line + "\n");
    };
    const sep = "─".repeat(40);
    res.write(`${sep}\n`);
    res.write("正在验证构建（首次需要下载 Minecraft 等依赖，约 5~20 分钟，请耐心等待）…\n");
    const buildCode = await session.runner.runBuildOnly(targetDir, log);
    if (session.cancelled) {
        res.write("已取消\n");
        await registerGeneratedMod(args, false);
        finish(1);
        return;
    }
    if (buildCode !== 0) {
        await registerGeneratedMod(args, false);
        finish(buildCode);
        return;
    }
    res.write(`${sep}\n`);
    const clientCode = await session.runner.runClientOnly(targetDir, log);
    await registerGeneratedMod(args, clientCode === 0 && !session.cancelled);
    finish(session.cancelled ? 1 : clientCode);
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1080,
        height: 780,
        minWidth: 900,
        minHeight: 600,
        resizable: true,
        title: "DMCL",
        show: false,
        backgroundColor: "#f6f8f6",
        icon: node_path_1.default.join(__dirname, "assets", "brand", process.platform === "win32" ? "dmcl-app-icon.ico" : "dmcl-app-icon-256.png"),
        autoHideMenuBar: true,
        webPreferences: {
            preload: node_path_1.default.join(__dirname, "preload-bridge.js"),
        },
    });
    mainWindow.loadURL(`http://localhost:${PORT}`);
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    if (process.env.DMCL_DEBUG) {
        mainWindow.webContents.openDevTools();
    }
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        electron_1.shell.openExternal(url);
        return { action: "deny" };
    });
}
electron_1.app.whenReady().then(() => {
    const repoRoot = node_path_1.default.resolve(__dirname, "..");
    (0, node_http_1.createServer)(serveGui).listen(PORT, "127.0.0.1", () => {
        console.log(`GUI server: http://localhost:${PORT}`);
        void packagedProjectsRoot()
            .then(async (projectsRoot) => {
            await (0, workspace_api_1.initWorkspace)(repoRoot, projectsRoot);
            await (0, variant_batch_job_1.resumeVariantBatchJobs)();
        })
            .catch(async (err) => {
            console.warn("packagedProjectsRoot failed, falling back to dev layout:", err);
            await (0, workspace_api_1.initWorkspace)(repoRoot, undefined);
            await (0, variant_batch_job_1.resumeVariantBatchJobs)();
        });
        createWindow();
    });
});
electron_1.app.on("window-all-closed", () => {
    killActiveChild();
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("before-quit", () => {
    killActiveChild();
});
electron_1.app.on("activate", () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0)
        createWindow();
});
