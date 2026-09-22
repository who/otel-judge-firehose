/**
 * Demo-origin CORS for the emit API.
 *
 * Only an origin in the configured allowlist receives allow headers. A
 * disallowed or absent `Origin` gets the response untouched: the browser
 * enforces the failure on its side, and a non-browser caller such as curl
 * keeps working. No Judge secret is ever placed in a CORS header.
 */

import type { FirehoseConfig } from "../config";

/** The slice of the producer configuration CORS needs. */
export type CorsConfig = Pick<FirehoseConfig, "demoOriginAllowlist">;

/** Methods the demo may use against the emit API. */
export const ALLOWED_METHODS = "GET, POST, OPTIONS";

/** Request headers the demo may send; the emit body is JSON. */
export const ALLOWED_HEADERS = "content-type";

/** Seconds a browser may cache a preflight answer. */
export const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** True when `origin` is listed, or the allowlist is the development wildcard `*`. */
export function isAllowedOrigin(origin: string, allowlist: readonly string[]): boolean {
  return allowlist.includes("*") || allowlist.includes(origin);
}

/**
 * Allow headers for `origin`, or an empty record when the origin is absent or
 * not allowlisted. The origin is reflected rather than `*` so the same
 * headers work whether or not the browser sends credentials.
 */
export function corsHeaders(origin: string | null, config: CorsConfig): Record<string, string> {
  if (origin === null || !isAllowedOrigin(origin, config.demoOriginAllowlist)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
    vary: "Origin",
  };
}

/** Answers an OPTIONS preflight with HTTP 204 and the allow headers for the request origin. */
export function handlePreflight(request: Request, config: CorsConfig): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin"), config),
  });
}

/** Returns `response` carrying the allow headers for `origin`; unchanged when there are none. */
export function withCors(response: Response, origin: string | null, config: CorsConfig): Response {
  const headers = corsHeaders(origin, config);
  if (Object.keys(headers).length === 0) {
    return response;
  }
  const decorated = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    decorated.headers.set(name, value);
  }
  return decorated;
}
