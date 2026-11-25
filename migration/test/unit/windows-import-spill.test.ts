// Unit tests for the window import's byte-bounded sorted runs: spilled and in-memory imports apply the same batches,
// rebuilt rows decode only when read, and runs are disposed whichever side of a table fails.
import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from '@opt2/platform/logging';
import { decodeRow, encodeKey, encodeRow, type ApplyRequest, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { BridgeClient, LegacyDb } from '../../src/legacy/index.js';
import { loadUnitCatalog, type OwnersClient, type UnitCatalog } from '../../src/owners/index.js';
import { WindowImportError, decodedRowOf, importWindow, keyRowOf, type ImportInput, type WindowImportContext } from '../../src/windows/import.js';
import {
  connectionLost,
  createFakeLegacyDb,
  type FakeLegacyDb,
  type LegacyColumnDef,
  type LegacyTableOptions,
  type Row,
  type StatementRecord,
} from '../helpers/fake-legacy-db.js';
import { UNITS, fixtureInventoryFor, writeInventoryFile, writeOwnershipFile } from '../helpers/fixtures.js';
import { createOwnerDoubles, type OwnerFailure } from '../helpers/owner-double.js';

// Every decodeRow call passes through, counted by encoding, so a test can tell which rows were decoded.
const decodes = vi.hoisted(() => new Map<string, number>());

vi.mock('@opt2/platform/migration-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/migration-kit')>();
  return {
    ...actual,
    decodeRow: (columns: Parameters<typeof actual.decodeRow>[0], encoding: string) => {
      decodes.set(encoding, (decodes.get(encoding) ?? 0) + 1);
      return actual.decodeRow(columns, encoding);
    },
  };
});

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const UMBRELLA = CONFIG.umbrellaSiteId;
// Small batches and legacy chunks, so applies run while the sorted runs are still being read.
const BATCH_ROWS = 2;
// One byte per run: every added row spills, and merges reduce the runs at the smallest fan-in.
const SPILL_EVERY_ROW = 1;

/** The two tenant sites in tenant order, so a scenario can name the tenant a key is first held in. */
const [FIRST, SECOND] = ['tenant-a', 'tenant-b'].sort((a, b) => (tenantIdForSite(a) < tenantIdForSite(b) ? -1 : 1)) as [string, string];
const SITE_OF = new Map(['default', 'tenant-a', 'tenant-b', UMBRELLA].map((site) => [tenantIdForSite(site), site]));

const col = (name: string, type: LegacyColumnDef['type'], length?: number): LegacyColumnDef => ({ name, type, ...(length === undefined ? {} : { length }) });
const s = (name: string): CanonicalColumn => ({ name, type: 's' });
const i = (name: string): CanonicalColumn => ({ name, type: 'i' });

/** One live legacy table with its rows. */
interface LegacyTable {
  qualified: string;
  columns: LegacyColumnDef[];
  options?: LegacyTableOptions;
  rows: Row[];
}

/** A window import over seeded legacy tables and target rows, with the rows it must apply per site. */
interface Scenario {
  name: string;
  unit: string;
  owner: string;
  /** Imports over the fixture's table ownership and inventory instead of the committed ownership. */
  fixture?: boolean;
  scope: ImportInput['scope'];
  legacy: LegacyTable[];
  /** The owner's export columns of the unit's table. */
  columns: CanonicalColumn[];
  /** Target rows held before the window, per legacy table name (folded tables as `Program_<id>.<table>`) and site. */
  held: { table: string; site: string; rows: Row[] }[];
  /** Columns of each applied row the expectation shows. */
  show: string[];
  /** Applied rows per site as `[programId, op, discriminator, ...shown values]`. */
  expected: Record<string, unknown[][]>;
}

const TSETTINGS: LegacyTable = {
  qualified: 'dbo.tsettings',
  columns: [col('SiteID', 'nvarchar', 25), col('filePoolID', 'varchar', 25)],
  options: { primaryKey: ['SiteID'] },
  rows: ['default', 'tenant-a', 'tenant-b', UMBRELLA].map((SiteID) => ({ SiteID, filePoolID: null })),
};

