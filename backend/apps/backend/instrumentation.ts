import { registerOtel } from "@medusajs/medusa"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
// Same copy of sdk-trace-node that registerOtel itself uses
import { BatchSpanProcessor } from "@medusajs/framework/opentelemetry/sdk-trace-node"

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
    // registerOtel defaults to a SimpleSpanProcessor: one HTTPS export per
    // span as it ends. A crashing request ends its whole span stack at once,
    // exceeding the exporter's concurrent-export limit — failure traces (the
    // ones this project exists for!) were silently dropped. spanProcessors
    // overrides it (NodeSDK prefers it over spanProcessor) and makes the
    // OTEL_BSP_* env vars actually apply.
    spanProcessors: [new BatchSpanProcessor(exporter)],
    instrument: {
      http: true,
      workflows: true,
      query: true,
      db: true,
    },
  })
}
