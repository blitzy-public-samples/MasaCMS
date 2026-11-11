// Unit tests for the Program_<id> fold, over a fake legacy pool with scripted rows per table and a fake unit catalog.
import { EventEmitter } from 'node:events';

import type { ConnectionPool } from 'mssql';
import { compareEncodings, encodeKey, encodeRow, LEGACY_PROGRAM_ID_COLUMN, parseProgramTable } from '@opt2/platform/migration-kit';
import type { CanonicalColumn } from '@opt2/platform/migration-kit';
import { beforeEach, describe, expect, it } from 'vitest';

import { TableNotFoundError, clearCatalogCache, type LegacyTableRef } from '../../../src/extract/catalog.js';
import {
  FoldShapeError,
  describeLegacyTable,
  streamFoldedRows,
  streamLegacyTable,
  type FoldPart,
  type LegacyTableDeps,
  type LegacyTableOptions,
  type LegacyTableShape,
} from '../../../src/extract/fold.js';
import { ExtractError, compareCanonicalRows, type CanonicalRow } from '../../../src/extract/stream.js';
import type { MigratableTable } from '../../../src/extract/tables.js';
import type { LegacyDb } from '../../../src/legacy/legacy-db.js';
import { UnitCatalogError, UnknownLegacyTableError, type UnitCatalog } from '../../../src/owners/units.js';

type Row = Record<string, unknown>;

interface ColumnSpec {
  name: string;
  type: string;
  maxLength?: number;
  scale?: number;
}

interface TableSpec {
  columns: readonly ColumnSpec[];
  primaryKey?: readonly string[];
}

/** Rows one stream request emits, one per tick; `failAt` ends it with `error`, a cancel ends it with `cancelError`. */
interface StreamScript {
  rows: readonly Row[];
  failAt?: number;
  error?: unknown;
  cancelError?: unknown;
}

const CANCELED = Object.assign(new Error('Canceled.'), { code: 'ECANCEL' });
const FROM_TABLE = / FROM \[([^\]]+)\]\.\[([^\]]+)\]/;

class FakeStreamRequest extends EventEmitter {
  stream = false;
  sql = '';
  cancels = 0;
  readonly inputs: Record<string, { type: unknown; value: unknown }> = {};
  private script: StreamScript = { rows: [] };
  private paused = false;
  private index = 0;
  private ended = false;
  private settle: (() => void) | undefined;

  constructor(private readonly scripts: Readonly<Record<string, StreamScript>>) {
    super();
  }

  input(name: string, type: unknown, value: unknown): this {
    this.inputs[name] = { type, value };
    return this;
  }

  query(text: string): Promise<unknown> {
    this.sql = text;
    const from = FROM_TABLE.exec(text);
    this.script = (from === null ? undefined : this.scripts[`${String(from[1])}.${String(from[2])}`]) ?? { rows: [] };
    return new Promise((resolve) => {
      this.settle = () => resolve({});
      setImmediate(() => this.pump());
    });
  }

  pause(): boolean {
    this.paused = true;
    return true;
  }

  resume(): boolean {
    this.paused = false;
    setImmediate(() => this.pump());
    return true;
  }

  cancel(): void {
    this.cancels += 1;
    setImmediate(() => this.end(this.script.cancelError ?? CANCELED));
  }

  private pump(): void {
    if (this.ended || this.paused) return;
    if (this.index === this.script.failAt) this.end(this.script.error);
    else if (this.index >= this.script.rows.length) this.end();
    else {
      this.emit('row', this.script.rows[this.index++]);
      setImmediate(() => this.pump());
    }
  }

  private end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    if (error !== undefined) this.emit('error', error);
    this.emit('done', { rowsAffected: [] });
    this.settle?.();
  }
}

