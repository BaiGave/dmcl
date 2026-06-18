export interface ApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  expectText?: boolean;
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
