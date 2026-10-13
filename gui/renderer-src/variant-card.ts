/**
 * Variant cards: identity (loader, MC version, mod version, path), one primary 启动 action,
 * compact secondary actions, and a status badge with human time. Keyed, so polling
 * refreshes do not close open menus or steal focus.
 */
import { LOADER_LABELS } from "./constants";
import { variantStatusOf, type VariantStatus } from "./contract";
import { esc } from "./dom";
import { icon, loaderIcon } from "./icons";
import { humanTime, shortPath, statusView } from "./status";

export type CardAction =
  | "run" | "view-job" | "build" | "logs" | "source-hub" | "folder" | "cursor"
  | "relocate" | "sources-report" | "unlink" | "delete";

export interface CardContext {
  /** Whether a job id is known for the variant (enables 查看进度 / 日志 of that job). */
  hasJob(variantId: string): boolean;
  onAction(variant: Record<string, any>, action: CardAction): void;
}

function sourceSummary(v: Record<string, any>): { ready: boolean; text: string; reports: number } {
  const s = v.sourceStatus || {};
  const ready = s.ready === true;
  const reports = (s.mods || []).filter((m: any) => !!m.reportFilePath).length;
  const text = ready
    ? (s.minecraftReady ? "源码已准备 · MC + " + (s.modCount || 0) + " 个模组" : (s.modCount || 0) + " 个模组源码已准备")
    : "源码未准备";
  return { ready, text, reports };
}

/** Everything that changes a card except the relative time text. */
function signature(v: Record<string, any>, status: VariantStatus, hasJob: boolean): string {
  const src = sourceSummary(v);
  return [v.loader, v.mcVersion, v.modVersion, v.projectPath, v.pathMissing ? 1 : 0, status.state, status.kind,
    status.at, status.reason, status.phaseReached, status.activeJobId, hasJob ? 1 : 0, src.text, src.reports].join("|");
}

function cardHtml(v: Record<string, any>, status: VariantStatus, hasJob: boolean, now: number): string {
  const view = statusView(status, now);
  const loaderName = LOADER_LABELS[v.loader] || v.loader;
  const src = sourceSummary(v);
  const missing = v.pathMissing === true;
  const primary = view.active
    ? '<button type="button" class="btn btn-primary btn-launch is-active" data-action="view-job">' + icon("terminal") + "查看进度</button>"
    : missing
      ? '<button type="button" class="btn btn-primary btn-launch" data-action="relocate">' + icon("folder") + "重新定位</button>"
      : '<button type="button" class="btn btn-primary btn-launch" data-action="run" title="启动 Minecraft 客户端（只启动，不做完整构建）">' + icon("play") + "启动</button>";
  const showReason = view.tone === "danger" && !!view.reason;
  return (
    '<div class="vcard-id">' +
      '<span class="loader-badge loader-' + esc(v.loader) + '" aria-hidden="true">' + loaderIcon(v.loader) + "</span>" +
      '<div class="vcard-title">' +
        "<h4><span class=\"vcard-loader\">" + esc(loaderName) + '</span> <span class="vcard-mc">' + esc(v.mcVersion) + "</span></h4>" +
        '<div class="vcard-meta">' +
          (v.modVersion ? '<span class="vcard-ver">v' + esc(v.modVersion) + "</span>" : "") +
          '<span class="vcard-path" title="' + esc(v.projectPath || "") + '">' + esc(shortPath(v.projectPath || "", 2, 28)) + "</span>" +
          (missing ? '<span class="vcard-flag">' + icon("warning") + "目录丢失</span>" : "") +
        "</div>" +
      "</div>" +
    "</div>" +
    '<button type="button" class="status-badge tone-' + view.tone + '" data-action="' + (view.active || hasJob ? "view-job" : "logs") + '"' +
      ' title="' + esc(view.detail + (view.reason && !view.detail.includes(view.reason) ? "\n" + view.reason : "")) + '"' +
      ' aria-label="状态：' + esc(view.label + (view.time ? "，" + view.time : "")) + '，查看日志">' +
      '<span class="status-dot" aria-hidden="true"></span><span class="status-label">' + esc(view.label) + "</span>" +
      (view.time ? '<span class="status-time" data-at="' + esc(String(status.at ?? "")) + '">' + esc(view.time) + "</span>" : "") +
    "</button>" +
    (showReason ? '<p class="vcard-reason" title="' + esc(view.reason || "") + '">' + esc(view.reason || "") + "</p>" : "") +
    '<div class="vcard-actions">' +
      primary +
      '<div class="btn-cluster" role="group" aria-label="更多操作">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="build" title="完整 Gradle 构建">' + icon("build") + "构建</button>" +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="logs" title="最近一次任务的日志">' + icon("terminal") + "日志</button>" +
        '<button type="button" class="btn btn-ghost btn-sm' + (src.ready ? " has-dot" : "") + '" data-action="source-hub" title="' + esc(src.text) + '">' + icon(src.ready ? "folder" : "sparkles") + "源码</button>" +
        '<button type="button" class="btn btn-ghost btn-sm btn-square" data-action="folder" title="打开项目文件夹" aria-label="打开项目文件夹">' + icon("external") + "</button>" +
        '<details class="action-menu"><summary class="btn btn-ghost btn-sm btn-square" aria-label="更多变体操作" title="更多">' + icon("more") + "</summary>" +
          '<div class="action-menu-popover">' +
            '<button type="button" data-action="cursor">用 Cursor 打开</button>' +
            '<button type="button" data-action="relocate">重新定位项目</button>' +
            (src.reports ? '<button type="button" data-action="sources-report">依赖 API 报告</button>' : "") +
            '<span class="menu-separator"></span>' +
            '<button type="button" data-action="unlink">仅移除登记</button>' +
            '<button type="button" class="menu-danger" data-action="delete">删除变体</button>' +
          "</div></details>" +
      "</div>" +
    "</div>"
  );
}

