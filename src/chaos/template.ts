/**
 * The `chaos` scenario: a seeded template randomizer (PRD FR2).
 *
 * Where the four fixtures each model one fixed shape, `buildChaosPacket`
 * samples a service, an environment, a signal profile, a span mix, and an
 * alert label subset from small literal pools, so repeated demo runs stop
 * looking canned. Every range sits strictly inside the `PacketSchema`
 * bounds, so a validation failure downstream is a bug here, never an
 * expected outcome. The builder draws only from the `BuildContext` random
 * source, so a seeded run replays byte for byte and a failure is reportable.
 *
 * Roughly one packet in four carries a populated `recent_deploy`; the rest
 * set it to `null`, giving the Judge a mixed signal on deploy relatedness.
 *
 * The Workers AI chaos path in `./llm.ts` reuses this module as its base and
 * its fallback; nothing here touches an AI binding or a new route.
 */

import { PACKET_ENVS, type Packet, type PacketEnv, type RecentDeploy, type TopSpan } from "../packet/schema";
import { isoSeconds, type BuildContext } from "../fixtures/registry";
import { between, hex, intBetween, pick, round, type RandomSource } from "../fixtures/rng";

/** Plausible service names; every entry is non-empty so `service` always validates. */
export const SERVICE_POOL = [
  "checkout-api",
  "cart-service",
  "inventory-api",
  "payments-gateway",
  "search-indexer",
  "recommendations",
  "auth-service",
  "notifications",
  "order-orchestrator",
  "catalog-api",
] as const;

/** Span names the chaos packet scatters counts across. */
export const SPAN_POOL = [
  "POST /checkout",
  "GET /cart",
  "GET /products",
  "GET /search",
  "POST /login",
  "GET /recommendations",
  "db.query orders",
  "db.query products",
  "db.query sessions",
  "cache.get catalog",
  "client payments-gateway",
  "client inventory-api",
  "client auth-service",
  "queue.publish order.created",
] as const;

/** Alert labels the chaos packet may carry; drawn without replacement. */
export const ALERT_LABEL_POOL = [
  "slo_burn",
  "deploy_window",
  "latency",
  "dependency",
  "error_spike",
  "cpu_spike",
  "gc_pause",
  "pod_restart",
  "retry_spike",
  "queue_lag",
  "cache_miss",
  "connection_reset",
] as const;

/** Environments are the schema's closed set, re-exported so the pool is visible in one place. */
export const ENV_POOL: readonly [PacketEnv, ...PacketEnv[]] = PACKET_ENVS;

/** Fraction of chaos packets that carry a populated `recent_deploy`. */
export const DEPLOY_PROBABILITY = 0.25;

/** Fewest and most top spans a chaos packet carries. */
export const MIN_SPANS = 1;
export const MAX_SPANS = 6;

/** Most alert labels a chaos packet carries; the floor is zero. */
export const MAX_LABELS = 5;

/**
 * One signal profile: half-open sampling ranges for the multipliers and
 * absolute values that shape a packet's health signals. Every range is
 * chosen so the derived values stay inside the schema bounds (rates in
 * `[0, 1]`, latencies under an hour, burn rate under 10 000).
 */
interface SignalProfile {
  readonly name: string;
  readonly errorRateBaseline: readonly [number, number];
  readonly errorRateMultiplier: readonly [number, number];
  readonly p95BaselineMs: readonly [number, number];
  readonly p95Multiplier: readonly [number, number];
  readonly burnRate: readonly [number, number];
  readonly requestRate: readonly [number, number];
}

/** Named profiles from quiet to burning so the chaos stream has spread, not just jitter. */
export const SIGNAL_PROFILES: readonly [SignalProfile, ...SignalProfile[]] = [
  {
    name: "quiet",
    errorRateBaseline: [0.0005, 0.002],
    errorRateMultiplier: [0.5, 1.5],
    p95BaselineMs: [80, 500],
    p95Multiplier: [0.9, 1.15],
    burnRate: [0.05, 0.6],
    requestRate: [20, 800],
  },
  {
    name: "degraded",
    errorRateBaseline: [0.001, 0.005],
    errorRateMultiplier: [2, 8],
    p95BaselineMs: [120, 600],
    p95Multiplier: [1.5, 4],
    burnRate: [0.8, 4],
    requestRate: [50, 1200],
  },
  {
    name: "burning",
    errorRateBaseline: [0.002, 0.01],
    errorRateMultiplier: [8, 40],
    p95BaselineMs: [150, 700],
    p95Multiplier: [3, 9],
    burnRate: [4, 40],
    requestRate: [100, 2000],
  },
];

