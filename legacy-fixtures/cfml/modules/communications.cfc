// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="SYNTHETIC communications fixture: template store, send to Mailpit and delivery-status history." {

	public any function init(required any envelope, required any auth) hint="Stores the shared envelope and auth helpers." {
		variables.envelope = arguments.envelope;
		variables.auth = arguments.auth;
		variables.defaultFrom = "noreply@opt2.local";
		variables.smtpTimeoutSeconds = 10;
		variables.lookupBudgetMs = 10000;
		variables.lookupCallTimeoutSeconds = 2;
		variables.templateColumns = "template_id, siteID, name, subject, body_text, body_html, created, lastUpdate";
		variables.messageColumns = "message_id, siteID, template_id, to_address, from_address, subject, body_text, body_html, state, created, sent_at";
		return this;
	}

	public struct function handle(required struct route) hint="Dispatches the templates and messages routes; any other path or method raises notFound." {
		local.key = arguments.route.resource
			& (len(arguments.route.id) ? "/{id}" : "")
			& (len(arguments.route.action) || len(arguments.route.tail) ? "/+" : "")
			& " " & arguments.route.httpMethod;
		switch (local.key) {
			case "templates GET":
				return listTemplates(arguments.route);
			case "templates POST":
				return createTemplate(arguments.route);
			case "messages GET":
				return listMessages(arguments.route);
			case "messages POST":
				return sendMessage(arguments.route);
			case "messages/{id} GET":
				return messageDetail(arguments.route);
		}
		variables.envelope.raise("notFound");
	}

	private void function authorize() hint="Requires a logged-in session user who holds communications.sender in the request site." {
		variables.auth.requireLogin();
		variables.auth.requireAny(["communications.sender"]);
	}

	private struct function listTemplates(required struct route) hint="Lists the site's templates ordered by created, template_id." {
		authorize();
		local.qry = queryExecute(
			"SELECT " & variables.templateColumns & " FROM synthetic.message_template WHERE siteID = :siteid ORDER BY created, template_id",
			{siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"}}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function createTemplate(required struct route) hint="Stores a template with byte-exact bodies and returns the inserted row." {
		authorize();
		local.name = textParam(arguments.route.params, "name");
		local.subject = textParam(arguments.route.params, "subject");
		local.bodyText = textParam(arguments.route.params, "bodyText");
		local.bodyHtml = textParam(arguments.route.params, "bodyHtml");
		// Limits are the column sizes, so oversize input answers invalidParameters instead of a truncation error.
		if (!len(trim(local.name)) || len(local.name) > 100 || !len(trim(local.subject)) || len(local.subject) > 255
			|| !(len(local.bodyText) || len(local.bodyHtml))) {
			variables.envelope.raise("invalidParameters");
		}

		local.templateId = createUUID();
		local.now = now();
		queryExecute(
			"INSERT INTO synthetic.message_template (template_id, siteID, name, subject, body_text, body_html, created, lastUpdate)
			VALUES (:templateId, :siteid, :name, :subject, :bodyText, :bodyHtml, :now, :now)",
			{
				templateId = {value = local.templateId, cfsqltype = "cf_sql_char"},
				siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"},
				name = {value = local.name, cfsqltype = "cf_sql_nvarchar"},
				subject = {value = local.subject, cfsqltype = "cf_sql_nvarchar"},
				bodyText = {value = local.bodyText, cfsqltype = "cf_sql_longnvarchar"},
				bodyHtml = {value = local.bodyHtml, cfsqltype = "cf_sql_longnvarchar"},
				now = {value = local.now, cfsqltype = "cf_sql_timestamp"}
			}
		);
		return {"data" = variables.envelope.rows(findTemplate(local.templateId, arguments.route.siteid))[1]};
	}

	private struct function listMessages(required struct route) hint="Lists the site's messages ordered by created, message_id." {
		authorize();
		local.qry = queryExecute(
			"SELECT " & variables.messageColumns & " FROM synthetic.message WHERE siteID = :siteid ORDER BY created, message_id",
			{siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"}}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function messageDetail(required struct route) hint="Returns one message of the site with its delivery-status history." {
		authorize();
		return {"data" = detail(arguments.route.id, arguments.route.siteid)};
	}

	private struct function sendMessage(required struct route) hint="Queues, sends and confirms one message, recording each state change; returns the message detail." {
		authorize();
		local.mail = composeMessage(arguments.route.params, arguments.route.siteid);
		local.settings = mailSettings();
		local.messageId = createUUID();
		local.at = now();
		transaction {
			queryExecute(
				"INSERT INTO synthetic.message (message_id, siteID, template_id, to_address, from_address, subject, body_text, body_html, state, created)
				VALUES (:messageId, :siteid, :templateId, :toAddress, :fromAddress, :subject, :bodyText, :bodyHtml, :state, :created)",
				{
					messageId = {value = local.messageId, cfsqltype = "cf_sql_char"},
					siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"},
					templateId = {value = local.mail.templateId, cfsqltype = "cf_sql_char", null = !len(local.mail.templateId)},
					toAddress = {value = local.mail.to, cfsqltype = "cf_sql_nvarchar"},
					fromAddress = {value = local.mail.from, cfsqltype = "cf_sql_nvarchar"},
					subject = {value = local.mail.subject, cfsqltype = "cf_sql_nvarchar"},
					bodyText = {value = local.mail.bodyText, cfsqltype = "cf_sql_longnvarchar"},
					bodyHtml = {value = local.mail.bodyHtml, cfsqltype = "cf_sql_longnvarchar"},
					state = {value = "queued", cfsqltype = "cf_sql_nvarchar"},
					created = {value = local.at, cfsqltype = "cf_sql_timestamp"}
				}
			);
			appendStatus(local.messageId, "queued", local.at);
		}

		try {
			deliver(local.messageId, local.mail, local.settings);
		} catch (any e) {
			// Masa's mailer logs the same line when cfmail fails [core/mura/mailer.cfc:220-222].
			writeLog(type = "Error", file = "exception", text = "The current mail server settings for the site '" & arguments.route.siteid & "' are not valid.");
			// The failed row's detail tells an SMTP failure (smtp-error) from a message Mailpit never shows (mailpit-not-found).
			recordState(local.messageId, "failed", local.at, "smtp-error");
			return {"data" = detail(local.messageId, arguments.route.siteid)};
		}

		local.at = recordState(local.messageId, "sent", local.at);
		local.mailpitId = confirm(local.messageId, local.settings.apiBase);
		if (len(local.mailpitId)) {
			// synthetic.message has no mailpit_id column; the id is kept on the delivered status row.
			recordState(local.messageId, "delivered", local.at, "", local.mailpitId);
		} else {
			recordState(local.messageId, "failed", local.at, "mailpit-not-found");
		}
		return {"data" = detail(local.messageId, arguments.route.siteid)};
	}

	private struct function composeMessage(required struct params, required string siteid) hint="Resolves template or literal content and validates recipient and sender; raises notFound for a template outside the site, invalidParameters otherwise." {
		local.mail = {
			"templateId" = textParam(arguments.params, "templateId"),
			"to" = textParam(arguments.params, "to"),
			"from" = textParam(arguments.params, "from")
		};
		if (len(local.mail.templateId)) {
			local.template = findTemplate(local.mail.templateId, arguments.siteid);
			if (!local.template.recordCount) {
				variables.envelope.raise("notFound");
			}
			local.values = variablesParam(arguments.params);
			local.mail.subject = substitute(local.template.subject[1], local.values);
			local.mail.bodyText = substitute(local.template.body_text[1], local.values);
			local.mail.bodyHtml = substitute(local.template.body_html[1], local.values);
		} else {
			local.mail.subject = textParam(arguments.params, "subject");
			local.mail.bodyText = textParam(arguments.params, "bodyText");
			local.mail.bodyHtml = textParam(arguments.params, "bodyHtml");
			if (!len(trim(local.mail.subject)) || !(len(local.mail.bodyText) || len(local.mail.bodyHtml))) {
				variables.envelope.raise("invalidParameters");
			}
		}
		if (!len(local.mail.from)) {
			local.mail.from = variables.defaultFrom;
		}
		if (!isValid("email", local.mail.to) || len(local.mail.to) > 255 || !isValid("email", local.mail.from) || len(local.mail.from) > 255
			|| len(local.mail.subject) > 255) {
			variables.envelope.raise("invalidParameters");
		}
		return local.mail;
	}

	private struct function mailSettings() hint="Resolves SMTP_HOST, SMTP_PORT and MAILPIT_API_URL, unset or blank meaning 127.0.0.1, 1025 and http://127.0.0.1:8025; returns {smtpHost, smtpPort, apiBase}, throwing Opt2.Configuration that names an invalid variable." {
		local.values = {"SMTP_HOST" = "127.0.0.1", "SMTP_PORT" = "1025", "MAILPIT_API_URL" = "http://127.0.0.1:8025"};
		for (local.name in structKeyArray(local.values)) {
			if (structKeyExists(server.system.environment, local.name) && len(trim(server.system.environment[local.name]))) {
				local.values[local.name] = trim(server.system.environment[local.name]);
			}
		}
		if (!reFind("^[A-Za-z0-9._:\[\]-]+$", local.values.SMTP_HOST)) {
			throw(type = "Opt2.Configuration", message = "SMTP_HOST is not a host name or address.");
		}
		if (!reFind("^[0-9]{1,5}$", local.values.SMTP_PORT) || val(local.values.SMTP_PORT) < 1 || val(local.values.SMTP_PORT) > 65535) {
			throw(type = "Opt2.Configuration", message = "SMTP_PORT is not an integer from 1 to 65535.");
		}
		if (!reFindNoCase("^https?://[A-Za-z0-9._:\[\]-]+(/[A-Za-z0-9._~/-]*)?$", local.values.MAILPIT_API_URL)) {
			throw(type = "Opt2.Configuration", message = "MAILPIT_API_URL is not an http(s) origin with an optional path.");
		}
		return {
			"smtpHost" = local.values.SMTP_HOST,
			"smtpPort" = int(local.values.SMTP_PORT),
			"apiBase" = reReplace(local.values.MAILPIT_API_URL, "/+$", "")
		};
	}

	private void function deliver(required string messageId, required struct mail, required struct settings) hint="Sends the message synchronously to the resolved SMTP host and port under a fixed Message-ID, waiting at most smtpTimeoutSeconds (10 s) for the server; throws when the send fails or times out." {
		cfmail(to = arguments.mail.to, from = arguments.mail.from, subject = arguments.mail.subject, server = arguments.settings.smtpHost, port = arguments.settings.smtpPort, timeout = variables.smtpTimeoutSeconds, spoolEnable = "false", charset = "utf-8") {
			cfmailparam(name = "Message-ID", value = "<" & arguments.messageId & "@opt2.local>");
			if (len(arguments.mail.bodyText)) {
				cfmailpart(type = "text/plain", charset = "utf-8") {
					writeOutput(arguments.mail.bodyText);
				}
			}
			if (len(arguments.mail.bodyHtml)) {
				cfmailpart(type = "text/html", charset = "utf-8") {
					writeOutput(arguments.mail.bodyHtml);
				}
			}
		}
	}

	private string function confirm(required string messageId, required string apiBase) hint="Looks the message up in the Mailpit API at apiBase by Message-ID, up to 10 attempts 500 ms apart within lookupBudgetMs (10 s), each call capped at lookupCallTimeoutSeconds (2 s); returns the Mailpit ID, or an empty string when not found in time." {
		local.searchUrl = arguments.apiBase & "/api/v1/search?query=" & encodeForURL("message-id:" & arguments.messageId & "@opt2.local");
		local.deadline = getTickCount() + variables.lookupBudgetMs;
		for (local.attempt = 1; local.attempt <= 10; local.attempt++) {
			if (local.attempt > 1) {
				sleep(500);
			}
			local.remainingSeconds = int((local.deadline - getTickCount()) / 1000);
			if (local.remainingSeconds < 1) {
				break;
			}
			cfhttp(method = "GET", url = local.searchUrl, result = "local.res", timeout = min(variables.lookupCallTimeoutSeconds, local.remainingSeconds));
			if (val(local.res.statusCode) == 200 && isJSON(local.res.fileContent)) {
				local.found = deserializeJSON(local.res.fileContent);
				if (isStruct(local.found) && structKeyExists(local.found, "messages") && isArray(local.found.messages) && arrayLen(local.found.messages)) {
					return local.found.messages[1].ID;
				}
			}
		}
		return "";
	}

	private date function recordState(
		required string messageId,
		required string state,
		required date after,
		string detail = "",
		string mailpitId = ""
	) hint="Sets the message state (and sent_at when sent) and appends the matching status row in one transaction; returns the recorded time." {
		local.at = nextInstant(arguments.after);
		local.sql = "UPDATE synthetic.message SET state = :state";
		local.params = {
			messageId = {value = arguments.messageId, cfsqltype = "cf_sql_char"},
			state = {value = arguments.state, cfsqltype = "cf_sql_nvarchar"}
		};
		if (arguments.state == "sent") {
			local.sql &= ", sent_at = :sentAt";
			local.params.sentAt = {value = local.at, cfsqltype = "cf_sql_timestamp"};
		}
		local.sql &= " WHERE message_id = :messageId";
		transaction {
			queryExecute(local.sql, local.params);
			appendStatus(arguments.messageId, arguments.state, local.at, arguments.detail, arguments.mailpitId);
		}
		return local.at;
	}

	private void function appendStatus(
		required string messageId,
		required string status,
		required date at,
		string detail = "",
		string mailpitId = ""
	) hint="Appends one delivery_status row; an empty detail or mailpitId is stored as NULL." {
		queryExecute(
			"INSERT INTO synthetic.delivery_status (status_id, message_id, status, detail, mailpit_id, recorded_at)
			VALUES (:statusId, :messageId, :status, :detail, :mailpitId, :recordedAt)",
			{
				statusId = {value = createUUID(), cfsqltype = "cf_sql_char"},
				messageId = {value = arguments.messageId, cfsqltype = "cf_sql_char"},
				status = {value = arguments.status, cfsqltype = "cf_sql_nvarchar"},
				detail = {value = arguments.detail, cfsqltype = "cf_sql_longnvarchar", null = !len(arguments.detail)},
				mailpitId = {value = arguments.mailpitId, cfsqltype = "cf_sql_nvarchar", null = !len(arguments.mailpitId)},
				recordedAt = {value = arguments.at, cfsqltype = "cf_sql_timestamp"}
			}
		);
	}

	private date function nextInstant(required date after) hint="Returns now(), moved to 10 ms after the previous status when closer, so statuses keep their order under datetime's 1/300 s rounding." {
		local.at = now();
		if (local.at.getTime() - arguments.after.getTime() < 10) {
			local.at = dateAdd("l", 10, arguments.after);
		}
		return local.at;
	}

	private struct function detail(required string messageId, required string siteid) hint="Returns the message row of the site plus history[] ordered by recorded_at, status_id; raises notFound outside the site." {
		local.qry = queryExecute(
			"SELECT " & variables.messageColumns & " FROM synthetic.message WHERE message_id = :messageId AND siteID = :siteid",
			{
				messageId = {value = arguments.messageId, cfsqltype = "cf_sql_char"},
				siteid = {value = arguments.siteid, cfsqltype = "cf_sql_nvarchar"}
			}
		);
		if (!local.qry.recordCount) {
			variables.envelope.raise("notFound");
		}
		local.message = variables.envelope.rows(local.qry)[1];
		local.history = queryExecute(
			"SELECT status_id, message_id, status, detail, mailpit_id, recorded_at FROM synthetic.delivery_status
			WHERE message_id = :messageId ORDER BY recorded_at, status_id",
			{messageId = {value = arguments.messageId, cfsqltype = "cf_sql_char"}}
		);
		local.message["history"] = variables.envelope.rows(local.history);
		return local.message;
	}

	private query function findTemplate(required string templateId, required string siteid) hint="Returns the template row when it belongs to the site, otherwise an empty query." {
		return queryExecute(
			"SELECT " & variables.templateColumns & " FROM synthetic.message_template WHERE template_id = :templateId AND siteID = :siteid",
			{
				templateId = {value = arguments.templateId, cfsqltype = "cf_sql_char"},
				siteid = {value = arguments.siteid, cfsqltype = "cf_sql_nvarchar"}
			}
		);
	}

	private struct function variablesParam(required struct params) hint="Returns the variables parameter, a struct or a JSON object string, as a struct of simple values; raises invalidParameters otherwise." {
		local.value = structKeyExists(arguments.params, "variables") && !isNull(arguments.params["variables"]) ? arguments.params["variables"] : "";
		if (isSimpleValue(local.value)) {
			if (!len(local.value)) {
				return {};
			}
			local.value = isJSON(local.value) ? deserializeJSON(local.value) : "";
		}
		if (!isStruct(local.value)) {
			variables.envelope.raise("invalidParameters");
		}
		for (local.key in local.value) {
			if (isNull(local.value[local.key]) || !isSimpleValue(local.value[local.key])) {
				variables.envelope.raise("invalidParameters");
			}
		}
		return local.value;
	}

	private string function substitute(required string text, required struct values) hint="Replaces each {{key}} whose key equals a values key case-sensitively, in one pass; other placeholders stay as written." {
		local.keys = structKeyArray(arguments.values);
		local.matcher = createObject("java", "java.util.regex.Pattern").compile("\{\{([^{}]*)\}\}").matcher(javaCast("string", arguments.text));
		local.quoter = createObject("java", "java.util.regex.Matcher");
		local.out = createObject("java", "java.lang.StringBuffer").init();
		while (local.matcher.find()) {
			local.replacement = local.matcher.group(0);
			for (local.key in local.keys) {
				if (compare(local.key, local.matcher.group(1)) == 0) {
					local.replacement = toString(arguments.values[local.key]);
					break;
				}
			}
			local.matcher.appendReplacement(local.out, local.quoter.quoteReplacement(local.replacement));
		}
		local.matcher.appendTail(local.out);
		return local.out.toString();
	}

	private string function textParam(required struct params, required string name) hint="Returns a parameter as a string, empty when absent or null; raises invalidParameters for a complex value." {
		if (!structKeyExists(arguments.params, arguments.name) || isNull(arguments.params[arguments.name])) {
			return "";
		}
		if (!isSimpleValue(arguments.params[arguments.name])) {
			variables.envelope.raise("invalidParameters");
		}
		return toString(arguments.params[arguments.name]);
	}

}
