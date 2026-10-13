import fs from "node:fs";
import path from "node:path";

/**
 * 项目由 DMCL 脚手架生成（带 `.dmcl/scaffold.json`），DMCL 才可改写其构建文件、Gradle Wrapper 或删除其目录。
 * 导入项目即使位于工作区 projects 目录或写过 .dmcl 工具链记录也不算。
 */
export function hasScaffoldMarker(targetDir: string): boolean {
  return fs.existsSync(path.join(path.resolve(targetDir), ".dmcl", "scaffold.json"));
}
