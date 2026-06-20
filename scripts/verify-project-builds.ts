/**
 * 修复跨加载器复制错误的 Forge 项目，并逐个执行 gradlew build。
 * 用法：npm run build && npx tsx scripts/verify-project-builds.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectProject } from "../src/workspace/detect.js";
import { repairCrossLoaderProject } from "../src/workspace/cross-loader.js";
import { runGradleBuildTask } from "../src/core/gradle.js";
import { ensureProjectToolchain } from "../src/core/toolchain.js";
import { setProjectsRoot, getProjectsRoot } from "../src/workspace/paths.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
setProjectsRoot(path.join(repoRoot, "projects"));

function readProps(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function findProjects(): string[] {
  const root = getProjectsRoot();
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const modEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!modEntry.isDirectory()) continue;
    const modDir = path.join(root, modEntry.name);
    for (const varEntry of fs.readdirSync(modDir, { withFileTypes: true })) {
      if (!varEntry.isDirectory()) continue;
      const projectPath = path.join(modDir, varEntry.name);
      if (detectProject(projectPath)) out.push(projectPath);
    }
  }
  return out.sort();
}

async function main(): Promise<void> {
  const projects = findProjects();
  console.log(`发现 ${projects.length} 个变体项目\n`);

  const results: Array<{ path: string; repaired: boolean; code: number; err?: string }> = [];

  for (const projectPath of projects) {
    const detected = detectProject(projectPath)!;
    const props = readProps(path.join(projectPath, "gradle.properties"));
    const modId = props.mod_id ?? detected.modId;
    const displayName = props.mod_name ?? detected.displayName;
    const group = props.maven_group ?? props.mod_group_id ?? detected.group;
    const rel = path.relative(repoRoot, projectPath);

    const repaired = await repairCrossLoaderProject(
      projectPath,
      modId,
      displayName,
      group,
      detected.loader,
      detected.mcVersion,
      (line) => console.log(`  [${rel}] ${line}`),
    );

    console.log(`\n▶ 构建 ${rel} (${detected.loader} ${detected.mcVersion})${repaired ? " [已修复跨加载器代码]" : ""}`);

    const log = (line: string) => {
      if (/BUILD|FAILURE|错误|Error|Exception|成功|✔/.test(line)) console.log(`    ${line}`);
    };

    try {
      await ensureProjectToolchain(projectPath, detected.mcVersion, log);
      const code = await runGradleBuildTask(projectPath, log, {
        tasks: ["build", "--no-daemon", "--max-workers=1"],
        timeoutMs: 20 * 60 * 1000,
      });
      results.push({ path: rel, repaired, code });
      console.log(code === 0 ? `  ✔ 成功` : `  ✘ 失败 (exit ${code})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ path: rel, repaired, code: 1, err: msg });
      console.log(`  ✘ 异常：${msg}`);
    }
  }

  console.log("\n========== 汇总 ==========");
  const ok = results.filter((r) => r.code === 0);
  const bad = results.filter((r) => r.code !== 0);
  console.log(`成功 ${ok.length} / ${results.length}`);
  for (const r of bad) {
    console.log(`  ✘ ${r.path}${r.err ? " — " + r.err : ""}`);
  }
  process.exitCode = bad.length ? 1 : 0;
}

main();
