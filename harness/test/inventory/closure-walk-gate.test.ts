import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  computeClosure,
  extractCalls,
  memorySourceTree,
  openSourceTree,
  parseCfmTemplate,
  parseCfmlComponent,
} from '../../src/inventory/closure.js';
import type {
  CfmlComponent,
  CfmlFunction,
  ClosureEntry,
  ComponentIndex,
  Predicates,
  SourceTree,
  UnresolvedKind,
  WriteClosure,
} from '../../src/inventory/closure.js';
import { loadWriterOverrides, parseWriterOverrides } from '../../src/inventory/overrides.js';
import type { SourceRef, WriterOverrides } from '../../src/inventory/overrides.js';
import { pinnedSha } from '../../src/lib/pin.js';

const CBRANCH = 'admin/core/controllers/cbranch.cfc';
const CTAG = 'admin/core/controllers/ctagbranch.cfc';
const CFIXTURE = 'admin/core/controllers/cfixture.cfc';
const ROSTER = 'core/mura/roster/rosterManager.cfc';
const ROSTER_DAO = 'core/mura/roster/rosterDAO.cfc';
const AUDIT_DAO = 'core/mura/roster/auditDAO.cfc';
const BASE_DAO = 'core/mura/roster/baseDAO.cfc';
const TAG_DAO = 'core/mura/roster/tagDAO.cfc';
const SUMMARY = 'core/mura/roster/parts/summary.cfm';
const USER_MANAGER = 'core/mura/user/userManager.cfc';
const USER_BEAN = 'core/mura/user/userBean.cfc';
const USER_UTILITY = 'core/mura/user/userUtility.cfc';
const FILE_MANAGER = 'core/mura/content/file/fileManager.cfc';
const FILE_WRITER = 'core/mura/content/file/fileWriter.cfc';
const FIXTURE_MANAGER = 'core/mura/fixture/fixtureManager.cfc';
const FIXTURE_DAO = 'core/mura/fixture/fixtureDAO.cfc';
const FIXTURE_BEAN = 'core/mura/fixture/fixtureBean.cfc';
const ON_START = 'app/onStart.cfm';

/** Committed CFML fixtures and where the temp tree places them. */
const FIXTURES: Readonly<Record<string, string>> = {
  [FIXTURE_MANAGER]: 'manager-writes.cfc',
  [FIXTURE_DAO]: 'dao-writes.cfc',
  [CFIXTURE]: 'controller-gate.cfc',
};

/** Inline CFML of the temp tree: a branching controller, a roster manager and DAO, user, file and ORM components, start-up templates. */
const INLINE: Readonly<Record<string, string>> = {
  'core/mura/cfobject.cfc': `component output="false" {

  public any function init() {
    return this;
  }
}
`,
  [CBRANCH]: `component extends="controller" output="false" {

  public any function update(rc) {
    switch (arguments.rc.action) {
      case 'Add':
        application.rosterManager.create(arguments.rc);
        break;
      case 'Update':
        application.rosterManager.update(arguments.rc);
        break;
      case 'Delete':
        application.rosterManager.delete(arguments.rc.userid);
        break;
      default:
        queryExecute("INSERT INTO tbranchaudit (auditid) VALUES (:auditid)", {auditid=createUUID()});
    }
    if (len(arguments.rc.newFile)) {
      application.rosterManager.storePhoto(arguments.rc);
    }
  }

  public any function save(rc) {
    if (arguments.rc.type eq 1) {
      queryExecute("INSERT INTO tgroups (groupid) VALUES (:groupid)", {groupid=arguments.rc.groupid});
    } else if (arguments.rc.type eq 2) {
      application.rosterManager.create(arguments.rc);
    } else {
      queryExecute("INSERT INTO tpending (pendingid) VALUES (:pendingid)", {pendingid=createUUID()});
    }
  }

  public any function archive(rc) {
    switch (arguments.rc.mode) {
      case 'soft':
      case 'hide':
        queryExecute("UPDATE tusers SET inactive = 1 WHERE userid = :userid", {userid=arguments.rc.userid});
        break;
      case "#variables.customMode#":
        queryExecute("DELETE FROM tusersmemb WHERE userid = :userid", {userid=arguments.rc.userid});
        break;
    }
  }

  public any function rebuild(rc) {
    thread action="run" name="rosterRebuild" {
      application.rosterManager.delete(arguments.rc.userid);
    }
    if (arguments.rc.type eq 1) {
      thread action="run" name="groupRebuild" {
        queryExecute("DELETE FROM tgroups WHERE siteid = :siteid", {siteid=attributes.siteid});
      }
    }
  }

  public any function importRoster(rc) {
    try {
      queryExecute("INSERT INTO timports (importid) VALUES (:importid)", {importid=createUUID()});
    } catch (any e) {
      queryExecute("DELETE FROM timports WHERE importid = :importid", {importid=arguments.rc.importid});
    }
  }

  public any function relogin(rc) {
    application.rosterManager.update(arguments.rc);
  }

  public any function login(rc) {
    application.userUtility.loginByUserID(arguments.rc.userid);
  }

  public any function signout(rc) {
    application.rosterManager.update(arguments.rc);
    application.loginManager.logout();
  }

  public any function unresolvedCalls(rc) {
    getBean('missingService').run(arguments.rc);
    new mura.roster.absentHelper().run();
    application.rosterManager.absentMethod();
    local.record.save();
    application.ghostService.run();
    include "parts/absent.cfm";
    application.rosterManager.getNothing();
    application.rosterManager.setNothing(1);
  }

  public any function proxy(rc) {
    application.rosterProxy.anything(arguments.rc);
  }

  public any function saveFixture(rc) {
    getBean('fixture').loadBy(fixtureid=arguments.rc.fixtureid).save();
    getEntity('fixture').delete();
    getBean('fixture').purge();
  }

  public any function tables(rc) {
    application.rosterDAO.deleteMemberships(arguments.rc.userid);
    application.rosterDAO.purgeDefault();
    application.rosterDAO.purgeDefault(arguments.rc.tbl);
    application.auditDAO.clear();
    application.tagDAO.clear();
  }

  public any function purge(rc) {
    application.rosterManager.purgeTables(arguments.rc.scope);
  }

  public any function summary(rc) {
    application.rosterManager.renderSummary(arguments.rc);
  }

  public any function sync(rc) {
    application.rosterManager.syncAll();
  }
}
`,
  [CTAG]: `<cfcomponent extends="controller" output="false">

<cffunction name="update" output="false">
  <cfargument name="rc">
  <cfswitch expression="#arguments.rc.kind#">
    <cfcase value="person,member">
      <cfquery>
        INSERT INTO tpeople (personid) VALUES (1)
      </cfquery>
    </cfcase>
    <cfcase value="group|team" delimiters="|">
      <cfquery>
        INSERT INTO tgroups (groupid) VALUES (1)
      </cfquery>
    </cfcase>
    <cfdefaultcase>
      <cfquery>
        INSERT INTO tother (otherid) VALUES (1)
      </cfquery>
    </cfdefaultcase>
  </cfswitch>
  <cftry>
    <cfquery>
      UPDATE tcounters SET hits = hits + 1 WHERE kind = <cfqueryparam value="#arguments.rc.kind#">
    </cfquery>
    <cfcatch type="database">
      <cfquery>
        INSERT INTO terrors (errorid) VALUES (1)
      </cfquery>
    </cfcatch>
  </cftry>
</cffunction>

</cfcomponent>
`,
  [ROSTER]: `component extends="mura.cfobject" output="false" {

  public any function init() {
    variables.rosterDAO = getBean('rosterDAO');
    variables.history = new mura.roster.auditDAO().init();
    variables.cache = isNull(arguments.cache) ? {} : arguments.cache;
    variables.instance.helper = getBean('auditDAO');
    return this;
  }

  public any function setFileManager(fileManager) {
    variables.fileManager = arguments.fileManager;
  }

  public any function create(required struct data) {
    variables.rosterDAO.insertPerson(arguments.data);
    return this;
  }

  public any function update(required struct data) {
    variables.rosterDAO.updatePerson(arguments.data);
    getBean('userBean').loadBy(userid=arguments.data.userid).login();
    return this;
  }

  public any function delete(required string userid) {
    queryExecute("DELETE FROM tusers WHERE userid = :userid", {userid=arguments.userid});
    variables.rosterDAO.deleteMemberships(arguments.userid);
  }

  public any function storePhoto(required struct data) {
    variables.fileManager.create(arguments.data.newFile);
  }

  public any function renderSummary(required struct data) {
    include "parts/summary.cfm";
  }

  public any function summaryCount() {
    queryExecute("UPDATE tsummary SET hits = hits + 1 WHERE summaryid = :summaryid", {summaryid=1});
  }

  public any function syncAll() {
    getBean(variables.jobName).run();
    local.job.save();
  }

  public any function purgeTables(required string scope) {
    variables.rosterDAO.purgeAny(arguments.scope);
  }

  public any function getHistory() {
    return variables.history;
  }

  public any function getLabel() {
    return "roster";
  }

  public any function wiring(rc) {
    application.rosterDAO.updatePerson(arguments.rc);
    application.serviceFactory.getBean("rosterDAO").insertPerson(arguments.rc);
    variables.rosterDAO.deleteMemberships(arguments.rc.userid);
    getRosterDAO().updatePerson(arguments.rc);
    getHistory().clear();
    new mura.roster.rosterDAO().updatePerson(arguments.rc);
    createObject("component", "mura.roster.rosterDAO").updatePerson(arguments.rc);
    this.summaryCount();
    super.init();
    summaryCount();
    var dao = getBean('rosterDAO');
    dao.updatePerson(arguments.rc);
    local.audit = getHistory();
    local.audit.clear();
    variables.cache.save();
    getBean('userBean').loadBy(userid=arguments.rc.userid).save();
    getBean('rosterDAO').other().save();
    application.rosterDAO.settings.save();
    items[1].save();
    getBean(arguments.rc.beanName).save();
    getMissing().run();
    application.rosterManager.getHistory().clear();
    createObject("java", "java.lang.System").gc();
    unknownThing.run();
    len(arguments.rc.userid);
    variables.instance.helper.clear();
    getLabel().save();
    if (arguments.rc.type eq 2) {
      getEntity('fixture').save();
    }
  }
}
`,
  [ROSTER_DAO]: `component extends="mura.cfobject" output="false" {

  public any function insertPerson(required struct data) {
    queryExecute("INSERT INTO tusers (userid, siteid) VALUES (:userid, :siteid)", {userid=arguments.data.userid, siteid=arguments.data.siteid});
    clearFrom(table="tusersinterests", userid=arguments.data.userid);
  }

  public any function updatePerson(required struct data) {
    queryExecute("UPDATE tusers SET fname = :fname WHERE userid = :userid AND siteid = :siteid", {fname=arguments.data.fname, userid=arguments.data.userid, siteid=arguments.data.siteid});
  }

  public any function deleteMemberships(required string userid) {
    relay("tusersmemb", arguments.userid);
  }

  public any function relay(required string table, required string userid) {
    clearFrom(arguments.table, arguments.userid);
  }

  public any function clearFrom(required string table, required string userid) {
    queryExecute("DELETE FROM #arguments.table# WHERE userid = :userid", {userid=arguments.userid});
  }

  public any function purgeAny(required string tbl) {
    queryExecute("DELETE FROM #arguments.tbl# WHERE siteid = :siteid", {siteid=1});
  }

  public any function purgeDefault(string tbl = "tuserstags") {
    queryExecute("DELETE FROM #arguments.tbl# WHERE siteid = :siteid", {siteid=1});
  }
}
`,
  [BASE_DAO]: `component extends="mura.cfobject" output="false" {

  public any function clear() {
    queryExecute("DELETE FROM #variables.table# WHERE siteid = :siteid", {siteid=1});
  }
}
`,
  [AUDIT_DAO]: `component extends="mura.roster.baseDAO" output="false" {

  public any function init() {
    variables.table = "tauditlog";
    return this;
  }
}
`,
  [TAG_DAO]: `component extends="mura.roster.baseDAO" table="ttags" output="false" {
}
`,
  'core/mura/roster/rosterProxy.cfc': `component output="false" {

  public any function onMissingMethod(required string missingMethodName, struct missingMethodArguments) {
    queryExecute("INSERT INTO tproxylog (logid) VALUES (:logid)", {logid=createUUID()});
  }
}
`,
  [SUMMARY]: `<cfset summaryCount()>
<cfif rc.mode eq "full">
  <cfquery>
    INSERT INTO tsummarylog (logid) VALUES (1)
  </cfquery>
</cfif>
`,
  [USER_MANAGER]: `component extends="mura.cfobject" output="false" {

  public any function update(required struct data) {
    queryExecute("UPDATE tusers SET fname = :fname WHERE userid = :userid", {fname=arguments.data.fname, userid=arguments.data.userid});
    return this;
  }

  public any function create(required struct data) {
    queryExecute("INSERT INTO tusers (userid) VALUES (:userid)", {userid=createUUID()});
    return this;
  }

  public any function delete(required string userid, string type="2", boolean deleteMemberships=true) {
    queryExecute("DELETE FROM tusers WHERE userid = :userid", {userid=arguments.userid});
  }
}
`,
  [USER_BEAN]: `component extends="mura.cfobject" output="false" {

  public any function loadBy() {
    return this;
  }

  public any function save() {
    return this;
  }

  public any function login() {
    getBean('userUtility').loginByUserID(variables.instance.userid);
  }
}
`,
  [USER_UTILITY]: `component extends="mura.cfobject" output="false" {

  public any function loginByUserID(required string userid) {
    queryExecute("UPDATE tusers SET lastLogin = :now WHERE userid = :userid", {now=now(), userid=arguments.userid});
  }

  public any function logout() {
    structDelete(session, 'mura');
  }
}
`,
  'core/mura/login/loginManager.cfc': `component extends="mura.cfobject" output="false" {

  public any function logout() {
    application.userUtility.logout();
  }
}
`,
  [FILE_MANAGER]: `component extends="mura.cfobject" output="false" {

  public any function create(required any fileObj) {
    queryExecute("INSERT INTO tfiles (fileid) VALUES (:fileid)", {fileid=createUUID()});
    variables.fileWriter.writeFile(arguments.fileObj);
  }
}
`,
  [FILE_WRITER]: `component output="false" {

  public any function writeFile(required any fileObj) {
    return true;
  }
}
`,
  'core/mura/bean/beanORM.cfc': `component extends="mura.cfobject" output="false" {

  public any function loadBy() {
    return this;
  }

  public any function save() {
    return this;
  }

  public any function delete() {
    return this;
  }

  public any function purge() {
    queryExecute("DELETE FROM #getTable()# WHERE siteid = :siteid", {siteid=1});
  }
}
`,
  [FIXTURE_BEAN]: `component extends="mura.bean.beanORM" entityName="fixture" table="tfixtures" output="false" {
}
`,
  'core/mura/fixture/boot.cfm': `<cfquery>
  INSERT INTO tboot (bootid) VALUES (1)
</cfquery>
`,
  [ON_START]: `<!--- Application start-up sample --->
<cfscript>
  queryExecute("UPDATE tsettings SET lastStart = :now", {now=now()});
</cfscript>
<cfinclude template="startup/register.cfm">
<cfinclude template="/mura/fixture/boot.cfm">
<cfinclude template="/muraWRM/app/extra.cfm">
<cfinclude template="../../outside.cfm">
<cfinclude template="#variables.dynamicTemplate#">
<cfinclude template="missing.cfm">
<cfif rc.reload eq "true">
  <cfinclude template="startup/reload.cfm">
</cfif>
<cfthread action="run" name="warmup">
  <cfinclude template="startup/warm.cfm">
</cfthread>
<cfset this.missingHelper()>
`,
  'app/startup/register.cfm': `<cffunction name="registerBeans" output="false">
  <cfquery>
    INSERT INTO tregistry (beanid) VALUES (1)
  </cfquery>
</cffunction>
<cfset registerBeans()>
`,
  'app/startup/reload.cfm': `<cfquery>
  INSERT INTO treloads (reloadid) VALUES (1)
</cfquery>
`,
  'app/startup/warm.cfm': `<cfquery>
  INSERT INTO twarm (warmid) VALUES (1)
</cfquery>
`,
  'app/extra.cfm': `<cfquery>
  DELETE FROM textra WHERE siteid = 'default'
</cfquery>
<cfinclude template="extra-missing.cfm">
`,
};

