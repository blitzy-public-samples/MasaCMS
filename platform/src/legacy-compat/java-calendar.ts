// java.util.GregorianCalendar day arithmetic in the process time zone (the legacy server's): Julian before 1582-10-15.
export const DAY_MS = 86_400_000;

/** Epoch day of 1582-10-15, GregorianCalendar's default cutover. */
const CUTOVER_DAY = -141_427;
/** Largest instant a JS Date holds. */
const MAX_TIME = 8.64e15;
/** 1900-01-01T00:00:00Z, where java.util.TimeZone's transition table starts. */
const UTC_1900 = -2_208_988_800_000;
/** GregorianCalendar.getMaximum(YEAR). */
const MAX_JAVA_YEAR = 292_278_994;
/** Long.MAX_VALUE, the last instant a java.util.Date holds. */
export const JAVA_LONG_MAX = 9_223_372_036_854_775_807;

/** A calendar date and wall-clock time; `month` is 1-12. */
export interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}


/** Days from 1970-01-01 of a proleptic Gregorian date (month 1-12; excess days roll forward). */
function gregorianDay(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

/** Days from 1970-01-01 of a Julian calendar date. */
function julianDay(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 4);
  const doy = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  return era * 1461 + (y - era * 4) * 365 + doy - 719_470;
}

/** Date part of a day count from a 4-year (Julian) or 400-year (Gregorian) cycle position, March-based. */
function dateOf(yearOfEra: number, dayOfYear: number, eraStart: number): Pick<Civil, 'year' | 'month' | 'day'> {
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: eraStart + yearOfEra + (month <= 2 ? 1 : 0), month, day: dayOfYear - Math.floor((153 * mp + 2) / 5) + 1 };
}

/** Epoch day of a date as GregorianCalendar computes it: Gregorian from the cutover, Julian before. */
export function javaEpochDay(year: number, month: number, day: number): number {
  const gregorian = gregorianDay(year, month, day);
  return gregorian >= CUTOVER_DAY ? gregorian : julianDay(year, month, day);
}

/** The GregorianCalendar date of an epoch day. */
export function javaDateOf(epochDay: number): Pick<Civil, 'year' | 'month' | 'day'> {
  if (epochDay >= CUTOVER_DAY) {
    const z = epochDay + 719_468;
    const era = Math.floor(z / 146_097);
    const doe = z - era * 146_097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
    return dateOf(yoe, doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), era * 400);
  }
  const z = epochDay + 719_470;
  const era = Math.floor(z / 1461);
  const doe = z - era * 1461;
  const yoe = Math.floor((doe - Math.floor(doe / 1460)) / 365);
  return dateOf(yoe, doe - 365 * yoe, era * 4);
}

/** Whether year/month/day name a day GregorianCalendar accepts in non-lenient mode (YEAR 1 to 292278994). */
export function isJavaDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > MAX_JAVA_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const back = javaDateOf(javaEpochDay(year, month, day));
  return back.year === year && back.month === month && back.day === day;
}

/** GregorianCalendar.isLeapYear: Julian rule through 1582. */
export function isJavaLeapYear(year: number): boolean {
  return year % 4 === 0 && (year <= 1582 || year % 100 !== 0 || year % 400 === 0);
}

/** Day of week of an epoch day, 1 = Sunday … 7 = Saturday as Calendar.DAY_OF_WEEK. */
export function javaDayOfWeek(epochDay: number): number {
  return ((((epochDay + 4) % 7) + 7) % 7) + 1;
}

/** A java.util.TimeZone: the process zone (undefined), an IANA zone id, or a fixed offset in ms east of UTC. */
export type JavaZone = string | number | undefined;

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** An IANA zone's (or the process zone's) offset at `t` to the second (Date.getTimezoneOffset drops the seconds of old local mean times). */
function tzdbOffset(t: number, zone: string | undefined): number {
  const key = zone ?? `TZ=${process.env.TZ ?? ''}`;
  let format = offsetFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    offsetFormats.set(key, format);
  }
  const name = format.formatToParts(t).find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = /^GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(name);
  if (match === null) throw new RangeError(`Unreadable time-zone offset '${name}'`);
  const [, sign = '+', hours = '0', minutes = '0', seconds = '0'] = match;
  return (sign === '-' ? -1 : 1) * ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** java.util.TimeZone's raw offset: the zone's current standard (least) offset over this year. */
