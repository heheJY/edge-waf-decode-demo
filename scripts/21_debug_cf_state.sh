#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${TF_VAR_zone_id:?set TF_VAR_zone_id}"
: "${TF_VAR_zone_name:?set TF_VAR_zone_name}"

hdr=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

want1="ai.${TF_VAR_zone_name}"
want2="ai-inspect.${TF_VAR_zone_name}"
want3="ai-origin.${TF_VAR_zone_name}"

echo "== Zone =="
echo "zone_id=${TF_VAR_zone_id}"
echo "zone_name=${TF_VAR_zone_name}"
echo

echo "== DNS records (ai, ai-inspect, ai-origin) =="
dns_json="$(curl -sS "${hdr[@]}" "https://api.cloudflare.com/client/v4/zones/${TF_VAR_zone_id}/dns_records?per_page=500")"

# Fail early if API didn't return JSON
echo "$dns_json" | head -c 1 | grep -q '{' || {
  echo "[!] dns_records response is not JSON. First 300 bytes:"
  echo "$dns_json" | head -c 300
  echo
  exit 1
}

echo "$dns_json" | jq -r --arg w1 "$want1" --arg w2 "$want2" --arg w3 "$want3" '
  if .success != true then
    "API error: " + ( .errors|tostring )
  else
    (.result[]
      | select(.name==$w1 or .name==$w2 or .name==$w3)
      | {name, type, content, proxied, id}
    )
  end
' || true

echo
echo "== Worker routes (zone) =="
routes_json="$(curl -sS "${hdr[@]}" "https://api.cloudflare.com/client/v4/zones/${TF_VAR_zone_id}/workers/routes")"

echo "$routes_json" | head -c 1 | grep -q '{' || {
  echo "[!] workers/routes response is not JSON. First 300 bytes:"
  echo "$routes_json" | head -c 300
  echo
  exit 1
}

echo "$routes_json" | jq -r --arg z "$TF_VAR_zone_name" '
  if .success != true then
    "API error: " + ( .errors|tostring )
  else
    (.result[]
      | select(.pattern | test("ai\\."+$z+"\\/\\*|ai-inspect\\."+$z+"\\/\\*|ai-origin\\."+$z+"\\/\\*"))
    )
  end
' || true

echo
echo "== What you should see =="
echo "- DNS: ai.${TF_VAR_zone_name}, ai-inspect.${TF_VAR_zone_name}, ai-origin.${TF_VAR_zone_name} all present and proxied=true"
echo "- Routes: patterns ai.${TF_VAR_zone_name}/*, ai-inspect.${TF_VAR_zone_name}/*, ai-origin.${TF_VAR_zone_name}/* each mapped to the correct worker script"
