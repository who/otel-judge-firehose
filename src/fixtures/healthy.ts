/**
 * The `healthy` fixture: a service comfortably inside its objective.
 *
 * Error rate sits near 0.1%, p95 latency stays within a few percent of
 * baseline, the burn rate is well under 0.5, there is no recent deploy, and
 * no alert labels fire. Top spans are empty or a single unremarkable entry so
 * the Judge has nothing to escalate.
 */

import { PACKET_SCHEMA_VERSION, type Packet } from "../packet/schema";
import type { BuildContext } from "./registry";
import { between, hex, intBetween, pick, round } from "./rng";

export const HEALTHY_SERVICE = "checkout-api";

const QUIET_SPANS = ["GET /cart", "GET /health", "db.query products"] as const;

export function buildHealthy({ random, packetId, window }: BuildContext): Packet {
  const errorRateBaseline = round(between(random, 0.0008, 0.0012), 5);
  const errorRate = round(between(random, 0.0005, 0.0015), 5);
  const p95Baseline = round(between(random, 380, 460), 1);
  const p95 = round(p95Baseline * between(random, 0.94, 1.06), 1);
  const burnRate = round(between(random, 0.1, 0.4), 3);
  const requestRate = round(between(random, 240, 360), 1);

  const spanCount = intBetween(random, 0, 1);
  const topSpans =
    spanCount === 0
      ? []
      : [
          {
            name: pick(random, QUIET_SPANS),
            count: intBetween(random, 60_000, 90_000),
            error_count: intBetween(random, 0, 5),
            p95_ms: round(between(random, 120, 260), 1),
          },
        ];

  const exemplarTraceIds = intBetween(random, 0, 1) === 0 ? [] : [hex(random, 32)];

  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: packetId,
    service: HEALTHY_SERVICE,
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
    alert_labels: [],
  };
}
