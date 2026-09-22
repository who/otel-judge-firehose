/**
 * POST /emit: generate, validate, and forward fixture packets to the Judge.
 *
 * The demo posts a scenario and a count and receives a JSON summary of what
 * was forwarded. The Judge ingest token stays in this Worker; it is never
 * echoed into a response. A dry run generates and validates but posts
 * nothing, which lets the demo prove its wiring without touching the Judge.
 */

import { z } from "zod";

import { ConfigError, resolveConfig, type FirehoseConfig, type FirehoseEnv } from "../config";
import { UnknownScenarioError, buildScenarioPackets } from "../fixtures/registry";
import type { Packet } from "../packet/schema";
import { PacketValidationError, formatIssuePath, validatePackets } from "../packet/validate";
import { postPackets, type JudgeClientDeps, type JudgePostResult } from "./judgeClient";

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
}

/** Injected hooks: the Judge client's fetch and sleep, plus the packet generator. */
export interface EmitDeps extends Partial<JudgeClientDeps> {
  /** Defaults to `buildScenarioPackets`; injectable so a generator fault can be exercised. */
  readonly buildPackets?: typeof buildScenarioPackets;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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
  let config: FirehoseConfig;
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
  const { scenario, count, seed, dryRun } = parsed.data;
  const { buildPackets = buildScenarioPackets, ...clientDeps } = deps;

  let packets: Packet[];
  try {
    packets = validatePackets(buildPackets(scenario, count, seed === undefined ? {} : { seed }));
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
  const results = dryRun ? [] : await postPackets(config, packets, clientDeps);
  const accepted = results.filter((result) => result.accepted).length;

  const summary: EmitSummary = {
    ok: true,
    scenario,
    requested: count,
    generated: packets.length,
    accepted,
    dryRun,
    packetIds,
    results,
  };
  return jsonResponse(summary, 200);
}
