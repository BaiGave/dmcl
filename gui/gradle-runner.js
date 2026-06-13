"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.killCurrentRunner = killCurrentRunner;
exports.setRunnerCancelled = setRunnerCancelled;
exports.runBuildOnly = runBuildOnly;
exports.runClientOnly = runClientOnly;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const gradle_1 = require("./gradle");
let verificationCancelled = false;
let currentProc = null;
let currentIsWin = false;
function killCurrentRunner() {
    verificationCancelled = true;
    if (currentProc) {
        (0, gradle_1.killProcessTree)(currentProc, currentIsWin);
        currentProc = null;
    }
}
function setRunnerCancelled(cancelled) {
    verificationCancelled = cancelled;
}
const CLIENT_SUCCESS = [
    /Sound engine started/i,
    /OpenGL Version/i,
    /Created: \d+x\d+.*atlas/i,
];
const CLIENT_FAIL = [
    /---- Minecraft Crash Report ----/,
    /Process 'command 'runClient'' finished with non-zero/i,
    /BUILD FAILED/i,
];
function streamProc(proc, onLine) {
    const emit = (data) => {
        for (const line of data.toString("utf8").split("\n")) {
            const trimmed = line.trim();
            if (trimmed)
                onLine(trimmed);
        }
    };
    proc.stdout?.on("data", emit);
    proc.stderr?.on("data", emit);
}
function runBuildOnly(targetDir, log) {
    const isWin = process.platform === "win32";
    const gradlew = node_path_1.default.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
    if (!node_fs_1.default.existsSync(gradlew)) {
        log("未找到 gradlew");
        return Promise.resolve(1);
    }
    log("正在构建（gradlew build）…");
    const { proc } = (0, gradle_1.gradleSpawn)(targetDir, ["build", "--no-daemon"]);
    currentProc = proc;
    currentIsWin = process.platform === "win32";
    streamProc(proc, log);
    return new Promise((resolve) => {
        proc.on("close", (code) => {
            currentProc = null;
            if (verificationCancelled) {
                log("已取消");
                resolve(1);
                return;
            }
            if (code === 0)
                log("✔ 构建成功");
            else
                log(`构建失败（退出码 ${code}）`);
            resolve(code ?? 1);
        });
        proc.on("error", (err) => {
            log(`构建启动失败: ${err.message}`);
            resolve(1);
        });
    });
}
function runClientOnly(targetDir, log) {
    const isWin = process.platform === "win32";
    const gradlew = node_path_1.default.join(targetDir, isWin ? "gradlew.bat" : "gradlew");
    if (!node_fs_1.default.existsSync(gradlew)) {
        log("未找到 gradlew");
        return Promise.resolve(1);
    }
    log("正在启动 Minecraft 客户端…");
    const { proc, isWin: win } = (0, gradle_1.gradleSpawn)(targetDir, ["runClient", "--no-daemon"]);
    currentProc = proc;
    currentIsWin = win;
    const logPath = node_path_1.default.join(targetDir, "run", "logs", "latest.log");
    const CLIENT_TIMEOUT_MS = 10 * 60 * 1000;
    let finished = false;
    let verified = false;
    const finish = (code) => {
        if (finished)
            return code;
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        if (pendingSuccessTimer)
            clearTimeout(pendingSuccessTimer);
        currentProc = null;
        (0, gradle_1.killProcessTree)(proc, win);
        if (verificationCancelled) {
            log("已取消");
            return 1;
        }
        if (code === 0)
            log("✔ 客户端验证通过");
        else
            log("客户端验证失败");
        return code;
    };
    streamProc(proc, (line) => {
        log(line);
        if (CLIENT_FAIL.some((p) => p.test(line)))
            finish(1);
    });
    let pendingSuccessTimer = null;
    const pollTimer = setInterval(() => {
        if (finished || verified)
            return;
        try {
            if (!node_fs_1.default.existsSync(logPath))
                return;
            const content = node_fs_1.default.readFileSync(logPath, "utf8");
            if (CLIENT_FAIL.some((p) => p.test(content))) {
                log("检测到游戏崩溃");
                finish(1);
                return;
            }
            if (CLIENT_SUCCESS.some((p) => p.test(content))) {
                verified = true;
                log("✔ Minecraft 客户端已成功加载，正在关闭…");
                pendingSuccessTimer = setTimeout(() => finish(0), 2500);
            }
        }
        catch { /* ignore */ }
    }, 2000);
    const timeoutTimer = setTimeout(() => {
        if (!finished) {
            log("客户端验证超时（10 分钟）");
            finish(1);
        }
    }, CLIENT_TIMEOUT_MS);
    return new Promise((resolve) => {
        proc.on("close", (code) => {
            if (finished)
                return;
            if (verified) {
                resolve(finish(0));
                return;
            }
            try {
                if (node_fs_1.default.existsSync(logPath) && CLIENT_SUCCESS.some((p) => p.test(node_fs_1.default.readFileSync(logPath, "utf8")))) {
                    resolve(finish(0));
                    return;
                }
            }
            catch { /* ignore */ }
            resolve(finish(code === 0 ? 1 : (code ?? 1)));
        });
        proc.on("error", (err) => {
            log(`客户端启动失败: ${err.message}`);
            resolve(finish(1));
        });
    });
}
