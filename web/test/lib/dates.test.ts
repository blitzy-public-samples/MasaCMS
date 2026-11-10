import { describe, expect, it } from 'vitest';
import {
  dateKeyFor,
  formatDateField,
  formatDateTimeShort,
  localeHasDayParts,
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
  ])('takes %s from localeLookup', (javaLocale, dtCh, dtFormat, dateKeyFormat, dtExample, locale) => {
    expect(fieldsOf(dateKeyFor(javaLocale))).toEqual(expectedKey(locale, dtCh, dtFormat, dateKeyFormat, dtExample));
  });

  it.each([
    ['de_DE', '.', '1,0,2', 'DD.MM.YYYY', '315.11.2024', 'de-DE'],
    ['nl_NL', '-', '1,0,2', 'DD-MM-YYYY', '315-11-2024', 'nl-NL'],
    ['ru_RU', '.', '1,0,2', 'DD.MM.YYYY', '315.11.2024', 'ru-RU'],
    ['ja_JP', '/', '1,2,0', 'YYYY/MM/DD', '2024/11/315', 'ja-JP'],
    ['th_TH', '/', '1,0', 'DD/MM/DD', '315/11/315', 'th-TH'],
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
  it.each<[Date | string, string]>([
    [new Date(2026, 9, 29, 15, 45), '10/302/2026 3:45 PM'],
    [new Date(2026, 9, 29, 0, 5), '10/302/2026 12:05 AM'],
    ["{ts '2026-10-29 15:45:00'}", '10/302/2026 3:45 PM'],
  ])('formats %j', (value, expected) => {
    expect(formatDateTimeShort(value, 'MM/DD/YYYY')).toBe(expected);
  });

  it.each(['', null, undefined])('renders %j as a space', (value) => {
    expect(formatDateTimeShort(value, 'MM/DD/YYYY')).toBe(' ');
  });

  it('throws for an unparsable value', () => {
    expect(() => formatDateTimeShort('garbage', 'MM/DD/YYYY')).toThrow(RangeError);
  });
});
