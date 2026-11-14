// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Shared scaffolding of the timesheets suites: the app built for `app.inject` over an in-memory `timesheets` schema or a throwaway one, and test credentials. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVOCATION_HEADER, LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import { INBOX_TABLE, type EventPublisher } from '@opt2/platform/events';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN, cfUuid } from '@opt2/platform/legacy-compat';
import {
  CHANGELOG_TABLE,
  UNIT_GATE_TABLE,
  closeGates,
  ensureUnitGates,
  openGates,
  type GatePhase,
  type GateState,
} from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  baseEnvSchema,
  loadEnv,
  type BaseEnv,
  type Clock,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  isNonTenantTable,
  tenantDbFromPool,
  type Pool,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
} from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  pushKeyQuery,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type RoleSubject,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SERVICE_NAME, buildApp } from '../../src/app.js';
import {
  TIMESHEETS_SCHEMA,
  TIMESHEETS_UNITS,
  tables,
  type ApprovalActionRow,
  type BlackoutRow,
  type TimesheetDayRow,
  type TimesheetRow,
  type TimesheetsUnit,
} from '../../src/repo/tables.js';

export { BUSINESS_DATE, asOf } from '@opt2/platform/testing';

const STATE_DIR_PREFIX = 'opt2-timesheets-';
const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);

/** State directories testEnv created that no app has removed yet. */
const createdStateDirs = new Set<string>();
let exitCleanupRegistered = false;

/** Tracks `dir` for removal when the process exits or a signal ends it; buildTestApp removes its own directories when their app closes. */
function removeAtExit(dir: string): void {
  createdStateDirs.add(dir);
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  const removeAll = (): void => {
    for (const created of createdStateDirs) rmSync(created, { recursive: true, force: true });
    createdStateDirs.clear();
  };
  process.once('exit', removeAll);
  // A worker ended by SIGTERM or SIGINT skips 'exit'; the signal is raised again once the directories are gone.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      removeAll();
      process.kill(process.pid, signal);
    });
  }
}

function removeStateDir(dir: string): void {
  createdStateDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/** Parsed local-mode env for `buildApp`, its secrets written to a fresh `os.tmpdir()` state dir unless `overrides` sets `OPT2_STATE_DIR`; an `undefined` override drops a variable. */
export async function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}): Promise<BaseEnv> {
  const ownStateDir = 'OPT2_STATE_DIR' in overrides ? undefined : mkdtempSync(path.join(tmpdir(), STATE_DIR_PREFIX));
  if (ownStateDir !== undefined) removeAtExit(ownStateDir);
  // Every URL and database setting satisfies the schema only; an app built over an injected db and publisher connects to none of them.
  const raw: Record<string, string | undefined> = {
    OPT2_SERVICE_NAME: SERVICE_NAME,
    OPT2_ENV: 'local',
    PORT: '8118',
    TZ: process.env.TZ ?? 'UTC',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2',
    PG_USER: 'timesheets_app',
    PG_PASSWORD: 'unused',
    PUBSUB_EMULATOR_HOST: 'localhost:8085',
    GOOGLE_CLOUD_PROJECT: 'opt2-local',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    // testVerifier() verifies user tokens against the test key pair, so the JWKS is never fetched.
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_GATEWAY_URL: 'http://127.0.0.1:8100',
    OPT2_MIGRATION_URL: 'http://127.0.0.1:8102',
    OPT2_SERVICE_URLS: '{}',
    OPT2_STATE_DIR: ownStateDir,
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    ...overrides,
  };
  const env = loadEnv(baseEnvSchema, Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  await writeTestSecrets(env.OPT2_STATE_DIR);
  return env;
}

/** Clock every suite shares: local `2026-06-30T12:00:00`, the seed's business date and the default `asOf`. */
export const TEST_CLOCK: Clock = businessClock();

/** Holder id the helpers close and reopen unit gates with. */
export const TEST_GATE_HOLDER = 'timesheets-test-holder';

/** A `timesheets.unit_gate` row as pg returns it. */
export type UnitGateRow = {
  unit: string;
  state: GateState;
  holder_id: string | null;
  phase: GatePhase;
  updated_at: Date;
};

/** A row of a platform table, keyed by column name. */
type PlatformRow = Record<string, unknown>;

/** Row shape of each table of schema `timesheets`, by its unqualified name. */
export interface RecordingRowTypes {
  timesheet: TimesheetRow;
  timesheet_day: TimesheetDayRow;
  approval_action: ApprovalActionRow;
  blackout: BlackoutRow;
  unit_gate: UnitGateRow;
  tenant_registry: PlatformRow;
  tenant_grant: PlatformRow;
  changelog: PlatformRow;
  open_operation: PlatformRow;
  migration_batch: PlatformRow;
  migration_watermark: PlatformRow;
  inbox: PlatformRow;
  consumer_aggregate_version: PlatformRow;
  outbox: PlatformRow;
}

/** An unqualified table of schema `timesheets`. */
export type TableName = keyof RecordingRowTypes;

const TABLE_NAMES: readonly TableName[] = Object.freeze([
  'timesheet',
  'timesheet_day',
  'approval_action',
  'blackout',
  UNIT_GATE_TABLE,
  'tenant_registry',
  'tenant_grant',
  CHANGELOG_TABLE,
  'open_operation',
  'migration_batch',
  'migration_watermark',
  INBOX_TABLE,
  'consumer_aggregate_version',
  'outbox',
]);

/** Committed rows per table; omitted columns take their DDL defaults. */
export type SeedRows = { readonly [T in TableName]?: readonly Readonly<Partial<RecordingRowTypes[T]>>[] };

/** A committed write; `row` is the row as pg returns it (the after-image of an update, the removed row of a delete). */
export interface RecordedWrite {
  readonly table: TableName;
  readonly op: 'insert' | 'update' | 'delete';
  readonly row: Readonly<Record<string, unknown>>;
  /** `app.tenant_id` of the writing transaction; null in a metadata transaction. */
  readonly tenantId: string | null;
  /** Decimal `pg_current_xact_id()` of the writing transaction. */
  readonly xid: string;
}

/** A statement as issued, with its transaction's `app.tenant_id` (null when empty or outside a transaction). */
export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly tenantId: string | null;
}

/** Matches statements by normalised substring, by RegExp (tested on the raw and the normalised text), or by predicate. */
export type StatementMatcher = string | RegExp | ((text: string, values: readonly unknown[]) => boolean);

/** A PostgreSQL error as node-pg raises it, with its SQLSTATE `code`. */
type PgError = Error & { code: string; severity: 'ERROR' };

function pgError(code: string, message: string): PgError {
  return Object.assign(new Error(message), { code, severity: 'ERROR' as const });
}

/** SQL the recording db does not model; the statement runner rethrows it naming the statement. */
class UnsupportedSqlError extends Error {
  override readonly name: string = 'UnsupportedSqlError';
}

function unsupported(what: string): never {
  throw new UnsupportedSqlError(what);
}

/** Thrown when `db/migrations` and the repository's table definitions disagree, so no suite runs against a stale model. */
class CatalogueDriftError extends Error {
  override readonly name: string = 'CatalogueDriftError';
}

/** Stored column type; `int8` also covers `bigserial` and identity columns. */
type ColumnKind = 'uuid' | 'text' | 'char' | 'int4' | 'int8' | 'xid8' | 'numeric' | 'timestamp' | 'bool' | 'jsonb';

/** A column default the catalogue applies when an insert omits the column. */
type ColumnFallback = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'now' } | { readonly kind: 'xid' } | { readonly kind: 'serial' };

interface CatalogColumn {
  readonly name: string;
  readonly kind: ColumnKind;
  readonly array: boolean;
  readonly length?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly notNull: boolean;
  readonly fallback?: ColumnFallback;
  /** Values an inline `CHECK (<column> IN (…))` admits. */
  readonly allowed?: readonly string[];
}

interface CatalogTable {
  readonly name: TableName;
  readonly columns: readonly CatalogColumn[];
  readonly column: ReadonlyMap<string, CatalogColumn>;
  readonly primaryKey: readonly string[];
  /** Primary key first, then each UNIQUE constraint. */
  readonly unique: readonly (readonly string[])[];
  /** True once the DDL forces row level security on the table. */
  tenantOwned: boolean;
}

const COLUMN_TYPES: readonly (readonly [RegExp, (match: RegExpExecArray) => Pick<CatalogColumn, 'kind' | 'array' | 'length' | 'precision' | 'scale'>])[] = [
  [/^uuid\[\]/i, () => ({ kind: 'uuid', array: true })],
  [/^uuid/i, () => ({ kind: 'uuid', array: false })],
  [/^text\[\]/i, () => ({ kind: 'text', array: true })],
  [/^text/i, () => ({ kind: 'text', array: false })],
  [/^char\((\d+)\)/i, (m) => ({ kind: 'char', array: false, length: Number(m[1]) })],
  [/^bigserial/i, () => ({ kind: 'int8', array: false })],
  [/^bigint/i, () => ({ kind: 'int8', array: false })],
  [/^integer/i, () => ({ kind: 'int4', array: false })],
  [/^xid8/i, () => ({ kind: 'xid8', array: false })],
  [/^numeric\((\d+),(\d+)\)/i, (m) => ({ kind: 'numeric', array: false, precision: Number(m[1]), scale: Number(m[2]) })],
  [/^timestamp\(3\) without time zone/i, () => ({ kind: 'timestamp', array: false })],
  [/^jsonb/i, () => ({ kind: 'jsonb', array: false })],
  [/^boolean/i, () => ({ kind: 'bool', array: false })],
];

/** `text` split at commas outside parentheses and single-quoted literals, each part trimmed. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== '');
}

function columnList(text: string): string[] {
  return splitTopLevel(text).map((name) => name.replace(/"/g, ''));
}

function fallbackOf(definition: string, serial: boolean): ColumnFallback | undefined {
  if (serial) return { kind: 'serial' };
  const found = /\bDEFAULT\s+('(?:[^']|'')*'|pg_current_xact_id\(\)|localtimestamp\(3\)|true|false)/i.exec(definition)?.[1];
  if (found === undefined) return undefined;
  if (/^pg_current_xact_id/i.test(found)) return { kind: 'xid' };
  if (/^localtimestamp/i.test(found)) return { kind: 'now' };
  if (/^(true|false)$/i.test(found)) return { kind: 'value', value: found.toLowerCase() === 'true' };
  const text = found.slice(1, -1).replace(/''/g, "'");
  return { kind: 'value', value: text === '{}' ? [] : text };
}

function parseColumn(table: string, item: string): CatalogColumn {
  const head = /^"?([a-z_][a-z0-9_]*)"?\s+([\s\S]+)$/.exec(item);
  if (head === null) throw new CatalogueDriftError(`timesheets.${table}: cannot read column definition ${JSON.stringify(item)}`);
  const [, name = '', definition = ''] = head;
  const type = COLUMN_TYPES.map(([pattern, build]) => {
    const match = pattern.exec(definition);
    return match === null ? undefined : build(match);
  }).find((candidate) => candidate !== undefined);
  if (type === undefined) throw new CatalogueDriftError(`timesheets.${table}.${name}: unmodelled column type in ${JSON.stringify(definition)}`);
  const serial = /^bigserial/i.test(definition) || /GENERATED ALWAYS AS IDENTITY/i.test(definition);
  const allowed = /\bCHECK \(\w+ IN \(([^)]*)\)\)/i.exec(definition)?.[1];
  const fallback = fallbackOf(definition, serial);
  return {
    name,
    ...type,
    notNull: /\bNOT NULL\b|\bPRIMARY KEY\b/i.test(definition) || serial,
    ...(fallback === undefined ? {} : { fallback }),
    ...(allowed === undefined ? {} : { allowed: splitTopLevel(allowed).map((value) => value.slice(1, -1)) }),
  };
}

function parseTable(name: string, body: string): CatalogTable {
  if (!(TABLE_NAMES as readonly string[]).includes(name)) throw new CatalogueDriftError(`the recording db models no table timesheets.${name}`);
  const columns: CatalogColumn[] = [];
  const unique: string[][] = [];
  let primaryKey: string[] | undefined;
  for (const item of splitTopLevel(body)) {
    const constraint = /^(PRIMARY KEY|UNIQUE)\s*\(([^)]*)\)$/i.exec(item);
    if (constraint !== null) {
      const names = columnList(constraint[2] ?? '');
      if (/^PRIMARY/i.test(constraint[1] ?? '')) primaryKey = names;
      else unique.push(names);
      continue;
    }
    if (/^CHECK\b/i.test(item)) continue;
    const column = parseColumn(name, item);
    columns.push(column);
    if (/\bPRIMARY KEY\b/i.test(item)) primaryKey = [column.name];
    else if (/\bUNIQUE\b/i.test(item)) unique.push([column.name]);
  }
  if (primaryKey === undefined) throw new CatalogueDriftError(`timesheets.${name} has no primary key`);
  return {
    name: name as TableName,
    columns,
    column: new Map(columns.map((column) => [column.name, column])),
    primaryKey,
    unique: [primaryKey, ...unique],
    tenantOwned: false,
  };
}

let catalogueCache: ReadonlyMap<string, CatalogTable> | undefined;

/** Tables of schema `timesheets` as `db/migrations` declares them, parsed once per process and checked against the repository. */
function catalogue(): ReadonlyMap<string, CatalogTable> {
  catalogueCache ??= loadCatalogue();
  return catalogueCache;
}