function catalogSets(spec: TableSpec | undefined): Row[][] {
  if (spec === undefined) return [[], [], []];
  const columns = spec.columns.map((column, index) => ({
    COLUMN_NAME: column.name,
    DATA_TYPE: column.type,
    IS_NULLABLE: 'YES',
    CHARACTER_MAXIMUM_LENGTH: column.maxLength ?? null,
    NUMERIC_PRECISION: column.scale === undefined ? null : 9,
    NUMERIC_SCALE: column.scale ?? null,
    ORDINAL_POSITION: index + 1,
  }));
  return [columns, (spec.primaryKey ?? []).map((name) => ({ name })), []];
}

/** `schema.table` split at the first dot, as sys.tables would list it. */
function liveTableRow(name: string): { schema_name: string; table_name: string } {
  const dot = name.indexOf('.');
  return { schema_name: name.slice(0, dot), table_name: name.slice(dot + 1) };
}

/** Fake LegacyDb: catalog and table-list queries answer from `tables` (keyed `schema.table`), row requests from `scripts` by FROM table. */
function fakeLegacy(tables: Readonly<Record<string, TableSpec>>, scripts: Readonly<Record<string, StreamScript>> = {}) {
  const streams: FakeStreamRequest[] = [];
  const opened: string[] = [];
  const listed: string[] = [];
  const specs = new Map(Object.entries(tables).map(([name, spec]) => [name.toLowerCase(), spec]));
  const pool = {
    config: { database: 'muradb_test' },
    request() {
      const request = new FakeStreamRequest(scripts);
      const query = request.query.bind(request);
      request.query = (text: string) => {
        if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
          const sets = catalogSets(specs.get(`${String(request.inputs.schema?.value)}.${String(request.inputs.table?.value)}`.toLowerCase()));
          return Promise.resolve({ recordsets: sets, recordset: sets[0] });
        }
        if (text.includes('DATABASEPROPERTYEX')) return Promise.resolve({ recordset: [{ updateability: 'READ_ONLY' }] });
        if (text.includes('sys.schemas')) {
          listed.push(text);
          return Promise.resolve({ recordset: Object.keys(tables).map(liveTableRow) });
        }
        streams.push(request);
        return query(text);
      };
      return request;
    },
  } as unknown as ConnectionPool;
  const legacy: LegacyDb = {
    live: () => {
      opened.push('(live)');
      return Promise.resolve(pool);
    },
    database: (name: string) => {
      opened.push(name);
      return Promise.resolve(pool);
    },
    transaction: () => Promise.reject(new Error('fake legacy: transaction is not used by the fold')),
    close: () => Promise.resolve(),
  };
  const streamOf = (table: string): FakeStreamRequest | undefined => streams.find((stream) => stream.sql.includes(` FROM ${table} `));
  return { legacy, streams, opened, listed, streamOf };
}

/** Ownership entries as `opt2/table-ownership.json` records them; `migratable: false` marks a retired table. */
const OWNERSHIP: Readonly<Record<string, { keyColumns?: readonly string[]; migratable?: boolean }>> = {
  'Program_N.timesheet': { keyColumns: ['timesheet_id'] },
  'Program_N.blackout': { keyColumns: [] },
  'Program_N.approval_action': { keyColumns: ['action_id'] },
  tfiles: { keyColumns: ['siteID', 'fileID'] },
  tglobals: { migratable: false },
};

function ownershipName(table: string): string | undefined {
  const lower = table.replace(/^dbo\./i, '').toLowerCase();
  return Object.keys(OWNERSHIP).find((name) => name.toLowerCase() === lower);
}

function unused(method: string): () => never {
  return () => {
    throw new Error(`fake catalog: ${method} is not used by the fold`);
  };
}

