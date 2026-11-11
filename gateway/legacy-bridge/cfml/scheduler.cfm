<cfscript>
// ACF scheduled-task control: describe, repoint, pause, resume, delete and restore (contract: ../README.md).
app = request.opt2BridgeApp;
op = url.op;
body = {};
reply = {};

// Text of a listing cell, "" when absent or null.
function cellText(required struct row, required string key) {
	if (!structKeyExists(arguments.row, arguments.key) || isNull(arguments.row[arguments.key])
		|| !isSimpleValue(arguments.row[arguments.key])) {
		return "";
	}
	return toString(arguments.row[arguments.key]);
}

// Body field as a string, "" when absent; raises 400 badRequest when it is not a simple value.
function bodyText(required struct source, required string key) {
	if (!structKeyExists(arguments.source, arguments.key) || isNull(arguments.source[arguments.key])) {
		return "";
	}
	if (!isSimpleValue(arguments.source[arguments.key])) {
		app.raise(400, "badRequest", arguments.key & " must be a string");
	}
	return toString(arguments.source[arguments.key]);
}

// Body flag, false when absent; raises 400 badRequest when it is not a JSON boolean.
function bodyFlag(required struct source, required string key) {
	if (!structKeyExists(arguments.source, arguments.key) || isNull(arguments.source[arguments.key])) {
		return false;
	}
	if (!isInstanceOf(arguments.source[arguments.key], "java.lang.Boolean")) {
		app.raise(400, "badRequest", arguments.key & " must be a boolean");
	}
	return arguments.source[arguments.key] ? true : false;
}

// One listing row in the wire task shape; dates use the mm/dd/yyyy and HH:mm:ss forms cfschedule accepts back.
function wireTask(required struct row) {
	var startDate = cellText(arguments.row, "startDate");
	var startTime = cellText(arguments.row, "startTime");
	return {
		"task": cellText(arguments.row, "task"),
		"group": cellText(arguments.row, "group"),
		"url": cellText(arguments.row, "url"),
		"port": cellText(arguments.row, "port"),
		"interval": cellText(arguments.row, "interval"),
		"startDate": isDate(startDate) ? dateFormat(startDate, "mm/dd/yyyy") : startDate,
		"startTime": isDate(startTime) ? timeFormat(startTime, "HH:mm:ss") : startTime,
		"requestTimeOut": cellText(arguments.row, "requestTimeOut"),
		"operation": cellText(arguments.row, "operation"),
		"paused": compareNoCase(cellText(arguments.row, "status"), "Paused") == 0
	};
}

// Every ACF task in the wire shape; for-in yields one struct per entry whether the listing is a query (ACF 2023) or an array.
function listTasks() {
	var listing = "";
	cfschedule(action = "list", result = "local.listing");
	var tasks = [];
	for (var row in listing) {
		arrayAppend(tasks, wireTask(row));
	}
	return tasks;
}

// Group attribute to pass: "" for ACF's default group, where Masa's own call places its task.
function groupAttr(required string group) {
	return compareNoCase(arguments.group, "default") == 0 ? "" : arguments.group;
}

// Scheme, host and port of OPT2_GATEWAY_ORIGIN; when the origin names no port, "443" for https and "80" for http.
function gatewayOrigin() {
	var origin = createObject("java", "java.lang.System").getenv("OPT2_GATEWAY_ORIGIN");
	if (isNull(origin) || !len(origin)) {
		app.raise(500, "serverError", "OPT2_GATEWAY_ORIGIN unset");
	}
	try {
		var uri = createObject("java", "java.net.URI").init(origin);
	} catch (any parseError) {
		app.raise(500, "serverError", "OPT2_GATEWAY_ORIGIN invalid");
	}
	if (isNull(uri.getScheme()) || isNull(uri.getHost())) {
		app.raise(500, "serverError", "OPT2_GATEWAY_ORIGIN invalid");
	}
	var port = uri.getPort() != -1 ? toString(uri.getPort()) : (compareNoCase(uri.getScheme(), "https") == 0 ? "443" : "80");
	return {scheme: uri.getScheme(), host: uri.getHost(), port: port};
}

// taskUrl with the origin's scheme and host and no port, keeping its path and query; the port attribute carries the port.
function repointUrl(required string taskUrl, required struct origin) {
	var uri = createObject("java", "java.net.URI").init(arguments.taskUrl);
	return arguments.origin.scheme & "://" & arguments.origin.host
		& (isNull(uri.getRawPath()) ? "" : uri.getRawPath())
		& (isNull(uri.getRawQuery()) ? "" : "?" & uri.getRawQuery());
}

// Creates or updates a task through Masa's utility.scheduleTask with no mode, omitting empty attributes.
function saveTask(required struct attrs) {
	var args = {action: "update", publish: "No"};
	for (var name in arguments.attrs) {
		if (len(arguments.attrs[name])) {
			args[name] = arguments.attrs[name];
		}
	}
	application.serviceFactory.getBean("utility").scheduleTask(argumentCollection = args);
}

