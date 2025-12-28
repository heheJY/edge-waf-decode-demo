# Edge WAF Decode Complement Demo

## What this demonstrates
- WAF/Transform decoding is limited for JSON bodies and non-base64 encodings.
- Workers cannot run before WAF in the same hop.
- We solve this by:
  - `ai.example.com` Worker router: decode ONLY if suspicious
  - `ai-inspect.example.com`: Firewall for AI + WAF enforcement
  - `ai-origin.example.com`: mock origin

## Deploy
```bash
export TF_VAR_account_id="..."
export TF_VAR_zone_id="..."
export TF_VAR_zone_name="example.com"
export CLOUDFLARE_API_TOKEN="YOUR_TOKEN"

bash scripts/10_deploy.sh
