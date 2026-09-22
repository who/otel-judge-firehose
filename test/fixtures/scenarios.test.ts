import { describe, expect, it } from "vitest";

import {
  DEPENDENCY_TIMEOUTS_CEILING_MS,
  DEPENDENCY_TIMEOUTS_LABELS,
  DEPENDENCY_TIMEOUTS_UPSTREAM,
  DEPENDENCY_TIMEOUTS_UPSTREAM_SPAN,
  buildDependencyTimeouts,
} from "../../src/fixtures/dependencyTimeouts";
import {
  NOISE_STORM_BURN_RATE_CEILING,
  NOISE_STORM_LABEL_POOL,
  NOISE_STORM_MIN_LABELS,
  NOISE_STORM_MIN_SPANS,
  buildNoiseStorm,
} from "../../src/fixtures/noiseStorm";
import { SCENARIOS, buildScenarioPackets, listScenarios } from "../../src/fixtures/registry";
import { PacketSchema } from "../../src/packet/schema";

const ALL_SCENARIO_IDS = ["healthy", "post_deploy_burn", "dependency_timeouts", "noise_storm"] as const;

describe("dependency timeouts", () => {
  it("dependency timeouts packets show elevated latency, a null recent deploy, and an upstream client span leading", () => {
    const packets = buildScenarioPackets("dependency_timeouts", 30);

    expect(packets).toHaveLength(30);
    for (const packet of packets) {
      expect(PacketSchema.safeParse(packet).success).toBe(true);
      expect(packet.packet_id).toMatch(/^pkt_dependency_timeouts_/);
      const { signals } = packet;

      // Latency is the symptom: 4-8x baseline, crowding a round timeout ceiling.
      expect(signals.p95_latency_ms).toBeGreaterThanOrEqual(signals.p95_latency_baseline_ms * 3.99);
      expect(signals.p95_latency_ms).toBeLessThanOrEqual(signals.p95_latency_baseline_ms * 8.01);
      expect(signals.p95_latency_ms).toBeLessThanOrEqual(DEPENDENCY_TIMEOUTS_CEILING_MS);
      expect(signals.p95_latency_ms).toBeGreaterThanOrEqual(DEPENDENCY_TIMEOUTS_CEILING_MS * 0.85);

      // Moderate error rate and a burn rate between 1 and 3: bad, not catastrophic.
      expect(signals.error_rate).toBeGreaterThanOrEqual(0.05);
      expect(signals.error_rate).toBeLessThanOrEqual(0.15);
      expect(signals.slo_burn_rate).toBeGreaterThan(1);
      expect(signals.slo_burn_rate).toBeLessThan(3);

      // Not deploy related.
      expect(packet.recent_deploy).toBeNull();

      // The upstream client span leads and dominates the span list.
      expect(packet.top_spans.length).toBeGreaterThanOrEqual(2);
      const leading = packet.top_spans[0];
      expect(leading?.name).toBe(DEPENDENCY_TIMEOUTS_UPSTREAM_SPAN);
      expect(leading?.name).toContain(DEPENDENCY_TIMEOUTS_UPSTREAM);
      expect(leading?.name.startsWith("client ")).toBe(true);
      for (const span of packet.top_spans.slice(1)) {
        expect(leading?.count).toBeGreaterThan(span.count);
      }
      expect(leading?.p95_ms).toBeLessThanOrEqual(DEPENDENCY_TIMEOUTS_CEILING_MS);

      expect(packet.alert_labels).toEqual([...DEPENDENCY_TIMEOUTS_LABELS]);
      expect(packet.alert_labels).toContain("dependency");
      expect(packet.alert_labels).toContain("latency");
      expect(new Set(packet.alert_labels).size).toBe(packet.alert_labels.length);
    }
    expect(SCENARIOS.dependency_timeouts?.build).toBe(buildDependencyTimeouts);
  });
});

describe("noise storm", () => {
  it("noise storm packets show near-baseline signals, a low burn rate, and a long alert label list", () => {
    const packets = buildScenarioPackets("noise_storm", 30);

    expect(packets).toHaveLength(30);
    for (const packet of packets) {
      expect(PacketSchema.safeParse(packet).success).toBe(true);
      expect(packet.packet_id).toMatch(/^pkt_noise_storm_/);
      const { signals } = packet;

      // Signals at or near baseline.
      expect(signals.error_rate).toBeGreaterThanOrEqual(0);
      expect(signals.error_rate).toBeLessThanOrEqual(signals.error_rate_baseline);
      expect(signals.p95_latency_ms).toBeGreaterThanOrEqual(signals.p95_latency_baseline_ms * 0.9);
      expect(signals.p95_latency_ms).toBeLessThanOrEqual(signals.p95_latency_baseline_ms * 1.1);
      expect(signals.slo_burn_rate).toBeLessThan(NOISE_STORM_BURN_RATE_CEILING);

      // Not deploy related.
      expect(packet.recent_deploy).toBeNull();

      // Many low-count spans, none of them hot.
      expect(packet.top_spans.length).toBeGreaterThanOrEqual(NOISE_STORM_MIN_SPANS);
      expect(new Set(packet.top_spans.map((span) => span.name)).size).toBe(packet.top_spans.length);
      for (const span of packet.top_spans) {
        expect(span.count).toBeLessThanOrEqual(120);
      }

      // A long, duplicate-free list of low-value labels drawn from the pool.
      expect(packet.alert_labels.length).toBeGreaterThanOrEqual(NOISE_STORM_MIN_LABELS);
      expect(new Set(packet.alert_labels).size).toBe(packet.alert_labels.length);
      for (const label of packet.alert_labels) {
        expect(NOISE_STORM_LABEL_POOL).toContain(label);
      }
      expect(packet.alert_labels).not.toContain("slo_burn");
      expect(packet.alert_labels).not.toContain("deploy_window");
      expect(packet.alert_labels).not.toContain("dependency");
    }
    expect(SCENARIOS.noise_storm?.build).toBe(buildNoiseStorm);
  });

  it("noise storm clamps the error rate at zero for a seed whose jitter exceeds the baseline", () => {
    // Sweep seeds until the subtractive jitter would have gone negative; the
    // clamp must hold for every packet along the way.
    let sawZero = false;
    for (let i = 0; i < 400 && !sawZero; i += 1) {
      const [packet] = buildScenarioPackets("noise_storm", 1, { seed: `clamp-${i}` });
      expect(packet?.signals.error_rate).toBeGreaterThanOrEqual(0);
      if (packet?.signals.error_rate === 0) {
        sawZero = true;
      }
    }
    expect(sawZero).toBe(true);
  });
});

