import type { ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { getGradleCore, getProjectJdk } from "./gradle-core-bridge";

let verificationCancelled = false;

export function setVerificationCancelled(cancelled: boolean): void {
  verificationCancelled = cancelled;
}

export function isVerificationCancelled(): boolean {
  return verificationCancelled;
}

export async function killProcessTree(proc: ChildProcess, isWin: boolean): Promise<void> {
  const core = await getGradleCore();
  core.killProcessTree(proc, isWin);
}

async function prepareProjectJdkForBuild(
  targetDir: string,
  log: (line: string) => void,
): Promise<boolean> {
  const jdk = await getProjectJdk();
  return jdk.prepareProjectJdk(targetDir, log, {
    isCancelled: () => verificationCancelled,
  });
}

/** gradlew build --no-daemon（向导流式 HTTP 输出） */
export async function runBuild(
  targetDir: string,
  res: ServerResponse,
  onDone: (code: number) => void,
): Promise<ChildProcess | null> {
  const core = await getGradleCore();
  const sep = "─".repeat(40);
  res.write(`${sep}\n`);
  res.write("正在验证构建（首次需要下载 Minecraft 等依赖，约 5~20 分钟，请耐心等待）…\n");

  const jdkOk = await prepareProjectJdkForBuild(targetDir, (line) => res.write(line + "\n"));
  if (!jdkOk || verificationCancelled) {
    res.write(`${sep}\n`);
    res.write(verificationCancelled ? "已取消\n" : "构建失败：JDK 环境准备未完成\n");
    onDone(1);
    return null;
  }

  res.write(`${sep}\n`);
  let procRef: ChildProcess | null = null;
  const code = await core.runGradleBuildTask(
    targetDir,
    (line: string) => res.write(line + "\n"),
    {
      isCancelled: () => verificationCancelled,
      onProc: (proc: ChildProcess) => { procRef = proc; },
    },
  );

  res.write(`${sep}\n`);
  if (verificationCancelled) {
    res.write("已取消\n");
    onDone(1);
    return procRef;
  }
  res.write(code === 0 ? "✔ 构建验证通过\n" : `构建失败（退出码 ${code}），请检查上方日志\n`);
  onDone(code);
  return procRef;
}

/** gradlew runClient（向导客户端验证） */
export async function runClientVerify(
  targetDir: string,
  res: ServerResponse,
  onDone: (code: number) => void,
): Promise<ChildProcess | null> {
  const core = await getGradleCore();
  const sep = "─".repeat(40);
  res.write(`${sep}\n`);
  res.write("正在启动 Minecraft 客户端验证（会弹出游戏窗口，加载成功后自动关闭）…\n");

  const jdkOk = await prepareProjectJdkForBuild(targetDir, (line) => res.write(line + "\n"));
  if (!jdkOk || verificationCancelled) {
    res.write(`${sep}\n`);
    res.write(verificationCancelled ? "已取消\n" : "客户端验证失败：JDK 环境准备未完成\n");
    onDone(1);
    return null;
  }

  res.write(`${sep}\n`);
  let procRef: ChildProcess | null = null;
  const code = await core.runGradleClientTask(
    targetDir,
    (line: string) => {
      if (core.CLIENT_FAIL.some((p) => p.test(line))) return;
      if (core.shouldEmitGradleLine(line)) res.write(line + "\n");
    },
    {
      mode: "verify",
      isCancelled: () => verificationCancelled,
      onProc: (proc: ChildProcess) => { procRef = proc; },
    },
  );

  res.write(`${sep}\n`);
  if (verificationCancelled) {
    res.write("已取消\n");
    onDone(1);
    return procRef;
  }
  res.write(
    code === 0
      ? "✔ 客户端验证通过，项目可以直接使用！\n"
      : "客户端验证失败，请检查上方日志\n",
  );
  onDone(code);
  return procRef;
}
