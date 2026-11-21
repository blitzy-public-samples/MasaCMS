import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouteEntryPoint, VariantDeclaration } from '@opt2/platform/legacy-compat';
import { openSourceTree } from '../../src/inventory/closure.js';
import type { ComponentIndex, SourceTree } from '../../src/inventory/closure.js';
import {
  EVENTS_HANDLER_PATH,
  FORM_TEMPLATE_PATH,
  ROOT_REQUEST,
  extractFrontEnd,
  httpReachability,
  isHttpReachable,
} from '../../src/inventory/frontend.js';
import type {
  CsrfValidation,
  FrontEndEntry,
  FrontEndExtraction,
  FrontEndKind,
  HttpReachability,
  SessionEffects,
  SourceRef,
} from '../../src/inventory/frontend.js';
import { inventoryRouteKey } from '../../src/inventory/route-keys.js';
import { buildComponentIndex, extractAliases, extractServices } from '../../src/inventory/services.js';
import type { ComponentIndexInputs } from '../../src/inventory/services.js';

const SERVER = ROOT_REQUEST.path;
const EVENTS = EVENTS_HANDLER_PATH;
const FORM = FORM_TEMPLATE_PATH;
const RATE_AJAX = 'core/modules/v1/rater/ajax/saveRate.cfm';
const COMMENTS_PROXY = 'core/modules/v1/comments/ajax/commentsProxy.cfc';
const MURA_GUARD = 'core/mura/Application.cfc';
const HIDDEN_PROXY = 'core/mura/fixture/hiddenProxy.cfc';
const DAO = 'core/mura/fixture/fixtureDAO.cfc';

const VARIANTS: readonly VariantDeclaration[] = [];
const NO_ORM: ComponentIndexInputs['ormIndex'] = { byComponent: new Map(), byEntityName: new Map() };

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function scriptCfc(...body: string[]): string {
  return lines('component extends="mura.cfobject" output="false" {', ...body, '}');
}

