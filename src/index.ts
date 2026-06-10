#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { LOADER_LABELS, type LoaderId, type ProjectOptions } from "./types.js";
import { fetchReleaseVersions } from "./meta/mojang.js";
import { fetchFabricGameVersions } from "./meta/fabric.js";
import { forgeSupportedMcVersions } from "./meta/forge.js";
import { fetchNeoForgeVersions, pickNeoForgeVersion } from "./meta/neoforge.js";
import { scaffoldFabric } from "./loaders/fabric.js";
import { scaffoldForge } from "./loaders/forge.js";
import { scaffoldNeoForge } from "./loaders/neoforge.js";
import { applyChinaMirror } from "./core/mirror.js";
import { writeCursorConfig } from "./core/vscode.js";
import { adoptiumDownloadUrl, detectJavaMajor, requiredJavaFor } from "./core/jdk.js";

const MOD_ID_RE = /^[a-z][a-z0-9_]{1,63}$/;
const GROUP_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

function pascalCase(input: string): string {
  const name = input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : `Mod${name}`;
}

async function supportedVersions(loader: LoaderId, releases: string[]): Promise<string[]> {
  if (loader === "fabric") {
    const fab = new Set(await fetchFabricGameVersions());
    return releases.filter((v) => fab.has(v));
  }
  if (loader === "forge") {
    const set = await forgeSupportedMcVersions();
    return releases.filter((v) => set.has(v));
  }
  const versions = await fetchNeoForgeVersions();
  return releases.filter((v) => pickNeoForgeVersion(versions, v) !== null);
}

async function scaffold(opts: ProjectOptions, log: (msg: string) => void): Promise<void> {
  await fs.promises.mkdir(opts.targetDir, { recursive: true });

  if (opts.loader === "fabric") await scaffoldFabric(opts, log);
  else if (opts.loader === "forge") await scaffoldForge(opts, log);
  else await scaffoldNeoForge(opts, log);

  if (opts.mirror) await applyChinaMirror(opts.targetDir, log);

  await writeCursorConfig(opts.targetDir);
  log("已生成 Cursor / VS Code 配置（.vscode）");

  const git = spawnSync("git", ["init", "-q"], { cwd: opts.targetDir });
  if (git.status === 0) log("已初始化 git 仓库");
}

function printNextSteps(opts: ProjectOptions): void {
  const java = requiredJavaFor(opts.mcVersion);
  const detected = detectJavaMajor();
  const lines: string[] = [];

  if (detected === null) {
    lines.push(pc.yellow(`⚠ 未检测到 Java。该版本需要 JDK ${java}，请先安装：`));
    lines.push(pc.yellow(`  ${adoptiumDownloadUrl(java)}`));
  } else if (detected < java) {
    lines.push(pc.yellow(`⚠ 当前 Java ${detected} 过旧，该版本需要 JDK ${java}：`));
    lines.push(pc.yellow(`  ${adoptiumDownloadUrl(java)}`));
  } else {
    lines.push(pc.green(`✔ Java ${detected} 满足要求（需要 ≥ ${java}）`));
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

async function main(): Promise<void> {
  const args = parseCli();

  console.clear();
  p.intro(pc.bgCyan(pc.black(" mcdev-wizard · Minecraft 模组开发环境一键搭建 ")));

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
    const opts: ProjectOptions = {
      loader,
      mcVersion: args.mc,
      modId,
      displayName,
      className: pascalCase(displayName),
      group: args.group ?? `com.example.${modId.replace(/_/g, "")}`,
      targetDir: path.resolve(args.dir ?? modId),
      mirror: !args["no-mirror"],
    };
    const s = p.spinner();
    s.start("正在生成项目");
    await scaffold(opts, (msg) => s.message(msg));
    s.stop(`项目已生成：${opts.targetDir}`);
    printNextSteps(opts);
    p.outro("完成");
    return;
  }

  // ---------- 交互模式 ----------
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
    const releases = await fetchReleaseVersions();
    versions = await supportedVersions(loader, releases);
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
  };

  const s2 = p.spinner();
  s2.start("正在生成项目");
  try {
    await scaffold(opts, (msg) => s2.message(msg));
  } catch (err) {
    s2.stop("生成失败");
    bail((err as Error).message);
  }
  s2.stop(`项目已生成：${pc.bold(opts.targetDir)}`);

  printNextSteps(opts);
  p.outro("祝模组开发愉快！");
}

main().catch((err) => {
  p.cancel(`发生错误：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
