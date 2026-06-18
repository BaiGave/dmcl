#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { LOADER_LABELS, MAPPINGS_LABELS, DEFAULT_MAPPINGS, type LoaderId, type MappingsId, type ProjectOptions } from "./types.js";
import { resolveMappings } from "./meta/mappings-cache.js";
import { supportedVersions } from "./meta/versions.js";
import { applyChinaMirror } from "./core/mirror.js";
import { ensureForgeMavenizerJdkCache } from "./core/forge-mavenizer.js";
import {
  ensureProjectJdk,
  pickJdkMajor,
  readJavaHomeFromProject,
} from "./core/jdk.js";
import { scaffoldProject, pascalCase } from "./core/scaffold.js";
import { runGradleBuild, runGradleClientVerify } from "./core/build.js";
import {
  loadVersionVerificationPlan,
  runAllVersionVerifications,
  runVersionVerificationBatch,
} from "./workspace/version-verifier.js";

const MOD_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
const GROUP_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** 交互式 JDK 处理：按 Gradle / MC 版本选择兼容 JDK */
async function handleJdkInteractive(opts: ProjectOptions, log: (msg: string) => void): Promise<void> {
  await ensureProjectJdk(opts.targetDir, opts.mcVersion, log);
  await ensureForgeMavenizerJdkCache(opts.targetDir, log);
}

/** 非交互模式 JDK 处理（GUI 场景不能问用户） */
async function handleJdkNonInteractive(opts: ProjectOptions, log: (msg: string) => void): Promise<void> {
  await ensureProjectJdk(opts.targetDir, opts.mcVersion, log);
  await ensureForgeMavenizerJdkCache(opts.targetDir, log);
}

function printNextSteps(opts: ProjectOptions): void {
  const java = pickJdkMajor(opts.mcVersion, opts.targetDir);
  const configured = readJavaHomeFromProject(opts.targetDir);
  const lines: string[] = [];

  if (configured) {
    lines.push(pc.green(`✔ 已自动配置 JDK ${java}`));
    lines.push(pc.dim(`  ${configured}`));
  } else {
    lines.push(pc.green(`✔ 构建时将自动下载并配置 JDK ${java}（无需事先安装 Java）`));
  }

  lines.push("");
  lines.push("接下来：");
  lines.push(pc.cyan(`  cursor "${opts.targetDir}"`) + "   # 用 Cursor 打开项目（按提示安装 Java 扩展）");
  lines.push(pc.cyan(`  .\\gradlew build`) + "       # 首次构建会下载并反编译 Minecraft，可能要 5~20 分钟");
  lines.push(pc.cyan(`  .\\gradlew runClient`) + "   # 启动带模组的开发版客户端");

  p.note(lines.join("\n"), "环境就绪");
}

interface CliArgs {
  loader?: string;
  mc?: string;
  modid?: string;
  name?: string;
  group?: string;
  dir?: string;
  "no-mirror"?: boolean;
  mappings?: string;
  build?: boolean;
  "verify-versions"?: boolean;
  "verify-all"?: boolean;
  "verify-plan"?: boolean;
  "verify-limit"?: string;
  "verify-root"?: string;
  "verify-force"?: boolean;
  "keep-projects"?: boolean;
  yes?: boolean;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    options: {
      loader: { type: "string" },
      mc: { type: "string" },
      modid: { type: "string" },
      name: { type: "string" },
      group: { type: "string" },
      dir: { type: "string" },
      "no-mirror": { type: "boolean" },
      mappings: { type: "string" },
      build: { type: "boolean" },
      "verify-versions": { type: "boolean" },
      "verify-all": { type: "boolean" },
      "verify-plan": { type: "boolean" },
      "verify-limit": { type: "string" },
      "verify-root": { type: "string" },
      "verify-force": { type: "boolean" },
      "keep-projects": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
    allowPositionals: false,
  });
  return values as CliArgs;
}

function bail(message: string): never {
  p.cancel(message);
  process.exit(1);
}

