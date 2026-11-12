# @opt2/platform

Shared runtime components that every OPT-2 package (gateway, web, migration, harness, `legacy-fixtures/seed` and every `services/*`) imports by subpath.

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

## Consuming the package

| Consumer | Dependency |
|---|---|
| `services/*`, `legacy-fixtures/seed` | `"@opt2/platform": "file:../../platform"` |
| `gateway`, `web`, `migration`, `harness` | `"@opt2/platform": "file:../platform"` |

- Each consumer's `postinstall` runs `npm ci --prefix <platform> && npm run build --prefix <platform>`, so a fresh folder installs and builds the platform itself. There are no npm workspaces, because the root `package.json` is Masa's gulp build (AAP 0.4.1).
- Import through subpath exports only, never from `platform/src/**` (AAP 0.6.2):

  ```ts
  // never
  import { withTenant } from '../../../platform/src/tenancy/transaction';
  // always
  import { withTenant } from '@opt2/platform/tenancy';
  ```

- This `package.json` is the version source for the shared runtime libraries (AAP 0.10.2). Consumers list only their own additions and take what they need of the shared ones from the platform's re-exports: Fastify types and `z` (zod) from `service-kit`, `pg` pool, client and result types from `tenancy`, OpenTelemetry span types from `tracing`. A consumer that imports a shared library directly, or needs its types resolvable from its own folder, lists it at exactly the platform's version, and the two pins change together. Current ones:

  | Consumer | Package | Why |
  |---|---|---|
  | `gateway` | `ajv` 8.20.0 | Imported in `src/cutover/loader.ts` |
  | `gateway` | `fastify` 5.12.7 (dev) | `@fastify/reply-from`'s types augment `'fastify'`, so `reply.from` type-checks only against a copy resolvable from `gateway/`. Dev-only and never loaded at runtime, so there is no second Fastify instance |
  | `migration` | `pg` 8.23.1, `@types/pg` 8.23.1 (dev), `@google-cloud/cloud-sql-connector` 1.12.1 | Imported in `src/db-bootstrap/index.ts` |
  | `migration` | `@google-cloud/pubsub` 6.3.2 | Imported in `src/quiesce/subscriptions.ts` |
  | `harness` | `pg` 8.23.1, `@types/pg` 8.23.1 (dev) | Imported in `src/lib/pg.ts` |
  | `harness` | `ajv` 8.20.0, `@google-cloud/pubsub` 6.3.2 | Direct use |
  | `services/identity` | `jose` 6.2.14 | Local signer (AAP 0.10.1) |

- ESM package (`"type": "module"`). Node `22.23.4` is enforced by `engines` plus `engine-strict=true` in `.npmrc`, which also sets `save-exact=true`.

## Modules

Each subpath maps to `dist/<module>/index.js` and its `.d.ts` (AAP 0.5.5).

| Subpath | Provides | Consumers |
|---|---|---|
| `service-kit` | `createService`: Fastify factory wiring auth, tenancy, logging, tracing, `/healthz`, legacy error mapping and graceful shutdown; it routes declared legacy path prefixes (`noCasePathPrefixes`) in any letter case. `createServiceClient`: undici client, 10 s timeout, no automatic retries, forwards the caller's user token, request id and trace context. Injectable clock; zod environment schema (`loadEnv`, [Configuration](#configuration)); `csrfPreHandler`, which calls identity `POST /internal/v1/csrf/consume` | gateway, all services, stub |
| `auth` | User-token verification: local RS256 via `OPT2_JWKS_URL`, or the cloud securetoken issuer. Invocation credentials in `X-Serverless-Authorization`. Per-transport schemes: service call, managed Pub/Sub push, managed Cloud Tasks. `config.opt2.requires` / `config.opt2.public`, deny by default. Role-matrix export | all services, gateway, web, migration |
| `tenancy` | `tenantIdForSite` (UUIDv5, namespace `6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c`); `withTenant`, whose first statement is `set_config('app.tenant_id', $1, true)`; pool, content-pool and `tenant_grant` resolution from the registry; RLS SQL helper; `tenant_registry` consumer of `programs-sites.site.changed.v1`; Cloud SQL IAM connections | all services, migration |
| `outbox` | Writer inside the business transaction; in-request flush after commit; `/internal/v1/outbox/sweep` handler with recovery hooks and its self-rescheduling task; replay | every producer |
| `events` | Envelope validation; publisher with ordering keys; push handler `/internal/v1/events/<subscription>`; inbox-idempotent consumer applying the `x-opt2-kind` and `x-opt2-tenant-fanout` rules; DLQ publisher; DLQ replay | every producer and consumer |
| `logging` | pino logger emitting `log-record.v1`, plus its validator | every process |
| `tracing` | OTel SDK start-up; W3C propagation over HTTP, Pub/Sub attributes and Cloud Tasks headers | every process |
| `legacy-compat` | Masa wire format: envelope, error map, ETag, `Generator`/HSTS, CF UUIDs, dates, cookies, admin URLs, CSRF formula, bridge assertion signer, CSV, 503 shapes. `route-key.ts`: the one route-key function (AAP 0.4.2) | gateway, web, migration, all services; route key also the harness inventory and coverage |
| `tasks` | Task port; Cloud Tasks and local adapters; `ensureRecurring()` | programs-sites, strategies-content, communications, surveys, reporting; every producer's outbox sweep |
| `storage` | Storage port; Cloud Storage adapter (v4 signed URLs, 15 min); local HMAC adapter (`/opt2/files/<bucket>/…`); byte-stream helper for legacy file routes | strategies-content, reporting, finance, e-signature |
| `migration-kit` | Mappings, including the `Program_<id>` fold; canonical encoding (AAP 0.8.4); changelog hook and commit-safe cursor (AAP 0.5.2); unit gates and open operations (AAP 0.5.4); `/internal/v1/migration/{apply,export,changes,position,watermark,gate}` handlers; `X-Opt2-Write-Position` | all services, migration |
| `state-machine` | Transition-table runner; `generate-table.ts` (AAP 0.4.5) | finance, timesheets |
| `testing` | Tenant fixtures A, B and umbrella; throwaway schema and roles; suite cleanup (`runCleanup`) that runs every teardown step; token minting; contract assertions; isolation and pooled-connection-reuse suites | all test suites |

