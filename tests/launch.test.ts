import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OutputTracker,
  classifyRunExit,
  foreignActivity,
  listHostActivity,
  registerHostActivity,
  runGradleSession,
  type ProcessStartReader,
} from "../src/launch/index.js";
import {
  SLOT_CAPS,
  SlotScheduler,
  SlotWaitCancelled,
  recommendedSlotLimits,
} from "../src/core/scheduler.js";
import { concurrencyWarnings, defaultConcurrencyLimits, resolveConcurrencyLimits } from "../src/core/host-concurrency.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("output phases", () => {
  it("follows a Loom runClient from configuration to the title screen", () => {
    const tracker = new OutputTracker("run");
    const phases: string[] = [];
    for (const line of [
      "Reusing configuration cache.",
      "> Task :compileJava UP-TO-DATE",
      "> Task :downloadAssets",
      "> Task :processResources",
      "> Task :runClient",
      "[12:00:00] [main/INFO] (FabricLoader/GameProvider): Loading Minecraft 1.20.1 with Fabric Loader 0.18.4",
      "[12:00:30] [Render thread/INFO] (Minecraft) Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas",
    ]) {
      const change = tracker.feed(line);
      if (change?.phase) phases.push(change.phase);
    }
    assert.deepEqual(phases, ["compile", "assets", "compile", "starting", "in-game"]);
    assert.equal(tracker.titleReached, true);
  });

  it("detects the game from its output when the run task header is missing (ModDevGradle)", () => {
    const tracker = new OutputTracker("run");
    tracker.feed("> Task :prepareClientRun");
    assert.equal(tracker.phase, "assets");
    tracker.feed("[main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, forgeclient]");
    assert.equal(tracker.phase, "starting");
    tracker.feed("> Task :compileJava");
    assert.equal(tracker.phase, "starting", "never goes back once the game starts");
  });

  it("takes the failure reason from Gradle's 'What went wrong'", () => {
    const tracker = new OutputTracker("build");
    for (const line of ["FAILURE: Build failed with an exception.", "", "* What went wrong:", "Execution failed for task ':compileJava'."]) {
      tracker.feed(line);
    }
    assert.equal(tracker.failure, "Execution failed for task ':compileJava'.");
  });

  it("classifies how a run ended", () => {
    const base = { cancelled: false, stoppedAtTitle: false, titleReached: true, exitCode: 0, crashed: false };
    assert.equal(classifyRunExit(base).status, "success");
    assert.equal(classifyRunExit({ ...base, crashed: true, exitCode: 255 }).status, "failed");
    assert.equal(classifyRunExit({ ...base, cancelled: true }).status, "cancelled");
    assert.equal(classifyRunExit({ ...base, stoppedAtTitle: true, cancelled: true, exitCode: 1 }).status, "success");
    const early = classifyRunExit({ ...base, titleReached: false });
    assert.equal(early.status, "failed");
    assert.match(early.reason ?? "", /标题界面/);
  });
});

describe("scheduler", () => {
  it("limits each slot kind, queues the rest and applies new limits without touching running work", async () => {
    let limits = { gradle: 1, client: 1 };
    const scheduler = new SlotScheduler(() => limits);
    const releaseA = await scheduler.acquire("gradle");
    let waited = false;
    const second = scheduler.acquire("gradle", { onWait: () => { waited = true; } });
    const client = await scheduler.acquire("client");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(waited, true);
    assert.deepEqual(scheduler.status().gradle, { active: 1, max: 1, waiting: 1 });

    limits = { gradle: 2, client: 1 };
    scheduler.wakeAll();
    const releaseB = await second;
    assert.equal(scheduler.status().gradle.active, 2);

    limits = { gradle: 1, client: 1 };
    assert.equal(scheduler.status().gradle.active, 2, "lowering a limit does not cancel running work");
    releaseA();
    releaseB();
    client();
  });

  it("gives up a wait when the job is cancelled", async () => {
    const scheduler = new SlotScheduler(() => ({ gradle: 1, client: 1 }));
    const hold = await scheduler.acquire("client");
    let cancelled = false;
    const waiting = scheduler.acquire("client", { isCancelled: () => cancelled });
    cancelled = true;
    await assert.rejects(waiting, SlotWaitCancelled);
    hold();
  });

  it("defaults to 2 Gradle builds and 2 clients on 16 cores and caps old 16/16/8 settings", () => {
    assert.deepEqual(recommendedSlotLimits(16), { gradle: 2, client: 2 });
    assert.deepEqual(recommendedSlotLimits(4), { gradle: 1, client: 1 });
    const info = { physicalCores: 16, logicalCores: 32, source: "fallback" as const };
    const old = resolveConcurrencyLimits({ jobSlots: 16, gradleBuildConcurrency: 16, clientConcurrency: 8 }, info);
    assert.equal(old.gradleBuildConcurrency, SLOT_CAPS.gradle);
    assert.equal(old.clientConcurrency, SLOT_CAPS.client);
    assert.equal(concurrencyWarnings(old, defaultConcurrencyLimits(info)).length, 2);
    assert.deepEqual(concurrencyWarnings(defaultConcurrencyLimits(info), defaultConcurrencyLimits(info)), []);
  });
});

