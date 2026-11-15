import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTENTNAV_ENTITY,
  GENERIC_METHODS,
  IMAGE_UPLOAD_CONDITION,
  PHOTO_CONDITION,
  PUBLIC_METHODS,
  REGISTERED_ENTITIES,
  SAVEFORM_CONDITION,
  VARIATION_ENTITY,
} from '@opt2/platform/legacy-compat';
import type { RouteEntryPoint, RouteKeyOptions, VariantDeclaration } from '@opt2/platform/legacy-compat';
import { memorySourceTree, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { CfmlComponent, ComponentIndex, SourceTree } from '../../src/inventory/closure.js';
import { decide, loadDecisionList, loadExceptions } from '../../src/inventory/disposition.js';
import type { DispositionContext, DispositionFacts } from '../../src/inventory/disposition.js';
import { isHttpReachable } from '../../src/inventory/frontend.js';
import { inventoryRouteKey } from '../../src/inventory/route-keys.js';
import {
  API_AREA,
  APPLICATION_SETTINGS_PATH,
  BEAN_ROOT_PATH,
  CONTENT_SERVER_PATH,
  DECLARED_ENTITY_TABLES,
  FAMILY_MODES,
  FAMILY_TABLE,
  FIXTURE_API_PATH,
  FIXTURE_PREFIX,
  FIXTURE_SERVICES,
  JSON_API_PATH,
  OAUTH_IDS,
  PROGRAM_SCHEMA_FOLD,
  RUNTIME_METHODS,
  SETTINGS_BEAN_PATH,
  SOAP_AREA,
  SOAP_DIR,
  WEB_ROOT_COMPONENTS,
  areaKeyOf,
  assertPinnedRegistry,
  countRoutes,
  extractRoutes,
  fixtureModuleRoutes,
  loadFixtureTree,
  parseFixtureController,
  parseFixtureSql,
  parseJsonApi,
  parseOAuth,
  parseRouteFamilies,
  parseSessionlessPrefix,
  soapEntries,
} from '../../src/inventory/routes.js';
import type {
  ExtractRoutesOptions,
  FixtureController,
  JsonApiRegistry,
  RouteEntry,
  RouteExtraction,
  WriterOverrides,
} from '../../src/inventory/routes.js';
import { STARTUP_PATH } from '../../src/inventory/services.js';
import { assertOutsideRepo } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const FEED_API = 'core/mura/client/api/feed/v1/feedApiUtility.cfc';
const VARIATION_TEMPLATE = 'core/mura/client/api/resource/variation.js.cfm';
const BEAN_EXTENDABLE = 'core/mura/bean/beanExtendable.cfc';
const BEAN_FACTORY = 'core/mura/bean/beanFactory.cfc';
const CONTENT_BEAN = 'core/mura/content/contentBean.cfc';
const FILE_BEAN = 'core/mura/content/file/fileBean.cfc';
const FEED_BEAN = 'core/mura/content/feed/feedBean.cfc';
const USER_BEAN = 'core/mura/user/userBean.cfc';
const EXTEND_OBJECT = 'core/mura/extend/extendObject.cfc';
const USER_UTILITY = 'core/mura/user/userUtility.cfc';
const LOGIN_MANAGER = 'core/mura/login/loginManager.cfc';
const EMAIL_MANAGER = 'core/mura/email/emailManager.cfc';
const FILE_MANAGER = 'core/mura/content/file/fileManager.cfc';
const CONTENT_MANAGER = 'core/mura/content/contentManager.cfc';
const FORM_TEMPLATE = 'core/modules/v1/form/index.cfm';
const LOGIN_TEMPLATE = 'core/modules/v1/login/index.cfm';
const FILEBROWSER = 'core/modules/v1/filebrowser/model/beans/filebrowser.cfc';
const COLLECTION = 'core/modules/v1/collection/model/beans/collectionBean.cfc';
const MURA_GUARD = 'core/mura/Application.cfc';
const SOAP_USER = `${SOAP_DIR}/user.cfc`;
const SOAP_FEED = `${SOAP_DIR}/feed.cfc`;
const ENVELOPE = 'legacy-fixtures/cfml/lib/envelope.cfc';
const AUDIT_TEMPLATE = 'legacy-fixtures/cfml/lib/audit.cfm';
const PEOPLE = 'legacy-fixtures/cfml/modules/people.cfc';
const FINANCE = 'legacy-fixtures/cfml/modules/finance.cfc';
const REPORTING = 'legacy-fixtures/cfml/modules/reporting.cfc';
const PEOPLE_SQL = 'legacy-fixtures/sql/people/100_person_archive.sql';
const TIMESHEETS_SQL = 'legacy-fixtures/sql/timesheets/300_blackout.sql';
const FINANCE_SQL = 'legacy-fixtures/sql/finance/200_finance.program.sql';
const ESIGNATURE_SQL = 'legacy-fixtures/sql/esignature/400_audit.sql';
const SAMPLE_ID = '6B9B1F2C-0A1B-4C2D-9E8F70A1B2C3D4E5';
const MODULE_PERM = '00000000000000000000000000000000000';

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function scriptCfc(attrs: string, ...body: string[]): string {
  return lines(`component ${attrs} output="false" {`, ...body, '}');
}

/** handleRootRequest and handleAPIRequest, modelled on contentServer.cfc. */
const CONTENT_SERVER = lines(
  '<cfcomponent extends="mura.cfobject" output="false">',
  '<cffunction name="handleRootRequest" output="false">',
  '\t<cfargument name="path" default="#cgi.path_info#">',
  "\t<cfif listFindNoCase('_api,tasks',listFirst(path,'/'))>",
  '\t\t<cfreturn handleAPIRequest(arguments.path)>',
  '\t</cfif>',
  '\t<cfreturn "">',
  '</cffunction>',
  '<cffunction name="handleAPIRequest" output="false">',
  '\t<cfargument name="path" default="#cgi.path_info#">',
  '\t<cfset var jsonendpoint="/_api/json/v1">',
  '\t<cfset var ajaxendpoint="/_api/ajax/v1">',
  '\t<cfset var restendpoint="/_api/rest/v1">',
  '\t<cfset var feedendpoint="/_api/feed/v1">',
  '\t<cfset var legacyfeedendpoint="/tasks/feed">',
  '\t<cfset var variationendpoint="/_api/resource/variation">',
  '\t<cfset var emailendpoint="/_api/email/trackopen">',
  '\t<cfset var fileendpoint="/_api/render/">',
  '\t<cfset var legacyfileendpoint="/tasks/render/">',
  '\t<cfset var sitemonitorendpoint="/_api/sitemonitor">',
  '\t<cfset var legacywidgetendpoint="/tasks/widgets/">',
  '\t<cfset var assetendpoint="/_api/asset/">',
  '\t<cfset var siteid="">',
  '\t<cfif left(arguments.path,len(jsonendpoint)) eq jsonendpoint>',
  "\t\t<cfset siteid=listGetAt(arguments.path,4,'/')>",
  "\t\t<cfif isDefined('form.siteid')>",
  '\t\t\t<cfset siteid=form.siteid>',
  "\t\t<cfelseif isDefined('url.siteid')>",
  '\t\t\t<cfset siteid=url.siteid>',
  '\t\t</cfif>',
  '\t\t<cfif not getBean(\'settingsManager\').siteExists(siteid)><cfset siteid="default"></cfif>',
  "\t\t<cfreturn getBean('settingsManager').getSite(siteid).getApi('json','v1').processRequest(arguments.path)>",
  '\t<cfelseif left(arguments.path,len(ajaxendpoint)) eq ajaxendpoint>',
  "\t\t<cfreturn getBean('settingsManager').getSite(url.siteid).getApi('json','v1').processRequest(arguments.path)>",
  '\t<cfelseif left(arguments.path,len(restendpoint)) eq restendpoint>',
  "\t\t<cfset request.muraAPIRequestMode='rest'>",
  "\t\t<cfif isDefined('url.siteid')><cfset siteid=url.siteid></cfif>",
  "\t\t<cfreturn getBean('settingsManager').getSite(siteid).getApi('json','v1').processRequest(arguments.path)>",
  "\t<cfelseif isDefined('url.feedid') and (left(arguments.path,len(feedendpoint)) eq feedendpoint or left(arguments.path,len(legacyfeedendpoint)) eq legacyfeedendpoint)>",
  "\t\t<cfreturn getBean('settingsManager').getSite(siteid).getApi('feed','v1').processRequest(arguments.path)>",
  "\t<cfelseif application.configBean.getValue(property='variations',defaultValue=false) and isDefined('url.siteid') and left(arguments.path,len(variationendpoint)) eq variationendpoint>",
  "\t\t<cfreturn new mura.executor().execute('/mura/client/api/resource/variation.js.cfm')>",
  "\t<cfelseif isDefined('url.emailid') and left(arguments.path,len(emailendpoint)) eq emailendpoint>",
  "\t\t<cfset getBean('emailManager').track(url.emailid,url.email,'emailOpen')>",
  '\t\t<cfreturn "">',
  "\t<cfelseif isDefined('url.fileid') and (left(arguments.path,len(fileendpoint)) eq fileendpoint or left(arguments.path,len(legacyfileendpoint)) eq legacyfileendpoint)>",
  '\t\t<cfparam name="url.size" default="#listGetAt(path,3,\'/\')#">',
  '\t\t<cfswitch expression="#url.size#">',
  '\t\t\t<cfcase value="small">',
  "\t\t\t\t<cfreturn getBean('fileManager').renderSmall(url.fileid)>",
  '\t\t\t</cfcase>',
  '\t\t\t<cfcase value="medium">',
  "\t\t\t\t<cfreturn getBean('fileManager').renderMedium(url.fileid)>",
  '\t\t\t</cfcase>',
  '\t\t\t<cfdefaultcase>',
  "\t\t\t\t<cfreturn getBean('fileManager').renderFile(url.fileid)>",
  '\t\t\t</cfdefaultcase>',
  '\t\t</cfswitch>',
  '\t<cfelseif left(arguments.path,len(sitemonitorendpoint)) eq sitemonitorendpoint>',
  "\t\t<cfset getBean('contentManager').sendReminders(now())>",
  '\t\t<cfreturn "">',
  '\t<cfelseif left(arguments.path,len(legacywidgetendpoint)) eq legacywidgetendpoint>',
  '\t\t<cflocation statuscode="301" url="#replaceNoCase(cgi.path_info,\'/tasks/widgets/\',\'/core/vendor/\')#" addtoken="false">',
  '\t<cfelseif left(arguments.path,len(assetendpoint)) eq assetendpoint>',
  '\t\t<cfparam name="url.action" default="#listGetAt(path,3,\'/\')#">',
  '\t\t<cfswitch expression="#url.action#">',
  '\t\t\t<cfcase value="upload">',
  `\t\t\t\t<cfif getBean('permUtility').getModulePerm('${MODULE_PERM}',url.siteid)>`,
  "\t\t\t\t\t<cfreturn getBean('fileManager').upload(url.filePath)>",
  '\t\t\t\t</cfif>',
  '\t\t\t</cfcase>',
  '\t\t\t<cfdefaultcase>',
  "\t\t\t\t<cfreturn getBean('fileManager').renderAsset(url.filePath)>",
  '\t\t\t</cfdefaultcase>',
  '\t\t</cfswitch>',
  '\t</cfif>',
  '\t<cfreturn "">',
  '</cffunction>',
  '</cfcomponent>',
);

const PUBLIC_METHOD_LIST =
  'undeclareEntity,declareEntity,checkSchema,findOne,findMany,findAll,findPermissions,findProperties,findNew,findQuery,' +
  'save,delete,findCrumbArray,generateCSRFTokens,validateEmail,login,logout,submitForm,findCalendarItems,validate,' +
  'processAsyncObject,findRelatedContent,getURLForImage,findVersionHistory,findCurrentUser,swagger';

const UNCONDITIONAL_ENTITIES = [
  'site',
  'content',
  'comment',
  'user',
  'group',
  'address',
  'changeset',
  'feed',
  'category',
  'contentCategoryAssign',
  'file',
  'fileMetaData',
  'changesetCategoryAssignment',
  'stats',
];

/** init, processRequest, the generic and public methods and the token-info method, modelled on jsonApiUtility.cfc. */
const JSON_API = scriptCfc(
  'extends="mura.cfobject"',
  '\tfunction init(siteid) {',
  '\t\tvariables.siteid = arguments.siteid;',
  '\t\tvariables.config = {',
  `\t\t\tpublicMethods = "${PUBLIC_METHOD_LIST}",`,
  '\t\t\tentities = {',
  "\t\t\t\t'contentnav' = { fields = \"contentid,title,menutitle\" }",
  '\t\t\t}',
  '\t\t};',
  '\t\tvariables.csrfContexts = { calendar = arguments.calendarid };',
  '\t\tif (structIsEmpty(variables.config)) variables.ready = false;',
  ...UNCONDITIONAL_ENTITIES.map((e) => `\t\tregisterEntity('${e}', { moduleid = '${MODULE_PERM}' });`),
  "\t\tif (getBean('configBean').getValue(property='variations', defaultValue=false)) {",
  "\t\t\tregisterEntity('variationTargeting', { public = true });",
  '\t\t}',
  '\t\treturn this;',
  '\t}',
  '',
  '\tfunction registerEntity(entityName, config) {',
  '\t\tvariables.config.entities[arguments.entityName] = arguments.config;',
  '\t}',
  '',
  '\tfunction processRequest(path) {',
  '\t\tparam name="request.muraAPIRequestMode" default="json";',
  '\t\tvar params = {};',
  '\t\tvar method = "GET";',
  "\t\tvar pathInfo = listToArray(arguments.path, '/');",
  "\t\tif (listFindNoCase('contentnav', params.entityName)) {",
  '\t\t\tparams.entityName = "content";',
  '\t\t}',
  '\t\tif (!request.muraSessionManagement) {',
  "\t\t\tif (isDefined('params.access_token')) {",
  "\t\t\t\tif (pathInfo[4] == 'tokeninfo') {",
  '\t\t\t\t\treturn getOAuthTokenInfo(params.access_token);',
  '\t\t\t\t}',
  "\t\t\t\tgetBean('oauthToken').loadBy(token=params.access_token);",
  "\t\t\t} else if (isDefined('params.client_id') && isDefined('params.client_secret')) {",
  "\t\t\t\tgetBean('oauthClient').loadBy(clientid=params.client_id);",
  '\t\t\t} else {',
  "\t\t\t\tif (listFind('oauth,oauth2', pathInfo[4])) {",
  '\t\t\t\t\tqueryExecute("INSERT INTO toauthtokens (token, clientid) VALUES (:token, :clientid)", { token = createUUID(), clientid = params.client_id });',
  "\t\t\t\t\treturn { token_type = 'Bearer', note = 'client''s token' };",
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t}',
  '\t\tswitch (method) {',
  '\t\t\tcase "GET":',
  '\t\t\t\treturn findOne(argumentCollection=params);',
  '\t\t\tcase "POST":',
  '\t\t\tcase "PUT":',
  '\t\t\t\treturn save(argumentCollection=params);',
  '\t\t\tcase "DELETE":',
  '\t\t\t\treturn delete(argumentCollection=params);',
  '\t\t\tdefault:',
  '\t\t\t\tthrow(type="invalidMethodCall");',
  '\t\t}',
  '\t}',
  '',
  '\tfunction findOne(siteid, entityName, id) {',
  "\t\tvar $ = getBean('$').init(arguments.siteid);",
  '\t\tvar entity = $.getBean(arguments.entityName).loadBy(id=arguments.id);',
  '\t\treturn entity.getAllValues();',
  '\t}',
  '\tfunction findMany(siteid, entityName, ids) {',
  "\t\treturn getBean(arguments.entityName).getFeed().where().prop('id').isIn(arguments.ids).getIterator();",
  '\t}',
  '\tfunction findAll(siteid, entityName) {',
  '\t\treturn getBean(entityName).getFeed().getIterator();',
  '\t}',
  '\tfunction findNew(siteid, entityName) {',
  '\t\treturn getBean(arguments.entityName).getAllValues();',
  '\t}',
  '\tfunction findQuery(siteid, entityName) {',
  '\t\tvar feed = getBean(arguments.entityName).getFeed();',
  '\t\treturn feed.getQuery();',
  '\t}',
  '\tfunction findProperties(siteid, entityName) {',
  '\t\treturn getBean(arguments.entityName).properties.keyList();',
  '\t}',
  '\tfunction findPermissions(siteid, entityName) {',
  "\t\treturn getBean('permUtility').getModulePerm(getBean(arguments.entityName).getModuleID(), arguments.siteid);",
  '\t}',
  '\tfunction validate(siteid, entityName, data) {',
  '\t\treturn getBean(arguments.entityName).set(arguments.data).validate().getErrors();',
  '\t}',
  "\tfunction save(siteid, entityName, id='new') {",
  "\t\tvar $ = getBean('$').init(arguments.siteid);",
  '\t\tif (!request.muraSessionManagement || !$.validateCSRFTokens(context=arguments.id)) {',
  '\t\t\tthrow(type="invalidTokens");',
  '\t\t}',
  '\t\tvar entity = $.getBean(arguments.entityName).loadBy(id=arguments.id);',
  '\t\tentity.set(form).save();',
  "\t\tif (request.muraAPIRequestMode == 'json' && entity.getEntityName() == 'user' && entity.getUserID() == session.mura.userid) {",
  "\t\t\tgetBean('userUtility').loginByUserID(entity.getUserID(), arguments.siteid);",
  '\t\t}',
  '\t\treturn entity.getAllValues();',
  '\t}',
  '\tfunction delete(siteid, entityName, id) {',
  "\t\tvar $ = getBean('$').init(arguments.siteid);",
  '\t\tif ($.getContentRenderer().validateCSRFTokens && !$.validateCSRFTokens(context=arguments.id)) {',
  '\t\t\tthrow(type="invalidTokens");',
  '\t\t}',
  '\t\tvar entity = $.getBean(arguments.entityName).loadBy(id=arguments.id);',
  '\t\tentity.delete();',
  '\t\treturn true;',
  '\t}',
  '',
  '\tfunction undeclareEntity(entityName) {',
  '\t\tgetServiceFactory().undeclareEntity(arguments.entityName);',
  '\t\treturn true;',
  '\t}',
  '\tfunction declareEntity(entityConfig) {',
  '\t\tgetServiceFactory().declareEntity(arguments.entityConfig);',
  "\t\tgetServiceFactory().containsBean('entity');",
  '\t\treturn true;',
  '\t}',
  '\tfunction checkSchema(entityName) {',
  '\t\tgetBean(arguments.entityName).checkSchema();',
  '\t\treturn true;',
  '\t}',
  '\tfunction findCrumbArray(siteid, contentid) {',
  "\t\treturn getBean('contentManager').getCrumbList(arguments.contentid, arguments.siteid);",
  '\t}',
  '\tfunction generateCSRFTokens(siteid, context) {',
  "\t\treturn getBean('$').init(arguments.siteid).generateCSRFTokens(context=arguments.context);",
  '\t}',
  '\tfunction validateEmail(email) {',
  "\t\tvar tokenContext = arguments.email & 'check';",
  "\t\tif (!getBean('$').validateCSRFTokens(context=tokenContext)) {",
  '\t\t\treturn false;',
  '\t\t}',
  "\t\treturn isValid('email', arguments.email);",
  '\t}',
  '\tfunction login(username, password, siteid) {',
  "\t\treturn getBean('loginManager').remoteLogin(arguments.username, arguments.password);",
  '\t}',
  '\tfunction logout(siteid) {',
  "\t\tif (true || !getBean('$').validateCSRFTokens(context='logout')) {",
  "\t\t\tgetBean('loginManager').logout();",
  '\t\t}',
  '\t\treturn true;',
  '\t}',
  '\tfunction findCalendarItems(siteid, calendarid) {',
  "\t\tif (!getBean('$').validateCSRFTokens(context=variables.csrfContexts.calendar)) {",
  '\t\t\treturn [];',
  '\t\t}',
  "\t\treturn getBean('contentGateway').getCalendarItems(arguments.siteid, arguments.calendarid);",
  '\t}',
  '\tfunction processAsyncObject(siteid, object) {',
  "\t\tvar $ = getBean('$').init(arguments.siteid);",
  '\t\treturn $.dspObject(object=arguments.object);',
  '\t}',
  '\tfunction findRelatedContent(siteid, contentid) {',
  "\t\treturn getBean('contentGateway').getRelatedContent(arguments.siteid, arguments.contentid);",
  '\t}',
  '\tfunction getURLForImage(siteid, fileid) {',
  "\t\treturn getBean('fileManager').renderFile(arguments.fileid);",
  '\t}',
  '\tfunction findVersionHistory(siteid, contentid) {',
  "\t\treturn getBean('contentGateway').getHistory(arguments.siteid, arguments.contentid);",
  '\t}',
  '\tfunction findCurrentUser() {',
  "\t\treturn getBean('$').currentUser().getAllValues();",
  '\t}',
  '\tfunction swagger(siteid) {',
  "\t\treturn getBean('swaggerGenerator').generate(variables.config);",
  '\t}',
  '\tfunction getOAuthTokenInfo(access_token) {',
  "\t\treturn getBean('oauthToken').loadBy(token=arguments.access_token).getAllValues();",
  '\t}',
);

