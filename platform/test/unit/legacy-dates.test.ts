import { describe, expect, it } from 'vitest';
import {
  cfDateAdd,
  cfDateFormat,
  cfDateTimeFormat,
  cfLsDateFormat,
  cfLsTimeFormat,
  cfTimeFormat,
  formatCookieExpires,
  formatCsrfExpires,
  formatSerializerDate,
  formatSerializerUtcDate,
} from '../../src/legacy-compat/dates.js';

type DatePart = Parameters<typeof cfDateAdd>[0];

const TUE = new Date(2026, 5, 30, 15, 0, 0, 246);
const THU = new Date(2026, 9, 29, 9, 5, 7, 8);
const SUN = new Date(2026, 0, 4, 0, 7, 3, 50);
const SAT = new Date(2026, 6, 4, 12, 30, 45, 5);
const LEAP = new Date(2024, 1, 29, 23, 59, 59, 999);
const PADDED = new Date(2027, 0, 2, 3, 4, 5, 6);

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

describe('cfDateFormat', () => {
  it.each([
    { mask: 'mm/dd/yyyy', date: TUE, expected: '06/30/2026' },
    { mask: 'MM/DD/YYYY', date: THU, expected: '10/302/2026' },
    { mask: 'm/d/yy', date: TUE, expected: '6/30/26' },
    { mask: 'm/d/yyyy', date: PADDED, expected: '1/2/2027' },
    { mask: 'yyyy-mm-dd', date: PADDED, expected: '2027-01-02' },
    { mask: 'yyyymmdd', date: THU, expected: '20261029' },
    { mask: 'yyyy.mm.dd', date: THU, expected: '2026.10.29' },
    { mask: 'yy/mm/dd', date: PADDED, expected: '27/01/02' },
    { mask: 'mmddyy', date: PADDED, expected: '010227' },
    { mask: 'dd_mm_yyyy', date: PADDED, expected: '02_01_2027' },
    { mask: 'yyyy_dd_mm', date: THU, expected: '2026_29_10' },
    { mask: 'ddd, dd-mmm-yyyy', date: THU, expected: 'Thu, 29-Oct-2026' },
    { mask: 'ddd, dd mmm yyyy', date: SUN, expected: 'Sun, 04 Jan 2026' },
    { mask: 'dddd', date: SAT, expected: 'Saturday' },
    { mask: 'DDD', date: THU, expected: 'Thu' },
    { mask: 'ddddd', date: LEAP, expected: 'Thursday' },
    { mask: 'Dd', date: TUE, expected: '18130' },
    { mask: 'D', date: SUN, expected: '4' },
    { mask: 'DD', date: SUN, expected: '04' },
    { mask: 'DD', date: THU, expected: '302' },
    { mask: 'mmm', date: THU, expected: 'Oct' },
    { mask: 'mmmm', date: THU, expected: 'October' },
    { mask: 'mmmmm', date: SUN, expected: 'January' },
    { mask: 'M', date: PADDED, expected: '1' },
    { mask: 'y', date: PADDED, expected: '2027' },
    { mask: 'yy', date: PADDED, expected: '27' },
    { mask: 'yyy', date: PADDED, expected: '2027' },
    { mask: 'yyyyy', date: PADDED, expected: '02027' },
    { mask: 'Y', date: PADDED, expected: '2027' },
    { mask: 'YY', date: PADDED, expected: '27' },
    { mask: 'YYYY', date: PADDED, expected: '2027' },
    { mask: 'gg', date: TUE, expected: 'AD' },
    { mask: 'G', date: TUE, expected: 'AD' },
    { mask: 'e', date: SAT, expected: 'Sat' },
    { mask: 'EEEE', date: SAT, expected: 'Saturday' },
    { mask: 's', date: THU, expected: '7' },
    { mask: 'S', date: THU, expected: '8' },
    { mask: 'SS', date: THU, expected: '08' },
    { mask: 'h', date: SUN, expected: '12' },
    { mask: 'hh', date: SAT, expected: '12' },
    { mask: 'H', date: SUN, expected: '0' },
    { mask: 'HH', date: PADDED, expected: '03' },
    { mask: 'k', date: SUN, expected: '24' },
    { mask: 'K', date: SAT, expected: '0' },
    { mask: 'HH:mm:ss', date: THU, expected: '09:10:07' },
    { mask: 'short', date: TUE, expected: '6/30/26' },
    { mask: 'medium', date: TUE, expected: 'Jun 30, 2026' },
    { mask: 'long', date: TUE, expected: 'June 30, 2026' },
    { mask: 'full', date: TUE, expected: 'Tuesday, June 30, 2026' },
    { mask: 'SHORT', date: PADDED, expected: '1/2/27' },
    { mask: 'Medium', date: PADDED, expected: 'Jan 2, 2027' },
    { mask: 'LONG', date: LEAP, expected: 'February 29, 2024' },
    { mask: 'iso', date: PADDED, expected: '2027-01-02' },
    { mask: 'ISO', date: THU, expected: '2026-10-29' },
    { mask: ' short', date: TUE, expected: ' 03ort' },
    { mask: 'iso8601', date: TUE, expected: 'i0o8601' },
    { mask: 'n', date: TUE, expected: 'n' },
    { mask: 'N', date: TUE, expected: 'N' },
    { mask: 'l', date: TUE, expected: 'l' },
    { mask: 't', date: TUE, expected: 't' },
    { mask: 'tt', date: TUE, expected: 'tt' },
    { mask: 'x', date: TUE, expected: 'x' },
    { mask: 'q', date: TUE, expected: 'q' },
    { mask: 'a', date: TUE, expected: 'a' },
    { mask: ':', date: TUE, expected: ':' },
    { mask: 'mm.dd', date: THU, expected: '10.29' },
    { mask: 'dd,mm', date: THU, expected: '29,10' },
    { mask: 'd"m', date: THU, expected: '29"10' },
    { mask: "'at'", date: TUE, expected: 'at' },
    { mask: "mm 'of' yyyy", date: THU, expected: '10 of 2026' },
    { mask: "''", date: TUE, expected: "'" },
    { mask: "'abc", date: TUE, expected: 'abc' },
    { mask: "'at''q'", date: TUE, expected: "at'q" },
    { mask: "'at'.q", date: TUE, expected: "at'.q" },
    { mask: "d 'o''clock'", date: TUE, expected: "30 o'clock" },
    { mask: '', date: TUE, expected: '' },
  ])('renders $mask as $expected', ({ mask, date, expected }) => {
    expect(cfDateFormat(date, mask)).toBe(expected);
  });

  it.each(['w', 'W', 'F', 'f', 'z', 'Z', 'X'])('rejects the week or zone field %s', (mask) => {
    expect(() => cfDateFormat(TUE, mask)).toThrow(RangeError);
  });

  it('rejects an invalid date', () => {
    expect(() => cfDateFormat(new Date(Number.NaN), 'yyyy')).toThrow(RangeError);
  });
});

