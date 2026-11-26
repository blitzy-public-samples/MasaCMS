import { describe, expect, it } from 'vitest';
import {
  memorySourceTree,
  parseCfmlComponent,
  type ClosureWrite,
  type CfmlComponent,
  type ComponentIndex,
  type ConditionalWrite,
  type FileStoreEvidence,
  type SourceTree,
  type UnresolvedRef,
} from '../../src/inventory/closure.js';
import type { WriterOverrides } from '../../src/inventory/overrides.js';
import { tableOwnershipSchema } from '../../src/inventory/tables.js';
import {
  RowTypeLookups,
  UNDECIDED_FILE_STORE_GUARD,
  UnitResolver,
  WRITER_OVERRIDES_REF,
  collapseConditionalWrites,
  statementKeysOneRow,
  tusersReadTypes,
  type BranchFacts,
  type GuardOf,
  type InventoryConditionalWrite,
  type WriteEvidenceSet,
} from '../../src/inventory/units.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const UTILITY = 'core/mura/user/userUtility.cfc';
const DAO = 'core/mura/user/userDAO.cfc';

/** Ownership modelled on opt2/table-ownership.json: tusers split by Type and column, owner-typed child rows, list tables. */
const OWNERSHIP = tableOwnershipSchema.parse({
  sourceSha: SHA,
  units: [
    { unit: 'identity.group_account', owner: 'identity' },
    { unit: 'identity.user_account', owner: 'identity' },
    { unit: 'identity.credential', owner: 'identity' },
    { unit: 'identity.login_state', owner: 'identity' },
    { unit: 'people.person', owner: 'people' },
    { unit: 'identity.group_address', owner: 'identity' },
    { unit: 'people.address', owner: 'people' },
    { unit: 'content.file', owner: 'strategies-content' },
    { unit: 'content.page', owner: 'strategies-content' },
  ],
  tables: [
    {
      table: 'tusers',
      owner: 'split',
      ruleSteps: [1],
      split: { by: 'Type and column' },
      targets: [
        { unit: 'identity.group_account', owner: 'identity', rowPredicate: 'Type = 1', ownedColumns: ['UserID', 'GroupName', 'Password', 'LastLogin'] },
        { unit: 'identity.user_account', owner: 'identity', rowPredicate: 'Type = 2', ownedColumns: ['UserID', 'UserName', 'Type'] },
        { unit: 'identity.credential', owner: 'identity', rowPredicate: 'Type = 2', ownedColumns: ['Password', 'PasswordCreated'] },
        { unit: 'identity.login_state', owner: 'identity', rowPredicate: 'Type = 2', ownedColumns: ['LastLogin'] },
        { unit: 'people.person', owner: 'people', rowPredicate: 'Type = 2', ownedColumns: ['Fname', 'Lname', 'Email'] },
      ],
    },
    {
      table: 'tuseraddresses',
      owner: 'split',
      ruleSteps: [1],
      split: { by: 'owner Type' },
      targets: [
        { unit: 'identity.group_address', owner: 'identity', rowPredicate: 'owner Type = 1' },
        { unit: 'people.address', owner: 'people', rowPredicate: 'owner Type = 2' },
      ],
    },
    { table: 'tfiles', owner: 'strategies-content', ruleSteps: [1], targets: [{ unit: 'content.file', owner: 'strategies-content' }] },
    { table: 'tcontent', owner: 'strategies-content', ruleSteps: [1], targets: [{ unit: 'content.page', owner: 'strategies-content' }] },
    { table: 'tplugins', owner: 'decision-list', ruleSteps: [5], targets: [], decisionRef: 'opt2/decision-list.json#tplugins' },
    { table: 'tglobals', owner: 'retired', ruleSteps: [5], targets: [] },
    { table: 'tsyncstate', owner: 'migration', ruleSteps: [5], targets: [] },
  ],
});

const LOOKUP_SQL = '\t\t\tSELECT * FROM tusers WHERE username = <cfqueryparam value="#arguments.username#"> AND Type = 2 and inactive = 0';

