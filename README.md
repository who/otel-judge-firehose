# otel-judge-firehose

A Cloudflare Worker that produces normalized OpenTelemetry-derived judge
packets and posts them into the `otel-judge` Worker firehose. It exists so
the demo board and any test rig can drive realistic and chaos-engineered
traffic at the Judge without the Judge Agent generating its own input and
without the browser ever holding a Judge secret.

Every packet this Worker emits follows the field contract in
[`docs/PACKET_CONTRACT.md`](docs/PACKET_CONTRACT.md). Read that page for
what each field means to the Judge; this page covers how to configure, run,
deploy, and call the producer.

## What this repository owns

- The deterministic fixture library: four canned scenarios plus a seeded
  chaos randomizer, all validated against the packet schema before they
  leave the generator.
- The emit API the demo calls: `POST /emit` with a scenario and a count,
  which forwards packets to the Judge firehose.
- Rate and burst pacing for demo runs.
- This README, which documents how to point the producer at a Judge Worker
  ingress URL.

## What this repository does not own

- The Judge evaluate loop, its LLM judge, and its board state. Those live in
  `otel-judge`.
- The demo board UI. That lives in `otel-judge-demo`, which only triggers this
  producer.
- The Judge Worker's own CORS and ingest policy. This page documents the
  ingest authorization the Judge may require, nothing more.
