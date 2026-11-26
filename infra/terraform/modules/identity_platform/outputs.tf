# Outputs of the identity_platform module.

output "tenants" {
  description = "Tenant display name to Identity Platform tenant id."
  value       = { for k, t in google_identity_platform_tenant.this : k => t.name }
}