/** Bean names of the temp tree; `ghostService` names a component the tree lacks. */
const BEANS: Readonly<Record<string, string>> = {
  rosterManager: ROSTER,
  rosterDAO: ROSTER_DAO,
  auditDAO: AUDIT_DAO,
  tagDAO: TAG_DAO,
  rosterProxy: 'core/mura/roster/rosterProxy.cfc',
  userManager: USER_MANAGER,
  userBean: USER_BEAN,
  userUtility: USER_UTILITY,
  loginManager: 'core/mura/login/loginManager.cfc',
  fileManager: FILE_MANAGER,
  fileWriter: FILE_WRITER,
  fixtureManager: FIXTURE_MANAGER,
  fixtureDAO: FIXTURE_DAO,
  fixture: FIXTURE_BEAN,
  ghostService: 'core/mura/ghost/ghostService.cfc',
};

/** In-memory tree for walk termination, merging and session-override scenarios. */
const WALK_FILES: Readonly<Record<string, string>> = {
  'walk/loop.cfc': `component output="false" {

  public any function walk(rc) {
    this.walk(arguments.rc);
    visit();
  }

  public any function visit() {
    walk();
    queryExecute("INSERT INTO tvisits (visitid) VALUES (1)");
  }

  public any function selfRef() {
    variables.dao.save();
  }

  public any function init() {
    variables.dao = variables.dao;
  }
}
`,
  'walk/merge.cfc': `component output="false" {

  public any function supersede(rc) {
    if (arguments.rc.mode eq 'x') {
      record();
    }
    record();
  }

  public any function keepPlain(rc) {
    stamp(arguments.rc);
    if (arguments.rc.mode eq 'x') {
      stamp(local.other);
    }
  }

  public any function upgrade(rc) {
    if (arguments.rc.mode eq 'x') {
      stamp(arguments.rc);
    }
    stamp(local.other);
  }

  public any function firstCondition(rc) {
    if (arguments.rc.mode eq 'x') {
      stamp(arguments.rc);
    }
    if (arguments.rc.kind eq 'y') {
      stamp(local.other);
    }
  }

  public any function photo(rc) {
    if (arguments.rc.mode eq 'x') {
      store(arguments.rc);
    }
    store(local.other);
  }

  public any function collect(rc, event) {
    tally(argumentCollection=arguments.rc);
    forward(argumentCollection=arguments);
    handle(arguments.event);
  }

  public any function tally() {
    if (arguments.kind eq 'y') {
      queryExecute("INSERT INTO ttally (tallyid) VALUES (1)");
    }
  }

  public any function forward(rc) {
    if (arguments.rc.kind eq 'y') {
      queryExecute("INSERT INTO tforward (forwardid) VALUES (1)");
    }
  }

  public any function handle(event) {
    if (arguments.event.getValue('kind') eq 'y') {
      queryExecute("INSERT INTO thandled (handledid) VALUES (1)");
    }
  }

  public any function record() {
    queryExecute("INSERT INTO trecords (recordid) VALUES (1)");
  }

  public any function stamp(data) {
    queryExecute("INSERT INTO tstamps (stampid) VALUES (1)");
  }

  public any function store(data) {
    application.fileManager.deleteVersion(1);
    application.fileManager.deleteVersion(2);
    getBean('fileDAO').purgeDeleted();
  }

  public any function twoWays(rc) {
    if (arguments.rc.mode eq 'x') {
      stamp(arguments.rc);
    }
    thread action="run" name="stampLater" {
      if (arguments.rc.kind eq 'y') {
        stamp(arguments.rc);
      }
      if (arguments.rc.mode eq 'x') {
        stamp(local.other);
      }
    }
  }

  public any function fanOut(rc) {
    thread action="run" name="first" { record(); } thread action="run" name="second" {
      record();
    }
  }
}
`,
  'walk/fileManager.cfc': `component output="false" {

  public any function deleteVersion(required string fileid) {
    variables.fileWriter.renameFile(arguments.fileid);
  }
}
`,
  'walk/cycleA.cfc': `component extends="cycleB" output="false" {

  public any function start() {
    this.run();
    this.absent();
  }
}
`,
  'walk/cycleB.cfc': `component extends="cycleA" output="false" {

  public any function run() {
    queryExecute("INSERT INTO tcycles (cycleid) VALUES (1)");
  }
}
`,
  'walk/memberBean.cfc': `component output="false" {

  public any function login() {
    queryExecute("UPDATE tmembers SET lastLogin = :now WHERE memberid = :memberid", {now=now(), memberid=1});
  }
}
`,
  'walk/cmember.cfc': `component output="false" {

  public any function signin(rc) {
    var userBean = getBean('member');
    userBean.login();
  }
}
`,
  'walk/page.cfm': `<cfset this.render()>
<cfset super.save()>
`,
};

