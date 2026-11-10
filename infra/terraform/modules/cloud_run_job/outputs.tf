# Outputs of the cloud_run_job module.

output "name" {
  description = "Job name."
  value       = google_cloud_run_v2_job.this.name
}

output "id" {
  description = "Job resource id."
  value       = google_cloud_run_v2_job.this.id
}
