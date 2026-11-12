# Legacy bridge

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The legacy bridge is a set of new CFML endpoints under the legacy web root, which is the repository root (setup §1). Through them the gateway and the migration service act on the running Masa 7.6.1 application: its sessions, site-monitor steps, ACF scheduled tasks, in-memory site registry, caches and file store. The bridge changes no Masa file and no Masa table schema (AAP 0.2.1, conflict C1; Masa licence header `Application.cfc:59`).

This README is the normative contract. The pages in [`cfml/`](cfml/) implement it, and the TypeScript callers build against it.

| File | Role |
|---|---|
| `cfml/Application.cfc` | Guard (allow-list, assertion, reload-key strip) and the helpers the pages share |
| `cfml/session.cfm` | Session describe, hydrate, CSRF ledger, end |
| `cfml/jobs.cfm` | Site-monitor steps, cursor, cache purge |
| `cfml/scheduler.cfm` | ACF scheduled-task control |
| `cfml/site.cfm` | In-memory site registry list and rebuild |
| `cfml/files.cfm` | Legacy file store list, get, put, delete |

Every endpoint is `${LEGACY_ORIGIN}/gateway/legacy-bridge/cfml/<page>.cfm?op=<op>`, or `jobs.cfm?job=<job>`.

## How it plugs into Masa

- `cfml/Application.cfc` is `extends="muraWRM.Application"`.
  - `/muraWRM` is a **server-level** ColdFusion mapping to the repository root, saved by `harness/repro/lib/legacy-start.sh` with `box cfconfig cfmapping save`. Masa defines `/muraWRM` only as an application mapping (`core/appcfc/applicationSettings.cfm:215`), which a component's `extends` cannot use before the application exists.
  - The subclass shares Masa's application scope, session scope and `application.serviceFactory`, because `this.name` is computed in Masa's own `core/appcfc/applicationSettings.cfm:173` from that include's path.
  - It declares no `this.*` settings and overrides only `onRequestStart`.
- Guard order in the overridden `onRequestStart`:
  1. **Allow-list.** Only `session.cfm`, `jobs.cfm`, `scheduler.cfm`, `site.cfm` and `files.cfm` are served, matched case-sensitively. Anything else gets 404 with an empty body.
  2. **Assertion.** Any verification failure gets 403 with an empty body. Masa never runs for a rejected request.
  3. **Reload flag.** When the URL carries the key named by `application.appReloadKey` (default `appreload`, `core/appcfc/onApplicationStart_include.cfm:80`), the guard sets `request.muraAppreloaded = true`, Masa's own "already reloaded in this request" flag (`core/appcfc/onApplicationStart_include.cfm:88`). Deleting the key first could not stop the reload: Masa re-decodes `url` with `setEncoding` (`core/appcfc/onRequestStart_include.cfm:82`) before its reload check.
  4. Masa's `onRequestStart` runs: session defaults, session cookies, `Generator` and HSTS headers.
  5. **Reload key.** The key is then deleted from `url`, so the page never sees it.
- The flag suppresses only a reload asked for by that key on a bridge call, never genuine initialisation:
  - Masa resets the flag to `false` and runs `onApplicationStart_include.cfm` when the application is not initialised or fails its start-up check, and still reloads on the key while setup is incomplete (`core/appcfc/onRequestStart_include.cfm:92-136`).
  - ColdFusion's own application start, after a restart or application expiry, runs Masa's `onApplicationStart` before the guard.
  - The start-up guard (AAP 0.5.4) closes those paths; the bridge does not.

### Reachability

- Only the gateway and the migration service hold `OPT2_BRIDGE_HMAC_KEY` (AAP 0.5.1).
- From outside, the cut-over table answers 404 for `/gateway/legacy-bridge/**` (AAP 0.4.2).
- Callers address legacy directly at `LEGACY_ORIGIN` (local `http://127.0.0.1:${PORT}`), never through the gateway's public routing.
- All bridge traffic comes from loopback (AAP 0.11.2).

## Assertion

Implemented on the TypeScript side by [`platform/src/legacy-compat/bridge-assertion.ts`](../../platform/src/legacy-compat/bridge-assertion.ts) (`signBridgeAssertion`, `verifyBridgeAssertion`), exported from `@opt2/platform/legacy-compat`.

