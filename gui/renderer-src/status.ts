/** Pure status → label / tone / time formatting for variants and jobs. */
import { type JobPhase, type Timestamp, type VariantStatus, toMillis } from "./contract";

export const PHASE_LABELS: Record<JobPhase, string> = {
  queued: "排队",
  toolchain: "工具链",
  configure: "配置",
  compile: "编译",
  assets: "资源",
  starting: "启动游戏",
  "in-game": "已进入游戏",
  exited: "已退出",
};

/** A failure older than this is shown as history rather than as an alarm. */
export const STALE_FAILURE_MS = 24 * 60 * 60 * 1000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function dateLabel(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/** "刚刚" / "3 分钟前" / "2 小时前" / "昨天" / "5 天前" / "2026-09-01". */
export function humanTime(at: Timestamp | null | undefined, now: number = Date.now()): string | null {
  const ms = toMillis(at);
  if (ms === null) return null;
  const diff = now - ms;
  if (diff < 45_000) return "刚刚";
  if (diff < HOUR) return Math.max(1, Math.round(diff / MINUTE)) + " 分钟前";
  if (diff < DAY) return Math.round(diff / HOUR) + " 小时前";
  if (diff < 2 * DAY) return "昨天";
  if (diff < 30 * DAY) return Math.floor(diff / DAY) + " 天前";
  return dateLabel(ms);
}

/** Full local date-time for tooltips. */
export function exactTime(at: Timestamp | null | undefined): string | null {
  const ms = toMillis(at);
  if (ms === null) return null;
  const d = new Date(ms);
  return dateLabel(ms) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

/** "8s" / "3:05" / "1:02:03". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  if (total < 60) return total + "s";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? h + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
}

export type StatusTone = "success" | "running" | "queued" | "danger" | "stale" | "cancelled" | "idle";

export interface StatusView {
  tone: StatusTone;
  /** Short badge text, e.g. "运行中 · 编译". */
  label: string;
  /** Human age ("3 分钟前") or null when unknown. */
  time: string | null;
  /** Tooltip / expanded detail: what happened, when exactly, and why. */
  detail: string;
  reason: string | null;
  active: boolean;
}

export function statusView(status: VariantStatus, now: number = Date.now()): StatusView {
  const time = humanTime(status.at, now);
  const exact = exactTime(status.at);
  const kindLabel = status.kind === "build" ? "构建" : status.kind === "run" ? "启动" : "任务";
  const when = exact ? "（" + exact + "）" : "";
  const reason = status.reason;
  switch (status.state) {
    case "running": {
      const phase = status.phaseReached && status.phaseReached !== "queued" ? PHASE_LABELS[status.phaseReached] : null;
      return {
        tone: "running", label: phase ? "运行中 · " + phase : "运行中", time, reason,
        detail: kindLabel + "进行中" + (phase ? "，当前阶段：" + phase : ""), active: true,
      };
    }
    case "queued":
      return { tone: "queued", label: "排队中", time, reason, detail: kindLabel + "已加入队列，等待空闲槽位", active: true };
    case "succeeded": {
      const label = status.kind === "run" ? "启动成功" : status.kind === "build" ? "构建成功" : "就绪";
      return { tone: "success", label, time, reason, detail: "上次" + kindLabel + "成功" + when, active: false };
    }
    case "failed": {
      const ms = toMillis(status.at);
      const stale = ms === null || now - ms > STALE_FAILURE_MS;
      const head = stale ? "上次失败" : "失败";
      const phase = status.phaseReached ? "，停在「" + PHASE_LABELS[status.phaseReached] + "」" : "";
      return {
        tone: stale ? "stale" : "danger", label: head, time, reason,
        detail: "上次" + kindLabel + "失败" + phase + when + (reason ? "\n" + reason : ""), active: false,
      };
    }
    case "cancelled":
      return { tone: "cancelled", label: "已取消", time, reason, detail: kindLabel + "已取消" + when, active: false };
    default:
      return {
        tone: time ? "stale" : "idle", label: time ? "已过期" : "未运行", time, reason,
        detail: time ? "上次结果已失效（" + (exact || time) + "），建议重新启动验证" : "尚未在 DMCL 中构建或启动", active: false,
      };
  }
}

/** Shortens a path for display, keeping the last segments: "…\\projects\\mymod\\fabric-1.21.4". */
export function shortPath(path: string, keepSegments = 3, maxLength = 48): string {
  if (!path) return "";
  if (path.length <= maxLength) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  let tail = parts.slice(-keepSegments).join(sep);
  if (tail.length > maxLength - 2) tail = tail.slice(tail.length - (maxLength - 2));
  return "…" + sep + tail;
}
