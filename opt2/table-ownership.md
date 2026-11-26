# Table ownership

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

[`table-ownership.json`](table-ownership.json) is the source this file renders, and the unit of write authority is one target table, written `<schema>.<table>`.

## Rule steps

| Step | Rule |
|---|---|
| 1 | Entity owner: the service that owns the entity owns its table. |
| 2 | Membership and permission tables go to identity. |
| 3 | Other services keep an id plus an event-fed projection. |
| 4 | Pooled data is umbrella-tenant data. |
| 5 | Anything else goes on the decision list. |

## Counts

| Measure | Static count | Note |
|---|---|---|
| Bootstrap tables (`core/setup/db/mssql.sql`) | 41 | 40 live, because `core/mura/dbUpdates/5.7.cfm:136` drops `tglobals` |
| Tables created by migrations (`core/mura/dbUpdates/*.cfm`) | 12 | — |
| ORM-only entity tables (`table=` of concrete `beanORM` entities) | 21 | — |
| Live core tables | 73 | 40 + 12 + 21 |
| Tables with a `siteID` column | 55 | Includes `tcontentfilemetadata` (`siteID` from `beanORMVersioned`) and `tremotepointer` (created lazily), so a fresh live catalog shows 54 |
| Bootstrap tables without a primary key | 10 | 8 live: `tsettings` gains its key in `core/mura/dbUpdates/6.1.cfm:120-122` and `tglobals` is retired |
| Fixture, dynamic-pattern, test-suite and OPT-2 tables | 1, 2, 2, 1 | Listed under Owners and Fixture tables |
| Units | 85 | Listed under Units |

The keyless bootstrap tables are `tcontentdisplaytitleapprovals`, `tcontenteventreminders`, `tcontentpublicsubmissionapprovals`, `temailreturnstats`, `temailstats`, `tglobals`, `tmailinglist`, `tmailinglistmembers`, `tsettings` and `tsystemobjects`; keyless live tables match as a multiset of full-row encodings, with `legacy_row_hash` and an occurrence number on each target row.

The live-catalog counts in `opt2/inventory/legacy-inventory.json` govern over these static figures.

## Owners

Unit counts cover Masa tables; the fixture table and its unit are under Fixture tables. An owner's extension shares are the `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets` and `tclassextenddata` rows whose subtype's `baseTable` resolves to it (Shared tables).

| Owner | Legacy tables | Target tables | Step |
|---|---|---|---|
| identity | `tusersmemb`, `tpermissions`, `tuserstrikes`, `tuserremotesessions`, `tuserdevice`, `tredirects`, `toauthclients`, `toauthtokens`; the identity shares of `tusers`, `tuseraddresses`, `tusersinterests`, `tuserstags`, `tusersfavorites`, `tclassextenddatauseractivity` and `ttrash`; its extension shares | Schema `identity`, 23 units | 2 for `tusersmemb` and `tpermissions`; 1 for the rest |
| people | The people shares of `tusers`, `tuseraddresses`, `tusersinterests`, `tuserstags`, `tusersfavorites`, `tclassextenddatauseractivity`, `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets`, `tclassextenddata` and `ttrash` | Schema `people`, 12 units | 1; 1 and 3 for `tusersinterests` (category ids kept, names by projection) and `tusersfavorites` (content ids kept, resolved through strategies-content) |
| programs-sites | `tsettings`, `timagesizes`, `tdirectories`, `tsystemobjects`; its extension shares; its `ttrash` share | Schema `programs_sites`, 10 units | 1 |
| strategies-content (content) | `tcontent`, `tcontentobjects`, `tcontentrelated`, `tcontenttags`, `tcontentcategoryassign`, `tcontentcategories`, `tcontentassignments`, `tcontentstats`, `tcontentratings`, `tcontentcomments`, `tcontentcommentcommenters`, `tcontentfeeds`, `tcontentfeeditems`, `tcontentfeedadvancedparams`, `tfiles`, `tcontentfilemetadata`, `tcontentfilenamearchive`, `tcontentsourcemaps`, `tcontentremotepointer`, `tcontentvariationtargeting`, `tcontentdisplaytitleapprovals`, `tcontentpublicsubmissionapprovals`, `tformresponsepackets`, `tformresponsequestions`; its extension shares, approval and change-set base tables included; its `ttrash` share | Schema `content`, 30 units | 1 |
| strategies-content (approvals and change sets) | `tapprovalchains`, `tapprovalmemberships`, `tapprovalassignments`, `tapprovalrequests`, `tapprovalactions`, `tchangesets`, `tchangesetrollback`, `tchangesetcategoryassign`, `tchangesettagassign` | Schema `content`, 9 units | 1; `tapprovalmemberships` links chains to approving groups, which is workflow configuration, so step 2 does not apply |
| legacy | `temails`, `temailstats`, `temailreturnstats`, `tmailinglist`, `tmailinglistmembers`, `tsessiontracking`; the `ttrash` rows of classes `mailinglist` and `email` | None; no target service owns them, so nothing migrates and their routes stay on legacy | — |
| retired | `tglobals` (dropped by `core/mura/dbUpdates/5.7.cfm:136`); `testoption`, `testwidget` (created only by the TestBox entities spec) | None; nothing migrates | — |
| decision list | `tplugins`, `tpluginsettings`, `tpluginscripts`, `tplugindisplayobjects`, `tclusterpeers`, `tclustercommands`, `tentity`, `tentity-declared:*`, `tremotepointer`, `trazunasettings`, `tcontenteventreminders`, `fb_*` (`opt2/decision-list.md`, pending) | None until approved | 5 |
| migration | `opt2_sync.projector_checkpoint` (reverse-projector checkpoint in the legacy database) | None; coordination state that never migrates | — |

