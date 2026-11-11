// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MONEY_SCALE, formatMoney, moneyFromNumeric, parseMoney, sumMoney, type Money } from '../../src/domain/money.js';

const NUMERIC_19_4_MAX: Money = 10n ** 19n - 1n;
const FIXTURE_STORED_TEXT = /^-?[0-9]{1,15}\.[0-9]{4}$/;

/** Parses an amount the fixture accepts, failing the test on rejection. */
const parse = (input: unknown): Money => {
  const result = parseMoney(input);
  if (!result.ok) throw new Error(`amount ${JSON.stringify(input)} rejected: ${result.reason}`);
  return result.value;
};

describe('money scale', () => {
  it('uses the numeric(19,4) scale of four decimals', () => {
    expect(MONEY_SCALE).toBe(4);
  });

  it('holds an amount as an integer scaled by 10^4', () => {
    expect(parseMoney('1234.56')).toEqual({ ok: true, value: 12_345_600n });
  });
});

describe('parseMoney and formatMoney with fixture amount text', () => {
  it.each(['0.0000', '1.0000', '1234.5600', '-42.1000', '99.9999', '0.0001', '-0.0001'])(
    'round-trips %s unchanged',
    (text) => {
      expect(formatMoney(parse(text))).toBe(text);
    },
  );

  it.each([
    ['12', '12.0000'],
    ['12.5', '12.5000'],
    ['0.1', '0.1000'],
    ['-3.25', '-3.2500'],
    ['007', '7.0000'],
  ])('formats %s with four decimals as %s', (text, formatted) => {
    expect(formatMoney(parse(text))).toBe(formatted);
  });

  it.each([
    [1n, '0.0001'],
    [99n, '0.0099'],
    [-10_000n, '-1.0000'],
    [0n, '0.0000'],
  ])('formats scaled value %s as %s', (value, formatted) => {
    expect(formatMoney(value)).toBe(formatted);
  });
});

describe('sumMoney', () => {
  it('sums 0.1 and 0.2 to 0.3000 without float drift', () => {
    expect(formatMoney(sumMoney([parse('0.1'), parse('0.2')]))).toBe('0.3000');
  });

  it('sums one thousand amounts of 0.0001 to exactly 0.1000', () => {
    expect(formatMoney(sumMoney(Array.from({ length: 1000 }, () => parse('0.0001'))))).toBe('0.1000');
  });

  it('sums any iterable of amounts', () => {
    function* amounts(): Generator<Money> {
      yield parse('10.0001');
      yield parse('-0.0002');
    }
    expect(formatMoney(sumMoney(amounts()))).toBe('9.9999');
  });

  it('sums no amounts to 0.0000', () => {
    expect(formatMoney(sumMoney([]))).toBe('0.0000');
  });
});

describe('negative amounts', () => {
  it('sums -0.5000 and 0.5000 to 0.0000 without a minus sign', () => {
    expect(formatMoney(sumMoney([parse('-0.5000'), parse('0.5000')]))).toBe('0.0000');
  });

  it('sums negatives exactly', () => {
    expect(formatMoney(sumMoney([parse('-1.25'), parse('-2.5'), parse('0.0001')]))).toBe('-3.7499');
  });

  it.each(['-0', '-0.0000'])('formats negative zero %s as 0.0000', (text) => {
    expect(formatMoney(parse(text))).toBe('0.0000');
  });
});

describe('numeric(19,4) bounds', () => {
  it.each([
    ['999999999999999.9999', NUMERIC_19_4_MAX],
    ['-999999999999999.9999', -NUMERIC_19_4_MAX],
  ])('accepts the bound %s and round-trips it', (text, value) => {
    expect(parseMoney(text)).toEqual({ ok: true, value });
    expect(formatMoney(value)).toBe(text);
  });

  it.each(['1000000000000000.0000', '-1000000000000000.0000', '1000000000000000'])(
    'rejects %s with 16 integer digits as range',
    (text) => {
      expect(parseMoney(text)).toEqual({ ok: false, reason: 'range' });
    },
  );
});

