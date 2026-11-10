// SYNTHETIC: esignature - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="SYNTHETIC e-signature fixture: typed-name signing requests and their SHA-256 hash-chained audit, hashed only in SQL." {

	public any function init(required any envelope, required any auth) hint="Stores the shared envelope and auth helpers and the module's fixed SQL fragments." {
		variables.envelope = arguments.envelope;
		variables.auth = arguments.auth;

		variables.requestColumns = "[request_id], [siteID], [document_name], [document_sha256], [signer_user_id], [state], [created], [createdByID]";
		variables.chainKeys = ["seq", "action", "actor_user_id", "detail", "at", "prev_hash", "entry_hash"];
		variables.chainMetadata = {};
		for (local.key in variables.chainKeys) {
			variables.chainMetadata[local.key] = {type = "string"};
		}

		// Verdict over a [chain] CTE of (position, seq, prev_hash, entry_hash, previous_hash, computed_hash);
		// the genesis and hash expressions are those of synthetic.usp_audit_append.
		variables.verdictSql = ", [checked] AS (
				SELECT c.[position], c.[seq],
					CASE WHEN c.[seq] <> c.[position]
						OR c.[prev_hash] <> COALESCE(c.[previous_hash], CAST(REPLICATE(0x00, 32) AS binary(32)))
						OR c.[entry_hash] <> c.[computed_hash]
					THEN 1 ELSE 0 END AS [broken]
				FROM [chain] AS c
			)
			SELECT COUNT(*) AS [entries],
				COALESCE(MAX(k.[broken]), 0) AS [broken],
				COALESCE((SELECT TOP (1) b.[seq] FROM [checked] AS b WHERE b.[broken] = 1 ORDER BY b.[position]), 0) AS [brokenat]
			FROM [checked] AS k";

		return this;
	}

	public struct function handle(required struct route) hint="Dispatches requests (GET, POST) and requests/{id}/sign (POST), /audit (GET) and /verify (GET, POST); anything else raises notFound." {
		if (arguments.route.resource == "requests" && !len(arguments.route.tail)) {
			if (!len(arguments.route.id) && !len(arguments.route.action)) {
				if (arguments.route.httpMethod == "GET") {
					return listRequests(arguments.route);
				}
				if (arguments.route.httpMethod == "POST") {
					return createRequest(arguments.route);
				}
			} else if (len(arguments.route.id)) {
				switch (arguments.route.action & " " & arguments.route.httpMethod) {
					case "sign POST":
						return signRequest(arguments.route);
					case "audit GET":
						return auditChain(arguments.route);
					case "verify GET":
						return verifyStored(arguments.route);
					case "verify POST":
						return verifySupplied(arguments.route);
				}
			}
		}
		variables.envelope.raise("notFound");
	}

	private struct function listRequests(required struct route) hint="Returns the site's requests, without document bytes, ordered by created, request_id, as an envelope.list result." {
		variables.auth.requireAny(["esignature.signer"]);
		local.qry = queryExecute(
			"SELECT #variables.requestColumns# FROM [synthetic].[signature_request] WHERE [siteID] = :siteid ORDER BY [created], [request_id]",
			{siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"}}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function createRequest(required struct route) hint="Creates a PENDING request from documentName, documentBase64 and signerUserId, appends its 'created' audit entry with the document SHA-256 as detail, and returns the request row." {
		variables.auth.requireAny(["esignature.signer"]);
		local.documentName = textParam(arguments.route.params, "documentName");
		if (!len(local.documentName) || len(local.documentName) > 255) {
			variables.envelope.raise("invalidParameters");
		}
		local.document = decodeDocument(textParam(arguments.route.params, "documentBase64"));
		local.signerUserId = poolUserId(arguments.route.siteid, textParam(arguments.route.params, "signerUserId"));

		local.requestId = createUUID();
		local.documentSha256 = variables.envelope.sha256Hex(local.document);
		local.actorUserId = variables.auth.userId();
		local.now = now();
		transaction {
			queryExecute(
				"INSERT INTO [synthetic].[signature_request] ([request_id], [siteID], [document_name], [document_sha256], [document], [signer_user_id], [state], [created], [createdByID])
				VALUES (:request_id, :siteid, :document_name, :document_sha256, :document, :signer_user_id, N'PENDING', :created, :created_by)",
				{
					request_id = {value = local.requestId, cfsqltype = "cf_sql_char"},
					siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"},
					document_name = {value = local.documentName, cfsqltype = "cf_sql_nvarchar"},
					document_sha256 = {value = local.documentSha256, cfsqltype = "cf_sql_char"},
					document = {value = local.document, cfsqltype = "cf_sql_blob"},
					signer_user_id = {value = local.signerUserId, cfsqltype = "cf_sql_char"},
					created = {value = local.now, cfsqltype = "cf_sql_timestamp"},
					created_by = {value = local.actorUserId, cfsqltype = "cf_sql_char"}
				}
			);
			appendAudit(local.requestId, "created", local.actorUserId, local.documentSha256, local.now);
		}
		return {data = requestRows(arguments.route.siteid, local.requestId)[1]};
	}

	private struct function signRequest(required struct route) hint="Signs a PENDING request as its signer with typedName (stored as sent), appends the 'signed' audit entry with typedName as detail, and returns the updated request row." {
		variables.auth.requireAny(["esignature.signer"]);
		local.row = loadRequest(arguments.route);
		local.signerUserId = variables.auth.userId();
		if (compareNoCase(local.row.signer_user_id, local.signerUserId)) {
			variables.envelope.raise("forbidden");
		}
		local.typedName = textParam(arguments.route.params, "typedName");
		if (!len(trim(local.typedName)) || len(local.typedName) > 255) {
			variables.envelope.raise("invalidParameters");
		}

		local.now = now();
		transaction {
			// The state guard in the UPDATE makes a concurrent second signature a conflict, not a unique-key error.
			local.updated = queryExecute(
				"UPDATE [synthetic].[signature_request] SET [state] = N'SIGNED'
				OUTPUT inserted.[request_id]
				WHERE [request_id] = :request_id AND [siteID] = :siteid AND [state] = N'PENDING'",
				{
					request_id = {value = local.row.request_id, cfsqltype = "cf_sql_char"},
					siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"}
				}
			);
			if (!local.updated.recordCount) {
				variables.envelope.raise("conflict", "already-signed");
			}
			queryExecute(
				"INSERT INTO [synthetic].[signature] ([signature_id], [request_id], [typed_name], [signer_user_id], [signed_at])
				VALUES (:signature_id, :request_id, :typed_name, :signer_user_id, :signed_at)",
				{
					signature_id = {value = createUUID(), cfsqltype = "cf_sql_char"},
					request_id = {value = local.row.request_id, cfsqltype = "cf_sql_char"},
					typed_name = {value = local.typedName, cfsqltype = "cf_sql_nvarchar"},
					signer_user_id = {value = local.signerUserId, cfsqltype = "cf_sql_char"},
					signed_at = {value = local.now, cfsqltype = "cf_sql_timestamp"}
				}
			);
			appendAudit(local.row.request_id, "signed", local.signerUserId, local.typedName, local.now);
		}
		return {data = requestRows(arguments.route.siteid, local.row.request_id)[1]};
	}

	private struct function auditChain(required struct route) hint="Returns the request's audit entries ordered by seq as an envelope.list result, with at as yyyy-MM-ddTHH:mm:ss.fff text and lowercase-hex hashes, so the items POST back to verify unchanged." {
		local.row = authorizeChainReader(arguments.route);
		local.qry = queryExecute(
			"SELECT e.[entry_id], e.[request_id], e.[seq], e.[action], e.[actor_user_id], e.[detail],
				FORMAT(e.[at], 'yyyy-MM-dd''T''HH:mm:ss.fff', 'en-US') AS [at],
				LOWER(CONVERT(varchar(64), e.[prev_hash], 2)) AS [prev_hash],
				LOWER(CONVERT(varchar(64), e.[entry_hash], 2)) AS [entry_hash]
			FROM [synthetic].[audit_entry] AS e
			INNER JOIN [synthetic].[signature_request] AS r ON r.[request_id] = e.[request_id] AND r.[siteID] = :siteid
			WHERE e.[request_id] = :request_id
			ORDER BY e.[seq]",
			{
				request_id = {value = local.row.request_id, cfsqltype = "cf_sql_char"},
				siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"}
			}
		);
		return variables.envelope.list(variables.envelope.rows(local.qry), arguments.route.params);
	}

	private struct function verifyStored(required struct route) hint="Recomputes the stored chain in SQL and returns {valid, entries, brokenat}." {
		local.row = authorizeChainReader(arguments.route);
		local.qry = queryExecute(
			"WITH [chain] AS (
				SELECT ROW_NUMBER() OVER (ORDER BY e.[seq]) AS [position], e.[seq], e.[prev_hash], e.[entry_hash],
					LAG(e.[entry_hash]) OVER (ORDER BY e.[seq]) AS [previous_hash],
					HASHBYTES('SHA2_256', e.[prev_hash] + CAST(CONCAT(e.[request_id], N'|', e.[seq], N'|', e.[action], N'|', COALESCE(e.[actor_user_id], N''), N'|', COALESCE(e.[detail], N''), N'|', FORMAT(e.[at], 'yyyy-MM-dd''T''HH:mm:ss.fff', 'en-US')) AS varbinary(max))) AS [computed_hash]
				FROM [synthetic].[audit_entry] AS e
				INNER JOIN [synthetic].[signature_request] AS r ON r.[request_id] = e.[request_id] AND r.[siteID] = :siteid
				WHERE e.[request_id] = :request_id
			)" & variables.verdictSql,
			{
				request_id = {value = local.row.request_id, cfsqltype = "cf_sql_char"},
				siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"}
			}
		);
		return verdict(local.qry);
	}

	private struct function verifySupplied(required struct route) hint="Recomputes a supplied copy of the chain (params.entries, in array order) in SQL against the stored request id and returns {valid, entries, brokenat}." {
		local.row = authorizeChainReader(arguments.route);
		local.entries = suppliedEntries(arguments.route.params);
		local.qry = queryExecute(
			"WITH [supplied] AS (
				SELECT CAST(a.[key] AS int) + 1 AS [position], j.[seq], j.[action], j.[actor_user_id], j.[detail],
					TRY_CONVERT(datetime, j.[at], 126) AS [at],
					CONVERT(binary(32), j.[prev_hash], 2) AS [prev_hash],
					CONVERT(binary(32), j.[entry_hash], 2) AS [entry_hash]
				FROM OPENJSON(CAST(:entries AS nvarchar(max))) AS a
				CROSS APPLY OPENJSON(a.[value]) WITH (
					[seq] int N'$.seq',
					[action] nvarchar(max) N'$.action',
					[actor_user_id] nvarchar(max) N'$.actor_user_id',
					[detail] nvarchar(max) N'$.detail',
					[at] nvarchar(30) N'$.at',
					[prev_hash] char(64) N'$.prev_hash',
					[entry_hash] char(64) N'$.entry_hash'
				) AS j
			), [chain] AS (
				SELECT s.[position], s.[seq], s.[prev_hash], s.[entry_hash],
					LAG(s.[entry_hash]) OVER (ORDER BY s.[position]) AS [previous_hash],
					HASHBYTES('SHA2_256', s.[prev_hash] + CAST(CONCAT(r.[request_id], N'|', s.[seq], N'|', s.[action], N'|', COALESCE(s.[actor_user_id], N''), N'|', COALESCE(s.[detail], N''), N'|', FORMAT(s.[at], 'yyyy-MM-dd''T''HH:mm:ss.fff', 'en-US')) AS varbinary(max))) AS [computed_hash]
				FROM [supplied] AS s
				CROSS JOIN (SELECT [request_id] FROM [synthetic].[signature_request] WHERE [request_id] = :request_id AND [siteID] = :siteid) AS r
			)" & variables.verdictSql,
			{
				entries = {value = serializeJSON(local.entries), cfsqltype = "cf_sql_longnvarchar"},
				request_id = {value = local.row.request_id, cfsqltype = "cf_sql_char"},
				siteid = {value = arguments.route.siteid, cfsqltype = "cf_sql_nvarchar"}
			}
		);
		return verdict(local.qry);
	}

	private struct function authorizeChainReader(required struct route) hint="Returns the route's request row for an auditor, or for a signer who is its signer; raises authorization, forbidden or notFound in check order." {
		variables.auth.requireLogin();
		local.held = variables.auth.rolesHeld();
		local.isAuditor = arrayFindNoCase(local.held, "esignature.auditor") > 0;
		if (!local.isAuditor && !arrayFindNoCase(local.held, "esignature.signer")) {
			variables.envelope.raise("forbidden");
		}
		local.row = loadRequest(arguments.route);
		if (!local.isAuditor && compareNoCase(local.row.signer_user_id, variables.auth.userId())) {
			variables.envelope.raise("forbidden");
		}
		return local.row;
	}

	private struct function loadRequest(required struct route) hint="Returns the route's request row in the site; raises notFound when it is absent." {
		local.found = requestRows(arguments.route.siteid, arguments.route.id);
		if (!arrayLen(local.found)) {
			variables.envelope.raise("notFound");
		}
		return local.found[1];
	}

	private array function requestRows(required string siteid, required string requestId) hint="Returns the request's row, without document bytes, as a zero- or one-element array." {
		return variables.envelope.rows(queryExecute(
			"SELECT #variables.requestColumns# FROM [synthetic].[signature_request] WHERE [request_id] = :request_id AND [siteID] = :siteid",
			{
				request_id = {value = arguments.requestId, cfsqltype = "cf_sql_char"},
				siteid = {value = arguments.siteid, cfsqltype = "cf_sql_nvarchar"}
			}
		));
	}

	private void function appendAudit(
		required string requestId,
		required string action,
		required string actorUserId,
		required string detail,
		required date at
	) hint="Appends one audit entry through synthetic.usp_audit_append, which assigns seq and computes the chain hashes." {
		queryExecute(
			"EXEC [synthetic].[usp_audit_append] @entry_id = :entry_id, @request_id = :request_id, @action = :action, @actor_user_id = :actor_user_id, @detail = :detail, @at = :at",
			{
				entry_id = {value = createUUID(), cfsqltype = "cf_sql_char"},
				request_id = {value = arguments.requestId, cfsqltype = "cf_sql_char"},
				action = {value = arguments.action, cfsqltype = "cf_sql_nvarchar"},
				actor_user_id = {value = arguments.actorUserId, cfsqltype = "cf_sql_char"},
				detail = {value = arguments.detail, cfsqltype = "cf_sql_longnvarchar"},
				at = {value = arguments.at, cfsqltype = "cf_sql_timestamp"}
			}
		);
	}

	private string function poolUserId(required string siteid, required string userid) hint="Returns the UserID of an existing Type 2 user of the site's public or private user pool; raises invalidParameters otherwise." {
		if (!len(arguments.userid)) {
			variables.envelope.raise("invalidParameters");
		}
		local.site = application.settingsManager.getSite(arguments.siteid);
		local.user = application.userManager.read(userid = arguments.userid, siteid = arguments.siteid);
		if (local.user.getIsNew() != 0 || local.user.getType() != 2
			|| !arrayFindNoCase([local.site.getPublicUserPoolID(), local.site.getPrivateUserPoolID()], local.user.getSiteID())) {
			variables.envelope.raise("invalidParameters");
		}
		return local.user.getUserID();
	}

	private binary function decodeDocument(required string base64) hint="Returns the decoded document bytes; raises invalidParameters for invalid base64 or an empty document." {
		try {
			local.bytes = binaryDecode(arguments.base64, "base64");
		} catch (any e) {
			variables.envelope.raise("invalidParameters");
		}
		if (!len(local.bytes)) {
			variables.envelope.raise("invalidParameters");
		}
		return local.bytes;
	}

	private string function textParam(required struct params, required string name) hint="Returns a simple-valued param as a string, or an empty string when it is absent, null or complex." {
		if (structKeyExists(arguments.params, arguments.name) && !isNull(arguments.params[arguments.name]) && isSimpleValue(arguments.params[arguments.name])) {
			return arguments.params[arguments.name];
		}
		return "";
	}

	private array function suppliedEntries(required struct params) hint="Returns params.entries (an array, or a JSON array string) as string-typed structs of the chain keys; raises invalidParameters for another shape, a seq that is not a positive integer without leading zeros, an at not in yyyy-MM-ddTHH:mm:ss.fff form, or a hash that is not 64 hex characters." {
		local.entries = structKeyExists(arguments.params, "entries") && !isNull(arguments.params.entries) ? arguments.params.entries : "";
		if (isSimpleValue(local.entries) && isJSON(local.entries)) {
			local.entries = deserializeJSON(local.entries);
		}
		if (!isArray(local.entries)) {
			variables.envelope.raise("invalidParameters");
		}
		local.result = [];
		for (local.i = 1; local.i <= arrayLen(local.entries); local.i++) {
			if (!arrayIsDefined(local.entries, local.i) || !isStruct(local.entries[local.i])) {
				variables.envelope.raise("invalidParameters");
			}
			local.entry = [:];
			for (local.key in variables.chainKeys) {
				if (!structKeyExists(local.entries[local.i], local.key) || isNull(local.entries[local.i][local.key]) || !isSimpleValue(local.entries[local.i][local.key])) {
					variables.envelope.raise("invalidParameters");
				}
				local.entry[local.key] = toString(local.entries[local.i][local.key]);
			}
			if (!reFind("^[1-9][0-9]{0,8}$", local.entry.seq)
				|| !reFind("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$", local.entry.at)
				|| !reFindNoCase("^[0-9a-f]{64}$", local.entry.prev_hash)
				|| !reFindNoCase("^[0-9a-f]{64}$", local.entry.entry_hash)) {
				variables.envelope.raise("invalidParameters");
			}
			// Typed as strings so serializeJSON never turns numeric- or boolean-looking text into JSON numbers or booleans.
			local.entry.setMetadata(variables.chainMetadata);
			arrayAppend(local.result, local.entry);
		}
		return local.result;
	}

	private struct function verdict(required query qry) hint="Maps a verification row to {data: {valid, entries, brokenat}}; brokenat is the seq of the first failing entry in chain order, or 0 when the chain is valid." {
		local.result = [:];
		local.result["valid"] = arguments.qry.broken[1] == 0;
		local.result["entries"] = arguments.qry.entries[1];
		local.result["brokenat"] = arguments.qry.brokenat[1];
		return {data = local.result};
	}

}
