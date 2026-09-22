/**
 * Typed configuration for the Judge firehose producer.
 *
 * `resolveConfig` is the single place that reads the Worker environment. It
 * validates and normalizes the three producer variables (the optional `AI`
 * binding is passed through untouched) so every later caller
 * (the health probe, the firehose client, the emit handler) works from one
 * `FirehoseConfig` instead of raw environment strings.
 */

import type { AiBinding } from "./chaos/llm";

/** Raw Worker bindings as declared in `wrangler.jsonc` and `.dev.vars`. */
export interface FirehoseEnv {
  /** Required absolute HTTPS URL of the otel-judge Worker ingress. */
  JUDGE_FIREHOSE_URL?: string;
  /**
   * Optional Worker secret sent as an `Authorization: Bearer` header when
   * present. Never echo this value into a response body or a log line.
   */
  JUDGE_INGEST_TOKEN?: string;
  /**
   * Shared HMAC secret for `x-firehose-signature`. When set, every packet POST
   * is signed with HMAC-SHA256 of the exact JSON body (lowercase hex). Never
   * echo this value into a response body or a log line.
   */
  FIREHOSE_SECRET?: string;
  /** Comma-separated demo origins allowed to call the emit API. */
  DEMO_ORIGIN_ALLOWLIST?: string;
  /**
   * Optional Workers AI binding declared in `wrangler.jsonc`. Used only by
   * the chaos scenario when the emit request sets `llm`; absent locally and
   * in tests, where the template path is taken instead.
   */
  AI?: AiBinding;
}

/** Validated, normalized producer configuration. */
export interface FirehoseConfig {
  /** Ingest URL with any trailing slash removed so path joining is unambiguous. */
  readonly judgeFirehoseUrl: string;
  /** Present only when `JUDGE_INGEST_TOKEN` was set to a non-blank value. */
  readonly judgeIngestToken?: string;
  /** Present only when `FIREHOSE_SECRET` was set to a non-blank value. */
  readonly firehoseSecret?: string;
  /** Parsed allowlist; a single `*` entry means any origin (development only). */
  readonly demoOriginAllowlist: readonly string[];
}

/** Default demo origin used when `DEMO_ORIGIN_ALLOWLIST` is absent. */
export const DEFAULT_DEMO_ORIGIN_ALLOWLIST: readonly string[] = ["https://who.github.io"];

/** Hosts for which a plain `http:` ingest URL is tolerated for local development. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Raised when the Worker environment is missing or malformed. `variable`
 * names the offending binding so the operator knows what to fix.
 */
export class ConfigError extends Error {
  readonly variable: keyof FirehoseEnv;

  constructor(variable: keyof FirehoseEnv, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

/** Treats `undefined`, empty, and whitespace-only strings as unset. */
function presence(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.trim() === "" ? undefined : value;
}

function resolveIngestUrl(raw: string | undefined): string {
  const value = presence(raw);
  if (value === undefined) {
    throw new ConfigError(
      "JUDGE_FIREHOSE_URL",
      "is required; set it to the absolute HTTPS URL of the otel-judge Worker ingress",
    );
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError("JUDGE_FIREHOSE_URL", `is not an absolute URL: ${JSON.stringify(value)}`);
  }

  if (url.protocol !== "https:") {
    if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname)) {
      throw new ConfigError(
        "JUDGE_FIREHOSE_URL",
        `must use https (plain http is only allowed for localhost), got ${url.protocol}//${url.host}`,
      );
    }
  }

  return url.href.replace(/\/+$/, "");
}

/** Parses the demo origin allowlist on its own so CORS works even when the ingest URL is unset. */
export function resolveAllowlist(raw: string | undefined): readonly string[] {
  const value = presence(raw);
  if (value === undefined) {
    return [...DEFAULT_DEMO_ORIGIN_ALLOWLIST];
  }
  const origins = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return origins.length > 0 ? origins : [...DEFAULT_DEMO_ORIGIN_ALLOWLIST];
}

/**
 * Reads and validates the producer configuration from the Worker environment.
 *
 * Throws `ConfigError` rather than returning a partial object so callers fail
 * loudly on a missing or malformed `JUDGE_FIREHOSE_URL`.
 */
export function resolveConfig(env: FirehoseEnv): FirehoseConfig {
  const judgeFirehoseUrl = resolveIngestUrl(env.JUDGE_FIREHOSE_URL);
  const demoOriginAllowlist = resolveAllowlist(env.DEMO_ORIGIN_ALLOWLIST);
  const judgeIngestToken = presence(env.JUDGE_INGEST_TOKEN);
  const firehoseSecret = presence(env.FIREHOSE_SECRET);

  const base: FirehoseConfig = { judgeFirehoseUrl, demoOriginAllowlist };
  return {
    ...base,
    ...(judgeIngestToken === undefined ? {} : { judgeIngestToken }),
    ...(firehoseSecret === undefined ? {} : { firehoseSecret }),
  };
}
