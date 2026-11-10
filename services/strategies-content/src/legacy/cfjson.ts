// Ports of the ColdFusion JSON encoders behind content responses outside the JSON API: mura.json encode and ACF serializeJSON.
// Behaviour notes marked "ACF" were observed on Adobe ColdFusion 2023 running the legacy code.
import { cfDateTimeFormat, cfIsNumeric, cfNumberString, type LegacyQuery } from '@opt2/platform/legacy-compat';

/** A ColdFusion query, as legacy-compat models it. */
export type CfQuery = LegacyQuery;

/** A CFML simple value; a Date stands for a CF date/time object. */
export type CfSimpleValue = string | number | boolean | Date;

/** Options of acfSerializeJson. */
export interface AcfSerializeJsonOptions {
  /** Emit struct keys as given, for keys legacy set by bracket or quoted name; by default keys are upper-cased as ACF does for dot-notation keys. */
  preserveKeyCase?: boolean;
}

const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\f': '\\f',
  '\b': '\\b',
};
// ACF: other control characters, DEL, '/' and non-ASCII pass through JSStringFormat unchanged.
const JS_STRING_SPECIALS = /[\\"'\n\r\t\f\b]/g;

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};
// ACF serializeJSON: '/' and non-ASCII stay raw; other C0 characters and DEL become lowercase \u00xx.
const JSON_SPECIALS = /["\\\u0000-\u001F\u007F]/g;

/** ACF JSStringFormat. */
export function cfJsStringFormat(s: string): string {
  return s.replace(JS_STRING_SPECIALS, (c) => JS_STRING_ESCAPES[c] ?? c);
}

/** ACF ToString of a simple value: numbers as CFML prints them, dates as {ts 'yyyy-mm-dd HH:nn:ss'}. */
export function cfToString(value: CfSimpleValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}`;
}

function isSimpleValue(v: unknown): v is CfSimpleValue {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date;
}

function isCfQuery(v: unknown): v is CfQuery {
  const q = v as Partial<CfQuery>;
  return q.kind === 'query' && Array.isArray(q.columnList) && Array.isArray(q.rows);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Cell of a row by column name, case-insensitively as ACF query columns resolve. */
function cellOf(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const upper = column.toUpperCase();
  const key = Object.keys(row).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : row[key];
}

/** Port of core/mura/json.cfc encode (lines 215-295); the output is not always valid JSON, exactly as legacy. */
export function muraJsonEncode(value: unknown): string {
  // Database NULLs reach legacy beans and query cells as empty strings, so a null member or cell encodes as "".
  if (value === null || value === undefined) return '""';
  if (Array.isArray(value)) return encodeArray(value);
  if (isCfQuery(value)) return encodeQuery(value);
  if (isPlainObject(value)) return encodeStruct(value);
  if (isSimpleValue(value)) {
    // json.cfc:261-262: numeric values, numeric strings included, are emitted raw (ACF: '007' -> 007, ' 12' -> " 12" unquoted).
    if (cfIsNumeric(value)) return cfToString(value);
    return `"${cfJsStringFormat(cfToString(value))}"`;
  }
  if (typeof value === 'object') return 'unknown-obj';
  return 'unknown';
}

/** Encoding of a value, or undefined where encoding throws (json.cfc's try/catch). */
function tryEncode(value: unknown): string | undefined {
  try {
    return muraJsonEncode(value);
  } catch {
    return undefined;
  }
}

function encodeArray(items: readonly unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    // ACF: reading a null element throws, so json.cfc's catch drops it with every element that fails to encode ([1,null,2] -> [1,2]).
    if (item === null || item === undefined) continue;
    const encoded = tryEncode(item);
    if (encoded !== undefined) parts.push(encoded);
  }
  return `[${parts.join(',')}]`;
}

function encodeStruct(struct: Record<string, unknown>): string {
  const keys = Object.keys(struct);
  if (keys.length === 0) return '{}';
  let encoded = '';
  const members = keys.map((key) => {
    // json.cfc:248-250: a member that fails to encode keeps the previous member's encoding (nothing for the first).
    encoded = tryEncode(struct[key]) ?? encoded;
    // json.cfc:254: keys are lower-cased and written without escaping.
    return `"${key.toLowerCase()}":${encoded}`;
  });
  return `{${members.join(',')}}`;
}

/** ACF ToString of a cfquery datetime cell (java.sql.Timestamp): yyyy-mm-dd HH:mm:ss.f, trailing fraction zeros dropped. */
function timestampText(d: Date): string {
  const fraction = String(d.getMilliseconds()).padStart(3, '0').replace(/0+$/, '') || '0';
  return `${cfDateTimeFormat(d, 'yyyy-mm-dd HH:nn:ss')}.${fraction}`;
}

function encodeCell(value: unknown): string {
  return value instanceof Date ? `"${cfJsStringFormat(timestampText(value))}"` : muraJsonEncode(value);
}

function encodeQuery(query: CfQuery): string {
  // ACF query.columnList is upper-cased and sorted by code unit (A,B,B1,BZ,B_X,ZETA,_U); data follows that order.
  const columns = query.columnList.map((c) => c.toUpperCase()).sort();
  const data = columns.map((column) => {
    const cells = query.rows.map((row) => encodeCell(cellOf(row, column)));
    return `"${column}":[${cells.join(',')}]`;
  });
  return `{"recordcount":${String(query.rows.length)},"columnlist":${muraJsonEncode(columns.join(','))},"data":{${data.join(',')}}}`;
}

function acfString(s: string): string {
  const escaped = s.replace(JSON_SPECIALS, (c) => JSON_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/** Java Double.toString: plain decimal in [1e-3, 1e7), else d.dddE[-]n (ACF: 1/3 -> 0.3333333333333333, 10^20 -> 1.0E20). */
function javaDoubleText(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e-3 && abs < 1e7) return String(n);
  const [mantissa = '', exponent = '0'] = n.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${String(Number(exponent))}`;
}

