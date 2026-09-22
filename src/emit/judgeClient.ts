/**
 * Outbound client that posts validated packets to the otel-judge firehose.
 *
 * Each packet is sent as its own POST so the Judge sees one unique
 * `packet_id` per request and can dedupe per packet. Transient failures are
 * retried a bounded number of times; a permanent rejection is reported once.
 * The `fetch` and `sleep` implementations are injectable so tests never touch
 * the network or the wall clock.
 */

import type { FirehoseConfig } from "../config";
import type { Packet } from "../packet/schema";

/** Maximum number of retries after the first attempt. */
export const MAX_RETRIES = 2;

/** Backoff in milliseconds before each retry, indexed by retry number. */
export const RETRY_BACKOFF_MS: readonly number[] = [200, 400];

/** Per-packet outcome. JSON-serializable so the emit route can return it. */
export interface JudgePostResult {
  /** The `packet_id` of the packet this result describes. */
  readonly packetId: string;
  /** True when the ingress answered with a 2xx status. */
  readonly accepted: boolean;
  /** HTTP status of the final attempt; absent when every attempt was a network rejection. */
  readonly status?: number;
  /** Total attempts made, including the first request. */
  readonly attempts: number;
  /** Explanation of the final failure; absent when accepted. */
  readonly error?: string;
}

/** Injected runtime hooks. Defaults to the Worker globals. */
export interface JudgeClientDeps {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly sleep: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Global `fetch` is looked up lazily so the module loads even in environments
 * where the global is installed after import.
 */
function defaultFetch(input: string, init: RequestInit): Promise<Response> {
  return fetch(input, init);
}

const DEFAULT_DEPS: JudgeClientDeps = { fetch: defaultFetch, sleep: defaultSleep };

const encoder = new TextEncoder();

/**
 * HMAC-SHA256 of the raw body bytes as lowercase hex. Matches Judge
 * `signFirehoseBody` in `src/ingress/verify.ts` so ingress accepts the POST.
 */
export async function signFirehoseBody(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Builds the URL and request init for a single packet POST. */
export async function buildPacketRequest(

  config: FirehoseConfig,
  packet: Packet,
): Promise<{ url: string; init: RequestInit }> {
  const body = JSON.stringify(packet);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.judgeIngestToken !== undefined) {
    headers.authorization = `Bearer ${config.judgeIngestToken}`;
  }
  if (config.firehoseSecret !== undefined) {
    headers["x-firehose-signature"] = await signFirehoseBody(config.firehoseSecret, body);
  }
  return {
    url: config.judgeFirehoseUrl,
    init: { method: "POST", headers, body },
  };
}

/** True for statuses that may succeed on a later attempt. */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Describes a rejected fetch without ever echoing request details. Only the
 * error's own message is used, which cannot contain the Authorization header.
 */
function describeRejection(reason: unknown): string {
  if (reason instanceof Error) {
    return `network error: ${reason.message}`;
  }
  return "network error";
}

/**
 * Posts one packet, retrying transient failures with exponential backoff.
 *
 * A network rejection, a 429, or a 5xx is retried up to `MAX_RETRIES` times
 * with the delays in `RETRY_BACKOFF_MS`. Any other non-2xx status is treated
 * as permanent and reported after a single attempt. Never throws.
 */
export async function postPacket(
  config: FirehoseConfig,
  packet: Packet,
  deps: Partial<JudgeClientDeps> = {},
): Promise<JudgePostResult> {
  const { fetch: doFetch, sleep } = { ...DEFAULT_DEPS, ...deps };
  const { url, init } = await buildPacketRequest(config, packet);
  const packetId = packet.packet_id;

  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError = "no attempt made";

  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    attempts += 1;
    let response: Response;
    try {
      response = await doFetch(url, init);
    } catch (reason) {
      lastStatus = undefined;
      lastError = describeRejection(reason);
      if (retry < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[retry] ?? 0);
      }
      continue;
    }

    lastStatus = response.status;
    if (response.ok) {
      return { packetId, accepted: true, status: response.status, attempts };
    }

    lastError = `judge ingress responded ${response.status}`;
    if (!isTransientStatus(response.status)) {
      return { packetId, accepted: false, status: response.status, attempts, error: lastError };
    }
    if (retry < MAX_RETRIES) {
      await sleep(RETRY_BACKOFF_MS[retry] ?? 0);
    }
  }

  const failure = `${lastError} after ${attempts} attempts`;
  return lastStatus === undefined
    ? { packetId, accepted: false, attempts, error: failure }
    : { packetId, accepted: false, status: lastStatus, attempts, error: failure };
}

/**
 * Posts packets sequentially and returns one result per packet in order.
 * A per-packet failure never aborts the batch; the caller reports partial
 * success from the returned array. An empty input performs no request.
 */
export async function postPackets(
  config: FirehoseConfig,
  packets: readonly Packet[],
  deps: Partial<JudgeClientDeps> = {},
): Promise<JudgePostResult[]> {
  const results: JudgePostResult[] = [];
  for (const packet of packets) {
    results.push(await postPacket(config, packet, deps));
  }
  return results;
}
