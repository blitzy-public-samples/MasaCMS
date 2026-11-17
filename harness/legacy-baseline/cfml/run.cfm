<!--- Diagnostic TestBox runner and read-only environment and entity probes for the OPT-2 harness. --->
<cfsetting showdebugoutput="false" requesttimeout="1800">
<cfparam name="url.reporter" default="json">
<cfscript>
/** Sorted short names of the core spec bundles, bundleValidatorSecurity excluded. */
function baselineBundles() {
	var names = [];
	for (var fileName in directoryList(expandPath('/muraWRM/core/tests/specs/mura/core'), false, 'name', '*.cfc')) {
		var bundleName = reReplaceNoCase(fileName, '\.cfc$', '');
		if (compareNoCase(bundleName, 'bundleValidatorSecurity') != 0) {
			arrayAppend(names, bundleName);
		}
	}
	arraySort(names, 'text');
	return names;
}

/** configBean setting, or fallback when unset; unlike getValue it never stores the fallback. */
function configValue(required string name, any fallback = '') {
	var values = application.configBean.getAllValues();
	return structKeyExists(values, arguments.name) ? values[arguments.name] : arguments.fallback;
}

/** Masa-style flag: true only when the setting is a boolean true. */
function configFlag(required string name, required boolean fallback) {
	var value = configValue(arguments.name, arguments.fallback);
	return isBoolean(value) && value;
}

/** Strings sorted case-insensitively. */
function sortedStrings(required array values) {
	var result = [];
	for (var value in arguments.values) {
		arrayAppend(result, javaCast('string', value));
	}
	arraySort(result, 'textnocase');
	return result;
}

/** Replaces the response body with value as JSON and sets the status code. */
function respondJson(required any value, numeric status = 200) output=true {
	cfheader(statuscode = arguments.status);
	cfcontent(reset = true, type = "application/json; charset=utf-8");
	writeOutput(serializeJSON(arguments.value));
}

/** Current server time, ISO-8601 local with milliseconds. */
function isoNow() {
	return dateTimeFormat(now(), "yyyy-mm-dd'T'HH:nn:ss.lll");
}
</cfscript>
<cfif not structKeyExists(url, "info")>
<cfset sessionData=application.mura.getSession()>
<cfif not isDefined('sessionData.mura')>
    <cfset application.mura.getBean('userUtility').setUserStruct()>
</cfif>
<cfif application.mura.getBean('configBean').getValue(property='testbox',defaultValue=false) and directoryExists(Expandpath("/testbox"))>
    <cfset bundles = baselineBundles().map(function(n){ return 'muraWRM.core.tests.specs.mura.core.' & n; })>
    <cfset r = new testbox.system.TestBox( bundles=bundles ) >
    <cfoutput>#r.run(reporter=url.reporter)#</cfoutput>
<cfelse>
    <h1>Access Restricted.</h1>
    <cfoutput>
      <br/>Testbox enabled: #application.mura.getBean('configBean').getValue(property='testbox',defaultValue=false)#
      <br/>Testbox installed: #directoryExists(Expandpath("/testbox"))#
    </cfoutput>
