/**
 * Packet firehose producer Worker.
 *
 * The MVP exposes a single health probe; later tasks register their routes in
 * `routeRequest` alongside it.
 */

export interface Env {
  /** Judge firehose ingest URL, wired up by a later task. */
  JUDGE_FIREHOSE_URL?: string;
}

export const SERVICE_NAME = "otel-judge-firehose";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function routeRequest(request: Request, _env: Env): Response {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse(
        { ok: false, error: "method_not_allowed", method: request.method },
        405,
      );
    }
    return jsonResponse({ ok: true, service: SERVICE_NAME }, 200);
  }

  return jsonResponse({ ok: false, error: "not_found", path: pathname }, 404);
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Response {
    return routeRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
