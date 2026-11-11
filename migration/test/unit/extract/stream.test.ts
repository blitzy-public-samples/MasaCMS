// Unit tests for the row extractor, using a fake pool whose stream requests emit scripted rows with pause, resume and cancel.
import { EventEmitter } from 'node:events';
import { mkdtemp, open, readdir, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ConnectionPool } from 'mssql';
import { compareEncodings, decodeRow, encodeKey, encodeRow } from '@opt2/platform/migration-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TableNotFoundError, clearCatalogCache } from '../../../src/extract/catalog.js';
import {
  DEFAULT_HIGH_WATER_MARK,
  DEFAULT_SORT_RUN_BYTES,
  ExtractError,
  ExtractOrderError,
  RunReader,
  compareCanonicalRows,
  compareKeyValues,
  describeStream,
  streamCanonicalRows,
  writeRecords,
  type CanonicalRow,
  type KeyValue,
  type StreamOptions,
} from '../../../src/extract/stream.js';

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

/** Rows a stream request emits; `burst` rows go out per tick regardless of pause, as a TDS packet does. */
interface StreamScript {
  rows: readonly Row[];
  burst?: number;
  failAt?: number;
  error?: unknown;
  cancelError?: unknown;
  rejectWith?: Error;
}

const CANCELED = Object.assign(new Error('Canceled.'), { code: 'ECANCEL' });

class FakeStreamRequest extends EventEmitter {
  stream = false;
  sql = '';
  readonly inputs: Record<string, { type: unknown; value: unknown }> = {};
  pauses = 0;
  resumes = 0;
  cancels = 0;
  private paused = false;
  private index = 0;
  private ended = false;
  private settle: (() => void) | undefined;

  constructor(private readonly script: StreamScript) {
    super();
  }

  input(name: string, type: unknown, value: unknown): this {
    this.inputs[name] = { type, value };
    return this;
  }

  query(text: string): Promise<unknown> {
    this.sql = text;
    if (this.script.rejectWith !== undefined) return Promise.reject(this.script.rejectWith);
    return new Promise((resolve) => {
      this.settle = () => resolve({});
      setImmediate(() => this.pump());
    });
  }

  pause(): boolean {
    this.pauses += 1;
    this.paused = true;
    return true;
  }

  resume(): boolean {
    this.resumes += 1;
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
    const { rows, burst = 1, failAt } = this.script;
    for (let sent = 0; sent < burst && this.index < rows.length && this.index !== failAt; sent++) {
      this.emit('row', rows[this.index++]);
    }
    if (this.index === failAt) this.end(this.script.error);
    else if (this.index >= rows.length) this.end();
    else setImmediate(() => this.pump());
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
    NUMERIC_PRECISION: column.scale === undefined ? null : 19,
    NUMERIC_SCALE: column.scale ?? null,
    ORDINAL_POSITION: index + 1,
  }));
  return [columns, (spec.primaryKey ?? []).map((name) => ({ name })), []];
}

/** Fake LegacyDb: catalog queries answer from `tables`, every other query is a stream request answering from `script`. */
function fakeLegacy(tables: Record<string, TableSpec>, script: StreamScript, database = 'muradb_test') {
  const streams: FakeStreamRequest[] = [];
  const opened: string[] = [];
  const pool = {
    config: { database },
    request() {
      const request = new FakeStreamRequest(script);
      const query = request.query.bind(request);
      request.query = (text: string) => {
        if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
          const key = `${String(request.inputs.schema?.value)}.${String(request.inputs.table?.value)}`.toLowerCase();
          const sets = catalogSets(tables[key]);
          return Promise.resolve({ recordsets: sets, recordset: sets[0] });
        }
        if (text.includes('DATABASEPROPERTYEX')) return Promise.resolve({ recordset: [{ updateability: 'READ_ONLY' }] });
        streams.push(request);
        return query(text);
      };
      return request;
    },
  } as unknown as ConnectionPool;
  const legacy: StreamOptions['legacy'] = {
    live: () => {
      opened.push('live');
      return Promise.resolve(pool);
    },
    database: (name: string) => {
      opened.push(name);
      return Promise.resolve(pool);
    },
  };
  return { legacy, streams, opened };
}

