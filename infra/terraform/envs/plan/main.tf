# Plan-only composition of the OPT-2 Google Cloud estate; every name, URL and IAM member is a plan-time string.

locals {
  runtime_services = [
    "gateway",
    "web",
    "identity",
    "people",
    "programs-sites",
    "strategies-content",
    "migration",
  ]
  domain_services = [for n in local.runtime_services : n if !contains(["gateway", "web", "migration"], n)]
  accounts        = concat(local.runtime_services, ["db-bootstrap", "pubsub-invoker", "tasks-invoker"])

  emails  = { for n in local.accounts : n => "opt2-${n}@${var.project_id}.iam.gserviceaccount.com" }
  members = { for n, e in local.emails : n => "serviceAccount:${e}" }

  # Cloud Run's deterministic service URLs, so callers, push endpoints and audiences never read a computed attribute.
  urls         = { for n in local.runtime_services : n => "https://${n}-${var.project_number}.${var.region}.run.app" }
  service_urls = local.urls
  images       = { for n in local.runtime_services : n => "${var.image_repository}/${n}:${var.image_tag}" }

  db_users      = concat([for n in local.runtime_services : n if n != "web"], ["db-bootstrap"])
  db_user_names = { for n in local.db_users : n => trimsuffix(local.emails[n], ".gserviceaccount.com") }

  sql_instance_name  = "opt2-postgres"
  cloud_sql_instance = "${var.project_id}:${var.region}:${local.sql_instance_name}"

  min_instance_counts = { for n in local.runtime_services : n => n == "migration" ? 1 : 0 }

  # Bucket to the one service that writes it.
  buckets = {
    "content-files" = "strategies-content"
  }
}

# Service accounts and their grants.
locals {
  pubsub_service_agent = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
  # Accounts that sign storage URLs or custom tokens through IAM rather than a key.
  self_signers  = ["identity", "strategies-content"]
  task_creators = sort(distinct(flatten([for q in var.queues : q.creators])))

  project_roles = { for n in local.accounts : n => concat(
    contains(local.runtime_services, n) ? ["roles/logging.logWriter", "roles/telemetry.tracesWriter"] : [],
    contains(local.db_users, n) ? ["roles/cloudsql.client", "roles/cloudsql.instanceUser"] : [],
    n == "identity" ? ["roles/firebaseauth.admin"] : [],
    # The transition drain lists subscriptions and reads their metadata.
    n == "migration" ? ["roles/pubsub.viewer"] : [],
  ) }

  account_iam = { for n in local.accounts : n => concat(
    contains(local.self_signers, n) ? [{ role = "roles/iam.serviceAccountTokenCreator", member = local.members[n] }] : [],
    n == "pubsub-invoker" ? [{ role = "roles/iam.serviceAccountTokenCreator", member = local.pubsub_service_agent }] : [],
    n == "tasks-invoker" ? [for c in local.task_creators : { role = "roles/iam.serviceAccountUser", member = local.members[c] }] : [],
  ) }
}

module "service_accounts" {
  source   = "../../modules/service_account"
  for_each = toset(local.accounts)

  project_id    = var.project_id
  name          = each.key
  display_name  = "OPT-2 ${each.key}"
  project_roles = local.project_roles[each.key]
  account_iam   = local.account_iam[each.key]
  secret_access = sort(distinct(values(try(local.operator_secret_env[each.key], {}))))
}

module "network" {
  source = "../../modules/network"

  project_id  = var.project_id
  region      = var.region
  name        = "opt2"
  subnet_cidr = var.subnet_cidr
}

module "cloud_sql" {
  source = "../../modules/cloud_sql_postgres"

  project_id                 = var.project_id
  region                     = var.region
  instance_name              = local.sql_instance_name
  database_name              = var.database_name
  private_network            = module.network.private_network
  iam_service_account_emails = [for n in local.db_users : local.emails[n]]

  depends_on = [module.service_accounts]
}

locals {
  secrets = {
    "legacy-bridge-hmac"      = { data = null, accessors = ["gateway", "migration"] }
    "cloudsql-admin-password" = { data = null, accessors = ["db-bootstrap"] }
    "otel-collector-config" = {
      data      = file("${path.module}/../../modules/cloud_run_service/otel-collector.yaml")
      accessors = local.runtime_services
    }
  }
}

module "secrets" {
  source   = "../../modules/secret"
  for_each = local.secrets

  project_id       = var.project_id
  secret_id        = each.key
  data             = each.value.data
  accessor_members = [for a in each.value.accessors : local.members[a]]

  depends_on = [module.service_accounts]
}

