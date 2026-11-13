# Legacy inventory (Masa CMS 7.6.1)

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f
Extracted from: git archive 696383140578f8dea3ece26f80cd7bfb370ddf0f · generator: harness/src/inventory · live fields: pending-run

## Counts

| Section | Item | Count |
| --- | --- | --- |
| entities | orm-base | 4 |
| entities | orm-concrete | 24 |
| entities | not-entity | 1 |
| entities | domain-bean | 35 |
| entities | dynamic | pending-run |
| entities | dynamicPatterns | 3 |
| ormTables | concrete | 24 |
| ormTables | ormOnly | 21 |
| services | registeredSingletons | 123 |
| services | serviceList | 26 |
| services | transient | 86 |
| services | aliases | 59 |
| controllers | circuits | 25 |
| controllers | base | 1 |
| controllers | actions | 219 |
| controllers | viewOnlyActions | 74 |
| controllers | variants | 243 |
| coreMuraActionFiles | — | 21 |
| frontEnd | — | 27 |
| scheduledJobs | jobs | 1 |
| scheduledJobs | siteMonitorSteps | 8 |
| routes | families | 13 |
| routes | apiEntityMethods | 382 |
| routes | apiMethods | 34 |
| routes | oauth | 3 |
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
| tables | testSuite | 2 |
| tables | dynamicPatterns | 2 |
| tables | live | pending-run |
| tables | withSiteIdLive | pending-run |
| relations | — | 121 |
| storedProcedures | static | 0 |
| storedProcedures | live | pending-run |
| dispositions | carry | 754 |
| dispositions | legacy-served | 150 |
| dispositions | decision | 136 |
| dispositions | retired | 21 |
| notes | withSiteIdStatic | Counts tcontentfilemetadata, whose siteID comes from the beanORMVersioned base, and tremotepointer, which an install creates lazily; a fresh live catalog shows one fewer. |
| notes | dispositions | Tallied over controller variants, frontEnd entries, site-monitor steps, routes, entities, services and tables. |

## Admin controllers

