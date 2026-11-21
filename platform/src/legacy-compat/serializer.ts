// Port of core/mura/jsonSerializer.cfc with the key hints the JSON API installs (jsonApiUtility.cfc:46-67, 261-271).
// Behaviour notes marked "ACF" were observed on Adobe ColdFusion 2023 running the legacy serializer.
import { cfDoubleShape, isHexFloatLiteral, parseDecimal } from './acf-double.js';
import { formatSerializerDate, formatSerializerUtcDate } from './dates.js';

/** Data-type hint a serializer key can carry; `any` lets the parent hint fall through. */
export type SerializerHint = 'any' | 'string' | 'boolean' | 'integer' | 'float' | 'date' | 'utcdate';

/** Hint a caller may register for an API key or an entity property. */
export type ApiSerializerHint = 'integer' | 'float' | 'date' | 'string' | 'boolean';

/** One key-to-hint registration. */
export interface ApiKeyHint {
  key: string;
  hint: ApiSerializerHint;
}

/** A ColdFusion query: serialized as an array of row structs, columns in `columnList` order. */
export interface LegacyQuery {
  readonly kind: 'query';
  columnList: string[];
  rows: Record<string, unknown>[];
}

type SimpleValue = string | number | boolean | Date;

const VAL_PREFIX = /^[+-]?(?:\d+\.?\d*|\.\d+)/;
const BOOLEAN_WORD = /^(?:true|false|yes|no)$/i;
const TRUE_WORD = /^(?:true|yes)$/i;
/** Text CFDouble hands to its parser: a digit, sign or '.' first. */
const NUMBER_START = /^[0-9+\-.]/;
/** Java `Double.parseDouble`'s grammar without a type suffix. */
const JAVA_DOUBLE_TEXT = /^[+-]?(?:NaN|Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)[pP][+-]?\d+)$/;
// POSIX [[:cntrl:]] as ACF's reReplace matches it: ASCII C0 and DEL only, not U+0080-U+009F.
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};
const NEEDS_ESCAPE = /["\\\u0000-\u001F\u007F]/g;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Java String.trim(), which ACF applies before numeric parsing: strips every char <= U+0020. */
export function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/**
 * Text as CFDouble reads a number: ACF's DoubleParser copy, or Java's own parser (`java`), behind its guard of a digit,
 * sign or '.' first, no edge whitespace and no f/F/d/D suffix. Null for text it reads as no number.
 */
function acfDouble(text: string, java = false): number | null {
  return NUMBER_START.test(text) && cfDoubleShape(text) ? parseDecimal(text, java) : null;
}

/** Whether `n` is a number but an infinity; NaN counts. */
function isNonInfinite(n: number | null): n is number {
  return n !== null && Math.abs(n) !== Infinity;
}

/**
 * CFML isNumeric: finite numbers, and text ACF's DoubleParser reads as finite once Java-trimmed (ACF: '12'&chr(1) and
 * '0x1p3' are numeric; '1e309', '-NaN' and '0xAp0', whose binary exponent the copy reads from its digits, are not).
 */
export function cfIsNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && Number.isFinite(acfDouble(javaTrim(v)) ?? NaN);
}

/** An `==` operand's number: a boolean word as 1 or 0, else text not ending in '.' ACF's DoubleParser reads as no infinity. */
function comparedNumber(text: string): number | undefined {
  if (BOOLEAN_WORD.test(text)) return TRUE_WORD.test(text) ? 1 : 0;
  const n = text.endsWith('.') ? null : acfDouble(text);
  return isNonInfinite(n) ? n : undefined;
}

/**
 * CFML `==` on strings: numeric when both Java-trimmed sides read as numbers, else case-insensitive text (ACF: '1.' == '1'
 * and '0x1p3' == '8' are false; ' yes' == '1', '0x1p3' == '2' are true; '-NaN' equals nothing).
 */
export function cfEq(a: string, b: string): boolean {
  const x = comparedNumber(javaTrim(a));
  const y = comparedNumber(javaTrim(b));
  if (x !== undefined && y !== undefined) return x === y;
  return a.toLowerCase() === b.toLowerCase();
}

/** CFML isBoolean: booleans, finite numbers, true/false/yes/no in any case, and untrimmed number text but an infinity (ACF: ' 1' and '1e309' are not boolean; '-NaN' is). */
export function cfIsBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && (BOOLEAN_WORD.test(v) || isNonInfinite(acfDouble(v)));
}

/**
 * CFML boolean conversion, as `<cfif>` reads a value: true/yes and false/no by word, numbers and untrimmed number text by
 * non-zero (ACF: '1e309', '0xAp0' and '-NaN' are true; '0x10000p-1' is false); throws for a value CFML cannot convert.
 */
