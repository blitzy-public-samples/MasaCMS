import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSourceTree } from '../../src/inventory/closure.js';
import type { ClosureContext, SourceTree } from '../../src/inventory/closure.js';
import { CONTENT_SERVER_PATH, JOB_ID, SETTINGS_TEMPLATE_PATH, SITE_MONITOR_STEPS, extractJobs } from '../../src/inventory/jobs.js';
import type { JobExtraction, JobRouteKeyOptions, ScheduledJobEntry, ScheduledJobStep, SourceRef } from '../../src/inventory/jobs.js';
import { inventoryRouteKey } from '../../src/inventory/route-keys.js';
import { STARTUP_PATH, buildComponentIndex, extractAliases, extractServices } from '../../src/inventory/services.js';
import type { ComponentIndexInputs } from '../../src/inventory/services.js';

const CONTENT_MANAGER = 'core/mura/content/contentManager.cfc';
const EMAIL_MANAGER = 'core/mura/email/emailManager.cfc';
const CHANGESET_MANAGER = 'core/mura/content/changeset/changesetManager.cfc';
const FEED_MANAGER = 'core/mura/content/feed/feedManager.cfc';
const CLUSTER_MANAGER = 'core/mura/cluster/clusterManager.cfc';
const SETTINGS_MANAGER = 'core/mura/settings/settingsManager.cfc';
const SETTINGS_BEAN = 'core/mura/settings/settingsBean.cfc';

const ROUTE_KEY_OPTIONS: JobRouteKeyOptions = { variants: [] };
const NO_ORM: ComponentIndexInputs['ormIndex'] = { byComponent: new Map(), byEntityName: new Map() };

const PUBLISH_CALL = '\t\t<cfset application.changesetManager.publishBySchedule()>';
const CLUSTER_CALL = '\t\t<cfset application.clusterManager.clearOldCommands()>';

/** contentServer.cfc handleAPIRequest, its site-monitor branch modelled on lines 669-747; the two calls fill the change-set and cluster slots. */
function contentServer(atPublish: string, atCluster: string): string {
  return [
    '<cfcomponent extends="mura.cfobject" output="false">',
    '<cffunction name="handleAPIRequest" output="false">',
    '\t<cfargument name="path" default="#cgi.path_info#">',
    '\t<cfset var fileendpoint="/_api/render/">',
    '\t<cfset var sitemonitorendpoint="/_api/sitemonitor">',
    '\t<cfset var legacywidgetendpoint="/tasks/widgets/">',
    '\t<cfif left(arguments.path,len(fileendpoint)) eq fileendpoint>',
    '\t\t<cfreturn application.contentRenderer.renderFile(url.fileID)>',
    '\t<cfelseif left(arguments.path,len(sitemonitorendpoint)) eq sitemonitorendpoint>',
    '\t\t<cfset var theTime=now()/>',
    '\t\t<cfset var emailList="" />',
    '\t\t<cfset var theemail="" />',
    '\t\t<cfset var site="" />',
    '\t\t<cfset var rsChanges="" />',
    '',
    "\t\t<cfparam name=\"application.lastMonitored\" default=\"#dateadd('n',-1,theTime)#\"/>",
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
    atPublish,
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
    '\t\t\t\t<cfset application.serviceFactory',
    "\t\t\t\t\t.getBean('contentManager')",
    "\t\t\t\t\t\t.purgeContentCache(contentBean=application.serviceFactory.getBean('content').loadBy(contentID=rsChanges.contentid,siteid=rsChanges.siteid))>",
    '\t\t\t</cfloop>',
    '\t\t\t<cfquery name="rsChanges" dbtype="query">',
    '\t\t\t\tselect distinct siteid from rsChanges',
    '\t\t\t</cfquery>',
    '\t\t\t<cfloop query="rsChanges">',
    '\t\t\t\t<cfset application.settingsManager.getSite(rsChanges.siteid).purgeCache() />',
    '\t\t\t</cfloop>',
    '\t\t</cfif>',
    '',
    atCluster,
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
    '\t<cfelseif left(path,len(legacywidgetendpoint)) eq legacywidgetendpoint>',
    "\t\t<cflocation statuscode=\"301\" addtoken=\"false\" url=\"#replaceNoCase(cgi.path_info,'/tasks/widgets/','/core/vendor/')#\">",
    '\t</cfif>',
    '</cffunction>',
    '</cfcomponent>',
    '',
  ].join('\n');
}

