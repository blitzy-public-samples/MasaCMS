**SYNTHETIC MODULE**
There is no Masa equivalent; the legacy oracle is in [`legacy-fixtures/`](../../legacy-fixtures/README.md).

# e-signature

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md). Shared components: [`platform/README.md`](../../platform/README.md).

## What it does

- **Signature requests.** A signer uploads a document for one named signer of the site. The request starts `PENDING`; the document's SHA-256 is recorded with it.
- **Typed-name signing.** The designated signer signs by typing their name. The request becomes `SIGNED`, and a request is signed at most once.
- **Audit trail.** Every create and sign appends an entry to the request's audit chain. Each entry's hash covers the previous entry's hash and the entry's sequence number, action, actor, detail and time, so changing any of those, reordering or inserting an entry, or removing one before the end, breaks a link or hash that verification recomputes. Verification establishes that consistency only: removing entries from the end, down to an empty chain, leaves a valid prefix, and because the hashes are unkeyed SHA-256, anyone who can write the trail can recompute a consistent chain. Completeness and authenticity need an independent anchor, such as an entry count or last hash held elsewhere; neither the fixture nor the service keeps one.
- **Verification.** Anyone allowed to read a request's audit can recompute its stored chain, or a copy they hold, and learn whether it is intact and where it first breaks.

| | |
|---|---|
| Folder | `services/e-signature` |
| PostgreSQL schema | `esignature` |
| Local port | 8120 (`OPT2_PORT_E_SIGNATURE` in `harness/repro/ports.env`) |
| Cloud | Cloud Run service `e-signature`, `min_instance_count = 0` (scales to zero) |

## Legacy oracle

| Piece | Where |
|---|---|
| Endpoints | `legacy-fixtures/cfml/modules/esignature.cfc`, reached as `/legacy-fixtures/cfml/api.cfm/esignature/requests[/{id}/<action>]` |
| Tables | `legacy-fixtures/sql/esignature/100_tables.sql`: `synthetic.signature_request`, `synthetic.signature`, `synthetic.audit_entry` |
| Procedure | `legacy-fixtures/sql/esignature/200_usp_audit_append.sql`: `synthetic.usp_audit_append`, reimplemented in [`src/domain/hash-chain.ts`](src/domain/hash-chain.ts) |
| Seed | `legacy-fixtures/sql/esignature/300_seed.sql`: `synthetic.usp_seed_esignature`, loaded by `legacy-fixtures/cfml/seed.cfm` from the fixed-seed dataset; audit rows go through `usp_audit_append` |

The fixture hashes only in SQL; the service reproduces the same bytes in Node, so a chain written on either side verifies on the other.

## Hash chain

Each audit entry stores `prev_hash` and `entry_hash` (32 bytes each).

- **Genesis.** The first entry's `prev_hash` is 32 zero bytes; every later entry's `prev_hash` is the previous entry's `entry_hash`. `seq` runs 1, 2, 3, … per request.
- **Canonical string.** `request_id|seq|action|actor|detail|at`, where:
  - `request_id` is the `char(35)` id (space-padded if shorter, as SQL Server pads it);
  - `actor` is `actor_user_id`, padded to `char(35)` for a stored entry and hashed as sent for a supplied copy;
  - a NULL `actor_user_id` or `detail` renders as the empty string;
  - `at` is `yyyy-MM-ddTHH:mm:ss.fff` in the legacy server's time zone, with milliseconds rounded to SQL Server `datetime` precision (1/300 s), as `@at datetime` stores them. Supplied `at` text that SQL Server cannot convert renders empty.
- **Entry hash.** `entry_hash = SHA-256(prev_hash ‖ UTF-16LE(canonical))`, identical to `HASHBYTES('SHA2_256', @prev_hash + CAST(@canonical AS varbinary(max)))` on the procedure's `nvarchar` canonical value.
- **Actions.** `created` (detail: the document SHA-256) and `signed` (detail: the typed name).
- **Appended row.** `usp_audit_append` returns `entry_id, request_id, seq, action, actor_user_id, detail, at, prev_hash, entry_hash, prev_hash_hex, entry_hash_hex` (the last two lowercase hex). The audit routes answer `entry_id, request_id, seq, action, actor_user_id, detail, at, prev_hash, entry_hash`, with `at` as the hashed text and both hashes as lowercase hex, so their items can be posted back to verify unchanged.
- **Verify.** Recomputes the chain and answers `{valid, entries, brokenat}`. An entry breaks on its position (`seq` differs from its place in the chain), its link (`prev_hash` differs from the previous `entry_hash`, or genesis) or its own hash. `entries` counts every entry; `brokenat` is the `seq` of the first broken entry in chain order, and `0` when `valid`. An empty chain is valid. No expected length or tail is held, so a truncated chain, being an intact prefix, verifies valid, as the fixture's does. The stored chain is read in `seq` order; a supplied copy is checked in array order against the stored request id.

## Roles