- Header `X-Opt2-Bridge-Assertion`, value `<b64>.<mac>`, joined with one `.`.
  - `<b64>`: unpadded base64url (RFC 4648 §5) of the UTF-8 compact JSON object with keys in this order: `aud`, `op`, `sid`, `sub`, `siteId`, `exp`, `nonce`.
  - `<mac>`: lowercase hex HMAC-SHA256, keyed with the UTF-8 bytes of `OPT2_BRIDGE_HMAC_KEY`, over the ASCII bytes of `<b64>` itself. The verifier never re-serialises the JSON.
- Claims:

| Claim | Type | Rule |
|---|---|---|
| `aud` | string | Must be `"legacy-bridge"` |
| `op` | string | Must equal `<page basename>.<url.op>`, or `jobs.<url.job>` for `jobs.cfm`, compared case-sensitively. Examples: `session.hydrate`, `jobs.purgeCache`, `files.put` |
| `sid` | string | Legacy session id for session ops, when known (see `session.cfm`); `""` otherwise |
| `sub` | string | Masa `UserID` that `session.hydrate` installs; `""` otherwise |
| `siteId` | string | Must equal the URL parameter `siteid`, compared case-sensitively; an absent `siteid` counts as `""` |
| `exp` | integer | Epoch seconds (UTC). Accepted when `now < exp <= now + 60` |
| `nonce` | string | Non-empty; single use within 120 s (in-memory ledger in the ColdFusion process; see the restart rule below). The signer emits 32 lowercase hex characters |

- A missing or empty `OPT2_BRIDGE_HMAC_KEY` in the ColdFusion process rejects every request.
- The nonce ledger lives in the ColdFusion process, so a restart empties it. After a restart, an assertion whose `exp` is at or before the JVM start time + 60 s is refused (log reason `preStart`), because the previous process may have accepted it. A signer with a TTL under 60 s is therefore refused for the first 60 − TTL seconds after the JVM starts, so the gateway session client and the migration client both sign with 60 s.
- The MAC comparison is constant-time.
- The verified payload is available to the page as `request.opt2Bridge`.

### Signing test vector

Fixed vector, computed with Node `crypto` and cross-checked with `openssl dgst -sha256 -hmac`. The key is a test value, not a secret.

```text
key (UTF-8)   opt2-bridge-test-vector-key-0001
now           1782820800   (2026-06-30T12:00:00Z)
payload JSON  {"aud":"legacy-bridge","op":"session.hydrate","sid":"OPT2TEST_1001_12345678","sub":"9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F","siteId":"default","exp":1782820860,"nonce":"3b9f1c2e-7d4a-4e8b-9f6a-1c2d3e4f5a6b"}
b64           eyJhdWQiOiJsZWdhY3ktYnJpZGdlIiwib3AiOiJzZXNzaW9uLmh5ZHJhdGUiLCJzaWQiOiJPUFQyVEVTVF8xMDAxXzEyMzQ1Njc4Iiwic3ViIjoiOUMxRDdFMkYtM0E0Qi00QzVELThFOUYwQTFCMkMzRDRFNUYiLCJzaXRlSWQiOiJkZWZhdWx0IiwiZXhwIjoxNzgyODIwODYwLCJub25jZSI6IjNiOWYxYzJlLTdkNGEtNGU4Yi05ZjZhLTFjMmQzZTRmNWE2YiJ9
mac           8c7859b0af8d3c07a627b6fb7f1968d9ae7020f06e86108dd7288f996a1d6a09
header value  <b64>.<mac>
```

- With `@opt2/platform/legacy-compat`, `verifyBridgeAssertion(value, key, new MemoryNonceStore(), new Date(1782820800 * 1000))` returns `{ ok: true, payload }`, with `payload` equal to the payload JSON (`aud` included), and recomputing the HMAC over `<b64>` gives `<mac>`.
- The CFML verifier must accept the vector with its clock set to `now`.
- Shell check: `printf '%s' '<b64>' | openssl dgst -sha256 -hmac 'opt2-bridge-test-vector-key-0001'` prints `<mac>`; `printf '%s' '<b64>' | basenc --base64url -d` prints the payload JSON (this `<b64>` is 272 characters, so it needs no padding).

## Conventions

