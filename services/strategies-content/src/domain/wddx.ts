// WDDX 1.0 packets byte for byte as ACF 2023 <cfwddx> writes and reads them: ttrash.objectString (trashManager.cfc:226),
// tformresponsepackets.Data (dataCollectionManager.cfc:181) and the data manager's wddx2cfml (dsp_edit.cfm:83, dsp_response.cfm:186).
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';

/** A CFML number, written as `text` inside <number> (ACF writes Java Double.toString: 1.0, 12.34, 1.2345678E7). */
export class WddxNumber {
  constructor(readonly text: string) {}
}

/** A CFML date-time, written to the second in the process time zone with its offset. */
export class WddxDate {
  constructor(readonly value: Date) {}
}

/** A CFML struct; cfml2wddx writes the entries in this order with the keys as given. */
export interface WddxStruct {
  readonly kind: 'struct';
  readonly entries: Array<[string, WddxValue]>;
}

/** A CFML query: column names in query order and one record per row keyed by column name. */
export interface WddxQuery {
  readonly kind: 'query';
  readonly columns: string[];
  readonly rows: Record<string, WddxValue>[];
}

/** A value cfml2wddx writes and wddx2cfml returns; null is a Java null (a query NULL cell), written <null/>. */
export type WddxValue = string | WddxNumber | boolean | WddxDate | WddxStruct | WddxValue[] | WddxQuery | null;

/** Struct whose entries are written in the given order. */
export function wddxStruct(entries: Array<[string, WddxValue]>): WddxStruct {
  return { kind: 'struct', entries };
}

/** Case-insensitive struct lookup as CFML resolves keys; undefined when the key is absent. */
export function wddxStructGet(s: WddxStruct, key: string): WddxValue | undefined {
  const upper = key.toUpperCase();
  return s.entries.find(([name]) => name.toUpperCase() === upper)?.[1];
}

// ACF iterates a struct in hash-bin order, not insertion order (captured), so packets need this order to match legacy bytes.
/** Struct as ACF iterates a structNew() given these assignments in order; a repeated key (any case) keeps its first casing and place. */
export function cfStruct(assignments: Iterable<readonly [string, WddxValue]>): WddxStruct {
  const table = new StructTable();
  for (const [key, value] of assignments) table.put(key, value);
  return wddxStruct(table.entries());
}

// Java 17 lengthens a few rare doubles beyond the shortest round-trip digits used here; a captured form goes in new WddxNumber(text).
/** A CFML numeric value as cfwddx writes it (Java Double.toString): 0 -> 0.0, 1.5 -> 1.5, 1e7 -> 1.0E7, 1e-4 -> 1.0E-4. */
export function wddxNumber(n: number): WddxNumber {
  if (!Number.isFinite(n)) return new WddxNumber(String(n));
  if (n === 0) return new WddxNumber(Object.is(n, -0) ? '-0.0' : '0.0');
  const abs = Math.abs(n);
  if (abs >= 1e-3 && abs < 1e7) {
    const plain = String(n);
    return new WddxNumber(plain.includes('.') ? plain : `${plain}.0`);
  }
  const [mantissa = '', exponent = '0'] = n.toExponential().split('e');
  return new WddxNumber(`${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`);
}

const PACKET_OPEN = "<wddxPacket version='1.0'><header/><data>";
const PACKET_CLOSE = '</data></wddxPacket>';
const RECORDSET_TYPE = 'coldfusion.sql.QueryTable';
const TEXT_ENTITIES = new Map([['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;']]);
const ATTRIBUTE_ENTITIES = new Map([...TEXT_ENTITIES, ["'", '&apos;'], ['"', '&quot;']]);

/** Serializes a value to the packet ACF's cfml2wddx produces, byte for byte. */
export function cfml2wddx(value: WddxValue): string {
  return PACKET_OPEN + element(value) + PACKET_CLOSE;
}

function element(v: WddxValue): string {
  if (v === null) return '<null/>';
  if (typeof v === 'string') return `<string>${escapeXml(v, TEXT_ENTITIES)}</string>`;
  if (typeof v === 'boolean') return `<boolean value='${v}'/>`;
  if (v instanceof WddxNumber) return `<number>${v.text}</number>`;
  if (v instanceof WddxDate) return `<dateTime>${isoDateTime(v.value)}</dateTime>`;
  if (Array.isArray(v)) return `<array length='${v.length}'>${v.map((item) => element(item)).join('')}</array>`;
  return v.kind === 'struct' ? struct(v) : recordset(v);
}

function struct(s: WddxStruct): string {
  let out = '<struct>';
  for (const [key, value] of s.entries) out += `<var name='${escapeXml(key, ATTRIBUTE_ENTITIES)}'>${element(value)}</var>`;
  return `${out}</struct>`;
}