| Id | Route key | Owner | Disposition (step) | CSRF | Response mode |
| --- | --- | --- | --- | --- | --- |
| `ctl:carch.approvalaction{action=approve}` | `admin:carch.approvalaction{action=approve}` | strategies-content | carry (5) | bypassed `approvalaction` | json (application/json) |
| `ctl:carch.approvalaction` | `admin:carch.approvalaction` | strategies-content | carry (5) | bypassed `approvalaction` | json (application/json) |
| `ctl:carch.assocfiles` | `admin:carch.assocfiles` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.audit` | `admin:carch.audit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.availablechangesets` | `admin:carch.availablechangesets` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.copy` | `admin:carch.copy` | spans identity, strategies-content | decision (3) (corrected; expected carry) | none | json (application/json) |
| `ctl:carch.cropimage` | `admin:carch.cropimage` | strategies-content | carry (5) `EX-FILE-RENDITION` | validates `rc.fileid` | page (text/html) |
| `ctl:carch.datamanager` | `admin:carch.datamanager` | strategies-content | carry (5) | validates `rc.responseid` | page (text/html) |
| `ctl:carch.displayobjectmodal` | `admin:carch.displayobjectmodal` | strategies-content | legacy-served (4) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.downloaddata` | `admin:carch.downloaddata` | strategies-content | carry (5) | none | download (application/msexcel) |
| `ctl:carch.draft` | `admin:carch.draft` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.draftpromptdata` | `admin:carch.draftpromptdata` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.edit` | `admin:carch.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.editlive` | `admin:carch.editlive` | strategies-content | carry (5) | none | redirect |
| `ctl:carch.edittext` | `admin:carch.edittext` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.emailtest` | `admin:carch.emailtest` | communications | legacy-served (4) | validates `testEmail` | fragment (text/html) |
| `ctl:carch.export` | `admin:carch.export` | strategies-content | legacy-served (4) | none | page (text/html) |
| `ctl:carch.exportcomponent` | `admin:carch.exportcomponent` | strategies-content | legacy-served (4) | none | download (application/zip) |
| `ctl:carch.exportcontent` | `admin:carch.exportcontent` | strategies-content | legacy-served (4) | none | redirect |
| `ctl:carch.flipimage` | `admin:carch.flipimage` | strategies-content | carry (5) `EX-FILE-RENDITION` | validates `rc.fileid` | page (text/html) |
| `ctl:carch.frontendconfigurator` | `admin:carch.frontendconfigurator` | strategies-content | legacy-served (4) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.getaudittrail` | `admin:carch.getaudittrail` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.getimagesizeurl` | `admin:carch.getimagesizeurl` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.hist` | `admin:carch.hist` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.imagedetails` | `admin:carch.imagedetails` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.import` | `admin:carch.import` | strategies-content | legacy-served (4) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.importcomponent` | `admin:carch.importcomponent` | spans identity, strategies-content | decision (2) (corrected; expected legacy-served) | none | page (text/html) |
| `ctl:carch.importcontent` | `admin:carch.importcontent` | spans communications, identity, people, programs-sites, strategies-content | decision (2) (corrected; expected legacy-served) | validates `rc.contentid` | redirect |
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
| `ctl:carch.loadsiteflat` | `admin:carch.loadsiteflat` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.loadsitemanager` | `admin:carch.loadsitemanager` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.loadsitesection` | `admin:carch.loadsitesection` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.loadtagarray` | `admin:carch.loadtagarray` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.lockcheck` | `admin:carch.lockcheck` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.lockfile` | `admin:carch.lockfile` | strategies-content | carry (5) | validates `rc.contentid & "lockfile"` | json (application/json) |
| `ctl:carch.multifileupload{upload=image}` | `admin:carch.multifileupload{upload=image}` | strategies-content | carry (5) `EX-FILE-RENDITION` | none | page (text/html) |
| `ctl:carch.multifileupload` | `admin:carch.multifileupload` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.refreshsitesection` | `admin:carch.refreshsitesection` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.relatedcontent` | `admin:carch.relatedcontent` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.rotateimage` | `admin:carch.rotateimage` | strategies-content | carry (5) `EX-FILE-RENDITION` | validates `rc.fileid` | page (text/html) |
| `ctl:carch.savecopyinfo` | `admin:carch.savecopyinfo` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.savequickedit` | `admin:carch.savequickedit` | strategies-content | carry (5) | validates `rc.contentid & "quickedit"` | json (application/json) |
| `ctl:carch.search` | `admin:carch.search` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.selectfields` | `admin:carch.selectfields` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.selectmedia` | `admin:carch.selectmedia` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:carch.sitemanagertab` | `admin:carch.sitemanagertab` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:carch.siteparents` | `admin:carch.siteparents` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.statusmodal` | `admin:carch.statusmodal` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:carch.unlockfile` | `admin:carch.unlockfile` | strategies-content | carry (5) | validates `rc.contentid & "unlockfile"` | json (application/json) |
| `ctl:carch.unlocknode` | `admin:carch.unlocknode` | strategies-content | carry (5) | validates `rc.contentid & "unlocknode"` | json (application/json) |
| `ctl:carch.update{upload=image}` | `admin:carch.update{upload=image}` | spans identity, strategies-content | decision (2) (corrected; expected carry) `EX-FILE-RENDITION` | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.update{approved=1}` | `admin:carch.update{approved=1}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.update{notify}` | `admin:carch.update{notify}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.update` | `admin:carch.update` | strategies-content | carry (5) | validates `rc.contentid & "deleteall" \| rc.contentid & "deletehistall" \| rc.contenthistid & "delete" \| rc.contentBean.getContentHistID() & "add" \| rc.parentid & "multifileupload"` | fragment (text/html) |
| `ctl:carch.updateobjectparams{approved=1}` | `admin:carch.updateobjectparams{approved=1}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | none | json (text/html) |
| `ctl:carch.updateobjectparams` | `admin:carch.updateobjectparams` | strategies-content | carry (5) | none | json (text/html) |
| `ctl:carch.variationtargeting{notify}` | `admin:carch.variationtargeting{notify}` | spans identity, strategies-content | decision (3) (corrected; expected carry) | none | page (text/html) |
| `ctl:carch.variationtargeting` | `admin:carch.variationtargeting` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:ccategory.edit` | `admin:ccategory.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:ccategory.list` | `admin:ccategory.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:ccategory.update` | `admin:ccategory.update` | strategies-content | carry (5) | validates `rc.categoryid` | page (text/html) |
| `ctl:cchain.delete` | `admin:cchain.delete` | strategies-content | carry (5) | validates `rc.chainid` | redirect |
| `ctl:cchain.list` | `admin:cchain.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchain.pending` | `admin:cchain.pending` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchain.save` | `admin:cchain.save` | strategies-content | carry (5) | validates `rc.chainid` | redirect |
| `ctl:cchain.update` | `admin:cchain.update` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.assignments` | `admin:cchangesets.assignments` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.delete` | `admin:cchangesets.delete` | strategies-content | carry (5) | validates `rc.changesetid` | redirect |
| `ctl:cchangesets.edit` | `admin:cchangesets.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.list` | `admin:cchangesets.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cchangesets.loadtagarray` | `admin:cchangesets.loadtagarray` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cchangesets.publish` | `admin:cchangesets.publish` | strategies-content | decision (2) (corrected; expected carry) | none | redirect |
| `ctl:cchangesets.removeitem` | `admin:cchangesets.removeitem` | strategies-content | carry (5) | validates `rc.changesetid` | redirect |
| `ctl:cchangesets.rollback` | `admin:cchangesets.rollback` | strategies-content | carry (5) | validates `rc.changesetid` | redirect |
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
| `ctl:cdashboard.dismissalert` | `admin:cdashboard.dismissalert` | reporting | legacy-served (4) | none | json (application/json) |
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
| `ctl:ceditprofile.edit` | `admin:ceditprofile.edit` | identity | carry (5) (corrected; expected carry) | none | page (text/html) |
| `ctl:ceditprofile.update{photo}` | `admin:ceditprofile.update{photo}` | people | decision (3) | validates | page (text/html) |
| `ctl:ceditprofile.update{extdata}` | `admin:ceditprofile.update{extdata}` | spans identity, people, strategies-content | decision (3) (corrected; expected carry) | validates | page (text/html) |
| `ctl:ceditprofile.update` | `admin:ceditprofile.update` | people | carry (5) | validates | page (text/html) |
| `ctl:cemail.deletebounces` | `admin:cemail.deletebounces` | communications | legacy-served (4) | none | redirect |
| `ctl:cemail.download` | `admin:cemail.download` | communications | legacy-served (4) | none | download (application/msexcel) |
| `ctl:cemail.edit` | `admin:cemail.edit` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.list` | `admin:cemail.list` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.showallbounces` | `admin:cemail.showallbounces` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.showbounces` | `admin:cemail.showbounces` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.showreturns` | `admin:cemail.showreturns` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.sitelist` | `admin:cemail.sitelist` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cemail.update` | `admin:cemail.update` | communications | legacy-served (4) | none | redirect |
| `ctl:cextend.download` | `admin:cextend.download` | — | decision (3) | none | download (application/xml) |
| `ctl:cextend.editattributes` | `admin:cextend.editattributes` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.editrelatedcontentset` | `admin:cextend.editrelatedcontentset` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.editset` | `admin:cextend.editset` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.editsubtype` | `admin:cextend.editsubtype` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.export` | `admin:cextend.export` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.exportsubtype` | `admin:cextend.exportsubtype` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.importsubtypes` | `admin:cextend.importsubtypes` | spans communications, identity, people, programs-sites, strategies-content | decision (2) | validates `import` | page (text/html) |
| `ctl:cextend.listsets` | `admin:cextend.listsets` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.listsubtypes` | `admin:cextend.listsubtypes` | — | decision (3) | none | page (text/html) |
| `ctl:cextend.saveattributesort` | `admin:cextend.saveattributesort` | spans people, programs-sites, strategies-content | decision (3) | none | json (application/json) |
| `ctl:cextend.saveextendsetsort` | `admin:cextend.saveextendsetsort` | spans people, programs-sites, strategies-content | decision (3) | none | json (application/json) |
| `ctl:cextend.saverelatedsetsort` | `admin:cextend.saverelatedsetsort` | spans people, programs-sites, strategies-content | decision (3) | none | json (application/json) |
| `ctl:cextend.updateattribute` | `admin:cextend.updateattribute` | spans identity, people, programs-sites, strategies-content | decision (3) | validates `rc.attributeid` | redirect |
| `ctl:cextend.updaterelatedcontentset` | `admin:cextend.updaterelatedcontentset` | spans people, programs-sites, strategies-content | decision (3) | validates `rc.relatedContentSetID` | redirect |
| `ctl:cextend.updateset` | `admin:cextend.updateset` | spans identity, people, programs-sites, strategies-content | decision (3) | validates `rc.extendsetid` | redirect |
| `ctl:cextend.updatesubtype` | `admin:cextend.updatesubtype` | spans identity, people, programs-sites, strategies-content | decision (3) | validates `rc.subtypeid` | redirect |
| `ctl:cfeed.edit` | `admin:cfeed.edit` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cfeed.import1` | `admin:cfeed.import1` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cfeed.import2` | `admin:cfeed.import2` | strategies-content | decision (2) (corrected; expected carry) | none | page (text/html) |
| `ctl:cfeed.list` | `admin:cfeed.list` | strategies-content | carry (5) | none | page (text/html) |
| `ctl:cfeed.loadsite` | `admin:cfeed.loadsite` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cfeed.siteparents` | `admin:cfeed.siteparents` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cfeed.update` | `admin:cfeed.update` | strategies-content | carry (5) | validates `rc.feedid` | fragment (text/html) |
| `ctl:cfilemanager.default` | `admin:cfilemanager.default` | strategies-content | legacy-served (4) | none | page (text/html) |
| `ctl:cform.export` | `admin:cform.export` | strategies-content | carry (5) | none | download (application/zip) |
| `ctl:cform.getdataset` | `admin:cform.getdataset` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.getdialog` | `admin:cform.getdialog` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cform.getfield` | `admin:cform.getfield` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.getfieldtemplate` | `admin:cform.getfieldtemplate` | strategies-content | carry (5) | none | fragment (text/html) |
| `ctl:cform.getfieldtype` | `admin:cform.getfieldtype` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.getform` | `admin:cform.getform` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cform.importform` | `admin:cform.importform` | strategies-content | carry (5) | validates `formimport` | redirect |
| `ctl:clogin.login` | `admin:clogin.login` | identity | carry (5) | validates `login` | page (text/html) |
| `ctl:clogin.logout` | `admin:clogin.logout` | identity | carry (5) | none | redirect |
| `ctl:clogin.main` | `admin:clogin.main` | identity | carry (5) | none | page (text/html) |
| `ctl:cmailinglist.download` | `admin:cmailinglist.download` | communications | legacy-served (4) | none | download (text/plain) |
| `ctl:cmailinglist.edit` | `admin:cmailinglist.edit` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cmailinglist.list` | `admin:cmailinglist.list` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cmailinglist.listmembers` | `admin:cmailinglist.listmembers` | communications | legacy-served (4) | none | page (text/html) |
| `ctl:cmailinglist.update` | `admin:cmailinglist.update` | communications | legacy-served (4) | none | redirect |
| `ctl:cmailinglist.updatemember` | `admin:cmailinglist.updatemember` | communications | legacy-served (4) | none | redirect |
| `ctl:cmessage.noaccess` | `admin:cmessage.noaccess` | identity | carry (5) | none | page (text/html) |
| `ctl:cnav.searchsitedata` | `admin:cnav.searchsitedata` | strategies-content | carry (5) | none | json (application/json) |
| `ctl:cperm.main` | `admin:cperm.main` | identity | carry (5) | none | page (text/html) |
| `ctl:cperm.module` | `admin:cperm.module` | identity | carry (5) | none | page (text/html) |
| `ctl:cperm.update` | `admin:cperm.update` | spans identity, strategies-content | decision (3) (corrected; expected carry) | validates `rc.contentid` | redirect |
| `ctl:cperm.updatemodule` | `admin:cperm.updatemodule` | identity | carry (5) | validates `rc.moduleid` | redirect |
| `ctl:cplugins.list` | `admin:cplugins.list` | — | legacy-served (4) (corrected; expected decision) | none | page (text/html) |
| `ctl:csettings.createbundle` | `admin:csettings.createbundle` | strategies-content | legacy-served (4) | validates `csrfContext` | page (text/html) |
| `ctl:csettings.deleteplugin` | `admin:csettings.deleteplugin` | strategies-content | decision (2) (corrected; expected legacy-served) | validates `rc.moduleid` | redirect |
| `ctl:csettings.deploybundle` | `admin:csettings.deploybundle` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.deployplugin` | `admin:csettings.deployplugin` | spans communications, identity, people, programs-sites, strategies-content | decision (2) (corrected; expected legacy-served) | validates `rc.moduleid \| newplugin` | redirect |
| `ctl:csettings.editplugin` | `admin:csettings.editplugin` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.editsite` | `admin:csettings.editsite` | programs-sites | carry (5) | none | page (text/html) |
| `ctl:csettings.exporthtml` | `admin:csettings.exporthtml` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.list` | `admin:csettings.list` | programs-sites | carry (5) | validates `updatesites \| updatecore` | page (text/html) |
| `ctl:csettings.loadcustomimage` | `admin:csettings.loadcustomimage` | programs-sites | carry (5) | none | fragment (text/html) |
| `ctl:csettings.loadcustomimages` | `admin:csettings.loadcustomimages` | programs-sites | carry (5) | none | fragment (text/html) |
| `ctl:csettings.selectbundleoptions` | `admin:csettings.selectbundleoptions` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.sitecopy` | `admin:csettings.sitecopy` | programs-sites | decision (2) | validates `sitecopy` | redirect |
| `ctl:csettings.sitecopyresult` | `admin:csettings.sitecopyresult` | programs-sites | carry (5) | none | page (text/html) |
| `ctl:csettings.sitecopyselect` | `admin:csettings.sitecopyselect` | programs-sites | decision (3) | none | page (text/html) |
| `ctl:csettings.updateplugin` | `admin:csettings.updateplugin` | spans communications, identity, people, programs-sites, strategies-content | decision (2) (corrected; expected legacy-served) | validates `rc.moduleid` | redirect |
| `ctl:csettings.updatepluginversion` | `admin:csettings.updatepluginversion` | programs-sites | legacy-served (4) | none | page (text/html) |
| `ctl:csettings.updatesite{bundle}` | `admin:csettings.updatesite{bundle}` | spans communications, identity, people, programs-sites, reporting, strategies-content | decision (2) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite{action=add}` | `admin:csettings.updatesite{action=add}` | programs-sites | decision (2) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite{action=delete}` | `admin:csettings.updatesite{action=delete}` | programs-sites | decision (2) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite{action=update}` | `admin:csettings.updatesite{action=update}` | spans people, programs-sites, strategies-content | decision (2) (corrected; expected carry) | validates `"" \| rc.siteID` | redirect |
| `ctl:csettings.updatesite` | `admin:csettings.updatesite` | programs-sites | carry (5) | validates `"" \| rc.siteID` | redirect |
| `ctl:ctrash.detail` | `admin:ctrash.detail` | — | decision (3) | none | page (text/html) |
| `ctl:ctrash.empty` | `admin:ctrash.empty` | spans communications, identity, people, programs-sites, strategies-content | decision (2) | validates `'emptytrash' & rc.siteID` | redirect |
| `ctl:ctrash.list` | `admin:ctrash.list` | — | decision (3) | none | page (text/html) |
| `ctl:ctrash.restore` | `admin:ctrash.restore` | — | decision (3) | validates `'restore' & rc.objectID` | redirect |
| `ctl:cusers.addtogroup` | `admin:cusers.addtogroup` | identity | carry (5) | validates `rc.userid & rc.groupid & 'addtogroup'` | redirect |
| `ctl:cusers.advancedsearch` | `admin:cusers.advancedsearch` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.advancedsearchtocsv` | `admin:cusers.advancedsearchtocsv` | people | carry (5) | none | redirect |
| `ctl:cusers.default` | `admin:cusers.default` | people | carry (5) | none | redirect |
| `ctl:cusers.download` | `admin:cusers.download` | people | carry (5) | none | download (text/csv) |
| `ctl:cusers.downloadgroupmembers` | `admin:cusers.downloadgroupmembers` | identity | carry (5) | none | redirect |
| `ctl:cusers.editaddress` | `admin:cusers.editaddress` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.editgroup` | `admin:cusers.editgroup` | identity | carry (5) | none | page (text/html) |
| `ctl:cusers.editgroupmembers` | `admin:cusers.editgroupmembers` | identity | carry (5) | none | page (text/html) |
| `ctl:cusers.edituser` | `admin:cusers.edituser` | identity | carry (5) (corrected; expected carry) | none | page (text/html) |
| `ctl:cusers.list` | `admin:cusers.list` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.listusers` | `admin:cusers.listusers` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.loadextendedattributes` | `admin:cusers.loadextendedattributes` | people | carry (5) | none | fragment (text/html) |
| `ctl:cusers.removefromgroup` | `admin:cusers.removefromgroup` | identity | carry (5) | none | redirect |
| `ctl:cusers.route` | `admin:cusers.route` | people | carry (5) | none | redirect |
| `ctl:cusers.search` | `admin:cusers.search` | people | carry (5) | none | page (text/html) |
| `ctl:cusers.update{photo}` | `admin:cusers.update{photo}` | people | decision (3) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=add,extdata}` | `admin:cusers.update{type=2,action=add,extdata}` | spans identity, people, strategies-content | decision (3) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=update,extdata}` | `admin:cusers.update{type=2,action=update,extdata}` | spans identity, people, strategies-content | decision (3) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=1,action=delete}` | `admin:cusers.update{type=1,action=delete}` | spans identity, strategies-content | decision (3) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=1,extdata}` | `admin:cusers.update{type=1,extdata}` | spans identity, strategies-content | decision (3) (corrected; expected carry) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=add}` | `admin:cusers.update{type=2,action=add}` | people | carry (5) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=delete}` | `admin:cusers.update{type=2,action=delete}` | people | decision (3) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=2,action=update}` | `admin:cusers.update{type=2,action=update}` | people | carry (5) | validates `rc.userid` | redirect |
| `ctl:cusers.update{type=1}` | `admin:cusers.update{type=1}` | identity | carry (5) | validates `rc.userid` | redirect |
| `ctl:cusers.update` | `admin:cusers.update` | spans identity, people, strategies-content | decision (3) | validates `rc.userid` | redirect |
| `ctl:cusers.updateaddress{action=delete}` | `admin:cusers.updateaddress{action=delete}` | spans people, strategies-content | decision (3) (corrected; expected carry) | validates `'updateaddress' & rc.userid` | redirect |
| `ctl:cusers.updateaddress{extdata}` | `admin:cusers.updateaddress{extdata}` | spans people, strategies-content | decision (3) (corrected; expected carry) | validates `'updateaddress' & rc.userid` | redirect |
| `ctl:cusers.updateaddress` | `admin:cusers.updateaddress` | people | carry (5) | validates `'updateaddress' & rc.userid` | redirect |
| `ctl:cwebservice.delete` | `admin:cwebservice.delete` | identity | carry (5) | validates `rc.clientid` | redirect |
| `ctl:cwebservice.list` | `admin:cwebservice.list` | identity | carry (5) | none | page (text/html) |
| `ctl:cwebservice.save` | `admin:cwebservice.save` | identity | carry (5) | validates `rc.clientid` | page (text/html) |
| `ctl:home.redirect` | `admin:home.redirect` | identity | carry (5) | none | redirect |
| `ctl:razuna.default` | `admin:razuna.default` | strategies-content | legacy-served (4) (corrected; expected decision) | none | fragment (text/html) |
| `ctl:razuna.getnodes` | `admin:razuna.getnodes` | strategies-content | legacy-served (4) (corrected; expected decision) | none | fragment (text/html) |
| `ctl:razuna.selectnode` | `admin:razuna.selectnode` | strategies-content | legacy-served (4) (corrected; expected decision) | none | fragment (text/html) |
| `ctl:razuna.settingsquerytostruct` | `admin:razuna.settingsquerytostruct` | strategies-content | legacy-served (4) (corrected; expected decision) | none | redirect |
| `ctl:razuna.structkeydefault` | `admin:razuna.structkeydefault` | strategies-content | legacy-served (4) (corrected; expected decision) | none | redirect |
| `ctl:scaffold.assembler` | `admin:scaffold.assembler` | — | legacy-served (4) (corrected; expected decision) | none | page (text/html) |
| `ctl:scaffold.sites` | `admin:scaffold.sites` | — | legacy-served (4) (corrected; expected decision) | none | page (text/html) |
| `ctl:scaffold.updatesites` | `admin:scaffold.updatesites` | — | legacy-served (4) (corrected; expected decision) | none | redirect |

