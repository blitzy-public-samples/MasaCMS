<!--- SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/ --->
<cfscript>
	variables.envelope = createObject("component", "lib.envelope").init();
	variables.auth = createObject("component", "lib.auth").init();

	variables.masaParts = "sites,groups,users,memberships,categories,content,files,oauthClients";
	variables.loopback = "127.0.0.1,::1,0:0:0:0:0:0:0:1";
	// Fixture tables and the seed procedure that loads each; an empty name marks a table seeded by no procedure.
	variables.fixtureProcedures = {
		"synthetic" = {
			"person_archive" = "",
			"survey" = "usp_seed_surveys",
			"survey_schedule" = "usp_seed_surveys",
			"survey_reminder" = "usp_seed_surveys",
			"survey_target" = "usp_seed_surveys",
			"survey_response" = "usp_seed_surveys",
			"export_definition" = "usp_seed_reporting",
			"export_job" = "usp_seed_reporting",
			"message_template" = "usp_seed_communications",
			"message" = "usp_seed_communications",
			"delivery_status" = "usp_seed_communications",
			"signature_request" = "usp_seed_esignature",
			"signature" = "usp_seed_esignature",
			"audit_entry" = "usp_seed_esignature"
		},
		"program" = {
			"timesheet" = "usp_seed_timesheets",
			"timesheet_day" = "usp_seed_timesheets",
			"approval_action" = "usp_seed_timesheets",
			"blackout" = "usp_seed_timesheets",
			"finance_record" = "usp_seed_finance",
			"finance_record_version" = "usp_seed_finance",
			"finance_attachment" = "usp_seed_finance"
		}
	};
	// Envelope params carry only these three values, never the body, so no credential can be echoed.
	variables.call = {"part" = "", "offset" = 0, "limit" = ""};

	/** Returns row[key], or fallback when the key is absent or JSON null. */
	any function rowValue(required struct row, required string key, any fallback = "") {
		return structKeyExists(arguments.row, arguments.key) ? arguments.row[arguments.key] : arguments.fallback;
	}

	/** Returns a copy of row without its JSON-null members, which Masa's bean setters cannot take. */
	struct function rowData(required struct row) {
		local.data = {};
		for (local.key in arguments.row) {
			if (structKeyExists(arguments.row, local.key)) {
				local.data[local.key] = arguments.row[local.key];
			}
		}
		return local.data;
	}

	/** Returns the row's remoteID, or its dataset id when it has none. */
	string function remoteIdOf(required struct row, required string idKey) {
		local.remoteID = rowValue(arguments.row, "remoteID");
		return len(local.remoteID) ? local.remoteID : arguments.row[arguments.idKey];
	}

	/** True when a Masa read found a record; Masa answers with an array when several match. */
	boolean function found(required any bean) {
		return isArray(arguments.bean) || !arguments.bean.getIsNew();
	}

	/** Raises invalidParameters naming the row and the bean's error keys, never their values. */
	void function requireValid(required any bean, required string rowId) {
		local.errors = arguments.bean.getErrors();
		if (!structIsEmpty(local.errors)) {
			variables.envelope.raise("invalidParameters", "Row #arguments.rowId# failed validation: #listSort(structKeyList(local.errors), 'textnocase')#");
		}
	}

	/** Returns the secret at path inside the request's credentials, or raises invalidParameters naming only the row. */
	string function secretFor(required any credentials, required array path, required string rowId) {
		local.node = arguments.credentials;
		for (local.key in arguments.path) {
			if (!isStruct(local.node) || !structKeyExists(local.node, local.key)) {
				variables.envelope.raise("invalidParameters", "Row #arguments.rowId# has no credential");
			}
			local.node = local.node[local.key];
		}
		if (!isSimpleValue(local.node) || !len(local.node)) {
			variables.envelope.raise("invalidParameters", "Row #arguments.rowId# has no credential");
		}
		return local.node;
	}

	/** Returns the canonical part name for a canonical or manifest (masa.<array>, fixtures.<schema>.<table>) name. */
	string function canonicalPart(required string raw) {
		local.name = trim(arguments.raw);
		if (left(local.name, 5) == "masa.") {
			local.name = mid(local.name, 6, len(local.name));
		} else if (left(local.name, 9) == "fixtures.") {
			local.name = "fixtures:" & mid(local.name, 10, len(local.name));
		}
		local.position = listFindNoCase(variables.masaParts, local.name);
		if (local.position) {
			return listGetAt(variables.masaParts, local.position);
		}
		if (reFindNoCase("^fixtures:[A-Za-z0-9_]+\.[A-Za-z0-9_]+$", local.name)) {
			return "fixtures:" & mid(local.name, 10, len(local.name));
		}
		variables.envelope.raise("invalidParameters", "Unknown seed part");
	}

	/** Returns a non-negative integer url parameter, fallback when absent or empty, or raises invalidParameters. */
	numeric function urlCount(required string name, required numeric fallback) {
		if (!structKeyExists(url, arguments.name) || !len(url[arguments.name])) {
			return arguments.fallback;
		}
		if (!isValid("integer", url[arguments.name]) || url[arguments.name] < 0) {
			variables.envelope.raise("invalidParameters", "#arguments.name# must be a non-negative integer");
		}
		return int(url[arguments.name]);
	}

	/** Creates each absent site through settingsManager.create, which also creates its private-pool Admin group. */
	struct function seedSites(required array rows) {
		local.inserted = 0;
		// A seeded site takes the installed default site's theme, as Masa's add-site form preselects an installed theme.
		local.theme = application.settingsManager.getSite("default").getTheme();
		for (local.row in arguments.rows) {
			if (application.settingsManager.siteExists(local.row.siteID)) {
				continue;
			}
			local.data = {
				"siteID" = local.row.siteID,
				"site" = local.row.site,
				"domain" = rowValue(local.row, "domain"),
				"domainAlias" = rowValue(local.row, "domainAlias"),
				"orderNo" = rowValue(local.row, "orderNo", 0),
				"theme" = local.theme,
				"publicUserPoolID" = local.row.publicUserPoolID,
				"privateUserPoolID" = local.row.privateUserPoolID,
				"categoryPoolID" = local.row.categoryPoolID,
				"filePoolID" = local.row.filePoolID,
				"displayPoolID" = local.row.displayPoolID,
				"contentPoolID" = rowValue(local.row, "contentPoolID", local.row.siteID)
			};
			requireValid(application.settingsManager.create(local.data), local.row.siteID);
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Returns the Masa id of a membership row's group: its dataset id when stored, else the group of that name in the row's pool. */
	string function resolveGroup(required struct row) {
		local.groupID = rowValue(arguments.row, "groupID");
		if (len(local.groupID)) {
			local.group = application.userManager.read(userid = local.groupID);
			if (!local.group.getIsNew() && local.group.getType() == 1) {
				return local.groupID;
			}
		}
		local.name = rowValue(arguments.row, "groupname");
		local.site = rowValue(arguments.row, "groupSiteID", rowValue(arguments.row, "siteID"));
		if (len(local.name) && len(local.site)) {
			local.group = application.userManager.readByGroupName(local.name, local.site, rowValue(arguments.row, "isPublic", 0));
			if (!isArray(local.group) && !local.group.getIsNew()) {
				return local.group.getUserID();
			}
		}
		local.named = len(local.groupID) ? local.groupID : local.name;
		variables.envelope.raise("invalidParameters", "Membership of user #rowValue(arguments.row, 'userID')# names an unknown group #local.named#");
	}

	/** Creates each absent Type 1 group with its dataset id; a group of the same name in the pool, such as Masa's Admin, counts as present. */
	struct function seedGroups(required array rows) {
		local.inserted = 0;
		for (local.row in arguments.rows) {
			local.remoteID = remoteIdOf(local.row, "groupID");
			if (found(application.userManager.readByRemoteID(local.remoteID, local.row.siteID))
				|| found(application.userManager.readByGroupName(local.row.groupname, local.row.siteID, rowValue(local.row, "isPublic", 0)))) {
				continue;
			}
			local.data = rowData(local.row);
			// userBean.groupID is the membership list, so a group row's own id must not reach it.
			structDelete(local.data, "groupID");
			local.data.userID = local.row.groupID;
			local.data.type = 1;
			local.data.remoteID = local.remoteID;
			requireValid(application.userManager.create(local.data), local.row.groupID);
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Creates each absent Type 2 user with its dataset id and its password from the request's credentials. */
	struct function seedUsers(required array rows, required any credentials) {
		local.inserted = 0;
		for (local.row in arguments.rows) {
			local.remoteID = remoteIdOf(local.row, "userID");
			if (found(application.userManager.readByRemoteID(local.remoteID, local.row.siteID))) {
				continue;
			}
			local.data = rowData(local.row);
			local.data.type = 2;
			local.data.s2 = 0;
			local.data.remoteID = local.remoteID;
			local.data.password = secretFor(arguments.credentials, [local.row.siteID, local.row.username], local.row.userID);
			if (len(rowValue(local.row, "groupID"))) {
				local.groups = [];
				for (local.groupID in listToArray(local.row.groupID)) {
					arrayAppend(local.groups, resolveGroup({"userID" = local.row.userID, "groupID" = trim(local.groupID)}));
				}
				local.data.groupID = arrayToList(local.groups);
			}
			requireValid(application.userManager.create(local.data), local.row.userID);
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Adds each absent membership through userManager.createUserInGroup. */
	struct function seedMemberships(required array rows) {
		local.inserted = 0;
		for (local.row in arguments.rows) {
			local.groupID = resolveGroup(local.row);
			local.held = application.userManager.readMemberships(local.row.userID);
			if (listFindNoCase(valueList(local.held.groupID), local.groupID)) {
				continue;
			}
			application.userManager.createUserInGroup(local.row.userID, local.groupID);
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Creates each absent category with its dataset id in its category pool site. */
	struct function seedCategories(required array rows) {
		local.inserted = 0;
		for (local.row in arguments.rows) {
			local.remoteID = remoteIdOf(local.row, "categoryID");
			if (found(application.categoryManager.read(remoteID = local.remoteID, siteID = local.row.siteID))) {
				continue;
			}
			local.data = rowData(local.row);
			local.data.parentID = rowValue(local.row, "parentID");
			local.data.remoteID = local.remoteID;
			requireValid(application.categoryManager.create(local.data), local.row.categoryID);
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Saves each absent content node's versions oldest first, so Masa writes one tcontent history row per version. */
	struct function seedContent(required array rows) {
		local.inserted = 0;
		for (local.row in arguments.rows) {
			local.remoteID = remoteIdOf(local.row, "contentID");
			if (found(application.contentManager.read(remoteID = local.remoteID, siteID = local.row.siteID))) {
				continue;
			}
			local.categoryIDs = rowValue(local.row, "categoryIDs", []);
			local.node = {
				"contentID" = local.row.contentID,
				"siteID" = local.row.siteID,
				"parentID" = local.row.parentID,
				"type" = local.row.type,
				"subType" = rowValue(local.row, "subType", "Default"),
				"isNav" = rowValue(local.row, "isNav", 1),
				"display" = rowValue(local.row, "display", 1),
				"remoteID" = local.remoteID,
				"categoryID" = arrayToList(local.categoryIDs)
			};
			// Masa's category form posts one categoryAssign<id without dashes> field per assigned category; 0 is "not featured".
			for (local.categoryID in local.categoryIDs) {
				local.node["categoryAssign" & replace(local.categoryID, "-", "", "all")] = 0;
			}
			// The dataset's contentHistID is never passed: Masa always generates it, and a given one would be read as the version to edit.
			for (local.version in local.row.versions) {
				local.data = duplicate(local.node);
				local.data.title = local.version.title;
				local.data.menuTitle = local.version.title;
				local.data.summary = rowValue(local.version, "summary");
				local.data.body = rowValue(local.version, "body");
				local.data.approved = rowValue(local.version, "approved", 0);
				requireValid(application.contentManager.save(local.data), local.row.contentID);
			}
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Stores each absent file under its dataset id through Masa's upload path, which writes the _source, _small and _medium image renditions. */
	struct function seedFiles(required array rows) {
		local.inserted = 0;
		local.fileManager = application.serviceFactory.getBean("fileManager");
		for (local.row in arguments.rows) {
			if (!application.serviceFactory.getBean("file").loadBy(fileID = local.row.fileID).getIsNew()) {
				continue;
			}
			local.dir = getTempDirectory() & createUUID();
			directoryCreate(local.dir);
			try {
				local.path = local.dir & "/" & getFileFromPath(local.row.filename);
				fileWrite(local.path, binaryDecode(local.row.bytes, rowValue(local.row, "encoding", "base64") == "hex" ? "hex" : "base64"));
				local.upload = local.fileManager.emulateUpload(filePath = local.path);
				// The same steps as fileBean.save(), which is not used because it replaces the fileID with a new UUID.
				local.args = structCopy(local.upload);
				structAppend(local.args, local.fileManager.Process(local.upload, local.row.siteID));
				if (isStruct(local.args.exif)) {
					local.args.exif = serializeJSON(local.args.exif);
				}
				local.args.fileExt = local.upload.serverFileExt;
				local.args.filename = local.row.filename;
				local.args.fileID = local.row.fileID;
				local.args.siteID = local.row.siteID;
				local.args.moduleID = local.row.moduleID;
				local.args.contentID = rowValue(local.row, "contentID");
				local.args.remoteID = remoteIdOf(local.row, "fileID");
				local.fileManager.create(argumentCollection = local.args);
			} finally {
				directoryDelete(local.dir, true);
			}
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Saves each absent OAuth client with its dataset id and its secret from the request's credentials. */
	struct function seedOAuthClients(required array rows, required any credentials) {
		local.inserted = 0;
		for (local.row in arguments.rows) {
			local.client = application.serviceFactory.getBean("oauthClient").loadBy(clientid = local.row.clientID);
			if (!local.client.getIsNew()) {
				continue;
			}
			local.client.set({
				"clientid" = local.row.clientID,
				"clientsecret" = secretFor(arguments.credentials, [local.row.clientID], local.row.clientID),
				"siteid" = local.row.siteID,
				"userid" = rowValue(local.row, "userID"),
				"name" = local.row.name,
				"description" = rowValue(local.row, "description"),
				"granttype" = rowValue(local.row, "grantType", "client_credentials"),
				"redirecturl" = rowValue(local.row, "redirectURL")
			});
			local.client.save();
			requireValid(local.client, local.row.clientID);
			local.inserted++;
		}
		return {"total" = arrayLen(arguments.rows), "inserted" = local.inserted};
	}

	/** Loads rows first .. first + count - 1 of a fixture part through its table's seed procedure; returns {total, inserted}. */
	struct function seedFixture(required string part, required string body, required numeric first, required numeric count, required numeric rowCount) {
		local.schemaName = listFirst(listRest(arguments.part, ":"), ".");
		local.table = lCase(listLast(arguments.part, "."));
		if (local.schemaName == "synthetic") {
			local.schema = "synthetic";
			local.procedures = variables.fixtureProcedures.synthetic;
		} else if (reFindNoCase("^Program_[0-9]{1,9}$", local.schemaName)) {
			local.program = queryExecute(
				"SELECT program_id FROM synthetic.program_site WHERE program_id = :programId",
				{programId = {value = listLast(local.schemaName, "_"), cfsqltype = "cf_sql_integer"}}
			);
			if (!local.program.recordCount) {
				variables.envelope.raise("invalidParameters", "Unknown program schema");
			}
			// The schema name is built only from the stored integer, never from the request.
			local.schema = "Program_" & int(local.program.program_id[1]);
			local.procedures = variables.fixtureProcedures.program;
		} else {
			variables.envelope.raise("invalidParameters", "Unknown seed part");
		}
		if (!structKeyExists(local.procedures, local.table)) {
			variables.envelope.raise("invalidParameters", "Unknown seed part");
		}
		local.procedure = local.procedures[local.table];
		if (!len(local.procedure)) {
			if (arguments.rowCount) {
				variables.envelope.raise("invalidParameters", "#local.schema#.#local.table# is seeded empty");
			}
			return {"total" = 0, "inserted" = 0};
		}
		if (local.procedure == "usp_seed_finance") {
			local.businessDate = structKeyExists(url, "businessDate") ? url.businessDate : "";
			if (!reFind("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", local.businessDate) || !isDate(local.businessDate)) {
				variables.envelope.raise("invalidParameters", "businessDate must be yyyy-mm-dd");
			}
			local.now = createDate(listGetAt(local.businessDate, 1, "-"), listGetAt(local.businessDate, 2, "-"), listGetAt(local.businessDate, 3, "-"));
		}
		if (!arguments.count) {
			return {"total" = 0, "inserted" = 0};
		}

		// The raw body is reshaped in T-SQL: deserialised and re-serialised in CFML, money strings, hex and key case would not survive byte-exact.
		local.params = {
			body = {value = arguments.body, cfsqltype = "cf_sql_longnvarchar"},
			tableName = {value = local.table, cfsqltype = "cf_sql_nvarchar"}
		};
		if (arguments.first == 0 && arguments.count == arguments.rowCount) {
			local.rowsSql = "JSON_QUERY(@body, N'$.rows')";
		} else {
			local.rowsSql = "(SELECT N'[' + STRING_AGG(CAST([value] AS nvarchar(max)), N',') WITHIN GROUP (ORDER BY CAST([key] AS int)) + N']'"
				& " FROM OPENJSON(@body, N'$.rows') WHERE CAST([key] AS int) >= :first AND CAST([key] AS int) < :stop)";
			local.params.first = {value = arguments.first, cfsqltype = "cf_sql_integer"};
			local.params.stop = {value = arguments.first + arguments.count, cfsqltype = "cf_sql_integer"};
		}
		local.sql = "SET NOCOUNT ON;"
			& " DECLARE @body nvarchar(max) = :body;"
			& " DECLARE @path nvarchar(200) = N'$.""' + :tableName + N'""';"
			& " DECLARE @rows nvarchar(max) = #local.rowsSql#;"
			& " DECLARE @json nvarchar(max) = JSON_MODIFY(N'{}', @path, JSON_QUERY(@rows));"
			& " EXEC [#local.schema#].[#local.procedure#] @json = @json;";

		transaction {
			local.counts = queryExecute(local.sql, local.params);
			if (local.procedure == "usp_seed_finance") {
				queryExecute(
					"EXEC [#local.schema#].[usp_finance_rollup] @now = :now",
					{now = {value = local.now, cfsqltype = "cf_sql_timestamp"}}
				);
			}
		}

		local.inserted = 0;
		for (local.column in listToArray(local.counts.columnList)) {
			local.inserted += val(local.counts[local.column][1]);
		}
		return {"total" = arguments.count, "inserted" = local.inserted};
	}

	/** Validates the request, selects its rows and runs the part's handler; returns {part, offset, limit, total, inserted}. */
	struct function seed() {
		if (!structKeyExists(url, "part") || !len(url.part)) {
			variables.envelope.raise("invalidParameters", "part is required");
		}
		local.part = canonicalPart(url.part);
		variables.call.part = local.part;
		local.isFixture = left(local.part, 9) == "fixtures:";
		local.fixtures = structKeyExists(url, "fixtures") && len(url.fixtures) ? url.fixtures : true;
		if (!isBoolean(local.fixtures)) {
			variables.envelope.raise("invalidParameters", "fixtures must be a boolean");
		}
		if (local.isFixture && !local.fixtures) {
			variables.envelope.raise("badRequest", "Fixture parts are disabled; the synthetic services are seeded directly");
		}

		local.raw = getHTTPRequestData().content;
		if (isBinary(local.raw)) {
			local.raw = charsetEncode(local.raw, "utf-8");
		}
		if (!isJSON(local.raw)) {
			variables.envelope.raise("invalidParameters", "The body is not JSON");
		}
		local.body = deserializeJSON(local.raw);
		if (!isStruct(local.body) || !isArray(rowValue(local.body, "rows"))) {
			variables.envelope.raise("invalidParameters", "The body has no rows array");
		}
		if (len(rowValue(local.body, "array")) && compareNoCase(canonicalPart(local.body.array), local.part)) {
			variables.envelope.raise("invalidParameters", "The body holds another part");
		}
		local.base = rowValue(local.body, "offset", 0);
		if (!isValid("integer", local.base) || local.base < 0) {
			variables.envelope.raise("invalidParameters", "The body offset must be a non-negative integer");
		}

		// offset is a dataset-wide row index, as in the manifest and the part file, whose rows start at the body's own offset.
		local.rowCount = arrayLen(local.body.rows);
		local.offset = urlCount("offset", local.base);
		if (local.offset < local.base || local.offset > local.base + local.rowCount) {
			variables.envelope.raise("invalidParameters", "offset lies outside the part");
		}
		local.limit = urlCount("limit", local.base + local.rowCount - local.offset);
		local.first = local.offset - local.base;
		local.count = min(local.limit, local.rowCount - local.first);
		variables.call.offset = local.offset;
		variables.call.limit = local.limit;

		if (local.isFixture) {
			local.result = seedFixture(local.part, local.raw, local.first, local.count, local.rowCount);
		} else {
			local.rows = local.count ? arraySlice(local.body.rows, local.first + 1, local.count) : [];
			for (local.row in local.rows) {
				if (!isStruct(local.row)) {
					variables.envelope.raise("invalidParameters", "Every row must be an object");
				}
			}
			local.credentials = rowValue(local.body, "credentials", {});
			switch (local.part) {
				case "sites":
					local.result = seedSites(local.rows);
					break;
				case "groups":
					local.result = seedGroups(local.rows);
					break;
				case "users":
					local.result = seedUsers(local.rows, local.credentials);
					break;
				case "memberships":
					local.result = seedMemberships(local.rows);
					break;
				case "categories":
					local.result = seedCategories(local.rows);
					break;
				case "content":
					local.result = seedContent(local.rows);
					break;
				case "files":
					local.result = seedFiles(local.rows);
					break;
				default:
					local.result = seedOAuthClients(local.rows, local.credentials);
			}
		}
		return {
			"part" = local.part,
			"offset" = local.offset,
			"limit" = local.limit,
			"total" = local.result.total,
			"inserted" = local.result.inserted
		};
	}

	/** Returns a log-record.v1 JSON line for an unhandled exception, free of request values and exception text. */
	string function exceptionLogRecord(required any exception) {
		local.record = [:];
		local.record["timestamp"] = dateTimeFormat(dateConvert("local2utc", now()), "yyyy-mm-dd'T'HH:nn:ss.lll'Z'");
		local.record["severity"] = "ERROR";
		local.record["message"] = "Unhandled seed exception";
		local.record["service"] = "legacy-fixtures";
		local.record["version"] = "1.0.0";
		local.record["env"] = "local";
		local.record["requestId"] = createUUID();
		local.record["route"] = cgi.script_name;
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

	// Errors are collected here and written after the try, because the envelope output aborts.
	variables.result = {};
	try {
		// cgi.remote_addr is the socket peer; request.remoteAddr follows a configurable header and could be spoofed.
		if (!variables.auth.currentUser().isSuperUser() || !listFind(variables.loopback, cgi.remote_addr)) {
			variables.envelope.raise("authorization");
		}
		if (cgi.request_method != "POST") {
			variables.envelope.raise("invalidMethodCall");
		}
		variables.result = seed();
	} catch (opt2fixture e) {
		variables.failure = {"type" = listLast(e.type, "."), "message" = e.message};
	} catch (any e) {
		writeLog(type = "Error", file = "exception", text = exceptionLogRecord(e));
		// The exception stays out of the envelope: it can hold row values.
		variables.failure = {"type" = "server_error", "message" = ""};
	}

	if (structKeyExists(variables, "failure")) {
		variables.envelope.fail(type = variables.failure.type, method = "seed", params = variables.call, message = variables.failure.message);
	}
	variables.envelope.success(method = "seed", params = variables.call, data = variables.result);
</cfscript>