const APPLICATION_SETTINGS = lines(
  '<cfscript>',
  'this.name = "masacms";',
  "this.sessionManagement = !(left(cgi.path_info,13)=='/_api/rest/v1');",
  '</cfscript>',
);

const SETTINGS_BEAN = scriptCfc(
  'extends="mura.bean.beanExtendable" entityname="site"',
  '\tfunction getApi(type="json", version="v1") {',
  '\t\treturn new mura.client.api.#arguments.type#.#arguments.version#.#arguments.type#ApiUtility(siteid=variables.instance.siteid);',
  '\t}',
);

const STARTUP = lines('<cfscript>', 'variables.serviceFactory=new mura.bean.beanFactory("/mura", true);', '</cfscript>');

function tagCfc(...body: string[]): string {
  return lines('<cfcomponent extends="mura.cfobject" output="false">', ...body, '</cfcomponent>');
}

function tagMethod(name: string, args: readonly string[], ...body: string[]): string {
  return lines(`<cffunction name="${name}" output="false">`, ...args.map((a) => `\t<cfargument name="${a}">`), ...body, '</cffunction>');
}

/** The pinned-archive excerpt the extraction reads. */
const ARCHIVE: Readonly<Record<string, string>> = {
  [CONTENT_SERVER_PATH]: CONTENT_SERVER,
  [JSON_API_PATH]: JSON_API,
  [APPLICATION_SETTINGS_PATH]: APPLICATION_SETTINGS,
  [SETTINGS_BEAN_PATH]: SETTINGS_BEAN,
  [STARTUP_PATH]: STARTUP,
  [FEED_API]: scriptCfc(
    'extends="mura.cfobject"',
    '\tfunction processRequest(path) {',
    "\t\treturn getBean('feedManager').read(url.feedid).getRSS();",
    '\t}',
  ),
  [VARIATION_TEMPLATE]: lines(
    "<cfset $=application.serviceFactory.getBean('$').init(url.siteid)>",
    '<cfset renderer=$.getContentRenderer()>',
    '<cfcontent type="text/javascript"><cfoutput>#renderer.renderVariations()#</cfoutput>',
  ),
  [BEAN_ROOT_PATH]: scriptCfc('extends="mura.cfobject"', '\tfunction init() {', '\t\treturn this;', '\t}'),
  [BEAN_EXTENDABLE]: scriptCfc('extends="mura.bean.bean"', '\tfunction getExtendedAttribute(name) {', '\t\treturn "";', '\t}'),
  [BEAN_FACTORY]: scriptCfc(
    'extends="mura.cfobject"',
    '\tfunction declareEntity(entityConfig) {',
    '\t\tqueryExecute("INSERT INTO tentity (name, scope) VALUES (:name, \'site\')", { name = arguments.entityConfig });',
    '\t}',
    '\tfunction undeclareEntity(entityName) {',
    '\t\tqueryExecute("DELETE FROM tentity WHERE name = :name", { name = arguments.entityName });',
    '\t}',
  ),
  [CONTENT_BEAN]: scriptCfc(
    'extends="mura.bean.beanExtendable" entityname="content"',
    '\tfunction save() {',
    '\t\tqueryExecute("UPDATE tcontent SET lastupdate = :now WHERE contentid = :contentid", { now = now(), contentid = variables.instance.contentid });',
    '\t\treturn this;',
    '\t}',
    '\tfunction delete() {',
    '\t\tqueryExecute("DELETE FROM tcontent WHERE contentid = :contentid", { contentid = variables.instance.contentid });',
    '\t}',
  ),
  [FILE_BEAN]: scriptCfc(
    'extends="mura.bean.beanORM" table="tfiles" entityname="file"',
    '\tfunction save() {',
    '\t\treturn this;',
    '\t}',
    '\tfunction delete() {',
    '\t\treturn this;',
    '\t}',
  ),
  [USER_BEAN]: scriptCfc(
    'extends="mura.bean.beanExtendable" entityname="user"',
    '\tfunction save() {',
    '\t\tqueryExecute("UPDATE tusers SET lastupdate = :now WHERE userid = :userid", { now = now(), userid = variables.instance.userid });',
    '\t\treturn this;',
    '\t}',
    '\tfunction delete() {',
    '\t\tqueryExecute("DELETE FROM tusers WHERE userid = :userid", { userid = variables.instance.userid });',
    '\t}',
  ),
  [FEED_BEAN]: scriptCfc(
    'extends="mura.bean.bean" entityname="feed"',
    '\tvariables.entityName = "feed";',
    '\tremote function getRemoteFeed(siteid) {',
    '\t\tqueryExecute("UPDATE tcontentfeeds SET lastimport = :now WHERE feedid = :feedid", { now = now(), feedid = variables.instance.feedid });',
    '\t\treturn "";',
    '\t}',
  ),
  [EXTEND_OBJECT]: scriptCfc('extends="mura.bean.bean" entityname="extendObject"', '\tremote function getExtendedData() {', '\t\treturn {};', '\t}'),
  [USER_UTILITY]: scriptCfc(
    'extends="mura.cfobject"',
    '\tfunction loginByUserID(userid, siteid) {',
    '\t\tqueryExecute("UPDATE tusers SET lastlogin = :now WHERE userid = :userid", { now = now(), userid = arguments.userid });',
    '\t\treturn true;',
    '\t}',
  ),
  [LOGIN_MANAGER]: scriptCfc(
    'extends="mura.cfobject"',
    '\tfunction remoteLogin(username, password) {',
    "\t\tif (!getBean('$').validateCSRFTokens(context='login')) {",
    '\t\t\treturn false;',
    '\t\t}',
    "\t\treturn getBean('userUtility').loginByUserID(arguments.username, '');",
    '\t}',
    '\tfunction logout() {',
    "\t\tstructDelete(session, 'mura');",
    '\t}',
  ),
  [EMAIL_MANAGER]: tagCfc(
    tagMethod(
      'track',
      ['emailid', 'email', 'type'],
      '\t<cfquery>',
      '\t\tINSERT INTO temailstats (emailid, email, type) VALUES (<cfqueryparam value="#arguments.emailid#">, <cfqueryparam value="#arguments.email#">, <cfqueryparam value="#arguments.type#">)',
      '\t</cfquery>',
    ),
  ),
  [FILE_MANAGER]: tagCfc(
    tagMethod('renderSmall', ['fileid'], '\t<cfreturn renderFile(arguments.fileid)>'),
    tagMethod('renderMedium', ['fileid'], '\t<cfreturn renderFile(arguments.fileid)>'),
    tagMethod('renderFile', ['fileid'], '\t<cfreturn "">'),
    tagMethod('renderAsset', ['filePath'], '\t<cfreturn "">'),
    tagMethod('upload', ['filePath'], '\t<cfreturn create(arguments.filePath)>'),
    tagMethod(
      'create',
      ['filePath'],
      '\t<cfquery>',
      '\t\tINSERT INTO tfiles (fileid, filename) VALUES (<cfqueryparam value="#createUUID()#">, <cfqueryparam value="#arguments.filePath#">)',
      '\t</cfquery>',
    ),
  ),
  [CONTENT_MANAGER]: tagCfc(
    tagMethod('sendReminders', ['theTime'], '\t<cfquery>', '\t\tDELETE FROM tcontenteventreminders WHERE remindDate < <cfqueryparam value="#arguments.theTime#">', '\t</cfquery>'),
  ),
  [FORM_TEMPLATE]: lines(
    "<cfif not len(event('saveform'))>",
    "\t<cfoutput>#$.dspObject_include(theFile='form/form.cfm')#</cfoutput>",
    '</cfif>',
    "<cfif len(event('saveform'))>",
    "\t<cfif not $.validateCSRFTokens(context=event('formid'))>",
    '\t\t<cfabort>',
    '\t</cfif>',
    '\t<cfquery>',
    '\t\tINSERT INTO tformresponsepackets (responseid, formid) VALUES (<cfqueryparam value="#createUUID()#">, <cfqueryparam value="#event(\'formid\')#">)',
    '\t</cfquery>',
    '</cfif>',
  ),
  [LOGIN_TEMPLATE]: lines('<cfif len(event(\'username\'))>', "\t<cfoutput>#$.dspObject_include(theFile='login/form.cfm')#</cfoutput>", '</cfif>'),
  [FILEBROWSER]: scriptCfc(
    'extends="mura.bean.bean"',
    '\tvariables.entityName = "filebrowser";',
    '\tremote function browse(directory) {',
    "\t\treturn directoryList(expandPath('/' & arguments.directory));",
    '\t}',
  ),
  [COLLECTION]: scriptCfc(
    'extends="mura.bean.bean"',
    '\tremote function render(siteid) {',
    '\t\treturn "";',
    '\t}',
    '\tfunction helper() {',
    '\t\treturn "";',
    '\t}',
  ),
  [SOAP_USER]: scriptCfc(
    '',
    '\tremote any function login(username, password) {',
    '\t\treturn application.loginManager.remoteLogin(arguments.username, arguments.password);',
    '\t}',
  ),
  [SOAP_FEED]: lines('<cfcomponent output="false">', '<cffunction name="read" access="remote" output="false">', '\t<cfreturn "">', '</cffunction>', '</cfcomponent>'),
};

