<!--- SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/ --->
<cfscript>
	variables.envelope = createObject("component", "lib.envelope").init();
	variables.auth = createObject("component", "lib.auth").init();
	variables.fixtureModules = "people,timesheets,finance,surveys,reporting,communications,esignature";
	variables.httpRequest = getHTTPRequestData();
	variables.headers = variables.httpRequest.headers;

	// Effective method and params, merged as Masa's JSON API merges them (jsonApiUtility.cfc:405-412).
	variables.route = {
		"module" = "",
		"resource" = "",
		"id" = "",
		"action" = "",
		"tail" = "",
		"httpMethod" = uCase(cgi.request_method),
		"params" = {},
		"siteid" = "",
		"method" = "invalid"
	};
	if (structKeyExists(variables.headers, "X-HTTP-Method-Override") && len(variables.headers["X-HTTP-Method-Override"])) {
		variables.route.httpMethod = uCase(variables.headers["X-HTTP-Method-Override"]);
	}
	structAppend(variables.route.params, url);
	structAppend(variables.route.params, form);
	if (structKeyExists(variables.headers, "Content-Type")
		&& len(variables.headers["Content-Type"]) >= 16
		&& left(variables.headers["Content-Type"], 16) == "application/json"
		&& isJSON(variables.httpRequest.content)) {
		variables.body = deserializeJSON(variables.httpRequest.content);
		if (isStruct(variables.body)) {
			structAppend(variables.route.params, variables.body);
		}
	}

	// Path grammar <module>/<resource>[/<id>][/<action>][/<tail>]; a path outside it leaves module empty.
	variables.segments = listToArray(cgi.path_info, "/");
	variables.segmentCount = arrayLen(variables.segments);
	if (variables.segmentCount >= 2 && variables.segmentCount <= 5 && listFind(variables.fixtureModules, lCase(variables.segments[1]))) {
		variables.route.module = lCase(variables.segments[1]);
		variables.route.resource = lCase(variables.segments[2]);
		variables.route.method = variables.route.module & "." & variables.route.resource;
		if (variables.segmentCount >= 3) {
			variables.route.id = variables.segments[3];
		}
		if (variables.segmentCount >= 4) {
			variables.route.action = lCase(variables.segments[4]);
			variables.route.method &= "." & variables.route.action;
		}
		if (variables.segmentCount == 5) {
			if (isValid("uuid", variables.segments[5])) {
				variables.route.tail = variables.segments[5];
			} else {
				variables.route.tail = lCase(variables.segments[5]);
				variables.route.method &= "." & variables.route.tail;
			}
		}
	}

	// Dispatch; errors are collected here and written after the try, because the envelope output aborts.
	variables.result = {};
	try {
		if (!len(variables.route.module)) {
			variables.envelope.raise("notFound");
		}
		variables.route.siteid = variables.auth.resolveSite(variables.route.params);
		variables.module = createObject("component", "modules." & variables.route.module).init(envelope = variables.envelope, auth = variables.auth);
		variables.result = variables.module.handle(variables.route);
	} catch (opt2fixture e) {
		variables.failure = {"type" = listLast(e.type, "."), "message" = e.message};
	} catch (any e) {
		writeLog(type="Error", file="exception", text=e.stacktrace);
		variables.failure = {"type" = "server_error", "message" = "", "exception" = e};
	}

	if (structKeyExists(variables, "failure")) {
		variables.failure.method = variables.route.method;
		variables.failure.params = variables.route.params;
		variables.envelope.fail(argumentCollection = variables.failure);
	}
	if (structKeyExists(variables.result, "file")) {
		variables.envelope.sendFile(variables.result.file.bytes, variables.result.file.contentType, variables.result.file.fileName);
	}
	if (structKeyExists(variables.result, "list")) {
		variables.envelope.listResponse(variables.route.method, variables.route.params, variables.result);
	}
	variables.envelope.success(variables.route.method, variables.route.params, variables.result.data);
</cfscript>