function rawOffset(zone: string | undefined): number {
  const year = new Date().getUTCFullYear();
  return Math.min(...Array.from({ length: 24 }, (_, k) => tzdbOffset(Date.UTC(year, k >> 1, k % 2 === 0 ? 1 : 15), zone)));
}

/** java.util.TimeZone offset at `t` in ms east of UTC: the raw offset before 1900 (ZoneInfo keeps no earlier history). */
export function zoneOffset(t: number, zone?: JavaZone): number {
  if (typeof zone === 'number') return zone;
  return t < UTC_1900 ? rawOffset(zone) : tzdbOffset(Math.min(MAX_TIME, t), zone);
}

/** Wall-clock milliseconds of a civil value: its UTC instant, excess days rolling forward. */
export function utcInstant(c: Civil): number {
  return javaEpochDay(c.year, c.month, c.day) * DAY_MS + ((c.hour * 60 + c.minute) * 60 + c.second) * 1000 + c.ms;
}

/** The offset a lenient GregorianCalendar gives a local wall time: the later one for a repeated time, the earlier for a skipped one. */
function wallOffset(wall: number, zone?: JavaZone): number {
  const later = zoneOffset(wall + DAY_MS, zone);
  return zoneOffset(wall - later, zone) === later ? later : zoneOffset(wall - DAY_MS, zone);
}

/** Instant of a wall time in `zone` (the process zone by default) as a lenient GregorianCalendar resolves it. */
export function localInstant(c: Civil, zone?: JavaZone): number {
  const wall = utcInstant(c);
  return wall - wallOffset(wall, zone);
}

/** Whether a local wall time exists in the process zone (no forward offset change skips it). */
export function isLocalTime(c: Civil): boolean {
  const wall = utcInstant(c);
  const offset = wallOffset(wall);
  return zoneOffset(wall - offset) === offset;
}

/** GregorianCalendar.add(DATE, days) from `t`: the wall time at the old offset, moved to the new offset unless that changes the date. */
export function addLocalDays(t: number, days: number): number {
  const before = zoneOffset(t);
  const wall = t + before + days * DAY_MS;
  const first = wall - before;
  const after = zoneOffset(first);
  if (after === before) return first;
  const second = wall - after;
  return Math.floor((second + zoneOffset(second)) / DAY_MS) === Math.floor(wall / DAY_MS) ? second : first;
}

/** Civil fields of an instant in `zone` (the process zone by default). */
export function localCivil(t: number, zone?: JavaZone): Civil {
  const wall = t + zoneOffset(t, zone);
  const epochDay = Math.floor(wall / DAY_MS);
  let rest = wall - epochDay * DAY_MS;
  const ms = rest % 1000;
  rest = (rest - ms) / 1000;
  return { ...javaDateOf(epochDay), hour: Math.floor(rest / 3600), minute: Math.floor(rest / 60) % 60, second: rest % 60, ms };
}

/** Instant of a local wall time in a non-lenient GregorianCalendar; undefined when a field is out of range or the time is skipped. */
export function strictLocalInstant(c: Civil): number | undefined {
  if (!isJavaDate(c.year, c.month, c.day) || !validTime(c) || !isLocalTime(c)) return undefined;
  const t = localInstant(c);
  return t <= JAVA_LONG_MAX ? t : undefined;
}

/** Instant of civil fields in a non-lenient UTC GregorianCalendar; undefined when a field is out of range. */
export function strictUtcInstant(c: Civil): number | undefined {
  if (!isJavaDate(c.year, c.month, c.day) || !validTime(c)) return undefined;
  const t = utcInstant(c);
  return t <= JAVA_LONG_MAX ? t : undefined;
}

function validTime(c: Civil): boolean {
  return c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59 && c.second >= 0 && c.second <= 59 && c.ms >= 0 && c.ms <= 999;
}

/** A JS Date of an instant; throws RangeError when JS cannot represent it. */
export function toDate(t: number): Date {
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) throw new RangeError('The date is outside the JS Date range');
  return date;
}
