// Legacy bridge guard: serves only the five bridge pages, only for a verified gateway or migration assertion, inside Masa's application.
component extends="muraWRM.Application" output="false" {

	// Answers 404 or 403 with an empty body unless the request is a verified bridge call, then runs Masa's request start.
	public boolean function onRequestStart(string targetPage = cgi.script_name) output=false {
		// The default covers Masa's onMissingTemplate, which calls onRequestStart() without arguments.
		var fileName = listLast(getFileFromPath(arguments.targetPage), "/\");
		if (!listFind("session.cfm,jobs.cfm,scheduler.cfm,site.cfm,files.cfm", fileName)) {
			endEmpty(404);
		}

		var verdict = verifyAssertion(fileName);
		if (len(verdict.reason)) {
			writeLog(file = "opt2-bridge", type = "warning", text = "bridge rejected: " & verdict.reason);
			endEmpty(403);
		}
		request.opt2Bridge = verdict.payload;
		request.opt2BridgeApp = this;

		// Masa re-decodes url (setEncoding) before its reload check, so deleting the key first cannot stop a reload.
		// Its own reload flag does; Masa clears that flag itself when start-up is genuinely due.
		if (structKeyExists(url, reloadKeyName())) {
			request.muraAppreloaded = true;
		}
		var started = super.onRequestStart(argumentCollection = arguments);
		structDelete(url, reloadKeyName());
		return started;
	}

	// Writes body as the JSON response with the given status, adding serverTime when absent, and ends the request.
	public void function respondJson(required numeric status, required struct body) output=true {
		if (!structKeyExists(arguments.body, "serverTime")) {
			arguments.body["serverTime"] = formatLegacyTime(now());
		}
		cfheader(statuscode = arguments.status);
		cfcontent(type = "application/json; charset=utf-8", reset = true);
		writeOutput(serializeJSON(arguments.body));
		abort;
	}

	// Ends the request with the error body {error, message, serverTime}.
	public void function respondError(required numeric status, required string error, string message = "") output=true {
		respondJson(arguments.status, {"error": arguments.error, "message": arguments.message});
	}

	// Throws opt2bridge.fail: errorCode carries the error token, detail the HTTP status.
	public void function raise(required numeric status, required string error, string message = "") {
		throw(type = "opt2bridge.fail", errorCode = arguments.error, detail = arguments.status, message = arguments.message);
	}

	// Returns the JSON object request body, or {} for an empty body; raises 400 badRequest otherwise.
	public struct function readJsonBody() {
		var content = getHttpRequestData().content;
		var text = isBinary(content) ? charsetEncode(content, "utf-8") : content;
		if (!len(text)) {
			return {};
		}
		if (!isJSON(text)) {
			raise(400, "badRequest", "invalid JSON body");
		}
		var body = deserializeJSON(text);
		if (!isStruct(body)) {
			raise(400, "badRequest", "invalid JSON body");
		}
		return body;
	}

	// Wire time yyyy-mm-ddTHH:nn:ss.lll in the legacy server zone, without offset.
	public string function formatLegacyTime(required date d) {
		return dateTimeFormat(arguments.d, "yyyy-mm-dd") & "T" & dateTimeFormat(arguments.d, "HH:nn:ss.lll");
	}

	// Parses a wire time with a T or space separator and 0-3 fraction digits; raises 400 badRequest when invalid.
	public date function parseLegacyTime(required string s) {
		var text = replace(trim(arguments.s), "T", " ");
		if (!find(".", text)) {
			text &= ".000";
		}
		if (!reFind("^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,3}$", text)) {
			raise(400, "badRequest", "invalid time");
		}
		text = left(text, 20) & left(listLast(text, ".") & "00", 3);
		var parsed = "";
		try {
			// ACF reads this mask in ColdFusion letters (m month, n minute, l millisecond), not Java pattern letters.
			parsed = parseDateTime(text, "yyyy-mm-dd HH:nn:ss.lll");
		} catch (any e) {
			raise(400, "badRequest", "invalid time");
		}
		// A lenient parse rolls impossible dates over, so only a value that formats back unchanged is accepted.
		if (compare(dateTimeFormat(parsed, "yyyy-mm-dd HH:nn:ss.lll"), text) != 0) {
			raise(400, "badRequest", "invalid time");
		}
		return parsed;
	}

	// Lowercase hex SHA-256 of bytes.
	public string function sha256Hex(required binary bytes) {
		return lcase(binaryEncode(createObject("java", "java.security.MessageDigest").getInstance("SHA-256").digest(arguments.bytes), "hex"));
	}

	// Returns {reason: "", payload} for a valid assertion addressed to fileName, else {reason: <rejection token>}.
	private struct function verifyAssertion(required string fileName) {
		var headers = getHttpRequestData(false).headers;
		if (!structKeyExists(headers, "X-Opt2-Bridge-Assertion") || !isSimpleValue(headers["X-Opt2-Bridge-Assertion"])
			|| !len(headers["X-Opt2-Bridge-Assertion"])) {
			return {reason: "missingAssertion"};
		}
		var key = createObject("java", "java.lang.System").getenv("OPT2_BRIDGE_HMAC_KEY");
		if (isNull(key) || !len(key)) {
			return {reason: "missingKey"};
		}

		var parts = listToArray(headers["X-Opt2-Bridge-Assertion"], ".", true);
		if (arrayLen(parts) != 2 || !len(parts[1]) || !len(parts[2])) {
			return {reason: "malformed"};
		}
		var expected = lcase(hmac(parts[1], key, "HMACSHA256", "UTF-8"));
		if (!createObject("java", "java.security.MessageDigest").isEqual(expected.getBytes("UTF-8"), parts[2].getBytes("UTF-8"))) {
			return {reason: "macMismatch"};
		}

		var payload = decodePayload(parts[1]);
		if (!structKeyExists(payload, "nonce")) {
			return {reason: "malformed"};
		}
		if (compare(payload.aud, "legacy-bridge") != 0) {
			return {reason: "audience"};
		}
		// Not "\ 1000": ACF's integer division needs 32-bit operands, which epoch milliseconds exceed.
		var nowS = int(createObject("java", "java.lang.System").currentTimeMillis() / 1000);
		// Valid while nowS < exp <= nowS + 60, the window the TypeScript verifier applies.
		if (payload.exp <= nowS) {
			return {reason: "expired"};
		}
		if (payload.exp > nowS + 60) {
			return {reason: "tooFar"};
		}

		var replayed = false;
		lock name="opt2BridgeNonce" type="exclusive" timeout="10" {
			param name="application.opt2BridgeNonces" default={};
			for (var seen in structKeyArray(application.opt2BridgeNonces)) {
				if (application.opt2BridgeNonces[seen] <= nowS) {
					structDelete(application.opt2BridgeNonces, seen);
				}
			}
			replayed = structKeyExists(application.opt2BridgeNonces, payload.nonce);
			if (!replayed) {
				application.opt2BridgeNonces[payload.nonce] = nowS + 120;
			}
		}
		if (replayed) {
			return {reason: "replay"};
		}

		var base = listFirst(arguments.fileName, ".");
		var opParam = base == "jobs" ? "job" : "op";
		if (!structKeyExists(url, opParam) || !isSimpleValue(url[opParam]) || !len(url[opParam])
			|| compare(payload.op, base & "." & url[opParam]) != 0) {
			return {reason: "opMismatch"};
		}
		if (len(payload.siteId) && (!structKeyExists(url, "siteid") || compare(url.siteid, payload.siteId) != 0)) {
			return {reason: "siteMismatch"};
		}
		return {reason: "", payload: payload};
	}

	// Decodes the base64url payload part into its claims, or {} when a claim is missing, the nonce empty or exp not a whole number.
	private struct function decodePayload(required string part) {
		try {
			var b64 = replace(replace(arguments.part, "-", "+", "all"), "_", "/", "all");
			b64 &= repeatString("=", (4 - len(b64) % 4) % 4);
			var json = charsetEncode(binaryDecode(b64, "base64"), "utf-8");
			if (!isJSON(json)) {
				return {};
			}
			var claims = deserializeJSON(json);
			if (!isStruct(claims)) {
				return {};
			}
			for (var name in ["aud", "op", "sid", "sub", "siteId", "exp", "nonce"]) {
				if (!structKeyExists(claims, name) || !isSimpleValue(claims[name])) {
					return {};
				}
			}
			if (!len(claims.nonce) || !isNumeric(claims.exp) || claims.exp != int(claims.exp)) {
				return {};
			}
			return claims;
		} catch (any e) {
			return {};
		}
	}

	// URL key that makes Masa re-initialise.
	private string function reloadKeyName() {
		return structKeyExists(application, "appReloadKey") ? application.appReloadKey : "appreload";
	}

	// Ends the request with the given status and an empty body.
	private void function endEmpty(required numeric status) {
		cfheader(statuscode = arguments.status);
		cfcontent(reset = true);
		abort;
	}

}
