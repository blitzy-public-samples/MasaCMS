# Inputs of the cloud_run_job module.

variable "project_id" {
  description = "Project that holds the job."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
}

variable "name" {
  description = "Job name."
  type        = string
}

variable "image" {
  description = "Container image reference."
  type        = string
}

variable "service_account_email" {
  description = "Runtime service account email."
  type        = string
}

variable "network" {
  description = "VPC network for Direct VPC egress."
  type        = string
}

variable "subnetwork" {
  description = "Subnetwork for Direct VPC egress."
  type        = string
}

variable "command" {
  description = "Container entrypoint override; null keeps the image default."
  type        = list(string)
  default     = null
}

variable "args" {
  description = "Container arguments; null keeps the image default."
  type        = list(string)
  default     = null
}

variable "env" {
  description = "Plain environment variables."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Env name to Secret Manager secret id."
  type        = map(string)
  default     = {}
}

variable "max_retries" {
  description = "Retries per failed task."
  type        = number
  default     = 0
}
