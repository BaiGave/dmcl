import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { apiFetch, api, ApiError, TOKEN_HEADER, isNotFound } from "../gui/renderer-src/api";
import { parseHostActivity, parseJob, variantStatusOf, type JobInfo } from "../gui/renderer-src/contract";
import { formatDuration, humanTime, shortPath, statusView, STALE_FAILURE_MS } from "../gui/renderer-src/status";
import { PhaseTimeline, buildStepper, currentStepIndex, inferPhaseFromLine, totalElapsed } from "../gui/renderer-src/phases";
import { LogBuffer, classifyLine, extractErrorHighlights, isAtBottom, visibleRange } from "../gui/renderer-src/log-buffer";
import { busyWarningText, hostChipView, jobTitle, progressText, shouldWarnBeforeLaunch } from "../gui/renderer-src/host-activity";
import { openJobFeed, resetJobsApiProbe, jobsApiSupport } from "../gui/renderer-src/job-feed";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const MIN = 60_000;

function job(over: Partial<JobInfo> = {}): JobInfo {
  return {
    jobId: "j1", variantId: "v1", kind: "run", state: "running", phase: "compile",
    startedAt: NOW - 90_000, phaseStartedAt: NOW - 20_000, finishedAt: null, reason: null, logLineCount: 0,
    ...over,
  };
}

