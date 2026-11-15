import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memorySourceTree, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { CfmlComponent, ClosureContext, ComponentIndex, SourceTree } from '../../src/inventory/closure.js';
import {
  AAP_REF,
  CONTENT_SERVER_PATH,
  JOB_ID,
  SETTINGS_TEMPLATE_PATH,
  SITE_MONITOR_ENDPOINT,
  SITE_MONITOR_JOB_EXPECTED,
  SITE_MONITOR_STEPS,
  extractJobs,
  jobWriteEvidence,
  parseRegistration,
  stepId,
} from '../../src/inventory/jobs.js';
import type { JobExtraction, JobRouteKeyOptions, ScheduledJobEntry, ScheduledJobStep, SourceRef } from '../../src/inventory/jobs.js';
import { parseWriterOverrides } from '../../src/inventory/overrides.js';
import type { WriterOverrides } from '../../src/inventory/overrides.js';
import { inventoryRouteKey } from '../../src/inventory/route-keys.js';
import { STARTUP_PATH } from '../../src/inventory/services.js';
import { assertOutsideRepo } from '../../src/lib/paths.js';

const CONTENT_MANAGER = 'core/mura/content/contentManager.cfc';
const EMAIL_MANAGER = 'core/mura/email/emailManager.cfc';
const CHANGESET_MANAGER = 'core/mura/content/changesets/changesetManager.cfc';
const FEED_MANAGER = 'core/mura/feed/feedManager.cfc';
const CLUSTER_MANAGER = 'core/mura/cluster/clusterManager.cfc';
const SETTINGS_MANAGER = 'core/mura/settings/settingsManager.cfc';
const SETTINGS_BEAN = 'core/mura/settings/settingsBean.cfc';
const MURA_SCOPE = 'core/mura/MuraScope.cfc';
const CONTENT_BEAN = 'core/mura/content/contentBean.cfc';
const CACHE_DAO = 'core/mura/cache/cacheDAO.cfc';
const FILE_MANAGER = 'core/mura/content/file/fileManager.cfc';
const LOGIN_MANAGER = 'core/mura/login/loginManager.cfc';
const GHOST_MANAGER = 'core/mura/ghost/ghostManager.cfc';
const CHILD_MANAGER = 'core/mura/base/childManager.cfc';
const PARENT_MANAGER = 'core/mura/base/parentManager.cfc';
const ORPHAN_MANAGER = 'core/mura/base/orphanManager.cfc';
const LOOP_MANAGER = 'core/mura/base/loopManager.cfc';

const ROUTE_KEY_OPTIONS: JobRouteKeyOptions = { variants: [] };

/** Bean names the start-up registers, as the component index resolves them. */
const BEANS: Readonly<Record<string, string>> = {
  contentmanager: CONTENT_MANAGER,
  emailmanager: EMAIL_MANAGER,
  changesetmanager: CHANGESET_MANAGER,
  feedmanager: FEED_MANAGER,
  clustermanager: CLUSTER_MANAGER,
  settingsmanager: SETTINGS_MANAGER,
  settingsbean: SETTINGS_BEAN,
  $: MURA_SCOPE,
  content: CONTENT_BEAN,
  cachedao: CACHE_DAO,
  filemanager: FILE_MANAGER,
  loginmanager: LOGIN_MANAGER,
  ghostmanager: GHOST_MANAGER,
  childmanager: CHILD_MANAGER,
  orphanmanager: ORPHAN_MANAGER,
  loopmanager: LOOP_MANAGER,
};

/** The handler's site-monitor branch, modelled on contentServer.cfc handleAPIRequest. */
const CONTENT_SERVER = [
  '<cfcomponent extends="mura.cfobject" output="false">',
  '<cffunction name="handleAPIRequest" output="false">',
  '\t<cfargument name="path" default="#cgi.path_info#">',
  '\t<cfset var fileendpoint="/_api/render/">',
  '\t<cfset var sitemonitorendpoint="/_api/sitemonitor">',
  '\t<cfif left(arguments.path,len(fileendpoint)) eq fileendpoint>',
  '\t\t<cfreturn application.contentRenderer.renderFile(url.fileID)>',
  '\t<cfelseif left(arguments.path,len(sitemonitorendpoint)) eq sitemonitorendpoint>',
  '\t\t<cfset var theTime=now()/>',
  '\t\t<cfset var emailList="" />',
  '\t\t<cfset var theemail="" />',
  '\t\t<cfset var site="" />',
  '\t\t<cfset var rsChanges="" />',
  '',
  '\t\t<cfparam name="application.lastMonitored" default="#dateadd(\'n\',-1,theTime)#"/>',
  '\t\t<cfset var addPrev=minute(application.lastMonitored) neq minute(dateadd("n",-30,theTime))/>',
  '',
  '\t\t<cfif addPrev>',
  '\t\t\t<cfset application.contentManager.sendReminders(dateadd("n",-30,theTime)) />',
  '\t\t</cfif>',
  '',
  '\t\t<cfset application.contentManager.sendReminders(theTime) />',
  '',
  '\t\t<cfset application.emailManager.send() />',
  '',
  '\t\t<cfset application.changesetManager.publishBySchedule()>',
  '',
  '\t\t<cfloop collection="#application.settingsManager.getSites()#" item="site">',
  '\t\t\t<cfset theEmail = application.settingsManager.getSite(site).getMailServerUsername() />',
  '\t\t\t<cfif application.settingsManager.getSite(site).getEmailBroadcaster()>',
  '\t\t\t\t<cfif not listFind(emailList,theEmail)>',
  '\t\t\t\t\t<cfset application.emailManager.trackBounces(site) />',
  '\t\t\t\t\t<cfset listAppend(emailList,theEmail) />',
  '\t\t\t\t</cfif>',
  '\t\t\t</cfif>',
  '\t\t\t<cfif application.settingsManager.getSite(site).getFeedManager()>',
  '\t\t\t\t<cfset application.feedManager.doAutoImport(site)>',
  '\t\t\t</cfif>',
  '\t\t</cfloop>',
  '',
  '\t\t<cfquery name="rsChanges" datasource="#application.configBean.getDatasource()#">',
  '\t\t\tselect tcontent.siteid, tcontent.contentid from tcontent',
  '\t\t\twhere (tcontent.displaystart >=<cfqueryparam cfsqltype="cf_sql_timestamp" value="#application.lastmonitored#">',
  '\t\t\tand tcontent.displaystart <=<cfqueryparam cfsqltype="cf_sql_timestamp" value="#theTime#">)',
  '\t\t\tor (tcontent.displaystop >=<cfqueryparam cfsqltype="cf_sql_timestamp" value="#application.lastmonitored#">',
  '\t\t\tand tcontent.displaystop <=<cfqueryparam cfsqltype="cf_sql_timestamp" value="#theTime#">)',
  '\t\t</cfquery>',
  '',
  '\t\t<cfif rsChanges.recordcount>',
  '\t\t\t<cfloop query="rsChanges">',
  "\t\t\t\t<cfset application.serviceFactory.getBean('contentManager').purgeContentCache(contentBean=application.serviceFactory.getBean('content').loadBy(contentID=rsChanges.contentid,siteid=rsChanges.siteid))>",
  '\t\t\t</cfloop>',
  '\t\t\t<cfloop query="rsChanges">',
  '\t\t\t\t<cfset application.settingsManager.getSite(rsChanges.siteid).purgeCache() />',
  '\t\t\t</cfloop>',
  '\t\t</cfif>',
  '',
  '\t\t<cfset application.clusterManager.clearOldCommands()>',
  '',
  "\t\t<cfset application.serviceFactory.getBean('$').announceEvent('onGlobalMonitor') />",
  '',
  "\t\t<cfset var rsSites=application.serviceFactory.getBean('settingsManager').getList()>",
  '',
  '\t\t<cfloop query="rsSites">',
  "\t\t\t<cfset application.serviceFactory.getBean('$').init(rsSites.siteid).announceEvent('onSiteMonitor') />",
  '\t\t</cfloop>',
  '',
  '\t\t<cfset application.lastMonitored=theTime/>',
  '',
  '\t\t<cfreturn "">',
  '\t<cfelseif left(path,len("/tasks/widgets/")) eq "/tasks/widgets/">',
  '\t\t<cfreturn "">',
  '\t</cfif>',
  '</cffunction>',
  '</cfcomponent>',
  '',
].join('\n');

