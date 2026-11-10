/** The one canonical row encoding shared by every legacy and target row comparison. */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** Value tag: `s` text, `i` integer, `f` float, `d` fixed decimal, `t` timestamp, `b` binary. */
export type CanonicalType = 's' | 'i' | 'f' | 'd' | 't' | 'b';

/** One column of a canonical row; `scale` is required for `d`. */
export interface CanonicalColumn {
  name: string;
  type: CanonicalType;
  scale?: number;
}

/** Decoded column value: `Buffer` for `b`, the canonical value text for every other tag. */
export type CanonicalValue = string | Buffer | null;

/** Canonical type and scale resolved from a catalog type name. */
export type CanonicalTypeInfo = Pick<CanonicalColumn, 'type' | 'scale'>;

/** Options for encoding or decoding one value. */
export interface CanonicalValueOptions {
  scale?: number | undefined;
  column?: string | undefined;
}

/** Wall-clock date and time components (month 1-12). */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock components with a fractional second in [0, 1). */
export interface WallClockFraction extends WallClock {
  fractionSeconds: number;
}

/** Wall-clock components rounded to SQL Server `datetime` precision. */
export interface SqlServerDatetime extends WallClock {
  ms: number;
}

/** Raised when a value, column definition or encoding does not fit its canonical form. */
export class CanonicalEncodingError extends Error {
  readonly column?: string;
  readonly type?: CanonicalType;

  constructor(message: string, details: { column?: string | undefined; type?: CanonicalType | undefined; cause?: unknown } = {}) {
    super(details.column === undefined ? message : `${message} (column ${details.column})`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'CanonicalEncodingError';
    if (details.column !== undefined) this.column = details.column;
    if (details.type !== undefined) this.type = details.type;
  }
}

const TAGS: ReadonlySet<string> = new Set<CanonicalType>(['s', 'i', 'f', 'd', 't', 'b']);
const MAX_SCALE = 16_383; // PostgreSQL's numeric scale limit
const MAX_DECIMAL_EXPONENT = 1_000_000; // bounds the zeros an exponent string can expand to
const COMPARE_SCAN_UNITS = 1024;
const INTEGER_TEXT = /^[+-]?\d+$/;
const FLOAT_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DECIMAL_TEXT = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const TIMESTAMP_TEXT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;
const BYTEA_TEXT = /^\\x(?:[0-9a-fA-F]{2})*$/;
const LOWER_HEX = /^(?:[0-9a-f]{2})*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function fail(message: string, type: CanonicalType | undefined, opts: CanonicalValueOptions): never {
  throw new CanonicalEncodingError(message, { column: opts.column, type });
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return 'Date';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Validates the tag (and the scale of `d`) independently of any value, returning the scale. */
function checkColumnType(type: CanonicalType, opts: CanonicalValueOptions): number {
  if (!TAGS.has(type)) fail(`unknown canonical type '${type}'`, undefined, opts);
  if (type !== 'd') return 0;
  const scale = opts.scale;
  if (scale === undefined || !Number.isSafeInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    fail(`d requires an integer scale between 0 and ${String(MAX_SCALE)}`, 'd', opts);
  }
  return scale;
}

function textValue(value: unknown, opts: CanonicalValueOptions): string {
  if (typeof value !== 'string') fail(`s expects a string, got ${describe(value)}`, 's', opts);
  // An unpaired surrogate has no UTF-8 form; encoding it would silently collapse distinct values to U+FFFD.
  if (LONE_SURROGATE.test(value)) fail('s value contains an unpaired UTF-16 surrogate', 's', opts);
  return value;
}

function integerValue(value: unknown, opts: CanonicalValueOptions): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('i expects a safe integer number', 'i', opts);
    return BigInt(value).toString();
  }
  if (typeof value === 'string' && INTEGER_TEXT.test(value)) return BigInt(value).toString();
  return fail(`i expects an integer, bigint, boolean or decimal-integer string, got ${describe(value)}`, 'i', opts);
}

function floatValue(value: unknown, opts: CanonicalValueOptions): string {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && FLOAT_TEXT.test(value)) n = Number(value);
  else return fail(`f expects a finite number or numeric string, got ${describe(value)}`, 'f', opts);
  if (!Number.isFinite(n)) fail('f value must be finite', 'f', opts);
  return String(n);
}

function incrementDigits(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits.charCodeAt(i) === 57) i--;
  const tail = '0'.repeat(digits.length - 1 - i);
  return i < 0 ? `1${tail}` : `${digits.slice(0, i)}${String.fromCharCode(digits.charCodeAt(i) + 1)}${tail}`;
}

