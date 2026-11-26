import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '@opt2/platform/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSourceTree } from '../../src/inventory/closure.js';
import type { SourceTree } from '../../src/inventory/closure.js';
import { extractEntities, ormEntityIndex } from '../../src/inventory/entities.js';
import type { EntityEntry, EntityExtraction } from '../../src/inventory/entities.js';
import { extractDaoJoins, extractOrmRelations, extractRelations, fixtureRelations, tenantParentRelations } from '../../src/inventory/relations.js';
import type {
  Cardinality,
  FixtureOwnership,
  Orientation,
  ParentKeyBasis,
  Relation,
  RelationExtraction,
  RelationInputs,
  RelationSource,
} from '../../src/inventory/relations.js';
import { BOOTSTRAP_DDL_PATH, extractTables, mergeLiveCatalog, tableOwnershipSchema } from '../../src/inventory/tables.js';
import type { LiveCatalogTable, TableEntry } from '../../src/inventory/tables.js';
import { assertOutsideRepo } from '../../src/lib/paths.js';

const FIXTURE_BEAN = 'core/mura/fixture/fixtureBean.cfc';
const NOTE_BEAN = 'core/mura/fixture/fixtureNoteBean.cfc';
const REPLY_BEAN = 'core/mura/fixture/fixtureReplyBean.cfc';
const REPLY_BASE = 'core/mura/fixture/fixtureReplyBase.cfc';
const STATS_BEAN = 'core/mura/fixture/fixtureStatsBean.cfc';
const LOOP_BEAN = 'core/mura/fixture/fixtureLoopBean.cfc';
const DAO = 'core/mura/fixture/fixtureDAO.cfc';
const GATEWAY = 'core/mura/fixture/fixtureGateway.cfc';
const TRUNCATED_DAO = 'core/mura/fixture/fixtureTruncatedDAO.cfc';
const OWNERSHIP_FILE = 'opt2/table-ownership.json';
const PROGRAM_SITE_SQL = 'legacy-fixtures/sql/010_program_site.sql';
const ITEM_SQL = 'legacy-fixtures/sql/sample-module/010_item.sql';
const SAMPLE_MODULE_DIR = 'legacy-fixtures/sql/sample-module/';

/** Committed fixtures by their place in the on-disk archive tree. */
const COPIED: Readonly<Record<string, string>> = {
  [FIXTURE_BEAN]: 'cfml/entity-with-bom.cfc',
  [BOOTSTRAP_DDL_PATH]: 'cfml/mssql-excerpt.sql',
};

/** Inline components: relation properties of every kind, tag-syntax DAO joins, script SQL literals and a truncated query. */
const INLINE: Readonly<Record<string, string>> = {
  [NOTE_BEAN]: [
    'component extends="mura.bean.beanORM" table="tfixturenote" entityname="fixtureNote" {',
    '\tproperty name="noteid" fieldtype="id";',
    '\tproperty name="parentid" datatype="char" length="35";',
    '\tproperty name="fixture" fieldtype="many-to-one" cfc="fixture" fkcolumn="fixtureID";',
    '\tproperty name="author" fieldtype="many-to-one" cfc="user" fkcolumn="authorID" loadkey="userid";',
    '\tproperty name="content" fieldtype="one-to-one" cfc="content" fkcolumn="contentID";',
    '\tproperty name="replies" fieldtype="one-to-many" cfc="fixtureReply";',
    '\tproperty name="children" fieldtype="one-to-many" cfc="fixtureNote" nested="true";',
    '\tproperty name="stats" fieldtype="one-to-many" relatesto="fixtureStats" fkcolumn="noteid" loadkey="statnoteid";',
    '\tproperty name="self" fieldtype="many-to-one" cfc="fixtureNote";',
    '\tproperty name="ghost" fieldtype="many-to-one" cfc="nowhere" fkcolumn="ghostid";',
    '\tproperty name="draft" fieldtype="many-to-one" cfc="fixture" fkcolumn="draftid" persistent="false";',
    '\tproperty name="tags" fieldtype="many-to-many" cfc="fixture";',
    '\tproperty name="loose" fieldtype="many-to-one";',
    '}',
    '',
  ].join('\n'),
  [REPLY_BASE]: [
    'component extends="mura.bean.beanORM" output="false" {',
    '\tproperty name="creator" fieldtype="many-to-one" cfc="user" fkcolumn="createdByID";',
    '\tproperty name="note" fieldtype="many-to-one" cfc="fixture" fkcolumn="fixtureID";',
    '}',
    '',
  ].join('\n'),
  [REPLY_BEAN]: [
    '<cfcomponent extends="fixtureReplyBase" table="tfixturereply" entityname="fixtureReply" output="false">',
    '\t<cfproperty name="replyid" fieldtype="id">',
    '\t<cfproperty name="threadid" fieldtype="id">',
    '\t<cfproperty name="note" fieldtype="many-to-one" cfc="fixtureNote" fkcolumn="noteID">',
    '\t<cfproperty name="body" datatype="text">',
    '</cfcomponent>',
    '',
  ].join('\n'),
  [STATS_BEAN]: [
    'component extends="mura.bean.bean" table="tfixturestats" output="false" {',
    '\tproperty name="statID" type="string";',
    '\tproperty name="fixtureSite" fieldtype="many-to-one" cfc="fixture" fkcolumn="siteid" loadkey="siteid";',
    '\tproperty name="site" fieldtype="many-to-one" cfc="site";',
    '',
    '\tpublic any function init() {',
    "\t\tvariables.primaryKey = 'statID';",
    '\t\treturn this;',
    '\t}',
    '}',
    '',
  ].join('\n'),
  [LOOP_BEAN]: [
    'component extends="fixtureLoopBean" table="tfixturenopk" output="false" {',
    '\tproperty name="fixture" fieldtype="many-to-one" cfc="fixture";',
    '\tproperty name="peer" fieldtype="many-to-one" cfc="fixtureLoopBean" fkcolumn="label" loadkey="primaryKey";',
    '}',
    '',
  ].join('\n'),
  [DAO]: [
    '<cfcomponent extends="mura.cfobject" output="false">',
    '',
    '<cffunction name="readBySite" output="false">',
    '\t<cfargument name="siteid" type="string" required="true">',
    '\t<cfset var rs = "">',
    '\t<cfquery name="rs">',
    '\t\tSELECT f.name, s.data, n.noteid',
    '\t\tFROM [dbo].[tfixture] AS f',
    '\t\tINNER JOIN dbo.tfixturestats s WITH (NOLOCK) ON s.siteid = f.SiteID',
    '\t\tLEFT JOIN tfixturenote n (nolock) ON n.fixtureid = f.fixtureID',
    '\t\tLEFT JOIN tfixturearchive a ON a.fixtureid = f.fixtureID',
    '\t\tWHERE f.siteid = <cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.siteid#">',
    "\t\t<cfif len(arguments.siteid)>AND f.name <> 'n.parentid = f.fixtureID'</cfif>",
    '\t\tAND s.data <> \'#trim("n.noteid = f.SiteID")#\'',
    '\t\t-- AND n.parentid = s.statID',
    '\t\t/* AND n.noteid = s.statID */',
    '\t</cfquery>',
    '\t<cfreturn rs>',
    '</cffunction>',
    '',
    '<!---',
    '<cffunction name="readReplies" output="false">',
    '\t<cfquery name="rs">',
    '\t\tSELECT r.body FROM tfixture f INNER JOIN tfixturereply r ON r.noteid = f.fixtureID',
    '\t</cfquery>',
    '</cffunction>',
    '--->',
    '',
    '<cffunction name="readOrphans" output="false">',
    '\t<cfquery name="rs">',
    '\t\tSELECT p.label',
    '\t\tFROM tfixture f, tfixturenopk p, (SELECT statID, siteid FROM tfixturestats WHERE siteid IS NOT NULL) d',
    '\t\tWHERE p.fixtureID = f.fixtureID',
    '\t\tAND d.siteid = p.label',
    '\t\tAND tfixturenote.parentid = tfixturereply.threadid',
    '\t\tAND #variables.prefix#tfixturenopk.label = f.name',
    '\t</cfquery>',
    '</cffunction>',
    '',
    '<cffunction name="readAmbiguous" output="false">',
    '\t<cfquery name="rs">',
    '\t\tSELECT x.name FROM tfixture x JOIN tfixturenote x ON x.fixtureID = x.noteid',
    '\t</cfquery>',
    '</cffunction>',
    '</cfcomponent>',
    '',
  ].join('\n'),
  [GATEWAY]: [
    'component extends="mura.cfobject" output="false" {',
    '\tpublic query function bySite(required string siteid) {',
    '\t\t// queryExecute("SELECT r.body FROM tfixture f JOIN tfixturereply r ON r.noteid = f.fixtureID")',
    "\t\tvar rs = queryExecute(\"SELECT f.fixtureID FROM tfixture f JOIN tfixturestats s ON s.statID = f.fixtureID WHERE f.name <> 'it''s ##1'\", {});",
    "\t\tvar q = new Query(sql = 'SELECT n.noteid FROM tfixturenote n INNER JOIN tfixture f ON f.fixtureID = n.fixtureID AND f.fixtureID = f.fixtureID');",
    "\t\tq.setSql(\"SELECT r.replyid FROM tfixturereply r JOIN tfixturenote n ON n.parentid = r.threadid WHERE r.body = '#arguments.siteid#'\");",
    '\t\treturn rs;',
    '\t}',
    '}',
    '',
  ].join('\n'),
  [TRUNCATED_DAO]: [
    '<cfcomponent output="false">',
    '<cffunction name="truncated" output="false">',
    '\t<cfquery name="rs">',
    '\t\tSELECT p.label FROM tfixturestats s JOIN tfixturenopk p ON p.label = s.data',
    '\t\t/* AND p.fixtureID = s.statID',
  ].join('\n'),
};

