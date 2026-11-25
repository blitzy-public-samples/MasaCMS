import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openSourceTree } from '../../src/inventory/closure.js';
import { loadDecisionList, loadExceptions } from '../../src/inventory/disposition.js';
import type { Disposition, DispositionStep, ExceptionsList } from '../../src/inventory/disposition.js';
import {
  GENERATED_BY,
  INVENTORY_JSON,
  INVENTORY_MD,
  adminFacts,
  checkInventory,
  firstJsonDifference,
  generateInventory,
  main,
  serviceFacts,
  writeInventory,
} from '../../src/inventory/generate.js';
import type {
  DispositionFields,
  EntryReferences,
  GenerateResult,
  GeneratedFinding,
  InventoryInputs,
  LegacyInventory,
} from '../../src/inventory/generate.js';
import { LIVE_SNAPSHOT_JSON, readLiveSnapshot, writeLiveSnapshot } from '../../src/inventory/live-snapshot.js';
import { loadRoleOverrides, loadWriterOverrides } from '../../src/inventory/overrides.js';
import { loadTableOwnership } from '../../src/inventory/tables.js';
import type { TableOwnership } from '../../src/inventory/tables.js';
import { runCli, UsageError } from '../../src/lib/cli.js';
import { gitArchiveExtract } from '../../src/lib/git.js';
import { createReadOnlyMssql } from '../../src/lib/mssql.js';
import type { ReadOnlyMssql } from '../../src/lib/mssql.js';
import { assertOutsideRepo, opt2Path } from '../../src/lib/paths.js';
import { readPin } from '../../src/lib/pin.js';
import { stableStringify } from '../../src/lib/report.js';

// main() takes no inputs, so its default loaders read the inputs a test sets here instead of the repository's files.
const defaults = vi.hoisted(() => {
  const state: { inputs: InventoryInputs | null } = { inputs: null };
  return {
    state,
    get<K extends keyof InventoryInputs>(key: K): InventoryInputs[K] {
      if (state.inputs === null) throw new Error('default inventory inputs are not set');
      return state.inputs[key];
    },
  };
});

// generateInventory calls gitArchiveExtract directly, so the mock hands it a copy of the prepared tree instead of running git.
vi.mock('../../src/lib/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/git.js')>()),
  gitArchiveExtract: vi.fn(),
}));

// main --live opens SQL Server from the environment, so the mock hands it a fake read-only client instead.
vi.mock('../../src/lib/mssql.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/mssql.js')>()),
  createReadOnlyMssql: vi.fn(),
}));

vi.mock('../../src/inventory/overrides.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inventory/overrides.js')>();
  return {
    ...actual,
    loadRoleOverrides: async (p?: string) => (p === undefined ? defaults.get('roleOverrides') : actual.loadRoleOverrides(p)),
    loadViewPartials: async (p?: string) => (p === undefined ? defaults.get('viewPartials') : actual.loadViewPartials(p)),
    loadWriterOverrides: async (p?: string) => (p === undefined ? defaults.get('writerOverrides') : actual.loadWriterOverrides(p)),
  };
});

vi.mock('../../src/inventory/route-keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inventory/route-keys.js')>();
  return { ...actual, loadInventoryVariants: async (p?: string) => (p === undefined ? defaults.get('variants') : actual.loadInventoryVariants(p)) };
});

vi.mock('../../src/inventory/tables.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inventory/tables.js')>();
  return { ...actual, loadTableOwnership: async (p?: string) => (p === undefined ? defaults.get('ownership') : actual.loadTableOwnership(p)) };
});

vi.mock('../../src/inventory/disposition.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inventory/disposition.js')>();
  return {
    ...actual,
    loadDecisionList: async (p?: string) => (p === undefined ? defaults.get('decisionList') : actual.loadDecisionList(p)),
    loadExceptions: async (p?: string) => (p === undefined ? defaults.get('exceptions') : actual.loadExceptions(p)),
  };
});

// The working-tree fixture front controller is read inside routes.ts, so main()'s runs default to no fixture routes.
vi.mock('../../src/inventory/routes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inventory/routes.js')>();
  return {
    ...actual,
    extractRoutes: (tree: Parameters<typeof actual.extractRoutes>[0], opts: Parameters<typeof actual.extractRoutes>[1]) =>
      actual.extractRoutes(tree, { ...opts, fixtureTree: opts.fixtureTree ?? null }),
  };
});

// Each front-end extraction a run makes, so the inventory can be held to the unreachable methods it returned.
const frontEndRuns = vi.hoisted(() => [] as import('../../src/inventory/frontend.js').FrontEndExtraction[]);

vi.mock('../../src/inventory/frontend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inventory/frontend.js')>();
  return {
    ...actual,
    extractFrontEnd: async (...args: Parameters<typeof actual.extractFrontEnd>) => {
      const result = await actual.extractFrontEnd(...args);
      frontEndRuns.push(result);
      return result;
    },
  };
});

// Each relation extraction a run makes, so the inventory can be held to the unoriented edges it returned.
const relationRuns = vi.hoisted(() => [] as import('../../src/inventory/relations.js').RelationExtraction[]);

vi.mock('../../src/inventory/relations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inventory/relations.js')>();
  return {
    ...actual,
    extractRelations: (...args: Parameters<typeof actual.extractRelations>) => {
      const result = actual.extractRelations(...args);
      relationRuns.push(result);
      return result;
    },
  };
});

const extract = vi.mocked(gitArchiveExtract);

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function scriptCfc(attrs: string, ...body: string[]): string {
  return lines(`component ${attrs} output="false" {`, ...body, '}');
}

/** Committed fixtures copied byte for byte into the archive tree. */
const COPIED: Readonly<Record<string, string>> = {
  'core/setup/db/mssql.sql': 'cfml/mssql-excerpt.sql',
  'core/mura/dbUpdates/9.9.cfm': 'cfml/dbupdate-excerpt.cfm',
  'core/mura/fixture/fixtureBean.cfc': 'cfml/entity-with-bom.cfc',
  'core/mura/fixture/fixtureVersionedBean.cfc': 'cfml/versioned-entity.cfc',
  'core/mura/fixture/fixtureBase.cfc': 'cfml/orm-base.cfc',
  'core/mura/fixture/fixtureManager.cfc': 'cfml/not-entity-manager.cfc',
  'core/mura/fixture/writerManager.cfc': 'cfml/manager-writes.cfc',
  'core/mura/fixture/fixtureDAO.cfc': 'cfml/dao-writes.cfc',
  'admin/core/controllers/cfixture.cfc': 'cfml/controller-gate.cfc',
  'admin/core/views/cfixture/bypassed.cfm': 'cfml/view-bypassed.cfm',
  'admin/core/views/cfixture/fragment.cfm': 'cfml/view-fragment.cfm',
  'admin/core/views/cfixture/json.cfm': 'cfml/view-json.cfm',
  'core/mura/Application.cfc': 'Application.cfc',
};

const STARTUP_PATH = 'core/appcfc/onApplicationStart_include.cfm';
const STARTUP_FIXTURE = 'cfml/appstart-scan.cfm';

/** Site-monitor registration appended to the start-up fixture, modelled on onApplicationStart_include.cfm:549-579. */
const SITE_MONITOR_TASK = lines(
  '<cfscript>',
  '\tvariables.siteMonitorTask="#application.configBean.getWebRoot()#/index.cfm/_api/sitemonitor/";',
  '\ttry {',
  '\t\tif ( isBoolean(variables.iniProperties.ping) && variables.iniProperties.ping ) {',
  '\t\t\tlocal.updateurl = "http://" & listFirst(cgi.http_host,":") & application.configBean.getContext() & "/index.cfm/_api/sitemonitor/";',
  "\t\t\tapplication.serviceFactory.getBean('utility').scheduleTask(",
  '\t\t\t\taction = "update",',
  '\t\t\t\ttask = "#variables.siteMonitorTask#",',
  '\t\t\t\toperation = "HTTPRequest",',
  '\t\t\t\turl = "#local.updateurl#",',
  '\t\t\t\tstartTime = "#createTime(0,15,0)#",',
  '\t\t\t\tpublish = "No",',
  '\t\t\t\tinterval = "900",',
  '\t\t\t\trequestTimeOut = "600"',
  '\t\t\t);',
  '\t\t}',
  '\t} catch (any cfcatch) {',
  '\t}',
  '</cfscript>',
);

