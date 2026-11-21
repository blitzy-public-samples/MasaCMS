# Outputs of the secret module; ids only, never payloads.
output "secret_id" {
  description = "Secret ID."
  value       = google_secret_manager_secret.this.secret_id
}

output "id" {
  description = "Full secret resource name."
  value       = google_secret_manager_secret.this.id
}

output "version_id" {
  description = "Version resource name, or null when no version exists."
  value       = one(google_secret_manager_secret_version.this[*].id)
}