function liveColumn(name: string): LiveCatalogTable['columns'][number] {
  return { name, type: 'nvarchar', length: 35, nullable: true };
}

function liveTable(schema: string, name: string, columns: string[], key: string, hasSiteId: boolean): LiveCatalogTable {
  return { schema, name, columns: columns.map(liveColumn), primaryKey: [key], hasPrimaryKey: true, hasSiteId };
}

/** Live-only tables: two domain-bean tables, both program schemas and the synthetic tables the fixtures keep. */
const LIVE: readonly LiveCatalogTable[] = [
  liveTable('dbo', 'tsettings', ['SiteID', 'Site'], 'SiteID', true),
  liveTable('dbo', 'tusers', ['UserID', 'SiteID'], 'UserID', true),
  ...['Program_1', 'Program_2'].flatMap((schema) => [
    liveTable(schema, 'item', ['item_id', 'person_id', 'siteID'], 'item_id', true),
    liveTable(schema, 'item_day', ['day_id', 'item_id', 'archive_id', 'hours'], 'day_id', false),
  ]),
  liveTable('synthetic', 'program_site', ['program_id', 'siteID'], 'program_id', true),
  liveTable('synthetic', 'sample', ['sample_id', 'siteID'], 'sample_id', true),
  liveTable('synthetic', 'sample_reminder', ['reminder_id', 'sample_id'], 'reminder_id', false),
];

function programTables(schema: string): FixtureOwnership['tables'] {
  return [
    {
      table: `${schema}.item`,
      owner: 'sample-module',
      primaryKey: ['item_id'],
      columns: ['item_id', 'person_id', 'siteID'],
      hasSiteId: true,
      source: { path: ITEM_SQL, lines: [3, 14] },
    },
    {
      table: `${schema}.item_day`,
      owner: 'sample-module',
      primaryKey: ['day_id'],
      columns: ['day_id', 'item_id', 'archive_id', 'hours'],
      hasSiteId: false,
      source: { path: SAMPLE_MODULE_DIR, lines: null },
    },
  ];
}

const PROGRAM_SITE = {
  table: 'synthetic.program_site',
  primaryKey: ['program_id'],
  columns: ['program_id', 'siteID'],
  hasSiteId: true,
  source: { path: PROGRAM_SITE_SQL, lines: null },
};

/** Ownership entries: both program schemas, the program-site map, and synthetic tables with stated and broken parents. */
const OWNERSHIP: FixtureOwnership = {
  tables: [
    { table: 'tfixture', owner: 'strategies-content', primaryKey: [''] },
    ...programTables('Program_1'),
    ...programTables('Program_2'),
    PROGRAM_SITE,
    { table: 'synthetic.person_archive', primaryKey: ['archive_id'], columns: ['archive_id', 'person_id', 'siteID'], hasSiteId: true },
    { table: 'synthetic.sample', primaryKey: ['sample_id'], columns: ['sample_id', 'siteID'], hasSiteId: true },
    {
      table: 'synthetic.sample_reminder',
      primaryKey: ['reminder_id'],
      columns: ['reminder_id', 'sample_id'],
      hasSiteId: false,
      tenantParent: { table: 'synthetic.sample', join: 'synthetic.sample.sample_id = synthetic.sample_reminder.sample_id' },
    },
    {
      table: 'synthetic.sample_target',
      primaryKey: ['target_id'],
      columns: ['target_id', 'siteID'],
      hasSiteId: null,
      tenantParent: { table: 'synthetic.sample', join: 'synthetic.sample_target.sample_ref = synthetic.sample.sample_id' },
    },
    { table: 'synthetic.rollup', primaryKey: ['period', 'state'], columns: ['period', 'state', 'day_id', 'sample_id'] },
    {
      table: 'synthetic.unparented',
      columns: ['note_id'],
      tenantParent: { table: 'synthetic.missing', join: 'synthetic.unparented.note_id = synthetic.missing.note_id' },
    },
    {
      table: 'synthetic.misjoined',
      columns: ['note_id'],
      tenantParent: { table: 'synthetic.sample', join: 'synthetic.other.sample_id = synthetic.sample.sample_id' },
    },
    { table: 'synthetic.unjoined', tenantParent: { table: 'synthetic.sample', join: 'sample_id' } },
  ],
};

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