describe('cfLsDateFormat', () => {
  it.each([
    { mask: 'short', date: TUE, expected: '6/30/26' },
    { mask: 'medium', date: THU, expected: 'Oct 29, 2026' },
    { mask: 'long', date: LEAP, expected: 'February 29, 2024' },
    { mask: ' short', date: TUE, expected: ' 03ort' },
    { mask: 'mm/dd/yyyy', date: PADDED, expected: '01/02/2027' },
    { mask: 'mmddyy', date: PADDED, expected: '010227' },
    { mask: 'MM/DD/YYYY', date: THU, expected: '10/302/2026' },
  ])('renders $mask as $expected for en_US', ({ mask, date, expected }) => {
    expect(cfLsDateFormat(date, mask)).toBe(expected);
  });
});

describe('cfTimeFormat', () => {
  it.each([
    { mask: 'HH:mm:ss', date: TUE, expected: '15:00:00' },
    { mask: 'HH:mm:ss', date: SUN, expected: '00:07:03' },
    { mask: 'hh:mm tt', date: SUN, expected: '12:07 AM' },
    { mask: 'h:mm tt', date: TUE, expected: '3:00 PM' },
    { mask: 'hh:mm:ss tt', date: SAT, expected: '12:30:45 PM' },
    { mask: 'h:mm t', date: THU, expected: '9:05 A' },
    { mask: 'hhmmss', date: THU, expected: '090507' },
    { mask: 'hh_mm_ss', date: TUE, expected: '03_00_00' },
    { mask: 'HH_mm', date: PADDED, expected: '03_04' },
    { mask: 'HH:mm:ss.000', date: THU, expected: '09:05:07.000' },
    { mask: 'HH:mm:ss.l', date: THU, expected: '09:05:07.8' },
    { mask: 'HH.mm', date: TUE, expected: '15.00' },
    { mask: 'HH,mm', date: TUE, expected: '15,00' },
    { mask: 'tt', date: THU, expected: 'AM' },
    { mask: 't', date: TUE, expected: 'P' },
    { mask: 'TT', date: SAT, expected: 'PM' },
    { mask: 'T', date: SUN, expected: 'A' },
    { mask: 'tT', date: TUE, expected: 'PM' },
    { mask: "t'tt'", date: TUE, expected: 'PMtt' },
    { mask: 'H:M', date: PADDED, expected: '3:4' },
    { mask: 'n', date: PADDED, expected: '4' },
    { mask: 'nn', date: PADDED, expected: '04' },
    { mask: 'm', date: PADDED, expected: '4' },
    { mask: 'M', date: PADDED, expected: '4' },
    { mask: 'mm', date: THU, expected: '05' },
    { mask: 'l', date: PADDED, expected: '6' },
    { mask: 'L', date: PADDED, expected: '6' },
    { mask: 'lll', date: PADDED, expected: '006' },
    { mask: 'LLL', date: LEAP, expected: '999' },
    { mask: 's', date: PADDED, expected: '5' },
    { mask: 'S', date: PADDED, expected: '5' },
    { mask: 'ss', date: PADDED, expected: '05' },
    { mask: 'SS', date: THU, expected: '07' },
    { mask: 'y', date: PADDED, expected: '2027' },
    { mask: 'yy', date: PADDED, expected: '27' },
    { mask: 'yyyy', date: PADDED, expected: '2027' },
    { mask: 'k', date: SUN, expected: '24' },
    { mask: 'kk', date: SUN, expected: '24' },
    { mask: 'K', date: SAT, expected: '0' },
    { mask: 'KK', date: SAT, expected: '00' },
    { mask: 'h', date: SAT, expected: '12' },
    { mask: 'H', date: SAT, expected: '12' },
    { mask: 'd', date: TUE, expected: '30' },
    { mask: 'D', date: TUE, expected: '181' },
    { mask: 'ddd', date: TUE, expected: 'Tue' },
    { mask: 'dddd', date: TUE, expected: 'Tuesday' },
    { mask: 'e', date: TUE, expected: 'Tue' },
    { mask: 'g', date: TUE, expected: 'AD' },
    { mask: 'short', date: TUE, expected: '3:00 PM' },
    { mask: 'medium', date: TUE, expected: '3:00:00 PM' },
    { mask: 'SHORT', date: SUN, expected: '12:07 AM' },
    { mask: 'Medium', date: SAT, expected: '12:30:45 PM' },
    { mask: 'x', date: TUE, expected: 'x' },
    { mask: 'http', date: TUE, expected: '3PMp' },
    { mask: 'utc', date: TUE, expected: 'uPc' },
    { mask: "h 'h'", date: TUE, expected: '3 h' },
    { mask: "'at' h", date: TUE, expected: 'at 3' },
    { mask: "''", date: TUE, expected: "'" },
    { mask: "'abc", date: TUE, expected: 'abc' },
    { mask: '', date: TUE, expected: '' },
  ])('renders $mask as $expected', ({ mask, date, expected }) => {
    expect(cfTimeFormat(date, mask)).toBe(expected);
  });

  it.each(['w', 'W', 'F', 'z', 'Z', 'X', 'Y', 'long', 'full', 'iso', 'LONG', 'ISO'])(
    'rejects the week, zone or zone-bearing mask %s',
    (mask) => {
      expect(() => cfTimeFormat(TUE, mask)).toThrow(RangeError);
    },
  );
});