async function collect(rows: AsyncIterable<CanonicalRow>): Promise<CanonicalRow[]> {
  const out: CanonicalRow[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

const ID_A = 'A0000000-0000-0000-0000000000000001';
const ID_B = 'B0000000-0000-0000-0000000000000002';
const ID_C = 'c0000000-0000-0000-0000000000000003';

/** A Masa-like keyed table covering every transported type, columns deliberately not in alphabetical order. */
const TFILES: TableSpec = {
  columns: [
    { name: 'fileID', type: 'char', maxLength: 35 },
    { name: 'siteID', type: 'nvarchar', maxLength: 25 },
    { name: 'remoteID', type: 'bigint' },
    { name: 'isActive', type: 'bit' },
    { name: 'amount', type: 'decimal', scale: 4 },
    { name: 'price', type: 'money', scale: 4 },
    { name: 'body', type: 'ntext' },
    { name: 'notes', type: 'text' },
    { name: 'image', type: 'image' },
    { name: 'created', type: 'datetime' },
    { name: 'hits', type: 'int' },
    { name: 'guid', type: 'uniqueidentifier' },
  ],
  primaryKey: ['fileID'],
};

function fileRow(fileID: string, overrides: Row = {}): Row {
  return {
    fileID,
    siteID: 'tenant-a',
    remoteID: '9007199254740993',
    isActive: true,
    amount: '12.3400',
    price: '-5.0000',
    body: 'line one\nline two',
    notes: '',
    image: Buffer.from([0, 1, 254]),
    created: new Date(2026, 5, 30, 13, 45, 7, 123),
    hits: 7,
    guid: '6F0A2C1E-5B7D-4E8A-9C3F-0D1E2F3A4B5C',
    ...overrides,
  };
}

/** A keyless table, as `tsettings` is [core/setup/db/mssql.sql:370]. */
const TSETTINGS: TableSpec = {
  columns: [
    { name: 'SiteID', type: 'nvarchar', maxLength: 25 },
    { name: 'Theme', type: 'nvarchar', maxLength: 50 },
    { name: 'isOn', type: 'bit' },
  ],
};

function settingsRows(count: number): Row[] {
  // Descending, duplicated and multi-line values, so the output order differs from the arrival order.
  return Array.from({ length: count }, (_, index) => ({
    SiteID: `site-${String((count - index) % 7)}`,
    Theme: index % 3 === 0 ? null : `theme\n${String(index % 4)}`,
    isOn: index % 2 === 0,
  }));
}

let spillParent: string;

beforeEach(async () => {
  clearCatalogCache();
  spillParent = await mkdtemp(join(tmpdir(), 'stream-test-'));
});

afterEach(async () => {
  await rm(spillParent, { recursive: true, force: true });
});

describe('describeStream', () => {
  it('selects every column in ordinal order with transport casts and a binary-collated key order', async () => {
    const { legacy, opened } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [] });
    const shape = await describeStream({ legacy, table: 'tfiles' });

    expect(opened).toEqual(['live']);
    expect(shape).toMatchObject({ database: 'muradb_test', table: 'tfiles', keyed: true, keyColumns: ['fileID'] });
    expect(shape.columns.map((column) => column.name)).toEqual(TFILES.columns.map((column) => column.name));
    expect(shape.selectSql).toBe(
      'SELECT [fileID], [siteID], [remoteID], [isActive], CONVERT(varchar(64), [amount]) AS [amount], ' +
        'CONVERT(varchar(64), [price], 2) AS [price], CAST([body] AS nvarchar(max)) AS [body], ' +
        'CAST([notes] AS nvarchar(max)) AS [notes], CAST([image] AS varbinary(max)) AS [image], [created], [hits], [guid] ' +
        'FROM [dbo].[tfiles] ORDER BY [fileID] COLLATE Latin1_General_BIN2 ASC',
    );
    expect(shape.selectSql).not.toMatch(/CONCAT|\]\s*\+/i);
    expect(shape.scope.kind).toBe('table');
  });

  it('orders composite keys by explicit expressions per type and reads a named database', async () => {
    const spec: TableSpec = { ...TFILES, primaryKey: ['guid', 'amount', 'price', 'hits', 'siteID'] };
    const { legacy, opened } = fakeLegacy({ 'dbo.tfiles': spec }, { rows: [] });
    const shape = await describeStream({ legacy, database: 'muradb_opt2_snap_3', table: 'tfiles', label: 'files' });

    expect(opened).toEqual(['muradb_opt2_snap_3']);
    expect(shape.table).toBe('files');
    expect(shape.selectSql).toContain(
      ' ORDER BY CONVERT(char(36), [guid]) COLLATE Latin1_General_BIN2 ASC, ' +
        'CONVERT(varchar(64), [amount]) COLLATE Latin1_General_BIN2 ASC, ' +
        'CONVERT(varchar(64), [price], 2) COLLATE Latin1_General_BIN2 ASC, [hits] ASC, [siteID] COLLATE Latin1_General_BIN2 ASC',
    );
  });

  it('selects requested columns plus key columns, resolving names case-insensitively, and binds scope parameters', async () => {
    const { legacy } = fakeLegacy({ 'program_1.timesheet': TFILES }, { rows: [] });
    const shape = await describeStream({
      legacy,
      table: { schema: 'Program_1', table: 'timesheet', qualified: 'Program_1.timesheet' },
      columns: ['HITS', 'siteid'],
      keyColumns: ['FILEID'],
      scope: { siteid: ['tenant-a', 'tenant-b'] },
    });

    expect(shape.keyColumns).toEqual(['fileID']);
    expect(shape.columns.map((column) => column.name)).toEqual(['siteID', 'hits']);
    expect(shape.selectSql).toBe(
      'SELECT [fileID], [siteID], [hits] FROM [Program_1].[timesheet] WHERE ([siteID] IN (@p0, @p1)) ' +
        'ORDER BY [fileID] COLLATE Latin1_General_BIN2 ASC',
    );
  });

  it('ignores key columns for a keyless table and orders nothing', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tsettings': TSETTINGS }, { rows: [] });
    const shape = await describeStream({ legacy, table: 'tsettings', keyColumns: ['SiteID'], columns: [] });

    expect(shape).toMatchObject({ keyed: false, keyColumns: [] });
    expect(shape.selectSql).toBe('SELECT [SiteID], [Theme], [isOn] FROM [dbo].[tsettings]');
  });

  it.each([
    ['key', { keyColumns: ['nope'] }],
    ['requested', { columns: ['siteID', 'nope'] }],
  ])('rejects an unknown %s column', async (role, extra) => {
    const { legacy } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [] });
    const failure = describeStream({ legacy, table: 'tfiles', ...extra });

    await expect(failure).rejects.toBeInstanceOf(ExtractError);
    await expect(failure).rejects.toThrow(`${role} column nope is not a column of tfiles`);
  });

  it('wraps a pool failure and lets catalog errors through', async () => {
    const down: StreamOptions['legacy'] = {
      live: () => Promise.reject(new Error('ECONNREFUSED')),
      database: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const failure = await describeStream({ legacy: down, table: 'tfiles' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtractError);
    expect(failure).toMatchObject({ database: '(live)', table: 'tfiles', cause: new Error('ECONNREFUSED') });

    const { legacy } = fakeLegacy({}, { rows: [] });
    await expect(describeStream({ legacy, table: 'tmissing' })).rejects.toBeInstanceOf(TableNotFoundError);
  });
});