/** 1-based line of the only occurrence of `needle` in `text`. */
function lineIn(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) throw new Error(`${JSON.stringify(needle)} is not unique`);
  return text.slice(0, at).split('\n').length;
}

function inline(rel: string): string {
  const text = INLINE[rel];
  if (text === undefined) throw new Error(`no inline file ${rel}`);
  return text;
}

function at(p: string, line: number): RelationSource {
  return { path: p, lines: [line, line] };
}

/** `table.column` as one edge side. */
function side(ref: string): { table: string; columns: string[] } {
  const dot = ref.lastIndexOf('.');
  return { table: ref.slice(0, dot), columns: [ref.slice(dot + 1)] };
}

function ormFk(
  id: string,
  child: string,
  parent: string,
  source: RelationSource,
  cfc: string,
  cardinality: Cardinality,
  parentKey: Relation['parentKey'],
  tenantDerivation: boolean,
): Relation {
  return { id, kind: 'orm-fk', child: side(child), parent: side(parent), source, cfc, cardinality, orientation: 'declared', parentKey, tenantDerivation };
}

function daoJoin(
  id: string,
  child: string,
  parent: string,
  source: RelationSource,
  orientation: Orientation,
  basis: ParentKeyBasis,
  tenantDerivation: boolean,
): Relation {
  return {
    id,
    kind: 'dao-join',
    child: side(child),
    parent: side(parent),
    source,
    cfc: null,
    cardinality: null,
    orientation,
    parentKey: { basis, component: null },
    tenantDerivation,
  };
}

function fixtureFk(id: string, child: string, parent: string, source: RelationSource, tenantDerivation: boolean): Relation {
  return {
    id,
    kind: 'fixture-fk',
    child: side(child),
    parent: side(parent),
    source,
    cfc: null,
    cardinality: null,
    orientation: 'declared',
    parentKey: { basis: 'ownership', component: null },
    tenantDerivation,
  };
}

function programFold(id: string, childTable: string): Relation {
  return {
    id,
    kind: 'program-fold',
    child: { table: childTable, columns: null },
    parent: side('synthetic.program_site.program_id'),
    source: { path: PROGRAM_SITE_SQL, lines: [1, 1] },
    cfc: null,
    cardinality: null,
    orientation: 'declared',
    parentKey: { basis: 'ownership', component: null },
    tenantDerivation: true,
  };
}

function ids(relations: readonly Relation[]): string[] {
  return relations.map((r) => r.id);
}

function byRelationId(relations: readonly Relation[], id: string): Relation {
  const found = relations.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no relation ${id}`);
  return found;
}

function entityById(entities: readonly EntityEntry[], id: string): EntityEntry {
  const found = entities.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no entity ${id}`);
  return found;
}

let root = '';
let tree: SourceTree;
let fixtureBeanText = '';
let extraction: EntityExtraction;
let tables: TableEntry[];
let inputs: RelationInputs;
let union: RelationExtraction;

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-relations-gate-'));
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fixturePath(name), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  fixtureBeanText = await readFile(fixturePath('cfml/entity-with-bom.cfc'), 'utf8');
  tree = openSourceTree(root);
  extraction = extractEntities(tree);
  tables = mergeLiveCatalog(extractTables(tree, extraction.ormTables).tables, LIVE);
  inputs = { entities: extraction.entities, tables, tree, ownership: OWNERSHIP };
  union = extractRelations(inputs);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the relation fixture tree', () => {
  it('holds byte-exact fixture copies and classifies the inline components as the relation extractors expect', async () => {
    expect(await readFile(path.join(root, FIXTURE_BEAN))).toEqual(await readFile(fixturePath('cfml/entity-with-bom.cfc')));
    expect(await readFile(path.join(root, BOOTSTRAP_DDL_PATH))).toEqual(await readFile(fixturePath('cfml/mssql-excerpt.sql')));
    expect(extraction.entities.map((e) => [e.id, e.class, e.table])).toEqual([
      ['ent:fixtureBean', 'orm-concrete', 'tfixture'],
      ['ent:fixtureLoopBean', 'domain-bean', 'tfixturenopk'],
      ['ent:fixtureNoteBean', 'orm-concrete', 'tfixturenote'],
      ['ent:fixtureReplyBase', 'orm-base', null],
      ['ent:fixtureReplyBean', 'orm-concrete', 'tfixturereply'],
      ['ent:fixtureStatsBean', 'domain-bean', 'tfixturestats'],
    ]);
    expect(tables.map((t) => [t.table, t.primaryKey, t.hasSiteId])).toEqual([
      ['Program_N.item', ['item_id'], true],
      ['Program_N.item_day', ['day_id'], false],
      ['synthetic.program_site', ['program_id'], true],
      ['synthetic.sample', ['sample_id'], true],
      ['synthetic.sample_reminder', ['reminder_id'], false],
      ['tfixture', ['fixtureID'], true],
      ['tfixturenopk', [], false],
      ['tfixturenote', ['noteid'], false],
      ['tfixturereply', ['replyid'], false],
      ['tfixturestats', ['statID'], true],
      ['tsettings', ['SiteID'], true],
      ['tusers', ['UserID'], true],
    ]);
  });
});

