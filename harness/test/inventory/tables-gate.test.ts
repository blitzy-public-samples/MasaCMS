import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { computeClosure, memorySourceTree, openSourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type {
  CfmlComponent,
  ClosureWrite,
  ComponentIndex,
  ConditionalWrite,
  SourceTree,
  WriteClosure,
} from '../../src/inventory/closure.js';
import { loadWriterOverrides, parseWriterOverrides } from '../../src/inventory/overrides.js';
import type { SourceRef, WriterOp, WriterOverrides } from '../../src/inventory/overrides.js';
import {
  BOOTSTRAP_DDL_PATH,
  DB_UPDATES_DIR,
  EXPECTED_SERIALIZED_COLUMNS,
  LIVE_TABLE_SOURCE,
  TABLE_OWNERSHIP_PATH,
  TABLE_SCOPE,
  TEMPLATE_METHOD,
  assignOwners,
  attachWriters,
  extractTables,
  fetchLiveCatalog,
  loadTableOwnership,
  mergeLiveCatalog,
  tableOwnershipSchema,
} from '../../src/inventory/tables.js';
import type {
  LiveCatalogTable,
  TableColumn,
  TableEntry,
  TableExtraction,
  TableOwnership,
  WriteEvidence,
  WriterEntry,
} from '../../src/inventory/tables.js';
import { assertReadOnlySql } from '../../src/lib/mssql.js';
import type { ReadOnlyMssql } from '../../src/lib/mssql.js';
import { assertOutsideRepo, repoPath } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

const DDL = BOOTSTRAP_DDL_PATH;
const MANAGER = 'core/mura/fixture/fixtureManager.cfc';
const DAO = 'core/mura/fixture/fixtureDAO.cfc';
const FIXTURE_BEAN = 'core/mura/fixture/fixtureBean.cfc';
const VERSIONED_BEAN = 'core/mura/fixture/fixtureVersionedBean.cfc';
const VERSIONED_BASE = 'core/mura/bean/beanORMVersioned.cfc';
const STATS_READER = 'core/mura/fixture/fixtureStatsReader.cfc';
const SETUP = 'core/mura/fixture/setup.cfm';
const MYSQL_DDL = 'core/setup/db/mysql.sql';
const UPDATE_EXCERPT = `${DB_UPDATES_DIR}/9.9.cfm`;
const UPDATE_PROC = `${DB_UPDATES_DIR}/9.9.1.cfm`;

/** Committed fixtures by their place in the on-disk archive tree. */
const COPIED: Readonly<Record<string, string>> = {
  [DDL]: 'mssql-excerpt.sql',
  [UPDATE_EXCERPT]: 'dbupdate-excerpt.cfm',
  [UPDATE_PROC]: 'dbupdate-with-proc.cfm',
  [MANAGER]: 'manager-writes.cfc',
  [DAO]: 'dao-writes.cfc',
  [FIXTURE_BEAN]: 'entity-with-bom.cfc',
  [VERSIONED_BEAN]: 'versioned-entity.cfc',
  [VERSIONED_BASE]: 'orm-base.cfc',
};

/** Inline files of the on-disk tree: another dialect's DDL and a reader that deserializes a stats column. */
const INLINE: Readonly<Record<string, string>> = {
  [MYSQL_DDL]: [
    'CREATE TABLE IF NOT EXISTS `tfixture` (',
    '  `fixtureID` char(35) NOT NULL',
    ');',
    'CREATE TABLE `tfixturenopk` (',
    '  `fixtureID` char(35)',
    ');',
    'CREATE TABLE `tmysqlonly` (`x` int);',
    '',
  ].join('\n'),
  [STATS_READER]: [
    'component extends="mura.cfobject" output="false" {',
    '\tpublic struct function read(required string statid) {',
    '\t\tvar rs = queryExecute("SELECT data FROM tfixturestats WHERE statid = :statid", {statid=arguments.statid});',
    '\t\treturn deserializeJSON(rs.data);',
    '\t}',
    '}',
    '',
  ].join('\n'),
};

const SCHEMA_DDL = [
  'CREATE TABLE [dbo].[tbase] (',
  '\t[baseID] [char] (35) NOT NULL ,',
  '\t[siteID] [nvarchar] (25) NULL ,',
  '\t[legacyName] [nvarchar] (50) NULL ,',
  '\t[obsolete] [int] NULL ,',
  '\t[payload] [nvarchar] (max) NULL ,',
  '\tCONSTRAINT [PK_tbase] PRIMARY KEY CLUSTERED ([baseID] ASC)',
  ')',
  'GO',
  'CREATE TABLE [dbo].[tkeyed] (',
  '\t[keyedID] [int] NOT NULL PRIMARY KEY,',
  "\t[code] [varchar] (20) NOT NULL DEFAULT 'a'',b',",
  '\tCONSTRAINT [uq_code] UNIQUE ([code]),',
  '\tUNIQUE ([code], [keyedID])',
  ')',
  'GO',
  'CREATE TABLE [dbo].[tglobalsfix] (',
  '\t[appreload] [datetime] NULL',
  ')',
  'GO',
  'CREATE TABLE [dbo].[tlater] (',
  '\t[laterID] [char] (35) NOT NULL',
  ')',
  'GO',
  'CREATE TABLE [dbo].[tcopy] AS SELECT (1) AS x',
  'GO',
  'CREATE TABLE [dbo].[tbroken] ([a] [int]',
  'GO',
  '',
].join('\n');

const UPDATE_SQL = `${DB_UPDATES_DIR}/7.0.cfm`;
const UPDATE_SQL_TEXT = [
  '<!--- schema changes written as SQL --->',
  '<cfquery>',
  'ALTER TABLE tbase ADD notes nvarchar(max) NULL',
  '</cfquery>',
  '<cfquery>',
  'ALTER TABLE tbase ALTER COLUMN legacyName nvarchar(255)',
  '</cfquery>',
  '<cfquery>',
  'ALTER TABLE tbase DROP COLUMN obsolete',
  '</cfquery>',
  '<cfquery>',
  "EXEC sp_rename 'tbase.legacyName', 'displayName', 'COLUMN'",
  '</cfquery>',
  '<cfquery>',
  'DROP TABLE tglobalsfix',
  '</cfquery>',
  '<cfquery>',
  'ALTER TABLE tlater ADD CONSTRAINT PK_tlater PRIMARY KEY (laterID)',
  '</cfquery>',
  '<cfquery>',
  'ALTER TABLE tkeyed DROP CONSTRAINT PK_tkeyed',
  '</cfquery>',
  '<cfquery>',
  "EXEC sp_rename 'tbase', 'tbase_old'",
  '</cfquery>',
  '<cfquery>',
  'DROP TABLE #variables.tempTable#',
  '</cfquery>',
  '<cfquery>',
  'ALTER TABLE tbase NOCHECK CONSTRAINT ALL',
  '</cfquery>',
  '<cfquery>',
  'ALTER TABLE tbase ALTER COLUMN missingCol int',
  '</cfquery>',
  '<cfquery>',
  'ALTER TABLE tunknown ADD c int',
  '</cfquery>',
  '<cfquery name="rsCheck" dbtype="query">',
  "SELECT * FROM rsTables WHERE 'CREATE TABLE tqoq (a int)' <> ''",
  '</cfquery>',
  '<cfquery>',
  'CREATE TABLE tbase (baseID char(35), extra2 int)',
  '</cfquery>',
  '',
].join('\n');

const UPDATE_UTIL = `${DB_UPDATES_DIR}/7.1.cfm`;
const UPDATE_UTIL_TEXT = [
  '<cfscript>',
  '\tdbUtility.setTable("tutilnew")',
  '\t\t.addColumn(column="utilID",datatype="char",length="35",nullable=false)',
  '\t\t.addColumn(column="body",datatype="text",length="max")',
  '\t\t.addColumn(column="siteid",datatype="varchar",length="25",nullable=true)',
  '\t\t.addPrimaryKey("utilID");',
  '\tgetBean("dbUtility").setTable(table="tbase")',
  '\t\t.renameColumn(column="notes",newcolumn="remarks")',
  '\t\t.alterColumn(column="remarks",datatype="longtext")',
  '\t\t.addPrimaryKey("siteID");',
  '\tdbUtility.addColumn(table="tlater",column="laterName",datatype="varchar",length=100);',
  '\tdbUtility.setTable("tkeyed").dropPrimaryKey().addIndex("code");',
  '\tdbUtility.setTable("").addColumn(column="orphan",datatype="int");',
  '\tdbUtility.setTable("tnothere").dropTable();',
  '\tdbUtility.setTable("tbase").renameColumn(column="remarks",newcolumn="baseID");',
  '\tdbUtility.setTable("tutilnew").dropPrimaryKey().addPrimaryKey("siteid");',
  '\tdbUtility.setTable("tdropme").addColumn(column="x",datatype="int").dropTable();',
  '</cfscript>',
  '',
].join('\n');

const UPDATE_DIALECT = `${DB_UPDATES_DIR}/7.2.cfm`;
const UPDATE_DIALECT_TEXT = [
  '<cfswitch expression="#getDbType()#">',
  '<cfcase value="mssql">',
  '<cfquery>',
  'CREATE TABLE tdialect (',
  '\tdialectID char(35) NOT NULL PRIMARY KEY,',
  '\tbody <cfoutput>#MSSQLlob#</cfoutput> NULL,',
  '\tsiteid nvarchar(25)',
  ')',
  '</cfquery>',
  '</cfcase>',
  '<cfcase value="mysql, postgresql">',
  '<cfquery>',
  'CREATE TABLE tdialect (dialectID char(35) NOT NULL, body longtext)',
  '</cfquery>',
  '<cfif getDbType() eq "postgresql">',
  '<cfquery>',
  'CREATE TABLE tpgonly (x int)',
  '</cfquery>',
  '</cfif>',
  '</cfcase>',
  '</cfswitch>',
  '<cfif getDbType() eq "oracle">',
  '<cfquery>',
  'ALTER TABLE tdialect ADD oracleNote varchar2(10)',
  '</cfquery>',
  '<cfelse>',
  '<cfquery>',
  'ALTER TABLE tdialect ADD commonNote int',
  '</cfquery>',
  '</cfif>',
  '<cfif getDbType() eq "mysql">',
  '<cfquery>',
  'ALTER TABLE tdialect ADD mysqlNote int',
  '</cfquery>',
  '<cfelseif variables.configBean.getDbType() is "MSSQL">',
  '<cfquery>',
  'ALTER TABLE tdialect ADD mssqlNote nvarchar(10) NULL',
  '</cfquery>',
  '</cfif>',
  '<cfswitch expression="#variables.mode#">',
  '<cfcase value="mssql">',
  '<cfquery>',
  'ALTER TABLE tdialect ADD modeNote int',
  '</cfquery>',
  '</cfcase>',
  '</cfswitch>',
  '',
].join('\n');

const ORACLE_DDL = 'core/setup/db/oracle.sql';
const THING_DIR = 'core/mura/content/thing';
const THING_BEAN = `${THING_DIR}/thingBean.cfc`;
const THING_BASE = `${THING_DIR}/thingBase.cfc`;
const THING_NOTE = `${THING_DIR}/thingNoteBean.cfc`;

/** Archive tree of schema statements, schema updates and ORM declarations, held in memory. */
const SCHEMA_FILES: Readonly<Record<string, string>> = {
  [DDL]: SCHEMA_DDL,
  [ORACLE_DDL]: 'CREATE TABLE tbase (\n\tbaseID char(35)\n);\n',
  [UPDATE_SQL]: UPDATE_SQL_TEXT,
  [UPDATE_UTIL]: UPDATE_UTIL_TEXT,
  [UPDATE_DIALECT]: UPDATE_DIALECT_TEXT,
  [`${DB_UPDATES_DIR}/readme.txt`]: 'CREATE TABLE tnotes (a int)\n',
  [`${DB_UPDATES_DIR}/old/1.0.cfm`]: '<cfquery>\nCREATE TABLE tarchived (a int)\n</cfquery>\n',
  [`${THING_DIR}/ThingDecl.cfc`]: 'component table="tthing" output="false" {\n}\n',
  [THING_BASE]: [
    'component extends="mura.bean.beanORMHistorical" {',
    '\tproperty name="histid" fieldtype="id" historical="true";',
    '\tproperty name="title" datatype="varchar";',
    '\tproperty name="created" datatype="datetime";',
    '}',
    '',
  ].join('\n'),
  [THING_BEAN]: [
    'component extends="thingBase" table="tthing" entityname="thing" {',
    '\tproperty name="thingid" fieldtype="id";',
    '\tproperty name="site" fieldtype="many-to-one" cfc="site" fkcolumn="siteID";',
    '\tproperty name="owner" fieldtype="many-to-one" relatesto="user";',
    '\tproperty name="title" ormtype="string" length="200" nullable="false";',
    '\tproperty name="body" datatype="text" length="max";',
    '\tproperty name="label" column="labelText" type="string" nullable="true";',
    '\tproperty name="cache" persistent="false";',
    '}',
    '',
  ].join('\n'),
  [`${THING_DIR}/thingGateway.cfc`]: [
    'component extends="mura.cfobject" output="false" {',
    '\tpublic query function list() {',
    '\t\tvar table = "tthing";',
    '\t\treturn queryExecute("SELECT * FROM #table#");',
    '\t}',
    '}',
    '',
  ].join('\n'),
  [THING_NOTE]: 'component extends="thingBase" table="tthingnote" entityname="thingNote" {\n\tproperty name="noteid" fieldtype="id";\n}\n',
  [`${THING_DIR}/thingZ.cfc`]: 'component extends="mura.bean.beanORM" table="tthing" entityname="thingDuplicate" {\n}\n',
};

const DOC_BEAN = 'core/mura/doc/docBean.cfc';
const DOC_MANAGER = 'core/mura/doc/docManager.cfc';
const DOC_DDL = [
  'CREATE TABLE [dbo].[tdoc] (',
  '\t[docID] [char] (35) NOT NULL ,',
  '\t[body] [ntext] NULL ,',
  '\t[meta] [nvarchar] (max) NULL ,',
  '\t[notes] [text] NULL ,',
  '\t[label] [nvarchar] (255) NULL',
  ')',
  'GO',
  '',
].join('\r\n');
const DOC_ENTITY = 'component extends="mura.bean.beanORM" table="tdoc" entityname="doc" {\n\tproperty name="docid" fieldtype="id";\n}\n';

const PLAN_READER = 'core/mura/plan/planReader.cfc';

/** Bootstrap DDL of the four tables whose serialized documents the plan names; `dataColumn` spells the packet column. */
function planDdl(dataColumn: string): string {
  return [
    'CREATE TABLE [dbo].[tcontentobjects] (\r\n\t[contentID] [char] (35) NOT NULL ,\r\n\t[params] [ntext] NULL\r\n)\r\nGO',
    `CREATE TABLE [dbo].[tformresponsepackets] (\r\n\t[ResponseID] [char] (35) NOT NULL ,\r\n\t[${dataColumn}] [ntext] NULL\r\n)\r\nGO`,
    'CREATE TABLE [dbo].[toauthtokens] (\r\n\t[token] [char] (35) NOT NULL ,\r\n\t[data] [nvarchar] (max) NULL\r\n)\r\nGO',
    'CREATE TABLE [dbo].[ttrash] (\r\n\t[objectID] [char] (35) NOT NULL ,\r\n\t[objectstring] [ntext] NULL\r\n)\r\nGO',
    '',
  ].join('\r\n');
}

/** A reader of the plan's serialized documents; `tokens` false leaves out the toauthtokens read. */
function planReader(tokens: boolean): string {
  return [
    'component extends="mura.cfobject" output="false" {',
    '\tpublic array function read(required string id) {',
    '\t\tvar objects = queryExecute("SELECT params FROM tcontentobjects WHERE contentid = :id", {id=arguments.id});',
    '\t\tvar packets = queryExecute("SELECT Data FROM tformresponsepackets WHERE responseid = :id", {id=arguments.id});',
    ...(tokens ? ['\t\tvar tokens = queryExecute("SELECT data FROM toauthtokens WHERE token = :id", {id=arguments.id});'] : []),
    '\t\tvar trash = queryExecute("SELECT objectstring FROM ttrash WHERE objectid = :id", {id=arguments.id});',
    `\t\treturn [deserializeJSON(objects.params), deserializeJSON(packets.Data), ${tokens ? 'deserializeJSON(tokens.data), ' : ''}isWDDX(trash.objectstring)];`,
    '\t}',
    '}',
    '',
  ].join('\n');
}

interface OwnershipRow {
  table: string;
  owner: string;
  ruleSteps: number[];
  targets: Array<{ unit: string; owner: string; columns?: string[] }>;
  split?: { by: string; rows?: Record<string, string> };
  decisionRef?: string;
  source?: { path: string; lines: [number, number] | null };
}

interface OwnershipDoc {
  sourceSha: string;
  units: Array<{ unit: string; owner: string }>;
  tables: OwnershipRow[];
  reviewedBy?: string;
}

const FORM_SOURCE = { path: 'core/mura/formBuilder/formBuilderManager.cfc', lines: [689, 773] as [number, number] };
const TIMESHEET_SOURCE = { path: 'legacy-fixtures/sql/timesheets/001_timesheet.sql', lines: [3, 9] as [number, number] };

/** Ownership document over the on-disk tree and its live catalog, carrying `sourceSha`. */
function ownershipDoc(sourceSha: string): OwnershipDoc {
  return {
    sourceSha,
    units: [
      { unit: 'identity.fixture', owner: 'identity' },
      { unit: 'people.person', owner: 'people' },
      { unit: 'content.form_entity', owner: 'strategies-content' },
      { unit: 'programs_sites.program', owner: 'programs-sites' },
      { unit: 'timesheets.timesheet', owner: 'timesheets' },
    ],
    tables: [
      {
        table: 'tfixture',
        owner: 'identity',
        ruleSteps: [1],
        split: { by: 'Type', rows: { '1': 'identity' } },
        targets: [{ unit: 'identity.fixture', owner: 'identity', columns: ['fixtureID'] }],
      },
      { table: 'dbo.TFixtureMigrated', owner: 'people', ruleSteps: [1, 3], targets: [{ unit: 'people.person', owner: 'people' }] },
      { table: 'tfixturenopk', owner: 'decision-list', ruleSteps: [5], targets: [], decisionRef: 'dl:tfixturenopk' },
      { table: 'tfixturestats', owner: 'reporting', ruleSteps: [1], targets: [] },
      { table: 'tfixtureversioned', owner: 'identity', ruleSteps: [1], targets: [], source: { path: VERSIONED_BEAN, lines: [2, 2] } },
      {
        table: 'fb_*',
        owner: 'strategies-content',
        ruleSteps: [1],
        targets: [{ unit: 'content.form_entity', owner: 'strategies-content' }],
        source: FORM_SOURCE,
      },
      { table: 'tentity-declared:*', owner: 'decision-list', ruleSteps: [5], targets: [], decisionRef: 'dl:tentity' },
      {
        table: 'Program_N.tprogram',
        owner: 'programs-sites',
        ruleSteps: [1, 4],
        targets: [{ unit: 'programs_sites.program', owner: 'programs-sites' }],
        source: { path: 'legacy-fixtures/sql/010_program_site.sql', lines: null },
      },
      {
        table: 'synthetic.timesheet',
        owner: 'timesheets',
        ruleSteps: [1],
        targets: [{ unit: 'timesheets.timesheet', owner: 'timesheets' }],
        source: TIMESHEET_SOURCE,
      },
    ],
    reviewedBy: 'tables gate',
  };
}

function catalogColumn(schema: string, table: string, name: string, type: string, length: number | null, nullable: 'YES' | 'NO', ordinal: number): Record<string, unknown> {
  return {
    TABLE_SCHEMA: schema,
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: type,
    CHARACTER_MAXIMUM_LENGTH: length,
    IS_NULLABLE: nullable,
    ORDINAL_POSITION: ordinal,
  };
}

function catalogKey(schema: string, table: string, name: string, ordinal: number): Record<string, unknown> {
  return { TABLE_SCHEMA: schema, TABLE_NAME: table, COLUMN_NAME: name, ORDINAL_POSITION: ordinal };
}

interface CatalogRows {
  tables: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  keys: Record<string, unknown>[];
}

/** Rows of the three INFORMATION_SCHEMA queries for the on-disk tree's live database. */
function catalogRows(): CatalogRows {
  return {
    tables: [
      ['dbo', 'tfixture'],
      ['dbo', 'tFixtureNoPK'],
      ['dbo', 'tfixturestats'],
      ['dbo', 'tfixturemigrated'],
      ['Program_2', 'tprogram'],
      ['Program_1', 'tprogram'],
      ['synthetic', 'timesheet'],
      ['dbo', 'fb_survey'],
      ['dbo', 'tdeclaredthing'],
      ['dbo', 'tstray'],
      ['opt2_sync', 'checkpoint'],
    ].map(([schema, name]) => ({ TABLE_SCHEMA: schema, TABLE_NAME: name })),
    columns: [
      catalogColumn('dbo', 'tfixture', 'SiteID', 'nvarchar', 25, 'YES', 2),
      catalogColumn('dbo', 'tfixture', 'fixtureID', 'char', 35, 'NO', 1),
      catalogColumn('dbo', 'tfixture', 'userID', 'char', 35, 'YES', 3),
      catalogColumn('dbo', 'tfixture', 'name', 'nvarchar', 100, 'YES', 4),
      catalogColumn('dbo', 'tfixture', 'notes', 'NVARCHAR', -1, 'YES', 5),
      catalogColumn('dbo', 'tfixture', 'sortOrder', 'int', null, 'YES', 6),
      catalogColumn('dbo', 'tfixture', 'tablist', 'nvarchar', -1, 'YES', 7),
      catalogColumn('dbo', 'tFixtureNoPK', 'fixtureID', 'char', 35, 'NO', 1),
      catalogColumn('dbo', 'tFixtureNoPK', 'label', 'nvarchar', 50, 'YES', 2),
      catalogColumn('dbo', 'tfixturestats', 'statID', 'char', 35, 'NO', 1),
      catalogColumn('dbo', 'tfixturestats', 'siteid', 'nvarchar', 25, 'YES', 2),
      catalogColumn('dbo', 'tfixturestats', 'data', 'ntext', 1073741823, 'YES', 3),
      catalogColumn('dbo', 'tfixturemigrated', 'migratedID', 'char', 35, 'NO', 1),
      catalogColumn('dbo', 'tfixturemigrated', 'siteID', 'nvarchar', 25, 'YES', 2),
      catalogColumn('dbo', 'tfixturemigrated', 'label', 'nvarchar', 50, 'YES', 3),
      catalogColumn('Program_1', 'tprogram', 'programID', 'char', 35, 'NO', 1),
      catalogColumn('Program_1', 'tprogram', 'siteID', 'nvarchar', 25, 'NO', 2),
      catalogColumn('Program_2', 'tprogram', 'programID', 'char', 35, 'NO', 1),
      catalogColumn('Program_2', 'tprogram', 'SiteID', 'nvarchar', 25, 'NO', 2),
      catalogColumn('Program_2', 'tprogram', 'extra', 'int', null, 'YES', 3),
      catalogColumn('synthetic', 'timesheet', 'timesheetID', 'uniqueidentifier', null, 'NO', 1),
      catalogColumn('synthetic', 'timesheet', 'siteid', 'nvarchar', 25, 'NO', 2),
      catalogColumn('dbo', 'fb_survey', 'surveyID', 'char', 35, 'NO', 1),
      catalogColumn('dbo', 'tdeclaredthing', 'id', 'char', 35, 'NO', 1),
      catalogColumn('dbo', 'tstray', 'strayID', 'int', null, 'NO', 1),
      catalogColumn('dbo', 'tstray', 'SITEID', 'nvarchar', 25, 'YES', 2),
      catalogColumn('opt2_sync', 'checkpoint', 'unit', 'nvarchar', 100, 'NO', 1),
      catalogColumn('dbo', 'vfixture', 'fixtureID', 'char', 35, 'NO', 1),
    ],
    keys: [
      catalogKey('dbo', 'tfixture', 'fixtureID', 1),
      catalogKey('dbo', 'tFixtureNoPK', 'fixtureID', 1),
      catalogKey('dbo', 'tfixturemigrated', 'siteID', 2),
      catalogKey('dbo', 'tfixturemigrated', 'migratedID', 1),
      catalogKey('Program_1', 'tprogram', 'programID', 1),
      catalogKey('synthetic', 'timesheet', 'timesheetID', 1),
      catalogKey('dbo', 'fb_survey', 'surveyID', 1),
      catalogKey('opt2_sync', 'checkpoint', 'unit', 1),
    ],
  };
}

/** Read-only client that answers the catalog queries from `rows`, refusing any statement the guard refuses. */
function catalogDb(rows: CatalogRows, seen: string[]): ReadOnlyMssql {
  return {
    readOnlyQuery<T>(sql: string): Promise<T[]> {
      assertReadOnlySql(sql);
      seen.push(sql);
      if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) return Promise.resolve(rows.keys as T[]);
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return Promise.resolve(rows.columns as T[]);
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) return Promise.resolve(rows.tables as T[]);
      return Promise.reject(new Error(`unexpected catalog query: ${sql}`));
    },
    close: () => Promise.resolve(),
  };
}

