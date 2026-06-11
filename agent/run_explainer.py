"""Run the explainer agent locally against a real incident (Phase 3 verify).

Usage:
    agent/.venv/bin/python agent/run_explainer.py --incident-id inc_... --phase A
    agent/.venv/bin/python agent/run_explainer.py --incident-id inc_... --phase B
    agent/.venv/bin/python agent/run_explainer.py --json incident.json --phase A
    agent/.venv/bin/python agent/run_explainer.py --latest --phase A

--incident-id / --latest fetch the row from the dockerized Postgres.
Prints every tool call the agent makes, then the validated explanation JSON.
"""

import argparse
import asyncio
import json
import subprocess
import sys
import time

from google.genai import types
from opentelemetry import trace

from explainer.agent import Explanation, root_agent
from explainer.telemetry import flush_tracing, setup_tracing

PSQL = [
    "docker", "compose", "exec", "-T", "postgres",
    "psql", "-U", "postgres", "-d", "medusa", "-t", "-A", "-c",
]

# What the incident module will send the agent in Phase 4: the exception
# payload + correlation key. Never the chaos `scenario` tag — the agent must
# work it out from telemetry, like it would for a real unknown failure.
INCIDENT_QUERY = """
SELECT row_to_json(t) FROM (
  SELECT id AS incident_id, trace_id, created_at, route, method,
         error_type, error_message, error_stack, request_context
  FROM incident {where}
  ORDER BY created_at DESC LIMIT 1
) t
"""


def fetch_incident(incident_id: str | None) -> dict:
    where = f"WHERE id='{incident_id}'" if incident_id else ""
    out = subprocess.run(
        PSQL + [INCIDENT_QUERY.format(where=where)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    if not out:
        sys.exit(f"No incident found ({incident_id or 'latest'})")
    return json.loads(out)


async def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--incident-id")
    source.add_argument("--latest", action="store_true")
    source.add_argument("--json", help="path to an incident JSON file")
    parser.add_argument("--phase", choices=["A", "B"], default="A")
    args = parser.parse_args()

    if args.json:
        incident = json.load(open(args.json))
    else:
        incident = fetch_incident(args.incident_id)

    payload = {"phase": args.phase, "incident": incident}
    print(f"--- input (phase {args.phase}) ---")
    print(json.dumps(payload, indent=2, default=str)[:1500])

    # The agent's own traces go to the same Dynatrace tenant it investigates.
    setup_tracing()

    # Imported late: InMemoryRunner pulls in the full ADK surface (~seconds).
    from google.adk.runners import InMemoryRunner

    runner = InMemoryRunner(agent=root_agent, app_name="explainer")
    session = await runner.session_service.create_session(
        app_name="explainer", user_id="local"
    )

    started = time.monotonic()
    final_text = None
    # Root span carrying the correlation keys: incident id, phase, and the
    # trace id of the store failure being investigated — joinable in DQL.
    tracer = trace.get_tracer("explainer.driver")
    with tracer.start_as_current_span("explain_incident") as root_span:
        root_span.set_attribute("incident.id", str(incident.get("incident_id")))
        root_span.set_attribute("incident.phase", args.phase)
        root_span.set_attribute("incident.store_trace_id", str(incident.get("trace_id")))
        async for event in runner.run_async(
            user_id="local",
            session_id=session.id,
            new_message=types.Content(
                role="user", parts=[types.Part(text=json.dumps(payload, default=str))]
            ),
        ):
            elapsed = time.monotonic() - started
            for part in (event.content and event.content.parts) or []:
                if part.function_call:
                    arg_preview = json.dumps(part.function_call.args or {})[:200]
                    print(f"[{elapsed:6.1f}s] tool call: {part.function_call.name}({arg_preview})")
                elif part.function_response:
                    print(f"[{elapsed:6.1f}s] tool done: {part.function_response.name}")
            if event.is_final_response() and event.content and event.content.parts:
                text = "".join(p.text or "" for p in event.content.parts)
                if text.strip():
                    final_text = text

    flush_tracing()
    elapsed = time.monotonic() - started
    if not final_text:
        sys.exit("No final response from the agent.")

    explanation = Explanation.model_validate_json(final_text)
    print(f"--- explanation (validated, {elapsed:.1f}s total) ---")
    print(explanation.model_dump_json(indent=2))


if __name__ == "__main__":
    asyncio.run(main())
