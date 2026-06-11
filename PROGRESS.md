# PROGRESS — context handoff

Project "Something Went Wrong": an AI agent that explains ecommerce failures
to end users using Dynatrace telemetry. **Read DESIGN.md first** — it holds
the architecture, the two-phase explanation flow, and the phased plan.
This file holds the current implementation state.

**Status: Phase 0 ✅, Phase 1 ✅, Phase 2 ✅, Phase 3 ✅ (2026-06-11). Next:
Phase 4 (end-to-end glue — DESIGN.md §6 Phase 4).**

## What exists and runs (all local, all Docker except tools)

| Service | URL / location | Notes |
|---|---|---|
| Medusa v2.15.5 backend | http://localhost:9000 | turbo monorepo at `backend/`, app at `backend/apps/backend/` |
| Admin UI | http://localhost:9000/app | login `admin@sww.local` / `supersecret` |
| Next.js storefront | http://localhost:8000 | starter at `storefront/`, region `/dk` (seed = Europe region) |
| Postgres 16 + Redis 7 | compose services | 139 tables, demo catalog seeded via `db:migrate` migration-scripts |
| Admin HMR | port 24678 | pinned via HMR_* env vars in compose |

- Start: `docker compose --profile app up -d` (dbs alone: `docker compose up -d postgres redis`)
- Place a full test order: `sh scripts/place_order.sh` → prints `ORDER order_…`
- Publishable key (also in `storefront/.env.local`):
  `pk_98cd485c718acd8f25a926e0cff630f1147eb2664f1edfea98471f444a5f9c34`

## Telemetry (verified end-to-end)

- `backend/apps/backend/instrumentation.ts` → `registerOtel` (http, workflows,
  query, db) → OTLP to `https://$DT_ENVIRONMENT_NAME.live.dynatrace.com/api/v2/otlp/v1/traces`
  with `Api-Token $DT_OTLP_INGEST_TOKEN`. `OTEL_BSP_SCHEDULE_DELAY=1000` (1s flush).
- Spans appear in Grail as `service.name == "medusa-backend"` (http +
  middleware + workflow + pg.query spans, correlated by `trace.id`).
- Query via MCP: `agent/.venv/bin/python agent/verify_mcp.py "<DQL>"` — connects
  to the Dynatrace-hosted remote MCP server (streamable HTTP + bearer Platform
  Token from `.env`), lists tools, runs DQL. DQL tool is `execute-dql`, arg
  `dqlQueryString`. Verified: order spans retrieved by DQL ~45s after the order.

## Environment

- `.env` (gitignored, filled): `DT_ENVIRONMENT_NAME`, `DT_PLATFORM_TOKEN`
  (scopes incl. `mcp-gateway:servers:*`, storage read), `DT_OTLP_INGEST_TOKEN`,
  `GCP_PROJECT_ID`, `GCP_REGION`. Template: `.env.example`.
- GCP: project `devpost-hackathon-11`, `aiplatform.googleapis.com` enabled,
  gcloud authed as akashdalvi115@gmail.com (region config us-west1).
- Python: ADK 2.2.0 in `agent/.venv` (`google-adk`, `mcp`, `python-dotenv` —
  note: ADK 2.x does NOT bundle the `mcp` package; it's explicit in
  `agent/requirements.txt`).
- User conventions: runtime deps (Node/Medusa/Postgres) ONLY in Docker; CLI
  tools (gcloud/python/git) native; Python in venv.

## Phase 2 — failure injection + incident module (done, verified)

All inside `backend/apps/backend/`:

- **Incident module** `src/modules/incident/` (registered in
  `medusa-config.ts`): `incident` table (migration applied) with id
  (`inc_<uuid>`, doubles as public incident_id), trace_id/span_id, status
  `pending|preliminary|confirmed`, error type/message/stack, route, method,
  scenario, request_context json, explanation json (agent fills in later).
