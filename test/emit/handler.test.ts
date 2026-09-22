import { describe, expect, it } from "vitest";

import { EmitRequestSchema, MAX_EMIT_COUNT, type EmitDeps } from "../../src/emit/handler";
import { MAX_BURST, MAX_INTERVAL_MS } from "../../src/emit/pacing";
import { listScenarios } from "../../src/fixtures/registry";
import { routeRequest, type Env } from "../../src/index";
import { PacketSchema } from "../../src/packet/schema";

const ORIGIN = "https://who.github.io";
const OTHER_ORIGIN = "https://evil.example";
const JUDGE_URL = "https://judge.example/ingest/v1";
const TOKEN = "super-secret-ingest-token";

const ENV: Env = { JUDGE_FIREHOSE_URL: JUDGE_URL, JUDGE_INGEST_TOKEN: TOKEN };

/** Loosely typed JSON body so assertions can reach into any field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function readBody(response: Response): Promise<Loose> {
  return response.json() as Promise<Loose>;
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Scripted Judge: answers each POST with the next status, then 202 forever. */
function judgeStub(statuses: number[] = []): { deps: EmitDeps; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...statuses];
  const deps: EmitDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: queue.shift() ?? 202 });
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

function request(path: string, init: RequestInit = {}, origin: string | null = ORIGIN): Request {
  const headers = new Headers(init.headers);
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return new Request(`https://firehose.test${path}`, { ...init, headers });
}

function emit(body: unknown, origin: string | null = ORIGIN): Request {
  return request(
    "/emit",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    origin,
  );
}

describe("EmitRequestSchema", () => {
  it("defaults count to one and dryRun to false", () => {
    expect(EmitRequestSchema.parse({ scenario: "healthy" })).toEqual({
      scenario: "healthy",
      count: 1,
      dryRun: false,
    });
  });

  it("bounds count to the emit ceiling", () => {
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", count: 0 }).success).toBe(false);
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", count: MAX_EMIT_COUNT }).success).toBe(true);
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", count: MAX_EMIT_COUNT + 1 }).success).toBe(false);
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", count: 1.5 }).success).toBe(false);
  });

  it("leaves the pacing fields absent unless supplied and bounds them", () => {
    expect(EmitRequestSchema.parse({ scenario: "healthy" })).not.toHaveProperty("intervalMs");
    expect(EmitRequestSchema.parse({ scenario: "healthy" })).not.toHaveProperty("burst");
    expect(EmitRequestSchema.parse({ scenario: "healthy", intervalMs: 250, burst: 3 })).toMatchObject({
      intervalMs: 250,
      burst: 3,
    });
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", intervalMs: -1 }).success).toBe(false);
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", intervalMs: MAX_INTERVAL_MS + 1 }).success).toBe(false);
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", burst: 0 }).success).toBe(false);
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", burst: MAX_BURST + 1 }).success).toBe(false);
    expect(EmitRequestSchema.safeParse({ scenario: "healthy", burst: 2.5 }).success).toBe(false);
  });
});