/** handleRootRequest, handleAPIRequest with one branch per route family, and the page render, modelled on contentServer.cfc. */
const CONTENT_SERVER = lines(
  '<cfcomponent extends="mura.cfobject" output="false">',
  '<cffunction name="handleRootRequest" output="false">',
  '\t<cfset var path=cgi.path_info>',
  "\t<cfif listFindNoCase('_api,tasks',listFirst(path,'/'))>",
  '\t\t<cfreturn handleAPIRequest(path)>',
  '\t<cfelse>',
  '\t\t<cfreturn parseURLRoot(path=path)>',
  '\t</cfif>',
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
  '\t\t<cfif not getBean(\'settingsManager\').siteExists(siteid)><cfset siteid="default"></cfif>',
  "\t\t<cfreturn getBean('settingsManager').getSite(siteid).getApi('json','v1').processRequest(arguments.path)>",
  '\t<cfelseif left(arguments.path,len(ajaxendpoint)) eq ajaxendpoint>',
  "\t\t<cfreturn getBean('settingsManager').getSite(url.siteid).getApi('json','v1').processRequest(arguments.path)>",
  '\t<cfelseif left(arguments.path,len(restendpoint)) eq restendpoint>',
  "\t\t<cfset request.muraAPIRequestMode='rest'>",
  "\t\t<cfif isDefined('url.siteid')><cfset siteid=url.siteid></cfif>",
  "\t\t<cfreturn getBean('settingsManager').getSite(siteid).getApi('json','v1').processRequest(arguments.path)>",
  "\t<cfelseif isDefined('url.feedid') and (left(arguments.path,len(feedendpoint)) eq feedendpoint or left(arguments.path,len(legacyfeedendpoint)) eq legacyfeedendpoint)>",
  '\t\t<cfreturn "">',
  "\t<cfelseif isDefined('url.siteid') and left(arguments.path,len(variationendpoint)) eq variationendpoint>",
  '\t\t<cfreturn "">',
  "\t<cfelseif isDefined('url.emailid') and left(arguments.path,len(emailendpoint)) eq emailendpoint>",
  '\t\t<cfreturn "">',
  "\t<cfelseif isDefined('url.fileid') and (left(arguments.path,len(fileendpoint)) eq fileendpoint or left(arguments.path,len(legacyfileendpoint)) eq legacyfileendpoint)>",
  '\t\t<cfparam name="url.size" default="#listGetAt(path,3,\'/\')#">',
  '\t\t<cfswitch expression="#url.size#">',
  '\t\t\t<cfcase value="small">',
  '\t\t\t\t<cfreturn "">',
  '\t\t\t</cfcase>',
  '\t\t\t<cfdefaultcase>',
  '\t\t\t\t<cfreturn "">',
  '\t\t\t</cfdefaultcase>',
  '\t\t</cfswitch>',
  '\t<cfelseif left(arguments.path,len(sitemonitorendpoint)) eq sitemonitorendpoint>',
  '\t\t<cfset var theTime=now()/>',
  "\t\t<cfparam name=\"application.lastMonitored\" default=\"#dateadd('n',-1,theTime)#\"/>",
  '\t\t<cfset application.contentManager.sendReminders(theTime) />',
  '\t\t<cfset application.changesetManager.publishBySchedule()>',
  '\t\t<cfset application.lastMonitored=theTime/>',
  '\t\t<cfreturn "">',
  '\t<cfelseif left(arguments.path,len(legacywidgetendpoint)) eq legacywidgetendpoint>',
  '\t\t<cflocation statuscode="301" url="#replaceNoCase(cgi.path_info,\'/tasks/widgets/\',\'/core/vendor/\')#" addtoken="false">',
  '\t<cfelseif left(arguments.path,len(assetendpoint)) eq assetendpoint>',
  '\t\t<cfparam name="url.action" default="#listGetAt(path,3,\'/\')#">',
  '\t\t<cfswitch expression="#url.action#">',
  '\t\t\t<cfdefaultcase>',
  '\t\t\t\t<cfreturn "">',
  '\t\t\t</cfdefaultcase>',
  '\t\t</cfswitch>',
  '\t</cfif>',
  '\t<cfreturn "">',
  '</cffunction>',
  '<cffunction name="parseURLRoot" output="false">',
  '\t<cfargument name="path">',
  '\t<cfset request.servletEvent.getHandler("standardDoActions").handle(request.servletEvent)>',
  '</cffunction>',
  '</cfcomponent>',
);

/** Guard kinds with the prefix of their fixture methods and doactions, and the reason the generator records. */
const GUARD_CASES = [
  ['cluster-broadcast', 'cluster', 'environment.ts asserts no broadcasting/peers (AAP 0.5.4)'],
  ['site-load', 'site', 'loads a site missing from the registry, which start-up fills and the projector refreshes after every site change'],
  ['entity-load', 'entity', 'declares a stored dynamic entity the factory lacks, which start-up and declareEntity register'],
  ['trash-restore', 'trash', 'runs only for a bean carrying fromMuraTrash, which ctrash.restore sets (decision list)'],
] as const;

const GUARDS_PATH = 'core/mura/fixture/fixtureGuards.cfc';
const GUARD_WRITE = '\t\t\tqueryExecute("DELETE FROM tfixturenopk WHERE siteid = :siteid", {siteid="default"});';
const TRASH_FLAG = ['\t\tvar doPurge = false;', '\t\tif (arguments.restored.valueExists("fromMuraTrash")) {', '\t\t\tdoPurge = true;', '\t\t}'];

