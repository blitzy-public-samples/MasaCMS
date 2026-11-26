# Multi-tenant Identity Platform config.
resource "google_identity_platform_config" "this" {
  project = var.project_id

  multi_tenant {
    allow_tenants = true
  }
}

# One tenant per user-pool site.
resource "google_identity_platform_tenant" "this" {
  for_each = toset(var.tenant_display_names)

  project      = var.project_id
  display_name = each.value

  depends_on = [google_identity_platform_config.this]
}
