"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConcurrencyLimits = getConcurrencyLimits;
exports.applyConcurrencyUserSettings = applyConcurrencyUserSettings;
exports.resetConcurrencyToDefaults = resetConcurrencyToDefaults;
exports.reloadConcurrencySettings = reloadConcurrencySettings;
exports.getGovernorStatus = getGovernorStatus;
exports.withGradleBuildSlot = withGradleBuildSlot;
exports.withClientSlot = withClientSlot;
const concurrency_settings_1 = require("./concurrency-settings");
class Semaphore {
    limit;
    active = 0;
    waiters = [];
    constructor(limit) {
        this.limit = limit;
    }
    get activeCount() {
        return this.active;
    }
    wakeAll() {
        const pending = this.waiters.splice(0, this.waiters.length);
        for (const wake of pending)
            wake();
    }
    async acquire() {
        while (this.active >= this.limit()) {
            await new Promise((resolve) => { this.waiters.push(resolve); });
        }
        this.active++;
    }
    release() {
        this.active = Math.max(0, this.active - 1);
        const next = this.waiters.shift();
        if (next)
            next();
    }
}
(0, concurrency_settings_1.loadConcurrencySettingsFromDisk)();
let limits = (0, concurrency_settings_1.getEffectiveConcurrencyLimits)();
const gradleBuildSem = new Semaphore(() => limits.gradleBuildConcurrency);
const clientSem = new Semaphore(() => limits.clientConcurrency);
function syncLimits() {
    limits = (0, concurrency_settings_1.getEffectiveConcurrencyLimits)();
    gradleBuildSem.wakeAll();
    clientSem.wakeAll();
}
function getConcurrencyLimits() {
    return limits;
}
function applyConcurrencyUserSettings(user) {
    (0, concurrency_settings_1.saveConcurrencyUserSettings)(user);
    syncLimits();
    return limits;
}
function resetConcurrencyToDefaults() {
    (0, concurrency_settings_1.resetConcurrencyUserSettings)();
    syncLimits();
    return limits;
}
function reloadConcurrencySettings() {
    (0, concurrency_settings_1.loadConcurrencySettingsFromDisk)();
    syncLimits();
    return limits;
}
function getGovernorStatus() {
    return {
        gradleBuildActive: gradleBuildSem.activeCount,
        gradleBuildMax: limits.gradleBuildConcurrency,
        clientActive: clientSem.activeCount,
        clientMax: limits.clientConcurrency,
        jobSlots: limits.jobSlots,
        physicalCores: limits.physicalCores,
    };
}
async function withGradleBuildSlot(operation) {
    await gradleBuildSem.acquire();
    try {
        return await operation();
    }
    finally {
        gradleBuildSem.release();
    }
}
async function withClientSlot(operation) {
    await clientSem.acquire();
    try {
        return await operation();
    }
    finally {
        clientSem.release();
    }
}
