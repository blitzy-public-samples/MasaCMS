/** legacyStorable: every content table's text columns held to the widths of the live legacy catalog, as SQL Server stores them. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RepositoryError, type RepositoryRow } from '@opt2/platform/migration-kit';
import { mappings } from '../../src/migration/mappings/index.js';
import { LegacyStorageError, isLegacyLimited, legacyStorable, type LegacyLimitedTable } from '../../src/repo/legacy-limits.js';
import { CONTENT_UNITS, NON_UNIT_TABLE_NAMES } from '../../src/repo/tables.js';

interface CatalogTable {
  schema: string;
  name: string;
  columns: { name: string; type: string; length: number | 'max' | null }[];
}

const CATALOG = JSON.parse(readFileSync(new URL('../../../../opt2/inventory/live-catalog.json', import.meta.url), 'utf8')) as { catalog: CatalogTable[] };
const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as {
  units: { unit: string; owner: string; legacyTables: string[] }[];
};
const TEXT_TYPES: ReadonlySet<string> = new Set(['char', 'nchar', 'varchar', 'nvarchar']);
const UNIT_PREFIX = 'content.';

/** A text column of a content table: its target name and its catalog width, null for `max`. */
interface TextColumn {
  table: LegacyLimitedTable;
  column: string;
  width: number | null;
}

/** The text columns of every strategies-content unit's legacy table, named as its mapping names them in the target. */
const TEXT_COLUMNS: readonly TextColumn[] = OWNERSHIP.units
  .filter((unit) => unit.owner === 'strategies-content')
  .flatMap(({ unit, legacyTables }) => {
    const [legacyName] = legacyTables;
    const legacy = CATALOG.catalog.find((entry) => entry.schema === 'dbo' && entry.name.toLowerCase() === legacyName?.toLowerCase());
    const mapping = mappings.find((entry) => entry.unit === unit);
    if (legacy === undefined || mapping === undefined) throw new Error(`no live catalog table or mapping for ${unit}`);
    const table = unit.slice(UNIT_PREFIX.length) as LegacyLimitedTable;
    return legacy.columns
      .filter((column) => TEXT_TYPES.has(column.type))
      .map((column): TextColumn => {
        const target = mapping.columns.find((entry) => entry.legacy.toLowerCase() === column.name.toLowerCase())?.target;
        if (target === undefined) throw new Error(`${unit} maps no target column for ${legacy.name}.${column.name}`);
        return { table, column: target, width: typeof column.length === 'number' ? column.length : null };
      });
  });

const FINITE = TEXT_COLUMNS.filter((column): column is TextColumn & { width: number } => column.width !== null);
const UNLIMITED = TEXT_COLUMNS.filter((column) => column.width === null);

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('legacyStorable', () => {
  const smile = '\u{1F600}';

  it('limits every content unit table and no table without a legacy one', () => {
    expect(new Set(TEXT_COLUMNS.map((column) => `${UNIT_PREFIX}${column.table}`))).toEqual(new Set(CONTENT_UNITS));
    expect(CONTENT_UNITS.filter((unit) => !isLegacyLimited(unit.slice(UNIT_PREFIX.length)))).toEqual([]);
    expect(NON_UNIT_TABLE_NAMES.filter((table) => isLegacyLimited(table))).toEqual([]);
  });

  it.each(FINITE)('holds $table.$column to its catalog width $width', ({ table, column, width }) => {
    const fits = { [column]: 'x'.repeat(width) };
    expect(legacyStorable(table, fits)).toEqual(fits);
    expect(thrownBy(() => legacyStorable(table, { [column]: 'x'.repeat(width + 1) }))).toMatchObject({ table, column, limit: width });
  });

  it.each(UNLIMITED)('leaves the max column $table.$column unlimited', ({ table, column }) => {
    const row = { [column]: 'x'.repeat(10_000) };
    expect(legacyStorable(table, row)).toEqual(row);
  });

  it.each<[string, LegacyLimitedTable, RepositoryRow, RepositoryRow]>([
    ['a value at the width', 'category', { name: 'n'.repeat(50) }, { name: 'n'.repeat(50) }],
    ['only trailing spaces beyond the width, cut', 'category', { name: `${'n'.repeat(50)}   `, notes: ' n ' }, { name: 'n'.repeat(50), notes: ' n ' }],
    ['NULL and absent columns', 'changeset', { name: null, description: 'd' }, { name: null, description: 'd' }],
    ['non-text values', 'content', { title: 7, lastupdate: new Date(2026, 5, 30) }, { title: 7, lastupdate: new Date(2026, 5, 30) }],
    ['surrogate pairs within the width', 'approval_chain', { name: smile.repeat(50) }, { name: smile.repeat(50) }],
  ])('stores %s', (_label, table, row, expected) => {
    expect(legacyStorable(table, row)).toEqual(expected);
  });

  it.each<[string, LegacyLimitedTable, RepositoryRow, string, number]>([
    ['a category name beyond its nvarchar(50)', 'category', { name: 'n'.repeat(255) }, 'name', 50],
    ['a space then text beyond the width', 'changeset', { name: `${'n'.repeat(100)} y` }, 'name', 100],
    ['surrogate pairs beyond the width', 'approval_chain', { name: smile.repeat(51) }, 'name', 100],
    ['an id beyond its char(35)', 'trash', { deleteid: 'D'.repeat(36) }, 'deleteid', 35],
  ])('rejects %s', (_label, table, row, column, limit) => {
    const thrown = thrownBy(() => legacyStorable(table, row));
    expect(thrown).toBeInstanceOf(LegacyStorageError);
    expect(thrown).toBeInstanceOf(RepositoryError);
    expect(thrown).toMatchObject({ table, column, limit, message: `${table}: column ${column} is beyond the legacy width ${String(limit)}` });
  });
});
