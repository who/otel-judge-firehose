/**
 * The single validation gate every packet passes before the Worker posts it.
 *
 * `validatePacket()` and `validatePackets()` throw `PacketValidationError`
 * rather than returning a result union, so no caller can forget to check.
 * The emit handler calls `validatePackets()` immediately before handing
 * packets to the Judge client; fixture builders and chaos generators use
 * `validatePacket()` to fail fast on their own output.
 */

import type { z } from "zod";

import { PacketSchema, type Packet } from "./schema";

/** A zod issue as reported by `PacketSchema`. */
export type PacketIssue = z.ZodIssue;

/** Renders a zod issue path as `a.b[2].c`; the root path renders as `(root)`. */
export function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "(root)";
  }
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }
    const text = String(segment);
    return acc === "" ? text : `${acc}.${text}`;
  }, "");
}

/**
 * Raised when a candidate packet does not satisfy `PacketSchema`.
 *
 * `issues` holds the zod issues verbatim. For a batch failure each issue's
 * path is prefixed with the index of the offending candidate, and
 * `failedIndices` lists every index that failed, so one error reports every
 * bad packet.
 *
 * The message names only field paths and zod's own messages. It never embeds
 * candidate values, because the message may reach a response body.
 */
export class PacketValidationError extends Error {
  readonly issues: readonly PacketIssue[];
  /** Indices of failing candidates; empty for a single-packet failure. */
  readonly failedIndices: readonly number[];

  constructor(issues: readonly PacketIssue[], failedIndices: readonly number[] = []) {
    super(describe(issues, failedIndices));
    this.name = "PacketValidationError";
    this.issues = issues;
    this.failedIndices = failedIndices;
  }

  /** Rendered `path: message` lines, one per issue. */
  get details(): readonly string[] {
    return this.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
  }
}

function describe(issues: readonly PacketIssue[], failedIndices: readonly number[]): string {
  const details = issues
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
  if (failedIndices.length === 0) {
    return `packet failed validation: ${details}`;
  }
  const noun = failedIndices.length === 1 ? "packet" : "packets";
  return `${failedIndices.length} ${noun} failed validation at index ${failedIndices.join(", ")}: ${details}`;
}

/**
 * Parses one candidate against `PacketSchema` and returns the typed packet
 * with unknown keys stripped. Throws `PacketValidationError` on any failure,
 * including non-object input such as `null` or a string.
 */
export function validatePacket(candidate: unknown): Packet {
  const result = PacketSchema.safeParse(candidate);
  if (!result.success) {
    throw new PacketValidationError(result.error.issues);
  }
  return result.data;
}

/**
 * Validates every candidate and returns the typed packets in order. Throws a
 * single `PacketValidationError` listing every failing index and every issue,
 * so a batch reports all bad packets at once. An empty array is valid and
 * yields an empty array.
 */
export function validatePackets(candidates: readonly unknown[]): Packet[] {
  const packets: Packet[] = [];
  const issues: PacketIssue[] = [];
  const failedIndices: number[] = [];

  candidates.forEach((candidate, index) => {
    const result = PacketSchema.safeParse(candidate);
    if (result.success) {
      packets.push(result.data);
      return;
    }
    failedIndices.push(index);
    for (const issue of result.error.issues) {
      issues.push({ ...issue, path: [index, ...issue.path] });
    }
  });

  if (failedIndices.length > 0) {
    throw new PacketValidationError(issues, failedIndices);
  }
  return packets;
}
