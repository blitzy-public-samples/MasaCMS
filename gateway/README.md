# OPT-2 gateway and compatibility dispatcher
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The gateway is the strangler-fig front door of OPT-2. Every browser and API request enters here and is sent either to a new service or to the unchanged Masa CMS, according to the active cut-over version. Routes move one cut-over version at a time, and no route is hard-wired to a target in code.

## What it does

- **Only public entry point.** Cloud Run `INGRESS_TRAFFIC_ALL` with `allUsers` as invoker; locally port 8100 (`OPT2_PORT_GATEWAY` in `harness/repro/ports.env`). Because ingress is public, the gateway verifies invocation credentials itself.
- **One route key.** Keys come from one module, `platform/src/legacy-compat/route-key.ts` (`@opt2/platform/legacy-compat`), so every consumer shares one precedence. Live requests: the dispatcher keys every edge request but the relay's (`/opt2/svc/**`) with `routeKeyForRequest` and the variants of `cutover/variants.json`, and the most specific key wins; the golden coverage check keys scenario requests with the same function. Precomputed keys: the inventory keys entry points with `routeKeyForEntryPoint`, which delegates to `routeKeyForRequest`; `src/cutover/build-groups.ts` keys nothing itself and groups the inventory's keys, compared in `normaliseRouteKey` form. `test/route-key-parity.test.ts` runs the shared conflict table through the matcher and asserts its keys equal `routeKeyForRequest`'s.
- **Routing** by the matched entry of the active version:

