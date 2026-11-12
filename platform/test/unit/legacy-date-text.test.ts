// CFML text dates against ACF 2023 (hotfix 26, Java 17, English (US) unless a row names a locale): every expected value
// is the legacy engine's result for that process zone, with the clock at ORACLE_NOW; 'zone' and 'skipped' rows are the
// cases the port fails closed on.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cfIsDateText,
  cfLsIsDate,
  cfLsParseDateTime,
  cfParseDateTimeText,
  cfTimestampParam,
  sqlServerDatetime,
} from '../../src/legacy-compat/date-text.js';
import { LegacyServiceUnavailableError } from '../../src/legacy-compat/errors.js';
import { masaCf2Java } from '../../src/legacy-compat/masa-locale.js';

/** When the oracle values were taken: two-digit-year windows and month-day years follow the clock. */
const ORACLE_NOW = new Date('2026-11-11T23:01:22Z');
const SYSTEM_TZ = process.env.TZ;

/** Runs `run` with the process time zone set to `zone`, restoring the original zone afterwards. */
function withZone<T>(zone: string, run: () => T): T {
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (SYSTEM_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = SYSTEM_TZ;
  }
}

/** A call's result as an ISO instant or boolean, or the kind of error it throws. */
function outcome(run: () => Date | boolean): string | boolean {
  try {
    const value = run();
    return typeof value === 'boolean' ? value : value.toISOString();
  } catch (error) {
    if (error instanceof LegacyServiceUnavailableError) return error.reason === 'datetime-skipped-time' ? 'skipped' : 'zone';
    if (error instanceof RangeError) return 'range';
    const { message } = error as Error;
    if (message.endsWith('cannot be converted to a date.')) return 'not-a-date';
    if (message.endsWith('is an invalid date or time string.') || message.endsWith('is not a valid date/time format.')) return 'invalid';
    if (message === 'The cf_sql_timestamp value is empty') return 'empty';
    return 'error';
  }
}

/** The datetime column's expected outcome: `param` unchanged (true), its stored value (text), or SQL Server's error (false). */
const stored = (column: boolean | string, param: string): string => (typeof column === 'string' ? column : column ? param : 'error');

interface OracleRow {
  zone: string;
  text: string;
  lsIsDate: boolean | 'zone';
  ls: string;
  isDate: boolean | 'error';
  parsed: string;
  param: string;
  /** Whether SQL Server's datetime column takes the bound timestamp, or the value it stores where that differs. */
  column?: boolean | string;
}

