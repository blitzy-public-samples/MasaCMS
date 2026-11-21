// isDate's grammar with the Cast._Date of the same text, LSIsDate/LSParseDateTime of zone and locale text, and
// LSDateFormat's string resolution, against ACF 2023 (hotfix 26, Java 17) in UTC with the clock at ORACLE_NOW. Seconds-resolution expectations are the oracle's own.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cfIsDateText, cfLsDateOf, cfLsIsDate, cfLsParseDateTime, cfTimestampParam } from '../../src/legacy-compat/date-text.js';
import { cfJavaDateFormat } from '../../src/legacy-compat/dates.js';

const ORACLE_NOW = new Date('2026-11-11T09:00:00Z');
const SYSTEM_TZ = process.env.TZ;

/** An instant as yyyy-mm-dd HH:mm:ss in UTC, or the kind of error the call throws. */
function second(run: () => Date): string {
  try {
    return run().toISOString().slice(0, 19).replace('T', ' ');
  } catch (error) {
    const { message } = error as Error;
    if (message.endsWith('cannot be converted to a date.')) return 'not-a-date';
    if (message.endsWith('is an invalid date or time string.')) return 'invalid';
    return 'error';
  }
}

/** Either error Cast._Date of text throws; the oracle's LSDateFormat reports both as one invalid-format error. */
const FAILED_CAST = expect.stringMatching(/^(invalid|not-a-date)$/);

/** A UTC ISO instant as the second-resolution stamp `second` reports. */
const stampOf = (iso: string): string => iso.slice(0, 19).replace('T', ' ');