/**
 * userUtility's credential lookup filtering on `Type = 2`, a lookup with two Types, a function reading no tusers, and
 * the forgot-password lookup with an unqualified and a qualified caller.
 */
const FILES: Readonly<Record<string, string>> = {
  [UTILITY]: [
    '<cfcomponent extends="mura.cfobject" output="false">',
    '<cffunction name="lookupByCredentials" output="false">',
    '\t\t<cfquery name="rsUser">',
    LOOKUP_SQL,
    '\t\t</cfquery>',
    '\t\t<cfset variables.userDAO.savePassword(rsUser.userid, arguments.password)>',
    '</cffunction>',
    '<cffunction name="lookupAny" output="false">',
    "\t\t<cfquery name=\"rs\">SELECT * FROM tusers WHERE userid = 'x' AND (Type = 1 OR Type = 2)</cfquery>",
    '</cffunction>',
    '<cffunction name="sendReminder" output="false">',
    "\t\t<cfquery name=\"rs\">SELECT * FROM tcontent WHERE type = 2</cfquery>",
    '</cffunction>',
    '<cffunction name="getUserByEmail" output="false">',
    '\t\t<cfquery name="rsCheck">SELECT * FROM tusers WHERE type=2 AND email = <cfqueryparam value="#arguments.email#"></cfquery>',
    '\t\t<cfreturn rsCheck>',
    '</cffunction>',
    '<cffunction name="sendLoginByEmail" output="false">',
    "\t\t<cfset var rsuser=getUserByEmail('#arguments.email#')>",
    '</cffunction>',
    '<cffunction name="sendLoginByProxy" output="false">',
    "\t\t<cfset var rsuser=variables.mailer.getUserByEmail('#arguments.email#')>",
    '</cffunction>',
    '</cfcomponent>',
  ].join('\n'),
  [DAO]: [
    '<cfcomponent extends="mura.cfobject" output="false">',
    '<cffunction name="savePassword" output="false">',
    '\t\t<cfquery>UPDATE tusers SET Password = <cfqueryparam value="#arguments.password#"> WHERE userid = <cfqueryparam value="#arguments.userid#"></cfquery>',
    '</cffunction>',
    '</cfcomponent>',
  ].join('\n'),
};

function indexFor(tree: SourceTree): ComponentIndex {
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: () => null,
    ormTable: () => null,
    parsed(p) {
      if (!parsed.has(p)) parsed.set(p, tree.exists(p) ? parseCfmlComponent(p, tree.readText(p)) : null);
      return parsed.get(p) ?? null;
    },
  };
}

const TREE = memorySourceTree(FILES);
const OVERRIDES: WriterOverrides = {
  sourceSha: SHA,
  writers: [],
  settledCalls: [
    { id: 'wov:settled-plugin-call', source: { path: UTILITY, lines: [11, 13] }, calls: ['pluginManager.announceEvent'], resolution: 'non-write', reason: 'announces no writer' },
  ],
};

function resolver(): UnitResolver {
  return new UnitResolver(OWNERSHIP, OVERRIDES, new RowTypeLookups(TREE, indexFor(TREE)));
}

function write(table: string, columns: string[] | null, via: string[], extra: Partial<ClosureWrite> = {}): ClosureWrite {
  return {
    table,
    op: 'update',
    component: DAO,
    method: 'savePassword',
    source: { path: DAO, lines: [3, 3] },
    trigger: 'request',
    whereParams: [],
    conditional: false,
    columns,
    via,
    ...extra,
  };
}

function evidence(writes: ClosureWrite[], extra: Partial<WriteEvidenceSet> = {}): WriteEvidenceSet {
  return { writes, conditionalWrites: [], fileStoreEvidence: [], unresolved: [], ...extra };
}

const OPEN: GuardOf = () => undefined;

function facts(predicates: Record<string, string> = {}, storedDataOwner = false): BranchFacts {
  return { predicates, storedDataOwner };
}

const SESSION_LOOKUP = ['userUtility.lookupByCredentials', 'userDAO.savePassword'];