## Configuration

`loadEnv(schema = baseEnvSchema, source = process.env)` from `service-kit` validates every process's variables (AAP 0.6.2). A blank or whitespace-only value counts as unset.

| Variable | Accepted value → parsed | Required | Default | Purpose |
|---|---|---|---|---|
| `PORT` | integer 1–65535 → number | yes | — | Listen port. In this environment `PORT` is legacy ColdFusion's, so `harness/repro/up.sh` sets each target's inline from `harness/repro/ports.env` |
| `OPT2_SERVICE_NAME` | `^[a-z][a-z0-9-]*$` | yes | — | This process's service name: local invocation-token caller and callee, its own `OPT2_SERVICE_URLS` entry, the `EnvValidationError` prefix |
| `OPT2_ENV` | `local` \| `cloud` | yes | — | Mode: local or cloud auth, and the rules below |
| `PG_HOST` | string | `OPT2_DB_AUTH=password` | — | PostgreSQL host |
| `PG_PORT` | integer 1–65535 → number | `OPT2_DB_AUTH=password` | — | PostgreSQL port |
| `PG_DATABASE` | string | `OPT2_DB_AUTH` set | — | PostgreSQL database |
| `PG_USER` | string | `OPT2_DB_AUTH` set | — | Login role; `up.sh` sets it inline to the service's `<svc>_app` role |
| `PG_PASSWORD` | string | `OPT2_DB_AUTH=password`; must be unset with `iam` | — | Password of `PG_USER` |
| `OPT2_DB_AUTH` | `password` \| `iam` | no | unset: no pool | Pool login: `password` locally, Cloud SQL IAM in the cloud. `createService` with a `schema` throws without it |
| `CLOUD_SQL_INSTANCE` | `<project>:<region>:<instance>` | `OPT2_DB_AUTH=iam` | — | Cloud SQL connector instance |
| `PUBSUB_EMULATOR_HOST` | `host:port` or `[ipv6]:port`, port 1–65535 | no; must be unset in the cloud | — | Pub/Sub emulator, read by the Pub/Sub client |
| `GOOGLE_CLOUD_PROJECT` | string | `OPT2_ENV=cloud` | — | Project of Pub/Sub, Cloud Tasks, Cloud Storage, cloud log trace ids and the securetoken issuer |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | http(s) URL, trailing `/` trimmed | no | tracing uses `http://localhost:4318` | OTLP/HTTP base; `tracing` exports spans to `<base>/v1/traces` |
| `OPT2_JWKS_URL` | http(s) URL, trailing `/` trimmed | `OPT2_ENV=local` | cloud: Google's securetoken JWKS | Key set that verifies user tokens; locally identity's |
| `OPT2_TOKEN_ISSUER` | string | yes | — | Expected user-token `iss`; `auth` exports the local signer's (`LOCAL_USER_TOKEN`) and the cloud's (`cloudUserTokenSettings`) |
| `OPT2_TOKEN_AUDIENCE` | string | yes | — | Expected user-token `aud`, from the same two exports |
| `OPT2_GATEWAY_URL` | http(s) URL, trailing `/` trimmed | no | — | Service-client target `gateway` |
| `OPT2_MIGRATION_URL` | http(s) URL, trailing `/` trimmed | no | — | Service-client target `migration` |
| `OPT2_SERVICE_URLS` | JSON object: service name → http(s) URL, trailing `/` trimmed | no | `{}` | Service-client targets. In the cloud the process's own entry is its Pub/Sub push and Cloud Tasks audience |
| `OPT2_STATE_DIR` | absolute path resolving, through symlinks, outside the checkout → normalised path | no | `$HOME/.opt2/state` | Runtime state (AAP 0.4.1). The platform uses `secrets/` (`token-signing-private.pem`, `token-signing-public.pem`, `pubsub-push-key`, `storage-hmac-key`) and the local storage adapter's `storage/` |
| `OPT2_TASKS_ADAPTER` | `local` \| `cloud` | no; must equal `OPT2_ENV` | `OPT2_ENV` | Tasks port adapter |
| `OPT2_STORAGE_ADAPTER` | `local` \| `cloud` | no; must equal `OPT2_ENV` | `OPT2_ENV` | Storage port adapter |
| `TZ` | correctly cased IANA zone id the process applies, such as `UTC` | yes | — | Process time zone: the legacy server's, for `timestamp(3)` values |

