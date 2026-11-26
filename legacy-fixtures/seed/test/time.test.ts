// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, describe, expect, it } from 'vitest';
import { createCalendar, type Calendar } from '../src/time.js';

const BUSINESS_DATE = '2026-06-30';
const cal = createCalendar(BUSINESS_DATE);

describe('createCalendar', () => {
  it('anchors day offset 0 on the business date', () => {
    expect(cal.businessDate).toBe(BUSINESS_DATE);
    expect(cal.localDate(0)).toBe(BUSINESS_DATE);
    expect(cal.dayOffsetOf(BUSINESS_DATE)).toBe(0);
    expect(Object.isFrozen(cal)).toBe(true);
  });

  it.each(['1753-01-01', '2024-02-29', '9999-12-31'])('accepts %s', (date) => {
    expect(createCalendar(date).localDate(0)).toBe(date);
  });

  it.each([
    '',
    '2026-6-30',
    '2026-06-30T00:00:00.000',
    ' 2026-06-30',
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-06-00',
    '1752-12-31',
    '0026-06-30',
    '10000-01-01',
  ])('rejects %j', (date) => {
    expect(() => createCalendar(date)).toThrow(
      new RangeError(`createCalendar: businessDate must be a yyyy-MM-dd date in years 1753..9999, got ${JSON.stringify(date)}`),
    );
  });
});

describe('localDate', () => {
  it.each([
    [-1, '2026-06-29'],
    [1, '2026-07-01'],
    [-120, '2026-03-02'],
    [-181, '2025-12-31'],
    [365, '2027-06-30'],
  ])('localDate(%d) is %s', (offset, expected) => {
    expect(cal.localDate(offset)).toBe(expected);
  });

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects dayOffset %d', (offset) => {
    expect(() => cal.localDate(offset)).toThrow(new RangeError(`localDate: dayOffset must be a safe integer, got ${offset}`));
  });

  it.each([
    ['9999-12-31', 1],
    ['1753-01-01', -1],
  ])('rejects a day beyond the datetime years from %s', (date, offset) => {
    expect(() => createCalendar(date).localDate(offset)).toThrow(
      new RangeError(`localDate: dayOffset must be within the datetime years 1753..9999, got ${offset}`),
    );
  });
});

describe('localTimestamp', () => {
  it.each([
    [0, 9 * 60 + 30, 120, '2026-06-30T09:30:00.120'],
    [0, 0, 0, '2026-06-30T00:00:00.000'],
    [0, 1439, 990, '2026-06-30T23:59:00.990'],
    [0, 1440, 0, '2026-07-01T00:00:00.000'],
    [0, -1, 0, '2026-06-29T23:59:00.000'],
    [1, 2 * 1440 + 5, 10, '2026-07-03T00:05:00.010'],
    [-114, 150, 0, '2026-03-08T02:30:00.000'],
    [124, 90, 0, '2026-11-01T01:30:00.000'],
  ])('localTimestamp(%d, %d, %d) is %s', (offset, minutes, ms, expected) => {
    expect(cal.localTimestamp(offset, minutes, ms)).toBe(expected);
  });

  it('defaults ms to 0', () => {
    expect(cal.localTimestamp(-1, 61)).toBe('2026-06-29T01:01:00.000');
  });

  it.each([5, -10, 1000, 10.5, Number.NaN])('rejects ms %d', (ms) => {
    expect(() => cal.localTimestamp(0, 0, ms)).toThrow(
      new RangeError(`localTimestamp: ms must be a multiple of 10 in 0..990, got ${ms}`),
    );
  });

  it.each([
    ['dayOffset', 0.5, 0],
    ['minutes', 0, 1.5],
    ['minutes', 0, Number.NEGATIVE_INFINITY],
  ])('rejects a non-integer %s', (name, offset, minutes) => {
    const value = name === 'dayOffset' ? offset : minutes;
    expect(() => cal.localTimestamp(offset, minutes)).toThrow(
      new RangeError(`localTimestamp: ${name} must be a safe integer, got ${value}`),
    );
  });

  it('rejects a result beyond the datetime years', () => {
    expect(() => createCalendar('9999-12-31').localTimestamp(0, 1440)).toThrow(
      new RangeError('localTimestamp: result falls outside the datetime years 1753..9999'),
    );
  });
});

describe('addMinutes', () => {
  it.each([
    ['2026-06-30T23:50:00.120', 15, '2026-07-01T00:05:00.120'],
    ['2026-06-30T23:50:00.120', -1440, '2026-06-29T23:50:00.120'],
    ['2026-06-30T23:50:00.120', 0, '2026-06-30T23:50:00.120'],
    ['2026-02-28T23:59:30.000', 1, '2026-03-01T00:00:30.000'],
  ])('addMinutes(%s, %d) is %s', (ts, minutes, expected) => {
    expect(cal.addMinutes(ts, minutes)).toBe(expected);
  });

  it.each([
    '2026-06-30 23:50:00.120',
    '2026-06-30T24:00:00.000',
    '2026-06-30T23:60:00.000',
    '2026-06-31T00:00:00.000',
    '2026-06-30T23:50:00.125',
    '2026-06-30T23:50:00',
    '2026-06-30',
    '1752-12-31T23:59:00.000',
  ])('rejects ts %j', (ts) => {
    expect(() => cal.addMinutes(ts, 1)).toThrow(
      new RangeError(
        `addMinutes: ts must be a yyyy-MM-ddTHH:mm:ss.SSS timestamp in years 1753..9999 with milliseconds a multiple of 10, got ${JSON.stringify(ts)}`,
      ),
    );
  });

  it('rejects non-integer minutes', () => {
    expect(() => cal.addMinutes('2026-06-30T00:00:00.000', 0.5)).toThrow(
      new RangeError('addMinutes: minutes must be a safe integer, got 0.5'),
    );
  });

  it('rejects a result beyond the datetime years', () => {
    expect(() => cal.addMinutes('9999-12-31T23:59:00.000', 1)).toThrow(
      new RangeError('addMinutes: result falls outside the datetime years 1753..9999'),
    );
  });
});

