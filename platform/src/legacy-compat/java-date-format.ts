// java.text.SimpleDateFormat.parse(text, pos) of a non-lenient formatter as Java 17 (CLDR data) runs it for a locale's
// symbols (acf-date-locales.ts), for the pattern letters ColdFusion's LS date functions use: G y M d E a h H m s S z X.
import type { AcfDateLocale, DateName } from './acf-date-locales.js';
import { LegacyServiceUnavailableError } from './errors.js';
import { type Civil, JAVA_LONG_MAX, javaDateOf, javaDayOfWeek, javaEpochDay, localCivil, localInstant } from './java-calendar.js';
import { EN_US_ZONE_NAMES } from './java-zone-names.js';

type Token = { readonly field: string; readonly count: number } | { readonly literal: string };

/** A compiled SimpleDateFormat pattern. */
export type JavaPattern = readonly Token[];

/** java.text.ParsePosition: `index` advances on success and is left unchanged on failure. */
export interface ParsePosition {
  index: number;
}

const HOUR_MS = 3_600_000;
const INT_MAX = 2_147_483_647;
const INT_MIN = -2_147_483_648;
const LONG_MIN_DIGITS = '9223372036854775808';
const ND = /^\p{Nd}$/u;
const LETTER = /^\p{L}$/u;
/** The non-letter UTF-16 units any uncarried locale's time-zone names start with. */
const ZONE_NAME_INITIALS = '[\u200b\u200c\u200d\u200e\ud804';

/** Fields a parse sets, by Calendar field (`month` 0-based), and the parse order of the hour fields (0 when unset). */
interface Fields {
  era?: number;
  year?: number;
  month?: number;
  day?: number;
  dayOfWeek?: number;
  hour?: number;
  hourOfDay?: number;
  amPm?: number;
  minute?: number;
  second?: number;
  ms?: number;
  zoneOffset?: number;
  ambiguousYear?: boolean;
  hourAt: number;
  hourOfDayAt: number;
  amPmAt: number;
}

/** Compiles a pattern: letter runs are fields, quoted text and other characters literals ('' is a quote). */
export function compilePattern(pattern: string): JavaPattern {
  const tokens: Token[] = [];
  let literal = '';
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern.charAt(i);
    if (ch === "'") {
      const end = pattern.indexOf("'", i + 1);
      literal += end === i + 1 ? "'" : pattern.slice(i + 1, end);
      i = end + 1;
    } else if (/[A-Za-z]/.test(ch)) {
      let count = 1;
      while (pattern.charAt(i + count) === ch) count++;
      if (literal) tokens.push({ literal });
      literal = '';
      tokens.push({ field: ch, count });
      i += count;
    } else {
      literal += ch;
      i++;
    }
  }
  if (literal) tokens.push({ literal });
  return tokens;
}

/** Character.isDigit: a Unicode decimal digit (UTF-16 code unit). */
export function isJavaDigit(ch: string): boolean {
  return ND.test(ch);
}

/** Character.digit(ch, 10); -1 for a non-digit. Every Nd block holds the ten digits in code-point order. */
function javaDigit(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (code >= 48 && code <= 57) return code - 48;
  if (!isJavaDigit(text.charAt(i))) return -1;
  let zero = code;
  while (isJavaDigit(String.fromCharCode(zero - 1))) zero--;
  return (code - zero) % 10;
}

function javaUpper(ch: string): string {
  const upper = ch.toUpperCase();
  return upper.length === 1 ? upper : ch;
}

function javaLower(ch: string): string {
  if (ch === '\u0130') return 'i';
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : ch;
}

/** String.regionMatches(true, start, s, 0, s.length) with Java's per-char case folding. */
function regionMatchesIgnoreCase(text: string, start: number, s: string): boolean {
  if (start < 0 || start + s.length > text.length) return false;
  for (let j = 0; j < s.length; j++) {
    const a = text.charAt(start + j);
    const b = s.charAt(j);
    if (a === b) continue;
    const ua = javaUpper(a);
    const ub = javaUpper(b);
    if (ua !== ub && javaLower(ua) !== javaLower(ub)) return false;
  }
  return true;
}

/** SimpleDateFormat.matchString over a display-names map (longest first): the longest name matching at `start`. */
function matchName(text: string, start: number, names: readonly DateName[]): { value: number; end: number } | null {
  for (const [name, value] of names) {
    if (regionMatchesIgnoreCase(text, start, name)) return { value, end: start + name.length };
  }
  return null;
}

