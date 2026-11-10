import { describe, expect, it } from 'vitest';
import {
  LEGACY_ADMIN_SENTINEL_ID,
  cfDateAdd,
  cfDateFormat,
  cfDateTimeFormat,
  cfLsDateFormat,
  cfTimeFormat,
  cfUuid,
  formatCookieExpires,
  formatSerializerDate,
  isCfUuid,
  isLegacyFindOneId,
} from '../../src/legacy-compat/index.js';

type DatePart = Parameters<typeof cfDateAdd>[0];

const NOON = new Date(2026, 5, 30, 12, 0, 5, 123);
const CF_UUID_SHAPE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
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

describe('legacy-compat ids', () => {
  it('generates 100 distinct 35-character upper-case CF uuids', () => {
    const ids = Array.from({ length: 100 }, () => cfUuid());
    for (const id of ids) {
      expect(id).toHaveLength(35);
      expect(id).toMatch(CF_UUID_SHAPE);
    }
    expect(new Set(ids).size).toBe(100);
  });

  // Legacy checks the sentinel beside isValid('uuid') (jsonApiUtility.cfc:1265), so only the findOne test accepts it.
  it.each([
    { label: 'a generated id', value: cfUuid(), uuid: true, findOneId: true },
    { label: 'a lower-case generated id', value: cfUuid().toLowerCase(), uuid: true, findOneId: true },
    { label: 'the admin sentinel', value: LEGACY_ADMIN_SENTINEL_ID, uuid: false, findOneId: true },
    { label: 'an RFC 4122 uuid', value: '6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c', uuid: false, findOneId: false },
    { label: 'junk', value: 'not-a-uuid', uuid: false, findOneId: false },
  ])('classifies $label: isCfUuid $uuid, isLegacyFindOneId $findOneId', ({ value, uuid, findOneId }) => {
    expect(isCfUuid(value)).toBe(uuid);
    expect(isLegacyFindOneId(value)).toBe(findOneId);
  });

  it('exposes the home-node sentinel id', () => {
    expect(LEGACY_ADMIN_SENTINEL_ID).toBe('00000000000000000000000000000000001');
  });
});

describe('legacy-compat date masks', () => {
  // dateTimeFormat reads m as month and n as minutes, as ACF does; the CSRF expiry mask relies on nn.
  it.each([
    { name: 'cfDateTimeFormat', format: cfDateTimeFormat, mask: 'yyMMddHHnnsslll', expected: '260630120005123' },
    { name: 'cfDateTimeFormat', format: cfDateTimeFormat, mask: 'HH:nn:ss.lll', expected: '12:00:05.123' },
    { name: 'cfDateTimeFormat', format: cfDateTimeFormat, mask: 'HH:mm', expected: '12:06' },
    { name: 'cfDateFormat', format: cfDateFormat, mask: 'mm/dd/yyyy', expected: '06/30/2026' },
    { name: 'cfLsDateFormat', format: cfLsDateFormat, mask: 'MM/DD/YYYY', expected: '06/181/2026' },
    { name: 'cfTimeFormat', format: cfTimeFormat, mask: 'HH:mm:ss', expected: '12:00:05' },
  ])('$name renders $mask as $expected', ({ format, mask, expected }) => {
    expect(format(NOON, mask)).toBe(expected);
  });

  it('renders the admin dateKeyFormat with the day of year, as legacy shows 10/302/2026', () => {
    expect(cfLsDateFormat(new Date(2026, 9, 29), 'MM/DD/YYYY')).toBe('10/302/2026');
  });

  it('renders the serializer date hint in local time', () => {
    expect(formatSerializerDate(NOON)).toBe('2026-06-30T12:00:05');
  });
});

describe('formatCookieExpires', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati'])(
    'renders a UTC instant in GMT when the process zone is %s',
    (zone) => {
      const expires = withZone(zone, () => formatCookieExpires(new Date(Date.UTC(2026, 5, 30, 12, 0, 0))));
      expect(expires).toBe('Tue, 30-Jun-2026 12:00:00 GMT');
    },
  );
});

describe('cfDateAdd', () => {
  it.each<{ part: DatePart; n: number; expected: Date }>([
    { part: 'l', n: 123, expected: new Date(2026, 5, 30, 12, 0, 5, 246) },
    { part: 'h', n: 3, expected: new Date(2026, 5, 30, 15, 0, 5, 123) },
    { part: 'd', n: -1, expected: new Date(2026, 5, 29, 12, 0, 5, 123) },
    { part: 'yyyy', n: 30, expected: new Date(2056, 5, 30, 12, 0, 5, 123) },
  ])('adds $n of $part', ({ part, n, expected }) => {
    expect(cfDateAdd(part, n, NOON)).toEqual(expected);
  });
});