describe('extractOrmRelations', () => {
  const noteLine = (needle: string): number => lineIn(inline(NOTE_BEAN), needle);

  it('records each relation property with its cardinality, declared orientation, parent-key basis and tenant derivation', () => {
    expect(extractOrmRelations(extraction.entities, tree, extraction.ormIndex, tables)).toEqual([
      ormFk(
        'rel:tfixture.siteid->tsettings.siteid',
        'tfixture.SiteID',
        'tsettings.SiteID',
        at(FIXTURE_BEAN, lineIn(fixtureBeanText, 'name="site"')),
        'site',
        'many-to-one',
        { basis: 'fkcolumn', component: null },
        false,
      ),
      ormFk(
        'rel:tfixturenote.authorid->tusers.userid',
        'tfixturenote.authorID',
        'tusers.UserID',
        at(NOTE_BEAN, noteLine('name="author"')),
        'user',
        'many-to-one',
        { basis: 'loadkey', component: null },
        true,
      ),
      ormFk(
        'rel:tfixturenote.contentid->tcontent.contentid',
        'tfixturenote.contentID',
        'tcontent.ContentID',
        at(NOTE_BEAN, noteLine('name="content"')),
        'content',
        'one-to-one',
        { basis: 'domain-bean', component: null },
        true,
      ),
      ormFk(
        'rel:tfixturenote.fixtureid->tfixture.fixtureid',
        'tfixturenote.fixtureID',
        'tfixture.fixtureID',
        at(NOTE_BEAN, noteLine('name="fixture"')),
        'fixture',
        'many-to-one',
        { basis: 'fkcolumn', component: FIXTURE_BEAN },
        true,
      ),
      ormFk(
        'rel:tfixturenote.parentid->tfixturenote.noteid',
        'tfixturenote.parentid',
        'tfixturenote.noteid',
        at(NOTE_BEAN, noteLine('name="children"')),
        'fixtureNote',
        'one-to-many',
        { basis: 'entity-key', component: NOTE_BEAN },
        true,
      ),
      ormFk(
        'rel:tfixturereply.createdbyid->tusers.userid',
        'tfixturereply.createdByID',
        'tusers.UserID',
        at(REPLY_BASE, lineIn(inline(REPLY_BASE), 'name="creator"')),
        'user',
        'many-to-one',
        { basis: 'domain-bean', component: null },
        true,
      ),
      ormFk(
        'rel:tfixturereply.noteid->tfixturenote.noteid',
        'tfixturereply.noteID',
        'tfixturenote.noteid',
        at(NOTE_BEAN, noteLine('name="replies"')),
        'fixtureReply',
        'one-to-many',
        { basis: 'entity-key', component: NOTE_BEAN },
        true,
      ),
      ormFk(
        'rel:tfixturestats.noteid->tfixturenote.noteid',
        'tfixturestats.noteid',
        'tfixturenote.noteid',
        at(NOTE_BEAN, noteLine('name="stats"')),
        'fixtureStats',
        'one-to-many',
        { basis: 'fkcolumn', component: NOTE_BEAN },
        false,
      ),
      ormFk(
        'rel:tfixturestats.siteid->tfixture.siteid',
        'tfixturestats.siteid',
        'tfixture.SiteID',
        at(STATS_BEAN, lineIn(inline(STATS_BEAN), 'name="fixtureSite"')),
        'fixture',
        'many-to-one',
        { basis: 'loadkey', component: FIXTURE_BEAN },
        false,
      ),
      ormFk(
        'rel:tfixturestats.statid->tsettings.siteid',
        'tfixturestats.statID',
        'tsettings.SiteID',
        at(STATS_BEAN, lineIn(inline(STATS_BEAN), 'name="site"')),
        'site',
        'many-to-one',
        { basis: 'domain-bean', component: null },
        false,
      ),
    ]);
  });

  it('keeps the lowest source of an edge two properties declare, and an inherited property only where no nearer one shadows it', () => {
    const relations = extractOrmRelations(extraction.entities, tree, extraction.ormIndex, tables);
    expect(byRelationId(relations, 'rel:tfixturereply.noteid->tfixturenote.noteid')).toMatchObject({
      source: at(NOTE_BEAN, noteLine('name="replies"')),
      cardinality: 'one-to-many',
      parentKey: { basis: 'entity-key', component: NOTE_BEAN },
    });
    expect(ids(relations)).not.toContain('rel:tfixturereply.fixtureid->tfixture.fixtureid');
  });

  it.each<[string, string]>([
    ['an unresolvable cfc', 'rel:tfixturenote.ghostid->'],
    ['a non-persistent property', 'rel:tfixturenote.draftid->'],
    ['a many-to-many property', 'rel:tfixturenote.noteid->tfixture.'],
    ['a relation without a cfc', 'rel:tfixturenote.loose->'],
    ['a self relation naming the same column on both sides', 'rel:tfixturenote.noteid->tfixturenote.noteid'],
    ['a keyless entity whose fkcolumn defaults to its key or whose load key is the related key', 'rel:tfixturenopk.'],
  ])('records no edge for %s', (_label, prefix) => {
    const relations = extractOrmRelations(extraction.entities, tree, extraction.ormIndex, tables);
    expect(ids(relations).filter((id) => id.startsWith(prefix))).toEqual([]);
  });

  it('defaults the index and, without tables, takes columns as written and has() from declared properties only', () => {
    expect(
      extractOrmRelations(extraction.entities, tree).map((r) => [r.id, r.child.columns, r.parent.columns, r.parentKey.basis, r.tenantDerivation]),
    ).toEqual([
      ['rel:tfixture.siteid->tsettings.siteid', ['siteid'], ['SiteID'], 'domain-bean', false],
      ['rel:tfixturenote.authorid->tusers.userid', ['authorID'], ['UserID'], 'domain-bean', false],
      ['rel:tfixturenote.contentid->tcontent.contentid', ['contentID'], ['ContentID'], 'domain-bean', false],
      ['rel:tfixturenote.fixtureid->tfixture.fixtureid', ['fixtureID'], ['fixtureID'], 'fkcolumn', false],
      ['rel:tfixturenote.parentid->tfixturenote.noteid', ['parentid'], ['noteid'], 'entity-key', false],
      ['rel:tfixturereply.createdbyid->tusers.userid', ['createdByID'], ['UserID'], 'domain-bean', false],
      ['rel:tfixturereply.noteid->tfixturenote.noteid', ['noteid'], ['noteid'], 'entity-key', false],
      ['rel:tfixturestats.noteid->tfixturenote.noteid', ['noteid'], ['noteid'], 'fkcolumn', false],
      ['rel:tfixturestats.siteid->tfixture.fixtureid', ['siteid'], ['fixtureid'], 'entity-key', false],
      ['rel:tfixturestats.statid->tsettings.siteid', ['statID'], ['SiteID'], 'domain-bean', false],
    ]);
  });

  it('resolves a cfc through the given name index before registered names, file stems and the domain-bean map', () => {
    const index = ormEntityIndex(extraction.entities);
    index.byEntityName.set('fixture', REPLY_BEAN);
    const relations = extractOrmRelations(extraction.entities, tree, index, tables);
    expect(byRelationId(relations, 'rel:tfixturenote.fixtureid->tfixturereply.threadid')).toMatchObject({
      parent: { table: 'tfixturereply', columns: ['threadid'] },
      parentKey: { basis: 'entity-key', component: REPLY_BEAN },
    });
    expect(ids(relations)).toContain('rel:tfixturestats.siteid->tfixturereply.threadid');
    expect(ids(relations)).not.toContain('rel:tfixturenote.fixtureid->tfixture.fixtureid');
  });

  it('lets a tree entity registered as a domain-bean name win over the built-in map, keyed by its table when its file is absent', () => {
    const userBean: EntityEntry = {
      ...entityById(extraction.entities, 'ent:fixtureBean'),
      id: 'ent:userBean',
      component: 'mura.user.userBean',
      table: 'tusers',
      entityname: null,
      registeredName: 'user',
      source: { path: 'core/mura/user/userBean.cfc', lines: [1, 1] },
    };
    const relations = extractOrmRelations([...extraction.entities, userBean], tree, undefined, tables);
    expect(byRelationId(relations, 'rel:tfixturenote.authorid->tusers.userid').parentKey).toEqual({
      basis: 'loadkey',
      component: 'core/mura/user/userBean.cfc',
    });
    expect(byRelationId(relations, 'rel:tfixturereply.createdbyid->tusers.userid').parentKey).toEqual({
      basis: 'entity-key',
      component: 'core/mura/user/userBean.cfc',
    });
  });
});

