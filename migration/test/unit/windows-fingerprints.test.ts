// Unit tests for window row fingerprints: the hash SELECT, the read over a scripted legacy pool, and the before/after diff.
import { setTimeout as delay } from 'node:timers/promises';

import type { ConnectionPool } from 'mssql';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { MAX_SCOPE_PARAMETERS, clearCatalogCache, type CatalogColumn, type TableCatalog } from '../../src/extract/index.js';
import { loadUnitCatalog } from '../../src/owners/index.js';
import { FILE_OBJECT_UNIT } from '../../src/reverse/files.js';
import {
  FINGERPRINT_CONCURRENCY,
  MAX_FINGERPRINT_ROWS,
  PARTITION_CELLS,
  diffFingerprints,
  fingerprintKey,
  fingerprintSql,
  fingerprintTables,
  partitionWhere,
  readFingerprints,
  sameScope,
  type TableFingerprint,
} from '../../src/windows/fingerprints.js';

type Row = Record<string, unknown>;

const column = (name: string, sqlType: string, maxLength: number | null = null): CatalogColumn => ({
  name,
  type: 's',
  sqlType,
  nullable: true,
  maxLength,
  precision: null,
  numericScale: null,
  ordinal: 0,
});

const tableOf = (columns: CatalogColumn[], primaryKey: string[] = []): Pick<TableCatalog, 'schema' | 'table' | 'columns' | 'primaryKey'> => ({
  schema: 'dbo',
  table: 'tsample',
  columns,
  primaryKey,
});

/** Worst-case varbinary bytes of `column` as the tests count them, length prefix included; undefined when hashed whole. */
function worstCase(spec: CatalogColumn): number | undefined {
  const sized: Record<string, number> = { char: 1, varchar: 1, binary: 1, varbinary: 1, nchar: 2, nvarchar: 2 };
  const unit = sized[spec.sqlType];
  if (unit === undefined) return ['text', 'ntext', 'xml', 'image'].includes(spec.sqlType) ? undefined : 24;
  return spec.maxLength === null || spec.maxLength < 0 ? undefined : 4 + spec.maxLength * unit;
}

const CHUNK = /HASHBYTES\('SHA2_256', ((?:ISNULL\(CAST\(DATALENGTH\(\[[^\]]+\]\) AS binary\(4\)\) \+ CAST\(\[[^\]]+\] AS varbinary\(8000\)\), 0xFFFFFFFF\)(?: \+ )?)+)\)/g;
const TERM_COLUMN = /DATALENGTH\(\[([^\]]+)\]\)/g;