/** Catalog over OWNERSHIP folding `Program_<id>` names as loadUnitCatalog does; a name in `failures` throws its error from keyColumnsOf. */
function fakeCatalog(failures: Readonly<Record<string, Error>> = {}) {
  const keyLookups: string[] = [];
  const foldProgramTable: UnitCatalog['foldProgramTable'] = (table) => {
    const parsed = parseProgramTable(table);
    const generic = parsed === null ? undefined : ownershipName(`Program_N.${parsed.table}`);
    return parsed === null || generic === undefined ? { legacyTable: table, programId: null } : { legacyTable: generic, programId: parsed.programId };
  };
  const catalog: UnitCatalog = {
    units: unused('units'),
    unit: unused('unit'),
    ownerOf: unused('ownerOf'),
    unitsOfOwner: unused('unitsOfOwner'),
    legacyTablesOf: unused('legacyTablesOf'),
    unitsForLegacyTable: unused('unitsForLegacyTable'),
    legacyTableOwner: unused('legacyTableOwner'),
    isMigratable: unused('isMigratable'),
    isSplit: unused('isSplit'),
    ownersForLegacyTable: unused('ownersForLegacyTable'),
    foldProgramTable,
    keyColumnsOf: (table) => {
      keyLookups.push(table);
      const failure = failures[table];
      if (failure !== undefined) throw failure;
      const name = ownershipName(foldProgramTable(table).legacyTable);
      const entry = name === undefined ? undefined : OWNERSHIP[name];
      if (entry === undefined) throw new UnknownLegacyTableError(table);
      if (entry.migratable === false) throw new UnitCatalogError(`legacy table ${table} is not migratable (owner "retired")`);
      return entry.keyColumns ?? [];
    },
  };
  return { catalog, keyLookups };
}

const TIMESHEET: TableSpec = {
  columns: [
    { name: 'timesheet_id', type: 'int' },
    { name: 'person_id', type: 'char', maxLength: 35 },
    { name: 'hours', type: 'decimal', scale: 2 },
    { name: 'note', type: 'nvarchar', maxLength: 200 },
  ],
  primaryKey: ['timesheet_id'],
};

const BLACKOUT: TableSpec = {
  columns: [
    { name: 'person_id', type: 'char', maxLength: 35 },
    { name: 'reason', type: 'nvarchar', maxLength: 50 },
  ],
};

const TFILES: TableSpec = {
  columns: [
    { name: 'fileID', type: 'char', maxLength: 35 },
    { name: 'siteID', type: 'nvarchar', maxLength: 25 },
    { name: 'hits', type: 'int' },
  ],
  primaryKey: ['fileID'],
};

/** The live legacy catalog: two programs of timesheet and blackout, a dbo table sharing a folded name, and plain tables. */
const LIVE: Readonly<Record<string, TableSpec>> = {
  'Program_2.timesheet': TIMESHEET,
  'Program_1.timesheet': TIMESHEET,
  'Program_1.blackout': BLACKOUT,
  'Program_2.blackout': BLACKOUT,
  'dbo.timesheet': TFILES,
  'dbo.odd.name': TFILES,
  'dbo.tfiles': TFILES,
  'dbo.tglobals': TFILES,
  'dbo.tunknown': TFILES,
};

