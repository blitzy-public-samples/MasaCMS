# Outputs of the cloud_sql_postgres module.

output "instance_name" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.this.name
}

output "connection_name" {
  description = "Instance connection name (project:region:instance); unknown until creation."
  value       = google_sql_database_instance.this.connection_name
}

output "database_name" {
  description = "Application database name."
  value       = google_sql_database.this.name
}

output "iam_user_names" {
  description = "Map of service-account email to Cloud SQL IAM user name."
  value       = { for e, u in google_sql_user.iam : e => u.name }
}
