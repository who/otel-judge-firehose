import { describe, expect, it } from "vitest";

import worker, { SERVICE_NAME, type Env } from "../src/index";

const env: Env = {};
const ctx = {} as ExecutionContext;

function call(path: string, init?: RequestInit): Response | Promise<Response> {
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
    });
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