const PROGRAM: CanonicalColumn = { name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' };

const FOLDED_TIMESHEET: readonly CanonicalColumn[] = [
  { name: 'timesheet_id', type: 'i' },
  { name: 'person_id', type: 's' },
  { name: 'hours', type: 'd', scale: 2 },
  { name: 'note', type: 's' },
  PROGRAM,
];

const sheet = (timesheetId: number, personId: string, hours = '7.50', note: string | null = null): Row => ({
  timesheet_id: timesheetId,
  person_id: personId,
  hours,
  note,
});

const blackout = (personId: string, reason: string): Row => ({ person_id: personId, reason });

/** Timesheet 3 has identical content in both programs; blackout P-001/leave likewise, and twice in program 1. */
const SCRIPTS: Readonly<Record<string, StreamScript>> = {
  'Program_1.timesheet': { rows: [sheet(1, 'P-001'), sheet(3, 'P-003', '8.00', 'same'), sheet(4, 'P-004')] },
  'Program_2.timesheet': { rows: [sheet(2, 'P-002'), sheet(3, 'P-003', '8.00', 'same')] },
  'Program_1.blackout': { rows: [blackout('P-002', 'leave'), blackout('P-001', 'leave'), blackout('P-001', 'leave')] },
  'Program_2.blackout': { rows: [blackout('P-001', 'leave'), blackout('P-003', 'audit')] },
  'dbo.tfiles': { rows: [{ fileID: 'F-2', siteID: 'tenant-a', hits: 1 }, { fileID: 'F-1', siteID: 'tenant-b', hits: 2 }] },
};

function ref(schema: string, table: string, qualified = `${schema}.${table}`): LegacyTableRef {
  return { schema, table, qualified };
}

function part(programId: number, table: string): FoldPart {
  return { programId, ref: ref(`Program_${String(programId)}`, table) };
}

function deps(fake: ReturnType<typeof fakeLegacy>, catalog: UnitCatalog = fakeCatalog().catalog): LegacyTableDeps {
  return { legacy: fake.legacy, catalog };
}

async function collect(rows: AsyncIterable<CanonicalRow>): Promise<CanonicalRow[]> {
  const out: CanonicalRow[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

beforeEach(() => {
  clearCatalogCache();
});

describe('streamFoldedRows', () => {
  it('merges keyed Program_<n> parts in compareCanonicalRows order with legacy_program_id in row, encoding and key', async () => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const out = await collect(streamFoldedRows({ legacy: fake.legacy, table: 'Program_N.timesheet', parts: [part(2, 'timesheet'), part(1, 'timesheet')] }));

    expect(out.map((row) => [row.row.timesheet_id, row.legacyProgramId])).toEqual([
      ['1', 1],
      ['2', 2],
      ['3', 1],
      ['3', 2],
      ['4', 1],
    ]);
    out.slice(1).forEach((row, index) => expect(compareCanonicalRows(out[index] as CanonicalRow, row)).toBeLessThan(0));
    for (const row of out) {
      expect(row.table).toBe('Program_N.timesheet');
      expect(row.row[LEGACY_PROGRAM_ID_COLUMN]).toBe(String(row.legacyProgramId));
      expect(row.keyValues).toEqual([Number(row.row.timesheet_id), row.legacyProgramId]);
      expect(row.encoding).toBe(encodeRow(FOLDED_TIMESHEET, row.row));
      expect(row.key).toBe(encodeKey(FOLDED_TIMESHEET, ['timesheet_id', LEGACY_PROGRAM_ID_COLUMN], row.row));
    }
    expect(fake.streams.map((stream) => stream.sql)).toEqual(
      [1, 2].map(
        (id) => `SELECT [timesheet_id], [person_id], CONVERT(varchar(64), [hours]) AS [hours], [note] FROM [Program_${String(id)}].[timesheet] ORDER BY [timesheet_id] ASC`,
      ),
    );
  });

  it('yields identical content of two programs as two distinct rows', async () => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const out = await collect(streamFoldedRows({ legacy: fake.legacy, table: 'Program_N.timesheet', parts: [part(1, 'timesheet'), part(2, 'timesheet')] }));
    const [first, second] = out.filter((row) => row.row.timesheet_id === '3');

    expect(first?.row).toEqual({ timesheet_id: '3', person_id: 'P-003', hours: '8.00', note: 'same', [LEGACY_PROGRAM_ID_COLUMN]: '1' });
    expect(second?.row).toEqual({ ...first?.row, [LEGACY_PROGRAM_ID_COLUMN]: '2' });
    expect(first?.key).not.toBe(second?.key);
    expect(first?.encoding).not.toBe(second?.encoding);
  });

  it('merges keyless parts by folded encoding, keeping each program duplicate as its own row', async () => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const out = await collect(streamFoldedRows({ legacy: fake.legacy, table: 'Program_N.blackout', parts: [part(1, 'blackout'), part(2, 'blackout')] }));
    const columns: CanonicalColumn[] = [{ name: 'person_id', type: 's' }, { name: 'reason', type: 's' }, PROGRAM];

    expect(out.map((row) => row.encoding)).toEqual(out.map((row) => row.encoding).sort(compareEncodings));
    expect(out.map((row) => [row.row.person_id, row.legacyProgramId])).toEqual([
      ['P-001', 1],
      ['P-001', 1],
      ['P-001', 2],
      ['P-002', 1],
      ['P-003', 2],
    ]);
    for (const row of out) {
      expect(row).toMatchObject({ table: 'Program_N.blackout', key: row.encoding, keyValues: [] });
      expect(row.encoding).toBe(encodeRow(columns, row.row));
    }
    expect(out[0]?.encoding).toBe(out[1]?.encoding);
    expect(out[1]?.encoding).not.toBe(out[2]?.encoding);
  });

  it('strips legacy_program_id from requested columns and key columns before they reach the parts', async () => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const out = await collect(
      streamFoldedRows({
        legacy: fake.legacy,
        table: 'Program_N.timesheet',
        parts: [part(1, 'timesheet'), part(2, 'timesheet')],
        columns: ['hours', 'LEGACY_PROGRAM_ID'],
        keyColumns: ['timesheet_id', LEGACY_PROGRAM_ID_COLUMN],
      }),
    );
    const columns: CanonicalColumn[] = [{ name: 'hours', type: 'd', scale: 2 }, PROGRAM];

    expect(fake.streams[0]?.sql).toBe('SELECT [timesheet_id], CONVERT(varchar(64), [hours]) AS [hours] FROM [Program_1].[timesheet] ORDER BY [timesheet_id] ASC');
    expect(out).toHaveLength(5);
    expect(out[0]?.row).toEqual({ timesheet_id: '1', hours: '7.50', [LEGACY_PROGRAM_ID_COLUMN]: '1' });
    for (const row of out) expect(row.encoding).toBe(encodeRow(columns, row.row));
  });

  const reshaped = (change: (columns: ColumnSpec[]) => ColumnSpec[], primaryKey: readonly string[] | null = ['timesheet_id']): TableSpec => ({
    columns: change([...TIMESHEET.columns]),
    ...(primaryKey === null ? {} : { primaryKey }),
  });
  const mismatch = 'Program_2.timesheet does not have the columns, types and key of Program_1.timesheet';
  const twoParts = [part(1, 'timesheet'), part(2, 'timesheet')];

  it.each<[string, TableSpec, readonly FoldPart[], string]>([
    ['a part with a column of another type', reshaped((c) => c.map((col) => (col.name === 'hours' ? { name: 'hours', type: 'int' } : col))), twoParts, mismatch],
    ['a part with a decimal of another scale', reshaped((c) => c.map((col) => (col.name === 'hours' ? { ...col, scale: 3 } : col))), twoParts, mismatch],
    ['a part with a renamed column', reshaped((c) => c.map((col) => (col.name === 'note' ? { ...col, name: 'comment' } : col))), twoParts, mismatch],
    ['a part with its columns in another order', reshaped((c) => c.reverse()), twoParts, mismatch],
    ['a part with another primary key', reshaped((c) => c, ['person_id']), twoParts, mismatch],
    ['a part without a primary key', reshaped((c) => c, null), twoParts, mismatch],
    ['a part with its own legacy_program_id column', reshaped((c) => [...c, { name: 'Legacy_Program_ID', type: 'int' }]), twoParts, 'Program_2.timesheet already has a legacy_program_id column'],
    ['a fold without parts', TIMESHEET, [], 'a folded table needs at least one Program_<id> part'],
  ])('raises FoldShapeError before reading rows for %s', async (_label, programTwo, parts, message) => {
    const fake = fakeLegacy({ ...LIVE, 'Program_2.timesheet': programTwo }, SCRIPTS);
    const failure = await collect(streamFoldedRows({ legacy: fake.legacy, table: 'Program_N.timesheet', parts })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FoldShapeError);
    expect(failure).toMatchObject({ name: 'FoldShapeError', table: 'Program_N.timesheet', message: `Program_N.timesheet: ${message}` });
    expect(fake.streams).toHaveLength(0);
  });

  it('surfaces a part driver error at the pull that meets it and cancels the other parts', async () => {
    const cause = Object.assign(new Error('Connection lost - read ECONNRESET'), { code: 'ESOCKET' });
    const many = Array.from({ length: 200 }, (_, index) => sheet(index * 2 + 1, 'P-001'));
    const fake = fakeLegacy(LIVE, {
      'Program_1.timesheet': { rows: many },
      'Program_2.timesheet': { rows: [sheet(2, 'P-002'), sheet(6, 'P-006')], failAt: 1, error: cause },
    });
    const seen: unknown[] = [];
    const failure = await (async () => {
      for await (const row of streamFoldedRows({ legacy: fake.legacy, table: 'Program_N.timesheet', parts: twoParts })) seen.push(row.row.timesheet_id);
    })().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtractError);
    expect(failure).toMatchObject({ database: 'muradb_test', table: 'Program_N.timesheet', cause });
    expect(seen).toEqual(['1', '2']);
    expect(fake.streamOf('[Program_1].[timesheet]')?.cancels).toBe(1);
  });

  it('cancels every part when the consumer breaks early', async () => {
    const rows = (offset: number) => Array.from({ length: 50 }, (_, index) => sheet(index * 2 + offset, 'P-001'));
    const fake = fakeLegacy(LIVE, { 'Program_1.timesheet': { rows: rows(1) }, 'Program_2.timesheet': { rows: rows(2) } });
    for await (const row of streamFoldedRows({ legacy: fake.legacy, table: 'Program_N.timesheet', parts: twoParts })) if (row) break;

    expect(fake.streams.map((stream) => stream.cancels)).toEqual([1, 1]);
  });

  it('surfaces a part close failure after an early break, but never over the consumer error', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => sheet(index + 1, 'P-001'));
    const broken: Record<string, StreamScript> = {
      'Program_1.timesheet': { rows, cancelError: new Error('connection reset') },
      'Program_2.timesheet': { rows, cancelError: new Error('connection reset') },
    };
    const breaking = (async () => {
      for await (const row of streamFoldedRows({ legacy: fakeLegacy(LIVE, broken).legacy, table: 'Program_N.timesheet', parts: twoParts })) if (row) break;
    })();
    await expect(breaking).rejects.toMatchObject({ name: 'ExtractError', table: 'Program_N.timesheet', cause: new Error('connection reset') });

    clearCatalogCache();
    const throwing = (async () => {
      for await (const row of streamFoldedRows({ legacy: fakeLegacy(LIVE, broken).legacy, table: 'Program_N.timesheet', parts: twoParts })) {
        if (row) throw new Error('consumer');
      }
    })();
    await expect(throwing).rejects.toThrow('consumer');
  });
});

