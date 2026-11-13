**SYNTHETIC MODULE**

# surveys

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Surveys has no Masa equivalent. It is a synthetic module, and its legacy oracle is the surveys fixture in [`legacy-fixtures/`](../../legacy-fixtures/README.md): the service is built to answer the fixture's routes as the fixture does, and the outputs captured from the fixture are its parity tests.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml), [`contracts/events/surveys.survey.scheduled.v1.json`](contracts/events/surveys.survey.scheduled.v1.json). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md). Shared components: [`platform/README.md`](../../platform/README.md).

## What it does

- **Surveys.** A survey manager creates a survey for a site. It starts as `DRAFT`.
- **Scheduling.** The manager sets the launch time and any reminders, each a number of minutes after launch. The survey becomes `SCHEDULED`. Rescheduling replaces the launch and reminders and raises the schedule version. This is seam 2: surveys announces the schedule, and communications creates the launch and reminder tasks.
- **Launch and reminders.** The launch task marks the survey `LAUNCHED` once. Each reminder run is stamped as sent once. A task of a superseded schedule version changes nothing.
- **Bulk targeting.** Sites, each optionally narrowed to one group, are added in one request. Targets the survey already has are skipped. Every targeted site may then respond.
- **Responses.** Members of the survey's site or of a targeted site submit answers. Each response is kept with the survey and records the respondent's site.
- **Task list.** The manager sees the launch and reminder tasks of the current schedule.

## Legacy oracle

| Piece | Where |
|---|---|
| Endpoints | `legacy-fixtures/cfml/modules/surveys.cfc`, reached through the front controller `legacy-fixtures/cfml/api.cfm` as `/legacy-fixtures/cfml/api.cfm/surveys/<resource>[/<id>][/<action>]` |
| Tables | `legacy-fixtures/sql/surveys/100_tables.sql`: `synthetic.survey`, `survey_schedule`, `survey_reminder`, `survey_target`, `survey_response` |
| Bulk targeting | `synthetic.usp_survey_bulk_target` (`200_usp_survey_bulk_target.sql`), reimplemented in `src/domain/bulk-target.ts` |
| Seed | `synthetic.usp_seed_surveys` (`300_seed.sql`), loaded by `legacy-fixtures/cfml/seed.cfm` from the fixed-seed dataset |

Scheduling in the fixture replaces the ACF tasks `opt2-survey-<id>-launch` and `opt2-survey-<id>-reminder-<n>`. They are addressed to `OPT2_GATEWAY_ORIGIN` and call back `…/{id}/launch` and `…/{id}/remind?reminder=<n>` with the schedule's `opt2TaskToken`, whose SHA-256 is stored as `task_token_hash`. In the transition that moves the surveys units (AAP 0.4.2, fixture survey tasks):

1. `gateway/legacy-bridge/cfml/scheduler.cfm?op=pause` pauses them.
2. After activation, communications `/internal/v1/migration/adopt-scheduled-tasks` recreates them as Cloud Tasks and `communications.scheduled_task` rows, idempotent by task name.
3. `op=delete` removes the ACF tasks.

## Owned data

Schema `surveys`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with three roles:

| Role | Use |
|---|---|
| `surveys_owner` | `NOLOGIN`; owns the schema and every object, and FORCE RLS applies to it |
| `surveys_app` | Runtime DML only; the service's `PG_USER` |
| `surveys_migrator` | Applies `db/migrations/*.sql` after `SET ROLE surveys_owner` |

Fixture tables, as assigned in [`opt2/table-ownership.json`](../../opt2/table-ownership.json) (rule step 1) and mapped in `src/migration/mappings/`:

| Legacy table | Target table | Tenant | Target-only column |
|---|---|---|---|
| `synthetic.survey` | `surveys.survey` | `tenantIdForSite(siteID)` | — |
| `synthetic.survey_schedule` | `surveys.survey_schedule` | The parent survey's | `row_version`, the `aggregateVersion` of `surveys.survey.scheduled.v1` |
| `synthetic.survey_reminder` | `surveys.survey_reminder` | The parent survey's | — |
| `synthetic.survey_target` | `surveys.survey_target` | The parent survey's; its `siteID` is the targeted site, not the owner | — |
| `synthetic.survey_response` | `surveys.survey_response` | `tenantIdForSite(siteID)`, where `siteID` is the survey's site | — |

Every table adds `tenant_id uuid NOT NULL`, with row-level security enabled and forced under the `tenant_isolation` policy on `app.tenant_id`. No table declares a foreign key.

