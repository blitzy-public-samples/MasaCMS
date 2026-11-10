# Inputs of the identity_platform module.

variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "tenant_display_names" {
  description = "Identity Platform tenant display names, one per user-pool site; 4-20 chars, starting with a letter, letters, digits and hyphens only."
  type        = list(string)
}