/** Plain-object component index over `tree`: case-insensitive beans, ORM tables by path, memoised parses. */
function componentIndex(tree: SourceTree, beans: Readonly<Record<string, string>>, orm: Readonly<Record<string, string>> = {}): ComponentIndex {
  const byName = new Map(Object.entries(beans).map(([name, p]) => [name.toLowerCase(), p]));
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => byName.get(name.toLowerCase()) ?? null,
    ormTable: (p) => orm[p] ?? null,
    parsed(p) {
      if (!parsed.has(p)) parsed.set(p, p.endsWith('.cfc') && tree.exists(p) ? parseCfmlComponent(p, tree.readText(p)) : null);
      return parsed.get(p) ?? null;
    },
  };
}

/** Source reference from the first line of `rel` containing `marker`, `span` lines long beyond it. */
function at(tree: SourceTree, rel: string, marker: string, span = 0): SourceRef {
  const line = tree.readText(rel).split('\n').findIndex((l) => l.includes(marker)) + 1;
  if (line === 0) throw new Error(`no ${marker} in ${rel}`);
  return { path: rel, lines: [line, line + span] };
}

/** Parsed component at `rel` of the temp tree and its function `name`. */
function member(rel: string, name: string): { unit: CfmlComponent; fn: CfmlFunction } {
  const unit = index.parsed(rel);
  const fn = unit?.functions.find((f) => f.name === name);
  if (unit === null || fn === undefined) throw new Error(`no function ${name} in ${rel}`);
  return { unit, fn };
}

type Verdict = 'pruned' | 'unconditional' | 'conditional';

/** How a write under `if (guard)` (or `<cfif guard>`) lands in the closure of `probe(<formal>)`. */
function verdictOf(
  guard: string,
  predicates: Predicates = {},
  excludePredicates: Predicates[] = [],
  opts: { formal?: string; tag?: boolean } = {},
): Verdict {
  const formal = opts.formal ?? 'rc';
  const source =
    opts.tag === true
      ? `<cfcomponent>\n<cffunction name="probe">\n  <cfargument name="${formal}">\n  <cfif ${guard}>\n    <cfquery>INSERT INTO tprobe (probeid) VALUES (1)</cfquery>\n  </cfif>\n</cffunction>\n</cfcomponent>\n`
      : `component {\n  public any function probe(${formal}) {\n    if (${guard}) {\n      queryExecute("INSERT INTO tprobe (probeid) VALUES (1)");\n    }\n  }\n}\n`;
  const probeTree = memorySourceTree({ 'probe/cprobe.cfc': source });
  const closure = computeClosure(
    { component: 'probe/cprobe.cfc', method: 'probe', predicates, excludePredicates },
    { tree: probeTree, index: componentIndex(probeTree, {}) },
  );
  if (closure.tables.length === 0) return 'pruned';
  return closure.conditionalWrites.length === 0 ? 'unconditional' : 'conditional';
}

let root = '';
let tree: SourceTree;
let index: ComponentIndex;
let walkTree: SourceTree;
let walkIndex: ComponentIndex;

/** Closure of `component`#`method` over the temp tree. */
function closureOf(component: string, method: string, entry: Omit<ClosureEntry, 'component' | 'method'> = {}, overrides?: WriterOverrides): WriteClosure {
  return computeClosure({ component, method, ...entry }, { tree, index, overrides });
}

/** Closure of `component`#`method` over the in-memory walk tree. */
function walkClosureOf(component: string, method: string, entry: Omit<ClosureEntry, 'component' | 'method'> = {}, overrides?: WriterOverrides): WriteClosure {
  return computeClosure({ component, method, ...entry }, { tree: walkTree, index: walkIndex, overrides });
}

