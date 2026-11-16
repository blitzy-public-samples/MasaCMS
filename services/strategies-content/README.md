# strategies-content

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The strategies/content service of OPT-2, migrated from Masa CMS 7.6.1.

Authors create, edit, approve, schedule and publish site content in the Site Manager. Editors manage categories, comments, collections (feeds), approval chains, change sets and forms, and export form responses. Visitors' files, comments and JSON API reads are served with legacy's bytes, headers and envelope. Some carried operations answer the legacy-shaped 503 instead, as [Routes](#routes) lists. The golden scenarios GS-CO-01 to GS-CO-19, GS-UI-01 to GS-UI-05, GS-PUB-04, GS-PUB-05, GS-BR-01 and GS-LS-03 (`harness/golden/catalogue.yaml`) define the parity checks for these routes. Their capture and replay have not run yet: `opt2/reports/parity.json` is `pending-run` and `harness/golden/sets/` holds no golden set, so parity with legacy is not yet established. `web/` renders the admin screens from this service's data.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml), the authority for every path, role and route key below. The service produces no event topic. Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md).

## Masa features replaced

| Masa feature | Masa source | Here |
|---|---|---|
| Site Manager tree, content edit, drafts, version history and audit | `carch.list`, `edit`, `update`, `draft`, `hist`, `audit`, `loadsitemanager` (`admin/core/controllers/carch.cfc`); `core/mura/content/contentManager.cfc` | `/v1/sites/{siteid}/content/**`; `/v1/raw/carch/*` for the fragment, JSON and download actions |
| Approvals and approval chains | `carch.approvalaction` and the status modal (`admin/core/views/carch/approvalaction.cfm`, `statusmodal.cfm`); `cchain` (`admin/core/controllers/cchain.cfc`); `core/mura/content/approval/**` | `/v1/sites/{siteid}/approval-chains/**`; `/v1/raw/carch/approvalaction`, `/v1/raw/carch/statusmodal` |
| Change sets and scheduled publish | `cchangesets` (`admin/core/controllers/cchangesets.cfc`); `changesetManager.publishBySchedule` [core/mura/content/changeset/changesetManager.cfc:327-343] | `/v1/sites/{siteid}/changesets/**`; `POST /internal/v1/jobs/publish-scheduled-changesets` |
| Categories | `ccategory` (`admin/core/controllers/ccategory.cfc`); `core/mura/category/**` | `/v1/sites/{siteid}/categories/**` |
| Comments | `ccomments` (`admin/core/controllers/ccomments.cfc`); remote `get`, `flag`, `getContentStats` [core/modules/v1/comments/ajax/commentsProxy.cfc:88-112] | `/v1/sites/{siteid}/comments/**`; `/core/modules/v1/comments/ajax/commentsProxy.cfc` |
| Collections (feeds), RSS and remote auto-import | `cfeed` (`admin/core/controllers/cfeed.cfc`); `core/mura/client/api/feed/v1/feedApiUtility.cfc`; `feedManager.doAutoImport` [core/mura/content/feed/feedManager.cfc:371-385] | `/v1/sites/{siteid}/feeds/**`; `/_api/feed/v1`, `/tasks/feed`; `POST /internal/v1/jobs/feed-auto-import` |
| Files and renditions | `/_api/render` [core/mura/content/contentServer.cfc:655-668]; `core/mura/content/file/fileManager.cfc`, `fileDAO.cfc` | `/_api/render/{size}`, `/tasks/render/{size}` byte streams; `GET /v1/sites/{siteid}/files/{fileid}/download-url` |
| Forms and responses | `cform` (`admin/core/controllers/cform.cfc`); `carch.datamanager`, `carch.downloaddata`; `core/mura/formBuilder/**` | `/v1/sites/{siteid}/forms/**`; `/v1/raw/cform/*`, `/v1/raw/carch/downloaddata` |
| Search | `carch.search`; `cnav.searchsitedata` (`admin/core/controllers/cnav.cfc`) | `GET /v1/sites/{siteid}/content`; `/v1/raw/cnav/searchsitedata` |
| Ratings | `core/modules/v1/rater/ajax/saveRate.cfm` | `POST /core/modules/v1/rater/ajax/saveRate.cfm` |
| Variations | `carch.variationtargeting`; `/_api/resource/variation` [core/mura/content/contentServer.cfc:649-650]; entity `variationTargeting`, registered at start-up only while configBean `variations` is on [core/mura/client/api/json/v1/jsonApiUtility.cfc:103-105], otherwise for a site by a `findProperties` of it [core/mura/client/api/json/v1/jsonApiUtility.cfc:124-129,1559] | `/v1/sites/{siteid}/variation-targeting`; `/_api/resource/variation`; `MURA_VARIATIONS` |
| JSON API content entities and methods | `registerEntity` [core/mura/client/api/json/v1/jsonApiUtility.cfc:69-105]; `publicMethods` [core/mura/client/api/json/v1/jsonApiUtility.cfc:34] | `/_api/{json,ajax,rest}/v1`, with `/{siteid}` and `/{siteid}/{path}` |
| Content-node permission verdicts | `permission.getPerm` [core/mura/permission.cfc:220-266] | `content.permission_projection` and `content.membership_projection`, fed by identity |
| Admin header prompt counts | Drafts, submissions, approvals, expiring content and change-set approvals [admin/common/layouts/includes/header.cfm:176-246] | `GET /v1/sites/{siteid}/header-prompts` |

## Owned data

Schema `content`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with three roles:

| Role | Use |
|---|---|
| `content_owner` | `NOLOGIN NOSUPERUSER NOBYPASSRLS`; owns the schema and every object, and FORCE RLS applies to it |
| `content_app` | Runtime DML only; the service's `PG_USER` |
| `content_migrator` | Applies `db/migrations/*.sql` after `SET ROLE content_owner` |

Legacy tables, as split in [`opt2/table-ownership.json`](../../opt2/table-ownership.json) (rule step 1); each target is `content.<table>`:

| Legacy table | Target table |
|---|---|
| `tcontent`, `tcontentobjects`, `tcontentrelated`, `tcontenttags`, `tcontentassignments` | `content`, `content_object`, `content_related`, `content_tag`, `content_assignment` |
| `tcontentcategories`, `tcontentcategoryassign` | `category`, `content_category_assign` |
| `tcontentstats`, `tcontentratings` | `content_stats`, `content_rating` |
| `tcontentcomments`, `tcontentcommentcommenters` | `comment`, `commenter` |
| `tcontentfeeds`, `tcontentfeeditems`, `tcontentfeedadvancedparams` | `feed`, `feed_item`, `feed_advanced_param` |
| `tfiles`, `tcontentfilemetadata`, `tcontentfilenamearchive`, `tcontentsourcemaps` | `file`, `file_metadata`, `filename_archive`, `source_map` |
| `tcontentremotepointer`, `tcontentvariationtargeting` | `content_remote_pointer`, `variation_targeting` |
| `tcontentdisplaytitleapprovals`, `tcontentpublicsubmissionapprovals` | `display_title_approval`, `public_submission_approval`; no key, so stored as a multiset with `legacy_row_hash` and `occurrence` |
| `tformresponsepackets`, `tformresponsequestions` | `form_response_packet`, `form_response_question` |
| `tapprovalchains`, `tapprovalmemberships`, `tapprovalassignments`, `tapprovalrequests`, `tapprovalactions` | `approval_chain`, `approval_membership`, `approval_assignment`, `approval_request`, `approval_action` |
| `tchangesets`, `tchangesetrollback`, `tchangesetcategoryassign`, `tchangesettagassign` | `changeset`, `changeset_rollback`, `changeset_category_assign`, `changeset_tag_assign` |
| `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets`, `tclassextenddata` (split) | `extend_subtype`, `extend_set`, `extend_attribute`, `extend_rc_set`, `extend_data`: subtypes whose `baseTable` is `tcontent` or another table above, with their sets, attributes, related-content sets and values |
| `ttrash` (split) | `trash`: rows whose class-map owner is strategies-content: `objectClass` `content`, `feed`, `category` or `changeset`, and `extendObject` rows whose subtype's `baseTable` this service owns |

New tables:

| Table | Holds |
|---|---|
| `content.file_object` | Manifest of `content-files` objects: key `<tenantId>/<fileId><variant>.<ext>`, size, SHA-256, content type, orphan flag |
| `content.staged_object` | Ledger of objects written before their rows commit (migration transfers and uploads) |
| `content.permission_projection` | Projection of `identity.permission.changed.v1`: each group's permission rows per node |
| `content.membership_projection` | Projection of `identity.membership.changed.v1`: each user's groups |
| `content.group_projection` | Projection of `identity.group.changed.v1`: group names and pools |

Also owned: the platform tables `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `outbox`, `inbox`, `consumer_aggregate_version`, `scheduled_task_queue` and `scheduled_task_queue_state`.

- Every tenant-owned table has `tenant_id uuid NOT NULL` and row-level security enabled and forced, with the `tenant_isolation` policy on `app.tenant_id`. `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` hold tenant metadata only. No table declares a foreign key, as in Masa.
- **Pools.** Categories of a site's `categoryPoolID` and files of its `filePoolID` are umbrella-tenant rows, read in the pool tenant `tenant_registry` gives for the token's tenant. A `contentPoolID` read runs one transaction per registered content-pool tenant and merges the results.
- **Files.** Bucket `content-files`, written only by this service; pooled files sit under the umbrella tenant's prefix. `/_api/render/*` keeps legacy's 200 byte stream from storage. New download paths return 15-minute signed URLs; the local adapter's URLs are `/opt2/files/content-files/…`, served by `getLocalContentFile`.

## Routes

Every route declares `config.opt2.requires` or `config.opt2.public`; anything else fails start-up. Token roles: `s2`; `site-admin`, a member of the site's private-pool `Admin` group; `m:<nnn>`, a core module grant: `m:000` Site Manager, `m:003` components, `m:004` forms, `m:010` categories, `m:011` collections, `m:014` change sets, `m:015` comments, `m:099` variations; `system-user`. Public legacy routes apply Masa's own checks inside the handler.

### Legacy routes

Route keys are those of `platform/src/legacy-compat/route-key.ts`; the state is the one in `gateway/cutover/versions/v0001.json` to `v0003.json`.

| Route key | Legacy entry | Served by | Committed state |
|---|---|---|---|
| `admin:carch.*`, except the keys under [Not built here](#not-built-here) | Site Manager, edit, history, status modal, approvals, image details, data manager, search | `web/` → `/v1/sites/{siteid}/content/**`, `/forms/**`, `/files/**`, `/variation-targeting`, `/v1/raw/carch/*` | `legacy` |
| `admin:cchangesets.*`, except `publish` | Change sets | `web/` → `/v1/sites/{siteid}/changesets/**`, `/v1/raw/cchangesets/loadtagarray` | `legacy` |
| `admin:ccomments.*` | Comment moderation | `web/` → `/v1/sites/{siteid}/comments/**`, `/v1/raw/ccomments/*` | `legacy` |
| `admin:ccategory.*` | Categories | `web/` → `/v1/sites/{siteid}/categories/**` | `legacy` |
| `admin:cfeed.*`, except `import2` | Collections and the feed import preview | `web/` → `/v1/sites/{siteid}/feeds/**`, `/v1/raw/cfeed/*` | `legacy` |
| `admin:cchain.*` | Approval chains and pending approvals | `web/` → `/v1/sites/{siteid}/approval-chains/**` | `legacy` |
| `admin:cform.*` | Form builder dialogs, export and import | `web/` → `/v1/sites/{siteid}/forms/import`, `/v1/raw/cform/*` | `legacy` |
| `admin:cnav.searchsitedata` | Site search data | `web/` → `/v1/raw/cnav/searchsitedata` | `legacy` |
| `api:` and `rest:` `<entity>.delete`, `findall`, `findmany`, `findnew`, `findone`, `findpermissions`, `findproperties`, `findquery`, `save`, `validate` for `content`, `contentnav`, `comment`, `category`, `contentcategoryassign`, `file`, `filemetadata`, `changeset`, `changesetcategoryassignment`, `feed`, `stats`, `variationtargeting` | JSON API entities | `/_api/{json,ajax,rest}/v1*`; `validate` answers the legacy-shaped 503 (`jsonapi-<entity>-validate-not-ported`) | `legacy`, except `variationtargeting.save` and `variationtargeting.delete`: `target` from `v0002` |
| `api:` and `rest:` `comment.~delete`, `~flag`, `~markasspam`, `~undelete`, `~unmarkasspam` | Comment bean methods called through the API | `/_api/{json,ajax,rest}/v1*`, which answers the legacy-shaped 503 (`jsonapi-comment-<method>-not-ported`) | `legacy` |
| `api:` and `rest:` `findcalendaritems`, `findrelatedcontent`, `geturlforimage`, `findversionhistory`, `findcrumbarray` | JSON API content methods | `/_api/{json,ajax,rest}/v1*` | `legacy` |
| `feed:v1` | RSS feeds | `/_api/feed/v1*`, `/tasks/feed*`; a stored feed that reaches rendering answers the legacy-shaped 503 (`feed-site-settings`) | `legacy` |
| `render:file`, `render:small`, `render:medium` | File and rendition streams | `/_api/render/{size}`, `/tasks/render/{size}` | `legacy` |
| `variation:js` | `variation.js.cfm`, while `MURA_VARIATIONS` is on | `/_api/resource/variation*`: legacy's empty page while the url carries no `siteid` or `MURA_VARIATIONS` is off, else the legacy-shaped 503 (`variation-script-runtime`); a `siteid` naming another site than the token's is refused | `legacy` |
| `cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=get`, `flag`, `getcontentstats` | Comments proxy data methods | `/core/modules/v1/comments/ajax/commentsProxy.cfc` | `legacy` |
| `cfm:/core/modules/v1/rater/ajax/saverate.cfm` | Rating save | `POST /core/modules/v1/rater/ajax/saveRate.cfm` | `legacy` |

Why the content routes stay on legacy in this run:

- **Start-up writers.** `gateway/cutover/groups.json` puts 30 of the 39 content units into one group, `grp:content.approval_action`, because carried writes such as `carch.update` reach them together. Its units have application-start writers that `gateway/src/cutover/prevented-writers.ts` does not close: Masa's start-up bundle deploy (`getToWork*` in `core/mura/publisher.cfc`), the `core/mura/dbUpdates` scripts and the materialized-path rebuilds of `contentUtility.cfc` and `categoryUtility.cfc`. `gateway/src/cutover/build-versions.ts` therefore keeps the group `legacy`-authoritative, and every read entry, whose units include it, follows. Only `grp:content.variation_targeting` moves.
- **Halted cases** ([`opt2/exceptions-list.md`](../../opt2/exceptions-list.md)). `EX-CARCH-SEARCH-SITE`, `EX-CARCH-UPLOAD-PAGELIMIT` and `EX-CARCH-IMAGE-SIZES` keep `admin:carch.search`, `admin:carch.multifileupload` and `admin:carch.imagedetails` on legacy in every version: each needs site settings no programs-sites contract gives this service, so it answers the legacy-shaped 503 naming the halt reason. Open `preserve` entries: `EX-SHELL-THEMEPATH`, `EX-CCHAIN-PENDING-PREVIEW`, `EX-CARCH-VERSION-PREVIEW`, `EX-UNSTORABLE-TEXT-VARIATIONTARGETING`, `EX-VARIATIONTARGETING-REGISTRATION`, `EX-JSONAPI-IMAGE-SIZES-CACHE`.

Every operation of the contract is registered. These carried operations answer the legacy-shaped 503 instead of running, because they need data or CFML runtime this service does not hold:

- JSON API `validate` of the twelve content entities, and the comment bean methods `~delete`, `~undelete`, `~flag`, `~markasspam` and `~unmarkasspam`: the bean validator and the comment bean code are not ported (`src/routes/jsonapi.ts`).
- Rendering a stored feed on `/_api/feed/v1` and `/tasks/feed`: `src/routes/index.ts` gives the feed routes no source of the site settings a feed prints. Credentials sent for a restricted feed answer the same way, as they are identity data. Requests that stop before rendering, such as an unknown feed or a refused reader, are still answered here.
- The variation script `/_api/resource/variation` for a url with a `siteid` while `MURA_VARIATIONS` is on, which only the CFML runtime generates.
- `carch.loadnotify` and `carch.loadexpirenotify`, whose recipients are people and identity data, and `carch.loadclassconfigurator`, which reads legacy CFML.
- `cfeed.edit`, `cfeed.loadsite` and `cfeed.siteparents`, whose site values and labels have no source here.
- The save of a form import (`cform.importform`) that passes legacy's checks, which needs site settings.
- The halted cases above.

Other carried operations answer the legacy-shaped 503 only on branches that need such data, such as a JSON API content read with `render`, a sized rendition never stored, and lists that print preview URLs.

### `/v1` APIs

`web/` calls these through the gateway with the session's user token (`web/src/screens/{carch,cchangesets,ccomments,ccategory,cfeed,cform,cchain,cnav}/`). `carch.edittext` is a static view `web/` renders without service data.

| Paths | Requires | Does |
|---|---|---|
| `GET /v1/sites/{siteid}/content/tree`, `/content`, `/content/drafts`, `/content/images`, `/content/{contentid}`, `/content/{contentid}/history`, `/content/{contentid}/versions/{contenthistid}/audit`, `/content/{contentid}/multi-file-upload`, `/content/versions/{contenthistid}/summary` | `s2`, `site-admin`, `m:000` | Site Manager tree, search, drafts, media selector, edit model, history, audit, upload form, version summary |
| `POST /v1/sites/{siteid}/content/versions/{contenthistid}/object-params` | `s2`, `site-admin`, `m:000` | `carch.updateobjectparams` |
| `GET /v1/sites/{siteid}/content/{contentid}/crumbs` | `s2`, `site-admin` | Node crumbs for identity's permission screens |
| `GET /v1/sites/{siteid}/header-prompts` | `s2`, `site-admin`, `system-user` | Admin header badge counts |
| `GET /v1/sites/{siteid}/forms/{contentid}/responses`, `POST …/responses/delete` | `s2`, `site-admin`, `m:000` | Data manager list and delete |
| `POST /v1/sites/{siteid}/forms/import` | `s2`, `site-admin`, `m:004` | `cform.importform` |
| `GET /v1/sites/{siteid}/files/image-details`, `GET /v1/sites/{siteid}/files/{fileid}/download-url` | `s2`, `site-admin`, `m:000` | Image details model; 900 s signed download URL |
| `GET`, `POST /v1/sites/{siteid}/changesets`; `GET /v1/sites/{siteid}/changesets/{changesetid}`; `POST …/delete`, `…/rollback`, `…/items/{contenthistid}/remove`; `GET …/assignments` | `s2`, `site-admin`, `m:014` | Change set list, save, edit, delete, rollback, item removal, assignments |
| `GET /v1/sites/{siteid}/comments`; `POST …/comments/bulk`, `…/purge-deleted`, `…/{commentid}`, `…/{commentid}/approve`, `unapprove`, `delete`, `spam` | `s2`, `site-admin`, `m:015` | Comment moderation |
| `GET`, `POST /v1/sites/{siteid}/categories`; `GET …/categories/{categoryid}` | `s2`, `site-admin`, `m:010` | Category list, save, edit |
| `GET /v1/sites/{siteid}/feeds`, `…/feeds/{feedid}`, `…/feeds/{feedid}/import` | `s2`, `site-admin`, `m:011` | Collection list, edit, import preview |
| `GET /v1/sites/{siteid}/feeds/display-fields` | `s2`, `site-admin`, `m:000` | `carch.selectfields` |
| `GET`, `POST /v1/sites/{siteid}/approval-chains`; `GET …/{chainid}`, `…/{chainid}/pending`; `POST …/{chainid}/delete` | `s2`, `site-admin` | Approval chain list, save, edit, pending approvals, delete |
| `GET`, `POST /v1/sites/{siteid}/variation-targeting` | `s2`, `site-admin`, `m:000` | `carch.variationtargeting` |
| `GET`, `POST /v1/raw/<circuit>/<action>` | as the circuit above; `cnav/searchsitedata` public | Legacy fragment, JSON and download responses that `web/` relays unchanged: 34 `carch` actions (`loadsitemanager`, `sitemanagertab`, `statusmodal`, `approvalaction`, `loaddiff`, `update`, `downloaddata`, …), `cchangesets/loadtagarray`, `ccomments/{ajax,loadcomments,loadcommentspage}`, `cfeed/{loadsite,siteparents,update}`, `cform/{export,getdataset,getdialog,getfield,getfieldtemplate,getfieldtype,getform}`, `cnav/searchsitedata` |

### Internal and managed routes

| Method and path | Transport | Requires | Does |
|---|---|---|---|
| `POST /internal/v1/files:lookup` | service | `service:people`, `service:identity` | `fileEXT` of stored files, for user photos and group member lists |
| `POST /internal/v1/content:links` | service | `service:people` | Legacy `createHref` links of content ids, for people's favorites |
| `POST /internal/v1/migration/apply`; `GET /internal/v1/migration/export`, `changes`, `position`; `GET`, `POST /internal/v1/migration/watermark`; `POST /internal/v1/migration/gate` | service | `platform.migration` | Backfill and feed batches, canonical export, changelog, write position, watermarks, unit gates |
| `POST`, `GET`, `DELETE /internal/v1/migration/objects` | service | `platform.migration` | Store a legacy file-store object once per SHA-256, read it for reverse projection, delete it |
| `POST /internal/v1/events/strategies-content.<topic>` | Pub/Sub push | `service:pubsub-invoker` | Event deliveries ([Events and jobs](#events-and-jobs)) |
| `POST /internal/v1/jobs/publish-scheduled-changesets`, `POST /internal/v1/jobs/feed-auto-import?siteid=` | Cloud Tasks | `service:tasks-invoker` | Site-monitor steps ([Events and jobs](#events-and-jobs)) |
| `POST /internal/v1/task-queues/{queue}/pause`, `resume`, `ensure` | service | `platform.migration`, `platform.operator` | Queue control for the queues this service creates tasks on (`content-scheduled-publish`) |
| `GET /opt2/files/content-files/{tenantId}/{objectName}` | service | public; the HMAC signature is the credential | Local adapter's signed file URLs; 404 in the cloud |
| `GET /healthz` | service | public | Liveness |

## Not built here

- **Halted** (`EX-FILE-RENDITION`): image uploads and the image tools. Legacy writes their renditions with ColdFusion's image engine, whose bytes no other encoder reproduces. The image saves `admin:carch.update{upload=image}` (the route key of `EX-FILE-RENDITION`, also withheld under `opt2/decision-list.json#tcontenteventreminders`), `api:file.save{upload=image}` and `rest:file.save{upload=image}`, and the tools `admin:carch.cropimage`, `admin:carch.rotateimage` and `admin:carch.flipimage`, are `legacy-write` entries in every version: they run on legacy inside write windows that import their originals and renditions into `content-files`. The upload page `admin:carch.multifileupload{upload=image}` is a `read` entry with no group in every version and stays on legacy; its uploads post to `carch.update`. A sized rendition legacy would generate on demand and never stored answers the legacy-shaped 503 on `/_api/render`. Non-image uploads are carried.
- **Withheld** (decision list, [`opt2/decision-list.md`](../../opt2/decision-list.md); they keep running on legacy as `legacy-write` entries): `admin:carch.update{approved=1}`, `admin:carch.update{notify}`, `admin:carch.updateobjectparams{approved=1}`, `admin:cchangesets.publish` and `admin:cfeed.import2`, which write `tcontenteventreminders`; `admin:carch.importcontent` and `admin:carch.importcomponent`, which write decision-list tables; `admin:carch.copy` and `admin:carch.variationtargeting{notify}`, whose writes span identity.
- **Legacy-served:** `admin:carch.export`, `exportcontent`, `exportcomponent`, `import` (bundle engine); `admin:carch.emailtest` (communications); `admin:carch.displayobjectmodal`, `frontendconfigurator`, `loadrepomanager`; `admin:cfilemanager.default`, `api:filebrowser.~*`, `rest:filebrowser.~*` and `/_api/asset/` (`asset:upload`, `asset:render`) (legacy web-root filesystem); `admin:razuna.*`, `admin:scaffold.*`, `admin:cplugins.*`; `api:processasyncobject`; `api:swagger`; `declareEntity`, `undeclareEntity`, `checkSchema`; public page render, `doaction=saveRate` (`page:saverate`) and `saveform`; `commentsProxy.renderCommentsPage`.
- **Retired:** `api:submitform`, a public method name with no function behind it in `jsonApiUtility.cfc`.
- **Decision-list tables** (no target table, mapping or route): `tremotepointer`, `trazunasettings`, `fb_*`, `tentity`, `tcontenteventreminders`.

## Legacy behaviour kept on purpose

Reproduced as Masa shows it (see [`opt2/reports/pre-existing-defects.md`](../../opt2/reports/pre-existing-defects.md)):

- **SEC-01.** `carch.approvalaction` skips its CSRF check, `true or rc.$.validateCSRFTokens(…)` [admin/core/views/carch/approvalaction.cfm:1]; `/v1/raw/carch/approvalaction` declares `x-opt2-csrf` `bypassed` and consumes no token.
- **SEC-02.** `cChangesets.publish` checks no CSRF token [admin/core/controllers/cchangesets.cfc:144-147]; the action is withheld, so legacy keeps serving it.
- Routes whose legacy action validates no token (`x-opt2-csrf` `none`: comment moderation, object params, variation targeting save, file metadata) consume none.

## Events and jobs

Consumed, each a `state` event, through push subscription `strategies-content.<topic>`:

| Topic | Fills |
|---|---|
| `programs-sites.site.changed.v1` | `content.tenant_registry`: each site's tenant and pools |
| `identity.group.changed.v1` | `content.group_projection` |
| `identity.permission.changed.v1` | `content.permission_projection` |
| `identity.membership.changed.v1` | `content.membership_projection` |

A delivery failing envelope, schema or tenant checks is published to `<subscription>.dlq`; that publisher is the service's only Pub/Sub output. It produces no topic, so it has no outbox sweep.

Site-monitor steps, called by the programs-sites orchestrator (`services/programs-sites/src/jobs/sitemonitor.ts`) through Cloud Tasks:

| Route | Queue | Mirrors |
|---|---|---|
| `POST /internal/v1/jobs/publish-scheduled-changesets` | `content-scheduled-publish` | `changesetManager.publishBySchedule`: every unpublished change set whose publish date has passed, oldest first |
| `POST /internal/v1/jobs/feed-auto-import?siteid=` | `content-feed-import` | `feedManager.doAutoImport`: every remote feed of the site marked for automatic import |

The orchestrator sends a step here only once every unit it writes is `target`-authoritative. Both steps can write `tcontenteventreminders`, which never moves, so in this run they run on legacy ([`services/programs-sites/README.md`](../programs-sites/README.md#site-monitor)).

## How to run

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
PORT=8114 npm start     # normally started by harness/repro/up.sh
```

`test/contract` and `test/security` need nothing external. Suites over the database read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, create a throwaway copy of schema `content` through `@opt2/platform/testing`, and skip when PostgreSQL is unreachable.

- **Environment.** `contentEnvSchema` in `src/app.ts`: `baseEnvSchema` of `@opt2/platform/service-kit` ([`platform/README.md`](../../platform/README.md#configuration)): `PORT`, `OPT2_SERVICE_NAME=strategies-content`, `OPT2_ENV`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `OPT2_DB_AUTH`, `CLOUD_SQL_INSTANCE`, `PUBSUB_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPT2_JWKS_URL`, `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, `OPT2_SERVICE_URLS`, `OPT2_STATE_DIR`, `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER`, `LOG_LEVEL`, `TZ`; plus `MURA_VARIATIONS`, a ColdFusion boolean (`true`, `yes`, `1`, `false`, `no`, `0`; false when unset) that registers the `variationTargeting` entity at start-up (its finders and `read` permission; save, delete and properties answer either way) and turns on `/_api/resource/variation`, as configBean `variations` does. While it is off, a `findProperties` of `variationTargeting` registers the entity for its site until the service instance stops, as legacy's does on the site's API instance until the site beans are rebuilt (`EX-VARIATIONTARGETING-REGISTRATION`). `OPT2_SERVICE_URLS` must name `identity` (CSRF consume, session and admin state), `programs-sites` (the site custom image sizes of JSON API content `images`, `GET /internal/v1/sites/{siteId}/image-sizes`) and `strategies-content` (the target of its own tasks; in the cloud also its push and Cloud Tasks audience).

**Masa settings.** The JSON API (`jsonApiLegacySettings` in `src/routes/jsonapi.ts`) and people's content-link lookup (`contentLinkUrlSettings` in `src/routes/internal-content-links.ts`) also read these Masa variables straight from the process environment, which Masa start-up applies over its settings template. Set each to the legacy server's value, or links, endpoint URLs and CORS answers differ from legacy's. A `${…}` or `{{…}}` value, an expression Masa evaluates as CFML, reads as unset, except that the JSON API takes it as written in `MURA_APPRELOADKEY` and the content-link lookup reads it in `MURA_SITEIDINURLS`, `MURA_INDEXFILEINURLS` and `MURA_HASHURLS` as a non-boolean, so they take configBean's defaults: true, true and false. A malformed value stops start-up with an `EnvValidationError` naming the variable. A CFML boolean is `true`, `false`, `yes`, `no` or a number.

| Variable | Accepted | Unset | Blank | Drives |
|---|---|---|---|---|
| `MURA_ADMINSSL` | Blank or a CFML boolean | false | false | `https:` for the JSON API endpoint URL when true, else the request's scheme |
| `MURA_PORT` | Blank or a port from 1 to 65535 | The request host's port | No port | The port in the JSON API endpoint and site URLs; `80` and `443` print none |
| `MURA_CONTEXT` | Blank or a path starting with `/` or `\`, without whitespace, `?` or `#` | No context | No context | The context path in the JSON API endpoint, site URLs, route keys and people's content links; one trailing `/` or `\` is dropped |
| `MURA_ADMINDOMAIN` | Blank or a comma list of host names, without ports | None | None | Adds the current admin host to the origins the JSON API allows for CORS |
| `MURA_APPRELOADKEY` | Any value without whitespace or control characters | `appreload` | No reload parameter | The url parameter the JSON API drops before resolving a call, as Masa drops its reload key |
| `MURA_SITEIDINURLS` | A CFML boolean; any other value reads as true | false | true | The site id in content URLs |
| `MURA_INDEXFILEINURLS` | A CFML boolean; any other value reads as true | true | true | `index.cfm` in content URLs |
| `MURA_HASHURLS` | A CFML boolean; any other value reads as false | false | false | Hash (`/#`) content URLs and query strings |
| `MURA_LEGACYINDEXFILELOCATION` | A CFML boolean | false | Stops start-up | Puts content URLs that carry both the site id and `index.cfm` under the site asset path: `/sites/<siteid>/index.cfm/…` |
| `MURA_SITEDIR` | Any value | `sites` | No prefix when empty, else `/<value>` | The site asset path `/<value>` in file asset URLs and in the URLs `MURA_LEGACYINDEXFILELOCATION` shapes |

- **Local.** `harness/repro/up.sh` starts the service natively with `PORT=8114` and `PG_USER=content_app`, after `opt2-db bootstrap --target local` has created the schema and roles. Local storage lives under `${OPT2_STATE_DIR}/storage/content-files/`.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `content_app`, bucket `content-files`, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).
