// Unit tests for the write-window scope filter: SQL predicate, parameter binding and the Node row mirror.
import sql from 'mssql';
import type { ISqlTypeFactory, Request } from 'mssql';
import { describe, expect, it } from 'vitest';

import type { CatalogColumn } from '../../../src/extract/catalog.js';
import {
  MAX_SCOPE_PARAMETERS,
  bindScope,
  buildScopeFilter,
  rowInScope,
  type ExtractScope,
  type ScopeFilter,
  type ScopeValue,
} from '../../../src/extract/scope.js';

const INTEGER_SQL_TYPES = new Set(['int', 'smallint', 'tinyint', 'bigint', 'bit']);

/** Catalog column as `readTableCatalog` builds it; `maxLength` -1 means `max`. */
function column(name: string, sqlType: string, maxLength: number | null = null, ordinal = 1): CatalogColumn {
  return Object.freeze({
    name,
    type: INTEGER_SQL_TYPES.has(sqlType) ? 'i' : sqlType === 'datetime' ? 't' : 's',
    sqlType,
    nullable: true,
    maxLength,
    precision: null,
    numericScale: null,
    ordinal,
  });
}

/** Columns of a Masa-like table: `SiteID nvarchar(25)` and `ContentID char(35)` [core/setup/db/mssql.sql:3-8]. */
const TCONTENT: readonly CatalogColumn[] = [
  column('tcontent_ID', 'int', null, 1),
  column('SiteID', 'nvarchar', 25, 2),
  column('ContentID', 'char', 35, 3),
  column('UserID', 'char', 35, 4),
  column('LastUpdate', 'datetime', null, 5),
];

const SITE_ONLY: readonly CatalogColumn[] = [column('siteID', 'nvarchar', 25)];

const CF_ID = '9C2B3F6A-1D2E-4F5A-8B7C6D5E4F3A2B1C';