describe('streamCanonicalRows on keyed tables', () => {
  it('yields canonical rows in SQL order whose encoding and key are the migration-kit encodings', async () => {
    const rows = [fileRow(ID_A), fileRow(ID_B, { notes: null, isActive: false, remoteID: '-1' }), fileRow(ID_C)];
    const { legacy, streams } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows });
    const shape = await describeStream({ legacy, table: 'tfiles' });
    const out = await collect(streamCanonicalRows({ legacy, table: 'tfiles' }));

    expect(streams).toHaveLength(1);
    expect(streams[0]?.stream).toBe(true);
    expect(streams[0]?.sql).toBe(shape.selectSql);
    expect(out.map((row) => row.row.fileID)).toEqual([ID_A, ID_B, ID_C]);
    for (const row of out) {
      expect(row.table).toBe('tfiles');
      expect(encodeRow(shape.columns, row.row)).toBe(row.encoding);
      expect(row.key).toBe(encodeKey(shape.columns, ['fileID'], row.row));
      expect(decodeRow(shape.columns, row.encoding)).toEqual(row.row);
    }
    expect(out[0]?.row).toMatchObject({
      remoteID: '9007199254740993',
      isActive: '1',
      amount: '12.3400',
      price: '-5.0000',
      notes: '',
      created: '2026-06-30T13:45:07.123',
      image: Buffer.from([0, 1, 254]),
    });
    expect(out[0]?.encoding).toContain('s0:');
    expect(out[1]?.encoding).toContain('N');
    expect(out[1]?.row.notes).toBeNull();
    expect(out[0]?.keyValues).toEqual([ID_A]);
  });

  it('keeps char padding and types key values for ordering', async () => {
    const padded = 'site-1   ';
    const spec: TableSpec = { ...TFILES, primaryKey: ['remoteID', 'isActive', 'siteID'] };
    const { legacy } = fakeLegacy({ 'dbo.tfiles': spec }, { rows: [fileRow(ID_A, { siteID: padded })] });
    const [row] = await collect(streamCanonicalRows({ legacy, table: 'tfiles' }));

    expect(row?.keyValues).toEqual([9007199254740993n, 1, padded]);
    expect(row?.row.siteID).toBe(padded);
    expect(row?.encoding).toContain(`s9:${padded}`);
  });

  it('encodes only the requested columns while still keying and returning the key column', async () => {
    const { legacy } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [fileRow(ID_A), fileRow(ID_B)] });
    const out = await collect(streamCanonicalRows({ legacy, table: 'tfiles', columns: ['hits', 'siteID'] }));
    const columns = [
      { name: 'siteID', type: 's' as const },
      { name: 'hits', type: 'i' as const },
    ];

    expect(out[0]?.row).toEqual({ fileID: ID_A, siteID: 'tenant-a', hits: '7' });
    expect(out[0]?.encoding).toBe(encodeRow(columns, out[0]?.row ?? {}));
    expect(out[0]?.key).toBe(`s35:${ID_A}`);
  });

  it('binds scope values as @pN parameters only', async () => {
    const { legacy, streams } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [] });
    await collect(streamCanonicalRows({ legacy, table: 'tfiles', scope: { siteid: ['tenant-a'], fileid: [ID_A] } }));

    expect(streams[0]?.sql).toContain(' WHERE ([siteID] IN (@p0)) OR ([fileID] IN (@p1)) ORDER BY');
    expect(Object.keys(streams[0]?.inputs ?? {})).toEqual(['p0', 'p1']);
    expect(streams[0]?.inputs.p1?.value).toBe(ID_A);
  });

  it('raises ExtractOrderError when the stream contradicts the comparator, and accepts equal keys', async () => {
    const equal = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [fileRow(ID_A), fileRow(ID_A, { hits: 8 })] });
    expect(await collect(streamCanonicalRows({ legacy: equal.legacy, table: 'tfiles' }))).toHaveLength(2);

    clearCatalogCache();
    const { legacy, streams } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [fileRow(ID_B), fileRow(ID_A), fileRow(ID_C)] });
    const failure = await collect(streamCanonicalRows({ legacy, table: 'tfiles' })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtractOrderError);
    expect(failure).toMatchObject({ database: 'muradb_test', table: 'tfiles', previous: `s35:${ID_B}`, current: `s35:${ID_A}` });
    expect(streams[0]?.cancels).toBe(1);
  });

  it('pauses for a slow consumer and resumes once it drains', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => fileRow(`ID${String(index).padStart(33, '0')}`));
    const { legacy, streams } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows, burst: 3 });
    let count = 0;
    for await (const row of streamCanonicalRows({ legacy, table: 'tfiles', highWaterMark: 4 })) {
      expect(row.row.fileID).toBe(rows[count]?.fileID);
      count += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(count).toBe(40);
    expect(streams[0]?.pauses).toBeGreaterThan(0);
    expect(streams[0]?.resumes).toBeGreaterThan(0);
    expect(streams[0]?.cancels).toBe(0);
  });

  it('keeps order across a large buffered burst', async () => {
    const rows = Array.from({ length: 6000 }, (_, index) => fileRow(`ID${String(index).padStart(33, '0')}`));
    const { legacy } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows, burst: 6000 });
    const out = await collect(streamCanonicalRows({ legacy, table: 'tfiles', highWaterMark: 10_000 }));

    expect(out.map((row) => row.row.fileID)).toEqual(rows.map((row) => row.fileID));
  });

  it('cancels the request when the consumer breaks early and swallows the cancellation error', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => fileRow(`ID${String(index).padStart(33, '0')}`));
    const { legacy, streams } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows });
    let seen = 0;
    for await (const row of streamCanonicalRows({ legacy, table: 'tfiles' })) {
      seen += row.keyValues.length;
      if (seen === 2) break;
    }

    expect(streams[0]?.cancels).toBe(1);
  });

  it('surfaces a non-cancellation error after an early break, but never over the consumer error', async () => {
    const rows = [fileRow(ID_A), fileRow(ID_B), fileRow(ID_C)];
    const broken = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows, cancelError: new Error('connection reset') });
    const breaking = (async () => {
      for await (const row of streamCanonicalRows({ legacy: broken.legacy, table: 'tfiles' })) if (row) break;
    })();
    await expect(breaking).rejects.toBeInstanceOf(ExtractError);

    clearCatalogCache();
    const again = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows, cancelError: new Error('connection reset') });
    const throwing = (async () => {
      for await (const row of streamCanonicalRows({ legacy: again.legacy, table: 'tfiles' })) if (row) throw new Error('consumer');
    })();
    await expect(throwing).rejects.toThrow('consumer');
  });

  it('wraps a driver error in ExtractError at the next pull', async () => {
    const cause = Object.assign(new Error('Connection lost - read ECONNRESET'), { code: 'ESOCKET' });
    const { legacy, streams } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [fileRow(ID_A), fileRow(ID_B)], failAt: 1, error: cause });
    const seen: string[] = [];
    const failure = await (async () => {
      for await (const row of streamCanonicalRows({ legacy, table: 'tfiles' })) seen.push(row.key);
    })().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtractError);
    expect(failure).not.toBeInstanceOf(ExtractOrderError);
    expect(failure).toMatchObject({ database: 'muradb_test', table: 'tfiles', cause });
    expect(seen.length).toBeLessThanOrEqual(1);
    expect(streams[0]?.cancels).toBe(0);
  });

  it('wraps a rejected query in ExtractError', async () => {
    const cause = new Error('request rejected');
    const { legacy } = fakeLegacy({ 'dbo.tfiles': TFILES }, { rows: [], rejectWith: cause });

    await expect(collect(streamCanonicalRows({ legacy, table: 'tfiles' }))).rejects.toMatchObject({ name: 'ExtractError', cause });
  });
});

