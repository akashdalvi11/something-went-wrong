import { model } from "@medusajs/framework/utils"

// One row per "something went wrong" occurrence. The id doubles as the
// public incident_id handed to the storefront; trace_id is the correlation
// key into Dynatrace (DESIGN.md §3). The explanation JSON is filled in by
// the agent in later phases (pending → preliminary → confirmed).
export const Incident = model.define("incident", {
  id: model.id({ prefix: "inc" }).primaryKey(),
  trace_id: model.text().nullable(),
  span_id: model.text().nullable(),
  status: model.enum(["pending", "preliminary", "confirmed"]).default("pending"),
  error_type: model.text().nullable(),
  error_message: model.text().nullable(),
  error_stack: model.text().nullable(),
  route: model.text().nullable(),
  method: model.text().nullable(),
  // which chaos scenario (if any) was active when this fired — demo metadata,
  // never sent to the agent or the user
  scenario: model.text().nullable(),
  // safe, non-PII request context for the agent (route params, cart id, …)
  request_context: model.json().nullable(),
  // agent output (structured JSON from DESIGN.md §3), latest phase wins
  explanation: model.json().nullable(),
})
