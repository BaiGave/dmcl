import fs from "node:fs";
import path from "node:path";
import type { WorkspaceStore } from "./store.js";
import { defaultVariantPath } from "./paths.js";
import { detectProject } from "./detect.js";

export interface ReconcileResult {
  checked: number;
  missing: number;
  relocated: number;
}

function hasGradleProject(dir: string): boolean {
  const gradlew = process.platform === "win32"
    ? path.join(dir, "gradlew.bat")
    : path.join(dir, "gradlew");
  return fs.existsSync(gradlew);
}

/** 启动或刷新时校验变体路径是否仍在磁盘上，并尝试在默认位置找回 */
export function reconcileWorkspace(store: WorkspaceStore): ReconcileResult {
  const result: ReconcileResult = { checked: 0, missing: 0, relocated: 0 };

  for (const mod of store.getMods()) {
    for (const variant of mod.variants) {
      result.checked++;
      const current = path.resolve(variant.projectPath);

      if (hasGradleProject(current)) {
        if (variant.pathMissing) {
          store.setVariantPathMissing(variant.id, false);
        }
        continue;
      }

      const expected = defaultVariantPath(mod.modId, variant.loader, variant.mcVersion);
      if (hasGradleProject(expected)) {
        store.updateVariantPath(variant.id, expected);
        store.setVariantPathMissing(variant.id, false);
        result.relocated++;
        continue;
      }

      store.setVariantPathMissing(variant.id, true);
      result.missing++;
    }
  }

  return result;
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
  store.setVariantPathMissing(variantId, false);
  store.removeExcludedPath(resolved);

  if (detected.modVersion) {
    store.updateVariantBuildStatus(variantId, found.variant.buildStatus, detected.modVersion);
  }

  return { ok: true };
}
