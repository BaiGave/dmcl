import type { JdkLogger, JdkOptions } from "./jdk.js";
import { readMcVersionFromProject } from "./jdk.js";
import { ensureProjectToolchain } from "./toolchain.js";
import fs from "node:fs";
import path from "node:path";
import { detectProject } from "../workspace/detect.js";
import { repairCrossLoaderProject } from "../workspace/cross-loader.js";

function readGradleProps(targetDir: string): Record<string, string> {
  const file = path.join(targetDir, "gradle.properties");
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** 构建/运行 Gradle 前确保项目 JDK 已配置 */
export async function prepareProjectJdk(
  targetDir: string,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<boolean> {
  try {
    const detected = detectProject(targetDir);
    if (detected) {
      const props = readGradleProps(targetDir);
      await repairCrossLoaderProject(
        targetDir,
        props.mod_id ?? detected.modId,
        props.mod_name ?? detected.displayName,
        props.maven_group ?? props.mod_group_id ?? detected.group,
        detected.loader,
        detected.mcVersion,
        log,
      );
    }

    const mc = readMcVersionFromProject(targetDir);
    if (!mc) {
      log("⚠ 无法从项目推断 Minecraft 版本，跳过 JDK 检查");
      return true;
    }
    await ensureProjectToolchain(targetDir, mc, log, options);
    return true;
  } catch (err) {
    if (options?.isCancelled?.() || (err as Error).message === "已取消") {
      log("已取消");
      return false;
    }
    log(`JDK 准备失败：${(err as Error).message}`);
    return false;
  }
}
