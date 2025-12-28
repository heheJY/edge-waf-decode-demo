#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${TF_VAR_account_id:?set TF_VAR_account_id}"
: "${TF_VAR_zone_id:?set TF_VAR_zone_id}"
: "${TF_VAR_zone_name:?set TF_VAR_zone_name}"

unset CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CLOUDFLARE_API_USER_SERVICE_KEY || true

pushd terraform >/dev/null
terraform init
terraform apply -auto-approve
terraform output
popd >/dev/null

echo
echo "== Post-deploy Cloudflare state check =="
bash scripts/21_debug_cf_state.sh

echo "[ok] deploy complete"
