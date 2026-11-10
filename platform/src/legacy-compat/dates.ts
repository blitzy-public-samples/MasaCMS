// ColdFusion date arithmetic and masks as ACF 2023 renders them (en_US, process TZ = legacy server zone).

type Flavor = 'datetime' | 'date' | 'time';

interface Fields {
  year: number;
  month: number;
  day: number;
  weekday: number;
  yearDay: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ACF rewrites a CF mask into a Java SimpleDateFormat pattern letter by letter; unmapped letters become literal text.
const COMMON_LETTERS: [string, string][] = [
  ['d', 'd'], ['D', 'D'], ['e', 'E'], ['E', 'E'], ['G', 'G'], ['g', 'G'], ['H', 'H'], ['h', 'h'], ['k', 'k'],
  ['K', 'K'], ['s', 's'], ['w', 'w'], ['W', 'W'], ['F', 'F'], ['f', 'F'], ['z', 'z'], ['Z', 'Z'], ['X', 'X'],
];
const LETTERS: Record<Flavor, Map<string, string>> = {
  datetime: new Map([...COMMON_LETTERS, ['m', 'M'], ['M', 'M'], ['y', 'y'], ['Y', 'y'], ['n', 'm'], ['N', 'm'],
    ['S', 's'], ['l', 'S'], ['L', 'S'], ['t', 'a'], ['T', 'a']]),
  date: new Map([...COMMON_LETTERS, ['m', 'M'], ['M', 'M'], ['y', 'y'], ['Y', 'y'], ['S', 'S']]),
  time: new Map([...COMMON_LETTERS, ['m', 'm'], ['M', 'm'], ['n', 'm'], ['N', 'm'], ['y', 'y'], ['Y', 'Y'],
    ['S', 's'], ['l', 'S'], ['L', 'S'], ['t', 'a'], ['T', 'a']]),
};

// Separators ACF copies into the pattern unquoted; any other literal run is wrapped in its own quotes.
const RAW_SEPARATORS: Record<Flavor, string> = { datetime: ' /-:', date: ' /-', time: ' /-:' };

// Named masks (case-insensitive) as the Java patterns ACF uses; long/full/iso time styles print zone names or offsets.
const DATE_STYLES = new Map([
  ['short', 'M/d/yy'],
  ['medium', 'MMM d, y'],
  ['long', 'MMMM d, y'],
  ['full', 'EEEE, MMMM d, y'],
  ['iso', 'yyyy-MM-dd'],
]);
const TIME_STYLES = new Map([
  ['short', 'h:mm a'],
  ['medium', 'h:mm:ss a'],
]);

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function fieldsOf(d: Date, utc: boolean): Fields {
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid date');
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  const month = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = utc ? d.getUTCDate() : d.getDate();
  return {
    year,
    month,
    day,
    weekday: utc ? d.getUTCDay() : d.getDay(),
    yearDay: (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000 + 1,
    hour: utc ? d.getUTCHours() : d.getHours(),
    minute: utc ? d.getUTCMinutes() : d.getMinutes(),
    second: utc ? d.getUTCSeconds() : d.getSeconds(),
    ms: utc ? d.getUTCMilliseconds() : d.getMilliseconds(),
  };
}

/** Rewrites a CF mask into the Java pattern ACF hands to SimpleDateFormat. */
function toJavaPattern(mask: string, flavor: Flavor): string {
  const letters = LETTERS[flavor];
  let out = '';
  let literal = '';
  const flush = (): void => {
    if (literal) out += `'${literal}'`;
    literal = '';
  };
  let i = 0;
  while (i < mask.length) {
    const ch = mask.charAt(i);
    if (ch === "'") {
      // Each quoted span becomes its own quoted group; abutting groups therefore print a stray quote ('at'.q -> at'.q).
      flush();
      const end = mask.indexOf("'", i + 1);
      const text = end < 0 ? mask.slice(i + 1) : mask.slice(i + 1, end);
      out += text ? `'${text}'` : "''";
      i = end < 0 ? mask.length : end + 1;
      continue;
    }
    let run = 0;
    while (/[dD]/.test(mask.charAt(i + run))) run++;
    if (run >= 3) {
      // Three or more d/D in any case are a day name: ddd -> Thu, dddd -> Thursday.
      flush();
      out += 'E'.repeat(run);
      i += run;
      continue;
    }
    const java = letters.get(ch);
    if (java || RAW_SEPARATORS[flavor].includes(ch)) {
      flush();
      out += java ?? ch;
    } else {
      literal += ch;
    }
    i++;
  }
  flush();
  return out;
}

/** Formats one run of a Java pattern letter. */
function javaField(letter: string, count: number, f: Fields, fullMarker: boolean): string {
  switch (letter) {
    case 'G':
      return 'AD';
    case 'y':
      return count === 2 ? pad(f.year % 100, 2) : pad(f.year, count);
    case 'M': {
      const name = MONTHS[f.month - 1] as string;
      if (count >= 4) return name;
      return count === 3 ? name.slice(0, 3) : pad(f.month, count);
    }
    case 'd':
      return pad(f.day, count);
    case 'D':
      return pad(f.yearDay, count);
    case 'E': {
      const name = DAYS[f.weekday] as string;
      return count >= 4 ? name : name.slice(0, 3);
    }
    case 'H':
      return pad(f.hour, count);
    case 'h':
      return pad(f.hour % 12 || 12, count);
    case 'k':
      return pad(f.hour || 24, count);
    case 'K':
      return pad(f.hour % 12, count);
    case 'm':
      return pad(f.minute, count);
    case 's':
      return pad(f.second, count);
    case 'S':
      return pad(f.ms, count);
    case 'a': {
      const marker = f.hour < 12 ? 'AM' : 'PM';
      return fullMarker ? marker : marker.charAt(0);
    }
    default:
      // Java week and zone fields (w W F Y z Z X); no legacy call site uses them, so they fail fast instead of diverging.
      throw new RangeError(`Unsupported ColdFusion mask field '${letter}'`);
  }
}

/** Renders a Java SimpleDateFormat pattern: quoted text, '' as a quote, runs of one letter as a field. */
function renderJava(f: Fields, pattern: string, fullMarker: boolean): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === "'") {
      if (pattern.charAt(i + 1) === "'") {
        out += "'";
        i += 2;
        continue;
      }
      for (i++; i < pattern.length; i++) {
        if (pattern.charAt(i) !== "'") out += pattern.charAt(i);
        else if (pattern.charAt(i + 1) === "'") out += pattern.charAt(++i);
        else break;
      }
      i++;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) {
      out += ch;
      i++;
      continue;
    }
    let count = 1;
    while (pattern.charAt(i + count) === ch) count++;
    out += javaField(ch, count, f, fullMarker);
    i += count;
  }
  return out;
}