const ARCHIVES: LegacyTable = {
  qualified: 'synthetic.person_archive',
  columns: [col('archive_id', 'int'), col('siteID', 'nvarchar', 50), col('archived_by', 'nvarchar', 50)],
  options: { primaryKey: ['archive_id'] },
  rows: [
    { archive_id: 1, siteID: FIRST, archived_by: 'Renamed' },
    { archive_id: 3, siteID: FIRST, archived_by: 'New' },
    { archive_id: 4, siteID: SECOND, archived_by: 'Changed' },
    { archive_id: 5, siteID: FIRST, archived_by: 'Same' },
    { archive_id: 10, siteID: FIRST, archived_by: 'Ten' },
    { archive_id: 12, siteID: SECOND, archived_by: 'Twelve' },
  ],
};

const KEYED: Scenario = {
  name: 'a keyed table across tenants, in canonical rather than numeric key order',
  unit: 'people.person_archive',
  owner: 'people',
  scope: { table: true },
  legacy: [ARCHIVES],
  columns: [i('archive_id'), s('siteID'), s('archived_by')],
  held: [
    {
      table: 'synthetic.person_archive',
      site: FIRST,
      rows: [
        { archive_id: '1', siteID: FIRST, archived_by: 'Original' },
        { archive_id: '2', siteID: FIRST, archived_by: 'Deleted' },
        { archive_id: '5', siteID: FIRST, archived_by: 'Same' },
        { archive_id: '10', siteID: FIRST, archived_by: 'Ten old' },
        { archive_id: '11', siteID: FIRST, archived_by: 'Gone' },
      ],
    },
    { table: 'synthetic.person_archive', site: SECOND, rows: [{ archive_id: '4', siteID: SECOND, archived_by: 'Before' }] },
  ],
  show: ['archive_id', 'archived_by'],
  expected: {
    // Deletes follow every upsert, in apply-encoding order.
    [FIRST]: [
      [undefined, 'upsert', undefined, '1', 'Renamed'],
      [undefined, 'upsert', undefined, '10', 'Ten'],
      [undefined, 'upsert', undefined, '3', 'New'],
      [undefined, 'delete', undefined, '2', 'Deleted'],
      [undefined, 'delete', undefined, '11', 'Gone'],
    ],
    [SECOND]: [
      [undefined, 'upsert', undefined, '12', 'Twelve'],
      [undefined, 'upsert', undefined, '4', 'Changed'],
    ],
  },
};

const object = (name: string, site: string, order: number): Row => ({ Object: name, SiteID: site, Name: name, OrderNo: order });
const heldObject = (name: string, site: string, order: number): Row => ({ ...object(name, site, order), OrderNo: String(order) });
const SYSTEM_OBJECT_COLUMNS = [col('Object', 'varchar', 50), col('SiteID', 'varchar', 25), col('Name', 'varchar', 50), col('OrderNo', 'int')];

const KEYLESS: Scenario = {
  name: 'a keyless table whose duplicated rows gain and lose occurrences',
  unit: 'programs_sites.system_object',
  owner: 'programs-sites',
  scope: { table: true },
  legacy: [
    {
      qualified: 'dbo.tsystemobjects',
      columns: SYSTEM_OBJECT_COLUMNS,
      rows: [object('A', FIRST, 1), object('C', FIRST, 1), object('A', FIRST, 1), object('B', FIRST, 1), object('A', FIRST, 1), object('C', FIRST, 1), object('E', SECOND, 2)],
    },
  ],
  columns: [s('Object'), s('SiteID'), s('Name'), i('OrderNo')],
  held: [
    { table: 'tsystemobjects', site: FIRST, rows: [heldObject('A', FIRST, 1), heldObject('B', FIRST, 1), heldObject('B', FIRST, 1), heldObject('D', FIRST, 1)] },
    { table: 'tsystemobjects', site: SECOND, rows: [heldObject('E', SECOND, 2), heldObject('E', SECOND, 2)] },
  ],
  show: ['Object'],
  expected: {
    [FIRST]: [
      [undefined, 'insert', undefined, 'A'],
      [undefined, 'insert', undefined, 'A'],
      [undefined, 'insert', undefined, 'C'],
      [undefined, 'insert', undefined, 'C'],
      [undefined, 'delete', undefined, 'B'],
      [undefined, 'delete', undefined, 'D'],
    ],
    [SECOND]: [[undefined, 'delete', undefined, 'E']],
  },
};

