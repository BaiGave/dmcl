import type { ChildProcess } from "node:child_process";
import { loadDist, repoDist } from "./dist-loader";
import type { JobPhase } from "./gradle-runner";

/** Typed views of the dist (ESM) core modules used by the GUI main process. */

export interface GradleCoreModule {
  CLIENT_FAIL: RegExp[];
  hasGradlew(targetDir: string): boolean;
  shouldEmitGradleLine(line: string): boolean;
  killProcessTree(proc: ChildProcess, isWin: boolean): void;
  pruneDmclGradleCache(): Promise<unknown>;
  measureLegacyGradleShards(): Promise<Array<{ path: string; bytes: number }>>;
  resolveGradleUserHome(targetDir?: string): { path: string; kind: "user" | "dmcl" };
  /** Adds `ensureFabricApiVersionIfScaffolded` on top of core/gradle.js (see below). */
  ensureFabricApiVersionIfScaffolded(targetDir: string, log: (line: string) => void): Promise<void>;
}

export interface ProjectJdkModule {
  prepareProjectJdk(
    targetDir: string,
    log: (line: string) => void,
    options?: { isCancelled?: () => boolean },
  ): Promise<boolean>;
}

export interface JdkCoreModule {
  readJavaHomeFromProject(targetDir: string): string | null;
  detectJavaMajorAt(javaHome: string): number | null;
}

export interface GradleSessionResult {
  status: "success" | "failed" | "cancelled";
  reason?: string;
  exitCode: number | null;
  phaseReached: JobPhase;
  titleReached: boolean;
  timeToTitleMs?: number;
  durationMs: number;
  pid?: number;
}

export interface HostActivityEntry {
  schema: number;
  pid: number;
  process_started: number | null;
  kind: string;
  label: string;
  cwd: string;
  started_at: string;
  progress?: string;
  entry?: string;
}

export interface LaunchCoreModule {
  runGradleSession(targetDir: string, opts: {
    kind: "build" | "run";
    tasks: string[];
    label: string;
    onLine?: (line: string) => void;
    onPhase?: (phase: JobPhase, detail?: string) => void;
    isCancelled?: () => boolean;
    stopAtTitle?: boolean;
    timeoutMs?: number;
  }): Promise<GradleSessionResult>;
  listHostActivity(): Promise<HostActivityEntry[]>;
}

const gradleCorePromise = (async (): Promise<GradleCoreModule> => {
  const core = await loadDist<Omit<GradleCoreModule, "ensureFabricApiVersionIfScaffolded">>(repoDist("core", "gradle.js"));
  const fabric = await loadDist<{ ensureFabricApiVersion(dir: string, log: (line: string) => void): Promise<boolean> }>(
    repoDist("loaders", "fabric-toolchain.js"),
  );
  return {
    ...core,
    // Gated on the scaffold marker inside ensureFabricApiVersion: imported projects are never rewritten.
    ensureFabricApiVersionIfScaffolded: async (targetDir, log) => {
      await fabric.ensureFabricApiVersion(targetDir, log).catch(() => false);
    },
  };
})();
const projectJdkPromise = loadDist<ProjectJdkModule>(repoDist("core", "project-jdk.js"));
const jdkCorePromise = loadDist<JdkCoreModule>(repoDist("core", "jdk.js"));
const launchCorePromise = loadDist<LaunchCoreModule>(repoDist("launch", "index.js"));
for (const promise of [gradleCorePromise, projectJdkPromise, jdkCorePromise, launchCorePromise]) {
  promise.catch(() => undefined);
}

export function getGradleCore(): Promise<GradleCoreModule> {
  return gradleCorePromise;
}

export function getProjectJdk(): Promise<ProjectJdkModule> {
  return projectJdkPromise;
}

export function getJdkCore(): Promise<JdkCoreModule> {
  return jdkCorePromise;
}

export function getLaunchCore(): Promise<LaunchCoreModule> {
  return launchCorePromise;
}
