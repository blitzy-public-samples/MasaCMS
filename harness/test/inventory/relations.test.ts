import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSourceTree } from '../../src/inventory/closure.js';
import type { SourceTree } from '../../src/inventory/closure.js';
import { extractEntities } from '../../src/inventory/entities.js';
import type { EntityExtraction } from '../../src/inventory/entities.js';
import { extractDaoJoins, extractOrmRelations, extractRelations, fixtureRelations } from '../../src/inventory/relations.js';
import type { FixtureOwnership, Relation, RelationExtraction, RelationInputs } from '../../src/inventory/relations.js';
import { extractTables, mergeLiveCatalog, tableOwnershipSchema } from '../../src/inventory/tables.js';
import type { LiveCatalogTable, TableEntry } from '../../src/inventory/tables.js';

const FIXTURE_BEAN = 'core/mura/fixture/fixtureBean.cfc';
const JOIN_DAO = 'core/mura/fixture/joinDAO.cfc';
const BOOTSTRAP_DDL = 'core/setup/db/mssql.sql';
const TIMESHEETS_DIR = 'legacy-fixtures/sql/timesheets/';

/** Committed fixtures by their place in the temp tree. */
const COPIED: Readonly<Record<string, string>> = {
  [FIXTURE_BEAN]: 'cfml/entity-with-bom.cfc',
  [BOOTSTRAP_DDL]: 'cfml/mssql-excerpt.sql',
};

/** Tag-syntax DAO: a join of two inventoried tables, a commented-out join, and a join to an uninventoried table. */
const JOIN_DAO_TEXT = [
  '<cfcomponent extends="mura.cfobject" output="false">',
  '',
  '<cffunction name="readStats" output="false">',
  '\t<cfargument name="fixtureID" type="string" />',
  '\t<cfset var rsStats = "" />',
  '\t<cfquery name="rsStats">',
  '\tselect tfixture.name, tfixturestats.data from tfixture inner join tfixturestats on tfixture.fixtureID = tfixturestats.statid',
  '\t<!--- inner join tfixturenopk on tfixturenopk.fixtureID = tfixture.fixtureID --->',
  '\twhere tfixture.fixtureID = <cfqueryparam cfsqltype="cf_sql_varchar" value="#arguments.fixtureID#">',
  '\t</cfquery>',
  '\t<cfreturn rsStats />',
  '</cffunction>',
  '',
  '<cffunction name="readUnknown" output="false">',
  '\t<cfset var rsUnknown = "" />',
  '\t<cfquery name="rsUnknown">',
  '\tselect tfixture.name from tfixture',
  '\tinner join tnosuch on tnosuch.fixtureid = tfixture.fixtureID',
  '\t</cfquery>',
  '\t<cfreturn rsUnknown />',
  '</cffunction>',
  '</cfcomponent>',
  '',
].join('\n');

const INLINE: Readonly<Record<string, string>> = { [JOIN_DAO]: JOIN_DAO_TEXT };

/** Ownership entries of one program schema, in the shape of the `opt2/table-ownership.json` fixture entries. */
function timesheetTables(schema: string): FixtureOwnership['tables'] {
  return [
    {
      table: `${schema}.timesheet`,
      owner: 'timesheets',
      source: { path: TIMESHEETS_DIR, lines: null },
      hasSiteId: true,
      primaryKey: ['timesheet_id'],
      columns: ['timesheet_id', 'person_id', 'siteID', 'period_start', 'period_end', 'due_date'],
      tenantResolution: 'program_site',
    },
    {
      table: `${schema}.timesheet_day`,
      owner: 'timesheets',
      source: { path: TIMESHEETS_DIR, lines: null },
      hasSiteId: false,
      primaryKey: ['day_id'],
      columns: ['day_id', 'timesheet_id', 'work_date', 'hours', 'state'],
      tenantResolution: 'program_site',
    },
  ];
}

const OWNERSHIP: FixtureOwnership = { tables: [...timesheetTables('Program_1'), ...timesheetTables('Program_2')] };

function liveTable(schema: string, name: string, columns: string[], key: string, hasSiteId: boolean): LiveCatalogTable {
  return {
    schema,
    name,
    columns: columns.map((c) => ({ name: c, type: 'nvarchar', length: 35, nullable: true })),
    primaryKey: [key],
    hasPrimaryKey: true,
    hasSiteId,
  };
}

/** Live-only tables the union needs: the site table and both program schemas. */
const LIVE: readonly LiveCatalogTable[] = [
  liveTable('dbo', 'tsettings', ['SiteID', 'Site'], 'SiteID', true),
  ...['Program_1', 'Program_2'].flatMap((schema) => [
    liveTable(schema, 'timesheet', ['timesheet_id', 'person_id', 'siteID'], 'timesheet_id', true),
    liveTable(schema, 'timesheet_day', ['day_id', 'timesheet_id', 'hours'], 'day_id', false),
  ]),
];

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

/** 1-based line of the only occurrence of `needle` in `text`. */
function lineIn(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) throw new Error(`${JSON.stringify(needle)} is not unique`);
  return text.slice(0, at).split('\n').length;
}

function ids(relations: readonly Relation[]): string[] {
  return relations.map((r) => r.id);
}

function timesheetEdge(schema: string): Relation {
  const id = `rel:${schema}.timesheet_day.timesheet_id->${schema}.timesheet.timesheet_id`.toLowerCase();
  return {
    id,
    kind: 'fixture-fk',
    child: { table: `${schema}.timesheet_day`, columns: ['timesheet_id'] },
    parent: { table: `${schema}.timesheet`, columns: ['timesheet_id'] },
    source: { path: TIMESHEETS_DIR, lines: [1, 1] },
    cfc: null,
    cardinality: null,
    orientation: 'declared',
    parentKey: { basis: 'ownership', component: null },
    tenantDerivation: true,
  };
}