describe("status labels and time", () => {
  it("formats human times in Chinese", () => {
    assert.equal(humanTime(NOW - 10_000, NOW), "刚刚");
    assert.equal(humanTime(NOW - 3 * MIN, NOW), "3 分钟前");
    assert.equal(humanTime(new Date(NOW - 2 * 60 * MIN).toISOString(), NOW), "2 小时前");
    assert.equal(humanTime(NOW - 30 * 60 * MIN, NOW), "昨天");
    assert.equal(humanTime(NOW - 5 * 24 * 60 * MIN, NOW), "5 天前");
    assert.match(humanTime(NOW - 90 * 24 * 60 * MIN, NOW) || "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(humanTime(null, NOW), null);
    assert.equal(humanTime("not a date", NOW), null);
  });

  it("formats durations", () => {
    assert.equal(formatDuration(8_400), "8s");
    assert.equal(formatDuration(185_000), "3:05");
    assert.equal(formatDuration(3_723_000), "1:02:03");
    assert.equal(formatDuration(null), "—");
  });

  it("labels every run state", () => {
    const base = { kind: null, at: NOW - 3 * MIN, reason: null, phaseReached: null, activeJobId: null } as const;
    assert.equal(statusView({ ...base, state: "running", phaseReached: "compile" }, NOW).label, "运行中 · 编译");
    assert.equal(statusView({ ...base, state: "queued" }, NOW).label, "排队中");
    assert.equal(statusView({ ...base, state: "succeeded", kind: "run" }, NOW).label, "启动成功");
    assert.equal(statusView({ ...base, state: "succeeded" }, NOW).label, "就绪");
    assert.equal(statusView({ ...base, state: "cancelled" }, NOW).label, "已取消");
    assert.equal(statusView({ ...base, state: "unknown", at: null }, NOW).label, "未运行");
    assert.equal(statusView({ ...base, state: "unknown" }, NOW).label, "已过期");
  });

  it("shows a recent failure as an alarm with its reason, an old one as history", () => {
    const recent = statusView({ state: "failed", kind: "run", at: NOW - 3 * MIN, reason: "exit code 1", phaseReached: "starting", activeJobId: null }, NOW);
    assert.equal(recent.tone, "danger");
    assert.equal(recent.label, "失败");
    assert.equal(recent.time, "3 分钟前");
    assert.match(recent.detail, /exit code 1/);
    assert.match(recent.detail, /启动游戏/);
    const old = statusView({ state: "failed", kind: "build", at: NOW - STALE_FAILURE_MS - MIN, reason: "x", phaseReached: null, activeJobId: null }, NOW);
    assert.equal(old.tone, "stale");
    assert.equal(old.label, "上次失败");
    assert.equal(old.time, "昨天");
  });

  it("maps the legacy buildStatus when the backend has no status object", () => {
    assert.equal(variantStatusOf({ buildStatus: "success", lastBuiltAt: "2026-10-13T11:00:00Z" }).state, "succeeded");
    assert.equal(variantStatusOf({ buildStatus: "building" }).state, "running");
    assert.equal(variantStatusOf({ buildStatus: "unknown" }).state, "unknown");
    const s = variantStatusOf({ buildStatus: "failed", status: { state: "queued", kind: "run", at: 1, reason: null, phaseReached: null, activeJobId: "j9" } });
    assert.equal(s.state, "queued");
    assert.equal(s.activeJobId, "j9");
  });

  it("shortens long paths from the end", () => {
    const p = "D:\\dcml\\projects\\some-very-long-mod-name\\fabric-1.21.4";
    const short = shortPath(p, 2, 40);
    assert.ok(short.startsWith("…\\"));
    assert.ok(short.endsWith("fabric-1.21.4"));
    assert.equal(shortPath("C:\\a", 2, 40), "C:\\a");
  });
});

describe("phase stepper", () => {
  it("marks done, active and pending steps with durations", () => {
    const tl = new PhaseTimeline();
    tl.observe(job({ phase: "toolchain", phaseStartedAt: NOW - 90_000 }), NOW - 90_000);
    tl.observe(job({ phase: "configure", phaseStartedAt: NOW - 60_000 }), NOW - 60_000);
    const j = job({ phase: "compile", phaseStartedAt: NOW - 20_000 });
    tl.observe(j, NOW);
    const steps = buildStepper(j, tl, NOW);
    assert.deepEqual(steps.map((s) => s.state), ["done", "done", "active", "pending", "pending", "pending"]);
    assert.equal(steps[0].durationMs, 30_000);
    assert.equal(steps[1].durationMs, 40_000);
    assert.equal(steps[2].durationMs, 20_000);
    assert.equal(steps[3].durationMs, null);
    assert.equal(totalElapsed(j, NOW), 90_000);
  });

  it("uses phaseStartedAt for the active step when opened mid-job", () => {
    const j = job({ phase: "starting", phaseStartedAt: NOW - 5_000 });
    const steps = buildStepper(j, new PhaseTimeline(), NOW);
    assert.equal(steps[4].state, "active");
    assert.equal(steps[4].durationMs, 5_000);
    assert.equal(steps[0].state, "done");
    assert.equal(steps[0].durationMs, null);
  });

  it("marks the failing step and freezes elapsed time", () => {
    const tl = new PhaseTimeline();
    tl.observe(job({ phase: "assets", phaseStartedAt: NOW - 10_000 }), NOW - 10_000);
    const failed = job({ phase: "assets", state: "failed", finishedAt: NOW - 4_000, reason: "boom" });
    tl.observe(failed, NOW);
    const steps = buildStepper(failed, tl, NOW);
    assert.equal(steps[3].state, "failed");
    assert.equal(steps[3].durationMs, 6_000);
    assert.equal(steps[4].state, "pending");
    assert.equal(totalElapsed(failed, NOW), 86_000);
  });

  it("treats exited as the highest phase reached", () => {
    const tl = new PhaseTimeline();
    tl.observe(job({ phase: "in-game" }), NOW);
    const done = job({ phase: "exited", state: "succeeded", finishedAt: NOW });
    tl.observe(done, NOW);
    assert.equal(currentStepIndex(done, tl), 5);
    assert.ok(buildStepper(done, tl, NOW).every((s) => s.state === "done"));
    const crashed = job({ phase: "exited", state: "failed", finishedAt: NOW });
    assert.equal(currentStepIndex(crashed, new PhaseTimeline()), -1);
  });

  it("builds have four steps", () => {
    const steps = buildStepper(job({ kind: "build", phase: "assets", state: "succeeded", finishedAt: NOW }), new PhaseTimeline(), NOW);
    assert.equal(steps.length, 4);
    assert.ok(steps.every((s) => s.state === "done"));
  });

  it("infers legacy phases from Gradle and Minecraft lines, never going back", () => {
    assert.equal(inferPhaseFromLine("> Task :compileJava", "run", "configure"), "compile");
    assert.equal(inferPhaseFromLine("> Task :runClient", "run", "compile"), "starting");
    assert.equal(inferPhaseFromLine("[Render thread/INFO]: Sound engine started", "run", "starting"), "in-game");
    assert.equal(inferPhaseFromLine("> Task :compileJava", "run", "starting"), null);
    assert.equal(inferPhaseFromLine("> Task :runClient", "build", "compile"), null);
    assert.equal(inferPhaseFromLine("hello", "run", null), null);
  });
});

describe("log buffer and virtualisation", () => {
  it("classifies lines", () => {
    assert.equal(classifyLine("[main/ERROR]: oops"), "error");
    assert.equal(classifyLine("java.lang.IllegalStateException: bad"), "error");
    assert.equal(classifyLine("\tat net.minecraft.Foo.bar(Foo.java:10)"), "error");
    assert.equal(classifyLine("[Render thread/WARN]: slow"), "warn");
    assert.equal(classifyLine("> Task :compileJava"), "info");
  });

  it("indexes warnings/errors and maps rows to lines under a filter", () => {
    const b = new LogBuffer();
    b.append(["a", "[x/WARN] w", "b", "[x/ERROR] e", "c"]);
    assert.equal(b.count("all"), 5);
    assert.equal(b.count("issues"), 2);
    assert.equal(b.rowToLine("issues", 1), 3);
    assert.equal(b.lineToRow("issues", 2), 1);
    assert.equal(b.errorCount, 1);
    assert.equal(b.warnCount, 1);
  });

  it("caps memory by dropping the oldest lines in batches", () => {
    const b = new LogBuffer(1000);
    const lines = Array.from({ length: 50_000 }, (_, i) => (i % 100 === 0 ? "[t/ERROR] " : "line ") + i);
    b.append(lines);
    assert.ok(b.size <= 1100, "size " + b.size);
    assert.equal(b.end, 50_000);
    assert.equal(b.line(b.end - 1), "line 49999");
    assert.equal(b.line(0), undefined);
    assert.ok(b.rowToLine("issues", 0) >= b.dropped);
    assert.match(b.text(), /^…（前 \d+ 行/);
  });

  it("computes the rendered window with overscan", () => {
    assert.deepEqual(visibleRange(0, 360, 18, 30_000, 10), { start: 0, end: 31, offset: 0 });
    const mid = visibleRange(18 * 1000, 360, 18, 30_000, 10);
    assert.equal(mid.start, 990);
    assert.equal(mid.end, 1031);
    assert.equal(mid.offset, 990 * 18);
    const end = visibleRange(18 * 30_000, 360, 18, 30_000, 10);
    assert.equal(end.end, 30_000);
    assert.deepEqual(visibleRange(0, 360, 18, 0), { start: 0, end: 0, offset: 0 });
  });

  it("detects the tail for autoscroll", () => {
    assert.equal(isAtBottom(982, 1400, 400), true);
    assert.equal(isAtBottom(900, 1400, 400), false);
  });

  it("extracts Gradle's what-went-wrong block", () => {
    const b = new LogBuffer();
    b.append(["> Task :compileJava FAILED", "", "FAILURE: Build failed with an exception.", "", "* What went wrong:",
      "Execution failed for task ':compileJava'.", "> Compilation failed; see the compiler error output for details.", "", "* Try:", "> Run with --stacktrace"]);
    const h = extractErrorHighlights(b);
    assert.deepEqual(h.map((x) => x.text), ["Execution failed for task ':compileJava'.", "> Compilation failed; see the compiler error output for details."]);
    assert.equal(h[0].line, 5);
  });

  it("leads with compiler errors before Gradle's summary", () => {
    const b = new LogBuffer();
    b.append(["> Task :compileJava FAILED", "A.java:42: error: cannot find symbol", "  symbol: x", "B.java:7: error: incompatible types",
      "2 errors", "* What went wrong:", "Execution failed for task ':compileJava'.", "* Try:"]);
    assert.deepEqual(extractErrorHighlights(b, 4).map((x) => x.line), [1, 3, 6]);
  });

  it("falls back to the first exception and its causes", () => {
    const b = new LogBuffer();
    b.append(["info", "java.lang.RuntimeException: outer", "\tat a.b(C.java:1)", "Caused by: java.io.IOException: inner", "\tat d.e(F.java:2)", "after"]);
    assert.deepEqual(extractErrorHighlights(b).map((x) => x.line), [1, 3]);
  });
});

describe("fetch helper", () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { window?: unknown };
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete g.window;
  });

  function capture(): Array<{ url: string; init: RequestInit }> {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    return calls;
  }

  it("adds the token header when window.dmcl.apiToken is set", async () => {
    const calls = capture();
    g.window = { dmcl: { apiToken: "secret-1" } };
    await api("/api/x", { method: "POST", body: { a: 1 } });
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get(TOKEN_HEADER), "secret-1");
    assert.equal(headers.get("Content-Type"), "application/json");
  });

  it("sends no token header without window.dmcl", async () => {
    const calls = capture();
    await apiFetch("/api/x");
    assert.equal(new Headers(calls[0].init.headers).has(TOKEN_HEADER), false);
    g.window = {};
    await apiFetch("/api/y");
    assert.equal(new Headers(calls[1].init.headers).has(TOKEN_HEADER), false);
  });

  it("raises ApiError with the status, also for non-JSON 404 bodies", async () => {
    globalThis.fetch = (async () => new Response("404", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(api("/api/jobs/x"), (err: unknown) => err instanceof ApiError && err.status === 404 && isNotFound(err));
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "变体不存在" }), { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(api("/api/x"), /变体不存在/);
  });
});