Cross-variable rules (`envModeIssues`):

- `OPT2_DB_AUTH=password`: `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER` and `PG_PASSWORD` required; `OPT2_ENV=local`.
- `OPT2_DB_AUTH=iam`: `CLOUD_SQL_INSTANCE`, `PG_DATABASE` and `PG_USER` required; `PG_PASSWORD` unset; `OPT2_ENV=cloud`.
- `OPT2_ENV=cloud`: `GOOGLE_CLOUD_PROJECT` required; `PUBSUB_EMULATOR_HOST` unset.
- `OPT2_ENV=local`: `OPT2_JWKS_URL` required.
- `OPT2_TASKS_ADAPTER` and `OPT2_STORAGE_ADAPTER` equal `OPT2_ENV`.

Loading:

- Every variable is parsed first; the cross-variable rules run only once all parse. Either stage throws `EnvValidationError` listing all of its issues: `<OPT2_SERVICE_NAME>: invalid environment` (no prefix while the name is missing or invalid), then one indented `<VAR>: <problem>` line each, `is required` for an unset variable. `issues` holds those lines.
- The result is frozen, with both adapters set.
- `schema` may be `baseEnvSchema.extend({…})`; `requiredEnvString`, `optionalEnvString`, `envUrl` and `envPort` build further variables with the same blank handling. Per-process additions (AAP 0.6.2) extend it in their own packages: gateway `LEGACY_ORIGIN`, `OPT2_CUTOVER_DIR`, `OPT2_BRIDGE_HMAC_KEY`; migration, among others, `MURA_DBHOST`, `MURA_DBPORT`, `MURA_DATABASE`, `MURA_DBUSERNAME`, `MURA_DBPASSWORD`, `LEGACY_ORIGIN`, `OPT2_BRIDGE_HMAC_KEY`; communications `SMTP_HOST`, `SMTP_PORT`, `MAILPIT_API_URL`.

## Contracts

| File | Fields |
|---|---|
| `contracts/event-envelope.v1.json` | `eventId`, `eventType`, `schemaVersion`, `tenantId`, `occurredAt`, `producer`, `aggregateType`, `aggregateId`, `aggregateVersion`, `traceparent`, `tracestate`, `correlationId`, `causationId`, `payload` |
| `contracts/log-record.v1.json` | `timestamp`, `severity`, `message`, `service`, `version`, `env`; `traceId`, `spanId`, `traceSampled`; `tenantId`, `userId`, `requestId`, `eventId`; `route`, `httpMethod`, `statusCode`, `latencyMs`; `error.{type,message,stack}`; in the cloud also `logging.googleapis.com/{trace,spanId,trace_sampled}` |

- Pub/Sub attributes mirror `eventId`, `eventType`, `schemaVersion`, `tenantId`, `aggregateVersion` and `traceparent`. The ordering key is `aggregateId`.
- Topics are named `<service>.<entity>.<event>.v<major>`. Each producer owns its payload schemas under `services/<producer>/contracts/events/<topic>.json` (AAP 0.4.4).

## CLIs

