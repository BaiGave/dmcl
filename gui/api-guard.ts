import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Protects the local HTTP API (127.0.0.1:<port>) from other local processes and from web pages:
 * - every request must name this server as Host (localhost / 127.0.0.1 with our port), which defeats
 *   DNS rebinding;
 * - a request carrying an Origin header must come from the GUI's own origin;
 * - every /api request must carry the per-session token in `X-DMCL-Token`. The token is generated at
 *   start-up and handed to the window only through the preload bridge (window.dmcl.apiToken).
 * Static GUI files (GET outside /api) need no token.
 */

export const API_TOKEN_HEADER = "x-dmcl-token";
const TOKEN_ARG = "--dmcl-api-token=";

export interface ApiGuard {
  readonly token: string;
  /** Command-line argument for the preload script (webPreferences.additionalArguments). */
  preloadArgument(): string;
  /** null when the request may proceed, else the HTTP status and message to send. */
  check(req: IncomingMessage, urlPath: string): { status: number; error: string } | null;
}

export function createApiGuard(port: number, token = randomBytes(32).toString("hex")): ApiGuard {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  const expected = Buffer.from(token, "utf8");

  const tokenMatches = (value: string | string[] | undefined): boolean => {
    if (typeof value !== "string") return false;
    const given = Buffer.from(value, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return {
    token,
    preloadArgument: () => `${TOKEN_ARG}${token}`,
    check(req, urlPath) {
      const host = (req.headers.host ?? "").toLowerCase();
      if (!hosts.has(host)) return { status: 403, error: "Host not allowed" };
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin.toLowerCase())) {
        return { status: 403, error: "Origin not allowed" };
      }
      if (urlPath === "/api" || urlPath.startsWith("/api/")) {
        if (!tokenMatches(req.headers[API_TOKEN_HEADER])) return { status: 401, error: "Missing or invalid X-DMCL-Token" };
      }
      return null;
    },
  };
}

/** Preload side: reads the token passed through additionalArguments. */
export function tokenFromArgv(argv: readonly string[]): string {
  const arg = argv.find((value) => value.startsWith(TOKEN_ARG));
  return arg ? arg.slice(TOKEN_ARG.length) : "";
}