## `tusers` column split

| Target | Row predicate | Columns |
|---|---|---|
| `identity.group_account` | `Type = 1` | All 38 live columns: the 37 bootstrap columns (`core/setup/db/mssql.sql:467-505`) plus `tablist` |
| `identity.user_account` | `Type = 2` | `UserID`, `UserName`, `Type`, `Admin`, `S2`, `Perm`, `InActive`, `isPublic`, `SiteID`, `remoteID`, `tablist` |
| `identity.credential` | `Type = 2` | `Password`, `PasswordCreated` |
| `identity.login_state` | `Type = 2` | `LastLogin` |
| `people.person` | `Type = 2` | `GroupName`, `Fname`, `Lname`, `Email`, `Company`, `JobTitle`, `mobilePhone`, `Website`, `subType`, `Ext`, `ContactForm`, `LastUpdate`, `LastUpdateBy`, `LastUpdateByID`, `Subscribe`, `notes`, `description`, `interests`, `keepPrivate`, `photoFileID`, `IMName`, `IMService`, `created`, `tags`; key `UserID`, `SiteID`, copied from `identity.user_account`, which owns them |

`tablist` is a live column added by `core/mura/dbUpdates/5.2.1932.cfm:18`, and for `Type = 2` rows it belongs to `identity.user_account`, because `core/mura/user/userBean.cfc:640-660` unions it across memberships as an account authorisation attribute.

The reverse projector reassembles each legacy row from every owner's columns, and an unassigned live column fails `services/*/test/unit/mapping.test.ts`.

## Shared tables

| Shared table | Split |
|---|---|
| `tuseraddresses`, `tusersinterests`, `tuserstags`, `tusersfavorites`, `tclassextenddatauseractivity` | By the `Type` of the owning `tusers` row: 1 to identity, 2 to people. The join is `userID = tusers.UserID`; `tclassextenddatauseractivity` joins on `baseID = tusers.UserID`, or on `baseID = tuseraddresses.addressID` and then `tuseraddresses.userID = tusers.UserID` for address extended data |
| `tclassextenddata` | By the `baseTable` of the attribute's subtype, through `attributeID` → `tclassextendattributes.extendSetID` → `tclassextendsets.subTypeID` → `tclassextend.baseTable`, resolved by `split.baseTableOwners`: `tcontent` to strategies-content, `tsettings` to programs-sites, `tusers` and both Address spellings, `tusersaddresses` (XML import, `core/mura/extend/extendManager.cfc:1906-1910`) and `tuseraddresses` (subtype editor, `admin/core/views/cextend/editsubtype.cfm:80`), to people; every other table the JSON gives to one data owner to that owner's `extend_data`. Any other value (`custom`, an empty `baseTable`, a split, decision-list, retired, legacy or migration table, an unlisted name) resolves to no owner, and its rows stay on legacy with the withheld `cextend` and `ctrash` screens |
| `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets` | By `baseTable`, resolved by the same `split.baseTableOwners` (named values, both Address spellings, every other single-data-owner table to its owner, any other value left on legacy), into that owner's `extend_subtype`, `extend_set`, `extend_attribute` and `extend_rc_set`: `tclassextend` directly, `tclassextendsets` and `tclassextendrcsets` through `subTypeID`, `tclassextendattributes` through `extendSetID` → `subTypeID` |
| `ttrash` | By `objectClass` (`core/mura/trash/trashManager.cfc:175-176`): `content`, `feed`, `category`, `changeset` to strategies-content; `mailinglist`, `email` to legacy, so their rows stay on legacy; `group` to identity; `user` by its stored `Type` (1 identity, 2 people); `address` by its owning user's `Type`; `extendObject` by its subtype's `baseTable`, resolved as above, an unresolved one staying on legacy; an ORM entity name to the owner of the entity's table, which only dynamic decision-list entities reach, so those rows stay on legacy. An unmapped class fails `services/*/test/unit/mapping.test.ts` |

