// CFML date text as ACF 2023 reads it: LSIsDate/LSParseDateTime under setLocale, isDate/parseDateTime, LSDateFormat's
// string resolution, and the cfqueryparam cf_sql_timestamp conversion; instants are in the process time zone (the legacy server's).
import { type AcfDateLocale, acfDateLocale } from './acf-date-locales.js';
import { cfDateTimeInstant } from './cf-date-parser.js';
import { LegacyServiceUnavailableError } from './errors.js';
import { DAY_MS, addLocalDays, isJavaLeapYear, isLocalTime, localCivil, localInstant, toDate, utcInstant, zoneOffset } from './java-calendar.js';
import { type JavaPattern, compilePattern, isJavaDigit, javaEqualsIgnoreCase, parseJavaDate } from './java-date-format.js';
import { type ZoneTable, javaZoneTable } from './java-zone-names.js';
import { cfIsNumeric, javaTrim } from './serializer.js';
import { roundToSqlServerDatetime } from '../migration-kit/canonical.js';

// CFLocaleBase's formatters, in its order: whole date-times, then dates (0-6) and times (7-15). Numbers index the
// locale's style patterns (date-time, date, time: SHORT to FULL), strings are its own patterns.
const DATE_TIME_FORMATS = [0, 1, 2, 3, 'EEE, dd MMM yyyy HH:mm:ss zzz', "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mm:ss"];
const DATE_AND_TIME_FORMATS = [
  4, 5, 7, 6, 'yyyy-MM-dd', 'dd.MM.yyyy', 'dd/MM/yyyy', 11, 10, 'H:mm:ss.S', 'h:mm:ss a', 'H:mm:ss', 'h:mm a', 'H:mm', 9, 8,
];
const TIME_START = 7;
/** The FULL and LONG time styles, whose result CFLocaleBase shifts by the current DST offset on a summer-time date. */
const ZONED_TIMES = new Set([7, 8]);
// Cast._Date hands text starting with these to the date parser; other non-numeric starts are no date.
const PARSER_STARTS = 'ADJMOSTWadjmostw{';
// Java's HexFloatPattern: sign, whole significand or integer and fraction digits, exponent sign and digits.
const HEX_FLOAT = /^([-+])?0[xX](?:([0-9A-Fa-f]+)\.?|([0-9A-Fa-f]*)\.([0-9A-Fa-f]+))[pP]([-+])?([0-9]+)[fFdD]?$/;
const INT_MAX = 2 ** 31 - 1;
const OLE_EPOCH = { year: 1899, month: 12, day: 30, hour: 0, minute: 0, second: 0, ms: 0 };
/** SQL Server datetime's last tick, which every later datetime2 of 9999-12-31 converts to. */
const DATETIME_LAST = { year: 9999, month: 12, day: 31, hour: 23, minute: 59, second: 59, ms: 997 };
const LONG_MAX = 2n ** 63n - 1n;

/** SimpleDateFormat's default century start: the clock 80 years back (ACF builds the formatters once per thread). */
function centuryStart(now: number): number {
  const c = localCivil(now);
  const year = c.year - 80;
  return localInstant({ ...c, year, day: c.month === 2 && c.day === 29 && !isJavaLeapYear(year) ? 28 : c.day });
}

/** DST offset of the process zone at `t`: its offset above the lesser of that year's January and July offsets. */
function daylightSaving(t: number): number {
  const { year } = localCivil(t);
  const offsetOn = (month: number): number => zoneOffset(utcInstant({ ...OLE_EPOCH, year, month, day: 1 }));
  return zoneOffset(t) - Math.min(offsetOn(1), offsetOn(7));
}

/** The formatters CFLocaleBase builds for one locale's data, and the zone strings they read. */
interface LsFormatters {
  symbols: AcfDateLocale;
  zones: ZoneTable;
  dateTimes: JavaPattern[];
  dateAndTimes: JavaPattern[];
}

const lsFormatterCache = new Map<string, LsFormatters>();

/** The formatters of the locale setLocale(`locale`) selects; throws setLocale's error for a name ACF does not support. */
function lsFormatters(locale: string): LsFormatters {
  const key = locale.toLowerCase();
  let formatters = lsFormatterCache.get(key);
  if (formatters === undefined) {
    const symbols = acfDateLocale(locale);
    const zones = javaZoneTable(locale);
    if (symbols === undefined || zones === undefined) throw new Error(`${locale} must be one of the ColdFusion supported locales.`);
    const compile = (format: number | string): JavaPattern => {
      const pattern = typeof format === 'string' ? format : symbols.patterns[format];
      if (pattern === undefined) throw new RangeError(`Locale ${locale} has no date pattern ${format}`);
      return compilePattern(pattern);
    };
    formatters = { symbols, zones, dateTimes: DATE_TIME_FORMATS.map(compile), dateAndTimes: DATE_AND_TIME_FORMATS.map(compile) };
    lsFormatterCache.set(key, formatters);
  }
  return formatters;
}