| Matched entry | Destination |
|---|---|
| `state=target`, API, fixture, job or `/opt2/**` family | The owning service, from `OPT2_SERVICE_URLS` |
| `state=target`, admin family | `web`, by the action's inventoried response mode: `page` → `/admin/<circuit>/<action>`; `fragment`, `json`, `download` → `/admin-raw/<circuit>/<action>`; `redirect` → `/admin-actions/<circuit>/<action>` |
| `state=legacy`, or no entry | Masa at `LEGACY_ORIGIN`: `Host` preserved, `X-Forwarded-*` added, request and response bytes unchanged except the session mapping below |
| `/gateway/legacy-bridge/**` | 404, answered by the gateway |
| `/opt2/svc/<service>/…` | The web service-call relay (see [Internal API](#internal-api)) |

- **Legacy URLs stay.** The browser URL is always the legacy one; web receives the original request target in `X-Opt2-Original-Url`, and builds links, form actions and redirects in legacy form.

## Cut-over table

| File | Role |
|---|---|
| `cutover/cutover-table.schema.json` | Contract of every version file |
| `cutover/variants.json` | Request-decidable variant predicates, such as `admin:cusers.update{type=2,action=add}`, `{photo}` and `{upload=image}` |
| `cutover/groups.json` | Write-authority groups, generated from `opt2/inventory/legacy-inventory.json` and `opt2/table-ownership.json` by `npm run cutover:groups` |
| `cutover/versions/v0001.json` | Every group `legacy`, every inventoried route `legacy`; only `/opt2/stub/**` (plus the gateway's own `/gateway/legacy-bridge/**` and web's `/_next/**`) is `target` |
| `cutover/versions/v0002.json` | Parity milestone: a group goes `target` when it has a carry write entry and none of its units keeps an unprevented non-gateway writer; a carry entry goes `target` when its units allow it; halted or `fix`-pending write variants are `legacy-write`. Committed after parity replay |
| `cutover/versions/v0003.json` | Rollback rehearsal: the roster group set `R` back to `legacy`, named in `rollbackRefs` with `opt2/reports/reconciliation/rollback-before.json` and its evidence |

- **`v0002` as committed.** 12 of 54 groups are `target`. Six groups with carry write entries stay `legacy` because their units have `appstart` writers that `src/cutover/prevented-writers.ts` does not close, chiefly Masa's start-up bundle deploy (`getToWork*` in `core/mura/publisher.cfc`): `grp:content.approval_action`, `grp:identity.credential`, `grp:identity.permission`, `grp:people.user_favorite`, `grp:programs_sites.image_size`, `grp:programs_sites.site`. `grp:identity.credential` holds `admin:clogin.login`, so sessions stay legacy-primary (see [Sessions and CSRF](#sessions-and-csrf)).
- **File fields:** `tableVersion`, `previous`, `sourceSha`, `createdAt`, `groupAuthority` (group id → `legacy|target`), `rollbackRefs`, `entries`.
- **Entry fields:** `route` (key with any variant), `owningService`, `tableVersion`, `state` (`legacy|target`), `kind` (`read|write|legacy-write|job|static`), `group` (for `write` entries), `units[]`, `disposition` (from the inventory).
- **Validation** (`src/cutover/validate.ts`; finding rule ids in brackets), run by `npm run cutover:validate` in CI mode and again at activation:
  - every inventoried route key appears exactly once [`route-once`];
  - `target` only for carry entries; withheld and legacy-served entries never [`target-only-carry`, `withheld-never-target`, `legacy-served-never-target`];
  - a `write` entry is `target` exactly when its group is [`write-follows-group`];
  - a `read` entry is `target` only when every unit in `units[]` is `target`-authoritative [`read-follows-units`];
  - `legacy-write` entries are `legacy` in every version; halted variants are `legacy-write` [`legacy-write-always-legacy`, `halted-is-legacy-write`, `halted-read-legacy`];
  - the `job` entry (`/_api/sitemonitor`) is `legacy` in `v0001` only [`job-state`];
  - no `target`-authoritative unit keeps an unprevented non-gateway writer [`unprevented-writer`];
  - a group returns from `target` to `legacy` only with a `rollbackRefs` entry naming a zero-difference reconciliation report [`rollback-evidence`];
  - plus schema, pinned `sourceSha`, `previous` chain, group and variant references [`schema`, `source-sha`, `previous-chain`, `group-unknown`, `group-authority`, `variant-undeclared`, `route-not-inventoried`].
- **Regeneration.** `npm run cutover:groups` and `npm run cutover:versions` rewrite the generated files. Run without `--write` (for example `npx tsx src/cutover/build-groups.ts`), each script only diffs and exits 1 on a difference. `build-versions.ts --fixtures available|unavailable|auto` defaults to `auto`, which reads `${OPT2_STATE_DIR}/fixtures.json`.

## Activation, freeze and in-flight writes

State lives only in the `gateway` schema (`db/migrations/`), never in a file or variable:

| Table | Holds |
|---|---|
| `gateway.cutover_state` | Active version, previous version and `epoch` (one row) |
| `gateway.cutover_freeze` | Frozen route keys and the epoch of each freeze |
| `gateway.instance` | Each instance's heartbeat and last seen epoch |
| `gateway.inflight` | Forwarded writes not yet completed: instance, request id, route, side (`legacy` or `target`), window |
| `gateway.legacy_jar` | Legacy ColdFusion cookies and session mode per identity session |
| `gateway.session_barrier` | Recorded and pending write positions per session and owner |

- Activation validates the version, requires its `previous` to equal the active version, and commits a new `epoch`. Freeze and unfreeze also commit a new epoch.
- Every write reads the epoch before routing; instances refresh their cached version and heartbeat every second. With no active version, or a cached one older than two seconds, every edge request the cut-over table dispatches (`edge*`) answers the legacy-shaped 503; `GET /healthz`, the internal operations (cut-over activate, freeze, unfreeze and status, in-flight orphan clearing, legacy-session mark-used) and the web service-call relay (`/internal/v1/relay/**` and its `/opt2/svc/**` alias) keep answering.
- An operation is visible only once every live instance reports the new epoch; the transition procedure waits for this.
- Freezing never changes where an entry routes. A frozen entry's requests wait up to 30 s, then answer the legacy-shaped 503.
- Only the forwarding instance removes its `inflight` row. A dead instance's row is cleared only by evidence, never by time: `gates-closed` for target-bound writes (the owner's gates closed on the route's units), `legacy-restart` for legacy-bound writes (a controlled ColdFusion restart).

## Write windows and the read-after-write barrier

- **Write windows.** `legacy-write` entries always run on legacy. When any of their units is `target`-authoritative, `src/dispatcher/write-window.ts` first asks migration to open a window (`POST /internal/v1/windows`), forwards the request unchanged, buffers the legacy response, and reports completion (`POST /internal/v1/windows/{windowId}:complete`) before answering.
- **Barrier.** A target write response's `X-Opt2-Write-Position` is stripped from the client response and stored in `gateway.session_barrier`; a target write is declared there before it is forwarded. Before any legacy-bound request of that session, the gateway calls migration `POST /internal/v1/projection/await` with a 5 s bound and answers the legacy-shaped 503 if legacy does not yet hold every position.

## Fail closed

- A `target` entry whose owner refuses the connection, times out, or answers 502, 503 or 504 answers the legacy-shaped 503: the JSON API envelope with `error` for JSON, AJAX, REST and OAuth, fixture, site-monitor, stub and relay routes; the legacy error page for admin routes and for `/_api/feed` and `/_api/render`, whose legacy failures are not enveloped.
- Nothing is retried against legacy, reads included.
- A `legacy-write` entry whose window cannot open answers the same 503 before legacy executes anything.

## Sessions and CSRF

Identity owns all session state; the gateway owns only the cookie mapping and the barriers (`src/session/`).

- **Mode.** Chosen by the authority of the generated group containing `clogin.login`:
  - *legacy-primary* while it is `legacy`: legacy session cookies pass through unchanged, and target-bound requests are described to identity through the bridge (`op=describe`);
  - *target-primary* while it is `target`: identity issues the session cookies with the legacy names and attributes (`CFID`, `CFTOKEN`, `JSESSIONID`), and the legacy cookies of the session are kept in `gateway.legacy_jar` and sent only to legacy. Legacy `Set-Cookie` headers for session cookies are absorbed into the jar and re-emitted as the target session cookie.
- **Hydration.** The first legacy-bound request of a target-primary session installs identity's login-time snapshot and CSRF ledger in the legacy session (`op=hydrate`), without a login or database write.
- **CSRF.** Both sides share one secret per session. Claims on tokens sent to legacy go through identity (`POST /internal/v1/csrf/claims`, `…/claims:settle`): only tokens legacy actually consumed (`op=usedSince`) become used, the rest are released. Identity marks tokens consumed on the target side in the legacy session through `POST /internal/v1/legacy-sessions/{sid}:mark-used`.
- **Adoption.** At cut-over, a request with legacy cookies mapped to no target session is adopted (`POST /internal/v1/sessions:adopt`); moving back to legacy-primary answers target cookies with the jar's legacy values.
- **Invalidation.** Logout on either side ends both sessions (`op=end`, `POST /internal/v1/sessions/{sid}:end`). On a session epoch change, the legacy session is re-hydrated from the new snapshot.
- **User tokens.** A site-scoped token per (session, site) from identity `POST /internal/v1/tokens`, cached until expiry or an epoch change, attached as `Authorization: Bearer` to target-bound requests. Inbound `X-Serverless-Authorization` and `X-Opt2-*` headers are always stripped, and `Authorization` once exchanged for a user token. Session state is re-checked with identity (`GET /internal/v1/sessions/{sid}/state`) at most once per second.

## Legacy bridge

`legacy-bridge/cfml/` is CFML served by the legacy web root through an `Application.cfc` that extends `muraWRM.Application`: session describe, hydrate, mark-used and end, site-monitor steps, scheduler hand-off, site registry and file store. It accepts only requests carrying an HMAC bridge assertion signed with `OPT2_BRIDGE_HMAC_KEY`, which only the gateway and the migration service hold; from outside, `/gateway/legacy-bridge/**` answers 404 at the gateway. See [`legacy-bridge/README.md`](legacy-bridge/README.md).

## Internal API

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). Every operation except `/healthz` and the edge requires an invocation credential carrying the listed role.

| Operation | Path | Caller and role |
|---|---|---|
| `healthz` | `GET /healthz` | Public |
| `cutoverActivate` | `POST /internal/v1/cutover/activate` | `opt2-migrate transition` or an operator, `platform.operator` |
| `cutoverFreeze`, `cutoverUnfreeze` | `POST /internal/v1/cutover/freeze`, `POST /internal/v1/cutover/unfreeze` | `opt2-migrate transition` or an operator, `platform.operator` |
| `cutoverStatus` | `GET /internal/v1/cutover/status` | `platform.operator` or `platform.migration` |
| `inflightClearOrphans` | `POST /internal/v1/inflight:clear-orphans` | `platform.operator` or `platform.migration` |
| `legacySessionMarkUsed` | `POST /internal/v1/legacy-sessions/{sid}:mark-used` | Identity, `service:identity` |
| `relayGet` … `relayDelete` | `/internal/v1/relay/{service}/{path}` (also reached as `/opt2/svc/{service}/{path}`) | Web, `service:web`; the user token passes on only with web's credential |
| `edge*` | `/{path}` | Public; dispatched by the active version |

## Environment

`@opt2/platform/service-kit` `baseEnvSchema` (see [`platform/README.md`](../platform/README.md#configuration)) plus:

| Variable | Use |
|---|---|
| `LEGACY_ORIGIN` | Masa origin; locally `http://127.0.0.1:${PORT}` of ColdFusion |
| `OPT2_CUTOVER_DIR` | Relocates the cut-over directory; default `gateway/cutover` |
| `OPT2_BRIDGE_HMAC_KEY` | Bridge assertion key; locally generated into `${OPT2_STATE_DIR}/secrets/`, in the cloud the Secret Manager secret `legacy-bridge-hmac` |
| `MURA_APPRELOADKEY` | Masa's reload parameter name for the route key; default `appreload` |

- `OPT2_SERVICE_URLS` must name the ten services and `web`, plus `stub` locally; migration comes from `OPT2_MIGRATION_URL` or the map.
- The active version is read from the `gateway` schema, never from the environment.
- The database role is `gateway_app`, with access to the `gateway` schema only.

## Build, test, run

```sh
npm ci                     # installs and builds ../platform through postinstall
npm run build              # generates contract types into src/generated/, then tsc -> dist/
npm test                   # vitest with coverage, >= 90% statements
npm run test:contract      # test/contract
npm run test:security      # test/security: route and role matrix through app.inject
npm run cutover:groups     # regenerates cutover/groups.json
npm run cutover:versions   # regenerates cutover/versions/v0001-v0003.json
npm run cutover:validate   # validates every committed version
npm start                  # node dist/main.js
```

- Suites under `test/cutover/` and `test/session/` that need PostgreSQL use a throwaway schema from the `PG_*` variables and skip when none is reachable; the rest use in-process doubles.
- Locally, `harness/repro/up.sh` starts the gateway natively with `PORT=8100`. The `Dockerfile` is the Cloud Run artefact, built but never pushed in CI.
