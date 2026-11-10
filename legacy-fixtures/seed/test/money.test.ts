// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, expect, it } from 'vitest';
import { MONEY_PATTERN, formatUnits, fromCents, sumUnits, units } from '../src/money.js';

describe('units', () => {
  it.each([
    [0, 0, 0n],
    [1, 0, 10_000n],
    [12, 3456, 123_456n],
    [0, 5000, 5000n],
    [-7, 5000, -75_000n],
    [-1, 1, -10_001n],
    [Number.MAX_SAFE_INTEGER, 9999, BigInt(Number.MAX_SAFE_INTEGER) * 10_000n + 9999n],
    [Number.MIN_SAFE_INTEGER, 9999, BigInt(Number.MIN_SAFE_INTEGER) * 10_000n - 9999n],
  ])('units(%d, %d) is %s', (whole, fraction, expected) => {
    expect(units(whole, fraction)).toBe(expected);
  });

  it('defaults fraction to 0', () => {
    expect(units(-3)).toBe(-30_000n);
  });

  it('gives the fraction of -0 a negative sign', () => {
    expect(units(-0, 5000)).toBe(-5000n);
    expect(formatUnits(units(-0, 5000))).toBe('-0.5000');
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53)])('rejects whole %d', (whole) => {
    expect(() => units(whole, 0)).toThrow(new RangeError(`units: whole must be a safe integer, got ${whole}`));
  });

  it.each([-1, 10_000, 0.5, Number.NaN])('rejects fraction %d', (fraction) => {
    expect(() => units(1, fraction)).toThrow(
      new RangeError(`units: fraction must be an integer in 0..9999, got ${fraction}`),
    );
  });
});

describe('formatUnits', () => {
  it.each([
    [0n, '0.0000'],
    [1n, '0.0001'],
    [-1n, '-0.0001'],
    [10_000n, '1.0000'],
    [12_345_000n, '1234.5000'],
    [-75_000n, '-7.5000'],
    [-5000n, '-0.5000'],
    [10n ** 30n + 42n, '100000000000000000000000000.0042'],
  ])('formatUnits(%s) is %s', (value, expected) => {
    expect(formatUnits(value)).toBe(expected);
    expect(formatUnits(value)).toMatch(MONEY_PATTERN);
  });

  it.each([
    [0, 0],
    [7, 50],
    [-7, 5000],
    [-123, 9999],
    [Number.MAX_SAFE_INTEGER, 1],
  ])('round-trips units(%d, %d)', (whole, fraction) => {
    expect(formatUnits(units(whole, fraction))).toBe(`${whole}.${String(fraction).padStart(4, '0')}`);
  });
});

describe('fromCents', () => {
  it.each([
    [0, 0n, '0.0000'],
    [1999, 199_900n, '19.9900'],
    [-123, -12_300n, '-1.2300'],
    [-5, -500n, '-0.0500'],
  ])('fromCents(%d) is %s', (cents, expected, formatted) => {
    expect(fromCents(cents)).toBe(expected);
    expect(formatUnits(fromCents(cents))).toBe(formatted);
  });

  it.each([1.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53])('rejects %d', (cents) => {
    expect(() => fromCents(cents)).toThrow(new RangeError(`fromCents: cents must be a safe integer, got ${cents}`));
  });
});

describe('sumUnits', () => {
  it.each([
    [[], 0n],
    [[units(1, 2500)], 12_500n],
    [[units(1, 2500), units(-3, 5000), fromCents(1)], -22_400n],
    [[2n ** 60n, 2n ** 60n, 1n], 2n ** 61n + 1n],
  ])('sums case %# exactly', (values, expected) => {
    expect(sumUnits(values)).toBe(expected);
  });
});

describe('MONEY_PATTERN', () => {
  it.each(['0.0000', '-7.5000', '1234.5000', '100000000000000000000.0001'])('accepts %s', (text) => {
    expect(MONEY_PATTERN.test(text)).toBe(true);
  });

  it.each(['1', '1.5', '1.50000', '.5000', '-.5000', '+1.0000', '1.0000 ', '1,0000', ''])('rejects %j', (text) => {
    expect(MONEY_PATTERN.test(text)).toBe(false);
  });
});
