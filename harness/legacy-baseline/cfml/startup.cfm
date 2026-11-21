<!--- Masa start-up settling for the OPT-2 harness: op=reload reports the reload Application.cfc ran, op=status whether the last start-up completed. --->
<cfsetting showdebugoutput="false" requesttimeout="1800">
<cfparam name="url.op" default="">
<cfscript>
/** Replaces the response body with value as JSON and sets the status code. */
function respondJson(required any value, numeric status = 200) output=true {
	cfheader(statuscode = arguments.status);
	cfcontent(reset = true, type = "application/json; charset=utf-8");
	writeOutput(serializeJSON(arguments.value));
}

/** application.appInitializedTime in epoch ms, 0 before Masa's first start-up has set it. */
function initializedMs() {
	return structKeyExists(application, "appInitializedTime") && isInstanceOf(application.appInitializedTime, "java.util.Date")
		? application.appInitializedTime.getTime() : 0;
}

/** The epoch ms stamp Application.cfc leaves after a completed reload, 0 when absent. */
function settledMs() {
	return structKeyExists(application, "opt2StartupSettledAt") && isNumeric(application.opt2StartupSettledAt)
		? application.opt2StartupSettledAt : 0;
}

/** Sets answer[key] to epoch ms ms as ISO-8601 local time with milliseconds, or to null for 0. */
function putTime(required struct answer, required string key, required numeric ms) {
	if (arguments.ms > 0) {
		arguments.answer[arguments.key] = dateTimeFormat(createObject("java", "java.util.Date").init(javaCast("long", arguments.ms)), "yyyy-mm-dd'T'HH:nn:ss.lll");
	} else {
		arguments.answer[arguments.key] = javaCast("null", "");
	}
}
</cfscript>
<cfif url.op eq "reload"><cfscript>
	answer = structNew("ordered");
	answer["op"] = "reload";
	answer["reloaded"] = javaCast("boolean", structKeyExists(request, "opt2StartupReloaded") && request.opt2StartupReloaded);
	answer["appInitialized"] = javaCast("boolean", application.appInitialized);
	putTime(answer, "appInitializedTime", initializedMs());
	putTime(answer, "settledAt", settledMs());
	respondJson(answer);
</cfscript><cfelseif url.op eq "status"><cfscript>
	// Masa's start-up holds this lock exclusively, so the read waits out a start-up in progress.
	lock name="appInitBlock#application.instanceID#" type="readonly" timeout="600" {
		initialized = application.appInitialized;
		initializedAt = initializedMs();
		settledAt = settledMs();
	}
	answer = structNew("ordered");
	answer["op"] = "status";
	answer["appInitialized"] = javaCast("boolean", initialized);
	putTime(answer, "appInitializedTime", initializedAt);
	putTime(answer, "settledAt", settledAt);
	// Epoch ms rather than dates: CFML compares dates to the second.
	answer["settled"] = javaCast("boolean", initialized && settledAt > 0 && settledAt == initializedAt);
	respondJson(answer);
</cfscript><cfelse><cfscript>
	invalid = structNew("ordered");
	invalid["error"] = "invalidParameters";
	respondJson(invalid, 400);
</cfscript></cfif>
