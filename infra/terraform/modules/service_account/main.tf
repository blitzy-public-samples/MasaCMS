resource "google_service_account" "this" {
  project      = var.project_id
  account_id   = "opt2-${var.name}"
  display_name = var.display_name
}

resource "google_project_iam_member" "project" {
  for_each = toset(var.project_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.this.email}"
}

# Keyed by role and member so bindings stay stable when the list is reordered.
resource "google_service_account_iam_member" "account" {
  for_each = { for b in var.account_iam : "${b.role}|${b.member}" => b }

  service_account_id = google_service_account.this.name
  role               = each.value.role
  member             = each.value.member
}
