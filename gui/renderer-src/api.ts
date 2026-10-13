/**
 * The only way the renderer talks to the local DMCL API.
 * Every request goes through {@link apiFetch}, which attaches the per-launch token.
 */

export const TOKEN_HEADER = "X-DMCL-Token";

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

/** HTTP failure with the status kept, so callers can feature-detect endpoints (404). */
export class ApiError extends Error {
  readonly status: number;
  /** False when the body was not JSON — e.g. the static-file 404 for an unknown endpoint. */
  readonly jsonBody: boolean;
  constructor(status: number, message: string, jsonBody = true) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.jsonBody = jsonBody;
  }
}

/** The endpoint itself does not exist (as opposed to a JSON "not found" for one resource). */
export function isMissingEndpoint(err: unknown): boolean {
  return err instanceof ApiError && !err.jsonBody && (err.status === 404 || err.status === 405 || err.status === 501);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501);
}

/** The token from the preload (`window.dmcl.apiToken`), or null when there is none. */
export function apiToken(): string | null {
  const host = (globalThis as { window?: { dmcl?: { apiToken?: unknown } } }).window;
  const token = host?.dmcl?.apiToken;
  return typeof token === "string" && token ? token : null;
}

/** Copy of `init` with the token header added (headers of the caller are kept). */
export function withToken(init: RequestInit = {}): RequestInit {
  const token = apiToken();
  if (!token) return init;
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, token);
  return { ...init, headers };
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, withToken(init));
}

/** Streaming / long requests: retry network failures (default 3 times). */
export async function fetchWithRetry(path: string, opts: FetchRetryOptions = {}): Promise<Response> {
  const { retries = 3, retryDelayMs = 800, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await apiFetch(path, init);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(msg || "fetch failed");
}

/** JSON request. Resolves with the parsed body; rejects with {@link ApiError} on HTTP errors. */
export function api(path: string, opts: ApiOptions = {}): Promise<any> {
  const hasBody = opts.body !== undefined && opts.body !== null;
  return apiFetch(path, {
    method: opts.method || "GET",
    headers: hasBody ? { "Content-Type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  }).then(async (r) => {
    if (opts.expectText) {
      if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
      return r;
    }
    const text = await r.text();
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`, false);
      throw new Error("响应不是有效的 JSON");
    }
    if (!r.ok) throw new ApiError(r.status, (data && data.error) || `HTTP ${r.status}`);
    return data;
  });
}