# Runtime environment of each Cloud Run service; PORT is injected by Cloud Run.
locals {
  common_env = { for n in local.runtime_services : n => {
    OPT2_ENV                    = "cloud"
    OPT2_SERVICE_NAME           = n
    GOOGLE_CLOUD_PROJECT        = var.project_id
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
    OPT2_TOKEN_ISSUER           = "https://securetoken.google.com/${var.project_id}"
    OPT2_TOKEN_AUDIENCE         = var.project_id
    OPT2_JWKS_URL               = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
    OPT2_GATEWAY_URL            = local.urls["gateway"]
    OPT2_MIGRATION_URL          = local.urls["migration"]
    OPT2_SERVICE_URLS           = jsonencode(local.service_urls)
    OPT2_TASKS_ADAPTER          = "cloud"
    OPT2_STORAGE_ADAPTER        = "cloud"
    TZ                          = var.time_zone
  } }

  db_env = { for n in local.db_users : n => {
    OPT2_DB_AUTH       = "iam"
    CLOUD_SQL_INSTANCE = local.cloud_sql_instance
    PG_DATABASE        = var.database_name
    PG_USER            = local.db_user_names[n]
  } }

  connection_env = {
    gateway = { LEGACY_ORIGIN = var.legacy_origin }
    migration = {
      LEGACY_ORIGIN   = var.legacy_origin
      MURA_DBTYPE     = "mssql"
      MURA_DBHOST     = var.legacy_db_host
      MURA_DBPORT     = tostring(var.legacy_db_port)
      MURA_DATABASE   = var.legacy_db_name
      MURA_DBUSERNAME = var.legacy_db_username
    }
    # The database name alone, which the SQL Server messages of its legacy error pages qualify a table with.
    "strategies-content" = { MURA_DATABASE = var.legacy_db_name }
    identity             = { MURA_DATABASE = var.legacy_db_name }
    people               = { MURA_DATABASE = var.legacy_db_name }
  }

  # Non-secret Masa MURA_<KEY> settings each service reads; unset keys keep Masa's settings-template default.
  legacy_setting_readers = {
    gateway              = ["MURA_COOKIEDOMAIN", "MURA_REQUESTTIMEOUT", "MURA_SECURECOOKIES", "MURA_SESSIONTIMEOUT"]
    identity             = ["MURA_ADMINDOMAIN", "MURA_ADMINSSL", "MURA_CONTEXT", "MURA_DATASOURCE", "MURA_HASHURLS", "MURA_INDEXFILEINURLS", "MURA_PORT", "MURA_SESSIONBASEDLOCKDOWN", "MURA_SESSIONTIMEOUT", "MURA_SITEIDINURLS", "MURA_STRICTHTML"]
    people               = ["MURA_ADMINDOMAIN", "MURA_ADMINSSL", "MURA_CONTEXT", "MURA_DATASOURCE", "MURA_EXPIREPASSWORDS", "MURA_PORT"]
    "programs-sites"     = ["MURA_ADMINDOMAIN", "MURA_ADMINSSL", "MURA_CONTEXT", "MURA_LOCALE", "MURA_PORT"]
    "strategies-content" = ["MURA_ADMINDOMAIN", "MURA_ADMINSSL", "MURA_CONTEXT", "MURA_DEBUGGINGENABLED", "MURA_HASHURLS", "MURA_INDEXFILEINURLS", "MURA_LEGACYINDEXFILELOCATION", "MURA_PORT", "MURA_SITEDIR", "MURA_SITEIDINURLS", "MURA_SORTPERMISSION", "MURA_SUPPRESSAPIPARAMS", "MURA_USEDATANAMESPACEFORAPI", "MURA_VARIATIONS"]
    web                  = ["MURA_ADMINDIR", "MURA_ADMINDOMAIN", "MURA_ADMINEMAIL", "MURA_ADMINSSL", "MURA_ALLOWAUTOUPDATES", "MURA_ASSETPATH", "MURA_CONTEXT", "MURA_COOKIEDOMAIN", "MURA_COREPATH", "MURA_DBTYPE", "MURA_DEBUGGINGENABLED", "MURA_EXPIREPASSWORDS", "MURA_FILEASSETPATH", "MURA_FILEDELIM", "MURA_FILEDIR", "MURA_FILEMANAGERENABLED", "MURA_FMSHOWAPPLICATIONROOT", "MURA_FMSHOWSITEFILES", "MURA_FORMPOLLS", "MURA_HASHURLS", "MURA_HTMLEDITORTYPE", "MURA_INDEXFILEINAPI", "MURA_INDEXFILEINURLS", "MURA_JAVAENABLED", "MURA_KEEPMETAKEYWORDS", "MURA_LEGACYINDEXFILELOCATION", "MURA_LOCALE", "MURA_MODE", "MURA_PLUGINSPATH", "MURA_PORT", "MURA_PROXYSERVER", "MURA_PROXYUSER", "MURA_RENDERMURAALERTS", "MURA_S3ASSETS", "MURA_SECURECOOKIES", "MURA_SESSIONHISTORY", "MURA_SESSIONTIMEOUT", "MURA_SHOWUSAGETABS", "MURA_SITEDIR", "MURA_SITEIDINURLS", "MURA_STRONGPASSWORDS", "MURA_TITLE", "MURA_WEBROOT", "MURA_WINDOWDOCUMENTDOMAIN"]
  }
  legacy_setting_keys  = sort(distinct(flatten(values(local.legacy_setting_readers))))
  legacy_setting_flags = ["MURA_ADMINSSL", "MURA_ALLOWAUTOUPDATES", "MURA_FILEMANAGERENABLED", "MURA_FMSHOWAPPLICATIONROOT", "MURA_FMSHOWSITEFILES", "MURA_FORMPOLLS", "MURA_HASHURLS", "MURA_INDEXFILEINAPI", "MURA_INDEXFILEINURLS", "MURA_JAVAENABLED", "MURA_KEEPMETAKEYWORDS", "MURA_LEGACYINDEXFILELOCATION", "MURA_RENDERMURAALERTS", "MURA_SECURECOOKIES", "MURA_SESSIONBASEDLOCKDOWN", "MURA_SHOWUSAGETABS", "MURA_SITEIDINURLS", "MURA_STRICTHTML", "MURA_STRONGPASSWORDS", "MURA_SUPPRESSAPIPARAMS", "MURA_USEDATANAMESPACEFORAPI", "MURA_VARIATIONS"]
  # Services that read Masa's MURA_APPRELOADKEY.
  legacy_reload_key_readers = ["gateway", "web", "identity", "people", "programs-sites", "strategies-content", "migration"]

  service_env = { for n in local.runtime_services : n => merge(
    try(local.connection_env[n], {}),
    { for k in try(local.legacy_setting_readers[n], []) : k => var.legacy_settings[k] if contains(keys(var.legacy_settings), k) },
  ) }

  env = { for n in local.runtime_services : n => merge(
    local.common_env[n],
    try(local.db_env[n], {}),
    try(local.service_env[n], {}),
  ) }

  secret_env_by_service = {
    gateway   = { OPT2_BRIDGE_HMAC_KEY = module.secrets["legacy-bridge-hmac"].secret_id }
    migration = { OPT2_BRIDGE_HMAC_KEY = module.secrets["legacy-bridge-hmac"].secret_id }
  }

  # Env name to existing operator secret id, per reader; null ids are left out.
  operator_secret_env = { for n in local.runtime_services : n => { for name, id in {
    MURA_DBPASSWORD                = n == "migration" ? var.operator_secret_ids.legacy_db_password : null
    OPT2_IDENTITY_PLATFORM_API_KEY = n == "identity" ? var.operator_secret_ids.identity_platform_api_key : null
    MURA_APPRELOADKEY              = contains(local.legacy_reload_key_readers, n) ? var.operator_secret_ids.legacy_reload_key : null
  } : name => id if id != null } }

  secret_env = { for n in local.runtime_services : n => merge(
    try(local.secret_env_by_service[n], {}),
    local.operator_secret_env[n],
  ) }
}