describe('streamCanonicalRows on keyless tables', () => {
  async function keyless(rows: readonly Row[], extra: Partial<StreamOptions> = {}) {
    const fake = fakeLegacy({ 'dbo.tsettings': TSETTINGS }, { rows, burst: 5 });
    const shape = await describeStream({ legacy: fake.legacy, table: 'tsettings' });
    const out = await collect(streamCanonicalRows({ legacy: fake.legacy, table: 'tsettings', spillDir: spillParent, ...extra }));
    return { ...fake, shape, out };
  }

  it.each([
    ['in memory', {}],
    ['through several spill runs', { sortRunBytes: 64 }],
  ])('yields rows sorted by encoding with every duplicate, %s', async (_label, extra) => {
    const source = settingsRows(60);
    const { shape, out, streams } = await keyless(source, extra);
    const expected = source.map((row) => encodeRow(shape.columns, { ...row, isOn: row.isOn === true ? 1 : 0 })).sort(compareEncodings);

    expect(out.map((row) => row.encoding)).toEqual(expected);
    for (const row of out) {
      expect(row).toMatchObject({ table: 'tsettings', key: row.encoding, keyValues: [] });
      expect(encodeRow(shape.columns, row.row)).toBe(row.encoding);
    }
    expect(out.some((row) => row.row.Theme === null)).toBe(true);
    expect(await readdir(spillParent)).toEqual([]);
    if ('sortRunBytes' in extra) expect(streams[0]?.pauses).toBeGreaterThan(0);
  });

  it('spills and merges multi-megabyte multi-byte values byte-exactly', async () => {
    const big = (fill: string, index: number) => ({ SiteID: `site-${String(index % 2)}`, Theme: fill.repeat(400_000 + index), isOn: false });
    const source = [big('é€', 4), big('ab', 3), big('é€', 2), big('zz', 1), big('ab', 0)];
    const { shape, out } = await keyless(source, { sortRunBytes: 4 * 1024 * 1024 });
    const expected = source.map((row) => encodeRow(shape.columns, { ...row, isOn: 0 })).sort(compareEncodings);

    expect(out.map((row) => row.encoding)).toEqual(expected);
    expect(await readdir(spillParent)).toEqual([]);
  });

  it('removes its spill directory when the consumer breaks during the merge', async () => {
    const fake = fakeLegacy({ 'dbo.tsettings': TSETTINGS }, { rows: settingsRows(30) });
    for await (const row of streamCanonicalRows({ legacy: fake.legacy, table: 'tsettings', spillDir: spillParent, sortRunBytes: 16 })) {
      if (row) break;
    }

    expect(await readdir(spillParent)).toEqual([]);
  });

  it('cancels the request and propagates the error when a spill cannot be written', async () => {
    const fake = fakeLegacy({ 'dbo.tsettings': TSETTINGS }, { rows: settingsRows(200) });
    const missing = join(spillParent, 'missing');
    const failure = collect(streamCanonicalRows({ legacy: fake.legacy, table: 'tsettings', spillDir: missing, sortRunBytes: 32 }));

    await expect(failure).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.streams[0]?.cancels).toBe(1);
    expect(await readdir(spillParent)).toEqual([]);
  });
});

