import { Module } from "@medusajs/framework/utils"
import IncidentModuleService from "./service"

export const INCIDENT_MODULE = "incident"

export default Module(INCIDENT_MODULE, {
  service: IncidentModuleService,
})
