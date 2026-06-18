import type { JdkLogger, JdkOptions } from "./jdk.js";
import { ensureProjectJdk, readMcVersionFromProject } from "./jdk.js";
import { ensureForgeMavenizerJdkCache } from "./forge-mavenizer.js";

/** 构建/运行 Gradle 前确保项目 JDK 已配置 */
export async function prepareProjectJdk(
  targetDir: string,
  log: JdkLogger,
  options?: JdkOptions,
): Promise<boolean> {
  try {
    const mc = readMcVersionFromProject(targetDir);
    if (!mc) {
      log("⚠ 无法从项目推断 Minecraft 版本，跳过 JDK 检查");
      return true;
    }
    await ensureProjectJdk(targetDir, mc, log, options);
    await ensureForgeMavenizerJdkCache(targetDir, log, options);
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
