import path from "node:path";
import type { WorkspaceStore } from "./store.js";
import { detectProject } from "./detect.js";

export interface ReconcileResult {
  checked: number;
  missing: number;
  relocated: number;
}

/** 从磁盘重新扫描；文件夹已删除的模组会自动消失 */
export function reconcileWorkspace(store: WorkspaceStore): ReconcileResult {
  const before = store.getMods().length;
  store.refresh();
  const after = store.getMods().length;
  return {
    checked: before,
    missing: Math.max(0, before - after),
    relocated: 0,
  };
}

/** 用户手动重新定位变体目录 */
export function relocateVariant(
  store: WorkspaceStore,
  variantId: string,
  newPath: string,
): { ok: boolean; error?: string } {
  const found = store.getVariant(variantId);
  if (!found) return { ok: false, error: "变体不存在" };

  const resolved = path.resolve(newPath);
  const detected = detectProject(resolved);
  if (!detected) {
    return { ok: false, error: "所选目录不是有效的 mod 项目（缺少 gradlew）" };
  }

  store.updateVariantPath(variantId, resolved);
  store.removeExcludedPath(resolved);

  if (detected.modVersion) {
    store.updateVariantBuildStatus(variantId, found.variant.buildStatus, detected.modVersion);
  }

  return { ok: true };
}