const CONTENT_SERVER = contentServer(PUBLISH_CALL, CLUSTER_CALL);

/** Scheduled-task block of onApplicationStart_include.cfm lines 549-579. */
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
  '\t\t\tvariables.tracePoint=initTracePoint("Setting Ping Scheduled Task");',
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
  '\t\t\tcommitTracePoint(variables.tracePoint);',
  '\t\t}',
  '\t} catch (any cfcatch) {',
  '\t}',
  '</cfscript>',
  '',
].join('\n');

/** settings.template.cfm around line 91. */
const SETTINGS_TEMPLATE = ['[settings]', 'ormusedbformapping=false', 'ping=false', 'plugindir=', 'port=${cgi.SERVER_PORT}', ''].join('\n');

function cfc(...functions: string[]): string {
  return ['<cfcomponent extends="mura.cfobject" output="false">', ...functions, '</cfcomponent>', ''].join('\n');
}

/** A tag method whose body is `body`, with one optional argument. */
function method(name: string, body: string, arg?: string): string {
  return [`<cffunction name="${name}" output="false">`, ...(arg === undefined ? [] : [`\t<cfargument name="${arg}">`]), `\t${body}`, '</cffunction>'].join('\n');
}

function query(sql: string): string {
  return `<cfquery>${sql}</cfquery>`;
}

const NOW_PARAM = '<cfqueryparam cfsqltype="cf_sql_timestamp" value="#now()#">';
const SITE_PARAM = '<cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.siteid#">';

/** Archive files of a temp tree: each step method writes one table, the cache purges and site lookups none. */
function treeFiles(server: string): Record<string, string> {
  return {
    [CONTENT_SERVER_PATH]: server,
    [STARTUP_PATH]: STARTUP,
    [SETTINGS_TEMPLATE_PATH]: SETTINGS_TEMPLATE,
    [CONTENT_MANAGER]: cfc(
      method('sendReminders', query(`DELETE FROM tcontenteventreminders WHERE remindDate <= ${NOW_PARAM}`), 'theTime'),
      method('purgeContentCache', '<cfreturn this>', 'contentBean'),
    ),
    [EMAIL_MANAGER]: cfc(
      method('send', query(`UPDATE temails SET isSent = 1 WHERE deliveryDate <= ${NOW_PARAM}`)),
      method('trackBounces', query(`INSERT INTO temailreturnstats (siteID, created) VALUES (${SITE_PARAM}, ${NOW_PARAM})`), 'siteid'),
    ),
    [CHANGESET_MANAGER]: cfc(method('publishBySchedule', query(`UPDATE tchangesets SET published = 1 WHERE publishDate <= ${NOW_PARAM}`))),
    [FEED_MANAGER]: cfc(method('doAutoImport', query(`INSERT INTO tcontentfeeditems (siteID, created) VALUES (${SITE_PARAM}, ${NOW_PARAM})`), 'siteid')),
    [CLUSTER_MANAGER]: cfc(method('clearOldCommands', query(`DELETE FROM tclustercommands WHERE created < ${NOW_PARAM}`))),
    [SETTINGS_MANAGER]: cfc(method('getSites', '<cfreturn variables.sites>'), method('getSite', '<cfreturn variables.sites[arguments.siteid]>', 'siteid'), method('getList', '<cfreturn "">')),
    [SETTINGS_BEAN]: cfc(method('purgeCache', '<cfreturn this>')),
  };
}

async function writeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-jobs-'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

/** Closure context over `tree` with the DI1 registry the start-up scan builds. */
function contextFor(tree: SourceTree): ClosureContext {
  return { tree, index: buildComponentIndex({ services: extractServices(tree), aliases: extractAliases(tree), ormIndex: NO_ORM, tree }) };
}

/** 1-based line of the only line of `text` containing `needle`. */
function lineWith(text: string, needle: string): number {
  const hits = text.split('\n').flatMap((l, i) => (l.includes(needle) ? [i + 1] : []));
  const [hit] = hits;
  if (hits.length !== 1 || hit === undefined) throw new Error(`${JSON.stringify(needle)} is on ${hits.length} lines`);
  return hit;
}

