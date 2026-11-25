// SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="Masa-session authentication, site resolution and CSRF validation for the SYNTHETIC fixtures." {

	public any function init() hint="Returns this helper." {
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

	public void function requireLogin() hint="Throws authorization unless the session user is logged in." {
		if (!currentUser().isLoggedIn()) {
			throw(type="opt2fixture.authorization", message="");
		}
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

	public string function userId() hint="Returns the session user's Masa UserID." {
		return currentUser().getUserID();
	}

}
