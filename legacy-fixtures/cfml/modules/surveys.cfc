// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="SYNTHETIC surveys fixture: surveys, launch and reminder schedules backed by ACF tasks, targets and responses." {

	public any function init(required any envelope, required any auth) hint="Stores the envelope and auth helpers." {
		variables.envelope = arguments.envelope;
		variables.auth = arguments.auth;
		variables.managerRole = "surveys.manager";
		variables.taskPrefix = "opt2-survey-";
		variables.callbackPath = "/legacy-fixtures/cfml/api.cfm/surveys/surveys/";
		variables.scheduleStates = "DRAFT,SCHEDULED";
		return this;
	}

	public struct function handle(required struct route) hint="Dispatches a surveys route to its handler; any other route raises notFound." {
		local.route = arguments.route;
		local.now = now();
		if (local.route.resource == "surveys") {
			if (!len(local.route.id)) {
				if (local.route.httpMethod == "GET") {
					return listSurveys(local.route);
				}
				if (local.route.httpMethod == "POST") {
					return createSurvey(local.route, local.now);
				}
			} else if (!len(local.route.tail)) {
				switch (local.route.action & ":" & local.route.httpMethod) {
					case ":GET":
						return getSurvey(local.route);
					case "schedule:POST":
						return scheduleSurvey(local.route, local.now);
					case "responses:GET":
						return listResponses(local.route);
					case "responses:POST":
						return createResponse(local.route, local.now);
					case "tasks:GET":
						return listTasks(local.route);
					case "launch:GET":
					case "launch:POST":
						return launchCallback(local.route, local.now);
					case "remind:GET":
					case "remind:POST":
						return remindCallback(local.route, local.now);
				}
			} else if (local.route.action == "targets" && local.route.tail == "bulk" && local.route.httpMethod == "POST") {
				return bulkTarget(local.route, local.now);
			}
		}
		variables.envelope.raise("notFound");
	}

	private struct function listSurveys(required struct route) hint="Lists the site's surveys." {
		variables.auth.requireAny(variables.managerRole);
		local.qry = queryExecute(
			"SELECT * FROM synthetic.survey WHERE siteID = :siteid ORDER BY created, survey_id",
			{siteid = sqlParam(arguments.route.siteid)}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function createSurvey(required struct route, required date now) hint="Creates a DRAFT survey in the site and returns its detail." {
		variables.auth.requireAny(variables.managerRole);
		local.title = paramValue(arguments.route.params, "title");
		if (!isSimpleValue(local.title) || !len(trim(local.title)) || len(local.title) > 255) {
			variables.envelope.raise("invalidParameters");
		}
		local.surveyId = createUUID();
		queryExecute(
			"INSERT INTO synthetic.survey (survey_id, siteID, title, status, created, createdByID)
			VALUES (:id, :siteid, :title, 'DRAFT', :now, :userid)",
			{
				id = sqlParam(local.surveyId),
				siteid = sqlParam(arguments.route.siteid),
				title = sqlParam(local.title, "cf_sql_nvarchar"),
				now = sqlParam(arguments.now, "cf_sql_timestamp"),
				userid = sqlParam(variables.auth.userId())
			}
		);
		return {"data" = surveyDetail(local.surveyId, arguments.route.siteid)};
	}

	private struct function getSurvey(required struct route) hint="Returns the detail of a survey in the site." {
		variables.auth.requireAny(variables.managerRole);
		return {"data" = surveyDetail(arguments.route.id, arguments.route.siteid)};
	}

	private struct function surveyDetail(required string surveyId, required string siteid) hint="Returns the site's survey row with its schedule, reminders and targets; raises notFound outside the site." {
		local.survey = findSurvey(arguments.surveyId, arguments.siteid);
		local.params = {id = sqlParam(local.survey.survey_id)};
		local.schedule = variables.envelope.rows(queryExecute(
			"SELECT schedule_id, survey_id, launch_at, schedule_version, task_name, created
			FROM synthetic.survey_schedule WHERE survey_id = :id",
			local.params
		));
		local.survey["schedule"] = arrayLen(local.schedule) ? local.schedule[1] : {};
		// The reminder ordinal exists only as the task_name suffix, so a shorter name has a lower ordinal.
		local.survey["reminders"] = variables.envelope.rows(queryExecute(
			"SELECT reminder_id, survey_id, offset_minutes, remind_at, task_name, sent_at
			FROM synthetic.survey_reminder WHERE survey_id = :id
			ORDER BY LEN(task_name), task_name, reminder_id",
			local.params
		));
		local.survey["targets"] = variables.envelope.rows(queryExecute(
			"SELECT target_id, survey_id, siteID, group_name, created
			FROM synthetic.survey_target WHERE survey_id = :id
			ORDER BY siteID, group_name, target_id",
			local.params
		));
		return local.survey;
	}

	private struct function scheduleSurvey(required struct route, required date now) hint="Replaces the survey's schedule and reminders, marks it SCHEDULED and recreates its ACF launch and reminder tasks." {
		variables.auth.requireAny(variables.managerRole);
		local.survey = findSurvey(arguments.route.id, arguments.route.siteid);
		local.launchText = paramValue(arguments.route.params, "launchAt");
		if (!isSimpleValue(local.launchText) || !reFind("^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$", local.launchText)) {
			variables.envelope.raise("invalidParameters");
		}
		// ACF masks use mm for months and nn for minutes; the round trip rejects values the lenient parser rolls over.
		local.launchAt = parseDateTime(local.launchText, "yyyy-mm-dd'T'HH:nn:ss");
		local.reminders = arrayParam(arguments.route.params, "reminders", false);
		if (dateTimeFormat(local.launchAt, "yyyy-mm-dd'T'HH:nn:ss") != local.launchText
			|| !allHaveValue(local.reminders, "offsetMinutes")) {
			variables.envelope.raise("invalidParameters");
		}
		for (local.reminder in local.reminders) {
			if (!isValid("integer", local.reminder.offsetMinutes) || local.reminder.offsetMinutes < 0) {
				variables.envelope.raise("invalidParameters");
			}
		}
		// A launched or closed survey keeps its state: rescheduling it would never launch again.
		if (!listFind(variables.scheduleStates, local.survey.status)) {
			variables.envelope.raise("conflict");
		}

		local.origin = structKeyExists(server.system.environment, "OPT2_GATEWAY_ORIGIN")
			? reReplace(server.system.environment.OPT2_GATEWAY_ORIGIN, "/+$", "")
			: "";
		if (!len(local.origin)) {
			variables.envelope.raise("server_error");
		}
		local.originUri = createObject("java", "java.net.URI").init(local.origin);
		local.port = local.originUri.getPort() > 0 ? local.originUri.getPort() : (local.originUri.getScheme() == "https" ? 443 : 80);

		local.surveyId = local.survey.survey_id;
		local.token = lCase(binaryEncode(binaryDecode(generateSecretKey("AES", 256), "base64"), "hex"));
		local.tokenHash = sqlParam(variables.envelope.sha256Hex(local.token), "cf_sql_char");
		local.taskBase = variables.taskPrefix & local.surveyId & "-";
		local.tasks = [{"name" = local.taskBase & "launch", "action" = "launch", "runAt" = local.launchAt, "reminder" = 0}];

		// Serialises reschedules of one survey so its ACF tasks always carry the token whose hash committed last.
		lock name="#local.taskBase#" type="exclusive" timeout="30" {
			transaction {
				local.existing = queryExecute(
					"SELECT schedule_version FROM synthetic.survey_schedule WHERE survey_id = :id",
					{id = sqlParam(local.surveyId)}
				);
				local.scheduleParams = {
					id = sqlParam(local.surveyId),
					launchAt = sqlParam(local.launchAt, "cf_sql_timestamp"),
					taskName = sqlParam(local.tasks[1].name, "cf_sql_nvarchar"),
					tokenHash = local.tokenHash
				};
				if (local.existing.recordCount) {
					queryExecute(
						"UPDATE synthetic.survey_schedule
						SET launch_at = :launchAt, schedule_version = schedule_version + 1, task_name = :taskName, task_token_hash = :tokenHash
						WHERE survey_id = :id",
						local.scheduleParams
					);
				} else {
					local.scheduleParams.scheduleId = sqlParam(createUUID());
					local.scheduleParams.now = sqlParam(arguments.now, "cf_sql_timestamp");
					queryExecute(
						"INSERT INTO synthetic.survey_schedule (schedule_id, survey_id, launch_at, schedule_version, task_name, task_token_hash, created)
						VALUES (:scheduleId, :id, :launchAt, 1, :taskName, :tokenHash, :now)",
						local.scheduleParams
					);
				}

				queryExecute("DELETE FROM synthetic.survey_reminder WHERE survey_id = :id", {id = sqlParam(local.surveyId)});
				for (local.n = 1; local.n <= arrayLen(local.reminders); local.n++) {
					local.offset = int(local.reminders[local.n].offsetMinutes);
					local.task = {
						"name" = local.taskBase & "reminder-" & local.n,
						"action" = "remind",
						"runAt" = dateAdd("n", local.offset, local.launchAt),
						"reminder" = local.n
					};
					arrayAppend(local.tasks, local.task);
					queryExecute(
						"INSERT INTO synthetic.survey_reminder (reminder_id, survey_id, offset_minutes, remind_at, task_name, task_token_hash, sent_at)
						VALUES (:reminderId, :id, :offset, :remindAt, :taskName, :tokenHash, NULL)",
						{
							reminderId = sqlParam(createUUID()),
							id = sqlParam(local.surveyId),
							offset = sqlParam(local.offset, "cf_sql_integer"),
							remindAt = sqlParam(local.task.runAt, "cf_sql_timestamp"),
							taskName = sqlParam(local.task.name, "cf_sql_nvarchar"),
							tokenHash = local.tokenHash
						}
					);
				}

				queryExecute("UPDATE synthetic.survey SET status = 'SCHEDULED' WHERE survey_id = :id", {id = sqlParam(local.surveyId)});
			}

			for (local.stale in scheduledTasks(local.taskBase)) {
				cfschedule(action = "delete", task = local.stale.name);
			}
			for (local.task in local.tasks) {
				cfschedule(
					action = "update",
					task = local.task.name,
					operation = "HTTPRequest",
					url = local.origin & variables.callbackPath & encodeForURL(local.surveyId) & "/" & local.task.action
						& "?siteid=" & encodeForURL(arguments.route.siteid)
						& (local.task.reminder ? "&reminder=" & local.task.reminder : "")
						& "&opt2TaskToken=" & local.token,
					port = local.port,
					startDate = dateFormat(local.task.runAt, "mm/dd/yyyy"),
					startTime = timeFormat(local.task.runAt, "HH:mm:ss"),
					interval = "once",
					requestTimeOut = "600"
				);
			}
		}

		return {"data" = surveyDetail(local.surveyId, arguments.route.siteid)};
	}

	private struct function bulkTarget(required struct route, required date now) hint="Adds the distinct site and group targets of a JSON array through usp_survey_bulk_target and returns {inserted, total}." {
		variables.auth.requireAny(variables.managerRole);
		local.survey = findSurvey(arguments.route.id, arguments.route.siteid);
		local.raw = paramValue(arguments.route.params, "targets");
		local.targets = arrayParam(arguments.route.params, "targets", true);
		if (!allHaveValue(local.targets, "siteID")) {
			variables.envelope.raise("invalidParameters");
		}
		local.qry = queryExecute(
			"EXEC synthetic.usp_survey_bulk_target @survey_id = :id, @json = :json, @now = :now",
			{
				id = sqlParam(local.survey.survey_id, "cf_sql_char"),
				json = sqlParam(isSimpleValue(local.raw) ? local.raw : serializeJSON(local.targets), "cf_sql_longnvarchar"),
				now = sqlParam(arguments.now, "cf_sql_timestamp")
			}
		);
		return {"data" = variables.envelope.rows(local.qry)[1]};
	}

	private struct function listResponses(required struct route) hint="Lists the responses of a survey in the site." {
		variables.auth.requireAny(variables.managerRole);
		local.survey = findSurvey(arguments.route.id, arguments.route.siteid);
		local.qry = queryExecute(
			"SELECT * FROM synthetic.survey_response WHERE survey_id = :id ORDER BY created, response_id",
			{id = sqlParam(local.survey.survey_id)}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function createResponse(required struct route, required date now) hint="Stores a logged-in user's answers, from the survey's own site or a targeted site, under the survey's site." {
		variables.auth.requireLogin();
		local.qry = queryExecute(
			"SELECT v.survey_id, v.siteID,
				CASE WHEN v.siteID = :siteid
					OR EXISTS (SELECT 1 FROM synthetic.survey_target t WHERE t.survey_id = v.survey_id AND t.siteID = :siteid)
				THEN 1 ELSE 0 END AS allowed
			FROM synthetic.survey v WHERE v.survey_id = :id",
			{id = sqlParam(arguments.route.id), siteid = sqlParam(arguments.route.siteid)}
		);
		if (!local.qry.recordCount) {
			variables.envelope.raise("notFound");
		}
		if (!local.qry.allowed[1]) {
			variables.envelope.raise("forbidden");
		}
		local.answers = paramValue(arguments.route.params, "answers");
		if (!isSimpleValue(local.answers) || !len(local.answers)) {
			variables.envelope.raise("invalidParameters");
		}
		local.responseId = createUUID();
		queryExecute(
			"INSERT INTO synthetic.survey_response (response_id, survey_id, siteID, respondentSiteID, respondent_user_id, answers, created)
			VALUES (:id, :surveyId, :siteid, :respondentSiteId, :userid, :answers, :now)",
			{
				id = sqlParam(local.responseId),
				surveyId = sqlParam(local.qry.survey_id[1]),
				siteid = sqlParam(local.qry.siteID[1]),
				respondentSiteId = sqlParam(arguments.route.siteid),
				userid = sqlParam(variables.auth.userId()),
				answers = sqlParam(local.answers, "cf_sql_longnvarchar"),
				now = sqlParam(arguments.now, "cf_sql_timestamp")
			}
		);
		return {"data" = variables.envelope.rows(queryExecute(
			"SELECT * FROM synthetic.survey_response WHERE response_id = :id",
			{id = sqlParam(local.responseId)}
		))[1]};
	}

	private struct function listTasks(required struct route) hint="Lists the survey's ACF tasks of its current schedule with kind, callback route and offset in minutes." {
		variables.auth.requireAny(variables.managerRole);
		local.survey = findSurvey(arguments.route.id, arguments.route.siteid);
		local.recorded = queryExecute(
			"SELECT task_name, 'launch' AS kind, 0 AS offset_minutes FROM synthetic.survey_schedule WHERE survey_id = :id
			UNION ALL
			SELECT task_name, 'reminder', offset_minutes FROM synthetic.survey_reminder WHERE survey_id = :id",
			{id = sqlParam(local.survey.survey_id)}
		);
		local.byName = {};
		for (local.row in local.recorded) {
			local.byName[local.row.task_name] = {"kind" = local.row.kind, "offset" = local.row.offset_minutes};
		}

		local.items = [];
		for (local.task in scheduledTasks(variables.taskPrefix & local.survey.survey_id & "-")) {
			if (structKeyExists(local.byName, local.task.name)) {
				local.item = [:];
				local.item["taskname"] = local.task.name;
				local.item["kind"] = local.byName[local.task.name].kind;
				local.item["route"] = listFirst(reReplace(local.task.url, "^[A-Za-z][A-Za-z0-9+.-]*://[^/]*", ""), "?");
				local.item["offsetminutes"] = local.byName[local.task.name].offset;
				arrayAppend(local.items, local.item);
			}
		}
		arraySort(local.items, function(a, b) {
			if (arguments.a.offsetminutes != arguments.b.offsetminutes) {
				return arguments.a.offsetminutes < arguments.b.offsetminutes ? -1 : 1;
			}
			return compare(arguments.a.taskname, arguments.b.taskname);
		});
		return variables.envelope.list(local.items, arguments.route.params);
	}

	private struct function launchCallback(required struct route, required date now) hint="Task callback: marks the survey LAUNCHED the first time and returns its row." {
		local.surveyId = verifiedTaskSurvey(arguments.route);
		queryExecute(
			"UPDATE synthetic.survey SET status = 'LAUNCHED', launched_at = :now WHERE survey_id = :id AND launched_at IS NULL",
			{id = sqlParam(local.surveyId), now = sqlParam(arguments.now, "cf_sql_timestamp")}
		);
		return {"data" = findSurvey(local.surveyId, arguments.route.siteid)};
	}

	private struct function remindCallback(required struct route, required date now) hint="Task callback: stamps the reminder's sent_at the first time and returns its row." {
		local.surveyId = verifiedTaskSurvey(arguments.route);
		local.n = paramValue(arguments.route.params, "reminder");
		if (!isSimpleValue(local.n) || !isValid("integer", local.n) || local.n < 1) {
			variables.envelope.raise("invalidParameters");
		}
		local.found = queryExecute(
			"SELECT reminder_id FROM synthetic.survey_reminder WHERE survey_id = :id AND task_name = :taskName",
			{
				id = sqlParam(local.surveyId),
				taskName = sqlParam(variables.taskPrefix & local.surveyId & "-reminder-" & int(local.n), "cf_sql_nvarchar")
			}
		);
		if (!local.found.recordCount) {
			variables.envelope.raise("notFound");
		}
		local.reminderParams = {id = sqlParam(local.found.reminder_id[1]), now = sqlParam(arguments.now, "cf_sql_timestamp")};
		queryExecute(
			"UPDATE synthetic.survey_reminder SET sent_at = :now WHERE reminder_id = :id AND sent_at IS NULL",
			local.reminderParams
		);
		return {"data" = variables.envelope.rows(queryExecute(
			"SELECT reminder_id, survey_id, offset_minutes, remind_at, task_name, sent_at FROM synthetic.survey_reminder WHERE reminder_id = :id",
			{id = local.reminderParams.id}
		))[1]};
	}

	private string function verifiedTaskSurvey(required struct route) hint="Returns the scheduled survey's id when url.opt2TaskToken matches its stored task token hash in the request site; raises forbidden otherwise, a missing survey included." {
		local.qry = queryExecute(
			"SELECT s.survey_id, s.task_token_hash
			FROM synthetic.survey_schedule s INNER JOIN synthetic.survey v ON v.survey_id = s.survey_id
			WHERE s.survey_id = :id AND v.siteID = :siteid",
			{id = sqlParam(arguments.route.id), siteid = sqlParam(arguments.route.siteid)}
		);
		if (!variables.auth.checkTaskToken(url.opt2TaskToken ?: "", local.qry.recordCount ? local.qry.task_token_hash[1] : "")) {
			variables.envelope.raise("forbidden");
		}
		return local.qry.survey_id[1];
	}

	private struct function findSurvey(required string surveyId, required string siteid) hint="Returns the survey row in the site, or raises notFound." {
		local.rows = variables.envelope.rows(queryExecute(
			"SELECT * FROM synthetic.survey WHERE survey_id = :id AND siteID = :siteid",
			{id = sqlParam(arguments.surveyId), siteid = sqlParam(arguments.siteid)}
		));
		if (!arrayLen(local.rows)) {
			variables.envelope.raise("notFound");
		}
		return local.rows[1];
	}

	private array function scheduledTasks(required string prefix) hint="Returns {name, url} of every ACF task whose name starts with prefix (case-sensitive), from a query or array-of-structs listing." {
		cfschedule(action = "list", result = "local.listing");
		local.result = [];
		for (local.entry in local.listing) {
			local.name = entryValue(local.entry, "task");
			if (!len(local.name)) {
				local.name = entryValue(local.entry, "taskname");
			}
			if (len(local.name) > len(arguments.prefix) && !compare(left(local.name, len(arguments.prefix)), arguments.prefix)) {
				arrayAppend(local.result, {"name" = local.name, "url" = entryValue(local.entry, "url")});
			}
		}
		return local.result;
	}

	private string function entryValue(required struct entry, required string key) hint="Returns a task-listing field read case-insensitively, or an empty string when absent or null." {
		return structKeyExists(arguments.entry, arguments.key) && isSimpleValue(arguments.entry[arguments.key]) ? arguments.entry[arguments.key] : "";
	}

	private array function arrayParam(required struct params, required string name, required boolean required) hint="Returns an array parameter, deserializing a JSON string; an absent or empty value is [] unless required; anything else raises invalidParameters." {
		local.value = paramValue(arguments.params, arguments.name);
		if (!arguments.required && isSimpleValue(local.value) && !len(local.value)) {
			return [];
		}
		if (isSimpleValue(local.value) && isJSON(local.value)) {
			local.value = deserializeJSON(local.value);
		}
		if (!isArray(local.value)) {
			variables.envelope.raise("invalidParameters");
		}
		return local.value;
	}

	private boolean function allHaveValue(required array items, required string key) hint="Returns true when every item is a struct whose key, matched case-sensitively as JSON and OPENJSON match it, holds a non-empty simple value." {
		for (local.i = 1; local.i <= arrayLen(arguments.items); local.i++) {
			if (!arrayIsDefined(arguments.items, local.i) || !isStruct(arguments.items[local.i])) {
				return false;
			}
			local.item = arguments.items[local.i];
			if (!arrayFind(structKeyArray(local.item), arguments.key) || isNull(local.item[arguments.key])
				|| !isSimpleValue(local.item[arguments.key]) || !len(local.item[arguments.key])) {
				return false;
			}
		}
		return true;
	}

	private any function paramValue(required struct params, required string name) hint="Returns a request parameter, or an empty string when it is absent or null." {
		return structKeyExists(arguments.params, arguments.name) ? arguments.params[arguments.name] : "";
	}

	private struct function sqlParam(required any value, string type = "cf_sql_varchar") hint="Returns a typed queryExecute parameter." {
		return {value = arguments.value, cfsqltype = arguments.type};
	}

}