function fixedDecimal(negative: boolean, integer: string, fraction: string, scale: number): string {
  let whole = integer;
  let kept = fraction.length >= scale ? fraction.slice(0, scale) : fraction + '0'.repeat(scale - fraction.length);
  if (fraction.length > scale && fraction.charCodeAt(scale) >= 53) {
    const bumped = incrementDigits(whole + kept);
    whole = bumped.slice(0, bumped.length - scale);
    kept = bumped.slice(bumped.length - scale);
  }
  whole = whole.replace(/^0+/, '') || '0';
  const body = scale === 0 ? whole : `${whole}.${kept}`;
  const zero = whole === '0' && !/[1-9]/.test(kept);
  return negative && !zero ? `-${body}` : body;
}

function decimalValue(value: unknown, scale: number, opts: CanonicalValueOptions): string {
  if (typeof value === 'bigint') return fixedDecimal(value < 0n, (value < 0n ? -value : value).toString(), '', scale);
  let text: string;
  if (typeof value === 'string') text = value;
  // A number goes through its shortest round-trip text, so 1.005 and '1.005' encode alike, as PostgreSQL rounds a numeric parameter.
  else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e21) text = String(value);
  else return fail(`d expects a decimal string, bigint or finite number below 1e21, got ${describe(value)}`, 'd', opts);
  const m = DECIMAL_TEXT.exec(text);
  if (m === null) return fail('d value is not a decimal number', 'd', opts);
  const integer = m[2] ?? '';
  const fraction = m[3] ?? m[4] ?? '';
  const exponent = m[5] === undefined ? 0 : Number(m[5]);
  if (Math.abs(exponent) > MAX_DECIMAL_EXPONENT) fail('d exponent out of range', 'd', opts);
  if (exponent === 0) return fixedDecimal(m[1] === '-', integer, fraction, scale);
  const digits = integer + fraction;
  const point = integer.length + exponent;
  if (point <= 0) return fixedDecimal(m[1] === '-', '', '0'.repeat(-point) + digits, scale);
  if (point >= digits.length) return fixedDecimal(m[1] === '-', digits + '0'.repeat(point - digits.length), '', scale);
  return fixedDecimal(m[1] === '-', digits.slice(0, point), digits.slice(point), scale);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

function validateWallClock(parts: WallClock, opts: CanonicalValueOptions): void {
  const { year, month, day, hour, minute, second } = parts;
  const integers = [year, month, day, hour, minute, second].every((n) => Number.isSafeInteger(n));
  if (!integers || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    fail('t value is not a valid date and time between years 1 and 9999', 't', opts);
  }
}

/** Applies `ticks` (1/300 s units, 0-300) to whole-second components, carrying 300 into the next second. */
function applyTicks(parts: WallClock, ticks: number, opts: CanonicalValueOptions): SqlServerDatetime {
  let { year, month, day, hour, minute, second } = parts;
  if (ticks < 300) return { year, month, day, hour, minute, second, ms: Math.round((ticks * 10) / 3) };
  // Calendar carry on plain components so no time-zone or DST rule can shift the wall-clock value.
  if (++second === 60) {
    second = 0;
    if (++minute === 60) {
      minute = 0;
      if (++hour === 24) {
        hour = 0;
        if (++day > daysInMonth(year, month)) {
          day = 1;
          if (++month === 13) {
            month = 1;
            year += 1;
          }
        }
      }
    }
  }
  if (year > 9999) fail('t value rounds past year 9999', 't', opts);
  return { year, month, day, hour, minute, second, ms: 0 };
}

/** Rounds a fractional second to SQL Server `datetime` ticks of 1/300 s, half up. */
export function roundToSqlServerDatetime(parts: WallClockFraction): SqlServerDatetime {
  const opts: CanonicalValueOptions = {};
  validateWallClock(parts, opts);
  const fraction = parts.fractionSeconds;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) fail('fractionSeconds must be in [0, 1)', 't', opts);
  const nanos = Math.round(fraction * 1e9);
  return applyTicks(parts, Math.floor((nanos * 600 + 1e9) / 2e9), opts);
}

