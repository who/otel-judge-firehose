/**
 * The `demo_mix` fixture: one scenario that emits a weighted blend of window
 * shapes so a demo run lands packets across the whole judgement range instead
 * of a wall of look-alike outages.
 *
 * Five profiles are drawn per packet from `DEMO_MIX_WEIGHTS`: chronic
 * client-side 4xx noise, a quiet window, a failing best-effort path, a
 * degraded core service, and a critical-path burn. Failure class and path
 * criticality are encoded only in fields the Judge already reads — the service
 * name, the span names, the alert labels, the log snippets, and the signal
 * ratios — so nothing here asks the packet contract for a criticality field.
 *
 * Two rules keep the blend honest. A quiet window is quiet: low signals, a
 * dull span or none at all, no alert labels, and no log snippets, never a
 * stream of HTTP 200 lines dressed up as evidence. And client noise never
 * carries a recent deploy or a burn label, so a chronic 4xx ratio on a
 * critical service cannot read as a release that deserves paging.
 */

import { PACKET_SCHEMA_VERSION, type Packet, type RecentDeploy, type Signals, type TopSpan } from "../packet/schema";
import { isoSeconds, type BuildContext } from "./registry";
import { between, hex, intBetween, pick, round, type RandomSource } from "./rng";

/** Path-criticality labels. A packet carries at most one of the three. */
export const CRITICAL_PATH_LABEL = "critical_path";
export const CORE_PATH_LABEL = "core_path";
export const BEST_EFFORT_LABEL = "best_effort";

/**
 * Failure-class label identifying each noisy profile. Unique per profile, so a
 * batch can be audited for weight coverage without a profile field on the wire.
 * The quiet profile deliberately has none: it carries no alert labels at all.
 */
export const CLIENT_NOISE_LABEL = "client_errors";
export const OPTIONAL_PATH_LABEL = "optional_path_degraded";
export const CORE_DEGRADED_LABEL = "core_degradation";
export const CRITICAL_BURN_LABEL = "slo_burn";

/** Services on the paying path: a failure here is revenue or access. */
export const CRITICAL_SERVICES = ["checkout-api", "payments-api", "auth-api"] as const;
/** Services users notice but can survive for a few minutes. */
export const CORE_SERVICES = ["catalog-api", "search-api", "account-api"] as const;
/** Best-effort services: failing entirely costs telemetry and relevance, not orders. */
export const OPTIONAL_SERVICES = ["tracking-collector", "analytics-ingest", "recommendations-api"] as const;

/** Client faults land on whatever a user can call directly, critical paths included. */
const CLIENT_NOISE_SERVICES = ["auth-api", "checkout-api", "catalog-api", "search-api", "account-api"] as const;
/** A quiet window is worth showing for a service whose failure would matter. */
const QUIET_SERVICES = ["checkout-api", "catalog-api", "search-api", "account-api"] as const;

/** Profile identifiers in registration order; also the weighted draw order. */
export const DEMO_MIX_PROFILE_IDS = [
  "client_noise",
  "healthy_quiet",
  "optional_path_errors",
  "core_degraded",
  "critical_burn",
] as const;

/** One of the five window shapes `demo_mix` draws from. */
export type DemoMixProfileId = (typeof DEMO_MIX_PROFILE_IDS)[number];

/**
 * Draw weights in whole percentage points, summing to
 * `DEMO_MIX_WEIGHT_TOTAL`. Integers rather than fractions on purpose: a
 * cumulative float table can round a small profile down to an interval it
 * never wins, and the whole point of the blend is that every shape shows up.
 */
export const DEMO_MIX_WEIGHTS: Readonly<Record<DemoMixProfileId, number>> = {
  client_noise: 40,
  healthy_quiet: 15,
  optional_path_errors: 15,
  core_degraded: 20,
  critical_burn: 10,
};

/** Sum the weights must reach; asserted by the fixture tests. */
export const DEMO_MIX_WEIGHT_TOTAL = 100;

const MINUTE_MS = 60 * 1000;

/** The deploy lands before the window opens, so subtract the window length first. */
const WINDOW_OFFSET_MS = 5 * MINUTE_MS;

/** A span name paired with the log line that explains it. */
interface SpanTemplate {
  readonly name: string;
  readonly snippet: string;
}

const CLIENT_NOISE_SPANS = [
  { name: "POST /v1/orders", snippet: 'HTTP 400 validation_failed: field "sku" missing' },
  { name: "GET /v1/cart", snippet: "HTTP 401 unauthorized: bearer token expired" },
  { name: "GET /v1/catalog/item", snippet: "HTTP 404 not_found: sku 8841-XL retired" },
  { name: "POST /v1/account/password", snippet: "HTTP 403 forbidden: password reset rate limited" },
] as const satisfies readonly SpanTemplate[];

