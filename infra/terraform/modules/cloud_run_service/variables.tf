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
}

variable "min_instance_count" {
  description = "Minimum instances; 0 scales to zero."
  type        = number
  default     = 0
}

variable "cpu_idle" {
  description = "Throttle CPU outside requests."
  type        = bool
  default     = true
}

variable "env" {
  description = "Plain env vars of the app container; PORT is reserved by Cloud Run and must not be passed."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "App env var name to Secret Manager secret id."
  type        = map(string)
  default     = {}
}

variable "otel_image" {
  description = "OpenTelemetry Collector sidecar image."
  type        = string
  default     = "us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.163.1"
}

variable "invoker_members" {
  description = "IAM members granted roles/run.invoker, e.g. allUsers or serviceAccount:<email>."
  type        = list(string)
  default     = []
}
