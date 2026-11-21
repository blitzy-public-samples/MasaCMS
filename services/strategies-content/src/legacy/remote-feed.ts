/**
 * Remote feed reader for feed imports: feedManager.doAutoImport, cfeed.import1 and cfeed.import2
 * (feedUtility.cfc:89-295, cfeed/import1.cfm:106-151). Parsing reproduces Masa's parseXML on ACF 2023,
 * xmlParse(text, false, {allowExternalEntities: false}) (backport/acf.cfm:6-8): namespace-aware, DOCTYPE refused,
 * case-insensitive child lookup. No I/O: the caller fetches the feed URL and passes the response text.
 */
import { cfHash, cfListToArray } from '@opt2/platform/legacy-compat';

/** Options of prepareRemoteFeedText. */
export interface PrepareRemoteFeedTextOptions {
  /** Remove every chr(20) first, as getRemoteFeedData does (feedUtility.cfc:257); cfeed.import1 does not. */
  stripChr20?: boolean;
}

/** Feed text as legacy hands it to parseXML: chr(20) optionally removed, then all text before the first `<` (feedUtility.cfc:257-258, import1.cfm:107). */
export function prepareRemoteFeedText(raw: string, options: PrepareRemoteFeedTextOptions = {}): string {
  const text = options.stripChr20 ? raw.replaceAll('\u0014', '') : raw;
  return text.replace(/^[^<]*/, '');
}

/** Malformed feed XML: parseXML throws, so the import of that feed fails. */
export class XmlParseError extends Error {
  /**
   * @param position Offset in the line-end-normalised text.
   * @param namespaceError Namespace-constraint failure, which CFML isXML still accepts (feedUtility.cfc:260).
   */
  constructor(
    message: string,
    readonly position: number,
    readonly namespaceError = false,
  ) {
    super(`${message} (offset ${position})`);
    this.name = 'XmlParseError';
  }
}

/** CFML "Element X is undefined" for a child legacy dereferences that the feed lacks, for example an item without pubDate. */
export class XmlElementUndefinedError extends Error {
  constructor(
    readonly element: string,
    parent: string,
  ) {
    super(`Element ${element.toUpperCase()} is undefined in ${parent}.`);
    this.name = 'XmlElementUndefinedError';
  }
}

/** Parsed element with the CFML XML object surface legacy reads: xmlName, xmlAttributes, xmlChildren and xmlText. */
export class XmlElement {
  /**
   * @param name Qualified name as written (xmlName).
   * @param localName Name without its prefix.
   * @param attributes Decoded, whitespace-normalised attribute values, namespace declarations included (xmlAttributes).
   * @param elements Child elements in document order (xmlChildren).
   * @param text Direct text, reference and CDATA pieces in document order.
   */
  constructor(
    readonly name: string,
    readonly localName: string,
    readonly attributes: Readonly<Record<string, string>>,
    readonly elements: readonly XmlElement[],
    private readonly text: readonly string[],
  ) {}

  /** Direct text and CDATA children concatenated, decoded and untrimmed; descendants' text is excluded. */
  get xmlText(): string {
    return this.text.join('');
  }

  /** CFML key match: the qualified or the local name, ignoring case (xmlParse with caseSensitive=false). */
  is(name: string): boolean {
    const key = name.toLowerCase();
    return this.name.toLowerCase() === key || this.localName.toLowerCase() === key;
  }

  /** Every child element `element[name]` addresses, in document order. */
  children(name: string): XmlElement[] {
    return this.elements.filter((element) => element.is(name));
  }

  /** structKeyExists(element, name). */
  has(name: string): boolean {
    return this.elements.some((element) => element.is(name));
  }

  /** `element.name`: the first matching child; throws XmlElementUndefinedError when there is none. */
  child(name: string): XmlElement {
    const found = this.elements.find((element) => element.is(name));
    if (found === undefined) throw new XmlElementUndefinedError(name, this.name);
    return found;
  }
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const NCNAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F' +
  '\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NCNAME_CHAR = `${NCNAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040`;
const NAME_PATTERN = `[:${NCNAME_START}][:${NCNAME_CHAR}]*`;
const NCNAME_PATTERN = `[${NCNAME_START}][${NCNAME_CHAR}]*`;
const NAME = new RegExp(NAME_PATTERN, 'uy');
const QNAME = new RegExp(`^(?:(${NCNAME_PATTERN}):)?(${NCNAME_PATTERN})$`, 'u');
const REFERENCE = new RegExp(`&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(${NAME_PATTERN}));`, 'uy');
const INVALID_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const SPACE = /[ \t\n]+/y;
const CHAR_DATA = /[^<&]+/y;
const ATTRIBUTE_CHARS: Readonly<Record<'"' | "'", RegExp>> = { '"': /[^"<&]*/y, "'": /[^'<&]*/y };
const XML_DECL_START = /^<\?xml[ \t\n]/;
const XML_DECL =
  /<\?xml[ \t\n]+version[ \t\n]*=[ \t\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(?:"[A-Za-z][\w.-]*"|'[A-Za-z][\w.-]*'))?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\n]*\?>/y;