describe("host activity", () => {
  const linker = parseHostActivity({ busy: true, jobs: [{ kind: "regress", label: "regress", pid: 42, startedAt: NOW, progress: { done: 5, total: 16 }, source: "linker" }] });

  it("formats progress shapes", () => {
    assert.equal(progressText({ done: 5, total: 16 }), "5/16");
    assert.equal(progressText(0.25), "25%");
    assert.equal(progressText("3/9"), "3/9");
    assert.equal(progressText(null), null);
  });

  it("names recorded Linker command lines briefly", () => {
    const job = (label: string) => ({ kind: "instance-test", label, pid: 1, startedAt: NOW, progress: null, source: "linker" as const });
    assert.equal(jobTitle(job("minecraft_variants regress --profile smoke --output build/tasks/release-1.0.4/regress-smoke-2")), "回归 · smoke");
    assert.equal(jobTitle(job("minecraft_variants accept --variant fabric-1.21.1 --scenario world-import --artifacts reuse --output D:/x/y")), "验收 · fabric-1.21.1 · world-import");
    assert.equal(jobTitle(job("instance_test run world-import --preset world-import-wide-atlas --artifacts reuse")), "实例测试 · world-import");
    assert.equal(jobTitle(job("minecraft_variants build-all --tests --jobs 4 --output D:/a/b")), "构建全部变体");
    assert.equal(jobTitle(job("remove_task_tree D:/dcml/worktrees/linker-x")), "清理任务目录");
    assert.equal(jobTitle(job("npm build")), "npm build");
    assert.equal(jobTitle(job("some_tool D:/very/long/path/that/goes/on/and/on --flag 1")), "some_tool");
  });

  it("shows a chip for Linker tests", () => {
    const view = hostChipView(linker);
    assert.equal(view.visible, true);
    assert.equal(view.text, "Linker 测试运行中 · regress 5/16");
  });

  it("hides the chip when idle or when only DMCL's own jobs run", () => {
    assert.equal(hostChipView(null).visible, false);
    assert.equal(hostChipView({ busy: false, jobs: [] }).visible, false);
    const own = parseHostActivity({ busy: true, jobs: [{ kind: "build", label: "fabric 1.21.4", source: "dmcl" }] });
    assert.equal(hostChipView(own).visible, false);
    assert.equal(shouldWarnBeforeLaunch(own), false);
  });

  it("counts extra jobs and warns before launching into a busy host", () => {
    const many = parseHostActivity({ busy: true, jobs: [
      { kind: "regress", label: "regress", progress: "5/16", source: "linker" },
      { kind: "build", label: "gradle", source: "linker" },
    ] });
    assert.match(hostChipView(many).text, /另有 1 项$/);
    assert.equal(shouldWarnBeforeLaunch(linker), true);
    assert.equal(shouldWarnBeforeLaunch({ busy: true, jobs: [] }), true);
    assert.equal(shouldWarnBeforeLaunch({ busy: false, jobs: [] }), false);
    assert.match(busyWarningText(linker), /Linker 测试正在运行/);
  });
});