function parseLoader(raw: string | undefined): LoaderId | undefined {
  if (raw === undefined) return undefined;
  if (raw === "fabric" || raw === "forge" || raw === "neoforge") return raw;
  bail(`鏈煡鍔犺浇鍣細${raw}`);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) bail(`verify-limit 闇€涓洪潪璐熸暣鏁帮細${raw}`);
  return n;
}

async function handleVersionVerification(args: CliArgs): Promise<void> {
  const loader = parseLoader(args.loader);
  const limit = parseLimit(args["verify-limit"]);
  const opts = {
    loader,
    mcVersion: args.mc,
    force: args["verify-force"] === true,
  };

  if (args["verify-plan"] && !args["verify-versions"]) {
    const plan = await loadVersionVerificationPlan(opts);
    const shown = plan.slice(0, limit ?? 30);
    console.log(JSON.stringify({
      planned: plan.length,
      shown: shown.length,
      targets: shown,
    }, null, 2));
    return;
  }

  const runOptions = {
    ...opts,
    limit,
    rootDir: args["verify-root"],
    mirror: !args["no-mirror"],
    keepProjects: args["keep-projects"] === true,
  };
  const result = args["verify-all"]
    ? await runAllVersionVerifications(runOptions, (msg) => console.log(msg))
    : await runVersionVerificationBatch(runOptions, (msg) => console.log(msg));
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = parseCli();

  if (args["verify-plan"] || args["verify-versions"] || args["verify-all"]) {
    await handleVersionVerification(args);
    return;
  }

  // ---------- 非交互模式 ----------
  if (args.yes) {
    if (!args.loader || !args.mc || !args.modid) {
      bail("非交互模式需要 --loader --mc --modid 参数");
    }
    const loader = args.loader as LoaderId;
    if (!["fabric", "forge", "neoforge"].includes(loader)) bail(`未知加载器：${args.loader}`);
    const modId = args.modid;
    if (!MOD_ID_RE.test(modId)) bail("modid 需为全小写字母/数字/下划线，且以字母开头");
    const displayName = args.name ?? pascalCase(modId);
    const mappingsRaw = args.mappings ?? DEFAULT_MAPPINGS[loader];
    if (!["yarn", "mojmap", "parchment"].includes(mappingsRaw)) bail(`未知映射表：${mappingsRaw}`);
    const opts: ProjectOptions = {
      loader,
      mcVersion: args.mc,
      modId,
      displayName,
      className: pascalCase(displayName),
      group: args.group ?? `com.example.${modId.replace(/_/g, "")}`,
      targetDir: path.resolve(args.dir ?? modId),
      mirror: !args["no-mirror"],
      mappings: mappingsRaw as MappingsId,
    };
    // GUI/管道场景下 spinner 输出不可靠，直接逐行打印
    const log = (msg: string) => console.log(msg);
    log("正在生成项目…");
    await scaffoldProject(opts, log);
    log("检查 JDK…");
    try {
      await handleJdkNonInteractive(opts, log);
    } catch (err) {
      log(`JDK 配置失败：${(err as Error).message}`);
      process.exit(1);
    }
    log(`✔ 项目已生成：${opts.targetDir}`);
    if (args.build) {
      const buildCode = await runGradleBuild(opts.targetDir, log);
      if (buildCode === 0) {
        await runGradleClientVerify(opts.targetDir, log);
      }
    }
    return;
  }

  // ---------- 交互模式 ----------
  console.clear();
  p.intro(pc.bgCyan(pc.black(" DMCL · Developer Minecraft Launcher ")));

  const loader = (await p.select({
    message: "选择模组加载器",
    options: [
      { value: "fabric", label: "Fabric", hint: "轻量、更新快，社区活跃" },
      { value: "neoforge", label: "NeoForge", hint: "Forge 的现代分支，1.20.1+" },
      { value: "forge", label: "Forge", hint: "老牌加载器，老版本覆盖最全" },
    ],
  })) as LoaderId;
  if (p.isCancel(loader)) bail("已取消");

  const s1 = p.spinner();
  s1.start(`正在获取 ${LOADER_LABELS[loader]} 支持的 Minecraft 版本`);
  let versions: string[];
  try {
    versions = await supportedVersions(loader);
  } catch (err) {
    s1.stop("获取版本列表失败");
    bail(`网络请求失败，请检查网络后重试：${(err as Error).message}`);
  }
  s1.stop(`共 ${versions.length} 个可用版本`);
  if (versions.length === 0) bail("没有可用版本");

  const mcVersion = (await p.select({
    message: "选择 Minecraft 版本",
    options: versions.map((v, i) => ({
      value: v,
      label: v,
      hint: i === 0 ? "最新" : undefined,
    })),
    maxItems: 12,
  })) as string;
  if (p.isCancel(mcVersion)) bail("已取消");

  const mappingsOptions = (await resolveMappings(loader, mcVersion)).options.map((o) => ({
    value: o.id,
    label: o.version ? `${o.label} (${o.version})` : o.label,
  }));
  const mappings = (mappingsOptions.length === 1)
    ? mappingsOptions[0].value as MappingsId
    : (await p.select({
        message: "选择映射表（Mappings）",
        options: mappingsOptions.length
          ? mappingsOptions
          : [{ value: DEFAULT_MAPPINGS[loader], label: MAPPINGS_LABELS[DEFAULT_MAPPINGS[loader]] }],
      })) as MappingsId;
  if (p.isCancel(mappings)) bail("已取消");

  const modId = (await p.text({
    message: "模组 ID（全小写，用于注册名/资源目录）",
    placeholder: "mymod",
    defaultValue: "mymod",
    validate: (v) => {
      if (v && !MOD_ID_RE.test(v)) return "需以小写字母开头，仅含小写字母、数字、下划线";
    },
  })) as string;
  if (p.isCancel(modId)) bail("已取消");

  const displayName = (await p.text({
    message: "模组显示名称",
    placeholder: "My Mod",
    defaultValue: pascalCase(modId),
  })) as string;
  if (p.isCancel(displayName)) bail("已取消");

  const group = (await p.text({
    message: "Java 包名（Maven group）",
    placeholder: `com.example.${modId.replace(/_/g, "")}`,
    defaultValue: `com.example.${modId.replace(/_/g, "")}`,
    validate: (v) => {
      if (v && !GROUP_RE.test(v)) return "形如 com.example.mymod 的小写包名";
    },
  })) as string;
  if (p.isCancel(group)) bail("已取消");

  const dirInput = (await p.text({
    message: "项目目录",
    placeholder: modId,
    defaultValue: modId,
  })) as string;
  if (p.isCancel(dirInput)) bail("已取消");
  const targetDir = path.resolve(dirInput);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    bail(`目录已存在且非空：${targetDir}`);
  }

  const mirror = (await p.confirm({
    message: "使用国内镜像加速 Gradle 下载？（海外网络选否）",
    initialValue: true,
  })) as boolean;
  if (p.isCancel(mirror)) bail("已取消");

  const opts: ProjectOptions = {
    loader,
    mcVersion,
    modId,
    displayName,
    className: pascalCase(displayName),
    group,
    targetDir,
    mirror,
    mappings,
  };

  const s2 = p.spinner();
  s2.start("正在生成项目");
  try {
    await scaffoldProject(opts, (msg) => s2.message(msg));
    s2.message("检查 JDK…");
    await handleJdkInteractive(opts, (msg) => s2.message(msg));
  } catch (err) {
    s2.stop("生成失败");
    bail((err as Error).message);
  }
  s2.stop(`项目已生成：${pc.bold(opts.targetDir)}`);

  // 询问是否立即构建验证
  const doBuild = await p.confirm({
    message: "是否立即运行 gradlew build 验证？（首次需下载 Minecraft，约 5~20 分钟）",
    initialValue: false,
  });
  if (!p.isCancel(doBuild) && doBuild) {
    p.intro(pc.bgCyan(pc.black(" 构建验证 ")));
    const buildCode = await runGradleBuild(opts.targetDir, console.log);
    if (buildCode === 0) {
      await runGradleClientVerify(opts.targetDir, console.log);
    }
  }

  printNextSteps(opts);
  p.outro("祝模组开发愉快！");
}

main().catch((err) => {
  p.cancel(`发生错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
