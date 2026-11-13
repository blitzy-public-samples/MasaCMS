**SYNTHETIC MODULE**

# finance

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Finance has no Masa equivalent: it is a synthetic module whose legacy oracle is the finance fixture in [`legacy-fixtures/`](../../legacy-fixtures/README.md) (`legacy-fixtures/cfml/modules/finance.cfc` and `legacy-fixtures/sql/finance/`), and the outputs captured from that fixture are its parity tests.

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md). Shared components: [`platform/README.md`](../../platform/README.md).

## What it does

- **Records.** A preparer creates a finance record (title, amount, period) for a site. It starts `IN-PROGRESS` at version 1.
- **Approval.** The preparer submits it; an approver approves or rejects it; after a rejection the preparer may edit and resubmit it. An approved record is final.
- **Versions.** Every create, edit and transition is kept as a version row, so the full history of a record can be read back.
- **Attachments.** Preparers attach files to a record. Preparers and approvers list and download them; each file is stored with its SHA-256.
- **Rollups.** Record count and total amount per period and state, rebuilt after every create, edit and transition, as `usp_finance_rollup` rebuilds them.

## Lifecycle

| From | Action (role) | To |
|---|---|---|
| IN-PROGRESS | submit (`finance.preparer`) | SUBMITTED |
| SUBMITTED | approve (`finance.approver`) | APPROVED |
| SUBMITTED | reject (`finance.approver`) | REJECTED |
| REJECTED | resubmit (`finance.preparer`) | RE-SUBMITTED |
| RE-SUBMITTED | approve / reject (`finance.approver`) | APPROVED / REJECTED |
| IN-PROGRESS, REJECTED | edit (`finance.preparer`) | same state, new version |
| APPROVED | — | terminal |

- **One definition.** [`src/domain/lifecycle.transitions.ts`](src/domain/lifecycle.transitions.ts) is the only place the transitions are written.
- **Generated table.** `npm run export-transitions` expands every state × action × role into `test/generated/transition-table.json` and [`opt2/reports/state-machines/finance.json`](../../opt2/reports/state-machines/finance.json): 50 rows, 8 legal. `legacy-fixtures/load-fixtures.sh` loads the same rows into `synthetic.finance_transition`, which the fixture procedures enforce, so the oracle and the service apply one table.
- **Outcomes.** Legal: 2xx and the new state. Illegal state: 409 `illegalTransition`. Wrong role: 403.

## Legacy oracle

| Piece | Where |
|---|---|
| Endpoints | `legacy-fixtures/cfml/modules/finance.cfc`, reached as `/legacy-fixtures/cfml/api.cfm/finance/<resource>[/<id>][/<action>]` |
| Tables | `sql/finance/110_tables.program.sql`: `Program_N.finance_record`, `finance_record_version`, `finance_attachment` (`varbinary(max)`), `finance_rollup`; `sql/finance/100_finance_transition.sql`: `synthetic.finance_transition` |
| Procedures | `sql/finance/200_procedures.program.sql`: `usp_finance_create`, `usp_finance_transition`, `usp_finance_rollup`, reimplemented in `src/domain/records.ts` and `src/domain/rollup.ts` |
| Seed | `sql/finance/300_seed.program.sql` (`usp_seed_finance`), loaded by `legacy-fixtures/cfml/seed.cfm` from the fixed-seed dataset |

## Owned data

