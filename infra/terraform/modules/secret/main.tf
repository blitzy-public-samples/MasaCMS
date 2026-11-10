# Secret Manager container, optional single version, accessor bindings.
resource "google_secret_manager_secret" "this" {
  project   = var.project_id
  secret_id = var.secret_id

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "this" {
  count = var.data == null ? 0 : 1

  secret      = google_secret_manager_secret.this.id
  secret_data = var.data
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = toset(var.accessor_members)

  project   = var.project_id
  secret_id = google_secret_manager_secret.this.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = each.value
}