describe("all scenarios validate", () => {
  it("all scenarios validate against the packet schema across many seeds", () => {
    for (const id of ALL_SCENARIO_IDS) {
      for (let i = 0; i < 100; i += 1) {
        const packets = buildScenarioPackets(id, 3, { seed: `${id}-${i}` });
        expect(packets).toHaveLength(3);
        for (const packet of packets) {
          const result = PacketSchema.safeParse(packet);
          expect(result.success, `${id} seed ${i}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
          expect(packet.signals.error_rate).toBeGreaterThanOrEqual(0);
          expect(packet.signals.error_rate).toBeLessThanOrEqual(1);
          expect(packet.signals.p95_latency_ms).toBeGreaterThanOrEqual(0);
          expect(packet.recent_deploy === null || typeof packet.recent_deploy === "object").toBe(true);
          expect(new Set(packet.alert_labels).size).toBe(packet.alert_labels.length);
        }
      }
    }
  });

  it("all scenarios validate: the same seed reproduces the two new scenarios byte for byte", () => {
    for (const id of ["dependency_timeouts", "noise_storm"]) {
      const first = buildScenarioPackets(id, 5, { seed: "replay" });
      const second = buildScenarioPackets(id, 5, { seed: "replay" });
      const other = buildScenarioPackets(id, 5, { seed: "elsewhere" });

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(JSON.stringify(first)).not.toBe(JSON.stringify(other));
    }
  });

  it("all scenarios validate: the four profiles stay distinguishable from one another", () => {
    const [healthy] = buildScenarioPackets("healthy", 1, { seed: "x" });
    const [burn] = buildScenarioPackets("post_deploy_burn", 1, { seed: "x" });
    const [timeouts] = buildScenarioPackets("dependency_timeouts", 1, { seed: "x" });
    const [noise] = buildScenarioPackets("noise_storm", 1, { seed: "x" });

    // Only the post-deploy burn is deploy related.
    expect(burn?.recent_deploy).not.toBeNull();
    expect(healthy?.recent_deploy).toBeNull();
    expect(timeouts?.recent_deploy).toBeNull();
    expect(noise?.recent_deploy).toBeNull();

    // Latency ratio separates dependency timeouts from the burn and from the quiet ones.
    const ratio = (p: typeof healthy) => (p?.signals.p95_latency_ms ?? 0) / (p?.signals.p95_latency_baseline_ms ?? 1);
    expect(ratio(timeouts)).toBeGreaterThan(ratio(burn));
    expect(ratio(burn)).toBeGreaterThan(ratio(healthy));
    expect(ratio(noise)).toBeLessThan(1.1);

    // Burn rate separates the burn from the timeouts and both from the quiet ones.
    expect(burn?.signals.slo_burn_rate).toBeGreaterThan(timeouts?.signals.slo_burn_rate ?? 0);
    expect(timeouts?.signals.slo_burn_rate).toBeGreaterThan(noise?.signals.slo_burn_rate ?? 0);
    expect(timeouts?.signals.slo_burn_rate).toBeGreaterThan(healthy?.signals.slo_burn_rate ?? 0);

    // Label count separates the noise storm from everything else.
    expect(noise?.alert_labels.length).toBeGreaterThan(timeouts?.alert_labels.length ?? 0);
    expect(noise?.alert_labels.length).toBeGreaterThan(burn?.alert_labels.length ?? 0);
    expect(healthy?.alert_labels).toEqual([]);
  });
});

describe("four scenarios", () => {
  it("the scenario listing reports exactly four scenarios in registration order", () => {
    const listed = listScenarios();

    expect(listed).toHaveLength(4);
    expect(listed.map((entry) => entry.id)).toEqual([...ALL_SCENARIO_IDS]);
    for (const entry of listed) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(SCENARIOS[entry.id]?.description).toBe(entry.description);
    }
    expect(Object.keys(SCENARIOS)).toHaveLength(4);
  });
});
