/**
 * Tests for the `demo_mix` scenario.
 *
 * The point of the scenario is variety, so the assertions are about the shape
 * of a whole seeded batch: every profile has to turn up, criticality has to be
 * readable off the packet, and the quiet profile has to stay quiet rather than
 * pad itself out with success-status log lines.
 */

import { describe, expect, it } from "vitest";

import {
  BEST_EFFORT_LABEL,
  CLIENT_NOISE_LABEL,
  CORE_DEGRADED_LABEL,
  CORE_PATH_LABEL,
  CORE_SERVICES,
  CRITICAL_BURN_LABEL,
  CRITICAL_PATH_LABEL,
  CRITICAL_SERVICES,
  DEMO_MIX_PROFILE_IDS,
  DEMO_MIX_WEIGHTS,
  DEMO_MIX_WEIGHT_TOTAL,
  OPTIONAL_PATH_LABEL,
  OPTIONAL_SERVICES,
  buildDemoMix,
  buildDemoMixProfile,
  criticalityLabel,
} from "../../src/fixtures/demoMix";
import {
  SCENARIOS,
  SEEDED_CLOCK_EPOCH_MS,
  WINDOW_MS,
  buildScenarioPackets,
  createBuildContextForTest,
  isoSeconds,
  resolveScenarioId,
} from "../../src/fixtures/registry";
import { PacketSchema, type Packet } from "../../src/packet/schema";

const BATCH_SEED = "demo-mix-board";
const BATCH_COUNT = 120;

function batch(): Packet[] {
  return buildScenarioPackets("demo_mix", BATCH_COUNT, { seed: BATCH_SEED });
}

/** Every string a reader would scan for evidence, flattened. */
function prose(packet: Packet): string[] {
  return [
    ...packet.top_spans.map((span) => span.name),
    ...packet.alert_labels,
    ...(packet.log_snippets ?? []),
  ];
}

describe("demo_mix registration", () => {
  it("is registered under its own id and reachable through the demo alias", () => {
    expect(SCENARIOS.demo_mix?.build).toBe(buildDemoMix);
    expect(SCENARIOS.demo_mix?.id).toBe("demo_mix");
    expect(resolveScenarioId("mix")).toBe("demo_mix");

    const packets = buildScenarioPackets(resolveScenarioId("mix"), 4, { seed: "alias" });
    expect(packets).toHaveLength(4);
    for (const packet of packets) {
      expect(packet.packet_id).toMatch(/^pkt_demo_mix_/);
    }
  });

  it("weights are whole numbers that sum to the declared total", () => {
    const sum = DEMO_MIX_PROFILE_IDS.reduce((total, id) => total + DEMO_MIX_WEIGHTS[id], 0);
    expect(sum).toBe(DEMO_MIX_WEIGHT_TOTAL);
    for (const id of DEMO_MIX_PROFILE_IDS) {
      expect(Number.isInteger(DEMO_MIX_WEIGHTS[id])).toBe(true);
      expect(DEMO_MIX_WEIGHTS[id]).toBeGreaterThan(0);
    }
  });
});

describe("demo_mix batch", () => {
  it("every packet in a seeded batch parses against the packet schema", () => {
    const packets = batch();

    expect(packets).toHaveLength(BATCH_COUNT);
    for (const packet of packets) {
      const parsed = PacketSchema.safeParse(packet);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
      expect(packet.env).toBe("prod");
      expect(packet.window).toEqual({
        start: isoSeconds(SEEDED_CLOCK_EPOCH_MS - WINDOW_MS),
        end: isoSeconds(SEEDED_CLOCK_EPOCH_MS),
      });
      for (const span of packet.top_spans) {
        expect(span.error_count).toBeLessThanOrEqual(span.count);
      }
    }
    expect(new Set(packets.map((packet) => packet.packet_id)).size).toBe(BATCH_COUNT);
  });

  it("a single packet is still a valid packet", () => {
    const packets = buildScenarioPackets("demo_mix", 1, { seed: "one" });
    expect(packets).toHaveLength(1);
    expect(PacketSchema.safeParse(packets[0]).success).toBe(true);
  });

  it("the same seed replays the same batch", () => {
    expect(batch()).toEqual(batch());
  });

  it("all five weighted profiles appear in one seeded batch", () => {
    const packets = batch();
    const labels = packets.flatMap((packet) => packet.alert_labels);

    expect(labels).toContain(CLIENT_NOISE_LABEL);
    expect(labels).toContain(OPTIONAL_PATH_LABEL);
    expect(labels).toContain(CORE_DEGRADED_LABEL);
    expect(labels).toContain(CRITICAL_BURN_LABEL);
    // The quiet profile is the one with nothing to say.
    expect(packets.some((packet) => packet.alert_labels.length === 0)).toBe(true);
  });
});

