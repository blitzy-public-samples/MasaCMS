# OPT-2 gateway and compatibility dispatcher
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The gateway is the strangler-fig front door of OPT-2. Every browser and API request enters here and is sent either to a new service or to the unchanged Masa CMS, according to the active cut-over version. Routes move one cut-over version at a time, and no route is hard-wired to a target in code.

## What it does

- **Only public entry point.** Cloud Run `INGRESS_TRAFFIC_ALL` with `allUsers` as invoker; locally port 8100 (`OPT2_PORT_GATEWAY` in `harness/repro/ports.env`). Because ingress is public, the gateway verifies invocation credentials itself.
- **One route key.** Keys come from one module, `platform/src/legacy-compat/route-key.ts` (`@opt2/platform/legacy-compat`), so every consumer shares one precedence. Live requests: the dispatcher keys every edge request but the relay's (`/opt2/svc/**`) with `scannedRouteKey` (`platform/src/legacy-compat/scanned-route-key.ts`), which runs `routeKeyForRequest` and the variants of `cutover/variants.json` on the url and form scopes as Masa's start-up Portcullis scan leaves them (a reload is decided on the url as sent), and the most specific key wins. A request whose scan outcome ColdFusion's runtime decides, an admin scan fault included, keys the `{scriptprotect=fault}` variant: legacy serves it under the entry its key has without that variant, a writer as `legacy-write` (`EX-ADMIN-SCAN-FAULT` in [`opt2/exceptions-list.md`](../opt2/exceptions-list.md)). The dispatcher and the golden coverage check call it through `haltedRouteKey` (`platform/src/legacy-compat/request-halts.ts`), which runs `textHaltedRouteKey` (`platform/src/legacy-compat/unstorable-text.ts`). That halts the same way a request carrying a NUL legacy stores (`{text=nul}`: in a JSON API, REST or fixture JSON object body, a fixture path item other than a finance, survey or e-signature path id, whose services find no row for it as legacy does, a JSON API or REST path value or Basic credential, or an admin path pair kept in `rc`, but never on the reporting export create or the survey schedule, whose legacy `cfthread` job and ACF tasks would outlive the write window and whose services answer a NUL as legacy does; `EX-UNSTORABLE-TEXT-NUL`) and a fixture write storing request text whose JSON object body holds an unpaired surrogate (`{text=surrogate}`: finance, communications, e-signature, survey and timesheet-day writes; `EX-UNSTORABLE-TEXT-SURROGATE`): PostgreSQL text cannot hold or bind that text as legacy does. `haltedRouteKey` adds two halts the request decides: a Site Manager list whose `siteid` names no site the gateway's site registry holds (`admin:carch.list{siteid=unregistered}`, `EX-CARCH-LIST-UNREGISTERED-SITE`), and an admin login one of whose redirect values legacy sends with a `Location` byte Node refuses (`admin:clogin.login{location=raw}`, `EX-LOGIN-LOCATION-BYTES`). Precomputed keys: the inventory keys entry points with `routeKeyForEntryPoint`, which delegates to `routeKeyForRequest`; `src/cutover/build-groups.ts` keys nothing itself and groups the inventory's keys, compared in `normaliseRouteKey` form. `test/route-key-parity.test.ts` runs the shared conflict table through the matcher and asserts its keys equal `routeKeyForRequest`'s.
- **Routing** by the matched entry of the active version:

