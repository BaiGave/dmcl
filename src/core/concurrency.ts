import os from "node:os";

const GRADLE_BUILD_CAP = 6;

export function availableLogicalCores(): number {
  const n = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, n || 1);
}

/** 推荐 Gradle 并行构建数：约为逻辑核数一半，且不超过 GRADLE_BUILD_CAP */
export function recommendGradleBuildConcurrency(logicalCores = availableLogicalCores()): number {
  const half = Math.max(1, Math.ceil(logicalCores / 2));
  return Math.max(1, Math.min(logicalCores, GRADLE_BUILD_CAP, half));
}

/** 全矩阵验证默认 worker 数（与 GUI 批量构建策略一致） */
export function defaultMatrixParallelism(explicit?: number): number {
  if (explicit != null && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return recommendGradleBuildConcurrency();
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    while (this.active >= this.limit) {
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

const gradleSlots = new Map<number, Semaphore>();

function gradleSemaphore(limit: number): Semaphore {
  let sem = gradleSlots.get(limit);
  if (!sem) {
    sem = new Semaphore(limit);
    gradleSlots.set(limit, sem);
  }
  return sem;
}

/** 限制 CLI 矩阵验证中同时运行的 Gradle build 数量 */
export async function withGradleBuildSlot<T>(
  limit: number,
  operation: () => Promise<T>,
): Promise<T> {
  const sem = gradleSemaphore(Math.max(1, limit));
  await sem.acquire();
  try {
    return await operation();
  } finally {
    sem.release();
  }
}
