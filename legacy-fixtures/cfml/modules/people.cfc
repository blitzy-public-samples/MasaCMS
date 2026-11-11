// SYNTHETIC: people - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="Person archive records, with blackout of the person's open timesheet days, for the SYNTHETIC people fixture." {

	public any function init(required any envelope, required any auth) hint="Stores the envelope and auth helpers." {
		variables.envelope = arguments.envelope;
		variables.auth = arguments.auth;
		return this;
	}

	public struct function handle(required struct route) hint="Dispatches persons/{id}/archive (POST archives, GET reads the record); anything else raises notFound." {
		local.r = arguments.route;
		if (local.r.resource == "persons" && len(local.r.id) && local.r.action == "archive" && !len(local.r.tail)) {
			if (local.r.httpMethod == "POST") {
				return archive(local.r);
			}
			if (local.r.httpMethod == "GET") {
				return archiveDetail(local.r);
			}
		}
		variables.envelope.raise("notFound");
	}

	private struct function archive(required struct route) hint="Archives the person from effectiveFrom, blacks out their open timesheet days through usp_person_archived_blackout, and returns the archive record." {
		local.user = gate(arguments.route);
		local.effectiveFrom = effectiveFromParam(arguments.route.params);

		local.now = now();
		local.archiveId = createUUID();
		local.keys = {
			archive_id = idParam(local.archiveId),
			person_id = idParam(arguments.route.id),
			siteID = {value = local.user.getSiteID(), cfsqltype = "cf_sql_nvarchar"},
			effective_from = {value = local.effectiveFrom, cfsqltype = "cf_sql_timestamp"},
			now = {value = local.now, cfsqltype = "cf_sql_timestamp"}
		};
		local.record = duplicate(local.keys);
		local.record.archived_by_id = idParam(variables.auth.userId());
		local.record.archived_by = {value = left(variables.auth.currentUser().getFullName(), 50), cfsqltype = "cf_sql_nvarchar"};

		transaction {
			// UPDLOCK, HOLDLOCK queues archives of one person here until commit; TOP (1) keeps a found row to one key lock, avoiding range-lock deadlocks.
			local.existing = queryExecute(
				"SELECT TOP (1) 1 AS found FROM synthetic.person_archive WITH (UPDLOCK, HOLDLOCK) WHERE person_id = :person_id",
				{person_id = idParam(arguments.route.id)}
			);
			if (local.existing.recordCount) {
				variables.envelope.raise("badRequest");
			}
			queryExecute(
				"INSERT INTO synthetic.person_archive (archive_id, person_id, siteID, effective_from, archived_at, archived_by_id, archived_by) VALUES (:archive_id, :person_id, :siteID, :effective_from, :now, :archived_by_id, :archived_by)",
				local.record
			);
			queryExecute(
				"EXEC synthetic.usp_person_archived_blackout @person_id = :person_id, @siteID = :siteID, @effective_from = :effective_from, @archive_id = :archive_id, @now = :now",
				local.keys
			);
		}
		return {"data" = variables.envelope.rows(findArchives(true, local.archiveId))[1]};
	}

	private struct function archiveDetail(required struct route) hint="Returns the person's archive record, or raises notFound when the person has none." {
		gate(arguments.route);
		local.qry = findArchives(false, arguments.route.id);
		if (!local.qry.recordCount) {
			variables.envelope.raise("notFound");
		}
		return {"data" = variables.envelope.rows(local.qry)[1]};
	}

	private any function gate(required struct route) hint="Requires login and site-admin rights, then returns the route's person." {
		variables.auth.requireLogin();
		if (!variables.auth.isSiteAdmin()) {
			variables.envelope.raise("forbidden");
		}
		return requirePerson(arguments.route);
	}

	private any function requirePerson(required struct route) hint="Returns the route's Type 2 user when it belongs to the request site's public or private user pool; otherwise raises notFound." {
		local.user = application.userManager.read(userid = arguments.route.id, siteid = arguments.route.siteid);
		local.site = application.settingsManager.getSite(arguments.route.siteid);
		if (local.user.getIsNew() != 0
			|| local.user.getType() != 2
			|| (compareNoCase(local.user.getSiteID(), local.site.getPublicUserPoolID()) != 0
				&& compareNoCase(local.user.getSiteID(), local.site.getPrivateUserPoolID()) != 0)) {
			variables.envelope.raise("notFound");
		}
		return local.user;
	}

	private date function effectiveFromParam(required struct params) hint="Returns effectiveFrom as a date at midnight, or raises invalidParameters unless it is a real yyyy-mm-dd calendar date from 1753 on, SQL Server datetime's floor." {
		local.text = structKeyExists(arguments.params, "effectiveFrom") && !isNull(arguments.params.effectiveFrom) ? arguments.params.effectiveFrom : "";
		if (!isSimpleValue(local.text) || !reFind("^\d{4}-\d{2}-\d{2}$", local.text) || val(left(local.text, 4)) < 1753) {
			variables.envelope.raise("invalidParameters");
		}
		try {
			local.date = createDate(int(left(local.text, 4)), int(mid(local.text, 6, 2)), int(right(local.text, 2)));
			// The round trip rejects day rollover and the century mapping createDate applies to years below 100; compare() because != compares date-like strings as dates.
			local.valid = compare(dateFormat(local.date, "yyyy-mm-dd"), local.text) == 0;
		} catch (any e) {
			local.valid = false;
		}
		if (!local.valid) {
			variables.envelope.raise("invalidParameters");
		}
		return local.date;
	}

	private query function findArchives(required boolean byArchive, required string id) hint="Returns the archive record with id (byArchive) or the archive records of person id, in effective_from, archive_id order, as the five response columns." {
		return queryExecute(
			"SELECT archive_id AS archiveid, person_id AS personid, siteID AS siteid, effective_from AS effectivefrom, archived_at AS archivedat FROM synthetic.person_archive WHERE "
				& (arguments.byArchive ? "archive_id = :id" : "person_id = :id")
				& " ORDER BY effective_from, archive_id",
			{id = idParam(arguments.id)}
		);
	}

	private struct function idParam(required string value) hint="Returns a char(35) id query param." {
		return {value = arguments.value, cfsqltype = "cf_sql_char"};
	}

}