describe("host activity registry", () => {
  const fakeStarts = (alive: Record<number, number | "unknown">): ProcessStartReader => async (pids) =>
    new Map(pids.filter((pid) => pid in alive).map((pid) => [pid, alive[pid]]));

  it("writes host_activity.py's schema and removes the entry when done", async () => {
    const dir = tempDir("dmcl-activity-");
    const reg = registerHostActivity(
      { pid: 4242, kind: "game", label: "DMCL runClient linker fabric-1.20.1", cwd: "D:/x" },
      { dir, readStarts: fakeStarts({ 4242: 133000000000000000 }) },
    );
    assert.ok(reg.file && path.basename(reg.file).startsWith("4242-"));
    await new Promise((r) => setTimeout(r, 20));
    const entry = JSON.parse(fs.readFileSync(reg.file!, "utf8"));
    assert.deepEqual(Object.keys(entry).sort(), ["cwd", "kind", "label", "pid", "process_started", "schema", "started_at"]);
    assert.equal(entry.schema, 1);
    assert.equal(entry.process_started, 133000000000000000);
    assert.match(entry.started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    reg.update({ progress: "in-game" });
    assert.equal(JSON.parse(fs.readFileSync(reg.file!, "utf8")).progress, "in-game");
    reg.unregister();
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("lists live entries only: exited processes and reused PIDs are left out", async () => {
    const dir = tempDir("dmcl-activity-");
    const write = (name: string, entry: object) => fs.writeFileSync(path.join(dir, name), JSON.stringify(entry));
    const base = { schema: 1, kind: "instance-test", cwd: "D:/linker", label: "instance_test run world-import" };
    write("1-a.json", { ...base, pid: 1, process_started: 10, started_at: "2026-10-13T09:00:00" });
    write("2-b.json", { ...base, pid: 2, process_started: 20, started_at: "2026-10-13T08:00:00" });
    write("3-c.json", { ...base, pid: 3, process_started: 30, started_at: "2026-10-13T07:00:00" });
    write("4-d.json", { ...base, pid: 4, process_started: null, started_at: "2026-10-13T06:00:00" });
    write("broken.json", "{");
    const live = await listHostActivity({ dir, readStarts: fakeStarts({ 1: 10, 2: 99, 4: "unknown" }) });
    assert.deepEqual(live.map((e) => e.pid), [4, 1]);
    assert.deepEqual(foreignActivity(live, [4]).map((e) => e.pid), [1]);
  });
});

describe("Gradle session (fake gradlew)", { skip: process.platform !== "win32" }, () => {
  function fakeProject(script: string[]): string {
    const dir = tempDir("dmcl-session-");
    fs.writeFileSync(path.join(dir, "gradlew.bat"), ["@echo off", ...script].join("\r\n") + "\r\n");
    return dir;
  }
  const keepRunning = "ping -n 30 127.0.0.1 >nul";

  it("stops a smoke launch at the title screen, registers host activity and reports success", async () => {
    const activityDir = tempDir("dmcl-session-activity-");
    process.env.LINKER_HOST_ACTIVITY = activityDir;
    try {
      const dir = fakeProject([
        "echo ^> Task :compileJava",
        "echo ^> Task :runClient",
        "echo [Render thread/INFO]: Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas",
        keepRunning,
      ]);
      const phases: string[] = [];
      let sawActivity = false;
      const result = await runGradleSession(dir, {
        kind: "run",
        tasks: ["runClient"],
        label: "DMCL runClient test",
        stopAtTitle: true,
        onPhase: (phase) => {
          phases.push(phase);
          if (phase === "in-game") sawActivity = fs.readdirSync(activityDir).length === 1;
        },
      });
      assert.equal(result.status, "success");
      assert.equal(result.titleReached, true);
      assert.ok(result.timeToTitleMs !== undefined && result.timeToTitleMs < 20_000);
      assert.ok(phases.includes("starting") && phases.includes("in-game"), phases.join(","));
      assert.equal(sawActivity, true);
      assert.deepEqual(fs.readdirSync(activityDir), [], "entry removed after exit");
    } finally {
      delete process.env.LINKER_HOST_ACTIVITY;
    }
  });

  it("cancels an interactive launch by killing the process tree", async () => {
    const dir = fakeProject(["echo ^> Task :runClient", keepRunning]);
    let cancel = false;
    setTimeout(() => { cancel = true; }, 500);
    const started = Date.now();
    const result = await runGradleSession(dir, {
      kind: "run",
      tasks: ["runClient"],
      label: "DMCL runClient test",
      hostActivity: false,
      isCancelled: () => cancel,
    });
    assert.equal(result.status, "cancelled");
    assert.ok(Date.now() - started < 15_000);
  });

  it("reports a build failure with Gradle's reason", async () => {
    const dir = fakeProject([
      "echo FAILURE: Build failed with an exception.",
      "echo * What went wrong:",
      "echo Could not resolve all files for configuration ':compileClasspath'.",
      "exit /b 1",
    ]);
    const result = await runGradleSession(dir, { kind: "build", tasks: ["build"], label: "DMCL build test", hostActivity: false });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "Could not resolve all files for configuration ':compileClasspath'.");
  });
});
