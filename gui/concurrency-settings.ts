import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectConcurrencyInfo,
  detectConcurrencyLimits,
  type ConcurrencyInfo,
  type ConcurrencyLimits,
} from "./cpu-concurrency";

export interface ConcurrencyUserSettings {
  jobSlots?: number;
  gradleBuildConcurrency?: number;
  clientConcurrency?: number;
}

export interface ConcurrencyBounds {
  min: number;
  max: number;
}

export interface ConcurrencySettingsPayload {
  hardware: ConcurrencyInfo;
  defaults: Pick<ConcurrencyLimits, "jobSlots" | "gradleBuildConcurrency" | "clientConcurrency">;
  user: ConcurrencyUserSettings;
  effective: ConcurrencyLimits;
  bounds: {
    jobSlots: ConcurrencyBounds;
    gradleBuildConcurrency: ConcurrencyBounds;
    clientConcurrency: ConcurrencyBounds;
  };
}

interface SettingsFile {
  concurrency?: ConcurrencyUserSettings;
}

const SETTINGS_FILE = path.join(os.homedir(), ".dmcl", "settings.json");

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function resolveConcurrencyLimits(user: ConcurrencyUserSettings = {}): ConcurrencyLimits {
  const hardware = detectConcurrencyInfo();
  const auto = detectConcurrencyLimits();
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

function readSettingsFile(): SettingsFile {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as SettingsFile;
    }
  } catch { /* ignore */ }
  return {};
}

function writeSettingsFile(data: SettingsFile): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
}

let userSettings: ConcurrencyUserSettings = {};
let effectiveLimits: ConcurrencyLimits = resolveConcurrencyLimits();

export function getEffectiveConcurrencyLimits(): ConcurrencyLimits {
  return effectiveLimits;
}

export function getConcurrencyUserSettings(): ConcurrencyUserSettings {
  return { ...userSettings };
}

export function loadConcurrencySettingsFromDisk(): ConcurrencyLimits {
  const file = readSettingsFile();
  userSettings = file.concurrency ?? {};
  effectiveLimits = resolveConcurrencyLimits(userSettings);
  return effectiveLimits;
}

export function saveConcurrencyUserSettings(next: ConcurrencyUserSettings): ConcurrencyLimits {
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

export function resetConcurrencyUserSettings(): ConcurrencyLimits {
  const file = readSettingsFile();
  delete file.concurrency;
  writeSettingsFile(file);
  userSettings = {};
  effectiveLimits = resolveConcurrencyLimits();
  return effectiveLimits;
}

export function getConcurrencySettingsPayload(): ConcurrencySettingsPayload {
  const hardware = detectConcurrencyInfo();
  const defaults = detectConcurrencyLimits();
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