/** Bean names the start-up registers, as the component index resolves them. */
const BEANS: Readonly<Record<string, string>> = {
  site: SETTINGS_BEAN_PATH,
  content: CONTENT_BEAN,
  user: USER_BEAN,
  file: FILE_BEAN,
  feed: FEED_BEAN,
  userutility: USER_UTILITY,
  loginmanager: LOGIN_MANAGER,
  emailmanager: EMAIL_MANAGER,
  filemanager: FILE_MANAGER,
  contentmanager: CONTENT_MANAGER,
};

const ORM_TABLES: Readonly<Record<string, string>> = { [FILE_BEAN]: 'tfiles' };

/** The fixture front controller, its modules and SQL, as the working tree holds them. */
const FIXTURES: Readonly<Record<string, string>> = {
  [FIXTURE_API_PATH]: lines(
    '<cfscript>',
    '// SYNTHETIC: fixture front controller excerpt.',
    'variables.fixtureModules = "people,finance,reporting";',
    'variables.segments = listToArray(cgi.path_info, "/");',
    'variables.segmentCount = arrayLen(variables.segments);',
    'if (variables.segmentCount >= 2 && variables.segmentCount <= 5) {',
    '\tvariables.route = { module = lCase(variables.segments[1]), resource = variables.segments[2] };',
    '\tvariables.envelope = createObject("component", "lib.envelope");',
    '\tvariables.module = createObject("component", "modules." & variables.route.module).init(variables.envelope);',
    '\tvariables.module.handle(variables.route);',
    '}',
    '</cfscript>',
  ),
  [ENVELOPE]: scriptCfc(
    '',
    '\tfunction ok(data) {',
    '\t\treturn { data = arguments.data };',
    '\t}',
    '\tfunction validateCSRFTokens(context) {',
    '\t\treturn true;',
    '\t}',
  ),
  [AUDIT_TEMPLATE]: lines('<cfset request.audited = true>'),
  [PEOPLE]: scriptCfc(
    '',
    '\tfunction init(envelope) {',
    '\t\tvariables.envelope = arguments.envelope;',
    '\t\tvariables.resources = "persons";',
    "\t\tvariables.archiveAction = 'archive';",
    '\t\treturn this;',
    '\t}',
    '\tfunction handle(route) {',
    '\t\tvar r = arguments.route;',
    '\t\tvar verb = ucase(trim(r.httpMethod));',
    '\t\tvar target = "";',
    '\t\ttarget &= lcase(r.resource);',
    '\t\tif (listFindNoCase(variables.resources, target) == 0) {',
    '\t\t\traise(route, "notFound");',
    '\t\t}',
    '\t\tif (r.action == variables.archiveAction && len(r.id) > 0 && r.tail == "") {',
    '\t\t\tif (verb == "POST") return archive(route, gate(route));',
    '\t\t\tif (verb eq "GET") {',
    '\t\t\t\treturn archiveStatus(route, gate(route));',
    '\t\t\t}',
    '\t\t} else if (r.action == "" and not len(r.id) and r.tail == "") {',
    '\t\t\tif (verb == "POST") return create(route);',
    '\t\t\treturn list(route);',
    '\t\t}',
    '\t\traise(route, "notFound");',
    '\t}',
    '\tfunction gate(route) {',
    '\t\tif (listFind("GET,HEAD", arguments.route.httpMethod)) { return; }',
    '\t\tif (!variables.envelope.validateCSRFTokens(context=route.id)) {',
    '\t\t\traise(arguments.route, "forbidden");',
    '\t\t}',
    '\t\treturn true;',
    '\t}',
    '\tfunction archive(route, allowed) {',
    '\t\tqueryExecute("INSERT INTO synthetic.person_archive (userid, archivedat) VALUES (:userid, :now)", { userid = arguments.route.id, now = now() });',
    '\t\tqueryExecute("EXEC synthetic.usp_person_archived_blackout @userId = :userid", { userid = arguments.route.id });',
    '\t\treturn variables.envelope.ok({ archived = true });',
    '\t}',
    '\tfunction archiveStatus(route, allowed) {',
    '\t\treturn variables.envelope.ok(queryExecute("SELECT userid FROM synthetic.person_archive WHERE userid = :userid", { userid = arguments.route.id }));',
    '\t}',
    '\tfunction create(route) {',
    '\t\treturn variables.envelope.ok({});',
    '\t}',
    '\tfunction list(route) {',
    '\t\treturn variables.envelope.ok([]);',
    '\t}',
  ),
  [FINANCE]: scriptCfc(
    '',
    '\tfunction init(envelope) {',
    '\t\tvariables.envelope = arguments.envelope;',
    '\t\tvariables.verbs = "GET,POST";',
    '\t\treturn this;',
    '\t}',
    '\tfunction handle(route) {',
    '\t\tvar verb = arguments.route.httpMethod;',
    '\t\tif (!listFind(variables.verbs, verb)) {',
    '\t\t\traise(route, "methodNotAllowed");',
    '\t\t}',
    '\t\tswitch (route.resource) {',
    '\t\t\tcase "records":',
    '\t\t\t\tswitch (route.action) {',
    '\t\t\t\t\tcase "":',
    '\t\t\t\t\t\tif (route.id == "" && route.tail == "") {',
    '\t\t\t\t\t\t\tif (verb == "GET") return listRecords(route);',
    '\t\t\t\t\t\t\treturn createRecord(route);',
    '\t\t\t\t\t\t}',
    '\t\t\t\t\t\tif (route.tail == "" && verb == "GET") return showRecord(route);',
    '\t\t\t\t\t\tbreak;',
    '\t\t\t\t\tcase "attachments":',
    '\t\t\t\t\t\tif (verb == "GET") return attachment(route);',
    '\t\t\t\t\t\tbreak;',
    '\t\t\t\t\tdefault:',
    '\t\t\t\t\t\traise(route, "notFound");',
    '\t\t\t\t}',
    '\t\t\t\tbreak;',
    '\t\t\tcase "rollups":',
    '\t\t\t\tif (route.id == "" && verb == "GET") return rollups(route);',
    '\t\t\tdefault:',
    '\t\t\t\traise(route, "notFound");',
    '\t\t}',
    '\t}',
    '\tfunction listRecords(route) {',
    '\t\treturn variables.envelope.ok([]);',
    '\t}',
    '\tfunction createRecord(route) {',
    '\t\tif (listFind("GET,HEAD", arguments.route.httpMethod)) { return; }',
    '\t\tif (!variables.envelope.validateCSRFTokens(context=route.action)) {',
    '\t\t\treturn variables.envelope.ok({});',
    '\t\t}',
    '\t\tqueryExecute("INSERT INTO [#arguments.schema#].finance_record (recordid) VALUES (:id)", { id = createUUID() });',
    '\t\tqueryExecute("INSERT INTO [#arguments.schema#].finance_note (recordid) VALUES (:id)", { id = createUUID() });',
    '\t\tqueryExecute("EXEC [#arguments.schema#].usp_finance_rollup @recordId = :id", { id = createUUID() });',
    '\t\treturn variables.envelope.ok({});',
    '\t}',
    '\tfunction showRecord(route) {',
    '\t\tinclude "../lib/audit.cfm";',
    '\t\treturn variables.envelope.ok({});',
    '\t}',
    '\tfunction attachment(route) {',
    '\t\treturn variables.envelope.ok({});',
    '\t}',
    '\tfunction rollups(route) {',
    '\t\treturn getBean("envelope").ok([]);',
    '\t}',
  ),
  [REPORTING]: scriptCfc(
    '',
    '\tfunction init(envelope) {',
    '\t\tvariables.envelope = arguments.envelope;',
    '\t\treturn this;',
    '\t}',
    '\tfunction handle(route) {',
    '\t\tvar enabled = "yes";',
    '\t\tvar strict = true;',
    '\t\tvar kind = len(route.id) ? "one" : "many";',
    '\t\tvar label = "export #route.id#";',
    '\t\tvar hashes = "####";',
    '\t\tvar probe = variables.envelope.ok({}).data;',
    '\t\tvar first = route.params["x"];',
    '\t\tvar opts = { a = 1 };',
    '\t\tvar list = [1, 2];',
    '\t\tvar stamp = createUUID();',
    '\t\t;',
    '\t\tif (!enabled) {',
    '\t\t\traise(route, "disabled");',
    '\t\t}',
    '\t\tif (strict && len(route.resource) >= 1 && len(route.tail) <= 0 && len(route.module) > 0 && len(route.action) < 20 && route.method != "x" && route.siteid neq "y" && kind != "") {',
    '\t\t\tif (route.resource == "exports" && route.action == "" && route.tail == "") {',
    '\t\t\t\tif (route.httpMethod == "POST" && route.id == "") return startExport(route);',
    '\t\t\t\tif (route.httpMethod == "GET" && (len(route.id) || false)) return showExport(route);',
    '\t\t\t}',
    '\t\t\tif (route.resource == "exports" && (route.action == "download" or route.action == "file") && route.httpMethod == "GET" && listFind("1", "1")) return download(route);',
    '\t\t}',
    '\t}',
    '\tfunction startExport(route) {',
    '\t\tvar jobId = createUUID();',
    '\t\tqueryExecute("INSERT INTO synthetic.export_job (jobid, status) VALUES (:id, \'queued\')", { id = jobId });',
    '\t\tthread name="export#jobId#" jobId=jobId {',
    '\t\t\trunExport(attributes.jobId);',
    '\t\t}',
    '\t\treturn variables.envelope.ok({ id = jobId });',
    '\t}',
    '\tfunction runExport(jobId) {',
    '\t\tqueryExecute("UPDATE synthetic.export_job SET status = \'done\' WHERE jobid = :id", { id = arguments.jobId });',
    '\t\tqueryExecute("EXEC dbo.usp_missing @id = :id", { id = arguments.jobId });',
    '\t\tqueryExecute("EXEC usp_audit_append @entry = :id", { id = arguments.jobId });',
    '\t}',
    '\tfunction showExport(route) {',
    '\t\treturn variables.envelope.ok({});',
    '\t}',
    '\tfunction download(route) {',
    '\t\treturn variables.envelope.ok({});',
    '\t}',
  ),
  [PEOPLE_SQL]: lines(
    '-- SYNTHETIC: person archive excerpt.',
    'CREATE TABLE synthetic.person_archive (userid char(35) NOT NULL, archivedat datetime2 NOT NULL);',
    'GO',
  ),
  [TIMESHEETS_SQL]: lines(
    'CREATE TABLE $(PROGRAM_SCHEMA).blackout (userid char(35) NOT NULL);',
    'GO',
    'CREATE OR ALTER PROCEDURE synthetic.usp_person_archived_blackout @userId char(35) AS',
    'BEGIN',
    '\t/* INSERT INTO synthetic.not_written (x) VALUES (1) */',
    "\tINSERT INTO synthetic.timesheet_transition (userid, note) VALUES (@userId, 'it''s archived');",
    '\tEXEC synthetic.usp_audit_append @entry = @userId;',
    'END',
    'GO',
  ),
  [FINANCE_SQL]: lines(
    'CREATE TABLE $(PROGRAM_SCHEMA).finance_record (recordid char(35) NOT NULL);',
    'CREATE TABLE [$(PROGRAM_SCHEMA)].[finance_rollup] (programid int NOT NULL, total numeric(19,4) NOT NULL);',
    'GO',
    'CREATE PROCEDURE $(PROGRAM_SCHEMA).usp_finance_rollup @recordId char(35) AS',
    '\tDELETE FROM $(PROGRAM_SCHEMA).finance_rollup WHERE programid = 1; -- INSERT INTO synthetic.not_written',
    '\tMERGE INTO [$(PROGRAM_SCHEMA)].[finance_rollup] AS t USING (SELECT 1 AS programid) AS s ON t.programid = s.programid WHEN NOT MATCHED THEN INSERT (programid, total) VALUES (1, 0);',
    '\tEXEC synthetic.usp_audit_append @entry = @recordId;',
    'GO',
  ),
  [ESIGNATURE_SQL]: lines(
    'CREATE PROCEDURE synthetic.usp_audit_append @entry nvarchar(max) AS',
    "\tDECLARE @caller sysname = N'usp_person_archived_blackout';",
    '\tINSERT INTO synthetic.audit_entry (entry) VALUES (@entry);',
    '\tUPDATE synthetic.audit_entry SET verified = 0 WHERE entry = @entry;',
  ),
};

const VARIANTS: readonly VariantDeclaration[] = [
  { route: 'api:user.save', variant: 'photo', when: [PHOTO_CONDITION] },
  { route: 'api:processasyncobject', variant: 'formobject', when: [SAVEFORM_CONDITION, { param: 'object', equals: 'form' }] },
  { route: 'api:processasyncobject', variant: 'saveform', when: [SAVEFORM_CONDITION] },
  { route: 'rest:content.save', variant: 'image', when: [IMAGE_UPLOAD_CONDITION] },
  { route: 'api:site.save', variant: 'delete', when: [{ param: 'action', equals: 'Delete' }] },
  { route: 'api:site.save', variant: 'add', when: [{ param: 'action', in: ['Add', 'Copy'] }] },
  { route: 'rest:user.save', variant: 'roster', when: [{ param: 'type', equals: '2' }, { param: 'TYPE', in: ['2', '3'] }] },
  { route: 'api:group.save', variant: 'removephoto', when: [{ param: 'removePhotoFile', truthy: true }] },
  { route: 'api:group.delete', variant: 'typed', when: [{ anyOf: [{ param: 'type', equals: '1' }, { multipartExtensionIn: ['csv'] }] }] },
];

/** 1-based line of the only line of `text` containing `needle`. */
function lineWith(text: string, needle: string): number {
  const hits = text.split('\n').flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
  const [hit] = hits;
  if (hits.length !== 1 || hit === undefined) throw new Error(`${JSON.stringify(needle)} is on ${hits.length} lines`);
  return hit;
}

const DELETE_LINE = lineWith(JSON_API, 'function delete(');

const SHA = pinnedSha();

const OVERRIDES: WriterOverrides = {
  sourceSha: SHA,
  writers: [
    {
      id: 'wov:user-delete-memberships',
      tables: ['tusersmemb'],
      component: JSON_API_PATH,
      method: 'delete',
      op: 'delete',
      source: { path: JSON_API_PATH, lines: [DELETE_LINE, DELETE_LINE] },
      routeKeys: ['api:user.delete', 'rest:user.delete'],
      keyScope: ['userid'],
      trigger: 'request',
      sessionEffects: 'none',
      reason: 'Group memberships go with the deleted user.',
    },
  ],
};

