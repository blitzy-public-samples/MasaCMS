// Unit tests for the dependency order of the legacy tables, over the fixture inventory and catalog, inline inventories and the committed inventory.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseProgramTable } from '@opt2/platform/migration-kit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import {
  DependencyOrderError,
  EXPECTED_HEAD,
  MIGRATION_ORDER_REPORT,
  PROGRAM_SITE_TABLE,
  SITE_ROOT_TABLE,
  buildDependencyOrder,
  compareTableNames,
  computeDependencyOrder,
  loadOrderInventory,
  parentOf,
  toMigrationOrderReport,
  writeMigrationOrderReport,
} from '../../src/order/index.js';
import type {
  DependencyOrder,
  OrderCatalog,
  OrderInventory,
  OrderRelation,
  OrderRelationKind,
  TableRef,
  TenantFrom,
} from '../../src/order/index.js';
import { UnitCatalogError, UnknownLegacyTableError, loadUnitCatalog } from '../../src/owners/index.js';
import type { DataOwner, LegacyTableOwner, Unit } from '../../src/owners/index.js';
import { resolveReportTarget } from '../../src/reports/index.js';
import type { ReportClock, ReportTarget } from '../../src/reports/index.js';
import { TEST_SOURCE_SHA, createTestDirs } from '../helpers/env.js';
import type { TestDirs } from '../helpers/env.js';
import { FIXTURE_CATALOG, FIXTURE_INVENTORY, PROGRAM_SITES, writeInventoryFile } from '../helpers/fixtures.js';

/** One ownership entry of the fake catalog; a table migrates when it has owners. */
interface FakeTable {
  readonly owner: LegacyTableOwner;
  readonly owners?: readonly DataOwner[];
  readonly keyColumns?: readonly string[];
}

/** Catalog over lower-case `tables` keys, folding `Program_<id>` names onto `program_n.<table>` as the unit catalog does. */
function fakeCatalog(tables: Readonly<Record<string, FakeTable>>, units: readonly Unit[] = []): OrderCatalog {
  const entry = (table: string): FakeTable => {
    const program = parseProgramTable(table);
    const key = program === null ? table.replace(/^dbo\./i, '').toLowerCase() : `program_n.${program.table.toLowerCase()}`;
    const found = Object.hasOwn(tables, key) ? tables[key] : undefined;
    if (found === undefined) throw new UnknownLegacyTableError(table);
    return found;
  };
  const owners = (table: string): readonly DataOwner[] => entry(table).owners ?? [];
  return {
    units: () => units,
    legacyTablesOf: (unitId) => {
      const unit = units.find(({ id }) => id === unitId);
      if (unit === undefined) throw new Error(`fake catalog: unknown unit ${unitId}`);
      return unit.legacyTables;
    },
    isMigratable: (table) => owners(table).length > 0,
    isSplit: (table) => entry(table).owner === 'split',
    ownersForLegacyTable: owners,
    legacyTableOwner: (table) => entry(table).owner,
    keyColumnsOf: (table) => {
      if (owners(table).length === 0) throw new UnitCatalogError(`legacy table ${table} is not migratable`);
      return entry(table).keyColumns ?? [];
    },
  };
}

/** `<table>.<column>`, split at the last dot so schema-qualified and bracketed tables keep theirs. */
function ref(qualified: string): TableRef {
  const dot = qualified.lastIndexOf('.');
  return { table: qualified.slice(0, dot), column: qualified.slice(dot + 1) };
}

function relation(id: string, kind: OrderRelationKind, child: string, parent: string, source?: OrderRelation['source']): OrderRelation {
  const base = { id, kind, child: ref(child), parent: ref(parent) };
  return source === undefined ? base : { ...base, source };
}

function unsited(...tables: string[]): OrderInventory['tables'] {
  return tables.map((table) => ({ table, hasSiteId: false }));
}

/** Entries of `owner` keyed by table, each with its key columns. */
function ownedBy(owner: DataOwner, keyColumns: Readonly<Record<string, readonly string[]>>): Record<string, FakeTable> {
  return Object.fromEntries(Object.entries(keyColumns).map(([table, keys]) => [table, { owner, owners: [owner], keyColumns: keys }]));
}

const CLOCK: ReportClock = { now: () => new Date('2026-03-04T05:06:07.000Z') };
const INTEREST_SOURCE: NonNullable<OrderRelation['source']> = { path: 'core/mura/user/userDAO.cfc', lines: [40, 44] };

const MAIN_TABLES: Readonly<Record<string, FakeTable>> = {
  tsettings: { owner: 'programs-sites', owners: ['programs-sites'], keyColumns: ['SiteID'] },
  'synthetic.program_site': { owner: 'programs-sites', keyColumns: ['program_id'] },
  tusers: { owner: 'split', owners: ['identity', 'people'], keyColumns: ['UserID'] },
  tusersmemb: { owner: 'identity', owners: ['identity'], keyColumns: ['UserID', 'GroupID'] },
  tpermissions: { owner: 'identity', owners: ['identity'], keyColumns: ['ContentID', 'GroupID', 'SiteID'] },
  tusersinterests: { owner: 'people', owners: ['people'], keyColumns: ['userID', 'categoryID'] },
  ...ownedBy('strategies-content', {
    tcontent: ['tcontent_ID'],
    tcontentcategories: ['categoryID'],
    tcontentcategoryassign: ['contentHistID', 'categoryID'],
    tapprovalchains: ['chainID'],
    tapprovalrequests: ['requestID'],
  }),
  tjobqueue: { owner: 'reporting', owners: ['reporting'], keyColumns: ['jobID'] },
  'program_n.grant': { owner: 'finance', owners: ['finance'], keyColumns: ['grant_id'] },
  'program_n.award': { owner: 'finance', owners: ['finance'], keyColumns: ['award_id'] },
  tplugins: { owner: 'decision-list' },
  tglobals: { owner: 'retired' },
};

const MAIN_UNITS: readonly Unit[] = [
  { id: 'content.category', owner: 'strategies-content', schema: 'content', legacyTables: ['tcontentcategories'] },
  { id: 'finance.grant', owner: 'finance', schema: 'finance', legacyTables: ['Program_N.grant'] },
];

const MAIN_INVENTORY: OrderInventory = {
  tables: [
    { table: 'tsettings', hasSiteId: true },
    { table: 'tusers', hasSiteId: true },
    { table: 'tusersmemb', hasSiteId: false },
    { table: 'dbo.tpermissions', hasSiteId: true },
    { table: 'tusersinterests', hasSiteId: false },
    { table: 'tcontent', hasSiteId: true },
    { table: 'tcontentcategoryassign', hasSiteId: false },
    { table: 'tapprovalchains', hasSiteId: true },
    { table: 'tapprovalrequests', hasSiteId: false },
    { table: 'tjobqueue', hasSiteId: false },
    { table: 'Program_N.grant', hasSiteId: false },
    { table: 'Program_N.award', hasSiteId: false },
    { table: 'tplugins', hasSiteId: true },
    { table: 'tglobals', hasSiteId: false },
  ],
  relations: [
    relation('orm:approvalChain.site', 'beanORM', 'tapprovalchains.siteID', 'tsettings.siteID'),
    relation('dao:approvalRequest.chain', 'daoJoin', 'tapprovalrequests.chainID', 'tapprovalchains.chainID'),
    relation('orm:approvalRequest.chain', 'beanORM', 'tapprovalrequests.ChainID', 'tapprovalchains.chainID'),
    relation('dao:membership.user', 'daoJoin', 'tusersmemb.UserID', 'tusers.UserID'),
    relation('dao:membership.group', 'daoJoin', 'tusersmemb.GroupID', 'tusers.UserID'),
    relation('dao:permission.group', 'daoJoin', 'tpermissions.GroupID', 'tusers.UserID'),
    relation('dao:interest.user', 'daoJoin', 'tusersinterests.userID', 'tusers.UserID', INTEREST_SOURCE),
    relation('dao:interest.category', 'daoJoin', 'tusersinterests.categoryID', 'tcontentcategories.categoryID'),
    relation('dao:category.site', 'daoJoin', 'tcontentcategories.SiteID', 'tsettings.SiteID'),
    relation('dao:assign.content', 'daoJoin', 'tcontentcategoryassign.contentID', 'tcontent.contentID'),
    relation('orm:assign.category', 'beanORM', 'tcontentcategoryassign.categoryID', 'tcontentcategories.categoryID'),
    relation('dao:content.parent', 'daoJoin', 'tcontent.ParentID', 'tcontent.ContentID'),
    relation('dao:job.parent', 'daoJoin', 'tjobqueue.ParentJobID', 'tjobqueue.JobID'),
    relation('fixture:award.grant', 'programFk', 'Program_N.award.grant_id', '[Program_N].[Grant].grant_id'),
    relation('dao:plugin.user', 'daoJoin', 'tplugins.ModuleID', 'tusers.UserID'),
    relation('dao:globals.content', 'daoJoin', 'tcontent.GlobalID', 'tglobals.GlobalID'),
  ],
};

