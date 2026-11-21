# Outputs of the cloud_tasks_queue module.

output "name" {
  description = "Queue name."
  value       = google_cloud_tasks_queue.this.name
}

output "id" {
  description = "Queue resource id."
  value       = google_cloud_tasks_queue.this.id
}