function loadCatalogue(): ReadonlyMap<string, CatalogTable> {
  const catalog = new Map<string, CatalogTable>();
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  for (const file of files) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    for (const match of sql.matchAll(new RegExp(`CREATE TABLE ${TIMESHEETS_SCHEMA}\\.(\\w+) \\(\\n([\\s\\S]*?)\\n\\);`, 'g'))) {
      const table = parseTable(match[1] ?? '', match[2] ?? '');
      catalog.set(table.name, table);
    }
    for (const match of sql.matchAll(new RegExp(`ALTER TABLE ${TIMESHEETS_SCHEMA}\\.(\\w+) FORCE ROW LEVEL SECURITY`, 'g'))) {
      const table = catalog.get(match[1] ?? '');
      if (table === undefined) throw new CatalogueDriftError(`${file}: row level security forced on unknown table ${match[1] ?? ''}`);
      table.tenantOwned = true;
    }
  }
  assertCatalogue(catalog);
  return catalog;
}

function assertCatalogue(catalog: ReadonlyMap<string, CatalogTable>): void {
  const missing = TABLE_NAMES.filter((name) => !catalog.has(name));
  if (missing.length > 0) throw new CatalogueDriftError(`the migrations define no table ${missing.map((name) => `timesheets.${name}`).join(', ')}`);
  for (const def of tables) {
    const table = catalog.get(def.table) as CatalogTable;
    const absent = def.columns.filter((column) => !table.column.has(column.name)).map((column) => column.name);
    if (absent.length > 0) throw new CatalogueDriftError(`timesheets.${def.table} has no column ${absent.join(', ')}`);
    const expected = ['tenant_id', ...def.key];
    if (table.primaryKey.join() !== expected.join()) {
      throw new CatalogueDriftError(`timesheets.${def.table} primary key (${table.primaryKey.join(', ')}) is not (${expected.join(', ')})`);
    }
  }
  for (const table of catalog.values()) {
    if (table.tenantOwned === isNonTenantTable(table.name)) {
      throw new CatalogueDriftError(`timesheets.${table.name} ${table.tenantOwned ? 'forces' : 'lacks'} row level security against the platform's tenant tables`);
    }
  }
}

/** A `char(n)` value: compared and cast to text without its trailing spaces, as PostgreSQL's bpchar is. */
class Bpchar {
  constructor(readonly text: string) {}
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_TEXT = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d*))?)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)?\s*$/i;
const USECS_PER_DAY = 86_400_000_000;
const NUMERIC_SPACE = /^[ \t\n\v\f\r]*$/;
const NUMERIC_SPECIAL = /^[ \t\n\v\f\r]*(?:(nan)|[+-]?inf(?:inity)?)[ \t\n\v\f\r]*$/i;
const NON_DECIMAL_TEXT = /^[ \t\n\v\f\r]*([+-]?)(0x(?:_?[\da-f])+|0o(?:_?[0-7])+|0b(?:_?[01])+)(.*)$/is;
const DECIMAL_TEXT = /^[ \t\n\v\f\r]*([+-]?)(?=\.?\d)(\d+(?:_\d+)*)?(?:\.(\d+(?:_\d+)*)?)?(?:e([+-]?\d+(?:_\d+)*))?(.*)$/is;
/** numeric_in's limits: exponent magnitude, display scale, decimal digits before the point, and typmod precision. */
const NUMERIC_MAX_EXPONENT = 1_073_741_823;
const NUMERIC_MAX_DSCALE = 16_383;
const NUMERIC_MAX_WHOLE_DIGITS = 131_072;
const NUMERIC_MAX_PRECISION = 1000;
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

