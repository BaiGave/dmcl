import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoaderId } from "../types.js";

export type VerificationJobType = "build" | "run" | "build+run";
export type VerificationPhase = "build" | "client";
export type VerificationState = "verified" | "build-only" | "failed" | "unknown";

export interface VersionVerificationRecord {
  /** "template": DMCL's own generated verification project for loader+MC; "project": a user's variant. */
  scope?: "template" | "project";
  loader: LoaderId;
  mcVersion: string;
  buildVerified: boolean;
  clientVerified: boolean;
  lastResultAt: string;
  lastBuildAt?: string;
  lastClientAt?: string;
  lastFailureAt?: string;
  lastFailurePhase?: VerificationPhase;
  failureSummary?: string;
  lastProjectPath?: string;
  lastVariantId?: string;
  lastJobType?: VerificationJobType;
}

export interface VersionVerificationFile {
  version: 1 | 2;
  records: Record<string, VersionVerificationRecord>;
}

export interface RecordVerificationInput {
  /** Defaults to "project" when a variantId is given, else "template". */
  scope?: "template" | "project";
  loader: LoaderId;
  mcVersion: string;
  jobType: VerificationJobType;
  variantId?: string;
  projectPath?: string;
  buildSuccess?: boolean;
  clientSuccess?: boolean;
  failureSummary?: string;
  at?: string;
}

export interface VersionVerificationSummary {
  state: VerificationState;
  buildVerified: boolean;
  clientVerified: boolean;
  updatedAt?: string;
  failureSummary?: string;
}

export const VERSION_VERIFICATION_FILE = path.join(
  os.homedir(),
  ".dmcl",
  "version-verification.json",
);

export function verificationFilePath(): string {
  return process.env.DMCL_VERSION_VERIFICATION_FILE || VERSION_VERIFICATION_FILE;
}

/** Key of DMCL's template verification for a loader + Minecraft version (what the version plan reads). */
export function verificationKey(loader: LoaderId, mcVersion: string): string {
  return `${loader}:${mcVersion}`;
}

/** Key of one user variant's result: project path + variant id, so projects never overwrite each other. */
export function projectVerificationKey(projectPath: string, variantId?: string): string {
  const normalized = path.resolve(projectPath).split(path.sep).join("/");
  return `project:${process.platform === "win32" ? normalized.toLowerCase() : normalized}#${variantId ?? ""}`;
}

function emptyFile(): VersionVerificationFile {
  return { version: 2, records: {} };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Version 1 keyed everything by loader:mc, so user projects (e.g. Linker) and test fixtures overwrote
 * DMCL's template results. Version 2 moves records that came from a variant (they carry
 * lastVariantId) to project keys and drops records of temporary test projects.
 */
export function migrateVerificationIndex(index: VersionVerificationFile): VersionVerificationFile {
  if (index.version === 2) return index;
  const records: Record<string, VersionVerificationRecord> = {};
  const tmp = os.tmpdir();
  for (const [key, record] of Object.entries(index.records)) {
    if (record.lastProjectPath && isInside(record.lastProjectPath, tmp)) continue;
    if (key.startsWith("project:")) {
      records[key] = record;
    } else if (record.lastVariantId && record.lastProjectPath) {
      records[projectVerificationKey(record.lastProjectPath, record.lastVariantId)] = { ...record, scope: "project" };
    } else {
      records[key] = { ...record, scope: "template" };
    }
  }
  return { version: 2, records };
}

export function readVersionVerificationIndex(): VersionVerificationFile {
  const file = verificationFilePath();
  try {
    if (!fs.existsSync(file)) return emptyFile();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VersionVerificationFile;
    if ((parsed.version === 1 || parsed.version === 2) && parsed.records) return migrateVerificationIndex(parsed);
  } catch {
    // Rebuild a fresh index on malformed or partially written files.
  }
  return emptyFile();
}

export function writeVersionVerificationIndex(index: VersionVerificationFile): void {
  const file = verificationFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index, null, 2), "utf8");
}

export function versionVerificationStamp(): string {
  const file = verificationFilePath();
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function recordState(record?: VersionVerificationRecord): VerificationState {
  if (!record) return "unknown";
  if (record.lastFailureAt && record.lastFailureAt === record.lastResultAt) return "failed";
  if (record.buildVerified && record.clientVerified) return "verified";
  if (record.buildVerified) return "build-only";
  if (record.lastFailureAt) return "failed";
  return "unknown";
}

export function summarizeVersionVerification(
  record?: VersionVerificationRecord,
): VersionVerificationSummary {
  const state = recordState(record);
  return {
    state,
    buildVerified: record?.buildVerified ?? false,
    clientVerified: record?.clientVerified ?? false,
    updatedAt: record?.lastResultAt,
    failureSummary: state === "failed" ? record?.failureSummary : undefined,
  };
}

export function recordVersionVerification(input: RecordVerificationInput): VersionVerificationRecord {
  const index = readVersionVerificationIndex();
  const scope = input.scope ?? (input.variantId ? "project" : "template");
  const key = scope === "project" && input.projectPath
    ? projectVerificationKey(input.projectPath, input.variantId)
    : verificationKey(input.loader, input.mcVersion);
  const now = input.at ?? new Date().toISOString();
  const previous = index.records[key];
  const buildSucceeded = input.buildSuccess === true;
  const buildFailed = input.buildSuccess === false;
  const clientSucceeded = input.clientSuccess === true;
  const clientFailed = input.clientSuccess === false;

  const next: VersionVerificationRecord = {
    scope,
    loader: input.loader,
    mcVersion: input.mcVersion,
    buildVerified: previous?.buildVerified ?? false,
    clientVerified: previous?.clientVerified ?? false,
    lastResultAt: now,
    lastBuildAt: previous?.lastBuildAt,
    lastClientAt: previous?.lastClientAt,
    lastFailureAt: previous?.lastFailureAt,
    lastFailurePhase: previous?.lastFailurePhase,
    failureSummary: previous?.failureSummary,
    lastProjectPath: input.projectPath ?? previous?.lastProjectPath,
    lastVariantId: input.variantId ?? previous?.lastVariantId,
    lastJobType: input.jobType,
  };

  if (buildSucceeded) {
    next.buildVerified = true;
    next.lastBuildAt = now;
  }
  if (clientSucceeded) {
    next.clientVerified = true;
    next.lastClientAt = now;
  }
  if (buildFailed || clientFailed) {
    next.lastFailureAt = now;
    next.lastFailurePhase = buildFailed ? "build" : "client";
    next.failureSummary = input.failureSummary;
  } else if (buildSucceeded || clientSucceeded) {
    delete next.lastFailureAt;
    delete next.lastFailurePhase;
    delete next.failureSummary;
  }

  index.records[key] = next;
  writeVersionVerificationIndex(index);
  return next;
}

export function getVersionVerificationSummary(
  loader: LoaderId,
  mcVersion: string,
): VersionVerificationSummary {
  const index = readVersionVerificationIndex();
  return summarizeVersionVerification(index.records[verificationKey(loader, mcVersion)]);
}