/** Files of the temp tree: copies of committed fixtures, and excerpts modelled on the legacy lines the unit reads. */
const FILES: Readonly<Record<string, string>> = {
  [MURA_GUARD]: readFileSync(fixturePath('Application.cfc'), 'utf8'),
  [DAO]: readFileSync(fixturePath('cfml/dao-writes.cfc'), 'utf8'),
  [SERVER]: lines(
    '<cfcomponent extends="mura.cfobject" output="false">',
    '',
    '<cffunction name="handleRootRequest" output="false">',
    '\t<cfset var pageContent="">',
    '\t<cfset var path=cgi.path_info>',
    "\t<cfif listFindNoCase('_api,tasks',listFirst(path,'/'))>",
    '\t\t<cfreturn handleAPIRequest(path)>',
    '\t<cfelse>',
    '\t\t<cfset pageContent = application.contentServer.parseURLRoot(path=path)>',
    '\t\t<cfreturn pageContent>',
    '\t</cfif>',
    '</cffunction>',
    '',
    '<cffunction name="handleAPIRequest" output="false">',
    '\t<cfargument name="path">',
    "\t<cfset getBean('fixtureDAO').deleteMembership(userid=url.userid, groupid=url.groupid)>",
    '</cffunction>',
    '',
    '<cffunction name="parseURLRoot" output="false">',
    '\t<cfargument name="path">',
    '\t<cfset request.servletEvent.getValidator("standardTrackSession").validate(request.servletEvent)>',
    '\t<cfset request.servletEvent.getHandler("standardDoActions").handle(request.servletEvent)>',
    '</cffunction>',
    '',
    '</cfcomponent>',
  ),
  [EVENTS]: lines(
    '<cfcomponent extends="mura.cfobject" output="false">',
    '',
    '<cffunction name="standardTrackSessionValidator" output="false">',
    '\t<cfargument name="event" required="true">',
    "\t<cfset getBean('fixtureDAO').trackAsync(siteid=arguments.event.getValue('siteID'))>",
    '</cffunction>',
    '',
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
    '',
    '<cffunction name="doAction" output="false">',
    '\t<cfargument name="theaction" type="string" default="">',
    '\t<cfargument name="event" required="true">',
    '\t<cfargument name="$" />',
    '\t<cfswitch expression="#arguments.theaction#">',
    '\t\t<cfcase value="login">',
    "\t\t\t<cfif not arguments.$.getContentRenderer().validateCSRFTokens or arguments.$.validateCSRFTokens(context='login')>",
    "\t\t\t\t<cfset arguments.$.getBean('loginManager').login(arguments.$.event().getAllValues(),'')>",
    '\t\t\t</cfif>',
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="return">',
    "\t\t\t<cfset application.emailManager.track(arguments.event.getValue('emailID'),arguments.event.getValue('email'),'returnClick')>",
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="logout">',
    '\t\t\t<cfset application.loginManager.logout()>',
    '\t\t\t<cfset arguments.event.getHandler("standardPostLogout").handle(arguments.event)>',
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="updateprofile">',
    "\t\t\t<cfif not arguments.$.getContentRenderer().validateCSRFTokens or arguments.$.validateCSRFTokens(context='editprofile')>",
    '\t\t\t\t<cfset application.userManager.update(arguments.event.getAllValues())>',
    '\t\t\t\t<cfset application.loginManager.loginByUserID(arguments.event.getAllValues())>',
    '\t\t\t</cfif>',
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="setReminder">',
    "\t\t\t<cfset application.contentManager.setReminder(arguments.event.getValue('contentID'),arguments.event.getValue('siteID'))>",
    '\t\t</cfcase>',
    '',
    '\t\t<cfcase value="customthing">',
    "\t\t\t<cfset arguments.event.setValue('customthing',true)>",
    '\t\t</cfcase>',
    '\t</cfswitch>',
    '</cffunction>',
    '',
    '</cfcomponent>',
  ),
  [FORM]: lines(
    '<cfset objectParams.render = "client" />',
    '<cfset objectParams.async = "true"/>',
    "<cfif len($.event('saveform'))>",
    "\t<cfset $.event('fields','')>",
    "\t<cfset objectParams.errors=$.getBean('dataCollectionBean')",
    '\t\t.set($.event().getAllValues())',
    '\t\t.submit($).getErrors()>',
    '\t<cfif not structCount(objectParams.errors)>',
    '\t\t<cfset objectParams.responsemessage=$.renderEvent(eventName="onFormSubmitResponseRender")>',
    '\t</cfif>',
    '</cfif>',
  ),
  [RATE_AJAX]: lines(
    '<cfsetting enablecfoutputonly="yes">',
    '<cfset myRate=application.raterManager.saveRate(form.contentID, form.siteID, form.userID, form.rate) />',
    '<cfoutput>#application.contentRenderer.jsonencode(application.raterManager.getAvgRating(form.contentID,form.siteid))#</cfoutput>',
  ),
  [COMMENTS_PROXY]: lines(
    '<cfcomponent extends="Mura.cfobject">',
    '',
    '\t<cffunction name="get" access="remote" returnformat="plain">',
    '\t\t<cfargument name="commentID">',
    '\t\t<cfset var $ = getBean("MuraScope").init("default")>',
    '\t\t<cfset var data = $.getBean("contentManager").getCommentBean().setCommentID(arguments.commentID).load().getAllValues()>',
    '\t\t<cfreturn createobject("component","Mura.json").encode(data)>',
    '\t</cffunction>',
    '',
    '\t<cffunction name="renderCommentsPage" access="remote" returnformat="plain">',
    '\t\t<cfargument name="contentID">',
    '\t\t<cfset var $ = getBean("MuraScope").init("default")>',
    '\t\t<cfset var returnStruct = structNew()>',
    '\t\t<cfsavecontent variable="returnStruct.htmloutput">',
    "\t\t\t<cfoutput>#$.dspObject('comments')#</cfoutput>",
    '\t\t</cfsavecontent>',
    '\t\t<cfreturn returnStruct>',
    '\t</cffunction>',
    '',
    '</cfcomponent>',
  ),
  [HIDDEN_PROXY]: scriptCfc('\tremote string function ping() {', "\t\treturn 'pong';", '\t}'),
  'core/mura/login/loginManager.cfc': scriptCfc(
    '\tpublic boolean function login(required struct loginStruct, string sessionUserID="") {',
    "\t\treturn getBean('userUtility').loginByQuery(arguments.loginStruct);",
    '\t}',
    '',
    '\tpublic boolean function loginByUserID(required struct loginStruct) {',
    "\t\treturn getBean('userUtility').loginByUserID(arguments.loginStruct.userid);",
    '\t}',
    '',
    '\tpublic void function logout() {',
    "\t\tgetBean('userUtility').logout();",
    '\t}',
  ),
  'core/mura/user/userUtility.cfc': scriptCfc(
    '\tpublic boolean function loginByQuery(required any rsUser) {',
    "\t\tgetBean('fixtureDAO').update(userid=arguments.rsUser.userid, name='lastLogin');",
    '\t\treturn true;',
    '\t}',
    '',
    '\tpublic boolean function loginByUserID(required string userid) {',
    '\t\treturn true;',
    '\t}',
    '',
    '\tpublic void function logout() {',
    '\t}',
  ),
  'core/mura/user/userManager.cfc': scriptCfc(
    '\tpublic any function update(required struct data) {',
    "\t\tgetBean('fixtureDAO').update(userid=arguments.data.userid, name=arguments.data.name);",
    "\t\tgetBean('fixtureDAO').deleteMembership(userid=arguments.data.userid, groupid=arguments.data.groupid);",
    '\t}',
  ),
  'core/mura/datacollection/dataCollectionBean.cfc': scriptCfc(
    '\tpublic any function set(required struct data) {',
    '\t\treturn this;',
    '\t}',
    '',
    '\tpublic any function submit(required any $) {',
    "\t\tgetBean('fixtureDAO').create(getAllValues());",
    '\t\treturn this;',
    '\t}',
  ),
};