describe('UnitResolver.project unit resolution', () => {
  it.each([
    ['column intersection: a LastLogin write reaches only the targets owning LastLogin', [write('tusers', ['lastlogin'], ['userDAO.update'])], facts({}, true), ['identity.group_account', 'identity.login_state'], ['identity']],
    ['column intersection: a person-column write reaches the person unit', [write('tusers', ['FNAME', 'email'], ['userDAO.update'])], facts({}, true), ['people.person'], ['people']],
    ['request Type predicate: type=1 keeps the group target', [write('tusers', null, ['userDAO.update'])], facts({ type: '1' }), ['identity.group_account'], ['identity']],
    ['request Type predicate: type=2 keeps the user-row targets', [write('tusers', null, ['userDAO.update'])], facts({ Type: '2' }), ['identity.credential', 'identity.login_state', 'identity.user_account', 'people.person'], ['identity', 'people']],
    ['request Type predicate: a type no Type target names is no row evidence', [write('tusers', ['password'], ['userDAO.update'])], facts({ type: 'Page' }, true), ['identity.credential', 'identity.group_account'], ['identity']],
    ['session-user Type=2: a write keyed by the credential lookup is a user row', [write('tusers', ['password'], SESSION_LOOKUP)], facts({}, true), ['identity.credential'], ['identity']],
    ['session-user Type=2: a lookup filtering on two Types decides nothing', [write('tusers', ['password'], ['userUtility.lookupAny', 'userDAO.savePassword'])], facts({}, true), ['identity.credential', 'identity.group_account'], ['identity']],
    ['forgot-password Type=2: a caller of a same-component Type=2 lookup keys a user row', [write('tusers', ['password', 'fname'], ['userUtility.sendLoginByEmail', 'userBean.save', 'userDAO.update'])], facts({}, true), ['identity.credential', 'people.person'], ['identity', 'people']],
    ['forgot-password Type=2: a qualified call of the lookup decides nothing', [write('tusers', ['password', 'fname'], ['userUtility.sendLoginByProxy', 'userBean.save', 'userDAO.update'])], facts({}, true), ['identity.credential', 'identity.group_account', 'people.person'], ['identity', 'people']],
    ['session-user Type=2: an owner-typed row of a branch writing no tusers is a user row', [write('tuseraddresses', null, ['addressDAO.create'])], facts(), ['people.address'], ['people']],
    ['session-user Type=2: an owner held in stored data decides nothing', [write('tuseraddresses', null, ['addressDAO.create'])], facts({}, true), ['identity.group_address', 'people.address'], ['identity', 'people']],
    ['session-user Type=2: owner rows follow the Type of the tusers row the branch writes', [write('tuseraddresses', null, ['addressDAO.create']), write('tusers', null, ['userDAO.update'])], facts({ type: '1' }), ['identity.group_account', 'identity.group_address'], ['identity']],
    ['decision-list: a listed table resolves to its legacy unit', [write('tplugins', null, ['pluginDAO.save'])], facts(), ['legacy:tplugins'], []],
    ['retired: a retired table resolves to its legacy unit with no owner', [write('tglobals', null, ['settingsDAO.save'])], facts(), ['legacy:tglobals'], []],
    ['target-less owner: a coordination table keeps its owner', [write('tsyncstate', null, ['syncDAO.save'])], facts(), ['legacy:tsyncstate'], ['migration']],
  ])('%s', (_name, writes, branch, units, owners) => {
    const projected = resolver().project(evidence(writes), branch, OPEN, [...new Set(writes.map((w) => w.table ?? ''))]);
    expect([...new Set(projected.writeSet.map((w) => w.unit))].sort()).toEqual(units);
    expect(projected.owners.owners).toEqual(owners);
  });

  it.each([
    ['decision-list', 'tplugins', ['tplugins']],
    ['retired', 'tglobals', []],
  ])('lists a %s table as a decision table only when it is on the decision list', (_kind, table, decisionTables) => {
    expect(resolver().project(evidence([write(table, null, [])]), facts(), OPEN, [table]).owners.decisionTables).toEqual(decisionTables);
  });

  it('records a file-store call under the file-store unit with no table, and counts the file store toward the owners', () => {
    const file: FileStoreEvidence = { component: DAO, method: 'deleteVersion', source: { path: DAO, lines: [9, 9] }, conditional: true, via: ['fileManager.deleteVersion'] };
    const projected = resolver().project(evidence([], { fileStoreEvidence: [file] }), facts(), OPEN, []);
    expect(projected.writeSet).toEqual([
      { unit: 'file-store', legacyTable: null, op: 'delete', via: ['fileManager.deleteVersion'], source: file.source, condition: UNDECIDED_FILE_STORE_GUARD, override: null },
    ]);
    expect(projected.owners).toEqual({ owners: ['strategies-content'], decisionTables: [] });
  });

  it('throws for a written table the ownership file does not list', () => {
    expect(() => resolver().project(evidence([write('tunknown', null, [])]), facts(), OPEN, ['tunknown'])).toThrow(
      'table ownership assigns no owner to written table tunknown',
    );
  });
});