function isNull(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function describeValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : value instanceof Bpchar ? value.text : String(value);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** PostgreSQL's text output of a `timestamp(3)`: local wall-clock time, fraction without trailing zeros. */
function timestampText(date: Date): string {
  const fraction = date.getMilliseconds() === 0 ? '' : `.${pad(date.getMilliseconds(), 3).replace(/0+$/, '')}`;
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${fraction}`
  );
}

/** A `timestamp without time zone` value: a Date as node-pg binds it, or text read as local wall-clock time (a zone suffix is ignored). */
function toDate(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw pgError('22007', 'invalid input syntax for type timestamp: "Invalid Date"');
    return new Date(value.getTime());
  }
  const input = describeValue(value);
  const match = TIMESTAMP_TEXT.exec(input);
  if (match === null) throw pgError('22007', `invalid input syntax for type timestamp: "${input}"`);
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = match.slice(1, 7).map((part) => Number(part ?? '0'));
  const us = rint(Number(`0.${match[7] ?? ''}`) * 1e6);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || mi > 59 || s > 60 || ((h * 60 + mi) * 60 + s) * 1e6 + us > USECS_PER_DAY) {
    throw pgError('22008', `date/time field value out of range: "${input}"`);
  }
  // timestamp(3) rounds microseconds since 2000-01-01 half away from zero, so earlier times round a half down.
  const date = new Date(2000, 0, 1);
  date.setFullYear(y, mo - 1, d);
  date.setHours(h, mi, s, Math.floor((us + (y < 2000 ? 499 : 500)) / 1000));
  return date;
}

/** `x` rounded half to even, as C's rint rounds. */
function rint(x: number): number {
  const floor = Math.floor(x);
  const rest = x - floor;
  return rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  const text = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : '') : describeValue(value).trim();
  if (!/^[+-]?\d+$/.test(text)) throw pgError('22P02', `invalid input syntax for type bigint: "${describeValue(value)}"`);
  return BigInt(text);
}

function toInt4(value: unknown): number {
  const integer = toBigInt(typeof value === 'boolean' ? Number(value) : value);
  if (integer < BigInt(INT4_MIN) || integer > BigInt(INT4_MAX)) throw pgError('22003', 'value "' + integer.toString() + '" is out of range for type integer');
  return Number(integer);
}

function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = describeValue(value).trim().toLowerCase();
  if (['t', 'true', 'y', 'yes', 'on', '1'].includes(text)) return true;
  if (['f', 'false', 'n', 'no', 'off', '0'].includes(text)) return false;
  throw pgError('22P02', `invalid input syntax for type boolean: "${describeValue(value)}"`);
}

function toUuid(value: unknown): string {
  const text = describeValue(value).trim().toLowerCase().replace(/^\{(.*)\}$/, '$1');
  const canonical = /^[0-9a-f]{32}$/.test(text) ? text.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : text;
  if (!UUID_TEXT.test(canonical)) throw pgError('22P02', `invalid input syntax for type uuid: "${describeValue(value)}"`);
  return canonical;
}

/** SQLSTATE 22003 for a value numeric(`precision`,`scale`) cannot hold, with PostgreSQL's detail. */
function numericFieldOverflow(precision: number, scale: number, infinite: boolean): PgError {
  const whole = precision - scale;
  const limit = infinite ? 'cannot hold an infinite value' : `must round to an absolute value less than ${whole === 0 ? '1' : `10^${whole}`}`;
  return Object.assign(pgError('22003', 'numeric field overflow'), { detail: `A field with precision ${precision}, scale ${scale} ${limit}.` });
}

/** Sign, significant digits and the power of ten of their last digit in finite numeric input `input`; raises what numeric_in raises before the typmod. */
function numericDigits(input: string): { negative: boolean; digits: string; exponent: number } {
  const invalid = (): PgError => pgError('22P02', `invalid input syntax for type numeric: "${input}"`);
  const nonDecimal = NON_DECIMAL_TEXT.exec(input);
  if (nonDecimal !== null) {
    const [, sign, literal = '', rest = ''] = nonDecimal;
    if (!NUMERIC_SPACE.test(rest)) throw invalid();
    return { negative: sign === '-', digits: BigInt(literal.replace(/_/g, '')).toString().replace(/^0+/, ''), exponent: 0 };
  }
  const decimal = DECIMAL_TEXT.exec(input);
  if (decimal === null) throw invalid();
  const [, sign, whole = '', fractionText = '', exponentText = '0', rest = ''] = decimal;
  const exponent = Number(exponentText.replace(/_/g, ''));
  if (Math.abs(exponent) > NUMERIC_MAX_EXPONENT) throw pgError('22003', 'value overflows numeric format');
  if (!NUMERIC_SPACE.test(rest)) throw invalid();
  const fraction = fractionText.replace(/_/g, '');
  const digits = (whole.replace(/_/g, '') + fraction).replace(/^0+/, '');
  if (fraction.length - exponent > NUMERIC_MAX_DSCALE || (digits !== '' && digits.length + exponent - fraction.length > NUMERIC_MAX_WHOLE_DIGITS)) {
    throw pgError('22003', 'value overflows numeric format');
  }
  return { negative: sign === '-', digits, exponent: exponent - fraction.length };
}

/** `value`, as node-pg sends it, stored as numeric(`precision`,`scale`): exactly `scale` fraction digits, rounded half away from zero. */
function fixedScale(value: unknown, precision: number, scale: number): string {
  const input = describeValue(value);
  const special = NUMERIC_SPECIAL.exec(input);
  if (special !== null) {
    if (special[1] !== undefined) return 'NaN';
    throw numericFieldOverflow(precision, scale, true);
  }
  const { negative, digits, exponent } = numericDigits(input);
  const cut = digits === '' ? 0 : digits.length + exponent + scale;
  const kept = cut > 0 ? digits.slice(0, cut).padEnd(cut, '0') : '';
  const rounded = kept.length > precision ? null : BigInt(kept || '0') + (cut >= 0 && digits.charAt(cut) >= '5' ? 1n : 0n);
  if (rounded === null || rounded >= 10n ** BigInt(precision)) throw numericFieldOverflow(precision, scale, false);
  const text = rounded.toString().padStart(scale + 1, '0');
  const body = scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
  return negative && rounded !== 0n ? `-${body}` : body;
}

/** The stored (pg output) form of `value` written to `column`, raising the SQLSTATE PostgreSQL raises for a value the type rejects. */
function coerce(column: CatalogColumn, value: unknown): unknown {
  if (isNull(value)) return null;
  if (column.array) {
    if (!Array.isArray(value)) throw pgError('22P02', `malformed array literal: "${describeValue(value)}"`);
    return value.map((item: unknown) => (isNull(item) ? null : coerceScalar(column, item)));
  }
  return coerceScalar(column, value);
}

function coerceScalar(column: CatalogColumn, value: unknown): unknown {
  switch (column.kind) {
    case 'uuid':
      return toUuid(value);
    case 'text':
      return value instanceof Bpchar ? value.text.trimEnd() : textOf(value);
    case 'char': {
      const text = value instanceof Bpchar ? value.text : textOf(value);
      const length = column.length ?? 1;
      if (text.trimEnd().length > length) throw pgError('22001', `value too long for type character(${length})`);
      return text.slice(0, Math.max(length, text.trimEnd().length)).padEnd(length, ' ');
    }
    case 'int4':
      return toInt4(value);
    case 'int8':
    case 'xid8':
      return toBigInt(value).toString();
    case 'numeric':
      return fixedScale(value, column.precision ?? NUMERIC_MAX_PRECISION, column.scale ?? 0);
    case 'timestamp':
      return toDate(value);
    case 'bool':
      return toBool(value);
    case 'jsonb':
      return typeof value === 'string' ? (JSON.parse(value) as unknown) : structuredClone(value);
  }
}

/** PostgreSQL's text form of an evaluated value. */
function textOf(value: unknown): string {
  if (value instanceof Bpchar) return value.text.trimEnd();
  if (value instanceof Date) return timestampText(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** The form an expression reads a stored value in: `char(n)` as Bpchar and `int8`/`xid8` as bigint. */
function evalForm(column: CatalogColumn, stored: unknown): unknown {
  if (isNull(stored)) return null;
  if (column.kind === 'char') return new Bpchar(String(stored));
  if ((column.kind === 'int8' || column.kind === 'xid8') && !column.array) return BigInt(String(stored));
  return stored;
}

/** The form node-pg returns an evaluated value in. */
function wireForm(value: unknown): unknown {
  if (isNull(value)) return null;
  if (value instanceof Bpchar) return value.text;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(wireForm);
  return typeof value === 'object' ? structuredClone(value) : value;
}

/** A stored row copied as node-pg returns it. */
function copyRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, wireForm(value)]));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SQL order of two values (bytewise for text, as `COLLATE "C"`); null when either is NULL. */
function compareValues(a: unknown, b: unknown): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (a instanceof Bpchar || b instanceof Bpchar) {
    const text = (v: unknown): string => (v instanceof Bpchar ? v.text : textOf(v)).trimEnd();
    return compareText(text(a), text(b));
  }
  if (a instanceof Date || b instanceof Date) return Math.sign(toDate(a).getTime() - toDate(b).getTime());
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const [x, y] = [toBigInt(a), toBigInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'number' || typeof b === 'number') return Math.sign(Number(a) - Number(b));
  if (typeof a === 'boolean' || typeof b === 'boolean') return Math.sign(Number(toBool(a)) - Number(toBool(b)));
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      const order = compareValues(a[i], b[i]);
      if (order === null || order !== 0) return order;
    }
    return Math.sign(a.length - b.length);
  }
  return compareText(textOf(a), textOf(b));
}

/** Whether two values are not distinct: NULL equals NULL, otherwise SQL equality. */
function notDistinct(a: unknown, b: unknown): boolean {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  return compareValues(a, b) === 0;
}

/** Key text of a row's `columns` for primary-key and unique lookups; null when a column is NULL, which never conflicts. */
function keyText(table: CatalogTable, columns: readonly string[], row: Readonly<Record<string, unknown>>): string | null {
  const parts: string[] = [];
  for (const name of columns) {
    const value = row[name];
    if (isNull(value)) return null;
    const column = table.column.get(name);
    parts.push(value instanceof Date ? String(value.getTime()) : column?.kind === 'char' ? String(value).trimEnd() : String(value));
  }
  return parts.join('\u0001');
}

type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'param' | 'op';

/** One SQL token; a `word` is lower-cased, an `ident` and a `string` keep their text. */
interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const OPERATORS = ['::', '<=', '>=', '<>', '!=', '&&', '||', '(', ')', ',', '.', ';', '=', '<', '>', '+', '-', '*', '[', ']'] as const;
const TOKEN_PATTERNS: readonly (readonly [TokenKind | 'skip', RegExp])[] = [
  ['skip', /\s+|--[^\n]*/y],
  ['string', /'((?:[^']|'')*)'/y],
  ['ident', /"((?:[^"]|"")*)"/y],
  ['param', /\$(\d+)/y],
  ['word', /[A-Za-z_][A-Za-z0-9_$]*/y],
  ['number', /\d+(?:\.\d+)?/y],
];

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  scan: while (at < sql.length) {
    for (const [kind, pattern] of TOKEN_PATTERNS) {
      pattern.lastIndex = at;
      const match = pattern.exec(sql);
      if (match === null) continue;
      at = pattern.lastIndex;
      if (kind === 'string') tokens.push({ kind, text: (match[1] ?? '').replace(/''/g, "'") });
      else if (kind === 'ident') tokens.push({ kind, text: (match[1] ?? '').replace(/""/g, '"') });
      else if (kind === 'param') tokens.push({ kind, text: match[1] ?? '' });
      else if (kind === 'word') tokens.push({ kind, text: match[0].toLowerCase() });
      else if (kind === 'number') tokens.push({ kind, text: match[0] });
      continue scan;
    }
    const op = OPERATORS.find((candidate) => sql.startsWith(candidate, at));
    if (op === undefined) unsupported(`the character ${JSON.stringify(sql.charAt(at))}`);
    tokens.push({ kind: 'op', text: op });
    at += op.length;
  }
  return tokens;
}

type Expr =
  | { readonly k: 'col'; readonly table?: string; readonly name: string }
  | { readonly k: 'param'; readonly n: number }
  | { readonly k: 'lit'; readonly v: string | number | boolean | null }
  | { readonly k: 'default' }
  | { readonly k: 'star' }
  | { readonly k: 'cast'; readonly e: Expr; readonly type: string }
  | { readonly k: 'fn'; readonly name: string; readonly args: readonly Expr[] }
  | { readonly k: 'not'; readonly e: Expr }
  | { readonly k: 'bin'; readonly op: string; readonly l: Expr; readonly r: Expr }
  | { readonly k: 'isnull'; readonly e: Expr; readonly not: boolean }
  | { readonly k: 'distinct'; readonly l: Expr; readonly r: Expr; readonly not: boolean }
  | { readonly k: 'any'; readonly op: string; readonly l: Expr; readonly r: Expr }
  | { readonly k: 'in'; readonly l: Expr; readonly list: readonly Expr[]; readonly not: boolean }
  | { readonly k: 'row'; readonly items: readonly Expr[] }
  | { readonly k: 'array'; readonly items: readonly Expr[] }
  | { readonly k: 'exists'; readonly select: SelectStmt }
  | { readonly k: 'subquery'; readonly select: SelectStmt };

type SelectItem = { readonly star: true } | { readonly star: false; readonly e: Expr; readonly alias?: string };

interface OrderItem {
  readonly e: Expr;
  readonly desc: boolean;
  readonly nullsFirst: boolean;
}

interface TableRef {
  readonly table: TableName;
  readonly alias?: string;
}

interface Assignment {
  readonly column: string;
  readonly e: Expr;
}

interface SelectStmt {
  readonly kind: 'select';
  readonly items: readonly SelectItem[];
  from?: TableRef;
  join?: { readonly ref: TableRef; readonly on: Expr };
  where?: Expr;
  groupBy: readonly Expr[];
  orderBy: readonly OrderItem[];
  limit?: Expr;
  offset?: Expr;
}

type ConflictClause =
  | { readonly columns?: readonly string[]; readonly action: 'nothing' }
  | { readonly columns?: readonly string[]; readonly action: 'update'; readonly set: readonly Assignment[]; readonly where?: Expr };

interface InsertStmt {
  readonly kind: 'insert';
  readonly target: TableRef;
  readonly columns: readonly string[];
  values?: Expr[][];
  source?: SelectStmt;
  conflict?: ConflictClause;
  returning?: readonly SelectItem[];
}

interface UpdateStmt {
  readonly kind: 'update';
  readonly target: TableRef;
  readonly set: readonly Assignment[];
  where?: Expr;
  returning?: readonly SelectItem[];
}

interface DeleteStmt {
  readonly kind: 'delete';
  readonly target: TableRef;
  where?: Expr;
  returning?: readonly SelectItem[];
}

type DataStmt = SelectStmt | InsertStmt | UpdateStmt | DeleteStmt;

const RESERVED_AFTER_TABLE: ReadonlySet<string> = new Set(['where', 'join', 'inner', 'on', 'set', 'values', 'order', 'group', 'limit', 'offset', 'for', 'returning', 'select']);
const COMPARISONS: ReadonlySet<string> = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);

/** Recursive-descent parser of the SQL subset the timesheets app and the platform emit against schema `timesheets`. */
class SqlParser {
  private pos = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private isWord(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'word' && token.text === word;
  }

  private isOp(op: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'op' && token.text === op;
  }

  private eatWord(word: string): boolean {
    if (!this.isWord(word)) return false;
    this.pos += 1;
    return true;
  }

  private eatOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.pos += 1;
    return true;
  }

  private expectWord(word: string): void {
    if (!this.eatWord(word)) this.fail(word.toUpperCase());
  }

  private expectOp(op: string): void {
    if (!this.eatOp(op)) this.fail(`'${op}'`);
  }

  private fail(expected: string): never {
    const token = this.peek();
    return unsupported(`${expected} expected at ${token === undefined ? 'the end' : JSON.stringify(token.text)}`);
  }

  private name(): string {
    const token = this.peek();
    if (token?.kind !== 'word' && token?.kind !== 'ident') return this.fail('a name');
    this.pos += 1;
    return token.text;
  }

  private names(): string[] {
    this.expectOp('(');
    const names = [this.name()];
    while (this.eatOp(',')) names.push(this.name());
    this.expectOp(')');
    return names;
  }

  statement(): DataStmt {
    let stmt: DataStmt;
    if (this.isWord('select')) stmt = this.select();
    else if (this.isWord('insert')) stmt = this.insert();
    else if (this.isWord('update')) stmt = this.update();
    else if (this.isWord('delete')) stmt = this.delete();
    else return this.fail('SELECT, INSERT, UPDATE or DELETE');
    this.eatOp(';');
    if (this.pos < this.tokens.length) this.fail('the end of the statement');
    return stmt;
  }

  private tableRef(): TableRef {
    const schema = this.name();
    if (!this.eatOp('.')) return unsupported(`the unqualified table ${schema}`);
    const table = this.name();
    if (schema !== TIMESHEETS_SCHEMA || !(TABLE_NAMES as readonly string[]).includes(table)) {
      return unsupported(`the table ${schema}.${table}, which schema ${TIMESHEETS_SCHEMA} does not hold`);
    }
    let alias: string | undefined;
    if (this.eatWord('as')) {
      alias = this.name();
    } else {
      const token = this.peek();
      if (token?.kind === 'word' && !RESERVED_AFTER_TABLE.has(token.text)) {
        alias = token.text;
        this.pos += 1;
      }
    }
    return alias === undefined ? { table: table as TableName } : { table: table as TableName, alias };
  }

  private select(): SelectStmt {
    this.expectWord('select');
    const stmt: SelectStmt = { kind: 'select', items: this.selectItems(), groupBy: [], orderBy: [] };
    if (this.eatWord('from')) {
      stmt.from = this.tableRef();
      if (this.eatWord('inner') || this.isWord('join')) {
        this.expectWord('join');
        const ref = this.tableRef();
        this.expectWord('on');
        stmt.join = { ref, on: this.expr() };
      }
    }
    if (this.eatWord('where')) stmt.where = this.expr();
    if (this.eatWord('group')) {
      this.expectWord('by');
      stmt.groupBy = this.exprList();
    }
    if (this.eatWord('order')) {
      this.expectWord('by');
      const items = [this.orderItem()];
      while (this.eatOp(',')) items.push(this.orderItem());
      stmt.orderBy = items;
    }
    if (this.eatWord('limit')) stmt.limit = this.expr();
    if (this.eatWord('offset')) stmt.offset = this.expr();
    // Row locks only serialise concurrent transactions; the recording db runs each statement atomically, so they read like plain selects.
    if (this.eatWord('for')) this.lockClause();
    return stmt;
  }

  private lockClause(): void {
    if (this.eatWord('no')) {
      this.expectWord('key');
      this.expectWord('update');
    } else if (this.eatWord('key')) {
      this.expectWord('share');
    } else if (!this.eatWord('update') && !this.eatWord('share')) {
      this.fail('UPDATE or SHARE');
    }
    if (this.eatWord('of')) {
      this.name();
      while (this.eatOp(',')) this.name();
    }
    if (this.eatWord('skip')) this.expectWord('locked');
    else this.eatWord('nowait');
  }

  private selectItems(): SelectItem[] {
    const items = [this.selectItem()];
    while (this.eatOp(',')) items.push(this.selectItem());
    return items;
  }

  private selectItem(): SelectItem {
    if (this.eatOp('*')) return { star: true };
    const e = this.expr();
    return this.eatWord('as') ? { star: false, e, alias: this.name() } : { star: false, e };
  }

  private orderItem(): OrderItem {
    const e = this.expr();
    const desc = this.eatWord('desc') ? true : (this.eatWord('asc'), false);
    let nullsFirst = desc;
    if (this.eatWord('nulls')) {
      if (this.eatWord('first')) nullsFirst = true;
      else if (this.eatWord('last')) nullsFirst = false;
      else this.fail('FIRST or LAST');
    }
    return { e, desc, nullsFirst };
  }

  private insert(): InsertStmt {
    this.expectWord('insert');
    this.expectWord('into');
    const stmt: InsertStmt = { kind: 'insert', target: this.tableRef(), columns: this.names() };
    if (this.eatWord('values')) {
      stmt.values = [this.tuple()];
      while (this.eatOp(',')) stmt.values.push(this.tuple());
    } else if (this.isWord('select')) {
      stmt.source = this.select();
    } else {
      this.fail('VALUES or SELECT');
    }
    if (this.eatWord('on')) {
      this.expectWord('conflict');
      const columns = this.isOp('(') ? this.names() : undefined;
      this.expectWord('do');
      if (this.eatWord('nothing')) {
        stmt.conflict = columns === undefined ? { action: 'nothing' } : { columns, action: 'nothing' };
      } else {
        this.expectWord('update');
        this.expectWord('set');
        const set = this.assignments();
        const where = this.eatWord('where') ? this.expr() : undefined;
        stmt.conflict = { ...(columns === undefined ? {} : { columns }), action: 'update', set, ...(where === undefined ? {} : { where }) };
      }
    }
    if (this.eatWord('returning')) stmt.returning = this.selectItems();
    return stmt;
  }

  private update(): UpdateStmt {
    this.expectWord('update');
    const target = this.tableRef();
    this.expectWord('set');
    const stmt: UpdateStmt = { kind: 'update', target, set: this.assignments() };
    if (this.eatWord('where')) stmt.where = this.expr();
    if (this.eatWord('returning')) stmt.returning = this.selectItems();
    return stmt;
  }

  private delete(): DeleteStmt {
    this.expectWord('delete');
    this.expectWord('from');
    const stmt: DeleteStmt = { kind: 'delete', target: this.tableRef() };
    if (this.eatWord('where')) stmt.where = this.expr();
    if (this.eatWord('returning')) stmt.returning = this.selectItems();
    return stmt;
  }

  private assignments(): Assignment[] {
    const set: Assignment[] = [];
    do {
      const column = this.name();
      this.expectOp('=');
      set.push({ column, e: this.expr() });
    } while (this.eatOp(','));
    return set;
  }

  private tuple(): Expr[] {
    this.expectOp('(');
    const items = this.exprList();
    this.expectOp(')');
    return items;
  }

  private exprList(): Expr[] {
    const items = [this.expr()];
    while (this.eatOp(',')) items.push(this.expr());
    return items;
  }

  private expr(): Expr {
    let e = this.and();
    while (this.eatWord('or')) e = { k: 'bin', op: 'or', l: e, r: this.and() };
    return e;
  }

  private and(): Expr {
    let e = this.not();
    while (this.eatWord('and')) e = { k: 'bin', op: 'and', l: e, r: this.not() };
    return e;
  }

  private not(): Expr {
    return this.eatWord('not') ? { k: 'not', e: this.not() } : this.predicate();
  }

  private predicate(): Expr {
    const l = this.additive();
    const token = this.peek();
    if (token?.kind === 'op' && COMPARISONS.has(token.text)) {
      this.pos += 1;
      if (this.isWord('any') && this.isOp('(', 1)) {
        this.pos += 2;
        const r = this.expr();
        this.expectOp(')');
        return { k: 'any', op: token.text, l, r };
      }
      return { k: 'bin', op: token.text, l, r: this.additive() };
    }
    if (this.eatOp('&&')) return { k: 'bin', op: '&&', l, r: this.additive() };
    if (this.eatWord('is')) {
      const not = this.eatWord('not');
      if (this.eatWord('null')) return { k: 'isnull', e: l, not };
      this.expectWord('distinct');
      this.expectWord('from');
      return { k: 'distinct', l, r: this.additive(), not };
    }
    const notIn = this.isWord('not') && this.isWord('in', 1);
    if (notIn || this.isWord('in')) {
      this.pos += notIn ? 2 : 1;
      this.expectOp('(');
      const list = this.exprList();
      this.expectOp(')');
      return { k: 'in', l, list, not: notIn };
    }
    return l;
  }

  private additive(): Expr {
    let e = this.postfix();
    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'op' || !['+', '-', '||'].includes(token.text)) return e;
      this.pos += 1;
      e = { k: 'bin', op: token.text, l: e, r: this.postfix() };
    }
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.eatOp('::')) {
        e = { k: 'cast', e, type: this.typeName() };
      } else if (this.eatWord('collate')) {
        // Text always compares bytewise here, which is what every COLLATE "C" the statements name asks for.
        this.name();
      } else {
        return e;
      }
    }
  }

  private typeName(): string {
    let type = this.name();
    if (this.eatOp('(')) {
      while (!this.eatOp(')')) this.pos += 1;
    }
    if (this.eatOp('[')) {
      this.expectOp(']');
      type += '[]';
    }
    return type;
  }

  private primary(): Expr {
    const token = this.peek();
    if (token === undefined) return this.fail('an expression');
    if (token.kind === 'param') {
      this.pos += 1;
      return { k: 'param', n: Number(token.text) };
    }
    if (token.kind === 'string') {
      this.pos += 1;
      return { k: 'lit', v: token.text };
    }
    if (token.kind === 'number') {
      this.pos += 1;
      return { k: 'lit', v: Number(token.text) };
    }
    if (token.kind === 'op') return this.parenthesised(token);
    if (token.kind === 'word') {
      const keyword = this.keyword(token.text);
      if (keyword !== undefined) return keyword;
      if (this.isOp('(', 1)) return this.call();
    }
    return this.column();
  }

  private parenthesised(token: Token): Expr {
    if (this.eatOp('-')) return { k: 'bin', op: '-', l: { k: 'lit', v: 0 }, r: this.postfix() };
    if (token.text !== '(') return this.fail('an expression');
    this.pos += 1;
    if (this.isWord('select')) {
      const select = this.select();
      this.expectOp(')');
      return { k: 'subquery', select };
    }
    const items = this.exprList();
    this.expectOp(')');
    return items.length === 1 ? (items[0] as Expr) : { k: 'row', items };
  }

  private keyword(word: string): Expr | undefined {
    switch (word) {
      case 'null':
        this.pos += 1;
        return { k: 'lit', v: null };
      case 'true':
      case 'false':
        this.pos += 1;
        return { k: 'lit', v: word === 'true' };
      case 'default':
        this.pos += 1;
        return { k: 'default' };
      case 'exists': {
        this.pos += 1;
        this.expectOp('(');
        const select = this.select();
        this.expectOp(')');
        return { k: 'exists', select };
      }
      case 'array': {
        this.pos += 1;
        this.expectOp('[');
        const items = this.isOp(']') ? [] : this.exprList();
        this.expectOp(']');
        return { k: 'array', items };
      }
      case 'localtimestamp':
        this.pos += 1;
        if (this.eatOp('(')) {
          this.pos += 1;
          this.expectOp(')');
        }
        return { k: 'fn', name: 'localtimestamp', args: [] };
      default:
        return undefined;
    }
  }

  private call(): Expr {
    const name = this.name();
    this.expectOp('(');
    let args: Expr[] = [];
    if (this.eatOp('*')) args = [{ k: 'star' }];
    else if (!this.isOp(')')) args = this.exprList();
    this.expectOp(')');
    return { k: 'fn', name, args };
  }

  private column(): Expr {
    const parts = [this.name()];
    while (this.eatOp('.')) parts.push(this.name());
    const name = parts.at(-1) as string;
    const table = parts.at(-2);
    return table === undefined ? { k: 'col', name } : { k: 'col', table, name };
  }
}

const parsedStatements = new Map<string, DataStmt>();

/** The parsed statement, cached by its text; the platform builds the same texts again and again. */
function parseStatement(sql: string): DataStmt {
  let stmt = parsedStatements.get(sql);
  if (stmt === undefined) {
    stmt = new SqlParser(tokenize(sql)).statement();
    parsedStatements.set(sql, stmt);
  }
  return stmt;
}

/** A row value `(a, b, …)`: compared item by item. */
class RowValue {
  constructor(readonly items: readonly unknown[]) {}
}

/** The value `pg_current_snapshot()` evaluates to; only the snapshot accessors read it. */
const SNAPSHOT: unique symbol = Symbol('pg_current_snapshot');
/** Marks an insert cell that takes its column default. */
const DEFAULT_VALUE: unique symbol = Symbol('DEFAULT');

/** What one statement runs with: the store, its session and transaction, and the bound parameters. */
interface Exec {
  readonly store: RecordingStore;
  readonly session: Session;
  readonly tx: Tx;
  readonly params: readonly unknown[];
}

/** A stored row bound to a qualifier; expressions read its values in evaluation form. */
interface Binding {
  readonly table: CatalogTable;
  readonly stored: Readonly<Record<string, unknown>>;
}

/** Rows an expression reads by qualifier; `outer` is the enclosing query's scope, `group` the member rows of an aggregate. */
interface Scope {
  readonly ex: Exec;
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly outer?: Scope;
  readonly group?: readonly Scope[];
  /** Output values by alias, which an unqualified ORDER BY name refers to first. */
  readonly output?: ReadonlyMap<string, unknown>;
}

function emptyScope(ex: Exec, outer?: Scope): Scope {
  return outer === undefined ? { ex, bindings: new Map() } : { ex, bindings: new Map(), outer };
}

function bind(table: CatalogTable, stored: Readonly<Record<string, unknown>>): Binding {
  return { table, stored };
}

function scopeOf(ex: Exec, entries: readonly (readonly [string, Binding])[], outer?: Scope): Scope {
  const bindings = new Map(entries);
  return outer === undefined ? { ex, bindings } : { ex, bindings, outer };
}

function columnLabel(e: Extract<Expr, { k: 'col' }>): string {
  return e.table === undefined ? e.name : `${e.table}.${e.name}`;
}

/** The binding and catalogue column an expression's column reference resolves to, innermost scope first. */
function resolveColumn(e: Extract<Expr, { k: 'col' }>, scope: Scope): { value: unknown; column: CatalogColumn } {
  for (let current: Scope | undefined = scope; current !== undefined; current = current.outer) {
    let binding: Binding | undefined;
    if (e.table !== undefined) {
      binding = current.bindings.get(e.table);
    } else {
      for (const candidate of current.bindings.values()) {
        if (!candidate.table.column.has(e.name)) continue;
        if (binding !== undefined) unsupported(`the ambiguous column ${e.name}`);
        binding = candidate;
      }
    }
    if (binding === undefined) continue;
    const column = binding.table.column.get(e.name);
    if (column === undefined) throw pgError('42703', `column ${columnLabel(e)} does not exist`);
    return { value: evalForm(column, binding.stored[e.name]), column };
  }
  throw pgError('42703', `column ${columnLabel(e)} does not exist`);
}

/** The column an operand reads directly, so the other operand is read as that column's type, as PostgreSQL resolves an untyped parameter. */
function operandColumn(e: Expr, scope: Scope): CatalogColumn | undefined {
  const inner = e.k === 'cast' ? undefined : e;
  if (inner?.k !== 'col') return undefined;
  const { column } = resolveColumn(inner, scope);
  return column.array ? undefined : column;
}

function asColumnType(column: CatalogColumn | undefined, value: unknown): unknown {
  if (column === undefined || isNull(value) || value instanceof Bpchar || value instanceof RowValue) return value;
  switch (column.kind) {
    case 'char':
      return new Bpchar(textOf(value));
    case 'uuid':
      return toUuid(value);
    case 'int8':
    case 'xid8':
      return toBigInt(value);
    case 'int4':
      return toInt4(value);
    case 'timestamp':
      return toDate(value);
    case 'bool':
      return toBool(value);
    default:
      return value;
  }
}

function truth(value: unknown): boolean | null {
  return isNull(value) ? null : toBool(value);
}

function holds(op: string, order: number | null): boolean | null {
  if (order === null) return null;
  switch (op) {
    case '=':
      return order === 0;
    case '<>':
    case '!=':
      return order !== 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    default:
      return unsupported(`the operator ${op}`);
  }
}

/** SQL comparison of two evaluated values, row values item by item. */
function compareOperands(a: unknown, b: unknown): number | null {
  if (a instanceof RowValue && b instanceof RowValue) {
    for (let i = 0; i < Math.max(a.items.length, b.items.length); i += 1) {
      const order = compareValues(a.items[i], b.items[i]);
      if (order === null || order !== 0) return order;
    }
    return 0;
  }
  return compareValues(a, b);
}

function rowNotDistinct(a: unknown, b: unknown): boolean {
  if (a instanceof RowValue && b instanceof RowValue) {
    return a.items.length === b.items.length && a.items.every((item, i) => notDistinct(item, b.items[i]));
  }
  return notDistinct(a, b);
}

function anyTrue(results: readonly (boolean | null)[]): boolean | null {
  if (results.includes(true)) return true;
  return results.includes(null) ? null : false;
}

function evaluate(e: Expr, scope: Scope): unknown {
  switch (e.k) {
    case 'col':
      return resolveColumn(e, scope).value;
    case 'param': {
      const { params } = scope.ex;
      if (e.n > params.length) throw pgError('08P01', `bind message supplies ${params.length} parameters, but the statement requires $${e.n}`);
      return paramValue(params[e.n - 1]);
    }
    case 'lit':
      return e.v;
    case 'default':
      return DEFAULT_VALUE;
    case 'star':
      return unsupported('* outside count(*)');
    case 'cast':
      return castValue(evaluate(e.e, scope), e.type);
    case 'fn':
      return callFunction(e, scope);
    case 'not': {
      const value = truth(evaluate(e.e, scope));
      return value === null ? null : !value;
    }
    case 'bin':
      return binary(e.op, e.l, e.r, scope);
    case 'isnull': {
      const value = evaluate(e.e, scope);
      const none = value instanceof RowValue ? value.items.every(isNull) : isNull(value);
      return e.not ? !none : none;
    }
    case 'distinct': {
      const same = rowNotDistinct(evaluate(e.l, scope), evaluate(e.r, scope));
      return e.not ? same : !same;
    }
    case 'any': {
      const column = operandColumn(e.l, scope);
      const left = evaluate(e.l, scope);
      const list = evaluate(e.r, scope);
      if (isNull(list)) return null;
      if (!Array.isArray(list)) return unsupported('ANY over a non-array');
      return anyTrue(list.map((item: unknown) => holds(e.op, compareOperands(left, asColumnType(column, item)))));
    }
    case 'in': {
      const left = evaluate(e.l, scope);
      const found = anyTrue(e.list.map((item) => holds('=', compareOperands(left, evaluate(item, scope)))));
      return found === null ? null : e.not ? !found : found;
    }
    case 'row':
      return new RowValue(e.items.map((item) => evaluate(item, scope)));
    case 'array':
      return e.items.map((item) => evaluate(item, scope));
    case 'exists':
      return runSelect(scope.ex, e.select, scope).rows.length > 0;
    case 'subquery': {
      const { rows } = runSelect(scope.ex, e.select, scope);
      if (rows.length > 1) throw pgError('21000', 'more than one row returned by a subquery used as an expression');
      return rows[0]?.[0] ?? null;
    }
  }
}

/** A parameter as the server receives it from node-pg; undefined binds NULL. */
function paramValue(value: unknown): unknown {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.map(paramValue) : value;
}

function binary(op: string, l: Expr, r: Expr, scope: Scope): unknown {
  if (op === 'and' || op === 'or') {
    const left = truth(evaluate(l, scope));
    if (op === 'and' && left === false) return false;
    if (op === 'or' && left === true) return true;
    const right = truth(evaluate(r, scope));
    if (op === 'and') return right === false ? false : left === null || right === null ? null : true;
    return right === true ? true : left === null || right === null ? null : false;
  }
  if (COMPARISONS.has(op)) {
    const [leftColumn, rightColumn] = [operandColumn(l, scope), operandColumn(r, scope)];
    const left = asColumnType(rightColumn, evaluate(l, scope));
    const right = asColumnType(leftColumn, evaluate(r, scope));
    return holds(op, compareOperands(left, right));
  }
  const left = evaluate(l, scope);
  const right = evaluate(r, scope);
  if (isNull(left) || isNull(right)) return null;
  switch (op) {
    case '&&':
      if (!Array.isArray(left) || !Array.isArray(right)) return unsupported('&& over non-arrays');
      return left.some((item: unknown) => right.some((other: unknown) => compareValues(item, other) === 0));
    case '||':
      return `${textOf(left)}${textOf(right)}`;
    case '+':
    case '-': {
      if (typeof left === 'bigint' || typeof right === 'bigint') {
        const [x, y] = [toBigInt(left), toBigInt(right)];
        return op === '+' ? x + y : x - y;
      }
      return op === '+' ? Number(left) + Number(right) : Number(left) - Number(right);
    }
    default:
      return unsupported(`the operator ${op}`);
  }
}

function castValue(value: unknown, type: string): unknown {
  if (type.endsWith('[]')) {
    if (isNull(value)) return null;
    if (!Array.isArray(value)) throw pgError('22P02', `malformed array literal: "${describeValue(value)}"`);
    const base = type.slice(0, -2);
    return value.map((item: unknown) => (isNull(item) ? null : castValue(item, base)));
  }
  if (isNull(value)) return null;
  switch (type) {
    case 'text':
    case 'varchar':
      return textOf(value);
    case 'bpchar':
      return value instanceof Bpchar ? value : new Bpchar(textOf(value));
    case 'uuid':
      return toUuid(value);
    case 'xid8':
    case 'bigint':
    case 'int8':
      return toBigInt(value);
    case 'integer':
    case 'int':
    case 'int4':
      return toInt4(value);
    case 'boolean':
    case 'bool':
      return toBool(value);
    case 'timestamp':
      return toDate(value);
    case 'jsonb':
      return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    default:
      return unsupported(`the cast to ${type}`);
  }
}

function hasAggregate(e: Expr): boolean {
  switch (e.k) {
    case 'fn':
      return e.name === 'count' || e.args.some(hasAggregate);
    case 'cast':
    case 'not':
    case 'isnull':
      return hasAggregate(e.e);
    case 'bin':
    case 'distinct':
    case 'any':
      return hasAggregate(e.l) || hasAggregate(e.r);
    case 'in':
      return hasAggregate(e.l) || e.list.some(hasAggregate);
    case 'row':
    case 'array':
      return e.items.some(hasAggregate);
    default:
      return false;
  }
}

/** `date` formatted by the to_char patterns the statements use: YYYY, MM, DD, HH24, MI, SS, MS and "quoted" text. */
function toChar(date: Date, format: string): string {
  return format.replace(/"([^"]*)"|YYYY|HH24|MS|MI|MM|SS|DD/g, (token: string, quoted: string | undefined) => {
    if (quoted !== undefined) return quoted;
    switch (token) {
      case 'YYYY':
        return pad(date.getFullYear(), 4);
      case 'HH24':
        return pad(date.getHours());
      case 'MS':
        return pad(date.getMilliseconds(), 3);
      case 'MI':
        return pad(date.getMinutes());
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'SS':
        return pad(date.getSeconds());
      default:
        return pad(date.getDate());
    }
  });
}

/** `schema.table` named by `to_regclass` text, quoted or not, or undefined when it is not a table the catalogue holds. */
function regclass(store: RecordingStore, value: string): string | undefined {
  const match = /^"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?$/.exec(value.trim());
  if (match === null || match[1] !== TIMESHEETS_SCHEMA || !store.catalog.has(match[2] ?? '')) return undefined;
  return `${TIMESHEETS_SCHEMA}.${match[2] ?? ''}`;
}

function stringArg(value: unknown): string | null {
  return isNull(value) ? null : textOf(value);
}

function callFunction(e: Extract<Expr, { k: 'fn' }>, scope: Scope): unknown {
  const { ex } = scope;
  if (e.name === 'count') {
    if (scope.group === undefined) return unsupported('count() outside an aggregate query');
    const [arg] = e.args;
    if (arg === undefined || arg.k === 'star') return BigInt(scope.group.length);
    return BigInt(scope.group.filter((member) => !isNull(evaluate(arg, member))).length);
  }
  const args = e.args.map((arg) => evaluate(arg, scope));
  const [first, second, third] = args;
  switch (e.name) {
    case 'localtimestamp':
      return ex.store.clock.now();
    case 'pg_current_xact_id':
      return ex.store.ensureXid(ex.tx);
    case 'pg_current_snapshot':
      return SNAPSHOT;
    case 'pg_snapshot_xmin':
    case 'pg_snapshot_xmax':
      if (first !== SNAPSHOT) return unsupported(`${e.name} of anything but pg_current_snapshot()`);
      return e.name === 'pg_snapshot_xmin' ? ex.store.xmin() : ex.store.xmax();
    case 'set_config':
      return ex.store.setConfig(ex, textOf(first), textOf(second), toBool(third));
    case 'current_setting':
      return ex.store.currentSetting(ex, textOf(first), second === undefined ? false : toBool(second));
    case 'to_regclass':
      return isNull(first) ? null : (regclass(ex.store, textOf(first)) ?? null);
    case 'coalesce':
      return args.find((arg) => !isNull(arg)) ?? null;
    case 'lower':
      return stringArg(first)?.toLowerCase() ?? null;
    case 'rtrim': {
      const text = stringArg(first);
      const chars = second === undefined ? ' ' : stringArg(second);
      if (text === null || chars === null) return null;
      let end = text.length;
      while (end > 0 && chars.includes(text.charAt(end - 1))) end -= 1;
      return text.slice(0, end);
    }
    case 'translate': {
      const [text, from, to] = [stringArg(first), stringArg(second), stringArg(third)];
      if (text === null || from === null || to === null) return null;
      return [...text].flatMap((ch) => {
        const at = from.indexOf(ch);
        return at < 0 ? [ch] : at < to.length ? [to.charAt(at)] : [];
      }).join('');
    }
    case 'octet_length':
      return isNull(first) ? null : Buffer.byteLength(textOf(first), 'utf8');
    case 'char_length':
      return isNull(first) ? null : [...textOf(first)].length;
    case 'to_char':
      return isNull(first) || isNull(second) ? null : toChar(toDate(first), textOf(second));
    default:
      return unsupported(`the function ${e.name}()`);
  }
}

const TENANT_SETTING = 'app.tenant_id';
const SETTING_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ['lock_timeout', '0'],
  ['statement_timeout', '0'],
  ['timezone', process.env.TZ ?? 'UTC'],
]);
const FIRST_XID = 1000n;
const RECORDING_FAILURE_CODE = '08006';

/** A write staged in a transaction, logged as a RecordedWrite when it commits. */
interface PendingWrite {
  readonly table: TableName;
  readonly op: RecordedWrite['op'];
  readonly row: Readonly<Record<string, unknown>>;
  readonly tenantId: string | null;
}

type Overlay = Map<TableName, Map<string, Readonly<Record<string, unknown>> | null>>;

/** State a savepoint, or the start of a statement, rolls a transaction back to. */
interface TxMark {
  readonly overlay: Overlay;
  readonly writes: number;
  readonly settings: ReadonlyMap<string, string>;
}

function cloneOverlay(overlay: Overlay): Overlay {
  return new Map([...overlay].map(([table, rows]) => [table, new Map(rows)]));
}

/** One transaction: its staged rows stay invisible to other transactions until COMMIT; its xid is assigned at its first write. */
class Tx {
  xid: bigint | undefined;
  aborted = false;
  overlay: Overlay = new Map();
  readonly writes: PendingWrite[] = [];
  settings = new Map<string, string>();
  readonly savepoints: { readonly name: string; readonly mark: TxMark }[] = [];

  mark(): TxMark {
    return { overlay: cloneOverlay(this.overlay), writes: this.writes.length, settings: new Map(this.settings) };
  }

  restore(mark: TxMark): void {
    this.overlay = cloneOverlay(mark.overlay);
    this.writes.length = mark.writes;
    this.settings = new Map(mark.settings);
  }
}

/** A pooled connection's state: its open transaction and its session-level settings. */
interface Session {
  tx: Tx | undefined;
  readonly settings: Map<string, string>;
}

interface Failure {
  readonly matches: (text: string, normalized: string, values: readonly unknown[]) => boolean;
  readonly error: Error;
}

function normalizeSql(sql: string): string {
  return sql.replace(/"/g, '').replace(/\s+/g, ' ').trim().replace(/;$/, '').toLowerCase();
}

function failureMatcher(match: StatementMatcher): Failure['matches'] {
  if (typeof match === 'function') return (text, _normalized, values) => match(text, values);
  if (typeof match === 'string') {
    const wanted = normalizeSql(match);
    return (_text, normalized) => normalized.includes(wanted);
  }
  return (text, normalized) => {
    match.lastIndex = 0;
    if (match.test(text)) return true;
    match.lastIndex = 0;
    return match.test(normalized);
  };
}

/** The committed rows, the logs and the xid counter behind every connection of one recording db. */
class RecordingStore {
  readonly committed = new Map<TableName, Map<string, Readonly<Record<string, unknown>>>>();
  readonly writeLog: RecordedWrite[] = [];
  readonly queryLog: RecordedQuery[] = [];
  readonly failures: Failure[] = [];
  lastXid: bigint | undefined;
  private readonly open = new Set<Tx>();
  private readonly serials = new Map<string, bigint>();
  private nextXid = FIRST_XID;

  constructor(
    readonly catalog: ReadonlyMap<string, CatalogTable>,
    readonly clock: Clock,
  ) {
    for (const name of catalog.keys()) this.committed.set(name as TableName, new Map());
  }

  table(name: string): CatalogTable {
    const table = this.catalog.get(name);
    if (table === undefined) throw new TypeError(`the recording db models no table ${TIMESHEETS_SCHEMA}.${name}`);
    return table;
  }

  begin(): Tx {
    const tx = new Tx();
    this.open.add(tx);
    return tx;
  }

  finish(tx: Tx, commit: boolean): void {
    this.open.delete(tx);
    if (!commit) return;
    for (const [table, rows] of tx.overlay) {
      const target = this.committed.get(table) as Map<string, Readonly<Record<string, unknown>>>;
      for (const [key, row] of rows) {
        if (row === null) target.delete(key);
        else target.set(key, row);
      }
    }
    if (tx.writes.length === 0 || tx.xid === undefined) return;
    const xid = tx.xid.toString();
    this.lastXid = tx.xid;
    for (const write of tx.writes) this.writeLog.push({ ...write, row: copyRow(write.row), xid });
  }

  /** Rolls back the session's open transaction, if any, as releasing or resetting a connection does. */
  abandon(session: Session): void {
    if (session.tx !== undefined) this.finish(session.tx, false);
    session.tx = undefined;
  }

  ensureXid(tx: Tx): bigint {
    if (tx.xid === undefined) {
      tx.xid = this.nextXid;
      this.nextXid += 1n;
    }
    return tx.xid;
  }

  /** Oldest xid still in progress, or the next unassigned one when none is. */
  xmin(): bigint {
    let oldest = this.nextXid;
    for (const tx of this.open) if (tx.xid !== undefined && tx.xid < oldest) oldest = tx.xid;
    return oldest;
  }

  xmax(): bigint {
    return this.nextXid;
  }

  private nextSerial(table: TableName, column: string): bigint {
    const key = `${table}.${column}`;
    const next = (this.serials.get(key) ?? 0n) + 1n;
    this.serials.set(key, next);
    return next;
  }

  setConfig(ex: Exec, name: string, value: string, local: boolean): string {
    const setting = name.toLowerCase();
    (local ? ex.tx.settings : ex.session.settings).set(setting, value);
    return value;
  }

  currentSetting(ex: Exec, name: string, missingOk: boolean): string | null {
    const setting = name.toLowerCase();
    const value = ex.tx.settings.get(setting) ?? ex.session.settings.get(setting) ?? SETTING_DEFAULTS.get(setting);
    if (value === undefined && !missingOk) throw pgError('42704', `unrecognized configuration parameter "${name}"`);
    return value ?? null;
  }

  /** The transaction's RLS tenant: null when `app.tenant_id` is empty, so forced RLS hides every tenant row. */
  tenantOf(ex: Exec): string | null {
    const setting = ex.tx.settings.get(TENANT_SETTING) ?? ex.session.settings.get(TENANT_SETTING) ?? '';
    return setting === '' ? null : toUuid(setting);
  }

  /** Rows of `table` the transaction sees, committed rows overlaid by its own; forced RLS applies unless `rls` is false. */
  visible(ex: Exec, table: CatalogTable, rls = true): Readonly<Record<string, unknown>>[] {
    const committed = this.committed.get(table.name) as Map<string, Readonly<Record<string, unknown>>>;
    const staged = ex.tx.overlay.get(table.name);
    const rows: Readonly<Record<string, unknown>>[] = [];
    for (const [key, row] of committed) {
      const current = staged?.has(key) === true ? staged.get(key) : row;
      if (current !== null && current !== undefined) rows.push(current);
    }
    for (const [key, row] of staged ?? []) if (row !== null && !committed.has(key)) rows.push(row);
    if (!rls || !table.tenantOwned) return rows;
    const tenant = this.tenantOf(ex);
    return tenant === null ? [] : rows.filter((row) => row.tenant_id === tenant);
  }

  /** `values` completed with column defaults and stored in column types; throws as PostgreSQL does for a type, NOT NULL or CHECK violation. */
  completeRow(ex: Exec, table: CatalogTable, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const column of table.columns) {
      let value = values[column.name];
      if (value === undefined || value === DEFAULT_VALUE) value = this.fallback(ex, table, column);
      row[column.name] = coerce(column, value);
    }
    this.check(table, row);
    return row;
  }

  private fallback(ex: Exec | undefined, table: CatalogTable, column: CatalogColumn): unknown {
    const fallback = column.fallback;
    if (fallback === undefined) return null;
    switch (fallback.kind) {
      case 'value':
        return Array.isArray(fallback.value) ? [...(fallback.value as unknown[])] : fallback.value;
      case 'now':
        return this.clock.now();
      case 'serial':
        return this.nextSerial(table.name, column.name);
      case 'xid':
        return ex === undefined ? this.nextXid++ : this.ensureXid(ex.tx);
    }
  }

  private check(table: CatalogTable, row: Readonly<Record<string, unknown>>): void {
    for (const column of table.columns) {
      const value = row[column.name];
      if (column.notNull && isNull(value)) {
        throw pgError('23502', `null value in column "${column.name}" of relation "${table.name}" violates not-null constraint`);
      }
      if (column.allowed !== undefined && !isNull(value) && !column.allowed.includes(String(value))) {
        throw pgError('23514', `new row for relation "${table.name}" violates check constraint "${table.name}_${column.name}_check"`);
      }
    }
  }

  private rlsCheck(ex: Exec, table: CatalogTable, row: Readonly<Record<string, unknown>>): void {
    if (table.tenantOwned && row.tenant_id !== this.tenantOf(ex)) {
      throw pgError('42501', `new row violates row-level security policy for table "${table.name}"`);
    }
  }

  /** Stored rows that hold `row`'s values of a unique constraint, ignoring RLS as PostgreSQL's unique indexes do. */
  conflicts(ex: Exec, table: CatalogTable, row: Readonly<Record<string, unknown>>, self?: Readonly<Record<string, unknown>>): { columns: readonly string[]; existing: Readonly<Record<string, unknown>> }[] {
    const rows = this.visible(ex, table, false).filter((candidate) => candidate !== self);
    return table.unique.flatMap((columns) => {
      const wanted = keyText(table, columns, row);
      if (wanted === null) return [];
      const existing = rows.find((candidate) => keyText(table, columns, candidate) === wanted);
      return existing === undefined ? [] : [{ columns, existing }];
    });
  }

  private stage(ex: Exec, table: CatalogTable, key: string, row: Readonly<Record<string, unknown>> | null): void {
    let rows = ex.tx.overlay.get(table.name);
    if (rows === undefined) {
      rows = new Map();
      ex.tx.overlay.set(table.name, rows);
    }
    rows.set(key, row);
  }

  insert(ex: Exec, table: CatalogTable, row: Readonly<Record<string, unknown>>): void {
    this.rlsCheck(ex, table, row);
    const conflict = this.conflicts(ex, table, row)[0];
    if (conflict !== undefined) throw uniqueViolation(table, conflict.columns, row);
    this.ensureXid(ex.tx);
    this.stage(ex, table, keyText(table, table.primaryKey, row) as string, row);
    ex.tx.writes.push({ table: table.name, op: 'insert', row, tenantId: this.tenantOf(ex) });
  }

  update(ex: Exec, table: CatalogTable, before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): void {
    this.check(table, after);
    this.rlsCheck(ex, table, after);
    const conflict = this.conflicts(ex, table, after, before)[0];
    if (conflict !== undefined) throw uniqueViolation(table, conflict.columns, after);
    this.ensureXid(ex.tx);
    const oldKey = keyText(table, table.primaryKey, before) as string;
    const newKey = keyText(table, table.primaryKey, after) as string;
    if (oldKey !== newKey) this.stage(ex, table, oldKey, null);
    this.stage(ex, table, newKey, after);
    ex.tx.writes.push({ table: table.name, op: 'update', row: after, tenantId: this.tenantOf(ex) });
  }

  remove(ex: Exec, table: CatalogTable, row: Readonly<Record<string, unknown>>): void {
    this.ensureXid(ex.tx);
    this.stage(ex, table, keyText(table, table.primaryKey, row) as string, null);
    ex.tx.writes.push({ table: table.name, op: 'delete', row, tenantId: this.tenantOf(ex) });
  }

  /** Appends committed rows directly, completing omitted columns from their defaults; nothing is logged. */
  seedRows(name: string, rows: readonly Readonly<Record<string, unknown>>[]): void {
    const table = this.table(name);
    const target = this.committed.get(table.name) as Map<string, Readonly<Record<string, unknown>>>;
    for (const values of rows) {
      const unknownColumn = Object.keys(values).find((column) => !table.column.has(column));
      if (unknownColumn !== undefined) throw new TypeError(`${TIMESHEETS_SCHEMA}.${table.name} has no column ${unknownColumn}`);
      const row: Record<string, unknown> = {};
      for (const column of table.columns) {
        const value = values[column.name];
        row[column.name] = coerce(column, value === undefined ? this.fallback(undefined, table, column) : value);
      }
      this.check(table, row);
      const key = keyText(table, table.primaryKey, row) as string;
      if (target.has(key)) throw uniqueViolation(table, table.primaryKey, row);
      target.set(key, row);
    }
  }

  committedRows(name: string, tenantId?: string): Record<string, unknown>[] {
    const table = this.table(name);
    const wanted = tenantId === undefined ? undefined : tenantId.toLowerCase();
    return [...(this.committed.get(table.name) as Map<string, Readonly<Record<string, unknown>>>).values()]
      .filter((row) => wanted === undefined || row.tenant_id === wanted)
      .map(copyRow);
  }

  setGate(unit: string, state: GateState, phase: GatePhase): void {
    const table = this.table(UNIT_GATE_TABLE);
    const target = this.committed.get(table.name) as Map<string, Readonly<Record<string, unknown>>>;
    // unit_gate's CHECK ((state = 'closed') = (holder_id IS NOT NULL)) gives only a closed gate a holder.
    const row = { unit, state, holder_id: state === 'closed' ? TEST_GATE_HOLDER : null, phase, updated_at: this.clock.now() };
    target.set(keyText(table, table.primaryKey, row) as string, row);
  }
}

function uniqueViolation(table: CatalogTable, columns: readonly string[], row: Readonly<Record<string, unknown>>): PgError {
  const constraint = columns === table.primaryKey ? `${table.name}_pkey` : `${table.name}_${columns.join('_')}_key`;
  const values = columns.map((column) => describeValue(row[column])).join(', ');
  return Object.assign(pgError('23505', `duplicate key value violates unique constraint "${constraint}"`), {
    constraint,
    detail: `Key (${columns.join(', ')})=(${values}) already exists.`,
  });
}

/** Rows a query produced, in evaluation form, under its output column names. */
interface Projection {
  readonly names: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

function outputName(e: Expr): string {
  switch (e.k) {
    case 'col':
      return e.name;
    case 'cast':
      return e.e.k === 'col' || e.e.k === 'fn' ? outputName(e.e) : '?column?';
    case 'fn':
      return e.name;
    case 'exists':
      return 'exists';
    case 'array':
      return 'array';
    default:
      return '?column?';
  }
}

function bindingName(ref: TableRef): string {
  return ref.alias ?? ref.table;
}

function boundCount(e: Expr | undefined, ex: Exec, clause: string): number | undefined {
  if (e === undefined) return undefined;
  const value = evaluate(e, emptyScope(ex));
  if (isNull(value)) return undefined;
  const count = Number(toBigInt(value));
  if (count < 0) throw pgError('2201W', `${clause} must not be negative`);
  return count;
}

/** The source rows of a SELECT: its table, joined to its JOIN table, with the enclosing scope for correlated references. */
function sourceScopes(ex: Exec, stmt: SelectStmt, outer: Scope | undefined): Scope[] {
  const { from, join } = stmt;
  if (from === undefined) return [emptyScope(ex, outer)];
  const table = ex.store.table(from.table);
  const scopes = ex.store.visible(ex, table).map((row) => scopeOf(ex, [[bindingName(from), bind(table, row)]], outer));
  if (join === undefined) return scopes;
  const joined = ex.store.table(join.ref.table);
  const rightName = bindingName(join.ref);
  const right = ex.store.visible(ex, joined).map((row) => bind(joined, row));
  const keys = joinKeys(join.on, bindingName(from), rightName);
  // Equality conjuncts of ON pick each left row's candidates from a hash of the right rows; ON itself still decides every pair.
  const buckets = new Map<string, Binding[]>();
  for (const binding of right) {
    const key = hashKey(keys.map(({ right: column }) => evaluate(column, scopeOf(ex, [[rightName, binding]]))));
    if (key !== undefined) buckets.set(key, [...(buckets.get(key) ?? []), binding]);
  }
  return scopes.flatMap((left) => {
    const key = hashKey(keys.map(({ left: column }) => evaluate(column, left)));
    const candidates = keys.length === 0 ? right : key === undefined ? [] : (buckets.get(key) ?? []);
    return candidates
      .map((binding) => scopeOf(ex, [...left.bindings, [rightName, binding]], outer))
      .filter((scope) => truth(evaluate(join.on, scope)) === true);
  });
}

/** Column pairs `left.a = right.b` among the AND-ed conjuncts of a join condition. */
function joinKeys(on: Expr, left: string, right: string): { left: Expr; right: Expr }[] {
  if (on.k === 'bin' && on.op === 'and') return [...joinKeys(on.l, left, right), ...joinKeys(on.r, left, right)];
  if (on.k !== 'bin' || on.op !== '=' || on.l.k !== 'col' || on.r.k !== 'col') return [];
  if (on.l.table === left && on.r.table === right) return [{ left: on.l, right: on.r }];
  if (on.l.table === right && on.r.table === left) return [{ left: on.r, right: on.l }];
  return [];
}

/** Hash key of join values that equal values always share; undefined when one is NULL, which joins nothing. */
function hashKey(values: readonly unknown[]): string | undefined {
  const parts: string[] = [];
  for (const value of values) {
    if (isNull(value)) return undefined;
    parts.push(value instanceof Date ? String(value.getTime()) : typeof value === 'bigint' || typeof value === 'number' ? String(value) : textOf(value).trimEnd());
  }
  return parts.join('\u0001');
}

/** Output rows of `stmt` with the scopes their ORDER BY reads, grouped when the query aggregates. */
function groupScopes(stmt: SelectStmt, scopes: readonly Scope[], ex: Exec, outer: Scope | undefined): Scope[] {
  const aggregated = stmt.groupBy.length > 0 || stmt.items.some((item) => !item.star && hasAggregate(item.e));
  if (!aggregated) return [...scopes];
  const groups = new Map<string, Scope[]>();
  for (const scope of scopes) {
    const key = JSON.stringify(stmt.groupBy.map((e) => {
      const value = evaluate(e, scope);
      return isNull(value) ? null : textOf(value);
    }));
    groups.set(key, [...(groups.get(key) ?? []), scope]);
  }
  if (groups.size === 0 && stmt.groupBy.length === 0) groups.set('[]', []);
  return [...groups.values()].map((members) => ({ ...(members[0] ?? emptyScope(ex, outer)), group: members }));
}

function projectScope(stmt: SelectStmt, scope: Scope): { names: string[]; values: unknown[] } {
  const names: string[] = [];
  const values: unknown[] = [];
  for (const item of stmt.items) {
    if (item.star) {
      const from = stmt.from;
      if (from === undefined) return unsupported('SELECT * without FROM');
      const binding = scope.bindings.get(bindingName(from)) as Binding;
      for (const column of binding.table.columns) {
        names.push(column.name);
        values.push(evalForm(column, binding.stored[column.name]));
      }
      continue;
    }
    names.push(item.alias ?? outputName(item.e));
    values.push(evaluate(item.e, scope));
  }
  return { names, values };
}

function sortScopes(stmt: SelectStmt, scopes: readonly Scope[]): Scope[] {
  if (stmt.orderBy.length === 0) return [...scopes];
  const keyed = scopes.map((scope) => {
    const output = new Map<string, unknown>();
    const { names, values } = projectScope(stmt, scope);
    names.forEach((name, i) => output.set(name, values[i]));
    const keys = stmt.orderBy.map(({ e }) => (e.k === 'col' && e.table === undefined && output.has(e.name) ? output.get(e.name) : evaluate(e, { ...scope, output })));
    return { scope, keys };
  });
  keyed.sort((a, b) => {
    for (const [i, item] of stmt.orderBy.entries()) {
      const [x, y] = [a.keys[i], b.keys[i]];
      if (isNull(x) || isNull(y)) {
        if (isNull(x) && isNull(y)) continue;
        return isNull(x) === item.nullsFirst ? -1 : 1;
      }
      const order = compareValues(x, y) ?? 0;
      if (order !== 0) return item.desc ? -order : order;
    }
    return 0;
  });
  return keyed.map(({ scope }) => scope);
}

function runSelect(ex: Exec, stmt: SelectStmt, outer?: Scope): Projection {
  const [only] = stmt.items;
  if (stmt.from === undefined && stmt.items.length === 1 && only !== undefined && !only.star && only.e.k === 'fn' && only.e.name === 'unnest') {
    const list = evaluate(only.e.args[0] ?? { k: 'lit', v: null }, emptyScope(ex, outer));
    return { names: [only.alias ?? 'unnest'], rows: Array.isArray(list) ? list.map((item: unknown) => [item]) : [] };
  }
  const filtered = sourceScopes(ex, stmt, outer).filter((scope) => stmt.where === undefined || truth(evaluate(stmt.where, scope)) === true);
  const ordered = sortScopes(stmt, groupScopes(stmt, filtered, ex, outer));
  const offset = boundCount(stmt.offset, ex, 'OFFSET') ?? 0;
  const limit = boundCount(stmt.limit, ex, 'LIMIT');
  const page = ordered.slice(offset, limit === undefined ? undefined : offset + limit);
  let names: readonly string[] = stmt.items.flatMap((item) => (item.star ? [] : [item.alias ?? outputName(item.e)]));
  const rows = page.map((scope) => {
    const projected = projectScope(stmt, scope);
    names = projected.names;
    return projected.values;
  });
  return { names, rows };
}

/** Rows of a projection as node-pg returns them. */
function wireRows({ names, rows }: Projection): QueryResultRow[] {
  return rows.map((values) => Object.fromEntries(names.map((name, i) => [name, wireForm(values[i])])));
}

function returning(ex: Exec, table: CatalogTable, ref: TableRef, items: readonly SelectItem[] | undefined, affected: readonly Readonly<Record<string, unknown>>[]): QueryResultRow[] {
  if (items === undefined) return [];
  const stmt: SelectStmt = { kind: 'select', items, from: ref, groupBy: [], orderBy: [] };
  return affected.map((row) => {
    const { names, values } = projectScope(stmt, scopeOf(ex, [[bindingName(ref), bind(table, row)]]));
    return Object.fromEntries(names.map((name, i) => [name, wireForm(values[i])]));
  });
}

function result(command: string, rows: QueryResultRow[] = [], rowCount: number = rows.length): QueryResult {
  return { command, rowCount, oid: 0, rows, fields: [] };
}

function assignValues(ex: Exec, table: CatalogTable, before: Readonly<Record<string, unknown>>, set: readonly Assignment[], scope: Scope): Record<string, unknown> {
  const after: Record<string, unknown> = { ...before };
  for (const { column, e } of set) {
    const target = table.column.get(column);
    if (target === undefined) throw pgError('42703', `column "${column}" of relation "${table.name}" does not exist`);
    const value = evaluate(e, scope);
    after[column] = coerce(target, value === DEFAULT_VALUE ? null : value);
  }
  return after;
}

function proposedRows(ex: Exec, stmt: InsertStmt, table: CatalogTable): Record<string, unknown>[] {
  for (const column of stmt.columns) {
    if (!table.column.has(column)) throw pgError('42703', `column "${column}" of relation "${table.name}" does not exist`);
  }
  const tuples = stmt.values?.map((tuple) => tuple.map((e) => evaluate(e, emptyScope(ex)))) ?? [...runSelect(ex, stmt.source as SelectStmt).rows];
  return tuples.map((values) => {
    if (values.length !== stmt.columns.length) throw pgError('42601', 'INSERT has more target columns than expressions');
    return Object.fromEntries(stmt.columns.map((column, i) => [column, values[i]]));
  });
}

function runInsert(ex: Exec, stmt: InsertStmt): QueryResult {
  const table = ex.store.table(stmt.target.table);
  const affected: Readonly<Record<string, unknown>>[] = [];
  const { conflict } = stmt;
  for (const values of proposedRows(ex, stmt, table)) {
    const row = ex.store.completeRow(ex, table, values);
    const found = ex.store.conflicts(ex, table, row);
    if (found.length === 0) {
      ex.store.insert(ex, table, row);
      affected.push(row);
      continue;
    }
    const arbiter = conflict?.columns;
    const hit = found.find(({ columns }) => arbiter === undefined || (columns.length === arbiter.length && arbiter.every((column) => columns.includes(column))));
    if (conflict === undefined || hit === undefined) throw uniqueViolation(table, (found[0] as { columns: readonly string[] }).columns, row);
    if (conflict.action === 'nothing') continue;
    const scope = scopeOf(ex, [
      [bindingName(stmt.target), bind(table, hit.existing)],
      ['excluded', bind(table, row)],
    ]);
    if (conflict.where !== undefined && truth(evaluate(conflict.where, scope)) !== true) continue;
    const after = assignValues(ex, table, hit.existing, conflict.set, scope);
    ex.store.update(ex, table, hit.existing, after);
    affected.push(after);
  }
  return result('INSERT', returning(ex, table, stmt.target, stmt.returning, affected), affected.length);
}

function targetRows(ex: Exec, table: CatalogTable, ref: TableRef, where: Expr | undefined): Readonly<Record<string, unknown>>[] {
  return ex.store
    .visible(ex, table)
    .filter((row) => where === undefined || truth(evaluate(where, scopeOf(ex, [[bindingName(ref), bind(table, row)]]))) === true);
}

function runUpdate(ex: Exec, stmt: UpdateStmt): QueryResult {
  const table = ex.store.table(stmt.target.table);
  const affected = targetRows(ex, table, stmt.target, stmt.where).map((before) => {
    const after = assignValues(ex, table, before, stmt.set, scopeOf(ex, [[bindingName(stmt.target), bind(table, before)]]));
    ex.store.update(ex, table, before, after);
    return after;
  });
  return result('UPDATE', returning(ex, table, stmt.target, stmt.returning, affected), affected.length);
}

function runDelete(ex: Exec, stmt: DeleteStmt): QueryResult {
  const table = ex.store.table(stmt.target.table);
  const affected = targetRows(ex, table, stmt.target, stmt.where);
  for (const row of affected) ex.store.remove(ex, table, row);
  return result('DELETE', returning(ex, table, stmt.target, stmt.returning, affected), affected.length);
}

function execute(ex: Exec, stmt: DataStmt): QueryResult {
  switch (stmt.kind) {
    case 'select':
      return result('SELECT', wireRows(runSelect(ex, stmt)));
    case 'insert':
      return runInsert(ex, stmt);
    case 'update':
      return runUpdate(ex, stmt);
    case 'delete':
      return runDelete(ex, stmt);
  }
}

const IDENTIFIER = '([a-z_][a-z0-9_$]*)';
const BEGIN = /^(?:begin|start transaction)(?: work| transaction)?(?: isolation level read committed)?$/;
const COMMIT = /^(?:commit|end)(?: work| transaction)?$/;
const ROLLBACK_TO = new RegExp(`^rollback(?: work| transaction)? to (?:savepoint )?${IDENTIFIER}$`);
const ROLLBACK = /^(?:rollback|abort)(?: work| transaction)?$/;
const SAVEPOINT = new RegExp(`^savepoint ${IDENTIFIER}$`);
const RELEASE = new RegExp(`^release (?:savepoint )?${IDENTIFIER}$`);

/** Every data statement family the app and the platform issue against schema `timesheets`; a statement outside all of them fails fast. */
const DATA_PATTERNS: readonly { readonly name: string; readonly match: RegExp }[] = [
  { name: 'tenant-setting', match: /^select set_config\('app\.tenant_id', \$1, true\)$/ },
  { name: 'lock-timeout', match: /^select (?:set_config\('lock_timeout', \$1, true\)|current_setting\('lock_timeout'\) as value)$/ },
  { name: 'snapshot', match: /^select pg_snapshot_xm(?:in|ax)\(pg_current_snapshot\(\)\)::text as value$/ },
  { name: 'relation-probe', match: /^select to_regclass\(\$1\) is not null as \w+, to_regclass\(\$2\) is not null as \w+$/ },
  {
    name: 'outbox-drain',
    match: new RegExp(`^select \\(select count\\(\\*\\) from ${TIMESHEETS_SCHEMA}\\.outbox where [^()]+\\) as unpublished, \\(select count\\(\\*\\) from ${TIMESHEETS_SCHEMA}\\.outbox where held\\) as held$`),
  },
  ...TABLE_NAMES.map((table) => ({ name: table, match: new RegExp(`^(?:select|insert into|update|delete from) .*?\\b${TIMESHEETS_SCHEMA}\\.${table}\\b`) })),
];

function injectedFailure(): PgError {
  return pgError(RECORDING_FAILURE_CODE, 'Connection terminated: failure injected by the recording db');
}

function openTx(session: Session, statement: string): Tx {
  if (session.tx === undefined) throw pgError('25P01', `${statement} can only be used in transaction blocks`);
  return session.tx;
}

function abortedError(): PgError {
  return pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
}

function savepointMark(tx: Tx, name: string): number {
  const at = tx.savepoints.map((savepoint) => savepoint.name).lastIndexOf(name);
  if (at < 0) throw pgError('3B001', `savepoint "${name}" does not exist`);
  return at;
}

/** Runs one transaction-control statement, or returns undefined for any other statement. */
function transactionControl(store: RecordingStore, session: Session, normalized: string): QueryResult | undefined {
  if (BEGIN.test(normalized)) {
    // BEGIN inside a transaction block only warns.
    session.tx ??= store.begin();
    return result('BEGIN');
  }
  if (COMMIT.test(normalized)) {
    const { tx } = session;
    if (tx === undefined) return result('COMMIT');
    session.tx = undefined;
    // COMMIT of a failed transaction rolls it back and reports ROLLBACK.
    store.finish(tx, !tx.aborted);
    return result(tx.aborted ? 'ROLLBACK' : 'COMMIT');
  }
  const rollbackTo = ROLLBACK_TO.exec(normalized);
  if (rollbackTo !== null) {
    const tx = openTx(session, 'ROLLBACK TO SAVEPOINT');
    const at = savepointMark(tx, rollbackTo[1] ?? '');
    tx.restore((tx.savepoints[at] as { mark: TxMark }).mark);
    tx.savepoints.length = at + 1;
    tx.aborted = false;
    return result('ROLLBACK');
  }
  if (ROLLBACK.test(normalized)) {
    store.abandon(session);
    return result('ROLLBACK');
  }
  const savepoint = SAVEPOINT.exec(normalized);
  if (savepoint !== null) {
    const tx = openTx(session, 'SAVEPOINT');
    if (tx.aborted) throw abortedError();
    tx.savepoints.push({ name: savepoint[1] ?? '', mark: tx.mark() });
    return result('SAVEPOINT');
  }
  const release = RELEASE.exec(normalized);
  if (release !== null) {
    const tx = openTx(session, 'RELEASE SAVEPOINT');
    if (tx.aborted) throw abortedError();
    tx.savepoints.length = savepointMark(tx, release[1] ?? '');
    return result('RELEASE');
  }
  return undefined;
}

/** Runs `text` on `session` as PostgreSQL would, after logging it and firing any matching injected failure. */
function runStatement(store: RecordingStore, session: Session, text: string, params: readonly unknown[]): QueryResult {
  const normalized = normalizeSql(text);
  const tenant = session.tx?.settings.get(TENANT_SETTING) ?? '';
  store.queryLog.push({ text, values: [...params], tenantId: tenant === '' ? null : tenant.toLowerCase() });
  const failure = store.failures.findIndex((candidate) => candidate.matches(text, normalized, params));
  if (failure >= 0) {
    const [{ error }] = store.failures.splice(failure, 1) as [Failure];
    if (session.tx !== undefined && !COMMIT.test(normalized) && !ROLLBACK.test(normalized)) session.tx.aborted = true;
    throw error;
  }
  const control = transactionControl(store, session, normalized);
  if (control !== undefined) return control;
  if (session.tx?.aborted === true) throw abortedError();
  if (!DATA_PATTERNS.some(({ match }) => match.test(normalized))) {
    throw new UnsupportedSqlError(`no statement family of the recording db matches: ${text}`);
  }
  const own = session.tx === undefined;
  const tx = session.tx ?? store.begin();
  const mark = tx.mark();
  try {
    const out = execute({ store, session, tx, params }, parseStatement(text));
    if (own) store.finish(tx, true);
    return out;
  } catch (err) {
    tx.restore(mark);
    if (own) store.finish(tx, false);
    else tx.aborted = true;
    throw err instanceof UnsupportedSqlError ? new UnsupportedSqlError(`the recording db cannot run ${err.message}: ${text}`) : err;
  }
}

/** The part of a pg client the transaction runner uses. */
interface FakeConnection {
  query(input: string | QueryConfig, values?: unknown[]): Promise<QueryResult>;
  release(err?: Error | boolean): void;
}

/** The part of a pg pool `tenantDbFromPool` uses; connections wait for `ready`, and released sessions are reused with their session settings. */
class FakePool {
  private ended = false;
  private readonly idle: Session[] = [];

  constructor(
    private readonly store: RecordingStore,
    private readonly ready: Promise<void>,
  ) {}

  async connect(): Promise<FakeConnection> {
    await this.ready;
    if (this.ended) throw new Error('Cannot use a pool after calling end on the pool');
    const session: Session = this.idle.pop() ?? { tx: undefined, settings: new Map() };
    let held = true;
    return {
      query: async (input, values) => {
        if (!held) throw new Error('Client was released to the pool');
        const text = typeof input === 'string' ? input : input.text;
        const params = values ?? (typeof input === 'string' ? undefined : (input.values as unknown[] | undefined)) ?? [];
        return runStatement(this.store, session, text, params);
      },
      release: (err) => {
        if (!held) throw new Error('Release called on client which has already been released to the pool.');
        held = false;
        this.store.abandon(session);
        // An errored release destroys the connection instead of pooling it.
        if (err === undefined || err === false) this.idle.push(session);
      },
    };
  }

  async query(input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    const client = await this.connect();
    try {
      return await client.query(input, values);
    } finally {
      client.release();
    }
  }

  end(): Promise<void> {
    if (this.ended) return Promise.reject(new Error('Called end on pool more than once'));
    this.ended = true;
    this.idle.length = 0;
    return Promise.resolve();
  }

  /** Accepts pg's pool listeners; fake connections never fail while idle. */
  on(): this {
    return this;
  }
}

/** Options of {@link createRecordingDb}; `clock` gives LOCALTIMESTAMP and the default rows' times. */
export interface RecordingDbOptions {
  clock?: Clock;
}

/** In-memory schema `timesheets` behind the platform transaction runner, with forced RLS, constraints, transactions and xids as pg has them. */
export interface RecordingDb extends TenantDb {
  /** Committed writes in commit order, changelog rows included. */
  readonly writes: readonly RecordedWrite[];
  /** Every statement run since creation or the last `clear()`, in order. */
  readonly queries: readonly RecordedQuery[];
  /** Decimal xid of the last committed transaction that wrote, as `X-Opt2-Write-Position` carries it. */
  readonly lastXid: string | undefined;
  /** Settles once the fixture registry is seeded; every connection waits for it. */
  readonly ready: Promise<void>;
  /** Committed rows of `table`, optionally of one tenant only. */
  rowsOf<T extends TableName>(table: T, tenantId?: string): RecordingRowTypes[T][];
  /** Appends committed rows, completing omitted columns from their defaults; neither logged nor audited. */
  seed(rows: SeedRows): void;
  /** Empties `writes` and `queries`; rows and gates stay. */
  clear(): void;
  /** Sets the committed gate of `unit`; a closed gate is held by {@link TEST_GATE_HOLDER}, and a write meeting it waits the platform's real 30 s gate budget. */
  setGate(unit: TimesheetsUnit, state: GateState, phase?: GatePhase): void;
  /** The next statement matching `matcher` throws `error`, by default a SQLSTATE 08006 connection failure; one-shot. */
  failNext(matcher: StatementMatcher, error?: Error): void;
}

const recordingDbs = new WeakSet<TenantDb>();

function applySeed(store: RecordingStore, rows: SeedRows): void {
  for (const [table, list] of Object.entries(rows) as [string, readonly Readonly<Record<string, unknown>>[] | undefined][]) {
    if (list !== undefined) store.seedRows(table, list);
  }
}

/**
 * Creates a {@link RecordingDb}; nothing connects to PostgreSQL. Every unit gate starts `open` and `quiet`, and the fixture sites are
 * registered through the platform's own registry upsert; a `seed` naming `unit_gate` or `tenant_registry` rows replaces those defaults.
 */
export function createRecordingDb(seed: SeedRows = {}, options: RecordingDbOptions = {}): RecordingDb {
  const store = new RecordingStore(catalogue(), options.clock ?? TEST_CLOCK);
  const now = store.clock.now();
  const seededGates = new Set((seed.unit_gate ?? []).map((row) => row.unit));
  store.seedRows(
    UNIT_GATE_TABLE,
    TIMESHEETS_UNITS.filter((unit) => !seededGates.has(unit)).map((unit) => ({ unit, state: 'open', holder_id: null, phase: 'quiet', updated_at: now })),
  );
  applySeed(store, seed);
  const seeding = tenantDbFromPool(new FakePool(store, Promise.resolve()) as unknown as Pool, { schema: TIMESHEETS_SCHEMA });
  const ready =
    seed.tenant_registry !== undefined
      ? Promise.resolve()
      : seedRegistry(seeding, TIMESHEETS_SCHEMA).then(() => {
          store.writeLog.length = 0;
          store.queryLog.length = 0;
        });
  // Connections rethrow a seeding failure; this branch only keeps it from surfacing as an unhandled rejection.
  ready.catch(() => undefined);
  const base = tenantDbFromPool(new FakePool(store, ready) as unknown as Pool, { schema: TIMESHEETS_SCHEMA });
  const db: RecordingDb = {
    schema: base.schema,
    withTenant: (tenantId, fn, opts) => base.withTenant(tenantId, fn, opts),
    withMetadata: (fn, opts) => base.withMetadata(fn, opts),
    end: () => base.end(),
    get writes() {
      return [...store.writeLog];
    },
    get queries() {
      return [...store.queryLog];
    },
    get lastXid() {
      return store.lastXid?.toString();
    },
    ready,
    rowsOf: <T extends TableName>(table: T, tenantId?: string) => store.committedRows(table, tenantId) as RecordingRowTypes[T][],
    seed(rows) {
      applySeed(store, rows);
    },
    clear() {
      store.writeLog.length = 0;
      store.queryLog.length = 0;
    },
    setGate(unit, state, phase = 'quiet') {
      store.setGate(unit, state, phase);
    },
    failNext(matcher, error) {
      store.failures.push({ matches: failureMatcher(matcher), error: error ?? injectedFailure() });
    },
  };
  recordingDbs.add(db);
  return Object.freeze(db);
}

function isRecordingDb(db: TenantDb): db is RecordingDb {
  return recordingDbs.has(db);
}

/** CSRF token and expiry headers a day action sends; the identity double answers every token with its current verdict. */
export const CSRF_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [CSRF_HEADER_TOKEN]: 'OPT2TIMESHEETSTESTCSRFTOKEN',
  [CSRF_HEADER_EXPIRES]: '991231235959000',
});

/** Identity's CSRF consume route as the app's service client reaches it. */
export interface CsrfDouble {
  /** Consume requests identity received, in order. */
  readonly calls: readonly CsrfConsumeRequest[];
  /** Sets the `valid` verdict identity answers; initially true. */
  answer(valid: boolean): void;
}

/** Reporting's answer to an export source-scope lookup: a status and body, or an error the service client throws. */
export type ReportingScopeAnswer = { status: number; body?: unknown } | Error;

/** Reporting's export source-scope route as the app's service client reaches it. */
export interface ReportingDouble {
  /** Scope lookups reporting received, in order. */
  readonly lookups: readonly ServiceRequest[];
  /** Sets how reporting answers each later lookup; initially its notFound, as for a job it does not store. */
  answer(next: ReportingScopeAnswer | ((req: ServiceRequest) => ReportingScopeAnswer)): void;
}

const REPORTING_SERVICE = 'reporting';
const REPORTING_SCOPE_PATH = /^\/internal\/v1\/exports\/[^/]+\/source-scope$/;
const REPORTING_NOT_FOUND: ReportingScopeAnswer = { status: 404, body: { error: { code: 'invalid_request', message: 'Not Found' } } };

/**
 * Replaces `request` on the app's service client, which the CSRF hook and the export read use at request time, with identity's CSRF
 * consume and reporting's scope lookup; any other service call rejects.
 */
function installServiceDoubles(app: FastifyInstance): { csrf: CsrfDouble; reporting: ReportingDouble } {
  const calls: CsrfConsumeRequest[] = [];
  const lookups: ServiceRequest[] = [];
  let valid = true;
  let scope: ReportingScopeAnswer | ((req: ServiceRequest) => ReportingScopeAnswer) = REPORTING_NOT_FOUND;
  function request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (req.service === IDENTITY_SERVICE && req.method === 'POST' && req.path === CSRF_CONSUME_PATH) {
      calls.push(req.json as CsrfConsumeRequest);
      return Promise.resolve({ status: 200, headers: {}, body: { valid } as T });
    }
    if (req.service === REPORTING_SERVICE && req.method === 'GET' && REPORTING_SCOPE_PATH.test(req.path)) {
      lookups.push(req);
      const answer = typeof scope === 'function' ? scope(req) : scope;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ status: answer.status, headers: { 'content-type': 'application/json' }, body: answer.body as T });
    }
    return Promise.reject(new Error(`timesheets test app made an unexpected service call: ${req.service} ${req.method} ${req.path}`));
  }
  Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  return {
    csrf: {
      calls,
      answer(next) {
        valid = next;
      },
    },
    reporting: {
      lookups,
      answer(next) {
        scope = next;
      },
    },
  };
}

/** Options of {@link buildTestApp}; it creates each dependency it is not given. */
export interface TestAppOptions<D extends TenantDb = RecordingDb, P extends EventPublisher = CapturingPublisher> {
  /** Overrides of {@link testEnv}. */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  /** Defaults to a fresh recording db on the same clock. */
  db?: D;
  publisher?: P;
}

/** A timesheets app under test with the fakes it runs on; closing the app removes a state directory testEnv created for it. */
export interface TestApp<D extends TenantDb = RecordingDb, P extends EventPublisher = CapturingPublisher> {
  readonly app: FastifyInstance;
  readonly db: D;
  readonly publisher: P;
  readonly clock: Clock;
  readonly stateDir: string;
  readonly csrf: CsrfDouble;
  readonly reporting: ReportingDouble;
}

/**
 * Builds the timesheets app for `app.inject`, ready but never listening; without PostgreSQL, the Pub/Sub emulator or the network
 * unless the caller's `db` needs them. A recording db's logs are cleared after start-up, so they hold only the suite's own statements.
 */
export async function buildTestApp<D extends TenantDb = RecordingDb, P extends EventPublisher = CapturingPublisher>(
  opts: TestAppOptions<D, P> = {},
): Promise<TestApp<D, P>> {
  const env = await testEnv(opts.env);
  const stateDir = env.OPT2_STATE_DIR;
  const ownStateDir = opts.env === undefined || !('OPT2_STATE_DIR' in opts.env);
  const clock = opts.clock ?? TEST_CLOCK;
  let app: FastifyInstance | undefined;
  try {
    const publisher = opts.publisher ?? (createCapturingPublisher() as unknown as P);
    const db: TenantDb = opts.db ?? createRecordingDb({}, { clock });
    app = await buildApp({ env, clock, verifierOverride: testVerifier(), db, publisher });
    const { csrf, reporting } = installServiceDoubles(app);
    if (ownStateDir) {
      app.addHook('onClose', (_instance, done) => {
        removeStateDir(stateDir);
        done();
      });
    }
    await app.ready();
    if (isRecordingDb(db)) db.clear();
    return { app, db: db as D, publisher, clock, stateDir, csrf, reporting };
  } catch (err) {
    await app?.close().catch(() => undefined);
    if (ownStateDir) removeStateDir(stateDir);
    throw err;
  }
}

/** Options of {@link createTimesheetsSchema}. */
export interface TimesheetsSchemaOptions {
  /** SQL applied after the migrations, rewritten to the throwaway schema like them. */
  extraSql?: readonly string[];
  /** Seeds the fixture sites into `tenant_registry`; defaults to true. */
  registry?: boolean;
  /** `open` (default) opens every unit gate as the recording db starts them; `legacy` leaves them as `ensureUnitGates` creates them. */
  gates?: 'open' | 'legacy';
}

/** A throwaway PostgreSQL schema migrated with `db/migrations`, its registry and unit gates prepared; callers `drop()` it. */
export async function createTimesheetsSchema(opts: TimesheetsSchemaOptions = {}): Promise<ThrowawaySchema> {
  const handle = await createThrowawaySchema({
    service: SERVICE_NAME,
    migrationsDir: fileURLToPath(MIGRATIONS_DIR),
    ...(opts.extraSql === undefined ? {} : { extraSql: opts.extraSql }),
  });
  try {
    if (opts.registry ?? true) await seedRegistry(handle.app, handle.schema);
    await ensureUnitGates(handle.app, TIMESHEETS_UNITS);
    if ((opts.gates ?? 'open') === 'open') {
      // A legacy gate opens only through a holder's compare-and-set: close it (allowLegacy), then reopen it as open.
      await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: TEST_GATE_HOLDER, allowLegacy: true });
      await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: TEST_GATE_HOLDER, state: 'open' });
    }
  } catch (err) {
    await handle.drop();
    throw err;
  }
  return handle;
}

/** A subject {@link headersFor} accepts: a platform RoleSubject, the name of one in ROLE_SET, or a user's roles with optional site and `sub`. */
export type HeadersSubject = RoleSubject | string | { readonly roles: readonly string[]; readonly site?: string; readonly sub?: string };

/** Options of {@link headersFor}; `csrf` (true by default) adds {@link CSRF_HEADERS} for user subjects. */
export interface HeadersOptions {
  site?: string;
  sub?: string;
  csrf?: boolean;
}

function roleSubject(subject: RoleSubject | string): RoleSubject {
  if (typeof subject !== 'string') return subject;
  const found = ROLE_SET.find((candidate) => candidate.name === subject);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject ${subject}`);
  return found;
}

