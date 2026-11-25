# programs-sites

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Programs-sites keeps the catalogue of Masa sites. A "program" is a Masa site, and each site is one tenant whose id is `tenantIdForSite(siteID)`: the UUIDv5 of the lower-cased site id under the namespace `6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c` (`@opt2/platform/tenancy`). The service stores each site's settings, custom image sizes and shared pools, and serves the data behind the Sites and Edit Site admin screens, which `web/` renders. It announces every site and its pools to the other services through `programs-sites.site.changed.v1`, which fills each service's site registry. It also runs the scheduled site monitor, which publishes scheduled change sets, imports remote feeds and runs Masa's other monitor steps on whichever side owns each one.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml), [`contracts/events/programs-sites.site.changed.v1.json`](contracts/events/programs-sites.site.changed.v1.json). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md).

## Masa features replaced

| Masa feature | Masa source | Here |
|---|---|---|
| Sites list, bind order and batch-deploy flags | `csettings.list` [admin/core/controllers/csettings.cfc:97-114]; `settingsManager.saveOrder`, `saveDeploy` [core/mura/settings/settingsManager.cfc:212-242] | `GET /v1/sites`; `POST /v1/sites/order` under CSRF context `updatesites` |
| Edit Site, all tabs | `csettings.editSite` [admin/core/controllers/csettings.cfc:116-118] | `GET /v1/sites/{siteId}`: the stored settings, the `tsettings` extend sets with their values and the custom image sizes; an unknown id yields the defaulted new site. Stored Razuna settings (`trazunasettings`, decision list) stay on legacy and are not returned ([`web/README.md`](../../web/README.md#known-limitations)) |
| Custom image sizes | `csettings.loadcustomimage`, `csettings.loadcustomimages` (`admin/core/views/csettings/loadcustomimage.cfm`, `loadcustomimages.cfm`); table `timagesizes` [core/mura/settings/settingsImageSizeBean.cfc:76] | `/v1/sites/{siteId}/image-sizes` and `/v1/sites/{siteId}/image-sizes/{sizeId}`; no CSRF check, as in legacy. `GET /internal/v1/sites/{siteId}/image-sizes` lists `getSite(siteId).getCustomImageSizeIterator()` for strategies-content's JSON API content `images` [core/mura/client/api/json/v1/jsonApiUtility.cfc:3574-3615] |
| Access gate | `csettings.before()`: S2, or an `Admin` of the site's private user pool except on the list, plugin and site-copy actions [admin/core/controllers/csettings.cfc:85-95] | Roles `s2` and `site-admin` ([Routes](#routes)) |
| Pools | `publicUserPoolID`, `privateUserPoolID`, `displayPoolID`, `contentPoolID`, `categoryPoolID`, `filePoolID`, each defaulting to the site's own id [core/mura/settings/settingsBean.cfc:119-124,328-344] | Stored on `programs_sites.site` and published as legacy site ids in `site.changed`; each consumer resolves them to tenant UUIDs in its `tenant_registry`. Pooled rows of other services carry the pool site's tenant |
| JSON API entity `site` | Public entity [core/mura/client/api/json/v1/jsonApiUtility.cfc:69-73]; an unknown `siteid` falls back to `default` [core/mura/content/contentServer.cfc:610-622] | Every `/_api/{json,ajax,rest}/v1` path, also behind `/index.cfm` and in any letter case, under every verb: `findOne`, `findAll`, `findMany`, `findQuery`, `findNew`, `findProperties`, `findPermissions`, `validate` and `delete`; the withheld `save` answers the legacy-shaped 503 ([below](#json-api-site)) |
| Admin layout site data, a user's sites, href domains | `settingsManager.getUserSites`, `contentServer.bindToDomain(isAdmin=true)`, `utility.sanitizeHref` | `GET /v1/sites/{siteId}/shell`, `GET /v1/sites/{siteId}/user-pool-sites`, `GET /v1/user-sites` (for `web/`), `GET /v1/href-domains` (for the gateway) |
| Site login-mail settings | `settingsManager.getSite` [core/mura/settings/settingsManager.cfc:537-567]; `getUseSSL`, `getEditProfileURL`, `getServerPort`, `getContext` [core/mura/settings/settingsBean.cfc:396-402,559-569,1395-1414] | `POST /internal/v1/sites/mail-settings:lookup` (for identity's login mail) |
| Site RSS settings | `settingsManager.getSite` [core/mura/settings/settingsManager.cfc:537-567] as the RSS writers read it [core/mura/client/api/feed/v1/feedApiUtility.cfc:257-446]; `getContact`, `getJavaLocale`, `getDomain`, `isValidDomain`, `getUseSSL`, `getServerPort`, `getContext` [core/mura/settings/settingsBean.cfc:376-387,396-402,647-654,1189-1221,1395-1414] | `POST /internal/v1/sites/feed-settings:lookup` (for strategies-content's `/_api/feed/v1`) |
| Site Manager `$.siteConfig` flags | `MasaScope.siteConfig` [core/mura/MasaScope.cfc:304-330] over `settingsManager.getSite` [core/mura/settings/settingsManager.cfc:537-567]; `setScaffolding`, `getDataCollection`, `setHasComments`, `setHasLockableNodes` [core/mura/settings/settingsBean.cfc:360-364,427-433,576-581,1336-1341]; `getHasFeedManager` [core/mura/settings/settingsBean.cfc:126,411-418] for the cfeed gate [admin/core/controllers/cfeed.cfc:86-88] | `POST /internal/v1/sites/config-flags:lookup` (for strategies-content's `carch` views and `cfeed` gate) |
| JSON API `site` relations of other entities | `expandEntity` and relation paths read `findOne('site')` under the request site [core/mura/client/api/json/v1/jsonApiUtility.cfc:1086-1150,2292-2384,2424-2497] | `POST /internal/v1/sites/json-api-values:lookup` (for strategies-content's `expand=site` and `<entity>/<id>/site`) |
| In-memory site registry rebuild | `settingsManager.setSites` [core/mura/settings/settingsManager.cfc:440-486] | `programs-sites.site.changed.v1` into every service's `tenant_registry`; legacy is refreshed by the migration projector through `gateway/legacy-bridge/cfml/site.cfm?op=refresh` |
| Site monitor | `/_api/sitemonitor` [core/mura/content/contentServer.cfc:669-747]; ACF task registration [core/appcfc/onApplicationStart_include.cfm:549-579] | `src/jobs/sitemonitor.ts` ([below](#site-monitor)) |

### Site monitor

The orchestrator keeps legacy's semantics:

- **Cursor.** `application.lastMonitored` is the one `programs_sites.sitemonitor_state` row of the system tenant, behind a run lease, so one pass runs at a time across instances. Without a stored cursor it starts one minute before the run [core/mura/content/contentServer.cfc:676]. It moves to the run time only after every step ran [core/mura/content/contentServer.cfc:745]; a failed pass leaves it unchanged.
- **Catch-up.** Reminders also run for `theTime − 30 min` when the minute of the cursor differs from the minute of `theTime − 30 min` [core/mura/content/contentServer.cfc:677-681].
- **Fixed order.** Reminders, email send, scheduled change sets; then per site, bounces where `EmailBroadcaster` is set and feed import where `FeedManager` is set; display-window purge over `[lastMonitored, theTime]` [core/mura/content/contentServer.cfc:702-733]; cluster cleanup; `onGlobalMonitor`; `onSiteMonitor` per site; cursor.
- **Bounce dedupe.** Legacy discards the `listAppend` result [core/mura/content/contentServer.cfc:694], so its mail-server dedupe never skips a site. That is reproduced.

Each step is routed by its own write set, read from migration `GET /internal/v1/authority`:

| Step | Runs on |
|---|---|
| Scheduled change sets, feed import | A Cloud Task to strategies-content (`content-scheduled-publish` → `/internal/v1/jobs/publish-scheduled-changesets`, `content-feed-import` → `/internal/v1/jobs/feed-auto-import`) once every unit it writes is `target`-authoritative. Both can write `tcontenteventreminders`, a decision-list table that never moves, so in this run they run on legacy |
| Reminders, email send, bounces, display-window purge, cluster cleanup, plugin events | Always legacy |

A legacy step goes to migration `POST /internal/v1/legacy-steps`, which calls `gateway/legacy-bridge/cfml/jobs.cfm?job=<step>` with the orchestrator's `theTime` and `lastMonitored`, inside a write window when the step writes `target`-authoritative units. The last step, `setCursor`, aligns `application.lastMonitored`.

`/_api/sitemonitor` is public, as in legacy, in any letter case and behind `/index.cfm`, and runs for any method the gateway forwards (GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS), as legacy does. Legacy also runs the monitor for QUERY, the WebDAV verbs, CONNECT and non-standard tokens (only TRACE gets a server 405); the platform declares and serves only those seven methods (OpenAPI 3.1.0 contracts and the gateway edge), so the target answers the others with a 4xx and does not run the monitor. The recurring trigger is the self-rescheduling Cloud Task chain on `programs-sites-sitemonitor` (900 s interval, 600 s deadline) calling `/internal/v1/jobs/sitemonitor`. Service start-up never creates it. Only `opt2-tasks reconcile --with-sitemonitor` does, which the scheduler hand-off (`migration/src/scheduler/`) runs only when a native ACF task existed, so a legacy `ping=false` monitor never runs. The hand-off seeds the cursor through `PUT /internal/v1/sitemonitor/state`.

Callers never queue behind a pass, where legacy runs one per caller. A caller that arrives while a pass runs in the process gets that pass's outcome. One that finds another instance's run lease waits for it: once that holder's pass has moved the cursor, the caller is answered as covered by it; when the holder ended without moving it, the caller runs its own pass. A public caller waits at most `PUBLIC_RUN_BUDGET_MS`, the gateway's target forward bound (the 30 s gate wait plus the 10 s service-call bound) less `PUBLIC_RUN_MARGIN_MS` (1 s), and then gets the legacy 503 while the pass runs on to the 600 s queue deadline, so the gateway always receives the empty `200` or the legacy 503 before its own timeout. The task route keeps the 600 s queue deadline and answers the result of the pass it ran or joined.

### JSON API site

- **Method.** The route key of `platform/src/legacy-compat/route-key.ts` picks the method as `processRequest` does [core/mura/client/api/json/v1/jsonApiUtility.cfc:856-900,989-1316]. A `/site/<x>` path is `findOne` under any verb. The bare entity path maps GET to `findOne`, POST and PUT to the withheld `save`, and DELETE to `delete`; HEAD, OPTIONS and PATCH of it call nothing and answer the empty result `{"apiversion":"v1","data":"","method":"undefined"}`. `?method=<m>&entityname=site` and `/<m>?entityname=site` call `<m>` under any verb and report it as spelled.
- **HEAD** sends the status, ETag and headers of the GET answer without a body or `Content-Length`, as legacy does.
- **Feeds.** `findAll`, `findMany` (`ids` required) and `findQuery` read the feed of the API site: `contentpoolid=*` takes its content pool, a listed pool is bounded by it, and each site is read in its own tenant. Paging, blank rows past the last one, `countOnly`, `distinct` and `fields` follow `setFeedProps`, `setIteratorProps` and `packageIteratorArray` [core/mura/client/api/json/v1/jsonApiUtility.cfc:280-370,2542-2918,2955-3185]; `findQuery` filters on `tsettings` columns as `queryParam` binds them [core/mura/queryParam.cfc:60-360]. Legacy orders the query parameters of the `findAll` and `findMany` self links differently from request to request; the target sends one of those orders.
- **`delete` never writes.** Without a stored site it answers the empty result; a caller without S2 gets `authorization`; the session modes then consume the CSRF token; then, the settings bean defining no `delete`, it answers `server_error` [core/mura/client/api/json/v1/jsonApiUtility.cfc:3259-3335].
- **Legacy-shaped 503**, writing nothing, where the legacy answer is not reproduced: `findQuery` aggregates (`sum`, `avg`, `count`, `max`, `min`, `groupBy`) and `distinct` (legacy then returns every `tsettings` column, the mail server password included); multi-part column identifiers, criteria naming another entity's column, comparisons converting between column types and a timestamp list bound empty; `ishuman` (CFFormProtect markup); `validate` of another entity or with ad hoc property rules (these site forms are `EX-SITE-FEED-SUBFORMS` in [`opt2/exceptions-list.md`](../../opt2/exceptions-list.md), the `distinct` leak SEC-07 in [`opt2/reports/pre-existing-defects.md`](../../opt2/reports/pre-existing-defects.md)); method calls without `entityname` (`api:.<method>`, which no service owns).
- **`save` is withheld** ([`opt2/decision-list.json`](../../opt2/decision-list.json) `trazunasettings`): every form that resolves to `site.save` (POST or PUT of the entity path, `?method=save`, `/<site>/save`, a bundle upload) answers the legacy-shaped 503 before any site read, CSRF consume or write, and legacy serves it.
- **Request start-up scan**, as in every service: routes read the url and form scopes as Masa's Portcullis scan leaves them (`platform/src/legacy-compat/portcullis.ts`, `request-scopes.ts`; service-kit `legacyParamsOf`, `legacyScopesOf`). The url is always scanned; form and multipart field text unless the body is JSON, which is read as sent; a file part by its file name. Names differing only in case are joined under the first spelling, values in sent order; names CFML cannot hold are dropped; NULs are removed; outside Masa's exception fields the tag and word filters put `[INVALID]` in place of a match; values are trimmed. A scan fault, such as a `null` value, answers legacy's 500 error page on the root-served JSON API and site-monitor paths (`platform/src/service-kit/create-service.ts`). The route key is taken on the scanned scopes (`scannedRouteKey`, `platform/src/legacy-compat/scanned-route-key.ts`); an outcome ColdFusion's runtime decides keys the `{scriptprotect=fault}` variant, which legacy serves (`EX-ADMIN-SCAN-FAULT` in [`opt2/exceptions-list.md`](../../opt2/exceptions-list.md)).

## Owned data

Schema `programs_sites`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with three roles:

| Role | Use |
|---|---|
| `programs_sites_owner` | `NOLOGIN`; owns the schema and every object, and FORCE RLS applies to it |
| `programs_sites_app` | Runtime DML only; the service's `PG_USER` |
| `programs_sites_migrator` | Applies `db/migrations/*.sql` after `SET ROLE programs_sites_owner` |

Legacy tables, as split in [`opt2/table-ownership.json`](../../opt2/table-ownership.json) (rule step 1):

| Legacy table | Target table | Rows | Row identity |
|---|---|---|---|
| `tsettings` [core/setup/db/mssql.sql:370] | `site` | All | `SiteID`. The bootstrap DDL declares no key; [core/mura/dbUpdates/6.1.cfm:120-122] adds the one the live catalog carries |
| `timagesizes` [core/mura/dbUpdates/5.7.cfm:94-102] | `image_size` | All | `sizeID` |
| `tdirectories` [core/mura/dbUpdates/5.7.cfm:158-164] | `directory` | All | `dirID` |
| `tsystemobjects` [core/setup/db/mssql.sql:436] | `system_object` | All | No key: multiset, stored with `legacy_row_hash` and `occurrence` |
| `tclassextend` | `extend_subtype` | Subtypes whose `baseTable` programs-sites owns: `tsettings`, `tdirectories`, `timagesizes`, `tsystemobjects` | `subTypeID` |
| `tclassextendsets` | `extend_set` | Sets of those subtypes | `extendSetID` |
| `tclassextendattributes` | `extend_attribute` | Attributes of those sets | `attributeID` |
| `tclassextendrcsets` | `extend_rc_set` | Related-content sets of those subtypes | `relatedContentSetID` |
| `tclassextenddata` | `extend_data` | Values of those attributes | `dataID` |
| `ttrash` | `trash` | `extendObject` rows whose `baseTable` programs-sites owns | `objectID` |

Also owned: `sitemonitor_state` (new), and the platform tables `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `outbox`, `inbox`, `consumer_aggregate_version`, `scheduled_task_queue` and `scheduled_task_queue_state`.

Every tenant-owned table has `tenant_id uuid NOT NULL` and row-level security enabled and forced, with the `tenant_isolation` policy on `app.tenant_id`. `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` hold tenant metadata only. No table declares a foreign key.

## Routes

Every route declares `config.opt2.requires` or `config.opt2.public`; anything else fails start-up. A public route waives the user token, not the caller's invocation credential, which only `/healthz` may omit. `site-admin` is a member of the site's private-pool `Admin` group, and `system-user` any authenticated private-pool user.

### Legacy routes

Route keys are those of `platform/src/legacy-compat/route-key.ts`; the state is the one in `gateway/cutover/versions/v0001.json` to `v0003.json`.

| Route key | Legacy entry | Served by | Committed state |
|---|---|---|---|
| `admin:csettings.list` | Sites screen, with its order and deploy save | `web/` → `GET /v1/sites`, `POST /v1/sites/order` | `target` from `v0002`; `legacy` in `v0001` |
| `admin:csettings.editsite` | Edit Site | `web/` → `GET /v1/sites/{siteId}` | `legacy` |
| `admin:csettings.updatesite{action=update}` | Edit Site save | Legacy; `POST /v1/sites/{siteId}/update` answers the legacy-shaped 503 | `legacy-write`, decision |
| `admin:csettings.loadcustomimage` | Image size dialog | `web/` → `GET /v1/sites/{siteId}/image-sizes/{sizeId}` | `legacy` |
| `admin:csettings.loadcustomimages` | Image size list, save and delete | `web/` → `GET /v1/sites/{siteId}/image-sizes`; `PUT`, `DELETE /v1/sites/{siteId}/image-sizes/{sizeId}` | `legacy` |
| `api:site.findone`, `findall`, `findmany`, `findquery`, `findnew`, `findproperties`, `findpermissions`, `validate`, `delete`, and their `rest:` keys | JSON API site methods | `/_api/{json,ajax,rest}/v1*`, also behind `/index.cfm` | `legacy` |
| `api:site.save`, `rest:site.save` | JSON API site save | Legacy; `/_api/{json,ajax,rest}/v1*` answer the legacy-shaped 503 | `legacy-write`, decision |
| `api:site.http-head`, `http-options`, `http-patch`, and their `rest:` keys | HEAD, OPTIONS and PATCH of the bare entity path | `/_api/{json,ajax,rest}/v1*`, also behind `/index.cfm` | no entry: legacy |
| `sitemonitor:run` | `/_api/sitemonitor` | `/_api/sitemonitor` | `target` from `v0002` |

Why the other site routes stay on legacy in this run:

- Only the site and image-size groups have carry write entries (`admin:csettings.list`, `admin:csettings.loadcustomimages`). `grp:programs_sites.site` is `target`-authoritative from `v0002`: `gateway/src/cutover/prevented-writers.ts` closes the non-request writers of `tsettings` (Masa's start-up bundle deploy, project-site creation and the theme-config site save, and the siteMonitor run's writes). `grp:programs_sites.image_size` stays `legacy`-authoritative in every version: the theme-config image-size upsert (`settingsImageSizeBean.save` through `core/mura/extend/extendManager.cfc:1998-2012`, called at `core/appcfc/onApplicationStart_include.cfm:844`) writes `timagesizes` on every start-up, reload and re-initialisation, and nothing closes it. The other units have no carry write entry, and every read entry's units are all ten `programs_sites` units, so the reads stay `legacy`.
- The Edit Site save and JSON API `site.save` write `trazunasettings` on every save [core/mura/settings/settingsManager.cfc:271], a decision-list table, plus strategies-content and people extension definitions and `tfiles`. They stay `legacy-write` entries, run on legacy inside write windows.

The service implements the other routes in full, so a later version can move them once those blockers are settled. The two withheld saves are not built.

### `/v1` and `/v2` APIs

| Method and path | Requires | Does |
|---|---|---|
| `GET /v1/sites` | `s2` | Sites screen rows, sorted as legacy sorts them |
| `GET /v2/sites` | `s2` | One keyset page of the Sites screen rows in site-id order: `limit` 1 to 1000 (default 50), `after` the previous page's `next`; answers `{items: SiteListItem[], next}`, `next` null after the last page |
| `POST /v1/sites/order` | `s2` | Saves bind order and batch-deploy flags, then returns the rows |
| `GET /v1/sites/{siteId}` | `s2`, `site-admin` | One site's Edit Site data: stored settings, `tsettings` extend sets with their values, custom image sizes. Stored Razuna settings stay on legacy and are not returned ([`web/README.md`](../../web/README.md#known-limitations)) |
| `GET /v1/sites/{siteId}/shell` | `s2`, `site-admin`, `system-user` | Site settings the admin layout reads |
| `GET /v1/sites/{siteId}/user-pool-sites` | `s2`, `site-admin`, `system-user` | The same settings of the site's registered private, then public, user pool sites, each once; the user form's photo URL reads a pooled user's site |
| `POST /v1/sites/{siteId}/update` | `s2`, `site-admin` | Refuses the Edit Site save: `invalidParameters` 400 for any action but `Update`, the legacy-shaped 503 for the withheld `Update`; it consumes no CSRF token and writes nothing |
| `GET /v1/sites/{siteId}/image-sizes` | `s2`, `site-admin` | The site's custom image sizes |
| `GET /v2/sites/{siteId}/image-sizes` | `s2`, `site-admin` | One keyset page of the site's custom image sizes by `sizeid`, paged as `GET /v2/sites` |
| `GET`, `PUT`, `DELETE /v1/sites/{siteId}/image-sizes/{sizeId}` | `s2`, `site-admin` | Read (defaulted new size for an unknown id), create or update, delete |
| `GET /v1/href-domains` | `service:gateway` | Registered domains and the site domain an absolute href is checked against |
| `GET /v1/user-sites` | `s2`, `site-admin`, `system-user` | Sites the token's user administers, and the site the given host binds to |
| `GET /v2/user-sites` | `s2`, `site-admin`, `system-user` | One keyset page of those sites in site-id order, paged as `GET /v2/sites`: the registry's page for `s2`, else the session's site ids in code-point order; answers `{items: UserSite[], next}` and binds no host |

### Internal and managed routes

| Method and path | Transport | Requires |
|---|---|---|
| `POST /internal/v1/migration/apply`; `GET /internal/v1/migration/export`, `changes`, `position`; `GET`, `POST /internal/v1/migration/watermark`; `POST /internal/v1/migration/gate` | service | `platform.migration` |
| `GET`, `PUT /internal/v1/sitemonitor/state` | service | `platform.migration` |
| `POST /internal/v1/sites/mail-settings:lookup` | service | `service:identity`: the mail settings `getSite` resolves for each listed id, in order |
| `POST /internal/v1/sites/feed-settings:lookup` | service | `service:strategies-content`: the contact, Java locale, domains, SSL and remote port and context `getSite` resolves for each listed id, in order |
| `POST /internal/v1/sites/config-flags:lookup` | service | `service:strategies-content`: the hasLockableNodes, hasChangesets, dataCollection, hasComments, scaffolding and hasFeedManager flags `getSite` resolves for each listed id, in order |
| `POST /internal/v1/sites/json-api-values:lookup` | service | `service:strategies-content`: the values the JSON API's `site` findOne answers for each listed id under the given endpoint, in order; an unregistered id answers the new bean |
| `GET /internal/v1/sites/{siteId}/image-sizes` | service | `service:strategies-content`: the custom image sizes of the site `getSite` resolves (an unknown id resolves to `default`), by `sizeid` |
| `POST /internal/v1/task-queues/{queue}/pause`, `resume`, `ensure` | service | `platform.migration`, `platform.operator` |
| `POST /internal/v1/events/programs-sites.programs-sites.site.changed.v1` | Pub/Sub push | `service:pubsub-invoker` |
| `POST /internal/v1/outbox/sweep` (`programs-sites-outbox-sweep`) | Cloud Tasks | `service:tasks-invoker` |
| `POST /internal/v1/jobs/sitemonitor` (`programs-sites-sitemonitor`) | Cloud Tasks | `service:tasks-invoker` |
| `GET /healthz` | service | public, invocation credential optional |

Queues this service creates tasks on (`platform/src/tasks/queues.ts`): `programs-sites-sitemonitor`, `programs-sites-outbox-sweep`, `content-scheduled-publish` and `content-feed-import`.

## Not built here

- **Withheld** (decision list, [`opt2/decision-list.md`](../../opt2/decision-list.md); they keep running on legacy): `admin:csettings.updatesite{action=update}`, `api:site.save` and `rest:site.save`, which write `trazunasettings` on every save [core/mura/settings/settingsManager.cfc:271], so their extended attributes, placeholder image, display-pool copy, bundle deploy and runtime effects stay on legacy too; `admin:csettings.updatesite{action=add}`, `admin:csettings.updatesite{action=delete}`, `admin:csettings.sitecopyselect`, `admin:csettings.sitecopy`, `admin:cextend.*` and `admin:ctrash.*`; also `admin:csettings.updatesite{bundle}` and the plugin writes `deleteplugin`, `deployplugin` and `updateplugin`, which write `tplugins*` (decision list). Programs-sites builds no class-extension definition or trash management: it writes the `tsettings` subtype, set, attribute and related-content-set rows and the site trash rows only through migration. It does read the site's extend sets and their values for Edit Site. `admin:csettings.sitecopyresult` has no screen here and stays on legacy with the site copy it reports.
- **Legacy-served:** `csettings` createBundle, selectBundleOptions, deployBundle, exportHTML, editPlugin and updatePluginVersion.

## Events

Produces `programs-sites.site.changed.v1`, kind `state`:

| Envelope field | Value |
|---|---|
| `aggregateType`, `aggregateId` | `site`, the legacy site id; `aggregateId` is the ordering key |
| `aggregateVersion` | The site's `row_version`, incremented in the same transaction. A deletion, and a later creation of the same site id, continue above the highest version in the site's outbox rows |
| `tenantId` | The site's tenant |
| `payload` | `siteId`, `publicUserPoolId`, `privateUserPoolId`, `categoryPoolId`, `filePoolId`, `displayPoolId`, `contentPoolIds`, `domains`; `deleted: true` when the site was deleted, the other fields then carrying its last stored state |

Every other service consumes it, and so does programs-sites itself, into `<schema>.tenant_registry`. Pool ids arrive as legacy site ids after Masa's defaults, and consumers store each with its tenant UUID; a `deleted` event marks the site's entry deleted, so the site is unknown to tokens and routes while outbox sweeps and task scans still reach its tenant. Migration applies emit it too, as a state event, for each `tsettings` insert, update and delete.

## How to run

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
npm run lint            # eslint, typescript-eslint recommended
npm run typecheck       # contract types, then tsc over src/ and test/ without emitting
```

`test/unit` and `test/contract` need nothing external. The isolation and event suites need PostgreSQL 16 through `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, plus `PUBSUB_EMULATOR_HOST` where they publish, and create a throwaway schema and roles per run through `@opt2/platform/testing`.

- **Local.** `harness/repro/up.sh` starts the service natively with `PORT=8113` and `PG_USER=programs_sites_app`. It reads `baseEnvSchema` of `@opt2/platform/service-kit` (details in [`platform/README.md`](../../platform/README.md#configuration)): `PORT`, `OPT2_SERVICE_NAME`, `OPT2_ENV`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `OPT2_DB_AUTH`, `CLOUD_SQL_INSTANCE`, `PUBSUB_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_LOG_LEVEL`, `OPT2_JWKS_URL`, `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, `OPT2_SERVICE_URLS`, `OPT2_STATE_DIR`, `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER`, `TZ`. It also reads Masa settings from `MURA_<KEY>` variables, as Masa start-up does [core/appcfc/onApplicationStart_include.cfm:136-150,167-181], and refuses to start on a malformed one: `MURA_LOCALE`, configBean's locale and so the RSS Java locale of a site without a siteLocale (`Server` when unset, empty or a `${…}`/`{{…}}` expression, which only CFML evaluates); `MURA_ADMINSSL`, `MURA_PORT`, `MURA_CONTEXT`, `MURA_ADMINDOMAIN` and `MURA_APPRELOADKEY`, for the JSON API `site` links, route key and CORS allow-list and a user's sites. The service calls identity (CSRF) and migration (authority, legacy steps), and creates tasks for itself and strategies-content, so those must resolve through `OPT2_SERVICE_URLS` or `OPT2_MIGRATION_URL`.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `programs_sites_app`, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).
