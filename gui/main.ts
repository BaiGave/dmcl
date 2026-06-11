import { app, BrowserWindow, dialog, shell } from "electron";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = 19089;
let mainWindow: BrowserWindow | null = null;

// ============ Minimal HTTP server for GUI ============

function serveGui(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url === "/" ? "/index.html" : req.url ?? "/";
  const guiDir = path.join(__dirname);
  const filePath = path.join(guiDir, path.normalize(url).replace(/^\/+/, ""));

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

      let args: string[];
      try { args = JSON.parse(body).args; } catch { args = []; }

      const projectRoot = path.resolve(__dirname, "..");
      const child = spawn("npx", ["tsx", "src/index.ts", ...args], {
        cwd: projectRoot,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const push = (data: Buffer) => {
        for (const line of data.toString("utf8").split("\n")) {
          if (line.trim()) res.write(line.trim() + "\n");
        }
      };
      child.stdout!.on("data", push);
      child.stderr!.on("data", push);
      child.on("close", () => res.end());
      child.on("error", (err) => {
        res.write(`ERROR: ${err.message}\n`);
        res.end();
      });
    });
    return;
  }

  // API: close app window
  if (url === "/api/close") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    if (mainWindow) mainWindow.close();
    return;
  }

  // API: open directory picker
  if (url === "/api/select-dir") {
    dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择模组项目输出目录",
    }).then((result) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (result.canceled || result.filePaths.length === 0) {
        res.end(JSON.stringify({ canceled: true }));
      } else {
        res.end(JSON.stringify({ path: result.filePaths[0] }));
      }
    }).catch((err) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Static file serving
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("404");
    return;
  }

  const ext = path.extname(filePath);
  const mime: Record<string, string> = {
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
  fs.createReadStream(filePath).pipe(res);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ---------- lifecycle ----------

app.whenReady().then(() => {
  // Start HTTP server first, then create window
  createServer(serveGui).listen(PORT, () => {
    console.log(`GUI server: http://localhost:${PORT}`);
    createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
