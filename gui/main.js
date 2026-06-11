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
const PORT = 19089;
let mainWindow = null;
// ============ Minimal HTTP server for GUI ============
function serveGui(req, res) {
    const url = req.url === "/" ? "/index.html" : req.url ?? "/";
    const guiDir = node_path_1.default.join(__dirname);
    const filePath = node_path_1.default.join(guiDir, node_path_1.default.normalize(url).replace(/^\/+/, ""));
    // API: run CLI generation
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
            const projectRoot = node_path_1.default.resolve(__dirname, "..");
            const child = (0, node_child_process_1.spawn)("npx", ["tsx", "src/index.ts", ...args], {
                cwd: projectRoot,
                env: { ...process.env, FORCE_COLOR: "0" },
                stdio: ["ignore", "pipe", "pipe"],
            });
            const push = (data) => {
                for (const line of data.toString("utf8").split("\n")) {
                    if (line.trim())
                        res.write(line.trim() + "\n");
                }
            };
            child.stdout.on("data", push);
            child.stderr.on("data", push);
            child.on("close", () => res.end());
            child.on("error", (err) => {
                res.write(`ERROR: ${err.message}\n`);
                res.end();
            });
        });
        return;
    }
    // API: open directory picker
    if (url === "/api/select-dir") {
        electron_1.dialog.showOpenDialog(mainWindow, {
            properties: ["openDirectory", "createDirectory"],
            title: "选择模组项目输出目录",
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
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 760,
        height: 660,
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
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("activate", () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0)
        createWindow();
});
