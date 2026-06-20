import path from "node:path";
import { adaptTemplate, downloadAndExtract } from "../core/template.js";
import { patchProperties } from "../core/fsutils.js";
import { applyMappings } from "../core/mappings.js";
import { pickForgeVersion, resolveForgeMdkUrl } from "../meta/forge.js";
import type { Logger, ProjectOptions } from "../types.js";

export async function scaffoldForge(opts: ProjectOptions, log: Logger): Promise<void> {
  const forgeVersion = await pickForgeVersion(opts.mcVersion);
  if (!forgeVersion) {
    throw new Error(`Forge 不支持 Minecraft ${opts.mcVersion}`);
  }
  const resolved = await resolveForgeMdkUrl(
    opts.mcVersion,
    forgeVersion,
    opts.mirror !== false,
  );
  if (resolved.status === "missing") {
    throw new Error(
      `Forge ${opts.mcVersion}-${forgeVersion} 的 MDK 在 Maven 上未发布（404）。`
        + ` 若这是极新版本，可能尚未同步 MDK；可稍后再试或换 NeoForge。\n${resolved.tried[0]}`,
    );
  }
  if (resolved.status === "unreachable") {
    throw new Error(
      `无法连接 Forge MDK 下载源（网络超时），并非版本过老。`
        + ` 请检查网络/代理，或在设置中确认镜像已开启后重试。\n${resolved.tried.join("\n")}`,
    );
  }

  log(`下载 Forge ${forgeVersion} MDK…`);
  await downloadAndExtract(resolved.url, opts.targetDir);

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