/** The start-up's scheduled-task block, modelled on onApplicationStart_include.cfm. */
const STARTUP = [
  '<cfscript>',
  '\tstructDelete(application,"proxyServices");',
  '\t//  Set up scheduled tasks',
  '\tif ( (len(application.configBean.getServerPort())-1) < 1 ) {',
  '\t\tvariables.port=80;',
  '\t} else {',
  '\t\tvariables.port=right(application.configBean.getServerPort(),len(application.configBean.getServerPort())-1);',
  '\t}',
  "\tif ( listFindNoCase('Railo,Lucee',application.configBean.getCompiler()) ) {",
  '\t\tvariables.siteMonitorTask="siteMonitor";',
  '\t} else {',
  '\t\tvariables.siteMonitorTask="#application.configBean.getWebRoot()#/index.cfm/_api/sitemonitor/";',
  '\t}',
  '\ttry {',
  '\t\tif ( isBoolean(variables.iniProperties.ping) && variables.iniProperties.ping ) {',
  '\t\t\tlocal.updateurl = "http://" & listFirst(cgi.http_host,":") & application.configBean.getContext() & "/index.cfm/_api/sitemonitor/";',
  "\t\t\tapplication.serviceFactory.getBean('utility').scheduleTask(",
  '\t\t\t\taction = "update",',
  '\t\t\t\ttask = "#variables.siteMonitorTask#",',
  '\t\t\t\toperation = "HTTPRequest",',
  '\t\t\t\turl = "#local.updateurl#",',
  '\t\t\t\tport="#variables.port#",',
  "\t\t\t\tstartDate = \"#dateFormat(now(),'mm/dd/yyyy')#\",",
  '\t\t\t\tstartTime = "#createTime(0,15,0)#",',
  '\t\t\t\tpublish = "No",',
  '\t\t\t\tinterval = "900",',
  '\t\t\t\trequestTimeOut = "600"',
  '\t\t\t);',
  '\t\t}',
  '\t} catch (any cfcatch) {',
  '\t}',
  '',
  '\t//BEGIN CONFIG DIR MANAGEMENT',
  '\tif ( !fileExists(application.configBean.getWebRoot() & "/config/Application.cfc") ) {',
  '\t\tvariables.configDir = "";',
  '\t}',
  '</cfscript>',
  '',
].join('\n');

/** Settings-template excerpt declaring the ping default. */
const SETTINGS_TEMPLATE = ['[settings]', 'appreloadkey=appreload', 'mode=production', '[production]', 'ping=false', 'plugindir=', ''].join('\n');

function tagCfc(functions: string, attrs = 'extends="mura.cfobject"'): string {
  return `<cfcomponent ${attrs} output="false">\n${functions}</cfcomponent>\n`;
}

/** A method whose only effect is one delete from `table`. */
function writer(name: string, table: string, args = ''): string {
  return [
    `<cffunction name="${name}" output="false">`,
    ...(args === '' ? [] : [`\t<cfargument name="${args}">`]),
    '\t<cfquery>',
    `\t\tDELETE FROM ${table} WHERE created < <cfqueryparam cfsqltype="cf_sql_timestamp" value="#now()#">`,
    '\t</cfquery>',
    '</cffunction>',
    '',
  ].join('\n');
}

function method(name: string, body = '', args = ''): string {
  return [
    `<cffunction name="${name}" output="false">`,
    ...(args === '' ? [] : [`\t<cfargument name="${args}">`]),
    ...(body === '' ? [] : [body]),
    '</cffunction>',
    '',
  ].join('\n');
}

/** Archive files of the legacy-modelled tree. */
const BASE_FILES: Readonly<Record<string, string>> = {
  [CONTENT_SERVER_PATH]: CONTENT_SERVER,
  [STARTUP_PATH]: STARTUP,
  [SETTINGS_TEMPLATE_PATH]: SETTINGS_TEMPLATE,
  [CONTENT_MANAGER]: tagCfc(writer('sendReminders', 'tcontenteventreminders', 'theTime') + writer('purgeContentCache', 'tcontentcache', 'contentBean')),
  [EMAIL_MANAGER]: tagCfc(writer('send', 'temailsends') + writer('trackBounces', 'temailbouncestats', 'siteid')),
  [CHANGESET_MANAGER]: tagCfc(writer('publishBySchedule', 'tchangesets')),
  [FEED_MANAGER]: tagCfc(writer('doAutoImport', 'tcontentfeedimports', 'siteid')),
  [CLUSTER_MANAGER]: tagCfc(writer('clearOldCommands', 'tclustercommands')),
  [SETTINGS_MANAGER]: tagCfc(method('getSites', '\t<cfreturn {}>') + method('getSite', '\t<cfreturn "">', 'siteid') + method('getList', '\t<cfreturn "">')),
  [SETTINGS_BEAN]: tagCfc(writer('purgeCache', 'tsettingscache')),
  [MURA_SCOPE]: tagCfc(method('init', '\t<cfreturn this>', 'siteid') + method('announceEvent', '', 'eventName')),
  [CONTENT_BEAN]: tagCfc(method('loadBy', '\t<cfreturn this>')),
};

/** 1-based line of the only line of `text` containing `needle`. */
function lineWith(text: string, needle: string): number {
  const hits = text.split('\n').flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
  const [hit] = hits;
  if (hits.length !== 1 || hit === undefined) throw new Error(`${JSON.stringify(needle)} is on ${hits.length} lines`);
  return hit;
}

function src(file: string, from: number, to = from): SourceRef {
  return { path: file, lines: [from, to] };
}

/** Handler source of the base fixture from the line holding `from` to the line holding `to`, plus `extra` lines. */
function cs(from: string, to = from, extra = 0): SourceRef {
  return src(CONTENT_SERVER_PATH, lineWith(CONTENT_SERVER, from), lineWith(CONTENT_SERVER, to) + extra);
}

function startupLine(needle: string): number {
  return lineWith(STARTUP, needle);
}

/** Component index over `source` with {@link BEANS} registered. */
function indexFor(source: SourceTree): ComponentIndex {
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => BEANS[name.toLowerCase()] ?? null,
    ormTable: () => null,
    parsed(p) {
      if (!parsed.has(p)) parsed.set(p, p.endsWith('.cfc') && source.exists(p) ? parseCfmlComponent(p, source.readText(p)) : null);
      return parsed.get(p) ?? null;
    },
  };
}

/** In-memory tree of the base files with `changes` applied; an undefined value removes the file. */
function variantTree(changes: Readonly<Record<string, string | undefined>>): SourceTree {
  const files = new Map<string, string>(Object.entries(BASE_FILES));
  for (const [rel, text] of Object.entries(changes)) {
    if (text === undefined) files.delete(rel);
    else files.set(rel, text);
  }
  return memorySourceTree(files);
}

function variantContext(changes: Readonly<Record<string, string | undefined>>, overrides?: WriterOverrides): ClosureContext {
  const source = variantTree(changes);
  return overrides === undefined ? { tree: source, index: indexFor(source) } : { tree: source, index: indexFor(source), overrides };
}

function onlyJob(result: JobExtraction): ScheduledJobEntry {
  const [only] = result.scheduledJobs;
  if (result.scheduledJobs.length !== 1 || only === undefined) throw new Error('expected exactly one scheduled job');
  return only;
}

function stepNamed(entry: ScheduledJobEntry, step: string): ScheduledJobStep {
  const found = entry.steps.find((s) => s.step === step);
  if (found === undefined) throw new Error(`no step ${step}`);
  return found;
}

