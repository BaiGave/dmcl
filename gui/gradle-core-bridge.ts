import type { ChildProcess } from "node:child_process";
import { loadDist, repoDist } from "./dist-loader";

export interface GradleCoreModule {
  CLIENT_FAIL: RegExp[];
  hasGradlew(targetDir: string): boolean;
  shouldEmitGradleLine(line: string): boolean;
  gradleSpawn(targetDir: string, tasks: string[]): { proc: ChildProcess; isWin: boolean };
  killProcessTree(proc: ChildProcess, isWin: boolean): void;
  runGradleBuildTask(
    targetDir: string,
    onLine: (line: string) => void,
    opts?: {
      tasks?: string[];
      isCancelled?: () => boolean;
      onProc?: (proc: ChildProcess, isWin: boolean) => void;
    },
  ): Promise<number>;
  runGradleClientTask(
    targetDir: string,
    onLine: (line: string) => void,
    opts: {
      mode: "verify" | "interactive";
      isCancelled?: () => boolean;
      onProc?: (proc: ChildProcess, isWin: boolean) => void;
    },
  ): Promise<number>;
}

export interface ProjectJdkModule {
  prepareProjectJdk(
    targetDir: string,
    log: (line: string) => void,
    options?: { isCancelled?: () => boolean },
  ): Promise<boolean>;
}

export function loadGradleCore(): Promise<GradleCoreModule> {
  return loadDist<GradleCoreModule>(repoDist("core", "gradle.js"));
}

export function loadProjectJdk(): Promise<ProjectJdkModule> {
  return loadDist<ProjectJdkModule>(repoDist("core", "project-jdk.js"));
}

const gradleCorePromise = loadGradleCore();
const projectJdkPromise = loadProjectJdk();

export function getGradleCore(): Promise<GradleCoreModule> {
  return gradleCorePromise;
}

export function getProjectJdk(): Promise<ProjectJdkModule> {
  return projectJdkPromise;
}
