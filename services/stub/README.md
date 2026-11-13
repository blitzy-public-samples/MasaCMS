# stub — platform-proof service

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The stub proves the shared platform on one minimal entity, a tenant-owned note, before any domain service depends on it. It exercises gateway dispatch, deny-by-default roles, tenancy with row-level security, the changelog and unit gates, outbox → Pub/Sub → idempotent consumer, dead letters and replay, structured logs and tracing.

It runs locally only and is never deployed: Terraform declares no instance of it, and the cloud Pub/Sub topology drops `stub.note.created.v1` and its subscription. It has no Masa equivalent and no legacy oracle.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml), [`contracts/events/stub.note.created.v1.json`](contracts/events/stub.note.created.v1.json). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md). Shared components: [`platform/README.md`](../../platform/README.md).

## Data

Schema `stub`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with three roles:

| Role | Use |
|---|---|
| `stub_owner` | `NOLOGIN`; owns the schema and every object, and FORCE RLS applies to it |
| `stub_app` | Runtime DML only; the service's `PG_USER` |
| `stub_migrator` | Applies `db/migrations/*.sql` after `SET ROLE stub_owner` |

[`db/migrations/0001_stub.sql`](db/migrations/0001_stub.sql) creates:

| Table | Holds |
|---|---|
| `stub.note` | `tenant_id`, `note_id` (`char(35)` CF UUID), `title`, `body`, `created` (`timestamp(3)`), `row_version` (the event's `aggregateVersion`) |
| `stub.note_projection` | The note as the stub's own `stub.note.created.v1` consumer applied it, with `aggregate_version`, `apply_count`, `last_event_id` and `projected_at` |
| Platform tables | `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `inbox`, `consumer_aggregate_version`, `outbox`, `scheduled_task_queue`, `scheduled_task_queue_state` |

Every tenant-owned table has RLS enabled and forced under the `tenant_isolation` policy on `app.tenant_id`. `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` are non-tenant tables without RLS or a `tenant_isolation` policy: they hold tenant metadata, never tenant data. `tenant_registry` maps each site to its `tenant_id` and pool tenants; `tenant_grant` stores `grantor_tenant` and `grantee_tenant`. The migration seeds the gates of the units `stub.note` and `stub.note_projection` as `open`. The stub owns no legacy table, so its migration mappings (`src/migration/mappings/`) are empty.

## Routes

Every route declares its roles or `public`; an undeclared route fails start-up. Responses under `/opt2/stub/**` use the Masa JSON envelope, and a note of another tenant answers the same legacy 404 as a missing one. The gateway route key is `opt2:/opt2/stub/**`, `target` from `v0001`.

| Method | Path | Transport | Requires | Does |
|---|---|---|---|---|
| `POST` | `/opt2/stub/notes` | `service` | `system-user` | Creates a note and its `stub.note.created.v1` outbox row in one transaction |
| `GET` | `/opt2/stub/notes` | `service` | `member`, `system-user`, `site-admin`, `s2` | One page of the tenant's notes (`limit` 1–1000, default 50; `after` cursor) |
| `GET` | `/opt2/stub/notes/{noteId}` | `service` | `member`, `system-user`, `site-admin`, `s2` | One note |
| `GET` | `/opt2/stub/notes/{noteId}/projection` | `service` | `member`, `system-user`, `site-admin`, `s2` | The note's `stub.note_projection` row |
| `DELETE` | `/opt2/stub/notes/{noteId}` | `service` | `s2` | Deletes a note; the deny case for every other role |
| `GET` | `/healthz` | `service` | public | Liveness probe |
| `POST` | `/internal/v1/migration/apply` | `service` | `platform.migration` | Applies one batch of canonical rows, once per batch id |
| `GET` | `/internal/v1/migration/export` | `service` | `platform.migration` | One page of a unit's rows in canonical form |
| `GET` | `/internal/v1/migration/changes` | `service` | `platform.migration` | Changelog after a cursor, below the commit-safe horizon |
| `GET` | `/internal/v1/migration/position` | `service` | `platform.migration` | Write position and outbox and inbox drain counts |
| `GET`, `POST` | `/internal/v1/migration/watermark` | `service` | `platform.migration` | Reads or records feed watermarks |
| `POST` | `/internal/v1/migration/gate` | `service` | `platform.migration` | Closes, re-phases, opens or reads the unit gates |
| `POST` | `/internal/v1/events/stub.stub.note.created.v1` | `pubsub-push` | `service:pubsub-invoker` (local push key locally) | Applies `stub.note.created.v1` to `stub.note_projection` |
| `POST` | `/internal/v1/events/stub.programs-sites.site.changed.v1` | `pubsub-push` | `service:pubsub-invoker` (local push key locally) | Applies `programs-sites.site.changed.v1` to `stub.tenant_registry` |
| `POST` | `/internal/v1/outbox/sweep` | `cloud-tasks` | `service:tasks-invoker` | Creates the next sweep task, then publishes every unpublished outbox row |
| `POST` | `/internal/v1/task-queues/{queue}/pause`, `/resume`, `/ensure` | `service` | `platform.migration`, `platform.operator` | Controls `stub-outbox-sweep` |

## Events

| Topic | Direction | Effect |
|---|---|---|
| `stub.note.created.v1` | Produced by `POST /opt2/stub/notes`; consumed by the stub itself | `stub.note_projection` row. `x-opt2-kind: state`: the payload is the note's full state (`noteId`, `title`, `body`, `created`, `rowVersion`); `aggregateType` is `note`, `aggregateId` the note id, `aggregateVersion` its `row_version` |
| `programs-sites.site.changed.v1` | Consumed | `stub.tenant_registry` row |

- A duplicate delivery has one effect, through the `inbox` receipt. A state version at or below the last applied one is acked and ignored.
- A missing, invalid or unregistered tenant, a tenant mismatch or a schema failure is published to `<subscription>.dlq` (for notes, `stub.stub.note.created.v1.dlq`) with a `reason` attribute and acked. `opt2-events replay` republishes it.
- The sweep queue `stub-outbox-sweep` runs every 60 s and exists locally only; `opt2-tasks reconcile` includes it when `OPT2_ENV=local`.

## Platform-proof checks

`harness/e2e/isolation/platform-proof.e2e.test.ts` runs these against the stub with `v0001` active and writes `opt2/reports/platform-proof.json`. [`TRACEABILITY.md`](TRACEABILITY.md) maps each to its code and tests.

| Check id | Proves |
|---|---|
| `dispatch` | The gateway routes `/opt2/stub/**` to the stub |
| `unmoved-to-legacy` | An unmoved route reaches legacy unchanged |
| `fail-closed-write` | With the stub down, a write answers the legacy-shaped 503 |
| `outbox-pubsub-idempotent-consumer` | A note's event reaches `stub.note_projection` once, however often it is delivered |
| `dlq-replay` | A dead-lettered message replays once |
| `rls-isolation` | Tenants A, B and umbrella never see each other's rows |
| `log-schema` | Log lines validate against `log-record.v1` |
| `trace` | One `traceId` spans gateway, stub and consumer |

## Run and test

```sh
npm ci            # postinstall builds ../../platform
npm run build     # generates src/generated/ from the contracts, then tsc -> dist/
export OPT2_STATE_DIR="$HOME/.opt2/state"   # outside the checkout; secrets/ from `npm run repro:secrets` in harness
export PORT=8199 OPT2_SERVICE_NAME=stub OPT2_ENV=local TZ=UTC
export OPT2_DB_AUTH=password PG_HOST=127.0.0.1 PG_PORT=5432 PG_DATABASE='<database>'   # the database opt2-db bootstrap set up
export PG_USER=stub_app PG_PASSWORD="$(cat "$OPT2_STATE_DIR/secrets/db-stub-app")"
export PUBSUB_EMULATOR_HOST=localhost:8085
export OPT2_TOKEN_ISSUER=opt2-local-identity OPT2_TOKEN_AUDIENCE=opt2-local
export OPT2_JWKS_URL=http://127.0.0.1:8111/.well-known/jwks.json   # identity's key set
export OPT2_SERVICE_URLS='{"stub":"http://127.0.0.1:8199"}'        # target of the stub's own outbox sweep
npm start         # node dist/main.js
```

The environment is `baseEnvSchema` of `@opt2/platform/service-kit` (see [Configuration](../../platform/README.md#configuration)); locally it also needs `PUBSUB_EMULATOR_HOST`. `harness/repro/up.sh` sets all of it.

| Command | Runs |
|---|---|
| `npm test` | Every suite with coverage (≥ 90 % statements): `test/unit`, `test/contract`, `test/isolation`, `test/events`, `test/security` |
| `npm run test:contract` | Responses and events against the contracts |
| `npm run test:security` | The route × role matrix through `app.inject` |

`harness/repro/test-all.sh` stage 2 runs `npm test` here. A full run needs PostgreSQL (`PG_HOST`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`; `PG_PORT` defaults to 5432) and the Pub/Sub emulator (`PUBSUB_EMULATOR_HOST`), which `test-all.sh` and CI provide. The PostgreSQL cases in `test/unit/app.test.ts`, `test/unit/repository.test.ts`, `test/isolation/rls.test.ts`, `test/events/delivery.test.ts` and `test/events/outbox.test.ts` skip when `PG_HOST` is unset or the server cannot be reached. With `PG_HOST` set, a missing setting, an invalid `PG_PORT` or a refused login fails those files with an error naming the cause. The emulator round trip in `test/events/outbox.test.ts` skips when `PUBSUB_EMULATOR_HOST` is unset or unreachable.
