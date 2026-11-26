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
  "migration",
]
operator_secret_ids = {
  legacy_db_password        = "opt2-legacy-db-password"
  legacy_reload_key         = "opt2-legacy-reload-key"
  identity_platform_api_key = "opt2-identity-platform-api-key"
}
legacy_settings = {
  MURA_DATASOURCE      = "masa"
  MURA_DBTYPE          = "mssql"
  MURA_INDEXFILEINURLS = "false"
  MURA_SITEIDINURLS    = "false"
}
