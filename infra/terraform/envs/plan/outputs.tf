# Outputs of the plan-only root module; none carries a credential.

output "service_urls" {
  description = "Cloud Run service name to its deterministic run.app URL."
  value       = local.service_urls
}

output "service_account_emails" {
  description = "Service account name to email."
  value       = local.emails
}

output "sql_connection_name" {
  description = "Cloud SQL instance connection name; unknown until creation."
  value       = module.cloud_sql.connection_name
}

output "queue_names" {
  description = "Cloud Tasks queue names, sorted."
  value       = keys(var.queues)
}

output "bucket_names" {
  description = "Cloud Storage bucket names, sorted."
  value       = keys(local.buckets)
}

output "identity_platform_tenants" {
  description = "Tenant display name to Identity Platform tenant id."
  value       = module.identity_platform.tenants
}

output "min_instance_counts" {
  description = "Cloud Run service name to its planned min_instance_count."
  value       = local.min_instance_counts
}
