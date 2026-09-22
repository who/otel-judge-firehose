/**
 * Scenario registry for the deterministic fixture library (PRD FR1).
 *
 * A `ScenarioBuilder` is a pure function from a `BuildContext` to one
 * `Packet`. The registry, not the builder, mints the packet identifier and
 * computes the observation window, so no scenario can diverge on either.
 * Every packet a builder returns passes `validatePackets()` before it leaves
 * `buildScenarioPackets()`.
 *
 * Scenario identifiers are a contract with the demo Emit control and are
 * fixed: healthy, post_deploy_burn, dependency_timeouts, noise_storm, and
 * chaos. Adding a scenario means adding an entry to `SCENARIOS`; the
 * interface does not change.
 */

import { buildChaosPacket } from "../chaos/template";
import { mintPacketId } from "../packet/id";
import type { Packet, PacketWindow } from "../packet/schema";
import { validatePackets } from "../packet/validate";
import { buildDependencyTimeouts } from "./dependencyTimeouts";
import { buildHealthy } from "./healthy";
import { buildNoiseStorm } from "./noiseStorm";
import { buildPostDeployBurn } from "./postDeployBurn";
import { createSeededRng, freshSeed, type RandomSource } from "./rng";

/** Length of every fixture observation window. */
export const WINDOW_MS = 5 * 60 * 1000;

/**
 * Clock value used when a seed is supplied but no explicit `now` is: pinning
 * the clock is what makes seeded output fully reproducible. 2026-09-21T12:00:00Z.
 */
export const SEEDED_CLOCK_EPOCH_MS = Date.UTC(2026, 8, 21, 12, 0, 0);

/** Everything a builder may depend on. Builders must not read any other clock or random source. */
export interface BuildContext {
  /** Registered scenario identifier being built. */
  readonly scenario: string;
  /** Zero-based position of this packet in the requested batch. */
  readonly index: number;
  /** Total packets requested in this batch. */
  readonly count: number;
  /** Millisecond clock value the window ends at. */
  readonly nowMs: number;
  /** Uniform `[0, 1)` source; seeded when the caller supplied a seed. */
  readonly random: RandomSource;
  /** Identifier minted by the registry for this packet. */
  readonly packetId: string;
  /** Five-minute window ending at `nowMs`, computed by the registry. */
  readonly window: PacketWindow;
}

/** Pure function producing one packet for a context. */
export type ScenarioBuilder = (context: BuildContext) => Packet;

/** A registered scenario: stable id, human description, and its builder. */
export interface ScenarioDefinition {
  readonly id: string;
  readonly description: string;
  readonly build: ScenarioBuilder;
}

/** Entry shape returned by `listScenarios()` and served by the listing route. */
export interface ScenarioSummary {
  readonly id: string;
  readonly description: string;
}

/** Options for `buildScenarioPackets()`. */
export interface BuildOptions {
  /**
   * When present, drives every random draw and pins the clock (to `now` or
   * `SEEDED_CLOCK_EPOCH_MS`), so output is byte-identical across calls.
   */
  readonly seed?: string;
  /** Millisecond clock override. Defaults to the live clock, or the pinned epoch when seeded. */
  readonly now?: number;
}

/** Raised for a scenario identifier that is not registered; the route maps it to HTTP 400. */
export class UnknownScenarioError extends Error {
  readonly scenarioId: string;
  readonly known: readonly string[];

  constructor(scenarioId: string, known: readonly string[]) {
    super(`unknown scenario ${JSON.stringify(scenarioId)}; known scenarios: ${known.join(", ")}`);
    this.name = "UnknownScenarioError";
    this.scenarioId = scenarioId;
    this.known = known;
  }
}

/** Registered scenarios in listing order. */
export const SCENARIOS: Readonly<Record<string, ScenarioDefinition>> = {
  healthy: {
    id: "healthy",
    description:
      "Service inside its objective: error rate near 0.1%, latency at baseline, burn rate below 0.5, no recent deploy.",
    build: buildHealthy,
  },
  post_deploy_burn: {
    id: "post_deploy_burn",
    description:
      "Regression minutes after a release: error rate 10-30x baseline, p95 latency 2-4x baseline, burn rate above 4, populated recent deploy.",
    build: buildPostDeployBurn,
  },
  dependency_timeouts: {
    id: "dependency_timeouts",
    description:
      "Upstream dependency timing out while the service is healthy: p95 latency 4-8x baseline near a 3s timeout ceiling, error rate 5-15%, burn rate 1-3, no recent deploy, upstream client span leading.",
    build: buildDependencyTimeouts,
  },
  noise_storm: {
    id: "noise_storm",
    description:
      "Alert noise, not an incident: error rate at or below baseline, latency within 10% of baseline, burn rate below 0.3, no recent deploy, many low-count spans and a long list of flapping labels.",
    build: buildNoiseStorm,
  },
  chaos: {
    id: "chaos",
    description:
      "Randomized: seeded template draws the service, environment, signal profile, span mix, and alert labels afresh per packet; about one in four carries a recent deploy. Reproducible with a seed.",
    build: buildChaosPacket,
  },
};

/** Stable id and description of every registered scenario, in registration order. */
export function listScenarios(): ScenarioSummary[] {
  return Object.values(SCENARIOS).map(({ id, description }) => ({ id, description }));
}

/** Renders a millisecond clock value as an ISO 8601 UTC timestamp without fractional seconds. */
export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

function resolveScenario(id: string): ScenarioDefinition {
  const definition = Object.hasOwn(SCENARIOS, id) ? SCENARIOS[id] : undefined;
  if (definition === undefined) {
    throw new UnknownScenarioError(id, Object.keys(SCENARIOS));
  }
  return definition;
}

/**
 * Builds `count` schema-valid packets for the scenario `id`.
 *
 * With a seed, every draw comes from `createSeededRng(seed)` and the clock is
 * pinned, so the same seed and count always produce identical packets,
 * identifiers included. Without one, the live clock and a fresh seed are
 * used. A count of zero yields an empty array. The registry accepts any
 * non-negative integer; the emit ceiling is the emit handler's concern.
 */
export function buildScenarioPackets(id: string, count: number, options: BuildOptions = {}): Packet[] {
  const definition = resolveScenario(id);
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${String(count)}`);
  }

  const seeded = options.seed !== undefined;
  const random = createSeededRng(seeded ? (options.seed as string) : freshSeed());
  const nowMs = options.now ?? (seeded ? SEEDED_CLOCK_EPOCH_MS : Date.now());
  const window: PacketWindow = { start: isoSeconds(nowMs - WINDOW_MS), end: isoSeconds(nowMs) };
  const minted = new Set<string>();
  const packets: Packet[] = [];

  for (let index = 0; index < count; index += 1) {
    const packetId = mintUnique(definition.id, nowMs, random, minted);
    packets.push(definition.build({ scenario: definition.id, index, count, nowMs, random, packetId, window }));
  }

  return validatePackets(packets);
}

/**
 * Mints an identifier not yet used in this batch. Packets in one batch share
 * a millisecond, so distinctness rests on the suffix; a collision is
 * astronomically unlikely but a redraw costs nothing and makes it impossible.
 */
function mintUnique(scenario: string, nowMs: number, random: RandomSource, minted: Set<string>): string {
  const now = new Date(nowMs);
  let id = mintPacketId(scenario, now, random);
  while (minted.has(id)) {
    id = mintPacketId(scenario, now, random);
  }
  minted.add(id);
  return id;
}