describe('extractDaoJoins', () => {
  const daoLine = (needle: string): number => lineIn(inline(DAO), needle);

  it('records join predicates of inventoried tables, oriented to the key side with the lowest path and line of each edge', () => {
    expect(extractDaoJoins(tree, tables, extraction.entities)).toEqual([
      daoJoin(
        'rel:tfixture.fixtureid->tfixturestats.statid',
        'tfixture.fixtureID',
        'tfixturestats.statID',
        at(GATEWAY, lineIn(inline(GATEWAY), 's.statID = f.fixtureID')),
        'unknown',
        'join',
        false,
      ),
      daoJoin(
        'rel:tfixture.siteid->tfixturestats.siteid',
        'tfixture.SiteID',
        'tfixturestats.siteid',
        at(DAO, daoLine('s.siteid = f.SiteID')),
        'unknown',
        'join',
        false,
      ),
      daoJoin(
        'rel:tfixturenopk.fixtureid->tfixture.fixtureid',
        'tfixturenopk.fixtureID',
        'tfixture.fixtureID',
        at(DAO, daoLine('p.fixtureID = f.fixtureID')),
        'primary-key',
        'table-key',
        true,
      ),
      daoJoin(
        'rel:tfixturenopk.label->tfixturestats.data',
        'tfixturenopk.label',
        'tfixturestats.data',
        at(TRUNCATED_DAO, lineIn(inline(TRUNCATED_DAO), 'p.label = s.data')),
        'unknown',
        'join',
        false,
      ),
      daoJoin(
        'rel:tfixturenote.fixtureid->tfixture.fixtureid',
        'tfixturenote.fixtureID',
        'tfixture.fixtureID',
        at(DAO, daoLine('n.fixtureid = f.fixtureID')),
        'primary-key',
        'table-key',
        true,
      ),
      daoJoin(
        'rel:tfixturenote.parentid->tfixturereply.threadid',
        'tfixturenote.parentid',
        'tfixturereply.threadid',
        at(DAO, daoLine('tfixturenote.parentid = tfixturereply.threadid')),
        'primary-key',
        'entity-key',
        true,
      ),
    ]);
  });

  it('orients by table sole keys alone when no entities are given', () => {
    const joins = extractDaoJoins(tree, tables);
    expect(byRelationId(joins, 'rel:tfixturenote.parentid->tfixturereply.threadid')).toMatchObject({
      orientation: 'unknown',
      parentKey: { basis: 'join', component: null },
      tenantDerivation: false,
    });
    expect(ids(joins)).toEqual(ids(extractDaoJoins(tree, tables, extraction.entities)));
  });

  it.each<[string, string]>([
    ['in a CFML or script comment', 'rel:tfixturereply.noteid->tfixture.fixtureid'],
    ['in a SQL line comment', 'rel:tfixturenote.parentid->tfixturestats.statid'],
    ['in a SQL block comment', 'rel:tfixturenote.noteid->tfixturestats.statid'],
    ['in an unterminated SQL block comment', 'rel:tfixturenopk.fixtureid->tfixturestats.statid'],
    ['in a SQL string literal', 'rel:tfixturenote.parentid->tfixture.fixtureid'],
    ['in a CFML expression', 'rel:tfixture.siteid->tfixturenote.noteid'],
    ['on a derived table', 'rel:tfixturenopk.label->tfixturestats.siteid'],
    ['on a dynamic table name', 'rel:tfixture.name->tfixturenopk.label'],
    ['on an alias bound to two tables', 'rel:tfixturenote.fixtureid->tfixturenote.noteid'],
    ['on an uninventoried table', 'rel:tfixturearchive.fixtureid->tfixture.fixtureid'],
    ['joining one column to itself', 'rel:tfixture.fixtureid->tfixture.fixtureid'],
  ])('ignores a join predicate %s', (_label, id) => {
    expect(ids(extractDaoJoins(tree, tables, extraction.entities))).not.toContain(id);
  });

  it.each<[string, string]>([
    [
      'an unterminated CFML tag',
      '<cfcomponent output="false">\n<cfquery name="rs">\nSELECT p.label FROM tfixturestats s JOIN tfixturenopk p ON p.label = s.data\n<cfif p.fixtureID = s.statID\n',
    ],
    [
      'an unterminated CFML expression',
      '<cfcomponent output="false">\n<cfquery name="rs">\nSELECT p.label FROM tfixturestats s JOIN tfixturenopk p ON p.label = s.data AND s.siteid = #arguments.siteid AND p.fixtureID = s.statID\n</cfquery>\n</cfcomponent>\n',
    ],
    [
      'an unterminated script string',
      'component output="false" {\n\tpublic query function run() {\n\t\treturn queryExecute("SELECT p.label FROM tfixturestats s JOIN tfixturenopk p ON p.label = s.data\n',
    ],
    [
      'an unbalanced derived table ending at FROM',
      '<cfcomponent output="false">\n<cfquery name="rs">\nSELECT p.label FROM tfixturestats s JOIN tfixturenopk p ON p.label = s.data JOIN (SELECT statID FROM\n</cfquery>\n</cfcomponent>\n',
    ],
    [
      'three-part names and a trailing SQL line comment',
      'component output="false" {\n\tpublic query function run() {\n\t\treturn queryExecute("SELECT p.label FROM dbo.tfixturestats JOIN [dbo].[tfixturenopk] p ON p.label = [dbo].[tfixturestats].[data] -- AND p.fixtureID = tfixturestats.statID");\n\t}\n}\n',
    ],
    [
      'a SQL literal escaped by doubled quotes in a single-quoted CFML string',
      "component output=\"false\" {\n\tpublic query function run() {\n\t\treturn queryExecute('SELECT p.label FROM tfixturestats s, tfixturenopk p WHERE s.data <> ''p.fixtureID = s.statID'' AND p.label = s.data');\n\t}\n}\n",
    ],
    [
      'doubled quotes in a double-quoted CFML string',
      'component output="false" {\n\tpublic query function run() {\n\t\treturn queryExecute("SELECT p.label FROM tfixturestats s JOIN tfixturenopk p ON p.label = s.data WHERE p.label <> ""x""");\n\t}\n}\n',
    ],
  ])('records only the stated join of a query with %s', async (label, text) => {
    const caseRoot = path.join(root, 'cases', label.replace(/\W+/g, '-'));
    await mkdir(path.join(caseRoot, path.dirname(TRUNCATED_DAO)), { recursive: true });
    await writeFile(path.join(caseRoot, TRUNCATED_DAO), text, 'utf8');
    expect(ids(extractDaoJoins(openSourceTree(caseRoot), tables))).toEqual(['rel:tfixturenopk.label->tfixturestats.data']);
  });

  it.each<[string, string, string]>([
    ['rel:tfixturenote.fixtureid->tfixture.fixtureid', 'n.fixtureid = f.fixtureID', 'f.fixtureID = n.fixtureID'],
    ['rel:tfixturenote.parentid->tfixturereply.threadid', 'tfixturenote.parentid = tfixturereply.threadid', 'n.parentid = r.threadid'],
  ])('keeps the earlier file of %s, which a script SQL literal repeats', (id, daoNeedle, gatewayNeedle) => {
    expect(() => lineIn(inline(GATEWAY), gatewayNeedle)).not.toThrow();
    expect(byRelationId(extractDaoJoins(tree, tables, extraction.entities), id).source).toEqual(at(DAO, daoLine(daoNeedle)));
  });

  /** DAO joins of one component holding `sql` as its only query, written under a fresh case root. */
  async function caseJoins(label: string, sql: string): Promise<Relation[]> {
    const caseRoot = path.join(root, 'semi-join-cases', label.replace(/\W+/g, '-'));
    await mkdir(path.join(caseRoot, path.dirname(TRUNCATED_DAO)), { recursive: true });
    await writeFile(path.join(caseRoot, TRUNCATED_DAO), `<cfcomponent output="false">\n<cfquery name="rs">\n${sql}\n</cfquery>\n</cfcomponent>\n`, 'utf8');
    return extractDaoJoins(openSourceTree(caseRoot), tables);
  }

  it.each<[string, string]>([
    ['qualified on both sides', 'SELECT p.label FROM tfixturenopk p WHERE p.fixtureID IN (SELECT f.fixtureID FROM tfixture f)'],
    ['unqualified on both sides, negated and distinct', "DELETE FROM tfixturenopk WHERE fixtureID NOT IN (SELECT DISTINCT fixtureID FROM tfixture WHERE name <> '')"],
    ['with the key side outside the subquery', 'SELECT name FROM tfixture WHERE tfixture.fixtureID in (select tfixturenopk.fixtureID from tfixturenopk)'],
  ])('records a semi-join %s, oriented to the key side at the line of its outer column', async (label, sql) => {
    expect(await caseJoins(label, sql)).toEqual([
      daoJoin('rel:tfixturenopk.fixtureid->tfixture.fixtureid', 'tfixturenopk.fixtureID', 'tfixture.fixtureID', at(TRUNCATED_DAO, 3), 'primary-key', 'table-key', true),
    ]);
  });

  it.each<[string, string]>([
    ['whose unqualified column two outer tables have', 'SELECT f.name FROM tfixture f, tfixturestats s WHERE siteid IN (SELECT SiteID FROM tsettings)'],
    ['whose unqualified column the subquery table lacks', 'SELECT p.label FROM tfixturenopk p WHERE p.fixtureID IN (SELECT label FROM tfixture)'],
    ['on a dynamic subquery table', 'SELECT p.label FROM tfixturenopk p WHERE fixtureID IN (SELECT fixtureID FROM #variables.table#)'],
  ])('ignores a semi-join %s', async (label, sql) => {
    expect(await caseJoins(label, sql)).toEqual([]);
  });
});