const MAIN_CATALOG = fakeCatalog(MAIN_TABLES, MAIN_UNITS);

/** Table, schema, owner, tenant source and parents of each entry, in order. */
const MAIN_ENTRIES: readonly (readonly [string, string, string, TenantFrom, readonly string[]])[] = [
  ['tsettings', 'dbo', 'programs-sites', 'siteID', []],
  ['tusers', 'dbo', 'split', 'siteID', ['tsettings']],
  ['tpermissions', 'dbo', 'identity', 'siteID', ['tsettings', 'tusers']],
  ['tusersmemb', 'dbo', 'identity', 'parent', ['tusers']],
  // A parent loads with its earliest child: the category pool ahead of the interests that reference it.
  ['tcontentcategories', 'dbo', 'strategies-content', 'siteID', ['tsettings']],
  ['tusersinterests', 'dbo', 'people', 'parent', ['tcontentcategories', 'tusers']],
  ['tcontent', 'dbo', 'strategies-content', 'siteID', ['tsettings']],
  ['tcontentcategoryassign', 'dbo', 'strategies-content', 'parent', ['tcontent', 'tcontentcategories']],
  ['tapprovalchains', 'dbo', 'strategies-content', 'siteID', ['tsettings']],
  ['tapprovalrequests', 'dbo', 'strategies-content', 'parent', ['tapprovalchains']],
  ['tjobqueue', 'dbo', 'reporting', 'umbrella', []],
  ['synthetic.program_site', 'synthetic', 'programs-sites', 'siteID', ['tsettings']],
  ['Program_1.grant', 'Program_1', 'finance', 'parent', ['synthetic.program_site']],
  ['Program_1.award', 'Program_1', 'finance', 'parent', ['Program_1.grant', 'synthetic.program_site']],
  ['Program_2.grant', 'Program_2', 'finance', 'parent', ['synthetic.program_site']],
  ['Program_2.award', 'Program_2', 'finance', 'parent', ['Program_2.grant', 'synthetic.program_site']],
];

const PAIR_INVENTORY: OrderInventory = {
  tables: unsited('tbeta', 'talpha'),
  relations: [
    relation('dao:beta.alpha', 'daoJoin', 'tbeta.AlphaID', 'talpha.AlphaID'),
    relation('dao:alpha.beta', 'daoJoin', 'talpha.BetaID', 'tbeta.BetaID'),
  ],
};

const MIRRORED_RELATIONS: readonly OrderRelation[] = [
  relation('orm:gamma.link', 'beanORM', 'tgamma.LinkID', 'tdelta.LinkID'),
  relation('orm:delta.link', 'beanORM', 'tdelta.linkid', 'tgamma.LinkID'),
];

/** A deferring cycle (`talpha`/`tbeta`) with a dependent table (`tachild`), beside a mirrored cycle (`tdelta`/`tgamma`). */
const CYCLES_INVENTORY: OrderInventory = {
  tables: unsited('tgamma', 'tdelta', 'tbeta', 'talpha', 'tachild'),
  relations: [...PAIR_INVENTORY.relations, ...MIRRORED_RELATIONS, relation('dao:child.beta', 'daoJoin', 'tachild.BetaID', 'tbeta.BetaID')],
};

const CYCLES_KEYS: Readonly<Record<string, readonly string[]>> = {
  tachild: ['ChildID'],
  talpha: ['AlphaID'],
  tbeta: ['BetaID'],
  tgamma: ['LinkID'],
  tdelta: ['LinkID'],
};

const CYCLES_CATALOG = fakeCatalog(ownedBy('surveys', CYCLES_KEYS));

const PEOPLE_SPLIT: FakeTable = { owner: 'split', owners: ['identity', 'people'] };

const HEAD_TABLES: Readonly<Record<string, FakeTable>> = {
  tsettings: { owner: 'programs-sites', owners: ['programs-sites'], keyColumns: ['SiteID'] },
  tusers: { ...PEOPLE_SPLIT, keyColumns: ['UserID'] },
  tuserstags: { ...PEOPLE_SPLIT, keyColumns: ['tagID'] },
  tclassextenddatauseractivity: { ...PEOPLE_SPLIT, keyColumns: ['dataID'] },
  ...ownedBy('identity', { tusersmemb: ['UserID', 'GroupID'], tpermissions: ['ContentID', 'GroupID'], tuserremotesessions: ['userID'], tuserstrikes: ['username'] }),
  ...ownedBy('strategies-content', {
    tcontent: ['tcontent_ID'],
    tfiles: ['fileID'],
    tcontentobjects: ['ContentHistID', 'ObjectID'],
    tcontentcategories: ['categoryID'],
    tapprovalchains: ['chainID'],
    tchangesets: ['changesetID'],
  }),
  temails: { owner: 'communications', owners: ['communications'], keyColumns: ['EmailID'] },
  'synthetic.program_site': { owner: 'programs-sites', keyColumns: ['program_id'] },
  ...ownedBy('surveys', { 'synthetic.survey': ['survey_id'], 'synthetic.survey_reminder': ['reminder_id'] }),
  'program_n.timesheet': { owner: 'timesheets', owners: ['timesheets'], keyColumns: ['timesheet_id'] },
};

const HEAD_CATALOG = fakeCatalog(HEAD_TABLES);

/** Masa tables of every planned head group, `tusers` held behind its photo file, and the tables of two fixture modules. */
const HEAD_INVENTORY: OrderInventory = {
  tables: [
    ...['tsettings', 'tusers', 'tpermissions', 'tuserstags', 'tclassextenddatauseractivity', 'tcontent', 'tfiles'].map((table) => ({ table, hasSiteId: true })),
    ...['tcontentobjects', 'tcontentcategories', 'tapprovalchains', 'tchangesets', 'temails', 'synthetic.survey'].map((table) => ({ table, hasSiteId: true })),
    ...unsited('tusersmemb', 'tuserremotesessions', 'tuserstrikes', 'synthetic.survey_reminder', 'Program_N.timesheet'),
  ],
  relations: [
    relation('orm:user.photo', 'beanORM', 'tusers.photoFileID', 'tfiles.fileID'),
    relation('orm:file.content', 'beanORM', 'tfiles.contentID', 'tcontent.ContentID'),
    relation('dao:content.file', 'daoJoin', 'tcontent.FileID', 'tfiles.fileID'),
    relation('orm:content.changeset', 'beanORM', 'tcontent.changesetID', 'tchangesets.changesetID'),
    relation('dao:membership.user', 'daoJoin', 'tusersmemb.UserID', 'tusers.UserID'),
    relation('dao:permission.group', 'daoJoin', 'tpermissions.GroupID', 'tusers.UserID'),
    relation('dao:tag.user', 'daoJoin', 'tuserstags.userID', 'tusers.UserID'),
    relation('dao:activity.user', 'daoJoin', 'tclassextenddatauseractivity.baseID', 'tusers.UserID'),
    relation('tenant:session.user', 'tenantParent', 'tuserremotesessions.userID', 'tusers.UserID'),
    relation('tenant:strike.user', 'tenantParent', 'tuserstrikes.username', 'tusers.UserName'),
    relation('dao:object.version', 'daoJoin', 'tcontentobjects.ContentHistID', 'tcontent.ContentHistID'),
    relation('orm:chain.site', 'beanORM', 'tapprovalchains.siteID', 'tsettings.SiteID'),
    relation('fixture:reminder.survey', 'programFk', 'synthetic.survey_reminder.survey_id', 'synthetic.survey.survey_id'),
  ],
};

