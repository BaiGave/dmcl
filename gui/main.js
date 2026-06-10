"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
let mainWindow = null;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 720,
        height: 620,
        resizable: false,
        title: "mcdev-wizard",
        webPreferences: {
            preload: node_path_1.default.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
        autoHideMenuBar: true,
    });
    mainWindow.loadFile(node_path_1.default.join(__dirname, "index.html"));
}
// ---------- IPC ----------
electron_1.ipcMain.handle("gen:run", async (_event, args) => {
    const projectRoot = node_path_1.default.resolve(__dirname, "..");
    const child = (0, node_child_process_1.spawn)("npx", ["tsx", "src/index.ts", ...args], {
        cwd: projectRoot,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve) => {
        const lines = [];
        const collect = (data) => {
            for (const line of data.toString("utf8").split("\n")) {
                const t = line.trim();
                if (t) {
                    lines.push(t);
                    mainWindow?.webContents.send("gen:line", t);
                }
            }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("close", () => resolve(lines));
        child.on("error", (err) => {
            lines.push(`错误：${err.message}`);
            resolve(lines);
        });
    });
});
electron_1.ipcMain.handle("fs:write", async (_event, filePath, content) => {
    await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    await node_fs_1.default.promises.writeFile(filePath, content, "utf8");
    return true;
});
electron_1.ipcMain.handle("fs:exists", async (_event, p) => node_fs_1.default.existsSync(p));
electron_1.ipcMain.handle("app:open", async (_event, dir) => {
    // 优先用 cursor，退化为 explorer
    try {
        await electron_1.shell.openPath(dir);
    }
    catch {
        // fallback
    }
});
// ---------- lifecycle ----------
electron_1.app.whenReady().then(createWindow);
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.app.on("activate", () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0)
        createWindow();
});
