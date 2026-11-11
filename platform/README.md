# @opt2/platform

Shared runtime components that every OPT-2 package (gateway, web, migration, harness and every `services/*`) imports by subpath.

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

## Consuming the package

| Consumer | Dependency |
|---|---|
| `services/*` | `"@opt2/platform": "file:../../platform"` |
| `gateway`, `web`, `migration`, `harness` | `"@opt2/platform": "file:../platform"` |

- Each consumer's `postinstall` runs `npm ci --prefix <platform> && npm run build --prefix <platform>`, so a fresh folder installs and builds the platform itself. There are no npm workspaces, because the root `package.json` is Masa's gulp build (AAP 0.4.1).
- Import through subpath exports only, never from `platform/src/**` (AAP 0.6.2):

  ```ts
  // never
  import { withTenant } from '../../../platform/src/tenancy/transaction';
  // always
  import { withTenant } from '@opt2/platform/tenancy';
  ```

- Shared third-party libraries are pinned once, in this `package.json` (AAP 0.10.2). Consumers list only their own additions and take what they need of the shared ones from the platform's re-exports: Fastify types and `z` (zod) from `service-kit`, `pg` pool, client and result types from `tenancy`, OpenTelemetry span types from `tracing`.
- ESM package (`"type": "module"`). Node `22.23.4` is enforced by `engines` plus `engine-strict=true` in `.npmrc`, which also sets `save-exact=true`.

## Modules

Each subpath maps to `dist/<module>/index.js` and its `.d.ts` (AAP 0.5.5).

| Subpath | Provides | Consumers |
|---|---|---|
| `service-kit` | `createService`: Fastify factory wiring auth, tenancy, logging, tracing, `/healthz`, legacy error mapping and graceful shutdown. `createServiceClient`: undici client, 10 s timeout, no automatic retries, forwards the caller's user token and trace context. Injectable clock; zod environment schema (`loadEnv`, AAP 0.6.2); `csrfPreHandler`, which calls identity `POST /internal/v1/csrf/consume` | gateway, all services, stub |
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
| `testing` | Tenant fixtures A, B and umbrella; throwaway schema and roles; token minting; contract assertions; isolation and pooled-connection-reuse suites | all test suites |

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

Exit codes: 0 done, 1 failed, 2 usage or environment error. `npm ci` in a consumer links these into its `node_modules/.bin` from the committed `bin/` wrappers, which run the compiled `dist/<module>/cli.js` once the platform is built (the consumer's `postinstall` builds it). `node <path>/platform/dist/<module>/cli.js` runs the same CLI directly.

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

`test/unit` and `test/contract` need nothing external. `test/isolation` and `test/events` read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` and `PUBSUB_EMULATOR_HOST`, create a throwaway schema and roles per run through `testing`, and skip their database or emulator cases when that server is unreachable.