describe('UnitResolver.project records', () => {
  it('keeps a write only under a never-holding guard out of the write set, tables and owners', () => {
    const guarded = write('tcontent', null, ['siteManager.load'], { op: 'insert', source: { path: UTILITY, lines: [12, 12] } });
    const guardOf: GuardOf = (w) => (w === guarded ? { kind: 'site-load', guard: 'loads a missing site' } : undefined);
    const projected = resolver().project(evidence([guarded]), facts(), guardOf, ['tcontent']);
    expect(projected).toMatchObject({ writeSet: [], tables: [], owners: { owners: [], decisionTables: [] } });
    expect(projected.conditionalWrites).toEqual([
      { kind: 'site-load', unit: 'content.page', legacyTable: 'tcontent', op: 'insert', via: ['siteManager.load'], source: guarded.source, guard: 'loads a missing site' },
    ]);
  });

  it('records a guarded split-table write reached on several paths once, with a null unit and the first path', () => {
    const at = (via: string[]): ClosureWrite => write('tusers', null, via, { op: 'insert', source: { path: UTILITY, lines: [12, 12] } });
    const guardOf: GuardOf = () => ({ kind: 'site-load', guard: 'loads a missing site' });
    const projected = resolver().project(evidence([at(['b.save', 'userDAO.create']), at(['a.save', 'userDAO.create'])]), facts({}, true), guardOf, ['tusers']);
    expect(projected.conditionalWrites).toEqual([
      { kind: 'site-load', unit: null, legacyTable: 'tusers', op: 'insert', via: ['a.save', 'userDAO.create'], source: { path: UTILITY, lines: [12, 12] }, guard: 'loads a missing site' },
    ]);
  });

  it('gives a guarded write of a table with no ownership entry a null unit', () => {
    const guarded = write('tclustercommands', null, ['clusterManager.broadcast'], { op: 'insert' });
    const projected = resolver().project(evidence([guarded]), facts(), () => ({ kind: 'cluster-broadcast', guard: 'no peers' }), ['tclustercommands']);
    expect(projected.conditionalWrites).toMatchObject([{ kind: 'cluster-broadcast', unit: null, legacyTable: 'tclustercommands' }]);
  });

  it('carries the closure condition and the writer override, and keeps one record per unit, table, op and source', () => {
    const source = { path: DAO, lines: [3, 3] as [number, number] };
    const conditional = write('tusers', ['password'], ['loginManager.login', ...SESSION_LOOKUP], { conditional: true, override: 'wov:legacy-hash-upgrade' });
    const plain = write('tusers', ['password'], SESSION_LOOKUP);
    const condition: ConditionalWrite = { table: 'tusers', condition: 'len(rsUser.password) eq 32', source, via: conditional.via };
    const projected = resolver().project(evidence([conditional, plain], { conditionalWrites: [condition] }), facts(), OPEN, ['tusers']);
    expect(projected.writeSet).toEqual([
      { unit: 'identity.credential', legacyTable: 'tusers', op: 'update', via: SESSION_LOOKUP, source, condition: null, override: null },
    ]);
    const only = resolver().project(evidence([conditional], { conditionalWrites: [condition] }), facts(), OPEN, ['tusers']);
    expect(only.writeSet).toEqual([
      {
        unit: 'identity.credential',
        legacyTable: 'tusers',
        op: 'update',
        via: conditional.via,
        source,
        condition: 'len(rsUser.password) eq 32',
        override: `${WRITER_OVERRIDES_REF}#wov:legacy-hash-upgrade`,
      },
    ]);
  });

  it('deduplicates unresolved calls by call and source, naming the reviewed record whose span settles them', () => {
    const at = (line: number, via: string[]): UnresolvedRef => ({ expr: 'pluginManager.announceEvent', source: { path: UTILITY, lines: [line, line] }, via }) as UnresolvedRef;
    const projected = resolver().project(evidence([], { unresolved: [at(12, ['b.x']), at(12, ['a.x']), at(20, ['a.x'])] }), facts(), OPEN, []);
    expect(projected.unresolvedCalls).toEqual([
      { call: 'pluginManager.announceEvent', via: ['a.x'], source: { path: UTILITY, lines: [12, 12] }, override: `${WRITER_OVERRIDES_REF}#wov:settled-plugin-call` },
      { call: 'pluginManager.announceEvent', via: ['a.x'], source: { path: UTILITY, lines: [20, 20] }, override: null },
    ]);
  });

  it('gives a component the union of the units its writes reached in every recorded branch', () => {
    const units = resolver();
    units.project(evidence([write('tusers', ['password'], SESSION_LOOKUP)]), facts(), OPEN, ['tusers']);
    units.project(evidence([write('tusers', ['fname'], ['userDAO.update'])]), facts({ type: '2' }), OPEN, ['tusers']);
    expect(units.ownersOfComponent(DAO, ['tusers', 'tplugins'])).toEqual({ owners: ['identity', 'people'], decisionTables: ['tplugins'] });
    expect(units.ownersOfComponent('core/mura/other.cfc', ['tusers'])).toEqual({ owners: ['identity', 'people'], decisionTables: [] });
  });
});

