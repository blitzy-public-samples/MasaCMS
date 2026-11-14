**SYNTHETIC MODULE**
Reporting has no Masa equivalent beyond owning the legacy `tsessiontracking` table; its legacy oracle is the reporting fixture in [`legacy-fixtures/`](../../legacy-fixtures/README.md).

# reporting

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md). Shared components: [`platform/README.md`](../../platform/README.md).

## What it does

- **Export jobs.** A user holding `reporting.exporter` asks for an export of one of the site's definitions in `xlsx`, `csv` or `pdf`. A definition names a source and a column list. The sources are `timesheets.sheets` (sheet status as of the business date `asOf`, today when absent) and `finance.records`. A third source, `broken`, always fails; it exists to exercise the failure path.
- **Asynchronous run.** The request returns at once with the job `queued`. A Cloud Task on `reporting-export-run` then runs it, and it ends in one of two states:
  - `done`, with the file downloadable;
  - `failed`, with `source-unavailable` (a `broken` source, or a producer that is unreachable or answers non-2xx) or `export-failed` (any other failure).

  Before queuing, a create fails with `export-failed` any of the site's jobs whose run task is gone. The fixture does the same for jobs left without a runner thread.
- **Output.** A header row of the definition's column names, then one row per source row, every value a string. The file is named `export-<job_id>.<format>`:
  - XLSX: one sheet named `export`.
  - CSV: RFC 4180, UTF-8 without a BOM, every line ending in CRLF.
  - PDF: the definition name above a table, drawn in the standard Times fonts. As with cfdocument, only Windows-1252 characters are drawn.

State moves follow `synthetic.usp_export_job_transition`. [`src/domain/job-state.ts`](src/domain/job-state.ts) is the only writer of `export_job.state`:

| From | To | Also sets |
|---|---|---|
| `queued` | `running` | `started_at` |
| `running` | `done` | `finished_at`, `file_name`, `content_type`, the output (stored as an object here) and `output_sha256` |
| `running` | `failed` | `finished_at`, `error` |

Each move reports `legal`, `illegal-state` (the job keeps its state) or `not-found`. `done` and `failed` are terminal.

## Legacy oracle

| Piece | Where |
|---|---|
| Endpoints | `legacy-fixtures/cfml/modules/reporting.cfc`, reached through the front controller `legacy-fixtures/cfml/api.cfm`. A `cfthread` runner moves each job |
| Tables | `legacy-fixtures/sql/reporting/100_tables.sql`: `synthetic.export_definition`, `synthetic.export_job` (output in `varbinary(max)`) |
| Procedure | `legacy-fixtures/sql/reporting/200_usp_export_job_transition.sql`: `synthetic.usp_export_job_transition` |
| Seed | `legacy-fixtures/sql/reporting/300_seed.sql` (`synthetic.usp_seed_reporting`), loaded by `legacy-fixtures/cfml/seed.cfm` from the fixed-seed dataset: 5 definitions and 200 historical jobs in `tenant-a`, 2 definitions and 10 jobs in `tenant-b` |

The fixture reads its sources from the program schema: `tvf_timesheet_status(asOf)` and `finance_record`. The service reads the same rows from timesheets and finance through their APIs.

The GS-RE scenarios in `harness/golden/catalogue.yaml` are captured from the fixture and replayed through the gateway:

- GS-RE-01: XLSX, CSV and PDF jobs through `queued` → `running` → `done`, and their downloads;
- GS-RE-02: a failed job.

Exports are compared by content, never by bytes: XLSX by cell values per sheet, CSV by cell values, PDF by extracted text per page.

## Owned data

[`opt2/table-ownership.json`](../../opt2/table-ownership.json) is authoritative (rule step 1).

| Unit | Legacy source | Notes |
|---|---|---|
| `reporting.export_definition` | `synthetic.export_definition` | One-to-one; `tenant_id` from `siteID` |
| `reporting.export_job` | `synthetic.export_job` | One-to-one; `tenant_id` from `siteID`. The `output varbinary(max)` bytes become an object in bucket `reporting-exports`, keyed `<tenantId>/<job_id>.<format>`. The row keeps `object_key` and `output_sha256`, which equals the object's SHA-256 |
| `reporting.session_tracking` | Masa `tsessiontracking` [core/setup/db/mssql.sql:349-367], with `fname`, `lname` and `company` added by [core/mura/dbUpdates/6.1.1.cfm:2-5] | Mapping only, no routes. `tenant_id` from `siteID`, or the umbrella tenant when it names no site |

