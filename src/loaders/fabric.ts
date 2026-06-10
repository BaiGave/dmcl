import path from "node:path";
import fs from "node:fs";
import { urlExists } from "../core/http.js";
import { adaptTemplate, downloadAndExtract } from "../core/template.js";
import { patchProperties } from "../core/fsutils.js";
import {
  fetchFabricApiVersion,
  fetchFabricLoaderVersion,
  fetchYarnVersion,
} from "../meta/fabric.js";
import type { Logger, ProjectOptions } from "../types.js";

/** fabric-example-mod 按 MC 大版本拆分支，找不到就退回 master */
function branchCandidates(mcVersion: string): string[] {
  const out: string[] = [];
  if (mcVersion.startsWith("1.")) {
    const [major, minor] = mcVersion.split(".");
    out.push(`${major}.${minor}`);
  }
  out.push("master");
  return out;
}

export async function scaffoldFabric(opts: ProjectOptions, log: Logger): Promise<void> {
  let zipUrl: string | null = null;
  for (const branch of branchCandidates(opts.mcVersion)) {
    const url = `https://codeload.github.com/FabricMC/fabric-example-mod/zip/refs/heads/${branch}`;
    if (await urlExists(url)) {
      log(`使用官方模板分支 ${branch}`);
      zipUrl = url;
      break;
    }
  }
  if (!zipUrl) throw new Error("未找到可用的 Fabric 模板分支");

  log("下载模板…");
  await downloadAndExtract(zipUrl, opts.targetDir);

  // 元数据查询失败不应中断生成：模板自带的版本号仍然可用
  log("查询 Fabric 各组件版本…");
  const [loaderVersion, yarnVersion, apiVersion] = await Promise.all([
    fetchFabricLoaderVersion().catch(() => null),
    fetchYarnVersion(opts.mcVersion),
    fetchFabricApiVersion(opts.mcVersion),
  ]);

  // 必须先做全局占位符替换，再补丁 properties，否则新写入的值会被二次替换
  log("替换模板占位符…");
  await adaptTemplate(opts, {
    modIdToken: "modid",
    classToken: "ExampleMod",
    displayToken: "Example Mod",
  });

  const gradleProps = path.join(opts.targetDir, "gradle.properties");
  const patched = await patchProperties(gradleProps, {
    minecraft_version: opts.mcVersion,
    yarn_mappings: yarnVersion,
    loader_version: loaderVersion,
    // 不同分支的键名不同，两个都尝试
    fabric_version: apiVersion,
    fabric_api_version: apiVersion,
    mod_version: "0.1.0",
    maven_group: opts.group,
    archives_base_name: opts.modId,
  });
  log(`已更新 gradle.properties（${patched.join(", ")}）`);

  // 模板自带的 LICENSE 是 CC0 模板文件，提醒用户自行决定
  const licenseFile = path.join(opts.targetDir, "LICENSE");
  if (fs.existsSync(licenseFile)) {
    log("注意：模板附带 CC0 LICENSE，可按需修改");
  }
}
