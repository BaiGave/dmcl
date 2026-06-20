export interface ApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  expectText?: boolean;
}

export interface FetchRetryOptions extends RequestInit {
  retries?: number;
  retryDelayMs?: number;
}

/** 流式/长连接请求：网络抖动时自动重试（默认 3 次） */
export async function fetchWithRetry(
  path: string,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  var retries = opts.retries ?? 3;
  var delayMs = opts.retryDelayMs ?? 800;
  var lastErr: unknown;
  for (var attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(path, opts);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await new Promise(function (r) { setTimeout(r, delayMs * (attempt + 1)); });
    }
  }
  var msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(msg || "fetch failed");
}

export function api(path: string, opts: ApiOptions = {}): Promise<unknown> {
  return fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  }).then((r) => {
    if (opts.expectText) {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    }
    return r.json().then((data: { error?: string }) => {
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
      return data;
    });
  });
}
