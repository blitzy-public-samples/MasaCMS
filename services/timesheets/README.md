**SYNTHETIC MODULE**

# timesheets service

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Timesheets has no Masa equivalent: it is a synthetic module whose legacy oracle is the timesheets fixture in [`legacy-fixtures/`](../../legacy-fixtures/README.md) (`legacy-fixtures/cfml/modules/timesheets.cfc`, served through `legacy-fixtures/cfml/api.cfm`, and `legacy-fixtures/sql/timesheets/{100_timesheet_transition,110_tables.program,200_procedures.program,210_usp_person_archived_blackout,300_seed.program}.sql`), and the outputs captured from that fixture are its parity tests.

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md). Shared components: [`platform/README.md`](../../platform/README.md).

## What it does

- **Timesheets.** Each person has one timesheet per period, with a due date, and one row per work day holding the hours worked.
- **Approval.** The employee submits each day. A primary approver approves it, then a secondary approver gives the final approval. Either approver may return the day at their own step, and the employee resubmits it. An approved day is final.
- **Archive blackouts.** When a person is archived, each of their open days (not yet approved) from the archive's effective date is blacked out. A blacked-out day can no longer be acted on and no longer counts towards its sheet's status.
- **Status and overdue.** A sheet's status and overdue flag are derived from its days for a business date `asOf`, never stored.
- **Reporting.** Reporting's `timesheets.sheets` export reads the sheet status rows.

## Lifecycle

| From | Action (role) | To |
|---|---|---|
| DRAFT | submit (`timesheets.employee`) | SUBMITTED |
| SUBMITTED, RESUBMITTED | primary-approve (`timesheets.primary-approver`) | PRIMARY_APPROVED |
| PRIMARY_APPROVED | secondary-approve (`timesheets.secondary-approver`) | APPROVED |
| SUBMITTED, RESUBMITTED | return (`timesheets.primary-approver`) | RETURNED |
| PRIMARY_APPROVED | return (`timesheets.secondary-approver`) | RETURNED |
| RETURNED | resubmit (`timesheets.employee`) | RESUBMITTED |
| APPROVED | — | terminal |
| any blackout day | any | 409 `blackout` |

- **One definition.** [`src/domain/lifecycle.transitions.ts`](src/domain/lifecycle.transitions.ts) (`defineTransitions` from `@opt2/platform/state-machine`) is the only place the transitions and the `blackout` guard are written.
- **Generated table.** `generateTable` expands every state × action × role: 90 rows (6 × 5 × 3), 8 legal, plus the same 90 under the `blackout` guard. `npm run export-transitions` writes all 180 to `test/generated/transition-table.json`, and the 90 unguarded rows with one `blackout` block to [`opt2/reports/state-machines/timesheets.json`](../../opt2/reports/state-machines/timesheets.json). `legacy-fixtures/load-fixtures.sh` loads that report into `synthetic.timesheet_transition` and `synthetic.transition_rule`, which `usp_timesheet_day_action` enforces, so the oracle and the service apply one table.
- **Outcomes.** Legal: 200 with the day in its new state. Illegal state: 409 `illegalTransition`. Wrong role: 403. Blackout day: 409 `blackout`, whatever the action and role.
- **Writes.** A legal action updates the day's `state`, `lastupdate` and `lastupdatebyid` and inserts one `approval_action` row, each with its changelog row, in one transaction ([`src/domain/day-action.ts`](src/domain/day-action.ts)).

### Sheet status

[`src/domain/sheet-status.ts`](src/domain/sheet-status.ts) mirrors `tvf_timesheet_status`, which `usp_timesheet_status` and `usp_timesheet_status_list` read. Over the sheet's non-blackout days, the first match wins:

| Status | When |
|---|---|
| RETURNED | Any day is RETURNED |
| APPROVED | Every day is APPROVED |
| PARTIALLY_APPROVED | Some days are APPROVED |
| SUBMITTED | Every day is SUBMITTED or later |
| DRAFT | Otherwise, including a sheet with no non-blackout day |

- **Overdue.** `due_date` is before `asOf` and some non-blackout day is still DRAFT.
- **Counts.** `day_count` includes blackout days, `blackout_count` counts them, `approved_count` counts non-blackout APPROVED days.
- **`asOf`.** A request parameter; when omitted it is today in the legacy server's zone. Golden scenarios always pass it, so their outputs are clock-independent.

## Legacy oracle