</cfif>
<cfelseif url.info eq "1"><cfscript>
	cfpmCommand = server.coldfusion.rootdir & (findNoCase("windows", server.os.name) ? "\bin\cfpm.bat" : "/bin/cfpm.sh");
	cfpmLines = [];
	cfpmFailure = "";
	try {
		cfexecute(name = cfpmCommand, arguments = "list", timeout = 120, variable = "cfpmOut", errorVariable = "cfpmErr");
		for (cfpmLine in listToArray(cfpmOut, chr(10))) {
			if (len(trim(cfpmLine))) {
				arrayAppend(cfpmLines, javaCast("string", trim(cfpmLine)));
			}
		}
	} catch (any cfpmException) {
		cfpmFailure = cfpmException.message;
	}

	siteMonitorTask = listFindNoCase("Railo,Lucee", application.configBean.getCompiler())
		? "siteMonitor"
		: application.configBean.getWebRoot() & "/index.cfm/_api/sitemonitor/";
	cfschedule(action = "list", result = "scheduledTasks");
	taskRows = [];
	if (isQuery(scheduledTasks)) {
		for (taskRow in scheduledTasks) {
			arrayAppend(taskRows, taskRow);
		}
	} else {
		taskRows = scheduledTasks;
	}
	siteMonitorTaskRegistered = false;
	for (taskRow in taskRows) {
		taskName = structKeyExists(taskRow, "task") ? taskRow.task : "";
		taskUrl = structKeyExists(taskRow, "url") ? taskRow.url : "";
		if (compareNoCase(taskName, siteMonitorTask) == 0 || findNoCase("/_api/sitemonitor", taskUrl)) {
			siteMonitorTaskRegistered = true;
			break;
		}
	}

	broadcastClusterCommands = configFlag("broadcastClusterCommands", true) && !configFlag("readonly", false);
	cluster = structNew("ordered");
	cluster["broadcastClusterCommands"] = javaCast("boolean", broadcastClusterCommands);
	cluster["broadcastCachePurges"] = javaCast("boolean", configFlag("broadcastCachePurges", true) && broadcastClusterCommands);
	cluster["broadcastAppreloads"] = javaCast("boolean", configFlag("broadcastAppreloads", true) && broadcastClusterCommands);
	cluster["clearOldBroadcastCommands"] = javaCast("boolean", configFlag("clearOldBroadcastCommands", true) && broadcastClusterCommands);
	cluster["readonly"] = javaCast("boolean", configFlag("readonly", false));
	cluster["clusterIPList"] = javaCast("string", application.configBean.getClusterIPList());
	cluster["peerCount"] = javaCast("int", application.clusterManager.getPeers().recordcount);

	// Inputs of the application-start writers, read as start-up reads them [core/appcfc/onApplicationStart_include.cfm].
	projectSiteID = configValue("ProjectSiteID", "default");
	deployBundlePath = request.muraInDocker ? "/tmp/MuraBundle.zip" : expandPath("/muraWRM/config/setup/deploy/bundle.zip");
	themeStandardImageSizes = [];
	for (siteRow in application.settingsManager.getList()) {
		themeSite = application.settingsManager.getSite(siteRow.siteid);
		themeDir = expandPath(themeSite.getThemeIncludePath());
		themeXml = "";
		if (fileExists(themeDir & "/config.xml.cfm")) {
			savecontent variable = "themeXml" {
				include "#themeSite.getThemeIncludePath()#/config.xml.cfm";
			}
		} else if (fileExists(themeDir & "/config.xml")) {
			themeXml = fileRead(themeDir & "/config.xml");
		}
		if (len(themeXml) && isValid("xml", themeXml)) {
			// Masa's parseXML [core/mura/backport/acf.cfm:6-8].
			themeRoot = xmlParse(themeXml, false, {allowExternalEntities: false}).xmlRoot;
			// A small, medium or large size makes start-up save the site [core/mura/extend/extendManager.cfc:1976-2017].
			if (listFindNoCase("plugin,theme,mura,displayobject,contenttype", themeRoot.xmlName) && structKeyExists(themeRoot, "imagesizes")) {
				for (sizeNode in themeRoot.imagesizes.xmlChildren) {
					if (compareNoCase(sizeNode.xmlName, "imagesize") == 0 && structKeyExists(sizeNode.xmlAttributes, "name")
						&& listFindNoCase("small,medium,large", sizeNode.xmlAttributes.name)) {
						arrayAppend(themeStandardImageSizes, javaCast("string", siteRow.siteid));
						break;
					}
				}
			}
		}
	}
	startup = structNew("ordered");
	startup["projectSiteID"] = javaCast("string", projectSiteID);
	startup["projectSiteExists"] = javaCast("boolean", application.settingsManager.siteExists(projectSiteID));
	startup["deployBundlePath"] = javaCast("string", deployBundlePath);
	startup["deployBundlePresent"] = javaCast("boolean", fileExists(deployBundlePath));
	startup["autoDiscoverPlugins"] = javaCast("boolean", configFlag("autoDiscoverPlugins", false));
	startup["applyDbUpdates"] = javaCast("boolean", configFlag("applyDbUpdates", true));
	startup["appAutoUpdated"] = javaCast("boolean", structKeyExists(application, "appAutoUpdated") && application.appAutoUpdated);
	startup["themeStandardImageSizes"] = themeStandardImageSizes;

	environment = structNew("ordered");
	environment["productName"] = javaCast("string", server.coldfusion.productname);
	environment["productVersion"] = javaCast("string", server.coldfusion.productversion);
	environment["productLevel"] = javaCast("string", server.coldfusion.productlevel);
	environment["edition"] = javaCast("string", server.coldfusion.productlevel);
	if (structKeyExists(server.coldfusion, "expiration")) {
		environment["expiration"] = isDate(server.coldfusion.expiration)
			? dateTimeFormat(server.coldfusion.expiration, "yyyy-mm-dd'T'HH:nn:ss")
			: javaCast("string", server.coldfusion.expiration);
	} else {
		environment["expiration"] = javaCast("null", "");
	}
	environment["rootDir"] = javaCast("string", server.coldfusion.rootdir);
	// server.java exists only on Lucee; ACF 2018+ exposes the JVM properties under server.system.
	environment["javaVersion"] = javaCast("string", structKeyExists(server, "java") ? server.java.version : server.system.properties["java.version"]);
	environment["applicationName"] = javaCast("string", application.applicationName);
	if (len(cfpmFailure)) {
		environment["cfpmPackages"] = javaCast("null", "");
	} else {
		environment["cfpmPackages"] = cfpmLines;
	}
	environment["cfpmSource"] = "cfpm list";
	if (len(cfpmFailure)) {
		environment["cfpmError"] = javaCast("string", cfpmFailure);
	} else {
		environment["cfpmError"] = javaCast("null", "");
	}
	environment["testboxEnabled"] = javaCast("boolean", configFlag("testbox", false));
	environment["testboxInstalled"] = javaCast("boolean", directoryExists(expandPath("/testbox")));
	environment["ping"] = javaCast("boolean", configFlag("ping", false));
	environment["siteMonitorTask"] = javaCast("string", siteMonitorTask);
	environment["siteMonitorTaskRegistered"] = javaCast("boolean", siteMonitorTaskRegistered);
	environment["cluster"] = cluster;
	environment["startup"] = startup;
	environment["timeZone"] = javaCast("string", createObject("java", "java.util.TimeZone").getDefault().getID());
	environment["utcTotalOffset"] = javaCast("int", getTimeZoneInfo().utcTotalOffset);
	environment["serverTime"] = isoNow();
	environment["bundles"] = baselineBundles();
	environment["excludedBundles"] = ["bundleValidatorSecurity"];
	respondJson(environment);
