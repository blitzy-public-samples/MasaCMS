// WDDX 1.0 packet writer reproducing ACF 2023 <cfwddx action="cfml2wddx"> output (trashManager.cfc:227).
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';

/** Number written with this exact lexical form, such as a value copied from a captured packet. */
export class WddxNumber {
  constructor(readonly text: string) {}
}

// A bean's values carry query objects (userBean.cfc:162 creates the empty ADDRESSES query), so recordsets are part of the value model.
/** CFML query: column names in query order and rows of cells in column order. */
export class WddxRecordset {
  constructor(
    readonly columns: readonly string[],
    readonly rows: readonly (readonly WddxValue[])[] = [],
  ) {}
}

/** A value cfml2wddx serializes; null and undefined stand for CFML empty strings. */
export type WddxValue =
  | string
  | number
  | WddxNumber
  | boolean
  | Date
  | null
  | undefined
  | WddxRecordset
  | readonly WddxValue[]
  | WddxStruct;

/** CFML struct, written in iteration order with keys as given; plain objects list integer-like keys first, so use a Map to keep those in captured order. */
export type WddxStruct = { [key: string]: WddxValue } | ReadonlyMap<string, WddxValue>;

/** Opening tag ACF writes for a CFML struct (coldfusion.runtime.Struct carries no type attribute). */
export const WDDX_STRUCT_OPEN = '<struct>';

const PACKET_OPEN = "<wddxPacket version='1.0'><header/><data>";
const PACKET_CLOSE = '</data></wddxPacket>';
const RECORDSET_TYPE = 'coldfusion.sql.QueryTable';
const EMPTY_STRING = '<string></string>';

/** Serializes a struct to the packet ACF's cfml2wddx produces, byte for byte. */
export function cfml2wddx(values: WddxStruct): string {
  return PACKET_OPEN + element(values) + PACKET_CLOSE;
}

function element(v: WddxValue): string {
  // ACF runs without null support, so a query NULL reaches cfwddx as an empty string.
  if (v === null || v === undefined) return EMPTY_STRING;
  if (typeof v === 'string') return `<string>${escapeText(v, false)}</string>`;
  if (typeof v === 'number') return `<number>${javaDoubleString(v)}</number>`;
  if (typeof v === 'boolean') return `<boolean value='${v}'/>`;
  if (v instanceof WddxNumber) return `<number>${escapeText(v.text, false)}</number>`;
  if (v instanceof Date) return `<dateTime>${isoDateTime(v)}</dateTime>`;
  if (v instanceof WddxRecordset) return recordset(v);
  if (Array.isArray(v)) return array(v as readonly WddxValue[]);
  if (v instanceof Map) return struct((v as ReadonlyMap<string, WddxValue>).entries());
  if (isPlainObject(v)) return struct(Object.entries(v));
  throw new TypeError(`Cannot serialize ${describe(v)} as WDDX`);
}

function struct(entries: Iterable<[string, WddxValue]>): string {
  let out = WDDX_STRUCT_OPEN;
  for (const [key, value] of entries) out += `<var name='${escapeText(String(key), true)}'>${element(value)}</var>`;
  return `${out}</struct>`;
}

function array(items: readonly WddxValue[]): string {
  let out = `<array length='${items.length}'>`;
  for (const item of items) out += element(item);
  return `${out}</array>`;
}

function recordset(rs: WddxRecordset): string {
  // ACF writes fieldNames verbatim but attribute-escapes each field's name attribute.
  let out = `<recordset rowCount='${rs.rows.length}' fieldNames='${rs.columns.join(',')}' type='${RECORDSET_TYPE}'>`;
  rs.columns.forEach((name, column) => {
    out += `<field name='${escapeText(name, true)}'>`;
    for (const row of rs.rows) out += element(row[column]);
    out += '</field>';
  });
  return `${out}</recordset>`;
}

function isPlainObject(v: object): v is { [key: string]: WddxValue } {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function describe(v: unknown): string {
  if (typeof v !== 'object' || v === null) return typeof v;
  const ctor: unknown = (v as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name ? ctor.name : 'object';
}

/** Escapes one UTF-16 code unit as ACF's UTF8Converter tables do; undefined when it is written as is. */
function escapeUnit(code: number, attribute: boolean): string | undefined {
  if (code < 0x20) return `<char code='${code.toString(16).padStart(2, '0')}'/>`;
  // Every unit from 0x80 up becomes a character reference, so a surrogate pair is written as two.
  if (code >= 0x80) return `&#x${code.toString(16)};`;
  switch (code) {
    case 0x26:
      return '&amp;';
    case 0x3c:
      return '&lt;';
    case 0x3e:
      return '&gt;';
    case 0x27:
      return attribute ? '&apos;' : undefined;
    case 0x22:
      return attribute ? '&quot;' : undefined;
    default:
      return undefined;
  }
}

/** Escapes element text (& < > as entities) or a name attribute (also ' and "); units below 0x20 become <char code='xx'/>, from 0x80 &#x<hex>;. */
function escapeText(s: string, attribute: boolean): string {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const encoded = escapeUnit(s.charCodeAt(i), attribute);
    if (encoded === undefined) continue;
    out += s.slice(start, i) + encoded;
    start = i + 1;
  }
  return out + s.slice(start);
}

// ACF writes every number as a double (captured: <number>1.0</number>); digits are the shortest round-trip ones,
// which Java 17 lengthens for some magnitudes above 1e16, so a WddxNumber carries a captured form exactly.
/** Java Double.toString: 1 -> 1.0, 0.5 -> 0.5, 1e7 -> 1.0E7, 1e-4 -> 1.0E-4. */
function javaDoubleString(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(v);
  if (abs >= 1e-3 && abs < 1e7) {
    const plain = String(v);
    return plain.includes('.') ? plain : `${plain}.0`;
  }
  const [mantissa = '', exponent = '0'] = v.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}

/** Zero-pads below 10, as ISO8601.adjustPrefixSet does. */
const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

// ACF 2023 (coldfusion.wddx.ISO8601) zero-pads every part after the year and the offset (captured:
// 2026-11-10T09:08:24+00:00), so the WDDX specification's unpadded form is not used.
/** coldfusion.wddx.ISO8601.stringValueOf(d, true) in the process time zone. */
function isoDateTime(d: Date): string {
  const stamp = cfDateTimeFormat(d, "yyyy-mm-dd'T'HH:nn:ss");
  // Java adds today's raw offset to the date's DST offset; that equals the date's offset unless the zone's standard offset has since changed.
  const offset = Math.trunc(-d.getTimezoneOffset());
  const minutes = Math.abs(offset);
  return `${stamp}${offset < 0 ? '-' : '+'}${pad2(Math.trunc(minutes / 60))}:${pad2(minutes % 60)}`;
}
