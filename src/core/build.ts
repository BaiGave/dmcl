import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../types.js";

/**
 * 在项目目录中运行 `gradlew build`，流式输出进度。
 * 返回 exit code（0 = 成功）。
 * 先确保 gradlew 可执行（非 Windows 平台）。
 */
export async function runGradleBuild(targetDir: string, log: Logger, onComplete?: (ok: boolean) => void): Promise<number> {
  const isWin = process.platform === "win32";
  const cmd = isWin ? "gradlew.bat" : "./gradlew";
  const gradlew = path.join(targetDir, cmd);

  if (!fs.existsSync(gradlew)) {
    log("未找到 gradlew，跳过构建验证");
    return 1;
  }

  // 非 Windows 上确保可执行
  if (!isWin) {
    try { await fs.promises.chmod(gradlew, 0o755); } catch {}
  }

  log("運行首次構建（gradlew build）…");
  log("這會下載並反編譯 Minecraft，可能需要 5~20 分鐘");

  return new Promise((resolve) => {
    const proc = spawn(gradlew, ["build"], {
      cwd: targetDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
    });

    let lastLog = "";
    const update = (data: Buffer) => {
      const text = data.toString("utf8");
      // 只汇报重要的构建阶段
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith(">") || trimmed.includes("BUILD") || trimmed.includes("FAILURE") || 
            /^\d+%/.test(trimmed) || trimmed.includes("Download") || trimmed.includes("FAILED")) {
          log(trimmed.substring(0, 120));
          lastLog = trimmed;
        }
      }
    };

    proc.stdout?.on("data", update);
    proc.stderr?.on("data", update);

    proc.on("close", (code) => {
      const ok = code === 0;
      log(ok ? "构建成功！" : `构建失敗 (exit ${code})，但項目文件已就緒`);
      onComplete?.(ok);
      resolve(code ?? 1);
    });

    proc.on("error", (err) => {
      log(`構建啟動失敗：${err.message}`);
      onComplete?.(false);
      resolve(1);
    });
  });
}
