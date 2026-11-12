# @opt2/web — Masa admin on Next.js

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

A Next.js 16 App Router service built to reproduce the legacy Masa 7.6.1 admin screens without redesign, subject to the [known limitations](#known-limitations). This README states intended behaviour; equivalence is demonstrated only by the golden comparison and browser flows under [Tests](#tests). Browser URLs stay legacy (`/admin/?muraAction=…`), and the gateway maps each admin request here by the action's inventoried response mode (AAP 0.4.9).

Web has no database and no state of its own: every read and write goes through the gateway to the owning service (AAP 0.5.3).

## Layout

| Path | Holds |
|---|---|
| `app/admin/[circuit]/[action]/page.tsx` | `page` mode: full or compact layout, chosen as `admin/common/layouts/default.cfm` chooses (`compactDisplay eq 'true'`) |
| `app/admin-actions/[circuit]/[action]/route.ts` | `redirect` mode: the write, then the legacy redirect or the re-rendered form |
| `app/admin-raw/[circuit]/[action]/route.ts` | `fragment`, `json` and `download` modes |
| `app/opt2/admin/[module]/[screen]/page.tsx`, `app/opt2/admin-actions/[module]/[action]/route.ts` | SYNTHETIC module screens and their posts |
| `proxy.ts` | Legacy headers on page-mode responses (below) |
| `src/shell/` | `admin/common/layouts/template.cfm`, `compact.cfm` and their includes (`nav.cfm`, `header.cfm`, `dsp_secondary_menu.cfm`, `dialog.cfm`) |
| `src/screens/<circuit>/`, `src/screens/opt2/<module>/` | Reproduced views |
| `src/lib/` | Markup primitives (`html.ts`), legacy URLs (`urls.ts`), legacy responses (`responses.ts`), environment and Masa settings (`env.ts`), dates, telemetry, resource bundles, auth, the gateway client |
| `src/generated/` | Build output of `npm run generate` (gitignored) |

## What is reproduced

| Screen group | Source views | Owning service |
|---|---|---|
| Login, logout, no-access, home redirect | `admin/core/views/clogin/`, `cmessage/` | identity |
| Users: list, listusers, search, advanced search, edit user (Basic, Address Information, Group Memberships, Interests, Extended Attributes, Advanced, Content), edit address, route, downloads (`download`, `advancedSearchToCSV`) | `admin/core/views/cusers/` | people |
| Edit profile | `admin/core/views/ceditprofile/` | people |
| Groups: edit group, group members, add and remove member, `downloadGroupMembers` | `admin/core/views/cusers/` | identity |
| Permissions (main, module) | `admin/core/views/cperm/` | identity |
| OAuth clients | `admin/core/views/cwebservice/` | identity |
| Sites list, edit site (all tabs; Razuna values are empty, see [Known limitations](#known-limitations)) | `admin/core/views/csettings/` | programs-sites |
| Site Manager tree and tabs, edit and edit panels, history, status modal, multi-file upload, crop image, data manager, search | `admin/core/views/carch/` | strategies-content |
| Change sets, comments, categories, collections (feeds), forms dialogs, approval chains, site search | `admin/core/views/{cchangesets,ccomments,ccategory,cfeed,cform,cchain,cnav}/` | strategies-content |

Not built here; legacy renders them in its own shell, reached through the gateway and its session bridge:

- **Legacy-served:** email broadcaster (`cemail`), mailing lists (`cmailinglist`), dashboard (`cdashboard`), file manager (`cfilemanager`), bundles, export HTML and plugin actions (`csettings`), plugins (`cplugins`), scaffolder (`scaffold`), Razuna (`razuna`), and `carch` export, exportcontent, importcontent, exportcomponent, importcomponent and emailTest.
- **Withheld** (decision list, `opt2/decision-list.md`): site add, delete and copy (`csettings.updateSite{action=Add|Delete}`, `sitecopyselect`, `sitecopy`), class extensions (`cextend`), trash (`ctrash`), user delete (`cusers.update{type=2,action=Delete}`) and every photo branch of `cusers.update` and `ceditprofile.update`.

### SYNTHETIC module screens

**SYNTHETIC** — no Masa equivalent; legacy oracle in legacy-fixtures/.

Minimal screens at `/opt2/admin/<module>/<screen>`, rendered inside the same shell and built only from legacy admin CSS classes (`mura-header`, `nav-module-specific`, `mura-table-grid`, `btn`, `alert`). The nav gains one "OPT-2" group linking to them.

| Module | Screens |
|---|---|
| `timesheets` | Sheet list with status and overdue flag; sheet detail with day approve, return and resubmit for each role |
| `finance` | Record list; record detail with version history, transition buttons and attachments |
| `e-signature` | Signing request with typed name; audit chain; verify |
| `reporting` | Export job list with state and signed download |
| `surveys` | Survey list; schedule (launch and reminders); bulk targeting; responses |
| `communications` | Templates; sends; delivery status |

### Known legacy issues, reproduced as legacy shows them

- The admin date mask shows `10/302/2026`: ACF 2023 reads `DD` in `MM/DD/YYYY` as day of year.
- The header search form posts to a route that answers 404.
- The group and user forms default to Member.

The fourth known issue, the session id not rotated at login, belongs to identity. None of these is masked or fixed here (AAP 0.2.2).

### Known limitations

Settled gaps of the target, each commented at its source:

- **Admin session state** (`src/lib/request-context.ts`, `loadIdentitySession`, `initialSession`): identity's session API holds only the user struct and the site list, so every other admin session value (the session site switch, `session.rb`, keywords, the FW/1 flash and preserved contexts) starts at its legacy `cfparam` default on each request. Changes are recorded in `sessionWrites` but not persisted until identity's contract adds an operation for them, so they do not carry over between requests.
- **Site data for non-admins** (`src/lib/request-context.ts` `siteLookups`; `src/shell/nav.ts` `dashboard`, `moduleEntries`, `users`): programs-sites serves site data only to S2 users and site admins, and only for the token's site. Editors such as `qa_editor` get none, so the nav hides the site-flag-gated entries legacy shows them (Dashboard, Change Sets, Comments, Collections, Email Broadcaster, Mailing Lists, the extranet Users menu), and a site with its own locale shows their dates in the default locale.
- **Theme location** (`src/shell/html-head.ts`, `src/shell/inline-scripts.ts`, `themeAssetPath`): legacy `getThemeAssetPath` probes the legacy file tree, which web cannot read. Web assumes the web-root `themes/<theme>` layout of a Masa 7 install. When site data is withheld, the head's `themepath` is `<context>/themes/default`, and `Mura.init` takes the session site with no theme (`unreadSiteBean`).
- **Razuna** (`src/screens/csettings/editsite/razuna.ts`): the Edit Site Razuna tab renders legacy's markup with empty values, because Razuna settings (`trazunasettings`) stay on legacy; a site with stored Razuna settings differs in those values.

## How it renders

- Shell and screens are server-only TypeScript that produce escaped HTML strings through `src/lib/html.ts` (`html`, `attr`, `join`, `raw`). Page mode embeds that markup in one container of the React root, with no client components, so legacy jQuery, OneUI, CKEditor and nice-select are meant to operate on the DOM as on legacy; the browser flows under [Tests](#tests) demonstrate it. Route handlers return the same strings.
- Legacy static assets are referenced in place (`/admin/assets/**`, `/core/vendor/**`, `/core/modules/**`) and served by legacy through the gateway. Nothing is copied, and no component library or new stylesheet is added.
- Labels come from `core/mura/resourceBundle/resources/*.properties`, with core-module bundles from `core/modules/v1/core_assets/resource_bundles/` and global overrides from `resource_bundles/`, compiled into `src/generated/resource-bundles/` at build time.
- Masa global settings are read from `MURA_<SETTING>` variables, with the defaults of `core/templates/settings.template.cfm`. A value Masa would evaluate as CFML (`${…}`, `{{…}}`) resolves to `''`.
- Next layouts cannot read the query, so page mode applies the `<html>` and `<body>` attributes with a first-in-body inline script. Route-handler documents carry them literally. Either way the attributes are applied so that the DOM model the golden comparator builds is intended to match legacy's; the golden comparison under [Tests](#tests) demonstrates it.
- Links, form actions and redirects use the legacy form (`adminUrl` from `@opt2/platform/legacy-compat`, FW/1 `buildURL` as `buildUrl` in `src/lib/urls.ts`).

## Gateway ↔ web contract

This section is normative for `gateway/` (`src/admin/map.ts`, the dispatcher and its forwarding) and for `web/src/lib`. Header names are case-insensitive on the wire.

1. **Listening.** Web listens on `PORT`: `8101` locally (`OPT2_PORT_WEB` in `harness/repro/ports.env`), `8080` on Cloud Run. Ingress is internal only, and the gateway is web's only invoker.
2. **Paths by response mode** (AAP 0.4.9). `<circuit>` and `<action>` are the two parts of the admin route key's base key (`RouteKeyResult.baseKey` after `admin:`): the FW/1 action lower-cased, without `core:` and without variant braces, each URI-component-encoded. The query is the original query string byte for byte, never parsed or re-encoded; a request without one gets no `?`.

   | Response mode | Web path | Method and body |
   |---|---|---|
   | `page` | `/admin/<circuit>/<action>?<original query>` | `HEAD` stays `HEAD`, any other method becomes `GET`; never a body (a `POST`'s fields join the query, item 3) |
   | `redirect` | `/admin-actions/<circuit>/<action>?<original query>` | Original method and body |
   | `fragment`, `json`, `download` | `/admin-raw/<circuit>/<action>?<original query>` | Original method and body |
   | SYNTHETIC | `/opt2/admin/<module>/<screen>`, `/opt2/admin-actions/<module>/<action>` | Path, query, method and body unchanged |

   The mode is the inventoried one (`ResponseModes.modeFor(routeKey)`); an action without one is never `target`, so it never reaches web.
3. **Request facts.** On every request in the `page`, `redirect`, `fragment`, `json` and `download` modes the gateway adds `X-Opt2-Original-Url`: the browser's request target as received, path and query, including FW/1 path-info pairs (for example `/admin/index.cfm/cusers/list/siteid/default?compactDisplay=true`). Web derives the path info and the URL scope from it and performs the FW/1 context merge itself (path pairs, then URL, then form, later overwriting earlier; `fuseaction` overriding `muraAction` per scope). A Next page cannot read a request body, so a `page`-mode request is forwarded without one, as `GET` (a `HEAD` stays `HEAD`). Only a request-line `POST` contributes its form fields, appended to the query: the original query string, then `&` when both are non-empty, then the fields.
   - `application/x-www-form-urlencoded`: the body bytes unchanged, except controls and space (`0x00`–`0x20`), `0x7F`, non-ASCII bytes (`0x80`–`0xFF`) and `#`, which a request target cannot carry and so become `%XX` (uppercase hex); existing `%XX` escapes pass through.
   - `multipart/form-data`: the text fields as legacy's form scope reads them, each `encodeURIComponent(name)=encodeURIComponent(value)`, joined by `&` in body order; file parts are dropped, because a page-mode view only renders.
   - Any other body contributes no fields, as legacy's form scope is then empty.

   Web takes the URL scope from `X-Opt2-Original-Url` and the form scope from what follows it in the query it receives.
4. **Inbound headers.**
   - `Authorization: Bearer <site-scoped user token>`, minted by identity for the session and site; absent when the request has no session, and web then has no `user` or `userToken`. An anonymous session's token has an empty `sub`: web verifies and forwards it like any user token for session-bound calls (identity's current session; CSRF token issuance, which answers 401 without a user token) and treats the request as logged out.
   - `X-Serverless-Authorization: Bearer <gateway invocation credential>`: in the cloud a Google-signed ID token whose audience is web's origin, locally a service token from identity's local signer with audience `web`. Web answers a bare 403 when it is missing or names another caller, and a bare 401 for an invalid user token.
   - `X-Request-Id`, `traceparent`, `tracestate`.
   - `X-Forwarded-Host` (the browser's `Host`), `X-Forwarded-Proto`, `X-Forwarded-For`. `Host` itself is web's own address, which Cloud Run routes by.
   - `Cookie`, `Accept-Encoding`, `Accept-Language` and `User-Agent` as the browser sent them. Legacy-session cookies from the gateway's jar are never sent to web.

   The gateway strips every inbound `Authorization`, `X-Serverless-Authorization` and `X-OPT2-*` header before adding its own (AAP 0.5.1), and strips `RSC`, `Next-Router-*`, `Next-Url` and `Next-Action`, which would switch Next to its client-router protocol (`RSC: 1` answers a 307 to `?_rsc`). Web trusts no `X-Opt2-*` header other than `X-Opt2-Original-Url`, and never takes a tenant, user, role or site conclusion from a header.
5. **Web's runtime assets.** `/_next/**` is a `static` cut-over entry owned by web, forwarded unchanged in both directions; legacy has no `/_next` path.
6. **Outbound relay.** Web calls services only through the gateway, at `${OPT2_GATEWAY_URL}/opt2/svc/<service>/<service path>` (`GATEWAY_SERVICE_PREFIX` in `src/lib/env.ts`), where `<service>` is one of the ten service folder names, for example `${OPT2_GATEWAY_URL}/opt2/svc/people/v1/users`. Each call carries the user token in `Authorization`, web's invocation credential in `X-Serverless-Authorization` (audience: the gateway's origin in the cloud, `gateway` locally), `X-Request-Id`, `traceparent` and `tracestate`. The gateway:
   - verifies web's invocation credential (caller `web`), and answers 403 without it;
   - strips `/opt2/svc/<service>`, forwards method, query and body unchanged to that service with its own invocation credential, and passes `Authorization` on unchanged;
   - answers 404 for any other `<service>`, and 503 on connection failure or timeout, without retrying and never reaching legacy;
   - records an `X-Opt2-Write-Position` response header in the read-after-write barrier of the session named by the user token's `sid`, removes it, and returns status, headers (`Set-Cookie` and `Location` included) and body otherwise unchanged.
7. **Response normalisation.** Web's responses reach the client as sent, except:
   - every mode: `x-nextjs-*` headers are dropped, and Next's router members (`rsc`, `next-router-state-tree`, `next-router-prefetch`, `next-router-segment-prefetch`) are removed from `Vary`, which is dropped when nothing remains;
   - page mode (`/admin/<circuit>/<action>` and `/opt2/admin/<module>/<screen>`):
     - `Content-Type` becomes `text/html;charset=UTF-8` (`LEGACY_HTML_CONTENT_TYPE`), replacing Next's `text/html; charset=utf-8`;
     - `proxy.ts` sends `Cache-Control: no-cache, no-store, must-revalidate` with `Expires` exactly where legacy's full layout does. A page response without `Expires` has its `Cache-Control` removed, since that one is Next's own (`private, no-cache, no-store, max-age=0, must-revalidate`) and the compact layout sends none;
     - a 307 (Next `redirect()`) becomes legacy's `cflocation` 302: the same `Location`, an empty body, `Cache-Control: no-cache`, `Pragma: no-cache`, no `Expires`, as `fw1Redirect()` in `src/lib/responses.ts` emits it;
   - everything else as sent, in particular `Generator`, `Strict-Transport-Security`, `Content-Language`, `Content-Encoding`, `Set-Cookie`, `Location`, `Expires` outside the 302 rewrite, and the `Content-Type` of route handlers.
8. **Fail closed.** Connection failure, timeout, or any 5xx from web is answered with `adminUnavailableResponse()` (503, the legacy admin error page), never with legacy and never retried. A page cannot set its status, so in page mode web reports an unavailable service by failing the render (Next answers 500). Route handlers answer 503 themselves (`legacyUnavailable()` in `src/lib/responses.ts`), which the gateway replaces the same way. A service's 401 or 403 is a denial, not unavailability: web raises `GatewayDenialError` and answers it with the access gate's redirect (`deniedGate()` in `src/lib/access-gate.ts`), to `clogin.logout` for 401 and `cMessage.noaccess` for 403.

## Build and run

Prerequisites: Node.js 22.23.4 (`engines` in `package.json`, enforced by `engine-strict=true` in `.npmrc`) and npm 11.21.0. `npm start` also needs the environment below and, locally, the two key files in `${OPT2_STATE_DIR}/secrets/` that `harness/repro/up.sh` generates.

```sh
npm ci                # also installs and builds ../platform (postinstall)
npm run generate      # service clients and resource bundles into src/generated/
npm run build         # runs generate, then next build
PORT=8101 npm start   # next start; reads the environment below
npm test              # runs generate, then vitest with coverage (>= 90% statements)
```

- `npm run generate` writes `src/generated/clients/<service>.ts` from each `../services/<service>/contracts/openapi.yaml` (`generate:clients`) and `src/generated/resource-bundles/` from the legacy `.properties` files (`generate:rb`).
- The container image is the Cloud Run artefact, built in CI only, from the repository root: `docker build -f web/Dockerfile .`. It listens on `8080`.
- `harness/repro/up.sh` starts web with the rest of the stack; set `NEXT_TELEMETRY_DISABLED=1` when running it by hand.

## Environment

Every variable but `MURA_*` is parsed at first use by `webEnvSchema` (`src/lib/env.ts`, extending `baseEnvSchema` of `@opt2/platform/service-kit`), which counts a blank value as unset and throws `EnvValidationError` naming each offending variable.

| Variable | Type / format | Local | Cloud | Use |
|---|---|---|---|---|
| `PORT` | Integer 1–65535 | Required: `8101` (`OPT2_PORT_WEB` in `harness/repro/ports.env`) | Required: `8080` | Listening port |
| `OPT2_SERVICE_NAME` | `web` | Optional: unset is `web`, any other value is rejected | As local | Caller and callee name of local invocation credentials |
| `OPT2_ENV` | `local` or `cloud` | Required: `local` | Required: `cloud` | Selects local or cloud authentication and logging |
| `OPT2_GATEWAY_URL` | Absolute http(s) URL; trailing `/` trimmed | Required | Required | Base of the outbound relay |
| `OPT2_JWKS_URL` | Absolute http(s) URL | Required: identity's `/.well-known/jwks.json` | Optional: defaults to Google's securetoken JWKS | Keys that verify user tokens |
| `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE` | String | Required: `opt2-local-identity`, `opt2-local` | Required: `https://securetoken.google.com/<project>`, `<project>` | Expected user-token `iss` and `aud` |
| `OPT2_STATE_DIR` | Absolute path outside the repository checkout | Optional: defaults to `$HOME/.opt2/state`; holds the key files below | Optional; unused | Runtime state directory |
| `GOOGLE_CLOUD_PROJECT` | Project id | Optional; unused | Required | Invocation-credential checks and log trace ids |
| `PUBSUB_EMULATOR_HOST` | `host:port` | Optional; unused | Must be unset | None: web uses no Pub/Sub |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Absolute http(s) URL | Optional: defaults to `http://localhost:4318` | As local (the collector sidecar) | OTLP/HTTP trace receiver |
| `TZ` | IANA time-zone name, exactly cased, that the process applies (`UTC`, `America/New_York`) | Required | Required | The legacy server's time zone |
| `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER` | `local` or `cloud` | Optional: defaults to, and must equal, `OPT2_ENV` | As local | None: web uses no tasks or storage |
| `MURA_<SETTING>` (27 keys, below) | Masa setting text; booleans and numbers convert as CFML does | Optional | Optional | Masa global settings the shell and lib render |

Locally `${OPT2_STATE_DIR}/secrets/` must hold the local signing key pair (`LOCAL_SECRET_FILES` in `@opt2/platform/auth`), which `harness/repro/up.sh` generates. The cloud reads neither file.

- `token-signing-public.pem` verifies the gateway's invocation credential; without it web authenticates no request.
- `token-signing-private.pem` mints web's invocation credential for the relay; without it web starts, but every relay call fails.

The Masa settings web reads: `MURA_TITLE`, `MURA_CONTEXT`, `MURA_ADMINDIR`, `MURA_ADMINDOMAIN`, `MURA_ADMINSSL`, `MURA_SESSIONTIMEOUT`, `MURA_RENDERMURAALERTS`, `MURA_SECURECOOKIES`, `MURA_SESSIONHISTORY`, `MURA_WINDOWDOCUMENTDOMAIN`, `MURA_LOCALE`, `MURA_ALLOWAUTOUPDATES`, `MURA_FILEMANAGERENABLED`, `MURA_FMSHOWSITEFILES`, `MURA_FMSHOWAPPLICATIONROOT`, `MURA_MODE`, `MURA_DBTYPE`, `MURA_PORT`, `MURA_HTMLEDITORTYPE`, `MURA_FILEDELIM`, `MURA_SITEIDINURLS`, `MURA_INDEXFILEINURLS`, `MURA_INDEXFILEINAPI`, `MURA_EXPIREPASSWORDS`, `MURA_WEBROOT`, `MURA_SITEDIR` and `MURA_ASSETPATH`. Unlike the variables `webEnvSchema` parses, a blank `MURA_*` variable is set, not unset: its configBean setter receives `''`, so `MURA_TITLE=` gives an empty title. An unset variable takes its `core/templates/settings.template.cfm` value. The configBean default applies to a value the setter rejects (`MURA_ADMINDIR=` keeps `/admin`; `MURA_SESSIONHISTORY=` gives `1`, not the template's `0`) and to an unset variable the template lacks, except `MURA_INDEXFILEINAPI`, which then follows `MURA_INDEXFILEINURLS`. `SETTING_RULES` and `resolveLegacySettings` in `src/lib/env.ts` are the per-key table of defaults and conversions. A `${…}` or `{{…}}` value resolves to `''`. `MURA_PORT` is Masa's `port` setting, not web's `PORT`.

Web reads no `PG_*`, `OPT2_DB_AUTH` or `CLOUD_SQL_INSTANCE` variable: it has no database. Leave them, `OPT2_MIGRATION_URL` and `OPT2_SERVICE_URLS` unset; the shared schema still rejects malformed values, and a set `OPT2_DB_AUTH` demands its database variables.

## Tests

- `web/test/**` holds DOM-model (`test/helpers/dom-model.ts`, cheerio) and snapshot tests of the shell, screens and lib. They need no running stack. Page and layout adapters (`*.tsx`) are excluded from coverage; their behaviour is covered through `src/lib`.
- Equivalence is demonstrated only by the proofs below, which run from `harness/` and `web/test/`; this README records no result:
  - **Reproduced screens:** the golden scenarios GS-ID, GS-PE, GS-PS and GS-CO, replayed through the gateway and compared against legacy captures as each scenario declares (`compare` in `harness/golden/catalogue.yaml`): admin screens as DOM models (AAP 0.7.3), plus status, headers, authentication behaviour, envelopes, exports, and stored-row, stored-file and mail side effects; and the browser flows GS-UI-01 to GS-UI-05, which compare DOM, XHR responses and console.
  - **SYNTHETIC modules:** GS-TS, GS-FI, GS-ES, GS-RE, GS-SU and GS-CM prove API parity: the module APIs, called through the gateway, against the legacy-fixture captures (responses and side effects). Their `/opt2/admin/…` and `/opt2/admin-actions/…` steps are `compare: []` coverage visits, not UI comparisons.
  - **SYNTHETIC screens' markup:** DOM snapshot tests under `web/test/screens/opt2/`.