/** CFLocaleBase.ParseDateTime with a locale's formatters: the instant, or null where ACF throws InvalidDateTimeException. */
function lsParse(indate: string, { symbols, zones, dateTimes, dateAndTimes }: LsFormatters): number | null {
  const text = javaTrim(indate);
  const now = Date.now();
  const start = centuryStart(now);
  const pos = { index: 0 };
  const parse = (format: JavaPattern, s: string): number | null => parseJavaDate(format, s, pos, start, symbols, zones);
  let dt: number | null = null;
  for (const format of dateTimes) {
    dt = parse(format, text);
    if (dt !== null) break;
  }
  let d: number | null = null;
  let t: number | null = null;
  if (pos.index !== text.length) {
    pos.index = 0;
    for (const [i, format] of dateAndTimes.entries()) {
      if (i < TIME_START && d === null) d = parse(format, text);
      else if (i >= TIME_START && t === null) t = parse(format, text);
      if ((dt === null && d === null && t === null) || pos.index < text.length) continue;
      if (ZONED_TIMES.has(i) && t !== null && d !== null && daylightSaving(d) !== 0) t += daylightSaving(now);
      break;
    }
    const split = pos.index;
    if (split < text.length && split > 0) {
      // The rest, trimmed, is parsed alone; ACF then counts one separator character between the parts.
      const rest = javaTrim(text.slice(split));
      pos.index = 0;
      for (const [i, format] of dateAndTimes.entries()) {
        if (i < TIME_START && d === null) d = parse(format, rest);
        if (i >= TIME_START && t === null) t = parse(format, rest);
        if ((dt === null && d === null && t === null) || pos.index < rest.length) continue;
        pos.index = split + pos.index + 1;
        break;
      }
    }
  }
  const time = t ?? dt;
  const day = d ?? dt;
  if (pos.index !== text.length || (time === null && day === null)) return null;
  // new OleDateTime(year - 1900, month, date, hour, min, sec): the era-less Calendar.YEAR (Buddhist where the locale's
  // calendar is), no milliseconds.
  const date = day === null ? OLE_EPOCH : localCivil(day);
  const clock = time === null ? OLE_EPOCH : localCivil(time);
  const year = (date.year > 0 ? date.year : 1 - date.year) + (day === null ? 0 : symbols.yearOffset);
  return localInstant({ year, month: date.month, day: date.day, hour: clock.hour, minute: clock.minute, second: clock.second, ms: 0 });
}

/**
 * CFML LSIsDate(text) after setLocale(locale) on a request thread whose formatters have parsed no zone name yet:
 * digits-only text is no date. Throws setLocale's error for a locale ACF does not support.
 */
export function cfLsIsDate(text: string, locale = 'English (US)'): boolean {
  const formatters = lsFormatters(locale);
  if (text.split('').every(isJavaDigit)) return false;
  return lsParse(text, formatters) !== null;
}

/**
 * CFML LSParseDateTime(text) after setLocale(locale); throws as cfLsIsDate does, ACF's invalid-date error, and RangeError
 * beyond the JS Date range.
 */
export function cfLsParseDateTime(text: string, locale = 'English (US)'): Date {
  const t = lsParse(text, lsFormatters(locale));
  if (t === null) throw new Error(`${text} is an invalid date or time string.`);
  return toDate(t);
}

/** CFML isDate(text); throws where ACF throws (a day the non-lenient calendar refuses). */
export function cfIsDateText(text: string): boolean {
  return cfDateTimeInstant(javaTrim(text)) !== null;
}

/** CFML parseDateTime(text); throws ACF's not-a-date error. A named zone's instant keeps the clock's milliseconds, as ACF's does. */
export function cfParseDateTimeText(text: string): Date {
  const t = cfDateTimeInstant(javaTrim(text));
  if (t === null) throw new Error(`${text} is not a valid date/time format.`);
  return toDate(t);
}

/**
 * The date CFML LSDateFormat(text, mask) formats after setLocale(locale): a number as a date serial, else LSParseDateTime,
 * else the Cast._Date of the text; null for blank text. Throws setLocale's error, ACF's invalid-format error, and
 * RangeError beyond the JS Date range.
 */
export function cfLsDateOf(text: string, locale = 'English (US)'): Date | null {
  const formatters = lsFormatters(locale);
  if (!cfIsNumeric(text)) {
    if (javaTrim(text) === '') return null;
    const t = lsParse(text, formatters);
    if (t !== null) return toDate(t);
  }
  try {
    return cfTimestampParam(text);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new Error(`${text} is an invalid date format.`);
  }
}