| Matched entry | Destination |
|---|---|
| `state=target`, API, fixture, job or `opt2` family (`/opt2/**` and the synthetic services' own `/v1/` resource paths) | The owning service, from `OPT2_SERVICE_URLS` |
| `state=target`, admin family | `web`, by the action's inventoried response mode: `page` → `/admin/<circuit>/<action>`; `fragment`, `json`, `download` → `/admin-raw/<circuit>/<action>`; `redirect` → `/admin-actions/<circuit>/<action>` |
| `state=legacy`, or no entry | Masa at `LEGACY_ORIGIN`: `Host` preserved, `X-Forwarded-*` added, request and response bytes unchanged except the session mapping below. Request heads are admitted up to legacy's own 1 MiB limit; a head within the size of the gateway's added forwarding headers (`X-Forwarded-*`, trace context) below that limit reaches legacy over it and gets legacy's own bare 400. A login halted for its redirect bytes (`{location=raw}`) is forwarded through Node's lenient parser, which reads the `Location` bytes undici refuses (`src/dispatcher/lenient-response.ts`), and each such line is written byte for byte. An `opt2`-family request is routed as the legacy entry point that serves it (`page:render`, a `doaction`, `reload:application`) |
| `/gateway/legacy-bridge/**` | 404, answered by the gateway |
| Files under the OPT-2 folders (`/harness`, `/services`, `/migration`, `/platform`, `/infra`, `/web`, `/gateway`, `/.github/workflows`, `/opt2`; static files of `/legacy-fixtures`), however spelled, a reload in front included | 404, answered by the gateway; fixture templates and the longer `/opt2/**` entries keep routing |
| `/opt2/svc/<service>/…` | The web service-call relay (see [Internal API](#internal-api)) |

- **Bodies legacy's servlet container rejects.** A POST body that legacy's container answers itself before any CFML runs (`UnreadableBodyError.legacyRejects` in `src/dispatcher/body.ts`: a multipart boundary missing, unclosed or outside ASCII, a body not opening with its boundary, a part without its closing boundary, disposition or `Content-Type` value, an illegal charset name) goes to `LEGACY_ORIGIN` as sent while a version is active, whatever its entry, and legacy's answer passes through as for any legacy forward. Legacy writes nothing for it, so no session mapping, CSRF claim, barrier, in-flight row or write window applies. Requests keyed, without the body, as the relay alias or a `static`, `opt2` or `bridge` route that legacy does not serve fail closed instead.
- **Legacy request start on target responses.** Except for `static` (`/_next/**`), `opt2` and `bridge` routes, a target-served response gets the servlet container's `Content-Encoding: identity` when the client's `Accept-Encoding` negotiates identity and the response names no encoding, and, on a session-managed path (not `/_api/rest/`), Masa's request-start `MXP_TRACKINGID` and `mobileFormat` cookies (`requestStartSetCookies` in `@opt2/platform/legacy-compat`), computed from the client's own request, after every other `Set-Cookie` and in place of any of the same name, except that an `MXP_TRACKINGID` owed from legacy's session is kept. Fail-closed 503s and the relay get neither.
- **Legacy URLs stay.** The browser URL is always the legacy one; web receives the original request target in `X-Opt2-Original-Url`, and builds links, form actions and redirects in legacy form.
- **Absolute URLs address the gateway.** Masa builds them from the preserved `Host` and its configured port, so legacy runs with `MURA_PORT` and `MURA_PROXYPORT` equal to the gateway port (set by `harness/repro/server.json.template`), and its `Mura.init` paths and redirect `Location` headers name the gateway. `process_env` (`harness/repro/lib/processes.sh`) hands the target processes the same two values over any the caller exports, so their absolute URLs name the gateway too. The platform-proof check `unmoved-to-legacy` fails on any forwarded response that names `LEGACY_ORIGIN`'s port.

## Cut-over table

| File | Role |
|---|---|
| `cutover/cutover-table.schema.json` | Contract of every version file |
| `cutover/variants.json` | Request-decidable variant predicates, such as `admin:cusers.update{type=2,action=add}`, `{photo}`, `{upload=image}` and the halted `admin:carch.list{sharedid}`, a Site Manager sort naming a content id every site shares (`{param, listItemIn}`, EX-CARCH-SORT-SHARED-ID) |
| `cutover/groups.json` | Write-authority groups, generated from `opt2/inventory/legacy-inventory.json` and `opt2/table-ownership.json` by `npm run cutover:groups` |
| `cutover/versions/v0001.json` | Every group `legacy`, every inventoried route `legacy`; only `/opt2/stub/**` (plus the gateway's own 404 entries for `/gateway/legacy-bridge/**` and the OPT-2 folders, and web's `/_next/**`) is `target` |
| `cutover/versions/v0002.json` | Parity milestone: a group goes `target` when it has a carry write entry and none of its units keeps an unprevented non-gateway writer; a carry entry goes `target` when its units allow it; halted or `fix`-pending write variants are `legacy-write`. Committed after parity replay |
| `cutover/versions/v0003.json` | Rollback rehearsal: the roster group set `R` back to `legacy`, named in `rollbackRefs` with `opt2/reports/reconciliation/rollback-before.json` and its evidence |

- **`v0002` as committed.** 16 of 96 groups are `target`, with 151 `target` entries: `grp:communications.delivery_status`, `grp:communications.message_template`, `grp:content.approval_action`, `grp:content.comment`, `grp:esignature.audit_entry`, `grp:finance.attachment`, `grp:finance.record`, `grp:identity.credential`, `grp:identity.permission`, `grp:people.person_archive`, `grp:programs_sites.site`, `grp:reporting.export_job`, `grp:surveys.survey`, `grp:surveys.survey_response`, `grp:surveys.survey_target`, `grp:timesheets.approval_action`. These are the 17 groups with carry write entries except `grp:programs_sites.image_size`. `src/cutover/prevented-writers.ts` closes the non-request writers of their units as the inventory records them at the writing statement: those of Masa's start-up bundle deploy (guarded by `fileExists(local.bundleLoc)`, and the reviewed bundleable-bean save of `getToWork` in `core/mura/publisher.cfc`), project-site creation and plugin discovery by their start-up guard conjuncts, the theme-config site save at `core/mura/extend/extendManager.cfc:2016-2018`, and every scheduler writer the siteMonitor run reaches (route key `sitemonitor:run`). `grp:programs_sites.image_size` stays `legacy` because the theme-config image-size upsert (`settingsImageSizeBean.save` through `core/mura/extend/extendManager.cfc:1998-2012`) runs on every start-up, reload and re-initialisation, and nothing closes it. `grp:identity.credential` holds `admin:clogin.login`, so sessions are target-primary under `v0002`. Each synthetic module's `opt2:/opt2/admin/<module>/**` and `opt2:/opt2/admin-actions/<module>/**` entries follow the units its screens read and its actions write (`SYNTHETIC_MODULES` in `src/cutover/build-versions.ts`); all are `target` except timesheets', whose screens read `timesheets.timesheet`, a unit no carry entry writes. `v0003` returns `R` (`grp:identity.credential`, `grp:people.person_archive`) to `legacy`, which makes sessions legacy-primary again (see [Sessions and CSRF](#sessions-and-csrf)).
- **File fields:** `tableVersion`, `previous`, `sourceSha`, `createdAt`, `groupAuthority` (group id → `legacy|target`), `rollbackRefs`, `entries`.
- **Entry fields:** `route` (key with any variant), `owningService`, `tableVersion`, `state` (`legacy|target`), `kind` (`read|write|legacy-write|job|static`), `group` (for `write` entries), `units[]`, `disposition` (from the inventory).
- **Validation** (`src/cutover/validate.ts`; finding rule ids in brackets), run by `npm run cutover:validate` in CI mode and again at activation:
  - every inventoried route key appears exactly once [`route-once`];
  - `target` only for carry entries; withheld and legacy-served entries never [`target-only-carry`, `withheld-never-target`, `legacy-served-never-target`];
  - a `write` entry is `target` exactly when its group is [`write-follows-group`];
  - a `read` entry is `target` only when every unit in `units[]` is `target`-authoritative [`read-follows-units`];
  - `legacy-write` entries are `legacy` in every version; halted variants are `legacy-write` [`legacy-write-always-legacy`, `halted-is-legacy-write`, `halted-read-legacy`];
  - a `target` `rest:` entry has a `legacy` entry for a variant declared on `{sessionManaged: true}` alone, such as `{session}`, since legacy serves a REST call session-managed when `path_info` keeps a spelling of `index.cfm` the container does not map (EX-REST-INDEX-SESSION) [`rest-session-legacy`];
  - a `target` `rest:` entry has a `legacy` entry for a variant declared on `{startupSiteId: true}` alone, such as `{siteid}`, since legacy fails a sessionless REST call in `onRequestStart` when its form or url scope carries a `siteid` naming a site (EX-REST-SITEID-STARTUP) [`rest-siteid-legacy`];
  - the `job` entry (`/_api/sitemonitor`) is `legacy` in `v0001` only [`job-state`];
  - no `target`-authoritative unit keeps an unprevented non-gateway writer [`unprevented-writer`];
  - a group returns from `target` to `legacy` only with a `rollbackRefs` entry naming a zero-difference reconciliation report [`rollback-evidence`];
  - plus schema, pinned `sourceSha`, `previous` chain, group and variant references [`schema`, `source-sha`, `previous-chain`, `group-unknown`, `group-authority`, `variant-undeclared`, `route-not-inventoried`].
- **Regeneration.** `npm run cutover:groups` and `npm run cutover:versions` rewrite the generated files. Run without `--write` (for example `npx tsx src/cutover/build-groups.ts`), each script only diffs and exits 1 on a difference. `build-versions.ts --fixtures available|unavailable|auto` defaults to `auto`, which reads `${OPT2_STATE_DIR}/fixtures.json`. `unavailable` adds to `v0002` and `v0003` one write entry `opt2:<prefix>/**`, `target` in `v0002`, per `/v1/` resource prefix of each synthetic service (`SYNTHETIC_V1_PREFIXES` in `route-key.ts`: `/v1/messages` and `/v1/templates` for communications, `/v1/esignature`, `/v1/finance`, `/v1/reporting`, `/v1/surveys`, `/v1/timesheets`); `v0001` is the same in both builds.

## Activation, freeze and in-flight writes

State lives only in the `gateway` schema (`db/migrations/`), never in a file or variable:

| Table | Holds |
|---|---|
| `gateway.cutover_state` | Active version, previous version and `epoch` (one row) |
| `gateway.cutover_freeze` | Frozen route keys and the epoch of each freeze |
| `gateway.instance` | Each instance's heartbeat and last seen epoch |
| `gateway.inflight` | Forwarded writes not yet completed: instance, request id, route, side (`legacy` or `target`), window, and when the instance abandoned it |
| `gateway.legacy_jar` | Legacy ColdFusion cookies, session mode and last activity per identity session. Activity is recorded at most once a minute when a state check finds the session active; each new jar purges up to 100 jars idle for Masa's `sessionTimeout` plus two minutes, marked for a pending identity end or not, with their barrier positions recorded as long ago |
| `gateway.session_barrier` | Recorded and pending write positions per session and owner |

- Activation validates the version, requires its `previous` to equal the active version, and commits a new `epoch`. Freeze and unfreeze also commit a new epoch.
- Every write reads the epoch before routing; instances refresh their cached version and heartbeat every second. With no active version, or a cached one older than two seconds, every edge request the cut-over table dispatches (`edge*`) answers the legacy-shaped 503; `GET /healthz`, the internal operations (cut-over activate, freeze, unfreeze and status, in-flight orphan clearing, legacy-session mark-used, legacy site paths, the legacy Version menu facts) and the web service-call relay (`/internal/v1/relay/**` and its `/opt2/svc/**` alias) keep answering.
- An operation is visible only once every live instance reports the new epoch; the transition procedure waits for this.
- Freezing never changes where an entry routes. A frozen entry's requests wait up to 30 s, then answer the legacy-shaped 503.
- Only the forwarding instance removes its `inflight` row, when the response completes. A target exchange that ends while the owner may still commit (a timeout, or a broken response) marks its row abandoned instead. A row is an orphan when its instance is dead or it is abandoned, and the v2 cut-over status (`cutoverStatusV2`) reports it `orphaned`; the v1 status keeps its payload, grouped by instance, route and side. An orphan is cleared only by evidence, never by time: `gates-closed` for target-bound writes (the owner's gates closed on the route's units), `legacy-restart` for legacy-bound writes (a controlled ColdFusion restart).

## Write windows and the read-after-write barrier

- **Write windows.** `legacy-write` entries always run on legacy. When any of their units is `target`-authoritative, `src/dispatcher/write-window.ts` first asks migration to open a window (`POST /internal/v1/windows`), forwards the request unchanged, buffers the legacy response, and reports completion (`POST /internal/v1/windows/{windowId}:complete`) before answering.
- **Probed writes.** Two inventoried legacy writes depend on stored state the request does not show (`src/dispatcher/request-writes.ts`): the 404 handler's cleanup of an orphan `tcontentfilenamearchive` row, and the remember-me login of a static-family request, which runs only when legacy runs CFML for it. When either write's units add a `target`-authoritative unit to the request's window, the gateway asks once its barrier is awaited: migration `POST /internal/v1/probes/orphan-archive` with every filename the render can look up, render404's `404` included for page, static, render, asset and feed requests, and the bridge's `site.cfm?op=static` with the decoded path. A `true` answer, or no answer, routes the request again with a window over those units too.

- **Barrier.** A target write response's `X-Opt2-Write-Position` is stripped from the client response and stored in `gateway.session_barrier`; a target write is declared there before it is forwarded. Before any legacy-bound request of that session, the gateway calls migration `POST /internal/v1/projection/await` with a 5 s bound and answers the legacy-shaped 503 if legacy does not yet hold every position.

## Fail closed

- A `target` entry whose owner refuses the connection, times out (40 s: the owner's 30 s gate wait plus the 10 s call bound), or answers 502, 503 or 504 answers the legacy-shaped 503: the JSON API envelope with `error` for JSON, AJAX, REST and OAuth, fixture, site-monitor, stub and relay routes; the legacy error page for admin routes and for `/_api/feed` and `/_api/render`, whose legacy failures are not enveloped.
- Any other owner answer, web's included and 500 among them (legacy's `500 An Error Occurred`), passes through with its status and reason phrase.
- Nothing is retried against legacy, reads included.
- A `legacy-write` entry whose window cannot open answers the same 503 before legacy executes anything.
- A fixture route's envelope `method` is the one `api.cfm` reads from the path: `<module>.<resource>[.<action>][.<tail>]` lower-cased, a CF UUID tail left out, and `invalid` outside that grammar.
- Each fail-closed 503 writes one `fail-closed: <cause>` line whose message names what failed and the owner where one is known, with the route key, `httpMethod`, `statusCode` 503 and the cause's `error`. It is ERROR for an unavailable owner or dependency and for a gateway fault, and WARNING for a freeze outlasting its wait, a body the gateway cannot read (a charset it does not decode, or one legacy rejects on a route legacy does not serve or while no version is active) or a path the forwarder rejects.

## Sessions and CSRF

Identity owns all session state; the gateway owns only the cookie mapping and the barriers (`src/session/`).

- **Mode.** Chosen by the authority of the generated group containing `clogin.login`:
  - *legacy-primary* while it is `legacy`: legacy session cookies pass through unchanged, and target-bound requests are described to identity through the bridge (`op=describe`);
  - *target-primary* while it is `target`: identity issues the session cookies with the legacy names and attributes (`CFID`, `CFTOKEN`, `JSESSIONID`), and the legacy cookies of the session are kept in `gateway.legacy_jar` and sent only to legacy. Legacy `Set-Cookie` headers for session cookies are absorbed into the jar and re-emitted as the target session cookie.
- **Hydration.** The first legacy-bound request of a target-primary session installs identity's login-time snapshot and CSRF ledger in the legacy session (`op=hydrate`), without a login or database write.
- **Shared values.** The session values target-served and legacy-served admin screens share (`flatViewArgs`, `session.mura.nextN` and `alerts`, the session site with `userFilesPath`, `topID` and `openSectionList`, `keywords`, the data manager's `datakeywords` and `filterBy`, carch's `moduleid`, module tops and `session.mura.objectInstanceId`, and FW/1's preserve-key counter; the table in [`legacy-bridge/README.md`](legacy-bridge/README.md)) travel both ways, so both sides allocate preserve keys from one counter. FW/1's preserved contexts, which target post-actions save for their legacy-served landings, travel target to legacy only, a failed user or group save's `userBean` installed as legacy's own bean. Before each legacy-bound admin request of a session they are read from identity (`GET /internal/v1/sessions/{sid}/admin-state`) and installed in its legacy session (`op=carry`) whenever they changed since the last install. Once legacy has completed such a request, other than a login or logout, the values legacy changed (`op=export`) are stored in identity (`POST /internal/v1/sessions/{sid}/admin-state`) before its last byte reaches the browser. Of a `session.mura` struct the carry installed, such as `flatViewArgs` or `alerts`, identity stores only legacy's changes against the installed struct (`base`), merged under the locked session row, so a target write since the carry stands; the next carry installs the merged value. In legacy-primary, an unavailable identity or cookies that no longer attach the jar's legacy session leave both sides as they are.
- **CSRF.** Both sides share one secret per session. Claims on tokens sent to legacy go through identity (`POST /internal/v1/csrf/claims`, `…/claims:settle`): only tokens legacy actually consumed (`op=usedSince`) become used, the rest are released. Identity marks tokens consumed on the target side in the legacy session through `POST /internal/v1/legacy-sessions/{sid}:mark-used`. REST keys the inventory records `sessionless` take no claims; a session-managed REST variant such as `rest:variationtargeting.save{session}` does, reading `X-csrf_token*` as the JSON API does.
- **Adoption.** At cut-over, a request with legacy cookies mapped to no target session is adopted (`POST /internal/v1/sessions:adopt`) at the request's site, or `default` when it names none or holds a NUL, which no site id does; moving back to legacy-primary answers target cookies with the jar's legacy values.
- **Invalidation.** Logout on either side ends both sessions (`op=end`, `POST /internal/v1/sessions/{sid}:end`). A legacy-served logout marks the session first and ends it in identity only once `op=describe` shows legacy logged it out; while legacy or identity cannot be read, the mark stays and the session's requests go on anonymously, each judging the logout again. On a session epoch change, the legacy session is re-hydrated from the new snapshot.
- **User tokens.** A site-scoped token per (session, site) from identity `POST /internal/v1/tokens`, cached until an epoch change or until less than 25 s of its lifetime is left (twice the 10 s service-call timeout plus 5 s of clock skew), attached as `Authorization: Bearer` to target-bound requests. Inbound `X-Serverless-Authorization` and `X-Opt2-*` headers are always stripped, and `Authorization` once exchanged for a user token. A target-bound fixture-route request's inbound `Authorization` is relayed verbatim as the gateway-authored `X-Opt2-Fixture-Authorization`, which carries a survey task run's Basic credential. Session state is re-checked with identity (`GET /internal/v1/sessions/{sid}/state`) at most once per second.

## Legacy bridge

`legacy-bridge/cfml/` is CFML served by the legacy web root through an `Application.cfc` that extends `muraWRM.Application`: session describe, hydrate, mark-used, carry, export and end, site-monitor steps, scheduler hand-off, site registry, the admin Version menu facts and file store. It accepts only requests carrying an HMAC bridge assertion signed with `OPT2_BRIDGE_HMAC_KEY`, which only the gateway and the migration service hold; from outside, `/gateway/legacy-bridge/**` answers 404 at the gateway. See [`legacy-bridge/README.md`](legacy-bridge/README.md).

## Internal API

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml). Every operation except `/healthz` and the edge requires an invocation credential carrying the listed role.

| Operation | Path | Caller and role |
|---|---|---|
| `healthz` | `GET /healthz` | Public |
| `cutoverActivate` | `POST /internal/v1/cutover/activate` | `opt2-migrate transition` or an operator, `platform.operator` |
| `cutoverFreeze`, `cutoverUnfreeze` | `POST /internal/v1/cutover/freeze`, `POST /internal/v1/cutover/unfreeze` | `opt2-migrate transition` or an operator, `platform.operator` |
| `cutoverStatus` | `GET /internal/v1/cutover/status` | `platform.operator` or `platform.migration` |
| `cutoverStatusV2` | `GET /internal/v2/cutover/status` | `platform.operator` or `platform.migration`; the migration service reads orphans from it |
| `inflightClearOrphans` | `POST /internal/v1/inflight:clear-orphans` | `platform.operator` or `platform.migration` |
| `legacySessionMarkUsed` | `POST /internal/v1/legacy-sessions/{sid}:mark-used` | Identity, `service:identity` |
| `legacySitePaths` | `GET /internal/v1/legacy-site-paths` | Web, `service:web`; legacy's live first-touch site paths for a browser request's host facts (`site.cfm?op=paths`) |
| `getLegacyVersionMenu` | `GET /internal/v1/legacy-server/version-menu` | Web, `service:web`; legacy's admin Version menu facts through the bridge's `site.cfm?op=versionMenu` |
| `relayGet` … `relayDelete` | `/internal/v1/relay/{service}/{path}` (also reached as `/opt2/svc/{service}/{path}`) | Web, `service:web`; the user token passes on only with web's credential, and of the `X-Opt2-*` headers only web's `X-Opt2-Path-Pairs`. Only the callee's versioned API (`/v1/**`, `/v2/**`) is forwarded; any other callee path answers the legacy 404, as an unknown service does |
| `edge*` | `/{path}` | Public; dispatched by the active version |

## Environment

`@opt2/platform/service-kit` `baseEnvSchema` (see [`platform/README.md`](../platform/README.md#configuration)) plus:

| Variable | Use |
|---|---|
| `LEGACY_ORIGIN` | Masa origin; locally `http://127.0.0.1:${PORT}` of ColdFusion |
| `OPT2_CUTOVER_DIR` | Relocates the cut-over directory; default `gateway/cutover` |
| `OPT2_BRIDGE_HMAC_KEY` | Bridge assertion key; locally generated into `${OPT2_STATE_DIR}/secrets/`, in the cloud the Secret Manager secret `legacy-bridge-hmac` |
| `MURA_APPRELOADKEY` | Masa's reload parameter name for the route key; default `appreload` |
| `MURA_SESSIONTIMEOUT` | Masa's `sessionTimeout` in minutes, the idle limit of a jar and of the legacy-primary cookies known to attach a legacy session without a describe; 180 when unset, blank, an expression or below 1 |
| `MURA_REQUESTTIMEOUT` | Masa's `requesttimeout` in seconds, after which no legacy logout can still be running, so a session whose pending logout legacy shows it kept is unmarked; 1000 when unset or blank; any other value that is not a positive number fails start-up |
| `MURA_SECURECOOKIES` | Masa's `secureCookies`: marks the request-start cookies `secure`; false when unset, an expression or no CFML boolean |
| `MURA_COOKIEDOMAIN` | Masa's `cookieDomain`: the request-start cookies' `domain`, as given; none when unset, blank or an expression |

- `OPT2_SERVICE_NAME` must be `gateway`, and `OPT2_DB_AUTH` and `PG_DATABASE` are required.
- `OPT2_SERVICE_URLS` must name the ten services and `web`, plus `stub` locally; migration comes from `OPT2_MIGRATION_URL` or the map.
- A cut-over file that cannot be read fails start-up with `cannot read OPT2_CUTOVER_DIR file <path inside the directory> (<syscall> <code>)`.
- The active version is read from the `gateway` schema, never from the environment.
- The database role is `gateway_app`, with access to the `gateway` schema only.

## Build, test, run

```sh
npm ci                     # installs and builds ../platform through postinstall
npm run build              # generates contract types into src/generated/, then tsc -> dist/
npm run typecheck          # tsc over src/, test/ and vitest.config.ts (test/tsconfig.json), no emit
npm run lint               # eslint with typescript-eslint recommended (eslint.config.mjs)
npm test                   # vitest with coverage, >= 90% statements
npm run test:contract      # test/contract
npm run test:security      # test/security: route and role matrix through app.inject
npm run cutover:groups     # regenerates cutover/groups.json
npm run cutover:versions   # regenerates cutover/versions/v0001-v0003.json
npm run cutover:validate   # validates every committed version
npm start                  # node dist/main.js
```

- Suites under `test/cutover/` and `test/session/` that need PostgreSQL use a throwaway schema from the `PG_*` variables, skip when `PG_HOST` is unset and fail when the server is unreachable; the rest use in-process doubles.
- Locally, `harness/repro/up.sh` starts the gateway natively with `PORT=8100`. The `Dockerfile` is the Cloud Run artefact, built but never pushed in CI.