/**
 * Headers presenting `subject` to the timesheets app: its user token in `Authorization` and the gateway's invocation credential in
 * `X-Serverless-Authorization`, or a service's credential alone. A roles-only subject is a user of `tenant-a` with a fresh CF UUID `sub`.
 */
export async function headersFor(subject: HeadersSubject, opts: HeadersOptions = {}): Promise<Record<string, string>> {
  const custom = typeof subject !== 'string' && !('kind' in subject) ? subject : undefined;
  const resolved: RoleSubject = custom === undefined ? roleSubject(subject as RoleSubject | string) : { name: 'timesheets-test-user', kind: 'user', roles: custom.roles };
  const site = custom?.site ?? opts.site ?? TENANT_A.siteId;
  const sub = custom?.sub ?? opts.sub ?? (custom === undefined ? undefined : cfUuid());
  const headers = await authHeadersFor(resolved, sub === undefined ? { site, audience: SERVICE_NAME } : { site, audience: SERVICE_NAME, sub });
  return resolved.kind === 'user' && (opts.csrf ?? true) ? { ...headers, ...CSRF_HEADERS } : headers;
}

/** The invocation credential alone of service `caller` (by default with its own service roles), as `/internal/v1/*` routes take it. */
export async function serviceHeaders(caller: string, roles?: readonly string[]): Promise<Record<string, string>> {
  const token = await mintServiceToken(roles === undefined ? { caller, audience: SERVICE_NAME } : { caller, audience: SERVICE_NAME, roles: [...roles] });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

/** Query string (without `?`) carrying the local push key that `/internal/v1/events/<subscription>` push routes require. */
export function pushQuery(): string {
  return pushKeyQuery();
}
