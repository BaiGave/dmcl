import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SLOT_CAPS,
  clampSlotLimit,
  configureHostScheduler,
  hostScheduler,
  recommendedSlotLimits,
  type SlotKindStatus,
} from "./scheduler.js";

/**
 * GUI concurrency settings (~/.dmcl/settings.json `concurrency`) on top of the one scheduler.
 * Saving applies the new limits to work that has not started yet; running jobs keep going.
 */

export interface ConcurrencyInfo {
  physicalCores: number;
  logicalCores: number;
  source: "windows-cim" | "macos-sysctl" | "linux-proc" | "fallback";
}

export interface ConcurrencyUserSettings {
  /** Kept for old settings files; the total is now always gradle + client. */
  jobSlots?: number;
  gradleBuildConcurrency?: number;
  clientConcurrency?: number;
}

export interface ConcurrencyLimits extends ConcurrencyInfo {
  gradleBuildConcurrency: number;
  clientConcurrency: number;
  /** gradleBuildConcurrency + clientConcurrency */
  jobSlots: number;
  /** = gradleBuildConcurrency (older GUI field) */
  maxConcurrency: number;
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
  /** Shown next to the form when the user raised a limit above the recommendation. */
  warnings: string[];
  scheduler: Record<"gradle" | "client", SlotKindStatus>;
}

export function parseWindowsPhysicalCores(output: string): number | null {
  const values = output.match(/\d+/g)?.map(Number).filter((n) => Number.isFinite(n) && n > 0) ?? [];
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export function parseLinuxPhysicalCores(cpuInfo: string): number | null {
  const cores = new Set<string>();
  for (const block of cpuInfo.split(/\n\s*\n/)) {
    const physical = block.match(/^physical id\s*:\s*(.+)$/m)?.[1]?.trim();
    const core = block.match(/^core id\s*:\s*(.+)$/m)?.[1]?.trim();
    if (physical !== undefined && core !== undefined) cores.add(`${physical}:${core}`);
  }
  return cores.size > 0 ? cores.size : null;
}

function logicalCores(): number {
  const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, n || 1);
}

let hardwareCache: ConcurrencyInfo | null = null;

export function detectConcurrencyInfo(): ConcurrencyInfo {
  if (hardwareCache) return hardwareCache;
  const logical = logicalCores();
  let detected: number | null = null;
  let source: ConcurrencyInfo["source"] = "fallback";
  try {
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
      ], { encoding: "utf8", timeout: 4000, windowsHide: true });
      detected = parseWindowsPhysicalCores(output);
      if (detected) source = "windows-cim";
    } else if (process.platform === "darwin") {
      detected = Number.parseInt(execFileSync("sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8", timeout: 1000 }).trim(), 10) || null;
      if (detected) source = "macos-sysctl";
    } else if (process.platform === "linux") {
      detected = parseLinuxPhysicalCores(fs.readFileSync("/proc/cpuinfo", "utf8"));
      if (detected) source = "linux-proc";
    }
  } catch {
    detected = null;
  }
  const physicalCores = detected && detected > 0
    ? Math.max(1, Math.min(Math.floor(detected), logical))
    : Math.max(1, Math.round(logical / 2));
  hardwareCache = { physicalCores, logicalCores: logical, source };
  return hardwareCache;
}

function withTotals(info: ConcurrencyInfo, gradle: number, client: number): ConcurrencyLimits {
  return {
    ...info,
    gradleBuildConcurrency: gradle,
    clientConcurrency: client,
    jobSlots: gradle + client,
    maxConcurrency: gradle,
  };
}

export function defaultConcurrencyLimits(info = detectConcurrencyInfo()): ConcurrencyLimits {
  const recommended = recommendedSlotLimits(info.physicalCores);
  return withTotals(info, recommended.gradle, recommended.client);
}

