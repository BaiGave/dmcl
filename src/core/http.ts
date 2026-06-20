import fs from "node:fs";
import path from "node:path";

export const UA = "DMCL/0.1 (https://github.com/BaiGave/dmcl)";

interface FetchOpts {
  retries?: number;
  timeoutMs?: number;
}

async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { retries = 2, timeoutMs = 15_000 } = opts;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`请求失败：${url}（${reason}）`);
}

export async function fetchJson<T>(url: string, opts?: FetchOpts): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts?: FetchOpts): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export type UrlProbe = "ok" | "missing" | "unreachable";

export async function probeUrl(url: string, opts?: FetchOpts): Promise<UrlProbe> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const retries = opts?.retries ?? 1;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const head = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "user-agent": UA },
        signal,
      });
      if (head.ok) return "ok";
      if (head.status === 404 || head.status === 410) return "missing";
    } catch {
      // HEAD 可能被 CDN 拒绝，继续 Range GET
    }
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": UA, range: "bytes=0-0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      if (res.ok) return "ok";
      if (res.status === 404 || res.status === 410) return "missing";
    } catch {
      // retry
    }
  }
  return "unreachable";
}

export async function urlExists(url: string, opts?: FetchOpts): Promise<boolean> {
  return (await probeUrl(url, opts)) === "ok";
}

export async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buf);
}
