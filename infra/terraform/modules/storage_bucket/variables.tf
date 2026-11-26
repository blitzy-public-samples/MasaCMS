# Inputs of the storage_bucket module.

variable "project_id" {
  description = "Project that holds the bucket."
  type        = string
}

variable "region" {
  description = "Bucket location."
  type        = string
}

variable "name" {
  description = "Global bucket name, used verbatim."
  type        = string
}

variable "object_admin_emails" {
  description = "Service-account emails granted object admin; must be known at plan time."
  type        = list(string)
  default     = []
}
