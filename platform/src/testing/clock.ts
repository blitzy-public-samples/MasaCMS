import { fixedClock, type Clock } from '../service-kit/index.js';

export { fixedClock, systemClock, isClock, type Clock } from '../service-kit/index.js';

/** The seed's business date (`legacy-fixtures/seed/seed.config.json`), used as `asOf`. */
export const BUSINESS_DATE = '2026-06-30' as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** `yyyy-mm-dd` of `date` as a local calendar date. Throws RangeError when `date` is not a valid date. */
export function asOf(date: string | Date = BUSINESS_DATE): string {
  const dateOnly = typeof date === 'string' && DATE_ONLY.test(date);
  const value = typeof date === 'string' ? new Date(dateOnly ? `${date}T00:00:00` : date) : date;
  const result = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1, 2)}-${pad(value.getDate(), 2)}`;
  // A date-only string with an out-of-range day rolls over instead of failing to parse.
  if (Number.isNaN(value.getTime()) || (dateOnly && result !== date)) {
    throw new RangeError(`Invalid asOf date: ${String(date)}`);
  }
  return result;
}

/** Clock frozen at `time` (local `HH:mm:ss`) on the business date. */
export function businessClock(time = '12:00:00'): Clock {
  return fixedClock(`${BUSINESS_DATE}T${time}`);
}