## Route families

| Id | Route key | Owner | Disposition (step) | CSRF | Notes |
| --- | --- | --- | --- | --- | --- |
| `rte:/_api/ajax/v1` | — | — | carry (5) | — | — |
| `rte:/_api/asset/render` | `asset:render` | strategies-content | legacy-served (4) | none | — |
| `rte:/_api/asset/upload` | `asset:upload` | strategies-content | legacy-served (4) | none | — |
| `rte:/_api/email/trackopen` | `trackopen:open` | communications | legacy-served (4) | none | — |
| `rte:/_api/feed/v1` | `feed:v1` | strategies-content | carry (5) | none | — |
| `rte:/_api/json/v1` | — | — | carry (5) | — | — |
| `rte:/_api/render/file` | `render:file` | strategies-content | carry (5) | none | — |
| `rte:/_api/render/medium` | `render:medium` | strategies-content | carry (5) | none | — |
| `rte:/_api/render/small` | `render:small` | strategies-content | carry (5) | none | — |
| `rte:/_api/resource/variation` | `variation:js` | strategies-content | carry (5) | none | — |
| `rte:/_api/rest/v1` | — | — | carry (5) | — | — |
| `rte:/_api/sitemonitor` | `sitemonitor:run` | programs-sites | carry (5) | none | — |
| `rte:/tasks/widgets` | `widgets:redirect` | — | legacy-served (4) | none | — |

## JSON API entities and methods

