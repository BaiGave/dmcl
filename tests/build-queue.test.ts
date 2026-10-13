import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { GradleRunner, StepContext, StepResult } from "../gui/gradle-runner";
import {
  cancelBuildQueue,
  cancelJob,
  enqueueBuild,
  getJob,
  getJobLog,
  isVariantQueued,
  listJobs,
  mergeBuildJobType,
  onBuildEvent,
  resetBuildQueueForTests,
  setRunnerForTests,
  setStatusSinkForTests,
  type BuildEvent,
  type BuildJob,
  type VariantStatusSink,
} from "../gui/build-queue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(5);
  }
}

interface Calls {
  builds: string[];
  launches: Array<{ dir: string; stopAtTitle?: boolean }>;
  concurrentByDir: Map<string, number>;
  maxConcurrentSameDir: number;
}

/** A runner that walks through the real phases and honours cancellation like the Gradle session. */
function mockRunner(calls: Calls, opts: { buildMs?: number; launchMs?: number; lines?: number } = {}): GradleRunner {
  const enter = (dir: string) => {
    const n = (calls.concurrentByDir.get(dir) ?? 0) + 1;
    calls.concurrentByDir.set(dir, n);
    calls.maxConcurrentSameDir = Math.max(calls.maxConcurrentSameDir, n);
  };
  const leave = (dir: string) => calls.concurrentByDir.set(dir, (calls.concurrentByDir.get(dir) ?? 1) - 1);
  const work = async (ctx: StepContext, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (ctx.isCancelled()) return false;
      await sleep(5);
    }
    return !ctx.isCancelled();
  };
  return {
    async build(dir, ctx) {
      calls.builds.push(dir);
      enter(dir);
      try {
        ctx.phase("toolchain");
        ctx.phase("compile", "> Task :compileJava");
        ctx.log("mock build");
        const ok = await work(ctx, opts.buildMs ?? 30);
        return ok ? { status: "success", javaMajor: 21 } : { status: "cancelled", reason: "已取消" };
      } finally {
        leave(dir);
      }
    },
    async launch(dir, ctx, options): Promise<StepResult> {
      calls.launches.push({ dir, stopAtTitle: options.stopAtTitle });
      enter(dir);
      try {
        ctx.phase("toolchain");
        ctx.phase("configure");
        for (let i = 0; i < (opts.lines ?? 1); i++) ctx.log(`game line ${i}`);
        ctx.phase("starting");
        ctx.phase("in-game", "已进入标题界面");
        const ok = await work(ctx, opts.launchMs ?? 30);
        return ok
          ? { status: "success", phaseReached: "in-game", timeToTitleMs: 1234, javaMajor: 21 }
          : { status: "cancelled", reason: "已取消", phaseReached: "in-game" };
      } finally {
        leave(dir);
      }
    },
  };
}

function fakeSink(): VariantStatusSink & { results: Array<{ variantId: string; state: string; kind: string; reason: string | null }>; activity: Map<string, string> } {
  const results: Array<{ variantId: string; state: string; kind: string; reason: string | null }> = [];
  const activity = new Map<string, string>();
  return {
    results,
    activity,
    setActivity(variantId, value) {
      if (value) activity.set(variantId, value.state);
      else activity.delete(variantId);
    },
    recordResult(variantId, result) {
      activity.delete(variantId);
      results.push({ variantId, state: result.state, kind: result.kind, reason: result.reason });
    },
  };
}

function waitForDone(jobId: string): Promise<BuildEvent> {
  return new Promise((resolve) => {
    const off = onBuildEvent((event) => {
      if (event.type === "done" && event.job?.id === jobId) {
        off();
        resolve(event);
      }
    });
  });
}

const job = (variantId: string, type: BuildJob["type"] = "run", extra: Partial<BuildJob> = {}) => ({
  variantId,
  projectPath: `C:/does-not-exist/dmcl-test/${variantId}`,
  type,
  ...extra,
});

let calls: Calls;
let sink: ReturnType<typeof fakeSink>;

beforeEach(() => {
  resetBuildQueueForTests();
  calls = { builds: [], launches: [], concurrentByDir: new Map(), maxConcurrentSameDir: 0 };
  sink = fakeSink();
  setStatusSinkForTests(sink);
});

describe("mergeBuildJobType", () => {
  it("keeps the broadest request: build+run ⊃ run ⊃ build", () => {
    assert.equal(mergeBuildJobType("build", "build+run"), "build+run");
    assert.equal(mergeBuildJobType("build+run", "build"), "build+run");
    assert.equal(mergeBuildJobType("build", "run"), "run");
  });
});

