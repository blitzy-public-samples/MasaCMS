// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
// Direct mode's apply bodies, as runDirect sends them, against the fixture DDL and the owners' ApplyRequest fields.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTypeForSqlServer, decodeRow, type ApplyRequest, type CanonicalColumn, type CanonicalValue } from '@opt2/platform/migration-kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildDataset, type Dataset } from '../../src/dataset.js';
import { FIXTURE_COLUMNS, applyRequestFor, planDirectBatches } from '../../src/direct.js';
import { FIXTURE_TABLE_SPECS, fixtureKeys, specForKey, type FixtureRow } from '../../src/fixture-tables.js';

type DecodedRow = Record<string, CanonicalValue>;

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PKG_ROOT, '../..');
const CONFIG_PATH = path.join(PKG_ROOT, 'seed.config.json');
const PIN_PATH = path.join(REPO_ROOT, 'opt2', 'source-pin.json');

let dataset: Dataset;
let keys: string[];

function rowsOf(key: string): FixtureRow[] {
  const rows = dataset.fixtures[key];
  if (rows === undefined) throw new Error(`dataset has no ${key}`);
  return rows;
}

/** A decoded row in dataset form: bytes as hex, every other value as its text. */
function datasetForm(row: DecodedRow, columns: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(
    columns.map((name) => {
      const value = row[name] ?? null;
      return [name, Buffer.isBuffer(value) ? value.toString('hex') : value];
    }),
  );
}