function fractionTicks(digits: string): number {
  if (digits === '') return 0;
  const den = 10n ** BigInt(digits.length);
  return Number((BigInt(digits) * 600n + den) / (2n * den));
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function timestampValue(value: unknown, opts: CanonicalValueOptions): string {
  let rounded: SqlServerDatetime;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail('t value is an invalid Date', 't', opts);
    const parts: WallClock = {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
      hour: value.getHours(),
      minute: value.getMinutes(),
      second: value.getSeconds(),
    };
    validateWallClock(parts, opts);
    rounded = applyTicks(parts, Math.floor((3 * value.getMilliseconds() + 5) / 10), opts);
  } else if (typeof value === 'string') {
    const m = TIMESTAMP_TEXT.exec(value);
    if (m === null) return fail('t expects YYYY-MM-DD[ T]HH:MM[:SS[.fraction]] without a zone', 't', opts);
    const parts: WallClock = {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] ?? '0'),
    };
    validateWallClock(parts, opts);
    rounded = applyTicks(parts, fractionTicks(m[7] ?? ''), opts);
  } else {
    return fail(`t expects a Date or wall-clock string, got ${describe(value)}`, 't', opts);
  }
  const { year, month, day, hour, minute, second, ms } = rounded;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(ms, 3)}`;
}

/** Returns the canonical `t` value text, `YYYY-MM-DDTHH:MM:SS.mmm`, for a local Date or wall-clock string. */
export function formatCanonicalTimestamp(value: Date | string): string {
  return timestampValue(value, {});
}

function binaryValue(value: unknown, opts: CanonicalValueOptions): string {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex');
  if (typeof value === 'string' && BYTEA_TEXT.test(value)) return value.slice(2).toLowerCase();
  return fail(`b expects a Buffer, Uint8Array or \\x-prefixed hex string, got ${describe(value)}`, 'b', opts);
}

function valueText(type: CanonicalType, value: unknown, scale: number, opts: CanonicalValueOptions): string {
  switch (type) {
    case 's':
      return textValue(value, opts);
    case 'i':
      return integerValue(value, opts);
    case 'f':
      return floatValue(value, opts);
    case 'd':
      return decimalValue(value, scale, opts);
    case 't':
      return timestampValue(value, opts);
    case 'b':
      return binaryValue(value, opts);
  }
}

/** Encoded column as a head (`N`, or tag, byte length and `:`) and the value text, kept apart for incremental hashing. */
function segments(type: CanonicalType, value: unknown, opts: CanonicalValueOptions): [head: string, text: string] {
  const scale = checkColumnType(type, opts);
  if (value === null || value === undefined) return ['N', ''];
  const text = valueText(type, value, scale, opts);
  return [`${type}${String(type === 's' ? Buffer.byteLength(text, 'utf8') : text.length)}:`, text];
}

function columnSegments(column: CanonicalColumn, row: Readonly<Record<string, unknown>>): [head: string, text: string] {
  if (!(column.name in row)) {
    throw new CanonicalEncodingError('row has no value for column', { column: column.name, type: column.type });
  }
  return segments(column.type, row[column.name], { scale: column.scale, column: column.name });
}

/** Encodes one value: `N` for null or undefined, otherwise `<tag><UTF-8 byte length>:<value text>`. */
export function encodeValue(type: CanonicalType, value: unknown, opts: CanonicalValueOptions = {}): string {
  const [head, text] = segments(type, value, opts);
  return head + text;
}

/** Encodes a row as the concatenation of its column encodings in the given (catalog) order. */
export function encodeRow(columns: readonly CanonicalColumn[], row: Readonly<Record<string, unknown>>): string {
  const parts = new Array<string>(columns.length * 2);
  let i = 0;
  for (const column of columns) {
    const [head, text] = columnSegments(column, row);
    parts[i++] = head;
    parts[i++] = text;
  }
  return parts.join('');
}

/** Encodes the key columns of a row in `keyNames` order. */
export function encodeKey(columns: readonly CanonicalColumn[], keyNames: readonly string[], row: Readonly<Record<string, unknown>>): string {
  if (keyNames.length === 0) throw new CanonicalEncodingError('encodeKey needs at least one key column');
  const keyColumns = keyNames.map((name) => {
    const column = columns.find((c) => c.name === name);
    if (column === undefined) throw new CanonicalEncodingError('key column is not among the row columns', { column: name });
    return column;
  });
  return encodeRow(keyColumns, row);
}

interface Decoded {
  value: CanonicalValue;
  next: number;
}

/** Reads one encoded value at `pos`, rejecting tag mismatches, truncation and non-canonical value text. */
function readValue(bytes: Buffer, pos: number, type: CanonicalType, opts: CanonicalValueOptions): Decoded {
  const scale = checkColumnType(type, opts);
  if (pos >= bytes.length) fail('encoding ends before this column', type, opts);
  const tag = bytes[pos];
  if (tag === 0x4e) return { value: null, next: pos + 1 };
  if (tag !== type.charCodeAt(0)) fail(`expected tag '${type}' or 'N', found byte ${String(tag)}`, type, opts);
  let cursor = pos + 1;
  while (cursor < bytes.length && (bytes[cursor] ?? 0) >= 0x30 && (bytes[cursor] ?? 0) <= 0x39) cursor++;
  const lengthDigits = cursor - pos - 1;
  if (lengthDigits === 0 || lengthDigits > 15 || (lengthDigits > 1 && bytes[pos + 1] === 0x30) || bytes[cursor] !== 0x3a) {
    fail('malformed length prefix', type, opts);
  }
  const start = cursor + 1;
  const end = start + Number(bytes.toString('latin1', pos + 1, cursor));
  if (end > bytes.length) fail('value is truncated', type, opts);
  if (type === 's') {
    if (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) fail('length splits a UTF-8 character', type, opts);
    return { value: bytes.toString('utf8', start, end), next: end };
  }
  const text = bytes.toString('latin1', start, end);
  if (type === 'b') {
    if (!LOWER_HEX.test(text)) fail('b value is not lowercase hex', type, opts);
    return { value: Buffer.from(text, 'hex'), next: end };
  }
  if (valueText(type, text, scale, opts) !== text) fail('value text is not in canonical form', type, opts);
  return { value: text, next: end };
}

function encodingBytes(encoding: string, opts: CanonicalValueOptions): Buffer {
  if (LONE_SURROGATE.test(encoding)) fail('encoding contains an unpaired UTF-16 surrogate', undefined, opts);
  return Buffer.from(encoding, 'utf8');
}

/** Decodes one encoded value; `d` without `opts.scale` takes the scale from the value text. */
export function decodeValue(type: CanonicalType, text: string, opts: CanonicalValueOptions = {}): CanonicalValue {
  const bytes = encodingBytes(text, opts);
  let resolved = opts;
  if (type === 'd' && opts.scale === undefined) {
    const point = text.indexOf('.');
    resolved = { ...opts, scale: point < 0 ? 0 : text.length - point - 1 };
  }
  const { value, next } = readValue(bytes, 0, type, resolved);
  if (next !== bytes.length) fail('trailing bytes after the value', type, opts);
  return value;
}

/** Decodes a row encoding over `columns`; `encodeRow(columns, decodeRow(columns, e)) === e` for every accepted `e`. */
export function decodeRow(columns: readonly CanonicalColumn[], encoding: string): Record<string, CanonicalValue> {
  const bytes = encodingBytes(encoding, {});
  const entries = new Array<[string, CanonicalValue]>(columns.length);
  let pos = 0;
  let i = 0;
  for (const column of columns) {
    const { value, next } = readValue(bytes, pos, column.type, { scale: column.scale, column: column.name });
    entries[i++] = [column.name, value];
    pos = next;
  }
  if (pos !== bytes.length) fail('trailing bytes after the last column', undefined, {});
  return Object.fromEntries(entries);
}

/** Lowercase hex SHA-256 of a string (as UTF-8) or of bytes. */
export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** SHA-256 hex of `encodeRow(columns, row)`, hashed column by column without building the encoding. */
export function rowChecksum(columns: readonly CanonicalColumn[], row: Readonly<Record<string, unknown>>): string {
  const hash = createHash('sha256');
  for (const column of columns) {
    const [head, text] = columnSegments(column, row);
    hash.update(head, 'utf8');
    if (text !== '') hash.update(text, 'utf8');
  }
  return hash.digest('hex');
}

/** The `legacy_row_hash` of a keyless-table row: the row checksum over its legacy columns. */
export function legacyRowHash(columns: readonly CanonicalColumn[], row: Readonly<Record<string, unknown>>): string {
  return rowChecksum(columns, row);
}

/** Names of the columns, in column order, whose encoded values differ between `before` and `after`. */
export function changedColumns(
  columns: readonly CanonicalColumn[],
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): string[] {
  const changed: string[] = [];
  for (const column of columns) {
    const [headBefore, textBefore] = columnSegments(column, before);
    const [headAfter, textAfter] = columnSegments(column, after);
    if (headBefore !== headAfter || textBefore !== textAfter) changed.push(column.name);
  }
  return changed;
}


/** Orders two encodings by their UTF-8 bytes, independent of any database collation. */
export function compareEncodings(a: string, b: string): number {
  if (a === b) return 0;
  const shared = Math.min(a.length, b.length);
  const scanned = Math.min(shared, COMPARE_SCAN_UNITS);
  for (let i = 0; i < scanned; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    // Outside the surrogate range UTF-16 unit order equals UTF-8 byte order; surrogates need the bytes themselves.
    if ((x & 0xf800) === 0xd800 || (y & 0xf800) === 0xd800) return compareBytes(a, b);
    return x < y ? -1 : 1;
  }
  // A proper prefix sorts first in both orders; a longer shared prefix is compared natively.
  if (scanned < shared) return compareBytes(a, b);
  return a.length < b.length ? -1 : 1;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** One row of a table checksum: `key` for keyed tables, absent for keyless (multiset) tables. */
export interface ChecksumEntry {
  readonly key?: string | undefined;
  readonly row: string;
}

/** Row count and SHA-256 over the row encodings sorted by key (keyed tables) or by row (keyless tables). */
export function tableChecksum(entries: Iterable<ChecksumEntry>): { count: number; sha256: string } {
  const list = Array.from(entries);
  const keyed = list.length > 0 && list[0]?.key !== undefined;
  if (list.some((entry) => (entry.key !== undefined) !== keyed)) {
    throw new CanonicalEncodingError('tableChecksum entries must all have a key or all lack one');
  }
  list.sort(keyed
    ? (x, y) => compareEncodings(x.key ?? '', y.key ?? '') || compareEncodings(x.row, y.row)
    : (x, y) => compareEncodings(x.row, y.row));
  const hash = createHash('sha256');
  for (const entry of list) hash.update(entry.row, 'utf8');
  return { count: list.length, sha256: hash.digest('hex') };
}

/** A distinct encoding of a multiset with its number of occurrences. */
export interface MultisetEntry {
  encoding: string;
  count: number;
}

/** Occurrences added or removed for one distinct encoding. */
export interface MultisetDelta {
  hash: string;
  encoding: string;
  count: number;
}

/** One row of a keyless table with its hash and 1-based occurrence among identical rows. */
export interface Occurrence {
  encoding: string;
  hash: string;
  occurrence: number;
}

/** Groups encodings by `sha256Hex(encoding)` with their occurrence counts. */
export function multiset(encodings: Iterable<string>): Map<string, MultisetEntry> {
  const out = new Map<string, MultisetEntry>();
  for (const encoding of encodings) {
    const hash = sha256Hex(encoding);
    const entry = out.get(hash);
    if (entry === undefined) out.set(hash, { encoding, count: 1 });
    else entry.count += 1;
  }
  return out;
}

type MultisetInput = Iterable<string> | ReadonlyMap<string, MultisetEntry>;

function asMultiset(input: MultisetInput): ReadonlyMap<string, MultisetEntry> {
  return input instanceof Map ? (input as ReadonlyMap<string, MultisetEntry>) : multiset(input as Iterable<string>);
}

function deltas(from: ReadonlyMap<string, MultisetEntry>, minus: ReadonlyMap<string, MultisetEntry>): MultisetDelta[] {
  const out: MultisetDelta[] = [];
  for (const [hash, entry] of from) {
    const count = entry.count - (minus.get(hash)?.count ?? 0);
    if (count > 0) out.push({ hash, encoding: entry.encoding, count });
  }
  return out.sort((x, y) => compareEncodings(x.encoding, y.encoding));
}

/** Occurrences added and removed per distinct encoding between two multisets (encodings or `multiset` output). */
export function diffMultiset(before: MultisetInput, after: MultisetInput): { added: MultisetDelta[]; removed: MultisetDelta[] } {
  const was = asMultiset(before);
  const now = asMultiset(after);
  return { added: deltas(now, was), removed: deltas(was, now) };
}

/** Numbers identical encodings 1..n in input order, as stored with `legacy_row_hash` on keyless target rows. */
export function assignOccurrences(encodings: Iterable<string>): Occurrence[] {
  const seen = new Map<string, number>();
  const out: Occurrence[] = [];
  for (const encoding of encodings) {
    const hash = sha256Hex(encoding);
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);
    out.push({ encoding, hash, occurrence });
  }
  return out;
}

const SQL_SERVER_TYPES: ReadonlyMap<string, CanonicalType> = new Map<string, CanonicalType>([
  ['char', 's'], ['nchar', 's'], ['varchar', 's'], ['nvarchar', 's'], ['text', 's'], ['ntext', 's'], ['xml', 's'],
  ['uniqueidentifier', 's'],
  ['int', 'i'], ['smallint', 'i'], ['tinyint', 'i'], ['bigint', 'i'], ['bit', 'i'],
  ['float', 'f'], ['real', 'f'],
  ['decimal', 'd'], ['numeric', 'd'], ['money', 'd'], ['smallmoney', 'd'],
  ['datetime', 't'], ['smalldatetime', 't'], ['datetime2', 't'], ['date', 't'],
  ['image', 'b'], ['varbinary', 'b'], ['binary', 'b'],
]);

const POSTGRES_TYPES: ReadonlyMap<string, CanonicalType> = new Map<string, CanonicalType>([
  ['bpchar', 's'], ['char', 's'], ['character', 's'], ['varchar', 's'], ['character varying', 's'], ['text', 's'],
  ['uuid', 's'], ['name', 's'],
  ['int2', 'i'], ['smallint', 'i'], ['int4', 'i'], ['integer', 'i'], ['int', 'i'], ['int8', 'i'], ['bigint', 'i'],
  ['bool', 'i'], ['boolean', 'i'],
  ['float4', 'f'], ['real', 'f'], ['float8', 'f'], ['double precision', 'f'],
  ['numeric', 'd'], ['decimal', 'd'],
  ['timestamp', 't'], ['timestamp without time zone', 't'],
  ['bytea', 'b'],
]);

const CATALOG_TYPE = /^([^()]*?)\s*(?:\(([^()]*)\)([^()]*))?$/;

/** Splits `numeric(19, 4)` or `timestamp(3) without time zone` into a lower-cased base name and its arguments. */
function parseCatalogType(raw: string): { base: string; args: string[] | undefined } {
  const m = CATALOG_TYPE.exec(raw.trim());
  if (m === null) return { base: '', args: undefined };
  const base = `${m[1] ?? ''} ${m[3] ?? ''}`.trim().replace(/\s+/g, ' ').toLowerCase();
  return { base, args: m[2] === undefined ? undefined : m[2].split(',').map((arg) => arg.trim()) };
}

function catalogScale(dataType: string, args: string[] | undefined, scale: number | undefined): number {
  const declared = args === undefined ? undefined : args.length === 1 ? 0 : Number(args[1]);
  const resolved = scale ?? declared;
  if (resolved === undefined || !Number.isSafeInteger(resolved) || resolved < 0 || resolved > MAX_SCALE
    || (declared !== undefined && declared !== resolved)) {
    throw new CanonicalEncodingError(`cannot determine a fixed scale for '${dataType}'`, { type: 'd' });
  }
  return resolved;
}

function resolveCatalogType(
  engine: string,
  types: ReadonlyMap<string, CanonicalType>,
  dataType: string,
  base: string,
  args: string[] | undefined,
  scale: number | undefined,
): CanonicalTypeInfo {
  const type = types.get(base);
  if (type === undefined) throw new CanonicalEncodingError(`unsupported ${engine} type '${dataType}'`);
  if (base === 'money' || base === 'smallmoney') return { type, scale: 4 };
  return type === 'd' ? { type, scale: catalogScale(dataType, args, scale) } : { type };
}

/** Canonical type (and scale for `d`) of a SQL Server `DATA_TYPE`, e.g. `nvarchar`, `char(35)`, `decimal(19,4)`. */
export function canonicalTypeForSqlServer(dataType: string, opts: { scale?: number | undefined } = {}): CanonicalTypeInfo {
  const { base, args } = parseCatalogType(dataType);
  const unbracketed = /^\[(.+)\]$/.exec(base)?.[1] ?? base;
  return resolveCatalogType('SQL Server', SQL_SERVER_TYPES, dataType, unbracketed, args, opts.scale);
}

/** Canonical type (and scale for `d`) of a PostgreSQL `udt_name` or `format_type` name, e.g. `int4`, `numeric(19,4)`. */
export function canonicalTypeForPostgres(udtName: string, opts: { scale?: number | undefined } = {}): CanonicalTypeInfo {
  const { base, args } = parseCatalogType(udtName);
  return resolveCatalogType('PostgreSQL', POSTGRES_TYPES, udtName, base, args, opts.scale);
}

/** Serialized-document columns compared byte-exact as `s` and never parsed. */
export const SERIALIZED_DOCUMENT_COLUMNS = Object.freeze([
  'ttrash.objectstring',
  'toauthtokens.data',
  'tformresponsepackets.Data',
  'tcontentobjects.params',
] as const);