/** Java's (long) narrowing of a double. */
function javaLong(x: number): bigint {
  if (Number.isNaN(x)) return 0n;
  if (x >= 2 ** 63) return LONG_MAX;
  if (x <= -(2 ** 63)) return -LONG_MAX - 1n;
  return BigInt(Math.trunc(x));
}

/** Math.round(double): floor(x + 1/2) as a long. */
const javaRound = (x: number): bigint => (Math.abs(x) < 2 ** 52 ? BigInt(Math.round(x)) : javaLong(x));

/** OleDateTime(double): whole days from 1899-12-30 in the process zone, the fraction as milliseconds, narrowed to int. */
function oleInstant(value: number): Date {
  const days = javaLong(Math.floor(value));
  const ms = Number(BigInt.asIntN(32, javaRound((value - Number(days)) * DAY_MS)));
  return toDate(addLocalDays(localInstant(OLE_EPOCH) + ms, Number(BigInt.asIntN(32, days))));
}

/** A positive integer times 2^exponent rounded half-even to a double, subnormals included, as FloatingDecimal rounds. */
function scaleBinary(significand: bigint, exponent: number): number {
  const bits = significand.toString(2).length;
  const top = exponent + bits - 1;
  if (top > 1023) return Infinity;
  if (top < -1075) return 0;
  const kept = top >= -1022 ? 53 : top + 1075;
  const drop = BigInt(bits - kept);
  if (drop <= 0n) return Number(significand << -drop) * 2 ** (top - kept + 1);
  let m = significand >> drop;
  const rest = significand - (m << drop);
  const half = 1n << (drop - 1n);
  if (rest > half || (rest === half && (m & 1n) === 1n)) m += 1n;
  return Number(m) * 2 ** (top - kept + 1);
}

/**
 * Hexadecimal float text as FloatingDecimal.parseHexString (`java`) or ACF DoubleParser's copy reads it; the copy takes
 * its binary exponent's magnitude from the significand digits read as decimal. Null when malformed.
 */
function parseHex(s: string, java: boolean): number | null {
  const m = HEX_FLOAT.exec(s);
  if (m === null) return null;
  const [, sign, whole, integer = '', fraction = '', expSign, expDigits = ''] = m;
  const negative = sign === '-';
  const digits = (whole ?? integer + fraction).replace(/^0+/, '');
  if (digits === '') return negative ? -0 : 0;
  const magnitude = java ? expDigits : digits;
  // An exponent Integer.parseInt refuses (overflow, or a hex digit in the copy) gives infinity or zero by its sign.
  if (!/^[0-9]+$/.test(magnitude) || Number(magnitude) > INT_MAX) {
    const limit = expSign === '-' ? 0 : Infinity;
    return negative ? -limit : limit;
  }
  const value = scaleBinary(BigInt(`0x${digits}`), (expSign === '-' ? -1 : 1) * Number(magnitude) - 4 * fraction.length);
  return negative ? -value : value;
}

/**
 * Number text as Java's FloatingDecimal (`java`, Double.parseDouble) or ACF's DoubleParser copy reads it: sign, NaN,
 * Infinity, a hexadecimal float, digits with one '.', exponent, one trailing f/F/d/D. Null when malformed.
 */