/** `table:op` of every write, in closure order. */
function tableOps(c: WriteClosure): string[] {
  return c.writes.map((w) => `${w.table ?? '?'}:${w.op}`);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-closure-walk-'));
  for (const [rel, name] of Object.entries(FIXTURES)) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await copyFile(fileURLToPath(new URL(`../fixtures/cfml/${name}`, import.meta.url)), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  tree = openSourceTree(root);
  index = componentIndex(tree, BEANS, { [FIXTURE_BEAN]: 'tfixtures' });
  walkTree = memorySourceTree(WALK_FILES);
  walkIndex = componentIndex(walkTree, { fileManager: 'walk/fileManager.cfc', member: 'walk/memberBean.cfc' });
});

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('guard evaluation over request predicates', () => {
  it.each<[string, Predicates, Verdict]>([
    ['arguments.rc.type eq 1', { type: '1' }, 'unconditional'],
    ['arguments.rc.type eq 2', { type: '1' }, 'pruned'],
    ['arguments.rc.type eq 1', {}, 'conditional'],
    ['rc.type == 1', { type: '1' }, 'unconditional'],
    ['rc.type is 1', { type: '1' }, 'unconditional'],
    ['rc.type equal 1', { type: '1' }, 'unconditional'],
    ['rc.type neq 1', { type: '1' }, 'pruned'],
    ['rc.type != 1', { type: '1' }, 'pruned'],
    ['rc.type <> 1', { type: '1' }, 'pruned'],
    ['rc.type is not 1', { type: '1' }, 'pruned'],
    ['rc.type not equal 1', { type: '1' }, 'pruned'],
    ['rc.type eq 1.0', { type: '1' }, 'unconditional'],
    ["rc.type eq '01'", { type: '1' }, 'unconditional'],
    ["rc.type is 'Admin'", { type: 'admin' }, 'unconditional'],
    ['rc.Type eq 1', { TYPE: '1' }, 'unconditional'],
  ])('equality %s under %j is %s', (guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates)).toBe(verdict);
  });

  it.each<[string, Predicates, Verdict]>([
    ['rc.n gt 5', { n: '7' }, 'unconditional'],
    ['rc.n > 5', { n: '7' }, 'unconditional'],
    ['rc.n gte 7', { n: '7' }, 'unconditional'],
    ['rc.n ge 8', { n: '7' }, 'pruned'],
    ['rc.n >= 8', { n: '7' }, 'pruned'],
    ['rc.n lt 5', { n: '7' }, 'pruned'],
    ['rc.n < 10', { n: '7' }, 'unconditional'],
    ['rc.n lte 7', { n: '7' }, 'unconditional'],
    ['rc.n le 6', { n: '7' }, 'pruned'],
    ['rc.n <= 6', { n: '7' }, 'pruned'],
    ['rc.n greater than 5', { n: '7' }, 'unconditional'],
    ['rc.n greater than or equal to 7', { n: '7' }, 'unconditional'],
    ['rc.n greater than or equal 8', { n: '7' }, 'pruned'],
    ['rc.n less than 5', { n: '7' }, 'pruned'],
    ['rc.n less than or equal to 7', { n: '7' }, 'unconditional'],
    ['rc.n gt 5', { n: 'abc' }, 'conditional'],
    ['rc.n gt 5', { n: false }, 'conditional'],
  ])('ordering %s under %j is %s', (guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates)).toBe(verdict);
  });

  it.each<[string, Predicates, Verdict]>([
    ["rc.title contains 'draft'", { title: 'My Draft' }, 'unconditional'],
    ["rc.title does not contain 'draft'", { title: 'My Draft' }, 'pruned'],
    ["rc.title contains 'final'", { title: 'My Draft' }, 'pruned'],
    ["rc.title contains 'draft'", { title: true }, 'conditional'],
    ["rc.title contains 'draft'", { title: false }, 'pruned'],
    ['rc.flag', { flag: 'true' }, 'unconditional'],
    ['rc.flag', { flag: 'yes' }, 'unconditional'],
    ['rc.flag', { flag: '2' }, 'unconditional'],
    ['rc.flag', { flag: 'no' }, 'pruned'],
    ['rc.flag', { flag: '0' }, 'pruned'],
    ['rc.flag', { flag: 'abc' }, 'pruned'],
    ['rc.flag', { flag: true }, 'conditional'],
    ['rc.flag', { flag: false }, 'pruned'],
    ['rc.flag', { flag: null }, 'pruned'],
    ['not rc.flag', { flag: 'yes' }, 'pruned'],
    ['!rc.flag', { flag: 'no' }, 'unconditional'],
    ['not rc.flag', { flag: true }, 'conditional'],
    ['rc.flag eq true', { flag: 'yes' }, 'unconditional'],
    ['rc.flag eq true', { flag: '1' }, 'unconditional'],
    ['rc.flag eq true', { flag: 'maybe' }, 'pruned'],
    ['rc.flag eq false', { flag: 'no' }, 'unconditional'],
    ['true', {}, 'unconditional'],
    ['false', {}, 'pruned'],
    ['1', {}, 'unconditional'],
    ['0', {}, 'pruned'],
    ["'yes'", {}, 'unconditional'],
    ["'abc'", {}, 'pruned'],
    ["rc.tag eq 'a##b'", { tag: 'a#b' }, 'unconditional'],
  ])('text and truthiness %s under %j is %s', (guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates)).toBe(verdict);
  });

  it.each<[string, Predicates, Verdict]>([
    ['len(rc.name)', { name: true }, 'unconditional'],
    ['len(rc.name)', { name: false }, 'pruned'],
    ['len(rc.name)', { name: 'bob' }, 'unconditional'],
    ['len(rc.name)', {}, 'conditional'],
    ['len(rc.name) eq 0', { name: true }, 'pruned'],
    ['len(rc.name) neq 0', { name: true }, 'unconditional'],
    ['len(rc.name) eq 3', { name: true }, 'conditional'],
    ['len(rc.name) gt 0', { name: true }, 'conditional'],
    ['len(trim(rc.name))', { name: '  ' }, 'pruned'],
    ["trim(rc.name) eq 'bob'", { name: ' bob ' }, 'unconditional'],
    ["trim(rc.name) eq 'bob'", { name: true }, 'conditional'],
    ["trim(rc.name) eq ''", { name: false }, 'unconditional'],
    ["lcase(rc.action) eq 'add'", { action: 'ADD' }, 'unconditional'],
    ["ucase(rc.action) eq 'ADD'", { action: 'add' }, 'unconditional'],
    ["len('abc') eq 3", {}, 'unconditional'],
    ['len() eq 0', {}, 'conditional'],
    ['len(rc)', {}, 'conditional'],
    ["listFind(rc.list, 'a')", { list: 'a' }, 'conditional'],
    ['len(rc.a) eq rc.b', { a: true, b: true }, 'conditional'],
    ['rc.a eq rc.b', { a: true, b: true }, 'conditional'],
  ])('builtin %s under %j is %s', (guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates)).toBe(verdict);
  });

  it.each<[string, Predicates, Verdict]>([
    ["structKeyExists(arguments.rc, 'photo')", { photo: true }, 'unconditional'],
    ["structKeyExists(arguments.rc, 'photo')", { photo: false }, 'conditional'],
    ["structKeyExists(arguments.rc, 'photo')", {}, 'conditional'],
    ["structKeyExists(rc, 'photo')", { photo: 'x.png' }, 'unconditional'],
    ["structKeyExists(struct=rc, key='photo')", { photo: true }, 'unconditional'],
    ['structKeyExists(rc, photoKey)', { photo: true }, 'conditional'],
    ["structKeyExists(variables, 'photo')", { photo: true }, 'conditional'],
    ["not structKeyExists(rc, 'photo')", { photo: true }, 'pruned'],
    ["isDefined('rc.photo')", { photo: true }, 'unconditional'],
    ["isDefined('arguments.rc.photo')", { photo: true }, 'unconditional'],
    ["isDefined('rc.photo.name')", { photo: true }, 'conditional'],
    ["isDefined('session.photo')", { photo: true }, 'conditional'],
    ['isDefined(photoKey)', { photo: true }, 'conditional'],
  ])('existence %s under %j is %s', (guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates)).toBe(verdict);
  });

  it.each<[string, string, Predicates, Verdict]>([
    ['rc', 'request.context.type eq 2', { type: '2' }, 'unconditional'],
    ['rc', "rc['type'] eq 2", { type: '2' }, 'unconditional'],
    ['rc', 'rc[typeKey] eq 2', { type: '2' }, 'conditional'],
    ['rc', "rc.$.event('type') eq 2", { type: '2' }, 'unconditional'],
    ['rc', "rc.getValue('type') eq 2", { type: '2' }, 'conditional'],
    ['rc', 'rc.items[1] eq 2', { items: '2' }, 'conditional'],
    ['rc', 'rc.type.name eq 2', { type: '2' }, 'conditional'],
    ['rc', 'rc.$.currentUser().isAdmin()', {}, 'conditional'],
    ['rc', 'rc', {}, 'conditional'],
    ['rc', 'variables.flag', { flag: 'yes' }, 'conditional'],
    ['event', "event.getValue('type') eq 2", { type: '2' }, 'unconditional'],
    ['event', "event.valueExists('photo')", { photo: true }, 'unconditional'],
    ['event', "arguments.event.getValue('action') eq 'save'", { action: 'SAVE' }, 'unconditional'],
    ['event', "event.other('type') eq 2", { type: '2' }, 'conditional'],
    ['$', "$.event('type') eq 2", { type: '2' }, 'unconditional'],
    ['$', "$.event('type', 'x') eq 2", { type: '2' }, 'conditional'],
  ])('a %s formal reads %s under %j as %s', (formal, guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates, [], { formal })).toBe(verdict);
  });

  it.each<[string, Predicates, Verdict]>([
    ['rc.type eq 1 and rc.other eq 2', { type: '1' }, 'conditional'],
    ['rc.type eq 2 and rc.other eq 2', { type: '1' }, 'pruned'],
    ['rc.type eq 1 && rc.other eq 2', { type: '1' }, 'conditional'],
    ['rc.type eq 1 or rc.other eq 2', { type: '1' }, 'unconditional'],
    ['rc.type eq 2 || rc.other eq 2', { type: '1' }, 'conditional'],
    ['rc.type eq 2 or rc.type eq 3', { type: '1' }, 'pruned'],
    ['(rc.type eq 1)', { type: '1' }, 'unconditional'],
    ['(rc.type eq 1) eq true', { type: '1' }, 'unconditional'],
    ['not (rc.type eq 2)', { type: '1' }, 'unconditional'],
  ])('connective %s under %j is %s', (guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates)).toBe(verdict);
  });

  it.each<[string, Predicates]>([
    ['rc.type eq 1 xor rc.type eq 2', { type: '1' }],
    ['rc.type eq 1 rc.other', { type: '1' }],
    ['rc.type eq', { type: '1' }],
    ['rc.type ? 1 : 0', { type: '1' }],
    ['rc.type + 1 eq 2', { type: '1' }],
    ['rc.type mod 2 eq 0', { type: '2' }],
    ['-rc.type eq -1', { type: '1' }],
    ['rc.type eq ,', { type: '1' }],
    ["rc.tag eq '#x#'", { tag: 'a' }],
  ])('an expression it cannot decide, %s under %j, stays conditional', (guard, predicates) => {
    expect(verdictOf(guard, predicates)).toBe('conditional');
  });

  it.each<[string, Predicates, Verdict]>([
    ['(rc.type eq 1', { type: '1' }, 'conditional'],
    ['len(rc.type eq 1', { type: '1' }, 'conditional'],
    ["rc['type' eq 1", { type: '1' }, 'conditional'],
    ['#rc.type# eq 1', { type: '1' }, 'unconditional'],
    ['rc.type is "Admin"', { type: 'ADMIN' }, 'unconditional'],
    ['rc.type is "Admin"', { type: 'guest' }, 'pruned'],
  ])('tag guard <cfif %s> under %j is %s', (guard, predicates, verdict) => {
    expect(verdictOf(guard, predicates, [], { tag: true })).toBe(verdict);
  });

  it.each<[string, Predicates, Predicates[], Verdict]>([
    ["rc.a eq 'add'", { a: true }, [{ a: 'add' }], 'pruned'],
    ["structKeyExists(rc, 'photo')", {}, [{ photo: 'z' }], 'conditional'],
    ["rc.action eq 'Add'", { action: 'Add' }, [{ photo: true }], 'unconditional'],
    ["rc.action eq 'Add'", { action: 'Add' }, [{ action: 'add' }], 'conditional'],
    ['len(rc.newFile)', { type: '2' }, [{ type: '2', newFile: true }], 'pruned'],
    ['len(rc.newFile)', { type: '2' }, [{ type: '1', newFile: true }], 'conditional'],
    ['len(rc.newFile)', { type: '2' }, [{ type: true, newFile: true }], 'pruned'],
    ['len(rc.newFile)', { type: true }, [{ type: '2', newFile: true }], 'conditional'],
    ['len(rc.newFile)', { type: true }, [{ type: true, newFile: true }], 'pruned'],
    ['len(rc.newFile)', { type: false }, [{ type: true, newFile: true }], 'conditional'],
  ])('%s under %j excluding %j is %s', (guard, predicates, exclusions, verdict) => {
    expect(verdictOf(guard, predicates, exclusions)).toBe(verdict);
  });

  it('records an undecided guard as the condition text of its write', () => {
    const tree0 = memorySourceTree({
      'probe/cprobe.cfc': 'component {\n  public any function probe(rc) {\n    if (len(rc.name)   and   rc.mode eq "x") {\n      queryExecute("INSERT INTO tprobe (probeid) VALUES (1)");\n    }\n  }\n}\n',
    });
    const closure = computeClosure({ component: 'probe/cprobe.cfc', method: 'probe' }, { tree: tree0, index: componentIndex(tree0, {}) });
    expect(closure.conditionalWrites).toEqual([
      { table: 'tprobe', condition: 'len(rc.name) and rc.mode eq "x"', source: { path: 'probe/cprobe.cfc', lines: [4, 4] } },
    ]);
    expect(closure.writes).toEqual([
      {
        table: 'tprobe',
        op: 'insert',
        component: 'probe/cprobe.cfc',
        method: 'probe',
        source: { path: 'probe/cprobe.cfc', lines: [4, 4] },
        trigger: 'request',
        whereParams: [],
        conditional: true,
      },
    ]);
  });
});

