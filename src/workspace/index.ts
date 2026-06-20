export * from "./types.js";
export { WorkspaceStore, getWorkspace, getDmclDir, getLogsDir } from "./store.js";
export {
  setRepoRoot,
  setProjectsRoot,
  getRepoRoot,
  getProjectsRoot,
  getModDir,
  variantFolderName,
  defaultVariantPath,
  ensureProjectsRoot,
  variantDirName,
} from "./paths.js";
export { detectProject, scanDirectory, scanDefaultProjects } from "./detect.js";
export { buildMatrix, invalidateMatrixCache, serializeMatrixResult } from "./matrix.js";
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
export { deleteVariantProject, deleteModProjects } from "./delete.js";
export {
  inferModDir,
  variantLogsDir,
  readModMeta,
  writeModMeta,
  MOD_META_FILE,
  VARIANT_META_DIR,
} from "./project-meta.js";
export { syncWorkspaceFromDisk, findVariantOnDisk, findModOnDisk } from "./sync-from-disk.js";
export {
  getVersionVerificationSummary,
  readVersionVerificationIndex,
  recordVersionVerification,
  verificationFilePath,
  verificationKey,
  versionVerificationStamp,
  writeVersionVerificationIndex,
} from "./version-verification.js";
export type {
  RecordVerificationInput,
  VersionVerificationFile,
  VersionVerificationRecord,
  VersionVerificationSummary,
  VerificationState,
} from "./version-verification.js";
export {
  buildVersionVerificationPlan,
  loadVersionVerificationPlan,
  loadVersionVerificationContext,
  summarizeMatrixCombinations,
  runAllVersionVerifications,
  runVersionVerificationBatch,
  runVersionVerificationBatchParallel,
  verifyOneVersion,
  verifyExistingProject,
} from "./version-verifier.js";
export {
  applyVerificationFixes,
  planVerificationFixes,
} from "./verification-fix.js";
export type { VerificationFixId, VerificationFixPlan, VerificationFixResult } from "./verification-fix.js";
export type {
  VersionVerificationBatchResult,
  VersionVerificationPlanOptions,
  VersionVerificationRunOptions,
  VersionVerificationRunResult,
  VersionVerificationTarget,
  VersionVerificationPlanContext,
  MatrixCombinationCounts,
  VerifyExistingProjectOptions,
  VerifyExistingProjectResult,
} from "./version-verifier.js";
