/**
 * The Workers AI chaos path (PRD FR2, NFR2).
 *
 * `buildLlmChaosPacket` asks a Workers AI model for the descriptive fields
 * of a chaos packet, namely the service name, environment, span names,
 * alert labels, and log snippets, and merges them onto a template packet
 * built by `buildChaosPacket`. Every number in the packet, the observation
 * window, and the identifier stay exactly as the template computed them: a
 * model is unreliable at producing bounded numbers, and the packet must
 * validate. The merged candidate passes `validatePacket()`; on any failure,
 * a rejected call, prose instead of JSON, a field that fails the model
 * schema, or a merged packet the contract rejects, the untouched template
 * packet is returned with a `fallbackReason`, so the demo never stalls and
 * never posts a malformed packet.
 *
 * The model is reached only through the Worker's `AI` binding, which keeps
 * every credential inside this Worker and off the demo's static origin. The
 * binding is optional at runtime: local development and the test suite
 * work without it, and a missing binding is a fallback, never an error.
 */

import { z } from "zod";

import { PACKET_ENVS, type Packet, type TopSpan } from "../packet/schema";
import { PacketValidationError, validatePacket } from "../packet/validate";
import { MAX_LABELS, MAX_SPANS } from "./template";

/** Workers AI model identifier the chaos path asks for descriptive fields. */
export const CHAOS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Most packets per emit request that are model-written. Model latency must
 * not eat the wall-clock budget of a run, so the handler applies the model
 * to the first burst only and never to more packets than this; the rest of
 * the run stays on the template path.
 */
export const MAX_LLM_PACKETS = 10;

/** Retries after the first model call; exactly one by design. */
export const MODEL_RETRIES = 1;

/** Longest a single model call may take before it counts as a rejection. */
export const MODEL_TIMEOUT_MS = 6000;

/** Bounds on model-written log snippets so the packet stays small. */
export const MAX_LOG_SNIPPETS = 3;
export const MAX_LOG_SNIPPET_CHARS = 240;

/** Longest accepted service, span, or label name; longer names are truncated. */
export const MAX_NAME_CHARS = 96;

/**
 * The slice of the Workers AI binding this module uses. Declared
 * structurally so the Worker's real `AI` binding satisfies it and a test can
 * stub it with a plain object.
 */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** System prompt: descriptive fields only, as one JSON object, no prose. */
export const CHAOS_PROMPT = [
  "You write realistic observability data for a demo of an incident-triage system.",
  "Given the health signals of one service over a five-minute window, invent the",
  "descriptive fields of that observation. Respond with exactly one JSON object and",
  "nothing else: no prose, no markdown fences, no comments.",
  "",
  "The object has exactly these keys:",
  '- "service": a plausible kebab-case microservice name, for example "order-orchestrator".',
  '- "env": one of "prod", "staging", "dev".',
  '- "span_names": an array of distinct span names such as "POST /checkout", "db.query orders",',
  '  or "client payments-gateway". Produce exactly the number requested, at most ' + String(MAX_SPANS) + ".",
  '- "alert_labels": an array of at most ' + String(MAX_LABELS) + " distinct snake_case labels such as",
  '  "slo_burn", "deploy_window", or "connection_reset". Use an empty array when the service is healthy.',
  '- "log_snippets": an array of one to ' + String(MAX_LOG_SNIPPETS) + " short single-line log excerpts",
  "  that fit the signals, each under 200 characters.",
  "",
  "Never include numbers such as latencies, rates, counts, or timestamps: those are",
  "computed elsewhere. Do not add any other key.",
].join("\n");

/** Trims, drops empties, dedupes, truncates each entry, and caps the list length. */
function cleanNames(items: readonly string[], maxItems: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const name = item.trim().slice(0, maxChars).trim();
    if (name === "" || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
    if (out.length === maxItems) {
      break;
    }
  }
  return out;
}

