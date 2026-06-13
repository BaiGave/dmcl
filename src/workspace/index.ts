export * from "./types.js";
export { WorkspaceStore, getWorkspace, getDmclDir, getLogsDir } from "./store.js";
export {
  setRepoRoot,
  getRepoRoot,
  getProjectsRoot,
  getModDir,
  variantFolderName,
  defaultVariantPath,
  ensureProjectsRoot,
  variantDirName,
} from "./paths.js";
export { detectProject, scanDirectory, scanDefaultProjects } from "./detect.js";
export { buildMatrix } from "./matrix.js";
export { generateVariant } from "./variant.js";
export {
  importDetectedProject,
  importFromPath,
  scanAndImport,
  autoScan,
} from "./scan.js";
export { reconcileWorkspace, relocateVariant } from "./reconcile.js";
export type { ReconcileResult } from "./reconcile.js";
export { listRegisteredProjects } from "./registry.js";
export type { ExternalProjectEntry } from "./registry.js";
export { assertValidModId, isValidModId } from "./validate.js";
export { exportCatalog, writeCatalogExport } from "./export.js";
