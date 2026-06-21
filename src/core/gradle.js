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
exports.CLIENT_FAIL = exports.CLIENT_SUCCESS = void 0;
exports.summarizeFabricIncompatibleModsError = summarizeFabricIncompatibleModsError;
exports.readJavaHomeFromProject = readJavaHomeFromProject;
exports.getIsolatedGradleHome = getIsolatedGradleHome;
exports.buildGradleEnv = buildGradleEnv;
exports.gradlewPath = gradlewPath;
exports.hasGradlew = hasGradlew;
exports.ensureGradlewExecutable = ensureGradlewExecutable;
exports.gradleSpawn = gradleSpawn;
exports.killProcessTree = killProcessTree;
exports.attachLineStream = attachLineStream;
exports.shouldEmitGradleLine = shouldEmitGradleLine;
exports.runGradleTask = runGradleTask;
exports.runGradleBuildTask = runGradleBuildTask;
exports.findClientLatestLogs = findClientLatestLogs;
exports.runGradleClientTask = runGradleClientTask;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const dmcl_home_js_1 = require("./dmcl-home.js");
exports.CLIENT_SUCCESS = [
    /Sound engine started/i,
    /OpenGL Version/i,
    /Created: \d+x\d+.*atlas/i,
];
exports.CLIENT_FAIL = [
    /---- Minecraft Crash Report ----/,
    /Process 'command 'runClient'' finished with non-zero/i,
    /BUILD FAILED/i,
    /Incompatible mods found/i,
    /FormattedException.*incompatible/i,
    /有不兼容的模组/i,
];
/** 从 Fabric Loader 日志提取「模组不兼容」的简短说明 */
function summarizeFabricIncompatibleModsError(log) {
    if (!/Incompatible mods found|有不兼容的模组/i.test(log))
        return null;
    const installedMc = log.match(/已经安装了的版本\s+([^\s！!]+)/)?.[1]
        ?? log.match(/found (?:version )?([\d.]+)/i)?.[1];
    const fabricApi = log.match(/模组 'Fabric API' \(fabric\)\s+(\S+)/)?.[1]
        ?? log.match(/'Fabric API' \(fabric\)\s+(\S+)/)?.[1];
    const requiredMc = log.match(/需要 'Minecraft' \(minecraft\) 的\s+([^\n]+)/)?.[1]
        ?? log.match(/requires (?:'Minecraft'|minecraft)[^\n]*?([\d.]+(?:\s*to\s*[\d.-]+)?)/i)?.[1];
    if (fabricApi && installedMc) {
        let summary = `Fabric API ${fabricApi} 与 Minecraft ${installedMc} 不兼容。`;
        if (requiredMc)
            summary += ` Fabric API 需要 MC ${requiredMc.trim()}。`;
        summary += " DMCL 会在启动客户端前自动修正 Fabric API 版本；若仍失败，请在设置中重新生成或手动执行 gradlew build。";
        return summary;
    }
    return "检测到 Fabric 模组依赖冲突（Incompatible mods）。请检查 Fabric API 与 Minecraft 版本是否匹配。";
}
/** 读取项目 gradle.properties 中的 org.gradle.java.home */
function readJavaHomeFromProject(targetDir) {
    try {
        const propsFile = node_path_1.default.join(targetDir, "gradle.properties");
        if (!node_fs_1.default.existsSync(propsFile))
            return null;
        const content = node_fs_1.default.readFileSync(propsFile, "utf8");
        const m = content.match(/^[ \t]*org\.gradle\.java\.home[ \t]*=[ \t]*(.+)$/m);
        if (!m)
            return null;
        return m[1].trim().replace(/\\\\/g, "\\").replace(/\\:/g, ":");
    }
    catch {
        return null;
    }
}
/** 独立 Gradle 用户目录，避免用户全局 init.d 脚本破坏旧版 Gradle。 */
function getIsolatedGradleHome() {
    const dir = node_path_1.default.join((0, dmcl_home_js_1.getDmclHome)(), "cache", "gradle");
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function buildGradleEnv(targetDir) {
    const env = { ...process.env };
    env.GRADLE_USER_HOME = getIsolatedGradleHome();
    (0, dmcl_home_js_1.ensureDmclHome)();
    const javaHome = readJavaHomeFromProject(targetDir);
    if (javaHome) {
        env.JAVA_HOME = javaHome;
        const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
        env[pathKey] = `${node_path_1.default.join(javaHome, "bin")};${env[pathKey] ?? ""}`;
    }
    return env;
}
function gradlewPath(targetDir) {
    const isWin = process.platform === "win32";
    return node_path_1.default.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
}
function hasGradlew(targetDir) {
    return node_fs_1.default.existsSync(gradlewPath(targetDir));
}
async function ensureGradlewExecutable(targetDir) {
    if (process.platform === "win32")
        return;
    const gradlew = node_path_1.default.join(targetDir, "gradlew");
    if (!node_fs_1.default.existsSync(gradlew))
        return;
    try {
        await node_fs_1.default.promises.chmod(gradlew, 0o755);
    }
    catch { /* ignore */ }
}
function gradleSpawn(targetDir, tasks, envOverrides) {
    const isWin = process.platform === "win32";
    const cmd = isWin
        ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
        : "./gradlew";
    const cmdArgs = isWin ? ["/c", "gradlew.bat", ...tasks] : tasks;
    const proc = (0, node_child_process_1.spawn)(cmd, cmdArgs, {
        cwd: targetDir,
        env: { ...buildGradleEnv(targetDir), ...envOverrides },
        stdio: ["ignore", "pipe", "pipe"],
    });
    return { proc, isWin };
}
function killProcessTree(proc, isWin) {
    if (!proc.pid || proc.killed)
        return;
    try {
        if (isWin) {
            (0, node_child_process_1.spawn)("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        }
        else {
            proc.kill("SIGTERM");
        }
    }
    catch { /* ignore */ }
}
function attachLineStream(proc, onLine) {
    const attach = (stream) => {
        if (!stream)
            return;
        let pending = "";
        stream.on("data", (data) => {
            pending += data.toString();
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
                const complete = line.endsWith("\r") ? line.slice(0, -1) : line;
                if (complete.length > 0)
                    onLine(complete);
            }
        });
        stream.on("end", () => {
            const complete = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
            if (complete.length > 0)
                onLine(complete);
            pending = "";
        });
    };
    attach(proc.stdout);
    attach(proc.stderr);
}
function shouldEmitGradleLine(line) {
    return (line.startsWith(">") ||
        line.includes("Launching") ||
        line.includes("Running") ||
        line.includes("Download") ||
        line.includes("download") ||
        line.includes("BUILD") ||
        line.includes("FAILURE") ||
        line.includes("Exception") ||
        line.includes("Error") ||
        line.includes("Caused by") ||
        line.includes("Could not") ||
        line.includes("Cannot") ||
        line.includes("Failed to") ||
        line.includes("Mavenizer") ||
        line.includes("mavenizer") ||
        line.includes("Slime Launcher") ||
        line.includes("Checking assets") ||
        line.includes("Processing Minecraft") ||
        line.includes("Cache miss") ||
        line.includes("HTTP") ||
        line.includes("timeout") ||
        line.includes("timed out") ||
        line.includes("DownloadUtils") ||
        /^\d+%/.test(line) ||
        line.includes("FAILED"));
}
function cancelledCode(opts) {
    return opts?.isCancelled?.() ? 1 : null;
}
async function runGradleTask(targetDir, tasks, onLine, opts) {
    if (!hasGradlew(targetDir))
        return 1;
    await ensureGradlewExecutable(targetDir);
    if (cancelledCode(opts) !== null)
        return 1;
    const { proc, isWin } = gradleSpawn(targetDir, tasks, opts?.env);
    opts?.onProc?.(proc, isWin);
    attachLineStream(proc, onLine);
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const done = (code) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(code);
        };
        if (opts?.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => {
                killProcessTree(proc, isWin);
                done(124);
            }, opts.timeoutMs);
            timer.unref?.();
        }
        proc.on("close", (code) => {
            if (opts?.isCancelled?.()) {
                done(1);
                return;
            }
            done(code ?? 1);
        });
        proc.on("error", () => done(1));
    });
}
/** gradlew build --no-daemon */
async function runGradleBuildTask(targetDir, onLine, opts) {
    return runGradleTask(targetDir, opts?.tasks ?? ["build", "--no-daemon"], onLine, opts);
}
function findClientLatestLogs(targetDir) {
    const found = new Set();
    const visit = (dir, depth) => {
        if (depth > 3)
            return;
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = node_path_1.default.join(dir, entry.name);
            if (entry.isDirectory())
                visit(full, depth + 1);
            else if (entry.name === "latest.log" && node_path_1.default.basename(node_path_1.default.dirname(full)) === "logs") {
                found.add(full);
            }
        }
    };
    for (const rootName of ["run", "runs"]) {
        const runDir = node_path_1.default.join(targetDir, rootName);
        visit(runDir, 0);
        found.add(node_path_1.default.join(runDir, "logs", "latest.log"));
        found.add(node_path_1.default.join(runDir, "client", "logs", "latest.log"));
    }
    return [...found];
}
/** gradlew runClient --no-daemon，支持验证模式与交互模式 */
async function runGradleClientTask(targetDir, onLine, opts) {
    if (!hasGradlew(targetDir))
        return 1;
    await ensureGradlewExecutable(targetDir);
    if (cancelledCode(opts) !== null)
        return 1;
    try {
        const { ensureFabricApiVersion } = await Promise.resolve().then(() => __importStar(require("../loaders/fabric-toolchain.js")));
        await ensureFabricApiVersion(targetDir, onLine);
    }
    catch {
        // 修正失败不阻断启动，由 Loader 报错后再提示
    }
    const startedAt = Date.now();
    const logBaselines = new Map();
    for (const logPath of findClientLatestLogs(targetDir)) {
        logBaselines.set(logPath, node_fs_1.default.existsSync(logPath) ? node_fs_1.default.statSync(logPath).size : 0);
    }
    const { proc, isWin } = gradleSpawn(targetDir, ["runClient", "--no-daemon"]);
    opts.onProc?.(proc, isWin);
    const timeoutMs = opts.mode === "verify" ? 10 * 60 * 1000 : 60 * 60 * 1000;
    let settled = false;
    let verified = false;
    let sawGameLaunch = false;
    let pendingSuccessTimer = null;
    let pollTimer = null;
    let timeoutTimer = null;
    const cleanup = () => {
        if (pollTimer)
            clearInterval(pollTimer);
        if (timeoutTimer)
            clearTimeout(timeoutTimer);
        if (pendingSuccessTimer)
            clearTimeout(pendingSuccessTimer);
        pollTimer = null;
        timeoutTimer = null;
        pendingSuccessTimer = null;
    };
    const readFreshLog = () => {
        const fresh = [];
        for (const logPath of findClientLatestLogs(targetDir)) {
            try {
                if (!node_fs_1.default.existsSync(logPath))
                    continue;
                const stat = node_fs_1.default.statSync(logPath);
                const baseline = logBaselines.get(logPath) ?? 0;
                if (stat.mtimeMs < startedAt - 3000 && stat.size <= baseline)
                    continue;
                const content = node_fs_1.default.readFileSync(logPath, "utf8");
                if (opts.mode === "verify" && stat.size <= baseline && !content.trim())
                    continue;
                fresh.push(content);
            }
            catch {
                // Log files may rotate while the client is starting.
            }
        }
        return fresh.length > 0 ? fresh.join("\n") : null;
    };
    return new Promise((resolve) => {
        const done = (code) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (opts.mode === "verify" && proc.pid && !proc.killed) {
                killProcessTree(proc, isWin);
            }
            if (opts.isCancelled?.()) {
                resolve(1);
                return;
            }
            if (opts.mode === "interactive") {
                const elapsed = Date.now() - startedAt;
                if (code === 0 && elapsed < 15000 && !sawGameLaunch) {
                    resolve(1);
                    return;
                }
            }
            resolve(code);
        };
        attachLineStream(proc, (line) => {
            onLine(line);
            if (/Launching Minecraft|Starting Minecraft|Running program|runClient/i.test(line)) {
                sawGameLaunch = true;
            }
            if (opts.mode === "verify" && exports.CLIENT_FAIL.some((p) => p.test(line)))
                done(1);
        });
        if (opts.mode === "verify") {
            pollTimer = setInterval(() => {
                if (settled || verified)
                    return;
                const content = readFreshLog();
                if (!content)
                    return;
                if (exports.CLIENT_FAIL.some((p) => p.test(content))) {
                    const summary = summarizeFabricIncompatibleModsError(content);
                    if (summary)
                        onLine(summary);
                    done(1);
                    return;
                }
                if (exports.CLIENT_SUCCESS.some((p) => p.test(content))) {
                    verified = true;
                    pendingSuccessTimer = setTimeout(() => done(0), 2500);
                }
            }, 2000);
        }
        timeoutTimer = setTimeout(() => {
            if (!settled) {
                if (opts.mode === "interactive")
                    killProcessTree(proc, isWin);
                done(1);
            }
        }, timeoutMs);
        proc.on("close", (code) => {
            if (settled)
                return;
            if (opts.mode === "verify" && verified) {
                done(0);
                return;
            }
            if (opts.mode === "verify") {
                const content = readFreshLog();
                if (content && exports.CLIENT_SUCCESS.some((p) => p.test(content))) {
                    done(0);
                    return;
                }
                const summary = content ? summarizeFabricIncompatibleModsError(content) : null;
                if (summary)
                    onLine(summary);
                done(code === 0 ? 1 : (code ?? 1));
                return;
            }
            done(code ?? 1);
        });
        proc.on("error", () => done(1));
    });
}