- **Methods.** Reads are `GET`. Mutations are `POST`. A body, where an op takes one, is JSON (`Content-Type: application/json`), except `files.cfm?op=put`, which takes a raw `application/octet-stream` body. A wrong method answers 400.
- **Responses.** `application/json; charset=utf-8`, camelCase keys. Every JSON body carries `serverTime`. The exception is `files.cfm?op=get`, which returns raw bytes.
- **Time format**, in and out: `yyyy-mm-ddTHH:nn:ss.lll` in ColdFusion mask letters (Java `yyyy-MM-dd'T'HH:mm:ss.SSS`), for example `2026-06-30T12:00:00.000`.
  - Legacy server zone (`TZ` exported by `up.sh`, AAP 0.5.5), no offset.
  - Parsers also accept a space instead of `T` and missing or shorter milliseconds.
  - Applies to `theTime`, `lastMonitored`, `value`, `since`, `usedAt`, `lastModified`, `lastlogin`, `passwordCreated` and `serverTime`.
  - The programs-sites orchestrator formats with `LEGACY_TIME_MASK = 'yyyy-MM-dd HH:nn:ss.lll'` (`formatLegacyTime` in `services/programs-sites/src/jobs/dispatch.ts`, legacy-compat `cfDateTimeFormat` letters: `M` month, `n` minutes, `l` milliseconds), which gives the space-separated form, for example `2026-06-30 12:00:00.000`.
- **Errors.** Body `{error, message, serverTime}`. `message` never carries secrets. The guard's 403 and 404 have empty bodies.
  - For an uncaught error, each page's `catch (any e)` answers 500 `serverError` with `message` = the exception type (`e.type`) only.
  - The other 500s carry a fixed `message`: `OPT2_GATEWAY_ORIGIN unset` or `OPT2_GATEWAY_ORIGIN invalid` (`scheduler.cfm` `repoint`, and `restore` with `repoint: true`), and `opt2bridge.writeVerification` (`files.cfm` `put`, when the re-read file does not hash to the written bytes).

| Status | `error` | When |
|---|---|---|
| 400 | `badRequest` | Missing or invalid parameter, body or time; wrong HTTP method |
| 400 | `hashMismatch` | `files.put` body does not hash to `X-Opt2-Sha256` |
| 404 | `notFound` | Unknown op or job, unregistered site, missing file |
| 409 | `sessionMismatch` | Assertion `sid` differs from `session.sessionid` |
| 409 | `subjectMismatch` | `hydrate` `snapshot.user.userID` differs from assertion `sub` |
| 409 | `unsupportedFileStore` | `files.get`, `files.put` or `files.delete` when the store is not `fileDir` |
| 500 | `serverError` | Uncaught error; `OPT2_GATEWAY_ORIGIN` unset or invalid; `files.put` write verification failed |

- **Logging.** The key, assertion values, CSRF secret keys, used tokens and password hashes are never logged. The guard logs only a rejection reason.
- **User-Agent.** Masa turns session tracking off and sets a 2-second session timeout for empty or bot-like user agents, such as `java`, `coldfusion`, `cfschedule`, `python`, `go-http-client`, `ping` or anything matching `bot\b` (`core/appcfc/applicationSettings.cfm:240-312`).
  - **Session ops must forward the browser's `User-Agent`.** Otherwise the user's legacy session is cut to 2 s.
  - All other ops carry no session cookies and send `User-Agent: opt2-legacy-bridge-bot`, so the throwaway session each creates expires within 2 s.

## Endpoints

### `session.cfm?op=…`

Caller: the gateway, `gateway/src/session/bridge-client.ts` (AAP 0.4.2). Assertion op `session.<op>`.

- The request carries only the legacy session cookies `CFID`, `CFTOKEN` and `JSESSIONID`, from the gateway jar or the browser, so ColdFusion attaches that session. No other cookie is sent: Masa's remember-me cookies (`userid`, `userHash`) would log the user in through `loginManager.rememberMe` (`core/appcfc/onRequestStart_include.cfm:223-227`), which writes `LastLogin`.
- The assertion's `sid` must equal `session.sessionid`, else 409 `sessionMismatch`. The exceptions are `describe`, from which the gateway learns the id, and a `hydrate` sent without session cookies, for which ColdFusion creates a new session.
- No session op runs a query of its own or writes the database.

