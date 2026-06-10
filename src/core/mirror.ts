import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../types.js";

/** 将 Gradle wrapper 分发地址切换为腾讯云镜像（国内下载提速明显） */
export async function applyChinaMirror(targetDir: string, log: Logger): Promise<void> {
  const wrapperProps = path.join(targetDir, "gradle", "wrapper", "gradle-wrapper.properties");
  if (!fs.existsSync(wrapperProps)) {
    log("未找到 gradle-wrapper.properties，跳过镜像配置");
    return;
  }
  let content = await fs.promises.readFile(wrapperProps, "utf8");
  const before = content;
  content = content.replace(
    /services\.gradle\.org\/distributions/g,
    "mirrors.cloud.tencent.com/gradle",
  );
  if (content !== before) {
    await fs.promises.writeFile(wrapperProps, content, "utf8");
    log("Gradle 下载源已切换至腾讯云镜像");
  }
}