function format(f: Fields, mask: string, flavor: Flavor): string {
  const key = mask.toLowerCase();
  const date = DATE_STYLES.get(key);
  const time = TIME_STYLES.get(key);
  if (flavor === 'date' && date) return renderJava(f, date, true);
  if (flavor === 'time' && time) return renderJava(f, time, true);
  if (flavor === 'datetime' && date && time) return renderJava(f, `${date}, ${time}`, true);
  if (key === 'long' || key === 'full' || key === 'iso') throw new RangeError(`Unsupported ColdFusion named mask '${mask}'`);
  // A single t prints A/P unless "tt" appears anywhere in the mask, quoted text included (t'tt' -> PMtt).
  return renderJava(f, toJavaPattern(mask, flavor), /tt/i.test(mask));
}

const DAY_MS = 86_400_000;

/** Local zone offset at instant t, in ms east of UTC. */
const offsetAt = (t: number): number => -new Date(t).getTimezoneOffset() * 60_000;

/** Instant of a local wall-clock time (fields read as UTC) as GregorianCalendar resolves it: a repeated time takes the later offset, a skipped one the earlier. */
function wallToInstant(wall: number): number {
  const later = offsetAt(wall + DAY_MS);
  return offsetAt(wall - later) === later ? wall - later : wall - offsetAt(wall - DAY_MS);
}

/** GregorianCalendar.add(MONTH): same day clamped to month end, wall-clock time re-resolved in the new month. */
function addMonths(d: Date, months: number): Date {
  const wall = new Date(d.getTime() + offsetAt(d.getTime()));
  const day = wall.getUTCDate();
  wall.setUTCDate(1);
  wall.setUTCMonth(wall.getUTCMonth() + months);
  const monthEnd = new Date(wall.getTime());
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  wall.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return new Date(wallToInstant(wall.getTime()));
}

/** GregorianCalendar.add(DATE): the wall-clock time at the old offset, moved to the new offset unless that changes the date. */
function addDays(d: Date, days: number): Date {
  const before = offsetAt(d.getTime());
  const wall = d.getTime() + before + days * DAY_MS;
  const first = wall - before;
  const after = offsetAt(first);
  if (after === before) return new Date(first);
  const second = wall - after;
  return new Date(Math.floor((second + offsetAt(second)) / DAY_MS) === Math.floor(wall / DAY_MS) ? second : first);
}