/** User values are clamped to [1, cap]; old files with 16/16/8 come out as 4/3. */
export function resolveConcurrencyLimits(
  user: ConcurrencyUserSettings = {},
  info = detectConcurrencyInfo(),
): ConcurrencyLimits {
  const defaults = defaultConcurrencyLimits(info);
  return withTotals(
    info,
    clampSlotLimit("gradle", user.gradleBuildConcurrency, defaults.gradleBuildConcurrency),
    clampSlotLimit("client", user.clientConcurrency, defaults.clientConcurrency),
  );
}

export function concurrencyWarnings(effective: ConcurrencyLimits, defaults: ConcurrencyLimits): string[] {
  const warnings: string[] = [];
  if (effective.gradleBuildConcurrency > defaults.gradleBuildConcurrency) {
    warnings.push(
      `Gradle 构建并发 ${effective.gradleBuildConcurrency} 高于推荐的 ${defaults.gradleBuildConcurrency}：`
      + "并行构建会争用 Gradle 缓存锁与内存，也会拖慢同时运行的 Linker 实例测试",
    );
  }
  if (effective.clientConcurrency > defaults.clientConcurrency) {
    warnings.push(
      `同时运行的客户端 ${effective.clientConcurrency} 个高于推荐的 ${defaults.clientConcurrency} 个：每个客户端约占 2–4 GB 内存与显存`,
    );
  }
  return warnings;
}

function settingsFile(): string {
  return path.join(os.homedir(), ".dmcl", "settings.json");
}

function readSettingsFile(): { concurrency?: ConcurrencyUserSettings } & Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { concurrency?: ConcurrencyUserSettings };
  } catch {
    return {};
  }
}

function writeSettingsFile(data: Record<string, unknown>): void {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

let userSettings: ConcurrencyUserSettings = {};
let effective: ConcurrencyLimits | null = null;

function apply(): ConcurrencyLimits {
  effective = resolveConcurrencyLimits(userSettings);
  const snapshot = effective;
  configureHostScheduler(() => ({ gradle: snapshot.gradleBuildConcurrency, client: snapshot.clientConcurrency }));
  return effective;
}

/** Loads the settings file and hands the limits to the process scheduler. */
export function loadConcurrencySettings(): ConcurrencyLimits {
  userSettings = readSettingsFile().concurrency ?? {};
  return apply();
}

export function getConcurrencyLimits(): ConcurrencyLimits {
  return effective ?? loadConcurrencySettings();
}

/** Saves and applies new limits; running work is never cancelled by this. */
export function saveConcurrencySettings(next: ConcurrencyUserSettings): ConcurrencyLimits {
  const file = readSettingsFile();
  const stored: ConcurrencyUserSettings = {};
  if (next.gradleBuildConcurrency !== undefined) stored.gradleBuildConcurrency = clampSlotLimit("gradle", next.gradleBuildConcurrency, 1);
  if (next.clientConcurrency !== undefined) stored.clientConcurrency = clampSlotLimit("client", next.clientConcurrency, 1);
  file.concurrency = stored;
  writeSettingsFile(file);
  userSettings = stored;
  return apply();
}

export function resetConcurrencySettings(): ConcurrencyLimits {
  const file = readSettingsFile();
  delete file.concurrency;
  writeSettingsFile(file);
  userSettings = {};
  return apply();
}

export function getConcurrencySettingsPayload(): ConcurrencySettingsPayload {
  const current = getConcurrencyLimits();
  const defaults = defaultConcurrencyLimits(current);
  return {
    hardware: detectConcurrencyInfo(),
    defaults: {
      jobSlots: defaults.jobSlots,
      gradleBuildConcurrency: defaults.gradleBuildConcurrency,
      clientConcurrency: defaults.clientConcurrency,
    },
    user: { ...userSettings },
    effective: { ...current },
    bounds: {
      jobSlots: { min: 2, max: SLOT_CAPS.gradle + SLOT_CAPS.client },
      gradleBuildConcurrency: { min: 1, max: SLOT_CAPS.gradle },
      clientConcurrency: { min: 1, max: SLOT_CAPS.client },
    },
    warnings: concurrencyWarnings(current, defaults),
    scheduler: hostScheduler.status(),
  };
}
