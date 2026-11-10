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

	// Returns a log-record.v1 JSON line for an unhandled exception, free of request values and exception text.
	string function exceptionLogRecord(required any exception) {
		local.record = [:];
		local.record["timestamp"] = dateTimeFormat(dateConvert("local2utc", now()), "yyyy-mm-dd'T'HH:nn:ss.lll'Z'");
		local.record["severity"] = "ERROR";
		local.record["message"] = "Unhandled fixture exception";
		local.record["service"] = "legacy-fixtures";
		local.record["version"] = "1.0.0";
		local.record["env"] = "local";
		local.record["requestId"] = createUUID();
		local.traceparent = structKeyExists(variables.headers, "traceparent") ? variables.headers.traceparent : "";
		local.trace = reFind("^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$", local.traceparent, 1, true);
		if (local.trace.pos[1] && !reFind("^ff-|^..-0{32}-|-0{16}-..$", local.traceparent)) {
			local.record["traceId"] = mid(local.traceparent, local.trace.pos[2], local.trace.len[2]);
			local.record["spanId"] = mid(local.traceparent, local.trace.pos[3], local.trace.len[3]);
		}
		local.record["route"] = cgi.script_name & "/" & variables.route.module;
		local.record["httpMethod"] = cgi.request_method;
		local.record["statusCode"] = javaCast("int", 500);
		local.error = [:];
		local.error["type"] = structKeyExists(arguments.exception, "type") && reFind("^[A-Za-z0-9_.$-]{1,128}$", arguments.exception.type) ? arguments.exception.type : "Unknown";
		local.error["message"] = "Unhandled Exception";
		if (structKeyExists(arguments.exception, "tagContext") && isArray(arguments.exception.tagContext)) {
			local.root = replace(expandPath("/"), "\", "/", "all");
			local.frames = [];
			for (local.frame in arguments.exception.tagContext) {
				if (structKeyExists(local.frame, "template") && structKeyExists(local.frame, "line")) {
					local.template = replace(local.frame.template, "\", "/", "all");
					local.template = left(local.template, len(local.root)) == local.root ? mid(local.template, len(local.root) + 1, len(local.template)) : getFileFromPath(local.template);
					arrayAppend(local.frames, local.template & ":" & local.frame.line);
				}
			}
			local.error["stack"] = arrayToList(local.frames, chr(10));
		}
		local.record["error"] = local.error;
		return serializeJSON(local.record);
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
		writeLog(type="Error", file="exception", text=exceptionLogRecord(e));
		variables.failure = {"type" = "server_error", "message" = "", "exception" = e};
	}

	if (structKeyExists(variables, "failure")) {
		variables.failure.method = variables.route.method;
		variables.failure.params = variables.route.params;
		variables.envelope.fail(argumentCollection = variables.failure);
	}
	if (structKeyExists(variables.result, "file")) {
		variables.envelope.sendFile(variables.result.file.bytes, variables.result.file.contentType, variables.result.file.fileName, variables.route.method, variables.route.params);
	}
	if (structKeyExists(variables.result, "list")) {
		variables.envelope.listResponse(variables.route.method, variables.route.params, variables.result);
	}
	variables.envelope.success(variables.route.method, variables.route.params, variables.result.data);
</cfscript>