function values(count: number, prefix = 'v'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function bound(filter: ScopeFilter): Request['parameters'] {
  const request = new sql.Request();
  bindScope(request, filter);
  return request.parameters;
}

describe('buildScopeFilter', () => {
  it('filters one name on its catalog column with one parameter', () => {
    const filter = buildScopeFilter(SITE_ONLY, { siteid: ['tenant-a'] });

    expect(filter.kind).toBe('filtered');
    expect(filter.reason).toBeUndefined();
    expect(filter.whereSql).toBe(' WHERE ([siteID] IN (@p0))');
    expect(filter.params).toEqual([{ name: 'p0', column: SITE_ONLY[0], value: 'tenant-a' }]);
    expect(filter.terms).toEqual([{ name: 'siteid', column: SITE_ONLY[0], values: ['tenant-a'] }]);
    expect(Object.isFrozen(filter)).toBe(true);
    expect(Object.isFrozen(filter.params)).toBe(true);
  });

  it('combines names with OR and numbers parameters across terms', () => {
    const filter = buildScopeFilter(TCONTENT, { siteid: ['tenant-a', 'umbrella'], userid: [CF_ID], contentid: ['c1', 'c2'] });

    expect(filter.whereSql).toBe(
      ' WHERE ([SiteID] IN (@p0, @p1)) OR ([UserID] IN (@p2)) OR ([ContentID] IN (@p3, @p4))',
    );
    expect(filter.params.map((param) => [param.name, param.column.name, param.value])).toEqual([
      ['p0', 'SiteID', 'tenant-a'],
      ['p1', 'SiteID', 'umbrella'],
      ['p2', 'UserID', CF_ID],
      ['p3', 'ContentID', 'c1'],
      ['p4', 'ContentID', 'c2'],
    ]);
    expect(filter.terms.map((term) => term.name)).toEqual(['siteid', 'userid', 'contentid']);
  });

  it('merges names bound to the same column and de-duplicates values in first-seen order', () => {
    const filter = buildScopeFilter(TCONTENT, { siteid: ['b', 'a', 'b'], SiteID: ['a', 'c'] });

    expect(filter.terms).toEqual([{ name: 'siteid', column: TCONTENT[1], values: ['b', 'a', 'c'] }]);
    expect(filter.whereSql).toBe(' WHERE ([SiteID] IN (@p0, @p1, @p2))');
    expect(filter.params.map((param) => param.value)).toEqual(['b', 'a', 'c']);
  });

  it.each<[string, ExtractScope | undefined, ScopeFilter['reason'], readonly string[] | undefined]>([
    ['no scope', undefined, 'no-scope', undefined],
    ['an empty scope object', {}, 'no-scope', undefined],
    ['the table scope', 'table', 'table-scope', undefined],
    ['an unbound name', { userid: [CF_ID], groupid: ['g1'], moduleid: ['m1'] }, 'unbound-name', ['groupid', 'moduleid']],
    ['an unbound name beside an empty list', { siteid: [], groupid: ['g1'] }, 'unbound-name', ['groupid']],
    ['an empty value list', { siteid: ['tenant-a'], userid: [] }, 'empty-values', undefined],
    ['more distinct values than parameters', { siteid: values(MAX_SCOPE_PARAMETERS + 1) }, 'too-many-values', undefined],
    ['too many values across terms', { siteid: values(1000), userid: values(1001) }, 'too-many-values', undefined],
  ])('reads the whole table for %s', (_label, scope, reason, unboundNames) => {
    const filter = buildScopeFilter(TCONTENT, scope);

    expect(filter).toEqual({
      kind: 'table',
      reason,
      ...(unboundNames === undefined ? {} : { unboundNames }),
      terms: [],
      whereSql: '',
      params: [],
    });
    expect(bound(filter)).toEqual({});
  });

  it('accepts exactly the parameter limit, counting distinct values only', () => {
    const filter = buildScopeFilter(TCONTENT, { siteid: [...values(MAX_SCOPE_PARAMETERS), 'v0', 'v1'] });

    expect(filter.kind).toBe('filtered');
    expect(filter.params).toHaveLength(MAX_SCOPE_PARAMETERS);
    expect(filter.params.at(-1)?.name).toBe(`p${MAX_SCOPE_PARAMETERS - 1}`);
  });

  it('keeps values out of the SQL text and quotes column identifiers', () => {
    const hostile = "x'] OR 1=1; DROP TABLE [tusers] --";
    const columns = [column('odd]name', 'nvarchar', 50)];
    const filter = buildScopeFilter(columns, { 'ODD]NAME': [hostile, 'a]b'] });

    expect(filter.whereSql).toBe(' WHERE ([odd]]name] IN (@p0, @p1))');
    expect(filter.whereSql).not.toContain("'");
    expect(filter.params.map((param) => param.value)).toEqual([hostile, 'a]b']);
  });
});

describe('bindScope', () => {
  const MAX_COLUMNS: readonly CatalogColumn[] = [
    column('Notes', 'varchar', -1),
    column('Body', 'nvarchar', -1),
    column('Code', 'varchar', 50),
    column('Flag', 'nchar', 10),
    column('Guid', 'uniqueidentifier'),
    column('Small', 'smallint'),
    column('Tiny', 'tinyint'),
    column('Big', 'bigint'),
    column('Active', 'bit'),
  ];

  it.each<[string, readonly CatalogColumn[], string, ScopeValue, ISqlTypeFactory, number | undefined, unknown]>([
    ['char(35) id', TCONTENT, 'ContentID', CF_ID, sql.Char, 35, CF_ID],
    ['char value longer than the column', TCONTENT, 'ContentID', `${CF_ID}     `, sql.VarChar, sql.MAX, `${CF_ID}     `],
    ['nvarchar(25) site id', TCONTENT, 'SiteID', 'tenant-a', sql.NVarChar, 25, 'tenant-a'],
    ['nvarchar number value', TCONTENT, 'SiteID', 7, sql.NVarChar, 25, '7'],
    ['nvarchar value longer than the column', TCONTENT, 'SiteID', 'x'.repeat(26), sql.NVarChar, sql.MAX, 'x'.repeat(26)],
    ['varchar(max)', MAX_COLUMNS, 'Notes', 'n', sql.VarChar, sql.MAX, 'n'],
    ['nvarchar(max)', MAX_COLUMNS, 'Body', 'b', sql.NVarChar, sql.MAX, 'b'],
    ['varchar(50)', MAX_COLUMNS, 'Code', 'c', sql.VarChar, 50, 'c'],
    ['varchar multi-byte value over the byte length', MAX_COLUMNS, 'Code', 'é'.repeat(26), sql.VarChar, sql.MAX, 'é'.repeat(26)],
    ['nchar(10)', MAX_COLUMNS, 'Flag', 'f', sql.NChar, 10, 'f'],
    ['uniqueidentifier', MAX_COLUMNS, 'Guid', '0e984725-c51c-4bf4-9960-e1c80e27aba0', sql.UniqueIdentifier, undefined, '0e984725-c51c-4bf4-9960-e1c80e27aba0'],
    ['int from digit text', TCONTENT, 'tcontent_ID', ' 42 ', sql.Int, undefined, 42],
    ['smallint', MAX_COLUMNS, 'Small', 3, sql.SmallInt, undefined, 3],
    ['tinyint', MAX_COLUMNS, 'Tiny', '+7', sql.TinyInt, undefined, 7],
    ['bigint beyond double precision', MAX_COLUMNS, 'Big', '9007199254740993', sql.BigInt, undefined, '9007199254740993'],
    ['bit', MAX_COLUMNS, 'Active', '0', sql.Bit, undefined, 0],
    ['non-integer text on an int column', TCONTENT, 'tcontent_ID', 'abc', sql.NVarChar, undefined, 'abc'],
    ['fractional number on an int column', TCONTENT, 'tcontent_ID', 1.5, sql.Float, undefined, 1.5],
    ['datetime, typed by mssql', TCONTENT, 'LastUpdate', '2026-06-30', sql.NVarChar, undefined, '2026-06-30'],
  ])('binds %s', (_label, columns, name, value, type, length, boundValue) => {
    const parameters = bound(buildScopeFilter(columns, { [name]: [value] }));

    expect(Object.keys(parameters)).toEqual(['p0']);
    expect(parameters.p0?.type).toBe(type);
    expect(parameters.p0?.length).toBe(length);
    expect(parameters.p0?.value).toEqual(boundValue);
  });

  it('binds every parameter of every term under its own name', () => {
    const parameters = bound(buildScopeFilter(TCONTENT, { siteid: ['tenant-a', 'tenant-b'], contentid: [CF_ID] }));

    expect(Object.keys(parameters)).toEqual(['p0', 'p1', 'p2']);
    expect([parameters.p0?.value, parameters.p1?.value, parameters.p2?.value]).toEqual(['tenant-a', 'tenant-b', CF_ID]);
    expect(parameters.p2?.type).toBe(sql.Char);
  });
});

describe('rowInScope', () => {
  const siteFilter = buildScopeFilter(SITE_ONLY, { siteid: ['tenant-a'] });

  it('accepts every row of a whole-table filter', () => {
    expect(rowInScope(buildScopeFilter(SITE_ONLY, 'table'), {})).toBe(true);
    expect(rowInScope(buildScopeFilter(SITE_ONLY, undefined), { siteID: null })).toBe(true);
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['the same value', { siteID: 'tenant-a' }, true],
    ['different case and trailing spaces', { siteID: 'Tenant-A  ' }, true],
    ['a key in other case', { SITEID: 'TENANT-A' }, true],
    ['a longer value', { siteID: 'tenant-ab' }, false],
    ['leading spaces', { siteID: ' tenant-a' }, false],
    ['a trailing tab', { siteID: 'tenant-a\t' }, false],
    ['null', { siteID: null }, false],
    ['undefined', { siteID: undefined }, false],
    ['a missing column', { other: 'tenant-a' }, false],
    ['a buffer', { siteID: Buffer.from('tenant-a') }, false],
  ])('matches a text column against %s: %s', (_label, row, expected) => {
    expect(rowInScope(siteFilter, row)).toBe(expected);
  });

  it('prefers the catalog spelling over another key differing only in case', () => {
    expect(rowInScope(siteFilter, { siteid: 'tenant-a', siteID: 'other' })).toBe(false);
  });

  it('matches scope values with trailing spaces or numbers on text columns', () => {
    expect(rowInScope(buildScopeFilter(SITE_ONLY, { siteid: ['TENANT-A   '] }), { siteID: 'tenant-a' })).toBe(true);
    expect(rowInScope(buildScopeFilter(SITE_ONLY, { siteid: [5] }), { siteID: '5 ' })).toBe(true);
    expect(rowInScope(buildScopeFilter(SITE_ONLY, { siteid: ['5'] }), { siteID: 5 })).toBe(true);
  });

  it('keeps char(35) padding equal to the unpadded id', () => {
    const filter = buildScopeFilter(TCONTENT, { contentid: [CF_ID.toLowerCase()] });

    expect(rowInScope(filter, { ContentID: `${CF_ID} ` })).toBe(true);
  });

  it.each<[string, ScopeValue, unknown, boolean]>([
    ['digit text against a number', '42', 42, true],
    ['a number against canonical text', 42, '42', true],
    ['signed padded text against a bigint', ' +42 ', 42n, true],
    ['a fractional row value', 42, '42.0', false],
    ['a fractional scope value', 1.5, 1, false],
    ['non-numeric scope text', 'abc', 0, false],
    ['null', 0, null, false],
    ['an empty string', 0, '', false],
  ])('compares integer columns numerically: %s', (_label, value, rowValue, expected) => {
    const filter = buildScopeFilter(TCONTENT, { tcontent_id: [value] });

    expect(rowInScope(filter, { tcontent_ID: rowValue })).toBe(expected);
  });

  it('compares bigint ids exactly and bit columns as 0 and 1', () => {
    const big = buildScopeFilter([column('Big', 'bigint')], { big: ['9007199254740993'] });
    const bit = buildScopeFilter([column('Active', 'bit')], { active: [1] });

    expect(rowInScope(big, { Big: '9007199254740993' })).toBe(true);
    expect(rowInScope(big, { Big: '9007199254740992' })).toBe(false);
    expect(rowInScope(bit, { Active: true })).toBe(true);
    expect(rowInScope(bit, { Active: false })).toBe(false);
  });

  it('accepts a row matching any term, as the OR predicate does', () => {
    const filter = buildScopeFilter(TCONTENT, { siteid: ['tenant-a'], userid: [CF_ID] });

    expect(rowInScope(filter, { SiteID: 'tenant-b', UserID: CF_ID })).toBe(true);
    expect(rowInScope(filter, { SiteID: 'tenant-a', UserID: null })).toBe(true);
    expect(rowInScope(filter, { SiteID: 'tenant-b', UserID: null })).toBe(false);
  });
});
