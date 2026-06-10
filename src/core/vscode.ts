import fs from "node:fs";
import path from "node:path";

/** 生成 Cursor / VS Code 工作区配置与扩展推荐 */
export async function writeCursorConfig(targetDir: string): Promise<void> {
  const dir = path.join(targetDir, ".vscode");
  await fs.promises.mkdir(dir, { recursive: true });

  const settings = {
    "java.import.gradle.enabled": true,
    "java.configuration.updateBuildConfiguration": "automatic",
    "files.eol": "\n",
  };
  const extensions = {
    recommendations: ["vscjava.vscode-java-pack", "vscjava.vscode-gradle"],
  };

  await fs.promises.writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify(settings, null, 2) + "\n",
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(dir, "extensions.json"),
    JSON.stringify(extensions, null, 2) + "\n",
    "utf8",
  );
}
