import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeClosure, extractSqlWrites, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { CfmlComponent, ClosureWrite, ComponentIndex, SourceTree, WriteClosure } from '../../src/inventory/closure.js';
import { loadWriterOverrides } from '../../src/inventory/overrides.js';
import type { SourceRef, Trigger, WriterOverrides } from '../../src/inventory/overrides.js';
import {
  BOOTSTRAP_DDL_PATH,
  DB_UPDATES_DIR,
  LIVE_TABLE_SOURCE,
  TABLE_SCOPE,
  assignOwners,
  attachWriters,
  extractTables,
  fetchLiveCatalog,
  loadTableOwnership,
  mergeLiveCatalog,
  tableKey,
} from '../../src/inventory/tables.js';
import type {
  LiveCatalogTable,
  TableEntry,
  TableExtraction,
  TableOwnership,
  WriteEvidence,
  WriterEntry,
} from '../../src/inventory/tables.js';
import { assertReadOnlySql } from '../../src/lib/mssql.js';
import type { ReadOnlyMssql } from '../../src/lib/mssql.js';

const DDL = BOOTSTRAP_DDL_PATH;
const UPDATE = `${DB_UPDATES_DIR}/9.9.cfm`;
const MANAGER = 'core/mura/fixture/fixtureManager.cfc';
const DAO = 'core/mura/fixture/fixtureDAO.cfc';
const FIXTURE_BEAN = 'core/mura/fixture/fixtureBean.cfc';
const ORM_BEAN = 'core/mura/fixture/fixtureOrmBean.cfc';
const CLEANUP = 'core/mura/fixture/fixtureCleanup.cfc';
const TRASH_READER = 'core/mura/trash/trashReader.cfc';
const PROC_UPDATE = `${DB_UPDATES_DIR}/9.9.1.cfm`;

/** Committed fixtures by their place in the temp archive tree. */
const COPIED: Readonly<Record<string, string>> = {
  [DDL]: 'cfml/mssql-excerpt.sql',
  [UPDATE]: 'cfml/dbupdate-excerpt.cfm',
  [MANAGER]: 'cfml/manager-writes.cfc',
  [DAO]: 'cfml/dao-writes.cfc',
};

/** ORM declarations: one maps the bootstrap table tfixture (as tredirects is mapped), one an ORM-only table. */
const ORM_FILES: Readonly<Record<string, string>> = {
  [FIXTURE_BEAN]: [
    'component extends="mura.bean.beanORM" table="tfixture" entityname="fixture" output="false" {',
    '\tproperty name="fixtureid" fieldtype="id";',
    '\tproperty name="ormOnlyColumn" datatype="varchar";',
    '}',
    '',
  ].join('\n'),
  [ORM_BEAN]: [
    'component extends="mura.bean.beanORM" table="tfixtureorm" entityname="fixtureOrm" output="false" {',
    '\tproperty name="fixtureormid" fieldtype="id";',
    '\tproperty name="site" fieldtype="many-to-one" cfc="site" fkcolumn="siteID";',
    '\tproperty name="label" datatype="varchar" length="50";',
    '}',
    '',
  ].join('\n'),
};

/** Second tree: a serialized-document table the plan names, a reader that deserializes it and stored procedures. */
const SERIALIZED_FILES: Readonly<Record<string, string>> = {
  [DDL]: [
    'CREATE TABLE [dbo].[ttrash] (',
    '\t[objectID] [char] (35) NOT NULL ,',
    '\t[siteID] [nvarchar] (25) NULL ,',
    '\t[objectString] [ntext] NULL',
    ') ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]',
    'GO',
    '',
    'CREATE PROCEDURE [dbo].[usp_fixture_purge] AS',
    'BEGIN',
    "\tDELETE FROM ttrash WHERE siteID = 'default'",
    'END',
    'GO',
    '',
  ].join('\r\n'),
  [PROC_UPDATE]: '<cfquery>\nCREATE PROCEDURE dbo.usp_fixture_refresh AS SELECT 1\n</cfquery>\n',
  [TRASH_READER]: [
    'component extends="mura.cfobject" output="false" {',
    '\tpublic boolean function restorable(required string objectid) {',
    '\t\tvar rs = queryExecute("SELECT objectString FROM ttrash WHERE objectid = :objectid", {objectid=arguments.objectid});',
    '\t\treturn isWDDX(rs.objectString);',
    '\t}',
    '}',
    '',
  ].join('\n'),
};

