# Outputs of the pubsub_topic module.

output "topic_name" {
  description = "Event topic name."
  value       = google_pubsub_topic.this.name
}

output "subscription_names" {
  description = "Push subscription names."
  value       = [for s in google_pubsub_subscription.push : s.name]
}

output "dlq_topic_names" {
  description = "Dead-letter topic names."
  value       = [for t in google_pubsub_topic.dlq : t.name]
}
