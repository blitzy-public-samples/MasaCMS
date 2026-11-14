// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Recording-db numeric(p,s) and timestamp(3) input coercion against outcomes read from PostgreSQL 16. */
import { describe, expect, it } from 'vitest';
import { createRecordingDb } from '../helpers/app.js';
import { dayRow, timesheetRow } from '../helpers/days.js';

type Column = 'hours' | 'backup_lsn' | 'work_date';
type Outcome = { readonly stored: unknown } | { readonly code: string };

const SHEET = timesheetRow();
const FINISHED_AT = new Date(2026, 5, 30);

/** `input` seeded into `column` and read back as the recording db returns it, or the SQLSTATE it raises. */
function outcomeOf(column: Column, input: unknown): Outcome {
  try {
    if (column === 'backup_lsn') {
      const db = createRecordingDb({ migration_watermark: [{ legacy_table: 'timesheet', direction: 'forward', backup_lsn: input, finished_at: FINISHED_AT }] });
      return { stored: db.rowsOf('migration_watermark')[0]?.['backup_lsn'] };
    }
    const db = createRecordingDb({ timesheet_day: [{ ...dayRow(SHEET, { workDate: '2026-06-08' }), [column]: input }] });
    return { stored: db.rowsOf('timesheet_day')[0]?.[column] };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string') throw error;
    return { code };
  }
}

/** Local wall-clock time with a 1-based month; years below 100 stay as given. */
function local(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0, ms = 0): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, seconds, ms);
  return date;
}

const NUMERIC: readonly (readonly [Column, unknown, Outcome])[] = [
  ['hours', '1000000000000000.0000', { code: '22003' }],
  ['hours', '999999999999999.9999', { stored: '999999999999999.9999' }],
  ['hours', '999999999999999.99995', { code: '22003' }],
  ['hours', '999999999999999.99994999', { stored: '999999999999999.9999' }],
  ['hours', '-999999999999999.99995', { code: '22003' }],
  ['hours', '0.00005', { stored: '0.0001' }],
  ['hours', '-0.00005', { stored: '-0.0001' }],
  ['hours', '-0.00004', { stored: '0.0000' }],
  ['hours', '1e3', { stored: '1000.0000' }],
  ['hours', '1.5E-5', { stored: '0.0000' }],
  ['hours', 'NaN', { stored: 'NaN' }],
  ['hours', 'Infinity', { code: '22003' }],
  ['hours', '-Infinity', { code: '22003' }],
  ['hours', ' +12.3 ', { stored: '12.3000' }],
  ['hours', '.5', { stored: '0.5000' }],
  ['hours', '5.', { stored: '5.0000' }],
  ['hours', '1e15', { code: '22003' }],
  ['hours', '0.00004999999999', { stored: '0.0000' }],
  ['hours', '00000000000000000000000001.5', { stored: '1.5000' }],
  ['hours', '1_000.5_5', { stored: '1000.5500' }],
  ['hours', '0x1F', { stored: '31.0000' }],
  ['hours', '1e2000000000', { code: '22003' }],
  ['hours', '+NaN', { code: '22P02' }],
  ['hours', '1.2.3', { code: '22P02' }],
  ['hours', 'abc', { code: '22P02' }],
  ['hours', '', { code: '22P02' }],
  ['hours', 7.5, { stored: '7.5000' }],
  ['hours', 0.00004999999999, { stored: '0.0000' }],
  ['hours', 1e21, { code: '22003' }],
  ['hours', Number.NaN, { stored: 'NaN' }],
  ['hours', Number.POSITIVE_INFINITY, { code: '22003' }],
  ['backup_lsn', '9999999999999999999999999', { stored: '9999999999999999999999999' }],
  ['backup_lsn', '9999999999999999999999999.5', { code: '22003' }],
  ['backup_lsn', '10000000000000000000000000', { code: '22003' }],
];

const TIMESTAMPS: readonly (readonly [string, Outcome])[] = [
  ['2026-13-01 00:00:00', { code: '22008' }],
  ['2026-02-30', { code: '22008' }],
  ['2026-02-28 23:61:00', { code: '22008' }],
  ['2026-02-28 24:00:01', { code: '22008' }],
  ['2026-02-28 24:00:00.0000006', { code: '22008' }],
  ['2026-02-28 23:59:61', { code: '22008' }],
  ['2026-06-30 23:59:60.0000006', { code: '22008' }],
  ['0000-01-01', { code: '22008' }],
  ['2023-02-29', { code: '22008' }],
  ['1900-02-29', { code: '22008' }],
  ['2026-06-30 25:00', { code: '22008' }],
  ['2026-00-10', { code: '22008' }],
  ['2026-06-00', { code: '22008' }],
  ['not a date', { code: '22007' }],
  ['2026-02-28 24:00:00', { stored: local(2026, 3, 1) }],
  ['2026-02-28 23:59:60', { stored: local(2026, 3, 1) }],
  ['2026-06-30 23:59:59.9995', { stored: local(2026, 7, 1) }],
  ['2026-06-30 23:59:59.99949999', { stored: local(2026, 7, 1) }],
  ['2026-06-30 23:59:59.9994', { stored: local(2026, 6, 30, 23, 59, 59, 999) }],
  ['0050-01-01', { stored: local(50, 1, 1) }],
  ['2024-02-29', { stored: local(2024, 2, 29) }],
  ['2026-06-30T12:00:00.123+05:00', { stored: local(2026, 6, 30, 12, 0, 0, 123) }],
  ['2026-06-30 23:59:59.0005', { stored: local(2026, 6, 30, 23, 59, 59, 1) }],
  ['2026-06-30 12:00:00.0000005', { stored: local(2026, 6, 30, 12) }],
  ['2026-06-30 12:00:00.0000015', { stored: local(2026, 6, 30, 12) }],
  ['2026-06-30 12:00:00.0004995', { stored: local(2026, 6, 30, 12, 0, 0, 1) }],
  ['2026-06-30 12:30:60.5', { stored: local(2026, 6, 30, 12, 31, 0, 500) }],
  ['2026-06-30 12:00:00.', { stored: local(2026, 6, 30, 12) }],
  ['1999-12-31 23:59:59.0005', { stored: local(1999, 12, 31, 23, 59, 59) }],
  ['9999-12-31 23:59:59.9995', { stored: local(10000, 1, 1) }],
];

describe('recording db numeric(p,s)', () => {
  it.each(NUMERIC)('stores %s from %o as PostgreSQL does', (column, input, outcome) => {
    expect(outcomeOf(column, input)).toStrictEqual(outcome);
  });

  it.each([
    ['1000000000000000.0000', 'A field with precision 19, scale 4 must round to an absolute value less than 10^15.'],
    ['-inf', 'A field with precision 19, scale 4 cannot hold an infinite value.'],
  ])('rejects %o with PostgreSQL detail', (input, detail) => {
    expect(() => createRecordingDb({ timesheet_day: [{ ...dayRow(SHEET, { workDate: '2026-06-08' }), hours: input }] })).toThrow(
      expect.objectContaining({ code: '22003', message: 'numeric field overflow', detail }),
    );
  });
});

describe('recording db timestamp(3)', () => {
  it.each(TIMESTAMPS)('stores %o as PostgreSQL does', (input, outcome) => {
    expect(outcomeOf('work_date', input)).toStrictEqual(outcome);
  });
});
