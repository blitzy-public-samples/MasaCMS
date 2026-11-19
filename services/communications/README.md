**SYNTHETIC MODULE**

# communications

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Communications has no Masa equivalent beyond owning Masa's mail tables. It is a synthetic module, and its legacy oracle is the communications fixture in [`legacy-fixtures/`](../../legacy-fixtures/README.md): the service answers the fixture's routes as the fixture does, and the outputs captured from the fixture are its parity tests.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml), [`contracts/events/communications.message.delivery-status-changed.v1.json`](contracts/events/communications.message.delivery-status-changed.v1.json). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md). Shared components: [`platform/README.md`](../../platform/README.md).

## What it does

- **Templates.** A sender stores reusable subjects and bodies for a site. `{{key}}` placeholders are filled from the send's `variables`.
- **Sends.** A sender sends one message, from a template or literal content, through the SMTP relay. Each message carries the Message-ID `<message_id@opt2.local>`.
- **Delivery status.** Every message keeps an append-only history: `queued`, then `sent` and `delivered` once Mailpit shows it, or `failed` with the detail `smtp-error` or `mailpit-not-found`.
- **Login mail.** Identity's forgot-password and send-login mail arrive as events and are sent by the rules of Masa's `mailer.cfc` `sendText` [core/mura/mailer.cfc:231]: text only, to the recipients `filterEmails` keeps. The From address implements only the last step of Masa's `getFromEmail` [core/mura/mailer.cfc:522-531]: `no-reply@` plus the first domain communications' `tenant_registry` holds for the site, else for the `default` site, else `localhost`. The earlier steps (the mail-server username when `sendFromMailServerUserName` is on, then the site contact, then the global admin email) are not implemented, because programs-sites' contract offers communications no operation for a site's mail settings; where one of them is a valid address, Masa sends from it instead. The admin forgot-password mail has no site [admin/core/views/clogin/main.cfm:310], so Masa reads the `default` site [core/mura/settings/settingsManager.cfc:539-541] and sends from its contact, `admin@example.com` as installed, where communications would use `no-reply@localhost`. GS-ID-04 does not show the difference, because `admin:clogin.main` stays `legacy` in `v0001`–`v0003` and its replay is sent by Masa; `opt2/exceptions-list.json` has no entry for it.
- **Survey tasks.** A survey schedule becomes one launch task and one task per reminder (seam 2, [below](#seam-2-survey-schedule-to-cloud-tasks)).

Masa's own mail features stay on legacy (AAP 0.3.2): the email broadcaster (`cemail`), mailing lists (`cmailinglist`), `carch.emailTest`, open tracking (`/_api/email/trackopen`) and the public `return`, `subscribe`, `unsubscribe` and `forwardEmail` actions are legacy-served. They keep writing Masa's tables, which this service holds as mappings only.

## Legacy oracle

| Piece | Where |
|---|---|
| Endpoints | `legacy-fixtures/cfml/modules/communications.cfc`, reached through the front controller `legacy-fixtures/cfml/api.cfm` as `/legacy-fixtures/cfml/api.cfm/communications/<resource>[/<id>]` |
| Tables | `legacy-fixtures/sql/communications/100_tables.sql`: `synthetic.message_template`, `synthetic.message`, `synthetic.delivery_status` |
| Seed | `synthetic.usp_seed_communications` (`legacy-fixtures/sql/communications/300_seed.sql`), loaded by `legacy-fixtures/cfml/seed.cfm` from the fixed-seed dataset |

The fixture sends with `cfmail` and confirms delivery through the Mailpit API; the service reproduces its validation, substitution, timings and status details in `src/domain/`.

## Owned data

Schema `communications`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with three roles:

| Role | Use |
|---|---|
| `communications_owner` | `NOLOGIN`; owns the schema and every object, and FORCE RLS applies to it |
| `communications_app` | Runtime DML only; the service's `PG_USER` |
| `communications_migrator` | Applies `db/migrations/*.sql` after `SET ROLE communications_owner` |

Every tenant-owned table has `tenant_id uuid NOT NULL`, with row-level security enabled and forced under the `tenant_isolation` policy on `app.tenant_id`. Units are those of [`opt2/table-ownership.json`](../../opt2/table-ownership.json) (rule step 1); mappings are in `src/migration/mappings/`.

**Fixture tables**, mapped one-to-one:

| Legacy table | Unit | Rows match on | Tenant |
|---|---|---|---|
| `synthetic.message_template` | `communications.message_template` | `template_id` | `tenantIdForSite(siteID)` |
| `synthetic.message` | `communications.message` | `message_id` | `tenantIdForSite(siteID)`; `state` is `queued`, `sent`, `delivered` or `failed` |
| `synthetic.delivery_status` | `communications.delivery_status` | `status_id` | The parent message's; append-only, with `mailpit_id` on the `delivered` row |

**Masa tables**, mapping only. No carry entry point writes them, so their units stay `legacy`-authoritative in every version; the forward feed keeps them current and reconciliation checks them.

| Legacy table | Unit | Rows match on | Tenant |
|---|---|---|---|
| `temails` | `communications.email` | `EmailID` | `siteid`, else the umbrella tenant as an orphan |
| `temailstats` | `communications.email_stat` | multiset | The parent `temails` row's |
| `temailreturnstats` | `communications.email_return_stat` | multiset | The parent `temails` row's |
| `tmailinglist` | `communications.mailing_list` | multiset | `SiteID`, else the umbrella tenant as an orphan |
| `tmailinglistmembers` | `communications.mailing_list_member` | multiset | `SiteID`, else the umbrella tenant as an orphan |
| `ttrash`, rows of `objectClass` `email` and `mailinglist`, plus the `extendObject` rows of communications subtypes | `communications.trash` | `objectID` | `siteID`; `objectstring` is byte-exact WDDX; the migration sends each row's class-map owner with it. The trash screens are withheld (decision list) |
| `tclassextend`, rows whose `baseTable` is a communications table (`temails`, `temailstats`, `temailreturnstats`, `tmailinglist`, `tmailinglistmembers` or one of the three fixture tables) | `communications.extend_subtype` | `subTypeID` | `siteID`, else the umbrella tenant as an orphan. The class-extension screens (`cextend`) are withheld (decision list) |
| `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets`, `tclassextenddata`, rows reaching those subtypes through `subTypeID`, `extendSetID` and `attributeID` | `communications.extend_set`, `communications.extend_attribute`, `communications.extend_rc_set`, `communications.extend_data` | `extendSetID`, `attributeID`, `relatedContentSetID`, `dataID` | `siteID`, else the umbrella tenant as an orphan; the migration sends each row's subtype `baseTable` with it |

`temailstats`, `temailreturnstats`, `tmailinglist` and `tmailinglistmembers` have no primary key [core/setup/db/mssql.sql:239,231,312,323]. Each target row stores `legacy_row_hash` and an `occurrence` number, so duplicates stay distinct and reconciliation compares them as multisets (AAP 0.8.4).

**Target-only data:**

- `communications.scheduled_task`: one row per survey launch or reminder task, with `task_name`, `queue`, `kind` (`survey-launch` or `survey-reminder`), `source_type` and `source_id`, `reminder_n`, `schedule_time`, `status` (`scheduled`, `done`, `superseded`, `cancelled`), `target_route`, `schedule_version` and `origin` (`event` or `adopted`). It has no legacy table and shares the group `grp:surveys.survey`.
- `communications.message.source` (`send` or `login-mail`), `event_id` and `row_version`, and `communications.delivery_status.source`. Login mail is stored as `source = 'login-mail'` rows with their history; Masa sends it without storing a row.

Platform tables (`db/migrations/0001_platform.sql`): `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `inbox`, `consumer_aggregate_version`, `outbox`, `scheduled_task_queue` and `scheduled_task_queue_state`. `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` hold tenant metadata, never tenant data, and carry no row-level security.

## Routes

Every route declares `config.opt2.requires` or `config.opt2.public`; anything else fails start-up. `communications.sender` is the role identity mints from the fixture-seeded Masa group of that name (`services/identity/config/role-map.json`).

### Fixture routes

Paths below are under `/legacy-fixtures/cfml/api.cfm/communications`. Each answers in the Masa envelope with the method name shown; transport is `service`. The routes are public on the platform, which still requires the caller's invocation credential, because, as in `api.cfm`, the handler checks the site first, then login, the `communications.sender` group and, on writes, the CSRF token of the collection context `''`, which identity consumes once.

| Method | Path | Method name | Does |
|---|---|---|---|
| `GET` | `/templates` | `communications.templates` | One page of the site's templates |
| `POST` | `/templates` | `communications.templates` | Stores `name`, `subject`, `bodyText`, `bodyHtml` |
| `GET` | `/messages` | `communications.messages` | One page of the site's messages |
| `POST` | `/messages` | `communications.messages` | Sends `templateId` with `variables`, or literal content, `to` and `from`; returns the message with `history[]` |
| `GET` | `/messages/{id}` | `communications.messages` | One message with its delivery history `history[]` |

Every other method and path under `/legacy-fixtures/cfml/api.cfm/` reaches the catch-all `/legacy-fixtures/cfml/api.cfm/*`, which reads the path as `api.cfm` does: empty segments dropped, module, resource and action in any letter case, dispatched on the effective method (`X-HTTP-Method-Override` included). It serves the five rows above under those spellings and answers anything else with the fixture `notFound`: after the site check under `communications.<resource>[.<action>][.<tail>]`, or before it under `invalid` for the module alone or more than five segments. Another module's path gets the service's not-found.

The gateway routes all five `legacy` in `v0001`. From `v0002` the two writes are `target` with their groups `grp:communications.message_template` and `grp:communications.delivery_status`; a read moves only once every unit it lists is `target`-authoritative.

### `/v1` APIs

Used by the OPT-2 screens at `/opt2/admin/communications/*` (templates, sends, delivery status), which `web/` renders. Transport `service`; every route requires `communications.sender`. Each `POST` first has identity consume the CSRF token of context `''`, as the fixture's writes do.

| Method | Path | Does |
|---|---|---|
| `GET` | `/v1/templates` | One page of the site's templates |
| `POST` | `/v1/templates` | Stores a template |
| `GET` | `/v1/messages` | One page of the site's messages |
| `POST` | `/v1/messages` | Sends a message and returns it with its history |
| `GET` | `/v1/messages/{messageId}` | One message with its delivery history |

### Internal and managed routes

| Method | Path | Transport | Requires | Does |
|---|---|---|---|---|
| `GET` | `/internal/v1/scheduled-tasks?sourceType=survey&sourceId={surveyId}` | `service` | `service:surveys`, with the forwarded user token | The survey's tasks of its current schedule version, in the token's tenant, with a null `next`, streamed from batches of 1000 each read in its own transaction; with `limit` (1 to 1000, default 100) or `after` (the previous page's `next`), one keyset page of them on that page's schedule version and the cursor of the next; `taskName`, repeated for up to 100 names, lists only the tasks so named; read by surveys' `{id}/tasks` |
| `POST` | `/internal/v1/scheduled-tasks/survey-launches/{surveyId}/done` | `service` | `service:surveys` | Marks the launch task surveys ran `done`, matched by queue task name, survey and schedule version under the body's tenant; a done, superseded or cancelled task changes nothing |
| `POST` | `/internal/v1/tasks/reminders` | `cloud-tasks` (queue `communications-reminders`) | `service:tasks-invoker` | Runs the reminder whose scheduled-task row the task payload names under the body's tenant: reports it sent to surveys, then marks the task `done`; a done, superseded or cancelled task changes nothing |
| `POST` | `/internal/v1/migration/apply` | `service` | `platform.migration` | Applies one batch of canonical legacy rows, once per batch id |
| `GET` | `/internal/v1/migration/export` | `service` | `platform.migration` | One page of a unit's rows in canonical legacy form; `communications.scheduled_task`, which has no legacy table, is encoded over its own columns with an empty `legacyTable` |
| `GET` | `/internal/v1/migration/changes` | `service` | `platform.migration` | Changelog after a cursor, below the commit-safe horizon |
| `GET` | `/internal/v1/migration/position` | `service` | `platform.migration` | Write position and outbox and inbox drain counts |
| `GET`, `POST` | `/internal/v1/migration/watermark` | `service` | `platform.migration` | Reads or records feed watermarks |
| `POST` | `/internal/v1/migration/gate` | `service` | `platform.migration` | Closes, re-phases, opens or reads the unit gates |
| `POST` | `/internal/v1/migration/adopt-scheduled-tasks` | `service` | `platform.migration` | Recreates the fixture's paused `opt2-survey-*` ACF tasks as queue tasks and `scheduled_task` rows (`origin = adopted`), once per task name; a passed run time is scheduled immediately (AAP 0.4.2). A cancelled task adopted again is queued as `<name>-v<scheduleVersion>-r<generation>`, because its earlier queue task name stays a tombstone; a queue task its cancellation failed to delete is deleted first, and while that delete fails the call answers the legacy 503 and the row keeps its name |
| `POST` | `/internal/v1/migration/cancel-adopted-scheduled-tasks` | `service` | `platform.migration` | Cancels the named, or every, still-scheduled adopted task and deletes its queue task, when the surveys units return to legacy |
| `POST` | `/internal/v1/events/communications.programs-sites.site.changed.v1` | `pubsub-push` | `service:pubsub-invoker` (local push key locally) | Site registry ([Events](#events)) |
| `POST` | `/internal/v1/events/communications.identity.login-mail.requested.v1` | `pubsub-push` | `service:pubsub-invoker` (local push key locally) | Login mail |
| `POST` | `/internal/v1/events/communications.surveys.survey.scheduled.v1` | `pubsub-push` | `service:pubsub-invoker` (local push key locally) | Seam 2 |
| `POST` | `/internal/v1/outbox/sweep` | `cloud-tasks` (queue `communications-outbox-sweep`, every 60 s) | `service:tasks-invoker` | Creates the next sweep task, publishes every unpublished outbox row, sends login mail still `queued` after 30 s and re-queues task rows whose queue call was lost |
| `POST` | `/internal/v1/task-queues/{queue}/pause`, `/resume`, `/ensure` | `service` | `platform.migration`, `platform.operator` | Controls `surveys-launch`, `communications-reminders` and `communications-outbox-sweep`, the queues this service creates tasks on |
| `GET` | `/healthz` | `service` | public, invocation credential optional | Liveness probe |

## Events

| Direction | Topic | Kind | Effect |
|---|---|---|---|
| Produces | `communications.message.delivery-status-changed.v1` | `state` | Full delivery state of one message (`aggregateId` = message id, `aggregateVersion` = `message.row_version`), written to the outbox in the transaction of every state change. No consumer this run; contract-tested |
| Consumes | `programs-sites.site.changed.v1` | `state` | `communications.tenant_registry`: site, tenant, pools and domains |
| Consumes | `identity.login-mail.requested.v1` | `process` | Stores the mail `queued` once per `eventId` in the envelope tenant, re-checked against the registry, and sends it after commit (GS-ID-04, `withheld`) |
| Consumes | `surveys.survey.scheduled.v1` | `process`, `x-opt2-supersedes` | Seam 2, below |

## Seam 2: survey schedule to Cloud Tasks

For each schedule version, the consumer creates one launch task on `surveys-launch`, which calls surveys' `QUEUES['surveys-launch'].targetPath` (`/internal/v1/tasks/surveys/launch`), and one task per reminder on `communications-reminders`, which calls `/internal/v1/tasks/reminders`, each recorded in `communications.scheduled_task` with that fixed path as `target_route`. Task URLs carry no ids, so each is an exact OIDC audience: the launch payload names the survey, site and schedule version, and the reminder payload the scheduled-task row, survey, ordinal and schedule version. Task names are deterministic, the fixture's ACF name suffixed with `-v<scheduleVersion>`, so creating a task twice is a no-op. A newer `scheduleVersion` marks the earlier version's tasks still `scheduled` as `superseded` and deletes them from the queue; tasks already `done` or `cancelled` keep their status and history. A run task becomes `done`: the reminder task closes its own row after surveys' reminder-sent call, and surveys reports each launch it ran on `/internal/v1/scheduled-tasks/survey-launches/{surveyId}/done`. Survey data changes only through surveys' OpenAPI.

## Configuration

`communicationsEnvSchema` (`src/app.ts`) is the platform's `baseEnvSchema` (AAP 0.6.2; see [`platform/README.md`](../../platform/README.md#configuration)) plus:

| Variable | Local | Cloud | Use |
|---|---|---|---|
| `SMTP_HOST`, `SMTP_PORT` | Mailpit `127.0.0.1`, `1025` | The relay | Every send; 10 s SMTP timeout, as the fixture's `cfmail` |
| `SMTP_CREDENTIAL` | Unset: no SMTP AUTH | Required: secret env `communications-smtp`, JSON with `user` and `pass` | AUTH over TLS on port 465, otherwise over required STARTTLS |
| `MAILPIT_API_URL` | `http://127.0.0.1:8025` | Terraform variable | Delivery confirmation: `GET /api/v1/search?query=message-id:<message_id>@opt2.local`, up to 10 tries 500 ms apart within 10 s, as the fixture |

`OPT2_SERVICE_URLS` must contain `surveys` (launch target, reminder-sent call), `identity` (CSRF consumption) and `communications` itself (reminder target and its sweep chain). Start-up refuses an environment missing any of them, `OPT2_DB_AUTH` or `PG_DATABASE`, with an `OPT2_SERVICE_NAME` other than `communications`, or with an `SMTP_CREDENTIAL` that is not JSON with a non-empty `user` and `pass`, naming each variable but never its value.

## Build, test and run

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm start               # node dist/main.js
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
npm run lint            # eslint with typescript-eslint recommended rules
npm run typecheck       # contract types, then tsc over src/ and test/ without emitting
```

No suite needs Mailpit, and only the DLQ replay suite of `test/events/dlq.test.ts` needs the Pub/Sub emulator: it runs `opt2-events replay` against `PUBSUB_EMULATOR_HOST` (project prefix `GOOGLE_CLOUD_PROJECT`) and is skipped when that variable is unset; an emulator that does not answer within 10 s fails it (`pubsubEmulatorAvailable`). Every other suite injects pushes through `app.inject` (`pushTo` of `@opt2/platform/testing`) and captures publications in process (`createCapturingPublisher`); the app environment from `testEnv` (`test/helpers/app.ts`) holds placeholder `PUBSUB_EMULATOR_HOST` and `PG_*` values that are never connected to. PostgreSQL 16 is needed, through `PG_HOST`, `PG_PORT` (default 5432), `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, by `test/isolation`, `test/events` and eight unit files: `adoption-route`, `consumer-tenant-binding`, `messages`, `queries`, `query-plans`, `repository`, `scheduled-tasks-route` and `survey-schedule-domain` (`.test.ts`). Each creates a throwaway schema and roles per run through `@opt2/platform/testing` and first calls `pgAvailable()`, which is false when `PG_HOST` is unset and throws when `PG_USER`, `PG_PASSWORD` or `PG_DATABASE` is unset, the server answers with an error such as a refused login, or it does not answer within 10 s. These suites are therefore skipped only when `PG_HOST` is unset. `test/contract`, `test/security` and every other unit file need nothing external; the SMTP relay and Mailpit stall cases in `test/contract` (`smtp-relay`, `mailpit-search`) use an in-process loopback listener.

- **Local.** `harness/repro/up.sh` starts the service natively on port 8115 (`harness/repro/ports.env`), as `PORT=8115 npm start` with `PG_USER=communications_app`.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `communications_app`, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).

## Parity evidence

Scenarios in `harness/golden/catalogue.yaml`, captured from legacy and replayed through the gateway:

| Scenario | Covers |
|---|---|
| GS-ID-04 | Forgot-password mail captured in Mailpit; `withheld` (`opt2/decision-list.json#admin:clogin.main{status=sendlogin}`), so Masa sends it until the proposal is approved |
| GS-CM-01 | Template store |
| GS-CM-02 | Send to Mailpit and delivery-status history |

Each behaviour's code and test are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
