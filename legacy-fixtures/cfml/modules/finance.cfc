// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="Finance records, lifecycle transitions, versions, attachments and rollups for the SYNTHETIC finance fixture." {

	public any function init(required any envelope, required any auth) hint="Stores the envelope and auth helpers." {
		variables.envelope = arguments.envelope;
		variables.auth = arguments.auth;
		variables.readRoles = ["finance.preparer", "finance.approver"];
		variables.writeRoles = ["finance.preparer"];
		variables.actions = "submit,approve,reject,resubmit,edit";
		variables.titleMaxLength = 255;
		return this;
	}

	public struct function handle(required struct route) hint="Dispatches a finance route; an unmatched route raises notFound." {
		local.r = arguments.route;
		local.get = local.r.httpMethod == "GET";
		local.post = local.r.httpMethod == "POST";

		if (local.r.resource == "records" && !len(local.r.id)) {
			if (local.get) {
				return listRecords(local.r, gate(local.r, variables.readRoles));
			}
			if (local.post) {
				return createRecord(local.r, gate(local.r, variables.writeRoles));
			}
		} else if (local.r.resource == "records") {
			if (!len(local.r.action) && local.get) {
				return recordDetail(local.r, gate(local.r, variables.readRoles));
			}
			if (listFind(variables.actions, local.r.action) && !len(local.r.tail) && local.post) {
				return transition(local.r, gate(local.r, variables.readRoles));
			}
			if (local.r.action == "versions" && !len(local.r.tail) && local.get) {
				return versions(local.r, gate(local.r, variables.readRoles));
			}
			if (local.r.action == "attachments" && !len(local.r.tail) && local.get) {
				return attachmentList(local.r, gate(local.r, variables.readRoles));
			}
			if (local.r.action == "attachments" && !len(local.r.tail) && local.post) {
				return upload(local.r, gate(local.r, variables.writeRoles));
			}
			if (local.r.action == "attachments" && len(local.r.tail) && local.get) {
				return download(local.r, gate(local.r, variables.readRoles));
			}
		} else if (local.r.resource == "rollups" && !len(local.r.id) && local.get) {
			return rollups(local.r, gate(local.r, variables.readRoles));
		}
		variables.envelope.raise("notFound");
	}

	private struct function listRecords(required struct route, required string schema) hint="Lists the site's finance records." {
		local.qry = queryExecute(
			"SELECT * FROM #arguments.schema#.finance_record WHERE siteID = :siteid ORDER BY created, record_id",
			{siteid = siteParam(arguments.route.siteid)}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function createRecord(required struct route, required string schema) hint="Creates an IN-PROGRESS record with its version-1 row and refreshes the rollup." {
		local.fields = recordFields(arguments.route.params);
		local.now = now();
		local.recordId = createUUID();
		local.params = fieldParams(local.fields);
		local.params.rid = idParam(local.recordId);
		local.params.siteid = siteParam(arguments.route.siteid);
		local.params.actor = idParam(variables.auth.userId());
		local.params.vid = idParam(createUUID());
		local.params.now = {value = local.now, cfsqltype = "cf_sql_timestamp"};
		transaction {
			queryExecute(
				"EXEC #arguments.schema#.usp_finance_create @record_id = :rid, @siteID = :siteid, @title = :title, @amount = :amount, @period = :period, @actor_user_id = :actor, @version_id = :vid, @now = :now",
				local.params
			);
			refreshRollup(arguments.schema, local.now);
		}
		return {"data" = variables.envelope.rows(findRecord(arguments.schema, arguments.route.siteid, local.recordId))[1]};
	}

	private struct function recordDetail(required struct route, required string schema) hint="Returns one record of the site." {
		return {"data" = variables.envelope.rows(requireRecord(arguments.route, arguments.schema))[1]};
	}

	private struct function transition(required struct route, required string schema) hint="Applies a lifecycle action through usp_finance_transition and refreshes the rollup." {
		requireRecord(arguments.route, arguments.schema);
		local.params = arguments.route.action == "edit" ? fieldParams(recordFields(arguments.route.params)) : fieldParams();
		local.now = now();
		local.params.id = idParam(arguments.route.id);
		local.params.action = {value = arguments.route.action, cfsqltype = "cf_sql_varchar"};
		local.params.roles = {value = arrayToList(variables.auth.rolesHeld()), cfsqltype = "cf_sql_nvarchar"};
		local.params.actor = idParam(variables.auth.userId());
		local.params.vid = idParam(createUUID());
		local.params.now = {value = local.now, cfsqltype = "cf_sql_timestamp"};
		transaction {
			local.outcome = queryExecute(
				"EXEC #arguments.schema#.usp_finance_transition @record_id = :id, @action = :action, @roles = :roles, @actor_user_id = :actor, @version_id = :vid, @now = :now, @title = :title, @amount = :amount, @period = :period",
				local.params
			);
			mapOutcome(queryGetRow(local.outcome, 1));
			refreshRollup(arguments.schema, local.now);
		}
		return {"data" = variables.envelope.rows(findRecord(arguments.schema, arguments.route.siteid, arguments.route.id))[1]};
	}

	private struct function versions(required struct route, required string schema) hint="Lists a record's version rows in version order." {
		requireRecord(arguments.route, arguments.schema);
		local.qry = queryExecute(
			"SELECT * FROM #arguments.schema#.finance_record_version WHERE record_id = :id ORDER BY version",
			{id = idParam(arguments.route.id)}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function attachmentList(required struct route, required string schema) hint="Lists a record's attachment metadata, without content." {
		requireRecord(arguments.route, arguments.schema);
		local.qry = queryExecute(
			"SELECT attachment_id, record_id, file_name, content_type, size_bytes, sha256, created, createdByID FROM #arguments.schema#.finance_attachment WHERE record_id = :id ORDER BY created, attachment_id",
			{id = idParam(arguments.route.id)}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function upload(required struct route, required string schema) hint="Stores the multipart field 'file' as an attachment and returns its metadata." {
		requireRecord(arguments.route, arguments.schema);
		if (!structKeyExists(form, "file") || !isSimpleValue(form.file) || !len(form.file) || !isFilePart("file")) {
			variables.envelope.raise("invalidParameters");
		}
		local.up = fileUpload(getTempDirectory(), "file", "", "makeUnique");
		local.path = local.up.serverDirectory & "/" & local.up.serverFile;
		try {
			local.bytes = fileReadBinary(local.path);
			local.attachmentId = createUUID();
			queryExecute(
				"INSERT INTO #arguments.schema#.finance_attachment (attachment_id, record_id, file_name, content_type, size_bytes, sha256, content, created, createdByID) VALUES (:aid, :id, :fileName, :contentType, :size, :sha, :content, :created, :creator)",
				{
					aid = idParam(local.attachmentId),
					id = idParam(arguments.route.id),
					fileName = {value = local.up.clientFile, cfsqltype = "cf_sql_nvarchar"},
					contentType = {value = local.up.contentType & "/" & local.up.contentSubType, cfsqltype = "cf_sql_nvarchar"},
					size = {value = arrayLen(local.bytes), cfsqltype = "cf_sql_integer"},
					sha = {value = variables.envelope.sha256Hex(local.bytes), cfsqltype = "cf_sql_char"},
					content = {value = local.bytes, cfsqltype = "cf_sql_blob"},
					created = {value = now(), cfsqltype = "cf_sql_timestamp"},
					creator = idParam(variables.auth.userId())
				}
			);
		} finally {
			if (fileExists(local.path)) {
				fileDelete(local.path);
			}
		}
		local.qry = queryExecute(
			"SELECT attachment_id, record_id, file_name, content_type, size_bytes, sha256, created, createdByID FROM #arguments.schema#.finance_attachment WHERE attachment_id = :aid",
			{aid = idParam(local.attachmentId)}
		);
		return {"data" = variables.envelope.rows(local.qry)[1]};
	}

	private struct function download(required struct route, required string schema) hint="Returns an attachment of the record as a file result." {
		requireRecord(arguments.route, arguments.schema);
		local.qry = queryExecute(
			"SELECT content, content_type, file_name FROM #arguments.schema#.finance_attachment WHERE attachment_id = :aid AND record_id = :id",
			{aid = idParam(arguments.route.tail), id = idParam(arguments.route.id)}
		);
		if (!local.qry.recordCount) {
			variables.envelope.raise("notFound");
		}
		return {"file" = {"bytes" = local.qry.content[1], "contentType" = local.qry.content_type[1], "fileName" = local.qry.file_name[1]}};
	}

	private struct function rollups(required struct route, required string schema) hint="Lists the program's per-period, per-state totals." {
		// finance_rollup has no siteID: the program schema is per site. Binary collation keeps usp_finance_rollup's order.
		local.qry = queryExecute(
			"SELECT * FROM #arguments.schema#.finance_rollup ORDER BY period COLLATE Latin1_General_BIN2, state COLLATE Latin1_General_BIN2"
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private string function gate(required struct route, required array roles) hint="Requires login and one of roles, then returns the site's bracket-quoted program schema." {
		variables.auth.requireAny(arguments.roles);
		return "[" & variables.auth.programSchema(arguments.route.siteid) & "]";
	}

	private query function findRecord(required string schema, required string siteid, required string recordId) hint="Returns the record with recordId in the site, possibly empty." {
		return queryExecute(
			"SELECT * FROM #arguments.schema#.finance_record WHERE record_id = :id AND siteID = :siteid",
			{id = idParam(arguments.recordId), siteid = siteParam(arguments.siteid)}
		);
	}

	private query function requireRecord(required struct route, required string schema) hint="Returns the route's record, or raises notFound when it is not in this program and site." {
		local.qry = findRecord(arguments.schema, arguments.route.siteid, arguments.route.id);
		if (!local.qry.recordCount) {
			variables.envelope.raise("notFound");
		}
		return local.qry;
	}

	private struct function recordFields(required struct params) hint="Returns title, amount and period as strings, or raises invalidParameters unless all three are valid." {
		local.fields = {};
		for (local.name in ["title", "amount", "period"]) {
			local.value = structKeyExists(arguments.params, local.name) && !isNull(arguments.params[local.name]) ? arguments.params[local.name] : "";
			local.fields[local.name] = isSimpleValue(local.value) ? toString(local.value) : "";
		}
		if (!len(trim(local.fields.title)) || len(local.fields.title) > variables.titleMaxLength
			|| !reFind("^-?[0-9]{1,15}(\.[0-9]{1,4})?$", local.fields.amount)
			|| !reFind("^[0-9]{4}-(0[1-9]|1[0-2])$", local.fields.period)) {
			variables.envelope.raise("invalidParameters");
		}
		return local.fields;
	}

	private boolean function isFilePart(required string field) hint="Returns true when the multipart request carries a named file part for field, as Masa's fileManager.getPostedClientFileName reads it on Adobe." {
		local.parts = form.getPartsArray();
		if (!isNull(local.parts)) {
			for (local.part in local.parts) {
				if (local.part.isFile() && local.part.getName() == arguments.field && len(local.part.getFileName())) {
					return true;
				}
			}
		}
		return false;
	}

	private struct function fieldParams(struct fields) hint="Returns typed title, amount and period query params; without fields all three bind as NULL." {
		local.unset = isNull(arguments.fields);
		return {
			title = {value = local.unset ? "" : arguments.fields.title, cfsqltype = "cf_sql_nvarchar", null = local.unset},
			amount = {value = local.unset ? "" : arguments.fields.amount, cfsqltype = "cf_sql_decimal", scale = 4, null = local.unset},
			period = {value = local.unset ? "" : arguments.fields.period, cfsqltype = "cf_sql_varchar", null = local.unset}
		};
	}

	private void function mapOutcome(required struct row) hint="Raises the error envelope type for a non-legal usp_finance_transition outcome." {
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
				throw(type="opt2.finance.outcome", message="Unexpected finance transition outcome");
		}
	}

	private void function refreshRollup(required string schema, required date now) hint="Rebuilds the program's rollup through usp_finance_rollup." {
		queryExecute(
			"EXEC #arguments.schema#.usp_finance_rollup @now = :now",
			{now = {value = arguments.now, cfsqltype = "cf_sql_timestamp"}}
		);
	}

	private struct function idParam(required string value) hint="Returns a char(35) id query param." {
		return {value = arguments.value, cfsqltype = "cf_sql_char"};
	}

	private struct function siteParam(required string siteid) hint="Returns a siteID query param." {
		return {value = arguments.siteid, cfsqltype = "cf_sql_varchar"};
	}

}