describe("demo_mix criticality", () => {
  it("a seeded batch carries both critical-path and best-effort windows", () => {
    const packets = batch();
    const critical = packets.filter((packet) => packet.alert_labels.includes(CRITICAL_PATH_LABEL));
    const bestEffort = packets.filter((packet) => packet.alert_labels.includes(BEST_EFFORT_LABEL));

    expect(critical.length).toBeGreaterThan(0);
    expect(bestEffort.length).toBeGreaterThan(0);
  });

  it("the criticality label always agrees with the service tier", () => {
    for (const packet of batch()) {
      if (packet.alert_labels.includes(CRITICAL_PATH_LABEL)) {
        expect(CRITICAL_SERVICES).toContain(packet.service);
      }
      if (packet.alert_labels.includes(CORE_PATH_LABEL)) {
        expect(CORE_SERVICES).toContain(packet.service);
      }
      if (packet.alert_labels.includes(BEST_EFFORT_LABEL)) {
        expect(OPTIONAL_SERVICES).toContain(packet.service);
      }
      const tiers = packet.alert_labels.filter((label) =>
        [CRITICAL_PATH_LABEL, CORE_PATH_LABEL, BEST_EFFORT_LABEL].includes(label),
      );
      expect(tiers.length).toBeLessThanOrEqual(1);
    }
  });

  it("best-effort failures never borrow a critical service name", () => {
    for (const packet of batch()) {
      if (!packet.alert_labels.includes(OPTIONAL_PATH_LABEL)) {
        continue;
      }
      expect(OPTIONAL_SERVICES).toContain(packet.service);
      for (const critical of CRITICAL_SERVICES) {
        expect(packet.service).not.toBe(critical);
      }
      expect(packet.alert_labels).toContain(BEST_EFFORT_LABEL);
    }
  });

  it("criticalityLabel maps every tier service and defaults to best effort", () => {
    for (const service of CRITICAL_SERVICES) {
      expect(criticalityLabel(service)).toBe(CRITICAL_PATH_LABEL);
    }
    for (const service of CORE_SERVICES) {
      expect(criticalityLabel(service)).toBe(CORE_PATH_LABEL);
    }
    for (const service of OPTIONAL_SERVICES) {
      expect(criticalityLabel(service)).toBe(BEST_EFFORT_LABEL);
    }
    expect(criticalityLabel("something-unlisted")).toBe(BEST_EFFORT_LABEL);
  });
});

describe("demo_mix client noise", () => {
  it("reads as client faults rather than a dependency outage", () => {
    const noisy = batch().filter((packet) => packet.alert_labels.includes(CLIENT_NOISE_LABEL));

    expect(noisy.length).toBeGreaterThan(0);
    for (const packet of noisy) {
      const { signals } = packet;

      // Moderate and chronic: a few times baseline, latency untouched.
      expect(signals.error_rate).toBeLessThanOrEqual(0.15);
      expect(signals.error_rate).toBeGreaterThan(signals.error_rate_baseline);
      expect(signals.error_rate).toBeLessThanOrEqual(signals.error_rate_baseline * 2.5);
      expect(signals.p95_latency_ms).toBeLessThanOrEqual(signals.p95_latency_baseline_ms * 1.13);
      expect(signals.slo_burn_rate).toBeLessThan(1.2);

      // Never dressed as a release that needs paging.
      expect(packet.recent_deploy).toBeUndefined();
      expect(packet.alert_labels).not.toContain(CRITICAL_BURN_LABEL);

      // The evidence names 4xx client faults, not 5xx from an upstream.
      const snippets = packet.log_snippets ?? [];
      expect(snippets.length).toBeGreaterThan(0);
      for (const snippet of snippets) {
        expect(snippet).toMatch(/HTTP 4\d\d/);
      }
    }
  });
});

describe("demo_mix quiet windows", () => {
  it("stay low-signal instead of padding themselves with success-status log spam", () => {
    const quiet = batch().filter((packet) => packet.alert_labels.length === 0);

    expect(quiet.length).toBeGreaterThan(0);
    for (const packet of quiet) {
      const { signals } = packet;

      expect(signals.error_rate).toBeLessThanOrEqual(signals.error_rate_baseline);
      expect(signals.p95_latency_ms).toBeLessThanOrEqual(signals.p95_latency_baseline_ms * 1.05);
      expect(signals.slo_burn_rate).toBeLessThan(0.5);
      expect(packet.recent_deploy).toBeUndefined();
      expect(packet.top_spans.length).toBeLessThanOrEqual(1);

      // The differentiator is the absence of signal, not a wall of 200s.
      expect(packet.log_snippets).toBeUndefined();
      for (const text of prose(packet)) {
        expect(text).not.toMatch(/\b2\d\d\b/);
      }
    }
  });

  it("no packet anywhere in the batch quotes a success status", () => {
    for (const packet of batch()) {
      for (const snippet of packet.log_snippets ?? []) {
        expect(snippet).not.toMatch(/HTTP 2\d\d/);
      }
    }
  });
});

describe("demo_mix profiles built directly", () => {
  it("each profile produces a schema-valid packet on its own", () => {
    for (const profile of DEMO_MIX_PROFILE_IDS) {
      const context = createBuildContextForTest("demo_mix", `profile-${profile}`);
      const packet = buildDemoMixProfile(profile, context);
      const parsed = PacketSchema.safeParse(packet);

      expect(parsed.success, `${profile}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
      expect(packet.packet_id).toMatch(/^pkt_demo_mix_/);
    }
  });

  it("the critical burn profile pages and names a release", () => {
    const context = createBuildContextForTest("demo_mix", "burn");
    const packet = buildDemoMixProfile("critical_burn", context);

    expect(packet.alert_labels).toContain(CRITICAL_PATH_LABEL);
    expect(packet.alert_labels).toContain(CRITICAL_BURN_LABEL);
    expect(CRITICAL_SERVICES).toContain(packet.service);
    expect(packet.signals.slo_burn_rate).toBeGreaterThan(5);
    expect(packet.recent_deploy?.minutes_ago).toBeGreaterThanOrEqual(0);
  });
});
