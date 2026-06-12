"""Create (or update) the Davis anomaly detector that opens a Dynatrace
problem when payment failures spike on medusa-backend.

Why: the explainer agent's phase B cross-checks `query-problems`. An ACTIVE
"payment processing is failing" problem is what lets it conclude SYSTEM fault
("payments are failing for everyone"), not just "your request hit a bug".

Detection logic (evaluated every minute by Davis):
  - DQL counts error spans whose name contains "payment" on medusa-backend,
    per 1-minute bucket;
  - a minute with >= 1 failure is a violating sample;
  - 2+ violating samples within a 15-minute sliding window opens the problem;
  - the problem closes after 15 clean minutes (dealerting), so it persists
    roughly 15 minutes past the last failure — long enough for a demo.

Usage:
    agent/.venv/bin/python dynatrace/payment_anomaly_detector.py

Requires DT_ENVIRONMENT_NAME + DT_PLATFORM_TOKEN in .env; the token must have
settings:objects:read, settings:objects:write (and settings:schemas:read).
Idempotent: re-running updates the existing detector by title.
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

import certifi

SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())

ROOT = os.path.join(os.path.dirname(__file__), "..")


def load_env() -> None:
    with open(os.path.join(ROOT, ".env")) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())


load_env()
DT_ENV = os.environ.get("DT_ENVIRONMENT_NAME")
DT_TOKEN = os.environ.get("DT_PLATFORM_TOKEN")
if not DT_ENV or not DT_TOKEN:
    sys.exit("Set DT_ENVIRONMENT_NAME and DT_PLATFORM_TOKEN in .env first.")

BASE = f"https://{DT_ENV}.apps.dynatrace.com/platform/classic/environment-api/v2"
SCHEMA_ID = "builtin:davis.anomaly-detectors"

TITLE = "Payment failures — checkout payments failing repeatedly"

QUERY = (
    "fetch spans "
    '| filter service.name == "medusa-backend" '
    'and span.status_code == "error" '
    'and contains(span.name, "payment") '
    "| makeTimeseries failures = count(default: 0), "
    "by: {dt.entity.service}, interval: 1m"
)

DETECTOR_VALUE = {
    "enabled": True,
    "title": TITLE,
    "description": (
        "Opens a problem when checkout payment attempts fail repeatedly "
        "within a 15-minute window. Read by the explainer agent (phase B "
        "query-problems cross-check) to classify payment incidents as a "
        "system-wide outage."
    ),
    "source": "Rest-API",
    "executionSettings": {"actor": None, "queryOffset": None},
    "analyzer": {
        "name": (
            "dt.statistics.ui.anomaly_detection."
            "StaticThresholdAnomalyDetectionAnalyzer"
        ),
        "input": [
            {"key": "query", "value": QUERY},
            {"key": "threshold", "value": "0"},
            {"key": "alertCondition", "value": "ABOVE"},
            {"key": "alertOnMissingData", "value": "false"},
            {"key": "violatingSamples", "value": "2"},
            {"key": "slidingWindow", "value": "15"},
            {"key": "dealertingSamples", "value": "15"},
        ],
    },
    "eventTemplate": {
        "properties": [
            {"key": "dt.source_entity", "value": "{dims:dt.entity.service}"},
            {"key": "event.type", "value": "CUSTOM_ALERT"},
            {
                "key": "event.name",
                "value": (
                    "Payment processing is failing for multiple customers"
                ),
            },
            {
                "key": "event.description",
                "value": (
                    "Checkout payment attempts on "
                    "{dims:dt.entity.service.name} are failing repeatedly: "
                    "the payment provider (fakepay) is not responding within "
                    "the client timeout on createPaymentSession. Multiple "
                    "checkout attempts are affected; no charges are made."
                ),
            },
        ]
    },
}


def request(method: str, path: str, body=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {DT_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, context=SSL_CONTEXT) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main() -> None:
    params = urllib.parse.urlencode(
        {"schemaIds": SCHEMA_ID, "fields": "objectId,value"}
    )
    status, listing = request("GET", f"/settings/objects?{params}")
    if status == 403:
        print(json.dumps(listing, indent=2))
        sys.exit(
            "\n❌ 403 — the Platform Token is missing settings scopes.\n"
            "Add these scopes (Account Management > Platform tokens):\n"
            "  settings:objects:read, settings:objects:write, "
            "settings:schemas:read\n"
            "then re-run this script."
        )
    if status != 200:
        print(json.dumps(listing, indent=2))
        sys.exit(f"❌ Listing settings objects failed (HTTP {status}).")

    existing = next(
        (
            o
            for o in listing.get("items", [])
            if o.get("value", {}).get("title") == TITLE
        ),
        None,
    )

    if existing:
        object_id = existing["objectId"]
        status, result = request(
            "PUT",
            f"/settings/objects/{object_id}",
            {"value": DETECTOR_VALUE},
        )
        action = "updated"
    else:
        status, result = request(
            "POST",
            "/settings/objects",
            [
                {
                    "schemaId": SCHEMA_ID,
                    "scope": "environment",
                    "value": DETECTOR_VALUE,
                }
            ],
        )
        action = "created"

    print(json.dumps(result, indent=2))
    if status in (200, 201):
        print(f"\n✅ Anomaly detector {action}: {TITLE!r}")
        print(
            "Davis evaluates it every minute. Warm it up before a demo with "
            "scripts/warmup_payment_problem.sh"
        )
    else:
        sys.exit(f"\n❌ Detector {action} failed (HTTP {status}) — see above.")


if __name__ == "__main__":
    main()
