"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBuildConcurrency = getBuildConcurrency;
exports.getBuildConcurrencyInfo = getBuildConcurrencyInfo;
exports.resetRunnerPool = resetRunnerPool;
exports.getRunnerPool = getRunnerPool;
exports.cancelAllRunners = cancelAllRunners;
exports.resetAllRunners = resetAllRunners;
exports.createGradleRunner = createGradleRunner;
const concurrency_governor_1 = require("./concurrency-governor");
const gradle_core_bridge_1 = require("./gradle-core-bridge");
const gradle_1 = require("./gradle");
function getBuildConcurrency() {
    return (0, concurrency_governor_1.getConcurrencyLimits)().jobSlots;
}
function getBuildConcurrencyInfo() {
    return (0, concurrency_governor_1.getConcurrencyLimits)();
}
let runnerPool = null;
function resetRunnerPool() {
    const previous = runnerPool;
    runnerPool = null;
    if (previous) {
        void Promise.all(previous.map((runner) => runner.cancel()));
    }
}
function getRunnerPool() {
    const size = getBuildConcurrency();
    if (!runnerPool || runnerPool.length !== size) {
        if (runnerPool) {
            void Promise.all(runnerPool.map((runner) => runner.cancel()));
        }
        runnerPool = Array.from({ length: size }, () => createGradleRunner());
    }
    return runnerPool;
}
async function cancelAllRunners() {
    await Promise.all(getRunnerPool().map((runner) => runner.cancel()));
}
function resetAllRunners() {
    for (const runner of getRunnerPool())
        runner.reset();
}
function createGradleRunner() {
    let cancelled = false;
    let currentProc = null;
    let currentIsWin = false;
    const trackProc = (proc, isWin) => {
        currentProc = proc;
        currentIsWin = isWin;
    };
    const clearProc = (proc) => {
        if (currentProc === proc)
            currentProc = null;
    };
    const prepareProjectJdk = async (targetDir, log) => {
        if (cancelled)
            return false;
        const jdk = await (0, gradle_core_bridge_1.getProjectJdk)();
        return jdk.prepareProjectJdk(targetDir, log, { isCancelled: () => cancelled });
    };
    const runBuildOnly = async (targetDir, log) => (0, concurrency_governor_1.withGradleBuildSlot)(async () => {
        const core = await (0, gradle_core_bridge_1.getGradleCore)();
        if (!core.hasGradlew(targetDir)) {
            log("未找到 gradlew，请确认项目目录有效");
            return 1;
        }
        if (!(await prepareProjectJdk(targetDir, log)) || cancelled) {
            log("已取消");
            return 1;
        }
        log(`正在构建（gradlew build，Gradle 并发 ${(0, concurrency_governor_1.getConcurrencyLimits)().gradleBuildConcurrency} 路 · 槽内单 Worker）…`);
        let tracked = null;
        const code = await core.runGradleBuildTask(targetDir, log, {
            tasks: ["build", "--no-daemon", "--max-workers=1"],
            isCancelled: () => cancelled,
            onProc: (proc, isWin) => { tracked = proc; trackProc(proc, isWin); },
        });
        clearProc(tracked);
        if (cancelled) {
            log("已取消");
            return 1;
        }
        if (code === 0)
            log("✔ 构建成功");
        else
            log(`构建失败（退出码 ${code}）`);
        return code;
    });
    const runClientInternal = async (targetDir, log, mode) => (0, concurrency_governor_1.withClientSlot)(async () => {
        const core = await (0, gradle_core_bridge_1.getGradleCore)();
        if (!core.hasGradlew(targetDir)) {
            log("未找到 gradlew，请确认项目目录有效");
            return 1;
        }
        if (!(await prepareProjectJdk(targetDir, log)) || cancelled) {
            log("已取消");
            return 1;
        }
        log(mode === "verify"
            ? `正在启动 Minecraft 客户端（客户端验证并发 ${(0, concurrency_governor_1.getConcurrencyLimits)().clientConcurrency} 路）…`
            : "正在启动 Minecraft 客户端（游戏窗口将保持打开，关闭游戏后结束）…");
        let tracked = null;
        const code = await core.runGradleClientTask(targetDir, log, {
            mode,
            isCancelled: () => cancelled,
            onProc: (proc, isWin) => { tracked = proc; trackProc(proc, isWin); },
        });
        clearProc(tracked);
        if (cancelled) {
            log("已取消");
            return 1;
        }
        if (mode === "interactive") {
            if (code === 0)
                log("✔ 客户端已正常退出");
            else if (code === 1)
                log("⚠ 进程很快退出且未检测到游戏启动，请查看 Gradle 日志或先执行构建");
            else
                log(`客户端异常退出（退出码 ${code}）`);
        }
        else if (code === 0) {
            log("✔ 客户端验证通过");
        }
        else {
            log("客户端验证失败");
        }
        return code;
    });
    return {
        runBuildOnly,
        runClientOnly: (targetDir, log) => runClientInternal(targetDir, log, "verify"),
        runClientInteractive: (targetDir, log) => runClientInternal(targetDir, log, "interactive"),
        isCancelled: () => cancelled,
        reset: () => {
            cancelled = false;
        },
        cancel: async () => {
            if (cancelled)
                return;
            cancelled = true;
            const proc = currentProc;
            if (!proc)
                return;
            try {
                await (0, gradle_1.killProcessTree)(proc, currentIsWin);
            }
            finally {
                clearProc(proc);
            }
        },
    };
}