const PREDEFINED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['apos', "'"],
  ['quot', '"'],
]);

type NamespaceScope = ReadonlyMap<string, string>;

/** An open element while its content is read. */
interface Frame {
  element: XmlElement;
  elements: XmlElement[];
  text: string[];
  scope: NamespaceScope;
  closed: boolean;
}

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Single-pass XML 1.0 + Namespaces reader over line-end-normalised text. */
class FeedXmlParser {
  private pos = 0;

  constructor(private readonly s: string) {}

  document(): XmlElement {
    if (XML_DECL_START.test(this.s)) {
      XML_DECL.lastIndex = 0;
      if (!XML_DECL.test(this.s)) this.fail('Malformed XML declaration');
      this.pos = XML_DECL.lastIndex;
    }
    this.misc();
    // allowExternalEntities=false makes ACF refuse every DOCTYPE, internal subset or not.
    if (this.s.startsWith('<!DOCTYPE', this.pos)) this.fail('DOCTYPE is disallowed');
    if (this.pos >= this.s.length) this.fail('Premature end of file');
    if (this.s[this.pos] !== '<') this.fail('Content is not allowed in prolog');
    const root = this.elementTree();
    this.misc();
    if (this.pos < this.s.length) this.fail('Content is not allowed in trailing section');
    return root;
  }