describe('describeLegacyTable', () => {
  const timesheetParts = [part(1, 'timesheet'), part(2, 'timesheet')];

  it.each<[string, LegacyTableShape]>([
    [
      'Program_N.timesheet',
      { table: 'Program_N.timesheet', folded: true, keyed: true, keyColumns: ['timesheet_id', LEGACY_PROGRAM_ID_COLUMN], columns: FOLDED_TIMESHEET, parts: timesheetParts },
    ],
    [
      'Program_N.blackout',
      {
        table: 'Program_N.blackout',
        folded: true,
        keyed: false,
        keyColumns: [],
        columns: [{ name: 'person_id', type: 's' }, { name: 'reason', type: 's' }, PROGRAM],
        parts: [part(1, 'blackout'), part(2, 'blackout')],
      },
    ],
    [
      'tfiles',
      {
        table: 'tfiles',
        folded: false,
        keyed: true,
        keyColumns: ['siteID', 'fileID'],
        columns: [{ name: 'fileID', type: 's' }, { name: 'siteID', type: 's' }, { name: 'hits', type: 'i' }],
        parts: [],
      },
    ],
  ])('describes %s as a frozen shape of plain {name, type, scale?} columns', async (table, expected) => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const shape = await describeLegacyTable(deps(fake), { table });

    expect(shape).toStrictEqual(expected);
    expect(Object.isFrozen(shape)).toBe(true);
    expect(Object.isFrozen(shape.columns)).toBe(true);
    expect(Object.isFrozen(shape.keyColumns)).toBe(true);
    expect(Object.isFrozen(shape.parts)).toBe(true);
    expect(shape.columns.every((column) => Object.isFrozen(column))).toBe(true);
    expect(fake.streams).toHaveLength(0);
  });

  it.each<[string, string, boolean, readonly number[]]>([
    ['Program_N.timesheet', 'Program_N.timesheet', true, [1, 2]],
    ['program_n.TIMESHEET', 'Program_N.timesheet', true, [1, 2]],
    ['[Program_N].[timesheet]', 'Program_N.timesheet', true, [1, 2]],
    ['Program_2.timesheet', 'Program_N.timesheet', true, [2]],
    ['[Program_1].[timesheet]', 'Program_N.timesheet', true, [1]],
    ['timesheet', 'timesheet', false, []],
    ['dbo.[odd.name]', 'odd.name', false, []],
    ['tfiles', 'tfiles', false, []],
  ])('resolves %s to table %s (folded: %s) with program parts %j', async (name, table, folded, programIds) => {
    const shape = await describeLegacyTable(deps(fakeLegacy(LIVE, SCRIPTS)), { table: name });

    expect(shape).toMatchObject({ table, folded });
    expect(shape.parts.map((found) => found.programId)).toEqual(programIds);
    expect(shape.columns.at(-1)?.name === LEGACY_PROGRAM_ID_COLUMN).toBe(folded);
  });

  it.each<[string, string | undefined, string]>([
    ['the live database', undefined, '(live)'],
    ['a named snapshot', 'muradb_opt2_snap_2', 'muradb_opt2_snap_2'],
  ])('raises TableNotFoundError naming %s for a fold target with no live parts', async (_label, database, named) => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const options: LegacyTableOptions = database === undefined ? { table: 'Program_N.approval_action' } : { table: 'Program_N.approval_action', database };
    const failure = await describeLegacyTable(deps(fake), options).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TableNotFoundError);
    expect(failure).toMatchObject({ database: named, table: 'Program_N.approval_action', message: `table Program_N.approval_action not found in database ${named}` });
    expect(fake.opened).toEqual([named]);
    expect(fake.listed).toHaveLength(1);
  });

  it.each<[string, LegacyTableOptions, readonly string[], readonly string[]]>([
    ['the ownership key by default', { table: 'tfiles' }, ['siteID', 'fileID'], ['tfiles']],
    ['the requested key over the ownership key', { table: 'tfiles', keyColumns: ['hits'] }, ['hits'], []],
    ['the live primary key for a table the ownership file does not know', { table: 'tunknown' }, ['fileID'], ['tunknown']],
    ['the live primary key for a table the ownership file does not migrate', { table: 'tglobals' }, ['fileID'], ['tglobals']],
    ['the ownership key of a program table plus legacy_program_id', { table: 'Program_1.timesheet' }, ['timesheet_id', LEGACY_PROGRAM_ID_COLUMN], ['Program_1.timesheet']],
  ])('keys a table by %s', async (_label, options, keyColumns, lookups) => {
    const { catalog, keyLookups } = fakeCatalog();
    const shape = await describeLegacyTable(deps(fakeLegacy(LIVE, SCRIPTS), catalog), options);

    expect(shape.keyColumns).toEqual(keyColumns);
    expect(keyLookups).toEqual(lookups);
  });

  it('propagates an ownership lookup failure other than an unknown or unmigrated table', async () => {
    const failure = new TypeError('ownership index is corrupt');
    const { catalog } = fakeCatalog({ tfiles: failure });

    await expect(describeLegacyTable(deps(fakeLegacy(LIVE, SCRIPTS), catalog), { table: 'tfiles' })).rejects.toBe(failure);
  });
});

