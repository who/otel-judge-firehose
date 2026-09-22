/**
 * Packet firehose producer Worker.
 *
 * `routeRequest` serves the health probe, the scenario listing, the emit
 * route, and the CORS preflight for the two demo-facing routes.
 */

import { ConfigError, resolveAllowlist, resolveConfig, type FirehoseEnv } from "./config";
import { handleEmit, type EmitDeps } from "./emit/handler";
import { listScenarios } from "./fixtures/registry";
import { handlePreflight, withCors, type CorsConfig } from "./http/cors";

/** Worker bindings; see `FirehoseEnv` for the individual variables. */
export type Env = FirehoseEnv;

export const SERVICE_NAME = "otel-judge-firehose";

/** Routes the demo calls cross-origin; every response from these carries CORS headers. */
const DEMO_ROUTES: ReadonlySet<string> = new Set(["/scenarios", "/emit"]);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function methodNotAllowed(method: string): Response {
  return jsonResponse({ ok: false, error: "method_not_allowed", method }, 405);
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

/** Serves a demo route after the preflight branch has been handled. */
function routeDemo(request: Request, pathname: string, env: Env, deps: EmitDeps): Promise<Response> {
  if (pathname === "/scenarios") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Promise.resolve(methodNotAllowed(request.method));
    }
    return Promise.resolve(jsonResponse({ scenarios: listScenarios() }, 200));
  }

  if (request.method !== "POST") {
    return Promise.resolve(methodNotAllowed(request.method));
  }
  return handleEmit(request, env, deps);
}

export async function routeRequest(request: Request, env: Env, deps: EmitDeps = {}): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(request.method);
    }
    return jsonResponse(
      { ok: true, service: SERVICE_NAME, judgeConfigured: isJudgeConfigured(env) },
      200,
    );
  }

  if (DEMO_ROUTES.has(pathname)) {
    const cors: CorsConfig = { demoOriginAllowlist: resolveAllowlist(env.DEMO_ORIGIN_ALLOWLIST) };
    if (request.method === "OPTIONS") {
      return handlePreflight(request, cors);
    }
    const response = await routeDemo(request, pathname, env, deps);
    return withCors(response, request.headers.get("origin"), cors);
  }

  return jsonResponse({ ok: false, error: "not_found", path: pathname }, 404);
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
