import { loadDist, repoDist } from "./dist-loader";

/**
 * GUI facade over the core scheduler (dist/core/scheduler.js) and its settings
 * (dist/core/host-concurrency.js). There is one scheduler per process: the build queue, batch jobs
 * and the version verifier all take their Gradle/client slots from it.
 */

export interface ConcurrencyLimits {
  physicalCores: number;
  logicalCores: number;
  source: string;
  gradleBuildConcurrency: number;
  clientConcurrency: number;
  jobSlots: number;
  maxConcurrency: number;
}

export interface ConcurrencyUserSettings {
  gradleBuildConcurrency?: number;
  clientConcurrency?: number;
}

interface SlotKindStatus {
  active: number;
  max: number;
  waiting: number;
}

export interface SlotWaitOptions {
  isCancelled?: () => boolean;
  onWait?: (status: SlotKindStatus) => void;
}

interface SchedulerModule {
  hostScheduler: {
    withSlot<T>(kind: "gradle" | "client", op: () => Promise<T>, options?: SlotWaitOptions): Promise<T>;
    status(): Record<"gradle" | "client", SlotKindStatus>;
  };
  SlotWaitCancelled: new () => Error;
}

interface HostConcurrencyModule {
  loadConcurrencySettings(): ConcurrencyLimits;
  getConcurrencyLimits(): ConcurrencyLimits;
  saveConcurrencySettings(next: ConcurrencyUserSettings): ConcurrencyLimits;
  resetConcurrencySettings(): ConcurrencyLimits;
  getConcurrencySettingsPayload(): unknown;
}

let schedulerModule: SchedulerModule | null = null;
let settingsModule: HostConcurrencyModule | null = null;
let snapshot: ConcurrencyLimits = {
  physicalCores: 1,
  logicalCores: 1,
  source: "loading",
  gradleBuildConcurrency: 1,
  clientConcurrency: 1,
  jobSlots: 2,
  maxConcurrency: 1,
};

const ready: Promise<void> = (async () => {
  schedulerModule = await loadDist<SchedulerModule>(repoDist("core", "scheduler.js"));
  settingsModule = await loadDist<HostConcurrencyModule>(repoDist("core", "host-concurrency.js"));
  snapshot = settingsModule.loadConcurrencySettings();
})();
ready.catch((err) => console.warn("[dmcl] concurrency settings failed to load:", err));

export function concurrencyReady(): Promise<void> {
  return ready;
}

/** Current limits (a snapshot; refreshed whenever settings are applied). */
export function getConcurrencyLimits(): ConcurrencyLimits {
  return snapshot;
}

/** Applies new limits to work that has not started; running jobs are not cancelled. */
export async function applyConcurrencyUserSettings(user: ConcurrencyUserSettings): Promise<ConcurrencyLimits> {
  await ready;
  snapshot = settingsModule!.saveConcurrencySettings(user);
  return snapshot;
}

export async function resetConcurrencyToDefaults(): Promise<ConcurrencyLimits> {
  await ready;
  snapshot = settingsModule!.resetConcurrencySettings();
  return snapshot;
}

export async function getConcurrencySettingsPayload(): Promise<unknown> {
  await ready;
  return settingsModule!.getConcurrencySettingsPayload();
}

export function isSlotWaitCancelled(err: unknown): boolean {
  return !!schedulerModule && err instanceof schedulerModule.SlotWaitCancelled;
}

export function getGovernorStatus(): {
  gradleBuildActive: number;
  gradleBuildMax: number;
  gradleBuildWaiting: number;
  clientActive: number;
  clientMax: number;
  clientWaiting: number;
  jobSlots: number;
  physicalCores: number;
} {
  const status = schedulerModule?.hostScheduler.status();
  return {
    gradleBuildActive: status?.gradle.active ?? 0,
    gradleBuildMax: status?.gradle.max ?? snapshot.gradleBuildConcurrency,
    gradleBuildWaiting: status?.gradle.waiting ?? 0,
    clientActive: status?.client.active ?? 0,
    clientMax: status?.client.max ?? snapshot.clientConcurrency,
    clientWaiting: status?.client.waiting ?? 0,
    jobSlots: snapshot.jobSlots,
    physicalCores: snapshot.physicalCores,
  };
}

export async function withGradleBuildSlot<T>(operation: () => Promise<T>, options?: SlotWaitOptions): Promise<T> {
  await ready;
  return schedulerModule!.hostScheduler.withSlot("gradle", operation, options);
}

export async function withClientSlot<T>(operation: () => Promise<T>, options?: SlotWaitOptions): Promise<T> {
  await ready;
  return schedulerModule!.hostScheduler.withSlot("client", operation, options);
}