Schema `finance`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with the roles `finance_owner` (owns every object; FORCE RLS applies to it), `finance_app` (runtime DML; the service's `PG_USER`) and `finance_migrator` (applies `db/migrations/*.sql` after `SET ROLE finance_owner`).

[`opt2/table-ownership.json`](../../opt2/table-ownership.json) is authoritative (rule step 1). Each fixture table exists once per program schema and folds into one tenant-column table; `tenant_id` comes from `synthetic.program_site` (program 1 → `tenant-a`, program 2 → `tenant-b`) and `legacy_program_id` keeps the source schema for reconciliation:

| Legacy table | Target table | Notes |
|---|---|---|
| `[Program_1\|Program_2].finance_record` | `finance.record` | Current state and version |
| `[Program_1\|Program_2].finance_record_version` | `finance.record_version` | One row per create, edit and transition, written in the same transaction |
| `[Program_1\|Program_2].finance_attachment` | `finance.attachment` | Metadata and `sha256`; the bytes become objects |
| `[Program_1\|Program_2].finance_rollup` | `finance.rollup` | Keyed by program, period and state |

- **Service-only tables.** `finance.program_binding` (the program each tenant was folded from) and `finance.staged_object` (attachment objects stored before their row commits, or replaced since, until they are collected).
- **Platform tables.** `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `inbox`, `consumer_aggregate_version`.
- **Isolation.** Every tenant-owned table carries `tenant_id uuid NOT NULL` with row-level security enabled and forced under `tenant_isolation` on `app.tenant_id`.
- **Attachment bytes.** Cloud Storage bucket `finance-attachments`, key `<tenantId>/<id>.<ext>`; locally `${OPT2_STATE_DIR}/storage/finance-attachments/`.
- **Money.** `numeric(19,4)`, serialised as a string with four decimals, as the fixture does.

## Routes

Deny by default: every route declares its roles (`config.opt2.requires`) or `config.opt2.public`, and an undeclared route fails start-up. The finance roles come from the fixture-seeded Masa groups in `services/identity/config/role-map.json`. Writes have identity consume the CSRF token first (`POST /internal/v1/csrf/consume`), as the fixture's writes do.

### Fixture routes

Served under `/legacy-fixtures/cfml/api.cfm/finance` in the Masa envelope. The gateway routes them `legacy` in `v0001` and `target` from `v0002` (groups `grp:finance.record`, `grp:finance.attachment`).

| Method | Path | Requires |
|---|---|---|
| `GET`, `POST` | `/records` | read: preparer or approver; create: preparer |
| `GET` | `/records/{id}` | preparer or approver |
| `POST` | `/records/{id}/{submit\|approve\|reject\|resubmit\|edit}` | preparer or approver; the transition table decides |
| `GET` | `/records/{id}/versions` | preparer or approver |
| `GET`, `POST` | `/records/{id}/attachments` | list: preparer or approver; upload: preparer |
| `GET` | `/records/{id}/attachments/{aid}` | preparer or approver; the file as a byte stream |
| `GET` | `/rollups` | preparer or approver |

### OPT-2 screens

`/v1/finance/**` serves the screens at `/opt2/admin/finance/*` that `web/` renders: record list (also readable by `reporting.exporter`), record detail with versions, transition actions (`/v1/finance/records/{id}/transitions/{action}`), attachments, download URLs signed for 15 minutes (`…/attachments/{aid}/download-url`) and rollups. `/v2/finance/**` adds paged reads of record detail, versions, attachments and rollups.

### Internal and managed routes

| Method | Path | Requires | Does |
|---|---|---|---|
| `GET` | `/internal/v1/finance/records` | `service:reporting` | One page of records for a running export job, once reporting confirms the job's scope |
| `POST` | `/internal/v1/events/finance.programs-sites.site.changed.v1` | `service:pubsub-invoker` (local push key locally) | Push delivery into `finance.tenant_registry` |
| `GET`, `POST` | `/internal/v1/migration/{apply,export,changes,position,watermark,gate,objects}` | `platform.migration` | Backfill, feed, reconciliation, unit gates and attachment bytes for the reverse projection |
| `GET` | `/opt2/files/finance-attachments/{tenantId}/{objectName}` | public; the signature is the credential | Local storage adapter downloads |
| `GET` | `/healthz` | public | Liveness probe |

## Events

- **Consumes** `programs-sites.site.changed.v1` into `finance.tenant_registry`, which resolves site ids and pools to tenants.
- **Produces** no topic, so it has no outbox, outbox sweep or task queue.

## Run and test

```sh
npm ci                               # postinstall builds ../../platform
npm run build                        # contract types into src/generated/, then tsc into dist/
npm start                            # node dist/main.js
npm test                             # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
npm run export-transitions           # regenerate the transition table and its export
npm run export-transitions -- --check
```

- **Configuration.** `baseEnvSchema` of `@opt2/platform/service-kit` ([details](../../platform/README.md#configuration)). Locally `harness/repro/up.sh` starts it on port 8119 (`harness/repro/ports.env`) with `PG_USER=finance_app`. `OPT2_SERVICE_URLS` must contain `identity` (CSRF checks) and `reporting` (export scope checks).
- **Test dependencies.** The security and contract suites need nothing external. The PostgreSQL-backed suites under `test/unit` and `test/events` read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, create a throwaway schema and roles through `@opt2/platform/testing`, and are skipped when PostgreSQL is unreachable. `test/events` is also skipped when `PG_HOST` is unset, and needs no Pub/Sub emulator: it injects push deliveries in process and captures publishes in memory.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress and Cloud SQL IAM authentication as a member of `finance_app` (`infra/terraform/`, plan only).

## Parity evidence

The GS-FI scenarios in `harness/golden/catalogue.yaml` are captured from the fixture and replayed through the gateway:

| Scenario | Covers |
|---|---|
| GS-FI-01 | Every legal transition |
| GS-FI-02 | Illegal transitions and wrong role |
| GS-FI-03 | Edits create versions |
| GS-FI-04 | Attachment upload and download |
| GS-FI-05 | Rollup totals |

Each behaviour's code and test are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