/** Hand-built writer whose statement no request value bounds. */
const CLEANUP_CFC = [
  'component extends="mura.cfobject" output="false" {',
  '\tpublic void function clear() {',
  '\t\tqueryExecute("DELETE FROM tfixturenopk");',
  '\t}',
  '}',
  '',
].join('\n');

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

function src(p: string, from: number, to: number = from): SourceRef {
  return { path: p, lines: [from, to] };
}

async function writeTree(root: string, copied: Readonly<Record<string, string>>, inline: Readonly<Record<string, string>>): Promise<SourceTree> {
  for (const [rel, fixture] of Object.entries(copied)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fixturePath(fixture), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(inline)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  return openSourceTree(root);
}

function byTable(tables: readonly TableEntry[], table: string): TableEntry {
  const found = tables.find((t) => t.table === table);
  if (found === undefined) throw new Error(`no table ${table}`);
  return found;
}

/** Minimal table entry for a table the fixture trees do not create. */
function handBuilt(table: string, siteIdColumn: string | null = null): TableEntry {
  const source = src(DDL, 1);
  return {
    id: `tbl:${table}`,
    table,
    schema: 'dbo',
    origin: 'bootstrap',
    source,
    createdBy: [{ dialect: 'mssql', path: DDL, lines: [1, 1] }],
    otherDialects: [],
    retired: false,
    droppedBy: null,
    columns: siteIdColumn === null ? [] : [{ name: siteIdColumn, type: 'nvarchar', length: 25, nullable: true, source }],
    hasSiteId: siteIdColumn !== null,
    siteIdColumn,
    siteIdSource: siteIdColumn === null ? null : source,
    hasPrimaryKey: true,
    staticHasPrimaryKey: true,
    bootstrapHasPrimaryKey: true,
    primaryKey: [],
    primaryKeySource: null,
    serializedColumns: [],
    ormEntity: null,
    owningService: null,
    ownershipRuleStep: [],
    targetUnits: [],
    split: null,
    decisionListRef: null,
    writers: [],
    live: null,
    liveStatus: 'pending-run',
  };
}

function writer(fields: Pick<WriterEntry, 'component' | 'method' | 'source' | 'op'> & Partial<WriterEntry>): WriterEntry {
  return { routeKeys: [], keyScope: [TABLE_SCOPE], trigger: 'request', sessionEffects: 'none', condition: null, override: null, ...fields };
}

function closureOf(writes: ClosureWrite[]): WriteClosure {
  const tables = [...new Set(writes.flatMap((w) => (w.table === null ? [] : [w.table])))].sort();
  return { tables, writes, conditionalWrites: [], fileStore: false, fileStoreEvidence: [], sessionEffects: 'none', threads: [], unresolved: [], overrides: [], visited: [] };
}

/** Component index over the temp tree with the fixture manager and DAO registered as beans. */
function fixtureIndex(source: SourceTree): ComponentIndex {
  const beans: Readonly<Record<string, string>> = { fixturedao: DAO, fixturemanager: MANAGER };
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => beans[name.toLowerCase()] ?? null,
    ormTable: (p) => (p === FIXTURE_BEAN ? 'tfixture' : p === ORM_BEAN ? 'tfixtureorm' : null),
    parsed(p) {
      if (!parsed.has(p)) parsed.set(p, p.endsWith('.cfc') && source.exists(p) ? parseCfmlComponent(p, source.readText(p)) : null);
      return parsed.get(p) ?? null;
    },
  };
}

