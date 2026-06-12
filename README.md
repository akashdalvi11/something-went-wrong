# Something Went Wrong

> *Checkout fails. The screen says "something went wrong." The backend already knows exactly what happened — and so does the user, 5 seconds later.*

A working ecommerce store where failures explain themselves using distributed telemetry and an AI agent grounded in real observability data.

**Live demo:** [34.82.29.34:8000/dk](http://34.82.29.34:8000/dk) · Built at a hackathon, June 2026.

---

## Inspiration

Every ecommerce site has the same dead end: checkout fails and the screen says "something went wrong." What struck us is that at that exact moment, the answer already exists — the backend just caught the exception, and Dynatrace has the request's full distributed trace. It even knows whether this is one unlucky request or an outage hitting everyone. All of that information stops one layer before the only person who actually needs it: the user staring at the error. We wanted to close that last gap.

---

## What It Does

**Something Store** is a working ecommerce store (Medusa v2 + Next.js) where failures explain themselves. On any unhandled 5xx, the backend captures the exception and the request's W3C trace id, stores an incident, and returns the normal error — plus an `incident_id`. A chat assistant opens automatically and the user gets two messages:

- **First look (~5 seconds):** generated from the exception alone — what failed, the immediate consequence ("no charge was made"), what to do now.
- **Confirmed (~40 seconds):** an agent queries that exact trace in Dynatrace via DQL, reads the failing span and its recorded exception, and checks open Davis problems for wider impact. It delivers a verdict with an honest fault classification: `USER`, `SYSTEM`, or `BOTH`.

The problem check is what changes everything: a payment timeout reads as *"our payment service timed out on your request"* — unless Davis has an open problem on payment failures, in which case the user hears *"this is an ongoing issue affecting other customers, nothing you did, your card was not charged."* Each explanation also produces an internal report with the real stack trace and evidence for support.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Storefront | Next.js 15 (App Router) |
| Backend | Medusa v2.15.5 (Node.js, Turbo monorepo) |
| Database | PostgreSQL 16 + Redis 7 |
| Tracing | OpenTelemetry → Dynatrace Grail (OTLP) |
| AI Agent | Google ADK `LlmAgent` + Gemini 2.5 Flash |
| Agent hosting | Vertex AI Agent Engine |
| Agent tools | Dynatrace-hosted remote MCP server (`execute-dql`, problem queries) |
| Anomaly detection | Davis anomaly detector (custom Python span counter) |
| Infrastructure | GCE VM (`us-west1`), Docker Compose |

---

## How We Built It

**Store:** Medusa v2 with OpenTelemetry (`registerOtel`) exporting traces straight to Dynatrace Grail; a Next.js storefront with a persistent chat assistant that polls for explanation upgrades.

**Failure injection:** Real bugs behind runtime toggles — a promo code that hits an unhandled `TypeError`, a payment provider that exceeds the client timeout, an inventory race.

**Incident pipeline:** A global error handler persists incidents (trace id + exception + safe request context) and fire-and-forgets two agent calls — the error path never waits on the agent.

**Agent:** Google ADK `LlmAgent` (Gemini 2.5 Flash) deployed on Vertex AI Agent Engine, with an `McpToolset` connected to the Dynatrace-hosted remote MCP server for `execute-dql` and problem queries, and a strict structured output schema.

**Detection:** A Davis anomaly detector counts failed payment spans per minute and opens a real Dynatrace problem on a spike — the same problem the agent reads.

**Observability of the explainer itself:** The agent exports its own OTel traces to the same tenant, so one dashboard shows store failures next to agent runs, time-to-explanation per phase, and token usage.

---

## Getting Started (Local Dev)

### Prerequisites

- Docker + Docker Compose
- Python 3.11+ with `venv`
- A Dynatrace environment (Platform Token + OTLP ingest token)
- A GCP project with Vertex AI enabled (for the deployed agent)

### Setup

```bash
# 1. Clone and configure environment
cp .env.example .env
# Fill in DT_ENVIRONMENT_NAME, DT_PLATFORM_TOKEN, DT_OTLP_INGEST_TOKEN, GCP_PROJECT_ID

# 2. Start the store (Medusa + storefront + Postgres + Redis)
docker compose --profile app up -d

# 3. (First run only) Run DB migrations
docker compose exec medusa sh -c "cd apps/backend && npx medusa db:migrate"
```

The storefront is at [localhost:8000/dk](http://localhost:8000/dk), the backend at [localhost:9000](http://localhost:9000), and the admin UI at [localhost:9000/app](http://localhost:9000/app) (`admin@sww.local` / `supersecret`).

### Agent

The agent is deployed on Vertex AI Agent Engine and called automatically when `AGENT_ENGINE_RESOURCE` is set in `.env`. To run the agent locally instead:

```bash
cd agent
python -m venv .venv && .venv/bin/pip install -r requirements.txt
# Comment out AGENT_ENGINE_RESOURCE in .env, then:
.venv/bin/adk api_server --host 0.0.0.0 --port 8001 .
```

### Triggering a failure

Use the promo code `SAVE-NULL` at checkout — it hits a real null-deref `TypeError` and triggers the full incident + explanation flow. Payment timeout and inventory race can be toggled at `POST /admin/chaos`.

---

## Challenges We Ran Into

**Failure traces silently vanishing:** Medusa's default `SimpleSpanProcessor` blew its concurrent-export limit exactly when a request crashed — successful traces arrived, failure traces didn't. Switching to a `BatchSpanProcessor` fixed the one category of trace we needed most.

**DQL type strictness:** `trace.id` is a `uid` — `filter trace.id == "<hex>"` silently matches nothing; it must be `toUid("<hex>")`. The agent's prompt now carries canonical query templates.

**Ingest lag vs. waiting users:** Traces take 15–60s to become queryable. The two-phase design exists because of this — comfort comes from the exception in seconds; only the confirmed verdict waits, with a retry-until-the-trace-appears loop.

**Young plumbing:** Agent Engine's container failed to start until we found it runs `adk api_server --a2a` (needs `google-adk[a2a]`); its streaming endpoint returns newline-delimited JSON even when you ask for SSE; Vertex's shared quota threw transient 429s that needed retries to stop killing phase B.

**Hidden SSL masking in Medusa's DB layer** turned simple misconfigurations into blank pages and `KnexTimeoutError`s that took real spelunking to attribute.

---

## Accomplishments We're Proud Of

- The full loop runs with no human anywhere: checkout fails → grounded first message in ~5s → trace-confirmed verdict with correct fault in ~40s.
- The agent genuinely changes its answer based on distributed context — same exception, different verdict when a real Davis problem is open. That's not a template; it's the telemetry talking.
- Honesty as a design rule that held: the agent only claims what the telemetry shows, says "no charge was made" only when the trace supports it, and admits "this part was our bug" on `BOTH` verdicts — with a sanitizer backstop so internals never leak to users.
- The explainer is itself observable in the platform it queries.

---

## What We Learned

- Decoupling comfort from root cause is the unlock: users need something true in seconds, and something complete can follow.
- The exception tells you what broke; only telemetry tells you for whom. Fault classification lives entirely in that second question.
- Grounding an LLM in tools is mostly prompt discipline: canonical queries, an explicit fault rubric, and "never invent a cause" rules did more than any model setting.
- Observability data is underused as a user-facing asset — it's all there, just never routed to the person affected.

---

## What's Next

- Finish full deployment (store on a GCE VM; Platform Token into Secret Manager).
- Replace polling with server-sent events, and add a support-facing view of internal reports linked to traces.
- Cover more failure classes (inventory races, malformed input, dependency outages are already injectable) and let the agent file the bug it just diagnosed — with the trace attached.
- Long-term: make this a drop-in middleware for any OTel-instrumented store — if your telemetry can explain a failure, your users should hear it.

---

## Project Structure

```
something-went-wrong/
├── backend/          # Medusa v2 monorepo (Node.js)
│   └── apps/backend/ # Medusa app — incident module, chaos, OTel
├── storefront/       # Next.js storefront + incident assistant UI
├── agent/            # Google ADK agent (Gemini 2.5 Flash + Dynatrace MCP)
├── dynatrace/        # Davis anomaly detector
├── scripts/          # Dev helpers (order placement, failure warmup)
├── deploy/           # GCE deployment config
└── docker-compose.yml
```
