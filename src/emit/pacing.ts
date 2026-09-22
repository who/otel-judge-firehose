/**
 * Bounded pacing for an emit run.
 *
 * `resolvePacing` turns the optional request fields into a fully populated
 * `Pacing`, and `pacedEmit` slices packets into bursts, sleeping between
 * bursts and stopping early once the wall-clock ceiling would be crossed.
 * Runs are stateless and live inside one Worker request; a paused demo
 * simply stops issuing emit requests.
 */

import type { Packet } from "../packet/schema";
import type { JudgePostResult } from "./judgeClient";

/** Longest permitted gap between bursts, in milliseconds. */
export const MAX_INTERVAL_MS = 2000;

/** Largest permitted burst when the caller sets one explicitly. */
export const MAX_BURST = 10;

/** Hard wall-clock ceiling for one paced run, in milliseconds. */
export const MAX_RUN_MS = 20000;

/** Fully resolved pacing for one run. */
export interface Pacing {
  /** Gap between bursts; zero means every burst is sent back to back. */
  readonly intervalMs: number;
  /** Packets per burst; never less than one. */
  readonly burst: number;
  /** Wall-clock ceiling the run must not exceed. */
  readonly maxRunMs: number;
}

/** Caller-supplied pacing fields; `count` is the packet total the burst defaults to. */
export interface PacingInput {
  readonly intervalMs?: number | undefined;
  readonly burst?: number | undefined;
  readonly count: number;
}

/** Injected clock hooks. Defaults to the Worker globals. */
export interface PacingDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** Outcome of a paced run. */
export interface PacedEmitResult {
  /** One result per packet that was handed to `send`, in order. */
  readonly results: JudgePostResult[];
  /** Number of bursts actually sent. */
  readonly bursts: number;
  /** True when the wall-clock ceiling stopped the run before every burst was sent. */
  readonly truncated: boolean;
  /** Milliseconds from the first burst to the last result. */
  readonly elapsedMs: number;
}

/** Sends one burst and reports one result per packet in it. */
export type BurstSender = (burst: readonly Packet[]) => Promise<JudgePostResult[]>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_DEPS: PacingDeps = { sleep: defaultSleep, now: () => Date.now() };

/** Clamps a number into an inclusive integer range, treating a non-finite value as the fallback. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Applies the documented defaults and bounds. An omitted interval is zero and
 * an omitted burst is the whole count, which reproduces the unpaced run; an
 * explicit burst is capped at `MAX_BURST`.
 */
export function resolvePacing(input: PacingInput): Pacing {
  const count = Math.max(1, Math.floor(input.count));
  const intervalMs = clampInt(input.intervalMs, 0, 0, MAX_INTERVAL_MS);
  const burst = input.burst === undefined ? count : clampInt(input.burst, count, 1, MAX_BURST);
  return { intervalMs, burst, maxRunMs: MAX_RUN_MS };
}

function describeRejection(reason: unknown): string {
  return reason instanceof Error ? `burst failed: ${reason.message}` : "burst failed";
}

/**
 * Sends `packets` in bursts of `pacing.burst`, sleeping `pacing.intervalMs`
 * before every burst except the first. Before each sleep the elapsed time is
 * checked against `pacing.maxRunMs`; when the next gap would cross the
 * ceiling the run stops and `truncated` is set, keeping the results already
 * collected. A rejected `send` records a failed result for each packet in
 * that burst and ends the run so nothing is left hanging.
 */
export async function pacedEmit(
  packets: readonly Packet[],
  pacing: Pacing,
  send: BurstSender,
  deps: Partial<PacingDeps> = {},
): Promise<PacedEmitResult> {
  const { sleep, now } = { ...DEFAULT_DEPS, ...deps };
  const start = now();
  const results: JudgePostResult[] = [];
  let bursts = 0;
  let truncated = false;

  for (let offset = 0; offset < packets.length; offset += pacing.burst) {
    if (offset > 0) {
      if (now() - start + pacing.intervalMs > pacing.maxRunMs) {
        truncated = true;
        break;
      }
      if (pacing.intervalMs > 0) {
        await sleep(pacing.intervalMs);
      }
    }

    const burst = packets.slice(offset, offset + pacing.burst);
    bursts += 1;
    try {
      results.push(...(await send(burst)));
    } catch (reason) {
      const error = describeRejection(reason);
      for (const packet of burst) {
        results.push({ packetId: packet.packet_id, accepted: false, attempts: 0, error });
      }
      break;
    }
  }

  return { results, bursts, truncated, elapsedMs: Math.max(0, now() - start) };
}
