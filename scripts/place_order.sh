#!/bin/sh
# Places a complete test order against the local Medusa backend.
# Prints the order id on success. Used to verify traces reach Dynatrace.
set -e

BASE=http://localhost:9000
PK=pk_98cd485c718acd8f25a926e0cff630f1147eb2664f1edfea98471f444a5f9c34
H="x-publishable-api-key: $PK"
J="Content-Type: application/json"

jqpy() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

REGION=$(curl -sf -H "$H" "$BASE/store/regions" | jqpy "d['regions'][0]['id']")
VARIANT=$(curl -sf -H "$H" "$BASE/store/products?region_id=$REGION&limit=1&fields=*variants" | jqpy "d['products'][0]['variants'][0]['id']")
echo "region=$REGION variant=$VARIANT" >&2

CART=$(curl -sf -X POST -H "$H" -H "$J" -d "{\"region_id\":\"$REGION\",\"email\":\"shopper@sww.local\"}" "$BASE/store/carts" | jqpy "d['cart']['id']")
echo "cart=$CART" >&2

curl -sf -X POST -H "$H" -H "$J" -d "{\"variant_id\":\"$VARIANT\",\"quantity\":1}" "$BASE/store/carts/$CART/line-items" > /dev/null

ADDR='{"first_name":"Test","last_name":"Shopper","address_1":"Nyhavn 1","city":"Copenhagen","postal_code":"1051","country_code":"dk"}'
curl -sf -X POST -H "$H" -H "$J" -d "{\"shipping_address\":$ADDR,\"billing_address\":$ADDR}" "$BASE/store/carts/$CART" > /dev/null

SHIPOPT=$(curl -sf -H "$H" "$BASE/store/shipping-options?cart_id=$CART" | jqpy "d['shipping_options'][0]['id']")
curl -sf -X POST -H "$H" -H "$J" -d "{\"option_id\":\"$SHIPOPT\"}" "$BASE/store/carts/$CART/shipping-methods" > /dev/null
echo "shipping=$SHIPOPT" >&2

PAYCOL=$(curl -sf -X POST -H "$H" -H "$J" -d "{\"cart_id\":\"$CART\"}" "$BASE/store/payment-collections" | jqpy "d['payment_collection']['id']")
curl -sf -X POST -H "$H" -H "$J" -d '{"provider_id":"pp_system_default"}' "$BASE/store/payment-collections/$PAYCOL/payment-sessions" > /dev/null
echo "payment_collection=$PAYCOL" >&2

curl -sf -X POST -H "$H" "$BASE/store/carts/$CART/complete" | jqpy "('ORDER '+d['order']['id']) if d.get('type')=='order' else ('FAILED: '+json.dumps(d)[:300])"
