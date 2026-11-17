# strategies-content

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The strategies/content service of OPT-2, migrated from Masa CMS 7.6.1.

Authors create, edit, approve, schedule and publish site content in the Site Manager. Editors manage categories, comments, collections (feeds), approval chains, change sets and forms, and export form responses. Visitors' files, comments and JSON API reads are served with legacy's bytes, headers and envelope. Some carried operations answer the legacy-shaped 503 instead, as [Routes](#routes) lists. The golden scenarios GS-CO-01 to GS-CO-19, GS-UI-01 to GS-UI-05, GS-PUB-04, GS-PUB-05, GS-BR-01 and GS-LS-03 (`harness/golden/catalogue.yaml`) define the parity checks for these routes. Their capture and replay have not run yet: `opt2/reports/parity.json` is `pending-run` and `harness/golden/sets/` holds no golden set, so parity with legacy is not yet established. `web/` renders the admin screens from this service's data.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml), the authority for every path, role and route key below. The service produces no event topic. Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md).

## Masa features replaced

| Masa feature | Masa source | Here |
|---|---|---|
| Site Manager tree, content edit, drafts, version history and audit | `carch.list`, `edit`, `update`, `draft`, `hist`, `audit`, `loadsitemanager` (`admin/core/controllers/carch.cfc`); `core/mura/content/contentManager.cfc` | `/v1/sites/{siteid}/content/**`; `/v1/raw/carch/*` for the fragment, JSON and download actions; the site's `$.siteConfig` flags (scaffolding, dataCollection, hasLockableNodes, hasChangesets, hasComments) from programs-sites' `POST /internal/v1/sites/config-flags:lookup`, whose unavailability answers the legacy-shaped 503 |
| Approvals and approval chains | `carch.approvalaction` and the status modal (`admin/core/views/carch/approvalaction.cfm`, `statusmodal.cfm`); `cchain` (`admin/core/controllers/cchain.cfc`); `core/mura/content/approval/**` | `/v1/sites/{siteid}/approval-chains/**`; `/v1/raw/carch/approvalaction`, `/v1/raw/carch/statusmodal` |
| Change sets and scheduled publish | `cchangesets` (`admin/core/controllers/cchangesets.cfc`); `changesetManager.publishBySchedule` [core/mura/content/changeset/changesetManager.cfc:327-343] | `/v1/sites/{siteid}/changesets/**`; `POST /internal/v1/jobs/publish-scheduled-changesets` |
| Categories | `ccategory` (`admin/core/controllers/ccategory.cfc`); `core/mura/category/**` | `/v1/sites/{siteid}/categories/**` |
| Comments | `ccomments` (`admin/core/controllers/ccomments.cfc`); remote `get`, `flag`, `getContentStats` [core/modules/v1/comments/ajax/commentsProxy.cfc:88-112] | `/v1/sites/{siteid}/comments/**`; `/core/modules/v1/comments/ajax/commentsProxy.cfc` |
| Collections (feeds), RSS and remote auto-import | `cfeed` (`admin/core/controllers/cfeed.cfc`); `core/mura/client/api/feed/v1/feedApiUtility.cfc`; `feedManager.doAutoImport` [core/mura/content/feed/feedManager.cfc:371-385] | `/v1/sites/{siteid}/feeds/**`; `/_api/feed/v1`, `/tasks/feed`, rendered with the site contact, locale and URL settings of programs-sites' `POST /internal/v1/sites/feed-settings:lookup`; `POST /internal/v1/jobs/feed-auto-import` |
| Files and renditions | `/_api/render` [core/mura/content/contentServer.cfc:655-668]; `core/mura/content/file/fileManager.cfc`, `fileDAO.cfc` | `/_api/render/{size}`, `/tasks/render/{size}` byte streams; `GET /v1/sites/{siteid}/files/{fileid}/download-url` |
| Forms and responses | `cform` (`admin/core/controllers/cform.cfc`); `carch.datamanager`, `carch.downloaddata`; `core/mura/formBuilder/**` | `/v1/sites/{siteid}/forms/**`; `/v1/raw/cform/*`, `/v1/raw/carch/downloaddata` |
| Search | `carch.search`; `cnav.searchsitedata` (`admin/core/controllers/cnav.cfc`) | `GET /v1/sites/{siteid}/content`; `/v1/raw/cnav/searchsitedata` |
| Ratings | `core/modules/v1/rater/ajax/saveRate.cfm`; `raterManager.saveRate`, `getAvgRating` [core/mura/content/rater/raterManager.cfc:114-189] | `GET`, `POST /core/modules/v1/rater/ajax/saveRate.cfm` |
| Variations | `carch.variationtargeting`; `/_api/resource/variation` [core/mura/content/contentServer.cfc:649-650]; entity `variationTargeting`, registered at start-up only while configBean `variations` is on [core/mura/client/api/json/v1/jsonApiUtility.cfc:103-105], otherwise for a site by a `findProperties` of it [core/mura/client/api/json/v1/jsonApiUtility.cfc:124-129,1559] | `/v1/sites/{siteid}/variation-targeting`; `/_api/resource/variation`; `MURA_VARIATIONS` |
| JSON API content entities and methods | `registerEntity` [core/mura/client/api/json/v1/jsonApiUtility.cfc:69-105]; `publicMethods` [core/mura/client/api/json/v1/jsonApiUtility.cfc:34] | `/_api/{json,ajax,rest}/v1`, with `/{siteid}` and `/{siteid}/{path}`, each also behind `/index.cfm`, in any letter case |
| Content-node permission verdicts | `permission.getPerm` [core/mura/permission.cfc:220-266] | `content.permission_projection` and `content.membership_projection`, fed by identity |
| Admin header prompt counts | Drafts, submissions, approvals, expiring content and change-set approvals [admin/common/layouts/includes/header.cfm:176-246] | `GET /v1/sites/{siteid}/header-prompts` |
| Edit Profile and Edit User interest groups | `categoryManager.getPrivateInterestGroups` [core/mura/category/categoryGateway.cfc:266-283], read per level by `admin/core/views/ceditprofile/dsp_categories_nest.cfm` and `admin/core/views/cusers/dsp_categories_nest.cfm` | `GET /v1/sites/{siteid}/private-interest-groups` |

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
| `admin:carch.*`, except the halted keys of the next row and the keys under [Not built here](#not-built-here) | Site Manager tree and tabs, drafts, `editlive`, `edittext`, history, audit, lock check, related content, data manager, scaffold, field and media selectors, file lock and unlock, node unlock, copy info, and 27 relayed fragment, JSON and download actions, among them the status modal and approvals | `web/` → `/v1/sites/{siteid}/content/**`, `/forms/**`, `/feeds/display-fields`, `/v1/raw/carch/*` | `approvalaction`, `datamanager`, `list`, `lockfile`, `unlockfile` and `unlocknode` `target` from `v0002`, `legacy` in `v0001`; the others `legacy` |
| `admin:carch.edit`, `imagedetails`, `loadsiteflat`, `multifileupload`, `search` | Content edit form, image details, Site Manager flat view, multi-file upload page, search | Legacy; `web/` registers no screen for them | `legacy` in every version, halted: `edit` (`EX-CARCH-EDIT-FORM`) and `imagedetails` (`EX-CARCH-IMAGE-SIZES`) `legacy-write` entries; `loadsiteflat` (`EX-CONTENT-FEED-UNORDERED-SORT`), `multifileupload` (`EX-CARCH-UPLOAD-PAGELIMIT`) and `search` (`EX-CARCH-SEARCH-SITE`) `read` entries |
| `admin:cchangesets.*`, except `publish` and `rollback` ([Not built here](#not-built-here)) | Change sets | `web/` → `/v1/sites/{siteid}/changesets/**`, `/v1/raw/cchangesets/loadtagarray` | `delete`, `removeitem` and `save` `target` from `v0002`, `legacy` in `v0001`; the others `legacy` |
| `admin:ccomments.*` | Comment moderation | `web/` → `/v1/sites/{siteid}/comments/**`, `/v1/raw/ccomments/*` | `approve`, `bulkedit`, `delete`, `markasspam`, `purgedeletedcomments`, `singleedit` and `unapprove` `target` from `v0002`, `legacy` in `v0001`; the others `legacy` |
| `admin:ccategory.*` | Categories | `web/` → `/v1/sites/{siteid}/categories/**` | `update` `target` from `v0002`, `legacy` in `v0001`; the others `legacy` |
| `admin:cfeed.*`, except `import2` | Collections and the feed import preview | `web/` → `/v1/sites/{siteid}/feeds/**`, `/v1/raw/cfeed/*` | `update` `target` from `v0002`, `legacy` in `v0001`; the others `legacy` |
| `admin:cchain.*` | Approval chains and pending approvals | `web/` → `/v1/sites/{siteid}/approval-chains/**` | `delete` and `save` `target` from `v0002`, `legacy` in `v0001`; the others `legacy` |
| `admin:cform.*` | Form builder dialogs, export and import | `web/` → `/v1/sites/{siteid}/forms/import`, `/v1/raw/cform/*` | `importform` `target` from `v0002`, `legacy` in `v0001`; the others `legacy` |
| `admin:cnav.searchsitedata` | Site search data | `web/` → `/v1/raw/cnav/searchsitedata` | `legacy` |
| `api:` and `rest:` `<entity>.delete`, `findall`, `findmany`, `findnew`, `findone`, `findpermissions`, `findproperties`, `findquery`, `save`, `validate` for `content`, `contentnav`, `comment`, `category`, `contentcategoryassign`, `file`, `filemetadata`, `changeset`, `changesetcategoryassignment`, `feed`, `stats`, `variationtargeting` | JSON API entities | `/_api/{json,ajax,rest}/v1*`, `/index.cfm/_api/{json,ajax,rest}/v1*` | `save` and `delete` of every entity `target` from `v0002`, `legacy` in `v0001`, except `content.save` and `contentnav.save`, withheld `legacy-write` entries ([Not built here](#not-built-here)), as are `file.save{upload=image}` (`EX-FILE-RENDITION`), the `rest:` `{session}` variant of each `save` and `delete`, for REST behind an unmapped spelling of `index.cfm` (`EX-REST-INDEX-SESSION`), and its `{siteid}` variant, for sessionless REST carrying a `siteid` param (`EX-REST-SITEID-STARTUP`); the others `legacy`; halted among them: `findall`, `findmany` and `findquery` of every entity (`EX-JSONAPI-BLANK-ROW-LIMIT`), of `content` and `contentnav` also `EX-CONTENT-FEED-UNORDERED-SORT` and `EX-CONTENT-FEED-MULTISITE-SORT`, `content.findone` (`EX-CONTENT-RENDER`) and `validate` of every entity (`EX-CONTENT-VALIDATE`) |
| `api:` and `rest:` `comment.~delete`, `~flag`, `~markasspam`, `~undelete`, `~unmarkasspam` | Comment bean methods called through the API; each runs, except over sessionless REST, then answers legacy's 500 `server_error` | `/_api/{json,ajax,rest}/v1*`, `/index.cfm/_api/{json,ajax,rest}/v1*` | `target` from `v0002`, `legacy` in `v0001`; the `rest:` `{session}` and `{siteid}` variants `legacy-write` (`EX-REST-INDEX-SESSION`, `EX-REST-SITEID-STARTUP`) |
| `api:` and `rest:` `<entity>.~<relation>`, one per relation the entity declares | Relation paths `<entity>/<id>/<relation>`: findOne or findQuery of the related entity; `site` values from programs-sites `lookupSiteJsonApiValues`, whose unavailability answers the legacy-shaped 503 | `/_api/{json,ajax,rest}/v1*`, `/index.cfm/_api/{json,ajax,rest}/v1*` | `legacy` (unlisted keys) |
| `api:` and `rest:` `findcalendaritems`, `findrelatedcontent`, `geturlforimage`, `findversionhistory`, `findcrumbarray` | JSON API content methods | `/_api/{json,ajax,rest}/v1*`, `/index.cfm/_api/{json,ajax,rest}/v1*` | `legacy`; `findrelatedcontent` and `findversionhistory` halted (`EX-JSONAPI-BLANK-ROW-LIMIT`) |
| `api:` and `rest:` `comment.findcrumbarray`, `content.findcrumbarray`, `category.findcrumbarray`, `content.findrelatedcontent`, `content.findversionhistory` | The `<entity>/<id>/crumbs`, `content/<id>/relatedcontent` and `content/<id>/history` paths of those methods | `/_api/{json,ajax,rest}/v1*`, `/index.cfm/_api/{json,ajax,rest}/v1*` | `legacy` |
| `feed:v1` | RSS feeds; the site settings they print come from programs-sites `lookupSiteFeedSettings`, and its unavailability answers the legacy-shaped 503 | `/_api/feed/v1*`, `/tasks/feed*` | `legacy`; halted (`EX-CONTENT-FEED-UNORDERED-SORT`, `EX-CONTENT-FEED-MULTISITE-SORT`) |
| `render:file`, `render:small`, `render:medium` | File and rendition streams | `/_api/render/{size}`, `/tasks/render/{size}` | `legacy`; `render:file` a `legacy-write` entry (`EX-FILE-RENDITION`) |
| `variation:js` | `variation.js.cfm`, while `MURA_VARIATIONS` is on | Legacy only. The built `/_api/resource/variation*` route, which no version routes to, answers legacy's empty page while the url carries no `siteid` or `MURA_VARIATIONS` is off, else the legacy-shaped 503 (`variation-script-runtime`, `EX-VARIATION-SCRIPT`); a `siteid` naming another site than the token's is refused | `legacy`; legacy-served (halted, `EX-VARIATION-SCRIPT`) |
| `cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=get`, `flag`, `getcontentstats` | Comments proxy data methods | `/core/modules/v1/comments/ajax/commentsProxy.cfc` | `flag` `target` from `v0002`, `legacy` in `v0001`; `get` and `getcontentstats` `legacy` |
| `cfm:/core/modules/v1/rater/ajax/saverate.cfm` | Rating save | `GET`, `POST /core/modules/v1/rater/ajax/saveRate.cfm` | `target` from `v0002`, `legacy` in `v0001` |

Why the other content routes stay on legacy in this run:

- **Groups.** `gateway/cutover/groups.json` puts 27 of the 39 content units into one group, `grp:content.approval_action`, because carried writes such as `api:content.delete` reach them together, and `content.comment`, `content.content_rating` and `content.content_stats` into `grp:content.comment`. Both are `target`-authoritative from `v0002`, and `v0003` keeps them so: `gateway/src/cutover/prevented-writers.ts` closes every non-request writer of their units, namely Masa's start-up bundle deploy (`getToWork*` in `core/mura/publisher.cfc`), start-up URL conversion, project-site creation and plugin discovery by their start-up guards, and the scheduled writers the siteMonitor run reaches, such as `changesetManager.publish`, whose runs the gateway dispatches (route key `sitemonitor:run`). The other content groups have no carry write entry and stay `legacy`-authoritative in every version, so every content read entry, whose units include one of them, stays `legacy`; only `opt2:/opt2/files/content-files/**`, whose one unit `content.file` is `target`-authoritative, is `target` from `v0002`.
- **Halted cases** ([`opt2/exceptions-list.md`](../../opt2/exceptions-list.md)). `EX-CARCH-SEARCH-SITE`, `EX-CARCH-UPLOAD-PAGELIMIT` and `EX-CARCH-IMAGE-SIZES` keep `admin:carch.search`, `admin:carch.multifileupload` and `admin:carch.imagedetails` on legacy in every version: each needs site settings no programs-sites contract gives this service, so it answers the legacy-shaped 503 naming the halt reason. `EX-CARCH-EDIT-FORM` makes `admin:carch.edit` a `legacy-write` entry in every version: the edit form prints notify recipients and restrict groups, the theme's templates on the legacy web root and site settings this service cannot read, so it answers the legacy-shaped 503 naming `carch-edit-halted`, and the gateway serves the form on legacy inside write windows. `EX-FEED-REMOTE-OVERSIZE` keeps `admin:cfeed.import1` on legacy in every version: the service reads at most 100 MiB of a remote feed, counted after decompression, and answers a larger one with the legacy-shaped 503 naming `feed-remote-oversize-halted`. `EX-CONTENT-VALIDATE` keeps the 24 `api:` and `rest:` `<entity>.validate` keys of the content entities on legacy: `validate` reproduces ad hoc rules, the content beans' own rules and loadby lookups, and answers the 503 for the cases that need ColdFusion's regex engine and built-in `isValid` patterns, site resource bundles, another owner's beans, the session's site or SQL Server's scan order. `EX-CONTENT-FEED-UNORDERED-SORT` (route key `api:content.findquery`) keeps 14 keys on legacy in every version, the 12 `api:` and `rest:` `findall`, `findmany` and `findquery` keys of `content` and `contentnav`, `feed:v1` and `admin:carch.loadsiteflat`: a feed `sortBy` that is neither a sort option nor an extended attribute the pool holds sorts every row by NULL, so SQL Server's plan alone picks and orders the rows under `TOP maxItems`; the service answers such a feed with a TOP over more than one row that could answer, and a flat-view due-date view whose TOP of 500 drops rows or in which two rows tie on both dates, with the legacy-shaped 503 naming `feed-extended-sort-unordered`. `EX-CONTENT-FEED-MULTISITE-SORT` (route key `api:content.findquery`) keeps 13 keys on legacy in every version, the same 12 `api:` and `rest:` keys and `feed:v1`: legacy orders a feed over several sites of its content pool in one statement, by values its rows need not return, while the service reads each pool site in its own tenant transaction and merges the rows, so it answers a sort by values the rows do not return with the legacy-shaped 503 naming `feed-content-unsupported`. `EX-JSONAPI-BLANK-ROW-LIMIT` (route key `api:content.findquery`) keeps 76 keys on legacy in every version, the `api:` and `rest:` `findall`, `findmany` and `findquery` keys of the 12 content entities, `findrelatedcontent` and `findversionhistory`: a list page before its first record serializes one blank row per step, so whether legacy finishes a large such page turns on its request timeout and host speed, and the service answers a page of more than 1000 such rows with the legacy-shaped 503 naming `iterator-blank-rows-timeout`. `EX-REST-INDEX-SESSION` keeps the `{session}` variant of every carried `rest:` write `legacy-write` in every version: legacy serves a REST call session-managed when `path_info` keeps a spelling of `index.cfm` the container does not map (`/INDEX.CFM`, `/Index.cfm`, `/index.CFM`) or a double-encoded `_api` segment, and this service serves REST sessionless, so the gateway serves those spellings on legacy inside write windows. `EX-REST-SITEID-STARTUP` keeps the `{siteid}` variant of the same writes `legacy-write` in every version: a sessionless REST call with a non-empty `siteid` in the form scope, else the url scope, fails in legacy's `onRequestStart` before the credential code with ColdFusion's 500 error page, which this service cannot print, so the gateway serves those calls on legacy inside write windows. Open `preserve` entries: `EX-SHELL-THEMEPATH`, `EX-CCHAIN-PENDING-PREVIEW`, `EX-CARCH-VERSION-PREVIEW`, `EX-CARCH-UPDATE-RERENDER`, `EX-UNSTORABLE-TEXT-VARIATIONTARGETING`, `EX-VARIATIONTARGETING-REGISTRATION`, `EX-JSONAPI-IMAGE-SIZES-CACHE`, `EX-PROFILE-INTEREST-SITES`, `EX-COMMENT-REMOTE-SITE`, `EX-JSONAPI-PARAMS-NULL-HINT`, `EX-JSONAPI-REST-CREDENTIALS`. `EX-COMMENT-REMOTE-SITE` records that the comment remote functions reach only the token tenant's comments, where legacy loads a comment by id from any site; the keys are not halted, since no request variant tells another site's id from a missing one. `EX-JSONAPI-PARAMS-NULL-HINT` records that, with `suppressAPIParams` false, an echo holding a JSON null under a serializer-hinted key answers legacy's debugging-off error page (`core/templates/error.html` at 500), where legacy with `debuggingEnabled` on prints its debug page. `EX-JSONAPI-REST-CREDENTIALS` keeps the carried `rest:` writes on this service and answers the 503 naming the entry for a REST call without a user token whose answer identity's OAuth clients or tokens decide, which through the gateway arrives only for a REST session that ended after identity's exchange.

Every operation of the contract is registered. These carried operations answer the legacy-shaped 503 instead of running, because they need data or CFML runtime this service does not hold:

- Credentials sent for a restricted feed on `/_api/feed/v1` and `/tasks/feed`, which are identity data, and a feed item with dynamic tags, which only the CFML runtime renders (`src/routes/feed.ts`).
- The variation script `/_api/resource/variation` for a url with a `siteid` while `MURA_VARIATIONS` is on, which only the CFML runtime generates.
- `carch.loadnotify` and `carch.loadexpirenotify`, whose recipients are people and identity data, and `carch.loadclassconfigurator`, which reads legacy CFML.
- `cfeed.edit`, `cfeed.loadsite` and `cfeed.siteparents`, whose site values and labels have no source here.
- The save of a form import (`cform.importform`) that passes legacy's checks, which needs site settings.
- The halted cases above.

Other carried operations answer the legacy-shaped 503 only on branches that need such data, such as a JSON API content read with `render`, a sized rendition never stored, and lists that print preview URLs.

### `/v1` APIs

`web/` calls these through the gateway with the session's user token (`web/src/screens/{carch,cchangesets,ccomments,ccategory,cfeed,cform,cchain,cnav,ceditprofile}/`). `carch.edittext` and `carch.scaffold` are static views `web/` renders without service data. No registered `web/` screen calls `GET /v1/sites/{siteid}/content` (search), `…/content/{contentid}/multi-file-upload`, `…/files/image-details`, `POST …/content/versions/{contenthistid}/object-params`, `GET`, `POST …/variation-targeting` or `POST …/changesets/{changesetid}/rollback`: their `carch` and `cchangesets` actions are halted or withheld and served by legacy ([Legacy routes](#legacy-routes), [Not built here](#not-built-here)). The rollback operation is built, but `admin:cchangesets.rollback` is withheld: `web/` registers no screen for it, and every version keeps it a `legacy-write` entry, so no version routes it to the target. `GET …/files/{fileid}/download-url` has no `web/` caller.

| Paths | Requires | Does |
|---|---|---|
| `GET /v1/sites/{siteid}/content/tree`, `/content`, `/content/drafts`, `/content/images`, `/content/{contentid}`, `/content/{contentid}/history`, `/content/{contentid}/versions/{contenthistid}/audit`, `/content/{contentid}/multi-file-upload`, `/content/versions/{contenthistid}/summary` | `s2`, `site-admin`, `m:000` | Site Manager tree, search, drafts, media selector, edit model, history, audit, upload form, version summary |
| `POST /v1/sites/{siteid}/content/versions/{contenthistid}/object-params` | `s2`, `site-admin`, `m:000` | `carch.updateobjectparams` |
| `GET /v1/sites/{siteid}/content/{contentid}/crumbs` | `s2`, `site-admin` | Node crumbs for identity's permission screens |
| `GET /v1/sites/{siteid}/header-prompts` | `s2`, `site-admin`, `system-user` | Admin header badge counts |
| `GET /v1/sites/{siteid}/private-interest-groups` | `s2`, `site-admin`, `system-user`, `member` | One level of a private user pool's interest groups, each with its site id, for Edit Profile and Edit User; 503 for a level that rows of several sites hold (`EX-PROFILE-INTEREST-SITES`) |
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
| `GET`, `POST /v1/raw/<circuit>/<action>` | as the circuit above; `cnav/searchsitedata` public | Legacy fragment, JSON and download responses that `web/` relays unchanged: 34 `carch` actions (`loadsitemanager`, `sitemanagertab`, `statusmodal`, `approvalaction`, `loaddiff`, `downloaddata`, …; `web/` relays all but `loadsiteflat`, `savequickedit` and `update`, which legacy serves), `cchangesets/loadtagarray`, `ccomments/{ajax,loadcomments,loadcommentspage}`, `cfeed/{loadsite,siteparents,update}`, `cform/{export,getdataset,getdialog,getfield,getfieldtemplate,getfieldtype,getform}`, `cnav/searchsitedata` |

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

- **Halted** (`EX-FILE-RENDITION`): image uploads and the image tools. Legacy writes their renditions with ColdFusion's image engine, whose bytes no other encoder reproduces. The image saves `admin:carch.update{upload=image}` (the route key of `EX-FILE-RENDITION`, also withheld under `opt2/decision-list.json#tcontenteventreminders`), `api:file.save{upload=image}` and `rest:file.save{upload=image}`, and the tools `admin:carch.cropimage`, `admin:carch.rotateimage` and `admin:carch.flipimage`, are `legacy-write` entries in every version: they run on legacy inside write windows that import their originals and renditions into `content-files`. The upload page `admin:carch.multifileupload{upload=image}` is a `read` entry with no group in every version and stays on legacy; its uploads post to `carch.update`. `render:file` is one too: for an image it streams the `_<size>` rendition, `_file` for `/_api/render/file/`, and generates a missing one with the same engine, so strategies-content streams a stored rendition and answers one never stored with the legacy-shaped 503, never the original. Non-image uploads are carried.
- **Halted** (`EX-CONTENT-RENDER`): the JSON API content render branch (`content/_path/…`, `content/_variation/…`, a merged `render` parameter) of `api:content.findone` and `rest:content.findone`. Legacy answers it with the CFML theme renderer's page data, the site `404` page's for an unknown filename; strategies-content answers every such request with the legacy-shaped 503, and both keys stay `legacy` in every version.
- **Halted** (`EX-VARIATION-SCRIPT`): `variation:js` once its branch is taken (`MURA_VARIATIONS` on and a `siteid`). The script is CFML-runtime output; strategies-content answers the legacy-shaped 503, and the key stays `legacy` in every version.
- **Withheld** (decision list, [`opt2/decision-list.md`](../../opt2/decision-list.md); they keep running on legacy as `legacy-write` entries): `admin:carch.update{approved=1}`, `admin:carch.update{notify}`, `admin:carch.updateobjectparams{approved=1}`, `admin:cchangesets.publish` and `admin:cfeed.import2`, which write `tcontenteventreminders`; `admin:carch.importcontent`, which writes decision-list tables; `admin:carch.copy` and `admin:carch.variationtargeting{notify}`, whose writes span identity. These, too, can write `tcontenteventreminders` and are withheld, though their code is built here and no version routes to it: `admin:carch.update`, `admin:carch.savequickedit`, `admin:carch.updateobjectparams`, `admin:carch.variationtargeting`, `admin:carch.approvalaction{action=approve}`, `admin:cchangesets.rollback`, `api:`/`rest:` `content.save` and `contentnav.save`, and the site-monitor steps `changeset-publish` and `feed-import`.
- **Legacy-served:** `admin:carch.export`, `exportcontent`, `exportcomponent`, `import`, `importcomponent` (bundle engine); `variation:js` (`/_api/resource/variation` renders CFML; its built route is unrouted); `admin:carch.emailtest` (communications); `admin:carch.displayobjectmodal`, `frontendconfigurator`, `loadrepomanager`; `admin:cfilemanager.default`, `api:filebrowser.~*`, `rest:filebrowser.~*` and `/_api/asset/` (`asset:upload`, `asset:render`) (legacy web-root filesystem); `admin:razuna.*`, `admin:scaffold.*`, `admin:cplugins.*`; `api:processasyncobject`; `api:swagger`; `declareEntity`, `undeclareEntity`, `checkSchema`; public page render, `doaction=saveRate` (`page:saverate`) and `saveform`; `commentsProxy.renderCommentsPage`.
- **Retired:** `api:submitform`, a public method name with no function behind it in `jsonApiUtility.cfc`.
- **Decision-list tables** (no target table, mapping or route): `tremotepointer`, `trazunasettings`, `fb_*`, `tentity`, `tcontenteventreminders`.

## Legacy behaviour kept on purpose

Reproduced as Masa shows it (see [`opt2/reports/pre-existing-defects.md`](../../opt2/reports/pre-existing-defects.md)):

- **SEC-01.** `carch.approvalaction` skips its CSRF check, `true or rc.$.validateCSRFTokens(…)` [admin/core/views/carch/approvalaction.cfm:1]; `/v1/raw/carch/approvalaction` declares `x-opt2-csrf` `bypassed` and consumes no token.
- **SEC-02.** `cChangesets.publish` checks no CSRF token [admin/core/controllers/cchangesets.cfc:144-147]; the action is withheld, so legacy keeps serving it.
- Routes whose legacy action validates no token (`x-opt2-csrf` `none`: comment moderation, object params, variation targeting save, file metadata) consume none.

Open entries ([`opt2/exceptions-list.md`](../../opt2/exceptions-list.md)), whose routes keep the legacy contract:

- **`EX-RENDER-404-PAGE`** (`preserve`). `render404` prints the site theme's `404` page; `/_api/render/*` and `/_api/feed/v1` answer its 404 `Content Not Found` status and content type with an empty body. It holds no route.
- **`EX-SEC-CONTENT-ENTITY-SITE`** (`fix`, SEC-11). Legacy JSON API `findOne` of `category`, `comment` and `feed` loads another site's row by id; strategies-content reads by id only in the token site's tenant and category pool and answers a new bean. Not activated: the six `findOne` keys stay `legacy` in every version.

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

`test/contract` and `test/security` need nothing external. Suites over the database read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, create a throwaway copy of schema `content` through `@opt2/platform/testing`, skip when `PG_HOST` is unset and fail when PostgreSQL is unreachable.

- **Environment.** `contentEnvSchema` in `src/app.ts`: `baseEnvSchema` of `@opt2/platform/service-kit` ([`platform/README.md`](../../platform/README.md#configuration)): `PORT`, `OPT2_SERVICE_NAME=strategies-content`, `OPT2_ENV`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `OPT2_DB_AUTH`, `CLOUD_SQL_INSTANCE`, `PUBSUB_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_LOG_LEVEL`, `OPT2_JWKS_URL`, `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, `OPT2_SERVICE_URLS`, `OPT2_STATE_DIR`, `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER`, `LOG_LEVEL`, `TZ`; plus `MURA_VARIATIONS`, a ColdFusion boolean (`true`, `yes`, `1`, `false`, `no`, `0`; false when unset) that registers the `variationTargeting` entity at start-up (its finders and `read` permission; save, delete and properties answer either way) and turns on `/_api/resource/variation`, as configBean `variations` does. While it is off, a `findProperties` of `variationTargeting` registers the entity for its site until the service instance stops, as legacy's does on the site's API instance until the site beans are rebuilt (`EX-VARIATIONTARGETING-REGISTRATION`). `OPT2_SERVICE_URLS` must name `identity` (CSRF consume, session and admin state), `programs-sites` (the site custom image sizes of JSON API content `images`, `GET /internal/v1/sites/{siteId}/image-sizes`; the site settings of rendered RSS feeds, `POST /internal/v1/sites/feed-settings:lookup`; the `site` values of JSON API relations, `POST /internal/v1/sites/json-api-values:lookup`) and `strategies-content` (the target of its own tasks; in the cloud also its push and Cloud Tasks audience).

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
| `MURA_SUPPRESSAPIPARAMS` | A CFML boolean | true | Stops start-up | Drops `params` from every JSON API envelope |
| `MURA_USEDATANAMESPACEFORAPI` | A CFML boolean | true | Stops start-up | Keeps a struct `data` under `data` unless the request's `useDataNamespace` is a boolean |

- **JSON API envelope settings.** `MURA_SUPPRESSAPIPARAMS` (configBean `suppressAPIParams`) drops `params` from every JSON API envelope, errors and denials included; `MURA_USEDATANAMESPACEFORAPI` (configBean `useDataNamespaceForAPI`) keeps a struct `data` under `data` unless the request's `useDataNamespace` is a boolean [core/mura/client/api/json/v1/jsonApiUtility.cfc:11,1471-1511]. Both are CFML booleans, true when unset; any other value fails start-up, as legacy would fail every response. A site content renderer's `useDataNamespaceForAPI` would override the configBean value [core/mura/client/api/json/v1/jsonApiUtility.cfc:13-15]; renderers are legacy theme CFML this service cannot read, and no deployed renderer sets it, so the configBean value governs. Echoed `params` are processRequest's: url, form (with `fieldnames`) and JSON body values, the REST family's and an admin preview's `mobileFormat` [core/appcfc/onRequestStart_include.cfm:271-306], a JSON null kept as `null`, which handlers read as absent; an echo holding a JSON null under a serializer-hinted key, on which legacy's serializer raises, answers onError's page as legacy does with debugging off: `core/templates/error.html` at `500 An Error Occurred` under the JSON content type, without an ETag (`EX-JSONAPI-PARAMS-NULL-HINT`). The fail-closed 503 omits `params` under either value, as the gateway's does.
- **Local.** `harness/repro/up.sh` starts the service natively with `PORT=8114` and `PG_USER=content_app`, after `opt2-db bootstrap --target local` has created the schema and roles. Local storage lives under `${OPT2_STATE_DIR}/storage/content-files/`.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `content_app`, bucket `content-files`, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).
