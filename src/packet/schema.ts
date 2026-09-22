/**
 * Normalized packet contract for the Judge firehose.
 *
 * `PacketSchema` is the single source of truth for the payload this producer
 * emits. Every generator (fixtures, chaos templates, Workers AI) is typed
 * against `Packet`, and `validatePacket()` (a sibling task) parses candidates
 * with this schema before anything is posted to the Judge.
 *
 * Field names are snake_case to match the sibling Judge PRD exactly. Unknown
 * keys are stripped rather than rejected so a Judge-side addition does not
 * break this producer; any field added here later must be optional so an
 * older Judge deployment keeps parsing.
 */

import { z } from "zod";

/**
 * Version of the packet contract. Bump when a field is added, removed, or has
 * its meaning changed so the Judge can detect a mismatch.
 */
export const PACKET_SCHEMA_VERSION = "1" as const;

/** Deployment environments the Judge distinguishes. Closed set by design. */
export const PACKET_ENVS = ["prod", "staging", "dev"] as const;

/**
 * Shape of a minted packet identifier:
 * `pkt_<scenario>_<epochMillis>_<six base36 characters>`, for example
 * `pkt_healthy_1758480000000_k3f9zq`. The scenario segment is lowercase
 * `[a-z0-9_]`. Keep in sync with `mintPacketId()` in `src/packet/id.ts`.
 */
export const PACKET_ID_PATTERN = /^pkt_[a-z0-9_]+_[0-9]+_[a-z0-9]{6}$/;

/** W3C / OpenTelemetry trace id: 16 bytes rendered as 32 hex characters. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** Upper bounds that catch unit mistakes (e.g. millis passed as seconds). */
const MAX_LATENCY_MS = 3_600_000; // one hour
const MAX_SLO_BURN_RATE = 10_000;
const MAX_REQUEST_RATE = 1_000_000; // requests per second

const nonEmptyString = z.string().trim().min(1);

/** ISO 8601 UTC timestamp (`Z` suffix required; numeric offsets rejected). */
const isoUtcTimestamp = z.iso.datetime({
  error: "must be an ISO 8601 UTC timestamp such as 2026-09-21T12:00:00Z",
});

const unitInterval = z.number().min(0).max(1);
const nonNegativeMillis = z.number().min(0).max(MAX_LATENCY_MS);

/** Aggregate health signals for the observation window. */
export const SignalsSchema = z.object({
  /** Fraction of requests that failed in the window, 0 to 1. */
  error_rate: unitInterval,
  /** Fraction of requests that failed in the baseline period, 0 to 1. */
  error_rate_baseline: unitInterval,
  /** 95th percentile latency in the window, milliseconds. */
  p95_latency_ms: nonNegativeMillis,
  /** 95th percentile latency in the baseline period, milliseconds. */
  p95_latency_baseline_ms: nonNegativeMillis,
  /** SLO error budget burn rate; 1 means burning exactly at budget. */
  slo_burn_rate: z.number().min(0).max(MAX_SLO_BURN_RATE),
  /** Requests per second observed in the window. */
  request_rate: z.number().min(0).max(MAX_REQUEST_RATE),
});

/** One notable span aggregated over the window. */
export const TopSpanSchema = z.object({
  name: nonEmptyString,
  count: z.number().int().min(0),
  p95_ms: nonNegativeMillis,
});

/** Most recent deploy of the service before or during the window. */
export const RecentDeploySchema = z.object({
  sha: nonEmptyString,
  version: nonEmptyString,
  deployed_at: isoUtcTimestamp,
});

/** Half-open observation window; `end` must be strictly after `start`. */
export const WindowSchema = z
  .object({
    start: isoUtcTimestamp,
    end: isoUtcTimestamp,
  })
  .refine(
    ({ start, end }) => {
      // A malformed timestamp is already reported by the field check above;
      // do not pile a misleading ordering error on top of it. `Date.parse`
      // alone is not enough because V8 accepts many non-ISO strings.
      if (!isoUtcTimestamp.safeParse(start).success || !isoUtcTimestamp.safeParse(end).success) {
        return true;
      }
      return Date.parse(end) > Date.parse(start);
    },
    { message: "window end must be after window start", path: ["end"] },
  );

/** The normalized packet this producer posts to the Judge firehose. */
export const PacketSchema = z.object({
  /** Unique per POST; see `PACKET_ID_PATTERN`. */
  packet_id: z.string().regex(PACKET_ID_PATTERN, {
    message: "must match pkt_<scenario>_<epochMillis>_<6 base36 chars>",
  }),
  /** Logical service name the signals describe. */
  service: nonEmptyString,
  env: z.enum(PACKET_ENVS),
  window: WindowSchema,
  signals: SignalsSchema,
  /** May be empty: a healthy window has no notable spans. */
  top_spans: z.array(TopSpanSchema),
  exemplar_trace_ids: z.array(
    z.string().regex(TRACE_ID_PATTERN, { message: "must be a 32-character hex trace id" }),
  ),
  /**
   * Required but nullable: `null` states "no recent deploy" explicitly, which
   * is distinct from the generator forgetting the field.
   */
  recent_deploy: RecentDeploySchema.nullable(),
  alert_labels: z.array(z.string()),
  log_snippets: z.array(z.string()).optional(),
});

export type PacketEnv = (typeof PACKET_ENVS)[number];
export type Signals = z.infer<typeof SignalsSchema>;
export type TopSpan = z.infer<typeof TopSpanSchema>;
export type RecentDeploy = z.infer<typeof RecentDeploySchema>;
export type PacketWindow = z.infer<typeof WindowSchema>;
/** Parsed, typed packet. */
export type Packet = z.infer<typeof PacketSchema>;
/** Shape accepted by `PacketSchema.parse` before defaults and stripping. */
export type PacketInput = z.input<typeof PacketSchema>;