/** Per guard kind, a write in its guarded branch and one in the opposite branch; `count` writes the table unguarded. */
const FIXTURE_GUARDS = scriptCfc(
  'extends="mura.cfobject"',
  '\tpublic any function clusterGuarded() {',
  '\t\tif (variables.broadcastClusterCommands) {',
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function clusterOpen() {',
  '\t\tif (variables.broadcastClusterCommands) {',
  '\t\t\treturn;',
  '\t\t} else {',
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function siteGuarded(required string siteid) {',
  '\t\tif (structKeyExists(variables.sites, arguments.siteid)) {',
  '\t\t\treturn;',
  '\t\t} else {',
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function siteOpen(required string siteid) {',
  '\t\tif (structKeyExists(variables.sites, arguments.siteid)) {',
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function entityGuarded() {',
  "\t\tif (super.containsBean( 'entity' )) {",
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function entityOpen() {',
  "\t\tif (super.containsBean( 'entity' )) {",
  '\t\t\treturn;',
  '\t\t} else {',
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function trashGuarded(required any restored) {',
  ...TRASH_FLAG,
  '\t\tif (doPurge) {',
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function trashOpen(required any restored) {',
  ...TRASH_FLAG,
  '\t\tif (doPurge) {',
  '\t\t\treturn;',
  '\t\t} else {',
  GUARD_WRITE,
  '\t\t}',
  '\t}',
  '\tpublic any function count() {',
  '\t\tqueryExecute("UPDATE tfixturenopk SET siteid = :siteid", {siteid="default"});',
  '\t}',
  // A bean save under a configuration setting, modelled on userUtility.cfc:419-432.
  '\tpublic any function configLocal() {',
  "\t\tvar autoresetpasswords = variables.configBean.getValue('autoresetpasswords');",
  "\t\tvar record = getBean('fixtureRecordBean');",
  '\t\tif (autoresetpasswords) {',
  '\t\t\trecord.save();',
  '\t\t}',
  '\t}',
  '\tpublic any function configInline() {',
  "\t\tvar record = getBean('fixtureRecordBean');",
  "\t\tif (variables.configBean.getValue('autoresetpasswords')) {",
  '\t\t\trecord.save();',
  '\t\t}',
  '\t}',
);

/** Configuration-guard doactions with the guard conjunct the closure records. */
const CONFIG_CASES = [
  ['a setting held in a local', 'configLocal', 'autoresetpasswords'],
  ['a setting read in the guard', 'configInline', "variables.configBean.getValue('autoresetpasswords')"],
] as const;

/** doAction cases calling each guard kind's guarded branch, its opposite branch, and its guarded branch with `count`. */
const GUARD_DOACTIONS = GUARD_CASES.flatMap(([, prefix]) => {
  const args = prefix === 'site' ? "'default'" : prefix === 'trash' ? 'arguments.event' : '';
  const call = (method: string): string => `<cfset getBean('fixtureGuards').${method}(${method === 'count' ? '' : args})>`;
  const cases: [value: string, body: string][] = [
    [`${prefix}Guarded`, call(`${prefix}Guarded`)],
    [`${prefix}Open`, call(`${prefix}Open`)],
    [`${prefix}Mixed`, call(`${prefix}Guarded`) + call('count')],
  ];
  return cases.flatMap(([value, body]) => [`\t\t<cfcase value="${value}">`, `\t\t\t${body}`, '\t\t</cfcase>']);
});

/** The doaction loop and its doAction cases, modelled on standardEventsHandler.cfc:521-640. */
const EVENTS_HANDLER = lines(
  '<cfcomponent extends="mura.cfobject" output="false">',
  '<cffunction name="standardDoActionsHandler" output="false">',
  '\t<cfargument name="event" required="true">',
  '\t<cfargument name="$" />',
  '\t<cfset var a=""/>',
  "\t<cfif arguments.event.getValue('doaction') neq ''>",
  "\t\t<cfloop list=\"#arguments.event.getValue('doaction')#\" index=\"a\">",
  '\t\t\t<cfset doAction(a,arguments.event,arguments.$)>',
  '\t\t</cfloop>',
  '\t</cfif>',
  '</cffunction>',
  '<cffunction name="doAction" output="false">',
  '\t<cfargument name="theaction" type="string" default="">',
  '\t<cfargument name="event" required="true">',
  '\t<cfargument name="$" />',
  '\t<cfswitch expression="#arguments.theaction#">',
  '\t\t<cfcase value="rename">',
  "\t\t\t<cfset getBean('fixtureDAO').update(userid=arguments.event.getValue('userid'), name=arguments.event.getValue('name'))>",
  '\t\t</cfcase>',
  '\t\t<cfcase value="broadcast">',
  "\t\t\t<cfset getBean('fixtureCluster').broadcast('reload')>",
  '\t\t</cfcase>',
  ...GUARD_DOACTIONS,
  ...CONFIG_CASES.flatMap(([, method]) => [`\t\t<cfcase value="${method}">`, `\t\t\t<cfset getBean('fixtureGuards').${method}()>`, '\t\t</cfcase>']),
  '\t</cfswitch>',
  '</cffunction>',
  '</cfcomponent>',
);

const PUBLIC_METHOD_LIST =
  'undeclareEntity,declareEntity,checkSchema,findOne,findMany,findAll,findPermissions,findProperties,findNew,findQuery,' +
  'save,delete,findCrumbArray,generateCSRFTokens,validateEmail,login,logout,submitForm,findCalendarItems,validate,' +
  'processAsyncObject,findRelatedContent,getURLForImage,findVersionHistory,findCurrentUser,swagger';

const REGISTERED = [
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

const GENERIC = ['findOne', 'findMany', 'findAll', 'findNew', 'findQuery', 'findProperties', 'findPermissions', 'validate', 'save', 'delete'];

/** init, processRequest with its OAuth blocks, the generic methods and token info, modelled on jsonApiUtility.cfc. */
const JSON_API = scriptCfc(
  'extends="mura.cfobject"',
  '\tfunction init(siteid) {',
  '\t\tvariables.config = {',
  `\t\t\tpublicMethods = "${PUBLIC_METHOD_LIST}",`,
  '\t\t\tentities = {',
  "\t\t\t\t'contentnav' = { fields = \"contentid,title\" }",
  '\t\t\t}',
  '\t\t};',
  ...REGISTERED.map((e) => `\t\tregisterEntity('${e}', { moduleid = '00000000000000000000000000000000000' });`),
  "\t\tif (getBean('configBean').getValue(property='variations', defaultValue=false)) {",
  "\t\t\tregisterEntity('variationTargeting', { public = true });",
  '\t\t}',
  '\t\treturn this;',
  '\t}',
  '\tfunction registerEntity(entityName, config) {',
  '\t\tvariables.config.entities[arguments.entityName] = arguments.config;',
  '\t}',
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
  '\t\t\t} else {',
  "\t\t\t\tif (listFind('oauth,oauth2', pathInfo[4])) {",
  "\t\t\t\t\treturn { token_type = 'Bearer' };",
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t}',
  '\t\tswitch (method) {',
  '\t\t\tcase "GET":',
  '\t\t\t\treturn findOne(argumentCollection=params);',
  '\t\t\tcase "POST":',
  '\t\t\t\treturn save(argumentCollection=params);',
  '\t\t\tcase "DELETE":',
  '\t\t\t\treturn delete(argumentCollection=params);',
  '\t\t\tdefault:',
  '\t\t\t\tthrow(type="invalidMethodCall");',
  '\t\t}',
  '\t}',
  ...GENERIC.flatMap((m) => [`\tfunction ${m}(siteid, entityName, id) {`, '\t\treturn {};', '\t}']),
  '\tfunction getOAuthTokenInfo(access_token) {',
  '\t\treturn {};',
  '\t}',
);

/** Inline excerpts the extractors anchor on, by archive path. */
const INLINE: Readonly<Record<string, string>> = {
  'core/mura/content/contentServer.cfc': CONTENT_SERVER,
  'core/mura/Handler/standardEventsHandler.cfc': EVENTS_HANDLER,
  'core/mura/client/api/json/v1/jsonApiUtility.cfc': JSON_API,
  'core/appcfc/applicationSettings.cfm': lines('<cfscript>', "this.sessionManagement = !(left(cgi.path_info,13)=='/_api/rest/v1');", '</cfscript>'),
  'core/mura/settings/settingsBean.cfc': scriptCfc(
    'extends="mura.cfobject" entityname="site"',
    '\tfunction getApi(type="json", version="v1") {',
    '\t\treturn new mura.client.api.#arguments.type#.#arguments.version#.#arguments.type#ApiUtility(siteid=variables.instance.siteid);',
    '\t}',
  ),
  // A join of two primary keys: no key side, so the edge is unoriented.
  'core/mura/fixture/fixtureStatsIterator.cfc': scriptCfc(
    'extends="mura.cfobject"',
    '\tpublic query function read() {',
    '\t\treturn queryExecute("SELECT f.name FROM tfixture f INNER JOIN tfixturestats s ON s.statID = f.fixtureID");',
    '\t}',
  ),
  [GUARDS_PATH]: FIXTURE_GUARDS,
  'core/mura/fixture/fixtureCluster.cfc': scriptCfc(
    'extends="mura.cfobject"',
    '\tpublic any function broadcast(required string command) {',
    "\t\tif (variables.configBean.getValue('broadcastClusterCommands') && variables.rsPeers.recordcount) {",
    '\t\t\tqueryExecute("INSERT INTO tclustercommands (commandID, command) VALUES (:id, :command)", {id=createUUID(), command=arguments.command});',
    '\t\t}',
    '\t}',
  ),
  'core/mura/fixture/fixtureRecordBean.cfc': scriptCfc(
    'extends="mura.cfobject"',
    '\tpublic any function save() {',
    "\t\tgetBean('fixtureDAO').update(userid=variables.userid, name=variables.name);",
    '\t\treturn this;',
    '\t}',
  ),
  // Remote methods the core/mura request guard keeps HTTP from, modelled on muraProxy.cfc.
  'core/mura/fixture/fixtureProxy.cfc': scriptCfc(
    'extends="mura.cfobject"',
    '\tremote any function login(required string username) {',
    '\t\treturn "";',
    '\t}',
    '\tpublic any function helper() {',
    '\t\treturn true;',
    '\t}',
    '\tremote any function callWithStringArgs(required string serviceName) {',
    '\t\treturn "";',
    '\t}',
  ),
  'core/mura/fixture/fixtureUserBean.cfc': lines(
    'component extends="mura.bean.beanORM" table="tusers" entityname="fixtureUser" {',
    '\tproperty name="userid" fieldtype="id";',
    '}',
  ),
  'admin/core/controllers/controller.cfc': scriptCfc(
    'accessors="true"',
    '\tproperty name="userManager";',
    '\tpublic any function init(fw) {',
    '\t\treturn this;',
    '\t}',
    '\tpublic any function secure(rc) {',
    '\t\tlocation(url="./?muraAction=cLogin.main", addtoken=false);',
    '\t}',
  ),
};

/** Request variants of the fixture controller's actions, one per predicate form. */
const VARIANTS: InventoryInputs['variants']['variants'] = [
  { route: 'admin:cfixture.update', variant: 'action=add', when: [{ param: 'action', equals: 'Add' }] },
  { route: 'admin:cfixture.update', variant: 'action=delete', when: [{ param: 'action', in: ['Delete'] }] },
  {
    route: 'admin:cfixture.remove',
    variant: 'confirmed',
    when: [
      { param: 'confirm', truthy: true },
      { param: 'userid', nonEmpty: true },
    ],
  },
];

/** Ownership of the fixture tables, added to the mini ownership file because every archive table needs an owner. */
const FIXTURE_OWNERSHIP: readonly (readonly [table: string, owner: string, unit: string])[] = [
  ['tfixture', 'people', 'people.fixture'],
  ['tfixturemigrated', 'programs-sites', 'programs_sites.fixture_migrated'],
  ['tfixturenopk', 'strategies-content', 'content.fixture_nopk'],
  ['tfixturestats', 'sample-module', 'sample_module.fixture_stats'],
  ['tfixtureversioned', 'strategies-content', 'content.fixture_versioned'],
];

function withFixtureTables(ownership: TableOwnership): TableOwnership {
  return {
    ...ownership,
    units: [...ownership.units, ...FIXTURE_OWNERSHIP.map(([, owner, unit]) => ({ unit, owner }))],
    tables: [
      ...ownership.tables,
      ...FIXTURE_OWNERSHIP.map(([table, owner, unit]) => ({ table, owner, ruleSteps: [1], targets: [{ unit, owner }] })),
      { table: 'fb_*', owner: 'decision-list', ruleSteps: [5], targets: [], decisionRef: 'opt2/decision-list.json#fb_*' },
    ],
  };
}

const pin = readPin();
const FULL_DB_UPDATES = 37;
const COMMITTED = [opt2Path('inventory', INVENTORY_JSON), opt2Path('inventory', INVENTORY_MD)];

const TOP_LEVEL_KEYS = [
  'sourceSha',
  'generatedBy',
  'extractedFrom',
  'counts',
  'entities',
  'services',
  'controllers',
  'coreMuraActionSearch',
  'frontEnd',
  'unreachableRemote',
  'scheduledJobs',
  'routes',
  'tables',
  'relations',
  'unorientedRelations',
  'storedProcedureCheck',
  'findings',
];

/** Rule steps each disposition is decided at. */
const RULE_STEPS: Readonly<Record<Disposition, readonly DispositionStep[]>> = {
  retired: [1],
  decision: [2, 3],
  'legacy-served': [4],
  carry: [5, 'fixture-definition'],
};

interface FileState {
  mtimeMs: number;
  sha256: string;
}

let tempRoot = '';
let archiveDir = '';
let fullArchiveDir = '';
let outRoot = '';
let outA = '';
let inputs: InventoryInputs;
let first: GenerateResult;
let firstCalls: unknown[][] = [];
let archivesBefore: Record<string, string>[] = [];
let committedBefore: (FileState | null)[] = [];

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareFindings(a: GeneratedFinding, b: GeneratedFinding): number {
  return (
    compareText(a.kind, b.kind) ||
    compareText(a.id ?? a.measure ?? '', b.id ?? b.measure ?? '') ||
    compareText(a.source?.path ?? '', b.source?.path ?? '') ||
    (a.source?.lines[0] ?? 0) - (b.source?.lines[0] ?? 0) ||
    compareText(a.detail ?? '', b.detail ?? '')
  );
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** SHA-256 of every file under `dir`, by relative path. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of (await readdir(dir, { recursive: true })).sort(compareText)) {
    const abs = path.join(dir, rel);
    if ((await stat(abs)).isFile()) out[rel] = await sha256(abs);
  }
  return out;
}

async function fileState(file: string): Promise<FileState | null> {
  return existsSync(file) ? { mtimeMs: (await stat(file)).mtimeMs, sha256: await sha256(file) } : null;
}

/** A fresh copy of the archive tree `from`, as `git archive` would extract it. */
async function extractCopy(from: string): Promise<string> {
  const dir = await mkdtemp(path.join(tempRoot, 'extract-'));
  await cp(from, dir, { recursive: true });
  return dir;
}

/** The directory the latest extractor call returned. */
async function extractedDir(): Promise<string> {
  const result = extract.mock.results.at(-1);
  if (result?.type !== 'return') throw new Error('the extractor was not called');
  return result.value;
}

function run(extra: Parameters<typeof generateInventory>[0] = {}): Promise<GenerateResult> {
  return generateInventory({ inputs, expectedDbUpdates: 1, ...extra });
}

/** Copies the inventory files of `from` with `counts.frontEnd` and line 4 of the Markdown changed. */
async function modifiedCopy(from: string, name: string): Promise<{ dir: string; json: string; markdown: string }> {
  const dir = path.join(outRoot, name);
  await mkdir(dir, { recursive: true });
  const inv = JSON.parse(await readFile(path.join(from, INVENTORY_JSON), 'utf8')) as LegacyInventory;
  const json = stableStringify({ ...inv, counts: { ...inv.counts, frontEnd: inv.counts.frontEnd + 1 } });
  const markdown = (await readFile(path.join(from, INVENTORY_MD), 'utf8'))
    .split('\n')
    .map((line, i) => (i === 3 ? `${line} (edited)` : line))
    .join('\n');
  await writeFile(path.join(dir, INVENTORY_JSON), json, 'utf8');
  await writeFile(path.join(dir, INVENTORY_MD), markdown, 'utf8');
  return { dir, json, markdown };
}

function disposedItems(inv: LegacyInventory): (DispositionFields & { id: string })[] {
  return [
    ...inv.controllers.flatMap((c) => c.actions.flatMap((a) => a.variants)),
    ...inv.frontEnd,
    ...inv.unreachableRemote,
    ...inv.scheduledJobs.flatMap((j) => j.steps),
    ...inv.routes,
    ...inv.entities,
    ...inv.services,
    ...inv.tables,
  ];
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-generate-'));
  archiveDir = path.join(tempRoot, 'archive');
  outRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-generate-out-'));
  outA = path.join(outRoot, 'first');
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(archiveDir, rel)), { recursive: true });
    await copyFile(fixturePath(name), path.join(archiveDir, rel));
  }
  // The start-up fixture holds the DI1 scan; the site-monitor registration the jobs extractor needs follows it.
  await mkdir(path.dirname(path.join(archiveDir, STARTUP_PATH)), { recursive: true });
  await writeFile(path.join(archiveDir, STARTUP_PATH), (await readFile(fixturePath(STARTUP_FIXTURE), 'utf8')) + SITE_MONITOR_TASK, 'utf8');
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(archiveDir, rel)), { recursive: true });
    await writeFile(path.join(archiveDir, rel), text, 'utf8');
  }
  // main() keeps the default schema-update count, so its archive adds updates that change no table.
  fullArchiveDir = path.join(tempRoot, 'archive-full');
  await cp(archiveDir, fullArchiveDir, { recursive: true });
  for (let n = 1; n < FULL_DB_UPDATES; n++) {
    await writeFile(path.join(fullArchiveDir, `core/mura/dbUpdates/1.${String(n)}.cfm`), '<!--- Schema update with no table change --->\n', 'utf8');
  }
  archivesBefore = await Promise.all([archiveDir, fullArchiveDir].map(snapshot));
  committedBefore = await Promise.all(COMMITTED.map(fileState));
  inputs = {
    roleOverrides: await loadRoleOverrides(fixturePath('inventory/role-overrides.valid.yaml')),
    viewPartials: { sourceSha: pin.sha, partials: [] },
    writerOverrides: await loadWriterOverrides(fixturePath('inventory/writer-overrides.valid.yaml')),
    variants: { sourceSha: pin.sha, variants: VARIANTS },
    ownership: withFixtureTables(await loadTableOwnership(fixturePath('inventory/mini-table-ownership.json'))),
    decisionList: await loadDecisionList(fixturePath('inventory/mini-decision-list.json')),
    exceptions: await loadExceptions(fixturePath('inventory/mini-exceptions-list.json')),
    fixtureTree: null,
  };
  extract.mockImplementation(() => extractCopy(archiveDir));
  first = await run();
  firstCalls = extract.mock.calls.map((call) => [...call]);
  await writeInventory(first.inventory, outA);
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await rm(outRoot, { recursive: true, force: true });
});

