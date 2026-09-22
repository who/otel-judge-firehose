/**
 * Seeded random helper for deterministic fixture scenarios.
 *
 * `createSeededRng` turns a string seed into a `[0, 1)` generator so a
 * scenario build can be replayed byte-for-byte. The implementation is
 * mulberry32 over an FNV-1a hash of the seed: a handful of lines, no
 * dependency, and more than adequate for demo variation. It is not a CSPRNG
 * and must never be used for anything security-relevant; packet identifier
 * suffixes on the live emit path keep using `crypto.getRandomValues`.
 */

import type { RandomSource } from "../packet/id";

export type { RandomSource };

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-16 code units of `text`. */
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** mulberry32: a small, fast 32-bit PRNG with a full 2^32 period. */
function mulberry32(initialState: number): RandomSource {
  let state = initialState >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns a generator yielding numbers in the half-open interval `[0, 1)`.
 * Two generators built from the same seed produce the same sequence.
 */
export function createSeededRng(seed: string): RandomSource {
  return mulberry32(fnv1a32(seed));
}

/**
 * Draws a fresh seed from the platform CSPRNG for unseeded builds. Returned as
 * a string so it can be echoed back to a caller who wants to replay the run.
 */
export function freshSeed(): string {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return `${(words[0] ?? 0).toString(36)}${(words[1] ?? 0).toString(36)}`;
}

/** Uniform number in `[min, max)`. */
export function between(random: RandomSource, min: number, max: number): number {
  return min + random() * (max - min);
}

/** Uniform integer in the inclusive range `[min, max]`. */
export function intBetween(random: RandomSource, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** Picks one element; `items` must be non-empty. */
export function pick<T>(random: RandomSource, items: readonly [T, ...T[]]): T {
  const index = Math.min(Math.floor(random() * items.length), items.length - 1);
  return items[index] as T;
}

const HEX_ALPHABET = "0123456789abcdef";

/** `length` lowercase hex characters, for trace ids and synthetic shas. */
export function hex(random: RandomSource, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += HEX_ALPHABET[Math.min(Math.floor(random() * 16), 15)];
  }
  return out;
}

/** Rounds to `digits` decimal places so fixture output stays readable. */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