/** A handler whose site-monitor branch is the last branch, holding `lines`. */
function handler(lines: readonly string[], tail: readonly string[] = ['\t</cfif>']): string {
  return [
    '<cfcomponent extends="mura.cfobject" output="false">',
    '<cffunction name="describeEndpoint" output="false">',
    '\t<cfset var endpoint="/_api/sitemonitor/">',
    '\t<cfreturn endpoint>',
    '</cffunction>',
    '<cffunction name="handleAPIRequest" output="false">',
    '\t<cfset var monitorendpoint="/_api/sitemonitor/">',
    '\t<cfif left(arguments.path,len(monitorendpoint)) eq monitorendpoint>',
    ...lines,
    ...tail,
    '</cffunction>',
    '</cfcomponent>',
    '',
  ].join('\n');
}

function startup(...lines: string[]): string {
  return ['<cfscript>', ...lines, '</cfscript>', ''].join('\n');
}

const REGISTER = 'scheduleTask(task = "monitor", url = "/_api/sitemonitor/", interval = "900", requestTimeOut = "600");';

let root = '';
let tree: SourceTree;
let extraction: JobExtraction;
let job: ScheduledJobEntry;

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-jobs-gate-'));
  for (const [rel, text] of Object.entries(BASE_FILES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  tree = openSourceTree(root);
  extraction = await extractJobs({ tree, index: indexFor(tree) }, { routeKeyOptions: ROUTE_KEY_OPTIONS });
  job = onlyJob(extraction);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scheduled-job constants', () => {
  it('name the job, its archive inputs, its endpoint and the plan reference', () => {
    expect(JOB_ID).toBe('job:sitemonitor');
    expect(CONTENT_SERVER_PATH).toBe('core/mura/content/contentServer.cfc');
    expect(SETTINGS_TEMPLATE_PATH).toBe('core/templates/settings.template.cfm');
    expect(SITE_MONITOR_ENDPOINT).toBe('/_api/sitemonitor');
    expect(AAP_REF).toBe('AAP 0.3.2');
    expect(SITE_MONITOR_JOB_EXPECTED).toEqual({ disposition: 'carry', owningService: 'programs-sites', ref: AAP_REF });
    expect(Object.isFrozen(SITE_MONITOR_JOB_EXPECTED)).toBe(true);
    expect(stepId('bounces')).toBe('job:sitemonitor.bounces');
  });

  it('list the eight planned steps in order with their gates, owners and frozen action lists', () => {
    expect(SITE_MONITOR_STEPS.map((s) => [s.step, s.actions, s.perSite, s.gateFlag, s.expected.disposition, s.expected.owningService])).toEqual([
      ['reminders', ['contentmanager.sendreminders'], false, null, 'decision', null],
      ['email-send', ['emailmanager.send'], false, null, 'legacy-served', 'communications'],
      ['changeset-publish', ['changesetmanager.publishbyschedule'], false, null, 'carry', 'strategies-content'],
      ['bounces', ['emailmanager.trackbounces'], true, 'EmailBroadcaster', 'legacy-served', 'communications'],
      ['feed-import', ['feedmanager.doautoimport'], true, 'FeedManager', 'carry', 'strategies-content'],
      ['cache-purge', ['contentmanager.purgecontentcache', 'settingsbean.purgecache'], false, null, 'legacy-served', 'strategies-content'],
      ['cluster-cleanup', ['clustermanager.clearoldcommands'], false, null, 'decision', null],
      ['plugin-events', ['*.announceevent'], true, null, 'decision', null],
    ]);
    expect(Object.isFrozen(SITE_MONITOR_STEPS)).toBe(true);
    for (const spec of SITE_MONITOR_STEPS) {
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.actions)).toBe(true);
      expect(Object.isFrozen(spec.expected)).toBe(true);
      expect(spec.expected.ref).toBe(AAP_REF);
    }
  });
});