export function cfToBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v !== 0;
  if (typeof v === 'string') {
    if (BOOLEAN_WORD.test(v)) return TRUE_WORD.test(v);
    const n = acfDouble(v);
    if (n !== null) return n !== 0;
  }
  throw new TypeError(`Cannot convert ${String(v)} to a boolean`);
}

/**
 * CFML numeric conversion of a number or number text, as arithmetic and a numeric binding read it: Java-trimmed text by
 * Java's parser (ACF: '0x1p3' is 8, '0xAp0' 10); throws for a value CFML cannot convert or reads as NaN or an infinity.
 */
export function cfToNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = typeof v === 'string' ? acfDouble(javaTrim(v), true) : null;
  if (n === null || !Number.isFinite(n)) throw new TypeError(`Cannot convert ${String(v)} to a number`);
  return n;
}

/** CFML `isValid('numeric')`, which a `type="numeric"` argument also checks: Java-trimmed text in Java's double grammar, of any magnitude. */
export function cfIsValidNumeric(text: string): boolean {
  return JAVA_DOUBLE_TEXT.test(javaTrim(text));
}

/** Whether `v` is text holding a Java hex float literal once Java-trimmed, which SQL Server reads as no number when inlined. */
export function cfIsHexFloatText(v: unknown): boolean {
  return typeof v === 'string' && isHexFloatLiteral(javaTrim(v));
}

/** CFML `Val`: the signed decimal (never an exponent) the Java-trimmed simple-value text starts with; else 0, overflow included. */
export function cfVal(value: unknown): number {
  const number = Number(VAL_PREFIX.exec(javaTrim(simpleText(value)))?.[0] ?? '');
  return Number.isFinite(number) ? number : 0;
}

/** A simple value as CFML text: strings as is, numbers and booleans as ACF prints them; '' for anything else. */
function simpleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  return typeof value === 'boolean' ? String(value) : '';
}

