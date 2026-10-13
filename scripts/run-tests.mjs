#!/usr/bin/env node
/**
 * Runs the test suite against a throwaway sandbox so tests never touch the user's real
 * ~/.dmcl, %LOCALAPPDATA%\DMCL, Gradle home or the Linker host-activity registry.
 * Every home-like variable is pointed into one temp directory that is removed afterwards
 * (set DMCL_KEEP_TEST_SANDBOX=1 to keep it for debugging).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dmcl-test-"));
const dir = (name) => {
  const full = path.join(sandbox, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
};

const home = dir("home");
const tmp = dir("tmp");
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  DMCL_HOME: dir("dmcl"),
  LOCALAPPDATA: dir("localappdata"),
  APPDATA: dir("appdata"),
  XDG_DATA_HOME: dir("xdg-data"),
  GRADLE_USER_HOME: dir("gradle"),
  TEMP: tmp,
  TMP: tmp,
  TMPDIR: tmp,
  DMCL_TEST_SANDBOX: sandbox,
};
delete env.DMCL_VERSION_VERIFICATION_FILE;

const patterns = process.argv.slice(2);
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const result = spawnSync(
  process.execPath,
  [tsxCli, "--test", ...(patterns.length ? patterns : ["tests/**/*.test.ts"])],
  { cwd: repoRoot, env, stdio: "inherit" },
);

if (process.env.DMCL_KEEP_TEST_SANDBOX) {
  console.log(`test sandbox kept: ${sandbox}`);
} else {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(result.status ?? 1);