/** Component index over `source` with {@link BEANS} and {@link ORM_TABLES}. */
function indexFor(source: SourceTree): ComponentIndex {
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => BEANS[name.toLowerCase()] ?? null,
    ormTable: (p) => ORM_TABLES[p] ?? null,
    parsed(p) {
      if (!parsed.has(p)) parsed.set(p, p.endsWith('.cfc') && source.exists(p) ? parseCfmlComponent(p, source.readText(p)) : null);
      return parsed.get(p) ?? null;
    },
  };
}

async function writeTree(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
}

const GUARD_FIXTURE = fileURLToPath(new URL('../fixtures/Application.cfc', import.meta.url));

function inventoryFixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/inventory/${name}`, import.meta.url));
}

/** Rule inputs for `decide`: every written table retired, no decision-list or exceptions entries. */
const DISPOSITION_CONTEXT: DispositionContext = {
  ownership: { sourceSha: SHA, units: [], tables: [{ table: '*', owner: 'retired', ruleSteps: [1], targets: [] }] },
  decisionList: { sourceSha: SHA, tables: [], actionVariants: [], spanningControllers: [] },
  exceptions: { sourceSha: SHA, entries: [] },
};

const REMOTE_FUNCTIONS: Record<string, readonly string[]> = { collection: ['render'], feed: ['getremotefeed'], filebrowser: ['browse'] };

const KEY_OPTIONS: RouteKeyOptions = { variants: VARIANTS, entityRemoteFunctions: REMOTE_FUNCTIONS };

/** Request parts each declared variant is sampled with. */
const VARIANT_SAMPLES: Readonly<Record<string, { params?: Record<string, string>; multipartFileNames?: Array<{ field: string; filename: string }> }>> = {
  photo: { params: { newFile: 'sample' } },
  formobject: { params: { saveform: 'sample', object: 'form' } },
  saveform: { params: { saveform: 'sample' } },
  image: { multipartFileNames: [{ field: 'newfile', filename: 'sample.png' }] },
  delete: { params: { action: 'Delete' } },
  add: { params: { action: 'Add' } },
  roster: { params: { type: '2', TYPE: '2' } },
  removephoto: { params: { removePhotoFile: 'true' } },
  typed: { params: { type: '1' } },
};

const FILE_QUERY = { fileid: SAMPLE_ID };
const ASSET_QUERY = { siteId: 'default', filePath: '/assets/Image/sample.png' };

/** Keyed family entries: the request each stands for, extra key options, and the key the platform grammar names. */
const FAMILY_POINTS: ReadonlyArray<readonly [string, RouteEntryPoint, RouteKeyOptions, string]> = [
  ['rte:/_api/feed/v1', { kind: 'path', path: '/_api/feed/v1/', query: { feedid: SAMPLE_ID } }, {}, 'feed:v1'],
  ['rte:/_api/resource/variation', { kind: 'path', path: '/_api/resource/variation/', query: { siteid: 'default' } }, { variationsEnabled: true }, 'variation:js'],
  ['rte:/_api/email/trackopen', { kind: 'path', path: '/_api/email/trackopen/', query: { emailid: SAMPLE_ID, email: 'reader@example.com' } }, {}, 'trackopen:open'],
  ['rte:/_api/render/small', { kind: 'path', path: '/_api/render/small/', query: FILE_QUERY }, {}, 'render:small'],
  ['rte:/_api/render/medium', { kind: 'path', path: '/tasks/render/medium/', query: FILE_QUERY }, {}, 'render:medium'],
  ['rte:/_api/render/file', { kind: 'path', path: '/_api/render/file/', query: FILE_QUERY }, {}, 'render:file'],
  ['rte:/_api/sitemonitor', { kind: 'path', path: '/_api/sitemonitor/' }, {}, 'sitemonitor:run'],
  ['rte:/tasks/widgets', { kind: 'path', path: '/tasks/widgets/' }, {}, 'widgets:redirect'],
  ['rte:/_api/asset/upload', { kind: 'path', path: '/_api/asset/upload/', query: ASSET_QUERY }, {}, 'asset:upload'],
  ['rte:/_api/asset/render', { kind: 'path', path: '/_api/asset/render/', query: ASSET_QUERY }, {}, 'asset:render'],
  ['rte:/oauth', { kind: 'path', path: '/_api/rest/v1/default/oauth/' }, {}, 'rest:oauth'],
  ['rte:/oauth2', { kind: 'path', path: '/_api/rest/v1/default/oauth2/' }, {}, 'rest:oauth2'],
  ['rte:tokeninfo', { kind: 'path', path: '/_api/rest/v1/default/tokeninfo', query: { access_token: 'sample', client_id: SAMPLE_ID } }, {}, 'rest:tokeninfo'],
];

/** The entry point an entry stands for, with the key options it is keyed under. */
function entryPointOf(e: RouteEntry): { point: RouteEntryPoint; options: RouteKeyOptions } {
  const sample = e.predicate === null ? {} : VARIANT_SAMPLES[e.predicate.variant];
  if (sample === undefined) throw new Error(`no sample for ${e.id}`);
  const family = e.family === 'rest' ? 'rest' : 'api';
  if (e.kind === 'fixture') {
    const at = e.id.lastIndexOf('@');
    return { point: { kind: 'fixture', httpMethod: e.id.slice(at + 1).toUpperCase(), path: `${FIXTURE_PREFIX}/${e.id.slice(4, at).replaceAll('{id}', SAMPLE_ID)}` }, options: KEY_OPTIONS };
  }
  if (e.kind === 'api-entity-method' && e.id.includes('.~')) {
    return { point: { kind: 'path', path: `/_api/${family === 'rest' ? 'rest' : 'json'}/v1/default/${e.entity ?? ''}/${SAMPLE_ID}/${e.method ?? ''}` }, options: KEY_OPTIONS };
  }
  if (e.kind === 'api-entity-method') return { point: { kind: 'api', family, method: e.method ?? '', entity: e.entity ?? '', ...sample }, options: KEY_OPTIONS };
  if (e.kind === 'api-method') return { point: { kind: 'api', family, method: e.method ?? '', ...sample }, options: KEY_OPTIONS };
  const known = FAMILY_POINTS.find(([id]) => id === e.id);
  if (known === undefined) throw new Error(`no entry point for ${e.id}`);
  return { point: known[1], options: { ...KEY_OPTIONS, ...known[2] } };
}

function factsOf(e: RouteEntry): DispositionFacts {
  return {
    itemKind: e.kind === 'fixture' ? 'fixture-route' : 'route',
    id: e.id,
    ...(e.routeKey === null ? {} : { routeKey: e.routeKey }),
    reachable: e.reachable,
    writeSet: e.writeSet,
    fileStoreWrite: e.fileStoreWrite,
    rendersCfml: e.rendersCfml,
    webRootFilesystem: e.webRootFilesystem,
    ...(e.runtimeCategory === null ? {} : { runtimeCategory: e.runtimeCategory }),
    areaKey: e.areaKey,
    ...(e.fixtureModule === null ? {} : { fixtureModule: e.fixtureModule }),
  };
}

/** `text` with the one occurrence of `from` replaced; throws unless `from` occurs exactly once. */
function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`${JSON.stringify(from)} does not occur exactly once`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** 1-based line of the only line of `text` equal to `exact`. */
function lineIs(text: string, exact: string): number {
  const hits = text.split('\n').flatMap((l, i) => (l === exact ? [i + 1] : []));
  const [hit] = hits;
  if (hits.length !== 1 || hit === undefined) throw new Error(`${JSON.stringify(exact)} is ${hits.length} lines`);
  return hit;
}

/** First and last line of the script function declared on the line holding `needle`. */
function fnLines(text: string, needle: string): [number, number] {
  const start = lineWith(text, needle);
  const end = text.split('\n').findIndex((l, i) => i >= start && l === '\t}');
  return [start, end + 1];
}

function textOf(files: Readonly<Record<string, string>>, file: string): string {
  const text = files[file];
  if (text === undefined) throw new Error(`no file ${file}`);
  return text;
}

const cs = (needle: string): number => lineWith(CONTENT_SERVER, needle);
const ja = (needle: string): number => lineWith(JSON_API, needle);

function src(file: string, from: number, to = from): { path: string; lines: [number, number] } {
  return { path: file, lines: [from, to] };
}

let root = '';
let archiveDir = '';
let workDir = '';
let guardText = '';
let tree: SourceTree;
let fixtureTree: SourceTree;
let extraction: RouteExtraction;

function entryOf(id: string): RouteEntry {
  const found = extraction.routes.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no routes[] entry ${id}`);
  return found;
}

/** In-memory archive with `changes` applied; an undefined value removes the file. */
function archiveTree(changes: Readonly<Record<string, string | undefined>>): SourceTree {
  const files = new Map<string, string>([...Object.entries(ARCHIVE), [MURA_GUARD, guardText]]);
  for (const [rel, text] of Object.entries(changes)) {
    if (text === undefined) files.delete(rel);
    else files.set(rel, text);
  }
  return memorySourceTree(files);
}