- Any Judge-side API key. This repository carries no Judge secrets; see
  [Environment variables](#environment-variables).

## Environment variables

The Worker reads exactly three bindings. `resolveConfig()` in
`src/config.ts` validates them, and the health probe reports whether the
result is usable.

| Variable | Kind | Required | Meaning |
|---|---|---|---|
| `JUDGE_FIREHOSE_URL` | Wrangler `vars` entry | yes | Absolute HTTPS URL of the `otel-judge` Worker firehose ingress. Plain `http:` is accepted only for `localhost`, `127.0.0.1`, and `[::1]`. A trailing slash is stripped. |
| `JUDGE_INGEST_TOKEN` | **Worker secret** | no | When set, every packet POST carries it as an `Authorization: Bearer` header. It is never echoed into a response body or a log line. |
| `DEMO_ORIGIN_ALLOWLIST` | Wrangler `vars` entry | no | Comma-separated browser origins allowed to call the emit API cross-origin. Defaults to the demo's GitHub Pages origin, `who.github.io` over HTTPS. A single `*` allows any origin and is a development-only setting. |

`JUDGE_INGEST_TOKEN` is a secret. It is set with the Wrangler secret command
and is deliberately absent from `wrangler.jsonc`, so it is never committed:

```sh
npx wrangler secret put JUDGE_INGEST_TOKEN
```

The other two variables are plain configuration and live in the `vars`
block of `wrangler.jsonc`. The committed values there are placeholders;
override them per deployment.

The demo holds only the public URL of this Worker. It never sees
`JUDGE_FIREHOSE_URL` or the ingest token, and this producer never places a
Judge secret in a CORS header or a response.

## Local development

```sh
npm install
cp -f .dev.vars.example .dev.vars   # then edit the values
npm run dev                          # wrangler dev on http://localhost:8787
```

`.dev.vars` is git-ignored and is where local values for all three
variables go, the token included. Point `JUDGE_FIREHOSE_URL` at a locally
running Judge Worker over `http://localhost:8787` or at a staging ingress
over HTTPS.

Checks:

```sh
npm test            # vitest, no network
npm run typecheck   # tsc --noEmit
```

## Deployment

1. Set `JUDGE_FIREHOSE_URL` and `DEMO_ORIGIN_ALLOWLIST` in the `vars` block of
   `wrangler.jsonc`.
2. Deploy:

   ```sh
   npm run deploy
   ```

3. If the Judge ingress requires a bearer token, store it as a Worker secret
   after the first deploy:

   ```sh
   npx wrangler secret put JUDGE_INGEST_TOKEN
   ```

4. Confirm the wiring:

   ```sh
   curl https://firehose.example.invalid/health
   ```

   `judgeConfigured` is `true` when the ingest URL validated.

## HTTP API

All responses are JSON with `content-type: application/json`. Unknown paths
answer `404` with `{ "ok": false, "error": "not_found", "path": "..." }`, and
a wrong method answers `405` with `{ "ok": false, "error": "method_not_allowed" }`.

`GET /scenarios` and `POST /emit` are the demo-facing routes. Both answer an
`OPTIONS` preflight with `204`, and any response to an allowlisted `Origin`
carries `access-control-allow-origin` (reflecting the origin),
`access-control-allow-methods: GET, POST, OPTIONS`,
`access-control-allow-headers: content-type`, and a ten-minute
`access-control-max-age`. A non-allowlisted origin gets the response with no
CORS headers, so the browser blocks it while `curl` keeps working.

### GET /health

Liveness probe. Does not call the Judge.

```sh
curl https://firehose.example.invalid/health
```

```json
{ "ok": true, "service": "otel-judge-firehose", "judgeConfigured": true }
```

The body carries `ok`, the `service` name, and `judgeConfigured`, which is
`false` when `JUDGE_FIREHOSE_URL` is missing or malformed. The body never
contains the URL or the token.

### GET /scenarios

Lists every registered scenario in the order the Emit control should show
them.

```sh
curl https://firehose.example.invalid/scenarios
```

```json
{
  "scenarios": [
    { "id": "healthy", "description": "Service inside its objective: ..." },
    { "id": "post_deploy_burn", "description": "Regression minutes after a release: ..." },
    { "id": "dependency_timeouts", "description": "Upstream dependency timing out ..." },
    { "id": "noise_storm", "description": "Alert noise, not an incident: ..." },
    { "id": "chaos", "description": "Randomized: seeded template draws ..." }
  ]
}
```

The `scenarios` array is in registration order, and each entry carries the
stable `id` and a human `description`. Descriptions are abbreviated above;
the route returns the full text.

### POST /emit

Generates `count` packets for `scenario`, validates them, and posts each one
to the Judge firehose as its own HTTP request. The body is parsed by
`EmitRequestSchema` in `src/emit/handler.ts`; unknown keys are ignored.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `scenario` | string | required | A scenario `id` from `GET /scenarios`. |
| `count` | integer 1 to 50 | `1` | Packets to generate. |
| `seed` | string | none | When present, every random draw and the clock are pinned, so the same seed and count always produce byte-identical packets, identifiers included. |
| `dryRun` | boolean | `false` | Generate and validate but post nothing. Lets the demo prove its wiring without touching the Judge. |
| `intervalMs` | integer 0 to 2000 | none | Gap between bursts in milliseconds. Omitted means no pacing. |
| `burst` | integer 1 to 10 | none | Packets per burst. Omitted means the whole count in one burst. |

An `llm` field is not yet accepted. The `chaos` scenario is currently the
seeded template randomizer; a Workers AI path is planned behind the same
route and will fall back to the template when the model output is invalid.

Request body, with every field present:

```json
{ "scenario": "healthy", "count": 3, "seed": "demo-run-1", "dryRun": false, "intervalMs": 500, "burst": 1 }
```

Sent with curl:

```sh
curl -X POST https://firehose.example.invalid/emit \
  -H 'content-type: application/json' \
  -d '{ "scenario": "healthy", "count": 3, "intervalMs": 500, "burst": 1 }'
```

Response, HTTP `200`:

```json
{
  "ok": true,
  "scenario": "healthy",
  "requested": 3,
  "generated": 3,
  "accepted": 3,
  "dryRun": false,
  "packetIds": [
    "pkt_healthy_1758456000000_k3f9zq",
    "pkt_healthy_1758456000000_8m2xv1",
    "pkt_healthy_1758456000000_c0dq7e"
  ],
  "results": [
    { "packetId": "pkt_healthy_1758456000000_k3f9zq", "accepted": true, "status": 202, "attempts": 1 },
    { "packetId": "pkt_healthy_1758456000000_8m2xv1", "accepted": true, "status": 202, "attempts": 1 },
    { "packetId": "pkt_healthy_1758456000000_c0dq7e", "accepted": true, "status": 202, "attempts": 2 }
  ],
  "truncated": false,
  "elapsedMs": 1043
}
```

- `ok` is always `true` on a `200`; a failed run is reported per packet, not
  as a failed request.
- `requested` is the count asked for, `generated` the packets that passed
  validation, and `accepted` the packets the Judge answered with a 2xx.
- `packetIds` lists every generated identifier in order, dry run included,
  so the demo can match them against the board.
- `results` has one entry per posted packet, keyed by `packetId`. A rejected
  packet still yields HTTP `200` with `accepted: false`, the final `status` when there was one,
  the `attempts` made, and an `error` string. A network rejection, a `429`,
  or a `5xx` is retried up to two more times with a short backoff; any other
  non-2xx status is final.
- `truncated` is `true` when the 20-second wall-clock ceiling on a paced run
  cut it short. The counts describe what was actually sent.
- `elapsedMs` is the time from the first burst to the last result.
- A dry run returns `accepted` as `0`, an empty `results`, and `elapsedMs`
  as `0`.

Error responses:

| Status | `error` | When |
|---|---|---|
| `400` | `invalid_json` | The body is not a JSON object. |
| `400` | `invalid_request` | The body fails the schema; `issues` lists `{ "field", "message" }` pairs. |
| `400` | `unknown_scenario` | `scenario` is not registered; `known` lists the valid identifiers. |
| `500` | `packet_validation_failed` | A generator produced an invalid packet. The packet payload is not returned. |
| `503` | `judge_not_configured` | `JUDGE_FIREHOSE_URL` is missing or malformed; `variable` names the binding to fix. |

## Scenarios

The identifiers are a contract with the demo Emit control and are fixed.

- `healthy`: service inside its objective, error rate near 0.1%, latency at
  baseline, burn rate below 0.5, no recent deploy.
- `post_deploy_burn`: regression minutes after a release, error rate 10 to
  30 times baseline, p95 latency 2 to 4 times baseline, burn rate above 4,
  populated `recent_deploy`.
- `dependency_timeouts`: an upstream dependency timing out while the service
  itself is healthy, p95 latency near a 3 second timeout ceiling, upstream
  client span leading, no recent deploy.
- `noise_storm`: alert noise rather than an incident, signals at or near
  baseline, many low-count spans and a long list of flapping alert labels.
- `chaos`: seeded template randomizer that draws the service, environment,
  signal profile, span mix, and alert labels afresh per packet, with about
  one packet in four carrying a recent deploy. Reproducible with a `seed`.

Descriptions are served verbatim by `GET /scenarios`, which is the source of
truth for the Emit control's picker.

## Demo wiring

```
otel-judge-demo (Emit control)  --POST /emit-->  otel-judge-firehose  --one POST per packet-->  otel-judge (firehose ingress -> Agent)
```

1. The demo is configured with the public URL of this Worker and nothing
   else. It reads `GET /scenarios` to populate the scenario picker.
2. A click on Emit sends `POST /emit` with the chosen `scenario`, `count`,
   and optional `intervalMs` and `burst`. The demo's origin must be in
   `DEMO_ORIGIN_ALLOWLIST` or the browser will block the call.
3. This Worker generates and validates the packets, then posts each one to
   `JUDGE_FIREHOSE_URL`, attaching the ingest token when one is configured.
4. The Judge dedupes on `packet_id` and routes the packet to the Agent, and
   the board updates through the demo's own connection to the Judge.

**Pause is client-driven.** There is no pause endpoint and no server-side
run state. Each emit request is a self-contained run bounded by the count
and the wall-clock ceiling, and a paused demo simply stops issuing emit
requests. To keep a board filling continuously, the demo issues repeated
paced requests; to stop, it stops.

## Repository layout

- `src/index.ts`: request routing for `/health`, `/scenarios`, and `/emit`.
- `src/config.ts`: environment validation.
- `src/emit/`: the emit handler, the Judge client with retries, and pacing.
- `src/fixtures/`: the scenario registry and the four deterministic builders.
- `src/chaos/`: the seeded chaos template.
- `src/packet/`: the packet schema, identifier minting, and validation.
- `docs/PACKET_CONTRACT.md`: field-by-field alignment with the Judge contract.
- `test/docs.test.ts`: keeps this README and the contract document in step
  with the code.
