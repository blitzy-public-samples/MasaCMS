# Inputs of the cloud_tasks_queue module.

variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "region" {
  description = "Cloud Tasks location."
  type        = string
}

variable "name" {
  description = "Queue name; equals the platform queue name."
  type        = string
}

variable "retry" {
  description = "Retry policy; durations are strings such as \"10s\", and max_retry_duration may be omitted."
  type = object({
    max_attempts       = number
    min_backoff        = string
    max_backoff        = string
    max_doublings      = number
    max_retry_duration = optional(string)
  })
}

variable "creator_emails" {
  description = "Service-account emails that create tasks on and pause or resume the queue."
  type        = list(string)
  default     = []
}
