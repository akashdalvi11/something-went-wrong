import { Logger } from "@medusajs/framework/types"
import { GoogleAuth } from "google-auth-library"
import IncidentModuleService from "../modules/incident/service"

// Incident module, part 2 (DESIGN.md §3.3): background invocation of the
// explainer agent — phase A (preliminary, seconds) then phase B (confirmed,
// after Dynatrace ingest). Fire-and-forget from the error path; every step
// here is best-effort and must never throw out of the pipeline.
//
// Two interchangeable agent backends:
// - AGENT_ENGINE_RESOURCE set (projects/…/locations/…/reasoningEngines/…):
//   the deployed Vertex AI Agent Engine, called over REST :streamQuery with
//   an ADC bearer token (Phase 5).
// - otherwise AGENT_BASE_URL: a local `adk api_server --host 0.0.0.0
//   --port 8001 agent` on the host.

const AGENT_ENGINE_RESOURCE = process.env.AGENT_ENGINE_RESOURCE
const AGENT_BASE_URL =
  process.env.AGENT_BASE_URL ?? "http://host.docker.internal:8001"
const APP = "explainer"
const USER = "medusa"
// Head start before phase B's first DQL attempt. Spans flush after ~1s
// (OTEL_BSP_SCHEDULE_DELAY) and the agent's own retry loop absorbs the
// remaining ingest variance, so this no longer waits out the typical lag.
const PHASE_B_DELAY_MS = 5_000
const PHASE_A_TIMEOUT_MS = 60_000
const PHASE_B_TIMEOUT_MS = 300_000

export type ExplainerResult = {
  incident_id: string
  status: "preliminary" | "confirmed"
  fault: "USER" | "SYSTEM" | "BOTH" | "UNKNOWN"
  user_message: string
  internal_report: string
  evidence: string[]
  confidence: "high" | "medium" | "low"
}

export type IncidentPayload = {
  incident_id: string
  trace_id: string | null
  created_at?: string
  route: string | null
  method: string | null
  error_type: string
  error_message: string
  error_stack: string | null
  request_context: Record<string, unknown>
}

// Backstop behind the prompt rules: if internals leak into user_message
// anyway, replace the whole message rather than risk it (DESIGN.md §3
// guardrails).
const DENY_PATTERNS: RegExp[] = [
  /\bat\s+\w+.*\(/, // stack frames
  /\b[\w-]+\.(ts|js|tsx|jsx|py)\b/i, // source file names
  /node_modules|stacktrace|stack trace/i,
  /\b(postgres|sql|knex|redis|medusa|middleware|span|grail|dql)\b/i,
  /trace[._-]?id|span[._-]?id/i,
  /\b(fakepay|pp_system_default)\b/i, // internal provider names
]

const FALLBACK_USER_MESSAGE =
  "Something went wrong on our side and your request didn't complete. " +
  "Please try again in a few minutes."

export function sanitizeUserMessage(message: unknown): string {
  if (typeof message !== "string" || !message.trim()) {
    return FALLBACK_USER_MESSAGE
  }
  const trimmed = message.trim().slice(0, 500)
  if (DENY_PATTERNS.some((p) => p.test(trimmed))) {
    return FALLBACK_USER_MESSAGE
  }
  return trimmed
}

// Lazy singleton: GoogleAuth caches and refreshes ADC tokens internally.
let googleAuth: GoogleAuth | null = null
function getGoogleAuth(): GoogleAuth {
  if (!googleAuth) {
    googleAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    })
  }
  return googleAuth
}

// Agent Engine REST: async_stream_query creates a fresh session per call
// (no session_id passed) and streams ADK events as SSE `data:` lines; the
// last text part is the structured JSON.
async function invokeViaAgentEngine(
  phase: "A" | "B",
  incident: IncidentPayload,
  timeout: number
): Promise<ExplainerResult> {
  const resource = AGENT_ENGINE_RESOURCE!
  const region = resource.match(/locations\/([^/]+)\//)?.[1]
  if (!region) {
    throw new Error(`cannot parse region from AGENT_ENGINE_RESOURCE: ${resource}`)
  }
  const token = await getGoogleAuth().getAccessToken()

  const res = await fetch(
    `https://${region}-aiplatform.googleapis.com/v1/${resource}:streamQuery?alt=sse`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        class_method: "async_stream_query",
        input: {
          user_id: USER,
          message: JSON.stringify({ phase, incident }),
        },
      }),
      signal: AbortSignal.timeout(timeout),
    }
  )
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300)
    throw new Error(`agent engine query failed: ${res.status} ${detail}`)
  }

  const body = await res.text()
  let finalText: string | undefined
  // One JSON event per line; Agent Engine omits the SSE "data:" prefix even
  // with alt=sse (verified against the live endpoint), so treat it as optional.
  for (const rawLine of body.split("\n")) {
    const line = (
      rawLine.startsWith("data:") ? rawLine.slice(5) : rawLine
    ).trim()
    if (!line) {
      continue
    }
    try {
      const event = JSON.parse(line) as {
        content?: { parts?: Array<{ text?: string }> }
      }
      for (const part of event.content?.parts ?? []) {
        if (part.text?.trim()) {
          finalText = part.text
        }
      }
    } catch {
      // partial/non-JSON SSE line — ignore
    }
  }
  if (!finalText) {
    throw new Error("agent engine returned no text response")
  }
  return JSON.parse(finalText) as ExplainerResult
}

