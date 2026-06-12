#!/bin/sh
# Warms up the "payment failures" Dynatrace problem before a demo.
#
# Enables the payment_timeout chaos flag, then fires repeated payment-session
# attempts spaced so the failures land in several distinct minutes — the Davis
# anomaly detector (dynatrace/payment_anomaly_detector.py) needs 2+ violating
# minutes within its 15-minute window to open the problem. Expect the problem
# to be ACTIVE ~2-3 minutes after this script finishes; it stays open ~15
# minutes past the last failure, so run your on-camera incident inside that.
#
# Leaves payment_timeout chaos ON (the demo needs it). Each attempt also
# creates an incident row and kicks the explainer pipeline — harmless.
set -e

# Override to warm up a deployed store, e.g. SWW_BASE=http://34.82.29.34:9000
BASE=${SWW_BASE:-http://localhost:9000}
PK=pk_98cd485c718acd8f25a926e0cff630f1147eb2664f1edfea98471f444a5f9c34
H="x-publishable-api-key: $PK"
J="Content-Type: application/json"

ATTEMPTS=${1:-6}
SPACING_S=${2:-25}

jqpy() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

echo "Enabling payment_timeout chaos..." >&2
curl -sf -X POST -H "$J" -d '{"scenario":"payment_timeout","enabled":true}' \
  "$BASE/admin/chaos" | jqpy "d['chaos']" >&2

REGION=$(curl -sf -H "$H" "$BASE/store/regions" | jqpy "d['regions'][0]['id']")
VARIANT=$(curl -sf -H "$H" "$BASE/store/products?region_id=$REGION&limit=1&fields=*variants" | jqpy "d['products'][0]['variants'][0]['id']")

CART=$(curl -sf -X POST -H "$H" -H "$J" -d "{\"region_id\":\"$REGION\",\"email\":\"shopper@sww.local\"}" "$BASE/store/carts" | jqpy "d['cart']['id']")
curl -sf -X POST -H "$H" -H "$J" -d "{\"variant_id\":\"$VARIANT\",\"quantity\":1}" "$BASE/store/carts/$CART/line-items" > /dev/null
PAYCOL=$(curl -sf -X POST -H "$H" -H "$J" -d "{\"cart_id\":\"$CART\"}" "$BASE/store/payment-collections" | jqpy "d['payment_collection']['id']")
echo "cart=$CART payment_collection=$PAYCOL" >&2

i=1
while [ "$i" -le "$ATTEMPTS" ]; do
  # Expected to fail with 500 after the 3s fake-PSP timeout — that error
  # span is exactly what the anomaly detector counts.
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "$H" -H "$J" \
    -d '{"provider_id":"pp_system_default"}' \
    "$BASE/store/payment-collections/$PAYCOL/payment-sessions")
  echo "attempt $i/$ATTEMPTS -> HTTP $CODE $( [ "$CODE" = 500 ] && echo '(failure recorded)' || echo '(expected 500 — is chaos on?)' )" >&2
  if [ "$i" -lt "$ATTEMPTS" ]; then sleep "$SPACING_S"; fi
  i=$((i + 1))
done

echo "Done. Problem should open in Dynatrace within ~2-3 minutes and persist" >&2
echo "~15 minutes after the last failure. payment_timeout chaos is still ON." >&2
