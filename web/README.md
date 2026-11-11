# @opt2/web — Masa admin on Next.js

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

A Next.js 16 App Router service that reproduces the legacy Masa 7.6.1 admin screens without redesign. Browser URLs stay legacy (`/admin/?muraAction=…`), and the gateway maps each admin request here by the action's inventoried response mode (AAP 0.4.9).

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
| Sites list, edit site (all tabs) | `admin/core/views/csettings/` | programs-sites |
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

## How it renders

- Shell and screens are server-only TypeScript that produce escaped HTML strings through `src/lib/html.ts` (`html`, `attr`, `join`, `raw`). Page mode embeds that markup in one container of the React root, with no client components, so legacy jQuery, OneUI, CKEditor and nice-select operate on the DOM exactly as on legacy. Route handlers return the same strings.
- Legacy static assets are referenced in place (`/admin/assets/**`, `/core/vendor/**`, `/core/modules/**`) and served by legacy through the gateway. Nothing is copied, and no component library or new stylesheet is added.
- Labels come from `core/mura/resourceBundle/resources/*.properties`, with core-module bundles from `core/modules/v1/core_assets/resource_bundles/` and global overrides from `resource_bundles/`, compiled into `src/generated/resource-bundles/` at build time.
- Masa global settings are read from `MURA_<SETTING>` variables, with the defaults of `core/templates/settings.template.cfm`. A value Masa would evaluate as CFML (`${…}`, `{{…}}`) resolves to `''`.
- Next layouts cannot read the query, so page mode applies the `<html>` and `<body>` attributes with a first-in-body inline script. Route-handler documents carry them literally. Either way the DOM model the golden comparator builds equals legacy's.
- Links, form actions and redirects use the legacy form (`adminUrl` from `@opt2/platform/legacy-compat`, FW/1 `buildURL` as `buildUrl` in `src/lib/urls.ts`).

## Gateway ↔ web contract

This section is normative for `gateway/` (`src/admin/map.ts`, the dispatcher and its forwarding) and for `web/src/lib`. Header names are case-insensitive on the wire.

1. **Listening.** Web listens on `PORT`: `8101` locally (`OPT2_PORT_WEB` in `harness/repro/ports.env`), `8080` on Cloud Run. Ingress is internal only, and the gateway is web's only invoker.
2. **Paths by response mode** (AAP 0.4.9). `<circuit>` and `<action>` are the two parts of the admin route key's base key (`RouteKeyResult.baseKey` after `admin:`): the FW/1 action lower-cased, without `core:` and without variant braces, each URI-component-encoded. The query is the original query string byte for byte, never parsed or re-encoded; a request without one gets no `?`.

   | Response mode | Web path | Method and body |
   |---|---|---|
   | `page` | `/admin/<circuit>/<action>?<original query>` | `GET` (a `POST` is rewritten, item 3) |
   | `redirect` | `/admin-actions/<circuit>/<action>?<original query>` | Original method and body |
   | `fragment`, `json`, `download` | `/admin-raw/<circuit>/<action>?<original query>` | Original method and body |
   | SYNTHETIC | `/opt2/admin/<module>/<screen>`, `/opt2/admin-actions/<module>/<action>` | Path, query, method and body unchanged |

   The mode is the inventoried one (`ResponseModes.modeFor(routeKey)`); an action without one is never `target`, so it never reaches web.
3. **Request facts.** On every request in the `page`, `redirect`, `fragment`, `json` and `download` modes the gateway adds `X-Opt2-Original-Url`: the browser's request target as received, path and query, including FW/1 path-info pairs (for example `/admin/index.cfm/cusers/list/siteid/default?compactDisplay=true`). Web derives the path info and the URL scope from it and performs the FW/1 context merge itself (path pairs, then URL, then form, later overwriting earlier; `fuseaction` overriding `muraAction` per scope). A Next page cannot read a request body, so a `POST` to a `page`-mode action is forwarded as `GET` with its form fields appended to the query: the original query string, then `&` when both are non-empty, then the fields.
   - `application/x-www-form-urlencoded`: the body bytes unchanged.
   - `multipart/form-data`: the text fields URL-encoded in body order; file parts are dropped, because a page-mode view only renders.
   - Any other body contributes no fields, as legacy's form scope is then empty.

   Web takes the URL scope from `X-Opt2-Original-Url` and the form scope from what follows it in the query it receives.
4. **Inbound headers.**
   - `Authorization: Bearer <site-scoped user token>`, minted by identity for the session and site; absent when anonymous.
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
8. **Fail closed.** Connection failure, timeout, or any 5xx from web is answered with `adminUnavailableResponse()` (503, the legacy admin error page), never with legacy and never retried. A page cannot set its status, so in page mode web reports an unavailable service by failing the render (Next answers 500). Route handlers answer 503 themselves (`legacyUnavailable()` in `src/lib/responses.ts`), which the gateway replaces the same way.

## Build and run

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

| Variable | Use |
|---|---|
| `PORT` | Listening port (required) |
| `OPT2_SERVICE_NAME` | Defaults to `web`; no other value is accepted |
| `OPT2_ENV` | `local` or `cloud` |
| `OPT2_GATEWAY_URL` | Gateway base URL for the relay (required) |
| `OPT2_JWKS_URL` | Identity's JWKS for user tokens (required locally) |
| `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE` | Expected user-token `iss` and `aud` |
| `OPT2_STATE_DIR` | Locally, `secrets/` holds the key pair web mints and verifies invocation credentials with |
| `GOOGLE_CLOUD_PROJECT` | Cloud project (required in the cloud) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP trace endpoint |
| `TZ` | The legacy server's time zone |
| `MURA_<SETTING>` | Masa global settings the shell renders, for example `MURA_TITLE`, `MURA_CONTEXT`, `MURA_ADMINDIR`, `MURA_ADMINSSL`, `MURA_SESSIONTIMEOUT` |

Web reads no `PG_*` variable: it has no database.

## Tests

- `web/test/**` holds DOM-model (`test/helpers/dom-model.ts`, cheerio) and snapshot tests of the shell, screens and lib. They need no running stack. Page and layout adapters (`*.tsx`) are excluded from coverage; their behaviour is covered through `src/lib`.
- End-to-end proof is the golden scenarios in `harness/`, replayed through the gateway against legacy captures: GS-ID, GS-PE, GS-PS, GS-CO and the browser flows GS-UI-01 to GS-UI-05 for reproduced screens, and the SYNTHETIC GS-TS, GS-FI, GS-ES, GS-RE, GS-SU and GS-CM sets for module screens.