/** The order of {@link HEAD_INVENTORY}: `tusers` follows the tables its photo file needs, then the planned head groups. */
const HEAD_ORDER: readonly string[] = [
  'tsettings',
  'tchangesets',
  'tcontent',
  'tfiles',
  'tusers',
  'tpermissions',
  'tusersmemb',
  'tclassextenddatauseractivity',
  'tuserremotesessions',
  'tuserstags',
  'tuserstrikes',
  'tcontentobjects',
  'tcontentcategories',
  'tapprovalchains',
  'temails',
  'synthetic.program_site',
  'synthetic.survey',
  'synthetic.survey_reminder',
  'Program_1.timesheet',
  'Program_2.timesheet',
];

const LEGACY_FORM_TABLES: Readonly<Record<string, FakeTable>> = {
  tsettings: { owner: 'programs-sites', owners: ['programs-sites'], keyColumns: ['SiteID'] },
  tredirects: { owner: 'strategies-content', owners: ['strategies-content'], keyColumns: ['redirectID'] },
  tjobqueue: { owner: 'reporting', owners: ['reporting'], keyColumns: ['jobID'] },
  'program_n.grant': { owner: 'finance', owners: ['finance'], keyColumns: ['grant_id'] },
  'program_n.award': { owner: 'finance', owners: ['finance'], keyColumns: ['award_id'] },
  'synthetic.program_site': { owner: 'programs-sites', keyColumns: ['program_id'] },
};

/** An inventory as `opt2/inventory/legacy-inventory.json` records it, with keys the order does not read. */
const LEGACY_FORM = {
  sourceSha: TEST_SOURCE_SHA,
  tables: [
    { table: 'tsettings', hasSiteId: true, rowCount: 3 },
    { table: 'Program_N.grant', hasSiteId: null, hasSiteIdLive: false },
    { table: 'tredirects', hasSiteId: null, hasSiteIdLive: true },
    { table: 'tjobqueue', hasSiteId: null },
  ],
  relations: [
    {
      id: 'rel:fold',
      kind: 'program-fold',
      child: { table: 'Program_N.*', columns: null },
      parent: { table: 'synthetic.program_site', columns: ['program_id'] },
      source: { path: 'legacy-fixtures/sql/010_program_site.sql', lines: [8, 8] },
      tenantDerivation: true,
    },
    { id: 'rel:orm', kind: 'orm-fk', child: { table: 'tredirects', columns: ['siteID'] }, parent: { table: 'tsettings', columns: ['siteID'] } },
    {
      id: 'rel:dao',
      kind: 'dao-join',
      child: { table: 'tjobqueue', columns: ['RedirectID'] },
      parent: { table: 'tredirects', columns: ['redirectID'] },
    },
    {
      id: 'rel:fk',
      kind: 'fixture-fk',
      child: { table: 'Program_N.award', columns: ['grant_id'] },
      parent: { table: 'Program_N.grant', columns: ['grant_id'] },
    },
  ],
};

const LEGACY_FORM_PARSED: OrderInventory = {
  tables: [
    { table: 'tsettings', hasSiteId: true },
    { table: 'Program_N.grant', hasSiteId: false },
    { table: 'tredirects', hasSiteId: true },
    { table: 'tjobqueue', hasSiteId: false },
  ],
  relations: [
    {
      id: 'rel:fold',
      kind: 'programFold',
      child: { table: 'Program_N.*', column: 'legacy_program_id' },
      parent: { table: 'synthetic.program_site', column: 'program_id' },
      source: { path: 'legacy-fixtures/sql/010_program_site.sql', lines: [8, 8] },
    },
    { id: 'rel:orm', kind: 'beanORM', child: { table: 'tredirects', column: 'siteID' }, parent: { table: 'tsettings', column: 'siteID' } },
    { id: 'rel:dao', kind: 'daoJoin', child: { table: 'tjobqueue', column: 'RedirectID' }, parent: { table: 'tredirects', column: 'redirectID' } },
    {
      id: 'rel:fk',
      kind: 'programFk',
      child: { table: 'Program_N.award', column: 'grant_id' },
      parent: { table: 'Program_N.grant', column: 'grant_id' },
    },
  ],
};

/** Table, owner and tenant source of each entry of the fixture order, in order. */
const FIXTURE_ENTRIES: readonly (readonly [string, DataOwner | 'split', TenantFrom])[] = [
  ['tsettings', 'programs-sites', 'siteID'],
  ['tusers', 'split', 'siteID'],
  ['tcontent', 'strategies-content', 'siteID'],
  ['tfiles', 'strategies-content', 'siteID'],
  ['timagesizes', 'programs-sites', 'siteID'],
  ['tmailinglist', 'communications', 'siteID'],
  ['tmailinglistmembers', 'communications', 'siteID'],
  ['synthetic.program_site', 'programs-sites', 'siteID'],
  ['synthetic.person_archive', 'people', 'siteID'],
  ['Program_1.blackout', 'timesheets', 'parent'],
  ['Program_2.blackout', 'timesheets', 'parent'],
];

/** Child and parent table pairs of a fixture relation; `Program_N` sides become one pair per fixture program. */
function concretePairs(child: string, parent: string): [string, string][] {
  const programTable = (table: string, programId: number): string => table.replace(/^Program_N\./, `Program_${String(programId)}.`);
  if (!child.startsWith('Program_N.') && !parent.startsWith('Program_N.')) return [[child, parent]];
  return PROGRAM_SITES.map(({ program_id }) => [programTable(child, program_id), programTable(parent, program_id)]);
}

const cleanups: (() => Promise<void>)[] = [];

/** Fresh test directories, removed after the test. */
async function testDirs(): Promise<TestDirs> {
  const dirs = await createTestDirs();
  cleanups.push(dirs.cleanup);
  return dirs;
}

/** Writes `text` as `name` in the state directory of fresh test directories and returns its path. */
async function writeTempFile(name: string, text: string): Promise<string> {
  const file = path.join((await testDirs()).stateDir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

/** Report target over the reports directory of fresh test directories, its SHA read from a source-pin file beside it. */
async function makeReportTarget(): Promise<ReportTarget> {
  const dirs = await testDirs();
  const pin = {
    sha: TEST_SOURCE_SHA,
    subject: 'pin',
    repository: 'https://example.invalid/masa.git',
    confirmedAt: '2026-01-01T00:00:00Z',
    confirmCommand: 'check-pin',
  };
  const sourceShaFile = path.join(dirs.stateDir, 'source-pin.json');
  writeFileSync(sourceShaFile, JSON.stringify(pin), 'utf8');
  return resolveReportTarget({ reportsDir: dirs.reportsDir, sourceShaFile });
}

function readReport(target: ReportTarget): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(target.reportsDir, MIGRATION_ORDER_REPORT), 'utf8')) as Record<string, unknown>;
}

/** Every observable part of `order`, the inherited parent of each table included. */
function summary(order: DependencyOrder) {
  return {
    order: order.order,
    entries: order.entries,
    deferred: order.deferred,
    relaxed: order.relaxed,
    cycles: order.cycles,
    parents: order.order.map((table) => order.parentOf(table)),
  };
}

