<cfscript>
// Legacy bridge session ops: describe, hydrate and end the attached ColdFusion session, read or extend its CSRF used-token
// ledger, and carry into it or export from it the session values target and legacy routes share.

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

// The key of a shared name in its scope: "mura.<key>" names a session.mura key, any other name a top-level session key.
function sharedKey(required string name) {
	return left(arguments.name, 5) == "mura." ? mid(arguments.name, 6, len(arguments.name) - 5) : arguments.name;
}

// {exists, value} of a shared name in the attached session; "moduleTopIds" assembles {<key>: topid} over the module top keys.
function readShared(required string name) {
	if (arguments.name == "moduleTopIds") {
		var tops = {};
		for (var topKey in variables.moduleTopKeys) {
			if (structKeyExists(session, topKey) && isStruct(session[topKey]) && structKeyExists(session[topKey], "topid")) {
				tops[topKey] = javacast("string", session[topKey].topid);
			}
		}
		return structIsEmpty(tops) ? {"exists": false} : {"exists": true, "value": tops};
	}
	var key = sharedKey(arguments.name);
	var scope = left(arguments.name, 5) == "mura." ? session.mura : session;
	return structKeyExists(scope, key) ? {"exists": true, "value": scope[key]} : {"exists": false};
}

// Sets a shared name in the attached session; "moduleTopIds" sets session[<key>] = {topid} for each module top key given.
function writeShared(required string name, required any value) {
	if (arguments.name == "moduleTopIds") {
		for (var key in arguments.value) {
			if (arrayFindNoCase(variables.moduleTopKeys, key) && isSimpleValue(arguments.value[key])) {
				session[key] = {topid = arguments.value[key]};
			}
		}
	} else if (left(arguments.name, 5) == "mura.") {
		session.mura[sharedKey(arguments.name)] = arguments.value;
	} else {
		session[arguments.name] = arguments.value;
	}
}

// True for FW/1 preserved contexts by preserve key: positive integer keys, each a struct of simple values whose userBean,
// when present, is JSON.
function isContexts(required any value) {
	if (!isStruct(arguments.value)) return false;
	for (var key in arguments.value) {
		var context = arguments.value[key];
		if (!isValid("integer", key) || key < 1 || !isStruct(context)
			|| (structKeyExists(context, "userBean") && (!isSimpleValue(context.userBean) || !isJSON(context.userBean)))) return false;
		for (var entry in context) {
			if (!isSimpleValue(context[entry])) return false;
		}
	}
	return true;
}

// True when two contexts of simple values hold the same keys and values.
function sameContext(required struct a, required struct b) {
	if (structCount(arguments.a) != structCount(arguments.b)) return false;
	for (var key in arguments.a) {
		if (!structKeyExists(arguments.b, key) || compare(arguments.a[key], arguments.b[key]) != 0) return false;
	}
	return true;
}

// The user bean legacy's failed userManager.update or create leaves (core/mura/user/userManager.cfc:404-450, 563-582):
// the stored user, or a new one, set from the posted values under the S2 rule, holding the target save's errors; no write.
function failedSaveBean(required struct posted, required struct result) {
	var data = structCopy(arguments.posted);
	structDelete(data, "userBean");
	var userId = structKeyExists(data, "userID") ? data.userID : "";
	var updating = len(userId) && structKeyExists(data, "action") && data.action == "Update";
	var bean = updating ? application.serviceFactory.getBean("userDAO").read(userId) : application.serviceFactory.getBean("user");
	bean.set(data);
	if (!application.permUtility.isS2()) bean.setS2(0);
	if (bean.getS2()) bean.setIsPublic(0);
	if (!updating) bean.setUserID(len(userId) ? userId : createUUID());
	bean.setErrors(structKeyExists(arguments.result, "errors") && isStruct(arguments.result.errors) ? arguments.result.errors : {});
	return bean;
}

// Installs each carried context that differs from the one installed last as session["__fw1<key>"], its userBean (a target
// save result) as the user bean legacy's failed save leaves, and purges the context ten keys earlier, as FW/1's key
// allocation does (admin/framework.cfc:1432-1456).
function installContexts(required struct contexts, required struct previous) {
	for (var key in arguments.contexts) {
		var context = arguments.contexts[key];
		if (structKeyExists(arguments.previous, key) && sameContext(arguments.previous[key], context)) continue;
		var restored = structCopy(context);
		if (structKeyExists(restored, "userBean")) restored.userBean = failedSaveBean(context, deserializeJSON(context.userBean));
		session["__fw1" & key] = restored;
		structDelete(session, "__fw1" & (key - 10));
	}
}