describe('fingerprintSql', () => {
  it('hashes every column once in catalog order, in chunks whose worst case stays within 8,000 bytes', () => {
    const columns = [
      column('tcontent_ID', 'int'),
      column('ContentID', 'char', 35),
      ...Array.from({ length: 42 }, (_, index) => column(`Text${String(index)}`, 'nvarchar', 255)),
      column('Wide', 'varchar', 7996),
      column('Amount', 'decimal'),
      column('Body', 'nvarchar', -1),
      column('LastUpdate', 'datetime'),
    ];
    const text = fingerprintSql(tableOf(columns, ['tcontent_ID']), ' WHERE ([SiteID] IN (@p0))');

    const chunks = [...(text ?? '').matchAll(CHUNK)].map(([, body = '']) => [...body.matchAll(TERM_COLUMN)].map(([, name = '']) => name));
    expect(chunks.length).toBeGreaterThan(2);
    const byName = new Map(columns.map((spec) => [spec.name, spec]));
    for (const chunk of chunks) {
      expect(chunk.reduce((sum, name) => sum + (worstCase(byName.get(name) as CatalogColumn) ?? Number.NaN), 0)).toBeLessThanOrEqual(8000);
    }
    expect(chunks.flat()).toEqual(columns.filter((spec) => worstCase(spec) !== undefined).map((spec) => spec.name));
    expect(text).toContain('ISNULL(CAST(DATALENGTH([Body]) AS binary(4)) + CAST([Body] AS varbinary(max)), 0xFFFFFFFF)');
    expect(text).toMatch(/^SELECT TOP \(250001\) \[tcontent_ID\] AS \[k0\], CAST\(HASHBYTES\('SHA2_256', CAST\(HASHBYTES\('SHA2_256', /);
    expect(text).toMatch(/\) AS binary\(16\)\) AS \[h\] FROM \[dbo\]\.\[tsample\] WHERE \(\[SiteID\] IN \(@p0\)\)$/);
  });

  it.each([
    ['ntext', null, 'CAST([Doc] AS nvarchar(max))'],
    ['xml', -1, 'CAST([Doc] AS nvarchar(max))'],
    ['text', null, 'CAST([Doc] AS varchar(max))'],
    ['image', null, '[Doc]'],
    ['nvarchar', -1, '[Doc]'],
    ['varchar', -1, '[Doc]'],
    ['varbinary', -1, '[Doc]'],
    ['varchar', 8000, '[Doc]'],
    ['nvarchar', 4000, '[Doc]'],
  ] as [string, number | null, string][])('hashes a %s(%s) column whole through %s', (sqlType, maxLength, read) => {
    const text = fingerprintSql(tableOf([column('ID', 'int'), column('Doc', sqlType, maxLength)], ['ID']), '');
    expect(text).toContain(`CAST(HASHBYTES('SHA2_256', ISNULL(CAST(DATALENGTH([ID]) AS binary(4)) + CAST([ID] AS varbinary(8000)), 0xFFFFFFFF)) AS varbinary(max))`);
    expect(text).toContain(` + ISNULL(CAST(DATALENGTH(${read}) AS binary(4)) + CAST(${read} AS varbinary(max)), 0xFFFFFFFF))`);
  });

  it('hashes a table of large objects only from its first whole column on', () => {
    const text = fingerprintSql(tableOf([column('Doc', 'ntext'), column('Blob', 'image')]), '');
    expect(text).toBe(
      'SELECT TOP (250001) CAST(HASHBYTES(\'SHA2_256\', CAST(ISNULL(CAST(DATALENGTH(CAST([Doc] AS nvarchar(max))) AS binary(4)) + CAST(CAST([Doc] AS nvarchar(max)) AS varbinary(max)), 0xFFFFFFFF) AS varbinary(max))' +
        ' + ISNULL(CAST(DATALENGTH([Blob]) AS binary(4)) + CAST([Blob] AS varbinary(max)), 0xFFFFFFFF)) AS binary(16)) AS [h] FROM [dbo].[tsample]',
    );
  });

  it.each(['sql_variant', 'timestamp', 'geography', 'hierarchyid'])('reads no fingerprint of a table with a %s column', (sqlType) => {
    expect(fingerprintSql(tableOf([column('ID', 'int'), column('Odd', sqlType)], ['ID']), '')).toBeUndefined();
  });

  it.each([
    ['a keyless table', [], ''],
    ['a composite key', ['ContentHistID', 'CategoryID'], '[ContentHistID] AS [k0], [CategoryID] AS [k1], '],
  ] as [string, string[], string][])('selects the key columns of %s before the row hash, under the row cap', (_label, primaryKey, keys) => {
    const columns = [column('ContentHistID', 'char', 35), column('CategoryID', 'char', 35), column('OrderNo', 'int')];
    expect(fingerprintSql(tableOf(columns, primaryKey), '', 9)).toMatch(new RegExp(`^SELECT TOP \\(10\\) ${keys.replace(/[[\]()]/g, '\\$&')}CAST\\(HASHBYTES`));
  });
});

describe('partitionWhere', () => {
  it.each([
    ['the whole table', '', ['ID'], 1, ' WHERE ABS(CAST(CHECKSUM([ID]) AS bigint)) % 4 = 1'],
    [
      'every term of a scope filter',
      ' WHERE ([SiteID] IN (@p0)) OR ([UserID] IN (@p1))',
      ['ContentHistID', 'CategoryID'],
      3,
      ' WHERE (([SiteID] IN (@p0)) OR ([UserID] IN (@p1))) AND ABS(CAST(CHECKSUM([ContentHistID], [CategoryID]) AS bigint)) % 4 = 3',
    ],
  ] as [string, string, string[], number, string][])('narrows %s to one key partition', (_label, whereSql, keyColumns, index, expected) => {
    expect(partitionWhere(whereSql, keyColumns, index, 4)).toBe(expected);
  });
});

/** A keyed fingerprint of `rows`, each a key tuple and its hash. */
function keyed(rows: [unknown[], string][], keyColumns = ['ID']): TableFingerprint {
  return { table: 'tsample', keyed: true, keyColumns, rows: new Map(rows.map(([key, hash]) => [JSON.stringify(key), { key, hash }])) };
}

function keyless(hashes: Record<string, number>): TableFingerprint {
  return { table: 'tsample', keyed: false, hashes: new Map(Object.entries(hashes)) };
}

describe('diffFingerprints', () => {
  const BEFORE = keyed([
    [[1], 'a'],
    [[2], 'b'],
    [[3], 'c'],
  ]);

  it('finds nothing changed when every key keeps its hash', () => {
    expect(diffFingerprints(BEFORE, keyed([[[3], 'c'], [[1], 'a'], [[2], 'b']]))).toEqual({ kind: 'unchanged' });
  });

  it.each([
    ['an insert', [[[1], 'a'], [[2], 'b'], [[3], 'c'], [[4], 'd']], [4]],
    ['an update', [[[1], 'a'], [[2], 'B'], [[3], 'c']], [2]],
    ['a delete', [[[1], 'a'], [[3], 'c']], [2]],
    ['a key changed in place', [[[1], 'a'], [[2], 'b'], [[30], 'c']], [3, 30]],
  ] as [string, [unknown[], string][], number[]][])('narrows %s to its changed keys', (_label, after, values) => {
    expect(diffFingerprints(BEFORE, keyed(after))).toEqual({ kind: 'keys', column: 'ID', values });
  });

  it.each([
    ['the column with the fewest distinct values', [[['S1', 'C1'], 'x'], [['S1', 'C2'], 'y']], { column: 'SiteID', values: ['S1'] }],
    ['the first key column on a tie', [[['S1', 'C1'], 'x'], [['S2', 'C2'], 'y']], { column: 'SiteID', values: ['S1', 'S2'] }],
    ['the second column when it has fewer values', [[['S1', 'C1'], 'x'], [['S2', 'C1'], 'y']], { column: 'ContentID', values: ['C1'] }],
  ] as [string, [unknown[], string][], { column: string; values: string[] }][])('finds composite-key changes by %s', (_label, added, change) => {
    expect(diffFingerprints(keyed([], ['SiteID', 'ContentID']), keyed(added, ['SiteID', 'ContentID']))).toEqual({ kind: 'keys', ...change });
  });

  it.each([
    ['bit', true, 1],
    ['char padded text', 'ID-1      ', 'ID-1      '],
    ['safe integer', 2 ** 53 - 1, 2 ** 53 - 1],
  ] as [string, unknown, string | number][])('binds a %s key value as the filter reads it', (_label, key, value) => {
    expect(diffFingerprints(keyed([]), keyed([[[key], 'x']]))).toEqual({ kind: 'keys', column: 'ID', values: [value] });
  });

  it.each([
    ['a datetime key', new Date(0)],
    ['a binary key', Buffer.from('ab')],
    ['an unsafe integer key', 2 ** 53 + 2],
    ['a fractional key', 1.5],
  ])('compares the whole table for %s, which no filter binds', (_label, key) => {
    expect(diffFingerprints(keyed([]), keyed([[[key], 'x']]))).toEqual({ kind: 'whole' });
  });

  it('compares the whole table once more keys changed than one filter binds', () => {
    const rows = (count: number): [unknown[], string][] => Array.from({ length: count }, (_, index): [unknown[], string] => [[index], 'x']);
    expect(diffFingerprints(keyed([]), keyed(rows(MAX_SCOPE_PARAMETERS)))).toMatchObject({ kind: 'keys' });
    expect(diffFingerprints(keyed([]), keyed(rows(MAX_SCOPE_PARAMETERS + 1)))).toEqual({ kind: 'whole' });
  });

  it.each([
    ['a keyless table holding the same multiset', 'unchanged', keyless({ a: 2, b: 1 }), keyless({ b: 1, a: 2 })],
    ['a keyless table that gained an occurrence', 'whole', keyless({ a: 2, b: 1 }), keyless({ a: 3, b: 1 })],
    ['a keyless table that lost a row', 'whole', keyless({ a: 1, b: 1 }), keyless({ a: 1 })],
    ['a table no longer fingerprinted', 'whole', keyless({ a: 1 }), undefined],
    ['a table fingerprinted only after', 'whole', undefined, keyed([])],
    ['a table that gained a key', 'whole', keyless({}), keyed([])],
    ['a table whose key changed', 'whole', keyed([], ['ID']), keyed([], ['UserID'])],
  ] as [string, string, TableFingerprint | undefined, TableFingerprint | undefined][])('finds %s %s', (_label, kind, before, after) => {
    expect(diffFingerprints(before, after)).toEqual({ kind });
  });
});

describe('sameScope', () => {
  it.each([
    ['table', 'table', true],
    [{ siteid: ['tenant-a'], userid: ['U1'] }, { userid: ['U1'], siteid: ['tenant-a'] }, true],
    [{ siteid: ['tenant-a'] }, { siteid: ['tenant-b'] }, false],
    [{ siteid: ['tenant-a'] }, 'table', false],
  ] as const)('compares %j with %j as %s', (a, b, same) => {
    expect(sameScope(a, b)).toBe(same);
  });
});

describe('fingerprintTables', () => {
  it('lists the units\' legacy tables once each, skipping the file-object unit', () => {
    const catalog = loadUnitCatalog(loadConfig().paths.tableOwnership);
    const units = ['people.person', FILE_OBJECT_UNIT, 'identity.group_account', 'content.content', 'identity.group_account'];
    expect(fingerprintTables(catalog, units)).toEqual(['tcontent', 'tusers']);
    expect(fingerprintKey('dbo.TUsers')).toBe('tusers');
  });
});

/** A scripted table: its catalog columns and key, and the rows its hash SELECT returns. */
interface ScriptedTable {
  columns: { name: string; type: string; maxLength?: number }[];
  primaryKey?: string[];
  rows: Row[];
}

let databases = 0;

/** Options of {@link scriptedLegacy}. */
interface ScriptedOptions {
  fail?: Record<string, Error>;
  /** Tables whose hash SELECT answers only when cancelled. */
  hold?: string[];
  /** Row counts the size query reports, by `schema.table`, with each table's scripted column count. */
  sizes?: Record<string, number>;
  /** Held catalog reads answer once it settles. */
  stall?: Promise<void>;
  /** A database other than READ_ONLY has its catalog version checked on every catalog read. */
  updateability?: string;
}

/** The partition a scripted key value falls in, standing for CHECKSUM's spread. */
function partitionOf(value: unknown, count: number): number {
  if (typeof value === 'number') return Math.abs(value) % count;
  let sum = 0;
  for (const char of String(value)) sum += char.codePointAt(0) ?? 0;
  return sum % count;
}

/**
 * Legacy pool answering catalog and size queries from `tables` and each hash SELECT after a tick, with only the rows of
 * the key partition it names; `hold` tables answer only when cancelled.
 */
function scriptedLegacy(tables: Record<string, ScriptedTable>, options: ScriptedOptions = {}) {
  const selects: string[] = [];
  const texts: string[] = [];
  const queries: string[] = [];
  const cancelled: string[] = [];
  let running = 0;
  let mostRunning = 0;
  databases += 1;
  const spec = (schema: unknown, table: unknown): ScriptedTable | undefined => tables[`${String(schema)}.${String(table)}`];
  const request = () => {
    const inputs = new Map<string, unknown>();
    let cancel: (() => void) | undefined;
    let name = '';
    return {
      input(key: string, ...rest: unknown[]) {
        inputs.set(key, rest.at(-1));
        return this;
      },
      cancel() {
        cancelled.push(name);
        cancel?.();
      },
      async query(text: string) {
        queries.push(text);
        if (text.includes('DATABASEPROPERTYEX')) return { recordset: [{ updateability: options.updateability ?? 'READ_ONLY' }] };
        if (text.includes('sys.partitions')) {
          const sizes = [...inputs].map(([key, value], i) => {
            const qualified = String(value).replaceAll(/[[\]]/g, '');
            expect(key).toBe(`t${String(i)}`);
            const rows = options.sizes?.[qualified];
            // SUM over bigint row counts reaches the driver as text; a table without a count stands for one SQL Server lacks.
            return { i, rows: rows === undefined ? null : String(rows), columns: rows === undefined ? null : (tables[qualified]?.columns.length ?? 0) };
          });
          return { recordset: sizes };
        }
        if (text.includes('last_modified')) return { recordset: [{ table_count: 1, column_count: 1, last_modified: new Date(0) }] };
        if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
          await options.stall;
          const found = spec(inputs.get('schema'), inputs.get('table'));
          const columns = (found?.columns ?? []).map((item, index) => ({
            COLUMN_NAME: item.name,
            DATA_TYPE: item.type,
            IS_NULLABLE: 'YES',
            CHARACTER_MAXIMUM_LENGTH: item.maxLength ?? null,
            NUMERIC_PRECISION: null,
            NUMERIC_SCALE: null,
            ORDINAL_POSITION: index + 1,
          }));
          return { recordset: columns, recordsets: [columns, (found?.primaryKey ?? []).map((key) => ({ name: key })), []] };
        }
        const from = /FROM \[([^\]]+)\]\.\[([^\]]+)\]/.exec(text);
        const partition = /% (\d+) = (\d+)$/.exec(text);
        name = `${from?.[1] ?? ''}.${from?.[2] ?? ''}`;
        selects.push(name);
        texts.push(text);
        running += 1;
        mostRunning = Math.max(mostRunning, running);
        try {
          if (options.hold?.includes(name) === true) {
            await new Promise<void>((resolve) => {
              cancel = resolve;
            });
            throw Object.assign(new Error('Canceled.'), { code: 'ECANCEL' });
          }
          await delay(5);
          const failure = options.fail?.[name];
          if (failure !== undefined) throw failure;
          const rows = spec(from?.[1], from?.[2])?.rows ?? [];
          if (partition === null) return { recordset: rows };
          const [count, index] = [Number(partition[1]), Number(partition[2])];
          return { recordset: rows.filter((row) => partitionOf(row.k0, count) === index) };
        } finally {
          running -= 1;
        }
      },
    };
  };
  const pool = { config: { database: `muradb_fingerprints_${String(databases)}` }, request } as unknown as ConnectionPool;
  const legacy = { live: () => Promise.resolve(pool) } as unknown as MigrationContext['legacy'];
  const catalog = loadUnitCatalog(loadConfig().paths.tableOwnership);
  return { ctx: { legacy, catalog }, selects, texts, queries, cancelled, mostRunning: () => mostRunning };
}

