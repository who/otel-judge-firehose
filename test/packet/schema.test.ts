import { describe, expect, it } from "vitest";

import {
  PACKET_ENVS,
  PACKET_ID_PATTERN,
  PACKET_SCHEMA_VERSION,
  PacketSchema,
  RecentDeploySchema,
  SignalsSchema,
  TopSpanSchema,
  type Packet,
  type PacketInput,
} from "../../src/packet/schema";

function validPacket(): PacketInput {
  return {
    packet_id: "pkt_post_deploy_burn_1758480000000_k3f9zq",
    service: "checkout-api",
    env: "prod",
    window: {
      start: "2026-09-21T12:00:00Z",
      end: "2026-09-21T12:05:00Z",
    },
    signals: {
      error_rate: 0.12,
      error_rate_baseline: 0.004,
      p95_latency_ms: 1850,
      p95_latency_baseline_ms: 420,
      slo_burn_rate: 14.2,
      request_rate: 312.5,
    },
    top_spans: [
      { name: "POST /checkout", count: 9_400, p95_ms: 1_900 },
      { name: "db.query orders", count: 9_100, p95_ms: 1_200 },
    ],
    exemplar_trace_ids: ["4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7a3ce929d0e0e4736"],
    recent_deploy: {
      sha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
      version: "2026.09.21-3",
      deployed_at: "2026-09-21T11:58:30Z",
    },
    alert_labels: ["slo:checkout-availability", "severity:page"],
    log_snippets: ["ERROR orders-db: connection pool exhausted (max=50)"],
  };
}

/** Flattened `a.b.c` paths of every issue, for readable assertions. */
function issuePaths(input: unknown): string[] {
  const result = PacketSchema.safeParse(input);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.path.map(String).join("."));
}

describe("PacketSchema", () => {
  it("parses a fully populated valid packet into the typed value", () => {
    const input = validPacket();

    const packet: Packet = PacketSchema.parse(input);

    expect(packet).toEqual(input);
    expect(packet.env).toBe("prod");
    expect(packet.recent_deploy?.sha).toBe("9fceb02d0ae598e95dc970b74767f19372d61af8");
  });

  it("parses a valid packet without the optional log snippets", () => {
    const { log_snippets: _omitted, ...input } = validPacket();

    const packet = PacketSchema.parse(input);

    expect(packet).not.toHaveProperty("log_snippets");
  });

  it("parses a valid packet with an empty top_spans array", () => {
    const packet = PacketSchema.parse({ ...validPacket(), top_spans: [] });

    expect(packet.top_spans).toEqual([]);
  });

  it("parses a valid packet with recent_deploy set to null", () => {
    const packet = PacketSchema.parse({ ...validPacket(), recent_deploy: null });

    expect(packet.recent_deploy).toBeNull();
  });

  it("strips unknown extra keys instead of rejecting the packet", () => {
    const input = { ...validPacket(), judge_only_field: "ignored" };

    const packet = PacketSchema.parse(input);

    expect(packet).not.toHaveProperty("judge_only_field");
    expect(packet).toEqual(validPacket());
  });

  it("rejects a packet with a missing signal, naming the field path", () => {
    const input = validPacket();
    const { slo_burn_rate: _omitted, ...signals } = input.signals;

    const result = PacketSchema.safeParse({ ...input, signals });

    expect(result.success).toBe(false);
    expect(issuePaths({ ...input, signals })).toEqual(["signals.slo_burn_rate"]);
  });

  it("rejects a packet with an out-of-range error rate", () => {
    const input = validPacket();

    expect(issuePaths({ ...input, signals: { ...input.signals, error_rate: 1.5 } })).toEqual([
      "signals.error_rate",
    ]);
    expect(issuePaths({ ...input, signals: { ...input.signals, error_rate: -0.1 } })).toEqual([
      "signals.error_rate",
    ]);
  });

  it("rejects a negative latency or request rate", () => {
    const input = validPacket();

    expect(issuePaths({ ...input, signals: { ...input.signals, p95_latency_ms: -1 } })).toEqual([
      "signals.p95_latency_ms",
    ]);
    expect(issuePaths({ ...input, signals: { ...input.signals, request_rate: -5 } })).toEqual([
      "signals.request_rate",
    ]);
  });

  it("rejects an inverted window whose end precedes its start", () => {
    const input = validPacket();
    const inverted = {
      ...input,
      window: { start: "2026-09-21T12:05:00Z", end: "2026-09-21T12:00:00Z" },
    };

    const result = PacketSchema.safeParse(inverted);

    expect(result.success).toBe(false);
    expect(issuePaths(inverted)).toEqual(["window.end"]);
  });

  it("rejects an inverted window when end equals start", () => {
    const input = validPacket();

    expect(
      issuePaths({
        ...input,
        window: { start: "2026-09-21T12:00:00Z", end: "2026-09-21T12:00:00Z" },
      }),
    ).toEqual(["window.end"]);
  });

  it("rejects timestamps that are not ISO 8601 UTC", () => {
    const input = validPacket();

    expect(
      issuePaths({ ...input, window: { ...input.window, start: "2026-09-21 12:00:00" } }),
    ).toEqual(["window.start"]);
    expect(
      issuePaths({ ...input, window: { ...input.window, start: "2026-09-21T12:00:00+02:00" } }),
    ).toEqual(["window.start"]);
  });

  it("rejects a packet where recent_deploy is absent rather than null", () => {
    const { recent_deploy: _omitted, ...input } = validPacket();

    expect(issuePaths(input)).toEqual(["recent_deploy"]);
  });

  it("rejects an env outside the closed enum", () => {
    expect(issuePaths({ ...validPacket(), env: "production" })).toEqual(["env"]);
    expect([...PACKET_ENVS]).toEqual(["prod", "staging", "dev"]);
  });

  it("rejects a packet_id that does not match the minted prefix pattern", () => {
    for (const packet_id of ["", "healthy_1758480000000_k3f9zq", "pkt_Healthy_1_abc", "pkt_h_1_k3f9zq7"]) {
      expect(issuePaths({ ...validPacket(), packet_id })).toEqual(["packet_id"]);
    }
    expect(PACKET_ID_PATTERN.test("pkt_healthy_1758480000000_k3f9zq")).toBe(true);
  });

  it("rejects a non-hex exemplar trace id", () => {
    expect(
      issuePaths({ ...validPacket(), exemplar_trace_ids: ["not-a-trace-id"] }),
    ).toEqual(["exemplar_trace_ids.0"]);
  });

  it("rejects non-object input with a schema error rather than a type error", () => {
    expect(PacketSchema.safeParse(null).success).toBe(false);
    expect(PacketSchema.safeParse("packet").success).toBe(false);
    expect(PacketSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("component schemas", () => {
  it("exposes SignalsSchema, TopSpanSchema, and RecentDeploySchema independently", () => {
    const input = validPacket();

    expect(SignalsSchema.parse(input.signals)).toEqual(input.signals);
    expect(TopSpanSchema.parse(input.top_spans[0])).toEqual(input.top_spans[0]);
    expect(RecentDeploySchema.parse(input.recent_deploy)).toEqual(input.recent_deploy);
    expect(TopSpanSchema.safeParse({ name: "x", count: 1.5, p95_ms: 1 }).success).toBe(false);
  });
});

describe("schema version", () => {
  it("exports the schema version constant equal to 1", () => {
    expect(PACKET_SCHEMA_VERSION).toBe("1");
    expect(Number(PACKET_SCHEMA_VERSION)).toBe(1);
  });
});
