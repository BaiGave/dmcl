import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LoaderId } from "../types.js";

export type VerificationJobType = "build" | "run" | "build+run";
export type VerificationPhase = "build" | "client";
export type VerificationState = "verified" | "build-only" | "failed" | "unknown";

export interface VersionVerificationRecord {
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
  version: 1;
  records: Record<string, VersionVerificationRecord>;
}

export interface RecordVerificationInput {
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

export function verificationKey(loader: LoaderId, mcVersion: string): string {
  return `${loader}:${mcVersion}`;
}

function emptyFile(): VersionVerificationFile {
  return { version: 1, records: {} };
}

export function readVersionVerificationIndex(): VersionVerificationFile {
  const file = verificationFilePath();
  try {
    if (!fs.existsSync(file)) return emptyFile();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VersionVerificationFile;
    if (parsed.version === 1 && parsed.records) return parsed;
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
  const key = verificationKey(input.loader, input.mcVersion);
  const now = input.at ?? new Date().toISOString();
  const previous = index.records[key];
  const buildSucceeded = input.buildSuccess === true;
  const buildFailed = input.buildSuccess === false;
  const clientSucceeded = input.clientSuccess === true;
  const clientFailed = input.clientSuccess === false;

  const next: VersionVerificationRecord = {
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
