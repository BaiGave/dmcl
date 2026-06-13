import path from "node:path";
import { urlExists } from "../core/http.js";
import { adaptTemplate, downloadAndExtract } from "../core/template.js";
import { patchProperties } from "../core/fsutils.js";
import { applyMappings } from "../core/mappings.js";
import { fetchNeoForgeVersions, neoMdkZipCandidates, pickNeoForgeVersion } from "../meta/neoforge.js";
import type { Logger, ProjectOptions } from "../types.js";

export async function scaffoldNeoForge(opts: ProjectOptions, log: Logger): Promise<void> {
  const versions = await fetchNeoForgeVersions();
  const neoVersion = pickNeoForgeVersion(versions, opts.mcVersion);
  if (!neoVersion) {
    throw new Error(`NeoForge 不支持 Minecraft ${opts.mcVersion}（NeoForge 从 1.20.1 开始提供）`);
  }

  let zipUrl: string | null = null;
  for (const url of neoMdkZipCandidates(opts.mcVersion)) {
    if (await urlExists(url)) {
      zipUrl = url;
      break;
    }
  }
  if (!zipUrl) {
    throw new Error(`未找到 Minecraft ${opts.mcVersion} 的官方 NeoForge MDK 模板仓库`);
  }

  log(`下载 NeoForge MDK 模板（NeoForge ${neoVersion}）…`);
  await downloadAndExtract(zipUrl, opts.targetDir);

  // 必须先做全局占位符替换，再补丁 properties，否则新写入的值会被二次替换
  log("替换模板占位符…");
  await adaptTemplate(opts, {
    modIdToken: "examplemod",
    classToken: "ExampleMod",
    displayToken: "Example Mod",
  });

  const gradleProps = path.join(opts.targetDir, "gradle.properties");
  const patched = await patchProperties(gradleProps, {
    neo_version: neoVersion,
    minecraft_version: opts.mcVersion,
    mod_id: opts.modId,
    mod_name: opts.displayName,
    mod_group_id: opts.group,
    mod_version: "0.1.0",
    mod_authors: "YourName",
    mod_description: `${opts.displayName} - 使用 DMCL 生成`,
  });
  if (patched.length > 0) log(`已更新 gradle.properties（${patched.join(", ")}）`);

  await applyMappings(opts, log);
}
