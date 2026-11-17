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

- This `package.json` is the version source for the shared runtime libraries (AAP 0.10.2). Consumers list only their own additions and take what they need of the shared ones from the platform's re-exports: Fastify types, `z` (zod), and undici's `Agent` and `Dispatcher` types from `service-kit`, the `pg` driver (`pg`) with its pool, client, config and result types, and the Cloud SQL connector's `Connector`, `AuthTypes` and `IpAddressTypes` from `tenancy`, the Pub/Sub `PubSub` client, its generated `v1` clients and its `Message` and `protos` types from `events`, `jose`'s `SignJWT`, `jwtVerify`, `decodeJwt`, `decodeProtectedHeader`, `createLocalJWKSet`, `exportJWK`, `exportPKCS8` and its `JWK` and `JSONWebKeySet` types from `auth`, OpenTelemetry span types from `tracing`. A consumer that imports a shared library directly, or needs its types resolvable from its own folder, lists it at exactly the platform's version, and the two pins change together. Current ones:

  | Consumer | Package | Why |
  |---|---|---|
  | `gateway` | `ajv` 8.20.0 | Imported in `src/cutover/loader.ts` |
  | `gateway` | `fastify` 5.12.7 (dev) | `@fastify/reply-from`'s types augment `'fastify'`, so `reply.from` type-checks only against a copy resolvable from `gateway/`. Dev-only and never loaded at runtime, so there is no second Fastify instance |

- ESM package (`"type": "module"`). Node `22.23.4` is enforced by `engines` plus `engine-strict=true` in `.npmrc`, which also sets `save-exact=true`.

## Modules

Each subpath maps to `dist/<module>/index.js` and its `.d.ts` (AAP 0.5.5).

