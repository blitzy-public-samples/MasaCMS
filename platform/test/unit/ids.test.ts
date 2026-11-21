import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ADMIN_SENTINEL_ID, cfUuid, isCfUuid, isLegacyFindOneId } from '../../src/legacy-compat/ids.js';

const CF_UUID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const RFC_UUID = '6f0a2c1e-5b7d-4e8a-9c3f-0d1e2f3a4b5c';

describe('cfUuid', () => {
  it('returns a 35-character uppercase hex value grouped 8-4-4-16', () => {
    const id = cfUuid();
    expect(id).toHaveLength(35);
    expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
    expect(isCfUuid(id)).toBe(true);
  });

  it('returns a distinct value on every call', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => cfUuid()));
    expect(ids.size).toBe(10_000);
  });

  describe('time order', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** cfUuid with the wall clock at `wallMs`. */
    function idAt(wallMs: number): string {
      vi.spyOn(performance, 'now').mockReturnValue(wallMs - performance.timeOrigin);
      return cfUuid();
    }

    // ACF createUUID() sampled on the legacy server: the first group is the low 32 bits of currentTimeMillis * 10.
    it.each([
      ['the 100 µs tick of the wall clock', 1_795_098_255_446.35, '89F0435F'],
      ['the tick past a 32-bit wrap', 1_794_866_832_998.95, '00000005'],
    ])('starts with %s', (_label, wallMs, group) => {
      expect(idAt(wallMs).slice(0, 8)).toBe(group);
    });

    it('sorts an id after the ids made before it', () => {
      const ids = [0, 0.2, 1, 25].map((offset) => idAt(1_795_098_255_446.35 + offset));
      expect([...ids].sort()).toEqual(ids);
    });
  });
});

describe('isCfUuid', () => {
  it.each([
    ['upper case', CF_UUID],
    ['lower case', CF_UUID.toLowerCase()],
    ['mixed case', 'a1b2c3d4-E5F6-a7b8-C9D0e1f2A3B4c5d6'],
  ])('accepts a CF uuid in %s', (_label, value) => {
    expect(isCfUuid(value)).toBe(true);
  });

  it.each([
    ['a 36-character RFC 4122 uuid', RFC_UUID],
    ['an upper-case RFC 4122 uuid', RFC_UUID.toUpperCase()],
    ['an empty string', ''],
    ['a value one character short', CF_UUID.slice(0, -1)],
    ['a value one character long', `${CF_UUID}0`],
    ['a non-hex character', `G${CF_UUID.slice(1)}`],
    ['separators in the wrong positions', 'A1B2C3D4E-5F6-A7B8-C9D0E1F2A3B4C5D6'],
    ['no separators', CF_UUID.replaceAll('-', '')],
    ['surrounding whitespace', ` ${CF_UUID} `],
    ['the legacy admin sentinel', LEGACY_ADMIN_SENTINEL_ID],
  ])('rejects %s', (_label, value) => {
    expect(isCfUuid(value)).toBe(false);
  });
});

describe('LEGACY_ADMIN_SENTINEL_ID', () => {
  it('is the 35-character home-node content id', () => {
    expect(LEGACY_ADMIN_SENTINEL_ID).toBe('00000000000000000000000000000000001');
    expect(LEGACY_ADMIN_SENTINEL_ID).toHaveLength(35);
  });
});

describe('isLegacyFindOneId', () => {
  it.each([
    { label: 'a CF uuid', value: CF_UUID, expected: true },
    { label: 'a lower-case CF uuid', value: CF_UUID.toLowerCase(), expected: true },
    { label: 'the legacy admin sentinel', value: LEGACY_ADMIN_SENTINEL_ID, expected: true },
    { label: 'the sentinel as 1', value: '1', expected: true },
    { label: 'the sentinel as 01', value: '01', expected: true },
    { label: 'the sentinel padded with spaces', value: ' 1 ', expected: true },
    { label: 'the sentinel as 1.0', value: '1.0', expected: true },
    { label: 'the sentinel as 1e0', value: '1e0', expected: true },
    { label: 'the sentinel as 1.e0', value: '1.e0', expected: true },
    { label: 'the sentinel as +1', value: '+1', expected: true },
    { label: 'the sentinel with a Java-trimmed control char', value: '1\u0001', expected: true },
    { label: 'the sentinel with a trailing dot', value: '1.', expected: false },
    { label: 'the sentinel with a trailing dot before a space', value: '01. ', expected: false },
    { label: 'another number', value: '2', expected: false },
    { label: 'zero', value: '0', expected: false },
    { label: 'minus one', value: '-1', expected: false },
    { label: 'a digit followed by a letter', value: '1a', expected: false },
    { label: 'hex notation', value: '0x1', expected: false },
    { label: 'an empty string', value: '', expected: false },
    { label: 'a 36-character RFC 4122 uuid', value: RFC_UUID, expected: false },
    { label: 'a filename', value: 'about-us', expected: false },
  ])('returns $expected for $label', ({ value, expected }) => {
    expect(isLegacyFindOneId(value)).toBe(expected);
  });
});