describe('wire columns against the fixture DDL', () => {
  const SQL_DIR = path.join(REPO_ROOT, 'legacy-fixtures', 'sql');
  const TABLES = FIXTURE_TABLE_SPECS.map(({ table }) => table);
  const APPLY_KEYS = ['batchId', 'columns', 'legacyTable', 'origin', 'rows', 'tenantId'];
  const CANONICAL_TYPES = ['s', 'i', 'f', 'd', 't', 'b'];
  // Pattern of components.schemas.TenantId in the owners' contracts.
  const TENANT_ID = /^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}|00000000-0000-0000-0000-000000000000|[Ff]{8}-[Ff]{4}-[Ff]{4}-[Ff]{4}-[Ff]{12})$/;
  let ddl: Map<string, CanonicalColumn[]>;
  let wireBodies: ApplyRequest[];

  /** Canonical columns of each `CREATE TABLE` block of a fixture DDL file by table, in catalog order. */
  function ddlCatalog(sql: string): Map<string, CanonicalColumn[]> {
    const tables = new Map<string, CanonicalColumn[]>();
    for (const [, table = '', body = ''] of sql.matchAll(/CREATE TABLE \[[^\]]+\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g)) {
      const columns = body.split('\n').flatMap((line): CanonicalColumn[] => {
        const match = /^\s*\[([^\]]+)\] (\[[A-Za-z]+\](?: \([^)]+\))?)/.exec(line);
        return match === null ? [] : [{ name: match[1] ?? '', ...canonicalTypeForSqlServer(match[2] ?? '') }];
      });
      tables.set(table, columns);
    }
    return tables;
  }

  /** DDL columns of fixture table `table`. */
  function ddlOf(table: string): CanonicalColumn[] {
    const columns = ddl.get(table);
    if (columns === undefined) throw new Error(`${table} has no CREATE TABLE under ${SQL_DIR}`);
    return columns;
  }

  /** Fixture table of a dataset key, without its schema. */
  const tableOf = (key: string): string => key.replace(/^(?:Program_\d+|synthetic)\./, '');

  /** `name:<tag>` of a column, with its scale after the tag when it has one. */
  const wire = (column: CanonicalColumn | undefined): string => (column === undefined ? 'nothing' : `${column.name}:${column.type}${column.scale ?? ''}`);

  /** Position-by-position differences of `columns` from `expected`, each naming the column of `table`. */
  function mismatches(table: string, columns: readonly CanonicalColumn[], expected: readonly CanonicalColumn[]): string[] {
    return Array.from({ length: Math.max(columns.length, expected.length) }, (_, i) => ({ i, got: columns[i], want: expected[i] }))
      .filter(({ got, want }) => wire(got) !== wire(want))
      .map(({ i, got, want }) => `${table}.${want?.name ?? got?.name ?? ''} #${i + 1}: sent ${wire(got)}, DDL ${wire(want)}`);
  }

  /** `columns` with positions `i` and `j` exchanged. */
  const swap = (columns: readonly CanonicalColumn[], i: number, j: number): CanonicalColumn[] =>
    columns.map((column, k) => columns[k === i ? j : k === j ? i : k] ?? column);

  beforeAll(async () => {
    const config = await loadConfig(CONFIG_PATH);
    const { sha } = JSON.parse(await fs.readFile(PIN_PATH, 'utf8')) as { sha: string };
    dataset = buildDataset(config, sha);
    keys = fixtureKeys(config);
    ddl = new Map();
    for (const dir of await fs.readdir(SQL_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const file of (await fs.readdir(path.join(SQL_DIR, dir.name))).filter((name) => /^1\d*_.+\.sql$/.test(name))) {
        for (const [table, columns] of ddlCatalog(await fs.readFile(path.join(SQL_DIR, dir.name, file), 'utf8'))) {
          if (ddl.has(table)) throw new Error(`${table} has two CREATE TABLE blocks under ${SQL_DIR}`);
          ddl.set(table, columns);
        }
      }
    }
    // runDirect posts applyRequestFor(batch) for every planned batch, as JSON.
    wireBodies = planDirectBatches(dataset, config).map((batch) => JSON.parse(JSON.stringify(applyRequestFor(batch))) as ApplyRequest);
  });

  it('covers the table of every configured fixture key and every catalog entry', () => {
    expect([...new Set(keys.map(tableOf))]).toEqual(TABLES);
    expect(Object.keys(FIXTURE_COLUMNS).sort()).toEqual([...TABLES].sort());
  });

  it.each(TABLES)('FIXTURE_COLUMNS.%s matches its DDL columns in order, tag and scale', (table) => {
    expect(mismatches(table, FIXTURE_COLUMNS[table] ?? [], ddlOf(table))).toEqual([]);
    expect(FIXTURE_COLUMNS[table]).toStrictEqual(ddlOf(table));
  });

  it.each(TABLES)('%s batches declare its DDL columns, and their rows decode over the DDL columns to the dataset rows', (table) => {
    const columns = ddlOf(table);
    for (const key of keys.filter((candidate) => tableOf(candidate) === table)) {
      const pk = specForKey(key).spec.key;
      const byKey = new Map<string, DecodedRow>();
      for (const body of wireBodies.filter(({ legacyTable }) => legacyTable === key)) {
        expect(mismatches(table, body.columns, columns), key).toEqual([]);
        for (const { row } of body.rows) {
          const decodedRow = decodeRow(columns, row);
          byKey.set(String(decodedRow[pk]), decodedRow);
        }
      }
      const expected = rowsOf(key);
      expect(byKey.size, key).toBe(expected.length);
      const actual = expected.map((row) => {
        const match = byKey.get(String(row[pk]));
        return match === undefined ? undefined : datasetForm(match, Object.keys(row));
      });
      expect(actual, key).toEqual(expected.map((row) => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value === null ? null : String(value)]))));
    }
  });

  it('sends each body with exactly the ApplyRequest fields direct mode uses', () => {
    expect(wireBodies.length).toBeGreaterThan(0);
    for (const body of wireBodies) {
      expect(Object.keys(body).sort(), body.legacyTable).toEqual(APPLY_KEYS);
      expect(body, body.legacyTable).toMatchObject({
        batchId: expect.stringMatching(/\S/),
        origin: 'backfill',
        legacyTable: expect.stringMatching(/^(?:Program_\d+|synthetic)\.\w+$/),
        tenantId: expect.stringMatching(TENANT_ID),
      });
    }
  });

  it('declares each column as a name and canonical tag, with a scale exactly for d', () => {
    for (const body of wireBodies) {
      expect(body.columns.length, body.legacyTable).toBeGreaterThan(0);
      for (const column of body.columns) {
        const label = `${body.legacyTable}.${column.name}`;
        expect(Object.keys(column).sort(), label).toEqual(column.type === 'd' ? ['name', 'scale', 'type'] : ['name', 'type']);
        expect(CANONICAL_TYPES, label).toContain(column.type);
        if (column.type === 'd') expect(Number.isSafeInteger(column.scale) && Number(column.scale) >= 0, label).toBe(true);
      }
    }
  });

  it('sends each row as one upsert of an encoded row string', () => {
    const malformed = wireBodies.flatMap(({ rows }) => rows.filter((row) => Object.keys(row).sort().join() !== 'op,row' || row.op !== 'upsert' || typeof row.row !== 'string'));
    expect(malformed).toEqual([]);
  });

  it.each<[string, string, (columns: readonly CanonicalColumn[]) => CanonicalColumn[], string[]]>([
    [
      'a wrong tag',
      'timesheet_day',
      (columns) => columns.map((column): CanonicalColumn => (column.name === 'hours' ? { name: column.name, type: 's' } : column)),
      ['timesheet_day.hours #4: sent hours:s, DDL hours:d4'],
    ],
    [
      'a wrong scale',
      'finance_record',
      (columns) => columns.map((column): CanonicalColumn => (column.name === 'amount' ? { ...column, scale: 2 } : column)),
      ['finance_record.amount #4: sent amount:d2, DDL amount:d4'],
    ],
    [
      'swapped columns',
      'timesheet_day',
      (columns) => swap(columns, 2, 3),
      ['timesheet_day.work_date #3: sent hours:d4, DDL work_date:t', 'timesheet_day.hours #4: sent work_date:t, DDL hours:d4'],
    ],
  ])('flags a catalog with %s in %s, naming the column', (_label, table, mutate, expected) => {
    expect(mismatches(table, mutate(FIXTURE_COLUMNS[table] ?? []), ddlOf(table))).toEqual(expected);
  });
});