let root = '';
let tree: SourceTree;
let extraction: TableExtraction;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-tables-'));
  tree = await writeTree(path.join(root, 'tree'), COPIED, ORM_FILES);
  extraction = extractTables(tree, ['tfixture', 'tfixtureorm']);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('extractTables', () => {
  it('copies the fixtures byte for byte, keeping the CRLF line endings of the bootstrap DDL', async () => {
    for (const [rel, fixture] of Object.entries(COPIED)) {
      expect(Buffer.compare(await readFile(path.join(root, 'tree', rel)), await readFile(fixturePath(fixture)))).toBe(0);
    }
    expect(tree.readText(DDL)).toContain(') ON [PRIMARY]\r\nGO\r\n');
  });

  it('records a bootstrap table with its DDL span, siteID column and the columns a schema update adds', () => {
    const t = byTable(extraction.tables, 'tfixture');
    expect(t).toMatchObject({
      id: 'tbl:tfixture',
      schema: 'dbo',
      origin: 'bootstrap',
      source: src(DDL, 2, 7),
      createdBy: [{ dialect: 'mssql', path: DDL, lines: [2, 2] }],
      hasSiteId: true,
      siteIdColumn: 'SiteID',
      siteIdSource: src(DDL, 4),
      retired: false,
    });
    expect(t.columns.map((c) => [c.name, c.type, c.length, c.source])).toEqual([
      ['fixtureID', 'char', 35, src(DDL, 3)],
      ['SiteID', 'nvarchar', 25, src(DDL, 4)],
      ['userID', 'char', 35, src(DDL, 5)],
      ['name', 'nvarchar', 100, src(DDL, 6)],
      ['notes', 'longtext', null, src(UPDATE, 12)],
      ['sortOrder', 'int', null, src(UPDATE, 13)],
    ]);
  });

  it('reads the primary key from the later ALTER TABLE in the same DDL file', () => {
    expect(byTable(extraction.tables, 'tfixture')).toMatchObject({
      hasPrimaryKey: true,
      staticHasPrimaryKey: true,
      bootstrapHasPrimaryKey: true,
      primaryKey: ['fixtureID'],
      primaryKeySource: null,
    });
    expect(byTable(extraction.tables, 'tfixturestats')).toMatchObject({ hasPrimaryKey: true, primaryKey: ['statID'] });
  });

  it('flags a table with neither a siteID column nor a primary key', () => {
    expect(byTable(extraction.tables, 'tfixturenopk')).toMatchObject({
      source: src(DDL, 10, 13),
      hasSiteId: false,
      siteIdColumn: null,
      hasPrimaryKey: false,
      bootstrapHasPrimaryKey: false,
      primaryKey: [],
    });
    expect(extraction.noPrimaryKeyBootstrap).toEqual(['tfixturenopk']);
    expect(extraction.noPrimaryKey).toEqual(['tfixturemigrated', 'tfixturenopk']);
  });

  it('matches a lower-case siteid column and computes no serialized column that nothing deserializes', () => {
    const stats = byTable(extraction.tables, 'tfixturestats');
    expect(stats).toMatchObject({ hasSiteId: true, siteIdColumn: 'siteid', serializedColumns: [] });
    expect(stats).not.toHaveProperty('expectedSerializedColumns');
    expect(extraction.corrections).toEqual([
      {
        measure: 'serializedColumns',
        expected: ['tcontentobjects.params', 'tformresponsepackets.Data', 'toauthtokens.data', 'ttrash.objectstring'],
        computed: [],
      },
    ]);
  });

  it('creates a table from a schema-update CREATE TABLE as a migration table', () => {
    const t = byTable(extraction.tables, 'tfixturemigrated');
    expect(t).toMatchObject({
      origin: 'migration',
      source: src(UPDATE, 3, 7),
      createdBy: [{ dialect: 'any', path: UPDATE, lines: [3, 3] }],
      hasSiteId: true,
      siteIdColumn: 'siteID',
      hasPrimaryKey: false,
      bootstrapHasPrimaryKey: null,
    });
    expect(t.columns.map((c) => c.name)).toEqual(['migratedID', 'siteID', 'label']);
  });

  it('creates an ORM-only table from its entity and keeps one bootstrap entry for a table an entity also maps', () => {
    expect(byTable(extraction.tables, 'tfixtureorm')).toMatchObject({
      origin: 'orm',
      source: src(ORM_BEAN, 1),
      createdBy: [{ dialect: 'orm', path: ORM_BEAN, lines: [1, 1] }],
      hasSiteId: true,
      siteIdColumn: 'siteID',
      hasPrimaryKey: true,
      primaryKey: ['fixtureormid'],
      ormEntity: { path: ORM_BEAN, entityName: 'fixtureOrm' },
    });
    const mapped = byTable(extraction.tables, 'tfixture');
    expect(mapped.origin).toBe('bootstrap');
    expect(mapped.ormEntity).toEqual({ path: FIXTURE_BEAN, entityName: 'fixture' });
    expect(mapped.columns.map((c) => c.name)).not.toContain('ormOnlyColumn');
    expect(extraction.tables.filter((t) => t.table === 'tfixture')).toHaveLength(1);
  });

  it('counts the tables by origin', () => {
    expect(extraction.counts).toEqual({
      bootstrap: 3,
      migration: 1,
      orm: 1,
      staticTotal: 5,
      retired: 0,
      liveStatic: 5,
      withSiteId: 4,
      withoutPrimaryKeyBootstrap: 1,
      withoutPrimaryKey: 2,
    });
  });

  it('sorts entries by id, unowned, writerless and pending a live run', () => {
    expect(extraction.tables.map((t) => t.id)).toEqual([
      'tbl:tfixture',
      'tbl:tfixturemigrated',
      'tbl:tfixturenopk',
      'tbl:tfixtureorm',
      'tbl:tfixturestats',
    ]);
    for (const t of extraction.tables) {
      expect(t).toMatchObject({ live: null, liveStatus: 'pending-run', owningService: null, ownershipRuleStep: [], writers: [] });
    }
  });

  it('throws for an ORM table no component declares', () => {
    expect(() => extractTables(tree, ['tfixturemissing'])).toThrow('ORM table tfixturemissing has no entity declaration under core/mura');
  });

  it('records a deserialized document column of a plan-named table and inventories no stored procedure', async () => {
    const second = await writeTree(path.join(root, 'serialized'), {}, SERIALIZED_FILES);
    const result = extractTables(second, []);
    expect(result.tables.map((t) => t.id)).toEqual(['tbl:ttrash']);
    const trash = byTable(result.tables, 'ttrash');
    expect(trash).toMatchObject({ source: src(DDL, 1, 5), hasSiteId: true, hasPrimaryKey: false, serializedColumns: ['objectString'] });
    expect(trash).not.toHaveProperty('expectedSerializedColumns');
    expect(result.corrections).toEqual([
      {
        measure: 'serializedColumns',
        expected: ['tcontentobjects.params', 'tformresponsepackets.Data', 'toauthtokens.data', 'ttrash.objectString'],
        computed: ['ttrash.objectString'],
      },
    ]);
  });

  it('keys table names case-insensitively without the dbo schema and folds program schemas', () => {
    expect(tableKey('dbo.TFixture')).toBe('tfixture');
    expect(tableKey('Program_2.Blackout')).toBe('program_n.blackout');
    expect(tableKey('synthetic.Survey')).toBe('synthetic.survey');
  });
});

