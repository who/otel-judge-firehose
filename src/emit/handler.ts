/**
 * POST /emit: generate, validate, and forward fixture packets to the Judge.
 *
 * The demo posts a scenario and a count and receives a JSON summary of what
 * was forwarded. The Judge ingest token stays in this Worker; it is never
 * echoed into a response. A dry run generates and validates, returns the packets in the response, and
 * posts nothing — Firehose can be tested with no Judge URL at all.
 * Optional `intervalMs` and `burst` fields pace the run through `pacedEmit`
 * so a demo board fills in visibly, bounded by a fixed wall-clock ceiling.
 * An optional `llm` flag sends the chaos scenario's first burst through
 * Workers AI via `buildLlmChaosPackets`, which falls back to the template
 * packet, never to an invalid one.
 */

import { z } from "zod";

import { buildLlmChaosPackets } from "../chaos/llm";
import { ConfigError, resolveConfig, type FirehoseConfig, type FirehoseEnv } from "../config";
import { CHAOS_SCENARIO_ID, UnknownScenarioError, buildScenarioPackets, resolveScenarioId } from "../fixtures/registry";
import type { Packet } from "../packet/schema";
import { PacketValidationError, formatIssuePath, validatePackets } from "../packet/validate";
import { postPackets, type JudgeClientDeps, type JudgePostResult } from "./judgeClient";
import { MAX_BURST, MAX_INTERVAL_MS, pacedEmit, resolvePacing, type PacingDeps } from "./pacing";

/**
 * Upper bound on packets per emit request. A Worker request has a wall-clock
 * budget and packets are posted one per request, so a demo never needs more.
 */
export const MAX_EMIT_COUNT = 50;

/** Request body accepted by `handleEmit()`. Unknown keys are ignored. */
export const EmitRequestSchema = z.object({
  /** Registered scenario identifier, for example `healthy`. */
  scenario: z.string().min(1, "scenario must be a non-empty string"),
  /** Packets to generate; defaults to the single-shot emit. */
  count: z.number().int().min(1).max(MAX_EMIT_COUNT).default(1),
  /** Optional seed for byte-reproducible output. */
  seed: z.string().min(1, "seed must be a non-empty string").optional(),
  /** When true, generate and validate but post nothing. */
  dryRun: z.boolean().default(false),
  /** Gap between bursts in milliseconds; omitted means no pacing. */
  intervalMs: z.number().int().min(0).max(MAX_INTERVAL_MS).optional(),
  /** Packets per burst; omitted means the whole count in one burst. */
  burst: z.number().int().min(1).max(MAX_BURST).optional(),
  /**
   * When true and the scenario is `chaos`, Workers AI writes the descriptive
   * fields of the first burst. Omitted means false: the template path, and no
   * model call. Ignored for every other scenario.
   */
  llm: z.boolean().optional(),
});

export type EmitRequest = z.infer<typeof EmitRequestSchema>;

/** HTTP 200 body of a successful emit, dry run included. */
export interface EmitSummary {
  readonly ok: true;
  readonly scenario: string;
  /** Count the caller asked for. */
  readonly requested: number;
  /** Packets generated and validated. */
  readonly generated: number;
  /** Packets the Judge accepted; zero for a dry run. */
  readonly accepted: number;
  readonly dryRun: boolean;
  /** Identifiers of every generated packet, in order. */
  readonly packetIds: readonly string[];
  /** One result per posted packet; empty for a dry run. */
  readonly results: readonly JudgePostResult[];
  /**
   * Full validated packets. Present only on `dryRun: true` so Firehose can be
   * exercised with no Judge URL and no outbound POST.
   */
  readonly packets?: readonly Packet[];
  /** True when the wall-clock ceiling cut the run short; the counts describe what was sent. */
  readonly truncated: boolean;
  /** Milliseconds from the first burst to the last result; zero for a dry run. */
  readonly elapsedMs: number;
  /**
   * Present only when `llm` was set and at least one packet fell back to its
   * template, naming the first reason seen. Never carries model output.
   */
  readonly fallbackReason?: string;
}

/**
 * Injected hooks: the Judge client's fetch and sleep, the pacer's clock, and
 * the packet generator. One `sleep` serves both retry backoff and pacing.
 */
