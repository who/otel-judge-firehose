/**
 * The `noise_storm` fixture: an alert storm the Judge should classify as
 * noise rather than an incident.
 *
 * Every health signal sits at or near baseline: the error rate is at or
 * below baseline (clamped at zero when the jitter would go negative), p95
 * latency stays within ten percent of baseline, and the burn rate is below
 * `NOISE_STORM_BURN_RATE_CEILING`. There is no recent deploy. What makes the
 * packet noisy is the shape around the signals: many low-count spans and a
 * long list of flapping, low-value alert labels with no duplicates.
 */

import { PACKET_SCHEMA_VERSION, type Packet, type TopSpan } from "../packet/schema";
import type { BuildContext } from "./registry";
import { between, hex, intBetween, round, type RandomSource } from "./rng";

export const NOISE_STORM_SERVICE = "checkout-api";

/** Every noise storm packet keeps its burn rate strictly below this value. */
export const NOISE_STORM_BURN_RATE_CEILING = 0.3;

/** Fewest alert labels a noise storm packet carries; the list is long by design. */
export const NOISE_STORM_MIN_LABELS = 8;

/** Fewest top spans a noise storm packet carries. */
export const NOISE_STORM_MIN_SPANS = 6;

/** Flapping, low-value labels the storm draws from. Order is irrelevant; entries are unique. */
export const NOISE_STORM_LABEL_POOL = [
  "cpu_spike",
  "gc_pause",
  "pod_restart",
  "disk_pressure",
  "log_volume",
  "cache_miss",
  "connection_reset",
  "retry_spike",
  "queue_lag",
  "dns_slow",
  "config_reload",
  "cert_rotation",
  "autoscale_event",
  "heartbeat_missed",
  "clock_skew",
  "metrics_gap",
] as const;

/** Unremarkable span names the storm scatters low counts across. */
const SPAN_POOL = [
  "GET /cart",
  "GET /health",
  "GET /products",
  "GET /profile",
  "db.query products",
  "db.query sessions",
  "cache.get cart",
  "cache.get catalog",
  "GET /static",
  "GET /metrics",
  "POST /events",
  "GET /recommendations",
] as const;

export function buildNoiseStorm({ random, packetId, window }: BuildContext): Packet {
  const errorRateBaseline = round(between(random, 0.0002, 0.0012), 5);
  // Jitter only ever subtracts, so the rate is at or below baseline; the
  // clamp keeps a near-zero baseline from producing a negative rate.
  const errorRate = Math.max(0, round(errorRateBaseline - between(random, 0, 0.0006), 5));
  const p95Baseline = round(between(random, 380, 460), 1);
  const p95 = round(p95Baseline * between(random, 0.92, 1.08), 1);
  const burnRate = round(between(random, 0.05, 0.25), 3);
  const requestRate = round(between(random, 240, 360), 1);

  const spanNames = sampleDistinct(random, SPAN_POOL, intBetween(random, NOISE_STORM_MIN_SPANS, SPAN_POOL.length));
  const topSpans: TopSpan[] = spanNames.map((name) => ({
    name,
    count: intBetween(random, 5, 120),
    error_count: intBetween(random, 0, 3),
    p95_ms: round(between(random, 20, 180), 1),
  }));

  const alertLabels = sampleDistinct(
    random,
    NOISE_STORM_LABEL_POOL,
    intBetween(random, NOISE_STORM_MIN_LABELS, NOISE_STORM_LABEL_POOL.length),
  );

  const exemplarTraceIds = intBetween(random, 0, 1) === 0 ? [] : [hex(random, 32)];

  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: packetId,
    service: NOISE_STORM_SERVICE,
    env: "prod",
    window,
    signals: {
      error_rate: errorRate,
      error_rate_baseline: errorRateBaseline,
      p95_latency_ms: p95,
      p95_latency_baseline_ms: p95Baseline,
      request_rate_rps: requestRate,
      slo_burn_rate: burnRate,
    },
    top_spans: topSpans,
    exemplar_trace_ids: exemplarTraceIds,
    alert_labels: alertLabels,
  };
}

/**
 * Draws `size` distinct elements from `pool` using a seeded partial
 * Fisher-Yates shuffle, so the result has no duplicates and is reproducible.
 * `size` is clamped to the pool length.
 */
function sampleDistinct<T>(random: RandomSource, pool: readonly T[], size: number): T[] {
  const copy = [...pool];
  const take = Math.min(size, copy.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.min(Math.floor(random() * (copy.length - i)), copy.length - i - 1);
    const swap = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = swap;
  }
  return copy.slice(0, take);
}