# roles/run.invoker per callee: generated service calls, push delivery and task delivery on top of each fixed base.
locals {
  callers = { for callee in local.runtime_services : callee => [
    for caller, callees in var.service_calls : caller if contains(callees, callee) && contains(local.runtime_services, caller)
  ] }
  push_consumers = distinct([for s in var.subscriptions : s.consumer])
  task_targets   = distinct([for q in var.queues : q.target_service])

  invokers = merge(
    { for n in concat(local.domain_services, ["migration"]) : n => sort(distinct([for a in concat(
      n == "migration" ? ["gateway", "programs-sites"] : ["gateway", "migration"],
      local.callers[n],
      contains(local.push_consumers, n) ? ["pubsub-invoker"] : [],
      contains(local.task_targets, n) ? ["tasks-invoker"] : [],
    ) : local.members[a]])) },
    {
      gateway = ["allUsers"]
      web     = [local.members["gateway"]]
    },
  )
}

check "topology" {
  assert {
    condition     = toset(var.cloud_run_services) == toset(local.runtime_services)
    error_message = "cloud_run_services must list exactly the 7 runtime services."
  }

  assert {
    condition = alltrue(concat(
      [for s in var.subscriptions : contains(local.domain_services, s.consumer)],
      [for q in var.queues : contains(local.domain_services, q.target_service)],
    ))
    error_message = "Every push consumer and task target must be one of the four domain services."
  }

  assert {
    condition     = alltrue([for q in var.queues : !strcontains(q.target_path, "{")])
    error_message = "Queue target paths must be fixed: Cloud Run admits only exact audiences."
  }
}

