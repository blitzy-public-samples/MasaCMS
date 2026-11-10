// SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Runs the fixture endpoints inside Masa's application, sharing its scopes, session and datasource. */
component extends="muraWRM.Application" output="false" {

	/** Runs Masa's request start without a reload, then admits only api.cfm and seed.cfm in this folder. */
	public boolean function onRequestStart(string targetPage = cgi.script_name) output=false {
		// The default covers Masa's onMissingTemplate, which calls onRequestStart() without arguments.
		// A fixture URL must never re-initialise Masa. Masa re-decodes url before its reload check, so its own
		// reload flag suppresses the reload; Masa clears that flag itself when start-up is genuinely due.
		local.reloadKey = structKeyExists(application, "appReloadKey") ? application.appReloadKey : "appreload";
		if (structKeyExists(url, local.reloadKey)) {
			request.muraAppreloaded = true;
		}
		local.result = super.onRequestStart(argumentCollection = arguments);
		structDelete(url, local.reloadKey);

		// targetPage is web-root relative, so it is expanded. This folder comes from metadata, because
		// getCurrentTemplatePath() names Masa's include when onMissingTemplate calls this method.
		local.targetDir = reReplace(replace(getDirectoryFromPath(expandPath(arguments.targetPage)), "\", "/", "all"), "/+", "/", "all");
		local.ownDir = reReplace(replace(getDirectoryFromPath(getMetaData(this).path), "\", "/", "all"), "/+", "/", "all");
		if (compareNoCase(local.targetDir, local.ownDir) != 0
			|| !listFindNoCase("api.cfm,seed.cfm", getFileFromPath(arguments.targetPage))) {
			cfheader(statuscode = 404);
			cfcontent(reset = true);
			abort;
		}

		return local.result;
	}

}
