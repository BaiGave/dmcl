import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { GradleRunner } from "../gui/gradle-runner";
import {
  cancelBuildQueue,
  enqueueBuild,
  isVariantQueued,
  mergeBuildJobType,
  onBuildEvent,
  resetBuildQueueForTests,
  setRunnerPoolForTests,
  type BuildEvent,
  type BuildJob,
} from "../gui/build-queue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockRunner(runMs = 80): GradleRunner {
  let cancelled = false;
  return {
    runBuildOnly: async (_targetDir, log) => {
      log("mock build start");
      await sleep(runMs);
      return cancelled ? 1 : 0;
    },
    runClientOnly: async (_targetDir, log) => {
      log("mock client verify");
      await sleep(20);
      return cancelled ? 1 : 0;
    },
    runClientInteractive: async (_targetDir, log) => {
      log("mock client interactive");
      await sleep(20);
      return cancelled ? 1 : 0;
    },
    cancel: async () => {
      cancelled = true;
    },
    reset: () => {
      cancelled = false;
    },
    isCancelled: () => cancelled,
  };
}

function waitForEvent(
  predicate: (event: BuildEvent) => boolean,
  timeoutMs = 5000,
): Promise<BuildEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for build event"));
    }, timeoutMs);
    const off = onBuildEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

const sampleJob = (variantId: string, type: BuildJob["type"] = "build") => ({
  variantId,
  projectPath: `C:/tmp/dmcl-test/${variantId}`,
  type,
  loader: "fabric" as const,
  mcVersion: "1.21.1",
});

describe("mergeBuildJobType", () => {
  it("upgrades build to build+run", () => {
    assert.equal(mergeBuildJobType("build", "build+run"), "build+run");
  });

  it("keeps build+run when build is requested again", () => {
    assert.equal(mergeBuildJobType("build+run", "build"), "build+run");
  });

  it("upgrades build to run", () => {
    assert.equal(mergeBuildJobType("build", "run"), "run");
  });
});

describe("build queue cancel and resume", () => {
  beforeEach(() => {
    resetBuildQueueForTests();
    setRunnerPoolForTests([createMockRunner(120)]);
  });

  it("runs newly enqueued jobs after cancel while processor is winding down", async () => {
    const started = new Promise<void>((resolve) => {
      const off = onBuildEvent((event) => {
        if (event.type === "start" && event.job?.variantId === "variant-a") {
          off();
          resolve();
        }
      });
      enqueueBuild(sampleJob("variant-a"));
    });
    await started;

    cancelBuildQueue();
    enqueueBuild(sampleJob("variant-b"));

    const done = await waitForEvent(
      (event) => event.type === "done" && event.job?.variantId === "variant-b" && event.success === true,
      8000,
    );
    assert.equal(done.job?.variantId, "variant-b");
  });

  it("does not run the same variant in parallel across slots after cancel", async () => {
    setRunnerPoolForTests([createMockRunner(180), createMockRunner(180)]);

    const activeVariants = new Set<string>();
    const off = onBuildEvent((event) => {
      if (event.type === "start" && event.job) {
        if (activeVariants.has(event.job.variantId)) {
          throw new Error(`parallel start for ${event.job.variantId}`);
        }
        activeVariants.add(event.job.variantId);
      }
      if (event.type === "done" && event.job) {
        activeVariants.delete(event.job.variantId);
      }
    });

    const started = new Promise<void>((resolve) => {
      const offStart = onBuildEvent((event) => {
        if (event.type === "start" && event.job?.variantId === "variant-a") {
          offStart();
          resolve();
        }
      });
      enqueueBuild(sampleJob("variant-a"));
    });
    await started;

    cancelBuildQueue();
    enqueueBuild(sampleJob("variant-a"));

    const done = await waitForEvent(
      (event) => event.type === "done" && event.job?.variantId === "variant-a" && event.success === true,
      8000,
    );
    off();
    assert.equal(done.job?.variantId, "variant-a");
  });

  it("resets idle runner slots after cancel so parallel jobs are not stuck", async () => {
    setRunnerPoolForTests([createMockRunner(120), createMockRunner(120)]);

    enqueueBuild(sampleJob("slot-a"));
    enqueueBuild(sampleJob("slot-b"));
    await waitForEvent((event) => event.type === "start" && event.job?.variantId === "slot-b");

    cancelBuildQueue();
    enqueueBuild(sampleJob("slot-c"));
    enqueueBuild(sampleJob("slot-d"));

    const doneC = waitForEvent(
      (event) => event.type === "done" && event.job?.variantId === "slot-c" && event.success === true,
      8000,
    );
    const doneD = waitForEvent(
      (event) => event.type === "done" && event.job?.variantId === "slot-d" && event.success === true,
      8000,
    );
    await Promise.all([doneC, doneD]);
  });

  it("does not treat wind-down jobs as queued", async () => {
    const started = new Promise<void>((resolve) => {
      const off = onBuildEvent((event) => {
        if (event.type === "start" && event.job?.variantId === "variant-a") {
          off();
          resolve();
        }
      });
      enqueueBuild(sampleJob("variant-a"));
    });
    await started;

    assert.equal(isVariantQueued("variant-a"), true);
    cancelBuildQueue();
    assert.equal(isVariantQueued("variant-a"), false);
  });

  it("starts other variants while the queue head is waiting on wind-down", async () => {
    setRunnerPoolForTests([createMockRunner(180), createMockRunner(80)]);

    const started = new Promise<void>((resolve) => {
      const off = onBuildEvent((event) => {
        if (event.type === "start" && event.job?.variantId === "variant-a") {
          off();
          resolve();
        }
      });
      enqueueBuild(sampleJob("variant-a"));
    });
    await started;

    cancelBuildQueue();
    enqueueBuild(sampleJob("variant-a"));
    enqueueBuild(sampleJob("variant-b"));

    const doneB = await waitForEvent(
      (event) => event.type === "done" && event.job?.variantId === "variant-b" && event.success === true,
      8000,
    );
    assert.equal(doneB.job?.variantId, "variant-b");
  });

  it("upgrades queued job type instead of ignoring later requests", async () => {
    const firstId = enqueueBuild(sampleJob("variant-merge", "build"));
    const secondId = enqueueBuild(sampleJob("variant-merge", "build+run"));
    assert.equal(firstId, secondId);

    const progress: string[] = [];
    const off = onBuildEvent((event) => {
      if (event.type === "progress" && event.line) progress.push(event.line);
    });

    const done = await waitForEvent(
      (event) => event.type === "done" && event.job?.variantId === "variant-merge" && event.success === true,
    );
    off();

    assert.equal(done.job?.type, "build+run");
    assert.ok(progress.some((line) => line.includes("mock client verify")));
  });
});