const enrolments = (rows: [number, number][]): Row[] => rows.map(([enrolment, cohort]) => ({ enrolment_id: enrolment, cohort_id: cohort }));
const heldEnrolments = (rows: [number, number][]): Row[] => rows.map(([enrolment, cohort]) => ({ enrolment_id: String(enrolment), cohort_id: String(cohort) }));
const enrolmentTable = (programId: number, rows: [number, number][]): LegacyTable => ({
  qualified: `Program_${String(programId)}.enrolment`,
  columns: [col('enrolment_id', 'int'), col('cohort_id', 'int')],
  options: { primaryKey: ['enrolment_id'] },
  rows: enrolments(rows),
});

const FOLDED: Scenario = {
  name: 'a Program_<id> table folded into per-program batches of each program tenant',
  unit: UNITS.enrolment,
  owner: 'programs-sites',
  fixture: true,
  scope: { table: true },
  legacy: [
    {
      qualified: 'synthetic.program_site',
      columns: [col('program_id', 'int'), col('siteID', 'nvarchar', 25)],
      options: { primaryKey: ['program_id'] },
      rows: [
        { program_id: 1, siteID: FIRST },
        { program_id: 2, siteID: SECOND },
      ],
    },
    enrolmentTable(1, [
      [1, 7],
      [2, 4],
      [3, 8],
    ]),
    enrolmentTable(2, [
      [1, 6],
      [2, 5],
    ]),
  ],
  columns: [i('enrolment_id'), i('cohort_id')],
  held: [
    {
      table: 'Program_1.enrolment',
      site: FIRST,
      rows: heldEnrolments([
        [1, 8],
        [4, 8],
      ]),
    },
    { table: 'Program_2.enrolment', site: SECOND, rows: heldEnrolments([[1, 6]]) },
  ],
  show: ['enrolment_id', 'cohort_id'],
  expected: {
    [FIRST]: [
      [1, 'upsert', undefined, '1', '7'],
      [1, 'upsert', undefined, '2', '4'],
      [1, 'upsert', undefined, '3', '8'],
      [1, 'delete', undefined, '4', '8'],
    ],
    [SECOND]: [[2, 'upsert', undefined, '2', '5']],
  },
};

const token = (id: string, client: string, granttype: string): Row => ({ token: id, clientid: client, granttype });

const PARENT_TENANT: Scenario = {
  name: 'a child table that keeps the first tenant holding a key and places new rows by their parent',
  unit: 'identity.oauth_token',
  owner: 'identity',
  scope: { table: true },
  legacy: [
    {
      qualified: 'dbo.toauthclients',
      columns: [col('clientid', 'varchar', 35), col('siteid', 'varchar', 25), col('name', 'varchar', 50)],
      options: { primaryKey: ['clientid'] },
      rows: [
        { clientid: 'C1', siteid: FIRST, name: 'Portal' },
        { clientid: 'C4', siteid: SECOND, name: 'Partner' },
      ],
    },
    {
      qualified: 'dbo.toauthtokens',
      columns: [col('token', 'varchar', 35), col('clientid', 'varchar', 35), col('granttype', 'varchar', 50)],
      options: { primaryKey: ['token'] },
      rows: [token('T10', 'C1', 'password'), token('T11', 'C1', 'refresh_token'), token('T12', 'C99', 'password'), token('T13', 'C4', 'client_credentials')],
    },
  ],
  columns: [s('token'), s('clientid'), s('granttype')],
  held: [
    { table: 'toauthtokens', site: FIRST, rows: [token('T13', 'C4', 'authorization_code')] },
    { table: 'toauthtokens', site: SECOND, rows: [token('T11', 'C1', 'password'), token('T13', 'C4', 'authorization_code'), token('T14', 'C4', 'password')] },
  ],
  show: ['token', 'granttype'],
  expected: {
    [FIRST]: [
      [undefined, 'upsert', undefined, 'T10', 'password'],
      [undefined, 'upsert', undefined, 'T13', 'client_credentials'],
    ],
    [SECOND]: [
      [undefined, 'upsert', undefined, 'T11', 'refresh_token'],
      [undefined, 'delete', undefined, 'T13', 'authorization_code'],
      [undefined, 'delete', undefined, 'T14', 'password'],
    ],
    [UMBRELLA]: [[undefined, 'upsert', undefined, 'T12', 'password']],
  },
};