function positions(order: DependencyOrder): Map<string, number> {
  return new Map(order.entries.map((entry) => [entry.table, entry.position]));
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('compareTableNames', () => {
  it.each<[string, string, number]>([
    ['tusers', 'tusersmemb', -1],
    ['tsettings', 'Tusers', -1],
    ['TUsers', 'tusers', -1],
    ['tusers', 'TUsers', 1],
    ['Program_10.grant', 'Program_2.grant', -1],
    ['tsettings', 'tsettings', 0],
  ])('orders %s against %s as %i: case-insensitive code units, then exact form', (a, b, sign) => {
    expect(Math.sign(compareTableNames(a, b))).toBe(sign);
  });
});

describe('buildDependencyOrder over the fixture inventory and catalog', () => {
  const order = buildDependencyOrder({ inventory: FIXTURE_INVENTORY, catalog: FIXTURE_CATALOG });

  it('orders the fixture tables from tsettings, recording owner and tenant source of each', () => {
    expect(order.order[0]).toBe(SITE_ROOT_TABLE);
    expect(EXPECTED_HEAD[0]).toBe('tsettings');
    expect(order.entries.map((entry) => [entry.table, entry.owner, entry.tenantFrom])).toEqual(FIXTURE_ENTRIES);
  });

  it('places the parent of every fixture relation before its child, except across the deferred back-reference', () => {
    const at = positions(order);
    const deferred = new Set(order.deferred.map(({ relationId }) => relationId));
    for (const { id, child, parent } of FIXTURE_INVENTORY.relations) {
      for (const [childTable, parentTable] of concretePairs(child.table, parent.table)) {
        const [first, second] = deferred.has(id) ? [childTable, parentTable] : [parentTable, childTable];
        expect(at.get(first), `${id}: ${first} before ${second}`).toBeLessThan(at.get(second) ?? 0);
      }
    }
  });

  it('gives the same result on every call', () => {
    expect(summary(buildDependencyOrder({ inventory: FIXTURE_INVENTORY, catalog: FIXTURE_CATALOG }))).toEqual(summary(order));
  });

  it('orders tables that depend on tsettings alone by planned head group, Masa tables before the fold target and fixtures, then by name', () => {
    const siblings = order.entries.filter((entry) => entry.parents.join() === SITE_ROOT_TABLE).map((entry) => entry.table);
    expect(siblings).toEqual(['tusers', 'timagesizes', 'tmailinglist', 'synthetic.program_site', 'synthetic.person_archive']);
    expect(['timagesizes', 'tmailinglist'].sort(compareTableNames)).toEqual(siblings.slice(1, 3));
  });

  // EXPECTED_HEAD is the planned head and the computed order governs, so only its lead is pinned to the head.
  it('keeps every planned head table the fixture holds behind tsettings', () => {
    const planned = EXPECTED_HEAD.filter((table) => order.order.includes(table));
    expect(planned).toEqual(['tsettings', 'tusers', 'tcontent', 'synthetic.program_site']);
    for (const table of planned.slice(1)) expect(order.order.indexOf(table), table).toBeGreaterThan(0);
  });

  it('folds Program_N.blackout into one entry per fixture program, each behind synthetic.program_site', () => {
    const programTables = order.order.filter((table) => parseProgramTable(table) !== null);
    expect(programTables).toEqual(PROGRAM_SITES.map(({ program_id }) => `Program_${String(program_id)}.blackout`));
    expect(order.order.filter((table) => table.startsWith('Program_N'))).toEqual([]);
    expect(new Set(order.order).size).toBe(order.order.length);
    for (const table of programTables) expect(order.order.indexOf(PROGRAM_SITE_TABLE)).toBeLessThan(order.order.indexOf(table));
    expect(FIXTURE_CATALOG.isMigratable(PROGRAM_SITE_TABLE)).toBe(false);
  });

  it('leaves out decision-list and retired tables even when relations name them', () => {
    const inventory: OrderInventory = {
      tables: FIXTURE_INVENTORY.tables,
      relations: [
        ...FIXTURE_INVENTORY.relations,
        relation('dao:reminder.content', 'daoJoin', 'tcontenteventreminders.contentId', 'tcontent.ContentID'),
        relation('dao:content.globals', 'daoJoin', 'tcontent.appreload', 'tglobals.appreload'),
      ],
    };
    expect([FIXTURE_CATALOG.legacyTableOwner('tcontenteventreminders'), FIXTURE_CATALOG.legacyTableOwner('tglobals')]).toEqual([
      'decision-list',
      'retired',
    ]);
    const result = buildDependencyOrder({ inventory, catalog: FIXTURE_CATALOG });
    expect(result.order).toEqual(order.order);
    expect(result.entries.flatMap((entry) => entry.parents)).not.toContain('tglobals');
    expect(result.parentOf('tcontenteventreminders')).toBeNull();
  });

  it.each(['Program_1.blackout', 'Program_2.blackout'])('inherits the tenant of %s through the program fold', (table) => {
    expect(parentOf(order, table)).toStrictEqual({
      id: `implicit:programFold:${table}`,
      kind: 'programFold',
      child: { table, column: 'legacy_program_id' },
      parent: { table: PROGRAM_SITE_TABLE, column: 'program_id' },
    });
  });

  it.each(FIXTURE_ENTRIES.filter(([, , tenantFrom]) => tenantFrom === 'siteID').map(([table]) => table))(
    'gives %s no inherited parent because its rows carry their own site',
    (table) => {
      expect(parentOf(order, table)).toBeNull();
    },
  );

  it('defers tcontent.FileID to break the tcontent/tfiles cycle', () => {
    expect(order.deferred).toStrictEqual([
      {
        table: 'tcontent',
        column: 'FileID',
        references: { table: 'tfiles', column: 'fileID' },
        relationId: 'rel:tcontent.FileID->tfiles.fileID',
      },
    ]);
    expect(order.relaxed).toEqual([]);
    expect(order.cycles).toEqual([['tcontent', 'tfiles']]);
  });

  // The unit catalog raises its own error for a table the ownership file does not list.
  it('propagates the catalog error for a relation naming a table the ownership file does not list', () => {
    const inventory: OrderInventory = {
      tables: FIXTURE_INVENTORY.tables,
      relations: [...FIXTURE_INVENTORY.relations, relation('dao:mystery.content', 'daoJoin', 'tmystery.ContentID', 'tcontent.ContentID')],
    };
    expect(() => buildDependencyOrder({ inventory, catalog: FIXTURE_CATALOG })).toThrow(
      new UnknownLegacyTableError('tmystery'),
    );
  });
});

describe('buildDependencyOrder', () => {
  const order = buildDependencyOrder({ inventory: MAIN_INVENTORY, catalog: MAIN_CATALOG });

  it('starts with tsettings, then orders the ready tables by planned head group and name', () => {
    expect(order.order[0]).toBe(SITE_ROOT_TABLE);
    expect(EXPECTED_HEAD[0]).toBe(SITE_ROOT_TABLE);
    expect(order.order).toEqual(MAIN_ENTRIES.map(([table]) => table));
  });

  it('records schema, owner, tenant source and parents of every entry, with 1-based positions', () => {
    expect(order.entries.map((entry) => [entry.table, entry.schema, entry.owner, entry.tenantFrom, entry.parents])).toEqual(MAIN_ENTRIES);
    expect(order.entries.map((entry) => entry.position)).toEqual(MAIN_ENTRIES.map((_, index) => index + 1));
  });

  it('places every parent before its children', () => {
    const at = positions(order);
    for (const entry of order.entries) {
      for (const parent of entry.parents) expect(at.get(parent), `${parent} before ${entry.table}`).toBeLessThan(entry.position);
    }
  });

  it('leaves out decision-list and retired tables and their relations', () => {
    expect(order.order).not.toContain('tplugins');
    expect(order.order).not.toContain('tglobals');
    expect(order.entries.flatMap((entry) => entry.parents)).not.toContain('tglobals');
    expect(order.parentOf('tplugins')).toBeNull();
  });

  it('drops self-references without deferring them or inheriting through them', () => {
    expect(order.deferred).toEqual([]);
    expect(order.relaxed).toEqual([]);
    expect(order.cycles).toEqual([]);
    expect(order.entries.find((entry) => entry.table === 'tjobqueue')).toMatchObject({ parents: [], tenantFrom: 'umbrella' });
    expect(order.entries.find((entry) => entry.table === 'tcontent')?.parents).toEqual(['tsettings']);
    expect(order.parentOf('tjobqueue')).toBeNull();
  });

  it('adds synthetic.program_site, the program fold target, though it does not migrate, after every Masa table', () => {
    expect(MAIN_CATALOG.isMigratable(PROGRAM_SITE_TABLE)).toBe(false);
    expect(order.order.indexOf(PROGRAM_SITE_TABLE)).toBe(order.entries.filter((entry) => entry.schema === 'dbo').length);
  });

  it.each(['tsettings', 'synthetic.program_site', 'tusers', 'tpermissions', 'tcontent', 'tcontentcategories', 'tapprovalchains'])(
    'gives %s no parent because its rows carry their own site',
    (table) => {
      expect(order.parentOf(table)).toBeNull();
      expect(order.entries.find((entry) => entry.table === table)?.tenantFrom).toBe('siteID');
    },
  );

  it.each(['Program_1.grant', 'Program_1.award', 'Program_2.grant', 'Program_2.award'])(
    'folds %s onto synthetic.program_site ahead of its fixture foreign key',
    (table) => {
      expect(order.parentOf(table)).toStrictEqual({
        id: `implicit:programFold:${table}`,
        kind: 'programFold',
        child: { table, column: 'legacy_program_id' },
        parent: { table: 'synthetic.program_site', column: 'program_id' },
      });
    },
  );

  it.each<[string, string, string]>([
    ['prefers the stronger relation kind', 'tcontentcategoryassign', 'orm:assign.category'],
    ['prefers a parent sharing an owner with the child over a smaller name', 'tusersinterests', 'dao:interest.user'],
    ['keeps one edge per case-insensitive column pair, the smallest relation id', 'tapprovalrequests', 'dao:approvalRequest.chain'],
    ['breaks remaining ties by child column', 'tusersmemb', 'dao:membership.group'],
  ])('%s when inheriting the tenant of %s', (_, table, relationId) => {
    expect(order.parentOf(table)?.id).toBe(relationId);
  });

  it('carries the source of the relation a table inherits through', () => {
    expect(order.parentOf('tusersinterests')).toStrictEqual({
      id: 'dao:interest.user',
      kind: 'daoJoin',
      child: { table: 'tusersinterests', column: 'userID' },
      parent: { table: 'tusers', column: 'UserID' },
      source: INTEREST_SOURCE,
    });
  });

  it.each<[string, string]>([
    ['[dbo].[TUsersMemb]', 'tusersmemb'],
    ['DBO.tusersmemb', 'tusersmemb'],
    ['[Program_1].[Award]', 'Program_1.award'],
    ['program_1.AWARD', 'Program_1.award'],
  ])('resolves the parent of %s as that of %s', (alias, table) => {
    expect(order.parentOf(alias)).not.toBeNull();
    expect(parentOf(order, alias)).toBe(order.parentOf(table));
  });

  it('returns frozen results', () => {
    for (const part of [order, order.order, order.entries, order.entries[0], order.entries[0]?.parents, order.deferred, order.cycles]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
    expect(Object.isFrozen(order.parentOf('tusersmemb'))).toBe(true);
  });

  type Permute = <T>(items: readonly T[]) => T[];
  const permutations: readonly (readonly [string, Permute])[] = [
    ['reversed', (items) => [...items].reverse()],
    ['rotated', (items) => [...items.slice(3), ...items.slice(0, 3)]],
    ['interleaved', (items) => [...items.filter((_, index) => index % 2 === 1), ...items.filter((_, index) => index % 2 === 0)]],
  ];

  it.each<[string, OrderInventory, Readonly<Record<string, FakeTable>>, readonly Unit[]]>([
    ['the site and program inventory', MAIN_INVENTORY, MAIN_TABLES, MAIN_UNITS],
    ['the cycle inventory', CYCLES_INVENTORY, ownedBy('surveys', CYCLES_KEYS), []],
    ['the planned head inventory', HEAD_INVENTORY, HEAD_TABLES, []],
  ])('gives the same result for %s whatever the order of its tables, relations and units', (_, inventory, tables, units) => {
    const expected = summary(buildDependencyOrder({ inventory, catalog: fakeCatalog(tables, units) }));
    for (const [, permute] of permutations) {
      const shuffled = { tables: permute(inventory.tables), relations: permute(inventory.relations) };
      expect(summary(buildDependencyOrder({ inventory: shuffled, catalog: fakeCatalog(tables, permute(units)) }))).toEqual(expected);
    }
  });

  it.each<[string, readonly number[] | undefined, OrderInventory['tables'], readonly string[]]>([
    ['the given program ids', [7], [], ['Program_7.grant']],
    [
      'the program ids the inputs name',
      undefined,
      unsited('Program_3.grant', 'Program_1.award'),
      ['Program_1.award', 'Program_1.grant', 'Program_3.grant'],
    ],
    ['programs 1 and 2 when no input names one', undefined, [], ['Program_1.grant', 'Program_2.grant']],
  ])('expands Program_N tables for %s', (_, programIds, extraTables, programTables) => {
    const inventory: OrderInventory = {
      tables: [{ table: 'tsettings', hasSiteId: true }, ...unsited('Program_N.grant'), ...extraTables],
      relations: [],
    };
    const result = buildDependencyOrder({ inventory, catalog: fakeCatalog(MAIN_TABLES), programIds });
    expect(result.order).toEqual([SITE_ROOT_TABLE, PROGRAM_SITE_TABLE, ...programTables]);
  });

  it('links every table a wildcard relation side matches, except the other side itself', () => {
    const inventory: OrderInventory = {
      tables: [
        { table: 'tsettings', hasSiteId: true },
        { table: 'tclassextend', hasSiteId: true },
        ...unsited('tclassextend*', 'tclassextenddata', 'tclassextendsets', 'tsubtyperules'),
      ],
      relations: [
        relation('dao:extend.base', 'daoJoin', 'tclassextend*.SubTypeID', 'tclassextend.SubTypeID'),
        relation('dao:rules.extend', 'daoJoin', 'tsubtyperules.SubTypeID', 'tclassextend*.SubTypeID'),
      ],
    };
    const catalog = fakeCatalog({
      tsettings: { owner: 'programs-sites', owners: ['programs-sites'], keyColumns: ['SiteID'] },
      ...ownedBy('strategies-content', {
        tclassextend: ['SubTypeID'],
        tclassextenddata: ['dataID'],
        tclassextendsets: ['ExtendSetID'],
        tsubtyperules: ['ruleID'],
      }),
    });
    const result = buildDependencyOrder({ inventory, catalog });
    expect(result.order).toEqual(['tsettings', 'tclassextend', 'tclassextenddata', 'tclassextendsets', 'tsubtyperules']);
    expect(result.entries.map((entry) => entry.parents)).toEqual([
      [],
      ['tsettings'],
      ['tclassextend'],
      ['tclassextend'],
      ['tclassextend', 'tclassextenddata', 'tclassextendsets'],
    ]);
    expect(result.parentOf('tclassextendsets')?.id).toBe('dao:extend.base');
    expect(result.parentOf('tsubtyperules')?.parent.table).toBe('tclassextend');
  });

  it('orders site tables without site edges when tsettings is not among the tables', () => {
    const inventory: OrderInventory = {
      tables: [{ table: 'tcontent', hasSiteId: true }, ...unsited('tcontentobjects')],
      relations: [relation('dao:object.content', 'daoJoin', 'tcontentobjects.ContentID', 'tcontent.ContentID')],
    };
    const catalog = fakeCatalog(ownedBy('strategies-content', { tcontent: ['tcontent_ID'], tcontentobjects: ['ContentID', 'ObjectID'] }));
    const result = buildDependencyOrder({ inventory, catalog });
    expect(result.entries.map((entry) => [entry.table, entry.tenantFrom, entry.parents])).toEqual([
      ['tcontent', 'siteID', []],
      ['tcontentobjects', 'parent', ['tcontent']],
    ]);
  });

  it('propagates the catalog error for a table the ownership file does not list', () => {
    const inventory: OrderInventory = { tables: unsited('tmystery'), relations: [] };
    expect(() => buildDependencyOrder({ inventory, catalog: MAIN_CATALOG })).toThrow(UnknownLegacyTableError);
  });

  it.each<LegacyTableOwner>(['decision-list', 'retired'])('rejects an ordered table owned by "%s"', (owner) => {
    const catalog = fakeCatalog({ ...MAIN_TABLES, 'synthetic.program_site': { owner } });
    const inventory: OrderInventory = { tables: unsited('Program_N.grant'), relations: [] };
    const build = (): DependencyOrder => buildDependencyOrder({ inventory, catalog });
    expect(build).toThrow(DependencyOrderError);
    expect(build).toThrow(new DependencyOrderError(`ordered table synthetic.program_site is owned by "${owner}"`));
  });
});

describe('buildDependencyOrder head', () => {
  const order = buildDependencyOrder({ inventory: HEAD_INVENTORY, catalog: HEAD_CATALOG });
  const at = positions(order);

  it('follows the planned head: tusers, its memberships and permissions, people children, tcontent versions, categories, approvals', () => {
    expect(order.order).toEqual(HEAD_ORDER);
  });

  it('still defers tcontent.FileID to break the tcontent/tfiles cycle that holds tusers back', () => {
    expect(order.deferred.map(({ table, column, relationId }) => [table, column, relationId])).toEqual([['tcontent', 'FileID', 'dao:content.file']]);
    expect(order.cycles).toEqual([['tcontent', 'tfiles']]);
  });

  it.each(['tusersmemb', 'tpermissions', 'tuserstags', 'tclassextenddatauseractivity', 'tuserremotesessions', 'tuserstrikes'])(
    'places %s after tusers',
    (table) => {
      expect(at.get(table)).toBeGreaterThan(at.get('tusers') ?? Infinity);
    },
  );

  it('places every Masa table before synthetic.program_site and every fixture table after it, module by module', () => {
    const fixtures = order.entries.filter((entry) => entry.schema !== 'dbo').map((entry) => [entry.table, entry.owner]);
    expect(order.entries.slice(0, -fixtures.length).every((entry) => entry.schema === 'dbo')).toBe(true);
    expect(fixtures).toEqual([
      [PROGRAM_SITE_TABLE, 'programs-sites'],
      ['synthetic.survey', 'surveys'],
      ['synthetic.survey_reminder', 'surveys'],
      ['Program_1.timesheet', 'timesheets'],
      ['Program_2.timesheet', 'timesheets'],
    ]);
  });

  it.each<[string, string]>([
    ['tuserremotesessions', 'tenant:session.user'],
    ['tuserstrikes', 'tenant:strike.user'],
  ])('inherits the tenant of %s through its tenant-parent relation to tusers', (table, relationId) => {
    expect(order.parentOf(table)).toMatchObject({ id: relationId, kind: 'tenantParent', parent: { table: 'tusers' } });
  });
});

describe('computeDependencyOrder over the committed inventory and table ownership', () => {
  const config = loadConfig();
  let order: DependencyOrder;
  let at: Map<string, number>;

  beforeAll(async () => {
    order = await computeDependencyOrder({ inventory: config.paths.inventory, catalog: loadUnitCatalog(config.paths.tableOwnership), programIds: [1, 2] });
    at = positions(order);
  });

  it('places every parent before its children except across a broken back-reference', () => {
    const broken = new Set([...order.deferred, ...order.relaxed].map(({ table, references }) => `${table}<${references.table}`));
    for (const entry of order.entries) {
      for (const parent of entry.parents) {
        if (!broken.has(`${entry.table}<${parent}`)) expect(at.get(parent), `${parent} before ${entry.table}`).toBeLessThan(entry.position);
      }
    }
  });

  it.each([
    'tusersmemb',
    'tpermissions',
    'tuseraddresses',
    'tuserremotesessions',
    'tusersfavorites',
    'tusersinterests',
    'tuserstags',
    'tuserstrikes',
    'tclassextenddatauseractivity',
  ])('relates %s to tusers and places it after tusers', (table) => {
    expect(order.entries.find((entry) => entry.table === table)?.parents).toContain('tusers');
    expect(at.get(table)).toBeGreaterThan(at.get('tusers') ?? Infinity);
  });

  it('leads with tsettings, places every Masa table before synthetic.program_site and every fixture table after it', () => {
    const fold = at.get(PROGRAM_SITE_TABLE) ?? 0;
    expect(order.order[0]).toBe(SITE_ROOT_TABLE);
    expect(order.entries.filter((entry) => entry.schema === 'dbo' && entry.position > fold)).toEqual([]);
    expect(order.entries.filter((entry) => entry.schema !== 'dbo' && entry.position < fold)).toEqual([]);
    const programs = order.entries.filter((entry) => parseProgramTable(entry.table) !== null);
    expect(programs.length).toBeGreaterThan(0);
    for (const entry of programs) expect(entry.parents, entry.table).toContain(PROGRAM_SITE_TABLE);
  });
});

describe('buildDependencyOrder cycles', () => {
  it.each<[string, Readonly<Record<string, readonly string[]>>, readonly [string, string], OrderRelation]>([
    [
      'the smaller table',
      { talpha: ['AlphaID'], tbeta: ['BetaID'] },
      ['talpha', 'tbeta'],
      relation('dao:alpha.beta', 'daoJoin', 'talpha.BetaID', 'tbeta.BetaID'),
    ],
    [
      'the next table when the smaller one keys on its back-reference',
      { talpha: ['AlphaID', 'BetaID'], tbeta: ['BetaID'] },
      ['tbeta', 'talpha'],
      relation('dao:beta.alpha', 'daoJoin', 'tbeta.AlphaID', 'talpha.AlphaID'),
    ],
  ])('defers the one back-reference column of %s in a two-table cycle', (_, keyColumns, [first, second], broken) => {
    const result = buildDependencyOrder({ inventory: PAIR_INVENTORY, catalog: fakeCatalog(ownedBy('surveys', keyColumns)) });
    expect(result.order).toEqual([first, second]);
    expect(result.deferred).toStrictEqual([
      { table: broken.child.table, column: broken.child.column, references: broken.parent, relationId: broken.id },
    ]);
    expect(result.relaxed).toEqual([]);
    expect(result.cycles).toEqual([['talpha', 'tbeta']]);
    expect(result.entries.map((entry) => [entry.table, entry.tenantFrom, entry.parents])).toEqual([
      [first, 'umbrella', [second]],
      [second, 'parent', [first]],
    ]);
    expect(result.parentOf(first)).toBeNull();
    expect(result.parentOf(second)?.parent.table).toBe(first);
  });

  const ring: OrderInventory = {
    tables: unsited('tc', 'tb', 'ta'),
    relations: [
      relation('r:a.b', 'daoJoin', 'ta.b_id', 'tb.id'),
      relation('r:b.c', 'daoJoin', 'tb.c_id', 'tc.id'),
      relation('r:c.a', 'daoJoin', 'tc.a_id', 'ta.id'),
    ],
  };
  const selfReference: OrderInventory = {
    tables: unsited('tnode'),
    relations: [relation('dao:node.parent', 'daoJoin', 'tnode.ParentID', 'tnode.NodeID')],
  };

  it.each<[string, OrderInventory, OrderCatalog, readonly string[], readonly string[], readonly (readonly string[])[]]>([
    [
      'the fixture tcontent/tfiles pair',
      FIXTURE_INVENTORY,
      FIXTURE_CATALOG,
      FIXTURE_ENTRIES.map(([table]) => table),
      ['tcontent.FileID'],
      [['tcontent', 'tfiles']],
    ],
    [
      'a three-table ring',
      ring,
      fakeCatalog(ownedBy('surveys', { ta: ['id'], tb: ['id'], tc: ['id'] })),
      ['ta', 'tc', 'tb'],
      ['ta.b_id'],
      [['ta', 'tb', 'tc']],
    ],
    // A table's rows load in one pass, so a self-reference orders nothing and is dropped rather than deferred.
    ['a self-reference', selfReference, fakeCatalog(ownedBy('surveys', { tnode: ['NodeID'] })), ['tnode'], [], []],
  ])('breaks %s by deferring at most one back-reference and orders every kept relation', (_, inventory, catalog, tables, deferred, cycles) => {
    const result = buildDependencyOrder({ inventory, catalog });
    expect(result.order).toEqual(tables);
    expect(result.deferred.map(({ table, column }) => `${table}.${column}`)).toEqual(deferred);
    expect(result.relaxed).toEqual([]);
    expect(result.cycles).toEqual(cycles);
    const broken = new Set(result.deferred.map(({ relationId }) => relationId));
    const at = positions(result);
    for (const { id, child, parent } of inventory.relations.filter((rel) => !broken.has(rel.id))) {
      for (const [childTable, parentTable] of concretePairs(child.table, parent.table)) {
        if (childTable !== parentTable) expect(at.get(parentTable), `${id}`).toBeLessThan(at.get(childTable) ?? 0);
      }
    }
  });

  it('throws when every back-reference of the cycle is a key column', () => {
    const catalog = fakeCatalog(ownedBy('surveys', { talpha: ['AlphaID', 'BetaID'], tbeta: ['BetaID', 'AlphaID'] }));
    const build = (): DependencyOrder => buildDependencyOrder({ inventory: PAIR_INVENTORY, catalog });
    expect(build).toThrow(DependencyOrderError);
    expect(build).toThrow(new DependencyOrderError('cycle talpha, tbeta has no member whose back-references are all non-key or mirrored'));
  });

  it('relaxes a back-reference mirrored by a kept relation on the same column pair, even on a key column', () => {
    const inventory: OrderInventory = { tables: unsited('tgamma', 'tdelta'), relations: MIRRORED_RELATIONS };
    const result = buildDependencyOrder({ inventory, catalog: CYCLES_CATALOG });
    expect(result.order).toEqual(['tdelta', 'tgamma']);
    expect(result.deferred).toEqual([]);
    expect(result.relaxed).toStrictEqual([
      { table: 'tdelta', column: 'linkid', references: { table: 'tgamma', column: 'LinkID' }, relationId: 'orm:delta.link' },
    ]);
    expect(result.cycles).toEqual([['tdelta', 'tgamma']]);
    expect(result.parentOf('tgamma')?.id).toBe('orm:gamma.link');
  });

  it('breaks a cycle left inside a broken one, recording both', () => {
    const inventory: OrderInventory = {
      tables: unsited('tc', 'tb', 'ta'),
      relations: [
        relation('r:a.b', 'daoJoin', 'ta.b_id', 'tb.id'),
        relation('r:b.a', 'daoJoin', 'tb.a_id', 'ta.id'),
        relation('r:b.c', 'daoJoin', 'tb.c_id', 'tc.id'),
        relation('r:c.b', 'daoJoin', 'tc.b_id', 'tb.id'),
      ],
    };
    const result = buildDependencyOrder({ inventory, catalog: fakeCatalog(ownedBy('surveys', { ta: ['id'], tb: ['id'], tc: ['id'] })) });
    expect(result.order).toEqual(['ta', 'tb', 'tc']);
    expect(result.deferred.map(({ table, column, relationId }) => [table, column, relationId])).toEqual([
      ['ta', 'b_id', 'r:a.b'],
      ['tb', 'c_id', 'r:b.c'],
    ]);
    expect(result.cycles).toEqual([['ta', 'tb', 'tc'], ['tb', 'tc']]);
    expect(toMigrationOrderReport(result).brokenCycles).toEqual([
      { tables: ['ta', 'tb', 'tc'], backReferenceColumn: 'ta.b_id', patchedInSecondPass: true },
      { tables: ['tb', 'tc'], backReferenceColumn: 'tb.c_id', patchedInSecondPass: true },
    ]);
  });

  it('defers the back-reference of tsettings so that it still leads', () => {
    const inventory: OrderInventory = {
      tables: [{ table: 'tsettings', hasSiteId: true }, { table: 'ttheme', hasSiteId: true }],
      relations: [relation('dao:site.theme', 'daoJoin', 'tsettings.ThemeID', 'ttheme.ThemeID')],
    };
    const catalog = fakeCatalog({
      tsettings: { owner: 'programs-sites', owners: ['programs-sites'], keyColumns: ['SiteID'] },
      ttheme: { owner: 'strategies-content', owners: ['strategies-content'], keyColumns: ['ThemeID'] },
    });
    const result = buildDependencyOrder({ inventory, catalog });
    expect(result.order).toEqual(['tsettings', 'ttheme']);
    expect(result.deferred.map(({ table, column }) => `${table}.${column}`)).toEqual(['tsettings.ThemeID']);
    expect(result.entries.map((entry) => entry.tenantFrom)).toEqual(['siteID', 'siteID']);
  });

  it('places every parent before its children except across a broken back-reference', () => {
    const result = buildDependencyOrder({ inventory: CYCLES_INVENTORY, catalog: CYCLES_CATALOG });
    const brokenParents = new Set([...result.deferred, ...result.relaxed].map(({ table, references }) => `${table}<${references.table}`));
    const at = positions(result);
    for (const entry of result.entries) {
      for (const parent of entry.parents) {
        if (!brokenParents.has(`${entry.table}<${parent}`)) expect(at.get(parent)).toBeLessThan(entry.position);
      }
    }
    expect(result.order).toEqual(['talpha', 'tbeta', 'tachild', 'tdelta', 'tgamma']);
    expect(result.cycles).toEqual([['talpha', 'tbeta'], ['tdelta', 'tgamma']]);
  });
});

describe('loadOrderInventory', () => {
  it('reads the legacy inventory form into order relations', async () => {
    const file = await writeTempFile('legacy-inventory.json', JSON.stringify(LEGACY_FORM));
    expect(loadOrderInventory(file)).toStrictEqual(LEGACY_FORM_PARSED);
  });

  it('reads a tenant-parent relation as tenantParent, inherited through ahead of a code relation to a parent of the same tenant source', async () => {
    const source = { path: 'core/mura/dbUpdates/5.2.0.cfm', lines: [318, 322] };
    const file = await writeTempFile(
      'legacy-inventory.json',
      JSON.stringify({
        tables: [...['tsettings', 'tusers', 'tcontent'].map((table) => ({ table, hasSiteId: true })), { table: 'tuserstrikes', hasSiteId: false }],
        relations: [
          { id: 'rel:dao', kind: 'dao-join', child: { table: 'tuserstrikes', columns: ['contentID'] }, parent: { table: 'tcontent', columns: ['ContentID'] } },
          { id: 'rel:tenant', kind: 'tenant-parent', child: { table: 'tuserstrikes', columns: ['username'] }, parent: { table: 'tusers', columns: ['UserName'] }, source },
        ],
      }),
    );
    const inventory = loadOrderInventory(file);
    expect(inventory.relations.map((r) => r.kind)).toEqual(['daoJoin', 'tenantParent']);
    expect(buildDependencyOrder({ inventory, catalog: HEAD_CATALOG }).parentOf('tuserstrikes')).toStrictEqual({
      id: 'rel:tenant',
      kind: 'tenantParent',
      child: { table: 'tuserstrikes', column: 'username' },
      parent: { table: 'tusers', column: 'UserName' },
      source,
    });
  });

  it('reads a serialised order inventory back unchanged', async () => {
    const inventory: OrderInventory = {
      tables: MAIN_INVENTORY.tables,
      relations: [...MAIN_INVENTORY.relations, relation('implicit:site:tusers', 'site', 'tusers.siteID', 'tsettings.SiteID')],
    };
    const file = await writeTempFile('order-inventory.json', JSON.stringify(inventory));
    expect(loadOrderInventory(file)).toStrictEqual(inventory);
  });

  it('reads the fixture inventory file back as the fixture inventory, ignoring its other keys', async () => {
    const file = await writeInventoryFile((await testDirs()).stateDir);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object)).toEqual(['sourceSha', 'tables', 'relations', 'scheduledJobs']);
    expect(loadOrderInventory(file)).toStrictEqual(FIXTURE_INVENTORY);
  });

  it.each<[string, string | null, RegExp]>([
    ['a missing file', null, /cannot be read as JSON: ENOENT/],
    ['text that is not JSON', '{"tables": [', /cannot be read as JSON: /],
    ['a document that is not an object', 'null', /\n {2}\(root\): /],
    ['a table without a name', '{"tables":[{"table":"","hasSiteId":true}],"relations":[]}', /\n {2}tables\.0\.table: /],
    [
      'a relation of an unknown kind',
      '{"tables":[],"relations":[{"id":"r","kind":"view-join","child":{"table":"a","columns":["x"]},"parent":{"table":"b","columns":["x"]}}]}',
      /\n {2}relations\.0: /,
    ],
    [
      'a relation other than a program fold without child columns',
      '{"tables":[],"relations":[{"id":"r","kind":"orm-fk","child":{"table":"a","columns":null},"parent":{"table":"b","columns":["x"]}}]}',
      /\n {2}relations\.0: /,
    ],
  ])('rejects %s, naming the file', async (_, content, reason) => {
    const file = content === null ? path.join((await testDirs()).stateDir, 'absent.json') : await writeTempFile('inventory.json', content);
    const error = (() => {
      try {
        loadOrderInventory(file);
      } catch (thrown) {
        return thrown;
      }
      throw new Error('expected a throw');
    })();
    expect(error).toBeInstanceOf(DependencyOrderError);
    const { name, message } = error as Error;
    expect(name).toBe('DependencyOrderError');
    expect(message).toContain(file);
    expect(message).toMatch(reason);
  });
});