describe("launch jobs", () => {
  it("launches with the client task only - no build first - and reports the contract fields", async () => {
    setRunnerForTests(mockRunner(calls));
    const id = enqueueBuild(job("v1"));
    const done = await waitForDone(id);
    assert.equal(done.success, true);
    assert.deepEqual(calls.builds, [], "run must not build first");
    assert.equal(calls.launches.length, 1);
    const view = getJob(id)!;
    assert.equal(view.jobId, id);
    assert.equal(view.variantId, "v1");
    assert.equal(view.kind, "run");
    assert.equal(view.state, "succeeded");
    assert.equal(view.phase, "exited");
    assert.equal(view.reason, null);
    assert.equal(view.timeToTitleMs, 1234);
    assert.equal(view.javaMajor, 21);
    for (const key of ["startedAt", "phaseStartedAt", "finishedAt"] as const) {
      assert.ok(!Number.isNaN(Date.parse(view[key] ?? "")), key);
    }
    assert.ok(view.logLineCount >= 1);
    assert.deepEqual(sink.results, [{ variantId: "v1", state: "succeeded", kind: "run", reason: null }]);
  });

  it("pages the log with from/next/done (at most 2000 lines per response)", async () => {
    setRunnerForTests(mockRunner(calls, { lines: 2500 }));
    const id = enqueueBuild(job("v-log"));
    await waitForDone(id);
    const first = getJobLog(id, 0)!;
    assert.equal(first.lines.length, 2000);
    assert.equal(first.next, 2000);
    assert.equal(first.done, false);
    const second = getJobLog(id, first.next)!;
    assert.equal(second.lines[0], "game line 2000");
    assert.equal(second.done, true);
    assert.equal(getJobLog(id, second.next)!.lines.length, 0);
  });

  it("records a cancelled run as cancelled, not failed", async () => {
    setRunnerForTests(mockRunner(calls, { launchMs: 5000 }));
    const id = enqueueBuild(job("v2"));
    await until(() => getJob(id)?.phase === "in-game");
    assert.equal(getJob(id)!.state, "running");
    assert.equal(sink.activity.get("v2"), "running");
    assert.equal(cancelJob(id), true);
    await waitForDone(id);
    assert.equal(getJob(id)!.state, "cancelled");
    assert.deepEqual(sink.results.map((r) => r.state), ["cancelled"]);
  });

  it("build+run builds, then smoke-launches to the title screen", async () => {
    setRunnerForTests(mockRunner(calls));
    const id = enqueueBuild(job("v3", "build+run"));
    await waitForDone(id);
    assert.equal(calls.builds.length, 1);
    assert.deepEqual(calls.launches.map((l) => l.stopAtTitle), [true]);
    assert.equal(getJob(id)!.kind, "build");
  });
});

describe("queue behaviour", () => {
  it("never runs two jobs of one variant at once, and cancels a waiting job immediately", async () => {
    setRunnerForTests(mockRunner(calls, { launchMs: 200, buildMs: 50 }));
    const running = enqueueBuild(job("same", "run"));
    await until(() => getJob(running)?.state === "running");
    const waiting = enqueueBuild(job("same", "build"));
    assert.notEqual(waiting, running);
    assert.equal(getJob(waiting)!.state, "queued");
    assert.equal(cancelJob(waiting), true);
    assert.equal(getJob(waiting)!.state, "cancelled");
    const later = enqueueBuild(job("same", "build"));
    await waitForDone(later);
    assert.equal(calls.maxConcurrentSameDir, 1);
    assert.equal(getJob(running)!.state, "succeeded");
  });

  it("merges requests into a job that has not started yet", async () => {
    setRunnerForTests(mockRunner(calls, { launchMs: 100 }));
    const first = enqueueBuild(job("m", "run"));
    await until(() => getJob(first)?.state === "running");
    const a = enqueueBuild(job("m", "build"));
    const b = enqueueBuild(job("m", "build+run"));
    assert.equal(a, b);
    assert.equal(getJob(b)!.type, "build+run");
    assert.equal(enqueueBuild(job("m", "run")), first, "same request as the running job returns it");
    await waitForDone(b);
  });

  it("other variants start while one is busy; cancelling the queue cancels all active jobs", async () => {
    setRunnerForTests(mockRunner(calls, { launchMs: 5000 }));
    const ids = ["a", "b", "c"].map((v) => enqueueBuild(job(v)));
    await until(() => ids.every((id) => getJob(id)?.state === "running"));
    assert.equal(isVariantQueued("b"), true);
    cancelBuildQueue();
    await until(() => ids.every((id) => getJob(id)?.state === "cancelled"));
    assert.equal(isVariantQueued("b"), false);
    assert.ok(sink.results.every((r) => r.state === "cancelled"));
    assert.equal(listJobs().length, 3);
  });
});
