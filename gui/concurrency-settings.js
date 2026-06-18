"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveConcurrencyLimits = resolveConcurrencyLimits;
exports.getEffectiveConcurrencyLimits = getEffectiveConcurrencyLimits;
exports.getConcurrencyUserSettings = getConcurrencyUserSettings;
exports.loadConcurrencySettingsFromDisk = loadConcurrencySettingsFromDisk;
exports.saveConcurrencyUserSettings = saveConcurrencyUserSettings;
exports.resetConcurrencyUserSettings = resetConcurrencyUserSettings;
exports.getConcurrencySettingsPayload = getConcurrencySettingsPayload;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const cpu_concurrency_1 = require("./cpu-concurrency");
const SETTINGS_FILE = node_path_1.default.join(node_os_1.default.homedir(), ".dmcl", "settings.json");
function clampInt(value, min, max) {
    const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n))
        return min;
    return Math.max(min, Math.min(max, Math.floor(n)));
}
function resolveConcurrencyLimits(user = {}) {
    const hardware = (0, cpu_concurrency_1.detectConcurrencyInfo)();
    const auto = (0, cpu_concurrency_1.detectConcurrencyLimits)();
    const physical = hardware.physicalCores;
    const jobSlots = user.jobSlots !== undefined
        ? clampInt(user.jobSlots, 1, physical)
        : auto.jobSlots;
    const gradleBuildConcurrency = user.gradleBuildConcurrency !== undefined
        ? clampInt(user.gradleBuildConcurrency, 1, jobSlots)
        : Math.min(auto.gradleBuildConcurrency, jobSlots);
    const clientMax = Math.min(8, jobSlots);
    const clientConcurrency = user.clientConcurrency !== undefined
        ? clampInt(user.clientConcurrency, 1, clientMax)
        : Math.min(auto.clientConcurrency, clientMax);
    return {
        ...hardware,
        jobSlots,
        gradleBuildConcurrency,
        clientConcurrency,
        maxConcurrency: gradleBuildConcurrency,
    };
}
function readSettingsFile() {
    try {
        if (node_fs_1.default.existsSync(SETTINGS_FILE)) {
            return JSON.parse(node_fs_1.default.readFileSync(SETTINGS_FILE, "utf8"));
        }
    }
    catch { /* ignore */ }
    return {};
}
function writeSettingsFile(data) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(SETTINGS_FILE), { recursive: true });
    node_fs_1.default.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
}
let userSettings = {};
let effectiveLimits = resolveConcurrencyLimits();
function getEffectiveConcurrencyLimits() {
    return effectiveLimits;
}
function getConcurrencyUserSettings() {
    return { ...userSettings };
}
function loadConcurrencySettingsFromDisk() {
    const file = readSettingsFile();
    userSettings = file.concurrency ?? {};
    effectiveLimits = resolveConcurrencyLimits(userSettings);
    return effectiveLimits;
}
function saveConcurrencyUserSettings(next) {
    const file = readSettingsFile();
    file.concurrency = {
        jobSlots: next.jobSlots,
        gradleBuildConcurrency: next.gradleBuildConcurrency,
        clientConcurrency: next.clientConcurrency,
    };
    writeSettingsFile(file);
    userSettings = { ...file.concurrency };
    effectiveLimits = resolveConcurrencyLimits(userSettings);
    return effectiveLimits;
}
function resetConcurrencyUserSettings() {
    const file = readSettingsFile();
    delete file.concurrency;
    writeSettingsFile(file);
    userSettings = {};
    effectiveLimits = resolveConcurrencyLimits();
    return effectiveLimits;
}
function getConcurrencySettingsPayload() {
    const hardware = (0, cpu_concurrency_1.detectConcurrencyInfo)();
    const defaults = (0, cpu_concurrency_1.detectConcurrencyLimits)();
    const physical = hardware.physicalCores;
    return {
        hardware,
        defaults: {
            jobSlots: defaults.jobSlots,
            gradleBuildConcurrency: defaults.gradleBuildConcurrency,
            clientConcurrency: defaults.clientConcurrency,
        },
        user: { ...userSettings },
        effective: { ...effectiveLimits },
        bounds: {
            jobSlots: { min: 1, max: physical },
            gradleBuildConcurrency: { min: 1, max: physical },
            clientConcurrency: { min: 1, max: Math.min(8, physical) },
        },
    };
}
