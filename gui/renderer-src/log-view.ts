/**
 * Virtualised log viewer: renders only the rows in view, so tens of thousands of lines
 * stay smooth. Follows the tail until the user scrolls up.
 */
import { type LogBuffer, type LogFilter, isAtBottom, visibleRange } from "./log-buffer";

const ROW_HEIGHT = 18;

export class LogView {
  readonly el: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly jump: HTMLButtonElement;
  private buffer: LogBuffer;
  private filter: LogFilter = "all";
  private follow = true;
  private frame = 0;
  private marked = -1;
  private lastScrollTop = 0;

  constructor(buffer: LogBuffer) {
    this.buffer = buffer;
    this.el = document.createElement("div");
    this.el.className = "log-view";
    this.el.innerHTML =
      '<div class="log-viewport" tabindex="0" role="log" aria-live="off" aria-label="日志输出">' +
        '<div class="log-spacer"><div class="log-rows"></div></div></div>' +
      '<button type="button" class="log-jump" hidden>↓ 跳到最新</button>';
    this.viewport = this.el.querySelector(".log-viewport") as HTMLElement;
    this.spacer = this.el.querySelector(".log-spacer") as HTMLElement;
    this.rows = this.el.querySelector(".log-rows") as HTMLElement;
    this.jump = this.el.querySelector(".log-jump") as HTMLButtonElement;
    this.viewport.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.jump.addEventListener("click", () => this.setFollow(true));
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.schedule()).observe(this.viewport);
  }

  setBuffer(buffer: LogBuffer): void {
    this.buffer = buffer;
    this.marked = -1;
    this.setFollow(true);
  }

  setFilter(filter: LogFilter): void {
    if (filter === this.filter) return;
    this.filter = filter;
    this.marked = -1;
    if (this.follow) this.schedule();
    else this.viewport.scrollTop = 0;
    this.schedule();
  }

  get following(): boolean {
    return this.follow;
  }

  setFollow(follow: boolean): void {
    this.follow = follow;
    this.jump.hidden = true;
    if (follow) this.schedule();
  }

  /** Call after appending to the buffer. Coalesced to one render per frame. */
  refresh(): void {
    if (!this.follow && this.buffer.count(this.filter) > 0) this.jump.hidden = false;
    this.schedule();
  }

  /** Scrolls to an absolute line and marks it, leaving follow mode. */
  reveal(line: number): void {
    if (this.filter === "issues" && this.buffer.level(line) === "info") this.filter = "all";
    this.follow = false;
    this.marked = line;
    const row = this.buffer.lineToRow(this.filter, line);
    this.renderNow();
    this.viewport.scrollTop = Math.max(0, row * ROW_HEIGHT - this.viewport.clientHeight / 3);
    this.renderNow();
  }

  currentFilter(): LogFilter {
    return this.filter;
  }

  private onScroll(): void {
    const top = this.viewport.scrollTop;
    const atBottom = isAtBottom(top, this.viewport.scrollHeight, this.viewport.clientHeight, ROW_HEIGHT);
    if (top < this.lastScrollTop && !atBottom) this.follow = false;
    else if (atBottom) {
      this.follow = true;
      this.jump.hidden = true;
    }
    this.lastScrollTop = top;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    this.frame = raf(() => {
      this.frame = 0;
      this.renderNow();
    });
  }

  private renderNow(): void {
    const count = this.buffer.count(this.filter);
    this.spacer.style.height = count * ROW_HEIGHT + "px";
    if (this.follow) {
      this.viewport.scrollTop = this.viewport.scrollHeight;
      this.lastScrollTop = this.viewport.scrollTop;
    }
    const win = visibleRange(this.viewport.scrollTop, this.viewport.clientHeight || 400, ROW_HEIGHT, count, 30);
    this.rows.style.transform = "translateY(" + win.offset + "px)";
    const needed = win.end - win.start;
    while (this.rows.childElementCount < needed) {
      const row = document.createElement("div");
      row.className = "log-row";
      row.innerHTML = '<span class="log-ln"></span><span class="log-tx"></span>';
      this.rows.appendChild(row);
    }
    while (this.rows.childElementCount > needed) this.rows.lastElementChild?.remove();
    for (let i = 0; i < needed; i++) {
      const row = this.rows.children[i] as HTMLElement;
      const abs = this.buffer.rowToLine(this.filter, win.start + i);
      const level = this.buffer.level(abs);
      row.className = "log-row lvl-" + level + (abs === this.marked ? " is-marked" : "");
      (row.firstChild as HTMLElement).textContent = String(abs + 1);
      (row.lastChild as HTMLElement).textContent = this.buffer.line(abs) ?? "";
    }
  }
}
