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
| Fixture, dynamic-pattern, test-suite and OPT-2 tables | 26, 2, 2, 1 | Listed under Owners and Fixture tables |
| Units | 108 | Listed under Units |

The keyless bootstrap tables are `tcontentdisplaytitleapprovals`, `tcontenteventreminders`, `tcontentpublicsubmissionapprovals`, `temailreturnstats`, `temailstats`, `tglobals`, `tmailinglist`, `tmailinglistmembers`, `tsettings` and `tsystemobjects`; keyless live tables match as a multiset of full-row encodings, with `legacy_row_hash` and an occurrence number on each target row.

The live-catalog counts in `opt2/inventory/legacy-inventory.json` govern over these static figures.

## Owners

Unit counts cover Masa tables; fixture tables and their units are under Fixture tables.

| Owner | Legacy tables | Target tables | Step |
|---|---|---|---|
| identity | `tusersmemb`, `tpermissions`, `tuserstrikes`, `tuserremotesessions`, `tuserdevice`, `tredirects`, `toauthclients`, `toauthtokens`; the identity shares of `tusers`, `tuseraddresses`, `tusersinterests`, `tuserstags`, `tusersfavorites`, `tclassextenddatauseractivity` and `ttrash` | Schema `identity`, 18 units | 2 for `tusersmemb` and `tpermissions`; 1 for the rest |
| people | The people shares of `tusers`, `tuseraddresses`, `tusersinterests`, `tuserstags`, `tusersfavorites`, `tclassextenddatauseractivity`, `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets`, `tclassextenddata` and `ttrash` | Schema `people`, 12 units | 1; 1 and 3 for `tusersinterests` (category ids kept, names by projection) and `tusersfavorites` (content ids kept, resolved through strategies-content) |
| programs-sites | `tsettings`, `timagesizes`, `tdirectories`, `tsystemobjects`; the `baseTable = 'tsettings'` shares of `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets`, `tclassextenddata`; its `ttrash` share | Schema `programs_sites`, 10 units | 1 |
| strategies-content (content) | `tcontent`, `tcontentobjects`, `tcontentrelated`, `tcontenttags`, `tcontentcategoryassign`, `tcontentcategories`, `tcontentassignments`, `tcontentstats`, `tcontentratings`, `tcontentcomments`, `tcontentcommentcommenters`, `tcontentfeeds`, `tcontentfeeditems`, `tcontentfeedadvancedparams`, `tfiles`, `tcontentfilemetadata`, `tcontentfilenamearchive`, `tcontentsourcemaps`, `tcontentremotepointer`, `tcontentvariationtargeting`, `tcontentdisplaytitleapprovals`, `tcontentpublicsubmissionapprovals`, `tformresponsepackets`, `tformresponsequestions`; the `baseTable = 'tcontent'` shares of `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets`, `tclassextenddata`; its `ttrash` share | Schema `content`, 30 units | 1 |
| strategies-content (approvals and change sets) | `tapprovalchains`, `tapprovalmemberships`, `tapprovalassignments`, `tapprovalrequests`, `tapprovalactions`, `tchangesets`, `tchangesetrollback`, `tchangesetcategoryassign`, `tchangesettagassign` | Schema `content`, 9 units | 1; `tapprovalmemberships` links chains to approving groups, which is workflow configuration, so step 2 does not apply |
| communications | `temails`, `temailstats`, `temailreturnstats`, `tmailinglist`, `tmailinglistmembers`; its `ttrash` share | Schema `communications`, 6 units | 1 |
| reporting | `tsessiontracking` | Schema `reporting`, 1 unit | 1 |
| retired | `tglobals` (dropped by `core/mura/dbUpdates/5.7.cfm:136`); `testoption`, `testwidget` (created only by the TestBox entities spec) | None; nothing migrates | — |
| decision list | `tplugins`, `tpluginsettings`, `tpluginscripts`, `tplugindisplayobjects`, `tclusterpeers`, `tclustercommands`, `tentity`, `tentity-declared:*`, `tremotepointer`, `trazunasettings`, `tcontenteventreminders`, `fb_*` ([decision-list.md](decision-list.md)) | None until approved | 5 |
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
| `tclassextenddata` | By the `baseTable` of the attribute's subtype, through `attributeID` → `tclassextendattributes.extendSetID` → `tclassextendsets.subTypeID` → `tclassextend.baseTable`. `tcontent` to strategies-content, `tsettings` to programs-sites, `tusers` and `tusersaddresses` to people; any other `baseTable` to the owner this map gives that table, and an unmapped one fails `services/*/test/unit/mapping.test.ts` |
| `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets` | By `baseTable`, with the same owners: `tclassextend` directly, `tclassextendsets` and `tclassextendrcsets` through `subTypeID`, `tclassextendattributes` through `extendSetID` → `subTypeID` |
| `ttrash` | By `objectClass` (`core/mura/trash/trashManager.cfc:175-176`): `content`, `feed`, `category`, `changeset` to strategies-content; `mailinglist`, `email` to communications; `group` to identity; `user` by its stored `Type` (1 identity, 2 people); `address` by its owning user's `Type`; `extendObject` by `baseTable` as above; an ORM entity name to the owner of the entity's table, which only dynamic decision-list entities reach, so those rows stay on legacy. An unmapped class fails `services/*/test/unit/mapping.test.ts` |

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
| identity | `identity.extend_data_user_activity` | `tclassextenddatauseractivity` |
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
| communications | `communications.delivery_status` | `synthetic.delivery_status` |
| communications | `communications.email` | `temails` |
| communications | `communications.email_return_stat` | `temailreturnstats` |
| communications | `communications.email_stat` | `temailstats` |
| communications | `communications.mailing_list` | `tmailinglist` |
| communications | `communications.mailing_list_member` | `tmailinglistmembers` |
| communications | `communications.message` | `synthetic.message` |
| communications | `communications.message_template` | `synthetic.message_template` |
| communications | `communications.trash` | `ttrash` |
| reporting | `reporting.export_definition` | `synthetic.export_definition` |
| reporting | `reporting.export_job` | `synthetic.export_job` |
| reporting | `reporting.session_tracking` | `tsessiontracking` |
| surveys | `surveys.survey` | `synthetic.survey` |
| surveys | `surveys.survey_reminder` | `synthetic.survey_reminder` |
| surveys | `surveys.survey_response` | `synthetic.survey_response` |
| surveys | `surveys.survey_schedule` | `synthetic.survey_schedule` |
| surveys | `surveys.survey_target` | `synthetic.survey_target` |
| timesheets | `timesheets.approval_action` | `Program_N.approval_action` |
| timesheets | `timesheets.blackout` | `Program_N.blackout` |
| timesheets | `timesheets.timesheet` | `Program_N.timesheet` |
| timesheets | `timesheets.timesheet_day` | `Program_N.timesheet_day` |
| finance | `finance.attachment` | `Program_N.finance_attachment` |
| finance | `finance.record` | `Program_N.finance_record` |
| finance | `finance.record_version` | `Program_N.finance_record_version` |
| finance | `finance.rollup` | `Program_N.finance_rollup` |
| e-signature | `esignature.audit_entry` | `synthetic.audit_entry` |
| e-signature | `esignature.signature` | `synthetic.signature` |
| e-signature | `esignature.signature_request` | `synthetic.signature_request` |