## Pools

Pool columns: `core/mura/settings/settingsBean.cfc:119-124,328-344`; every pool is step 4.

| Pool | Rows | Owner | Representation |
|---|---|---|---|
| `publicUserPoolID`, `privateUserPoolID` | `tusers`, `tusersmemb`, `tuseraddresses`, `tusersinterests`, `tuserstags`, `tusersfavorites`, `tclassextenddatauseractivity`, `tuserremotesessions`, `tuserstrikes` where `SiteID` is the pool site | identity and people, as split above | Umbrella `tenant_id`; each member site's two user pools are resolved from the registry, never from the token |
| `categoryPoolID` | `tcontentcategories` rows and `tusersinterests` category references whose `siteID` is the pool site | strategies-content | Umbrella `tenant_id`, read in a pool-tenant transaction |
| `filePoolID` | `tfiles` rows and the pool site's stored objects | strategies-content | Umbrella `tenant_id`; objects under the umbrella prefix in bucket `content-files` |
| `contentPoolID` | None; a site setting naming the sites whose content a site may reference | programs-sites stores it; strategies-content reads it | Read from the site projection, one transaction per pool tenant, merged |
| `displayPoolID` | None; it selects theme and display-object directories | programs-sites | Consumed only by legacy-served rendering |

## Units

Each unit is one target table; `newTables` in the JSON lists target-only tables, which hold no legacy rows and are not units.

