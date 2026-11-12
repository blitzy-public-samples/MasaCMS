import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  dateKeyFor,
  formatDateField,
  formatDateTimeShort,
  isMoreThanFiftyYearsAfter,
  localeHasDayParts,
  lsDateFormatString,
  parseLegacyDate,
  shortDatePattern,
  type DateKey,
} from '@/lib/dates';
import { isSafeHtml, toString } from '@/lib/html';

type KeyFields = Omit<DateKey, 'script'> & { script: string };

/** The key with its script as a markup string. */
const fieldsOf = (key: DateKey): KeyFields => ({ ...key, script: toString(key.script) });

/** The key utils.setJSDateKeys builds from its parts. */
function expectedKey(locale: string, dtCh: string, dtFormat: string, dateKeyFormat: string, dtExample: string): KeyFields {
  return {
    locale,
    dtCh,
    dtFormat,
    dateKeyFormat,
    dtExample,
    script: `<script type="text/javascript">var dtExample="${dtExample}", dtCh="${dtCh}", dtFormat =[${dtFormat}], dtLocale="${locale}";</script>`,
    objInc: `dtExample:"${dtExample}",\r\ndtCh:"${dtCh}",\r\ndtFormat:[${dtFormat}],\r\ndtLocale:"${locale}"`,
  };
}

describe('dateKeyFor', () => {
  it('builds the en_US key', () => {
    const key = dateKeyFor('en_US');
    expect(key.locale).toBe('en-US');
    expect(key.dtCh).toBe('/');
    expect(key.dtFormat).toBe('0,1,2');
    expect(key.dateKeyFormat).toBe('MM/DD/YYYY');
    expect(key.dtExample).toBe('11/315/2024');
    expect(isSafeHtml(key.script)).toBe(true);
    expect(toString(key.script)).toBe(
      '<script type="text/javascript">var dtExample="11/315/2024", dtCh="/", dtFormat =[0,1,2], dtLocale="en-US";</script>',
    );
    expect(key.objInc).toBe('dtExample:"11/315/2024",\r\ndtCh:"/",\r\ndtFormat:[0,1,2],\r\ndtLocale:"en-US"');
  });

  it.each([
    ['zh_HK', '-', '1,0,2', 'dd-mm-yyyy', '10-11-2024', 'zh-HK'],
    ['zh_TW', '/', '2,0,1', 'yyyy/mm/dd', '2024/11/10', 'zh-TW'],
    ['ru', '.', '1,0,2', 'dd.mm.yyyy', '10.11.2024', 'ru'],
    ['tr', '.', '1,0,2', 'dd.mm.yyyy', '10.11.2024', 'tr'],
    ['uk', '/', '1,0,2', 'dd/mm/yyyy', '10/11/2024', 'uk'],
    ['zh_tw', '/', '2,0,1', 'yyyy/mm/dd', '2024/11/10', 'zh-tw'],
    ['Zh_Tw', '/', '2,0,1', 'yyyy/mm/dd', '2024/11/10', 'Zh-Tw'],
    ['ZH_HK', '-', '1,0,2', 'dd-mm-yyyy', '10-11-2024', 'ZH-HK'],
    ['RU', '.', '1,0,2', 'dd.mm.yyyy', '10.11.2024', 'RU'],
  ])('takes %s from localeLookup', (javaLocale, dtCh, dtFormat, dateKeyFormat, dtExample, locale) => {
    expect(fieldsOf(dateKeyFor(javaLocale))).toEqual(expectedKey(locale, dtCh, dtFormat, dateKeyFormat, dtExample));
  });

  it.each([
    ['de_DE', '.', '1,0,2', 'DD.MM.YYYY', '315.11.2024', 'de-DE'],
    ['nl_NL', '-', '1,0,2', 'DD-MM-YYYY', '315-11-2024', 'nl-NL'],
    ['ru_RU', '.', '1,0,2', 'DD.MM.YYYY', '315.11.2024', 'ru-RU'],
    ['ja_JP', '/', '1,2,0', 'YYYY/MM/DD', '2024/11/315', 'ja-JP'],
    ['th_TH', '/', '1,0,2', 'DD/MM/YYYY', '315/11/2024', 'th-TH'],
    ['de_de', '.', '1,0,2', 'DD.MM.YYYY', '315.11.2024', 'de-de'],
    ['hu_hu', '.', '-1,-1,0', 'YYYY.MM.DD', '2024.11.315', 'hu-hu'],
    ['zh_cn', '/', '1,2,0', 'YYYY/MM/DD', '2024/11/315', 'zh-cn'],
  ])('derives %s from its short date', (javaLocale, dtCh, dtFormat, dateKeyFormat, dtExample, locale) => {
    expect(fieldsOf(dateKeyFor(javaLocale))).toEqual(expectedKey(locale, dtCh, dtFormat, dateKeyFormat, dtExample));
  });

  it('returns one frozen key per locale', () => {
    const key = dateKeyFor('en_US');
    expect(dateKeyFor('en_US')).toBe(key);
    expect(Object.isFrozen(key)).toBe(true);
  });
});

