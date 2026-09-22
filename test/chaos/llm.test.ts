import { describe, expect, it } from "vitest";

import {
  CHAOS_MODEL,
  CHAOS_PROMPT,
  MAX_LLM_PACKETS,
  MAX_LOG_SNIPPETS,
  MAX_LOG_SNIPPET_CHARS,
  MODEL_RETRIES,
  buildLlmChaosPacket,
  buildLlmChaosPackets,
  parseModelPacket,
  type AiBinding,
} from "../../src/chaos/llm";
import { MAX_SPANS, SERVICE_POOL } from "../../src/chaos/template";
import type { EmitDeps } from "../../src/emit/handler";
import { buildScenarioPackets } from "../../src/fixtures/registry";
import { routeRequest, type Env } from "../../src/index";
import { PacketSchema, type Packet } from "../../src/packet/schema";

const JUDGE_URL = "https://judge.example/ingest/v1";
const ORIGIN = "https://who.github.io";

/** A model reply the schema accepts, distinct from anything the template pools contain. */
const GOOD_FIELDS = {
  service: "ledger-reconciler",
  env: "staging",
  span_names: ["POST /ledger/reconcile", "db.query ledger_entries", "client fx-rates"],
  alert_labels: ["reconcile_lag", "fx_timeout"],
  log_snippets: [
    'level=error msg="fx-rates upstream timed out after 3000ms" attempt=3',
    'level=warn msg="reconcile batch 4127 retried"',
  ],
} as const;

interface ModelCall {
  model: string;
  inputs: Record<string, unknown>;
}

