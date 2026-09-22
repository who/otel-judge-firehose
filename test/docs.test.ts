/// <reference types="vite/client" />

/**
 * Drift guard between `docs/PACKET_CONTRACT.md` and `PacketSchema`.
 *
 * The document is hand-written for a human reader, so nothing generates it.
 * These tests make a schema change that is not mirrored in the document fail
 * loudly, and keep the public document free of real Worker hosts and tokens.
 */

import { describe, expect, it } from "vitest";

import contract from "../docs/PACKET_CONTRACT.md?raw";
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
function documents(field: string): boolean {
  return contract.includes(`\`${field}\``);
}

function missing(fields: readonly string[]): string[] {
  return fields.filter((field) => !documents(field));
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
    expect(contract).toContain(`\`PACKET_SCHEMA_VERSION\` is \`"${PACKET_SCHEMA_VERSION}"\``);
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