/** CFML isDate for serializer input: valid Date instances only; date-typed values must arrive as Date objects. */
export function cfIsDate(v: unknown): v is Date {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

/** Number as ACF prints it: integers verbatim, other doubles with 12 significant digits (ACF: 1/3 -> 0.333333333333, 1e20 -> 1E+020). */
export function cfNumberString(n: number): string {
  if (Number.isSafeInteger(n)) return String(n);
  // The notation is chosen by the unrounded exponent (ACF: 999999999999.5 -> 1000000000000, 1e12 -> 1E+012).
  const exponent = Number(n.toExponential().split('e')[1]);
  if (exponent < -4 || exponent >= 12) {
    const [mantissa = '', exp = '0'] = n.toExponential(11).split('e');
    const power = Number(exp);
    return `${trimFraction(mantissa)}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(3, '0')}`;
  }
  return trimFraction(n.toFixed(11 - exponent));
}

/** Drops trailing fractional zeros and a bare decimal point. */
function trimFraction(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** ACF serializeJSON string literal: '/' and non-ASCII stay raw; other C0 chars and DEL use lowercase \u00xx. */
export function jsonString(s: string): string {
  const escaped = s.replace(
    NEEDS_ESCAPE,
    (c) => SHORT_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `"${escaped}"`;
}

/** ACF serializeJSON default date text, e.g. "October, 29 2026 13:04:05", in the process time zone. */
function cfDefaultDateString(d: Date): string {
  if (!cfIsDate(d)) throw new RangeError('Invalid date');
  const two = (n: number): string => String(n).padStart(2, '0');
  const year = String(d.getFullYear()).padStart(4, '0');
  return `${MONTHS[d.getMonth()]!}, ${two(d.getDate())} ${year} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Native serializeJSON of a simple value. */
function jsonValue(v: SimpleValue): string {
  if (typeof v === 'string') return jsonString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return jsonString(cfDefaultDateString(v));
  return Number.isFinite(v) ? cfNumberString(v) : 'null';
}

/** Text of a numeric simple value as CFML writeOutput renders it. */
function numericText(v: string | number): string {
  return typeof v === 'number' ? cfNumberString(v) : v;
}

/** Serializes a simple value under a hint (jsonSerializer.cfc:189-244). */
function simpleValue(v: SimpleValue, hint: SerializerHint): string {
  const numeric = cfIsNumeric(v);
  if (hint === 'string' || hint === 'any') {
    // jsonSerializer.cfc:197: numeric values are quoted raw, without escaping.
    return numeric ? `"${numericText(v as string | number)}"` : jsonValue(v);
  }
  if (hint === 'boolean' && cfIsBoolean(v)) return cfToBoolean(v) ? 'true' : 'false';
  if (hint === 'integer' || hint === 'float') {
    if (numeric) return numericText(v as string | number);
    if (cfIsBoolean(v)) return cfToBoolean(v) ? '1' : '0';
  }
  if (hint === 'date' && cfIsDate(v)) return `"${formatSerializerDate(v)}"`;
  if (hint === 'utcdate' && cfIsDate(v)) return `"${formatSerializerUtcDate(v)}"`;
  return jsonValue(v);
}

function isSimpleValue(v: unknown): v is SimpleValue {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date;
}

function isLegacyQuery(v: unknown): v is LegacyQuery {
  const q = v as Partial<LegacyQuery>;
  return q.kind === 'query' && Array.isArray(q.columnList) && Array.isArray(q.rows);
}

/** Cell value by column name, case-insensitively as ACF query columns resolve. */
function cell(row: Record<string, unknown>, column: string): unknown {
  if (Object.hasOwn(row, column)) return row[column];
  const lower = column.toLowerCase();
  const key = Object.keys(row).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : row[key];
}

/** Builds a LegacyQuery from its column list and rows. */
export function legacyQuery(columnList: string[], rows: Record<string, unknown>[]): LegacyQuery {
  return { kind: 'query', columnList, rows };
}

/** Case-insensitive key-hinted JSON serializer producing legacy JSON API bodies (jsonSerializer.cfc). */
export class LegacyJsonSerializer {
  readonly #keys = new Set<string>();
  readonly #hints = new Map<string, SerializerHint>();
  readonly #excluded = new Set<string>();

  /** Registers a key without a type, so the parent hint applies to its value. */
  asAny(key: string): this {
    return this.#define(key, 'any');
  }

  /** Registers a key whose simple values serialize as strings. */
  asString(key: string): this {
    return this.#define(key, 'string');
  }

  /** Registers a key whose boolean-like values serialize as true/false. */
  asBoolean(key: string): this {
    return this.#define(key, 'boolean');
  }

  /** Registers a key whose numeric values serialize raw and booleans as 1/0. */
  asInteger(key: string): this {
    return this.#define(key, 'integer');
  }

  /** Registers a key whose numeric values serialize raw and booleans as 1/0. */
  asFloat(key: string): this {
    return this.#define(key, 'float');
  }

  /** Registers a key whose Date values serialize as local yyyy-mm-ddTHH:mm:ss. */
  asDate(key: string): this {
    return this.#define(key, 'date');
  }

  /** Registers a key whose Date values serialize as ISO 8601 with a zone offset. */
  asUtcDate(key: string): this {
    return this.#define(key, 'utcdate');
  }

  /** Omits a key from struct and query output. */
  exclude(key: string): this {
    this.#excluded.add(key.toLowerCase());
    return this;
  }

  /** Serializes input as legacy JSON text. */
  serialize(input: unknown): string {
    const out: string[] = [];
    this.#write(input, 'any', out);
    // jsonSerializer.cfc:119: reReplace defaults to scope "one", so only the first control character is removed (ACF).
    return out.join('').replace(CONTROL_CHAR, '');
  }

  /**
   * Whether legacy's serializer would raise on `input`: a struct member that is null under a key with a hint is passed
   * to serializeInput, whose required INPUT argument it then lacks (jsonSerializer.cfc:262-275); arrays skip nulls.
   */
  nullUnderHint(input: unknown): boolean {
    if (Array.isArray(input)) return (input as unknown[]).some((item) => item !== null && item !== undefined && this.nullUnderHint(item));
    if (input === null || typeof input !== 'object' || isSimpleValue(input) || isLegacyQuery(input)) return false;
    return Object.entries(input as Record<string, unknown>).some(([key, value]) => {
      const lower = key.toLowerCase();
      if (this.#excluded.has(lower)) return false;
      return value === null || value === undefined ? this.#hints.has(lower) : this.nullUnderHint(value);
    });
  }

  #define(key: string, hint: SerializerHint): this {
    const lower = key.toLowerCase();
    // jsonSerializer.cfc:138-140: the first definition of a key wins.
    if (this.#keys.has(lower)) return this;
    this.#keys.add(lower);
    // jsonSerializer.cfc:163: "any" stores no hint so parent hints fall through.
    if (hint !== 'any') this.#hints.set(lower, hint);
    return this;
  }

  // Legacy also asAny()s unseen keys mid-serialization (jsonSerializer.cfc:279-283); hints are installed first, so this stays pure.
  #write(input: unknown, hint: SerializerHint, out: string[]): void {
    if (input === null || input === undefined) {
      // jsonSerializer.cfc:295-296: a null member serializes as null.
      out.push('null');
    } else if (isSimpleValue(input)) {
      out.push(simpleValue(input, hint));
    } else if (Array.isArray(input)) {
      out.push('[');
      let first = true;
      for (const item of input as unknown[]) {
        // ACF array iteration skips null elements, delimiter included (ACF: [1,null,2] -> ["1","2"]).
        if (item === null || item === undefined) continue;
        if (!first) out.push(',');
        first = false;
        this.#write(item, hint, out);
      }
      out.push(']');
    } else if (isLegacyQuery(input)) {
      this.#writeQuery(input, hint, out);
    } else if (typeof input === 'object') {
      this.#writeStruct(input as Record<string, unknown>, hint, out);
    } else {
      // jsonSerializer.cfc:425: other types go to the native serializer.
      out.push(JSON.stringify(input) ?? 'null');
    }
  }

  #writeStruct(input: Record<string, unknown>, hint: SerializerHint, out: string[]): void {
    out.push('{');
    let first = true;
    for (const key of Object.keys(input)) {
      const lower = key.toLowerCase();
      if (this.#excluded.has(lower)) continue;
      if (!first) out.push(',');
      first = false;
      out.push(jsonString(lower), ':');
      this.#write(input[key], this.#hints.get(lower) ?? hint, out);
    }
    out.push('}');
  }

  #writeQuery(input: LegacyQuery, hint: SerializerHint, out: string[]): void {
    out.push('[');
    input.rows.forEach((row, index) => {
      if (index > 0) out.push(',');
      out.push('{');
      let first = true;
      for (const column of input.columnList) {
        const lower = column.toLowerCase();
        if (this.#excluded.has(lower)) continue;
        if (!first) out.push(',');
        first = false;
        out.push(jsonString(lower), ':');
        // ACF query cells read NULL as an empty string (ACF: cast(null as int) under an integer hint -> "").
        this.#write(cell(row, column) ?? '', this.#hints.get(lower) ?? hint, out);
      }
      out.push('}');
    });
    out.push(']');
  }
}

/** Key hints the JSON API serializer installs, in legacy call order (jsonApiUtility.cfc:46-67). */
export const API_SERIALIZER_HINTS: readonly Readonly<ApiKeyHint>[] = Object.freeze([
  { key: 'csrf_token_expires', hint: 'string' },
  { key: 'csrf_token', hint: 'string' },
  { key: 'id', hint: 'string' },
  { key: 'url', hint: 'string' },
  { key: 'start', hint: 'date' },
  { key: 'end', hint: 'date' },
  { key: 'startindex', hint: 'integer' },
  { key: 'endindex', hint: 'integer' },
  { key: 'itemsperpage', hint: 'integer' },
  // Registered twice in legacy; the first definition wins.
  { key: 'endindex', hint: 'integer' },
  { key: 'totalpages', hint: 'integer' },
  { key: 'totalitems', hint: 'integer' },
  { key: 'pageindex', hint: 'integer' },
  { key: 'code', hint: 'integer' },
  { key: 'title', hint: 'string' },
  { key: 'isnew', hint: 'integer' },
  { key: 'saveErrors', hint: 'boolean' },
  { key: 'scaffold', hint: 'boolean' },
  { key: 'dynamic', hint: 'boolean' },
  { key: 'expires_at', hint: 'integer' },
  { key: 'expires_in', hint: 'integer' },
]);

const ENTITY_DATATYPE_HINTS: ReadonlyMap<string, ApiSerializerHint> = new Map([
  ['int', 'integer'],
  ['tinyint', 'integer'],
  ['integer', 'integer'],
  ['float', 'float'],
  ['numeric', 'float'],
  ['double', 'float'],
  ['date', 'date'],
  ['datetime', 'date'],
  ['timestamp', 'date'],
]);

/** Hint registerEntity installs for an entity property datatype, if any (jsonApiUtility.cfc:261-271). */
export function entityPropertyHint(datatype: string): ApiSerializerHint | undefined {
  return ENTITY_DATATYPE_HINTS.get(datatype.toLowerCase());
}

const APPLY_HINT: Readonly<Record<ApiSerializerHint, (s: LegacyJsonSerializer, key: string) => LegacyJsonSerializer>> = {
  string: (s, key) => s.asString(key),
  boolean: (s, key) => s.asBoolean(key),
  integer: (s, key) => s.asInteger(key),
  float: (s, key) => s.asFloat(key),
  date: (s, key) => s.asDate(key),
};

/** JSON API serializer: the legacy API hints, then entity property hints; a key keeps its first hint. */
export function createApiSerializer(extraHints: readonly ApiKeyHint[] = []): LegacyJsonSerializer {
  const serializer = new LegacyJsonSerializer();
  for (const { key, hint } of [...API_SERIALIZER_HINTS, ...extraHints]) APPLY_HINT[hint](serializer, key);
  return serializer;
}
