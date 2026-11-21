<cfscript>
// ACF scheduled-task control: describe, repoint, pause, resume, delete and restore (contract: ../README.md).
app = request.opt2BridgeApp;
op = url.op;
body = {};
reply = {};
// Lead of a past-due ONCE task moved to run now: its update keeps it paused, so the new start must outlast the resume that follows.
rescheduleLeadS = 10;

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
		"paused": compareNoCase(cellText(arguments.row, "status"), "Paused") == 0,
		"expired": compareNoCase(cellText(arguments.row, "status"), "Expired") == 0
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

// Creates or updates a task through Masa's utility.scheduleTask with no mode, omitting empty attributes; a fixture
// survey task also gets its Basic task credential, which an update without one would clear.
function saveTask(required struct attrs) {
	var args = {action: "update", publish: "No"};
	for (var name in arguments.attrs) {
		if (len(arguments.attrs[name])) {
			args[name] = arguments.attrs[name];
		}
	}
	var credential = createObject("component", "muraWRM.legacy-fixtures.cfml.lib.auth").init().surveyTaskCredential(arguments.attrs.task);
	if (len(credential)) {
		args.username = "opt2-task";
		args.password = credential;
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

// True for ACF's refusal to pause or resume a task whose run time has passed.
function isExpiredTaskError(required any error) {
	return isInstanceOf(arguments.error, "coldfusion.tagext.lang.ScheduleTag$PauseExpiredTaskException");
}

// The listed task named name, or {} when ACF lists none.
function listedTask(required string name) {
	for (var t in listTasks()) {
		if (compare(t.task, arguments.name) == 0) {
			return t;
		}
	}
	return {};
}

// Pauses task t: true once it is paused, false when ACF holds it expired. A task already paused is left as it is,
// because ACF refuses to pause one whose run time passed while it was paused.
function pauseTask(required struct t) {
	if (arguments.t.paused) {
		return true;
	}
	if (arguments.t.expired) {
		return false;
	}
	try {
		taskAction("pause", arguments.t.task, arguments.t.group);
	} catch (any e) {
		if (!isExpiredTaskError(e)) {
			rethrow;
		}
		var current = listedTask(arguments.t.task);
		return !structIsEmpty(current) && current.paused;
	}
	return true;
}

// Saves task t with its start rescheduleLeadS seconds from now; an existing task keeps its paused state.
function saveDueNow(required struct t) {
	var runAt = dateAdd("s", rescheduleLeadS, now());
	var moved = {group: groupAttr(arguments.t.group), startDate: dateFormat(runAt, "mm/dd/yyyy"), startTime: timeFormat(runAt, "HH:mm:ss")};
	for (var field in ["task", "operation", "url", "port", "interval", "requestTimeOut"]) {
		moved[field] = arguments.t[field];
	}
	saveTask(moved);
}

// Resumes task t: true once it runs on its schedule, false when ACF holds it expired. With reschedule, a ONCE task whose
// run time has passed is first moved to now, so it runs at once.
function resumeTask(required struct t, required boolean reschedule) {
	if (arguments.t.expired) {
		return false;
	}
	try {
		taskAction("resume", arguments.t.task, arguments.t.group);
		return true;
	} catch (any e) {
		if (!isExpiredTaskError(e)) {
			rethrow;
		}
	}
	if (!arguments.reschedule || compareNoCase(arguments.t.interval, "once") != 0) {
		return false;
	}
	saveDueNow(arguments.t);
	taskAction("resume", arguments.t.task, arguments.t.group);
	return true;
}

// True when definition d is a ONCE task whose mm/dd/yyyy and HH:mm:ss start is not after ColdFusion's clock.
function startPassed(required struct d) {
	if (compareNoCase(arguments.d.interval, "once") != 0 || !isDate(arguments.d.startDate) || !isDate(arguments.d.startTime)) {
		return false;
	}
	var onDate = parseDateTime(arguments.d.startDate);
	var atTime = parseDateTime(arguments.d.startTime);
	var start = createDateTime(year(onDate), month(onDate), day(onDate), hour(atTime), minute(atTime), second(atTime));
	return dateCompare(start, now()) <= 0;
}

// True when listed task t carries definition d's group, URL, port, interval, start and timeout.
function sameDefinition(required struct t, required struct d) {
	if (compareNoCase(groupAttr(arguments.t.group), arguments.d.group) != 0 || compareNoCase(arguments.t.interval, arguments.d.interval) != 0) {
		return false;
	}
	for (var field in ["url", "port", "startDate", "startTime", "requestTimeOut"]) {
		if (compare(arguments.t[field], arguments.d[field]) != 0) {
			return false;
		}
	}
	return true;
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

		// Applies the op to every listed task named in tasks or starting with prefix; pause and resume leave expired tasks untouched.
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
			expired = [];
			for (t in listTasks()) {
				hit = len(prefix) && compare(left(t.task, len(prefix)), prefix) == 0;
				for (entry in wanted) {
					hit = hit || compare(t.task, entry) == 0;
				}
				if (!hit) {
					continue;
				}
				if (op == "delete") {
					taskAction(op, t.task, t.group);
					done = true;
				} else {
					// Only a task paused while it waited is moved to now; a running one that ACF reports expired has had its run.
					done = op == "pause" ? pauseTask(t) : resumeTask(t, t.paused);
				}
				if (done) {
					arrayAppend(affected, t.task);
				} else {
					arrayAppend(expired, t.task);
				}
			}
			reply = op == "delete" ? {"op": op, "tasks": affected} : {"op": op, "tasks": affected, "expired": expired};
			break;

		// Recreates each given task exactly, optionally re-pointed at the gateway, then pauses or resumes it. Of definitions
		// whose ONCE run time has passed, one captured expired stays expired, and any other is moved to now when resumed.
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
				arrayAppend(definitions, {attrs: definition, expired: bodyFlag(t, "expired")});
			}
			// Keyed case-insensitively, as ACF names its tasks.
			existing = {};
			for (t in listTasks()) {
				existing[t.task] = t;
			}
			restored = [];
			expired = [];
			for (entry in definitions) {
				definition = entry.attrs;
				current = structKeyExists(existing, definition.task) ? existing[definition.task] : {};
				// An update with a past start runs a paused task at once, so a past ONCE start is never saved over a task.
				if (!startPassed(definition)) {
					saveTask(definition);
					// ACF's update keeps an existing task's paused state, so a restore without paused resumes explicitly.
					saved = duplicate(definition);
					saved.paused = false;
					saved.expired = false;
					held = pauseAfter ? pauseTask(saved) : resumeTask(saved, !entry.expired);
				} else if (!pauseAfter && !entry.expired) {
					saveDueNow(definition);
					taskAction("resume", definition.task, definition.group);
					held = true;
				} else if (!structIsEmpty(current) && sameDefinition(current, definition)
					&& (current.expired || (current.paused && pauseAfter && !entry.expired))) {
					// Left as it is: recreated within ACF's misfire threshold of its start, the task would run.
					held = !current.expired;
				} else {
					// Created with a start past ACF's misfire threshold, a task is expired at once and never runs; ACF cannot pause it.
					if (!structIsEmpty(current)) {
						taskAction("delete", current.task, current.group);
					}
					saveTask(definition);
					held = false;
				}
				if (!held) {
					arrayAppend(expired, definition.task);
				}
				arrayAppend(restored, definition.task);
			}
			reply = {"op": op, "tasks": restored, "expired": expired};
			break;
	}
} catch (opt2bridge.fail e) {
	app.respondError(val(e.detail), e.errorCode, e.message);
} catch (any e) {
	app.respondError(500, "serverError", e.type);
}

app.respondJson(200, reply);
</cfscript>