describe('shortDatePattern', () => {
  it.each([
    ['en_US', '11/10/24'],
    ['de_DE', '10.11.24'],
    ['ja_JP', '2024/11/10'],
    ['hu_hu', '2024. 11. 10.'],
    ['th_TH', '10/11/24'],
  ])('%s -> %s', (javaLocale, expected) => {
    expect(shortDatePattern(javaLocale)).toBe(expected);
  });
});

describe('localeHasDayParts', () => {
  it.each([
    ['en_US', true],
    ['de_DE', false],
    ['en_AU', true],
    ['ja_JP', false],
    ['en_us', true],
  ])('%s -> %s', (javaLocale, expected) => {
    expect(localeHasDayParts(javaLocale)).toBe(expected);
  });
});

describe('parseLegacyDate', () => {
  it.each([
    ["{ts '2026-10-29 15:45:00'}", new Date(2026, 9, 29, 15, 45)],
    ['2026-10-29', new Date(2026, 9, 29)],
    ['  2026-10-29  ', new Date(2026, 9, 29)],
    ['2026-10-29T15:45', new Date(2026, 9, 29, 15, 45)],
    ['2026-10-29 15:45:07.5', new Date(2026, 9, 29, 15, 45, 7, 500)],
    ['2026-10-29 15:45:07.123', new Date(2026, 9, 29, 15, 45, 7, 123)],
    ['2024-02-29', new Date(2024, 1, 29)],
  ])('parses %j', (value, expected) => {
    expect(parseLegacyDate(value)).toEqual(expected);
  });

  it.each<Date | string | null | undefined>([
    null,
    undefined,
    new Date(Number.NaN),
    '',
    'garbage',
    '2026-02-29',
    '2026-00-10',
    '2026-13-01',
    '2026-10-00',
    '2026-10-32',
    '2026-10-29 24:00',
    '2026-10-29 23:60',
    '2026-10-29 23:59:60',
    '2026-10-29T15:45:00Z',
    "{ts '2026-10-29'",
  ])('rejects %s', (value) => {
    expect(parseLegacyDate(value)).toBeNull();
  });

  it('returns a valid Date as given', () => {
    const date = new Date(2026, 9, 29);
    expect(parseLegacyDate(date)).toBe(date);
  });

  it('keeps a two-digit year', () => {
    const date = parseLegacyDate('0099-01-15');
    expect([date?.getFullYear(), date?.getMonth(), date?.getDate()]).toEqual([99, 0, 15]);
  });
});

describe('formatDateField', () => {
  it.each<[Date | string, string, string]>([
    [new Date(2026, 9, 29), 'MM/DD/YYYY', '10/302/2026'],
    [new Date(2026, 9, 29), 'dd.mm.yyyy', '29.10.2026'],
    [new Date(2026, 9, 29), 'DD.MM.YYYY', '302.10.2026'],
    ["{ts '2026-10-29 15:45:00'}", 'MM/DD/YYYY', '10/302/2026'],
    ['2026-10-29', 'yyyy/mm/dd', '2026/10/29'],
  ])('formats %j with %s', (value, dateKeyFormat, expected) => {
    expect(formatDateField(value, dateKeyFormat)).toBe(expected);
  });

  it.each(['', null, undefined])('renders %j empty', (value) => {
    expect(formatDateField(value, 'MM/DD/YYYY')).toBe('');
  });

  it.each([
    [new Date(2077, 9, 28), '10/301/2077'],
    [new Date(2077, 9, 29), ''],
    [new Date(2090, 0, 1), ''],
  ])('blanks dates more than 50 years ahead: %s', (value, expected) => {
    expect(formatDateField(value, 'MM/DD/YYYY', new Date(2026, 9, 29))).toBe(expected);
  });
});

