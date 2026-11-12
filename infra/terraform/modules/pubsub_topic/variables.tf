# Inputs of the pubsub_topic module.

variable "project_id" {
  description = "Project that owns the topic and subscriptions."
  type        = string
}

variable "project_number" {
  description = "Project number, used for the Pub/Sub service agent."
  type        = string
}

variable "topic_name" {
  description = "Event topic name."
  type        = string
}

variable "producer_email" {
  description = "Service account email of the producing service."
  type        = string
}

variable "pubsub_invoker_email" {
  description = "Service account email whose OIDC token signs push requests."
  type        = string
}

variable "subscriptions" {
  description = "Push subscriptions keyed by subscription name."
  type = map(object({
    push_endpoint           = string
    consumer_email          = string
    dlq_topic               = string
    dlq_replay_subscription = string
    max_delivery_attempts   = number
  }))
  default = {}
}
