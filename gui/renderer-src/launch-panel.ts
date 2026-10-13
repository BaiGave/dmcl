/**
 * Launch panel: a non-modal drawer that follows one build/run job — phase stepper,
 * elapsed time, live log, failure summary and cancel. Reopenable for any job.
 */
import { api } from "./api";
import { type JobInfo, type JobKind, type JobState, isTerminal } from "./contract";
import { esc, notify } from "./dom";
import { icon, loaderIcon } from "./icons";
import { type JobFeed, openJobFeed } from "./job-feed";
import { LogBuffer, type LogFilter, extractErrorHighlights } from "./log-buffer";
import { LogView } from "./log-view";
import { PhaseTimeline, buildStepper, jobHeadline, JOB_STATE_LABELS, totalElapsed } from "./phases";
import { formatDuration, shortPath } from "./status";
import { LOADER_LABELS } from "./constants";

export interface PanelVariant {
  id: string;
  loader: string;
  mcVersion: string;
  modVersion?: string;
  projectPath: string;
  modName?: string;
}

export interface OpenPanelOptions {
  variant: PanelVariant;
  jobId?: string | null;
  kind: JobKind;
  /** Follow a live job (true) or only show its saved log (false). Default: follow when a job id is given. */
  follow?: boolean;
  /** Reads the variant's stored result (used by the older backend once a job ends). */
  outcome: () => Promise<JobState>;
}

export interface PanelHooks {
  onJobFinished?: (job: JobInfo) => void;
  onRelaunch?: (variant: PanelVariant, kind: JobKind) => void;
}

// ---- remembered jobs (so 日志 / 查看进度 can reopen the last job of a variant)

const JOBS_KEY = "dmcl:last-jobs";
let lastJobs: Record<string, { jobId: string; kind: JobKind }> = {};
try {
  lastJobs = JSON.parse(sessionStorage.getItem(JOBS_KEY) || "{}") || {};
} catch {
  lastJobs = {};
}

export function rememberJob(variantId: string, jobId: string, kind: JobKind): void {
  lastJobs[variantId] = { jobId, kind };
  try { sessionStorage.setItem(JOBS_KEY, JSON.stringify(lastJobs)); } catch { /* storage unavailable */ }
}

export function lastJobFor(variantId: string): { jobId: string; kind: JobKind } | null {
  return lastJobs[variantId] || null;
}

function logDirOf(projectPath: string): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return projectPath.replace(/[\\/]+$/, "") + sep + ".dmcl" + sep + "logs";
}

function variantTitle(v: PanelVariant): string {
  return (LOADER_LABELS[v.loader] || v.loader) + " " + v.mcVersion;
}

const POLL_RUNNING_MS = 600;
const POLL_QUEUED_MS = 1500;
const POLL_LEGACY_MS = 1000;