const TRASH_COLUMNS = [col('objectID', 'varchar', 35), col('siteID', 'varchar', 25), col('objectClass', 'varchar', 50), col('objectLabel', 'varchar', 50)];
const trash = (objectID: string, objectClass: string, objectLabel: string): Row => ({ objectID, siteID: FIRST, objectClass, objectLabel });

const CLASS_MAP: Scenario = {
  name: 'a class-split table whose stored-data class updates held rows only',
  unit: 'people.trash',
  owner: 'people',
  scope: { keys: { siteid: FIRST } },
  legacy: [
    {
      qualified: 'dbo.ttrash',
      columns: TRASH_COLUMNS,
      options: { primaryKey: ['objectID'] },
      rows: [trash('C1', 'content', 'c'), trash('G1', 'group', 'g'), trash('U1', 'user', 'new'), trash('U2', 'user', 'same'), trash('X1', 'unmapped', 'x2')],
    },
  ],
  columns: [s('objectID'), s('siteID'), s('objectClass'), s('objectLabel')],
  held: [{ table: 'ttrash', site: FIRST, rows: [trash('U1', 'user', 'old'), trash('U2', 'user', 'same'), trash('U3', 'user', 'gone'), trash('X1', 'unmapped', 'x1')] }],
  show: ['objectID', 'objectLabel'],
  expected: {
    [FIRST]: [
      [undefined, 'upsert', 'people', 'U1', 'new'],
      [undefined, 'upsert', 'people', 'X1', 'x2'],
      [undefined, 'delete', 'people', 'U3', 'gone'],
    ],
  },
};

const user = (UserID: string, Fname: string, Type: number): Row => ({ UserID, Fname, Type, SiteID: FIRST });
const heldUser = (UserID: string, Fname: string): Row => ({ UserID, Fname, Type: '2', SiteID: FIRST });

const CARRIED: Scenario = {
  name: 'a column-split table whose apply rows carry the split column the owner does not export',
  unit: 'people.person',
  owner: 'people',
  scope: { keys: { siteid: FIRST } },
  legacy: [
    {
      qualified: 'dbo.tusers',
      columns: [col('UserID', 'nvarchar', 35), col('Fname', 'nvarchar', 50), col('Type', 'int'), col('SiteID', 'nvarchar', 50)],
      options: { primaryKey: ['UserID'] },
      rows: [user('G1', 'Group', 1), user('U1', 'Anne', 2), user('U2', 'Bob', 2), user('U4', 'Dan', 2)],
    },
  ],
  columns: [s('UserID'), s('Fname'), i('Type'), s('SiteID')],
  held: [{ table: 'tusers', site: FIRST, rows: [heldUser('U1', 'Ann'), heldUser('U2', 'Bob'), heldUser('U3', 'Gone')] }],
  show: ['UserID', 'Fname', 'Type'],
  expected: {
    [FIRST]: [
      [undefined, 'upsert', undefined, 'U1', 'Anne', '2'],
      [undefined, 'upsert', undefined, 'U4', 'Dan', '2'],
      [undefined, 'delete', undefined, 'U3', 'Gone', '2'],
    ],
  },
};

const assignment = (contentHistID: string, categoryID: string, orderno: number, siteID = FIRST): Row => ({
  contentHistID,
  categoryID,
  contentID: `C-${contentHistID}`,
  isFeature: 0,
  orderno,
  siteID,
});
const heldAssignment = (contentHistID: string, categoryID: string, orderno: number, siteID = FIRST): Row => ({
  ...assignment(contentHistID, categoryID, orderno, siteID),
  isFeature: '0',
  orderno: String(orderno),
});