| Op | Method | Parameters | Body | Response |
|---|---|---|---|---|
| `describe` | GET | — | — | `{sessionId, isLoggedIn, user:{…}, memberships, membershipIds, csrfSecretKey, usedTokens:[{token, usedAt}], siteId, serverTime}` |
| `hydrate` | POST | — | `{snapshot:{user, memberships, membershipIds}, csrfSecretKey, usedTokens:[{token, usedAt}]}` | `{sessionId, hydrated:true, serverTime}` |
| `markUsed` | POST | — | `{tokens:[{token, usedAt}]}` | `{applied, serverTime}` |
| `usedSince` | GET | `since` | — | `{tokens:[{token, usedAt}], serverTime}` |
| `end` | POST | — | — | `{ended:true, serverTime}` |

- **`describe`** is read-only. Every value comes from `session.mura`, as `userUtility.setUserStruct` sets it (`core/mura/user/userUtility.cfc:749-805`), and from `session.siteid`. Full shape:
  `{sessionId, isLoggedIn, user:{userID, username, siteID, subtype, password, fname, lname, email, remoteID, company, lastlogin, passwordCreated}, memberships, membershipIds, csrfSecretKey, usedTokens:[{token, usedAt}], siteId, serverTime}`
  - `user`: absent keys take the logged-out defaults, `""`, and `subtype` `"Default"`. `lastlogin` and `passwordCreated` are wire times or `""`. `password` is the stored hash.
  - `memberships`: the `loginByQuery` role list string (`userUtility.cfc:321-336`): `<groupname>;<siteid>;<isPublic>` per group, then `S2IsPrivate;<siteid>,S2IsPrivate` (or `S2IsPublic;<siteid>,S2IsPublic` for a public-pool user), then `S2` for a super user, then `<username>;username;<siteid>`.
  - `membershipIds`: the group ids plus the user id, as a list string.
  - `csrfSecretKey`: `session.mura.csrfsecretkey`.
  - `usedTokens`: `[{token, usedAt}]` over `session.mura.csrfusedtokens`.
  - `siteId`: `session.siteid`, or `""`.
- **`hydrate`** installs identity's `login_snapshot` without a login.
  - `snapshot.user` has the `describe` `user` keys; times are wire times or `""`. It must not carry `groupID`, which would override `membershipIds` (`userUtility.cfc:780-781`); 400 otherwise. `snapshot.user.userID` must equal the assertion's `sub`, else 409 `subjectMismatch`.
  - Steps, in order:
    1. `setUserStruct(user, memberships, membershipIds)`.
    2. Set `session.mura.csrfsecretkey` to `csrfSecretKey` and replace `session.mura.csrfusedtokens` with `usedTokens` (token → datetime). This must follow step 1, because `setUserStruct` replaces `session.mura` and mints a new secret (`userUtility.cfc:761-763`).
    3. `structDelete(session, 'siteArray')`, as `loginByQuery` does (`userUtility.cfc:339`).
  - It never runs the `LastLogin` update (`userUtility.cfc:367-370`), the login announcements (`:228-233`, `:292-298`), `cflogin` or any query.
  - For a new session the gateway absorbs ColdFusion's `Set-Cookie` headers into `gateway.legacy_jar`.
- **`markUsed`** adds each token to `session.mura.csrfusedtokens`. A token already present keeps its earlier timestamp. `applied` is the number of tokens newly added.
- **`usedSince`** returns the ledger entries with `usedAt >= since`, compared to the millisecond. Ledger semantics are legacy's (`core/mura/user/sessionUserFacade.cfc:206-235`): a token validates once, and legacy purges entries older than 3 h at its next validation. The bridge never purges.
- **`end`** calls `setUserStruct()` with no user (logged-out defaults, no database), then `sessionInvalidate()`.

### `jobs.cfm?job=…`

Caller: the migration service, for the programs-sites site-monitor orchestrator and for the reverse projector (AAP 0.3.2, 0.8.3). Assertion op `jobs.<job>`; for site jobs, `siteId` equals `siteid`.

- Each step job reproduces its block of `core/mura/content/contentServer.cfc:669-747`, with the orchestrator's cursor instead of `application.lastMonitored`.
- Step job names equal `SiteMonitorStepName` in [`services/programs-sites/src/jobs/steps.ts`](../../services/programs-sites/src/jobs/steps.ts). `getCursor` and `purgeCache` are bridge-only jobs.
- Every job is POST except `getCursor` (GET). Parameters are URL query parameters, and there is no body.
- Site jobs (`trackBounces`, `feedAutoImport`, `onSiteMonitor`, `purgeCache`) need a registered `siteid` (`settingsManager.siteExists`), else 404.
- Response: `{job, siteId?, completed:true, serverTime}`, with `siteId` on site jobs. `getCursor` answers `{job, lastMonitored, serverTime}`, where `lastMonitored` is a wire time or `null` before any cursor exists.