const QUIET_SPANS = ["GET /v1/catalog", "GET /v1/account/profile", "GET /v1/search"] as const;

const OPTIONAL_PATH_SPANS = [
  { name: "client POST events-sink", snippet: "HTTP 503 upstream_unavailable: events-sink refused connection" },
  { name: "client GET model-scorer", snippet: "HTTP 502 bad_gateway: model-scorer returned an empty body" },
  { name: "queue publish analytics-batch", snippet: "HTTP 504 gateway_timeout: analytics-batch publish exceeded 2s" },
] as const satisfies readonly SpanTemplate[];

const CORE_DEGRADED_SPANS = [
  { name: "GET /v1/catalog/search", snippet: "HTTP 500 internal_error: search index shard unavailable" },
  { name: "db.query catalog_items", snippet: "HTTP 500 internal_error: statement timeout after 1500ms" },
  { name: "cache.get catalog_page", snippet: "HTTP 500 internal_error: cache node evicted mid-request" },
] as const satisfies readonly SpanTemplate[];

const CRITICAL_BURN_SPANS = [
  { name: "POST /v1/checkout/submit", snippet: "HTTP 500 internal_error: payment authorization call failed" },
  { name: "client POST payment-gateway", snippet: "HTTP 504 gateway_timeout: payment-gateway silent for 3000ms" },
  { name: "db.tx orders_insert", snippet: "HTTP 500 internal_error: orders insert deadlocked and rolled back" },
] as const satisfies readonly SpanTemplate[];

/** Everything a profile decides; the packet frame around it is shared. */
interface ProfileDraw {
  readonly service: string;
  readonly signals: Signals;
  readonly topSpans: TopSpan[];
  readonly alertLabels: string[];
  /** Absent for the quiet profile, which has nothing worth quoting. */
  readonly logSnippets?: string[];
  /** Absent when the window is not deploy related. */
  readonly deployMinutesAgo?: number;
}

/**
 * Criticality label for `service`, derived from the tier lists rather than
 * stored per profile, so a service cannot be described two ways.
 */
export function criticalityLabel(service: string): string {
  if ((CRITICAL_SERVICES as readonly string[]).includes(service)) {
    return CRITICAL_PATH_LABEL;
  }
  if ((CORE_SERVICES as readonly string[]).includes(service)) {
    return CORE_PATH_LABEL;
  }
  return BEST_EFFORT_LABEL;
}

/**
 * Draws a profile from `DEMO_MIX_WEIGHTS`. One integer ticket in
 * `[0, DEMO_MIX_WEIGHT_TOTAL)` is spent against the weights in order, so each
 * profile wins exactly its share of tickets and none is ever unreachable.
 */
export function pickDemoMixProfile(random: RandomSource): DemoMixProfileId {
  let ticket = intBetween(random, 0, DEMO_MIX_WEIGHT_TOTAL - 1);
  for (const id of DEMO_MIX_PROFILE_IDS) {
    ticket -= DEMO_MIX_WEIGHTS[id];
    if (ticket < 0) {
      return id;
    }
  }
  // Only reachable if the weights stop summing to the total; the last profile
  // absorbing the remainder beats throwing on a demo emit path.
  return "critical_burn";
}

/** Two distinct templates from `pool`, primary first. `pool` needs two entries. */
function drawSpanPair(random: RandomSource, pool: readonly SpanTemplate[]): SpanTemplate[] {
  const first = intBetween(random, 0, pool.length - 1);
  const second = (first + intBetween(random, 1, pool.length - 1)) % pool.length;
  return [pool[first] as SpanTemplate, pool[second] as SpanTemplate];
}

/** An error count consistent with `errorRate`, never above the span's own count. */
function errorsFor(random: RandomSource, count: number, errorRate: number, spread: number): number {
  return Math.min(count, Math.round(count * errorRate * between(random, 1 / spread, spread)));
}

function drawClientNoise(random: RandomSource): ProfileDraw {
  const service = pick(random, CLIENT_NOISE_SERVICES);
  const errorRateBaseline = round(between(random, 0.02, 0.05), 5);
  // Only a shade above baseline: bad input is the steady state here, not news.
  const errorRate = round(errorRateBaseline * between(random, 1.2, 2.5), 5);
  const p95Baseline = round(between(random, 140, 240), 1);
  const p95 = round(p95Baseline * between(random, 0.92, 1.12), 1);
  const templates = drawSpanPair(random, CLIENT_NOISE_SPANS);

  const topSpans = templates.map((template) => {
    const count = intBetween(random, 3_000, 9_000);
    return {
      name: template.name,
      count,
      error_count: errorsFor(random, count, errorRate, 1.6),
      p95_ms: round(p95 * between(random, 0.8, 1.1), 1),
    };
  });

  return {
    service,
    signals: {
      error_rate: errorRate,
      error_rate_baseline: errorRateBaseline,
      p95_latency_ms: p95,
      p95_latency_baseline_ms: p95Baseline,
      request_rate_rps: round(between(random, 400, 900), 1),
      slo_burn_rate: round(between(random, 0.3, 1.1), 3),
    },
    topSpans,
    alertLabels: [CLIENT_NOISE_LABEL, "4xx_ratio", criticalityLabel(service)],
    logSnippets: templates.map((template) => template.snippet),
  };
}