describe('toMigrationOrderReport', () => {
  it('reports the basis, the planned head, the entries and one item per broken back-reference', () => {
    const order = buildDependencyOrder({ inventory: CYCLES_INVENTORY, catalog: CYCLES_CATALOG });
    const report = toMigrationOrderReport(order);
    expect(Object.keys(report)).toEqual(['basis', 'expectedHead', 'order', 'brokenCycles']);
    expect(report.basis).toEqual({
      relations: 'opt2/inventory/legacy-inventory.json relations[]',
      kinds: [
        'beanORM fkcolumn/cfc property',
        'DAO join predicate in core/mura/**',
        'Program_<id> fixture foreign-key column',
        'opt2/table-ownership.json tenantParent join of a table no code join relates to its tenant parent',
      ],
      foreignKeysDeclared: 0,
      cyclePolicy: 'load without back-reference column, patch in second pass; a back-reference mirrored by a kept relation loads unchanged',
    });
    expect(report.expectedHead).toEqual({ provenance: 'planning', tables: EXPECTED_HEAD });
    expect(report.order).toBe(order.entries);
    expect(report.brokenCycles).toEqual([
      { tables: ['talpha', 'tbeta'], backReferenceColumn: 'talpha.BetaID', patchedInSecondPass: true },
      { tables: ['tdelta', 'tgamma'], backReferenceColumn: 'tdelta.linkid', patchedInSecondPass: false },
    ]);
  });
});