describe('attachWriters', () => {
  let overrides: WriterOverrides;
  let evidence: WriteEvidence[];
  let tables: TableEntry[];
  let reloginClosure: WriteClosure;

  /** The cleanup DELETE as a closure write reached under `trigger`. */
  function cleanupWrite(trigger: Trigger): ClosureWrite {
    const comp = parseCfmlComponent(CLEANUP, CLEANUP_CFC);
    const fn = comp?.functions.find((f) => f.name === 'clear');
    if (comp === null || fn === undefined) throw new Error('cleanup fixture did not parse');
    const [w] = extractSqlWrites(fn, comp);
    if (w === undefined) throw new Error('cleanup fixture has no SQL write');
    return { table: w.table, op: w.op, component: CLEANUP, method: fn.name, source: src(CLEANUP, w.line, w.endLine), trigger, whereParams: w.whereParams, conditional: false };
  }

  beforeAll(async () => {
    overrides = await loadWriterOverrides(fixturePath('inventory/writer-overrides.valid.yaml'));
    const ctx = { tree, index: fixtureIndex(tree), overrides };
    const reached = (entryRouteKey: string, component: string, method: string): WriteEvidence => ({
      entryRouteKey,
      trigger: 'request',
      closure: computeClosure({ component, method }, ctx),
    });
    reloginClosure = computeClosure({ component: MANAGER, method: 'refreshLogin' }, ctx);
    evidence = [
      reached('admin:cfixture.rename', MANAGER, 'rename'),
      reached('admin:cfixture.purge', MANAGER, 'purgeSite'),
      reached('admin:cfixture.create', MANAGER, 'create'),
      reached('admin:cfixture.track', MANAGER, 'trackStats'),
      reached('admin:cfixture.members', DAO, 'deleteMembership'),
      { entryRouteKey: 'api:user.save', trigger: 'request', closure: reloginClosure },
      { entryRouteKey: 'admin:cfixture.clear', trigger: 'request', closure: closureOf([cleanupWrite('request')]) },
      { entryRouteKey: null, trigger: 'appstart', closure: closureOf([cleanupWrite('request'), cleanupWrite('scheduler')]) },
    ];
    tables = [...extraction.tables, handBuilt('tusers', 'SiteID')];
  });

  it('bounds each request writer by its WHERE parameters, or by the whole table when none bound it', () => {
    expect(byTable(attachWriters(tables, evidence, overrides).tables, 'tfixture').writers).toEqual([
      writer({ component: DAO, method: 'create', source: src(DAO, 7, 12), op: 'insert', routeKeys: ['admin:cfixture.create'] }),
      writer({ component: MANAGER, method: 'purgeSite', source: src(MANAGER, 9), op: 'delete', routeKeys: ['admin:cfixture.purge'], keyScope: ['siteid'] }),
      writer({ component: MANAGER, method: 'rename', source: src(MANAGER, 5), op: 'update', routeKeys: ['admin:cfixture.rename'], keyScope: ['userid'] }),
    ]);
  });

  it('takes the entry trigger for request writes and keeps a reached scheduler, appstart or thread trigger', () => {
    const result = attachWriters(tables, evidence, overrides).tables;
    const clear = { component: CLEANUP, method: 'clear', source: src(CLEANUP, 3), op: 'delete' } as const;
    expect(byTable(result, 'tfixturenopk').writers).toEqual([
      writer({ ...clear, trigger: 'appstart' }),
      writer({ ...clear, routeKeys: ['admin:cfixture.clear'] }),
      writer({ ...clear, trigger: 'scheduler' }),
    ]);
    expect(byTable(result, 'tfixturestats').writers).toEqual([
      writer({
        component: MANAGER,
        method: 'trackStats',
        source: src(MANAGER, 12, 16),
        op: 'insert',
        routeKeys: ['admin:cfixture.track'],
        keyScope: ['siteid'],
        trigger: 'thread',
        override: 'wov:fixture-thread',
      }),
      writer({ component: MANAGER, method: 'trackStats', source: src(MANAGER, 14), op: 'insert', routeKeys: ['admin:cfixture.track'], trigger: 'thread' }),
    ]);
  });

  it('records the re-login of the userBean.login() path through its reviewed override', () => {
    expect(reloginClosure.sessionEffects).toBe('relogin');
    const relogin = writer({
      component: MANAGER,
      method: 'refreshLogin',
      source: src(MANAGER, 18, 20),
      op: 'update',
      routeKeys: ['api:user.save'],
      keyScope: ['userid', 'siteid'],
      sessionEffects: 'relogin',
      override: 'wov:fixture-relogin',
    });
    expect(byTable(attachWriters(tables, evidence, overrides).tables, 'tusers').writers).toEqual([relogin]);
    expect(byTable(attachWriters(tables, [], overrides).tables, 'tusers').writers).toEqual([relogin]);
  });

  it('attaches an override no closure reaches to the table it names', () => {
    const result = attachWriters(tables, [], overrides).tables;
    expect(byTable(result, 'tfixturestats').writers).toEqual([
      writer({ component: MANAGER, method: 'trackStats', source: src(MANAGER, 12, 16), op: 'insert', keyScope: ['siteid'], trigger: 'thread', override: 'wov:fixture-thread' }),
    ]);
    expect(byTable(result, 'tfixture').writers).toEqual([]);
  });

  it('returns a write of a table without an inventory entry as unmatched', () => {
    const result = attachWriters(tables, evidence, overrides);
    expect(result.unmatched).toEqual([{ table: 'tfixturemembers', component: DAO, method: 'deleteMembership', source: src(DAO, 30), override: null }]);
    expect(result.tables.map((t) => t.table)).toEqual(tables.map((t) => t.table));
  });

  it('gives the same writers in the same order whatever order the evidence and overrides arrive in', () => {
    const shuffled = [...evidence].reverse().map((ev) => ({ ...ev, closure: { ...ev.closure, writes: [...ev.closure.writes].reverse() } }));
    const reversedOverrides = { ...overrides, writers: [...overrides.writers].reverse() };
    expect(attachWriters(tables, shuffled, reversedOverrides)).toEqual(attachWriters(tables, evidence, overrides));
  });
});

