import type { ConcurrencyLimits } from "./cpu-concurrency";
import {
  getEffectiveConcurrencyLimits,
  loadConcurrencySettingsFromDisk,
  saveConcurrencyUserSettings,
  resetConcurrencyUserSettings,
  type ConcurrencyUserSettings,
} from "./concurrency-settings";

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  get activeCount(): number {
    return this.active;
  }

  wakeAll(): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const wake of pending) wake();
  }

  async acquire(): Promise<void> {
    while (this.active >= this.limit()) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    }
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

loadConcurrencySettingsFromDisk();

let limits: ConcurrencyLimits = getEffectiveConcurrencyLimits();
const gradleBuildSem = new Semaphore(() => limits.gradleBuildConcurrency);
const clientSem = new Semaphore(() => limits.clientConcurrency);

function syncLimits(): void {
  limits = getEffectiveConcurrencyLimits();
  gradleBuildSem.wakeAll();
  clientSem.wakeAll();
}

export function getConcurrencyLimits(): ConcurrencyLimits {
  return limits;
}

export function applyConcurrencyUserSettings(user: ConcurrencyUserSettings): ConcurrencyLimits {
  saveConcurrencyUserSettings(user);
  syncLimits();
  return limits;
}

export function resetConcurrencyToDefaults(): ConcurrencyLimits {
  resetConcurrencyUserSettings();
  syncLimits();
  return limits;
}

export function reloadConcurrencySettings(): ConcurrencyLimits {
  loadConcurrencySettingsFromDisk();
  syncLimits();
  return limits;
}

export function getGovernorStatus(): {
  gradleBuildActive: number;
  gradleBuildMax: number;
  clientActive: number;
  clientMax: number;
  jobSlots: number;
  physicalCores: number;
} {
  return {
    gradleBuildActive: gradleBuildSem.activeCount,
    gradleBuildMax: limits.gradleBuildConcurrency,
    clientActive: clientSem.activeCount,
    clientMax: limits.clientConcurrency,
    jobSlots: limits.jobSlots,
    physicalCores: limits.physicalCores,
  };
}

export async function withGradleBuildSlot<T>(operation: () => Promise<T>): Promise<T> {
  await gradleBuildSem.acquire();
  try {
    return await operation();
  } finally {
    gradleBuildSem.release();
  }
}

export async function withClientSlot<T>(operation: () => Promise<T>): Promise<T> {
  await clientSem.acquire();
  try {
    return await operation();
  } finally {
    clientSem.release();
  }
}
