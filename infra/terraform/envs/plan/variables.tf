# Inputs of the plan-only root module: plan.tfvars and the generated topology.auto.tfvars.json.

variable "project_id" {
  description = "Google Cloud project id."
  type        = string
}

variable "project_number" {
  description = "Google Cloud project number; builds Cloud Run URLs and the Pub/Sub service agent."
  type        = string
}

variable "region" {
  description = "Region of every regional resource."
  type        = string
}

variable "plan_access_token" {
  description = "Placeholder provider access token; planning uses no credentials."
  type        = string
  default     = "plan-only"
  sensitive   = true
}

variable "image_repository" {
  description = "Artifact Registry path prefix of the service images."
  type        = string
}

variable "image_tag" {
  description = "Tag of every service image."
  type        = string
}

variable "cloud_run_services" {
  description = "Names of the deployed Cloud Run services; the topology generator reads this list."
  type        = list(string)

  validation {
    condition     = contains(var.cloud_run_services, "gateway") && contains(var.cloud_run_services, "migration")
    error_message = "cloud_run_services must include gateway and migration."
  }
}

variable "legacy_origin" {
  description = "Legacy Masa origin (LEGACY_ORIGIN) of the gateway and migration."
  type        = string
}

variable "legacy_db_host" {
  description = "Legacy SQL Server host (MURA_DBHOST) of migration."
  type        = string
}

variable "legacy_db_port" {
  description = "Legacy SQL Server port (MURA_DBPORT) of migration."
  type        = number
  default     = 1433
}

variable "legacy_db_name" {
  description = "Legacy database name (MURA_DATABASE) of migration."
  type        = string
}

variable "legacy_db_username" {
  description = "Legacy database user (MURA_DBUSERNAME) of migration."
  type        = string
}

variable "operator_secret_ids" {
  description = "Ids of existing Secret Manager secrets the operator provides and Terraform only references: MURA_DBPASSWORD of migration; MURA_APPRELOADKEY of the legacy origin, null when legacy keeps Masa's default appreload; OPT2_IDENTITY_PLATFORM_API_KEY of identity, the project Web API key accounts:signInWithCustomToken takes."
  type = object({
    legacy_db_password        = string
    legacy_reload_key         = optional(string)
    identity_platform_api_key = string
  })
  nullable = false

  validation {
    condition = alltrue([
      can(regex("^[A-Za-z0-9_-]{1,255}$", var.operator_secret_ids.legacy_db_password)),
      can(regex("^[A-Za-z0-9_-]{1,255}$", var.operator_secret_ids.identity_platform_api_key)),
      var.operator_secret_ids.legacy_reload_key == null || can(regex("^[A-Za-z0-9_-]{1,255}$", var.operator_secret_ids.legacy_reload_key)),
    ])
    error_message = "operator_secret_ids entries must be Secret Manager secret ids of 1 to 255 letters, digits, '_' or '-'; only legacy_reload_key may be null."
  }

  validation {
    condition = length(setintersection(
      [for id in values(var.operator_secret_ids) : id if id != null],
      keys(local.secrets),
    )) == 0
    error_message = "operator_secret_ids must name secrets the operator provides, never one this configuration creates (${join(", ", sort(keys(local.secrets)))})."
  }
}

