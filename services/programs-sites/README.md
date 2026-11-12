# programs-sites

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Programs-sites keeps the catalogue of Masa sites. A "program" is a Masa site, and each site is one tenant whose id is `tenantIdForSite(siteID)`: the UUIDv5 of the lower-cased site id under the namespace `6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c` (`@opt2/platform/tenancy`). The fixture schemas `Program_1` and `Program_2` map to the sites `tenant-a` and `tenant-b` through `synthetic.program_site`. The service stores each site's settings, custom image sizes and shared pools, and serves the data behind the Sites and Edit Site admin screens, which `web/` renders. It announces every site and its pools to the other services through `programs-sites.site.changed.v1`, which fills each service's site registry. It also runs the scheduled site monitor, which publishes scheduled change sets, imports remote feeds and runs Masa's other monitor steps on whichever side owns each one.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml), [`contracts/events/programs-sites.site.changed.v1.json`](contracts/events/programs-sites.site.changed.v1.json). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md).

## Masa features replaced

| Masa feature | Masa source | Here |
|---|---|---|
| Sites list, bind order and batch-deploy flags | `csettings.list` [admin/core/controllers/csettings.cfc:97-114]; `settingsManager.saveOrder`, `saveDeploy` [core/mura/settings/settingsManager.cfc:212-242] | `GET /v1/sites`; `POST /v1/sites/order` under CSRF context `updatesites` |
| Edit Site, all tabs | `csettings.editSite` [admin/core/controllers/csettings.cfc:116-118] | `GET /v1/sites/{siteId}`; an unknown id yields the defaulted new site |
| Edit Site save, `action=Update` | `csettings.updateSite` [admin/core/controllers/csettings.cfc:170-225]; `settingsManager.update` [core/mura/settings/settingsManager.cfc:251-304]; `settingsDAO.update` [core/mura/settings/settingsDAO.cfc:318-420] | `POST /v1/sites/{siteId}/update` under CSRF context = site id; a failed check writes nothing, as in legacy |
| Custom image sizes | `csettings.loadcustomimage`, `csettings.loadcustomimages` (`admin/core/views/csettings/loadcustomimage.cfm`, `loadcustomimages.cfm`); table `timagesizes` [core/mura/settings/settingsImageSizeBean.cfc:76] | `/v1/sites/{siteId}/image-sizes` and `/v1/sites/{siteId}/image-sizes/{sizeId}`; no CSRF check, as in legacy |
| Access gate | `csettings.before()`: S2, or an `Admin` of the site's private user pool except on the list, plugin and site-copy actions [admin/core/controllers/csettings.cfc:85-95] | Roles `s2` and `site-admin` ([Routes](#routes)) |
| Pools | `publicUserPoolID`, `privateUserPoolID`, `displayPoolID`, `contentPoolID`, `categoryPoolID`, `filePoolID`, each defaulting to the site's own id [core/mura/settings/settingsBean.cfc:119-124,328-344] | Stored on `programs_sites.site` and published as legacy site ids in `site.changed`; each consumer resolves them to tenant UUIDs in its `tenant_registry`. Pooled rows of other services carry the pool site's tenant |
| JSON API entity `site` | Public entity [core/mura/client/api/json/v1/jsonApiUtility.cfc:69-73]; an unknown `siteid` falls back to `default` [core/mura/content/contentServer.cfc:610-622] | `/_api/{json,ajax,rest}/v1/{siteid}/site`: `findOne`, and `save` of the addressed, existing site. Every other site method answers the legacy-shaped 503 |
| Admin layout site data, a user's sites, href domains | `settingsManager.getUserSites`, `contentServer.bindToDomain(isAdmin=true)`, `utility.sanitizeHref` | `GET /v1/sites/{siteId}/shell`, `GET /v1/user-sites` (for `web/`), `GET /v1/href-domains` (for the gateway) |
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

`/_api/sitemonitor` is public, as in legacy, in any letter case and behind `/index.cfm`. The recurring trigger is the self-rescheduling Cloud Task chain on `programs-sites-sitemonitor` (900 s interval, 600 s deadline) calling `/internal/v1/jobs/sitemonitor`. Service start-up never creates it. Only `opt2-tasks reconcile --with-sitemonitor` does, which the scheduler hand-off (`migration/src/scheduler/`) runs only when a native ACF task existed, so a legacy `ping=false` monitor never runs. The hand-off seeds the cursor through `PUT /internal/v1/sitemonitor/state`.

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
| `tclassextend` | `extend_subtype` | Subtypes with `baseTable = 'tsettings'` | `subTypeID` |
| `tclassextendsets` | `extend_set` | Sets of those subtypes | `extendSetID` |
| `tclassextendattributes` | `extend_attribute` | Attributes of those sets | `attributeID` |
| `tclassextendrcsets` | `extend_rc_set` | Related-content sets of those subtypes | `relatedContentSetID` |
| `tclassextenddata` | `extend_data` | Values of those attributes; target rows take negative `dataID`s from `extend_data_dataid_seq` | `dataID` |
| `ttrash` | `trash` | `extendObject` rows whose `baseTable` is `tsettings` | `objectID` |

