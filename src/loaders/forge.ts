import path from "node:path";
import { urlExists } from "../core/http.js";
import { adaptTemplate, downloadAndExtract } from "../core/template.js";
import { patchProperties } from "../core/fsutils.js";
import { applyMappings } from "../core/mappings.js";
import { forgeMdkUrl, pickForgeVersion } from "../meta/forge.js";
import type { Logger, ProjectOptions } from "../types.js";

export async function scaffoldForge(opts: ProjectOptions, log: Logger): Promise<void> {
  const forgeVersion = await pickForgeVersion(opts.mcVersion);
  if (!forgeVersion) {
    throw new Error(`Forge 不支持 Minecraft ${opts.mcVersion}`);
  }
  const url = forgeMdkUrl(opts.mcVersion, forgeVersion);
  if (!(await urlExists(url))) {
    throw new Error(`该版本的 Forge MDK 不存在（过老的版本不提供 MDK）：${url}`);
  }

  log(`下载 Forge ${forgeVersion} MDK…`);
  await downloadAndExtract(url, opts.targetDir);

  // 必须先做全局占位符替换，再补丁 properties，否则新写入的值会被二次替换
  log("替换模板占位符…");
  await adaptTemplate(opts, {
    modIdToken: "examplemod",
    classToken: "ExampleMod",
    displayToken: "Example Mod",
  });

  const gradleProps = path.join(opts.targetDir, "gradle.properties");
  const patched = await patchProperties(gradleProps, {
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
