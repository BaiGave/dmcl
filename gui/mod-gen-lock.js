"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withModVariantGenLock = withModVariantGenLock;
/** 同一模组并发生成变体时串行化，避免工作区元数据写入竞态（批任务与 HTTP API 共用） */
const modGenTail = new Map();
async function withModVariantGenLock(modKey, work) {
    const previous = modGenTail.get(modKey) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    modGenTail.set(modKey, next);
    await previous;
    try {
        return await work();
    }
    finally {
        release();
    }
}
