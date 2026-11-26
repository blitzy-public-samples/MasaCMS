/** Row filter of a write window's legacy read: the writers' keyScope names bound to one table's columns. */
import sql from 'mssql';
import type { ISqlType, Request } from 'mssql';

import { quoteIdent } from '../legacy/legacy-db.js';
import { findColumn, type CatalogColumn } from './catalog.js';

/** One keyScope value, such as a site id, a CF UUID or an integer id. */
export type ScopeValue = string | number;

/** keyScope names with the values that bound the writers' rows, or `table` when no bound is derivable. */
export type ExtractScope = 'table' | Readonly<Record<string, readonly ScopeValue[]>>;

/** One column of the filter; `name` is the first scope name bound to it, `values` are de-duplicated in first-seen order. */
export interface ScopeTerm {
  readonly name: string;
  readonly column: CatalogColumn;
  readonly values: readonly ScopeValue[];
}

/** One bound parameter; `name` is `p0`, `p1`, … numbered across all terms. */
export interface ScopeParam {
  readonly name: string;
  readonly column: CatalogColumn;
  readonly value: ScopeValue;
}

/**
 * Filter of one table's rows. `table` reads the whole table, with `whereSql` `''`; `filtered` has `whereSql`
 * ` WHERE (<term>) OR (<term>) …`, starting with one space so it appends directly after the FROM clause.
 */
export interface ScopeFilter {
  readonly kind: 'table' | 'filtered';
  readonly reason?: 'no-scope' | 'table-scope' | 'unbound-name' | 'empty-values' | 'too-many-values';
  readonly unboundNames?: readonly string[];
  readonly terms: readonly ScopeTerm[];
  readonly whereSql: string;
  readonly params: readonly ScopeParam[];
}

/** Most parameters one filter binds; SQL Server accepts 2,100 per request and extraction binds no others. */
export const MAX_SCOPE_PARAMETERS = 2000;

type WholeTableReason = NonNullable<ScopeFilter['reason']>;

const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;

const INTEGER_TYPES: ReadonlyMap<string, () => ISqlType> = new Map([
  ['int', sql.Int],
  ['smallint', sql.SmallInt],
  ['tinyint', sql.TinyInt],
  ['bigint', sql.BigInt],
  ['bit', sql.Bit],
]);

function wholeTable(reason: WholeTableReason, unboundNames?: readonly string[]): ScopeFilter {
  return Object.freeze({
    kind: 'table',
    reason,
    ...(unboundNames === undefined ? {} : { unboundNames: Object.freeze([...unboundNames]) }),
    terms: Object.freeze([]),
    whereSql: '',
    params: Object.freeze([]),
  });
}

/** Builds the filter for `scope` over a table with `columns`; any scope that cannot narrow every writer reads the whole table. */
export function buildScopeFilter(columns: readonly CatalogColumn[], scope: ExtractScope | undefined): ScopeFilter {
  if (scope === undefined) return wholeTable('no-scope');
  if (scope === 'table') return wholeTable('table-scope');
  const entries = Object.entries(scope);
  // A scope naming no column bounds no writer, so it reads like no scope rather than an empty WHERE.
  if (entries.length === 0) return wholeTable('no-scope');

  const bound: { name: string; column: CatalogColumn; values: readonly ScopeValue[] }[] = [];
  const unboundNames: string[] = [];
  for (const [name, values] of entries) {
    const column = findColumn(columns, name);
    if (column === undefined) unboundNames.push(name);
    else bound.push({ name, column, values });
  }
  // A writer bounded only by an unbound name may have touched any row of this table.
  if (unboundNames.length > 0) return wholeTable('unbound-name', unboundNames);
  if (bound.some((entry) => entry.values.length === 0)) return wholeTable('empty-values');

  const merged = new Map<string, { name: string; column: CatalogColumn; values: Set<ScopeValue> }>();
  for (const { name, column, values } of bound) {
    let term = merged.get(column.name);
    if (term === undefined) {
      term = { name, column, values: new Set() };
      merged.set(column.name, term);
    }
    for (const value of values) term.values.add(value);
  }
  let count = 0;
  for (const term of merged.values()) count += term.values.size;
  if (count > MAX_SCOPE_PARAMETERS) return wholeTable('too-many-values');

  const terms: ScopeTerm[] = [];
  const params: ScopeParam[] = [];
  const predicates: string[] = [];
  for (const { name, column, values } of merged.values()) {
    const placeholders: string[] = [];
    for (const value of values) {
      const param = Object.freeze({ name: `p${params.length}`, column, value });
      params.push(param);
      placeholders.push(`@${param.name}`);
    }
    terms.push(Object.freeze({ name, column, values: Object.freeze([...values]) }));
    predicates.push(`(${quoteIdent(column.name)} IN (${placeholders.join(', ')}))`);
  }
  // OR, not AND: the scope is the union of several writers' keyScopes, and a touched row satisfies only its own writer's names.
  return Object.freeze({
    kind: 'filtered',
    terms: Object.freeze(terms),
    whereSql: ` WHERE ${predicates.join(' OR ')}`,
    params: Object.freeze(params),
  });
}

