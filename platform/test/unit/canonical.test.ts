import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  CanonicalEncodingError,
  SERIALIZED_DOCUMENT_COLUMNS,
  assignOccurrences,
  canonicalTypeForPostgres,
  canonicalTypeForSqlServer,
  changedColumns,
  compareEncodings,
  decodeRow,
  decodeValue,
  diffMultiset,
  encodeKey,
  encodeRow,
  encodeValue,
  formatCanonicalTimestamp,
  legacyRowHash,
  multiset,
  roundToSqlServerDatetime,
  rowChecksum,
  sha256Hex,
  tableChecksum,
  type CanonicalColumn,
  type CanonicalType,
  type CanonicalTypeInfo,
  type CanonicalValue,
  type ChecksumEntry,
} from '../../src/migration-kit/canonical.js';

const TEN_MB = 10 * 1024 * 1024;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const UNKNOWN_TAG: string = 'x';

/** Asserts that `fn` throws a CanonicalEncodingError whose message contains `message`. */
function expectEncodingError(fn: () => unknown, message: string): void {
  expect(fn).toThrow(CanonicalEncodingError);
  expect(fn).toThrow(message);
}

/** Local Date at 2026-06-30 12:00:00 plus `ms` milliseconds. */
function noonWith(ms: number): Date {
  return new Date(2026, 5, 30, 12, 0, 0, ms);
}

describe('CanonicalEncodingError', () => {
  it('is a named Error without column, type or cause by default', () => {
    const error = new CanonicalEncodingError('bad value');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CanonicalEncodingError');
    expect(error.message).toBe('bad value');
    expect(error.column).toBeUndefined();
    expect(error.type).toBeUndefined();
    expect(error.cause).toBeUndefined();
  });

  it('names the column in the message and keeps column, type and cause', () => {
    const cause = new Error('root');
    const error = new CanonicalEncodingError('bad value', { column: 'title', type: 's', cause });
    expect(error.message).toBe('bad value (column title)');
    expect(error.column).toBe('title');
    expect(error.type).toBe('s');
    expect(error.cause).toBe(cause);
  });
});

