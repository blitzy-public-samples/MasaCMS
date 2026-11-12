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

	public string function resolveSite(struct params={}) hint="Returns the canonical id of params.siteid, else the session site, else default, as request.siteid; throws invalidParameters for an unknown site." {
		local.siteid = structKeyExists(arguments.params, "siteid") && !isNull(arguments.params.siteid) ? arguments.params.siteid : "";
		if (isSimpleValue(local.siteid) && !len(local.siteid)) {
			local.siteid = currentUser().getValue("siteID");
		}
		if (isSimpleValue(local.siteid) && !len(local.siteid)) {
			local.siteid = "default";
		}
		if (!isSimpleValue(local.siteid) || !application.settingsManager.siteExists(local.siteid)) {
			throw(type="opt2fixture.invalidParameters", message="");
		}
		request.siteid = application.settingsManager.getSite(local.siteid).getSiteID();
		return request.siteid;
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

	public void function requireAny(required any roles) hint="Throws authorization when not logged in, forbidden unless a held role equals (case-insensitively) one of roles, an array or comma list, then applies requireCsrf." {
		local.wanted = isArray(arguments.roles) ? arguments.roles : listToArray(arguments.roles);
		requireLogin();
		local.held = rolesHeld();
		for (local.role in local.wanted) {
			if (arrayFindNoCase(local.held, local.role)) {
				requireCsrf();
				return;
			}
		}
		throw(type="opt2fixture.forbidden", message="");
	}

	public any function forRoute(required struct route, struct headers={}) hint="Keeps the route's effective method, its id as CSRF context and its csrf_token pair, X-csrf_token headers winning over params as in Masa's JSON API; returns this." {
		variables.csrf = {"httpMethod" = arguments.route.httpMethod, "context" = arguments.route.id, "validated" = false};
		for (local.field in ["csrf_token", "csrf_token_expires"]) {
			if (structKeyExists(arguments.headers, "X-" & local.field)) {
				local.value = arguments.headers["X-" & local.field];
			} else {
				local.value = structKeyExists(arguments.route.params, local.field) && !isNull(arguments.route.params[local.field]) ? arguments.route.params[local.field] : "";
			}
			variables.csrf[local.field] = isSimpleValue(local.value) ? local.value : "";
		}
		return this;
	}

	public void function requireCsrf() hint="Validates the forRoute token pair once per request through Masa's single-use check for a logged-in write (not GET or HEAD); throws invalidTokens when Masa rejects it." {
		if (listFind("GET,HEAD", variables.csrf.httpMethod) || variables.csrf.validated || !currentUser().isLoggedIn()) {
			return;
		}
		// An empty siteid keeps the event from loading site objects; its values win over form and url.
		local.masa = createObject("component", "mura.MasaScope").init({
			"siteid" = "",
			"csrf_token" = variables.csrf.csrf_token,
			"csrf_token_expires" = variables.csrf.csrf_token_expires
		});
		if (!currentUser().validateCSRFTokens($ = local.masa, context = variables.csrf.context)) {
			throw(type="opt2fixture.invalidTokens", message="");
		}
		variables.csrf.validated = true;
	}

	public boolean function isSiteAdmin() hint="Returns true for an S2 user or a member of the private-pool Admin group of request.siteid." {
		local.user = currentUser();
		// Masa's membership checks return list positions, so the result is normalised to a boolean.
		return (local.user.isSuperUser() || local.user.isInGroup("Admin", 0)) ? true : false;
	}

	public boolean function isSiteMember() hint="Returns true for a logged-in S2 user, private-pool user or public-pool account of request.siteid, from the login-time memberships; callers run resolveSite first." {
		local.user = currentUser();
		if (!local.user.isLoggedIn()) {
			return false;
		}
		local.publicPool = application.settingsManager.getSite(request.siteid).getPublicUserPoolID();
		return (local.user.isPrivateUser() || listFindNoCase(local.user.getValue("memberships"), "S2IsPublic;" & local.publicPool)) ? true : false;
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