app = request.opt2BridgeApp;
op = url.op;
body = {};
// The session.mura keys userUtility.setUserStruct sets for a logged-in user, in describe's wire spelling.
userKeys = ["userID", "username", "siteID", "subtype", "password", "fname", "lname", "email", "remoteID", "company", "lastlogin", "passwordCreated"];
// The session values target and legacy admin routes share, which op=carry sets and op=export reads; "__fw1" stands for the
// FW/1 preserved contexts session["__fw1<key>"], which op=carry installs and op=export never reads, and "moduleTopIds"
// for the module tops session[<key>].topid.
sharedNames = ["flatViewArgs", "mura.nextN", "mura.alerts", "siteid", "userFilesPath", "topID", "openSectionList", "keywords", "datakeywords", "filterBy", "__fw1NextPreserveKey", "__fw1", "moduleid", "moduleTopIds", "mura.objectInstanceId"];
// The session keys holding a module's Site Manager top: before()'s "m<moduleid>" and the empty-tree reset's "<moduleid>", over
// the module ids carch before() accepts (admin/core/controllers/carch.cfc:79-107, 216-240).
moduleTopKeys = [];
for (moduleId in ["00000000000000000000000000000000000", "00000000000000000000000000000000003", "00000000000000000000000000000000004", "00000000000000000000000000000000099", "000000000000000000000000000000000099"]) {
	arrayAppend(moduleTopKeys, "m" & moduleId);
	arrayAppend(moduleTopKeys, moduleId);
}

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
			// setUserStruct replaced the session.mura values op=carry installed, so the next carry installs every value again.
			structDelete(session, "opt2Carried");
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

		case "carry":
			// Sets each shared value unless its revision is the one installed last, so legacy's own writes to it stand until
			// identity's value changes again; the installed value's JSON is recorded for op=export.
			requireMethod("POST");
			requireSession();
			input = app.readJsonBody();
			values = structKeyExists(input, "values") ? input.values : "";
			if (!isArray(values)) {
				app.raise(400, "badRequest", "values must be an array");
			}
			for (entry in values) {
				if (!isStruct(entry) || !structKeyExists(entry, "name") || !isSimpleValue(entry.name) || !arrayFind(sharedNames, entry.name)
					|| !structKeyExists(entry, "value") || isNull(entry.value)
					|| !structKeyExists(entry, "revision") || !isSimpleValue(entry.revision) || !len(entry.revision)
					|| (entry.name == "__fw1" && !isContexts(entry.value)) || (entry.name == "moduleTopIds" && !isStruct(entry.value))) {
					app.raise(400, "badRequest", "values entries need a shared name, a value and a revision");
				}
			}
			param name="session.opt2Carried" default={};
			applied = [];
			for (entry in values) {
				carried = structKeyExists(session.opt2Carried, entry.name) ? session.opt2Carried[entry.name] : {};
				if (!structKeyExists(carried, "revision") || compare(carried.revision, entry.revision) != 0) {
					if (entry.name == "__fw1") {
						installContexts(entry.value, structKeyExists(carried, "json") ? deserializeJSON(carried.json) : {});
						json = serializeJSON(entry.value);
					} else {
						writeShared(entry.name, entry.value);
						// The value as op=export reads it back, so an unchanged value is never exported.
						held = readShared(entry.name);
						json = held.exists ? serializeJSON(held.value) : "";
					}
					session.opt2Carried[entry.name] = {"revision": entry.revision, "json": json};
					arrayAppend(applied, entry.name);
				}
			}
			body = {"applied": applied};
			break;

		case "export":
			// Reads each shared value the session holds whose JSON differs from the one op=carry installed last, or that
			// op=carry never installed; simple values go out as strings, so a numeric-looking id keeps its digits.
			requireMethod("GET");
			requireSession();
			exported = [];
			for (name in sharedNames) {
				// No legacy-served preserving redirect lands on a target-served page, so contexts travel target to legacy only.
				if (name == "__fw1") {
					continue;
				}
				held = readShared(name);
				if (!held.exists || isNull(held.value)) {
					continue;
				}
				if (structKeyExists(session, "opt2Carried") && structKeyExists(session.opt2Carried, name)
					&& compare(session.opt2Carried[name].json, serializeJSON(held.value)) == 0) {
					continue;
				}
				arrayAppend(exported, {"name": name, "value": isSimpleValue(held.value) ? javacast("string", held.value) : held.value});
			}
			body = {"values": exported};
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