describe("POST /emit", () => {
  it("forwards packets and returns a summary whose accepted count matches", async () => {
    const { deps, calls } = judgeStub();

    const response = await routeRequest(emit({ scenario: "healthy", count: 3, seed: "ac-1" }), ENV, deps);

    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body).toMatchObject({
      ok: true,
      scenario: "healthy",
      requested: 3,
      generated: 3,
      accepted: 3,
      dryRun: false,
      truncated: false,
    });
    expect(body.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(body.results).toHaveLength(3);
    expect(body.results.every((result: { accepted: boolean }) => result.accepted)).toBe(true);

    expect(calls).toHaveLength(3);
    const postedIds = calls.map((call) => {
      expect(call.url).toBe(JUDGE_URL);
      expect(call.init.method).toBe("POST");
      return PacketSchema.parse(JSON.parse(String(call.init.body))).packet_id;
    });
    expect(postedIds).toEqual(body.packetIds);
    expect(new Set(postedIds).size).toBe(3);
  });

  it("forwards packets with the default count of one", async () => {
    const { deps, calls } = judgeStub();

    const response = await routeRequest(emit({ scenario: "healthy" }), ENV, deps);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ requested: 1, accepted: 1 });
    expect(calls).toHaveLength(1);
  });

  it("forwards packets in bursts spaced by the requested interval", async () => {
    const { deps, calls } = judgeStub();
    const sleeps: number[] = [];
    let clock = 0;
    const paced: EmitDeps = {
      ...deps,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    };

    const response = await routeRequest(
      emit({ scenario: "healthy", count: 5, burst: 2, intervalMs: 300 }),
      ENV,
      paced,
    );

    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body).toMatchObject({ ok: true, requested: 5, generated: 5, accepted: 5, truncated: false });
    expect(body.elapsedMs).toBe(600);
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([300, 300]);
  });

  it("forwards packets until the ceiling and reports the run as truncated", async () => {
    const { deps, calls } = judgeStub();
    let clock = 0;
    const paced: EmitDeps = {
      ...deps,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };

    const response = await routeRequest(
      emit({ scenario: "healthy", count: 30, burst: 1, intervalMs: 2000 }),
      ENV,
      paced,
    );

    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body).toMatchObject({ ok: true, requested: 30, generated: 30, accepted: 11, truncated: true });
    expect(body.elapsedMs).toBe(20000);
    expect(body.packetIds).toHaveLength(30);
    expect(body.results).toHaveLength(11);
    expect(calls).toHaveLength(11);
  });

  it("forwards packets and still answers 200 when the Judge rejects one", async () => {
    const { deps, calls } = judgeStub([202, 400, 202]);

    const response = await routeRequest(emit({ scenario: "post_deploy_burn", count: 3 }), ENV, deps);

    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body).toMatchObject({ ok: true, requested: 3, generated: 3, accepted: 2 });
    expect(body.results[1]).toMatchObject({ accepted: false, status: 400 });
    expect(calls).toHaveLength(3);
  });

  it("forwards packets without echoing the ingest token or URL", async () => {
    const { deps } = judgeStub();

    const response = await routeRequest(emit({ scenario: "healthy", count: 2 }), ENV, deps);

    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("judge.example");
  });

  it("dry run generates and validates packets but issues no outbound request", async () => {
    const { deps, calls } = judgeStub();

    const response = await routeRequest(
      emit({ scenario: "post_deploy_burn", count: 2, dryRun: true }),
      ENV,
      deps,
    );

    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body).toMatchObject({
      ok: true,
      scenario: "post_deploy_burn",
      requested: 2,
      generated: 2,
      accepted: 0,
      dryRun: true,
      results: [],
      truncated: false,
      elapsedMs: 0,
    });
    expect(body.packetIds).toHaveLength(2);
    expect(calls).toHaveLength(0);
  });

  it("rejects bad request: a body that is not valid JSON", async () => {
    const { deps, calls } = judgeStub();

    const response = await routeRequest(
      request("/emit", { method: "POST", body: "{not json" }),
      ENV,
      deps,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "invalid_json" });
    expect(calls).toHaveLength(0);
  });

  it("rejects bad request: a count above the ceiling names the field", async () => {
    const { deps, calls } = judgeStub();

    const response = await routeRequest(
      emit({ scenario: "healthy", count: MAX_EMIT_COUNT + 1 }),
      ENV,
      deps,
    );

    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body).toMatchObject({ ok: false, error: "invalid_request" });
    expect(body.issues).toEqual([expect.objectContaining({ field: "count" })]);
    expect(calls).toHaveLength(0);
  });

  it("rejects bad request: a count of zero names the field", async () => {
    const { deps } = judgeStub();

    const response = await routeRequest(emit({ scenario: "healthy", count: 0 }), ENV, deps);

    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body.issues).toEqual([expect.objectContaining({ field: "count" })]);
  });

  it("rejects bad request: a missing scenario names the field", async () => {
    const { deps } = judgeStub();

    const response = await routeRequest(emit({ count: 1 }), ENV, deps);

    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body.issues).toEqual([expect.objectContaining({ field: "scenario" })]);
  });

  it("rejects bad request: a body that is not an object", async () => {
    const { deps } = judgeStub();

    const response = await routeRequest(emit([]), ENV, deps);

    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body).toMatchObject({ ok: false, error: "invalid_request" });
    expect(body.issues).toEqual([expect.objectContaining({ field: "(root)" })]);
  });

  it("rejects bad request: an unknown scenario is a 400 naming the field", async () => {
    const { deps, calls } = judgeStub();

    const response = await routeRequest(emit({ scenario: "nope", count: 1 }), ENV, deps);

    expect(response.status).toBe(400);
    const body = await readBody(response);
    expect(body).toMatchObject({ ok: false, error: "unknown_scenario", field: "scenario" });
    expect(body.message).toContain("nope");
    expect(body.known).toEqual(expect.arrayContaining(["healthy", "post_deploy_burn"]));
    expect(calls).toHaveLength(0);
  });

  it("answers 503 when the ingest URL is not configured", async () => {
    const { deps, calls } = judgeStub();

    const response = await routeRequest(emit({ scenario: "healthy" }), {}, deps);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "judge_not_configured",
      variable: "JUDGE_FIREHOSE_URL",
    });
    expect(calls).toHaveLength(0);
  });

  it("answers 503 without echoing a malformed ingest URL", async () => {
    const { deps } = judgeStub();

    const response = await routeRequest(
      emit({ scenario: "healthy" }),
      { JUDGE_FIREHOSE_URL: "ftp://not-allowed.example" },
      deps,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("not-allowed.example");
  });

  it("answers 500 naming the field but not the packet when generation fails validation", async () => {
    const { deps, calls } = judgeStub();
    const faulty: EmitDeps = {
      ...deps,
      buildPackets: () => [{ packet_id: "pkt_broken_1758500000000_abc123", service: "" } as never],
    };

    const response = await routeRequest(emit({ scenario: "healthy" }), ENV, faulty);

    expect(response.status).toBe(500);
    const text = await response.text();
    const body = JSON.parse(text) as Loose;
    expect(body).toMatchObject({ ok: false, error: "packet_validation_failed" });
    expect(body.message).toContain("service");
    expect(text).not.toContain("pkt_broken");
    expect(calls).toHaveLength(0);
  });

  it("answers 405 for a non-POST method", async () => {
    const response = await routeRequest(request("/emit", { method: "GET" }), ENV);

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: "method_not_allowed" });
  });
});