describe('collapseConditionalWrites', () => {
  const guarded = (unit: string | null, legacyTable: string | null, via: string[], extra: Partial<InventoryConditionalWrite> = {}): InventoryConditionalWrite => ({
    kind: 'site-load',
    unit,
    legacyTable,
    op: 'insert',
    via,
    source: { path: DAO, lines: [3, 3] },
    guard: 'loads a missing site',
    ...extra,
  });

  it.each([
    [
      'single-unit table: keeps the unit and the first path',
      [guarded('content.page', 'tcontent', ['b.load']), guarded('content.page', 'tcontent', ['a.load'])],
      [guarded('content.page', 'tcontent', ['a.load'])],
    ],
    [
      'split table: several units give a null unit',
      [guarded('people.person', 'tusers', ['b.load']), guarded('identity.user_account', 'tusers', ['a.load']), guarded('identity.credential', 'tusers', ['b.load'])],
      [guarded(null, 'tusers', ['a.load'])],
    ],
    [
      'decision-list table: keeps its legacy unit',
      [guarded('legacy:tplugins', 'tplugins', ['pluginManager.b']), guarded('legacy:tplugins', 'tplugins', ['pluginManager.a'])],
      [guarded('legacy:tplugins', 'tplugins', ['pluginManager.a'])],
    ],
    [
      'file-store: keeps the file-store unit',
      [guarded('file-store', null, ['fileManager.purge'], { op: 'delete' }), guarded('file-store', null, ['fileManager.delete'], { op: 'delete' })],
      [guarded('file-store', null, ['fileManager.delete'], { op: 'delete' })],
    ],
    [
      'distinct kind, op or source: stays apart, ordered by unit',
      [
        guarded('content.page', 'tcontent', ['a.load'], { kind: 'trash-restore' }),
        guarded('content.page', 'tcontent', ['a.load'], { op: 'delete' }),
        guarded('content.page', 'tcontent', ['a.load'], { source: { path: DAO, lines: [9, 9] } }),
        guarded('content.file', 'tfiles', ['a.load']),
      ],
      [
        guarded('content.file', 'tfiles', ['a.load']),
        guarded('content.page', 'tcontent', ['a.load'], { op: 'delete' }),
        guarded('content.page', 'tcontent', ['a.load'], { kind: 'trash-restore' }),
        guarded('content.page', 'tcontent', ['a.load'], { source: { path: DAO, lines: [9, 9] } }),
      ],
    ],
  ])('%s', (_name, records, expected) => {
    expect(collapseConditionalWrites(records)).toEqual(expected);
    expect(collapseConditionalWrites([...records].reverse())).toEqual(expected);
  });
});