export class LaunchPanel {
  private readonly root: HTMLElement;
  private readonly buffer = new LogBuffer();
  private readonly view = new LogView(this.buffer);
  private timeline = new PhaseTimeline();
  private feed: JobFeed | null = null;
  private job: JobInfo | null = null;
  private opts: OpenPanelOptions | null = null;
  private session = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  /** The job was seen queued/running in this session, so its end is news worth reporting. */
  private sawActive = false;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly hooks: PanelHooks = {}) {
    this.root = document.createElement("aside");
    this.root.className = "launch-panel";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "false");
    this.root.setAttribute("aria-labelledby", "lp-title");
    this.root.hidden = true;
    this.root.innerHTML =
      '<header class="lp-head">' +
        '<span class="lp-loader" aria-hidden="true"></span>' +
        '<div class="lp-heading"><h3 id="lp-title"></h3><p class="lp-sub"></p></div>' +
        '<button type="button" class="btn btn-icon btn-ghost lp-close" aria-label="关闭面板" title="关闭（Esc）">' + icon("close") + '</button>' +
      '</header>' +
      '<div class="lp-summary">' +
        '<span class="lp-state" data-state="queued"></span>' +
        '<strong class="lp-headline"></strong>' +
        '<span class="lp-elapsed" title="总用时">' + icon("clock") + '<span></span></span>' +
      '</div>' +
      '<ol class="lp-steps" aria-label="启动阶段"></ol>' +
      '<section class="lp-failure" hidden>' +
        '<div class="lp-failure-head">' + icon("error") + '<strong>失败原因</strong></div>' +
        '<p class="lp-failure-reason"></p>' +
        '<ul class="lp-failure-lines" aria-label="关键错误行"></ul>' +
      '</section>' +
      '<div class="lp-toolbar">' +
        '<div class="segmented" role="radiogroup" aria-label="日志筛选">' +
          '<button type="button" role="radio" aria-checked="true" data-filter="all">全部 <span class="seg-count" data-count="all">0</span></button>' +
          '<button type="button" role="radio" aria-checked="false" data-filter="issues">警告与错误 <span class="seg-count" data-count="issues">0</span></button>' +
        '</div>' +
        '<span class="lp-conn" hidden>连接中断，正在重试…</span>' +
        '<div class="lp-tools">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="copy" title="复制完整日志">' + icon("copy") + '复制</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="folder" title="打开日志文件夹">' + icon("folder") + '日志文件夹</button>' +
        '</div>' +
      '</div>' +
      '<div class="lp-log"></div>' +
      '<footer class="lp-foot">' +
        '<span class="lp-note"></span>' +
        '<button type="button" class="btn btn-danger btn-sm" data-act="cancel">' + icon("close") + '取消</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="relaunch" hidden>' + icon("play") + '<span>再次启动</span></button>' +
      '</footer>';
    (this.root.querySelector(".lp-log") as HTMLElement).appendChild(this.view.el);
    document.body.appendChild(this.root);
    this.wire();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** The job currently shown, if any. */
  get currentJob(): JobInfo | null {
    return this.job;
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private wire(): void {
    this.q(".lp-close").addEventListener("click", () => this.close());
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.querySelector(".modal-overlay.visible")) {
        e.stopPropagation();
        this.close();
      }
    });
    this.root.querySelectorAll<HTMLButtonElement>(".segmented [data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => this.setFilter(btn.dataset.filter as LogFilter));
    });
    this.q('[data-act="copy"]').addEventListener("click", () => void this.copy());
    this.q('[data-act="folder"]').addEventListener("click", () => void this.openFolder());
    this.q('[data-act="cancel"]').addEventListener("click", () => void this.cancel());
    this.q('[data-act="relaunch"]').addEventListener("click", () => {
      if (this.opts && this.job) this.hooks.onRelaunch?.(this.opts.variant, this.job.kind);
    });
    this.q(".lp-failure-lines").addEventListener("click", (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("[data-line]");
      if (li) this.view.reveal(Number(li.dataset.line));
    });
  }

  private setFilter(filter: LogFilter): void {
    this.root.querySelectorAll<HTMLElement>(".segmented [data-filter]").forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.filter === filter));
    });
    this.view.setFilter(filter);
  }

  /** Opens (or switches) the panel to a job. */
  async open(opts: OpenPanelOptions): Promise<void> {
    const session = ++this.session;
    this.stopTimers();
    this.opts = opts;
    this.job = null;
    this.feed = null;
    this.failures = 0;
    this.sawActive = false;
    this.timeline = new PhaseTimeline();
    this.buffer.clear();
    this.view.setBuffer(this.buffer);
    this.setFilter("all");
    if (this.root.hidden) this.returnFocus = document.activeElement as HTMLElement | null;
    this.root.hidden = false;
    document.body.classList.add("has-launch-panel");

    const v = opts.variant;
    this.q(".lp-loader").innerHTML = loaderIcon(v.loader);
    this.q(".lp-loader").className = "lp-loader loader-" + v.loader;
    this.q("#lp-title").textContent = (v.modName ? v.modName + " · " : "") + variantTitle(v);
    const sub = this.q(".lp-sub");
    sub.textContent = [v.modVersion ? "v" + v.modVersion : null, shortPath(v.projectPath, 3, 56)].filter(Boolean).join(" · ");
    sub.title = v.projectPath;
    this.renderJob(null);
    requestAnimationFrame(() => this.q(".lp-close").focus());

    try {
      const feed = await openJobFeed({
        jobId: opts.jobId,
        legacy: {
          variantId: v.id, kind: opts.kind, jobId: opts.jobId, outcome: opts.outcome,
          staticOnly: opts.follow === undefined ? undefined : !opts.follow,
        },
      });
      if (session !== this.session) return;
      this.feed = feed;
      this.q(".lp-note").textContent = feed.legacy && opts.jobId ? "当前后端未提供阶段数据，阶段根据日志推断" : "";
      await this.poll(session);
    } catch (err) {
      if (session !== this.session) return;
      this.showConnectionError(err);
      this.pollTimer = setTimeout(() => void this.open(opts), 3000);
    }
  }

  /** Shows the last job again (refetching it from the start). */
  reopen(): void {
    if (this.opts && !this.isOpen) void this.open(this.opts);
  }

  close(): void {
    if (this.root.hidden) return;
    this.session++;
    this.stopTimers();
    this.root.hidden = true;
    document.body.classList.remove("has-launch-panel");
    this.returnFocus?.focus?.();
    this.returnFocus = null;
  }

  private stopTimers(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.pollTimer = null;
    this.clockTimer = null;
  }

  private async poll(session: number): Promise<void> {
    if (!this.feed || session !== this.session) return;
    let finished = false;
    try {
      const update = await this.feed.next();
      if (session !== this.session) return;
      this.failures = 0;
      this.q(".lp-conn").hidden = true;
      if (update.reset) this.buffer.clear();
      if (update.lines.length || update.reset) {
        this.buffer.append(update.lines);
        this.view.refresh();
      }
      this.job = update.job;
      this.timeline.observe(update.job);
      this.renderJob(update.job);
      finished = update.finished;
      if (finished && this.sawActive) this.hooks.onJobFinished?.(update.job);
      if (!isTerminal(update.job.state)) this.sawActive = true;
    } catch (err) {
      if (session !== this.session) return;
      this.failures++;
      this.showConnectionError(err);
    }
    if (finished || session !== this.session) {
      if (this.clockTimer) clearInterval(this.clockTimer);
      this.clockTimer = null;
      return;
    }
    if (!this.clockTimer) this.clockTimer = setInterval(() => this.renderClock(), 1000);
    const base = this.feed.legacy ? POLL_LEGACY_MS : this.job?.state === "queued" ? POLL_QUEUED_MS : POLL_RUNNING_MS;
    const delay = this.failures ? Math.min(10_000, base * 2 ** this.failures) : base;
    this.pollTimer = setTimeout(() => void this.poll(session), delay);
  }

  private showConnectionError(err: unknown): void {
    const conn = this.q(".lp-conn");
    conn.hidden = false;
    conn.title = err instanceof Error ? err.message : String(err);
  }

  private renderClock(): void {
    if (!this.job) return;
    const elapsed = totalElapsed(this.job);
    this.q(".lp-elapsed span").textContent = formatDuration(elapsed);
    this.renderSteps(this.job);
  }

  private renderSteps(job: JobInfo): void {
    const steps = buildStepper(job, this.timeline);
    const list = this.q(".lp-steps");
    if (list.childElementCount !== steps.length) {
      list.innerHTML = steps.map(() =>
        '<li class="lp-step"><span class="lp-step-dot" aria-hidden="true"></span><span class="lp-step-label"></span><span class="lp-step-time"></span></li>',
      ).join("");
    }
    steps.forEach((step, i) => {
      const li = list.children[i] as HTMLElement;
      li.dataset.state = step.state;
      if (step.state === "active") li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
      (li.querySelector(".lp-step-label") as HTMLElement).textContent = step.label;
      (li.querySelector(".lp-step-time") as HTMLElement).textContent =
        step.state === "pending" ? "" : step.state === "skipped" ? "跳过" : formatDuration(step.durationMs);
    });
  }

  private renderJob(job: JobInfo | null): void {
    const stateEl = this.q(".lp-state");
    const headline = this.q(".lp-headline");
    const cancel = this.q<HTMLButtonElement>('[data-act="cancel"]');
    const relaunch = this.q<HTMLButtonElement>('[data-act="relaunch"]');
    if (!job) {
      stateEl.dataset.state = "queued";
      stateEl.textContent = "连接中";
      headline.textContent = "正在获取任务状态…";
      this.q(".lp-elapsed span").textContent = "—";
      this.q(".lp-steps").innerHTML = "";
      this.q(".lp-failure").hidden = true;
      cancel.hidden = true;
      relaunch.hidden = true;
      return;
    }
    stateEl.dataset.state = job.state;
    stateEl.textContent = JOB_STATE_LABELS[job.state];
    headline.textContent = jobHeadline(job);
    this.q(".lp-elapsed span").textContent = formatDuration(totalElapsed(job));
    const isStatic = job.jobId.startsWith("legacy:") && job.startedAt === null;
    this.q(".lp-steps").hidden = isStatic;
    if (!isStatic) this.renderSteps(job);
    if (isStatic) {
      stateEl.textContent = "日志";
      headline.textContent = "最近一次构建或启动的日志";
    }
    cancel.hidden = isTerminal(job.state);
    cancel.disabled = false;
    relaunch.hidden = !isTerminal(job.state) || !this.hooks.onRelaunch;
    const relaunchLabel = relaunch.querySelector("span");
    if (relaunchLabel) relaunchLabel.textContent = job.kind === "build" ? "重新构建" : job.state === "failed" ? "重试启动" : "再次启动";
    this.root.dataset.state = job.state;
    this.renderCounts();
    this.renderFailure(job);
  }

  private renderCounts(): void {
    this.q('[data-count="all"]').textContent = String(this.buffer.end);
    const issues = this.buffer.count("issues");
    const el = this.q('[data-count="issues"]');
    el.textContent = String(issues);
    el.classList.toggle("has-errors", this.buffer.errorCount > 0);
  }

  private renderFailure(job: JobInfo): void {
    const box = this.q(".lp-failure");
    if (job.state !== "failed") {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    this.q(".lp-failure-reason").textContent = job.reason || (job.kind === "run" ? "游戏进程异常退出" : "Gradle 构建失败");
    const highlights = extractErrorHighlights(this.buffer, 6);
    this.q(".lp-failure-lines").innerHTML = highlights.map((h) =>
      '<li><button type="button" data-line="' + h.line + '" title="在日志中定位第 ' + (h.line + 1) + ' 行"><span class="ln">' + (h.line + 1) + '</span><code>' + esc(h.text.trim()) + "</code></button></li>",
    ).join("");
  }

  private async copy(): Promise<void> {
    const text = this.buffer.text();
    try {
      await navigator.clipboard.writeText(text);
      notify("已复制 " + this.buffer.size + " 行日志", "success");
    } catch {
      notify("复制失败：剪贴板不可用", "error");
    }
  }

  private async openFolder(): Promise<void> {
    if (!this.opts) return;
    const dir = logDirOf(this.opts.variant.projectPath);
    try {
      await api("/api/open-folder", { method: "POST", body: { path: dir } });
    } catch (err) {
      notify("无法打开日志文件夹：" + (err instanceof Error ? err.message : String(err)), "error");
    }
  }

  private async cancel(): Promise<void> {
    if (!this.feed || !this.job) return;
    const btn = this.q<HTMLButtonElement>('[data-act="cancel"]');
    btn.disabled = true;
    try {
      await this.feed.cancel();
      notify(this.feed.legacy ? "已请求取消（当前后端会取消整个队列）" : "已请求取消", "warning");
    } catch (err) {
      btn.disabled = false;
      notify("取消失败：" + (err instanceof Error ? err.message : String(err)), "error");
    }
  }
}

/** Mounts into the page once; returns the singleton. */
let instance: LaunchPanel | null = null;
export function launchPanel(hooks?: PanelHooks): LaunchPanel {
  if (!instance) instance = new LaunchPanel(hooks);
  return instance;
}