/** Renders/updates cards in `container`, reusing unchanged ones. */
export function renderVariantCards(container: HTMLElement, variants: Array<Record<string, any>>, ctx: CardContext, now = Date.now()): void {
  const existing = new Map<string, HTMLElement>();
  container.querySelectorAll<HTMLElement>(":scope > .vcard[data-variant-id]").forEach((el) => {
    existing.set(el.dataset.variantId || "", el);
  });
  container.querySelectorAll(":scope > :not(.vcard)").forEach((el) => el.remove());

  let prev: Element | null = null;
  for (const v of variants) {
    const status = variantStatusOf(v);
    const hasJob = ctx.hasJob(v.id);
    const sig = signature(v, status, hasJob);
    let card = existing.get(v.id);
    existing.delete(v.id);
    if (!card) {
      card = document.createElement("article");
      card.className = "vcard";
      card.dataset.variantId = v.id;
      card.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
        if (!btn || !card!.contains(btn)) return;
        e.stopPropagation();
        btn.closest("details")?.removeAttribute("open");
        const current = (card as HTMLElement & { _variant?: Record<string, any> })._variant;
        if (current) ctx.onAction(current, btn.dataset.action as CardAction);
      });
    }
    (card as HTMLElement & { _variant?: Record<string, any> })._variant = v;
    if (card.dataset.sig !== sig) {
      const openMenu = card.querySelector("details[open]") !== null;
      const focusedAction = (document.activeElement as HTMLElement | null)?.closest?.(".vcard") === card
        ? (document.activeElement as HTMLElement).dataset.action : undefined;
      card.innerHTML = cardHtml(v, status, hasJob, now);
      card.dataset.sig = sig;
      card.className = "vcard tone-" + statusView(status, now).tone + (v.pathMissing ? " is-missing" : "");
      if (openMenu) card.querySelector("details")?.setAttribute("open", "");
      if (focusedAction) card.querySelector<HTMLElement>('[data-action="' + focusedAction + '"]')?.focus();
    }
    const expected: Element | null = prev ? prev.nextElementSibling : container.firstElementChild;
    if (expected !== card) container.insertBefore(card, expected);
    prev = card;
  }
  existing.forEach((el) => el.remove());
}

/** Refreshes "3 分钟前" labels without re-rendering cards. */
export function refreshRelativeTimes(root: ParentNode, now = Date.now()): void {
  root.querySelectorAll<HTMLElement>("[data-at]").forEach((el) => {
    const at = el.dataset.at;
    if (!at) return;
    const label = humanTime(/^\d+$/.test(at) ? Number(at) : at, now);
    if (label && el.textContent !== label) el.textContent = label;
  });
}