| Role | Grants |
|---|---|
| `esignature.signer` | List the site's requests and create requests; sign, read the audit of and verify requests addressed to them |
| `esignature.auditor` | Read the audit and verify any request of the site |

Identity mints both roles from the fixture-seeded Masa groups of the same names in the site's private user pool (`services/identity/config/role-map.json`), and the fixture authorises by those groups, so denials compare one-to-one. Deny by default: every route declares `config.opt2.requires` or `config.opt2.public`, and an undeclared route fails start-up.

## Owned data

Schema `esignature`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with the roles `esignature_owner` (owns every object; FORCE RLS applies to it), `esignature_app` (runtime DML; the service's `PG_USER`) and `esignature_migrator` (applies `db/migrations/*.sql` after `SET ROLE esignature_owner`).

[`opt2/table-ownership.json`](../../opt2/table-ownership.json) is authoritative (rule step 1). A request's tenant is `tenantIdForSite(siteID)`; its signature and audit entries take the tenant of their request.

| Legacy table | Target table (`db/migrations/0001_esignature.sql`) | Notes |
|---|---|---|
| `synthetic.signature_request` | `esignature.signature_request` | `state` is `PENDING` or `SIGNED`, default `PENDING`. The document bytes stay in `document` (`bytea`, the fixture's `varbinary(max)`) and are never returned |
| `synthetic.signature` | `esignature.signature` | At most one per request (unique `request_id`) |
| `synthetic.audit_entry` | `esignature.audit_entry` | Unique `(request_id, seq)`; `prev_hash` and `entry_hash` are 32-byte `bytea`, which the canonical encoding renders as lowercase hex |

E-signature also takes its share of split Masa tables (`db/migrations/0002_extensions.sql`): `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets` and `tclassextenddata` rows whose subtype's `baseTable` is one of the three fixture tables become `esignature.extend_subtype`, `extend_set`, `extend_attribute`, `extend_rc_set` and `extend_data`; `ttrash` `extendObject` rows of those subtypes become `esignature.trash` (`objectstring` kept byte-exact). Class-extension rows take their tenant from `siteID`, else the umbrella tenant; trash rows from `siteID`. They are migrated only: no carried route writes them, so their groups stay `legacy`-authoritative.

- **Platform tables.** `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `inbox`, `consumer_aggregate_version`, and `outbox`, which stays empty because e-signature publishes nothing; the migration position endpoint reads it.
- **Isolation.** Every tenant-owned table carries `tenant_id uuid NOT NULL` with row-level security enabled and forced under `tenant_isolation` on `app.tenant_id`.

## Audit

- Every write commits its `esignature.changelog` row in the same transaction, through the `@opt2/platform/migration-kit` repository hook; an audit append commits its hash-chain entry in that transaction too.
- Appends to one request are serialised by a row lock on the request (`SELECT … FOR UPDATE`), as the procedure serialises them with `UPDLOCK, HOLDLOCK`, so two appends never take the same `seq`.
- Signing takes the same row lock and accepts only a `PENDING` request, so a second or concurrent signature answers 409 `already-signed` and never stores a second signature.

## Routes

Exact paths, operation ids and schemas are in [`contracts/openapi.yaml`](contracts/openapi.yaml).

### Fixture routes

Served under `/legacy-fixtures/cfml/api.cfm/esignature` in the Masa envelope (`method` is `esignature.<resource>[.<action>]`). The gateway routes them `legacy` in `v0001` and `target` from `v0002`; both writes belong to group `grp:esignature.audit_entry` (units `signature_request`, `signature`, `audit_entry`).

| Method | Path | Operation | Requires |
|---|---|---|---|
| `GET` | `/requests` | `fixtureListRequests` | signer; paged, without document bytes |
| `POST` | `/requests` | `fixtureCreateRequest` | signer; `documentName`, `documentBase64`, `signerUserId` |
| `POST` | `/requests/{id}/sign` | `fixtureSignRequest` | signer, and the request's signer; `typedName` |
| `GET` | `/requests/{id}/audit` | `fixtureGetAudit` | auditor, or the request's signer |
| `GET` | `/requests/{id}/verify` | `fixtureVerifyStored` | as audit |
| `POST` | `/requests/{id}/verify` | `fixtureVerifySupplied` | as audit; `entries`, a copy of the chain |

- **Checks.** The routes are `public` on the platform because the handler applies the fixture's own checks in its order: path, site, login, role, existence, validation, state. Before the handler runs, the platform refuses a call to these routes without the caller's invocation credential with 401 `authorization`. `siteid` defaults to the token's site, else `default`; for a logged-in user it must resolve to the token's tenant. Each `POST` consumes a CSRF token through identity (`POST /internal/v1/csrf/consume`) after the role check, with the route's `{id}` as context (empty for `/requests`).
- **Method override.** The `…ByGet`, `…ByPost`, `…ByPut`, `…ByPatch`, `…ByDelete`, `…ByOptions` and `…ByHead` operations answer as the operation `X-HTTP-Method-Override` selects, and 404 `notFound` otherwise. There is no `requests/{id}` read; it answers 404.

### OPT-2 screens

`/v1/esignature/**` serves the screens `web/` renders at `/opt2/admin/e-signature/{requests,request,audit,verify}` and the actions `/opt2/admin-actions/e-signature/{create-request,sign,verify}`. The list shows every request of the site; for one request's detail, audit and verify, an auditor may open any request and a signer only those addressed to them. Each `POST` consumes a CSRF pair through identity after the role and site checks, as the fixture does: the context is empty for the create and the request `{id}` as sent for sign and supplied verify.

| Method | Path | Operation | Requires |
|---|---|---|---|
| `GET`, `POST` | `/v1/esignature/requests` | `listSignatureRequests`, `createSignatureRequest` | signer |
| `GET` | `/v1/esignature/requests/{id}` | `getSignatureRequest` | signer or auditor |
| `POST` | `/v1/esignature/requests/{id}/sign` | `signRequest` | signer |
| `GET` | `/v1/esignature/requests/{id}/audit` | `getAuditChain` | signer or auditor |
| `GET`, `POST` | `/v1/esignature/requests/{id}/verify` | `verifyChain`, `verifySuppliedChain` | signer or auditor |

### Internal and managed routes

| Method | Path | Requires | Does |
|---|---|---|---|
| `POST` | `/internal/v1/events/e-signature.programs-sites.site.changed.v1` | `service:pubsub-invoker` (local push key locally) | Push delivery into `esignature.tenant_registry` (`pushSiteChanged`) |
| `GET`, `POST` | `/internal/v1/migration/{apply,export,changes,position,watermark,gate}` | `platform.migration` | Backfill, feed, reconciliation and unit gates of the owned units |
| `GET` | `/healthz` | public, invocation credential optional | Liveness probe |

## Events

- **Consumes** `programs-sites.site.changed.v1` into `esignature.tenant_registry`, which resolves site ids and pools to tenants.
- **Produces** no topic, so it has no outbox sweep and no task queue; its publisher carries only the consumer's dead letters.

## Other services

- **People.** Whether a signer exists as a Type 2 user of the site's public or private user pool comes only from people's `readPoolUser` (`GET /internal/v1/users/pool-user`, [`services/people/contracts/openapi.yaml`](../people/contracts/openapi.yaml)), through [`src/legacy/people-client.ts`](src/legacy/people-client.ts) and the generated client `src/generated/clients/people.ts`. It stands in for the fixture's `userManager.read`. E-signature never reads another schema.
- **Identity.** Validates and consumes the CSRF token of each fixture `POST` and `/v1` write.

## Files

The service stores no objects and issues no download URLs: document bytes live in `esignature.signature_request.document` and no route returns them. The bucket `esignature-documents` and the gateway entry `/opt2/files/esignature-documents/**` are reserved for signed document artefacts; such an artefact would be stored through `@opt2/platform/storage` and downloaded through a v4 signed URL valid for 15 minutes (locally, an HMAC-signed URL under `/opt2/files/esignature-documents/…`).

## Run and test

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm start               # node dist/main.js
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
```

- **Configuration.** `esignatureEnvSchema` in `src/app.ts`: `baseEnvSchema` of `@opt2/platform/service-kit` ([details](../../platform/README.md#configuration)) with `OPT2_SERVICE_NAME=e-signature`, `OPT2_DB_AUTH`, `PG_DATABASE` and the `OPT2_SERVICE_URLS` entries `identity` and `people` required; start-up fails naming each one missing. Locally `harness/repro/up.sh` starts it with `PORT=8120` and `PG_USER=esignature_app`.
- **Test dependencies.** The security and contract suites need nothing external. The PostgreSQL-backed suites read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, create a throwaway schema and roles through `@opt2/platform/testing`, are skipped when `PG_HOST` is unset and fail when PostgreSQL is unreachable. No suite needs the Pub/Sub emulator: the test helpers (`test/helpers/app.ts`) give every app a capturing publisher, and push deliveries are injected in process.
- **Packaging.** The `Dockerfile` is the Cloud Run artefact, built (not pushed) in CI. In the cloud the service runs with internal-only ingress and Cloud SQL IAM authentication as a member of `esignature_app` (`infra/terraform/`, plan only).

## Parity evidence

The GS-ES scenarios in `harness/golden/catalogue.yaml` are captured from the fixture and replayed through the gateway:

| Scenario | Covers |
|---|---|
| GS-ES-01 | Typed-name signing: create, sign, a repeated sign (409 `already-signed`), list |
| GS-ES-02 | Audit chain; verification of the stored chain and of an intact copy; tamper detection on a corrupted copy |

Chain hashes cover the request id and `at`, which differ on every run, so the comparator checks each `entry_hash` against the procedure's formula over its own entry and then replaces both hashes with scenario ordinals under the `chain-hash` rule of `harness/golden/normalise.yaml`; an entry that fails the check reads `<hash:mismatch>` and stays a difference.

Each behaviour's code and test are listed in [`TRACEABILITY.md`](TRACEABILITY.md).
