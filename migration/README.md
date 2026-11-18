# OPT-2 migration orchestrator and service
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The migration package moves data between the legacy Masa SQL Server database and the PostgreSQL schemas of the ten services while the gateway moves routes one cut-over version at a time. It ships three CLIs (`opt2-migrate`, `opt2-db`, `opt2-ops`) and the always-on migration service, all from one image.

## Purpose

| Job | How |
|---|---|
| Move legacy data | Copy-only snapshots of the legacy database, backfilled and then fed as diffs to each owner's `/internal/v1/migration/apply` (AAP 0.8.1, 0.8.2) |
| Prove zero difference | Reconciliation at every point: row count, SHA-256, field differences and file-object manifest, tolerance zero (AAP 0.8.4) |
| Keep one writer per unit | Unit leases and owner gates for cut-over transitions, and write windows around legacy-served and withheld writers (AAP 0.5.4) |
| Keep legacy readers current | Reverse projection of the owners' changelogs into the live legacy tables, and the read-after-write barrier (AAP 0.8.3) |
| Hand over schedulers and files | The native `siteMonitor` and fixture survey tasks, and the legacy file store into `content-files` |

## Runtime forms

### `opt2-migrate` (`src/cli.ts`)

Run as `node migration/dist/cli.js <command>` or through the `opt2-migrate` bin. Every command except `serve` prints one JSON summary line on stdout. Exit codes: 0 success, 1 failure or reconciliation difference, 2 usage error. `MURA_DBPASSWORD`, `OPT2_BRIDGE_HMAC_KEY`, `PG_PASSWORD`, URL queries and userinfo, credentials and email addresses are redacted from all output. A malformed `--params` or `--scope` is reported as not valid JSON, never echoed. A failed command prints `{"command","ok":false,"error":{"type","message",…,"causes"}}` and nothing else of the error: its class; the safe message of `@opt2/platform/logging` (`[REDACTED]` unless it is a fixed text such as `read ECONNRESET` or a SQLSTATE; a `FaultUsageError` or `ReconcileUsageError` keeps its own text); the identifier-shaped properties `code`, `number`, `status`, `database`, `table`, `unit`, `owner`, `operation`, `op`, `method`, `step` and `schema`; and up to eight causes (`cause`, or node-mssql's `originalError`), each with its class, safe message and identifiers. A returned result, an aborted transition or failed fault included, keeps its fields but carries error payloads only as safe metadata: every `error`, key ending in `Error`, `failedAfterRestart` and `stderrTail`, at any depth, is reduced to the safe message of its text, or of an object's `message` beside that object's number, boolean and identifier fields. stderr carries `log-record.v1` lines, the failure and then one `caused by` line per cause, each with the error's class, safe message and stack frames and its identifiers in the message. `serve` prints no summary line: a start-up failure is one `log-record.v1` `start-up failed` line on stdout. `<command> --help` prints that command's usage.

| Command | Does |
|---|---|
| `serve` | Starts the migration service |
| `init-legacy` | Creates schema `opt2_sync` and `opt2_sync.projector_checkpoint` in the legacy database from [`sql/005_opt2_sync.sql`](sql/005_opt2_sync.sql) |
| `snapshot --kind <seed\|workload\|transition\|rebaseline\|checkpoint\|feed>` | Takes the next snapshot at a quiesced point, with its file manifest |
| `snapshot restore --seq <n>` | Resets the live legacy database from snapshot `n`'s backup; ColdFusion must be stopped |
| `snapshot drop --seq <n>` | Drops snapshot `n`'s database, backup and manifest rows; the `migration.snapshot` row stays |
| `backfill --snapshot <n>` | Loads snapshot `n` into the owners in dependency order, transfers its files, reconciles `after-backfill` |
| `feed [--snapshot <n>]` | Takes a feed snapshot (or resumes on `n`), applies each table's changes since its watermark, reconciles `after-feed-<n>` |
| `transition --to <vNNNN> [--poll-ms <ms>]` | Asks the service for the transition to a cut-over version and waits, reading it every `--poll-ms` (1–2147483647, default 1000); exit 1 unless it completes |
| `reconcile --point <name> [--units <unit,...>]` | Reconciles at a named point and writes its report |
| `rollback-set` | Computes the people-roster group set `R` and checks it against `v0003` |
| `rollback rebaseline` | Restarts the forward feed for `R`'s units from a fresh `rebaseline` snapshot |
| `rollback report` | Writes `rollback-rehearsal.md` |
| `fault <name> [--params <json>]` | Runs one scripted fault end to end: fault, resume, reconcile |
| `resolve-window <windowId>` | Imports and closes an `import-pending` window after operator review |
| `window open --units <unit,...> [--route <key>] [--scope <table\|json>]` | Opens a write window as `platform.operator` |
| `window complete <windowId> [--forwarded]` | Reports the legacy outcome of an operator window and closes it; exit 1 for an id that names no window (`state` `unknown`) |
| `window report` | Writes `windows.json` from `migration.write_window`, keeping the entries of windows the table no longer holds |
| `scheduler import --file <path>` | Loads the captured native tasks and `ping` (`${OPT2_PRISTINE_DIR}/native-tasks.json`) into `migration.scheduler_state` |
| `scheduler status` | Prints the stored scheduler state beside the live ColdFusion tasks |
| `files manifest --snapshot <n>` | Lists the legacy file store through the bridge into `migration.file_manifest` |
| `files transfer --snapshot <n>` | Moves the manifest's objects to strategies-content |

`transition`, `resolve-window`, `window open` and `window complete` are clients of the running service, as is `fault` for the service's in-process hooks.

### `opt2-db` (`src/db-bootstrap/cli.ts`) and `opt2-ops` (`src/quiesce/cli.ts`)

| Command | Does |
|---|---|
| `opt2-db bootstrap --target local` | Drops and recreates every OPT-2 schema with its `<svc>_owner`, `<svc>_app` and `<svc>_migrator` roles, then applies each package's `db/migrations` as `<svc>_migrator` after `SET ROLE <svc>_owner`; role passwords from `${OPT2_STATE_DIR}/secrets/db-<schema>-{app,migrator}` |
| `opt2-db bootstrap --target cloud` | The same against Cloud SQL, as the built-in `postgres` user plus IAM users; refuses schemas that already hold tables (AAP 0.4.6) |
| `opt2-db teardown --target local` | Drops every OPT-2 schema with its objects and its three roles from `${PG_HOST}`/`${PG_DATABASE}` as `${PG_USER}`, through the bootstrap's local reset; repeatable, reads no password file. `down.sh` runs it. There is no cloud teardown: the cloud bootstrap is declared but never executed |
| `opt2-ops drain-and-suspend` | Waits for outboxes and consumers to drain, pauses ACF and local tasks and the recurring sweeps, switches push subscriptions to pull, records what it paused |
| `opt2-ops resume` | Undoes `drain-and-suspend` from its record and runs the recurring-task reconcile |
| `opt2-ops seek-subscriptions --to <ISO-8601 time>` | Seeks every OPT-2 consumer subscription to the checkpoint time and verifies none holds a message |

Both print one JSON summary line; exit 0, 1 or 2 as above (`opt2-db` also exits 1 on a role-assertion finding). A usage error prints its message and the usage on stderr. A failure prints `{"command",…,"ok":false,"error":{"type","message",…,"causes"}}` (`opt2-db` adds `"target"`), redacted and built as for `opt2-migrate`: the class, the safe message of `@opt2/platform/logging`, the identifier-shaped properties and up to eight causes, never the raw message or stack. `opt2-ops` adds its failure's fields `timeoutMs`, `owners`, `queues`, `rows`, `nonEmpty`, `subscriptions`, `failed`, `operation`, `status` and `owner`, each nested `error` text reduced to its safe message. `opt2-db` adds a failed migration's `file`, `sqlState`, `line` and `position`, and the `schemas` a cloud bootstrap refused. stderr carries `log-record.v1` lines, the failure and then one `caused by` line per cause, as service `OPT2_SERVICE_NAME` or `opt2-ops` for `opt2-ops` and as `db-bootstrap` for `opt2-db`. A failed final trace export of `opt2-ops` is a `WARNING` line.

### Service (`src/server.ts`)

- `opt2-migrate serve` (the `Dockerfile` command); locally port 8102 (`OPT2_PORT_MIGRATION` in `harness/repro/ports.env`).
- Cloud Run `min_instance_count = 1`, the only service that never scales to zero, because the projector and write windows must run while any unit is `target`-authoritative. CPU stays allocated (`cpu_idle = false`); every other service is request-billed (`cpu_idle = true`).
- Background work, started once the app is ready:

| Loop | Interval | Gated by `opt2-ops` suspension |
|---|---|---|
| Reverse projector | Continuous: at once after a backlog and when an await starts, `projection.idlePollMs` 250 ms after an active cycle and while an await waits, backing off by doubling to `projection.idleMaxPollMs` 5000 ms while idle; each stream reads at most `projection.streamPagesPerCycle` (1) pages per cycle and leaves the rest as backlog | No: legacy-bound reads wait on the barrier it advances |
| Window recovery and transition resume | Once at start-up | No |
| Window import retries | `windows.importRetryMs` 5 s | Yes |
| Legacy bridge poll (`scheduler.cfm?op=describe`) | `background.bridgePollMs` 60 s | Yes; a request inside the Masa application, so ColdFusion never reaches its three-day idle expiry |
| Recurring-task reconcile (`ensureRecurring` for every outbox sweep, and `programs-sites-sitemonitor` once handed off) | `background.tasksReconcileMs` 5 min | Yes |

### Cloud Run job `db-bootstrap`

Same image, `node dist/db-bootstrap/cli.js bootstrap --target cloud`. Declared in `infra/terraform/envs/plan/main.tf` and never executed in this run.

## Data reach

| Store | Access |
|---|---|
| Schema `migration` | Read and write through role `migration_app`; never another PostgreSQL schema |
| Target data | Only through each owner's `/internal/v1/migration/{apply,export,changes,position,watermark,gate}` and `/internal/v1/migration/objects` |
| Legacy SQL Server (`MURA_DB*`) | Snapshot databases read-only. Live database read; written only by reverse projection of `target`-authoritative units, `init-legacy` and the test-sequence restore |
| Legacy file store | Only through `gateway/legacy-bridge/cfml/files.cfm` |
| Gateway | Cut-over activate, freeze, unfreeze, status (v1, and v2 for orphans) and in-flight orphan clearing over HTTP |

SQL Server is the only supported source: `MURA_DBTYPE` naming anything else (the setup's MySQL fallback, recorded by `harness/src/baseline/environment.ts`) fails start-up with `UnsupportedLegacyDatabaseError`, so the migration stages stop.

## Schema `migration`

DDL in [`db/migrations/0001_migration.sql`](db/migrations/0001_migration.sql) and [`db/migrations/0002_projector_quarantine.sql`](db/migrations/0002_projector_quarantine.sql); roles `migration_owner`, `migration_app`, `migration_migrator`.

| Table | Holds |
|---|---|
| `snapshot` | Sequence, snapshot database, backup file, checkpoint LSN, kind, state, manifest completeness, `source_sha` |
| `transition` | One row per transition: versions, step 1–8, units `T`, frozen routes, paused work, closed gates, reconciliation; at most one active |
| `write_window` | Route key, units, scope, kind (`request`, `legacy-step`, `startup`, `reload`), state, phase history, rows imported, outcome |
| `unit_lease` | One holder per unit, kind `window` or `transition` |
| `projector_cursor` | Reporting mirror of the projector cursor and applied horizon per owner and tenant. The authoritative checkpoint is `opt2_sync.projector_checkpoint` in SQL Server, committed with each batch |
| `projector_quarantine` | Changes the projector could not write into legacy (a SQL Server data error or a missing legacy row), and the other changes of their operation, each recorded before its batch commits without it: owner, tenant, changelog `xid`/`seq`, legacy table, op, legacy key, reason, batch. `repaired_at`, `repaired_xid` and `repaired_seq` are set once a later change of the same keyed row is written |
| `scheduler_state` | Keys `sitemonitor`, `nativeTasks`, `surveyTasks` and `background` (the `opt2-ops` record) |
| `file_manifest` | Per snapshot and site: path, `fileID`, variant, extension, size, SHA-256, orphan flag, object key, transfer time |

## Flows

### Snapshot (`src/snapshot/`)

- `BACKUP DATABASE … WITH COPY_ONLY, CHECKSUM` to `${OPT2_STATE_DIR}/snapshots/snap-<n>.bak`, restored beside the live database as `<db>_opt2_snap_<n>` and set `READ_ONLY`. SQL Server Express has no database snapshots or CDC.
- The checkpoint LSN is read from `msdb.dbo.backupset`. Snapshots are taken only at quiesced points, and the file manifest is taken at the same point.

### Backfill (`src/apply/backfill.ts`, `src/order/`, `src/extract/`)

- Tables load in the dependency order computed from the inventory's code relations (Masa declares no foreign keys), written to `migration-order.json`.
- Canonical rows ordered by key; fixture `Program_<id>` tables fold into one stream with `legacy_program_id`.
- 1,000 rows per tenant per batch to the owner's `apply`, each with a deterministic `batchId`, so a repeated batch is a no-op. Split tables (`tusers`, `tclassextend*`, `ttrash`) go to every owner, which takes its own rows and columns.
- `tenant_id = tenantIdForSite(siteID)`; pooled rows carry the umbrella tenant, child rows inherit their parent's, and rows with no resolvable parent load under the umbrella tenant and are reported as orphans.
- Owners emit only `state` events for migration applies, never `process` events.

### Change feed (`src/apply/feed.ts`, `src/diff/`)

- A new feed snapshot is diffed per table against the snapshot of the owners' watermark: keyed merge-join with column-scoped updates, keyless tables as multisets of whole-row encodings, file manifests by path and SHA-256.
- Only columns of `legacy`-authoritative units are applied. Each owner writes `migration_watermark` in the transaction of its last batch for the table; the next run starts from it.

### Transition (`src/transition/`)

`opt2-migrate transition --to <vNNNN>` is the only way a version after `v0001` becomes active. One row in `migration.transition`, resumable after a restart:

| Step | Name | Does |
|---|---|---|
| 1 | `transition-set` | Derives the units `T` whose authority changes and the affected entries; leases `T` as holder kind `transition` |
| 2 | `stop-new-work` | Pauses the native and survey tasks and the owners' queues that write `T` (outbox sweeps excepted); freezes the entries and waits for every gateway instance's epoch |
| 3 | `confirm-inflight-finished` | Waits for `gateway.inflight` to hold none of them but orphans (the instance is dead, or abandoned the exchange); orphaned legacy-bound rows are cleared only by a controlled restart (`OPT2_LEGACY_RESTART_CMD`), otherwise the transition aborts naming the orphan, and orphaned target-bound rows pass to step 5; waits for fixture `cfthread` exports (10 min bound) |
| 4 | `drain-effects` | Runs the outbox sweeps and waits until every published event for `T` has an inbox receipt, or a dead letter for a `state` event, with the gates still open; a dead-lettered `process` event aborts the step, and an owner that does not answer is asked again until `transition.drainTimeoutMs` |
| 5 | `close-gates` | Closes `T`'s gates at their owners with the transition as holder, then clears step 3's target-bound orphans with that `gates-closed` evidence |
| 6 | `final-state-and-reconcile` | Final snapshot and diff for units moving to `target`; projector to every owner's write position for units moving to `legacy`; reconciles `T` to zero or aborts |
| 7 | `activate` | Activates the version once and waits for every gateway instance's epoch |
| 8 | `hand-off-and-reopen` | Hands off schedulers, sets gates `open` or `legacy`, releases leases, unfreezes, resumes queues and tasks, reconciles recurring tasks |

An abort before step 7 reopens what it closed and leaves the active version unchanged. A transition that would make units `target`-authoritative is refused while the legacy database lacks `opt2_sync.projector_checkpoint` (run `init-legacy` first). One that would make a content unit `target`-authoritative is also refused (`cluster-unsafe`) unless `${OPT2_STATE_DIR}/baseline/environment.json` records `settings.cluster.clusterSafe: true` and the live `tclustercommands` is empty; a missing record refuses too (run `harness/src/baseline/environment.ts --phase services`).

Orphan classification (the in-flight waits of step 3, reload windows and `opt2-ops drain-and-suspend`) reads the gateway's `cutoverStatusV2`; a gateway without it (404, or legacy's redirect of the path) falls back to `cutoverStatus`, where the rows of instances not live are the orphans.

### Reverse projection and the read-after-write barrier (`src/reverse/`)

- For each owner and tenant, reads `/internal/v1/migration/changes?after=<cursor>` below the owner's commit-safe horizon. Rows with origin `legacy-window`, `migration-feed` or `backfill` are passed over; rows of an open multi-participant operation (the roster write protocol) are held until every participant's rows are read, then applied together.
- Each batch is one SQL Server transaction that also upserts `opt2_sync.projector_checkpoint`, so a crash never re-applies a committed batch. Split tables update only `target`-authoritative columns; keyless tables delete exactly one row matching the before-image.
- A change legacy cannot take (a SQL Server data error such as truncation, NULL, conversion, overflow, duplicate key or constraint, or no legacy row for an update or keyless delete) is recorded in `migration.projector_quarantine`, logged, and left out of its batch, which then commits with the rest and the checkpoint; any other failure stops the stream at its checkpoint. Every other change of the batch that belongs to the same operation is recorded and left out with it, so legacy never holds part of an operation.
- A later change of a quarantined keyed row replays it: an update writes its whole after-image, inserting the row when legacy has none. Once the batch commits, the earlier records of that row are marked repaired and one INFO line names them. A crash between the commit and the marking leaves them unrepaired. Keyless rows are never repaired.
- After batches touching `tsettings` or content, the projector calls `site.cfm?op=refresh` and `jobs.cfm?job=purgeCache`. `content.file_object` changes go to the legacy store through `files.cfm?op=put|delete`; finance attachments go back into `Program_<id>.finance_attachment`.
- `projectionAwait` answers once every listed `<owner>=<xid>` position is below that owner's applied horizon, or 503 after `timeoutMs` (default 5 s). It answers 503 at once when a listed position has an unrepaired quarantine record (`ProjectionQuarantinedError`). Owners' current positions and positions without such a record are awaited as before.

### Reconciliation (`src/reconcile/`)

- Compares legacy (live database or snapshot) with each owner's `export`, per unit and tenant: row count, SHA-256 over canonical encodings in key order, field-by-field differences, and for file units the object manifest (one object per legacy file, equal size and SHA-256). Any difference exits 1.
- Keyless tables compare as multisets of encodings with counts.
- Points: `after-backfill`, `after-feed-<n>`, `after-fault-<fault>`, `checkpoint`, `post-cutover`, `rollback-before`, `rollback-after`.

### Write windows and unit leases (`src/windows/`)

| Phase | What happens |
|---|---|
| Open | Lease the units in sorted order in one transaction, close the owners' gates by compare-and-set with phase `quiet`, wait until the projector has applied each owner's current position. Over 30 s or an owner down: undo, and the gateway answers 503 before legacy runs |
| `executing` | The gateway forwards the request to legacy and buffers the response |
| `importing` | Legacy tables within the writers' `scope` are diffed against the owners' exports and applied with origin `legacy-window` |
| Close | Gates reopened by compare-and-set on the holder, leases released |
| `import-pending` | A failed import keeps the gates closed (reads and writes wait or answer 503) and retries every 5 s |

Elapsed time alone never imports or reopens a window whose gateway lease (120 s) expires: while a live gateway instance still holds the request, the lease is extended. A later completion of the window, a controlled legacy restart run through `OPT2_LEGACY_RESTART_CMD` under the window's holder, or `opt2-migrate resolve-window <id>` is the evidence that the request can no longer commit; the window then imports and closes. Without a restart command, as in the cloud, or when the restart fails, it stays `import-pending` until a completion or `resolve-window`. Windows on disjoint units run concurrently; overlapping windows and transitions serialise at lease acquisition. Every window is logged to `windows.json`. Site-monitor steps on legacy run through the same windows (`legacyStepRun`).

### Start-up guard (`src/legacy/startup-guard.ts`, `src/windows/reload.ts`)

Masa's start-up rewrites `tcontent` rows of type `File` or `Link` that are active with `body` null and `filename` set (`core/appcfc/onApplicationStart_include.cfm:892-929`). Every projector batch and window import touching `tcontent` is checked against that predicate before commit. If a row would match, the guard freezes every legacy-bound entry, commits, runs reload windows (`?<appreloadkey>`) until no row matches, then unfreezes.

### Scheduler hand-off (`src/scheduler/`)

- `scheduler import` loads the capture taken before ColdFusion first restarted with `MURA_PING=false`.
- In the transition that makes `/_api/sitemonitor` `target`: the native task is paused before the freeze and deleted after activation, programs-sites receives `application.lastMonitored` as its cursor, and its recurring trigger is enabled only if a native task existed.
- Fixture `opt2-survey-*` tasks are paused, adopted by communications (`/internal/v1/migration/adopt-scheduled-tasks`) and then deleted. A transition back to `legacy` reverses each step through `scheduler.cfm?op=restore` and `jobs.cfm?job=setCursor`.

### File-store transfer (`src/files/`)

- `files.cfm?op=list` per site records every file whose name starts with a `fileID`, so variants (`_source`, `_small`, `_medium`, as `core/mura/content/file/fileDAO.cfc:153-199` writes them) are found, not assumed. Files without a `tfiles` row are kept and flagged as orphans. A listed name whose 35-character id is no CF UUID is no `fileID`; the build lists it under `skipped` with its reason.
- `tfiles` owners and content types are read per batch of file ids, never as a whole table.
- Each object is streamed from `op=get` into a temporary file, checked against its SHA-256 and streamed from that file to strategies-content `POST /internal/v1/migration/objects`, which stores it as `<tenant>/<fileID><variant>.<ext>` in `content-files`; the same hash again is a no-op. The migration service holds no whole object in memory and one object at a time on disk. An object the owner refuses (a 4xx other than 401 or 403) is listed under the transfer's `rejected` and the transfer goes on; reconciliation reports the missing object.
- The feed streams the two manifests' diff twice: first to transfer added and changed copies, then to delete the objects of dropped copies that the new snapshot no longer plans.
- A live store other than `fileDir` is not moved: `/_api/render` stays legacy.

### Fault injection (`src/faults/`)

`opt2-migrate fault <name>` runs the fault, resumes and reconciles into `after-fault-<name>.json`; `projector-delay` is a toggle with no reconciliation point. The service's in-process hooks are armed through `faultSet`/`faultClear`.

| Fault | Injects |
|---|---|
| `applier-killed-mid-batch` | A backfill or feed child exits during, or right after, an apply |
| `duplicate-batch` | One applied batch resent under its `batchId` |
| `mssql-dropped-mid-extract` | SQL Server connection lost while streaming; the rerun resumes from watermarks |
| `service-restarted-mid-apply` | An owner restarted while receiving batches |
| `pubsub-redelivery` | State-event outbox rows republished with their original `eventId` |
| `window-import-interrupted` | A window import failed after legacy committed |
| `projector-delay` | Sleep once per projector cycle before its first batch (default 3 s; used by GS-BR-01) |
| `forced-reinit` | A `tcontent` row matching the start-up predicate, converted by the guard |

### People-roster rollback (`src/rollback/`)

The procedure is [`runbooks/people-roster-rollback.md`](runbooks/people-roster-rollback.md): `rollback-set`, then `transition --to v0003`, then `rollback rebaseline`, the rehearsal and `rollback report`.

## Internal API

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). Every operation except `healthz` requires an invocation credential carrying one of the listed roles.