| Piece | Where |
|---|---|
| Endpoints | `legacy-fixtures/cfml/modules/timesheets.cfc`, reached as `/legacy-fixtures/cfml/api.cfm/timesheets/<resource>[/<id>][/<action>]` |
| Tables | `sql/timesheets/110_tables.program.sql`: `Program_N.timesheet`, `timesheet_day`, `approval_action`, `blackout`; `sql/timesheets/100_timesheet_transition.sql`: `synthetic.timesheet_transition` |
| Procedures | `sql/timesheets/200_procedures.program.sql`: `tvf_timesheet_status`, `usp_timesheet_status` and `usp_timesheet_status_list` (reimplemented in `src/domain/sheet-status.ts`), `usp_timesheet_day_action` (`src/domain/day-action.ts`), `usp_apply_blackout` (`src/domain/blackout.ts`); `sql/timesheets/210_usp_person_archived_blackout.sql`: `synthetic.usp_person_archived_blackout`, which the people archive fixture calls (`src/events/person-archived.ts`) |
| Seed | `sql/timesheets/300_seed.program.sql` (`usp_seed_timesheets`), loaded by `legacy-fixtures/cfml/seed.cfm` from the fixed-seed dataset |

## Owned data

Schema `timesheets`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with the roles `timesheets_owner` (`NOLOGIN`; owns every object; FORCE RLS applies to it), `timesheets_app` (runtime DML; the service's `PG_USER`) and `timesheets_migrator` (applies `db/migrations/*.sql` after `SET ROLE timesheets_owner`). No role has `BYPASSRLS`.

[`opt2/table-ownership.json`](../../opt2/table-ownership.json) is authoritative for units and columns (rule step 1). Each fixture table exists once per program schema and folds into one tenant-column table; `tenant_id` is `tenantIdForSite(siteID)` for the program's site in `synthetic.program_site` (program 1 → `tenant-a`, program 2 → `tenant-b`), and `legacy_program_id` keeps the source schema for reconciliation:

| Legacy table | Target table | Cut-over group | Notes |
|---|---|---|---|
| `[Program_1\|Program_2].timesheet` | `timesheets.timesheet` | `grp:timesheets.timesheet` | Person, site, period and `due_date` |
| `[Program_1\|Program_2].timesheet_day` | `timesheets.timesheet_day` | `grp:timesheets.approval_action` | `state`; `hours numeric(19,4)`, serialised as a four-decimal string |
| `[Program_1\|Program_2].approval_action` | `timesheets.approval_action` | `grp:timesheets.approval_action` | One row per applied action |
| `[Program_1\|Program_2].blackout` | `timesheets.blackout` | `grp:people.person_archive` | One row per blacked-out day; a unit of the people-roster rollback set `R` |

- **Owned, not migrated.** `synthetic.timesheet_transition` and `synthetic.transition_rule`, loaded from the exported report.
- **Platform tables.** `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `inbox`, `consumer_aggregate_version`, `outbox`.
- **Isolation.** Every tenant-owned table carries `tenant_id uuid NOT NULL` with row-level security enabled and forced under `tenant_isolation` on `app.tenant_id`.
- **No foreign keys**, as in the fixture.

## Routes

Deny by default: every route declares its roles (`config.opt2.requires`) or `config.opt2.public`, and an undeclared route fails start-up. The timesheets roles come from the fixture-seeded Masa groups in `services/identity/config/role-map.json`. Day actions have identity consume the CSRF token first (`POST /internal/v1/csrf/consume`, context = the day id), as the fixture's writes do.

### Fixture routes

Served under `/legacy-fixtures/cfml/api.cfm/timesheets` in the Masa envelope, with `method` = `timesheets.<resource>[.<action>]`. Each also answers the other HTTP method carrying `X-HTTP-Method-Override`, as the fixture does.

| Method | Path | Requires | Does |
|---|---|---|---|
| `GET` | `/sheets` | any timesheets role | One page (`pageIndex`, `itemsPerPage`) of the site's sheets with status, overdue flag and day counts as of `asOf` |
| `GET` | `/sheets/{id}` | any timesheets role | The sheet with its status fields as of `asOf` and its `days[]` |
| `GET` | `/sheets/{id}/status` | any timesheets role | The sheet's `usp_timesheet_status` row as of `asOf` |
| `POST` | `/days/{id}/{submit\|primary-approve\|secondary-approve\|return\|resubmit}` | any timesheets role; the transition table decides | Applies the action with an optional `comment` and returns the day |

The committed cut-over versions route the day actions `legacy` in `v0001` and `target` from `v0002` (group `grp:timesheets.approval_action`). The sheet reads stay `legacy` in every version: their units include `timesheets.timesheet`, whose group has no carry write entry and so stays legacy-authoritative. Legacy answers them from tables the reverse projector keeps current.

### OPT-2 screens

`/v1/timesheets/**` serves the screens at `/opt2/admin/timesheets/*` that `web/` renders (`web/src/screens/opt2/timesheets/`), and reporting's interactive reads.

| Method | Path | Requires | Does |
|---|---|---|---|
| `GET` | `/v1/timesheets/sheets` | any timesheets role | Sheet list with status and overdue flag as of `asOf`, paged |
| `GET` | `/v1/timesheets/sheets/{id}` | any timesheets role | Sheet detail with its days and the caller's allowed day actions, as of `asOf` |
| `POST` | `/v1/timesheets/days/{id}/{action}` | any timesheets role; the transition table decides | Day action and its approval action |
| `GET` | `/v1/timesheets/sheet-status` | `reporting.exporter`, `timesheets.primary-approver` or `timesheets.secondary-approver` | Status rows shaped like `tvf_timesheet_status` as of `asOf`: every row, or one page with `total` |

### Internal and managed routes

| Method | Path | Requires | Does |
|---|---|---|---|
| `GET` | `/internal/v1/timesheets/sheet-status` | `service:reporting` | One page of status rows for a running export job, once reporting's `getExportSourceScope` confirms the job's tenant, site and claim |
| `POST` | `/internal/v1/events/timesheets.people.person.archived.v1` | `service:pubsub-invoker` (local push key locally) | Seam 1: blackouts of an archived person ([Events](#events)) |
| `POST` | `/internal/v1/events/timesheets.programs-sites.site.changed.v1` | `service:pubsub-invoker` (local push key locally) | Push delivery into `timesheets.tenant_registry` |
| `GET`, `POST` | `/internal/v1/migration/{apply,export,changes,position,watermark,gate}` | `platform.migration` | Backfill, feed, reconciliation, unit gates and the reverse projection's changelog reads |
| `GET` | `/healthz` | public | Liveness probe |

## Events

- **Consumes `people.person.archived.v1` (seam 1).** Kind `process`, `x-opt2-tenant-fanout: userPool`; payload `personId`, `archiveId`, `siteId`, `effectiveFrom`, `archivedAt`; subscription `timesheets.people.person.archived.v1`.
  - **Destinations.** The envelope tenant, plus every tenant whose registered public or private user pool is that tenant, from this service's own `tenant_registry`; never from the payload.
  - **Tenant check.** The envelope's aggregate must be the payload's person, and the envelope tenant's registered site must equal `siteId`.
  - **Effect.** In each destination, one `timesheets.blackout` row per open day of the person on or after `effectiveFrom` without a blackout yet, mirroring `synthetic.usp_person_archived_blackout` and `usp_apply_blackout`.
  - **Delivery.** Inbox receipts per `(tenant_id, event_id)` give each destination one effect, even when a partly applied fan-out is redelivered whole. A missing or invalid tenant, a schema failure or a tenant mismatch goes to `timesheets.people.person.archived.v1.dlq`; processing errors are nacked and retried.
- **Consumes `programs-sites.site.changed.v1`** (subscription `timesheets.programs-sites.site.changed.v1`) into `timesheets.tenant_registry`, which resolves site ids and user pools to tenants.
- **Produces** no topic: `timesheets.outbox` stays empty, and the service has no outbox sweep or task queue.

## Run and test

```sh
npm ci                               # postinstall builds ../../platform
npm run build                        # contract and event types into src/generated/, then tsc into dist/
npm start                            # node dist/main.js
npm test                             # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
npm run export-transitions           # regenerate the transition table and its export
npm run export-transitions -- --check
```

- **Configuration.** `baseEnvSchema` of `@opt2/platform/service-kit` ([details](../../platform/README.md#configuration)). Locally `harness/repro/up.sh` starts it on port 8118 (`harness/repro/ports.env`) with `PORT=8118` and `PG_USER=timesheets_app` set inline; standalone, `PORT=8118 OPT2_SERVICE_NAME=timesheets … npm start` with the rest of that schema. `OPT2_SERVICE_URLS` must contain `identity` (CSRF checks) and `reporting` (export scope checks).
- **Test dependencies.** The PostgreSQL-backed suites read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, create a throwaway schema and roles through `@opt2/platform/testing`, and are skipped when PostgreSQL is unreachable. The isolation and event suites also read `PUBSUB_EMULATOR_HOST`.
- **Cloud.** Cloud Run image from `Dockerfile`, with `min_instance_count = 0`, internal-only ingress and Cloud SQL IAM authentication as a member of `timesheets_app` (`infra/terraform/`, plan only).

## Parity evidence

The GS-TS scenarios in `harness/golden/catalogue.yaml` are captured from the fixture and replayed through the gateway:

| Scenario | Covers |
|---|---|
| GS-TS-01 | Day submit |
| GS-TS-02 | Primary then secondary approval |
| GS-TS-03 | Return and resubmit by the primary and the secondary approver |
| GS-TS-04 | Partially approved and overdue sheets as of a date |
| GS-TS-05 | Sheet status for each precedence state |
| GS-TS-06 | Illegal day actions: blackout day, wrong role and illegal state |

Seam 1 is proven by people's GS-PE-03 and GS-PE-RH-03, which compare the blackout rows once the seam has drained. Each behaviour's code and test are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
