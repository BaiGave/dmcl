import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 620,
    resizable: false,
    title: "mcdev-wizard",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

// ---------- IPC ----------

ipcMain.handle("gen:run", async (_event, args: string[]) => {
  const projectRoot = path.resolve(__dirname, "..");
  const child = spawn("npx", ["tsx", "src/index.ts", ...args], {
    cwd: projectRoot,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise<string[]>((resolve) => {
    const lines: string[] = [];
    const collect = (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        const t = line.trim();
        if (t) {
          lines.push(t);
          mainWindow?.webContents.send("gen:line", t);
        }
      }
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.on("close", () => resolve(lines));
    child.on("error", (err) => {
      lines.push(`错误：${err.message}`);
      resolve(lines);
    });
  });
});

ipcMain.handle("fs:write", async (_event, filePath: string, content: string) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf8");
  return true;
});

ipcMain.handle("fs:exists", async (_event, p: string) => fs.existsSync(p));

ipcMain.handle("app:open", async (_event, dir: string) => {
  // 优先用 cursor，退化为 explorer
  try {
    await shell.openPath(dir);
  } catch {
    // fallback
  }
});

// ---------- lifecycle ----------

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