function text(file: string): string {
  const found = FILES[file];
  if (found === undefined) throw new Error(`no temp-tree file ${file}`);
  return found;
}

/** 1-based line of the only occurrence of `needle` in `file`. */
function lineIn(file: string, needle: string): number {
  const t = text(file);
  const at = t.indexOf(needle);
  if (at < 0 || t.indexOf(needle, at + 1) >= 0) throw new Error(`${JSON.stringify(needle)} is not unique in ${file}`);
  return t.slice(0, at).split('\n').length;
}

function src(file: string, from: number, to: number = from): SourceRef {
  return { path: file, lines: [from, to] };
}

function spanOf(file: string, first: string, last: string = first): SourceRef {
  return src(file, lineIn(file, first), lineIn(file, last));
}

/** A tag function from its `<cffunction>` line through its closing tag. */
function functionSource(file: string, name: string): SourceRef {
  const t = text(file);
  const open = t.indexOf(`<cffunction name="${name}"`);
  return src(file, t.slice(0, open).split('\n').length, t.slice(0, t.indexOf('</cffunction>', open)).split('\n').length);
}

/** A doAction case from its `<cfcase>` line through its closing tag. */
function caseSource(value: string): SourceRef {
  const t = text(EVENTS);
  const open = t.indexOf(`<cfcase value="${value}">`);
  return src(EVENTS, t.slice(0, open).split('\n').length, t.slice(0, t.indexOf('</cfcase>', open)).split('\n').length);
}

const GUARD = `${MURA_GUARD}:${lineIn(MURA_GUARD, 'function onRequestStart')}-${lineIn(MURA_GUARD, 'abort;') + 1}`;

let root = '';
let tree: SourceTree;
let extraction: FrontEndExtraction;

function indexOf(source: SourceTree): ComponentIndex {
  return buildComponentIndex({ services: extractServices(source), aliases: extractAliases(source), ormIndex: NO_ORM, tree: source });
}

