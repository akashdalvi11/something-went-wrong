"""Export the agent's own OTel traces to Dynatrace.

ADK traces everything through the global tracer (agent run, LLM calls, tool
calls), so registering a global TracerProvider with the same Dynatrace OTLP
endpoint the Medusa backend uses makes the explainer a second observed
service in the tenant: the platform the agent queries for answers also
observes the agent itself.
"""

import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_provider: TracerProvider | None = None


def setup_tracing() -> TracerProvider | None:
    """Register the global tracer provider (idempotent). Returns it, or None
    when the Dynatrace env vars are missing (tracing is optional)."""
    global _provider
    if _provider is not None:
        return _provider

    env = os.environ.get("DT_ENVIRONMENT_NAME")
    token = os.environ.get("DT_OTLP_INGEST_TOKEN")
    if not env or not token:
        return None

    exporter = OTLPSpanExporter(
        endpoint=f"https://{env}.live.dynatrace.com/api/v2/otlp/v1/traces",
        headers={"Authorization": f"Api-Token {token}"},
    )
    _provider = TracerProvider(
        resource=Resource.create({"service.name": "explainer-agent"})
    )
    _provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(_provider)
    return _provider


def flush_tracing() -> None:
    """Make sure buffered spans leave the process (call before exit)."""
    if _provider is not None:
        _provider.force_flush()