# Exact OIDC audiences per service: its push endpoints and its queues' fixed target URLs.
locals {
  custom_audiences = { for n in local.runtime_services : n => sort(distinct(concat(
    [for s in var.subscriptions : "${local.urls[n]}${s.push_path}" if s.consumer == n],
    [for q in var.queues : "${local.urls[n]}${q.target_path}" if q.target_service == n],
  ))) }
}

# One Cloud Run service per runtime service; only migration keeps a warm instance and CPU outside requests.
module "cloud_run" {
  source   = "../../modules/cloud_run_service"
  for_each = toset(var.cloud_run_services)

  project_id            = var.project_id
  region                = var.region
  name                  = each.key
  image                 = local.images[each.key]
  service_account_email = module.service_accounts[each.key].email
  network               = module.network.network_id
  subnetwork            = module.network.subnetwork_id
  otel_config_secret_id = module.secrets["otel-collector-config"].secret_id
  ingress               = each.key == "gateway" ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"
  min_instance_count    = local.min_instance_counts[each.key]
  cpu_idle              = each.key != "migration"
  env                   = local.env[each.key]
  secret_env            = local.secret_env[each.key]
  invoker_members       = local.invokers[each.key]
  custom_audiences      = local.custom_audiences[each.key]

  depends_on = [module.secrets, module.service_accounts]
}

# Declared only: the job carries no trigger or execution.
module "db_bootstrap" {
  source = "../../modules/cloud_run_job"

  project_id            = var.project_id
  region                = var.region
  name                  = "db-bootstrap"
  image                 = local.images["migration"]
  service_account_email = module.service_accounts["db-bootstrap"].email
  network               = module.network.network_id
  subnetwork            = module.network.subnetwork_id
  command               = ["node"]
  args                  = ["dist/db-bootstrap/cli.js", "bootstrap", "--target", "cloud"]
  max_retries           = 0
  env = {
    OPT2_ENV             = "cloud"
    GOOGLE_CLOUD_PROJECT = var.project_id
    CLOUD_SQL_INSTANCE   = local.cloud_sql_instance
    PG_DATABASE          = var.database_name
    OPT2_DB_AUTH         = "iam"
    PG_USER              = local.db_user_names["db-bootstrap"]
  }
  secret_env = { OPT2_CLOUDSQL_ADMIN_PASSWORD = module.secrets["cloudsql-admin-password"].secret_id }

  depends_on = [module.secrets, module.service_accounts]
}

module "pubsub" {
  source   = "../../modules/pubsub_topic"
  for_each = var.topics

  project_id           = var.project_id
  project_number       = var.project_number
  topic_name           = each.key
  producer_email       = local.emails[each.value.producer]
  pubsub_invoker_email = local.emails["pubsub-invoker"]
  subscriptions = {
    for s, v in var.subscriptions : s => {
      push_endpoint           = "${local.urls[v.consumer]}${v.push_path}"
      consumer_email          = local.emails[v.consumer]
      dlq_topic               = v.dead_letter_topic
      dlq_replay_subscription = v.dlq_replay_subscription
      max_delivery_attempts   = v.max_delivery_attempts
    } if v.topic == each.key
  }
  replay_subscriber_emails = [local.emails["migration"]]

  depends_on = [module.service_accounts]
}

module "queues" {
  source   = "../../modules/cloud_tasks_queue"
  for_each = var.queues

  project_id = var.project_id
  region     = var.region
  name       = each.key
  retry = {
    max_attempts  = each.value.retry.max_attempts
    min_backoff   = "${each.value.retry.min_backoff_s}s"
    max_backoff   = "${each.value.retry.max_backoff_s}s"
    max_doublings = each.value.retry.max_doublings
  }
  creator_emails = sort(distinct([for c in each.value.creators : local.emails[c]]))

  depends_on = [module.service_accounts]
}

module "buckets" {
  source   = "../../modules/storage_bucket"
  for_each = local.buckets

  project_id          = var.project_id
  region              = var.region
  name                = each.key
  object_admin_emails = [local.emails[each.value]]

  depends_on = [module.service_accounts]
}

module "identity_platform" {
  source = "../../modules/identity_platform"

  project_id           = var.project_id
  tenant_display_names = ["default", "umbrella", "tenant-a", "tenant-b"]
}