describe('cfLsTimeFormat', () => {
  const PM = new Date(2026, 9, 29, 15, 45, 7);
  const AM = new Date(2026, 9, 29, 0, 5);

  it.each([
    { locale: 'en_US', mask: 'short', date: PM, expected: '3:45 PM' },
    { locale: 'en_US', mask: 'short', date: AM, expected: '12:05 AM' },
    { locale: 'en_US', mask: 'medium', date: PM, expected: '3:45:07 PM' },
    { locale: 'fil_PH', mask: 'short', date: PM, expected: '3:45 PM' },
    { locale: 'fil_PH', mask: 'short', date: AM, expected: '12:05 AM' },
    { locale: 'de_DE', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'de_DE', mask: 'short', date: AM, expected: '00:05' },
    { locale: 'de_DE', mask: 'medium', date: PM, expected: '15:45:07' },
    { locale: 'fr_FR', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'es_ES', mask: 'short', date: AM, expected: '0:05' },
    { locale: 'hu_HU', mask: 'short', date: AM, expected: '0:05' },
    { locale: 'da_DK', mask: 'short', date: PM, expected: '15.45' },
    { locale: 'id_ID', mask: 'medium', date: PM, expected: '15.45.07' },
    { locale: 'zh_CN', mask: 'short', date: PM, expected: '下午3:45' },
    { locale: 'zh_CN', mask: 'short', date: AM, expected: '上午12:05' },
    { locale: 'zh_CN', mask: 'medium', date: PM, expected: '下午3:45:07' },
    { locale: 'zh_TW', mask: 'short', date: PM, expected: '下午3:45' },
    { locale: 'zh_TW', mask: 'short', date: AM, expected: '上午12:05' },
    { locale: 'zh_HK', mask: 'short', date: PM, expected: '下午3:45' },
    { locale: 'zh_HK', mask: 'short', date: AM, expected: '上午12:05' },
    { locale: 'DE_de', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'zh_tw', mask: 'short', date: PM, expected: '下午3:45' },
    { locale: 'en_us', mask: 'short', date: AM, expected: '12:05 AM' },
    { locale: 'de_DE', mask: 'SHORT', date: PM, expected: '15:45' },
    { locale: 'zh_TW', mask: 'Medium', date: PM, expected: '下午3:45:07' },
    { locale: 'en_AU', mask: 'short', date: PM, expected: '3:45 pm' },
    { locale: 'en_AU', mask: 'short', date: AM, expected: '12:05 am' },
    { locale: 'en_AU', mask: 'medium', date: PM, expected: '3:45:07 pm' },
    { locale: 'ja_JP', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'ja_JP', mask: 'short', date: AM, expected: '0:05' },
    { locale: 'th_TH', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'th_TH', mask: 'short', date: AM, expected: '00:05' },
    { locale: 'es_MX', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'es_MX', mask: 'short', date: AM, expected: '00:05' },
    { locale: 'es_US', mask: 'short', date: PM, expected: '3:45 p.\u00a0m.' },
    { locale: 'es_CO', mask: 'short', date: PM, expected: '3:45 p.\u00a0m.' },
    { locale: 'ar_EG', mask: 'short', date: PM, expected: '\u0663:\u0664\u0665 \u0645' },
    { locale: 'ar_EG', mask: 'short', date: AM, expected: '\u0661\u0662:\u0660\u0665 \u0635' },
    { locale: 'fr_CA', mask: 'short', date: PM, expected: '15 h 45' },
    { locale: 'fr_CA', mask: 'medium', date: PM, expected: '15 h 45 min 07 s' },
    { locale: 'ko_KR', mask: 'short', date: PM, expected: '오후 3:45' },
    { locale: 'zh_SG_#Hans', mask: 'short', date: AM, expected: '上午 12:05' },
    { locale: 'Spanish (Mexican)', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'German (Standard)', mask: 'short', date: PM, expected: '15:45' },
    { locale: 'agq_CM_#Latn', mask: 'short', date: AM, expected: '12:05 AM' },
  ])('renders $mask in $locale as $expected', ({ locale, mask, date, expected }) => {
    expect(cfLsTimeFormat(date, mask, locale)).toBe(expected);
  });

  it.each(['xx_YY', 'iw_IL'])('rejects %s as setLocale does', (locale) => {
    expect(() => cfLsTimeFormat(PM, 'short', locale)).toThrow(
      new RangeError(`${locale} must be one of the ColdFusion supported locales.`),
    );
  });

  it.each([
    { locale: 'de_DE', mask: 'HH:mm', date: PM },
    { locale: 'en_US', mask: 'long', date: PM },
    { locale: 'en_AU', mask: 'long', date: PM },
    { locale: 'de_DE', mask: 'short', date: new Date(Number.NaN) },
  ])('rejects $mask in $locale for $date', ({ locale, mask, date }) => {
    expect(() => cfLsTimeFormat(date, mask, locale)).toThrow(RangeError);
  });
});

