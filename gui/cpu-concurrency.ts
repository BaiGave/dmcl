import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

export interface ConcurrencyInfo {
  physicalCores: number;
  logicalCores: number;
  maxConcurrency: number;
  source: "windows-cim" | "macos-sysctl" | "linux-proc" | "fallback";
}

/** Gradle 构建与 MC 客户端验证的分级并发上限 */
export interface ConcurrencyLimits extends ConcurrencyInfo {
  /** 同时跑 gradlew build 的上限（兼顾 ~/.gradle 文件锁） */
  gradleBuildConcurrency: number;
  /** 同时启动 Minecraft 客户端验证的上限（内存/GPU） */
  clientConcurrency: number;
  /** 队列/批量任务总槽位 */
  jobSlots: number;
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

function availableLogicalCores(): number {
  const available = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, available || 1);
}

export function normalizePhysicalCores(detected: number | null, logical: number): number {
  if (!detected || !Number.isFinite(detected) || detected < 1) return Math.max(1, logical);
  return Math.max(1, Math.min(Math.floor(detected), Math.max(1, logical)));
}

export function detectConcurrencyInfo(): ConcurrencyInfo {
  const logicalCores = availableLogicalCores();
  let detected: number | null = null;
  let source: ConcurrencyInfo["source"] = "fallback";

  try {
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
      ], { encoding: "utf8", timeout: 2500, windowsHide: true });
      detected = parseWindowsPhysicalCores(output);
      if (detected) source = "windows-cim";
    } else if (process.platform === "darwin") {
      const output = execFileSync("sysctl", ["-n", "hw.physicalcpu"], {
        encoding: "utf8", timeout: 1000,
      });
      detected = Number.parseInt(output.trim(), 10) || null;
      if (detected) source = "macos-sysctl";
    } else if (process.platform === "linux") {
      detected = parseLinuxPhysicalCores(fs.readFileSync("/proc/cpuinfo", "utf8"));
      if (detected) source = "linux-proc";
    }
  } catch {
    detected = null;
  }

  const physicalCores = normalizePhysicalCores(detected, logicalCores);
  return { physicalCores, logicalCores, maxConcurrency: physicalCores, source };
}

/** Gradle 缓存锁争用：高核数机器上限制同时 build 数，避免全员等锁 */
const GRADLE_BUILD_CAP = 6;

/** 推荐 Gradle 并行构建数：约为物理核数一半，且不超过 GRADLE_BUILD_CAP */
export function recommendGradleBuildConcurrency(physicalCores: number): number {
  const half = Math.max(1, Math.ceil(physicalCores / 2));
  return Math.max(1, Math.min(physicalCores, GRADLE_BUILD_CAP, half));
}

export function detectConcurrencyLimits(): ConcurrencyLimits {
  const base = detectConcurrencyInfo();
  const physical = base.physicalCores;
  const gradleBuildConcurrency = recommendGradleBuildConcurrency(physical);
  const clientConcurrency = physical >= 8 ? 2 : 1;
  return {
    ...base,
    gradleBuildConcurrency,
    clientConcurrency,
    jobSlots: physical,
    maxConcurrency: gradleBuildConcurrency,
  };
}