describe('branch pruning on the roster controller', () => {
  it.each<[Predicates, Predicates[], string[]]>([
    [{ action: 'Add' }, [{ action: 'Add', newFile: true }], ['tusers', 'tusersinterests']],
    [{ action: 'add' }, [{ action: 'add', newFile: true }], ['tusers', 'tusersinterests']],
    [{ action: 'UPDATE' }, [{ action: 'UPDATE', newFile: true }], ['tusers']],
    [{ action: 'Delete' }, [{ action: 'Delete', newFile: true }], ['tusers', 'tusersmemb']],
    [{}, [{ action: 'Add' }, { action: 'Update' }, { action: 'Delete' }, { newFile: true }], ['tbranchaudit']],
  ])('switch on rc.action under %j excluding %j writes %j', (predicates, excludePredicates, tables) => {
    const closure = closureOf(CBRANCH, 'update', { predicates, excludePredicates });
    expect(closure.tables).toEqual(tables);
    expect(closure.conditionalWrites).toEqual([]);
    expect(closure.fileStore).toBe(false);
  });

  it('visits only the methods the kept case reaches', () => {
    expect(closureOf(CBRANCH, 'update', { predicates: { action: 'Delete' }, excludePredicates: [{ newFile: true }] }).visited).toEqual([
      `${CBRANCH}#update`,
      `${ROSTER_DAO}#clearFrom`,
      `${ROSTER_DAO}#deleteMemberships`,
      `${ROSTER_DAO}#relay`,
      `${ROSTER}#delete`,
    ]);
  });

  it('keeps every case reachable and conditional when no predicate decides the switch', () => {
    const closure = closureOf(CBRANCH, 'update', { excludePredicates: [{ newFile: true }] });
    expect(closure.tables).toEqual(['tbranchaudit', 'tusers', 'tusersinterests', 'tusersmemb']);
    expect(closure.conditionalWrites.map((c) => [c.table, c.condition])).toEqual([
      ['tbranchaudit', "!(switch(arguments.rc.action) case 'Add' || switch(arguments.rc.action) case 'Update' || switch(arguments.rc.action) case 'Delete')"],
      ['tusers', "switch(arguments.rc.action) case 'Add'"],
      ['tusers', "switch(arguments.rc.action) case 'Update'"],
      ['tusers', "switch(arguments.rc.action) case 'Delete'"],
      ['tusers', "switch(arguments.rc.action) case 'Update'"],
      ['tusersinterests', "switch(arguments.rc.action) case 'Add'"],
      ['tusersmemb', "switch(arguments.rc.action) case 'Delete'"],
    ]);
  });

  it.each<[Predicates, string[], string[]]>([
    [{ type: '1' }, ['tgroups'], []],
    [{ type: '2' }, ['tusers', 'tusersinterests'], []],
    [{ type: '3' }, ['tpending'], []],
    [
      {},
      ['tgroups', 'tpending', 'tusers', 'tusersinterests'],
      [
        'tgroups|arguments.rc.type eq 1',
        'tpending|!(arguments.rc.type eq 1) && !(arguments.rc.type eq 2)',
        'tusers|!(arguments.rc.type eq 1) && arguments.rc.type eq 2',
        'tusersinterests|!(arguments.rc.type eq 1) && arguments.rc.type eq 2',
      ],
    ],
  ])('if/else-if/else on rc.type under %j writes %j', (predicates, tables, conditional) => {
    const closure = closureOf(CBRANCH, 'save', { predicates });
    expect(closure.tables).toEqual(tables);
    expect(closure.conditionalWrites.map((c) => `${c.table}|${c.condition}`)).toEqual(conditional);
    expect(closure.sessionEffects).toBe('none');
  });

  it.each<[Predicates, string[], string[]]>([
    [{ mode: 'hide' }, ['tusers:update', 'tusersmemb:delete'], ['tusersmemb|switch(arguments.rc.mode) case ?']],
    [{ mode: 'SOFT' }, ['tusers:update', 'tusersmemb:delete'], ['tusersmemb|switch(arguments.rc.mode) case ?']],
    [{ mode: 'purge' }, ['tusersmemb:delete'], ['tusersmemb|switch(arguments.rc.mode) case ?']],
  ])('grouped and interpolated cases under %j write %j', (predicates, ops, conditional) => {
    const closure = closureOf(CBRANCH, 'archive', { predicates });
    expect(tableOps(closure)).toEqual(ops);
    expect(closure.conditionalWrites.map((c) => `${c.table}|${c.condition}`)).toEqual(conditional);
  });

  it.each<[Predicates, string[]]>([
    [{ kind: 'Member' }, ['tcounters', 'terrors', 'tpeople']],
    [{ kind: 'team' }, ['tcounters', 'terrors', 'tgroups']],
    [{ kind: 'robot' }, ['tcounters', 'terrors', 'tother']],
  ])('cfswitch with value lists and delimiters under %j writes %j', (predicates, tables) => {
    const closure = closureOf(CTAG, 'update', { predicates });
    expect(closure.tables).toEqual(tables);
    expect(closure.conditionalWrites).toEqual([
      { table: 'terrors', condition: 'cfcatch type="database"', source: at(tree, CTAG, 'INSERT INTO terrors') },
    ]);
    expect(closure.writes.find((w) => w.table === 'tcounters')?.whereParams).toEqual(['kind']);
  });

  it('treats a catch body as an undecidable guard and its try block as unconditional', () => {
    const closure = closureOf(CBRANCH, 'importRoster', { predicates: { importid: '7' } });
    expect(tableOps(closure)).toEqual(['timports:delete', 'timports:insert']);
    expect(closure.conditionalWrites).toEqual([
      { table: 'timports', condition: 'catch(any e)', source: at(tree, CBRANCH, 'DELETE FROM timports') },
    ]);
  });

  it.each<[string, Predicates, string[]]>([
    ['Update', { action: 'Update' }, ['tusers:update']],
    ['delete', { action: 'delete' }, ['tusers:delete']],
    ['Add', { action: 'Add' }, ['tusers:insert']],
  ])('gates the %s branch of the fixture controller behind its CSRF check', (_label, predicates, ops) => {
    const closure = closureOf(CFIXTURE, 'update', { predicates });
    expect(tableOps(closure)).toEqual(ops);
    expect(closure.conditionalWrites.map((c) => c.condition)).toEqual(['arguments.rc.$.validateCSRFTokens(context="update")']);
  });

  it('writes nothing for the fixture controller base entry that excludes every action variant', () => {
    const closure = closureOf(CFIXTURE, 'update', { excludePredicates: [{ action: 'Add' }, { action: 'Update' }, { action: 'Delete' }] });
    expect(closure.tables).toEqual([]);
    expect(closure.visited).toEqual([`${CFIXTURE}#update`]);
  });

  it('keeps the remove branch conditional on a CSRF check keyed by a request value', () => {
    const closure = closureOf(CFIXTURE, 'remove', { predicates: { userid: 'u1' } });
    expect(closure.conditionalWrites).toEqual([
      { table: 'tusers', condition: 'arguments.rc.$.validateCSRFTokens(context=arguments.rc.userid)', source: at(tree, USER_MANAGER, 'DELETE FROM tusers') },
    ]);
    expect(closure.writes[0]?.whereParams).toEqual(['userid']);
  });

  it('skips a missing getter on a resolved component without reporting it', () => {
    const closure = closureOf(CFIXTURE, 'list');
    expect(closure.writes).toEqual([]);
    expect(closure.unresolved).toEqual([]);
  });
});

describe('file store, session effects and threads', () => {
  it('records the photo branch as conditional file-store evidence when nothing decides it', () => {
    const closure = closureOf(CBRANCH, 'update', { predicates: { action: 'Add' } });
    expect(closure.tables).toEqual(['tfiles', 'tusers', 'tusersinterests']);
    expect(closure.conditionalWrites).toEqual([
      { table: 'tfiles', condition: 'len(arguments.rc.newFile)', source: at(tree, FILE_MANAGER, 'INSERT INTO tfiles') },
    ]);
    expect(closure.fileStore).toBe(true);
    expect(closure.fileStoreEvidence).toEqual([
      { component: FILE_MANAGER, method: 'create', source: at(tree, ROSTER, 'variables.fileManager.create('), conditional: true },
      { component: FILE_WRITER, method: 'writeFile', source: at(tree, FILE_MANAGER, 'variables.fileWriter.writeFile('), conditional: true },
    ]);
  });

  it('records the photo variant as unconditional file-store evidence', () => {
    const closure = closureOf(CBRANCH, 'update', { predicates: { action: 'Add', newFile: true } });
    expect(closure.conditionalWrites).toEqual([]);
    expect(closure.fileStoreEvidence.map((e) => [e.component, e.method, e.conditional])).toEqual([
      [FILE_MANAGER, 'create', false],
      [FILE_WRITER, 'writeFile', false],
    ]);
  });

  it('upgrades file-store evidence first seen under a guard when an unconditional path reaches it', () => {
    const closure = walkClosureOf('walk/merge.cfc', 'photo');
    expect(closure.fileStoreEvidence).toEqual([
      { component: 'fileDAO', method: 'purgeDeleted', source: at(walkTree, 'walk/merge.cfc', "getBean('fileDAO')"), conditional: false },
      { component: 'filewriter', method: 'renameFile', source: at(walkTree, 'walk/fileManager.cfc', 'renameFile'), conditional: false },
      { component: 'walk/fileManager.cfc', method: 'deleteVersion', source: at(walkTree, 'walk/merge.cfc', 'deleteVersion(1)'), conditional: false },
      { component: 'walk/fileManager.cfc', method: 'deleteVersion', source: at(walkTree, 'walk/merge.cfc', 'deleteVersion(2)'), conditional: false },
    ]);
    expect(closure.unresolved).toEqual([
      { expr: 'variables.fileWriter.renameFile', kind: 'bean', source: at(walkTree, 'walk/fileManager.cfc', 'renameFile') },
      { expr: "getBean('fileDAO').purgeDeleted", kind: 'bean', source: at(walkTree, 'walk/merge.cfc', "getBean('fileDAO')") },
    ]);
  });

  it.each<[string, Predicates, string]>([
    ['save', { type: '1' }, 'none'],
    ['relogin', {}, 'relogin'],
    ['login', {}, 'login'],
    ['signout', {}, 'logout'],
    ['update', { action: 'Update', newFile: false }, 'relogin'],
  ])('cbranch.%s under %j has session effect %s', (method, predicates, effect) => {
    expect(closureOf(CBRANCH, method, { predicates }).sessionEffects).toBe(effect);
  });

  it('reaches the login writes of a re-login through the user bean', () => {
    const closure = closureOf(CBRANCH, 'relogin');
    expect(closure.writes.map((w) => [w.component, w.method, w.op])).toEqual([
      [ROSTER_DAO, 'updatePerson', 'update'],
      [USER_UTILITY, 'loginByUserID', 'update'],
    ]);
    expect(closure.visited).toContain(`${USER_BEAN}#login`);
  });

  it.each<[string, string]>([
    ['core/mura/login/loginManager.cfc', 'logout'],
    [USER_UTILITY, 'logout'],
    [USER_UTILITY, 'loginByUserID'],
  ])('%s#%s sets its own session effect', (component, method) => {
    expect(closureOf(component, method).sessionEffects).toBe(method === 'logout' ? 'logout' : 'login');
  });

  it.each<[string, string]>([
    [FIXTURE_MANAGER, 'refreshLogin'],
    [FIXTURE_DAO, 'refreshLogin'],
  ])('%s#%s logs the session user in again through userBean.login()', (component, method) => {
    const closure = closureOf(component, method);
    expect(closure.sessionEffects).toBe('relogin');
    expect(closure.writes).toEqual([]);
    expect(closure.unresolved).toEqual([]);
  });

  it('records a run thread and the thread trigger of the writes it reaches', () => {
    const closure = closureOf(CBRANCH, 'rebuild', { predicates: { type: '2' } });
    const open = at(tree, CBRANCH, 'name="rosterRebuild"').lines[0];
    expect(closure.threads).toEqual([{ name: 'rosterRebuild', component: CBRANCH, method: 'rebuild', source: { path: CBRANCH, lines: [open, open + 2] } }]);
    expect(closure.writes.map((w) => [w.table, w.op, w.trigger])).toEqual([
      ['tusers', 'delete', 'thread'],
      ['tusersmemb', 'delete', 'thread'],
    ]);
  });

  it('keeps a guarded thread and its writes when the guard holds', () => {
    const closure = closureOf(CBRANCH, 'rebuild', { predicates: { type: '1' } });
    expect(closure.threads.map((t) => t.name)).toEqual(['rosterRebuild', 'groupRebuild']);
    expect(closure.writes.find((w) => w.table === 'tgroups')).toMatchObject({ op: 'delete', trigger: 'thread', whereParams: ['siteid'], conditional: false });
  });

  it.each<[string, string, string, [number, number], [number, number]]>([
    [FIXTURE_MANAGER, 'trackStats', 'fixtureStats', [13, 15], [14, 14]],
    [FIXTURE_DAO, 'trackAsync', 'fixtureThread#createUUID()#', [36, 41], [38, 39]],
  ])('%s#%s runs its insert in thread %s', (component, method, name, threadLines, writeLines) => {
    const closure = closureOf(component, method);
    expect(closure.threads).toEqual([{ name, component, method, source: { path: component, lines: threadLines } }]);
    expect(closure.writes).toEqual([
      { table: 'tfixturestats', op: 'insert', component, method, source: { path: component, lines: writeLines }, trigger: 'thread', whereParams: [], conditional: false },
    ]);
  });

  it.each<[string, string, string, [number, number], string[]]>([
    [FIXTURE_MANAGER, 'rename', 'update', [5, 5], ['userid']],
    [FIXTURE_MANAGER, 'purgeSite', 'delete', [9, 9], ['siteid']],
    [FIXTURE_DAO, 'create', 'insert', [7, 12], []],
    [FIXTURE_DAO, 'update', 'update', [20, 22], ['userid']],
  ])('%s#%s %ss tfixture at lines %j keyed by %j', (component, method, op, lines, whereParams) => {
    expect(closureOf(component, method).writes).toEqual([
      { table: 'tfixture', op, component, method, source: { path: component, lines }, trigger: 'request', whereParams, conditional: false },
    ]);
  });

  it('follows a getBean call from the fixture manager into the fixture DAO', () => {
    const closure = closureOf(FIXTURE_MANAGER, 'create');
    expect(closure.writes.map((w) => [w.table, w.component, w.method, w.source.lines])).toEqual([['tfixture', FIXTURE_DAO, 'create', [7, 12]]]);
    expect(closure.visited).toEqual([`${FIXTURE_DAO}#create`, `${FIXTURE_MANAGER}#create`]);
  });

  it('keys the membership delete by both of its bound arguments', () => {
    expect(closureOf(FIXTURE_DAO, 'deleteMembership').writes.map((w) => [w.table, w.whereParams])).toEqual([['tfixturemembers', ['userid', 'groupid']]]);
  });
});

