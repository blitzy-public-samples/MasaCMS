// WDDX 1.0 packet writer reproducing ACF 2023 <cfwddx action="cfml2wddx"> for people's address trash rows (trashManager.cfc:227).
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';

/** Number written exactly as given inside <number>, such as a form copied from a captured packet. */
export class WddxNumber {
  constructor(readonly lexical: string) {}
}

/** CFML struct as ordered entries; cfml2wddx writes them in this order with keys as given. */
export type WddxStruct = { readonly entries: ReadonlyArray<readonly [key: string, value: WddxValue]> };

/** A value cfml2wddx serializes; null is a Java null member. */
export type WddxValue = string | number | boolean | Date | null | WddxNumber | WddxStruct | readonly WddxValue[];

/** Opening tag ACF writes for a CFML struct (coldfusion.runtime.Struct carries no type attribute). */
export const WDDX_STRUCT_OPEN = '<struct>';

/** A stored tuseraddresses row in legacy column names (mssql.sql:444-464); null is SQL NULL. */
export interface AddressRow {
  readonly addressID: string;
  readonly userID: string | null;
  readonly siteID: string | null;
  readonly addressName: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly country: string | null;
  readonly phone: string | null;
  readonly fax: string | null;
  readonly isPrimary: number | null;
  readonly addressNotes: string | null;
  readonly addressURL: string | null;
  readonly longitude: number | null;
  readonly latitude: number | null;
  readonly addressEmail: string | null;
  readonly hours: string | null;
}

/** Extended-set data as extendData.convertDataToStruct builds it (extendData.cfc:406-440): values in data-query row order and the valueList of their set ids. */
export interface AddressExtendedData {
  readonly extendSetId: string;
  readonly data: ReadonlyArray<readonly [name: string, value: string | Date]>;
}

/** Everything throwIn serializes for a deleted address. */
export interface AddressTrashInput {
  readonly address: AddressRow;
  readonly extendedData: AddressExtendedData;
  /** muraDeleteDateTime, now() when throwIn runs. */
  readonly deleteDateTime: Date;
  /** muraDeleteID, a createUUID() value. */
  readonly deleteId: string;
  /** INSTANCEID, the createUUID() value bean.init takes when userDAO.readAddress creates the bean. */
  readonly instanceId: string;
}

const PACKET_OPEN = "<wddxPacket version='1.0'><header/><data>";
const PACKET_CLOSE = '</data></wddxPacket>';
const TEXT_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = { ...TEXT_ENTITIES, "'": '&apos;', '"': '&quot;' };
const ZERO = new WddxNumber('0.0');
// A ninth node in one bin makes ConcurrentHashMap treeify it (or presize the table); that order is not modelled.
const TREEIFY_THRESHOLD = 8;

/** Serializes a struct to the packet ACF's cfml2wddx produces, byte for byte. */
export function cfml2wddx(values: WddxStruct): string {
  return PACKET_OPEN + struct(values) + PACKET_CLOSE;
}

function element(v: WddxValue): string {
  // WddxOutputStream.writeNull: a null member is <null/>, never an empty string.
  if (v === null) return '<null/>';
  if (typeof v === 'string') return `<string>${escapeXml(v, TEXT_ENTITIES)}</string>`;
  if (typeof v === 'number') return `<number>${javaDoubleString(v)}</number>`;
  if (typeof v === 'boolean') return `<boolean value='${v}'/>`;
  if (v instanceof WddxNumber) return `<number>${v.lexical}</number>`;
  if (v instanceof Date) return `<dateTime>${isoDateTime(v)}</dateTime>`;
  if (Array.isArray(v)) return array(v as readonly WddxValue[]);
  if (isStruct(v)) return struct(v);
  throw new TypeError(`Cannot serialize ${describe(v)} as WDDX`);
}

function struct(s: WddxStruct): string {
  let out = WDDX_STRUCT_OPEN;
  for (const [key, value] of s.entries) out += `<var name='${escapeXml(key, ATTRIBUTE_ENTITIES)}'>${element(value)}</var>`;
  return `${out}</struct>`;
}

function array(items: readonly WddxValue[]): string {
  let out = `<array length='${items.length}'>`;
  for (const item of items) out += element(item);
  return `${out}</array>`;
}

function isStruct(v: unknown): v is WddxStruct {
  return typeof v === 'object' && v !== null && Array.isArray((v as { entries?: unknown }).entries);
}

function describe(v: unknown): string {
  if (typeof v !== 'object' || v === null) return typeof v;
  const ctor: unknown = (v as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name ? ctor.name : 'object';
}

// Captured: every unit from 0x80 up, ' and " in element text included, is written as is.
/** UTF8Converter tables: units below 0x20 as <char code='hh'/> (lowercase hex), the given characters as entities. */
function escapeXml(s: string, entities: Readonly<Record<string, string>>): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s.charAt(i);
    out += code < 0x20 ? `<char code='${code.toString(16).padStart(2, '0')}'/>` : (entities[ch] ?? ch);
  }
  return out;
}

