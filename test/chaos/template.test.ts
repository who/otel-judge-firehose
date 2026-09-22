import { describe, expect, it } from "vitest";

import {
  ALERT_LABEL_POOL,
  DEPLOY_PROBABILITY,
  MAX_LABELS,
  MAX_SPANS,
  MIN_SPANS,
  SERVICE_POOL,
  SPAN_POOL,
  buildChaosPacket,
  sampleDistinct,
} from "../../src/chaos/template";
import { SCENARIOS, buildScenarioPackets, listScenarios } from "../../src/fixtures/registry";
import { createSeededRng } from "../../src/fixtures/rng";
import { routeRequest, type Env } from "../../src/index";
import { PACKET_ENVS, PacketSchema } from "../../src/packet/schema";

const SEED_SWEEP = 1000;

describe("chaos template", () => {
  it("validates across seeds: a thousand consecutive seeds all produce schema-valid packets", () => {
    let deployed = 0;
    let total = 0;
    for (let i = 0; i < SEED_SWEEP; i += 1) {
      const packets = buildScenarioPackets("chaos", 2, { seed: `chaos-${i}` });
      expect(packets).toHaveLength(2);
      for (const packet of packets) {
        const result = PacketSchema.safeParse(packet);
        expect(result.success, `seed ${i}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
        expect(packet.packet_id).toMatch(/^pkt_chaos_/);

        // Sampled values come from the pools and never from anywhere else.
        expect(SERVICE_POOL).toContain(packet.service);
        expect(packet.service.length).toBeGreaterThan(0);
        expect(PACKET_ENVS).toContain(packet.env);

        // Signals sit inside the schema bounds by construction, not by clamping.
        const { signals } = packet;
        expect(signals.error_rate).toBeGreaterThanOrEqual(0);
        expect(signals.error_rate).toBeLessThanOrEqual(1);
        expect(signals.error_rate_baseline).toBeGreaterThanOrEqual(0);
        expect(signals.error_rate_baseline).toBeLessThanOrEqual(1);
        expect(signals.p95_latency_ms).toBeGreaterThan(0);
        expect(signals.p95_latency_baseline_ms).toBeGreaterThan(0);
        expect(signals.slo_burn_rate).toBeGreaterThan(0);
        expect(signals.request_rate).toBeGreaterThan(0);

        // Span mix is bounded, drawn from the pool, and duplicate-free.
        expect(packet.top_spans.length).toBeGreaterThanOrEqual(MIN_SPANS);
        expect(packet.top_spans.length).toBeLessThanOrEqual(MAX_SPANS);
        expect(new Set(packet.top_spans.map((span) => span.name)).size).toBe(packet.top_spans.length);
        for (const span of packet.top_spans) {
          expect(SPAN_POOL).toContain(span.name);
        }

        // Alert labels are a bounded, duplicate-free subset of the pool.
        expect(packet.alert_labels.length).toBeLessThanOrEqual(MAX_LABELS);
        expect(new Set(packet.alert_labels).size).toBe(packet.alert_labels.length);
        for (const label of packet.alert_labels) {
          expect(ALERT_LABEL_POOL).toContain(label);
        }

        if (packet.recent_deploy !== null) {
          deployed += 1;
          expect(packet.recent_deploy.sha).toMatch(/^[0-9a-f]{12}$/);
          expect(Date.parse(packet.recent_deploy.deployed_at)).toBeLessThan(Date.parse(packet.window.start));
        }
        total += 1;
      }
    }

    // Roughly one packet in four is deploy related: a mixed signal, not a constant.
    const share = deployed / total;
    expect(share).toBeGreaterThan(DEPLOY_PROBABILITY - 0.08);
    expect(share).toBeLessThan(DEPLOY_PROBABILITY + 0.08);
  });

  it("seed reproducible: the same seed replays byte for byte and different seeds diverge", () => {
    const first = buildScenarioPackets("chaos", 8, { seed: "replay-chaos" });
    const second = buildScenarioPackets("chaos", 8, { seed: "replay-chaos" });
    const other = buildScenarioPackets("chaos", 8, { seed: "elsewhere" });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(other));

    // Variation is real, not just the identifier: across a modest sweep the
    // sampler visits more than one service, environment, and label count.
    const services = new Set<string>();
    const envs = new Set<string>();
    const labelCounts = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const [packet] = buildScenarioPackets("chaos", 1, { seed: `vary-${i}` });
      services.add(packet?.service ?? "");
      envs.add(packet?.env ?? "");
      labelCounts.add(packet?.alert_labels.length ?? -1);
    }
    expect(services.size).toBeGreaterThan(3);
    expect(envs.size).toBe(PACKET_ENVS.length);
    expect(labelCounts.size).toBeGreaterThan(2);
  });

  it("seed reproducible: sampleDistinct never repeats an element and clamps to the pool", () => {
    const pool = ["a", "b", "c", "d", "e"] as const;
    for (let i = 0; i < 200; i += 1) {
      const random = createSeededRng(`distinct-${i}`);
      const size = i % 8;
      const drawn = sampleDistinct(random, pool, size);
      expect(drawn).toHaveLength(Math.min(size, pool.length));
      expect(new Set(drawn).size).toBe(drawn.length);
      for (const item of drawn) {
        expect(pool).toContain(item);
      }
    }
    expect(sampleDistinct(createSeededRng("neg"), pool, -3)).toEqual([]);
  });

  it("listed scenario: chaos is registered after the four fixtures and reachable through emit", async () => {
    const listed = listScenarios();
    const chaos = listed.find((entry) => entry.id === "chaos");

    expect(listed.map((entry) => entry.id)).toEqual([
      "healthy",
      "post_deploy_burn",
      "dependency_timeouts",
      "noise_storm",
      "chaos",
    ]);
    expect(chaos?.description.toLowerCase()).toContain("randomized");
    expect(SCENARIOS.chaos?.build).toBe(buildChaosPacket);

    // The existing emit route serves chaos with no change: a dry run
    // generates and validates without posting anything.
    const env: Env = { JUDGE_FIREHOSE_URL: "https://judge.example/ingest/v1" };
    let posts = 0;
    const response = await routeRequest(
      new Request("https://firehose.test/emit", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://who.github.io" },
        body: JSON.stringify({ scenario: "chaos", count: 5, seed: "via-emit", dryRun: true }),
      }),
      env,
      {
        fetch: async () => {
          posts += 1;
          return new Response(null, { status: 202 });
        },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; scenario: string; generated: number; packetIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.scenario).toBe("chaos");
    expect(body.generated).toBe(5);
    expect(body.packetIds.every((id) => id.startsWith("pkt_chaos_"))).toBe(true);
    expect(posts).toBe(0);
  });
});