describe('fixtureRelations', () => {
  it('relates program tables within their own schema and to synthetic, and synthetic tables by stated parents and sole keys', () => {
    expect(fixtureRelations(OWNERSHIP)).toEqual([
      programFold('rel:program_1.item->synthetic.program_site.program_id', 'Program_1.item'),
      programFold('rel:program_1.item_day->synthetic.program_site.program_id', 'Program_1.item_day'),
      fixtureFk(
        'rel:program_1.item_day.archive_id->synthetic.person_archive.archive_id',
        'Program_1.item_day.archive_id',
        'synthetic.person_archive.archive_id',
        { path: SAMPLE_MODULE_DIR, lines: [1, 1] },
        true,
      ),
      fixtureFk(
        'rel:program_1.item_day.item_id->program_1.item.item_id',
        'Program_1.item_day.item_id',
        'Program_1.item.item_id',
        { path: SAMPLE_MODULE_DIR, lines: [1, 1] },
        true,
      ),
      programFold('rel:program_2.item->synthetic.program_site.program_id', 'Program_2.item'),
      programFold('rel:program_2.item_day->synthetic.program_site.program_id', 'Program_2.item_day'),
      fixtureFk(
        'rel:program_2.item_day.archive_id->synthetic.person_archive.archive_id',
        'Program_2.item_day.archive_id',
        'synthetic.person_archive.archive_id',
        { path: SAMPLE_MODULE_DIR, lines: [1, 1] },
        true,
      ),
      fixtureFk(
        'rel:program_2.item_day.item_id->program_2.item.item_id',
        'Program_2.item_day.item_id',
        'Program_2.item.item_id',
        { path: SAMPLE_MODULE_DIR, lines: [1, 1] },
        true,
      ),
      fixtureFk(
        'rel:synthetic.rollup.sample_id->synthetic.sample.sample_id',
        'synthetic.rollup.sample_id',
        'synthetic.sample.sample_id',
        { path: OWNERSHIP_FILE, lines: [1, 1] },
        false,
      ),
      fixtureFk(
        'rel:synthetic.sample_reminder.sample_id->synthetic.sample.sample_id',
        'synthetic.sample_reminder.sample_id',
        'synthetic.sample.sample_id',
        { path: OWNERSHIP_FILE, lines: [1, 1] },
        true,
      ),
      fixtureFk(
        'rel:synthetic.sample_target.sample_ref->synthetic.sample.sample_id',
        'synthetic.sample_target.sample_ref',
        'synthetic.sample.sample_id',
        { path: OWNERSHIP_FILE, lines: [1, 1] },
        false,
      ),
    ]);
  });

  it('keeps the stated source lines of the child entry', () => {
    const note = {
      table: 'Program_1.item_note',
      primaryKey: ['note_id'],
      columns: ['note_id', 'item_id'],
      source: { path: ITEM_SQL, lines: [20, 27] },
    };
    const relations = fixtureRelations({ tables: [...programTables('Program_1'), note] });
    expect(byRelationId(relations, 'rel:program_1.item_note.item_id->program_1.item.item_id')).toMatchObject({
      source: { path: ITEM_SQL, lines: [20, 27] },
      tenantDerivation: false,
    });
  });

  it('yields none for the committed ownership excerpt, whose tables are bootstrap and migration tables', async () => {
    const doc = tableOwnershipSchema.parse(JSON.parse(await readFile(fixturePath('inventory/mini-table-ownership.json'), 'utf8')));
    expect(doc.tables.map((t) => t.table)).toEqual(['tplugins', 'tusers', 'tusersmemb']);
    expect(fixtureRelations(doc)).toEqual([]);
  });

  it.each<[string, FixtureOwnership['tables'], boolean]>([
    ['a program-site entry with a sole key', [...programTables('Program_1'), PROGRAM_SITE], true],
    ['the Program_N spelling', [...programTables('Program_N'), PROGRAM_SITE], true],
    ['no program-site entry', programTables('Program_1'), false],
    ['a program-site entry with a composite key', [...programTables('Program_1'), { ...PROGRAM_SITE, primaryKey: ['program_id', 'siteID'] }], false],
    ['a program-site entry without a key', [...programTables('Program_1'), { table: 'synthetic.program_site', columns: ['program_id'] }], false],
  ])('folds program tables into synthetic.program_site only for a stated sole key: %s', (_label, entries, folded) => {
    const folds = fixtureRelations({ tables: entries }).filter((r) => r.kind === 'program-fold');
    expect(folds.map((r) => r.child.table)).toEqual(folded ? entries.filter((e) => /^program_/i.test(e.table)).map((e) => e.table) : []);
    expect(folds.every((r) => r.child.columns === null && r.tenantDerivation)).toBe(true);
  });

  it.each<[string, FixtureOwnership['tables'][number]]>([
    ['an empty key column', { table: 'synthetic.bad', primaryKey: [''] }],
    ['a column list that is not an array', { table: 'synthetic.bad', columns: 'a,b' }],
    ['a site flag that is not a boolean', { table: 'Program_1.bad', hasSiteId: 'yes' }],
    ['a tenant parent without a join', { table: 'synthetic.bad', tenantParent: { table: 'synthetic.sample' } }],
    ['a source without a path', { table: 'synthetic.bad', source: { lines: [1, 2] } }],
    ['a source line below 1', { table: 'Program_2.bad', source: { path: ITEM_SQL, lines: [0, 2] } }],
  ])('rejects a fixture entry with %s', (_label, entry) => {
    expect(() => fixtureRelations({ tables: [entry] })).toThrow(z.ZodError);
  });

  it('validates fixture entries only, passing their unread fields through', () => {
    expect(fixtureRelations({ tables: [{ table: 'tusers', primaryKey: [''], hasSiteId: 'yes' }] })).toEqual([]);
    expect(fixtureRelations({ tables: [{ table: 'synthetic.extra', owner: 'people', targets: [{ unit: 'people.extra' }] }] })).toEqual([]);
  });
});