// finance.cfc answers every rejected amount with invalidParameters; 'format' and 'range' are money.ts's own labels.
describe('parseMoney rejections the fixture amount pattern makes', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['non-numeric text', 'abc'],
    ['a trailing letter', '12a'],
    ['more than four decimals', '1.23456'],
    ['exponent form 1e3', '1e3'],
    ['exponent form 1E-2', '1E-2'],
    ['thousands separators', '1,000.00'],
    ['a leading plus sign', '+1'],
    ['a missing integer part', '.5'],
    ['a trailing decimal point', '1.'],
    ['leading whitespace', ' 12'],
    ['trailing whitespace', '12 '],
    ['a trailing newline', '12\n'],
    ['a trailing carriage return', '12\r'],
    ['a trailing CRLF', '12\r\n'],
    ['a trailing line separator', '12\u2028'],
    ['a trailing paragraph separator', '12\u2029'],
    ['a trailing next-line character', '12\u0085'],
    ['a trailing newline after a fraction', '12.5\n'],
    ['a doubled minus sign', '--1'],
    ['a bare minus sign', '-'],
    ['hex notation', '0x10'],
    ['digit separators', '1_000'],
    ['full-width digits', '\uFF11\uFF12'],
  ])('rejects %s with reason format', (_label, text) => {
    expect(parseMoney(text)).toEqual({ ok: false, reason: 'format' });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an object', {}],
    ['an array', []],
  ])('rejects %s with reason format', (_label, input) => {
    expect(parseMoney(input)).toEqual({ ok: false, reason: 'format' });
  });
});

describe('parseMoney with JSON numbers, as ACF prints them after deserializeJSON', () => {
  it.each([
    [12, '12.0000'],
    [12.5, '12.5000'],
    [0.1, '0.1000'],
    [-0.5, '-0.5000'],
    [0.0001, '0.0001'],
    [-0.0001, '-0.0001'],
    [0.1 + 0.2, '0.3000'],
    [1_000_000_000_000, '1000000000000.0000'],
    [99_999_999_999.99995, '100000000000.0000'],
    [100_000_000_000.5, '100000000000.0000'],
    [100_000_000_001.5, '100000000002.0000'],
    [10_000_000_000.25, '10000000000.2000'],
    [10_000_000_000.75, '10000000000.8000'],
  ])('reads %s as %s', (input, formatted) => {
    expect(formatMoney(parse(input))).toBe(formatted);
  });

  it.each([
    ['0.00001, printed in E notation', 0.00001],
    ['1234567890123.5, printed in E notation', 1_234_567_890_123.5],
    ['1.23456, with five decimals', 1.23456],
    ['0.00025, with five decimals', 0.00025],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s with reason format', (_label, input) => {
    expect(parseMoney(input)).toEqual({ ok: false, reason: 'format' });
  });

  it('rejects the integer 10^16 with reason range', () => {
    expect(parseMoney(10_000_000_000_000_000)).toEqual({ ok: false, reason: 'range' });
  });
});

describe('moneyFromNumeric', () => {
  it.each([
    ['12.3400', 123_400n],
    ['-0.0100', -100n],
    ['0', 0n],
    ['5', 50_000n],
    ['12.34', 123_400n],
    ['12.34000000', 123_400n],
    ['999999999999999.9999', NUMERIC_19_4_MAX],
    ['-999999999999999.9999', -NUMERIC_19_4_MAX],
  ])('reads PostgreSQL numeric text %s', (text, value) => {
    expect(moneyFromNumeric(text)).toBe(value);
  });

  it.each(['abc', '', '12.3.4', ' 1', '1e3', 'NaN', '12\n', '12\r', '12\r\n', '12\u2028', '12\u2029', '12.3400\n'])(
    'throws RangeError for malformed text %j',
    (text) => {
      expect(() => moneyFromNumeric(text)).toThrow(RangeError);
      expect(() => moneyFromNumeric(text)).toThrow(`not numeric text: ${JSON.stringify(text)}`);
    },
  );

  it('throws RangeError for text with nonzero digits beyond scale 4', () => {
    expect(() => moneyFromNumeric('12.34001')).toThrow(RangeError);
    expect(() => moneyFromNumeric('12.34001')).toThrow('numeric text exceeds scale 4: "12.34001"');
  });
});

describe('money properties', () => {
  it('round-trips every numeric(19,4) value through fixture text', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -NUMERIC_19_4_MAX, max: NUMERIC_19_4_MAX }), (value) => {
        const text = formatMoney(value);
        expect(text).toMatch(FIXTURE_STORED_TEXT);
        expect(parseMoney(text)).toEqual({ ok: true, value });
        expect(moneyFromNumeric(text)).toBe(value);
      }),
      { seed: 20260601, numRuns: 500 },
    );
  });
});
