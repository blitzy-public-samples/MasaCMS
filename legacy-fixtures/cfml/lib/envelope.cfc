// SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
component output="false" hint="Masa-shaped JSON envelope and value formats for the SYNTHETIC fixtures." {

	public any function init() hint="Configures Masa's serializer hints plus the fixture hints; a hinted key must carry only a scalar, because nested keys inherit its hint." {
		variables.serializer = new mura.jsonSerializer()
			.asString('csrf_token_expires')
			.asString('csrf_token')
			.asString('id')
			.asString('url')
			.asDate('start')
			.asDate('end')
			.asInteger('startindex')
			.asInteger('endindex')
			.asInteger('itemsperpage')
			.asInteger('totalpages')
			.asInteger('totalitems')
			.asInteger('pageindex')
			.asInteger('code')
			.asString('title')
			.asInteger('isnew')
			.asBoolean('saveErrors')
			.asBoolean('scaffold')
			.asBoolean('dynamic')
			.asInteger('expires_at')
			.asInteger('expires_in')
			.asInteger('version')
			.asInteger('seq')
			.asInteger('record_count')
			.asInteger('day_count')
			.asInteger('blackout_count')
			.asInteger('approved_count')
			.asInteger('size_bytes')
			.asInteger('offset_minutes')
			.asInteger('offsetminutes')
			.asInteger('schedule_version')
			.asInteger('inserted')
			.asInteger('total')
			.asInteger('blackouts')
			.asInteger('program_id')
			.asInteger('entries')
			.asInteger('brokenat')
			.asBoolean('overdue')
			.asBoolean('valid')
			.asBoolean('isblackout');

		variables.errorMap = {
			'authorization' = {'status' = 401, 'code' = 'invalid_request', 'message' = 'Insufficient Account Permissions'},
			'invalidParameters' = {'status' = 400, 'code' = 'invalid_request', 'message' = 'Invalid parameters'},
			'invalidMethodCall' = {'status' = 400, 'code' = 'invalid_request', 'message' = 'Invalid method call'},
			'badRequest' = {'status' = 400, 'code' = 'invalid_request', 'message' = 'Bad Request'},
			'forbidden' = {'status' = 403, 'code' = 'invalid_request', 'message' = 'Insufficient Account Permissions'},
			'notFound' = {'status' = 404, 'code' = 'invalid_request', 'message' = 'Not Found'},
			'conflict' = {'status' = 409, 'code' = 'invalid_request', 'message' = 'Conflict'},
			'server_error' = {'status' = 500, 'code' = 'server_error', 'message' = 'Unhandled Exception'}
		};

		return this;
	}

	public void function raise(required string type, string message="") hint="Throws opt2fixture.<type>; an empty message lets fail() apply the type's default." {
		throw(type="opt2fixture." & arguments.type, message=arguments.message);
	}

	public void function fail(
		required string type,
		required string method,
		struct params={},
		string message="",
		any exception
	) hint="Writes the Masa error envelope for a short or opt2fixture.-prefixed type (unknown types answer 500) and ends the request." {
		local.key = reReplaceNoCase(arguments.type, "^opt2fixture\.", "");
		local.entry = structKeyExists(variables.errorMap, local.key) ? variables.errorMap[local.key] : variables.errorMap['server_error'];

		local.error = [:];
		local.error['code'] = local.entry.code;
		local.error['message'] = len(arguments.message) ? arguments.message : local.entry.message;
		if (!isNull(arguments.exception) && application.configBean.getDebuggingEnabled()) {
			local.error['stacktrace'] = arguments.exception;
		}

		respond(local.entry.status, arguments.method, arguments.params, 'error', local.error);
	}

	public void function success(required string method, struct params={}, any data={}) hint="Writes the Masa success envelope with status 200 and ends the request." {
		respond(200, arguments.method, arguments.params, 'data', arguments.data);
	}

	public struct function page(struct params={}) hint="Validates pageIndex (default 1) and itemsPerPage (default 50, max 1000) and returns {pageIndex, itemsPerPage, offset}, offset being the count of rows before the page." {
		local.page = {
			'pageIndex' = pageParam(arguments.params, 'pageIndex', 1),
			'itemsPerPage' = pageParam(arguments.params, 'itemsPerPage', 50, 1000)
		};
		local.page['offset'] = (local.page.pageIndex - 1) * local.page.itemsPerPage;
		return local.page;
	}

	public struct function list(required array items, struct params={}) hint="Validates paging as page() does and returns {list, pageIndex, itemsPerPage} for listResponse() to slice in memory." {
		local.page = page(arguments.params);
		return {
			'list' = arguments.items,
			'pageIndex' = local.page.pageIndex,
			'itemsPerPage' = local.page.itemsPerPage
		};
	}

	public struct function queryPage(required string sql, required string countSql, struct sqlParams={}, struct params={}) hint="Validates paging as page() does, counts rows with countSql (column total) and, when the page starts before that total, runs sql with :offset and :fetch bound to the page; returns {list, pageIndex, itemsPerPage, totalItems} for listResponse()." {
		local.page = page(arguments.params);
		local.totalItems = queryExecute(arguments.countSql, arguments.sqlParams).total[1];
		local.items = [];
		if (local.page.offset < local.totalItems) {
			local.pageParams = structCopy(arguments.sqlParams);
			local.pageParams.offset = {value = local.page.offset, cfsqltype = "cf_sql_bigint"};
			local.pageParams.fetch = {value = local.page.itemsPerPage, cfsqltype = "cf_sql_integer"};
			local.items = rows(queryExecute(arguments.sql, local.pageParams));
		}
		return {
			'list' = local.items,
			'pageIndex' = local.page.pageIndex,
			'itemsPerPage' = local.page.itemsPerPage,
			'totalItems' = local.totalItems
		};
	}

	public void function listResponse(required string method, struct params={}, required struct listResult) hint="Writes one page of a list() or queryPage() result in Masa's paged-list shape and ends the request; a result with totalItems already holds only its page." {
		local.paged = structKeyExists(arguments.listResult, 'totalItems');
		local.totalItems = local.paged ? arguments.listResult.totalItems : arrayLen(arguments.listResult.list);
		local.pageIndex = arguments.listResult.pageIndex;
		local.itemsPerPage = arguments.listResult.itemsPerPage;
		local.startIndex = (local.pageIndex - 1) * local.itemsPerPage + 1;
		local.endIndex = min(local.startIndex + local.itemsPerPage - 1, local.totalItems);

		local.data = [:];
		if (local.startIndex > local.totalItems) {
			local.data['items'] = [];
		} else if (local.paged) {
			local.data['items'] = arguments.listResult.list;
		} else {
			local.data['items'] = arraySlice(arguments.listResult.list, local.startIndex, local.endIndex - local.startIndex + 1);
		}
		local.data['startindex'] = local.startIndex;
		local.data['endindex'] = local.endIndex;
		local.data['itemsperpage'] = local.itemsPerPage;
		local.data['totalitems'] = local.totalItems;
		local.data['totalpages'] = ceiling(local.totalItems / local.itemsPerPage);
		local.data['pageindex'] = local.pageIndex;

		success(arguments.method, arguments.params, local.data);
	}

	public void function sendFile(required binary bytes, required string contentType, required string fileName, string method="", struct params={}) hint="Streams bytes as an attachment download with status 200, the filename as an escaped quoted-string, and ends the request; a control character in the filename answers server_error." {
		if (reFind("[[:cntrl:]]", arguments.fileName)) {
			fail("server_error", arguments.method, arguments.params);
		}
		cfheader(name="Content-Disposition", value='attachment; filename="' & replace(replace(arguments.fileName, "\", "\\", "all"), '"', '\"', "all") & '"');
		cfcontent(type=arguments.contentType, variable=arguments.bytes, reset=true);
		abort;
	}

	public array function rows(required query qry, string include="") hint="Converts a query to an array of row structs: NULL as empty string, dates as yyyy-mm-ddTHH:nn:ss, decimals as plain strings; binary columns are dropped unless listed in include." {
		local.columns = [];
		for (local.meta in getMetadata(arguments.qry)) {
			local.type = lcase(listFirst(local.meta.TypeName, ' '));
			if (listFind('binary,varbinary,image,timestamp', local.type) && !listFindNoCase(arguments.include, local.meta.Name)) {
				continue;
			}
			arrayAppend(local.columns, {'name' = local.meta.Name, 'type' = local.type});
		}

		local.result = [];
		for (local.i = 1; local.i <= arguments.qry.recordCount; local.i++) {
			local.row = [:];
			for (local.column in local.columns) {
				local.value = arguments.qry[local.column.name][local.i];
				if (isNull(local.value)) {
					local.value = "";
				} else if (listFind('date,datetime,datetime2,smalldatetime', local.column.type) && len(local.value)) {
					local.value = dateTimeFormat(local.value, "yyyy-mm-dd'T'HH:nn:ss");
				} else if (isInstanceOf(local.value, "java.math.BigDecimal")) {
					local.value = local.value.toPlainString();
				}
				local.row[local.column.name] = local.value;
			}
			arrayAppend(local.result, local.row);
		}
		return local.result;
	}

	public string function sha256Hex(required any value) hint="Returns the lowercase hex SHA-256 of binary input, or of a string's UTF-8 bytes." {
		local.bytes = isBinary(arguments.value) ? arguments.value : charsetDecode(arguments.value, 'utf-8');
		local.digest = createObject('java', 'java.security.MessageDigest').getInstance('SHA-256').digest(local.bytes);
		return lcase(binaryEncode(local.digest, 'hex'));
	}

	private numeric function pageParam(required struct params, required string name, required numeric defaultValue, numeric maxValue=2147483647) hint="Returns a paging parameter as an integer in [1, maxValue], its default when absent or empty, or raises invalidParameters." {
		if (!structKeyExists(arguments.params, arguments.name) || isNull(arguments.params[arguments.name])) {
			return arguments.defaultValue;
		}
		local.value = arguments.params[arguments.name];
		if (isSimpleValue(local.value) && !len(local.value)) {
			return arguments.defaultValue;
		}
		if (!isValid('integer', local.value) || local.value < 1 || local.value > arguments.maxValue) {
			raise('invalidParameters');
		}
		return int(local.value);
	}

	private struct function paramsWithoutMethod(required struct params) hint="Port of jsonApiUtility.getParamsWithOutMethod: a copy without method, cache ids, bracket-derived keys or path-like values." {
		local.temp = {};
		structAppend(local.temp, arguments.params);
		structDelete(local.temp, 'method');
		structDelete(local.temp, '_cacheid');
		structDelete(local.temp, 'cacheid');

		for (local.p in structKeyArray(local.temp)) {
			if (find('[', local.p)) {
				structDelete(local.temp, listFirst(local.p, '[') & listFirst(listLast(local.p, '['), ']'));
			}
			if (structKeyExists(local.temp, local.p) && !isNull(local.temp[local.p]) && isSimpleValue(local.temp[local.p]) && refind('[\\/]', local.temp[local.p])) {
				structDelete(local.temp, local.p);
			}
		}
		return local.temp;
	}

	private boolean function useDataNamespaceForAPI() hint="Returns the configured useDataNamespaceForAPI flag, overridden by the request site's content renderer when it declares a boolean." {
		local.flag = application.configBean.getValue(property='useDataNamespaceForAPI', defaultValue=true);
		if (structKeyExists(request, 'siteid') && isSimpleValue(request.siteid) && len(request.siteid) && application.settingsManager.siteExists(request.siteid)) {
			local.renderer = application.settingsManager.getSite(request.siteid).getContentRenderer();
			if (structKeyExists(local.renderer, 'useDataNamespaceForAPI') && isBoolean(local.renderer.useDataNamespaceForAPI)) {
				local.flag = local.renderer.useDataNamespaceForAPI;
			}
		}
		return local.flag;
	}

	private void function respond(
		required numeric status,
		required string method,
		required struct params,
		required string payloadKey,
		required any payload
	) hint="Serializes the envelope as Masa's serializeResponse does, with status, JSON content type and ETag, and ends the request." {
		local.response = [:];
		local.response['apiversion'] = 'v1';
		local.response['method'] = arguments.method;
		local.response['params'] = paramsWithoutMethod(arguments.params);
		local.response[arguments.payloadKey] = arguments.payload;

		if (application.configBean.getValue(property='suppressAPIParams', defaultValue=true)) {
			structDelete(local.response, 'params');
		}

		if (structKeyExists(local.response, 'data') && isStruct(local.response.data)) {
			if (structKeyExists(arguments.params, 'useDataNamespace') && !isNull(arguments.params.useDataNamespace) && isBoolean(arguments.params.useDataNamespace)) {
				local.flatten = !arguments.params.useDataNamespace;
			} else {
				local.flatten = !useDataNamespaceForAPI();
			}
			if (local.flatten) {
				structAppend(local.response, local.response.data);
				structDelete(local.response, 'data');
			}
		}

		cfheader(statuscode=arguments.status);
		cfcontent(type="application/json; charset=utf-8", reset=true);
		local.body = variables.serializer.serialize(local.response);
		cfheader(name="ETag", value=hash(local.body));
		writeOutput(local.body);
		abort;
	}

}
