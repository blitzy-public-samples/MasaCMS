# Queue with its retry policy.
resource "google_cloud_tasks_queue" "this" {
  project  = var.project_id
  name     = var.name
  location = var.region

  retry_config {
    max_attempts       = var.retry.max_attempts
    min_backoff        = var.retry.min_backoff
    max_backoff        = var.retry.max_backoff
    max_doublings      = var.retry.max_doublings
    max_retry_duration = var.retry.max_retry_duration
  }
}

locals {
  # Roles covering every platform Cloud Tasks adapter call: create, list and delete tasks; get, pause and resume the queue.
  creator_roles = [
    "roles/cloudtasks.enqueuer",
    "roles/cloudtasks.queueAdmin",
    "roles/cloudtasks.viewer",
    "roles/cloudtasks.taskDeleter",
  ]

  grants = {
    for p in setproduct(local.creator_roles, var.creator_emails) :
    "${p[0]}|serviceAccount:${p[1]}" => { role = p[0], member = "serviceAccount:${p[1]}" }
  }
}

# Task and queue-control rights for each creator.
resource "google_cloud_tasks_queue_iam_member" "creator" {
  for_each = local.grants

  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.this.name
  role     = each.value.role
  member   = each.value.member
}
