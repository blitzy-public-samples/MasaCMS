// In-memory SQL Server behind the LegacyDb port for migration suites: a T-SQL subset interpreter over an in-memory
// catalog that runs the statements the migration package issues and throws UnsupportedStatementError for anything else.
// Statement shapes are open-ended (apply-legacy, stream and window imports build SQL per table), so the fake parses the
// grammar those builders emit rather than matching fixed texts; unmodelled grammar, functions or types fail loudly.
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ConnectionPool, Transaction } from 'mssql';

import { canonicalTypeForSqlServer, encodeRow, roundToSqlServerDatetime } from '@opt2/platform/migration-kit';
import type { CanonicalColumn } from '@opt2/platform/migration-kit';

import { clearCatalogCache } from '../../src/extract/catalog.js';
import { MASTER_DATABASE } from '../../src/legacy/legacy-db.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';

/** SQL Server column types a fake table may declare. */
export type LegacyColumnType =
  | 'char'
  | 'nchar'
  | 'varchar'
  | 'nvarchar'
  | 'text'
  | 'ntext'
  | 'int'
  | 'smallint'
  | 'tinyint'
  | 'bigint'
  | 'bit'
  | 'float'
  | 'decimal'
  | 'numeric'
  | 'money'
  | 'datetime'
  | 'smalldatetime'
  | 'datetime2'
  | 'varbinary'
  | 'image'
  | 'uniqueidentifier';

/** One column of a fake table; `nullable` defaults to true and character and binary lengths to 1, as in T-SQL DDL. */
export interface LegacyColumnDef {
  name: string;
  type: LegacyColumnType;
  /** Characters (bytes for varbinary), or `max`. */
  length?: number | 'max';
  /** decimal/numeric precision; defaults to 18. */
  precision?: number;
  /** decimal/numeric scale (default 0), or datetime2 fractional digits (default 7). */
  scale?: number;
  nullable?: boolean;
  /** Value an INSERT that omits the column stores. */
  default?: unknown;
}

/** Key, identity column and database of a fake table; a table without `primaryKey` is a heap. */
export interface LegacyTableOptions {
  primaryKey?: string[];
  identity?: string;
  /** Database holding the table; defaults to the live database. */
  database?: string;
}

/** A row keyed by column name, valued as the mssql driver returns it (or as a suite seeds it). */
export type Row = Record<string, unknown>;

/** Initial state of a fake server. */
export interface FakeLegacyDbSeed {
  /** Live database name; defaults to `masa_test`. */
  database?: string;
  /** Server default data and log directory (SERVERPROPERTY, sys.master_files); defaults to `/var/opt/mssql/data/`. */
  dataPath?: string;
  tables?: Array<{ qualified: string; columns: LegacyColumnDef[]; options?: LegacyTableOptions }>;
  /** Rows per table name, seeded into the live database after the tables are defined. */
  rows?: Record<string, Row[]>;
}

/** One request sent to the fake, as the client sent it; `txId` is null outside explicit transactions. */
export interface StatementRecord {
  database: string;
  sql: string;
  params: Record<string, unknown>;
  txId: number | null;
  at: number;
}

/** One committed explicit transaction and the statements it ran. */
export interface CommitRecord {
  txId: number;
  database: string;
  statements: StatementRecord[];
}

/** Raised for a statement, function, type or value the fake does not model. */
export class UnsupportedStatementError extends Error {
  override readonly name = 'UnsupportedStatementError';
  readonly sql: string;
  readonly params: Record<string, unknown>;

  constructor(sql: string, params: Record<string, unknown> = {}, detail = 'this statement') {
    super(`The fake legacy database does not model ${detail}: ${sql}`);
    this.sql = sql;
    this.params = params;
  }
}

/** Raised in place of a statement that `crashAt` matched; the statement does not run. */
export class CrashInjectedError extends Error {
  override readonly name = 'CrashInjectedError';
  readonly statement: StatementRecord;

  constructor(statement: StatementRecord) {
    super(`Crash injected before: ${statement.sql}`);
    this.statement = statement;
  }
}

/** SQL Server error details as tedious reports them. */
export interface SqlErrorInfo {
  number: number;
  message: string;
  state: number;
  class: number;
  lineNumber: number;
  serverName: string;
  procName: string;
}

/** The mssql `RequestError` a SQL Server error surfaces as. */
export interface SqlRequestError extends Error {
  name: 'RequestError';
  code: 'EREQUEST';
  number: number;
  state: number;
  class: number;
  lineNumber: number;
  serverName: string;
  procName: string;
  originalError: Error & { info: SqlErrorInfo };
}

/** The mssql `ConnectionError` a lost connection surfaces as. */
export interface SqlConnectionError extends Error {
  name: 'ConnectionError';
  code: string;
}

const SERVER_NAME = 'fake-legacy-db';

const DEFAULT_MESSAGES: ReadonlyMap<number, string> = new Map([
  [229, 'The SELECT permission was denied on the object.'],
  [262, 'CREATE SCHEMA permission denied in database.'],
  [515, 'Cannot insert the value NULL into a column that does not allow nulls.'],
  [544, 'Cannot insert explicit value for identity column in table when IDENTITY_INSERT is set to OFF.'],
  [1205, 'Transaction was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.'],
  [2627, 'Violation of PRIMARY KEY constraint. Cannot insert duplicate key in object.'],
  [2714, 'There is already an object with that name in the database.'],
  [3906, 'Failed to update database because the database is read-only.'],
]);

/** An mssql `RequestError` for SQL Server error `number`, shaped as the driver builds it from a server error token. */
export function sqlError(number: number, message?: string): SqlRequestError {
  const text = message ?? DEFAULT_MESSAGES.get(number) ?? `SQL Server error ${String(number)}`;
  const info: SqlErrorInfo = { number, message: text, state: 1, class: 16, lineNumber: 1, serverName: SERVER_NAME, procName: '' };
  const originalError = Object.assign(new Error(text), { info });
  const error = new Error(text) as SqlRequestError;
  return Object.assign(error, {
    name: 'RequestError' as const,
    code: 'EREQUEST' as const,
    number,
    state: info.state,
    class: info.class,
    lineNumber: info.lineNumber,
    serverName: info.serverName,
    procName: info.procName,
    originalError,
  });
}

/** An mssql `ConnectionError` for a connection reset mid-request. */
export function connectionLost(message = 'Connection lost - read ECONNRESET'): SqlConnectionError {
  return Object.assign(new Error(message), { name: 'ConnectionError' as const, code: 'ECONNRESET' });
}

