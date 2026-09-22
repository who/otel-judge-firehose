import { describe, expect, it } from "vitest";

import {
  FALLBACK_SCENARIO_SEGMENT,
  mintPacketId,
  sanitizeScenarioSegment,
} from "../../src/packet/id";
import { PACKET_ID_PATTERN, PacketSchema, type PacketInput } from "../../src/packet/schema";
import {
  PacketValidationError,
  formatIssuePath,
  validatePacket,
  validatePackets,
} from "../../src/packet/validate";

function validPacket(overrides: Partial<PacketInput> = {}): PacketInput {
  return {
    packet_id: mintPacketId("healthy"),
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
    top_spans: [{ name: "POST /checkout", count: 9_400, p95_ms: 1_900 }],
    exemplar_trace_ids: ["4bf92f3577b34da6a3ce929d0e0e4736"],
    recent_deploy: null,
    alert_labels: ["slo:checkout-availability"],
    ...overrides,
  };
}

function captureError(fn: () => unknown): PacketValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PacketValidationError);
    return error as PacketValidationError;
  }
  throw new Error("expected the call to throw PacketValidationError");
}

describe("mintPacketId", () => {
  it("mints unique identifiers across ten thousand mints", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      ids.add(mintPacketId("healthy"));
    }

    expect(ids.size).toBe(10_000);
    for (const id of ids) {
      expect(id).toMatch(PACKET_ID_PATTERN);
    }
  });

  it("mints the documented four-segment shape with a pinned timestamp", () => {
    const now = new Date("2026-09-21T12:00:00Z");

    const id = mintPacketId("post_deploy_burn", now);

    const match = /^pkt_(.+)_(\d+)_([a-z0-9]{6})$/.exec(id);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("post_deploy_burn");
    expect(match?.[2]).toBe(String(now.getTime()));
    expect(match?.[3]).toHaveLength(6);
  });

  it("sanitizes scenario names containing spaces, slashes, and uppercase", () => {
    expect(sanitizeScenarioSegment("Post Deploy/Burn")).toBe("post_deploy_burn");
    expect(sanitizeScenarioSegment("  ")).toBe(FALLBACK_SCENARIO_SEGMENT);
    expect(sanitizeScenarioSegment("café-1")).toBe("caf__1");

    expect(mintPacketId("Post Deploy/Burn")).toMatch(PACKET_ID_PATTERN);
    expect(mintPacketId("")).toMatch(PACKET_ID_PATTERN);
    expect(mintPacketId("x")).toMatch(PACKET_ID_PATTERN);
  });

  it("is accepted by schema when placed in an otherwise valid packet", () => {
    const packet_id = mintPacketId("healthy");

    const parsed = PacketSchema.parse(validPacket({ packet_id }));
    const validated = validatePacket(validPacket({ packet_id }));

    expect(parsed.packet_id).toBe(packet_id);
    expect(validated.packet_id).toBe(packet_id);
  });
});

describe("validatePacket", () => {
  it("returns the typed packet and strips unknown keys", () => {
    const input = { ...validPacket(), extra: "ignored" };

    const packet = validatePacket(input);

    expect(packet).not.toHaveProperty("extra");
    expect(packet.service).toBe("checkout-api");
  });

  it("rejects malformed packets with an error naming the failing field path", () => {
    const input = validPacket({
      signals: { ...validPacket().signals, error_rate: 1.5 },
    });

    const error = captureError(() => validatePacket(input));

    expect(error.name).toBe("PacketValidationError");
    expect(error.failedIndices).toEqual([]);
    expect(error.issues.map((issue) => formatIssuePath(issue.path))).toContain(
      "signals.error_rate",
    );
    expect(error.message).toContain("signals.error_rate");
    expect(error.message).not.toContain("1.5");
    expect(error.details.some((line) => line.startsWith("signals.error_rate:"))).toBe(true);
  });

  it("rejects malformed non-object input with the validation error, not a type error", () => {
    for (const input of [null, undefined, "packet", 42, []]) {
      const error = captureError(() => validatePacket(input));
      expect(error.message).toContain("(root)");
    }
  });
});

describe("validatePackets", () => {
  it("returns an empty array for an empty batch", () => {
    expect(validatePackets([])).toEqual([]);
  });

  it("returns every packet in order when all candidates are valid", () => {
    const first = validPacket({ service: "first" });
    const second = validPacket({ service: "second" });

    const packets = validatePackets([first, second]);

    expect(packets.map((packet) => packet.service)).toEqual(["first", "second"]);
  });

  it("aggregates batch failures into one error listing every failing index", () => {
    const good = validPacket();
    const badId = validPacket({ packet_id: "not-a-packet-id" });
    const badRate = validPacket({
      signals: { ...validPacket().signals, request_rate: -1 },
    });

    const error = captureError(() => validatePackets([good, badId, good, badRate, null]));

    expect(error.failedIndices).toEqual([1, 3, 4]);
    const paths = error.issues.map((issue) => formatIssuePath(issue.path));
    expect(paths).toContain("[1].packet_id");
    expect(paths).toContain("[3].signals.request_rate");
    expect(paths).toContain("[4]");
    expect(error.message).toContain("3 packets failed validation at index 1, 3, 4");
    expect(error.message).toContain("[1].packet_id");
    expect(error.message).toContain("[3].signals.request_rate");
  });
});