function drawHealthyQuiet(random: RandomSource): ProfileDraw {
  const service = pick(random, QUIET_SERVICES);
  const errorRateBaseline = round(between(random, 0.0008, 0.0025), 5);
  const errorRate = round(errorRateBaseline * between(random, 0.3, 1), 5);
  const p95Baseline = round(between(random, 120, 260), 1);
  const p95 = round(p95Baseline * between(random, 0.9, 1.05), 1);

  // Nothing notable happened, so there may be nothing worth listing.
  const count = intBetween(random, 40_000, 80_000);
  const topSpans =
    intBetween(random, 0, 1) === 0
      ? []
      : [
          {
            name: pick(random, QUIET_SPANS),
            count,
            error_count: errorsFor(random, count, errorRate, 1.2),
            p95_ms: round(p95 * between(random, 0.85, 1.05), 1),
          },
        ];

  return {
    service,
    signals: {
      error_rate: errorRate,
      error_rate_baseline: errorRateBaseline,
      p95_latency_ms: p95,
      p95_latency_baseline_ms: p95Baseline,
      request_rate_rps: round(between(random, 150, 400), 1),
      slo_burn_rate: round(between(random, 0.02, 0.35), 3),
    },
    topSpans,
    alertLabels: [],
  };
}

function drawOptionalPathErrors(random: RandomSource): ProfileDraw {
  const service = pick(random, OPTIONAL_SERVICES);
  const errorRateBaseline = round(between(random, 0.005, 0.02), 5);
  // A genuine 5xx failure, but of something nobody is paying for.
  const errorRate = round(between(random, 0.18, 0.45), 5);
  const p95Baseline = round(between(random, 200, 420), 1);
  const p95 = round(p95Baseline * between(random, 1.4, 3), 1);
  const templates = drawSpanPair(random, OPTIONAL_PATH_SPANS);

  const topSpans = templates.map((template) => {
    const count = intBetween(random, 800, 4_000);
    return {
      name: template.name,
      count,
      error_count: errorsFor(random, count, errorRate, 1.3),
      p95_ms: round(p95 * between(random, 0.85, 1.1), 1),
    };
  });

  return {
    service,
    signals: {
      error_rate: errorRate,
      error_rate_baseline: errorRateBaseline,
      p95_latency_ms: p95,
      p95_latency_baseline_ms: p95Baseline,
      request_rate_rps: round(between(random, 60, 220), 1),
      // A loose objective: the budget drains slowly even while the path is down.
      slo_burn_rate: round(between(random, 0.6, 2), 3),
      saturation: { queue_depth: intBetween(random, 400, 9_000) },
    },
    topSpans,
    alertLabels: [OPTIONAL_PATH_LABEL, BEST_EFFORT_LABEL, "upstream_5xx"],
    logSnippets: templates.map((template) => template.snippet),
  };
}

function drawCoreDegraded(random: RandomSource): ProfileDraw {
  const service = pick(random, CORE_SERVICES);
  const errorRateBaseline = round(between(random, 0.002, 0.006), 5);
  const errorRate = round(errorRateBaseline * between(random, 15, 40), 5);
  const p95Baseline = round(between(random, 260, 420), 1);
  const p95 = round(p95Baseline * between(random, 2, 4), 1);
  const templates = drawSpanPair(random, CORE_DEGRADED_SPANS);

  const topSpans = templates.map((template) => {
    const count = intBetween(random, 2_000, 7_000);
    return {
      name: template.name,
      count,
      error_count: errorsFor(random, count, errorRate, 1.4),
      p95_ms: round(p95 * between(random, 0.7, 1.05), 1),
    };
  });

  const draw: ProfileDraw = {
    service,
    signals: {
      error_rate: errorRate,
      error_rate_baseline: errorRateBaseline,
      p95_latency_ms: p95,
      p95_latency_baseline_ms: p95Baseline,
      request_rate_rps: round(between(random, 180, 420), 1),
      slo_burn_rate: round(between(random, 2, 5.5), 3),
      saturation: {
        cpu_pct: round(between(random, 55, 85), 1),
        mem_pct: round(between(random, 50, 80), 1),
      },
    },
    topSpans,
    alertLabels: [CORE_DEGRADED_LABEL, CORE_PATH_LABEL, "latency_regression"],
    logSnippets: templates.map((template) => template.snippet),
  };

  // Half of these follow a release, so the board sees both a deploy-shaped
  // core regression and one with no release to blame.
  return intBetween(random, 0, 1) === 1 ? { ...draw, deployMinutesAgo: intBetween(random, 4, 25) } : draw;
}

