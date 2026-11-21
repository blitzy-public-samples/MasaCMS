# Outputs of the service_account module.

output "email" {
  description = "Service account email."
  value       = google_service_account.this.email
}

output "member" {
  description = "IAM member string for the account."
  value       = "serviceAccount:${google_service_account.this.email}"
}

output "id" {
  description = "Service account resource id."
  value       = google_service_account.this.id
}