variable "legacy_settings" {
  description = "Non-secret Masa MURA_<KEY> settings of the legacy origin that the targets reproduce; each service gets the keys it reads."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition     = alltrue([for v in values(var.legacy_settings) : v != null])
    error_message = "legacy_settings values must be strings, never null."
  }

  validation {
    condition     = alltrue([for k in keys(var.legacy_settings) : contains(local.legacy_setting_keys, k) || !can(regex("(?i)(PASSWORD|SECRET|TOKEN|KEY$)", k))])
    error_message = "legacy_settings must not carry secrets such as MURA_APPRELOADKEY or MURA_DBPASSWORD: put the id of an existing Secret Manager secret in operator_secret_ids instead."
  }

  validation {
    condition     = alltrue([for k in keys(var.legacy_settings) : contains(local.legacy_setting_keys, k) || can(regex("(?i)(PASSWORD|SECRET|TOKEN|KEY$)", k))])
    error_message = "legacy_settings keys must be among ${join(", ", local.legacy_setting_keys)}."
  }

  validation {
    condition     = alltrue([for k, v in var.legacy_settings : can(regex("(?i)^(true|false|yes|no|1|0)$", v)) if contains(local.legacy_setting_flags, k)])
    error_message = "legacy_settings flags ${join(", ", local.legacy_setting_flags)} must be CFML booleans: true, false, yes, no, 1 or 0, in any case."
  }

  validation {
    condition     = alltrue([for k, v in var.legacy_settings : v == "" || try(can(regex("^[0-9]+$", v)) && tonumber(v) >= 1 && tonumber(v) <= 65535, false) if k == "MURA_PORT"])
    error_message = "legacy_settings MURA_PORT must be blank or a TCP port from 1 to 65535."
  }

  validation {
    condition     = alltrue([for k, v in var.legacy_settings : can(regex("^[0-9]+$", v)) if k == "MURA_EXPIREPASSWORDS"])
    error_message = "legacy_settings MURA_EXPIREPASSWORDS must be a whole number of days."
  }

  validation {
    condition     = alltrue([for k, v in var.legacy_settings : try(can(regex("^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$", v)) && abs(tonumber(v)) <= 1.7976931348623157e308, false) if contains(["MURA_SESSIONHISTORY", "MURA_SESSIONTIMEOUT"], k)])
    error_message = "legacy_settings MURA_SESSIONHISTORY (days) and MURA_SESSIONTIMEOUT (minutes) must be CFML numbers: decimal text such as 180, 1.5 or 2e2, with no whitespace."
  }

  validation {
    condition     = alltrue([for k, v in var.legacy_settings : can(regex("^(/[^\\s?#]*)?$", v)) if k == "MURA_CONTEXT"])
    error_message = "legacy_settings MURA_CONTEXT must be blank or a path that starts with / and holds no whitespace, ? or #."
  }

  validation {
    condition     = alltrue([for k, v in var.legacy_settings : can(regex("^[^\\s:/\\\\?#@]*$", v)) if k == "MURA_ADMINDOMAIN"])
    error_message = "legacy_settings MURA_ADMINDOMAIN must be blank or a comma list of host names with no whitespace, port, path or @."
  }

  validation {
    condition     = alltrue([for k, v in var.legacy_settings : !can(regex("(?i)[a-z][a-z0-9+.-]*://[^/?#\\s]*@", v)) if contains(["MURA_ASSETPATH", "MURA_COREPATH", "MURA_FILEASSETPATH", "MURA_FILEDIR", "MURA_PLUGINSPATH", "MURA_PROXYSERVER", "MURA_S3ASSETS"], k)])
    error_message = "legacy_settings MURA_ASSETPATH, MURA_COREPATH, MURA_FILEASSETPATH, MURA_FILEDIR, MURA_PLUGINSPATH, MURA_PROXYSERVER and MURA_S3ASSETS must not embed URL credentials (scheme://user[:password]@host): legacy_settings values are plain env, and secrets reach the services only as existing Secret Manager ids in operator_secret_ids."
  }
}

variable "smtp_host" {
  description = "SMTP relay host (SMTP_HOST) of communications."
  type        = string
}

variable "smtp_port" {
  description = "SMTP relay port (SMTP_PORT) of communications."
  type        = number
}

variable "mailpit_api_url" {
  description = "Mail API URL (MAILPIT_API_URL) of communications."
  type        = string
}

variable "time_zone" {
  description = "TZ of every service: the legacy server time zone."
  type        = string
}

variable "database_name" {
  description = "Cloud SQL database name, also PG_DATABASE."
  type        = string
}

variable "subnet_cidr" {
  description = "CIDR of the Direct VPC egress subnet; /26 or larger."
  type        = string

  validation {
    condition     = can(cidrhost(var.subnet_cidr, 0)) && try(tonumber(split("/", var.subnet_cidr)[1]) <= 26, false)
    error_message = "subnet_cidr must be an IPv4 CIDR with a prefix of 26 or smaller."
  }
}

variable "topics" {
  description = "Topic name to producer and event kind; generated by harness/src/repro/pubsub-topology.ts --target cloud."
  type = map(object({
    producer = string
    kind     = string
  }))
}

variable "subscriptions" {
  description = "Push subscription <consumer>.<topic> to its delivery settings; generated by harness/src/repro/pubsub-topology.ts --target cloud."
  type = map(object({
    topic                   = string
    consumer                = string
    push_path               = string
    ordering                = bool
    dead_letter_topic       = string
    max_delivery_attempts   = number
    dlq_replay_subscription = string
  }))
}

variable "queues" {
  description = "Task queue name to target, creators, cadence and retry policy in seconds; generated by harness/src/repro/pubsub-topology.ts --target cloud."
  type = map(object({
    creators             = list(string)
    target_service       = string
    target_path          = string
    recurring_interval_s = optional(number)
    deadline_s           = number
    retry = object({
      max_attempts  = number
      min_backoff_s = number
      max_backoff_s = number
      max_doublings = number
    })
  }))
}

variable "service_calls" {
  description = "Caller service to the services it invokes; generated by harness/src/repro/pubsub-topology.ts --target cloud."
  type        = map(list(string))
}
