import os from "node:os";
import { hostScheduler, useCliGradleLimit } from "./scheduler.js";

const GRADLE_BUILD_CAP = 6;

export function availableLogicalCores(): number {
  const n = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, n || 1);
}

/** 推荐 CLI 矩阵验证的 Gradle 并行数：约为逻辑核数一半，且不超过 GRADLE_BUILD_CAP */
export function recommendGradleBuildConcurrency(logicalCores = availableLogicalCores()): number {
  const half = Math.max(1, Math.ceil(logicalCores / 2));
  return Math.max(1, Math.min(logicalCores, GRADLE_BUILD_CAP, half));
}

/** 全矩阵验证默认 worker 数 */
export function defaultMatrixParallelism(explicit?: number): number {
  if (explicit != null && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  return recommendGradleBuildConcurrency();
}

/**
 * 在进程唯一的调度器（见 scheduler.ts）里占一个 Gradle 槽位执行。
 * GUI 进程由设置决定上限，忽略 `limit`；纯 CLI 运行时 `limit` 即本次的 Gradle 并行数。
 */
export async function withGradleBuildSlot<T>(
  limit: number,
  operation: () => Promise<T>,
): Promise<T> {
  useCliGradleLimit(limit);
  return hostScheduler.withSlot("gradle", operation);
}
