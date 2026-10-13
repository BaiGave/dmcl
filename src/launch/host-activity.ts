import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The machine-wide host activity registry shared with Linker's tools/host_activity.py:
 * one JSON file per running heavy job in %LOCALAPPDATA%\LinkerHost\activity (LINKER_HOST_ACTIVITY
 * overrides; ~/.cache/linker-host/activity elsewhere), written atomically and removed when the job ends.
 *
 *   {"schema": 1, "pid": 1234, "process_started": <Windows FILETIME of the process creation>,
 *    "kind": "build" | "game" | "instance-test" | ..., "label": "...", "cwd": "...",
 *    "started_at": "2026-10-13T09:30:00", "progress": "..." (optional)}
 *
 * Readers ignore entries whose process exited or whose PID now belongs to another process.
 * Recording never fails the job it describes.
 */

export const HOST_ACTIVITY_SCHEMA = 1;

export interface HostActivityEntry {
  schema: number;
  pid: number;
  process_started: number | null;
  kind: string;
  label: string;
  cwd: string;
  started_at: string;
  progress?: string;
  /** Added by readers: the entry's file. */
  entry?: string;
}

export function hostActivityDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LINKER_HOST_ACTIVITY) return env.LINKER_HOST_ACTIVITY;
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "LinkerHost", "activity");
  return path.join(os.homedir(), ".cache", "linker-host", "activity");
}

function localTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function writeAtomic(file: string, entry: HostActivityEntry): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** Creation time of running processes, as Windows FILETIME (what host_activity.py records). */
export type ProcessStartReader = (pids: number[]) => Promise<Map<number, number | "unknown">>;

/** Windows: one PowerShell call for all PIDs; `.StartTime.ToFileTimeUtc()` equals GetProcessTimes' creation time. */
export const readProcessStarts: ProcessStartReader = (pids) => new Promise((resolve) => {
  const result = new Map<number, number | "unknown">();
  const ids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!ids.length) {
    resolve(result);
    return;
  }
  if (process.platform !== "win32") {
    for (const pid of ids) {
      try {
        process.kill(pid, 0);
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        const started = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
        result.set(pid, Number.isFinite(started) ? started : 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") result.set(pid, "unknown");
      }
    }
    resolve(result);
    return;
  }
  const script = `foreach ($id in @(${ids.join(",")})) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; `
    + "if ($p) { try { \"$id $($p.StartTime.ToFileTimeUtc())\" } catch { \"$id ?\" } } }";
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 15_000,
  }, (_err, stdout) => {
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+) (\d+|\?)$/);
      if (!m) continue;
      result.set(Number(m[1]), m[2] === "?" ? "unknown" : Number(m[2]));
    }
    resolve(result);
  });
});

export interface ActivityRegistration {
  readonly file: string | null;
  update(fields: Partial<Pick<HostActivityEntry, "progress" | "label">>): void;
  unregister(): void;
}

/**
 * Records a running job of process `pid` (for DMCL: the Gradle wrapper process it spawned).
 * The entry is written at once with process_started=null and completed when the creation time is known.
 */
export function registerHostActivity(
  input: { pid: number; kind: "build" | "game" | string; label: string; cwd: string },
  options: { dir?: string; readStarts?: ProcessStartReader } = {},
): ActivityRegistration {
  const dir = options.dir ?? hostActivityDir();
  let entry: HostActivityEntry = {
    schema: HOST_ACTIVITY_SCHEMA,
    pid: input.pid,
    process_started: null,
    kind: input.kind,
    label: input.label.length <= 300 ? input.label : `${input.label.slice(0, 297)}...`,
    cwd: input.cwd,
    started_at: localTimestamp(),
  };
  let file: string | null = null;
  let removed = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${input.pid}-${randomBytes(4).toString("hex")}.json`);
    writeAtomic(file, entry);
  } catch {
    file = null;
  }
  const write = () => {
    if (!file || removed) return;
    try {
      writeAtomic(file, entry);
    } catch { /* recording never fails the job */ }
  };
  if (file) {
    void (options.readStarts ?? readProcessStarts)([input.pid]).then((starts) => {
      const started = starts.get(input.pid);
      if (typeof started === "number") {
        entry = { ...entry, process_started: started };
        write();
      }
    }).catch(() => {});
  }
  return {
    file,
    update(fields) {
      entry = { ...entry, ...fields };
      write();
    },
    unregister() {
      if (removed) return;
      removed = true;
      if (file) fs.rmSync(file, { force: true });
    },
  };
}

/**
 * Live entries, oldest first. Entries of exited processes, or whose PID was reused (creation time
 * differs), are left out. Files are not deleted here; host_activity.py's reader cleans them up.
 */
export async function listHostActivity(
  options: { dir?: string; readStarts?: ProcessStartReader } = {},
): Promise<HostActivityEntry[]> {
  const dir = options.dir ?? hostActivityDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: HostActivityEntry[] = [];
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HostActivityEntry;
      if (!Number.isInteger(parsed.pid)) continue;
      entries.push({ ...parsed, entry: file });
    } catch {
      // Being written, or not ours to judge.
    }
  }
  const starts = await (options.readStarts ?? readProcessStarts)(entries.map((entry) => entry.pid));
  return entries
    .filter((entry) => {
      const started = starts.get(entry.pid);
      if (started === undefined) return false;
      if (started === "unknown" || entry.process_started == null) return true;
      return started === entry.process_started;
    })
    .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
}

/** Entries that are not DMCL's own jobs (by PID of this process's children). */
export function foreignActivity(entries: HostActivityEntry[], ownPids: Iterable<number>): HostActivityEntry[] {
  const own = new Set(ownPids);
  return entries.filter((entry) => !own.has(entry.pid));
}
