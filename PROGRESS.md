# PROGRESS — context handoff

Project "Something Went Wrong": an AI agent that explains ecommerce failures
to end users using Dynatrace telemetry. **Read DESIGN.md first** — it holds
the architecture, the two-phase explanation flow, and the phased plan.
This file holds the current implementation state.

**Status: Phase 0 ✅, Phase 1 ✅ (2026-06-11). Next: Phase 2 (failure
injection + incident module, DESIGN.md §5/§6).**

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

Debugging tip that cracked 1+2: a `--require` shim patching `tarn.Pool.acquire`
and `pg.Client.connect` to log real errors (deleted; recreate if needed).

## Phase 2 scope (next session starts here)

Per DESIGN.md §5 + §6 Phase 2, inside `backend/apps/backend/`:
1. Failure-injection scenarios 1–3 (promo `SAVE-NULL` null-deref, payment
   provider timeout, inventory race) behind toggles.
2. Incident module part 1: global error-handling middleware on unhandled 5xx —
   capture `trace_id` from active OTel context + exception (type/message/
   stack), generate `incident_id`, persist incident row (status `pending`) in
   Medusa's Postgres, return generic error + `incident_id` to the FE.
3. Verify: trigger scenario 1 → exception span event visible in Dynatrace via
   `verify_mcp.py` DQL by `trace.id`; incident row matches; FE gets incident_id.
