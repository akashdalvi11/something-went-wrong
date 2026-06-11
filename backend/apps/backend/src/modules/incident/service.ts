import { MedusaService } from "@medusajs/framework/utils"
import { Incident } from "./models/incident"

// Generated CRUD: createIncidents, retrieveIncident, updateIncidents, …
class IncidentModuleService extends MedusaService({ Incident }) {}

export default IncidentModuleService