describe('computeDependencyOrder', () => {
  it('loads an inventory path, orders it and writes migration-order.json headed by the source SHA', async () => {
    const inventory = await writeTempFile('legacy-inventory.json', JSON.stringify(LEGACY_FORM));
    const target = await makeReportTarget();
    const catalog = fakeCatalog(LEGACY_FORM_TABLES);
    const order = await computeDependencyOrder({ inventory, catalog, reportsOpts: { target, clock: CLOCK } });

    expect(order.order).toEqual([
      'tsettings',
      'tredirects',
      'tjobqueue',
      'synthetic.program_site',
      'Program_1.grant',
      'Program_1.award',
      'Program_2.grant',
      'Program_2.award',
    ]);
    expect(order.parentOf('Program_2.award')?.id).toBe('rel:fold');
    expect(order.parentOf('tjobqueue')?.id).toBe('rel:dao');
    expect(summary(order)).toEqual(summary(buildDependencyOrder({ inventory: LEGACY_FORM_PARSED, catalog })));

    const report = readReport(target);
    expect(Object.keys(report).slice(0, 4)).toEqual(['sourceSha', 'generatedBy', 'generatedAt', 'status']);
    expect(report).toEqual({
      sourceSha: TEST_SOURCE_SHA,
      generatedBy: 'migration/src/order/dependency-order.ts',
      generatedAt: '2026-03-04T05:06:07.000Z',
      status: 'generated',
      ...(JSON.parse(JSON.stringify(toMigrationOrderReport(order))) as Record<string, unknown>),
    });
  });

  it('orders the fixture inventory file and writes its order, deferred column and cycle into the reports directory', async () => {
    const dirs = await testDirs();
    const inventory = await writeInventoryFile(dirs.stateDir);
    const target = await makeReportTarget();
    const order = await computeDependencyOrder({ inventory, catalog: FIXTURE_CATALOG, reportsOpts: { target, clock: CLOCK } });
    expect(summary(order)).toEqual(summary(buildDependencyOrder({ inventory: FIXTURE_INVENTORY, catalog: FIXTURE_CATALOG })));

    const report = readReport(target);
    expect(Object.keys(report).slice(0, 4)).toEqual(['sourceSha', 'generatedBy', 'generatedAt', 'status']);
    expect(report).toEqual({
      sourceSha: TEST_SOURCE_SHA,
      generatedBy: 'migration/src/order/dependency-order.ts',
      generatedAt: '2026-03-04T05:06:07.000Z',
      status: 'generated',
      ...(JSON.parse(JSON.stringify(toMigrationOrderReport(order))) as Record<string, unknown>),
    });
    expect((report.order as { table: string }[]).map(({ table }) => table)).toEqual(FIXTURE_ENTRIES.map(([table]) => table));
    expect(report.brokenCycles).toEqual([{ tables: ['tcontent', 'tfiles'], backReferenceColumn: 'tcontent.FileID', patchedInSecondPass: true }]);
  });

  it.each<[string, null | undefined]>([
    ['null', null],
    ['omitted', undefined],
  ])('orders an inventory object without writing a report when reportsOpts is %s', async (_, reportsOpts) => {
    const order = await computeDependencyOrder({ inventory: MAIN_INVENTORY, catalog: MAIN_CATALOG, reportsOpts });
    expect(summary(order)).toEqual(summary(buildDependencyOrder({ inventory: MAIN_INVENTORY, catalog: MAIN_CATALOG })));
  });

  it('passes the given generatedBy to the report', async () => {
    const target = await makeReportTarget();
    await computeDependencyOrder({
      inventory: PAIR_INVENTORY,
      catalog: CYCLES_CATALOG,
      reportsOpts: { target, clock: CLOCK, generatedBy: 'opt2-migrate order' },
    });
    expect(readReport(target)).toMatchObject({
      sourceSha: TEST_SOURCE_SHA,
      generatedBy: 'opt2-migrate order',
      generatedAt: '2026-03-04T05:06:07.000Z',
    });
  });
});

describe('writeMigrationOrderReport', () => {
  it('writes under the reports directory with the module as generator and the system clock by default', async () => {
    const target = await makeReportTarget();
    const order = buildDependencyOrder({ inventory: PAIR_INVENTORY, catalog: CYCLES_CATALOG });
    const before = Date.now();
    const written = await writeMigrationOrderReport(target, order);
    expect(written.path).toBe(path.join(target.reportsDir, MIGRATION_ORDER_REPORT));
    expect(readReport(target)).toEqual(written.report);
    expect(written.report).toMatchObject({
      sourceSha: TEST_SOURCE_SHA,
      generatedBy: 'migration/src/order/dependency-order.ts',
      status: 'generated',
    });
    const generatedAt = Date.parse(String(written.report.generatedAt));
    expect(generatedAt).toBeGreaterThanOrEqual(before);
    expect(generatedAt).toBeLessThanOrEqual(Date.now());
  });
});