function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../fixtures/${rel}`, import.meta.url));
}

/** 1-based line of the only occurrence of `needle` in `text`. */
function lineIn(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) throw new Error(`${JSON.stringify(needle)} is not unique`);
  return text.slice(0, at).split('\n').length;
}

function src(p: string, from: number, to: number = from): SourceRef {
  return { path: p, lines: [from, to] };
}

function col(name: string, type: string | null, length: number | 'max' | null, nullable: boolean | null, source: SourceRef): TableColumn {
  return { name, type, length, nullable, source };
}

function site(column: string, source: SourceRef): Pick<TableEntry, 'hasSiteId' | 'siteIdColumn' | 'siteIdSource'> {
  return { hasSiteId: true, siteIdColumn: column, siteIdSource: source };
}

function key(columns: string[]): Pick<TableEntry, 'hasPrimaryKey' | 'staticHasPrimaryKey' | 'primaryKey'> {
  return { hasPrimaryKey: true, staticHasPrimaryKey: true, primaryKey: columns };
}

/** A static entry as extractTables leaves it, before the live catalog, writers and owners. */
function staticEntry(fields: Pick<TableEntry, 'table' | 'origin' | 'source' | 'createdBy' | 'columns'> & Partial<TableEntry>): TableEntry {
  return {
    id: `tbl:${fields.table}`,
    schema: 'dbo',
    otherDialects: [],
    retired: false,
    droppedBy: null,
    hasSiteId: false,
    siteIdColumn: null,
    siteIdSource: null,
    hasPrimaryKey: false,
    staticHasPrimaryKey: false,
    bootstrapHasPrimaryKey: null,
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
    ...fields,
  };
}

function writer(fields: Pick<WriterEntry, 'component' | 'method' | 'source' | 'op'> & Partial<WriterEntry>): WriterEntry {
  return { routeKeys: [], keyScope: [TABLE_SCOPE], trigger: 'request', sessionEffects: 'none', condition: null, override: null, ...fields };
}

function closureWrite(table: string | null, op: WriterOp, component: string, method: string, source: SourceRef, extra: Partial<ClosureWrite> = {}): ClosureWrite {
  return { table, op, component, method, source, trigger: 'request', whereParams: [], conditional: false, ...extra };
}

function closureOf(writes: ClosureWrite[], conditionalWrites: ConditionalWrite[] = []): WriteClosure {
  const tables = [...new Set(writes.flatMap((w) => (w.table === null ? [] : [w.table])))].sort();
  const overrides = [...new Set(writes.flatMap((w) => (w.override === undefined ? [] : [w.override])))].sort();
  return { tables, writes, conditionalWrites, fileStore: false, fileStoreEvidence: [], sessionEffects: 'none', threads: [], unresolved: [], overrides, visited: [] };
}

function byTable(tables: readonly TableEntry[], table: string): TableEntry {
  const found = tables.find((t) => t.table === table);
  if (found === undefined) throw new Error(`no table ${table}`);
  return found;
}

function scriptCfc(body: string): string {
  return `component extends="mura.cfobject" output="false" {\n\tpublic any function run(required struct data) {\n\t\t${body}\n\t}\n}\n`;
}

function tagCfc(body: string): string {
  return `<cfcomponent extends="mura.cfobject" output="false">\n<cffunction name="run" output="false">\n\t<cfargument name="data" type="struct">\n\t${body}\n</cffunction>\n</cfcomponent>\n`;
}

/** Component index over the on-disk tree with the fixture DAO and manager registered. */
function fixtureIndex(source: SourceTree): ComponentIndex {
  const beans: Readonly<Record<string, string>> = { fixturedao: DAO, fixturemanager: MANAGER };
  const parsed = new Map<string, CfmlComponent | null>();
  return {
    resolveBean: (name) => beans[name.toLowerCase()] ?? null,
    ormTable: (p) => (p === FIXTURE_BEAN ? 'tfixture' : null),
    parsed(p) {
      if (!parsed.has(p)) parsed.set(p, p.endsWith('.cfc') && source.exists(p) ? parseCfmlComponent(p, source.readText(p)) : null);
      return parsed.get(p) ?? null;
    },
  };
}

let root = '';
let tree: SourceTree;
let extraction: TableExtraction;
let live: LiveCatalogTable[];
let merged: TableEntry[];
let ownership: TableOwnership;

beforeAll(async () => {
  root = await mkdtemp(path.join(assertOutsideRepo(os.tmpdir(), 'TMPDIR'), 'opt2-inv-tables-gate-'));
  const treeRoot = path.join(root, 'tree');
  for (const [rel, name] of Object.entries(COPIED)) {
    await mkdir(path.dirname(path.join(treeRoot, rel)), { recursive: true });
    await copyFile(fixturePath(`cfml/${name}`), path.join(treeRoot, rel));
  }
  for (const [rel, text] of Object.entries(INLINE)) {
    await mkdir(path.dirname(path.join(treeRoot, rel)), { recursive: true });
    await writeFile(path.join(treeRoot, rel), text);
  }
  tree = openSourceTree(treeRoot);
  extraction = extractTables(tree, ['TFixture', 'tfixtureversioned', 'tfixture']);
  live = await fetchLiveCatalog(catalogDb(catalogRows(), []));
  merged = mergeLiveCatalog(extraction.tables, live, { declaredEntityTables: ['TDeclaredThing'] });
  const ownershipFile = path.join(root, 'table-ownership.json');
  await writeFile(ownershipFile, JSON.stringify(ownershipDoc(pinnedSha())));
  ownership = await loadTableOwnership(ownershipFile);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('table inventory constants', () => {
  it('name the archive inputs, the ownership file and the serialized documents the migration plan names', () => {
    expect(BOOTSTRAP_DDL_PATH).toBe('core/setup/db/mssql.sql');
    expect(DB_UPDATES_DIR).toBe('core/mura/dbUpdates');
    expect(TABLE_OWNERSHIP_PATH).toBe(repoPath('opt2/table-ownership.json'));
    expect(LIVE_TABLE_SOURCE).toEqual({ path: 'live:INFORMATION_SCHEMA.TABLES', lines: [1, 1] });
    expect(Object.isFrozen(LIVE_TABLE_SOURCE)).toBe(true);
    expect(TEMPLATE_METHOD).toBe('(template)');
    expect(TABLE_SCOPE).toBe('table');
    expect(EXPECTED_SERIALIZED_COLUMNS).toEqual({
      tcontentobjects: ['params'],
      tformresponsepackets: ['Data'],
      toauthtokens: ['data'],
      ttrash: ['objectstring'],
    });
  });
});

describe('extractTables over the committed fixtures', () => {
  const versionedDecl = src(VERSIONED_BEAN, 2, 2);

  it('builds one entry per bootstrap, schema-update and ORM-only table with its columns, keys and sources', () => {
    expect(extraction.tables).toEqual([
      staticEntry({
        table: 'tfixture',
        origin: 'bootstrap',
        source: src(DDL, 2, 7),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [2, 2] }],
        otherDialects: [{ dialect: 'mysql', path: MYSQL_DDL, lines: [1, 1] }],
        columns: [
          col('fixtureID', 'char', 35, false, src(DDL, 3)),
          col('SiteID', 'nvarchar', 25, true, src(DDL, 4)),
          col('userID', 'char', 35, true, src(DDL, 5)),
          col('name', 'nvarchar', 100, true, src(DDL, 6)),
          col('notes', 'longtext', null, null, src(UPDATE_EXCERPT, 12)),
          col('sortOrder', 'int', null, null, src(UPDATE_EXCERPT, 13)),
        ],
        ...site('SiteID', src(DDL, 4)),
        ...key(['fixtureID']),
        bootstrapHasPrimaryKey: true,
        ormEntity: { path: FIXTURE_BEAN, entityName: 'fixture' },
      }),
      staticEntry({
        table: 'tfixturemigrated',
        origin: 'migration',
        source: src(UPDATE_EXCERPT, 3, 7),
        createdBy: [{ dialect: 'any', path: UPDATE_EXCERPT, lines: [3, 3] }],
        columns: [
          col('migratedID', 'char', 35, false, src(UPDATE_EXCERPT, 4)),
          col('siteID', 'nvarchar', 25, true, src(UPDATE_EXCERPT, 5)),
          col('label', 'nvarchar', 50, true, src(UPDATE_EXCERPT, 6)),
        ],
        ...site('siteID', src(UPDATE_EXCERPT, 5)),
      }),
      staticEntry({
        table: 'tfixturenopk',
        origin: 'bootstrap',
        source: src(DDL, 10, 13),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [10, 10] }],
        otherDialects: [{ dialect: 'mysql', path: MYSQL_DDL, lines: [4, 4] }],
        columns: [col('fixtureID', 'char', 35, true, src(DDL, 11)), col('label', 'nvarchar', 50, true, src(DDL, 12))],
        bootstrapHasPrimaryKey: false,
      }),
      staticEntry({
        table: 'tfixturestats',
        origin: 'bootstrap',
        source: src(DDL, 16, 20),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [16, 16] }],
        columns: [
          col('statID', 'char', 35, false, src(DDL, 17)),
          col('siteid', 'nvarchar', 25, true, src(DDL, 18)),
          col('data', 'ntext', null, true, src(DDL, 19)),
        ],
        ...site('siteid', src(DDL, 18)),
        ...key(['statID']),
        bootstrapHasPrimaryKey: true,
        serializedColumns: ['data'],
        expectedSerializedColumns: [],
      }),
      staticEntry({
        table: 'tfixtureversioned',
        origin: 'orm',
        source: versionedDecl,
        createdBy: [{ dialect: 'orm', path: VERSIONED_BEAN, lines: [2, 2] }],
        columns: [
          col('fixtureversionedid', 'varchar', null, null, src(VERSIONED_BEAN, 3)),
          col('created', 'timestamp', null, null, src(VERSIONED_BASE, 3)),
        ],
        ...key(['fixtureversionedid']),
        ormEntity: { path: VERSIONED_BEAN, entityName: 'fixtureVersioned' },
      }),
    ]);
  });

  it('counts the tables by origin and lists those without a primary key', () => {
    expect(extraction.counts).toEqual({
      bootstrap: 3,
      migration: 1,
      orm: 1,
      staticTotal: 5,
      retired: 0,
      liveStatic: 5,
      withSiteId: 3,
      withoutPrimaryKeyBootstrap: 1,
      withoutPrimaryKey: 2,
    });
    expect(extraction.noPrimaryKeyBootstrap).toEqual(['tfixturenopk']);
    expect(extraction.noPrimaryKey).toEqual(['tfixturemigrated', 'tfixturenopk']);
  });

  it('reports computed serialized columns that differ from the plan as a correction', () => {
    expect(extraction.corrections).toEqual([
      {
        measure: 'serializedColumns',
        expected: ['tcontentobjects.params', 'tformresponsepackets.Data', 'toauthtokens.data', 'ttrash.objectstring'],
        computed: ['tfixturestats.data'],
      },
    ]);
    expect(byTable(extraction.tables, 'tfixture')).not.toHaveProperty('expectedSerializedColumns');
  });
});

describe('extractTables over schema statements and updates', () => {
  const schema = extractTables(memorySourceTree(SCHEMA_FILES), ['tthing', 'tthingnote']);
  const sqlLine = (needle: string): number => lineIn(UPDATE_SQL_TEXT, needle);
  const utilLine = (needle: string): number => lineIn(UPDATE_UTIL_TEXT, needle);
  const dialectLine = (needle: string): number => lineIn(UPDATE_DIALECT_TEXT, needle);
  const ddlLine = (needle: string): number => lineIn(SCHEMA_DDL, needle);

  it('applies column, key, rename and drop statements of SQL and dbUtility updates in file order', () => {
    const recreate = sqlLine('CREATE TABLE tbase');
    expect(byTable(schema.tables, 'tbase')).toEqual(
      staticEntry({
        table: 'tbase',
        origin: 'bootstrap',
        source: src(DDL, 1, 8),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [1, 1] }],
        otherDialects: [
          { dialect: 'any', path: UPDATE_SQL, lines: [recreate, recreate] },
          { dialect: 'oracle', path: ORACLE_DDL, lines: [1, 1] },
        ],
        columns: [
          col('baseID', 'char', 35, false, src(DDL, 2)),
          col('siteID', 'nvarchar', 25, true, src(DDL, 3)),
          col('displayName', 'nvarchar', 255, true, src(DDL, 4)),
          col('payload', 'nvarchar', 'max', true, src(DDL, 6)),
          col('remarks', 'longtext', null, true, src(UPDATE_SQL, sqlLine('ADD notes'))),
          col('extra2', 'int', null, null, src(UPDATE_SQL, recreate)),
        ],
        ...site('siteID', src(DDL, 3)),
        ...key(['baseID']),
        bootstrapHasPrimaryKey: true,
      }),
    );
  });

  it('keeps the bootstrap key flag apart from the key the updates leave, skipping table constraints and quoted defaults', () => {
    const keyed = ddlLine('[dbo].[tkeyed]');
    expect(byTable(schema.tables, 'tkeyed')).toEqual(
      staticEntry({
        table: 'tkeyed',
        origin: 'bootstrap',
        source: src(DDL, keyed, ddlLine('UNIQUE ([code], [keyedID])') + 1),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [keyed, keyed] }],
        columns: [
          col('keyedID', 'int', null, false, src(DDL, ddlLine('[keyedID] [int]'))),
          col('code', 'varchar', 20, false, src(DDL, ddlLine('[code] [varchar]'))),
        ],
        bootstrapHasPrimaryKey: true,
      }),
    );
    const later = ddlLine('[dbo].[tlater]');
    expect(byTable(schema.tables, 'tlater')).toEqual(
      staticEntry({
        table: 'tlater',
        origin: 'bootstrap',
        source: src(DDL, later, later + 2),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [later, later] }],
        columns: [
          col('laterID', 'char', 35, false, src(DDL, later + 1)),
          col('laterName', 'varchar', 100, null, src(UPDATE_UTIL, utilLine('table="tlater"'))),
        ],
        ...key(['laterID']),
        primaryKeySource: src(UPDATE_SQL, sqlLine('PK_tlater')),
        bootstrapHasPrimaryKey: false,
      }),
    );
  });

  it('marks a table a schema update drops as retired', () => {
    const globals = ddlLine('[dbo].[tglobalsfix]');
    expect(byTable(schema.tables, 'tglobalsfix')).toEqual(
      staticEntry({
        table: 'tglobalsfix',
        origin: 'bootstrap',
        source: src(DDL, globals, globals + 2),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [globals, globals] }],
        columns: [col('appreload', 'datetime', null, true, src(DDL, globals + 1))],
        retired: true,
        droppedBy: src(UPDATE_SQL, sqlLine('DROP TABLE tglobalsfix')),
        bootstrapHasPrimaryKey: false,
      }),
    );
    const dropLine = utilLine('setTable("tdropme")');
    expect(byTable(schema.tables, 'tdropme')).toEqual(
      staticEntry({
        table: 'tdropme',
        origin: 'migration',
        source: src(UPDATE_UTIL, dropLine),
        createdBy: [{ dialect: 'any', path: UPDATE_UTIL, lines: [dropLine, dropLine] }],
        columns: [col('x', 'int', null, null, src(UPDATE_UTIL, dropLine))],
        retired: true,
        droppedBy: src(UPDATE_UTIL, dropLine),
      }),
    );
  });

  it('creates a table from the dbUtility chain whose first addColumn names an unknown table', () => {
    const start = utilLine('setTable("tutilnew")\n');
    const siteLine = utilLine('column="siteid"');
    expect(byTable(schema.tables, 'tutilnew')).toEqual(
      staticEntry({
        table: 'tutilnew',
        origin: 'migration',
        source: src(UPDATE_UTIL, start, utilLine('addPrimaryKey("utilID")')),
        createdBy: [{ dialect: 'any', path: UPDATE_UTIL, lines: [start, start] }],
        columns: [
          col('utilID', 'char', 35, false, src(UPDATE_UTIL, utilLine('column="utilID"'))),
          col('body', 'text', 'max', null, src(UPDATE_UTIL, utilLine('column="body"'))),
          col('siteid', 'varchar', 25, true, src(UPDATE_UTIL, siteLine)),
        ],
        ...site('siteid', src(UPDATE_UTIL, siteLine)),
        ...key(['siteid']),
      }),
    );
  });

  it('takes SQL Server branches of dialect switches and records other dialects without creating their tables', () => {
    const create = dialectLine('CREATE TABLE tdialect (\n');
    const other = dialectLine('CREATE TABLE tdialect (dialectID');
    const siteLine = dialectLine('\tsiteid nvarchar(25)');
    expect(byTable(schema.tables, 'tdialect')).toEqual(
      staticEntry({
        table: 'tdialect',
        origin: 'migration',
        source: src(UPDATE_DIALECT, create, siteLine + 1),
        createdBy: [{ dialect: 'mssql', path: UPDATE_DIALECT, lines: [create, create] }],
        otherDialects: [{ dialect: 'mysql,postgresql', path: UPDATE_DIALECT, lines: [other, other] }],
        columns: [
          col('dialectID', 'char', 35, false, src(UPDATE_DIALECT, dialectLine('\tdialectID char(35)'))),
          col('body', 'nvarchar', 'max', true, src(UPDATE_DIALECT, dialectLine('#MSSQLlob#'))),
          col('siteid', 'nvarchar', 25, null, src(UPDATE_DIALECT, siteLine)),
          col('commonNote', 'int', null, null, src(UPDATE_DIALECT, dialectLine('commonNote'))),
          col('mssqlNote', 'nvarchar', 10, true, src(UPDATE_DIALECT, dialectLine('mssqlNote'))),
          col('modeNote', 'int', null, null, src(UPDATE_DIALECT, dialectLine('modeNote'))),
        ],
        ...site('siteid', src(UPDATE_DIALECT, siteLine)),
        ...key(['dialectID']),
      }),
    );
  });

  it('maps ORM-only tables from the first extending declaration, with inherited columns and the historical key', () => {
    expect(byTable(schema.tables, 'tthing')).toEqual(
      staticEntry({
        table: 'tthing',
        origin: 'orm',
        source: src(THING_BEAN, 1),
        createdBy: [{ dialect: 'orm', path: THING_BEAN, lines: [1, 1] }],
        columns: [
          col('thingid', 'varchar', null, null, src(THING_BEAN, 2)),
          col('siteID', 'varchar', null, null, src(THING_BEAN, 3)),
          col('title', 'string', 200, false, src(THING_BEAN, 5)),
          col('body', 'text', 'max', null, src(THING_BEAN, 6)),
          col('labelText', 'string', null, true, src(THING_BEAN, 7)),
          col('histid', 'varchar', null, null, src(THING_BASE, 2)),
          col('created', 'datetime', null, null, src(THING_BASE, 4)),
        ],
        ...site('siteID', src(THING_BEAN, 3)),
        ...key(['histid']),
        primaryKeySource: src(THING_BASE, 2),
        ormEntity: { path: THING_BEAN, entityName: 'thing' },
      }),
    );
    expect(byTable(schema.tables, 'tthingnote')).toEqual(
      staticEntry({
        table: 'tthingnote',
        origin: 'orm',
        source: src(THING_NOTE, 1),
        createdBy: [{ dialect: 'orm', path: THING_NOTE, lines: [1, 1] }],
        columns: [
          col('noteid', 'varchar', null, null, src(THING_NOTE, 2)),
          col('histid', 'varchar', null, null, src(THING_BASE, 2)),
          col('title', 'varchar', null, null, src(THING_BASE, 3)),
          col('created', 'datetime', null, null, src(THING_BASE, 4)),
        ],
        ...key(['histid']),
        primaryKeySource: src(THING_BASE, 2),
        ormEntity: { path: THING_NOTE, entityName: 'thingNote' },
      }),
    );
  });

  it('inventories nothing from unparsable, dynamic, query-of-queries, non-SQL Server or non-update sources', () => {
    expect(schema.tables.map((t) => t.table)).toEqual([
      'tbase',
      'tdialect',
      'tdropme',
      'tglobalsfix',
      'tkeyed',
      'tlater',
      'tthing',
      'tthingnote',
      'tutilnew',
    ]);
    expect(schema.counts).toEqual({
      bootstrap: 4,
      migration: 3,
      orm: 2,
      staticTotal: 9,
      retired: 2,
      liveStatic: 7,
      withSiteId: 4,
      withoutPrimaryKeyBootstrap: 2,
      withoutPrimaryKey: 1,
    });
    expect(schema.noPrimaryKeyBootstrap).toEqual(['tglobalsfix', 'tlater']);
    expect(schema.noPrimaryKey).toEqual(['tkeyed']);
  });

  it('reports the plan serialized columns as a correction when the tree computes none', () => {
    expect(schema.corrections).toEqual([
      {
        measure: 'serializedColumns',
        expected: ['tcontentobjects.params', 'tformresponsepackets.Data', 'toauthtokens.data', 'ttrash.objectstring'],
        computed: [],
      },
    ]);
    expect(schema.tables.filter((t) => 'expectedSerializedColumns' in t)).toEqual([]);
  });

  it('throws for an ORM table no component declares and leaves an undeclared bootstrap table without an entity', () => {
    const files = { [DDL]: 'CREATE TABLE [dbo].[tone] (\n\t[a] [int] NULL\n)\nGO\n', 'core/mura/x/xBean.cfc': 'component extends="mura.bean.beanORM" table="tother" {\n}\n' };
    expect(() => extractTables(memorySourceTree(files), ['tmissing'])).toThrow('ORM table tmissing has no entity declaration under core/mura');
    const one = extractTables(memorySourceTree(files), ['tone']);
    expect(one.tables).toEqual([
      staticEntry({
        table: 'tone',
        origin: 'bootstrap',
        source: src(DDL, 1, 3),
        createdBy: [{ dialect: 'mssql', path: DDL, lines: [1, 1] }],
        columns: [col('a', 'int', null, true, src(DDL, 2))],
        bootstrapHasPrimaryKey: false,
      }),
    ]);
  });
});

describe('extractTables serialized-document columns', () => {
  const docColumns = (files: Readonly<Record<string, string>>): string[] =>
    byTable(extractTables(memorySourceTree({ [DDL]: DOC_DDL, [DOC_BEAN]: DOC_ENTITY, ...files }), ['tdoc']).tables, 'tdoc').serializedColumns;

  it.each<[string, Record<string, string>, string[]]>([
    ['a deserialized member of a query naming the table', { [DOC_MANAGER]: scriptCfc('var rs = queryExecute("SELECT body FROM tdoc");\n\t\treturn deserializeJSON(rs.body);') }, ['body']],
    ['a bracketed member isJSON tests', { [DOC_MANAGER]: scriptCfc('var rs = queryExecute("SELECT meta FROM tdoc");\n\t\treturn isJSON(rs["meta"]);') }, ['meta']],
    [
      'a WDDX packet cfwddx reads',
      { [DOC_MANAGER]: tagCfc('<cfquery name="rs">SELECT notes FROM tdoc</cfquery>\n\t<cfwddx action="wddx2cfml" input="#rs.notes#" output="local.data">') },
      ['notes'],
    ],
    ['a getter of the entity getBean loads', { [DOC_MANAGER]: scriptCfc('var doc = getBean("doc").loadBy(docid=arguments.data.id);\n\t\treturn deserializeJSON(doc.getMeta());') }, ['meta']],
    [
      'a member the entity component deserializes itself',
      { [DOC_BEAN]: DOC_ENTITY.replace('}\n', '\tpublic any function getNotesData() {\n\t\treturn deserializeJSON(variables.instance.notes);\n\t}\n}\n') },
      ['notes'],
    ],
    [
      'an inserted serializeJSON value',
      {
        [DOC_MANAGER]: tagCfc(
          '<cfquery>\n\t\tINSERT INTO tdoc (docID, body)\n\t\tVALUES (<cfqueryparam value="#arguments.data.id#">, <cfqueryparam value="#serializeJSON(arguments.data)#">)\n\t</cfquery>',
        ),
      },
      ['body'],
    ],
    [
      'an inserted variable serializeJSON produced',
      {
        [DOC_MANAGER]: tagCfc(
          '<cfset var packed = serializeJSON(arguments.data)>\n\t<cfquery>\n\t\tINSERT INTO [dbo].[tdoc] ([docID], [meta])\n\t\tVALUES (<cfqueryparam value="#arguments.data.id#">, <cfqueryparam value="#packed#">)\n\t</cfquery>',
        ),
      },
      ['meta'],
    ],
    [
      'an updated WDDX packet',
      {
        [DOC_MANAGER]: tagCfc(
          '<cfwddx action="cfml2wddx" input="#arguments.data#" output="wddxPacket">\n\t<cfquery>\n\t\tUPDATE tdoc SET notes = <cfqueryparam value="#wddxPacket#">, label = <cfqueryparam value="#arguments.data.label#">\n\t\tWHERE docID = <cfqueryparam value="#arguments.data.id#">\n\t</cfquery>',
        ),
      },
      ['notes'],
    ],
    ['an updated serializeJSON value of a statement without WHERE', { [DOC_MANAGER]: scriptCfc('queryExecute("UPDATE tdoc SET body = \'#serializeJSON(arguments.data)#\'");') }, ['body']],
    ['no column for a bare scope variable', { [DOC_MANAGER]: scriptCfc('queryExecute("SELECT body FROM tdoc");\n\t\treturn deserializeJSON(arguments.body);') }, []],
    ['no column of a table the file does not name', { [DOC_MANAGER]: scriptCfc('var rs = queryExecute("SELECT body FROM tother");\n\t\treturn deserializeJSON(rs.body);') }, []],
    ['no column of a non-document type', { [DOC_MANAGER]: scriptCfc('var rs = queryExecute("SELECT label FROM tdoc");\n\t\treturn deserializeJSON(rs.label);') }, []],
    ['no column read under core/mura/lib', { 'core/mura/lib/docLib.cfc': scriptCfc('var rs = queryExecute("SELECT body FROM tdoc");\n\t\treturn deserializeJSON(rs.body);') }, []],
    [
      'no column of an INSERT ... SELECT or of writes to another table',
      {
        [DOC_MANAGER]: tagCfc(
          "<cfquery>\n\t\tINSERT INTO tdoc (docID, body) SELECT docID, '#serializeJSON(arguments.data)#' FROM tstage\n\t</cfquery>\n\t<cfquery>\n\t\tINSERT INTO tother (body) VALUES ('#serializeJSON(arguments.data)#')\n\t</cfquery>\n\t<cfquery>\n\t\tUPDATE tother SET body = '#serializeJSON(arguments.data)#'\n\t</cfquery>",
        ),
      },
      [],
    ],
  ])('marks %s', (_label, files, expected) => {
    expect(docColumns(files)).toEqual(expected);
  });

  it('reports no correction when the computed columns match the plan, in the case the DDL declares', () => {
    const plan = extractTables(memorySourceTree({ [DDL]: planDdl('Data'), [PLAN_READER]: planReader(true) }), []);
    expect(plan.tables.map((t) => [t.table, t.serializedColumns])).toEqual([
      ['tcontentobjects', ['params']],
      ['tformresponsepackets', ['Data']],
      ['toauthtokens', ['data']],
      ['ttrash', ['objectstring']],
    ]);
    expect(plan.corrections).toEqual([]);
    expect(plan.tables.filter((t) => 'expectedSerializedColumns' in t)).toEqual([]);
  });

  it('records the expected columns on a table whose computed columns differ from the plan', () => {
    const plan = extractTables(memorySourceTree({ [DDL]: planDdl('DATA'), [PLAN_READER]: planReader(false) }), []);
    expect(plan.corrections).toEqual([
      {
        measure: 'serializedColumns',
        expected: ['tcontentobjects.params', 'tformresponsepackets.DATA', 'toauthtokens.data', 'ttrash.objectstring'],
        computed: ['tcontentobjects.params', 'tformresponsepackets.DATA', 'ttrash.objectstring'],
      },
    ]);
    expect(byTable(plan.tables, 'toauthtokens').expectedSerializedColumns).toEqual(['data']);
    expect(plan.tables.filter((t) => 'expectedSerializedColumns' in t).map((t) => t.table)).toEqual(['toauthtokens']);
  });
});

describe('fetchLiveCatalog', () => {
  it('reads base tables, ordered columns and primary keys with read-only SQL, skipping the coordination schema', async () => {
    const seen: string[] = [];
    const tables = await fetchLiveCatalog(catalogDb(catalogRows(), seen));
    expect(seen).toHaveLength(3);
    for (const sql of seen) expect(() => assertReadOnlySql(sql)).not.toThrow();
    const c = (name: string, type: string, length: number | 'max' | null, nullable: boolean): LiveCatalogTable['columns'][number] => ({ name, type, length, nullable });
    expect(tables).toEqual([
      {
        schema: 'Program_1',
        name: 'tprogram',
        columns: [c('programID', 'char', 35, false), c('siteID', 'nvarchar', 25, false)],
        primaryKey: ['programID'],
        hasPrimaryKey: true,
        hasSiteId: true,
      },
      {
        schema: 'Program_2',
        name: 'tprogram',
        columns: [c('programID', 'char', 35, false), c('SiteID', 'nvarchar', 25, false), c('extra', 'int', null, true)],
        primaryKey: [],
        hasPrimaryKey: false,
        hasSiteId: true,
      },
      { schema: 'dbo', name: 'fb_survey', columns: [c('surveyID', 'char', 35, false)], primaryKey: ['surveyID'], hasPrimaryKey: true, hasSiteId: false },
      {
        schema: 'dbo',
        name: 'tFixtureNoPK',
        columns: [c('fixtureID', 'char', 35, false), c('label', 'nvarchar', 50, true)],
        primaryKey: ['fixtureID'],
        hasPrimaryKey: true,
        hasSiteId: false,
      },
      { schema: 'dbo', name: 'tdeclaredthing', columns: [c('id', 'char', 35, false)], primaryKey: [], hasPrimaryKey: false, hasSiteId: false },
      {
        schema: 'dbo',
        name: 'tfixture',
        columns: [
          c('fixtureID', 'char', 35, false),
          c('SiteID', 'nvarchar', 25, true),
          c('userID', 'char', 35, true),
          c('name', 'nvarchar', 100, true),
          c('notes', 'nvarchar', 'max', true),
          c('sortOrder', 'int', null, true),
          c('tablist', 'nvarchar', 'max', true),
        ],
        primaryKey: ['fixtureID'],
        hasPrimaryKey: true,
        hasSiteId: true,
      },
      {
        schema: 'dbo',
        name: 'tfixturemigrated',
        columns: [c('migratedID', 'char', 35, false), c('siteID', 'nvarchar', 25, true), c('label', 'nvarchar', 50, true)],
        primaryKey: ['migratedID', 'siteID'],
        hasPrimaryKey: true,
        hasSiteId: true,
      },
      {
        schema: 'dbo',
        name: 'tfixturestats',
        columns: [c('statID', 'char', 35, false), c('siteid', 'nvarchar', 25, true), c('data', 'ntext', 1073741823, true)],
        primaryKey: [],
        hasPrimaryKey: false,
        hasSiteId: true,
      },
      { schema: 'dbo', name: 'tstray', columns: [c('strayID', 'int', null, false), c('SITEID', 'nvarchar', 25, true)], primaryKey: [], hasPrimaryKey: false, hasSiteId: true },
      {
        schema: 'synthetic',
        name: 'timesheet',
        columns: [c('timesheetID', 'uniqueidentifier', null, false), c('siteid', 'nvarchar', 25, false)],
        primaryKey: ['timesheetID'],
        hasPrimaryKey: true,
        hasSiteId: true,
      },
    ]);
  });

  it.each<[string, (rows: CatalogRows) => void]>([
    ['table', (rows) => rows.tables.push({ TABLE_SCHEMA: 'dbo', TABLE_NAME: '' })],
    ['column', (rows) => rows.columns.push({ ...catalogColumn('dbo', 'tfixture', 'flag', 'bit', null, 'NO', 8), IS_NULLABLE: 'MAYBE' })],
    ['primary-key', (rows) => rows.keys.push({ ...catalogKey('dbo', 'tfixture', 'fixtureID', 1), ORDINAL_POSITION: 'first' })],
  ])('rejects malformed %s rows', async (label, corrupt) => {
    const rows = catalogRows();
    corrupt(rows);
    await expect(fetchLiveCatalog(catalogDb(rows, []))).rejects.toThrow(`live catalog ${label} rows are malformed`);
  });
});

describe('mergeLiveCatalog', () => {
  it('lets the live catalog govern the key flag and records each static table live state', () => {
    const state = (t: string): Pick<TableEntry, 'hasPrimaryKey' | 'live' | 'liveStatus'> => {
      const e = byTable(merged, t);
      return { hasPrimaryKey: e.hasPrimaryKey, live: e.live, liveStatus: e.liveStatus };
    };
    expect(state('tfixture')).toEqual({
      hasPrimaryKey: true,
      live: {
        present: true,
        instances: ['dbo.tfixture'],
        columns: ['fixtureID', 'SiteID', 'userID', 'name', 'notes', 'sortOrder', 'tablist'],
        primaryKey: ['fixtureID'],
        hasPrimaryKey: true,
        hasSiteId: true,
      },
      liveStatus: 'live',
    });
    expect(state('tfixturenopk')).toMatchObject({ hasPrimaryKey: true, live: { instances: ['dbo.tFixtureNoPK'], primaryKey: ['fixtureID'] } });
    expect(state('tfixturemigrated')).toMatchObject({ hasPrimaryKey: true, live: { primaryKey: ['migratedID', 'siteID'] } });
    expect(state('tfixturestats')).toMatchObject({ hasPrimaryKey: false, live: { hasPrimaryKey: false } });
    expect(state('tfixtureversioned')).toEqual({
      hasPrimaryKey: true,
      live: { present: false, instances: [], columns: [], primaryKey: [], hasPrimaryKey: null, hasSiteId: null },
      liveStatus: 'live',
    });
    expect(byTable(merged, 'tfixturenopk').staticHasPrimaryKey).toBe(false);
  });

  it('adds live-only tables, folding Program_<id> instances into one Program_N entry', () => {
    expect(merged.map((t) => [t.id, t.origin, t.schema])).toEqual([
      ['tbl:Program_N.tprogram', 'fixture', 'Program_N'],
      ['tbl:fb_survey', 'dynamic', 'dbo'],
      ['tbl:synthetic.timesheet', 'fixture', 'synthetic'],
      ['tbl:tdeclaredthing', 'dynamic', 'dbo'],
      ['tbl:tfixture', 'bootstrap', 'dbo'],
      ['tbl:tfixturemigrated', 'migration', 'dbo'],
      ['tbl:tfixturenopk', 'bootstrap', 'dbo'],
      ['tbl:tfixturestats', 'bootstrap', 'dbo'],
      ['tbl:tfixtureversioned', 'orm', 'dbo'],
      ['tbl:tstray', 'live-only', 'dbo'],
    ]);
    const liveCol = (name: string, type: string, length: number | null, nullable: boolean): TableColumn => ({ name, type, length, nullable, source: LIVE_TABLE_SOURCE });
    const liveOnly = (fields: Pick<TableEntry, 'table' | 'schema' | 'origin' | 'columns' | 'live'> & Partial<TableEntry>): TableEntry =>
      staticEntry({ source: LIVE_TABLE_SOURCE, createdBy: [], staticHasPrimaryKey: null, liveStatus: 'live', ...fields });
    expect(byTable(merged, 'Program_N.tprogram')).toEqual(
      liveOnly({
        table: 'Program_N.tprogram',
        schema: 'Program_N',
        origin: 'fixture',
        columns: [liveCol('programID', 'char', 35, false), liveCol('siteID', 'nvarchar', 25, false)],
        ...site('siteID', LIVE_TABLE_SOURCE),
        primaryKey: ['programID'],
        live: {
          present: true,
          instances: ['Program_1.tprogram', 'Program_2.tprogram'],
          columns: ['programID', 'siteID', 'extra'],
          primaryKey: ['programID'],
          hasPrimaryKey: false,
          hasSiteId: true,
        },
      }),
    );
    expect(byTable(merged, 'tstray')).toEqual(
      liveOnly({
        table: 'tstray',
        schema: 'dbo',
        origin: 'live-only',
        columns: [liveCol('strayID', 'int', null, false), liveCol('SITEID', 'nvarchar', 25, true)],
        ...site('SITEID', LIVE_TABLE_SOURCE),
        live: { present: true, instances: ['dbo.tstray'], columns: ['strayID', 'SITEID'], primaryKey: [], hasPrimaryKey: false, hasSiteId: true },
      }),
    );
    expect(byTable(merged, 'fb_survey')).toMatchObject({ hasPrimaryKey: true, primaryKey: ['surveyID'], hasSiteId: false, siteIdSource: null });
  });

  it('classifies a table as dynamic only when it is a form-builder table or a declared entity table', () => {
    expect(byTable(mergeLiveCatalog(extraction.tables, live), 'tdeclaredthing').origin).toBe('live-only');
  });

  it('resets to the static entries pending a live run when the catalog is null', () => {
    expect(mergeLiveCatalog(merged, null)).toEqual(extraction.tables);
  });
});

describe('tableOwnershipSchema and loadTableOwnership', () => {
  it('loads a pinned ownership file and passes unread keys through', () => {
    expect(ownership).toEqual(ownershipDoc(pinnedSha()));
  });

  it('rejects a file whose sourceSha differs from the source pin', async () => {
    const file = path.join(root, 'table-ownership.stale.json');
    const stale = '0'.repeat(40);
    await writeFile(file, JSON.stringify(ownershipDoc(stale)));
    await expect(loadTableOwnership(file)).rejects.toThrow(`${file}: sourceSha "${stale}" differs from the pinned SHA ${pinnedSha()}`);
  });

  it.each<[string, (doc: OwnershipDoc) => void, Array<string | number>, string]>([
    [
      'a table listed twice under another spelling',
      (doc) => doc.tables.push({ table: 'dbo.TFIXTURE', owner: 'people', ruleSteps: [1], targets: [] }),
      ['tables', 9, 'table'],
      'duplicate table dbo.TFIXTURE',
    ],
    [
      'a target unit missing from units',
      (doc) => doc.tables[0]?.targets.push({ unit: 'people.ghost', owner: 'people' }),
      ['tables', 0, 'targets', 1, 'unit'],
      'unit people.ghost is not listed in units',
    ],
  ])('flags %s', async (_label, corrupt, issuePath, message) => {
    const doc = ownershipDoc(pinnedSha());
    corrupt(doc);
    const parsed = tableOwnershipSchema.safeParse(doc);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => [i.path, i.message])).toEqual([[issuePath, message]]);
    const file = path.join(root, `table-ownership.${issuePath.join('-')}.json`);
    await writeFile(file, JSON.stringify(doc));
    await expect(loadTableOwnership(file)).rejects.toThrow(/does not match its schema/);
    await expect(loadTableOwnership(file)).rejects.toThrow(message);
  });

  it('refuses a rule step outside the five ownership steps', () => {
    const doc = ownershipDoc(pinnedSha());
    const first = doc.tables[0];
    if (first !== undefined) first.ruleSteps = [6];
    const parsed = tableOwnershipSchema.safeParse(doc);
    expect(parsed.error?.issues.map((i) => [i.path, i.code])).toEqual([[['tables', 0, 'ruleSteps', 0], 'too_big']]);
  });
});

describe('assignOwners', () => {
  it('sets owner, rule steps, target units, split and decision reference by exact name, pattern and declared-entity fallback', () => {
    const owned = assignOwners(
      merged.filter((t) => t.table !== 'tstray'),
      ownership,
    );
    expect(owned.map((t) => [t.table, t.owningService, t.ownershipRuleStep, t.targetUnits, t.split, t.decisionListRef])).toEqual([
      ['Program_N.tprogram', 'programs-sites', [1, 4], ['programs_sites.program'], null, null],
      ['fb_survey', 'strategies-content', [1], ['content.form_entity'], null, null],
      ['synthetic.timesheet', 'timesheets', [1], ['timesheets.timesheet'], null, null],
      ['tdeclaredthing', 'decision-list', [5], [], null, 'dl:tentity'],
      ['tfixture', 'identity', [1], ['identity.fixture'], { by: 'Type', rows: { '1': 'identity' } }, null],
      ['tfixturemigrated', 'people', [1, 3], ['people.person'], null, null],
      ['tfixturenopk', 'decision-list', [5], [], null, 'dl:tfixturenopk'],
      ['tfixturestats', 'reporting', [1], [], null, null],
      ['tfixtureversioned', 'identity', [1], [], null, null],
    ]);
    expect(owned.map((t) => [t.table, t.source])).toEqual([
      ['Program_N.tprogram', LIVE_TABLE_SOURCE],
      ['fb_survey', FORM_SOURCE],
      ['synthetic.timesheet', TIMESHEET_SOURCE],
      ['tdeclaredthing', LIVE_TABLE_SOURCE],
      ['tfixture', src(DDL, 2, 7)],
      ['tfixturemigrated', src(UPDATE_EXCERPT, 3, 7)],
      ['tfixturenopk', src(DDL, 10, 13)],
      ['tfixturestats', src(DDL, 16, 20)],
      ['tfixtureversioned', src(VERSIONED_BEAN, 2, 2)],
    ]);
    expect(merged.every((t) => t.owningService === null)).toBe(true);
  });

  it('throws naming every table the ownership file does not assign, in name order', () => {
    const stray = byTable(merged, 'tstray');
    const extra = [{ ...stray, id: 'tbl:tzeta', table: 'tzeta' }, { ...stray, id: 'tbl:talpha', table: 'talpha' }];
    expect(() => assignOwners([...merged, ...extra], ownership)).toThrow('table ownership assigns no owner to talpha, tstray, tzeta');
  });

  it('assigns a dynamic table nothing when no declared-entity pattern is listed', () => {
    const withoutDeclared = { ...ownership, tables: ownership.tables.filter((t) => t.table !== 'tentity-declared:*') };
    expect(() => assignOwners([byTable(merged, 'tdeclaredthing'), byTable(merged, 'fb_survey')], withoutDeclared)).toThrow(
      'table ownership assigns no owner to tdeclaredthing',
    );
  });
});

describe('attachWriters', () => {
  const daoUpdate = src(DAO, 20, 22);
  const daoCreate = src(DAO, 7, 12);
  const daoTrack = src(DAO, 38, 39);
  const daoRelabel = src(DAO, 50, 52);
  const purge = src(MANAGER, 9);
  const rename = src(MANAGER, 5);
  const relogin = src(MANAGER, 19);
  const jobSource = src(MANAGER, 1, 26);

  const evidence: WriteEvidence[] = [
    {
      entryRouteKey: 'admin:cfixture.update',
      trigger: 'request',
      closure: closureOf(
        [
          closureWrite('tfixture', 'update', DAO, 'update', daoUpdate, { whereParams: ['userid'] }),
          closureWrite('tfixture', 'delete', MANAGER, 'purgeSite', purge, { whereParams: ['siteid'], conditional: true }),
          closureWrite('tfixture', 'update', MANAGER, 'rename', rename, { whereParams: ['userid'], conditional: true }),
          closureWrite('tfixturestats', 'insert', DAO, 'trackAsync', daoTrack, { trigger: 'thread', whereParams: ['siteid'] }),
          closureWrite('tusers', 'update', MANAGER, 'refreshLogin', relogin, { whereParams: ['userid'] }),
          closureWrite(null, 'update', DAO, 'dynamicWrite', src(DAO, 44, 46), { dynamic: true }),
        ],
        [
          { table: 'tfixture', condition: 'rc.purge eq true', source: purge },
          { table: 'tfixture', condition: 'rc.rename', source: rename },
        ],
      ),
    },
    {
      entryRouteKey: 'api:fixture.save',
      trigger: 'request',
      closure: closureOf(
        [
          closureWrite('TFixture', 'update', DAO, 'update', daoUpdate, { whereParams: ['userid'] }),
          closureWrite('tfixture', 'delete', MANAGER, 'purgeSite', purge, { whereParams: ['siteid'], conditional: true }),
          closureWrite('tfixture', 'insert', DAO, 'create', daoCreate, { conditional: true }),
          closureWrite('tfixturenopk', 'update', DAO, 'relabel', daoRelabel, { conditional: true }),
          closureWrite('tusers', 'update', MANAGER, 'refreshLogin', relogin, { whereParams: ['userid'] }),
        ],
        [{ table: 'dbo.tfixture', condition: 'arguments.force', source: purge }],
      ),
    },
    {
      entryRouteKey: null,
      trigger: 'appstart',
      closure: closureOf(
        [
          closureWrite('dbo.tFixtureNoPK', 'insert', SETUP, '', src(SETUP, 3), { whereParams: ['siteid'] }),
          closureWrite('Program_2.tprogram', 'insert', SETUP, '', src(SETUP, 5)),
          closureWrite('tfixture', 'insert', DAO, 'create', daoCreate, { conditional: true }),
        ],
        [{ table: 'tfixture', condition: 'application.setupComplete', source: daoCreate }],
      ),
    },
    {
      entryRouteKey: 'admin:cfixture.rename',
      trigger: 'request',
      closure: closureOf([closureWrite('tfixture', 'update', MANAGER, 'rename', rename, { whereParams: ['userid'], override: 'wov:rename-settled' })]),
    },
  ];

  const inlineOverrides = (sourceSha: string): WriterOverrides =>
    parseWriterOverrides(
      stringify({
        sourceSha,
        writers: [
          {
            id: 'wov:dao-update-relogin',
            tables: ['tfixture'],
            component: DAO,
            method: 'update',
            op: 'update',
            source: daoUpdate,
            routeKeys: ['API:User.Save'],
            keyScope: ['UserID', 'siteid'],
            trigger: 'request',
            sessionEffects: 'relogin',
            condition: 'rc.relogin',
            columns: ['name'],
            noGroupJoin: true,
            reason: 'The DAO update re-logs the saved user in.',
          },
          {
            id: 'wov:create-scheduler',
            tables: ['tfixture'],
            component: DAO,
            method: 'create',
            op: 'insert',
            source: daoCreate,
            routeKeys: [],
            keyScope: ['siteid'],
            trigger: 'scheduler',
            sessionEffects: 'none',
            preventedBy: 'scheduler-registration',
            reason: 'A scheduled task runs the create.',
          },
          {
            id: 'wov:stats-job',
            tablesFrom: { job: 'job:sitemonitor' },
            component: MANAGER,
            method: null,
            op: 'delete',
            source: jobSource,
            routeKeys: [],
            keyScope: 'table',
            trigger: 'scheduler',
            sessionEffects: 'none',
            preventedBy: 'native-sitemonitor-task',
            dynamic: false,
            reason: 'The site monitor purges the step tables.',
          },
        ],
      }),
      'inline writer overrides',
    );

  const entryPoints = {
    jobs: [{ id: 'job:sitemonitor', steps: [{ tables: ['tfixturestats', 'tfixture'] }, { tables: ['tfixturestats', 'tghost'] }] }],
  };

  let attached: ReturnType<typeof attachWriters>;

  beforeAll(async () => {
    const fixtureOverrides = await loadWriterOverrides(fixturePath('inventory/writer-overrides.valid.yaml'));
    const inline = inlineOverrides(fixtureOverrides.sourceSha);
    attached = attachWriters(merged, evidence, { ...inline, writers: [...inline.writers, ...fixtureOverrides.writers] }, entryPoints);
  });

  it('keys writers by component, method, lines, op and trigger, uniting route keys and guard conditions', () => {
    expect(byTable(attached.tables, 'tfixture').writers).toEqual([
      writer({
        component: DAO,
        method: 'create',
        source: daoCreate,
        op: 'insert',
        routeKeys: ['api:fixture.save'],
        keyScope: ['siteid'],
        trigger: 'scheduler',
        condition: 'application.setupComplete',
        override: 'wov:create-scheduler',
        preventedBy: 'scheduler-registration',
      }),
      writer({
        component: DAO,
        method: 'update',
        source: daoUpdate,
        op: 'update',
        routeKeys: ['admin:cfixture.update', 'api:fixture.save', 'api:user.save'],
        keyScope: ['userid', 'siteid'],
        sessionEffects: 'relogin',
        condition: 'rc.relogin',
        override: 'wov:dao-update-relogin',
        columns: ['name'],
        noGroupJoin: true,
      }),
      writer({
        component: MANAGER,
        method: TEMPLATE_METHOD,
        source: jobSource,
        op: 'delete',
        trigger: 'scheduler',
        override: 'wov:stats-job',
        preventedBy: 'native-sitemonitor-task',
        dynamic: false,
      }),
      writer({
        component: MANAGER,
        method: 'purgeSite',
        source: purge,
        op: 'delete',
        routeKeys: ['admin:cfixture.update', 'api:fixture.save'],
        keyScope: ['siteid'],
        condition: 'arguments.force || rc.purge eq true',
      }),
      writer({
        component: MANAGER,
        method: 'rename',
        source: rename,
        op: 'update',
        routeKeys: ['admin:cfixture.rename', 'admin:cfixture.update'],
        keyScope: ['userid'],
        override: 'wov:rename-settled',
      }),
    ]);
  });

  it('keeps a reached non-request trigger and bounds such writers by the whole table', () => {
    expect(byTable(attached.tables, 'tfixturestats').writers).toEqual([
      writer({ component: DAO, method: 'trackAsync', source: daoTrack, op: 'insert', routeKeys: ['admin:cfixture.update'], trigger: 'thread' }),
      writer({
        component: MANAGER,
        method: TEMPLATE_METHOD,
        source: jobSource,
        op: 'delete',
        trigger: 'scheduler',
        override: 'wov:stats-job',
        preventedBy: 'native-sitemonitor-task',
        dynamic: false,
      }),
      writer({
        component: MANAGER,
        method: 'trackStats',
        source: src(MANAGER, 12, 16),
        op: 'insert',
        keyScope: ['siteid'],
        trigger: 'thread',
        override: 'wov:fixture-thread',
      }),
    ]);
    expect(byTable(attached.tables, 'tfixturenopk').writers).toEqual([
      writer({ component: DAO, method: 'relabel', source: daoRelabel, op: 'update', routeKeys: ['api:fixture.save'] }),
      writer({ component: SETUP, method: TEMPLATE_METHOD, source: src(SETUP, 3), op: 'insert', trigger: 'appstart' }),
    ]);
    expect(byTable(attached.tables, 'Program_N.tprogram').writers).toEqual([
      writer({ component: SETUP, method: TEMPLATE_METHOD, source: src(SETUP, 5), op: 'insert', trigger: 'appstart' }),
    ]);
    expect(byTable(attached.tables, 'tfixtureversioned').writers).toEqual([]);
  });

  it('returns writes and override tables without an inventory entry as unmatched, once each', () => {
    expect(attached.unmatched).toEqual([
      { table: 'tghost', component: MANAGER, method: TEMPLATE_METHOD, source: jobSource, override: 'wov:stats-job' },
      { table: 'tusers', component: MANAGER, method: 'refreshLogin', source: src(MANAGER, 18, 20), override: 'wov:fixture-relogin' },
      { table: 'tusers', component: MANAGER, method: 'refreshLogin', source: relogin, override: null },
    ]);
    expect(attached.tables.flatMap((t) => t.writers).some((w) => w.method === 'dynamicWrite')).toBe(false);
    expect(attached.tables.map((t) => t.table)).toEqual(merged.map((t) => t.table));
  });

  it('throws for a tablesFrom override whose job no entry point lists', () => {
    const overrides = inlineOverrides(pinnedSha());
    expect(() => attachWriters(merged, [], overrides)).toThrow('writer override wov:stats-job takes its tables from job:sitemonitor, which no entry point lists');
  });

  it('attaches the writes computeClosure reaches through the committed manager and DAO', async () => {
    const overrides = await loadWriterOverrides(fixturePath('inventory/writer-overrides.valid.yaml'));
    const ctx = { tree, index: fixtureIndex(tree), overrides };
    const renamed = computeClosure({ component: MANAGER, method: 'rename' }, ctx);
    const tracked = computeClosure({ component: DAO, method: 'trackAsync' }, ctx);
    const relogged = computeClosure({ component: MANAGER, method: 'refreshLogin' }, ctx);
    const result = attachWriters(
      extraction.tables,
      [
        { entryRouteKey: 'admin:cfixture.rename', trigger: 'request', closure: renamed },
        { entryRouteKey: 'admin:cfixture.track', trigger: 'request', closure: tracked },
        { entryRouteKey: 'api:user.save', trigger: 'request', closure: relogged },
      ],
      overrides,
    );
    expect(byTable(result.tables, 'tfixture').writers).toEqual([
      writer({ component: MANAGER, method: 'rename', source: src(MANAGER, 5), op: 'update', routeKeys: ['admin:cfixture.rename'], keyScope: ['userid'] }),
    ]);
    expect(byTable(result.tables, 'tfixturestats').writers).toEqual([
      writer({ component: DAO, method: 'trackAsync', source: src(DAO, 38, 39), op: 'insert', routeKeys: ['admin:cfixture.track'], trigger: 'thread' }),
      writer({
        component: MANAGER,
        method: 'trackStats',
        source: src(MANAGER, 12, 16),
        op: 'insert',
        keyScope: ['siteid'],
        trigger: 'thread',
        override: 'wov:fixture-thread',
      }),
    ]);
    expect(result.unmatched).toEqual([
      { table: 'tusers', component: MANAGER, method: 'refreshLogin', source: src(MANAGER, 18, 20), override: 'wov:fixture-relogin' },
    ]);
  });
});
