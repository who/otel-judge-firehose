/// <reference types="vite/client" />

/**
 * Drift guards for the hand-written documents.
 *
 * `docs/PACKET_CONTRACT.md` must mirror `PacketSchema`, and `README.md` must
 * name every environment variable, every route, and every scenario the code
 * actually exposes. Nothing generates either document, so these tests make a
 * code change that is not mirrored in the prose fail loudly, and keep both
 * public documents free of real Worker hosts and tokens.
 */

import { describe, expect, it } from "vitest";

import readme from "../README.md?raw";
import contract from "../docs/PACKET_CONTRACT.md?raw";
import configSource from "../src/config.ts?raw";
import { EmitRequestSchema } from "../src/emit/handler";
import { listScenarios } from "../src/fixtures/registry";
import {
  PACKET_ENVS,
  PACKET_ID_PATTERN,
  PACKET_SCHEMA_VERSION,
  PacketSchema,
  RecentDeploySchema,
  SignalsSchema,
  TopSpanSchema,
} from "../src/packet/schema";

/**
 * A field counts as documented only when it appears as a whole backticked
 * name, so `env` cannot be satisfied by the word "environment" and `count`
 * cannot be satisfied by prose.
 */
function documents(field: string, text: string = contract): boolean {
  return text.includes(`\`${field}\``);
}

function missing(fields: readonly string[], text: string = contract): string[] {
  return fields.filter((field) => !documents(field, text));
}

/**
 * Environment variable names as declared on `FirehoseEnv`, read from the
 * source so a rename in `src/config.ts` reaches the README assertions without
 * anyone remembering to update a list here.
 */
function declaredEnvVariables(): string[] {
  const block = configSource.match(/export interface FirehoseEnv \{([\s\S]*?)\n\}/);
  if (block === null || block[1] === undefined) {
    throw new Error("FirehoseEnv interface not found in src/config.ts");
  }
  return [...block[1].matchAll(/^\s+([A-Z][A-Z0-9_]*)\?: string;/gm)].map((match) => match[1] as string);
}

/** Hostnames a public document may mention: reserved names, localhost, and the demo's Pages origin. */
function isPlaceholderHost(hostname: string): boolean {
  return (
    hostname.endsWith(".invalid") ||
    hostname.endsWith("example.com") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "who.github.io"
  );
}

describe("packet contract document", () => {
  it("names the transport decision", () => {
    expect(contract).toContain("compact normalized packet");
    expect(contract).toContain("application/json");
  });

  it("field coverage: every top-level packet field appears in the document", () => {
    expect(missing(Object.keys(PacketSchema.shape))).toEqual([]);
  });

  it("field coverage: every signal field appears in the document", () => {
    expect(missing(Object.keys(SignalsSchema.shape))).toEqual([]);
  });

  it("field coverage: nested span and deploy fields appear in the document", () => {
    expect(missing(Object.keys(TopSpanSchema.shape))).toEqual([]);
    expect(missing(Object.keys(RecentDeploySchema.shape))).toEqual([]);
  });

  it("field coverage: every environment value appears in the document", () => {
    expect(missing(PACKET_ENVS)).toEqual([]);
  });

  it("records the identifier format with an example the schema accepts", () => {
    expect(contract).toContain("pkt_<scenario>_<epochMillis>_<six base36 characters>");
    const examples = contract.match(/pkt_[a-z0-9_]+_[0-9]+_[a-z0-9]{6}/g) ?? [];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example).toMatch(PACKET_ID_PATTERN);
    }
  });

  it("records the additive versioning rule and the current version", () => {
    expect(contract).toContain(`\`PACKET_SCHEMA_VERSION\` is \`${PACKET_SCHEMA_VERSION}\``);
    expect(contract).toMatch(/additive, optional fields/i);
  });

  it("no secrets: contains no real Worker hostname", () => {
    expect(contract).not.toMatch(/workers\.dev/i);
    const urls = contract.match(/https?:\/\/[^\s)`>]+/g) ?? [];
    for (const url of urls) {
      const { hostname } = new URL(url);
      expect(hostname.endsWith(".invalid") || hostname.endsWith("example.com")).toBe(true);
    }
  });

  it("no secrets: contains no bearer token or token-shaped value", () => {
    expect(contract).not.toMatch(/bearer\s+[A-Za-z0-9._-]{8,}/i);
    expect(contract).not.toMatch(/JUDGE_INGEST_TOKEN\s*[=:]\s*\S/);
    expect(contract).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});

describe("readme", () => {
  it("readme variables: documents every FirehoseEnv variable by name", () => {
    const variables = declaredEnvVariables();
    expect(variables).toHaveLength(4);
    expect(variables).toContain("JUDGE_FIREHOSE_URL");
    expect(missing(variables, readme)).toEqual([]);
  });

  it("readme variables: marks the ingest token as a Worker secret set through wrangler", () => {
    const tokenRow = readme.match(/^\| `JUDGE_INGEST_TOKEN` \|.*$/m)?.[0];
    expect(tokenRow).toBeDefined();
    expect(tokenRow).toMatch(/Worker secret/);
    expect(readme).toContain("wrangler secret put JUDGE_INGEST_TOKEN");
  });

  it("readme routes: documents the three routes with request and response bodies", () => {
    for (const route of ["GET /health", "GET /scenarios", "POST /emit"]) {
      expect(readme).toContain(`### ${route}`);
    }
    for (const field of ["ok", "service", "judgeConfigured", "scenarios"]) {
      expect(documents(field, readme)).toBe(true);
    }
  });

  it("readme routes: documents every accepted emit request field", () => {
    expect(missing(Object.keys(EmitRequestSchema.shape), readme)).toEqual([]);
  });

  it("readme routes: documents every emit summary field", () => {
    const summaryFields = [
      "ok",
      "scenario",
      "requested",
      "generated",
      "accepted",
      "dryRun",
      "packetIds",
      "results",
      "truncated",
      "elapsedMs",
      "fallbackReason",
    ];
    expect(missing(summaryFields, readme)).toEqual([]);
    expect(missing(["packetId", "accepted", "status", "attempts", "error"], readme)).toEqual([]);
  });

  it("readme routes: example JSON bodies parse", () => {
    const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] as string);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });

  it("readme routes: example packet identifiers match the schema pattern", () => {
    const examples = readme.match(/pkt_[a-z0-9_]+_[0-9]+_[a-z0-9]{6}/g) ?? [];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(example).toMatch(PACKET_ID_PATTERN);
    }
  });

  it("readme scenarios: lists every scenario identifier the listing returns", () => {
    const ids = listScenarios().map((scenario) => scenario.id);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(missing(ids, readme)).toEqual([]);
  });

  it("readme scenarios: does not promise a pause endpoint", () => {
    expect(readme).toMatch(/pause is client-driven/i);
    expect(readme).not.toMatch(/\/pause\b/);
  });

  it("readme links the packet contract document", () => {
    expect(readme).toContain("docs/PACKET_CONTRACT.md");
  });

  it("no secrets: readme contains no real Worker hostname", () => {
    expect(readme).not.toMatch(/workers\.dev/i);
    const urls = readme.match(/https?:\/\/[^\s)`>'"]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(isPlaceholderHost(new URL(url).hostname)).toBe(true);
    }
  });

  it("no secrets: readme contains no bearer token or token-shaped value", () => {
    expect(readme).not.toMatch(/bearer\s+[A-Za-z0-9._-]{8,}/i);
    expect(readme).not.toMatch(/JUDGE_INGEST_TOKEN\s*[=:]\s*\S/);
    expect(readme).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});
