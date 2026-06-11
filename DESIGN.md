# "Something Went Wrong" — Design Document

An AI agent that turns generic ecommerce error screens into calm, honest,
root-cause-aware explanations, using telemetry already flowing into Dynatrace.

## 1. The idea, restated precisely

When an unhandled failure occurs in the ecommerce backend, the user normally
sees "something went wrong" and nothing else. Instead:

1. The backend still fails fast and returns a generic error — but it also
   captures the **trace id** of the failed request *and the exception
   itself*, and emits an *incident event* to an AI agent.
2. The agent responds in **two phases**:
   - **Phase A — preliminary (~2–5 s):** from the exception payload alone
     (no tools needed), it produces an immediate, grounded holding
     explanation: "Your card was not charged — our payment service timed
     out. We're confirming the details."
   - **Phase B — confirmed (~30–60 s):** it queries Dynatrace (via its
     official MCP server, using DQL) for the spans and logs of that exact
     trace, determines the root cause in distributed context, and classifies
     fault: **USER**, **SYSTEM**, **BOTH**, or **UNKNOWN**. The UI upgrades
     the preliminary message to a confirmed one (or corrects it).
3. The frontend receives a calm, human explanation: what happened, whose
   fault it was, and what the user can do (retry, fix their input, wait).

The value proposition is **transparency**: the user learns whether they did
something wrong, and the system admits its own faults.

