// coldfusion.runtime.CFDateTimeParser and DateTimeString as ACF 2023 (hotfix 26) runs them for isDate/parseDateTime of text.
import { type Civil, type JavaZone, isJavaLeapYear, localCivil, localInstant, strictLocalInstant, strictUtcInstant } from './java-calendar.js';

type Ymd = [year: number, month: number, day: number];

/** coldfusion.date.parsing.maxyear default. */
const MAX_YEAR = 292_278_993;
/** coldfusion.cutoffyear default: two-digit years below it are 20xx. */
const CUTOFF_YEAR = 30;
const MAX_TEXT = 1024;
const INT_MAX = 2_147_483_647;
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const DAY_NAMES = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
// Every prefix of three or more letters names the month; weekdays by full name or first three letters.
const MONTHS = new Map(MONTH_NAMES.flatMap((name, i) => Array.from({ length: name.length - 2 }, (_, k) => [name.slice(0, k + 3), i + 1] as const)));
const DAYS = new Map(DAY_NAMES.flatMap((name, i) => [[name, i + 1], [name.slice(0, 3), i + 1]] as const));
// Three-letter java.util.TimeZone IDs (DateTimeString.readTimeZone keeps a zone only when its ID matches) as the tzdb
// zones Java 17 maps them to, and its pseudo names.
const ZONES = new Map<string, JavaZone>([
  ['ACT', 'Australia/Darwin'], ['AET', 'Australia/Sydney'], ['AGT', 'America/Argentina/Buenos_Aires'], ['ART', 'Africa/Cairo'],
  ['AST', 'America/Anchorage'], ['BET', 'America/Sao_Paulo'], ['BST', 'Asia/Dhaka'], ['CAT', 'Africa/Harare'], ['CET', 'CET'],
  ['CNT', 'America/St_Johns'], ['CST', 'America/Chicago'], ['CTT', 'Asia/Shanghai'], ['EAT', 'Africa/Addis_Ababa'],
  ['ECT', 'Europe/Paris'], ['EET', 'EET'], ['EST', -18_000_000], ['GMT', 0], ['HST', -36_000_000],
  ['IET', 'America/Indiana/Indianapolis'], ['IST', 'Asia/Kolkata'], ['JST', 'Asia/Tokyo'], ['MET', 'MET'], ['MIT', 'Pacific/Apia'],
  ['MST', -25_200_000], ['NET', 'Asia/Yerevan'], ['NST', 'Pacific/Auckland'], ['PLT', 'Asia/Karachi'], ['PNT', 'America/Phoenix'],
  ['PRC', 'PRC'], ['PRT', 'America/Puerto_Rico'], ['PST', 'America/Los_Angeles'], ['ROK', 'ROK'], ['SST', 'Pacific/Guadalcanal'],
  ['UCT', 0], ['UTC', 0], ['VST', 'Asia/Ho_Chi_Minh'], ['WET', 'WET'],
]);
const PSEUDO_ZONES = new Map([['PDT', 'PST']]);
const NO_BREAK_SPACES = new Set(['\u00A0', '\u2007', '\u202F']);

/** Character.isWhitespace of one UTF-16 unit. */
export function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

const isAsciiDigit = (ch: string): boolean => ch >= '0' && ch <= '9' && ch.length === 1;
const isAsciiLetter = (ch: string): boolean => /^[A-Za-z]$/.test(ch);