| Subpath | Provides | Consumers |
|---|---|---|
| `service-kit` | `createService`: Fastify factory wiring auth, tenancy, logging, tracing, `/healthz`, legacy error mapping and graceful shutdown; a value PostgreSQL cannot store, such as text with a NUL (U+0000) that legacy SQL Server stores in `nvarchar` (22021, or 22P05 for a `\u0000` escape in JSON input), answers 400 `invalidParameters` (`isUnstorableTextError`); it routes declared legacy path prefixes (`noCasePathPrefixes`) in any letter case, and with `legacyFixturePaths` routes `/legacy-fixtures/cfml/api.cfm/` paths under their module, resource, action and tail segments lower-cased, as api.cfm reads them. `abandonOnDisconnect`: opts a read into abandonment, so once its client disconnects `throwIfRequestAborted()` and the service client's next call throw `RequestAbortedError`, logged at INFO as `request abandoned`. `createServiceClient`: undici client, 10 s timeout, no automatic retries, forwards the caller's user token, request id and trace context. `createSignalBoundFetch`: `fetch` over undici without header or body timeouts, for callers that bound each call through its `AbortSignal` (migration's legacy-bridge client). `jsonListStream`: the bytes `JSON.stringify` gives an object with one array member, streamed from async batches pulled under backpressure in the creating request's context, sent with `JSON_CONTENT_TYPE`. Injectable clock; zod environment schema (`loadEnv`, [Configuration](#configuration)); `csrfPreHandler`, which calls identity `POST /internal/v1/csrf/consume`. `legacyParamsOf`: the scanned url then form scope, or a JSON body as sent, later keys winning ignoring case; `legacyScopesOf`: the scanned url and form scopes with their failure flags. A root-served path (`/_api`, `/index.cfm`, `/tasks`, `/core`, `/legacy-fixtures`, `noCasePathPrefixes`) whose scan faults answers legacy's 500 error page (`legacyStartupScan`, default on; the gateway turns it off), except a request the service's `skipsStartupScan` names, such as a path naming no template, whose 404 legacy keeps. A request target the service's `containerRefusesTarget` names gets the servlet container's empty 400 with `Connection: close` and no Date, Generator or HSTS header, ahead of the POST size check, the scan and auth. The request-head limit is `SERVICE_MAX_HEADER_SIZE`, legacy's plus 64 KiB for the headers the gateway adds when it forwards (the gateway sets `maxHeaderSize` to legacy's own); a head over it gets that same empty 400 and the connection closes. Re-exports undici's `Agent` and `Dispatcher` types, for the gateway's reply-from agent | gateway, all services, stub, migration |
| `auth` | User-token verification: local RS256 via `OPT2_JWKS_URL`, or the cloud securetoken issuer. Invocation credentials in `X-Serverless-Authorization`. Per-transport schemes: service call, managed Pub/Sub push, managed Cloud Tasks; `managedAudience` derives the exact OIDC audience, the service origin plus the route path, that the cloud push and task schemes verify and the Cloud Tasks adapter sends. `config.opt2.requires` / `config.opt2.public`, deny by default. Site check over `suppliedSiteIdsOf`: route params, the scanned url and form scopes plus each sent `siteid` scanned alone, or a JSON body as sent. Role-matrix export | all services, gateway, web, migration |
| `tenancy` | `tenantIdForSite` (UUIDv5, namespace `6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c`); `withTenant`, whose first statement is `set_config('app.tenant_id', $1, true)`; pool, content-pool and `tenant_grant` resolution from the registry; RLS SQL helper; `tenant_registry` consumer of `programs-sites.site.changed.v1`; Cloud SQL IAM connections; `TenantDb.listen`, a reconnecting LISTEN session on its own connection | all services, migration |
| `outbox` | Writer inside the business transaction; in-request flush after commit; `/internal/v1/outbox/sweep` handler with recovery hooks and its self-rescheduling task; replay | every producer |
| `events` | Envelope validation; publisher with ordering keys; push handler `/internal/v1/events/<subscription>`; inbox-idempotent consumer applying the `x-opt2-kind` and `x-opt2-tenant-fanout` rules; DLQ publisher; DLQ replay | every producer and consumer |
| `logging` | pino logger emitting `log-record.v1`, plus its validator and the CLI diagnostics (`createCliDiagnostics`, `parseArgsProblem`) | every process |
| `tracing` | OTel SDK start-up; W3C propagation over HTTP, Pub/Sub attributes and Cloud Tasks headers; `withUnsampledTrace` runs a background-loop iteration in an unsampled trace (outgoing `traceparent` flags `00`), whose real work records itself with `startLinkedRootSpan` | every process |
| `legacy-compat` | Masa wire format: envelope, error map, ETag, `Generator`/HSTS, CF UUIDs, dates, cookies, admin URLs, CSRF formula, bridge assertion signer, CSV, 503 shapes; `cfVal` (ACF `Val`). `request-head.ts`: the container's 1 MiB request-head limit and its bare 400. `route-key.ts`: the one route-key function (AAP 0.4.2). Masa's start-up script protection: `portcullis.ts` (`portcullisScan`: Portcullis tag and word filters to `[INVALID]`, fixValues, stripMSWord with the ACF JSON round trip of `acf-json.ts` and `java-double.ts`); `request-scopes.ts` (`legacyScopesFrom`, `portcullisInputsOf`, `legacyScopeParams`: url and form scopes as ColdFusion builds them and the scan leaves them); `scanned-route-key.ts` (`scannedRouteKey`: reload on the url as sent, route on the scanned scopes, the `{scriptprotect=fault}` halt variant, which legacy serves, where ColdFusion's runtime decides the scan or an admin scan faults) | gateway, web, migration, all services; route key also the harness inventory and coverage |
| `tasks` | Task port; Cloud Tasks and local adapters, the local one woken by transactional `pg_notify` from every adapter on its schema; `ensureRecurring()` | programs-sites, strategies-content, communications, surveys, reporting; every producer's outbox sweep |
| `storage` | Storage port; Cloud Storage adapter (v4 signed URLs, 15 min), where every wait on Cloud Storage (a request's answer, or the next chunk of a stream) is bounded by `STORAGE_TIMEOUT_MS` (10 s) and fails with `StorageTimeoutError` (legacy 503), cancelling the operation's requests; local HMAC adapter (`/opt2/files/<bucket>/…`); byte-stream helper for legacy file routes | strategies-content, reporting, finance, e-signature |
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
| `OPT2_DB_AUTH` | `password` \| `iam` | no | unset: no pool | Pool login: `password` locally, Cloud SQL IAM in the cloud. `createService` with a `schema` throws `EnvValidationError` naming it, and `PG_DATABASE`, when unset |
| `CLOUD_SQL_INSTANCE` | `<project>:<region>:<instance>` | `OPT2_DB_AUTH=iam` | — | Cloud SQL connector instance |
| `PUBSUB_EMULATOR_HOST` | `host:port` or `[ipv6]:port`, port 1–65535 | by a local process's default publisher (`publisherEmulatorHost`); must be unset in the cloud | — | Pub/Sub emulator, read by the Pub/Sub client |
| `GOOGLE_CLOUD_PROJECT` | string | `OPT2_ENV=cloud` | — | Project of Pub/Sub, Cloud Tasks, Cloud Storage, cloud log trace ids and the securetoken issuer |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | http(s) URL, trailing `/` trimmed | no | tracing uses `http://localhost:4318` | OTLP/HTTP base; `tracing` exports spans to `<base>/v1/traces` |
| `OTEL_LOG_LEVEL` | `ALL` \| `VERBOSE` \| `DEBUG` \| `INFO` \| `WARN` \| `ERROR` \| `NONE` in any case → upper case; any other text → `INFO`, as the OTel SDK reads it | no | unset: no OTel diagnostics | OTel SDK diagnostics `tracing` writes at that level as `log-record.v1` lines through the process diagnostic logger, never the console |
| `OPT2_JWKS_URL` | http(s) URL, trailing `/` trimmed | `OPT2_ENV=local` | cloud: Google's securetoken JWKS | Key set that verifies user tokens; locally identity's |
| `OPT2_TOKEN_ISSUER` | string | yes | — | Expected user-token `iss`; `auth` exports the local signer's (`LOCAL_USER_TOKEN`) and the cloud's (`cloudUserTokenSettings`) |
| `OPT2_TOKEN_AUDIENCE` | string | yes | — | Expected user-token `aud`, from the same two exports |
| `OPT2_GATEWAY_URL` | http(s) URL, trailing `/` trimmed | no | — | Service-client target `gateway` |
| `OPT2_MIGRATION_URL` | http(s) URL, trailing `/` trimmed | no | — | Service-client target `migration` |
| `OPT2_SERVICE_URLS` | JSON object: service name → http(s) URL, trailing `/` trimmed | no | `{}` | Service-client targets. In the cloud the process's own entry is the origin of its managed audiences: `managedAudience`, the origin plus the push or task path, for Pub/Sub push and Cloud Tasks |
| `OPT2_STATE_DIR` | absolute path resolving, through symlinks, outside the checkout → normalised path | no | `$HOME/.opt2/state` | Runtime state (AAP 0.4.1). The platform uses `secrets/` (`token-signing-private.pem`, `token-signing-public.pem`, `pubsub-push-key`, `storage-hmac-key`) and the local storage adapter's `storage/` |
| `OPT2_TASKS_ADAPTER` | `local` \| `cloud` | no; must equal `OPT2_ENV` | `OPT2_ENV` | Tasks port adapter |
| `OPT2_STORAGE_ADAPTER` | `local` \| `cloud` | no; must equal `OPT2_ENV` | `OPT2_ENV` | Storage port adapter |
| `LOG_LEVEL` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` | no | `info` | Minimum severity `createService`'s logger writes; unused when a `logger` is injected |
| `TZ` | correctly cased IANA zone id the process applies, such as `UTC` | yes | — | Process time zone: the legacy server's, for `timestamp(3)` values |

Cross-variable rules (`envModeIssues`):

- `OPT2_DB_AUTH=password`: `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER` and `PG_PASSWORD` required; `OPT2_ENV=local`.
- `OPT2_DB_AUTH=iam`: `CLOUD_SQL_INSTANCE`, `PG_DATABASE` and `PG_USER` required; `PG_PASSWORD` unset; `OPT2_ENV=cloud`.
- `OPT2_ENV=cloud`: `GOOGLE_CLOUD_PROJECT` required; `PUBSUB_EMULATOR_HOST` unset.
- `OPT2_ENV=local`: `OPT2_JWKS_URL` required.
- `OPT2_TASKS_ADAPTER` and `OPT2_STORAGE_ADAPTER` equal `OPT2_ENV`.

Loading:

- One `EnvValidationError` lists the parse issues, then the cross-variable ones. A variable that fails to parse gets no cross-variable issue, and the rules that depend on `OPT2_ENV` are skipped while it is missing or invalid. The message is `<OPT2_SERVICE_NAME>: invalid environment` (no prefix while the name is missing or invalid), then one indented `<VAR>: <problem>` line each, `is required` for an unset variable. `issues` holds those lines. Logs carry only its safe text, `<service>: invalid environment (<VAR>: <reason>; …)`: one entry per variable with the reason of its first issue, either the rule's own wording (`is required`, `is required when OPT2_ENV=local`, `must equal OPT2_ENV`, `must be an absolute path`), zod's expected form (`expected number`, `expected one of local|cloud`, `expected an http(s) URL`), or `is invalid` for any other text, so no value reaches a log.
- The result is frozen, with both adapters set.
- A secret file under `OPT2_STATE_DIR` that cannot be read rejects with `EnvFileError`, which keeps the read error's message, `code` and `syscall` and is logged as `cannot read OPT2_STATE_DIR file secrets/<file> (open ENOENT)`.
- `processEnvSchema(schema, { service, callees, database })` refines a process's schema with `checkProcessEnv`, which runs even when other variables fail: `OPT2_SERVICE_NAME: must be <service>`; `OPT2_SERVICE_URLS.<callee>: is required` for each callee without an entry, where `gateway` and `migration` are also named by `OPT2_GATEWAY_URL` and `OPT2_MIGRATION_URL` (`OPT2_GATEWAY_URL: is required (or OPT2_SERVICE_URLS.gateway)`); and, with `database: true`, `OPT2_DB_AUTH: is required` and `PG_DATABASE: is required`. A variable or map that failed its own parse gets no further issue. A consumer with its own `superRefine` calls `checkProcessEnv(env, ctx, requirements)` inside it.
- `publisherEmulatorHost(env)` returns the emulator host a process's default publisher uses. It throws `EnvValidationError` with `PUBSUB_EMULATOR_HOST: is required when OPT2_ENV=local` when the host is unset locally, so a local process never reaches Cloud Pub/Sub; services call it only when no publisher is injected.
- `tracingEnvSchema` holds the two `OTEL_*` variables, which `baseEnvSchema` includes. `startTracing` parses it with `loadTracingEnv(source, service)` before it patches anything, as it runs before the process loads its own schema; an invalid `OTEL_EXPORTER_OTLP_ENDPOINT` throws `EnvValidationError`.
- `schema` may be `baseEnvSchema.extend({…})`; `requiredEnvString`, `optionalEnvString`, `envUrl` and `envPort` build further variables with the same blank handling. Per-process additions (AAP 0.6.2) extend it in their own packages: gateway `LEGACY_ORIGIN`, `OPT2_CUTOVER_DIR`, `OPT2_BRIDGE_HMAC_KEY`; migration, among others, `MURA_DBHOST`, `MURA_DBPORT`, `MURA_DATABASE`, `MURA_DBUSERNAME`, `MURA_DBPASSWORD`, `LEGACY_ORIGIN`, `OPT2_BRIDGE_HMAC_KEY`; communications `SMTP_HOST`, `SMTP_PORT`, `SMTP_CREDENTIAL` (the `communications-smtp` secret, required when `OPT2_ENV=cloud`), `MAILPIT_API_URL`.

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
| `opt2-events replay --subscription <s>` | Republishes the subscription's DLQ messages published before the run started to its original topic; later ones, including replays dead-lettered again, stay on the DLQ (`--max`, `--idle-seconds`, `--project`) |
| `opt2-tasks reconcile` | Has each creating service run `ensureRecurring()` for its recurring queues (`--queue`, `--with-sitemonitor`, `--include-local-only`, `--as`) |

| CLI | Reads | Exit 0 | Exit 1 | Exit 2 |
|---|---|---|---|---|
| `opt2-auth` | No variable itself; the builder it imports may call `loadEnv` | Matrix written | Any other failure, including the builder's `EnvValidationError` | Usage only: unknown flag or subcommand, missing `--app`, invalid `--options` JSON, builder export not a function |
| `opt2-outbox` | Only `OPT2_SERVICE_NAME`, `OPT2_ENV`, `TZ` (the zone outbox timestamps are stored in), `OPT2_DB_AUTH`, `PG_DATABASE` and `GOOGLE_CLOUD_PROJECT` in either mode, plus the `PG_*`, `CLOUD_SQL_INSTANCE` and `PUBSUB_EMULATOR_HOST` rules of [Configuration](#configuration) for its `OPT2_DB_AUTH` and `OPT2_ENV`, all reported in one `EnvValidationError`; `--schema` defaults to the schema of `OPT2_SERVICE_NAME` | Every row republished | A row failed or was skipped, or another error | Usage, including a `--since` that is not an ISO-8601 date-time with a zone, or `EnvValidationError` |
| `opt2-events` | Only `GOOGLE_CLOUD_PROJECT` (unless `--project`) and, through the Pub/Sub client, `PUBSUB_EMULATOR_HOST` | Done | Any other failure, such as a pull or republish error | Usage, including an invalid subscription name and no `--project` with `GOOGLE_CLOUD_PROJECT` unset |
| `opt2-tasks` | Only `OPT2_ENV`, `OPT2_SERVICE_URLS` (at least one service), `OPT2_STATE_DIR` (the local signing key pair) and `GOOGLE_CLOUD_PROJECT` (in the cloud), each parsed as in [Configuration](#configuration) | Every selected chain ensured; without `--queue`, creators `OPT2_SERVICE_URLS` lacks are skipped | A chain failed, including a `--queue` whose creator `OPT2_SERVICE_URLS` lacks | Usage or `EnvValidationError`; a `--queue` the registry refuses; without `--queue`, `OPT2_SERVICE_URLS` naming none of the selected queues' creators |

`--help` (or `-h`) prints each CLI's usage, options and environment variables and exits 0 before any variable is read. `npm ci` in a consumer links these into its `node_modules/.bin` from the committed `bin/` wrappers, which run the compiled `dist/<module>/cli.js` once the platform is built (the consumer's `postinstall` builds it). `node <path>/platform/dist/<module>/cli.js` runs the same CLI directly.

`opt2-auth`, `opt2-outbox`, `opt2-events` and `opt2-tasks` write each diagnostic to stderr as one log-record.v1 line through `createCliDiagnostics` of `logging`, opened before the arguments and environment are parsed: a fixed message that names options but never quotes an argument, an environment error's safe text (each variable with its value-free reason), and a failure's safe `error` record. stdout carries only the help and the result.

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
- A missing setting or an unreachable server fails these suites, so `npm test` fails without both servers. Only `isolation/{migration-kit-handlers,migration-kit-repository,outbox-ordering,testing-isolation,testing-schema}` and `events/local-task-adapter` skip their PostgreSQL cases instead, and only when `PG_HOST` is unset; a server that accepts no connection within 10 s or answers with an error such as a wrong password still fails them.
- `pgAvailable` and `pubsubEmulatorAvailable` of `testing`, which every package's suites gate on, resolve false only when `PG_HOST` or `PUBSUB_EMULATOR_HOST` is unset, and reject when the named server does not answer within 10 s. `OPT2_TEST_REQUIRE_PG=1` and `OPT2_TEST_REQUIRE_PUBSUB=1`, set by `.github/workflows/services.yml`, make an unset host reject as well. The `isolation-suite` BYPASSRLS case skips when `PG_USER` holds neither `SUPERUSER` nor `BYPASSRLS`.
