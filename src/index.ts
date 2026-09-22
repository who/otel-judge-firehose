/**
 * Packet firehose producer Worker.
 *
 * The MVP exposes a single health probe; later tasks register their routes in
 * `routeRequest` alongside it.
 */

import { ConfigError, resolveConfig, type FirehoseEnv } from "./config";

/** Worker bindings; see `FirehoseEnv` for the individual variables. */
export type Env = FirehoseEnv;

export const SERVICE_NAME = "otel-judge-firehose";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * True only when `resolveConfig` accepts the environment. A `ConfigError` is
 * the expected "not configured" signal; anything else is a real bug and is
 * rethrown so it surfaces instead of being reported as "not configured".
 */
function isJudgeConfigured(env: Env): boolean {
  try {
    resolveConfig(env);
    return true;
  } catch (error) {
    if (error instanceof ConfigError) {
      return false;
    }
    throw error;
  }
}

export function routeRequest(request: Request, env: Env): Response {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(
        { ok: false, error: "method_not_allowed", method: request.method },
        405,
      );
    }
    return jsonResponse(
      { ok: true, service: SERVICE_NAME, judgeConfigured: isJudgeConfigured(env) },
      200,
    );
  }

  return jsonResponse({ ok: false, error: "not_found", path: pathname }, 404);
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Response {
    return routeRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