const COMPOSITE_KEY: Scenario = {
  name: 'a composite key the owner exports in another order than its key columns',
  unit: 'content.content_category_assign',
  owner: 'strategies-content',
  scope: { table: true },
  legacy: [
    {
      qualified: 'dbo.tcontentcategoryassign',
      columns: [col('contentHistID', 'varchar', 35), col('categoryID', 'varchar', 35), col('contentID', 'varchar', 35), col('isFeature', 'int'), col('orderno', 'int'), col('siteID', 'varchar', 25)],
      options: { primaryKey: ['contentHistID', 'categoryID'] },
      rows: [assignment('H1', 'C1', 1), assignment('H1', 'C2', 2), assignment('H10', 'C1', 1), assignment('H2', 'C1', 1), assignment('H3', 'C1', 1, SECOND)],
    },
  ],
  columns: [s('categoryID'), s('contentHistID'), s('contentID'), i('isFeature'), i('orderno'), s('siteID')],
  held: [
    {
      table: 'tcontentcategoryassign',
      site: FIRST,
      rows: [heldAssignment('H1', 'C1', 1), heldAssignment('H1', 'C2', 1), heldAssignment('H1', 'C3', 1), heldAssignment('H10', 'C1', 3)],
    },
    { table: 'tcontentcategoryassign', site: SECOND, rows: [heldAssignment('H3', 'C1', 1, SECOND), heldAssignment('H4', 'C1', 1, SECOND)] },
  ],
  show: ['contentHistID', 'categoryID', 'orderno'],
  expected: {
    [FIRST]: [
      [undefined, 'upsert', undefined, 'H1', 'C2', '2'],
      [undefined, 'upsert', undefined, 'H10', 'C1', '1'],
      [undefined, 'upsert', undefined, 'H2', 'C1', '1'],
      [undefined, 'delete', undefined, 'H1', 'C3', '1'],
    ],
    [SECOND]: [[undefined, 'delete', undefined, 'H4', 'C1', '1']],
  },
};

const UNCHANGED_KEYLESS: Scenario = {
  ...KEYLESS,
  name: 'a keyless table with an unchanged row',
  legacy: [{ qualified: 'dbo.tsystemobjects', columns: SYSTEM_OBJECT_COLUMNS, rows: [object('A', FIRST, 1), object('B', FIRST, 1)] }],
  held: [{ table: 'tsystemobjects', site: FIRST, rows: [heldObject('A', FIRST, 1), heldObject('C', FIRST, 1)] }],
  expected: {
    [FIRST]: [
      [undefined, 'insert', undefined, 'B'],
      [undefined, 'delete', undefined, 'C'],
    ],
  },
};

const NEW_STORED_CLASS: Scenario = {
  ...CLASS_MAP,
  name: 'a new row of a class whose owner depends on stored data',
  legacy: [{ qualified: 'dbo.ttrash', columns: TRASH_COLUMNS, options: { primaryKey: ['objectID'] }, rows: [trash('U1', 'user', 'new'), trash('U9', 'user', 'fresh')] }],
};

/** What one import did: the batches the owner applied, its error, the spill directories seen at each legacy read, export and apply, and the tenants exported. */
interface Outcome {
  batches: ApplyRequest[];
  error: unknown;
  spills: number[];
  exports: string[];
}

/** Faults of one import: `legacy` prepares the fake database; `beforeLive` and `beforeExport` are awaited as each legacy read and tenant export starts. */
interface Hooks {
  legacy?: (fake: FakeLegacyDb) => void;
  beforeLive?: (fake: FakeLegacyDb) => Promise<void>;
  beforeExport?: (tenantId: string, fake: FakeLegacyDb) => Promise<void>;
}

let databases = 0;
let spillDir: string;
let inventoryDir: string;
/** Table ownership, unit catalog and inventory of the committed ownership and of the fixture's. */
let worlds: Record<'committed' | 'fixture', { tableOwnership: string; catalog: UnitCatalog; inventory: string }>;

