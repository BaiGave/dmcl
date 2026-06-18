import type { Logger, ProjectOptions } from "../types.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { scaffoldFabric } from "../loaders/fabric.js";
import { scaffoldForge } from "../loaders/forge.js";
import { scaffoldNeoForge } from "../loaders/neoforge.js";
import { applyChinaMirror } from "./mirror.js";
import { injectBuildscriptMirrors, injectMavenMirrors } from "./maven.js";
import { writeCursorConfig } from "./vscode.js";

export function pascalCase(input: string): string {
  const name = input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `Mod${name}`;
}

/** 下载模板、注入镜像、初始化 git — CLI 与变体生成共用 */
export async function scaffoldProject(opts: ProjectOptions, log: Logger): Promise<void> {
  await fs.promises.mkdir(opts.targetDir, { recursive: true });

  if (opts.loader === "fabric") await scaffoldFabric(opts, log);
  else if (opts.loader === "forge") await scaffoldForge(opts, log);
  else await scaffoldNeoForge(opts, log);

  if (opts.mirror) {
    await applyChinaMirror(opts.targetDir, log);
    await injectMavenMirrors(opts.targetDir, log);
    await injectBuildscriptMirrors(opts.targetDir, log);
  }

  await writeCursorConfig(opts.targetDir);
  log("已生成 Cursor / VS Code 配置（.vscode）");
  const git = spawnSync("git", ["init", "-q"], { cwd: opts.targetDir });
  if (git.status === 0) log("已初始化 git 仓库");
}