function acfNumber(n: number): string {
  if (!Number.isFinite(n)) return 'null';
  // A JS number cannot say whether legacy held an Integer or a Double, so integral values print as integers
  // (ACF: an int column gives 5, a computed double 5.0); other values print as Java doubles.
  return Number.isSafeInteger(n) ? String(n) : javaDoubleText(n);
}

/** ACF serializeJSON default date text, e.g. "June, 30 2026 13:04:05", in the process time zone. */
function acfDateText(d: Date): string {
  return cfDateTimeFormat(d, 'mmmm, dd yyyy HH:nn:ss');
}

function acfQuery(query: CfQuery, preserveKeyCase: boolean): string {
  // ACF serializeQueryAs "row": upper-cased columns in query order; NULL cells are null.
  const columns = query.columnList.map((c) => acfString(c.toUpperCase()));
  const rows = query.rows.map(
    (row) => `[${query.columnList.map((c) => acfJson(cellOf(row, c), preserveKeyCase)).join(',')}]`,
  );
  return `{"COLUMNS":[${columns.join(',')}],"DATA":[${rows.join(',')}]}`;
}

function acfJson(value: unknown, preserveKeyCase: boolean): string {
  if (value === null || value === undefined) return 'null';
  // ACF 2023 keeps strings as strings, numeric-looking ones included ("1", "1.50", "007" stay quoted).
  if (typeof value === 'string') return acfString(value);
  if (typeof value === 'number') return acfNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return acfString(acfDateText(value));
  // Array.from visits holes as undefined, which serialize as null like ACF's undefined elements.
  if (Array.isArray(value)) return `[${Array.from(value, (v: unknown) => acfJson(v, preserveKeyCase)).join(',')}]`;
  if (isCfQuery(value)) return acfQuery(value, preserveKeyCase);
  if (isPlainObject(value)) {
    const members = Object.keys(value).map(
      (key) => `${acfString(preserveKeyCase ? key : key.toUpperCase())}:${acfJson(value[key], preserveKeyCase)}`,
    );
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`serializeJSON has no CFML form for a ${typeof value === 'object' ? 'class instance' : typeof value}`);
}

/** Port of ACF 2023 native serializeJSON (carch update errors, cfobject getAsJSON). */
export function acfSerializeJson(value: unknown, opts: AcfSerializeJsonOptions = {}): string {
  return acfJson(value, opts.preserveKeyCase === true);
}
