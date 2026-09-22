import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_DEMO_ORIGIN_ALLOWLIST,
  resolveConfig,
  type FirehoseEnv,
} from "../src/config";

describe("resolveConfig", () => {
  it("resolves a valid environment into a normalized config", () => {
    const env: FirehoseEnv = {
      JUDGE_FIREHOSE_URL: "https://judge.example.workers.dev/",
      JUDGE_INGEST_TOKEN: "secret-token",
      DEMO_ORIGIN_ALLOWLIST: "https://who.github.io, http://localhost:5173 ,,",
    };

    expect(resolveConfig(env)).toEqual({
      judgeFirehoseUrl: "https://judge.example.workers.dev",
      judgeIngestToken: "secret-token",
      demoOriginAllowlist: ["https://who.github.io", "http://localhost:5173"],
    });
  });

  it("resolves a URL with a path by stripping only the trailing slash", () => {
    const config = resolveConfig({ JUDGE_FIREHOSE_URL: "https://judge.example/ingest/v1/" });

    expect(config.judgeFirehoseUrl).toBe("https://judge.example/ingest/v1");
  });

  it("resolves the default allowlist when the variable is absent or blank", () => {
    expect(resolveConfig({ JUDGE_FIREHOSE_URL: "https://judge.example" }).demoOriginAllowlist).toEqual(
      DEFAULT_DEMO_ORIGIN_ALLOWLIST,
    );
    expect(
      resolveConfig({ JUDGE_FIREHOSE_URL: "https://judge.example", DEMO_ORIGIN_ALLOWLIST: "  " })
        .demoOriginAllowlist,
    ).toEqual(DEFAULT_DEMO_ORIGIN_ALLOWLIST);
  });

  it("resolves a wildcard allowlist entry as-is", () => {
    const config = resolveConfig({
      JUDGE_FIREHOSE_URL: "https://judge.example",
      DEMO_ORIGIN_ALLOWLIST: "*",
    });

    expect(config.demoOriginAllowlist).toEqual(["*"]);
  });

  it("resolves without a token field when the token is absent or blank", () => {
    expect(resolveConfig({ JUDGE_FIREHOSE_URL: "https://judge.example" })).not.toHaveProperty(
      "judgeIngestToken",
    );
    expect(
      resolveConfig({ JUDGE_FIREHOSE_URL: "https://judge.example", JUDGE_INGEST_TOKEN: "   " }),
    ).not.toHaveProperty("judgeIngestToken");
  });

  it("resolves a plain http URL for localhost only", () => {
    expect(resolveConfig({ JUDGE_FIREHOSE_URL: "http://localhost:8787/" }).judgeFirehoseUrl).toBe(
      "http://localhost:8787",
    );
    expect(resolveConfig({ JUDGE_FIREHOSE_URL: "http://127.0.0.1:8787" }).judgeFirehoseUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("rejects a missing ingest URL with an error naming the variable", () => {
    for (const env of [{}, { JUDGE_FIREHOSE_URL: "" }, { JUDGE_FIREHOSE_URL: "   " }]) {
      expect(() => resolveConfig(env)).toThrow(ConfigError);
      expect(() => resolveConfig(env)).toThrow(/JUDGE_FIREHOSE_URL/);
    }
  });

  it("rejects a malformed ingest URL with an error naming the variable", () => {
    expect(() => resolveConfig({ JUDGE_FIREHOSE_URL: "not a url" })).toThrow(ConfigError);
    expect(() => resolveConfig({ JUDGE_FIREHOSE_URL: "judge.example/ingest" })).toThrow(
      /JUDGE_FIREHOSE_URL/,
    );
  });

  it("resolves without a firehoseSecret field when the secret is absent or blank", () => {
    expect(resolveConfig({ JUDGE_FIREHOSE_URL: "https://judge.example" })).not.toHaveProperty(
      "firehoseSecret",
    );
    expect(
      resolveConfig({ JUDGE_FIREHOSE_URL: "https://judge.example", FIREHOSE_SECRET: "   " }),
    ).not.toHaveProperty("firehoseSecret");
  });

  it("resolves firehoseSecret when set", () => {
    expect(
      resolveConfig({
        JUDGE_FIREHOSE_URL: "https://judge.example",
        FIREHOSE_SECRET: "local-dev-otel-judge-firehose",
      }).firehoseSecret,
    ).toBe("local-dev-otel-judge-firehose");
  });

  it("rejects a plain http ingest URL on a non-local host", () => {
    let caught: unknown;
    try {
      resolveConfig({ JUDGE_FIREHOSE_URL: "http://judge.example" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).variable).toBe("JUDGE_FIREHOSE_URL");
    expect((caught as ConfigError).message).toMatch(/https/);
  });
});