function extractFrom(source: SourceTree, opts: Partial<ExtractRoutesOptions> = {}): Promise<RouteExtraction> {
  return extractRoutes(source, { index: indexFor(source), variants: VARIANTS, fixtureTree: null, ...opts });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-routes-'));
  archiveDir = path.join(root, 'archive');
  workDir = path.join(root, 'work');
  await writeTree(archiveDir, ARCHIVE);
  await copyFile(GUARD_FIXTURE, path.join(archiveDir, MURA_GUARD));
  guardText = await readFile(GUARD_FIXTURE, 'utf8');
  await writeTree(workDir, FIXTURES);
  tree = openSourceTree(archiveDir);
  const loaded = loadFixtureTree(workDir);
  if (loaded === null) throw new Error('the fixture front controller is missing from the work tree');
  fixtureTree = loaded;
  extraction = await extractRoutes(tree, { index: indexFor(tree), overrides: OVERRIDES, variants: VARIANTS, fixtureTree });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('routes constants', () => {
  it('map fixture modules to services, families to request modes and OAuth endpoints to entry ids', () => {
    expect(FIXTURE_SERVICES).toEqual({
      people: 'people',
      timesheets: 'timesheets',
      finance: 'finance',
      surveys: 'surveys',
      reporting: 'reporting',
      communications: 'communications',
      esignature: 'e-signature',
    });
    expect(FAMILY_MODES).toEqual({ api: 'json', rest: 'rest' });
    expect(OAUTH_IDS).toEqual({ oauth: 'rte:/oauth', oauth2: 'rte:/oauth2', tokeninfo: 'rte:tokeninfo' });
    expect(RUNTIME_METHODS).toEqual({ swagger: 'bean-metadata' });
    expect(Object.keys(WEB_ROOT_COMPONENTS)).toEqual([FILEBROWSER]);
    expect([FIXTURE_PREFIX, API_AREA, SOAP_AREA, DECLARED_ENTITY_TABLES, PROGRAM_SCHEMA_FOLD]).toEqual([
      '/legacy-fixtures/cfml/api.cfm',
      'api',
      'soap:v1',
      'tentity-declared:*',
      'Program_N',
    ]);
    for (const table of [FIXTURE_SERVICES, FAMILY_MODES, OAUTH_IDS, RUNTIME_METHODS, WEB_ROOT_COMPONENTS]) expect(Object.isFrozen(table)).toBe(true);
  });

  it('list the handleAPIRequest families in legacy order, each frozen', () => {
    expect(FAMILY_TABLE.map((r) => [r.endpoint, r.family, r.kind, r.keyed, r.aliases, r.cases?.on ?? null, r.rendersCfml, r.webRootFilesystem])).toEqual([
      ['jsonendpoint', 'api', 'api-family', false, [], null, [], false],
      ['ajaxendpoint', 'api', 'api-family', false, [], null, [], false],
      ['restendpoint', 'rest', 'api-family', false, [], null, [], false],
      ['feedendpoint', 'feed', 'api-family', true, ['legacyfeedendpoint'], null, [], false],
      ['variationendpoint', 'variation', 'api-family', true, [], null, ['*'], false],
      ['emailendpoint', 'trackopen', 'api-family', true, [], null, [], false],
      ['fileendpoint', 'render', 'api-family', true, ['legacyfileendpoint'], 'url.size', [], false],
      ['sitemonitorendpoint', 'sitemonitor', 'job', true, [], null, [], false],
      ['legacywidgetendpoint', 'widgets', 'static', true, [], null, [], false],
      ['assetendpoint', 'asset', 'api-family', true, [], 'url.action', ['render'], true],
    ]);
    expect(Object.isFrozen(FAMILY_TABLE)).toBe(true);
    for (const row of FAMILY_TABLE) expect(Object.isFrozen(row)).toBe(true);
  });

  it.each([
    ['api:user.save{photo}', 'api:user'],
    ['REST:Content.findOne', 'api:content'],
    ['api:login', 'api:login'],
    ['fixture:people/persons/{id}/archive@post', 'fixture:people'],
    ['render:small', 'render'],
    ['sitemonitor', 'sitemonitor'],
  ])('areaKeyOf(%s) is %s', (key, area) => {
    expect(areaKeyOf(key)).toBe(area);
  });
});

describe('parseSessionlessPrefix', () => {
  it('reads the path prefix whose requests run without a session', () => {
    expect(parseSessionlessPrefix(tree)).toEqual({
      prefix: '/_api/rest/v1',
      source: src(APPLICATION_SETTINGS_PATH, lineWith(APPLICATION_SETTINGS, 'this.sessionManagement')),
    });
  });

  it.each([
    ['a prefix whose length differs from the left() count', "this.sessionManagement = !(left(cgi.path_info,12)=='/_api/rest/v1');"],
    ['no path-prefix assignment', 'this.sessionManagement = true;'],
  ])('rejects %s', (_name, line) => {
    const source = memorySourceTree({ [APPLICATION_SETTINGS_PATH]: lines('<cfscript>', line, '</cfscript>') });
    expect(() => parseSessionlessPrefix(source)).toThrow(`${APPLICATION_SETTINGS_PATH}: no this.sessionManagement path-prefix assignment`);
  });
});

describe('parseRouteFamilies', () => {
  it('reads one branch per family row with its endpoint values, aliases and switch cases', () => {
    const branches = parseRouteFamilies(tree);
    expect(branches.map((b) => [b.row.endpoint, b.method, b.endpoint, b.aliases, b.cases.map((c) => c.label)])).toEqual([
      ['jsonendpoint', 'handleAPIRequest', '/_api/json/v1', [], [null]],
      ['ajaxendpoint', 'handleAPIRequest', '/_api/ajax/v1', [], [null]],
      ['restendpoint', 'handleAPIRequest', '/_api/rest/v1', [], [null]],
      ['feedendpoint', 'handleAPIRequest', '/_api/feed/v1', ['/tasks/feed'], [null]],
      ['variationendpoint', 'handleAPIRequest', '/_api/resource/variation', [], [null]],
      ['emailendpoint', 'handleAPIRequest', '/_api/email/trackopen', [], [null]],
      ['fileendpoint', 'handleAPIRequest', '/_api/render/', ['/tasks/render/'], ['small', 'medium', 'file']],
      ['sitemonitorendpoint', 'handleAPIRequest', '/_api/sitemonitor', [], [null]],
      ['legacywidgetendpoint', 'handleAPIRequest', '/tasks/widgets/', [], [null]],
      ['assetendpoint', 'handleAPIRequest', '/_api/asset/', [], ['upload', 'render']],
    ]);
    const file = branches.find((b) => b.row.endpoint === 'fileendpoint');
    const small = cs('<cfcase value="small">');
    expect(file?.source).toEqual(src(CONTENT_SERVER_PATH, cs("isDefined('url.fileid')"), cs('eq sitemonitorendpoint>') - 1));
    expect(file?.cases.map((c) => c.source)).toEqual([
      src(CONTENT_SERVER_PATH, small, small + 2),
      src(CONTENT_SERVER_PATH, small + 3, small + 5),
      src(CONTENT_SERVER_PATH, small + 6, small + 8),
    ]);
    expect(branches[0]?.condition).toBe('left(arguments.path,len(jsonendpoint)) eq jsonendpoint');
  });

  it.each([
    ['an endpoint variable it tests but never declares', '\t<cfset var ajaxendpoint="/_api/ajax/v1">\n', '', 'handleAPIRequest declares no endpoint variable ajaxendpoint'],
    ['two branches testing one endpoint', 'len(ajaxendpoint)) eq ajaxendpoint>', 'len(ajaxendpoint)) eq jsonendpoint>', '2 handleAPIRequest branches test jsonendpoint, expected 1'],
    [
      'no branch for a family',
      "isDefined('url.emailid') and left(arguments.path,len(emailendpoint)) eq emailendpoint>",
      "isDefined('url.emailid') and left(arguments.path,len(mailendpoint)) eq mailendpoint>",
      '0 handleAPIRequest branches test emailendpoint, expected 1',
    ],
    [
      'an alias its branch does not test',
      ' or left(arguments.path,len(legacyfeedendpoint)) eq legacyfeedendpoint)>',
      ')>',
      'the feedendpoint branch does not test legacyfeedendpoint',
    ],
    ['a switch on another expression', '<cfswitch expression="#url.size#">', '<cfswitch expression="#url.width#">', 'the fileendpoint branch has no <cfswitch> on url.size'],
    [
      'a branch no family row serves',
      '\t\t</cfswitch>\n\t</cfif>',
      '\t\t</cfswitch>\n\t<cfelseif left(arguments.path,6) eq "/_api/">\n\t\t<cfreturn "">\n\t</cfif>',
      `handleAPIRequest branches at lines ${CONTENT_SERVER.split('\n').lastIndexOf('\t</cfif>') + 1} serve no family row`,
    ],
    ['an unterminated branch chain', '\t\t</cfswitch>\n\t</cfif>', '\t\t</cfswitch>', 'unterminated <cfif> chain at offset'],
    ['an unterminated switch case', "renderFile(url.fileid)>\n\t\t\t</cfdefaultcase>", 'renderFile(url.fileid)>', 'unterminated <cfdefaultcase> at offset'],
  ])('rejects %s', (_name, from, to, message) => {
    const source = memorySourceTree({ [CONTENT_SERVER_PATH]: replaceOnce(CONTENT_SERVER, from, to) });
    expect(() => parseRouteFamilies(source)).toThrow(message);
  });
});

describe('parseJsonApi and assertPinnedRegistry', () => {
  it('read publicMethods, the registered and config entities, the alias, the verb dispatch and the self-save re-login', () => {
    const reg = parseJsonApi(tree);
    const publicLine = ja('publicMethods = "');
    expect(reg.publicMethods).toEqual([...PUBLIC_METHODS]);
    expect(reg.publicMethodsSource).toEqual(src(JSON_API_PATH, publicLine));
    expect(reg.entities.map((e) => [e.name, e.via, e.config, e.source.lines[0]])).toEqual([
      [CONTENTNAV_ENTITY, 'config', null, ja("'contentnav' = {")],
      ...REGISTERED_ENTITIES.map((name) => [name, 'registerEntity', null, ja(`registerEntity('${name}',`)]),
      [VARIATION_ENTITY, 'registerEntity', 'variations', ja(`registerEntity('${VARIATION_ENTITY}',`)],
    ]);
    expect(reg.entities.at(-1)?.condition).toBe("getBean('configBean').getValue(property='variations', defaultValue=false)");
    expect(reg.entities.slice(0, -1).every((e) => e.condition === null)).toBe(true);
    expect(reg.aliases).toEqual({ contentnav: 'content' });
    expect(reg.verbs).toEqual({ findone: ['GET'], save: ['POST', 'PUT'], delete: ['DELETE'] });
    expect(reg.defaultMode).toBe('json');
    const relogin = ja("request.muraAPIRequestMode == 'json'");
    expect(reg.selfSave).toMatchObject({ mode: 'json', entityName: 'user', source: src(JSON_API_PATH, relogin, relogin + 2) });
    expect([reg.declared.has('submitform'), reg.declared.has('swagger'), reg.declared.has('getoauthtokeninfo')]).toEqual([false, true, true]);
    expect(() => assertPinnedRegistry(reg)).not.toThrow();
  });

  it('assertPinnedRegistry names every difference from the pinned JSON API', () => {
    const reg = parseJsonApi(tree);
    const changed: JsonApiRegistry = {
      ...reg,
      publicMethods: reg.publicMethods.filter((m) => m !== 'save'),
      entities: reg.entities.filter((e) => e.name !== 'stats' && e.name !== VARIATION_ENTITY && e.name !== CONTENTNAV_ENTITY),
      aliases: {},
    };
    let message = '';
    try {
      assertPinnedRegistry(changed);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.split('\n')).toEqual([
      `${JSON_API_PATH} differs from the pinned JSON API:`,
      `- unconditional registerEntity: parsed [${REGISTERED_ENTITIES.filter((e) => e !== 'stats').join(', ')}], platform [${REGISTERED_ENTITIES.join(', ')}]`,
      `- conditional registerEntity: parsed [], platform [${VARIATION_ENTITY}]`,
      `- config entities: parsed [], platform [${CONTENTNAV_ENTITY}]`,
      `- publicMethods: parsed [${PUBLIC_METHODS.filter((m) => m !== 'save').join(', ')}], platform [${PUBLIC_METHODS.join(', ')}]`,
      '- generic methods missing from publicMethods: save',
      `- processRequest maps no alias for ${CONTENTNAV_ENTITY}`,
    ]);
  });

  it('reports a publicMethods name the platform list lacks instead of keying it', async () => {
    const listed = `publicMethods = "${PUBLIC_METHOD_LIST}"`;
    const source = archiveTree({ [JSON_API_PATH]: replaceOnce(JSON_API, listed, `publicMethods = "${PUBLIC_METHOD_LIST},bogusMethod"`) });
    const reg = parseJsonApi(source);
    expect(reg.publicMethods.at(-1)).toBe('bogusMethod');
    expect(PUBLIC_METHODS).not.toContain('bogusMethod');
    const finding = `- publicMethods: parsed [${[...PUBLIC_METHODS, 'bogusMethod'].join(', ')}], platform [${PUBLIC_METHODS.join(', ')}]`;
    expect(() => assertPinnedRegistry(reg)).toThrow(finding);
    await expect(extractFrom(source)).rejects.toThrow(finding);
  });

  it.each([
    ['no publicMethods list', `publicMethods = "${PUBLIC_METHOD_LIST}"`, `methods = "${PUBLIC_METHOD_LIST}"`, 'init sets no publicMethods'],
    ['no request-mode default', 'param name="request.muraAPIRequestMode" default="json";', 'param name="request.mode" default="json";', 'processRequest sets no request.muraAPIRequestMode default'],
    ['no entity-route switch', '\t\tswitch (method) {', '\t\tswitch (lcase(method)) {', 'processRequest has no switch(method) entity-route dispatch'],
  ])('parseJsonApi rejects %s', (_name, from, to, message) => {
    const source = memorySourceTree({ [JSON_API_PATH]: replaceOnce(JSON_API, from, to) });
    expect(() => parseJsonApi(source)).toThrow(`${JSON_API_PATH}: ${message}`);
  });
});

describe('parseOAuth', () => {
  it('reads the Bearer and grant blocks, the grant endpoints and the token-info method', () => {
    const bearer = ja("if (isDefined('params.access_token')) {");
    const grant = lineIs(JSON_API, '\t\t\t} else {');
    expect(parseOAuth(tree)).toMatchObject({
      bearerSource: src(JSON_API_PATH, bearer, ja("} else if (isDefined('params.client_id')")),
      grantSource: src(JSON_API_PATH, grant, grant + 5),
      endpoints: ['oauth', 'oauth2'],
      tokenInfo: { segment: 'tokeninfo', method: 'getOAuthTokenInfo', source: src(JSON_API_PATH, ...fnLines(JSON_API, 'function getOAuthTokenInfo(')) },
    });
  });

  it.each([
    ['no REST credential block', '\t\tif (!request.muraSessionManagement) {', '\t\tif (request.muraSessionManagement) {', 'REST credential block'],
    ['no Bearer token block', "if (isDefined('params.access_token')) {", "if (isDefined('params.token')) {", 'Bearer token block'],
    ['no final grant clause', '\t\t\t} else {\n', "\t\t\t} else if (isDefined('params.grant_type')) {\n", 'Bearer … else grant chain'],
    ['no grant endpoint test', "listFind('oauth,oauth2', pathInfo[4])", "listFindNoCase('oauth,oauth2', pathInfo[4])", 'oauth endpoint test in the grant block'],
    ['no token-info path test', "pathInfo[4] == 'tokeninfo'", "pathInfo[4] eq 'tokeninfo'", 'token-info path test'],
    ['no token-info call', 'return getOAuthTokenInfo(params.access_token);', 'return getOAuthInfo(params.access_token);', 'token-info call'],
  ])('rejects %s', (_name, from, to, what) => {
    const source = memorySourceTree({ [JSON_API_PATH]: replaceOnce(JSON_API, from, to) });
    expect(() => parseOAuth(source)).toThrow(`${JSON_API_PATH}: processRequest has no ${what}`);
  });
});

describe('extractRoutes over the archive excerpt', () => {
  it('builds every kind of entry once, sorted by id, with the fixture routes present', () => {
    const ids = extraction.routes.map((r) => r.id);
    expect(extraction.counts).toEqual({ families: 13, apiEntityMethods: 333, apiMethods: 34, oauth: 3, soap: 2, fixture: 14 });
    expect(countRoutes(extraction.routes)).toEqual(extraction.counts);
    expect(ids).toHaveLength(399);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ids);
    expect(extraction.fixtureRoutesStatus).toBe('present');
  });

  it('keys every keyed entry exactly as inventoryRouteKey keys the entry point it stands for', async () => {
    const keyed = extraction.routes.filter((r) => r.routeKey !== null && r.reachable);
    expect(keyed).toHaveLength(392);
    for (const e of keyed) {
      const { point, options } = entryPointOf(e);
      expect((await inventoryRouteKey(point, options)).key, e.id).toBe(e.routeKey);
    }
    for (const e of extraction.routes.filter((r) => r.kind === 'api-method' && !r.reachable)) {
      const { point, options } = entryPointOf(e);
      expect((await inventoryRouteKey(point, options)).key).toBe(e.keyedAs);
      expect(e.routeKey).toBe(`${e.family}:${(e.method ?? '').toLowerCase()}`);
    }
  });

  it.each(FAMILY_POINTS)('keys %s as the platform grammar names it', async (id, point, options, key) => {
    expect(entryOf(id).routeKey).toBe(key);
    expect((await inventoryRouteKey(point, { ...KEY_OPTIONS, ...options })).key).toBe(key);
  });

  it('leaves only the API umbrella families and the SOAP components unkeyed', () => {
    expect(extraction.routes.filter((r) => r.routeKey === null).map((r) => [r.id, r.kind, r.areaKey])).toEqual([
      ['rte:/_api/ajax/v1', 'api-family', 'api'],
      ['rte:/_api/json/v1', 'api-family', 'api'],
      ['rte:/_api/rest/v1', 'api-family', 'api'],
      ['rte:soap:feed', 'soap', 'soap:v1'],
      ['rte:soap:user', 'soap', 'soap:v1'],
    ]);
  });

  it('sets owners and dispositions only on fixture routes', () => {
    for (const r of extraction.routes) {
      const fixture = r.kind === 'fixture';
      expect([r.owningService !== null, r.disposition !== null, r.dispositionStep !== null, r.liveStatus !== null], r.id).toEqual([fixture, fixture, fixture, fixture]);
    }
  });
});

