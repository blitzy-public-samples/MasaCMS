// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/

/** Clock-free calendar anchored on the business date; every value it returns is a zone-less local wall-clock string. */
export interface Calendar {
  /** Day offset 0, `yyyy-MM-dd`. */
  readonly businessDate: string;
  /** `yyyy-MM-dd` of the day `dayOffset` days from the business date. */
  localDate(dayOffset: number): string;
  /** `yyyy-MM-ddTHH:mm:ss.SSS` at `minutes` after local midnight of `dayOffset` (values outside 0..1439 roll into neighbouring days); `ms` is a multiple of 10 in 0..990. */
  localTimestamp(dayOffset: number, minutes: number, ms?: number): string;
  /** Timestamp `ts` moved by `minutes`, which may be negative. */
  addMinutes(ts: string, minutes: number): string;
  /** Day offset of the `yyyy-MM-dd` date `date`. */
  dayOffsetOf(date: string): number;
  /** Day of the week, 0 Sunday to 6 Saturday. */
  weekday(dayOffset: number): number;
  /** True for Monday to Friday. */
  isWeekday(dayOffset: number): boolean;
  /** Day offset of the Monday on or before `dayOffset`. */
  mondayOnOrBefore(dayOffset: number): number;
  /** Negative, zero or positive as timestamp `a` sorts before, with or after timestamp `b`. */
  compareTimestamps(a: string, b: string): number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;
// SQL Server `datetime` years; also keeps every value fixed-width, so string order is time order.
const MIN_YEAR = 1753;
const MAX_YEAR = 9999;
const DATE_FORM = `a yyyy-MM-dd date in years ${MIN_YEAR}..${MAX_YEAR}`;
// datetime stores 1/300 s ticks; only whole tens of milliseconds (3 ticks) load back unchanged.
const TIMESTAMP_FORM = `a yyyy-MM-ddTHH:mm:ss.SSS timestamp in years ${MIN_YEAR}..${MAX_YEAR} with milliseconds a multiple of 10`;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

// Epoch milliseconds hold the wall clock as if it were UTC, so no host time zone ever applies.
function iso(epochMs: number): string {
  const d = new Date(epochMs);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
  const time = `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}`;
  return `${date}T${time}`;
}

function inRange(epochMs: number): boolean {
  const year = new Date(epochMs).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

function fail(fn: string, name: string, expected: string, value: string | number): never {
  throw new RangeError(`${fn}: ${name} must be ${expected}, got ${typeof value === 'string' ? JSON.stringify(value) : value}`);
}

function integer(fn: string, name: string, value: number): number {
  if (!Number.isSafeInteger(value)) fail(fn, name, 'a safe integer', value);
  return value;
}

function emit(fn: string, epochMs: number): string {
  if (!inRange(epochMs)) throw new RangeError(`${fn}: result falls outside the datetime years ${MIN_YEAR}..${MAX_YEAR}`);
  return iso(epochMs);
}

function parseDate(fn: string, name: string, text: string): number {
  const m = DATE.exec(text);
  const epochMs = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
  if (!inRange(epochMs) || iso(epochMs).slice(0, 10) !== text) fail(fn, name, DATE_FORM, text);
  return epochMs;
}

function parseTimestamp(fn: string, name: string, text: string): number {
  const m = TIMESTAMP.exec(text);
  const epochMs = m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]))
    : Number.NaN;
  if (!inRange(epochMs) || iso(epochMs) !== text || Number(m?.[7]) % 10 !== 0) fail(fn, name, TIMESTAMP_FORM, text);
  return epochMs;
}

/** Calendar whose day offset 0 is `businessDate` (`yyyy-MM-dd`); throws `RangeError` for any other form or an impossible date. */
export function createCalendar(businessDate: string): Calendar {
  const base = parseDate('createCalendar', 'businessDate', businessDate);

  const dayEpoch = (fn: string, dayOffset: number): number => {
    const epochMs = base + integer(fn, 'dayOffset', dayOffset) * DAY_MS;
    if (!inRange(epochMs)) fail(fn, 'dayOffset', `within the datetime years ${MIN_YEAR}..${MAX_YEAR}`, dayOffset);
    return epochMs;
  };

  const localDate = (dayOffset: number): string => iso(dayEpoch('localDate', dayOffset)).slice(0, 10);

  const localTimestamp = (dayOffset: number, minutes: number, ms = 0): string => {
    integer('localTimestamp', 'dayOffset', dayOffset);
    integer('localTimestamp', 'minutes', minutes);
    if (!Number.isInteger(ms) || ms < 0 || ms > 990 || ms % 10 !== 0) {
      fail('localTimestamp', 'ms', 'a multiple of 10 in 0..990', ms);
    }
    return emit('localTimestamp', base + dayOffset * DAY_MS + minutes * MINUTE_MS + ms);
  };

  const addMinutes = (ts: string, minutes: number): string =>
    emit('addMinutes', parseTimestamp('addMinutes', 'ts', ts) + integer('addMinutes', 'minutes', minutes) * MINUTE_MS);

  const dayOffsetOf = (date: string): number => (parseDate('dayOffsetOf', 'date', date) - base) / DAY_MS;

  const weekday = (dayOffset: number): number => new Date(dayEpoch('weekday', dayOffset)).getUTCDay();

  const isWeekday = (dayOffset: number): boolean => {
    const day = weekday(dayOffset);
    return day >= 1 && day <= 5;
  };

  const mondayOnOrBefore = (dayOffset: number): number => dayOffset - ((weekday(dayOffset) + 6) % 7);

  const compareTimestamps = (a: string, b: string): number => {
    parseTimestamp('compareTimestamps', 'a', a);
    parseTimestamp('compareTimestamps', 'b', b);
    return a < b ? -1 : a > b ? 1 : 0;
  };

  return Object.freeze({
    businessDate,
    localDate,
    localTimestamp,
    addMinutes,
    dayOffsetOf,
    weekday,
    isWeekday,
    mondayOnOrBefore,
    compareTimestamps,
  });
}
