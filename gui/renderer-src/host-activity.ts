/**
 * Host activity: shows when Linker tests or other heavy jobs share this machine, and asks
 * before launching into a busy host. Decisions are pure; the DOM part only renders them.
 */
import { api, isNotFound } from "./api";
import { type HostActivity, type HostJob, parseHostActivity, toMillis } from "./contract";
import { esc } from "./dom";
import { icon } from "./icons";
import { formatDuration } from "./status";

export function progressText(progress: unknown): string | null {
  if (progress === null || progress === undefined || progress === "") return null;
  if (typeof progress === "string") return progress;
  if (typeof progress === "number" && Number.isFinite(progress)) {
    const pct = progress <= 1 ? progress * 100 : progress;
    return Math.round(Math.max(0, Math.min(100, pct))) + "%";
  }
  if (typeof progress === "object") {
    const p = progress as Record<string, unknown>;
    const done = typeof p.done === "number" ? p.done : typeof p.current === "number" ? p.current : null;
    const total = typeof p.total === "number" ? p.total : null;
    if (done !== null && total !== null) return done + "/" + total;
    if (typeof p.percent === "number") return progressText(p.percent > 1 ? p.percent / 100 : p.percent);
  }
  return null;
}

export function sourceLabel(job: HostJob): string {
  if (job.source === "linker") return /test|regress|instance/i.test(job.kind + " " + job.label) ? "Linker 测试" : "Linker 任务";
  if (job.source === "dmcl") return "DMCL";
  return "其他任务";
}

function jobSummary(job: HostJob): string {
  const progress = progressText(job.progress);
  return [job.label || job.kind, progress].filter(Boolean).join(" ");
}

export interface ChipView {
  visible: boolean;
  tone: "idle" | "busy";
  text: string;
  title: string;
}

/** Chip in the header. Hidden when the host is idle; DMCL's own jobs already show in the queue bar. */
export function hostChipView(activity: HostActivity | null): ChipView {
  if (!activity) return { visible: false, tone: "idle", text: "", title: "" };
  const external = activity.jobs.filter((j) => j.source !== "dmcl");
  if (!external.length) {
    return activity.busy && !activity.jobs.length
      ? { visible: true, tone: "busy", text: "主机繁忙", title: "主机正在运行重型任务" }
      : { visible: false, tone: "idle", text: "", title: "" };
  }
  const lead = external[0];
  const head = sourceLabel(lead) + "运行中";
  const detail = jobSummary(lead);
  const more = external.length - 1;
  const text = head + (detail ? " · " + detail : "") + (more > 0 ? " · 另有 " + more + " 项" : "");
  const title = activity.jobs.map((j) => sourceLabel(j) + "：" + jobSummary(j)).join("\n");
  return { visible: true, tone: "busy", text, title };
}

/**
 * Whether to ask before launching. DMCL's own queued work does not count — the queue
 * already orders it — but Linker tests and unknown heavy work on the same host do.
 */
export function shouldWarnBeforeLaunch(activity: HostActivity | null): boolean {
  if (!activity || !activity.busy) return false;
  if (!activity.jobs.length) return true;
  return activity.jobs.some((j) => j.source !== "dmcl");
}

export function busyWarningText(activity: HostActivity): string {
  const external = activity.jobs.filter((j) => j.source !== "dmcl");
  if (!external.length) return "主机正在运行重型任务，现在启动可能较慢。";
  const names = external.slice(0, 2).map(jobSummary).join("、");
  return sourceLabel(external[0]) + "正在运行（" + names + (external.length > 2 ? " 等" : "") + "），现在启动会互相抢占 CPU 与内存，可能较慢。";
}

// ---------------------------------------------------------------- DOM

const POLL_MS = 5000;
const RETRY_MISSING_MS = 60_000;

export class HostActivityMonitor {
  private latest: HostActivity | null = null;
  private fetchedAt = 0;
  private supported = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chip: HTMLButtonElement | null = null;
  private popover: HTMLElement | null = null;

  constructor(mount: HTMLElement | null) {
    if (mount) this.buildChip(mount);
  }

  start(): void {
    void this.tick();
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    await this.refresh();
    this.schedule(this.supported ? POLL_MS : RETRY_MISSING_MS);
  }

  /** Fetches now; resolves to the latest activity (null when the backend has no endpoint). */
  async refresh(): Promise<HostActivity | null> {
    try {
      this.latest = parseHostActivity(await api("/api/host-activity"));
      this.supported = true;
    } catch (err) {
      if (isNotFound(err)) this.supported = false;
      this.latest = null;
    }
    this.fetchedAt = Date.now();
    this.render();
    return this.latest;
  }