describe('handleAPIRequest family entries', () => {
  it('record the JSON API umbrella families with their guards, site resolution and per-method write facts', () => {
    expect(entryOf('rte:/_api/json/v1')).toMatchObject({
      kind: 'api-family',
      family: 'api',
      source: src(CONTENT_SERVER_PATH, cs('eq jsonendpoint>'), cs('eq ajaxendpoint>') - 1),
      condition: 'left(arguments.path,len(jsonendpoint)) eq jsonendpoint',
      siteResolution: {
        pathSegment: 4,
        scopes: ['form.siteid', 'url.siteid'],
        fallback: 'default',
        source: src(CONTENT_SERVER_PATH, cs("listGetAt(arguments.path,4,'/')"), cs('siteExists(siteid)')),
      },
      sessionless: false,
      conditional: null,
      writeFacts: 'per-method',
      roots: [],
      csrfValidation: null,
    });
    expect(entryOf('rte:/_api/ajax/v1')).toMatchObject({ siteResolution: null, sessionless: false, writeFacts: 'per-method' });
    expect(entryOf('rte:/_api/rest/v1')).toMatchObject({
      family: 'rest',
      sessionless: true,
      conditional: `REST mode is sessionless (${APPLICATION_SETTINGS_PATH}:${lineWith(APPLICATION_SETTINGS, 'this.sessionManagement')})`,
      siteResolution: { pathSegment: null, scopes: ['url.siteid'], fallback: null },
      writeFacts: 'per-method',
    });
  });

  it('key the feed family once for its legacy alias and walk the feed API that getApi binds', () => {
    expect(entryOf('rte:/_api/feed/v1')).toMatchObject({
      legacyAliases: ['/tasks/feed'],
      requires: ['url.feedid'],
      config: [],
      writeFacts: 'closure',
      roots: [`${CONTENT_SERVER_PATH}#handleAPIRequest[keep:${cs("isDefined('url.feedid')")}-${cs("property='variations'")}]`, `${FEED_API}#processRequest`],
      writeSet: [],
      csrfValidation: 'none',
    });
  });

  it('split the render family per size case, each under its /tasks/render alias', () => {
    const small = cs('<cfcase value="small">');
    for (const [size, at] of [['small', small], ['medium', small + 3], ['file', small + 6]] as const) {
      expect(entryOf(`rte:/_api/render/${size}`)).toMatchObject({
        routeKey: `render:${size}`,
        source: src(CONTENT_SERVER_PATH, at, at + 2),
        branch: src(CONTENT_SERVER_PATH, cs("isDefined('url.fileid')"), cs('eq sitemonitorendpoint>') - 1),
        legacyAliases: [`/tasks/render/${size}/`],
        requires: ['url.fileid'],
        roots: [`${CONTENT_SERVER_PATH}#handleAPIRequest[keep:${at}-${at + 2}]`],
        rendersCfml: false,
        writeSet: [],
      });
    }
  });

  it('record the variation family as config-gated and rendered through its executor template', () => {
    expect(entryOf('rte:/_api/resource/variation')).toMatchObject({
      requires: ['url.siteid'],
      config: ['variations'],
      conditional: 'only when the variations config is on',
      rendersCfml: true,
      rendersCfmlEvidence: src(VARIATION_TEMPLATE, 2),
      roots: [`${CONTENT_SERVER_PATH}#handleAPIRequest[keep:${cs("property='variations'")}-${cs("isDefined('url.emailid')")}]`, `${VARIATION_TEMPLATE}#`],
    });
  });

  it('walk the open-tracking branch to the table its manager writes', () => {
    expect(entryOf('rte:/_api/email/trackopen')).toMatchObject({ requires: ['url.emailid'], writeSet: ['temailstats'], writeFacts: 'closure', sessionEffects: 'none' });
  });

  it('mark the site monitor as a job whose write facts are its scheduled steps', () => {
    expect(entryOf('rte:/_api/sitemonitor')).toMatchObject({
      kind: 'job',
      jobRef: 'job:sitemonitor',
      conditional: 'steps are listed under scheduledJobs[]',
      writeFacts: 'scheduled-jobs',
      writeSet: [],
      roots: [],
      csrfValidation: 'none',
    });
  });

  it('record the widgets family as a static redirect to the vendor directory', () => {
    expect(entryOf('rte:/tasks/widgets')).toMatchObject({ kind: 'static', redirect: { statusCode: 301, from: '/tasks/widgets/', to: '/core/vendor/' }, writeSet: [] });
  });

  it('split the asset family into a permission-guarded upload that writes the file store and a CFML-rendered render', () => {
    const upload = cs('<cfcase value="upload">');
    expect(entryOf('rte:/_api/asset/upload')).toMatchObject({
      source: src(CONTENT_SERVER_PATH, upload, upload + 4),
      modulePermissions: [MODULE_PERM],
      webRootFilesystem: true,
      rendersCfml: false,
      writeSet: ['tfiles'],
      fileStoreWrite: true,
      conditionalWrites: [{ table: 'tfiles', condition: `getBean('permUtility').getModulePerm('${MODULE_PERM}',url.siteid)` }],
    });
    expect(entryOf('rte:/_api/asset/render')).toMatchObject({
      source: src(CONTENT_SERVER_PATH, upload + 5, upload + 7),
      rendersCfml: true,
      rendersCfmlEvidence: src(CONTENT_SERVER_PATH, upload + 5, upload + 7),
      webRootFilesystem: true,
      writeSet: [],
    });
  });

  it.each([
    ['rte:/_api/feed/v1', 'carry', 5, 'strategies-content'],
    ['rte:/_api/render/small', 'carry', 5, 'strategies-content'],
    ['rte:/_api/sitemonitor', 'carry', 5, 'programs-sites'],
    ['rte:/_api/email/trackopen', 'legacy-served', 4, 'communications'],
    ['rte:/_api/asset/upload', 'legacy-served', 4, 'strategies-content'],
    ['rte:/_api/asset/render', 'legacy-served', 4, 'strategies-content'],
    ['rte:/tasks/widgets', 'legacy-served', 4, null],
    ['rte:/_api/resource/variation', 'legacy-served', 4, 'strategies-content'],
  ])('give %s the facts the disposition rule decides as %s', (id, disposition, step, owningService) => {
    expect(decide(factsOf(entryOf(id)), DISPOSITION_CONTEXT)).toMatchObject({ disposition, dispositionStep: step, owningService });
  });

  it('let the rule serve the CFML-rendering variation script on legacy, keeping the expected carry as a correction', () => {
    expect(decide(factsOf(entryOf('rte:/_api/resource/variation')), DISPOSITION_CONTEXT).correction).toMatchObject({
      expected: { disposition: 'carry' },
      computed: { disposition: 'legacy-served', owningService: 'strategies-content' },
      basis: 'renders CFML through the theme and display-object runtime',
    });
  });
});

describe('JSON API entity and method entries', () => {
  it('cross every served entity with every generic method in both families', () => {
    const names = [CONTENTNAV_ENTITY, ...REGISTERED_ENTITIES, VARIATION_ENTITY];
    const verbs: Readonly<Record<string, string[]>> = { findone: ['GET'], save: ['POST', 'PUT'], delete: ['DELETE'] };
    for (const family of ['api', 'rest'] as const) {
      for (const entity of names) {
        for (const method of GENERIC_METHODS) {
          expect(entryOf(`${family}:${entity.toLowerCase()}.${method.toLowerCase()}`)).toMatchObject({
            kind: 'api-entity-method',
            family,
            entity,
            method,
            httpMethods: verbs[method.toLowerCase()] ?? [],
            sessionless: family === 'rest',
            source: src(JSON_API_PATH, ...fnLines(JSON_API, `function ${method}(`)),
            areaKey: `api:${entity.toLowerCase()}`,
            precedence: 0,
            predicate: null,
          });
        }
      }
    }
  });

  it('keys entity-generic methods as <entity>.<method>, so saves of different entities never share a key', () => {
    const keys = ['api:content.findone', 'api:user.save', 'api:user.delete', 'api:group.save', 'api:content.save'];
    expect(keys.map((id) => entryOf(id).routeKey)).toEqual(keys);
    expect(entryOf('api:user.save').routeKey).not.toBe(entryOf('api:content.save').routeKey);
  });

  it.each(['login', 'logout', 'generateCSRFTokens', 'processAsyncObject', 'swagger'])('keys the non-generic public method %s by its name', (name) => {
    const key = `api:${name.toLowerCase()}`;
    expect(PUBLIC_METHODS).toContain(name);
    expect(entryOf(key)).toMatchObject({ kind: 'api-method', routeKey: key, method: name, entity: null, reachable: true });
  });

  it('bind persistence calls on the addressed entity to its component, or note why they cannot run', () => {
    const saveLine = ja('entity.set(form).save();');
    expect(entryOf('api:file.save')).toMatchObject({
      writeSet: ['tfiles'],
      closureEvidence: [{ table: 'tfiles', op: 'save', component: FILE_BEAN, method: 'save', source: src(JSON_API_PATH, saveLine), trigger: 'request', whereParams: [], conditional: false }],
      conditional: null,
    });
    expect(entryOf('api:file.delete').writeSet).toEqual(['tfiles']);
    const relogin = ja("request.muraAPIRequestMode == 'json'");
    expect(entryOf('api:contentnav.save')).toMatchObject({
      writeSet: ['tcontent'],
      roots: [`${JSON_API_PATH}#save[drop:${relogin}-${relogin + 2}]`, `${CONTENT_BEAN}#save`],
    });
    expect(entryOf('api:site.save')).toMatchObject({ conditional: 'settingsBean defines no save; the call raises an error', writeSet: [] });
    expect(entryOf('api:comment.save').conditional).toBe('no bean is registered as comment');
    expect(entryOf('rest:variationtargeting.findone').conditional).toBe('registered only when the variations config is on; no bean is registered as variationTargeting');
    expect(entryOf('api:site.findone').conditional).toBeNull();
  });

  it('report only the unresolved calls that are not on the addressed entity', () => {
    expect(entryOf('api:user.save').unresolved.map((u) => u.expr)).toEqual(['$.validateCSRFTokens', "getBean('$').init"]);
    expect(entryOf('api:user.findquery').unresolved.map((u) => u.expr)).toEqual([]);
  });

  it('give a JSON-mode save of the user entity the re-login the self-save branch makes', () => {
    const relogin = ja("request.muraAPIRequestMode == 'json'");
    const span = `${relogin}-${relogin + 2}`;
    expect(entryOf('api:user.save')).toMatchObject({
      sessionEffects: 'relogin',
      writeSet: ['tusers'],
      roots: [`${JSON_API_PATH}#save[drop:${span}]`, `${JSON_API_PATH}#save[keep:${span}]`, `${USER_BEAN}#save`],
    });
    expect(entryOf('rest:user.save')).toMatchObject({ sessionEffects: 'none', roots: [`${JSON_API_PATH}#save[drop:${span}]`, `${USER_BEAN}#save`] });
    expect(entryOf('api:content.save').sessionEffects).toBe('none');
  });

  it('read CSRF validation, its session bypass and the renderer gate from the method itself', () => {
    expect(entryOf('api:user.save')).toMatchObject({ csrfContext: 'arguments.id', csrfValidation: 'validates', csrfGate: null });
    expect(entryOf('rest:user.save')).toMatchObject({ csrfContext: 'arguments.id', csrfValidation: 'bypassed', csrfGate: null });
    expect(entryOf('rest:user.delete')).toMatchObject({ csrfContext: 'arguments.id', csrfValidation: 'validates', csrfGate: '$.getContentRenderer().validateCSRFTokens' });
    expect(entryOf('api:user.findone')).toMatchObject({ csrfContext: null, csrfValidation: 'none', csrfGate: null });
  });

  it('apply a writer override on the entry function only to the route keys it names', () => {
    const deleteLine = ja('function delete(');
    expect(entryOf('api:user.delete')).toMatchObject({
      writeSet: ['tusers', 'tusersmemb'],
      overrides: ['wov:user-delete-memberships'],
      unresolved: [],
    });
    expect(entryOf('api:user.delete').closureEvidence).toContainEqual({
      table: 'tusersmemb',
      op: 'delete',
      component: JSON_API_PATH,
      method: 'delete',
      source: src(JSON_API_PATH, deleteLine),
      trigger: 'request',
      whereParams: ['userid'],
      conditional: false,
      override: 'wov:user-delete-memberships',
    });
    expect(entryOf('rest:user.delete').overrides).toEqual(['wov:user-delete-memberships']);
    expect(entryOf('api:site.delete')).toMatchObject({ writeSet: [], overrides: [] });
  });

  it('add one entry per declared variant, in declaration order, each keyed by a request that selects it', () => {
    expect(['api:site.save', 'api:site.save{delete}', 'api:site.save{add}'].map((id) => [entryOf(id).precedence, entryOf(id).predicate])).toEqual([
      [0, null],
      [1, { variant: 'delete', when: [{ param: 'action', equals: 'Delete' }] }],
      [2, { variant: 'add', when: [{ param: 'action', in: ['Add', 'Copy'] }] }],
    ]);
    expect(entryOf('api:user.save{photo}')).toMatchObject({ precedence: 1, predicate: { variant: 'photo', when: [PHOTO_CONDITION] }, writeSet: ['tusers'], sessionEffects: 'relogin' });
    expect(entryOf('rest:content.save{image}')).toMatchObject({ precedence: 1, predicate: { variant: 'image', when: [IMAGE_UPLOAD_CONDITION] }, sessionless: true });
    expect(entryOf('rest:user.save{roster}').predicate?.variant).toBe('roster');
    expect(entryOf('api:group.save{removephoto}').predicate?.variant).toBe('removephoto');
    expect(entryOf('api:group.delete{typed}').predicate?.variant).toBe('typed');
    expect(extraction.routes.filter((r) => r.precedence > 0)).toHaveLength(9);
  });

  it('key a publicMethods name without a function as unreachable under the key the platform gives it', () => {
    const publicLine = ja('publicMethods = "');
    for (const family of ['api', 'rest'] as const) {
      expect(entryOf(`${family}:submitform`)).toMatchObject({
        kind: 'api-method',
        routeKey: `${family}:submitform`,
        keyedAs: `${family}:entity.findquery`,
        source: src(JSON_API_PATH, publicLine),
        reachable: false,
        reason: `listed in publicMethods but jsonApiUtility defines no submitForm function, so the request keys to ${family}:entity.findquery`,
        csrfValidation: 'none',
        writeFacts: 'none',
      });
    }
  });

  it('carry the session effects and CSRF facts the login and logout methods reach', () => {
    expect(entryOf('api:login')).toMatchObject({ sessionEffects: 'login', csrfContext: 'login', csrfValidation: 'validates', writeSet: ['tusers'], roots: [`${JSON_API_PATH}#login`] });
    expect(entryOf('api:logout')).toMatchObject({ sessionEffects: 'logout', csrfContext: 'logout', csrfValidation: 'bypassed', csrfGate: null, writeSet: [] });
  });

  it('resolve bare-identifier and struct-field CSRF contexts to the expressions assigned to them', () => {
    expect(entryOf('api:validateemail')).toMatchObject({ csrfContext: "arguments.email & 'check'", csrfValidation: 'validates' });
    expect(entryOf('api:findcalendaritems')).toMatchObject({ csrfContext: 'calendarid', csrfValidation: 'validates' });
  });

  it('mark swagger as runtime bean metadata and processAsyncObject as CFML-rendered', () => {
    const render = ja('return $.dspObject(object=arguments.object);');
    expect(entryOf('api:swagger')).toMatchObject({ rendersCfml: true, rendersCfmlEvidence: src(JSON_API_PATH, ja('function swagger(')), runtimeCategory: 'bean-metadata' });
    expect(entryOf('rest:processasyncobject')).toMatchObject({
      rendersCfml: true,
      rendersCfmlEvidence: src(JSON_API_PATH, render),
      runtimeCategory: null,
      writeSet: [],
      roots: [`${JSON_API_PATH}#processAsyncObject`],
      csrfContext: "event('formid')",
      csrfValidation: 'validates',
    });
  });

  it('walk the display-object branches a processAsyncObject variant opens, first declaration first', () => {
    const open = lineIs(textOf(ARCHIVE, FORM_TEMPLATE), "<cfif len(event('saveform'))>");
    const formRoot = `${FORM_TEMPLATE}#[keep:${open}-${open + 6}]`;
    for (const [id, precedence] of [['api:processasyncobject{formobject}', 1], ['api:processasyncobject{saveform}', 2]] as const) {
      expect(entryOf(id)).toMatchObject({ precedence, writeSet: ['tformresponsepackets'], roots: [`${JSON_API_PATH}#processAsyncObject`, formRoot], csrfContext: "event('formid')" });
    }
    expect(entryOf('api:processasyncobject{formobject}').predicate).toEqual({ variant: 'formobject', when: [SAVEFORM_CONDITION, { param: 'object', equals: 'form' }] });
    expect(entryOf('api:processasyncobject')).toMatchObject({ writeSet: [], roots: [`${JSON_API_PATH}#processAsyncObject`] });
  });

  it('bind getServiceFactory() calls to the start-up bean factory and record schema checks on declared entities', () => {
    expect(entryOf('api:declareentity')).toMatchObject({ writeSet: ['tentity'], roots: [`${JSON_API_PATH}#declareEntity`, `${BEAN_FACTORY}#declareEntity`] });
    expect(entryOf('rest:undeclareentity')).toMatchObject({ writeSet: ['tentity'], roots: [`${JSON_API_PATH}#undeclareEntity`, `${BEAN_FACTORY}#undeclareEntity`] });
    const check = ja('getBean(arguments.entityName).checkSchema();');
    expect(entryOf('api:checkschema')).toMatchObject({
      writeSet: [DECLARED_ENTITY_TABLES],
      closureEvidence: [
        { table: DECLARED_ENTITY_TABLES, op: 'update', component: JSON_API_PATH, method: 'checkSchema', source: src(JSON_API_PATH, check), trigger: 'request', whereParams: [], conditional: false, dynamic: true },
      ],
    });
  });

  it.each([
    ['api:site.findone', 'carry', 5, 'programs-sites'],
    ['api:contentnav.findall', 'carry', 5, 'strategies-content'],
    ['api:group.findone', 'carry', 5, 'identity'],
    ['rest:user.findone', 'carry', 5, 'people'],
    ['api:findcurrentuser', 'carry', 5, 'identity'],
    ['rest:generatecsrftokens', 'carry', 5, 'identity'],
    ['rte:tokeninfo', 'carry', 5, 'identity'],
    ['api:processasyncobject', 'legacy-served', 4, 'strategies-content'],
    ['api:swagger', 'legacy-served', 4, null],
    ['api:submitform', 'retired', 1, 'strategies-content'],
  ])('give read-only entry %s the facts the disposition rule decides as %s', (id, disposition, step, owningService) => {
    expect(decide(factsOf(entryOf(id)), DISPOSITION_CONTEXT)).toMatchObject({ disposition, dispositionStep: step, owningService, legacyWrite: false });
  });

  it('let the rule retire the undeclared submitForm, keeping the expected carry as a correction', () => {
    expect(decide(factsOf(entryOf('api:submitform')), DISPOSITION_CONTEXT).correction).toMatchObject({
      expected: { disposition: 'carry' },
      computed: { disposition: 'retired' },
      basis: 'unreachable over HTTP or the scheduler at the pinned SHA',
    });
  });

  it('add remote-function routes for the start-up and module entities that inherit the bean base', () => {
    const remote = extraction.routes.filter((r) => r.id.includes('.~')).map((r) => [r.id, r.entity, r.method, r.conditional, r.webRootFilesystem, r.writeSet]);
    expect(remote).toEqual([
      ['api:collection.~render', 'collection', 'render', 'registered when the core collection module model loads', false, []],
      ['api:feed.~getremotefeed', 'feed', 'getRemoteFeed', 'remote function registered in application.objectMappings', false, ['tcontentfeeds']],
      ['api:filebrowser.~browse', 'filebrowser', 'browse', 'registered when the core filebrowser module model loads', true, []],
      ['rest:collection.~render', 'collection', 'render', 'registered when the core collection module model loads', false, []],
      ['rest:feed.~getremotefeed', 'feed', 'getRemoteFeed', 'remote function registered in application.objectMappings', false, ['tcontentfeeds']],
      ['rest:filebrowser.~browse', 'filebrowser', 'browse', 'registered when the core filebrowser module model loads', true, []],
    ]);
    expect(entryOf('api:feed.~getremotefeed')).toMatchObject({
      source: src(FEED_BEAN, ...fnLines(textOf(ARCHIVE, FEED_BEAN), 'remote function getRemoteFeed(')),
      roots: [`${FEED_BEAN}#getRemoteFeed`],
      areaKey: 'api:feed',
    });
  });
});

