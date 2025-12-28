locals {
  public_fqdn  = "${var.public_host}.${var.zone_name}"
  inspect_fqdn = "${var.inspect_host}.${var.zone_name}"
  origin_fqdn  = "${var.origin_host}.${var.zone_name}"
}

# -------------------------
# DNS (proxied)
# -------------------------
resource "cloudflare_dns_record" "public" {
  zone_id = var.zone_id
  name    = var.public_host
  type    = "A"
  content = "192.0.2.1"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "inspect" {
  zone_id = var.zone_id
  name    = var.inspect_host
  type    = "A"
  content = "192.0.2.1"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "origin" {
  zone_id = var.zone_id
  name    = var.origin_host
  type    = "A"
  content = "192.0.2.1"
  proxied = true
  ttl     = 1
}

# -------------------------
# Origin Worker
# -------------------------
resource "cloudflare_worker" "origin" {
  account_id    = var.account_id
  name          = "demo-ai-origin"
  observability = { enabled = true }
}

resource "cloudflare_worker_version" "origin_v1" {
  account_id         = var.account_id
  worker_id          = cloudflare_worker.origin.id
  compatibility_date = var.compatibility_date
  main_module        = "origin.mjs"

  modules = [
    {
      name         = "origin.mjs"
      content_type = "application/javascript+module"
      content_file = "${path.module}/../workers/origin.mjs"
    }
  ]
}

resource "cloudflare_workers_deployment" "origin_deploy" {
  account_id  = var.account_id
  script_name = cloudflare_worker.origin.name
  strategy    = "percentage"
  versions    = [{ percentage = 100, version_id = cloudflare_worker_version.origin_v1.id }]
}

resource "cloudflare_workers_route" "origin_route" {
  zone_id = var.zone_id
  pattern = "${local.origin_fqdn}/*"
  script  = cloudflare_worker.origin.name
}

# -------------------------
# Inspect Worker (enforcement hop)
# -------------------------
resource "cloudflare_worker" "inspect" {
  account_id    = var.account_id
  name          = "demo-ai-inspect"
  observability = { enabled = true }
}

resource "cloudflare_worker_version" "inspect_v1" {
  account_id         = var.account_id
  worker_id          = cloudflare_worker.inspect.id
  compatibility_date = var.compatibility_date
  main_module        = "inspect.mjs"

  modules = [
    {
      name         = "inspect.mjs"
      content_type = "application/javascript+module"
      content_file = "${path.module}/../workers/inspect.mjs"
    }
  ]

  bindings = [
    { type="service", name="ORIGIN", service=cloudflare_worker.origin.name },
    { type="plain_text", name="DEBUG_SHORTCIRCUIT", text="0" }
  ]

}


resource "cloudflare_workers_deployment" "inspect_deploy" {
  account_id  = var.account_id
  script_name = cloudflare_worker.inspect.name
  strategy    = "percentage"
  versions    = [{ percentage = 100, version_id = cloudflare_worker_version.inspect_v1.id }]
}

resource "cloudflare_workers_route" "inspect_route" {
  zone_id = var.zone_id
  pattern = "${local.inspect_fqdn}/*"
  script  = cloudflare_worker.inspect.name
}

# -------------------------
# Router Worker (public entry)
# -------------------------
resource "cloudflare_worker" "router" {
  account_id    = var.account_id
  name          = "demo-ai-router-normalizer"
  observability = { enabled = true }
}

resource "cloudflare_worker_version" "router_v1" {
  account_id         = var.account_id
  worker_id          = cloudflare_worker.router.id
  compatibility_date  = "2025-12-28"
  compatibility_flags = ["global_fetch_strictly_public"]
  main_module        = "router.mjs"

  modules = [
    {
      name         = "router.mjs"
      content_type = "application/javascript+module"
      content_file = "${path.module}/../workers/router.mjs"
    }
  ]

  bindings = [
    {
      type = "plain_text"
      name = "INSPECT_HOST"
      text = local.inspect_fqdn
    }
  ]
}


resource "cloudflare_workers_deployment" "router_deploy" {
  account_id  = var.account_id
  script_name = cloudflare_worker.router.name
  strategy    = "percentage"
  versions    = [{ percentage = 100, version_id = cloudflare_worker_version.router_v1.id }]
}

resource "cloudflare_workers_route" "router_route" {
  zone_id = var.zone_id
  pattern = "${local.public_fqdn}/*"
  script  = cloudflare_worker.router.name
}

# -------------------------
# Custom WAF ruleset entrypoint (IMPORT REQUIRED)
# -------------------------
# This resource MUST be imported into state (scripts handle it).
resource "cloudflare_ruleset" "waf_custom_entrypoint" {
  zone_id = var.zone_id
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  # Avoid Terraform trying to rename/replace the existing entrypoint ruleset.
  lifecycle {
    ignore_changes = [name, description]
  }

  # NOTE: Name/description values are ignored (imported ruleset controls them).
  name        = "entrypoint: http_request_firewall_custom (managed rules only)"
  description = "Managed by Terraform via imported entrypoint ruleset."

  rules = concat(
    # Ensure router worker runs on public host (optional)
    var.skip_waf_on_public ? [
      {
        action      = "skip"
        enabled     = true
        description = "ai public: ensure router worker runs (skip managed WAF+ratelimit)"
        expression  = "(http.host eq \"${local.public_fqdn}\" and http.request.method eq \"POST\" and http.request.uri.path eq \"/v1/chat/completions\")"
        action_parameters = {
          phases = [
            "http_request_firewall_managed",
            "http_ratelimit"
          ]
        }
      }
    ] : [],

    [
      # Allow router->inspect traffic to reach inspect worker by skipping managed phases
      {
        action      = "skip"
        enabled     = true
        description = "ai-inspect: router-marked traffic skips managed WAF+ratelimit"
        expression  = "(http.host eq \"${local.inspect_fqdn}\" and http.request.method eq \"POST\" and http.request.uri.path eq \"/v1/chat/completions\" and http.request.headers[\"x-cf-ai-router\"][0] eq \"1\")"
        action_parameters = {
          phases = [
            "http_request_firewall_managed",
            "http_ratelimit"
          ]
        }
      },

      # Anti-bypass: block direct ai-inspect calls without router header
      {
        action      = "block"
        enabled     = true
        description = "ai-inspect: block direct bypass (missing x-cf-ai-router)"
        expression  = "(http.host eq \"${local.inspect_fqdn}\" and http.request.method eq \"POST\" and http.request.uri.path eq \"/v1/chat/completions\" and not http.request.headers[\"x-cf-ai-router\"][0] eq \"1\")"
      }
    ],

    var.enable_firewall_ai_rules ? [
      {
        action      = "block"
        enabled     = true
        description = "ai-inspect: block likely prompt injection (Firewall for AI)"
        expression  = "(http.host eq \"${local.inspect_fqdn}\" and cf.llm.prompt.injection_score < 20)"
      },
      {
        action      = "block"
        enabled     = true
        description = "ai-inspect: block if PII detected (Firewall for AI)"
        expression  = "(http.host eq \"${local.inspect_fqdn}\" and cf.llm.prompt.pii_detected)"
      }
    ] : []
  )
}
