import { randomUUID } from "node:crypto"
import {
  errorHandler as coreErrorHandler,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { SpanStatusCode, trace } from "@opentelemetry/api"
import IncidentModuleService from "../modules/incident/service"
import { INCIDENT_MODULE } from "../modules/incident"
import { activeScenario } from "./chaos"
import { runExplanationPipeline } from "./explainer-client"

// Incident module, part 1 (DESIGN.md §3.3 / §6 Phase 2): on any unhandled
// 5xx, capture trace context + the exception in hand, persist an incident
// row (status pending), and return the generic error *plus* incident_id.
// Must never block and never throw — the user's error response cannot
// depend on incident capture working.

const defaultHandler = coreErrorHandler()

// Mirror of the core error handler's type→status mapping, so we only
// intercept what the core would have answered with a 5xx.
const NON_5XX_TYPES = new Set<string>([
  "QueryRunnerAlreadyReleasedError",
  "TransactionAlreadyStartedError",
  "TransactionNotStartedError",
  MedusaError.Types.CONFLICT,
  MedusaError.Types.UNAUTHORIZED,
  MedusaError.Types.FORBIDDEN,
  MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
  MedusaError.Types.DUPLICATE_ERROR,
  MedusaError.Types.NOT_ALLOWED,
  MedusaError.Types.INVALID_DATA,
  MedusaError.Types.NOT_FOUND,
])

function wouldBe5xx(err: any): boolean {
  const errorType = err?.type || err?.name
  // zod validation errors answer 400 in the core handler
  if (err && "issues" in err && Array.isArray(err.issues)) {
    return false
  }
  return !NON_5XX_TYPES.has(errorType)
}

export function incidentErrorHandler(
  err: any,
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const scenario = activeScenario(req)
  // A chaos-injected failure is always an incident, even if Medusa would
  // classify the resulting error as a 4xx (scenario 3 surfaces as
  // not_allowed): the premise is the user saw "something went wrong".
  if (!wouldBe5xx(err) && !scenario) {
    return defaultHandler(err, req, res, next)
  }

  const incidentId = `inc_${randomUUID()}`

  try {
    const logger = req.scope?.resolve(ContainerRegistrationKeys.LOGGER) ?? console

    // Make sure the exception lands on the active span so Dynatrace shows a
    // span exception event for this trace.
    const span = trace.getActiveSpan()
    if (err instanceof Error) {
      span?.recordException(err)
    }
    span?.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message ?? err) })
    const spanContext = span?.spanContext()

    const incident = {
      id: incidentId,
      trace_id: spanContext?.traceId ?? null,
      span_id: spanContext?.spanId ?? null,
      status: "pending" as const,
      error_type: String(err?.type || err?.name || "Error"),
      error_message: String(err?.message ?? err),
      error_stack: typeof err?.stack === "string" ? err.stack : null,
      route: req.originalUrl?.split("?")[0] ?? null,
      method: req.method ?? null,
      scenario: scenario ?? null,
      request_context: {
        params: req.params ?? {},
        // Whitelisted, PII-free request fields the agent may reason about.
        // Never the whole body.
        promo_codes: (req.body as any)?.promo_codes ?? undefined,
        payment_provider: (req.body as any)?.provider_id ?? undefined,
      },
    }

    logger.error(`incident captured: ${JSON.stringify(incident)}`)

    const incidentService = req.scope?.resolve<IncidentModuleService>(INCIDENT_MODULE)
    incidentService
      ?.createIncidents(incident)
      .then(() => {
        // Two-phase agent invocation in the background; the user's error
        // response (below) never waits for any of this.
        runExplanationPipeline(incidentService, logger as any, {
          incident_id: incident.id,
          trace_id: incident.trace_id,
          created_at: new Date().toISOString(),
          route: incident.route,
          method: incident.method,
          error_type: incident.error_type,
          error_message: incident.error_message,
          error_stack: incident.error_stack,
          request_context: incident.request_context,
        })
      })
      .catch((e) => logger.error(`incident persist failed for ${incidentId}: ${e}`))
  } catch (captureError) {
    // capture is best-effort by design; the response below still goes out
    console.error(`incident capture failed for ${incidentId}: ${captureError}`)
  }

  res.status(500).json({
    type: "unknown_error",
    code: "unknown_error",
    // The marker rides inside the message because @medusajs/js-sdk only
    // surfaces the message string of an error body — the storefront parses
    // [incident:…] back out and never displays it raw.
    message: `An unknown error occurred. [incident:${incidentId}]`,
    incident_id: incidentId,
  })
}
