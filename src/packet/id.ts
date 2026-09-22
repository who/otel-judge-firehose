/**
 * Packet identifier minting.
 *
 * Every packet this producer posts carries a unique `packet_id` (PRD FR3).
 * The format is `pkt_<scenario>_<epochMillis>_<six base36 characters>`, for
 * example `pkt_healthy_1758480000000_k3f9zq`:
 *
 * - the scenario segment keeps demo logs readable,
 * - the millisecond timestamp makes ordering obvious,
 * - the random suffix makes collisions within one millisecond effectively
 *   impossible.
 *
 * The shape must stay consistent with `PACKET_ID_PATTERN` in
 * `src/packet/schema.ts`; change both in the same commit.
 *
 * Deduplication against previously emitted identifiers is deliberately not
 * done here: the Judge owns dedupe per its own PRD.
 */

/** Prefix shared by every minted identifier. */
export const PACKET_ID_PREFIX = "pkt";

/** Length of the random suffix, in base36 characters. */
export const PACKET_ID_SUFFIX_LENGTH = 6;

/** Scenario segment used when the caller's scenario sanitizes to nothing. */
export const FALLBACK_SCENARIO_SEGMENT = "unknown";

const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Largest byte value that maps onto the alphabet without modulo bias:
 * 36 * 7 = 252, so bytes 252..255 are discarded and redrawn.
 */
const UNBIASED_BYTE_LIMIT = BASE36_ALPHABET.length * Math.floor(256 / BASE36_ALPHABET.length);

/**
 * Lowercases the scenario and replaces every character outside `a-z`, `0-9`,
 * and `_` with an underscore so the result always satisfies the scenario
 * segment of `PACKET_ID_PATTERN`. A scenario that sanitizes to nothing (empty
 * string, whitespace only) falls back to `FALLBACK_SCENARIO_SEGMENT` because
 * the pattern requires at least one character.
 */
export function sanitizeScenarioSegment(scenario: string): string {
  const trimmed = scenario.trim();
  if (trimmed === "") {
    return FALLBACK_SCENARIO_SEGMENT;
  }
  return trimmed.toLowerCase().replace(/[^a-z0-9_]/gu, "_");
}

/**
 * A source of uniform numbers in the half-open interval `[0, 1)`, the same
 * contract as `Math.random`. Seeded fixture builds pass one so the suffix is
 * reproducible; production callers leave it unset and get the CSPRNG.
 */
export type RandomSource = () => number;

/**
 * Draws `length` base36 characters from the Workers-provided CSPRNG.
 * `crypto.getRandomValues` is a global on the Workers runtime and on Node 19+,
 * so no Node `crypto` import is needed (and none is allowed in this Worker).
 */
function randomBase36(length: number): string {
  let out = "";
  // Over-allocate so a single draw almost always suffices; redraw on the rare
  // case that too many bytes were rejected for bias.
  const buffer = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= UNBIASED_BYTE_LIMIT) {
        continue;
      }
      out += BASE36_ALPHABET[byte % BASE36_ALPHABET.length];
      if (out.length === length) {
        break;
      }
    }
  }
  return out;
}

/** Draws `length` base36 characters from a caller-supplied `[0, 1)` source. */
function seededBase36(length: number, random: RandomSource): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    // Clamp so a source that returns exactly 1 (contract violation) cannot
    // index past the alphabet and yield `undefined`.
    const index = Math.min(Math.floor(random() * BASE36_ALPHABET.length), BASE36_ALPHABET.length - 1);
    out += BASE36_ALPHABET[index];
  }
  return out;
}

/**
 * Mints a unique packet identifier for `scenario`.
 *
 * `now` defaults to the current time and exists so tests and seeded fixture
 * builds can pin the timestamp segment. `random` replaces the CSPRNG as the
 * suffix source; seeded fixture builds pass their deterministic generator so
 * the same seed always yields the same identifier. Production emit paths
 * pass neither.
 */
export function mintPacketId(
  scenario: string,
  now: Date = new Date(),
  random?: RandomSource,
): string {
  const segment = sanitizeScenarioSegment(scenario);
  const epochMillis = now.getTime();
  const suffix =
    random === undefined
      ? randomBase36(PACKET_ID_SUFFIX_LENGTH)
      : seededBase36(PACKET_ID_SUFFIX_LENGTH, random);
  return `${PACKET_ID_PREFIX}_${segment}_${epochMillis}_${suffix}`;
}
