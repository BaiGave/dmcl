import fs from "node:fs";
import path from "node:path";
import { resolveBuildJdk } from "../src/core/jdk.js";
import { getProjectSourceRoot } from "../src/sources/paths.js";
import { detectSourceProjectTarget } from "../src/sources/project-build.js";
import {
  detectModMetadata,
  detectProjectMapping,
  getMinecraftSourceStatus,
  materializeExternalModSource,
  materializeMinecraftSourcesFromProject,
  projectExternalModSource,
  startMinecraftSourceTask,
} from "../src/sources/service.js";
import type { LoaderId, MappingsId } from "../src/types.js";
import type { ProjectSourceIndex } from "../src/sources/types.js";

const USAGE = `用法：npm run sources:prepare -- <项目变体目录> [选项]

准备项目变体的 Minecraft 源码，并可从本地 jar 补充模组源码，结果写入 DMCL 源码库与 <项目>/.dmcl/sources
选项：
  --mod-jar <jar>      从这个本地模组 jar 生成源码单元，可重复；同目录有 <名称>-sources.jar 时直接用它，否则 CFR 反编译
  --mod-list <文件>    UTF-8 文本，每行一个 jar 路径（# 开头为注释）；jar 很多或路径含非 ASCII 字符时代替 --mod-jar
  --mods-only          跳过 Minecraft 源码，只处理 --mod-jar / --mod-list
  --no-gradle          不运行 Gradle、不写项目入口：把目录 build/ 里已有的加载器源码包（如 NeoForge 的 *-sources.jar）
                       收进源码库；目录不必是完整项目，需同时给 --loader 与 --mc，映射用 --mapping 声明（默认按构建脚本，否则 mojmap）
  --mapping <mojmap|parchment|yarn|mcp>   与 --no-gradle 连用，声明这些源码的实际命名；--mapping-version <版本> 默认取 MC 版本
  --loader <fabric|forge|neoforge>   覆盖自动识别的加载器
  --mc <版本>          覆盖自动识别的 Minecraft 版本
  --java-home <JDK>    项目未配置 org.gradle.java.home 时使用的 JDK；省略则按构建需求取 DMCL 缓存的 JDK
  --jobs <n>           同时反编译的模组数，默认 1
  --force              忽略已有缓存重新生成
  -h, --help           显示本说明
JDK 只经环境传给本次 Gradle/CFR 进程，不会写入项目的 gradle.properties`;

interface Args {
  project: string;
  modJars: string[];
  modsOnly: boolean;
  noGradle: boolean;
  force: boolean;
  jobs: number;
  loader?: LoaderId;
  mcVersion?: string;
  mapping?: MappingsId;
  mappingVersion?: string;
  javaHome?: string;
}