**Division of labor between the two phases** (worth articulating when
presenting this): the local exception gives the *proximate* cause ("a null
deref in the promo handler"). Dynatrace gives what no single process can
know — the *distributed* cause ("the promo service has been failing for
everyone for 10 minutes" vs. "only your request hit this"), which is exactly
what determines the fault classification. The MCP/DQL step is not a slow way
to fetch the error; it is the only way to get the context *around* the error.

## 2. Corrections to the original assumptions

| Original assumption | Reality / correction |
|---|---|
| "Backend sends 'something went wrong' to the agent" | Sending the error message alone is useless — the agent needs the **trace id** (W3C trace context) of the failed request as the correlation key to query Dynatrace, plus the **exception payload** the backend already holds (it powers the instant preliminary explanation). The incident event must carry `trace_id`, exception details, route, timestamp, and safe user context. |
| Agent responds while the user waits on the error screen | Telemetry export is batched and Dynatrace ingest adds lag — a trace is typically queryable in Grail in **15–45 s** (budget up to ~2 min for retries). The flow must be **asynchronous and two-phase**: a preliminary explanation from the exception payload arrives in seconds; the Dynatrace-confirmed one follows. The FE polls (or subscribes) and upgrades the message; the agent retries its DQL until the trace appears. Comfort and root cause are decoupled — comfort never waits on ingest. |
| Backend calls the agent as part of error handling | The agent call must be **fire-and-forget** (async HTTP, never awaited in the error path). The error response to the user must never depend on the agent being up. |
| Agent output goes straight to the user | The agent sees stack traces, SQL, internal service names. It must produce **two artifacts**: a sanitized `user_message` (no internals, no blame-dodging, no fabrication) and an `internal_report` (full diagnosis, for a support/admin view). |
| "Google cloud agent platform" | Concretely: **Google ADK (Agent Development Kit, Python)** for the agent + **Gemini via Vertex AI** (uses your credits), deployed on **Vertex AI Agent Engine** — which gives the platform monitoring/tracing of the agent for free. ADK's `McpToolset` connects over streamable HTTP to the **Dynatrace-hosted remote MCP server**, so there is no MCP server to host or spawn anywhere. |
| Dynatrace "is fixed" | Fine — but DQL and the MCP server require a **Dynatrace SaaS tenant with Grail** (the free trial provides this; classic/managed environments do not). |
| Medusa as backend | Good choice, and better than you may have known: **Medusa v2 has built-in OpenTelemetry support** (`instrumentation.ts` + `registerOtel`) tracing HTTP, route handlers, workflows, and DB queries out of the box. |

## 3. Architecture

```
┌──────────────┐  checkout/cart/promo  ┌──────────────────────────┐  OTLP (traces+logs)  ┌────────────────┐
│  Storefront  │ ────────────────────▶ │  Medusa v2 backend       │ ───────────────────▶ │   Dynatrace    │
│  (Next.js)   │ ◀──────────────────── │  (GCE VM)                │                      │   (Grail/DQL)  │
└──────┬───────┘  500 + incident_id    │  + OTel instrumentation  │                      └───────▲────────┘
       │                               │  + incident module       │                              │
       │  GET /store/explanations/{id} │  + explanations (PG)     │                              │ execute_dql,
       │  (poll Medusa directly:       └────────────┬─────────────┘                              │ list_problems, …
       │   pending → preliminary                    │ Agent Engine REST :streamQuery ×2          │
       │   → confirmed)                             │ (phase A, then phase B; bearer = ADC       │
       │                                            │  token from the VM's service account)      │
       │                                            ▼                                            │
       └─────────────────────────────  ┌──────────────────────────┐  streamable HTTP  ┌──────────┴───────────┐
          (Medusa serves the result)   │  Explainer agent         │ ────────────────▶ │  Dynatrace-hosted    │
                                       │  (ADK + Gemini, Vertex   │  bearer = DT      │  remote MCP server   │
                                       │   AI Agent Engine)       │  platform token   │                      │
                                       └──────────────────────────┘                   └──────────────────────┘
```

### Components

1. **Medusa v2 backend** — standard store APIs on a GCE VM, instrumented
   with `instrumentation.ts` / `registerOtel`, exporting OTLP to the
   Dynatrace tenant endpoint (`https://<env>.live.dynatrace.com/api/v2/otlp`).
   Span exception events carry the stack traces the agent will read.

2. **Failure injection module** — deliberate, realistic bugs behind toggles
   (see §5). This is the demo's heart: without controllable failures you
   can't show the agent working.

3. **Incident module** (inside Medusa — there is no separate middle service)
   — a global error-handling middleware plus a small custom module that owns
   the whole explanation lifecycle:
   - on any unhandled 5xx: reads `trace_id`/`span_id` from the active OTel
     context, captures the exception in hand (type, message, stack, failing
     operation), generates an `incident_id` (uuid), persists an incident row
     (status `pending`) in Medusa's own Postgres, and returns the normal
     generic error **plus** `incident_id` to the FE — never blocking, never
     throwing;
   - in the background, invokes the agent **twice** over Agent Engine's REST
     API (`POST …/reasoningEngines/{id}:streamQuery`): phase A with the
     exception payload (result stored as `preliminary` within seconds), then
     phase B (result stored as `confirmed`);
   - exposes `GET /store/explanations/{incident_id}` for the FE to poll;
   - authenticates to Agent Engine with the VM's **attached service account**
     via Application Default Credentials (`google-auth-library` fetches
     tokens from the metadata server automatically — no key files).

4. **Explainer agent** — an ADK `LlmAgent` (Gemini) deployed to **Vertex AI
   Agent Engine** (`agent_engines.create()`), so the platform's tracing and
   monitoring of the agent come for free. Its `McpToolset` connects to the
   **Dynatrace-hosted remote MCP server** via
   `StreamableHTTPConnectionParams(url=…, headers={"Authorization":
   "Bearer <platform token>"})` — nothing to host or spawn, and local dev
   uses the exact same URL. Input is `{phase: "A"|"B", …incident}`; the
   prompt branches: phase A answers from the exception payload alone (no
   tools), phase B runs the DQL investigation. The platform token is
   embedded in the agent file for now — a deliberate prototype shortcut
   (see §7).

5. **Storefront** — Medusa's Next.js starter, plus one reusable
   `<SomethingWentWrong incidentId={…}/>` component: shows the calm holding
   message, polls the Medusa explanations route, renders the preliminary message within
   seconds, then quietly upgrades it when the confirmed one lands (with the
   fault classification visually distinct: "this was on us" vs "here's how to
   fix your input", and a subtle `preliminary`/`confirmed` indicator).

### Agent flow (per incident)

**Phase A — preliminary (target < 5 s, no tools):**

1. First agent invocation (`phase: "A"`): a single fast LLM pass over the
   exception payload + route + scenario context. Output the structured JSON
   below with `status: "preliminary"` and conservative wording (no fault
   verdict stronger than the exception alone supports).
2. The incident module stores it; the FE shows it on its next poll. Comfort
   is now delivered — everything after this is enrichment, not rescue.

**Phase B — confirmed investigation (second agent invocation):**

1. Wait ~15s (ingest lag), then DQL with retry/backoff up to ~3 min:
   `fetch spans | filter trace.id == "<trace_id>"` — until rows appear.
2. Fetch the full trace: spans, status codes, exception events, durations.
   Optionally `fetch logs | filter trace_id == "<trace_id>"`.
3. Reason: which span failed first, what was the exception, was the trigger
   user input, an internal bug, or a dependency (payment provider, DB)?
4. Cross-check `list_problems` for an active Dynatrace problem (e.g.,
   service-wide outage) to distinguish "your request hit a bug" from "we are
   having an incident right now" — the distributed context Phase A cannot see.
5. Return the final JSON with `status: "confirmed"`; the incident module
   replaces the preliminary record. If the trace contradicts the preliminary
   explanation, the confirmed message corrects it; if the trace never
   appears, keep the preliminary message and mark confidence accordingly.

**Structured output (both phases; enforced via ADK output schema):**

```json
{
  "incident_id": "…",
  "status": "preliminary | confirmed",
  "fault": "USER | SYSTEM | BOTH | UNKNOWN",
  "user_message": "Calm, honest, no internals, ≤3 sentences, with a next step.",
  "internal_report": "Root-cause narrative citing the failing span/exception.",
  "evidence": ["exception details (phase A) / span names actually found in telemetry (phase B)"],
  "confidence": "high | medium | low"
}
```

### Guardrails (prototype-level)

- The agent must only claim what the telemetry shows; if the trace never
  appears or is inconclusive → `fault: UNKNOWN`, honest "still investigating"
  message. No invented root causes.
- `user_message` must never contain stack traces, hostnames, table names,
  PII, or secrets — enforced in the prompt and by a regex/deny-list pass in
  the incident module before storing.
- Read-only Dynatrace Platform Token scopes (`storage:spans:read`,
  `storage:logs:read`, `storage:buckets:read`, problem read, plus
  `mcp-gateway:servers:invoke` / `mcp-gateway:servers:read` for the remote
  MCP server) — the agent can query, never mutate.

## 4. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Backend | Medusa v2 (Node) on a GCE VM | Built-in OTel; realistic ecommerce flows for free |
| Storefront | Medusa Next.js starter | Free checkout UI to break |
| Telemetry | OTel SDK → Dynatrace OTLP endpoint | Direct, no collector needed for a prototype |
| Observability | Dynatrace SaaS trial (Grail + DQL) | Fixed requirement; MCP server needs Grail |
| Agent framework | Google ADK (Python) | First-class `McpToolset`, your GCP credits |
| Model | Gemini 2.x Flash via Vertex AI | Cheap/fast; investigation is mostly tool-driven |
| Agent hosting | Vertex AI Agent Engine | Managed runtime; platform tracing/monitoring of the agent for free |
| MCP server | Dynatrace-hosted remote MCP server (streamable HTTP) | Official; `execute_dql`, problems; zero hosting, one bearer Platform Token |
| Medusa → agent auth | VM service account + ADC (`roles/aiplatform.user`) | Zero key management; tokens come from the metadata server |
| Explanation store | Medusa's own Postgres | Already there; FE polls a Medusa route; no extra datastore |

## 5. Failure injection scenarios (the demo script)

Each is a feature flag in a small Medusa plugin/module:

| # | Scenario | Trigger | Expected fault class | What the agent should say |
|---|---|---|---|---|
| 1 | Promo code crash | Promo code `SAVE-NULL` hits an unhandled null deref in a custom promo handler | BOTH | "That promo code isn't valid — but our system should have told you that instead of failing. We've noted the bug. Try checkout without the code." |
| 2 | Payment timeout | Fake payment provider sleeps > client timeout | SYSTEM | "Your card was not charged. Our payment service timed out — please try again in a few minutes." |
| 3 | Inventory race | Stock zeroed between cart and checkout | SYSTEM (state) | "The last unit sold out while you were checking out. Nothing went wrong on your end." |
| 4 | Malformed input 500 | Oversized/invalid address field that validation misses, DB rejects | BOTH | "Your address field is longer than we support — please shorten it. We'll also fix the unclear error." |
| 5 | Dependency down | Toggle that makes an internal service call ECONNREFUSED | SYSTEM | "A part of our system is currently down; your cart is safe. Please retry shortly." |

## 6. Build plan (phased; each phase independently verifiable)

**Phase 0 — Accounts & access (½ day)**
- Dynatrace SaaS trial tenant (confirm Grail). Create an OTLP ingest token
  and a **Platform Token** with the read + `mcp-gateway:*` scopes from §3.
- GCP project, enable Vertex AI, install ADK (`pip install google-adk`).
- Verify the **Dynatrace-hosted remote MCP server** from any MCP client
  (URL + bearer header — nothing to install or run), execute one DQL query
  by hand.

**Phase 1 — Store + telemetry (1–2 days)**
- Scaffold Medusa v2 + Next.js starter locally, seed products.
- Add `instrumentation.ts` with `registerOtel` → Dynatrace OTLP.
- ✅ Verify: place an order, find its trace by `trace.id` in a Dynatrace
  notebook with DQL.

**Phase 2 — Failure injection + incident events (1–2 days)**
- Implement scenarios 1–3 (add 4–5 if time allows).
- Incident module, part 1: incident row in Postgres (status `pending`),
  incident_id + trace_id + exception capture (log the incident JSON for now).
- ✅ Verify: trigger scenario 1, see the exception span event in Dynatrace,
  see the incident row with matching trace_id, FE receives incident_id.

**Phase 3 — The agent, locally (2–3 days; the interesting part)**
- Phase A path first: `phase: "A"` branch — one Gemini pass over an
  exception payload → structured preliminary JSON. (Fast win, no MCP
  involved.)
- Then Phase B: `McpToolset` with `StreamableHTTPConnectionParams` → the
  Dynatrace-hosted remote MCP server (the same URL the deployed agent will
  use). System prompt: investigation procedure, fault rubric, tone rules,
  structured output schema. Retry-until-trace-appears loop.
- ✅ Verify: feed it a real incident (exception + trace_id) from Phase 2 on
  the CLI / `adk web`; preliminary JSON in seconds, then correct fault class
  + sane user_message for all scenarios once the trace is found.

**Phase 4 — End-to-end glue (1–2 days)**
- Incident module, part 2: background phase A + phase B invocations of the
  agent (running locally via `adk api_server` for now), explanation rows
  updated `pending → preliminary → confirmed`,
  `GET /store/explanations/{id}` route.
- FE error component with polling and the preliminary→confirmed upgrade.
- ✅ Verify: full demo — click checkout with `SAVE-NULL`, see a grounded
  preliminary explanation within ~5s, see it upgrade to confirmed ~30–60s
  later.

**Phase 5 — Deploy (1 day)**
- Deploy the agent to Agent Engine (`agent_engines.create()` from a small
  deploy script); note the `reasoningEngines/{id}` resource name.
- GCE VM for Medusa; attach a service account with `roles/aiplatform.user`;
  point the incident module at the Agent Engine REST endpoint — ADC picks up
  credentials from the metadata server with zero config changes.
- Optional stretch: support-facing internal-report view, SSE instead of
  polling, Platform Token into Secret Manager instead of embedded.

## 7. Risks / open questions

- **Ingest latency UX**: largely defused by the two-phase design — a grounded
  preliminary explanation lands in seconds; only the *confirmed* verdict
  waits on ingest (15–60s typical). Mitigations on top: tune the OTel
  `BatchSpanProcessor` schedule delay down (~1s) for the prototype, and keep
  the incident view reachable from order history so nobody has to wait on
  the page.
- **Phase A / Phase B disagreement**: the preliminary explanation may
  occasionally be wrong once distributed context arrives. Keep Phase A
  wording conservative (proximate cause only, no strong fault verdicts) and
  let the confirmed message correct it explicitly — honesty about revision is
  itself part of the transparency story.
- **DQL fluency**: the LLM may write bad DQL. Mitigation: give the prompt 2–3
  canonical query templates (fetch spans/logs by trace id) rather than
  letting it freestyle; the MCP server's `generate_dql_from_natural_language`
  can help during development.
- **Trial tenant limits**: Dynatrace trials expire (~15 days). Plan demo
  recording accordingly, or be ready to re-provision.
- **Young plumbing**: ADK `McpToolset` + remote streamable HTTP + Agent
  Engine is a recent combination with reported rough edges (e.g.
  [adk-python #2615](https://github.com/google/adk-python/issues/2615)).
  Budget friction in Phase 5; everything is testable locally first.
- **Embedded Platform Token**: a deliberate prototype shortcut — anyone with
  the agent source can read your telemetry. Keep the repo private; move to
  Secret Manager before sharing code (Phase 5 stretch).
- **Cost**: negligible — Flash-class model, a handful of tool calls per
  incident; one small GCE VM.
- **Local Node version**: Medusa v2 wants Node ≥ 20.

## 8. What "done" looks like (prototype acceptance)

A screen recording: user applies promo `SAVE-NULL` → checkout fails → within
~5 seconds the screen already says, preliminarily, that the promo code caused
the failure → under a minute later the message upgrades to a confirmed
verdict: the code was invalid *and* the server mishandled it, with the
matching root cause visible in a Dynatrace notebook and the internal report
showing the actual exception — no human in the loop.
