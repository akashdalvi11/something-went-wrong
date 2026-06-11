import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import IncidentModuleService from "../../../../modules/incident/service"
import { INCIDENT_MODULE } from "../../../../modules/incident"

// Polled by the storefront's <SomethingWentWrong/> component:
// pending → preliminary → confirmed (DESIGN.md §3). Only safe fields leave
// the backend — never the exception, stack, or internal report.
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const incidentService = req.scope.resolve<IncidentModuleService>(INCIDENT_MODULE)
  try {
    const incident = await incidentService.retrieveIncident(req.params.id)
    const explanation = (incident.explanation ?? {}) as Record<string, unknown>
    res.json({
      incident_id: incident.id,
      status: incident.status,
      fault: explanation.fault ?? null,
      user_message: explanation.user_message ?? null,
      created_at: incident.created_at,
    })
  } catch {
    res.status(404).json({ message: `No incident ${req.params.id}` })
  }
}