let root = '';
let tree: SourceTree;
let extraction: EntityExtraction;
let staticTables: TableEntry[];
let tables: TableEntry[];
let inputs: RelationInputs;
let union: RelationExtraction;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-inv-relations-'));
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(fixturePath(name), path.join(root, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  tree = openSourceTree(root);
  extraction = extractEntities(tree);
  staticTables = extractTables(tree, extraction.ormTables).tables;
  tables = mergeLiveCatalog(staticTables, LIVE);
  inputs = { entities: extraction.entities, tables, tree, ownership: OWNERSHIP };
  union = extractRelations(inputs);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('extractOrmRelations', () => {
  it('derives tfixture.siteid -> tsettings.siteid from the many-to-one site property', () => {
    expect(extractOrmRelations(extraction.entities, tree)).toEqual([
      {
        id: 'rel:tfixture.siteid->tsettings.siteid',
        kind: 'orm-fk',
        child: { table: 'tfixture', columns: ['siteid'] },
        parent: { table: 'tsettings', columns: ['SiteID'] },
        source: { path: FIXTURE_BEAN, lines: [4, 4] },
        cfc: 'site',
        cardinality: 'many-to-one',
        orientation: 'declared',
        parentKey: { basis: 'domain-bean', component: null },
        tenantDerivation: false,
      },
    ]);
  });
});

describe('extractDaoJoins', () => {
  it('records the tfixture.fixtureID = tfixturestats.statid join at its query line, skipping the uninventoried table', () => {
    const line = lineIn(JOIN_DAO_TEXT, 'tfixture.fixtureID = tfixturestats.statid');
    expect(extractDaoJoins(tree, staticTables)).toEqual([
      {
        id: 'rel:tfixture.fixtureid->tfixturestats.statid',
        kind: 'dao-join',
        child: { table: 'tfixture', columns: ['fixtureID'] },
        parent: { table: 'tfixturestats', columns: ['statID'] },
        source: { path: JOIN_DAO, lines: [line, line] },
        cfc: null,
        cardinality: null,
        orientation: 'unknown',
        parentKey: { basis: 'join', component: null },
        tenantDerivation: false,
      },
    ]);
  });

  it('orients the join on the live catalog key once it replaces the static one', () => {
    const line = lineIn(JOIN_DAO_TEXT, 'tfixture.fixtureID = tfixturestats.statid');
    const governed = mergeLiveCatalog(staticTables, [
      { ...liveTable('dbo', 'tfixture', ['fixtureID', 'SiteID', 'name'], 'fixtureID', true) },
      { ...liveTable('dbo', 'tfixturestats', ['statID', 'siteid', 'data'], 'statID', true), primaryKey: [], hasPrimaryKey: false },
    ]);
    expect(extractDaoJoins(tree, governed)).toEqual([
      {
        id: 'rel:tfixturestats.statid->tfixture.fixtureid',
        kind: 'dao-join',
        child: { table: 'tfixturestats', columns: ['statID'] },
        parent: { table: 'tfixture', columns: ['fixtureID'] },
        source: { path: JOIN_DAO, lines: [line, line] },
        cfc: null,
        cardinality: null,
        orientation: 'primary-key',
        parentKey: { basis: 'table-key', component: null },
        tenantDerivation: false,
      },
    ]);
  });

  it('ignores a join predicate inside a CFML comment', () => {
    expect(() => lineIn(JOIN_DAO_TEXT, 'tfixturenopk.fixtureID = tfixture.fixtureID')).not.toThrow();
    expect(ids(extractDaoJoins(tree, staticTables, extraction.entities)).filter((id) => id.includes('tfixturenopk'))).toEqual([]);
  });
});

describe('fixtureRelations', () => {
  it('relates each program schema timesheet_day.timesheet_id to the timesheet of the same schema', () => {
    expect(fixtureRelations(OWNERSHIP)).toEqual([timesheetEdge('Program_1'), timesheetEdge('Program_2')]);
  });

  it('yields none for an ownership file without fixture tables', async () => {
    const doc = tableOwnershipSchema.parse(JSON.parse(await readFile(fixturePath('inventory/mini-table-ownership.json'), 'utf8')));
    expect(fixtureRelations(doc)).toEqual([]);
  });
});

describe('extractRelations', () => {
  it('unites the ORM, DAO-join and fixture relations, folding both program schemas into one Program_N edge', () => {
    expect(ids(union.relations)).toEqual([
      'rel:program_n.timesheet_day.timesheet_id->program_n.timesheet.timesheet_id',
      'rel:tfixture.siteid->tsettings.siteid',
    ]);
    expect(union.relations[1]).toEqual(extractOrmRelations(extraction.entities, tree, extraction.ormIndex, tables)[0]);
    expect(union.unoriented).toEqual(extractDaoJoins(tree, tables, extraction.entities));
    expect(union.dropped).toEqual([]);
    expect(union.counts).toEqual({
      relations: 2,
      ormFk: 1,
      daoJoin: 0,
      fixtureFk: 1,
      programFold: 0,
      tenantParent: 0,
      unknownOrientation: 1,
      relationsDropped: 0,
    });
  });

  it('keeps one copy of an ORM relation fed twice, sorted by rel: id, and repeats its result', () => {
    const doubled = extractRelations({ ...inputs, entities: [...extraction.entities, ...extraction.entities] });
    expect(doubled).toEqual(union);
    for (const list of [union.relations, union.unoriented]) {
      expect(ids(list).every((id) => id.startsWith('rel:'))).toBe(true);
      expect(ids(list)).toEqual([...ids(list)].sort());
    }
    expect(extractRelations(inputs)).toEqual(union);
  });
});
