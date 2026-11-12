# Placeholder token: plan only, no credentials.
provider "google" {
  project      = var.project_id
  region       = var.region
  access_token = var.plan_access_token
}
