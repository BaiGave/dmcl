// Mock DMCL API for rendering the GUI without a backend (screenshots, manual UI work).
// Serves gui/ statically and fakes the job-based launch API; never starts Gradle or Minecraft.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
};

const MIN = 60_000;

function variant(id, loader, mcVersion, modVersion, dir, extra = {}) {
  return {
    id, loader, mcVersion, modVersion, mappings: "mojmap", group: "dev.example.aurora", source: "dmcl",
    projectPath: `D:\\dcml\\projects\\${dir}\\${loader}-${mcVersion}`, buildStatus: "unknown", createdAt: "2026-09-01T10:00:00Z",
    sourceStatus: { ready: loader === "fabric", minecraftReady: loader === "fabric", modCount: loader === "fabric" ? 3 : 0, mods: [] },
    ...extra,
  };
}

/** Scripted phases (ms from job creation) and log generation for a fake run. */
const RUN_SCRIPT = [
  { phase: "toolchain", at: 0 },
  { phase: "configure", at: 2600 },
  { phase: "compile", at: 5400 },
  { phase: "assets", at: 9600 },
  { phase: "starting", at: 13500 },
  { phase: "in-game", at: 18000 },
];
const FAIL_SCRIPT = [
  { phase: "toolchain", at: 0 },
  { phase: "configure", at: 1200 },
  { phase: "compile", at: 2600 },
];
const FAIL_AT = 5200;
const BUILD_DONE_AT = 14_000;
const scriptFor = (job) => job.fail ? FAIL_SCRIPT : job.kind === "build" ? RUN_SCRIPT.slice(0, 4) : RUN_SCRIPT;

const PHASE_LINES = {
  toolchain: (i) => i === 0 ? "Starting a Gradle Daemon (subsequent builds will be faster)" : `Using JDK 21.0.4 (Temurin) from %LOCALAPPDATA%\\DMCL\\jdks\\temurin-21 · cache hit ${i}`,
  configure: (i) => i % 25 === 0 ? `> Configure project :` : i % 97 === 0 ? `[WARN] Mapping cache for 1.21.4 is older than 30 days, refreshing in background` : `Resolved dependency net.fabricmc:fabric-loader:0.16.${i % 14} (from cache)`,
  compile: (i) => i % 140 === 0 ? `> Task :compileJava` : i % 333 === 0 ? `warning: [deprecation] getBlockState(BlockPos) in Level has been deprecated` : `  compiling dev/example/aurora/block/LanternBlock${i % 60}.java`,
  assets: (i) => i % 50 === 0 ? `> Task :processResources` : `  copied assets/aurora/textures/block/lantern_${i % 48}.png`,
  starting: (i) => i === 0 ? "> Task :runClient" : i % 40 === 0 ? "[main/INFO] (Minecraft) Setting user: Dev" : `[main/INFO] (FabricLoader) Loading mod ${i % 30} of 31`,
  "in-game": (i) => i === 0 ? "[Render thread/INFO] (Minecraft) Sound engine started" : i % 120 === 0 ? "[Render thread/WARN] (Minecraft) Texture aurora:block/lantern_glow is missing an mcmeta file" : `[Render thread/INFO] (Minecraft) Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas · frame ${i}`,
};
const LINES_PER_SECOND = { toolchain: 6, configure: 120, compile: 2600, assets: 900, starting: 120, "in-game": 40 };

const FAILURE_TAIL = [
  "> Task :compileJava FAILED",
  "D:\\dcml\\projects\\aurora\\forge-1.20.1\\src\\main\\java\\dev\\example\\aurora\\block\\LanternBlock.java:42: error: cannot find symbol",
  "        return state.getValue(BlockStateProperties.LIT_GLOW);",
  "                                                  ^",
  "  symbol:   variable LIT_GLOW",
  "D:\\dcml\\projects\\aurora\\forge-1.20.1\\src\\main\\java\\dev\\example\\aurora\\Aurora.java:18: error: incompatible types: ResourceLocation cannot be converted to String",
  "3 errors",
  "",
  "FAILURE: Build failed with an exception.",
  "",
  "* What went wrong:",
  "Execution failed for task ':compileJava'.",
  "> Compilation failed; see the compiler error output for details.",
  "",
  "* Try:",
  "> Run with --info option to get more log output.",
  "",
  "BUILD FAILED in 5s",
];