describe('first run', () => {
  it('extracts the pinned commit once through the archive extractor', () => {
    expect(pin.sha).toBe('696383140578f8dea3ece26f80cd7bfb370ddf0f');
    expect(firstCalls).toEqual([[pin.sha]]);
  });

  it('writes JSON holding every top-level key, stamped with the pinned SHA', async () => {
    const written = JSON.parse(await readFile(path.join(outA, INVENTORY_JSON), 'utf8')) as LegacyInventory;
    expect(Object.keys(first.inventory)).toEqual(TOP_LEVEL_KEYS);
    expect(Object.keys(written).sort(compareText)).toEqual([...TOP_LEVEL_KEYS].sort(compareText));
    expect(written).toEqual(JSON.parse(stableStringify(first.inventory)));
    expect(written.sourceSha).toBe(pin.sha);
    expect(written.generatedBy).toBe(GENERATED_BY);
    expect(written.extractedFrom).toEqual({ method: 'git archive', sha: pin.sha, workingTree: false });
  });

  it('sorts every entry array by id and the findings by kind, subject and source', () => {
    const inv = first.inventory;
    const arrays: Readonly<Record<string, readonly { id: string }[]>> = {
      entities: inv.entities,
      services: inv.services,
      controllers: inv.controllers,
      frontEnd: inv.frontEnd,
      unreachableRemote: inv.unreachableRemote,
      scheduledJobs: inv.scheduledJobs,
      routes: inv.routes,
      tables: inv.tables,
      relations: inv.relations,
      unorientedRelations: inv.unorientedRelations,
    };
    for (const [key, items] of Object.entries(arrays)) {
      const ids = items.map((item) => item.id);
      expect(ids, key).toEqual([...ids].sort(compareText));
    }
    expect(inv.findings.length).toBeGreaterThan(1);
    expect(inv.findings).toEqual([...inv.findings].sort(compareFindings));
  });

  it('leaves live fields null until a live run', () => {
    const inv = first.inventory;
    expect(inv.counts.liveStatus).toBe('pending-run');
    expect([inv.counts.entities.dynamic, inv.counts.tables.live, inv.counts.tables.withSiteIdLive, inv.counts.storedProcedures.live]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(inv.storedProcedureCheck.liveStatus).toBe('pending-run');
    expect(Object.entries(inv.storedProcedureCheck.live).filter(([, value]) => value !== null)).toEqual([]);
    for (const e of inv.entities) {
      expect([e.liveStatus, e.liveRegistered, e.liveNames, e.liveInstances], e.id).toEqual(['pending-run', null, null, null]);
    }
    for (const t of inv.tables) {
      expect([t.liveStatus, t.live, t.hasSiteIdLive, t.hasPrimaryKeyLive], t.id).toEqual(['pending-run', null, null, null]);
    }
  });

  it('decides a disposition at its rule step for every disposed item and tallies them', () => {
    const inv = first.inventory;
    const items = disposedItems(inv);
    const tally: Record<Disposition, number> = { carry: 0, 'legacy-served': 0, decision: 0, retired: 0 };
    for (const item of items) {
      expect(RULE_STEPS[item.disposition], item.id).toContain(item.dispositionStep);
      if (item.withheld) expect(item.disposition, item.id).toBe('decision');
      tally[item.disposition] += 1;
    }
    expect(Object.values(tally).every((n) => n > 0)).toBe(true);
    expect(items.some((item) => item.withheld)).toBe(true);
    expect(inv.counts.dispositions).toEqual(tally);
    for (const fields of [...inv.scheduledJobs, ...inv.tables.flatMap((t) => t.unitDispositions)]) {
      expect(RULE_STEPS[fields.disposition]).toContain(fields.dispositionStep);
    }
    expect(inv.controllers.map((c) => [c.disposition, c.dispositionStep])).toEqual(inv.controllers.map(() => [null, null]));
  });

  it('counts match the lengths of the arrays they summarise', () => {
    const { counts, ...inv } = first.inventory;
    const classes = counts.entities;
    const classTotal = classes['orm-base'] + classes['orm-concrete'] + classes['not-entity'] + classes['domain-bean'] + classes.dynamicPatterns;
    expect(classTotal).toBe(inv.entities.length);
    expect(counts.services.registeredSingletons).toBe(inv.services.length);
    expect(counts.controllers.circuits + counts.controllers.base).toBe(inv.controllers.length);
    expect(counts.controllers.actions).toBe(inv.controllers.reduce((n, c) => n + c.actions.length, 0));
    expect(counts.controllers.variants).toBe(inv.controllers.reduce((n, c) => n + c.actions.reduce((m, a) => m + a.variants.length, 0), 0));
    expect(counts.coreMuraActionFiles).toBe(inv.coreMuraActionSearch.filesMentioning);
    expect(counts.frontEnd).toBe(inv.frontEnd.length);
    expect(counts.unreachableRemote).toBe(inv.unreachableRemote.length);
    expect(counts.scheduledJobs).toEqual({
      jobs: inv.scheduledJobs.length,
      siteMonitorSteps: inv.scheduledJobs.reduce((n, j) => n + j.steps.length, 0),
    });
    expect(Object.values(counts.routes).reduce((n, c) => n + c, 0)).toBe(inv.routes.length);
    expect(counts.tables.staticTotal + counts.tables.retired + counts.tables.fixture + counts.tables.dynamic + counts.tables.liveOnly).toBe(
      inv.tables.length,
    );
    expect(counts.relations.relations).toBe(inv.relations.length);
    expect(counts.relations.unknownOrientation).toBe(inv.unorientedRelations.length);
    const sections = [inv.entities, inv.services, inv.controllers, inv.frontEnd, inv.unreachableRemote, inv.scheduledJobs, inv.routes, inv.tables];
    expect(sections.every((a) => a.length > 0)).toBe(true);
  });

  it('renders Markdown headed by the title and the Source SHA line', async () => {
    const markdown = await readFile(path.join(outA, INVENTORY_MD), 'utf8');
    expect(markdown).toBe(first.markdown);
    const [title, shaLine, blank] = markdown.split('\n');
    expect(title?.startsWith('# Legacy inventory')).toBe(true);
    expect(shaLine).toBe(`Source SHA: ${pin.sha}`);
    expect(blank).toBe('');
    expect(markdown.endsWith('\n') && !markdown.endsWith('\n\n')).toBe(true);
  });

  it('records a write reached only under an environment guard as a conditional write, outside the write set', () => {
    expect(first.inventory.frontEnd.find((e) => e.id === 'fe:doaction=broadcast')).toMatchObject({
      writeSet: [],
      conditionalWrites: [
        expect.objectContaining({ kind: 'cluster-broadcast', unit: null, legacyTable: 'tclustercommands', op: 'insert', guard: GUARD_CASES[0][2] }),
      ],
      owners: [],
    });
    expect(first.inventory.findings).toContainEqual(
      expect.objectContaining({ kind: 'unmatched-write', source: { path: 'core/mura/fixture/fixtureCluster.cfc', lines: [4, 4] } }),
    );
  });

  it.each(GUARD_CASES)('keeps a %s write only under its guard out of the write set, and a table also written unguarded in it', (kind, prefix, guard) => {
    const entry = (branch: string) => first.inventory.frontEnd.find((e) => e.id === `fe:doaction=${prefix}${branch}`);
    const at = (method: string) => ({
      unit: 'content.fixture_nopk',
      legacyTable: 'tfixturenopk',
      source: expect.objectContaining({ path: GUARDS_PATH }),
      via: expect.arrayContaining([`fixtureGuards.${method}`]),
    });
    const guarded = expect.objectContaining({ kind, op: 'delete', guard, ...at(`${prefix}Guarded`) });
    expect(entry('Guarded')).toMatchObject({ writeSet: [], conditionalWrites: [guarded], owners: [] });
    expect(entry('Open')).toMatchObject({
      writeSet: [expect.objectContaining({ op: 'delete', condition: expect.any(String), override: null, ...at(`${prefix}Open`) })],
      conditionalWrites: [],
      owners: ['strategies-content'],
    });
    expect(entry('Mixed')).toMatchObject({
      writeSet: [expect.objectContaining({ op: 'update', condition: null, override: null, ...at('count') })],
      conditionalWrites: [guarded],
      owners: ['strategies-content'],
    });
  });

  it.each(CONFIG_CASES)('keeps a bean save under %s in the write set, conditioned on it', (_label, method, conjunct) => {
    const entry = first.inventory.frontEnd.find((e) => e.id === `fe:doaction=${method}`);
    expect(entry).toMatchObject({
      writeSet: [
        expect.objectContaining({
          unit: 'people.fixture',
          legacyTable: 'tfixture',
          op: 'update',
          via: expect.arrayContaining([`fixtureGuards.${method}`, 'fixtureRecordBean.save', 'fixtureDAO.update']),
          override: null,
        }),
      ],
      conditionalWrites: [],
      owners: ['people'],
    });
    expect(entry?.writeSet[0]?.condition?.split(' && ')).toContain(conjunct);
  });

  it('disposes a split table once per target unit', () => {
    const users = first.inventory.tables.find((t) => t.table === 'tusers');
    expect(users).toMatchObject({ ownershipOwner: 'split', owningService: null, owners: ['identity', 'people'], ownerBasis: 'table-ownership' });
    expect(users?.unitDispositions.map((u) => [u.unit, u.rowPredicate, u.owningService])).toEqual([
      ['identity.user_account', 'Type = 2', 'identity'],
      ['people.person', 'Type = 2', 'people'],
    ]);
  });

  it('writes only the two inventory files into the output directory', async () => {
    expect((await readdir(outA)).sort(compareText)).toEqual([INVENTORY_JSON, INVENTORY_MD].sort(compareText));
  });
});

const PROXY = 'core/mura/fixture/fixtureProxy.cfc';
const PROXY_GUARD = 'core/mura/Application.cfc:6-9';

describe('unreachable remote methods', () => {
  it('keeps every remote method the front-end extraction found unreachable, and counts it', () => {
    const extracted = frontEndRuns[0]?.unreachableRemote ?? [];
    const inv = first.inventory;
    expect(extracted.length).toBeGreaterThan(0);
    expect(inv.counts.unreachableRemote).toBe(extracted.length);
    expect(inv.unreachableRemote.map((u) => ({ id: u.id, component: u.component, method: u.method, line: u.source.lines[0], guard: u.guard }))).toEqual(
      extracted
        .map((r) => ({ id: `fe:unreachable:${r.path.toLowerCase()}#${r.method}`, component: r.path, method: r.method, line: r.line, guard: r.guard }))
        .sort((a, b) => compareText(a.id, b.id)),
    );
  });

  it.each([
    { method: 'callWithStringArgs', span: [8, 10] },
    { method: 'login', span: [2, 4] },
  ])('retires $method at rule step 1 with its declaration span and guard, and routes nothing to it', ({ method, span }) => {
    const id = `fe:unreachable:${PROXY.toLowerCase()}#${method}`;
    const inv = first.inventory;
    expect(inv.unreachableRemote.find((u) => u.id === id)).toEqual({
      id,
      component: PROXY,
      method,
      source: { path: PROXY, lines: span },
      guard: PROXY_GUARD,
      routeKey: null,
      owningService: null,
      owners: [],
      ownerBasis: 'none',
      disposition: 'retired',
      dispositionStep: 1,
      dispositionReason: 'unreachable over HTTP or the scheduler at the pinned SHA',
      withheld: false,
      legacyWrite: false,
      haltedBy: null,
      protocol: null,
      decisionListRef: null,
      decisionListGap: false,
      correction: null,
    });
    expect([...inv.frontEnd, ...inv.routes].filter((e) => e.source.path === PROXY)).toEqual([]);
    expect(first.markdown).toContain(`| \`${id}\` | \`${PROXY}:${String(span[0])}-${String(span[1])}\` | \`${PROXY_GUARD}\` | — | retired (1) |`);
  });
});

describe('live run', () => {
  const BROWSER = 'core/modules/v1/filebrowser/model/beans/filebrowser.cfc';
  const VERSIONED_BASE = 'core/mura/bean/beanORMVersioned.cfc';
  const registration = (fields: Record<string, unknown>): Record<string, unknown> => ({
    table: null,
    componentPath: null,
    versioned: null,
    bundleable: null,
    historical: null,
    registrationComplete: true,
    origin: 'core',
    ...fields,
  });
  const PROBE = {
    generatedAt: '2026-11-13T00:00:00Z',
    bundleableBeans: [],
    versionedBeans: [],
    entities: [
      registration({
        name: 'filebrowser',
        table: 'm_filebrowser',
        componentPath: 'muraWRM.core.modules.v1.filebrowser.model.beans.filebrowser',
        origin: 'other',
      }),
    ],
  };
  const column = (table: string, name: string, ordinal: number): Record<string, unknown> => ({
    TABLE_SCHEMA: 'dbo',
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: 'char',
    CHARACTER_MAXIMUM_LENGTH: 35,
    IS_NULLABLE: 'NO',
    ORDINAL_POSITION: ordinal,
  });
  const CATALOG = {
    tables: ['tfixture', 'tfixturestats'].map((name) => ({ TABLE_SCHEMA: 'dbo', TABLE_NAME: name })),
    columns: [column('tfixture', 'fixtureID', 1), column('tfixture', 'SiteID', 2), column('tfixturestats', 'statID', 1)],
    keys: [{ TABLE_SCHEMA: 'dbo', TABLE_NAME: 'tfixture', COLUMN_NAME: 'fixtureID', ORDINAL_POSITION: 1 }],
  };
  const db: ReadOnlyMssql = {
    readOnlyQuery<T>(sql: string): Promise<T[]> {
      if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) return Promise.resolve(CATALOG.keys as T[]);
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return Promise.resolve(CATALOG.columns as T[]);
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) return Promise.resolve(CATALOG.tables as T[]);
      return Promise.resolve([]);
    },
    close: () => Promise.resolve(),
  };
  // Test value assembled at run time, not a secret.
  const env = { OPT2_HARNESS_KEY: ['opt2', 'harness', 'generate', 'test'].join('-') };
  let inv: LegacyInventory;
  let liveResult: GenerateResult;
  let liveDir = '';
  let probe: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    liveDir = path.join(tempRoot, 'archive-live');
    await cp(archiveDir, liveDir, { recursive: true });
    await mkdir(path.dirname(path.join(liveDir, BROWSER)), { recursive: true });
    await writeFile(
      path.join(liveDir, BROWSER),
      lines('component entityname="filebrowser" extends="mura.bean.bean" table="m_filebrowser" {', '\tproperty name="filebrowserid" fieldtype="id";', '}'),
      'utf8',
    );
    // The versioned base declares the siteID column of the ORM entity that extends it, as beanORMVersioned.cfc:80 does.
    await mkdir(path.dirname(path.join(liveDir, VERSIONED_BASE)), { recursive: true });
    await writeFile(
      path.join(liveDir, VERSIONED_BASE),
      lines('component extends="mura.bean.beanORM" {', '\tproperty name="site" fieldtype="many-to-one" cfc="site" fkcolumn="siteID";', '}'),
      'utf8',
    );
    const fetch = vi.fn(async () => new Response(JSON.stringify(PROBE), { status: 200, headers: { 'content-type': 'application/json' } }));
    probe = fetch;
    liveResult = await run({ sourceTree: openSourceTree(liveDir), live: { origin: 'http://legacy.invalid:8080', db, fixturesLoaded: false, env, fetch } });
    inv = liveResult.inventory;
  });

  it('completes with live table, siteID and stored-procedure figures', () => {
    expect(inv.counts.liveStatus).toBe('live');
    expect([inv.counts.tables.live, inv.counts.tables.withSiteIdLive, inv.counts.storedProcedures.live]).toEqual([2, 1, 0]);
    expect(inv.storedProcedureCheck.live).toMatchObject({ procedures: 0, triggers: 0, functions: 0, total: 0, takenBeforeFixtures: true });
  });

  it('carries the live catalog key into tables[] beside the static one', () => {
    expect(inv.tables.find((t) => t.table === 'tfixturestats')).toMatchObject({
      primaryKey: [],
      hasPrimaryKey: false,
      hasPrimaryKeyLive: false,
      staticPrimaryKey: ['statID'],
      staticHasPrimaryKey: true,
    });
  });

  it('gives a registration whose declared table no tables[] entry lists no writes, and reports it', () => {
    expect(inv.entities.find((e) => e.id === 'ent:dynamic:filebrowser')).toMatchObject({
      source: { path: BROWSER, lines: [1, 1] },
      table: 'm_filebrowser',
      writesTables: null,
      owners: [],
      disposition: 'carry',
    });
    expect(inv.findings).toContainEqual({
      kind: 'absent-entity-table',
      id: 'ent:dynamic:filebrowser',
      source: { path: BROWSER, lines: [1, 1] },
      detail: 'filebrowser declares table m_filebrowser, which no tables[] entry lists; the entity writes nothing to it',
    });
  });

  it('explains the static siteID count by origin and inherited column, adding the live figure on a live run', () => {
    const detail = (i: LegacyInventory): string | null | undefined =>
      i.findings.find((f) => f.kind === 'count-difference' && f.measure === 'tables.withSiteId')?.detail;
    expect(detail(first.inventory)).toBe('siteID on 2 bootstrap, 1 migration and 0 ORM-only tables');
    expect(detail(inv)).toBe(
      'siteID on 2 bootstrap, 1 migration and 1 ORM-only tables; ' +
        'inherited from a base component: tfixtureversioned (core/mura/bean/beanORMVersioned.cfc:2); ' +
        'live catalog 1, tables absent live: tfixturemigrated, tfixtureversioned, siteID absent live: tfixturestats',
    );
  });

  it('states the static and live table and siteID figures in the Markdown', () => {
    const { staticTotal, live, withSiteIdStatic, withSiteIdLive } = inv.counts.tables;
    for (const [item, value] of Object.entries({ staticTotal, live, withSiteIdStatic, withSiteIdLive })) {
      expect(liveResult.markdown).toContain(`| tables | ${item} | ${String(value)} |`);
    }
    expect(liveResult.markdown).toContain('- Stored procedures: static 0, live 0;');
  });

  it('rebuilds the same inventory and Markdown from the written snapshot without querying the live sources', async () => {
    const dir = path.join(outRoot, 'live-replay');
    await writeLiveSnapshot(liveResult.liveSnapshot ?? expect.unreachable('a live run returns its snapshot'), dir);
    const probes = probe.mock.calls.length;
    const replay = await run({ sourceTree: openSourceTree(liveDir), liveSnapshot: await readLiveSnapshot(path.join(dir, LIVE_SNAPSHOT_JSON)) });
    expect(probe.mock.calls.length).toBe(probes);
    expect(stableStringify(replay.inventory)).toBe(stableStringify(inv));
    expect(replay.markdown).toBe(liveResult.markdown);
    expect(replay.liveSnapshot).toEqual(liveResult.liveSnapshot);
  });

  it('takes live sources or a snapshot, not both', async () => {
    await expect(
      run({ sourceTree: openSourceTree(liveDir), live: { origin: 'http://legacy.invalid:8080', db, fixturesLoaded: false, env }, liveSnapshot: liveResult.liveSnapshot }),
    ).rejects.toThrow('generateInventory takes live sources or a live snapshot, not both');
  });
});


