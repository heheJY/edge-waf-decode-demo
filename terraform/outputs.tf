output "public_url" {
  value = "https://${local.public_fqdn}/v1/chat/completions"
}

output "inspect_url" {
  value = "https://${local.inspect_fqdn}/v1/chat/completions"
}

output "origin_url" {
  value = "https://${local.origin_fqdn}/v1/chat/completions"
}