| Operation | Path | Callers |
|---|---|---|
| `healthz` | `GET /healthz` | Public |
| `windowOpen` | `POST /internal/v1/windows` | Gateway (`service:gateway`), operators |
| `windowGet` | `GET /internal/v1/windows/{windowId}` | Gateway, operators |
| `windowComplete` | `POST /internal/v1/windows/{windowId}:complete` | Gateway, operators |
| `windowResolve` | `POST /internal/v1/windows/{windowId}:resolve` | Operators (`opt2-migrate resolve-window`) |
| `projectionAwait` | `POST /internal/v1/projection/await` | Gateway |
| `unitAuthority` | `GET /internal/v1/authority` | Programs-sites site-monitor orchestrator, gateway, operators |
| `legacyStepRun` | `POST /internal/v1/legacy-steps` | Programs-sites site-monitor orchestrator, for steps that run on legacy; windowed when they write `target`-authoritative units |
| `gatesList` | `GET /internal/v1/gates`, optionally paged with `limit` and `cursor` | Operators |
| `transitionStart`, `transitionGet` | `POST /internal/v1/transitions`, `GET /internal/v1/transitions/{transitionId}` | Operators (`opt2-migrate transition`) |
| `schedulerStateGet`, `schedulerStateImport` | `GET /internal/v1/scheduler/state`, `POST /internal/v1/scheduler/state:import` | Operators |
| `backgroundSuspend`, `backgroundResume` | `POST /internal/v1/background:suspend`, `POST /internal/v1/background:resume` | Operators (`opt2-ops`) |
| `faultSet`, `faultClear` | `PUT`, `DELETE /internal/v1/faults/{name}` | Operators (`opt2-migrate fault`) |