export function createMockState() {
  const now = Date.now();
  const mods = [
    {
      id: "m-aurora", modId: "aurora_lanterns", displayName: "Aurora Lanterns", status: "active",
      createdAt: "2026-08-01T10:00:00Z", updatedAt: "2026-10-12T10:00:00Z",
      variants: [
        variant("v-fab-1214", "fabric", "1.21.4", "1.3.0", "aurora", { status: { state: "succeeded", kind: "run", at: now - 3 * MIN, reason: null, phaseReached: "in-game", activeJobId: null } }),
        variant("v-neo-1211", "neoforge", "1.21.1", "1.3.0", "aurora", { status: { state: "running", kind: "build", at: now - 1 * MIN, reason: null, phaseReached: "compile", activeJobId: "job-bg" } }),
        variant("v-forge-1201", "forge", "1.20.1", "1.2.4", "aurora", { status: { state: "failed", kind: "run", at: now - 12 * MIN, reason: "编译失败：3 个错误（:compileJava）", phaseReached: "compile", activeJobId: null } }),
        variant("v-forge-1192", "forge", "1.19.2", "1.2.4", "aurora", { status: { state: "queued", kind: "run", at: now - 20_000, reason: null, phaseReached: null, activeJobId: "job-q" } }),
        variant("v-fab-1182", "fabric", "1.18.2", "1.1.0", "aurora", { status: { state: "failed", kind: "build", at: now - 9 * 24 * 60 * MIN, reason: "Could not resolve net.fabricmc:fabric-loom:0.10", phaseReached: "configure", activeJobId: null } }),
        variant("v-neo-1206", "neoforge", "1.20.6", "1.3.0", "aurora", { status: { state: "unknown", kind: null, at: null, reason: null, phaseReached: null, activeJobId: null } }),
      ],
    },
    {
      id: "m-pipes", modId: "copper_pipes", displayName: "Copper Pipes", status: "active", createdAt: "2026-07-01T10:00:00Z", updatedAt: "2026-10-10T10:00:00Z",
      variants: [
        variant("p-fab-1214", "fabric", "1.21.4", "0.4.2", "copper_pipes", { status: { state: "succeeded", kind: "build", at: now - 2 * 60 * MIN, reason: null, phaseReached: "assets", activeJobId: null } }),
        variant("p-neo-1211", "neoforge", "1.21.1", "0.4.2", "copper_pipes", { status: { state: "succeeded", kind: "run", at: now - 26 * 60 * MIN, reason: null, phaseReached: "in-game", activeJobId: null } }),
      ],
    },
    {
      id: "m-atlas", modId: "sky_atlas", displayName: "Sky Atlas", status: "paused", createdAt: "2026-05-01T10:00:00Z", updatedAt: "2026-09-10T10:00:00Z",
      variants: [
        variant("s-forge-1201", "forge", "1.20.1", "2.0.0", "sky_atlas", { status: { state: "failed", kind: "build", at: now - 31 * 24 * 60 * MIN, reason: "Gradle 8.1 不支持 Java 21", phaseReached: "toolchain", activeJobId: null } }),
      ],
    },
  ];
  const jobs = new Map([
    ["job-bg", { id: "job-bg", variantId: "v-neo-1211", kind: "build", createdAt: now - 7000, lines: [], perPhase: {} }],
    ["job-q", { id: "job-q", variantId: "v-forge-1192", kind: "run", createdAt: now - 20_000, queueMs: 10 * MIN, lines: [], perPhase: {} }],
  ]);
  return { mods, jobs, hostBusy: false, nextJob: 1 };
}

