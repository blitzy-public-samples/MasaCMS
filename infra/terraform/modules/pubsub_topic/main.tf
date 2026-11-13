# One event topic with ordered OIDC push subscriptions and their dead-letter topics.
locals {
  pubsub_agent = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic" "this" {
  project = var.project_id
  name    = var.topic_name
}

resource "google_pubsub_topic_iam_member" "producer" {
  project = var.project_id
  topic   = google_pubsub_topic.this.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.producer_email}"
}

resource "google_pubsub_topic" "dlq" {
  for_each = var.subscriptions

  project = var.project_id
  name    = each.value.dlq_topic
}

resource "google_pubsub_subscription" "push" {
  for_each = var.subscriptions

  project                 = var.project_id
  name                    = each.key
  topic                   = google_pubsub_topic.this.id
  enable_message_ordering = true

  push_config {
    push_endpoint = each.value.push_endpoint

    oidc_token {
      service_account_email = var.pubsub_invoker_email
      audience              = each.value.push_endpoint
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq[each.key].id
    max_delivery_attempts = each.value.max_delivery_attempts
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

resource "google_pubsub_subscription" "dlq_replay" {
  for_each = var.subscriptions

  project = var.project_id
  name    = each.value.dlq_replay_subscription
  topic   = google_pubsub_topic.dlq[each.key].id
}

resource "google_pubsub_topic_iam_member" "dlq_agent" {
  for_each = var.subscriptions

  project = var.project_id
  topic   = google_pubsub_topic.dlq[each.key].name
  role    = "roles/pubsub.publisher"
  member  = local.pubsub_agent
}

resource "google_pubsub_subscription_iam_member" "agent" {
  for_each = var.subscriptions

  project      = var.project_id
  subscription = google_pubsub_subscription.push[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}

resource "google_pubsub_topic_iam_member" "dlq_consumer" {
  for_each = var.subscriptions

  project = var.project_id
  topic   = google_pubsub_topic.dlq[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value.consumer_email}"
}