`tsessiontracking` stays `legacy`-authoritative in every cut-over version. No carry entry writes it, so its group `grp:reporting.session_tracking` never moves, and only backfill and the change feed keep the target copy current. Its legacy writers are:

- page renders, through `sessionTrackingDAO.createTrackingRecord`, run in a `cfthread` when `trackSessionInNewThread` is on [core/mura/user/sessionTracking/sessionTrackingDAO.cfc:125-133,166-191];
- the history purge `clearOldData` [core/mura/user/sessionTracking/sessionTrackingDAO.cfc:213-226];
- the withheld site delete [core/mura/settings/settingsDAO.cfc:240].

The legacy-served `cdashboard` screens read the table and write nothing to it.

## Schema and roles

Schema `reporting` is created with its roles by `opt2-db bootstrap` (`migration/src/db-bootstrap/`). Its DDL is in `db/migrations/0001_platform.sql` and `db/migrations/0002_reporting.sql`.

| Role | Attributes | Use |
|---|---|---|
| `reporting_owner` | `NOLOGIN NOSUPERUSER NOBYPASSRLS` | Owns every object; FORCE RLS applies to it |
| `reporting_app` | No `SUPERUSER`, no `BYPASSRLS` | Runtime DML on this schema only; the service's `PG_USER` |
| `reporting_migrator` | Member of `reporting_owner` | Applies `db/migrations/*.sql` after `SET ROLE reporting_owner` |