function matrixFor(mod) {
  const versions = ["1.21.4", "1.21.1", "1.20.6", "1.20.1", "1.19.2", "1.18.2"];
  const loaders = [{ id: "fabric", label: "Fabric" }, { id: "forge", label: "Forge" }, { id: "neoforge", label: "NeoForge" }];
  const cells = [];
  for (const l of loaders) {
    for (const v of versions) {
      const found = mod.variants.find((x) => x.loader === l.id && x.mcVersion === v);
      let status = "available";
      if (found) {
        const s = found.status?.state;
        status = s === "succeeded" ? "built" : s === "failed" ? "failed" : s === "running" || s === "queued" ? "building" : "exists";
      } else if (l.id === "neoforge" && (v === "1.19.2" || v === "1.18.2")) status = "unsupported";
      cells.push({ loader: l.id, mcVersion: v, status, variantId: found?.id });
    }
  }
  return { versions, loaders, cells };
}

function jobSnapshot(job, now = Date.now()) {
  const t = now - job.createdAt;
  const script = scriptFor(job);
  let cur = script[0];
  for (const step of script) if (t >= step.at) cur = step;
  let state = "running";
  let phase = cur.phase;
  let finishedAt = null;
  let reason = null;
  if (job.queueMs && t < job.queueMs && !job.cancelledAt) {
    return { jobId: job.id, variantId: job.variantId, kind: job.kind, state: "queued", phase: "queued",
      startedAt: job.createdAt, phaseStartedAt: job.createdAt, finishedAt: null, reason: null, logLineCount: 0 };
  }
  if (job.cancelledAt) {
    state = "cancelled"; finishedAt = job.cancelledAt; phase = job.cancelledPhase;
  } else if (job.kind === "build" && t >= BUILD_DONE_AT) {
    state = "succeeded"; finishedAt = job.createdAt + BUILD_DONE_AT; phase = "exited";
  } else if (job.fail && t >= FAIL_AT) {
    state = "failed"; finishedAt = job.createdAt + FAIL_AT; reason = "编译失败：3 个错误（:compileJava）";
  }
  return {
    jobId: job.id, variantId: job.variantId, kind: job.kind, state, phase,
    startedAt: job.createdAt, phaseStartedAt: job.createdAt + cur.at, finishedAt, reason, logLineCount: job.lines.length,
  };
}

/** Appends the log lines a job "printed" up to now. */
function advanceLog(job, now = Date.now()) {
  const snap = jobSnapshot(job, now);
  if (snap.state === "queued") return snap;
  const until = snap.finishedAt ?? now;
  const script = scriptFor(job);
  for (let i = 0; i < script.length; i++) {
    const start = job.createdAt + script[i].at;
    const end = Math.min(until, i + 1 < script.length ? job.createdAt + script[i + 1].at : until);
    if (end <= start) continue;
    const phase = script[i].phase;
    const want = Math.max(1, Math.floor(((end - start) / 1000) * LINES_PER_SECOND[phase]));
    const have = job.perPhase[phase] || 0;
    for (let n = have; n < want; n++) job.lines.push(PHASE_LINES[phase](n));
    job.perPhase[phase] = Math.max(have, want);
  }
  if (snap.state === "failed" && !job.tailWritten) {
    job.lines.push(...FAILURE_TAIL);
    job.tailWritten = true;
  }
  return snap;
}

function syncVariantStatus(state) {
  for (const job of state.jobs.values()) {
    const snap = advanceLog(job);
    for (const mod of state.mods) {
      const v = mod.variants.find((x) => x.id === job.variantId);
      if (v) v.status = { state: snap.state, kind: job.kind, at: snap.finishedAt ?? snap.startedAt, reason: snap.reason, phaseReached: snap.phase, activeJobId: snap.finishedAt ? null : job.id };
    }
  }
}

