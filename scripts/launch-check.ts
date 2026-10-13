/**
 * Launches registered variants exactly like the GUI's "启动" button (build queue -> runner -> runClient),
 * one at a time, stops each client at the title screen and prints the timings.
 *
 *   npx tsx scripts/launch-check.ts <variant dir or variant id> [...more] [--interactive]
 *
 * Waits while other heavy jobs (e.g. Linker instance tests) are recorded in the host activity registry.
 * Requires `npm run build` (the queue loads the core from dist/).
 */
import path from "node:path";
import { loadDist, repoDist } from "../gui/dist-loader";
import { enqueueBuild, getJob, onBuildEvent } from "../gui/build-queue";

interface Summary {
  variant: string;
  state: string;
  reason: string | null;
  timeToTitleSec: number | null;
  totalSec: number;
  gradleJava: number | null;
  phases: Array<{ phase: string; atSec: number; detail?: string | null }>;
}

async function waitForQuietHost(listHostActivity: () => Promise<Array<{ kind: string; label: string; pid: number }>>): Promise<void> {
  for (;;) {
    const foreign = (await listHostActivity()).filter((entry) => !entry.label.startsWith("DMCL "));
    if (foreign.length === 0) return;
    console.log(`[check] host busy, waiting: ${foreign.map((e) => `[${e.kind}] ${e.label} (pid ${e.pid})`).join("; ")}`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const interactive = argv.includes("--interactive");
  const targets = argv.filter((arg) => !arg.startsWith("--"));
  const workspace = await loadDist<any>(repoDist("workspace", "index.js"));
  const launch = await loadDist<any>(repoDist("launch", "index.js"));
  const store = workspace.getWorkspace();
  store.refresh({ force: true });

  const summaries: Summary[] = [];
  for (const target of targets) {
    const found = store.getVariant(target) ?? store.findVariantByPath(path.resolve(target));
    if (!found) {
      console.error(`[check] not a registered variant: ${target}`);
      process.exitCode = 1;
      continue;
    }
    await waitForQuietHost(() => launch.listHostActivity());
    const { variant, mod } = found;
    const label = `${variant.loader}-${variant.mcVersion}`;
    console.log(`\n[check] ===== ${label} (${variant.projectPath}) =====`);
    const started = Date.now();
    const phases: Summary["phases"] = [];
    const jobId = enqueueBuild({
      variantId: variant.id,
      projectPath: variant.projectPath,
      type: "run",
      loader: variant.loader,
      mcVersion: variant.mcVersion,
      modName: mod.displayName,
      stopAtTitle: !interactive,
    });
    await new Promise<void>((resolve) => {
      const off = onBuildEvent((event) => {
        if (event.job?.id !== jobId) return;
        if (event.type === "phase" && event.view) {
          const last = phases[phases.length - 1];
          if (!last || last.phase !== event.view.phase) {
            const atSec = Math.round((Date.now() - started) / 100) / 10;
            phases.push({ phase: event.view.phase, atSec, detail: event.view.phaseDetail });
            console.log(`[check] ${atSec.toFixed(1)}s  ${event.view.phase}${event.view.phaseDetail ? `  ${event.view.phaseDetail}` : ""}`);
          }
        } else if (event.type === "progress" && event.line && /JDK|Java \d|Gradle 使用|错误|FAILURE|What went wrong|Exception/.test(event.line)) {
          console.log(`[log] ${event.line}`);
        } else if (event.type === "done") {
          off();
          resolve();
        }
      });
    });
    const view = getJob(jobId)!;
    const summary: Summary = {
      variant: label,
      state: view.state,
      reason: view.reason,
      timeToTitleSec: view.timeToTitleMs === null ? null : Math.round(view.timeToTitleMs / 100) / 10,
      totalSec: Math.round((Date.now() - started) / 100) / 10,
      gradleJava: view.javaMajor,
      phases,
    };
    summaries.push(summary);
    console.log(`[check] ${label}: ${summary.state}${summary.reason ? ` (${summary.reason})` : ""}; title after ${summary.timeToTitleSec ?? "-"} s; total ${summary.totalSec} s; Gradle on Java ${summary.gradleJava ?? "?"}`);
  }
  console.log("\n[check] summary");
  console.log(JSON.stringify(summaries.map(({ phases: _p, ...rest }) => rest), null, 2));
  process.exit(summaries.every((s) => s.state === "succeeded") ? 0 : 1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
