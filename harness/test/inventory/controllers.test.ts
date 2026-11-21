import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VariantDeclaration } from '@opt2/platform/legacy-compat';
import { CFML_TRUTHY, computeClosure, memorySourceTree, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { CfmlComponent, ClosureContext, ComponentIndex, Predicates, SourceTree } from '../../src/inventory/closure.js';
import {
  CONTROLLERS_DIR,
  CORE_SEARCH_SCOPE,
  MURA_ACTION_QUERY,
  PAGE_LAYOUTS,
  REQUEST_LAYOUT,
  ROLE_OVERRIDES_REF,
  VIEWS_DIR,
  VIEW_PARTIALS_REF,
  extractControllers,
  searchCoreMuraAction,
} from '../../src/inventory/controllers.js';
import type { ActionEntry, ControllerEntry, ControllerExtraction, VariantEntry } from '../../src/inventory/controllers.js';
import { OverrideError, loadRoleOverrides, loadWriterOverrides } from '../../src/inventory/overrides.js';
import type { RequiredRole, RoleOverride, RoleOverrides, SourceRef, ViewPartial } from '../../src/inventory/overrides.js';
import { inventoryRouteKey, loadInventoryVariants, normaliseInventoryKey } from '../../src/inventory/route-keys.js';
import { assertOutsideRepo } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CTL = CONTROLLERS_DIR;
const VIEWS = VIEWS_DIR;
const CFIXTURE = `${CTL}/cfixture.cfc`;
const CUSERS = `${CTL}/cusers.cfc`;
const CACTIONS = `${CTL}/cactions.cfc`;
const CMODES = `${CTL}/cmodes.cfc`;
const CSITE = `${CTL}/csite.cfc`;
const CMERGE = `${CTL}/cmerge.cfc`;
const USER_MANAGER = 'core/mura/user/userManager.cfc';
const FIXTURE_DAO = 'core/mura/fixture/fixtureDAO.cfc';
const FIXTURE_MANAGER = 'core/mura/fixture/fixtureManager.cfc';
const OVERRIDE_PREFIX = `${ROLE_OVERRIDES_REF}#`;

/** Committed CFML fixtures by their place in the temp tree. */
const COPIED: Readonly<Record<string, string>> = {
  [CFIXTURE]: 'controller-gate.cfc',
  [`${VIEWS}/cfixture/special.cfm`]: 'view-bypassed.cfm',
  [`${VIEWS}/cfixture/diff.cfm`]: 'view-fragment.cfm',
  [`${VIEWS}/cfixture/loadjson.cfm`]: 'view-json.cfm',
  [FIXTURE_DAO]: 'dao-writes.cfc',
  [FIXTURE_MANAGER]: 'manager-writes.cfc',
};

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

function lines(...text: string[]): string {
  return `${text.join('\n')}\n`;
}

function circuit(...body: string[]): string {
  return lines('component extends="controller" output="false" {', '', ...body, '', '}');
}

/** A circuit whose script before() holds `gate`, plus empty actions. */
function gated(gate: string[], ...actions: string[]): string {
  return circuit(
    '\tpublic any function before(rc) {',
    ...gate.map((l) => `\t\t${l}`),
    '\t}',
    ...actions.flatMap((a) => ['', `\tpublic any function ${a}(rc) {`, '\t}']),
  );
}

const BASE_CONTROLLER = lines(
  'component output="false" accessors="true" {',
  '',
  '\tproperty name="fw";',
  '\tproperty name="userManager";',
  '',
  '\tpublic any function init(fw) {',
  '\t\tvariables.fw = arguments.fw;',
  '\t\treturn this;',
  '\t}',
  '',
  '\tpublic any function setUserManager(userManager) {',
  '\t\tvariables.userManager = arguments.userManager;',
  '\t}',
  '',
  '\tpublic any function secure(rc) {',
  '\t\tlocation(url="./?muraAction=cLogin.main", addtoken=false);',
  '\t}',
  '',
  '\tpublic any function appendRequestScope(rc) {',
  '\t\tstructAppend(arguments.rc, request, false);',
  '\t}',
  '',
  '\tprivate any function backUp() {',
  '\t\tlocation(url=cgi.http_referer, addtoken=false);',
  '\t}',
  '',
  '}',
);

const S2_MEMBER = "listFind(session.mura.memberships, 'S2')";
const SITE_ADMIN = "listFind(session.mura.memberships, 'Admin;#rc.$.siteConfig(\"privateUserPoolID\")#;0')";

/** Inline excerpts modelled on the base controller, cusers.cfc, userManager.cfc, the before() gate shapes and the response shapes. */
const INLINE: Readonly<Record<string, string>> = {
  [`${CTL}/controller.cfc`]: BASE_CONTROLLER,
  [CUSERS]: circuit(
    '\tpublic any function before(rc) {',
    "\t\targuments.rc.isAdmin = getBean('permUtility').isPrivateAdmin(arguments.rc.siteid);",
    "\t\tif ( !arguments.rc.isAdmin && !variables.permUtility.getModulePerm('00000000000000000000000000000000008', arguments.rc.siteid) ) {",
    '\t\t\tsecure(arguments.rc);',
    '\t\t}',
    '\t}',
    '',
    '\tpublic any function list(rc) {',
    '\t}',
    '',
    '\tpublic any function update(rc) {',
    '\t\tif ( arguments.rc.$.validateCSRFTokens(context=arguments.rc.userid) ) {',
    '\t\t\tswitch(arguments.rc.action) {',
    "\t\t\t\tcase 'Update' :",
    '\t\t\t\t\tgetUserManager().update(arguments.rc);',
    '\t\t\t\t\tbreak;',
    "\t\t\t\tcase 'Delete' :",
    '\t\t\t\t\tif ( arguments.rc.type == 1 ) {',
    '\t\t\t\t\t\tgetUserManager().deleteGroup(arguments.rc.userid);',
    '\t\t\t\t\t} else {',
    '\t\t\t\t\t\tgetUserManager().delete(arguments.rc.userid);',
    '\t\t\t\t\t}',
    '\t\t\t\t\tbreak;',
    "\t\t\t\tcase 'Add' :",
    '\t\t\t\t\tgetUserManager().create(arguments.rc);',
    '\t\t\t\t\tbreak;',
    '\t\t\t}',
    '\t\t}',
    '\t\tvariables.fw.redirect(action="cUsers.list", append="siteid");',
    '\t}',
  ),
  [`${VIEWS}/cusers/list.cfm`]: lines('<cfoutput><h1>Users</h1></cfoutput>'),
  [USER_MANAGER]: lines(
    'component extends="mura.cfobject" output="false" {',
    '',
    '\tpublic any function update(required struct data) {',
    "\t\treturn getBean('fixtureDAO').update(arguments.data.userid, arguments.data.name);",
    '\t}',
    '',
    '\tpublic any function create(required struct data) {',
    "\t\treturn getBean('fixtureDAO').create(arguments.data);",
    '\t}',
    '',
    '\tpublic any function deleteGroup(required string groupid) {',
    "\t\tgetBean('fixtureDAO').deleteMembership(arguments.groupid, arguments.groupid);",
    '\t}',
    '',
    '\tpublic any function delete(required string userid) {',
    "\t\tgetBean('fixtureDAO').deleteMembership(arguments.userid, '');",
    '\t\tqueryExecute("DELETE FROM tfixture WHERE userid = :userid", {userid=arguments.userid});',
    '\t}',
    '',
    '}',
  ),
  [`${VIEWS}/cfixture/list.cfm`]: lines(
    '<cfinclude template="dsp_header.cfm">',
    '<cfoutput><h1>Fixtures</h1></cfoutput>',
    '<cfinclude template="summary.cfm">',
    '<cfinclude template="#rc.extraView#">',
    '<cfinclude template="missing.cfm">',
    '<cfinclude template="edit.cfm">',
    '<cfoutput><a href="./?muraAction=cFixture.edit&fixtureid=#rc.fixtureid#">Edit</a></cfoutput>',
    '<!--- <a href="./?muraAction=cFixture.summary">Summary</a> --->',
  ),
  [`${VIEWS}/cfixture/summary.cfm`]: lines('<cfoutput><p>#rc.rs.recordcount#</p></cfoutput>'),
  [`${VIEWS}/cfixture/edit.cfm`]: lines('<cfoutput><h2>Edit fixture</h2></cfoutput>'),
  [`${VIEWS}/cfixture/dsp_header.cfm`]: lines('<cfoutput><h2>Header</h2></cfoutput>'),
  [`${VIEWS}/cfixture/download.cfm`]: lines('<cfinclude template="inc/dsp_download.cfm">'),
  [`${VIEWS}/cfixture/inc/dsp_download.cfm`]: lines(
    '<cfheader name="Content-Disposition" value="attachment;filename=fixtures.csv">',
    '<cfcontent type="text/csv" reset="true"><cfoutput>id,name</cfoutput>',
  ),
  [`${CTL}/cadmin.cfc`]: gated(
    [
      "if ( !listFind(session.mura.memberships, 'Admin;#variables.settingsManager.getSite(arguments.rc.siteid).getPrivateUserPoolID()#;0') && !listFind(session.mura.memberships, 'S2') ) {",
      '\tsecure(arguments.rc);',
      '}',
    ],
    'main',
  ),
  [`${CTL}/cs2.cfc`]: gated(
    [
      `local.isS2 = ${S2_MEMBER};`,
      'arguments.rc.note = "S2; only";',
      'if ( !local.isS2 ) secure(arguments.rc);',
      "if ( listLast(arguments.rc.muraAction, '.') == 'other' && false ) secure(arguments.rc);",
    ],
    'main',
  ),
  [`${CTL}/cloggedin.cfc`]: gated(
    ['if ( session.mura.isLoggedIn ) {', '\targuments.rc.ok = true;', '} else {', '\tsecure(arguments.rc);', '}'],
    'main',
  ),
  [`${CTL}/cmodule.cfc`]: gated(
    ["if ( !variables.permUtility.getModulePerm('00000000000000000000000000000000010', arguments.rc.siteid) ) secure(arguments.rc);"],
    'main',
  ),
  [`${CTL}/cpair.cfc`]: gated(
    [
      "if ( !(permUtility.getModulePerm('00000000000000000000000000000000000', rc.siteid) && permUtility.getModulePerm('00000000000000000000000000000000014', rc.siteid)) ) {",
      '\tsecure(arguments.rc);',
      '}',
    ],
    'main',
  ),
  [`${CTL}/cmixed.cfc`]: gated([`if ( !${S2_MEMBER} && !session.mura.isLoggedIn ) secure(arguments.rc);`], 'main'),
  [`${CTL}/cdeny.cfc`]: gated(['secure(arguments.rc);', 'if ( true and yes ) secure(arguments.rc);'], 'main'),
  [CSITE]: gated(
    ['param name="arguments.rc.siteid" default="default";', `if ( !${SITE_ADMIN} && !${S2_MEMBER} ) {`, '\tsecure(arguments.rc);', '}'],
    'edit',
    'main',
  ),
  [CACTIONS]: gated(
    [
      `if ( listFindNoCase('edit,save', listLast(arguments.rc.muraAction, '.')) and not ${S2_MEMBER} ) {`,
      '\tsecure(arguments.rc);',
      "} else if ( listLast(arguments.rc.muraAction, '.') eq 'view' && !session.mura.isLoggedIn ) {",
      '\tsecure(arguments.rc);',
      '}',
      'if ( false ) secure(arguments.rc);',
    ],
    'edit',
    'home',
    'save',
    'view',
  ),
  [`${CTL}/cunknown.cfc`]: gated(
    [
      "if ( listLast(arguments.rc.muraAction, '.') == 'purge' && !getBean('fixtureGate').allows(arguments.rc) ) {",
      '\tsecure(arguments.rc);',
      '}',
    ],
    'main',
  ),
  [`${CTL}/cops.cfc`]: gated(
    [
      "if ( listLast(arguments.rc.muraAction, ':') is not 'cOps.open' and (arguments.rc.count + 1 gt 5 or arguments.rc.name does not contain \"x\") ) {",
      '\tsecure(arguments.rc);',
      '}',
      'if ( arguments.rc.flag does contain "y" ) secure(arguments.rc);',
      "if ( arguments.rc.mode == 'x' || arguments.rc.a <> arguments.rc.b ) secure(arguments.rc);",
    ],
    'main',
  ),
  [`${CTL}/ctag.cfc`]: lines(
    '<cfcomponent extends="controller" output="false">',
    '',
    '<cffunction name="before" output="false">',
    '\t<cfargument name="rc">',
    "\t<cfif not listFind(session.mura.memberships, 'S2')>",
    '\t\t<cfset secure(arguments.rc)>',
    '\t</cfif>',
    '</cffunction>',
    '',
    '<cffunction name="main" output="false">',
    '\t<cfargument name="rc">',
    '</cffunction>',
    '',
    '<cffunction name="hidden" access="package" output="false">',
    '</cffunction>',
    '',
    '</cfcomponent>',
  ),
  [CMODES]: circuit(
    '\tpublic any function exportCsv(rc) {',
    '\t\tcfheader(name="Content-Disposition", value="attachment; filename=fixtures.csv");',
    '\t\tcfcontent(type="text/csv", variable=arguments.rc.bytes);',
    '\t}',
    '',
    '\tpublic any function stream(rc) {',
    '\t\tgetPageContext().getResponse().setContentType("application/pdf");',
    '\t\tcfcontent(type="application/pdf", file=arguments.rc.path);',
    '\t}',
    '',
    '\tpublic any function loadData(rc) {',
    '\t\tgetPageContext().getResponse().setContentType("application/json; charset=utf-8");',
    '\t\twriteOutput(serializeJSON(arguments.rc.data));',
    '\t\tabort;',
    '\t}',
    '',
    '\tpublic any function ping(rc) {',
    '\t\twriteOutput("ok");',
    '\t\tabort;',
    '\t}',
    '',
    '\tpublic any function save(rc) {',
    '\t\tvar uploaded = fileUpload(getTempDirectory(), "file");',
    '\t\tvariables.fw.redirect(action="cModes.list", append="siteid");',
    '\t}',
    '',
    '\tpublic any function go(rc) {',
    '\t\tlocation("./?muraAction=cModes.list", false);',
    '\t}',
    '',
    '\tpublic any function finish(rc) {',
    '\t\tgo(arguments.rc);',
    '\t}',
    '',
    '\tpublic any function list(rc) {',
    '\t}',
    '',
    '\tpublic any function field(rc) {',
    '\t}',
    '',
    '\tpublic any function object(rc) {',
    '\t}',
    '',
    '\tremote any function approve(rc) {',
    '\t\tif ( arguments.rc.$.validateCSRFTokens(context=arguments.rc.contentid) ) {',
    '\t\t\targuments.rc.approved = true;',
    '\t\t}',
    '\t}',
    '',
    '\tpublic any function confirm(rc) {',
    "\t\tif ( arguments.rc.step == 1 && arguments.rc.$.validateCSRFTokens(context='it''s') ) {",
    '\t\t\targuments.rc.ok = true;',
    '\t\t} else if ( arguments.rc.$.validateCSRFTokens(context=listFirst(arguments.rc.ids, ",")) ) {',
    '\t\t\targuments.rc.ok = true;',
    '\t\t} else if ( arguments.rc.$.validateCSRFTokens(context="#arguments.rc.contentid#") ) {',
    '\t\t\targuments.rc.ok = true;',
    '\t\t}',
    '\t}',
  ),
  [`${VIEWS}/cmodes/ping.cfm`]: lines('<cfoutput><p>never rendered</p></cfoutput>'),
  [`${VIEWS}/cmodes/save.cfm`]: lines('<cfinclude template="list.cfm">', '<cfoutput><p>Saved</p></cfoutput>'),
  [`${VIEWS}/cmodes/list.cfm`]: lines('<cfoutput><h1>Modes</h1></cfoutput>'),
  [`${VIEWS}/cmodes/field.cfm`]: lines('<cfoutput><div class="field">#rc.name#</div></cfoutput>', '<cfabort>'),
  [`${VIEWS}/cmodes/object.cfm`]: lines('<cfcontent type="Text/Plain; charset=utf-8">', '<cfoutput>{"ok":true}</cfoutput>', '<cfabort>'),
  [`${VIEWS}/cmodes/approve.cfm`]: lines('<cfif rc.$.validateCSRFTokens("")>', '\t<cfoutput>Approved</cfoutput>', '</cfif>'),
  [CMERGE]: circuit(
    '\tpublic any function save(rc) {',
    "\t\tgetBean('fixtureDAO').create(arguments.rc);",
    '\t\tqueryExecute("INSERT INTO tfixture (fixtureID) VALUES (:fixtureid)", {fixtureid=arguments.rc.fixtureid});',
    "\t\tif ( arguments.rc.mode == 'b' ) {",
    "\t\t\tgetBean('fixtureDAO').deleteMembership(arguments.rc.userid, arguments.rc.groupid);",
    '\t\t}',
    "\t\tgetBean('fixtureDAO').trackAsync(arguments.rc.siteid);",
    "\t\tgetBean('fixtureManager').trackStats(arguments.rc.siteid);",
    "\t\tgetBean('fixtureDAO').refreshLogin(arguments.rc.userBean);",
    "\t\tgetBean('fileManager').deleteVersion(arguments.rc.fileid);",
    "\t\tgetBean('fileManager').deleteAll(arguments.rc.siteid);",
    "\t\tgetBean('noSuchBean').save(arguments.rc);",
    "\t\tgetBean('otherBean').delete(arguments.rc.id);",
    '\t}',
  ),
  'core/mura/login/loginManager.cfc': lines(
    'component extends="mura.cfobject" output="false" {',
    '\tpublic any function editProfileURL() {',
    '\t\treturn "#application.configBean.getAdminPath()#/?muraAction=cEditProfile.edit";',
    '\t}',
    '\tpublic any function loginURL() {',
    '\t\treturn "./?muraAction=cLogin.main&returnURL=" & urlEncodedFormat(cgi.script_name);',
    '\t}',
    '}',
  ),
  'core/mura/fixture/actionReader.cfm': lines(
    '<cfif isDefined("url.muraAction")>',
    '\t<cfset request.lastAction = url.muraAction>',
    '</cfif>',
  ),
  'core/mura/plain.cfc': lines('component output="false" {', '}'),
  'core/vendor/fw1/framework.cfc': lines('component {', '\tswitch (url.muraAction) {', '\t}', '}'),
  'admin/Application.cfc': lines(
    'component extends="framework" output="false" {',
    '\tvariables.framework = structNew();',
    '\tvariables.framework.action = "muraAction";',
    '\tvariables.framework.home = "core:cdashboard.main";',
    '',
    '\tpublic any function setupRequest() {',
    '\t\tif ( structKeyExists(form, "fuseaction") ) {',
    '\t\t\tform.muraAction = form.fuseaction;',
    '\t\t}',
    '\t\tif ( structKeyExists(url, "fuseaction") ) {',
    '\t\t\turl.muraAction = url.fuseaction;',
    '\t\t}',
    '\t}',
    '}',
  ),
};

const BEANS: Readonly<Record<string, string>> = {
  usermanager: USER_MANAGER,
  fixturedao: FIXTURE_DAO,
  fixturemanager: FIXTURE_MANAGER,
};

const CEDGE = `${CTL}/cedge.cfc`;

/** An in-memory circuit whose token check, content declarations and redirects use the argument-less and empty forms. */
const EDGE_FILES: Readonly<Record<string, string>> = {
  [`${CTL}/controller.cfc`]: BASE_CONTROLLER,
  [CEDGE]: circuit(
    '\tpublic any function token(rc) {',
    '\t\tif ( arguments.rc.$.validateCSRFTokens() ) {',
    '\t\t\targuments.rc.ok = true;',
    '\t\t}',
    '\t}',
    '',
    '\tpublic any function raw(rc) {',
    '\t\tcfcontent(reset=true);',
    '\t\twriteOutput(arguments.rc.body);',
    '\t\tabort;',
    '\t}',
    '',
    '\tpublic any function back(rc) {',
    '\t\tvariables.fw.redirect();',
    '\t}',
    '',
    '\tpublic any function finish(rc) {',
    '\t\tnote(arguments.rc);',
    '\t\tclose(arguments.rc);',
    '\t}',
    '',
    '\tprivate any function note(rc) {',
    '\t\targuments.rc.noted = true;',
    '\t}',
    '',
    '\tprivate any function close(rc) {',
    '\t\tvariables.fw.redirect(action="cEdge.list", append="siteid");',
    '\t}',
  ),
  [`${VIEWS}/cedge/plain.cfm`]: lines('<cfcontent type="; charset=utf-8">', '<cfoutput><p>plain</p></cfoutput>', '<cfabort>'),
};

/** Variants the committed file does not declare, for the variant forms and the match-order checks. */
const CUSTOM_VARIANTS: readonly VariantDeclaration[] = [
  { route: 'admin:cfixture.update', variant: 'action=add', when: [{ param: 'action', equals: 'Add' }] },
  { route: 'admin:cfixture.update', variant: 'action=change', when: [{ param: 'action', in: ['Update', 'Delete'] }] },
  { route: 'admin:cfixture.remove', variant: 'upload=image', when: [{ multipartExtensionIn: ['png', 'jpg'] }] },
  {
    route: 'admin:cfixture.remove',
    variant: 'flagged',
    when: [{ param: 'confirm', truthy: true }, { not: { param: 'type', equals: '1' } }],
  },
  {
    route: 'admin:cmerge.save',
    variant: 'narrow',
    when: [
      { param: 'mode', nonEmpty: true },
      { param: 'mode', in: ['a', 'b'] },
      { param: 'MODE', equals: 'A' },
      { param: 'mode', nonEmpty: true },
    ],
  },
  { route: 'admin:cmerge.save', variant: 'mode', when: [{ param: 'mode', in: ['b', 'a'] }] },
];

/** Closure predicates of the committed cusers.update declarations, one list of alternatives per declaration in file order. */
const CUSERS_UPDATE_PREDICATES: ReadonlyArray<readonly Predicates[]> = [
  [{ newFile: true }, { removePhotoFile: CFML_TRUTHY }],
  [{ type: '2', action: 'Add', extendSetID: true }],
  [{ type: '2', action: 'Update', extendSetID: true }],
  [{ type: '1', action: 'Delete' }],
  [{ type: '1', extendSetID: true }],
  [{ type: '2', action: 'Add' }],
  [{ type: '2', action: 'Delete' }],
  [{ type: '2', action: 'Update' }],
  [{ type: '1' }],
];

let root = '';
let tree: SourceTree;
let ctx: ClosureContext;
let customCtx: ClosureContext;
let variants: readonly VariantDeclaration[];
let roleOverrides: RoleOverrides;
let extraction: ControllerExtraction;
let custom: ControllerExtraction;

/** Component index over `source` with the fixture bean registrations. */
function fixtureIndex(source: SourceTree): ComponentIndex {
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

function textOf(rel: string): string {
  const inline = INLINE[rel];
  if (inline !== undefined) return inline;
  const copied = COPIED[rel];
  if (copied === undefined) throw new Error(`no tree file ${rel}`);
  return readFileSync(fixturePath(`cfml/${copied}`), 'utf8');
}

/** 1-based line of the first line of `rel` that contains `needle`. */
function lineIn(rel: string, needle: string): number {
  const line = textOf(rel).split('\n').findIndex((l) => l.includes(needle));
  if (line < 0) throw new Error(`${rel} has no line containing ${JSON.stringify(needle)}`);
  return line + 1;
}

/** Lines from the first line of `rel` containing `first` to the first containing `last`. */
function span(rel: string, first: string, last: string): SourceRef {
  return { path: rel, lines: [lineIn(rel, first), lineIn(rel, last)] };
}

/** Lines from the first line of `rel` containing `first` through `more` lines after it. */
function block(rel: string, first: string, more: number): SourceRef {
  const line = lineIn(rel, first);
  return { path: rel, lines: [line, line + more] };
}

function controllerOf(result: ControllerExtraction, name: string): ControllerEntry {
  const found = result.controllers.find((c) => c.circuit === name);
  if (found === undefined) throw new Error(`no controller ${name}`);
  return found;
}

function actionOf(result: ControllerExtraction, id: string): ActionEntry {
  const found = result.controllers.flatMap((c) => c.actions).find((a) => a.id === id);
  if (found === undefined) throw new Error(`no action ${id}`);
  return found;
}

function variantOf(result: ControllerExtraction, id: string, routeKey: string): VariantEntry {
  const found = actionOf(result, id).variants.find((v) => v.routeKey === routeKey);
  if (found === undefined) throw new Error(`${id} has no variant ${routeKey}`);
  return found;
}

function onlyVariant(result: ControllerExtraction, id: string): VariantEntry {
  const [variant, ...rest] = actionOf(result, id).variants;
  if (variant === undefined || rest.length > 0) throw new Error(`${id} does not have exactly one variant`);
  return variant;
}

function memoryContext(files: Readonly<Record<string, string>>): ClosureContext {
  const source = memorySourceTree(files);
  return { tree: source, index: fixtureIndex(source) };
}

function inlineFiles(...rels: string[]): Record<string, string> {
  return Object.fromEntries(rels.map((rel) => [rel, textOf(rel)]));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-controllers-'));
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fixturePath(`cfml/${name}`), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  tree = openSourceTree(root);
  ctx = { tree, index: fixtureIndex(tree) };
  variants = (await loadInventoryVariants()).variants;
  roleOverrides = await loadRoleOverrides(fixturePath('inventory/role-overrides.valid.yaml'));
  extraction = await extractControllers(ctx, { variants, roleOverrides });
  const overrides = await loadWriterOverrides(fixturePath('inventory/writer-overrides.valid.yaml'));
  customCtx = { ...ctx, overrides };
  custom = await extractControllers(customCtx, { variants: CUSTOM_VARIANTS, roleOverrides });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('controllers constants', () => {
  it('name the admin folders, the override file, the page layouts and the core search', () => {
    expect([CONTROLLERS_DIR, VIEWS_DIR, ROLE_OVERRIDES_REF, VIEW_PARTIALS_REF]).toEqual([
      'admin/core/controllers',
      'admin/core/views',
      'harness/inventory/role-overrides.yaml',
      'harness/inventory/view-partials.yaml',
    ]);
    expect(PAGE_LAYOUTS).toEqual(['template', 'compact']);
    expect(Object.isFrozen(PAGE_LAYOUTS)).toBe(true);
    expect([REQUEST_LAYOUT, MURA_ACTION_QUERY, CORE_SEARCH_SCOPE]).toEqual(['request', 'muraAction', 'core/** excluding core/vendor']);
  });
});

describe('circuits and actions', () => {
  it('records one entry per controller file, sorted by id, and marks the extended controller as the base', () => {
    expect(extraction.controllers.map((c) => [c.id, c.isBase])).toEqual([
      ['ctl:cactions', false],
      ['ctl:cadmin', false],
      ['ctl:cdeny', false],
      ['ctl:cfixture', false],
      ['ctl:cloggedin', false],
      ['ctl:cmerge', false],
      ['ctl:cmixed', false],
      ['ctl:cmodes', false],
      ['ctl:cmodule', false],
      ['ctl:controller', true],
      ['ctl:cops', false],
      ['ctl:cpair', false],
      ['ctl:cs2', false],
      ['ctl:csite', false],
      ['ctl:ctag', false],
      ['ctl:cunknown', false],
      ['ctl:cusers', false],
    ]);
    expect(extraction.counts).toEqual({ circuits: 16, base: 1, actions: 40, viewOnlyActions: 6, variants: 49 });
  });

  it('spans each entry from its declaration line to the last line of the file', () => {
    expect(controllerOf(extraction, 'cfixture').source).toEqual({ path: CFIXTURE, lines: [2, textOf(CFIXTURE).split('\n').length - 1] });
    expect(controllerOf(extraction, 'controller').source).toEqual({ path: `${CTL}/controller.cfc`, lines: [1, 27] });
  });

  it('lists every base-controller function as a helper and none of them as an action', () => {
    const base = controllerOf(extraction, 'controller');
    expect(base.helpers.map((h) => h.name)).toEqual(['appendRequestScope', 'backUp', 'init', 'secure', 'setUserManager']);
    expect(base.helpers[0]?.source).toEqual(block(`${CTL}/controller.cfc`, 'function appendRequestScope', 2));
    expect(base.actions).toEqual([]);
    expect(controllerOf(extraction, 'cfixture').helpers).toEqual([]);
  });

  it('excludes lifecycle, base-helper, setter, generated accessor and private functions with their reasons', () => {
    const base = `${CTL}/controller.cfc`;
    expect(controllerOf(extraction, 'controller').excludedMethods).toEqual([
      { name: 'appendRequestScope', reason: 'base-helper', source: { path: base, lines: [19, 21] } },
      { name: 'backUp', reason: 'not-public', source: { path: base, lines: [23, 25] } },
      { name: 'getFw', reason: 'accessor', source: { path: base, lines: [3, 3] } },
      { name: 'getUserManager', reason: 'accessor', source: { path: base, lines: [4, 4] } },
      { name: 'init', reason: 'lifecycle', source: { path: base, lines: [6, 9] } },
      { name: 'secure', reason: 'base-helper', source: { path: base, lines: [15, 17] } },
      { name: 'setFw', reason: 'accessor', source: { path: base, lines: [3, 3] } },
      { name: 'setUserManager', reason: 'di-setter', source: { path: base, lines: [11, 13] } },
    ]);
    expect(controllerOf(extraction, 'ctag').excludedMethods.map((m) => [m.name, m.reason])).toEqual([
      ['before', 'lifecycle'],
      ['hidden', 'not-public'],
    ]);
  });

  it('takes public and remote methods as actions and views without a method as view-only actions', () => {
    expect(controllerOf(extraction, 'cfixture').actions.map((a) => [a.id, a.name, a.kind, a.viewPath])).toEqual([
      ['ctl:cfixture.diff', 'diff', 'view-only', `${VIEWS}/cfixture/diff.cfm`],
      ['ctl:cfixture.download', 'download', 'view-only', `${VIEWS}/cfixture/download.cfm`],
      ['ctl:cfixture.edit', 'edit', 'view-only', `${VIEWS}/cfixture/edit.cfm`],
      ['ctl:cfixture.list', 'list', 'method', `${VIEWS}/cfixture/list.cfm`],
      ['ctl:cfixture.loadjson', 'loadjson', 'view-only', `${VIEWS}/cfixture/loadjson.cfm`],
      ['ctl:cfixture.remove', 'remove', 'method', null],
      ['ctl:cfixture.special', 'special', 'view-only', `${VIEWS}/cfixture/special.cfm`],
      ['ctl:cfixture.summary', 'summary', 'view-only', `${VIEWS}/cfixture/summary.cfm`],
      ['ctl:cfixture.update', 'update', 'method', null],
    ]);
    const approve = actionOf(extraction, 'ctl:cmodes.approve');
    expect([approve.kind, approve.action, approve.viewPath]).toEqual(['method', 'approve', `${VIEWS}/cmodes/approve.cfm`]);
    expect(actionOf(extraction, 'ctl:cmodes.exportcsv').name).toBe('exportCsv');
  });

  it('keys every action as the platform keys the same admin entry point, in canonical lower case', async () => {
    const actions = extraction.controllers.flatMap((c) => c.actions.map((a) => ({ c, a })));
    expect(actions).toHaveLength(extraction.counts.actions);
    for (const { c, a } of actions) {
      const keyed = await inventoryRouteKey({ kind: 'admin', action: `${c.circuit}.${a.name}` }, { variants });
      expect([a.variants.at(-1)?.routeKey, a.variants.at(-1)?.predicate]).toEqual([keyed.key, null]);
      expect([keyed.key, a.id]).toEqual([`admin:${c.circuit.toLowerCase()}.${a.action}`, `ctl:${c.circuit.toLowerCase()}.${a.action}`]);
      expect(normaliseInventoryKey(keyed.key)).toBe(keyed.key);
    }
    expect(onlyVariant(extraction, 'ctl:cfixture.update').routeKey).toBe('admin:cfixture.update');
  });

  it('spans a method action over its function and a view-only action over its whole view', () => {
    expect(actionOf(extraction, 'ctl:cfixture.update').source).toEqual({
      path: CFIXTURE,
      lines: [lineIn(CFIXTURE, 'function update'), lineIn(CFIXTURE, 'function remove') - 2],
    });
    expect(actionOf(extraction, 'ctl:cfixture.special').source).toEqual({ path: `${VIEWS}/cfixture/special.cfm`, lines: [1, 4] });
    expect(actionOf(extraction, 'ctl:cfixture.download').source).toEqual({ path: `${VIEWS}/cfixture/download.cfm`, lines: [1, 1] });
  });

  it('excludes only dsp_ includes and subfolders from the view-only actions without reviewed partials', () => {
    expect(controllerOf(extraction, 'cfixture').excludedViews).toEqual([
      { path: `${VIEWS}/cfixture/dsp_header.cfm`, reason: 'dsp-include' },
      { path: `${VIEWS}/cfixture/inc`, reason: 'subfolder' },
    ]);
  });

  it('keeps every included view as an action, with its includers and the references addressing it', () => {
    const list = `${VIEWS}/cfixture/list.cfm`;
    const link = lineIn(list, 'muraAction=cFixture.edit');
    expect(actionOf(extraction, 'ctl:cfixture.edit').reachability).toEqual({
      includedBy: [list],
      addressedBy: [{ path: list, lines: [link, link] }],
    });
    expect(actionOf(extraction, 'ctl:cfixture.summary').reachability).toEqual({ includedBy: [list], addressedBy: [] });
    expect(onlyVariant(extraction, 'ctl:cfixture.edit').routeKey).toBe('admin:cfixture.edit');
    expect(onlyVariant(extraction, 'ctl:cfixture.summary').routeKey).toBe('admin:cfixture.summary');
    const included = extraction.controllers.flatMap((c) => c.actions).filter((a) => a.reachability !== undefined);
    expect(included.map((a) => a.id)).toEqual(['ctl:cfixture.edit', 'ctl:cfixture.summary']);
  });

  const MENU = `${VIEWS}/cpart/dsp_menu.cfm`;
  const OTHER = `${CTL}/cother.cfc`;
  const PART_LIST = `${VIEWS}/cpart/list.cfm`;
  const PART_EDIT = `${VIEWS}/cpart/edit.cfm`;
  /** A circuit whose list view includes an edit view and a dsp_ include. */
  const PART_FILES: Readonly<Record<string, string>> = {
    [`${CTL}/controller.cfc`]: BASE_CONTROLLER,
    [`${CTL}/cpart.cfc`]: circuit('\tpublic any function list(rc) {', '\t}'),
    [PART_LIST]: lines('<cfinclude template="edit.cfm">', '<cfinclude template="dsp_form.cfm">'),
    [PART_EDIT]: lines('<cfoutput><h2>Edit</h2></cfoutput>'),
    [`${VIEWS}/cpart/dsp_form.cfm`]: lines('<form></form>'),
  };
  /** The reviewed partial record of the cpart edit view, with `edits` applied. */
  const partOf = (edits: Partial<ViewPartial> = {}): ViewPartial => ({
    id: 'vp:cpart.edit',
    view: PART_EDIT,
    includers: [{ path: PART_LIST, lines: [1, 1] }],
    reason: 'Rendered only inside the list view.',
    ...edits,
  });
  const go = (line: string): string => circuit('\tpublic any function go(rc) {', `\t\t${line}`, '\t}');
  it.each<[string, string, string, [number, number] | null]>([
    ['a muraAction link in a view', MENU, '<a href="./?muraAction=cPart.edit&id=#rc.id#">Edit</a>', [1, 1]],
    ['an upper-case link outside the circuit', 'admin/common/menu.cfm', '<a href="./?MURAACTION=cpart.Edit">Edit</a>', [1, 1]],
    ['a core:-qualified fuseaction link', MENU, '<a href="./?fuseaction=core:cpart.edit">Edit</a>', [1, 1]],
    ['a hidden muraAction field', MENU, '<input type="hidden" name="muraAction" value="cpart.edit">', [1, 1]],
    ['a field naming its value first', MENU, '<input value="cPart.edit" type="hidden" name="muraAction">', [1, 1]],
    ['a field tag over two lines', MENU, '<input name="muraAction"\n\tvalue="cpart.edit">', [1, 2]],
    ['a buildURL call in a view', MENU, '<a href="#buildURL(\'cpart.edit\')#">Edit</a>', [1, 1]],
    ['a redirect in another controller', OTHER, go('variables.fw.redirect(action="cPart.edit", append="siteid");'), [4, 4]],
    ['a setView in another controller', OTHER, go('getFW().setView("cpart.edit");'), [4, 4]],
    ['a script URL in an admin asset', 'admin/assets/js/cpart.js', "$.ajax({url: './?muraAction=cpart.edit', data: {}});", [1, 1]],
    ['a core component', 'core/mura/part/urls.cfc', lines('component {', '\tvariables.edit = "./?muraAction=cPart.edit";', '}'), [2, 2]],
    ['a commented-out link', MENU, '<!--- <a href="./?muraAction=cpart.edit">Edit</a> --->', null],
    ['a script comment in a controller', OTHER, go('// variables.fw.redirect(action="cpart.edit");'), null],
    ["another circuit's action of the same name", MENU, '<a href="./?muraAction=cother.edit">Edit</a>', null],
    ['a longer action name', MENU, '<a href="./?muraAction=cpart.editor">Edit</a>', null],
    ['a dynamic action', MENU, '<a href="./?muraAction=#rc.circuit#.edit">Edit</a>', null],
    ['a link to the dsp_ include', MENU, '<a href="./?muraAction=cpart.dsp_form">Form</a>', null],
    ['a vendor file', 'core/vendor/lib/page.cfm', '<a href="./?muraAction=cpart.edit">Edit</a>', null],
    ['a file outside admin and core', 'sites/default/page.cfm', '<a href="./?muraAction=cpart.edit">Edit</a>', null],
  ])('keeps an included view as an action and records its references from %s', async (_label, rel, text, refLines) => {
    const files = { ...PART_FILES, [rel]: text };
    const result = await extractControllers(memoryContext(files), { variants, roleOverrides });
    const cpart = controllerOf(result, 'cpart');
    expect(cpart.excludedViews.filter((v) => v.path !== MENU)).toEqual([{ path: `${VIEWS}/cpart/dsp_form.cfm`, reason: 'dsp-include' }]);
    expect(cpart.actions.map((a) => [a.id, a.kind, a.viewPath])).toEqual([
      ['ctl:cpart.edit', 'view-only', PART_EDIT],
      ['ctl:cpart.list', 'method', PART_LIST],
    ]);
    expect(actionOf(result, 'ctl:cpart.edit').reachability).toEqual({
      includedBy: [PART_LIST],
      addressedBy: refLines === null ? [] : [{ path: rel, lines: refLines }],
    });
  });

  it('excludes a reviewed partial with its reference and includers instead of keeping it as an action', async () => {
    const viewPartials = { sourceSha: pinnedSha(), partials: [partOf()] };
    const result = await extractControllers(memoryContext(PART_FILES), { variants, roleOverrides, viewPartials });
    const cpart = controllerOf(result, 'cpart');
    expect(cpart.actions.map((a) => a.id)).toEqual(['ctl:cpart.list']);
    expect(cpart.excludedViews).toEqual([
      { path: `${VIEWS}/cpart/dsp_form.cfm`, reason: 'dsp-include' },
      { path: PART_EDIT, reason: 'reviewed-partial', ref: `${VIEW_PARTIALS_REF}#vp:cpart.edit`, includedBy: [PART_LIST] },
    ]);
    expect(result.counts).toMatchObject({ actions: 1, viewOnlyActions: 0, variants: 1 });
  });

  it.each<[string, Partial<ViewPartial>, Record<string, string>, string]>([
    ['an absent view', { id: 'vp:cpart.gone', view: `${VIEWS}/cpart/gone.cfm` }, {}, `${VIEWS}/cpart/gone.cfm does not exist`],
    [
      'a view of no controller',
      { id: 'vp:cnone.edit', view: `${VIEWS}/cnone/edit.cfm` },
      { [`${VIEWS}/cnone/edit.cfm`]: lines('<p>edit</p>') },
      `${VIEWS}/cnone/edit.cfm belongs to no controller of ${CTL}`,
    ],
    [
      'a view nothing includes',
      { id: 'vp:cpart.alone', view: `${VIEWS}/cpart/alone.cfm` },
      { [`${VIEWS}/cpart/alone.cfm`]: lines('<p>alone</p>') },
      `${VIEWS}/cpart/alone.cfm is not included by another view`,
    ],
    [
      'includers other than the includes',
      { includers: [{ path: PART_LIST, lines: [5, 5] }] },
      {},
      `includers ${PART_LIST}:5-5 differ from its includes ${PART_LIST}:1-1`,
    ],
    [
      'a method action view',
      {},
      { [`${CTL}/cpart.cfc`]: circuit('\tpublic any function list(rc) {', '\t}', '', '\tpublic any function edit(rc) {', '\t}') },
      `${PART_EDIT} is the view of the cpart.edit method action`,
    ],
    [
      'a dsp_ include',
      { id: 'vp:cpart.dsp_form', view: `${VIEWS}/cpart/dsp_form.cfm`, includers: [{ path: PART_LIST, lines: [2, 2] }] },
      {},
      `${VIEWS}/cpart/dsp_form.cfm is a dsp_ include, excluded by its name`,
    ],
    [
      'a view addressed as an action',
      {},
      { [MENU]: '<a href="./?muraAction=cPart.edit">Edit</a>' },
      `cpart.edit is addressed as an action at ${MENU}:1-1`,
    ],
  ])('rejects a reviewed partial the tree contradicts: %s', async (_label, edits, extra, issue) => {
    const record = partOf(edits);
    const viewPartials = { sourceSha: pinnedSha(), partials: [record] };
    const run = extractControllers(memoryContext({ ...PART_FILES, ...extra }), { variants, roleOverrides, viewPartials });
    const error: unknown = await run.then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(OverrideError);
    expect([(error as OverrideError).path, (error as OverrideError).issues]).toEqual([VIEW_PARTIALS_REF, [`${record.id}: ${issue}`]]);
  });

  it('throws on a controller file that declares no component', async () => {
    const broken = memoryContext({ [`${CTL}/cbroken.cfc`]: lines('<cfset x = 1>') });
    await expect(extractControllers(broken, { variants, roleOverrides })).rejects.toThrow(
      `${CTL}/cbroken.cfc is not a CFML component`,
    );
  });
});

describe('required role', () => {
  it.each<[string, string, RequiredRole]>([
    ['cadmin', 'P1', { anyOf: ['s2', 'site-admin'] }],
    ['cfixture', 'P2', { anyOf: ['s2', 'site-admin', 'm:008'] }],
    ['cpair', 'P2', { anyOf: ['s2', 'site-admin', { allOf: ['m:014', 'm:000'] }] }],
    ['cs2', 'P3', 's2'],
    ['cmodule', 'P4', { anyOf: ['s2', 'site-admin', 'm:010'] }],
    ['cloggedin', 'P5', { anyOf: ['system-user', 'member'] }],
    ['cmodes', 'P0', 'public'],
    ['cactions', 'P0', 'public'],
  ])('classifies the %s gate as %s', (name, pattern, role) => {
    const c = controllerOf(extraction, name);
    expect([c.requiredRole.pattern, c.requiredRole.classification, c.requiredRole.unclassified, c.requiredRole.override]).toEqual([
      pattern,
      role,
      false,
      null,
    ]);
  });

  it.each(['cadmin', 'cpair', 'cs2', 'cmodule', 'cloggedin', 'cmodes'])('gives every %s action variant the circuit gate', (name) => {
    const c = controllerOf(extraction, name);
    expect(c.actions).not.toHaveLength(0);
    for (const action of c.actions) for (const v of action.variants) expect(v.requiredRole).toEqual(c.requiredRole);
  });

  it('records the guarded gate condition with the lines from its if to its body end', () => {
    expect(controllerOf(extraction, 'cfixture').requiredRole).toEqual({
      gate:
        "ListLast(arguments.rc.muraAction, ':') != 'cFixture.special' && !arguments.rc.isAdmin && " +
        "!variables.permUtility.getModulePerm('00000000000000000000000000000000008', arguments.rc.siteid)",
      classification: { anyOf: ['s2', 'site-admin', 'm:008'] },
      pattern: 'P2',
      unclassified: false,
      source: { path: CFIXTURE, lines: [8, 10] },
      override: null,
    });
    expect(controllerOf(extraction, 'cloggedin').requiredRole.gate).toBe('!(session.mura.isLoggedIn)');
    expect(controllerOf(extraction, 'cs2').requiredRole).toMatchObject({
      gate: '!local.isS2',
      source: span(`${CTL}/cs2.cfc`, '!local.isS2', '!local.isS2'),
    });
  });

  it('names the before() state when no secure() call applies', () => {
    expect(controllerOf(extraction, 'cmodes').requiredRole).toMatchObject({ gate: 'no before()', source: { path: CMODES, lines: [1, 1] } });
    expect(controllerOf(extraction, 'cactions').requiredRole).toMatchObject({
      gate: 'before() calls no secure()',
      source: { path: CACTIONS, lines: [lineIn(CACTIONS, 'function before'), lineIn(CACTIONS, 'if ( false )') + 1] },
    });
  });

  it('gives each distinct gate of the actions an action test names its own branch', () => {
    const c = controllerOf(extraction, 'cactions');
    expect(c.gates.map((g) => [g.actions, g.pattern, g.classification])).toEqual([
      [null, 'P0', 'public'],
      [['edit', 'save'], 'P3', 's2'],
      [['view'], 'P5', { anyOf: ['system-user', 'member'] }],
    ]);
    expect(c.gates[2]?.gate).toBe(
      "!(listFindNoCase('edit,save', listLast(arguments.rc.muraAction, '.')) and not listFind(session.mura.memberships, 'S2')) && " +
        "listLast(arguments.rc.muraAction, '.') eq 'view' && !session.mura.isLoggedIn",
    );
    expect(c.gates[1]?.source).toEqual(block(CACTIONS, "if ( listFindNoCase('edit,save'", 2));
    expect(c.gates[2]?.source).toEqual(block(CACTIONS, '} else if ( listLast', 2));
    expect(c.actions.map((a) => [a.action, onlyVariant(extraction, a.id).requiredRole.pattern])).toEqual([
      ['edit', 'P3'],
      ['home', 'P0'],
      ['save', 'P3'],
      ['view', 'P5'],
    ]);
  });

  it('folds an action branch whose gate equals the circuit gate into it', () => {
    expect(controllerOf(extraction, 'cs2').gates.map((g) => g.actions)).toEqual([null]);
  });

  it('settles an opaque branch with the action override and keeps the extracted span', () => {
    const c = controllerOf(extraction, 'cfixture');
    const special = {
      gate: "!(ListLast(arguments.rc.muraAction, ':') != 'cFixture.special') && !getBean('fixtureGate').allows(arguments.rc)",
      classification: { anyOf: ['site-admin', 's2'] },
      pattern: null,
      unclassified: false,
      source: { path: CFIXTURE, lines: [11, 13] },
      override: `${OVERRIDE_PREFIX}role:cfixture.special`,
    };
    expect(c.gates).toEqual([{ ...c.requiredRole, actions: null }, { ...special, actions: ['special'] }]);
    expect(onlyVariant(extraction, 'ctl:cfixture.special').requiredRole).toEqual(special);
    expect(onlyVariant(extraction, 'ctl:cfixture.update').requiredRole).toEqual(c.requiredRole);
  });

  it('settles every action of a circuit with its wildcard override', () => {
    const c = controllerOf(extraction, 'cusers');
    expect(c.requiredRole).toEqual({
      gate: "!arguments.rc.isAdmin && !variables.permUtility.getModulePerm('00000000000000000000000000000000008', arguments.rc.siteid)",
      classification: 'm:008',
      pattern: null,
      unclassified: false,
      source: block(CUSERS, 'if ( !arguments.rc.isAdmin', 2),
      override: `${OVERRIDE_PREFIX}role:cusers.*`,
    });
    for (const action of c.actions) for (const v of action.variants) expect(v.requiredRole).toEqual(c.requiredRole);
  });

  it.each<[string, string]>([
    ['cdeny', 'true || true and yes'],
    ['cmixed', "!listFind(session.mura.memberships, 'S2') && !session.mura.isLoggedIn"],
    ['csite', `!${SITE_ADMIN} && !${S2_MEMBER}`],
    ['ctag', 'before() calls no secure()'],
  ])('leaves the %s gate unclassified without an override', (name, gate) => {
    const c = controllerOf(extraction, name);
    expect([c.requiredRole.gate, c.requiredRole.classification, c.requiredRole.pattern, c.requiredRole.unclassified]).toEqual([
      gate,
      null,
      null,
      true,
    ]);
  });

  it('leaves the opaque cfixture.special branch unclassified and reports it when no override settles it', async () => {
    const result = await extractControllers(ctx, { variants, roleOverrides: { ...roleOverrides, overrides: [] } });
    const special = onlyVariant(result, 'ctl:cfixture.special').requiredRole;
    expect([special.classification, special.pattern, special.unclassified, special.override, special.source]).toEqual([
      null,
      null,
      true,
      null,
      { path: CFIXTURE, lines: [11, 13] },
    ]);
    expect(onlyVariant(result, 'ctl:cfixture.update').requiredRole).toEqual(controllerOf(extraction, 'cfixture').requiredRole);
    expect(controllerOf(result, 'cusers').requiredRole).toMatchObject({ classification: null, unclassified: true, override: null });
    expect(result.unclassifiedGates).toEqual(
      expect.arrayContaining([
        { circuit: 'cfixture', actions: ['special'], source: { path: CFIXTURE, lines: [11, 13] } },
        { circuit: 'cusers', actions: ['list', 'update'], source: block(CUSERS, 'if ( !arguments.rc.isAdmin', 2) },
      ]),
    );
  });

  it('leaves a gate on a request flag that before() never assigns unclassified', async () => {
    const files = {
      [`${CTL}/controller.cfc`]: BASE_CONTROLLER,
      [`${CTL}/cflag.cfc`]: gated(['if ( !arguments.rc.allowed ) secure(arguments.rc);'], 'main'),
    };
    const result = await extractControllers(memoryContext(files), { variants, roleOverrides });
    expect(controllerOf(result, 'cflag').requiredRole).toMatchObject({
      gate: '!arguments.rc.allowed',
      classification: null,
      pattern: null,
      unclassified: true,
    });
  });

  it('reports each unsettled gate once per source span with the actions it covers', () => {
    expect(extraction.unclassifiedGates).toEqual([
      { circuit: 'cdeny', actions: ['main'], source: span(`${CTL}/cdeny.cfc`, 'secure(arguments.rc);', 'if ( true and yes )') },
      { circuit: 'cmixed', actions: ['main'], source: span(`${CTL}/cmixed.cfc`, 'if (', 'if (') },
      { circuit: 'cops', actions: ['main'], source: span(`${CTL}/cops.cfc`, "is not 'cOps.open'", "arguments.rc.mode == 'x'") },
      { circuit: 'cops', actions: ['open'], source: span(`${CTL}/cops.cfc`, 'does contain', "arguments.rc.mode == 'x'") },
      { circuit: 'csite', actions: ['edit', 'main'], source: block(CSITE, 'if (', 2) },
      { circuit: 'ctag', actions: ['main'], source: span(`${CTL}/ctag.cfc`, '<cffunction name="before"', '</cffunction>') },
      { circuit: 'cunknown', actions: ['purge'], source: block(`${CTL}/cunknown.cfc`, "== 'purge'", 2) },
    ]);
    expect(controllerOf(extraction, 'cunknown').requiredRole.pattern).toBe('P0');
  });

  it('passes the application gate and the denial default through from the overrides', () => {
    expect(extraction.applicationGate).toEqual(roleOverrides.applicationGate);
    expect(extraction.denialDefault).toEqual(roleOverrides.denialDefault);
  });

  it('copies the site source, conditions, node permission and denial of an override', async () => {
    const source: SourceRef = { path: CSITE, lines: [3, 8] };
    const override: RoleOverride = {
      id: 'role:csite.*',
      circuit: 'csite',
      action: '*',
      requiredRole: 'site-admin',
      siteFrom: ['rc.siteid', 'default'],
      when: [{ on: 'request', predicate: 'rc.siteid is empty', requiredRole: 's2', denial: 'secure()', source }],
      nodePermission: { verdicts: ['editor', 'author'], precedence: source, source },
      denial: 'redirect cLogin.main',
      gate: source,
      reason: 'The site default is assigned before the membership test.',
    };
    const result = await extractControllers(memoryContext(inlineFiles(`${CTL}/controller.cfc`, CSITE)), {
      variants,
      roleOverrides: { ...roleOverrides, overrides: [...roleOverrides.overrides, override] },
    });
    expect(controllerOf(result, 'csite').requiredRole).toEqual({
      gate: `!${SITE_ADMIN} && !${S2_MEMBER}`,
      classification: 'site-admin',
      pattern: null,
      unclassified: false,
      source: block(CSITE, 'if (', 2),
      override: `${OVERRIDE_PREFIX}role:csite.*`,
      siteFrom: ['rc.siteid', 'default'],
      when: override.when,
      nodePermission: override.nodePermission,
      denial: 'redirect cLogin.main',
    });
    expect(result.unclassifiedGates).toEqual([]);
  });

  it('leaves a gate unclassified without a P0 pattern and collapses a role whose terms coincide', async () => {
    const result = await extractControllers(memoryContext(inlineFiles(`${CTL}/controller.cfc`, `${CTL}/cs2.cfc`)), {
      variants,
      roleOverrides: {
        ...roleOverrides,
        extractorPatterns: [{ id: 'P3', shape: '!S2 membership', requiredRole: { anyOf: ['s2', 's2'] } }],
      },
    });
    expect(controllerOf(result, 'cs2').requiredRole.classification).toBe('s2');
    expect(controllerOf(result, 'controller').requiredRole).toMatchObject({ gate: 'no before()', unclassified: true, pattern: null });
    expect(result.unclassifiedGates).toEqual([
      { circuit: 'controller', actions: null, source: { path: `${CTL}/controller.cfc`, lines: [1, 1] } },
    ]);
  });

  it('throws when a pattern role names m:X but the pattern matched no module', async () => {
    await expect(
      extractControllers(memoryContext(inlineFiles(`${CTL}/controller.cfc`, `${CTL}/cadmin.cfc`)), {
        variants,
        roleOverrides: { ...roleOverrides, extractorPatterns: [{ id: 'P1', shape: 'Admin or S2', requiredRole: 'm:X' }] },
      }),
    ).rejects.toThrow('extractor pattern role names m:X without a matched module');
  });
});

describe('variants and write sets', () => {
  it('keys each committed cusers.update variant in match order, the base key last', () => {
    const action = actionOf(extraction, 'ctl:cusers.update');
    expect(action.variants.map((v) => [v.routeKey, v.id, v.precedence, v.order])).toEqual([
      ['admin:cusers.update{photo}', 'ctl:cusers.update{photo}', 9, 1],
      ['admin:cusers.update{type=2,action=add,extdata}', 'ctl:cusers.update{type=2,action=add,extdata}', 8, 2],
      ['admin:cusers.update{type=2,action=update,extdata}', 'ctl:cusers.update{type=2,action=update,extdata}', 7, 3],
      ['admin:cusers.update{type=1,action=delete}', 'ctl:cusers.update{type=1,action=delete}', 6, 4],
      ['admin:cusers.update{type=1,extdata}', 'ctl:cusers.update{type=1,extdata}', 5, 5],
      ['admin:cusers.update{type=2,action=add}', 'ctl:cusers.update{type=2,action=add}', 4, 6],
      ['admin:cusers.update{type=2,action=delete}', 'ctl:cusers.update{type=2,action=delete}', 3, 7],
      ['admin:cusers.update{type=2,action=update}', 'ctl:cusers.update{type=2,action=update}', 2, 8],
      ['admin:cusers.update{type=1}', 'ctl:cusers.update{type=1}', 1, 9],
      ['admin:cusers.update', 'ctl:cusers.update', 0, 10],
    ]);
    expect(action.variants[0]?.predicate).toEqual({
      variant: 'photo',
      when: [{ anyOf: [{ param: 'newFile', nonEmpty: true }, { param: 'removePhotoFile', truthy: true }] }],
    });
    expect(action.variants.at(-1)?.predicate).toBeNull();
    expect(new Set(action.variants.map((v) => JSON.stringify(v.source)))).toEqual(new Set([JSON.stringify(action.source)]));
  });

  it.each<[string, string[]]>([
    ['{photo}', ['tfixture', 'tfixturemembers']],
    ['{type=2,action=add,extdata}', ['tfixture']],
    ['{type=1,action=delete}', ['tfixturemembers']],
    ['{type=1,extdata}', ['tfixture']],
    ['{type=2,action=add}', ['tfixture']],
    ['{type=2,action=delete}', ['tfixture', 'tfixturemembers']],
    ['{type=2,action=update}', ['tfixture']],
    ['{type=1}', ['tfixture']],
    ['', ['tfixture', 'tfixturemembers']],
  ])('computes the cusers.update%s write set from its own branch minus the earlier variants', (suffix, writeSet) => {
    const variant = variantOf(extraction, 'ctl:cusers.update', `admin:cusers.update${suffix}`);
    expect(variant.writeSet).toEqual(writeSet);
    expect(variant.closureEvidence.every((w) => w.trigger === 'request' && w.table !== null && writeSet.includes(w.table))).toBe(true);
  });

  it.each<[string, Array<[string, string, string, string]>]>([
    ['{type=2,action=add}', [['tfixture', 'insert', FIXTURE_DAO, 'create']]],
    ['{type=2,action=update}', [['tfixture', 'update', FIXTURE_DAO, 'update']]],
    [
      '{type=2,action=delete}',
      [
        ['tfixture', 'delete', USER_MANAGER, 'delete'],
        ['tfixturemembers', 'delete', FIXTURE_DAO, 'deleteMembership'],
      ],
    ],
  ])('traces the cusers.update%s writes to the manager and DAO statements its branch reaches', (suffix, writes) => {
    const variant = variantOf(extraction, 'ctl:cusers.update', `admin:cusers.update${suffix}`);
    expect(variant.closureEvidence.map((w) => [w.table, w.op, w.component, w.method])).toEqual(writes);
  });

  it.each<[Record<string, string>, string]>([
    [{ type: '1' }, 'admin:cusers.update{type=1}'],
    [{ type: '2', action: 'Add' }, 'admin:cusers.update{type=2,action=add}'],
    [{ type: '2', action: 'Update' }, 'admin:cusers.update{type=2,action=update}'],
    [{ type: '2', action: 'Delete' }, 'admin:cusers.update{type=2,action=delete}'],
    [{ type: '2', action: 'Update', newFile: 'photo.png' }, 'admin:cusers.update{photo}'],
  ])('keys a cusers.update request with %j as the platform does: %s', async (params, key) => {
    const keyed = await inventoryRouteKey({ kind: 'admin', action: 'cUsers.update', params }, { variants });
    expect(keyed.key).toBe(key);
    expect(variantOf(extraction, 'ctl:cusers.update', key).id).toBe(`ctl:${key.slice('admin:'.length)}`);
  });

  it('computes every cusers.update write set as the closure engine does for its predicates minus the earlier ones', () => {
    const action = actionOf(extraction, 'ctl:cusers.update');
    expect(action.variants).toHaveLength(CUSERS_UPDATE_PREDICATES.length + 1);
    action.variants.forEach((v, i) => {
      const positive = CUSERS_UPDATE_PREDICATES[i] ?? [{}];
      const excludePredicates = CUSERS_UPDATE_PREDICATES.slice(0, i).flat();
      const tables = positive.flatMap(
        (predicates) => computeClosure({ component: CUSERS, method: 'update', predicates, excludePredicates }, ctx).tables,
      );
      expect(v.writeSet).toEqual([...new Set(tables)].sort());
    });
  });

  it.each<[string, Predicates[], Predicates[]]>([
    ['admin:cfixture.update{action=add}', [{ action: 'Add' }], []],
    ['admin:cfixture.update{action=change}', [{ action: 'Update' }, { action: 'Delete' }], [{ action: 'Add' }]],
    ['admin:cfixture.update', [{}], [{ action: 'Add' }, { action: 'Update' }, { action: 'Delete' }]],
  ])('computes the custom %s write set as the closure engine does', (key, positive, excludePredicates) => {
    const tables = positive.flatMap(
      (predicates) => computeClosure({ component: CFIXTURE, method: 'update', predicates, excludePredicates }, customCtx).tables,
    );
    expect(variantOf(custom, 'ctl:cfixture.update', key).writeSet).toEqual([...new Set(tables)].sort());
  });

  it('records the guards a variant cannot decide as conditional writes', () => {
    const variant = variantOf(extraction, 'ctl:cusers.update', 'admin:cusers.update{type=1,action=delete}');
    expect(variant.conditionalWrites.map((w) => [w.table, w.condition])).toEqual([
      ['tfixturemembers', 'arguments.rc.$.validateCSRFTokens(context=arguments.rc.userid)'],
    ]);
    expect(variant.closureEvidence.map((w) => [w.table, w.op, w.component, w.method])).toEqual([
      ['tfixturemembers', 'delete', FIXTURE_DAO, 'deleteMembership'],
    ]);
  });

  it('keys an action without declared variants by its base key alone', () => {
    const update = onlyVariant(extraction, 'ctl:cfixture.update');
    expect([update.routeKey, update.id, update.predicate, update.precedence, update.order]).toEqual([
      'admin:cfixture.update',
      'ctl:cfixture.update',
      null,
      0,
      1,
    ]);
    expect(update.writeSet).toEqual(['tfixture', 'tfixturemembers']);
    expect([update.fileStoreWrite, update.sessionEffects, update.fileStoreEvidence, update.unresolvedCalls]).toEqual([
      false,
      'none',
      [],
      [],
    ]);
  });

  it('records the unresolved includes and calls of an action', () => {
    expect(onlyVariant(extraction, 'ctl:cfixture.list').unresolvedCalls.map((u) => [u.expr, u.kind])).toEqual([
      ['#rc.extraView#', 'include'],
      ['missing.cfm', 'include'],
    ]);
  });

  it('writes one request-triggered evidence entry per variant, sorted by route key', () => {
    const keys = extraction.controllers.flatMap((c) => c.actions.flatMap((a) => a.variants.map((v) => v.routeKey)));
    expect(extraction.writeEvidence.map((e) => e.entryRouteKey)).toEqual([...keys].sort());
    expect(new Set(extraction.writeEvidence.map((e) => e.trigger))).toEqual(new Set(['request']));
    const evidence = extraction.writeEvidence.find((e) => e.entryRouteKey === 'admin:cusers.update{type=1,action=delete}');
    expect(evidence?.closure.tables).toEqual(['tfixturemembers']);
  });

  it.each<[string, string, string[]]>([
    ['ctl:cfixture.update', 'admin:cfixture.update{action=add}', ['tfixture']],
    ['ctl:cfixture.update', 'admin:cfixture.update{action=change}', ['tfixture', 'tfixturemembers']],
    ['ctl:cfixture.update', 'admin:cfixture.update', []],
    ['ctl:cfixture.remove', 'admin:cfixture.remove{upload=image}', ['tfixture', 'tfixturemembers']],
    ['ctl:cfixture.remove', 'admin:cfixture.remove{flagged}', ['tfixture', 'tfixturemembers']],
    ['ctl:cfixture.remove', 'admin:cfixture.remove', ['tfixture', 'tfixturemembers']],
    ['ctl:cmerge.save', 'admin:cmerge.save{narrow}', ['tfixture', 'tfixturestats']],
    ['ctl:cmerge.save', 'admin:cmerge.save{mode}', ['tfixture', 'tfixturemembers', 'tfixturestats']],
    ['ctl:cmerge.save', 'admin:cmerge.save', ['tfixture', 'tfixturestats']],
  ])('keys %s as %s with write set %j under the equals, in, nonEmpty, multipart, truthy and not forms', (id, routeKey, writeSet) => {
    expect(variantOf(custom, id, routeKey).writeSet).toEqual(writeSet);
  });

  it('ranks the custom variants by declaration and keeps their predicates', () => {
    const remove = actionOf(custom, 'ctl:cfixture.remove');
    expect(remove.variants.map((v) => [v.routeKey, v.precedence, v.order, v.predicate?.variant ?? null])).toEqual([
      ['admin:cfixture.remove{upload=image}', 2, 1, 'upload=image'],
      ['admin:cfixture.remove{flagged}', 1, 2, 'flagged'],
      ['admin:cfixture.remove', 0, 3, null],
    ]);
  });

  it('merges the closures of every predicate alternative of a variant into one sorted closure', () => {
    const save = variantOf(custom, 'ctl:cmerge.save', 'admin:cmerge.save{mode}');
    expect(save.writeSet).toEqual(['tfixture', 'tfixturemembers', 'tfixturestats']);
    expect(save.sessionEffects).toBe('relogin');
    expect(save.fileStoreWrite).toBe(true);
    expect(save.fileStoreEvidence.map((e) => [e.component, e.method, e.conditional])).toEqual([
      ['fileManager', 'deleteAll', false],
      ['fileManager', 'deleteVersion', false],
    ]);
    expect(save.unresolvedCalls.map((u) => [u.expr, u.kind])).toEqual(
      expect.arrayContaining([
        ["getBean('noSuchBean').save", 'bean'],
        ["getBean('otherBean').delete", 'bean'],
      ]),
    );
    expect(save.conditionalWrites).toEqual([]);
    const requestWrites = save.closureEvidence.filter((w) => w.table !== 'tfixturestats');
    expect(requestWrites.map((w) => [w.table, w.op, w.component, w.conditional])).toEqual([
      ['tfixture', 'insert', CMERGE, false],
      ['tfixture', 'insert', FIXTURE_DAO, false],
      ['tfixturemembers', 'delete', FIXTURE_DAO, false],
    ]);
    const evidence = custom.writeEvidence.find((e) => e.entryRouteKey === 'admin:cmerge.save{mode}');
    expect(evidence?.closure.overrides).toEqual(['wov:fixture-thread']);
    expect(evidence?.closure.threads.length).toBe(2);
  });

  it('records the guard of a branch no variant decides as a conditional write of the base key', () => {
    const base = onlyVariant(extraction, 'ctl:cmerge.save');
    expect(base.writeSet).toEqual(['tfixture', 'tfixturemembers', 'tfixturestats']);
    expect(base.conditionalWrites.map((w) => [w.table, w.condition])).toEqual([['tfixturemembers', "arguments.rc.mode == 'b'"]]);
  });

  describe('a request-parameter branch of an included view', () => {
    /** A clogin-shaped circuit: the forgot-password call sits in a cfsavecontent of main.cfm, which login.cfm includes. */
    const LOGIN_FILES: Readonly<Record<string, string>> = {
      [`${CTL}/controller.cfc`]: BASE_CONTROLLER,
      [`${CTL}/clogin.cfc`]: circuit(
        '\tpublic any function before(rc) {',
        '\t\tparam default="" name="arguments.rc.status";',
        '\t}',
        '',
        '\tpublic any function main(rc) {',
        '\t}',
        '',
        '\tpublic any function login(rc) {',
        '\t}',
      ),
      [`${VIEWS}/clogin/main.cfm`]: lines(
        '<cfoutput>',
        '<cfsavecontent variable="pwresponse">',
        "\t<cfif rc.status eq 'sendLogin'>",
        "\t\t<cfset application.userManager.sendLoginByEmail('#rc.email#','')>",
        '\t<cfelse>',
        "\t\t#rc.$.rbKey('login.enteremail')#",
        '\t</cfif>',
        '</cfsavecontent>',
        '<p id="pw-response">#pwresponse#</p>',
        '</cfoutput>',
      ),
      [`${VIEWS}/clogin/login.cfm`]: lines('<cfinclude template="main.cfm">'),
      [USER_MANAGER]: lines(
        'component extends="mura.cfobject" output="false" {',
        '',
        '\tpublic any function sendLoginByEmail(required string email, string siteid="") {',
        '\t\tqueryExecute("INSERT INTO tfixtureredirects (email) VALUES (:email)", {email=arguments.email});',
        '\t}',
        '',
        '}',
      ),
    };
    let login: ControllerExtraction;

    beforeAll(async () => {
      login = await extractControllers(memoryContext(LOGIN_FILES), { variants, roleOverrides });
    });

    it.each<[string, Record<string, string>, string, string[]]>([
      ['cLogin.main', { status: 'sendlogin' }, 'admin:clogin.main{status=sendlogin}', ['tfixtureredirects']],
      ['cLogin.main', { status: 'failed' }, 'admin:clogin.main', []],
      ['cLogin.login', { status: 'sendlogin' }, 'admin:clogin.login{status=sendlogin}', ['tfixtureredirects']],
      ['cLogin.login', {}, 'admin:clogin.login', []],
    ])('keys %s with %j as %s under the committed variants, whose view closure writes %j', async (action, params, key, writeSet) => {
      expect((await inventoryRouteKey({ kind: 'admin', action, params }, { variants })).key).toBe(key);
      const variant = variantOf(login, `ctl:${action.toLowerCase()}`, key);
      expect([variant.writeSet, variant.conditionalWrites]).toEqual([writeSet, []]);
    });
  });

  it.each<[string, VariantDeclaration[], string]>([
    [
      'a base request already matches a variant',
      [{ route: 'admin:cfixture.list', variant: 'any', when: [{ not: { param: 'type', equals: '1' } }] }],
      'cfixture.list: a request without parameters already matches variant any',
    ],
    [
      'an earlier variant shadows a later one',
      [
        { route: 'admin:cfixture.remove', variant: 'wide', when: [{ param: 'type', nonEmpty: true }] },
        { route: 'admin:cfixture.remove', variant: 'narrow', when: [{ param: 'type', equals: '1' }] },
      ],
      'admin:cfixture.remove: variant narrow is shadowed by wide for a request satisfying it',
    ],
    [
      'the base key shadows a variant no request satisfies',
      [{ route: 'admin:cfixture.remove', variant: 'never', when: [{ anyOf: [] }] }],
      'admin:cfixture.remove: variant never is shadowed by the base key for a request satisfying it',
    ],
  ])('throws when %s', async (_label, declared, message) => {
    await expect(extractControllers(ctx, { variants: declared, roleOverrides })).rejects.toThrow(message);
  });
});

describe('CSRF context', () => {
  it.each<[string, string | null, string]>([
    ['ctl:cfixture.update', 'update', 'validates'],
    ['ctl:cfixture.remove', 'rc.userid', 'validates'],
    ['ctl:cfixture.list', null, 'none'],
    ['ctl:cfixture.special', 'approvalaction', 'bypassed'],
    ['ctl:cmodes.approve', 'rc.contentid | ""', 'validates'],
    ['ctl:cmodes.confirm', 'it\'s | listFirst(rc.ids, ",") | "#rc.contentid#"', 'validates'],
  ])('records %s with context %j and %s', (id, context, validation) => {
    for (const v of actionOf(extraction, id).variants) expect([v.csrfContext, v.csrfValidation]).toEqual([context, validation]);
  });

  it('records an empty context for a token check that names none', async () => {
    const result = await extractControllers(memoryContext(EDGE_FILES), { variants, roleOverrides });
    expect([onlyVariant(result, 'ctl:cedge.token').csrfContext, onlyVariant(result, 'ctl:cedge.token').csrfValidation]).toEqual([
      '',
      'validates',
    ]);
  });

  it('records the same token check on every variant of an action', () => {
    expect(new Set(actionOf(extraction, 'ctl:cusers.update').variants.map((v) => `${v.csrfContext}|${v.csrfValidation}`))).toEqual(
      new Set(['rc.userid|validates']),
    );
  });
});

describe('response modes', () => {
  it.each<[string, string, string | null, string | null, string | null]>([
    ['ctl:cfixture.list', 'page', REQUEST_LAYOUT, 'text/html', null],
    ['ctl:cfixture.special', 'page', REQUEST_LAYOUT, 'text/html', null],
    ['ctl:cfixture.diff', 'fragment', null, 'text/html', null],
    ['ctl:cfixture.loadjson', 'json', null, 'application/json', null],
    ['ctl:cfixture.download', 'download', null, 'text/csv', null],
    ['ctl:cfixture.update', 'redirect', null, null, null],
    ['ctl:cmodes.exportcsv', 'download', null, 'text/csv', null],
    ['ctl:cmodes.stream', 'download', null, 'application/pdf', null],
    ['ctl:cmodes.loaddata', 'json', null, 'application/json', null],
    ['ctl:cmodes.ping', 'json', null, 'text/html', null],
    ['ctl:cmodes.object', 'json', null, 'text/plain', null],
    ['ctl:cmodes.field', 'fragment', null, 'text/html', null],
    ['ctl:cmodes.save', 'redirect', null, null, 'cModes.list'],
    ['ctl:cmodes.go', 'redirect', null, null, './?muraAction=cModes.list'],
    ['ctl:cmodes.finish', 'redirect', null, null, './?muraAction=cModes.list'],
    ['ctl:cmodes.list', 'page', REQUEST_LAYOUT, 'text/html', null],
    ['ctl:cusers.update', 'redirect', null, null, 'cUsers.list'],
  ])('records %s as %s', (id, mode, layout, contentType, redirect) => {
    const action = actionOf(extraction, id);
    expect(action.variants).not.toHaveLength(0);
    for (const v of action.variants) {
      expect([v.responseMode, v.layout, v.contentType, v.redirectTarget]).toEqual([mode, layout, contentType, redirect]);
    }
  });

  it.each<[string, string, string | null, string | null]>([
    ['ctl:cedge.raw', 'json', 'text/html', null],
    ['ctl:cedge.plain', 'fragment', 'text/html', null],
    ['ctl:cedge.back', 'redirect', null, null],
    ['ctl:cedge.finish', 'redirect', null, 'cEdge.list'],
  ])('records %s as %s when its type, media type or redirect target is left out', async (id, mode, contentType, redirect) => {
    const result = await extractControllers(memoryContext(EDGE_FILES), { variants, roleOverrides });
    const v = onlyVariant(result, id);
    expect([v.responseMode, v.contentType, v.redirectTarget]).toEqual([mode, contentType, redirect]);
  });

  it('closes a method that aborts over its own body and never reads the view of the same name', () => {
    const ping = onlyVariant(extraction, 'ctl:cmodes.ping');
    expect(actionOf(extraction, 'ctl:cmodes.ping').viewPath).toBe(`${VIEWS}/cmodes/ping.cfm`);
    expect(ping.closureEvidence).toEqual([]);
    expect(ping.unresolvedCalls).toEqual([]);
  });
});

describe('searchCoreMuraAction', () => {
  const LOGIN = 'core/mura/login/loginManager.cfc';
  const READER = 'core/mura/fixture/actionReader.cfm';
  const APPLICATION = 'admin/Application.cfc';

  it('finds only URL builders and readers outside core/vendor and cites the FW/1 dispatcher', () => {
    expect(searchCoreMuraAction(tree)).toEqual({
      query: 'muraAction',
      scope: 'core/** excluding core/vendor',
      handlers: 0,
      filesMentioning: 2,
      conclusion: 'url-builder-only',
      dispatcher: span(APPLICATION, 'variables.framework.action', 'url.muraAction = url.fuseaction'),
      files: [
        { path: READER, lines: [1, 2], use: 'reads-admin-action' },
        { path: LOGIN, lines: [lineIn(LOGIN, 'cEditProfile'), lineIn(LOGIN, 'cLogin.main')], use: 'builds-admin-url' },
      ],
    });
  });

  it('counts a core file that dispatches on the action it reads as a handler', () => {
    const result = searchCoreMuraAction(
      memorySourceTree({
        [LOGIN]: textOf(LOGIN),
        'core/mura/fixture/dispatcher.cfc': lines(
          'component output="false" {',
          '\tpublic any function run() {',
          '\t\treturn invoke(this, url.muraAction);',
          '\t}',
          '}',
        ),
      }),
    );
    expect([result.handlers, result.filesMentioning, result.conclusion, result.dispatcher]).toEqual([1, 2, 'dispatches', null]);
    expect(result.files.find((f) => f.path === 'core/mura/fixture/dispatcher.cfc')).toEqual({
      path: 'core/mura/fixture/dispatcher.cfc',
      lines: [3],
      use: 'dispatches-admin-action',
    });
  });

  it.each<[string, Record<string, string>]>([
    ['no admin/Application.cfc', {}],
    [
      'the fuseaction fold before the framework settings',
      { [APPLICATION]: lines('component {', '\turl.muraAction = url.fuseaction;', '\tvariables.framework.action = "muraAction";', '}') },
    ],
  ])('cites no dispatcher for %s', (_label, files) => {
    const result = searchCoreMuraAction(memorySourceTree({ 'core/mura/plain.cfc': textOf('core/mura/plain.cfc'), ...files }));
    expect([result.dispatcher, result.files, result.conclusion]).toEqual([null, [], 'url-builder-only']);
  });
});