| Id | Route key | Owner | Disposition (step) | CSRF | Notes |
| --- | --- | --- | --- | --- | --- |
| `api:address.delete` | `api:address.delete` | spans people, strategies-content | decision (3) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:address.delete` |
| `api:address.findall` | `api:address.findall` | people | carry (5) | none | — |
| `api:address.findmany` | `api:address.findmany` | people | carry (5) | none | — |
| `api:address.findnew` | `api:address.findnew` | people | carry (5) | none | — |
| `api:address.findone` | `api:address.findone` | people | carry (5) | none | — |
| `api:address.findpermissions` | `api:address.findpermissions` | people | carry (5) | none | — |
| `api:address.findproperties` | `api:address.findproperties` | people | carry (5) | none | — |
| `api:address.findquery` | `api:address.findquery` | people | carry (5) | none | — |
| `api:address.save` | `api:address.save` | people | carry (5) | validates `arguments.id` | — |
| `api:address.save{extdata}` | `api:address.save{extdata}` | spans people, strategies-content | decision (3) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:address.save{extdata}` |
| `api:address.validate` | `api:address.validate` | people | carry (5) | none | — |
| `api:category.delete` | `api:category.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:category.findall` | `api:category.findall` | strategies-content | carry (5) | none | — |
| `api:category.findmany` | `api:category.findmany` | strategies-content | carry (5) | none | — |
| `api:category.findnew` | `api:category.findnew` | strategies-content | carry (5) | none | — |
| `api:category.findone` | `api:category.findone` | strategies-content | carry (5) | none | — |
| `api:category.findpermissions` | `api:category.findpermissions` | strategies-content | carry (5) | none | — |
| `api:category.findproperties` | `api:category.findproperties` | strategies-content | carry (5) | none | — |
| `api:category.findquery` | `api:category.findquery` | strategies-content | carry (5) | none | — |
| `api:category.save` | `api:category.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:category.validate` | `api:category.validate` | strategies-content | carry (5) | none | — |
| `api:changeset.delete` | `api:changeset.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changeset.findall` | `api:changeset.findall` | strategies-content | carry (5) | none | — |
| `api:changeset.findmany` | `api:changeset.findmany` | strategies-content | carry (5) | none | — |
| `api:changeset.findnew` | `api:changeset.findnew` | strategies-content | carry (5) | none | — |
| `api:changeset.findone` | `api:changeset.findone` | strategies-content | carry (5) | none | — |
| `api:changeset.findpermissions` | `api:changeset.findpermissions` | strategies-content | carry (5) | none | — |
| `api:changeset.findproperties` | `api:changeset.findproperties` | strategies-content | carry (5) | none | — |
| `api:changeset.findquery` | `api:changeset.findquery` | strategies-content | carry (5) | none | — |
| `api:changeset.save` | `api:changeset.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changeset.validate` | `api:changeset.validate` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.delete` | `api:changesetcategoryassignment.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changesetcategoryassignment.findall` | `api:changesetcategoryassignment.findall` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findmany` | `api:changesetcategoryassignment.findmany` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findnew` | `api:changesetcategoryassignment.findnew` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findone` | `api:changesetcategoryassignment.findone` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findpermissions` | `api:changesetcategoryassignment.findpermissions` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findproperties` | `api:changesetcategoryassignment.findproperties` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.findquery` | `api:changesetcategoryassignment.findquery` | strategies-content | carry (5) | none | — |
| `api:changesetcategoryassignment.save` | `api:changesetcategoryassignment.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:changesetcategoryassignment.validate` | `api:changesetcategoryassignment.validate` | strategies-content | carry (5) | none | — |
| `api:checkschema` | `api:checkschema` | — | decision (2) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#tentity-declared:*` |
| `api:comment.delete` | `api:comment.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:comment.findall` | `api:comment.findall` | strategies-content | carry (5) | none | — |
| `api:comment.findmany` | `api:comment.findmany` | strategies-content | carry (5) | none | — |
| `api:comment.findnew` | `api:comment.findnew` | strategies-content | carry (5) | none | — |
| `api:comment.findone` | `api:comment.findone` | strategies-content | carry (5) | none | — |
| `api:comment.findpermissions` | `api:comment.findpermissions` | strategies-content | carry (5) | none | — |
| `api:comment.findproperties` | `api:comment.findproperties` | strategies-content | carry (5) | none | — |
| `api:comment.findquery` | `api:comment.findquery` | strategies-content | carry (5) | none | — |
| `api:comment.save` | `api:comment.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:comment.validate` | `api:comment.validate` | strategies-content | carry (5) | none | — |
| `api:comment.~delete` | `api:comment.~delete` | strategies-content | carry (5) | none | — |
| `api:comment.~flag` | `api:comment.~flag` | strategies-content | carry (5) | none | — |
| `api:comment.~markasspam` | `api:comment.~markasspam` | strategies-content | carry (5) | none | — |
| `api:comment.~undelete` | `api:comment.~undelete` | strategies-content | carry (5) | none | — |
| `api:comment.~unmarkasspam` | `api:comment.~unmarkasspam` | strategies-content | carry (5) | none | — |
| `api:content.delete` | `api:content.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:content.findall` | `api:content.findall` | strategies-content | carry (5) | none | — |
| `api:content.findmany` | `api:content.findmany` | strategies-content | carry (5) | none | — |
| `api:content.findnew` | `api:content.findnew` | strategies-content | carry (5) | none | — |
| `api:content.findone` | `api:content.findone` | strategies-content | carry (5) | none | — |
| `api:content.findpermissions` | `api:content.findpermissions` | strategies-content | carry (5) | none | — |
| `api:content.findproperties` | `api:content.findproperties` | strategies-content | carry (5) | none | — |
| `api:content.findquery` | `api:content.findquery` | strategies-content | carry (5) | none | — |
| `api:content.save` | `api:content.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:content.save{approved=1}` | `api:content.save{approved=1}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:content.save{notify}` | `api:content.save{notify}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:content.validate` | `api:content.validate` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.delete` | `api:contentcategoryassign.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:contentcategoryassign.findall` | `api:contentcategoryassign.findall` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findmany` | `api:contentcategoryassign.findmany` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findnew` | `api:contentcategoryassign.findnew` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findone` | `api:contentcategoryassign.findone` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findpermissions` | `api:contentcategoryassign.findpermissions` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findproperties` | `api:contentcategoryassign.findproperties` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.findquery` | `api:contentcategoryassign.findquery` | strategies-content | carry (5) | none | — |
| `api:contentcategoryassign.save` | `api:contentcategoryassign.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:contentcategoryassign.validate` | `api:contentcategoryassign.validate` | strategies-content | carry (5) | none | — |
| `api:contentnav.delete` | `api:contentnav.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:contentnav.findall` | `api:contentnav.findall` | strategies-content | carry (5) | none | — |
| `api:contentnav.findmany` | `api:contentnav.findmany` | strategies-content | carry (5) | none | — |
| `api:contentnav.findnew` | `api:contentnav.findnew` | strategies-content | carry (5) | none | — |
| `api:contentnav.findone` | `api:contentnav.findone` | strategies-content | carry (5) | none | — |
| `api:contentnav.findpermissions` | `api:contentnav.findpermissions` | strategies-content | carry (5) | none | — |
| `api:contentnav.findproperties` | `api:contentnav.findproperties` | strategies-content | carry (5) | none | — |
| `api:contentnav.findquery` | `api:contentnav.findquery` | strategies-content | carry (5) | none | — |
| `api:contentnav.save` | `api:contentnav.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:contentnav.save{approved=1}` | `api:contentnav.save{approved=1}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:contentnav.save{notify}` | `api:contentnav.save{notify}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `api:contentnav.validate` | `api:contentnav.validate` | strategies-content | carry (5) | none | — |
| `api:declareentity` | `api:declareentity` | programs-sites | decision (2) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#tentity` |
| `api:feed.delete` | `api:feed.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:feed.findall` | `api:feed.findall` | strategies-content | carry (5) | none | — |
| `api:feed.findmany` | `api:feed.findmany` | strategies-content | carry (5) | none | — |
| `api:feed.findnew` | `api:feed.findnew` | strategies-content | carry (5) | none | — |
| `api:feed.findone` | `api:feed.findone` | strategies-content | carry (5) | none | — |
| `api:feed.findpermissions` | `api:feed.findpermissions` | strategies-content | carry (5) | none | — |
| `api:feed.findproperties` | `api:feed.findproperties` | strategies-content | carry (5) | none | — |
| `api:feed.findquery` | `api:feed.findquery` | strategies-content | carry (5) | none | — |
| `api:feed.save` | `api:feed.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:feed.validate` | `api:feed.validate` | strategies-content | carry (5) | none | — |
| `api:file.delete` | `api:file.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:file.findall` | `api:file.findall` | strategies-content | carry (5) | none | — |
| `api:file.findmany` | `api:file.findmany` | strategies-content | carry (5) | none | — |
| `api:file.findnew` | `api:file.findnew` | strategies-content | carry (5) | none | — |
| `api:file.findone` | `api:file.findone` | strategies-content | carry (5) | none | — |
| `api:file.findpermissions` | `api:file.findpermissions` | strategies-content | carry (5) | none | — |
| `api:file.findproperties` | `api:file.findproperties` | strategies-content | carry (5) | none | — |
| `api:file.findquery` | `api:file.findquery` | strategies-content | carry (5) | none | — |
| `api:file.save` | `api:file.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:file.save{upload=image}` | `api:file.save{upload=image}` | strategies-content | carry (5) | validates `arguments.id` | `EX-FILE-RENDITION` |
| `api:file.validate` | `api:file.validate` | strategies-content | carry (5) | none | — |
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
| `api:filemetadata.findall` | `api:filemetadata.findall` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findmany` | `api:filemetadata.findmany` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findnew` | `api:filemetadata.findnew` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findone` | `api:filemetadata.findone` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findpermissions` | `api:filemetadata.findpermissions` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findproperties` | `api:filemetadata.findproperties` | strategies-content | carry (5) | none | — |
| `api:filemetadata.findquery` | `api:filemetadata.findquery` | strategies-content | carry (5) | none | — |
| `api:filemetadata.save` | `api:filemetadata.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:filemetadata.validate` | `api:filemetadata.validate` | strategies-content | carry (5) | none | — |
| `api:findcalendaritems` | `api:findcalendaritems` | strategies-content | carry (5) | none | — |
| `api:findcrumbarray` | `api:findcrumbarray` | strategies-content | carry (5) | none | — |
| `api:findcurrentuser` | `api:findcurrentuser` | identity | carry (5) | none | — |
| `api:findrelatedcontent` | `api:findrelatedcontent` | strategies-content | carry (5) | none | — |
| `api:findversionhistory` | `api:findversionhistory` | strategies-content | carry (5) | none | — |
| `api:generatecsrftokens` | `api:generatecsrftokens` | identity | carry (5) | none | — |
| `api:geturlforimage` | `api:geturlforimage` | strategies-content | carry (5) | none | — |
| `api:group.delete` | `api:group.delete` | spans identity, strategies-content | decision (3) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:group.delete` |
| `api:group.findall` | `api:group.findall` | identity | carry (5) | none | — |
| `api:group.findmany` | `api:group.findmany` | identity | carry (5) | none | — |
| `api:group.findnew` | `api:group.findnew` | identity | carry (5) | none | — |
| `api:group.findone` | `api:group.findone` | identity | carry (5) | none | — |
| `api:group.findpermissions` | `api:group.findpermissions` | identity | carry (5) | none | — |
| `api:group.findproperties` | `api:group.findproperties` | identity | carry (5) | none | — |
| `api:group.findquery` | `api:group.findquery` | identity | carry (5) | none | — |
| `api:group.save` | `api:group.save` | identity | carry (5) | validates `arguments.id` | — |
| `api:group.save{extdata}` | `api:group.save{extdata}` | spans identity, strategies-content | decision (3) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:group.save{extdata}` |
| `api:group.save{photo}` | `api:group.save{photo}` | identity | decision (3) | validates `arguments.id` | `opt2/decision-list.json#api:group.save{photo}` |
| `api:group.validate` | `api:group.validate` | identity | carry (5) | none | — |
| `api:login` | `api:login` | identity | carry (5) | validates `login` | — |
| `api:logout` | `api:logout` | identity | carry (5) | none | — |
| `api:processasyncobject` | `api:processasyncobject` | spans communications, identity, people, programs-sites, strategies-content | decision (3) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#api:processasyncobject` |
| `api:processasyncobject{saveform}` | `api:processasyncobject{saveform}` | spans identity, strategies-content | decision (3) (corrected; expected legacy-served) | validates `getValue('formID')` | `opt2/decision-list.json#api:processasyncobject{saveform}` |
| `api:site.delete` | `api:site.delete` | programs-sites | carry (5) | validates `arguments.id` | — |
| `api:site.findall` | `api:site.findall` | programs-sites | carry (5) | none | — |
| `api:site.findmany` | `api:site.findmany` | programs-sites | carry (5) | none | — |
| `api:site.findnew` | `api:site.findnew` | programs-sites | carry (5) | none | — |
| `api:site.findone` | `api:site.findone` | programs-sites | carry (5) | none | — |
| `api:site.findpermissions` | `api:site.findpermissions` | programs-sites | carry (5) | none | — |
| `api:site.findproperties` | `api:site.findproperties` | programs-sites | carry (5) | none | — |
| `api:site.findquery` | `api:site.findquery` | programs-sites | carry (5) | none | — |
| `api:site.save` | `api:site.save` | spans communications, identity, people, programs-sites, strategies-content | decision (2) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#trazunasettings` |
| `api:site.save{bundle}` | `api:site.save{bundle}` | spans communications, identity, people, programs-sites, strategies-content | decision (2) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#tplugindisplayobjects` |
| `api:site.validate` | `api:site.validate` | programs-sites | carry (5) | none | — |
| `api:stats.delete` | `api:stats.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:stats.findall` | `api:stats.findall` | strategies-content | carry (5) | none | — |
| `api:stats.findmany` | `api:stats.findmany` | strategies-content | carry (5) | none | — |
| `api:stats.findnew` | `api:stats.findnew` | strategies-content | carry (5) | none | — |
| `api:stats.findone` | `api:stats.findone` | strategies-content | carry (5) | none | — |
| `api:stats.findpermissions` | `api:stats.findpermissions` | strategies-content | carry (5) | none | — |
| `api:stats.findproperties` | `api:stats.findproperties` | strategies-content | carry (5) | none | — |
| `api:stats.findquery` | `api:stats.findquery` | strategies-content | carry (5) | none | — |
| `api:stats.save` | `api:stats.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:stats.validate` | `api:stats.validate` | strategies-content | carry (5) | none | — |
| `api:submitform` | `api:submitform` | strategies-content | retired (1) (corrected; expected carry) | none | — |
| `api:swagger` | `api:swagger` | — | legacy-served (4) | none | — |
| `api:undeclareentity` | `api:undeclareentity` | programs-sites | decision (2) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#tentity` |
| `api:user.delete` | `api:user.delete` | people | decision (3) | validates `arguments.id` | `opt2/decision-list.json#api:user.delete` |
| `api:user.findall` | `api:user.findall` | people | carry (5) | none | — |
| `api:user.findmany` | `api:user.findmany` | people | carry (5) | none | — |
| `api:user.findnew` | `api:user.findnew` | people | carry (5) | none | — |
| `api:user.findone` | `api:user.findone` | people | carry (5) | none | — |
| `api:user.findpermissions` | `api:user.findpermissions` | people | carry (5) | none | — |
| `api:user.findproperties` | `api:user.findproperties` | people | carry (5) | none | — |
| `api:user.findquery` | `api:user.findquery` | people | carry (5) | none | — |
| `api:user.save` | `api:user.save` | people | carry (5) | validates `arguments.id` | — |
| `api:user.save{extdata}` | `api:user.save{extdata}` | spans identity, people, strategies-content | decision (3) (corrected; expected carry) | validates `arguments.id` | `opt2/decision-list.json#api:user.save{extdata}` |
| `api:user.save{photo}` | `api:user.save{photo}` | people | decision (3) | validates `arguments.id` | `opt2/decision-list.json#api:user.save{photo}` |
| `api:user.validate` | `api:user.validate` | people | carry (5) | none | — |
| `api:user.~pollstate` | `api:user.~pollstate` | people | carry (5) | none | — |
| `api:validateemail` | `api:validateemail` | identity | carry (5) | none | — |
| `api:variationtargeting.delete` | `api:variationtargeting.delete` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:variationtargeting.findall` | `api:variationtargeting.findall` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findmany` | `api:variationtargeting.findmany` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findnew` | `api:variationtargeting.findnew` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findone` | `api:variationtargeting.findone` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findpermissions` | `api:variationtargeting.findpermissions` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findproperties` | `api:variationtargeting.findproperties` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.findquery` | `api:variationtargeting.findquery` | strategies-content | carry (5) | none | — |
| `api:variationtargeting.save` | `api:variationtargeting.save` | strategies-content | carry (5) | validates `arguments.id` | — |
| `api:variationtargeting.validate` | `api:variationtargeting.validate` | strategies-content | carry (5) | none | — |
| `rest:address.delete` | `rest:address.delete` | spans people, strategies-content | decision (3) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:address.delete` |
| `rest:address.findall` | `rest:address.findall` | people | carry (5) | none | — |
| `rest:address.findmany` | `rest:address.findmany` | people | carry (5) | none | — |
| `rest:address.findnew` | `rest:address.findnew` | people | carry (5) | none | — |
| `rest:address.findone` | `rest:address.findone` | people | carry (5) | none | — |
| `rest:address.findpermissions` | `rest:address.findpermissions` | people | carry (5) | none | — |
| `rest:address.findproperties` | `rest:address.findproperties` | people | carry (5) | none | — |
| `rest:address.findquery` | `rest:address.findquery` | people | carry (5) | none | — |
| `rest:address.save` | `rest:address.save` | people | carry (5) | bypassed `arguments.id` | — |
| `rest:address.save{extdata}` | `rest:address.save{extdata}` | spans people, strategies-content | decision (3) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:address.save{extdata}` |
| `rest:address.validate` | `rest:address.validate` | people | carry (5) | none | — |
| `rest:category.delete` | `rest:category.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:category.findall` | `rest:category.findall` | strategies-content | carry (5) | none | — |
| `rest:category.findmany` | `rest:category.findmany` | strategies-content | carry (5) | none | — |
| `rest:category.findnew` | `rest:category.findnew` | strategies-content | carry (5) | none | — |
| `rest:category.findone` | `rest:category.findone` | strategies-content | carry (5) | none | — |
| `rest:category.findpermissions` | `rest:category.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:category.findproperties` | `rest:category.findproperties` | strategies-content | carry (5) | none | — |
| `rest:category.findquery` | `rest:category.findquery` | strategies-content | carry (5) | none | — |
| `rest:category.save` | `rest:category.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:category.validate` | `rest:category.validate` | strategies-content | carry (5) | none | — |
| `rest:changeset.delete` | `rest:changeset.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changeset.findall` | `rest:changeset.findall` | strategies-content | carry (5) | none | — |
| `rest:changeset.findmany` | `rest:changeset.findmany` | strategies-content | carry (5) | none | — |
| `rest:changeset.findnew` | `rest:changeset.findnew` | strategies-content | carry (5) | none | — |
| `rest:changeset.findone` | `rest:changeset.findone` | strategies-content | carry (5) | none | — |
| `rest:changeset.findpermissions` | `rest:changeset.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:changeset.findproperties` | `rest:changeset.findproperties` | strategies-content | carry (5) | none | — |
| `rest:changeset.findquery` | `rest:changeset.findquery` | strategies-content | carry (5) | none | — |
| `rest:changeset.save` | `rest:changeset.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changeset.validate` | `rest:changeset.validate` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.delete` | `rest:changesetcategoryassignment.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changesetcategoryassignment.findall` | `rest:changesetcategoryassignment.findall` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findmany` | `rest:changesetcategoryassignment.findmany` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findnew` | `rest:changesetcategoryassignment.findnew` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findone` | `rest:changesetcategoryassignment.findone` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findpermissions` | `rest:changesetcategoryassignment.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findproperties` | `rest:changesetcategoryassignment.findproperties` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.findquery` | `rest:changesetcategoryassignment.findquery` | strategies-content | carry (5) | none | — |
| `rest:changesetcategoryassignment.save` | `rest:changesetcategoryassignment.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:changesetcategoryassignment.validate` | `rest:changesetcategoryassignment.validate` | strategies-content | carry (5) | none | — |
| `rest:checkschema` | `rest:checkschema` | — | decision (2) (corrected; expected legacy-served) | bypassed | `opt2/decision-list.json#tentity-declared:*` |
| `rest:comment.delete` | `rest:comment.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:comment.findall` | `rest:comment.findall` | strategies-content | carry (5) | none | — |
| `rest:comment.findmany` | `rest:comment.findmany` | strategies-content | carry (5) | none | — |
| `rest:comment.findnew` | `rest:comment.findnew` | strategies-content | carry (5) | none | — |
| `rest:comment.findone` | `rest:comment.findone` | strategies-content | carry (5) | none | — |
| `rest:comment.findpermissions` | `rest:comment.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:comment.findproperties` | `rest:comment.findproperties` | strategies-content | carry (5) | none | — |
| `rest:comment.findquery` | `rest:comment.findquery` | strategies-content | carry (5) | none | — |
| `rest:comment.save` | `rest:comment.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:comment.validate` | `rest:comment.validate` | strategies-content | carry (5) | none | — |
| `rest:comment.~delete` | `rest:comment.~delete` | strategies-content | carry (5) | none | — |
| `rest:comment.~flag` | `rest:comment.~flag` | strategies-content | carry (5) | none | — |
| `rest:comment.~markasspam` | `rest:comment.~markasspam` | strategies-content | carry (5) | none | — |
| `rest:comment.~undelete` | `rest:comment.~undelete` | strategies-content | carry (5) | none | — |
| `rest:comment.~unmarkasspam` | `rest:comment.~unmarkasspam` | strategies-content | carry (5) | none | — |
| `rest:content.delete` | `rest:content.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:content.findall` | `rest:content.findall` | strategies-content | carry (5) | none | — |
| `rest:content.findmany` | `rest:content.findmany` | strategies-content | carry (5) | none | — |
| `rest:content.findnew` | `rest:content.findnew` | strategies-content | carry (5) | none | — |
| `rest:content.findone` | `rest:content.findone` | strategies-content | carry (5) | none | — |
| `rest:content.findpermissions` | `rest:content.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:content.findproperties` | `rest:content.findproperties` | strategies-content | carry (5) | none | — |
| `rest:content.findquery` | `rest:content.findquery` | strategies-content | carry (5) | none | — |
| `rest:content.save` | `rest:content.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:content.save{approved=1}` | `rest:content.save{approved=1}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:content.save{notify}` | `rest:content.save{notify}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:content.validate` | `rest:content.validate` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.delete` | `rest:contentcategoryassign.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:contentcategoryassign.findall` | `rest:contentcategoryassign.findall` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findmany` | `rest:contentcategoryassign.findmany` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findnew` | `rest:contentcategoryassign.findnew` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findone` | `rest:contentcategoryassign.findone` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findpermissions` | `rest:contentcategoryassign.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findproperties` | `rest:contentcategoryassign.findproperties` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.findquery` | `rest:contentcategoryassign.findquery` | strategies-content | carry (5) | none | — |
| `rest:contentcategoryassign.save` | `rest:contentcategoryassign.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:contentcategoryassign.validate` | `rest:contentcategoryassign.validate` | strategies-content | carry (5) | none | — |
| `rest:contentnav.delete` | `rest:contentnav.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:contentnav.findall` | `rest:contentnav.findall` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findmany` | `rest:contentnav.findmany` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findnew` | `rest:contentnav.findnew` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findone` | `rest:contentnav.findone` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findpermissions` | `rest:contentnav.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findproperties` | `rest:contentnav.findproperties` | strategies-content | carry (5) | none | — |
| `rest:contentnav.findquery` | `rest:contentnav.findquery` | strategies-content | carry (5) | none | — |
| `rest:contentnav.save` | `rest:contentnav.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:contentnav.save{approved=1}` | `rest:contentnav.save{approved=1}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:contentnav.save{notify}` | `rest:contentnav.save{notify}` | spans identity, strategies-content | decision (2) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tcontenteventreminders` |
| `rest:contentnav.validate` | `rest:contentnav.validate` | strategies-content | carry (5) | none | — |
| `rest:declareentity` | `rest:declareentity` | programs-sites | decision (2) (corrected; expected legacy-served) | bypassed | `opt2/decision-list.json#tentity` |
| `rest:feed.delete` | `rest:feed.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:feed.findall` | `rest:feed.findall` | strategies-content | carry (5) | none | — |
| `rest:feed.findmany` | `rest:feed.findmany` | strategies-content | carry (5) | none | — |
| `rest:feed.findnew` | `rest:feed.findnew` | strategies-content | carry (5) | none | — |
| `rest:feed.findone` | `rest:feed.findone` | strategies-content | carry (5) | none | — |
| `rest:feed.findpermissions` | `rest:feed.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:feed.findproperties` | `rest:feed.findproperties` | strategies-content | carry (5) | none | — |
| `rest:feed.findquery` | `rest:feed.findquery` | strategies-content | carry (5) | none | — |
| `rest:feed.save` | `rest:feed.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:feed.validate` | `rest:feed.validate` | strategies-content | carry (5) | none | — |
| `rest:file.delete` | `rest:file.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:file.findall` | `rest:file.findall` | strategies-content | carry (5) | none | — |
| `rest:file.findmany` | `rest:file.findmany` | strategies-content | carry (5) | none | — |
| `rest:file.findnew` | `rest:file.findnew` | strategies-content | carry (5) | none | — |
| `rest:file.findone` | `rest:file.findone` | strategies-content | carry (5) | none | — |
| `rest:file.findpermissions` | `rest:file.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:file.findproperties` | `rest:file.findproperties` | strategies-content | carry (5) | none | — |
| `rest:file.findquery` | `rest:file.findquery` | strategies-content | carry (5) | none | — |
| `rest:file.save` | `rest:file.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:file.save{upload=image}` | `rest:file.save{upload=image}` | strategies-content | carry (5) | bypassed `arguments.id` | `EX-FILE-RENDITION` |
| `rest:file.validate` | `rest:file.validate` | strategies-content | carry (5) | none | — |
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
| `rest:filemetadata.findall` | `rest:filemetadata.findall` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findmany` | `rest:filemetadata.findmany` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findnew` | `rest:filemetadata.findnew` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findone` | `rest:filemetadata.findone` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findpermissions` | `rest:filemetadata.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findproperties` | `rest:filemetadata.findproperties` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.findquery` | `rest:filemetadata.findquery` | strategies-content | carry (5) | none | — |
| `rest:filemetadata.save` | `rest:filemetadata.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:filemetadata.validate` | `rest:filemetadata.validate` | strategies-content | carry (5) | none | — |
| `rest:findcalendaritems` | `rest:findcalendaritems` | strategies-content | carry (5) | none | — |
| `rest:findcrumbarray` | `rest:findcrumbarray` | strategies-content | carry (5) | none | — |
| `rest:findcurrentuser` | `rest:findcurrentuser` | identity | carry (5) | none | — |
| `rest:findrelatedcontent` | `rest:findrelatedcontent` | strategies-content | carry (5) | none | — |
| `rest:findversionhistory` | `rest:findversionhistory` | strategies-content | carry (5) | none | — |
| `rest:generatecsrftokens` | `rest:generatecsrftokens` | identity | carry (5) | none | — |
| `rest:geturlforimage` | `rest:geturlforimage` | strategies-content | carry (5) | none | — |
| `rest:group.delete` | `rest:group.delete` | spans identity, strategies-content | decision (3) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.delete` |
| `rest:group.findall` | `rest:group.findall` | identity | carry (5) | none | — |
| `rest:group.findmany` | `rest:group.findmany` | identity | carry (5) | none | — |
| `rest:group.findnew` | `rest:group.findnew` | identity | carry (5) | none | — |
| `rest:group.findone` | `rest:group.findone` | identity | carry (5) | none | — |
| `rest:group.findpermissions` | `rest:group.findpermissions` | identity | carry (5) | none | — |
| `rest:group.findproperties` | `rest:group.findproperties` | identity | carry (5) | none | — |
| `rest:group.findquery` | `rest:group.findquery` | identity | carry (5) | none | — |
| `rest:group.save` | `rest:group.save` | identity | carry (5) | bypassed `arguments.id` | — |
| `rest:group.save{extdata}` | `rest:group.save{extdata}` | spans identity, strategies-content | decision (3) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.save{extdata}` |
| `rest:group.save{photo}` | `rest:group.save{photo}` | identity | decision (3) | bypassed `arguments.id` | `opt2/decision-list.json#api:group.save{photo}` |
| `rest:group.validate` | `rest:group.validate` | identity | carry (5) | none | — |
| `rest:login` | `rest:login` | identity | carry (5) | validates `login` | — |
| `rest:logout` | `rest:logout` | identity | carry (5) | none | — |
| `rest:processasyncobject` | `rest:processasyncobject` | spans identity, people, strategies-content | decision (3) (corrected; expected legacy-served) | validates | `opt2/decision-list.json#api:processasyncobject` |
| `rest:processasyncobject{saveform}` | `rest:processasyncobject{saveform}` | spans identity, strategies-content | decision (3) (corrected; expected legacy-served) | validates `getValue('formID')` | `opt2/decision-list.json#api:processasyncobject{saveform}` |
| `rest:site.delete` | `rest:site.delete` | programs-sites | carry (5) | bypassed `arguments.id` | — |
| `rest:site.findall` | `rest:site.findall` | programs-sites | carry (5) | none | — |
| `rest:site.findmany` | `rest:site.findmany` | programs-sites | carry (5) | none | — |
| `rest:site.findnew` | `rest:site.findnew` | programs-sites | carry (5) | none | — |
| `rest:site.findone` | `rest:site.findone` | programs-sites | carry (5) | none | — |
| `rest:site.findpermissions` | `rest:site.findpermissions` | programs-sites | carry (5) | none | — |
| `rest:site.findproperties` | `rest:site.findproperties` | programs-sites | carry (5) | none | — |
| `rest:site.findquery` | `rest:site.findquery` | programs-sites | carry (5) | none | — |
| `rest:site.save` | `rest:site.save` | spans communications, identity, people, programs-sites, strategies-content | decision (2) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#trazunasettings` |
| `rest:site.save{bundle}` | `rest:site.save{bundle}` | spans communications, identity, people, programs-sites, strategies-content | decision (2) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#tplugindisplayobjects` |
| `rest:site.validate` | `rest:site.validate` | programs-sites | carry (5) | none | — |
| `rest:stats.delete` | `rest:stats.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:stats.findall` | `rest:stats.findall` | strategies-content | carry (5) | none | — |
| `rest:stats.findmany` | `rest:stats.findmany` | strategies-content | carry (5) | none | — |
| `rest:stats.findnew` | `rest:stats.findnew` | strategies-content | carry (5) | none | — |
| `rest:stats.findone` | `rest:stats.findone` | strategies-content | carry (5) | none | — |
| `rest:stats.findpermissions` | `rest:stats.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:stats.findproperties` | `rest:stats.findproperties` | strategies-content | carry (5) | none | — |
| `rest:stats.findquery` | `rest:stats.findquery` | strategies-content | carry (5) | none | — |
| `rest:stats.save` | `rest:stats.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:stats.validate` | `rest:stats.validate` | strategies-content | carry (5) | none | — |
| `rest:submitform` | `rest:submitform` | strategies-content | retired (1) (corrected; expected carry) | none | — |
| `rest:swagger` | `rest:swagger` | — | legacy-served (4) | none | — |
| `rest:undeclareentity` | `rest:undeclareentity` | programs-sites | decision (2) (corrected; expected legacy-served) | bypassed | `opt2/decision-list.json#tentity` |
| `rest:user.delete` | `rest:user.delete` | people | decision (3) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.delete` |
| `rest:user.findall` | `rest:user.findall` | people | carry (5) | none | — |
| `rest:user.findmany` | `rest:user.findmany` | people | carry (5) | none | — |
| `rest:user.findnew` | `rest:user.findnew` | people | carry (5) | none | — |
| `rest:user.findone` | `rest:user.findone` | people | carry (5) | none | — |
| `rest:user.findpermissions` | `rest:user.findpermissions` | people | carry (5) | none | — |
| `rest:user.findproperties` | `rest:user.findproperties` | people | carry (5) | none | — |
| `rest:user.findquery` | `rest:user.findquery` | people | carry (5) | none | — |
| `rest:user.save` | `rest:user.save` | people | carry (5) | bypassed `arguments.id` | — |
| `rest:user.save{extdata}` | `rest:user.save{extdata}` | spans identity, people, strategies-content | decision (3) (corrected; expected carry) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.save{extdata}` |
| `rest:user.save{photo}` | `rest:user.save{photo}` | people | decision (3) | bypassed `arguments.id` | `opt2/decision-list.json#api:user.save{photo}` |
| `rest:user.validate` | `rest:user.validate` | people | carry (5) | none | — |
| `rest:user.~pollstate` | `rest:user.~pollstate` | people | carry (5) | none | — |
| `rest:validateemail` | `rest:validateemail` | identity | carry (5) | none | — |
| `rest:variationtargeting.delete` | `rest:variationtargeting.delete` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:variationtargeting.findall` | `rest:variationtargeting.findall` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findmany` | `rest:variationtargeting.findmany` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findnew` | `rest:variationtargeting.findnew` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findone` | `rest:variationtargeting.findone` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findpermissions` | `rest:variationtargeting.findpermissions` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findproperties` | `rest:variationtargeting.findproperties` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.findquery` | `rest:variationtargeting.findquery` | strategies-content | carry (5) | none | — |
| `rest:variationtargeting.save` | `rest:variationtargeting.save` | strategies-content | carry (5) | bypassed `arguments.id` | — |
| `rest:variationtargeting.validate` | `rest:variationtargeting.validate` | strategies-content | carry (5) | none | — |

## OAuth, SOAP and fixture routes

| Id | Route key | Owner | Disposition (step) | CSRF | Notes |
| --- | --- | --- | --- | --- | --- |
| `fix:communications/messages/{id}@get` | `fixture:communications/messages/{id}@get` | communications | carry (5) | none | — |
| `fix:communications/messages@get` | `fixture:communications/messages@get` | communications | carry (5) | none | — |
| `fix:communications/messages@post` | `fixture:communications/messages@post` | communications | carry (5) | validates | — |
| `fix:communications/templates@get` | `fixture:communications/templates@get` | communications | carry (5) | none | — |
| `fix:communications/templates@post` | `fixture:communications/templates@post` | communications | carry (5) | validates | — |
| `fix:esignature/requests/{id}/audit@get` | `fixture:esignature/requests/{id}/audit@get` | e-signature | carry (5) | none | — |
| `fix:esignature/requests/{id}/sign@post` | `fixture:esignature/requests/{id}/sign@post` | e-signature | carry (5) | validates `route.id` | — |
| `fix:esignature/requests/{id}/verify@get` | `fixture:esignature/requests/{id}/verify@get` | e-signature | carry (5) | none | — |
| `fix:esignature/requests/{id}/verify@post` | `fixture:esignature/requests/{id}/verify@post` | e-signature | carry (5) | validates `route.id` | — |
| `fix:esignature/requests@get` | `fixture:esignature/requests@get` | e-signature | carry (5) | none | — |
| `fix:esignature/requests@post` | `fixture:esignature/requests@post` | e-signature | carry (5) | validates | — |
| `fix:finance/records/{id}/approve@post` | `fixture:finance/records/{id}/approve@post` | finance | carry (5) | validates `route.id` | — |
| `fix:finance/records/{id}/attachments/{id}@get` | `fixture:finance/records/{id}/attachments/{id}@get` | finance | carry (5) | none | — |
| `fix:finance/records/{id}/attachments@get` | `fixture:finance/records/{id}/attachments@get` | finance | carry (5) | none | — |
| `fix:finance/records/{id}/attachments@post` | `fixture:finance/records/{id}/attachments@post` | finance | carry (5) | validates `route.id` | — |
| `fix:finance/records/{id}/edit@post` | `fixture:finance/records/{id}/edit@post` | finance | carry (5) | validates `route.id` | — |
| `fix:finance/records/{id}/reject@post` | `fixture:finance/records/{id}/reject@post` | finance | carry (5) | validates `route.id` | — |
| `fix:finance/records/{id}/resubmit@post` | `fixture:finance/records/{id}/resubmit@post` | finance | carry (5) | validates `route.id` | — |
| `fix:finance/records/{id}/submit@post` | `fixture:finance/records/{id}/submit@post` | finance | carry (5) | validates `route.id` | — |
| `fix:finance/records/{id}/versions@get` | `fixture:finance/records/{id}/versions@get` | finance | carry (5) | none | — |
| `fix:finance/records/{id}@get` | `fixture:finance/records/{id}@get` | finance | carry (5) | none | — |
| `fix:finance/records@get` | `fixture:finance/records@get` | finance | carry (5) | none | — |
| `fix:finance/records@post` | `fixture:finance/records@post` | finance | carry (5) | validates | — |
| `fix:finance/rollups@get` | `fixture:finance/rollups@get` | finance | carry (5) | none | — |
| `fix:people/persons/{id}/archive@get` | `fixture:people/persons/{id}/archive@get` | people | carry (5) | none | — |
| `fix:people/persons/{id}/archive@post` | `fixture:people/persons/{id}/archive@post` | people | carry (5) | validates `route.id` | — |
| `fix:reporting/exports/{id}/download@get` | `fixture:reporting/exports/{id}/download@get` | reporting | carry (5) | none | — |
| `fix:reporting/exports/{id}@get` | `fixture:reporting/exports/{id}@get` | reporting | carry (5) | none | — |
| `fix:reporting/exports@get` | `fixture:reporting/exports@get` | reporting | carry (5) | none | — |
| `fix:reporting/exports@post` | `fixture:reporting/exports@post` | reporting | carry (5) | validates | — |
| `fix:surveys/surveys/{id}/launch@get` | `fixture:surveys/surveys/{id}/launch@get` | surveys | carry (5) | none | — |
| `fix:surveys/surveys/{id}/launch@post` | `fixture:surveys/surveys/{id}/launch@post` | surveys | carry (5) | none | — |
| `fix:surveys/surveys/{id}/remind@get` | `fixture:surveys/surveys/{id}/remind@get` | surveys | carry (5) | none | — |
| `fix:surveys/surveys/{id}/remind@post` | `fixture:surveys/surveys/{id}/remind@post` | surveys | carry (5) | none | — |
| `fix:surveys/surveys/{id}/responses@get` | `fixture:surveys/surveys/{id}/responses@get` | surveys | carry (5) | none | — |
| `fix:surveys/surveys/{id}/responses@post` | `fixture:surveys/surveys/{id}/responses@post` | surveys | carry (5) | validates `route.id` | — |
| `fix:surveys/surveys/{id}/schedule@post` | `fixture:surveys/surveys/{id}/schedule@post` | surveys | carry (5) | validates `route.id` | — |
| `fix:surveys/surveys/{id}/targets/bulk@post` | `fixture:surveys/surveys/{id}/targets/bulk@post` | surveys | carry (5) | validates `route.id` | — |
| `fix:surveys/surveys/{id}/tasks@get` | `fixture:surveys/surveys/{id}/tasks@get` | surveys | carry (5) | none | — |
| `fix:surveys/surveys/{id}@get` | `fixture:surveys/surveys/{id}@get` | surveys | carry (5) | none | — |
| `fix:surveys/surveys@get` | `fixture:surveys/surveys@get` | surveys | carry (5) | none | — |
| `fix:surveys/surveys@post` | `fixture:surveys/surveys@post` | surveys | carry (5) | validates | — |
| `fix:timesheets/days/{id}/primary-approve@post` | `fixture:timesheets/days/{id}/primary-approve@post` | timesheets | carry (5) | validates `route.id` | — |
| `fix:timesheets/days/{id}/resubmit@post` | `fixture:timesheets/days/{id}/resubmit@post` | timesheets | carry (5) | validates `route.id` | — |
| `fix:timesheets/days/{id}/return@post` | `fixture:timesheets/days/{id}/return@post` | timesheets | carry (5) | validates `route.id` | — |
| `fix:timesheets/days/{id}/secondary-approve@post` | `fixture:timesheets/days/{id}/secondary-approve@post` | timesheets | carry (5) | validates `route.id` | — |
| `fix:timesheets/days/{id}/submit@post` | `fixture:timesheets/days/{id}/submit@post` | timesheets | carry (5) | validates `route.id` | — |
| `fix:timesheets/sheets/{id}/status@get` | `fixture:timesheets/sheets/{id}/status@get` | timesheets | carry (5) | none | — |
| `fix:timesheets/sheets/{id}@get` | `fixture:timesheets/sheets/{id}@get` | timesheets | carry (5) | none | — |
| `fix:timesheets/sheets@get` | `fixture:timesheets/sheets@get` | timesheets | carry (5) | none | — |
| `rte:/oauth` | `rest:oauth` | identity | carry (5) | none | — |
| `rte:/oauth2` | `rest:oauth2` | identity | carry (5) | none | — |
| `rte:soap:bundle` | — | — | retired (1) | — | — |
| `rte:soap:category` | — | — | retired (1) | — | — |
| `rte:soap:content` | — | — | retired (1) | — | — |
| `rte:soap:feed` | — | — | retired (1) | — | — |
| `rte:soap:muraProxy` | — | — | retired (1) | — | — |
| `rte:soap:service` | — | — | retired (1) | — | — |
| `rte:soap:user` | — | — | retired (1) | — | — |
| `rte:tokeninfo` | `rest:tokeninfo` | identity | carry (5) | none | — |

## Public front end

| Id | Entry | Owner | Disposition (step) | CSRF | Windowed | Session effects |
| --- | --- | --- | --- | --- | --- | --- |
| `fe:appreload` | application reload by ?\<appreloadkey> (default appreload) or the Global Config reload link; start-up converts tcontent URL data | strategies-content | legacy-served (4) `EX-SEC-APPRELOAD` | none | yes | none |
| `fe:cfm:/core/modules/v1/favorites/ajax/deletefavorite.cfm` | favorites ajax endpoint: deletes a favorite by favoriteID | people | carry (5) | none | no | none |
| `fe:cfm:/core/modules/v1/favorites/ajax/deleterssfavorite.cfm` | favorites ajax endpoint: deletes a user's RSS favorites | people | carry (5) | none | no | none |
| `fe:cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm` | favorites ajax endpoint: saves a favorite and returns it as JSON | people | carry (5) | none | no | none |
| `fe:cfm:/core/modules/v1/rater/ajax/saverate.cfm` | rater ajax endpoint: saves a rating for the posted contentID, siteID and userID and returns the average as JSON | strategies-content | carry (5) | none | no | none |
| `fe:commentsproxy.flag` | commentsProxy.flag remote method | strategies-content | carry (5) | none | no | none |
| `fe:commentsproxy.get` | commentsProxy.get remote method | strategies-content | carry (5) | none | no | none |
| `fe:commentsproxy.getContentStats` | commentsProxy.getContentStats remote method | strategies-content | carry (5) | none | no | none |
| `fe:commentsproxy.renderCommentsPage` | commentsProxy.renderCommentsPage remote method | strategies-content | legacy-served (4) | none | no | none |
| `fe:doaction=contactsend` | doaction=contactsend: case commented out at the pin, so the value only renders the page | — | retired (1) (corrected; expected legacy-served) | validates | no | none |
| `fe:doaction=createprofile` | doaction=createprofile: public registration through userBean.save, then login mail or loginByUserID | spans identity, people, strategies-content | decision (3) (corrected; expected legacy-served) | validates `editprofile` | yes | relogin |
| `fe:doaction=forward` | doaction=forward: email forward link; no handler acts on it, so the page renders | communications | legacy-served (4) | validates | no | none |
| `fe:doaction=forwardEmail` | doaction=forwardEmail: forward an email to up to five addresses | communications | legacy-served (4) | validates | no | none |
| `fe:doaction=login` | doaction=login: challenge attempt or username and password login | identity | legacy-served (4) | validates `login` | yes | relogin |
| `fe:doaction=logout` | doaction=logout: logout and post-logout handler | identity | legacy-served (4) | validates | no | logout |
| `fe:doaction=masterSubscribe` | doaction=masterSubscribe: master mailing list subscribe | communications | legacy-served (4) | validates | no | none |
| `fe:doaction=return` | doaction=return: email return-click tracking | communications | legacy-served (4) | validates | no | none |
| `fe:doaction=saveRate` | doaction=saveRate: rater display object saves the rating; not a doAction case | strategies-content | legacy-served (4) | validates | yes | none |
| `fe:doaction=sendlogin` | doaction=sendlogin: login display object sends the forgot-password mail | identity | legacy-served (4) | validates | yes | none |
| `fe:doaction=setReminder` | doaction=setReminder: event reminder create | communications | decision (2) (corrected; expected legacy-served) | validates | no | none |
| `fe:doaction=subscribe` | doaction=subscribe: mailing list member create after the human check | communications | legacy-served (4) | validates | no | none |
| `fe:doaction=unsubscribe` | doaction=unsubscribe: mailing list member delete | communications | legacy-served (4) | validates | no | none |
| `fe:doaction=updateprofile` | doaction=updateprofile: address create, update or delete, or userManager.update then loginByUserID | spans identity, people, strategies-content | decision (3) (corrected; expected legacy-served) | validates `editprofile` | yes | relogin |
| `fe:doaction=validateMember` | doaction=validateMember: master mailing list display object validates a member | communications | legacy-served (4) | validates | no | none |
| `fe:processasyncobject{saveform}` | processAsyncObject rendering the form display object with saveform | spans identity, strategies-content | decision (3) (corrected; expected legacy-served) | validates `getValue('formID')` | yes | none |
| `fe:render` | page render through handleRootRequest; session tracking writes tsessiontracking | spans communications, identity, people, programs-sites, reporting, strategies-content | decision (3) (corrected; expected legacy-served) | validates | yes | relogin |
| `fe:saveform` | form display object submits through dataCollectionBean.submit while rendering | spans identity, strategies-content | decision (3) (corrected; expected legacy-served) | validates `getValue('formID')` | yes | none |

## Site monitor

`job:sitemonitor` (`sitemonitor:run`, programs-sites, carry (5)): ACF HTTPRequest task to `/index.cfm/_api/sitemonitor/`, start 00:15, interval 900 s, request timeout 600 s, registered only when ping is true; `ping` default `false`; live task: pending-run; live `ping`: pending-run.

| Order | Step | Call | Owner | Disposition (step) | Target mechanism | State this run |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `job:sitemonitor.reminders` | contentManager.sendReminders (catch-up at now - 30 min when the minutes differ) | communications | decision (2) | proposed communications step | legacy step via gateway/legacy-bridge/cfml/jobs.cfm |
| 2 | `job:sitemonitor.email-send` | emailManager.send | communications | legacy-served (4) | proposed communications step; not built while cemail is legacy-served | legacy step |
| 3 | `job:sitemonitor.changeset-publish` | changesetManager.publishBySchedule | strategies-content | decision (2) (corrected; expected carry) | /internal/v1/jobs/publish-scheduled-changesets | target once its group is target-authoritative |
| 4 | `job:sitemonitor.bounces` | emailManager.trackBounces per site with EmailBroadcaster; mail-server dedupe ineffective (listAppend result discarded) | communications | legacy-served (4) | proposed communications step | legacy step |
| 5 | `job:sitemonitor.feed-import` | feedManager.doAutoImport per site with FeedManager | strategies-content | decision (2) (corrected; expected carry) | /internal/v1/jobs/feed-auto-import?siteid= | target once its group is target-authoritative |
| 6 | `job:sitemonitor.cache-purge` | contentManager.purgeContentCache and settingsBean.purgeCache for display windows in [lastMonitored, now] | strategies-content | legacy-served (4) | legacy only; the output cache exists only in legacy | legacy step |
| 7 | `job:sitemonitor.cluster-cleanup` | clusterManager.clearOldCommands | — | decision (2) | retired in target; Pub/Sub replaces tclustercommands | legacy step |
| 8 | `job:sitemonitor.plugin-events` | onGlobalMonitor, then onSiteMonitor per site | — | legacy-served (4) (corrected; expected decision) | none | legacy step |

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
| `tbl:fb_*` | dynamic | pending-run | pending-run | — | 5 | decision (2) | 0 |
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
| `tbl:tapprovalactions` | orm | yes | yes | strategies-content | 1 | carry (5) | 15 |
| `tbl:tapprovalassignments` | orm | yes | yes | strategies-content | 1 | carry (5) | 3 |
| `tbl:tapprovalchains` | orm | yes | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tapprovalmemberships` | orm | yes | yes | strategies-content | 1 | carry (5) | 11 |
| `tbl:tapprovalrequests` | orm | yes | yes | strategies-content | 1 | carry (5) | 17 |
| `tbl:tchangesetcategoryassign` | orm | yes | yes | strategies-content | 1 | carry (5) | 13 |
| `tbl:tchangesetrollback` | orm | yes | yes | strategies-content | 1 | carry (5) | 4 |
| `tbl:tchangesets` | migration | yes | yes | strategies-content | 1 | carry (5) | 12 |
| `tbl:tchangesettagassign` | orm | yes | yes | strategies-content | 1 | carry (5) | 12 |
| `tbl:tclassextend` | bootstrap | yes | yes | people, programs-sites, strategies-content | 1 | carry (5) | 15 |
| `tbl:tclassextendattributes` | bootstrap | yes | yes | people, programs-sites, strategies-content | 1 | carry (5) | 15 |
| `tbl:tclassextenddata` | bootstrap | yes | yes | people, programs-sites, strategies-content | 1 | carry (5) | 41 |
| `tbl:tclassextenddatauseractivity` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 28 |
| `tbl:tclassextendrcsets` | orm | yes | yes | people, programs-sites, strategies-content | 1 | carry (5) | 6 |
| `tbl:tclassextendsets` | bootstrap | yes | yes | people, programs-sites, strategies-content | 1 | carry (5) | 16 |
| `tbl:tclustercommands` | migration | no | yes | — | 5 | decision (2) | 10 |
| `tbl:tclusterpeers` | migration | no | yes | — | 5 | decision (2) | 9 |
| `tbl:tcontent` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 101 |
| `tbl:tcontentassignments` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 10 |
| `tbl:tcontentcategories` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 15 |
| `tbl:tcontentcategoryassign` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 21 |
| `tbl:tcontentcommentcommenters` | orm | no | yes | strategies-content | 1 | carry (5) | 3 |
| `tbl:tcontentcomments` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 23 |
| `tbl:tcontentdisplaytitleapprovals` | bootstrap | yes | no | strategies-content | 1 | carry (5) | 0 |
| `tbl:tcontenteventreminders` | bootstrap | yes | no | — | 5 | decision (2) | 12 |
| `tbl:tcontentfeedadvancedparams` | bootstrap | no | yes | strategies-content | 1 | carry (5) | 10 |
| `tbl:tcontentfeeditems` | bootstrap | no | yes | strategies-content | 1 | carry (5) | 9 |
| `tbl:tcontentfeeds` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 10 |
| `tbl:tcontentfilemetadata` | orm | yes | yes | strategies-content | 1 | carry (5) | 13 |
| `tbl:tcontentfilenamearchive` | orm | yes | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tcontentobjects` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 23 |
| `tbl:tcontentpublicsubmissionapprovals` | bootstrap | yes | no | strategies-content | 1 | carry (5) | 6 |
| `tbl:tcontentratings` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 12 |
| `tbl:tcontentrelated` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 18 |
| `tbl:tcontentremotepointer` | orm | yes | yes | strategies-content | 1 | carry (5) | 6 |
| `tbl:tcontentsourcemaps` | orm | yes | yes | strategies-content | 1 | carry (5) | 7 |
| `tbl:tcontentstats` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 19 |
| `tbl:tcontenttags` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 16 |
| `tbl:tcontentvariationtargeting` | orm | yes | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tdirectories` | migration | yes | yes | programs-sites | 1 | carry (5) | 1 |
| `tbl:temailreturnstats` | bootstrap | no | no | communications | 1 | legacy-served (4) | 4 |
| `tbl:temails` | bootstrap | yes | yes | communications | 1 | legacy-served (4) | 12 |
| `tbl:temailstats` | bootstrap | no | no | communications | 1 | legacy-served (4) | 7 |
| `tbl:tentity` | orm | no | yes | — | 5 | decision (2) | 5 |
| `tbl:tentity-declared:*` | dynamic | pending-run | pending-run | — | 5 | decision (2) | 1 |
| `tbl:testoption` | test-suite | no | yes | — | — | retired (1) | 0 |
| `tbl:testwidget` | test-suite | no | yes | — | — | retired (1) | 0 |
| `tbl:tfiles` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 27 |
| `tbl:tformresponsepackets` | bootstrap | yes | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tformresponsequestions` | bootstrap | no | yes | strategies-content | 1 | carry (5) | 8 |
| `tbl:tglobals` | bootstrap | no | no | — | — | retired (1) | 1 |
| `tbl:timagesizes` | migration | yes | yes | programs-sites | 1 | carry (5) | 10 |
| `tbl:tmailinglist` | bootstrap | yes | no | communications | 1 | legacy-served (4) | 10 |
| `tbl:tmailinglistmembers` | bootstrap | yes | no | communications | 1 | legacy-served (4) | 14 |
| `tbl:toauthclients` | orm | yes | yes | identity | 1 | carry (5) | 7 |
| `tbl:toauthtokens` | orm | no | yes | identity | 1 | carry (5) | 8 |
| `tbl:tpermissions` | bootstrap | yes | yes | identity | 2 | carry (5) | 18 |
| `tbl:tplugindisplayobjects` | migration | no | yes | — | 5 | decision (2) | 13 |
| `tbl:tplugins` | migration | no | yes | — | 5 | decision (2) | 23 |
| `tbl:tpluginscripts` | migration | no | yes | — | 5 | decision (2) | 12 |
| `tbl:tpluginsettings` | migration | no | yes | — | 5 | decision (2) | 8 |
| `tbl:trazunasettings` | orm | yes | yes | — | 5 | decision (2) | 5 |
| `tbl:tredirects` | bootstrap | yes | yes | identity | 1 | carry (5) | 9 |
| `tbl:tremotepointer` | orm | yes | yes | — | 5 | decision (2) | 4 |
| `tbl:tsessiontracking` | bootstrap | yes | yes | reporting | 1 | legacy-served (4) | 6 |
| `tbl:tsettings` | bootstrap | yes | yes (bootstrap: no) | programs-sites | 1 | carry (5) | 32 |
| `tbl:tsystemobjects` | bootstrap | yes | no | programs-sites | 1 | carry (5) | 15 |
| `tbl:ttrash` | migration | yes | yes | communications, identity, people, programs-sites, strategies-content | 1 | carry (5) | 10 |
| `tbl:tuseraddresses` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 13 |
| `tbl:tuserdevice` | orm | yes | yes | identity | 1 | carry (5) | 2 |
| `tbl:tuserremotesessions` | migration | no | yes | identity | 1 | carry (5) | 5 |
| `tbl:tusers` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 18 |
| `tbl:tusersfavorites` | bootstrap | yes | yes | identity, people | 1, 3 | carry (5) | 11 |
| `tbl:tusersinterests` | bootstrap | no | yes | identity, people | 1, 3 | carry (5) | 9 |
| `tbl:tusersmemb` | bootstrap | no | yes | identity | 2 | carry (5) | 12 |
| `tbl:tuserstags` | bootstrap | yes | yes | identity, people | 1 | carry (5) | 7 |
| `tbl:tuserstrikes` | migration | no | yes | identity | 1 | carry (5) | 9 |

## Relations and stored procedures

- Relations: 121 (program-fold 1, fixture-fk 15, orm-fk 74, dao-join 31)
- Stored procedures: static 0, live pending-run; foreign keys: static 0