function entryOf(id: string): FrontEndEntry {
  const found = extraction.frontEnd.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no front-end entry ${id}`);
  return found;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-frontend-'));
  for (const [rel, content] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  tree = openSourceTree(root);
  extraction = await extractFrontEnd(tree, { index: indexOf(tree), routeKeyOptions: { variants: VARIANTS } });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPEN: HttpReachability = { reachable: true, guard: null, allow: null };
const DENIED: HttpReachability = { reachable: false, guard: GUARD, allow: [] };

const REACH: Array<[string, HttpReachability]> = [
  [HIDDEN_PROXY, DENIED],
  [SERVER, DENIED],
  [COMMENTS_PROXY, OPEN],
  [RATE_AJAX, OPEN],
  ['admin/index.cfm', OPEN],
];

describe('front-end reachability', () => {
  it.each(REACH)('decides HTTP reachability of %s from its nearest Application.cfc', (rel, expected) => {
    expect(httpReachability(tree, rel)).toEqual(expected);
    expect(isHttpReachable(tree, rel)).toBe(expected.reachable);
  });

  it('records remote methods behind the deny-all guard instead of listing them', () => {
    expect(extraction.unreachableRemote).toEqual([
      { path: HIDDEN_PROXY, method: 'ping', line: lineIn(HIDDEN_PROXY, 'function ping'), guard: GUARD },
    ]);
    expect(extraction.frontEnd.filter((e) => e.source.path === HIDDEN_PROXY)).toEqual([]);
  });
});

/** One expected entry: its id, kind, entry point, source and the facts disposition reads. */
interface Case {
  id: string;
  kind: FrontEndKind;
  name: string;
  entryPoint: RouteEntryPoint;
  source: SourceRef;
  rendersCfml: boolean;
  writeSet: string[];
  sessionEffects?: SessionEffects;
  csrf?: [string | null, CsrfValidation];
}

function doaction(value: string, facts: Partial<Case> = {}): Case {
  return {
    id: `fe:doaction=${value}`,
    kind: 'doaction',
    name: value,
    entryPoint: { kind: 'page', doaction: [value] },
    source: caseSource(value),
    rendersCfml: true,
    writeSet: [],
    ...facts,
  };
}

function proxy(method: string, rendersCfml: boolean): Case {
  return {
    id: `fe:commentsproxy.${method}`,
    kind: 'remote-proxy',
    name: method,
    entryPoint: { kind: 'cfc', path: `/${COMMENTS_PROXY}`, method },
    source: functionSource(COMMENTS_PROXY, method),
    rendersCfml,
    writeSet: [],
  };
}

const CASES: Case[] = [
  {
    id: 'fe:cfm:/core/modules/v1/rater/ajax/saverate.cfm',
    kind: 'ajax-endpoint',
    name: 'saveRate.cfm',
    entryPoint: { kind: 'path', httpMethod: 'GET', path: `/${RATE_AJAX}` },
    source: src(RATE_AJAX, 1, 3),
    rendersCfml: false,
    writeSet: [],
  },
  proxy('get', false),
  proxy('renderCommentsPage', true),
  doaction('customthing'),
  doaction('login', { writeSet: ['tfixture'], sessionEffects: 'login', csrf: ['login', 'validates'] }),
  doaction('logout', { sessionEffects: 'logout' }),
  doaction('return'),
  doaction('setReminder'),
  doaction('updateprofile', {
    writeSet: ['tfixture', 'tfixturemembers'],
    sessionEffects: 'login',
    csrf: ['editprofile', 'validates'],
  }),
  {
    id: 'fe:render',
    kind: 'page-render',
    name: 'render',
    entryPoint: { kind: 'page' },
    source: functionSource(SERVER, 'handleRootRequest'),
    rendersCfml: true,
    writeSet: ['tfixturestats'],
  },
  {
    id: 'fe:saveform',
    kind: 'form-submission',
    name: 'saveform',
    entryPoint: { kind: 'page', saveform: true },
    source: spanOf(FORM, "<cfif len($.event('saveform'))>", '\t</cfif>'),
    rendersCfml: true,
    writeSet: ['tfixture'],
  },
];

describe('front-end entries and keys', () => {
  it('lists one entry per page render, doaction case, saveform branch, ajax template and remote method, sorted by id', () => {
    const ids = extraction.frontEnd.map((e) => e.id);
    expect(ids).toEqual(CASES.map((c) => c.id));
    expect(ids).toEqual([...ids].sort());
  });

  it.each(CASES)('keys $id like inventoryRouteKey of its entry point', async (c) => {
    const expected = await inventoryRouteKey(c.entryPoint, { variants: VARIANTS });
    expect(entryOf(c.id)).toMatchObject({
      kind: c.kind,
      name: c.name,
      source: c.source,
      routeKey: expected.key,
      unkeyed: false,
      predicate: null,
      trigger: 'request',
    });
  });

  it('keys doaction values as page keys and proxies by path and method', () => {
    expect(entryOf('fe:doaction=login').routeKey).toBe('page:login');
    expect(entryOf('fe:render').routeKey).toBe('page:render');
    expect(entryOf('fe:saveform').routeKey).toBe('page:saveform');
    for (const method of ['get', 'renderCommentsPage']) {
      expect(entryOf(`fe:commentsproxy.${method}`).routeKey).toBe(`cfc:/${COMMENTS_PROXY.toLowerCase()}?method=${method.toLowerCase()}`);
    }
  });

  it('reads every doaction value from a live doAction case', () => {
    for (const e of extraction.frontEnd.filter((x) => x.kind === 'doaction')) {
      expect(e).toMatchObject({
        entry: `doaction=${e.name}: standardEventsHandler.doAction case`,
        doactionEvidence: 'handler-case',
        reachable: true,
        unreachableReason: null,
        extraSources: [],
      });
    }
  });
});

describe('front-end facts for disposition', () => {
  it.each(CASES)('records render, write, session and CSRF facts of $id', (c) => {
    const [csrfContext, csrfValidation] = c.csrf ?? [null, 'none'];
    expect(entryOf(c.id)).toMatchObject({
      rendersCfml: c.rendersCfml,
      returnsDataOnly: !c.rendersCfml,
      writeSet: c.writeSet,
      fileStoreWrite: false,
      sessionEffects: c.sessionEffects ?? 'none',
      csrfContext,
      csrfValidation,
    });
  });

  it('marks commentsProxy.get as data-only and renderCommentsPage as rendering CFML', () => {
    expect(entryOf('fe:commentsproxy.get').renderEvidence).toEqual([]);
    expect(entryOf('fe:commentsproxy.renderCommentsPage').renderEvidence).toEqual([
      { marker: 'saved-output', source: spanOf(COMMENTS_PROXY, '<cfsavecontent') },
      { marker: 'display-object', source: spanOf(COMMENTS_PROXY, '$.dspObject') },
    ]);
  });

  it('walks the name-dispatched event methods of the page render but not its API branch', () => {
    const visited = entryOf('fe:render').closure.visited;
    expect(visited).toEqual(
      expect.arrayContaining([
        `${EVENTS}#standardDoActionsHandler`,
        `${EVENTS}#standardTrackSessionValidator`,
        `${SERVER}#parseURLRoot`,
        `${DAO}#trackAsync`,
      ]),
    );
    expect(visited).not.toContain(`${SERVER}#handleAPIRequest`);
    expect(visited).not.toContain(`${EVENTS}#doAction`);
  });

  it('derives the updateprofile write set from the closure through userManager.update', () => {
    const writes = entryOf('fe:doaction=updateprofile').closure.writes;
    expect(writes.map((w) => [w.table, w.op, w.component, w.method])).toEqual([
      ['tfixture', 'update', DAO, 'update'],
      ['tfixturemembers', 'delete', DAO, 'deleteMembership'],
    ]);
    expect(entryOf('fe:doaction=updateprofile').closure.visited).toContain('core/mura/user/userManager.cfc#update');
  });

  it('reports the manager calls an entry cannot resolve', () => {
    const unresolved = (id: string): string[] => entryOf(id).closure.unresolved.map((u) => u.expr);
    expect(unresolved('fe:doaction=return').some((e) => e.includes('emailManager.track'))).toBe(true);
    expect(unresolved('fe:doaction=setReminder').some((e) => e.includes('contentManager.setReminder'))).toBe(true);
    expect(unresolved('fe:cfm:/core/modules/v1/rater/ajax/saverate.cfm').some((e) => e.includes('raterManager.saveRate'))).toBe(true);
  });

  it('leaves owning service and disposition to the disposition rule', () => {
    for (const e of extraction.frontEnd) {
      expect(Object.keys(e)).not.toContain('owningService');
      expect(Object.keys(e)).not.toContain('disposition');
    }
  });
});