const MINUTE_MS = 60 * 1000;

/** Uniform draw from a half-open `[min, max)` range tuple. */
function draw(random: RandomSource, range: readonly [number, number]): number {
  return between(random, range[0], range[1]);
}

/**
 * Draws `size` distinct elements from `pool` with a seeded partial
 * Fisher-Yates shuffle, so the result has no duplicates and replays under
 * the same seed. `size` is clamped to the pool length.
 */
export function sampleDistinct<T>(random: RandomSource, pool: readonly T[], size: number): T[] {
  const copy = [...pool];
  const take = Math.max(0, Math.min(size, copy.length));
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.min(Math.floor(random() * (copy.length - i)), copy.length - i - 1);
    const swap = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = swap;
  }
  return copy.slice(0, take);
}

/** A deploy that landed two to thirty minutes before the window opened. */
function sampleDeploy(random: RandomSource, nowMs: number, windowStartMs: number): RecentDeploy {
  const deployedAtMs = windowStartMs - intBetween(random, 2, 30) * MINUTE_MS;
  const date = new Date(nowMs);
  const version = `${date.getUTCFullYear()}.${pad2(date.getUTCMonth() + 1)}.${pad2(date.getUTCDate())}-${intBetween(
    random,
    1,
    20,
  )}`;
  return { sha: hex(random, 12), version, deployed_at: isoSeconds(deployedAtMs) };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Builds one randomized, schema-valid packet. Registered in `SCENARIOS` as
 * `chaos`, so the emit route reaches it exactly like a fixture.
 */
export function buildChaosPacket({ random, packetId, window, nowMs }: BuildContext): Packet {
  const service = pick(random, SERVICE_POOL);
  const env = pick(random, ENV_POOL);
  const profile = pick(random, SIGNAL_PROFILES);

  const errorRateBaseline = round(draw(random, profile.errorRateBaseline), 5);
  // The largest baseline times the largest multiplier is 0.4, well inside [0, 1].
  const errorRate = round(errorRateBaseline * draw(random, profile.errorRateMultiplier), 5);
  const p95Baseline = round(draw(random, profile.p95BaselineMs), 1);
  const p95 = round(p95Baseline * draw(random, profile.p95Multiplier), 1);
  const burnRate = round(draw(random, profile.burnRate), 3);
  const requestRate = round(draw(random, profile.requestRate), 1);

  const spanNames = sampleDistinct(random, SPAN_POOL, intBetween(random, MIN_SPANS, MAX_SPANS));
  const topSpans: TopSpan[] = spanNames.map((name) => ({
    name,
    count: intBetween(random, 10, 20_000),
    p95_ms: round(p95 * between(random, 0.3, 1.1), 1),
  }));

  const alertLabels = sampleDistinct(random, ALERT_LABEL_POOL, intBetween(random, 0, MAX_LABELS));

  const exemplarTraceIds = Array.from({ length: intBetween(random, 0, 2) }, () => hex(random, 32));

  const recentDeploy =
    random() < DEPLOY_PROBABILITY ? sampleDeploy(random, nowMs, Date.parse(window.start)) : null;

  return {
    packet_id: packetId,
    service,
    env,
    window,
    signals: {
      error_rate: errorRate,
      error_rate_baseline: errorRateBaseline,
      p95_latency_ms: p95,
      p95_latency_baseline_ms: p95Baseline,
      slo_burn_rate: burnRate,
      request_rate: requestRate,
    },
    top_spans: topSpans,
    exemplar_trace_ids: exemplarTraceIds,
    recent_deploy: recentDeploy,
    alert_labels: alertLabels,
  };
}