describe('dayOffsetOf', () => {
  it.each([
    ['2026-06-29', -1],
    ['2026-03-02', -120],
    ['2027-06-30', 365],
  ])('dayOffsetOf(%s) is %d', (date, expected) => {
    expect(cal.dayOffsetOf(date)).toBe(expected);
  });

  it('inverts localDate', () => {
    for (let offset = -400; offset <= 400; offset += 1) expect(cal.dayOffsetOf(cal.localDate(offset))).toBe(offset);
  });

  it.each(['2026-06-31', '2026-06-30T00:00:00.000'])('rejects %j', (date) => {
    expect(() => cal.dayOffsetOf(date)).toThrow(
      new RangeError(`dayOffsetOf: date must be a yyyy-MM-dd date in years 1753..9999, got ${JSON.stringify(date)}`),
    );
  });
});

describe('weekdays', () => {
  it.each([
    [-2, 0, false, -8],
    [-1, 1, true, -1],
    [0, 2, true, -1],
    [3, 5, true, -1],
    [4, 6, false, -1],
    [5, 0, false, -1],
    [6, 1, true, 6],
  ])('day %d is weekday %d (isWeekday %s), Monday on or before %d', (offset, day, workday, monday) => {
    expect(cal.weekday(offset)).toBe(day);
    expect(cal.isWeekday(offset)).toBe(workday);
    expect(cal.mondayOnOrBefore(offset)).toBe(monday);
    expect(cal.weekday(cal.mondayOnOrBefore(offset))).toBe(1);
  });

  it('rejects a non-integer dayOffset', () => {
    expect(() => cal.weekday(1.5)).toThrow(new RangeError('weekday: dayOffset must be a safe integer, got 1.5'));
  });
});

describe('compareTimestamps', () => {
  it.each([
    ['2026-06-29T23:59:59.990', '2026-06-30T00:00:00.000', -1],
    ['2026-06-30T09:30:00.120', '2026-06-30T09:30:00.120', 0],
    ['2026-06-30T09:30:00.130', '2026-06-30T09:30:00.120', 1],
  ])('compareTimestamps(%s, %s) is %d', (a, b, expected) => {
    expect(cal.compareTimestamps(a, b)).toBe(expected);
  });

  it('orders successive events as time order', () => {
    const events = [cal.addMinutes(cal.localTimestamp(0, 600), 5), cal.localTimestamp(-1, 600), cal.localTimestamp(0, 600)];
    expect(events.sort(cal.compareTimestamps)).toEqual([
      '2026-06-29T10:00:00.000',
      '2026-06-30T10:00:00.000',
      '2026-06-30T10:05:00.000',
    ]);
  });

  it.each([
    ['2026-06-30', '2026-06-30T00:00:00.000', 'a'],
    ['2026-06-30T00:00:00.000', '2026-06-30 00:00:00.000', 'b'],
  ])('rejects a malformed operand (%s, %s)', (a, b, name) => {
    const bad = name === 'a' ? a : b;
    expect(() => cal.compareTimestamps(a, b)).toThrow(
      new RangeError(
        `compareTimestamps: ${name} must be a yyyy-MM-ddTHH:mm:ss.SSS timestamp in years 1753..9999 with milliseconds a multiple of 10, got ${JSON.stringify(bad)}`,
      ),
    );
  });
});

describe('host time zone', () => {
  const original = process.env.TZ;

  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  const sample = (calendar: Calendar): string[] => [
    calendar.localDate(-1),
    calendar.localTimestamp(0, 9 * 60 + 30, 120),
    calendar.localTimestamp(-114, 150),
    calendar.localTimestamp(124, 90),
    calendar.addMinutes('2026-03-08T01:59:00.000', 1),
    String(calendar.weekday(0)),
    String(calendar.mondayOnOrBefore(0)),
    String(calendar.dayOffsetOf('2026-11-01')),
  ];

  it('never changes a value', () => {
    process.env.TZ = 'UTC';
    const offsetUtc = new Date(Date.UTC(2026, 5, 30)).getTimezoneOffset();
    const expected = sample(createCalendar(BUSINESS_DATE));
    for (const zone of ['America/New_York', 'Pacific/Chatham', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      expect(new Date(Date.UTC(2026, 5, 30)).getTimezoneOffset()).not.toBe(offsetUtc);
      expect(sample(createCalendar(BUSINESS_DATE))).toEqual(expected);
    }
    expect(expected).toEqual([
      '2026-06-29',
      '2026-06-30T09:30:00.120',
      '2026-03-08T02:30:00.000',
      '2026-11-01T01:30:00.000',
      '2026-03-08T02:00:00.000',
      '2',
      '-1',
      '124',
    ]);
  });
});
