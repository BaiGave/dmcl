"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.variantJobLabel = variantJobLabel;
exports.setRunnerPoolForTests = setRunnerPoolForTests;
exports.resetBuildQueueForTests = resetBuildQueueForTests;
exports.onBuildEvent = onBuildEvent;
exports.mergeBuildJobType = mergeBuildJobType;
exports.isVariantQueued = isVariantQueued;
exports.getQueueStatus = getQueueStatus;
exports.cancelBuildQueue = cancelBuildQueue;
exports.enqueueBuild = enqueueBuild;
exports.enqueueBatch = enqueueBatch;
exports.saveVariantBuildLog = saveVariantBuildLog;
exports.appendVariantLiveLog = appendVariantLiveLog;
exports.clearVariantLiveLog = clearVariantLiveLog;
exports.getVariantBuildLogContent = getVariantBuildLogContent;
exports.listLogs = listLogs;
exports.readLog = readLog;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const dist_loader_1 = require("./dist-loader");
const gradle_runner_1 = require("./gradle-runner");
const concurrency_governor_1 = require("./concurrency-governor");
function variantLogsDir(projectPath) {
    return node_path_1.default.join(node_path_1.default.resolve(projectPath), ".dmcl", "logs");
}
function isLoaderId(value) {
    return value === "fabric" || value === "forge" || value === "neoforge";
}
function variantJobLabel(job) {
    if (job.loader && job.mcVersion)
        return `${job.loader} ${job.mcVersion}`;
    return "变体";
}
let queue = [];
let activeJobs = new Map();
let slotBusy = [];
let processorPromise = null;
let cancelled = false;
/** 已被 cancelBuildQueue 收尾的任务，executeJob 不再重复 emit done */
const cancelledJobIds = new Set();
let listeners = [];
let testRunnerPoolOverride = null;
/** @internal 测试专用：注入 mock runner 池 */
function setRunnerPoolForTests(pool) {
    testRunnerPoolOverride = pool;
}
/** @internal 测试专用：重置队列模块状态 */
function resetBuildQueueForTests() {
    queue = [];
    activeJobs.clear();
    slotBusy = [];
    processorPromise = null;
    cancelled = false;
    cancelledJobIds.clear();
    listeners = [];
    testRunnerPoolOverride = null;
}
function poolForProcessor() {
    return testRunnerPoolOverride ?? (0, gradle_runner_1.getRunnerPool)();
}
function cancelProcessorRunners() {
    const pool = poolForProcessor();
    void Promise.all(pool.map((runner) => runner.cancel()));
    pool.forEach((runner, index) => {
        if (!slotBusy[index])
            runner.reset();
    });
}
const concurrencyInfo = () => (0, gradle_runner_1.getBuildConcurrencyInfo)();
async function updateVariantStatus(variantId, status) {
    try {
        const mod = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "store.js"));
        mod.getWorkspace().updateVariantBuildStatus(variantId, status);
    }
    catch { /* ignore */ }
}
function summarizeFailure(lines) {
    const text = lines.join("\n");
    if (/JDK 准备失败|org\.gradle\.java\.home|需要 Java \d+|incompatibleReason/i.test(text)) {
        const jdk = [...lines].reverse().find((line) => /JDK|Java \d+|org\.gradle\.java\.home/i.test(line));
        if (jdk)
            return jdk.slice(0, 240);
    }
    if (/Timeout waiting to lock|Could not acquire lock|Gradle build daemon|文件锁|file lock/i.test(text)) {
        return "Gradle 缓存文件锁争用（大批量并行构建时常见，可在设置中降低「Gradle 构建并发」后重试）";
    }
    if (/OutOfMemoryError|GC overhead|内存不足|insufficient memory/i.test(text)) {
        return "构建进程内存不足（大批量并行时常见，请降低 Gradle 构建并发或任务槽位数）";
    }
    const hit = [...lines].reverse().find((line) => /BUILD FAILED|FAILURE|Exception|Error|Cannot|Could not/i.test(line));
    return hit ? hit.slice(0, 240) : undefined;
}
async function recordBuildVerification(job, result) {
    if (!isLoaderId(job.loader) || !job.mcVersion)
        return;
    try {
        const workspace = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "index.js"));
        workspace.recordVersionVerification({
            loader: job.loader,
            mcVersion: job.mcVersion,
            jobType: job.type,
            variantId: job.variantId,
            projectPath: job.projectPath,
            buildSuccess: result.buildSuccess,
            clientSuccess: result.clientSuccess,
            failureSummary: result.failureSummary,
        });
        workspace.invalidateMatrixCache();
    }
    catch {
        // Verification indexing must not break the build queue.
    }
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
const JOB_TYPE_RANK = {
    build: 1,
    run: 2,
    "build+run": 3,
};
/** 合并同一变体的构建意图：build+run ⊃ run ⊃ build */
function mergeBuildJobType(existing, incoming) {
    return JOB_TYPE_RANK[incoming] >= JOB_TYPE_RANK[existing] ? incoming : existing;
}
function findActiveJobByVariant(variantId) {
    for (const job of activeJobs.values()) {
        if (job.variantId === variantId)
            return job;
    }
    return undefined;
}
function findQueuedJobByVariant(variantId) {
    return queue.find((job) => job.variantId === variantId);
}
function applyJobFields(target, source) {
    target.projectPath = source.projectPath;
    target.loader = source.loader;
    target.mcVersion = source.mcVersion;
}
function resumeQueueAfterEnqueue() {
    cancelled = false;
    if (activeJobs.size === 0) {
        cancelledJobIds.clear();
    }
    ensureProcessor();
}
function activeJobList() {
    return [...activeJobs.values()];
}
function isVariantQueued(variantId) {
    const active = findActiveJobByVariant(variantId);
    if (active && !cancelledJobIds.has(active.id))
        return true;
    return queue.some((j) => j.variantId === variantId);
}
function getQueueStatus() {
    const active = activeJobs.size;
    const pending = queue.length;
    const total = active + pending;
    const activeList = activeJobList();
    const current = activeList[0] ?? null;
    let currentLabel = null;
    if (activeList.length === 1) {
        currentLabel = variantJobLabel(activeList[0]);
    }
    else if (activeList.length > 1) {
        currentLabel = `${activeList.length} 个变体`;
    }
    const governor = (0, concurrency_governor_1.getGovernorStatus)();
    return {
        running: processorPromise !== null || active > 0 || (pending > 0 && !cancelled),
        current,
        currentLabel,
        pending,
        active,
        maxConcurrency: governor.gradleBuildMax,
        gradleBuildActive: governor.gradleBuildActive,
        gradleBuildMax: governor.gradleBuildMax,
        clientActive: governor.clientActive,
        clientMax: governor.clientMax,
        jobSlots: governor.jobSlots,
        physicalCores: concurrencyInfo().physicalCores,
        logicalCores: concurrencyInfo().logicalCores,
        total,
        position: total > 0 ? total : null,
    };
}
function finalizeCancelledJob(job) {
    if (cancelledJobIds.has(job.id))
        return;
    cancelledJobIds.add(job.id);
    emit({ type: "cancelled", job });
    emit({ type: "done", job, success: false });
    void updateVariantStatus(job.variantId, "failed");
}
function cancelBuildQueue() {
    cancelled = true;
    const queuedVariantIds = queue.map((j) => j.variantId);
    queue.length = 0;
    cancelProcessorRunners();
    for (const job of activeJobs.values()) {
        finalizeCancelledJob(job);
    }
    for (const variantId of queuedVariantIds) {
        void updateVariantStatus(variantId, "unknown");
    }
}
function enqueueBuild(job) {
    const activeJob = findActiveJobByVariant(job.variantId);
    if (activeJob && !cancelledJobIds.has(activeJob.id)) {
        const mergedType = mergeBuildJobType(activeJob.type, job.type);
        if (mergedType !== activeJob.type) {
            activeJob.type = mergedType;
            applyJobFields(activeJob, job);
        }
        resumeQueueAfterEnqueue();
        return activeJob.id;
    }
    const existing = findQueuedJobByVariant(job.variantId);
    if (existing) {
        const mergedType = mergeBuildJobType(existing.type, job.type);
        if (mergedType !== existing.type) {
            existing.type = mergedType;
        }
        applyJobFields(existing, job);
        resumeQueueAfterEnqueue();
        return existing.id;
    }
    const entry = { ...job, id: (0, node_crypto_1.randomUUID)() };
    queue.push(entry);
    emit({ type: "queue", queueLength: queue.length });
    resumeQueueAfterEnqueue();
    return entry.id;
}
function enqueueBatch(jobs) {
    return jobs.map((j) => enqueueBuild(j));
}
function saveLog(projectPath, lines) {
    if (lines.length === 0)
        return null;
    const dir = variantLogsDir(projectPath);
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const logPath = node_path_1.default.join(dir, `${Date.now()}-${(0, node_crypto_1.randomUUID)()}.log`);
    node_fs_1.default.writeFileSync(logPath, lines.join("\n"), "utf8");
    return logPath;
}
/** 供批任务 / 外部验证写入构建日志 */
function saveVariantBuildLog(projectPath, lines) {
    return saveLog(projectPath, lines);
}
const liveLogsByVariant = new Map();
function appendLiveLog(variantId, line) {
    let buf = liveLogsByVariant.get(variantId);
    if (!buf) {
        buf = [];
        liveLogsByVariant.set(variantId, buf);
    }
    buf.push(line);
    if (buf.length > 4000)
        buf.splice(0, buf.length - 4000);
}
function clearLiveLog(variantId) {
    liveLogsByVariant.delete(variantId);
}
/** 批任务 / 外部流程写入实时日志缓冲 */
function appendVariantLiveLog(variantId, line) {
    appendLiveLog(variantId, line);
}
function clearVariantLiveLog(variantId) {
    clearLiveLog(variantId);
}
function tailFile(filePath, maxLines = 300) {
    if (!node_fs_1.default.existsSync(filePath))
        return null;
    try {
        const text = node_fs_1.default.readFileSync(filePath, "utf8");
        const lines = text.split(/\r?\n/);
        return lines.slice(-maxLines).join("\n");
    }
    catch {
        return null;
    }
}
function extractProblemsReportText(filePath) {
    if (!node_fs_1.default.existsSync(filePath))
        return null;
    try {
        const html = node_fs_1.default.readFileSync(filePath, "utf8");
        const stripped = html
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        if (!stripped)
            return null;
        const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);
        const tail = lines.slice(-120).join("\n");
        return tail.length > 8000 ? tail.slice(-8000) : tail;
    }
    catch {
        return null;
    }
}
function findGradleFallbackLogs(projectPath) {
    const resolved = node_path_1.default.resolve(projectPath);
    const out = [];
    const textLogs = [
        { label: "run/logs/latest.log", file: node_path_1.default.join(resolved, "run", "logs", "latest.log") },
        { label: "runs/client/logs/latest.log", file: node_path_1.default.join(resolved, "runs", "client", "logs", "latest.log") },
    ];
    for (const c of textLogs) {
        const content = tailFile(c.file);
        if (content?.trim())
            out.push({ label: c.label, content });
    }
    const problemsFile = node_path_1.default.join(resolved, "build", "reports", "problems", "problems-report.html");
    const problemsText = extractProblemsReportText(problemsFile);
    if (problemsText) {
        out.push({ label: "Gradle problems-report（摘要）", content: problemsText });
    }
    return out;
}
async function getVariantBuildLogContent(variantId) {
    const live = liveLogsByVariant.get(variantId);
    if (live?.length) {
        return {
            content: live.join("\n"),
            source: "live",
            hint: "任务进行中，显示实时输出",
        };
    }
    const files = await listLogs(variantId);
    let readFailure;
    for (const file of files) {
        const content = await readLog(file.path, variantId);
        if (content) {
            return { content, source: "saved", fileName: file.name };
        }
        readFailure = file.path;
    }
    if (files.length > 0) {
        return {
            content: "",
            source: "none",
            hint: `找到 ${files.length} 个日志文件但无法读取${readFailure ? "：" + readFailure : ""}。请检查文件权限或路径是否有效。`,
        };
    }
    const projectPath = await resolveProjectPath(variantId);
    if (projectPath) {
        const fallbacks = findGradleFallbackLogs(projectPath);
        if (fallbacks.length > 0) {
            const combined = fallbacks.map((f) => `===== ${f.label} =====\n${f.content}`).join("\n\n");
            return { content: combined, source: "fallback", fileName: fallbacks[0].label };
        }
        const logDir = variantLogsDir(projectPath);
        return {
            content: "",
            source: "none",
            hint: `暂无构建日志。完成一次构建后日志会保存到：\n${logDir}`,
        };
    }
    return { content: "", source: "none", hint: "未找到该变体项目路径" };
}
async function resolveProjectPath(variantId) {
    try {
        const mod = await (0, dist_loader_1.loadDist)((0, dist_loader_1.repoDist)("workspace", "store.js"));
        const found = mod.getWorkspace().getVariant(variantId);
        return found?.variant.projectPath ?? null;
    }
    catch {
        return null;
    }
}
async function listLogs(variantId) {
    const projectPath = await resolveProjectPath(variantId);
    if (!projectPath)
        return [];
    const dir = variantLogsDir(projectPath);
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
function isPathUnderDir(resolved, dir) {
    const base = node_path_1.default.resolve(dir);
    const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    const r = norm(resolved);
    const b = norm(base);
    return r === b || r.startsWith(b + node_path_1.default.sep);
}
async function readLog(logPath, variantId) {
    const resolved = node_path_1.default.resolve(logPath);
    const projectPath = await resolveProjectPath(variantId);
    if (!projectPath)
        return "";
    const allowedDir = variantLogsDir(projectPath);
    if (!isPathUnderDir(resolved, allowedDir))
        return "";
    if (!node_fs_1.default.existsSync(resolved))
        return "";
    return node_fs_1.default.readFileSync(resolved, "utf8");
}
async function executeJob(job, runner) {
    const lines = [];
    clearLiveLog(job.variantId);
    const logLine = (line) => {
        lines.push(line);
        appendLiveLog(job.variantId, line);
        emit({ type: "progress", job, line });
    };
    let success = false;
    let buildSuccess;
    let clientSuccess;
    try {
        if (job.type === "build" || job.type === "build+run") {
            const code = await runner.runBuildOnly(job.projectPath, logLine);
            buildSuccess = code === 0;
            if (code !== 0) {
                success = false;
            }
            else if (job.type === "build") {
                success = true;
            }
            else if (!cancelled && !runner.isCancelled()) {
                const clientCode = await runner.runClientOnly(job.projectPath, logLine);
                clientSuccess = clientCode === 0;
                success = clientSuccess;
            }
        }
        else if (!cancelled && !runner.isCancelled()) {
            const code = await runner.runClientInteractive(job.projectPath, logLine);
            clientSuccess = code === 0;
            success = clientSuccess;
        }
    }
    catch (err) {
        logLine(`错误：${err.message}`);
        success = false;
    }
    saveLog(job.projectPath, lines);
    clearLiveLog(job.variantId);
    const alreadyFinalized = cancelledJobIds.has(job.id);
    if (!alreadyFinalized) {
        if (cancelled || runner.isCancelled())
            success = false;
        await recordBuildVerification(job, {
            buildSuccess,
            clientSuccess,
            failureSummary: success ? undefined : summarizeFailure(lines),
        });
        await updateVariantStatus(job.variantId, success ? "success" : "failed");
        emit({ type: "done", job, success });
    }
    runner.reset();
}
function ensureProcessor() {
    if (processorPromise)
        return;
    processorPromise = runProcessor().finally(() => {
        processorPromise = null;
        if (queue.length > 0 && !cancelled) {
            ensureProcessor();
        }
    });
}
async function runProcessor() {
    const pool = poolForProcessor();
    if (slotBusy.length !== pool.length) {
        slotBusy = Array.from({ length: pool.length }, () => false);
    }
    const inFlight = new Map();
    const startJobs = () => {
        if (cancelled)
            return;
        for (let slot = 0; slot < pool.length; slot++) {
            if (slotBusy[slot] || queue.length === 0)
                continue;
            const index = queue.findIndex((candidate) => !findActiveJobByVariant(candidate.variantId));
            if (index < 0)
                continue;
            const job = queue.splice(index, 1)[0];
            const runner = pool[slot];
            slotBusy[slot] = true;
            activeJobs.set(job.id, job);
            emit({ type: "start", job });
            const jobPromise = executeJob(job, runner).finally(() => {
                slotBusy[slot] = false;
                activeJobs.delete(job.id);
                inFlight.delete(job.id);
                startJobs();
            });
            inFlight.set(job.id, jobPromise);
        }
    };
    startJobs();
    while (inFlight.size > 0) {
        await Promise.race(inFlight.values());
        startJobs();
    }
}