/** Float.valueOf("." + digits): the float nearest 0.digits, ties to even. */
function floatFraction(digits: string): number {
  const numerator = BigInt(digits);
  if (numerator === 0n) return 0;
  const denominator = 10n ** BigInt(digits.length);
  // Scale the quotient to 24 significant bits, or fewer once below the normal range (2^-126).
  let shift = 24 + denominator.toString(2).length - numerator.toString(2).length;
  while ((numerator << BigInt(shift)) / denominator >= 1n << 24n) shift--;
  while (shift < 149 && (numerator << BigInt(shift)) / denominator < 1n << 23n) shift++;
  const scaled = numerator << BigInt(shift);
  let quotient = scaled / denominator;
  const twice = (scaled % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient++;
  return Number(quotient) * 2 ** -shift;
}

/** coldfusion.runtime.DateTimeString: a cursor over the text. */
class DateTimeString {
  pos = 0;

  constructor(private readonly str: string) {}

  private char(i: number): string {
    return this.str.charAt(i);
  }

  isFinished(): boolean {
    return this.pos >= this.str.length;
  }

  isLast(): boolean {
    return this.pos === this.str.length - 1;
  }

  isCurrent(c: string): boolean {
    return this.pos < this.str.length && this.char(this.pos) === c;
  }

  /** Whether the current char lower-cases (Character.toLowerCase) to one of `cs`. */
  isCurrentIgnorecase(...cs: string[]): boolean {
    return this.pos < this.str.length && cs.includes(this.char(this.pos).toLowerCase());
  }

  skipSpaces(): void {
    while (this.pos < this.str.length && isJavaWhitespace(this.char(this.pos))) this.pos++;
  }

  moveIfSpaces(): boolean {
    const start = this.pos;
    this.skipSpaces();
    return start !== this.pos;
  }

  moveIfCurrent(c: string): boolean {
    if (!this.isCurrent(c)) return false;
    this.pos++;
    return true;
  }

  moveIfCurrentIgnorecase(c: string): boolean {
    if (!this.isCurrentIgnorecase(c)) return false;
    this.pos++;
    return true;
  }

  moveIfCurrentIgnoreSpaces(c: string): boolean {
    const start = this.pos;
    this.skipSpaces();
    if (this.moveIfCurrent(c)) return true;
    this.pos = start;
    return false;
  }

  /** A '-', '/', ',' or '.' (or 'T' when `includeT`) with the whitespace around it. */
  moveIfDelimiter(includeT = false): boolean {
    const start = this.pos;
    this.skipSpaces();
    const c = this.char(this.pos);
    if (this.pos < this.str.length && ('-/,.'.includes(c) || (includeT && (c === 'T' || c === 't')))) {
      this.pos++;
      this.skipSpaces();
      return true;
    }
    this.pos = start;
    return false;
  }

  /** `c` in any case with the whitespace around it. */
  moveIfDelimiterChar(c: string): boolean {
    const start = this.pos;
    this.skipSpaces();
    if (this.moveIfCurrentIgnorecase(c)) {
      this.skipSpaces();
      return true;
    }
    this.pos = start;
    return false;
  }

  /** Whether an a/p marker follows the whitespace: last char, or followed by 'm' or whitespace. */
  isCurrentAMPmStringNoSpaces(): boolean {
    const start = this.pos;
    this.skipSpaces();
    let result = false;
    if (this.isCurrentIgnorecase('a', 'p')) {
      const next = this.char(this.pos + 1);
      result = this.pos === this.str.length - 1 || next.toLowerCase() === 'm' || isJavaWhitespace(next);
    }
    this.pos = start;
    return result;
  }

  /** An ASCII digit run as an int; -1 (position kept) when absent or beyond Integer.MAX_VALUE. */
  readDigits(): number {
    const start = this.pos;
    while (this.pos < this.str.length && isAsciiDigit(this.char(this.pos))) this.pos++;
    if (start === this.pos) return -1;
    const value = Number(this.str.slice(start, this.pos));
    if (value <= INT_MAX) return value;
    this.pos = start;
    return -1;
  }

  /** An ASCII digit run read as the float fraction 0.digits; -1 when absent. */
  readFloatMantissa(): number {
    const start = this.pos;
    while (this.pos < this.str.length && isAsciiDigit(this.char(this.pos))) this.pos++;
    return start === this.pos ? -1 : floatFraction(this.str.slice(start, this.pos));
  }

  private readName(names: ReadonlyMap<string, number>): number {
    const start = this.pos;
    while (this.pos < this.str.length && isAsciiLetter(this.char(this.pos))) this.pos++;
    const value = start === this.pos ? undefined : names.get(this.str.slice(start, this.pos).toUpperCase());
    if (value !== undefined) return value;
    this.pos = start;
    return -1;
  }

  /** A month (1-12) or weekday (Monday 1 - Sunday 7) name. */
  readIndicator(): { month: boolean; value: number } | null {
    const month = this.readName(MONTHS);
    if (month !== -1) return { month: true, value: month };
    const day = this.readName(DAYS);
    return day === -1 ? null : { month: false, value: day };
  }

  readMonth(): number {
    return this.readName(MONTHS);
  }

  /** Three letters naming a java.util.TimeZone ID, as that ID. */
  readTimeZone(): string | null {
    const code = this.str.slice(this.pos, this.pos + 3);
    if (code.length < 3 || ![...code].every(isAsciiLetter)) return null;
    const upper = code.toUpperCase();
    const zone = ZONES.has(upper) ? upper : PSEUDO_ZONES.get(upper);
    if (zone === undefined) return null;
    this.pos += 3;
    return zone;
  }
}

function adjust2Kyear(year: number): number {
  if (year >= 0 && year < CUTOFF_YEAR) return year + 2000;
  return year >= CUTOFF_YEAR && year <= 99 ? year + 1900 : year;
}

function dayNotInMonth(day: number, month: number, year: number): boolean {
  return (
    day < 1 || month < 1 || year < 1 || day > 31 || (day > 30 && [2, 4, 6, 9, 11].includes(month)) || (day > 29 && month === 2) ||
    (day > 28 && month === 2 && !isJavaLeapYear(year))
  );
}

function invalidDate(): Error {
  return new Error('Date value passed to date function createDateTime is unspecified or invalid.');
}

/** DateUtils.createDateTime: a cleared non-lenient process-zone Calendar; years below 100 become 19xx/20xx (-1 is 1999). */
function createDateTime(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const adjusted = year + (year < 100 ? (year < CUTOFF_YEAR ? 2000 : 1900) : 0);
  const t = strictLocalInstant({ year: adjusted, month, day, hour, minute, second, ms: 0 });
  if (t === undefined) throw invalidDate();
  return t;
}

/** A cleared non-lenient Calendar after set(fields) and setMilliSeconds(ms), whose getTime() throws for an invalid field. */
function strictInstant(c: Omit<Civil, 'ms'>, ms: number, utc: boolean): number {
  const fields = { ...c, ms: ms > 0 && ms < 1000 ? ms : 0 };
  const t = utc ? strictUtcInstant(fields) : strictLocalInstant(fields);
  if (t === undefined) throw new Error(`The date ${c.year}-${c.month}-${c.day} ${c.hour}:${c.minute}:${c.second} does not exist`);
  return ms >= 1000 ? t + ms : t;
}

const civilOf = (date: Ymd, hour: number, minute: number, second: number): Omit<Civil, 'ms'> => ({
  year: date[0], month: date[1], day: date[2], hour, minute, second,
});

function toDateTime(date: Ymd, hour: number, minute: number, second: number, ms: number): number {
  if (ms === 0) return createDateTime(date[0], date[1], date[2], hour, minute, second);
  return strictInstant(civilOf(date, hour, minute, second), ms, false);
}

function yearAtEndOf(dts: DateTimeString, year: number, yearAtEnd: boolean): number {
  if (!yearAtEnd) return year;
  dts.skipSpaces();
  const read = dts.readDigits();
  return read === -1 ? year : adjust2Kyear(read);
}

/** CFDateTimeParser._parseoffset: hh[:mm|.mm] or hhmm east (`plus`) or west of UTC. */
function parseNumericOffset(dts: DateTimeString, date: Ymd, time: [number, number, number, number], plus: boolean, yearAtEnd: boolean): number | null {
  const start = dts.pos;
  let hour = dts.readDigits();
  if (hour === -1 || hour > 12) return null;
  const hourLength = dts.pos - start;
  let minute = 0;
  if (!dts.isFinished()) {
    if (!dts.moveIfCurrent(':') && !dts.moveIfCurrent('.')) return null;
    minute = dts.readDigits();
    if (minute === -1 || minute > 59 || (hour === 12 && minute > 0)) return null;
  } else if (hourLength > 2) {
    const h = Math.trunc(hour / 100);
    minute = hour - h * 100;
    hour = h;
    if (hour > 12 || minute > 59 || (hour === 12 && minute > 0)) return null;
  }
  const year = yearAtEndOf(dts, date[0], yearAtEnd);
  const [h, m, s, ms] = time;
  const t = strictInstant(civilOf([year, date[1], date[2]], h, m, s), ms, true);
  const offset = (hour * 60 + minute) * 60_000;
  return plus ? t - offset : t + offset;
}

/** CFDateTimeParser.parseOffset: a trailing Z, a three-letter zone, or a numeric offset. */
function parseOffset(dts: DateTimeString, date: Ymd, time: [number, number, number, number], yearAtEnd = false): number | null {
  const [hour, minute, second, ms] = time;
  if (dts.isLast() && dts.moveIfCurrentIgnorecase('z')) return strictInstant(civilOf(date, hour, minute, second), ms, true);
  const id = dts.readTimeZone();
  if (id === null || id === 'GMT') {
    if (dts.moveIfCurrent('+')) return parseNumericOffset(dts, date, time, true, yearAtEnd);
    if (dts.moveIfCurrent('-')) return parseNumericOffset(dts, date, time, false, yearAtEnd);
    // A final GMT keeps the wall time in the process zone (the lenient java.util.Date constructor).
    if (id !== null && dts.isFinished()) return localInstant({ ...civilOf([adjust2Kyear(date[0]), date[1], date[2]], hour, minute, second), ms: 0 }) + ms;
  }
  if (id === null) return null;
  const year = yearAtEndOf(dts, date[0], yearAtEnd);
  // Calendar.getInstance(zone), lenient and seeded with the clock, keeps the clock's milliseconds unless 0 < ms < 1000.
  const clockMs = ms > 0 && ms < 1000 ? ms : ((Date.now() % 1000) + 1000) % 1000;
  const t = localInstant({ ...civilOf([year, date[1], date[2]], hour, minute, second), ms: clockMs }, ZONES.get(id));
  return ms >= 1000 ? t + ms : t;
}

/** CFDateTimeParser.parseTime: [h]h[:mm[:ss[.fff]]] [AM|PM] [zone] after a date (or `hoursIn` already read). */
function parseTime(dts: DateTimeString, date: Ymd, hoursIn: number, skipLast: boolean, yearAtEnd = false): number | null {
  let hours = hoursIn;
  const hoursGiven = hours !== -1;
  if (!hoursGiven) {
    hours = dts.readDigits();
    if (hours === -1) return null;
  }
  if (hours > 23 || dts.isFinished()) return null;
  let minutes = 0;
  let seconds = 0;
  let ms = 0;
  if ((hoursGiven && !dts.isCurrentIgnorecase('a', 'p')) || dts.moveIfCurrentIgnoreSpaces(':')) {
    dts.skipSpaces();
    minutes = dts.readDigits();
    if (minutes === -1 || minutes > 59) return null;
    if (dts.moveIfCurrentIgnoreSpaces(':')) {
      dts.skipSpaces();
      seconds = dts.readDigits();
      if (seconds === -1 || seconds > 59) return null;
      if (dts.moveIfCurrentIgnoreSpaces('.')) {
        const fraction = dts.readFloatMantissa();
        if (fraction === -1) return null;
        // Math.round(float * 1000f); ACF's clamp above 1000 never applies, so a fraction rounding to 1.0f keeps 1000.
        ms = Math.round(Math.fround(fraction * 1000));
      }
    }
  }
  const at = (): number => toDateTime(date, hours, minutes, seconds, ms);
  dts.skipSpaces();
  if (dts.isFinished()) return at();
  if (dts.moveIfCurrentIgnorecase('a')) {
    dts.moveIfCurrentIgnorecase('m');
    if (hours === 12) hours = 0;
    if (dts.isFinished()) return at();
    dts.skipSpaces();
  } else if (dts.moveIfCurrentIgnorecase('p')) {
    dts.moveIfCurrentIgnorecase('m');
    if (hours < 12) hours += 12;
    if (dts.isFinished()) return at();
    dts.skipSpaces();
  }
  const position = dts.pos;
  const zoned = parseOffset(dts, date, [hours, minutes, seconds, ms], yearAtEnd);
  if (zoned === null) dts.pos = position;
  else if (dts.isFinished() || !hoursGiven || (yearAtEnd && skipLast)) return zoned;
  if (dts.isFinished()) return at();
  if (!hoursGiven) return skipLast ? at() : null;
  if (yearAtEnd) {
    dts.skipSpaces();
    const year = dts.readDigits();
    if (year !== -1) date[0] = adjust2Kyear(year);
    if (skipLast) return at();
  }
  const day = parseDate(dts, true);
  if (day === null) return null;
  // The default non-lenient Calendar set to that day, with the time fields replaced.
  const c = localCivil(day);
  return strictInstant({ year: c.year, month: c.month, day: c.day, hour: hours, minute: minutes, second: seconds }, ms > 0 ? ms : c.ms, false);
}

/** CFDateTimeParser.toDate of two words: month/day in the current year, or month/year on day 1. */
function twoWordDate(month: number, first: number, second: number, yearKnown: boolean): Ymd | null {
  if (first < 1 || second < 1) return null;
  if (first <= 12 && month < 2) {
    const thisYear = localCivil(Date.now()).year;
    if (!dayNotInMonth(second, first, thisYear)) return month === 1 ? [thisYear, first, second] : null;
    if (yearKnown && month === 1) return [thisYear, first, second];
    return [adjust2Kyear(second), first, 1];
  }
  if (second <= 12) {
    const thisYear = localCivil(Date.now()).year;
    if (!dayNotInMonth(first, second, thisYear)) return month === 2 ? [thisYear, second, first] : null;
    if (yearKnown && month === 2) return [thisYear, second, first];
    return [adjust2Kyear(first), second, 1];
  }
  return null;
}

/** CFDateTimeParser.toDate of three numbers (`month` 1 or 2 marks a month name first or second). */
function threeWordDate(month: number, firstIn: number, second: number, thirdIn: number): Ymd | null {
  let first = firstIn;
  let third = thirdIn;
  if (first <= 12 && first > 0) {
    third = adjust2Kyear(third);
    if (month === 2) return [adjust2Kyear(third), second, first];
    return dayNotInMonth(second, first, third) ? null : [third, first, second];
  }
  if (second > 12) return null;
  if (month === 2) [first, third] = [third, first];
  if (!dayNotInMonth(third, second, adjust2Kyear(first))) return [adjust2Kyear(first), second, third];
  third = adjust2Kyear(third);
  return dayNotInMonth(first, second, third) ? null : [third, second, first];
}

const createDay = (date: Ymd | null): number | null =>
  date !== null && date[0] <= MAX_YEAR ? createDateTime(date[0], date[1], date[2], 0, 0, 0) : null;

/** CFDateTimeParser._parseDateTime: a date of two or three words, optionally followed or preceded by a time. */
function parseDate(dts: DateTimeString, timeParsedAlready: boolean): number | null {
  let month = 0;
  let week = false;
  let first = dts.readDigits();
  if (first === -1) {
    const indicator = dts.readIndicator();
    if (indicator === null) return null;
    first = indicator.value;
    if (indicator.month) month = 1;
    else week = true;
  }
  if (dts.isFinished()) return null;
  if (week) {
    if (!dts.moveIfDelimiter() && !dts.moveIfSpaces()) return null;
    first = dts.readDigits();
    if (first === -1) {
      first = dts.readMonth();
      if (first === -1) return null;
      month = 1;
    }
    if (dts.isFinished()) return null;
  } else if (month === 0 && !timeParsedAlready && (dts.moveIfDelimiterChar(':') || dts.isCurrentAMPmStringNoSpaces())) {
    dts.skipSpaces();
    return parseTime(dts, [1899, 12, 30], first, false);
  }
  if (!dts.moveIfDelimiter() && !dts.moveIfSpaces()) return null;
  let second = dts.readDigits();
  if (second === -1) {
    second = dts.readMonth();
    if (second === -1 || month === 1) return null;
    month = 2;
  }
  if (dts.isFinished()) return createDay(twoWordDate(month, first, second, false));
  if (!dts.moveIfDelimiter() && !dts.moveIfSpaces()) return null;
  const third = dts.readDigits();
  if (third === -1) return null;
  if (dts.isFinished()) return createDay(threeWordDate(month, first, second, third));
  if (timeParsedAlready) return null;
  if (dts.moveIfDelimiter(true) || dts.moveIfSpaces()) {
    const date = threeWordDate(month, first, second, third);
    return date !== null && date[0] <= MAX_YEAR ? parseTime(dts, date, -1, week) : null;
  }
  if (!week || !dts.moveIfDelimiterChar(':')) return null;
  const date = twoWordDate(month, first, second, true);
  return date !== null && date[0] <= MAX_YEAR ? parseTime(dts, date, third, true, true) : null;
}

/** The [hh:mm:ss[.ms]] of an ODBC literal; null when malformed. */
function readOdbcTime(dts: DateTimeString): [number, number, number, number] | null {
  const hour = dts.readDigits();
  if (hour === -1 || hour > 23 || !dts.moveIfCurrent(':')) return null;
  dts.skipSpaces();
  const minute = dts.readDigits();
  if (minute === -1 || minute > 59 || !dts.moveIfCurrent(':')) return null;
  dts.skipSpaces();
  const second = dts.readDigits();
  if (second === -1 || second > 59) return null;
  let ms = 0;
  if (dts.moveIfCurrent('.')) {
    ms = dts.readDigits();
    if (ms === -1) return null;
    if (ms > 1000) ms = 999;
  }
  dts.skipSpaces();
  return [hour, minute, second, ms];
}

/** The yyyy-mm-dd of an ODBC literal (year 2K-adjusted); null when malformed or not a day. */
function readOdbcDate(dts: DateTimeString): Ymd | null {
  dts.skipSpaces();
  const year = dts.readDigits();
  if (year === -1 || !dts.moveIfCurrent('-')) return null;
  dts.skipSpaces();
  const month = dts.readDigits();
  if (month < 1 || month > 12 || !dts.moveIfCurrent('-')) return null;
  dts.skipSpaces();
  const day = dts.readDigits();
  return day < 1 ? null : [adjust2Kyear(year), month, day];
}

/** Whether an ODBC literal closes here: a quote, then only whitespace. */
function closesOdbc(dts: DateTimeString): boolean {
  if (!dts.moveIfCurrent("'")) return false;
  dts.skipSpaces();
  return dts.isFinished();
}

/** CFDateTimeParser.parseTimeStamps: ts 'yyyy-mm-dd hh:mm:ss[.ms]', t 'hh:mm:ss[.ms]' or d 'yyyy-mm-dd' between braces. */
function parseTimeStamps(text: string): number | null {
  const dts = new DateTimeString(text);
  if (dts.moveIfCurrentIgnorecase('t')) {
    if (dts.moveIfCurrentIgnorecase('s') && dts.moveIfSpaces() && dts.moveIfCurrent("'")) {
      const date = readOdbcDate(dts);
      if (date === null || !dts.moveIfSpaces() || dayNotInMonth(date[2], date[1], date[0])) return null;
      const time = readOdbcTime(dts);
      if (time === null) return null;
      const zoned = parseOffset(dts, date, time);
      if (!closesOdbc(dts)) return null;
      return zoned ?? createDateTime(date[0], date[1], date[2], time[0], time[1], time[2]) + time[3];
    }
    if (dts.moveIfSpaces() && dts.moveIfCurrent("'")) {
      const time = readOdbcTime(dts);
      if (time === null) return null;
      const zoned = parseOffset(dts, [1899, 12, 30], time);
      if (!closesOdbc(dts)) return null;
      return zoned ?? createDateTime(-1, 12, 30, time[0], time[1], time[2]) + time[3];
    }
  } else if (dts.moveIfCurrentIgnorecase('d') && dts.moveIfSpaces() && dts.moveIfCurrent("'")) {
    const date = readOdbcDate(dts);
    if (date === null || dayNotInMonth(date[2], date[1], date[0])) return null;
    dts.skipSpaces();
    return closesOdbc(dts) ? createDateTime(date[0], date[1], date[2], 0, 0, 0) : null;
  }
  return null;
}

/** CFDateTimeParser.parseDateTime of Java-trimmed text: the instant, or null when it is no date; throws where ACF throws. */
export function cfDateTimeInstant(text: string): number | null {
  if (text.length > MAX_TEXT) return null;
  const close = text.length > 2 && text.charAt(0) === '{' ? text.indexOf('}', 1) : -1;
  return close === -1 ? parseDate(new DateTimeString(text), false) : parseTimeStamps(text.slice(1, close));
}
