import fs from "node:fs";
import path from "node:path";
import type { LoaderId, Logger } from "../types.js";
import { ensureProjectToolchain } from "../core/toolchain.js";
import { detectProject } from "./detect.js";
import { repairCrossLoaderProject } from "./cross-loader.js";
import {
  prewarmForgeMavenizerLibraries,
  prewarmForgeMavenizerMcpTools,
} from "../core/forge-mavenizer.js";

const TRANSIENT_NETWORK_PATTERNS = [
  /HttpConnectTimeoutException/i,
  /SocketTimeoutException/i,
  /HTTP connect timed out/i,
  /connect timed out/i,
  /Read timed out/i,
  /Connection reset/i,
  /UnknownHostException/i,
  /No route to host/i,
];

function isLikelyTransientFailure(lines: string[]): boolean {
  return TRANSIENT_NETWORK_PATTERNS.some((pattern) => lines.some((line) => pattern.test(line)));
}

export type VerificationFixId =
  | "toolchain"
  | "cross-loader"
  | "fabric-api"
  | "forge-mavenizer"
  | "forge-mcp-tools";

export interface VerificationFixPlan {
  fixes: VerificationFixId[];
  notes: string[];
}

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

/** 根据失败日志规划可尝试的自动修复项（纯分析，便于测试） */
export function planVerificationFixes(
  logText: string,
  loader: LoaderId,
): VerificationFixPlan {
  const fixes: VerificationFixId[] = [];
  const notes: string[] = [];
  const lines = logText.split("\n");

  if (/JDK 准备失败|org\.gradle\.java\.home|需要 Java \d+|Gradle.*requires Java|incompatible.*Java|toolchain|minimum Gradle/i.test(logText)) {
    fixes.push("toolchain");
    notes.push("检测到 JDK / Gradle 工具链问题");
  }

  if (loader === "forge" && /ModInitializer|net\.fabricmc|fabric\.mod\.json/i.test(logText)) {
    fixes.push("cross-loader");
    notes.push("Forge 项目中混入了 Fabric 源码或元数据");
  }

  if (loader === "fabric" && /Incompatible mods|Fabric API|fabric-api|有不兼容的模组/i.test(logText)) {
    fixes.push("fabric-api");
    notes.push("Fabric API 与 MC 版本不匹配");
  }

  if (loader === "forge" && /Mavenizer|mavenizer|Slime Launcher|Could not (download|resolve|GET).*minecraft/i.test(logText)) {
    fixes.push("forge-mavenizer");
    notes.push("Forge Mavenizer 依赖或元数据缺失");
  }

  if (loader === "forge" && /MCP|mcp_snapshot|mapping/i.test(logText) && /Could not|Cannot|failed/i.test(logText)) {
    fixes.push("forge-mcp-tools");
    notes.push("Forge MCP 工具链可能未预热");
  }

  if (/Timeout waiting to lock|Could not acquire lock|file lock|Gradle build daemon/i.test(logText)) {
    notes.push("Gradle 缓存锁争用，建议降低 --parallel 后重试");
  }

  if (isLikelyTransientFailure(lines)) {
    notes.push("检测到疑似网络超时，将配合诊断构建重试");
  }

  return { fixes: [...new Set(fixes)], notes };
}

export interface VerificationFixResult {
  applied: VerificationFixId[];
  notes: string[];
}

export async function applyVerificationFixes(
  projectPath: string,
  loader: LoaderId,
  mcVersion: string,
  logText: string,
  log: Logger = () => {},
): Promise<VerificationFixResult> {
  const plan = planVerificationFixes(logText, loader);
  const applied: VerificationFixId[] = [];

  for (const fix of plan.fixes) {
    try {
      if (fix === "toolchain") {
        await ensureProjectToolchain(projectPath, mcVersion, log);
        applied.push(fix);
        continue;
      }

      if (fix === "cross-loader") {
        const detected = detectProject(projectPath);
        if (!detected) continue;
        const props = readGradleProps(projectPath);
        const repaired = await repairCrossLoaderProject(
          projectPath,
          props.mod_id ?? detected.modId,
          props.mod_name ?? detected.displayName,
          props.maven_group ?? props.mod_group_id ?? detected.group,
          loader,
          mcVersion,
          log,
        );
        if (repaired) applied.push(fix);
        continue;
      }

      if (fix === "fabric-api") {
        const { ensureFabricApiVersion } = await import("../loaders/fabric-toolchain.js");
        await ensureFabricApiVersion(projectPath, log);
        applied.push(fix);
        continue;
      }

      if (fix === "forge-mavenizer") {
        const warmed = await prewarmForgeMavenizerLibraries(projectPath, log);
        if (warmed.total > 0) applied.push(fix);
        continue;
      }

      if (fix === "forge-mcp-tools") {
        const count = await prewarmForgeMavenizerMcpTools(projectPath, log);
        if (count > 0) applied.push(fix);
      }
    } catch (err) {
      log(`自动修复 ${fix} 失败：${(err as Error).message}`);
    }
  }

  return { applied, notes: plan.notes };
}