  /** Activity no older than `maxAgeMs`, fetching if needed. */
  async current(maxAgeMs = 3000): Promise<HostActivity | null> {
    if (!this.supported && Date.now() - this.fetchedAt < RETRY_MISSING_MS) return null;
    if (Date.now() - this.fetchedAt <= maxAgeMs) return this.latest;
    return this.refresh();
  }

  private buildChip(mount: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "host-chip-wrap";
    wrap.innerHTML =
      '<button type="button" class="host-chip" hidden aria-haspopup="dialog" aria-expanded="false">' +
        '<span class="host-chip-pulse" aria-hidden="true"></span><span class="host-chip-text"></span></button>' +
      '<div class="host-popover" role="dialog" aria-label="主机上的任务" hidden></div>';
    mount.prepend(wrap);
    this.chip = wrap.querySelector(".host-chip");
    this.popover = wrap.querySelector(".host-popover");
    this.chip?.addEventListener("click", () => this.togglePopover());
    document.addEventListener("click", (e) => {
      if (!this.popover || this.popover.hidden) return;
      if (!wrap.contains(e.target as Node)) this.togglePopover(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.popover && !this.popover.hidden) {
        this.togglePopover(false);
        this.chip?.focus();
      }
    });
  }

  private togglePopover(force?: boolean): void {
    if (!this.popover || !this.chip) return;
    const open = force ?? this.popover.hidden;
    this.popover.hidden = !open;
    this.chip.setAttribute("aria-expanded", String(open));
    if (open) this.renderPopover();
  }

  private render(): void {
    if (!this.chip) return;
    const view = hostChipView(this.latest);
    this.chip.hidden = !view.visible;
    this.chip.title = view.title;
    const text = this.chip.querySelector(".host-chip-text");
    if (text) text.textContent = view.text;
    if (!view.visible) this.togglePopover(false);
    else if (this.popover && !this.popover.hidden) this.renderPopover();
  }

  private renderPopover(): void {
    if (!this.popover) return;
    const jobs = this.latest?.jobs || [];
    const now = Date.now();
    this.popover.innerHTML =
      '<div class="host-popover-head"><strong>主机上的任务</strong><span>与 DMCL 共用 CPU 与内存</span></div>' +
      (jobs.length
        ? '<ul class="host-job-list">' + jobs.map((j) => {
          const started = toMillis(j.startedAt ?? null);
          const progress = progressText(j.progress);
          return '<li><span class="host-job-source source-' + esc(j.source) + '">' + esc(sourceLabel(j)) + '</span>' +
            '<span class="host-job-label">' + esc(j.label || j.kind) + '</span>' +
            '<span class="host-job-meta">' + esc([progress, started !== null ? "已运行 " + formatDuration(now - started) : null, j.pid ? "PID " + j.pid : null].filter(Boolean).join(" · ")) + '</span></li>';
        }).join("") + "</ul>"
        : '<p class="host-popover-empty">主机繁忙，但没有任务详情。</p>');
  }
}

/**
 * Non-blocking warning shown when launching into a busy host. Resolves true for
 * "仍然启动", false for "稍后" (or when dismissed). The rest of the UI stays usable.
 */
export function askLaunchWhileBusy(activity: HostActivity, target: string): Promise<boolean> {
  document.querySelector(".busy-warning")?.dispatchEvent(new CustomEvent("dismiss"));
  return new Promise((resolve) => {
    const card = document.createElement("section");
    card.className = "busy-warning";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-labelledby", "busy-warning-title");
    card.innerHTML =
      '<div class="busy-warning-icon">' + icon("warning") + '</div>' +
      '<div class="busy-warning-body"><h4 id="busy-warning-title">主机正忙，仍要启动 ' + esc(target) + '？</h4>' +
      '<p></p></div>' +
      '<div class="busy-warning-actions"><button type="button" class="btn btn-secondary btn-sm" data-choice="later">稍后</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-choice="go">' + icon("play") + '仍然启动</button></div>';
    const p = card.querySelector("p");
    if (p) p.textContent = busyWarningText(activity);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      card.classList.add("leaving");
      setTimeout(() => card.remove(), 160);
      resolve(value);
    };
    card.addEventListener("dismiss", () => finish(false));
    card.addEventListener("click", (e) => {
      const choice = (e.target as HTMLElement).closest<HTMLElement>("[data-choice]")?.dataset.choice;
      if (choice) finish(choice === "go");
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
    });
    document.body.appendChild(card);
    requestAnimationFrame(() => card.querySelector<HTMLElement>('[data-choice="go"]')?.focus());
  });
}
