# OPT-2 Terraform (plan-only)

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

This tree declares the Google Cloud target of OPT-2: the Cloud Run services, Cloud SQL, Pub/Sub, Cloud Tasks, Cloud Storage and Identity Platform resources the services run on, and the identities and grants that wire them together. It is proven with `fmt`, `validate` and a `plan` that needs no credentials. It is **never applied**: it holds no credentials and no state backend, and no script or workflow in this repository creates cloud resources from it.

## Layout

| Path | Role |
|---|---|
| `plan.sh` | The one entry point: init, fmt, validate, plan and show; writes the plan report |
| `.gitignore` | Ignores `.terraform/`, `*.tfstate`, `*.tfstate.*` and `tfplan`; the lock file stays tracked |
| `modules/network` | VPC, subnet with Private Google Access, private services access range and peering for Cloud SQL, Cloud Router and Cloud NAT |
| `modules/cloud_run_service` | Cloud Run v2 service with Direct VPC egress, the collector sidecar and its `roles/run.invoker` bindings; `otel-collector.yaml` is the sidecar configuration |
| `modules/cloud_run_job` | Cloud Run v2 job with Direct VPC egress |
| `modules/cloud_sql_postgres` | PostgreSQL 16 instance, database and IAM database users |
| `modules/pubsub_topic` | One topic, its producer binding, ordered OIDC push subscriptions, their dead-letter topics, replay subscriptions and their subscriber bindings |
| `modules/cloud_tasks_queue` | One queue, its retry policy and its creators' bindings |
| `modules/storage_bucket` | One bucket and its object-admin bindings |
| `modules/identity_platform` | Multi-tenant Identity Platform config and its tenants |
| `modules/service_account` | One service account, its project roles and the bindings on the account |
| `modules/secret` | One Secret Manager secret, an optional single version and its accessor bindings |
| `envs/plan/versions.tf` | Version pins of the root module |
| `envs/plan/providers.tf` | Google provider with the placeholder token |
| `envs/plan/variables.tf` | Inputs (see [Variables and placeholders](#variables-and-placeholders)) |
| `envs/plan/main.tf` | The composition |
| `envs/plan/outputs.tf` | `service_urls`, `service_account_emails`, `sql_connection_name`, `queue_names`, `bucket_names`, `identity_platform_tenants`, `min_instance_counts` |
| `envs/plan/plan.tfvars` | Placeholder inputs |
| `envs/plan/topology.auto.tfvars.json` | Generated Pub/Sub, queue and service-call topology (see [Generated topology](#generated-topology)) |
| `envs/plan/.terraform.lock.hcl` | Provider hashes |

Pins: the root module and every module's `versions.tf` set `required_version = "= 1.17.1"` and `hashicorp/google` `version = "= 8.9.0"`. The lock file holds the 8.9.0 hashes for linux and darwin on amd64 and arm64.

## What is declared

| Resource | Count | Detail |
|---|---|---|
| Cloud Run services | 13 | `gateway`, `web`, `identity`, `people`, `programs-sites`, `strategies-content`, `communications`, `reporting`, `surveys`, `timesheets`, `finance`, `e-signature`, `migration`. The stub service is not deployed. `min_instance_count` is 0 everywhere except `migration` (1), whose reverse projector and write windows must keep running |
| Cloud Run job | 1 | `db-bootstrap`: the migration image running `node dist/db-bootstrap/cli.js bootstrap --target cloud`, `max_retries = 0`. Declared only, with no trigger or execution |
| Network | 1 | VPC and subnet `opt2` (Private Google Access), private services range `opt2-psa` peered through `servicenetworking.googleapis.com`, router `opt2-router` with NAT `opt2-nat` |
| Cloud SQL | 1 instance, 1 database, 13 IAM users | Instance `opt2-postgres`: `POSTGRES_16`, `ENTERPRISE` edition, tier `db-custom-1-3840`, private IP only, flag `cloudsql.iam_authentication = on`, daily backups with point-in-time recovery. Database `database_name`. One `CLOUD_IAM_SERVICE_ACCOUNT` user per database account: the 12 runtime services other than `web`, plus `db-bootstrap` |
| Pub/Sub | from the topology | Per topic: the topic. Per subscription: a push subscription, its dead-letter topic and a pull subscription on that topic for replay |
| Cloud Tasks | 11 queues | See [Generated topology](#generated-topology) |
| Cloud Storage | 4 buckets | `content-files`, `reporting-exports`, `finance-attachments`, `esignature-documents`; uniform bucket-level access, versioning off |
| Identity Platform | config + 4 tenants | Multi-tenant config; tenants `default`, `umbrella`, `tenant-a`, `tenant-b`, one per user-pool site of the seed |
| Service accounts | 16 | `opt2-<name>` for the 13 runtime services, `opt2-db-bootstrap`, `opt2-pubsub-invoker` and `opt2-tasks-invoker` |
| Secret Manager | 4 secrets | See [Secrets](#secrets) |

Guards in the code: a `check "topology"` block requires `cloud_run_services` to list exactly the 13 runtime services, every push consumer and task target to be a domain service, and every queue target path to be fixed. Module validations require `INGRESS_TRAFFIC_ALL` on the gateway and `INGRESS_TRAFFIC_INTERNAL_ONLY` elsewhere, `allUsers` as invoker on the gateway only and `allAuthenticatedUsers` nowhere, `min_instance_count` 1 for `migration` and 0 elsewhere, `cpu_idle` false for `migration` and true elsewhere, the pinned collector image, and no `PORT` in a service's app environment (Cloud Run injects it).

## Running the plan

Requires Terraform 1.17.1 exactly and Node 22 on `PATH`. The script takes no arguments; `--help` prints its usage and variables.

```sh
infra/terraform/plan.sh
```

| Variable | Default | Holds |
|---|---|---|
| `OPT2_STATE_DIR` | `$HOME/.opt2/state` | `tfplan`, the binary plan |
| `OPT2_REPORTS_DIR` | `opt2/reports` | `terraform-plan.json`; a relative path is taken from the repository root |

Steps, run from `infra/terraform/` with `TF_IN_AUTOMATION=1`; any failure stops the script:

| Step | Command |
|---|---|
| init | `terraform -chdir=envs/plan init -backend=false -input=false` |
| fmt | `terraform fmt -check -recursive` |
| validate | `terraform -chdir=envs/plan validate` |
| plan | `terraform -chdir=envs/plan plan -input=false -refresh=false -lock=false -var-file=plan.tfvars -out=<state-dir>/tfplan` |
| show | `terraform -chdir=envs/plan show -json <state-dir>/tfplan` |

The report `opt2/reports/terraform-plan.json` wraps the `show` output. A run writes `status: generated`; the placeholder committed before any run carries `status: pending-run`.

| Field | Content |
|---|---|
| `sourceSha` | Read from `opt2/source-pin.json` |
| `generatedBy` | `infra/terraform/plan.sh` |
| `generatedAt` | ISO-8601 time of the run |
| `status` | `generated` |
| `terraformVersion`, `providerVersion` | `1.17.1`, `hashicorp/google 8.9.0` |
| `commands` | The five commands above, with `<state-dir>` unexpanded |
| `applied` | Always `false` |
| `expected` | The planning-time expectation: the 13 Cloud Run services, job `db-bootstrap`, minimum instances 0 by default and 1 for `migration` |
| `minInstanceCounts` | Planned `min_instance_count` per Cloud Run service, read from the plan; the performance report reads it |
| `plan` | The JSON plan |

Callers: `.github/workflows/terraform.yml` (job `plan`) and `harness/repro/test-all.sh` (stage 7, before the performance suite).

## No-credential planning

- `providers.tf` sets `access_token = var.plan_access_token`. The variable is `sensitive` with a placeholder default, so the provider never looks for real credentials.
- The configuration has no `data` blocks, so nothing reads a Google API.
- `init -backend=false` skips backend initialization, `plan -refresh=false` plans against the recorded state without reading remote objects, and `-lock=false` takes no state lock. No `backend` block is declared, so state is local and nothing remote is read or locked, but a `terraform.tfstate` in `envs/plan` would still be read and shape the plan; none is committed (`.gitignore` excludes `*.tfstate`) and `plan.sh` writes none: `tfplan` stays in `OPT2_STATE_DIR`.
- Project id, project number and region are variables. Every URL, email, IAM member and the Pub/Sub service agent `service-<project_number>@gcp-sa-pubsub.iam.gserviceaccount.com` is a string built from them at plan time. Only values Google assigns on creation, such as `sql_connection_name`, stay unknown in the plan.

## Variables and placeholders

Every value in `plan.tfvars` points at nothing real: hosts use the reserved `.invalid` domain, and the project is `opt2-plan-only`. No image is built or pushed by this tree; the image references are placeholders. `plan.tfvars` never sets `plan_access_token`.

| Variable | Use | `plan.tfvars` value |
|---|---|---|
| `project_id` | Project of every resource | `opt2-plan-only` |
| `project_number` | Cloud Run URLs and the Pub/Sub service agent | `000000000000` |
| `region` | Every regional resource | `us-central1` |
| `plan_access_token` | Provider token, sensitive | Not set; its placeholder default is used |
| `image_repository` | Image prefix; each service runs `<image_repository>/<name>:<image_tag>` | `us-central1-docker.pkg.dev/opt2-plan-only/opt2` |
| `image_tag` | Tag of every image | `plan-only` |
| `cloud_run_services` | Deployed services; the topology generator reads this list | The 13 runtime services |
| `legacy_origin` | `LEGACY_ORIGIN` of `gateway` and `migration` | `https://legacy.invalid` |
| `legacy_db_host` | `MURA_DBHOST` of `migration` | `legacy-db.invalid` |
| `legacy_db_port` | `MURA_DBPORT` of `migration` (default 1433) | `1433` |
| `legacy_db_name` | `MURA_DATABASE` of `migration` | `masa` |
| `legacy_db_username` | `MURA_DBUSERNAME` of `migration` | `opt2-migration` |
| `operator_secret_ids` | Ids of existing secrets the operator provides (see [Secrets](#secrets)): `legacy_db_password`, `legacy_reload_key` (optional; null keeps Masa's default `appreload`), `identity_platform_api_key`. Each must be a Secret Manager id (`^[A-Za-z0-9_-]{1,255}$`) and none of the four secrets this tree creates | `opt2-legacy-db-password`, `opt2-legacy-reload-key`, `opt2-identity-platform-api-key` (ids only, never values) |
| `legacy_settings` | Non-secret Masa `MURA_<KEY>` settings of the legacy origin (see [Legacy compatibility settings](#legacy-compatibility-settings)); default `{}` | `MURA_DBTYPE = "mssql"`, `MURA_INDEXFILEINURLS = "false"`, `MURA_SITEIDINURLS = "false"` |
| `smtp_host` | `SMTP_HOST` of `communications` | `smtp.invalid` |
| `smtp_port` | `SMTP_PORT` of `communications` | `587` |
| `mailpit_api_url` | `MAILPIT_API_URL` of `communications` | `https://mailpit.invalid` |
| `time_zone` | `TZ` of every service: the legacy server time zone | `UTC` |
| `database_name` | Cloud SQL database, also `PG_DATABASE` | `opt2` |
| `subnet_cidr` | Direct VPC egress subnet, `/26` or larger | `10.10.0.0/24` |
| `topics`, `subscriptions`, `queues`, `service_calls` | Generated topology | Set by `topology.auto.tfvars.json` |

### Legacy compatibility settings

Masa reads each configBean setting from its `MURA_<KEY>` variable over the settings file, and the targets do the same. `legacy_settings` carries the legacy origin's non-secret settings: each service's env gets only the keys it reads, and a key left out keeps Masa's settings-template default, as on legacy. `plan.tfvars` sets the three settings the supplied legacy setup changes: `MURA_DBTYPE`, `MURA_INDEXFILEINURLS` and `MURA_SITEIDINURLS`. Secret settings are never values here; `MURA_APPRELOADKEY` and `MURA_DBPASSWORD` come from `operator_secret_ids`.

| Key | Readers | Accepted values |
|---|---|---|
| `MURA_ADMINDOMAIN` | `identity`, `people`, `programs-sites`, `strategies-content`, `web` | Blank, or a comma list of host names without whitespace, `:`, `/`, `\`, `?`, `#` or `@` |
| `MURA_ADMINSSL` | `identity`, `people`, `programs-sites`, `strategies-content`, `web` | CFML boolean |
| `MURA_CONTEXT` | `identity`, `people`, `programs-sites`, `strategies-content`, `web` | Blank, or a path from `/` without whitespace, `?` or `#` |
| `MURA_EXPIREPASSWORDS` | `people`, `web` | Whole number of days |
| `MURA_HASHURLS` | `identity`, `strategies-content` | CFML boolean |
| `MURA_INDEXFILEINURLS` | `identity`, `strategies-content`, `web` | CFML boolean |
| `MURA_LEGACYINDEXFILELOCATION` | `strategies-content`, `web` | CFML boolean |
| `MURA_PORT` | `identity`, `people`, `programs-sites`, `strategies-content`, `web` | Blank, or a port from 1 to 65535 |
| `MURA_SESSIONBASEDLOCKDOWN` | `identity` | CFML boolean |
| `MURA_SITEDIR` | `strategies-content`, `web` | Any text |
| `MURA_SITEIDINURLS` | `identity`, `strategies-content`, `web` | CFML boolean |
| `MURA_STRICTHTML` | `identity` | CFML boolean |
| `MURA_STRONGPASSWORDS` | `web` | CFML boolean |
| `MURA_VARIATIONS` | `strategies-content` | CFML boolean |
| `MURA_ALLOWAUTOUPDATES`, `MURA_FILEMANAGERENABLED`, `MURA_FMSHOWAPPLICATIONROOT`, `MURA_FMSHOWSITEFILES`, `MURA_FORMPOLLS`, `MURA_INDEXFILEINAPI`, `MURA_JAVAENABLED`, `MURA_KEEPMETAKEYWORDS`, `MURA_RENDERMURAALERTS`, `MURA_SECURECOOKIES`, `MURA_SHOWUSAGETABS` | `web` | CFML boolean |
| `MURA_SESSIONHISTORY` (days), `MURA_SESSIONTIMEOUT` (minutes) | `web` | CFML number: decimal text such as `180`, `1.5` or `2e2`, without whitespace |
| `MURA_ASSETPATH`, `MURA_COREPATH`, `MURA_FILEASSETPATH`, `MURA_FILEDIR`, `MURA_PLUGINSPATH`, `MURA_PROXYSERVER`, `MURA_S3ASSETS` | `web` | Any text without URL credentials (`scheme://user[:password]@`) |
| `MURA_ADMINDIR`, `MURA_ADMINEMAIL`, `MURA_DBTYPE`, `MURA_FILEDELIM`, `MURA_HTMLEDITORTYPE`, `MURA_LOCALE`, `MURA_MODE`, `MURA_PROXYUSER`, `MURA_TITLE`, `MURA_WEBROOT`, `MURA_WINDOWDOCUMENTDOMAIN` | `web` | Any text |

A CFML boolean is `true`, `false`, `yes`, `no`, `1` or `0`, in any case. Plan-time validation rejects any other key, a secret-like key (one containing `PASSWORD`, `SECRET` or `TOKEN`, or ending in `KEY`), a null value and a value outside the accepted set; every accepted value parses in each reader at start-up. The table is every non-secret `MURA_<KEY>` a target reads: `web` reads the 41 it lists for it (`web/src/lib/env.ts`), and `gateway`, `migration` and the six synthetic services read none beyond `MURA_APPRELOADKEY` and `migration`'s connection settings, whose `MURA_DBTYPE` stays `mssql`. Every value lands as plain env, so the seven keys that may hold a URL refuse embedded credentials; a secret reaches a service only as an `operator_secret_ids` id.

## Deterministic URLs

Every callee URL is computed as `https://<name>-<project_number>.<region>.run.app` (`local.urls`), never read from a resource attribute. The same strings feed `OPT2_SERVICE_URLS`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, each push endpoint (`<consumer URL><push_path>`), each push subscription's OIDC audience, each service's `custom_audiences`, and the `service_urls` output. All are known at plan time, and services that call each other, such as `gateway` and `identity`, form no dependency cycle.

Cloud Run admits a managed delivery's OIDC token only when its audience is the service URL or exactly one of the service's `custom_audiences` (`local.custom_audiences`). These are every push endpoint the service consumes and the target URL of every queue it serves, `<target URL><target_path>`. Every queue's target path is fixed, such as `/internal/v1/tasks/surveys/launch`, `/internal/v1/outbox/sweep` or `/internal/v1/jobs/sitemonitor`, so each task's audience is the exact URL it calls; the id a task acts on travels in its body, never in its path. The platform's `managedAudience` derives that audience for both the Cloud Tasks adapter and the `cloud-tasks` verifier, `check "topology"` refuses a target path holding `{`, and `harness/test/repro/cloud-audiences.test.ts` checks the composition for every subscription and queue.

## Generated topology

`envs/plan/topology.auto.tfvars.json` is written by `harness/src/repro/pubsub-topology.ts --target cloud` from the event contracts (`services/*/contracts/events/*.json`), the API contracts and `cloud_run_services` in `plan.tfvars`. Entries whose producer or consumer is not deployed are dropped, so the stub's `stub.note.created.v1` is absent. Never edit it by hand.

| Key | Content |
|---|---|
| `topics` | `<service>.<entity>.<event>.v<major>` to its `producer` and `kind` (`state` or `process`) |
| `subscriptions` | `<consumer>.<topic>` to its topic, consumer, `push_path` (`/internal/v1/events/<subscription>`), dead-letter topic `<subscription>.dlq` after 5 delivery attempts, and replay subscription `<subscription>.dlq.replay` |
| `queues` | Queue name to its creators, target service and path, cadence, deadline and retry policy |
| `service_calls` | Caller service to the services it invokes, from the API contracts |

Terraform reads the producers, push paths, dead-letter settings, queue creators, queue targets and retry policies; the other fields record the contract values for review. Push subscriptions have message ordering on, a 60 s acknowledgement deadline and redelivery backoff from 10 s to 600 s.

| Queue | Target service | Creators |
|---|---|---|
| `identity-outbox-sweep` | `identity` | `identity` |
| `people-outbox-sweep` | `people` | `people` |
| `programs-sites-outbox-sweep` | `programs-sites` | `programs-sites` |
| `programs-sites-sitemonitor` | `programs-sites` | `programs-sites` |
| `content-scheduled-publish` | `strategies-content` | `programs-sites`, `strategies-content` |
| `content-feed-import` | `strategies-content` | `programs-sites` |
| `communications-outbox-sweep` | `communications` | `communications` |
| `communications-reminders` | `communications` | `communications` |
| `surveys-launch` | `surveys` | `communications` |
| `surveys-outbox-sweep` | `surveys` | `surveys` |
| `reporting-export-run` | `reporting` | `reporting` |

Regenerate after a contract or `cloud_run_services` change, from `harness/` (its `npm ci` also installs and builds `platform`):

```sh
cd harness
CI=true npm ci
npm run topology -- --target cloud
npm run topology -- --target cloud --check
```

`--check` exits 1 on a difference. The `topology` job of `.github/workflows/terraform.yml` regenerates the file and fails on any `git diff`.

## Identity and access

Only the gateway is public: it is `INGRESS_TRAFFIC_ALL` with `allUsers` as invoker. Every other service is `INGRESS_TRAFFIC_INTERNAL_ONLY`; callers reach it through Direct VPC egress (`ALL_TRAFFIC`) on the `opt2` subnet, and same-project Pub/Sub push and Cloud Tasks requests count as internal.

| Grant | Scope | Members | Purpose |
|---|---|---|---|
| `roles/logging.logWriter`, `roles/telemetry.tracesWriter` | Project | The 13 runtime accounts | Logs and trace export |
| `roles/cloudsql.client`, `roles/cloudsql.instanceUser` | Project | The 13 database accounts | IAM database connections |
| `roles/firebaseauth.admin` | Project | `opt2-identity` | Identity Platform custom tokens |
| `roles/pubsub.viewer` | Project | `opt2-migration` | The transition drain lists subscriptions and reads their metadata |
| `roles/iam.serviceAccountTokenCreator` | Own account | `identity`, `strategies-content`, `reporting`, `finance`, `e-signature` | Keyless signing of custom tokens and v4 signed URLs |
| `roles/run.invoker` | `gateway` | `allUsers` | Public entry point |
| `roles/run.invoker` | `web` | `opt2-gateway` | Admin screens |
| `roles/run.invoker` | Each domain service | `gateway`, `migration`, its callers in `service_calls`, `opt2-pubsub-invoker` if it consumes events, `opt2-tasks-invoker` if it is a task target | Service calls, push and task delivery |
| `roles/run.invoker` | `migration` | `gateway`, `programs-sites`, its callers in `service_calls` | Write windows and projection barriers; the site-monitor orchestrator |
| `roles/iam.serviceAccountTokenCreator` | `opt2-pubsub-invoker` | Pub/Sub service agent | Push OIDC tokens |
| `roles/pubsub.publisher` on DLQ topics, `roles/pubsub.subscriber` on push subscriptions | Per subscription | Pub/Sub service agent | Dead-letter forwarding |
| `roles/pubsub.publisher` | Own topics | Each producer | Outbox publishing |
| `roles/pubsub.publisher` | Own DLQ topics | Each consumer | The push handler dead-letters tenant and schema failures itself |
| `roles/pubsub.subscriber` | Each DLQ replay subscription | `opt2-migration` | The transition drain peeks dead letters without acknowledging them |
| `roles/cloudtasks.enqueuer`, `roles/cloudtasks.queueAdmin`, `roles/cloudtasks.viewer`, `roles/cloudtasks.taskDeleter` | Each queue | The queue's creators | Create, list and delete tasks; get, pause and resume the queue during transitions |
| `roles/iam.serviceAccountUser` | `opt2-tasks-invoker` | Every queue creator | Tasks carry the `opt2-tasks-invoker` OIDC identity |
| `roles/storage.objectAdmin` | Each bucket | Its one writer: `strategies-content` (`content-files`), `reporting` (`reporting-exports`), `finance` (`finance-attachments`), `e-signature` (`esignature-documents`) | Objects and signed URLs |
| `roles/secretmanager.secretAccessor` | Each secret | Its accessors (next section); on each operator-provided secret, its readers, granted by `modules/service_account` (`secret_access`) | Secret env and the collector configuration |

## Secrets

Nothing secret is in this tree. Services reach Cloud SQL through IAM database authentication, so they have no Cloud SQL passwords. Identity Platform signs end-user tokens and Google signs service OIDC tokens, so no service holds a signing key. The four secrets below are the only ones this tree creates; an operator adds their values outside this configuration.

| Secret | Versions | Accessors | Consumed as |
|---|---|---|---|
| `communications-smtp` | None | `communications` | `SMTP_CREDENTIAL` |
| `legacy-bridge-hmac` | None | `gateway`, `migration` | `OPT2_BRIDGE_HMAC_KEY` |
| `cloudsql-admin-password` | None | `db-bootstrap` | `OPT2_CLOUDSQL_ADMIN_PASSWORD` of the job |
| `otel-collector-config` | One: the committed, non-secret `modules/cloud_run_service/otel-collector.yaml` | The 13 runtime accounts | Sidecar volume `/etc/otelcol-google/config.yaml` |

Operator-provided secrets already exist in the project with their values. Terraform never creates them or their versions: it references each id from `operator_secret_ids` as a secret env and grants each reader `roles/secretmanager.secretAccessor` on it.

| `operator_secret_ids` entry | Env | Readers |
|---|---|---|
| `legacy_db_password` | `MURA_DBPASSWORD`: the legacy SQL Server password | `migration` |
| `legacy_reload_key` | `MURA_APPRELOADKEY`: the legacy origin's reload key, with no whitespace or control characters, which the services refuse at start-up. Null when legacy keeps Masa's default `appreload`; no service then gets the variable or the grant | `gateway`, `web`, `identity`, `people`, `programs-sites`, `strategies-content`, `migration` |
| `identity_platform_api_key` | `OPT2_IDENTITY_PLATFORM_API_KEY`: the project Web API key that Identity Platform's `accounts:signInWithCustomToken` takes | `identity` |

Secret env references and the collector volume use version `latest`.

## Telemetry

Every Cloud Run service runs a second container, `otel-collector`, from the pinned image `us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.163.1`; Google labels its sample alpha. The app exports OTLP/HTTP to `http://localhost:4318` (`OTEL_EXPORTER_OTLP_ENDPOINT`). The collector adds GCP resource attributes, batches, and exports traces over OTLP to `telemetry.googleapis.com:443`, authenticating as the service account through `googleclientauth`. Its health check on port 13133 is the startup probe, and the app container starts after it. Only `migration` keeps CPU allocated outside requests (`cpu_idle = false` on both containers), beside its one warm instance. Every other service is request-billed (`cpu_idle = true` on both containers): its spans export while requests run, and a batch still pending goes out on a later request or at shutdown. Logs go to stdout as structured JSON for Cloud Logging.

## Residual risks

| Risk | Note |
|---|---|
| Cloud paths untested | Identity Platform tokens, invocation credentials, Cloud Tasks, signed URLs, Secret Manager, the `db-bootstrap` job and the collector sidecar have never run against live services |
| Plan scope | A plan proves resources and bindings are well-formed and wired, not that running connections work |
| Bucket names | Bucket names are global and may already be taken |
| Legacy connectivity | Connectivity to `legacy_origin` and `legacy_db_host`, which leave through Cloud NAT, is the operator's, as are the operator-provided secrets and their values: the plan references their ids but cannot prove they exist. `legacy_settings` must match the legacy origin's effective settings, or targets build URLs and enforce password policies that differ from legacy's |
| Google APIs | Cloud Run, Cloud SQL Admin, Service Networking, Compute, Pub/Sub, Cloud Tasks, Storage, Identity Toolkit, Secret Manager, IAM, IAM Credentials, Logging and Telemetry must be enabled outside this configuration |