function parseArgs(argv: string[]): Args | null {
  const args: Args = { project: "", modJars: [], modsOnly: false, noGradle: false, force: false, jobs: 1 };
  const value = (flag: string, index: number): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${flag} 需要一个值`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return null;
    else if (arg === "--mod-jar") args.modJars.push(path.resolve(value(arg, i++)));
    else if (arg === "--mod-list") {
      const list = path.resolve(value(arg, i++));
      for (const line of fs.readFileSync(list, "utf8").split(/\r?\n/)) {
        if (line.trim() && !line.trim().startsWith("#")) args.modJars.push(path.resolve(line.trim()));
      }
    } else if (arg === "--mods-only") args.modsOnly = true;
    else if (arg === "--no-gradle") args.noGradle = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--jobs") {
      args.jobs = Number.parseInt(value(arg, i++), 10);
      if (!(args.jobs >= 1 && args.jobs <= 16)) throw new Error("--jobs 需要 1 到 16 之间的整数");
    }
    else if (arg === "--loader") {
      const loader = value(arg, i++);
      if (!["fabric", "forge", "neoforge"].includes(loader)) throw new Error(`未知加载器：${loader}`);
      args.loader = loader as LoaderId;
    } else if (arg === "--mc") args.mcVersion = value(arg, i++);
    else if (arg === "--mapping") {
      const mapping = value(arg, i++);
      if (!["mojmap", "parchment", "yarn", "mcp"].includes(mapping)) throw new Error(`未知映射：${mapping}`);
      args.mapping = mapping as MappingsId;
    } else if (arg === "--mapping-version") args.mappingVersion = value(arg, i++);
    else if (arg === "--java-home") args.javaHome = path.resolve(value(arg, i++));
    else if (arg.startsWith("-")) throw new Error(`未知参数：${arg}`);
    else if (!args.project) args.project = path.resolve(arg);
    else throw new Error(`多余的参数：${arg}`);
  }
  if (!args.project) throw new Error("缺少项目变体目录");
  if (args.modsOnly && args.modJars.length === 0) throw new Error("--mods-only 需要至少一个 --mod-jar 或 --mod-list");
  if (args.noGradle && (!args.loader || !args.mcVersion)) throw new Error("--no-gradle 需要同时指定 --loader 与 --mc");
  if (args.noGradle && args.modsOnly) throw new Error("--no-gradle 与 --mods-only 不能同时使用");
  return args;
}

function readProjectionIndex(project: string): ProjectSourceIndex | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(getProjectSourceRoot(project), "index.json"), "utf8")) as ProjectSourceIndex;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs DMCL's Minecraft source task for the project and mirrors its log lines until it finishes. */
async function prepareMinecraft(args: Args, loader: LoaderId, mcVersion: string): Promise<boolean> {
  startMinecraftSourceTask({
    scope: "single",
    loader,
    mcVersion,
    projectPath: args.project,
    includeDependencies: false,
    force: args.force,
    javaHome: args.javaHome,
  });
  let lastLine: string | null = null;
  for (;;) {
    const task = getMinecraftSourceStatus().task;
    if (!task) throw new Error("源码任务没有启动");
    // The task keeps a bounded window of log lines, so resume after the last line already shown.
    const resumeAt = lastLine === null ? 0 : task.logs.lastIndexOf(lastLine) + 1;
    for (const line of task.logs.slice(resumeAt)) console.log(`  ${line}`);
    if (task.logs.length > 0) lastLine = task.logs[task.logs.length - 1];
    if (task.state !== "running") {
      if (task.state === "completed") return true;
      console.error(`Minecraft 源码${task.state === "cancelled" ? "已取消" : "失败"}：${task.lastError ?? "未知错误"}`);
      return false;
    }
    await sleep(500);
  }
}

/** Files already-built loader sources under <project>/build into the vault without running Gradle. */
async function ingestExistingSources(args: Args, loader: LoaderId, mcVersion: string): Promise<boolean> {
  const requested = {
    loader,
    mcVersion,
    mapping: args.mapping ?? ("mojmap" as MappingsId),
    mappingVersion: args.mappingVersion ?? mcVersion,
  };
  const target = args.mapping ? requested : { ...requested, ...detectProjectMapping(args.project, requested) };
  try {
    const entry = await materializeMinecraftSourcesFromProject({
      ...target,
      projectPath: args.project,
      force: args.force,
      javaHome: args.javaHome,
      log: (line) => console.log(`  ${line}`),
    });
    console.log(`Minecraft 源码：${entry.loader} ${entry.minecraftVersion} / ${entry.mapping} ${entry.mappingVersion}，${entry.javaFiles} 个 Java 文件（${entry.sourceKind}）`);
    console.log(`  单元：${entry.path}`);
    return true;
  } catch (error) {
    console.error(`Minecraft 源码失败：${(error as Error).message}`);
    return false;
  }
}

function versionFromFileName(name: string): string {
  return /-(\d[\w.+-]*)$/.exec(name)?.[1] ?? "local";
}

async function prepareMods(args: Args, loader: LoaderId, mcVersion: string): Promise<number> {
  let javaHome = args.javaHome;
  if (!javaHome) {
    try {
      javaHome = (await resolveBuildJdk(args.project, mcVersion, (line) => console.log(`  ${line}`))).javaHome;
    } catch (error) {
      console.warn(`  未能选定 JDK，反编译改用 PATH 中的 java：${(error as Error).message}`);
    }
  }
  const prepareOne = async (jar: string): Promise<boolean> => {
    let tag = path.basename(jar);
    try {
      if (!fs.existsSync(jar)) throw new Error("文件不存在");
      const name = path.basename(jar, path.extname(jar));
      const metadata = detectModMetadata(jar, name, versionFromFileName(name), loader);
      if (!metadata) throw new Error("没有可识别的模组元数据（fabric.mod.json / neoforge.mods.toml / mods.toml / mcmod.info）");
      tag = metadata.modId;
      const say = (line: string) => console.log(`[${tag}] ${line}`);
      const sourcesJar = path.join(path.dirname(jar), `${name}-sources.jar`);
      const hasSources = fs.existsSync(sourcesJar);
      say(`${metadata.modVersion}：${hasSources ? "使用同目录 sources jar" : "CFR 反编译"} ← ${jar}`);
      const entry = await materializeExternalModSource({
        loader,
        minecraftVersion: mcVersion,
        projectPath: args.project,
        modId: metadata.modId,
        modName: metadata.modName,
        modVersion: metadata.modVersion,
        artifactFile: jar,
        sourceArchiveFile: hasSources ? sourcesJar : undefined,
        sourceArchiveKind: hasSources ? "sources-jar" : undefined,
        origin: { provider: "local", file: jar },
        force: args.force,
        javaHome,
        log: say,
      });
      await projectExternalModSource(args.project, entry);
      say(`单元：${entry.path}（${entry.javaFiles} 个 Java 文件，${entry.sourceKind}）`);
      return true;
    } catch (error) {
      console.error(`[${tag}] 模组源码失败 ${jar}：${(error as Error).message}`);
      return false;
    }
  };

  // Units are independent and the projection writes are serialized by the service, so jars can decompile side by side.
  const queue = [...args.modJars];
  let failures = 0;
  const worker = async (): Promise<void> => {
    for (let jar = queue.shift(); jar !== undefined; jar = queue.shift()) {
      if (!(await prepareOne(jar))) failures++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.jobs, queue.length) }, worker));
  return failures;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(USAGE);
    return;
  }
  if (!fs.existsSync(args.project)) throw new Error(`项目目录不存在：${args.project}`);
  const detected = detectSourceProjectTarget(args.project);
  const loader = args.loader ?? detected?.loader;
  const mcVersion = args.mcVersion ?? detected?.mcVersion;
  if (!loader || !mcVersion) throw new Error("无法识别加载器或 Minecraft 版本，请用 --loader 与 --mc 指定");
  console.log(`项目：${args.project}\n目标：${loader} ${mcVersion}`);

  let failed = false;
  if (args.noGradle) {
    console.log("收录已有的 Minecraft 源码包（不运行 Gradle）…");
    failed = !(await ingestExistingSources(args, loader, mcVersion));
  } else if (!args.modsOnly) {
    console.log("准备 Minecraft 源码…");
    if (await prepareMinecraft(args, loader, mcVersion)) {
      const unit = readProjectionIndex(args.project)?.minecraft;
      if (unit) {
        console.log(`Minecraft 源码：${unit.loader} ${unit.minecraftVersion} / ${unit.mapping} ${unit.mappingVersion}，${unit.javaFiles} 个 Java 文件`);
        console.log(`  单元：${unit.path}`);
      }
      console.log(`  项目入口：${getProjectSourceRoot(args.project)}`);
    } else {
      failed = true;
    }
  }
  if (args.modJars.length > 0) {
    const failures = await prepareMods(args, loader, mcVersion);
    if (failures > 0) failed = true;
    console.log(`模组源码：${args.modJars.length - failures}/${args.modJars.length} 个就绪`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error((error as Error).message);
  console.error("使用 --help 查看用法");
  process.exitCode = 2;
});