- **Isolation.** Every tenant-owned table carries `tenant_id uuid NOT NULL`, with row-level security enabled and forced under the `tenant_isolation` policy on `app.tenant_id`.
- **Metadata tables.** `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` hold tenant metadata, never tenant data.
- **Platform tables.** `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `inbox`, `consumer_aggregate_version`, `outbox`, `scheduled_task_queue` and `scheduled_task_queue_state`. The last two back the local tasks adapter.

## Routes

Deny by default: every route declares its roles (`config.opt2.requires`) or `config.opt2.public`, and an undeclared route fails start-up. The role `reporting.exporter` comes from the fixture-seeded Masa group of that name in `services/identity/config/role-map.json`. Before a write runs, identity consumes its CSRF token for the empty context (`POST /internal/v1/csrf/consume`), as the fixture's writes require.

### Fixture routes

These are served in the Masa envelope under the base path `/legacy-fixtures/cfml/api.cfm/reporting`. The envelope `method` is `reporting.<resource>[.<action>]`: `reporting.exports` or `reporting.exports.download`.

| Method | Path | Requires | Answers |
|---|---|---|---|
| `GET` | `/legacy-fixtures/cfml/api.cfm/reporting/exports` | `reporting.exporter` | One page of the site's jobs (`pageIndex`, `itemsPerPage`) |
| `POST` | `/legacy-fixtures/cfml/api.cfm/reporting/exports` | `reporting.exporter` | `definitionId`, `format`, `asOf`; the job as `queued` |
| `GET` | `/legacy-fixtures/cfml/api.cfm/reporting/exports/{id}` | `reporting.exporter` | One job, without output |
| `GET` | `/legacy-fixtures/cfml/api.cfm/reporting/exports/{id}/download` | `reporting.exporter` | The output as a file stream; 409 `conflict` with message `not-ready` until `done` |

The gateway routes them by the active version in `gateway/cutover/versions/`:

- `v0001`: all four are `legacy`.
- `v0002`: the create is `target`, in group `grp:reporting.export_job`. The three reads stay `legacy`, because their units include `reporting.export_definition` and `reporting.session_tracking`, which stay `legacy`-authoritative.

### OPT-2 screens

`/v1/reporting/**` serves the export job list screen `/opt2/admin/reporting/exports`, which `web/` renders.

| Method | Path | Requires | Answers |
|---|---|---|---|
| `GET` | `/v1/reporting/exports` | `reporting.exporter` | One page (`page`, `pageSize`) of the tenant's jobs, with their total |
| `POST` | `/v1/reporting/exports` | `reporting.exporter` | Queues a job; answers it `queued` |
| `GET` | `/v1/reporting/exports/{id}` | `reporting.exporter` | One job |
| `GET` | `/v1/reporting/exports/{id}/download-url` | `reporting.exporter` | A download URL valid for 15 minutes; 409 `not-ready` until `done` |

In the cloud the download URL is a v4 signed Cloud Storage URL. Locally it is a path-only HMAC URL under `/opt2/files/reporting-exports/`.

### Internal and managed routes

| Method | Path | Requires | Does |
|---|---|---|---|
| `GET` | `/opt2/files/reporting-exports/{tenantId}/{objectName}` | public; the signature is the credential | Serves the local storage adapter's downloads |
| `GET` | `/internal/v1/exports/{exportId}/source-scope` | `service:finance`, `service:timesheets` | Returns a job's stored scope. The producer checks it before serving the job's source read |
| `POST` | `/internal/v1/tasks/exports/{exportId}/run` (`QUEUES['reporting-export-run'].targetPath`) | `service:tasks-invoker` only | Runs one job to `done` or `failed`; a job already past `queued` is left unchanged |
| `POST` | `/internal/v1/task-queues/{queue}/{pause,resume,ensure}` | `platform.migration`, `platform.operator` | Queue control for `reporting-export-run`. `ensure` answers 400, because the queue is not a recurring chain |
| `POST` | `/internal/v1/events/reporting.programs-sites.site.changed.v1` | `service:pubsub-invoker` (the local push key locally) | Push delivery into `reporting.tenant_registry` |
| `GET`, `POST` | `/internal/v1/migration/{apply,export,changes,position,watermark,gate}` | `platform.migration` | Backfill, feed, reconciliation and unit gates. `export` also returns the `reporting-exports` object manifest |
| `GET` | `/healthz` | public | Liveness probe |

## Integration

- **Tasks.** Queue `reporting-export-run` runs one task per job, named `reporting-export-run-<job_id>`. The run acts as System and carries no user credential.
- **Storage.** Export outputs are kept in bucket `reporting-exports`; locally under `${OPT2_STATE_DIR}/storage/reporting-exports/`.
- **Events.** The service consumes `programs-sites.site.changed.v1` into `reporting.tenant_registry`, which resolves site ids and pools to tenants. It produces no topic, so it has no outbox sweep.
- **Sources.** Source rows are read only through the producers' OpenAPIs, never their schemas:
  - timesheets: `GET /internal/v1/timesheets/sheet-status`, with `asOf` ([`services/timesheets/contracts/openapi.yaml`](../timesheets/contracts/openapi.yaml));
  - finance: `GET /internal/v1/finance/records` ([`services/finance/contracts/openapi.yaml`](../finance/contracts/openapi.yaml)).

## Build, test, run

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm start               # node dist/main.js
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
```

- **Configuration.** The process reads `baseEnvSchema` of `@opt2/platform/service-kit` ([details](../../platform/README.md#configuration)). Locally, `harness/repro/up.sh` starts it with these variables set inline:
  - `PORT=8116` (from `harness/repro/ports.env`), `OPT2_SERVICE_NAME=reporting`, `PG_USER=reporting_app`;
  - `OPT2_TASKS_ADAPTER=local`, `OPT2_STORAGE_ADAPTER=local`, `OPT2_STATE_DIR`;
  - `OPT2_SERVICE_URLS`, `PUBSUB_EMULATOR_HOST`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `TZ`.
- **Required entries.**
  - `OPT2_SERVICE_URLS` must contain `identity` (CSRF), `finance` and `timesheets` (sources), and `reporting` (the run task's target).
  - `PUBSUB_EMULATOR_HOST` is required with `OPT2_ENV=local`, because the publisher carries the consumer's dead letters.
- **Test dependencies.**
  - The contract and security suites need nothing external.
  - The PostgreSQL-backed suites in `test/unit` read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`. They create a throwaway schema and roles through `@opt2/platform/testing`, and are skipped when PostgreSQL is unreachable.
  - Push deliveries are injected in process, so no suite needs the Pub/Sub emulator.
- **Cloud.** The `Dockerfile` is the Cloud Run image, built in CI and never pushed. The service runs on Cloud Run with `min_instance_count = 0`, internal-only ingress and Cloud SQL IAM authentication as a member of `reporting_app` (`infra/terraform/`, plan only).

## Traceability

Each behaviour's legacy source, code and test are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