describe('streamLegacyTable', () => {
  const migratable = (name: string, physical: MigratableTable['physical'], folded: boolean, keyColumns: readonly string[]): MigratableTable => ({
    name,
    owner: 'timesheets',
    owners: ['timesheets'],
    physical,
    folded,
    keyColumns,
  });

  it('streams a folded migratable table through its own parts and key without listing tables or reading ownership', async () => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const { catalog, keyLookups } = fakeCatalog();
    const table = migratable('Program_N.timesheet', [part(1, 'timesheet'), part(2, 'timesheet')], true, ['timesheet_id']);
    const out = await collect(streamLegacyTable(deps(fake, catalog), { table }));

    expect(out.map((row) => [row.row.timesheet_id, row.legacyProgramId])).toEqual([
      ['1', 1],
      ['2', 2],
      ['3', 1],
      ['3', 2],
      ['4', 1],
    ]);
    expect(fake.listed).toHaveLength(0);
    expect(keyLookups).toEqual([]);
  });

  it('streams a plain migratable table under its ownership name with its own key', async () => {
    const fake = fakeLegacy(LIVE, SCRIPTS);
    const table = migratable('tfiles', [{ ref: ref('dbo', 'tfiles', 'tfiles') }], false, ['siteID', 'fileID']);
    const out = await collect(streamLegacyTable(deps(fake), { table }));

    expect(fake.streams[0]?.sql).toContain(' FROM [dbo].[tfiles] ORDER BY [siteID] COLLATE Latin1_General_BIN2 ASC, [fileID] COLLATE Latin1_General_BIN2 ASC');
    expect(out.map((row) => [row.table, row.row.fileID, 'legacyProgramId' in row])).toEqual([
      ['tfiles', 'F-2', false],
      ['tfiles', 'F-1', false],
    ]);
  });

  it('raises FoldShapeError for a folded migratable table with a part outside the Program_<id> schemas', async () => {
    const table = migratable('Program_N.timesheet', [{ ref: ref('dbo', 'timesheet', 'timesheet') }, part(1, 'timesheet')], true, ['timesheet_id']);
    const failure = await collect(streamLegacyTable(deps(fakeLegacy(LIVE, SCRIPTS)), { table })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FoldShapeError);
    expect(failure).toMatchObject({ table: 'Program_N.timesheet', message: 'Program_N.timesheet: timesheet is not a Program_<id> table' });
  });

  it('streams a logical folded name from every live program and a plain name as one table', async () => {
    const folded = await collect(streamLegacyTable(deps(fakeLegacy(LIVE, SCRIPTS)), { table: 'Program_N.blackout' }));
    const plain = await collect(streamLegacyTable(deps(fakeLegacy(LIVE, SCRIPTS)), { table: 'tfiles' }));

    expect(folded.map((row) => row.legacyProgramId)).toEqual([1, 1, 2, 1, 2]);
    expect(folded.every((row) => row.table === 'Program_N.blackout')).toBe(true);
    expect(plain.map((row) => [row.row.siteID, row.row.fileID])).toEqual([
      ['tenant-a', 'F-2'],
      ['tenant-b', 'F-1'],
    ]);
    expect(plain.every((row) => row.legacyProgramId === undefined && row.row[LEGACY_PROGRAM_ID_COLUMN] === undefined)).toBe(true);
  });
});
