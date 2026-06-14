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
const workspace_api_1 = require("./workspace-api");
const build_queue_1 = require("./build-queue");
const PORT = 19089;
let mainWindow = null;
let activeChild = null;
let userCancelled = false;
function killActiveChild() {
    userCancelled = true;
    if (activeChild && !activeChild.killed) {
        try {
            if (process.platform === "win32" && activeChild.pid) {
                (0, node_child_process_1.spawn)("taskkill", ["/PID", String(activeChild.pid), "/T", "/F"], { stdio: "ignore" });
            }
            else {
                activeChild.kill("SIGTERM");
            }
        }
        catch { /* ignore */ }
    }
    activeChild = null;
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
        let m = store.findModByModId(parsed.modid);
        if (!m) {
            m = store.createMod({
                modId: parsed.modid,
                displayName: parsed.name ?? parsed.modid,
            });
        }
        const existing = store.findVariantByPath(parsed.dir);
        if (existing) {
            store.updateVariantBuildStatus(existing.variant.id, success ? "success" : "failed");
            return;
        }
        store.addVariant(m.id, {
            loader: (parsed.loader ?? "fabric"),
            mcVersion: parsed.mc ?? "1.21.4",
            projectPath: node_path_1.default.resolve(parsed.dir),
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
(0, build_queue_1.onBuildEvent)((event) => broadcastBuildEvent(event));
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
                try {
                    args = JSON.parse(body).args;
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
                userCancelled = false;
                (0, gradle_1.setVerificationCancelled)(false);
                const child = (0, node_child_process_1.spawn)(nodeExe, [tsxModule, cliScript, ...args], {
                    cwd: projectRoot,
                    env: { ...process.env, FORCE_COLOR: "0", ELECTRON_RUN_AS_NODE: "1" },
                    stdio: ["ignore", "pipe", "pipe"],
                });
                activeChild = child;
                const push = (data) => {
                    for (const line of data.toString("utf8").split("\n")) {
                        if (line.trim())
                            res.write(line.trim() + "\n");
                    }
                };
                child.stdout.on("data", push);
                child.stderr.on("data", push);
                child.on("close", (code) => {
                    activeChild = null;
                    if (userCancelled) {
                        res.write("已取消\n");
                        res.write("__EXIT__:1\n");
                        res.end();
                        return;
                    }
                    if (code !== 0) {
                        res.write(`__EXIT__:${code ?? 1}\n`);
                        res.end();
                        return;
                    }
                    if (!targetDir) {
                        res.write("跳过构建验证：无法确定项目目录\n");
                        res.write("__EXIT__:0\n");
                        res.end();
                        return;
                    }
                    runVerification(targetDir, res, args);
                });
                child.on("error", (err) => {
                    activeChild = null;
                    res.write(`ERROR: ${err.message}\n`);
                    res.write("__EXIT__:1\n");
                    res.end();
                });
            });
            return;
        }
        if (urlPath === "/api/cancel") {
            (0, gradle_1.setVerificationCancelled)(true);
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
function runVerification(targetDir, res, args) {
    activeChild = (0, gradle_1.runBuild)(targetDir, res, (buildCode) => {
        activeChild = null;
        if (buildCode !== 0) {
            registerGeneratedMod(args, false).then(() => {
                res.write(`__EXIT__:${buildCode}\n`);
                res.end();
            });
            return;
        }
        activeChild = (0, gradle_1.runClientVerify)(targetDir, res, (clientCode) => {
            activeChild = null;
            registerGeneratedMod(args, clientCode === 0).then(() => {
                res.write(`__EXIT__:${clientCode}\n`);
                res.end();
            });
        });
    });
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1080,
        height: 780,
        minWidth: 900,
        minHeight: 600,
        resizable: true,
        title: "DMCL",
        autoHideMenuBar: true,
        webPreferences: {
            preload: node_path_1.default.join(__dirname, "preload-bridge.js"),
        },
    });
    mainWindow.loadURL(`http://localhost:${PORT}`);
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
        (0, workspace_api_1.initWorkspace)(repoRoot).catch(console.warn);
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