function drawCriticalBurn(random: RandomSource): ProfileDraw {
  const service = pick(random, CRITICAL_SERVICES);
  const errorRateBaseline = round(between(random, 0.001, 0.004), 5);
  const errorRate = round(between(random, 0.25, 0.6), 5);
  const p95Baseline = round(between(random, 320, 480), 1);
  const p95 = round(p95Baseline * between(random, 3, 6), 1);
  const templates = drawSpanPair(random, CRITICAL_BURN_SPANS);

  const topSpans = templates.map((template) => {
    const count = intBetween(random, 5_000, 14_000);
    return {
      name: template.name,
      count,
      error_count: errorsFor(random, count, errorRate, 1.2),
      p95_ms: round(p95 * between(random, 0.8, 1.05), 1),
    };
  });

  return {
    service,
    signals: {
      error_rate: errorRate,
      error_rate_baseline: errorRateBaseline,
      p95_latency_ms: p95,
      p95_latency_baseline_ms: p95Baseline,
      request_rate_rps: round(between(random, 260, 520), 1),
      slo_burn_rate: round(between(random, 6, 22), 3),
      saturation: {
        cpu_pct: round(between(random, 70, 95), 1),
        queue_depth: intBetween(random, 2_000, 20_000),
      },
    },
    topSpans,
    alertLabels: [CRITICAL_BURN_LABEL, CRITICAL_PATH_LABEL, "paging", "error_budget"],
    logSnippets: templates.map((template) => template.snippet),
    // This is the window a responder is paged for, so it always names the
    // release behind it: the rollback candidate is the first thing they want
    // and its absence would read as an unexplained burn.
    deployMinutesAgo: intBetween(random, 2, 18),
  };
}

const PROFILE_DRAWS: Readonly<Record<DemoMixProfileId, (random: RandomSource) => ProfileDraw>> = {
  client_noise: drawClientNoise,
  healthy_quiet: drawHealthyQuiet,
  optional_path_errors: drawOptionalPathErrors,
  core_degraded: drawCoreDegraded,
  critical_burn: drawCriticalBurn,
};

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Judge-shaped recent deploy: version, timestamp, and minutes elapsed. No sha. */
function buildRecentDeploy(nowMs: number, random: RandomSource, minutesAgo: number): RecentDeploy {
  const deployedAtMs = nowMs - WINDOW_OFFSET_MS - minutesAgo * MINUTE_MS;
  const deployDate = new Date(nowMs);
  const version = `${deployDate.getUTCFullYear()}.${pad2(deployDate.getUTCMonth() + 1)}.${pad2(
    deployDate.getUTCDate(),
  )}-${intBetween(random, 1, 9)}`;

  return {
    version,
    deployed_at: isoSeconds(deployedAtMs),
    minutes_ago: Math.max(0, Math.round((nowMs - deployedAtMs) / MINUTE_MS)),
  };
}

/** Builds one packet for an explicitly chosen profile; the tests' way in. */
export function buildDemoMixProfile(profile: DemoMixProfileId, context: BuildContext): Packet {
  const { random, packetId, window, nowMs } = context;
  const draw = PROFILE_DRAWS[profile](random);

  // A quiet window may have no exemplar worth keeping; a failing one always does.
  const traceCount = draw.alertLabels.length === 0 ? intBetween(random, 0, 1) : intBetween(random, 1, 3);
  const exemplarTraceIds: string[] = [];
  for (let index = 0; index < traceCount; index += 1) {
    exemplarTraceIds.push(hex(random, 32));
  }

  return {
    schema_version: PACKET_SCHEMA_VERSION,
    packet_id: packetId,
    service: draw.service,
    env: "prod",
    window,
    signals: draw.signals,
    top_spans: draw.topSpans,
    exemplar_trace_ids: exemplarTraceIds,
    alert_labels: draw.alertLabels,
    ...(draw.deployMinutesAgo === undefined
      ? {}
      : { recent_deploy: buildRecentDeploy(nowMs, random, draw.deployMinutesAgo) }),
    ...(draw.logSnippets === undefined ? {} : { log_snippets: draw.logSnippets }),
  };
}

/** Registry entry point: draws a profile by weight, then builds its packet. */
export function buildDemoMix(context: BuildContext): Packet {
  return buildDemoMixProfile(pickDemoMixProfile(context.random), context);
}