function parseDecimal(s: string, java: boolean): number | null {
  const len = s.length;
  let i = 0;
  const negative = s.charAt(0) === '-';
  if (negative || s.charAt(0) === '+') i++;
  const signSeen = i > 0;
  if (s.charAt(i) === 'N') return s.slice(i) === 'NaN' ? NaN : null;
  if (s.charAt(i) === 'I') return s.slice(i) === 'Infinity' ? (negative ? -Infinity : Infinity) : null;
  if (s.charAt(i) === '0' && (s.charAt(i + 1) === 'x' || s.charAt(i + 1) === 'X')) return parseHex(s, java);
  let leadZeros = 0;
  let trailZeros = 0;
  let digits = '';
  let decSeen = false;
  let decPt = 0;
  const point = (): boolean => {
    if (decSeen) return false;
    decPt = signSeen ? i - 1 : i;
    decSeen = true;
    return true;
  };
  for (; i < len && (s.charAt(i) === '0' || s.charAt(i) === '.'); i++) {
    if (s.charAt(i) === '0') leadZeros++;
    else if (!point()) return null;
  }
  for (; i < len; i++) {
    const ch = s.charAt(i);
    if (ch >= '1' && ch <= '9') {
      digits += ch;
      trailZeros = 0;
    } else if (ch === '0') {
      digits += ch;
      trailZeros++;
    } else if (ch !== '.') break;
    else if (!point()) return null;
  }
  const nDigits = digits.length - trailZeros;
  if (nDigits === 0 && leadZeros === 0) return null;
  let decExp = decSeen ? decPt - leadZeros : nDigits + trailZeros;
  if (s.charAt(i) === 'e' || s.charAt(i) === 'E') {
    i++;
    if (i >= len) return null;
    const expSign = s.charAt(i) === '-' ? -1 : 1;
    if (s.charAt(i) === '-' || s.charAt(i) === '+') i++;
    const expAt = i;
    let expVal = 0;
    let overflow = false;
    for (; i < len && s.charAt(i) >= '0' && s.charAt(i) <= '9'; i++) {
      if (expVal >= 0xccccccc) overflow = true;
      expVal = expVal * 10 + s.charCodeAt(i) - 48;
    }
    if (i < len && expVal >= 0xccccccc) overflow = true;
    const expLimit = 324 + nDigits + trailZeros;
    if (!overflow && expVal <= expLimit) decExp += expSign * expVal;
    else if (java && !overflow && expSign === 1 && decExp < 0 && expVal + decExp < expLimit) decExp += expVal;
    else decExp = expSign * expLimit;
    if (i === expAt) return null;
  }
  if (i < len && (i !== len - 1 || !'fFdD'.includes(s.charAt(i)))) return null;
  if (nDigits === 0) return negative ? -0 : 0;
  return Number(`${negative ? '-' : ''}0.${digits.slice(0, nDigits)}e${decExp}`);
}

/** CFDouble's guard before parsing: no trailing f/F/d/D and no edge whitespace. */
const cfDoubleShape = (s: string): boolean => !'FDdf'.includes(s.charAt(s.length - 1)) && s.charCodeAt(s.length - 1) > 32 && s.charCodeAt(0) > 32;

/**
 * cfqueryparam cf_sql_timestamp of a value (Cast._Date): a date as is, numbers and numeric text as OLE day counts from
 * 1899-12-30, other text through parseDateTime; throws as ACF's binding does (null and blank text bind a null the
 * driver rejects; booleans and complex values do not convert).
 */
export function cfTimestampParam(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return oleInstant(value);
  if (value === null || value === undefined) throw new Error('The cf_sql_timestamp value is empty');
  if (typeof value !== 'string') throw new Error(`A ${typeof value} value cannot be converted to a date.`);
  const s = javaTrim(value);
  if (s === '') throw new Error('The cf_sql_timestamp value is empty');
  const notDate = new Error(`The value ${s} cannot be converted to a date.`);
  const first = s.charAt(0);
  if (first === '+' || first === '-' || first === '.') {
    const value = cfDoubleShape(s) ? parseDecimal(s, true) : null;
    if (value === null) throw notDate;
    return oleInstant(value);
  }
  if (first >= '0' && first <= '9') {
    const value = cfDoubleShape(s) ? parseDecimal(s, false) : null;
    if (value !== null) return oleInstant(value);
  } else if (first === 'f' || first === 'F' || first === 'n' || first === 'N') {
    if (javaEqualsIgnoreCase(s, first.toLowerCase() === 'f' ? 'false' : 'no')) throw notDate;
  } else if (!PARSER_STARTS.includes(first)) {
    throw notDate;
  }
  const t = cfDateTimeInstant(s);
  if (t === null) throw new Error(`${s} is an invalid date or time string.`);
  return toDate(t);
}

/**
 * The value a SQL Server `datetime` column (legacy tclassextenddata.datetimevalue) stores for a bound timestamp: its wall
 * time rounded to 1/300 s. Throws SQL Server's range error outside 1753-9999, LegacyServiceUnavailableError when the
 * rounding carries into a wall time the process zone skips.
 */
export function sqlServerDatetime(value: Date): Date {
  const t = value.getTime();
  const wall = Number.isNaN(t) ? undefined : localCivil(t);
  const outOfRange = new Error('The conversion of a datetime2 data type to a datetime data type resulted in an out-of-range value.');
  if (wall === undefined || wall.year < 1752 || wall.year > 9999) throw outOfRange;
  const stored = utcInstant(wall) >= utcInstant(DATETIME_LAST) ? DATETIME_LAST : roundToSqlServerDatetime({ ...wall, fractionSeconds: wall.ms / 1000 });
  if (stored.year < 1753) throw outOfRange;
  if (utcInstant(stored) === utcInstant(wall)) return value;
  if (!isLocalTime(stored)) {
    throw new LegacyServiceUnavailableError('A datetime rounded into a skipped local time has no target timestamp', 'auto', 'datetime-skipped-time');
  }
  return toDate(localInstant(stored));
}
