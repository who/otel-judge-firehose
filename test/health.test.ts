import { describe, expect, it } from "vitest";

import worker, { type Env } from "../src/index";
import { SERVICE_NAME } from "../src/serviceName";

const ctx = {} as ExecutionContext;

function call(path: string, init?: RequestInit, env: Env = {}): Response | Promise<Response> {
  return worker.fetch(new Request(`https://firehose.test${path}`, init), env, ctx);
}

describe("GET /health", () => {
  it("answers 200 with the service identity", async () => {
    const response = await call("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: SERVICE_NAME,
      judgeConfigured: false,
    });
  });

  it("reports judgeConfigured false when the ingest URL is absent", async () => {
    const response = await call("/health", undefined, {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, judgeConfigured: false });
  });

  it("reports judgeConfigured false when the ingest URL is malformed", async () => {
    const response = await call("/health", undefined, { JUDGE_FIREHOSE_URL: "not a url" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, judgeConfigured: false });
  });

  it("reports judgeConfigured true when the ingest URL is present", async () => {
    const response = await call("/health", undefined, {
      JUDGE_FIREHOSE_URL: "https://judge.example.workers.dev",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, judgeConfigured: true });
  });

  it("never echoes the ingest token or URL in the judgeConfigured body", async () => {
    const response = await call("/health", undefined, {
      JUDGE_FIREHOSE_URL: "https://judge.example.workers.dev",
      JUDGE_INGEST_TOKEN: "super-secret-token",
    });

    const body = await response.text();
    expect(body).not.toContain("super-secret-token");
    expect(body).not.toContain("judge.example.workers.dev");
  });

  it("answers 405 for an unexpected method", async () => {
    const response = await call("/health", { method: "POST" });

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "method_not_allowed",
    });
  });
});

describe("routing", () => {
  it("answers 404 with a JSON error body for an unknown path", async () => {
    const response = await call("/nope");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "not_found",
      path: "/nope",
    });
  });
});