/** Exact integer of a row or scope value, or undefined when it has none. */
function toInteger(value: unknown): bigint | undefined {
  switch (typeof value) {
    case 'bigint':
      return value;
    case 'boolean':
      return value ? 1n : 0n;
    case 'number':
      return Number.isInteger(value) ? BigInt(value) : undefined;
    case 'string':
      return INTEGER_TEXT.test(value) ? BigInt(value) : undefined;
    default:
      return undefined;
  }
}

/** Parameter type matching the column, so SQL Server compares without converting the column; undefined lets mssql infer. */
function typedParameter(column: CatalogColumn, value: ScopeValue): { type: ISqlType; value: string | number } | undefined {
  const declared = column.maxLength ?? -1;
  switch (column.sqlType) {
    case 'char':
    case 'varchar': {
      const text = String(value);
      // A longer value can still match through ignored trailing spaces, so it widens instead of truncating to the column.
      if (declared < 0 || Buffer.byteLength(text) > declared) return { type: sql.VarChar(sql.MAX), value: text };
      return { type: column.sqlType === 'char' ? sql.Char(declared) : sql.VarChar(declared), value: text };
    }
    case 'nchar':
    case 'nvarchar': {
      const text = String(value);
      if (declared < 0 || text.length > declared) return { type: sql.NVarChar(sql.MAX), value: text };
      return { type: column.sqlType === 'nchar' ? sql.NChar(declared) : sql.NVarChar(declared), value: text };
    }
    case 'uniqueidentifier':
      return { type: sql.UniqueIdentifier(), value: String(value) };
    default: {
      const factory = INTEGER_TYPES.get(column.sqlType);
      const integer = factory === undefined ? undefined : toInteger(value);
      if (factory === undefined || integer === undefined) return undefined;
      return { type: factory(), value: column.sqlType === 'bigint' ? integer.toString() : Number(integer) };
    }
  }
}

/** Binds every parameter of `filter` on `request`, typed after its column. */
export function bindScope(request: Pick<Request, 'input'>, filter: ScopeFilter): void {
  for (const param of filter.params) {
    const typed = typedParameter(param.column, param.value);
    if (typed === undefined) request.input(param.name, param.value);
    else request.input(param.name, typed.type, typed.value);
  }
}

/** Drops trailing U+0020 only, as SQL Server's padded comparison does. */
function unpadded(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end -= 1;
  return text.slice(0, end);
}

/** Comparison key of a value in `column`: exact integer text for integer columns, else unpadded lower-case text. */
function matchKey(column: CatalogColumn, value: unknown): string | undefined {
  if (column.type === 'i') return toInteger(value)?.toString();
  if (typeof value === 'string') return unpadded(value).toLowerCase();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value).toLowerCase();
  return undefined;
}

const termKeys = new WeakMap<ScopeTerm, ReadonlySet<string>>();

function keysOf(term: ScopeTerm): ReadonlySet<string> {
  let keys = termKeys.get(term);
  if (keys === undefined) {
    keys = new Set(term.values.flatMap((value) => matchKey(term.column, value) ?? []));
    termKeys.set(term, keys);
  }
  return keys;
}

function columnValue(row: Readonly<Record<string, unknown>>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name];
  const lower = name.toLowerCase();
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : row[key];
}

/** Whether `row` (column name → value) satisfies `filter`, mirroring `whereSql` under a case-insensitive collation. */
export function rowInScope(filter: ScopeFilter, row: Readonly<Record<string, unknown>>): boolean {
  if (filter.kind === 'table') return true;
  return filter.terms.some((term) => {
    const key = matchKey(term.column, columnValue(row, term.column.name));
    return key !== undefined && keysOf(term).has(key);
  });
}
