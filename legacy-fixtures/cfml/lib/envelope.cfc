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
			.asInteger('inserted')
			.asInteger('total');

		variables.errorMap = {
			'authorization' = {'status' = 401, 'code' = 'invalid_request', 'message' = 'Insufficient Account Permissions'},
			'invalidParameters' = {'status' = 400, 'code' = 'invalid_request', 'message' = 'Invalid parameters'},
			'invalidMethodCall' = {'status' = 400, 'code' = 'invalid_request', 'message' = 'Invalid method call'},
			'badRequest' = {'status' = 400, 'code' = 'invalid_request', 'message' = 'Bad Request'},
			'invalidTokens' = {'status' = 400, 'code' = 'invalid_request', 'message' = 'Invalid CSRF tokens'},
			'forbidden' = {'status' = 403, 'code' = 'invalid_request', 'message' = 'Insufficient Account Permissions'},
			'notFound' = {'status' = 404, 'code' = 'invalid_request', 'message' = 'Not Found'},
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
		string message=""
	) hint="Writes the Masa error envelope for a short or opt2fixture.-prefixed type (unknown types answer 500) and ends the request." {
		local.key = reReplaceNoCase(arguments.type, "^opt2fixture\.", "");
		local.entry = structKeyExists(variables.errorMap, local.key) ? variables.errorMap[local.key] : variables.errorMap['server_error'];

		local.error = [:];
		local.error['code'] = local.entry.code;
		local.error['message'] = len(arguments.message) ? arguments.message : local.entry.message;

		respond(local.entry.status, arguments.method, arguments.params, 'error', local.error);
	}

	public void function success(required string method, struct params={}, any data={}) hint="Writes the Masa success envelope with status 200 and ends the request." {
		respond(200, arguments.method, arguments.params, 'data', arguments.data);
	}

	public array function rows(required query qry, string include="") hint="Converts a query to an array of row structs: NULL as the empty string ACF reads, dates as yyyy-mm-ddTHH:nn:ss, decimals as plain strings; binary columns are dropped unless listed in include." {
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
				if (listFind('date,datetime,datetime2,smalldatetime', local.column.type) && len(local.value)) {
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