| `job` | Parameters | Masa call |
|---|---|---|
| `sendReminders` | `theTime` | `contentManager.sendReminders(theTime)` (`:683`). The orchestrator sends the 30-minute catch-up (`:677-681`) as a separate call |
| `emailSend` | — | `emailManager.send()` (`:685`) |
| `publishScheduledChangesets` | — | `changesetManager.publishBySchedule()` (`:687`) |
| `trackBounces` | `siteid` | `emailManager.trackBounces(siteid)` (`:693`) |
| `feedAutoImport` | `siteid` | `feedManager.doAutoImport(siteid)` (`:698`) |
| `purgeDisplayWindow` | `lastMonitored`, `theTime` | The display-window query over `[lastMonitored, theTime]` (`:702-711`), then `purgeContentCache` per content and `purgeCache()` per site (`:713-733`) |
| `clearOldCommands` | — | `clusterManager.clearOldCommands()` (`:735`) |
| `onGlobalMonitor` | — | `getBean('$').announceEvent('onGlobalMonitor')` (`:737`) |
| `onSiteMonitor` | `siteid` | `getBean('$').init(siteid).announceEvent('onSiteMonitor')` (`:742`) |
| `setCursor` | `value` | `application.lastMonitored = value` (`:745`) |
| `getCursor` | — | Reads `application.lastMonitored`; seeds `programs_sites.sitemonitor_state` at hand-off |
| `purgeCache` | `siteid` | `settingsBean.purgeCache(name, broadcast=false)` for `output` and `data` (`core/mura/settings/settingsBean.cfc:639-645`) |

- The per-site gating (`EmailBroadcaster`, `FeedManager`), the step order, the catch-up and the ineffective mail-server dedupe (`:694` discards the `listAppend` result) belong to the orchestrator, not to the bridge.
- A step that writes `target`-authoritative units runs here only inside a write window that migration opens (AAP 0.5.4). The bridge itself is unaware of windows.

### `scheduler.cfm?op=…`

Caller: the migration service, `migration/src/scheduler/`, and `opt2-ops` (AAP 0.4.2). Assertion op `scheduler.<op>`.

- ColdFusion always runs with `MURA_PING=false`, so Masa never registers `siteMonitor` itself (`core/appcfc/onApplicationStart_include.cfm:561`). The bridge alone maintains the native task, from the definition captured on first run.
- Tasks are created through Masa's `utility.scheduleTask` (`<cfschedule attributeCollection>`, `core/mura/utility.cfc:1697-1699`), in the same default mode and group as Masa's own call.
- A task in the wire shape is `{task, group, url, port, interval, startDate, startTime, requestTimeOut, operation, paused}`. Every field is a string (`""` when ACF reports none), except `paused`, a boolean.
  - `startDate` is `mm/dd/yyyy`, the form Masa passes (`:570`), and `startTime` is 24-hour `HH:mm:ss`. `cfschedule` accepts both back.
  - On ACF 2023, `cfschedule action="list"` returns a query whose `GROUP` is `DEFAULT` for Masa's tasks and which has no operation column, so `operation` is `""`; `restore` then omits it, which ACF accepts. `paused` is `STATUS` equal to `Paused`.
  - `cfschedule` needs the ACF `scheduler` package (`cfpm install scheduler`). Without it every op answers 500 `serverError`.

| Op | Method | Body | Response |
|---|---|---|---|
| `describe` | GET | — | `{ping, siteMonitorTask, tasks:[<task>], serverTime}` |
| `repoint` | POST | `<task>`: the captured definition of the native task | `{op, tasks:[<name>], serverTime}` |
| `pause` | POST | `{tasks?:[<name>], prefix?}` | `{op, tasks:[<names affected>], serverTime}` |
| `resume` | POST | `{tasks?:[<name>], prefix?}` | `{op, tasks:[<names affected>], serverTime}` |
| `delete` | POST | `{tasks?:[<name>], prefix?}` | `{op, tasks:[<names affected>], serverTime}` |
| `restore` | POST | `{tasks:[<task>], repoint:boolean, paused:boolean}` | `{op, tasks:[<names>], serverTime}` |