describe('unresolved references', () => {
  it('reports each reference the walk cannot follow with its kind and line', () => {
    const closure = closureOf(CBRANCH, 'unresolvedCalls');
    const line = (marker: string): SourceRef => at(tree, CBRANCH, marker);
    expect(closure.unresolved).toEqual([
      { expr: "getBean('missingService').run", kind: 'bean', source: line("getBean('missingService')") },
      { expr: 'new mura.roster.absentHelper', kind: 'component', source: line('absentHelper') },
      { expr: 'new mura.roster.absentHelper().run', kind: 'component', source: line('absentHelper') },
      { expr: 'application.rosterManager.absentMethod', kind: 'method', source: line('absentMethod') },
      { expr: 'local.record.save', kind: 'receiver', source: line('local.record.save') },
      { expr: 'application.ghostService.run', kind: 'component', source: line('ghostService') },
      { expr: 'parts/absent.cfm', kind: 'include', source: line('parts/absent.cfm') },
    ]);
    expect(closure.writes).toEqual([]);
  });

  it('reports a dynamic table it cannot bind as an unresolved table with a null write', () => {
    const closure = closureOf(CBRANCH, 'purge');
    expect(closure.writes).toEqual([
      {
        table: null,
        op: 'delete',
        component: ROSTER_DAO,
        method: 'purgeAny',
        source: at(tree, ROSTER_DAO, 'DELETE FROM #arguments.tbl#'),
        trigger: 'request',
        whereParams: ['siteid'],
        conditional: false,
        dynamic: true,
      },
    ]);
    expect(closure.tables).toEqual([]);
    expect(closure.unresolved).toEqual([{ expr: '#arguments.tbl#', kind: 'table', source: at(tree, ROSTER_DAO, 'DELETE FROM #arguments.tbl#') }]);
  });

  it('dispatches a missing method to onMissingMethod', () => {
    const closure = closureOf(CBRANCH, 'proxy');
    expect(closure.tables).toEqual(['tproxylog']);
    expect(closure.visited).toContain('core/mura/roster/rosterProxy.cfc#onMissingMethod');
    expect(closure.unresolved).toEqual([]);
  });

  it('ends a self-referential assignment as an unresolved bean', () => {
    expect(walkClosureOf('walk/loop.cfc', 'selfRef').unresolved).toEqual([
      { expr: 'variables.dao.save', kind: 'bean', source: at(walkTree, 'walk/loop.cfc', 'variables.dao.save') },
    ]);
  });

  it('resolves this and super in a template against the template itself', () => {
    const closure = walkClosureOf('walk/page.cfm', '');
    expect(closure.unresolved).toEqual([
      { expr: 'this.render', kind: 'method', source: at(walkTree, 'walk/page.cfm', 'this.render') },
      { expr: 'super.save', kind: 'receiver', source: at(walkTree, 'walk/page.cfm', 'super.save') },
    ]);
    expect(closure.visited).toEqual(['walk/page.cfm#']);
  });

  it.each<[string, string, RegExp]>([
    ['walk/absent.cfc', 'run', /closure entry walk\/absent\.cfc is not a CFML unit of the source tree/],
    ['walk/absent.cfm', '', /closure entry walk\/absent\.cfm is not a CFML unit of the source tree/],
    ['walk/loop.cfc', 'absent', /closure entry walk\/loop\.cfc has no method "absent"/],
  ])('refuses the entry %s#%s', (component, method, message) => {
    expect(() => walkClosureOf(component, method)).toThrow(message);
  });
});

describe('dynamic tables and ORM saves', () => {
  it('binds dynamic tables from call literals, formal defaults and the component table, and leaves a non-literal argument unbound', () => {
    const closure = closureOf(CBRANCH, 'tables');
    expect(closure.writes.map((w) => [w.table, w.op, w.component, w.method])).toEqual([
      [null, 'delete', ROSTER_DAO, 'purgeDefault'],
      ['tauditlog', 'delete', AUDIT_DAO, 'clear'],
      ['ttags', 'delete', TAG_DAO, 'clear'],
      ['tusersmemb', 'delete', ROSTER_DAO, 'clearFrom'],
      ['tuserstags', 'delete', ROSTER_DAO, 'purgeDefault'],
    ]);
    const line = at(tree, ROSTER_DAO, 'function purgeDefault').lines[0] + 1;
    expect(closure.unresolved).toEqual([{ expr: '#arguments.tbl#', kind: 'table', source: { path: ROSTER_DAO, lines: [line, line] } }]);
  });

  it('records ORM saves and deletes through the entity table, and #getTable()# through the receiver', () => {
    const closure = closureOf(CBRANCH, 'saveFixture');
    expect(closure.writes.map((w) => [w.table, w.op, w.component, w.method, w.source.path])).toEqual([
      ['tfixtures', 'delete', FIXTURE_BEAN, 'delete', CBRANCH],
      ['tfixtures', 'delete', FIXTURE_BEAN, 'purge', 'core/mura/bean/beanORM.cfc'],
      ['tfixtures', 'save', FIXTURE_BEAN, 'save', CBRANCH],
    ]);
    expect(closure.unresolved).toEqual([]);
  });

  it('leaves #variables.table# unresolved on a component that declares no table', () => {
    const closure = closureOf(BASE_DAO, 'clear');
    expect(closure.writes.map((w) => [w.table, w.dynamic])).toEqual([[null, true]]);
    expect(closure.unresolved).toEqual([{ expr: '#variables.table#', kind: 'table', source: at(tree, BASE_DAO, 'DELETE FROM') }]);
  });

  it('passes literal table names through intermediate calls', () => {
    const closure = closureOf(ROSTER, 'delete');
    expect(closure.writes.map((w) => [w.table, w.method, w.whereParams])).toEqual([
      ['tusers', 'delete', ['userid']],
      ['tusersmemb', 'clearFrom', ['userid']],
    ]);
  });
});

