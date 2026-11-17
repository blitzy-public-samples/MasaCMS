// Unit tests for the window import's byte-bounded sorted runs: spilled and in-memory imports apply the same batches.
import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@opt2/platform/logging';
import { decodeRow, type ApplyRequest, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { BridgeClient, LegacyDb } from '../../src/legacy/index.js';
import { loadUnitCatalog, type OwnersClient } from '../../src/owners/index.js';
import { WindowImportError, importWindow, type ImportInput, type WindowImportContext } from '../../src/windows/import.js';
import { createFakeLegacyDb, type LegacyColumnDef, type LegacyTableOptions, type Row } from '../helpers/fake-legacy-db.js';
import { createOwnerDoubles, type OwnerFailure } from '../helpers/owner-double.js';

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

const SURVEYS: LegacyTable = {
  qualified: 'synthetic.survey',
  columns: [col('survey_id', 'int'), col('siteID', 'nvarchar', 25), col('title', 'nvarchar', 200)],
  options: { primaryKey: ['survey_id'] },
  rows: [
    { survey_id: 1, siteID: FIRST, title: 'Renamed' },
    { survey_id: 3, siteID: FIRST, title: 'New' },
    { survey_id: 4, siteID: SECOND, title: 'Changed' },
    { survey_id: 5, siteID: FIRST, title: 'Same' },
    { survey_id: 10, siteID: FIRST, title: 'Ten' },
    { survey_id: 12, siteID: SECOND, title: 'Twelve' },
  ],
};

const KEYED: Scenario = {
  name: 'a keyed table across tenants, in canonical rather than numeric key order',
  unit: 'surveys.survey',
  owner: 'surveys',
  scope: { table: true },
  legacy: [SURVEYS],
  columns: [i('survey_id'), s('siteID'), s('title')],
  held: [
    {
      table: 'synthetic.survey',
      site: FIRST,
      rows: [
        { survey_id: '1', siteID: FIRST, title: 'Original' },
        { survey_id: '2', siteID: FIRST, title: 'Deleted' },
        { survey_id: '5', siteID: FIRST, title: 'Same' },
        { survey_id: '10', siteID: FIRST, title: 'Ten old' },
        { survey_id: '11', siteID: FIRST, title: 'Gone' },
      ],
    },
    { table: 'synthetic.survey', site: SECOND, rows: [{ survey_id: '4', siteID: SECOND, title: 'Before' }] },
  ],
  show: ['survey_id', 'title'],
  expected: {
    [FIRST]: [
      [undefined, 'upsert', undefined, '1', 'Renamed'],
      [undefined, 'upsert', undefined, '10', 'Ten'],
      [undefined, 'delete', undefined, '11', 'Gone'],
      [undefined, 'delete', undefined, '2', 'Deleted'],
      [undefined, 'upsert', undefined, '3', 'New'],
    ],
    [SECOND]: [
      [undefined, 'upsert', undefined, '12', 'Twelve'],
      [undefined, 'upsert', undefined, '4', 'Changed'],
    ],
  },
};

const object = (name: string, site: string, order: number): Row => ({ Object: name, SiteID: site, Name: name, OrderNo: order });
const heldObject = (name: string, site: string, order: number): Row => ({ ...object(name, site, order), OrderNo: String(order) });

const KEYLESS: Scenario = {
  name: 'a keyless table whose duplicated rows gain and lose occurrences',
  unit: 'programs_sites.system_object',
  owner: 'programs-sites',
  scope: { table: true },
  legacy: [
    {
      qualified: 'dbo.tsystemobjects',
      columns: [col('Object', 'varchar', 50), col('SiteID', 'varchar', 25), col('Name', 'varchar', 50), col('OrderNo', 'int')],
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
      [undefined, 'delete', undefined, 'B'],
      [undefined, 'insert', undefined, 'C'],
      [undefined, 'insert', undefined, 'C'],
      [undefined, 'delete', undefined, 'D'],
    ],
    [SECOND]: [[undefined, 'delete', undefined, 'E']],
  },
};

const days = (rows: [number, number][]): Row[] => rows.map(([day, hours]) => ({ day_id: day, hours }));
const heldDays = (rows: [number, number][]): Row[] => rows.map(([day, hours]) => ({ day_id: String(day), hours: String(hours) }));
const dayTable = (programId: number, rows: [number, number][]): LegacyTable => ({
  qualified: `Program_${String(programId)}.timesheet_day`,
  columns: [col('day_id', 'int'), col('hours', 'int')],
  options: { primaryKey: ['day_id'] },
  rows: days(rows),
});

const FOLDED: Scenario = {
  name: 'a Program_<id> table folded into per-program batches of each program tenant',
  unit: 'timesheets.timesheet_day',
  owner: 'timesheets',
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
    dayTable(1, [
      [1, 7],
      [2, 4],
      [3, 8],
    ]),
    dayTable(2, [
      [1, 6],
      [2, 5],
    ]),
  ],
  columns: [i('day_id'), i('hours')],
  held: [
    {
      table: 'Program_1.timesheet_day',
      site: FIRST,
      rows: heldDays([
        [1, 8],
        [4, 8],
      ]),
    },
    { table: 'Program_2.timesheet_day', site: SECOND, rows: heldDays([[1, 6]]) },
  ],
  show: ['day_id', 'hours'],
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

const reminder = (id: number, survey: number, offset: number): Row => ({ reminder_id: id, survey_id: survey, offset_minutes: offset });
const heldReminder = (id: number, survey: number, offset: number): Row => ({ reminder_id: String(id), survey_id: String(survey), offset_minutes: String(offset) });

const PARENT_TENANT: Scenario = {
  name: 'a child table that keeps the first tenant holding a key and places new rows by their parent',
  unit: 'surveys.survey_reminder',
  owner: 'surveys',
  scope: { table: true },
  legacy: [
    SURVEYS,
    {
      qualified: 'synthetic.survey_reminder',
      columns: [col('reminder_id', 'int'), col('survey_id', 'int'), col('offset_minutes', 'int')],
      options: { primaryKey: ['reminder_id'] },
      rows: [reminder(10, 1, 60), reminder(11, 1, 30), reminder(12, 99, 5), reminder(13, 4, 25)],
    },
  ],
  columns: [i('reminder_id'), i('survey_id'), i('offset_minutes')],
  held: [
    { table: 'synthetic.survey_reminder', site: FIRST, rows: [heldReminder(13, 4, 20)] },
    { table: 'synthetic.survey_reminder', site: SECOND, rows: [heldReminder(11, 1, 15), heldReminder(13, 4, 20), heldReminder(14, 4, 10)] },
  ],
  show: ['reminder_id', 'offset_minutes'],
  expected: {
    [FIRST]: [
      [undefined, 'upsert', undefined, '10', '60'],
      [undefined, 'upsert', undefined, '13', '25'],
    ],
    [SECOND]: [
      [undefined, 'upsert', undefined, '11', '30'],
      [undefined, 'delete', undefined, '13', '20'],
      [undefined, 'delete', undefined, '14', '10'],
    ],
    [UMBRELLA]: [[undefined, 'upsert', undefined, '12', '5']],
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
      [undefined, 'delete', 'people', 'U3', 'gone'],
      [undefined, 'upsert', 'people', 'X1', 'x2'],
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
      [undefined, 'delete', undefined, 'U3', 'Gone', '2'],
      [undefined, 'upsert', undefined, 'U4', 'Dan', '2'],
    ],
  },
};