describe('parseRegistration over the start-up excerpt', () => {
  it('reads the ping-gated HTTP task with its schedule, URL template, engine task names and setting default', () => {
    expect(parseRegistration(tree)).toEqual({
      type: 'ACF HTTPRequest task',
      taskName: 'siteMonitor (Lucee/Railo) or <webroot>/index.cfm/_api/sitemonitor/',
      url: '/index.cfm/_api/sitemonitor/',
      urlTemplate: 'http://<host><context>/index.cfm/_api/sitemonitor/',
      operation: 'HTTPRequest',
      publish: 'No',
      startTime: '00:15',
      intervalSeconds: 900,
      requestTimeoutSeconds: 600,
      condition: 'ping is true',
      conditionExpression: 'isBoolean(variables.iniProperties.ping) && variables.iniProperties.ping',
      source: src(STARTUP_PATH, startupLine('//  Set up scheduled tasks'), startupLine('} catch (any cfcatch) {') + 1),
      conditionSource: src(STARTUP_PATH, startupLine('if ( isBoolean(')),
      pingDefault: { value: false, source: src(SETTINGS_TEMPLATE_PATH, lineWith(SETTINGS_TEMPLATE, 'ping=')) },
      liveTask: null,
      livePing: null,
      liveStatus: 'pending-run',
    });
  });

  it.each([
    {
      name: 'a literal task and absolute URL under a non-flag condition',
      text: startup(
        '\tif (variables.iniProperties.ping eq "yes") {',
        '\t\tscheduleTask(task = "siteMonitor", operation = "HTTPRequest", url = "http://localhost/index.cfm/_api/sitemonitor", publish = "Yes", startTime = "#createTime(1,2,30)#", interval = "60", requestTimeOut = "30");',
        '\t}',
      ),
      settings: SETTINGS_TEMPLATE,
      expected: {
        taskName: 'siteMonitor',
        url: '/index.cfm/_api/sitemonitor',
        urlTemplate: 'http://localhost/index.cfm/_api/sitemonitor',
        publish: 'Yes',
        startTime: '01:02:30',
        intervalSeconds: 60,
        requestTimeoutSeconds: 30,
        condition: 'variables.iniProperties.ping eq "yes"',
        source: src(STARTUP_PATH, 2, 4),
        conditionSource: src(STARTUP_PATH, 2),
        pingDefault: { value: false, source: src(SETTINGS_TEMPLATE_PATH, 5) },
      },
    },
    {
      name: 'a condition that reads no ini property',
      text: startup('\tif (application.ping) {', `\t\t${REGISTER}`, '\t}'),
      settings: SETTINGS_TEMPLATE,
      expected: { condition: 'application.ping', conditionExpression: 'application.ping', pingDefault: null, startTime: '', publish: '' },
    },
    {
      name: 'a settings template that is absent',
      text: startup('\tif (isBoolean(variables.iniProperties.ping) && variables.iniProperties.ping) {', `\t\t${REGISTER}`, '\t}'),
      settings: undefined,
      expected: { condition: 'ping is true', pingDefault: null },
    },
    {
      name: 'a settings template without the setting',
      text: startup('\tif (isBoolean(variables.iniProperties.ping) and variables.iniProperties.ping) {', `\t\t${REGISTER}`, '\t}'),
      settings: '[settings]\nmode=production\n',
      expected: { condition: 'ping is true', pingDefault: null },
    },
    {
      name: 'a non-boolean setting default on a CRLF line',
      text: startup('\tif (isBoolean(variables.iniProperties.ping) && variables.iniProperties.ping) {', `\t\t${REGISTER}`, '\t}'),
      settings: '[settings]\r\nping=${PING}\r\n',
      expected: { pingDefault: { value: '${PING}', source: src(SETTINGS_TEMPLATE_PATH, 2) } },
    },
    {
      name: 'mentions inside strings and tasks for other URLs before the site-monitor task',
      text: startup(
        '\tvariables.note = "scheduleTask(url=\'/_api/sitemonitor\')";',
        '\tscheduleTask(task = "other", url = "/tasks/other", interval = "1", requestTimeOut = "1");',
        '\tif (variables.enabled) {',
        '\t\tscheduleTask(task = "monitor", url = "/_api/sitemonitor/", startTime = "00:15", interval = "900", requestTimeOut = "600");',
        '\t}',
      ),
      settings: SETTINGS_TEMPLATE,
      expected: { taskName: 'monitor', url: '/_api/sitemonitor/', startTime: '00:15', condition: 'variables.enabled', source: src(STARTUP_PATH, 4, 6) },
    },
    {
      name: 'a URL assigned across an if, else if and else chain',
      text: startup(
        '\tif (variables.a) {',
        '\t\tvariables.u = "/first";',
        '\t} else if (variables.b) {',
        '\t\tvariables.u = "/second";',
        '\t} else {',
        '\t\tvariables.u = "/index.cfm" & "/_api/sitemonitor/";',
        '\t}',
        '\tif (variables.c) {',
        '\t\tscheduleTask(task = "monitor", url = "#variables.u#", startTime = "#createTime(0,15)#", interval = "900", requestTimeOut = "600");',
        '\t}',
      ),
      settings: SETTINGS_TEMPLATE,
      expected: { url: '/index.cfm/_api/sitemonitor/', urlTemplate: '/index.cfm/_api/sitemonitor/', startTime: '00:15', source: src(STARTUP_PATH, 2, 11), conditionSource: src(STARTUP_PATH, 9) },
    },
    {
      name: 'a guarded task inside try, catch and finally blocks',
      text: startup(
        '\ttry {',
        '\t\tif (variables.enabled) {',
        `\t\t\t${REGISTER}`,
        '\t\t}',
        '\t} catch (any e) {',
        '\t} finally {',
        '\t\tvariables.done = true;',
        '\t}',
        '\tvariables.after = 1;',
      ),
      settings: SETTINGS_TEMPLATE,
      expected: { source: src(STARTUP_PATH, 2, 9), conditionSource: src(STARTUP_PATH, 3) },
    },
    {
      name: 'interpolated expressions without a known placeholder',
      text: startup(
        '\tvariables.taskName = "monitor-" & variables.suffix;',
        '\tif (variables.enabled) {',
        '\t\tlocal.u = "http://" & variables.host & "/_api/sitemonitor/";',
        '\t\tscheduleTask(task = "#variables.taskName#", url = "#local.u#", interval = "900", requestTimeOut = "600");',
        '\t}',
      ),
      settings: SETTINGS_TEMPLATE,
      expected: { taskName: 'monitor-<variables.suffix>', url: '/_api/sitemonitor/', urlTemplate: 'http://<variables.host>/_api/sitemonitor/', source: src(STARTUP_PATH, 2, 6) },
    },
  ])('reads $name', ({ text, settings, expected }) => {
    expect(parseRegistration(variantTree({ [STARTUP_PATH]: text, [SETTINGS_TEMPLATE_PATH]: settings }))).toMatchObject(expected);
  });

  it.each([
    {
      name: 'no call registers the endpoint',
      text: ['<cfscript>', '\tvariables.note = "a ""quoted"" note";', '\tscheduleTask(task = "other", url = "/tasks/other", interval = "1", requestTimeOut = "1");', '\tscheduleTask(url = "/_api/sitemonitor/'].join('\n'),
      message: `${STARTUP_PATH}: no scheduleTask call registers /_api/sitemonitor`,
    },
    { name: 'the call is unguarded', text: startup(`\t${REGISTER}`), message: 'is not guarded by an if' },
    { name: 'the call sits directly in a try block', text: startup('\ttry {', `\t\t${REGISTER}`, '\t} catch (any e) {', '\t}'), message: 'is not guarded by an if' },
    { name: 'the call sits in an else branch', text: startup('\tif (variables.a) {', '\t} else {', `\t\t${REGISTER}`, '\t}'), message: 'is not guarded by an if' },
    { name: 'the call sits in a function body', text: startup('\tfunction setup() {', `\t\t${REGISTER}`, '\t}'), message: 'is not guarded by an if' },
    { name: 'the call sits in an else block after a braceless if', text: startup('\tif (variables.a) variables.b = 1; else {', `\t\t${REGISTER}`, '\t}'), message: 'is not guarded by an if' },
    { name: 'the URL variable is never assigned', text: startup('\tif (variables.a) {', '\t\tscheduleTask(task = "monitor", url = "#local.neverSet#", interval = "900", requestTimeOut = "600");', '\t}'), message: `${STARTUP_PATH}: local.neverSet is never assigned before the scheduleTask call` },
    { name: 'the interval is not a number of seconds', text: startup('\tif (variables.a) {', '\t\tscheduleTask(task = "monitor", url = "/_api/sitemonitor/", interval = "#variables.every#", requestTimeOut = "600");', '\t}'), message: 'scheduleTask interval "#variables.every#" is not a number of seconds' },
    { name: 'the request timeout is missing', text: startup('\tif (variables.a) {', '\t\tscheduleTask(task = "monitor", url = "/_api/sitemonitor/", interval = "900");', '\t}'), message: 'scheduleTask requestTimeOut undefined is not a number of seconds' },
    { name: 'the enclosing try block is never closed', text: ['<cfscript>', 'try {', '\tif (variables.a) {', `\t\t${REGISTER}`, '\t}', ''].join('\n'), message: 'unbalanced braces after offset' },
  ])('throws when $name', ({ text, message }) => {
    expect(() => parseRegistration(variantTree({ [STARTUP_PATH]: text }))).toThrow(message);
  });
});