| Owner | Unit | Legacy tables |
|---|---|---|
| identity | `identity.credential` | `tusers` |
| identity | `identity.extend_attribute` | `tclassextendattributes` |
| identity | `identity.extend_data` | `tclassextenddata` |
| identity | `identity.extend_data_user_activity` | `tclassextenddatauseractivity` |
| identity | `identity.extend_rc_set` | `tclassextendrcsets` |
| identity | `identity.extend_set` | `tclassextendsets` |
| identity | `identity.extend_subtype` | `tclassextend` |
| identity | `identity.group_account` | `tusers` |
| identity | `identity.login_state` | `tusers` |
| identity | `identity.membership` | `tusersmemb` |
| identity | `identity.oauth_client` | `toauthclients` |
| identity | `identity.oauth_token` | `toauthtokens` |
| identity | `identity.permission` | `tpermissions` |
| identity | `identity.redirect` | `tredirects` |
| identity | `identity.remote_session` | `tuserremotesessions` |
| identity | `identity.trash` | `ttrash` |
| identity | `identity.user_account` | `tusers` |
| identity | `identity.user_address` | `tuseraddresses` |
| identity | `identity.user_device` | `tuserdevice` |
| identity | `identity.user_favorite` | `tusersfavorites` |
| identity | `identity.user_interest` | `tusersinterests` |
| identity | `identity.user_strike` | `tuserstrikes` |
| identity | `identity.user_tag` | `tuserstags` |
| people | `people.extend_attribute` | `tclassextendattributes` |
| people | `people.extend_data` | `tclassextenddata` |
| people | `people.extend_data_user_activity` | `tclassextenddatauseractivity` |
| people | `people.extend_rc_set` | `tclassextendrcsets` |
| people | `people.extend_set` | `tclassextendsets` |
| people | `people.extend_subtype` | `tclassextend` |
| people | `people.person` | `tusers` |
| people | `people.person_archive` | `synthetic.person_archive` |
| people | `people.trash` | `ttrash` |
| people | `people.user_address` | `tuseraddresses` |
| people | `people.user_favorite` | `tusersfavorites` |
| people | `people.user_interest` | `tusersinterests` |
| people | `people.user_tag` | `tuserstags` |
| programs-sites | `programs_sites.directory` | `tdirectories` |
| programs-sites | `programs_sites.extend_attribute` | `tclassextendattributes` |
| programs-sites | `programs_sites.extend_data` | `tclassextenddata` |
| programs-sites | `programs_sites.extend_rc_set` | `tclassextendrcsets` |
| programs-sites | `programs_sites.extend_set` | `tclassextendsets` |
| programs-sites | `programs_sites.extend_subtype` | `tclassextend` |
| programs-sites | `programs_sites.image_size` | `timagesizes` |
| programs-sites | `programs_sites.site` | `tsettings` |
| programs-sites | `programs_sites.system_object` | `tsystemobjects` |
| programs-sites | `programs_sites.trash` | `ttrash` |
| strategies-content | `content.approval_action` | `tapprovalactions` |
| strategies-content | `content.approval_assignment` | `tapprovalassignments` |
| strategies-content | `content.approval_chain` | `tapprovalchains` |
| strategies-content | `content.approval_membership` | `tapprovalmemberships` |
| strategies-content | `content.approval_request` | `tapprovalrequests` |
| strategies-content | `content.category` | `tcontentcategories` |
| strategies-content | `content.changeset` | `tchangesets` |
| strategies-content | `content.changeset_category_assign` | `tchangesetcategoryassign` |
| strategies-content | `content.changeset_rollback` | `tchangesetrollback` |
| strategies-content | `content.changeset_tag_assign` | `tchangesettagassign` |
| strategies-content | `content.comment` | `tcontentcomments` |
| strategies-content | `content.commenter` | `tcontentcommentcommenters` |
| strategies-content | `content.content` | `tcontent` |
| strategies-content | `content.content_assignment` | `tcontentassignments` |
| strategies-content | `content.content_category_assign` | `tcontentcategoryassign` |
| strategies-content | `content.content_object` | `tcontentobjects` |
| strategies-content | `content.content_rating` | `tcontentratings` |
| strategies-content | `content.content_related` | `tcontentrelated` |
| strategies-content | `content.content_remote_pointer` | `tcontentremotepointer` |
| strategies-content | `content.content_stats` | `tcontentstats` |
| strategies-content | `content.content_tag` | `tcontenttags` |
| strategies-content | `content.display_title_approval` | `tcontentdisplaytitleapprovals` |
| strategies-content | `content.extend_attribute` | `tclassextendattributes` |
| strategies-content | `content.extend_data` | `tclassextenddata` |
| strategies-content | `content.extend_rc_set` | `tclassextendrcsets` |
| strategies-content | `content.extend_set` | `tclassextendsets` |
| strategies-content | `content.extend_subtype` | `tclassextend` |
| strategies-content | `content.feed` | `tcontentfeeds` |
| strategies-content | `content.feed_advanced_param` | `tcontentfeedadvancedparams` |
| strategies-content | `content.feed_item` | `tcontentfeeditems` |
| strategies-content | `content.file` | `tfiles` |
| strategies-content | `content.file_metadata` | `tcontentfilemetadata` |
| strategies-content | `content.filename_archive` | `tcontentfilenamearchive` |
| strategies-content | `content.form_response_packet` | `tformresponsepackets` |
| strategies-content | `content.form_response_question` | `tformresponsequestions` |
| strategies-content | `content.public_submission_approval` | `tcontentpublicsubmissionapprovals` |
| strategies-content | `content.source_map` | `tcontentsourcemaps` |
| strategies-content | `content.trash` | `ttrash` |
| strategies-content | `content.variation_targeting` | `tcontentvariationtargeting` |

## Fixture tables

| Fixture table | Target | Note |
|---|---|---|
| `synthetic.person_archive` | `people.person_archive` | Tenant from `siteID` |

A subtype whose `baseTable` is `synthetic.person_archive` joins the people extension units.
