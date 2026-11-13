<cfscript>
// Legacy bridge jobs: runs one site-monitor step of contentServer.cfc's /_api/sitemonitor with the caller's cursor, reads or sets the cursor, or purges a site's caches.
app = request.opt2BridgeApp;
job = url.job;
body = {"job": job, "completed": true};

// Matched case-sensitively, as the assertion op is.
allJobs = "sendReminders,emailSend,publishScheduledChangesets,trackBounces,feedAutoImport,purgeDisplayWindow,clearOldCommands,onGlobalMonitor,onSiteMonitor,setCursor,getCursor,purgeCache";
siteJobs = "trackBounces,feedAutoImport,onSiteMonitor,purgeCache";

// Returns the named URL parameter parsed as a wire time; raises 400 badRequest when it is missing or invalid.
function bridgeTimeParam(required any app, required string name) {
	if (!structKeyExists(url, arguments.name) || !len(url[arguments.name])) {
		arguments.app.raise(400, "badRequest", "missing parameter " & arguments.name);
	}
	return arguments.app.parseLegacyTime(url[arguments.name]);
}

try {
	if (!listFind(allJobs, job)) {
		app.raise(404, "notFound", "unknown job");
	}
	if (compare(cgi.request_method, job == "getCursor" ? "GET" : "POST") != 0) {
		app.raise(400, "badRequest", "wrong method");
	}
	if (listFind(siteJobs, job)) {
		if (!structKeyExists(url, "siteid") || !len(url.siteid)) {
			app.raise(400, "badRequest", "missing parameter siteid");
		}
		// getSite falls back to the default site for an unknown id, so registration is checked first.
		if (!application.settingsManager.siteExists(url.siteid)) {
			app.raise(404, "notFound", "unregistered site");
		}
		body["siteId"] = url.siteid;
	}

	switch (job) {
		case "sendReminders":
			application.contentManager.sendReminders(bridgeTimeParam(app, "theTime"));
			break;

		case "emailSend":
			application.emailManager.send();
			break;

		case "publishScheduledChangesets":
			application.changesetManager.publishBySchedule();
			break;

		case "trackBounces":
			// contentServer.cfc:691: the getter folds in the global emailBroadcaster config only legacy reads (settingsBean.cfc:435-441).
			if (application.settingsManager.getSite(url.siteid).getEmailBroadcaster()) {
				application.emailManager.trackBounces(url.siteid);
			}
			break;

		case "feedAutoImport":
			application.feedManager.doAutoImport(url.siteid);
			break;

		case "purgeDisplayWindow":
			// Content entering or leaving its display window within [lastMonitored, theTime].
			windowStart = bridgeTimeParam(app, "lastMonitored");
			windowEnd = bridgeTimeParam(app, "theTime");
			rsChanges = queryExecute(
				"select tcontent.siteid, tcontent.contentid from tcontent inner join tcontent tcontent2 on tcontent.parentid=tcontent2.contentid
				where tcontent.approved=1 and tcontent.active=1 and tcontent.display=2 and tcontent2.type <> 'Calendar'
				and ((tcontent.displaystart >= :lm and tcontent.displaystart <= :tt) or (tcontent.displaystop >= :lm and tcontent.displaystop <= :tt))
				group by tcontent.siteid, tcontent.contentid",
				{
					lm: {value: windowStart, cfsqltype: "cf_sql_timestamp"},
					tt: {value: windowEnd, cfsqltype: "cf_sql_timestamp"}
				},
				{
					datasource: application.configBean.getDatasource(),
					username: application.configBean.getDBUsername(),
					password: application.configBean.getDBPassword()
				}
			);
			if (rsChanges.recordCount) {
				for (row in rsChanges) {
					application.serviceFactory
						.getBean("contentManager")
						.purgeContentCache(
							contentBean = application.serviceFactory
								.getBean("content")
								.loadBy(contentID = row.contentid, siteid = row.siteid)
						);
				}
				rsSites = queryExecute("select distinct siteid from rsChanges", {}, {dbtype: "query"});
				for (row in rsSites) {
					application.settingsManager.getSite(row.siteid).purgeCache();
				}
			}
			break;

		case "clearOldCommands":
			application.clusterManager.clearOldCommands();
			break;

		case "onGlobalMonitor":
			application.serviceFactory.getBean("$").announceEvent("onGlobalMonitor");
			break;

		case "onSiteMonitor":
			application.serviceFactory.getBean("$").init(url.siteid).announceEvent("onSiteMonitor");
			break;

		case "setCursor":
			application.lastMonitored = bridgeTimeParam(app, "value");
			break;

		case "getCursor":
			// A null-valued quoted key serializes as "lastMonitored":null.
			body = {
				"job": job,
				"lastMonitored": structKeyExists(application, "lastMonitored") ? app.formatLegacyTime(application.lastMonitored) : javaCast("null", "")
			};
			break;

		case "purgeCache":
			site = application.settingsManager.getSite(url.siteid);
			site.purgeCache(name = "output", broadcast = false);
			site.purgeCache(name = "data", broadcast = false);
			break;
	}
} catch (opt2bridge.fail e) {
	app.respondError(val(e.detail), e.errorCode, e.message);
} catch (any e) {
	writeLog(file = "opt2-bridge", type = "error", text = "jobs." & job & " failed: " & e.type);
	app.respondError(500, "serverError", e.type);
}

app.respondJson(200, body);
</cfscript>