/** Handler span from the line holding `from` to the line holding `to`, or `to` lines further. */
function cs(from: string, to: string | number = 0): SourceRef {
  const start = lineWith(CONTENT_SERVER, from);
  return { path: CONTENT_SERVER_PATH, lines: [start, typeof to === 'number' ? start + to : lineWith(CONTENT_SERVER, to)] };
}

function startupRef(needle: string): SourceRef {
  const line = lineWith(STARTUP, needle);
  return { path: STARTUP_PATH, lines: [line, line] };
}

function stepNamed(entry: ScheduledJobEntry, step: string): ScheduledJobStep {
  const found = entry.steps.find((s) => s.step === step);
  if (found === undefined) throw new Error(`no step ${step}`);
  return found;
}

const roots: string[] = [];
let extraction: JobExtraction;
let job: ScheduledJobEntry;
let swapped: JobExtraction;

beforeAll(async () => {
  const legacyRoot = await writeTree(treeFiles(CONTENT_SERVER));
  const swappedRoot = await writeTree(treeFiles(contentServer(CLUSTER_CALL, PUBLISH_CALL)));
  roots.push(legacyRoot, swappedRoot);
  extraction = await extractJobs(contextFor(openSourceTree(legacyRoot)), { routeKeyOptions: ROUTE_KEY_OPTIONS });
  const [only] = extraction.scheduledJobs;
  if (only === undefined) throw new Error('no scheduled job extracted');
  job = only;
  swapped = await extractJobs(contextFor(openSourceTree(swappedRoot)), { routeKeyOptions: ROUTE_KEY_OPTIONS });
});

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('site-monitor job entry', () => {
  it('emits one scheduler-triggered job keyed like the /_api/sitemonitor entry point', async () => {
    const entryKey = await inventoryRouteKey({ kind: 'path', httpMethod: 'GET', path: '/_api/sitemonitor' }, ROUTE_KEY_OPTIONS);
    expect(extraction.scheduledJobs.map((j) => j.id)).toEqual(['job:sitemonitor']);
    expect(job.id).toBe(JOB_ID);
    expect(job.routeKey).toBe('sitemonitor:run');
    expect(job.routeKey).toBe(entryKey.key);
    expect(job.trigger).toBe('scheduler');
    expect(job.source).toEqual(cs('eq sitemonitorendpoint>', '<cfreturn "">'));
  });

  it('records the ping-gated HTTP task from 00:15 every 900 s with a 600 s timeout and the template default ping=false', () => {
    // `ormusedbformapping=false` also contains `ping=false`; only the whole-key line counts.
    const pingLine = SETTINGS_TEMPLATE.split('\n').indexOf('ping=false') + 1;
    expect(job.registration).toMatchObject({
      type: 'ACF HTTPRequest task',
      url: '/index.cfm/_api/sitemonitor/',
      urlTemplate: 'http://<host><context>/index.cfm/_api/sitemonitor/',
      operation: 'HTTPRequest',
      startTime: '00:15',
      intervalSeconds: 900,
      requestTimeoutSeconds: 600,
      condition: 'ping is true',
      conditionExpression: 'isBoolean(variables.iniProperties.ping) && variables.iniProperties.ping',
      source: { path: STARTUP_PATH, lines: [lineWith(STARTUP, '//  Set up scheduled tasks'), lineWith(STARTUP, '} catch (any cfcatch) {') + 1] },
      conditionSource: startupRef('if ( isBoolean('),
      pingDefault: { value: false, source: { path: SETTINGS_TEMPLATE_PATH, lines: [pingLine, pingLine] } },
    });
  });

  it('derives the cursor, the 30-minute catch-up, the purge window and the ineffective bounce dedupe from the handler', () => {
    expect(job.semantics.cursor).toEqual({
      rule: 'application.lastMonitored defaults to now - 1 minute and is set to the run time at the end',
      variable: 'application.lastMonitored',
      default: "dateadd('n',-1,theTime)",
      source: cs('<cfparam name="application.lastMonitored"'),
      endSource: cs('<cfset application.lastMonitored=theTime/>'),
    });
    expect(job.semantics.catchUp).toEqual({
      rule: 'reminders also run for now - 30 min when the minute of lastMonitored differs from the minute of now - 30 min',
      step: 'reminders',
      predicate: 'minute(application.lastMonitored) neq minute(dateadd("n",-30,theTime))',
      argument: 'dateadd("n",-30,theTime)',
      source: { path: CONTENT_SERVER_PATH, lines: [lineWith(CONTENT_SERVER, '<cfset var addPrev'), lineWith(CONTENT_SERVER, '<cfif addPrev>') + 2] },
    });
    expect(job.semantics.purgeWindow).toEqual({
      rule: 'display-window purge covers [lastMonitored, now]',
      step: 'cache-purge',
      from: 'lastMonitored',
      to: 'now',
      source: cs('<cfquery name="rsChanges" datasource', 6),
    });
    expect(job.semantics.bounceDedupeIneffective).toBe(true);
    expect(job.semantics.gating?.dedupeSource).toEqual(cs('<cfset listAppend(emailList,theEmail)'));
  });
});