describe('extractJobs over the legacy-modelled tree', () => {
  it('emits one scheduler-triggered job keyed by the requested route and spanning the handler branch', async () => {
    const routeKey = (await inventoryRouteKey({ kind: 'path', httpMethod: 'GET', path: '/index.cfm/_api/sitemonitor/' }, ROUTE_KEY_OPTIONS)).key;
    expect(extraction.scheduledJobs).toHaveLength(1);
    expect(job.id).toBe(JOB_ID);
    expect(job.routeKey).toBe(routeKey);
    expect(job.trigger).toBe('scheduler');
    expect(job.expected).toBe(SITE_MONITOR_JOB_EXPECTED);
    expect(job.source).toEqual(cs('eq sitemonitorendpoint>', '<cfset application.lastMonitored=theTime/>', 2));
    expect(job.registration).toEqual(parseRegistration(tree));
  });

  it('finds every planned step in the planned order, so no difference is reported', () => {
    expect(job.steps.map((s) => [s.order, s.id, s.step])).toEqual(SITE_MONITOR_STEPS.map((s, i) => [i + 1, stepId(s.step), s.step]));
    expect(extraction.differences).toEqual([]);
  });

  it.each([
    {
      step: 'reminders',
      source: cs('<cfset var addPrev', 'sendReminders(theTime)'),
      call: 'contentManager.sendReminders (catch-up at now - 30 min when the minutes differ)',
      tables: ['tcontenteventreminders'],
      perSite: false,
    },
    { step: 'email-send', source: cs('emailManager.send()'), call: 'emailManager.send', tables: ['temailsends'], perSite: false },
    { step: 'changeset-publish', source: cs('publishBySchedule()'), call: 'changesetManager.publishBySchedule', tables: ['tchangesets'], perSite: false },
    {
      step: 'bounces',
      source: cs('<cfloop collection=', '<cfset listAppend', 2),
      call: 'emailManager.trackBounces per site with EmailBroadcaster; mail-server dedupe ineffective (listAppend result discarded)',
      tables: ['temailbouncestats'],
      perSite: true,
    },
    { step: 'feed-import', source: cs('getFeedManager()>', 'doAutoImport', 1), call: 'feedManager.doAutoImport per site with FeedManager', tables: ['tcontentfeedimports'], perSite: true },
    {
      step: 'cache-purge',
      source: cs('<cfquery name="rsChanges"', '.purgeCache() />', 2),
      call: 'contentManager.purgeContentCache and settingsBean.purgeCache for display windows in [lastMonitored, now]',
      tables: ['tcontentcache', 'tsettingscache'],
      perSite: false,
    },
    { step: 'cluster-cleanup', source: cs('clearOldCommands()'), call: 'clusterManager.clearOldCommands', tables: ['tclustercommands'], perSite: false },
    {
      step: 'plugin-events',
      source: cs("announceEvent('onGlobalMonitor')", "announceEvent('onSiteMonitor')", 1),
      call: 'announceEvent onGlobalMonitor, then onSiteMonitor per site',
      tables: [],
      perSite: true,
    },
  ])('records the $step step with its own source span, call text and write set', ({ step, source, call, tables, perSite }) => {
    const s = stepNamed(job, step);
    const spec = SITE_MONITOR_STEPS.find((x) => x.step === step);
    expect(s.source).toEqual(source);
    expect(s.call).toBe(call);
    expect(s.tables).toEqual(tables);
    expect(s.perSite).toBe(perSite);
    expect(s.trigger).toBe('scheduler');
    expect(s.gating?.flag ?? null).toBe(spec?.gateFlag);
    expect(s.expected).toBe(spec?.expected);
    expect(s.targetMechanism).toBe(spec?.targetMechanism);
    expect(s.stateThisRun).toBe(spec?.stateThisRun);
    expect(s.closure.tables).toEqual(tables);
    expect(s.writeSet).toBe(s.closure.writes);
    expect(s.writeSet.map((w) => [w.table, w.op, w.trigger, w.conditional])).toEqual(tables.map((t) => [t, 'delete', 'scheduler', false]));
    expect([s.conditionalWrites, s.fileStoreWrite, s.unresolved, s.overrides]).toEqual([[], false, [], []]);
  });

  it('records each call as written, resolving a getSite result to the settings bean and noting events and site loops', () => {
    expect(stepNamed(job, 'reminders').calls).toEqual([
      { bean: 'contentManager', method: 'sendReminders', component: CONTENT_MANAGER, text: 'application.contentManager.sendReminders', line: cs('dateadd("n",-30,theTime)) />').lines[0], perSite: false, condition: 'addPrev', event: null },
      { bean: 'contentManager', method: 'sendReminders', component: CONTENT_MANAGER, text: 'application.contentManager.sendReminders', line: cs('sendReminders(theTime)').lines[0], perSite: false, condition: null, event: null },
    ]);
    expect(stepNamed(job, 'cache-purge').calls).toEqual([
      { bean: 'contentManager', method: 'purgeContentCache', component: CONTENT_MANAGER, text: "application.serviceFactory.getBean('contentManager').purgeContentCache", line: cs('.purgeContentCache(').lines[0], perSite: false, condition: 'rsChanges.recordcount', event: null },
      { bean: 'settingsBean', method: 'purgeCache', component: SETTINGS_BEAN, text: 'application.settingsManager.getSite(rsChanges.siteid).purgeCache', line: cs('.purgeCache() />').lines[0], perSite: false, condition: 'rsChanges.recordcount', event: null },
    ]);
    expect(stepNamed(job, 'plugin-events').calls.map((c) => [c.bean, c.method, c.component, c.line, c.perSite, c.event])).toEqual([
      ['$', 'announceEvent', MURA_SCOPE, cs("announceEvent('onGlobalMonitor')").lines[0], false, 'onGlobalMonitor'],
      ['$', 'announceEvent', MURA_SCOPE, cs("announceEvent('onSiteMonitor')").lines[0], true, 'onSiteMonitor'],
    ]);
  });

  it('gates the bounce and feed steps on their site flags inside the site loop and marks only plugin events dynamic', () => {
    const loopSource = cs('<cfloop collection=', 'doAutoImport', 2);
    expect(stepNamed(job, 'bounces').gating).toEqual({
      flag: 'EmailBroadcaster',
      condition: 'application.settingsManager.getSite(site).getEmailBroadcaster()',
      source: cs('getEmailBroadcaster()>'),
      loopSource,
    });
    expect(stepNamed(job, 'feed-import').gating).toEqual({
      flag: 'FeedManager',
      condition: 'application.settingsManager.getSite(site).getFeedManager()',
      source: cs('getFeedManager()>'),
      loopSource,
    });
    expect(job.steps.filter((s) => s.dynamic === true).map((s) => s.step)).toEqual(['plugin-events']);
  });

  it('derives the cursor, catch-up, order, gating and purge-window semantics from the handler', () => {
    expect(job.semantics).toEqual({
      cursor: {
        rule: 'application.lastMonitored defaults to now - 1 minute and is set to the run time at the end',
        variable: 'application.lastMonitored',
        default: "dateadd('n',-1,theTime)",
        source: cs('<cfparam name="application.lastMonitored"'),
        endSource: cs('<cfset application.lastMonitored=theTime/>'),
      },
      catchUp: {
        rule: 'reminders also run for now - 30 min when the minute of lastMonitored differs from the minute of now - 30 min',
        step: 'reminders',
        predicate: 'minute(application.lastMonitored) neq minute(dateadd("n",-30,theTime))',
        argument: 'dateadd("n",-30,theTime)',
        source: cs('<cfset var addPrev', '<cfif addPrev>', 2),
      },
      order: { rule: 'steps run in the fixed order of steps[]', steps: SITE_MONITOR_STEPS.map((s) => s.step), source: cs('<cfset var addPrev', "announceEvent('onSiteMonitor')", 1) },
      gating: {
        rule: 'bounces only where EmailBroadcaster is set; feed imports only where FeedManager is set; the mail-server dedupe discards the listAppend result',
        source: cs('<cfloop collection=', 'doAutoImport', 1),
        dedupeSource: cs('<cfset listAppend'),
      },
      purgeWindow: {
        rule: 'display-window purge covers [lastMonitored, now]',
        step: 'cache-purge',
        from: 'lastMonitored',
        to: 'now',
        source: cs('<cfquery name="rsChanges"', '</cfquery>'),
      },
      bounceDedupeIneffective: true,
    });
  });

  it('merges the scheduler-triggered closures of the distinct methods a step calls, entering a repeated method once', () => {
    expect(stepNamed(job, 'reminders').closure.visited).toEqual([`${CONTENT_MANAGER}#sendReminders`]);
    expect(stepNamed(job, 'cache-purge').closure.visited).toEqual([`${CONTENT_MANAGER}#purgeContentCache`, `${SETTINGS_BEAN}#purgeCache`]);
    expect(stepNamed(job, 'plugin-events').closure).toMatchObject({ tables: [], writes: [], sessionEffects: 'none', visited: [`${MURA_SCOPE}#announceEvent`] });
  });
});

describe('jobWriteEvidence', () => {
  it('yields one record per step, keyed by the job route key and carrying the step closure', () => {
    expect(jobWriteEvidence(extraction.scheduledJobs)).toEqual(job.steps.map((s) => ({ entryRouteKey: job.routeKey, trigger: 'scheduler', closure: s.closure })));
  });

  it('yields nothing without jobs', () => {
    expect(jobWriteEvidence([])).toEqual([]);
  });
});

