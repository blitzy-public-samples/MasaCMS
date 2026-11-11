<cfscript>
// Legacy bridge session ops: describe, hydrate and end the attached ColdFusion session, and read or extend its CSRF used-token ledger.

// Raises 400 badRequest unless the request uses the op's HTTP method.
function requireMethod(required string method) {
	if (compare(cgi.request_method, arguments.method) != 0) {
		variables.app.raise(400, "badRequest", "method must be " & arguments.method);
	}
}

// Raises 409 sessionMismatch unless the assertion's sid names the session ColdFusion attached.
function requireSession() {
	if (compare(request.opt2Bridge.sid, session.sessionid) != 0) {
		variables.app.raise(409, "sessionMismatch", "assertion sid differs from the session");
	}
}

// Token -> datetime ledger from [{token, usedAt}]; empty tokens are skipped and the first occurrence of a token wins.
function readLedger(required any entries, required string field) {
	if (!isArray(arguments.entries)) {
		variables.app.raise(400, "badRequest", arguments.field & " must be an array");
	}
	var ledger = {};
	for (var entry in arguments.entries) {
		if (!isStruct(entry) || !structKeyExists(entry, "token") || !isSimpleValue(entry.token)
			|| !structKeyExists(entry, "usedAt") || !isSimpleValue(entry.usedAt)) {
			variables.app.raise(400, "badRequest", arguments.field & " entries need token and usedAt");
		}
		if (len(entry.token) && !structKeyExists(ledger, entry.token)) {
			ledger[entry.token] = variables.app.parseLegacyTime(entry.usedAt);
		}
	}
	return ledger;
}

// [{token, usedAt}] for the ledger entries used at or after sinceMs (epoch milliseconds; dateCompare ignores milliseconds).
function ledgerEntries(required struct ledger, numeric sinceMs = 0) {
	var entries = [];
	for (var token in arguments.ledger) {
		var usedAt = arguments.ledger[token];
		if (usedAt.getTime() >= arguments.sinceMs) {
			arrayAppend(entries, {"token": token, "usedAt": variables.app.formatLegacyTime(usedAt)});
		}
	}
	return entries;
}

app = request.opt2BridgeApp;
op = url.op;
body = {};
// The session.mura keys userUtility.setUserStruct sets for a logged-in user, in describe's wire spelling.
userKeys = ["userID", "username", "siteID", "subtype", "password", "fname", "lname", "email", "remoteID", "company", "lastlogin", "passwordCreated"];

