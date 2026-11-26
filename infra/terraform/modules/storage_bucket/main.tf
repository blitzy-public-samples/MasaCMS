# One Cloud Storage bucket and its object-admin bindings.

resource "google_storage_bucket" "this" {
  project                     = var.project_id
  name                        = var.name
  location                    = var.region
  uniform_bucket_level_access = true

  versioning {
    enabled = false
  }
}

resource "google_storage_bucket_iam_member" "object_admin" {
  for_each = toset(var.object_admin_emails)

  bucket = google_storage_bucket.this.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${each.value}"
}