describe('spill run records', () => {
  async function readAll(file: string): Promise<string[]> {
    const reader = new RunReader(file, await open(file, 'r'));
    const records: string[] = [];
    try {
      for (let record = await reader.next(); record !== undefined; record = await reader.next()) records.push(record);
    } finally {
      await reader.close();
    }
    return records;
  }

  it('writes records from an async iterable in order, which RunReader reads back byte-exactly', async () => {
    const records = ['', 'é€ multi-byte', 's1:a', 'x'.repeat(1024 * 1024 + 3)];
    const file = join(spillParent, 'run');
    await writeRecords(file, (async function* () {
      for (const record of records) {
        await delay(0);
        yield record;
      }
    })());

    expect(await readAll(file)).toEqual(records);
  });

  it.each([
    ['a record header', 2],
    ['a record', 6],
  ])('rejects a run that ends inside %s', async (label, bytes) => {
    const file = join(spillParent, 'run');
    await writeRecords(file, ['abcdef']);
    await truncate(file, bytes);

    await expect(readAll(file)).rejects.toThrow(`spill run ${file} ends inside ${label}`);
  });
});

describe('comparators', () => {
  const day = (d: number) => new Date(2026, 5, d);
  it.each<[string, readonly KeyValue[], readonly KeyValue[], number]>([
    ['null before a value', [null], ['a'], -1],
    ['equal nulls', [null], [null], 0],
    ['numbers numerically', [9], [10], -1],
    ['bigint against number', [10n], [9], 1],
    ['equal bigint and number', [7n], [7], 0],
    ['dates by time', [day(2)], [day(1)], 1],
    ['text by code unit', ['B'], ['a'], -1],
    ['trailing spaces ignored', ['abc  '], ['abc'], 0],
    ['leading spaces kept', [' abc'], ['abc'], -1],
    ['binary by byte', [Buffer.from([1, 2])], [Buffer.from([1, 3])], -1],
    ['later element decides', ['a', 2], ['a', 1], 1],
    ['shorter tuple first', ['a'], ['a', 1], -1],
    ['type rank for mixed values', ['1'], [1], 1],
    ['date before text', [day(1)], ['x'], -1],
    ['binary after text', [Buffer.from([0])], ['x'], 1],
  ])('compareKeyValues: %s', (_label, a, b, expected) => {
    expect(compareKeyValues(a, b)).toBe(expected);
    expect(compareKeyValues(b, a)).toBe(-expected || 0);
  });

  const keyed = (keyValues: readonly KeyValue[], legacyProgramId?: number): CanonicalRow => ({
    table: 't',
    key: '',
    keyValues,
    encoding: 'z',
    row: {},
    ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
  });
  const keylessRow = (encoding: string): CanonicalRow => ({ table: 't', key: encoding, keyValues: [], encoding, row: {} });

  it.each<[string, CanonicalRow, CanonicalRow, number]>([
    ['keys first', keyed(['a'], 2), keyed(['b'], 1), -1],
    ['program id breaks ties', keyed(['a'], 2), keyed(['a'], 1), 1],
    ['an absent program id first', keyed(['a']), keyed(['a'], 1), -1],
    ['a present program id after an absent one', keyed(['a'], 1), keyed(['a']), 1],
    ['equal keys and program ids', keyed(['a'], 1), keyed(['a'], 1), 0],
    ['keyless rows by encoding', keylessRow('s1:b'), keylessRow('s1:a'), 1],
  ])('compareCanonicalRows: %s', (_label, a, b, expected) => {
    expect(compareCanonicalRows(a, b)).toBe(expected);
  });

  it('exposes the documented defaults', () => {
    expect(DEFAULT_SORT_RUN_BYTES).toBe(64 * 1024 * 1024);
    expect(DEFAULT_HIGH_WATER_MARK).toBe(256);
  });
});