  private elementTree(): XmlElement {
    const root = this.startTag(new Map([['xml', XML_NS]]));
    const stack = root.closed ? [] : [root];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as Frame;
      const s = this.s;
      const pos = this.pos;
      if (pos >= s.length) this.fail(`The element type "${top.element.name}" must be terminated`);
      if (s[pos] === '<') {
        if (s.startsWith('</', pos)) {
          this.endTag(top.element.name);
          stack.pop();
        } else if (s.startsWith('<!--', pos)) this.comment();
        else if (s.startsWith('<![CDATA[', pos)) top.text.push(this.cdata());
        else if (s.startsWith('<?', pos)) this.pi();
        else {
          const child = this.startTag(top.scope);
          top.elements.push(child.element);
          if (!child.closed) stack.push(child);
        }
      } else if (s[pos] === '&') top.text.push(this.reference());
      else top.text.push(this.charData());
    }
    return root.element;
  }

  private startTag(parentScope: NamespaceScope): Frame {
    this.pos += 1;
    const name = this.name('Element name expected');
    const attributes: [string, string][] = [];
    const seen = new Set<string>();
    let closed = false;
    for (;;) {
      const spaced = this.skipSpace();
      if (this.s.startsWith('/>', this.pos)) {
        this.pos += 2;
        closed = true;
        break;
      }
      if (this.s[this.pos] === '>') {
        this.pos += 1;
        break;
      }
      if (!spaced) this.fail(`Element type "${name}" must be followed by attribute specifications, ">" or "/>"`);
      const attribute = this.name('Attribute name expected');
      if (seen.has(attribute)) this.fail(`Attribute "${attribute}" was already specified for element "${name}"`);
      seen.add(attribute);
      this.skipSpace();
      if (this.s[this.pos] !== '=') this.fail(`Attribute name "${attribute}" must be followed by the "=" character`);
      this.pos += 1;
      this.skipSpace();
      attributes.push([attribute, this.attributeValue()]);
    }
    const scope = this.declareNamespaces(parentScope, attributes);
    const [prefix, localName] = this.qname(name);
    if (prefix === 'xmlns') this.namespaceFail(`Element "${name}" cannot have "xmlns" as its prefix`);
    if (prefix !== undefined && !scope.has(prefix)) this.namespaceFail(`The prefix "${prefix}" for element "${name}" is not bound`);
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    const expanded = new Set<string>();
    for (const [attribute, value] of attributes) {
      values[attribute] = value;
      const [attributePrefix, attributeLocal] = this.qname(attribute);
      if (attributePrefix === undefined || attributePrefix === 'xmlns') continue;
      const uri = scope.get(attributePrefix);
      if (uri === undefined) this.namespaceFail(`The prefix "${attributePrefix}" for attribute "${attribute}" is not bound`);
      const key = `${uri}\u0000${attributeLocal}`;
      if (expanded.has(key)) this.namespaceFail(`Attribute "${attributeLocal}" bound to namespace "${uri}" was already specified`);
      expanded.add(key);
    }
    const elements: XmlElement[] = [];
    const text: string[] = [];
    return { element: new XmlElement(name, localName, values, elements, text), elements, text, scope, closed };
  }

  private declareNamespaces(parent: NamespaceScope, attributes: readonly [string, string][]): NamespaceScope {
    let scope = parent;
    for (const [attribute, uri] of attributes) {
      const prefix = attribute === 'xmlns' ? '' : attribute.startsWith('xmlns:') ? attribute.slice(6) : undefined;
      if (prefix === undefined) continue;
      if (prefix !== '' && (uri === '' || prefix === 'xmlns' || (prefix === 'xml') !== (uri === XML_NS))) {
        this.namespaceFail(`Invalid namespace declaration "${attribute}"`);
      }
      if (scope === parent) scope = new Map(parent);
      (scope as Map<string, string>).set(prefix, uri);
    }
    return scope;
  }

  private qname(name: string): [prefix: string | undefined, localName: string] {
    const match = QNAME.exec(name);
    if (match === null) this.namespaceFail(`"${name}" is not a valid qualified name`);
    return [match[1], match[2] as string];
  }

  private attributeValue(): string {
    const quote = this.s[this.pos];
    if (quote !== '"' && quote !== "'") this.fail('Open quote is expected for attribute value');
    this.pos += 1;
    const plain = ATTRIBUTE_CHARS[quote];
    let value = '';
    for (;;) {
      plain.lastIndex = this.pos;
      value += (plain.exec(this.s) as RegExpExecArray)[0].replace(/[\t\n]/g, ' ');
      this.pos = plain.lastIndex;
      const next = this.s[this.pos];
      if (next === quote) {
        this.pos += 1;
        return value;
      }
      if (next !== '&') {
        this.fail(next === '<' ? 'The value of an attribute must not contain the "<" character' : 'Attribute value is not terminated');
      }
      value += this.reference();
    }
  }

  private reference(): string {
    REFERENCE.lastIndex = this.pos;
    const match = REFERENCE.exec(this.s);
    if (match === null) this.fail('The entity reference must be a predefined entity or a character reference ending in ";"');
    this.pos = REFERENCE.lastIndex;
    const [reference, hex, decimal, entity] = match;
    if (entity !== undefined) {
      const value = PREDEFINED_ENTITIES.get(entity);
      if (value === undefined) this.fail(`The entity "${entity}" was referenced, but not declared`);
      return value;
    }
    const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal as string, 10);
    if (!isXmlChar(code)) this.fail(`Character reference "${reference}" is an invalid XML character`);
    return String.fromCodePoint(code);
  }

  private charData(): string {
    CHAR_DATA.lastIndex = this.pos;
    const text = (CHAR_DATA.exec(this.s) as RegExpExecArray)[0];
    const terminator = text.indexOf(']]>');
    if (terminator >= 0) {
      this.pos += terminator;
      this.fail('The character sequence "]]>" must not appear in content unless used to mark the end of a CDATA section');
    }
    this.pos = CHAR_DATA.lastIndex;
    return text;
  }

  private cdata(): string {
    const start = this.pos + '<![CDATA['.length;
    const end = this.s.indexOf(']]>', start);
    if (end < 0) this.fail('The CDATA section must end with "]]>"');
    this.pos = end + 3;
    return this.s.slice(start, end);
  }

  private comment(): void {
    const end = this.s.indexOf('--', this.pos + 4);
    if (end < 0) this.fail('The comment is not terminated');
    if (this.s[end + 2] !== '>') {
      this.pos = end;
      this.fail('The string "--" is not permitted within comments');
    }
    this.pos = end + 3;
  }

  private pi(): void {
    this.pos += 2;
    const target = this.name('Processing instruction target expected');
    if (target.toLowerCase() === 'xml') this.fail('The processing instruction target matching "[xX][mM][lL]" is not allowed');
    if (this.s.startsWith('?>', this.pos)) {
      this.pos += 2;
      return;
    }
    if (!this.skipSpace()) this.fail('White space is required between the processing instruction target and data');
    const end = this.s.indexOf('?>', this.pos);
    if (end < 0) this.fail('The processing instruction is not terminated');
    this.pos = end + 2;
  }

  private endTag(expected: string): void {
    this.pos += 2;
    const name = this.name('End tag name expected');
    if (name !== expected) this.fail(`The element type "${expected}" must be terminated by the matching end-tag "</${expected}>"`);
    this.skipSpace();
    if (this.s[this.pos] !== '>') this.fail(`The end-tag for element type "${expected}" must end with a ">" delimiter`);
    this.pos += 1;
  }

  /** Everything allowed around the document element: white space, comments and processing instructions. */
  private misc(): void {
    for (;;) {
      this.skipSpace();
      if (this.s.startsWith('<!--', this.pos)) this.comment();
      else if (this.s.startsWith('<?', this.pos)) this.pi();
      else return;
    }
  }

  private name(expected: string): string {
    NAME.lastIndex = this.pos;
    const match = NAME.exec(this.s);
    if (match === null) this.fail(expected);
    this.pos = NAME.lastIndex;
    return match[0];
  }

  private skipSpace(): boolean {
    SPACE.lastIndex = this.pos;
    if (!SPACE.test(this.s)) return false;
    this.pos = SPACE.lastIndex;
    return true;
  }

  private fail(message: string): never {
    throw new XmlParseError(message, this.pos);
  }

  private namespaceFail(message: string): never {
    throw new XmlParseError(message, this.pos, true);
  }
}

