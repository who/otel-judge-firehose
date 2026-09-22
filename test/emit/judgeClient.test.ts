import { describe, expect, it } from "vitest";

import type { FirehoseConfig } from "../../src/config";
import {
  MAX_RETRIES,
  RETRY_BACKOFF_MS,
  buildPacketRequest,
  postPacket,
  postPackets,
  type JudgeClientDeps,
} from "../../src/emit/judgeClient";
import { PacketSchema, type Packet, type PacketInput } from "../../src/packet/schema";

const TOKEN = "super-secret-ingest-token";

const CONFIG: FirehoseConfig = {
  judgeFirehoseUrl: "https://judge.example/ingest/v1",
  judgeIngestToken: TOKEN,
  demoOriginAllowlist: ["https://who.github.io"],
};

function packet(id = "pkt_healthy_1758500000000_abc123"): Packet {
  const input: PacketInput = {
    packet_id: id,
    service: "checkout-api",
    env: "prod",
    window: { start: "2026-09-21T12:00:00Z", end: "2026-09-21T12:05:00Z" },
    signals: {
      error_rate: 0.12,
      error_rate_baseline: 0.004,
      p95_latency_ms: 1850,
      p95_latency_baseline_ms: 420,
      slo_burn_rate: 14.2,
      request_rate: 312.5,
    },
    top_spans: [{ name: "POST /checkout", count: 9_400, p95_ms: 1_900 }],
    exemplar_trace_ids: ["4bf92f3577b34da6a3ce929d0e0e4736"],
    recent_deploy: null,
    alert_labels: ["slo:checkout-availability"],
  };
  return PacketSchema.parse(input);
}

interface Call {
  url: string;
  init: RequestInit;
}

type Outcome = { status: number; body?: string } | { reject: Error };

/** Builds a scripted fetch that answers each call with the next outcome. */
function stub(outcomes: Outcome[]): {
  deps: JudgeClientDeps;
  calls: Call[];
  sleeps: number[];
} {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...outcomes];
  const deps: JudgeClientDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("fetch stub exhausted");
      }
      if ("reject" in next) {
        throw next.reject;
      }
      return new Response(next.body ?? "", { status: next.status });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, calls, sleeps };
}

describe("buildPacketRequest", () => {
  it("posts the JSON packet to the ingest URL with a bearer header", () => {
    const p = packet();
    const { url, init } = buildPacketRequest(CONFIG, p);

    expect(url).toBe(CONFIG.judgeFirehoseUrl);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(init.body as string)).toEqual(p);
  });

  it("omits the authorization header when no token is configured", () => {
    const { init } = buildPacketRequest(
      { judgeFirehoseUrl: CONFIG.judgeFirehoseUrl, demoOriginAllowlist: [] },
      packet(),
    );

    expect(init.headers).toEqual({ "content-type": "application/json" });
  });
});

describe("postPacket", () => {
  it("reports an accepted result with the packet id and status on 202", async () => {
    const { deps, calls, sleeps } = stub([{ status: 202, body: "not json {" }]);
    const p = packet();

    const result = await postPacket(CONFIG, p, deps);

    expect(result).toEqual({ packetId: p.packet_id, accepted: true, status: 202, attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries server error with backoff and reports accepted when the retry succeeds", async () => {
    const { deps, calls, sleeps } = stub([{ status: 500 }, { status: 202 }]);
    const p = packet();

    const result = await postPacket(CONFIG, p, deps);

    expect(result).toEqual({ packetId: p.packet_id, accepted: true, status: 202, attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([RETRY_BACKOFF_MS[0]]);
  });

  it("retries rate limiting within the bound and reports the final status", async () => {
    const { deps, calls, sleeps } = stub([{ status: 429 }, { status: 429 }, { status: 429 }]);
    const p = packet();

    const result = await postPacket(CONFIG, p, deps);

    expect(result.accepted).toBe(false);
    expect(result.status).toBe(429);
    expect(result.attempts).toBe(MAX_RETRIES + 1);
    expect(calls).toHaveLength(MAX_RETRIES + 1);
    expect(sleeps).toEqual([...RETRY_BACKOFF_MS]);
  });

  it("does not retry client error and reports failure after one attempt", async () => {
    const { deps, calls, sleeps } = stub([{ status: 400, body: '{"error":"bad packet"}' }]);
    const p = packet();

    const result = await postPacket(CONFIG, p, deps);

    expect(result).toEqual({
      packetId: p.packet_id,
      accepted: false,
      status: 400,
      attempts: 1,
      error: "judge ingress responded 400",
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("treats a network rejection as transient and exhausts retries without a status", async () => {
    const boom = new Error("ECONNRESET");
    const { deps, calls, sleeps } = stub([{ reject: boom }, { reject: boom }, { reject: boom }]);
    const p = packet();

    const result = await postPacket(CONFIG, p, deps);

    expect(result).not.toHaveProperty("status");
    expect(result.accepted).toBe(false);
    expect(result.attempts).toBe(MAX_RETRIES + 1);
    expect(result.error).toMatch(/ECONNRESET/);
    expect(calls).toHaveLength(MAX_RETRIES + 1);
    expect(sleeps).toEqual([...RETRY_BACKOFF_MS]);
  });

  it("never leaks token into result objects or error messages", async () => {
    const leaky = new Error(`refused for Bearer ${TOKEN}`);
    const outcomes: Outcome[][] = [
      [{ status: 202 }],
      [{ status: 400 }],
      [{ status: 503 }, { status: 503 }, { status: 503 }],
      [{ reject: new Error("timeout") }, { reject: new Error("timeout") }, { reject: new Error("timeout") }],
    ];

    for (const script of outcomes) {
      const { deps } = stub(script);
      const result = await postPacket(CONFIG, packet(), deps);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }

    // Even an error raised by fetch itself is reported verbatim only through
    // its own message; the client never appends headers to it.
    const { deps } = stub([{ reject: leaky }, { reject: leaky }, { reject: leaky }]);
    const result = await postPacket(CONFIG, packet(), deps);
    expect(result.error).toContain("refused for Bearer");
    expect(Object.keys(result)).toEqual(["packetId", "accepted", "attempts", "error"]);
  });
});

describe("postPackets", () => {
  it("returns an empty array without a request for an empty input", async () => {
    const { deps, calls } = stub([]);

    await expect(postPackets(CONFIG, [], deps)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns one result per packet in order and keeps going past a failure", async () => {
    const { deps, calls } = stub([{ status: 202 }, { status: 400 }, { status: 500 }, { status: 202 }]);
    const first = packet("pkt_healthy_1758500000001_aaaaaa");
    const second = packet("pkt_healthy_1758500000002_bbbbbb");
    const third = packet("pkt_healthy_1758500000003_cccccc");

    const results = await postPackets(CONFIG, [first, second, third], deps);

    expect(results.map((r) => [r.packetId, r.accepted, r.attempts])).toEqual([
      [first.packet_id, true, 1],
      [second.packet_id, false, 1],
      [third.packet_id, true, 2],
    ]);
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => JSON.parse(c.init.body as string).packet_id)).toEqual([
      first.packet_id,
      second.packet_id,
      third.packet_id,
      third.packet_id,
    ]);
  });
});
