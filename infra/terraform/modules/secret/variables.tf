# Inputs of the secret module.
variable "project_id" {
  description = "Project that owns the secret."
  type        = string
}

variable "secret_id" {
  description = "Secret Manager secret ID."
  type        = string
}

variable "data" {
  description = "Payload of the single version; null creates the container without a version."
  type        = string
  default     = null
}

variable "accessor_members" {
  description = "IAM members granted secretAccessor, e.g. serviceAccount:<email>."
  type        = list(string)
  default     = []
}