/** Branch whose steps stray from the plan: unknown and repeated calls, other gates, a generic catch-up and a moved cursor. */
const DIVERGENT = handler(
  [
    '\t\t<cfset var started=now()/>',
    '\t\t<cfset var count=0/>',
    "\t\t<cfparam name=\"application.lastMonitored\" default=\"#dateadd('n',-5,started)#\"/>",
    '\t\t<cfif minute(application.lastMonitored) neq minute(now())>',
    '\t\t\t<cfset application.contentManager.sendReminders(now()) />',
    '\t\t</cfif>',
    '\t\t<cfset application.changesetManager.publishBySchedule()>',
    '\t\t<cfset application.emailManager.send() />',
    '\t\t<cfset application.userManager.purgeSessions() />',
    '\t\t<cfset someObj.save() />',
    '\t\t<cfset application.ghostManager.run() />',
    '\t\t<cfset application.childManager.inherited() />',
    '\t\t<cfset application.orphanManager.lost() />',
    '\t\t<cfset application.loopManager.spin() />',
    '\t\t<cfset application.emailManager.send() />',
    '\t\t<cfloop collection="#application.settingsManager.getSites()#" item="site">',
    '\t\t\t<cfif application.settingsManager.getSite(site).getMailServerUsername() neq "">',
    '\t\t\t\t<cfset application.emailManager.trackBounces(site) />',
    '\t\t\t\t<cfset listAppend(sentList,site) />',
    '\t\t\t<cfelseif application.settingsManager.getSite(site).getFeedImport()>',
    '\t\t\t\t<cfset application.feedManager.doAutoImport(site)>',
    '\t\t\t<cfelse>',
    '\t\t\t\t<cfset application.feedManager.missingMethod(site)>',
    '\t\t\t</cfif>',
    '\t\t</cfloop>',
    '\t\t<cfquery name="rs"><cfqueryparam value="#url.since#"><cfqueryparam value="#application.lastMonitored#"></cfquery>',
    '\t\t<cfset application.settingsManager.getSite("default")>',
    "\t\t<cfset application.serviceFactory.getBean('$').announceEvent(eventName) />",
    "\t\t<cfset application.serviceFactory.getBean('$').announceEvent() />",
    '\t\t<cfset application.lastMonitored=dateadd("n",1,started)/>',
  ],
  ['\t<cfelse>', '\t\t<cfif variables.other></cfif>', '\t</cfif>'],
);

/** Components the divergent branch reaches beyond the base files. */
const DIVERGENT_FILES: Readonly<Record<string, string>> = {
  [CONTENT_SERVER_PATH]: DIVERGENT,
  [CHILD_MANAGER]: tagCfc('', 'extends="mura.base.parentManager"'),
  [PARENT_MANAGER]: tagCfc(writer('inherited', 'tinherited')),
  [ORPHAN_MANAGER]: tagCfc('', 'extends="mura.base.missingParent"'),
  [LOOP_MANAGER]: tagCfc('', 'extends="mura.base.loopManager"'),
};

/** Branch with a cursor that has a plain default and no final assignment, steps out of order and a nested last branch. */
const REORDERED = handler([
  '\t\t<cfparam name="application.lastMonitored" default="#now()#"/>',
  '\t\t<cfset application.note = "a ""quoted"" note">',
  '\t\t<cfif application.flag>',
  '\t\t\t<cfif application.other>',
  '\t\t\t\t<cfset application.clusterManager.clearOldCommands()>',
  '\t\t\t</cfif>',
  '\t\t</cfif>',
  '\t\t<cfquery name="q"><cfqueryparam value="#url.since#"></cfquery>',
  '\t\t<cfset application.contentManager.sendReminders(now()) />',
  '\t\t</cfoutput>',
]);

/** Branch without a cursor. */
const CURSORLESS = handler([
  '\t\t<cfset var theTime=now()/>',
  '\t\t<cfif application.flag><cfset application.contentManager.sendReminders(theTime) /></cfif>',
  '\t\t<cfquery name="q"><cfqueryparam value="#theTime#"></cfquery>',
  '\t\t<cfset application.changesetManager.publishBySchedule()>',
]);