beforeAll(async () => {
  inventoryDir = await mkdtemp(join(tmpdir(), 'opt2-window-spill-inventory-'));
  const fixtureDir = join(inventoryDir, 'fixture');
  const fixtureOwnership = await writeOwnershipFile(fixtureDir);
  worlds = {
    committed: { tableOwnership: CONFIG.paths.tableOwnership, catalog: CATALOG, inventory: await writeInventoryFile(join(inventoryDir, 'committed'), fixtureInventoryFor(CATALOG)) },
    fixture: { tableOwnership: fixtureOwnership, catalog: loadUnitCatalog(fixtureOwnership), inventory: await writeInventoryFile(fixtureDir) },
  };
});

afterAll(async () => {
  await rm(inventoryDir, { recursive: true, force: true });
});

beforeEach(async () => {
  spillDir = await mkdtemp(join(tmpdir(), 'opt2-window-spill-test-'));
});

afterEach(async () => {
  await rm(spillDir, { recursive: true, force: true });
});

/** Imports `scenario` once over fresh fakes, with `sortRunBytes` bounding the sorted runs; `fail` makes the first apply fail. */
async function importOnce(scenario: Scenario, sortRunBytes: number | undefined, fail?: OwnerFailure, hooks: Hooks = {}): Promise<Outcome> {
  databases += 1;
  const tables = [TSETTINGS, ...scenario.legacy];
  const fake = createFakeLegacyDb({
    database: `muradb_spill_${String(databases)}`,
    tables: tables.map(({ qualified, columns, options }) => ({ qualified, columns, ...(options === undefined ? {} : { options }) })),
    rows: Object.fromEntries(tables.map((table) => [table.qualified, table.rows])),
  });
  hooks.legacy?.(fake);
  const { tableOwnership, catalog, inventory } = worlds[scenario.fixture === true ? 'fixture' : 'committed'];
  const doubles = createOwnerDoubles(catalog, { owners: [scenario.owner] });
  const owner = doubles.owner(scenario.owner);
  for (const { table, site, rows } of scenario.held) owner.seedRows(table, tenantIdForSite(site), rows, scenario.columns);
  if (fail !== undefined) owner.failNext('apply', fail);
  const spills: number[] = [];
  const exports: string[] = [];
  const observe = (): void => {
    spills.push(readdirSync(spillDir).length);
  };
  const legacy: LegacyDb = {
    ...fake,
    live: async () => {
      observe();
      await hooks.beforeLive?.(fake);
      return fake.live();
    },
  };
  const owners: OwnersClient = {
    ...doubles.client,
    async *exportPages(name, params) {
      observe();
      exports.push(params.tenantId);
      await hooks.beforeExport?.(params.tenantId, fake);
      yield* doubles.client.exportPages(name, params);
    },
    apply: (name, request) => {
      observe();
      return doubles.client.apply(name, request);
    },
  };
  const ctx = {
    config: { ...CONFIG, paths: { ...CONFIG.paths, inventory, tableOwnership }, backfill: { ...CONFIG.backfill, batchRows: BATCH_ROWS } },
    legacy,
    catalog,
    owners,
    bridge: {} as BridgeClient,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  } as WindowImportContext;
  const input: ImportInput = { windowId: 'W1', attempt: 1, units: [scenario.unit], scope: scenario.scope };
  const error = await importWindow(ctx, input, { sortRunBytes, spillDir }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return { batches: owner.batches, error, spills, exports };
}

/** Applied rows per site as `[programId, op, discriminator, ...shown values]`. */
function appliedBySite(batches: readonly ApplyRequest[], show: readonly string[]): Record<string, unknown[][]> {
  const bySite: Record<string, unknown[][]> = {};
  for (const batch of batches) {
    const site = SITE_OF.get(batch.tenantId ?? '') ?? String(batch.tenantId);
    for (const row of batch.rows) {
      const values = decodeRow(batch.columns, row.row);
      (bySite[site] ??= []).push([batch.legacyProgramId, row.op, row.discriminator, ...show.map((name) => values[name])]);
    }
  }
  return bySite;
}

describe('importWindow through spilled sorted runs', () => {
  it.each([KEYED, KEYLESS, FOLDED, PARENT_TENANT, CLASS_MAP, CARRIED, COMPOSITE_KEY])('applies the same batches spilled as in memory: $name', async (scenario) => {
    const memory = await importOnce(scenario, undefined);
    const spilled = await importOnce(scenario, SPILL_EVERY_ROW);

    expect(memory.error).toBeUndefined();
    expect(spilled.error).toBeUndefined();
    expect(appliedBySite(memory.batches, scenario.show)).toEqual(scenario.expected);
    expect(spilled.batches).toEqual(memory.batches);
    expect(memory.spills.every((count) => count === 0)).toBe(true);
    expect(Math.max(...spilled.spills)).toBeGreaterThan(0);
    expect(await readdir(spillDir)).toEqual([]);
  });

  it.each([
    ['a new row of a stored-data class fails the join', NEW_STORED_CLASS, undefined, 'depends on its stored object'],
    ['an owner refuses an apply mid-table', KEYED, 'down' as const, 'ECONNREFUSED'],
  ] as [string, Scenario, OwnerFailure | undefined, string][])('removes every spill directory when %s', async (_case, scenario, fail, message) => {
    const memory = await importOnce(scenario, undefined, fail);
    const spilled = await importOnce(scenario, SPILL_EVERY_ROW, fail);

    expect(spilled.error).toBeInstanceOf(WindowImportError);
    expect((spilled.error as WindowImportError).message).toContain(message);
    expect((spilled.error as WindowImportError).message).toBe((memory.error as WindowImportError).message);
    expect(spilled.batches).toEqual([]);
    expect(Math.max(...spilled.spills)).toBeGreaterThan(0);
    expect(await readdir(spillDir)).toEqual([]);
  });

  // An unchanged row is decoded where it is read: once as the owner's row is checked and once by the extractor. The
  // sorted runs, the join and the diff rebuild it without decoding it again.
  it.each([
    { name: KEYED.name, scenario: KEYED, unchanged: { archive_id: '5', siteID: FIRST, archived_by: 'Same' } },
    { name: UNCHANGED_KEYLESS.name, scenario: UNCHANGED_KEYLESS, unchanged: heldObject('A', FIRST, 1) },
  ])('decodes an unchanged row only where it is read: $name', async ({ scenario, unchanged }) => {
    decodes.clear();
    const outcome = await importOnce(scenario, undefined);

    expect(outcome.error).toBeUndefined();
    expect(appliedBySite(outcome.batches, scenario.show)).toEqual(scenario.expected);
    expect(decodes.get(encodeRow(scenario.columns, unchanged))).toBe(2);
  });
});

describe('decodedRowOf', () => {
  type Layout = Parameters<typeof decodedRowOf>[1];
  const keyed: Layout = { columns: [i('id'), s('title')], compare: [i('id'), s('title')], keyNames: ['id'], folded: false };
  const keyless: Layout = { ...keyed, keyNames: [] };
  const encoding = encodeRow(keyed.compare, { id: '7', title: 'Seven' });

  it.each<{ name: string; layout: Layout; extra: Record<string, string>; keyValues?: string[]; lazy: boolean }>([
    { name: 'a keyed row given its key values', layout: keyed, extra: {}, keyValues: ['7'], lazy: true },
    { name: 'a keyless row', layout: keyless, extra: {}, lazy: true },
    { name: 'a row with a value the comparison leaves out', layout: keyed, extra: { Type: '2' }, keyValues: ['7'], lazy: true },
    { name: 'a keyed row without its key values', layout: keyed, extra: {}, lazy: false },
    { name: 'a row whose extra value replaces a compared one', layout: keyed, extra: { title: 'Other' }, keyValues: ['7'], lazy: false },
  ])('rebuilds $name as its decoded values give it', ({ layout, extra, keyValues, lazy }) => {
    const values = { ...decodeRow(layout.compare, encoding), ...extra };
    const rowEncoding = encodeRow(layout.compare, values);
    const key = layout.keyNames.length === 0 ? rowEncoding : encodeKey(layout.compare, layout.keyNames, values);
    const keys = layout.keyNames.map((name) => values[name]);
    decodes.clear();

    const row = decodedRowOf('t', layout, encoding, undefined, extra, keyValues);
    const decodedNow = lazy ? undefined : 1;
    expect(decodes.get(encoding)).toBe(decodedNow);
    if (layout.keyNames.length > 0) expect(keyRowOf(row, layout)).toEqual({ table: 't', key, keyValues: keys, encoding: key, row: {} });
    expect(decodes.get(encoding)).toBe(decodedNow);
    // A spread copies the decoded values; later reads return the same values without decoding again.
    expect({ ...row }).toEqual({ table: 't', key, keyValues: keys, encoding: rowEncoding, row: values });
    expect(row.row).toBe(row.row);
    expect(decodes.get(encoding)).toBe(1);
  });
});

/** Whether `statement` is the legacy side's read of the OAuth token rows. */
const readsTokens = (statement: StatementRecord): boolean => statement.sql.includes('[dbo].[toauthtokens]');

/** Resolves on the first event-loop turn at which `fake` has run a statement `matches` accepts; fails after 10 s. */
async function statementRun(fake: FakeLegacyDb, matches: (statement: StatementRecord) => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fake.statements.some(matches)) {
    if (Date.now() > deadline) throw new Error('the legacy side never read the table');
    await nextTurn();
  }
}