async function invokeExplainer(
  phase: "A" | "B",
  incident: IncidentPayload
): Promise<ExplainerResult> {
  const timeout = phase === "A" ? PHASE_A_TIMEOUT_MS : PHASE_B_TIMEOUT_MS
  if (AGENT_ENGINE_RESOURCE) {
    return invokeViaAgentEngine(phase, incident, timeout)
  }
  // Fresh session per run: ADK sessions accumulate history, and a stale
  // session would pollute a retriggered explanation.
  const sessionId = `${incident.incident_id}-${phase}-${Date.now()}`

  const sessionRes = await fetch(
    `${AGENT_BASE_URL}/apps/${APP}/users/${USER}/sessions/${sessionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    }
  )
  if (!sessionRes.ok) {
    throw new Error(`agent session create failed: ${sessionRes.status}`)
  }

  const runRes = await fetch(`${AGENT_BASE_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName: APP,
      userId: USER,
      sessionId,
      newMessage: {
        role: "user",
        parts: [{ text: JSON.stringify({ phase, incident }) }],
      },
    }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!runRes.ok) {
    throw new Error(`agent run failed: ${runRes.status}`)
  }

  const events = (await runRes.json()) as Array<{
    content?: { parts?: Array<{ text?: string }> }
  }>
  let finalText: string | undefined
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      if (part.text?.trim()) {
        finalText = part.text
      }
    }
  }
  if (!finalText) {
    throw new Error("agent returned no text response")
  }
  return JSON.parse(finalText) as ExplainerResult
}

// Vertex quota throttling (429 → agent run 500) is transient; a single
// failed call must not cost the user the whole explanation. Fresh session
// per attempt (invokeExplainer already does that).
async function invokeWithRetry(
  phase: "A" | "B",
  incident: IncidentPayload,
  logger: Logger,
  attempts: number,
  backoffMs: number
): Promise<ExplainerResult> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await invokeExplainer(phase, incident)
    } catch (e) {
      lastError = e
      if (attempt < attempts) {
        logger.warn(
          `explainer phase ${phase} attempt ${attempt}/${attempts} failed ` +
            `for ${incident.incident_id}, retrying: ${e}`
        )
        await new Promise((r) => setTimeout(r, backoffMs * attempt))
      }
    }
  }
  throw lastError
}

async function storeResult(
  incidentService: IncidentModuleService,
  incidentId: string,
  result: ExplainerResult,
  fallbackStatus: "preliminary" | "confirmed"
) {
  const status = result.status === "confirmed" ? "confirmed" : fallbackStatus
  await incidentService.updateIncidents({
    id: incidentId,
    status,
    explanation: {
      ...result,
      user_message: sanitizeUserMessage(result.user_message),
      status,
    },
  })
}

/** Fire-and-forget two-phase explanation. Never throws.
 *
 * Phase B does not depend on phase A's output, so both run in parallel —
 * phase B's first DQL attempt lands while phase A is still generating. The
 * only ordering rule is that a preliminary result must never overwrite a
 * confirmed one, guarded in the phase A path below.
 */
export function runExplanationPipeline(
  incidentService: IncidentModuleService,
  logger: Logger,
  incident: IncidentPayload
): void {
  void (async () => {
    try {
      const preliminary = await invokeWithRetry("A", incident, logger, 2, 5_000)
      const current = await incidentService.retrieveIncident(
        incident.incident_id
      )
      if (current.status === "confirmed") {
        logger.info(
          `explanation already confirmed for ${incident.incident_id}; ` +
            `dropping late preliminary`
        )
        return
      }
      await storeResult(incidentService, incident.incident_id, {
        ...preliminary,
        status: "preliminary",
      }, "preliminary")
      logger.info(`explanation preliminary stored for ${incident.incident_id}`)
    } catch (e) {
      logger.error(`explainer phase A failed for ${incident.incident_id}: ${e}`)
      // without a preliminary result, phase B can still rescue the incident
    }
  })()

  void (async () => {
    try {
      await new Promise((r) => setTimeout(r, PHASE_B_DELAY_MS))
      const confirmed = await invokeWithRetry("B", incident, logger, 3, 20_000)
      await storeResult(incidentService, incident.incident_id, confirmed, "preliminary")
      logger.info(
        `explanation ${confirmed.status} stored for ${incident.incident_id} ` +
          `(fault: ${confirmed.fault}, confidence: ${confirmed.confidence})`
      )
    } catch (e) {
      logger.error(`explainer phase B failed for ${incident.incident_id}: ${e}`)
    }
  })()
}