// Digits are JS's shortest round-trip ones; Java 17 lengthens a few rare values, so WddxNumber carries a captured form exactly.
/** Java Double.toString, which writeDouble uses: 0 -> 0.0, 1 -> 1.0, 1e7 -> 1.0E7, 1e-4 -> 1.0E-4. */
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

// Java adds the zone's current raw offset to the date's DST offset; that equals the date's offset unless the zone's standard offset has since changed.
/** coldfusion.wddx.ISO8601.stringValueOf(d, true) in the process zone: unpadded year, two-digit parts and offset. */
function isoDateTime(d: Date): string {
  const offset = Math.trunc(-d.getTimezoneOffset());
  const minutes = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${pad2(Math.trunc(minutes / 60))}:${pad2(minutes % 60)}`;
  return `${d.getFullYear()}-${cfDateTimeFormat(d, "mm-dd'T'HH:nn:ss")}${zone}`;
}

/** CFML trim (Java String.trim): strips units up to U+0020 from both ends. */
function cfTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/** Exact decimal of a positive finite double as digits / 10^scale. */
function exactDecimal(abs: number): { digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, abs);
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  const fraction = bits & 0xfffffffffffffn;
  const mantissa = biased === 0 ? fraction : fraction | 0x10000000000000n;
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  if (exponent >= 0) return { digits: mantissa << BigInt(exponent), scale: 0 };
  return { digits: mantissa * 5n ** BigInt(-exponent), scale: -exponent };
}

/** value / 10^drop rounded HALF_EVEN, DecimalFormat's default mode; a negative drop scales up. */
function roundHalfEven(value: bigint, drop: number): bigint {
  if (drop <= 0) return value * 10n ** BigInt(-drop);
  const divisor = 10n ** BigInt(drop);
  const quotient = value / divisor;
  const twice = (value % divisor) * 2n;
  return twice > divisor || (twice === divisor && quotient % 2n === 1n) ? quotient + 1n : quotient;
}

/** ACF Cast._String(double): the text trim() makes of a numeric query column (beanExtendable.cfc:239-241). */
function cfNumberText(v: number): string {
  if (!Number.isFinite(v)) throw new RangeError(`A legacy numeric column cannot hold ${v}`);
  if (Number.isInteger(v) && v > -1e12 && v < 1e12) return String(v);
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const { digits, scale } = exactDecimal(abs);
  if (abs >= 1e-4 && abs < 1e12) {
    // DecimalFormat("0.#") keeping 11 - floor(log10|v|) fraction digits, the exponent computed as Cast does.
    const fractionDigits = Math.max(0, 11 - Math.floor(0.4342944819032518 * Math.log(abs)));
    const text = roundHalfEven(digits, scale - fractionDigits).toString().padStart(fractionDigits + 1, '0');
    const fraction = text.slice(text.length - fractionDigits).replace(/0+$/, '');
    return `${sign}${text.slice(0, text.length - fractionDigits)}${fraction ? `.${fraction}` : ''}`;
  }
  // DecimalFormat("#.###########E000"): twelve significant digits; Cast inserts '+' before a positive exponent.
  const length = digits.toString().length;
  let exponent = length - 1 - scale;
  let significand = roundHalfEven(digits, length - 12).toString();
  if (significand.length > 12) {
    significand = significand.slice(0, -1);
    exponent += 1;
  }
  const kept = significand.replace(/0+$/, '');
  const mantissa = kept.length > 1 ? `${kept.charAt(0)}.${kept.slice(1)}` : kept;
  return `${sign}${mantissa}E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(3, '0')}`;
}

interface StructNode {
  readonly hash: number;
  readonly upper: string;
  readonly key: string;
  value: WddxValue;
}

/** String.hashCode of the upper-cased key (coldfusion.util.Key), spread as ConcurrentHashMap.spread does. */
function spreadHash(upper: string): number {
  let h = 0;
  for (let i = 0; i < upper.length; i++) h = (Math.imul(31, h) + upper.charCodeAt(i)) | 0;
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

// ACF iterates a struct in hash-bin order, not insertion order, and the order shifts with the key count, so it is computed.
/** coldfusion.runtime.Struct: a ConcurrentHashMap keyed by the upper-cased name, iterated bin by bin. */
class CfStruct {
  private bins: StructNode[][] = Array.from({ length: 16 }, () => []);
  private size = 0;
  private sizeCtl = 12;

  /** ConcurrentHashMap.putVal: an existing key keeps its casing and slot, a new one joins the tail of its bin. */
  put(key: string, value: WddxValue, overwrite = true): void {
    const upper = key.toUpperCase();
    const hash = spreadHash(upper);
    const bin = this.bins[hash & (this.bins.length - 1)] as StructNode[];
    const existing = bin.find((node) => node.upper === upper);
    if (existing) {
      if (overwrite) existing.value = value;
      return;
    }
    if (bin.length >= TREEIFY_THRESHOLD) throw new RangeError(`Struct key '${key}' would treeify its hash bin`);
    bin.push({ hash, upper, key, value });
    if (++this.size >= this.sizeCtl) this.transfer();
  }

  /** Entries in iteration order. */
  toWddx(): WddxStruct {
    return { entries: this.bins.flat().map((node) => [node.key, node.value] as const) };
  }

  /** ConcurrentHashMap.transfer: doubles the table; each bin's trailing run keeps its order and earlier nodes are prepended. */
  private transfer(): void {
    const n = this.bins.length;
    const next: StructNode[][] = Array.from({ length: n * 2 }, () => []);
    this.bins.forEach((bin, i) => {
      const first = bin[0];
      if (!first) return;
      let runBit = first.hash & n;
      let lastRun = 0;
      for (let j = 1; j < bin.length; j++) {
        const bit = (bin[j] as StructNode).hash & n;
        if (bit !== runBit) {
          runBit = bit;
          lastRun = j;
        }
      }
      const low = runBit === 0 ? bin.slice(lastRun) : [];
      const high = runBit === 0 ? [] : bin.slice(lastRun);
      for (const node of bin.slice(0, lastRun)) ((node.hash & n) === 0 ? low : high).unshift(node);
      next[i] = low;
      next[i + n] = high;
    });
    this.bins = next;
    this.sizeCtl = n * 2 - (n >>> 1);
  }
}

/** EXTENDSETID after getAllValues list-appends each new set id to the init '' (beanExtendable.cfc:292-296). */
function extendSetIds(ext: AddressExtendedData): string {
  if (ext.data.length === 0) return '';
  const ids: string[] = [];
  for (const id of ext.extendSetId.split(',')) if (id !== '' && !ids.includes(id)) ids.push(id);
  return ids.join(',');
}

/** The struct addressBean.getAllValues() returns at trashManager.cfc:227, entries in ACF iteration order. */
export function addressTrashValues(input: AddressTrashInput): WddxStruct {
  const { address: row, extendedData } = input;
  // bean.set(rs) trims every column through setValue, so stored values are strings (beanExtendable.cfc:239-241).
  const text = (v: string | null): string => cfTrim(v ?? '');
  // setIsPrimary/setLongitude/setLatitude ignore a NULL column's '', leaving the init literal 0.
  const numeric = (v: number | null): WddxValue => (v === null ? ZERO : cfNumberText(v));
  // First insertion of each key: bean.init, beanExtendable.init, addressBean.init (addressBean.cfc:107-131), then throwIn.
  const values: ReadonlyArray<readonly [string, WddxValue]> = [
    ['ISNEW', ZERO],
    ['ERRORS', { entries: [] }],
    ['FROMMURACACHE', false],
    ['INSTANCEID', input.instanceId],
    ['ADDOBJECTS', []],
    ['REMOVEOBJECTS', []],
    ['EXTENDDATA', ''],
    ['EXTENDSETID', extendSetIds(extendedData)],
    ['EXTENDDATATABLE', 'tclassextenddatauseractivity'],
    ['EXTENDAUTOCOMPLETE', true],
    ['TYPE', 'Address'],
    ['SUBTYPE', 'Default'],
    ['SITEID', text(row.siteID)],
    ['SOURCEITERATOR', ''],
    ['ADDRESSID', text(row.addressID)],
    ['USERID', text(row.userID)],
    ['ISPRIMARY', numeric(row.isPrimary)],
    ['ADDRESS1', text(row.address1)],
    ['ADDRESS2', text(row.address2)],
    ['FAX', text(row.fax)],
    ['CITY', text(row.city)],
    ['STATE', text(row.state)],
    ['ZIP', text(row.zip)],
    ['PHONE', text(row.phone)],
    ['COUNTRY', text(row.country)],
    ['ADDRESSNAME', text(row.addressName)],
    ['ADDRESSEMAIL', text(row.addressEmail)],
    ['ADDRESSNOTES', text(row.addressNotes)],
    ['ADDRESSURL', text(row.addressURL)],
    ['HOURS', text(row.hours)],
    ['LONGITUDE', numeric(row.longitude)],
    ['LATITUDE', numeric(row.latitude)],
    // setValue trims now() to its CFML string form (trashManager.cfc:179-189).
    ['muraDeleteDateTime', `{ts '${cfDateTimeFormat(input.deleteDateTime, 'yyyy-mm-dd HH:nn:ss')}'}`],
    ['muraDeleteID', input.deleteId],
  ];
  const struct = new CfStruct();
  for (const [key, value] of values) struct.put(key, value);
  if (extendedData.data.length > 0) {
    // structAppend(instance, extData.data, false) walks extData.data in its own struct order (beanExtendable.cfc:288-290).
    const data = new CfStruct();
    for (const [name, value] of extendedData.data) data.put(name, value);
    for (const [name, value] of data.toWddx().entries) struct.put(name, value, false);
  }
  return struct.toWddx();
}
