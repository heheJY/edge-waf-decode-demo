variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "zone_name" {
  type = string
}

variable "public_host" {
  type    = string
  default = "ai"
}

variable "inspect_host" {
  type    = string
  default = "ai-inspect"
}

variable "origin_host" {
  type    = string
  default = "ai-origin"
}

variable "compatibility_date" {
  type    = string
  default = "2025-12-01"
}

variable "skip_waf_on_public" {
  type    = bool
  default = true
}

variable "enable_firewall_ai_rules" {
  type    = bool
  default = false
}