describe('unoriented relations', () => {
  it('keeps every unoriented edge the relation extraction returned apart from relations[], counts it and renders it', () => {
    const extracted = relationRuns[0]?.unoriented ?? [];
    const inv = first.inventory;
    expect(extracted.length).toBeGreaterThan(0);
    expect(inv.unorientedRelations).toEqual(extracted);
    expect(inv.counts.relations.unknownOrientation).toBe(inv.unorientedRelations.length);
    const ordered = new Set(inv.relations.map((r) => r.id));
    expect(inv.unorientedRelations.filter((r) => ordered.has(r.id) || r.orientation !== 'unknown')).toEqual([]);
    for (const r of inv.unorientedRelations) {
      expect(first.markdown).toContain(`| \`${r.id}\` | ${r.kind} | \`${r.source.path}:${String(r.source.lines[0])}\` |`);
    }
  });
});

describe('entry references', () => {
  type Referenced = EntryReferences & Pick<DispositionFields, 'haltedBy'> & { id: string };
  const REF = 'AAP 0.3.2';
  const HALTED = 'EX-TEST-HALTED';
  const FIX = 'EX-TEST-FIX';

  /** Action variants, front-end entries and routes of `inv`, by id. */
  function entriesOf(inv: LegacyInventory): Map<string, Referenced> {
    const entries: Referenced[] = [...inv.controllers.flatMap((c) => c.actions.flatMap((a) => a.variants)), ...inv.frontEnd, ...inv.routes];
    return new Map(entries.map((e) => [e.id, e]));
  }

  let held: Map<string, Referenced>;
  beforeAll(async () => {
    const exceptions: ExceptionsList = {
      sourceSha: pin.sha,
      entries: [
        { id: FIX, routeKey: 'admin:cfixture.list', appliesTo: ['rest:user.findone'], decision: 'fix', status: 'open' },
        {
          id: HALTED,
          routeKey: 'admin:cfixture.update{action=add}',
          appliesTo: ['page:render', 'api:user.findone', 'admin:cfixture.remove*'],
          decision: 'preserve',
          status: 'halted',
        },
      ],
    };
    held = entriesOf((await run({ inputs: { ...inputs, exceptions } })).inventory);
  });

  it('gives every action variant, front-end entry and route both references', () => {
    const entries = [...entriesOf(first.inventory).values()];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => !('exceptionRef' in e) || !('expected' in e))).toEqual([]);
  });

  it.each([
    ['ctl:cfixture.update{action=add}', null],
    ['fe:render', { disposition: 'legacy-served', owningService: null, ref: REF }],
    ['api:user.delete', { disposition: 'decision', owningService: null, ref: REF }],
    ['rest:group.findone', { disposition: 'carry', owningService: 'identity', ref: REF }],
    ['rte:/tasks/widgets', { disposition: 'legacy-served', owningService: null, ref: REF }],
  ])('records the plan expectation of %s as %j', (id, expected) => {
    expect(entriesOf(first.inventory).get(id)?.expected).toEqual(expected);
  });

  it.each([
    ['ctl:cfixture.update{action=add}', HALTED, HALTED],
    ['ctl:cfixture.remove{confirmed}', HALTED, HALTED],
    ['fe:render', HALTED, HALTED],
    ['api:user.findone', HALTED, HALTED],
    ['ctl:cfixture.list', null, FIX],
    ['rest:user.findone', null, FIX],
    ['ctl:cfixture.update', null, null],
  ])('gives %s the exceptionRef %s and haltedBy %s', (id, exceptionRef, haltedBy) => {
    expect(held.get(id)).toMatchObject({ exceptionRef, haltedBy });
  });
});