beforeAll(() => {
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ORACLE_NOW);
});
afterAll(() => {
  vi.useRealTimers();
  if (SYSTEM_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = SYSTEM_TZ;
});

describe('isDate and the Cast._Date of text', () => {
  it.each<[string, boolean, string]>([
    ['06/30/2026 ', true, '2026-06-30 00:00:00'],
    ['14:05:07.5', true, '1899-12-30 14:05:07'],
    ['12:30 AM', true, '1899-12-30 00:30:00'],
    ['12:30 PM', true, '1899-12-30 12:30:00'],
    ['5:pm', true, '1899-12-30 17:00:00'],
    ['14:05 UTC06/30/2026', true, '2026-06-30 14:05:00'],
    ['14:05 EST06/30/2026', true, '2026-06-30 14:05:00'],
    ['2PMJune 30 2026', true, '2026-06-30 14:00:00'],
    ['2 PMJune 30 2026', true, '2026-06-30 14:00:00'],
    ['2PMESTJun 30 2026', true, '2026-06-30 14:00:00'],
    ['14:x', false, 'invalid'],
    ['14:05:x', false, 'invalid'],
    ['25:00', false, 'invalid'],
    ['5pEST', false, 'invalid'],
    ['5p-1', false, 'invalid'],
    ['14:05 UTC 06/30/2026', false, 'invalid'],
    ['14:05 +02:00 06/30/2026', false, 'invalid'],
    ['UTCJun 30 2026', false, 'not-a-date'],
    ['6/2026', true, '2026-06-01 00:00:00'],
    ['June 15', true, '2026-06-15 00:00:00'],
    ['June 2026', true, '2026-06-01 00:00:00'],
    ['June 32', true, '1932-06-01 00:00:00'],
    ['Jun 30 2026 14:05:07.25', true, '2026-06-30 14:05:07'],
    ['Jun 30 2026 T14:05', true, '2026-06-30 14:05:00'],
    ['2026-06-30 T 14:05', true, '2026-06-30 14:05:00'],
    ['6/15', false, 'invalid'],
    ['June July 2026', false, 'invalid'],
    ['June 1 2 2026', false, 'invalid'],
    ['30 2026 June', false, 'invalid'],
    ['6/30/2026x', false, 'invalid'],
    ['June 30 2026 xyz', false, 'invalid'],
    ['06/2026 14:05', false, 'invalid'],
    ['Jun 30 2026 14:05 x', false, 'invalid'],
    ['Jun 30 2026 5:pm', false, 'invalid'],
    ['Tue Jun 30 2026 14 x', true, '2026-06-30 14:00:00'],
    ['Tue Jun 30 2026 14:05 x', true, '2026-06-30 14:05:00'],
    ['Monday, June 30, 2026', true, '2026-06-30 00:00:00'],
    ['Tue, June 30, 2026 2:05 PM', true, '2026-06-30 14:05:00'],
    ['Tue Jun 30 2026 14', false, 'invalid'],
    ['Tue Jun 30 2026 25 x', false, 'invalid'],
    ['Tuesday', false, 'invalid'],
    ['Tuesday 14:05', false, 'invalid'],
    ["{d '2026-06-30'} x", true, '2026-06-30 00:00:00'],
    ["{ts '2026-06-30 14:05:07.5'}", true, '2026-06-30 14:05:07'],
    ['{garbage}', false, 'invalid'],
    ["{ts '2026-06-30'}", false, 'invalid'],
    ["{d '2026-02-30'}", false, 'invalid'],
    ['Jun 30 2026 14 EST', true, '2026-06-30 19:00:00'],
    ['2026-06-30T14 EST', true, '2026-06-30 19:00:00'],
    ['Jun 30 2026 14:05 CET', true, '2026-06-30 12:05:00'],
    ['Jan 30 2026 14:05 CET', true, '2026-01-30 13:05:00'],
    ['Jun 30 1850 14:05 CET', true, '1850-06-30 13:05:00'],
    ['Jun 30 1850 14:05 JST', true, '1850-06-30 05:05:00'],
    ['Jun 30 2026 14:05 +05:30', true, '2026-06-30 08:35:00'],
    ['Jun 30 2026 14:05 -05', true, '2026-06-30 19:05:00'],
    ['Jun 30 2026 14:05 GMT+02:00', true, '2026-06-30 12:05:00'],
    ['Jun 30 2026 14:05 GMT+2', true, '2026-06-30 12:05:00'],
    ['Jun 30 2026 14:05 GMT', true, '2026-06-30 14:05:00'],
    ['Jun 30 2026 14:05 Z', true, '2026-06-30 14:05:00'],
    ['Jun 30 2026 2PMEST x', true, '2026-06-30 19:00:00'],
    ['Jun 30 2026 2AMUTC', true, '2026-06-30 02:00:00'],
    ['Jun 30 2026 2 PM PST', true, '2026-06-30 21:00:00'],
    ['Jun 30 2026 2 PM PDT', true, '2026-06-30 21:00:00'],
    ['Jun 30 2026 2PMAST', true, '2026-06-30 22:00:00'],
    ['Jun 30 2026 11:30 APRC', true, '2026-06-30 03:30:00'],
    ['Jun 30 2026 14:05 PST', false, 'invalid'],
    ['Jun 30 2026 11:30 AMET', false, 'invalid'],
    ['23:30:00 AMST', false, 'invalid'],
    ['Jun 30 2026 14:05 +13', false, 'invalid'],
    ['Jun 30 2026 14:05 +05:60', false, 'invalid'],
    ['Jun 30 2026 14:05 +0530', false, 'invalid'],
    ['Jun 30 2026 14:05 +0800', false, 'invalid'],
    ['Jun 30 2026 14:05 +12:30', false, 'invalid'],
    ['Jun 30 2026 14:05 GMT-0530', false, 'invalid'],
  ])('%j: isDate %s, cast %s', (text, isDate, cast) => {
    expect(cfIsDateText(text)).toBe(isDate);
    expect(second(() => cfTimestampParam(text))).toBe(cast);
  });
});

describe('LSIsDate and LSParseDateTime of zone and locale text', () => {
  // `cast` is the Cast._Date LSDateFormat falls back to where LSParseDateTime fails ('-' where both fail).
  it.each<[string, string, boolean, string]>([
    ['2026-06-30T14:05:00+02:00', 'en_US', true, '2026-06-30T12:05:00.000Z'],
    ['2026-06-30T14:05:00-05:30', 'en_US', true, '2026-06-30T19:35:00.000Z'],
    ['2026-06-30T14:05:00+2:00', 'en_US', false, '2026-06-30T12:05:00.000Z'],
    ['2026-06-30T14:05:00+2', 'en_US', false, '2026-06-30T12:05:00.000Z'],
    ['2026-06-30T14:05:00+0200', 'en_US', false, '-'],
    ['2026-06-30T14:05:00+24:00', 'en_US', false, '-'],
    ['2026-06-30T14:05:00+02:60', 'en_US', false, '-'],
    ['2026-06-30T14:05:00+', 'en_US', false, '-'],
    ['2026-06-30T14:05:00 x', 'en_US', false, '-'],
    ['June 30, 2026 at 2:05:07 PM GMT+02:00', 'en_US', true, '2026-06-30T12:05:07.000Z'],
    ['June 30, 2026 at 2:05:07 PM GMT+2:00', 'en_US', true, '2026-06-30T12:05:07.000Z'],
    ['June 30, 2026 at 2:05:07 PM +0530', 'en_US', true, '2026-06-30T08:35:07.000Z'],
    ['June 30, 2026 at 2:05:07 PM -0530', 'en_US', true, '2026-06-30T19:35:07.000Z'],
    ['June 30, 2026 at 2:05:07 PM utc', 'en_US', true, '2026-06-30T14:05:07.000Z'],
    ['June 30, 2026 at 2:05:07 PM Coordinated Universal Time', 'en_US', true, '2026-06-30T14:05:07.000Z'],
    ['Tuesday, June 30, 2026 at 2:05:07 PM Coordinated Universal Time', 'en_US', true, '2026-06-30T14:05:07.000Z'],
    ['6/30/26 2:05:07 PM UTC', 'en_US', true, '2026-06-30T14:05:07.000Z'],
    ['6/30/26 2:05:07 PM GMT+02:00', 'en_US', true, '2026-06-30T12:05:07.000Z'],
    ['June 30, 2026 at 2:05:07 PM GMT+0200', 'en_US', false, '-'],
    ['June 30, 2026 at 2:05:07 PM GMT+', 'en_US', false, '-'],
    ['June 30, 2026 at 2:05:07 PM +05', 'en_US', false, '-'],
    ['June 30, 2026 at 2:05:07 PM +2400', 'en_US', false, '-'],
    ['June 30, 2026 at 2:05:07 PM XYZ', 'en_US', false, '-'],
    ['30.06.2026 14:05:07 Koordinierte Weltzeit', 'de_DE', true, '2026-06-30T14:05:07.000Z'],
    ['30.06.2026 14:05:07 GMT+02:00', 'de_DE', true, '2026-06-30T12:05:07.000Z'],
    // Java zone names, read as a request thread's formatters in their initial server zone read them.
    ['June 30, 2026 at 11:30:00 PM EST', 'en_US', true, '2026-07-01T04:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM Eastern Standard Time', 'en_US', true, '2026-07-01T04:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM EDT', 'en_US', true, '2026-07-01T03:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM Eastern Daylight Time', 'en_US', true, '2026-07-01T03:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM PST', 'en_US', true, '2026-07-01T07:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM Pacific Standard Time', 'en_US', true, '2026-07-01T07:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM PDT', 'en_US', true, '2026-07-01T06:30:00.000Z'],
    ['December 30, 2026 at 11:30:00 PM PDT', 'en_US', true, '2026-12-31T06:30:00.000Z'],
    ['Tuesday, June 30, 2026 at 11:30:00 PM Pacific Daylight Time', 'en_US', true, '2026-07-01T06:30:00.000Z'],
    ['June 30, 2026 at 2:05:07 PM CET', 'en_US', true, '2026-06-30T13:05:07.000Z'],
    ['June 30, 2026 at 11:30:00 PM CEST', 'en_US', true, '2026-06-30T21:30:00.000Z'],
    ['Tue, 30 Jun 2026 23:05:00 PST', 'en_US', true, '2026-07-01T07:05:00.000Z'],
    ['30. Juni 2026 um 23:30:00 Mitteleuropäische Sommerzeit', 'de_DE', true, '2026-06-30T21:30:00.000Z'],
    ['30. Dezember 2026 um 23:30:00 Mitteleuropäische Normalzeit', 'de_DE', true, '2026-12-30T22:30:00.000Z'],
    ['30 juin 2026 à 23:30:00 heure d’été d’Europe centrale', 'fr_FR', true, '2026-06-30T21:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM WET', 'en_US', true, '2026-06-30T23:30:00.000Z'],
    ['June 30, 1950 at 2:05:00 PM ART', 'en_US', true, '1950-06-30T18:05:00.000Z'],
    ['June 30, 1950 at 2:05:00 PM Apia Standard Time', 'en_US', true, '1950-07-01T01:05:00.000Z'],
    ['11:30:00 PM Irish Standard Time', 'en_US', true, '1899-12-30T22:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM Moscow Summer Time', 'en_US', true, '2026-06-30T20:30:00.000Z'],
    ['June 30, 2026 at 11:30:00 PM Pitcairn Time', 'en_US', true, '2026-07-01T07:30:00.000Z'],
    ['March 28, 2010 at 2:30:00 AM Moscow Summer Time', 'en_US', false, '-'],
    ['June 30, 2026 at 11:30:00 PM WITA', 'en_US', false, '-'],
  ])('%j under %s: lsIsDate %s, date %s', (text, locale, lsIsDate, date) => {
    expect(cfLsIsDate(text, locale)).toBe(lsIsDate);
    expect(second(() => cfLsParseDateTime(text, locale))).toBe(lsIsDate ? stampOf(date) : 'invalid');
    if (!lsIsDate) expect(second(() => cfTimestampParam(text))).toEqual(date === '-' ? FAILED_CAST : stampOf(date));
  });

  // Fields non-lenient Java refuses, and locales beyond Masa's bundles; `date` is LSDateFormat's date ('-' where it fails).
  it.each<[string, string, boolean, string]>([
    ['14:05:07.123', 'en_US', true, '1899-12-30 14:05:07'],
    ['14:-0', 'en_US', true, '1899-12-30 14:00:00'],
    ['6/30/46', 'en_US', true, '2046-06-30 00:00:00'],
    ['1/1/46', 'en_US', true, '2046-01-01 00:00:00'],
    ['6/30/47', 'en_US', true, '1947-06-30 00:00:00'],
    ['6/30/26, 3:45 XM', 'en_US', false, '-'],
    ['6/30/', 'en_US', false, '-'],
    ['6/-30/26', 'en_US', false, '-'],
    ['99999999999999999/30/26', 'en_US', false, '-'],
    ['6/30/26, 14:60', 'en_US', false, '-'],
    ['Monday, June 30, 2026 at 2:05:07 PM GMT', 'en_US', false, '-'],
    ['14:-5', 'de_DE', false, '-'],
    ['14:60', 'de_DE', false, '-'],
    ['úterý 30. června 2026', 'cs_CZ', true, '2026-06-30 00:00:00'],
    ['30.06.26 14:05', 'cs_CZ', true, '2026-06-30 14:05:00'],
    ['30. 6. 2026 14:05:07', 'cs_CZ', true, '2026-06-30 14:05:07'],
    ['30.06.26 14:05:07 UTC', 'CS_cz', true, '2026-06-30 14:05:07'],
    ['06/30/2026', 'cs_CZ', false, '2026-06-30 00:00:00'],
    ['31. 6. 2026', 'cs_CZ', false, '-'],
    ['otrdiena, 2026. gada 30. jūnijs 14:05:07 Universālais koordinētais laiks', 'lv_LV', true, '2026-06-30 14:05:07'],
    ['2026. gada 30. jūn.', 'lv_LV', true, '2026-06-30 00:00:00'],
    ['30 Jun 2026', 'en_IN', true, '2026-06-30 00:00:00'],
    ['30/06/26 2:05 pm', 'en_IN', true, '2026-06-30 14:05:00'],
    ['2:05:07 pm', 'en_IN', true, '1899-12-30 14:05:07'],
    ['30 มิ.ย. 2026 14:05:07', 'th_TH', true, '2026-06-30 14:05:07'],
    ['30 มิถุนายน ค.ศ. 2026', 'th_TH', false, '-'],
    ['June 30, 2026', 'zh_CN', false, '2026-06-30 00:00:00'],
  ])('%j under %s: lsIsDate %s, date %s', (text, locale, lsIsDate, date) => {
    expect(cfLsIsDate(text, locale)).toBe(lsIsDate);
    expect(second(() => cfLsParseDateTime(text, locale))).toBe(lsIsDate ? date : 'invalid');
    if (!lsIsDate) expect(second(() => cfTimestampParam(text))).toEqual(date === '-' ? FAILED_CAST : date);
  });
});

describe("isDate, LSIsDate and the Cast._Date of Masa's bundle-locale text", () => {
  it.each<[string, string, boolean, boolean]>([
    ['06/30/2026', 'en_US', true, true],
    ['06/30/2026', 'de_DE', true, false],
    ['01/06/2026', 'en_GB', true, true],
    ['30.06.2026', 'fr_FR', true, true],
    ['30. Juni 2026', 'de_DE', false, true],
    ['30. Juni 2026', 'en_US', false, false],
    ['Dienstag, 30. Juni 2026', 'de_DE', false, true],
    ['30 juin 2026', 'fr_FR', false, true],
    ['June 30, 2026', 'en_GB', true, false],
    ["{ts '2026-06-30 14:05:00'}", 'en_US', true, false],
    ['2026-06-30T14:05:00Z', 'fr_FR', true, true],
    ['Tue, 30 Jun 2026 14:05:00 GMT', 'en_GB', true, true],
    ['Jun 30 2026 14:05 EST', 'en_US', true, false],
    ['6/30/26 3:45 PM', 'en_US', true, true],
    ['14:05', 'de_DE', true, true],
    ['2026', 'en_US', false, false],
    ['2026.06', 'en_US', true, false],
    ['02/30/2026', 'en_US', false, false],
    ['garbage', 'en_US', false, false],
    [' ', 'en_US', false, false],
  ])('%j under %s: isDate %s, lsIsDate %s', (text, locale, isDate, lsIsDate) => {
    expect(cfIsDateText(text)).toBe(isDate);
    expect(cfLsIsDate(text, locale)).toBe(lsIsDate);
  });

  /** The UTC stamp of the Cast._Date of text, or its error message. */
  const castOf = (text: string): string => {
    try {
      return stampOf(cfTimestampParam(text).toISOString());
    } catch (error) {
      return (error as Error).message;
    }
  };

  it.each([
    ['06/30/2026', '2026-06-30 00:00:00'],
    ['30/06/2026', '2026-06-30 00:00:00'],
    ['01/06/2026', '2026-01-06 00:00:00'],
    ['June 30, 2026', '2026-06-30 00:00:00'],
    ['6/30/26 3:45 PM', '2026-06-30 15:45:00'],
    ['30.06.26', '1930-06-26 00:00:00'],
    ['14:05', '1899-12-30 14:05:00'],
    ["{t '14:05:00'}", '1999-12-30 14:05:00'],
    ['2026', '1905-07-18 00:00:00'],
    ['2026.06', '1905-07-18 01:26:24'],
    ['1.5', '1899-12-31 12:00:00'],
    ['Jun 30 2026 14:05 EST', '2026-06-30 19:05:00'],
    ['2026-06-30T14:05:00Z', '2026-06-30 14:05:00'],
    ['Tue, 30 Jun 2026 14:05:00 GMT', '2026-06-30 14:05:00'],
    ['30. Juni 2026', '30. Juni 2026 is an invalid date or time string.'],
    ['02/30/2026', '02/30/2026 is an invalid date or time string.'],
    ['garbage', 'The value garbage cannot be converted to a date.'],
    ['lundi 1 décembre 2031', 'The value lundi 1 décembre 2031 cannot be converted to a date.'],
  ])('casts %j to %s', (text, expected) => {
    expect(castOf(text)).toBe(expected);
  });
});

describe("LSDateFormat's string resolution", () => {
  /** The Java calendar day cfLsDateOf resolves, null for none, or its error message. */
  const dayOf = (text: string, locale: string): string | null => {
    try {
      const date = cfLsDateOf(text, locale);
      return date === null ? null : cfJavaDateFormat(date, 'yyyy-mm-dd');
    } catch (error) {
      return (error as Error).message;
    }
  };

  it.each<[string, string, string | null]>([
    ['06/30/2026', 'en_US', '2026-06-30'],
    ['01/06/2026', 'en_GB', '2026-06-01'],
    ['30. Juni 2026', 'de_DE', '2026-06-30'],
    ['lundi 1 décembre 2031', 'fr_FR', '2031-12-01'],
    ['June 30, 2026', 'en_GB', '2026-06-30'],
    ['June 30, 2026 at 11:30:00 PM EST', 'en_US', '2026-07-01'],
    ['30.06.26', 'en_US', '0026-06-30'],
    ["{ts '2026-11-30 00:00:00'}", 'en_US', '2026-11-30'],
    ['12:30 PM', 'zh_CN', '1899-12-30'],
    ['2026', 'en_US', '1905-07-18'],
    [' 2026 ', 'en_US', '1905-07-18'],
    ['2026.06', 'en_US', '1905-07-18'],
    ['-1', 'en_US', '1899-12-29'],
    ['1e400', 'en_US', '1899-12-28'],
    ['  ', 'en_US', null],
    ['', 'zh_CN', null],
    ['garbage', 'en_US', 'garbage is an invalid date format.'],
    ['30. Juni 2026', 'en_US', '30. Juni 2026 is an invalid date format.'],
    ['02/30/2026', 'de_DE', '02/30/2026 is an invalid date format.'],
    ['June 30, 2026 at 11:30:00 PM EST', 'zh_CN', 'June 30, 2026 at 11:30:00 PM EST is an invalid date format.'],
  ])('%j under %s is %j', (text, locale, expected) => {
    expect(dayOf(text, locale)).toBe(expected);
  });

  it("throws setLocale's error for an unsupported locale, and RangeError beyond the JS Date range", () => {
    expect(() => cfLsDateOf('', 'xx_YY')).toThrow(new Error('xx_YY must be one of the ColdFusion supported locales.'));
    expect(() => cfLsDateOf('6/30/999999', 'en_US')).toThrow(new RangeError('The date is outside the JS Date range'));
  });
});
