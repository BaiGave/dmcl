import { app, BrowserWindow, dialog, shell, Notification } from "electron";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { killProcessTree } from "./gradle";
import { cancelAllRunners, createGradleRunner, type GradleRunner } from "./gradle-runner";
import { cancelSourceJobs, handleWorkspaceApi, initWorkspace } from "./workspace-api";
import { loadDist, repoDist } from "./dist-loader";
import { cancelBuildQueue, onBuildEvent, getQueueStatus, variantJobLabel, type BuildEvent } from "./build-queue";
import { resumeVariantBatchJobs } from "./variant-batch-job";

const APP_DISPLAY_NAME = "DMCL";
const APP_USER_MODEL_ID = "com.dmcl.workbench";

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
app.setName(APP_DISPLAY_NAME);

const PORT = 19089;
let mainWindow: BrowserWindow | null = null;

async function packagedProjectsRoot(): Promise<string | undefined> {
  if (!app.isPackaged) return undefined;
  const { resolveDmclHome } = await loadDist<{ resolveDmclHome: (options?: { execPath?: string }) => string }>(
    repoDist("core", "dmcl-home.js"),
  );
  return path.join(resolveDmclHome({ execPath: process.execPath }), "projects");
}

interface GenerateSession {
  cancelled: boolean;
  scaffoldChild: ChildProcess | null;
  runner: GradleRunner;
}

const generateSessions = new Set<GenerateSession>();

interface BuildSummary {
  success: number;
  failed: number;
  labels: string[];
  targetVariantId: string | null;
  failedVariantIds: string[];
}

let notificationBatch: BuildSummary = { success: 0, failed: 0, labels: [], targetVariantId: null, failedVariantIds: [] };
let notificationBatchCancelled = false;

async function killChildProcess(proc: ChildProcess): Promise<void> {
  if (proc.killed) return;
  try {
    await killProcessTree(proc, process.platform === "win32");
  } catch { /* ignore */ }
}

function cancelAllGenerateSessions(): void {
  for (const session of generateSessions) {
    session.cancelled = true;
    if (session.scaffoldChild) void killChildProcess(session.scaffoldChild);
    void session.runner.cancel();
  }
}

function killActiveChild(): void {
  cancelAllGenerateSessions();
  void cancelAllRunners();
  cancelBuildQueue();
  void cancelSourceJobs();
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
    const projectPath = path.resolve(parsed.dir);
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
      loader: (parsed.loader ?? "fabric") as "fabric" | "forge" | "neoforge",
      mcVersion: parsed.mc ?? "1.21.4",
      projectPath,
      modVersion: "0.1.0",
      group: parsed.group ?? `com.example.${parsed.modid}`,
      mappings: (parsed.mappings ?? "mojmap") as "yarn" | "mojmap" | "parchment" | "mcp",
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

function resetNotificationBatch(): void {
  notificationBatch = { success: 0, failed: 0, labels: [], targetVariantId: null, failedVariantIds: [] };
  notificationBatchCancelled = false;
}

function completeBuildNotificationBatch(event: BuildEvent): void {
  if (event.type === "queue" && notificationBatch.success + notificationBatch.failed === 0) {
    notificationBatchCancelled = false;
    return;
  }
  if (event.type === "cancelled") {
    notificationBatchCancelled = true;
    return;
  }
  if (event.type !== "done" || !event.job || notificationBatchCancelled) return;
  if (event.job.type === "run") return;

  if (event.success) notificationBatch.success++;
  else {
    notificationBatch.failed++;
    notificationBatch.failedVariantIds.push(event.job.variantId);
  }
  notificationBatch.targetVariantId = event.job.variantId;
  const label = variantJobLabel(event.job);
  if (!notificationBatch.labels.includes(label)) notificationBatch.labels.push(label);

  const queueStatus = getQueueStatus();
  if (queueStatus.pending > 0 || queueStatus.active > 0) return;
  const summary = { ...notificationBatch, labels: [...notificationBatch.labels], failedVariantIds: [...notificationBatch.failedVariantIds] };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("build:summary", summary);
  }
  const shouldNotify = mainWindow && !mainWindow.isDestroyed()
    && (!mainWindow.isFocused() || mainWindow.isMinimized())
    && Notification.isSupported();
  if (shouldNotify) {
    const hasFailure = summary.failed > 0;
    const body = hasFailure
      ? `${summary.success} 个成功，${summary.failed} 个失败`
      : `${summary.success} 个变体构建成功${summary.labels.length ? ` · ${summary.labels.slice(0, 2).join(" / ")}` : ""}`;
    const notification = new Notification({
      title: hasFailure ? "DMCL · 构建有失败" : "DMCL · 构建完成",
      body,
    });
    notification.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      const targetVariantId = summary.failedVariantIds[0] || summary.targetVariantId;
      mainWindow.webContents.send("notification:open", { targetVariantId, failed: hasFailure });
    });
    notification.show();
  }
  resetNotificationBatch();
}

onBuildEvent((event) => {
  broadcastBuildEvent(event);
  completeBuildNotificationBatch(event);
});

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
        let scaffoldOnly = false;
        try {
          const parsed = JSON.parse(body) as { args?: string[]; scaffoldOnly?: boolean };
          args = parsed.args ?? [];
          scaffoldOnly = !!parsed.scaffoldOnly;
        } catch { args = []; }

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
          const stat = fs.statSync(targetDir);
          if (!stat.isDirectory()) {
            res.write(`错误：路径已存在但不是目录：${targetDir}\n`);
            res.write("__EXIT__:1\n");
            res.end();
            return;
          }
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

        const session: GenerateSession = {
          cancelled: false,
          scaffoldChild: null,
          runner: createGradleRunner(),
        };
        generateSessions.add(session);

        const child = spawn(nodeExe, [tsxModule, cliScript, ...args], {
          cwd: projectRoot,
          env: { ...process.env, FORCE_COLOR: "0", ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        session.scaffoldChild = child;

        const push = (data: Buffer) => {
          for (const line of data.toString("utf8").split("\n")) {
            if (line.trim()) res.write(line.trim() + "\n");
          }
        };
        child.stdout!.on("data", push);
        child.stderr!.on("data", push);

        const finish = (exitCode: number) => {
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
              if (scaffoldOnly) res.write("✔ 项目已生成（跳过构建验证）\n");
              else res.write("跳过构建验证：无法确定项目目录\n");
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

async function runVerificationWithRunner(
  session: GenerateSession,
  targetDir: string,
  res: ServerResponse,
  args: string[],
  finish: (code: number) => void,
): Promise<void> {
  const log = (line: string) => {
    if (!res.writableEnded) res.write(line + "\n");
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    title: "DMCL",
    show: false,
    backgroundColor: "#f6f8f6",
    icon: path.join(
      __dirname,
      "assets",
      "brand",
      process.platform === "win32" ? "dmcl-app-icon.ico" : "dmcl-app-icon-256.png",
    ),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-bridge.js"),
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.once("ready-to-show", () => mainWindow?.show());

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
    void packagedProjectsRoot()
      .then(async (projectsRoot) => {
        await initWorkspace(repoRoot, projectsRoot);
        await resumeVariantBatchJobs();
      })
      .catch(async (err) => {
        console.warn("packagedProjectsRoot failed, falling back to dev layout:", err);
        await initWorkspace(repoRoot, undefined);
        await resumeVariantBatchJobs();
      });
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
