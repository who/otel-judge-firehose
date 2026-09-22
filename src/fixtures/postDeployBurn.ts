/**
 * The `post_deploy_burn` fixture: a regression minutes after a release.
 *
 * Error rate runs ten to thirty times baseline, p95 latency two to four
 * times baseline, and the burn rate is above 4, so the error budget is being
 * consumed far faster than allowed. `recent_deploy` is populated with a version
 * deployed shortly before the window (Judge shape: version, deployed_at,
 * minutes_ago; no sha), and the alert labels name both the burn and the deploy
 * window so the Judge can tie them together.
 */

import { PACKET_SCHEMA_VERSION, type Packet } from "../packet/schema";
import { isoSeconds, type BuildContext } from "./registry";
import { between, hex, intBetween, round } from "./rng";

export const POST_DEPLOY_BURN_SERVICE = "checkout-api";

/** Alert labels every post-deploy burn packet carries. */
export const POST_DEPLOY_BURN_LABELS = ["slo_burn", "deploy_window"] as const;

const MINUTE_MS = 60 * 1000;

/** The deploy lands before the window opens, so subtract the window length first. */
const WINDOW_OFFSET_MS = 5 * MINUTE_MS;

export function buildPostDeployBurn({ random, packetId, window, nowMs }: BuildContext): Packet {
  const errorRateBaseline = round(between(random, 0.002, 0.005), 5);
  const errorRate = round(errorRateBaseline * between(random, 10, 30), 5);
  const p95Baseline = round(between(random, 380, 460), 1);
  const p95 = round(p95Baseline * between(random, 2, 4), 1);
  const burnRate = round(between(random, 4.5, 20), 3);
  const requestRate = round(between(random, 240, 360), 1);

  const hotCount = intBetween(random, 7_000, 12_000);
  const topSpans = [
    {
      name: "POST /checkout",
      count: hotCount,
      error_count: intBetween(random, Math.floor(hotCount * 0.08), Math.floor(hotCount * 0.25)),
      p95_ms: round(p95 * between(random, 0.95, 1.05), 1),
    },
    {
      name: "db.query orders",
      count: intBetween(random, Math.floor(hotCount * 0.8), hotCount),
      error_count: intBetween(random, Math.floor(hotCount * 0.05), Math.floor(hotCount * 0.2)),
      p95_ms: round(p95 * between(random, 0.5, 0.8), 1),
    },
  ];

  const deployedMinutesAgo = intBetween(random, 2, 8);
  const deployedAtMs = nowMs - WINDOW_OFFSET_MS - deployedMinutesAgo * MINUTE_MS;
  const deployDate = new Date(nowMs);
  const version = `${deployDate.getUTCFullYear()}.${pad2(deployDate.getUTCMonth() + 1)}.${pad2(
    deployDate.getUTCDate(),
  )}-${intBetween(random, 1, 9)}`;

  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: packetId,
    service: POST_DEPLOY_BURN_SERVICE,
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
    exemplar_trace_ids: [hex(random, 32), hex(random, 32)],
    recent_deploy: {
      version,
      deployed_at: isoSeconds(deployedAtMs),
      minutes_ago: Math.max(0, Math.round((nowMs - deployedAtMs) / MINUTE_MS)),
    },
    alert_labels: [...POST_DEPLOY_BURN_LABELS],
  };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