describe('OAuth entries', () => {
  it('key the grant endpoints and token info through sessionless REST requests to their paths', () => {
    const grant = lineIs(JSON_API, '\t\t\t} else {');
    const bearer = ja("if (isDefined('params.access_token')) {");
    for (const [id, key] of [['rte:/oauth', 'rest:oauth'], ['rte:/oauth2', 'rest:oauth2']] as const) {
      expect(entryOf(id)).toMatchObject({
        kind: 'oauth',
        family: 'rest',
        routeKey: key,
        areaKey: `api:${key.slice(5)}`,
        source: src(JSON_API_PATH, grant, grant + 5),
        sessionless: true,
        roots: [`${JSON_API_PATH}#processRequest[keep:${grant}-${grant + 5}]`],
        writeSet: ['toauthtokens'],
        conditionalWrites: [{ table: 'toauthtokens', condition: "listFind('oauth,oauth2', pathInfo[4])" }],
      });
    }
    expect(entryOf('rte:tokeninfo')).toMatchObject({
      routeKey: 'rest:tokeninfo',
      source: src(JSON_API_PATH, ...fnLines(JSON_API, 'function getOAuthTokenInfo(')),
      roots: [`${JSON_API_PATH}#getOAuthTokenInfo`, `${JSON_API_PATH}#processRequest[keep:${bearer}-${bearer + 5}]`],
      writeSet: [],
      sessionless: true,
    });
  });
});

describe('SOAP v1 entries', () => {
  it('record each component as unreachable: not routed by handleAPIRequest and blocked by the core/mura guard', () => {
    const guardLines = guardText.trimEnd().split('\n').length;
    for (const file of [SOAP_FEED, SOAP_USER]) {
      const name = path.posix.basename(file, '.cfc');
      expect(entryOf(`rte:soap:${name}`)).toMatchObject({
        kind: 'soap',
        family: 'cfc',
        routeKey: null,
        source: src(file, 1, textOf(ARCHIVE, file).trimEnd().split('\n').length),
        reachable: false,
        reason: 'not routed by handleAPIRequest; blocked by core/mura directory guard',
        guard: `${MURA_GUARD}:2-${guardLines}`,
        areaKey: SOAP_AREA,
        writeFacts: 'none',
      });
    }
  });

  it('give the SOAP components the facts the disposition rule retires at step 1', () => {
    for (const id of ['rte:soap:feed', 'rte:soap:user']) {
      expect(decide(factsOf(entryOf(id)), DISPOSITION_CONTEXT)).toMatchObject({
        disposition: 'retired',
        dispositionStep: 1,
        basis: 'unreachable over HTTP or the scheduler at the pinned SHA',
        withheld: false,
        legacyWrite: false,
      });
    }
  });

  it('agree with isHttpReachable that the core/mura guard blocks direct requests to the SOAP components', () => {
    for (const file of [SOAP_USER, SOAP_FEED]) {
      expect(isHttpReachable(tree, file), file).toBe(false);
      expect(entryOf(`rte:soap:${path.posix.basename(file, '.cfc')}`).reachable, file).toBe(false);
    }
    expect(isHttpReachable(archiveTree({ [MURA_GUARD]: undefined }), SOAP_USER)).toBe(true);
  });

  it('retire the SOAP components at step 1 under the mini decision list, exceptions list and table ownership', async () => {
    const ctx: DispositionContext = {
      ownership: JSON.parse(await readFile(inventoryFixture('mini-table-ownership.json'), 'utf8')) as DispositionContext['ownership'],
      decisionList: await loadDecisionList(inventoryFixture('mini-decision-list.json')),
      exceptions: await loadExceptions(inventoryFixture('mini-exceptions-list.json')),
      findings: [],
    };
    expect(ctx.ownership.sourceSha).toBe(SHA);
    for (const id of ['rte:soap:feed', 'rte:soap:user']) {
      expect(decide(factsOf(entryOf(id)), ctx)).toMatchObject({ disposition: 'retired', dispositionStep: 1, owners: [], withheld: false, legacyWrite: false });
    }
    expect(ctx.findings).toEqual([]);
  });

  it.each([
    [
      'a guard that aborts only under a script condition',
      { [MURA_GUARD]: lines('component {', '\tfunction onRequestStart() {', '\t\tif (!isLocal()) {', '\t\t\tabort;', '\t\t}', '\t}', '}') },
      { reachable: true, reason: 'not routed by handleAPIRequest; no directory guard aborts it', guard: `${MURA_GUARD}:1-7` },
    ],
    [
      'a tag guard that aborts only under a cfif',
      { [MURA_GUARD]: lines('<cfcomponent>', '<cffunction name="onRequestStart">', '\t<cfif cgi.remote_addr neq "127.0.0.1"><cfabort></cfif>', '</cffunction>', '</cfcomponent>') },
      { reachable: true, reason: 'not routed by handleAPIRequest; no directory guard aborts it', guard: `${MURA_GUARD}:1-5` },
    ],
    [
      'a guard without onRequestStart',
      { [MURA_GUARD]: lines('component {', '\tthis.name = "mura";', '}') },
      { reachable: true, reason: 'not routed by handleAPIRequest; no directory guard aborts it', guard: `${MURA_GUARD}:1-3` },
    ],
    ['no guard at all', { [MURA_GUARD]: undefined }, { reachable: true, reason: 'not routed by handleAPIRequest; no directory guard aborts it', guard: null }],
    [
      'a root handler that routes the core segment',
      { [CONTENT_SERVER_PATH]: replaceOnce(CONTENT_SERVER, "listFindNoCase('_api,tasks',", "listFindNoCase('_api,tasks,core',") },
      { reachable: true, reason: 'routed by handleAPIRequest; blocked by core/mura directory guard' },
    ],
  ])('soapEntries reports %s', (_name, changes, expected) => {
    const entries = soapEntries(archiveTree(changes));
    expect(entries.map((e) => e.id)).toEqual(['rte:soap:feed', 'rte:soap:user']);
    for (const e of entries) expect(e).toMatchObject(expected);
  });

  it('soapEntries skips the SOAP directory Application.cfc and lets its guard win', () => {
    const guard = `${SOAP_DIR}/Application.cfc`;
    const entries = soapEntries(archiveTree({ [guard]: guardText }));
    expect(entries.map((e) => [e.id, e.guard])).toEqual([
      ['rte:soap:feed', `${guard}:2-${guardText.trimEnd().split('\n').length}`],
      ['rte:soap:user', `${guard}:2-${guardText.trimEnd().split('\n').length}`],
    ]);
  });

  it('soapEntries rejects a root handler that routes no segments to handleAPIRequest', () => {
    const source = archiveTree({ [CONTENT_SERVER_PATH]: replaceOnce(CONTENT_SERVER, "listFindNoCase('_api,tasks',listFirst(path,'/'))", 'true') });
    expect(() => soapEntries(source)).toThrow(`${CONTENT_SERVER_PATH}: handleRootRequest routes no path segments to handleAPIRequest`);
  });
});

const SURVEYS = 'legacy-fixtures/cfml/modules/surveys.cfc';

const SURVEY_CONTROLLER: FixtureController = { modules: ['surveys'], minSegments: 2, maxSegments: 4, modulePackage: 'modules', method: 'handle', helpers: {} };

/** A surveys module whose `handle` runs `body`. */
function surveysModule(...body: string[]): SourceTree {
  return memorySourceTree({
    [SURVEYS]: scriptCfc(
      '',
      '\tfunction init() {',
      "\t\tvariables.kinds = 'launch,reminder';",
      '\t\treturn this;',
      '\t}',
      '\tfunction handle(route) {',
      ...body.map((l) => `\t\t${l}`),
      '\t}',
      '\tfunction list(route) {',
      '\t\treturn [];',
      '\t}',
    ),
  });
}