const hash = (text: string): Buffer => Buffer.from(text.padEnd(16, '.'));
const plain = (rows: Row[], primaryKey: string[] = ['ID']): ScriptedTable => ({ columns: [{ name: 'ID', type: 'int' }, { name: 'Title', type: 'nvarchar', maxLength: 50 }], primaryKey, rows });

describe('readFingerprints', () => {
  beforeEach(() => {
    clearCatalogCache();
  });

  it('reads keyed and keyless tables at most four at a time, by table key, leaving out a folded table and one past the row cap', async () => {
    const tables: Record<string, ScriptedTable> = {
      'dbo.tkeyed': plain([{ k0: 7, h: hash('seven') }, { k0: 8, h: hash('eight') }]),
      'dbo.tkeyless': plain([{ h: hash('dup') }, { h: hash('dup') }, { h: hash('one') }], []),
      'dbo.tbig': plain(Array.from({ length: MAX_FINGERPRINT_ROWS + 1 }, (_, index) => ({ k0: index, h: hash('x') }))),
      'Program_1.tsample': plain([]),
      ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`dbo.textra${String(index)}`, plain([])])),
    };
    const legacy = scriptedLegacy(tables);
    const names = ['tkeyed', 'dbo.TKeyed', 'tkeyless', 'tbig', 'Program_1.tsample', ...Array.from({ length: 6 }, (_, index) => `textra${String(index)}`)];
    const state = await readFingerprints(legacy.ctx, names, { siteid: ['tenant-a'] });

    expect(state.scope).toEqual({ siteid: ['tenant-a'] });
    expect([...state.tables.keys()].sort()).toEqual(['tkeyed', 'tkeyless', ...Array.from({ length: 6 }, (_, index) => `textra${String(index)}`)].sort());
    expect(state.tables.get('tkeyed')).toEqual({
      table: 'tkeyed',
      keyed: true,
      keyColumns: ['ID'],
      rows: new Map([
        ['[7]', { key: [7], hash: hash('seven').toString('hex') }],
        ['[8]', { key: [8], hash: hash('eight').toString('hex') }],
      ]),
    });
    expect(state.tables.get('tkeyless')).toEqual({ table: 'tkeyless', keyed: false, hashes: new Map([[hash('dup').toString('hex'), 2], [hash('one').toString('hex'), 1]]) });
    expect(legacy.selects).not.toContain('Program_1.tsample');
    expect(legacy.selects.filter((name) => name === 'dbo.tkeyed')).toHaveLength(1);
    expect(legacy.mostRunning()).toBe(4);
    expect(state.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with the first read\'s error once the reads in flight were cancelled, starting no further read', async () => {
    const failure = new Error('Invalid column name');
    const tables = Object.fromEntries(['tslow', 'tbad', 'tnext1', 'tnext2', 'tnext3', 'tnext4'].map((name) => [`dbo.${name}`, plain([])]));
    const legacy = scriptedLegacy(tables, { fail: { 'dbo.tbad': failure }, hold: ['dbo.tslow'] });

    await expect(readFingerprints(legacy.ctx, Object.keys(tables).map((name) => name.slice(4)), 'table')).rejects.toBe(failure);
    // Every read still in flight is cancelled; the held one ends only through its cancel.
    expect(legacy.cancelled.toSorted()).toEqual(['dbo.tnext1', 'dbo.tnext2', 'dbo.tslow']);
    expect(legacy.selects).toEqual(['dbo.tslow', 'dbo.tbad', 'dbo.tnext1', 'dbo.tnext2']);
  });

  // The scripted tables have two columns, so half the cell threshold in rows reaches it.
  it.each([
    ['a keyed table from the partition threshold on', PARTITION_CELLS / 2, FINGERPRINT_CONCURRENCY, ['ID']],
    ['a keyed table at the row cap', MAX_FINGERPRINT_ROWS, FINGERPRINT_CONCURRENCY, ['ID']],
    ['a keyed table below the partition threshold', PARTITION_CELLS / 2 - 1, 1, ['ID']],
    ['a keyed table past the row cap by its count', MAX_FINGERPRINT_ROWS + 1, 1, ['ID']],
    ['a keyless table from the partition threshold on', PARTITION_CELLS / 2, 1, []],
  ] as [string, number, number, string[]][])('reads %s, counted at %i rows, in %i SELECTs at once, holding every row once', async (_label, rows, selects, primaryKey) => {
    const records = Array.from({ length: 40 }, (_, index) => (primaryKey.length === 0 ? { h: hash(`row${String(index % 7)}`) } : { k0: index * 3 - 50, h: hash(`row${String(index)}`) }));
    const whole = await readFingerprints(scriptedLegacy({ 'dbo.tsplit': plain(records, primaryKey) }).ctx, ['tsplit'], 'table');
    const legacy = scriptedLegacy({ 'dbo.tsplit': plain(records, primaryKey) }, { sizes: { 'dbo.tsplit': rows } });
    const state = await readFingerprints(legacy.ctx, ['tsplit'], 'table');

    expect(legacy.texts.map((text) => /% (\d+) = (\d+)$/.exec(text)?.slice(1))).toEqual(
      selects === 1 ? [undefined] : Array.from({ length: selects }, (_, index) => [String(selects), String(index)]),
    );
    expect(legacy.mostRunning()).toBe(selects);
    expect(state.tables.get('tsplit')).toEqual(whole.tables.get('tsplit'));
    const print = state.tables.get('tsplit');
    expect(print?.keyed === true ? print.rows.size : [...(print?.hashes.values() ?? [])].reduce((sum, count) => sum + count, 0)).toBe(40);
  });

  it('leaves out a split table whose partitions together hold more than the row cap', async () => {
    const records = Array.from({ length: MAX_FINGERPRINT_ROWS + 1 }, (_, index) => ({ k0: index, h: hash('x') }));
    const legacy = scriptedLegacy({ 'dbo.tsplit': plain(records), 'dbo.tsmall': plain([{ k0: 1, h: hash('one') }]) }, { sizes: { 'dbo.tsplit': MAX_FINGERPRINT_ROWS } });
    const state = await readFingerprints(legacy.ctx, ['tsplit', 'tsmall'], 'table');

    expect(legacy.selects.filter((name) => name === 'dbo.tsplit')).toHaveLength(FINGERPRINT_CONCURRENCY);
    expect([...state.tables.keys()]).toEqual(['tsmall']);
  });

  it('starts the costliest SELECTs first, by row times column count, and tables without a count last in their order', async () => {
    const wide: ScriptedTable = { columns: Array.from({ length: 20 }, (_, index) => ({ name: `C${String(index)}`, type: 'int' })), primaryKey: ['C0'], rows: [] };
    const tables = { 'dbo.tnone': plain([]), 'dbo.tlong': plain([]), 'dbo.twide': wide, 'dbo.tfew': plain([]), 'dbo.tmid': plain([]), 'dbo.tlast': plain([]) };
    const legacy = scriptedLegacy(tables, { sizes: { 'dbo.tlong': 3000, 'dbo.twide': 1000, 'dbo.tfew': 5, 'dbo.tmid': 900 } });
    await readFingerprints(legacy.ctx, ['tnone', 'tlong', 'twide', 'tfew', 'tmid', 'tlast'], 'table');

    expect(legacy.selects).toEqual(['dbo.twide', 'dbo.tlong', 'dbo.tmid', 'dbo.tfew', 'dbo.tnone', 'dbo.tlast']);
  });

  it('reads no further catalog and runs no SELECT once its signal aborted during a catalog read', async () => {
    let release = (): void => undefined;
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const legacy = scriptedLegacy({ 'dbo.tslow': plain([]) }, { stall, updateability: 'READ_WRITE' });
    const controller = new AbortController();
    const reading = readFingerprints(legacy.ctx, ['tslow'], 'table', controller.signal);
    await delay(20);
    const queried = legacy.queries.length;
    controller.abort(new Error('budget spent'));
    release();

    await expect(reading).rejects.toThrow('budget spent');
    expect(legacy.queries).toHaveLength(queried);
    expect(legacy.selects).toEqual([]);
  });

  it('cancels its reads when the caller\'s signal aborts', async () => {
    const legacy = scriptedLegacy({ 'dbo.tslow': plain([]) }, { hold: ['dbo.tslow'] });
    const controller = new AbortController();
    const reading = readFingerprints(legacy.ctx, ['tslow'], 'table', controller.signal);
    await delay(20);
    controller.abort(new Error('budget spent'));

    await expect(reading).rejects.toMatchObject({ code: 'ECANCEL' });
    expect(legacy.cancelled).toEqual(['dbo.tslow']);
  });
});
