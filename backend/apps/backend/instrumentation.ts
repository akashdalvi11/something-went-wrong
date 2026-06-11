import { registerOtel } from "@medusajs/medusa"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"

// Exports spans straight to the Dynatrace OTLP ingest endpoint; the agent
// later correlates incidents to these traces by trace.id (DESIGN.md §3).
const exporter = new OTLPTraceExporter({
  url: `https://${process.env.DT_ENVIRONMENT_NAME}.live.dynatrace.com/api/v2/otlp/v1/traces`,
  headers: {
    Authorization: `Api-Token ${process.env.DT_OTLP_INGEST_TOKEN}`,
  },
})

export function register() {
  registerOtel({
    serviceName: "medusa-backend",
    exporter,
    instrument: {
      http: true,
      workflows: true,
      query: true,
      db: true,
    },
  })
}
