<cfscript>
// Masa's in-memory site registry: lists its site ids and domain bindings, and rebuilds it from tsettings after a reverse-projected tsettings batch.
app = request.opt2BridgeApp;
try {
	if (compare(url.op, "list") == 0) {
		if (compare(cgi.request_method, "GET") != 0) {
			app.raise(400, "badRequest", "GET required");
		}
		// What contentServer.bindToDomain reads: each getList(sortBy="orderno") row in order, with the domain and the
		// alias lines settingsBean.isValidDomain compares.
		rsSites = application.settingsManager.getList(sortBy = "orderno");
		bindings = [];
		for (i = 1; i <= rsSites.recordCount; i++) {
			try {
				site = application.settingsManager.getSite(rsSites.siteid[i]);
				binding = {"siteId": rsSites.siteid[i], "domain": site.getDomain(), "aliases": listToArray(site.getValue("domainAlias"), chr(13) & chr(10))};
			} catch (any e) {
				// bindToDomain's cftry skips a site whose settings fail to load, so it keeps its place but binds no host.
				binding = {"siteId": rsSites.siteid[i], "domain": "", "aliases": []};
			}
			arrayAppend(bindings, binding);
		}
		// settingsManager.siteExists is structKeyExists over this struct, so its keys are exactly the registered sites.
		body = {
			"sites": structKeyArray(application.settingsManager.getSites()),
			"bindings": bindings,
			"adminDomain": application.configBean.getAdminDomain()
		};
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
