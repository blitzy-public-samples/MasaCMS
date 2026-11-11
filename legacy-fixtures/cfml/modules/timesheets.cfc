// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="Timesheet sheets, status and day lifecycle actions for the SYNTHETIC timesheets fixture." {

	public any function init(required any envelope, required any auth) hint="Stores the envelope and auth helpers." {
		variables.envelope = arguments.envelope;
		variables.auth = arguments.auth;
		variables.roles = ["timesheets.employee", "timesheets.primary-approver", "timesheets.secondary-approver"];
		variables.dayActions = "submit,primary-approve,secondary-approve,return,resubmit";
		return this;
	}

	public struct function handle(required struct route) hint="Dispatches sheets (GET), sheets/{id} (GET), sheets/{id}/status (GET) and days/{id}/{action} (POST); anything else raises notFound." {
		local.r = arguments.route;
		if (!len(local.r.tail)) {
			if (local.r.resource == "sheets" && local.r.httpMethod == "GET") {
				if (!len(local.r.id)) {
					return listSheets(local.r);
				}
				if (!len(local.r.action)) {
					return sheetDetail(local.r);
				}
				if (local.r.action == "status") {
					return sheetStatusResult(local.r);
				}
			} else if (local.r.resource == "days" && local.r.httpMethod == "POST" && len(local.r.id) && listFind(variables.dayActions, local.r.action)) {
				return dayAction(local.r);
			}
		}
		variables.envelope.raise("notFound");
	}

	private struct function listSheets(required struct route) hint="Lists the site's sheets with status, overdue flag and day counts as of asOf." {
		gate();
		local.schema = variables.auth.programSchema(arguments.route.siteid);
		local.asOf = asOfParam(arguments.route.params);
		// The procedure's own order (period_start, person_id, timesheet_id) is the contract; it returns no period_start to re-sort on.
		local.qry = queryExecute(
			"EXEC [#local.schema#].usp_timesheet_status_list @siteID = :siteid, @asOf = :asOf",
			{siteid = siteParam(arguments.route.siteid), asOf = local.asOf}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function sheetDetail(required struct route) hint="Returns one sheet with its status fields as of asOf and its days." {
		gate();
		local.schema = variables.auth.programSchema(arguments.route.siteid);
		local.sheet = variables.envelope.rows(requireSheet(local.schema, arguments.route))[1];
		local.asOf = asOfParam(arguments.route.params);
		structAppend(local.sheet, variables.envelope.rows(sheetStatus(local.schema, arguments.route.id, local.asOf))[1], false);
		local.sheet["days"] = variables.envelope.rows(findDays(local.schema, false, arguments.route.id));
		return {"data" = local.sheet};
	}

	private struct function sheetStatusResult(required struct route) hint="Returns the sheet's usp_timesheet_status row as of asOf." {
		gate();
		local.schema = variables.auth.programSchema(arguments.route.siteid);
		requireSheet(local.schema, arguments.route);
		local.asOf = asOfParam(arguments.route.params);
		return {"data" = variables.envelope.rows(sheetStatus(local.schema, arguments.route.id, local.asOf))[1]};
	}

	private struct function dayAction(required struct route) hint="Applies a day lifecycle action through usp_timesheet_day_action and returns the day." {
		gate();
		local.schema = variables.auth.programSchema(arguments.route.siteid);
		local.exists = queryExecute(
			"SELECT d.day_id FROM [#local.schema#].timesheet_day d JOIN [#local.schema#].timesheet t ON t.timesheet_id = d.timesheet_id WHERE d.day_id = :id AND t.siteID = :siteid",
			{id = idParam(arguments.route.id), siteid = siteParam(arguments.route.siteid)}
		);
		if (!local.exists.recordCount) {
			variables.envelope.raise("notFound");
		}
		local.comment = structKeyExists(arguments.route.params, "comment") && !isNull(arguments.route.params.comment) ? arguments.route.params.comment : "";
		if (!isSimpleValue(local.comment)) {
			variables.envelope.raise("invalidParameters");
		}
		local.comment = toString(local.comment);

		transaction {
			local.outcome = queryExecute(
				"EXEC [#local.schema#].usp_timesheet_day_action @day_id = :day_id, @action = :action, @roles = :roles, @actor_user_id = :actor, @comment = :comment, @action_id = :action_id, @now = :now",
				{
					day_id = idParam(arguments.route.id),
					action = {value = arguments.route.action, cfsqltype = "cf_sql_nvarchar"},
					roles = {value = arrayToList(variables.auth.rolesHeld()), cfsqltype = "cf_sql_nvarchar"},
					actor = idParam(variables.auth.userId()),
					comment = {value = local.comment, cfsqltype = "cf_sql_nvarchar", null = !len(local.comment)},
					action_id = idParam(createUUID()),
					now = {value = now(), cfsqltype = "cf_sql_timestamp"}
				}
			);
			mapOutcome(variables.envelope.rows(local.outcome)[1]);
		}
		return {"data" = variables.envelope.rows(findDays(local.schema, true, arguments.route.id))[1]};
	}

	private void function gate() hint="Requires login, then one of the timesheets roles." {
		variables.auth.requireLogin();
		variables.auth.requireAny(variables.roles);
	}

	private query function requireSheet(required string schema, required struct route) hint="Returns the route's sheet, or raises notFound when it is not in this program and site." {
		local.qry = queryExecute(
			"SELECT * FROM [#arguments.schema#].timesheet WHERE timesheet_id = :id AND siteID = :siteid",
			{id = idParam(arguments.route.id), siteid = siteParam(arguments.route.siteid)}
		);
		if (!local.qry.recordCount) {
			variables.envelope.raise("notFound");
		}
		return local.qry;
	}

	private query function sheetStatus(required string schema, required string timesheetId, required struct asOf) hint="Returns the usp_timesheet_status row of a sheet; asOf is a typed date param." {
		return queryExecute(
			"EXEC [#arguments.schema#].usp_timesheet_status @timesheet_id = :id, @asOf = :asOf",
			{id = idParam(arguments.timesheetId), asOf = arguments.asOf}
		);
	}

	private query function findDays(required string schema, required boolean byDay, required string id) hint="Returns the day with id (byDay) or the days of sheet id, each with its blackout flag, in work_date, day_id order." {
		return queryExecute(
			"SELECT d.day_id, d.timesheet_id, d.work_date, d.hours, d.state, CASE WHEN b.blackout_id IS NULL THEN 0 ELSE 1 END AS isblackout FROM [#arguments.schema#].timesheet_day d LEFT JOIN [#arguments.schema#].blackout b ON b.day_id = d.day_id WHERE "
				& (arguments.byDay ? "d.day_id = :id" : "d.timesheet_id = :id")
				& " ORDER BY d.work_date, d.day_id",
			{id = idParam(arguments.id)}
		);
	}

	private struct function asOfParam(required struct params) hint="Returns asOf as a cf_sql_date param, today when absent, or raises invalidParameters unless it is a real yyyy-mm-dd date from 1753 on, SQL Server datetime's floor." {
		if (!structKeyExists(arguments.params, "asOf") || isNull(arguments.params.asOf)) {
			local.today = now();
			return {value = createDate(year(local.today), month(local.today), day(local.today)), cfsqltype = "cf_sql_date"};
		}
		local.text = arguments.params.asOf;
		if (!isSimpleValue(local.text) || !reFind("^\d{4}-\d{2}-\d{2}$", local.text)) {
			variables.envelope.raise("invalidParameters");
		}
		local.year = int(left(local.text, 4));
		local.month = int(mid(local.text, 6, 2));
		local.day = int(right(local.text, 2));
		// createDate maps years below 100 into another century, so the round trip rejects them; compare() because != compares date-like strings as dates.
		if (local.year < 1753 || local.month < 1 || local.month > 12 || local.day < 1 || local.day > daysInMonth(createDate(local.year, local.month, 1))
			|| compare(dateFormat(createDate(local.year, local.month, local.day), "yyyy-mm-dd"), local.text) != 0) {
			variables.envelope.raise("invalidParameters");
		}
		return {value = createDate(local.year, local.month, local.day), cfsqltype = "cf_sql_date"};
	}

	private void function mapOutcome(required struct row) hint="Raises the error envelope type for a non-legal usp_timesheet_day_action outcome." {
		switch (arguments.row.outcome) {
			case "legal":
				return;
			case "wrong-role":
				variables.envelope.raise("forbidden");
			case "illegal-state":
				variables.envelope.raise("conflict", arguments.row.error);
			case "not-found":
				variables.envelope.raise("notFound");
			default:
				throw(type="opt2.timesheets.outcome", message="Unexpected timesheet day action outcome");
		}
	}

	private struct function idParam(required string value) hint="Returns a char(35) id query param." {
		return {value = arguments.value, cfsqltype = "cf_sql_char"};
	}

	private struct function siteParam(required string siteid) hint="Returns an nvarchar siteID query param." {
		return {value = arguments.siteid, cfsqltype = "cf_sql_nvarchar"};
	}

}