describe('templates and includes', () => {
  it('walks a start-up template, its mapped and relative includes, with the appstart trigger', () => {
    const closure = closureOf(ON_START, '', { trigger: 'appstart' });
    expect(closure.writes.map((w) => [w.table, w.component, w.method, w.trigger, w.conditional])).toEqual([
      ['tboot', 'core/mura/fixture/boot.cfm', '', 'appstart', false],
      ['textra', 'app/extra.cfm', '', 'appstart', false],
      ['tregistry', 'app/startup/register.cfm', '', 'appstart', false],
      ['tregistry', 'app/startup/register.cfm', 'registerBeans', 'appstart', false],
      ['treloads', 'app/startup/reload.cfm', '', 'appstart', true],
      ['tsettings', ON_START, '', 'appstart', false],
      ['twarm', 'app/startup/warm.cfm', '', 'thread', false],
    ]);
    expect(closure.conditionalWrites.map((c) => [c.table, c.condition])).toEqual([['treloads', 'rc.reload eq "true"']]);
    expect(closure.threads).toEqual([{ name: 'warmup', component: ON_START, method: '', source: at(tree, ON_START, '<cfthread', 2) }]);
    expect(closure.unresolved).toEqual([
      { expr: 'extra-missing.cfm', kind: 'include', source: at(tree, 'app/extra.cfm', 'extra-missing.cfm') },
      { expr: '../../outside.cfm', kind: 'include', source: at(tree, ON_START, 'outside.cfm') },
      { expr: '#variables.dynamicTemplate#', kind: 'include', source: at(tree, ON_START, 'dynamicTemplate') },
      { expr: 'missing.cfm', kind: 'include', source: at(tree, ON_START, 'missing.cfm') },
      { expr: 'this.missingHelper', kind: 'method', source: at(tree, ON_START, 'missingHelper') },
    ]);
    expect(closure.visited).toEqual([
      'app/extra.cfm#',
      ON_START + '#',
      'app/startup/register.cfm#',
      'app/startup/register.cfm#registerBeans',
      'app/startup/reload.cfm#',
      'app/startup/warm.cfm#',
      'core/mura/fixture/boot.cfm#',
    ]);
  });

  it.each<[Predicates, boolean]>([
    [{ reload: 'true' }, true],
    [{ reload: 'false' }, false],
  ])('prunes or keeps a guarded include under %j', (predicates, kept) => {
    const closure = closureOf(ON_START, '', { predicates, trigger: 'appstart' });
    expect(closure.tables.includes('treloads')).toBe(kept);
    expect(closure.conditionalWrites).toEqual([]);
  });

  it('reads the request inside a component include and calls the including component', () => {
    const closure = closureOf(CBRANCH, 'summary', { predicates: { mode: 'full' } });
    expect(closure.writes.map((w) => [w.table, w.component, w.method, w.conditional])).toEqual([
      ['tsummary', ROSTER, 'summaryCount', false],
      ['tsummarylog', SUMMARY, '', false],
    ]);
    expect(closureOf(CBRANCH, 'summary', { predicates: { mode: 'brief' } }).tables).toEqual(['tsummary']);
  });
});

describe('writer overrides', () => {
  let rosterOverrides: WriterOverrides;

  beforeAll(() => {
    const source = (rel: string, marker: string): SourceRef => at(tree, rel, marker);
    rosterOverrides = parseWriterOverrides(
      stringify({
        sourceSha: pinnedSha(),
        writers: [
          {
            id: 'wov:roster-sync',
            tablesFrom: { job: 'rosterSync' },
            component: ROSTER,
            method: 'syncAll',
            op: 'update',
            source: source(ROSTER, 'function syncAll'),
            routeKeys: [],
            keyScope: 'table',
            trigger: 'scheduler',
            sessionEffects: 'none',
            reason: 'syncAll runs the steps of a scheduled job.',
          },
          {
            id: 'wov:roster-purge',
            tables: ['tusersmemb', 'tuserstags'],
            component: ROSTER,
            method: 'purgeTables',
            op: 'delete',
            source: source(ROSTER, 'function purgeTables'),
            routeKeys: ['cbranch.purge'],
            keyScope: ['userid'],
            trigger: 'request',
            sessionEffects: 'none',
            condition: "arguments.scope eq 'all'",
            reason: 'purgeTables picks its tables from the request scope.',
          },
          {
            id: 'wov:audit-clear',
            tables: ['tauditarchive'],
            component: AUDIT_DAO,
            method: 'clear',
            op: 'insert',
            source: source(BASE_DAO, 'function clear'),
            routeKeys: ['cbranch.tables'],
            keyScope: 'table',
            trigger: 'request',
            sessionEffects: 'none',
            reason: 'The audit DAO archives rows before the inherited clear.',
          },
          {
            id: 'wov:start-settings',
            tables: ['tsettings'],
            component: ON_START,
            method: null,
            op: 'update',
            source: source(ON_START, 'UPDATE tsettings'),
            routeKeys: [],
            keyScope: 'table',
            trigger: 'appstart',
            sessionEffects: 'none',
            reason: 'The start-up template stamps the settings row.',
          },
        ],
      }),
      'inline-writer-overrides.yaml',
    );
  });

  it('applies the reviewed fixture overrides loaded from YAML', async () => {
    const overrides = await loadWriterOverrides(fileURLToPath(new URL('../fixtures/inventory/writer-overrides.valid.yaml', import.meta.url)));
    const relogin = closureOf(FIXTURE_MANAGER, 'refreshLogin', {}, overrides);
    expect(relogin.overrides).toEqual(['wov:fixture-relogin']);
    expect(relogin.sessionEffects).toBe('relogin');
    expect(relogin.writes).toEqual([
      {
        table: 'tusers',
        op: 'update',
        component: FIXTURE_MANAGER,
        method: 'refreshLogin',
        source: { path: FIXTURE_MANAGER, lines: [18, 20] },
        trigger: 'request',
        whereParams: ['userid', 'siteid'],
        conditional: false,
        override: 'wov:fixture-relogin',
      },
    ]);
    const thread = closureOf(FIXTURE_MANAGER, 'trackStats', {}, overrides);
    expect(thread.overrides).toEqual(['wov:fixture-thread']);
    expect(thread.writes.map((w) => [w.source.lines, w.trigger, w.whereParams, w.override ?? null])).toEqual([
      [[12, 16], 'thread', ['siteid'], 'wov:fixture-thread'],
      [[14, 14], 'thread', [], null],
    ]);
  });

  it('settles the unresolved calls of an overridden method and records a tablesFrom override by id', () => {
    expect(closureOf(CBRANCH, 'sync').unresolved).toEqual([
      { expr: 'getBean(variables.jobName).run', kind: 'bean', source: at(tree, ROSTER, 'getBean(variables.jobName)') },
      { expr: 'local.job.save', kind: 'receiver', source: at(tree, ROSTER, 'local.job.save') },
    ]);
    const closure = closureOf(CBRANCH, 'sync', {}, rosterOverrides);
    expect(closure.unresolved).toEqual([]);
    expect(closure.overrides).toEqual(['wov:roster-sync']);
    expect(closure.writes).toEqual([]);
  });

  it('writes the tables of a conditional override as conditional writes', () => {
    const closure = closureOf(CBRANCH, 'purge', {}, rosterOverrides);
    expect(closure.overrides).toEqual(['wov:roster-purge']);
    expect(closure.conditionalWrites).toEqual([
      { table: 'tusersmemb', condition: "arguments.scope eq 'all'", source: at(tree, ROSTER, 'function purgeTables') },
      { table: 'tuserstags', condition: "arguments.scope eq 'all'", source: at(tree, ROSTER, 'function purgeTables') },
    ]);
    expect(closure.writes.filter((w) => w.override !== undefined).map((w) => [w.table, w.component, w.method, w.trigger, w.whereParams])).toEqual([
      ['tusersmemb', ROSTER, 'purgeTables', 'request', ['userid']],
      ['tuserstags', ROSTER, 'purgeTables', 'request', ['userid']],
    ]);
  });

  it('matches an override on the receiver of an inherited method', () => {
    const closure = closureOf(CBRANCH, 'tables', {}, rosterOverrides);
    expect(closure.overrides).toEqual(['wov:audit-clear']);
    expect(closure.writes.find((w) => w.override === 'wov:audit-clear')).toMatchObject({ table: 'tauditarchive', op: 'insert', component: AUDIT_DAO, method: 'clear', whereParams: [] });
  });

  it('applies a template override with a null method to that template alone and settles only its gaps', () => {
    const closure = closureOf(ON_START, '', { trigger: 'appstart' }, rosterOverrides);
    expect(closure.overrides).toEqual(['wov:start-settings']);
    expect(closure.unresolved).toEqual([{ expr: 'extra-missing.cfm', kind: 'include', source: at(tree, 'app/extra.cfm', 'extra-missing.cfm') }]);
    expect(closure.writes.filter((w) => w.override !== undefined)).toEqual([
      {
        table: 'tsettings',
        op: 'update',
        component: ON_START,
        method: '',
        source: at(tree, ON_START, 'UPDATE tsettings'),
        trigger: 'appstart',
        whereParams: [],
        conditional: false,
        override: 'wov:start-settings',
      },
    ]);
  });

  it('counts an override that logs in on a re-login path as a re-login', () => {
    const member = parseWriterOverrides(
      stringify({
        sourceSha: pinnedSha(),
        writers: [
          {
            id: 'wov:member-login',
            tables: ['tmembers'],
            component: 'walk/memberBean.cfc',
            method: 'login',
            op: 'update',
            source: at(walkTree, 'walk/memberBean.cfc', 'UPDATE tmembers'),
            routeKeys: ['cmember.signin'],
            keyScope: ['memberid'],
            trigger: 'request',
            sessionEffects: 'login',
            reason: 'The member bean login stamps the member row and logs the member in.',
          },
        ],
      }),
      'member-overrides.yaml',
    );
    expect(walkClosureOf('walk/cmember.cfc', 'signin', {}, member).sessionEffects).toBe('relogin');
    expect(walkClosureOf('walk/memberBean.cfc', 'login', {}, member).sessionEffects).toBe('login');
  });
});

