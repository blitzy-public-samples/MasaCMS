<cfscript>
// Masa's in-memory site registry: lists its site ids, and rebuilds it from tsettings after a reverse-projected tsettings batch.
app = request.opt2BridgeApp;
try {
	if (compare(url.op, "list") == 0) {
		if (compare(cgi.request_method, "GET") != 0) {
			app.raise(400, "badRequest", "GET required");
		}
		// settingsManager.siteExists is structKeyExists over this struct, so its keys are exactly the registered sites.
		body = {"sites": structKeyArray(application.settingsManager.getSites())};
	} else {
		if (compare(url.op, "refresh") != 0) {
			app.raise(404, "notFound", "unknown op");
		}
		if (compare(cgi.request_method, "POST") != 0) {
			app.raise(400, "badRequest", "POST required");
		}
		if (!structKeyExists(url, "siteid") || !len(url.siteid)) {
			app.raise(400, "badRequest", "siteid is required");
		}
		// settingsManager.getList drops setSites' clearCache argument, so the manager's own site-list cache is cleared first; otherwise created and deleted sites stay stale.
		application.settingsManager.get("gateway").getList(clearCache = true);
		application.settingsManager.setSites();
		body = {"refreshed": true, "siteExists": application.settingsManager.siteExists(url.siteid)};
	}
} catch (opt2bridge.fail e) {
	app.respondError(val(e.detail), e.errorCode, e.message);
} catch (any e) {
	app.respondError(500, "serverError", e.type);
}
app.respondJson(200, body);
</cfscript>
