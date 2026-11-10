# Inputs of the cloud_sql_postgres module.

variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "region" {
  description = "Region of the instance."
  type        = string
}

variable "instance_name" {
  description = "Cloud SQL instance name."
  type        = string
}

variable "database_name" {
  description = "Application database name."
  type        = string
}

variable "tier" {
  description = "Machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "private_network" {
  description = "VPC network id for private IP (from modules/network output private_network)."
  type        = string
}

variable "iam_service_account_emails" {
  description = "Service-account emails that get Cloud SQL IAM database users."
  type        = list(string)
}