describe('cfDateTimeFormat', () => {
  it.each([
    { mask: 'yyMMddHHnnsslll', date: TUE, expected: '260630150000246' },
    { mask: 'yyyymmddhhnnss', date: SAT, expected: '20260704123045' },
    { mask: 'yyyy-mm-dd HH:nn:ss', date: SUN, expected: '2026-01-04 00:07:03' },
    { mask: "yyyy-mm-dd'T'HH:nn:ss", date: THU, expected: '2026-10-29T09:05:07' },
    { mask: 'dd-MMM-yyyy HH:nn:ss', date: THU, expected: '29-Oct-2026 09:05:07' },
    { mask: 'HH:nn:ss', date: THU, expected: '09:05:07' },
    { mask: 'HH:mm', date: THU, expected: '09:10' },
    { mask: 'mm', date: THU, expected: '10' },
    { mask: 'M', date: PADDED, expected: '1' },
    { mask: 'n', date: PADDED, expected: '4' },
    { mask: 'N', date: PADDED, expected: '4' },
    { mask: 's', date: PADDED, expected: '5' },
    { mask: 'S', date: PADDED, expected: '5' },
    { mask: 'l', date: PADDED, expected: '6' },
    { mask: 'L', date: PADDED, expected: '6' },
    { mask: 'lll', date: PADDED, expected: '006' },
    { mask: 't', date: SUN, expected: 'A' },
    { mask: 'tt', date: SUN, expected: 'AM' },
    { mask: 'T', date: TUE, expected: 'P' },
    { mask: 'TT', date: TUE, expected: 'PM' },
    { mask: "t'tt'", date: TUE, expected: 'PMtt' },
    { mask: 'hh:nn:ss tt', date: LEAP, expected: '11:59:59 PM' },
    { mask: 'D', date: THU, expected: '302' },
    { mask: 'DD', date: SUN, expected: '04' },
    { mask: 'DDD', date: THU, expected: 'Thu' },
    { mask: 'ddd', date: THU, expected: 'Thu' },
    { mask: 'dddd', date: THU, expected: 'Thursday' },
    { mask: 'EEEE', date: SAT, expected: 'Saturday' },
    { mask: 'eeee', date: SUN, expected: 'Sunday' },
    { mask: 'e', date: TUE, expected: 'Tue' },
    { mask: 'y', date: PADDED, expected: '2027' },
    { mask: 'yy', date: PADDED, expected: '27' },
    { mask: 'Y', date: PADDED, expected: '2027' },
    { mask: 'YYYY', date: PADDED, expected: '2027' },
    { mask: 'G', date: TUE, expected: 'AD' },
    { mask: 'gg', date: TUE, expected: 'AD' },
    { mask: 'h', date: SUN, expected: '12' },
    { mask: 'hh', date: SAT, expected: '12' },
    { mask: 'k', date: SUN, expected: '24' },
    { mask: 'K', date: SAT, expected: '0' },
    { mask: 'short', date: TUE, expected: '6/30/26, 3:00 PM' },
    { mask: 'medium', date: TUE, expected: 'Jun 30, 2026, 3:00:00 PM' },
    { mask: 'SHORT', date: SUN, expected: '1/4/26, 12:07 AM' },
    { mask: 'Medium', date: LEAP, expected: 'Feb 29, 2024, 11:59:59 PM' },
    { mask: 'mm.dd HH,nn', date: THU, expected: '10.29 09,05' },
    { mask: 'utc', date: TUE, expected: 'uPc' },
    { mask: 'iso8601', date: TUE, expected: 'i0o8601' },
    { mask: 'x', date: TUE, expected: 'x' },
    { mask: 'q', date: TUE, expected: 'q' },
    { mask: 'a', date: TUE, expected: 'a' },
    { mask: "''", date: TUE, expected: "'" },
    { mask: "'abc", date: TUE, expected: 'abc' },
    { mask: '', date: TUE, expected: '' },
  ])('renders $mask as $expected', ({ mask, date, expected }) => {
    expect(cfDateTimeFormat(date, mask)).toBe(expected);
  });

  it.each(['w', 'W', 'F', 'z', 'Z', 'X', 'long', 'full', 'iso', 'Full', 'ISO'])(
    'rejects the week, zone or zone-bearing mask %s',
    (mask) => {
      expect(() => cfDateTimeFormat(TUE, mask)).toThrow(RangeError);
    },
  );
});