describe('formatDateTimeShort', () => {
  it.each<[Date | string, string, string, string]>([
    [new Date(2026, 9, 29, 15, 45), 'MM/DD/YYYY', 'en_US', '10/302/2026 3:45 PM'],
    [new Date(2026, 9, 29, 0, 5), 'MM/DD/YYYY', 'en_US', '10/302/2026 12:05 AM'],
    ["{ts '2026-10-29 15:45:00'}", 'MM/DD/YYYY', 'en_US', '10/302/2026 3:45 PM'],
    [new Date(2026, 9, 29, 15, 45, 7), 'DD.MM.YYYY', 'de_DE', '302.10.2026 15:45'],
    [new Date(2026, 9, 29, 15, 45, 7), 'DD/MM/YYYY', 'fr_FR', '302/10/2026 15:45'],
    [new Date(2026, 9, 29, 15, 45, 7), 'YYYY/MM/DD', 'zh_CN', '2026/10/302 下午3:45'],
    [new Date(2026, 9, 29, 15, 45, 7), 'DD/MM/YYYY', 'en_AU', '302/10/2026 3:45 pm'],
    [new Date(2026, 9, 29, 15, 45, 7), 'DD/MM/YYYY', 'es_MX', '302/10/2026 15:45'],
  ])('formats %j with %s in %s', (value, dateKeyFormat, javaLocale, expected) => {
    expect(formatDateTimeShort(value, dateKeyFormat, javaLocale)).toBe(expected);
  });

  it.each(['', null, undefined])('renders %j as a space', (value) => {
    expect(formatDateTimeShort(value, 'MM/DD/YYYY', 'en_US')).toBe(' ');
  });

  it('throws for an unparsable value', () => {
    expect(() => formatDateTimeShort('garbage', 'MM/DD/YYYY', 'en_US')).toThrow(RangeError);
  });
});

// Expected values below are ACF 2023's LSDateFormat under setLocale and dateDiff, on a UTC server with the clock at NOW.
const NOW = new Date(2026, 10, 11, 9, 0, 0);

describe('lsDateFormatString', () => {
  const systemZone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T09:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
    if (systemZone === undefined) delete process.env.TZ;
    else process.env.TZ = systemZone;
  });

  it.each([
    ['06/30/2026', 'en_US', 'MM/DD/YYYY', '06/181/2026'],
    ['01/06/2026', 'en_US', 'MM/DD/YYYY', '01/06/2026'],
    ['01/06/2026', 'en_GB', 'DD/MM/YYYY', '152/06/2026'],
    ['June 30, 2026', 'en_GB', 'DD/MM/YYYY', '181/06/2026'],
    ['30.06.2026', 'de_DE', 'DD.MM.YYYY', '181.06.2026'],
    ['30. Juni 2026', 'de_DE', 'DD.MM.YYYY', '181.06.2026'],
    ['Dienstag, 30. Juni 2026', 'de_DE', 'DD.MM.YYYY', '181.06.2026'],
    ['30 juin 2026', 'fr_FR', 'DD/MM/YYYY', '181/06/2026'],
    ['lundi 1 décembre 2031', 'fr_FR', 'DD/MM/YYYY', '335/12/2031'],
    ['30.06.26', 'en_US', 'MM/DD/YYYY', '06/181/0026'],
    ['2026', 'en_US', 'MM/DD/YYYY', '07/199/1905'],
    ["{ts '2026-11-30 00:00:00'}", 'en_US', 'MM/DD/YYYY', '11/334/2026'],
    ['12/31/2099', 'en_US', 'MM/DD/YYYY', '12/365/2099'],
    ['June 30, 2026 at 11:30:00 PM EST', 'en_US', 'MM/DD/YYYY', '07/182/2026'],
    ['02/29/1500', 'en_US', 'MM/DD/YYYY', '02/60/1500'],
    ["{ts '1582-10-04 23:59:00'}", 'en_US', 'MM/DD/YYYY', '10/277/1582'],
    ['1/1/100', 'en_US', 'MM/DD/YYYY', '01/01/0100'],
    ['  ', 'en_US', 'MM/DD/YYYY', ''],
    ['', 'en_US', 'MM/DD/YYYY', ''],
  ])('formats %j under %s with %s', (value, javaLocale, mask, expected) => {
    expect(lsDateFormatString(value, mask, javaLocale)).toBe(expected);
  });

  it.each([
    ['garbage', 'en_US'],
    ['30. Juni 2026', 'en_US'],
    ['02/30/2026', 'de_DE'],
    ['June 30, 2026 at 11:30:00 PM EST', 'zh_CN'],
  ])('fails on %j under %s as LSDateFormat does', (value, javaLocale) => {
    expect(() => lsDateFormatString(value, 'MM/DD/YYYY', javaLocale)).toThrow(new Error(`${value} is an invalid date format.`));
  });
});

describe('isMoreThanFiftyYearsAfter', () => {
  it.each([
    [new Date(2077, 10, 10), false],
    [new Date(2077, 10, 11, 9, 0, 0), true],
    [new Date(2099, 11, 31), true],
  ])('%s', (date, expected) => {
    expect(isMoreThanFiftyYearsAfter(date, NOW)).toBe(expected);
  });
});