describe('encodeValue', () => {
  describe('s', () => {
    it.each([
      { label: 'NULL', value: null, expected: 'N' },
      { label: 'undefined', value: undefined, expected: 'N' },
      { label: 'the empty string', value: '', expected: 's0:' },
      { label: 'the text N', value: 'N', expected: 's1:N' },
      { label: 'a two-byte character', value: 'é', expected: 's2:é' },
      { label: 'a four-byte emoji', value: '😀', expected: 's4:😀' },
      { label: 'text containing the delimiter', value: 'a:b', expected: 's3:a:b' },
      { label: 'control characters', value: '\u0000\n\t', expected: 's3:\u0000\n\t' },
      { label: 'char padding', value: 'ab   ', expected: 's5:ab   ' },
    ])('encodes $label', ({ value, expected }) => {
      expect(encodeValue('s', value)).toBe(expected);
    });

    it.each([
      { label: 'a number', value: 1, message: 's expects a string, got number' },
      { label: 'a Date', value: new Date(0), message: 's expects a string, got Date' },
      { label: 'an array', value: ['a'], message: 's expects a string, got array' },
      { label: 'a lone high surrogate', value: 'a\uD800', message: 's value contains an unpaired UTF-16 surrogate' },
      { label: 'a lone low surrogate', value: '\uDC00a', message: 's value contains an unpaired UTF-16 surrogate' },
    ])('rejects $label', ({ value, message }) => {
      expectEncodingError(() => encodeValue('s', value), message);
    });

    it.each([
      { label: 'ASCII', value: 'x'.repeat(TEN_MB) },
      { label: 'four-byte', value: '😀'.repeat(TEN_MB / 4) },
    ])('encodes, checksums and decodes a 10 MB $label value', ({ value }) => {
      const columns: CanonicalColumn[] = [{ name: 'body', type: 's' }];
      const encoding = encodeRow(columns, { body: value });
      expect(encoding.startsWith('s10485760:')).toBe(true);
      expect(encoding.length).toBe('s10485760:'.length + value.length);
      expect(rowChecksum(columns, { body: value })).toBe(sha256Hex(encoding));
      expect(decodeRow(columns, encoding).body === value).toBe(true);
    });
  });

  describe('i', () => {
    it.each([
      { label: '42', value: 42, expected: 'i2:42' },
      { label: 'a negative number', value: -7, expected: 'i2:-7' },
      { label: 'zero', value: 0, expected: 'i1:0' },
      { label: 'bit true', value: true, expected: 'i1:1' },
      { label: 'bit false', value: false, expected: 'i1:0' },
      { label: 'a bigint beyond 2^53', value: 9_007_199_254_740_993n, expected: 'i16:9007199254740993' },
      { label: 'a signed, zero-padded string', value: '+007', expected: 'i1:7' },
      { label: 'negative zero text', value: '-0', expected: 'i1:0' },
      { label: 'a negative string', value: '-12', expected: 'i3:-12' },
    ])('encodes $label', ({ value, expected }) => {
      expect(encodeValue('i', value)).toBe(expected);
    });

    it.each([
      { label: 'a fraction', value: 1.5, message: 'i expects a safe integer number' },
      { label: 'an unsafe integer', value: 2 ** 53, message: 'i expects a safe integer number' },
      { label: 'NaN', value: Number.NaN, message: 'i expects a safe integer number' },
      { label: 'decimal text', value: '1.0', message: 'decimal-integer string, got string' },
      { label: 'the empty string', value: '', message: 'decimal-integer string, got string' },
      { label: 'an object', value: {}, message: 'got object' },
      { label: 'an array', value: [1], message: 'got array' },
    ])('rejects $label', ({ value, message }) => {
      expectEncodingError(() => encodeValue('i', value), message);
    });
  });

  describe('f', () => {
    it.each([
      { label: '0.1', value: 0.1, expected: 'f3:0.1' },
      { label: '0.1 + 0.2', value: 0.1 + 0.2, expected: 'f19:0.30000000000000004' },
      { label: '1e21', value: 1e21, expected: 'f5:1e+21' },
      { label: 'a negative number', value: -2.5, expected: 'f4:-2.5' },
      { label: 'the smallest subnormal', value: 5e-324, expected: 'f6:5e-324' },
      { label: 'text with a trailing zero', value: '0.10', expected: 'f3:0.1' },
      { label: 'exponent text', value: '1E3', expected: 'f4:1000' },
      { label: 'text without an integer part', value: '.5', expected: 'f3:0.5' },
    ])('encodes $label as its shortest round-trip text', ({ value, expected }) => {
      expect(encodeValue('f', value)).toBe(expected);
    });

    it.each([0.1, 0.1 + 0.2, 1e21, -2.5, 5e-324, Number.MAX_VALUE, 123_456_789.125])('round-trips %d', (value) => {
      expect(Number(decodeValue('f', encodeValue('f', value)))).toBe(value);
    });

    it.each([
      { label: 'Infinity', value: Number.POSITIVE_INFINITY, message: 'f value must be finite' },
      { label: 'NaN', value: Number.NaN, message: 'f value must be finite' },
      { label: 'overflowing text', value: '1e999', message: 'f value must be finite' },
      { label: 'non-numeric text', value: 'abc', message: 'f expects a finite number or numeric string, got string' },
      { label: 'a boolean', value: true, message: 'got boolean' },
    ])('rejects $label', ({ value, message }) => {
      expectEncodingError(() => encodeValue('f', value), message);
    });
  });

  describe('d', () => {
    it.each([
      { value: 1.5, scale: 4, expected: '1.5000' },
      { value: '1.5', scale: 4, expected: '1.5000' },
      { value: 0, scale: 4, expected: '0.0000' },
      { value: 12n, scale: 2, expected: '12.00' },
      { value: -12n, scale: 0, expected: '-12' },
      { value: '1.23456', scale: 4, expected: '1.2346' },
      { value: '1.23454', scale: 4, expected: '1.2345' },
      { value: '9.99995', scale: 4, expected: '10.0000' },
      { value: '-9.99995', scale: 4, expected: '-10.0000' },
      { value: '-0.00005', scale: 4, expected: '-0.0001' },
      { value: '-0.00001', scale: 4, expected: '0.0000' },
      { value: '-0', scale: 2, expected: '0.00' },
      { value: '+3', scale: 1, expected: '3.0' },
      { value: '007.50', scale: 2, expected: '7.50' },
      { value: '.5', scale: 1, expected: '0.5' },
      { value: '5.', scale: 0, expected: '5' },
      { value: '2.5', scale: 0, expected: '3' },
      { value: '99.995', scale: 2, expected: '100.00' },
      { value: '1.5e2', scale: 2, expected: '150.00' },
      { value: '1.5e-3', scale: 4, expected: '0.0015' },
      { value: '12.345e1', scale: 2, expected: '123.45' },
      { value: '1.2345e1', scale: 2, expected: '12.35' },
      { value: 1.005, scale: 2, expected: '1.01' },
    ])('encodes $value at scale $scale as $expected', ({ value, scale, expected }) => {
      expect(encodeValue('d', value, { scale })).toBe(`d${String(expected.length)}:${expected}`);
    });

    it('encodes 1.5 at scale 4 as d6:1.5000 from a number or a string', () => {
      expect(encodeValue('d', 1.5, { scale: 4 })).toBe('d6:1.5000');
      expect(encodeValue('d', '1.5', { scale: 4 })).toBe('d6:1.5000');
    });

    it('accepts the maximum scale of 16383', () => {
      expect(encodeValue('d', '1', { scale: 16_383 })).toBe(`d16385:1.${'0'.repeat(16_383)}`);
    });

    it.each([
      { label: '1e21', value: 1e21, message: 'd expects a decimal string, bigint or finite number below 1e21, got number' },
      { label: 'NaN', value: Number.NaN, message: 'got number' },
      { label: 'Infinity', value: Number.POSITIVE_INFINITY, message: 'got number' },
      { label: 'a boolean', value: true, message: 'got boolean' },
      { label: 'non-numeric text', value: 'abc', message: 'd value is not a decimal number' },
      { label: 'a comma decimal', value: '1,5', message: 'd value is not a decimal number' },
      { label: 'the empty string', value: '', message: 'd value is not a decimal number' },
      { label: 'an exponent beyond 1e6', value: '1e1000001', message: 'd exponent out of range' },
    ])('rejects $label', ({ value, message }) => {
      expectEncodingError(() => encodeValue('d', value, { scale: 2 }), message);
    });

    it.each([
      { label: 'a missing scale', scale: undefined },
      { label: 'a negative scale', scale: -1 },
      { label: 'a fractional scale', scale: 1.5 },
      { label: 'a scale above 16383', scale: 16_384 },
    ])('rejects $label', ({ scale }) => {
      expectEncodingError(() => encodeValue('d', '1', { scale }), 'd requires an integer scale between 0 and 16383');
    });

    it('rejects a missing scale even for NULL', () => {
      expectEncodingError(() => encodeValue('d', null), 'd requires an integer scale');
    });
  });

  describe('t', () => {
    it('encodes a local Date as ISO-8601 with milliseconds', () => {
      expect(encodeValue('t', noonWith(5))).toBe('t23:2026-06-30T12:00:00.007');
    });

    it.each([
      { value: '2026-06-30T12:00', expected: '2026-06-30T12:00:00.000' },
      { value: '2026-06-30 12:00:05', expected: '2026-06-30T12:00:05.000' },
      { value: '2026-06-30 12:00:00.5', expected: '2026-06-30T12:00:00.500' },
      { value: '2026-06-30 12:00:00.0049', expected: '2026-06-30T12:00:00.003' },
      { value: '2026-06-30T12:00:00.007', expected: '2026-06-30T12:00:00.007' },
    ])('formats the wall-clock text $value as $expected', ({ value, expected }) => {
      expect(formatCanonicalTimestamp(value)).toBe(expected);
    });

    it.each([
      { label: 'an invalid Date', value: new Date(Number.NaN), message: 't value is an invalid Date' },
      { label: 'a Date after year 9999', value: new Date(10_000, 0, 1, 12), message: 'not a valid date and time' },
      { label: 'a zoned string', value: '2026-06-30T12:00:00Z', message: 't expects YYYY-MM-DD[ T]HH:MM[:SS[.fraction]] without a zone' },
      { label: 'a date without a time', value: '2026-06-30', message: 't expects YYYY-MM-DD' },
      { label: 'month 13', value: '2026-13-01 00:00', message: 'not a valid date and time' },
      { label: 'June 31', value: '2026-06-31 00:00', message: 'not a valid date and time' },
      { label: 'February 29 of a common year', value: '2023-02-29 00:00', message: 'not a valid date and time' },
      { label: 'February 29 of 1900', value: '1900-02-29 00:00', message: 'not a valid date and time' },
      { label: 'year 0', value: '0000-01-01 00:00', message: 'not a valid date and time' },
      { label: 'hour 24', value: '2026-06-30 24:00', message: 'not a valid date and time' },
      { label: 'minute 60', value: '2026-06-30 12:60', message: 'not a valid date and time' },
      { label: 'second 60', value: '2026-06-30 12:00:60', message: 'not a valid date and time' },
      { label: 'text rounding past 9999', value: '9999-12-31 23:59:59.999', message: 't value rounds past year 9999' },
      { label: 'a Date rounding past 9999', value: new Date(9999, 11, 31, 23, 59, 59, 999), message: 't value rounds past year 9999' },
      { label: 'an epoch number', value: 1_700_000_000_000, message: 't expects a Date or wall-clock string, got number' },
    ])('rejects $label', ({ value, message }) => {
      expectEncodingError(() => encodeValue('t', value), message);
    });
  });

  describe('b', () => {
    it.each([
      { label: 'a Buffer', value: Buffer.from([0xab, 0x01]), expected: 'b4:ab01' },
      { label: 'an empty Buffer', value: Buffer.alloc(0), expected: 'b0:' },
      { label: 'a Uint8Array view with an offset', value: new Uint8Array([0x00, 0xab, 0x01, 0x00]).subarray(1, 3), expected: 'b4:ab01' },
      { label: 'upper-case bytea text', value: '\\xAB01', expected: 'b4:ab01' },
      { label: 'empty bytea text', value: '\\x', expected: 'b0:' },
    ])('encodes $label as lowercase hex', ({ value, expected }) => {
      expect(encodeValue('b', value)).toBe(expected);
    });

    it.each([
      { label: 'unprefixed hex', value: 'ab01', message: 'b expects a Buffer, Uint8Array or \\x-prefixed hex string, got string' },
      { label: 'an odd number of hex digits', value: '\\xabc', message: 'got string' },
      { label: 'a number', value: 42, message: 'got number' },
      { label: 'an array of bytes', value: [0xab], message: 'got array' },
    ])('rejects $label', ({ value, message }) => {
      expectEncodingError(() => encodeValue('b', value), message);
    });
  });

  it('rejects an unknown tag', () => {
    expectEncodingError(() => encodeValue(UNKNOWN_TAG as CanonicalType, 'a'), "unknown canonical type 'x'");
  });
});