/** DigitList.fitsIntoLong of significant digits `digits` with the decimal point after `decimalAt` of them. */
function fitsIntoLong(digits: string, decimalAt: number, positive: boolean): boolean {
  const count = digits.replace(/0+$/, '').length;
  if (count === 0) return true;
  if (decimalAt < count || decimalAt > 19) return false;
  if (decimalAt < 19) return true;
  for (let i = 0; i < count; i++) {
    if (digits.charAt(i) !== LONG_MIN_DIGITS.charAt(i)) return digits.charAt(i) < LONG_MIN_DIGITS.charAt(i);
  }
  return count < decimalAt || !positive;
}

/** Number.intValue of a parsed DigitList: a long wraps to 32 bits, a double saturates (NaN is 0). */
function intValue(digits: string, decimalAt: number, positive: boolean): number {
  const trimmed = digits.replace(/0+$/, '');
  if (fitsIntoLong(digits, decimalAt, positive)) {
    const magnitude = trimmed === '' ? 0n : BigInt(trimmed) * 10n ** BigInt(decimalAt - trimmed.length);
    return Number(BigInt.asIntN(32, positive ? magnitude : -magnitude));
  }
  const value = Number(`${positive ? '' : '-'}0.${trimmed}e${decimalAt}`);
  return Math.max(INT_MIN, Math.min(INT_MAX, Math.trunc(value)));
}

/** DecimalFormat digit run from `start` (leading zeros dropped); undefined when it holds no digit. */
function digitRun(text: string, start: number): { digits: string; end: number } | undefined {
  let digits = '';
  let end = start;
  for (let d = javaDigit(text, end); d >= 0; d = javaDigit(text, ++end)) {
    if (d > 0 || digits !== '') digits += String(d);
  }
  return end === start ? undefined : { digits, end };
}

/**
 * The integer-only DecimalFormat SimpleDateFormat parses numbers with: the locale's minus sign, digits of any script, its
 * exponent separator, NaN and infinity.
 */
function parseInteger(text: string, start: number, symbols: AcfDateLocale): { value: number; end: number } | null {
  const { minus, nan, infinity } = symbols;
  if (text.startsWith(nan, start)) return { value: 0, end: start + nan.length };
  const positive = !text.startsWith(minus, start);
  const at = positive ? start : start + minus.length;
  if (text.startsWith(infinity, at)) return { value: positive ? INT_MAX : INT_MIN, end: at + infinity.length };
  const run = digitRun(text, at);
  if (run === undefined) return null;
  let { end } = run;
  let exponent = 0;
  if (text.startsWith(symbols.exponent, end)) {
    const expAt = end + symbols.exponent.length;
    const negative = text.startsWith(minus, expAt);
    const exp = digitRun(text, negative ? expAt + minus.length : expAt);
    if (exp !== undefined && fitsIntoLong(exp.digits, exp.digits.length, !negative)) {
      const value = Number(BigInt.asIntN(32, exp.digits === '' ? 0n : BigInt(exp.digits)));
      exponent = negative ? -value | 0 : value;
      end = exp.end;
    }
  }
  // DigitList.decimalAt is an int, so the exponent's addition wraps.
  return { value: intValue(run.digits, (run.digits.length + exponent) | 0, positive), end };
}

/** SimpleDateFormat.subParseNumericZone: ±hh[[:]mm] from `start` as an offset in ms, and the end. */
function numericZone(text: string, start: number, sign: number, count: number, colon: boolean): { offset: number; end: number } | null {
  const ascii = (k: number): number => {
    const ch = text.charAt(k);
    return ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : -1;
  };
  let i = start;
  let hours = ascii(i++);
  if (hours < 0 || i >= text.length) return null;
  if (ascii(i) >= 0) hours = hours * 10 + ascii(i++);
  else if (count > 0 || !colon) return null;
  if (hours > 23) return null;
  let minutes = 0;
  if (count !== 1) {
    if (colon && text.charAt(i++) !== ':') return null;
    const tens = ascii(i++);
    const units = ascii(i++);
    if (tens < 0 || units < 0 || tens * 10 + units > 59) return null;
    minutes = tens * 10 + units;
  }
  return { offset: sign * (hours * 60 + minutes) * 60_000, end: i };
}

/** The 'z' field: GMT[±h[h]:mm], ±hhmm, or a zone name (zoneNameEnd). */
function zoneName(text: string, start: number, at: number, f: Fields, symbols: AcfDateLocale): number {
  const ch = text.charAt(at);
  if (ch === '+' || ch === '-') {
    const zone = numericZone(text, at + 1, ch === '+' ? 1 : -1, 0, false);
    if (zone === null) return -1;
    f.zoneOffset = zone.offset;
    return zone.end;
  }
  if ((ch === 'G' || ch === 'g') && regionMatchesIgnoreCase(text, start, 'GMT')) {
    const after = text.charAt(start + 3);
    if (after !== '+' && after !== '-') {
      f.zoneOffset = 0;
      return start + 3;
    }
    const zone = numericZone(text, start + 4, after === '+' ? 1 : -1, 0, true);
    if (zone === null) return -1;
    f.zoneOffset = zone.offset;
    return zone.end;
  }
  return zoneNameEnd(text, at, f, symbols);
}