function nameList(maxItems: number, maxChars: number = MAX_NAME_CHARS) {
  return z.array(z.string()).transform((items) => cleanNames(items, maxItems, maxChars));
}

/**
 * Shape accepted from the model. `strict` rejects any extra key, so a model
 * that volunteers `signals` or another numeric field is discarded outright:
 * numerics are never accepted from the model, not even in range.
 */
export const ModelFieldsSchema = z
  .object({
    service: z
      .string()
      .trim()
      .transform((value) => value.slice(0, MAX_NAME_CHARS).trim())
      .pipe(z.string().min(1)),
    env: z.enum(PACKET_ENVS),
    span_names: nameList(MAX_SPANS).optional(),
    alert_labels: nameList(MAX_LABELS).optional(),
    log_snippets: nameList(MAX_LOG_SNIPPETS, MAX_LOG_SNIPPET_CHARS).optional(),
  })
  .strict();

/** Descriptive fields the model wrote, cleaned and bounded. */
export type ModelFields = z.infer<typeof ModelFieldsSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pulls the first `{ ... }` span out of model text, tolerating fences and surrounding prose. */
function parseJsonText(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Unwraps the binding's reply down to the candidate object. Text models
 * answer `{ response: string }`; JSON mode answers `{ response: object }`;
 * a stub may hand over the object or the text directly.
 */
function extractCandidate(raw: unknown): unknown {
  if (typeof raw === "string") {
    return parseJsonText(raw);
  }
  if (isRecord(raw)) {
    return "response" in raw ? extractCandidate(raw.response) : raw;
  }
  return null;
}

/**
 * Parses a model reply into `ModelFields`, or `null` when the reply is not
 * JSON, is not an object, or fails `ModelFieldsSchema`. Never throws, and
 * never keeps a reference to the raw text, so nothing the model wrote can
 * leak into a response or a log line through an error message.
 */
export function parseModelPacket(raw: unknown): ModelFields | null {
  const candidate = extractCandidate(raw);
  if (!isRecord(candidate)) {
    return null;
  }
  const result = ModelFieldsSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * Lays the model's descriptive fields over the template packet. Span names
 * are zipped onto the template's spans so every count and latency is the
 * template's; extra names are dropped and, when the model gave none, the
 * template's spans stay. Log snippets are added only when the model wrote
 * some, so a packet without them keeps the field absent as the contract allows.
 */
export function mergeModelFields(base: Packet, fields: ModelFields): Packet {
  const spanNames = fields.span_names ?? [];
  const topSpans: TopSpan[] =
    spanNames.length === 0
      ? base.top_spans
      : base.top_spans.slice(0, spanNames.length).map((span, index) => ({
          ...span,
          name: spanNames[index] as string,
        }));
  const logSnippets = fields.log_snippets ?? [];

  return {
    ...base,
    service: fields.service,
    env: fields.env,
    top_spans: topSpans,
    alert_labels: fields.alert_labels ?? base.alert_labels,
    ...(logSnippets.length === 0 ? {} : { log_snippets: logSnippets }),
  };
}

/** Injected knobs for `buildLlmChaosPacket`. */
export interface LlmDeps {
  /** Per-call ceiling; defaults to `MODEL_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** Outcome for one packet. `packet` is always schema-valid. */
export interface LlmChaosResult {
  readonly packet: Packet;
  /** True when the model's fields were merged; false when the template packet was returned. */
  readonly modelWritten: boolean;
  /** Why the template packet was returned instead; absent when `modelWritten`. */
  readonly fallbackReason?: string;
}

/** Outcome for a batch. `packets` is the full input length, model-written or not. */
export interface LlmChaosBatch {
  readonly packets: Packet[];
  /** How many packets carry model-written fields. */
  readonly modelWritten: number;
  /** The first fallback reason seen, when any packet fell back to its template. */
  readonly fallbackReason?: string;
}

/** Numeric context the model needs to write coherent fields; it may not change any of it. */
function describeSignals(base: Packet): string {
  const { signals } = base;
  return JSON.stringify({
    error_rate: signals.error_rate,
    error_rate_baseline: signals.error_rate_baseline,
    p95_latency_ms: signals.p95_latency_ms,
    p95_latency_baseline_ms: signals.p95_latency_baseline_ms,
    slo_burn_rate: signals.slo_burn_rate,
    request_rate_rps: signals.request_rate_rps,
    recent_deploy: base.recent_deploy !== undefined,
  });
}

/** Rejects `work` when `ms` elapse first; the timer is cleared either way. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function callModel(ai: AiBinding, base: Packet, timeoutMs: number): Promise<unknown> {
  const spanCount = Math.min(base.top_spans.length, MAX_SPANS);
  const inputs = {
    messages: [
      { role: "system", content: CHAOS_PROMPT },
      {
        role: "user",
        content: `Signals for this window: ${describeSignals(base)}\nReturn exactly ${spanCount} span_names.`,
      },
    ],
    max_tokens: 512,
    temperature: 0.9,
  };
  return withTimeout(ai.run(CHAOS_MODEL, inputs), timeoutMs);
}

/** Describes a rejected call from the error's own message only; model output is never included. */
function describeRejection(reason: unknown): string {
  return reason instanceof Error ? `model_call_failed: ${reason.message}` : "model_call_failed";
}

/**
 * Builds one model-written chaos packet on top of `base`, a validated
 * template packet. The binding is called once and retried once. Whatever
 * goes wrong, the returned packet validates: it is either the merged,
 * validated candidate or `base` itself. Never throws for a model problem;
 * only a programming error escapes.
 */
export async function buildLlmChaosPacket(
  base: Packet,
  ai: AiBinding | undefined,
  deps: LlmDeps = {},
): Promise<LlmChaosResult> {
  if (ai === undefined) {
    return { packet: base, modelWritten: false, fallbackReason: "ai_binding_missing" };
  }
  const timeoutMs = deps.timeoutMs ?? MODEL_TIMEOUT_MS;

  let fallbackReason = "model_unavailable";
  for (let attempt = 0; attempt <= MODEL_RETRIES; attempt += 1) {
    let raw: unknown;
    try {
      raw = await callModel(ai, base, timeoutMs);
    } catch (reason) {
      fallbackReason = describeRejection(reason);
      continue;
    }

    const fields = parseModelPacket(raw);
    if (fields === null) {
      fallbackReason = "model_output_invalid";
      continue;
    }

    try {
      return { packet: validatePacket(mergeModelFields(base, fields)), modelWritten: true };
    } catch (error) {
      if (error instanceof PacketValidationError) {
        fallbackReason = `merged_packet_invalid: ${error.details.join("; ")}`;
        continue;
      }
      throw error;
    }
  }

  return { packet: base, modelWritten: false, fallbackReason };
}

/**
 * Applies the model to the first `limit` packets of `bases`, capped at
 * `MAX_LLM_PACKETS`, calling the binding for each concurrently so a burst
 * costs one model round trip rather than one per packet. Packets past the
 * limit are returned untouched.
 */
export async function buildLlmChaosPackets(
  bases: readonly Packet[],
  limit: number,
  ai: AiBinding | undefined,
  deps: LlmDeps = {},
): Promise<LlmChaosBatch> {
  const take = Math.max(0, Math.min(Math.floor(limit), MAX_LLM_PACKETS, bases.length));
  const head = await Promise.all(bases.slice(0, take).map((base) => buildLlmChaosPacket(base, ai, deps)));

  const packets = [...head.map((result) => result.packet), ...bases.slice(take)];
  const modelWritten = head.filter((result) => result.modelWritten).length;
  const fallbackReason = head.find((result) => result.fallbackReason !== undefined)?.fallbackReason;

  return fallbackReason === undefined ? { packets, modelWritten } : { packets, modelWritten, fallbackReason };
}