describe("job feed", () => {
  afterEach(() => resetJobsApiProbe());

  it("follows the job API with incremental log reads", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchJson = async (path: string) => {
      calls.push(path);
      if (path === "/api/jobs/j1") {
        polls++;
        return { jobId: "j1", variantId: "v1", kind: "run", state: polls < 3 ? "running" : "succeeded", phase: polls < 3 ? "compile" : "exited", startedAt: 1, phaseStartedAt: 1, finishedAt: polls < 3 ? null : 2, reason: null, logLineCount: 3 };
      }
      if (path.startsWith("/api/jobs/j1/log?from=")) {
        const from = Number(path.split("=")[1]);
        return from === 0 ? { lines: ["a", "b"], next: 2, done: false } : { lines: ["c"], next: 3, done: true };
      }
      throw new Error("unexpected " + path);
    };
    const feed = await openJobFeed({ jobId: "j1", fetchJson, legacy: { variantId: "v1", kind: "run", outcome: async () => "failed" } });
    assert.equal(feed.legacy, false);
    assert.equal(jobsApiSupport(), "yes");
    const u1 = await feed.next();
    assert.deepEqual(u1.lines, ["a", "b"]);
    assert.equal(u1.finished, false);
    const u2 = await feed.next();
    assert.deepEqual(u2.lines, ["c"]);
    assert.equal(u2.finished, false);
    const u3 = await feed.next();
    assert.equal(u3.job.state, "succeeded");
    assert.equal(u3.finished, true);
    assert.ok(calls.includes("/api/jobs/j1/log?from=2"));
  });

  it("falls back to the variant live log on the older backend", async () => {
    let live = ["Starting a Gradle Daemon", "> Task :compileJava"];
    let source = "live";
    const fetchJson = async (path: string) => {
      if (path.startsWith("/api/jobs/")) throw new ApiError(404, "HTTP 404", false);
      if (path === "/api/variants/v1/log") return { content: live.join("\n"), source };
      if (path === "/api/queue") return { active: 0, pending: 0 };
      throw new Error("unexpected " + path);
    };
    const feed = await openJobFeed({ jobId: "legacy-job", fetchJson, legacy: { variantId: "v1", kind: "run", outcome: async () => "failed" } });
    assert.equal(feed.legacy, true);
    assert.equal(jobsApiSupport(), "no");
    const u1 = await feed.next();
    assert.equal(u1.job.state, "running");
    assert.equal(u1.job.phase, "compile");
    assert.equal(u1.lines.length, 2);
    live = [...live, "> Task :runClient"];
    const u2 = await feed.next();
    assert.deepEqual(u2.lines, ["> Task :runClient"]);
    assert.equal(u2.job.phase, "starting");
    source = "saved";
    live = [...live, "BUILD FAILED"];
    const u3 = await feed.next();
    assert.equal(u3.finished, true);
    assert.equal(u3.reset, true);
    assert.equal(u3.job.state, "failed");
  });

  it("treats a JSON 404 as an unknown job, not a missing job API", async () => {
    const fetchJson = async (path: string) => {
      if (path.startsWith("/api/jobs/")) throw new ApiError(404, "任务不存在", true);
      if (path === "/api/variants/v1/log") return { content: "saved line", source: "saved" };
      throw new Error("unexpected " + path);
    };
    const feed = await openJobFeed({ jobId: "gone", fetchJson, legacy: { variantId: "v1", kind: "run", outcome: async () => "succeeded" } });
    assert.equal(jobsApiSupport(), "yes");
    const u = await feed.next();
    assert.equal(u.finished, true);
    assert.deepEqual(u.lines, ["saved line"]);
  });

  it("parses jobs strictly", () => {
    assert.equal(parseJob({ state: "running" }), null);
    assert.equal(parseJob({ jobId: "x", state: "weird" }), null);
    assert.equal(parseJob({ jobId: "x", state: "queued" })?.phase, "queued");
  });
});
