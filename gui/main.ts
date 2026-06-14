import { app, BrowserWindow, dialog, shell } from "electron";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runBuild, runClientVerify, setVerificationCancelled } from "./gradle";
import { handleWorkspaceApi, initWorkspace } from "./workspace-api";
import { onBuildEvent } from "./build-queue";

const PORT = 19089;
let mainWindow: BrowserWindow | null = null;

let activeChild: ChildProcess | null = null;
let userCancelled = false;

function killActiveChild(): void {
  userCancelled = true;
  if (activeChild && !activeChild.killed) {
    try {
      if (process.platform === "win32" && activeChild.pid) {
        spawn("taskkill", ["/PID", String(activeChild.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        activeChild.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  }
  activeChild = null;
}

function parseGenerateArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && i + 1 < args.length) {
      out[a.replace(/^--/, "")] = args[i + 1];
      i++;
    }
  }
  return out;
}

async function registerGeneratedMod(args: string[], success: boolean): Promise<void> {
  try {
    const parsed = parseGenerateArgs(args);
    if (!parsed.dir || !parsed.modid) return;
    const { ws } = await import("./workspace-api");
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
      loader: (parsed.loader ?? "fabric") as "fabric" | "forge" | "neoforge",
      mcVersion: parsed.mc ?? "1.21.4",
      projectPath: path.resolve(parsed.dir),
      modVersion: "0.1.0",
      group: parsed.group ?? `com.example.${parsed.modid}`,
      mappings: (parsed.mappings ?? "mojmap") as "yarn" | "mojmap" | "parchment",
      buildStatus: success ? "success" : "failed",
      source: "dmcl",
    });
  } catch (err) {
    console.warn("注册模组失败:", err);
  }
}

function broadcastBuildEvent(event: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("build:event", event);
  }
}

onBuildEvent((event) => broadcastBuildEvent(event));

function serveGui(req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? "/";
  const urlObj = new URL(rawUrl, "http://localhost");
  const urlPath = urlObj.pathname;
  const method = req.method ?? "GET";

  // Workspace API
  handleWorkspaceApi(req, res, urlPath, method).then((handled) => {
    if (handled) return;

    const url = urlPath === "/" ? "/index.html" : urlPath;
    const guiDir = path.join(__dirname);
    const filePath = path.join(guiDir, path.normalize(url).replace(/^\/+/, ""));
    const resolvedFile = path.resolve(filePath);
    const resolvedGui = path.resolve(guiDir);
    if (!resolvedFile.startsWith(resolvedGui + path.sep) && resolvedFile !== resolvedGui) {
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

        let args: string[];
        try { args = JSON.parse(body).args; } catch { args = []; }

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

        if (fs.existsSync(targetDir)) {
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
      setVerificationCancelled(true);
      killActiveChild();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (urlPath === "/api/close") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      killActiveChild();
      if (mainWindow) mainWindow.close();
      return;
    }

    if (urlPath === "/api/open-folder" && method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let dirPath = "";
        try { dirPath = JSON.parse(body).path; } catch { /* ignore */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        if (dirPath) shell.openPath(dirPath);
        res.end(JSON.stringify({ ok: !!dirPath }));
      });
      return;
    }

    if (urlPath === "/api/default-dir") {
      import("./workspace-api").then(async ({ ws }) => {
        const mod = await ws();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          path: mod.getProjectsRoot(),
          projectsRoot: mod.getProjectsRoot(),
        }));
      }).catch(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: path.resolve(__dirname, "..", "projects") }));
      });
      return;
    }

    if (urlPath === "/api/select-dir") {
      dialog.showOpenDialog(mainWindow!, {
        properties: ["openDirectory", "createDirectory"],
        title: "选择目录",
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
      ".svg": "image/svg+xml; charset=utf-8",
    };
    res.writeHead(200, {
      "Content-Type": mime[ext] ?? "text/plain",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  }).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
}

function runVerification(targetDir: string, res: ServerResponse, args: string[]): void {
  activeChild = runBuild(targetDir, res, (buildCode) => {
    activeChild = null;
    if (buildCode !== 0) {
      registerGeneratedMod(args, false).then(() => {
        res.write(`__EXIT__:${buildCode}\n`);
        res.end();
      });
      return;
    }
    activeChild = runClientVerify(targetDir, res, (clientCode) => {
      activeChild = null;
      registerGeneratedMod(args, clientCode === 0).then(() => {
        res.write(`__EXIT__:${clientCode}\n`);
        res.end();
      });
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    title: "DMCL",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-bridge.js"),
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  if (process.env.DMCL_DEBUG) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  const repoRoot = path.resolve(__dirname, "..");
  createServer(serveGui).listen(PORT, "127.0.0.1", () => {
    console.log(`GUI server: http://localhost:${PORT}`);
    initWorkspace(repoRoot).catch(console.warn);
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