describe('SQL Server datetime rounding', () => {
  it.each([
    { value: '1998-01-01 23:59:59.999', expected: '1998-01-02T00:00:00.000' },
    { value: '1998-01-01 23:59:59.998', expected: '1998-01-01T23:59:59.997' },
    { value: '1998-01-01 23:59:59.997', expected: '1998-01-01T23:59:59.997' },
    { value: '1998-01-01 23:59:59.996', expected: '1998-01-01T23:59:59.997' },
    { value: '1998-01-01 23:59:59.995', expected: '1998-01-01T23:59:59.997' },
    { value: '1998-01-01 23:59:59.994', expected: '1998-01-01T23:59:59.993' },
    { value: '1998-01-01 23:59:59.993', expected: '1998-01-01T23:59:59.993' },
    { value: '1998-01-01 23:59:59.992', expected: '1998-01-01T23:59:59.993' },
    { value: '1998-01-01 23:59:59.991', expected: '1998-01-01T23:59:59.990' },
    { value: '1998-01-01 23:59:59.990', expected: '1998-01-01T23:59:59.990' },
  ])('stores $value as $expected', ({ value, expected }) => {
    expect(formatCanonicalTimestamp(value)).toBe(expected);
  });

  it.each([
    { ms: 1, expected: '2026-06-30T12:00:00.000' },
    { ms: 2, expected: '2026-06-30T12:00:00.003' },
    { ms: 5, expected: '2026-06-30T12:00:00.007' },
    { ms: 999, expected: '2026-06-30T12:00:01.000' },
  ])('rounds a local Date at .$ms to $expected', ({ ms, expected }) => {
    expect(formatCanonicalTimestamp(noonWith(ms))).toBe(expected);
  });

  it.each([
    { fractionSeconds: 0.001, second: 0, ms: 0 },
    { fractionSeconds: 0.002, second: 0, ms: 3 },
    { fractionSeconds: 0.005, second: 0, ms: 7 },
    { fractionSeconds: 0.999, second: 1, ms: 0 },
  ])('rounds fractionSeconds $fractionSeconds to second $second and ms $ms', ({ fractionSeconds, second, ms }) => {
    expect(roundToSqlServerDatetime({ year: 2026, month: 6, day: 30, hour: 12, minute: 0, second: 0, fractionSeconds }))
      .toStrictEqual({ year: 2026, month: 6, day: 30, hour: 12, minute: 0, second, ms });
  });

  it('rounds every millisecond alike from a Date, wall-clock text and fractional seconds', () => {
    const lastDigitMs = [0, 0, 3, 3, 3, 7, 7, 7, 7, 10];
    for (let ms = 0; ms < 1000; ms++) {
      const roundedMs = ms - (ms % 10) + (lastDigitMs[ms % 10] ?? Number.NaN);
      const second = roundedMs === 1000 ? 1 : 0;
      const milli = roundedMs % 1000;
      const expected = `2026-06-30T12:00:0${String(second)}.${String(milli).padStart(3, '0')}`;
      expect(formatCanonicalTimestamp(noonWith(ms))).toBe(expected);
      expect(formatCanonicalTimestamp(`2026-06-30 12:00:00.${String(ms).padStart(3, '0')}`)).toBe(expected);
      expect(roundToSqlServerDatetime({ year: 2026, month: 6, day: 30, hour: 12, minute: 0, second: 0, fractionSeconds: ms / 1000 }))
        .toStrictEqual({ year: 2026, month: 6, day: 30, hour: 12, minute: 0, second, ms: milli });
    }
  });

  it.each([
    { value: '2026-06-30 12:00:59.999', expected: '2026-06-30T12:01:00.000' },
    { value: '2026-06-30 12:59:59.999', expected: '2026-06-30T13:00:00.000' },
    { value: '2026-06-30 23:59:59.999', expected: '2026-07-01T00:00:00.000' },
    { value: '2024-02-28 23:59:59.999', expected: '2024-02-29T00:00:00.000' },
    { value: '2023-02-28 23:59:59.999', expected: '2023-03-01T00:00:00.000' },
    { value: '2000-02-29 23:59:59.999', expected: '2000-03-01T00:00:00.000' },
    { value: '2026-12-31 23:59:59.999', expected: '2027-01-01T00:00:00.000' },
  ])('carries $value into $expected', ({ value, expected }) => {
    expect(formatCanonicalTimestamp(value)).toBe(expected);
  });

  it('carries a local Date on the last second of a year into the next year', () => {
    expect(formatCanonicalTimestamp(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe('2027-01-01T00:00:00.000');
  });

  it.each([
    { label: 'fractionSeconds of 1', parts: { second: 0, month: 6, fractionSeconds: 1 }, message: 'fractionSeconds must be in [0, 1)' },
    { label: 'negative fractionSeconds', parts: { second: 0, month: 6, fractionSeconds: -0.001 }, message: 'fractionSeconds must be in [0, 1)' },
    { label: 'NaN fractionSeconds', parts: { second: 0, month: 6, fractionSeconds: Number.NaN }, message: 'fractionSeconds must be in [0, 1)' },
    { label: 'month 13', parts: { second: 0, month: 13, fractionSeconds: 0 }, message: 't value is not a valid date and time' },
    { label: 'a fractional second', parts: { second: 1.5, month: 6, fractionSeconds: 0 }, message: 't value is not a valid date and time' },
  ])('rejects $label', ({ parts, message }) => {
    expectEncodingError(() => roundToSqlServerDatetime({ year: 2026, day: 30, hour: 12, minute: 0, ...parts }), message);
  });

  it('rejects fractional seconds rounding past year 9999', () => {
    expectEncodingError(
      () => roundToSqlServerDatetime({ year: 9999, month: 12, day: 31, hour: 23, minute: 59, second: 59, fractionSeconds: 0.9995 }),
      't value rounds past year 9999',
    );
  });
});

const MIXED: CanonicalColumn[] = [
  { name: 'contentid', type: 's' },
  { name: 'title', type: 's' },
  { name: 'body', type: 's' },
  { name: 'sortorder', type: 'i' },
  { name: 'isnav', type: 'i' },
  { name: 'ratio', type: 'f' },
  { name: 'price', type: 'd', scale: 4 },
  { name: 'created', type: 't' },
  { name: 'image', type: 'b' },
  { name: 'removed', type: 't' },
];

const MIXED_ROW = {
  contentid: 'ABC  ',
  title: null,
  body: 'a:b\u0000\n\tc',
  sortorder: -3,
  isnav: true,
  ratio: 0.1,
  price: '1.5',
  created: noonWith(5),
  image: Buffer.from([0xab, 0x01]),
  removed: undefined,
};

const MIXED_ENCODING = 's5:ABC  Ns7:a:b\u0000\n\tci2:-3i1:1f3:0.1d6:1.5000t23:2026-06-30T12:00:00.007b4:ab01N';

describe('encodeRow', () => {
  it('concatenates column encodings in catalog order', () => {
    expect(encodeRow(MIXED, MIXED_ROW)).toBe(MIXED_ENCODING);
  });

  it('follows the column order, not the object key order', () => {
    const columns: CanonicalColumn[] = [{ name: 'b', type: 's' }, { name: 'a', type: 'i' }];
    expect(encodeRow(columns, { a: 1, b: 'x' })).toBe('s1:xi1:1');
  });

  it('keeps delimiters inside values from aliasing two rows', () => {
    const columns: CanonicalColumn[] = [{ name: 'x', type: 's' }, { name: 'y', type: 's' }];
    const left = encodeRow(columns, { x: 'a:', y: 'b' });
    const right = encodeRow(columns, { x: 'a', y: ':b' });
    expect(left).toBe('s2:a:s1:b');
    expect(right).toBe('s1:as2::b');
    expect(left).not.toBe(right);
  });

  it('distinguishes NULL from the empty string in either column', () => {
    const columns: CanonicalColumn[] = [{ name: 'x', type: 's' }, { name: 'y', type: 's' }];
    expect(encodeRow(columns, { x: null, y: '' })).toBe('Ns0:');
    expect(encodeRow(columns, { x: '', y: null })).toBe('s0:N');
  });

  it('rejects a row without a value for a column', () => {
    const columns: CanonicalColumn[] = [{ name: 'a', type: 'i' }, { name: 'b', type: 's' }];
    expectEncodingError(() => encodeRow(columns, { a: 1 }), 'row has no value for column (column b)');
    expect(() => encodeRow(columns, { a: 1 })).toThrow(expect.objectContaining({ column: 'b', type: 's' }));
  });

  it('names the column and type of a value that does not fit', () => {
    expect(() => encodeRow([{ name: 'title', type: 's' }], { title: 1 })).toThrow(
      expect.objectContaining({ column: 'title', type: 's', message: 's expects a string, got number (column title)' }),
    );
  });
});

describe('decodeRow', () => {
  it('decodes NULLs, canonical value text and bytes, and re-encodes to the same row', () => {
    const decoded = decodeRow(MIXED, MIXED_ENCODING);
    expect(decoded).toStrictEqual({
      contentid: 'ABC  ',
      title: null,
      body: 'a:b\u0000\n\tc',
      sortorder: '-3',
      isnav: '1',
      ratio: '0.1',
      price: '1.5000',
      created: '2026-06-30T12:00:00.007',
      image: Buffer.from([0xab, 0x01]),
      removed: null,
    });
    expect(encodeRow(MIXED, decoded)).toBe(MIXED_ENCODING);
  });

  it.each([
    { label: 'an encoding that ends early', encoding: 's1:x', message: 'encoding ends before this column (column y)' },
    { label: 'bytes after the last column', encoding: 's1:xs1:yN', message: 'trailing bytes after the last column' },
    { label: 'an unpaired surrogate', encoding: 's1:xs1:\uD800', message: 'encoding contains an unpaired UTF-16 surrogate' },
  ])('rejects $label', ({ encoding, message }) => {
    const columns: CanonicalColumn[] = [{ name: 'x', type: 's' }, { name: 'y', type: 's' }];
    expectEncodingError(() => decodeRow(columns, encoding), message);
  });
});

describe('decodeValue', () => {
  const accepted: ReadonlyArray<[CanonicalType, string, CanonicalValue]> = [
    ['s', 'N', null],
    ['s', 's0:', ''],
    ['s', 's2:é', 'é'],
    ['s', 's3:\u0000\n\t', '\u0000\n\t'],
    ['i', 'i3:-12', '-12'],
    ['f', 'f5:1e+21', '1e+21'],
    ['d', 'd6:1.5000', '1.5000'],
    ['d', 'd2:15', '15'],
    ['d', 'N', null],
    ['t', 't23:2026-06-30T12:00:00.007', '2026-06-30T12:00:00.007'],
    ['b', 'b4:ab01', Buffer.from([0xab, 0x01])],
    ['b', 'b0:', Buffer.alloc(0)],
  ];

  it.each(accepted)('decodes %s %j', (type, encoding, expected) => {
    expect(decodeValue(type, encoding)).toStrictEqual(expected);
  });

  it('decodes d at its declared scale', () => {
    expect(decodeValue('d', 'd6:1.5000', { scale: 4 })).toBe('1.5000');
  });

  const rejected: ReadonlyArray<[CanonicalType, string, string]> = [
    ['s', '', 'encoding ends before this column'],
    ['i', 's1:a', "expected tag 'i' or 'N', found byte 115"],
    ['s', 's:', 'malformed length prefix'],
    ['s', 's01:a', 'malformed length prefix'],
    ['s', 's1a', 'malformed length prefix'],
    ['s', 's1', 'malformed length prefix'],
    ['s', 's1234567890123456:', 'malformed length prefix'],
    ['s', 's3:é', 'value is truncated'],
    ['s', 's1:é', 'length splits a UTF-8 character'],
    ['s', 'Nx', 'trailing bytes after the value'],
    ['s', 's1:ab', 'trailing bytes after the value'],
    ['s', 's1:\uDC00', 'encoding contains an unpaired UTF-16 surrogate'],
    ['b', 'b4:AB01', 'b value is not lowercase hex'],
    ['b', 'b3:abc', 'b value is not lowercase hex'],
    ['i', 'i2:07', 'value text is not in canonical form'],
    ['f', 'f3:1.0', 'value text is not in canonical form'],
    ['t', 't23:2026-06-30 12:00:00.007', 'value text is not in canonical form'],
    ['t', 't3:abc', 't expects YYYY-MM-DD'],
  ];

  it.each(rejected)('rejects %s %j', (type, encoding, message) => {
    expectEncodingError(() => decodeValue(type, encoding), message);
  });

  it('rejects d text at a scale other than the declared one', () => {
    expectEncodingError(() => decodeValue('d', 'd6:1.5000', { scale: 2 }), 'value text is not in canonical form');
  });

  it('rejects an unknown tag', () => {
    expectEncodingError(() => decodeValue(UNKNOWN_TAG as CanonicalType, 'N'), "unknown canonical type 'x'");
  });
});

describe('encodeKey', () => {
  const columns: CanonicalColumn[] = [
    { name: 'contentid', type: 's' },
    { name: 'title', type: 's' },
    { name: 'siteid', type: 's' },
  ];
  const row = { contentid: 'c1', title: 'Home', siteid: 'tenant-a' };

  it('encodes only the key columns, in key order', () => {
    expect(encodeKey(columns, ['siteid', 'contentid'], row)).toBe('s8:tenant-as2:c1');
  });

  it.each([
    { label: 'no key columns', keyNames: [], message: 'encodeKey needs at least one key column' },
    { label: 'an unknown key column', keyNames: ['missing'], message: 'key column is not among the row columns (column missing)' },
  ])('rejects $label', ({ keyNames, message }) => {
    expectEncodingError(() => encodeKey(columns, keyNames, row), message);
  });
});

describe('row checksums', () => {
  it.each([
    { label: 'the empty string', input: '', expected: EMPTY_SHA256 },
    { label: 'abc as text', input: 'abc', expected: ABC_SHA256 },
    { label: 'abc as bytes', input: Buffer.from('abc'), expected: ABC_SHA256 },
  ])('sha256Hex hashes $label', ({ input, expected }) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  const rows: ReadonlyArray<{ label: string; columns: CanonicalColumn[]; row: Record<string, unknown> }> = [
    { label: 'a mixed row', columns: MIXED, row: MIXED_ROW },
    { label: 'NULL and empty columns', columns: [{ name: 'a', type: 's' }, { name: 'b', type: 's' }], row: { a: null, b: '' } },
    { label: 'multi-byte text', columns: [{ name: 'a', type: 's' }], row: { a: 'é😀' } },
  ];

  it.each(rows)('rowChecksum and legacyRowHash are the SHA-256 of the encoding of $label', ({ columns, row }) => {
    const expected = sha256Hex(encodeRow(columns, row));
    expect(rowChecksum(columns, row)).toBe(expected);
    expect(legacyRowHash(columns, row)).toBe(expected);
  });

  it('rowChecksum rejects a row without a value for a column', () => {
    expectEncodingError(() => rowChecksum([{ name: 'a', type: 's' }], {}), 'row has no value for column (column a)');
  });
});

describe('tableChecksum', () => {
  it('hashes an empty table as zero rows over no bytes', () => {
    expect(tableChecksum([])).toStrictEqual({ count: 0, sha256: EMPTY_SHA256 });
  });

  it('orders keyed rows by key, not by row', () => {
    const entries: ChecksumEntry[] = [{ key: 's1:2', row: 's1:a' }, { key: 's1:1', row: 's1:z' }];
    expect(tableChecksum(entries)).toStrictEqual({ count: 2, sha256: sha256Hex('s1:zs1:a') });
  });

  it('orders keyed rows sharing a key by row', () => {
    const entries: ChecksumEntry[] = [{ key: 'k', row: 's1:b' }, { key: 'k', row: 's1:a' }];
    expect(tableChecksum(entries).sha256).toBe(sha256Hex('s1:as1:b'));
  });

  it('orders keyless rows by row and counts duplicates', () => {
    expect(tableChecksum([{ row: 's1:z' }, { row: 's1:a' }, { row: 's1:z' }])).toStrictEqual({
      count: 3,
      sha256: sha256Hex('s1:as1:zs1:z'),
    });
  });

  const tables: ReadonlyArray<{ label: string; entries: ChecksumEntry[] }> = [
    { label: 'keyed', entries: [{ key: 'i1:1', row: 'i1:1s1:a' }, { key: 'i1:2', row: 'i1:2s1:b' }, { key: 'i1:3', row: 'i1:3N' }] },
    { label: 'keyless', entries: [{ row: 's1:a' }, { row: 's1:b' }, { row: 's1:a' }] },
  ];

  it.each(tables)('is independent of $label entry order and sensitive to every value', ({ entries }) => {
    const sum = tableChecksum(entries);
    expect(tableChecksum([...entries].reverse())).toStrictEqual(sum);
    expect(tableChecksum(new Set(entries).values())).toStrictEqual(sum);
    const changed = entries.map((entry, i) => (i === 1 ? { ...entry, row: `${entry.row}x` } : entry));
    expect(tableChecksum(changed).sha256).not.toBe(sum.sha256);
  });

  it('rejects a mix of keyed and keyless entries', () => {
    expectEncodingError(() => tableChecksum([{ key: 'k', row: 'r' }, { row: 'r' }]), 'tableChecksum entries must all have a key or all lack one');
    expectEncodingError(() => tableChecksum([{ row: 'r' }, { key: 'k', row: 'r' }]), 'must all have a key or all lack one');
  });
});

describe('changedColumns', () => {
  const columns: CanonicalColumn[] = [
    { name: 'a', type: 's' },
    { name: 'b', type: 's' },
    { name: 'c', type: 'i' },
    { name: 'd', type: 'd', scale: 2 },
    { name: 'e', type: 't' },
  ];
  const before = { a: 'x', b: null, c: 1, d: 1.5, e: noonWith(5) };

  it('lists exactly the changed columns in column order', () => {
    expect(changedColumns(columns, before, { ...before, c: 2, a: 'y' })).toStrictEqual(['a', 'c']);
  });

  it('counts NULL to empty and empty to NULL as changes', () => {
    expect(changedColumns(columns, before, { ...before, b: '' })).toStrictEqual(['b']);
    expect(changedColumns(columns, { ...before, b: '' }, before)).toStrictEqual(['b']);
  });

  it('ignores inputs that encode alike', () => {
    const after = { a: 'x', b: undefined, c: true, d: '1.50', e: '2026-06-30 12:00:00.006' };
    expect(changedColumns(columns, before, after)).toStrictEqual([]);
  });

  it('rejects a side without a value for a column', () => {
    const { a, b, c, d } = before;
    expectEncodingError(() => changedColumns(columns, before, { a, b, c, d }), 'row has no value for column (column e)');
  });
});

describe('compareEncodings', () => {
  const long = 'x'.repeat(2000);

  it.each([
    { label: 'equal strings', a: 'abc', b: 'abc', expected: 0 },
    { label: 'a smaller code unit', a: 'a', b: 'b', expected: -1 },
    { label: 'a larger code unit', a: 'b', b: 'a', expected: 1 },
    { label: 'a proper prefix', a: 'ab', b: 'abc', expected: -1 },
    { label: 'a proper extension', a: 'abc', b: 'ab', expected: 1 },
    { label: 'U+FFFF against a supplementary character', a: '\uFFFF', b: '😀', expected: -1 },
    { label: 'a supplementary character against U+FFFF', a: '😀', b: '\uFFFF', expected: 1 },
    { label: 'two supplementary characters', a: '😀', b: '😁', expected: -1 },
    { label: 'long strings differing early', a: `a${long}`, b: `b${long}`, expected: -1 },
    { label: 'long strings differing after 1024 units', a: `${long}a`, b: `${long}b`, expected: -1 },
    { label: 'long strings differing by a supplementary character', a: `${long}😀`, b: `${long}\uFFFF`, expected: 1 },
    { label: 'a long proper prefix', a: long, b: `${long}y`, expected: -1 },
  ])('orders $label as UTF-8 bytes', ({ a, b, expected }) => {
    expect(compareEncodings(a, b)).toBe(expected);
    expect(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))).toBe(expected);
  });
});

describe('multisets', () => {
  const columns: CanonicalColumn[] = [{ name: 'listid', type: 's' }, { name: 'email', type: 's' }];
  const first = encodeRow(columns, { listid: 'L1', email: 'a@example.com' });
  const second = encodeRow(columns, { listid: 'L1', email: null });

  it('counts duplicate encodings under their SHA-256', () => {
    const counted = multiset([first, second, first]);
    expect(counted.size).toBe(2);
    expect(counted.get(sha256Hex(first))).toStrictEqual({ encoding: first, count: 2 });
    expect(counted.get(sha256Hex(second))).toStrictEqual({ encoding: second, count: 1 });
  });

  it('finds one added and one removed occurrence of duplicated rows', () => {
    const expected = {
      added: [{ hash: sha256Hex(second), encoding: second, count: 1 }],
      removed: [{ hash: sha256Hex(first), encoding: first, count: 1 }],
    };
    const before = [first, first, second];
    const after = [second, first, second];
    expect(diffMultiset(before, after)).toStrictEqual(expected);
    expect(diffMultiset(multiset(before), multiset(after))).toStrictEqual(expected);
    expect(diffMultiset(multiset(before), after)).toStrictEqual(expected);
  });

  it('finds no difference between reordered multisets', () => {
    expect(diffMultiset([first, second, first], [first, first, second])).toStrictEqual({ added: [], removed: [] });
  });

  it('orders deltas by encoding bytes', () => {
    expect(diffMultiset(['s1:c'], ['s1:b', 's1:a', 's1:a'])).toStrictEqual({
      added: [
        { hash: sha256Hex('s1:a'), encoding: 's1:a', count: 2 },
        { hash: sha256Hex('s1:b'), encoding: 's1:b', count: 1 },
      ],
      removed: [{ hash: sha256Hex('s1:c'), encoding: 's1:c', count: 1 }],
    });
  });

  it('numbers identical rows 1, 2, 3 in input order with their legacy row hash', () => {
    const firstHash = legacyRowHash(columns, { listid: 'L1', email: 'a@example.com' });
    const secondHash = legacyRowHash(columns, { listid: 'L1', email: null });
    const expected = [
      { encoding: first, hash: firstHash, occurrence: 1 },
      { encoding: second, hash: secondHash, occurrence: 1 },
      { encoding: first, hash: firstHash, occurrence: 2 },
      { encoding: first, hash: firstHash, occurrence: 3 },
    ];
    expect(assignOccurrences([first, second, first, first])).toStrictEqual(expected);
    expect(assignOccurrences([first, second, first, first])).toStrictEqual(expected);
  });
});

describe('canonicalTypeForSqlServer', () => {
  const mapped: ReadonlyArray<[string, CanonicalTypeInfo]> = [
    ['char(35)', { type: 's' }],
    ['nchar(10)', { type: 's' }],
    ['varchar', { type: 's' }],
    ['NVARCHAR(MAX)', { type: 's' }],
    ['[nvarchar]', { type: 's' }],
    ['text', { type: 's' }],
    ['ntext', { type: 's' }],
    ['xml', { type: 's' }],
    ['uniqueidentifier', { type: 's' }],
    ['int', { type: 'i' }],
    ['smallint', { type: 'i' }],
    ['tinyint', { type: 'i' }],
    ['bigint', { type: 'i' }],
    ['bit', { type: 'i' }],
    ['float', { type: 'f' }],
    ['real', { type: 'f' }],
    ['decimal(19,4)', { type: 'd', scale: 4 }],
    ['numeric(10, 2)', { type: 'd', scale: 2 }],
    ['decimal(10)', { type: 'd', scale: 0 }],
    ['money', { type: 'd', scale: 4 }],
    ['smallmoney', { type: 'd', scale: 4 }],
    ['datetime', { type: 't' }],
    ['smalldatetime', { type: 't' }],
    ['datetime2', { type: 't' }],
    ['date', { type: 't' }],
    ['image', { type: 'b' }],
    ['varbinary(max)', { type: 'b' }],
    ['binary(16)', { type: 'b' }],
  ];

  it.each(mapped)('maps %s to %j', (dataType, expected) => {
    expect(canonicalTypeForSqlServer(dataType)).toStrictEqual(expected);
  });

  it('takes the scale of an undeclared decimal from the options', () => {
    expect(canonicalTypeForSqlServer('decimal', { scale: 2 })).toStrictEqual({ type: 'd', scale: 2 });
    expect(canonicalTypeForSqlServer('decimal(19,4)', { scale: 4 })).toStrictEqual({ type: 'd', scale: 4 });
  });

  it.each([
    { dataType: 'geography', opts: {}, message: "unsupported SQL Server type 'geography'" },
    { dataType: 'timestamp', opts: {}, message: "unsupported SQL Server type 'timestamp'" },
    { dataType: 'varchar(max', opts: {}, message: "unsupported SQL Server type 'varchar(max'" },
    { dataType: 'decimal', opts: {}, message: "cannot determine a fixed scale for 'decimal'" },
    { dataType: 'decimal(19,x)', opts: {}, message: "cannot determine a fixed scale for 'decimal(19,x)'" },
    { dataType: 'decimal(19,4)', opts: { scale: 2 }, message: "cannot determine a fixed scale for 'decimal(19,4)'" },
    { dataType: 'decimal', opts: { scale: -1 }, message: "cannot determine a fixed scale for 'decimal'" },
    { dataType: 'decimal', opts: { scale: 16_384 }, message: "cannot determine a fixed scale for 'decimal'" },
  ])('rejects $dataType with $opts', ({ dataType, opts, message }) => {
    expectEncodingError(() => canonicalTypeForSqlServer(dataType, opts), message);
  });
});

describe('canonicalTypeForPostgres', () => {
  const mapped: ReadonlyArray<[string, CanonicalTypeInfo]> = [
    ['bpchar', { type: 's' }],
    ['character(35)', { type: 's' }],
    ['char(35)', { type: 's' }],
    ['varchar', { type: 's' }],
    ['character varying(255)', { type: 's' }],
    ['text', { type: 's' }],
    ['uuid', { type: 's' }],
    ['name', { type: 's' }],
    ['int2', { type: 'i' }],
    ['smallint', { type: 'i' }],
    ['int4', { type: 'i' }],
    ['integer', { type: 'i' }],
    ['int', { type: 'i' }],
    ['int8', { type: 'i' }],
    ['bigint', { type: 'i' }],
    ['bool', { type: 'i' }],
    ['boolean', { type: 'i' }],
    ['float4', { type: 'f' }],
    ['real', { type: 'f' }],
    ['float8', { type: 'f' }],
    ['double precision', { type: 'f' }],
    ['numeric(19,4)', { type: 'd', scale: 4 }],
    ['decimal(10,2)', { type: 'd', scale: 2 }],
    ['timestamp', { type: 't' }],
    ['timestamp without time zone', { type: 't' }],
    ['timestamp(3) without time zone', { type: 't' }],
    ['bytea', { type: 'b' }],
  ];

  it.each(mapped)('maps %s to %j', (udtName, expected) => {
    expect(canonicalTypeForPostgres(udtName)).toStrictEqual(expected);
  });

  it('takes the scale of a bare numeric udt_name from the options', () => {
    expect(canonicalTypeForPostgres('numeric', { scale: 4 })).toStrictEqual({ type: 'd', scale: 4 });
  });

  it.each([
    { udtName: 'timestamptz', message: "unsupported PostgreSQL type 'timestamptz'" },
    { udtName: 'timestamp with time zone', message: "unsupported PostgreSQL type 'timestamp with time zone'" },
    { udtName: 'jsonb', message: "unsupported PostgreSQL type 'jsonb'" },
    { udtName: 'numeric(19,(4))', message: "unsupported PostgreSQL type 'numeric(19,(4))'" },
    { udtName: 'numeric', message: "cannot determine a fixed scale for 'numeric'" },
  ])('rejects $udtName', ({ udtName, message }) => {
    expectEncodingError(() => canonicalTypeForPostgres(udtName), message);
  });

  it('maps the matching SQL Server and PostgreSQL types alike', () => {
    expect(canonicalTypeForPostgres('numeric(19,4)')).toStrictEqual(canonicalTypeForSqlServer('money'));
    expect(canonicalTypeForPostgres('timestamp(3) without time zone')).toStrictEqual(canonicalTypeForSqlServer('datetime'));
    expect(canonicalTypeForPostgres('bpchar')).toStrictEqual(canonicalTypeForSqlServer('char(35)'));
  });
});

describe('SERIALIZED_DOCUMENT_COLUMNS', () => {
  it('lists the four serialized-document columns and is frozen', () => {
    expect(SERIALIZED_DOCUMENT_COLUMNS).toStrictEqual([
      'ttrash.objectstring',
      'toauthtokens.data',
      'tformresponsepackets.Data',
      'tcontentobjects.params',
    ]);
    expect(Object.isFrozen(SERIALIZED_DOCUMENT_COLUMNS)).toBe(true);
  });

  it('encodes a serialized document byte-exact as s', () => {
    const wddx = "<wddxPacket version='1.0'><header/><data><string>a:b é</string></data></wddxPacket>\r\n  ";
    const encoding = encodeValue('s', wddx);
    expect(encoding).toBe(`s${String(Buffer.byteLength(wddx, 'utf8'))}:${wddx}`);
    expect(decodeValue('s', encoding)).toBe(wddx);
  });
});