const NOPK_SOURCE: RelationSource = { path: BOOTSTRAP_DDL_PATH, lines: [10, 13] };

/** A Masa ownership entry without a site column whose tenant comes from `parent` through `join`. */
function tenantEntry(table: string, parent: string, join: string): FixtureOwnership['tables'][number] {
  return { table, hasSiteId: false, tenantParent: { table: parent, join }, source: NOPK_SOURCE };
}

describe('tenantParentRelations', () => {
  it('relates a Masa entry to its stated tenant parent, oriented as the file states it, at the entry source', () => {
    expect(tenantParentRelations({ tables: [tenantEntry('tfixturenopk', 'tfixture', 'tfixture.fixtureID = tfixturenopk.label')] })).toEqual([
      {
        id: 'rel:tfixturenopk.label->tfixture.fixtureid',
        kind: 'tenant-parent',
        child: side('tfixturenopk.label'),
        parent: side('tfixture.fixtureID'),
        source: NOPK_SOURCE,
        cfc: null,
        cardinality: null,
        orientation: 'declared',
        parentKey: { basis: 'ownership', component: null },
        tenantDerivation: true,
      },
    ]);
  });

  it.each<[string, FixtureOwnership['tables']]>([
    ['the fixture entries, which fixtureRelations relates', OWNERSHIP.tables],
    ['a join naming another table', [tenantEntry('tfixturenopk', 'tfixture', 'tother.fixtureID = tfixture.fixtureID')]],
    ['a join without two sides', [tenantEntry('tfixturenopk', 'tfixture', 'fixtureID')]],
  ])('yields none for %s', (_label, entries) => {
    expect(tenantParentRelations({ tables: entries })).toEqual([]);
  });

  it('rejects a Masa tenant parent without a join', () => {
    expect(() => tenantParentRelations({ tables: [{ table: 'tfixturenopk', tenantParent: { table: 'tfixture' } }] })).toThrow(z.ZodError);
  });
});

