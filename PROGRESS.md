# PROGRESS — context handoff

Project "Something Went Wrong": an AI agent that explains ecommerce failures
to end users using Dynatrace telemetry. **Read DESIGN.md first** — it holds
the architecture, the two-phase explanation flow, and the phased plan.
This file holds the current implementation state.

**Status: Phase 0–5 ✅ (2026-06-12). Fully deployed: agent on Agent Engine,
store (Medusa + storefront prod build) on GCE VM `sww-store`
(http://34.82.29.34:8000/dk · backend :9000), verified end-to-end in the
cloud. Local dev setup still works unchanged.**

## What exists and runs (all local, all Docker except tools)

| Service | URL / location | Notes |
|---|---|---|
| Medusa v2.15.5 backend | http://localhost:9000 | turbo monorepo at `backend/`, app at `backend/apps/backend/` |
| Admin UI | http://localhost:9000/app | login `admin@sww.local` / `supersecret` |
| Next.js storefront | http://localhost:8000 | starter at `storefront/`, region `/dk` (seed = Europe region) |
| Postgres 16 + Redis 7 | compose services | 139 tables, demo catalog seeded via `db:migrate` migration-scripts |
| Admin HMR | port 24678 | pinned via HMR_* env vars in compose |

- Start: `docker compose --profile app up -d` (dbs alone: `docker compose up -d postgres redis`)
- Agent: **deployed on Agent Engine** (see Phase 5 below) — local Medusa
  calls it because `AGENT_ENGINE_RESOURCE` is set in `.env`. No local agent
  server needed. To fall back to local: comment that var out and run
  `cd agent && .venv/bin/adk api_server --host 0.0.0.0 --port 8001 .`
  (`AGENT_BASE_URL` in compose points at `host.docker.internal:8001`)
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
  gcloud authed as akashdalvi115@gmail.com. Region is `us-west1`
  (`GCP_REGION` in `.env`) — the VM lives there and the agent deploys there
  too (Phase 5); gemini-2.5-flash verified serving from us-west1. ADC done:
  `gcloud auth application-default login`, quota project set.
- Python: ADK 2.2.0 in `agent/.venv` (`google-adk`, `mcp`, `python-dotenv`,
  `opentelemetry-exporter-otlp-proto-http==1.41.1` — pinned because ADK 2.2
  requires opentelemetry <=1.41.1; and ADK 2.x does NOT bundle `mcp`).
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
- ~~Platform Token gap (`storage:events:read` missing)~~ — RESOLVED: new
  token minted with the full scope set (see Extras below); problems
  cross-check works.

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

## Phase 4 — end-to-end glue (done, verified via API; browser click pending)

- **Explainer client** `backend/.../src/lib/explainer-client.ts`: fire-and-
  forget two-phase pipeline kicked off by the error handler after the
  incident row is created. Calls the ADK api_server REST API (session per
  run: `POST /apps/explainer/users/medusa/sessions/{id}`, then `POST /run`),
  phase A immediately, phase B after a 15s ingest delay. Results stored in
  `incident.explanation` + status, with a deny-list `sanitizeUserMessage`
  backstop (stack frames, file names, internal service names → replace whole
  message with a safe fallback).
- **Incident marker**: backend 5xx message is now
  `An unknown error occurred. [incident:inc_…]` — @medusajs/js-sdk only
  surfaces the message string of an error body, so the id rides inside it.
  The storefront parses it back out and never shows it raw.
- **Storefront — chatbot UI (reworked 2026-06-11)**: the app now behaves
  traditionally — the shared checkout `ErrorMessage` component (covers
  discount-code, payment step, place-order button) shows only a generic
  "Something went wrong. Please try again." inline, strips the incident
  marker, and dispatches a `sww:incident` CustomEvent. A persistent
  **`<IncidentAssistant/>`** chatbot
  (`src/modules/common/components/incident-assistant/`, mounted in the root
  `app/layout.tsx` so it survives navigation) pops up on that event: calming
  intro bubble immediately, then polls `/api/explanations/{id}` (Next
  server-side proxy holding the publishable key) every 3s up to 3min and
  appends the preliminary ("first look") and confirmed bubbles with fault
  badges ("This was on us" / "Partly on us" / "Action needed" / "Still
  investigating"), typing indicator while working, minimize-to-launcher with
  unread dot, conversation persisted in sessionStorage (key `sww-assistant`)
  across reloads/screen changes. The old inline `<SomethingWentWrong/>`
  component is deleted.
- ✅ Verified end-to-end via API: SAVE-NULL → 500 with marker → storefront
  proxy serves pending → preliminary (BOTH) ~11s → confirmed (BOTH, high)
  ~37s. No human in the loop.
- **Latency rework (2026-06-11)**: phases A and B now run in *parallel*
  (B never needed A's output) with B's head start cut 15s → 5s — the
  agent's retry-until-trace-appears loop absorbs ingest variance (prompt
  now ramps waits: 8s ×2 then 15s, up to 9 attempts, same ~2min budget);
  FE poll 3s → 2s. Guard: a late preliminary never overwrites a confirmed
  row. Also **invokeWithRetry** around both agent calls (A: 2 attempts/5s
  backoff, B: 3 attempts/20s·40s) — Vertex gemini-2.5-flash uses dynamic
  shared quota and threw a transient 429 RESOURCE_EXHAUSTED (not a credits
  issue) that previously killed phase B outright. Result: confirmed
  ~60-90s → ~37s, same verdict quality (BOTH, high, real span evidence).
- ⚠️ Caveats: agent api_server must be running (see Start above) — without
  it incidents stay `pending` and the chatbot keeps its calming intro +
  typing indicator, closing with a graceful "taking longer than usual" after
  3min. Server-action error messages pass through in `next dev` only;
  a production build masks them (would need actions to return errors instead
  of throwing — Phase 5 polish if deployed FE is wanted).
- Note: restarting the agent api_server is required after editing the
  agent prompt (`agent/explainer/agent.py`) — adk api_server does not
  hot-reload.

## Payment-outage Dynatrace problem (2026-06-11, built — one manual step left)

Goal: when payment failures spike, Dynatrace opens a real problem, so the
agent's phase B `query-problems` cross-check sees an ACTIVE problem and
concludes "payments are failing for everyone" (SYSTEM, not a one-off).

- **Davis anomaly detector** (settings schema `builtin:davis.anomaly-detectors`,
  created via `dynatrace/payment_anomaly_detector.py`, idempotent by title
  "Payment failures — checkout payments failing repeatedly"): DQL counts
  `medusa-backend` error spans with "payment" in the span name per 1-min
  bucket (`makeTimeseries count(default: 0), by: {dt.entity.service}`);
  static threshold >0; **2 violating samples in a 15-min sliding window**
  opens the problem, 15 dealerting samples keep it open ~15 min past the
  last failure (the demo window). Event: CUSTOM_ALERT "Payment processing
  is failing for multiple customers" on the medusa-backend service entity.
  Note: only spans exist in Grail (no log ingest), so the detector reads
  spans — same signal the user called "payment failure logs".
- ⚠️ **BLOCKED on token scopes**: the Platform Token lacks
  `settings:objects:read`, `settings:objects:write`, `settings:schemas:read`.
  Add them (Account Management → Platform tokens, or mint new + update
  `.env`), then run
  `agent/.venv/bin/python dynatrace/payment_anomaly_detector.py`.
  (Direct Davis event ingest was the alternative; also blocked —
  needs `storage:events:write` / classic `events.ingest`.)
- **Demo warm-up** `scripts/warmup_payment_problem.sh [attempts] [spacing_s]`
  (default 6×25s): enables `payment_timeout` chaos, builds one cart/payment
  collection, fires failing payment-session attempts across ≥2 distinct
  minutes. Problem ACTIVE ~2–3 min after it finishes; do the on-camera
  failure within the next ~15 min. Script verified (mechanics): 500s
  recorded, error spans land in Grail. Leaves chaos ON.
- Demo recipe: warm-up → wait ~3 min (check problem in Dynatrace or via
  `query-problems`) → storefront checkout payment fails → phase B cites the
  active problem → SYSTEM verdict "failing for everyone".
- ✅ Detector created (2026-06-12, scopes added to the Platform Token);
  verified: a problem opens on warm-up failures.

## Phase 5 (agent half) — deployed to Agent Engine (2026-06-12, verified)

- **Resource**: `projects/119572966637/locations/us-west1/reasoningEngines/4954742442386522112`
  (display name `explainer`, us-west1, project devpost-hackathon-11).
- **Deploy/redeploy** (also after any prompt edit in `agent/explainer/agent.py`):
  `agent/.venv/bin/adk deploy agent_engine --project devpost-hackathon-11
  --region us-west1 --display_name explainer --temp_folder
  /tmp/adk-agent-engine-deploy agent/explainer`
  (pass `--agent_engine_id 4954742442386522112` to update in place; without
  it a NEW instance is created — then update `AGENT_ENGINE_RESOURCE` in `.env`).
  Requires `google-cloud-aiplatform[agent_engines]` in the venv (installed).
- Deploy inputs live in the agent folder: `agent/explainer/.env` (gitignored;
  DT_* tokens + GCP_* — adk deploy sets these as runtime env vars) and
  `agent/explainer/requirements.txt`. **Gotcha**: the Agent Engine container
  runs `adk api_server --a2a`, so requirements need `google-adk[a2a]` — plain
  google-adk fails at start with ModuleNotFoundError: a2a ("failed to start
  and cannot serve traffic"; logs: `gcloud logging read
  'resource.type="aiplatform.googleapis.com/ReasoningEngine"'`).
- **Medusa → Agent Engine**: `explainer-client.ts` now branches on
  `AGENT_ENGINE_RESOURCE` (set in root `.env`): POST
  `https://us-west1-aiplatform.googleapis.com/v1/<resource>:streamQuery?alt=sse`
  with `{class_method: "async_stream_query", input: {user_id, message}}`,
  bearer from `google-auth-library` (ADC; `~/.config/gcloud/application_
  default_credentials.json` mounted read-only at `/gcloud/adc.json` in
  compose, `GOOGLE_APPLICATION_CREDENTIALS` points there). Fresh session per
  call (no session_id → auto-created). **Gotcha**: despite `alt=sse` the
  response is newline-delimited JSON events with NO `data:` prefix — the
  parser treats the prefix as optional.
- ✅ Verified end-to-end (local Medusa → deployed agent): SAVE-NULL incident
  → preliminary (BOTH) ~5s → confirmed (BOTH) ~40s. Local adk api_server no
  longer required.

## Phase 5 (store half) — GCE VM deploy (2026-06-12, verified)

- **VM**: `sww-store`, us-west1-b, e2-standard-2, 40GB, IP **34.82.29.34**,
  SA `sww-medusa-vm@…` with `roles/aiplatform.user`, scopes cloud-platform,
  firewall `sww-web` (tcp 8000/9000, tag sww-store). Docker via get.docker.com
  startup script. Repo at `~/sww`; stack:
  `sudo docker compose -f docker-compose.yml -f deploy/docker-compose.gce.yml
  --profile app up -d` (gce override = storefront `npm run start`, prod build).
  The user's pre-existing `first-virtual-machine` was left untouched.
- **Auth**: no ADC on the VM — google-auth-library falls back to the metadata
  server (SA). Locally the ADC mount lives in gitignored
  `docker-compose.override.yml` (template: docker-compose.override.example.yml).
- **Data**: local DB pg_dump/pg_restore (NOT re-seeded) so the publishable
  key in `storefront/.env.local` keeps matching the DB. VM env tweaks:
  `NEXT_PUBLIC_BASE_URL=http://34.82.29.34:8000`, STORE/ADMIN/AUTH_CORS set.
- **Prod-safe server actions**: `initiatePaymentSession`, `placeOrder` AND
  `applyPromotions` now return `{ error }` instead of throwing (Next prod
  masks thrown server-action messages — the browser then shows "An error
  occurred in the Server Components render…" and the `[incident:…]` marker
  is lost, so no chatbot). Callers adapted: payment/index.tsx,
  payment-button/index.tsx, discount-code/index.tsx (it calls
  applyPromotions DIRECTLY, not via submitPromotionForm — found only by
  testing the deployed build; the real error + digest was in
  `sudo docker logs sww-storefront-1`). All three chaos scenarios' UI paths
  are covered.
- ⚠️ **LANDMINE (cost ~2h)**: copying the repo with macOS `tar` shipped
  AppleDouble `._*` files; Linux extraction materialized them. Medusa's
  module loader dynamic-imports EVERY file in a module's `models/` dir and
  `.catch(() => [])`s the whole directory on any failure — `._incident.ts`
  (binary) threw, models came back empty, **no connection loader → module
  `manager` undefined → every incident insert died with "Cannot read
  properties of undefined (reading 'fork')" while the rest of the store
  worked perfectly.** Routes survived because the api loader matches exact
  `route.ts` names. Fix: `find ~/sww -name "._*" -delete` + restart. Future
  copies: `COPYFILE_DISABLE=1 tar czf …` from macOS.
- ✅ Verified on the VM: SAVE-NULL → preliminary ~20s → confirmed (BOTH)
  ~40s through Agent Engine with metadata-server auth.
- ⚠️ **LANDMINE 2 (cookies)**: the starter sets `_medusa_cart_id` /
  `_medusa_jwt` / locale cookies with `secure: NODE_ENV === "production"`.
  A prod build served over plain http (the VM) → browsers silently drop
  Secure cookies → add-to-cart "does nothing" (cart created server-side,
  id never persisted) and login breaks; the DB looks innocent. Fixed in
  cookies.ts + locale-actions.ts: `secure:
  !!process.env.NEXT_PUBLIC_BASE_URL?.startsWith("https")`. Storefront
  rebuilt on the VM (rebuild required — prod build bakes server actions).

## Message calibration v2 (2026-06-12, deployed + verified)

- Phase A = acknowledgment only: what the user was doing + safety
  consequence; **no remedies** (those belong to the confirmed verdict), no
  "I'll confirm shortly" (the chat UI adds that line itself).
- Phase B = verdict voice: opens with what was established, hedge words
  banned (incl. "unexpected"), must not read as a reworded preliminary;
  carries the next step; BOTH = user fix + our admission.
- Charge/card reassurance only in payment incidents (was bleeding into
  promo verdicts).
- Redeploy after prompt edits:
  `agent/.venv/bin/adk deploy agent_engine --project devpost-hackathon-11
  --region us-west1 --display_name explainer --agent_engine_id
  4954742442386522112 --temp_folder /tmp/adk-agent-engine-deploy
  agent/explainer`

## Storefront rebrand (2026-06-12)

- "Medusa Store" → "Something Store" everywhere user-visible (nav, footer,
  side menu, checkout layout, register/login/profile copy, page metadata
  titles). Home metadata title/description rebranded; hero is now
  "Something Store / The store that tells you what went wrong" (GitHub
  starter button removed); footer "Medusa" link column renamed "Resources".
  "Powered by Medusa & Next.js" credit (MedusaCTA) intentionally kept.
