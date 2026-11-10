# Inputs of the service_account module.

variable "project_id" {
  description = "Project that owns the service account and its bindings."
  type        = string
}

variable "name" {
  description = "Account name; the account id is opt2-<name>."
  type        = string
}

variable "display_name" {
  description = "Human-readable account name."
  type        = string
}

variable "project_roles" {
  description = "Project-level roles granted to the account."
  type        = list(string)
  default     = []
}

variable "account_iam" {
  description = "Roles other principals hold on this account."
  type = list(object({
    role   = string
    member = string
  }))
  default = []
}