describe('extractRelations', () => {
  it('adds a stated tenant parent over an unoriented join of its columns, and keeps the code record of an oriented one', () => {
    const tenantParents = [
      tenantEntry('tfixturenopk', 'tusers', 'tfixturenopk.label = tusers.UserID'),
      tenantEntry('tfixture', 'tfixturestats', 'tfixture.fixtureID = tfixturestats.statID'),
      tenantEntry('tfixturenopk', 'tfixture', 'tfixturenopk.fixtureID = tfixture.fixtureID'),
    ];
    const result = extractRelations({ ...inputs, ownership: { tables: [...OWNERSHIP.tables, ...tenantParents] } });
    const coded = 'rel:tfixturenopk.fixtureid->tfixture.fixtureid';
    expect(byRelationId(result.relations, coded)).toEqual(byRelationId(union.relations, coded));
    expect(result.relations.filter((r) => r.kind === 'tenant-parent').map((r) => [r.id, r.tenantDerivation])).toEqual([
      ['rel:tfixture.fixtureid->tfixturestats.statid', false],
      ['rel:tfixturenopk.label->tusers.userid', true],
    ]);
    expect(ids(result.unoriented)).toEqual(ids(union.unoriented).filter((id) => id !== 'rel:tfixture.fixtureid->tfixturestats.statid'));
    expect(result.counts).toMatchObject({ relations: union.counts.relations + 2, tenantParent: 2, unknownOrientation: union.counts.unknownOrientation - 1 });
  });

  it('unites the three sources re-keyed to inventory table names, each list sorted by rel: id', () => {
    expect(ids(union.relations)).toEqual([
      'rel:program_n.item->synthetic.program_site.program_id',
      'rel:program_n.item_day->synthetic.program_site.program_id',
      'rel:program_n.item_day.item_id->program_n.item.item_id',
      'rel:synthetic.sample_reminder.sample_id->synthetic.sample.sample_id',
      'rel:tfixture.siteid->tsettings.siteid',
      'rel:tfixturenopk.fixtureid->tfixture.fixtureid',
      'rel:tfixturenote.authorid->tusers.userid',
      'rel:tfixturenote.fixtureid->tfixture.fixtureid',
      'rel:tfixturenote.parentid->tfixturenote.noteid',
      'rel:tfixturenote.parentid->tfixturereply.threadid',
      'rel:tfixturereply.createdbyid->tusers.userid',
      'rel:tfixturereply.noteid->tfixturenote.noteid',
      'rel:tfixturestats.noteid->tfixturenote.noteid',
      'rel:tfixturestats.siteid->tfixture.siteid',
      'rel:tfixturestats.statid->tsettings.siteid',
    ]);
    for (const list of [union.relations, union.unoriented]) {
      expect(ids(list).every((id) => id.startsWith('rel:'))).toBe(true);
      expect(ids(list)).toEqual([...ids(list)].sort());
      expect(new Set(ids(list)).size).toBe(list.length);
    }
  });

  it('folds the Program_1 and Program_2 edges into one Program_N edge whose id names the inventory tables', () => {
    expect(byRelationId(union.relations, 'rel:program_n.item_day.item_id->program_n.item.item_id')).toEqual(
      fixtureFk(
        'rel:program_n.item_day.item_id->program_n.item.item_id',
        'Program_N.item_day.item_id',
        'Program_N.item.item_id',
        { path: SAMPLE_MODULE_DIR, lines: [1, 1] },
        true,
      ),
    );
    expect(union.relations.filter((r) => r.kind === 'program-fold')).toEqual([
      programFold('rel:program_n.item->synthetic.program_site.program_id', 'Program_N.item'),
      programFold('rel:program_n.item_day->synthetic.program_site.program_id', 'Program_N.item_day'),
    ]);
    expect(union.relations.every((r) => r.id.startsWith(`rel:${r.child.table.toLowerCase()}`))).toBe(true);
  });

  it('prefers the ORM declaration over a DAO join of the same columns', () => {
    expect(byRelationId(union.relations, 'rel:tfixturenote.fixtureid->tfixture.fixtureid')).toMatchObject({
      kind: 'orm-fk',
      source: at(NOTE_BEAN, lineIn(inline(NOTE_BEAN), 'name="fixture"')),
      tenantDerivation: true,
    });
  });

  it('keeps unknown-orientation joins apart, except one whose columns an oriented edge already joins', () => {
    expect(ids(union.unoriented)).toEqual(['rel:tfixture.fixtureid->tfixturestats.statid', 'rel:tfixturenopk.label->tfixturestats.data']);
    expect(union.unoriented.every((r) => r.orientation === 'unknown' && r.parentKey.basis === 'join')).toBe(true);
    expect(ids(union.relations)).toContain('rel:tfixturestats.siteid->tfixture.siteid');
    expect([...ids(union.relations), ...ids(union.unoriented)]).not.toContain('rel:tfixture.siteid->tfixturestats.siteid');
  });

  it('drops and counts each edge that touches a table the inventory does not list', () => {
    expect(union.dropped).toEqual([
      'rel:program_1.item_day.archive_id->synthetic.person_archive.archive_id',
      'rel:program_2.item_day.archive_id->synthetic.person_archive.archive_id',
      'rel:synthetic.rollup.sample_id->synthetic.sample.sample_id',
      'rel:synthetic.sample_target.sample_ref->synthetic.sample.sample_id',
      'rel:tfixturenote.contentid->tcontent.contentid',
    ]);
    expect(union.counts).toEqual({
      relations: 15,
      ormFk: 9,
      daoJoin: 2,
      fixtureFk: 2,
      programFold: 2,
      tenantParent: 0,
      unknownOrientation: 2,
      relationsDropped: 5,
    });
  });

  it('derives tenancy from the inventory child table, and always for a program fold', () => {
    const derived = union.relations.filter((r) => r.tenantDerivation).map((r) => r.id);
    expect(derived).toEqual([
      'rel:program_n.item->synthetic.program_site.program_id',
      'rel:program_n.item_day->synthetic.program_site.program_id',
      'rel:program_n.item_day.item_id->program_n.item.item_id',
      'rel:synthetic.sample_reminder.sample_id->synthetic.sample.sample_id',
      'rel:tfixturenopk.fixtureid->tfixture.fixtureid',
      'rel:tfixturenote.authorid->tusers.userid',
      'rel:tfixturenote.fixtureid->tfixture.fixtureid',
      'rel:tfixturenote.parentid->tfixturenote.noteid',
      'rel:tfixturenote.parentid->tfixturereply.threadid',
      'rel:tfixturereply.createdbyid->tusers.userid',
      'rel:tfixturereply.noteid->tfixturenote.noteid',
    ]);
    expect(union.unoriented.some((r) => r.tenantDerivation)).toBe(false);
  });

  it('gives the same result for the same inputs in any order, with or without the ORM index', () => {
    expect(extractRelations(inputs)).toEqual(union);
    expect(
      extractRelations({
        entities: [...extraction.entities].reverse(),
        tables: [...tables].reverse(),
        tree,
        index: extraction.ormIndex,
        ownership: { tables: [...OWNERSHIP.tables].reverse() },
      }),
    ).toEqual(union);
  });

  it('records nothing for empty inputs', () => {
    expect(extractRelations({ entities: [], tables: [], tree, ownership: { tables: [] } })).toEqual({
      relations: [],
      unoriented: [],
      counts: { relations: 0, ormFk: 0, daoJoin: 0, fixtureFk: 0, programFold: 0, tenantParent: 0, unknownOrientation: 0, relationsDropped: 0 },
      dropped: [],
    });
  });
});