/**
 * SimpleDateFormat.subParseZoneString, whose zone follows the formatter's per-thread state: a name every matching zone
 * parses at one offset is read; text that is or may be another zone name throws (only en_US lists every name).
 */
function zoneNameEnd(text: string, at: number, f: Fields, symbols: AcfDateLocale): number {
  const fixed = symbols.fixedZones.find(([name]) => regionMatchesIgnoreCase(text, at, name));
  if (fixed !== undefined) {
    const [name, offset, longer] = fixed;
    if (longer.some((other) => regionMatchesIgnoreCase(text, at, other))) throw zoneNameError();
    f.zoneOffset = offset;
    return at + name.length;
  }
  if (symbols.enZoneNames) {
    if (!EN_US_ZONE_NAMES.some((name) => regionMatchesIgnoreCase(text, at, name))) return -1;
    throw zoneNameError();
  }
  const ch = text.charAt(at);
  if (!LETTER.test(ch) && !ZONE_NAME_INITIALS.includes(ch)) return -1;
  if (symbols.zoneSafeNames.some((name) => regionMatchesIgnoreCase(text, at, name))) return -1;
  throw zoneNameError();
}

/** The fail-closed error for date text whose instant depends on a time-zone name. */
export function zoneNameError(): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError('Date text names a time zone that only the legacy parser resolves', 'auto', 'date-text-zone');
}

/** String.equalsIgnoreCase. */
export function javaEqualsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && regionMatchesIgnoreCase(a, 0, b);
}

/**
 * SimpleDateFormat.subParse of one field from `start` with the locale's symbols; the end, or -1. `order` is the field's
 * place in the pattern, the stamp Calendar resolves the hour fields by.
 */
function subParse(
  text: string, start: number, field: string, count: number, f: Fields, centuryYear: number, symbols: AcfDateLocale, order: number,
): number {
  let at = start;
  while (text.charAt(at) === ' ' || text.charAt(at) === '\t') at++;
  if (at >= text.length) return -1;
  const named = (names: readonly DateName[], set: (value: number) => void): number => {
    const match = matchName(text, start, names);
    if (match === null) return -1;
    set(match.value);
    return match.end;
  };
  if (field === 'G') return named(symbols.eras, (value) => (f.era = value));
  if (field === 'E') {
    const end = named(symbols.weekdays, (value) => (f.dayOfWeek = value));
    return end >= 0 ? end : named(symbols.shortWeekdays, (value) => (f.dayOfWeek = value));
  }
  if (field === 'a') {
    return named(symbols.amPm, (value) => {
      f.amPm = value;
      f.amPmAt = order;
    });
  }
  if (field === 'M' && count > 2) return named(symbols.months, (value) => (f.month = value));
  if (field === 'z') return zoneName(text, start, at, f, symbols);
  if (field === 'X') {
    const ch = text.charAt(at);
    if (ch === 'Z') {
      f.zoneOffset = 0;
      return at + 1;
    }
    const zone = ch === '+' || ch === '-' ? numericZone(text, at + 1, ch === '+' ? 1 : -1, count, count === 3) : null;
    if (zone === null) return -1;
    f.zoneOffset = zone.offset;
    return zone.end;
  }
  const number = parseInteger(text, at, symbols);
  if (number === null) return -1;
  const { value, end } = number;
  switch (field) {
    case 'y': {
      const twoDigits = count <= 2 && end - at === 2 && isJavaDigit(text.charAt(at)) && isJavaDigit(text.charAt(at + 1));
      if (!twoDigits) {
        f.year = value;
        break;
      }
      const ambiguous = centuryYear % 100;
      f.ambiguousYear = value === ambiguous;
      f.year = value + Math.floor(centuryYear / 100) * 100 + (value < ambiguous ? 100 : 0);
      break;
    }
    case 'M':
      f.month = value - 1;
      break;
    case 'd':
      f.day = value;
      break;
    case 'h':
      if (value < 1 || value > 12) return -1;
      f.hour = value === 12 ? 0 : value;
      f.hourAt = order;
      break;
    case 'H':
      f.hourOfDay = value;
      f.hourOfDayAt = order;
      break;
    case 'm':
      f.minute = value;
      break;
    case 's':
      f.second = value;
      break;
    default:
      f.ms = value;
  }
  return end;
}