describe('settled calls', () => {
  const SETTLE = 'core/mura/settle/settleManager.cfc';
  const settleTree = memorySourceTree({
    [SETTLE]: `component output="false" {
  public any function run(rc) {
    getBean('missingService').run(arguments.rc);
    application.ghostService.run();
    this.absentMethod();
    local.record.save();
    include "parts/absent.cfm";
    queryExecute("DELETE FROM #arguments.rc.tbl# WHERE siteid = :siteid", {siteid=1});
  }
}
`,
  });
  const settleIndex = componentIndex(settleTree, { ghostService: 'core/mura/ghost/ghostService.cfc' });
  const line = (marker: string): number => at(settleTree, SETTLE, marker).lines[0];
  const first = line("getBean('missingService')");
  const last = line('DELETE FROM');

  /** Closure of settleManager.run, under one settled call spanning `source` when it is given. */
  function runClosure(source?: SourceRef): WriteClosure {
    const overrides =
      source === undefined
        ? undefined
        : parseWriterOverrides(
            stringify({
              sourceSha: pinnedSha(),
              writers: [],
              settledCalls: [
                { id: 'wov:settle-run', source, calls: ['run'], resolution: 'non-write', reason: 'The span writes no table.' },
              ],
            }),
            'settled-calls.yaml',
          );
    return computeClosure({ component: SETTLE, method: 'run' }, { tree: settleTree, index: settleIndex, overrides });
  }

  it.each<[UnresolvedKind, string]>([
    ['bean', "getBean('missingService')"],
    ['component', 'application.ghostService'],
    ['method', 'this.absentMethod'],
    ['receiver', 'local.record.save'],
    ['include', 'parts/absent.cfm'],
    ['table', 'DELETE FROM'],
  ])('applies the settled call covering the %s reference instead of reporting it', (kind, marker) => {
    const source = at(settleTree, SETTLE, marker);
    const unsettled = runClosure();
    expect(unsettled.unresolved.filter((u) => u.source.lines[0] === source.lines[0]).map((u) => u.kind)).toEqual([kind]);
    const settled = runClosure(source);
    expect(settled.unresolved).toEqual(unsettled.unresolved.filter((u) => u.kind !== kind));
    expect(settled.overrides).toEqual(['wov:settle-run']);
    expect(settled.writes).toEqual(unsettled.writes);
  });

  it('settles every reference of an inclusive span from the first to the last of their lines', () => {
    const result = runClosure({ path: SETTLE, lines: [first, last] });
    expect(result.unresolved).toEqual([]);
    expect(result.overrides).toEqual(['wov:settle-run']);
  });

  it.each<[string, SourceRef]>([
    ['the lines above the references', { path: SETTLE, lines: [1, first - 1] }],
    ['the same lines of another file', { path: 'core/mura/settle/otherManager.cfc', lines: [first, last] }],
  ])('still reports every reference when the settled span covers only %s', (_label, source) => {
    const unsettled = runClosure();
    expect(unsettled.unresolved).toHaveLength(6);
    const result = runClosure(source);
    expect(result.unresolved).toEqual(unsettled.unresolved);
    expect(result.overrides).toEqual([]);
  });
});

describe('walk termination and merging', () => {
  it('terminates on direct and mutual recursion', () => {
    const closure = walkClosureOf('walk/loop.cfc', 'walk');
    expect(closure.tables).toEqual(['tvisits']);
    expect(closure.visited).toEqual(['walk/loop.cfc#visit', 'walk/loop.cfc#walk']);
  });

  it('terminates on an extends cycle and finds an inherited entry method', () => {
    expect(walkClosureOf('walk/cycleA.cfc', 'run').tables).toEqual(['tcycles']);
    const closure = walkClosureOf('walk/cycleA.cfc', 'start');
    expect(closure.writes.map((w) => [w.table, w.component, w.method])).toEqual([['tcycles', 'walk/cycleA.cfc', 'run']]);
    expect(closure.unresolved).toEqual([{ expr: 'this.absent', kind: 'method', source: at(walkTree, 'walk/cycleA.cfc', 'this.absent') }]);
  });

  it.each<[string, Array<[string, boolean]>, string[]]>([
    ['supersede', [['trecords', false]], []],
    ['keepPlain', [['tstamps', false]], []],
    ['upgrade', [['tstamps', false]], []],
    ['firstCondition', [['tstamps', true]], ["arguments.rc.mode eq 'x'"]],
  ])('%s merges conditional and unconditional sightings of one write', (method, writes, conditions) => {
    const closure = walkClosureOf('walk/merge.cfc', method);
    expect(closure.writes.map((w) => [w.table, w.conditional])).toEqual(writes);
    expect(closure.conditionalWrites.map((c) => c.condition)).toEqual(conditions);
  });

  it('keeps one write per trigger when a thread and the request reach it under different guards', () => {
    const closure = walkClosureOf('walk/merge.cfc', 'twoWays');
    expect(closure.writes.map((w) => [w.table, w.trigger, w.conditional])).toEqual([
      ['tstamps', 'request', true],
      ['tstamps', 'thread', true],
    ]);
    expect(closure.conditionalWrites.map((c) => c.condition)).toEqual(["arguments.rc.kind eq 'y'", "arguments.rc.mode eq 'x'"]);
  });

  it('lists threads that open on one line in source order', () => {
    const closure = walkClosureOf('walk/merge.cfc', 'fanOut');
    const open = at(walkTree, 'walk/merge.cfc', 'name="first"').lines[0];
    expect(closure.threads.map((t) => [t.name, t.source.lines])).toEqual([
      ['first', [open, open]],
      ['second', [open, open + 2]],
    ]);
    expect(closure.writes.map((w) => [w.table, w.trigger])).toEqual([['trecords', 'thread']]);
  });

  it.each<[Predicates, string[]]>([
    [{ kind: 'y' }, ['tforward', 'thandled', 'ttally']],
    [{ kind: 'z' }, []],
  ])('carries the request through argumentCollection and event arguments under %j', (predicates, tables) => {
    const closure = walkClosureOf('walk/merge.cfc', 'collect', { predicates });
    expect(closure.tables).toEqual(tables);
    expect(closure.conditionalWrites).toEqual([]);
  });
});

describe('call extraction', () => {
  it('classifies every call shape of a function with its target and resolved component', () => {
    const { unit, fn } = member(ROSTER, 'wiring');
    const calls = extractCalls(fn, unit, { tree, index });
    expect(calls.map((c) => [c.text, c.target, c.resolved])).toEqual([
      ['application.rosterDAO.updatePerson', { bean: 'rosterDAO', method: 'updatePerson' }, ROSTER_DAO],
      ['application.serviceFactory.getBean("rosterDAO").insertPerson', { bean: 'rosterDAO', method: 'insertPerson' }, ROSTER_DAO],
      ['variables.rosterDAO.deleteMemberships', { bean: 'rosterDAO', method: 'deleteMemberships' }, ROSTER_DAO],
      ['getRosterDAO().updatePerson', { bean: 'rosterDAO', method: 'updatePerson' }, ROSTER_DAO],
      ['getHistory().clear', { component: AUDIT_DAO, method: 'clear' }, AUDIT_DAO],
      ['new mura.roster.rosterDAO', { component: ROSTER_DAO, method: 'init' }, ROSTER_DAO],
      ['new mura.roster.rosterDAO().updatePerson', { component: ROSTER_DAO, method: 'updatePerson' }, ROSTER_DAO],
      ['createObject("component", "mura.roster.rosterDAO").updatePerson', { component: ROSTER_DAO, method: 'updatePerson' }, ROSTER_DAO],
      ['this.summaryCount', { self: 'this', method: 'summaryCount' }, ROSTER],
      ['super.init', { self: 'super', method: 'init' }, ROSTER],
      ['summaryCount', { self: 'local', method: 'summaryCount' }, ROSTER],
      ['dao.updatePerson', { bean: 'rosterDAO', method: 'updatePerson' }, ROSTER_DAO],
      ['getHistory', { self: 'local', method: 'getHistory' }, ROSTER],
      ['local.audit.clear', { component: AUDIT_DAO, method: 'clear' }, AUDIT_DAO],
      ['variables.cache.save', { bean: 'variables.cache', method: 'save' }, null],
      ["getBean('userBean').loadBy", { bean: 'userBean', method: 'loadBy' }, USER_BEAN],
      ["getBean('userBean').loadBy(userid=arguments.rc.userid).save", { bean: 'userBean', method: 'save' }, USER_BEAN],
      ["getBean('rosterDAO').other", { bean: 'rosterDAO', method: 'other' }, ROSTER_DAO],
      ["getBean('rosterDAO').other().save", { method: 'save' }, null],
      ['application.rosterDAO.settings.save', { method: 'save' }, null],
      ['items[1].save', { method: 'save' }, null],
      ['getBean(arguments.rc.beanName).save', { method: 'save' }, null],
      ['getMissing().run', { bean: 'getMissing()', method: 'run' }, null],
      ['application.rosterManager.getHistory().clear', { component: AUDIT_DAO, method: 'clear' }, AUDIT_DAO],
      ['variables.instance.helper.clear', { bean: 'auditDAO', method: 'clear' }, AUDIT_DAO],
      ['getLabel().save', { method: 'save' }, null],
      ["getEntity('fixture').save", { bean: 'fixture', method: 'save' }, FIXTURE_BEAN],
    ]);
    expect(calls.at(-1)?.guard).toEqual({ k: 'expr', text: 'arguments.rc.type eq 2' });
    expect(calls.find((c) => c.text === 'dao.updatePerson')).toMatchObject({ line: at(tree, ROSTER, 'dao.updatePerson').lines[0], args: [{ expr: 'arguments.rc' }] });
  });

  it('attaches the switch case and if guards to the calls they enclose', () => {
    const { unit, fn } = member(CBRANCH, 'update');
    const calls = extractCalls(fn, unit, { tree, index });
    expect(calls.map((c) => [c.target.method, c.guard])).toEqual([
      ['create', { k: 'case', subject: 'arguments.rc.action', values: ['Add'] }],
      ['update', { k: 'case', subject: 'arguments.rc.action', values: ['Update'] }],
      ['delete', { k: 'case', subject: 'arguments.rc.action', values: ['Delete'] }],
      ['storePhoto', { k: 'expr', text: 'len(arguments.rc.newFile)' }],
    ]);
  });

  it('attaches the enclosing thread to a call inside it', () => {
    const { unit, fn } = member(CBRANCH, 'rebuild');
    const [call] = extractCalls(fn, unit, { tree, index });
    const open = at(tree, CBRANCH, 'name="rosterRebuild"').lines[0];
    expect(call?.thread).toEqual({ name: 'rosterRebuild', line: open, endLine: open + 2 });
    expect(call?.guard).toBeUndefined();
  });

  it('resolves a template call against the receiver that includes it', () => {
    const template = parseCfmTemplate(SUMMARY, tree.readText(SUMMARY));
    const whole = template.functions[0];
    if (whole === undefined) throw new Error('template has no pseudo-function');
    expect(extractCalls(whole, template, { tree, index }).map((c) => c.text)).toEqual([]);
    expect(extractCalls(whole, template, { tree, index, receiver: ROSTER }).map((c) => [c.text, c.target, c.resolved])).toEqual([
      ['summaryCount', { self: 'local', method: 'summaryCount' }, ROSTER],
    ]);
  });
});
