# PRD — who/otel-judge-firehose

**Status:** Draft for beads decomposition (source of truth for build)  
**Repo:** `who/otel-judge-firehose`  
**Depends on:** Ingest contract / Worker firehose URL from `who/otel-judge`  
**Consumed by:** `who/otel-judge-demo` Emit controls (and any real collectors later)  
**Not submitted** as the Cloudflare application GitHub URL  
**Historical decisions log:** `who/otel-judge` → `docs/DESIGN.md`

---

## Problem

The Agent is **consume-only**. Demos and tests still need a **packet producer** that can emit realistic and chaos-engineered OTel-derived packets into the Agent’s firehose. That producer must not live inside the Agent class, and should not bloat the Pages demo into an LLM service.

## Goals

1. Own all **generation** of packets (fixtures + LLM/chaos scenarios).  
2. Emit into `otel-judge` Worker firehose ingress using the **normalized packet contract** (or OTLP that the Worker adapter normalizes — prefer compact packet if simpler for MVP).  
3. Support demo controls: scenario mix, rate/burst, pause, single-shot emit.  
4. Keep secrets off GitHub Pages — any LLM calls for chaos happen in this producer’s Worker (or offline fixtures), not in the browser.  

## Non-goals

- Jev / Llama **judge** evaluate loop  
- Agent SQLite / board `setState`  
- GitHub Pages UI chrome  
- Being the CF submit repo  

## Vocabulary

| Term | Meaning |
|---|---|
| **Packet** | Normalized evaluation unit defined by `PRD-otel-judge` |
| **Fixture producer** | Deterministic canned packets (healthy, burn, deploy regression, noise) |
| **Chaos producer** | LLM-assisted (or scripted) randomized but schema-valid packets |
| **Firehose** | HTTP ingest path on `otel-judge` Worker that routes to the Agent |

## Ownership (normative)

### This repo owns

- Fixture library (deterministic packets + optional OTLP samples)  
- Chaos generator (Workers AI or other LLM behind a small Worker/API — **not** the Judge Agent)  
- Emit API used by demo: e.g. `POST /emit` with `{ scenario, count }` → posts packets to Judge firehose  
- Rate/burst helpers for demos  
- README: how to point at Judge Worker ingest URL  

### This repo does not own

- Agent evaluate / Jev / Llama judge  
- Pages board  
- CORS policy for Pages→Judge (Judge Worker door) except documenting required ingest auth if any  

## Relationship to other PRDs

```
otel-judge-firehose  --packets-->  otel-judge (Worker ingress → Agent)
otel-judge-demo      --Emit UI-->  otel-judge-firehose  (and/or watches Agent via useAgent)
```

Demo **triggers** this producer; it does not implement chaos LLM logic in the browser.

## Requirements

### Functional

- FR1: Emit at least four fixture scenarios: healthy, post-deploy burn, dependency timeouts, noise storm  
- FR2: Optional chaos mode produces schema-valid packets via LLM or randomized templates  
- FR3: Each emit results in one or more POSTs to Judge firehose with unique `packet_id`s  
- FR4: Demo can call producer with scenario + count without holding Judge secrets  
- FR5: Document packet field alignment with Judge packet contract  

### Non-functional

- NFR1: No TypeSafe/Jev keys in this repo (Judge-only)  
- NFR2: If LLM chaos needs a key/binding, it lives in **this** producer’s Worker secrets — never Pages  
- NFR3: Generator code never imported by Agent package  

## Acceptance criteria

- [ ] Fixture emit → visible packet progression on demo board against live Judge  
- [ ] Chaos/fixture modes selectable from demo Emit controls  
- [ ] README documents Judge firehose base URL config  
- [ ] Schema validation rejects malformed generator output before POST  
- [ ] Confirmed: zero Agent-class coupling  

## Beads decomposition (epics)

1. **Scaffold** — repo, config for Judge ingest URL  
2. **Fixtures** — four scenarios, packet_id minting  
3. **Emit API** — HTTP handler demo can call; forwards to Judge firehose  
4. **Chaos** — LLM or template randomizer behind same API  
5. **Docs** — contract alignment + demo wiring  

## Open questions

- Prefer posting **compact packets** directly vs raw OTLP into Judge’s OTLP adapter  
- Host producer as Cloudflare Worker vs Node script for MVP (Worker recommended for Pages→HTTPS)  
- Shared packet Zod/JSON schema package vs duplicated schema docs  

## Ship / prompt history

Not the CF submit surface. Ortus logs for this repo may stay gitignored unless we later want a public trail; **Agent repo** owns application `PROMPT_HISTORY.md`.