/** Parses feed text as Masa's parseXML does and returns the document element (backport/acf.cfm:6-8); throws XmlParseError when malformed. */
export function parseFeedXml(text: string): XmlElement {
  const normalised = text.replace(/\r\n?/g, '\n');
  const invalid = INVALID_CHAR.exec(normalised);
  if (invalid !== null) {
    const code = (invalid[0].codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
    throw new XmlParseError(`An invalid XML character (Unicode: 0x${code}) was found`, invalid.index);
  }
  return new FeedXmlParser(normalised).document();
}

/** Wall-clock fields of a parsed date; month is zero-based. */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

/** A java.util.TimeZone ID: an IANA zone, or a fixed offset in minutes for Java's EST, MST and HST. */
type JavaZone = string | number;

// Three-letter java.util.TimeZone IDs ACF resolves case-insensitively, mapped as Java maps them. IDs beginning with
// A or P are absent because ACF reads that letter as an AM/PM marker first (observed: PST adds 12 hours, AEST is A + EST).
const JAVA_ZONES = new Map<string, JavaZone>([
  ['GMT', 'UTC'],
  ['UTC', 'UTC'],
  ['UCT', 'UTC'],
  ['EST', -300],
  ['MST', -420],
  ['HST', -600],
  ['CST', 'America/Chicago'],
  ['IET', 'America/Indiana/Indianapolis'],
  ['BET', 'America/Sao_Paulo'],
  ['CNT', 'America/St_Johns'],
  ['WET', 'WET'],
  ['CET', 'CET'],
  ['MET', 'MET'],
  ['EET', 'EET'],
  ['ECT', 'Europe/Paris'],
  ['CAT', 'Africa/Harare'],
  ['EAT', 'Africa/Addis_Ababa'],
  ['NET', 'Asia/Yerevan'],
  ['IST', 'Asia/Kolkata'],
  ['BST', 'Asia/Dhaka'],
  ['VST', 'Asia/Ho_Chi_Minh'],
  ['CTT', 'Asia/Shanghai'],
  ['JST', 'Asia/Tokyo'],
  ['SST', 'Pacific/Guadalcanal'],
  ['NST', 'Pacific/Auckland'],
  ['MIT', 'Pacific/Apia'],
]);

const MONTHS = new Map<string, number>(
  [
    ['january', 'jan'],
    ['february', 'feb'],
    ['march', 'mar'],
    ['april', 'apr'],
    ['may', 'may'],
    ['june', 'jun'],
    ['july', 'jul'],
    ['august', 'aug'],
    ['september', 'sep'],
    ['october', 'oct'],
    ['november', 'nov'],
    ['december', 'dec'],
  ].flatMap(([full, short], index) => [
    [full as string, index],
    [short as string, index],
  ]),
).set('sept', 8);

const WEEKDAY = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)(?:\\s*,\\s*|\\s+)';
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\\.?';
const TIME = '(\\d{1,3})(?:[:.](\\d{1,2})(?:[:.](\\d{1,2})(?:\\.(\\d+))?)?)?';
const TAIL = '((?:\\s+\\S+)*)';
const DATE_TIME_SEPARATOR = '(?:\\s*,\\s*|\\s+|t)';
const DAY_MONTH_YEAR = new RegExp(
  `^(${WEEKDAY})?(\\d{1,3})[\\s/-]+${MONTH}[\\s/-]+(\\d{1,5})(?:${DATE_TIME_SEPARATOR}${TIME}${TAIL})?$`,
  'i',
);
const MONTH_DAY_YEAR = new RegExp(
  `^(${WEEKDAY})?${MONTH}\\s+(\\d{1,2})(?:\\s*,\\s*|\\s+)(\\d{1,5})(?:${DATE_TIME_SEPARATOR}${TIME}${TAIL})?$`,
  'i',
);
const MONTH_YEAR = new RegExp(`^${MONTH}\\s+(\\d{4})$`, 'i');
const ISO_DATE = new RegExp(
  `^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})(?:[t\\s]+${TIME}(z|[+-]\\d{1,2}(?::\\d{2})?)?${TAIL})?$`,
  'i',
);
const US_DATE = new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{1,5})(?:\\s+${TIME}${TAIL})?$`, 'i');
// Time-only values take colon separators: a bare number such as 12.5 is not a date.
const TIME_ONLY = new RegExp(`^(\\d{1,3})(?::(\\d{1,2})(?::(\\d{1,2})(?:\\.(\\d+))?)?)?${TAIL}$`, 'i');
const ODBC_TIMESTAMP = /^\{ts\s*'(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})'\}$/i;
const NUMERIC_OFFSET = /^(?:GMT)?([+-])(\d+)(?::(\d{2}))?$/;

/** Time-zone and meridiem tokens after the time, as ACF reads them. */
interface ZoneReading {
  meridiem?: 'A' | 'P';
  offsetMinutes?: number;
  zone?: JavaZone;
  unknown: boolean;
}

function javaZone(token: string): JavaZone | undefined {
  return JAVA_ZONES.get(token) ?? JAVA_ZONES.get(/^[A-Z]+/.exec(token)?.[0] ?? '');
}

function readZoneTokens(tokens: readonly string[]): ZoneReading {
  const reading: ZoneReading = { unknown: false };
  for (const raw of tokens) {
    const token = raw.toUpperCase();
    const numeric = NUMERIC_OFFSET.exec(token);
    const hours = numeric ? Number(numeric[2]) : Number.NaN;
    const minutes = numeric?.[3] ? Number(numeric[3]) : 0;
    if (token === 'AM' || token === 'A' || token === 'PM' || token === 'P') reading.meridiem = token[0] as 'A' | 'P';
    else if (token === 'GMT' || token === 'Z') reading.offsetMinutes ??= 0;
    // The digits after the sign are read as hours, so +0000 is UTC and -0500 is no offset at all.
    else if (numeric && hours <= 23 && minutes <= 59) {
      reading.offsetMinutes ??= (numeric[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
    } else if (token[0] === 'A' || token[0] === 'P') {
      reading.meridiem = token[0];
      const zone = javaZone(token.slice(1));
      if (zone === undefined) reading.unknown = true;
      else reading.zone ??= zone;
    } else {
      const zone = javaZone(token);
      if (zone === undefined) reading.unknown = true;
      else reading.zone ??= zone;
    }
  }
  return reading;
}

function utcMillis(w: WallClock): number {
  const date = new Date(0);
  date.setUTCFullYear(w.year, w.month, w.day);
  date.setUTCHours(w.hour, w.minute, w.second, w.ms);
  return date.getTime();
}

function zoneOffsetMillis(timeZone: string, instant: number): number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(format.formatToParts(instant).find((p) => p.type === type)?.value);
  const wall = { year: part('year'), month: part('month') - 1, day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second'), ms: 0 };
  return utcMillis(wall) - Math.floor(instant / 1000) * 1000;
}

/** Instant of a wall-clock time in a Java zone, resolved like java.util.Calendar. */
function zoneInstant(w: WallClock, zone: JavaZone): number {
  const asUtc = utcMillis(w);
  if (typeof zone === 'number') return asUtc - zone * 60_000;
  const first = asUtc - zoneOffsetMillis(zone, asUtc);
  return asUtc - zoneOffsetMillis(zone, first);
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month + 1, 0);
  return date.getUTCDate();
}

/** CFML two-digit year rule: values below 100 fall in 1930-2029 (observed: 29 is 2029, 30 is 1930, 0003 is 2003). */
function fullYear(year: number): number {
  return year >= 100 ? year : year + (year < 30 ? 2000 : 1900);
}

/**
 * Resolves parsed fields to a Date, or undefined when ACF isDate would be false.
 * @param lenient A leading weekday makes ACF skip zone tokens it does not know; otherwise they reject the date.
 * @param now Clock whose milliseconds ACF leaks into dates it converts through a java.util.TimeZone.
 */
function resolveDate(
  w: WallClock,
  timeGiven: boolean,
  minutesGiven: boolean,
  tokens: readonly string[],
  lenient: boolean,
  now: Date,
): Date | undefined {
  if (timeGiven && !minutesGiven && tokens.length === 0) return undefined;
  if (w.month < 0 || w.month > 11 || w.day < 1 || w.day > daysInMonth(w.year, w.month)) return undefined;
  if (w.hour > 23 || w.minute > 59 || w.second > 59) return undefined;
  const reading = readZoneTokens(tokens);
  if (reading.unknown && !lenient) return undefined;
  const hour = reading.meridiem === 'P' && w.hour < 12 ? w.hour + 12 : reading.meridiem === 'A' && w.hour === 12 ? 0 : w.hour;
  const wall = { ...w, hour };
  if (reading.zone !== undefined) return new Date(zoneInstant({ ...wall, ms: now.getMilliseconds() }, reading.zone));
  if (reading.offsetMinutes !== undefined) return new Date(utcMillis(wall) - reading.offsetMinutes * 60_000);
  const local = new Date(0);
  local.setFullYear(wall.year, wall.month, wall.day);
  local.setHours(wall.hour, wall.minute, wall.second, wall.ms);
  return local;
}

function timeFields(hour?: string, minute?: string, second?: string, fraction?: string): Omit<WallClock, 'year' | 'month' | 'day'> {
  return {
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
    second: Number(second ?? 0),
    ms: fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0')),
  };
}

function tailTokens(tail: string | undefined): string[] {
  return (tail ?? '').split(/\s+/).filter((token) => token !== '');
}

/**
 * CFML isDate(text) and parseDateTime(text) as ACF 2023 evaluates them for feed dates (feedUtility.cfc:160-161):
 * RFC 822 with or without weekday, month-name, ISO 8601, US numeric, ODBC and time-only forms. Zone-free and
 * ignored-zone values keep their wall clock in the process time zone, which is the legacy server's; explicit offsets
 * and GMT convert to it. Returns undefined when isDate is false.
 */
export function cfParseDateTime(text: string, now: Date = new Date()): Date | undefined {
  const s = text.trim();
  let m: RegExpExecArray | null;
  if ((m = ODBC_TIMESTAMP.exec(s))) {
    const [, year, month, day, hour, minute, second] = m;
    const w = { year: Number(year), month: Number(month) - 1, day: Number(day), ...timeFields(hour, minute, second) };
    return resolveDate(w, true, true, [], false, now);
  }
  if ((m = DAY_MONTH_YEAR.exec(s))) {
    const [, weekday, day, month, year, hour, minute, second, fraction, tail] = m;
    const w = { year: fullYear(Number(year)), month: MONTHS.get((month as string).toLowerCase()) as number, day: Number(day), ...timeFields(hour, minute, second, fraction) };
    return resolveDate(w, hour !== undefined, minute !== undefined, tailTokens(tail), weekday !== undefined, now);
  }
  if ((m = MONTH_DAY_YEAR.exec(s))) {
    const [, weekday, month, day, year, hour, minute, second, fraction, tail] = m;
    const w = { year: fullYear(Number(year)), month: MONTHS.get((month as string).toLowerCase()) as number, day: Number(day), ...timeFields(hour, minute, second, fraction) };
    return resolveDate(w, hour !== undefined, minute !== undefined, tailTokens(tail), weekday !== undefined, now);
  }
  if ((m = MONTH_YEAR.exec(s))) {
    const w = { year: Number(m[2]), month: MONTHS.get((m[1] as string).toLowerCase()) as number, day: 1, ...timeFields() };
    return resolveDate(w, false, false, [], false, now);
  }
  if ((m = ISO_DATE.exec(s))) {
    const [, year, month, day, hour, minute, second, fraction, zone, tail] = m;
    const tokens = [...(zone === undefined ? [] : [zone]), ...tailTokens(tail)];
    const w = { year: Number(year), month: Number(month) - 1, day: Number(day), ...timeFields(hour, minute, second, fraction) };
    return resolveDate(w, hour !== undefined, minute !== undefined, tokens, false, now);
  }
  if ((m = US_DATE.exec(s))) {
    const [, month, day, year, hour, minute, second, fraction, tail] = m;
    const w = { year: fullYear(Number(year)), month: Number(month) - 1, day: Number(day), ...timeFields(hour, minute, second, fraction) };
    return resolveDate(w, hour !== undefined, minute !== undefined, tailTokens(tail), false, now);
  }
  if ((m = TIME_ONLY.exec(s))) {
    const [, hour, minute, second, fraction, tail] = m;
    // CFML time-only values fall on its zero date, 1899-12-30.
    const w = { year: 1899, month: 11, day: 30, ...timeFields(hour, minute, second, fraction) };
    return resolveDate(w, true, minute !== undefined, tailTokens(tail), false, now);
  }
  return undefined;
}

/** Feed formats getRemoteFeedData tells apart by document element (feedUtility.cfc:262-286). */
export type RemoteFeedType = 'rss' | 'rdf' | 'atom';

/** getRemoteFeedData's response struct (feedUtility.cfc:238-294). */
export interface RemoteFeed {
  /** Parsed document element; absent when the text is not XML. */
  xml?: XmlElement;
  /** Absent when the document element is none of rss, rdf:RDF or feed. */
  type?: RemoteFeedType;
  channelTitle?: string;
  /** rss channel items or Atom entries (itemArray). */
  items: readonly XmlElement[];
  /** min(item count, configured maxItems); 0 when the text is not XML. */
  maxItems: number;
}

/** A feed legacy fails to read for a reason other than malformed XML. */
export class RemoteFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFeedError';
  }
}

// ACF 2023 rejects the XPath "//:channel" (feedUtility.cfc:272), so legacy throws for every RDF feed; reproduced, not fixed.
const RDF_XMLSEARCH_ERROR = 'Unable to process the result of the XMLSearch for Unexpected token ":" at start of expression.';

/**
 * getRemoteFeedData over text already passed through prepareRemoteFeedText with stripChr20 (feedUtility.cfc:257-294).
 * Text CFML isXML rejects yields maxItems 0; namespace errors, which isXML accepts, and RDF feeds throw as in legacy.
 */
export function readRemoteFeed(text: string, maxItems: number): RemoteFeed {
  let xml: XmlElement;
  try {
    xml = parseFeedXml(text);
  } catch (error) {
    if (error instanceof XmlParseError && !error.namespaceError) return { items: [], maxItems: 0 };
    throw error;
  }
  let feed: RemoteFeed;
  if (xml.is('rss')) {
    const channelTitle = xml.child('channel').child('title').xmlText;
    feed = { xml, type: 'rss', channelTitle, items: xml.child('channel').children('item'), maxItems: 0 };
  } else if (xml.is('rdf:RDF')) {
    throw new RemoteFeedError(RDF_XMLSEARCH_ERROR);
  } else if (xml.is('feed')) {
    feed = { xml, type: 'atom', channelTitle: xml.child('title').xmlText, items: xml.children('entry'), maxItems: 0 };
  } else {
    feed = { xml, items: [], maxItems: 0 };
  }
  return { ...feed, maxItems: Math.min(feed.items.length, maxItems) };
}

/**
 * Branch doImport and cfeed.import1 take for the feed bean's version, matched case-insensitively like cfcase
 * (feedUtility.cfc:124-222, import1.cfm:108-151). doImport does nothing for atom; undefined matches no case.
 */
export function importFormat(version: string): 'rss' | 'atom' | undefined {
  const value = version.toLowerCase();
  if (value === 'rss 0.920' || value === 'rss 2.0') return 'rss';
  return value === 'atom' ? 'atom' : undefined;
}

/** `xmlFeed.rss.channel.item` (feedUtility.cfc:127, import1.cfm:111); throws, as CFML does, without an rss root or any item. */
export function rssChannelItems(xml: XmlElement): XmlElement[] {
  if (!xml.is('rss')) throw new XmlElementUndefinedError('rss', 'the XML document');
  const channel = xml.child('channel');
  const items = channel.children('item');
  if (items.length === 0) throw new XmlElementUndefinedError('item', channel.name);
  return items;
}

function visibleCount(items: readonly unknown[], maxItems: number): number {
  return Math.max(0, Math.min(items.length, maxItems));
}

/** Items doImport visits: from min(item count, maxItems) down to the first (feedUtility.cfc:128-134). */
export function importOrder<T>(items: readonly T[], maxItems: number): T[] {
  return items.slice(0, visibleCount(items, maxItems)).reverse();
}

/** Items cfeed.import1 lists: the first min(item count, maxItems), in feed order (import1.cfm:112-118). */
export function previewOrder<T>(items: readonly T[], maxItems: number): T[] {
  return items.slice(0, visibleCount(items, maxItems));
}

/** doImport's item filter: remoteID 'All' in any case, or a list holding the item's id (feedUtility.cfc:143). */
export function isImportSelected(remoteIdParam: string | undefined, feedItemId: string): boolean {
  if (remoteIdParam === undefined) return false;
  return remoteIdParam.toLowerCase() === 'all' || cfListToArray(remoteIdParam).includes(feedItemId);
}

/** CFML left(s, n) over UTF-16 code units. */
function cfLeft(s: string, count: number): string {
  return s.slice(0, count);
}

/** hash(s, configBean.getDefaultHashAlgorithm()) with the configured CFMX_COMPAT: an MD5, unlike cfHash's SHA-256 default. */
function cfmxCompatHash(s: string): string {
  return cfHash(s, 'CFMX_COMPAT');
}

/** Content remoteID of a feed item: hash of left(guid, 255), or of left(link, 255) without a guid (feedUtility.cfc:136-141, import1.cfm:120-125). */
export function feedItemRemoteId(item: XmlElement, hash: (s: string) => string = cfmxCompatHash): string {
  return hash(cfLeft((item.has('guid') ? item.child('guid') : item.child('link')).xmlText, 255));
}

/** Feed bean values doImport copies onto every item. */
export interface FeedImportTarget {
  parentId: string;
  siteId: string;
  /** The feed's categoryID list, or its ids in list order. */
  categoryIds: string | readonly string[];
}

/** Options of importItemFields. */
export interface ImportItemOptions {
  /** remoteID hash; default CFMX_COMPAT. */
  hash?: (s: string) => string;
  /** Clock for the milliseconds ACF leaks into zone-converted release dates. */
  now?: Date;
}

/** Site Manager module id doImport assigns to imported pages (feedUtility.cfc:194). */
export const FEED_IMPORT_MODULE_ID = '00000000000000000000000000000000000';

/** The feedItem struct doImport passes to contentBean.set (feedUtility.cfc:147-202); body and releaseDate are set only when legacy sets them. */
export type FeedImportItem = {
  remoteURL: string;
  title: string;
  summary: string;
  remotePubDate: string;
  releaseDate?: Date;
  remoteID: string;
  body?: string;
  parentID: string;
  siteID: string;
  approved: 1;
  type: 'Page';
  display: 1;
  isNav: 1;
  moduleID: string;
  mode: 'import';
} & { [categoryAssign: `categoryAssign${string}`]: 0 };

function optionalText(item: XmlElement, name: string): string | undefined {
  return item.has(name) ? item.child(name).xmlText : undefined;
}

/** Content fields doImport saves for one RSS item; a missing link, title or pubDate throws as in legacy (feedUtility.cfc:137-202). */
export function importItemFields(item: XmlElement, feed: FeedImportTarget, options: ImportItemOptions = {}): FeedImportItem {
  const remoteID = feedItemRemoteId(item, options.hash);
  const fields: FeedImportItem = {
    remoteURL: cfLeft(item.child('link').xmlText, 255),
    title: cfLeft(item.child('title').xmlText, 255),
    summary: optionalText(item, 'description') ?? optionalText(item, 'summary') ?? '',
    remotePubDate: item.child('pubDate').xmlText,
    remoteID,
    parentID: feed.parentId,
    siteID: feed.siteId,
    approved: 1,
    type: 'Page',
    display: 1,
    isNav: 1,
    moduleID: FEED_IMPORT_MODULE_ID,
    mode: 'import',
  };
  const releaseDate = cfParseDateTime(fields.remotePubDate, options.now);
  if (releaseDate !== undefined) fields.releaseDate = releaseDate;
  const body = item.children('content:encoded')[0]?.xmlText ?? optionalText(item, 'description') ?? optionalText(item, 'summary');
  if (body !== undefined) fields.body = body;
  const categoryIds = typeof feed.categoryIds === 'string' ? cfListToArray(feed.categoryIds) : feed.categoryIds;
  for (const categoryId of categoryIds) fields[`categoryAssign${categoryId.replaceAll('-', '')}`] = 0;
  return fields;
}