- **`describe`.**
  - `ping` is the effective `configBean` value, as a boolean. `up.sh` stops unless it is `false`, and after boot confirms that every task is `paused`.
  - `siteMonitorTask` is Masa's ACF task name, `configBean.getWebRoot() & "/index.cfm/_api/sitemonitor/"` (`onApplicationStart_include.cfm:555-559`).
- **`repoint`** recreates the native task with Masa's attributes (`:562-575`), then resumes it:
  - the task name (default `siteMonitorTask`), operation `HTTPRequest`, `startTime` 00:15, `interval` 900, `requestTimeOut` 600, `publish` No;
  - `startDate` from the captured definition, else today;
  - the URL `OPT2_GATEWAY_ORIGIN` + `/index.cfm/_api/sitemonitor/`, with host and port split as Masa splits them (`:549-553`, `:563`): the URL carries no port, `port` carries it, and a missing port is 443 for `https` and 80 for `http`.
- **`pause`, `resume`, `delete`** select tasks whose name equals an entry of `tasks`, or starts with `prefix` (case-sensitive; for example `opt2-survey-`). At least one of the two is required. An empty selection answers `tasks: []`.
- **`restore`** recreates each task exactly as given. With `repoint: true` only the scheme, host and port move to `OPT2_GATEWAY_ORIGIN`, a missing port defaulting as in `repoint`; path and query are kept. With `paused: true` each task is paused after creation. The input shape is the `describe` task shape, so migration can round-trip `${OPT2_PRISTINE_DIR}/native-tasks.json` after converting it.

### `site.cfm?op=refresh&siteid=…`

Caller: the migration reverse projector, after a batch touching `tsettings`, pool columns included (AAP 0.8.3). Assertion op `site.refresh`, `siteId` equal to `siteid`.

- POST, no body. `siteid` is required.
- Runs `settingsManager.setSites()`: a full rebuild of the in-memory registry from `tsettings`, under Masa's own lock (`core/mura/settings/settingsManager.cfc:440-486`).
- Response: `{refreshed:true, siteExists, serverTime}`. `siteExists` is `false` for a deleted site, with status 200.

### `site.cfm?op=list`

Caller: the gateway, `gateway/src/session/bridge-client.ts` (`createSiteListClient`), which keeps the route key's site registry (`gateway/src/dispatcher/site-registry.ts`). Assertion op `site.list`, `siteId` `""`.

- GET, no parameters, no body.
- Reads the keys of `settingsManager.getSites()`, the struct `settingsManager.siteExists` checks (`core/mura/settings/settingsManager.cfc:568-577`). Nothing is rebuilt or written.
- Response: `{sites:[<siteid>], serverTime}`, in no defined order. ColdFusion may serialise a numeric-looking id as a JSON number, so callers read each entry as a string.

### `files.cfm?op=…`

Caller: the migration service, `migration/src/files/` and the reverse projector (AAP 0.8.1, 0.8.3). Assertion op `files.<op>`, `siteId` equal to `siteid`.

- Layout follows `core/mura/content/file/fileDAO.cfc:153-199`: `<configBean.getFileDir()>/<siteid>/cache/file/<fileID><variant>.<ext>`.
  - fileDAO writes the variants `""`, `_source`, `_small` and `_medium`, the last three only for `png`, `gif`, `jpg` and `jpeg`; for `flv`, `_small` and `_medium` are `.jpg`.
  - Image rendering adds on-demand renditions `_<size name>` and `_W<w>_H<h>`, where `w` and `h` are numbers or `AUTO`/`auto` (`core/mura/content/file/processImgCfimage.cfc:190-201`).