describe('fixture routes', () => {
  it('parse the front controller: modules, segment grammar, module package, dispatch method and helpers', () => {
    expect(parseFixtureController(fixtureTree)).toEqual({
      modules: ['people', 'finance', 'reporting'],
      minSegments: 2,
      maxSegments: 5,
      modulePackage: 'modules',
      method: 'handle',
      helpers: { envelope: 'lib.envelope' },
    });
  });

  it.each([
    ['variables.fixtureModules list', 'variables.fixtureModules = "people,finance,reporting";', 'variables.modules = "people";'],
    ['segment-count grammar', 'variables.segmentCount >= 2 && variables.segmentCount <= 5', 'variables.segmentCount > 1'],
    ['module createObject', '"modules." & variables.route.module', 'variables.route.module'],
    ['module dispatch call', 'variables.module.handle(variables.route);', 'variables.module.handle(route = variables.route);'],
  ])('parseFixtureController rejects a controller with no %s', (what, from, to) => {
    const source = memorySourceTree({ [FIXTURE_API_PATH]: replaceOnce(textOf(FIXTURES, FIXTURE_API_PATH), from, to) });
    expect(() => parseFixtureController(source)).toThrow(`${FIXTURE_API_PATH}: no ${what}`);
  });

  it('evaluate a module dispatcher over every route its literals can form, per HTTP verb it names', () => {
    const controller = parseFixtureController(fixtureTree);
    expect(fixtureModuleRoutes(fixtureTree, controller, 'people')).toEqual([
      { module: 'people', segments: ['persons'], httpMethod: 'GET', handler: 'list', guards: [] },
      { module: 'people', segments: ['persons', SAMPLE_ID, 'archive'], httpMethod: 'GET', handler: 'archiveStatus', guards: ['gate'] },
      { module: 'people', segments: ['persons'], httpMethod: 'POST', handler: 'create', guards: [] },
      { module: 'people', segments: ['persons', SAMPLE_ID, 'archive'], httpMethod: 'POST', handler: 'archive', guards: ['gate'] },
    ]);
    expect(fixtureModuleRoutes(fixtureTree, controller, 'finance').map((r) => `${r.httpMethod} ${r.segments.join('/')} ${r.handler}`)).toEqual([
      'GET records listRecords',
      `GET records/${SAMPLE_ID} showRecord`,
      `GET records/${SAMPLE_ID}/attachments attachment`,
      `GET records/${SAMPLE_ID}/attachments/${SAMPLE_ID} attachment`,
      'GET rollups rollups',
      'POST records createRecord',
    ]);
  });

  it('model the CFScript a dispatcher uses: scopes, operators, switch fall-through, calls and literals', () => {
    const source = surveysModule(
      'var u = missing;',
      'var joined = route.resource & "/" & route.action;',
      'var unknownJoin = missing & "x";',
      'var chained = trim(route.id).len();',
      'var indexed = lcase(route.id)[1];',
      'var helped = variables.helper.ok(route);',
      'var kind = len(route.id) ? "one" : "many";',
      'var label = "export #route.id#";',
      'var hashes = "####";',
      'var opts = { a = 1 };',
      'var nums = [1, 2];',
      'local.flag = "1";',
      'var on = true;',
      'switch (route.resource) {',
      '\tcase "surveys":',
      '\tcase "polls":',
      '\t\tlocal.kind = "survey";',
      '}',
      'if (local.flag && on == "true" && joined != "" && kind != "") {',
      '\tif (route.resource == "surveys" && route.action == "" && route.httpMethod == "GET") return list(route = route);',
      '\tif (route.resource == "surveys" && listFindNoCase(variables.kinds, route.action) && route.httpMethod == "POST") {',
      '\t\treturn list(route, !check(route), audit(route) & note(route), len(route.id) ? one(route) : many(route));',
      '\t}',
      '}',
    );
    expect(fixtureModuleRoutes(source, SURVEY_CONTROLLER, 'surveys').map((r) => [r.httpMethod, r.segments.join('/'), r.handler, r.guards])).toEqual([
      ['GET', 'surveys', 'list', []],
      ['GET', `surveys/${SAMPLE_ID}`, 'list', []],
      ['POST', `surveys/${SAMPLE_ID}/launch`, 'list', ['check', 'audit', 'note', 'len', 'one', 'many']],
      ['POST', `surveys/${SAMPLE_ID}/reminder`, 'list', ['check', 'audit', 'note', 'len', 'one', 'many']],
    ]);
  });

  it.each([
    ['an unsupported statement', ['for (var i = 1; i <= 2; i++) {', '}'], /surveys\.cfc:\d+: unsupported for statement/],
    ['a switch label that is neither case nor default', ['switch (route.action) {', '\tother:', '}'], /surveys\.cfc:\d+: expected case or default/],
    ['an unclosed condition', ['if (route.id == "" return list(route);'], /surveys\.cfc:\d+: expected \)/],
    ['an assignment to a call', ['len(route.id) = 1;'], /surveys\.cfc:\d+: assignment to a non-variable/],
    ['an operator where a value belongs', ['return ,;'], /surveys\.cfc:\d+: unexpected ,/],
    ['an if with no statement', ['if (route.id == "")'], /surveys\.cfc:\d+: unexpected end of dispatcher/],
    ['a value it cannot know', ['if (route.params.x == "1") return list(route);'], /surveys\.cfc:\d+: the dispatcher depends on a value it cannot know/],
    ['a condition that is not a boolean', ['if (route.resource) return list(route);'], /surveys\.cfc:\d+: "opt2-unmatched" is not a boolean/],
    ['a branch returning something other than a handler call', ['return route.id;'], /surveys\.cfc: a dispatcher branch returns something other than a handler call/],
    ['a handler for any resource', ['return list(route);'], /surveys\.cfc: list accepts any resource \(GET\)/],
    ['a handler for any action', ['if (route.resource == "surveys") return list(route);'], /surveys\.cfc: list accepts any action \(GET\)/],
  ])('fixtureModuleRoutes rejects %s', (_name, body, message) => {
    const run = (): unknown => fixtureModuleRoutes(surveysModule(...body), SURVEY_CONTROLLER, 'surveys');
    expect(run).toThrow(message);
    expect(run).toThrow(expect.objectContaining({ name: 'FixtureDispatchError' }));
  });

  it('parse the fixture SQL: schema-qualified procedures with their writes and calls, and the per-program tables', () => {
    const go = (file: string, after: number): number => textOf(FIXTURES, file).split('\n').findIndex((l, i) => i >= after && l === 'GO') + 1;
    const rollup = lineWith(textOf(FIXTURES, FINANCE_SQL), 'CREATE PROCEDURE');
    const blackout = lineWith(textOf(FIXTURES, TIMESHEETS_SQL), 'CREATE OR ALTER PROCEDURE');
    expect(parseFixtureSql(fixtureTree)).toEqual({
      procedures: [
        { name: 'Program_N.usp_finance_rollup', source: src(FINANCE_SQL, rollup, go(FINANCE_SQL, rollup)), writes: ['Program_N.finance_rollup'], calls: ['synthetic.usp_audit_append'] },
        {
          name: 'synthetic.usp_audit_append',
          source: src(ESIGNATURE_SQL, 1, textOf(FIXTURES, ESIGNATURE_SQL).split('\n').length),
          writes: ['synthetic.audit_entry'],
          calls: ['synthetic.usp_person_archived_blackout'],
        },
        {
          name: 'synthetic.usp_person_archived_blackout',
          source: src(TIMESHEETS_SQL, blackout, go(TIMESHEETS_SQL, blackout)),
          writes: ['synthetic.timesheet_transition'],
          calls: ['synthetic.usp_audit_append'],
        },
      ],
      programTables: ['blackout', 'finance_record', 'finance_rollup'],
    });
    expect(parseFixtureSql(memorySourceTree({}))).toEqual({ procedures: [], programTables: [] });
  });

  it('parseFixtureSql rejects a procedure that is not schema-qualified', () => {
    const source = memorySourceTree({ 'legacy-fixtures/sql/bad.sql': lines('SELECT 1;', 'CREATE PROCEDURE usp_bare AS SELECT 1;', 'GO') });
    expect(() => parseFixtureSql(source)).toThrow('legacy-fixtures/sql/bad.sql:2: a fixture procedure must be schema-qualified');
  });

  it('carry every fixture route to its module service by definition, as the disposition rule does', () => {
    const fixtures = extraction.routes.filter((r) => r.kind === 'fixture');
    expect(fixtures.map((r) => r.id)).toEqual([
      'fix:finance/records/{id}/attachments/{id}@get',
      'fix:finance/records/{id}/attachments@get',
      'fix:finance/records/{id}@get',
      'fix:finance/records@get',
      'fix:finance/records@post',
      'fix:finance/rollups@get',
      'fix:people/persons/{id}/archive@get',
      'fix:people/persons/{id}/archive@post',
      'fix:people/persons@get',
      'fix:people/persons@post',
      'fix:reporting/exports/{id}/download@get',
      'fix:reporting/exports/{id}/file@get',
      'fix:reporting/exports/{id}@get',
      'fix:reporting/exports@post',
    ]);
    for (const r of fixtures) {
      const module = r.id.slice(4, r.id.indexOf('/'));
      expect(r, r.id).toMatchObject({
        family: 'fixture',
        routeKey: `fixture:${r.id.slice(4)}`,
        areaKey: `fixture:${module}`,
        fixtureModule: module,
        owningService: FIXTURE_SERVICES[module],
        disposition: 'carry',
        dispositionStep: 'fixture-definition',
        liveStatus: 'pending-run',
        httpMethods: [r.id.slice(r.id.lastIndexOf('@') + 1).toUpperCase()],
      });
      expect(decide(factsOf(r), DISPOSITION_CONTEXT)).toMatchObject({ disposition: 'carry', dispositionStep: 'fixture-definition', owningService: FIXTURE_SERVICES[module] });
    }
  });

  it('fold per-program and procedure writes into the write set, leaving other dynamic tables unresolved', () => {
    const createRecord = fnLines(textOf(FIXTURES, FINANCE), 'function createRecord(');
    const exec = lineWith(textOf(FIXTURES, FINANCE), 'usp_finance_rollup @recordId');
    expect(entryOf('fix:finance/records@post')).toMatchObject({
      method: 'createRecord',
      source: src(FINANCE, ...createRecord),
      roots: [`${FINANCE}#createRecord`],
      writeSet: ['Program_N.finance_record', 'Program_N.finance_rollup', 'synthetic.audit_entry', 'synthetic.timesheet_transition'],
      procedureCalls: [
        {
          procedure: '#arguments.schema#.usp_finance_rollup',
          source: src(FINANCE, exec),
          resolved: ['Program_N.usp_finance_rollup'],
          writes: ['Program_N.finance_rollup', 'synthetic.audit_entry', 'synthetic.timesheet_transition'],
        },
      ],
      unresolved: [{ expr: '[#arguments.schema#].finance_note', kind: 'table', source: src(FINANCE, lineWith(textOf(FIXTURES, FINANCE), 'finance_note')) }],
    });
    expect(entryOf('fix:people/persons/{id}/archive@post')).toMatchObject({
      writeSet: ['synthetic.audit_entry', 'synthetic.person_archive', 'synthetic.timesheet_transition'],
      procedureCalls: [{ procedure: 'synthetic.usp_person_archived_blackout', resolved: ['synthetic.usp_person_archived_blackout'] }],
    });
    expect(entryOf('fix:finance/records/{id}@get')).toMatchObject({ writeSet: [], procedureCalls: [], unresolved: [] });
  });

  it('read a guard function’s CSRF check per HTTP method and empty a context naming a segment the path lacks', () => {
    expect(entryOf('fix:people/persons/{id}/archive@post')).toMatchObject({
      roots: [`${PEOPLE}#archive`, `${PEOPLE}#gate`],
      csrfContext: 'route.id',
      csrfValidation: 'validates',
    });
    expect(entryOf('fix:people/persons/{id}/archive@get')).toMatchObject({ roots: [`${PEOPLE}#archiveStatus`, `${PEOPLE}#gate`], csrfContext: null, csrfValidation: 'none' });
    expect(entryOf('fix:finance/records@post')).toMatchObject({ csrfContext: '', csrfValidation: 'validates' });
  });

  it('note the functions that start and run a cfthread, and resolve unqualified procedure calls by name', () => {
    const thread = lineWith(textOf(FIXTURES, REPORTING), 'thread name=');
    expect(entryOf('fix:reporting/exports@post')).toMatchObject({
      conditional: 'writes in cfthread (startExport, runExport)',
      threads: [{ name: 'export#jobId#', component: REPORTING, method: 'startExport', source: src(REPORTING, thread, thread + 2) }],
      writeSet: ['synthetic.audit_entry', 'synthetic.export_job', 'synthetic.timesheet_transition'],
    });
    expect(entryOf('fix:reporting/exports@post').procedureCalls.map((c) => [c.procedure, c.resolved])).toEqual([
      ['dbo.usp_missing', []],
      ['usp_audit_append', ['synthetic.usp_audit_append']],
    ]);
    expect(entryOf('fix:reporting/exports/{id}@get').conditional).toBeNull();
  });

  it('load the fixture tree from a working tree, without SQL when it has none, and report it absent without the controller', async () => {
    expect(fixtureTree.list('legacy-fixtures', { recursive: true })).toEqual([...Object.keys(FIXTURES)].sort((a, b) => (a < b ? -1 : 1)));
    const bare = path.join(root, 'bare');
    await writeTree(bare, { [FIXTURE_API_PATH]: textOf(FIXTURES, FIXTURE_API_PATH), 'legacy-fixtures/cfml/notes.txt': 'not cfml\n' });
    expect(loadFixtureTree(bare)?.list('legacy-fixtures', { recursive: true })).toEqual([FIXTURE_API_PATH]);
    expect(loadFixtureTree(path.join(root, 'archive'))).toBeNull();
  });

  it('leave fixture routes out when no fixture tree is given', async () => {
    const result = await extractFrom(archiveTree({}));
    expect(result.fixtureRoutesStatus).toBe('absent');
    expect(result.counts.fixture).toBe(0);
    expect(result.routes.some((r) => r.id.startsWith('fix:'))).toBe(false);
    expect(result.routes).toHaveLength(extraction.routes.length - 14);
  });
});

const COLLIDING_FINANCE = scriptCfc(
  '',
  '\tfunction init() {',
  '\t\treturn this;',
  '\t}',
  '\tfunction handle(route) {',
  '\t\tif (route.resource == "records" && route.action == "777" && route.tail == "") return first(route);',
  '\t\tif (route.resource == "records" && route.action == "888" && route.tail == "") return second(route);',
  '\t}',
  '\tfunction first(route) {',
  '\t\treturn 1;',
  '\t}',
  '\tfunction second(route) {',
  '\t\treturn 2;',
  '\t}',
);

describe('extractRoutes errors', () => {
  it.each<[string, Readonly<Record<string, string | undefined>>, Partial<ExtractRoutesOptions>, string]>([
    ['a handler that is not a component', { [CONTENT_SERVER_PATH]: '<cfset x = 1>\n' }, {}, `${CONTENT_SERVER_PATH} is not a CFML component`],
    ['a handler without handleAPIRequest', { [CONTENT_SERVER_PATH]: replaceOnce(CONTENT_SERVER, 'name="handleAPIRequest"', 'name="handleRequest"') }, {}, `${CONTENT_SERVER_PATH} declares no function handleAPIRequest`],
    [
      'a REST branch that does not switch to REST mode',
      { [CONTENT_SERVER_PATH]: replaceOnce(CONTENT_SERVER, "request.muraAPIRequestMode='rest'", "request.muraAPIRequestMode='json'") },
      {},
      'JSON API request modes are json/json, expected json/rest',
    ],
    ['a registry that differs from the pinned one', { [JSON_API_PATH]: replaceOnce(JSON_API, "\t\tregisterEntity('stats', ", "\t\tregisterThing('stats', ") }, {}, 'differs from the pinned JSON API'],
    [
      'a getApi that instantiates no API component',
      { [SETTINGS_BEAN_PATH]: replaceOnce(SETTINGS_BEAN, 'new mura.client.api.', 'createObject("component", "x").') },
      {},
      `${SETTINGS_BEAN_PATH}: getApi instantiates no mura.client.api component`,
    ],
    ['a getApi target absent from the tree', { [FEED_API]: undefined }, {}, `${SETTINGS_BEAN_PATH}: getApi('feed','v1') names no component (mura.client.api.feed.v1.feedApiUtility)`],
    ['an executor template absent from the tree', { [VARIATION_TEMPLATE]: undefined }, {}, `${CONTENT_SERVER_PATH}: mura.executor runs /mura/client/api/resource/variation.js.cfm, absent from the tree`],
    [
      'an alias that keys differently',
      { [CONTENT_SERVER_PATH]: replaceOnce(CONTENT_SERVER, 'legacyfeedendpoint="/tasks/feed"', 'legacyfeedendpoint="/_api/feeds"') },
      {},
      `${CONTENT_SERVER_PATH}: /_api/feeds keys to apiother:/_api/feeds/, not feed:v1`,
    ],
    [
      'a start-up without the service factory',
      { [STARTUP_PATH]: lines('<cfscript>', 'variables.ready = true;', '</cfscript>') },
      {},
      `${STARTUP_PATH}: no variables.serviceFactory=new <component>(…) start-up assignment`,
    ],
    ['two switch cases with one label', { [CONTENT_SERVER_PATH]: replaceOnce(CONTENT_SERVER, '<cfcase value="medium">', '<cfcase value="small">') }, {}, 'two routes[] entries share the id rte:/_api/render/small'],
    [
      'a variant no request sample can satisfy',
      {},
      { variants: [{ route: 'api:login', variant: 'never', when: [{ param: 'username', nonEmpty: true }, { not: { param: 'x', equals: '1' } }] }] },
      'variant api:login{never} has a condition no request sample can satisfy',
    ],
    ['a variant its sample does not select', {}, { variants: [{ route: 'api:login', variant: 'other', when: [{ param: 'method', equals: 'logout' }] }] }, 'a request satisfying api:login{other} keys to api:login'],
  ])('rejects %s', async (_name, changes, opts, message) => {
    await expect(extractFrom(archiveTree(changes), opts)).rejects.toThrow(message);
  });

  it.each([
    [
      'a fixture module with no owning service',
      { [FIXTURE_API_PATH]: replaceOnce(textOf(FIXTURES, FIXTURE_API_PATH), '"people,finance,reporting"', '"people,payroll"') },
      `${FIXTURE_API_PATH}: fixture module payroll has no owning service`,
    ],
    [
      'two handlers behind one fixture route key',
      { [FIXTURE_API_PATH]: replaceOnce(textOf(FIXTURES, FIXTURE_API_PATH), '"people,finance,reporting"', '"finance"'), [FINANCE]: COLLIDING_FINANCE },
      `${FINANCE}: fixture:finance/records/{id}/{id}@get dispatches to both first and second`,
    ],
  ])('rejects %s', async (_name, changes, message) => {
    const files = new Map<string, string>(Object.entries(FIXTURES));
    for (const [rel, text] of Object.entries(changes)) files.set(rel, text);
    await expect(extractFrom(archiveTree({}), { fixtureTree: memorySourceTree(files) })).rejects.toThrow(message);
  });
});
