#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${TF_VAR_zone_id:?set TF_VAR_zone_id}"

cd terraform

if terraform state list | grep -q '^cloudflare_ruleset\.waf_custom_entrypoint$'; then
  echo "[ok] entrypoint ruleset already imported"
  exit 0
fi

echo "[info] fetching entrypoint ruleset id for http_request_firewall_custom..."
RULESET_ID="$(curl -sS \
  "https://api.cloudflare.com/client/v4/zones/${TF_VAR_zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
| python3 - <<'PY'
import sys, json
d=json.load(sys.stdin)
rid=(d.get("result") or {}).get("id","")
if not rid:
    print(d)
    sys.exit(1)
print(rid)
PY
)"

echo "[info] importing ruleset zones/${TF_VAR_zone_id}/${RULESET_ID}"
terraform import cloudflare_ruleset.waf_custom_entrypoint "zones/${TF_VAR_zone_id}/${RULESET_ID}"
echo "[ok] imported"
