# PROGRESS — context handoff

Project "Something Went Wrong": an AI agent that explains ecommerce failures
to end users using Dynatrace telemetry. **Read DESIGN.md first** — it holds
the architecture, the two-phase explanation flow, and the phased plan.
This file holds the current implementation state.

**Status: Phase 0 ✅, Phase 1 ✅, Phase 2 ✅ (2026-06-11). Next: Phase 3
(the explainer agent, locally — DESIGN.md §6 Phase 3).**

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

## Phase 3 scope (next session starts here)

Per DESIGN.md §6 Phase 3, in `agent/`:
1. Phase A first: ADK `LlmAgent` (Gemini via Vertex AI), `phase: "A"` branch —
   one LLM pass over an exception payload → structured preliminary JSON
   (output schema from DESIGN.md §3). No MCP involved.
2. Then Phase B: `McpToolset` + `StreamableHTTPConnectionParams` → the
   Dynatrace-hosted remote MCP server. Investigation prompt + fault rubric +
   retry-until-trace-appears loop (DQL templates: `fetch spans | filter
   trace.id == toUid("…")`, remember the toUid!).
3. Verify on real Phase 2 incidents from the `incident` table via CLI /
   `adk web`: preliminary JSON in seconds; correct fault class + sane
   user_message for all scenarios once the trace is found.