export async function startMockApi({ guiDir, port = 0 } = {}) {
  let state = createMockState();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const p = url.pathname;
    const json = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    if (p === "/__mock/reset") { state = createMockState(); return json({ ok: true }); }
    if (p === "/__mock/host") { state.hostBusy = url.searchParams.get("busy") === "1"; return json({ ok: true }); }

    if (p.startsWith("/api/")) {
      syncVariantStatus(state);
      let m;
      if (p === "/api/mods") return json({ mods: state.mods });
      if ((m = p.match(/^\/api\/mods\/([^/]+)\/detail$/))) {
        const mod = state.mods.find((x) => x.id === m[1]);
        return mod ? json({ mod, matrix: matrixFor(mod) }) : json({ error: "模组不存在" }, 404);
      }
      if ((m = p.match(/^\/api\/variants\/([^/]+)\/(run|build)$/)) && req.method === "POST") {
        const id = `job-${state.nextJob++}`;
        state.jobs.set(id, { id, variantId: m[1], kind: m[2], createdAt: Date.now(), fail: m[1] === "v-forge-1201", lines: [], perPhase: {} });
        return json({ jobId: id });
      }
      if ((m = p.match(/^\/api\/jobs\/([^/]+)\/cancel$/)) && req.method === "POST") {
        const job = state.jobs.get(m[1]);
        if (!job) return json({ error: "任务不存在" }, 404);
        const snap = jobSnapshot(job);
        job.cancelledAt = Date.now();
        job.cancelledPhase = snap.phase;
        return json({ ok: true });
      }
      if ((m = p.match(/^\/api\/jobs\/([^/]+)\/log$/))) {
        const job = state.jobs.get(m[1]);
        if (!job) return json({ error: "任务不存在" }, 404);
        const snap = advanceLog(job);
        const from = Number(url.searchParams.get("from") || 0);
        const lines = job.lines.slice(from, from + 5000);
        return json({ lines, next: from + lines.length, done: snap.finishedAt !== null && from + lines.length >= job.lines.length });
      }
      if ((m = p.match(/^\/api\/jobs\/([^/]+)$/))) {
        const job = state.jobs.get(m[1]);
        return job ? json(advanceLog(job)) : json({ error: "任务不存在" }, 404);
      }
      if ((m = p.match(/^\/api\/variants\/([^/]+)\/log$/))) {
        return json({ content: "> Task :compileJava\n> Task :processResources\nBUILD SUCCESSFUL in 41s", source: "saved", fileName: "build-2026-10-13.log" });
      }
      if (p === "/api/host-activity") {
        const now = Date.now();
        return json(state.hostBusy
          ? { busy: true, jobs: [
            { kind: "regress", label: "regress", pid: 18324, startedAt: now - 7 * MIN, progress: { done: 5, total: 16 }, source: "linker" },
            { kind: "instance-test", label: "world-import · 实例 2", pid: 20112, startedAt: now - 2 * MIN, progress: null, source: "linker" },
          ] }
          : { busy: false, jobs: [] });
      }
      if (p === "/api/queue") {
        const active = [...state.jobs.values()].filter((j) => jobSnapshot(j).finishedAt === null).length;
        return json({ running: active > 0, active, pending: 0, jobSlots: 4, gradleBuildActive: active, gradleBuildMax: 2, clientActive: 0, clientMax: 1, physicalCores: 8 });
      }
      if (p === "/api/default-dir") return json({ path: "D:\\dcml\\projects", projectsRoot: "D:\\dcml\\projects" });
      if (p === "/api/settings") return json({ projectsRoot: "D:\\dcml\\projects", dmclDir: "C:\\Users\\dev\\.dmcl", scanDirs: [] });
      if (p.startsWith("/api/versions/")) return json({ versions: ["1.21.4", "1.21.1", "1.20.6", "1.20.1"], fromCache: true });
      if (p.startsWith("/api/mappings/")) return json({ mappings: [{ id: "mojmap", label: "Mojang 官方映射" }], recommended: "mojmap" });
      return json({});
    }

    const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
    const file = path.resolve(guiDir, rel);
    if (!file.startsWith(path.resolve(guiDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("404");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// `node scripts/gui-mock-api.mjs` serves the GUI against the mock for manual work in a browser.
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || import.meta.url === `file://${process.argv[1]}`) {
  const guiDir = path.resolve(import.meta.dirname, "..", "gui");
  const mock = await startMockApi({ guiDir, port: Number(process.env.PORT || 19090) });
  console.log(`Mock DMCL GUI: ${mock.url}`);
}