- **Global error handler** `src/lib/incident-error-handler.ts`, wired via
  `defineMiddlewares({ errorHandler })` in `src/api/middlewares.ts`:
  intercepts would-be 5xx (mirrors core type→status map; chaos-tagged
  requests are always incidents), records the exception on the active OTel
  span, persists the incident fire-and-forget, responds with the generic
  error JSON + `incident_id`. 4xx delegate to the core handler.
- **Chaos scenarios** `src/lib/chaos.ts`, in-memory flags (env defaults
  `CHAOS_*`), runtime toggle `GET/POST /admin/chaos` (AUTHENTICATE=false,
  prototype): 1) `promo_crash` — promo code `SAVE-NULL` on cart update hits
  a real null-deref TypeError (default ON); 2) `payment_timeout` — payment
  session creation fails after a 3s fake-PSP timeout; 3) `inventory_race` —
  cart completion zeroes the cart items' stock first, Medusa's own inventory
  check then fails. Restore stock after demos — BOTH columns (Medusa reads
  the raw one): `UPDATE inventory_level SET stocked_quantity=1000000,
  raw_stocked_quantity='{"value": "1000000", "precision": 20}'::jsonb WHERE
  stocked_quantity=0;`
- **Polling route** `GET /store/explanations/{incident_id}` (publishable key
  required) → `{incident_id, status, fault, user_message, created_at}` only —
  internals never leave the backend.
- ✅ Verified all 3 scenarios: 500 + incident_id returned, incident rows have
  real trace_ids, and the scenario-1 trace is queryable in Grail by
  `trace.id == toUid("…")` with span status error + exception span event
  (type, message, full stack) on `middleware: promo_crash_middleware`.

## Landmines already hit and fixed (do not re-debug)

All four surface as blank pages or masked `KnexTimeoutError` (Medusa's
`propagateCreateError:false` hides real connection errors):

1. **Forced SSL**: Medusa treats any non-localhost DB host (Docker service
   names!) as remote → SSL. Fix lives in `medusa-config.ts`:
   `databaseDriverOptions: { connection: { ssl: false } }`. URL param
   `?ssl_mode=disable` alone is NOT sufficient (gets stripped before module
   migrations read it). Ref: medusajs/medusa#15658.
2. **Turbo strict env**: root `npm run dev` = `turbo dev` strips undeclared
   env vars (DATABASE_URL, REDIS_URL, DT_*). Compose bypasses turbo:
   `cd apps/backend && npm run dev`.
3. **/app mount collision**: admin UI URL base is `/app`; mounting code at
   container path `/app` makes Vite mis-resolve absolute fs paths in virtual
   modules (`virtual:medusa/i18n`). Code mounts at `/srv/medusa`.
4. **Random HMR port**: admin Vite HMR picks an ephemeral container-only port
   → blank page + `waitForSuccessfulPing` loop. Pinned via `HMR_PORT=24678`,
   `HMR_BIND_HOST=0.0.0.0`, `HMR_HOST=localhost`, `HMR_CLIENT_PORT=24678` +
   port published in compose.

5. **Failure traces silently dropped**: Medusa's `registerOtel` uses a
   `SimpleSpanProcessor` — one HTTPS export per span as it ends. A crashing
   request ends its whole span stack at once and blows the exporter's
   concurrent-export limit ("Concurrent export limit reached" at
   OTEL_LOG_LEVEL=debug); successful traces mostly survived, failure traces
   never reached Dynatrace. Fix in `instrumentation.ts`: pass
   `spanProcessors: [new BatchSpanProcessor(exporter)]` to `registerOtel`
   (NodeSDK prefers `spanProcessors`; also makes OTEL_BSP_* env vars apply).
   DQL note: `trace.id` is a uid — filter with
   `trace.id == toUid("<hex>")`, a plain string never matches.

Debugging tip that cracked 1+2: a `--require` shim patching `tarn.Pool.acquire`
and `pg.Client.connect` to log real errors (deleted; recreate if needed).

## Phase 3 — explainer agent, locally (done, verified)

