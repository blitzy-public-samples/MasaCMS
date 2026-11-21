// Diagnostic harness application: runs run.cfm and startup.cfm inside Masa's application for loopback harness callers;
// only startup.cfm?op=reload reloads Masa, every other request has app reloads blocked.
component extends="muraWRM.Application" output="false" {

	// Answers 404 or 403 with an empty body unless the request is an authorised run.cfm or startup.cfm call, then runs Masa's request start.
	boolean function onRequestStart(string targetPage = cgi.script_name) output=false {
		// The default covers Masa's onMissingTemplate, which calls onRequestStart() without arguments.
		// targetPage is web-root relative; this folder comes from metadata, since onMissingTemplate runs from Masa's include.
		var targetDir = reReplace(replace(getDirectoryFromPath(expandPath(arguments.targetPage)), "\", "/", "all"), "/+", "/", "all");
		var ownDir = reReplace(replace(getDirectoryFromPath(getMetaData(this).path), "\", "/", "all"), "/+", "/", "all");
		var page = getFileFromPath(arguments.targetPage);
		if (compareNoCase(targetDir, ownDir) != 0 || !listFindNoCase("run.cfm,startup.cfm", page)) {
			endEmpty(404);
		}
		var reason = rejection();
		if (len(reason)) {
			writeLog(file = "opt2-harness", type = "warning", text = "harness diagnostic rejected: " & reason);
			endEmpty(403);
		}

		if (compareNoCase(page, "startup.cfm") == 0 && structKeyExists(url, "op") && url.op == "reload") {
			return reloadMasa();
		}
		var reloadKey = (structKeyExists(application, "appReloadKey") && len(application.appReloadKey)) ? application.appReloadKey : "appreload";
		// Masa re-decodes url (setEncoding) before its reload check, so deleting the key first cannot stop a reload; its own reload flag does.
		if (structKeyExists(url, reloadKey)) {
			request.muraAppreloaded = true;
		}
		var started = super.onRequestStart();
		structDelete(url, reloadKey);
		return started;
	}

	// Re-initialises Masa in this request under its start-up lock; stamps application.opt2StartupSettledAt with that
	// start-up's appInitializedTime in epoch ms only when it ran to completion. Sets request.opt2StartupReloaded.
	private boolean function reloadMasa() {
		var started = false;
		request.opt2StartupReloaded = false;
		try {
			param name="application.instanceID" default=createUUID();
			// Masa's start-up takes the same lock again; ColdFusion named locks are reentrant within a request.
			lock name="appInitBlock#application.instanceID#" type="exclusive" timeout="600" {
				structDelete(application, "opt2StartupSettledAt");
				var before = initializedMs();
				// Not the reload key: Masa's first setEncoding("url") rebuilds url from the query string, dropping added keys.
				application.appInitialized = false;
				started = super.onRequestStart();
				var after = initializedMs();
				if (application.appInitialized && after > before) {
					application.opt2StartupSettledAt = after;
					request.opt2StartupReloaded = true;
				}
			}
		} catch (any failure) {
			writeLog(file = "opt2-harness", type = "error", text = "harness start-up reload failed: " & failure.type & ": " & failure.message);
			var answer = structNew("ordered");
			answer["error"] = "reloadFailed";
			answer["type"] = javaCast("string", failure.type);
			cfheader(statuscode = 500);
			cfcontent(reset = true, type = "application/json; charset=utf-8");
			writeOutput(serializeJSON(answer));
			abort;
		}
		return started;
	}

	// application.appInitializedTime in epoch ms, 0 before Masa's first start-up has set it.
	private numeric function initializedMs() {
		return structKeyExists(application, "appInitializedTime") && isInstanceOf(application.appInitializedTime, "java.util.Date")
			? application.appInitializedTime.getTime() : 0;
	}

	// Rejection token for a caller that is not a loopback peer presenting X-Opt2-Harness-Key equal to OPT2_HARNESS_KEY, else "".
	private string function rejection() {
		// cgi.remote_addr is the socket peer; request.remoteAddr follows a configurable header and could be spoofed.
		if (!listFind("127.0.0.1,::1,0:0:0:0:0:0:0:1", cgi.remote_addr)) {
			return "notLoopback";
		}
		var key = createObject("java", "java.lang.System").getenv("OPT2_HARNESS_KEY");
		if (isNull(key) || !len(key)) {
			return "missingKey";
		}
		var headers = getHttpRequestData(false).headers;
		if (!structKeyExists(headers, "X-Opt2-Harness-Key") || !isSimpleValue(headers["X-Opt2-Harness-Key"])
			|| !len(headers["X-Opt2-Harness-Key"])) {
			return "missingHeader";
		}
		var expected = javaCast("string", key).getBytes("UTF-8");
		var presented = javaCast("string", headers["X-Opt2-Harness-Key"]).getBytes("UTF-8");
		if (!createObject("java", "java.security.MessageDigest").isEqual(expected, presented)) {
			return "keyMismatch";
		}
		return "";
	}

	// Ends the request with the given status and an empty body.
	private void function endEmpty(required numeric status) {
		cfheader(statuscode = arguments.status);
		cfcontent(reset = true);
		abort;
	}

}