| Command | Does |
|---|---|
| `opt2-auth matrix --app <module>` | Builds the Fastify app from a compiled module's builder export (default `buildApp`) without listening, and writes its route/role matrix as JSON (`--export`, `--options`, `--out`) |
| `opt2-outbox replay --since <ts>` | Republishes stored outbox rows with their original `eventId` (`--tenant`, `--schema`) |
| `opt2-events replay --subscription <s>` | Republishes the subscription's DLQ messages to its original topic (`--max`, `--idle-seconds`, `--project`) |
| `opt2-tasks reconcile` | Has each creating service run `ensureRecurring()` for its recurring queues (`--queue`, `--with-sitemonitor`, `--include-local-only`, `--as`) |

| CLI | Reads | Exit 0 | Exit 1 | Exit 2 |
|---|---|---|---|---|
| `opt2-auth` | No variable itself; the builder it imports may call `loadEnv` | Matrix written | Any other failure, including the builder's `EnvValidationError` | Usage only: unknown flag or subcommand, missing `--app`, invalid `--options` JSON, builder export not a function |
| `opt2-outbox` | Only `OPT2_SERVICE_NAME`, `OPT2_ENV`, `TZ` (the zone outbox timestamps are stored in), `OPT2_DB_AUTH`, `PG_DATABASE` and `GOOGLE_CLOUD_PROJECT` in either mode, plus the `PG_*`, `CLOUD_SQL_INSTANCE` and `PUBSUB_EMULATOR_HOST` rules of [Configuration](#configuration) for its `OPT2_DB_AUTH` and `OPT2_ENV`, all reported in one `EnvValidationError`; `--schema` defaults to the schema of `OPT2_SERVICE_NAME` | Every row republished | A row failed or was skipped, or another error | Usage, including a `--since` that is not an ISO-8601 date-time with a zone, or `EnvValidationError` |
| `opt2-events` | Only `GOOGLE_CLOUD_PROJECT` (unless `--project`) and, through the Pub/Sub client, `PUBSUB_EMULATOR_HOST` | Done | Any other failure, such as a pull or republish error | Usage, including an invalid subscription name and no `--project` with `GOOGLE_CLOUD_PROJECT` unset |
| `opt2-tasks` | Only `OPT2_ENV`, `OPT2_SERVICE_URLS` (at least one service), `OPT2_STATE_DIR` (the local signing key pair) and `GOOGLE_CLOUD_PROJECT` (in the cloud), each parsed as in [Configuration](#configuration) | Every selected chain ensured; without `--queue`, creators `OPT2_SERVICE_URLS` lacks are skipped | A chain failed, including a `--queue` whose creator `OPT2_SERVICE_URLS` lacks | Usage or `EnvValidationError`; a `--queue` the registry refuses; without `--queue`, `OPT2_SERVICE_URLS` naming none of the selected queues' creators |

`--help` (or `-h`) prints each CLI's usage, options and environment variables and exits 0 before any variable is read. `npm ci` in a consumer links these into its `node_modules/.bin` from the committed `bin/` wrappers, which run the compiled `dist/<module>/cli.js` once the platform is built (the consumer's `postinstall` builds it). `node <path>/platform/dist/<module>/cli.js` runs the same CLI directly.

## Value formats

| Value | Format (AAP 0.5.5) |
|---|---|
| New primary keys | 35-character CF UUIDs from `legacy-compat`. Only `eventId` and tenant ids are RFC 4122 |
| Timestamps | `timestamp(3) without time zone` in the legacy server's zone (`TZ`, exported by `up.sh`) |
| Money | `numeric(19,4)`, serialized as a string with four decimals |

## Build and test

```sh
npm ci
npm run build           # tsc -> dist/
npm test                # vitest with coverage, >= 90% statements
npm run test:contract   # test/contract only
```

`npm test` runs every suite under `test/`. `test/unit` and `test/contract` need nothing external; the others need:

- `test/isolation` and `test/events`: PostgreSQL 16 named by all of `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`. Each run creates a throwaway schema and roles through `testing` and drops them afterwards, so `PG_USER` needs `CREATEROLE` plus `CREATE` and grantable `CONNECT` on `PG_DATABASE`, as its owner has.
- `test/events`, except `local-task-adapter`: also the Pub/Sub emulator at `PUBSUB_EMULATOR_HOST`, in project `GOOGLE_CLOUD_PROJECT` (default `opt2-local`).
- A missing setting or an unreachable server fails these suites, so `npm test` fails without both servers. Only `isolation/{migration-kit-handlers,migration-kit-repository,outbox-ordering,testing-isolation,testing-schema}` and `events/local-task-adapter` skip their PostgreSQL cases instead, when the `PG_*` settings are present but PostgreSQL accepts no connection within 2 s; a server error such as a wrong password still fails them. The `isolation-suite` BYPASSRLS case skips when `PG_USER` holds neither `SUPERUSER` nor `BYPASSRLS`.