export interface EmitDeps extends Partial<JudgeClientDeps> {
  /** Defaults to `buildScenarioPackets`; injectable so a generator fault can be exercised. */
  readonly buildPackets?: typeof buildScenarioPackets;
  /** Defaults to `Date.now`; injectable so the wall-clock ceiling can be exercised. */
  readonly now?: PacingDeps["now"];
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Forwards only the clock hooks that were actually injected so the pacer keeps its defaults. */
function pacingDeps(
  sleep: PacingDeps["sleep"] | undefined,
  now: PacingDeps["now"] | undefined,
): Partial<PacingDeps> {
  return {
    ...(sleep === undefined ? {} : { sleep }),
    ...(now === undefined ? {} : { now }),
  };
}

/**
 * Handles one emit request. Maps a missing or malformed ingest configuration
 * to HTTP 503, a bad body or unknown scenario to HTTP 400, and a generator
 * that produced an invalid packet to HTTP 500 without the packet payload.
 * A per-packet Judge failure is still HTTP 200 with a lower accepted count.
 */
export async function handleEmit(
  request: Request,
  env: FirehoseEnv,
  deps: EmitDeps = {},
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "invalid_json", message: "request body must be a JSON object" },
      400,
    );
  }

  const parsed = EmitRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          field: formatIssuePath(issue.path),
          message: issue.message,
        })),
      },
      400,
    );
  }
  const { scenario, count, seed, dryRun, intervalMs, burst, llm } = parsed.data;
  const resolvedScenario = resolveScenarioId(scenario);
  const { buildPackets = buildScenarioPackets, now, ...clientDeps } = deps;
  const pacing = resolvePacing({ intervalMs, burst, count });

  // Dry run is Firehose-only: generate + validate, no Judge URL, no POST.
  let config: FirehoseConfig | undefined;
  if (!dryRun) {
    try {
      config = resolveConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) {
        return jsonResponse(
          {
            ok: false,
            error: "judge_not_configured",
            variable: error.variable,
            message: `${error.variable} is missing or invalid; the Worker is deployed but not wired to the Judge`,
          },
          503,
        );
      }
      throw error;
    }
  }

  let packets: Packet[];
  let fallbackReason: string | undefined;
  try {
    let candidates: readonly unknown[] = buildPackets(resolvedScenario, count, seed === undefined ? {} : { seed });
    if (llm === true && resolvedScenario === CHAOS_SCENARIO_ID) {
      // Model latency stays out of the paced part of the run: only the first
      // burst is model-written, and every result is validated again below.
      const rewritten = await buildLlmChaosPackets(validatePackets(candidates), pacing.burst, env.AI);
      candidates = rewritten.packets;
      fallbackReason = rewritten.fallbackReason;
    }
    packets = validatePackets(candidates);
  } catch (error) {
    if (error instanceof UnknownScenarioError) {
      return jsonResponse(
        { ok: false, error: "unknown_scenario", field: "scenario", message: error.message, known: error.known },
        400,
      );
    }
    if (error instanceof PacketValidationError) {
      return jsonResponse(
        { ok: false, error: "packet_validation_failed", message: error.message, details: error.details },
        500,
      );
    }
    throw error;
  }

  const packetIds = packets.map((packet) => packet.packet_id);
  if (dryRun) {
    const summary: EmitSummary = {
      ok: true,
      scenario,
      requested: count,
      generated: packets.length,
      accepted: 0,
      dryRun: true,
      packetIds,
      results: [],
      packets,
      truncated: false,
      elapsedMs: 0,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    };
    return jsonResponse(summary, 200);
  }

  const run = await pacedEmit(
    packets,
    pacing,
    (slice) => postPackets(config as FirehoseConfig, slice, clientDeps),
    pacingDeps(clientDeps.sleep, now),
  );
  const { results, truncated, elapsedMs } = run;
  const accepted = results.filter((result) => result.accepted).length;

  const summary: EmitSummary = {
    ok: true,
    scenario,
    requested: count,
    generated: packets.length,
    accepted,
    dryRun: false,
    packetIds,
    results,
    truncated,
    elapsedMs,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  };
  return jsonResponse(summary, 200);
}