## Fixture tables

`Program_N` stands for `Program_1` and `Program_2`, which hold the same table set; each row folds into one target table with a `legacy_program_id` column, and its tenant is `tenantIdForSite` of the site that `synthetic.program_site` maps the schema to.

| Fixture table | Target | Note |
|---|---|---|
| `Program_N.timesheet` | `timesheets.timesheet` | Program fold |
| `Program_N.timesheet_day` | `timesheets.timesheet_day` | Program fold |
| `Program_N.approval_action` | `timesheets.approval_action` | Program fold |
| `Program_N.blackout` | `timesheets.blackout` | Program fold |
| `Program_N.finance_record` | `finance.record` | Program fold |
| `Program_N.finance_record_version` | `finance.record_version` | Program fold |
| `Program_N.finance_attachment` | `finance.attachment` | Program fold; the content bytes become objects in bucket `finance-attachments`, and the row keeps the object key |
| `Program_N.finance_rollup` | `finance.rollup` | Program fold |
| `synthetic.person_archive` | `people.person_archive` | Tenant from `siteID` |
| `synthetic.survey` | `surveys.survey` | Tenant from `siteID` |
| `synthetic.survey_schedule` | `surveys.survey_schedule` | Tenant of its `synthetic.survey` |
| `synthetic.survey_reminder` | `surveys.survey_reminder` | Tenant of its `synthetic.survey` |
| `synthetic.survey_target` | `surveys.survey_target` | Tenant of its `synthetic.survey`; `siteID` names the targeted site |
| `synthetic.survey_response` | `surveys.survey_response` | Tenant from `siteID`, the survey's site; `respondentSiteID` is the respondent's site, matching the survey-response tenant grant |
| `synthetic.export_definition` | `reporting.export_definition` | Tenant from `siteID` |
| `synthetic.export_job` | `reporting.export_job` | Tenant from `siteID` |
| `synthetic.message_template` | `communications.message_template` | Tenant from `siteID` |
| `synthetic.message` | `communications.message` | Tenant from `siteID` |
| `synthetic.delivery_status` | `communications.delivery_status` | Tenant of its `synthetic.message` |
| `synthetic.signature_request` | `esignature.signature_request` | Tenant from `siteID` |
| `synthetic.signature` | `esignature.signature` | Tenant of its `synthetic.signature_request` |
| `synthetic.audit_entry` | `esignature.audit_entry` | Tenant of its `synthetic.signature_request` |
| `synthetic.program_site` | None (owner programs-sites) | Not migrated; the fold mapping that `platform/src/migration-kit` reads |
| `synthetic.finance_transition` | None (owner finance) | Not migrated; loaded from `opt2/reports/state-machines/finance.json` |
| `synthetic.timesheet_transition` | None (owner timesheets) | Not migrated; loaded from `opt2/reports/state-machines/timesheets.json` |
| `synthetic.transition_rule` | None (owner timesheets) | Not migrated; holds the timesheets blackout rule from `opt2/reports/state-machines/timesheets.json` |
