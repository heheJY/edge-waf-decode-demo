#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?need CLOUDFLARE_API_TOKEN}"
: "${TF_VAR_zone_id:?need TF_VAR_zone_id}"

curl -sS "https://api.cloudflare.com/client/v4/zones/${TF_VAR_zone_id}/firewall-for-ai/settings" \
  --request PUT \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --data '{"pii_detection_enabled": true}' | jq .
