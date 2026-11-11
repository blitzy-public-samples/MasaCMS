<cfscript>
// Legacy file store bridge: lists, reads, writes and deletes <fileDir>/<siteid>/cache/file/ objects with Masa's path rules and file writer.
app = request.opt2BridgeApp;
op = url.op;
namePattern = "^[A-Za-z0-9-]{35}(_source|_small|_medium)?\.[A-Za-z0-9]+$";
fileIdPattern = "^[A-Za-z0-9-]{35}$";
body = {};
bytes = "";
sha = "";

// Returns url[key] when it matches pattern; raises 400 badRequest otherwise.
function requireParam(required string key, required string pattern) {
	if (!structKeyExists(url, arguments.key) || !isSimpleValue(url[arguments.key]) || !reFind(arguments.pattern, url[arguments.key])) {
		app.raise(400, "badRequest", "invalid " & arguments.key);
	}
	return url[arguments.key];
}

// Splits a name that matches namePattern into {name, fileId, variant, ext}.
function parseName(required string name) {
	return {
		"name": arguments.name,
		"fileId": left(arguments.name, 35),
		"variant": mid(arguments.name, 36, find(".", arguments.name) - 36),
		"ext": listLast(arguments.name, ".")
	};
}

try {
	if (!arrayFind(["list", "get", "put", "delete"], op)) {
		app.raise(404, "notFound", "unknown op");
	}
	if (compare(cgi.request_method, (op == "list" || op == "get") ? "GET" : "POST") != 0) {
		app.raise(400, "badRequest", "wrong method");
	}
	if (!structKeyExists(url, "siteid") || !isSimpleValue(url.siteid) || !len(url.siteid)) {
		app.raise(400, "badRequest", "missing siteid");
	}
	if (!application.settingsManager.siteExists(url.siteid)) {
		app.raise(404, "notFound", "unknown site");
	}
	store = application.configBean.getFileStore();
	if (store != "fileDir" && op != "list") {
		app.raise(409, "unsupportedFileStore", store);
	}
	dir = application.configBean.getFileDir() & "/" & url.siteid & "/cache/file/";

	switch (op) {
		// Every name-rule file in the directory, so variants are found rather than assumed.
		case "list":
			files = [];
			if (store == "fileDir" && directoryExists(dir)) {
				listing = directoryList(dir, false, "query", "*", "name asc");
				for (i = 1; i <= listing.recordCount; i++) {
					if (listing.type[i] == "File" && reFind(namePattern, listing.name[i])) {
						entry = parseName(listing.name[i]);
						content = fileReadBinary(dir & listing.name[i]);
						entry["size"] = len(content);
						entry["sha256"] = app.sha256Hex(content);
						entry["lastModified"] = app.formatLegacyTime(listing.dateLastModified[i]);
						arrayAppend(files, entry);
					}
				}
			}
			body = {"fileStore": store, "files": files};
			break;

		// Bytes and hash of one file, streamed after the try.
		case "get":
			name = requireParam("name", namePattern);
			if (!fileExists(dir & name)) {
				app.raise(404, "notFound", "missing file");
			}
			bytes = fileReadBinary(dir & name);
			sha = app.sha256Hex(bytes);
			break;

		// Hash-checked write through Masa's fileWriter, overwriting as Masa's cache writes do.
		case "put":
			name = requireParam("name", namePattern);
			httpRequest = getHttpRequestData();
			content = httpRequest.content;
			if (!isBinary(content)) {
				app.raise(400, "badRequest", "body must be application/octet-stream");
			}
			if (!structKeyExists(httpRequest.headers, "X-Opt2-Sha256") || !isSimpleValue(httpRequest.headers["X-Opt2-Sha256"])
				|| !len(httpRequest.headers["X-Opt2-Sha256"])) {
				app.raise(400, "badRequest", "missing X-Opt2-Sha256");
			}
			sha = app.sha256Hex(content);
			if (compare(sha, lcase(httpRequest.headers["X-Opt2-Sha256"])) != 0) {
				app.raise(400, "hashMismatch", "body does not hash to X-Opt2-Sha256");
			}
			fileWriter = application.serviceFactory.getBean("fileWriter");
			fileWriter.touchDir(dir, "774");
			fileWriter.writeFile(mode = "774", file = dir & name, output = content, addNewLine = false);
			if (compare(app.sha256Hex(fileReadBinary(dir & name)), sha) != 0) {
				app.raise(500, "serverError", "opt2bridge.writeVerification");
			}
			body = {"written": true, "name": name, "size": len(content), "sha256": sha};
			break;

		// One file by name (which wins when both are given), or every <fileId>* file as Masa's deleteCachedFile does,
		// without its tfiles read or plugin events; directories are skipped where Masa's cffile delete would fail.
		case "delete":
			deleted = [];
			if (structKeyExists(url, "name")) {
				name = requireParam("name", namePattern);
				if (fileExists(dir & name)) {
					fileDelete(dir & name);
					arrayAppend(deleted, name);
				}
			} else if (structKeyExists(url, "fileId")) {
				fileId = requireParam("fileId", fileIdPattern);
				if (directoryExists(dir)) {
					listing = directoryList(dir, false, "query", fileId & "*", "name asc");
					for (i = 1; i <= listing.recordCount; i++) {
						if (listing.type[i] == "File") {
							fileDelete(dir & listing.name[i]);
							arrayAppend(deleted, listing.name[i]);
						}
					}
				}
			} else {
				app.raise(400, "badRequest", "missing name or fileId");
			}
			body = {"deleted": deleted};
			break;
	}
} catch (opt2bridge.fail e) {
	app.respondError(val(e.detail), e.errorCode, e.message);
} catch (any e) {
	app.respondError(500, "serverError", e.type);
}

if (op == "get") {
	cfheader(name = "X-Opt2-Sha256", value = sha);
	cfcontent(type = "application/octet-stream", variable = bytes, reset = true);
	abort;
}
app.respondJson(200, body);
</cfscript>
