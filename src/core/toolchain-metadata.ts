import fs from "node:fs";
import path from "node:path";
import type { LoaderId } from "../types.js";

/** `.dmcl/toolchain.json`：DMCL 为项目选定的工具链；导入项目的 JDK 只记录在这里，不写 gradle.properties */
export interface ToolchainMetadata {
  mcVersion: string;
  loader: LoaderId | null;
  gradleVersion: string | null;
  jdkMajor: number;
  /** 启动 Gradle 时传入的 JDK 目录 */
  javaHome: string;
  compileJavaMajor: number;
  loomVersion: string | null;
  configuredAt: string;
}

function toolchainMetadataPath(targetDir: string): string {
  return path.join(targetDir, ".dmcl", "toolchain.json");
}

/** 读取已记录的工具链；旧版记录可能缺少字段，文件缺失或损坏时返回 null */
export function readToolchainMetadata(targetDir: string): Partial<ToolchainMetadata> | null {
  try {
    const meta = JSON.parse(fs.readFileSync(toolchainMetadataPath(targetDir), "utf8")) as unknown;
    return meta && typeof meta === "object" ? meta as Partial<ToolchainMetadata> : null;
  } catch {
    return null;
  }
}

export async function saveToolchainMetadata(targetDir: string, meta: ToolchainMetadata): Promise<void> {
  const file = toolchainMetadataPath(targetDir);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