</cfscript><cfelseif url.info eq "entities"><cfscript>
	mappings = application.objectMappings;
	bundleableList = structKeyExists(mappings, "bundleableBeans") ? mappings.bundleableBeans : "";
	versionedList = structKeyExists(mappings, "versionedBeans") ? mappings.versionedBeans : "";
	flagKeys = [
		["dynamic", "dynamic"], ["versioned", "versioned"], ["bundleable", "bundleable"],
		["historical", "historical"], ["scaffold", "scaffold"], ["public", "public"],
		["readonly", "readonly"], ["manageSchema", "manageschema"], ["useTrash", "usetrash"]
	];
	optionalKeys = [
		["primaryKey", "primarykey"], ["datasource", "datasource"],
		["discriminatorColumn", "discriminatorColumn"], ["discriminatorValue", "discriminatorValue"]
	];
	propertyKeys = ["name", "fieldtype", "datatype", "persistent", "cfc", "fkcolumn", "loadkey", "relatesto"];

	entityNames = [];
	for (mappingKey in structKeyArray(mappings)) {
		if (structKeyExists(mappings, mappingKey) && isStruct(mappings[mappingKey])) {
			arrayAppend(entityNames, mappingKey);
		}
	}
	arraySort(entityNames, "textnocase");

	entities = [];
	for (entityName in entityNames) {
		mapping = mappings[entityName];
		entry = structNew("ordered");
		entry["name"] = javaCast("string", entityName);
		if (structKeyExists(mapping, "displayname")) {
			entry["displayName"] = javaCast("string", mapping.displayname);
		} else {
			entry["displayName"] = javaCast("null", "");
		}
		tableName = structKeyExists(mapping, "table") ? mapping.table : "";
		if (structKeyExists(mapping, "table")) {
			entry["table"] = javaCast("string", tableName);
		} else {
			entry["table"] = javaCast("null", "");
		}

		try {
			beanInfo = application.serviceFactory.getBeanInfo(entityName);
		} catch (any beanNotFound) {
			beanInfo = {};
		}
		componentPath = structKeyExists(beanInfo, "cfc") ? beanInfo.cfc : "";
		componentFile = structKeyExists(beanInfo, "path") ? beanInfo.path : "";
		if (structKeyExists(beanInfo, "cfc")) {
			entry["componentPath"] = javaCast("string", componentPath);
		} else {
			entry["componentPath"] = javaCast("null", "");
		}
		if (structKeyExists(beanInfo, "path")) {
			entry["componentFile"] = javaCast("string", componentFile);
		} else {
			entry["componentFile"] = javaCast("null", "");
		}
		if (structKeyExists(beanInfo, "isSingleton") && isBoolean(beanInfo.isSingleton)) {
			entry["isSingleton"] = javaCast("boolean", beanInfo.isSingleton);
		} else {
			entry["isSingleton"] = javaCast("null", "");
		}

		for (flagKey in flagKeys) {
			if (structKeyExists(mapping, flagKey[2]) && isBoolean(mapping[flagKey[2]])) {
				entry[flagKey[1]] = javaCast("boolean", mapping[flagKey[2]]);
			} else {
				entry[flagKey[1]] = javaCast("null", "");
			}
		}
		for (optionalKey in optionalKeys) {
			if (structKeyExists(mapping, optionalKey[2])) {
				entry[optionalKey[1]] = javaCast("string", mapping[optionalKey[2]]);
			}
		}
		entry["inBundleableBeans"] = javaCast("boolean", listFindNoCase(bundleableList, entityName) > 0);
		entry["inVersionedBeans"] = javaCast("boolean", listFindNoCase(versionedList, entityName) > 0);

		properties = [];
		if (structKeyExists(mapping, "properties") && isStruct(mapping.properties)) {
			for (propertyName in sortedStrings(structKeyArray(mapping.properties))) {
				propertyMeta = mapping.properties[propertyName];
				propertyEntry = structNew("ordered");
				for (propertyKey in propertyKeys) {
					if (structKeyExists(propertyMeta, propertyKey)) {
						if (propertyKey == "persistent" && isBoolean(propertyMeta[propertyKey])) {
							propertyEntry[propertyKey] = javaCast("boolean", propertyMeta[propertyKey]);
						} else {
							propertyEntry[propertyKey] = javaCast("string", propertyMeta[propertyKey]);
						}
					}
				}
				arrayAppend(properties, propertyEntry);
			}
		}
		entry["properties"] = properties;
		if (structKeyExists(mapping, "columns")) {
			entry["columns"] = sortedStrings(isStruct(mapping.columns) ? structKeyArray(mapping.columns) : mapping.columns);
		}
		entry["registrationComplete"] = javaCast("boolean", structKeyExists(mapping, "properties"));

		if (left(tableName, 3) == "fb_") {
			origin = "formBuilder";
		} else if (structKeyExists(mapping, "dynamic") && isBoolean(mapping.dynamic) && mapping.dynamic) {
			origin = "dynamic";
		} else if (left(componentPath, 8) == "plugins." || findNoCase("/plugins/", componentFile)) {
			origin = "plugin";
		} else if (left(componentPath, 5) == "mura.") {
			origin = "core";
		} else {
			origin = "other";
		}
		entry["origin"] = origin;
		arrayAppend(entities, entry);
	}

	entityProbe = structNew("ordered");
	entityProbe["generatedAt"] = isoNow();
	entityProbe["bundleableBeans"] = sortedStrings(listToArray(bundleableList));
	entityProbe["versionedBeans"] = sortedStrings(listToArray(versionedList));
	entityProbe["entities"] = entities;
	respondJson(entityProbe);
</cfscript><cfelse><cfscript>
	invalid = structNew("ordered");
	invalid["error"] = "invalidParameters";
	respondJson(invalid, 400);
</cfscript></cfif>