describe('tusersReadTypes', () => {
  it.each([
    ['a tusers read filtering on one Type', LOOKUP_SQL, ['2']],
    ['a tusers read filtering on two Types', "SELECT * FROM tusers WHERE (Type = 1 OR tusers.Type = '2')", ['1', '2']],
    ['a read of another table', 'SELECT * FROM tcontent WHERE type = 2', []],
    ['a tusers read with no Type filter', 'SELECT * FROM tusers WHERE userid = :id', []],
  ])('reads %s', (_name, sql, types) => {
    expect(tusersReadTypes(`<cfquery name="rs">${sql}</cfquery>`)).toEqual(types);
  });
});

describe('UnitResolver.project trash-class targets', () => {
  const TRASH = 'core/mura/trash/trashManager.cfc';
  const tree = memorySourceTree({
    [TRASH]: [
      '<cfcomponent output="false">',
      '<cffunction name="throwIn" output="false">',
      '\t<cfquery>insert into ttrash (objectID,siteID) values (<cfqueryparam value="#arguments.deleted.getValue(idString)#" />, <cfqueryparam value="#siteid#" />)</cfquery>',
      '</cffunction>',
      '<cffunction name="empty" output="false">',
      '\t<cfloop query="rs"><cfquery>delete from ttrash where objectID=<cfqueryparam value="#rs.objectID#"></cfquery></cfloop>',
      '</cffunction>',
      '<cffunction name="deleteSite" output="false">',
      '\t<cfquery>delete from ttrash where siteid=<cfqueryparam value="#arguments.siteID#" /></cfquery>',
      '</cffunction>',
      '</cfcomponent>',
    ].join('\n'),
  });
  const trashTarget = (unit: string, owner: string) => ({ unit, owner, rowPredicate: `classMap owner = ${owner}` });
  const ownership = tableOwnershipSchema.parse({
    sourceSha: SHA,
    units: [
      { unit: 'identity.group_account', owner: 'identity' },
      { unit: 'people.person', owner: 'people' },
      { unit: 'content.file', owner: 'strategies-content' },
      { unit: 'content.trash', owner: 'strategies-content' },
      { unit: 'identity.trash', owner: 'identity' },
      { unit: 'people.trash', owner: 'people' },
      { unit: 'programs_sites.trash', owner: 'programs-sites' },
    ],
    tables: [
      {
        table: 'tusers',
        owner: 'split',
        ruleSteps: [1],
        targets: [
          { unit: 'identity.group_account', owner: 'identity', rowPredicate: 'Type = 1' },
          { unit: 'people.person', owner: 'people', rowPredicate: 'Type = 2' },
        ],
      },
      { table: 'tfiles', owner: 'strategies-content', ruleSteps: [1], targets: [{ unit: 'content.file', owner: 'strategies-content' }] },
      { table: 'temails', owner: 'legacy', ruleSteps: [], targets: [] },
      {
        table: 'ttrash',
        owner: 'split',
        ruleSteps: [1],
        primaryKey: ['objectID'],
        targets: [
          trashTarget('content.trash', 'strategies-content'),
          trashTarget('identity.trash', 'identity'),
          trashTarget('people.trash', 'people'),
          trashTarget('programs_sites.trash', 'programs-sites'),
        ],
      },
    ],
  });
  const trash = (op: string, line: number, method: string): ClosureWrite =>
    write('ttrash', null, [`trashManager.${method}`], { op: op as ClosureWrite['op'], component: TRASH, method, source: { path: TRASH, lines: [line, line] } });
  const throwIn = trash('insert', 3, 'throwIn');
  const users = write('tusers', null, ['userDAO.delete'], { op: 'delete' });
  const files = write('tfiles', null, ['fileDAO.deleteVersion']);
  const mails = write('temails', null, ['emailDAO.delete'], { op: 'delete' });
  const EVERY = ['content.trash', 'identity.trash', 'people.trash', 'programs_sites.trash'];

  it.each([
    ['a single-object write takes the owners a split co-write resolves to', [users, throwIn], facts({ type: '2' }), ['people.trash']],
    ['a single-object write takes the owner of a direct co-write', [files, throwIn], facts(), ['content.trash']],
    ['a single-object write no co-write selects keeps every target', [throwIn], facts(), EVERY],
    ['a single-object write of a co-written legacy-only entity takes no target', [mails, throwIn], facts(), ['legacy:ttrash']],
    ['a delete of each row of a looped query keeps every target', [files, trash('delete', 6, 'empty')], facts(), EVERY],
    ['a delete by siteid keeps every target', [files, trash('delete', 9, 'deleteSite')], facts(), EVERY],
    ['an owner held in stored data keeps every target', [files, throwIn], facts({}, true), EVERY],
  ])('%s', (_name, writes, branch, units) => {
    const resolver = new UnitResolver(ownership, OVERRIDES, new RowTypeLookups(tree, indexFor(tree)));
    const projected = resolver.project(evidence(writes), branch, OPEN, [...new Set(writes.map((w) => w.table ?? ''))]);
    expect(projected.writeSet.filter((w) => w.legacyTable === 'ttrash').map((w) => w.unit)).toEqual(units);
  });
});

