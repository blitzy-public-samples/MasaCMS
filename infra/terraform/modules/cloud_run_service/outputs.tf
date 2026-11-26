# Outputs of the cloud_run_service module.

output "name" {
  description = "Cloud Run service name."
  value       = google_cloud_run_v2_service.this.name
}

output "id" {
  description = "Cloud Run service id."
  value       = google_cloud_run_v2_service.this.id
}

output "location" {
  description = "Cloud Run service region."
  value       = google_cloud_run_v2_service.this.location
}