const NEW_STORED_CLASS: Scenario = {
  ...CLASS_MAP,
  name: 'a new row of a class whose owner depends on stored data',
  legacy: [{ qualified: 'dbo.ttrash', columns: TRASH_COLUMNS, options: { primaryKey: ['objectID'] }, rows: [trash('U1', 'user', 'new'), trash('U9', 'user', 'fresh')] }],
};

/** What one import did: the batches the owner applied, its error, and the spill directories seen at each legacy read and apply. */
interface Outcome {
  batches: ApplyRequest[];
  error: unknown;
  spills: number[];
}

let databases = 0;
let spillDir: string;

beforeEach(async () => {
  spillDir = await mkdtemp(join(tmpdir(), 'opt2-window-spill-test-'));
});

afterEach(async () => {
  await rm(spillDir, { recursive: true, force: true });
});

/** Imports `scenario` once over fresh fakes, with `sortRunBytes` bounding the sorted runs; `fail` makes the first apply fail. */
async function importOnce(scenario: Scenario, sortRunBytes: number | undefined, fail?: OwnerFailure): Promise<Outcome> {
  databases += 1;
  const tables = [TSETTINGS, ...scenario.legacy];
  const fake = createFakeLegacyDb({
    database: `muradb_spill_${String(databases)}`,
    tables: tables.map(({ qualified, columns, options }) => ({ qualified, columns, ...(options === undefined ? {} : { options }) })),
    rows: Object.fromEntries(tables.map((table) => [table.qualified, table.rows])),
  });
  const doubles = createOwnerDoubles(CATALOG, { owners: [scenario.owner] });
  const owner = doubles.owner(scenario.owner);
  for (const { table, site, rows } of scenario.held) owner.seedRows(table, tenantIdForSite(site), rows, scenario.columns);
  if (fail !== undefined) owner.failNext('apply', fail);
  const spills: number[] = [];
  const observe = (): void => {
    spills.push(readdirSync(spillDir).length);
  };
  const legacy: LegacyDb = {
    ...fake,
    live: () => {
      observe();
      return fake.live();
    },
  };
  const owners: OwnersClient = {
    ...doubles.client,
    apply: (name, request) => {
      observe();
      return doubles.client.apply(name, request);
    },
  };
  const ctx = {
    config: { ...CONFIG, backfill: { ...CONFIG.backfill, batchRows: BATCH_ROWS } },
    legacy,
    catalog: CATALOG,
    owners,
    bridge: {} as BridgeClient,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
  } as WindowImportContext;
  const input: ImportInput = { windowId: 'W1', attempt: 1, units: [scenario.unit], scope: scenario.scope };
  const error = await importWindow(ctx, input, { sortRunBytes, spillDir }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return { batches: owner.batches, error, spills };
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
  it.each([KEYED, KEYLESS, FOLDED, PARENT_TENANT, CLASS_MAP, CARRIED])('applies the same batches spilled as in memory: $name', async (scenario) => {
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
});