- `name` is `<fileID><variant>.<ext>` and must match `^[A-Za-z0-9-]{35}(_[^/\\[:cntrl:]]+)?\.[A-Za-z0-9]+$`, else 400:
  - the fileID is 35 characters of `[A-Za-z0-9-]`;
  - a variant is `_` and one or more characters other than `/`, `\` and ASCII control characters, dots included (`_W200.5_HAUTO`);
  - `ext` is the segment after the last dot.
  - A name has no separator and starts with the fileID, so it cannot leave the directory: a traversal, `/`, `%2F` or a backslash answers 400. With Masa's script protection on (the default, `core/mura/configBean.cfc:160`), `%00` is removed from parameters before the check (`core/mura/Portcullis.cfc:619-622`); otherwise the control-character rule rejects it.
- `fileId` must match `^[A-Za-z0-9-]{35}$`, else 400. `siteid` must be a registered site, else 404.
- Parameters are URL query parameters.
- When the store (`configBean.getFileStore()`) is not `fileDir`, `list` answers `files: []`, and `get`, `put` and `delete` answer 409 `unsupportedFileStore`. Migration records the halt (AAP 0.8.1).

| Op | Method | Parameters | Body | Response |
|---|---|---|---|---|
| `list` | GET | `siteid` | — | `{fileStore, files:[{name, fileId, variant, ext, size, sha256, lastModified}], serverTime}` |
| `get` | GET | `siteid`, `name` | — | Raw bytes, `application/octet-stream`, header `X-Opt2-Sha256` |
| `put` | POST | `siteid`, `name` | Raw bytes, `application/octet-stream`, header `X-Opt2-Sha256` | `{written:true, name, size, sha256, serverTime}` |
| `delete` | POST | `siteid`, and `name` or `fileId` | — | `{deleted:[<names>], serverTime}` |

- `sha256` and `X-Opt2-Sha256` are lowercase hex SHA-256 of the raw bytes. `size` is the byte count.
- **`list`** returns every file in the directory whose name starts with a fileID and matches the name rule, so variants are found, not assumed. A missing directory gives `files: []`.
- **`get`** answers 404 for a missing file.
- **`put`** checks the body against `X-Opt2-Sha256` (missing header 400, mismatch 400 `hashMismatch`), then writes through Masa's `fileWriter.writeFile(mode="774", …)`, overwriting an existing file as Masa's cache writes do.
- **`delete`** by `name` removes that file; by `fileId` it removes every `<fileId>*` file, as `deleteCachedFile` does (`fileDAO.cfc:382-402`). It reads no `tfiles` row and announces no plugin event. Nothing found gives `deleted: []`.

## Environment

Set on the ColdFusion start command only, by `harness/repro/lib/legacy-start.sh` (AAP 0.4.2, 0.6.1):

| Variable | Use |
|---|---|
| `OPT2_BRIDGE_HMAC_KEY` | Assertion key, generated by `up.sh` into `${OPT2_STATE_DIR}/secrets/`. In the cloud, the Secret Manager container `legacy-bridge-hmac` |
| `OPT2_GATEWAY_ORIGIN` | Gateway origin used by `scheduler.cfm` `repoint` and `restore` |
| `MURA_PING` | `false`, so Masa never registers the site-monitor task itself (`core/appcfc/onApplicationStart_include.cfm:136-141`, `:561`) |

## Callers

| Endpoint | Caller | When |
|---|---|---|
| `session.cfm` | `gateway/src/session/bridge-client.ts` | Describe and adoption, hydrate, CSRF claims, logout |
| `jobs.cfm` | The migration service on behalf of `services/programs-sites/src/jobs/dispatch.ts`; the reverse projector (`purgeCache`) | Legacy site-monitor steps, cursor hand-off, cache purge |
| `scheduler.cfm` | `migration/src/scheduler/` and `opt2-ops` | `up.sh`, transitions, drain and resume, `down.sh` |
| `site.cfm` | The migration reverse projector (`refresh`); `gateway/src/session/bridge-client.ts` (`list`) | After a `tsettings` batch; gateway start and every second after |
| `files.cfm` | `migration/src/files/` and the reverse projector | Snapshot manifest, transfer, reverse projection |

## Smoke check

With the local stack up, sign a fresh assertion with the platform signer and call `scheduler.cfm?op=describe`. Each assertion is single-use, so sign one per call.

```sh
cd gateway
export OPT2_BRIDGE_HMAC_KEY="$(cat "$OPT2_STATE_DIR/secrets/bridge-hmac-key")"
A="$(node --input-type=module -e "import { signBridgeAssertion } from '@opt2/platform/legacy-compat'; process.stdout.write(signBridgeAssertion({ op: 'scheduler.describe' }, process.env.OPT2_BRIDGE_HMAC_KEY))")"
curl -s -A opt2-legacy-bridge-bot -H "X-Opt2-Bridge-Assertion: $A" \
  "$LEGACY_ORIGIN/gateway/legacy-bridge/cfml/scheduler.cfm?op=describe"
```

The same call without the header answers 403 with an empty body:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -A opt2-legacy-bridge-bot \
  "$LEGACY_ORIGIN/gateway/legacy-bridge/cfml/scheduler.cfm?op=describe"
```

See also the [gateway README](../README.md).
