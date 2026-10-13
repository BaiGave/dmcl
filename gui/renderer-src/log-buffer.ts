/**
 * In-memory log for one job: bounded line storage, warning/error index, and the
 * pure maths the virtualised log view needs. No DOM here.
 */

export type LineLevel = "info" | "warn" | "error";
export type LogFilter = "all" | "issues";

const ERROR_RE = /\b(ERROR|FATAL|SEVERE|FAILED|FAILURE)\b|Exception\b|^Caused by:|^\s+at [\w$.<>]+\(|^\s*error:|\berror: |What went wrong|Could not (?:resolve|find|determine)|crash report|Process .* finished with non-zero exit value/;
const WARN_RE = /\bWARN(?:ING)?\b|^\s*warning:|\bwarning: |\bdeprecated\b/i;

export function classifyLine(line: string): LineLevel {
  if (ERROR_RE.test(line)) return "error";
  if (WARN_RE.test(line)) return "warn";
  return "info";
}

const LEVEL_CODE: Record<LineLevel, number> = { info: 0, warn: 1, error: 2 };
const CODE_LEVEL: LineLevel[] = ["info", "warn", "error"];

/**
 * Append-only line store with a cap. Lines are addressed by absolute index (0 = first line
 * the job ever wrote); when the cap is exceeded the oldest lines are dropped in one batch.
 */
export class LogBuffer {
  private lines: string[] = [];
  private levels: number[] = [];
  /** Absolute indices of warn/error lines still in the buffer. */
  private issues: number[] = [];
  /** Number of lines dropped from the front. */
  dropped = 0;
  errorCount = 0;
  warnCount = 0;

  constructor(readonly cap = 200_000) {}

  /** Absolute index one past the last line. */
  get end(): number {
    return this.dropped + this.lines.length;
  }

  get size(): number {
    return this.lines.length;
  }

  append(lines: readonly string[]): void {
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      const level = classifyLine(line);
      const abs = this.end;
      this.lines.push(line);
      this.levels.push(LEVEL_CODE[level]);
      if (level !== "info") {
        this.issues.push(abs);
        if (level === "error") this.errorCount++;
        else this.warnCount++;
      }
    }
    const excess = this.lines.length - this.cap;
    if (excess > Math.max(1, Math.floor(this.cap / 10))) this.dropFront(excess);
  }

  private dropFront(count: number): void {
    this.lines.splice(0, count);
    this.levels.splice(0, count);
    this.dropped += count;
    let firstKept = 0;
    while (firstKept < this.issues.length && this.issues[firstKept] < this.dropped) firstKept++;
    if (firstKept) this.issues.splice(0, firstKept);
  }

  clear(): void {
    this.lines = [];
    this.levels = [];
    this.issues = [];
    this.dropped = 0;
    this.errorCount = 0;
    this.warnCount = 0;
  }

  /** Line at an absolute index, or undefined when dropped / out of range. */
  line(abs: number): string | undefined {
    return this.lines[abs - this.dropped];
  }

  level(abs: number): LineLevel {
    return CODE_LEVEL[this.levels[abs - this.dropped] ?? 0];
  }

  /** Number of rows the given filter shows. */
  count(filter: LogFilter): number {
    return filter === "issues" ? this.issues.length : this.lines.length;
  }

  /** Absolute line index of the n-th visible row under a filter. */
  rowToLine(filter: LogFilter, row: number): number {
    return filter === "issues" ? this.issues[row] : this.dropped + row;
  }

  /** Visible row of an absolute line index (nearest following row under "issues"). */
  lineToRow(filter: LogFilter, abs: number): number {
    if (filter === "all") return Math.max(0, abs - this.dropped);
    let lo = 0;
    let hi = this.issues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.issues[mid] < abs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Everything still held, newline-joined (with a note when the head was dropped). */
  text(): string {
    const head = this.dropped ? `…（前 ${this.dropped} 行已从界面缓存中移除，完整日志见日志文件夹）\n` : "";
    return head + this.lines.join("\n");
  }

  all(): readonly string[] {
    return this.lines;
  }
}

export interface RowWindow {
  /** First row to render (inclusive). */
  start: number;
  /** Row after the last one to render. */
  end: number;
  /** Pixel offset of `start`. */
  offset: number;
}

/** Rows to render for a scroll position, with overscan on both sides. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 20): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, offset: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  const start = Math.max(0, Math.min(count - 1, first - overscan));
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(start, end), offset: start * rowHeight };
}

/** True when the viewport sits at (or within `slack` px of) the bottom. */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, slack = 24): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

const COMPILER_ERROR_RE = /:\d+: error: |^e: (?:file:|\S+\.kt)/;

export interface Highlight {
  line: number;
  text: string;
}

/**
 * The lines worth showing under a failure: Gradle's "What went wrong" block when present,
 * otherwise the first exception with its cause, otherwise the last error lines.
 */
export function extractErrorHighlights(buffer: LogBuffer, max = 8): Highlight[] {
  const lines = buffer.all();
  const base = buffer.dropped;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\* What went wrong:?/.test(lines[i])) {
      const wrong: Highlight[] = [];
      for (let j = i + 1; j < lines.length && wrong.length < max; j++) {
        const text = lines[j];
        if (/^\* (Try|Get more help|Exception is):?/.test(text)) break;
        if (text.trim()) wrong.push({ line: base + j, text });
      }
      if (!wrong.length) continue;
      // Compiler errors say more than Gradle's summary; lead with the first few.
      const compiler: Highlight[] = [];
      for (let j = 0; j < i && compiler.length < Math.max(0, max - wrong.length); j++) {
        if (COMPILER_ERROR_RE.test(lines[j])) compiler.push({ line: base + j, text: lines[j] });
      }
      return compiler.concat(wrong).slice(0, max);
    }
  }
  const out: Highlight[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const text = lines[i];
    if (/^(?:\S.*)?(Exception|Error)(?::|$)/.test(text) && !/^\s+at /.test(text) && classifyLine(text) === "error") {
      out.push({ line: base + i, text });
      for (let j = i + 1; j < lines.length && out.length < max; j++) {
        if (/^Caused by:/.test(lines[j])) out.push({ line: base + j, text: lines[j] });
        else if (!/^\s+(at |\.\.\. \d+ more)/.test(lines[j])) break;
      }
      return out;
    }
  }
  const errors: Highlight[] = [];
  for (let i = lines.length - 1; i >= 0 && errors.length < max; i--) {
    if (classifyLine(lines[i]) === "error" && !/^\s+at /.test(lines[i])) errors.push({ line: base + i, text: lines[i] });
  }
  return errors.reverse();
}