describe('statementKeysOneRow', () => {
  it.each<[string, string, string, boolean | null]>([
    [
      'an insert keyed by an argument',
      `insert into ttrash (objectID,deletedBy) values (<cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.deleted.getValue(idString)#" />, <cfqueryparam value="#left($.currentUser('fullname'),50)#" />)`,
      'insert',
      true,
    ],
    [
      'an insert into a bracketed dbo table under conditional columns',
      `insert into [dbo].[ttrash] (siteID,<cfif hasDeleteID>deleteID,</cfif>objectID) values ('#arguments.siteid#',<cfif hasDeleteID>'x',</cfif><cfqueryparam value="#arguments.objectid#">)`,
      'insert',
      true,
    ],
    ['an insert from a looped query row', 'insert into ttrash (objectID,siteID) values (<cfqueryparam value="#rsttrash.objectID#">, <cfqueryparam value="#arguments.toSiteID#">)', 'insert', false],
    ['an insert from a select', 'insert into ttrash (objectID) select objectID from tarchive', 'insert', false],
    ['an insert naming no key column', 'insert into ttrash (siteID) values (<cfqueryparam value="#arguments.siteID#">)', 'insert', false],
    [
      'a delete keyed by an evaluated argument',
      `delete from ttrash where objectID=<cfqueryparam cfsqltype="cf_sql_varchar" value="#evaluate('arguments.restored.get#IDString#()')#" />`,
      'delete',
      true,
    ],
    ['a delete of a looped query row', 'delete from ttrash where objectID=<cfqueryparam value="#rs.objectID#">', 'delete', false],
    ['a delete by siteid', 'delete from ttrash where siteid = <cfqueryparam value="#arguments.siteID#"/>', 'delete', false],
    ['a delete without a where clause', 'delete from ttrash', 'delete', false],
    ['an update keyed by a qualified column', "update ttrash set orderno = 1 where ttrash.objectID = '#arguments.objectID#'", 'update', true],
    ['a statement of another table', 'delete from tcontent where contentID=<cfqueryparam value="#arguments.contentID#">', 'delete', null],
    ['an operation with no statement form', 'delete from ttrash where objectID = :id', 'save', null],
  ])('reads %s', (_name, sql, op, keyed) => {
    expect(statementKeysOneRow(`<cfquery>${sql}</cfquery>`, op, 'ttrash', ['objectid'])).toBe(keyed);
  });
});
