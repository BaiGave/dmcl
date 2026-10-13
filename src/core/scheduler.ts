import os from "node:os";

/**
 * The one scheduler for heavy work in this process. Two slot kinds:
 * - `gradle`: Gradle builds/verifications (CPU, memory and Gradle cache locks);
 * - `client`: interactive Minecraft clients (memory and GPU).
 *
 * Limits come from a getter so new settings apply to the next acquisition without cancelling
 * running work: lowering a limit only makes new work wait until enough slots are released.
 * The GUI configures the limits from its settings; the CLI uses the recommended defaults.
 */

export type SlotKind = "gradle" | "client";

export interface SlotLimits {
  gradle: number;
  client: number;
}

/** Hard caps: more than this contends on Gradle locks / memory on any desktop machine. */
export const SLOT_CAPS: SlotLimits = { gradle: 4, client: 3 };

/** Defaults: about one Gradle build per 6 physical cores (2 on 16 cores), at most 3; 2 clients on 8+ cores. */
export function recommendedSlotLimits(physicalCores: number): SlotLimits {
  const cores = Math.max(1, Math.floor(physicalCores) || 1);
  return {
    gradle: Math.max(1, Math.min(3, Math.floor(cores / 6) || 1)),
    client: cores >= 8 ? 2 : 1,
  };
}

export function clampSlotLimit(kind: SlotKind, value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(SLOT_CAPS[kind], Math.floor(n)));
}

export interface SlotWaitOptions {
  /** Polled while waiting; a cancelled wait rejects with SlotWaitCancelled. */
  isCancelled?: () => boolean;
  /** Called once when the request has to wait for a slot. */
  onWait?: (status: SlotKindStatus) => void;
}

export class SlotWaitCancelled extends Error {
  constructor() {
    super("已取消");
  }
}

export interface SlotKindStatus {
  active: number;
  max: number;
  waiting: number;
}

interface Waiter {
  kind: SlotKind;
  wake: () => void;
}

export class SlotScheduler {
  private readonly active: Record<SlotKind, number> = { gradle: 0, client: 0 };
  private readonly waiters: Waiter[] = [];

  constructor(private limits: () => SlotLimits) {}

  setLimits(limits: () => SlotLimits): void {
    this.limits = limits;
    this.wakeAll();
  }

  private limit(kind: SlotKind): number {
    return Math.max(1, Math.floor(this.limits()[kind]) || 1);
  }

  /** Wakes waiters so they re-check the limits (after settings changed or a cancel). */
  wakeAll(): void {
    for (const waiter of this.waiters.splice(0)) waiter.wake();
  }

  /** Waits for a slot and returns its release function (idempotent). */
  async acquire(kind: SlotKind, options: SlotWaitOptions = {}): Promise<() => void> {
    let notified = false;
    while (this.active[kind] >= this.limit(kind)) {
      if (options.isCancelled?.()) throw new SlotWaitCancelled();
      if (!notified) {
        notified = true;
        options.onWait?.({ active: this.active[kind], max: this.limit(kind), waiting: this.waiting(kind) + 1 });
      }
      await new Promise<void>((resolve) => {
        const waiter: Waiter = { kind, wake: resolve };
        this.waiters.push(waiter);
        // Re-check cancellation periodically even when nothing releases.
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        }, 500);
        timer.unref?.();
      });
    }
    if (options.isCancelled?.()) throw new SlotWaitCancelled();
    this.active[kind]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active[kind] = Math.max(0, this.active[kind] - 1);
      const index = this.waiters.findIndex((waiter) => waiter.kind === kind);
      if (index >= 0) this.waiters.splice(index, 1)[0].wake();
    };
  }

  async withSlot<T>(kind: SlotKind, operation: () => Promise<T>, options?: SlotWaitOptions): Promise<T> {
    const release = await this.acquire(kind, options);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private waiting(kind: SlotKind): number {
    return this.waiters.filter((waiter) => waiter.kind === kind).length;
  }

  status(): Record<SlotKind, SlotKindStatus> {
    return {
      gradle: { active: this.active.gradle, max: this.limit("gradle"), waiting: this.waiting("gradle") },
      client: { active: this.active.client, max: this.limit("client"), waiting: this.waiting("client") },
    };
  }
}

let hostConfigured = false;
let cliGradleLimit: number | null = null;
let defaultLimits: SlotLimits | null = null;

function fallbackLimits(): SlotLimits {
  if (!defaultLimits) {
    // CLI fallback: logical cores halved as the physical estimate (the GUI passes detected physical cores).
    const logical = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    defaultLimits = recommendedSlotLimits(Math.max(1, Math.round(logical / 2)));
  }
  return { gradle: cliGradleLimit ?? defaultLimits.gradle, client: defaultLimits.client };
}

/** The process-wide scheduler shared by the GUI queue, batch jobs and the version verifier. */
export const hostScheduler = new SlotScheduler(fallbackLimits);

/** The GUI owns the limits (from its settings); later CLI-style per-call limits are ignored. */
export function configureHostScheduler(limits: () => SlotLimits): void {
  hostConfigured = true;
  hostScheduler.setLimits(limits);
}

export function isHostSchedulerConfigured(): boolean {
  return hostConfigured;
}

/** CLI runs (matrix verification) choose their own Gradle parallelism unless a host configured limits. */
export function useCliGradleLimit(limit: number): void {
  if (hostConfigured) return;
  const next = Math.max(1, Math.floor(limit) || 1);
  if (cliGradleLimit === next) return;
  cliGradleLimit = next;
  hostScheduler.wakeAll();
}
