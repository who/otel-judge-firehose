# Packet contract alignment

This document maps every field the firehose producer emits to the Judge
packet contract described in the `otel-judge` PRD under "Packet contract
(MVP intent)". It exists so a Judge-side change is caught by a reviewer
reading one page, not by a runtime rejection. The in-repo Zod schema in
`src/packet/schema.ts` is the local source of truth; this page is its
human-readable twin, and `test/docs.test.ts` fails when the two drift.

Contract version: `PACKET_SCHEMA_VERSION` is `"1"`.

## Transport decision

The producer posts **compact normalized packets** as JSON. It does not emit
raw OTLP, and the OTLP adapter on the Judge Worker ingress is unused by this
producer. Reasons:

- The Judge Agent only ever sees the normalized contract, so translating
  OTLP on the way in would add a lossy step this producer can skip.
- A fixture or chaos generator already knows the aggregate signals it wants
  the Judge to see; there is no raw telemetry to derive them from.
- The demo can inspect the exact payload the Judge receives.

Each packet is its own HTTP POST to the configured ingest URL with
`content-type: application/json` and the packet as the body. When an ingest
token is configured it travels as an `Authorization: Bearer` header. One
packet per request means one unique `packet_id` per request, which is what
the Judge dedupes on. Transient failures (network errors, 429, 5xx) are
retried a bounded number of times; any other non-2xx status is final.

There is no shared npm package. The three repositories are separate, with no
monorepo and no publishing pipeline, so cross-repo agreement is carried by
this document and the schema together. A Judge-side change is reconciled by
editing both in the same commit.

## Field table

Every top-level field is required unless marked optional. Field names are
snake_case and match the Judge PRD exactly. Unknown keys are stripped on
parse rather than rejected, so a Judge-side addition never breaks this
producer.

| Field | Type | Bounds | Judge-side meaning |
|---|---|---|---|
| `packet_id` | string | matches `pkt_<scenario>_<epochMillis>_<6 base36>` (see below) | Dedupe key; unique per POST (PRD FR3) |
| `service` | string | non-empty after trim | Logical service the signals describe; names the Agent instance the packet routes to |
| `env` | enum | one of `prod`, `staging`, `dev` | Deployment environment; closed set by design |
| `window` | object | `start` and `end` are ISO 8601 UTC timestamps with `Z` suffix; `end` strictly after `start` | Observation window the signals were aggregated over |
| `signals` | object | six numeric members, listed below | Aggregate health signals the Judge evaluates |
| `top_spans` | array of `{ name, count, p95_ms }` | may be empty; `name` non-empty, `count` integer at least 0, `p95_ms` 0 to 3,600,000 | Most notable spans in the window; empty means nothing to escalate |
| `exemplar_trace_ids` | array of string | each a 32-character hex trace id (W3C / OpenTelemetry) | Traces a human can open from the board |
| `recent_deploy` | object or `null` | required; `{ sha, version, deployed_at }` with non-empty strings and an ISO 8601 UTC `deployed_at`, or `null` for "no recent deploy" | Evidence for the `deploy_related` and `root_cause_family` questions |
| `alert_labels` | array of string | may be empty | Alert names firing in the window; volume feeds `noise_likely` |
| `log_snippets` | array of string | optional; omit rather than send an empty array when there is nothing to say | Free-text context for the narrative judge |

### `signals` members

| Field | Type | Bounds | Judge-side meaning |
|---|---|---|---|
| `error_rate` | number | 0 to 1 | Fraction of requests that failed in the window |
| `error_rate_baseline` | number | 0 to 1 | Same fraction over the baseline period |
| `p95_latency_ms` | number | 0 to 3,600,000 | 95th percentile latency in the window, milliseconds |
| `p95_latency_baseline_ms` | number | 0 to 3,600,000 | 95th percentile latency over the baseline period |
| `slo_burn_rate` | number | 0 to 10,000 | Error-budget burn rate; 1 means burning exactly at budget |
| `request_rate` | number | 0 to 1,000,000 | Requests per second observed in the window |

The upper bounds on latency and rates exist to catch unit mistakes, such as
seconds passed where milliseconds were meant. They are producer-side guards,
not Judge limits.

### `recent_deploy` members

| Field | Type | Bounds |
|---|---|---|
| `sha` | string | non-empty; a commit identifier |
| `version` | string | non-empty; a human-readable release label |
| `deployed_at` | string | ISO 8601 UTC timestamp with `Z` suffix |

`null` and absent are different. `null` states "no recent deploy" explicitly
and is valid; a missing `recent_deploy` key fails validation, because it
means the generator forgot the field.

## Identifier format

`packet_id` is minted by `mintPacketId()` in `src/packet/id.ts` and has four
underscore-separated segments:

```
pkt_<scenario>_<epochMillis>_<six base36 characters>
pkt_healthy_1758480000000_k3f9zq
```

- `pkt_` is a fixed prefix.
- `<scenario>` is the registered scenario id, lowercased, with every character
  outside `a-z`, `0-9`, and `_` replaced by `_`. An empty scenario falls back
  to `unknown`.
- `<epochMillis>` is the mint time in milliseconds since the Unix epoch, which
  makes ordering obvious in logs.
- The suffix is six characters drawn from `0-9a-z` using the Workers CSPRNG,
  or from the seeded generator when a demo requests reproducible output.

Uniqueness guarantee: the millisecond timestamp plus a six-character base36
suffix gives roughly 2.2 billion distinct values per millisecond, so
collisions within one emit run are effectively impossible. The producer does
not deduplicate against previously emitted identifiers; the Judge owns
dedupe per its own PRD. The pattern is enforced by `PACKET_ID_PATTERN` in the
schema, so the minting code and the schema must change in the same commit.

## Versioning rule

- Only additive, optional fields may be added under the current version. A
  new optional field lets an older Judge deployment keep parsing.
- Renaming a field, removing a field, changing a type, tightening a bound, or
  changing a field's meaning is a breaking change and bumps
  `PACKET_SCHEMA_VERSION`.
- The version is not carried inside the packet today. It is a constant the
  producer exports so the Judge can compare against its own expectation when
  the two repositories are reconciled.

## Mapping to the Judge questions map

The Judge PRD defines five questions. Each field below informs at least one
of them; the Judge decides how, and nothing here is a hard gate.

| Question key | Informed by |
|---|---|
| `severity` | `signals.error_rate` vs `signals.error_rate_baseline`, `signals.p95_latency_ms` vs `signals.p95_latency_baseline_ms`, `signals.slo_burn_rate`, `env` |
| `needs_human` | `signals.slo_burn_rate`, `alert_labels`, `exemplar_trace_ids`, `log_snippets` |
| `deploy_related` | `recent_deploy` relative to `window`, `top_spans` |
| `noise_likely` | `alert_labels` volume against the `signals` deltas, `signals.request_rate` |
| `root_cause_family` | `recent_deploy`, `top_spans`, `log_snippets`, `signals.request_rate` |

## Configuration placeholders

The ingest URL is supplied through the `JUDGE_FIREHOSE_URL` binding and the
optional token through `JUDGE_INGEST_TOKEN`. Neither value belongs in this
repository or in this document. Use placeholders such as
`https://judge.example.invalid/firehose` in examples.
