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
exports.onBuildEvent = onBuildEvent;
exports.getQueueStatus = getQueueStatus;
exports.cancelBuildQueue = cancelBuildQueue;
exports.resetBuildQueueCancel = resetBuildQueueCancel;
exports.enqueueBuild = enqueueBuild;
exports.enqueueBatch = enqueueBatch;
exports.listLogs = listLogs;
exports.readLog = readLog;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
let queue = [];
let running = false;
let currentJob = null;
let cancelled = false;
let listeners = [];
function projectRoot() {
    return node_path_1.default.resolve(__dirname, "..");
}
function logsBaseDir() {
    return node_path_1.default.join(node_os_1.default.homedir(), ".dmcl", "logs");
}
async function updateVariantStatus(variantId, status) {
    try {
        const mod = await Promise.resolve(`${node_path_1.default.join(projectRoot(), "dist", "workspace", "store.js")}`).then(s => __importStar(require(s)));
        mod.getWorkspace().updateVariantBuildStatus(variantId, status);
    }
    catch { /* ignore */ }
}
function onBuildEvent(cb) {
    listeners.push(cb);
    return () => {
        listeners = listeners.filter((l) => l !== cb);
    };
}
function emit(event) {
    for (const cb of listeners)
        cb(event);
}
function getQueueStatus() {
    return { running, current: currentJob, pending: queue.length };
}
function cancelBuildQueue() {
    cancelled = true;
    queue.length = 0;
    void Promise.resolve().then(() => __importStar(require("./gradle-runner"))).then((m) => m.killCurrentRunner());
}
function resetBuildQueueCancel() {
    cancelled = false;
}
function enqueueBuild(job) {
    resetBuildQueueCancel();
    const entry = { ...job, id: (0, node_crypto_1.randomUUID)() };
    queue.push(entry);
    emit({ type: "queue", queueLength: queue.length });
    void processQueue();
    return entry.id;
}
function enqueueBatch(jobs) {
    return jobs.map((j) => enqueueBuild(j));
}
function saveLog(variantId, lines) {
    const dir = node_path_1.default.join(logsBaseDir(), variantId);
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const logPath = node_path_1.default.join(dir, `${Date.now()}-${(0, node_crypto_1.randomUUID)()}.log`);
    node_fs_1.default.writeFileSync(logPath, lines.join("\n"), "utf8");
    return logPath;
}
function listLogs(variantId) {
    const dir = node_path_1.default.join(logsBaseDir(), variantId);
    if (!node_fs_1.default.existsSync(dir))
        return [];
    return node_fs_1.default.readdirSync(dir)
        .filter((f) => f.endsWith(".log"))
        .map((name) => {
        const p = node_path_1.default.join(dir, name);
        return { name, path: p, mtime: node_fs_1.default.statSync(p).mtimeMs };
    })
        .sort((a, b) => b.mtime - a.mtime);
}
function readLog(logPath) {
    const resolved = node_path_1.default.resolve(logPath);
    const base = node_path_1.default.resolve(logsBaseDir());
    if (!resolved.startsWith(base + node_path_1.default.sep))
        return "";
    if (!node_fs_1.default.existsSync(resolved))
        return "";
    return node_fs_1.default.readFileSync(resolved, "utf8");
}
async function processQueue() {
    if (running)
        return;
    running = true;
    while (queue.length > 0 && !cancelled) {
        const job = queue.shift();
        currentJob = job;
        emit({ type: "start", job });
        const lines = [];
        const logLine = (line) => {
            lines.push(line);
            emit({ type: "progress", job, line });
        };
        let success = false;
        try {
            const { runBuildOnly, runClientOnly } = await Promise.resolve().then(() => __importStar(require("./gradle-runner")));
            if (job.type === "build" || job.type === "build+run") {
                const code = await runBuildOnly(job.projectPath, logLine);
                if (code !== 0) {
                    success = false;
                }
                else if (job.type === "build") {
                    success = true;
                }
                else {
                    const clientCode = await runClientOnly(job.projectPath, logLine);
                    success = clientCode === 0;
                }
            }
            else {
                const code = await runClientOnly(job.projectPath, logLine);
                success = code === 0;
            }
        }
        catch (err) {
            logLine(`错误：${err.message}`);
            success = false;
        }
        if (cancelled)
            success = false;
        saveLog(job.variantId, lines);
        await updateVariantStatus(job.variantId, success ? "success" : "failed");
        emit({ type: "done", job, success });
        currentJob = null;
    }
    running = false;
}