// Runs cfschedule pause, resume or delete on one task, naming its group only when it is not the default.
function taskAction(required string action, required string task, required string group) {
	if (len(groupAttr(arguments.group))) {
		cfschedule(action = arguments.action, task = arguments.task, group = arguments.group);
	} else {
		cfschedule(action = arguments.action, task = arguments.task);
	}
}

try {
	if (!listFind("describe,repoint,pause,resume,delete,restore", op)) {
		app.raise(404, "notFound", "unknown op");
	}
	if (compare(cgi.request_method, op == "describe" ? "GET" : "POST") != 0) {
		app.raise(400, "badRequest", "wrong method");
	}
	if (op != "describe") {
		body = app.readJsonBody();
	}
	siteMonitorTask = application.configBean.getWebRoot() & "/index.cfm/_api/sitemonitor/";

	switch (op) {
		// Effective ping, Masa's task name and every task.
		case "describe":
			// No defaultValue: configBean.getValue writes a default into the shared config.
			ping = application.configBean.getValue("ping");
			reply = {"ping": (isBoolean(ping) && ping) ? true : false, "siteMonitorTask": siteMonitorTask, "tasks": listTasks()};
			break;

		// Recreates the native task with Masa's attributes against the gateway, then resumes it.
		case "repoint":
			origin = gatewayOrigin();
			name = len(bodyText(body, "task")) ? bodyText(body, "task") : siteMonitorTask;
			group = bodyText(body, "group");
			startDate = bodyText(body, "startDate");
			saveTask({
				task: name,
				group: groupAttr(group),
				operation: "HTTPRequest",
				url: origin.scheme & "://" & origin.host & application.configBean.getContext() & "/index.cfm/_api/sitemonitor/",
				port: origin.port,
				startDate: len(startDate) ? startDate : dateFormat(now(), "mm/dd/yyyy"),
				startTime: createTime(0, 15, 0),
				interval: "900",
				requestTimeOut: "600"
			});
			taskAction("resume", name, group);
			reply = {"op": op, "tasks": [name]};
			break;

		// Applies the op to every listed task named in tasks or starting with prefix.
		case "pause":
		case "resume":
		case "delete":
			wanted = structKeyExists(body, "tasks") ? body.tasks : [];
			prefix = bodyText(body, "prefix");
			if (!isArray(wanted) || (!arrayLen(wanted) && !len(prefix))) {
				app.raise(400, "badRequest", "tasks or prefix required");
			}
			for (entry in wanted) {
				if (!isSimpleValue(entry)) {
					app.raise(400, "badRequest", "tasks must be names");
				}
			}
			affected = [];
			for (t in listTasks()) {
				hit = len(prefix) && compare(left(t.task, len(prefix)), prefix) == 0;
				for (entry in wanted) {
					hit = hit || compare(t.task, entry) == 0;
				}
				if (hit) {
					taskAction(op, t.task, t.group);
					arrayAppend(affected, t.task);
				}
			}
			reply = {"op": op, "tasks": affected};
			break;

		// Recreates each given task exactly, optionally re-pointed at the gateway, then pauses or resumes it.
		case "restore":
			if (!structKeyExists(body, "tasks") || !isArray(body.tasks)) {
				app.raise(400, "badRequest", "tasks required");
			}
			repoint = bodyFlag(body, "repoint");
			pauseAfter = bodyFlag(body, "paused");
			origin = repoint ? gatewayOrigin() : {};
			definitions = [];
			for (t in body.tasks) {
				if (!isStruct(t) || !len(bodyText(t, "task"))) {
					app.raise(400, "badRequest", "every task needs a name");
				}
				definition = {group: groupAttr(bodyText(t, "group"))};
				for (field in ["task", "operation", "url", "port", "interval", "startDate", "startTime", "requestTimeOut"]) {
					definition[field] = bodyText(t, field);
				}
				if (repoint) {
					definition.url = len(definition.url) ? repointUrl(definition.url, origin) : "";
					definition.port = origin.port;
				}
				arrayAppend(definitions, definition);
			}
			restored = [];
			for (definition in definitions) {
				saveTask(definition);
				// ACF's update keeps an existing task's paused state, so a restore without paused resumes explicitly.
				taskAction(pauseAfter ? "pause" : "resume", definition.task, definition.group);
				arrayAppend(restored, definition.task);
			}
			reply = {"op": op, "tasks": restored};
			break;
	}
} catch (opt2bridge.fail e) {
	app.respondError(val(e.detail), e.errorCode, e.message);
} catch (any e) {
	app.respondError(500, "serverError", e.type);
}

app.respondJson(200, reply);
</cfscript>
