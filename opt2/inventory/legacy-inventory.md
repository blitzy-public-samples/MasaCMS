# Legacy inventory (Masa CMS 7.6.1)
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Extracted from: git archive 696383140578f8dea3ece26f80cd7bfb370ddf0f · generator: harness/src/inventory/generate.ts · live fields: live

## Counts

| Section | Item | Count |
| --- | --- | --- |
| entities | orm-base | 4 |
| entities | orm-concrete | 24 |
| entities | not-entity | 1 |
| entities | domain-bean | 35 |
| entities | dynamic | 1 |
| entities | dynamicPatterns | 3 |
| ormTables | concrete | 24 |
| ormTables | ormOnly | 21 |
| services | registeredSingletons | 122 |
| services | serviceList | 26 |
| services | transient | 86 |
| services | aliases | 59 |
| services | declaredBeans | 11 |
| controllers | circuits | 25 |
| controllers | base | 1 |
| controllers | actions | 222 |
| controllers | viewOnlyActions | 77 |
| controllers | variants | 251 |
| coreMuraActionFiles | — | 21 |
| frontEnd | — | 27 |
| unreachableRemote | — | 38 |
| scheduledJobs | jobs | 1 |
| scheduledJobs | siteMonitorSteps | 8 |
| routes | families | 13 |
| routes | apiEntityMethods | 456 |
| routes | apiMethods | 36 |
| routes | oauth | 9 |
| routes | soap | 7 |
| routes | fixture | 50 |
| tables | bootstrap | 41 |
| tables | bootstrapAfterDrops | 40 |
| tables | migrationCreated | 12 |
| tables | ormOnly | 21 |
| tables | staticTotal | 73 |
| tables | retired | 1 |
| tables | withSiteIdStatic | 55 |
| tables | withoutPrimaryKeyBootstrap | 10 |
| tables | fixture | 26 |
| tables | live | 72 |
| tables | withSiteIdLive | 54 |
| tables | dynamic | 0 |
| tables | liveOnly | 0 |
| tables | withoutPrimaryKey | 7 |
| relations | daoJoin | 49 |
| relations | fixtureFk | 15 |
| relations | ormFk | 72 |
| relations | programFold | 8 |
| relations | relations | 147 |
| relations | relationsDropped | 0 |
| relations | tenantParent | 3 |
| relations | unknownOrientation | 21 |
| storedProcedures | static | 0 |
| storedProcedures | live | 0 |
| storedProcedures | foreignKeys | 0 |
| dispositions | carry | 809 |
| dispositions | legacy-served | 150 |
| dispositions | decision | 170 |
| dispositions | retired | 56 |

## Admin controllers

