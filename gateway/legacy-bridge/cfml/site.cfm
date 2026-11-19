<cfscript>
// Masa's in-memory site registry: lists its site ids and domain bindings, reads the first-touch path getters admin pages print, and rebuilds it from tsettings after a reverse-projected tsettings batch;
// also reports the server facts the admin Version menu prints.
app = request.opt2BridgeApp;
try {
	if (compare(url.op, "versionMenu") == 0) {
		if (compare(cgi.request_method, "GET") != 0) {
			app.raise(400, "badRequest", "GET required");
		}
		// The values admin/common/layouts/includes/nav.cfm 383-407 prints; null where its structKeyExists finds the server key absent.
		dbVersion = application.serviceFactory.getBean("dbUtility").version();
		body = structNew("ordered");
		body["appServerProductName"] = javaCast("string", server.coldfusion.productname);
		body["appServerVersion"] = javaCast("string", server.coldfusion.productversion);
		body["dbProductName"] = javaCast("string", dbVersion.database_productname);
		body["dbProductVersion"] = javaCast("string", dbVersion.database_version);
		if (structKeyExists(server, "java") && structKeyExists(server.java, "version")) {
			body["javaVersion"] = javaCast("string", server.java.version);
		} else {
			body["javaVersion"] = javaCast("null", "");
		}
		if (structKeyExists(server, "os") && structKeyExists(server.os, "name")) {
			body["osName"] = javaCast("string", server.os.name);
			body["osVersion"] = javaCast("string", server.os.version);
		} else {
			body["osName"] = javaCast("null", "");
			body["osVersion"] = javaCast("null", "");
		}
	} else if (compare(url.op, "list") == 0) {
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
	} else if (compare(url.op, "paths") == 0) {
		if (compare(cgi.request_method, "GET") != 0) {
			app.raise(400, "badRequest", "GET required");
		}
		if (!structKeyExists(url, "siteid") || !len(url.siteid)) {
			app.raise(400, "badRequest", "siteid is required");
		}
		if (!structKeyExists(url, "apiSite") && !structKeyExists(url, "feedSite") && !structKeyExists(url, "themeSite") && !structKeyExists(url, "initSite")) {
			app.raise(400, "badRequest", "apiSite, feedSite, themeSite or initSite is required");
		}
		// admin/Application.cfc's request.muraPreviewDomain, with siteid as the session site.
		request.muraPreviewDomain = listFirst(cgi.http_host, ":");
		if (!len(request.muraPreviewDomain)) {
			request.muraPreviewDomain = cgi.server_name;
		}
		if (!application.settingsManager.getSite(url.siteid).isValidDomain(domain = request.muraPreviewDomain, mode = "complete")) {
			request.muraPreviewDomain = application.settingsManager.getSite(url.siteid).getDomain();
		}
		// The admin views' first-touch getters, in print order: cwebservice edit.cfm, cfeed edit.cfm/list.cfm, html_head.cfm, Mura.init.
		body = {};
		if (structKeyExists(url, "apiSite")) {
			body["restEndpoint"] = application.settingsManager.getSite(url.apiSite).getApi("json", "v1").getEndpoint(mode = "rest");
		}
		if (structKeyExists(url, "feedSite")) {
			body["feedEndpoint"] = application.settingsManager.getSite(url.feedSite).getApi("feed", "v1").getEndpoint();
		}
		if (structKeyExists(url, "themeSite")) {
			body["themeAssetPath"] = application.settingsManager.getSite(url.themeSite).getThemeAssetPath();
		}
		if (structKeyExists(url, "initSite")) {
			body["initThemeAssetPath"] = application.settingsManager.getSite(url.initSite).getThemeAssetPath(complete = 1);
		}
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
