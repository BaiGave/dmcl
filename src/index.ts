#!/usr/bin/env node
import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { LOADER_LABELS, MAPPINGS_FOR_LOADER, MAPPINGS_LABELS, type LoaderId, type MappingsId, type ProjectOptions } from "./types.js";
import { fetchReleaseVersions } from "./meta/mojang.js";
import { supportedVersions } from "./meta/versions.js";
import { scaffoldFabric } from "./loaders/fabric.js";
import { scaffoldForge } from "./loaders/forge.js";
import { scaffoldNeoForge } from "./loaders/neoforge.js";
import { applyChinaMirror } from "./core/mirror.js";
import { writeCursorConfig } from "./core/vscode.js";
import {
  detectJavaMajor,
  downloadWithFallback,
  extractJdk,
  fetchJdkDownloadUrl,
  findCachedJdk,
  injectJdkHome,
  jdkMirrorUrl,
  requiredJavaFor,
} from "./core/jdk.js";
import { injectBuildscriptMirrors, injectMavenMirrors } from "./core/maven.js";
import { runGradleBuild, runGradleClientVerify } from "./core/build.js";

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

async function scaffold(opts: ProjectOptions, log: (msg: string) => void): Promise<void> {
  await fs.promises.mkdir(opts.targetDir, { recursive: true });

  if (opts.loader === "fabric") await scaffoldFabric(opts, log);
  else if (opts.loader === "forge") await scaffoldForge(opts, log);
  else await scaffoldNeoForge(opts, log);

  if (opts.mirror) {
    await applyChinaMirror(opts.targetDir, log);
    await injectMavenMirrors(opts.targetDir, log);
    await injectBuildscriptMirrors(opts.targetDir, log);
  }

  await writeCursorConfig(opts.targetDir);
  log("已生成 Cursor / VS Code 配置（.vscode）");

  const git = spawnSync("git", ["init", "-q"], { cwd: opts.targetDir });
  if (git.status === 0) log("已初始化 git 仓库");
}

/** 交互式 JDK 处理：缓存命中直接注入，否则询问下载 */
async function handleJdkInteractive(opts: ProjectOptions, log: (msg: string) => void): Promise<void> {
  const java = requiredJavaFor(opts.mcVersion);
  const detected = detectJavaMajor();
  if (detected !== null && detected >= java) return; // 已满足

  // 检查缓存
  const cached = findCachedJdk(java);
  if (cached) {
    log(`使用缓存的 JDK ${java}（${cached}）`);
    await injectJdkHome(opts.targetDir, cached);
    return;
  }

  const label = detected === null ? "未检测到 Java" : `当前 Java ${detected} 不满足要求（需要 ≥ ${java}）`;
  const shouldDownload = await p.confirm({
    message: `${label}。是否自动下载安装 JDK ${java}？（约 200 MB）`,
    initialValue: true,
  });
  if (p.isCancel(shouldDownload) || !shouldDownload) return;

  await downloadAndInjectJdk(java, opts.targetDir, log);
}

/** 非交互模式 JDK 处理：有缓存直接用，没有就自动下载（GUI 场景不能问用户） */
async function handleJdkNonInteractive(opts: ProjectOptions, log: (msg: string) => void): Promise<void> {
  const java = requiredJavaFor(opts.mcVersion);
  const detected = detectJavaMajor();
  if (detected !== null && detected >= java) return;

  const cached = findCachedJdk(java);
  if (cached) {
    log(`使用缓存的 JDK ${java}（${cached}）`);
    await injectJdkHome(opts.targetDir, cached);
    return;
  }

  const label = detected === null ? "未检测到 Java" : `当前 Java ${detected} 过旧`;
  log(`${label}，自动下载 JDK ${java}（约 200 MB，仅首次需要）…`);
  await downloadAndInjectJdk(java, opts.targetDir, log);
}

async function downloadAndInjectJdk(javaMajor: number, targetDir: string, log: (msg: string) => void): Promise<void> {
  const asset = await fetchJdkDownloadUrl(javaMajor);
  if (!asset) {
    throw new Error(`查询 JDK ${javaMajor} 下载地址失败，请手动安装：https://adoptium.net`);
  }

  const tmpDir = path.join(os.tmpdir(), `dmcl-jdk-${javaMajor}-${Date.now()}`);
  const zipDest = path.join(tmpDir, asset.filename);
  await fs.promises.mkdir(tmpDir, { recursive: true });

  log(`下载 JDK ${javaMajor} ${asset.versionLabel}（${(asset.sizeBytes / 1024 / 1024).toFixed(0)} MB）…`);
  let lastPct = -10;
  // 优先清华镜像（国内快且稳），失败回退 Adoptium 官方源
  const urls = [jdkMirrorUrl(javaMajor, asset.filename), asset.url];
  await downloadWithFallback(urls, zipDest, asset.sizeBytes, (pct) => {
    if (pct >= lastPct + 10 || (pct === 100 && lastPct !== 100)) {
      lastPct = pct;
      log(`下载 JDK ${pct}%`);
    }
  });

  log("解压 JDK…");
  const jdkPath = await extractJdk(zipDest, javaMajor);

  // 清理临时文件
  await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  log(`JDK 已安装至 ${jdkPath}`);
  await injectJdkHome(targetDir, jdkPath);
  log(`已配置 org.gradle.java.home`);
}

function printNextSteps(opts: ProjectOptions): void {
  const java = requiredJavaFor(opts.mcVersion);
  const detected = detectJavaMajor();
  const cached = findCachedJdk(java);
  const hasJdk = (detected !== null && detected >= java) || cached !== null;
  const lines: string[] = [];

  if (!hasJdk) {
    if (detected === null) {
      lines.push(pc.yellow(`⚠ 未检测到 Java。该版本需要 JDK ${java}，请先安装：`));
      lines.push(pc.yellow(`  https://adoptium.net/zh-CN/temurin/releases/?version=${java}`));
    } else {
      lines.push(pc.yellow(`⚠ 当前 Java ${detected} 过旧，该版本需要 JDK ${java}：`));
      lines.push(pc.yellow(`  https://adoptium.net/zh-CN/temurin/releases/?version=${java}`));
    }
  } else if (cached) {
    lines.push(pc.green(`✔ 使用项目内置的 JDK ${java}（已配置 org.gradle.java.home）`));
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
  mappings?: string;
  build?: boolean;
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
    const mappingsRaw = args.mappings ?? (loader === "fabric" ? "yarn" : "mojmap");
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
    await scaffold(opts, log);
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

  const mappingsOptions = MAPPINGS_FOR_LOADER[loader].map((m) => ({
    value: m,
    label: MAPPINGS_LABELS[m],
  }));
  const mappings = (mappingsOptions.length === 1)
    ? mappingsOptions[0].value
    : (await p.select({
        message: "选择映射表（Mappings）",
        options: mappingsOptions,
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
    await scaffold(opts, (msg) => s2.message(msg));
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