describe("GET /scenarios", () => {
  it("scenario listing returns the registered scenarios with descriptions", async () => {
    const response = await routeRequest(request("/scenarios"), ENV);

    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body).toEqual({ scenarios: listScenarios() });
    expect(body.scenarios.map((entry: { id: string }) => entry.id)).toEqual(
      expect.arrayContaining(["healthy", "post_deploy_burn"]),
    );
    for (const entry of body.scenarios) {
      expect(entry.id).not.toBe("");
      expect(entry.description).not.toBe("");
    }
  });

  it("scenario listing works without any Judge configuration", async () => {
    const response = await routeRequest(request("/scenarios"), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ scenarios: expect.any(Array) });
  });

  it("answers 405 for a POST", async () => {
    const response = await routeRequest(request("/scenarios", { method: "POST" }), ENV);

    expect(response.status).toBe(405);
  });
});

describe("CORS", () => {
  it("preflight from an allowlisted origin answers 204 with the allow-origin header", async () => {
    const response = await routeRequest(request("/emit", { method: "OPTIONS" }), ENV);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("preflight from a non-allowlisted origin carries no allow-origin header", async () => {
    const response = await routeRequest(
      request("/emit", { method: "OPTIONS" }, OTHER_ORIGIN),
      ENV,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("preflight honours a configured allowlist over the default", async () => {
    const env: Env = { ...ENV, DEMO_ORIGIN_ALLOWLIST: "http://localhost:5173, https://demo.example" };

    const allowed = await routeRequest(
      request("/scenarios", { method: "OPTIONS" }, "http://localhost:5173"),
      env,
    );
    const denied = await routeRequest(request("/scenarios", { method: "OPTIONS" }, ORIGIN), env);

    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("preflight never carries the ingest token", async () => {
    const response = await routeRequest(request("/emit", { method: "OPTIONS" }), ENV);

    for (const [, value] of response.headers) {
      expect(value).not.toContain(TOKEN);
    }
  });

  it("serves a request with no Origin header without CORS headers", async () => {
    const response = await routeRequest(request("/scenarios", {}, null), ENV);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("applies allow headers to successful and error responses alike", async () => {
    const { deps } = judgeStub();

    const ok = await routeRequest(request("/scenarios"), ENV);
    const bad = await routeRequest(emit({ scenario: "nope" }), ENV, deps);
    const unconfigured = await routeRequest(emit({ scenario: "healthy" }), {}, deps);

    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("leaves a disallowed origin's response without allow headers", async () => {
    const response = await routeRequest(request("/scenarios", {}, OTHER_ORIGIN), ENV);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