describe('site-monitor steps', () => {
  it('lists the eight steps in handler order with job-scoped ids and no departure from the plan', () => {
    // Kebab step names and `<job>.<step>` ids are the ones the committed inventory and decision list reference.
    expect(job.steps.map((s) => [s.order, s.id, s.step])).toEqual([
      [1, 'job:sitemonitor.reminders', 'reminders'],
      [2, 'job:sitemonitor.email-send', 'email-send'],
      [3, 'job:sitemonitor.changeset-publish', 'changeset-publish'],
      [4, 'job:sitemonitor.bounces', 'bounces'],
      [5, 'job:sitemonitor.feed-import', 'feed-import'],
      [6, 'job:sitemonitor.cache-purge', 'cache-purge'],
      [7, 'job:sitemonitor.cluster-cleanup', 'cluster-cleanup'],
      [8, 'job:sitemonitor.plugin-events', 'plugin-events'],
    ]);
    expect(job.steps.map((s) => s.step)).toEqual(SITE_MONITOR_STEPS.map((s) => s.step));
    expect(job.semantics.order.steps).toEqual(job.steps.map((s) => s.step));
    expect(extraction.differences).toEqual([]);
  });

  it('gates bounce collection on EmailBroadcaster and feed imports on FeedManager inside the site loop, leaving the rest ungated', () => {
    const loopSource = cs('<cfloop collection=', 11);
    expect(job.steps.map((s) => [s.step, s.gating?.flag ?? null, s.perSite])).toEqual([
      ['reminders', null, false],
      ['email-send', null, false],
      ['changeset-publish', null, false],
      ['bounces', 'EmailBroadcaster', true],
      ['feed-import', 'FeedManager', true],
      ['cache-purge', null, false],
      ['cluster-cleanup', null, false],
      ['plugin-events', null, true],
    ]);
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
    expect(job.semantics.gating?.rule).toBe(
      'bounces only where EmailBroadcaster is set; feed imports only where FeedManager is set; the mail-server dedupe discards the listAppend result',
    );
  });

  it.each([
    { step: 'reminders', table: 'tcontenteventreminders', op: 'delete', component: CONTENT_MANAGER, method: 'sendReminders' },
    { step: 'email-send', table: 'temails', op: 'update', component: EMAIL_MANAGER, method: 'send' },
    { step: 'changeset-publish', table: 'tchangesets', op: 'update', component: CHANGESET_MANAGER, method: 'publishBySchedule' },
    { step: 'bounces', table: 'temailreturnstats', op: 'insert', component: EMAIL_MANAGER, method: 'trackBounces' },
    { step: 'feed-import', table: 'tcontentfeeditems', op: 'insert', component: FEED_MANAGER, method: 'doAutoImport' },
    { step: 'cluster-cleanup', table: 'tclustercommands', op: 'delete', component: CLUSTER_MANAGER, method: 'clearOldCommands' },
  ])('confines the $step write set to $table of its own manager', ({ step, table, op, component, method: name }) => {
    const s = stepNamed(job, step);
    expect(s.tables).toEqual([table]);
    expect(s.writeSet.map((w) => [w.table, w.op, w.component, w.method, w.trigger, w.conditional])).toEqual([[table, op, component, name, 'scheduler', false]]);
    expect([s.conditionalWrites, s.unresolved, s.fileStoreWrite]).toEqual([[], [], false]);
  });

  it('keeps every written table in the write set of exactly one step', () => {
    const owners = new Map<string, string[]>();
    for (const s of job.steps) for (const t of s.tables) owners.set(t, [...(owners.get(t) ?? []), s.step]);
    expect(Object.fromEntries(owners)).toEqual({
      tcontenteventreminders: ['reminders'],
      temails: ['email-send'],
      tchangesets: ['changeset-publish'],
      temailreturnstats: ['bounces'],
      tcontentfeeditems: ['feed-import'],
      tclustercommands: ['cluster-cleanup'],
    });
  });

  it('writes no table from the display-window cache purge or the plugin monitor events', () => {
    const purge = stepNamed(job, 'cache-purge');
    expect([purge.tables, purge.writeSet, purge.unresolved]).toEqual([[], [], []]);
    expect(purge.closure.visited).toEqual([`${CONTENT_MANAGER}#purgeContentCache`, `${SETTINGS_BEAN}#purgeCache`]);
    const events = stepNamed(job, 'plugin-events');
    expect([events.tables, events.writeSet, events.dynamic]).toEqual([[], [], true]);
    // The DI1 scan registers no `$` bean, so the event receivers stay open for writer overrides.
    expect(events.unresolved.map((u) => [u.kind, u.source.lines[0]])).toEqual([
      ['bean', lineWith(CONTENT_SERVER, "announceEvent('onGlobalMonitor')")],
      ['bean', lineWith(CONTENT_SERVER, "announceEvent('onSiteMonitor')")],
    ]);
    expect(job.steps.filter((s) => s.dynamic === true).map((s) => s.step)).toEqual(['plugin-events']);
  });

  it.each([
    { step: 'reminders', call: 'contentManager.sendReminders (catch-up at now - 30 min when the minutes differ)', calls: ['contentManager.sendReminders', 'contentManager.sendReminders'] },
    { step: 'email-send', call: 'emailManager.send', calls: ['emailManager.send'] },
    { step: 'changeset-publish', call: 'changesetManager.publishBySchedule', calls: ['changesetManager.publishBySchedule'] },
    {
      step: 'bounces',
      call: 'emailManager.trackBounces per site with EmailBroadcaster; mail-server dedupe ineffective (listAppend result discarded)',
      calls: ['emailManager.trackBounces'],
    },
    { step: 'feed-import', call: 'feedManager.doAutoImport per site with FeedManager', calls: ['feedManager.doAutoImport'] },
    {
      step: 'cache-purge',
      call: 'contentManager.purgeContentCache and settingsBean.purgeCache for display windows in [lastMonitored, now]',
      calls: ['contentManager.purgeContentCache', 'settingsBean.purgeCache'],
    },
    { step: 'cluster-cleanup', call: 'clusterManager.clearOldCommands', calls: ['clusterManager.clearOldCommands'] },
    { step: 'plugin-events', call: 'announceEvent onGlobalMonitor, then onSiteMonitor per site', calls: ['$.announceEvent', '$.announceEvent'] },
  ])('runs the $step step on the scheduler and names its legacy calls', ({ step, call, calls }) => {
    const s = stepNamed(job, step);
    expect(s.trigger).toBe('scheduler');
    expect(s.call).toBe(call);
    expect(s.calls.map((c) => `${c.bean ?? '?'}.${c.method}`)).toEqual(calls);
  });
});

describe('step order read from source', () => {
  it('follows the handler when the change-set publish and cluster cleanup calls swap places', () => {
    expect(swapped.scheduledJobs[0]?.steps.map((s) => [s.order, s.step, s.tables])).toEqual([
      [1, 'reminders', ['tcontenteventreminders']],
      [2, 'email-send', ['temails']],
      [3, 'cluster-cleanup', ['tclustercommands']],
      [4, 'bounces', ['temailreturnstats']],
      [5, 'feed-import', ['tcontentfeeditems']],
      [6, 'cache-purge', []],
      [7, 'changeset-publish', ['tchangesets']],
      [8, 'plugin-events', []],
    ]);
  });

  it('reports each swapped step against its planned position', () => {
    expect(swapped.differences).toEqual([
      { jobId: JOB_ID, step: 'cluster-cleanup', kind: 'order', expected: 7, computed: 3 },
      { jobId: JOB_ID, step: 'changeset-publish', kind: 'order', expected: 3, computed: 7 },
    ]);
  });
});
