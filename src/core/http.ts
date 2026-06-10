import fs from "node:fs";
import path from "node:path";

const UA = "mcdev-wizard (https://github.com/mcdev-wizard)";

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

export async function urlExists(url: string): Promise<boolean> {
  // 注意：codeload.github.com 等服务对 HEAD 一律返回 404，必须用 GET 验证
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow", headers: { "user-agent": UA } });
    if (head.ok) return true;
  } catch {
    // 忽略，继续用 GET 判断
  }
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, range: "bytes=0-0" },
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
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
