// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MONEY_SCALE, formatMoney, moneyFromNumeric, parseMoney, sumMoney, type Money } from '../../src/domain/money.js';

const NUMERIC_19_4_MAX: Money = 10n ** 19n - 1n;
const FIXTURE_STORED_TEXT = /^-?[0-9]{1,15}\.[0-9]{4}$/;

/** Parses an amount the fixture accepts, failing the test on rejection. */
const parse = (input: string): Money => {
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

  it.each(['1000000000000000.0000', '-1000000000000000.0000', '1000000000000000', '\t1000000000000000\n'])(
    'rejects %j with 16 integer digits as range',
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
    ['a trailing line separator', '12\u2028'],
    ['a trailing paragraph separator', '12\u2029'],
    ['a trailing next-line character', '12\u0085'],
    ['a leading no-break space', '\u00A012'],
    ['a trailing figure space', '12\u2007'],
    ['a trailing ideographic space', '12\u3000'],
    ['a leading byte order mark', '\uFEFF12'],
    ['a trailing delete character', '12\u007F'],
    ['an internal space', '1 2'],
    ['an internal tab', '1\t2'],
    ['a space after the minus sign', '- 5'],
    ['a space before the fraction', '12 .5'],
    ['a doubled minus sign', '--1'],
    ['a bare minus sign', '-'],
    ['hex notation', '0x10'],
    ['digit separators', '1_000'],
    ['full-width digits', '\uFF11\uFF12'],
  ])('rejects %s with reason format', (_label, text) => {
    expect(parseMoney(text)).toEqual({ ok: false, reason: 'format' });
  });

  // finance.cfc accepts only a java.lang.String amount: form and URL values, or a JSON string.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the boolean true', true],
    ['the boolean false', false],
    ['an object', {}],
    ['an array', []],
    ['an array holding amount text', ['5']],
    ['the JSON integer 5', 5],
    ['the JSON integer -1', -1],
    ['the JSON integer 0', 0],
    ['the JSON number 12345678901.2345', 12_345_678_901.2345],
    ['the JSON number 123456789012.5', 123_456_789_012.5],
    ['the JSON number 99999999999.9999', 99_999_999_999.9999],
    ['the JSON number 1E2', 1e2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 5n],
  ])('rejects %s, which is not a string, with reason format', (_label, input) => {
    expect(parseMoney(input)).toEqual({ ok: false, reason: 'format' });
  });
});

// Masa's Portcullis trims form and URL values with ColdFusion trim(), and finance.cfc trims a JSON amount alike.
describe('parseMoney surrounding whitespace, as ColdFusion trim() strips it', () => {
  it.each([
    [' 5', '5.0000'],
    ['5 ', '5.0000'],
    ['5\n', '5.0000'],
    ['\t5', '5.0000'],
    ['\r\n-12.5\r\n', '-12.5000'],
    ['\u0000\u0001\u001F5\u000B\u000C', '5.0000'],
    ['  000012.5  ', '12.5000'],
    ['\n12345678901.2345\t', '12345678901.2345'],
  ])('accepts %j as %s', (text, formatted) => {
    expect(formatMoney(parse(text))).toBe(formatted);
  });

  it('strips exactly the code units U+0000 to U+0020 around an amount', () => {
    const stripped: number[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const c = String.fromCharCode(code);
      const result = parseMoney(`${c}5${c}`);
      if (result.ok && result.value === 50_000n) stripped.push(code);
    }
    expect(stripped).toEqual(Array.from({ length: 0x21 }, (_, code) => code));
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
