import fs from "node:fs";
import path from "node:path";
import { patchProperties } from "./fsutils.js";
import { fetchParchmentVersion } from "../meta/parchment.js";
import type { Logger, MappingsId, ProjectOptions } from "../types.js";

/**
 * 根据 mappings 选择，修改项目的 gradle.properties 和 build.gradle / settings.gradle。
 * 调用时机：占位符替换之后，镜像注入之前。
 */
export async function applyMappings(opts: ProjectOptions, log: Logger): Promise<void> {
  if (opts.loader === "fabric") {
    await applyFabricMappings(opts, log);
  } else {
    await applyParchmentForForge(opts, log);
  }
}

async function applyFabricMappings(opts: ProjectOptions, log: Logger): Promise<void> {
  const propsFile = path.join(opts.targetDir, "gradle.properties");
  const buildFile = path.join(opts.targetDir, "build.gradle");
  const settingsFile = path.join(opts.targetDir, "settings.gradle");

  if (opts.mappings === "mojmap" || opts.mappings === "parchment") {
    // Loom 1.x 通过 variant 切换官方映射
    const patched = await patchProperties(propsFile, {
      mappings_variant: "minecraft",
    });
    if (patched.length) log(`已设置 mappings_variant=minecraft`);
  }

  if (opts.mappings === "parchment") {
    const parchmentVer = await fetchParchmentVersion(opts.mcVersion);
    if (!parchmentVer) {
      log("⚠ 未找到该版本的 Parchment 映射，退回使用 MojMap");
      return;
    }
    log(`使用 Parchment ${parchmentVer}`);

    // gradle.properties 追加 parchment 属性
    await patchProperties(propsFile, {
      parchment_minecraft_version: opts.mcVersion,
      parchment_version: parchmentVer,
    });

    // settings.gradle 追加 parchment maven 仓库
    if (fs.existsSync(settingsFile)) {
      let settingsContent = await fs.promises.readFile(settingsFile, "utf8");
      if (!settingsContent.includes("parchmentmc")) {
        settingsContent = settingsContent.replace(
          /(dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{)/,
          `$1\n        maven { url = "https://maven.parchmentmc.org/" }`,
        );
        await fs.promises.writeFile(settingsFile, settingsContent, "utf8");
        log("已注入 Parchment Maven 仓库到 settings.gradle");
      }
    }
  }
}

async function applyParchmentForForge(opts: ProjectOptions, log: Logger): Promise<void> {
  if (opts.mappings !== "parchment") return; // Forge/NeoForge 默认就是 MojMap

  const parchmentVer = await fetchParchmentVersion(opts.mcVersion);
  if (!parchmentVer) {
    log("⚠ 未找到该版本的 Parchment 映射，继续使用默认 MojMap");
    return;
  }
  log(`使用 Parchment ${parchmentVer}`);

  const propsFile = path.join(opts.targetDir, "gradle.properties");
  await patchProperties(propsFile, {
    parchment_version: parchmentVer,
  });

  // Forge/NeoForge: 在 build.gradle 的 dependencies 块之前注入 parchment maven
  const buildFile = path.join(opts.targetDir, "build.gradle");
  if (fs.existsSync(buildFile)) {
    let content = await fs.promises.readFile(buildFile, "utf8");
    if (!content.includes("parchmentmc")) {
      const snippet = [
        "repositories {",
        "    maven { url = \"https://maven.parchmentmc.org/\" }",
        "}",
        "",
      ].join("\n");
      // 插入到文件顶部第一个 import/plugin/buildscript 之后
      const insertAfter = /(plugins\s*\{[\s\S]*?\})/;
      if (insertAfter.test(content)) {
        content = content.replace(insertAfter, `$1\n\n${snippet}`);
      } else {
        content = `${snippet}\n${content}`;
      }
      await fs.promises.writeFile(buildFile, content, "utf8");
      log("已注入 Parchment Maven 仓库到 build.gradle");
    }
  }
}