function recordset(q: WddxQuery): string {
  // fieldNames is written verbatim while each field's name attribute is escaped (captured).
  let out = `<recordset rowCount='${q.rows.length}' fieldNames='${q.columns.join(',')}' type='${RECORDSET_TYPE}'>`;
  for (const column of q.columns) {
    out += `<field name='${escapeXml(column, ATTRIBUTE_ENTITIES)}'>`;
    for (const row of q.rows) {
      if (!Object.hasOwn(row, column)) throw new TypeError(`Query row has no '${column}' cell`);
      out += element(row[column] as WddxValue);
    }
    out += '</field>';
  }
  return `${out}</recordset>`;
}

/** ACF's UTF8Converter escaping: units below 0x20 as <char code='hh'/> (lowercase hex), the mapped characters as entities, all else as is. */
function escapeXml(s: string, entities: ReadonlyMap<string, string>): string {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const encoded = code < 0x20 ? `<char code='${code.toString(16).padStart(2, '0')}'/>` : entities.get(s.charAt(i));
    if (encoded === undefined) continue;
    out += s.slice(start, i) + encoded;
    start = i + 1;
  }
  return out + s.slice(start);
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** coldfusion.wddx.ISO8601 form: zero-padded parts, no milliseconds, offset ±hh:mm (captured: 2026-06-30T13:05:09+00:00). */
function isoDateTime(d: Date): string {
  const offset = Math.trunc(-d.getTimezoneOffset());
  const minutes = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${pad2(Math.trunc(minutes / 60))}:${pad2(minutes % 60)}`;
  return `${cfDateTimeFormat(d, "yyyy-mm-dd'T'HH:nn:ss")}${zone}`;
}

// java.util.concurrent.ConcurrentHashMap (Java 17) constants.
const INITIAL_CAPACITY = 16;
const TREEIFY_THRESHOLD = 8;
const UNTREEIFY_THRESHOLD = 6;
const MIN_TREEIFY_CAPACITY = 64;

interface StructNode {
  readonly hash: number;
  readonly upper: string;
  readonly key: string;
  value: WddxValue;
}

interface StructBin {
  nodes: StructNode[];
  tree: boolean;
}

const emptyBins = (n: number): StructBin[] => Array.from({ length: n }, () => ({ nodes: [], tree: false }));

/** String.hashCode of the upper-cased key (coldfusion.util.Key), spread as ConcurrentHashMap.spread does. */
function spread(upper: string): number {
  let h = 0;
  for (let i = 0; i < upper.length; i++) h = (Math.imul(31, h) + upper.charCodeAt(i)) | 0;
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

/** coldfusion.runtime.Struct: a ConcurrentHashMap keyed by the upper-cased name, iterated bin by bin in index order. */
class StructTable {
  private bins = emptyBins(INITIAL_CAPACITY);
  private size = 0;
  private sizeCtl = INITIAL_CAPACITY - (INITIAL_CAPACITY >>> 2);

  /** putVal: an existing key keeps its casing and slot; a new one joins the tail of a list bin or the head of a tree bin. */
  put(key: string, value: WddxValue): void {
    const upper = key.toUpperCase();
    const hash = spread(upper);
    const bin = this.bins[hash & (this.bins.length - 1)] as StructBin;
    const found = bin.nodes.findIndex((node) => node.upper === upper);
    if (found >= 0) {
      (bin.nodes[found] as StructNode).value = value;
      // putVal counts the list nodes it walked, so replacing the eighth or later one still calls treeifyBin.
      if (!bin.tree && found + 1 >= TREEIFY_THRESHOLD) this.treeify(bin);
      return;
    }
    const node: StructNode = { hash, upper, key, value };
    if (bin.tree) {
      bin.nodes.unshift(node);
    } else {
      bin.nodes.push(node);
      if (bin.nodes.length - 1 >= TREEIFY_THRESHOLD) this.treeify(bin);
    }
    if (++this.size >= this.sizeCtl) this.transfer();
  }

  /** Entries in iteration order. */
  entries(): Array<[string, WddxValue]> {
    return this.bins.flatMap((bin) => bin.nodes.map((node): [string, WddxValue] => [node.key, node.value]));
  }

  /** treeifyBin: below 64 bins tryPresize(n << 1) grows the table until sizeCtl reaches tableSizeFor(3n + 1); otherwise the bin becomes a TreeBin. */
  private treeify(bin: StructBin): void {
    const n = this.bins.length;
    if (n >= MIN_TREEIFY_CAPACITY) {
      bin.tree = true;
      return;
    }
    let target = 1;
    while (target < 3 * n + 1) target *= 2;
    while (target > this.sizeCtl) this.transfer();
  }

  /** transfer: doubles the table; a list bin keeps its trailing same-side run and prepends earlier nodes, a tree bin splits in order. */
  private transfer(): void {
    const n = this.bins.length;
    const next = emptyBins(n * 2);
    this.bins.forEach((bin, i) => {
      if (bin.nodes.length === 0) return;
      if (bin.tree) {
        const low = bin.nodes.filter((node) => (node.hash & n) === 0);
        const high = bin.nodes.filter((node) => (node.hash & n) !== 0);
        next[i] = { nodes: low, tree: low.length > UNTREEIFY_THRESHOLD };
        next[i + n] = { nodes: high, tree: high.length > UNTREEIFY_THRESHOLD };
        return;
      }
      let runBit = (bin.nodes[0] as StructNode).hash & n;
      let lastRun = 0;
      for (let j = 1; j < bin.nodes.length; j++) {
        const bit = (bin.nodes[j] as StructNode).hash & n;
        if (bit !== runBit) {
          runBit = bit;
          lastRun = j;
        }
      }
      const low = runBit === 0 ? bin.nodes.slice(lastRun) : [];
      const high = runBit === 0 ? [] : bin.nodes.slice(lastRun);
      for (const node of bin.nodes.slice(0, lastRun)) ((node.hash & n) === 0 ? low : high).unshift(node);
      next[i] = { nodes: low, tree: false };
      next[i + n] = { nodes: high, tree: false };
    });
    this.bins = next;
    this.sizeCtl = n * 2 - (n >>> 1);
  }
}

const START_TAG = /<([A-Za-z]+)((?:\s+[A-Za-z]+\s*=\s*(?:'[^'<]*'|"[^"<]*"))*)\s*(\/?)>/y;
const ATTRIBUTE = /([A-Za-z]+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
const CHAR = /<char\s+code\s*=\s*(?:'([0-9A-Fa-f]{1,2})'|"([0-9A-Fa-f]{1,2})")\s*\/>/y;
const ENTITY = /&(?:(amp|lt|gt|apos|quot)|#([0-9]+)|#x([0-9A-Fa-f]+));|&/g;
const NAMED_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['apos', "'"], ['quot', '"']]);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const COUNT = /^\d+$/;
const ISO_DATE_TIME = /^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})(?:([+-])(\d{1,2}):?(\d{2}))?$/;

/** Parses a packet as ACF's wddx2cfml reads it, struct keys in packet casing; malformed input throws Error('Invalid WDDX packet'). */
export function wddx2cfml(packet: string): WddxValue {
  return new PacketReader(packet).packet();
}

interface StartTag {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly empty: boolean;
}

function invalidPacket(): never {
  throw new Error('Invalid WDDX packet');
}

/** XML character data: the five named entities and numeric references; a bare & is malformed, as in ACF's parser. */
function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(ENTITY, (_match: string, named?: string, decimal?: string, hex?: string) => {
    if (named !== undefined) return NAMED_ENTITIES.get(named) as string;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : hex !== undefined ? Number.parseInt(hex, 16) : Number.NaN;
    return code <= 0x10ffff ? String.fromCodePoint(code) : invalidPacket();
  });
}

/** ISO 8601 as ACF reads it: unpadded and out-of-range fields roll over (2026-13-40 is 2027-02-09); no offset means local time. */
function parseDateTime(text: string): Date {
  const m = ISO_DATE_TIME.exec(text.trim()) ?? invalidPacket();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const at = new Date(0);
  if (m[7] === undefined) {
    at.setFullYear(year, month - 1, day);
    at.setHours(hour, minute, second, 0);
    return at;
  }
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  const offsetMinutes = (Number(m[8]) * 60 + Number(m[9])) * (m[7] === '-' ? -1 : 1);
  return new Date(at.getTime() - offsetMinutes * 60_000);
}

/** Recursive-descent reader for the elements cfwddx writes; whitespace between elements is ignored, as ACF ignores it. */
class PacketReader {
  private pos = 0;

  constructor(private readonly src: string) {}

  packet(): WddxValue {
    this.expect(this.startTag(), 'wddxPacket', false);
    if (!this.expect(this.startTag(), 'header').empty) this.skipPast('</header>');
    this.expect(this.startTag(), 'data', false);
    // ACF keeps the last of several values inside <data> (captured).
    let value = this.value();
    while (!this.closes('data')) value = this.value();
    this.close('wddxPacket');
    this.skipSpace();
    if (this.pos !== this.src.length) invalidPacket();
    return value;
  }

  private value(): WddxValue {
    const tag = this.startTag();
    switch (tag.name) {
      case 'null':
        this.endEmpty(tag);
        return null;
      case 'boolean': {
        const flag = this.attribute(tag, 'value');
        this.endEmpty(tag);
        // ACF rejects yes/no and upper-case forms (captured).
        if (flag !== 'true' && flag !== 'false') invalidPacket();
        return flag === 'true';
      }
      case 'string':
        return tag.empty ? '' : this.stringContent();
      case 'number': {
        const text = this.text(tag).trim();
        return NUMBER.test(text) ? new WddxNumber(text) : invalidPacket();
      }
      case 'dateTime':
        return new WddxDate(parseDateTime(this.text(tag)));
      case 'array':
        // ACF does not check the length attribute against the items (captured).
        return this.children(tag, () => this.value());
      case 'struct':
        return wddxStruct(this.children(tag, () => this.member()));
      case 'recordset':
        return this.recordset(tag);
      default:
        return invalidPacket();
    }
  }

  private member(): [string, WddxValue] {
    const tag = this.expect(this.startTag(), 'var', false);
    const entry: [string, WddxValue] = [this.attribute(tag, 'name'), this.value()];
    this.close('var');
    return entry;
  }

  private recordset(tag: StartTag): WddxQuery {
    const count = this.attribute(tag, 'rowCount');
    if (!COUNT.test(count)) invalidPacket();
    const declared = this.attribute(tag, 'fieldNames');
    const columns = declared === '' ? [] : declared.split(',');
    const fields = this.children(tag, () => {
      const field = this.expect(this.startTag(), 'field');
      return [this.attribute(field, 'name').toUpperCase(), this.children(field, () => this.value())] as const;
    });
    // Each declared column needs a field and each field a declared column, matched case-insensitively (captured).
    if (fields.length !== columns.length) invalidPacket();
    const cells = columns.map((column) => (fields.find(([name]) => name === column.toUpperCase()) ?? invalidPacket())[1]);
    // A field shorter than rowCount reads as NULL cells (captured).
    const rows = Array.from({ length: Number(count) }, (_, r) =>
      Object.fromEntries(columns.map((column, c): [string, WddxValue] => [column, cells[c]?.[r] ?? null])),
    );
    return { kind: 'query', columns, rows };
  }

  private stringContent(): string {
    let out = '';
    for (;;) {
      const lt = this.src.indexOf('<', this.pos);
      if (lt < 0) invalidPacket();
      out += decodeEntities(this.src.slice(this.pos, lt));
      this.pos = lt;
      if (this.consume('</string>')) return out;
      CHAR.lastIndex = lt;
      const m = CHAR.exec(this.src) ?? invalidPacket();
      out += String.fromCharCode(Number.parseInt(m[1] ?? m[2] ?? '', 16));
      this.pos = CHAR.lastIndex;
    }
  }

  /** Character data of a leaf element up to its end tag. */
  private text(tag: StartTag): string {
    if (tag.empty) return '';
    const lt = this.src.indexOf('<', this.pos);
    if (lt < 0) invalidPacket();
    const raw = this.src.slice(this.pos, lt);
    this.pos = lt;
    this.close(tag.name);
    return decodeEntities(raw);
  }

  private children<T>(tag: StartTag, read: () => T): T[] {
    const items: T[] = [];
    if (!tag.empty) while (!this.closes(tag.name)) items.push(read());
    return items;
  }

  private startTag(): StartTag {
    this.skipSpace();
    START_TAG.lastIndex = this.pos;
    const m = START_TAG.exec(this.src) ?? invalidPacket();
    this.pos = START_TAG.lastIndex;
    const attributes = new Map<string, string>();
    for (const a of (m[2] ?? '').matchAll(ATTRIBUTE)) attributes.set(a[1] ?? '', decodeEntities(a[2] ?? a[3] ?? ''));
    return { name: m[1] ?? '', attributes, empty: m[3] === '/' };
  }

  private expect(tag: StartTag, name: string, empty?: boolean): StartTag {
    if (tag.name !== name || (empty !== undefined && tag.empty !== empty)) invalidPacket();
    return tag;
  }

  private attribute(tag: StartTag, name: string): string {
    return tag.attributes.get(name) ?? invalidPacket();
  }

  private endEmpty(tag: StartTag): void {
    if (!tag.empty) this.close(tag.name);
  }

  private closes(name: string): boolean {
    this.skipSpace();
    return this.consume(`</${name}>`);
  }

  private close(name: string): void {
    if (!this.closes(name)) invalidPacket();
  }

  private consume(literal: string): boolean {
    if (!this.src.startsWith(literal, this.pos)) return false;
    this.pos += literal.length;
    return true;
  }

  private skipPast(literal: string): void {
    const at = this.src.indexOf(literal, this.pos);
    if (at < 0) invalidPacket();
    this.pos = at + literal.length;
  }

  private skipSpace(): void {
    while (this.pos < this.src.length && ' \t\r\n'.includes(this.src.charAt(this.pos))) this.pos++;
  }
}
