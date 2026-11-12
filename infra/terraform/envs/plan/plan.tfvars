# Placeholder inputs for the plan-only run; every value points at nothing real.
project_id         = "opt2-plan-only"
project_number     = "000000000000"
region             = "us-central1"
image_repository   = "us-central1-docker.pkg.dev/opt2-plan-only/opt2"
image_tag          = "plan-only"
legacy_origin      = "https://legacy.invalid"
legacy_db_host     = "legacy-db.invalid"
legacy_db_port     = 1433
legacy_db_name     = "masa"
legacy_db_username = "opt2-migration"
smtp_host          = "smtp.invalid"
smtp_port          = 587
mailpit_api_url    = "https://mailpit.invalid"
time_zone          = "UTC"
database_name      = "opt2"
subnet_cidr        = "10.10.0.0/24"
cloud_run_services = [
  "gateway",
  "web",
  "identity",
  "people",
  "programs-sites",
  "strategies-content",
  "communications",
  "reporting",
  "surveys",
  "timesheets",
  "finance",
  "e-signature",
  "migration",
]