try {
	switch (op) {
		case "describe":
			// Read-only view of the session as Masa's login left it; the gateway learns sessionId here, so no sid check.
			requireMethod("GET");
			mura = session.mura;
			user = {};
			for (key in userKeys) {
				user[key] = structKeyExists(mura, key) ? mura[key] : (key == "subtype" ? "Default" : "");
			}
			for (key in ["lastlogin", "passwordCreated"]) {
				user[key] = isDate(user[key]) ? app.formatLegacyTime(user[key]) : "";
			}
			body = {
				"sessionId": session.sessionid,
				"isLoggedIn": javacast("boolean", structKeyExists(mura, "isLoggedIn") && isBoolean(mura.isLoggedIn) && mura.isLoggedIn),
				"user": user,
				"memberships": structKeyExists(mura, "memberships") ? mura.memberships : "",
				"membershipIds": structKeyExists(mura, "membershipids") ? mura.membershipids : "",
				"csrfSecretKey": mura.csrfsecretkey,
				"usedTokens": ledgerEntries(mura.csrfusedtokens),
				"siteId": structKeyExists(session, "siteid") ? session.siteid : ""
			};
			break;

		case "hydrate":
			// Installs identity's login snapshot without a login: no query, no LastLogin update, no login events.
			requireMethod("POST");
			// Without session cookies ColdFusion has just created this session and Masa has set its cookies for the gateway's jar.
			if (structKeyExists(cookie, "CFID") || structKeyExists(cookie, "CFTOKEN") || structKeyExists(cookie, "JSESSIONID")) {
				requireSession();
			}
			input = app.readJsonBody();
			snapshot = structKeyExists(input, "snapshot") ? input.snapshot : "";
			if (!isStruct(snapshot) || !structKeyExists(snapshot, "user") || !isStruct(snapshot.user)) {
				app.raise(400, "badRequest", "snapshot.user must be an object");
			}
			for (key in userKeys) {
				if (!structKeyExists(snapshot.user, key) || !isSimpleValue(snapshot.user[key])) {
					app.raise(400, "badRequest", "snapshot.user." & key & " is required");
				}
			}
			// setUserStruct would take a groupID over membershipIds; an empty userID would log in a session with no subject.
			if (structKeyExists(snapshot.user, "groupID") || !len(snapshot.user.userID)) {
				app.raise(400, "badRequest", "snapshot.user needs a userID and no groupID");
			}
			memberships = structKeyExists(snapshot, "memberships") ? snapshot.memberships : "";
			membershipIds = structKeyExists(snapshot, "membershipIds") ? snapshot.membershipIds : "";
			secret = structKeyExists(input, "csrfSecretKey") ? input.csrfSecretKey : "";
			if (!isSimpleValue(memberships) || !isSimpleValue(membershipIds) || !isSimpleValue(secret) || !len(secret)) {
				app.raise(400, "badRequest", "memberships, membershipIds and csrfSecretKey must be strings, csrfSecretKey non-empty");
			}
			ledger = readLedger(structKeyExists(input, "usedTokens") ? input.usedTokens : [], "usedTokens");
			if (compare(snapshot.user.userID, request.opt2Bridge.sub) != 0) {
				app.raise(409, "subjectMismatch", "snapshot.user.userID differs from the assertion sub");
			}
			user = {};
			for (key in userKeys) {
				user[key] = snapshot.user[key];
			}
			for (key in ["lastlogin", "passwordCreated"]) {
				user[key] = len(user[key]) ? app.parseLegacyTime(user[key]) : "";
			}

			// setUserStruct replaces session.mura and mints a fresh CSRF secret, so identity's secret and ledger go in after it.
			application.serviceFactory.getBean("userUtility").setUserStruct(user, memberships, membershipIds);
			session.mura.csrfsecretkey = secret;
			session.mura.csrfusedtokens = ledger;
			structDelete(session, "siteArray");
			body = {"sessionId": session.sessionid, "hydrated": true};
			break;

		case "markUsed":
			// Adds tokens to the used-token ledger; a token already present keeps its earlier time.
			requireMethod("POST");
			requireSession();
			input = app.readJsonBody();
			incoming = readLedger(structKeyExists(input, "tokens") ? input.tokens : "", "tokens");
			param name="session.mura.csrfusedtokens" default={};
			applied = 0;
			for (token in incoming) {
				if (!structKeyExists(session.mura.csrfusedtokens, token)) {
					session.mura.csrfusedtokens[token] = incoming[token];
					applied++;
				}
			}
			body = {"applied": javacast("int", applied)};
			break;

		case "usedSince":
			// Ledger entries used at or after since.
			requireMethod("GET");
			requireSession();
			if (!structKeyExists(url, "since") || !isSimpleValue(url.since) || !len(url.since)) {
				app.raise(400, "badRequest", "since is required");
			}
			body = {"tokens": ledgerEntries(session.mura.csrfusedtokens, app.parseLegacyTime(url.since).getTime())};
			break;

		case "end":
			// Logs the session out without a database write, then invalidates it.
			requireMethod("POST");
			requireSession();
			body = {"ended": true, "serverTime": app.formatLegacyTime(now())};
			application.serviceFactory.getBean("userUtility").setUserStruct();
			sessionInvalidate();
			break;

		default:
			app.raise(404, "notFound", "unknown op");
	}
} catch (opt2bridge.fail e) {
	app.respondError(val(e.detail), e.errorCode, e.message);
} catch (any e) {
	app.respondError(500, "serverError", e.type);
}

app.respondJson(200, body);
</cfscript>