describe('cfDateAdd', () => {
  it.each<{ label: string; part: DatePart; n: number; from: Date; to: Date }>([
    { label: 'yyyy clamps Feb 29 to Feb 28', part: 'yyyy', n: 1, from: new Date(2024, 1, 29, 12), to: new Date(2025, 1, 28, 12) },
    { label: 'yyyy keeps Feb 29 in a leap year', part: 'yyyy', n: 4, from: new Date(2024, 1, 29, 12), to: new Date(2028, 1, 29, 12) },
    { label: 'yyyy subtracts and clamps', part: 'yyyy', n: -1, from: new Date(2024, 1, 29, 12), to: new Date(2023, 1, 28, 12) },
    { label: 'yyyy keeps the time of day', part: 'yyyy', n: 30, from: TUE, to: new Date(2056, 5, 30, 15, 0, 0, 246) },
    { label: 'yyyy truncates toward zero', part: 'yyyy', n: -1.9, from: TUE, to: new Date(2025, 5, 30, 15, 0, 0, 246) },
    { label: 'm clamps Jan 31 to Feb 28', part: 'm', n: 1, from: new Date(2026, 0, 31, 10), to: new Date(2026, 1, 28, 10) },
    { label: 'm clamps Jan 31 to Feb 29 in a leap year', part: 'm', n: 1, from: new Date(2024, 0, 31, 10), to: new Date(2024, 1, 29, 10) },
    { label: 'm keeps a day that exists', part: 'm', n: 2, from: new Date(2026, 0, 31, 10), to: new Date(2026, 2, 31, 10) },
    { label: 'm subtracts and clamps', part: 'm', n: -1, from: new Date(2026, 2, 31, 10), to: new Date(2026, 1, 28, 10) },
    { label: 'm crosses a year forwards', part: 'm', n: 13, from: new Date(2026, 0, 31, 10), to: new Date(2027, 1, 28, 10) },
    { label: 'm crosses a year backwards', part: 'm', n: -1, from: new Date(2026, 0, 15, 8), to: new Date(2025, 11, 15, 8) },
    { label: 'm crosses years backwards and clamps', part: 'm', n: -14, from: new Date(2026, 2, 31, 6), to: new Date(2025, 0, 31, 6) },
    { label: 'm keeps the last millisecond of the day', part: 'm', n: 1, from: new Date(2026, 7, 31, 23, 59, 59, 999), to: new Date(2026, 8, 30, 23, 59, 59, 999) },
    { label: 'd crosses a year forwards', part: 'd', n: 1, from: new Date(2026, 11, 31, 10), to: new Date(2027, 0, 1, 10) },
    { label: 'd crosses a year backwards', part: 'd', n: -1, from: new Date(2026, 0, 1, 10), to: new Date(2025, 11, 31, 10) },
    { label: 'd counts Feb 29', part: 'd', n: 365, from: new Date(2024, 0, 1), to: new Date(2024, 11, 31) },
    { label: 'd subtracts a month of days', part: 'd', n: -30, from: TUE, to: new Date(2026, 4, 31, 15, 0, 0, 246) },
    { label: 'd truncates 1.9 to 1', part: 'd', n: 1.9, from: TUE, to: new Date(2026, 6, 1, 15, 0, 0, 246) },
    { label: 'd truncates -1.9 to -1', part: 'd', n: -1.9, from: TUE, to: new Date(2026, 5, 29, 15, 0, 0, 246) },
    { label: 'h crosses midnight backwards', part: 'h', n: -3, from: new Date(2026, 5, 30, 1), to: new Date(2026, 5, 29, 22) },
    { label: 'h crosses midnight forwards', part: 'h', n: 3, from: new Date(2026, 0, 1, 23), to: new Date(2026, 0, 2, 2) },
    { label: 'n crosses midnight forwards', part: 'n', n: 90, from: new Date(2026, 5, 30, 23), to: new Date(2026, 6, 1, 0, 30) },
    { label: 'n crosses midnight backwards', part: 'n', n: -61, from: new Date(2026, 5, 30), to: new Date(2026, 5, 29, 22, 59) },
    { label: 'n truncates 0.9 to 0', part: 'n', n: 0.9, from: TUE, to: TUE },
    { label: 's crosses midnight backwards', part: 's', n: -45, from: new Date(2026, 5, 30, 0, 0, 10), to: new Date(2026, 5, 29, 23, 59, 25) },
    { label: 's adds an hour of seconds', part: 's', n: 3600, from: new Date(2026, 5, 30, 23, 30), to: new Date(2026, 6, 1, 0, 30) },
    { label: 'l crosses midnight forwards', part: 'l', n: 1500, from: new Date(2026, 5, 30, 23, 59, 59), to: new Date(2026, 6, 1, 0, 0, 0, 500) },
    { label: 'l crosses a year backwards', part: 'l', n: -1, from: new Date(2026, 0, 1), to: new Date(2025, 11, 31, 23, 59, 59, 999) },
    { label: 'l accepts the Java int maximum', part: 'l', n: 2_147_483_647, from: TUE, to: new Date(TUE.getTime() + 2_147_483_647) },
    { label: 's accepts the Java int minimum', part: 's', n: -2_147_483_648, from: TUE, to: new Date(TUE.getTime() - 2_147_483_648_000) },
  ])('$label', ({ part, n, from, to }) => {
    expect(cfDateAdd(part, n, from)).toEqual(to);
  });

  it.each([
    { n: 2_147_483_648, value: '2.147483648E9' },
    { n: -2_147_483_649, value: '-2.147483649E9' },
    { n: 1e10, value: '1.0E10' },
    { n: 1e308, value: '1.0E308' },
    { n: Number.MAX_VALUE, value: '1.7976931348623157E308' },
  ])('rejects $n, which does not fit a Java int', ({ n, value }) => {
    const add = (): Date => cfDateAdd('d', n, TUE);
    expect(add).toThrow(RangeError);
    expect(add).toThrow(`Cannot convert the value ${value} to an integer because it cannot fit inside an integer.`);
  });

  it.each<{ part: DatePart; n: number }>([
    { part: 'd', n: 1e9 },
    { part: 'm', n: -2_147_483_648 },
    { part: 'yyyy', n: 2_147_483_647 },
  ])('rejects $part $n, whose instant JS Date cannot represent', ({ part, n }) => {
    const add = (): Date => cfDateAdd(part, n, TUE);
    expect(add).toThrow(RangeError);
    expect(add).toThrow(`DateAdd('${part}', ${n}) is outside the JS Date range`);
  });

  it('leaves its input unchanged', () => {
    const from = new Date(2026, 0, 31, 10);
    const before = from.getTime();
    for (const part of ['yyyy', 'm', 'd', 'h', 'n', 's', 'l'] as const) cfDateAdd(part, 1, from);
    expect(from.getTime()).toBe(before);
  });

  it.each<{ zone: string; label: string; part: DatePart; n: number; from: string; to: string }>([
    { zone: 'America/New_York', label: 'd keeps the wall-clock time across spring-forward', part: 'd', n: 1, from: '2026-03-07T17:00:00Z', to: '2026-03-08T16:00:00Z' },
    { zone: 'America/New_York', label: 'd into the skipped hour keeps the standard offset', part: 'd', n: 1, from: '2026-03-07T07:30:00Z', to: '2026-03-08T06:30:00Z' },
    { zone: 'America/New_York', label: 'd back into the skipped hour moves past it', part: 'd', n: -1, from: '2026-03-09T06:30:00Z', to: '2026-03-08T07:30:00Z' },
    { zone: 'America/New_York', label: 'd back into the repeated hour keeps the standard offset', part: 'd', n: -1, from: '2026-11-02T06:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'd into the repeated hour keeps the daylight offset', part: 'd', n: 1, from: '2026-10-31T05:30:00Z', to: '2026-11-01T05:30:00Z' },
    { zone: 'America/New_York', label: 'd 0 leaves the standard repeated hour unchanged', part: 'd', n: 0, from: '2026-11-01T06:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'd 0 leaves the daylight repeated hour unchanged', part: 'd', n: 0, from: '2026-11-01T05:30:00Z', to: '2026-11-01T05:30:00Z' },
    { zone: 'America/New_York', label: 'm into the repeated hour takes the standard offset', part: 'm', n: 1, from: '2026-10-01T05:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'm back into the repeated hour takes the standard offset', part: 'm', n: -1, from: '2026-12-01T06:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'm into the skipped hour moves past it', part: 'm', n: 1, from: '2026-02-08T07:30:00Z', to: '2026-03-08T07:30:00Z' },
    { zone: 'America/New_York', label: 'm 0 leaves the standard repeated hour unchanged', part: 'm', n: 0, from: '2026-11-01T06:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'yyyy back onto the repeated hour takes the standard offset', part: 'yyyy', n: -1, from: '2026-11-02T06:00:00Z', to: '2025-11-02T06:00:00Z' },
    { zone: 'America/New_York', label: 'yyyy onto the repeated hour takes the standard offset', part: 'yyyy', n: 1, from: '2025-11-01T05:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'h adds elapsed time across spring-forward', part: 'h', n: 1, from: '2026-03-08T06:30:00Z', to: '2026-03-08T07:30:00Z' },
    { zone: 'America/New_York', label: 'h adds elapsed time across fall-back', part: 'h', n: 1, from: '2026-11-01T05:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'n adds elapsed time across spring-forward', part: 'n', n: 30, from: '2026-03-08T06:45:00Z', to: '2026-03-08T07:15:00Z' },
    { zone: 'America/New_York', label: 's adds elapsed time across fall-back', part: 's', n: 3600, from: '2026-11-01T05:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/New_York', label: 'l adds elapsed time across fall-back', part: 'l', n: 3_600_000, from: '2026-11-01T05:30:00Z', to: '2026-11-01T06:30:00Z' },
    { zone: 'America/Havana', label: 'd into a skipped midnight keeps the elapsed day', part: 'd', n: 1, from: '2026-03-07T05:30:00Z', to: '2026-03-08T05:30:00Z' },
  ])('in $zone, $label', ({ zone, part, n, from, to }) => {
    const result = withZone(zone, () => cfDateAdd(part, n, new Date(from)));
    expect(result.toISOString()).toBe(new Date(to).toISOString());
  });
});

describe('formatCsrfExpires', () => {
  it.each([
    { date: TUE, expected: '260630150000246' },
    { date: PADDED, expected: '270102030405006' },
  ])('renders $expected as yyMMddHHnnsslll', ({ date, expected }) => {
    expect(formatCsrfExpires(date)).toBe(expected);
  });
});

describe('formatCookieExpires', () => {
  const issued = new Date(Date.UTC(2026, 10, 10, 10, 36, 30));

  it.each([
    { label: 'a UTC instant without milliseconds', date: new Date(Date.UTC(2026, 5, 30, 19, 0, 0, 246)), expected: 'Tue, 30-Jun-2026 19:00:00 GMT' },
    { label: 'the 30-year never cookie', date: cfDateAdd('yyyy', 30, issued), expected: 'Fri, 10-Nov-2056 10:36:30 GMT' },
    { label: 'the expired now cookie', date: cfDateAdd('d', -1, issued), expected: 'Mon, 09-Nov-2026 10:36:30 GMT' },
    { label: 'a two-digit-year boundary', date: new Date(Date.UTC(1999, 11, 31, 23, 59, 59)), expected: 'Fri, 31-Dec-1999 23:59:59 GMT' },
  ])('renders $label in GMT', ({ date, expected }) => {
    expect(formatCookieExpires(date)).toBe(expected);
  });

  it('converts local time to GMT', () => {
    const expires = withZone('Asia/Kolkata', () => formatCookieExpires(new Date(2026, 5, 30, 15, 0, 0, 246)));
    expect(expires).toBe('Tue, 30-Jun-2026 09:30:00 GMT');
  });

  it('rejects an invalid date', () => {
    expect(() => formatCookieExpires(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('formatSerializerDate', () => {
  it.each([
    { date: TUE, expected: '2026-06-30T15:00:00' },
    { date: SUN, expected: '2026-01-04T00:07:03' },
    { date: LEAP, expected: '2024-02-29T23:59:59' },
  ])('renders $expected in local time', ({ date, expected }) => {
    expect(formatSerializerDate(date)).toBe(expected);
  });
});

describe('formatSerializerUtcDate', () => {
  it.each([
    { offset: 0, expected: '2026-06-30T15:00:00+00:00' },
    { offset: -240, expected: '2026-06-30T15:00:00-04:00' },
    { offset: 330, expected: '2026-06-30T15:00:00+05:30' },
    { offset: 345, expected: '2026-06-30T15:00:00+05:45' },
    { offset: 600, expected: '2026-06-30T15:00:00+10:00' },
    { offset: -150, expected: '2026-06-30T15:00:00-03:30' },
    { offset: -210, expected: '2026-06-30T15:00:00-04:30' },
    { offset: -600, expected: '2026-06-30T15:00:00-010:00' },
    { offset: -570, expected: '2026-06-30T15:00:00-010:30' },
  ])('renders offset $offset as $expected', ({ offset, expected }) => {
    expect(formatSerializerUtcDate(TUE, offset)).toBe(expected);
  });

  it.each([
    { label: 'midnight', date: new Date(2026, 0, 4), expected: '2026-01-04' },
    { label: '23:59', date: new Date(2026, 0, 4, 23, 59, 30), expected: '2026-01-04' },
    { label: '00:01', date: new Date(2026, 0, 4, 0, 1), expected: '2026-01-04T00:01:00+00:00' },
    { label: '23:58', date: new Date(2026, 0, 4, 23, 58), expected: '2026-01-04T23:58:00+00:00' },
  ])('renders $label as $expected', ({ date, expected }) => {
    expect(formatSerializerUtcDate(date, 0)).toBe(expected);
  });

  it.each([
    { zone: 'UTC', instant: '2026-06-30T15:00:00Z', expected: '2026-06-30T15:00:00+00:00' },
    { zone: 'Asia/Kolkata', instant: '2026-06-30T09:30:00Z', expected: '2026-06-30T15:00:00+05:30' },
    { zone: 'Pacific/Honolulu', instant: '2026-07-01T01:00:00Z', expected: '2026-06-30T15:00:00-010:00' },
    { zone: 'America/St_Johns', instant: '2026-06-30T17:30:00Z', expected: '2026-06-30T15:00:00-03:30' },
    { zone: 'America/New_York', instant: '2026-06-30T19:00:00Z', expected: '2026-06-30T15:00:00-04:00' },
    { zone: 'America/New_York', instant: '2026-03-08T07:30:00Z', expected: '2026-03-08T03:30:00-05:00' },
  ])('defaults to the legacy zone lookup in $zone at $instant', ({ zone, instant, expected }) => {
    expect(withZone(zone, () => formatSerializerUtcDate(new Date(instant)))).toBe(expected);
  });
});
