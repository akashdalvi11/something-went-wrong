import { Logger } from "@medusajs/framework/types"
import IncidentModuleService from "../modules/incident/service"

// Incident module, part 2 (DESIGN.md §3.3): background invocation of the
// explainer agent — phase A (preliminary, seconds) then phase B (confirmed,
// after Dynatrace ingest). Fire-and-forget from the error path; every step
// here is best-effort and must never throw out of the pipeline.
//
// Locally the agent runs via `adk api_server --host 0.0.0.0 --port 8001 agent`
// on the host; in Phase 5 this base URL becomes the Agent Engine REST
// endpoint (with an ADC bearer token).

const AGENT_BASE_URL =
  process.env.AGENT_BASE_URL ?? "http://host.docker.internal:8001"
const APP = "explainer"
const USER = "medusa"
const PHASE_B_DELAY_MS = 15_000 // typical minimum ingest lag (DESIGN.md §2)
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

async function invokeExplainer(
  phase: "A" | "B",
  incident: IncidentPayload
): Promise<ExplainerResult> {
  const timeout = phase === "A" ? PHASE_A_TIMEOUT_MS : PHASE_B_TIMEOUT_MS
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

/** Fire-and-forget two-phase explanation. Never throws. */
export function runExplanationPipeline(
  incidentService: IncidentModuleService,
  logger: Logger,
  incident: IncidentPayload
): void {
  void (async () => {
    try {
      const preliminary = await invokeExplainer("A", incident)
      await storeResult(incidentService, incident.incident_id, {
        ...preliminary,
        status: "preliminary",
      }, "preliminary")
      logger.info(`explanation preliminary stored for ${incident.incident_id}`)
    } catch (e) {
      logger.error(`explainer phase A failed for ${incident.incident_id}: ${e}`)
      // without a preliminary result, phase B can still rescue the incident
    }

    try {
      await new Promise((r) => setTimeout(r, PHASE_B_DELAY_MS))
      const confirmed = await invokeExplainer("B", incident)
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