Platform tables (`db/migrations/0001_platform.sql`): `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `inbox`, `consumer_aggregate_version`, `outbox`, `scheduled_task_queue` and `scheduled_task_queue_state`. `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` are non-tenant tables without row-level security or a `tenant_isolation` policy: they hold tenant metadata, never tenant data. `tenant_registry` maps each site to its `tenant_id` and pool tenants; `tenant_grant` stores `grantor_tenant` and `grantee_tenant`.

## Routes

Every route declares `config.opt2.requires` or `config.opt2.public`; anything else fails start-up. `surveys.manager` is the role identity mints from the fixture-seeded Masa group of that name (`services/identity/config/role-map.json`).

### Fixture routes

Paths below are under `/legacy-fixtures/cfml/api.cfm/surveys/surveys`. Each answers in the Masa envelope with the method name shown. Transport is `service`. The routes are public on the platform because, as in the fixture, the handler checks the site first, then login, the role group and, on writes, the CSRF token for context `id`, which identity consumes once (`POST /internal/v1/csrf/consume`, called as `service:surveys`). The gateway routes them `legacy` in `v0001` and `target` from `v0002` (groups `grp:surveys.survey`, `grp:surveys.survey_target`, `grp:surveys.survey_response`).

| Method | Path | Method name | Checked in the handler | Does |
|---|---|---|---|---|
| `GET` | *(collection)* | `surveys.surveys` | `surveys.manager` | One page of the site's surveys |
| `POST` | *(collection)* | `surveys.surveys` | `surveys.manager` | Creates a `DRAFT` survey from `title` |
| `GET` | `/{id}` | `surveys.surveys` | `surveys.manager` | The survey with its schedule, reminders and targets |
| `POST` | `/{id}/schedule` | `surveys.surveys.schedule` | `surveys.manager` | Replaces `launchAt` and `reminders[].offsetMinutes`; marks the survey `SCHEDULED`. 409 unless `DRAFT` or `SCHEDULED` |
| `POST` | `/{id}/targets/bulk` | `surveys.surveys.targets.bulk` | `surveys.manager` | Adds the missing `targets` and returns `{inserted, total}` |
| `GET` | `/{id}/responses` | `surveys.surveys.responses` | `surveys.manager` | One page of the survey's responses |
| `POST` | `/{id}/responses` | `surveys.surveys.responses` | Site member: S2, `system-user` or `member` | Stores `answers` ([below](#multi-site-responses)) |
| `GET` | `/{id}/tasks` | `surveys.surveys.tasks` | `surveys.manager` | Launch and reminder tasks with kind, callback route and offset |
| `GET`, `POST` | `/{id}/launch` | `surveys.surveys.launch` | Task token `opt2TaskToken` | Launch callback: marks the survey `LAUNCHED` once |
| `GET`, `POST` | `/{id}/remind` | `surveys.surveys.remind` | Task token `opt2TaskToken` | Reminder callback for `reminder=<n>`: stamps its `sent_at` once |

### `/v1` APIs

Used by the OPT-2 screens at `/opt2/admin/surveys/*`, which `web/` renders. Transport `service`; every route requires `surveys.manager`. Each `POST` first has identity consume the CSRF token of the survey id context, as the fixture's writes do; a missing, foreign or replayed token answers 400 `invalidTokens` and writes nothing.

| Method | Path | Does |
|---|---|---|
| `GET` | `/v1/surveys` | One page of the site's surveys with their schedules |
| `GET` | `/v1/surveys/{surveyId}` | One survey with its schedule |
| `POST` | `/v1/surveys/{surveyId}/schedule` | Replaces the launch time and reminders, marks the survey `SCHEDULED` and announces the new schedule version |
| `GET` | `/v1/surveys/{surveyId}/targets` | The survey's site and group targets |
| `POST` | `/v1/surveys/{surveyId}/targets/bulk` | Adds the missing targets and grants each targeted site its responses |
| `GET` | `/v1/surveys/{surveyId}/responses` | One page of the survey's responses from every responding site |
| `GET` | `/v1/surveys/{surveyId}/tasks` | The tasks of the current schedule version, as communications holds them (`GET /internal/v1/scheduled-tasks`) |

### Internal and managed routes

| Method | Path | Transport | Requires | Does |
|---|---|---|---|---|
| `POST` | `/internal/v1/tasks/surveys/{surveyId}/launch` | `cloud-tasks` (queue `surveys-launch`) | `service:tasks-invoker` | Marks the survey `LAUNCHED` once while the task's schedule version is current |
| `POST` | `/internal/v1/surveys/{surveyId}/reminders/{n}/sent` | `service` | `service:communications` | Stamps reminder `n` as sent once, after communications ran its reminder task |
| `POST` | `/internal/v1/migration/apply` | `service` | `platform.migration` | Applies one batch of canonical legacy rows, once per batch id |
| `GET` | `/internal/v1/migration/export` | `service` | `platform.migration` | One page of a unit's rows in canonical legacy form |
| `GET` | `/internal/v1/migration/changes` | `service` | `platform.migration` | Changelog after a cursor, below the commit-safe horizon |
| `GET` | `/internal/v1/migration/position` | `service` | `platform.migration` | Write position and outbox and inbox drain counts |
| `GET`, `POST` | `/internal/v1/migration/watermark` | `service` | `platform.migration` | Reads or records feed watermarks |
| `POST` | `/internal/v1/migration/gate` | `service` | `platform.migration` | Closes, re-phases, opens or reads the unit gates |
| `POST` | `/internal/v1/outbox/sweep` | `cloud-tasks` (queue `surveys-outbox-sweep`, every 60 s) | `service:tasks-invoker` | Creates the next sweep task, then publishes every unpublished outbox row |
| `POST` | `/internal/v1/events/surveys.programs-sites.site.changed.v1` | `pubsub-push` | `service:pubsub-invoker` (local push key locally) | Applies `programs-sites.site.changed.v1` to `surveys.tenant_registry` |
| `POST` | `/internal/v1/task-queues/{queue}/pause`, `/resume`, `/ensure` | `service` | `platform.migration`, `platform.operator` | Controls `surveys-outbox-sweep`, the one queue this service creates tasks on |
| `GET` | `/healthz` | `service` | public | Liveness probe |

## Events

Produces `surveys.survey.scheduled.v1` in the transaction of every schedule write, from the fixture route and `/v1` alike:

| Field | Value |
|---|---|
| `x-opt2-kind` | `process`, with `x-opt2-supersedes: true`: a later schedule version replaces the tasks of an earlier one, and a late earlier version is recorded as superseded |
| `aggregateType`, `aggregateId` | `survey-schedule`, the survey id; `aggregateId` is the ordering key |
| `aggregateVersion` | `survey_schedule.row_version`, incremented in the same transaction |
| `payload` | `surveyId`, `siteId`, `scheduleVersion`, `launchAt`, `launchTaskName`, `reminders[]` (`n`, `offsetMinutes`, `taskName`), `targets[]` (`siteId`, `groupName`) |

Communications consumes it: one launch task on queue `surveys-launch`, which calls `/internal/v1/tasks/surveys/{surveyId}/launch` here, and one task per reminder on `communications-reminders`, each recorded in `communications.scheduled_task`. Migration applies never emit it, because legacy already created those tasks.

Consumes `programs-sites.site.changed.v1` into `surveys.tenant_registry`, the site registry that resolves site ids, pools and grantees to tenants.

## Multi-site responses

- **Own grant.** Every stored survey carries its tenant's own `tenant_grant(kind = 'survey-response')`, with grantor and grantee both the survey tenant, written in the transaction that inserts or upserts the survey row, migration applies included, and removed with it (`src/repo/repository.ts`). Re-deriving the target grants never removes it.
- **Grant.** Bulk targeting writes `tenant_grant(kind = 'survey-response')` for each distinct registered targeted site other than the survey's own, in the survey tenant's transaction (`src/repo/grants.ts`). Migration applies of target rows re-derive the survey's grants from its stored targets.
- **Check.** A respondent's request runs first in the token's tenant. If the survey is not there, a stored grant to the token's tenant names the survey's tenant as grantor. Without one, a metadata-only read of `tenant_grant` answers as the fixture does: `forbidden` when any `survey-response` grant names the survey, `notFound` when none does; no other tenant's transaction is opened.
- **Write.** The response is written with `withTenant(grantor)`: `siteID` is the survey's site and `respondentSiteID` is the token's `site`.
- **No caller-supplied destination.** The tenant comes only from the verified token and the stored grant, never from the request (AAP 0.5.1).

## Run and test

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm start               # node dist/main.js
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
```

`test/unit` and `test/contract` need nothing external. The isolation and event suites need PostgreSQL 16 through `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, plus `PUBSUB_EMULATOR_HOST`, and create a throwaway schema and roles per run through `@opt2/platform/testing`.

- **Local.** `harness/repro/up.sh` starts the service natively on port 8117 (`harness/repro/ports.env`), with `PORT=8117` and `PG_USER=surveys_app`. It reads `baseEnvSchema` of `@opt2/platform/service-kit` (details in [`platform/README.md`](../../platform/README.md#configuration)): `PORT`, `OPT2_SERVICE_NAME`, `OPT2_ENV`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `OPT2_DB_AUTH`, `CLOUD_SQL_INSTANCE`, `PUBSUB_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPT2_JWKS_URL`, `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, `OPT2_SERVICE_URLS`, `OPT2_STATE_DIR`, `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER`, `TZ`.
- **`OPT2_SERVICE_URLS`** must contain `communications` (task list), `identity` (CSRF checks of fixture and `/v1` writes) and `surveys` itself (target of its own sweep chain).
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `surveys_app`, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).

## Parity evidence

The GS-SU scenarios in `harness/golden/catalogue.yaml` are captured from the fixture and replayed through the gateway:

| Scenario | Covers |
|---|---|
| GS-SU-01 | Schedule with launch and reminders, the task list, the launch and reminder callbacks, the survey list and the OPT-2 surveys screens |
| GS-SU-02 | Single-site responses |
| GS-SU-03 | Bulk targeting and a response from another targeted site |
| GS-SU-04 | A response from a site the survey does not target, refused with the fixture's 403 `forbidden` and nothing stored |

Each behaviour's code and test are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