describe('extractJobs over handler variants', () => {
  it('throws when the handler component is absent or no branch tests the site-monitor endpoint', async () => {
    await expect(extractJobs(variantContext({ [CONTENT_SERVER_PATH]: undefined }), { routeKeyOptions: ROUTE_KEY_OPTIONS })).rejects.toThrow(
      `${CONTENT_SERVER_PATH} is not a component of the source tree`,
    );
    const untested = tagCfc(
      method('describeEndpoint', '\t<cfset var endpoint="/_api/sitemonitor">\n\t<cfreturn endpoint>') +
        method('handleAPIRequest', '\t<cfset var jsonendpoint="/_api/json/v1">\n\t<cfif left(arguments.path,len(jsonendpoint)) eq jsonendpoint>\n\t</cfif>'),
    );
    await expect(extractJobs(variantContext({ [CONTENT_SERVER_PATH]: untested }), { routeKeyOptions: ROUTE_KEY_OPTIONS })).rejects.toThrow(
      `${CONTENT_SERVER_PATH}: no handler branch tests the /_api/sitemonitor endpoint`,
    );
  });

  it('names unplanned and repeated steps from their calls and records the gaps their closures cannot enter', async () => {
    const divergent = onlyJob(await extractJobs(variantContext(DIVERGENT_FILES), { routeKeyOptions: ROUTE_KEY_OPTIONS }));
    const at = (needle: string): SourceRef => src(CONTENT_SERVER_PATH, lineWith(DIVERGENT, needle));
    expect(divergent.steps.map((s) => [s.order, s.step, s.call, s.tables, s.unresolved, s.expected?.disposition ?? null])).toEqual([
      [1, 'reminders', 'contentManager.sendReminders (catch-up when minute(application.lastMonitored) neq minute(now()))', ['tcontenteventreminders'], [], 'decision'],
      [2, 'changeset-publish', 'changesetManager.publishBySchedule', ['tchangesets'], [], 'carry'],
      [3, 'email-send', 'emailManager.send', ['temailsends'], [], 'legacy-served'],
      [4, 'user-manager-purge-sessions', 'userManager.purgeSessions', [], [{ expr: 'application.userManager.purgeSessions', kind: 'bean', source: at('purgeSessions') }], null],
      [5, 'call-save', '?.save', [], [{ expr: 'someObj.save', kind: 'bean', source: at('someObj.save') }], null],
      [6, 'ghost-manager-run', 'ghostManager.run', [], [{ expr: 'application.ghostManager.run', kind: 'component', source: at('ghostManager.run') }], null],
      [7, 'child-manager-inherited', 'childManager.inherited', ['tinherited'], [], null],
      [8, 'orphan-manager-lost', 'orphanManager.lost', [], [{ expr: 'application.orphanManager.lost', kind: 'method', source: at('orphanManager.lost') }], null],
      [9, 'loop-manager-spin', 'loopManager.spin', [], [{ expr: 'application.loopManager.spin', kind: 'method', source: at('loopManager.spin') }], null],
      [10, 'email-send-2', 'emailManager.send', ['temailsends'], [], null],
      [11, 'bounces', 'emailManager.trackBounces per site with MailServerUsername', ['temailbouncestats'], [], 'legacy-served'],
      [12, 'feed-import', 'feedManager.doAutoImport per site with FeedImport; sentList dedupe ineffective (listAppend result discarded)', ['tcontentfeedimports'], [], 'carry'],
      [13, 'feed-manager-missing-method', 'feedManager.missingMethod', [], [{ expr: 'application.feedManager.missingMethod', kind: 'method', source: at('missingMethod') }], null],
      [14, 'plugin-events', 'announceEvent eventName, then ? for display windows in [url.since, lastMonitored]', [], [], 'decision'],
    ]);
    const repeated = stepNamed(divergent, 'email-send-2');
    expect([repeated.id, repeated.targetMechanism, repeated.stateThisRun]).toEqual([stepId('email-send-2'), null, null]);
    expect(stepNamed(divergent, 'call-save').calls).toEqual([
      { bean: null, method: 'save', component: null, text: 'someObj.save', line: at('someObj.save').lines[0], perSite: false, condition: null, event: null },
    ]);
    expect(stepNamed(divergent, 'feed-import').gating).toMatchObject({ flag: 'FeedImport', condition: 'application.settingsManager.getSite(site).getFeedImport()', source: at('<cfelseif') });
    const ungated = stepNamed(divergent, 'feed-manager-missing-method');
    expect([ungated.gating, ungated.perSite, ungated.calls[0]?.condition]).toEqual([null, true, null]);
    expect(stepNamed(divergent, 'plugin-events').calls.map((c) => c.event)).toEqual([null, null]);
  });

  it('reports the unplanned steps, the order the plan does not keep and the gates it names differently', async () => {
    const { differences } = await extractJobs(variantContext(DIVERGENT_FILES), { routeKeyOptions: ROUTE_KEY_OPTIONS });
    const diff = (step: string, kind: string, expected: string | number | null, computed: string | number | null) => ({ jobId: JOB_ID, step, kind, expected, computed });
    expect(differences).toEqual([
      diff('cache-purge', 'missing-step', 6, null),
      diff('cluster-cleanup', 'missing-step', 7, null),
      diff('user-manager-purge-sessions', 'unexpected-step', null, 4),
      diff('call-save', 'unexpected-step', null, 5),
      diff('ghost-manager-run', 'unexpected-step', null, 6),
      diff('child-manager-inherited', 'unexpected-step', null, 7),
      diff('orphan-manager-lost', 'unexpected-step', null, 8),
      diff('loop-manager-spin', 'unexpected-step', null, 9),
      diff('email-send-2', 'unexpected-step', null, 10),
      diff('feed-manager-missing-method', 'unexpected-step', null, 13),
      diff('changeset-publish', 'order', 3, 2),
      diff('email-send', 'order', 2, 3),
      diff('bounces', 'gating', 'EmailBroadcaster', 'MailServerUsername'),
      diff('feed-import', 'gating', 'FeedManager', 'FeedImport'),
    ]);
  });

  it('states a generic catch-up, a plural cursor offset, a moved cursor end and a window bounded by another value', async () => {
    const { semantics } = onlyJob(await extractJobs(variantContext(DIVERGENT_FILES), { routeKeyOptions: ROUTE_KEY_OPTIONS }));
    const at = (needle: string, extra = 0): SourceRef => src(CONTENT_SERVER_PATH, lineWith(DIVERGENT, needle), lineWith(DIVERGENT, needle) + extra);
    expect(semantics.cursor).toEqual({
      rule: 'application.lastMonitored defaults to now - 5 minutes and is set to dateadd("n",1,started) at the end',
      variable: 'application.lastMonitored',
      default: "dateadd('n',-5,started)",
      source: at('<cfparam'),
      endSource: at('<cfset application.lastMonitored='),
    });
    expect(semantics.catchUp).toEqual({
      rule: 'reminders also run for now() when minute(application.lastMonitored) neq minute(now())',
      step: 'reminders',
      predicate: 'minute(application.lastMonitored) neq minute(now())',
      argument: 'now()',
      source: at('<cfif minute(', 2),
    });
    expect(semantics.gating).toEqual({
      rule: 'bounces only where MailServerUsername is set; feed imports only where FeedImport is set',
      source: src(CONTENT_SERVER_PATH, lineWith(DIVERGENT, '<cfloop collection='), lineWith(DIVERGENT, 'doAutoImport')),
      dedupeSource: null,
    });
    expect(semantics.purgeWindow).toEqual({ rule: 'display-window purge covers [url.since, lastMonitored]', step: 'plugin-events', from: 'url.since', to: 'lastMonitored', source: at('<cfquery name="rs">') });
    expect(semantics.bounceDedupeIneffective).toBe(false);
  });

  it('keeps a plain cursor default without an end assignment and reports steps that run out of order', async () => {
    const extracted = await extractJobs(variantContext({ [CONTENT_SERVER_PATH]: REORDERED }), { routeKeyOptions: ROUTE_KEY_OPTIONS });
    const reordered = onlyJob(extracted);
    const at = (needle: string): number => lineWith(REORDERED, needle);
    expect(reordered.source).toEqual(src(CONTENT_SERVER_PATH, at('eq monitorendpoint>'), at('</cfoutput>')));
    expect(reordered.steps.map((s) => [s.step, s.source.lines])).toEqual([
      ['cluster-cleanup', [at('application.note'), at('<cfif application.flag>') + 4]],
      ['reminders', [at('<cfquery name="q">'), at('sendReminders')]],
    ]);
    expect(reordered.semantics).toEqual({
      cursor: { rule: 'application.lastMonitored defaults to now()', variable: 'application.lastMonitored', default: 'now()', source: src(CONTENT_SERVER_PATH, at('<cfparam')), endSource: null },
      catchUp: null,
      order: { rule: 'steps run in the fixed order of steps[]', steps: ['cluster-cleanup', 'reminders'], source: src(CONTENT_SERVER_PATH, at('application.note'), at('sendReminders')) },
      gating: null,
      purgeWindow: null,
      bounceDedupeIneffective: false,
    });
    expect(extracted.differences.filter((d) => d.kind === 'order')).toEqual([
      { jobId: JOB_ID, step: 'cluster-cleanup', kind: 'order', expected: 7, computed: 1 },
      { jobId: JOB_ID, step: 'reminders', kind: 'order', expected: 1, computed: 2 },
    ]);
  });

  it('leaves cursor, catch-up and purge-window semantics empty without a cursor', async () => {
    const cursorless = onlyJob(await extractJobs(variantContext({ [CONTENT_SERVER_PATH]: CURSORLESS }), { routeKeyOptions: ROUTE_KEY_OPTIONS }));
    expect(cursorless.steps.map((s) => [s.step, s.calls.map((c) => c.condition)])).toEqual([
      ['reminders', ['application.flag']],
      ['changeset-publish', [null]],
    ]);
    expect(cursorless.semantics).toMatchObject({ cursor: null, catchUp: null, gating: null, purgeWindow: null, bounceDedupeIneffective: false });
  });

  it('reports every planned step missing when the branch performs none', async () => {
    const extracted = await extractJobs(variantContext({ [CONTENT_SERVER_PATH]: handler(['\t\t<cfreturn "">']) }), { routeKeyOptions: ROUTE_KEY_OPTIONS });
    const empty = onlyJob(extracted);
    expect(empty.steps).toEqual([]);
    expect(empty.semantics.order).toEqual({ rule: 'steps run in the fixed order of steps[]', steps: [], source: null });
    expect(extracted.differences).toEqual(SITE_MONITOR_STEPS.map((s, i) => ({ jobId: JOB_ID, step: s.step, kind: 'missing-step', expected: i + 1, computed: null })));
    expect(jobWriteEvidence(extracted.scheduledJobs)).toEqual([]);
  });
});

/** Purge methods whose closures overlap, guard writes, touch the file store, spawn threads, log out and leave gaps. */
const MERGING_FILES: Readonly<Record<string, string>> = {
  [CONTENT_MANAGER]: tagCfc(
    writer('sendReminders', 'tcontenteventreminders', 'theTime') +
      method(
        'purgeContentCache',
        [
          '\t<cfif arguments.contentBean.getIsNew()>',
          '\t\t<cfset application.cacheDAO.purge(arguments.contentBean.getSiteID())>',
          '\t\t<cfquery>DELETE FROM tcontentstats WHERE contentid = <cfqueryparam value="#arguments.contentBean.getContentID()#"></cfquery>',
          '\t\t<cfquery>DELETE FROM tcontentlog WHERE contentid = <cfqueryparam value="#arguments.contentBean.getContentID()#"></cfquery>',
          '\t\t<cfquery>DELETE FROM tcontentlog WHERE contentid IS NULL</cfquery>',
          '\t</cfif>',
          '\t<cfset application.fileManager.deleteVersion(arguments.contentBean.getFileID())>',
          '\t<cfset application.fileManager.deleteVersion(arguments.contentBean.getOldFileID())>',
          '\t<cfthread action="run" name="contentPurgeThread">',
          '\t\t<cfquery>DELETE FROM tcachequeue WHERE created < <cfqueryparam value="#now()#"></cfquery>',
          '\t</cfthread>',
          '\t<cfthread action="run" name="contentAuditThread">',
          '\t</cfthread>',
          '\t<cfset application.loginManager.logout()>',
          '\t<cfset application.ghostService.flush()>',
          '\t<cfset application.shadowService.flush()>',
        ].join('\n'),
        'contentBean',
      ),
  ),
  [SETTINGS_BEAN]: tagCfc(
    method(
      'purgeCache',
      [
        '\t<cfset application.cacheDAO.purge(variables.siteid)>',
        '\t<cfset application.fileManager.deleteAll(variables.siteid)>',
        '\t<cfthread action="run" name="sitePurgeThread">',
        '\t\t<cfquery>DELETE FROM tsitecache WHERE siteid = <cfqueryparam value="#variables.siteid#"></cfquery>',
        '\t</cfthread>',
        '\t<cfset application.phantomService.flush()>',
      ].join('\n'),
    ),
  ),
  [CACHE_DAO]: tagCfc(
    method(
      'purge',
      [
        '\t<cfquery>DELETE FROM tcontentcache WHERE siteid = <cfqueryparam value="#arguments.siteid#"></cfquery>',
        '\t<cfquery>DELETE FROM tcontentcache WHERE siteid IS NULL</cfquery>',
      ].join('\n'),
      'siteid',
    ),
  ),
  [FILE_MANAGER]: tagCfc(method('deleteVersion', '', 'fileid') + method('deleteAll', '', 'siteid')),
  [LOGIN_MANAGER]: tagCfc(method('logout')),
};