describe('importWindow while both sides of a table read', () => {
  it.each([
    { name: 'the owner export fails while the legacy side streams', failing: 'target', message: 'export page lost' },
    { name: 'the legacy stream fails while the owner export is read', failing: 'legacy', message: 'reading toauthtokens from database' },
  ])('fails with WindowImportError and disposes every run when $name', async ({ failing, message }) => {
    // The export after FIRST's, whose rows have spilled by then, starts once the legacy side reads the table.
    const tenants = [...SITE_OF.keys()].sort();
    const read = tenants.slice(0, tenants.indexOf(tenantIdForSite(FIRST)) + 2);
    const gated = read.at(-1);
    // Each side waits for the other to be mid-read before it fails, so the failure always lands while both sides read.
    let targetFailed = (): void => undefined;
    const failed = new Promise<void>((resolve) => {
      targetFailed = resolve;
    });
    let targetGated = (): void => undefined;
    const atGate = new Promise<void>((resolve) => {
      targetGated = resolve;
    });
    let exportsStarted = false;
    let gateDone = false;
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    let outcome: Outcome;
    try {
      outcome = await importOnce(PARENT_TENANT, SPILL_EVERY_ROW, undefined, {
        legacy: (fake) => {
          if (failing === 'legacy') fake.failNext(readsTokens, connectionLost());
        },
        // Legacy reads made once the exports have started belong to the legacy side of the table.
        beforeLive: async (fake) => {
          if (failing === 'target' && fake.statements.some(readsTokens)) await failed;
          if (failing === 'legacy' && exportsStarted) await atGate;
        },
        beforeExport: async (tenantId, fake) => {
          exportsStarted = true;
          if (tenantId !== gated) return;
          targetGated();
          await statementRun(fake, readsTokens);
          if (failing === 'target') {
            gateDone = true;
            targetFailed();
            throw new Error('export page lost');
          }
          // Time for the legacy failure to reach the import, which then reads no further export.
          await sleep(200);
          gateDone = true;
        },
      });
      await nextTurn();
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(outcome.error).toBeInstanceOf(WindowImportError);
    expect((outcome.error as WindowImportError).message).toContain(message);
    expect(outcome.batches).toEqual([]);
    // Neither failure lets the owner's exports be read past the gated tenant, and the import ends only after its export.
    expect(outcome.exports).toEqual(read);
    expect(gateDone).toBe(true);
    expect(Math.max(...outcome.spills)).toBeGreaterThan(0);
    expect(await readdir(spillDir)).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