/** The LegacyDb port over one in-memory server, with seeding, inspection and fault injection for suites. */
export interface FakeLegacyDb extends LegacyDb {
  /** Creates a table (and its schema when missing); `qualified` is `t`, `schema.t` or `[db].[schema].[t]`. */
  defineTable(qualified: string, columns: readonly LegacyColumnDef[], options?: LegacyTableOptions): void;
  /** Inserts rows straight into committed state, bypassing the statement log; identity values given are kept. */
  seed(table: string, rows: readonly Row[], options?: { database?: string }): void;
  /** Committed rows as the driver returns them: keyed tables in key order, heaps in insertion order. */
  rows(table: string, options?: { database?: string }): Row[];
  /** Committed rows as canonical whole-row encodings (catalog order) with their occurrence counts. */
  multiset(table: string, options?: { database?: string }): Map<string, number>;
  /** Every request sent, in order, including ones a fault replaced. */
  readonly statements: StatementRecord[];
  /** Every committed explicit transaction, in commit order. */
  readonly commits: CommitRecord[];
  /** Throws CrashInjectedError in place of the next matching statement, or of every one when `once` is false. */
  crashAt(predicate: (statement: StatementRecord) => boolean, options?: { once?: boolean }): void;
  /** Fails the next matching statement with `error` (a `sqlError` surfaces through the driver with its number). */
  failNext(predicate: (statement: StatementRecord) => boolean, error: unknown): void;
  /** Names of every database on the server, master and msdb included, sorted. */
  databases(): string[];
  /** Empties `statements` and `commits` in place. */
  clearLogs(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Types and values

type Collation = 'ci' | 'cs' | 'bin';
type Family = 'char' | 'int' | 'exact' | 'float' | 'date' | 'binary' | 'uuid';

interface SqlType {
  readonly base: LegacyColumnType;
  readonly length?: number | 'max';
  readonly precision?: number;
  readonly scale?: number;
}

/**
 * A stored value: text for character types and uniqueidentifier (upper case), number for the int types, bit (0/1) and
 * float, bigint for bigint, fixed-scale text for decimal and money, local Date for date types, Buffer for binary.
 */
type Stored = string | number | bigint | Date | Buffer | null;

/** A typed value; `collation` is set by an explicit COLLATE. */
interface TV {
  readonly type: SqlType;
  readonly v: Stored;
  readonly collation?: Collation;
}

/** A SQL Server error raised by a statement. */
class SqlFault extends Error {
  readonly number: number;

  constructor(number: number, message: string) {
    super(message);
    this.number = number;
  }
}

/** Grammar, function, type or value outside the model; surfaces as UnsupportedStatementError. */
class Unmodelled extends Error {}

/** A `failNext` error, handed to the client unchanged. */
class InjectedFailure {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }
}

/** A statement sent on a session the server has killed. */
class SessionKilled extends Error {}

const FAMILY: Readonly<Record<LegacyColumnType, Family>> = {
  char: 'char',
  nchar: 'char',
  varchar: 'char',
  nvarchar: 'char',
  text: 'char',
  ntext: 'char',
  int: 'int',
  smallint: 'int',
  tinyint: 'int',
  bigint: 'int',
  bit: 'int',
  float: 'float',
  decimal: 'exact',
  numeric: 'exact',
  money: 'exact',
  datetime: 'date',
  smalldatetime: 'date',
  datetime2: 'date',
  varbinary: 'binary',
  image: 'binary',
  uniqueidentifier: 'uuid',
};

// SQL Server data type precedence: the operand of lower precedence converts to the type of higher precedence.
const PRECEDENCE: Readonly<Record<LegacyColumnType, number>> = {
  datetime2: 24,
  datetime: 23,
  smalldatetime: 22,
  float: 20,
  decimal: 18,
  numeric: 18,
  money: 17,
  bigint: 15,
  int: 14,
  smallint: 13,
  tinyint: 12,
  bit: 11,
  ntext: 10,
  text: 9,
  image: 8,
  uniqueidentifier: 7,
  nvarchar: 6,
  nchar: 5,
  varchar: 4,
  char: 3,
  varbinary: 2,
};

const LOB_TYPES: ReadonlySet<LegacyColumnType> = new Set(['text', 'ntext', 'image']);
const UNICODE_TYPES: ReadonlySet<LegacyColumnType> = new Set(['nchar', 'nvarchar', 'ntext']);
const FIXED_TYPES: ReadonlySet<LegacyColumnType> = new Set(['char', 'nchar']);
const LENGTH_TYPES: ReadonlySet<LegacyColumnType> = new Set(['char', 'nchar', 'varchar', 'nvarchar', 'varbinary']);
const INT_RANGE: Readonly<Partial<Record<LegacyColumnType, readonly [bigint, bigint]>>> = {
  tinyint: [0n, 255n],
  smallint: [-32768n, 32767n],
  int: [-2147483648n, 2147483647n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n],
};

const INT: SqlType = { base: 'int' };
const BIGINT: SqlType = { base: 'bigint' };
const BIT: SqlType = { base: 'bit' };
const TINYINT: SqlType = { base: 'tinyint' };
const SMALLINT: SqlType = { base: 'smallint' };
const DATETIME: SqlType = { base: 'datetime' };
const SYSNAME: SqlType = { base: 'nvarchar', length: 128 };
const NVARCHAR_MAX: SqlType = { base: 'nvarchar', length: 'max' };

const INT_TEXT = /^\s*[+-]?\d+\s*$/;
const FLOAT_TEXT = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;
const DEC_TEXT = /^\s*([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))\s*$/;
const DATE_TEXT = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*$/;
const UUID_TEXT = /^\s*\{?([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}?\s*$/;

function familyOf(type: SqlType): Family {
  return FAMILY[type.base];
}

function typeName(type: SqlType): string {
  if (type.length !== undefined && LENGTH_TYPES.has(type.base)) return `${type.base}(${String(type.length)})`;
  if (type.base === 'decimal' || type.base === 'numeric') {
    return `${type.base}(${String(type.precision ?? 18)},${String(type.scale ?? 0)})`;
  }
  return type.base;
}

function tv(type: SqlType, v: Stored): TV {
  return { type, v };
}

/** Drops trailing U+0020, as SQL Server's padded comparison does under every collation. */
function rtrim(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

function collationOf(name: string): Collation {
  if (/_BIN2?$/i.test(name)) return 'bin';
  return /_CS(?:_|$)/i.test(name) ? 'cs' : 'ci';
}

/** Exact decimal: `digits` / 10^`scale`, negated when `neg`. */
interface Dec {
  readonly neg: boolean;
  readonly digits: bigint;
  readonly scale: number;
}

function parseDec(text: string): Dec | null {
  const m = DEC_TEXT.exec(text);
  if (m === null) return null;
  const whole = m[2] ?? '';
  const fraction = m[3] ?? m[4] ?? '';
  return { neg: m[1] === '-', digits: BigInt(`${whole}${fraction}` || '0'), scale: fraction.length };
}

function decOfInt(value: bigint): Dec {
  return { neg: value < 0n, digits: value < 0n ? -value : value, scale: 0 };
}

/** Magnitude of `d` at `scale` digits, rounded half away from zero as SQL Server converts. */
function rescale(d: Dec, scale: number): bigint {
  if (scale >= d.scale) return d.digits * 10n ** BigInt(scale - d.scale);
  const divisor = 10n ** BigInt(d.scale - scale);
  const quotient = d.digits / divisor;
  return (d.digits % divisor) * 2n >= divisor ? quotient + 1n : quotient;
}

function decText(d: Dec, scale: number): string {
  const magnitude = rescale(d, scale);
  const padded = magnitude.toString().padStart(scale + 1, '0');
  const body = scale === 0 ? padded : `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
  return d.neg && magnitude !== 0n ? `-${body}` : body;
}

function decSigned(d: Dec, scale: number): bigint {
  const magnitude = d.digits * 10n ** BigInt(scale - d.scale);
  return d.neg ? -magnitude : magnitude;
}

function decCompare(a: Dec, b: Dec): number {
  const scale = Math.max(a.scale, b.scale);
  const x = decSigned(a, scale);
  const y = decSigned(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function decTruncate(d: Dec): bigint {
  const whole = d.digits / 10n ** BigInt(d.scale);
  return d.neg ? -whole : whole;
}

/** Canonical number text without trailing fractional zeros, so equal numbers of any type share one key. */
function decKey(d: Dec): string {
  const text = decText(d, d.scale);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Wall-clock components; `fraction` holds the fractional-second digits. */
interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
}

function wallOfText(text: string): WallParts | null {
  const m = DATE_TEXT.exec(text);
  if (m === null) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? '0'),
    minute: Number(m[5] ?? '0'),
    second: Number(m[6] ?? '0'),
    fraction: m[7] ?? '',
  };
}

function wallOfDate(date: Date): WallParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    fraction: String(date.getMilliseconds()).padStart(3, '0'),
  };
}

function localDate(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, ms);
  return date;
}

function validWall(p: WallParts): boolean {
  const date = localDate(p.year, p.month, p.day, 0, 0, 0, 0);
  return (
    date.getFullYear() === p.year &&
    date.getMonth() === p.month - 1 &&
    date.getDate() === p.day &&
    p.hour < 24 &&
    p.minute < 60 &&
    p.second < 60
  );
}

/** The value a date type stores: datetime rounded to 1/300 s, smalldatetime to the minute, datetime2 to its digits. */
function dateValue(p: WallParts, type: SqlType): Date {
  if (!validWall(p)) throw new SqlFault(241, 'Conversion failed when converting date and/or time from character string.');
  const fractionSeconds = Number(`0.${p.fraction || '0'}`);
  if (type.base === 'datetime') {
    if (p.year < 1753) {
      throw new SqlFault(242, 'The conversion of a varchar data type to a datetime data type resulted in an out-of-range value.');
    }
    const { year, month, day, hour, minute, second } = p;
    const r = roundToSqlServerDatetime({ year, month, day, hour, minute, second, fractionSeconds });
    return localDate(r.year, r.month, r.day, r.hour, r.minute, r.second, r.ms);
  }
  if (type.base === 'smalldatetime') {
    if (p.year < 1900 || p.year > 2079) {
      throw new SqlFault(242, 'The conversion of a varchar data type to a smalldatetime data type resulted in an out-of-range value.');
    }
    const start = localDate(p.year, p.month, p.day, p.hour, p.minute, 0, 0);
    return p.second + fractionSeconds >= 29.999 ? new Date(start.getTime() + 60_000) : start;
  }
  const unit = 10n ** BigInt(9 - (type.scale ?? 7));
  const nanos = BigInt(`${p.fraction}000000000`.slice(0, 9));
  const rounded = ((nanos + unit / 2n) / unit) * unit;
  return new Date(localDate(p.year, p.month, p.day, p.hour, p.minute, p.second, 0).getTime() + Number(rounded / 1_000_000n));
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatDate(date: Date, type: SqlType, style: number | undefined): string {
  const p = wallOfDate(date);
  const day = `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
  const time = `${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}`;
  switch (style) {
    case 120:
      return `${day} ${time}`;
    case 121:
      return `${day} ${time}.${p.fraction}`;
    case 126:
      return p.fraction === '000' && type.base !== 'datetime2' ? `${day}T${time}` : `${day}T${time}.${p.fraction}`;
    default:
      throw new Unmodelled(`CONVERT of ${type.base} to text with style ${String(style ?? 0)}`);
  }
}


interface ConvertOptions {
  readonly style?: number | undefined;
  /** Set for an assignment to a column: truncating anything but trailing spaces then raises error 2628. */
  readonly assign?: { readonly table: string; readonly column: string };
}

/** Converts `src` to `to` as CAST/CONVERT do, or as an assignment to a column when `opts.assign` is set. */
function convert(src: TV, to: SqlType, opts: ConvertOptions = {}): TV {
  if (src.v === null) return tv(to, null);
  switch (familyOf(to)) {
    case 'char':
      return tv(to, fitText(textOf(src, opts.style), to, opts));
    case 'uuid':
      return tv(to, uuidOf(src));
    case 'int':
      return tv(to, intOf(src, to));
    case 'exact':
      return tv(to, exactOf(src, to));
    case 'float':
      return tv(to, floatOf(src));
    case 'date':
      return tv(to, dateOf(src, to));
    case 'binary':
      return tv(to, fitBytes(bytesOf(src), to, opts));
  }
}

function textOf(src: TV, style?: number): string {
  const v = src.v;
  switch (familyOf(src.type)) {
    case 'char':
    case 'uuid':
      return v as string;
    case 'int':
      return String(v);
    case 'exact': {
      if (src.type.base !== 'money') return v as string;
      // CONVERT style 0 renders money with two decimals, style 2 with four.
      if (style === 2) return decText(parseDec(v as string) as Dec, 4);
      if (style === undefined || style === 0) return decText(parseDec(v as string) as Dec, 2);
      throw new Unmodelled(`CONVERT of money to text with style ${String(style)}`);
    }
    case 'date':
      return formatDate(v as Date, src.type, style);
    default:
      throw new Unmodelled(`conversion of ${src.type.base} to character data`);
  }
}

function truncationFault(target: { readonly table: string; readonly column: string }, kept: string): SqlFault {
  return new SqlFault(
    2628,
    `String or binary data would be truncated in table '${target.table}', column '${target.column}'. Truncated value: '${kept}'.`,
  );
}

function fitText(text: string, to: SqlType, opts: ConvertOptions): string {
  const limit = typeof to.length === 'number' ? to.length : undefined;
  let value = text;
  if (limit !== undefined && value.length > limit) {
    // Trailing spaces past the length are dropped silently; any other character fails an assignment.
    if (opts.assign !== undefined && rtrim(value).length > limit) throw truncationFault(opts.assign, value.slice(0, limit));
    value = value.slice(0, limit);
  }
  return limit !== undefined && FIXED_TYPES.has(to.base) ? value.padEnd(limit, ' ') : value;
}

function intOf(src: TV, to: SqlType): number | bigint {
  let n: bigint;
  switch (familyOf(src.type)) {
    case 'char': {
      const text = src.v as string;
      if (to.base === 'bit' && /^\s*(?:true|false)\s*$/i.test(text)) {
        n = /true/i.test(text) ? 1n : 0n;
        break;
      }
      if (!INT_TEXT.test(text)) {
        if (to.base === 'bigint') throw new SqlFault(8114, `Error converting data type ${src.type.base} to bigint.`);
        throw new SqlFault(245, `Conversion failed when converting the ${src.type.base} value '${text}' to data type ${to.base}.`);
      }
      n = BigInt(text.trim());
      break;
    }
    case 'int':
      n = BigInt(src.v as number | bigint);
      break;
    case 'exact':
      n = decTruncate(parseDec(src.v as string) as Dec);
      break;
    case 'float':
      n = BigInt(Math.trunc(src.v as number));
      break;
    case 'uuid':
      throw new SqlFault(529, `Explicit conversion from data type uniqueidentifier to ${to.base} is not allowed.`);
    default:
      throw new Unmodelled(`conversion of ${src.type.base} to ${to.base}`);
  }
  if (to.base === 'bit') return n === 0n ? 0 : 1;
  const [low, high] = INT_RANGE[to.base] as readonly [bigint, bigint];
  if (n < low || n > high) throw new SqlFault(8115, `Arithmetic overflow error converting expression to data type ${to.base}.`);
  return to.base === 'bigint' ? n : Number(n);
}

function exactOf(src: TV, to: SqlType): string {
  const money = to.base === 'money';
  const precision = money ? 19 : (to.precision ?? 18);
  const scale = money ? 4 : (to.scale ?? 0);
  let d: Dec | null;
  switch (familyOf(src.type)) {
    case 'char':
      d = parseDec(src.v as string);
      if (d === null) {
        throw money
          ? new SqlFault(235, 'Cannot convert a char value to money. The char value has incorrect syntax.')
          : new SqlFault(8114, `Error converting data type ${src.type.base} to numeric.`);
      }
      break;
    case 'int':
      d = decOfInt(BigInt(src.v as number | bigint));
      break;
    case 'exact':
      d = parseDec(src.v as string);
      break;
    case 'float': {
      const f = src.v as number;
      d = Math.abs(f) < 1e21 ? parseDec(f.toFixed(Math.min(100, scale + 6))) : null;
      break;
    }
    default:
      throw new Unmodelled(`conversion of ${src.type.base} to ${to.base}`);
  }
  if (d === null || rescale(d, scale) >= 10n ** BigInt(precision)) {
    throw new SqlFault(8115, `Arithmetic overflow error converting ${src.type.base} to data type numeric.`);
  }
  return decText(d, scale);
}

function floatOf(src: TV): number {
  switch (familyOf(src.type)) {
    case 'char': {
      const text = src.v as string;
      if (!FLOAT_TEXT.test(text)) throw new SqlFault(8114, `Error converting data type ${src.type.base} to float.`);
      return Number(text.trim());
    }
    case 'int':
    case 'exact':
    case 'float':
      return Number(src.v);
    default:
      throw new Unmodelled(`conversion of ${src.type.base} to float`);
  }
}

function dateOf(src: TV, to: SqlType): Date {
  switch (familyOf(src.type)) {
    case 'char': {
      const parts = wallOfText(src.v as string);
      if (parts === null) throw new SqlFault(241, 'Conversion failed when converting date and/or time from character string.');
      return dateValue(parts, to);
    }
    case 'date':
      return dateValue(wallOfDate(src.v as Date), to);
    default:
      throw new Unmodelled(`conversion of ${src.type.base} to ${to.base}`);
  }
}

function uuidOf(src: TV): string {
  const family = familyOf(src.type);
  if (family === 'uuid') return src.v as string;
  if (family !== 'char') {
    throw new SqlFault(529, `Explicit conversion from data type ${src.type.base} to uniqueidentifier is not allowed.`);
  }
  const m = UUID_TEXT.exec(src.v as string);
  if (m === null) throw new SqlFault(8169, 'Conversion failed when converting from a character string to uniqueidentifier.');
  return (m[1] as string).toUpperCase();
}

function bytesOf(src: TV): Buffer {
  const family = familyOf(src.type);
  if (family === 'binary') return Buffer.from(src.v as Buffer);
  if (family === 'char') return Buffer.from(src.v as string, UNICODE_TYPES.has(src.type.base) ? 'utf16le' : 'utf8');
  throw new Unmodelled(`conversion of ${src.type.base} to binary`);
}

function fitBytes(bytes: Buffer, to: SqlType, opts: ConvertOptions): Buffer {
  const limit = typeof to.length === 'number' ? to.length : undefined;
  if (limit === undefined || bytes.length <= limit) return bytes;
  if (opts.assign !== undefined) throw truncationFault(opts.assign, `0x${bytes.subarray(0, limit).toString('hex')}`);
  return bytes.subarray(0, limit);
}

/** A JavaScript value typed as the mssql driver infers it for an untyped parameter. */
function jsValue(value: unknown): TV {
  if (value === null || value === undefined) return tv(NVARCHAR_MAX, null);
  if (typeof value === 'string') return tv(NVARCHAR_MAX, value);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return tv(INT, value);
    if (!Number.isFinite(value)) throw new Unmodelled('a non-finite number parameter');
    return tv({ base: 'float' }, value);
  }
  if (typeof value === 'bigint') return tv(BIGINT, value);
  if (typeof value === 'boolean') return tv(BIT, value ? 1 : 0);
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Unmodelled('an invalid Date parameter');
    return tv({ base: 'datetime2', scale: 7 }, value);
  }
  if (value instanceof Uint8Array) return tv({ base: 'varbinary', length: 'max' }, Buffer.from(value));
  throw new Unmodelled(`a ${typeof value} parameter`);
}

const TYPE_SYNONYMS: Readonly<Record<string, LegacyColumnType>> = {
  real: 'float',
  smallmoney: 'money',
  xml: 'nvarchar',
  binary: 'varbinary',
  sysname: 'nvarchar',
};

function baseOf(name: string): LegacyColumnType {
  const lower = name.toLowerCase();
  const base = TYPE_SYNONYMS[lower] ?? lower;
  if (!Object.hasOwn(FAMILY, base)) throw new Unmodelled(`data type ${name}`);
  return base as LegacyColumnType;
}

/** The type of a bound parameter from its declaration name and size; mssql passes `max` as 65535. */
function paramType(declaration: string, length: unknown, precision: unknown, scale: unknown): SqlType {
  const base = baseOf(declaration);
  const size = typeof length === 'number' ? length : undefined;
  switch (base) {
    case 'char':
    case 'nchar':
      return size !== undefined && size <= 8000 ? { base, length: size } : { base };
    case 'varchar':
    case 'varbinary':
      return { base, length: size !== undefined && size <= 8000 ? size : 'max' };
    case 'nvarchar':
      return { base, length: size !== undefined && size <= 4000 ? size : 'max' };
    case 'decimal':
    case 'numeric':
      return { base, precision: typeof precision === 'number' ? precision : 18, scale: typeof scale === 'number' ? scale : 0 };
    case 'datetime2':
      return { base, scale: typeof scale === 'number' ? scale : 7 };
    default:
      return { base };
  }
}

/** A parameter value as the server receives it: converted to its declared type, or typed as mssql infers it. */
function paramValue(value: unknown, declared: SqlType | undefined): TV {
  const natural = jsValue(value);
  if (declared !== undefined) return convert(natural, declared);
  return natural.type.base === 'datetime2' ? convert(natural, DATETIME) : natural;
}

/** A value as mssql 12 returns it with `useUTC: false`: bit as boolean, bigint as text, decimals as numbers. */
function driverValue(value: TV): unknown {
  const v = value.v;
  if (v === null) return null;
  switch (value.type.base) {
    case 'bit':
      return v !== 0;
    case 'bigint':
      return String(v);
    case 'decimal':
    case 'numeric':
    case 'money':
      return Number(v);
    case 'datetime':
    case 'smalldatetime':
    case 'datetime2':
      return new Date((v as Date).getTime());
    case 'varbinary':
    case 'image':
      return Buffer.from(v as Buffer);
    default:
      return v;
  }
}

function sign(n: number): number {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

function compareText(a: string, b: string, collation: Collation): number {
  const x = collation === 'ci' ? rtrim(a).toLowerCase() : rtrim(a);
  const y = collation === 'ci' ? rtrim(b).toLowerCase() : rtrim(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Bytes compared as SQL Server compares binary values: the shorter one padded with zeros. */
function compareBytes(a: Buffer, b: Buffer): number {
  const length = Math.max(a.length, b.length);
  return Buffer.compare(Buffer.concat([a, Buffer.alloc(length - a.length)]), Buffer.concat([b, Buffer.alloc(length - b.length)]));
}

function decOf(value: TV, target: SqlType): Dec {
  switch (familyOf(value.type)) {
    case 'int':
      return decOfInt(BigInt(value.v as number | bigint));
    case 'exact':
      return parseDec(value.v as string) as Dec;
    case 'char':
      if (familyOf(target) === 'int') return decOfInt(BigInt(intOf(value, target)));
      return parseDec(exactOf(value, { base: 'decimal', precision: 38, scale: parseDec(value.v as string)?.scale ?? 0 })) as Dec;
    default:
      throw new Unmodelled(`comparison of ${value.type.base} with ${target.base}`);
  }
}

/**
 * Orders two values after converting the lower-precedence one, text under `collation` (default case-insensitive),
 * ignoring trailing spaces; null when either is NULL. `operator` names the operator in error 402, or is null in a sort.
 */
function compareTv(a: TV, b: TV, operator: string | null = 'equal to'): number | null {
  if (a.v === null || b.v === null) return null;
  if (LOB_TYPES.has(a.type.base) || LOB_TYPES.has(b.type.base)) {
    if (operator === null) {
      throw new SqlFault(306, 'The text, ntext, and image data types cannot be compared or sorted, except when using IS NULL or LIKE operator.');
    }
    throw new SqlFault(402, `The data types ${typeName(a.type)} and ${typeName(b.type)} are incompatible in the ${operator} operator.`);
  }
  const target = PRECEDENCE[a.type.base] >= PRECEDENCE[b.type.base] ? a.type : b.type;
  switch (familyOf(target)) {
    case 'char':
      return compareText(textOf(a), textOf(b), a.collation ?? b.collation ?? 'ci');
    case 'uuid': {
      const x = uuidOf(a);
      const y = uuidOf(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 'float':
      return sign(floatOf(a) - floatOf(b));
    case 'int':
    case 'exact':
      return decCompare(decOf(a, target), decOf(b, target));
    case 'date':
      return sign(dateOf(a, target).getTime() - dateOf(b, target).getTime());
    case 'binary':
      return compareBytes(bytesOf(a), bytesOf(b));
  }
}

/** Sort order: NULL first, then `compareTv`. */
function orderValues(a: TV, b: TV): number {
  if (a.v === null) return b.v === null ? 0 : -1;
  if (b.v === null) return 1;
  return compareTv(a, b, null) ?? 0;
}

/** Equality key under the default collation: equal keys for values `=` finds equal. */
function keyOf(type: SqlType, v: Stored): string {
  if (v === null) return 'N';
  switch (familyOf(type)) {
    case 'char':
      return `s${rtrim(v as string).toLowerCase()}`;
    case 'uuid':
      return `u${v as string}`;
    case 'int':
    case 'float':
      return `n${String(v)}`;
    case 'exact':
      return `n${decKey(parseDec(v as string) as Dec)}`;
    case 'date':
      return `t${String((v as Date).getTime())}`;
    case 'binary':
      return `b${(v as Buffer).toString('hex').replace(/(?:00)+$/, '')}`;
  }
}

/** Result type of CASE, COALESCE and set operations: the highest precedence, widened to the longest operand. */
function unionType(types: readonly SqlType[]): SqlType {
  let best = types[0] ?? INT;
  for (const type of types) if (PRECEDENCE[type.base] > PRECEDENCE[best.base]) best = type;
  const family = familyOf(best);
  if ((family === 'char' || family === 'binary') && !LOB_TYPES.has(best.base)) {
    let length: number | 'max' | undefined;
    for (const type of types) {
      if (familyOf(type) !== family) continue;
      if (type.length === 'max' || length === 'max') length = 'max';
      else if (type.length !== undefined) length = Math.max(length ?? 0, type.length);
    }
    return length === undefined ? { base: best.base } : { base: best.base, length };
  }
  if (family === 'exact' && best.base !== 'money') {
    const exact = types.filter((type) => familyOf(type) === 'exact');
    const scale = Math.max(...exact.map((type) => type.scale ?? 0));
    return { base: best.base, precision: Math.min(38, Math.max(...exact.map((type) => type.precision ?? 18))), scale };
  }
  return best;
}

const INT_BYTES: Readonly<Partial<Record<LegacyColumnType, number>>> = { tinyint: 1, smallint: 2, int: 4, bigint: 8, bit: 1 };

/** DATALENGTH: bytes of the value; bigint for max and large-object types, int otherwise. */
function dataLength(value: TV): TV {
  const big = value.type.length === 'max' || LOB_TYPES.has(value.type.base);
  const result = big ? BIGINT : INT;
  if (value.v === null) return tv(result, null);
  let bytes: number;
  switch (familyOf(value.type)) {
    case 'char':
      bytes = UNICODE_TYPES.has(value.type.base) ? (value.v as string).length * 2 : Buffer.byteLength(value.v as string, 'utf8');
      break;
    case 'binary':
      bytes = (value.v as Buffer).length;
      break;
    case 'uuid':
      bytes = 16;
      break;
    case 'int':
      bytes = INT_BYTES[value.type.base] ?? 4;
      break;
    case 'float':
      bytes = 8;
      break;
    case 'exact': {
      const precision = value.type.base === 'money' ? 19 : (value.type.precision ?? 18);
      bytes = value.type.base === 'money' ? 8 : precision <= 9 ? 5 : precision <= 19 ? 9 : precision <= 28 ? 13 : 17;
      break;
    }
    case 'date': {
      const digits = value.type.scale ?? 7;
      bytes = value.type.base === 'smalldatetime' ? 4 : value.type.base === 'datetime' ? 8 : digits <= 2 ? 6 : digits <= 4 ? 7 : 8;
      break;
    }
  }
  return tv(result, big ? BigInt(bytes) : bytes);
}


// ---------------------------------------------------------------------------------------------------------------------
// Storage

interface ColumnDef {
  readonly name: string;
  readonly type: SqlType;
  readonly nullable: boolean;
  readonly identity: boolean;
  /** Value of an omitted column, typed as written. */
  readonly defaultValue: (() => TV) | undefined;
}

interface TableDef {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  /** Column indexes of the primary key in key order; empty for a heap. */
  readonly primaryKey: readonly number[];
  readonly pkName: string | null;
  readonly identityColumn: number | null;
  readonly objectId: number;
  readonly createDate: Date;
  readonly modifyDate: Date;
}

interface StoredRow {
  readonly rid: number;
  readonly values: readonly Stored[];
}

/** Rows of a table version; `index` maps primary-key keys to rows, `sorted` caches key order. */
interface RowSet {
  rows: StoredRow[];
  index: Map<string, StoredRow> | null;
  sorted: StoredRow[] | null;
}

interface IdentityState {
  readonly seed: number;
  readonly increment: number;
  current: number | null;
}

interface Table {
  readonly def: TableDef;
  data: RowSet;
  readonly identity: IdentityState | null;
}

interface SchemaDef {
  readonly name: string;
  readonly id: number;
}

interface DbFile {
  readonly logicalName: string;
  readonly type: 'D' | 'L';
  readonly physicalName: string;
  readonly fileId: number;
}

interface Database {
  readonly name: string;
  readonly id: number;
  readonly system: boolean;
  readOnly: boolean;
  userAccess: 'MULTI_USER' | 'SINGLE_USER';
  singleUser: Session | null;
  schemas: Map<string, SchemaDef>;
  tables: Map<string, Table>;
  files: DbFile[];
  nextSchemaId: number;
  dropped: boolean;
}

/** One connection's server-side state. */
interface Session {
  readonly id: number;
  readonly db: Database;
  tx: TxState | null;
  identityInsert: Table | null;
  killed: boolean;
}

/** A transaction's private table versions; `id` is null for a single statement's autocommit transaction. */
interface TxState {
  readonly id: number | null;
  readonly db: Database;
  readonly work: Map<Table, TableWork>;
  readonly statements: StatementRecord[];
}

interface TableWork {
  readonly set: RowSet;
  readonly inserted: Set<number>;
  readonly updated: Map<number, StoredRow>;
  readonly deleted: Set<number>;
}

/** One backup set on a backup device: the database image, its files and its LSNs. */
interface BackupSet {
  readonly database: string;
  readonly files: readonly DbFile[];
  readonly schemas: ReadonlyMap<string, SchemaDef>;
  readonly tables: ReadonlyMap<string, Table>;
  readonly nextSchemaId: number;
  readonly readOnly: boolean;
}

/** A column of a table being created. */
interface ColumnSpec {
  readonly name: string;
  readonly type: SqlType;
  /** Undefined takes the T-SQL default: NOT NULL for key and identity columns, NULL otherwise. */
  readonly nullable: boolean | undefined;
  readonly identity: { readonly seed: number; readonly increment: number } | null;
  readonly defaultValue: (() => TV) | undefined;
}

interface TableSpec {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey: readonly string[];
  readonly pkName: string | null;
}

const BUILTIN_SCHEMAS: ReadonlyMap<string, SchemaDef> = new Map([
  ['dbo', { name: 'dbo', id: 1 }],
  ['guest', { name: 'guest', id: 2 }],
  ['information_schema', { name: 'INFORMATION_SCHEMA', id: 3 }],
  ['sys', { name: 'sys', id: 4 }],
]);

function tableKey(schema: string, name: string): string {
  return `${schema.toLowerCase()}.${name.toLowerCase()}`;
}

function schemaOf(db: Database, name: string): SchemaDef | undefined {
  const lower = name.toLowerCase();
  return lower === 'dbo' ? BUILTIN_SCHEMAS.get('dbo') : (db.schemas.get(lower) ?? BUILTIN_SCHEMAS.get(lower));
}

function readOnlyFault(db: Database): SqlFault {
  return new SqlFault(3906, `Failed to update database "${db.name}" because the database is read-only.`);
}

function tableLabel(db: Database, def: TableDef): string {
  return `${db.name}.${def.schema}.${def.name}`;
}

function displayValue(v: Stored): string {
  if (v === null) return '<NULL>';
  if (v instanceof Date) return formatDate(v, { base: 'datetime2' }, 121);
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  return String(v);
}

function rowKey(def: TableDef, values: readonly Stored[]): string {
  return def.primaryKey.map((index) => keyOf((def.columns[index] as ColumnDef).type, values[index] ?? null)).join('\u0000');
}

function duplicateKeyFault(def: TableDef, values: readonly Stored[]): SqlFault {
  const shown = def.primaryKey.map((index) => displayValue(values[index] ?? null)).join(', ');
  return new SqlFault(
    2627,
    `Violation of PRIMARY KEY constraint '${def.pkName ?? ''}'. Cannot insert duplicate key in object '${def.schema}.${def.name}'. The duplicate key value is (${shown}).`,
  );
}

function buildIndex(def: TableDef, rows: readonly StoredRow[]): Map<string, StoredRow> | null {
  if (def.primaryKey.length === 0) return null;
  const index = new Map<string, StoredRow>();
  for (const row of rows) {
    const key = rowKey(def, row.values);
    if (index.has(key)) throw duplicateKeyFault(def, row.values);
    index.set(key, row);
  }
  return index;
}

function compareKeyValues(def: TableDef, a: readonly Stored[], b: readonly Stored[]): number {
  for (const index of def.primaryKey) {
    const type = (def.columns[index] as ColumnDef).type;
    const order = orderValues(tv(type, a[index] ?? null), tv(type, b[index] ?? null));
    if (order !== 0) return order;
  }
  return 0;
}

/** Rows in scan order: clustered key order for keyed tables, insertion order for heaps. */
function scanRows(def: TableDef, set: RowSet): readonly StoredRow[] {
  if (def.primaryKey.length === 0) return set.rows;
  set.sorted ??= [...set.rows].sort((a, b) => compareKeyValues(def, a.values, b.values));
  return set.sorted;
}

function copyRowSet(set: RowSet): RowSet {
  return { rows: [...set.rows], index: set.index === null ? null : new Map(set.index), sorted: null };
}

function cloneTable(table: Table): Table {
  return { def: table.def, data: copyRowSet(table.data), identity: table.identity === null ? null : { ...table.identity } };
}

function cloneTables(tables: ReadonlyMap<string, Table>): Map<string, Table> {
  return new Map([...tables].map(([key, table]) => [key, cloneTable(table)]));
}

function workOf(tx: TxState, table: Table): TableWork {
  let work = tx.work.get(table);
  if (work === undefined) {
    work = { set: copyRowSet(table.data), inserted: new Set(), updated: new Map(), deleted: new Set() };
    tx.work.set(table, work);
  }
  return work;
}

function workInsert(def: TableDef, work: TableWork, rows: readonly StoredRow[]): void {
  for (const row of rows) {
    work.set.rows.push(row);
    work.set.index?.set(rowKey(def, row.values), row);
    work.inserted.add(row.rid);
  }
  work.set.sorted = null;
}

/** Replaces rows by rid; the caller has checked that no new key collides. */
function workUpdate(def: TableDef, work: TableWork, changes: readonly (readonly [StoredRow, StoredRow])[]): void {
  const replaced = new Map(changes.map(([before, after]) => [before.rid, after]));
  work.set.rows = work.set.rows.map((row) => replaced.get(row.rid) ?? row);
  const index = work.set.index;
  if (index !== null) {
    for (const [before] of changes) index.delete(rowKey(def, before.values));
    for (const [, after] of changes) index.set(rowKey(def, after.values), after);
  }
  for (const [, after] of changes) if (!work.inserted.has(after.rid)) work.updated.set(after.rid, after);
  work.set.sorted = null;
}

function workDelete(def: TableDef, work: TableWork, rows: readonly StoredRow[]): void {
  const removed = new Set(rows.map((row) => row.rid));
  work.set.rows = work.set.rows.filter((row) => !removed.has(row.rid));
  for (const row of rows) {
    work.set.index?.delete(rowKey(def, row.values));
    if (work.inserted.has(row.rid)) {
      work.inserted.delete(row.rid);
    } else {
      work.updated.delete(row.rid);
      work.deleted.add(row.rid);
    }
  }
  work.set.sorted = null;
}

/** Merges a transaction's changes into the committed versions; a key another commit took fails the whole commit. */
function mergeTx(tx: TxState): boolean {
  const merged: (readonly [Table, RowSet])[] = [];
  for (const [table, work] of tx.work) {
    if (work.inserted.size === 0 && work.updated.size === 0 && work.deleted.size === 0) continue;
    const rows: StoredRow[] = [];
    for (const row of table.data.rows) if (!work.deleted.has(row.rid)) rows.push(work.updated.get(row.rid) ?? row);
    for (const row of work.set.rows) if (work.inserted.has(row.rid)) rows.push(row);
    merged.push([table, { rows, index: buildIndex(table.def, rows), sorted: null }]);
  }
  for (const [table, set] of merged) table.data = set;
  return merged.length > 0;
}


// ---------------------------------------------------------------------------------------------------------------------
// Syntax

type CmpOp = '=' | '<>' | '<' | '>' | '<=' | '>=';

type Expr =
  | { readonly k: 'lit'; readonly value: TV }
  | { readonly k: 'null' }
  | { readonly k: 'var'; readonly name: string }
  | { readonly k: 'global'; readonly name: string }
  | { readonly k: 'col'; readonly parts: readonly string[] }
  | { readonly k: 'fn'; readonly name: string; readonly args: readonly Expr[]; readonly star: boolean }
  | { readonly k: 'cast'; readonly expr: Expr; readonly type: SqlType; readonly style?: Expr }
  | {
      readonly k: 'case';
      readonly operand?: Expr;
      readonly whens: readonly { readonly when: Expr; readonly then: Expr }[];
      readonly otherwise?: Expr;
    }
  | { readonly k: 'arith'; readonly op: '+' | '-'; readonly left: Expr; readonly right: Expr }
  | { readonly k: 'neg'; readonly expr: Expr }
  | { readonly k: 'cmp'; readonly op: CmpOp; readonly left: Expr; readonly right: Expr }
  | { readonly k: 'and'; readonly left: Expr; readonly right: Expr }
  | { readonly k: 'or'; readonly left: Expr; readonly right: Expr }
  | { readonly k: 'not'; readonly expr: Expr }
  | { readonly k: 'isnull'; readonly expr: Expr; readonly negated: boolean }
  | { readonly k: 'in'; readonly expr: Expr; readonly list: readonly Expr[]; readonly negated: boolean }
  | { readonly k: 'collate'; readonly expr: Expr; readonly collation: Collation }
  | { readonly k: 'subquery'; readonly select: SelectStmt };

type SelectItem =
  | { readonly kind: 'expr'; readonly expr: Expr; readonly alias: string | null }
  | { readonly kind: 'star'; readonly qualifier: string | null }
  | { readonly kind: 'assign'; readonly name: string; readonly expr: Expr };

interface TableRef {
  readonly parts: readonly string[];
  readonly alias: string | null;
  readonly args: readonly Expr[] | null;
}

interface FromClause {
  readonly first: TableRef;
  readonly joins: readonly { readonly ref: TableRef; readonly on: Expr }[];
}

interface SelectStmt {
  readonly k: 'select';
  readonly distinct: boolean;
  readonly top: Expr | null;
  readonly items: readonly SelectItem[];
  readonly from: FromClause | null;
  readonly where: Expr | null;
  readonly orderBy: readonly { readonly expr: Expr; readonly desc: boolean }[];
}

interface ColumnClause {
  readonly name: string;
  readonly type: SqlType;
  readonly nullable: boolean | undefined;
  readonly identity: { readonly seed: number; readonly increment: number } | null;
  readonly defaultExpr: Expr | null;
  readonly primaryKey: boolean;
}

interface WithOption {
  readonly name: string;
  readonly value: Expr | null;
}

type Stmt =
  | SelectStmt
  | {
      readonly k: 'insert';
      readonly table: readonly string[];
      readonly columns: readonly string[] | null;
      readonly rows: readonly (readonly Expr[])[];
    }
  | {
      readonly k: 'update';
      readonly table: readonly string[];
      readonly set: readonly { readonly column: string; readonly expr: Expr }[];
      readonly where: Expr | null;
    }
  | { readonly k: 'delete'; readonly table: readonly string[]; readonly top: Expr | null; readonly where: Expr | null }
  | { readonly k: 'declare'; readonly vars: readonly { readonly name: string; readonly type: SqlType; readonly init: Expr | null }[] }
  | { readonly k: 'setVar'; readonly name: string; readonly expr: Expr }
  | { readonly k: 'identityInsert'; readonly table: readonly string[]; readonly on: boolean }
  | { readonly k: 'if'; readonly cond: Expr; readonly then: Stmt; readonly otherwise: Stmt | null }
  | { readonly k: 'block'; readonly body: readonly Stmt[] }
  | { readonly k: 'try'; readonly body: readonly Stmt[]; readonly handler: readonly Stmt[] }
  | { readonly k: 'throw' }
  | { readonly k: 'exec'; readonly expr: Expr }
  | { readonly k: 'createSchema'; readonly name: string }
  | {
      readonly k: 'createTable';
      readonly table: readonly string[];
      readonly columns: readonly ColumnClause[];
      readonly pk: { readonly name: string | null; readonly columns: readonly string[] } | null;
    }
  | { readonly k: 'backup'; readonly db: string; readonly disk: Expr; readonly options: readonly WithOption[] }
  | { readonly k: 'fileList'; readonly disk: Expr; readonly options: readonly WithOption[] }
  | {
      readonly k: 'restore';
      readonly db: string;
      readonly disk: Expr;
      readonly moves: readonly { readonly logical: Expr; readonly physical: Expr }[];
      readonly options: readonly WithOption[];
    }
  | { readonly k: 'alterDb'; readonly db: string; readonly option: string; readonly rollbackImmediate: boolean }
  | { readonly k: 'dropDb'; readonly names: readonly string[] };

type Tok =
  | { readonly t: 'id'; readonly v: string; readonly quoted: boolean }
  | { readonly t: 'var'; readonly v: string }
  | { readonly t: 'str'; readonly v: string; readonly unicode: boolean }
  | { readonly t: 'num'; readonly v: string }
  | { readonly t: 'op'; readonly v: string }
  | { readonly t: 'eof' };

const SPACE_RE = /\s+/y;
const ID_RE = /[A-Za-z_#\u00C0-\uFFFF][A-Za-z0-9_@$#\u00C0-\uFFFF]*/y;
const VAR_RE = /@@?[A-Za-z0-9_@$#]+/y;
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const TWO_CHAR_OPS: ReadonlySet<string> = new Set(['<=', '>=', '<>', '!=']);
const ONE_CHAR_OPS = '(),;.*=<>+-/%';
const CMP_OPS: ReadonlySet<string> = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);
const ALTER_OPTIONS: ReadonlySet<string> = new Set(['READ_ONLY', 'READ_WRITE', 'SINGLE_USER', 'MULTI_USER']);

// Words that end an expression or a table reference, so they are never read as an implicit alias.
const RESERVED: ReadonlySet<string> = new Set(
  (
    'ALL AND AS ASC BEGIN BETWEEN BY CASE CATCH COLLATE CREATE CROSS DECLARE DELETE DESC DISTINCT DROP ELSE END EXEC ' +
    'EXECUTE EXISTS FOR FROM FULL GO GROUP HAVING IF IN INNER INSERT INTO IS JOIN LEFT LIKE NOT NULL OFFSET ON OPTION ' +
    'OR ORDER OUTER OUTPUT RESTORE BACKUP RIGHT SELECT SET THEN THROW TOP TRY UNION UPDATE VALUES WHEN WHERE WITH ALTER'
  ).split(' '),
);

/** Reads a quoted run starting at `start` (just past the opening quote) up to `close`, doubled `close` escaping it. */
function readQuoted(text: string, start: number, close: string, what: string): { value: string; end: number } {
  let value = '';
  let from = start;
  for (;;) {
    const at = text.indexOf(close, from);
    if (at < 0) throw new Unmodelled(`an unterminated ${what}`);
    value += text.slice(from, at);
    if (text[at + 1] === close) {
      value += close;
      from = at + 2;
      continue;
    }
    return { value, end: at + 1 };
  }
}

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const match = (re: RegExp): string | null => {
    re.lastIndex = i;
    return re.exec(text)?.[0] ?? null;
  };
  while (i < text.length) {
    const c = text[i] as string;
    const pair = text.slice(i, i + 2);
    const space = match(SPACE_RE);
    if (space !== null) {
      i += space.length;
    } else if (pair === '--') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
    } else if (pair === '/*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Unmodelled('an unterminated comment');
      i = end + 2;
    } else if (c === '[' || c === '"') {
      const { value, end } = readQuoted(text, i + 1, c === '[' ? ']' : '"', 'quoted identifier');
      toks.push({ t: 'id', v: value, quoted: true });
      i = end;
    } else if (c === "'" || ((c === 'N' || c === 'n') && text[i + 1] === "'")) {
      const unicode = c !== "'";
      const { value, end } = readQuoted(text, i + (unicode ? 2 : 1), "'", 'string');
      toks.push({ t: 'str', v: value, unicode });
      i = end;
    } else if (c === '@') {
      const name = match(VAR_RE);
      if (name === null) throw new Unmodelled("a bare '@'");
      toks.push({ t: 'var', v: name });
      i += name.length;
    } else {
      const number = /[0-9.]/.test(c) ? match(NUM_RE) : null;
      const word = number === null ? match(ID_RE) : null;
      if (number !== null) {
        toks.push({ t: 'num', v: number });
        i += number.length;
      } else if (word !== null) {
        toks.push({ t: 'id', v: word, quoted: false });
        i += word.length;
      } else if (TWO_CHAR_OPS.has(pair)) {
        toks.push({ t: 'op', v: pair });
        i += 2;
      } else if (ONE_CHAR_OPS.includes(c)) {
        toks.push({ t: 'op', v: c });
        i += 1;
      } else {
        throw new Unmodelled(`the character '${c}'`);
      }
    }
  }
  toks.push({ t: 'eof' });
  return toks;
}

function describeTok(tok: Tok): string {
  switch (tok.t) {
    case 'eof':
      return 'the end of the batch';
    case 'str':
      return `'${tok.v}'`;
    default:
      return `'${tok.v}'`;
  }
}

function lit(value: TV): Expr {
  return { k: 'lit', value };
}

/** A numeric literal typed as T-SQL types it: int, numeric(p,0) beyond int, numeric(p,s) with a point, float with an exponent. */
function numberLiteral(text: string, negative: boolean): Expr {
  const signed = negative ? `-${text}` : text;
  if (/[eE]/.test(text)) return lit(tv({ base: 'float' }, Number(signed)));
  const d = parseDec(signed) as Dec;
  if (text.includes('.')) {
    const precision = Math.max(d.digits.toString().length, d.scale, 1);
    if (precision > 38) throw new Unmodelled(`the literal ${text}`);
    return lit(tv({ base: 'numeric', precision, scale: d.scale }, decText(d, d.scale)));
  }
  const n = decTruncate(d);
  if (n >= -2147483648n && n <= 2147483647n) return lit(tv(INT, Number(n)));
  if (text.length > 38) throw new Unmodelled(`the literal ${text}`);
  return lit(tv({ base: 'numeric', precision: text.length, scale: 0 }, n.toString()));
}

/** Recursive-descent parser of the T-SQL subset. */
class Parser {
  #i = 0;
  readonly #toks: readonly Tok[];

  constructor(text: string) {
    this.#toks = tokenize(text);
  }

  batch(): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      while (this.#acceptOp(';'));
      if (this.#peek().t === 'eof') return out;
      out.push(this.#statement());
    }
  }

  /** A one- to three-part object name filling the whole text, as OBJECT_ID reads its argument. */
  objectNameOnly(): string[] {
    const parts = this.#objectName();
    if (this.#peek().t !== 'eof') throw this.#syntax();
    return parts;
  }

  #peek(offset = 0): Tok {
    return this.#toks[Math.min(this.#i + offset, this.#toks.length - 1)] as Tok;
  }

  #next(): Tok {
    const tok = this.#peek();
    if (tok.t !== 'eof') this.#i += 1;
    return tok;
  }

  #isKw(word: string, offset = 0): boolean {
    const tok = this.#peek(offset);
    return tok.t === 'id' && !tok.quoted && tok.v.toUpperCase() === word;
  }

  #acceptKw(word: string): boolean {
    if (!this.#isKw(word)) return false;
    this.#i += 1;
    return true;
  }

  #expectKw(word: string): void {
    if (!this.#acceptKw(word)) throw this.#syntax(word);
  }

  #isOp(op: string, offset = 0): boolean {
    const tok = this.#peek(offset);
    return tok.t === 'op' && tok.v === op;
  }

  #acceptOp(op: string): boolean {
    if (!this.#isOp(op)) return false;
    this.#i += 1;
    return true;
  }

  #expectOp(op: string): void {
    if (!this.#acceptOp(op)) throw this.#syntax(`'${op}'`);
  }

  #syntax(expected?: string): Unmodelled {
    const near = describeTok(this.#peek());
    return new Unmodelled(`the syntax near ${near}${expected === undefined ? '' : ` (expected ${expected})`}`);
  }

  #isReserved(offset = 0): boolean {
    const tok = this.#peek(offset);
    return tok.t === 'id' && !tok.quoted && RESERVED.has(tok.v.toUpperCase());
  }

  #ident(): string {
    const tok = this.#next();
    if (tok.t !== 'id') throw this.#syntax('an identifier');
    return tok.v;
  }

  #word(): string {
    return this.#ident().toUpperCase();
  }

  #objectName(): string[] {
    const parts = [this.#ident()];
    while (this.#acceptOp('.')) {
      if (this.#isOp('.')) {
        parts.push('');
        continue;
      }
      parts.push(this.#ident());
    }
    if (parts.length > 3) throw new Unmodelled(`the four-part name ${parts.join('.')}`);
    return parts;
  }

  #statement(): Stmt {
    const tok = this.#peek();
    if (tok.t !== 'id' || tok.quoted) throw this.#syntax('a statement');
    switch (tok.v.toUpperCase()) {
      case 'SELECT':
        return this.#select();
      case 'INSERT':
        return this.#insert();
      case 'UPDATE':
        return this.#update();
      case 'DELETE':
        return this.#delete();
      case 'DECLARE':
        return this.#declare();
      case 'SET':
        return this.#set();
      case 'IF':
        return this.#if();
      case 'BEGIN':
        return this.#begin();
      case 'THROW':
        this.#next();
        if (!(this.#peek().t === 'eof' || this.#isOp(';') || this.#isKw('END'))) throw new Unmodelled('THROW with arguments');
        return { k: 'throw' };
      case 'EXEC':
      case 'EXECUTE':
        this.#next();
        if (!this.#acceptOp('(')) throw new Unmodelled('EXEC of a stored procedure');
        return this.#execTail();
      case 'CREATE':
        return this.#create();
      case 'ALTER':
        return this.#alter();
      case 'DROP':
        return this.#drop();
      case 'BACKUP':
        return this.#backup();
      case 'RESTORE':
        return this.#restore();
      default:
        throw new Unmodelled(`the statement ${tok.v.toUpperCase()}`);
    }
  }

  #execTail(): Stmt {
    const expr = this.#expr();
    this.#expectOp(')');
    return { k: 'exec', expr };
  }

  #select(): SelectStmt {
    this.#expectKw('SELECT');
    const distinct = this.#acceptKw('DISTINCT');
    if (!distinct) this.#acceptKw('ALL');
    let top: Expr | null = null;
    if (this.#acceptKw('TOP')) {
      if (this.#acceptOp('(')) {
        top = this.#expr();
        this.#expectOp(')');
      } else {
        const tok = this.#next();
        if (tok.t !== 'num') throw this.#syntax('a TOP count');
        top = numberLiteral(tok.v, false);
      }
      if (this.#isKw('PERCENT') || (this.#isKw('WITH') && this.#isKw('TIES', 1))) throw new Unmodelled('TOP PERCENT or WITH TIES');
    }
    const items: SelectItem[] = [];
    do items.push(this.#selectItem());
    while (this.#acceptOp(','));
    const from = this.#acceptKw('FROM') ? this.#from() : null;
    const where = this.#acceptKw('WHERE') ? this.#expr() : null;
    for (const word of ['GROUP', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'OPTION', 'INTO']) {
      if (this.#isKw(word)) throw new Unmodelled(`SELECT with ${word}`);
    }
    const orderBy: { expr: Expr; desc: boolean }[] = [];
    if (this.#acceptKw('ORDER')) {
      this.#expectKw('BY');
      do {
        const expr = this.#expr();
        if (expr.k === 'lit') throw new Unmodelled('ORDER BY a column position or constant');
        const desc = this.#acceptKw('DESC');
        if (!desc) this.#acceptKw('ASC');
        orderBy.push({ expr, desc });
      } while (this.#acceptOp(','));
      if (this.#isKw('OFFSET')) throw new Unmodelled('ORDER BY ... OFFSET');
    }
    return { k: 'select', distinct, top, items, from, where, orderBy };
  }

  #selectItem(): SelectItem {
    if (this.#acceptOp('*')) return { kind: 'star', qualifier: null };
    const tok = this.#peek();
    if (tok.t === 'id' && this.#isOp('.', 1) && this.#isOp('*', 2)) {
      this.#i += 3;
      return { kind: 'star', qualifier: tok.v };
    }
    if (tok.t === 'var' && !tok.v.startsWith('@@') && this.#isOp('=', 1)) {
      this.#i += 2;
      return { kind: 'assign', name: tok.v, expr: this.#expr() };
    }
    const expr = this.#expr();
    let alias: string | null = null;
    if (this.#acceptKw('AS')) {
      const next = this.#next();
      if (next.t !== 'id' && next.t !== 'str') throw this.#syntax('an alias');
      alias = next.v;
    } else if (this.#peek().t === 'id' && !this.#isReserved()) {
      alias = this.#ident();
    }
    return { kind: 'expr', expr, alias };
  }

  #from(): FromClause {
    const first = this.#tableRef();
    const joins: { ref: TableRef; on: Expr }[] = [];
    for (;;) {
      if (this.#acceptKw('INNER')) this.#expectKw('JOIN');
      else if (!this.#acceptKw('JOIN')) break;
      const ref = this.#tableRef();
      this.#expectKw('ON');
      joins.push({ ref, on: this.#expr() });
    }
    if (this.#isKw('LEFT') || this.#isKw('RIGHT') || this.#isKw('FULL') || this.#isKw('CROSS') || this.#isOp(',')) {
      throw new Unmodelled('outer, cross or comma joins');
    }
    return { first, joins };
  }

  #tableRef(): TableRef {
    const parts = this.#objectName();
    let args: Expr[] | null = null;
    if (this.#acceptOp('(')) {
      args = [];
      if (!this.#isOp(')')) {
        do args.push(this.#expr());
        while (this.#acceptOp(','));
      }
      this.#expectOp(')');
    }
    let alias: string | null = null;
    if (this.#acceptKw('AS')) alias = this.#ident();
    else if (this.#peek().t === 'id' && !this.#isReserved()) alias = this.#ident();
    this.#hints();
    return { parts, alias, args };
  }

  /** Skips a `WITH (hint, …)` table-hint list; locking hints change nothing in a single-process model. */
  #hints(): void {
    if (!(this.#isKw('WITH') && this.#isOp('(', 1))) return;
    this.#i += 2;
    do this.#ident();
    while (this.#acceptOp(','));
    this.#expectOp(')');
  }

  #insert(): Stmt {
    this.#expectKw('INSERT');
    this.#acceptKw('INTO');
    const table = this.#objectName();
    let columns: string[] | null = null;
    if (this.#acceptOp('(')) {
      columns = [];
      do columns.push(this.#ident());
      while (this.#acceptOp(','));
      this.#expectOp(')');
    }
    if (!this.#acceptKw('VALUES')) throw new Unmodelled('INSERT without a VALUES list');
    const rows: Expr[][] = [];
    do {
      this.#expectOp('(');
      const values: Expr[] = [];
      do values.push(this.#expr());
      while (this.#acceptOp(','));
      this.#expectOp(')');
      rows.push(values);
    } while (this.#acceptOp(','));
    return { k: 'insert', table, columns, rows };
  }

  #update(): Stmt {
    this.#expectKw('UPDATE');
    if (this.#isKw('TOP')) throw new Unmodelled('UPDATE TOP');
    const table = this.#objectName();
    this.#hints();
    this.#expectKw('SET');
    const set: { column: string; expr: Expr }[] = [];
    do {
      const parts = this.#objectName();
      this.#expectOp('=');
      set.push({ column: parts[parts.length - 1] as string, expr: this.#expr() });
    } while (this.#acceptOp(','));
    if (this.#isKw('FROM') || this.#isKw('OUTPUT')) throw new Unmodelled('UPDATE with FROM or OUTPUT');
    const where = this.#acceptKw('WHERE') ? this.#expr() : null;
    return { k: 'update', table, set, where };
  }

  #delete(): Stmt {
    this.#expectKw('DELETE');
    let top: Expr | null = null;
    if (this.#acceptKw('TOP')) {
      this.#expectOp('(');
      top = this.#expr();
      this.#expectOp(')');
    }
    this.#acceptKw('FROM');
    const table = this.#objectName();
    this.#hints();
    if (this.#isKw('FROM') || this.#isKw('OUTPUT')) throw new Unmodelled('DELETE with FROM or OUTPUT');
    const where = this.#acceptKw('WHERE') ? this.#expr() : null;
    return { k: 'delete', table, top, where };
  }

  #declare(): Stmt {
    this.#expectKw('DECLARE');
    const vars: { name: string; type: SqlType; init: Expr | null }[] = [];
    do {
      const tok = this.#next();
      if (tok.t !== 'var' || tok.v.startsWith('@@')) throw this.#syntax('a variable name');
      this.#acceptKw('AS');
      if (this.#isKw('TABLE') || this.#isKw('CURSOR')) throw new Unmodelled('table variables and cursors');
      const type = this.#dataType(1);
      vars.push({ name: tok.v, type, init: this.#acceptOp('=') ? this.#expr() : null });
    } while (this.#acceptOp(','));
    return { k: 'declare', vars };
  }

  #set(): Stmt {
    this.#expectKw('SET');
    if (this.#acceptKw('IDENTITY_INSERT')) {
      const table = this.#objectName();
      const on = this.#acceptKw('ON');
      if (!on) this.#expectKw('OFF');
      return { k: 'identityInsert', table, on };
    }
    const tok = this.#peek();
    if (tok.t === 'var' && !tok.v.startsWith('@@') && this.#isOp('=', 1)) {
      this.#i += 2;
      return { k: 'setVar', name: tok.v, expr: this.#expr() };
    }
    throw new Unmodelled(`SET ${describeTok(tok)}`);
  }

  #if(): Stmt {
    this.#expectKw('IF');
    const cond = this.#expr();
    const then = this.#statement();
    const otherwise = this.#acceptKw('ELSE') ? this.#statement() : null;
    return { k: 'if', cond, then, otherwise };
  }

  #statementsUntil(word: string): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      while (this.#acceptOp(';'));
      if (this.#isKw(word) || this.#peek().t === 'eof') return body;
      body.push(this.#statement());
    }
  }

  #begin(): Stmt {
    this.#expectKw('BEGIN');
    if (this.#acceptKw('TRY')) {
      const body = this.#statementsUntil('END');
      this.#expectKw('END');
      this.#expectKw('TRY');
      this.#expectKw('BEGIN');
      this.#expectKw('CATCH');
      const handler = this.#statementsUntil('END');
      this.#expectKw('END');
      this.#expectKw('CATCH');
      return { k: 'try', body, handler };
    }
    if (this.#isKw('TRAN') || this.#isKw('TRANSACTION') || this.#isKw('DISTRIBUTED')) {
      throw new Unmodelled('BEGIN TRANSACTION inside a batch');
    }
    const body = this.#statementsUntil('END');
    this.#expectKw('END');
    return { k: 'block', body };
  }

  #create(): Stmt {
    this.#expectKw('CREATE');
    if (this.#acceptKw('SCHEMA')) {
      const name = this.#ident();
      if (this.#isKw('AUTHORIZATION')) throw new Unmodelled('CREATE SCHEMA AUTHORIZATION');
      return { k: 'createSchema', name };
    }
    if (!this.#acceptKw('TABLE')) throw new Unmodelled(`CREATE ${describeTok(this.#peek())}`);
    const table = this.#objectName();
    this.#expectOp('(');
    const columns: ColumnClause[] = [];
    let pk: { name: string | null; columns: string[] } | null = null;
    do {
      if (this.#acceptKw('CONSTRAINT')) pk = this.#primaryKey(this.#ident());
      else if (this.#isKw('PRIMARY')) pk = this.#primaryKey(null);
      else columns.push(this.#columnClause());
    } while (this.#acceptOp(','));
    this.#expectOp(')');
    if (this.#acceptKw('ON')) this.#ident();
    if (this.#acceptKw('TEXTIMAGE_ON')) this.#ident();
    return { k: 'createTable', table, columns, pk };
  }

  #primaryKey(name: string | null): { name: string | null; columns: string[] } {
    this.#expectKw('PRIMARY');
    this.#expectKw('KEY');
    if (!this.#acceptKw('CLUSTERED')) this.#acceptKw('NONCLUSTERED');
    this.#expectOp('(');
    const columns: string[] = [];
    do {
      columns.push(this.#ident());
      if (this.#isKw('DESC')) throw new Unmodelled('a descending key column');
      this.#acceptKw('ASC');
    } while (this.#acceptOp(','));
    this.#expectOp(')');
    return { name, columns };
  }

  #signedInt(): number {
    const negative = this.#acceptOp('-');
    const tok = this.#next();
    if (tok.t !== 'num' || !/^\d+$/.test(tok.v)) throw this.#syntax('an integer');
    return negative ? -Number(tok.v) : Number(tok.v);
  }

  #columnClause(): ColumnClause {
    const name = this.#ident();
    const type = this.#dataType(1);
    let nullable: boolean | undefined;
    let identity: { seed: number; increment: number } | null = null;
    let defaultExpr: Expr | null = null;
    let primaryKey = false;
    for (;;) {
      if (this.#acceptKw('NOT')) {
        this.#expectKw('NULL');
        nullable = false;
      } else if (this.#acceptKw('NULL')) {
        nullable = true;
      } else if (this.#acceptKw('IDENTITY')) {
        identity = { seed: 1, increment: 1 };
        if (this.#acceptOp('(')) {
          const seed = this.#signedInt();
          this.#expectOp(',');
          identity = { seed, increment: this.#signedInt() };
          this.#expectOp(')');
        }
      } else if (this.#acceptKw('DEFAULT')) {
        defaultExpr = this.#unary();
      } else if (this.#acceptKw('CONSTRAINT')) {
        this.#ident();
      } else if (this.#acceptKw('PRIMARY')) {
        this.#expectKw('KEY');
        if (!this.#acceptKw('CLUSTERED')) this.#acceptKw('NONCLUSTERED');
        primaryKey = true;
      } else {
        return { name, type, nullable, identity, defaultExpr, primaryKey };
      }
    }
  }

  /** A data type; `defaultLength` is the length of a sized type written without one (1 in DDL, 30 in CAST). */
  #dataType(defaultLength: number): SqlType {
    const name = this.#ident();
    const lower = name.toLowerCase();
    const args: (number | 'max')[] = [];
    if (this.#acceptOp('(')) {
      do {
        if (this.#acceptKw('MAX')) {
          args.push('max');
        } else {
          const tok = this.#next();
          if (tok.t !== 'num') throw this.#syntax('a type size');
          args.push(Number(tok.v));
        }
      } while (this.#acceptOp(','));
      this.#expectOp(')');
    }
    if (lower === 'sysname') return SYSNAME;
    if (lower === 'xml') return NVARCHAR_MAX;
    const base = baseOf(name);
    const first = args[0];
    if (LENGTH_TYPES.has(base)) {
      const length = first ?? defaultLength;
      if (length === 'max' && FIXED_TYPES.has(base)) throw new Unmodelled(`${base}(max)`);
      return { base, length };
    }
    if (base === 'decimal' || base === 'numeric') {
      const precision = typeof first === 'number' ? first : 18;
      const scale = typeof args[1] === 'number' ? args[1] : 0;
      return { base, precision, scale };
    }
    if (base === 'datetime2') return { base, scale: typeof first === 'number' ? first : 7 };
    if (args.length > 0 && base !== 'float') throw new Unmodelled(`the type ${name} with a size`);
    return { base };
  }

  #alter(): Stmt {
    this.#expectKw('ALTER');
    if (!this.#acceptKw('DATABASE')) throw new Unmodelled(`ALTER ${describeTok(this.#peek())}`);
    const db = this.#ident();
    this.#expectKw('SET');
    const option = this.#word();
    if (!ALTER_OPTIONS.has(option)) throw new Unmodelled(`ALTER DATABASE SET ${option}`);
    let rollbackImmediate = false;
    if (this.#acceptKw('WITH')) {
      if (this.#acceptKw('ROLLBACK')) {
        this.#expectKw('IMMEDIATE');
        rollbackImmediate = true;
      } else {
        this.#expectKw('NO_WAIT');
      }
    }
    return { k: 'alterDb', db, option, rollbackImmediate };
  }

  #drop(): Stmt {
    this.#expectKw('DROP');
    if (!this.#acceptKw('DATABASE')) throw new Unmodelled(`DROP ${describeTok(this.#peek())}`);
    const names: string[] = [];
    do names.push(this.#ident());
    while (this.#acceptOp(','));
    return { k: 'dropDb', names };
  }

  #disk(): Expr {
    this.#expectKw('DISK');
    this.#expectOp('=');
    return this.#additive();
  }

  #withOptions(moves: { logical: Expr; physical: Expr }[] | null): WithOption[] {
    const options: WithOption[] = [];
    if (!this.#acceptKw('WITH')) return options;
    do {
      if (moves !== null && this.#acceptKw('MOVE')) {
        const logical = this.#additive();
        this.#expectKw('TO');
        moves.push({ logical, physical: this.#additive() });
      } else {
        const name = this.#word();
        options.push({ name, value: this.#acceptOp('=') ? this.#additive() : null });
      }
    } while (this.#acceptOp(','));
    return options;
  }

  #backup(): Stmt {
    this.#expectKw('BACKUP');
    if (!this.#acceptKw('DATABASE')) throw new Unmodelled(`BACKUP ${describeTok(this.#peek())}`);
    const db = this.#ident();
    this.#expectKw('TO');
    const disk = this.#disk();
    return { k: 'backup', db, disk, options: this.#withOptions(null) };
  }

  #restore(): Stmt {
    this.#expectKw('RESTORE');
    if (this.#acceptKw('FILELISTONLY')) {
      this.#expectKw('FROM');
      const disk = this.#disk();
      return { k: 'fileList', disk, options: this.#withOptions(null) };
    }
    if (!this.#acceptKw('DATABASE')) throw new Unmodelled(`RESTORE ${describeTok(this.#peek())}`);
    const db = this.#ident();
    this.#expectKw('FROM');
    const disk = this.#disk();
    const moves: { logical: Expr; physical: Expr }[] = [];
    const options = this.#withOptions(moves);
    return { k: 'restore', db, disk, moves, options };
  }

  #expr(): Expr {
    let left = this.#and();
    while (this.#acceptKw('OR')) left = { k: 'or', left, right: this.#and() };
    return left;
  }

  #and(): Expr {
    let left = this.#not();
    while (this.#acceptKw('AND')) left = { k: 'and', left, right: this.#not() };
    return left;
  }

  #not(): Expr {
    if (this.#acceptKw('NOT')) return { k: 'not', expr: this.#not() };
    return this.#predicate();
  }

  #predicate(): Expr {
    const left = this.#additive();
    if (this.#acceptKw('IS')) {
      const negated = this.#acceptKw('NOT');
      this.#expectKw('NULL');
      return { k: 'isnull', expr: left, negated };
    }
    const negated = this.#isKw('NOT') && this.#isKw('IN', 1);
    if (negated) this.#i += 1;
    if (this.#acceptKw('IN')) {
      this.#expectOp('(');
      if (this.#isKw('SELECT')) throw new Unmodelled('IN (subquery)');
      const list: Expr[] = [];
      do list.push(this.#additive());
      while (this.#acceptOp(','));
      this.#expectOp(')');
      return { k: 'in', expr: left, list, negated };
    }
    if (this.#isKw('LIKE') || this.#isKw('BETWEEN') || (this.#isKw('NOT') && (this.#isKw('LIKE', 1) || this.#isKw('BETWEEN', 1)))) {
      throw new Unmodelled('LIKE and BETWEEN');
    }
    const tok = this.#peek();
    if (tok.t === 'op' && CMP_OPS.has(tok.v)) {
      this.#i += 1;
      const op = (tok.v === '!=' ? '<>' : tok.v) as CmpOp;
      return { k: 'cmp', op, left, right: this.#additive() };
    }
    return left;
  }

  #additive(): Expr {
    let left = this.#multiplicative();
    for (;;) {
      if (this.#acceptOp('+')) left = { k: 'arith', op: '+', left, right: this.#multiplicative() };
      else if (this.#acceptOp('-')) left = { k: 'arith', op: '-', left, right: this.#multiplicative() };
      else return left;
    }
  }

  #multiplicative(): Expr {
    const left = this.#unary();
    if (this.#isOp('*') || this.#isOp('/') || this.#isOp('%')) throw new Unmodelled('multiplication, division and modulo');
    return left;
  }

  #unary(): Expr {
    if (this.#acceptOp('-')) {
      const tok = this.#peek();
      if (tok.t === 'num') {
        this.#i += 1;
        return numberLiteral(tok.v, true);
      }
      return { k: 'neg', expr: this.#unary() };
    }
    if (this.#acceptOp('+')) return this.#unary();
    let expr = this.#primary();
    while (this.#acceptKw('COLLATE')) expr = { k: 'collate', expr, collation: collationOf(this.#ident()) };
    return expr;
  }

  #primary(): Expr {
    const tok = this.#peek();
    switch (tok.t) {
      case 'num':
        this.#i += 1;
        return numberLiteral(tok.v, false);
      case 'str':
        this.#i += 1;
        return lit(tv({ base: tok.unicode ? 'nvarchar' : 'varchar', length: Math.max(1, tok.v.length) }, tok.v));
      case 'var':
        this.#i += 1;
        return tok.v.startsWith('@@') ? { k: 'global', name: tok.v.slice(2).toUpperCase() } : { k: 'var', name: tok.v };
      case 'op': {
        if (tok.v !== '(') throw this.#syntax('an expression');
        this.#i += 1;
        if (this.#isKw('SELECT')) {
          const select = this.#select();
          this.#expectOp(')');
          return { k: 'subquery', select };
        }
        const inner = this.#expr();
        this.#expectOp(')');
        return inner;
      }
      case 'id':
        return this.#identifierExpr(tok);
      default:
        throw this.#syntax('an expression');
    }
  }

  #identifierExpr(tok: { readonly v: string; readonly quoted: boolean }): Expr {
    if (!tok.quoted) {
      switch (tok.v.toUpperCase()) {
        case 'NULL':
          this.#i += 1;
          return { k: 'null' };
        case 'CASE':
          return this.#case();
        case 'CAST': {
          this.#i += 1;
          this.#expectOp('(');
          const expr = this.#expr();
          this.#expectKw('AS');
          const type = this.#dataType(30);
          this.#expectOp(')');
          return { k: 'cast', expr, type };
        }
        case 'CONVERT': {
          this.#i += 1;
          this.#expectOp('(');
          const type = this.#dataType(30);
          this.#expectOp(',');
          const expr = this.#expr();
          const style = this.#acceptOp(',') ? this.#expr() : undefined;
          this.#expectOp(')');
          return style === undefined ? { k: 'cast', expr, type } : { k: 'cast', expr, type, style };
        }
        default:
          if (this.#isReserved() && !this.#isOp('(', 1)) throw this.#syntax('an expression');
      }
    }
    if (this.#isOp('(', 1)) return this.#call();
    const parts = [this.#ident()];
    while (this.#acceptOp('.')) parts.push(this.#ident());
    return { k: 'col', parts };
  }

  #call(): Expr {
    const name = this.#word();
    this.#expectOp('(');
    if (this.#acceptOp('*')) {
      this.#expectOp(')');
      return { k: 'fn', name, args: [], star: true };
    }
    if (this.#isKw('DISTINCT')) throw new Unmodelled(`${name}(DISTINCT …)`);
    const args: Expr[] = [];
    if (!this.#isOp(')')) {
      do args.push(this.#expr());
      while (this.#acceptOp(','));
    }
    this.#expectOp(')');
    if (this.#isKw('OVER')) throw new Unmodelled('window functions');
    return { k: 'fn', name, args, star: false };
  }

  #case(): Expr {
    this.#expectKw('CASE');
    const operand = this.#isKw('WHEN') ? undefined : this.#expr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.#acceptKw('WHEN')) {
      const when = this.#expr();
      this.#expectKw('THEN');
      whens.push({ when, then: this.#expr() });
    }
    if (whens.length === 0) throw this.#syntax('WHEN');
    const otherwise = this.#acceptKw('ELSE') ? this.#expr() : undefined;
    this.#expectKw('END');
    return { k: 'case', whens, ...(operand === undefined ? {} : { operand }), ...(otherwise === undefined ? {} : { otherwise }) };
  }
}


// ---------------------------------------------------------------------------------------------------------------------
// Evaluation

interface OutColumn {
  readonly name: string;
  readonly type: SqlType;
  readonly nullable: boolean;
}

/** What a batch returns, in order: result sets (rows as driver values) and DML row counts. */
type Token =
  | { readonly kind: 'rows'; readonly columns: readonly OutColumn[]; readonly rows: readonly (readonly unknown[])[] }
  | { readonly kind: 'count'; readonly count: number };

interface Source {
  readonly alias: string;
  readonly columns: readonly OutColumn[];
  readonly rows: readonly (readonly Stored[])[];
}

/** Rows in reach of an expression: one row per FROM source, select-list aliases, an aggregate group, the outer query. */
interface Scope {
  readonly sources: readonly Source[];
  readonly row: readonly (readonly Stored[] | undefined)[];
  readonly aliases?: ReadonlyMap<string, TV>;
  readonly group?: readonly (readonly (readonly Stored[])[])[];
  readonly outer?: Scope | undefined;
}

const EMPTY_SCOPE: Scope = { sources: [], row: [] };

/** State of one batch on one session. */
interface Exec {
  readonly server: FakeServer;
  readonly session: Session;
  readonly params: ReadonlyMap<string, TV>;
  readonly vars: Map<string, TV>;
  readonly out: Token[];
  readonly caught: SqlFault[];
  readonly batch: readonly Stmt[];
  rowcount: number;
  implicit: TxState | null;
}

const AGGREGATES: ReadonlySet<string> = new Set(['COUNT', 'COUNT_BIG', 'MAX', 'MIN']);
const OPERATOR_NAMES: Readonly<Record<CmpOp, string>> = {
  '=': 'equal to',
  '<>': 'not equal to',
  '<': 'less than',
  '>': 'greater than',
  '<=': 'less than or equal to',
  '>=': 'greater than or equal to',
};
const PRODUCT_VERSION = '16.0.4305.5';

function variableKey(name: string): string {
  return name.replace(/^@/, '').toLowerCase();
}

function readVariable(ctx: Exec, name: string): TV {
  const key = variableKey(name);
  const value = ctx.vars.get(key) ?? ctx.params.get(key);
  if (value === undefined) throw new SqlFault(137, `Must declare the scalar variable "${name}".`);
  return value;
}

function writeVariable(ctx: Exec, name: string, value: TV): void {
  ctx.vars.set(variableKey(name), convert(value, readVariable(ctx, name).type));
}

function hasAggregate(e: Expr): boolean {
  switch (e.k) {
    case 'fn':
      return AGGREGATES.has(e.name) || e.args.some(hasAggregate);
    case 'cast':
      return hasAggregate(e.expr) || (e.style !== undefined && hasAggregate(e.style));
    case 'case':
      return (
        (e.operand !== undefined && hasAggregate(e.operand)) ||
        e.whens.some((w) => hasAggregate(w.when) || hasAggregate(w.then)) ||
        (e.otherwise !== undefined && hasAggregate(e.otherwise))
      );
    case 'arith':
    case 'cmp':
    case 'and':
    case 'or':
      return hasAggregate(e.left) || hasAggregate(e.right);
    case 'neg':
    case 'not':
    case 'isnull':
    case 'collate':
      return hasAggregate(e.expr);
    case 'in':
      return hasAggregate(e.expr) || e.list.some(hasAggregate);
    default:
      return false;
  }
}

function findInScope(scope: Scope, parts: readonly string[]): TV | undefined {
  if (parts.length > 2) throw new Unmodelled(`the column reference ${parts.join('.')}`);
  const name = (parts[parts.length - 1] as string).toLowerCase();
  const qualifier = parts.length === 2 ? (parts[0] as string).toLowerCase() : null;
  let hit: TV | undefined;
  scope.sources.forEach((source, index) => {
    if (qualifier !== null && source.alias !== qualifier) return;
    const column = source.columns.findIndex((candidate) => candidate.name.toLowerCase() === name);
    if (column < 0) {
      if (qualifier !== null) throw new SqlFault(207, `Invalid column name '${parts[1] as string}'.`);
      return;
    }
    if (hit !== undefined) throw new SqlFault(209, `Ambiguous column name '${parts[parts.length - 1] as string}'.`);
    hit = tv((source.columns[column] as OutColumn).type, scope.row[index]?.[column] ?? null);
  });
  return hit;
}

function resolveColumn(scope: Scope, parts: readonly string[]): TV {
  if (parts.length === 1) {
    const aliased = scope.aliases?.get((parts[0] as string).toLowerCase());
    if (aliased !== undefined) return aliased;
  }
  for (let current: Scope | undefined = scope; current !== undefined; current = current.outer) {
    const found = findInScope(current, parts);
    if (found === undefined) continue;
    if (current.group !== undefined) {
      throw new SqlFault(
        8120,
        `Column '${parts.join('.')}' is invalid in the select list because it is not contained in either an aggregate function or the GROUP BY clause.`,
      );
    }
    return found;
  }
  if (parts.length === 1) throw new SqlFault(207, `Invalid column name '${parts[0] as string}'.`);
  throw new SqlFault(4104, `The multi-part identifier "${parts.join('.')}" could not be bound.`);
}

/** Type of an expression's result, for result sets without rows and CASE branches not taken. */
function typeOfExpr(ctx: Exec, e: Expr, scope: Scope): SqlType {
  if (e.k === 'cast') return e.type;
  if (e.k === 'lit') return e.value.type;
  try {
    return evalScalar(ctx, e, scope).type;
  } catch (error) {
    if (error instanceof SqlFault) return NVARCHAR_MAX;
    throw error;
  }
}

function requireArgs(e: { readonly name: string; readonly args: readonly Expr[] }, min: number, max: number): void {
  if (e.args.length >= min && e.args.length <= max) return;
  const count = min === max ? String(min) : `${String(min)} to ${String(max)}`;
  throw new SqlFault(174, `The ${e.name.toLowerCase()} function requires ${count} argument(s).`);
}

function textArg(ctx: Exec, e: Expr | undefined, scope: Scope): string | null {
  if (e === undefined) return null;
  const value = evalScalar(ctx, e, scope);
  return value.v === null ? null : textOf(value);
}

function objectIdOf(ctx: Exec, name: string, type: string | null): number | null {
  let parts: string[];
  try {
    parts = new Parser(name).objectNameOnly();
  } catch (error) {
    if (error instanceof Unmodelled) return null;
    throw error;
  }
  const db = parts.length === 3 ? ctx.server.findDb(parts[0] as string) : ctx.session.db;
  if (db === undefined) return null;
  const schema = parts.length >= 2 ? (parts[parts.length - 2] as string) || 'dbo' : 'dbo';
  const table = db.tables.get(tableKey(schema, parts[parts.length - 1] as string));
  if (table === undefined) return null;
  if (type !== null && rtrim(type).toUpperCase() !== 'U') return null;
  return table.def.objectId;
}

function aggregate(ctx: Exec, e: { readonly name: string; readonly args: readonly Expr[]; readonly star: boolean }, scope: Scope): TV {
  const group = scope.group;
  if (group === undefined) {
    throw new SqlFault(
      147,
      'An aggregate may not appear in the WHERE clause unless it is in a subquery contained in a HAVING clause or a select list, and the column being aggregated is an outer reference.',
    );
  }
  if (!e.star) requireArgs(e, 1, 1);
  const arg = e.args[0];
  const rowScope = (row: readonly (readonly Stored[])[]): Scope => ({ sources: scope.sources, row, outer: scope.outer });
  if (e.name === 'COUNT' || e.name === 'COUNT_BIG') {
    let count = 0;
    for (const row of group) if (arg === undefined || evalScalar(ctx, arg, rowScope(row)).v !== null) count += 1;
    return e.name === 'COUNT' ? tv(INT, count) : tv(BIGINT, BigInt(count));
  }
  if (arg === undefined) throw new SqlFault(102, `Incorrect syntax near '*' in ${e.name}.`);
  let best: TV | undefined;
  for (const row of group) {
    const value = evalScalar(ctx, arg, rowScope(row));
    if (value.v === null) continue;
    const order = best === undefined ? 0 : (compareTv(value, best, null) ?? 0);
    if (best === undefined || (e.name === 'MAX' ? order > 0 : order < 0)) best = value;
  }
  return best ?? tv(typeOfExpr(ctx, arg, rowScope([])), null);
}

function serverProperty(ctx: Exec, property: string | null): TV {
  const type: SqlType = { base: 'nvarchar', length: 4000 };
  switch (property?.toLowerCase()) {
    case 'instancedefaultdatapath':
    case 'instancedefaultlogpath':
      return tv(type, ctx.server.dataPath);
    case 'productversion':
      return tv(type, PRODUCT_VERSION);
    case 'edition':
      return tv(type, 'Express Edition (64-bit)');
    case 'servername':
      return tv(type, SERVER_NAME);
    default:
      return tv(type, null);
  }
}

function databaseProperty(ctx: Exec, database: string | null, property: string | null): TV {
  const db = database === null ? undefined : ctx.server.findDb(database);
  const value = (() => {
    if (db === undefined) return null;
    switch (property?.toLowerCase()) {
      case 'updateability':
        return db.readOnly ? 'READ_ONLY' : 'READ_WRITE';
      case 'useraccess':
        return db.userAccess;
      case 'status':
        return 'ONLINE';
      default:
        return null;
    }
  })();
  return tv({ base: 'nvarchar', length: 128 }, value);
}

function evalFunction(ctx: Exec, e: { readonly name: string; readonly args: readonly Expr[]; readonly star: boolean }, scope: Scope): TV {
  if (AGGREGATES.has(e.name)) return aggregate(ctx, e, scope);
  if (e.star) throw new Unmodelled(`${e.name}(*)`);
  const arg = (index: number): Expr => e.args[index] as Expr;
  switch (e.name) {
    case 'DB_NAME': {
      requireArgs(e, 0, 1);
      if (e.args.length === 0) return tv(SYSNAME, ctx.session.db.name);
      const id = evalScalar(ctx, arg(0), scope);
      return tv(SYSNAME, id.v === null ? null : (ctx.server.findDbById(Number(intOf(id, INT)))?.name ?? null));
    }
    case 'DB_ID': {
      requireArgs(e, 0, 1);
      const name = e.args.length === 0 ? ctx.session.db.name : textArg(ctx, arg(0), scope);
      return tv(INT, name === null ? null : (ctx.server.findDb(name)?.id ?? null));
    }
    case 'SCHEMA_ID': {
      requireArgs(e, 0, 1);
      const name = e.args.length === 0 ? 'dbo' : textArg(ctx, arg(0), scope);
      return tv(INT, name === null ? null : (schemaOf(ctx.session.db, name)?.id ?? null));
    }
    case 'OBJECT_ID': {
      requireArgs(e, 1, 2);
      const name = textArg(ctx, arg(0), scope);
      return tv(INT, name === null ? null : objectIdOf(ctx, name, textArg(ctx, e.args[1], scope)));
    }
    case 'QUOTENAME': {
      requireArgs(e, 1, 1);
      const name = textArg(ctx, arg(0), scope);
      return tv({ base: 'nvarchar', length: 258 }, name === null ? null : `[${name.replaceAll(']', ']]')}]`);
    }
    case 'DATABASEPROPERTYEX':
      requireArgs(e, 2, 2);
      return databaseProperty(ctx, textArg(ctx, arg(0), scope), textArg(ctx, arg(1), scope));
    case 'SERVERPROPERTY':
      requireArgs(e, 1, 1);
      return serverProperty(ctx, textArg(ctx, arg(0), scope));
    case 'SYSDATETIME':
      requireArgs(e, 0, 0);
      return tv({ base: 'datetime2', scale: 7 }, new Date());
    case 'GETDATE':
      requireArgs(e, 0, 0);
      return tv(DATETIME, dateValue(wallOfDate(new Date()), DATETIME));
    case 'ISNULL': {
      requireArgs(e, 2, 2);
      const first = evalScalar(ctx, arg(0), scope);
      if (first.v !== null) return first;
      const second = evalScalar(ctx, arg(1), scope);
      return arg(0).k === 'null' ? second : convert(second, first.type);
    }
    case 'COALESCE': {
      requireArgs(e, 2, Number.MAX_SAFE_INTEGER);
      const values = e.args.map((expr) => evalScalar(ctx, expr, scope));
      const type = unionType(values.filter((_, index) => arg(index).k !== 'null').map((value) => value.type));
      const found = values.find((value) => value.v !== null);
      return found === undefined ? tv(type, null) : convert(found, type);
    }
    case 'DATALENGTH':
      requireArgs(e, 1, 1);
      return dataLength(evalScalar(ctx, arg(0), scope));
    default:
      throw new Unmodelled(`the function ${e.name}`);
  }
}

function evalCase(ctx: Exec, e: Extract<Expr, { k: 'case' }>, scope: Scope): TV {
  const results = [...e.whens.map((w) => w.then), ...(e.otherwise === undefined ? [] : [e.otherwise])];
  const typed = results.filter((result) => result.k !== 'null').map((result) => typeOfExpr(ctx, result, scope));
  const type = typed.length === 0 ? INT : unionType(typed);
  let chosen = e.otherwise;
  const operand = e.operand === undefined ? undefined : evalScalar(ctx, e.operand, scope);
  for (const w of e.whens) {
    const hit = operand === undefined ? evalBool(ctx, w.when, scope) === true : compareTv(operand, evalScalar(ctx, w.when, scope)) === 0;
    if (hit) {
      chosen = w.then;
      break;
    }
  }
  return chosen === undefined ? tv(type, null) : convert(evalScalar(ctx, chosen, scope), type);
}

function evalArith(ctx: Exec, e: Extract<Expr, { k: 'arith' }>, scope: Scope): TV {
  const left = evalScalar(ctx, e.left, scope);
  const right = evalScalar(ctx, e.right, scope);
  const target = PRECEDENCE[left.type.base] >= PRECEDENCE[right.type.base] ? left.type : right.type;
  const family = familyOf(target);
  if (family === 'char') {
    if (e.op === '-') throw new SqlFault(8117, `Operand data type ${target.base} is invalid for subtract operator.`);
    const unicode = UNICODE_TYPES.has(left.type.base) || UNICODE_TYPES.has(right.type.base);
    const lengths = [left.type.length, right.type.length];
    const length = lengths.some((n) => n === 'max' || n === undefined) ? 'max' : (lengths as number[]).reduce((a, b) => a + b, 0);
    const type: SqlType = { base: unicode ? 'nvarchar' : 'varchar', length };
    return left.v === null || right.v === null ? tv(type, null) : tv(type, textOf(left) + textOf(right));
  }
  if (left.v === null || right.v === null) return tv(target, null);
  switch (family) {
    case 'int': {
      const type = target.base === 'bigint' ? BIGINT : INT;
      const x = BigInt(intOf(left, type));
      const y = BigInt(intOf(right, type));
      return tv(type, intOf(tv(BIGINT, e.op === '+' ? x + y : x - y), type));
    }
    case 'exact': {
      const x = decOf(left, target);
      const y = decOf(right, target);
      const scale = Math.max(x.scale, y.scale);
      const sum = e.op === '+' ? decSigned(x, scale) + decSigned(y, scale) : decSigned(x, scale) - decSigned(y, scale);
      const d: Dec = { neg: sum < 0n, digits: sum < 0n ? -sum : sum, scale };
      return tv({ base: 'numeric', precision: 38, scale }, decText(d, scale));
    }
    case 'float':
      return tv({ base: 'float' }, e.op === '+' ? floatOf(left) + floatOf(right) : floatOf(left) - floatOf(right));
    default:
      throw new SqlFault(8117, `Operand data type ${target.base} is invalid for ${e.op === '+' ? 'add' : 'subtract'} operator.`);
  }
}

function negate(value: TV): TV {
  if (value.v === null) return value;
  switch (familyOf(value.type)) {
    case 'int':
      return tv(value.type.base === 'bigint' ? BIGINT : INT, intOf(tv(BIGINT, -BigInt(value.v as number | bigint)), value.type.base === 'bigint' ? BIGINT : INT));
    case 'exact': {
      const d = parseDec(value.v as string) as Dec;
      return tv(value.type, decText({ ...d, neg: !d.neg }, d.scale));
    }
    case 'float':
      return tv(value.type, -(value.v as number));
    default:
      throw new SqlFault(8117, `Operand data type ${value.type.base} is invalid for minus operator.`);
  }
}

function scalarSubquery(ctx: Exec, select: SelectStmt, scope: Scope): TV {
  const result = runSelect(ctx, select, scope);
  if (result.columns.length !== 1) {
    throw new SqlFault(116, 'Only one expression can be specified in the select list when the subquery is not introduced with EXISTS.');
  }
  if (result.rows.length > 1) {
    throw new SqlFault(512, 'Subquery returned more than 1 value. This is not permitted when the subquery follows =, !=, <, <= , >, >= or when the subquery is used as an expression.');
  }
  return result.rows[0]?.[0] ?? tv((result.columns[0] as OutColumn).type, null);
}

function evalScalar(ctx: Exec, e: Expr, scope: Scope): TV {
  switch (e.k) {
    case 'lit':
      return e.value;
    case 'null':
      return tv(INT, null);
    case 'var':
      return readVariable(ctx, e.name);
    case 'global':
      if (e.name === 'ROWCOUNT') return tv(INT, ctx.rowcount);
      if (e.name === 'TRANCOUNT') return tv(INT, ctx.session.tx === null ? 0 : 1);
      throw new Unmodelled(`@@${e.name}`);
    case 'col':
      return resolveColumn(scope, e.parts);
    case 'fn':
      return evalFunction(ctx, e, scope);
    case 'cast': {
      const style = e.style === undefined ? undefined : evalScalar(ctx, e.style, scope);
      return convert(evalScalar(ctx, e.expr, scope), e.type, {
        style: style === undefined || style.v === null ? undefined : Number(intOf(style, INT)),
      });
    }
    case 'case':
      return evalCase(ctx, e, scope);
    case 'arith':
      return evalArith(ctx, e, scope);
    case 'neg':
      return negate(evalScalar(ctx, e.expr, scope));
    case 'collate': {
      const value = evalScalar(ctx, e.expr, scope);
      if (familyOf(value.type) !== 'char') throw new SqlFault(447, `Expression type ${value.type.base} is invalid for COLLATE clause.`);
      return { type: value.type, v: value.v, collation: e.collation };
    }
    case 'subquery':
      return scalarSubquery(ctx, e.select, scope);
    default:
      throw new Unmodelled('a condition used as a value');
  }
}

/** Three-valued truth of a condition: true, false or null (unknown). */
function evalBool(ctx: Exec, e: Expr, scope: Scope): boolean | null {
  switch (e.k) {
    case 'cmp': {
      const order = compareTv(evalScalar(ctx, e.left, scope), evalScalar(ctx, e.right, scope), OPERATOR_NAMES[e.op]);
      if (order === null) return null;
      switch (e.op) {
        case '=':
          return order === 0;
        case '<>':
          return order !== 0;
        case '<':
          return order < 0;
        case '>':
          return order > 0;
        case '<=':
          return order <= 0;
        case '>=':
          return order >= 0;
      }
      break;
    }
    case 'and': {
      const left = evalBool(ctx, e.left, scope);
      if (left === false) return false;
      const right = evalBool(ctx, e.right, scope);
      if (right === false) return false;
      return left === null || right === null ? null : true;
    }
    case 'or': {
      const left = evalBool(ctx, e.left, scope);
      if (left === true) return true;
      const right = evalBool(ctx, e.right, scope);
      if (right === true) return true;
      return left === null || right === null ? null : false;
    }
    case 'not': {
      const inner = evalBool(ctx, e.expr, scope);
      return inner === null ? null : !inner;
    }
    case 'isnull':
      return (evalScalar(ctx, e.expr, scope).v === null) !== e.negated;
    case 'in': {
      const value = evalScalar(ctx, e.expr, scope);
      let unknown = false;
      for (const item of e.list) {
        const order = compareTv(value, evalScalar(ctx, item, scope));
        if (order === 0) return !e.negated;
        if (order === null) unknown = true;
      }
      return unknown ? null : e.negated;
    }
    default:
      break;
  }
  throw new Unmodelled('a value used as a condition');
}


// ---------------------------------------------------------------------------------------------------------------------
// Catalog views

function col(name: string, type: SqlType, nullable = false): OutColumn {
  return { name, type, nullable };
}

const FIXED_BYTES: Readonly<Partial<Record<LegacyColumnType, number>>> = {
  tinyint: 1,
  smallint: 2,
  int: 4,
  bigint: 8,
  bit: 1,
  float: 8,
  money: 8,
  datetime: 8,
  smalldatetime: 4,
  datetime2: 8,
  uniqueidentifier: 16,
};
const PRECISIONS: Readonly<Partial<Record<LegacyColumnType, number>>> = {
  tinyint: 3,
  smallint: 5,
  int: 10,
  bigint: 19,
  float: 53,
  money: 19,
};

function charMax(type: SqlType): number | null {
  if (type.base === 'text' || type.base === 'image') return 2147483647;
  if (type.base === 'ntext') return 1073741823;
  if (!LENGTH_TYPES.has(type.base)) return null;
  return type.length === 'max' ? -1 : (type.length ?? 1);
}

function octetLength(type: SqlType): number | null {
  if (type.base === 'ntext') return 2147483646;
  const max = charMax(type);
  return max === null || max < 0 || !UNICODE_TYPES.has(type.base) ? max : max * 2;
}

function numericPrecision(type: SqlType): number | null {
  if (type.base === 'decimal' || type.base === 'numeric') return type.precision ?? 18;
  return PRECISIONS[type.base] ?? null;
}

function numericScale(type: SqlType): number | null {
  if (type.base === 'decimal' || type.base === 'numeric') return type.scale ?? 0;
  if (type.base === 'money') return 4;
  return familyOf(type) === 'int' && type.base !== 'bit' ? 0 : null;
}

function datetimePrecision(type: SqlType): number | null {
  if (type.base === 'datetime') return 3;
  if (type.base === 'smalldatetime') return 0;
  return type.base === 'datetime2' ? (type.scale ?? 7) : null;
}

/** `sys.columns.max_length`: bytes, -1 for max, 16 for large-object pointers. */
function maxBytes(type: SqlType): number {
  if (LOB_TYPES.has(type.base)) return 16;
  if (LENGTH_TYPES.has(type.base)) {
    return type.length === 'max' ? -1 : (type.length ?? 1) * (UNICODE_TYPES.has(type.base) ? 2 : 1);
  }
  if (type.base === 'decimal' || type.base === 'numeric') {
    const precision = type.precision ?? 18;
    return precision <= 9 ? 5 : precision <= 19 ? 9 : precision <= 28 ? 13 : 17;
  }
  return FIXED_BYTES[type.base] ?? 8;
}

function tablesOf(db: Database): Table[] {
  return [...db.tables.values()];
}

function infoColumnsSource(db: Database, alias: string): Source {
  const columns = [
    col('TABLE_CATALOG', SYSNAME),
    col('TABLE_SCHEMA', SYSNAME),
    col('TABLE_NAME', SYSNAME),
    col('COLUMN_NAME', SYSNAME),
    col('ORDINAL_POSITION', INT),
    col('COLUMN_DEFAULT', { base: 'nvarchar', length: 4000 }, true),
    col('IS_NULLABLE', { base: 'varchar', length: 3 }),
    col('DATA_TYPE', SYSNAME),
    col('CHARACTER_MAXIMUM_LENGTH', INT, true),
    col('CHARACTER_OCTET_LENGTH', INT, true),
    col('NUMERIC_PRECISION', TINYINT, true),
    col('NUMERIC_PRECISION_RADIX', SMALLINT, true),
    col('NUMERIC_SCALE', INT, true),
    col('DATETIME_PRECISION', SMALLINT, true),
  ];
  const rows = tablesOf(db).flatMap(({ def }) =>
    def.columns.map((column, index): Stored[] => {
      const precision = numericPrecision(column.type);
      return [
        db.name,
        def.schema,
        def.name,
        column.name,
        index + 1,
        null,
        column.nullable ? 'YES' : 'NO',
        column.type.base,
        charMax(column.type),
        octetLength(column.type),
        precision,
        precision === null ? null : column.type.base === 'float' ? 2 : 10,
        numericScale(column.type),
        datetimePrecision(column.type),
      ];
    }),
  );
  return { alias, columns, rows };
}

function infoTablesSource(db: Database, alias: string): Source {
  const columns = [col('TABLE_CATALOG', SYSNAME), col('TABLE_SCHEMA', SYSNAME), col('TABLE_NAME', SYSNAME), col('TABLE_TYPE', { base: 'varchar', length: 10 })];
  return { alias, columns, rows: tablesOf(db).map(({ def }) => [db.name, def.schema, def.name, 'BASE TABLE']) };
}

function fileExistsSource(args: readonly TV[], alias: string): Source {
  if (args.length !== 1) throw new SqlFault(216, 'Parameters were not supplied for the function sys.dm_os_file_exists.');
  const path = args[0]?.v === null || args[0] === undefined ? null : textOf(args[0]);
  const probe = (target: string): { isDirectory(): boolean } | undefined => {
    try {
      return statSync(target, { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
  };
  const entry = path === null ? undefined : probe(path);
  const parent = path === null ? undefined : probe(dirname(path));
  const columns = [col('file_exists', TINYINT), col('file_is_a_directory', TINYINT), col('parent_directory_exists', TINYINT)];
  const flag = (value: boolean): number => (value ? 1 : 0);
  return {
    alias,
    columns,
    rows: [[flag(entry !== undefined && !entry.isDirectory()), flag(entry?.isDirectory() === true), flag(parent?.isDirectory() === true)]],
  };
}

/** Rows of the catalog views and functions the migration package reads; undefined for a user table name. */
function systemSource(ctx: Exec, db: Database, schema: string, name: string, alias: string, args: readonly TV[] | null): Source | undefined {
  const schemaName = schema.toLowerCase();
  const view = name.toLowerCase();
  if (schemaName === 'information_schema') {
    if (view === 'columns') return infoColumnsSource(db, alias);
    if (view === 'tables') return infoTablesSource(db, alias);
    throw new Unmodelled(`the view INFORMATION_SCHEMA.${name}`);
  }
  if (schemaName !== 'sys') return undefined;
  if (view === 'dm_os_file_exists') return fileExistsSource(args ?? [], alias);
  if (args !== null) throw new Unmodelled(`the function sys.${name}`);
  const tables = tablesOf(db);
  switch (view) {
    case 'tables':
      return {
        alias,
        columns: [
          col('name', SYSNAME),
          col('object_id', INT),
          col('schema_id', INT),
          col('type', { base: 'char', length: 2 }),
          col('type_desc', { base: 'nvarchar', length: 60 }),
          col('create_date', DATETIME),
          col('modify_date', DATETIME),
          col('is_ms_shipped', BIT),
        ],
        rows: tables.map(({ def }) => [def.name, def.objectId, schemaOf(db, def.schema)?.id ?? null, 'U ', 'USER_TABLE', def.createDate, def.modifyDate, 0]),
      };
    case 'schemas':
      return {
        alias,
        columns: [col('name', SYSNAME), col('schema_id', INT), col('principal_id', INT, true)],
        rows: [...BUILTIN_SCHEMAS.values(), ...[...db.schemas.values()].filter((s) => s.name.toLowerCase() !== 'dbo')].map((s) => [s.name, s.id, 1]),
      };
    case 'columns':
      return {
        alias,
        columns: [
          col('object_id', INT),
          col('name', SYSNAME),
          col('column_id', INT),
          col('max_length', SMALLINT),
          col('precision', TINYINT),
          col('scale', TINYINT),
          col('is_nullable', BIT),
          col('is_identity', BIT),
        ],
        rows: tables.flatMap(({ def }) =>
          def.columns.map((column, index): Stored[] => [
            def.objectId,
            column.name,
            index + 1,
            maxBytes(column.type),
            numericPrecision(column.type) ?? 0,
            numericScale(column.type) ?? datetimePrecision(column.type) ?? 0,
            column.nullable ? 1 : 0,
            column.identity ? 1 : 0,
          ]),
        ),
      };
    case 'indexes':
      return {
        alias,
        columns: [
          col('object_id', INT),
          col('name', SYSNAME, true),
          col('index_id', INT),
          col('type', TINYINT),
          col('type_desc', { base: 'nvarchar', length: 60 }),
          col('is_unique', BIT),
          col('is_primary_key', BIT),
        ],
        rows: tables.map(({ def }): Stored[] =>
          def.primaryKey.length === 0
            ? [def.objectId, null, 0, 0, 'HEAP', 0, 0]
            : [def.objectId, def.pkName, 1, 1, 'CLUSTERED', 1, 1],
        ),
      };
    case 'index_columns':
      return {
        alias,
        columns: [
          col('object_id', INT),
          col('index_id', INT),
          col('index_column_id', INT),
          col('column_id', INT),
          col('key_ordinal', TINYINT),
          col('is_descending_key', BIT),
          col('is_included_column', BIT),
        ],
        rows: tables.flatMap(({ def }) => def.primaryKey.map((column, position): Stored[] => [def.objectId, 1, position + 1, column + 1, position + 1, 0, 0])),
      };
    case 'identity_columns':
      return {
        alias,
        columns: [col('object_id', INT), col('name', SYSNAME), col('column_id', INT), col('seed_value', INT), col('increment_value', INT), col('last_value', INT, true)],
        rows: tables.flatMap(({ def, identity }) =>
          def.identityColumn === null || identity === null
            ? []
            : [[def.objectId, (def.columns[def.identityColumn] as ColumnDef).name, def.identityColumn + 1, identity.seed, identity.increment, identity.current]],
        ),
      };
    case 'master_files':
      return {
        alias,
        columns: [
          col('database_id', INT),
          col('file_id', INT),
          col('type', TINYINT),
          col('type_desc', { base: 'nvarchar', length: 60 }),
          col('name', SYSNAME),
          col('physical_name', { base: 'nvarchar', length: 260 }),
          col('state', TINYINT),
          col('state_desc', { base: 'nvarchar', length: 60 }),
        ],
        rows: ctx.server
          .allDatabases()
          .flatMap((database) => database.files.map((file): Stored[] => [database.id, file.fileId, file.type === 'D' ? 0 : 1, file.type === 'D' ? 'ROWS' : 'LOG', file.logicalName, file.physicalName, 0, 'ONLINE'])),
      };
    default:
      throw new Unmodelled(`the catalog view sys.${name}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Statements

interface SelectResult {
  readonly columns: readonly OutColumn[];
  readonly rows: readonly (readonly TV[])[];
}

type OutputSpec =
  | { readonly kind: 'column'; readonly column: OutColumn; readonly source: number; readonly index: number }
  | { readonly kind: 'expr'; readonly name: string; readonly expr: Expr };

function locate(ctx: Exec, parts: readonly string[]): { db: Database; schema: string; name: string } {
  const name = parts[parts.length - 1] as string;
  const schema = parts.length >= 2 ? (parts[parts.length - 2] as string) || 'dbo' : 'dbo';
  if (parts.length < 3) return { db: ctx.session.db, schema, name };
  const db = ctx.server.findDb(parts[0] as string);
  if (db === undefined) throw new SqlFault(208, `Invalid object name '${parts.join('.')}'.`);
  return { db, schema, name };
}

function resolveTable(ctx: Exec, parts: readonly string[]): { db: Database; table: Table } {
  const { db, schema, name } = locate(ctx, parts);
  const table = db.tables.get(tableKey(schema, name));
  if (table === undefined) throw new SqlFault(208, `Invalid object name '${parts.join('.')}'.`);
  return { db, table };
}

/** The table version a statement reads: its own autocommit work, the open transaction's, or the committed one. */
function rowSetFor(ctx: Exec, table: Table): RowSet {
  return ctx.implicit?.work.get(table)?.set ?? ctx.session.tx?.work.get(table)?.set ?? table.data;
}

function tableColumns(def: TableDef): OutColumn[] {
  return def.columns.map((column) => col(column.name, column.type, column.nullable));
}

function sourceFor(ctx: Exec, ref: TableRef, outer: Scope | undefined): Source {
  const { db, schema, name } = locate(ctx, ref.parts);
  const alias = (ref.alias ?? name).toLowerCase();
  const args = ref.args === null ? null : ref.args.map((arg) => evalScalar(ctx, arg, outer ?? EMPTY_SCOPE));
  const system = systemSource(ctx, db, schema, name, alias, args);
  if (system !== undefined) return system;
  if (args !== null) throw new Unmodelled(`the table-valued function ${ref.parts.join('.')}`);
  const table = db.tables.get(tableKey(schema, name));
  if (table === undefined) throw new SqlFault(208, `Invalid object name '${ref.parts.join('.')}'.`);
  return { alias, columns: tableColumns(table.def), rows: scanRows(table.def, rowSetFor(ctx, table)).map((row) => row.values) };
}

function outputSpecs(items: readonly SelectItem[], sources: readonly Source[]): OutputSpec[] {
  const specs: OutputSpec[] = [];
  for (const item of items) {
    if (item.kind === 'expr') {
      const name = item.alias ?? (item.expr.k === 'col' ? (item.expr.parts[item.expr.parts.length - 1] as string) : '');
      specs.push({ kind: 'expr', name, expr: item.expr });
      continue;
    }
    if (item.kind === 'assign') {
      throw new SqlFault(141, 'A SELECT statement that assigns a value to a variable must not be combined with data-retrieval operations.');
    }
    if (sources.length === 0) throw new SqlFault(263, 'Must specify table to select from.');
    const qualifier = item.qualifier?.toLowerCase() ?? null;
    const matched = sources.flatMap((source, index) => (qualifier === null || source.alias === qualifier ? [index] : []));
    if (matched.length === 0) {
      throw new SqlFault(107, `The column prefix '${item.qualifier ?? ''}' does not match with a table name or alias name used in the query.`);
    }
    for (const source of matched) {
      (sources[source] as Source).columns.forEach((column, index) => specs.push({ kind: 'column', column, source, index }));
    }
  }
  return specs;
}

function cellOf(ctx: Exec, spec: OutputSpec, scope: Scope): TV {
  if (spec.kind === 'expr') return evalScalar(ctx, spec.expr, scope);
  return tv(spec.column.type, scope.row[spec.source]?.[spec.index] ?? null);
}

function runSelect(ctx: Exec, s: SelectStmt, outer?: Scope): SelectResult {
  const sources: Source[] = [];
  let combos: (readonly Stored[])[][] = [[]];
  if (s.from !== null) {
    const refs = [s.from.first, ...s.from.joins.map((join) => join.ref)];
    refs.forEach((ref, index) => {
      const source = sourceFor(ctx, ref, outer);
      if (sources.some((existing) => existing.alias === source.alias)) {
        throw new SqlFault(1011, `The correlation name '${source.alias}' is specified multiple times in a FROM clause.`);
      }
      sources.push(source);
      if (index === 0) {
        combos = source.rows.map((row) => [row]);
        return;
      }
      const on = (s.from as FromClause).joins[index - 1]?.on as Expr;
      const reach = [...sources];
      const joined: (readonly Stored[])[][] = [];
      for (const combo of combos) {
        for (const row of source.rows) {
          const candidate = [...combo, row];
          if (evalBool(ctx, on, { sources: reach, row: candidate, outer }) === true) joined.push(candidate);
        }
      }
      combos = joined;
    });
  }
  const where = s.where;
  const filtered = where === null ? combos : combos.filter((row) => evalBool(ctx, where, { sources, row, outer }) === true);
  const specs = outputSpecs(s.items, sources);
  const grouped = s.items.some((item) => item.kind === 'expr' && hasAggregate(item.expr));
  const scopes: Scope[] = grouped
    ? [{ sources, row: filtered[0] ?? [], group: filtered, outer }]
    : filtered.map((row) => ({ sources, row, outer }));
  let rows = scopes.map((scope) => ({ scope, cells: specs.map((spec) => cellOf(ctx, spec, scope)) }));
  const columns = specs.map((spec, index): OutColumn => {
    if (spec.kind === 'column') return spec.column;
    const type = rows[0]?.cells[index]?.type ?? typeOfExpr(ctx, spec.expr, { sources, row: [], outer });
    return col(spec.name, type, true);
  });
  if (s.distinct) {
    const seen = new Set<string>();
    rows = rows.filter((row) => {
      const key = row.cells.map((cell) => keyOf(cell.type, cell.v)).join('\u0001');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (s.orderBy.length > 0) {
    const keyed = rows.map((row, position) => {
      const aliases = new Map<string, TV>();
      columns.forEach((column, index) => {
        const key = column.name.toLowerCase();
        if (key !== '' && !aliases.has(key)) aliases.set(key, row.cells[index] as TV);
      });
      const scope: Scope = { ...row.scope, aliases };
      return { row, position, keys: s.orderBy.map((item) => evalScalar(ctx, item.expr, scope)) };
    });
    keyed.sort((a, b) => {
      for (const [index, item] of s.orderBy.entries()) {
        const order = orderValues(a.keys[index] as TV, b.keys[index] as TV);
        if (order !== 0) return item.desc ? -order : order;
      }
      return a.position - b.position;
    });
    rows = keyed.map((entry) => entry.row);
  }
  if (s.top !== null) {
    const top = evalScalar(ctx, s.top, outer ?? EMPTY_SCOPE);
    const count = top.v === null ? 0 : Number(intOf(top, BIGINT));
    if (count < 0) throw new SqlFault(1014, 'A TOP or FETCH clause contains an invalid value.');
    rows = rows.slice(0, count);
  }
  return { columns, rows: rows.map((row) => row.cells) };
}

function execSelect(ctx: Exec, s: SelectStmt): void {
  if (s.items.some((item) => item.kind === 'assign')) {
    if (!s.items.every((item) => item.kind === 'assign') || s.from !== null) {
      throw new Unmodelled('SELECT variable assignment combined with a FROM clause or result columns');
    }
    for (const item of s.items) if (item.kind === 'assign') writeVariable(ctx, item.name, evalScalar(ctx, item.expr, EMPTY_SCOPE));
    ctx.rowcount = 1;
    return;
  }
  const result = runSelect(ctx, s);
  ctx.out.push({ kind: 'rows', columns: result.columns, rows: result.rows.map((cells) => cells.map(driverValue)) });
  ctx.rowcount = result.rows.length;
}

/** Runs `run` in the session's transaction, or in a single-statement autocommit transaction committed after it. */
function withWrite<T>(ctx: Exec, db: Database, run: (tx: TxState) => T): T {
  if (db.readOnly) throw readOnlyFault(db);
  if (ctx.session.tx !== null) return run(ctx.session.tx);
  const tx: TxState = { id: null, db: ctx.session.db, work: new Map(), statements: [] };
  ctx.implicit = tx;
  try {
    const result = run(tx);
    ctx.server.commitImplicit(tx);
    return result;
  } finally {
    ctx.implicit = null;
  }
}

function columnIndex(def: TableDef, name: string): number {
  const lower = name.toLowerCase();
  const index = def.columns.findIndex((column) => column.name.toLowerCase() === lower);
  if (index < 0) throw new SqlFault(207, `Invalid column name '${name}'.`);
  return index;
}

function assignValue(db: Database, def: TableDef, index: number, value: TV, verb: 'INSERT' | 'UPDATE'): Stored {
  const column = def.columns[index] as ColumnDef;
  const label = tableLabel(db, def);
  const stored = convert(value, column.type, { assign: { table: label, column: column.name } }).v;
  if (stored === null && !column.nullable) {
    throw new SqlFault(515, `Cannot insert the value NULL into column '${column.name}', table '${label}'; column does not allow nulls. ${verb} fails.`);
  }
  return stored;
}

function nextIdentity(table: Table): number {
  const state = table.identity as IdentityState;
  state.current = state.current === null ? state.seed : state.current + state.increment;
  return state.current;
}

/** An explicit identity value moves the identity past it, as SQL Server does. */
function observeIdentity(table: Table, value: Stored): void {
  const state = table.identity;
  if (state === null || value === null) return;
  const n = Number(value);
  if (state.current === null || (state.increment > 0 ? n > state.current : n < state.current)) state.current = n;
}

function buildRow(server: FakeServer, db: Database, table: Table, given: ReadonlyMap<number, TV>): StoredRow {
  const def = table.def;
  const values = def.columns.map((column, index): Stored => {
    const value = given.get(index);
    if (value !== undefined) return assignValue(db, def, index, value, 'INSERT');
    if (column.identity) {
      const next = nextIdentity(table);
      return column.type.base === 'bigint' ? BigInt(next) : next;
    }
    return assignValue(db, def, index, column.defaultValue?.() ?? tv(column.type, null), 'INSERT');
  });
  if (def.identityColumn !== null && given.has(def.identityColumn)) observeIdentity(table, values[def.identityColumn] ?? null);
  return { rid: server.nextRid(), values };
}

function insertRows(def: TableDef, work: TableWork, rows: readonly StoredRow[]): void {
  const index = work.set.index;
  if (index !== null) {
    const added = new Set<string>();
    for (const row of rows) {
      const key = rowKey(def, row.values);
      if (index.has(key) || added.has(key)) throw duplicateKeyFault(def, row.values);
      added.add(key);
    }
  }
  workInsert(def, work, rows);
}

function duplicateColumnFault(name: string): SqlFault {
  return new SqlFault(264, `The column name '${name}' is specified more than once in the SET clause or column list of an INSERT. A column cannot be assigned more than one value in the same clause.`);
}

function execInsert(ctx: Exec, s: Extract<Stmt, { k: 'insert' }>): void {
  const { db, table } = resolveTable(ctx, s.table);
  const def = table.def;
  const targets = s.columns === null ? def.columns.flatMap((column, index) => (column.identity ? [] : [index])) : s.columns.map((name) => columnIndex(def, name));
  const seen = new Set<number>();
  for (const index of targets) {
    if (seen.has(index)) throw duplicateColumnFault((def.columns[index] as ColumnDef).name);
    seen.add(index);
  }
  const explicitIdentity = def.identityColumn !== null && seen.has(def.identityColumn);
  if (explicitIdentity && ctx.session.identityInsert !== table) {
    throw new SqlFault(544, `Cannot insert explicit value for identity column in table '${def.name}' when IDENTITY_INSERT is set to OFF.`);
  }
  if (!explicitIdentity && def.identityColumn !== null && ctx.session.identityInsert === table) {
    throw new SqlFault(
      545,
      `Explicit value must be specified for identity column in table '${def.name}' either when IDENTITY_INSERT is set to ON or when a replication user is inserting into a NOT FOR REPLICATION identity column.`,
    );
  }
  withWrite(ctx, db, (tx) => {
    const rows = s.rows.map((exprs) => {
      if (exprs.length !== targets.length) {
        throw exprs.length > targets.length
          ? new SqlFault(110, 'There are fewer columns in the INSERT statement than values specified in the VALUES clause. The number of values in the VALUES clause must match the number of columns specified in the INSERT statement.')
          : new SqlFault(109, 'There are more columns in the INSERT statement than values specified in the VALUES clause. The number of values in the VALUES clause must match the number of columns specified in the INSERT statement.');
      }
      const given = new Map(targets.map((index, position) => [index, evalScalar(ctx, exprs[position] as Expr, EMPTY_SCOPE)]));
      return buildRow(ctx.server, db, table, given);
    });
    insertRows(def, workOf(tx, table), rows);
    ctx.out.push({ kind: 'count', count: rows.length });
    ctx.rowcount = rows.length;
  });
}

/** Checks that keys an UPDATE moves collide neither with rows it leaves alone nor with each other. */
function checkMovedKeys(def: TableDef, work: TableWork, changes: readonly (readonly [StoredRow, StoredRow])[]): void {
  const index = work.set.index;
  if (index === null) return;
  const vacated = new Set<string>();
  const moved: (readonly [string, StoredRow])[] = [];
  for (const [before, after] of changes) {
    const oldKey = rowKey(def, before.values);
    const newKey = rowKey(def, after.values);
    if (oldKey === newKey) continue;
    vacated.add(oldKey);
    moved.push([newKey, after]);
  }
  const taken = new Set<string>();
  for (const [key, row] of moved) {
    if ((index.has(key) && !vacated.has(key)) || taken.has(key)) throw duplicateKeyFault(def, row.values);
    taken.add(key);
  }
}

function tableScope(def: TableDef, row: StoredRow): Scope {
  return { sources: [{ alias: def.name.toLowerCase(), columns: tableColumns(def), rows: [] }], row: [row.values] };
}

function execUpdate(ctx: Exec, s: Extract<Stmt, { k: 'update' }>): void {
  const { db, table } = resolveTable(ctx, s.table);
  const def = table.def;
  const sets = s.set.map((item) => ({ index: columnIndex(def, item.column), expr: item.expr }));
  const seen = new Set<number>();
  for (const { index } of sets) {
    const column = def.columns[index] as ColumnDef;
    if (seen.has(index)) throw duplicateColumnFault(column.name);
    if (column.identity) throw new SqlFault(8102, `Cannot update identity column '${column.name}'.`);
    seen.add(index);
  }
  withWrite(ctx, db, (tx) => {
    const work = workOf(tx, table);
    const changes: (readonly [StoredRow, StoredRow])[] = [];
    for (const row of scanRows(def, work.set)) {
      const scope = tableScope(def, row);
      if (s.where !== null && evalBool(ctx, s.where, scope) !== true) continue;
      const values = [...row.values];
      for (const { index, expr } of sets) values[index] = assignValue(db, def, index, evalScalar(ctx, expr, scope), 'UPDATE');
      changes.push([row, { rid: row.rid, values }]);
    }
    checkMovedKeys(def, work, changes);
    workUpdate(def, work, changes);
    ctx.out.push({ kind: 'count', count: changes.length });
    ctx.rowcount = changes.length;
  });
}

function execDelete(ctx: Exec, s: Extract<Stmt, { k: 'delete' }>): void {
  const { db, table } = resolveTable(ctx, s.table);
  const def = table.def;
  const top = s.top === null ? null : evalScalar(ctx, s.top, EMPTY_SCOPE);
  const limit = top === null ? Number.POSITIVE_INFINITY : top.v === null ? 0 : Number(intOf(top, BIGINT));
  if (limit < 0) throw new SqlFault(1014, 'A TOP or FETCH clause contains an invalid value.');
  withWrite(ctx, db, (tx) => {
    const work = workOf(tx, table);
    const doomed: StoredRow[] = [];
    for (const row of scanRows(def, work.set)) {
      if (doomed.length >= limit) break;
      if (s.where === null || evalBool(ctx, s.where, tableScope(def, row)) === true) doomed.push(row);
    }
    workDelete(def, work, doomed);
    ctx.out.push({ kind: 'count', count: doomed.length });
    ctx.rowcount = doomed.length;
  });
}

function execIdentityInsert(ctx: Exec, s: Extract<Stmt, { k: 'identityInsert' }>): void {
  const { table } = resolveTable(ctx, s.table);
  if (table.identity === null) {
    throw new SqlFault(8106, `Table '${table.def.name}' does not have the identity property. Cannot perform SET operation.`);
  }
  const current = ctx.session.identityInsert;
  if (s.on) {
    if (current !== null && current !== table) {
      throw new SqlFault(8107, `IDENTITY_INSERT is already ON for table '${current.def.name}'. Cannot perform SET operation for table '${table.def.name}'.`);
    }
    ctx.session.identityInsert = table;
  } else if (current === table) {
    ctx.session.identityInsert = null;
  }
  ctx.rowcount = 0;
}

function execCreateTable(ctx: Exec, s: Extract<Stmt, { k: 'createTable' }>): void {
  const { db, schema, name } = locate(ctx, s.table);
  const inline = s.columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (inline.length > 1 || (inline.length > 0 && s.pk !== null)) {
    throw new SqlFault(8110, `Cannot add multiple PRIMARY KEY constraints to table '${name}'.`);
  }
  const primaryKey = s.pk?.columns ?? inline;
  const columns = s.columns.map((column): ColumnSpec => {
    const expr = column.defaultExpr;
    if (expr !== null && expr.k !== 'lit' && expr.k !== 'null') throw new Unmodelled('a DEFAULT that is not a constant');
    const value = expr === null ? undefined : evalScalar(ctx, expr, EMPTY_SCOPE);
    return { name: column.name, type: column.type, nullable: column.nullable, identity: column.identity, defaultValue: value === undefined ? undefined : () => value };
  });
  const pkName = primaryKey.length === 0 ? null : (s.pk?.name ?? `PK__${name}`);
  ctx.server.createTable(db, { schema, name, columns, primaryKey, pkName });
}

function pathOf(ctx: Exec, e: Expr): string {
  const path = textArg(ctx, e, EMPTY_SCOPE);
  if (path === null || path === '') throw new SqlFault(3201, 'Cannot open backup device. Operating system error 2(The system cannot find the file specified.).');
  return path;
}

const BACKUP_OPTIONS: ReadonlySet<string> = new Set([
  'COPY_ONLY',
  'CHECKSUM',
  'NO_CHECKSUM',
  'INIT',
  'NOINIT',
  'FORMAT',
  'NOFORMAT',
  'SKIP',
  'NOSKIP',
  'COMPRESSION',
  'NO_COMPRESSION',
  'STATS',
  'NAME',
  'DESCRIPTION',
]);
const RESTORE_OPTIONS: ReadonlySet<string> = new Set(['RECOVERY', 'REPLACE', 'STATS', 'CHECKSUM', 'NO_CHECKSUM', 'NOUNLOAD', 'FILE']);
const FILELIST_OPTIONS: ReadonlySet<string> = new Set(['FILE', 'CHECKSUM', 'NO_CHECKSUM']);

function optionsOf(options: readonly WithOption[], allowed: ReadonlySet<string>, what: string): Map<string, Expr | null> {
  const named = new Map<string, Expr | null>();
  for (const option of options) {
    if (!allowed.has(option.name)) throw new Unmodelled(`the ${what} option ${option.name}`);
    named.set(option.name, option.value);
  }
  return named;
}

function fileNumber(ctx: Exec, options: ReadonlyMap<string, Expr | null>): number {
  const value = options.get('FILE');
  if (value === undefined || value === null) return 1;
  return Number(intOf(evalScalar(ctx, value, EMPTY_SCOPE), INT));
}

function execStatement(ctx: Exec, s: Stmt): void {
  switch (s.k) {
    case 'select':
      return execSelect(ctx, s);
    case 'insert':
      return execInsert(ctx, s);
    case 'update':
      return execUpdate(ctx, s);
    case 'delete':
      return execDelete(ctx, s);
    case 'declare':
      for (const variable of s.vars) {
        const key = variableKey(variable.name);
        if (ctx.vars.has(key) || ctx.params.has(key)) {
          throw new SqlFault(134, `The variable name '${variable.name}' has already been declared. Variable names must be unique within a query batch or stored procedure.`);
        }
        const init = variable.init === null ? tv(variable.type, null) : evalScalar(ctx, variable.init, EMPTY_SCOPE);
        ctx.vars.set(key, convert(init, variable.type));
      }
      return;
    case 'setVar':
      writeVariable(ctx, s.name, evalScalar(ctx, s.expr, EMPTY_SCOPE));
      ctx.rowcount = 1;
      return;
    case 'identityInsert':
      return execIdentityInsert(ctx, s);
    case 'if':
      if (evalBool(ctx, s.cond, EMPTY_SCOPE) === true) execStatement(ctx, s.then);
      else if (s.otherwise !== null) execStatement(ctx, s.otherwise);
      return;
    case 'block':
      return execStatements(ctx, s.body);
    case 'try':
      try {
        execStatements(ctx, s.body);
      } catch (error) {
        if (!(error instanceof SqlFault)) throw error;
        ctx.caught.push(error);
        try {
          execStatements(ctx, s.handler);
        } finally {
          ctx.caught.pop();
        }
      }
      return;
    case 'throw': {
      const caught = ctx.caught[ctx.caught.length - 1];
      if (caught === undefined) {
        throw new SqlFault(10704, 'To rethrow an error, a THROW statement must be used inside a CATCH block.');
      }
      throw caught;
    }
    case 'exec': {
      const text = textArg(ctx, s.expr, EMPTY_SCOPE);
      if (text === null) return;
      const batch = ctx.server.parse(text);
      const nested: Exec = { ...ctx, params: new Map(), vars: new Map(), caught: [], batch, implicit: null };
      execStatements(nested, batch);
      ctx.rowcount = nested.rowcount;
      return;
    }
    case 'createSchema':
      if (ctx.batch[0] !== s) throw new SqlFault(111, "'CREATE SCHEMA' must be the first statement in a query batch.");
      ctx.server.createSchema(ctx.session.db, s.name);
      return;
    case 'createTable':
      return execCreateTable(ctx, s);
    case 'backup': {
      const options = optionsOf(s.options, BACKUP_OPTIONS, 'BACKUP');
      ctx.server.backup(ctx.session, s.db, pathOf(ctx, s.disk), { init: options.has('INIT') || options.has('FORMAT'), copyOnly: options.has('COPY_ONLY') });
      return;
    }
    case 'fileList': {
      const options = optionsOf(s.options, FILELIST_OPTIONS, 'RESTORE FILELISTONLY');
      const token = ctx.server.fileList(ctx.session, pathOf(ctx, s.disk), fileNumber(ctx, options));
      ctx.out.push(token);
      ctx.rowcount = token.rows.length;
      return;
    }
    case 'restore': {
      const options = optionsOf(s.options, RESTORE_OPTIONS, 'RESTORE');
      const moves = s.moves.map((move) => ({ logical: pathOf(ctx, move.logical), physical: pathOf(ctx, move.physical) }));
      ctx.server.restore(ctx.session, s.db, pathOf(ctx, s.disk), { moves, replace: options.has('REPLACE'), file: fileNumber(ctx, options) });
      return;
    }
    case 'alterDb':
      ctx.server.alterDatabase(ctx.session, s.db, s.option, s.rollbackImmediate);
      return;
    case 'dropDb':
      for (const name of s.names) ctx.server.dropDatabase(ctx.session, name);
      return;
  }
}

function execStatements(ctx: Exec, statements: readonly Stmt[]): void {
  for (const statement of statements) execStatement(ctx, statement);
}


// ---------------------------------------------------------------------------------------------------------------------
// Server

type Fault =
  | { readonly kind: 'fail'; readonly predicate: (statement: StatementRecord) => boolean; readonly error: unknown }
  | { readonly kind: 'crash'; readonly predicate: (statement: StatementRecord) => boolean; readonly once: boolean };

/** A bound parameter as a front end received it; `declaration` names the declared type of a typed parameter. */
interface ParamInput {
  readonly value: unknown;
  readonly typed: boolean;
  readonly declaration?: unknown;
  readonly length?: unknown;
  readonly precision?: unknown;
  readonly scale?: unknown;
}

const PARSE_CACHE_LIMIT = 512;
const DEFAULT_DATA_PATH = '/var/opt/mssql/data/';
const MSDB = 'msdb';
const LIVE_DEFAULT = 'masa_test';

// modify_date must change whenever a schema changes, across servers too: catalog.ts memoises table metadata per
// database name for the process and revalidates it by table count, column count and the latest modify_date.
let lastDdlAt = 0;

function ddlInstant(): Date {
  lastDdlAt = Math.max(Date.now(), lastDdlAt + 10);
  return dateValue(wallOfDate(new Date(lastDdlAt)), DATETIME);
}

function spec(name: string, type: SqlType, nullable: boolean | undefined, identity = false): ColumnSpec {
  return { name, type, nullable, identity: identity ? { seed: 1, increment: 1 } : null, defaultValue: undefined };
}

const LSN: SqlType = { base: 'numeric', precision: 25, scale: 0 };

/** One in-memory SQL Server: databases, sessions, backup devices, the statement log and injected faults. */
class FakeServer {
  readonly dataPath: string;
  readonly statements: StatementRecord[] = [];
  readonly commits: CommitRecord[] = [];
  readonly faults: Fault[] = [];
  readonly #databases = new Map<string, Database>();
  readonly #sessions = new Set<Session>();
  readonly #backups = new Map<string, BackupSet[]>();
  readonly #parsed = new Map<string, readonly Stmt[]>();
  #lsn = 37_000_000_001_600_001n;
  #rid = 0;
  #txId = 0;
  #sessionId = 50;
  #databaseId = 5;
  #objectId = 245_575_913;
  #mediaSetId = 0;

  constructor(dataPath: string) {
    this.dataPath = /[\\/]$/.test(dataPath) ? dataPath : `${dataPath}/`;
    this.createDatabase(MASTER_DATABASE, { id: 1, system: true });
    const msdb = this.createDatabase(MSDB, { id: 4, system: true });
    const nvarchar = (length: number): SqlType => ({ base: 'nvarchar', length });
    this.createTable(msdb, {
      schema: 'dbo',
      name: 'backupmediafamily',
      columns: [spec('media_set_id', INT, false), spec('family_sequence_number', TINYINT, false), spec('physical_device_name', nvarchar(260), true)],
      primaryKey: ['media_set_id', 'family_sequence_number'],
      pkName: 'PK_backupmediafamily',
    });
    this.createTable(msdb, {
      schema: 'dbo',
      name: 'backupset',
      columns: [
        spec('backup_set_id', INT, false, true),
        spec('media_set_id', INT, false),
        spec('database_name', nvarchar(128), true),
        spec('backup_start_date', DATETIME, true),
        spec('backup_finish_date', DATETIME, true),
        spec('type', { base: 'char', length: 1 }, true),
        spec('is_copy_only', BIT, true),
        spec('first_lsn', LSN, true),
        spec('last_lsn', LSN, true),
        spec('checkpoint_lsn', LSN, true),
        spec('database_backup_lsn', LSN, true),
      ],
      primaryKey: ['backup_set_id'],
      pkName: 'PK_backupset',
    });
  }

  findDb(name: string): Database | undefined {
    return this.#databases.get(name.toLowerCase());
  }

  findDbById(id: number): Database | undefined {
    return [...this.#databases.values()].find((db) => db.id === id);
  }

  allDatabases(): Database[] {
    return [...this.#databases.values()];
  }

  nextRid(): number {
    this.#rid += 1;
    return this.#rid;
  }

  parse(text: string): readonly Stmt[] {
    const cached = this.#parsed.get(text);
    if (cached !== undefined) return cached;
    const parsed = new Parser(text).batch();
    if (this.#parsed.size >= PARSE_CACHE_LIMIT) {
      const oldest = this.#parsed.keys().next();
      if (oldest.done !== true) this.#parsed.delete(oldest.value);
    }
    this.#parsed.set(text, parsed);
    return parsed;
  }

  openSession(db: Database): Session {
    this.#sessionId += 1;
    const session: Session = { id: this.#sessionId, db, tx: null, identityInsert: null, killed: false };
    this.#sessions.add(session);
    return session;
  }

  /** Closes a connection; an open transaction on it is rolled back, as the server does on disconnect. */
  discard(session: Session): void {
    session.tx = null;
    session.killed = true;
    this.#sessions.delete(session);
  }

  /** Runs one batch on `session` and returns its result tokens. */
  execute(session: Session, sql: string, inputs: Readonly<Record<string, ParamInput>>): Token[] {
    if (session.killed) throw new SessionKilled('The connection was closed by the server');
    const raw: Record<string, unknown> = {};
    for (const [name, input] of Object.entries(inputs)) raw[name] = input.value;
    const record: StatementRecord = { database: session.db.name, sql, params: raw, txId: session.tx?.id ?? null, at: Date.now() };
    this.statements.push(record);
    session.tx?.statements.push(record);
    this.#inject(record);
    const db = session.db;
    if (db.userAccess === 'SINGLE_USER' && db.singleUser !== null && db.singleUser !== session && !db.singleUser.killed) {
      throw new SqlFault(924, `Database '${db.name}' is already open and can only have one user at a time.`);
    }
    try {
      const params = new Map<string, TV>();
      for (const [name, input] of Object.entries(inputs)) params.set(variableKey(name), this.#paramValue(input));
      const batch = this.parse(sql);
      const ctx: Exec = { server: this, session, params, vars: new Map(), out: [], caught: [], batch, rowcount: 0, implicit: null };
      execStatements(ctx, batch);
      return ctx.out;
    } catch (error) {
      if (error instanceof Unmodelled) throw new UnsupportedStatementError(sql, raw, error.message);
      throw error;
    }
  }

  #paramValue(input: ParamInput): TV {
    if (!input.typed) return paramValue(input.value, undefined);
    if (typeof input.declaration !== 'string') throw new Unmodelled('a parameter whose declared type has no name');
    return paramValue(input.value, paramType(input.declaration, input.length, input.precision, input.scale));
  }

  #inject(record: StatementRecord): void {
    const fail = this.faults.findIndex((fault) => fault.kind === 'fail' && fault.predicate(record));
    if (fail >= 0) {
      const [fault] = this.faults.splice(fail, 1);
      throw new InjectedFailure(fault?.kind === 'fail' ? fault.error : undefined);
    }
    const crash = this.faults.findIndex((fault) => fault.kind === 'crash' && fault.predicate(record));
    if (crash < 0) return;
    const fault = this.faults[crash];
    if (fault?.kind === 'crash' && fault.once) this.faults.splice(crash, 1);
    throw new CrashInjectedError(record);
  }

  begin(session: Session): number {
    if (session.killed) throw new SessionKilled('The connection was closed by the server');
    if (session.tx !== null) throw new Unmodelled('a nested transaction');
    this.#txId += 1;
    session.tx = { id: this.#txId, db: session.db, work: new Map(), statements: [] };
    return this.#txId;
  }

  /** Commits the session's transaction; a key conflict with another commit rolls it back and throws error 2627. */
  commit(session: Session): void {
    const tx = session.tx;
    if (tx === null) throw new SqlFault(3902, 'The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.');
    session.tx = null;
    if (mergeTx(tx)) this.#lsn += 1n;
    this.commits.push({ txId: tx.id as number, database: tx.db.name, statements: [...tx.statements] });
  }

  rollback(session: Session): void {
    session.tx = null;
  }

  commitImplicit(tx: TxState): void {
    if (mergeTx(tx)) this.#lsn += 1n;
  }

  /** Ends every other connection to `db`, rolling back its transaction, as `WITH ROLLBACK IMMEDIATE` does. */
  #kill(db: Database, except: Session): void {
    for (const session of this.#sessions) if (session !== except && session.db === db) this.discard(session);
  }

  /** Whether another connection has a transaction open on `db`. */
  #busy(db: Database, except: Session): boolean {
    for (const session of this.#sessions) if (session !== except && session.db === db && session.tx !== null) return true;
    return false;
  }

  createDatabase(name: string, opts: { id?: number; system?: boolean; files?: DbFile[] } = {}): Database {
    const files = opts.files ?? [
      { logicalName: name, type: 'D', physicalName: `${this.dataPath}${name}.mdf`, fileId: 1 },
      { logicalName: `${name}_log`, type: 'L', physicalName: `${this.dataPath}${name}_log.ldf`, fileId: 2 },
    ];
    let id = opts.id;
    if (id === undefined) {
      id = this.#databaseId;
      this.#databaseId += 1;
    }
    const db: Database = {
      name,
      id,
      system: opts.system ?? false,
      readOnly: false,
      userAccess: 'MULTI_USER',
      singleUser: null,
      schemas: new Map(),
      tables: new Map(),
      files,
      nextSchemaId: 5,
      dropped: false,
    };
    this.#databases.set(name.toLowerCase(), db);
    return db;
  }

  createSchema(db: Database, name: string): void {
    if (db.readOnly) throw readOnlyFault(db);
    if (schemaOf(db, name) !== undefined) throw new SqlFault(2714, `There is already an object named '${name}' in the database.`);
    db.schemas.set(name.toLowerCase(), { name, id: db.nextSchemaId });
    db.nextSchemaId += 1;
  }

  createTable(db: Database, table: TableSpec): Table {
    if (db.readOnly) throw readOnlyFault(db);
    const schema = schemaOf(db, table.schema);
    if (schema === undefined || schema.id === 3 || schema.id === 4) {
      throw new SqlFault(2760, `The specified schema name "${table.schema}" either does not exist or you do not have permission to use it.`);
    }
    const key = tableKey(schema.name, table.name);
    if (db.tables.has(key)) throw new SqlFault(2714, `There is already an object named '${table.name}' in the database.`);
    const names = new Set<string>();
    for (const column of table.columns) {
      const lower = column.name.toLowerCase();
      if (names.has(lower)) {
        throw new SqlFault(2705, `Column names in each table must be unique. Column name '${column.name}' in table '${table.name}' is specified more than once.`);
      }
      names.add(lower);
    }
    const primaryKey = table.primaryKey.map((name) => {
      const index = table.columns.findIndex((column) => column.name.toLowerCase() === name.toLowerCase());
      if (index < 0) throw new SqlFault(1911, `Column name '${name}' does not exist in the target table or view.`);
      return index;
    });
    const identities = table.columns.flatMap((column, index) => (column.identity === null ? [] : [index]));
    if (identities.length > 1) {
      throw new SqlFault(2744, `Multiple identity columns specified for table '${table.name}'. Only one identity column per table is allowed.`);
    }
    const columns = table.columns.map((column, index): ColumnDef => {
      const inKey = primaryKey.includes(index);
      if (inKey && (LOB_TYPES.has(column.type.base) || column.type.length === 'max')) {
        throw new SqlFault(1919, `Column '${column.name}' in table '${table.name}' is of a type that is invalid for use as a key column in an index.`);
      }
      if (inKey && column.nullable === true) throw new SqlFault(8111, `Cannot define PRIMARY KEY constraint on nullable column in table '${table.name}'.`);
      if (column.identity !== null && (column.nullable === true || familyOf(column.type) !== 'int' || column.type.base === 'bit')) {
        throw new SqlFault(
          2749,
          `Identity column '${column.name}' must be of data type int, bigint, smallint, tinyint, or decimal or numeric with a scale of 0, and constrained to be nonnullable.`,
        );
      }
      return {
        name: column.name,
        type: column.type,
        nullable: column.nullable ?? !(inKey || column.identity !== null),
        identity: column.identity !== null,
        defaultValue: column.defaultValue,
      };
    });
    const identityColumn = identities[0] ?? null;
    const identitySpec = identityColumn === null ? null : (table.columns[identityColumn] as ColumnSpec).identity;
    const created = ddlInstant();
    this.#objectId += 16;
    const def: TableDef = {
      schema: schema.name,
      name: table.name,
      columns,
      primaryKey,
      pkName: primaryKey.length === 0 ? null : (table.pkName ?? `PK__${table.name}`),
      identityColumn,
      objectId: this.#objectId,
      createDate: created,
      modifyDate: created,
    };
    const result: Table = {
      def,
      data: { rows: [], index: primaryKey.length === 0 ? null : new Map(), sorted: null },
      identity: identitySpec === null ? null : { seed: identitySpec.seed, increment: identitySpec.increment, current: null },
    };
    db.tables.set(key, result);
    return result;
  }

  backup(session: Session, name: string, path: string, opts: { init: boolean; copyOnly: boolean }): void {
    if (session.tx !== null) throw new SqlFault(3021, 'Cannot perform a backup or restore operation within a transaction.');
    const db = this.findDb(name);
    if (db === undefined) throw new SqlFault(911, `Database '${name}' does not exist. Make sure that the name is entered correctly.`);
    const startedAt = new Date();
    this.#lsn += 100_000n;
    const checkpointLsn = this.#lsn;
    this.#lsn += 1n;
    const lastLsn = this.#lsn;
    const set: BackupSet = {
      database: db.name,
      files: db.files.map((file) => ({ ...file })),
      schemas: new Map(db.schemas),
      tables: cloneTables(db.tables),
      nextSchemaId: db.nextSchemaId,
      readOnly: db.readOnly,
    };
    this.#backups.set(path, [...(opts.init ? [] : (this.#backups.get(path) ?? [])), set]);
    this.#mediaSetId += 1;
    const msdb = this.findDb(MSDB) as Database;
    this.insertDirect(msdb, this.#table(msdb, 'dbo', 'backupmediafamily'), [
      { media_set_id: this.#mediaSetId, family_sequence_number: 1, physical_device_name: path },
    ]);
    this.insertDirect(msdb, this.#table(msdb, 'dbo', 'backupset'), [
      {
        media_set_id: this.#mediaSetId,
        database_name: db.name,
        backup_start_date: startedAt,
        backup_finish_date: new Date(),
        type: 'D',
        is_copy_only: opts.copyOnly,
        first_lsn: String(checkpointLsn - 1n),
        last_lsn: String(lastLsn),
        checkpoint_lsn: String(checkpointLsn),
        database_backup_lsn: String(checkpointLsn),
      },
    ]);
  }

  #table(db: Database, schema: string, name: string): Table {
    return db.tables.get(tableKey(schema, name)) as Table;
  }

  #backupSet(path: string, file: number): BackupSet {
    const sets = this.#backups.get(path);
    if (sets === undefined) {
      throw new SqlFault(3201, `Cannot open backup device '${path}'. Operating system error 2(The system cannot find the file specified.).`);
    }
    const set = sets[file - 1];
    if (set === undefined) throw new SqlFault(4038, `Cannot find file ID ${String(file)} on device '${path}'.`);
    return set;
  }

  fileList(session: Session, path: string, file: number): Extract<Token, { kind: 'rows' }> {
    if (session.tx !== null) throw new SqlFault(3021, 'Cannot perform a backup or restore operation within a transaction.');
    const set = this.#backupSet(path, file);
    const size: SqlType = { base: 'numeric', precision: 20, scale: 0 };
    const columns = [
      col('LogicalName', SYSNAME),
      col('PhysicalName', { base: 'nvarchar', length: 260 }),
      col('Type', { base: 'char', length: 1 }),
      col('FileGroupName', SYSNAME, true),
      col('Size', size),
      col('MaxSize', size),
      col('FileId', BIGINT),
    ];
    const rows = set.files.map((entry) => [
      entry.logicalName,
      entry.physicalName,
      entry.type,
      entry.type === 'D' ? 'PRIMARY' : null,
      8_388_608,
      35_184_372_080_640,
      String(entry.fileId),
    ]);
    return { kind: 'rows', columns, rows };
  }

  restore(session: Session, name: string, path: string, opts: { moves: readonly { logical: string; physical: string }[]; replace: boolean; file: number }): void {
    if (session.tx !== null) throw new SqlFault(3021, 'Cannot perform a backup or restore operation within a transaction.');
    const set = this.#backupSet(path, opts.file);
    const existing = this.findDb(name);
    if (existing?.system === true) throw new SqlFault(3108, `To restore the ${existing.name} database, the server must be running in single-user mode.`);
    if (existing !== undefined && !opts.replace) {
      throw existing.name.toLowerCase() === set.database.toLowerCase()
        ? new SqlFault(3159, `The tail of the log for the database "${existing.name}" has not been backed up. Use the WITH REPLACE clause of the RESTORE statement to just overwrite the contents of the log.`)
        : new SqlFault(3154, `The backup set holds a backup of a database other than the existing '${existing.name}' database.`);
    }
    if (existing !== undefined && this.#busy(existing, session)) {
      throw new SqlFault(3101, 'Exclusive access could not be obtained because the database is in use.');
    }
    const moved = new Map(opts.moves.map((move) => [move.logical.toLowerCase(), move.physical]));
    for (const move of opts.moves) {
      if (!set.files.some((entry) => entry.logicalName.toLowerCase() === move.logical.toLowerCase())) {
        throw new SqlFault(3234, `Logical file '${move.logical}' is not part of database '${name}'. Use RESTORE FILELISTONLY to list the logical file names.`);
      }
    }
    const files = set.files.map((entry) => ({ ...entry, physicalName: moved.get(entry.logicalName.toLowerCase()) ?? entry.physicalName }));
    for (const entry of files) {
      const user = this.allDatabases().find((other) => other !== existing && other.files.some((f) => f.physicalName === entry.physicalName));
      if (user !== undefined) {
        throw new SqlFault(1834, `The file '${entry.physicalName}' cannot be overwritten.  It is being used by database '${user.name}'.`);
      }
    }
    const target = existing ?? this.createDatabase(name, { files });
    if (existing !== undefined) this.#kill(existing, session);
    target.files = files;
    target.schemas = new Map(set.schemas);
    target.tables = cloneTables(set.tables);
    target.nextSchemaId = set.nextSchemaId;
    target.readOnly = set.readOnly;
    target.userAccess = 'MULTI_USER';
    target.singleUser = null;
  }

  alterDatabase(session: Session, name: string, option: string, rollbackImmediate: boolean): void {
    if (session.tx !== null) throw new SqlFault(226, 'ALTER DATABASE statement not allowed within multi-statement transaction.');
    const db = this.findDb(name);
    if (db === undefined) {
      throw new SqlFault(5011, `User does not have permission to alter database '${name}', the database does not exist, or the database is not in a state that allows access checks.`);
    }
    if (rollbackImmediate) this.#kill(db, session);
    else if (option !== 'MULTI_USER' && this.#busy(db, session)) {
      throw new SqlFault(5070, `Database state cannot be changed while other users are using the database '${db.name}'`);
    }
    switch (option) {
      case 'READ_ONLY':
        db.readOnly = true;
        return;
      case 'READ_WRITE':
        db.readOnly = false;
        return;
      case 'SINGLE_USER':
        db.userAccess = 'SINGLE_USER';
        db.singleUser = session;
        return;
      default:
        db.userAccess = 'MULTI_USER';
        db.singleUser = null;
    }
  }

  dropDatabase(session: Session, name: string): void {
    if (session.tx !== null) throw new SqlFault(574, 'DROP DATABASE statement cannot be used inside a user transaction.');
    const db = this.findDb(name);
    if (db === undefined) throw new SqlFault(3701, `Cannot drop the database '${name}', because it does not exist or you do not have permission.`);
    if (db.system) throw new SqlFault(3708, `Cannot drop the database '${db.name}' because it is a system database.`);
    if (session.db === db || this.#busy(db, session)) throw new SqlFault(3702, `Cannot drop database "${db.name}" because it is currently in use.`);
    this.#kill(db, session);
    db.dropped = true;
    this.#databases.delete(db.name.toLowerCase());
  }

  /** Inserts rows into committed state outside any transaction or log, converting values as an INSERT would. */
  insertDirect(db: Database, table: Table, rows: readonly Row[]): void {
    const def = table.def;
    const built = rows.map((row) => {
      const given = new Map<number, TV>();
      for (const [name, value] of Object.entries(row)) given.set(columnIndex(def, name), jsValue(value));
      return buildRow(this, db, table, given);
    });
    const all = [...table.data.rows, ...built];
    table.data = { rows: all, index: buildIndex(def, all), sorted: null };
  }

  /** Database, schema and table name of a one- to three-part name; the database defaults to `database`. */
  locateName(qualified: string, database: string): { db: Database; schema: string; name: string } {
    const parts = new Parser(qualified).objectNameOnly();
    const dbName = parts.length === 3 ? (parts[0] as string) : database;
    const db = this.findDb(dbName);
    if (db === undefined) throw new SqlFault(911, `Database '${dbName}' does not exist. Make sure that the name is entered correctly.`);
    const name = parts[parts.length - 1] as string;
    const schema = parts.length >= 2 ? (parts[parts.length - 2] as string) || 'dbo' : 'dbo';
    return { db, schema, name };
  }

  tableNamed(qualified: string, database: string): { db: Database; table: Table } {
    const { db, schema, name } = this.locateName(qualified, database);
    const table = db.tables.get(tableKey(schema, name));
    if (table === undefined) throw new SqlFault(208, `Invalid object name '${qualified}'.`);
    return { db, table };
  }
}


// ---------------------------------------------------------------------------------------------------------------------
// Driver surfaces

interface PoolConfig {
  readonly database: string;
  readonly stream: boolean;
  readonly arrayRowMode: boolean;
  readonly parseJSON: boolean;
  readonly options: { readonly useUTC: boolean };
}

/** A request result shaped as mssql's IResult; stream-mode requests resolve with null record sets, as mssql does. */
interface FakeResult {
  readonly recordsets: unknown[][] | null;
  readonly recordset: unknown[] | null | undefined;
  readonly output: Record<string, unknown>;
  readonly rowsAffected: number[];
}

/** Where a request gets its session: a pool lends an idle one, a transaction its own. */
interface RequestHost {
  acquire(): Session;
  release(session: Session): void;
}

const STREAM_CHUNK = 64;
const IDLE_SESSIONS = 10;

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function driverError(name: string, code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { name, code });
}

function canceledError(): Error {
  return driverError('RequestError', 'ECANCEL', 'Canceled.');
}

function transactionError(code: string, message: string): Error {
  return driverError('TransactionError', code, message);
}

function loginFailed(database: string): Error {
  return driverError('ConnectionError', 'ELOGIN', `Cannot open database "${database}" requested by the login. The login failed.`);
}

/** The error a client sees for what the server raised. */
function clientError(error: unknown): unknown {
  if (error instanceof SqlFault) return sqlError(error.number, error.message);
  if (error instanceof InjectedFailure) return error.error;
  if (error instanceof SessionKilled) return connectionLost();
  return error;
}

/** A row object as mssql builds it: duplicate column names collect into an array. */
function rowObject(columns: readonly OutColumn[], values: readonly unknown[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    const value = values[index];
    const existing = row[column.name];
    if (existing === undefined) row[column.name] = value;
    else row[column.name] = Array.isArray(existing) ? [...(existing as unknown[]), value] : [existing, value];
  });
  return row;
}

function columnsMeta(columns: readonly OutColumn[]): Record<string, unknown> {
  return Object.fromEntries(
    columns.map((column, index) => [
      column.name,
      {
        index,
        name: column.name,
        length: charMax(column.type) ?? maxBytes(column.type),
        precision: column.type.precision,
        scale: column.type.scale,
        nullable: column.nullable,
        caseSensitive: false,
        identity: false,
        readOnly: false,
      },
    ]),
  );
}

function recordsetOf(token: Extract<Token, { kind: 'rows' }>): unknown[] {
  const rows: unknown[] = token.rows.map((values) => rowObject(token.columns, values));
  Object.defineProperty(rows, 'columns', { enumerable: false, configurable: true, value: columnsMeta(token.columns) });
  return rows;
}

function countOf(token: Token): number {
  return token.kind === 'rows' ? token.rows.length : token.count;
}

function resultOf(tokens: readonly Token[]): FakeResult {
  const recordsets = tokens.flatMap((token) => (token.kind === 'rows' ? [recordsetOf(token)] : []));
  return { recordsets, recordset: recordsets[0], output: {}, rowsAffected: tokens.map(countOf) };
}

/** A parameter bound through mssql's `input`: the type is a type function (`sql.Int`) or a sized type object. */
function mssqlParam(type: unknown, value: unknown, typed: boolean): ParamInput {
  if (!typed) return { value, typed: false };
  const declarationOf = (candidate: unknown): unknown =>
    typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)
      ? (candidate as { declaration?: unknown }).declaration
      : undefined;
  if (typeof type === 'function') return { value, typed: true, declaration: declarationOf(type) };
  if (typeof type === 'object' && type !== null) {
    const sized = type as { type?: unknown; length?: unknown; precision?: unknown; scale?: unknown };
    return { value, typed: true, declaration: declarationOf(sized.type), length: sized.length, precision: sized.precision, scale: sized.scale };
  }
  return { value, typed: true };
}

/** The mssql `Request` surface the migration package uses: inputs, query and batch, and stream mode with back-pressure. */
class FakeRequest extends EventEmitter {
  stream: boolean | null = null;
  canceled = false;
  readonly parameters: Record<string, { name: string; type: unknown; value: unknown }> = {};
  readonly #server: FakeServer;
  readonly #config: PoolConfig;
  readonly #host: RequestHost;
  readonly #inputs: Record<string, ParamInput> = {};
  #paused = false;
  #waiters: (() => void)[] = [];

  constructor(server: FakeServer, config: PoolConfig, host: RequestHost) {
    super();
    this.#server = server;
    this.#config = config;
    this.#host = host;
  }

  /** `input(name, value)` binds an untyped value; `input(name, type, value)` a typed one. */
  input(name: string, ...rest: unknown[]): this {
    const typed = rest.length >= 2;
    const type = typed ? rest[0] : undefined;
    const value = typed ? rest[1] : rest[0];
    this.parameters[name] = { name, type, value };
    this.#inputs[name] = mssqlParam(type, value, typed);
    return this;
  }

  query(command: string): Promise<FakeResult> {
    return this.#run(command);
  }

  batch(command: string): Promise<FakeResult> {
    return this.#run(command);
  }

  pause(): boolean {
    if (this.stream !== true) return false;
    this.#paused = true;
    return true;
  }

  resume(): boolean {
    if (this.stream !== true) return false;
    this.#paused = false;
    this.#wake();
    return true;
  }

  cancel(): boolean {
    this.canceled = true;
    this.#wake();
    return true;
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  async #run(command: string): Promise<FakeResult> {
    this.stream ??= this.#config.stream;
    await tick();
    let session: Session;
    try {
      if (this.canceled) throw canceledError();
      session = this.#host.acquire();
    } catch (error) {
      return this.#fail(error, []);
    }
    let tokens: Token[];
    try {
      tokens = this.#server.execute(session, command, this.#inputs);
    } catch (error) {
      this.#host.release(session);
      return this.#fail(clientError(error), []);
    }
    if (this.stream !== true) {
      this.#host.release(session);
      return resultOf(tokens);
    }
    try {
      return await this.#emit(tokens);
    } finally {
      this.#host.release(session);
    }
  }

  /** Rejects outside stream mode; in stream mode emits `error` then `done` and resolves, as mssql does. */
  #fail(error: unknown, rowsAffected: number[]): FakeResult {
    if (this.stream !== true) throw error;
    this.emit('error', error);
    this.emit('done', { output: {}, rowsAffected });
    return { recordsets: null, recordset: null, output: {}, rowsAffected };
  }

  async #emit(tokens: readonly Token[]): Promise<FakeResult> {
    const rowsAffected: number[] = [];
    for (const token of tokens) {
      if (this.canceled) return this.#fail(canceledError(), rowsAffected);
      if (token.kind === 'rows') {
        this.emit('recordset', columnsMeta(token.columns));
        for (const [index, values] of token.rows.entries()) {
          if (index % STREAM_CHUNK === 0) await tick();
          while (this.#paused && !this.canceled) {
            await new Promise<void>((resolve) => {
              this.#waiters.push(resolve);
            });
          }
          if (this.canceled) return this.#fail(canceledError(), rowsAffected);
          this.emit('row', rowObject(token.columns, values));
        }
      }
      rowsAffected.push(countOf(token));
      this.emit('rowsaffected', countOf(token));
    }
    this.emit('done', { output: {}, rowsAffected });
    return { recordsets: null, recordset: null, output: {}, rowsAffected };
  }
}

/** The mssql `Transaction` surface: begin, request, commit and rollback, one request at a time. */
class FakeTransaction extends EventEmitter {
  isolationLevel = 0x02;
  name = '';
  readonly #pool: FakePool;
  #session: Session | null = null;
  #active = false;

  constructor(pool: FakePool) {
    super();
    this.#pool = pool;
  }

  get config(): PoolConfig {
    return this.#pool.config;
  }

  get connected(): boolean {
    return this.#pool.connected;
  }

  async begin(isolationLevel?: number): Promise<this> {
    if (isolationLevel !== undefined) this.isolationLevel = isolationLevel;
    if (this.#session !== null) throw transactionError('EALREADYBEGUN', 'Transaction has already begun.');
    await tick();
    const session = this.#pool.take();
    try {
      this.#pool.server.begin(session);
    } catch (error) {
      this.#pool.give(session);
      throw clientError(error);
    }
    this.#session = session;
    this.emit('begin');
    return this;
  }

  request(): FakeRequest {
    return new FakeRequest(this.#pool.server, this.#pool.config, {
      acquire: () => {
        if (this.#session === null) throw transactionError('ENOTBEGUN', 'Transaction has not begun. Call begin() first.');
        if (this.#active) throw transactionError('EREQINPROG', "Can't acquire connection for the request. There is another request in progress.");
        this.#active = true;
        return this.#session;
      },
      release: () => {
        this.#active = false;
      },
    });
  }

  async commit(): Promise<void> {
    const session = this.#ending('commit');
    await tick();
    this.#session = null;
    try {
      if (session.killed) throw transactionError('EABORT', 'Transaction has been aborted.');
      this.#pool.server.commit(session);
    } catch (error) {
      throw clientError(error);
    } finally {
      this.#pool.give(session);
    }
    this.emit('commit');
  }

  async rollback(): Promise<void> {
    const session = this.#ending('rollback');
    await tick();
    this.#session = null;
    const aborted = session.killed;
    this.#pool.server.rollback(session);
    this.#pool.give(session);
    if (aborted) throw transactionError('EABORT', 'Transaction has been aborted.');
    this.emit('rollback', false);
  }

  #ending(verb: string): Session {
    if (this.#session === null) throw transactionError('ENOTBEGUN', 'Transaction has not begun. Call begin() first.');
    if (this.#active) throw transactionError('EREQINPROG', `Can't ${verb} transaction. There is a request in progress.`);
    return this.#session;
  }
}

/** A request as tedious hands it to a connection; mssql builds it for `new sql.Request(pool)` and `sql.Transaction`. */
interface TediousRequest {
  readonly sqlTextOrProcedure?: string;
  readonly parameters?: readonly {
    readonly name: string;
    readonly type?: { readonly name?: unknown };
    readonly value: unknown;
    readonly length?: unknown;
    readonly precision?: unknown;
    readonly scale?: unknown;
  }[];
  readonly paused?: boolean;
  callback(error?: unknown): void;
  emit(event: string, ...args: unknown[]): boolean;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

function serverErrorInfo(error: unknown): SqlErrorInfo | undefined {
  const info = (number: number, message: string): SqlErrorInfo => ({ number, message, state: 1, class: 16, lineNumber: 1, serverName: SERVER_NAME, procName: '' });
  if (error instanceof SqlFault) return info(error.number, error.message);
  if (!(error instanceof InjectedFailure)) return undefined;
  const injected = error.error as { number?: unknown; message?: unknown } | null;
  if (typeof injected?.number !== 'number') return undefined;
  return info(injected.number, typeof injected.message === 'string' ? injected.message : `SQL Server error ${String(injected.number)}`);
}

/**
 * The tedious connection a pool lends through `acquire`, for code that constructs mssql's own Request and Transaction
 * classes over the pool (snapshot statements on master, the forced re-initialisation fault). SQL Server errors are
 * reported as tedious does, an `errorMessage` event then the request callback, so mssql raises its RequestError.
 */
class TediousLink extends EventEmitter {
  readonly session: Session;
  readonly #server: FakeServer;
  #current: { canceled: boolean; wake: (() => void) | undefined } | null = null;

  constructor(server: FakeServer, session: Session) {
    super();
    this.#server = server;
    this.session = session;
  }

  execSql(request: TediousRequest): void {
    void this.#run(request);
  }

  execSqlBatch(request: TediousRequest): void {
    void this.#run(request);
  }

  beginTransaction(callback: (error?: unknown) => void): void {
    setImmediate(() => {
      try {
        this.#server.begin(this.session);
        callback();
      } catch (error) {
        callback(clientError(error));
      }
    });
  }

  commitTransaction(callback: (error?: unknown) => void): void {
    setImmediate(() => {
      try {
        this.#server.commit(this.session);
        callback();
      } catch (error) {
        callback(clientError(error));
      }
    });
  }

  rollbackTransaction(callback: (error?: unknown) => void): void {
    setImmediate(() => {
      this.#server.rollback(this.session);
      callback();
    });
  }

  cancel(): boolean {
    const current = this.#current;
    if (current !== null) {
      current.canceled = true;
      current.wake?.();
    }
    return true;
  }

  close(): void {
    this.#server.discard(this.session);
  }

  async #run(request: TediousRequest): Promise<void> {
    const current: { canceled: boolean; wake: (() => void) | undefined } = { canceled: false, wake: undefined };
    this.#current = current;
    const cancelled = (): Error => driverError('RequestError', 'ECANCEL', 'Canceled.');
    try {
      await tick();
      if (current.canceled) throw cancelled();
      const inputs: Record<string, ParamInput> = {};
      for (const param of request.parameters ?? []) {
        inputs[param.name] = { value: param.value, typed: true, declaration: param.type?.name, length: param.length, precision: param.precision, scale: param.scale };
      }
      const tokens = this.#server.execute(this.session, request.sqlTextOrProcedure ?? '', inputs);
      for (const token of tokens) {
        if (token.kind === 'rows') {
          request.emit(
            'columnMetadata',
            token.columns.map((column) => ({ colName: column.name, dataLength: charMax(column.type) ?? maxBytes(column.type), flags: column.nullable ? 1 : 0 })),
          );
          for (const [index, values] of token.rows.entries()) {
            if (index % STREAM_CHUNK === 0) await tick();
            while (request.paused === true && !current.canceled) {
              await new Promise<void>((resolve) => {
                current.wake = resolve;
                request.once('resume', resolve);
              });
              current.wake = undefined;
            }
            if (current.canceled) throw cancelled();
            request.emit('row', token.columns.map((column, position) => ({ value: values[position], metadata: { colName: column.name } })));
          }
        }
        request.emit('doneInProc', countOf(token), true);
      }
      this.#current = null;
      request.callback();
    } catch (error) {
      this.#current = null;
      const info = serverErrorInfo(error);
      if (info === undefined) {
        request.callback(clientError(error));
        return;
      }
      this.emit('errorMessage', info);
      request.callback(new Error(info.message));
    }
  }
}

/** The mssql `ConnectionPool` surface over one database of the fake server. */
class FakePool extends EventEmitter {
  connected = true;
  connecting = false;
  healthy = true;
  readonly config: PoolConfig;
  readonly server: FakeServer;
  readonly #idle: Session[] = [];

  constructor(server: FakeServer, database: string) {
    super();
    this.server = server;
    this.config = { database, stream: false, arrayRowMode: false, parseJSON: false, options: { useUTC: false } };
  }

  request(): FakeRequest {
    return new FakeRequest(this.server, this.config, { acquire: () => this.take(), release: (session) => this.give(session) });
  }

  transaction(): FakeTransaction {
    return new FakeTransaction(this);
  }

  connect(): Promise<this> {
    this.connected = true;
    return Promise.resolve(this);
  }

  close(): Promise<void> {
    this.connected = false;
    for (const session of this.#idle.splice(0)) this.server.discard(session);
    return Promise.resolve();
  }

  /** Lends an idle session on the pool's database, or opens one; sessions keep state such as IDENTITY_INSERT. */
  take(): Session {
    if (!this.connected) throw driverError('ConnectionError', 'ECONNCLOSED', 'Connection is closed.');
    const db = this.server.findDb(this.config.database);
    if (db === undefined) throw loginFailed(this.config.database);
    for (let session = this.#idle.pop(); session !== undefined; session = this.#idle.pop()) {
      if (!session.killed && session.db === db) return session;
      this.server.discard(session);
    }
    return this.server.openSession(db);
  }

  give(session: Session): void {
    if (session.killed || session.tx !== null || !this.connected || session.db.dropped || this.#idle.length >= IDLE_SESSIONS) {
      this.server.discard(session);
      return;
    }
    this.#idle.push(session);
  }

  acquire(_requester: unknown, callback: (error: unknown, connection?: unknown, config?: unknown) => void): this {
    let session: Session;
    try {
      session = this.take();
    } catch (error) {
      setImmediate(callback, error);
      return this;
    }
    setImmediate(callback, null, new TediousLink(this.server, session), this.config);
    return this;
  }

  release(connection: unknown): this {
    if (connection instanceof TediousLink) this.give(connection.session);
    return this;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Port

function columnType(def: LegacyColumnDef): SqlType {
  if (!Object.hasOwn(FAMILY, def.type)) throw new TypeError(`Column ${def.name} has unknown type ${String(def.type)}`);
  const base = def.type;
  if (LENGTH_TYPES.has(base)) {
    const length = def.length ?? 1;
    if (length === 'max' && FIXED_TYPES.has(base)) throw new TypeError(`Column ${def.name}: ${base} cannot be max`);
    return { base, length };
  }
  if (base === 'decimal' || base === 'numeric') return { base, precision: def.precision ?? 18, scale: def.scale ?? 0 };
  if (base === 'datetime2') return { base, scale: def.scale ?? def.precision ?? 7 };
  return { base };
}

/** Runs a suite helper, surfacing server errors as the mssql errors statements would raise. */
function helper<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SqlFault) throw sqlError(error.number, error.message);
    if (error instanceof Unmodelled) throw new TypeError(`The fake legacy database cannot ${error.message}`);
    throw error;
  }
}

function isEnded(error: unknown): boolean {
  const shape = error as { name?: unknown; code?: unknown } | null;
  return shape?.name === 'TransactionError' && (shape.code === 'EABORT' || shape.code === 'ENOTBEGUN');
}

/** Creates an in-memory server holding `master`, `msdb`, the live database and the seed's tables and rows. */
export function createFakeLegacyDb(seed: FakeLegacyDbSeed = {}): FakeLegacyDb {
  // Each fake is a fresh server, so metadata catalog.ts memoised for an earlier fake must not answer for this one.
  clearCatalogCache();
  const server = new FakeServer(seed.dataPath ?? DEFAULT_DATA_PATH);
  const live = seed.database ?? LIVE_DEFAULT;
  server.createDatabase(live);
  const pools = new Map<string, FakePool>();

  const pool = (name: string): Promise<ConnectionPool> => {
    const key = name.toLowerCase();
    let found = pools.get(key);
    if (found === undefined) {
      if (server.findDb(name) === undefined) return Promise.reject(loginFailed(name));
      found = new FakePool(server, name);
      pools.set(key, found);
    }
    return Promise.resolve(found as unknown as ConnectionPool);
  };

  const table = (qualified: string, database: string | undefined): { db: Database; table: Table } =>
    server.tableNamed(qualified, database ?? live);

  const fake: FakeLegacyDb = {
    live: () => pool(live),
    database: pool,
    async transaction<T>(fn: (tx: Transaction) => Promise<T>, options: { database?: string } = {}): Promise<T> {
      const target = (await pool(options.database ?? live)) as unknown as FakePool;
      const tx = target.transaction();
      await tx.begin();
      try {
        const result = await fn(tx as unknown as Transaction);
        await tx.commit();
        return result;
      } catch (error) {
        try {
          await tx.rollback();
        } catch (rollbackError) {
          if (!isEnded(rollbackError)) throw new AggregateError([error, rollbackError], 'Transaction failed and its rollback failed');
        }
        throw error;
      }
    },
    async close(): Promise<void> {
      const open = [...pools.values()];
      pools.clear();
      await Promise.all(open.map((entry) => entry.close()));
    },
    defineTable(qualified, columns, options = {}) {
      helper(() => {
        const { db, schema, name } = server.locateName(qualified, options.database ?? live);
        if (schemaOf(db, schema) === undefined) server.createSchema(db, schema);
        const identity = options.identity?.toLowerCase();
        if (identity !== undefined && !columns.some((column) => column.name.toLowerCase() === identity)) {
          throw new TypeError(`Identity column ${options.identity ?? ''} is not a column of ${qualified}`);
        }
        server.createTable(db, {
          schema,
          name,
          columns: columns.map((column) => ({
            name: column.name,
            type: columnType(column),
            nullable: column.nullable,
            identity: column.name.toLowerCase() === identity ? { seed: 1, increment: 1 } : null,
            defaultValue: column.default === undefined ? undefined : () => jsValue(column.default),
          })),
          primaryKey: options.primaryKey ?? [],
          pkName: options.primaryKey === undefined || options.primaryKey.length === 0 ? null : `PK_${name}`,
        });
      });
    },
    seed(name, rows, options = {}) {
      helper(() => {
        const target = table(name, options.database);
        server.insertDirect(target.db, target.table, rows);
      });
    },
    rows(name, options = {}) {
      return helper(() => {
        const { def, data } = table(name, options.database).table;
        return scanRows(def, data).map((row) =>
          Object.fromEntries(def.columns.map((column, index) => [column.name, driverValue(tv(column.type, row.values[index] ?? null))])),
        );
      });
    },
    multiset(name, options = {}) {
      return helper(() => {
        const { def, data } = table(name, options.database).table;
        const columns: CanonicalColumn[] = def.columns.map((column) => ({
          name: column.name,
          ...canonicalTypeForSqlServer(column.type.base, { scale: column.type.scale }),
        }));
        const counts = new Map<string, number>();
        for (const row of data.rows) {
          const values = Object.fromEntries(def.columns.map((column, index) => [column.name, row.values[index] ?? null]));
          const encoding = encodeRow(columns, values);
          counts.set(encoding, (counts.get(encoding) ?? 0) + 1);
        }
        return counts;
      });
    },
    statements: server.statements,
    commits: server.commits,
    crashAt(predicate, options = {}) {
      server.faults.push({ kind: 'crash', predicate, once: options.once ?? true });
    },
    failNext(predicate, error) {
      server.faults.push({ kind: 'fail', predicate, error });
    },
    databases() {
      return server
        .allDatabases()
        .map((db) => db.name)
        .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    },
    clearLogs() {
      server.statements.length = 0;
      server.commits.length = 0;
    },
  };

  helper(() => {
    for (const entry of seed.tables ?? []) fake.defineTable(entry.qualified, entry.columns, entry.options);
  });
  for (const [name, rows] of Object.entries(seed.rows ?? {})) fake.seed(name, rows);
  return fake;
}