"Operators" means `platform.operator`.

## Outputs

Written under `OPT2_REPORTS_DIR` (default `opt2/reports/`); each carries `sourceSha` from `opt2/source-pin.json`.

| File | Written by |
|---|---|
| `reconciliation/{after-backfill,after-feed-<n>,after-fault-<fault>,checkpoint,post-cutover,rollback-before,rollback-after}.json` | `reconcile`, `backfill`, `feed`, `fault`, transitions |
| `reconciliation/summary.md` | Regenerated with every reconciliation report |
| `windows.json` | Every write window: route, units, scope, phases with timestamps, rows imported, outcome. Written from `migration.write_window` by `window report` and when the service stops |
| `transitions.json` | Every transition: versions, `setT`, steps, outcome |
| `migration-order.json` | The dependency order, from `backfill` and `feed` |
| `rollback-rehearsal.md` | `rollback report` |

State files (snapshot backups, manifests, tars, the rebaseline record) go to `${OPT2_STATE_DIR}`, never the checkout.

## Environment

Read by the service, `opt2-migrate` and `opt2-ops`, whose `--help` lists every variable with its requiredness or default. `@opt2/platform/service-kit` `baseEnvSchema` (see [`platform/README.md`](../platform/README.md#configuration)) plus:

| Variable | Use |
|---|---|
| `MURA_DBHOST`, `MURA_DBPORT` (default 1433), `MURA_DATABASE`, `MURA_DBUSERNAME`, `MURA_DBPASSWORD` | Legacy SQL Server, as Masa's datasource |
| `MURA_DBTYPE` | Optional; must be unset or name SQL Server |
| `OPT2_MSSQL_TRUST_SERVER_CERT` | `true` or `false`; `true` is rejected when `OPT2_ENV=cloud` (default: `true` when `OPT2_ENV=local`, `false` in the cloud). In the cloud the legacy SQL Server certificate must chain to a CA Node trusts (a private CA through `NODE_EXTRA_CA_CERTS`) and name `MURA_DBHOST` |
| `LEGACY_ORIGIN` | Masa origin for bridge calls and reloads; locally `http://127.0.0.1:${PORT}` of ColdFusion |
| `MURA_APPRELOADKEY` | Masa's reload parameter name, when set; default `appreload` |
| `OPT2_BRIDGE_HMAC_KEY` | Bridge assertion key; locally from `${OPT2_STATE_DIR}/secrets/`, in the cloud the secret `legacy-bridge-hmac` |
| `OPT2_LEGACY_RESTART_CMD` | Controlled ColdFusion restart; locally `harness/repro/lib/legacy-start.sh`, whose no-argument form restarts. Absent in the cloud, so orphaned legacy writes need `opt2-migrate resolve-window <id>` |
| `OPT2_REPORTS_DIR` | Absolute reports directory; default `<repo>/opt2/reports` |
| `OPT2_PRISTINE_DIR` | Absolute pristine-baseline directory (`native-tasks.json`); default `~/.opt2/pristine` |
| `OPT2_CUTOVER_DIR` | Absolute cut-over directory (`versions/`, `groups.json`), the one the gateway reads; default `cutoverDir` of `config/migration.config.json` (`gateway/cutover`) |

- With `OPT2_ENV=local`, `GOOGLE_CLOUD_PROJECT` and `PUBSUB_EMULATOR_HOST` are required.
- The service, `opt2-migrate` and `opt2-ops` use schema `migration` as `migration_app`: locally `PG_USER=migration_app` with the password the bootstrap set from `${OPT2_STATE_DIR}/secrets/db-migration-app`, in the cloud (`OPT2_DB_AUTH=iam`) the migration service account's IAM database user, a member of `migration_app`. They never connect as the bootstrap administrator below. `opt2-db` reads only the variables of [Bootstrap environment](#bootstrap-environment).
- Static settings (batch sizes, waits, start-up predicate, file-store naming, faults, reconciliation points, rollback set, owners) are in [`config/migration.config.json`](config/migration.config.json).

### Bootstrap environment

`opt2-db bootstrap` (`src/db-bootstrap/env.ts`) connects as a database administrator, not as a runtime role. Locally `up.sh` runs it in the caller's environment as the admin `${PG_USER}`. The cloud job `db-bootstrap` logs in as Cloud SQL's built-in `postgres` user, then as its own IAM database user through the Cloud SQL connector (AAP 0.4.6). `opt2-db --help` prints the same list.

| Variable | Type | `--target local` | `--target cloud` | Default |
|---|---|---|---|---|
| `OPT2_ENV` | `local` or `cloud` | Required | Required | None |
| `PG_DATABASE` | String: database name | Required | Required | None |
| `PG_HOST` | String: host name | Required | Not used | None |
| `PG_PORT` | Integer: TCP port, 1–65535 | Required | Not used | None |
| `PG_USER` | String: role name | Required: the administrator role, with `CREATEROLE` and `CREATE` on `PG_DATABASE` | Not used: the IAM user derives from the `db-bootstrap` service account | None |
| `PG_PASSWORD` | String, secret | Required: password of `PG_USER` | Not used | None |
| `OPT2_STATE_DIR` | String: absolute path outside the checkout | Read: role passwords from `secrets/db-<schema>-{app,migrator}` | Not used | `~/.opt2/state` |
| `CLOUD_SQL_INSTANCE` | String: `<project>:<region>:<instance>` | Not used | Required | None |
| `GOOGLE_CLOUD_PROJECT` | String: project id | Not used | Required: the project of the service accounts and their IAM database users | None |
| `OPT2_CLOUDSQL_ADMIN_PASSWORD` | String, secret | Not used | Required: password of the built-in `postgres` user | None |

- `OPT2_CLOUDSQL_ADMIN_PASSWORD` is cloud-only and has no default. The `db-bootstrap` job in `infra/terraform/envs/plan/main.tf` takes it from the Secret Manager secret `cloudsql-admin-password` (version `latest`), a container with no version in this run; no file in the repository holds its value.
- The job also sets `OPT2_DB_AUTH=iam` and `PG_USER`; `opt2-db` uses neither for `--target cloud`.
- A variable that is set is format-checked whatever the target. A missing required one fails before any connection, with exit 1 and an error naming it: `error.message` is `db-bootstrap: invalid environment (<VAR>: <reason>; …)` for a missing (`is required`) or a badly formatted variable, and never holds a value.

## Build and test

```sh
npm ci                  # installs and builds ../platform through postinstall
npm run build           # generates contract types into src/generated/, then tsc -> dist/
npm test                # vitest with coverage, >= 90% statements
npm run test:contract   # test/contract
npm run test:security   # test/security: route and role matrix through app.inject
npm start               # node dist/cli.js serve
```

- Suites that need PostgreSQL create a throwaway schema from the `PG_*` variables, skip when `PG_HOST` is unset and fail when the server is unreachable. SQL Server, ColdFusion, the bridge, the gateway, the owners and Pub/Sub are in-process doubles (`test/helpers/`), so no suite needs a legacy server.
- Headline suites: `test/windows.test.ts` (overlapping windows, a transition racing a window, gateway loss mid-write), `test/transition.test.ts` (pending seam event drained before the gates close), `test/projection-await.test.ts` (older open transaction holds the barrier), `test/reverse-crash.test.ts` (crash between the SQL Server commit and the mirror), `test/reverse-nokey.test.ts` (duplicate keyless rows).

## Links

- [`gateway/README.md`](../gateway/README.md): cut-over table, write-window client, barrier, fail closed
- [`gateway/legacy-bridge/README.md`](../gateway/legacy-bridge/README.md): bridge assertion and the `files`, `jobs`, `scheduler`, `site` endpoints
- [`platform/README.md`](../platform/README.md): `migration-kit`, `tenancy`, `tasks` and the shared CLIs
- [`opt2/README.md`](../opt2/README.md): deliverable index and the two reproducibility commands
