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
  # The push request timeout; above the consumer's 30 s gate wait so a waiting delivery's answer reaches Pub/Sub.
  ack_deadline_seconds = 60

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

# Keyed by replay subscription and email so bindings stay stable when either list is reordered.
resource "google_pubsub_subscription_iam_member" "replay_subscriber" {
  for_each = {
    for pair in setproduct(keys(var.subscriptions), distinct(var.replay_subscriber_emails)) :
    "${var.subscriptions[pair[0]].dlq_replay_subscription}|${pair[1]}" => { subscription = pair[0], email = pair[1] }
  }

  project      = var.project_id
  subscription = google_pubsub_subscription.dlq_replay[each.value.subscription].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${each.value.email}"
}
