import type { ChildProcess } from "node:child_process";
import { getGradleCore } from "./gradle-core-bridge";

/** Kills a child process and everything it started (Gradle, its daemon, the game JVM). */
export async function killProcessTree(proc: ChildProcess, isWin: boolean): Promise<void> {
  const core = await getGradleCore();
  core.killProcessTree(proc, isWin);
}