function inRange(value: number | undefined, min: number, max: number): boolean {
  return value === undefined || (value >= min && value <= max);
}

/** Calendar's hour of day: HOUR_OF_DAY or HOUR (+12 when AM_PM is PM), whichever was set later. */
function hourOfDay(f: Fields): number {
  const hourAt = f.hourAt > 0 && f.amPmAt > 0 ? Math.max(f.hourAt, f.amPmAt) : 0;
  const best = Math.max(hourAt, f.hourOfDayAt) || Math.max(f.hourAt, f.amPmAt);
  if (best === 0) return 0;
  if (best === f.hourOfDayAt) return f.hourOfDay ?? 0;
  return (f.hour ?? 0) + (f.amPmAt > 0 ? 12 * (f.amPm ?? 0) : 0);
}

/**
 * CalendarBuilder.establish(non-lenient Gregorian or Buddhist calendar).getTime(): the instant, or null when a field is
 * out of range or does not survive recomputation. `yearOffset` is what a Buddhist calendar adds to the year.
 */
function establish(f: Fields, centuryStart: number, yearOffset: number): number | null {
  const year = f.year === undefined ? 1970 : f.year - yearOffset;
  const ranges: [number | undefined, number, number][] = [
    [f.era, 0, 1], [f.year === undefined ? undefined : year, 1, 292_278_994], [f.month, 0, 11], [f.day, 1, 31],
    [f.dayOfWeek, 1, 7], [f.hour, 0, 11], [f.amPm, 0, 1], [f.hourOfDay, 0, 23], [f.minute, 0, 59], [f.second, 0, 59],
    [f.ms, 0, 999], [f.zoneOffset, -13 * HOUR_MS, 14 * HOUR_MS],
  ];
  if (!ranges.every(([value, min, max]) => inRange(value, min, max))) return null;
  const civil: Civil = {
    year: f.era === 0 ? 1 - year : year,
    month: (f.month ?? 0) + 1,
    day: f.day ?? 1,
    hour: hourOfDay(f),
    minute: f.minute ?? 0,
    second: f.second ?? 0,
    ms: f.ms ?? 0,
  };
  const date = javaDateOf(javaEpochDay(civil.year, civil.month, civil.day));
  if (date.year !== civil.year || date.month !== civil.month || date.day !== civil.day) return null;
  const t = localInstant(civil, f.zoneOffset);
  if (t > JAVA_LONG_MAX || !keepsSetFields(f, localCivil(t, f.zoneOffset), yearOffset)) return null;
  if (f.ambiguousYear === true && t < centuryStart) {
    return establish({ ...f, year: (f.year ?? 0) + 100, ambiguousYear: false }, centuryStart, yearOffset);
  }
  return t;
}

/** Whether the fields the parse set survive the non-lenient calendar's recomputation from the instant. */
function keepsSetFields(f: Fields, back: Civil, yearOffset: number): boolean {
  const pairs: [number | undefined, number][] = [
    [f.era, back.year > 0 ? 1 : 0], [f.year, (back.year > 0 ? back.year : 1 - back.year) + yearOffset], [f.month, back.month - 1],
    [f.day, back.day], [f.dayOfWeek, javaDayOfWeek(javaEpochDay(back.year, back.month, back.day))], [f.hourOfDay, back.hour],
    [f.hour, back.hour % 12], [f.amPm, back.hour < 12 ? 0 : 1], [f.minute, back.minute], [f.second, back.second], [f.ms, back.ms],
  ];
  return pairs.every(([set, now]) => set === undefined || set === now);
}

/** SimpleDateFormat.parse(text, pos) of a formatter with `symbols` and defaultCenturyStart `centuryStart`: the instant, or null. */
export function parseJavaDate(
  pattern: JavaPattern, text: string, pos: ParsePosition, centuryStart: number, symbols: AcfDateLocale,
): number | null {
  const centuryYear = localCivil(centuryStart).year + symbols.yearOffset;
  const f: Fields = { hourAt: 0, hourOfDayAt: 0, amPmAt: 0 };
  let at = pos.index;
  for (const [order, token] of pattern.entries()) {
    if ('literal' in token) {
      if (!text.startsWith(token.literal, at)) return null;
      at += token.literal.length;
      continue;
    }
    at = subParse(text, at, token.field, token.count, f, centuryYear, symbols, order + 1);
    if (at < 0) return null;
  }
  const t = establish(f, centuryStart, symbols.yearOffset);
  if (t !== null) pos.index = at;
  return t;
}