describe('table ownership', () => {
  let ownership: TableOwnership;

  beforeAll(async () => {
    ownership = await loadTableOwnership(fixturePath('inventory/mini-table-ownership.json'));
  });

  it('loads the pinned ownership fixture', () => {
    expect(ownership.tables.map((t) => t.table)).toEqual(['tplugins', 'tusers', 'tusersmemb']);
    expect(ownership.units.map((u) => u.unit)).toEqual(['identity.membership', 'identity.user_account', 'people.person']);
  });

  it('assigns each listed table its owner, rule steps, target units, split and decision reference', () => {
    const owned = assignOwners([handBuilt('tusers', 'SiteID'), handBuilt('tplugins'), handBuilt('tusersmemb')], ownership);
    expect(byTable(owned, 'tusers')).toMatchObject({
      owningService: 'split',
      ownershipRuleStep: [1],
      targetUnits: ['identity.user_account', 'people.person'],
      split: { by: 'Type+column', typeColumn: 'Type' },
      decisionListRef: null,
    });
    expect(byTable(owned, 'tplugins')).toMatchObject({
      owningService: 'decision-list',
      ownershipRuleStep: [5],
      targetUnits: [],
      split: null,
      decisionListRef: 'opt2/decision-list.json#tplugins',
    });
    expect(byTable(owned, 'tusersmemb')).toMatchObject({ owningService: 'identity', ownershipRuleStep: [2], targetUnits: ['identity.membership'] });
  });

  it('throws naming every table the ownership file leaves unassigned', () => {
    const tables = [byTable(extraction.tables, 'tfixturenopk'), handBuilt('tusers'), byTable(extraction.tables, 'tfixture')];
    expect(() => assignOwners(tables, ownership)).toThrow('table ownership assigns no owner to tfixture, tfixturenopk');
    expect(byTable(extraction.tables, 'tfixture').owningService).toBeNull();
  });
});