/** CFML dateAdd: n truncates toward zero; yyyy/m clamp to month end; d keeps the wall-clock time across DST; h/n/s/l add exact ms. */
export function cfDateAdd(part: 'yyyy' | 'm' | 'd' | 'h' | 'n' | 's' | 'l', n: number, d: Date): Date {
  const amount = Math.trunc(n);
  // GregorianCalendar.add returns at once for 0, so a repeated-hour instant keeps its offset.
  if (amount === 0) return new Date(d.getTime());
  switch (part) {
    case 'yyyy':
      return addMonths(d, amount * 12);
    case 'm':
      return addMonths(d, amount);
    case 'd':
      return addDays(d, amount);
    case 'h':
      return new Date(d.getTime() + amount * 3_600_000);
    case 'n':
      return new Date(d.getTime() + amount * 60_000);
    case 's':
      return new Date(d.getTime() + amount * 1_000);
    case 'l':
      return new Date(d.getTime() + amount);
  }
}

/** CFML dateTimeFormat: d day, D/DD day-of-year, ddd+ day name, m/M month (even after an hour), n minutes, s/S seconds, l/L ms, t A/P, tt AM/PM, y/Y calendar year. */
export function cfDateTimeFormat(d: Date, mask: string): string {
  return format(fieldsOf(d, false), mask, 'datetime');
}

// Admin views render LSDateFormat(date, session.dateKeyFormat) (cusers/list.cfm:227); en_US dateKeyFormat is 'MM/DD/YYYY' (resourceBundle/utils.cfc:328-379), so 10/302/2026.
/** CFML DateFormat: d day, D/DD day-of-year, ddd+ day name, m/M month, y/Y calendar year, s seconds, S ms; named short/medium/long/full. */
export function cfDateFormat(d: Date, mask: string): string {
  return format(fieldsOf(d, false), mask, 'date');
}

/** CFML LSDateFormat for locale en_US, which ACF renders exactly as DateFormat. */
export const cfLsDateFormat: (d: Date, mask: string) => string = cfDateFormat;

/** CFML TimeFormat: h/H hours, m/M/n minutes, s/S seconds, l/L ms, t A/P, tt AM/PM; named short/medium. */
export function cfTimeFormat(d: Date, mask: string): string {
  return format(fieldsOf(d, false), mask, 'time');
}

/** CSRF token expiry string, 15 digits (sessionUserFacade.cfc:228,246). */
export function formatCsrfExpires(d: Date): string {
  return cfDateTimeFormat(d, 'yyMMddHHnnsslll');
}

/** Cookie `expires` value in GMT after DateConvert('local2Utc') (utility.cfc:845-846). */
export function formatCookieExpires(d: Date): string {
  const f = fieldsOf(d, true);
  return `${format(f, 'ddd, dd-mmm-yyyy', 'date')} ${format(f, 'HH:mm:ss', 'time')} GMT`;
}

/** Serializer `date` hint value: yyyy-mm-ddTHH:mm:ss in local time (jsonSerializer.cfc:219). */
export function formatSerializerDate(d: Date): string {
  return `${cfDateFormat(d, 'yyyy-mm-dd')}T${cfTimeFormat(d, 'HH:mm:ss')}`;
}

/** Zone offset in minutes east of UTC as moment.getArbitraryTimeOffset computes it (moment.cfc:187-193). */
function legacyUtcOffsetMinutes(d: Date): number {
  // The instant looked up is shifted by the local 1970-01-01 offset, so results lag DST changes by that offset.
  const seconds = Math.trunc((d.getTime() - new Date(1970, 0, 1).getTime()) / 1000);
  return -new Date(seconds * 1000).getTimezoneOffset();
}

/** Serializer `utcdate` hint value (jsonSerializer.cfc:223-235); offsetMinutes defaults to legacy's zone lookup. */
export function formatSerializerUtcDate(d: Date, offsetMinutes: number = legacyUtcOffsetMinutes(d)): string {
  const hour = d.getHours();
  const minute = d.getMinutes();
  const date = cfDateFormat(d, 'yyyy-mm-dd');
  if ((hour === 0 && minute === 0) || (hour === 23 && minute === 59)) return date;
  // CFML int() floors; each part is padded only when the signed value is < 10 (-10 h gives '-010:00').
  const offsetHour = Math.floor(offsetMinutes / 60);
  const offsetMinute = Math.abs(offsetMinutes - offsetHour * 60);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const hh = offsetHour < 10 ? `0${Math.abs(offsetHour)}` : String(offsetHour);
  const mm = offsetMinute < 10 ? `0${offsetMinute}` : String(offsetMinute);
  return `${date}T${cfTimeFormat(d, 'HH:mm:ss')}${sign}${hh}:${mm}`;
}
