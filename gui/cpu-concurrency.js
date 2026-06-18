"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWindowsPhysicalCores = parseWindowsPhysicalCores;
exports.parseLinuxPhysicalCores = parseLinuxPhysicalCores;
exports.normalizePhysicalCores = normalizePhysicalCores;
exports.detectConcurrencyInfo = detectConcurrencyInfo;
exports.detectConcurrencyLimits = detectConcurrencyLimits;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_child_process_1 = require("node:child_process");
function parseWindowsPhysicalCores(output) {
    const values = output.match(/\d+/g)?.map(Number).filter((n) => Number.isFinite(n) && n > 0) ?? [];
    if (!values.length)
        return null;
    return values.reduce((sum, value) => sum + value, 0);
}
function parseLinuxPhysicalCores(cpuInfo) {
    const cores = new Set();
    for (const block of cpuInfo.split(/\n\s*\n/)) {
        const physical = block.match(/^physical id\s*:\s*(.+)$/m)?.[1]?.trim();
        const core = block.match(/^core id\s*:\s*(.+)$/m)?.[1]?.trim();
        if (physical !== undefined && core !== undefined)
            cores.add(`${physical}:${core}`);
    }
    return cores.size > 0 ? cores.size : null;
}
function availableLogicalCores() {
    const available = typeof node_os_1.default.availableParallelism === "function"
        ? node_os_1.default.availableParallelism()
        : node_os_1.default.cpus().length;
    return Math.max(1, available || 1);
}
function normalizePhysicalCores(detected, logical) {
    if (!detected || !Number.isFinite(detected) || detected < 1)
        return Math.max(1, logical);
    return Math.max(1, Math.min(Math.floor(detected), Math.max(1, logical)));
}
function detectConcurrencyInfo() {
    const logicalCores = availableLogicalCores();
    let detected = null;
    let source = "fallback";
    try {
        if (process.platform === "win32") {
            const output = (0, node_child_process_1.execFileSync)("powershell.exe", [
                "-NoProfile", "-NonInteractive", "-Command",
                "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
            ], { encoding: "utf8", timeout: 2500, windowsHide: true });
            detected = parseWindowsPhysicalCores(output);
            if (detected)
                source = "windows-cim";
        }
        else if (process.platform === "darwin") {
            const output = (0, node_child_process_1.execFileSync)("sysctl", ["-n", "hw.physicalcpu"], {
                encoding: "utf8", timeout: 1000,
            });
            detected = Number.parseInt(output.trim(), 10) || null;
            if (detected)
                source = "macos-sysctl";
        }
        else if (process.platform === "linux") {
            detected = parseLinuxPhysicalCores(node_fs_1.default.readFileSync("/proc/cpuinfo", "utf8"));
            if (detected)
                source = "linux-proc";
        }
    }
    catch {
        detected = null;
    }
    const physicalCores = normalizePhysicalCores(detected, logicalCores);
    return { physicalCores, logicalCores, maxConcurrency: physicalCores, source };
}
/** Gradle 缓存锁争用：高核数机器上限制同时 build 数，避免全员等锁 */
const GRADLE_BUILD_CAP = 12;
function detectConcurrencyLimits() {
    const base = detectConcurrencyInfo();
    const physical = base.physicalCores;
    const gradleBuildConcurrency = Math.min(physical, GRADLE_BUILD_CAP);
    const clientConcurrency = physical >= 8 ? 2 : 1;
    return {
        ...base,
        gradleBuildConcurrency,
        clientConcurrency,
        jobSlots: physical,
        maxConcurrency: gradleBuildConcurrency,
    };
}