describe('determinism and check mode', () => {
  it('produces byte-identical JSON and Markdown on a second run', async () => {
    extract.mockClear();
    const second = await run();
    expect(extract).toHaveBeenCalledTimes(1);
    const outB = path.join(outRoot, 'second');
    await writeInventory(second.inventory, outB);
    for (const name of [INVENTORY_JSON, INVENTORY_MD]) {
      expect((await readFile(path.join(outB, name))).equals(await readFile(path.join(outA, name))), name).toBe(true);
    }
  });

  it('reads a given source tree without extracting', async () => {
    extract.mockClear();
    const fromTree = await run({ sourceTree: openSourceTree(archiveDir) });
    expect(extract).not.toHaveBeenCalled();
    expect(fromTree.extractDir).toBeNull();
    expect(stableStringify(fromTree.inventory)).toBe(stableStringify(first.inventory));
    expect(fromTree.markdown).toBe(first.markdown);
  });

  it('check mode matches the files a run wrote', async () => {
    expect(await checkInventory(first, outA)).toEqual({
      json: { match: true, firstDifference: null },
      markdown: { match: true, firstDifferingLine: null },
    });
  });

  it('check mode reports the changed field and line without rewriting either file', async () => {
    const copy = await modifiedCopy(outA, 'check-modified');
    expect(await checkInventory(first, copy.dir)).toEqual({
      json: { match: false, firstDifference: '$.counts.frontEnd' },
      markdown: { match: false, firstDifferingLine: 4 },
    });
    expect(await readFile(path.join(copy.dir, INVENTORY_JSON), 'utf8')).toBe(copy.json);
    expect(await readFile(path.join(copy.dir, INVENTORY_MD), 'utf8')).toBe(copy.markdown);
  });

  it.each([
    { name: 'absent files', json: null, difference: '$ (file absent)' },
    { name: 'JSON that does not parse', json: () => '{', difference: '$ (committed file is not valid JSON)' },
    {
      name: 'equal values serialised differently',
      json: () => JSON.stringify(first.inventory),
      difference: '$ (equal values, different serialisation)',
    },
  ])('check mode reports $name', async ({ name, json, difference }) => {
    const dir = path.join(outRoot, `check-${name.replaceAll(' ', '-')}`);
    if (json !== null) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, INVENTORY_JSON), json(), 'utf8');
      await writeFile(path.join(dir, INVENTORY_MD), first.markdown, 'utf8');
    }
    expect(await checkInventory(first, dir)).toEqual({
      json: { match: false, firstDifference: difference },
      markdown: json === null ? { match: false, firstDifferingLine: 1 } : { match: true, firstDifferingLine: null },
    });
  });

  it('check mode rethrows a read failure other than a missing file', async () => {
    await expect(checkInventory(first, path.join(outA, INVENTORY_JSON))).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it.each([
    { keepExtract: false, kept: false },
    { keepExtract: true, kept: true },
  ])('with keepExtract $keepExtract the extraction is kept: $kept', async ({ keepExtract, kept }) => {
    extract.mockClear();
    const result = await run({ keepExtract });
    const dir = await extractedDir();
    expect(extract).toHaveBeenCalledWith(pin.sha);
    expect(result.extractDir).toBe(kept ? dir : null);
    expect(existsSync(path.join(dir, STARTUP_PATH))).toBe(kept);
  });

  it('removes the extraction when generation fails', async () => {
    extract.mockClear();
    await expect(generateInventory({ inputs })).rejects.toThrow(/expected 37 \S+ files, found 1/);
    expect(existsSync(await extractedDir())).toBe(false);
  });

  it('refuses to write an inventory stamped with another SHA', async () => {
    const dir = path.join(outRoot, 'wrong-sha');
    await expect(writeInventory({ ...first.inventory, sourceSha: '0'.repeat(40) }, dir)).rejects.toThrow(/differs from the pinned SHA/);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    { a: { x: [1, { y: 'a' }] }, b: { x: [1, { y: 'a' }] }, at: null },
    { a: { x: [1, 2] }, b: { x: [1] }, at: '$.x[1]' },
    { a: { b: 1, a: { c: 1 } }, b: { b: 2, a: { c: 2 } }, at: '$.a.c' },
    { a: { only: 1 }, b: {}, at: '$.only' },
    { a: [1], b: { 0: 1 }, at: '$' },
  ])('firstJsonDifference finds $at', ({ a, b, at }) => {
    expect(firstJsonDifference(a, b)).toBe(at);
  });
});

