// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="SYNTHETIC reporting fixture: asynchronous XLSX, CSV and PDF export jobs run in cfthread through queued, running, done or failed." {

	public any function init(required any envelope, required any auth) hint="Stores the shared envelope and auth helpers." {
		variables.envelope = arguments.envelope;
		variables.auth = arguments.auth;
		variables.jobColumns = "[job_id], [siteID], [definition_id], [format], [state], [requested_by_id], [created], [started_at], [finished_at], [error], [file_name], [content_type], [output_sha256]";
		variables.contentTypes = {
			"xlsx" = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			"csv" = "text/csv",
			"pdf" = "application/pdf"
		};
		variables.crlf = chr(13) & chr(10);
		variables.csvQuotePattern = '[",' & chr(13) & chr(10) & ']';
		return this;
	}

	public struct function handle(required struct route) hint="Dispatches exports (GET, POST), exports/{id} (GET) and exports/{id}/download (GET); anything else raises notFound." {
		local.key = arguments.route.resource
			& (len(arguments.route.id) ? "/{id}" : "")
			& (len(arguments.route.action) ? "/" & arguments.route.action : "")
			& (len(arguments.route.tail) ? "/+" : "")
			& " " & arguments.route.httpMethod;
		switch (local.key) {
			case "exports POST":
				return createExport(arguments.route);
			case "exports GET":
				return listExports(arguments.route);
			case "exports/{id} GET":
				return exportDetail(arguments.route);
			case "exports/{id}/download GET":
				return download(arguments.route);
		}
		variables.envelope.raise("notFound");
	}

	private void function authorize() hint="Requires a logged-in session user who holds reporting.exporter in the request site." {
		variables.auth.requireLogin();
		variables.auth.requireAny(["reporting.exporter"]);
	}

	private struct function createExport(required struct route) hint="Queues a job for a definition of the site, starts its runner thread and returns the job as queued." {
		authorize();
		local.definition = queryExecute(
			"SELECT [definition_id] FROM synthetic.export_definition WHERE [definition_id] = :definitionId AND [siteID] = :siteid",
			{definitionId = idParam(textParam(arguments.route.params, "definitionId")), siteid = siteParam(arguments.route.siteid)}
		);
		if (!local.definition.recordCount) {
			variables.envelope.raise("notFound");
		}
		local.format = textParam(arguments.route.params, "format");
		if (!reFind("^(xlsx|csv|pdf)$", local.format)) {
			variables.envelope.raise("invalidParameters");
		}
		local.asOf = asOfParam(arguments.route.params);

		local.jobId = createUUID();
		queryExecute(
			"INSERT INTO synthetic.export_job ([job_id], [siteID], [definition_id], [format], [state], [requested_by_id], [created])
			VALUES (:jobId, :siteid, :definitionId, :format, N'queued', :userid, :created)",
			{
				jobId = idParam(local.jobId),
				siteid = siteParam(arguments.route.siteid),
				definitionId = idParam(local.definition.definition_id[1]),
				format = {value = local.format, cfsqltype = "cf_sql_varchar"},
				userid = idParam(variables.auth.userId()),
				created = {value = now(), cfsqltype = "cf_sql_timestamp"}
			}
		);
		// Read before the thread starts, so the response always shows the job as queued.
		local.job = jobRows(arguments.route.siteid, local.jobId)[1];
		cfthread(name = "opt2-export-" & local.jobId, action = "run", jobId = local.jobId, siteid = arguments.route.siteid, asOf = local.asOf) {
			variables.runExport(attributes.jobId, attributes.siteid, attributes.asOf);
		}
		return {"data" = local.job};
	}

	private struct function listExports(required struct route) hint="Lists the site's jobs, without output, ordered by created, job_id." {
		authorize();
		return variables.envelope.list(jobRows(arguments.route.siteid), arguments.route.params);
	}

	private struct function exportDetail(required struct route) hint="Returns one job of the site without output; raises notFound outside the site." {
		authorize();
		local.job = jobRows(arguments.route.siteid, arguments.route.id);
		if (!arrayLen(local.job)) {
			variables.envelope.raise("notFound");
		}
		return {"data" = local.job[1]};
	}

	private struct function download(required struct route) hint="Returns a done job's output as a file result; raises notFound outside the site and conflict not-ready before done." {
		authorize();
		local.qry = queryExecute(
			"SELECT [state], [file_name], [content_type], [output] FROM synthetic.export_job WHERE [job_id] = :jobId AND [siteID] = :siteid",
			{jobId = idParam(arguments.route.id), siteid = siteParam(arguments.route.siteid)}
		);
		if (!local.qry.recordCount) {
			variables.envelope.raise("notFound");
		}
		if (compare(local.qry.state[1], "done") != 0) {
			variables.envelope.raise("conflict", "not-ready");
		}
		return {"file" = {"bytes" = local.qry.output[1], "contentType" = local.qry.content_type[1], "fileName" = local.qry.file_name[1]}};
	}

	private void function runExport(required string jobId, required string siteid, required string asOf) hint="Thread body: moves the job to running, builds its output and records done, or failed with source-unavailable or export-failed." {
		if (moveJob(arguments.jobId, "running") != "legal") {
			return;
		}
		try {
			local.job = queryExecute(
				"SELECT [j].[format], [d].[name], [d].[source], [d].[columns] AS [column_json]
				FROM synthetic.export_job AS [j]
				INNER JOIN synthetic.export_definition AS [d] ON [d].[definition_id] = [j].[definition_id] AND [d].[siteID] = [j].[siteID]
				WHERE [j].[job_id] = :jobId AND [j].[siteID] = :siteid",
				{jobId = idParam(arguments.jobId), siteid = siteParam(arguments.siteid)}
			);
			if (!local.job.recordCount) {
				throw(type = "opt2.reporting.definition", message = "Export job or definition not found");
			}
			if (compare(local.job.source[1], "broken") == 0) {
				moveJob(arguments.jobId, "failed", {error = "source-unavailable"});
				return;
			}
			local.format = local.job.format[1];
			local.table = exportTable(sourceQuery(local.job.source[1], arguments.siteid, arguments.asOf), local.job.column_json[1]);
			if (compare(local.format, "xlsx") == 0) {
				local.bytes = xlsxBytes(local.table);
			} else if (compare(local.format, "csv") == 0) {
				local.bytes = csvBytes(local.table);
			} else if (compare(local.format, "pdf") == 0) {
				local.bytes = pdfBytes(local.table, local.job.name[1]);
			} else {
				throw(type = "opt2.reporting.format", message = "Unknown export format");
			}
			moveJob(arguments.jobId, "done", {
				fileName = "export-" & arguments.jobId & "." & local.format,
				contentType = variables.contentTypes[local.format],
				output = local.bytes,
				sha256 = variables.envelope.sha256Hex(local.bytes)
			});
		} catch (any e) {
			// A non-legal outcome here means the job already left running; the runner ends either way.
			moveJob(arguments.jobId, "failed", {error = "export-failed"});
		}
	}

	private query function sourceQuery(required string source, required string siteid, required string asOf) hint="Returns the site's source rows from its program schema: timesheet statuses as of asOf, or finance records; throws for any other source." {
		local.schema = "[" & variables.auth.programSchema(arguments.siteid) & "]";
		if (compare(arguments.source, "timesheets.sheets") == 0) {
			return queryExecute(
				"SELECT * FROM #local.schema#.tvf_timesheet_status(:asOf) WHERE siteID = :siteid ORDER BY period_start, timesheet_id",
				{asOf = {value = arguments.asOf, cfsqltype = "cf_sql_date"}, siteid = siteParam(arguments.siteid)}
			);
		}
		if (compare(arguments.source, "finance.records") == 0) {
			return queryExecute(
				"SELECT * FROM #local.schema#.finance_record WHERE siteID = :siteid ORDER BY created, record_id",
				{siteid = siteParam(arguments.siteid)}
			);
		}
		throw(type = "opt2.reporting.source", message = "Unknown export source");
	}

	private array function exportTable(required query source, required string columnJson) hint="Returns a header row of the definition's columns as given, then each source row's formatted values in that order; throws when the list is not an array or names a column the source lacks." {
		local.columns = deserializeJSON(arguments.columnJson);
		if (!isArray(local.columns)) {
			throw(type = "opt2.reporting.columns", message = "Export columns are not an array");
		}
		local.header = [];
		for (local.column in local.columns) {
			if (!isSimpleValue(local.column) || !listFindNoCase(arguments.source.columnList, local.column)) {
				throw(type = "opt2.reporting.columns", message = "Export column not in source");
			}
			arrayAppend(local.header, toString(local.column));
		}
		local.table = [local.header];
		for (local.row in variables.envelope.rows(arguments.source)) {
			local.values = [];
			for (local.column in local.header) {
				arrayAppend(local.values, toString(local.row[local.column]));
			}
			arrayAppend(local.table, local.values);
		}
		return local.table;
	}

	private binary function xlsxBytes(required array table) hint="Returns the table as one XLSX sheet named export with every cell stored as a string." {
		local.sheet = spreadsheetNew("export", true);
		// spreadsheetAddRows ignores its datatype argument for array data and stores numbers and dates, so each cell is set as a string.
		for (local.r = 1; local.r <= arrayLen(arguments.table); local.r++) {
			for (local.c = 1; local.c <= arrayLen(arguments.table[local.r]); local.c++) {
				spreadsheetSetCellValue(local.sheet, arguments.table[local.r][local.c], local.r, local.c, "string");
			}
		}
		return spreadsheetReadBinary(local.sheet);
	}

	private binary function csvBytes(required array table) hint="Returns the table as RFC 4180 CSV in UTF-8 without a BOM, every line ending in CRLF." {
		local.out = createObject("java", "java.lang.StringBuilder").init();
		for (local.values in arguments.table) {
			local.fields = [];
			for (local.value in local.values) {
				arrayAppend(local.fields, reFind(variables.csvQuotePattern, local.value) ? '"' & replace(local.value, '"', '""', "all") & '"' : local.value);
			}
			local.out.append(javaCast("string", arrayToList(local.fields, ",") & variables.crlf));
		}
		return charsetDecode(local.out.toString(), "utf-8");
	}

	private binary function pdfBytes(required array table, required string title) hint="Returns a PDF of an h1 with the definition name and a table whose first row is the th header row." {
		local.html = createObject("java", "java.lang.StringBuilder").init(javaCast("string", "<h1>" & encodeForHTML(arguments.title) & "</h1><table>"));
		for (local.i = 1; local.i <= arrayLen(arguments.table); local.i++) {
			local.cell = local.i == 1 ? "th" : "td";
			local.html.append(javaCast("string", "<tr>"));
			for (local.value in arguments.table[local.i]) {
				local.html.append(javaCast("string", "<" & local.cell & ">" & encodeForHTML(local.value) & "</" & local.cell & ">"));
			}
			local.html.append(javaCast("string", "</tr>"));
		}
		local.html.append(javaCast("string", "</table>"));
		cfdocument(format = "pdf", name = "local.pdfBytes") {
			writeOutput(local.html.toString());
		}
		return local.pdfBytes;
	}

	private array function jobRows(required string siteid, string jobId = "") hint="Returns the site's job rows without output ordered by created, job_id; only jobId's row when it is given." {
		local.sql = "SELECT #variables.jobColumns# FROM synthetic.export_job WHERE [siteID] = :siteid";
		local.params = {siteid = siteParam(arguments.siteid)};
		if (len(arguments.jobId)) {
			local.sql &= " AND [job_id] = :jobId";
			local.params.jobId = idParam(arguments.jobId);
		}
		return variables.envelope.rows(queryExecute(local.sql & " ORDER BY [created], [job_id]", local.params));
	}

	private string function moveJob(required string jobId, required string toState, struct values = {}) hint="Applies one state move through usp_export_job_transition and returns its outcome; values may carry error, fileName, contentType, output and sha256, the rest bind as NULL." {
		local.result = queryExecute(
			"EXEC synthetic.usp_export_job_transition @job_id = :jobId, @to_state = :toState, @now = :now, @error = :error, @file_name = :fileName, @content_type = :contentType, @output = :output, @output_sha256 = :sha256",
			{
				jobId = idParam(arguments.jobId),
				toState = {value = arguments.toState, cfsqltype = "cf_sql_varchar"},
				now = {value = now(), cfsqltype = "cf_sql_timestamp"},
				error = optionalParam(arguments.values, "error", "cf_sql_varchar"),
				fileName = optionalParam(arguments.values, "fileName", "cf_sql_varchar"),
				contentType = optionalParam(arguments.values, "contentType", "cf_sql_varchar"),
				output = optionalParam(arguments.values, "output", "cf_sql_blob"),
				sha256 = optionalParam(arguments.values, "sha256", "cf_sql_char")
			}
		);
		return local.result.outcome[1];
	}

	private struct function optionalParam(required struct values, required string key, required string type) hint="Returns a typed param bound to values[key], or a NULL param when the key is absent." {
		local.present = structKeyExists(arguments.values, arguments.key);
		return {value = local.present ? arguments.values[arguments.key] : "", cfsqltype = arguments.type, null = !local.present};
	}

	private string function asOfParam(required struct params) hint="Returns params.asOf, or today as yyyy-mm-dd when it is absent or null; raises invalidParameters unless it is a real yyyy-mm-dd date from 1753 on, SQL Server datetime's floor." {
		if (!structKeyExists(arguments.params, "asOf") || isNull(arguments.params.asOf)) {
			return dateFormat(now(), "yyyy-mm-dd");
		}
		local.text = isSimpleValue(arguments.params.asOf) ? toString(arguments.params.asOf) : "";
		if (!reFind("^\d{4}-\d{2}-\d{2}$", local.text) || val(left(local.text, 4)) < 1753
			|| val(mid(local.text, 6, 2)) < 1 || val(mid(local.text, 6, 2)) > 12 || val(right(local.text, 2)) < 1
			|| val(right(local.text, 2)) > daysInMonth(createDate(val(left(local.text, 4)), val(mid(local.text, 6, 2)), 1))) {
			variables.envelope.raise("invalidParameters");
		}
		return local.text;
	}

	private string function textParam(required struct params, required string name) hint="Returns a simple-valued param as a string, or an empty string when it is absent, null or complex." {
		local.value = structKeyExists(arguments.params, arguments.name) && !isNull(arguments.params[arguments.name]) ? arguments.params[arguments.name] : "";
		return isSimpleValue(local.value) ? toString(local.value) : "";
	}

	private struct function idParam(required string value) hint="Returns a char(35) id query param." {
		return {value = arguments.value, cfsqltype = "cf_sql_char"};
	}

	private struct function siteParam(required string siteid) hint="Returns a siteID query param." {
		return {value = arguments.siteid, cfsqltype = "cf_sql_varchar"};
	}

}
