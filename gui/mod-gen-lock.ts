/** 同一模组并发生成变体时串行化，避免工作区元数据写入竞态（批任务与 HTTP API 共用） */
const modGenTail = new Map<string, Promise<void>>();

export async function withModVariantGenLock<T>(modKey: string, work: () => Promise<T>): Promise<T> {
  const previous = modGenTail.get(modKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  modGenTail.set(modKey, next);
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