describe('main', () => {
  let expectedDir = '';
  let expected: GenerateResult;

  beforeAll(async () => {
    defaults.state.inputs = inputs;
    extract.mockImplementation(() => extractCopy(fullArchiveDir));
    expected = await generateInventory({ inputs, sourceTree: openSourceTree(fullArchiveDir) });
    expectedDir = path.join(outRoot, 'main-expected');
    await writeInventory(expected.inventory, expectedDir);
  });

  afterAll(() => {
    defaults.state.inputs = null;
    extract.mockImplementation(() => extractCopy(archiveDir));
  });

  it('writes into --out what generateInventory and writeInventory write, and reports the kept extraction', async () => {
    extract.mockClear();
    const out = path.join(outRoot, 'main-write');
    const outcome = await main(['--out', out, '--keep-extract']);
    const dir = await extractedDir();
    expect(extract).toHaveBeenCalledWith(pin.sha);
    expect(outcome).toEqual({
      summary: expect.objectContaining({
        wrote: [path.join(out, INVENTORY_JSON), path.join(out, INVENTORY_MD)],
        extract: dir,
        routes: expected.inventory.routes.length,
        findings: expected.inventory.findings.length,
        liveStatus: 'pending-run',
      }),
    });
    expect(existsSync(path.join(dir, STARTUP_PATH))).toBe(true);
    for (const name of [INVENTORY_JSON, INVENTORY_MD]) {
      expect((await readFile(path.join(out, name))).equals(await readFile(path.join(expectedDir, name))), name).toBe(true);
    }
  });

  it('check mode exits 0 against matching files and 1 against a changed copy it leaves unchanged', async () => {
    expect(await main(['--check', '--out', expectedDir])).toMatchObject({
      code: 0,
      summary: { wrote: [], check: { json: { match: true }, markdown: { match: true } } },
    });
    const copy = await modifiedCopy(expectedDir, 'main-modified');
    expect(await main(['--check', '--out', copy.dir])).toMatchObject({
      code: 1,
      summary: { check: { json: { match: false, firstDifference: '$.counts.frontEnd' }, markdown: { match: false, firstDifferingLine: 4 } } },
    });
    expect(await readFile(path.join(copy.dir, INVENTORY_JSON), 'utf8')).toBe(copy.json);
    expect(await readFile(path.join(copy.dir, INVENTORY_MD), 'utf8')).toBe(copy.markdown);
  });

  it('writes a --live run snapshot beside the inventory, which --check replays and holds the inventory to', async () => {
    const out = path.join(outRoot, 'main-live');
    const snapshotFile = path.join(out, LIVE_SNAPSHOT_JSON);
    const liveDb = { readOnlyQuery: () => Promise.resolve([]), close: vi.fn(() => Promise.resolve()) } as ReadOnlyMssql & { close: ReturnType<typeof vi.fn> };
    vi.mocked(createReadOnlyMssql).mockResolvedValue(liveDb);
    const liveFetch = vi.fn(async (_input: string, _init: RequestInit) =>
      Response.json({ generatedAt: '2026-11-13T00:00:00Z', bundleableBeans: [], versionedBeans: [], entities: [] }),
    );
    vi.stubGlobal('fetch', liveFetch);
    // Test value assembled at run time, not a secret.
    const key = ['opt2', 'harness', 'main', 'test'].join('-');
    try {
      expect(
        await main(['--live', '--out', out], {
          LEGACY_ORIGIN: 'http://legacy.invalid:8080',
          OPT2_STATE_DIR: path.join(tempRoot, 'state'),
          OPT2_HARNESS_KEY: key,
        }),
      ).toEqual({
        summary: expect.objectContaining({
          liveStatus: 'live',
          liveSnapshot: snapshotFile,
          wrote: [path.join(out, INVENTORY_JSON), path.join(out, INVENTORY_MD), snapshotFile],
        }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(liveFetch.mock.calls.map(([, init]) => new Headers(init.headers).get('x-opt2-harness-key'))).toEqual([key]);
    expect(liveDb.close).toHaveBeenCalledTimes(1);
    const check = (): Promise<unknown> => main(['--check', '--out', out]);
    expect(await check()).toMatchObject({
      code: 0,
      summary: { liveStatus: 'live', liveSnapshot: snapshotFile, wrote: [], check: { json: { match: true }, markdown: { match: true } } },
    });

    // One changed byte in the inventory fails the check.
    const json = await readFile(path.join(out, INVENTORY_JSON), 'utf8');
    await writeFile(path.join(out, INVENTORY_JSON), json.replace('"liveStatus":"live"', '"liveStatus":"livE"'), 'utf8');
    expect(await check()).toMatchObject({ code: 1, summary: { check: { json: { match: false }, markdown: { match: true } } } });
    await writeFile(path.join(out, INVENTORY_JSON), json, 'utf8');

    // A snapshot that no longer matches the inventory fails it at the replayed field.
    const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')) as { storedProcedures: { checkedAt: string } };
    snapshot.storedProcedures.checkedAt = '2000-01-01T00:00:00.000Z';
    await writeFile(snapshotFile, stableStringify(snapshot), 'utf8');
    expect(await check()).toMatchObject({ code: 1, summary: { check: { json: { match: false, firstDifference: '$.storedProcedureCheck.live.checkedAt' } } } });

    // Without a snapshot the run is pending-run, so the live inventory no longer matches.
    await rm(snapshotFile);
    expect(await check()).toMatchObject({ code: 1, summary: { liveStatus: 'pending-run', liveSnapshot: null, check: { json: { match: false } } } });
  });

  it('exits 1 and names the gate when a before() gate matches no pattern or override', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    defaults.state.inputs = {
      ...inputs,
      roleOverrides: { ...inputs.roleOverrides, overrides: inputs.roleOverrides.overrides.filter((o) => o.circuit !== 'cfixture') },
    };
    try {
      const outcome = await main(['--check', '--out', expectedDir]);
      expect(outcome.code).toBe(1);
      expect(outcome.summary?.unclassifiedGates).toEqual([
        { id: 'ctl:cfixture', source: expect.objectContaining({ path: 'admin/core/controllers/cfixture.cfc' }) },
      ]);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^unclassified gate ctl:cfixture at admin\/core\/controllers\/cfixture\.cfc:\d+: /));
    } finally {
      stderr.mockRestore();
      defaults.state.inputs = inputs;
    }
  });

  it.each([
    { argv: ['--bogus'], code: 2 },
    { argv: ['--out', ''], code: 2 },
    { argv: ['--check', '--live'], code: 2 },
    { argv: ['--help'], code: 0 },
  ])('exits $code for $argv', async ({ argv, code }) => {
    const written: string[] = [];
    const exit = vi.fn();
    expect(await runCli(main, { argv, stdout: { write: (chunk: string) => written.push(chunk) }, exit, command: 'inventory' })).toBe(code);
    expect(exit).toHaveBeenCalledWith(code);
    expect(written).toHaveLength(1);
  });

  it('rejects --live without a legacy origin before reading any source', async () => {
    extract.mockClear();
    await expect(main(['--live'], {})).rejects.toThrow(UsageError);
    expect(extract).not.toHaveBeenCalled();
  });
});

describe('rule facts', () => {
  it.each([
    ['admin:razuna.getnodes', { servesTable: 'trazunasettings' }],
    ['admin:carch.loadRepoManager', { runtimeCategory: 'framework-error' }],
    ['admin:csettings.sitecopyselect', { servesBranch: 'admin:csettings.sitecopy' }],
    ['admin:cplugins.list', { runtimeCategory: 'plugin' }],
    ['admin:carch.emailtest', {}],
  ])('gives the admin route %s the facts %j', (routeKey, fact) => {
    expect(adminFacts(routeKey)).toEqual(fact);
  });

  it.each([
    ['core/mura/MasaScope.cfc', { runtimeCategory: 'theme-render' }],
    ['core/mura/content/file/razuna/razunaAPI.cfc', { servesTable: 'trazunasettings' }],
    ['core/mura/formBuilder/formBuilderManager.cfc', { webRootFilesystem: true }],
    ['core/mura/email/emailManager.cfc', {}],
  ])('gives the component %s the facts %j', (componentPath, fact) => {
    expect(serviceFacts(componentPath)).toEqual(fact);
  });
});

describe('isolation', () => {
  it('leaves the archive tree and the committed inventory untouched', async () => {
    expect(await Promise.all([archiveDir, fullArchiveDir].map(snapshot))).toEqual(archivesBefore);
    expect(await Promise.all(COMMITTED.map(fileState))).toEqual(committedBefore);
  });
});

