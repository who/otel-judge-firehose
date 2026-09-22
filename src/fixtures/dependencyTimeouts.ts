/**
 * The `dependency_timeouts` fixture: an upstream dependency failing while the
 * service itself is healthy.
 *
 * p95 latency runs four to eight times baseline and sits just under a round
 * client timeout ceiling, because requests are waiting on the upstream until
 * the timeout fires. The error rate is moderate (roughly 5% to 15%) rather
 * than catastrophic, the burn rate sits between 1 and 3, and there is no
 * recent deploy, so the Judge cannot attribute the incident to a release.
 * The span list is led by a client span named for the upstream dependency
 * and the alert labels name both the dependency and the latency symptom.
 */

import type { Packet } from "../packet/schema";
import type { BuildContext } from "./registry";
import { between, hex, intBetween, round } from "./rng";

export const DEPENDENCY_TIMEOUTS_SERVICE = "checkout-api";

/** The upstream the service is timing out against. */
export const DEPENDENCY_TIMEOUTS_UPSTREAM = "payments-gateway";

/** Client span that leads `top_spans` in every dependency timeout packet. */
export const DEPENDENCY_TIMEOUTS_UPSTREAM_SPAN = `client ${DEPENDENCY_TIMEOUTS_UPSTREAM} POST /v1/authorize`;

/** Round client timeout the observed p95 latency crowds up against, in milliseconds. */
export const DEPENDENCY_TIMEOUTS_CEILING_MS = 3_000;

/** Alert labels every dependency timeout packet carries. */
export const DEPENDENCY_TIMEOUTS_LABELS = ["dependency", "latency", "upstream_timeout"] as const;

/** Lower and upper bounds of the p95 latency multiplier over baseline. */
const LATENCY_MULTIPLIER_MIN = 4;
const LATENCY_MULTIPLIER_MAX = 8;

export function buildDependencyTimeouts({ random, packetId, window }: BuildContext): Packet {
  const errorRateBaseline = round(between(random, 0.002, 0.005), 5);
  const errorRate = round(between(random, 0.05, 0.15), 5);
  const p95Baseline = round(between(random, 380, 460), 1);
  // Draw a value just under the timeout ceiling, then clamp into the documented
  // multiplier band so the ratio to baseline holds for every seed.
  const nearCeiling = between(random, DEPENDENCY_TIMEOUTS_CEILING_MS * 0.9, DEPENDENCY_TIMEOUTS_CEILING_MS);
  const p95 = round(
    Math.min(Math.max(nearCeiling, p95Baseline * LATENCY_MULTIPLIER_MIN), p95Baseline * LATENCY_MULTIPLIER_MAX),
    1,
  );
  const burnRate = round(between(random, 1.2, 2.8), 3);
  const requestRate = round(between(random, 240, 360), 1);

  const upstreamCount = intBetween(random, 8_000, 12_000);
  const topSpans = [
    {
      name: DEPENDENCY_TIMEOUTS_UPSTREAM_SPAN,
      count: upstreamCount,
      p95_ms: round(Math.min(p95 * between(random, 0.97, 1.0), DEPENDENCY_TIMEOUTS_CEILING_MS), 1),
    },
    {
      name: "POST /checkout",
      count: intBetween(random, Math.floor(upstreamCount * 0.6), Math.floor(upstreamCount * 0.9)),
      p95_ms: round(p95 * between(random, 0.9, 0.97), 1),
    },
    {
      name: "db.query orders",
      count: intBetween(random, Math.floor(upstreamCount * 0.3), Math.floor(upstreamCount * 0.5)),
      p95_ms: round(between(random, 40, 120), 1),
    },
  ];

  const exemplarCount = intBetween(random, 1, 2);
  const exemplarTraceIds = Array.from({ length: exemplarCount }, () => hex(random, 32));

  return {
    packet_id: packetId,
    service: DEPENDENCY_TIMEOUTS_SERVICE,
    env: "prod",
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
    recent_deploy: null,
    alert_labels: [...DEPENDENCY_TIMEOUTS_LABELS],
  };
}
