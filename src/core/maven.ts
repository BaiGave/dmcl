import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../types.js";

const MIRRORS: Array<{ name: string; url: string }> = [
  { name: "BMCLAPI", url: "https://bmclapi2.bangbang93.com/maven" },
  { name: "Alibaba", url: "https://maven.aliyun.com/repository/public" },
];

/**
 * 在 settings.gradle / build.gradle 中注入国内 Maven 镜像。
 * 策略：在已有的 repositories {} 顶部插入 mirror，覆盖默认 Maven Central。
 */
export async function injectMavenMirrors(targetDir: string, log: Logger): Promise<void> {
  const settingsFile = path.join(targetDir, "settings.gradle");
  if (!fs.existsSync(settingsFile)) {
    log("未找到 settings.gradle，跳过 Maven 镜像注入");
    return;
  }
  let content = await fs.promises.readFile(settingsFile, "utf8");

  // 生成 mirror 代码片段
  const snippet = MIRRORS.map(
    (m) => `        maven { name = "${m.name}"; url = "${m.url}" }`,
  ).join("\n");

  // 在 pluginManagement.repositories { 内部注入
  if (/pluginManagement\s*\{/.test(content)) {
    content = content.replace(
      /(pluginManagement\s*\{[\s\S]*?repositories\s*\{)/,
      `$1\n${snippet}`,
    );
  }

  // 在 dependencyResolutionManagement.repositories { 内部注入
  if (/dependencyResolutionManagement\s*\{/.test(content)) {
    content = content.replace(
      /(dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{)/,
      `$1\n${snippet}`,
    );
  }

  // 通用：第一个 repositories { 块注入
  if (!/BMCLAPI/.test(content)) {
    content = content.replace(
      /(repositories\s*\{)/,
      `$1\n${snippet}`,
    );
  }

  await fs.promises.writeFile(settingsFile, content, "utf8");
  log("Maven 仓库已切换至国内镜像（BMCLAPI + Alibaba）");
}

/**
 * 在 build.gradle 中注入国内镜像（适用于 Forge MDK 等使用 buildscript 的项目）。
 */
export async function injectBuildscriptMirrors(targetDir: string, log: Logger): Promise<void> {
  const buildFile = path.join(targetDir, "build.gradle");
  if (!fs.existsSync(buildFile)) return;
  let content = await fs.promises.readFile(buildFile, "utf8");
  if (/BMCLAPI/.test(content)) return;

  const snippet = MIRRORS.map(
    (m) => `        maven { url "${m.url}" }`,
  ).join("\n");

  // buildscript.repositories { } 注入
  content = content.replace(
    /(buildscript\s*\{[\s\S]*?repositories\s*\{)/,
    `$1\n${snippet}`,
  );

  // 普通 repositories { } 注入（避免重复）
  content = content.replace(
    /(?<!buildscript\s*\{[\s\S]*)(repositories\s*\{)/,
    `$1\n${snippet}`,
  );

  await fs.promises.writeFile(buildFile, content, "utf8");
  log("build.gradle 仓库已注入国内镜像");
}
