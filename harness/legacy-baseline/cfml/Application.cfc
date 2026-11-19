// Diagnostic harness application: runs run.cfm inside Masa's application for loopback harness callers and blocks app reloads.
component extends="muraWRM.Application" output="false" {

	// Answers 404 or 403 with an empty body unless the request is an authorised run.cfm call, then runs Masa's request start.
	boolean function onRequestStart(string targetPage = cgi.script_name) output=false {
		// The default covers Masa's onMissingTemplate, which calls onRequestStart() without arguments.
		// targetPage is web-root relative; this folder comes from metadata, since onMissingTemplate runs from Masa's include.
		var targetDir = reReplace(replace(getDirectoryFromPath(expandPath(arguments.targetPage)), "\", "/", "all"), "/+", "/", "all");
		var ownDir = reReplace(replace(getDirectoryFromPath(getMetaData(this).path), "\", "/", "all"), "/+", "/", "all");
		if (compareNoCase(targetDir, ownDir) != 0 || compareNoCase(getFileFromPath(arguments.targetPage), "run.cfm") != 0) {
			endEmpty(404);
		}
		var reason = rejection();
		if (len(reason)) {
			writeLog(file = "opt2-harness", type = "warning", text = "harness diagnostic rejected: " & reason);
			endEmpty(403);
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
