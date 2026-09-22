import { describe, expect, it } from "vitest";

import { buildHealthy } from "../../src/fixtures/healthy";
import { POST_DEPLOY_BURN_LABELS, buildPostDeployBurn } from "../../src/fixtures/postDeployBurn";
import {
  SCENARIOS,
  SEEDED_CLOCK_EPOCH_MS,
  UnknownScenarioError,
  WINDOW_MS,
  buildScenarioPackets,
  listScenarios,
} from "../../src/fixtures/registry";
import { createSeededRng, fnv1a32 } from "../../src/fixtures/rng";
import { mintPacketId } from "../../src/packet/id";
import { PACKET_ID_PATTERN, PacketSchema } from "../../src/packet/schema";

describe("createSeededRng", () => {
  it("yields the same sequence for the same seed and values inside [0, 1)", () => {
    const a = createSeededRng("demo");
    const b = createSeededRng("demo");
    const c = createSeededRng("demo-2");
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    const seqC = Array.from({ length: 50 }, () => c());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });

  it("makes mintPacketId reproducible when handed the seeded source", () => {
    const now = new Date(SEEDED_CLOCK_EPOCH_MS);
    const first = mintPacketId("healthy", now, createSeededRng("s"));
    const second = mintPacketId("healthy", now, createSeededRng("s"));

    expect(first).toBe(second);
    expect(first).toMatch(PACKET_ID_PATTERN);
  });
});

describe("buildScenarioPackets", () => {
  it("healthy packets are schema-valid with distinct identifiers", () => {
    const packets = buildScenarioPackets("healthy", 25);

    expect(packets).toHaveLength(25);
    const ids = new Set(packets.map((packet) => packet.packet_id));
    expect(ids.size).toBe(25);
    for (const packet of packets) {
      expect(PacketSchema.safeParse(packet).success).toBe(true);
      expect(packet.packet_id).toMatch(/^pkt_healthy_/);
      expect(packet.signals.error_rate).toBeLessThan(0.002);
      expect(packet.signals.slo_burn_rate).toBeLessThan(0.5);
      expect(packet.recent_deploy).toBeNull();
      expect(packet.alert_labels).toEqual([]);
      expect(packet.top_spans.length).toBeLessThanOrEqual(1);
      expect(Date.parse(packet.window.end) - Date.parse(packet.window.start)).toBe(WINDOW_MS);
    }
  });

  it("healthy packets stay distinct in the same millisecond under a pinned clock", () => {
    const packets = buildScenarioPackets("healthy", 200, { seed: "same-ms" });
    const ids = new Set(packets.map((packet) => packet.packet_id));

    expect(ids.size).toBe(200);
    const stamps = new Set(packets.map((packet) => packet.packet_id.split("_").at(-2)));
    expect(stamps.size).toBe(1);
  });

  it("post deploy burn packets exceed baseline error rate and carry a recent deploy", () => {
    const packets = buildScenarioPackets("post_deploy_burn", 20);

    expect(packets).toHaveLength(20);
    for (const packet of packets) {
      expect(PacketSchema.safeParse(packet).success).toBe(true);
      expect(packet.packet_id).toMatch(/^pkt_post_deploy_burn_/);
      const { signals } = packet;
      expect(signals.error_rate).toBeGreaterThanOrEqual(signals.error_rate_baseline * 9.9);
      expect(signals.error_rate).toBeLessThanOrEqual(signals.error_rate_baseline * 30.1);
      expect(signals.p95_latency_ms).toBeGreaterThanOrEqual(signals.p95_latency_baseline_ms * 1.99);
      expect(signals.p95_latency_ms).toBeLessThanOrEqual(signals.p95_latency_baseline_ms * 4.01);
      expect(signals.slo_burn_rate).toBeGreaterThan(4);
      expect(packet.recent_deploy).not.toBeNull();
      expect(packet.recent_deploy?.sha).toMatch(/^[0-9a-f]{12}$/);
      expect(Date.parse(packet.recent_deploy?.deployed_at ?? "")).toBeLessThan(
        Date.parse(packet.window.start),
      );
      expect(packet.alert_labels).toEqual([...POST_DEPLOY_BURN_LABELS]);
      expect(packet.top_spans.length).toBeGreaterThan(0);
    }
  });

  it("seed reproducible: the same seed and count produce identical output", () => {
    for (const id of ["healthy", "post_deploy_burn"]) {
      const first = buildScenarioPackets(id, 7, { seed: "replay-me" });
      const second = buildScenarioPackets(id, 7, { seed: "replay-me" });
      const other = buildScenarioPackets(id, 7, { seed: "different" });

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(JSON.stringify(first)).not.toBe(JSON.stringify(other));
      expect(first[0]?.window.end).toBe("2026-09-21T12:00:00Z");
    }
  });

  it("seed reproducible output honours an explicit clock", () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const packets = buildScenarioPackets("healthy", 3, { seed: "clock", now });

    for (const packet of packets) {
      expect(packet.window.end).toBe("2026-01-02T03:04:05Z");
      expect(packet.packet_id.split("_").at(-2)).toBe(String(now));
    }
  });

  it("unknown scenario identifiers raise UnknownScenarioError", () => {
    expect(() => buildScenarioPackets("nope", 1)).toThrow(UnknownScenarioError);
    expect(() => buildScenarioPackets("toString", 1)).toThrow(UnknownScenarioError);
    try {
      buildScenarioPackets("nope", 1);
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownScenarioError);
      expect((error as UnknownScenarioError).name).toBe("UnknownScenarioError");
      expect((error as UnknownScenarioError).scenarioId).toBe("nope");
      expect((error as UnknownScenarioError).message).toContain("healthy");
    }
  });

  it("returns an empty array for a count of zero and rejects negative or fractional counts", () => {
    expect(buildScenarioPackets("healthy", 0)).toEqual([]);
    expect(() => buildScenarioPackets("healthy", -1)).toThrow(RangeError);
    expect(() => buildScenarioPackets("healthy", 1.5)).toThrow(RangeError);
  });
});

describe("listScenarios", () => {
  it("lists scenarios with stable ids and descriptions", () => {
    const listed = listScenarios();

    expect(listed.map((entry) => entry.id)).toEqual([
      "healthy",
      "post_deploy_burn",
      "dependency_timeouts",
      "noise_storm",
    ]);
    for (const entry of listed) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(SCENARIOS[entry.id]?.description).toBe(entry.description);
    }
    expect(SCENARIOS.healthy?.build).toBe(buildHealthy);
    expect(SCENARIOS.post_deploy_burn?.build).toBe(buildPostDeployBurn);
  });
});