describe('fetchLiveCatalog and mergeLiveCatalog', () => {
  type Row = Record<string, unknown>;
  const column = (schema: string, table: string, name: string, type: string, length: number | null, nullable: 'YES' | 'NO', ordinal: number): Row => ({
    TABLE_SCHEMA: schema,
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: type,
    CHARACTER_MAXIMUM_LENGTH: length,
    IS_NULLABLE: nullable,
    ORDINAL_POSITION: ordinal,
  });
  const key = (table: string, name: string, ordinal: number): Row => ({ TABLE_SCHEMA: 'dbo', TABLE_NAME: table, COLUMN_NAME: name, ORDINAL_POSITION: ordinal });

  const rows = {
    tables: [
      ['dbo', 'tfixturestats'],
      ['dbo', 'tfixture'],
      ['dbo', 'fb_contact'],
      ['opt2_sync', 'projector_checkpoint'],
    ].map(([schema, name]) => ({ TABLE_SCHEMA: schema, TABLE_NAME: name })),
    columns: [
      column('dbo', 'tfixture', 'SiteID', 'NVARCHAR', 25, 'YES', 2),
      column('dbo', 'tfixture', 'fixtureID', 'char', 35, 'NO', 1),
      column('dbo', 'tfixture', 'userID', 'char', 35, 'YES', 3),
      column('dbo', 'tfixture', 'name', 'nvarchar', 100, 'YES', 4),
      column('dbo', 'tfixture', 'notes', 'nvarchar', -1, 'YES', 5),
      column('dbo', 'tfixture', 'sortOrder', 'int', null, 'YES', 6),
      column('dbo', 'tfixturestats', 'statID', 'char', 35, 'NO', 1),
      column('dbo', 'tfixturestats', 'siteid', 'nvarchar', 25, 'YES', 2),
      column('dbo', 'tfixturestats', 'data', 'ntext', 1073741823, 'YES', 3),
      column('dbo', 'fb_contact', 'contactID', 'char', 35, 'NO', 1),
      column('dbo', 'fb_contact', 'siteID', 'nvarchar', 25, 'YES', 2),
      column('opt2_sync', 'projector_checkpoint', 'owner', 'nvarchar', 100, 'NO', 1),
    ],
    keys: [key('tfixture', 'fixtureID', 1), key('fb_contact', 'contactID', 1)],
  };

  /** Fake read-only client answering the catalog queries; it refuses any statement the read-only guard refuses. */
  function catalogDb(answer: { tables: Row[]; columns: Row[]; keys: Row[] }, seen: string[]): ReadOnlyMssql {
    return {
      readOnlyQuery<T>(sql: string): Promise<T[]> {
        assertReadOnlySql(sql);
        seen.push(sql);
        if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) return Promise.resolve(answer.keys as T[]);
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return Promise.resolve(answer.columns as T[]);
        if (sql.includes('INFORMATION_SCHEMA.TABLES')) return Promise.resolve(answer.tables as T[]);
        return Promise.reject(new Error(`unexpected catalog query: ${sql}`));
      },
      close: () => Promise.resolve(),
    };
  }

  let seen: string[];
  let live: LiveCatalogTable[];
  let merged: TableEntry[];

  beforeAll(async () => {
    seen = [];
    live = await fetchLiveCatalog(catalogDb(rows, seen));
    merged = mergeLiveCatalog(extraction.tables, live);
  });

  it('reads the catalog with single read-only SELECT statements only', () => {
    expect(seen).toHaveLength(3);
    for (const sql of seen) {
      expect(() => assertReadOnlySql(sql)).not.toThrow();
      expect(sql).toMatch(/^\s*SELECT\b/i);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|EXEC|CREATE|ALTER|DROP|TRUNCATE)\b/i);
    }
  });

  it('reports each base table with its ordered columns, primary key and siteID flag, outside the coordination schema', () => {
    expect(live.map((t) => ({ table: `${t.schema}.${t.name}`, columns: t.columns.map((c) => c.name), pk: t.primaryKey, hasPrimaryKey: t.hasPrimaryKey, hasSiteId: t.hasSiteId }))).toEqual([
      { table: 'dbo.fb_contact', columns: ['contactID', 'siteID'], pk: ['contactID'], hasPrimaryKey: true, hasSiteId: true },
      { table: 'dbo.tfixture', columns: ['fixtureID', 'SiteID', 'userID', 'name', 'notes', 'sortOrder'], pk: ['fixtureID'], hasPrimaryKey: true, hasSiteId: true },
      { table: 'dbo.tfixturestats', columns: ['statID', 'siteid', 'data'], pk: [], hasPrimaryKey: false, hasSiteId: true },
    ]);
    const fixture = live.find((t) => t.name === 'tfixture');
    expect(fixture?.columns.find((c) => c.name === 'SiteID')).toEqual({ name: 'SiteID', type: 'nvarchar', length: 25, nullable: true });
    expect(fixture?.columns.find((c) => c.name === 'notes')?.length).toBe('max');
  });

  it('merges the live state into each static entry, letting the live key flag govern', () => {
    expect(byTable(merged, 'tfixture')).toMatchObject({
      liveStatus: 'live',
      hasPrimaryKey: true,
      live: {
        present: true,
        instances: ['dbo.tfixture'],
        columns: ['fixtureID', 'SiteID', 'userID', 'name', 'notes', 'sortOrder'],
        primaryKey: ['fixtureID'],
        hasPrimaryKey: true,
        hasSiteId: true,
      },
    });
    expect(byTable(merged, 'tfixturestats')).toMatchObject({ liveStatus: 'live', hasPrimaryKey: false, staticHasPrimaryKey: true });
    expect(byTable(merged, 'tfixtureorm')).toMatchObject({
      liveStatus: 'live',
      hasPrimaryKey: true,
      live: { present: false, instances: [], columns: [], primaryKey: [], hasPrimaryKey: null, hasSiteId: null },
    });
  });

  it('adds a form-builder table only the live catalog shows as a dynamic entry', () => {
    expect(byTable(merged, 'fb_contact')).toMatchObject({
      id: 'tbl:fb_contact',
      origin: 'dynamic',
      source: LIVE_TABLE_SOURCE,
      hasSiteId: true,
      siteIdColumn: 'siteID',
      hasPrimaryKey: true,
      staticHasPrimaryKey: null,
      primaryKey: ['contactID'],
      liveStatus: 'live',
      live: { present: true, instances: ['dbo.fb_contact'] },
    });
    expect(merged.map((t) => t.id)).toEqual([
      'tbl:fb_contact',
      'tbl:tfixture',
      'tbl:tfixturemigrated',
      'tbl:tfixturenopk',
      'tbl:tfixtureorm',
      'tbl:tfixturestats',
    ]);
  });

  it('resets to the static entries pending a live run when no catalog is available', () => {
    const reset = mergeLiveCatalog(merged, null);
    expect(reset.map((t) => t.id)).toEqual(extraction.tables.map((t) => t.id));
    for (const t of reset) expect(t).toMatchObject({ live: null, liveStatus: 'pending-run', hasPrimaryKey: t.staticHasPrimaryKey });
    expect(byTable(reset, 'tfixturestats').hasPrimaryKey).toBe(true);
  });

  it('rejects malformed catalog rows', async () => {
    const malformed = { ...rows, columns: [{ ...column('dbo', 'tfixture', 'fixtureID', 'char', 35, 'NO', 1), IS_NULLABLE: 'MAYBE' }] };
    await expect(fetchLiveCatalog(catalogDb(malformed, []))).rejects.toThrow('live catalog column rows are malformed');
  });
});