Also owned: `sitemonitor_state` (new), and the platform tables `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `outbox`, `inbox`, `consumer_aggregate_version`, `scheduled_task_queue` and `scheduled_task_queue_state`. `synthetic.program_site` is owned too but not migrated; the migration kit reads it to fold `Program_<id>` rows.

Every tenant-owned table has `tenant_id uuid NOT NULL` and row-level security enabled and forced, with the `tenant_isolation` policy on `app.tenant_id`. `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` hold tenant metadata only. No table declares a foreign key.

## Routes

Every route declares `config.opt2.requires` or `config.opt2.public`; anything else fails start-up. `site-admin` is a member of the site's private-pool `Admin` group, and `system-user` any authenticated private-pool user.

### Legacy routes

Route keys are those of `platform/src/legacy-compat/route-key.ts`; the state is the one in `gateway/cutover/versions/v0001.json` to `v0003.json`.

| Route key | Legacy entry | Served by | Committed state |
|---|---|---|---|
| `admin:csettings.list` | Sites screen, with its order and deploy save | `web/` → `GET /v1/sites`, `POST /v1/sites/order` | `legacy` |
| `admin:csettings.editsite` | Edit Site | `web/` → `GET /v1/sites/{siteId}` | `legacy` |
| `admin:csettings.updatesite{action=update}` | Edit Site save | `web/` → `POST /v1/sites/{siteId}/update` | `legacy-write`, decision |
| `admin:csettings.loadcustomimage` | Image size dialog | `web/` → `GET /v1/sites/{siteId}/image-sizes/{sizeId}` | `legacy` |
| `admin:csettings.loadcustomimages` | Image size list, save and delete | `web/` → `GET /v1/sites/{siteId}/image-sizes`; `PUT`, `DELETE /v1/sites/{siteId}/image-sizes/{sizeId}` | `legacy` |
| `api:site.findone`, `rest:site.findone` | JSON API site read | `/_api/{json,ajax,rest}/v1/{siteid}/site` | `legacy` |
| `api:site.save`, `rest:site.save` | JSON API site save | `/_api/{json,ajax,rest}/v1/{siteid}/site` | `legacy-write`, decision |
| `sitemonitor:run` | `/_api/sitemonitor` | `/_api/sitemonitor` | `target` from `v0002` |

Why the site routes stay on legacy in this run:

- The site and image-size groups have carry write entries (`admin:csettings.list`, `admin:csettings.loadcustomimages`), but `tsettings`, `timagesizes` and `tsystemobjects` also have application-start writers in the inventory that are not on the prevented-writer list (`gateway/src/cutover/prevented-writers.ts`). `gateway/src/cutover/build-versions.ts` therefore keeps every `programs_sites` group `legacy`-authoritative, and the read entries follow their units. The other units have no carry write entry.
- The Edit Site save and JSON API `site.save` write `trazunasettings` on every save [core/mura/settings/settingsManager.cfc:271], a decision-list table, plus strategies-content and people extension definitions and `tfiles`. They stay `legacy-write` entries, run on legacy inside write windows.

The service implements these routes in full, so a later version can move them once those blockers are settled.

### `/v1` APIs

| Method and path | Requires | Does |
|---|---|---|
| `GET /v1/sites` | `s2` | Sites screen rows, sorted as legacy sorts them |
| `POST /v1/sites/order` | `s2` | Saves bind order and batch-deploy flags, then returns the rows |
| `GET /v1/sites/{siteId}` | `s2`, `site-admin` | One site with the data of every Edit Site tab |
| `GET /v1/sites/{siteId}/shell` | `s2`, `site-admin`, `system-user` | Site settings the admin layout reads |
| `POST /v1/sites/{siteId}/update` | `s2`, `site-admin` | Edit Site save |
| `GET /v1/sites/{siteId}/image-sizes` | `s2`, `site-admin` | The site's custom image sizes |
| `GET`, `PUT`, `DELETE /v1/sites/{siteId}/image-sizes/{sizeId}` | `s2`, `site-admin` | Read (defaulted new size for an unknown id), create or update, delete |
| `GET /v1/href-domains` | `service:gateway` | Registered domains and the site domain an absolute href is checked against |
| `GET /v1/user-sites` | `s2`, `site-admin`, `system-user` | Sites the token's user administers, and the site the given host binds to |

### Internal and managed routes

| Method and path | Transport | Requires |
|---|---|---|
| `POST /internal/v1/migration/apply`; `GET /internal/v1/migration/export`, `changes`, `position`; `GET`, `POST /internal/v1/migration/watermark`; `POST /internal/v1/migration/gate` | service | `platform.migration` |
| `GET`, `PUT /internal/v1/sitemonitor/state` | service | `platform.migration` |
| `POST /internal/v1/task-queues/{queue}/pause`, `resume`, `ensure` | service | `platform.migration`, `platform.operator` |
| `POST /internal/v1/events/programs-sites.programs-sites.site.changed.v1` | Pub/Sub push | `service:pubsub-invoker` |
| `POST /internal/v1/outbox/sweep` (`programs-sites-outbox-sweep`) | Cloud Tasks | `service:tasks-invoker` |
| `POST /internal/v1/jobs/sitemonitor` (`programs-sites-sitemonitor`) | Cloud Tasks | `service:tasks-invoker` |
| `GET /healthz` | service | public |

Queues this service creates tasks on (`platform/src/tasks/queues.ts`): `programs-sites-sitemonitor`, `programs-sites-outbox-sweep`, `content-scheduled-publish` and `content-feed-import`.

## Not built here

- **Withheld** (decision list, [`opt2/decision-list.md`](../../opt2/decision-list.md); they keep running on legacy): `admin:csettings.updatesite{action=add}`, `admin:csettings.updatesite{action=delete}`, `admin:csettings.sitecopyselect`, `admin:csettings.sitecopy`, `admin:cextend.*` and `admin:ctrash.*`; also `admin:csettings.updatesite{bundle}` and the plugin writes `deleteplugin`, `deployplugin` and `updateplugin`, which write `tplugins*` (decision list). Programs-sites holds the `tsettings` class-extension and trash rows for migration only. `admin:csettings.sitecopyresult` has no screen here and stays on legacy with the site copy it reports.
- **Legacy-served:** `csettings` createBundle, selectBundleOptions, deployBundle, exportHTML, editPlugin and updatePluginVersion.
- **Update branches that write outside this service.** Before any write, `src/legacy/update-branches.ts` detects the `settingsManager.update` branches below and answers the legacy-shaped 503, writing nothing:

  | Branch | Trigger | Writes |
  |---|---|---|
  | Razuna settings | Razuna fields with values [core/mura/settings/settingsManager.cfc:271] | `trazunasettings` (decision list) |
  | Placeholder image | `newPlaceholderImg` or `deletePlaceholderImg` [core/mura/settings/settingsManager.cfc:273-290] | `tfiles` and the file store (strategies-content) |
  | Display-pool copy | The site becomes its own display pool [core/mura/settings/settingsManager.cfc:413-426] | The legacy web-root filesystem |
  | Bundle deploy | `bundleFile` or `serverBundlePath` [core/mura/settings/settingsManager.cfc:636-680] | The legacy bundle engine |

  The legacy runtime effects of an update (plugin events, `clusterManager.reload`, `setSites`, `application.appInitialized`) are replaced by the `site.changed` event and the projector's registry refresh, not reproduced.

## Events

Produces `programs-sites.site.changed.v1`, kind `state`:

| Envelope field | Value |
|---|---|
| `aggregateType`, `aggregateId` | `site`, the legacy site id; `aggregateId` is the ordering key |
| `aggregateVersion` | The site's `row_version`, incremented in the same transaction |
| `tenantId` | The site's tenant |
| `payload` | `siteId`, `publicUserPoolId`, `privateUserPoolId`, `categoryPoolId`, `filePoolId`, `displayPoolId`, `contentPoolIds`, `domains` |

Every other service consumes it, and so does programs-sites itself, into `<schema>.tenant_registry`. Pool ids arrive as legacy site ids after Masa's defaults, and consumers store each with its tenant UUID. Migration applies emit it too, as a state event.

## How to run

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
```

`test/unit` and `test/contract` need nothing external. The isolation and event suites need PostgreSQL 16 through `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, plus `PUBSUB_EMULATOR_HOST` where they publish, and create a throwaway schema and roles per run through `@opt2/platform/testing`.

- **Local.** `harness/repro/up.sh` starts the service natively with `PORT=8113` and `PG_USER=programs_sites_app`. It reads `baseEnvSchema` of `@opt2/platform/service-kit` (details in [`platform/README.md`](../../platform/README.md#configuration)): `PORT`, `OPT2_SERVICE_NAME`, `OPT2_ENV`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `OPT2_DB_AUTH`, `CLOUD_SQL_INSTANCE`, `PUBSUB_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPT2_JWKS_URL`, `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, `OPT2_SERVICE_URLS`, `OPT2_STATE_DIR`, `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER`, `TZ`. The service calls identity (CSRF) and migration (authority, legacy steps), and creates tasks for itself and strategies-content, so those must resolve through `OPT2_SERVICE_URLS` or `OPT2_MIGRATION_URL`.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `programs_sites_app`, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).