function fileLine(file: string, needle: string): number {
  return lineWith(MERGING_FILES[file] ?? '', needle);
}

/** Reviewed writers: two on the handler (inside a step span, and on the excluded cursor), one on a step method, one elsewhere. */
function mergingOverrides(): WriterOverrides {
  const writerOverride = (id: string, tables: object, component: string, name: string, source: SourceRef): object => ({
    id,
    ...tables,
    component,
    method: name,
    op: 'delete',
    source,
    routeKeys: [],
    keyScope: 'table',
    trigger: 'scheduler',
    sessionEffects: 'none',
    reason: 'reviewed site-monitor writer',
  });
  return parseWriterOverrides(
    JSON.stringify({
      sourceSha: '0'.repeat(40),
      writers: [
        writerOverride('wov:purge-window-query', { tablesFrom: { job: JOB_ID } }, CONTENT_SERVER_PATH, 'handleAPIRequest', cs('<cfquery name="rsChanges"')),
        writerOverride('wov:cursor-default', { tablesFrom: { job: JOB_ID } }, CONTENT_SERVER_PATH, 'handleAPIRequest', cs('<cfparam name="application.lastMonitored"')),
        writerOverride('wov:cluster-peers', { tables: ['tclusterpeers'] }, CLUSTER_MANAGER, 'clearOldCommands', src(CLUSTER_MANAGER, 2)),
        writerOverride('wov:feed-elsewhere', { tables: ['tfeedelsewhere'] }, FEED_MANAGER, 'neverCalled', src(FEED_MANAGER, cs('doAutoImport').lines[0])),
      ],
    }),
    'jobs-gate writer overrides',
  );
}

describe('extractJobs merging step closures', () => {
  it('unions overlapping closures, letting an unconditional sighting settle a guarded one', async () => {
    const merged = onlyJob(await extractJobs(variantContext(MERGING_FILES, mergingOverrides()), { routeKeyOptions: ROUTE_KEY_OPTIONS }));
    const { closure } = stepNamed(merged, 'cache-purge');
    expect(closure.tables).toEqual(['tcachequeue', 'tcontentcache', 'tcontentlog', 'tcontentstats', 'tsitecache']);
    expect(closure.writes.map((w) => [w.table, w.component, w.source.lines[0], w.trigger, w.conditional])).toEqual([
      ['tcachequeue', CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'tcachequeue'), 'thread', false],
      ['tcontentcache', CACHE_DAO, fileLine(CACHE_DAO, 'siteid = <cfqueryparam'), 'scheduler', false],
      ['tcontentcache', CACHE_DAO, fileLine(CACHE_DAO, 'siteid IS NULL'), 'scheduler', false],
      ['tcontentlog', CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'tcontentlog WHERE contentid ='), 'scheduler', true],
      ['tcontentlog', CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'tcontentlog WHERE contentid IS NULL'), 'scheduler', true],
      ['tcontentstats', CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'tcontentstats'), 'scheduler', true],
      ['tsitecache', SETTINGS_BEAN, fileLine(SETTINGS_BEAN, 'tsitecache'), 'thread', false],
    ]);
    expect(closure.conditionalWrites.map((c) => [c.table, c.source.lines[0], c.condition])).toEqual([
      ['tcontentlog', fileLine(CONTENT_MANAGER, 'tcontentlog WHERE contentid ='), 'arguments.contentBean.getIsNew()'],
      ['tcontentlog', fileLine(CONTENT_MANAGER, 'tcontentlog WHERE contentid IS NULL'), 'arguments.contentBean.getIsNew()'],
      ['tcontentstats', fileLine(CONTENT_MANAGER, 'tcontentstats'), 'arguments.contentBean.getIsNew()'],
    ]);
  });

  it('keeps file-store evidence, threads, the strongest session effect and every gap of the merged closures', async () => {
    const merged = onlyJob(await extractJobs(variantContext(MERGING_FILES, mergingOverrides()), { routeKeyOptions: ROUTE_KEY_OPTIONS }));
    const step = stepNamed(merged, 'cache-purge');
    expect(step.fileStoreWrite).toBe(true);
    expect(step.closure.fileStoreEvidence).toEqual([
      { component: FILE_MANAGER, method: 'deleteAll', source: src(SETTINGS_BEAN, fileLine(SETTINGS_BEAN, 'deleteAll')), conditional: false },
      { component: FILE_MANAGER, method: 'deleteVersion', source: src(CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'getFileID()')), conditional: false },
      { component: FILE_MANAGER, method: 'deleteVersion', source: src(CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'getOldFileID()')), conditional: false },
    ]);
    expect(step.closure.threads.map((t) => [t.name, t.component, t.method])).toEqual([
      ['contentPurgeThread', CONTENT_MANAGER, 'purgeContentCache'],
      ['contentAuditThread', CONTENT_MANAGER, 'purgeContentCache'],
      ['sitePurgeThread', SETTINGS_BEAN, 'purgeCache'],
    ]);
    expect(step.closure.sessionEffects).toBe('logout');
    expect(step.unresolved).toEqual([
      { expr: 'application.ghostService.flush', kind: 'bean', source: src(CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'ghostService')) },
      { expr: 'application.shadowService.flush', kind: 'bean', source: src(CONTENT_MANAGER, fileLine(CONTENT_MANAGER, 'shadowService')) },
      { expr: 'application.phantomService.flush', kind: 'bean', source: src(SETTINGS_BEAN, fileLine(SETTINGS_BEAN, 'phantomService')) },
    ]);
    expect(step.closure.visited).toEqual([
      `${CACHE_DAO}#purge`,
      `${CONTENT_MANAGER}#purgeContentCache`,
      `${FILE_MANAGER}#deleteAll`,
      `${FILE_MANAGER}#deleteVersion`,
      `${LOGIN_MANAGER}#logout`,
      `${SETTINGS_BEAN}#purgeCache`,
    ]);
  });

  it('attaches reviewed writers by step span and by the methods a step reaches, never the excluded cursor', async () => {
    const merged = onlyJob(await extractJobs(variantContext(MERGING_FILES, mergingOverrides()), { routeKeyOptions: ROUTE_KEY_OPTIONS }));
    expect(merged.steps.filter((s) => s.overrides.length > 0).map((s) => [s.step, s.overrides])).toEqual([
      ['cache-purge', ['wov:purge-window-query']],
      ['cluster-cleanup', ['wov:cluster-peers']],
    ]);
    const cleanup = stepNamed(merged, 'cluster-cleanup');
    expect(cleanup.tables).toEqual(['tclustercommands', 'tclusterpeers']);
    expect(cleanup.writeSet.find((w) => w.override === 'wov:cluster-peers')).toMatchObject({ table: 'tclusterpeers', trigger: 'scheduler', conditional: false });
    expect(jobWriteEvidence([merged]).map((e) => e.closure)).toEqual(merged.steps.map((s) => s.closure));
  });
});
