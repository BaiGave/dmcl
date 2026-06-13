"use strict";
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
const PORT = 19089;
let mainWindow = null;
/** 当前正在运行的子进程（生成或构建），用于取消和窗口关闭时清理 */
let activeChild = null;
let userCancelled = false;
function killActiveChild() {
    userCancelled = true;
    if (activeChild && !activeChild.killed) {
        try {
            if (process.platform === "win32" && activeChild.pid) {
                // Windows 上用 taskkill 终止整个进程树（gradle 会派生子进程）
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
// ============ Minimal HTTP server for GUI ============
function serveGui(req, res) {
    const url = req.url === "/" ? "/index.html" : req.url ?? "/";
    const guiDir = node_path_1.default.join(__dirname);
    const filePath = node_path_1.default.join(guiDir, node_path_1.default.normalize(url).replace(/^\/+/, ""));
    // API: run CLI generation + auto build verification
    if (url === "/api/generate" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
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
            // 参数校验：必须是非交互模式且带项目目录，否则 CLI 会卡在交互提问
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
            // 防呆：目标目录已存在且非空 → 直接报错，不覆盖用户文件
            if (targetDir && node_fs_1.default.existsSync(targetDir)) {
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
                // 生成成功 → 自动构建验证
                if (!targetDir) {
                    res.write("跳过构建验证：无法确定项目目录\n");
                    res.write(`__EXIT__:0\n`);
                    res.end();
                    return;
                }
                runVerification(targetDir, res);
            });
            child.on("error", (err) => {
                activeChild = null;
                res.write(`ERROR: ${err.message}\n`);
                res.write(`__EXIT__:1\n`);
                res.end();
            });
        });
        return;
    }
    // API: cancel current generation/build
    if (url === "/api/cancel") {
        (0, gradle_1.setVerificationCancelled)(true);
        killActiveChild();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    // API: close app window
    if (url === "/api/close") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        killActiveChild();
        if (mainWindow)
            mainWindow.close();
        return;
    }
    // API: open folder in explorer
    if (url === "/api/open-folder" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
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
    // API: get default parent directory (Desktop)
    if (url === "/api/default-dir") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: electron_1.app.getPath("desktop") }));
        return;
    }
    // API: open directory picker
    if (url === "/api/select-dir") {
        electron_1.dialog.showOpenDialog(mainWindow, {
            properties: ["openDirectory", "createDirectory"],
            title: "选择项目存放的父目录",
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
    // Static file serving
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
    };
    res.writeHead(200, {
        "Content-Type": mime[ext] ?? "text/plain",
        "Cache-Control": "no-cache",
    });
    node_fs_1.default.createReadStream(filePath).pipe(res);
}
/** 构建通过后继续启动 MC 客户端验证 */
function runVerification(targetDir, res) {
    activeChild = (0, gradle_1.runBuild)(targetDir, res, (buildCode) => {
        activeChild = null;
        if (buildCode !== 0) {
            res.write(`__EXIT__:${buildCode}\n`);
            res.end();
            return;
        }
        activeChild = (0, gradle_1.runClientVerify)(targetDir, res, (clientCode) => {
            activeChild = null;
            res.write(`__EXIT__:${clientCode}\n`);
            res.end();
        });
    });
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 680,
        height: 720,
        resizable: true,
        title: "mcdev-wizard",
        autoHideMenuBar: true,
    });
    mainWindow.loadURL(`http://localhost:${PORT}`);
    if (process.env.MCDEV_DEBUG) {
        mainWindow.webContents.openDevTools();
    }
    // 拦截 _blank 链接在外部浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        electron_1.shell.openExternal(url);
        return { action: "deny" };
    });
}
// ---------- lifecycle ----------
electron_1.app.whenReady().then(() => {
    // Start HTTP server first, then create window
    (0, node_http_1.createServer)(serveGui).listen(PORT, () => {
        console.log(`GUI server: http://localhost:${PORT}`);
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