/** Scripted binding: answers each call with the next reply, then the last one forever. */
function aiStub(replies: unknown[]): { ai: AiBinding; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const queue = [...replies];
  const ai: AiBinding = {
    run: async (model, inputs) => {
      calls.push({ model, inputs });
      const reply = queue.length > 1 ? queue.shift() : queue[0];
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
  };
  return { ai, calls };
}

function textReply(body: unknown): { response: string } {
  return { response: typeof body === "string" ? body : JSON.stringify(body) };
}

function templatePacket(seed = "llm-base"): Packet {
  const [packet] = buildScenarioPackets("chaos", 1, { seed });
  if (packet === undefined) {
    throw new Error("template build produced no packet");
  }
  return packet;
}

interface Post {
  body: Packet;
}

function judgeStub(): { deps: EmitDeps; posts: Post[] } {
  const posts: Post[] = [];
  const deps: EmitDeps = {
    fetch: async (_url, init) => {
      posts.push({ body: PacketSchema.parse(JSON.parse(String(init.body))) });
      return new Response(null, { status: 202 });
    },
    sleep: async () => {},
  };
  return { deps, posts };
}

function emit(body: unknown): Request {
  return new Request("https://firehose.test/emit", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe("parseModelPacket", () => {
  it("model response: accepts the text envelope, a bare object, and fenced JSON with prose around it", () => {
    const expected = {
      service: GOOD_FIELDS.service,
      env: GOOD_FIELDS.env,
      span_names: [...GOOD_FIELDS.span_names],
      alert_labels: [...GOOD_FIELDS.alert_labels],
      log_snippets: [...GOOD_FIELDS.log_snippets],
    };
    expect(parseModelPacket(textReply(GOOD_FIELDS))).toEqual(expected);
    expect(parseModelPacket({ response: GOOD_FIELDS })).toEqual(expected);
    expect(parseModelPacket(GOOD_FIELDS)).toEqual(expected);
    expect(parseModelPacket(`Sure! Here you go:\n\`\`\`json\n${JSON.stringify(GOOD_FIELDS)}\n\`\`\`\nHope that helps.`)).toEqual(
      expected,
    );
  });

  it("model response: truncates an enormous log snippet and bounds every list without rejecting", () => {
    const huge = "x".repeat(MAX_LOG_SNIPPET_CHARS * 10);
    const parsed = parseModelPacket({
      service: "  padded-service  ",
      env: "prod",
      span_names: Array.from({ length: MAX_SPANS + 4 }, (_, i) => `span ${i}`),
      alert_labels: ["dup", "dup", " ", "other"],
      log_snippets: [huge, "one", "two", "three", "four"],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.service).toBe("padded-service");
    expect(parsed?.span_names).toHaveLength(MAX_SPANS);
    expect(parsed?.alert_labels).toEqual(["dup", "other"]);
    expect(parsed?.log_snippets).toHaveLength(MAX_LOG_SNIPPETS);
    expect(parsed?.log_snippets?.[0]).toHaveLength(MAX_LOG_SNIPPET_CHARS);
  });

  it("falls back: prose, a non-object, an unknown environment, an empty service, and any numeric key parse to null", () => {
    expect(parseModelPacket("The service is checkout-api running in prod.")).toBeNull();
    expect(parseModelPacket(textReply("[1, 2, 3]"))).toBeNull();
    expect(parseModelPacket(textReply("{not json"))).toBeNull();
    expect(parseModelPacket(42)).toBeNull();
    expect(parseModelPacket(null)).toBeNull();
    expect(parseModelPacket({ ...GOOD_FIELDS, env: "production" })).toBeNull();
    expect(parseModelPacket({ ...GOOD_FIELDS, service: "   " })).toBeNull();
    expect(parseModelPacket({ ...GOOD_FIELDS, span_names: [1, 2] })).toBeNull();
    // Numerics are never accepted from the model, in range or not.
    expect(parseModelPacket({ ...GOOD_FIELDS, signals: { error_rate: 0.5 } })).toBeNull();
    expect(parseModelPacket({ ...GOOD_FIELDS, p95_latency_ms: 120 })).toBeNull();
  });
});

describe("buildLlmChaosPacket", () => {
  it("model response: a well-formed reply yields a packet carrying the model-written fields that validates", async () => {
    const base = templatePacket();
    const { ai, calls } = aiStub([textReply(GOOD_FIELDS)]);

    const result = await buildLlmChaosPacket(base, ai);

    expect(result.modelWritten).toBe(true);
    expect(result).not.toHaveProperty("fallbackReason");
    expect(PacketSchema.safeParse(result.packet).success).toBe(true);

    const { packet } = result;
    expect(packet.service).toBe(GOOD_FIELDS.service);
    expect(SERVICE_POOL).not.toContain(packet.service);
    expect(packet.env).toBe(GOOD_FIELDS.env);
    expect(packet.alert_labels).toEqual([...GOOD_FIELDS.alert_labels]);
    expect(packet.log_snippets).toEqual([...GOOD_FIELDS.log_snippets]);

    // Span names are the model's, zipped onto the template's numerics.
    const zipped = Math.min(GOOD_FIELDS.span_names.length, base.top_spans.length);
    expect(packet.top_spans).toHaveLength(zipped);
    packet.top_spans.forEach((span, index) => {
      expect(span.name).toBe(GOOD_FIELDS.span_names[index]);
      expect(span.count).toBe(base.top_spans[index]?.count);
      expect(span.p95_ms).toBe(base.top_spans[index]?.p95_ms);
    });

    // Everything numeric, the window, and the identifier are the template's.
    expect(packet.signals).toEqual(base.signals);
    expect(packet.window).toEqual(base.window);
    expect(packet.packet_id).toBe(base.packet_id);
    expect(packet.recent_deploy).toEqual(base.recent_deploy);
    expect(packet.exemplar_trace_ids).toEqual(base.exemplar_trace_ids);

    // One call, to the named model, carrying the prompt and the signals but no secret.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(CHAOS_MODEL);
    const messages = calls[0]?.inputs.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: CHAOS_PROMPT });
    expect(messages[1]?.content).toContain(String(base.signals.slo_burn_rate));
    expect(messages[1]?.content).toContain(`exactly ${base.top_spans.length} span_names`);
  });

  it("model response: a reply without optional lists keeps the template's spans and labels and omits log_snippets", async () => {
    const base = templatePacket("keep-lists");
    const { ai } = aiStub([textReply({ service: "sparse-svc", env: "dev" })]);

    const result = await buildLlmChaosPacket(base, ai);

    expect(result.modelWritten).toBe(true);
    expect(result.packet.service).toBe("sparse-svc");
    expect(result.packet.top_spans).toEqual(base.top_spans);
    expect(result.packet.alert_labels).toEqual(base.alert_labels);
    expect(result.packet).not.toHaveProperty("log_snippets");
  });

  it("falls back: a non-JSON reply on both attempts yields the template packet and a recorded reason", async () => {
    const base = templatePacket();
    const { ai, calls } = aiStub([textReply("Here is the packet you asked for: service checkout-api in prod.")]);

    const result = await buildLlmChaosPacket(base, ai);

    expect(result).toEqual({ packet: base, modelWritten: false, fallbackReason: "model_output_invalid" });
    expect(calls).toHaveLength(1 + MODEL_RETRIES);
  });

  it("falls back: a reply whose fields fail validation yields the template packet", async () => {
    const base = templatePacket();
    const { ai, calls } = aiStub([textReply({ ...GOOD_FIELDS, env: "production", signals: { error_rate: 7 } })]);

    const result = await buildLlmChaosPacket(base, ai);

    expect(result.modelWritten).toBe(false);
    expect(result.packet).toBe(base);
    expect(result.fallbackReason).toBe("model_output_invalid");
    expect(calls).toHaveLength(1 + MODEL_RETRIES);
  });

  it("falls back: a rejecting binding yields the template packet after exactly one retry, naming only the error", async () => {
    const base = templatePacket();
    const { ai, calls } = aiStub([new Error("inference quota exceeded")]);

    const result = await buildLlmChaosPacket(base, ai);

    expect(result.packet).toBe(base);
    expect(result.modelWritten).toBe(false);
    expect(result.fallbackReason).toBe("model_call_failed: inference quota exceeded");
    expect(calls).toHaveLength(1 + MODEL_RETRIES);
  });

  it("falls back: a binding that never answers is cut off by the timeout", async () => {
    const base = templatePacket();
    const ai: AiBinding = { run: () => new Promise(() => {}) };

    const result = await buildLlmChaosPacket(base, ai, { timeoutMs: 5 });

    expect(result.packet).toBe(base);
    expect(result.fallbackReason).toMatch(/^model_call_failed: no answer within 5ms/);
  });

  it("falls back: the retry succeeds when the first reply was bad", async () => {
    const base = templatePacket();
    const { ai, calls } = aiStub([textReply("nope"), textReply(GOOD_FIELDS)]);

    const result = await buildLlmChaosPacket(base, ai);

    expect(result.modelWritten).toBe(true);
    expect(result.packet.service).toBe(GOOD_FIELDS.service);
    expect(calls).toHaveLength(2);
  });

  it("missing binding: an absent AI binding yields the template packet without throwing", async () => {
    const base = templatePacket();

    const result = await buildLlmChaosPacket(base, undefined);

    expect(result).toEqual({ packet: base, modelWritten: false, fallbackReason: "ai_binding_missing" });
  });
});

describe("buildLlmChaosPackets", () => {
  it("model response: rewrites only the first `limit` packets, never more than the cap", async () => {
    const bases = buildScenarioPackets("chaos", MAX_LLM_PACKETS + 5, { seed: "batch" });
    const { ai, calls } = aiStub([textReply(GOOD_FIELDS)]);

    const limited = await buildLlmChaosPackets(bases, 3, ai);
    expect(limited.packets).toHaveLength(bases.length);
    expect(limited.modelWritten).toBe(3);
    expect(limited.packets.slice(0, 3).every((packet) => packet.service === GOOD_FIELDS.service)).toBe(true);
    expect(limited.packets.slice(3)).toEqual(bases.slice(3));
    expect(calls).toHaveLength(3);

    const capped = await buildLlmChaosPackets(bases, bases.length, ai);
    expect(capped.modelWritten).toBe(MAX_LLM_PACKETS);
    expect(calls).toHaveLength(3 + MAX_LLM_PACKETS);
  });

  it("falls back: a mixed batch reports the first fallback reason and keeps every packet valid", async () => {
    const bases = buildScenarioPackets("chaos", 3, { seed: "mixed" });
    // The first call gets a good reply; every later call, retries included, gets prose.
    const { ai } = aiStub([textReply(GOOD_FIELDS), textReply("prose")]);

    const batch = await buildLlmChaosPackets(bases, 3, ai);

    expect(batch.packets).toHaveLength(3);
    expect(batch.modelWritten).toBe(1);
    expect(batch.packets[0]?.service).toBe(GOOD_FIELDS.service);
    expect(batch.packets.slice(1)).toEqual(bases.slice(1));
    expect(batch.fallbackReason).toBe("model_output_invalid");
    expect(batch.packets.every((packet) => PacketSchema.safeParse(packet).success)).toBe(true);
  });
});

describe("POST /emit with llm", () => {
  it("model response: posts model-written chaos packets and the summary carries no fallbackReason", async () => {
    const { ai, calls } = aiStub([textReply(GOOD_FIELDS)]);
    const env: Env = { JUDGE_FIREHOSE_URL: JUDGE_URL, AI: ai };
    const { deps, posts } = judgeStub();

    const response = await routeRequest(emit({ scenario: "chaos", count: 2, seed: "route", llm: true }), env, deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Loose;
    expect(body).toMatchObject({ ok: true, scenario: "chaos", generated: 2, accepted: 2 });
    expect(body).not.toHaveProperty("fallbackReason");
    expect(calls).toHaveLength(2);
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.body.service).toBe(GOOD_FIELDS.service);
      expect(post.body.log_snippets).toEqual([...GOOD_FIELDS.log_snippets]);
    }
    expect(posts.map((post) => post.body.packet_id)).toEqual(body.packetIds);
  });

  it("model response: a paced run sends only the first burst through the model", async () => {
    const { ai, calls } = aiStub([textReply(GOOD_FIELDS)]);
    const env: Env = { JUDGE_FIREHOSE_URL: JUDGE_URL, AI: ai };
    const { deps, posts } = judgeStub();

    const response = await routeRequest(
      emit({ scenario: "chaos", count: 5, burst: 2, intervalMs: 10, llm: true }),
      env,
      deps,
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(posts).toHaveLength(5);
    expect(posts.slice(0, 2).every((post) => post.body.service === GOOD_FIELDS.service)).toBe(true);
    expect(posts.slice(2).every((post) => (SERVICE_POOL as readonly string[]).includes(post.body.service))).toBe(true);
  });

  it("falls back: an invalid model reply posts template packets only, with the reason on the summary", async () => {
    const { ai, calls } = aiStub([textReply("I cannot produce JSON right now.")]);
    const env: Env = { JUDGE_FIREHOSE_URL: JUDGE_URL, AI: ai };
    const { deps, posts } = judgeStub();

    const response = await routeRequest(emit({ scenario: "chaos", count: 2, seed: "invalid", llm: true }), env, deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Loose;
    expect(body).toMatchObject({ ok: true, generated: 2, accepted: 2, fallbackReason: "model_output_invalid" });
    expect(calls).toHaveLength(2 * (1 + MODEL_RETRIES));
    expect(posts).toHaveLength(2);
    // Exactly the template packets went out: same seed, same bytes.
    const expected = buildScenarioPackets("chaos", 2, { seed: "invalid" });
    expect(posts.map((post) => post.body)).toEqual(expected);
    const text = JSON.stringify(body);
    expect(text).not.toContain("cannot produce JSON");
  });

  it("missing binding: llm with no AI binding posts template packets and reports the missing binding", async () => {
    const env: Env = { JUDGE_FIREHOSE_URL: JUDGE_URL };
    const { deps, posts } = judgeStub();

    const response = await routeRequest(emit({ scenario: "chaos", count: 2, llm: true }), env, deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Loose;
    expect(body).toMatchObject({ ok: true, generated: 2, accepted: 2, fallbackReason: "ai_binding_missing" });
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => (SERVICE_POOL as readonly string[]).includes(post.body.service))).toBe(true);
  });

  it("missing binding: llm on a fixture scenario is ignored and makes no model call", async () => {
    const { ai, calls } = aiStub([textReply(GOOD_FIELDS)]);
    const env: Env = { JUDGE_FIREHOSE_URL: JUDGE_URL, AI: ai };
    const { deps, posts } = judgeStub();

    const response = await routeRequest(emit({ scenario: "healthy", count: 2, llm: true }), env, deps);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Loose;
    expect(body).toMatchObject({ ok: true, scenario: "healthy", accepted: 2 });
    expect(body).not.toHaveProperty("fallbackReason");
    expect(calls).toHaveLength(0);
    expect(posts).toHaveLength(2);
  });

  it("rejects a non-boolean llm field naming the field", async () => {
    const env: Env = { JUDGE_FIREHOSE_URL: JUDGE_URL };
    const { deps, posts } = judgeStub();

    const response = await routeRequest(emit({ scenario: "chaos", llm: "yes" }), env, deps);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Loose;
    expect(body.issues).toEqual([expect.objectContaining({ field: "llm" })]);
    expect(posts).toHaveLength(0);
  });
});
