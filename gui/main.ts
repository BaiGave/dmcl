import { app, BrowserWindow, dialog, shell } from "electron";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runBuild, runClientVerify, setVerificationCancelled } from "./gradle";
const PORT = 19089;
let mainWindow: BrowserWindow | null = null;

/** 当前正在运行的子进程（生成或构建），用于取消和窗口关闭时清理 */
let activeChild: ChildProcess | null = null;
let userCancelled = false;

function killActiveChild(): void {
  userCancelled = true;
  if (activeChild && !activeChild.killed) {
    try {
      if (process.platform === "win32" && activeChild.pid) {
        // Windows 上用 taskkill 终止整个进程树（gradle 会派生子进程）
        spawn("taskkill", ["/PID", String(activeChild.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        activeChild.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  }
  activeChild = null;
}

// ============ Minimal HTTP server for GUI ============

function serveGui(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url === "/" ? "/index.html" : req.url ?? "/";
  const guiDir = path.join(__dirname);
  const filePath = path.join(guiDir, path.normalize(url).replace(/^\/+/, ""));

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

      let args: string[];
      try { args = JSON.parse(body).args; } catch { args = []; }

      // 参数校验：必须是非交互模式且带项目目录，否则 CLI 会卡在交互提问
      const dirIdx = args.indexOf("--dir");
      const targetDir = dirIdx >= 0 && dirIdx + 1 < args.length
        ? path.resolve(args[dirIdx + 1])
        : null;
      if (!args.includes("--yes") || !targetDir) {
        res.write("错误：内部参数不完整（缺少 --yes 或 --dir），请重启应用后重试\n");
        res.write("__EXIT__:1\n");
        res.end();
        return;
      }

      // 防呆：目标目录已存在且非空 → 直接报错，不覆盖用户文件
      if (targetDir && fs.existsSync(targetDir)) {
        const entries = fs.readdirSync(targetDir);
        if (entries.length > 0) {
          res.write(`错误：目录已存在且非空：${targetDir}\n`);
          res.write("请换一个模组 ID 或父目录，或删除该文件夹后重试\n");
          res.write("__EXIT__:1\n");
          res.end();
          return;
        }
      }

      const projectRoot = path.resolve(__dirname, "..");
      const nodeExe = process.execPath;
      const tsxModule = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const cliScript = path.join(projectRoot, "src", "index.ts");

      userCancelled = false;
      setVerificationCancelled(false);

      const child = spawn(nodeExe, [tsxModule, cliScript, ...args], {
        cwd: projectRoot,
        env: { ...process.env, FORCE_COLOR: "0", ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeChild = child;

      const push = (data: Buffer) => {
        for (const line of data.toString("utf8").split("\n")) {
          if (line.trim()) res.write(line.trim() + "\n");
        }
      };
      child.stdout!.on("data", push);
      child.stderr!.on("data", push);

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
    setVerificationCancelled(true);
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
    if (mainWindow) mainWindow.close();
    return;
  }

  // API: open folder in explorer
  if (url === "/api/open-folder" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      let dirPath = "";
      try { dirPath = JSON.parse(body).path; } catch { /* ignore */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (dirPath) shell.openPath(dirPath);
      res.end(JSON.stringify({ ok: !!dirPath }));
    });
    return;
  }

  // API: get default parent directory (Desktop)
  if (url === "/api/default-dir") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: app.getPath("desktop") }));
    return;
  }

  // API: open directory picker
  if (url === "/api/select-dir") {
    dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择项目存放的父目录",
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

/** 构建通过后继续启动 MC 客户端验证 */
function runVerification(targetDir: string, res: ServerResponse): void {
  activeChild = runBuild(targetDir, res, (buildCode) => {
    activeChild = null;
    if (buildCode !== 0) {
      res.write(`__EXIT__:${buildCode}\n`);
      res.end();
      return;
    }
    activeChild = runClientVerify(targetDir, res, (clientCode) => {
      activeChild = null;
      res.write(`__EXIT__:${clientCode}\n`);
      res.end();
    });
  });
}

function createWindow(): void {  mainWindow = new BrowserWindow({
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
  killActiveChild();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killActiveChild();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