| Id | Route key | Owner | Disposition (step) | CSRF | Response mode |
| --- | --- | --- | --- | --- | --- |
| `ctl:carch.approvalaction{action=approve}` | `admin:carch.approvalaction{action=approve}` | strategies-content | decision (2, withheld) (corrected; expected carry) | bypassed `approvalaction` | json (application/json) |
| `ctl:carch.approvalaction` | `admin:carch.approvalaction` | strategies-content | carry (5) | bypassed `approvalaction` | json (application/json) |
| `ctl:carch.assocfiles` | `admin:carch.assocfiles` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.audit` | `admin:carch.audit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.availablechangesets` | `admin:carch.availablechangesets` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.copy` | `admin:carch.copy` | strategies-content | decision (2, withheld) (corrected; expected carry) | none | json (text/html) |
| `ctl:carch.cropimage` | `admin:carch.cropimage` | strategies-content | carry (5, legacy-write) `EX-FILE-RENDITION` | validates `rc.fileid` | page (text/html) |
| `ctl:carch.datamanager` | `admin:carch.datamanager` | strategies-content | carry (5, legacy-write) `EX-DATAMANAGER-STORED-PACKET` | validates `rc.responseid` | page (text/html) |
| `ctl:carch.displayobjectmodal` | `admin:carch.displayobjectmodal` | strategies-content | legacy-served (4) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.downloaddata` | `admin:carch.downloaddata` | strategies-content | carry (5) | none | download (application/msexcel) |
| `ctl:carch.draft` | `admin:carch.draft` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.draftpromptdata` | `admin:carch.draftpromptdata` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.edit` | `admin:carch.edit` | strategies-content | carry (5, legacy-write) `EX-CARCH-EDIT-FORM` | none | page (text/html) |
| `ctl:carch.editlive` | `admin:carch.editlive` | strategies-content | carry (5) | none | redirect |
| `ctl:carch.edittext` | `admin:carch.edittext` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.emailtest` | `admin:carch.emailtest` | communications | legacy-served (4) | validates `testEmail` | fragment (text/html) |
| `ctl:carch.export` | `admin:carch.export` | strategies-content | legacy-served (4) | none | page (text/html) |
| `ctl:carch.exportcomponent` | `admin:carch.exportcomponent` | strategies-content | legacy-served (4) | none | download (application/zip) |
| `ctl:carch.exportcontent` | `admin:carch.exportcontent` | strategies-content | legacy-served (4) | none | redirect |
| `ctl:carch.flipimage` | `admin:carch.flipimage` | strategies-content | carry (5, legacy-write) `EX-FILE-RENDITION` | validates `rc.fileid` | page (text/html) |
| `ctl:carch.frontendconfigurator` | `admin:carch.frontendconfigurator` | strategies-content | legacy-served (4) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.getaudittrail` | `admin:carch.getaudittrail` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.getimagesizeurl` | `admin:carch.getimagesizeurl` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.hist` | `admin:carch.hist` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.imagedetails` | `admin:carch.imagedetails` | strategies-content | carry (5, legacy-write) `EX-CARCH-IMAGE-SIZES` | none | page (text/html) |
| `ctl:carch.import` | `admin:carch.import` | strategies-content | legacy-served (4) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.importcomponent` | `admin:carch.importcomponent` | strategies-content | legacy-served (4) | none | redirect |
| `ctl:carch.importcontent` | `admin:carch.importcontent` | strategies-content | decision (2, withheld) (corrected; expected legacy-served) | validates `rc.contentid` | redirect |
| `ctl:carch.list{sharedid}` | `admin:carch.list{sharedid}` | strategies-content | carry (5, legacy-write) `EX-CARCH-SORT-SHARED-ID` | none | page (text/html) |
| `ctl:carch.list` | `admin:carch.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.loadcategoryassignment` | `admin:carch.loadcategoryassignment` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadcategoryfeaturestartstop` | `admin:carch.loadcategoryfeaturestartstop` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadclass` | `admin:carch.loadclass` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadclassconfigurator` | `admin:carch.loadclassconfigurator` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loaddiff` | `admin:carch.loaddiff` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadexpirenotify` | `admin:carch.loadexpirenotify` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadextendedattributes` | `admin:carch.loadextendedattributes` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.loadfilemetadata` | `admin:carch.loadfilemetadata` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadnewcontentmenu` | `admin:carch.loadnewcontentmenu` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadnotify` | `admin:carch.loadnotify` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadquickedit` | `admin:carch.loadquickedit` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadrelatedcontent` | `admin:carch.loadrelatedcontent` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadrepomanager` | `admin:carch.loadrepomanager` | strategies-content | legacy-served (4) (corrected; expected carry) | none | redirect |
| `ctl:carch.loadselectedrelatedcontent` | `admin:carch.loadselectedrelatedcontent` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadsiteflat` | `admin:carch.loadsiteflat` | strategies-content | carry (5) `EX-CONTENT-FEED-UNORDERED-SORT` | none | fragment (text/html) |
| `ctl:carch.loadsitemanager` | `admin:carch.loadsitemanager` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.loadsitesection` | `admin:carch.loadsitesection` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.loadtagarray` | `admin:carch.loadtagarray` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.lockcheck` | `admin:carch.lockcheck` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.lockfile` | `admin:carch.lockfile` | strategies-content | carry (5) | validates `rc.contentid & "lockfile"` | json (text/html) |
| `ctl:carch.multifileupload{upload=image}` | `admin:carch.multifileupload{upload=image}` | strategies-content | carry (5) `EX-FILE-RENDITION` | none | page (text/html) |
| `ctl:carch.multifileupload` | `admin:carch.multifileupload` | strategies-content | carry (5) `EX-CARCH-UPLOAD-PAGELIMIT` | none | page (text/html) |
| `ctl:carch.refreshsitesection` | `admin:carch.refreshsitesection` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.relatedcontent` | `admin:carch.relatedcontent` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.rotateimage` | `admin:carch.rotateimage` | strategies-content | carry (5, legacy-write) `EX-FILE-RENDITION` | validates `rc.fileid` | page (text/html) |
| `ctl:carch.savecopyinfo` | `admin:carch.savecopyinfo` | strategies-content | carry (5) | none | json (text/html) |
| `ctl:carch.savequickedit` | `admin:carch.savequickedit` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `rc.contentid & "quickedit"` | json (text/html) |
| `ctl:carch.scaffold` | `admin:carch.scaffold` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.search` | `admin:carch.search` | strategies-content | carry (5) `EX-CARCH-SEARCH-SITE` | none | page (text/html) |
| `ctl:carch.selectfields` | `admin:carch.selectfields` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.selectmedia` | `admin:carch.selectmedia` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.sitemanagertab` | `admin:carch.sitemanagertab` | strategies-content | carry (5) | none | json (text/html) |
| `ctl:carch.siteparents` | `admin:carch.siteparents` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.statusmodal` | `admin:carch.statusmodal` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.unlockfile` | `admin:carch.unlockfile` | strategies-content | carry (5) | validates `rc.contentid & "unlockfile"` | json (text/html) |
| `ctl:carch.unlocknode` | `admin:carch.unlocknode` | strategies-content | carry (5) | validates `rc.contentid & "unlocknode"` | json (text/html) |
| `ctl:carch.update{upload=image}` | `admin:carch.update{upload=image}` | strategies-content | decision (2, withheld, legacy-write) (corrected; expected carry) `EX-FILE-RENDITION` | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.update{approved=1}` | `admin:carch.update{approved=1}` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.update{notify}` | `admin:carch.update{notify}` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.update` | `admin:carch.update` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.updateobjectparams{approved=1}` | `admin:carch.updateobjectparams{approved=1}` | strategies-content | decision (2, withheld) (corrected; expected carry) | none | json (text/html) |
| `ctl:carch.updateobjectparams` | `admin:carch.updateobjectparams` | strategies-content | decision (2, withheld) (corrected; expected carry) | none | json (text/html) |
| `ctl:carch.variationtargeting{notify}` | `admin:carch.variationtargeting{notify}` | strategies-content | decision (2, withheld) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.variationtargeting` | `admin:carch.variationtargeting` | strategies-content | decision (2, withheld) (corrected; expected carry) | none | page (text/html) |
| `ctl:ccategory.edit` | `admin:ccategory.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:ccategory.list` | `admin:ccategory.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:ccategory.update` | `admin:ccategory.update` | strategies-content | carry (5) | validates `rc.categoryid` | page (text/html) |
| `ctl:cchain.delete` | `admin:cchain.delete` | strategies-content | carry (5) | validates `rc.chainid` | redirect |
| `ctl:cchain.edit` | `admin:cchain.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchain.list` | `admin:cchain.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchain.pending` | `admin:cchain.pending` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchain.save` | `admin:cchain.save` | strategies-content | carry (5, legacy-write) `EX-CCHAIN-SAVE-UNSCOPED-BEAN` | validates `rc.chainid` | redirect |
| `ctl:cchain.update` | `admin:cchain.update` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.assignments` | `admin:cchangesets.assignments` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.delete` | `admin:cchangesets.delete` | strategies-content | carry (5) | validates `rc.changesetid` | redirect |
| `ctl:cchangesets.edit` | `admin:cchangesets.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.list` | `admin:cchangesets.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.loadtagarray` | `admin:cchangesets.loadtagarray` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cchangesets.publish` | `admin:cchangesets.publish` | strategies-content | decision (2, withheld) (corrected; expected carry) | none | redirect |
| `ctl:cchangesets.removeitem` | `admin:cchangesets.removeitem` | strategies-content | carry (5) | validates `rc.changesetid` | redirect |
| `ctl:cchangesets.rollback` | `admin:cchangesets.rollback` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `rc.changesetid` | redirect |
| `ctl:cchangesets.save` | `admin:cchangesets.save` | strategies-content | carry (5) | validates `rc.changesetid` | page (text/html) |
| `ctl:ccomments.ajax` | `admin:ccomments.ajax` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:ccomments.approve` | `admin:ccomments.approve` | strategies-content | carry (5) | none | redirect |
| `ctl:ccomments.bulkedit` | `admin:ccomments.bulkedit` | strategies-content | carry (5) | none | redirect |
| `ctl:ccomments.default` | `admin:ccomments.default` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:ccomments.delete` | `admin:ccomments.delete` | strategies-content | carry (5) | none | redirect |
| `ctl:ccomments.loadcomments` | `admin:ccomments.loadcomments` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:ccomments.loadcommentspage` | `admin:ccomments.loadcommentspage` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:ccomments.markasspam` | `admin:ccomments.markasspam` | strategies-content | carry (5) | none | redirect |
| `ctl:ccomments.purgedeletedcomments` | `admin:ccomments.purgedeletedcomments` | strategies-content | carry (5) | none | redirect |
| `ctl:ccomments.singleedit` | `admin:ccomments.singleedit` | strategies-content | carry (5) | none | redirect |
| `ctl:ccomments.unapprove` | `admin:ccomments.unapprove` | strategies-content | carry (5) | none | redirect |
| `ctl:cdashboard.dismissalert` | `admin:cdashboard.dismissalert` | reporting | legacy-served (4) | none | json (text/html) |
| `ctl:cdashboard.listsessions` | `admin:cdashboard.listsessions` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.loademailactivity` | `admin:cdashboard.loademailactivity` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.loadformactivity` | `admin:cdashboard.loadformactivity` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.loadpopularcontent` | `admin:cdashboard.loadpopularcontent` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.loadrecentcomments` | `admin:cdashboard.loadrecentcomments` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.loaduseractivity` | `admin:cdashboard.loaduseractivity` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.main` | `admin:cdashboard.main` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.recentcomments` | `admin:cdashboard.recentcomments` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.sessionsearch` | `admin:cdashboard.sessionsearch` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.topcontent` | `admin:cdashboard.topcontent` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.toprated` | `admin:cdashboard.toprated` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.topreferers` | `admin:cdashboard.topreferers` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.topsearches` | `admin:cdashboard.topsearches` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:cdashboard.viewsession` | `admin:cdashboard.viewsession` | reporting | legacy-served (4) | none | page (text/html) |
| `ctl:ceditprofile.edit` | `admin:ceditprofile.edit` | people | carry (5) | none | page (text/html) |
| `ctl:ceditprofile.update{photo}` | `admin:ceditprofile.update{photo}` | spans identity, people, strategies-content | decision (3, withheld) | validates | page (text/html) |
| `ctl:ceditprofile.update{extdata}` | `admin:ceditprofile.update{extdata}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates | page (text/html) |
| `ctl:ceditprofile.update` | `admin:ceditprofile.update` | people | carry (5, legacy-write) `EX-ROSTER-POOLMOVE` | validates | page (text/html) |
| `ctl:cemail.deletebounces` | `admin:cemail.deletebounces` | communications | legacy-served (4) | none | redirect |
| `ctl:cemail.download` | `admin:cemail.download` | communications | legacy-served (4) | none | download (application/msexcel) |
| `ctl:cemail.edit` | `admin:cemail.edit` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.list` | `admin:cemail.list` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.showallbounces` | `admin:cemail.showallbounces` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.showbounces` | `admin:cemail.showbounces` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.showreturns` | `admin:cemail.showreturns` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.sitelist` | `admin:cemail.sitelist` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.update` | `admin:cemail.update` | communications | legacy-served (4) | none | redirect |
| `ctl:cextend.download` | `admin:cextend.download` | — | decision (3, withheld) | none | download (application/xml) |
| `ctl:cextend.editattributes` | `admin:cextend.editattributes` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.editrelatedcontentset` | `admin:cextend.editrelatedcontentset` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.editset` | `admin:cextend.editset` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.editsubtype` | `admin:cextend.editsubtype` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.export` | `admin:cextend.export` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.exportsubtype` | `admin:cextend.exportsubtype` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.importsubtypes` | `admin:cextend.importsubtypes` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (2, withheld) | validates `import` | redirect |
| `ctl:cextend.listsets` | `admin:cextend.listsets` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.listsubtypes` | `admin:cextend.listsubtypes` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:cextend.saveattributesort` | `admin:cextend.saveattributesort` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (3, withheld) | none | json (text/html) |
| `ctl:cextend.saveextendsetsort` | `admin:cextend.saveextendsetsort` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (3, withheld) | none | json (text/html) |
| `ctl:cextend.saverelatedsetsort` | `admin:cextend.saverelatedsetsort` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (3, withheld) | none | json (text/html) |
| `ctl:cextend.updateattribute` | `admin:cextend.updateattribute` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (3, withheld) | validates `rc.attributeid` | redirect |
| `ctl:cextend.updaterelatedcontentset` | `admin:cextend.updaterelatedcontentset` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (3, withheld) | validates `rc.relatedContentSetID` | redirect |
| `ctl:cextend.updateset` | `admin:cextend.updateset` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (3, withheld) | validates `rc.extendsetid` | redirect |
| `ctl:cextend.updatesubtype` | `admin:cextend.updatesubtype` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (3, withheld) | validates `rc.subtypeid` | redirect |
| `ctl:cfeed.edit` | `admin:cfeed.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cfeed.import1` | `admin:cfeed.import1` | strategies-content | carry (5) `EX-FEED-REMOTE-OVERSIZE` | none | page (text/html) |
| `ctl:cfeed.import2` | `admin:cfeed.import2` | strategies-content | decision (2, withheld) (corrected; expected carry) | none | page (text/html) |
| `ctl:cfeed.list` | `admin:cfeed.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cfeed.loadsite` | `admin:cfeed.loadsite` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cfeed.siteparents` | `admin:cfeed.siteparents` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cfeed.update{closecompactdisplay=true}` | `admin:cfeed.update{closecompactdisplay=true}` | strategies-content | carry (5, legacy-write) `EX-FEED-COMPACT-CLOSE` | validates `rc.feedid` | fragment (text/html) |
| `ctl:cfeed.update` | `admin:cfeed.update` | strategies-content | carry (5) | validates `rc.feedid` | fragment (text/html) |
| `ctl:cfilemanager.default` | `admin:cfilemanager.default` | strategies-content | legacy-served (4) | none | page (text/html) |
| `ctl:cform.export` | `admin:cform.export` | strategies-content | carry (5) | none | download (application/zip) |
| `ctl:cform.getdataset` | `admin:cform.getdataset` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.getdialog` | `admin:cform.getdialog` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cform.getfield` | `admin:cform.getfield` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.getfieldtemplate` | `admin:cform.getfieldtemplate` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cform.getfieldtype` | `admin:cform.getfieldtype` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.getform` | `admin:cform.getform` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.importform{formzip}` | `admin:cform.importform{formzip}` | strategies-content | carry (5, legacy-write) `EX-FORM-IMPORT` | validates `formimport` | redirect |
| `ctl:cform.importform` | `admin:cform.importform` | strategies-content | carry (5) | validates `formimport` | redirect |
| `ctl:clogin.login{status=sendlogin}` | `admin:clogin.login{status=sendlogin}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `login` | page (text/html) |
| `ctl:clogin.login` | `admin:clogin.login` | identity | carry (5) | validates `login` | page (text/html) |
| `ctl:clogin.logout` | `admin:clogin.logout` | identity | carry (5) | none | redirect |
| `ctl:clogin.main{status=sendlogin}` | `admin:clogin.main{status=sendlogin}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | none | page (text/html) |
| `ctl:clogin.main` | `admin:clogin.main` | identity | carry (5) | none | page (text/html) |
| `ctl:cmailinglist.download` | `admin:cmailinglist.download` | communications | legacy-served (4) | none | download (text/plain) |
| `ctl:cmailinglist.edit` | `admin:cmailinglist.edit` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cmailinglist.list` | `admin:cmailinglist.list` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cmailinglist.listmembers` | `admin:cmailinglist.listmembers` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cmailinglist.update` | `admin:cmailinglist.update` | communications | legacy-served (4) | none | redirect |
| `ctl:cmailinglist.updatemember` | `admin:cmailinglist.updatemember` | communications | legacy-served (4) | none | redirect |
| `ctl:cmessage.noaccess` | `admin:cmessage.noaccess` | identity | carry (5) | none | page (text/html) |
| `ctl:cnav.searchsitedata` | `admin:cnav.searchsitedata` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:controller` | — | — | — | — | — |
| `ctl:cperm.main` | `admin:cperm.main` | identity | carry (5) | none | page (text/html) |
| `ctl:cperm.module` | `admin:cperm.module` | identity | carry (5) | none | page (text/html) |
| `ctl:cperm.update` | `admin:cperm.update` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `rc.contentid` | redirect |
| `ctl:cperm.updatemodule` | `admin:cperm.updatemodule` | identity | carry (5) | validates `rc.moduleid` | redirect |
| `ctl:cplugins.list` | `admin:cplugins.list` | — | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.createbundle` | `admin:csettings.createbundle` | strategies-content | legacy-served (4) | validates `csrfContext` | page (text/html) |
| `ctl:csettings.deleteplugin` | `admin:csettings.deleteplugin` | spans strategies-content | decision (2, withheld) (corrected; expected legacy-served) | validates `rc.moduleid` | redirect |
| `ctl:csettings.deploybundle` | `admin:csettings.deploybundle` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.deployplugin` | `admin:csettings.deployplugin` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (2, withheld) (corrected; expected legacy-served) | validates `rc.moduleid \| newplugin` | redirect |
| `ctl:csettings.editplugin` | `admin:csettings.editplugin` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.editsite` | `admin:csettings.editsite` | programs-sites | carry (5) | none | page (text/html) |
| `ctl:csettings.exporthtml` | `admin:csettings.exporthtml` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.list` | `admin:csettings.list` | programs-sites | carry (5) | validates `updatesites \| updatecore` | page (text/html) |
| `ctl:csettings.loadcustomimage` | `admin:csettings.loadcustomimage` | programs-sites | carry (5) | none | fragment (text/html) |
| `ctl:csettings.loadcustomimages` | `admin:csettings.loadcustomimages` | programs-sites | carry (5) | none | fragment (text/html) |
| `ctl:csettings.selectbundleoptions` | `admin:csettings.selectbundleoptions` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.sitecopy` | `admin:csettings.sitecopy` | programs-sites | decision (2, withheld) | validates `sitecopy` | redirect |
| `ctl:csettings.sitecopyresult` | `admin:csettings.sitecopyresult` | programs-sites | carry (5) | none | page (text/html) |
| `ctl:csettings.sitecopyselect` | `admin:csettings.sitecopyselect` | programs-sites | decision (3, withheld) | none | page (text/html) |
| `ctl:csettings.updateplugin` | `admin:csettings.updateplugin` | spans programs-sites, strategies-content | decision (2, withheld) (corrected; expected legacy-served) | validates `rc.moduleid` | redirect |
| `ctl:csettings.updatepluginversion` | `admin:csettings.updatepluginversion` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.updatesite{bundle}` | `admin:csettings.updatesite{bundle}` | programs-sites | decision (2, withheld) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite{action=add}` | `admin:csettings.updatesite{action=add}` | programs-sites | decision (2, withheld) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite{action=delete}` | `admin:csettings.updatesite{action=delete}` | programs-sites | decision (2, withheld) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite{action=update}` | `admin:csettings.updatesite{action=update}` | programs-sites | decision (2, withheld) (corrected; expected carry) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite` | `admin:csettings.updatesite` | programs-sites | carry (5) | validates `"" \| rc.siteID` | redirect |
| `ctl:ctrash.detail` | `admin:ctrash.detail` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:ctrash.empty` | `admin:ctrash.empty` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (2, withheld) | validates `'emptytrash' & rc.siteID` | redirect |
| `ctl:ctrash.list` | `admin:ctrash.list` | — | decision (3, withheld) | none | page (text/html) |
| `ctl:ctrash.restore` | `admin:ctrash.restore` | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (2, withheld) | validates `'restore' & rc.objectID` | redirect |
| `ctl:cusers.addtogroup` | `admin:cusers.addtogroup` | identity | carry (5, legacy-write) `EX-SEC-GROUP-SITE` | validates `rc.userid & rc.groupid & 'addtogroup'` | redirect |
| `ctl:cusers.advancedsearch` | `admin:cusers.advancedsearch` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.advancedsearchtocsv` | `admin:cusers.advancedsearchtocsv` | people | carry (5) | none | redirect |
| `ctl:cusers.default` | `admin:cusers.default` | people | carry (5) | none | redirect |
| `ctl:cusers.download` | `admin:cusers.download` | people | carry (5) | none | download (text/csv) |
| `ctl:cusers.downloadgroupmembers` | `admin:cusers.downloadgroupmembers` | identity | carry (5) `EX-SEC-GROUP-SITE` | none | redirect |
| `ctl:cusers.editaddress` | `admin:cusers.editaddress` | people | carry (5) `EX-USER-EDIT-SITE` | none | page (text/html) |
| `ctl:cusers.editgroup` | `admin:cusers.editgroup` | identity | carry (5) `EX-SEC-GROUP-SITE` | none | page (text/html) |
| `ctl:cusers.editgroupmembers` | `admin:cusers.editgroupmembers` | identity | carry (5) `EX-SEC-GROUP-SITE` | none | page (text/html) |
| `ctl:cusers.edituser` | `admin:cusers.edituser` | identity | carry (5, legacy-write) (corrected; expected carry) `EX-USER-EDIT-SITE` | none | page (text/html) |
| `ctl:cusers.list` | `admin:cusers.list` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.listusers` | `admin:cusers.listusers` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.loadextendedattributes` | `admin:cusers.loadextendedattributes` | people | carry (5) | none | fragment (text/html) |
| `ctl:cusers.removefromgroup` | `admin:cusers.removefromgroup` | identity | carry (5, legacy-write) `EX-SEC-GROUP-SITE` | none | redirect |
| `ctl:cusers.route` | `admin:cusers.route` | people | carry (5) | none | redirect |
| `ctl:cusers.search` | `admin:cusers.search` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.update{photo}` | `admin:cusers.update{photo}` | spans identity, people, strategies-content | decision (3, withheld) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=add,extdata}` | `admin:cusers.update{type=2,action=add,extdata}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=update,extdata}` | `admin:cusers.update{type=2,action=update,extdata}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=1,action=delete}` | `admin:cusers.update{type=1,action=delete}` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=1,extdata}` | `admin:cusers.update{type=1,extdata}` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=add}` | `admin:cusers.update{type=2,action=add}` | people | carry (5) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=delete}` | `admin:cusers.update{type=2,action=delete}` | spans identity, people, strategies-content | decision (3, withheld) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=update}` | `admin:cusers.update{type=2,action=update}` | people | carry (5, legacy-write) `EX-ROSTER-POOLMOVE` | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=1}` | `admin:cusers.update{type=1}` | identity | carry (5) | validates `rc.userid` | redirect |
| `ctl:cusers.update` | `admin:cusers.update` | spans identity, people, strategies-content | decision (3, withheld) | validates `rc.userid` | redirect |
| `ctl:cusers.updateaddress{action=delete}` | `admin:cusers.updateaddress{action=delete}` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `'updateaddress' & rc.userid` | redirect |
| `ctl:cusers.updateaddress{extdata}` | `admin:cusers.updateaddress{extdata}` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `'updateaddress' & rc.userid` | redirect |
| `ctl:cusers.updateaddress` | `admin:cusers.updateaddress` | people | carry (5) | validates `'updateaddress' & rc.userid` | redirect |
| `ctl:cwebservice.delete` | `admin:cwebservice.delete` | identity | carry (5) | validates `rc.clientid` | redirect |
| `ctl:cwebservice.edit` | `admin:cwebservice.edit` | identity | carry (5) `EX-USER-FEED-TIE-ORDER` | none | page (text/html) |
| `ctl:cwebservice.list` | `admin:cwebservice.list` | identity | carry (5) | none | page (text/html) |
| `ctl:cwebservice.save` | `admin:cwebservice.save` | identity | carry (5, legacy-write) `EX-USER-FEED-TIE-ORDER` | validates `rc.clientid` | page (text/html) |
| `ctl:home.redirect` | `admin:home.redirect` | identity | carry (5) | none | redirect |
| `ctl:razuna.default` | `admin:razuna.default` | strategies-content | legacy-served (4) | none | fragment (text/html) |
| `ctl:razuna.getnodes` | `admin:razuna.getnodes` | strategies-content | legacy-served (4) | none | fragment (text/html) |
| `ctl:razuna.selectnode` | `admin:razuna.selectnode` | strategies-content | legacy-served (4) | none | fragment (text/html) |
| `ctl:razuna.settingsquerytostruct` | `admin:razuna.settingsquerytostruct` | strategies-content | legacy-served (4) | none | redirect |
| `ctl:razuna.structkeydefault` | `admin:razuna.structkeydefault` | strategies-content | legacy-served (4) | none | redirect |
| `ctl:scaffold.assembler` | `admin:scaffold.assembler` | — | legacy-served (4) | none | page (text/html) |
| `ctl:scaffold.sites` | `admin:scaffold.sites` | — | legacy-served (4) | none | page (text/html) |
| `ctl:scaffold.updatesites` | `admin:scaffold.updatesites` | — | legacy-served (4) | none | redirect |

Search for `muraAction` in `core/** excluding core/vendor`: 0 handlers; 21 files mention it (builds-admin-url 20, reads-admin-action 1); admin dispatch at `admin/Application.cfc:151-166`.

## Route families

| Id | Route key | Owner | Disposition (step) | CSRF | Notes |
| --- | --- | --- | --- | --- | --- |
| `rte:/_api/ajax/v1` | — | — | carry (5) | — | — |
| `rte:/_api/asset/render` | `asset:render` | strategies-content | legacy-served (4) | none | — |
| `rte:/_api/asset/upload` | `asset:upload` | strategies-content | legacy-served (4) | none | — |
| `rte:/_api/email/trackopen` | `trackopen:open` | communications | legacy-served (4) | none | — |
| `rte:/_api/feed/v1` | `feed:v1` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `rte:/_api/json/v1` | — | — | carry (5) | — | — |
| `rte:/_api/render/file` | `render:file` | strategies-content | carry (5, legacy-write) | none | `EX-FILE-RENDITION` |
| `rte:/_api/render/medium` | `render:medium` | strategies-content | carry (5) | none | — |
| `rte:/_api/render/small` | `render:small` | strategies-content | carry (5) | none | — |
| `rte:/_api/resource/variation` | `variation:js` | strategies-content | legacy-served (4) (corrected; expected carry) | none | `EX-VARIATION-SCRIPT` |
| `rte:/_api/rest/v1` | — | — | carry (5) | — | — |
| `rte:/_api/sitemonitor` | `sitemonitor:run` | programs-sites | carry (5) | none | — |
| `rte:/tasks/widgets` | `widgets:redirect` | — | legacy-served (4) | none | — |

## JSON API entities and methods

| Id | Route key | Owner | Disposition (step) | CSRF | Notes |
| --- | --- | --- | --- | --- | --- |
| `api:address.delete` | `api:address.delete` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:address.delete` |
| `api:address.findall` | `api:address.findall` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `api:address.findmany` | `api:address.findmany` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `api:address.findnew` | `api:address.findnew` | people | carry (5) | none | — |
| `api:address.findone` | `api:address.findone` | people | carry (5) | none | `EX-USER-EDIT-SITE` |
| `api:address.findpermissions` | `api:address.findpermissions` | people | carry (5) | none | — |
| `api:address.findproperties` | `api:address.findproperties` | people | carry (5) | none | — |
| `api:address.findquery` | `api:address.findquery` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `api:address.save` | `api:address.save` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:address.save` |
| `api:address.save{extdata}` | `api:address.save{extdata}` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:address.save{extdata}` |
| `api:address.validate` | `api:address.validate` | people | carry (5) | none | — |
| `api:category.delete` | `api:category.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:category.findall` | `api:category.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:category.findcrumbarray` | `api:category.findcrumbarray` | strategies-content | carry (5) | none | — |
| `api:category.findmany` | `api:category.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:category.findnew` | `api:category.findnew` | strategies-content | carry (5) | none | — |
| `api:category.findone` | `api:category.findone` | strategies-content | carry (5) | none | `EX-SEC-CONTENT-ENTITY-SITE` |
| `api:category.findpermissions` | `api:category.findpermissions` | strategies-content | carry (5) | none | — |
| `api:category.findproperties` | `api:category.findproperties` | strategies-content | carry (5) | none | — |
| `api:category.findquery` | `api:category.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:category.save` | `api:category.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:category.validate` | `api:category.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:changeset.delete` | `api:changeset.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changeset.findall` | `api:changeset.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:changeset.findmany` | `api:changeset.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:changeset.findnew` | `api:changeset.findnew` | strategies-content | carry (5) | none | — |
| `api:changeset.findone` | `api:changeset.findone` | strategies-content | carry (5) | none | — |
| `api:changeset.findpermissions` | `api:changeset.findpermissions` | strategies-content | carry (5) | none | — |
| `api:changeset.findproperties` | `api:changeset.findproperties` | strategies-content | carry (5) | none | — |
| `api:changeset.findquery` | `api:changeset.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:changeset.save` | `api:changeset.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changeset.validate` | `api:changeset.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:changesetcategoryassignment.delete` | `api:changesetcategoryassignment.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changesetcategoryassignment.findall` | `api:changesetcategoryassignment.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:changesetcategoryassignment.findmany` | `api:changesetcategoryassignment.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:changesetcategoryassignment.findnew` | `api:changesetcategoryassignment.findnew` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findone` | `api:changesetcategoryassignment.findone` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findpermissions` | `api:changesetcategoryassignment.findpermissions` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findproperties` | `api:changesetcategoryassignment.findproperties` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findquery` | `api:changesetcategoryassignment.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:changesetcategoryassignment.save` | `api:changesetcategoryassignment.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changesetcategoryassignment.validate` | `api:changesetcategoryassignment.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:checkschema` | `api:checkschema` | — | decision (2, withheld) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#tentity-declared:*` |
| `api:comment.delete` | `api:comment.delete` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-COMMENT-REMOTE-SITE` |
| `api:comment.findall` | `api:comment.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:comment.findcrumbarray` | `api:comment.findcrumbarray` | strategies-content | carry (5) | none | — |
| `api:comment.findmany` | `api:comment.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:comment.findnew` | `api:comment.findnew` | strategies-content | carry (5) | none | — |
| `api:comment.findone` | `api:comment.findone` | strategies-content | carry (5) | none | `EX-SEC-CONTENT-ENTITY-SITE` |
| `api:comment.findpermissions` | `api:comment.findpermissions` | strategies-content | carry (5) | none | — |
| `api:comment.findproperties` | `api:comment.findproperties` | strategies-content | carry (5) | none | — |
| `api:comment.findquery` | `api:comment.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:comment.save` | `api:comment.save` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-COMMENT-REMOTE-SITE` |
| `api:comment.validate` | `api:comment.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:comment.~delete` | `api:comment.~delete` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `api:comment.~flag` | `api:comment.~flag` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `api:comment.~markasspam` | `api:comment.~markasspam` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `api:comment.~undelete` | `api:comment.~undelete` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `api:comment.~unmarkasspam` | `api:comment.~unmarkasspam` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `api:content.delete` | `api:content.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:content.findall` | `api:content.findall` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `api:content.findcrumbarray` | `api:content.findcrumbarray` | strategies-content | carry (5) | none | — |
| `api:content.findmany` | `api:content.findmany` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `api:content.findnew` | `api:content.findnew` | strategies-content | carry (5) | none | — |
| `api:content.findone` | `api:content.findone` | strategies-content | carry (5) | none | `EX-CONTENT-RENDER` |
| `api:content.findpermissions` | `api:content.findpermissions` | strategies-content | carry (5) | none | — |
| `api:content.findproperties` | `api:content.findproperties` | strategies-content | carry (5) | none | — |
| `api:content.findquery` | `api:content.findquery` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `api:content.findrelatedcontent` | `api:content.findrelatedcontent` | strategies-content | carry (5) | none | — |
| `api:content.findversionhistory` | `api:content.findversionhistory` | strategies-content | carry (5) | none | — |
| `api:content.save` | `api:content.save` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:content.save{approved=1}` | `api:content.save{approved=1}` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:content.save{notify}` | `api:content.save{notify}` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:content.validate` | `api:content.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:contentcategoryassign.delete` | `api:contentcategoryassign.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:contentcategoryassign.findall` | `api:contentcategoryassign.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:contentcategoryassign.findmany` | `api:contentcategoryassign.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:contentcategoryassign.findnew` | `api:contentcategoryassign.findnew` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findone` | `api:contentcategoryassign.findone` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findpermissions` | `api:contentcategoryassign.findpermissions` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findproperties` | `api:contentcategoryassign.findproperties` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findquery` | `api:contentcategoryassign.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:contentcategoryassign.save` | `api:contentcategoryassign.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:contentcategoryassign.validate` | `api:contentcategoryassign.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:contentnav.delete` | `api:contentnav.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:contentnav.findall` | `api:contentnav.findall` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `api:contentnav.findmany` | `api:contentnav.findmany` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `api:contentnav.findnew` | `api:contentnav.findnew` | strategies-content | carry (5) | none | — |
| `api:contentnav.findone` | `api:contentnav.findone` | strategies-content | carry (5) | none | — |
| `api:contentnav.findpermissions` | `api:contentnav.findpermissions` | strategies-content | carry (5) | none | — |
| `api:contentnav.findproperties` | `api:contentnav.findproperties` | strategies-content | carry (5) | none | — |
| `api:contentnav.findquery` | `api:contentnav.findquery` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `api:contentnav.save` | `api:contentnav.save` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:contentnav.save{approved=1}` | `api:contentnav.save{approved=1}` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:contentnav.save{notify}` | `api:contentnav.save{notify}` | strategies-content | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:contentnav.validate` | `api:contentnav.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:declareentity` | `api:declareentity` | — | decision (2, withheld) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#tentity` |
| `api:feed.delete` | `api:feed.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:feed.findall` | `api:feed.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:feed.findmany` | `api:feed.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:feed.findnew` | `api:feed.findnew` | strategies-content | carry (5) | none | — |
| `api:feed.findone` | `api:feed.findone` | strategies-content | carry (5) | none | `EX-SEC-CONTENT-ENTITY-SITE` |
| `api:feed.findpermissions` | `api:feed.findpermissions` | strategies-content | carry (5) | none | — |
| `api:feed.findproperties` | `api:feed.findproperties` | strategies-content | carry (5) | none | — |
| `api:feed.findquery` | `api:feed.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:feed.save` | `api:feed.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:feed.validate` | `api:feed.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:file.delete` | `api:file.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:file.findall` | `api:file.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:file.findmany` | `api:file.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:file.findnew` | `api:file.findnew` | strategies-content | carry (5) | none | — |
| `api:file.findone` | `api:file.findone` | strategies-content | carry (5) | none | — |
| `api:file.findpermissions` | `api:file.findpermissions` | strategies-content | carry (5) | none | — |
| `api:file.findproperties` | `api:file.findproperties` | strategies-content | carry (5) | none | — |
| `api:file.findquery` | `api:file.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:file.save` | `api:file.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:file.save{upload=image}` | `api:file.save{upload=image}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-FILE-RENDITION` |
| `api:file.validate` | `api:file.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:filebrowser.~addfolder` | `api:filebrowser.~addfolder` | strategies-content | legacy-served (4) | validates `addfolder` | — |
| `api:filebrowser.~browse` | `api:filebrowser.~browse` | strategies-content | legacy-served (4) | none | — |
| `api:filebrowser.~children` | `api:filebrowser.~children` | strategies-content | legacy-served (4) | validates `children` | — |
| `api:filebrowser.~ckeditor_quick_upload` | `api:filebrowser.~ckeditor_quick_upload` | strategies-content | legacy-served (4) | none | — |
| `api:filebrowser.~delete` | `api:filebrowser.~delete` | strategies-content | legacy-served (4) | validates `delete` | — |
| `api:filebrowser.~duplicate` | `api:filebrowser.~duplicate` | strategies-content | legacy-served (4) | validates `duplicate` | — |
| `api:filebrowser.~edit` | `api:filebrowser.~edit` | strategies-content | legacy-served (4) | none | — |
| `api:filebrowser.~move` | `api:filebrowser.~move` | strategies-content | legacy-served (4) | validates `move` | — |
| `api:filebrowser.~processcrop` | `api:filebrowser.~processcrop` | strategies-content | legacy-served (4) | validates `processCrop` | — |
| `api:filebrowser.~rename` | `api:filebrowser.~rename` | strategies-content | legacy-served (4) | validates `rename` | — |
| `api:filebrowser.~resize` | `api:filebrowser.~resize` | strategies-content | legacy-served (4) | validates `resize` | — |
| `api:filebrowser.~rotate` | `api:filebrowser.~rotate` | strategies-content | legacy-served (4) | validates `rotate` | — |
| `api:filebrowser.~update` | `api:filebrowser.~update` | strategies-content | legacy-served (4) | validates `update` | — |
| `api:filebrowser.~upload` | `api:filebrowser.~upload` | strategies-content | legacy-served (4) | validates `upload` | — |
| `api:filemetadata.delete` | `api:filemetadata.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:filemetadata.findall` | `api:filemetadata.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:filemetadata.findmany` | `api:filemetadata.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:filemetadata.findnew` | `api:filemetadata.findnew` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findone` | `api:filemetadata.findone` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findpermissions` | `api:filemetadata.findpermissions` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findproperties` | `api:filemetadata.findproperties` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findquery` | `api:filemetadata.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:filemetadata.save` | `api:filemetadata.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:filemetadata.validate` | `api:filemetadata.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:findcalendaritems` | `api:findcalendaritems` | strategies-content | carry (5) | none | — |
| `api:findcrumbarray` | `api:findcrumbarray` | strategies-content | carry (5) | none | — |
| `api:findcurrentuser` | `api:findcurrentuser` | identity | carry (5) | none | — |
| `api:findrelatedcontent` | `api:findrelatedcontent` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:findversionhistory` | `api:findversionhistory` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:generatecsrftokens` | `api:generatecsrftokens` | identity | carry (5) | none | — |
| `api:geturlforimage` | `api:geturlforimage` | strategies-content | carry (5) | none | — |
| `api:group.delete` | `api:group.delete` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:group.delete` |
| `api:group.findall` | `api:group.findall` | identity | carry (5) | none | `EX-GROUP-FEED` |
| `api:group.findmany` | `api:group.findmany` | identity | carry (5) | none | `EX-GROUP-FEED` |
| `api:group.findnew` | `api:group.findnew` | identity | carry (5) | none | — |
| `api:group.findone` | `api:group.findone` | identity | carry (5) | none | `EX-SEC-GROUP-SITE` |
| `api:group.findpermissions` | `api:group.findpermissions` | identity | carry (5) | none | — |
| `api:group.findproperties` | `api:group.findproperties` | identity | carry (5) | none | — |
| `api:group.findquery` | `api:group.findquery` | identity | carry (5) | none | `EX-GROUP-FEED` |
| `api:group.save` | `api:group.save` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:group.save` |
| `api:group.save{extdata}` | `api:group.save{extdata}` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:group.save{extdata}` |
| `api:group.save{photo}` | `api:group.save{photo}` | spans identity, strategies-content | decision (3, withheld) | validates `arguments.id` | `opt2/decision-list.json#api:group.save{photo}` |
| `api:group.validate` | `api:group.validate` | identity | carry (5) | none | `EX-GROUP-VALIDATE` |
| `api:login` | `api:login` | identity | carry (5, legacy-write) | validates `login` | `EX-LOGIN-LOCKDOWN` |
| `api:logout` | `api:logout` | identity | carry (5) | none | — |
| `api:processasyncobject` | `api:processasyncobject` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates `oauthClient.getClientID()` | `opt2/decision-list.json#api:processasyncobject` |
| `api:processasyncobject{saveform}` | `api:processasyncobject{saveform}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#api:processasyncobject{saveform}` |
| `api:site.delete` | `api:site.delete` | programs-sites | carry (5) | validates `arguments.id` | — |
| `api:site.findall` | `api:site.findall` | programs-sites | carry (5) | none | — |
| `api:site.findmany` | `api:site.findmany` | programs-sites | carry (5) | none | — |
| `api:site.findnew` | `api:site.findnew` | programs-sites | carry (5) | none | — |
| `api:site.findone` | `api:site.findone` | programs-sites | carry (5) | none | — |
| `api:site.findpermissions` | `api:site.findpermissions` | programs-sites | carry (5) | none | — |
| `api:site.findproperties` | `api:site.findproperties` | programs-sites | carry (5) | none | — |
| `api:site.findquery` | `api:site.findquery` | programs-sites | carry (5) | none | — |
| `api:site.save` | `api:site.save` | programs-sites | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tentity` |
| `api:site.save{bundle}` | `api:site.save{bundle}` | programs-sites | decision (2, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tentity` |
| `api:site.validate` | `api:site.validate` | programs-sites | carry (5) | none | — |
| `api:stats.delete` | `api:stats.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:stats.findall` | `api:stats.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:stats.findmany` | `api:stats.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:stats.findnew` | `api:stats.findnew` | strategies-content | carry (5) | none | — |
| `api:stats.findone` | `api:stats.findone` | strategies-content | carry (5) | none | — |
| `api:stats.findpermissions` | `api:stats.findpermissions` | strategies-content | carry (5) | none | — |
| `api:stats.findproperties` | `api:stats.findproperties` | strategies-content | carry (5) | none | — |
| `api:stats.findquery` | `api:stats.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:stats.save` | `api:stats.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:stats.validate` | `api:stats.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `api:submitform` | `api:submitform` | strategies-content | retired (1) (corrected; expected carry) | none | — |
| `api:swagger` | `api:swagger` | — | legacy-served (4) | none | — |
| `api:undeclareentity` | `api:undeclareentity` | — | decision (2, withheld) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#tentity` |
| `api:user.delete` | `api:user.delete` | spans identity, people, strategies-content | decision (3, withheld) | validates `arguments.id` | `opt2/decision-list.json#api:user.delete` |
| `api:user.findall` | `api:user.findall` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `api:user.findmany` | `api:user.findmany` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `api:user.findnew` | `api:user.findnew` | people | carry (5) | none | — |
| `api:user.findone` | `api:user.findone` | people | carry (5) | none | `EX-USER-EDIT-SITE` |
| `api:user.findpermissions` | `api:user.findpermissions` | people | carry (5) | none | — |
| `api:user.findproperties` | `api:user.findproperties` | people | carry (5) | none | — |
| `api:user.findquery` | `api:user.findquery` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `api:user.save` | `api:user.save` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:user.save` |
| `api:user.save{extdata}` | `api:user.save{extdata}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:user.save{extdata}` |
| `api:user.save{photo}` | `api:user.save{photo}` | spans identity, people, strategies-content | decision (3, withheld) | validates `arguments.id` | `opt2/decision-list.json#api:user.save{photo}` |
| `api:user.validate` | `api:user.validate` | people | carry (5) | none | — |
| `api:user.~pollstate` | `api:user.~pollstate` | people | carry (5) | none | — |
| `api:validateemail` | `api:validateemail` | identity | carry (5) | none | — |
| `api:variationtargeting.delete` | `api:variationtargeting.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:variationtargeting.findall` | `api:variationtargeting.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:variationtargeting.findmany` | `api:variationtargeting.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:variationtargeting.findnew` | `api:variationtargeting.findnew` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findone` | `api:variationtargeting.findone` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findpermissions` | `api:variationtargeting.findpermissions` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findproperties` | `api:variationtargeting.findproperties` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findquery` | `api:variationtargeting.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `api:variationtargeting.save` | `api:variationtargeting.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:variationtargeting.validate` | `api:variationtargeting.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:address.delete` | `rest:address.delete` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:address.delete` |
| `rest:address.findall` | `rest:address.findall` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `rest:address.findmany` | `rest:address.findmany` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `rest:address.findnew` | `rest:address.findnew` | people | carry (5) | none | — |
| `rest:address.findone` | `rest:address.findone` | people | carry (5) | none | `EX-USER-EDIT-SITE` |
| `rest:address.findpermissions` | `rest:address.findpermissions` | people | carry (5) | none | — |
| `rest:address.findproperties` | `rest:address.findproperties` | people | carry (5) | none | — |
| `rest:address.findquery` | `rest:address.findquery` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `rest:address.save` | `rest:address.save` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:address.save` |
| `rest:address.save{extdata}` | `rest:address.save{extdata}` | spans people, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:address.save{extdata}` |
| `rest:address.save{session}` | `rest:address.save{session}` | spans people, strategies-content | decision (3, withheld, legacy-write) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:address.save`, `EX-REST-INDEX-SESSION` |
| `rest:address.save{siteid}` | `rest:address.save{siteid}` | spans people, strategies-content | decision (3, withheld, legacy-write) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:address.save`, `EX-REST-SITEID-STARTUP` |
| `rest:address.validate` | `rest:address.validate` | people | carry (5) | none | — |
| `rest:category.delete` | `rest:category.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:category.delete{session}` | `rest:category.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:category.delete{siteid}` | `rest:category.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:category.findall` | `rest:category.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:category.findcrumbarray` | `rest:category.findcrumbarray` | strategies-content | carry (5) | none | — |
| `rest:category.findmany` | `rest:category.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:category.findnew` | `rest:category.findnew` | strategies-content | carry (5) | none | — |
| `rest:category.findone` | `rest:category.findone` | strategies-content | carry (5) | none | `EX-SEC-CONTENT-ENTITY-SITE` |
| `rest:category.findpermissions` | `rest:category.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:category.findproperties` | `rest:category.findproperties` | strategies-content | carry (5) | none | — |
| `rest:category.findquery` | `rest:category.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:category.save` | `rest:category.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:category.save{session}` | `rest:category.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:category.save{siteid}` | `rest:category.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:category.validate` | `rest:category.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:changeset.delete` | `rest:changeset.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changeset.delete{session}` | `rest:changeset.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:changeset.delete{siteid}` | `rest:changeset.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:changeset.findall` | `rest:changeset.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:changeset.findmany` | `rest:changeset.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:changeset.findnew` | `rest:changeset.findnew` | strategies-content | carry (5) | none | — |
| `rest:changeset.findone` | `rest:changeset.findone` | strategies-content | carry (5) | none | — |
| `rest:changeset.findpermissions` | `rest:changeset.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:changeset.findproperties` | `rest:changeset.findproperties` | strategies-content | carry (5) | none | — |
| `rest:changeset.findquery` | `rest:changeset.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:changeset.save` | `rest:changeset.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changeset.save{session}` | `rest:changeset.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:changeset.save{siteid}` | `rest:changeset.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:changeset.validate` | `rest:changeset.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:changesetcategoryassignment.delete` | `rest:changesetcategoryassignment.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changesetcategoryassignment.delete{session}` | `rest:changesetcategoryassignment.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:changesetcategoryassignment.delete{siteid}` | `rest:changesetcategoryassignment.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:changesetcategoryassignment.findall` | `rest:changesetcategoryassignment.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:changesetcategoryassignment.findmany` | `rest:changesetcategoryassignment.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:changesetcategoryassignment.findnew` | `rest:changesetcategoryassignment.findnew` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findone` | `rest:changesetcategoryassignment.findone` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findpermissions` | `rest:changesetcategoryassignment.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findproperties` | `rest:changesetcategoryassignment.findproperties` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findquery` | `rest:changesetcategoryassignment.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:changesetcategoryassignment.save` | `rest:changesetcategoryassignment.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changesetcategoryassignment.save{session}` | `rest:changesetcategoryassignment.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:changesetcategoryassignment.save{siteid}` | `rest:changesetcategoryassignment.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:changesetcategoryassignment.validate` | `rest:changesetcategoryassignment.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:checkschema` | `rest:checkschema` | — | decision (2, withheld) (corrected; expected legacy-served) | bypassed | `opt2/decision-list.json#tentity-declared:*` |
| `rest:comment.delete` | `rest:comment.delete` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-COMMENT-REMOTE-SITE` |
| `rest:comment.delete{session}` | `rest:comment.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:comment.delete{siteid}` | `rest:comment.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:comment.findall` | `rest:comment.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:comment.findcrumbarray` | `rest:comment.findcrumbarray` | strategies-content | carry (5) | none | — |
| `rest:comment.findmany` | `rest:comment.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:comment.findnew` | `rest:comment.findnew` | strategies-content | carry (5) | none | — |
| `rest:comment.findone` | `rest:comment.findone` | strategies-content | carry (5) | none | `EX-SEC-CONTENT-ENTITY-SITE` |
| `rest:comment.findpermissions` | `rest:comment.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:comment.findproperties` | `rest:comment.findproperties` | strategies-content | carry (5) | none | — |
| `rest:comment.findquery` | `rest:comment.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:comment.save` | `rest:comment.save` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-COMMENT-REMOTE-SITE` |
| `rest:comment.save{session}` | `rest:comment.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:comment.save{siteid}` | `rest:comment.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:comment.validate` | `rest:comment.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:comment.~delete` | `rest:comment.~delete` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `rest:comment.~delete{session}` | `rest:comment.~delete{session}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rest:comment.~delete{siteid}` | `rest:comment.~delete{siteid}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |
| `rest:comment.~flag` | `rest:comment.~flag` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `rest:comment.~flag{session}` | `rest:comment.~flag{session}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rest:comment.~flag{siteid}` | `rest:comment.~flag{siteid}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |
| `rest:comment.~markasspam` | `rest:comment.~markasspam` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `rest:comment.~markasspam{session}` | `rest:comment.~markasspam{session}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rest:comment.~markasspam{siteid}` | `rest:comment.~markasspam{siteid}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |
| `rest:comment.~undelete` | `rest:comment.~undelete` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `rest:comment.~undelete{session}` | `rest:comment.~undelete{session}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rest:comment.~undelete{siteid}` | `rest:comment.~undelete{siteid}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |
| `rest:comment.~unmarkasspam` | `rest:comment.~unmarkasspam` | strategies-content | carry (5, legacy-write) | none | `EX-COMMENT-REMOTE-SITE` |
| `rest:comment.~unmarkasspam{session}` | `rest:comment.~unmarkasspam{session}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rest:comment.~unmarkasspam{siteid}` | `rest:comment.~unmarkasspam{siteid}` | strategies-content | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |
| `rest:content.delete` | `rest:content.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:content.delete{session}` | `rest:content.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:content.delete{siteid}` | `rest:content.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:content.findall` | `rest:content.findall` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `rest:content.findcrumbarray` | `rest:content.findcrumbarray` | strategies-content | carry (5) | none | — |
| `rest:content.findmany` | `rest:content.findmany` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `rest:content.findnew` | `rest:content.findnew` | strategies-content | carry (5) | none | — |
| `rest:content.findone` | `rest:content.findone` | strategies-content | carry (5) | none | `EX-CONTENT-RENDER` |
| `rest:content.findpermissions` | `rest:content.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:content.findproperties` | `rest:content.findproperties` | strategies-content | carry (5) | none | — |
| `rest:content.findquery` | `rest:content.findquery` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `rest:content.findrelatedcontent` | `rest:content.findrelatedcontent` | strategies-content | carry (5) | none | — |
| `rest:content.findversionhistory` | `rest:content.findversionhistory` | strategies-content | carry (5) | none | — |
| `rest:content.save` | `rest:content.save` | strategies-content | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:content.save{approved=1}` | `rest:content.save{approved=1}` | strategies-content | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:content.save{notify}` | `rest:content.save{notify}` | strategies-content | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:content.save{session}` | `rest:content.save{session}` | strategies-content | decision (2, withheld, legacy-write) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders`, `EX-REST-INDEX-SESSION` |
| `rest:content.save{siteid}` | `rest:content.save{siteid}` | strategies-content | decision (2, withheld, legacy-write) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders`, `EX-REST-SITEID-STARTUP` |
| `rest:content.validate` | `rest:content.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:contentcategoryassign.delete` | `rest:contentcategoryassign.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:contentcategoryassign.delete{session}` | `rest:contentcategoryassign.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:contentcategoryassign.delete{siteid}` | `rest:contentcategoryassign.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:contentcategoryassign.findall` | `rest:contentcategoryassign.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:contentcategoryassign.findmany` | `rest:contentcategoryassign.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:contentcategoryassign.findnew` | `rest:contentcategoryassign.findnew` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findone` | `rest:contentcategoryassign.findone` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findpermissions` | `rest:contentcategoryassign.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findproperties` | `rest:contentcategoryassign.findproperties` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findquery` | `rest:contentcategoryassign.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:contentcategoryassign.save` | `rest:contentcategoryassign.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:contentcategoryassign.save{session}` | `rest:contentcategoryassign.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:contentcategoryassign.save{siteid}` | `rest:contentcategoryassign.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:contentcategoryassign.validate` | `rest:contentcategoryassign.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:contentnav.delete` | `rest:contentnav.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:contentnav.delete{session}` | `rest:contentnav.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:contentnav.delete{siteid}` | `rest:contentnav.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:contentnav.findall` | `rest:contentnav.findall` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `rest:contentnav.findmany` | `rest:contentnav.findmany` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `rest:contentnav.findnew` | `rest:contentnav.findnew` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findone` | `rest:contentnav.findone` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findpermissions` | `rest:contentnav.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findproperties` | `rest:contentnav.findproperties` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findquery` | `rest:contentnav.findquery` | strategies-content | carry (5) | none | `EX-CONTENT-FEED-UNORDERED-SORT` |
| `rest:contentnav.save` | `rest:contentnav.save` | strategies-content | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:contentnav.save{approved=1}` | `rest:contentnav.save{approved=1}` | strategies-content | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:contentnav.save{notify}` | `rest:contentnav.save{notify}` | strategies-content | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:contentnav.save{session}` | `rest:contentnav.save{session}` | strategies-content | decision (2, withheld, legacy-write) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders`, `EX-REST-INDEX-SESSION` |
| `rest:contentnav.save{siteid}` | `rest:contentnav.save{siteid}` | strategies-content | decision (2, withheld, legacy-write) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders`, `EX-REST-SITEID-STARTUP` |
| `rest:contentnav.validate` | `rest:contentnav.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:declareentity` | `rest:declareentity` | — | decision (2, withheld) (corrected; expected legacy-served) | bypassed | `opt2/decision-list.json#tentity` |
| `rest:feed.delete` | `rest:feed.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:feed.delete{session}` | `rest:feed.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:feed.delete{siteid}` | `rest:feed.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:feed.findall` | `rest:feed.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:feed.findmany` | `rest:feed.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:feed.findnew` | `rest:feed.findnew` | strategies-content | carry (5) | none | — |
| `rest:feed.findone` | `rest:feed.findone` | strategies-content | carry (5) | none | `EX-SEC-CONTENT-ENTITY-SITE` |
| `rest:feed.findpermissions` | `rest:feed.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:feed.findproperties` | `rest:feed.findproperties` | strategies-content | carry (5) | none | — |
| `rest:feed.findquery` | `rest:feed.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:feed.save` | `rest:feed.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:feed.save{session}` | `rest:feed.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:feed.save{siteid}` | `rest:feed.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:feed.validate` | `rest:feed.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:file.delete` | `rest:file.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:file.delete{session}` | `rest:file.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:file.delete{siteid}` | `rest:file.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:file.findall` | `rest:file.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:file.findmany` | `rest:file.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:file.findnew` | `rest:file.findnew` | strategies-content | carry (5) | none | — |
| `rest:file.findone` | `rest:file.findone` | strategies-content | carry (5) | none | — |
| `rest:file.findpermissions` | `rest:file.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:file.findproperties` | `rest:file.findproperties` | strategies-content | carry (5) | none | — |
| `rest:file.findquery` | `rest:file.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:file.save` | `rest:file.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:file.save{session}` | `rest:file.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:file.save{siteid}` | `rest:file.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:file.save{upload=image}` | `rest:file.save{upload=image}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-FILE-RENDITION` |
| `rest:file.validate` | `rest:file.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:filebrowser.~addfolder` | `rest:filebrowser.~addfolder` | strategies-content | legacy-served (4) | validates `addfolder` | — |
| `rest:filebrowser.~browse` | `rest:filebrowser.~browse` | strategies-content | legacy-served (4) | none | — |
| `rest:filebrowser.~children` | `rest:filebrowser.~children` | strategies-content | legacy-served (4) | validates `children` | — |
| `rest:filebrowser.~ckeditor_quick_upload` | `rest:filebrowser.~ckeditor_quick_upload` | strategies-content | legacy-served (4) | none | — |
| `rest:filebrowser.~delete` | `rest:filebrowser.~delete` | strategies-content | legacy-served (4) | validates `delete` | — |
| `rest:filebrowser.~duplicate` | `rest:filebrowser.~duplicate` | strategies-content | legacy-served (4) | validates `duplicate` | — |
| `rest:filebrowser.~edit` | `rest:filebrowser.~edit` | strategies-content | legacy-served (4) | none | — |
| `rest:filebrowser.~move` | `rest:filebrowser.~move` | strategies-content | legacy-served (4) | validates `move` | — |
| `rest:filebrowser.~processcrop` | `rest:filebrowser.~processcrop` | strategies-content | legacy-served (4) | validates `processCrop` | — |
| `rest:filebrowser.~rename` | `rest:filebrowser.~rename` | strategies-content | legacy-served (4) | validates `rename` | — |
| `rest:filebrowser.~resize` | `rest:filebrowser.~resize` | strategies-content | legacy-served (4) | validates `resize` | — |
| `rest:filebrowser.~rotate` | `rest:filebrowser.~rotate` | strategies-content | legacy-served (4) | validates `rotate` | — |
| `rest:filebrowser.~update` | `rest:filebrowser.~update` | strategies-content | legacy-served (4) | validates `update` | — |
| `rest:filebrowser.~upload` | `rest:filebrowser.~upload` | strategies-content | legacy-served (4) | validates `upload` | — |
| `rest:filemetadata.delete` | `rest:filemetadata.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:filemetadata.delete{session}` | `rest:filemetadata.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:filemetadata.delete{siteid}` | `rest:filemetadata.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:filemetadata.findall` | `rest:filemetadata.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:filemetadata.findmany` | `rest:filemetadata.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:filemetadata.findnew` | `rest:filemetadata.findnew` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findone` | `rest:filemetadata.findone` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findpermissions` | `rest:filemetadata.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findproperties` | `rest:filemetadata.findproperties` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findquery` | `rest:filemetadata.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:filemetadata.save` | `rest:filemetadata.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:filemetadata.save{session}` | `rest:filemetadata.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:filemetadata.save{siteid}` | `rest:filemetadata.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:filemetadata.validate` | `rest:filemetadata.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:findcalendaritems` | `rest:findcalendaritems` | strategies-content | carry (5) | none | — |
| `rest:findcrumbarray` | `rest:findcrumbarray` | strategies-content | carry (5) | none | — |
| `rest:findcurrentuser` | `rest:findcurrentuser` | identity | carry (5) | none | — |
| `rest:findrelatedcontent` | `rest:findrelatedcontent` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:findversionhistory` | `rest:findversionhistory` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:generatecsrftokens` | `rest:generatecsrftokens` | identity | carry (5) | none | — |
| `rest:geturlforimage` | `rest:geturlforimage` | strategies-content | carry (5) | none | — |
| `rest:group.delete` | `rest:group.delete` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.delete` |
| `rest:group.findall` | `rest:group.findall` | identity | carry (5) | none | `EX-GROUP-FEED` |
| `rest:group.findmany` | `rest:group.findmany` | identity | carry (5) | none | `EX-GROUP-FEED` |
| `rest:group.findnew` | `rest:group.findnew` | identity | carry (5) | none | — |
| `rest:group.findone` | `rest:group.findone` | identity | carry (5) | none | `EX-SEC-GROUP-SITE` |
| `rest:group.findpermissions` | `rest:group.findpermissions` | identity | carry (5) | none | — |
| `rest:group.findproperties` | `rest:group.findproperties` | identity | carry (5) | none | — |
| `rest:group.findquery` | `rest:group.findquery` | identity | carry (5) | none | `EX-GROUP-FEED` |
| `rest:group.save` | `rest:group.save` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.save` |
| `rest:group.save{extdata}` | `rest:group.save{extdata}` | spans identity, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.save{extdata}` |
| `rest:group.save{photo}` | `rest:group.save{photo}` | spans identity, strategies-content | decision (3, withheld) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.save{photo}` |
| `rest:group.save{session}` | `rest:group.save{session}` | spans identity, strategies-content | decision (3, withheld, legacy-write) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:group.save`, `EX-REST-INDEX-SESSION` |
| `rest:group.save{siteid}` | `rest:group.save{siteid}` | spans identity, strategies-content | decision (3, withheld, legacy-write) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.save`, `EX-REST-SITEID-STARTUP` |
| `rest:group.validate` | `rest:group.validate` | identity | carry (5) | none | `EX-GROUP-VALIDATE` |
| `rest:login` | `rest:login` | identity | carry (5) | validates `login` | — |
| `rest:login{session}` | `rest:login{session}` | identity | carry (5, legacy-write) | validates `login` | `EX-REST-INDEX-SESSION` |
| `rest:login{siteid}` | `rest:login{siteid}` | identity | carry (5, legacy-write) | validates `login` | `EX-REST-SITEID-STARTUP` |
| `rest:logout` | `rest:logout` | identity | carry (5) | none | — |
| `rest:processasyncobject` | `rest:processasyncobject` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates `oauthClient.getClientID()` | `opt2/decision-list.json#api:processasyncobject` |
| `rest:processasyncobject{saveform}` | `rest:processasyncobject{saveform}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#api:processasyncobject{saveform}` |
| `rest:site.delete` | `rest:site.delete` | programs-sites | carry (5) | bypassed `arguments.id` | — |
| `rest:site.findall` | `rest:site.findall` | programs-sites | carry (5) | none | — |
| `rest:site.findmany` | `rest:site.findmany` | programs-sites | carry (5) | none | — |
| `rest:site.findnew` | `rest:site.findnew` | programs-sites | carry (5) | none | — |
| `rest:site.findone` | `rest:site.findone` | programs-sites | carry (5) | none | — |
| `rest:site.findpermissions` | `rest:site.findpermissions` | programs-sites | carry (5) | none | — |
| `rest:site.findproperties` | `rest:site.findproperties` | programs-sites | carry (5) | none | — |
| `rest:site.findquery` | `rest:site.findquery` | programs-sites | carry (5) | none | — |
| `rest:site.save` | `rest:site.save` | programs-sites | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tentity` |
| `rest:site.save{bundle}` | `rest:site.save{bundle}` | programs-sites | decision (2, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tentity` |
| `rest:site.validate` | `rest:site.validate` | programs-sites | carry (5) | none | — |
| `rest:stats.delete` | `rest:stats.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:stats.delete{session}` | `rest:stats.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:stats.delete{siteid}` | `rest:stats.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:stats.findall` | `rest:stats.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:stats.findmany` | `rest:stats.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:stats.findnew` | `rest:stats.findnew` | strategies-content | carry (5) | none | — |
| `rest:stats.findone` | `rest:stats.findone` | strategies-content | carry (5) | none | — |
| `rest:stats.findpermissions` | `rest:stats.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:stats.findproperties` | `rest:stats.findproperties` | strategies-content | carry (5) | none | — |
| `rest:stats.findquery` | `rest:stats.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:stats.save` | `rest:stats.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:stats.save{session}` | `rest:stats.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:stats.save{siteid}` | `rest:stats.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:stats.validate` | `rest:stats.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |
| `rest:submitform` | `rest:submitform` | strategies-content | retired (1) (corrected; expected carry) | none | — |
| `rest:swagger` | `rest:swagger` | — | legacy-served (4) | none | — |
| `rest:undeclareentity` | `rest:undeclareentity` | — | decision (2, withheld) (corrected; expected legacy-served) | bypassed | `opt2/decision-list.json#tentity` |
| `rest:user.delete` | `rest:user.delete` | spans identity, people, strategies-content | decision (3, withheld) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.delete` |
| `rest:user.findall` | `rest:user.findall` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `rest:user.findmany` | `rest:user.findmany` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `rest:user.findnew` | `rest:user.findnew` | people | carry (5) | none | — |
| `rest:user.findone` | `rest:user.findone` | people | carry (5) | none | `EX-USER-EDIT-SITE` |
| `rest:user.findpermissions` | `rest:user.findpermissions` | people | carry (5) | none | — |
| `rest:user.findproperties` | `rest:user.findproperties` | people | carry (5) | none | — |
| `rest:user.findquery` | `rest:user.findquery` | people | carry (5) | none | `EX-PEOPLE-FEED` |
| `rest:user.save` | `rest:user.save` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.save` |
| `rest:user.save{extdata}` | `rest:user.save{extdata}` | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.save{extdata}` |
| `rest:user.save{photo}` | `rest:user.save{photo}` | spans identity, people, strategies-content | decision (3, withheld) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.save{photo}` |
| `rest:user.save{session}` | `rest:user.save{session}` | spans identity, people, strategies-content | decision (3, withheld, legacy-write) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:user.save`, `EX-REST-INDEX-SESSION` |
| `rest:user.save{siteid}` | `rest:user.save{siteid}` | spans identity, people, strategies-content | decision (3, withheld, legacy-write) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.save`, `EX-REST-SITEID-STARTUP` |
| `rest:user.validate` | `rest:user.validate` | people | carry (5) | none | — |
| `rest:user.~pollstate` | `rest:user.~pollstate` | people | carry (5) | none | — |
| `rest:validateemail` | `rest:validateemail` | identity | carry (5) | none | — |
| `rest:variationtargeting.delete` | `rest:variationtargeting.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:variationtargeting.delete{session}` | `rest:variationtargeting.delete{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:variationtargeting.delete{siteid}` | `rest:variationtargeting.delete{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:variationtargeting.findall` | `rest:variationtargeting.findall` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:variationtargeting.findmany` | `rest:variationtargeting.findmany` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:variationtargeting.findnew` | `rest:variationtargeting.findnew` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findone` | `rest:variationtargeting.findone` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findpermissions` | `rest:variationtargeting.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findproperties` | `rest:variationtargeting.findproperties` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findquery` | `rest:variationtargeting.findquery` | strategies-content | carry (5) | none | `EX-JSONAPI-BLANK-ROW-LIMIT` |
| `rest:variationtargeting.save` | `rest:variationtargeting.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:variationtargeting.save{session}` | `rest:variationtargeting.save{session}` | strategies-content | carry (5, legacy-write) | validates `arguments.id` | `EX-REST-INDEX-SESSION` |
| `rest:variationtargeting.save{siteid}` | `rest:variationtargeting.save{siteid}` | strategies-content | carry (5, legacy-write) | bypassed `arguments.id` | `EX-REST-SITEID-STARTUP` |
| `rest:variationtargeting.validate` | `rest:variationtargeting.validate` | strategies-content | carry (5) | none | `EX-CONTENT-VALIDATE` |

## OAuth, SOAP and fixture routes

| Id | Route key | Owner | Disposition (step) | CSRF | Notes |
| --- | --- | --- | --- | --- | --- |
| `fix:communications/messages/{id}@get` | `fixture:communications/messages/{id}@get` | communications | carry (fixture-definition) | none | — |
| `fix:communications/messages@get` | `fixture:communications/messages@get` | communications | carry (fixture-definition) | none | — |
| `fix:communications/messages@post` | `fixture:communications/messages@post` | communications | carry (fixture-definition) | validates | — |
| `fix:communications/templates@get` | `fixture:communications/templates@get` | communications | carry (fixture-definition) | none | — |
| `fix:communications/templates@post` | `fixture:communications/templates@post` | communications | carry (fixture-definition) | validates | — |
| `fix:esignature/requests/{id}/audit@get` | `fixture:esignature/requests/{id}/audit@get` | e-signature | carry (fixture-definition) | none | — |
| `fix:esignature/requests/{id}/sign@post` | `fixture:esignature/requests/{id}/sign@post` | e-signature | carry (fixture-definition) | validates `route.id` | — |
| `fix:esignature/requests/{id}/verify@get` | `fixture:esignature/requests/{id}/verify@get` | e-signature | carry (fixture-definition) | none | — |
| `fix:esignature/requests/{id}/verify@post` | `fixture:esignature/requests/{id}/verify@post` | e-signature | carry (fixture-definition) | validates `route.id` | — |
| `fix:esignature/requests@get` | `fixture:esignature/requests@get` | e-signature | carry (fixture-definition) | none | — |
| `fix:esignature/requests@post` | `fixture:esignature/requests@post` | e-signature | carry (fixture-definition) | validates | — |
| `fix:finance/records/{id}/approve@post` | `fixture:finance/records/{id}/approve@post` | finance | carry (fixture-definition) | validates `route.id` | — |
| `fix:finance/records/{id}/attachments/{id}@get` | `fixture:finance/records/{id}/attachments/{id}@get` | finance | carry (fixture-definition) | none | — |
| `fix:finance/records/{id}/attachments@get` | `fixture:finance/records/{id}/attachments@get` | finance | carry (fixture-definition) | none | — |
| `fix:finance/records/{id}/attachments@post` | `fixture:finance/records/{id}/attachments@post` | finance | carry (fixture-definition) | validates `route.id` | — |
| `fix:finance/records/{id}/edit@post` | `fixture:finance/records/{id}/edit@post` | finance | carry (fixture-definition) | validates `route.id` | — |
| `fix:finance/records/{id}/reject@post` | `fixture:finance/records/{id}/reject@post` | finance | carry (fixture-definition) | validates `route.id` | — |
| `fix:finance/records/{id}/resubmit@post` | `fixture:finance/records/{id}/resubmit@post` | finance | carry (fixture-definition) | validates `route.id` | — |
| `fix:finance/records/{id}/submit@post` | `fixture:finance/records/{id}/submit@post` | finance | carry (fixture-definition) | validates `route.id` | — |
| `fix:finance/records/{id}/versions@get` | `fixture:finance/records/{id}/versions@get` | finance | carry (fixture-definition) | none | — |
| `fix:finance/records/{id}@get` | `fixture:finance/records/{id}@get` | finance | carry (fixture-definition) | none | — |
| `fix:finance/records@get` | `fixture:finance/records@get` | finance | carry (fixture-definition) | none | — |
| `fix:finance/records@post` | `fixture:finance/records@post` | finance | carry (fixture-definition) | validates | — |
| `fix:finance/rollups@get` | `fixture:finance/rollups@get` | finance | carry (fixture-definition) | none | — |
| `fix:people/persons/{id}/archive@get` | `fixture:people/persons/{id}/archive@get` | people | carry (fixture-definition) | none | — |
| `fix:people/persons/{id}/archive@post` | `fixture:people/persons/{id}/archive@post` | people | carry (fixture-definition) | validates `route.id` | — |
| `fix:reporting/exports/{id}/download@get` | `fixture:reporting/exports/{id}/download@get` | reporting | carry (fixture-definition) | none | — |
| `fix:reporting/exports/{id}@get` | `fixture:reporting/exports/{id}@get` | reporting | carry (fixture-definition) | none | — |
| `fix:reporting/exports@get` | `fixture:reporting/exports@get` | reporting | carry (fixture-definition) | none | — |
| `fix:reporting/exports@post` | `fixture:reporting/exports@post` | reporting | carry (fixture-definition) | validates | — |
| `fix:surveys/surveys/{id}/launch@get` | `fixture:surveys/surveys/{id}/launch@get` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys/{id}/launch@post` | `fixture:surveys/surveys/{id}/launch@post` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys/{id}/remind@get` | `fixture:surveys/surveys/{id}/remind@get` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys/{id}/remind@post` | `fixture:surveys/surveys/{id}/remind@post` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys/{id}/responses@get` | `fixture:surveys/surveys/{id}/responses@get` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys/{id}/responses@post` | `fixture:surveys/surveys/{id}/responses@post` | surveys | carry (fixture-definition) | validates `route.id` | — |
| `fix:surveys/surveys/{id}/schedule@post` | `fixture:surveys/surveys/{id}/schedule@post` | surveys | carry (fixture-definition) | validates `route.id` | — |
| `fix:surveys/surveys/{id}/targets/bulk@post` | `fixture:surveys/surveys/{id}/targets/bulk@post` | surveys | carry (fixture-definition) | validates `route.id` | — |
| `fix:surveys/surveys/{id}/tasks@get` | `fixture:surveys/surveys/{id}/tasks@get` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys/{id}@get` | `fixture:surveys/surveys/{id}@get` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys@get` | `fixture:surveys/surveys@get` | surveys | carry (fixture-definition) | none | — |
| `fix:surveys/surveys@post` | `fixture:surveys/surveys@post` | surveys | carry (fixture-definition) | validates | — |
| `fix:timesheets/days/{id}/primary-approve@post` | `fixture:timesheets/days/{id}/primary-approve@post` | timesheets | carry (fixture-definition) | validates `route.id` | — |
| `fix:timesheets/days/{id}/resubmit@post` | `fixture:timesheets/days/{id}/resubmit@post` | timesheets | carry (fixture-definition) | validates `route.id` | — |
| `fix:timesheets/days/{id}/return@post` | `fixture:timesheets/days/{id}/return@post` | timesheets | carry (fixture-definition) | validates `route.id` | — |
| `fix:timesheets/days/{id}/secondary-approve@post` | `fixture:timesheets/days/{id}/secondary-approve@post` | timesheets | carry (fixture-definition) | validates `route.id` | — |
| `fix:timesheets/days/{id}/submit@post` | `fixture:timesheets/days/{id}/submit@post` | timesheets | carry (fixture-definition) | validates `route.id` | — |
| `fix:timesheets/sheets/{id}/status@get` | `fixture:timesheets/sheets/{id}/status@get` | timesheets | carry (fixture-definition) | none | — |
| `fix:timesheets/sheets/{id}@get` | `fixture:timesheets/sheets/{id}@get` | timesheets | carry (fixture-definition) | none | — |
| `fix:timesheets/sheets@get` | `fixture:timesheets/sheets@get` | timesheets | carry (fixture-definition) | none | — |
| `rte:/oauth` | `rest:oauth` | identity | carry (5) | none | — |
| `rte:/oauth2` | `rest:oauth2` | identity | carry (5) | none | — |
| `rte:/oauth2{session}` | `rest:oauth2{session}` | identity | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rte:/oauth2{siteid}` | `rest:oauth2{siteid}` | identity | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |
| `rte:/oauth{session}` | `rest:oauth{session}` | identity | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rte:/oauth{siteid}` | `rest:oauth{siteid}` | identity | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |
| `rte:soap:bundle` | — | — | retired (1) | — | — |
| `rte:soap:category` | — | — | retired (1) | — | — |
| `rte:soap:content` | — | — | retired (1) | — | — |
| `rte:soap:feed` | — | — | retired (1) | — | — |
| `rte:soap:muraProxy` | — | — | retired (1) | — | — |
| `rte:soap:service` | — | — | retired (1) | — | — |
| `rte:soap:user` | — | — | retired (1) | — | — |
| `rte:tokeninfo` | `rest:tokeninfo` | identity | carry (5) | none | — |
| `rte:tokeninfo{session}` | `rest:tokeninfo{session}` | identity | carry (5, legacy-write) | none | `EX-REST-INDEX-SESSION` |
| `rte:tokeninfo{siteid}` | `rest:tokeninfo{siteid}` | identity | carry (5, legacy-write) | none | `EX-REST-SITEID-STARTUP` |

## Public front end

| Id | Entry | Owner | Disposition (step) | CSRF | Windowed | Session effects |
| --- | --- | --- | --- | --- | --- | --- |
| `fe:appreload` | application reload by ?\<appreloadkey> (default appreload) or the Global Config reload link; start-up re-runs | spans communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | decision (2, withheld, legacy-write) (corrected; expected legacy-served) `EX-SEC-APPRELOAD` | none | yes | none |
| `fe:cfm:/core/modules/v1/favorites/ajax/deletefavorite.cfm` | favorites ajax endpoint deleteFavorite.cfm | people | carry (5, legacy-write) `EX-FAVORITES` | none | yes | none |
| `fe:cfm:/core/modules/v1/favorites/ajax/deleterssfavorite.cfm` | favorites ajax endpoint deleteRSSFavorite.cfm | people | carry (5, legacy-write) `EX-FAVORITES` | none | yes | none |
| `fe:cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm` | favorites ajax endpoint saveFavorite.cfm | people | carry (5, legacy-write) `EX-FAVORITES` | none | yes | none |
| `fe:cfm:/core/modules/v1/rater/ajax/saverate.cfm` | rater ajax endpoint saveRate.cfm | strategies-content | carry (5) | none | no | none |
| `fe:commentsproxy.flag` | commentsProxy.flag remote method | strategies-content | carry (5, legacy-write) `EX-COMMENT-REMOTE-SITE` | none | yes | none |
| `fe:commentsproxy.get` | commentsProxy.get remote method | strategies-content | carry (5) | none | no | none |
| `fe:commentsproxy.getContentStats` | commentsProxy.getContentStats remote method | strategies-content | carry (5) | none | no | none |
| `fe:commentsproxy.renderCommentsPage` | commentsProxy.renderCommentsPage remote method | strategies-content | legacy-served (4) | none | no | none |
| `fe:doaction=contactsend` | doaction=contactsend: doAction case commented out at the pin, so the value only renders the page | communications | retired (1) (corrected; expected legacy-served) | none | no | none |
| `fe:doaction=createprofile` | doaction=createprofile: standardEventsHandler.doAction case | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates `editprofile` | yes | login |
| `fe:doaction=forward` | doaction=forward: named by core/mura/email/emailUtility.cfc; no code acts on it, so the page renders | — | legacy-served (4) | none | no | none |
| `fe:doaction=forwardEmail` | doaction=forwardEmail: standardEventsHandler.doAction case | communications | legacy-served (4) | none | yes | none |
| `fe:doaction=login` | doaction=login: standardEventsHandler.doAction case | identity | legacy-served (4) | validates `login` | yes | login |
| `fe:doaction=logout` | doaction=logout: standardEventsHandler.doAction case | identity | legacy-served (4) | none | no | logout |
| `fe:doaction=masterSubscribe` | doaction=masterSubscribe: standardEventsHandler.doAction case | communications | legacy-served (4) | none | yes | none |
| `fe:doaction=return` | doaction=return: standardEventsHandler.doAction case | communications | legacy-served (4) | none | yes | none |
| `fe:doaction=saveRate` | doaction=saveRate: read by core/modules/v1/rater/index.cfm; not a doAction case | strategies-content | legacy-served (4) | none | yes | none |
| `fe:doaction=sendlogin` | doaction=sendlogin: read by core/modules/v1/login/index.cfm; not a doAction case | spans identity, people, strategies-content | decision (3, withheld) | none | yes | none |
| `fe:doaction=setReminder` | doaction=setReminder: standardEventsHandler.doAction case | — | decision (2, withheld) (corrected; expected legacy-served) | none | no | none |
| `fe:doaction=subscribe` | doaction=subscribe: standardEventsHandler.doAction case | communications | legacy-served (4) | none | yes | none |
| `fe:doaction=unsubscribe` | doaction=unsubscribe: standardEventsHandler.doAction case | communications | legacy-served (4) | none | yes | none |
| `fe:doaction=updateprofile` | doaction=updateprofile: standardEventsHandler.doAction case | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates `editprofile` | yes | login |
| `fe:doaction=validateMember` | doaction=validateMember: read by core/modules/v1/mailing_list_master/index.cfm; not a doAction case | communications | legacy-served (4) | none | yes | none |
| `fe:processasyncobject{saveform}` | processAsyncObject rendering the form display object with saveform | spans identity, people, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates `getValue('formID')` | yes | login |
| `fe:render` | page render through handleRootRequest; the theme and display objects render in CFML | spans identity, reporting, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | none | yes | login |
| `fe:saveform` | form display object submits through dataCollectionBean while the page renders (saveform) | spans identity, strategies-content | decision (3, withheld) (corrected; expected legacy-served) | validates `getValue('formID')` | yes | none |

## Unreachable remote methods

| Id | Source | Guard | Owner | Disposition (step) |
| --- | --- | --- | --- | --- |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#addFolder` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:863-909` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#browse` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:919-1088` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#children` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:561-596` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#ckeditor_quick_upload` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:350-474` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#delete` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:729-795` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#duplicate` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:169-217` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#edit` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:645-684` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#move` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:598-643` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#processCrop` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:273-348` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#rename` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:797-861` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#resize` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:79-167` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#rotate` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:219-271` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#update` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:686-727` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/modules/v1/filebrowser/model/beans/filebrowser.cfc#upload` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:476-559` | `core/Application.cfc:92-105` | — | retired (1) |
| `fe:unreachable:core/mura/client/api/soap/v1/muraproxy.cfc#call` | `core/mura/client/api/soap/v1/muraProxy.cfc:216-260` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/client/api/soap/v1/muraproxy.cfc#callWithStringArgs` | `core/mura/client/api/soap/v1/muraProxy.cfc:262-276` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/client/api/soap/v1/muraproxy.cfc#isValidSession` | `core/mura/client/api/soap/v1/muraProxy.cfc:178-193` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/client/api/soap/v1/muraproxy.cfc#login` | `core/mura/client/api/soap/v1/muraProxy.cfc:84-149` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/client/api/soap/v1/muraproxy.cfc#logout` | `core/mura/client/api/soap/v1/muraProxy.cfc:151-162` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentcommentbean.cfc#delete` | `core/mura/content/contentCommentBean.cfc:317-338` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentcommentbean.cfc#flag` | `core/mura/content/contentCommentBean.cfc:363-382` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentcommentbean.cfc#markAsSpam` | `core/mura/content/contentCommentBean.cfc:384-405` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentcommentbean.cfc#unMarkAsSpam` | `core/mura/content/contentCommentBean.cfc:407-428` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentcommentbean.cfc#undelete` | `core/mura/content/contentCommentBean.cfc:340-361` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentgatewayadobe.cfc#getCommentCount` | `core/mura/content/contentGatewayAdobe.cfc:980-997` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentserver.cfc#bindToDomain` | `core/mura/content/contentServer.cfc:170-221` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentserver.cfc#forcePathDirectoryStructure` | `core/mura/content/contentServer.cfc:78-110` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentserver.cfc#parseURL` | `core/mura/content/contentServer.cfc:223-307` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentserver.cfc#parseURLLocal` | `core/mura/content/contentServer.cfc:309-334` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentserver.cfc#parseURLRoot` | `core/mura/content/contentServer.cfc:336-388` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentserver.cfc#parseURLRootStub` | `core/mura/content/contentServer.cfc:390-436` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/content/contentserver.cfc#setCGIPath` | `core/mura/content/contentServer.cfc:112-168` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/json.cfc#decode` | `core/mura/json.cfc:36-212` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/json.cfc#jsondecode` | `core/mura/json.cfc:29-31` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/json.cfc#jsonencode` | `core/mura/json.cfc:22-24` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/json.cfc#validate` | `core/mura/json.cfc:300-440` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/mura/user/userbean.cfc#pollState` | `core/mura/user/userBean.cfc:826-835` | `core/mura/Application.cfc:77-80` | — | retired (1) |
| `fe:unreachable:core/vendor/fullcalendar/proxy.cfc#getFullCalendarItems` | `core/vendor/fullcalendar/proxy.cfc:3-20` | `core/Application.cfc:92-105` | — | retired (1) |

## Site monitor

`job:sitemonitor` (`sitemonitor:run`, programs-sites, carry (5)): ACF HTTPRequest task to `/index.cfm/_api/sitemonitor/`, start 00:15, interval 900 s, request timeout 600 s, registered only when ping is true; `ping` default `false`; live task: pending-run; live `ping`: pending-run.

- Cursor: application.lastMonitored defaults to now - 1 minute and is set to the run time at the end (`core/mura/content/contentServer.cfc:676`, `core/mura/content/contentServer.cfc:745`)
- Catch-up: reminders also run for now - 30 min when the minute of lastMonitored differs from the minute of now - 30 min (`core/mura/content/contentServer.cfc:677-681`)
- Order: steps run in the fixed order of steps[] (`core/mura/content/contentServer.cfc:677-743`)
- Gating: bounces only where EmailBroadcaster is set; feed imports only where FeedManager is set; the mail-server dedupe discards the listAppend result (`core/mura/content/contentServer.cfc:689-699`, `core/mura/content/contentServer.cfc:694`)
- Purge window: display-window purge covers [lastMonitored, now] (`core/mura/content/contentServer.cfc:702-711`)
- Bounce dedupe ineffective: yes

| Order | Step | Call | Owner | Disposition (step) | Target mechanism | State this run |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `job:sitemonitor.reminders` | contentManager.sendReminders (catch-up at now - 30 min when the minutes differ) | — | decision (2, withheld) | proposed communications step | legacy step via gateway/legacy-bridge/cfml/jobs.cfm |
| 2 | `job:sitemonitor.email-send` | emailManager.send | communications | legacy-served (4) | proposed communications step; not built while cemail is legacy-served | legacy step |
| 3 | `job:sitemonitor.changeset-publish` | changesetManager.publishBySchedule | strategies-content | decision (2, withheld) (corrected; expected carry) | /internal/v1/jobs/publish-scheduled-changesets | target once its group is target-authoritative |
| 4 | `job:sitemonitor.bounces` | emailManager.trackBounces per site with EmailBroadcaster; mail-server dedupe ineffective (listAppend result discarded) | communications | legacy-served (4) | proposed communications step | legacy step |
| 5 | `job:sitemonitor.feed-import` | feedManager.doAutoImport per site with FeedManager | strategies-content | decision (2, withheld) (corrected; expected carry) | /internal/v1/jobs/feed-auto-import?siteid= | target once its group is target-authoritative |
| 6 | `job:sitemonitor.cache-purge` | contentManager.purgeContentCache and settingsBean.purgeCache for display windows in [lastMonitored, now] | strategies-content | legacy-served (4) | legacy only; the output cache exists only in legacy | legacy step |
| 7 | `job:sitemonitor.cluster-cleanup` | clusterManager.clearOldCommands | — | decision (2, withheld) | retired in target; Pub/Sub replaces tclustercommands | legacy step |
| 8 | `job:sitemonitor.plugin-events` | announceEvent onGlobalMonitor, then onSiteMonitor per site | — | legacy-served (4) (corrected; expected decision) | none | legacy step |

## Write sets

Units each writing entry point reaches:

| Id | Units |
| --- | --- |
| `api:address.delete` | content.content_rating, content.file, content.trash, file-store, people.extend_data_user_activity, people.trash, people.user_address |
| `api:address.save` | content.file, file-store, people.extend_data_user_activity, people.user_address |
| `api:address.save{extdata}` | content.file, file-store, people.extend_data_user_activity, people.user_address |
| `api:category.delete` | content.category, content.trash |
| `api:category.save` | content.category, content.content_category_assign |
| `api:changeset.delete` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.trash |
| `api:changeset.save` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign |
| `api:changesetcategoryassignment.delete` | content.changeset_category_assign |
| `api:changesetcategoryassignment.save` | content.changeset_category_assign |
| `api:checkschema` | legacy:tentity-declared:* |
| `api:comment.delete` | content.comment, content.content_stats |
| `api:comment.save` | content.comment, content.commenter, content.content_stats |
| `api:comment.~delete` | content.comment, content.content_stats |
| `api:comment.~flag` | content.comment, content.content_stats |
| `api:comment.~markasspam` | content.comment, content.content_stats |
| `api:comment.~undelete` | content.comment, content.content_stats |
| `api:comment.~unmarkasspam` | content.comment, content.content_stats |
| `api:content.delete` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `api:content.save` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `api:content.save{approved=1}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `api:content.save{notify}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `api:contentcategoryassign.delete` | content.content_category_assign |
| `api:contentcategoryassign.save` | content.content_category_assign |
| `api:contentnav.delete` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `api:contentnav.save` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `api:contentnav.save{approved=1}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `api:contentnav.save{notify}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `api:declareentity` | legacy:tentity |
| `api:feed.delete` | content.feed, content.trash |
| `api:feed.save` | content.feed, content.feed_advanced_param, content.feed_item |
| `api:file.delete` | content.file |
| `api:file.save` | content.file, file-store |
| `api:file.save{upload=image}` | content.file, file-store |
| `api:filemetadata.delete` | content.file_metadata |
| `api:filemetadata.save` | content.file, content.file_metadata |
| `api:group.delete` | content.file, content.trash, file-store, identity.extend_data_user_activity, identity.group_account, identity.oauth_token, identity.trash, identity.user_tag |
| `api:group.save` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `api:group.save{extdata}` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `api:group.save{photo}` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `api:login` | identity.credential, identity.login_state, identity.user_strike |
| `api:processasyncobject` | content.content_rating, content.file, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_device, identity.user_interest, identity.user_strike, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `api:processasyncobject{saveform}` | content.content_rating, content.file, content.form_response_packet, content.form_response_question, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_device, identity.user_interest, identity.user_strike, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `api:site.save` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tentity, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `api:site.save{bundle}` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tentity, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `api:stats.delete` | content.content_stats |
| `api:stats.save` | content.content_stats |
| `api:undeclareentity` | legacy:tentity |
| `api:user.delete` | content.file, content.trash, file-store, identity.credential, identity.login_state, identity.oauth_token, identity.trash, identity.user_account, people.extend_data_user_activity, people.person, people.trash, people.user_tag |
| `api:user.save` | content.file, file-store, identity.credential, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `api:user.save{extdata}` | content.file, file-store, identity.credential, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `api:user.save{photo}` | content.file, file-store, identity.credential, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `api:variationtargeting.delete` | content.variation_targeting |
| `api:variationtargeting.save` | content.variation_targeting |
| `ctl:carch.approvalaction` | content.approval_action, content.approval_request |
| `ctl:carch.approvalaction{action=approve}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:carch.copy` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.permission, identity.redirect, legacy:tcontenteventreminders |
| `ctl:carch.cropimage` | file-store |
| `ctl:carch.datamanager` | content.content, content.file, content.form_response_packet, content.form_response_question, file-store |
| `ctl:carch.edit` | content.content_stats |
| `ctl:carch.exportcontent` | file-store |
| `ctl:carch.flipimage` | file-store |
| `ctl:carch.frontendconfigurator` | content.content_stats |
| `ctl:carch.imagedetails` | file-store |
| `ctl:carch.importcomponent` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_category_assign, content.content_object, content.content_related, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store |
| `ctl:carch.importcontent` | content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.commenter, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.oauth_client, identity.redirect, legacy:tcontenteventreminders, legacy:tremotepointer |
| `ctl:carch.list` | content.content |
| `ctl:carch.list{sharedid}` | content.content |
| `ctl:carch.lockfile` | content.content_stats |
| `ctl:carch.rotateimage` | file-store |
| `ctl:carch.savequickedit` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:carch.unlockfile` | content.content_stats |
| `ctl:carch.unlocknode` | content.content_stats |
| `ctl:carch.update` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.trash, content.variation_targeting, file-store, identity.extend_data, identity.redirect, identity.trash, legacy:tcontenteventreminders |
| `ctl:carch.updateobjectparams` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:carch.updateobjectparams{approved=1}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:carch.update{approved=1}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.trash, content.variation_targeting, file-store, identity.extend_data, identity.redirect, identity.trash, legacy:tcontenteventreminders |
| `ctl:carch.update{notify}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.trash, content.variation_targeting, file-store, identity.extend_data, identity.redirect, identity.trash, legacy:tcontenteventreminders |
| `ctl:carch.update{upload=image}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.trash, content.variation_targeting, file-store, identity.extend_data, identity.redirect, identity.trash, legacy:tcontenteventreminders |
| `ctl:carch.variationtargeting` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:carch.variationtargeting{notify}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:ccategory.update` | content.category, content.content_category_assign, content.trash |
| `ctl:cchain.delete` | content.approval_action, content.approval_chain, content.approval_membership, content.approval_request |
| `ctl:cchain.save` | content.approval_action, content.approval_chain, content.approval_membership, content.approval_request |
| `ctl:cchangesets.delete` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.trash |
| `ctl:cchangesets.publish` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_rollback, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:cchangesets.removeitem` | content.content |
| `ctl:cchangesets.rollback` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:cchangesets.save` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign |
| `ctl:ccomments.approve` | content.comment, content.commenter, content.content_stats |
| `ctl:ccomments.bulkedit` | content.comment, content.commenter, content.content_stats |
| `ctl:ccomments.delete` | content.comment, content.content_stats |
| `ctl:ccomments.markasspam` | content.comment, content.content_stats |
| `ctl:ccomments.purgedeletedcomments` | content.comment |
| `ctl:ccomments.singleedit` | content.comment, content.commenter, content.content_stats |
| `ctl:ccomments.unapprove` | content.comment, content.commenter, content.content_stats |
| `ctl:ceditprofile.update` | identity.credential, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, identity.user_address, identity.user_interest, identity.user_tag, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:ceditprofile.update{extdata}` | content.file, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, identity.user_address, identity.user_interest, identity.user_tag, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:ceditprofile.update{photo}` | content.file, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, identity.user_address, identity.user_interest, identity.user_tag, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:cemail.deletebounces` | communications.mailing_list_member |
| `ctl:cemail.update` | communications.email, communications.email_stat, communications.trash |
| `ctl:cextend.importsubtypes` | communications.extend_attribute, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, content.extend_attribute, content.extend_rc_set, content.extend_set, content.extend_subtype, esignature.extend_attribute, esignature.extend_rc_set, esignature.extend_set, esignature.extend_subtype, finance.extend_attribute, finance.extend_rc_set, finance.extend_set, finance.extend_subtype, identity.extend_attribute, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, legacy:trazunasettings, people.extend_attribute, people.extend_rc_set, people.extend_set, people.extend_subtype, programs_sites.extend_attribute, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, reporting.extend_attribute, reporting.extend_rc_set, reporting.extend_set, reporting.extend_subtype, surveys.extend_attribute, surveys.extend_rc_set, surveys.extend_set, surveys.extend_subtype, timesheets.extend_attribute, timesheets.extend_rc_set, timesheets.extend_set, timesheets.extend_subtype |
| `ctl:cextend.saveattributesort` | communications.extend_attribute, content.extend_attribute, esignature.extend_attribute, finance.extend_attribute, identity.extend_attribute, people.extend_attribute, programs_sites.extend_attribute, reporting.extend_attribute, surveys.extend_attribute, timesheets.extend_attribute |
| `ctl:cextend.saveextendsetsort` | communications.extend_set, content.extend_set, esignature.extend_set, finance.extend_set, identity.extend_set, people.extend_set, programs_sites.extend_set, reporting.extend_set, surveys.extend_set, timesheets.extend_set |
| `ctl:cextend.saverelatedsetsort` | communications.extend_rc_set, content.extend_rc_set, esignature.extend_rc_set, finance.extend_rc_set, identity.extend_rc_set, people.extend_rc_set, programs_sites.extend_rc_set, reporting.extend_rc_set, surveys.extend_rc_set, timesheets.extend_rc_set |
| `ctl:cextend.updateattribute` | communications.extend_attribute, communications.extend_data, content.extend_attribute, content.extend_data, content.file, esignature.extend_attribute, esignature.extend_data, file-store, finance.extend_attribute, finance.extend_data, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, people.extend_attribute, people.extend_data, people.extend_data_user_activity, programs_sites.extend_attribute, programs_sites.extend_data, reporting.extend_attribute, reporting.extend_data, surveys.extend_attribute, surveys.extend_data, timesheets.extend_attribute, timesheets.extend_data |
| `ctl:cextend.updaterelatedcontentset` | communications.extend_rc_set, content.extend_rc_set, esignature.extend_rc_set, finance.extend_rc_set, identity.extend_rc_set, people.extend_rc_set, programs_sites.extend_rc_set, reporting.extend_rc_set, surveys.extend_rc_set, timesheets.extend_rc_set |
| `ctl:cextend.updateset` | communications.extend_attribute, communications.extend_data, communications.extend_set, content.extend_attribute, content.extend_data, content.extend_set, content.file, esignature.extend_attribute, esignature.extend_data, esignature.extend_set, file-store, finance.extend_attribute, finance.extend_data, finance.extend_set, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_set, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_set, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_set, reporting.extend_attribute, reporting.extend_data, reporting.extend_set, surveys.extend_attribute, surveys.extend_data, surveys.extend_set, timesheets.extend_attribute, timesheets.extend_data, timesheets.extend_set |
| `ctl:cextend.updatesubtype` | communications.extend_attribute, communications.extend_data, communications.extend_set, communications.extend_subtype, content.extend_attribute, content.extend_data, content.extend_set, content.extend_subtype, content.file, esignature.extend_attribute, esignature.extend_data, esignature.extend_set, esignature.extend_subtype, file-store, finance.extend_attribute, finance.extend_data, finance.extend_set, finance.extend_subtype, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_set, identity.extend_subtype, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_set, people.extend_subtype, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_set, programs_sites.extend_subtype, reporting.extend_attribute, reporting.extend_data, reporting.extend_set, reporting.extend_subtype, surveys.extend_attribute, surveys.extend_data, surveys.extend_set, surveys.extend_subtype, timesheets.extend_attribute, timesheets.extend_data, timesheets.extend_set, timesheets.extend_subtype |
| `ctl:cfeed.import2` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `ctl:cfeed.update` | content.content_object, content.feed, content.feed_advanced_param, content.feed_item, content.trash |
| `ctl:cfeed.update{closecompactdisplay=true}` | content.content_object, content.feed, content.feed_advanced_param, content.feed_item, content.trash |
| `ctl:cform.importform` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_category_assign, content.content_object, content.content_related, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store |
| `ctl:cform.importform{formzip}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_category_assign, content.content_object, content.content_related, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store |
| `ctl:clogin.login` | identity.credential, identity.login_state, identity.user_device, identity.user_strike |
| `ctl:clogin.login{status=sendlogin}` | content.file, file-store, identity.credential, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, identity.user_device, identity.user_strike, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:clogin.main{status=sendlogin}` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:cmailinglist.update` | communications.mailing_list, communications.mailing_list_member, communications.trash |
| `ctl:cmailinglist.updatemember` | communications.mailing_list_member |
| `ctl:cperm.update` | content.approval_assignment, identity.permission |
| `ctl:cperm.updatemodule` | identity.permission |
| `ctl:csettings.createbundle` | file-store |
| `ctl:csettings.deleteplugin` | content.content, content.content_object, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings |
| `ctl:csettings.deployplugin` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `ctl:csettings.list` | programs_sites.site |
| `ctl:csettings.loadcustomimages` | programs_sites.image_size |
| `ctl:csettings.sitecopy` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `ctl:csettings.updateplugin` | content.content, content.extend_attribute, content.extend_rc_set, content.extend_set, content.extend_subtype, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, programs_sites.extend_attribute, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site |
| `ctl:csettings.updatesite{action=add}` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, content.content, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.file, file-store, identity.credential, identity.group_account, identity.user_account, legacy:tentity, legacy:trazunasettings, people.extend_attribute, people.extend_data, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object |
| `ctl:csettings.updatesite{action=delete}` | communications.email, communications.email_return_stat, communications.email_stat, communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_assignment, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, legacy:tcontenteventreminders, legacy:tentity, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.extend_attribute, reporting.extend_data, reporting.extend_rc_set, reporting.extend_set, reporting.extend_subtype, reporting.session_tracking, reporting.trash, surveys.trash, timesheets.trash |
| `ctl:csettings.updatesite{action=update}` | content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.file, file-store, legacy:tentity, legacy:trazunasettings, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site |
| `ctl:csettings.updatesite{bundle}` | communications.email, communications.email_return_stat, communications.email_stat, communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_assignment, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tcontenteventreminders, legacy:tentity, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.extend_attribute, reporting.extend_data, reporting.extend_rc_set, reporting.extend_set, reporting.extend_subtype, reporting.session_tracking, reporting.trash, surveys.trash, timesheets.trash |
| `ctl:ctrash.empty` | communications.mailing_list_member, communications.trash, content.comment, content.content_assignment, content.content_category_assign, content.content_rating, content.content_remote_pointer, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.membership, identity.permission, identity.trash, identity.user_address, identity.user_favorite, identity.user_interest, legacy:tcontenteventreminders, people.trash, people.user_address, people.user_favorite, people.user_interest, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `ctl:ctrash.restore` | communications.email, communications.email_stat, communications.extend_data, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.source_map, content.trash, content.variation_targeting, esignature.extend_data, esignature.trash, file-store, finance.extend_data, finance.trash, identity.credential, identity.extend_data, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_interest, identity.user_tag, legacy:tcontenteventreminders, people.extend_data, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag, programs_sites.extend_data, programs_sites.trash, reporting.extend_data, reporting.trash, surveys.extend_data, surveys.trash, timesheets.extend_data, timesheets.trash |
| `ctl:cusers.addtogroup` | identity.membership |
| `ctl:cusers.edituser` | identity.user_strike |
| `ctl:cusers.removefromgroup` | identity.membership |
| `ctl:cusers.update` | content.file, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_interest, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `ctl:cusers.updateaddress` | people.user_address |
| `ctl:cusers.updateaddress{action=delete}` | content.content_rating, content.file, content.trash, file-store, people.extend_data_user_activity, people.trash, people.user_address |
| `ctl:cusers.updateaddress{extdata}` | content.file, file-store, people.extend_data_user_activity, people.user_address |
| `ctl:cusers.update{photo}` | content.file, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_interest, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `ctl:cusers.update{type=1,action=delete}` | content.file, content.trash, file-store, identity.extend_data_user_activity, identity.group_account, identity.oauth_token, identity.trash, identity.user_tag |
| `ctl:cusers.update{type=1,extdata}` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `ctl:cusers.update{type=1}` | identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `ctl:cusers.update{type=2,action=add,extdata}` | content.file, file-store, identity.credential, identity.membership, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:cusers.update{type=2,action=add}` | identity.credential, identity.membership, identity.user_account, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:cusers.update{type=2,action=delete}` | content.file, content.trash, file-store, identity.credential, identity.login_state, identity.oauth_token, identity.trash, identity.user_account, people.extend_data_user_activity, people.person, people.trash, people.user_tag |
| `ctl:cusers.update{type=2,action=update,extdata}` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:cusers.update{type=2,action=update}` | identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.person, people.user_address, people.user_interest, people.user_tag |
| `ctl:cwebservice.delete` | identity.oauth_client, identity.oauth_token |
| `ctl:cwebservice.save` | identity.oauth_client, identity.oauth_token |
| `fe:appreload` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tclustercommands, legacy:tclusterpeers, legacy:tentity, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `fe:cfm:/core/modules/v1/favorites/ajax/deletefavorite.cfm` | people.user_favorite |
| `fe:cfm:/core/modules/v1/favorites/ajax/deleterssfavorite.cfm` | people.user_favorite |
| `fe:cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm` | people.user_favorite |
| `fe:cfm:/core/modules/v1/rater/ajax/saverate.cfm` | content.content_rating, content.content_stats |
| `fe:commentsproxy.flag` | content.comment, content.content_stats |
| `fe:doaction=createprofile` | content.file, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, identity.user_address, identity.user_device, identity.user_interest, identity.user_tag, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `fe:doaction=forwardEmail` | communications.email |
| `fe:doaction=login` | identity.credential, identity.login_state, identity.user_device, identity.user_strike |
| `fe:doaction=masterSubscribe` | communications.mailing_list_member |
| `fe:doaction=return` | communications.email_return_stat, communications.email_stat |
| `fe:doaction=saveRate` | content.content_rating, content.content_stats |
| `fe:doaction=sendlogin` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, identity.user_strike, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `fe:doaction=setReminder` | legacy:tcontenteventreminders |
| `fe:doaction=subscribe` | communications.mailing_list_member |
| `fe:doaction=unsubscribe` | communications.mailing_list_member |
| `fe:doaction=updateprofile` | content.content_rating, content.file, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_device, identity.user_interest, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `fe:doaction=validateMember` | communications.mailing_list_member |
| `fe:processasyncobject{saveform}` | content.content_rating, content.file, content.form_response_packet, content.form_response_question, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_device, identity.user_interest, identity.user_strike, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `fe:render` | content.filename_archive, file-store, identity.credential, identity.group_account, identity.login_state, identity.user_strike, reporting.session_tracking |
| `fe:saveform` | content.file, content.form_response_packet, content.form_response_question, file-store, identity.redirect |
| `fix:communications/messages@post` | communications.delivery_status, communications.message |
| `fix:communications/templates@post` | communications.message_template |
| `fix:esignature/requests/{id}/sign@post` | esignature.audit_entry, esignature.signature, esignature.signature_request |
| `fix:esignature/requests@post` | esignature.audit_entry, esignature.signature_request |
| `fix:finance/records/{id}/approve@post` | finance.record, finance.record_version, finance.rollup |
| `fix:finance/records/{id}/attachments@post` | finance.attachment |
| `fix:finance/records/{id}/edit@post` | finance.record, finance.record_version, finance.rollup |
| `fix:finance/records/{id}/reject@post` | finance.record, finance.record_version, finance.rollup |
| `fix:finance/records/{id}/resubmit@post` | finance.record, finance.record_version, finance.rollup |
| `fix:finance/records/{id}/submit@post` | finance.record, finance.record_version, finance.rollup |
| `fix:finance/records@post` | finance.record, finance.record_version, finance.rollup |
| `fix:people/persons/{id}/archive@post` | people.person_archive, timesheets.blackout |
| `fix:reporting/exports@post` | reporting.export_job |
| `fix:surveys/surveys/{id}/launch@get` | surveys.survey |
| `fix:surveys/surveys/{id}/launch@post` | surveys.survey |
| `fix:surveys/surveys/{id}/remind@get` | surveys.survey_reminder |
| `fix:surveys/surveys/{id}/remind@post` | surveys.survey_reminder |
| `fix:surveys/surveys/{id}/responses@post` | surveys.survey_response |
| `fix:surveys/surveys/{id}/schedule@post` | surveys.survey, surveys.survey_reminder, surveys.survey_schedule |
| `fix:surveys/surveys/{id}/targets/bulk@post` | surveys.survey_target |
| `fix:surveys/surveys@post` | surveys.survey |
| `fix:timesheets/days/{id}/primary-approve@post` | timesheets.approval_action, timesheets.timesheet_day |
| `fix:timesheets/days/{id}/resubmit@post` | timesheets.approval_action, timesheets.timesheet_day |
| `fix:timesheets/days/{id}/return@post` | timesheets.approval_action, timesheets.timesheet_day |
| `fix:timesheets/days/{id}/secondary-approve@post` | timesheets.approval_action, timesheets.timesheet_day |
| `fix:timesheets/days/{id}/submit@post` | timesheets.approval_action, timesheets.timesheet_day |
| `job:sitemonitor.bounces` | communications.email_stat |
| `job:sitemonitor.changeset-publish` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_rollback, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `job:sitemonitor.cluster-cleanup` | legacy:tclustercommands, legacy:tclusterpeers |
| `job:sitemonitor.email-send` | communications.email, communications.email_stat |
| `job:sitemonitor.feed-import` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `job:sitemonitor.reminders` | legacy:tcontenteventreminders |
| `rest:address.delete` | content.content_rating, content.file, content.trash, file-store, people.extend_data_user_activity, people.trash, people.user_address |
| `rest:address.save` | content.file, file-store, people.extend_data_user_activity, people.user_address |
| `rest:address.save{extdata}` | content.file, file-store, people.extend_data_user_activity, people.user_address |
| `rest:address.save{session}` | content.file, file-store, people.extend_data_user_activity, people.user_address |
| `rest:address.save{siteid}` | content.file, file-store, people.extend_data_user_activity, people.user_address |
| `rest:category.delete` | content.category, content.trash |
| `rest:category.delete{session}` | content.category, content.trash |
| `rest:category.delete{siteid}` | content.category, content.trash |
| `rest:category.save` | content.category, content.content_category_assign |
| `rest:category.save{session}` | content.category, content.content_category_assign |
| `rest:category.save{siteid}` | content.category, content.content_category_assign |
| `rest:changeset.delete` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.trash |
| `rest:changeset.delete{session}` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.trash |
| `rest:changeset.delete{siteid}` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.trash |
| `rest:changeset.save` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign |
| `rest:changeset.save{session}` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign |
| `rest:changeset.save{siteid}` | content.changeset, content.changeset_category_assign, content.changeset_tag_assign |
| `rest:changesetcategoryassignment.delete` | content.changeset_category_assign |
| `rest:changesetcategoryassignment.delete{session}` | content.changeset_category_assign |
| `rest:changesetcategoryassignment.delete{siteid}` | content.changeset_category_assign |
| `rest:changesetcategoryassignment.save` | content.changeset_category_assign |
| `rest:changesetcategoryassignment.save{session}` | content.changeset_category_assign |
| `rest:changesetcategoryassignment.save{siteid}` | content.changeset_category_assign |
| `rest:checkschema` | legacy:tentity-declared:* |
| `rest:comment.delete` | content.comment, content.content_stats |
| `rest:comment.delete{session}` | content.comment, content.content_stats |
| `rest:comment.delete{siteid}` | content.comment, content.content_stats |
| `rest:comment.save` | content.comment, content.commenter, content.content_stats |
| `rest:comment.save{session}` | content.comment, content.commenter, content.content_stats |
| `rest:comment.save{siteid}` | content.comment, content.commenter, content.content_stats |
| `rest:comment.~delete` | content.comment, content.content_stats |
| `rest:comment.~delete{session}` | content.comment, content.content_stats |
| `rest:comment.~delete{siteid}` | content.comment, content.content_stats |
| `rest:comment.~flag` | content.comment, content.content_stats |
| `rest:comment.~flag{session}` | content.comment, content.content_stats |
| `rest:comment.~flag{siteid}` | content.comment, content.content_stats |
| `rest:comment.~markasspam` | content.comment, content.content_stats |
| `rest:comment.~markasspam{session}` | content.comment, content.content_stats |
| `rest:comment.~markasspam{siteid}` | content.comment, content.content_stats |
| `rest:comment.~undelete` | content.comment, content.content_stats |
| `rest:comment.~undelete{session}` | content.comment, content.content_stats |
| `rest:comment.~undelete{siteid}` | content.comment, content.content_stats |
| `rest:comment.~unmarkasspam` | content.comment, content.content_stats |
| `rest:comment.~unmarkasspam{session}` | content.comment, content.content_stats |
| `rest:comment.~unmarkasspam{siteid}` | content.comment, content.content_stats |
| `rest:content.delete` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `rest:content.delete{session}` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `rest:content.delete{siteid}` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `rest:content.save` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:content.save{approved=1}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:content.save{notify}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:content.save{session}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:content.save{siteid}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:contentcategoryassign.delete` | content.content_category_assign |
| `rest:contentcategoryassign.delete{session}` | content.content_category_assign |
| `rest:contentcategoryassign.delete{siteid}` | content.content_category_assign |
| `rest:contentcategoryassign.save` | content.content_category_assign |
| `rest:contentcategoryassign.save{session}` | content.content_category_assign |
| `rest:contentcategoryassign.save{siteid}` | content.content_category_assign |
| `rest:contentnav.delete` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `rest:contentnav.delete{session}` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `rest:contentnav.delete{siteid}` | content.approval_action, content.approval_request, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_remote_pointer, content.content_tag, content.extend_data, content.file, content.file_metadata, content.trash, file-store |
| `rest:contentnav.save` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:contentnav.save{approved=1}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:contentnav.save{notify}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:contentnav.save{session}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:contentnav.save{siteid}` | content.approval_action, content.approval_request, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.content, content.content_assignment, content.content_category_assign, content.content_object, content.content_related, content.content_stats, content.content_tag, content.extend_data, content.file, content.file_metadata, content.filename_archive, content.source_map, content.variation_targeting, file-store, identity.extend_data, identity.redirect, legacy:tcontenteventreminders |
| `rest:declareentity` | legacy:tentity |
| `rest:feed.delete` | content.feed, content.trash |
| `rest:feed.delete{session}` | content.feed, content.trash |
| `rest:feed.delete{siteid}` | content.feed, content.trash |
| `rest:feed.save` | content.feed, content.feed_advanced_param, content.feed_item |
| `rest:feed.save{session}` | content.feed, content.feed_advanced_param, content.feed_item |
| `rest:feed.save{siteid}` | content.feed, content.feed_advanced_param, content.feed_item |
| `rest:file.delete` | content.file |
| `rest:file.delete{session}` | content.file |
| `rest:file.delete{siteid}` | content.file |
| `rest:file.save` | content.file, file-store |
| `rest:file.save{session}` | content.file, file-store |
| `rest:file.save{siteid}` | content.file, file-store |
| `rest:file.save{upload=image}` | content.file, file-store |
| `rest:filemetadata.delete` | content.file_metadata |
| `rest:filemetadata.delete{session}` | content.file_metadata |
| `rest:filemetadata.delete{siteid}` | content.file_metadata |
| `rest:filemetadata.save` | content.file, content.file_metadata |
| `rest:filemetadata.save{session}` | content.file, content.file_metadata |
| `rest:filemetadata.save{siteid}` | content.file, content.file_metadata |
| `rest:group.delete` | content.file, content.trash, file-store, identity.extend_data_user_activity, identity.group_account, identity.oauth_token, identity.trash, identity.user_tag |
| `rest:group.save` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `rest:group.save{extdata}` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `rest:group.save{photo}` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `rest:group.save{session}` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `rest:group.save{siteid}` | content.file, file-store, identity.extend_data_user_activity, identity.group_account, identity.membership, identity.oauth_token, identity.redirect, identity.user_address, identity.user_interest, identity.user_tag |
| `rest:login` | identity.credential, identity.login_state, identity.user_strike |
| `rest:login{session}` | identity.credential, identity.login_state, identity.user_strike |
| `rest:login{siteid}` | identity.credential, identity.login_state, identity.user_strike |
| `rest:processasyncobject` | content.content_rating, content.file, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_device, identity.user_interest, identity.user_strike, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `rest:processasyncobject{saveform}` | content.content_rating, content.file, content.form_response_packet, content.form_response_question, content.trash, file-store, identity.credential, identity.extend_data_user_activity, identity.group_account, identity.login_state, identity.membership, identity.oauth_token, identity.redirect, identity.trash, identity.user_account, identity.user_address, identity.user_device, identity.user_interest, identity.user_strike, identity.user_tag, people.extend_data_user_activity, people.person, people.trash, people.user_address, people.user_interest, people.user_tag |
| `rest:site.save` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tentity, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `rest:site.save{bundle}` | communications.extend_attribute, communications.extend_data, communications.extend_rc_set, communications.extend_set, communications.extend_subtype, communications.mailing_list, communications.mailing_list_member, communications.trash, content.approval_action, content.approval_chain, content.approval_membership, content.approval_request, content.category, content.changeset, content.changeset_category_assign, content.changeset_tag_assign, content.comment, content.commenter, content.content, content.content_category_assign, content.content_object, content.content_rating, content.content_related, content.content_remote_pointer, content.content_stats, content.content_tag, content.extend_attribute, content.extend_data, content.extend_rc_set, content.extend_set, content.extend_subtype, content.feed, content.feed_advanced_param, content.feed_item, content.file, content.file_metadata, content.filename_archive, content.form_response_packet, content.form_response_question, content.trash, content.variation_targeting, esignature.trash, file-store, finance.trash, identity.credential, identity.extend_attribute, identity.extend_data, identity.extend_data_user_activity, identity.extend_rc_set, identity.extend_set, identity.extend_subtype, identity.group_account, identity.login_state, identity.membership, identity.oauth_client, identity.permission, identity.trash, identity.user_account, identity.user_address, identity.user_favorite, identity.user_interest, identity.user_tag, legacy:tentity, legacy:tplugindisplayobjects, legacy:tplugins, legacy:tpluginscripts, legacy:tpluginsettings, legacy:trazunasettings, legacy:tremotepointer, people.extend_attribute, people.extend_data, people.extend_data_user_activity, people.extend_rc_set, people.extend_set, people.extend_subtype, people.person, people.trash, people.user_address, people.user_favorite, people.user_interest, people.user_tag, programs_sites.extend_attribute, programs_sites.extend_data, programs_sites.extend_rc_set, programs_sites.extend_set, programs_sites.extend_subtype, programs_sites.image_size, programs_sites.site, programs_sites.system_object, programs_sites.trash, reporting.trash, surveys.trash, timesheets.trash |
| `rest:stats.delete` | content.content_stats |
| `rest:stats.delete{session}` | content.content_stats |
| `rest:stats.delete{siteid}` | content.content_stats |
| `rest:stats.save` | content.content_stats |
| `rest:stats.save{session}` | content.content_stats |
| `rest:stats.save{siteid}` | content.content_stats |
| `rest:undeclareentity` | legacy:tentity |
| `rest:user.delete` | content.file, content.trash, file-store, identity.credential, identity.login_state, identity.oauth_token, identity.trash, identity.user_account, people.extend_data_user_activity, people.person, people.trash, people.user_tag |
| `rest:user.save` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `rest:user.save{extdata}` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `rest:user.save{photo}` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `rest:user.save{session}` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `rest:user.save{siteid}` | content.file, file-store, identity.credential, identity.membership, identity.oauth_token, identity.redirect, identity.user_account, people.extend_data_user_activity, people.person, people.user_address, people.user_interest, people.user_tag |
| `rest:variationtargeting.delete` | content.variation_targeting |
| `rest:variationtargeting.delete{session}` | content.variation_targeting |
| `rest:variationtargeting.delete{siteid}` | content.variation_targeting |
| `rest:variationtargeting.save` | content.variation_targeting |
| `rest:variationtargeting.save{session}` | content.variation_targeting |
| `rest:variationtargeting.save{siteid}` | content.variation_targeting |
| `rte:/_api/asset/upload` | file-store |
| `rte:/_api/email/trackopen` | communications.email_stat |
| `rte:/_api/render/file` | file-store |
| `rte:/oauth` | identity.credential, identity.group_account, identity.login_state, identity.oauth_token, identity.user_strike |
| `rte:/oauth2` | identity.credential, identity.group_account, identity.login_state, identity.oauth_token, identity.user_strike |
| `rte:/oauth2{session}` | identity.credential, identity.group_account, identity.login_state, identity.oauth_token, identity.user_strike |
| `rte:/oauth2{siteid}` | identity.credential, identity.group_account, identity.login_state, identity.oauth_token, identity.user_strike |
| `rte:/oauth{session}` | identity.credential, identity.group_account, identity.login_state, identity.oauth_token, identity.user_strike |
| `rte:/oauth{siteid}` | identity.credential, identity.group_account, identity.login_state, identity.oauth_token, identity.user_strike |
| `rte:tokeninfo` | identity.group_account, identity.login_state, identity.oauth_token |
| `rte:tokeninfo{session}` | identity.group_account, identity.login_state, identity.oauth_token |
| `rte:tokeninfo{siteid}` | identity.group_account, identity.login_state, identity.oauth_token |

Sources of the write records, by unit, table and operation:

| Unit | Table | Op | Sources |
| --- | --- | --- | --- |
| `communications.delivery_status` | `synthetic.delivery_status` | insert | `legacy-fixtures/cfml/modules/communications.cfc:270-271` |
| `communications.email` | `temails` | delete | `core/mura/settings/settingsDAO.cfc:204` |
| `communications.email` | `temails` | insert | `core/mura/email/emailDAO.cfc:99-120` |
| `communications.email` | `temails` | update | `core/mura/email/emailDAO.cfc:146-163, 172-174; core/mura/email/emailManager.cfc:156; core/mura/email/emailUtility.cfc:142, 281, 285, 440, 444` |
| `communications.email_return_stat` | `temailreturnstats` | delete | `core/mura/settings/settingsDAO.cfc:196` |
| `communications.email_return_stat` | `temailreturnstats` | insert | `core/mura/email/emailUtility.cfc:474-477` |
| `communications.email_stat` | `temailstats` | delete | `core/mura/settings/settingsDAO.cfc:200` |
| `communications.email_stat` | `temailstats` | insert | `core/mura/email/emailUtility.cfc:484-485` |
| `communications.email_stat` | `temailstats` | update | `core/mura/email/emailUtility.cfc:459-462` |
| `communications.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499; core/mura/publisher.cfc:2574-2579; core/mura/settings/settingsDAO.cfc:260` |
| `communications.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957; core/mura/publisher.cfc:2846-2872` |
| `communications.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `communications.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984; core/mura/publisher.cfc:2819-2840` |
| `communications.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:2919-2945, 2950; core/mura/settings/settingsDAO.cfc:256` |
| `communications.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916; core/mura/publisher.cfc:2961-2982` |
| `communications.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `communications.extend_data` | `tclassextenddata` | update | `core/mura/content/contentUtility.cfc:1240-1243` |
| `communications.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `communications.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967; core/mura/publisher.cfc:2779` |
| `communications.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `communications.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385; core/mura/publisher.cfc:2565-2571; core/mura/settings/settingsDAO.cfc:264` |
| `communications.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365; core/mura/publisher.cfc:2718-2729` |
| `communications.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `communications.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350; core/mura/publisher.cfc:2733-2741` |
| `communications.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737; core/mura/publisher.cfc:2556-2561; core/mura/settings/settingsDAO.cfc:268` |
| `communications.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686; core/mura/publisher.cfc:2627-2681` |
| `communications.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `communications.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649; core/mura/publisher.cfc:2590-2623; core/mura/settings/settingsManager.cfc:728` |
| `communications.mailing_list` | `tmailinglist` | delete | `core/mura/mailinglist/mailinglistDAO.cfc:178; core/mura/publisher.cfc:1991-2004; core/mura/settings/settingsDAO.cfc:153` |
| `communications.mailing_list` | `tmailinglist` | insert | `core/mura/mailinglist/mailinglistDAO.cfc:88-95; core/mura/publisher.cfc:2008-2018; core/mura/settings/settingsDAO.cfc:841-849` |
| `communications.mailing_list` | `tmailinglist` | update | `core/mura/mailinglist/mailinglistDAO.cfc:163-168` |
| `communications.mailing_list_member` | `tmailinglistmembers` | delete | `core/mura/email/emailGateway.cfc:323; core/mura/mailinglist/mailinglistDAO.cfc:188; core/mura/mailinglist/mailinglistUtility.cfc:137; core/mura/mailinglist/memberDAO.cfc:173, 187; core/mura/publisher.cfc:2027; core/mura/settings/settingsDAO.cfc:157; core/mura/trash/trashManager.cfc:111-112` |
| `communications.mailing_list_member` | `tmailinglistmembers` | insert | `core/mura/mailinglist/memberDAO.cfc:96-105; core/mura/publisher.cfc:2032-2047` |
| `communications.mailing_list_member` | `tmailinglistmembers` | update | `core/mura/mailinglist/memberDAO.cfc:152-159; core/mura/mailinglist/memberManager.cfc:234-238` |
| `communications.message` | `synthetic.message` | insert | `legacy-fixtures/cfml/modules/communications.cfc:104-105` |
| `communications.message` | `synthetic.message` | update | `legacy-fixtures/cfml/modules/communications.cfc:245` |
| `communications.message_template` | `synthetic.message_template` | insert | `legacy-fixtures/cfml/modules/communications.cfc:66-67` |
| `communications.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `communications.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `content.approval_action` | `tapprovalactions` | delete | `core/mura/bean/beanORM.cfc:456-538, 707-723; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:284, 303-313` |
| `content.approval_action` | `tapprovalactions` | save | `core/mura/bean/beanORM.cfc:462-538; core/mura/content/approval/approvalRequestBean.cfc:26, 114, 135; core/mura/publisher.cfc:171-190, 598-610` |
| `content.approval_assignment` | `tapprovalassignments` | delete | `core/mura/settings/settingsDAO.cfc:288` |
| `content.approval_assignment` | `tapprovalassignments` | save | `admin/core/controllers/cperm.cfc:105` |
| `content.approval_chain` | `tapprovalchains` | delete | `admin/core/controllers/cchain.cfc:118; core/mura/bean/beanORM.cfc:731; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:292, 303-313` |
| `content.approval_chain` | `tapprovalchains` | save | `admin/core/controllers/cchain.cfc:108; core/mura/content/approval/approvalChainBean.cfc:115; core/mura/publisher.cfc:171-190, 598-610` |
| `content.approval_membership` | `tapprovalmemberships` | delete | `core/mura/bean/beanORM.cfc:456-538, 707-723, 731; core/mura/content/approval/approvalChainBean.cfc:85; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:296, 303-313` |
| `content.approval_membership` | `tapprovalmemberships` | save | `core/mura/bean/beanORM.cfc:462-538; core/mura/content/approval/approvalChainBean.cfc:78; core/mura/publisher.cfc:171-190, 598-610` |
| `content.approval_request` | `tapprovalrequests` | delete | `core/mura/bean/beanORM.cfc:456-538, 707-723, 731; core/mura/content/contentDAO.cfc:786, 1185; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:300, 303-313` |
| `content.approval_request` | `tapprovalrequests` | save | `core/mura/bean/beanORM.cfc:462-538; core/mura/content/approval/approvalRequestBean.cfc:41, 45, 60, 81, 95, 117, 138, 157; core/mura/content/changeset/changesetManager.cfc:536; core/mura/publisher.cfc:171-190, 598-610` |
| `content.approval_request` | `tapprovalrequests` | update | `core/mura/content/approval/approvalChainBean.cfc:91-93, 103-105` |
| `content.category` | `tcontentcategories` | delete | `core/mura/category/categoryDAO.cfc:380-381; core/mura/publisher.cfc:1203-1218; core/mura/settings/settingsDAO.cfc:220` |
| `content.category` | `tcontentcategories` | insert | `core/mura/category/categoryDAO.cfc:93-116; core/mura/publisher.cfc:1222-1253` |
| `content.category` | `tcontentcategories` | update | `core/mura/category/categoryDAO.cfc:344-363, 374-376; core/mura/category/categoryManager.cfc:218-221, 741-742; core/mura/category/categoryUtility.cfc:121-124` |
| `content.changeset` | `tchangesets` | delete | `core/mura/content/changeset/changesetManager.cfc:232-233; core/mura/publisher.cfc:1108-1123; core/mura/settings/settingsDAO.cfc:280` |
| `content.changeset` | `tchangesets` | insert | `core/mura/content/changeset/changesetManager.cfc:152-194; core/mura/publisher.cfc:1127-1149` |
| `content.changeset` | `tchangesets` | save | `core/mura/content/changeset/changesetManager.cfc:552-554` |
| `content.changeset` | `tchangesets` | update | `core/mura/content/changeset/changesetManager.cfc:100-137` |
| `content.changeset_category_assign` | `tchangesetcategoryassign` | delete | `core/mura/bean/beanORM.cfc:731; core/mura/client/api/json/v1/jsonApiUtility.cfc:3299; core/mura/content/changeset/changesetManager.cfc:141-142, 237-238; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313` |
| `content.changeset_category_assign` | `tchangesetcategoryassign` | save | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2004; core/mura/content/changeset/changesetManager.cfc:206; core/mura/publisher.cfc:171-190, 598-610` |
| `content.changeset_rollback` | `tchangesetrollback` | save | `core/mura/content/changeset/changesetManager.cfc:549` |
| `content.changeset_tag_assign` | `tchangesettagassign` | delete | `core/mura/content/changeset/changesetManager.cfc:146-147, 242-243; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313` |
| `content.changeset_tag_assign` | `tchangesettagassign` | save | `core/mura/content/changeset/changesetManager.cfc:215; core/mura/publisher.cfc:171-190, 598-610` |
| `content.comment` | `tcontentcomments` | delete | `core/mura/content/contentCommentManager.cfc:396-399; core/mura/publisher.cfc:1772; core/mura/settings/settingsDAO.cfc:180; core/mura/trash/trashManager.cfc:47-48` |
| `content.comment` | `tcontentcomments` | insert | `core/mura/content/contentCommentBean.cfc:502-522; core/mura/publisher.cfc:1777-1803` |
| `content.comment` | `tcontentcomments` | update | `core/modules/v1/comments/ajax/commentsProxy.cfc:101-102; core/mura/content/contentCommentBean.cfc:331, 354, 376, 398, 421, 475-492, 567-570; core/mura/content/contentUtility.cfc:1165-1168` |
| `content.commenter` | `tcontentcommentcommenters` | save | `core/mura/Handler/standardEventsHandler.cfc:158-183; core/mura/publisher.cfc:171-190, 598-610` |
| `content.content` | `tcontent` | delete | `core/mura/content/contentDAO.cfc:771-772, 868-870, 1145, 1196-1197; core/mura/plugin/pluginManager.cfc:968; core/mura/publisher.cfc:682-704; core/mura/settings/settingsDAO.cfc:176` |
| `content.content` | `tcontent` | insert | `core/mura/content/contentDAO.cfc:569-734; core/mura/plugin/pluginManager.cfc:1088-1104; core/mura/publisher.cfc:716-827, 3253-3269; core/mura/settings/settingsDAO.cfc:536-552, 555-572, 575-609, 613-630, 634-651, 656-673, 677-694, 698-715, 719-736, 741-758, 762-779, 783-800, 804-821` |
| `content.content` | `tcontent` | save | `core/mura/content/changeset/changesetManager.cfc:533` |
| `content.content` | `tcontent` | update | `admin/core/views/carch/list.cfm:608, 614, 621; core/appcfc/onApplicationStart_include.cfm:892-929, 910, 922; core/mura/content/changeset/changesetManager.cfc:621-625; core/mura/content/contentDAO.cfc:883-885, 1170-1171; core/mura/content/contentManager.cfc:933-936, 1307-1310, 1325-1328, 1543-1545, 1554-1557, 1576-1577; core/mura/content/contentUtility.cfc:480-481, 486-488, 523, 538, 1125-1128, 1197-1198, 1210, 1222; core/mura/content/dataCollection/dataCollectionManager.cfc:403-410; core/mura/publisher.cfc:708-711, 3245-3248; core/mura/settings/settingsManager.cfc:731` |
| `content.content_assignment` | `tcontentassignments` | delete | `core/mura/content/contentDAO.cfc:1201-1202, 1414-1422; core/mura/settings/settingsDAO.cfc:212; core/mura/trash/trashManager.cfc:41-43` |
| `content.content_assignment` | `tcontentassignments` | insert | `core/mura/content/contentDAO.cfc:1433-1439` |
| `content.content_category_assign` | `tcontentcategoryassign` | delete | `core/mura/bean/beanORM.cfc:731; core/mura/client/api/json/v1/jsonApiUtility.cfc:3299; core/mura/content/contentDAO.cfc:792-794, 844-846, 1158-1159, 1223-1224; core/mura/publisher.cfc:972-987; core/mura/settings/settingsDAO.cfc:216; core/mura/trash/trashManager.cfc:68-69` |
| `content.content_category_assign` | `tcontentcategoryassign` | insert | `core/mura/category/categoryDAO.cfc:325-334; core/mura/content/contentUtility.cfc:1031-1035; core/mura/publisher.cfc:1006-1017` |
| `content.content_category_assign` | `tcontentcategoryassign` | save | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2004` |
| `content.content_category_assign` | `tcontentcategoryassign` | update | `core/mura/category/categoryDAO.cfc:396-400` |
| `content.content_object` | `tcontentobjects` | delete | `core/mura/content/contentDAO.cfc:776-778, 833-835, 1126, 1213-1214, 1235-1236; core/mura/plugin/pluginManager.cfc:1169-1170; core/mura/publisher.cfc:833-848; core/mura/settings/settingsDAO.cfc:188` |
| `content.content_object` | `tcontentobjects` | insert | `core/mura/content/contentDAO.cfc:914-925, 934-945, 956-967; core/mura/content/contentUtility.cfc:1049-1053; core/mura/publisher.cfc:579-591, 867-887` |
| `content.content_object` | `tcontentobjects` | update | `core/mura/content/contentDAO.cfc:982-987` |
| `content.content_rating` | `tcontentratings` | delete | `core/mura/publisher.cfc:1809; core/mura/settings/settingsDAO.cfc:192; core/mura/trash/trashManager.cfc:31-32; core/mura/user/userDAO.cfc:819` |
| `content.content_rating` | `tcontentratings` | insert | `core/mura/content/rater/rateBean.cfc:87-94; core/mura/publisher.cfc:1813-1821` |
| `content.content_rating` | `tcontentratings` | update | `core/mura/content/rater/rateBean.cfc:76-81` |
| `content.content_related` | `tcontentrelated` | delete | `core/mura/content/contentDAO.cfc:798-800, 850-852, 1228-1229; core/mura/publisher.cfc:1023-1038; core/mura/settings/settingsDAO.cfc:208` |
| `content.content_related` | `tcontentrelated` | insert | `core/mura/content/contentDAO.cfc:1340-1348, 1360-1368; core/mura/content/contentUtility.cfc:1040-1044; core/mura/publisher.cfc:1058-1076` |
| `content.content_remote_pointer` | `tcontentremotepointer` | delete | `core/mura/content/contentDAO.cfc:1208-1209; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313; core/mura/trash/trashManager.cfc:52-53` |
| `content.content_remote_pointer` | `tcontentremotepointer` | save | `core/mura/publisher.cfc:171-190, 598-610` |
| `content.content_stats` | `tcontentstats` | delete | `core/mura/content/contentStatsBean.cfc:208-210; core/mura/publisher.cfc:1827` |
| `content.content_stats` | `tcontentstats` | insert | `core/mura/content/contentStatsBean.cfc:240-255; core/mura/publisher.cfc:1831-1867` |
| `content.content_stats` | `tcontentstats` | save | `admin/core/controllers/carch.cfc:323-328, 585, 598-605, 617-624` |
| `content.content_stats` | `tcontentstats` | update | `core/modules/v1/comments/ajax/commentsProxy.cfc:101-102; core/mura/content/contentStatsBean.cfc:221-234` |
| `content.content_tag` | `tcontenttags` | delete | `core/mura/content/contentDAO.cfc:804-806, 856-858, 1134, 1218-1219; core/mura/publisher.cfc:893-908; core/mura/settings/settingsDAO.cfc:252` |
| `content.content_tag` | `tcontenttags` | insert | `core/mura/content/contentDAO.cfc:1046-1053, 1068-1075; core/mura/publisher.cfc:926-940` |
| `content.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499; core/mura/publisher.cfc:2574-2579; core/mura/settings/settingsDAO.cfc:260` |
| `content.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957; core/mura/publisher.cfc:2846-2872` |
| `content.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `content.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984; core/mura/publisher.cfc:2819-2840` |
| `content.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:2919-2945, 2950; core/mura/settings/settingsDAO.cfc:256` |
| `content.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916; core/mura/publisher.cfc:2961-2982` |
| `content.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `content.extend_data` | `tclassextenddata` | update | `core/mura/content/contentUtility.cfc:1240-1243` |
| `content.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `content.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967; core/mura/publisher.cfc:2779` |
| `content.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `content.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385; core/mura/publisher.cfc:2565-2571; core/mura/settings/settingsDAO.cfc:264` |
| `content.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365; core/mura/publisher.cfc:2718-2729` |
| `content.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `content.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350; core/mura/publisher.cfc:2733-2741` |
| `content.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737; core/mura/publisher.cfc:2556-2561; core/mura/settings/settingsDAO.cfc:268` |
| `content.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686; core/mura/publisher.cfc:2627-2681` |
| `content.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `content.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649; core/mura/publisher.cfc:2590-2623; core/mura/settings/settingsManager.cfc:728` |
| `content.feed` | `tcontentfeeds` | delete | `core/mura/content/feed/feedDAO.cfc:324-325; core/mura/publisher.cfc:1279-1294; core/mura/settings/settingsDAO.cfc:236` |
| `content.feed` | `tcontentfeeds` | insert | `core/mura/content/feed/feedDAO.cfc:92-141; core/mura/publisher.cfc:1298-1391` |
| `content.feed` | `tcontentfeeds` | update | `core/mura/content/feed/feedDAO.cfc:268-310` |
| `content.feed_advanced_param` | `tcontentfeedadvancedparams` | delete | `core/mura/content/feed/feedDAO.cfc:433-434; core/mura/publisher.cfc:1442-1457; core/mura/settings/settingsDAO.cfc:232; core/mura/trash/trashManager.cfc:122-123` |
| `content.feed_advanced_param` | `tcontentfeedadvancedparams` | insert | `core/mura/content/feed/feedDAO.cfc:412-422; core/mura/publisher.cfc:1475-1486` |
| `content.feed_advanced_param` | `tcontentfeedadvancedparams` | update | `core/mura/publisher.cfc:3007-3013` |
| `content.feed_item` | `tcontentfeeditems` | delete | `core/mura/content/feed/feedDAO.cfc:354-355; core/mura/publisher.cfc:1397-1412; core/mura/settings/settingsDAO.cfc:228; core/mura/trash/trashManager.cfc:117-118` |
| `content.feed_item` | `tcontentfeeditems` | insert | `core/mura/content/feed/feedDAO.cfc:339-344; core/mura/publisher.cfc:1430-1436` |
| `content.file` | `tfiles` | delete | `core/mura/bean/beanORM.cfc:731; core/mura/client/api/json/v1/jsonApiUtility.cfc:3299; core/mura/content/file/fileDAO.cfc:366-369; core/mura/publisher.cfc:1556-1562, 1568-1569; core/mura/settings/settingsDAO.cfc:272` |
| `content.file` | `tfiles` | insert | `core/mura/publisher.cfc:1591-1644` |
| `content.file` | `tfiles` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211; core/mura/client/api/json/v1/jsonApiUtility.cfc:2004; core/mura/content/contentFileMetaDataBean.cfc:220; core/mura/content/contentManager.cfc:1435, 2540, 2629; core/mura/content/file/fileBean.cfc:158; core/mura/content/file/fileDAO.cfc:214; core/mura/settings/settingsManager.cfc:283, 387` |
| `content.file` | `tfiles` | update | `core/mura/content/contentManager.cfc:2555-2556, 2643-2644; core/mura/content/file/fileDAO.cfc:230, 375-380` |
| `content.file_metadata` | `tcontentfilemetadata` | delete | `core/mura/bean/beanORM.cfc:731; core/mura/client/api/json/v1/jsonApiUtility.cfc:3299; core/mura/content/contentDAO.cfc:1652-1668; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313` |
| `content.file_metadata` | `tcontentfilemetadata` | save | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2004; core/mura/content/contentDAO.cfc:1686-1723; core/mura/content/contentFileMetaDataBean.cfc:207; core/mura/content/contentManager.cfc:1644; core/mura/publisher.cfc:171-190, 598-610` |
| `content.filename_archive` | `tcontentfilenamearchive` | delete | `core/mura/Handler/standardEventsHandler.cfc:495; core/mura/bean/beanORM.cfc:731; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313` |
| `content.filename_archive` | `tcontentfilenamearchive` | save | `core/mura/content/contentManager.cfc:1695; core/mura/publisher.cfc:171-190, 598-610` |
| `content.form_response_packet` | `tformresponsepackets` | delete | `core/mura/content/dataCollection/dataCollectionManager.cfc:219-220; core/mura/publisher.cfc:1900; core/mura/settings/settingsDAO.cfc:165; core/mura/trash/trashManager.cfc:57-58` |
| `content.form_response_packet` | `tformresponsepackets` | insert | `core/mura/content/dataCollection/dataCollectionManager.cfc:181-188; core/mura/publisher.cfc:1905-1913` |
| `content.form_response_question` | `tformresponsequestions` | delete | `core/mura/content/dataCollection/dataCollectionManager.cfc:213-214; core/mura/publisher.cfc:1920-1926; core/mura/settings/settingsDAO.cfc:169-172; core/mura/trash/trashManager.cfc:62-63` |
| `content.form_response_question` | `tformresponsequestions` | insert | `core/mura/content/dataCollection/dataCollectionManager.cfc:166-172; core/mura/publisher.cfc:1932-1939` |
| `content.source_map` | `tcontentsourcemaps` | delete | `core/mura/content/contentDAO.cfc:1627-1637` |
| `content.source_map` | `tcontentsourcemaps` | save | `core/mura/content/contentManager.cfc:1623` |
| `content.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `content.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `content.variation_targeting` | `tcontentvariationtargeting` | delete | `core/mura/bean/beanORM.cfc:731; core/mura/client/api/json/v1/jsonApiUtility.cfc:3299; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313; core/mura/trash/trashManager.cfc:81-82` |
| `content.variation_targeting` | `tcontentvariationtargeting` | save | `admin/core/views/carch/variationtargeting.cfm:9; core/mura/client/api/json/v1/jsonApiUtility.cfc:2004; core/mura/content/contentManager.cfc:1739; core/mura/publisher.cfc:171-190, 598-610` |
| `esignature.audit_entry` | `synthetic.audit_entry` | insert | `legacy-fixtures/sql/esignature/200_usp_audit_append.sql:42-43` |
| `esignature.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499` |
| `esignature.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957` |
| `esignature.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `esignature.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984` |
| `esignature.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087` |
| `esignature.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916` |
| `esignature.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `esignature.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `esignature.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967` |
| `esignature.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `esignature.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385` |
| `esignature.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365` |
| `esignature.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `esignature.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350` |
| `esignature.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737` |
| `esignature.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686` |
| `esignature.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `esignature.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649` |
| `esignature.signature` | `synthetic.signature` | insert | `legacy-fixtures/cfml/modules/esignature.cfc:130-131` |
| `esignature.signature_request` | `synthetic.signature_request` | insert | `legacy-fixtures/cfml/modules/esignature.cfc:83-84` |
| `esignature.signature_request` | `synthetic.signature_request` | update | `legacy-fixtures/cfml/modules/esignature.cfc:118-120` |
| `esignature.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `esignature.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `file-store` | — | delete | `core/mura/content/contentManager.cfc:1422, 1492, 1831, 1924, 1932, 1982; core/mura/content/dataCollection/dataCollectionManager.cfc:207; core/mura/content/file/fileDAO.cfc:245, 343, 400; core/mura/content/file/fileManager.cfc:139, 146, 154, 365, 758, 795, 813, 1110; core/mura/extend/extendAttribute.cfc:472, 489; core/mura/extend/extendManager.cfc:588, 1082; core/mura/fileWriter.cfc:129, 171, 173, 304, 377; core/mura/publisher.cfc:1549; core/mura/settings/settingsManager.cfc:275, 287; core/mura/trash/trashManager.cfc:142, 144; core/mura/user/userManager.cfc:500, 731, 1004; core/mura/utility.cfc:324` |
| `file-store` | — | write | `core/mura/content/dataCollection/dataCollectionManager.cfc:152; core/mura/content/file/fileBean.cfc:123; core/mura/content/file/fileDAO.cfc:157, 161, 164, 167, 171, 174, 178, 182, 185, 188, 192, 195; core/mura/content/file/fileManager.cfc:132, 362, 365, 1127, 1157, 1213, 1240, 1253, 1262; core/mura/content/file/processImgCfimage.cfc:290, 295, 304, 310, 315; core/mura/extend/extendManager.cfc:623; core/mura/fileWriter.cfc:122, 124, 132, 134, 171, 173; core/mura/user/userManager.cfc:1007` |
| `finance.attachment` | `Program_N.finance_attachment` | insert | `legacy-fixtures/cfml/modules/finance.cfc:138` |
| `finance.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499` |
| `finance.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957` |
| `finance.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `finance.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984` |
| `finance.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087` |
| `finance.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916` |
| `finance.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `finance.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `finance.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967` |
| `finance.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `finance.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385` |
| `finance.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365` |
| `finance.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `finance.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350` |
| `finance.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737` |
| `finance.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686` |
| `finance.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `finance.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649` |
| `finance.record` | `Program_N.finance_record` | insert | `legacy-fixtures/sql/finance/200_procedures.program.sql:41-42` |
| `finance.record` | `Program_N.finance_record` | update | `legacy-fixtures/sql/finance/200_procedures.program.sql:144-147` |
| `finance.record_version` | `Program_N.finance_record_version` | insert | `legacy-fixtures/sql/finance/200_procedures.program.sql:44-45, 149-150` |
| `finance.rollup` | `Program_N.finance_rollup` | delete | `legacy-fixtures/sql/finance/200_procedures.program.sql:175` |
| `finance.rollup` | `Program_N.finance_rollup` | insert | `legacy-fixtures/sql/finance/200_procedures.program.sql:177-180` |
| `finance.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `finance.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `identity.credential` | `tusers` | delete | `core/mura/publisher.cfc:2412-2428; core/mura/settings/settingsDAO.cfc:149; core/mura/user/userDAO.cfc:375` |
| `identity.credential` | `tusers` | insert | `core/mura/publisher.cfc:2433-2477; core/mura/settings/settingsDAO.cfc:853-880; core/mura/user/userDAO.cfc:304-344` |
| `identity.credential` | `tusers` | update | `core/mura/user/userDAO.cfc:411-455, 698-701; core/mura/user/userUtility.cfc:167-173` |
| `identity.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499; core/mura/publisher.cfc:2574-2579; core/mura/settings/settingsDAO.cfc:260` |
| `identity.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957; core/mura/publisher.cfc:2846-2872` |
| `identity.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `identity.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984; core/mura/publisher.cfc:2819-2840` |
| `identity.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:2919-2945, 2950; core/mura/settings/settingsDAO.cfc:256` |
| `identity.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916; core/mura/publisher.cfc:2961-2982` |
| `identity.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `identity.extend_data` | `tclassextenddata` | update | `core/mura/content/contentUtility.cfc:1240-1243` |
| `identity.extend_data_user_activity` | `tclassextenddatauseractivity` | delete | `core/mura/extend/extendAttribute.cfc:493-494; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:3071` |
| `identity.extend_data_user_activity` | `tclassextenddatauseractivity` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641; core/mura/publisher.cfc:3081-3100` |
| `identity.extend_data_user_activity` | `tclassextenddatauseractivity` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `identity.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `identity.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967; core/mura/publisher.cfc:2779` |
| `identity.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `identity.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385; core/mura/publisher.cfc:2565-2571; core/mura/settings/settingsDAO.cfc:264` |
| `identity.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365; core/mura/publisher.cfc:2718-2729` |
| `identity.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `identity.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350; core/mura/publisher.cfc:2733-2741` |
| `identity.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737; core/mura/publisher.cfc:2556-2561; core/mura/settings/settingsDAO.cfc:268` |
| `identity.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686; core/mura/publisher.cfc:2627-2681` |
| `identity.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `identity.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649; core/mura/publisher.cfc:2590-2623; core/mura/settings/settingsManager.cfc:728` |
| `identity.group_account` | `tusers` | delete | `core/mura/publisher.cfc:2412-2428; core/mura/settings/settingsDAO.cfc:149; core/mura/user/userDAO.cfc:375` |
| `identity.group_account` | `tusers` | insert | `core/mura/publisher.cfc:2433-2477; core/mura/settings/settingsDAO.cfc:853-880; core/mura/user/userDAO.cfc:304-344` |
| `identity.group_account` | `tusers` | update | `core/mura/user/userBean.cfc:768-771; core/mura/user/userDAO.cfc:411-455; core/mura/user/userUtility.cfc:817-843` |
| `identity.login_state` | `tusers` | delete | `core/mura/publisher.cfc:2412-2428; core/mura/settings/settingsDAO.cfc:149; core/mura/user/userDAO.cfc:375` |
| `identity.login_state` | `tusers` | update | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2065-2071; core/mura/user/userBean.cfc:768-771; core/mura/user/userUtility.cfc:367-370, 368-369, 817-843` |
| `identity.membership` | `tusersmemb` | delete | `core/mura/publisher.cfc:2159-2178; core/mura/settings/settingsDAO.cfc:141; core/mura/trash/trashManager.cfc:104-106; core/mura/user/userDAO.cfc:507-512, 540, 878-887` |
| `identity.membership` | `tusersmemb` | insert | `core/mura/publisher.cfc:2191-2194; core/mura/user/userDAO.cfc:570-574` |
| `identity.oauth_client` | `toauthclients` | delete | `admin/core/controllers/cwebservice.cfc:119; core/mura/bean/beanORM.cfc:731; core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313` |
| `identity.oauth_client` | `toauthclients` | save | `admin/core/controllers/cwebservice.cfc:109; core/mura/client/api/oauth/oauthClientBean.cfc:20; core/mura/publisher.cfc:171-190, 598-610` |
| `identity.oauth_token` | `toauthtokens` | delete | `core/mura/bean/beanORM.cfc:456-460, 707-723, 731; core/mura/client/api/json/v1/jsonApiUtility.cfc:755-757, 756; core/mura/client/api/oauth/oauthClientBean.cfc:64; core/mura/user/userDAO.cfc:371, 486` |
| `identity.oauth_token` | `toauthtokens` | save | `core/mura/bean/beanORM.cfc:462-538; core/mura/client/api/json/v1/jsonApiUtility.cfc:521, 521-769, 614, 624-765, 656, 709, 769; core/mura/client/api/oauth/oauthClientBean.cfc:53; core/mura/client/api/oauth/oauthTokenBean.cfc:23` |
| `identity.permission` | `tpermissions` | delete | `core/mura/permission.cfc:527, 649; core/mura/publisher.cfc:2079; core/mura/settings/settingsDAO.cfc:161; core/mura/trash/trashManager.cfc:74-76` |
| `identity.permission` | `tpermissions` | insert | `core/mura/content/contentUtility.cfc:1058-1061; core/mura/permission.cfc:537-543, 655-661; core/mura/publisher.cfc:2090-2101` |
| `identity.redirect` | `tredirects` | delete | `core/mura/bean/beanORM.cfc:731; core/mura/user/userUtility.cfc:911` |
| `identity.redirect` | `tredirects` | insert | `core/mura/content/contentUtility.cfc:605-609, 615-619; core/mura/mailer.cfc:169-173` |
| `identity.redirect` | `tredirects` | save | `core/mura/content/dataCollection/dataCollectionBean.cfc:486; core/mura/user/userUtility.cfc:581` |
| `identity.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `identity.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `identity.user_account` | `tusers` | delete | `core/mura/publisher.cfc:2412-2428; core/mura/settings/settingsDAO.cfc:149; core/mura/user/userDAO.cfc:375` |
| `identity.user_account` | `tusers` | insert | `core/mura/publisher.cfc:2433-2477; core/mura/settings/settingsDAO.cfc:853-880; core/mura/user/userDAO.cfc:304-344` |
| `identity.user_account` | `tusers` | update | `core/mura/user/userDAO.cfc:411-455` |
| `identity.user_address` | `tuseraddresses` | delete | `core/mura/publisher.cfc:2349-2368; core/mura/settings/settingsDAO.cfc:145; core/mura/trash/trashManager.cfc:94-95; core/mura/user/userDAO.cfc:814` |
| `identity.user_address` | `tuseraddresses` | insert | `core/mura/publisher.cfc:2378-2406; core/mura/user/userDAO.cfc:780-804` |
| `identity.user_address` | `tuseraddresses` | update | `core/mura/user/userDAO.cfc:753-771, 854, 857` |
| `identity.user_device` | `tuserdevice` | save | `core/mura/login/loginManager.cfc:315, 370, 451` |
| `identity.user_favorite` | `tusersfavorites` | delete | `core/mura/publisher.cfc:2310-2314; core/mura/settings/settingsDAO.cfc:137; core/mura/trash/trashManager.cfc:99-100` |
| `identity.user_favorite` | `tusersfavorites` | insert | `core/mura/publisher.cfc:2319-2334` |
| `identity.user_interest` | `tusersinterests` | delete | `core/mura/publisher.cfc:2268-2287; core/mura/settings/settingsDAO.cfc:133; core/mura/trash/trashManager.cfc:87-89; core/mura/user/userDAO.cfc:588-591` |
| `identity.user_interest` | `tusersinterests` | insert | `core/mura/publisher.cfc:2292-2295; core/mura/user/userDAO.cfc:605-609` |
| `identity.user_strike` | `tuserstrikes` | insert | `core/mura/user/userstrikes.cfc:29-33` |
| `identity.user_strike` | `tuserstrikes` | update | `admin/core/views/cusers/edituser.cfm:129-132; core/modules/v1/login/index.cfm:103; core/mura/login/loginManager.cfc:268-275; core/mura/user/userUtility.cfc:120, 191-239; core/mura/user/userstrikes.cfc:53-56, 92-95, 115-118` |
| `identity.user_tag` | `tuserstags` | delete | `core/mura/publisher.cfc:2212-2232; core/mura/user/userDAO.cfc:920` |
| `identity.user_tag` | `tuserstags` | insert | `core/mura/publisher.cfc:2242-2250; core/mura/user/userDAO.cfc:904-909` |
| `legacy:tclustercommands` | `tclustercommands` | delete | `core/mura/cluster/clusterManager.cfc:294-295` |
| `legacy:tclusterpeers` | `tclusterpeers` | delete | `core/mura/cluster/clusterManager.cfc:286-290` |
| `legacy:tcontenteventreminders` | `tcontenteventreminders` | delete | `core/mura/content/reminder/reminderManager.cfc:141; core/mura/settings/settingsDAO.cfc:224; core/mura/trash/trashManager.cfc:36-37` |
| `legacy:tcontenteventreminders` | `tcontenteventreminders` | insert | `core/mura/content/reminder/reminderDAO.cfc:88-98` |
| `legacy:tcontenteventreminders` | `tcontenteventreminders` | update | `core/mura/content/reminder/reminderDAO.cfc:135-143; core/mura/content/reminder/reminderUtility.cfc:177-180` |
| `legacy:tentity` | `tentity` | delete | `core/mura/bean/beanFactory.cfc:199; core/mura/bean/beanORM.cfc:731` |
| `legacy:tentity` | `tentity` | save | `core/mura/bean/beanEntity.cfc:19; core/mura/bean/beanFactory.cfc:160` |
| `legacy:tentity-declared:*` | `tentity-declared:*` | update | `core/mura/client/api/json/v1/jsonApiUtility.cfc:215` |
| `legacy:tplugindisplayobjects` | `tplugindisplayobjects` | delete | `core/mura/plugin/pluginManager.cfc:1173; core/mura/publisher.cfc:3323-3324` |
| `legacy:tplugindisplayobjects` | `tplugindisplayobjects` | insert | `core/mura/plugin/pluginDisplayObjectBean.cfc:275-285; core/mura/publisher.cfc:3328-3348` |
| `legacy:tplugindisplayobjects` | `tplugindisplayobjects` | update | `core/mura/plugin/pluginDisplayObjectBean.cfc:260-269; core/mura/plugin/pluginManager.cfc:1111-1113` |
| `legacy:tplugins` | `tplugins` | delete | `core/mura/plugin/pluginManager.cfc:1280` |
| `legacy:tplugins` | `tplugins` | insert | `core/mura/plugin/pluginManager.cfc:339-355; core/mura/publisher.cfc:3198-3210` |
| `legacy:tplugins` | `tplugins` | update | `core/mura/plugin/pluginManager.cfc:359, 368-370, 483-507, 1035-1038, 1069-1071, 1142-1144; core/mura/publisher.cfc:3171-3182, 3230-3232` |
| `legacy:tpluginscripts` | `tpluginscripts` | delete | `core/mura/plugin/pluginManager.cfc:1162; core/mura/publisher.cfc:3289-3290` |
| `legacy:tpluginscripts` | `tpluginscripts` | insert | `core/mura/plugin/pluginScriptBean.cfc:153-159; core/mura/publisher.cfc:3296-3305` |
| `legacy:tpluginscripts` | `tpluginscripts` | update | `core/mura/plugin/pluginScriptBean.cfc:142-147` |
| `legacy:tpluginsettings` | `tpluginsettings` | delete | `core/mura/plugin/pluginManager.cfc:1155; core/mura/publisher.cfc:3366-3367` |
| `legacy:tpluginsettings` | `tpluginsettings` | insert | `core/mura/plugin/pluginManager.cfc:1018-1022; core/mura/publisher.cfc:3371-3378` |
| `legacy:trazunasettings` | `trazunasettings` | delete | `core/mura/bean/beanORM.cfc:731; core/mura/settings/settingsManager.cfc:316` |
| `legacy:trazunasettings` | `trazunasettings` | save | `core/mura/content/file/razuna/razunaSettingsBean.cfc:22; core/mura/extend/extendManager.cfc:2016-2018; core/mura/settings/settingsManager.cfc:271, 379` |
| `legacy:tremotepointer` | `tremotepointer` | delete | `core/mura/publisher.cfc:171-190; core/mura/settings/settingsDAO.cfc:303-313` |
| `legacy:tremotepointer` | `tremotepointer` | save | `core/mura/publisher.cfc:171-190, 598-610` |
| `people.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499; core/mura/publisher.cfc:2574-2579; core/mura/settings/settingsDAO.cfc:260` |
| `people.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957; core/mura/publisher.cfc:2846-2872` |
| `people.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `people.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984; core/mura/publisher.cfc:2819-2840` |
| `people.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:2919-2945, 2950; core/mura/settings/settingsDAO.cfc:256` |
| `people.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916; core/mura/publisher.cfc:2961-2982` |
| `people.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `people.extend_data` | `tclassextenddata` | update | `core/mura/content/contentUtility.cfc:1240-1243` |
| `people.extend_data_user_activity` | `tclassextenddatauseractivity` | delete | `core/mura/extend/extendAttribute.cfc:493-494; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:3071` |
| `people.extend_data_user_activity` | `tclassextenddatauseractivity` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641; core/mura/publisher.cfc:3081-3100` |
| `people.extend_data_user_activity` | `tclassextenddatauseractivity` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `people.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `people.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967; core/mura/publisher.cfc:2779` |
| `people.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `people.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385; core/mura/publisher.cfc:2565-2571; core/mura/settings/settingsDAO.cfc:264` |
| `people.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365; core/mura/publisher.cfc:2718-2729` |
| `people.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `people.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350; core/mura/publisher.cfc:2733-2741` |
| `people.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737; core/mura/publisher.cfc:2556-2561; core/mura/settings/settingsDAO.cfc:268` |
| `people.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686; core/mura/publisher.cfc:2627-2681` |
| `people.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `people.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649; core/mura/publisher.cfc:2590-2623; core/mura/settings/settingsManager.cfc:728` |
| `people.person` | `tusers` | delete | `core/mura/publisher.cfc:2412-2428; core/mura/settings/settingsDAO.cfc:149; core/mura/user/userDAO.cfc:375` |
| `people.person` | `tusers` | insert | `core/mura/publisher.cfc:2433-2477; core/mura/settings/settingsDAO.cfc:853-880; core/mura/user/userDAO.cfc:304-344` |
| `people.person` | `tusers` | update | `core/mura/user/userDAO.cfc:411-455` |
| `people.person_archive` | `synthetic.person_archive` | insert | `legacy-fixtures/cfml/modules/people.cfc:50` |
| `people.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `people.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `people.user_address` | `tuseraddresses` | delete | `core/mura/publisher.cfc:2349-2368; core/mura/settings/settingsDAO.cfc:145; core/mura/trash/trashManager.cfc:94-95; core/mura/user/userDAO.cfc:814` |
| `people.user_address` | `tuseraddresses` | insert | `core/mura/publisher.cfc:2378-2406; core/mura/user/userDAO.cfc:780-804` |
| `people.user_address` | `tuseraddresses` | update | `core/mura/user/userDAO.cfc:753-771, 854, 857` |
| `people.user_favorite` | `tusersfavorites` | delete | `core/mura/content/favorite/favoriteBean.cfc:200-201; core/mura/content/favorite/favoriteManager.cfc:248-250; core/mura/publisher.cfc:2310-2314; core/mura/settings/settingsDAO.cfc:137; core/mura/trash/trashManager.cfc:99-100` |
| `people.user_favorite` | `tusersfavorites` | insert | `core/mura/content/favorite/favoriteBean.cfc:226-238; core/mura/publisher.cfc:2319-2334` |
| `people.user_favorite` | `tusersfavorites` | update | `core/mura/content/favorite/favoriteBean.cfc:211-220` |
| `people.user_interest` | `tusersinterests` | delete | `core/mura/publisher.cfc:2268-2287; core/mura/settings/settingsDAO.cfc:133; core/mura/trash/trashManager.cfc:87-89; core/mura/user/userDAO.cfc:588-591` |
| `people.user_interest` | `tusersinterests` | insert | `core/mura/publisher.cfc:2292-2295; core/mura/user/userDAO.cfc:605-609` |
| `people.user_tag` | `tuserstags` | delete | `core/mura/publisher.cfc:2212-2232; core/mura/user/userDAO.cfc:920` |
| `people.user_tag` | `tuserstags` | insert | `core/mura/publisher.cfc:2242-2250; core/mura/user/userDAO.cfc:904-909` |
| `programs_sites.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499; core/mura/publisher.cfc:2574-2579; core/mura/settings/settingsDAO.cfc:260` |
| `programs_sites.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957; core/mura/publisher.cfc:2846-2872` |
| `programs_sites.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `programs_sites.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984; core/mura/publisher.cfc:2819-2840` |
| `programs_sites.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:2919-2945, 2950; core/mura/settings/settingsDAO.cfc:256` |
| `programs_sites.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916; core/mura/publisher.cfc:2961-2982` |
| `programs_sites.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `programs_sites.extend_data` | `tclassextenddata` | update | `core/mura/content/contentUtility.cfc:1240-1243` |
| `programs_sites.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `programs_sites.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967; core/mura/publisher.cfc:2779` |
| `programs_sites.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `programs_sites.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385; core/mura/publisher.cfc:2565-2571; core/mura/settings/settingsDAO.cfc:264` |
| `programs_sites.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365; core/mura/publisher.cfc:2718-2729` |
| `programs_sites.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `programs_sites.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350; core/mura/publisher.cfc:2733-2741` |
| `programs_sites.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737; core/mura/publisher.cfc:2556-2561; core/mura/settings/settingsDAO.cfc:268` |
| `programs_sites.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686; core/mura/publisher.cfc:2627-2681` |
| `programs_sites.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `programs_sites.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649; core/mura/publisher.cfc:2590-2623; core/mura/settings/settingsManager.cfc:728` |
| `programs_sites.image_size` | `timagesizes` | delete | `core/mura/publisher.cfc:1168; core/mura/settings/settingsDAO.cfc:129; core/mura/settings/settingsImageSizeBean.cfc:220-221` |
| `programs_sites.image_size` | `timagesizes` | insert | `core/mura/publisher.cfc:1173-1181; core/mura/settings/settingsImageSizeBean.cfc:201-207` |
| `programs_sites.image_size` | `timagesizes` | update | `core/mura/settings/settingsImageSizeBean.cfc:190-195` |
| `programs_sites.site` | `tsettings` | delete | `core/mura/settings/settingsDAO.cfc:125` |
| `programs_sites.site` | `tsettings` | insert | `core/mura/settings/settingsDAO.cfc:437-532` |
| `programs_sites.site` | `tsettings` | update | `core/mura/extend/extendManager.cfc:2016-2018; core/mura/publisher.cfc:300-301, 314-374, 2539-2542; core/mura/settings/settingsDAO.cfc:244, 248, 322-416; core/mura/settings/settingsManager.cfc:221, 237` |
| `programs_sites.system_object` | `tsystemobjects` | delete | `core/mura/publisher.cfc:947; core/mura/settings/settingsDAO.cfc:184` |
| `programs_sites.system_object` | `tsystemobjects` | insert | `core/mura/publisher.cfc:958-965; core/mura/settings/settingsDAO.cfc:830-836` |
| `programs_sites.system_object` | `tsystemobjects` | update | `core/mura/settings/settingsManager.cfc:734-737` |
| `programs_sites.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `programs_sites.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `reporting.export_job` | `synthetic.export_job` | insert | `legacy-fixtures/cfml/modules/reporting.cfc:66-67` |
| `reporting.export_job` | `synthetic.export_job` | update | `legacy-fixtures/sql/reporting/200_usp_export_job_transition.sql:50-59` |
| `reporting.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499; core/mura/publisher.cfc:2574-2579; core/mura/settings/settingsDAO.cfc:260` |
| `reporting.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957; core/mura/publisher.cfc:2846-2872` |
| `reporting.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `reporting.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984; core/mura/publisher.cfc:2819-2840` |
| `reporting.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087; core/mura/publisher.cfc:2919-2945, 2950; core/mura/settings/settingsDAO.cfc:256` |
| `reporting.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916; core/mura/publisher.cfc:2961-2982` |
| `reporting.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `reporting.extend_data` | `tclassextenddata` | update | `core/mura/content/contentUtility.cfc:1240-1243` |
| `reporting.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `reporting.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967; core/mura/publisher.cfc:2779` |
| `reporting.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `reporting.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385; core/mura/publisher.cfc:2565-2571; core/mura/settings/settingsDAO.cfc:264` |
| `reporting.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365; core/mura/publisher.cfc:2718-2729` |
| `reporting.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `reporting.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350; core/mura/publisher.cfc:2733-2741` |
| `reporting.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737; core/mura/publisher.cfc:2556-2561; core/mura/settings/settingsDAO.cfc:268` |
| `reporting.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686; core/mura/publisher.cfc:2627-2681` |
| `reporting.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `reporting.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649; core/mura/publisher.cfc:2590-2623; core/mura/settings/settingsManager.cfc:728` |
| `reporting.session_tracking` | `tsessiontracking` | delete | `core/mura/settings/settingsDAO.cfc:240; core/mura/user/sessionTracking/sessionTrackingDAO.cfc:222-223` |
| `reporting.session_tracking` | `tsessiontracking` | insert | `core/mura/user/sessionTracking/sessionTrackingDAO.cfc:168-190` |
| `reporting.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `reporting.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `surveys.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499` |
| `surveys.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957` |
| `surveys.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `surveys.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984` |
| `surveys.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087` |
| `surveys.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916` |
| `surveys.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `surveys.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `surveys.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967` |
| `surveys.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `surveys.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385` |
| `surveys.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365` |
| `surveys.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `surveys.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350` |
| `surveys.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737` |
| `surveys.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686` |
| `surveys.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `surveys.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649` |
| `surveys.survey` | `synthetic.survey` | insert | `legacy-fixtures/cfml/modules/surveys.cfc:69-70` |
| `surveys.survey` | `synthetic.survey` | update | `legacy-fixtures/cfml/modules/surveys.cfc:238, 383` |
| `surveys.survey_reminder` | `synthetic.survey_reminder` | delete | `legacy-fixtures/cfml/modules/surveys.cfc:219` |
| `surveys.survey_reminder` | `synthetic.survey_reminder` | insert | `legacy-fixtures/cfml/modules/surveys.cfc:222-229` |
| `surveys.survey_reminder` | `synthetic.survey_reminder` | update | `legacy-fixtures/cfml/modules/surveys.cfc:409` |
| `surveys.survey_response` | `synthetic.survey_response` | insert | `legacy-fixtures/cfml/modules/surveys.cfc:327-328` |
| `surveys.survey_schedule` | `synthetic.survey_schedule` | insert | `legacy-fixtures/cfml/modules/surveys.cfc:213-214` |
| `surveys.survey_schedule` | `synthetic.survey_schedule` | update | `legacy-fixtures/cfml/modules/surveys.cfc:204-206` |
| `surveys.survey_target` | `synthetic.survey_target` | insert | `legacy-fixtures/sql/surveys/200_usp_survey_bulk_target.sql:18-34` |
| `surveys.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `surveys.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |
| `timesheets.approval_action` | `Program_N.approval_action` | insert | `legacy-fixtures/sql/timesheets/200_procedures.program.sql:146-147` |
| `timesheets.blackout` | `Program_N.blackout` | insert | `legacy-fixtures/sql/timesheets/200_procedures.program.sql:180-183` |
| `timesheets.extend_attribute` | `tclassextendattributes` | delete | `core/mura/extend/extendAttribute.cfc:498-499` |
| `timesheets.extend_attribute` | `tclassextendattributes` | insert | `core/mura/extend/extendAttribute.cfc:423-441; core/mura/extend/extendManager.cfc:1943-1957` |
| `timesheets.extend_attribute` | `tclassextendattributes` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `timesheets.extend_attribute` | `tclassextendattributes` | update | `core/mura/extend/extendAttribute.cfc:398-415; core/mura/extend/extendManager.cfc:981-984` |
| `timesheets.extend_data` | `tclassextenddata` | delete | `core/mura/extend/extendAttribute.cfc:476-477; core/mura/extend/extendManager.cfc:523-525, 591-593, 1086-1087` |
| `timesheets.extend_data` | `tclassextenddata` | insert | `core/mura/extend/extendManager.cfc:530-556, 633-641, 728-754, 812-838, 900-916` |
| `timesheets.extend_data` | `tclassextenddata` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173, 200-211` |
| `timesheets.extend_rc_set` | `tclassextendrcsets` | delete | `admin/core/controllers/cextend.cfc:193; core/mura/bean/beanORM.cfc:731` |
| `timesheets.extend_rc_set` | `tclassextendrcsets` | save | `admin/core/controllers/cextend.cfc:190; core/mura/extend/extendManager.cfc:1967` |
| `timesheets.extend_rc_set` | `tclassextendrcsets` | update | `core/mura/extend/extendManager.cfc:1011-1014` |
| `timesheets.extend_set` | `tclassextendsets` | delete | `core/mura/extend/extendSet.cfc:385` |
| `timesheets.extend_set` | `tclassextendsets` | insert | `core/mura/extend/extendSet.cfc:356-365` |
| `timesheets.extend_set` | `tclassextendsets` | save | `admin/core/controllers/cextend.cfc:140-151, 162-173` |
| `timesheets.extend_set` | `tclassextendsets` | update | `core/mura/extend/extendManager.cfc:996-999; core/mura/extend/extendSet.cfc:342-350` |
| `timesheets.extend_subtype` | `tclassextend` | delete | `core/mura/extend/extendSubType.cfc:735-737` |
| `timesheets.extend_subtype` | `tclassextend` | insert | `core/mura/extend/extendSubType.cfc:668-686` |
| `timesheets.extend_subtype` | `tclassextend` | save | `admin/core/controllers/cextend.cfc:140-151; core/mura/extend/extendManager.cfc:1897-1913` |
| `timesheets.extend_subtype` | `tclassextend` | update | `core/mura/extend/extendSubType.cfc:633-649` |
| `timesheets.timesheet_day` | `Program_N.timesheet_day` | update | `legacy-fixtures/sql/timesheets/200_procedures.program.sql:142-144` |
| `timesheets.trash` | `ttrash` | delete | `core/mura/publisher.cfc:1669-1676; core/mura/settings/settingsDAO.cfc:276; core/mura/trash/trashManager.cfc:128-129, 432-434` |
| `timesheets.trash` | `ttrash` | insert | `core/mura/publisher.cfc:1719-1740; core/mura/trash/trashManager.cfc:257-271` |

## Tables

| Id | Origin | siteID | PK | Owner(s) | Rule step(s) | Disposition (step) | Writers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tbl:Program_N.approval_action` | fixture | no | yes | timesheets | 1 | carry (5) | 1 |
| `tbl:Program_N.blackout` | fixture | no | yes | timesheets | 1 | carry (5) | 1 |
| `tbl:Program_N.finance_attachment` | fixture | no | yes | finance | 1 | carry (5) | 1 |
| `tbl:Program_N.finance_record` | fixture | yes | yes | finance | 1 | carry (5) | 2 |
| `tbl:Program_N.finance_record_version` | fixture | no | yes | finance | 1 | carry (5) | 2 |
| `tbl:Program_N.finance_rollup` | fixture | no | yes | finance | 1 | carry (5) | 2 |
| `tbl:Program_N.timesheet` | fixture | yes | yes | timesheets | 1 | carry (5) | 0 |
| `tbl:Program_N.timesheet_day` | fixture | no | yes | timesheets | 1 | carry (5) | 1 |
| `tbl:synthetic.audit_entry` | fixture | no | yes | e-signature | 1 | carry (5) | 1 |
| `tbl:synthetic.delivery_status` | fixture | no | yes | communications | 1 | carry (5) | 1 |
| `tbl:synthetic.export_definition` | fixture | yes | yes | reporting | 1 | carry (5) | 0 |
| `tbl:synthetic.export_job` | fixture | yes | yes | reporting | 1 | carry (5) | 3 |
| `tbl:synthetic.finance_transition` | fixture | no | yes | finance | 1 | carry (5) | 0 |
| `tbl:synthetic.message` | fixture | yes | yes | communications | 1 | carry (5) | 2 |
| `tbl:synthetic.message_template` | fixture | yes | yes | communications | 1 | carry (5) | 1 |
| `tbl:synthetic.person_archive` | fixture | yes | yes | people | 1 | carry (5) | 1 |
| `tbl:synthetic.program_site` | fixture | yes | yes | programs-sites | 1 | carry (5) | 0 |
| `tbl:synthetic.signature` | fixture | no | yes | e-signature | 1 | carry (5) | 1 |
| `tbl:synthetic.signature_request` | fixture | yes | yes | e-signature | 1 | carry (5) | 2 |
| `tbl:synthetic.survey` | fixture | yes | yes | surveys | 1 | carry (5) | 4 |
| `tbl:synthetic.survey_reminder` | fixture | no | yes | surveys | 1 | carry (5) | 4 |
| `tbl:synthetic.survey_response` | fixture | yes | yes | surveys | 1 | carry (5) | 1 |
| `tbl:synthetic.survey_schedule` | fixture | no | yes | surveys | 1 | carry (5) | 2 |
| `tbl:synthetic.survey_target` | fixture | yes | yes | surveys | 1 | carry (5) | 1 |
| `tbl:synthetic.timesheet_transition` | fixture | no | yes | timesheets | 1 | carry (5) | 0 |
| `tbl:synthetic.transition_rule` | fixture | no | yes | timesheets | 1 | carry (5) | 0 |
| `tbl:tapprovalactions` | orm | yes | yes | strategies-content | 1 | carry (5) | 16 |
| `tbl:tapprovalassignments` | orm | yes | yes | strategies-content | 1 | carry (5) | 2 |
| `tbl:tapprovalchains` | orm | yes | yes | strategies-content | 1 | carry (5) | 9 |
| `tbl:tapprovalmemberships` | orm | yes | yes | strategies-content | 1 | carry (5) | 11 |
| `tbl:tapprovalrequests` | orm | yes | yes | strategies-content | 1 | carry (5) | 29 |
| `tbl:tchangesetcategoryassign` | orm | yes | yes | strategies-content | 1 | carry (5) | 14 |
| `tbl:tchangesetrollback` | orm | yes | yes | strategies-content | 1 | carry (5) | 4 |
| `tbl:tchangesets` | migration | yes | yes | strategies-content | 1 | carry (5) | 14 |
| `tbl:tchangesettagassign` | orm | yes | yes | strategies-content | 1 | carry (5) | 11 |
| `tbl:tclassextend` | bootstrap | yes | yes | communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | 1 | carry (5) | 22 |
| `tbl:tclassextendattributes` | bootstrap | yes | yes | communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | 1 | carry (5) | 23 |
| `tbl:tclassextenddata` | bootstrap | yes | yes | communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | 1 | carry (5) | 35 |
| `tbl:tclassextenddatauseractivity` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 14 |
| `tbl:tclassextendrcsets` | orm | yes | yes | communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | 1 | carry (5) | 11 |
| `tbl:tclassextendsets` | bootstrap | yes | yes | communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | 1 | carry (5) | 19 |
| `tbl:tclustercommands` | migration | no | yes | — | 5 | decision (2, withheld) | 11 |
| `tbl:tclusterpeers` | migration | no | yes | — | 5 | decision (2, withheld) | 11 |
| `tbl:tcontent` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 97 |
| `tbl:tcontentassignments` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 9 |
| `tbl:tcontentcategories` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 13 |
| `tbl:tcontentcategoryassign` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 22 |
| `tbl:tcontentcommentcommenters` | orm | no | yes | strategies-content | 1 | carry (5) | 5 |
| `tbl:tcontentcomments` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 19 |
| `tbl:tcontentdisplaytitleapprovals` | bootstrap | yes | no | strategies-content | 1 | carry (5) | 0 |
| `tbl:tcontenteventreminders` | bootstrap | yes | no | — | 5 | decision (2, withheld) | 11 |
| `tbl:tcontentfeedadvancedparams` | bootstrap | no | yes | strategies-content | 1 | carry (5) | 10 |
| `tbl:tcontentfeeditems` | bootstrap | no | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tcontentfeeds` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tcontentfilemetadata` | orm | yes | yes | strategies-content | 1 | carry (5) | 17 |
| `tbl:tcontentfilenamearchive` | orm | yes | yes | strategies-content | 1 | carry (5) | 10 |
| `tbl:tcontentobjects` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 25 |
| `tbl:tcontentpublicsubmissionapprovals` | bootstrap | yes | no (static: yes) | strategies-content | 1 | carry (5) | 0 |
| `tbl:tcontentratings` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 9 |
| `tbl:tcontentrelated` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 17 |
| `tbl:tcontentremotepointer` | orm | yes | yes | strategies-content | 1 | carry (5) | 6 |
| `tbl:tcontentsourcemaps` | orm | yes | yes | strategies-content | 1 | carry (5) | 6 |
| `tbl:tcontentstats` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 17 |
| `tbl:tcontenttags` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 18 |
| `tbl:tcontentvariationtargeting` | orm | yes | yes | strategies-content | 1 | carry (5) | 13 |
| `tbl:tdirectories` | migration | yes | yes | programs-sites | 1 | carry (5) | 0 |
| `tbl:temailreturnstats` | bootstrap | no | no | communications | 1 | legacy-served (4) | 2 |
| `tbl:temails` | bootstrap | yes | yes | communications | 1 | legacy-served (4) | 15 |
| `tbl:temailstats` | bootstrap | no | no | communications | 1 | legacy-served (4) | 7 |
| `tbl:tentity` | orm | no | yes | — | 5 | decision (2, withheld) | 10 |
| `tbl:tfiles` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 40 |
| `tbl:tformresponsepackets` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tformresponsequestions` | bootstrap | no | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tglobals` | bootstrap | no | no | — | — | retired (1) | 0 |
| `tbl:timagesizes` | migration | yes | yes | programs-sites | 1 | carry (5) | 14 |
| `tbl:tmailinglist` | bootstrap | yes | no | communications | 1 | legacy-served (4) | 10 |
| `tbl:tmailinglistmembers` | bootstrap | yes | no | communications | 1 | legacy-served (4) | 14 |
| `tbl:toauthclients` | orm | yes | yes | identity | 1 | carry (5) | 8 |
| `tbl:toauthtokens` | orm | no | yes | identity | 1 | carry (5) | 19 |
| `tbl:tpermissions` | bootstrap | yes | yes | identity | 2 | carry (5) | 11 |
| `tbl:tplugindisplayobjects` | migration | no | yes | — | 5 | decision (2, withheld) | 11 |
| `tbl:tplugins` | migration | no | yes | — | 5 | decision (2, withheld) | 21 |
| `tbl:tpluginscripts` | migration | no | yes | — | 5 | decision (2, withheld) | 10 |
| `tbl:tpluginsettings` | migration | no | yes | — | 5 | decision (2, withheld) | 8 |
| `tbl:trazunasettings` | orm | yes | yes | — | 5 | decision (2, withheld) | 13 |
| `tbl:tredirects` | bootstrap | yes | yes | identity | 1 | carry (5) | 13 |
| `tbl:tremotepointer` | orm | yes | yes | — | 5 | decision (2, withheld) | 4 |
| `tbl:tsessiontracking` | bootstrap | yes | yes | reporting | 1 | legacy-served (4) | 5 |
| `tbl:tsettings` | bootstrap | yes | yes (bootstrap: no) | programs-sites | 1 | carry (5) | 20 |
| `tbl:tsystemobjects` | bootstrap | yes | no | programs-sites | 1 | carry (5) | 9 |
| `tbl:ttrash` | migration | yes | yes | communications, e-signature, finance, identity, people, programs-sites, reporting, strategies-content, surveys, timesheets | 1 | carry (5) | 13 |
| `tbl:tuseraddresses` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 12 |
| `tbl:tuserdevice` | orm | yes | yes | identity | 1 | carry (5) | 3 |
| `tbl:tuserremotesessions` | migration | no | yes | identity | 1 | carry (5) | 0 |
| `tbl:tusers` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 19 |
| `tbl:tusersfavorites` | bootstrap | yes | yes | identity, people | 1, 3 | carry (5) | 10 |
| `tbl:tusersinterests` | bootstrap | no | yes | identity, people | 1, 3 | carry (5) | 9 |
| `tbl:tusersmemb` | bootstrap | no | yes | identity | 2 | carry (5) | 11 |
| `tbl:tuserstags` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 7 |
| `tbl:tuserstrikes` | migration | no | yes | identity | 1 | carry (5) | 9 |

## Relations and stored procedures

- Relations: 147 (program-fold 8, fixture-fk 15, orm-fk 72, dao-join 49, tenant-parent 3)
- Stored procedures: static 0, live 0; foreign keys: static 0

## Unoriented relations (not ordered)

| Id | Kind | Source |
| --- | --- | --- |
| `rel:tapprovalassignments.siteid->tcontent.siteid` | dao-join | `core/mura/content/contentGatewayAdobe.cfc:184` |
| `rel:tcontent.fileid->tcontentfilemetadata.fileid` | dao-join | `core/mura/content/contentGatewayAdobe.cfc:1398` |
| `rel:tcontent.moduleid->tplugindisplayobjects.moduleid` | dao-join | `core/mura/settings/settingsBundle.cfc:1790` |
| `rel:tcontent.moduleid->tplugins.moduleid` | dao-join | `core/mura/plugin/pluginManager.cfc:152` |
| `rel:tcontent.moduleid->tpluginscripts.moduleid` | dao-join | `core/mura/settings/settingsBundle.cfc:1774` |
| `rel:tcontent.moduleid->tpluginsettings.moduleid` | dao-join | `core/mura/settings/settingsBundle.cfc:1806` |
| `rel:tcontent.siteid->tcontentcategoryassign.siteid` | dao-join | `core/mura/category/categoryDAO.cfc:416` |
| `rel:tcontent.siteid->tcontenteventreminders.siteid` | dao-join | `core/mura/content/reminder/reminderGateway.cfc:98` |
| `rel:tcontent.siteid->tcontentobjects.siteid` | dao-join | `core/mura/content/contentGatewayAdobe.cfc:2657` |
| `rel:tcontent.siteid->tcontentratings.siteid` | dao-join | `core/mura/content/rater/raterManager.cfc:213` |
| `rel:tcontent.siteid->tcontentstats.siteid` | dao-join | `core/mura/content/contentGatewayAdobe.cfc:1141` |
| `rel:tcontent.siteid->tfiles.siteid` | dao-join | `core/mura/content/contentGatewayAdobe.cfc:1394` |
| `rel:tcontent.siteid->tsessiontracking.siteid` | dao-join | `core/mura/user/sessionTracking/sessionTrackingGateway.cfc:103` |
| `rel:tcontent.siteid->tusersfavorites.siteid` | dao-join | `core/mura/content/favorite/favoriteManager.cfc:128` |
| `rel:tformresponsepackets.formid->tformresponsequestions.formid` | dao-join | `core/mura/settings/settingsBundle.cfc:1830` |
| `rel:tmailinglist.mlid->tmailinglistmembers.mlid` | dao-join | `core/mura/email/emailUtility.cfc:639` |
| `rel:tmailinglist.siteid->tmailinglistmembers.siteid` | dao-join | `core/mura/mailinglist/mailinglistGateway.cfc:99` |
| `rel:tplugindisplayobjects.moduleid->tplugins.moduleid` | dao-join | `core/mura/plugin/pluginManager.cfc:215` |
| `rel:tplugins.moduleid->tpluginscripts.moduleid` | dao-join | `core/mura/plugin/pluginManager.cfc:151` |
| `rel:tsessiontracking.originalurltoken->tsessiontracking.urltoken` | dao-join | `core/mura/user/sessionTracking/sessionTrackingGateway.cfc:170` |
| `rel:tsessiontracking.userid->tuseraddresses.userid` | dao-join | `core/mura/user/sessionTracking/sessionTrackingGateway.cfc:675` |

## Findings

| Kind | Id | Source | Detail |
| --- | --- | --- | --- |
| absent-entity-table | `ent:dynamic:filebrowser` | `core/modules/v1/filebrowser/model/beans/filebrowser.cfc:1-7` | filebrowser declares table m_filebrowser, which no tables[] entry lists; the entity writes nothing to it |
| correction | `api:address.delete` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3259-3335` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `api:address.save{extdata}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `api:checkschema` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:207-223` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tentity-declared:*) |
| correction | `api:content.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `api:content.save{approved=1}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `api:content.save{notify}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `api:contentnav.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `api:contentnav.save{approved=1}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `api:contentnav.save{notify}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:150-185` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `api:group.delete` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3259-3335` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `api:group.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `api:group.save{extdata}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `api:processasyncobject` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3823-4102` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `api:processasyncobject{saveform}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3823-4102` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `api:site.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `api:site.save{bundle}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `api:submitform` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:34` | AAP expects carry, the rule computes retired at step 1 (unreachable over HTTP or the scheduler at the pinned SHA) |
| correction | `api:undeclareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:187-205` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `api:user.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `api:user.save{extdata}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `ctl:carch.approvalaction{action=approve}` | `admin/core/views/carch/approvalaction.cfm:1-18` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.copy` | `admin/core/controllers/carch.cfc:508-511` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.displayobjectmodal` | `admin/core/views/carch/displayobjectmodal.cfm:1-40` | AAP expects carry, the rule computes legacy-served at step 4 (depends on the CFML runtime (theme-render)) |
| correction | `ctl:carch.frontendconfigurator` | `admin/core/views/carch/frontendconfigurator.cfm:1-650` | AAP expects carry, the rule computes legacy-served at step 4 (depends on the CFML runtime (theme-render)) |
| correction | `ctl:carch.import` | `admin/core/views/carch/import.cfm:1-190` | AAP expects carry, the rule computes legacy-served at step 4 (depends on the CFML runtime (bundle)) |
| correction | `ctl:carch.importcontent` | `admin/core/controllers/carch.cfc:134-152` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.loadrepomanager` | `admin/core/controllers/carch.cfc:246-248` | AAP expects carry, the rule computes legacy-served at step 4 (depends on the CFML runtime (framework-error)) |
| correction | `ctl:carch.savequickedit` | `admin/core/controllers/carch.cfc:254-283` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.update` | `admin/core/controllers/carch.cfc:336-451` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.updateobjectparams` | `admin/core/controllers/carch.cfc:546-573` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.updateobjectparams{approved=1}` | `admin/core/controllers/carch.cfc:546-573` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.update{approved=1}` | `admin/core/controllers/carch.cfc:336-451` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.update{notify}` | `admin/core/controllers/carch.cfc:336-451` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.update{upload=image}` | `admin/core/controllers/carch.cfc:336-451` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.variationtargeting` | `admin/core/views/carch/variationtargeting.cfm:1-71` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:carch.variationtargeting{notify}` | `admin/core/views/carch/variationtargeting.cfm:1-71` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:cchangesets.publish` | `admin/core/controllers/cchangesets.cfc:144-147` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:cchangesets.rollback` | `admin/core/controllers/cchangesets.cfc:149-154` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:ceditprofile.update{extdata}` | `admin/core/controllers/ceditprofile.cfc:124-141` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `ctl:cfeed.import2` | `admin/core/controllers/cfeed.cfc:148-150` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `ctl:clogin.login{status=sendlogin}` | `admin/core/controllers/clogin.cfc:101-113` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `ctl:clogin.main{status=sendlogin}` | `admin/core/controllers/clogin.cfc:95-99` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `ctl:cperm.update` | `admin/core/controllers/cperm.cfc:98-108` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `ctl:csettings.deleteplugin` | `admin/core/controllers/csettings.cfc:120-129` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tplugindisplayobjects) |
| correction | `ctl:csettings.deployplugin` | `admin/core/controllers/csettings.cfc:140-159` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tplugindisplayobjects) |
| correction | `ctl:csettings.updateplugin` | `admin/core/controllers/csettings.cfc:161-168` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tplugindisplayobjects) |
| correction | `ctl:csettings.updatesite{action=update}` | `admin/core/controllers/csettings.cfc:170-225` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `ctl:cusers.edituser` | `admin/core/controllers/cusers.cfc:243-261` | area owner people, computed owner identity (single owner identity among the migrated services) |
| correction | `ctl:cusers.updateaddress{action=delete}` | `admin/core/controllers/cusers.cfc:355-375` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `ctl:cusers.updateaddress{extdata}` | `admin/core/controllers/cusers.cfc:355-375` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `ctl:cusers.update{type=1,action=delete}` | `admin/core/controllers/cusers.cfc:290-353` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `ctl:cusers.update{type=1,extdata}` | `admin/core/controllers/cusers.cfc:290-353` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `ctl:cusers.update{type=2,action=add,extdata}` | `admin/core/controllers/cusers.cfc:290-353` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `ctl:cusers.update{type=2,action=update,extdata}` | `admin/core/controllers/cusers.cfc:290-353` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `ent:dyn:plugin-declared` | `core/mura/plugin/pluginConfig.cfc:370-380` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tentity-declared:*) |
| correction | `fe:appreload` | `core/appcfc/onRequestStart_include.cfm:115-138` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tclustercommands) |
| correction | `fe:doaction=contactsend` | `core/mura/Handler/standardEventsHandler.cfc:631-636` | AAP expects legacy-served, the rule computes retired at step 1 (unreachable over HTTP or the scheduler at the pinned SHA) |
| correction | `fe:doaction=createprofile` | `core/mura/Handler/standardEventsHandler.cfc:604-629` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `fe:doaction=setReminder` | `core/mura/Handler/standardEventsHandler.cfc:658-664` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `fe:doaction=updateprofile` | `core/mura/Handler/standardEventsHandler.cfc:565-602` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `fe:processasyncobject{saveform}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3823-4102` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `fe:render` | `core/mura/content/contentServer.cfc:779-799` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, reporting, strategies-content; no input names the owner) |
| correction | `fe:saveform` | `core/modules/v1/form/index.cfm:114-150` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `job:sitemonitor.changeset-publish` | `core/mura/content/contentServer.cfc:687` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) [AAP 0.3.2] |
| correction | `job:sitemonitor.feed-import` | `core/mura/content/contentServer.cfc:697-699` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) [AAP 0.3.2] |
| correction | `job:sitemonitor.plugin-events` | `core/mura/content/contentServer.cfc:737-743` | AAP expects decision, the rule computes legacy-served at step 4 (depends on the CFML runtime (plugin)) [AAP 0.3.2] |
| correction | `rest:address.delete` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3259-3335` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `rest:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `rest:address.save{extdata}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `rest:address.save{session}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `rest:address.save{siteid}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans people, strategies-content; no input names the owner) |
| correction | `rest:checkschema` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:207-223` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tentity-declared:*) |
| correction | `rest:content.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:content.save{approved=1}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:content.save{notify}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:content.save{session}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:content.save{siteid}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:contentnav.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:contentnav.save{approved=1}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:contentnav.save{notify}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:contentnav.save{session}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:contentnav.save{siteid}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tcontenteventreminders) |
| correction | `rest:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:150-185` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `rest:group.delete` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3259-3335` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `rest:group.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `rest:group.save{extdata}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `rest:group.save{session}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `rest:group.save{siteid}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, strategies-content; no input names the owner) |
| correction | `rest:processasyncobject` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3823-4102` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `rest:processasyncobject{saveform}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3823-4102` | AAP expects legacy-served, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `rest:site.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `rest:site.save{bundle}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `rest:submitform` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:34` | AAP expects carry, the rule computes retired at step 1 (unreachable over HTTP or the scheduler at the pinned SHA) |
| correction | `rest:undeclareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:187-205` | AAP expects legacy-served, the rule computes decision at step 2 (writes decision-list table tentity) |
| correction | `rest:user.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `rest:user.save{extdata}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `rest:user.save{session}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `rest:user.save{siteid}` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1903-2074` | AAP expects carry, the rule computes decision at step 3 (write set spans identity, people, strategies-content; no input names the owner) |
| correction | `rte:/_api/resource/variation` | `core/mura/content/contentServer.cfc:649-650` | AAP expects carry, the rule computes legacy-served at step 4 (renders CFML through the theme and display-object runtime) |
| correction | `tables.serializedColumns` | — | expected tcontentobjects.Params, tformresponsepackets.Data, toauthtokens.data, ttrash.objectstring; computed tcontent.objectParams, tcontentobjects.Params, tformresponsepackets.Data, toauthtokens.data, ttrash.objectstring |
| count-difference | `tables.withSiteId` | — | AAP 54, computed 55; siteID on 33 bootstrap, 4 migration and 18 ORM-only tables; inherited from a base component: tcontentfilemetadata (core/mura/bean/beanORMVersioned.cfc:80); live catalog 54, tables absent live: tremotepointer |
| unmatched-write | — | `core/mura/client/api/json/v1/jsonApiUtility.cfc:215` | core/mura/client/api/json/v1/jsonApiUtility.cfc#checkSchema writes tentity-declared:*, which no tables[] entry lists |
| unresolved-call | `api:address.delete` | `core/mura/MasaScope.cfc:177` | component reference themeRenderer.injectMethod (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/MasaScope.cfc:177` | component reference themeRenderer.injectMethod('$',event("muraScope")).injectMethod (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/MasaScope.cfc:177` | component reference themeRenderer.injectMethod('$',event("muraScope")).injectMethod('mura',event("muraScope")).injectMethod (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/MasaScope.cfc:178` | component reference themeRenderer.init (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:132` | bean reference bean.has (also reached from 740 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:138` | bean reference bean.getPrimaryKey (also reached from 740 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:364` | bean reference obj.setSiteID (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:367` | bean reference obj.getPrimaryKey (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:369` | bean reference obj.getPrimaryKey (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:372` | bean reference obj.loadBy (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:372` | bean reference obj.loadBy(argumentCollection=loadArgs).set (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:374` | bean reference obj.get (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:374` | bean reference obj.getPrimaryKey (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:384` | bean reference obj.get (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:384` | bean reference obj.getPrimaryKey (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:396` | bean reference obj.setSiteID (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:399` | bean reference obj.getPrimaryKey (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:401` | bean reference obj.getPrimaryKey (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:404` | bean reference obj.loadBy (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/bean.cfc:404` | bean reference obj.loadBy(argumentCollection=loadArgs).set (also reached from 739 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/beanFactory.cfc:120` | bean reference getBean(p.relatesto).getValue (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/ioc.cfc:91` | bean reference variables.parent.containsBean (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/ioc.cfc:682` | bean reference head.listener (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/ioc.cfc:684` | bean reference head.listener.onLoad (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/ioc.cfc:687` | bean reference getBean( head.listener ).onLoad (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/bean/ioc.cfc:689` | bean reference head.listener.toString (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/cache/cacheAbstract.cfc:151` | bean reference variables.collection.get (also reached from 428 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/cache/cacheAbstract.cfc:155` | bean reference cacheData.object.get (also reached from 428 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/cache/cacheAbstract.cfc:196` | bean reference variables.collection.put (also reached from 428 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/cache/cacheAbstract.cfc:219` | bean reference variables.collection.get (also reached from 428 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/cache/cacheAbstract.cfc:222` | bean reference cacheData.object.get (also reached from 428 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/cfobject.cfc:265` | method reference this.onMissingMethod (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/configBean.cfc:2029` | bean reference entity.registerAsEntity (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/configBean.cfc:2032` | bean reference entity.checkSchema (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/configBean.cfc:2036` | bean reference entity.getEntityName (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/configBean.cfc:2071` | bean reference entity.isOrm (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/configBean.cfc:2077` | bean reference entity.getEntityName (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/configBean.cfc:2118` | component reference createObject('component','#package#.#beanName#').init (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/configBean.cfc:2131` | component reference beanInstance.onApplicationLoad (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/content/contentRenderer.cfc:2762` | bean reference variables.m.event (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/content/contentRenderer.cfc:2762` | bean reference variables.m.event().setValue (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/content/contentRenderer.cfc:2763` | bean reference variables.m.announceEvent (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/content/contentRenderer.cfc:2767` | bean reference variables.m.event (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/content/contentRenderer.cfc:2767` | bean reference variables.m.event().setValue (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/content/contentRenderer.cfc:2768` | bean reference variables.m.announceEvent (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/extend/extendSubType.cfc:655-661` | table reference #getBaseTable()# (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1422` | method reference arguments.event.event (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1454` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1495` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1541` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1581` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1661` | method reference arguments.event.event (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1711` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1757` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1806` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1849` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:1893` | method reference getExecutor().executeScript (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:2868` | component reference createObject("component",componentPath).init (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:2870` | component reference createObject("component",componentPath).init (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:2877` | component reference createObject("component",componentPath).init (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/plugin/pluginManager.cfc:3132` | component reference eventHandler.init (also reached from 736 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/resourceBundle/resourceBundle.cfc:39` | bean reference variables.javaLocale.init (also reached from 485 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/resourceBundle/resourceBundleFactory.cfc:127` | bean reference variables.parentFactory.getKeyValue (also reached from 480 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/resourceBundle/resourceBundleFactory.cfc:137` | bean reference variables.parentFactory.getKeyValue (also reached from 480 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.delete` | `core/mura/resourceBundle/utils.cfc:152` | bean reference variables.thisLocale.getDisplayName (also reached from 485 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:655` | bean reference entity.getHasManyPropArray (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:657` | bean reference entity.getTable (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:657` | bean reference entity.translatePropKey (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:661` | bean reference entity.getHasOnePropArray (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:663` | bean reference entity.getTable (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:663` | bean reference entity.translatePropKey (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:673` | bean reference entity.getHasManyPropArray (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:675` | bean reference entity.getTable (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:675` | bean reference entity.getValue (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:675` | bean reference entity.translatePropKey (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:679` | bean reference entity.getHasOnePropArray (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:681` | bean reference entity.getTable (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:681` | bean reference entity.getValue (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanFeed.cfc:681` | bean reference entity.translatePropKey (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanIterator.cfc:101` | bean reference getBean(variables.entityName).set (also reached from 139 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanIterator.cfc:101` | bean reference getBean(variables.entityName).set(queryRowToStruct(variables.records,arguments.recordIndex)).setIsNew (also reached from 139 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/bean/beanIterator.cfc:107` | bean reference getBean(variables.entityName).set (also reached from 139 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1690` | bean reference arguments.bean.get (also reached from 295 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1694` | bean reference arguments.bean.getEntityName (also reached from 295 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1710` | bean reference arguments.bean.allowAccess (also reached from 295 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2764` | bean reference entity.getFeed (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2768` | bean reference entity.setType (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2772` | bean reference entity.allowQueryParams (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2776` | bean reference entity.getEntityName (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2794` | bean reference entity.getEntityName (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2853` | bean reference entity.getEntityName (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2854` | bean reference entity.getEntityName (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2867` | bean reference entity.valueExists (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2880` | bean reference entity.getEntityName (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2883` | bean reference entity.getPrimaryKey (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2887` | bean reference entity.hasProperty (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2887` | bean reference entity.valueExists (also reached from 229 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3045` | bean reference feed.getEntity().getTable (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3127` | bean reference getBean(arguments.feed.getEntityName()).getPrimaryKey (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3165` | bean reference arguments.iterator.setNextN (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3167` | bean reference arguments.iterator.setNextN (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3201` | bean reference entity.getPrimaryKey (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3208` | bean reference entity.loadBy (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3208` | bean reference entity.loadBy(argumentCollection=params).getCrumbIterator (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3219` | bean reference entity.getEntityName (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3222` | bean reference entity.getEntityName (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3225` | bean reference arguments.iterator.hasNext (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3226` | bean reference arguments.iterator.next (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3613` | bean reference variables.images.reset (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3641` | bean reference variables.images.reset (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/content/contentRenderer.cfc:3063` | bean reference variables.$.event (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/content/contentRenderer.cfc:3067` | bean reference variables.$.event (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/content/contentRenderer.cfc:3068` | bean reference variables.$.event (also reached from 261 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findall` | `core/mura/utility.cfc:490` | bean reference getPageContext().getRequest().getScheme (also reached from 315 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findone` | `core/mura/content/contentServer.cfc:884` | bean reference getpagecontext().getresponse().setcontenttype (also reached from 37 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findone` | `core/mura/content/contentServer.cfc:896` | bean reference getpagecontext().getresponse().setcontenttype (also reached from 37 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findone` | `core/mura/content/contentServer.cfc:904` | bean reference getpagecontext().getresponse().setcontenttype (also reached from 37 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.findone` | `core/mura/content/contentServer.cfc:912` | bean reference getpagecontext().getresponse().setcontenttype (also reached from 37 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1987` | bean reference currentCategories.hasNext (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1988` | bean reference currentCategories.hasNext (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1989` | bean reference currentCategories.next (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1989` | bean reference currentCategories.next().get (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2015` | bean reference currentCategories.hasNext (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2016` | bean reference currentCategories.hasNext (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2017` | bean reference currentCategories.next (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:2017` | bean reference currentCategories.next().get (also reached from 80 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/content/file/s3.cfc:323` | bean reference variables.awsSecret.getBytes (also reached from 93 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/resourceBundle/resourceBundle.cfc:177` | bean reference variables.msgFormat.init (also reached from 84 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:address.save` | `core/mura/resourceBundle/resourceBundle.cfc:188` | bean reference thisFormat.format (also reached from 84 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:checkschema` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:215` | bean reference getBean(arguments.entityname).checkSchema (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:172` | bean reference getBean(obj.entityname).getDynamic (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1552` | bean reference exampleEntity.setType (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1555` | bean reference exampleEntity.getProperties (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1587` | bean reference exampleEntity.getEntityName (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1588` | bean reference exampleEntity.getBundleable (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1589` | bean reference exampleEntity.getOrderBy (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1590` | bean reference exampleEntity.getIsHistorical (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1591` | bean reference exampleEntity.getDynamic (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1592` | bean reference exampleEntity.getscaffold (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1593` | bean reference exampleEntity.getEntityDisplayName (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1594` | bean reference exampleEntity.getPrimaryKey (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:declareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1612` | bean reference exampleEntity.getTable (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:group.delete` | `core/mura/bean/beanFeed.cfc:328` | bean reference getEntity().getDbUtility (also reached from 60 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:group.delete` | `core/mura/bean/beanFeed.cfc:778` | bean reference getEntity().getTable (also reached from 56 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:group.delete` | `core/mura/bean/beanFeed.cfc:927` | bean reference getEntity().getLoadSQLColumnsAndTables (also reached from 56 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:group.delete` | `core/mura/bean/beanFeed.cfc:929` | bean reference getEntity().getLoadSQLColumnsAndTables (also reached from 56 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:group.delete` | `core/mura/bean/beanFeed.cfc:940` | bean reference getEntity().getPrimaryKey (also reached from 56 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:group.delete` | `core/mura/cfobject.cfc:471` | bean reference getBean(argumentCollection=arguments).getFeed (also reached from 41 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:logout` | `core/mura/login/loginManager.cfc:503` | bean reference getPageContext().getSession (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:logout` | `core/mura/login/loginManager.cfc:504` | bean reference j2eeSession.invalidate (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:processasyncobject` | `core/mura/utility.cfc:555` | component reference CreateObject("component","cfformprotect.cffpVerify").init (also reached from 11 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:processasyncobject` | `core/mura/utility.cfc:565` | component reference cffp.testSubmission (also reached from 11 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:site.save` | `core/mura/publisher.cfc:1546` | bean reference application.confiBean.getFileDir (also reached from 7 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:site.save` | `core/mura/publisher.cfc:1549` | bean reference application.confiBean.getFileDir (also reached from 7 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:site.save` | `core/mura/publisher.cfc:3393` | component reference pluginCFC.init (also reached from 7 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:site.save` | `core/mura/publisher.cfc:3395` | component reference pluginCFC.fromBundle (also reached from 7 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:swagger` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:4481` | bean reference entity.setType (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:swagger` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:4484` | bean reference entity.getPrimaryKey (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:swagger` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:4486` | bean reference entity.getEntityName (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:swagger` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:4489` | bean reference entity.getPrimaryKey (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:undeclareentity` | `core/mura/bean/beanFactory.cfc:185` | bean reference entity.getDynamic (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:undeclareentity` | `core/mura/bean/beanFactory.cfc:185` | bean reference entity.getTable (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:undeclareentity` | `core/mura/bean/beanFactory.cfc:187` | bean reference entity.getTable (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:undeclareentity` | `core/mura/bean/beanFactory.cfc:191` | bean reference entity.getEntityName (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:undeclareentity` | `core/mura/bean/beanFactory.cfc:193` | bean reference entity.getEntityName (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `api:undeclareentity` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:194` | bean reference getBean(arguments.entityname).getDynamic (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `admin/core/views/carch/dsp_secondary_menu.cfm:309` | bean reference beanInstance.getEntityDisplayName (also reached from 12 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `admin/core/views/carch/dsp_secondary_menu.cfm:309` | bean reference beanInstance.pluralizeHasRefName (also reached from 12 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `admin/core/views/carch/dsp_secondary_menu.cfm:316` | bean reference beanInstance.getEntityDisplayName (also reached from 12 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `admin/core/views/carch/dsp_secondary_menu.cfm:316` | bean reference beanInstance.pluralizeHasRefName (also reached from 12 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `core/mura/plugin/pluginManager.cfc:2319` | method reference arguments.event.event (also reached from 35 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `core/mura/plugin/pluginManager.cfc:2447` | method reference getExecutor().renderScript (also reached from 35 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `core/mura/plugin/pluginManager.cfc:2573` | method reference getExecutor().renderScript (also reached from 35 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.audit` | `core/mura/plugin/pluginManager.cfc:2638` | method reference getExecutor().renderScript (also reached from 35 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.datamanager` | `admin/core/views/carch/datamanager.cfm:136` | include reference data_manager/dsp_ormform.cfm; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `admin/core/views/carch/edit_panels.cfm:220` | include reference form/dsp_panel_Remote.cfm (also reached from 4 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `admin/core/views/carch/form/dsp_panel_layoutobjects.cfm:239` | include reference /#application.configBean.getWebRootMap()#/#rc.siteID#/includes/display_objects/custom/admin/dsp_objectClassLabel.cfm (also reached from 4 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `core/mura/plugin/pluginManager.cfc:1972` | method reference arguments.event.event (also reached from 15 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `core/mura/plugin/pluginManager.cfc:2039` | method reference getExecutor().renderScript (also reached from 15 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `core/mura/plugin/pluginManager.cfc:2102` | method reference getExecutor().renderScript (also reached from 15 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `core/mura/plugin/pluginManager.cfc:2166` | method reference getExecutor().renderScript (also reached from 15 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `core/mura/plugin/pluginManager.cfc:2224` | method reference getExecutor().renderScript (also reached from 15 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `core/mura/plugin/pluginManager.cfc:2386` | method reference getExecutor().renderScript (also reached from 15 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.edit` | `core/mura/plugin/pluginManager.cfc:2513` | method reference getExecutor().renderScript (also reached from 15 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.export` | `admin/core/controllers/carch.cfc:119` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.export` | `admin/core/controllers/carch.cfc:121` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.exportcontent` | `core/mura/settings/settingsBundleBean.cfc:1818` | bean reference getBean(beanName=local.b,siteid=arguments.siteid).toBundle (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.exportcontent` | `core/mura/settings/settingsBundleBean.cfc:1870` | bean reference bean.toBundle (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.getaudittrail` | `admin/core/controllers/carch.cfc:638` | bean reference getpagecontext().getResponse().setContentType; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.getimagesizeurl` | `admin/core/controllers/carch.cfc:646` | bean reference getpagecontext().getResponse().setContentType; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.importcontent` | `admin/core/controllers/carch.cfc:136` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.importcontent` | `admin/core/controllers/carch.cfc:148` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.importcontent` | `admin/core/controllers/carch.cfc:150` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loadclass` | `admin/core/views/carch/loadclass.cfm:103` | include reference objectclass/legacy/dsp_Folders.cfm; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loadclass` | `admin/core/views/carch/loadclass.cfm:130` | include reference /#application.configBean.getWebRootMap()#/#rc.siteID#/includes/display_objects/custom/admin/dsp_objectClass.cfm; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loadclassconfigurator` | `admin/core/views/carch/loadclassconfigurator.cfm:157` | include reference #configFile#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loaddiff` | `core/mura/diffMatchPatch.cfc:16` | bean reference variables.diff_match_patch.diff_cleanupSemantic; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loaddiff` | `core/mura/diffMatchPatch.cfc:20` | bean reference variables.diff_match_patch.diff_prettyHTML; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loaddiff` | `core/mura/diffMatchPatch.cfc:21` | bean reference variables.diff_match_patch.diff_text1; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loaddiff` | `core/mura/diffMatchPatch.cfc:22` | bean reference variables.diff_match_patch.diff_text2; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loadrelatedcontent` | `admin/core/views/carch/loadrelatedcontent.cfm:487` | bean reference sample.getSearchableProps; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loadrelatedcontent` | `admin/core/views/carch/loadrelatedcontent.cfm:515` | bean reference sample.getListViewProps; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.loadselectedrelatedcontent` | `admin/core/views/carch/loadselectedrelatedcontent.cfm:131` | bean reference sample.getListViewProps; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.update` | `admin/core/controllers/carch.cfc:427` | bean reference variables.fw.redirect (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.update` | `admin/core/controllers/carch.cfc:430` | bean reference variables.fw.redirect (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.update` | `admin/core/controllers/carch.cfc:438` | bean reference variables.fw.redirect (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:carch.update` | `admin/core/controllers/carch.cfc:446` | bean reference variables.fw.redirect (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccategory.update` | `admin/core/controllers/ccategory.cfc:117` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchain.delete` | `admin/core/controllers/cchain.cfc:120` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchain.save` | `admin/core/controllers/cchain.cfc:104` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchain.save` | `admin/core/controllers/cchain.cfc:112` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchangesets.delete` | `admin/core/controllers/cchangesets.cfc:191` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchangesets.publish` | `admin/core/controllers/cchangesets.cfc:146` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchangesets.removeitem` | `admin/core/controllers/cchangesets.cfc:170` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchangesets.rollback` | `admin/core/controllers/cchangesets.cfc:153` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cchangesets.save` | `admin/core/controllers/cchangesets.cfc:183` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccomments.approve` | `admin/core/controllers/ccomments.cfc:175` | bean reference getFW().redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccomments.bulkedit` | `admin/core/controllers/ccomments.cfc:138` | bean reference getFW().setView; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccomments.delete` | `admin/core/controllers/ccomments.cfc:193` | bean reference getFW().redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccomments.markasspam` | `admin/core/controllers/ccomments.cfc:201` | bean reference getFW().redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccomments.purgedeletedcomments` | `admin/core/controllers/ccomments.cfc:357` | bean reference getFW().redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccomments.singleedit` | `admin/core/controllers/ccomments.cfc:166` | bean reference getFW().setView; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ccomments.unapprove` | `admin/core/controllers/ccomments.cfc:184` | bean reference getFW().redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ceditprofile.update` | `admin/core/controllers/ceditprofile.cfc:138` | bean reference variables.fw.redirect (also reached from 2 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cemail.update` | `admin/core/controllers/cemail.cfc:122` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cemail.update` | `core/mura/email/emailUtility.cfc:229` | include reference #template# (also reached from 2 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cemail.update` | `core/mura/email/emailUtility.cfc:254` | include reference #template# (also reached from 2 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cextend.exportsubtype` | `admin/core/controllers/cextend.cfc:96` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cextend.importsubtypes` | `admin/core/controllers/cextend.cfc:111` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cextend.updaterelatedcontentset` | `admin/core/controllers/cextend.cfc:196` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cextend.updatesubtype` | `core/mura/extend/extendSubType.cfc:742-746` | table reference #getBaseTable()#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cfeed.update` | `admin/core/controllers/cfeed.cfc:137` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cfeed.update` | `admin/core/controllers/cfeed.cfc:144` | bean reference variables.fw.redirect (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cform.getdialog` | `core/mura/formBuilder/formBuilderManager.cfc:237` | include reference #templatePath#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cform.getfieldtemplate` | `core/mura/formBuilder/formBuilderManager.cfc:210` | include reference #templatePath#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:clogin.login` | `admin/core/controllers/clogin.cfc:111` | bean reference variables.fw.redirect (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:clogin.logout` | `admin/core/controllers/clogin.cfc:117` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:clogin.main` | `admin/core/controllers/clogin.cfc:97` | bean reference variables.fw.redirect (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cmailinglist.update` | `admin/core/controllers/cmailinglist.cfc:115` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cmailinglist.update` | `admin/core/controllers/cmailinglist.cfc:117` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cmailinglist.updatemember` | `admin/core/controllers/cmailinglist.cfc:128` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.update` | `admin/core/controllers/cperm.cfc:107` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:124` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:127` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:130` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:133` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:136` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:141` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:144` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:147` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:150` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:153` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:157` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cperm.updatemodule` | `admin/core/controllers/cperm.cfc:159` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.createbundle` | `admin/core/controllers/csettings.cfc:260` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.createbundle` | `admin/core/controllers/csettings.cfc:262` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.deleteplugin` | `core/mura/plugin/pluginManager.cfc:897` | include reference /plugins/#arguments.pluginDir#/plugin/config.xml.cfm (also reached from 4 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.deleteplugin` | `core/mura/plugin/pluginManager.cfc:1260` | component reference pluginCFC.init; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.deleteplugin` | `core/mura/plugin/pluginManager.cfc:1264` | component reference pluginCFC.delete; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.deployplugin` | `admin/core/controllers/csettings.cfc:149` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.deployplugin` | `admin/core/controllers/csettings.cfc:152` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.list` | `admin/core/controllers/csettings.cfc:106` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.list` | `core/mura/autoUpdater/autoUpdater.cfc:217` | include reference coreUpdates/#rsCoreUpdates.name#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.sitecopy` | `admin/core/controllers/csettings.cfc:239` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.updateplugin` | `core/mura/plugin/pluginManager.cfc:1127` | component reference pluginCFC.init (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.updateplugin` | `core/mura/plugin/pluginManager.cfc:1132` | component reference pluginCFC.update (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.updateplugin` | `core/mura/plugin/pluginManager.cfc:1136` | component reference pluginCFC.install (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.updatesite` | `admin/core/controllers/csettings.cfc:221` | bean reference variables.fw.redirect (also reached from 4 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.updatesite` | `admin/core/controllers/csettings.cfc:223` | bean reference variables.fw.redirect (also reached from 4 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.updatesite{action=add}` | `admin/core/controllers/csettings.cfc:203` | bean reference variables.fw.redirect (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:csettings.updatesite{action=update}` | `admin/core/controllers/csettings.cfc:186` | bean reference variables.fw.redirect (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ctrash.empty` | `admin/core/controllers/ctrash.cfc:105` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:ctrash.restore` | `core/mura/trash/trashManager.cfc:315` | bean reference retrieved.setAllValues; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.addtogroup` | `admin/core/controllers/cusers.cfc:388` | bean reference variables.fw.redirect (also reached from 11 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.addtogroup` | `admin/core/controllers/cusers.cfc:394` | bean reference variables.fw.redirect (also reached from 11 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.addtogroup` | `admin/core/controllers/cusers.cfc:397` | bean reference variables.fw.redirect (also reached from 11 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.advancedsearch` | `admin/core/controllers/cusers.cfc:443` | bean reference getPageContext().getRequest().getParameterMap; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.advancedsearchtocsv` | `admin/core/controllers/cusers.cfc:455` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.default` | `admin/core/controllers/cusers.cfc:175` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.downloadgroupmembers` | `admin/core/controllers/cusers.cfc:269` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.removefromgroup` | `admin/core/controllers/cusers.cfc:281` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.update` | `admin/core/controllers/cusers.cfc:351` | bean reference variables.fw.redirect (also reached from 5 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.updateaddress` | `admin/core/controllers/cusers.cfc:371` | bean reference variables.fw.redirect (also reached from 2 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.updateaddress` | `admin/core/controllers/cusers.cfc:373` | bean reference variables.fw.redirect (also reached from 2 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cusers.update{photo}` | `admin/core/controllers/cusers.cfc:348` | bean reference variables.fw.redirect (also reached from 2 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cwebservice.delete` | `admin/core/controllers/cwebservice.cfc:123` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cwebservice.save` | `admin/core/controllers/cwebservice.cfc:103` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:cwebservice.save` | `admin/core/controllers/cwebservice.cfc:113` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:home.redirect` | `admin/core/controllers/home.cfc:93` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:home.redirect` | `admin/core/controllers/home.cfc:118` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:home.redirect` | `admin/core/controllers/home.cfc:122` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:home.redirect` | `admin/core/controllers/home.cfc:126` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `ctl:home.redirect` | `admin/core/controllers/home.cfc:128` | bean reference variables.fw.redirect; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:appreload` | `core/mura/configBean.cfc:976` | include reference dbUpdates/#rsUpdates.name#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:doaction=forwardEmail` | `core/mura/email/emailUtility.cfc:395` | include reference #template#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:doaction=forwardEmail` | `core/mura/email/emailUtility.cfc:418` | include reference #template#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:doaction=login` | `core/mura/Handler/standardEventsHandler.cfc:542` | component reference createObject("component","#application.configBean.getWebRootMap()#.#arguments.event.getValue('siteid')#.includes.loginHandler").init().handleLogin; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:doaction=login` | `core/mura/Handler/standardEventsHandler.cfc:542` | component reference createObject("component","#application.configBean.getWebRootMap()#.#arguments.event.getValue('siteid')#.includes.loginHandler").init; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/Handler/standardEventsHandler.cfc:93` | include reference /muraWRM/config/lockdown.cfm; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/Handler/standardEventsHandler.cfc:986` | bean reference getpagecontext().getresponse().setcontenttype; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/Translator/standardHTMLTranslator.cfc:130` | include reference #arguments.event.getSite().getTemplateIncludePath()#/#renderer.getTemplate()#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/contentRenderer.cfc:2910` | bean reference variables.$.content; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/contentRenderer.cfc:2924` | include reference /#application.configBean.getWebRootMap()##application.configBean.getAdminDir()#/core/utilities/modal/toolbar.cfm; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/contentRenderer.cfc:2952` | include reference #lookupData.filePath#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/file/renderLucee.cfc:85` | bean reference context.getResponse (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/file/renderLucee.cfc:86` | bean reference response.getOutputStream (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/file/renderLucee.cfc:87` | bean reference response.setContentType (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/file/renderLucee.cfc:88` | bean reference response.setContentLength (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/file/renderLucee.cfc:89` | bean reference out.write (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/file/renderLucee.cfc:90` | bean reference out.flush (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/mura/content/file/renderLucee.cfc:92` | bean reference out.close (also reached from 3 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/templates/lockdown.cfm:200` | bean reference $.getBean('googleLoginProvider').generateAuthUrl; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/templates/lockdown.cfm:209` | bean reference $.getBean('facebookLoginProvider').generateAuthUrl; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/templates/lockdown.cfm:218` | bean reference $.getBean('githubLoginProvider').generateAuthUrl; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fe:render` | `core/templates/lockdown.cfm:227` | bean reference $.getBean('azureadLoginProvider').generateAuthUrl; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:communications/messages/{id}@get` | `legacy-fixtures/cfml/lib/auth.cfc:22` | component reference new mura.user.sessionUserFacade (also reached from 45 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:communications/messages/{id}@get` | `legacy-fixtures/cfml/lib/auth.cfc:109` | component reference createObject("component", "mura.MasaScope").init (also reached from 45 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:278` | bean reference application.settingsManager.getSite; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:279` | bean reference application.userManager.read; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:280` | bean reference local.user.getIsNew; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:280` | bean reference local.user.getType; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:281` | bean reference local.site.getPrivateUserPoolID; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:281` | bean reference local.site.getPublicUserPoolID; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:281` | bean reference local.user.getSiteID; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:esignature/requests@post` | `legacy-fixtures/cfml/modules/esignature.cfc:284` | bean reference local.user.getUserID; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:finance/records/{id}/approve@post` | `legacy-fixtures/cfml/lib/auth.cfc:46` | bean reference application.configBean.getReadOnlyQRYAttrs (also reached from 20 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:80` | bean reference application.userManager.read (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:81` | bean reference application.settingsManager.getSite (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:82` | bean reference local.user.getIsNew (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:83` | bean reference local.user.getType (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:84` | bean reference local.site.getPublicUserPoolID (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:84` | bean reference local.user.getSiteID (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:85` | bean reference local.site.getPrivateUserPoolID (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:people/persons/{id}/archive@get` | `legacy-fixtures/cfml/modules/people.cfc:85` | bean reference local.user.getSiteID (also reached from 1 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:surveys/surveys/{id}/responses@post` | `legacy-fixtures/cfml/lib/auth.cfc:131` | bean reference application.settingsManager.getSite(request.siteid).getPublicUserPoolID; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:surveys/surveys/{id}/responses@post` | `legacy-fixtures/cfml/lib/auth.cfc:131` | bean reference application.settingsManager.getSite; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:surveys/surveys/{id}/targets/bulk@post` | `legacy-fixtures/cfml/modules/surveys.cfc:274` | bean reference application.settingsManager.siteExists; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:surveys/surveys/{id}/targets/bulk@post` | `legacy-fixtures/cfml/modules/surveys.cfc:279` | bean reference application.settingsManager.getSite(local.target.siteID).getSiteID; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `fix:surveys/surveys/{id}/targets/bulk@post` | `legacy-fixtures/cfml/modules/surveys.cfc:279` | bean reference application.settingsManager.getSite; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:77` | bean reference getpagecontext().getresponse; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:107` | bean reference responseObject.setcontenttype; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:109` | bean reference responseObject.setcontenttype; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:139` | bean reference getpagecontext().getresponse().setStatus; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:149` | bean reference responseObject.setStatus; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:154` | bean reference responseObject.setStatus; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:159` | bean reference responseObject.setStatus; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:164` | bean reference responseObject.setStatus; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:169` | bean reference responseObject.setStatus; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/feed/v1` | `core/mura/client/api/feed/v1/feedApiUtility.cfc:175` | bean reference responseObject.getresponse().setStatus; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/_api/resource/variation` | `core/mura/executor.cfc:7` | include reference #filepath#; settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/oauth` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1472` | bean reference getpagecontext().getResponse (also reached from 8 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/oauth` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1473` | bean reference responseObject.setContentType (also reached from 8 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/oauth` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1476` | bean reference responseObject.setStatus (also reached from 8 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/oauth` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1478` | bean reference responseObject.setStatus (also reached from 8 more); settle it in harness/inventory/writer-overrides.yaml |
| unresolved-call | `rte:/oauth` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:1501` | bean reference responseObject.setContentType (also reached from 8 more); settle it in harness/inventory/writer-overrides.yaml |
