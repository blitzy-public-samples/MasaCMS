// SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="Masa-session authentication and role-group authorisation for the SYNTHETIC fixtures." {

	public any function init() hint="Sets the fixture role group names, which equal services/identity/config/role-map.json." {
		variables.roleNames = [
			"timesheets.employee",
			"timesheets.primary-approver",
			"timesheets.secondary-approver",
			"finance.preparer",
			"finance.approver",
			"esignature.signer",
			"esignature.auditor",
			"reporting.exporter",
			"surveys.manager",
			"communications.sender"
		];
		return this;
	}

	public any function currentUser() hint="Returns the request's Masa session user facade, creating it as mura.cfobject.getCurrentUser does." {
		if (!structKeyExists(request, "currentUser")) {
			request.currentUser = new mura.user.sessionUserFacade();
		}
		return request.currentUser;
	}

	public string function resolveSite(struct params={}) hint="Returns params.siteid, or the session site when it is absent or empty, as request.siteid; throws invalidParameters for an unknown site." {
		local.siteid = structKeyExists(arguments.params, "siteid") && !isNull(arguments.params.siteid) ? arguments.params.siteid : "";
		if (isSimpleValue(local.siteid) && !len(local.siteid)) {
			local.siteid = currentUser().getValue("siteID");
		}
		if (!isSimpleValue(local.siteid) || !len(local.siteid) || !application.settingsManager.siteExists(local.siteid)) {
			throw(type="opt2fixture.invalidParameters", message="");
		}
		request.siteid = local.siteid;
		return local.siteid;
	}

	public numeric function programFor(required string siteid) hint="Returns the program_id mapped to the site in synthetic.program_site; throws invalidParameters when the site has no program." {
		local.qry = queryExecute(
			"SELECT program_id FROM synthetic.program_site WHERE siteID = :siteid",
			{siteid = {value = arguments.siteid, cfsqltype = "cf_sql_varchar"}},
			application.configBean.getReadOnlyQRYAttrs()
		);
		if (!local.qry.recordCount) {
			throw(type="opt2fixture.invalidParameters", message="");
		}
		return javaCast("int", local.qry.program_id[1]);
	}

	public string function programSchema(required string siteid) hint="Returns the site's Program_<id> schema name, built only from the integer program_id." {
		return "Program_" & programFor(arguments.siteid);
	}

	public void function requireLogin() hint="Throws authorization unless the session user is logged in." {
		if (!currentUser().isLoggedIn()) {
			throw(type="opt2fixture.authorization", message="");
		}
	}

	public array function rolesHeld() hint="Returns the role group names, in role-map order, the user held at login in the private pool of request.siteid, the role-map privateUserPool scope; callers run resolveSite first." {
		local.user = currentUser();
		local.held = [];
		if (!local.user.isLoggedIn()) {
			return local.held;
		}
		for (local.name in variables.roleNames) {
			if (local.user.isInGroup(local.name, 0)) {
				arrayAppend(local.held, local.name);
			}
		}
		return local.held;
	}

	public void function requireAny(required any roles) hint="Throws authorization when not logged in, or forbidden unless a held role equals (case-insensitively) one of roles, an array or comma list." {
		local.wanted = isArray(arguments.roles) ? arguments.roles : listToArray(arguments.roles);
		requireLogin();
		local.held = rolesHeld();
		for (local.role in local.wanted) {
			if (arrayFindNoCase(local.held, local.role)) {
				return;
			}
		}
		throw(type="opt2fixture.forbidden", message="");
	}

	public boolean function isSiteAdmin() hint="Returns true for an S2 user or a member of the private-pool Admin group of request.siteid." {
		local.user = currentUser();
		// Masa's membership checks return list positions, so the result is normalised to a boolean.
		return (local.user.isSuperUser() || local.user.isInGroup("Admin", 0)) ? true : false;
	}

	public string function userId() hint="Returns the session user's Masa UserID." {
		return currentUser().getUserID();
	}

	public boolean function checkTaskToken(required string token, required string storedHash) hint="Compares the lowercase hex SHA-256 of token with storedHash in constant time." {
		local.computed = charsetDecode(lcase(hash(arguments.token, "SHA-256", "UTF-8")), "utf-8");
		local.stored = charsetDecode(arguments.storedHash, "utf-8");
		return createObject("java", "java.security.MessageDigest").isEqual(local.computed, local.stored);
	}

}