- **Agent** `agent/explainer/agent.py`: single ADK `LlmAgent`
  (`gemini-2.5-flash` via Vertex AI), input `{phase: "A"|"B", incident}`,
  prompt branches. ADK 2.x supports `output_schema` (pydantic `Explanation`,
  DESIGN.md §3 shape) TOGETHER with tools. Tools: `McpToolset` →
  Dynatrace-hosted remote MCP (`execute-dql`, `query-problems`,
  `get-problem-by-id`) + a `wait_for_ingest` sleep tool for the
  retry-until-trace-appears loop.
- **Driver** `agent/run_explainer.py`: `--incident-id inc_…|--latest|--json f`
  + `--phase A|B`; pulls the row from dockerized Postgres (excludes the chaos
  `scenario` tag — agent must work it out from telemetry), prints tool calls,
  validates the output against the schema.
- ✅ Verified on fresh incidents of all 3 scenarios: phase A ≈10s validated
  preliminary JSON; phase B ≈30s: correct DQL with toUid on first try,
  reads exception span events, sane user_message + fault per scenario
  (1 promo: BOTH, names the promo code from request_context; 2 payment:
  SYSTEM, high confidence, "no charge was made"; 3 inventory: SYSTEM).
- Incident capture now whitelists safe request fields into request_context
  (`promo_codes`, `payment_provider`) — that's what lets the agent reach the
  BOTH verdict for scenario 1. Scenario 2's middleware now awaits its fake
  timeout so the exception event lands on a live span (a bare setTimeout
  ended the span before the error handler could record it).
- Vertex auth: ADC via `gcloud auth application-default login` (done, quota
  project devpost-hackathon-11). `GCP_PROJECT_ID` now filled in `.env`.
- ⚠️ Platform Token gap: `query-problems` AND `fetch dt.davis.problems` fail
  with insufficient permission — token lacks `storage:events:read`. Agent
  degrades gracefully (notes the gap in internal_report). Add the scope to
  the Platform Token in the Dynatrace UI to enable the problems cross-check.

## Extras (2026-06-11, after Phase 3)

- **New Platform Token** with `storage:events:read` (+ entities/app-engine
  scopes + `document:documents:write`): the agent's `query-problems`
  cross-check now works — no more "insufficient permissions" in reports.
- **Agent observability**: `agent/explainer/telemetry.py` registers a global
  OTel TracerProvider → same Dynatrace OTLP endpoint as Medusa, service
  `explainer-agent`. ADK emits spans for everything (invocation, `call_llm`,
  `generate_content gemini-2.5-flash` with `gen_ai.usage.*` token counts,
  `execute_tool …`); the driver wraps runs in an `explain_incident` root span
  carrying `incident.id`, `incident.phase`, `incident.store_trace_id` —
  joinable in DQL to the store failure trace it investigates.
- **Dashboard** `dynatrace/dashboard.json` ("Something Went Wrong — store +
  explainer agent", uploaded via Document API, id
  1f67da2b-bb2d-4e93-ad81-1456a6220674): store health (failures, top failing
  ops, recent exceptions + trace ids, p95) + agent ops (runs, time-to-
  explanation by phase, token usage, tool calls). All tile DQL validated via
  MCP. Re-upload after edits: POST /platform/document/v1/documents.

## Phase 4 scope (next session starts here)

Per DESIGN.md §6 Phase 4:
1. Incident module part 2: after persisting the incident, invoke the agent
   in the background — phase A then phase B (locally via `adk api_server
   agent/` on the host; Medusa reaches it at `host.docker.internal`), store
   results in `incident.explanation`, status `pending → preliminary →
   confirmed`, sanitization deny-list pass before storing.
2. Storefront `<SomethingWentWrong incidentId/>` component: polls
   `GET /store/explanations/{id}`, shows preliminary within seconds,
   upgrades to confirmed (fault classification visually distinct).
3. ✅ Verify: checkout with SAVE-NULL in the browser → grounded preliminary
   ~5s → confirmed verdict ~30-60s, no human in the loop.