describe('CFML text dates (LSIsDate, LSParseDateTime, isDate, parseDateTime, cf_sql_timestamp)', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ORACLE_NOW);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it.each<OracleRow>([
    { zone: 'UTC', text: '11/12/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '1/2/26', lsIsDate: true, ls: '2026-01-02T00:00:00.000Z',
      isDate: true, parsed: '2026-01-02T00:00:00.000Z', param: '2026-01-02T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '01/02/2026', lsIsDate: true, ls: '2026-01-02T00:00:00.000Z',
      isDate: true, parsed: '2026-01-02T00:00:00.000Z', param: '2026-01-02T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '1/1/30', lsIsDate: true, ls: '2030-01-01T00:00:00.000Z',
      isDate: true, parsed: '1930-01-01T00:00:00.000Z', param: '1930-01-01T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '1/2/46', lsIsDate: true, ls: '2046-01-02T00:00:00.000Z',
      isDate: true, parsed: '1946-01-02T00:00:00.000Z', param: '1946-01-02T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '12/1/46', lsIsDate: true, ls: '1946-12-01T00:00:00.000Z',
      isDate: true, parsed: '1946-12-01T00:00:00.000Z', param: '1946-12-01T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '11.12.2026', lsIsDate: true, ls: '2026-12-11T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '13/01/2026', lsIsDate: true, ls: '2026-01-13T00:00:00.000Z',
      isDate: true, parsed: '2026-01-13T00:00:00.000Z', param: '2026-01-13T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '02/29/2028', lsIsDate: true, ls: '2028-02-29T00:00:00.000Z',
      isDate: true, parsed: '2028-02-29T00:00:00.000Z', param: '2028-02-29T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '02/30/2026', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 10:30 AM', lsIsDate: true, ls: '2026-11-12T10:30:00.000Z',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 PM', lsIsDate: true, ls: '2026-11-12T22:30:00.000Z',
      isDate: true, parsed: '2026-11-12T22:30:00.000Z', param: '2026-11-12T22:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 14:30', lsIsDate: true, ls: '2026-11-12T14:30:00.000Z',
      isDate: true, parsed: '2026-11-12T14:30:00.000Z', param: '2026-11-12T14:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 9:05', lsIsDate: true, ls: '2026-11-12T09:05:00.000Z',
      isDate: true, parsed: '2026-11-12T09:05:00.000Z', param: '2026-11-12T09:05:00.000Z', column: true },
    { zone: 'UTC', text: '2026-11-12 14:30', lsIsDate: true, ls: '2026-11-12T14:30:00.000Z',
      isDate: true, parsed: '2026-11-12T14:30:00.000Z', param: '2026-11-12T14:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 22:30:15', lsIsDate: true, ls: '2026-11-12T22:30:15.000Z',
      isDate: true, parsed: '2026-11-12T22:30:15.000Z', param: '2026-11-12T22:30:15.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30:15.123', lsIsDate: true, ls: '2026-11-12T10:30:15.000Z',
      isDate: true, parsed: '2026-11-12T10:30:15.123Z', param: '2026-11-12T10:30:15.123Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30:15.9995', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:16.000Z', param: '2026-11-12T10:30:16.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 12:00 AM', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026, 10:30 AM', lsIsDate: true, ls: '2026-11-12T10:30:00.000Z',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '2026-11-12', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '2026-11-12T10:30:15', lsIsDate: true, ls: '2026-11-12T10:30:15.000Z',
      isDate: true, parsed: '2026-11-12T10:30:15.000Z', param: '2026-11-12T10:30:15.000Z', column: true },
    { zone: 'UTC', text: '2026-11-12T10:30:15Z', lsIsDate: true, ls: '2026-11-12T10:30:15.000Z',
      isDate: true, parsed: '2026-11-12T10:30:15.000Z', param: '2026-11-12T10:30:15.000Z', column: true },
    { zone: 'UTC', text: '2026-11-12T10:30:15+05:00', lsIsDate: true, ls: '2026-11-12T05:30:15.000Z',
      isDate: true, parsed: '2026-11-12T05:30:15.000Z', param: '2026-11-12T05:30:15.000Z', column: true },
    { zone: 'UTC', text: '{ts \'2026-11-12 10:30:00\'}', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '{ts \'2026-11-12 10:30:00.123\'}', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.123Z', param: '2026-11-12T10:30:00.123Z', column: true },
    { zone: 'UTC', text: '{ts \'2026-11-12 10:30:00+05:00\'}', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T05:30:00.000Z', param: '2026-11-12T05:30:00.000Z', column: true },
    { zone: 'UTC', text: '{ts \'2026-11-12 10:30\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{d \'2026-11-12\'}', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '{t \'10:30:00\'}', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '1999-12-30T10:30:00.000Z', param: '1999-12-30T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '{ts \'2026-11-12 10:30:00\'} trailing', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: 'Nov 12, 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: 'November 12, 2026 10:30 AM', lsIsDate: true, ls: '2026-11-12T10:30:00.000Z',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: 'Thursday, November 12, 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: 'Monday, November 12, 2026', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: 'Thu, 12 Nov 2026 10:30:00 GMT', lsIsDate: true, ls: '2026-11-12T10:30:00.000Z',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: 'Thu, 12 Nov 2026 10:30:00 +0500', lsIsDate: true, ls: '2026-11-12T05:30:00.000Z',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: 'Nov 12', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: 'Nov 2026', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-01T00:00:00.000Z', param: '2026-11-01T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '12 Nov 2026', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: 'Sept 12, 2026', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-09-12T00:00:00.000Z', param: '2026-09-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: 'Thu Nov 12 10:30:00 2026', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: 'Thu Nov 12 10:30:00.5 GMT 2026', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.500Z', param: '2026-11-12T10:30:00.500Z', column: true },
    { zone: 'UTC', text: '10:30:15 AM Nov 12, 2026', lsIsDate: true, ls: '2026-11-12T10:30:15.000Z',
      isDate: true, parsed: '2026-11-12T10:30:15.000Z', param: '2026-11-12T10:30:15.000Z', column: true },
    { zone: 'UTC', text: '10:30:15 AM GMT', lsIsDate: true, ls: '1899-12-30T10:30:15.000Z',
      isDate: true, parsed: '1899-12-30T10:30:15.000Z', param: '1899-12-30T10:30:15.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 EST', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T15:30:00.000Z', param: '2026-11-12T15:30:00.000Z' },
    { zone: 'UTC', text: '11/12/2026 10:30:15 AM EST', lsIsDate: 'zone', ls: 'zone',
      isDate: true, parsed: '2026-11-12T15:30:15.000Z', param: '2026-11-12T15:30:15.000Z' },
    { zone: 'UTC', text: '11/12/2026 10:30 GMT', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 GMT+5', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T05:30:00.000Z', param: '2026-11-12T05:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 -05:00', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T15:30:00.000Z', param: '2026-11-12T15:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 +0130', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026T10:30', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 Z', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '10:30', lsIsDate: true, ls: '1899-12-30T10:30:00.000Z',
      isDate: true, parsed: '1899-12-30T10:30:00.000Z', param: '1899-12-30T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '10:30 PM', lsIsDate: true, ls: '1899-12-30T22:30:00.000Z',
      isDate: true, parsed: '1899-12-30T22:30:00.000Z', param: '1899-12-30T22:30:00.000Z', column: true },
    { zone: 'UTC', text: '1/1/1500', lsIsDate: true, ls: '1500-01-10T00:00:00.000Z',
      isDate: true, parsed: '1500-01-10T00:00:00.000Z', param: '1500-01-10T00:00:00.000Z', column: false },
    { zone: 'UTC', text: '2/29/1500', lsIsDate: true, ls: '1500-03-10T00:00:00.000Z',
      isDate: true, parsed: '1500-03-10T00:00:00.000Z', param: '1500-03-10T00:00:00.000Z', column: false },
    { zone: 'UTC', text: '10/10/1582', lsIsDate: false, ls: 'invalid', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'UTC', text: '31 Feb 2026', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '  11/12/2026  ', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '\t11/12/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: 'abc', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'true', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'yes', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: 'false', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: 'no', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'empty' },
    { zone: 'UTC', text: '   ', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'empty' },
    { zone: 'UTC', text: '0', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-30T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '12.5', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1900-01-11T12:00:00.000Z', column: true },
    { zone: 'UTC', text: '-1', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-29T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '+5', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1900-01-04T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '.5', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-30T12:00:00.000Z', column: true },
    { zone: 'UTC', text: '1e3', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1902-09-26T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '-Infinity', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '1899-12-30T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '1e400', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { zone: 'UTC', text: '12345', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1933-10-18T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '20261112', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '+057373-01-13T00:00:00.000Z', column: false },
    { zone: 'UTC', text: '0x1F', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '0x1Fp0', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { zone: 'UTC', text: '1d', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '1/1/1753', lsIsDate: true, ls: '1753-01-01T00:00:00.000Z',
      isDate: true, parsed: '1753-01-01T00:00:00.000Z', param: '1753-01-01T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '12/31/1752', lsIsDate: true, ls: '1752-12-31T00:00:00.000Z',
      isDate: true, parsed: '1752-12-31T00:00:00.000Z', param: '1752-12-31T00:00:00.000Z', column: false },
    { zone: 'UTC', text: '12/31/9999 23:59:59', lsIsDate: true, ls: '9999-12-31T23:59:59.000Z',
      isDate: true, parsed: '9999-12-31T23:59:59.000Z', param: '9999-12-31T23:59:59.000Z', column: true },
    { zone: 'UTC', text: '1/1/10000', lsIsDate: true, ls: '+010000-01-01T00:00:00.000Z',
      isDate: true, parsed: '+010000-01-01T00:00:00.000Z', param: '+010000-01-01T00:00:00.000Z', column: false },
    { zone: 'UTC', text: '{ts \'1752-12-31 23:59:59.999\'}', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '1752-12-31T23:59:59.999Z', param: '1752-12-31T23:59:59.999Z', column: '1753-01-01T00:00:00.000Z' },
    { zone: 'UTC', text: '2958466', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '+010000-01-01T00:00:00.000Z', column: false },
    { zone: 'UTC', text: '1/2/292278993', lsIsDate: true, ls: 'range', isDate: true, parsed: 'range', param: 'range' },
    { zone: 'UTC', text: '\u0661\u0662/\u0661/\u0662\u0660\u0662\u0666', lsIsDate: true, ls: '2026-12-01T00:00:00.000Z',
      isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'America/Sao_Paulo', text: '10/15/2017', lsIsDate: true, ls: '2017-10-15T03:00:00.000Z',
      isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'America/Sao_Paulo', text: '{d \'2017-10-15\'}', lsIsDate: false, ls: 'invalid', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'America/New_York', text: '3/8/2026 2:30 AM', lsIsDate: true, ls: '2026-03-08T07:30:00.000Z',
      isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'America/New_York', text: '11/1/2026 1:30 AM', lsIsDate: true, ls: '2026-11-01T06:30:00.000Z',
      isDate: true, parsed: '2026-11-01T06:30:00.000Z', param: '2026-11-01T06:30:00.000Z' },
    { zone: 'America/New_York', text: '1/1/1800', lsIsDate: true, ls: '1800-01-01T05:00:00.000Z',
      isDate: true, parsed: '1800-01-01T05:00:00.000Z', param: '1800-01-01T05:00:00.000Z' },
    { zone: 'America/New_York', text: '-36500', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1800-01-23T05:00:00.000Z' },
    { zone: 'America/New_York', text: '7/15/2026 10:30:15 AM GMT', lsIsDate: true, ls: '2026-07-15T09:30:15.000Z',
      isDate: true, parsed: '2026-07-15T14:30:15.000Z', param: '2026-07-15T14:30:15.000Z' },
    { zone: 'Asia/Kolkata', text: '1/1/1800', lsIsDate: true, ls: '1799-12-31T18:30:00.000Z',
      isDate: true, parsed: '1799-12-31T18:30:00.000Z', param: '1799-12-31T18:30:00.000Z' },
    { zone: 'Asia/Kolkata', text: '1/1/1906', lsIsDate: true, ls: '1905-12-31T18:38:50.000Z', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'Australia/Sydney', text: '1/15/2026 10:30:15 AM GMT', lsIsDate: true, ls: '2026-01-15T10:30:15.000Z',
      isDate: true, parsed: '2026-01-14T23:30:15.000Z', param: '2026-01-14T23:30:15.000Z' },
    { zone: 'Australia/Sydney', text: '7/15/2026 10:30:15 AM GMT', lsIsDate: true, ls: '2026-07-15T10:30:15.000Z',
      isDate: true, parsed: '2026-07-15T00:30:15.000Z', param: '2026-07-15T00:30:15.000Z' },
    { zone: 'UTC', text: '11/12/2026 10:30:15.000', lsIsDate: true, ls: '2026-11-12T10:30:15.000Z',
      isDate: true, parsed: '2026-11-12T10:30:15.000Z', param: '2026-11-12T10:30:15.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30:15.' + '0'.repeat(46) + '1', lsIsDate: true, ls: '2026-11-12T10:30:15.000Z',
      isDate: true, parsed: '2026-11-12T10:30:15.000Z', param: '2026-11-12T10:30:15.000Z', column: true },
    { zone: 'UTC', text: '10 AM', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '1899-12-30T10:00:00.000Z', param: '1899-12-30T10:00:00.000Z', column: true },
    { zone: 'UTC', text: '10 p', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '1899-12-30T22:00:00.000Z', param: '1899-12-30T22:00:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/99999999999', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '10/10/1582 10:30:15.5', lsIsDate: false, ls: 'invalid', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'UTC', text: '10/10/1582 10:30 Z', lsIsDate: false, ls: 'invalid', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'UTC', text: '11/12/2026 10:30 +05x', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 10:30 +012', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:18:00.000Z', param: '2026-11-12T10:18:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 x', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 24:00', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 10:60', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 10:30:60', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 10:30:15.', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 10:30 PM +05:00', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T17:30:00.000Z', param: '2026-11-12T17:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 AM\u3000', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T10:30:00.000Z', param: '2026-11-12T10:30:00.000Z', column: true },
    { zone: 'UTC', text: '11/12/2026 10:30 PM\u3000', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T22:30:00.000Z', param: '2026-11-12T22:30:00.000Z', column: true },
    { zone: 'UTC', text: '10:30 xyz', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '0/11', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'Thu Feb 30 10:30:00 2026', lsIsDate: false, ls: 'invalid', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'UTC', text: '12 Nov', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T00:00:00.000Z', param: '2026-11-12T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '13/11', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '2026/11', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-01T00:00:00.000Z', param: '2026-11-01T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '13/13', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '13/13/2026', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'Thu1', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'Thu, xyz', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'Thu, 12', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'Nov Dec 2026', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/xyz', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12x', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/xyz', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '10:30 11/12/2026 x', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026x', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{t \'25:30:00\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{t \'10:30:60\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{t \'10:30:00.\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{t \'10:30:00.1001\'}', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '1999-12-30T10:30:00.999Z', param: '1999-12-30T10:30:00.999Z', column: '1999-12-30T10:30:01.000Z' },
    { zone: 'UTC', text: '{d \'x\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{d \'2026/11/12\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{d \'2026-13-12\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{d \'2026-11-12x\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{ts \'2026-02-30 10:30:00\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{ts \'2026-11-12 10:30:00x\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{t \'x\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{t \'10:30:00x\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{d \'2026-11-31\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '{x \'2026\'}', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'Fr\u0130day, November 13, 2026', lsIsDate: true, ls: '2026-11-13T00:00:00.000Z',
      isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'S\u00DFp 12, 2026', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '1/1/99999999999999999999', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '1/1/9223372036854775807', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '1/1/9223372036854775808', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '4294967297/1/2026', lsIsDate: true, ls: '2026-01-01T00:00:00.000Z', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 NaN:30', lsIsDate: true, ls: '2026-11-12T00:30:00.000Z', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '11/12/2026 \u221E:30', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '1E1/2/2026', lsIsDate: true, ls: '2026-10-02T00:00:00.000Z', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '15E-1/2/2026', lsIsDate: true, ls: '2026-01-02T00:00:00.000Z', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '1E/2/2026', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '2026-11-12T10:30:15+5:00', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T05:30:15.000Z', param: '2026-11-12T05:30:15.000Z', column: true },
    { zone: 'UTC', text: '2026-11-12T10:30:15+24:00', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '2026-11-12T10:30:15+05-00', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '2026-11-12T10:30:15+05:60', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '2026-11-12T10:30:15+', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: 'Thu, 12 Nov 2026 10:30:00 +05', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T05:30:00.000Z', param: '2026-11-12T05:30:00.000Z', column: true },
    { zone: 'UTC', text: 'Thu, 12 Nov 2026 10:30:00 GMT+05:00', lsIsDate: true, ls: '2026-11-12T05:30:00.000Z',
      isDate: true, parsed: '2026-11-12T05:30:00.000Z', param: '2026-11-12T05:30:00.000Z', column: true },
    { zone: 'UTC', text: 'Thu, 12 Nov 2026 10:30:00 GMT+5', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '2026-11-12T05:30:00.000Z', param: '2026-11-12T05:30:00.000Z', column: true },
    { zone: 'UTC', text: '2026-11-12T10:30:15x', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '12/31/292278994', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'invalid' },
    { zone: 'UTC', text: '0001-01-01T00:00:00+05:00', lsIsDate: true, ls: '0001-12-29T19:00:00.000Z',
      isDate: true, parsed: '2000-12-31T19:00:00.000Z', param: '2000-12-31T19:00:00.000Z', column: true },
    { zone: 'UTC', text: '+NaN', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-30T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '-Inf', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '+.5', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-30T12:00:00.000Z', column: true },
    { zone: 'UTC', text: '-0.05', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-29T22:48:00.000Z', column: true },
    { zone: 'UTC', text: '1.2.3', lsIsDate: true, ls: '0003-01-30T00:00:00.000Z',
      isDate: true, parsed: '2003-01-02T00:00:00.000Z', param: '2003-01-02T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '+1.2.3', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '..5', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '+', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '+1e', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '+1e-3', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-30T00:01:26.400Z', column: true },
    { zone: 'UTC', text: '+1e+3', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1902-09-26T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '+1e99999999999', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { zone: 'UTC', text: '+1e+', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '+0.' + '0'.repeat(400) + '1e400', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '1899-12-30T02:24:00.000Z', column: true },
    { zone: 'UTC', text: '0.' + '0'.repeat(400) + '1e400', lsIsDate: false, ls: 'invalid',
      isDate: false, parsed: 'invalid', param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { zone: 'UTC', text: '+5x', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'UTC', text: '+0', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-30T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '-0.0', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '1899-12-30T00:00:00.000Z', column: true },
    { zone: 'UTC', text: '+5d', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: 'not-a-date' },
    { zone: 'America/New_York', text: '3/8/26, 2:30 AM', lsIsDate: false, ls: 'invalid', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'America/New_York', text: '2026-03-08T02:30:00', lsIsDate: false, ls: 'invalid', isDate: 'error', parsed: 'error', param: 'error' },
    { zone: 'America/New_York', text: '46218', lsIsDate: false, ls: 'invalid', isDate: false, parsed: 'invalid', param: '2026-07-15T04:00:00.000Z' },
    { zone: 'America/New_York', text: '46218.5', lsIsDate: false, ls: 'invalid',
      isDate: true, parsed: '+046218-05-01T04:00:00.000Z', param: '2026-07-15T16:00:00.000Z' },
  ])('$zone $text', ({ zone, text, lsIsDate, ls, isDate, parsed, param, column }) => {
    withZone(zone, () => {
      expect(outcome(() => cfLsIsDate(text))).toBe(lsIsDate);
      expect(outcome(() => cfLsParseDateTime(text))).toBe(ls);
      expect(outcome(() => cfIsDateText(text))).toBe(isDate);
      expect(outcome(() => cfParseDateTimeText(text))).toBe(parsed);
      expect(outcome(() => cfTimestampParam(text))).toBe(param);
      if (column !== undefined) expect(outcome(() => sqlServerDatetime(cfTimestampParam(text)))).toBe(stored(column, param));
    });
  });

  // LSIsDate and LSParseDateTime after setLocale(locale) in UTC: the Edit Site datepicker's text (utils.cfc dateKeyFormat),
  // the locale's own date and date-time styles, and text of other shapes. 'zone' rows name a zone whose legacy instant
  // depends on the request thread's formatter, or text a zone name the port does not carry may start.
  it.each<{ locale: string; text: string; lsIsDate: boolean | string; ls: string }>([
    { locale: 'German (Standard)', text: '12.11.2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'German (Standard)', text: '12.11.26', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'German (Standard)', text: '12. November 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'German (Standard)', text: 'Donnerstag, 12. November 2026',
      lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'German (Standard)', text: '12.11.26, 15:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'German (Standard)', text: '12.11.2026, 15:30:45', lsIsDate: false, ls: 'invalid' },
    { locale: 'German (Standard)', text: '12. November 2026 um 15:30:45 UTC',
      lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'German (Standard)', text: '12. November 2026 um 15:30:45 UT', lsIsDate: 'zone', ls: 'zone' },
    { locale: 'German (Standard)', text: '11/12/2026', lsIsDate: true, ls: '2026-12-11T00:00:00.000Z' },
    { locale: 'German (Standard)', text: '2026/11/12', lsIsDate: false, ls: 'invalid' },
    { locale: 'german (standard)', text: '12.11.2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'de_DE', text: '12.11.2026 15:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'de_DE', text: 'Donnerstag, 12. November 2026 um 15:30:45 Koordinierte Weltzeit',
      lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'French (Standard)', text: '12/11/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'French (Standard)', text: '12 nov. 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'French (Standard)', text: 'jeudi 12 novembre 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'French (Standard)', text: '12 nov. 2026, 15:30:45', lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'French (Standard)', text: '12 novembre 2026 à 15:30:45 UTC+05:00', lsIsDate: 'zone', ls: 'zone' },
    { locale: 'French (Standard)', text: '12.11.26', lsIsDate: true, ls: '0026-11-10T00:00:00.000Z' },
    { locale: 'English (UK)', text: '12/11/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'English (UK)', text: '12 Nov 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'English (UK)', text: 'Thursday, 12 November 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'English (UK)', text: '12/11/2026, 15:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'Spanish (Modern)', text: '12/11/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Spanish (Modern)', text: '12/11/26', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Spanish (Modern)', text: '12 de noviembre de 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Spanish (Modern)', text: 'jueves, 12 de noviembre de 2026',
      lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Spanish (Modern)', text: '12 nov 2026 15:30:45', lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'Japanese', text: '2026/11/12', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Japanese', text: '2026年11月12日', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Japanese', text: '2026年11月12日木曜日', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Japanese', text: '2026/11/12 15:30:45', lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'Japanese', text: '12.11.26', lsIsDate: true, ls: '0026-11-10T00:00:00.000Z' },
    { locale: 'Chinese (China)', text: '2026/11/12', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Chinese (China)', text: '2026年11月12日', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Chinese (China)', text: '2026年11月12日星期四', lsIsDate: false, ls: 'invalid' },
    { locale: 'Chinese (China)', text: '2026/11/12 下午3:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'Chinese (China)', text: '下午3:30:45', lsIsDate: true, ls: '1899-12-30T15:30:45.000Z' },
    { locale: 'Korean', text: '2026. 11. 12.', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Korean', text: '26. 11. 12.', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Korean', text: '2026년 11월 12일 목요일', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Korean', text: '26. 11. 12. 오후 3:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'Dutch (Belgian)', text: '12/11/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Dutch (Belgian)', text: '12 nov. 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Dutch (Belgian)', text: 'donderdag 12 november 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Dutch (Belgian)', text: '12 november 2026 om 15:30:45 UTC',
      lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'Portuguese (Brazilian)', text: '12/11/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Portuguese (Brazilian)', text: '12 de nov. de 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Portuguese (Brazilian)', text: 'quinta-feira, 12 de novembro de 2026',
      lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Portuguese (Brazilian)', text: '12/11/2026 15:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'Norwegian (Bokmal)', text: '12.11.2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Norwegian (Bokmal)', text: '12. nov. 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Norwegian (Bokmal)', text: 'torsdag 12. november 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'Norwegian (Bokmal)', text: '12.11.2026, 15:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'ar_EG', text: '١٢\u200f/١١\u200f/٢٠٢٦', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ar_EG', text: '١٢/١١/٢٠٢٦', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ar_EG', text: '١٢ نوفمبر ٢٠٢٦', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ar_EG', text: 'الخميس، ١٢ نوفمبر ٢٠٢٦', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ar_EG', text: '١٢\u200f/١١\u200f/٢٠٢٦, ٣:٣٠ م', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'ar_EG', text: '12/11/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ar_EG_#Arab', text: '١٢ نوفمبر ٢٠٢٦ في ٣:٣٠:٤٥ م UTC', lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'ru_RU', text: '12.11.2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ru_RU', text: '12 нояб. 2026 г.', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ru_RU', text: 'четверг, 12 ноября 2026 г.', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'ru_RU', text: '12.11.2026, 15:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'ru_RU', text: '12 ноября 2026 г., 15:30:45 UTC', lsIsDate: false, ls: 'invalid' },
    { locale: 'th_TH', text: '12/11/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'th_TH', text: '12/11/26', lsIsDate: true, ls: '2526-11-12T00:00:00.000Z' },
    { locale: 'th_TH', text: '12 พ.ย. 2569 15:30:45', lsIsDate: true, ls: '2569-11-12T15:30:45.000Z' },
    { locale: 'th_TH', text: '12 พฤศจิกายน 2569 15 นาฬิกา 30 นาที 45 วินาที UTC',
      lsIsDate: true, ls: '2569-11-12T15:30:45.000Z' },
    { locale: 'zh_TW', text: '2026/11/12 下午3:30', lsIsDate: true, ls: '2026-11-12T15:30:00.000Z' },
    { locale: 'zh_TW', text: '2026年11月12日 下午3:30:45 [UTC]', lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: 'English (US)', text: '11/12/2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'English (US)', text: 'Nov 12, 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'English (US)', text: 'Thursday, November 12, 2026', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: 'English (US)', text: 'Thu, 12 Nov 2026 10:30:00 JST', lsIsDate: true, ls: '2026-11-12T01:30:00.000Z' },
    { locale: 'English (US)', text: 'November 12, 2026 at 3:30:45 PM CST', lsIsDate: 'zone', ls: 'zone' },
    { locale: '', text: '2026-11-12', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: '', text: '2026 Nov 12', lsIsDate: true, ls: '2026-11-12T00:00:00.000Z' },
    { locale: '', text: '2026 Nov 12 15:30:45 UTC', lsIsDate: true, ls: '2026-11-12T15:30:45.000Z' },
    { locale: '', text: '11/12/2026', lsIsDate: true, ls: '2026-12-11T00:00:00.000Z' },
    { locale: 'ko_KY', text: '11/12/2026', lsIsDate: 'error', ls: 'error' },
  ])('$locale $text', ({ locale, text, lsIsDate, ls }) => {
    withZone('UTC', () => {
      expect(outcome(() => cfLsIsDate(text, locale))).toBe(lsIsDate);
      expect(outcome(() => cfLsParseDateTime(text, locale))).toBe(ls);
    });
  });

  // Cast._Date(Object) of values that are not text: ACF's results in UTC.
  it.each<{ value: unknown; param: string; column?: boolean | string }>([
    { value: 46218.5, param: '2026-07-15T12:00:00.000Z', column: true },
    { value: -1, param: '1899-12-29T00:00:00.000Z', column: true },
    { value: Number.NaN, param: '1899-12-30T00:00:00.000Z', column: true },
    { value: Number.POSITIVE_INFINITY, param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { value: 2958465.99999, param: '9999-12-31T23:59:59.136Z', column: '9999-12-31T23:59:59.137Z' },
    { value: 1e10, param: 'range' },
    { value: 12345, param: '1933-10-18T00:00:00.000Z', column: true },
    { value: true, param: 'not-a-date' },
    { value: null, param: 'empty' },
    { value: ['2026-11-12'], param: 'not-a-date' },
    { value: new Date(Date.UTC(2026, 10, 12, 10, 30, 0, 999)), param: '2026-11-12T10:30:00.999Z', column: '2026-11-12T10:30:01.000Z' },
    { value: new Date(Date.UTC(1752, 11, 31, 23, 59, 59, 998)), param: '1752-12-31T23:59:59.998Z', column: false },
    { value: new Date(Number.NaN), param: 'range', column: false },
  ])('cf_sql_timestamp of $value', ({ value, param, column }) => {
    withZone('UTC', () => {
      expect(outcome(() => cfTimestampParam(value))).toBe(param);
      if (column !== undefined) expect(outcome(() => sqlServerDatetime(cfTimestampParam(value)))).toBe(stored(column, param));
    });
  });

  // Hexadecimal floats bound as cf_sql_timestamp in UTC: ACF's DoubleParser copy (digit first) takes the significand digits
  // as the binary exponent; signed text goes through Double.parseDouble.
  it.each<{ text: string; param: string; column?: boolean | string }>([
    { text: '0x1.8p1', param: '2976-08-01T00:00:00.000Z', column: true },
    { text: '0X1P0', param: '1900-01-01T00:00:00.000Z', column: true },
    { text: '0x.8p1', param: '1900-05-07T00:00:00.000Z', column: true },
    { text: '0x1.5p3', param: '2017-09-30T00:00:00.000Z', column: true },
    { text: '0x1p-1', param: '1899-12-30T12:00:00.000Z', column: true },
    { text: '0x1p99999999999', param: '1900-01-01T00:00:00.000Z', column: true },
    { text: '0x1p-1074', param: '1899-12-30T12:00:00.000Z', column: true },
    { text: '0x10p-4', param: '1899-12-30T00:22:30.000Z', column: true },
    { text: '0x1.0p-0', param: '1899-12-30T00:01:24.375Z', column: '1899-12-30T00:01:24.377Z' },
    { text: '0x1.8p-2', param: '1899-12-30T00:00:00.494Z', column: '1899-12-30T00:00:00.493Z' },
    { text: '0xAp0', param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { text: '0x1.000000000000000000001p0', param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { text: '0xffffffffffffffffp-40', param: '1899-12-30T00:00:00.000Z', column: true },
    { text: '0x0.0000000000000000000000000000001p130', param: '1899-12-30T00:00:00.000Z', column: true },
    { text: '0x2.8p0', param: 'range' },
    { text: '0x1', param: 'invalid' },
    { text: '0x1p', param: 'invalid' },
    { text: '0x.p1', param: 'invalid' },
    { text: '0x-1p0', param: 'invalid' },
    { text: '0x1p0f', param: 'invalid' },
    { text: '00x1p0', param: 'invalid' },
    { text: '+0x1.8p1', param: '1900-01-02T00:00:00.000Z', column: true },
    { text: '+0X1P0', param: '1899-12-31T00:00:00.000Z', column: true },
    { text: '-0x1p0', param: '1899-12-29T00:00:00.000Z', column: true },
    { text: '-0x1.8p-1', param: '1899-12-29T06:00:00.000Z', column: true },
    { text: '+0x1.123456789abcdp-3', param: '1899-12-30T03:12:48.000Z', column: true },
    { text: '+0x1.fffffffffffffp-1', param: '1899-12-31T00:00:00.000Z', column: true },
    { text: '+0x1.0000000000001p15', param: '1989-09-17T00:00:00.000Z', column: true },
    { text: '+0x1p99999999999', param: '1899-12-28T23:59:59.999Z', column: '1899-12-29T00:00:00.000Z' },
    { text: '-0x1p99999999999', param: '1899-12-30T00:00:00.000Z', column: true },
    { text: '+0x1p-99999999999', param: '1899-12-30T00:00:00.000Z', column: true },
    { text: '-0x0p0', param: '1899-12-30T00:00:00.000Z', column: true },
    { text: '-0x1p31', param: 'range' },
    { text: '+0x1p0f', param: 'not-a-date' },
    { text: '+.0x1p0', param: 'not-a-date' },
    { text: '+-0x1p0', param: 'not-a-date' },
  ])('cf_sql_timestamp of hexadecimal $text', ({ text, param, column }) => {
    withZone('UTC', () => {
      expect(outcome(() => cfTimestampParam(text))).toBe(param);
      if (column !== undefined) expect(outcome(() => sqlServerDatetime(cfTimestampParam(text)))).toBe(stored(column, param));
    });
  });

  // What SQL Server 2022's datetime column stores for the bound text (UTC rows: ACF 2023 inserts into a datetime column).
  it.each<{ zone: string; text: string; stored: string }>([
    { zone: 'UTC', text: "{ts '2026-11-12 10:30:00.001'}", stored: '2026-11-12T10:30:00.000Z' },
    { zone: 'UTC', text: "{ts '2026-11-12 10:30:00.002'}", stored: '2026-11-12T10:30:00.003Z' },
    { zone: 'UTC', text: "{ts '2026-11-12 10:30:00.124'}", stored: '2026-11-12T10:30:00.123Z' },
    { zone: 'UTC', text: "{ts '2026-11-12 10:30:00.125'}", stored: '2026-11-12T10:30:00.127Z' },
    { zone: 'UTC', text: "{ts '2026-11-12 10:30:00.999'}", stored: '2026-11-12T10:30:01.000Z' },
    { zone: 'UTC', text: "{ts '2026-11-12 10:30:59.999'}", stored: '2026-11-12T10:31:00.000Z' },
    { zone: 'UTC', text: "{ts '2026-11-12 10:59:59.999'}", stored: '2026-11-12T11:00:00.000Z' },
    { zone: 'UTC', text: "{ts '2026-11-12 23:59:59.998'}", stored: '2026-11-12T23:59:59.997Z' },
    { zone: 'UTC', text: "{ts '2026-11-30 23:59:59.999'}", stored: '2026-12-01T00:00:00.000Z' },
    { zone: 'UTC', text: "{ts '2026-12-31 23:59:59.999'}", stored: '2027-01-01T00:00:00.000Z' },
    { zone: 'UTC', text: "{ts '2026-02-28 23:59:59.999'}", stored: '2026-03-01T00:00:00.000Z' },
    { zone: 'UTC', text: "{ts '2028-02-28 23:59:59.999'}", stored: '2028-02-29T00:00:00.000Z' },
    { zone: 'UTC', text: "{ts '2028-02-29 23:59:59.999'}", stored: '2028-03-01T00:00:00.000Z' },
    { zone: 'UTC', text: "{ts '9999-12-31 23:59:59.997'}", stored: '9999-12-31T23:59:59.997Z' },
    { zone: 'UTC', text: "{ts '9999-12-31 23:59:59.998'}", stored: '9999-12-31T23:59:59.997Z' },
    { zone: 'UTC', text: "{ts '9999-12-31 23:59:59.999'}", stored: '9999-12-31T23:59:59.997Z' },
    { zone: 'UTC', text: "{ts '1753-01-01 00:00:00.001'}", stored: '1753-01-01T00:00:00.000Z' },
    { zone: 'UTC', text: "{ts '1752-12-31 23:59:59.998'}", stored: 'error' },
    { zone: 'America/New_York', text: "{ts '2026-11-12 10:30:00.999'}", stored: '2026-11-12T15:30:01.000Z' },
    { zone: 'America/New_York', text: "{ts '2026-11-01 00:59:59.999'}", stored: '2026-11-01T06:00:00.000Z' },
    { zone: 'America/New_York', text: "{ts '2026-03-08 01:59:59.999'}", stored: 'skipped' },
  ])('SQL Server datetime of $zone $text', ({ zone, text, stored: expected }) => {
    withZone(zone, () => {
      expect(outcome(() => sqlServerDatetime(cfTimestampParam(text)))).toBe(expected);
    });
  });
});

// resourceBundleFactory.CF2Java on ACF 2023, and the setLocale outcome of its result in a UTC process zone.
describe('masaCf2Java', () => {
  it.each<{ value: string; java: string; parsed: string }>([
    { value: '', java: 'English (US)', parsed: '2026-11-12T00:00:00.000Z' },
    { value: ' Server ', java: 'en_US', parsed: '2026-11-12T00:00:00.000Z' },
    { value: 'SERVER', java: 'en_US', parsed: '2026-11-12T00:00:00.000Z' },
    { value: 'german (standard)', java: 'de_DE', parsed: '2026-12-11T00:00:00.000Z' },
    { value: ' de_DE ', java: 'de_DE', parsed: '2026-12-11T00:00:00.000Z' },
    { value: 'Spanish (Modern)', java: 'es_ES', parsed: '2026-12-11T00:00:00.000Z' },
    { value: 'Norwegian (Nynorsk)', java: 'no_NO', parsed: '2026-12-11T00:00:00.000Z' },
    { value: 'ENGLISH', java: 'en_US', parsed: '2026-11-12T00:00:00.000Z' },
    { value: 'ar_EG_#Arab', java: 'ar_EG_#Arab', parsed: '2026-12-11T00:00:00.000Z' },
    { value: 'korean (south korea)', java: 'ko_KY', parsed: 'ko_KY must be one of the ColdFusion supported locales.' },
    { value: 'chinese', java: 'ch_CN', parsed: 'ch_CN must be one of the ColdFusion supported locales.' },
    { value: 'Client', java: 'Client', parsed: 'Client must be one of the ColdFusion supported locales.' },
  ])('$value', ({ value, java, parsed }) => {
    expect(masaCf2Java(value)).toBe(java);
    withZone('UTC', () => {
      let result: string;
      try {
        result = cfLsParseDateTime('11/12/2026', java).toISOString();
      } catch (error) {
        result = (error as Error).message;
      }
      expect(result).toBe(parsed);
    });
  });
});
