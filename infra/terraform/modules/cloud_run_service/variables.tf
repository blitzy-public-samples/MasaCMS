# Inputs of the cloud_run_service module.

variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Cloud Run region."
  type        = string
}

variable "name" {
  description = "Cloud Run service name, e.g. gateway or migration."
  type        = string
}

variable "image" {
  description = "App container image reference with a pinned tag or digest, never latest."
  type        = string
}

variable "service_account_email" {
  description = "Runtime service account email."
  type        = string
}

variable "network" {
  description = "VPC network id or self link for Direct VPC egress."
  type        = string
}

variable "subnetwork" {
  description = "Subnetwork id or self link for Direct VPC egress."
  type        = string
}

variable "otel_config_secret_id" {
  description = "Secret Manager secret id holding the collector config."
  type        = string
}

variable "ingress" {
  description = "Ingress setting; only the gateway uses INGRESS_TRAFFIC_ALL."
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = var.ingress == (var.name == "gateway" ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY")
    error_message = "Ingress must be INGRESS_TRAFFIC_ALL for the gateway and INGRESS_TRAFFIC_INTERNAL_ONLY for every other service."
  }
}

variable "min_instance_count" {
  description = "Minimum instances; 0 scales to zero."
  type        = number
  default     = 0

  validation {
    condition     = var.min_instance_count == (var.name == "migration" ? 1 : 0)
    error_message = "Minimum instances must be 1 for migration and 0 for every other service."
  }
}

variable "env" {
  description = "Plain env vars of the app container; PORT is reserved by Cloud Run and must not be passed."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.env), "PORT")
    error_message = "Env must not set PORT, which Cloud Run injects."
  }
}

variable "secret_env" {
  description = "App env var name to Secret Manager secret id."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.secret_env), "PORT")
    error_message = "Secret env must not set PORT, which Cloud Run injects."
  }

  validation {
    condition     = length(setintersection(keys(var.env), keys(var.secret_env))) == 0
    error_message = "Env and secret env must not share a variable name."
  }
}

variable "otel_image" {
  description = "OpenTelemetry Collector sidecar image."
  type        = string
  default     = "us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.163.1"

  validation {
    condition     = var.otel_image == "us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.163.1"
    error_message = "The collector image must be the pinned otelcol-google:0.163.1."
  }
}

variable "invoker_members" {
  description = "IAM members granted roles/run.invoker, e.g. allUsers or serviceAccount:<email>."
  type        = list(string)
  default     = []

  validation {
    condition     = contains(var.invoker_members, "allUsers") == (var.name == "gateway") && !contains(var.invoker_members, "allAuthenticatedUsers")
    error_message = "Invokers must include allUsers on the gateway only and never allAuthenticatedUsers."
  }
}
