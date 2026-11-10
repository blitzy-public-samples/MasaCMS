# Outputs of the network module.

output "network_id" {
  description = "VPC network id."
  value       = google_compute_network.this.id
}

output "network_name" {
  description = "VPC network name."
  value       = google_compute_network.this.name
}

output "subnetwork_id" {
  description = "Subnet id."
  value       = google_compute_subnetwork.this.id
}

output "subnetwork_name" {
  description = "Subnet name for Direct VPC egress."
  value       = google_compute_subnetwork.this.name
}

output "private_network" {
  description = "Network id for Cloud SQL private IP, available once private services access exists."
  value       = google_service_networking_connection.this.network
}
