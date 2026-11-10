// Expected strings are what core/mura/jsonSerializer.cfc emits on Adobe ColdFusion 2023 for the same inputs.
import { describe, expect, it } from 'vitest';
import { formatSerializerUtcDate } from '../../src/legacy-compat/dates.js';
import {
  API_SERIALIZER_HINTS,
  LegacyJsonSerializer,
  cfEq,
  cfIsBoolean,
  cfIsDate,
  cfIsNumeric,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  createApiSerializer,
  entityPropertyHint,
  legacyQuery,
} from '../../src/legacy-compat/serializer.js';

const LOCAL = new Date(2026, 0, 2, 3, 4, 5);

/** Serializer with the same registrations as the ACF reference run, duplicates included. */
function referenceSerializer(): LegacyJsonSerializer {
  return new LegacyJsonSerializer()
    .asString('csrf_token_expires')
    .asString('id')
    .asInteger('code')
    .asBoolean('saveErrors')
    .asDate('start')
    .asInteger('isnew')
    .asString('title')
    .asUtcDate('udt')
    .asFloat('amt')
    .asInteger('code')
    .asString('code');
}

describe('createApiSerializer', () => {
  it.each<[unknown, string]>([
    [{ Code: '5' }, '{"code":5}'],
    [{ id: 12 }, '{"id":"12"}'],
    [{ saveErrors: 'yes' }, '{"saveerrors":true}'],
    [{ isnew: true }, '{"isnew":1}'],
    [{ start: LOCAL }, '{"start":"2026-01-02T03:04:05"}'],
    [{ id: { inner: 5, b: true, s: 'x' } }, '{"id":{"inner":"5","b":true,"s":"x"}}'],
    [{ a: null }, '{"a":null}'],
    [{ x: '12\u0001' }, '{"x":"12"}'],
    [{ x: 'a\nb' }, '{"x":"a\\nb"}'],
    [{ title: 2026 }, '{"title":"2026"}'],
    [{ end: new Date(2026, 0, 2) }, '{"end":"2026-01-02T00:00:00"}'],
    [
      { endindex: '3', expires_in: '60', scaffold: 'no', dynamic: 1, url: 5, csrf_token: 123, csrf_token_expires: 2611101010101 },
      '{"endindex":3,"expires_in":60,"scaffold":false,"dynamic":true,"url":"5","csrf_token":"123","csrf_token_expires":"2611101010101"}',
    ],
  ])('serializes %j as %s', (input, expected) => {
    expect(createApiSerializer().serialize(input)).toBe(expected);
  });

  it('lists the legacy registrations in call order, the duplicate endindex included', () => {
    expect(API_SERIALIZER_HINTS).toHaveLength(21);
    expect(API_SERIALIZER_HINTS.filter((h) => h.key === 'endindex')).toHaveLength(2);
    expect(API_SERIALIZER_HINTS[14]).toEqual({ key: 'title', hint: 'string' });
    expect(Object.isFrozen(API_SERIALIZER_HINTS)).toBe(true);
  });

  it('applies extra hints after the API hints, so an API key keeps its first hint', () => {
    const serializer = createApiSerializer([
      { key: 'lastupdate', hint: 'date' },
      { key: 'id', hint: 'integer' },
      { key: 'rating', hint: 'float' },
      { key: 'flag', hint: 'boolean' },
      { key: 'name', hint: 'string' },
    ]);
    expect(serializer.serialize({ lastupdate: new Date(2026, 10, 10, 9, 6, 40), id: '7', rating: '4.5', flag: 'yes', name: 12 })).toBe(
      '{"lastupdate":"2026-11-10T09:06:40","id":"7","rating":4.5,"flag":true,"name":"12"}',
    );
  });
});

describe('LegacyJsonSerializer', () => {
  it.each<[unknown, string]>([
    [{ x: '12\u0001', y: '\u000112', z: 'a\u0001' }, '{"x":"12","y":"\u000112","z":"a\\u0001"}'],
    [{ x: '12\u0001', y: '12\u0001' }, '{"x":"12","y":"12\u0001"}'],
    [{ x: '\t5\u001f' }, '{"x":"5\u001f"}'],
    [{ x: 'a\u0080b' }, '{"x":"a\u0080b"}'],
    [{ d: LOCAL }, '{"d":"January, 02 2026 03:04:05"}'],
    [{ code: LOCAL }, '{"code":"January, 02 2026 03:04:05"}'],
    [{ b: true, c: false, s: 'false' }, '{"b":true,"c":false,"s":"false"}'],
    [{ code: 'abc', amt: ' 5 ', isnew: 'yes' }, '{"code":"abc","amt": 5 ,"isnew":1}'],
    [{ saveErrors: 2, start: '', code: '' }, '{"saveerrors":true,"start":"","code":""}'],
    [{ udt: new Date(2026, 0, 2) }, '{"udt":"2026-01-02"}'],
    [[1, 'a', true, { CODE: '7' }], '["1","a",true,{"code":7}]'],
    [[1, null, 2], '["1","2"]'],
    [[null, 1], '["1"]'],
    [{ id: { x: null }, code: 5 }, '{"id":{"x":null},"code":5}'],
    [{ x: 1 / 3, y: 10 / 2, z: 2 ** 53 }, '{"x":"0.333333333333","y":"5","z":"9.00719925474E+015"}'],
    [{ code: 1 / 3, amt: 10 / 2 }, '{"code":0.333333333333,"amt":5}'],
    [{ 'A/B': 1, 'Q"': 2 }, '{"a/b":"1","q\\"":"2"}'],
    [{ s: 'tab\there "q" \\ / \u001a\u007f\b\f\r é\u2028' }, '{"s":"tab\\there \\"q\\" \\\\ / \\u001a\\u007f\\b\\f\\r é\u2028"}'],
    [{}, '{}'],
    [[], '[]'],
    ['12', '"12"'],
    [true, 'true'],
    [new Date(987, 9, 29, 13, 4, 5), '"October, 29 0987 13:04:05"'],
  ])('serializes %j as %s', (input, expected) => {
    expect(referenceSerializer().serialize(input)).toBe(expected);
  });

  it('formats utcdate values with a time through formatSerializerUtcDate', () => {
    expect(referenceSerializer().serialize({ udt: LOCAL })).toBe(`{"udt":"${formatSerializerUtcDate(LOCAL)}"}`);
  });

  it('serializes a query as row structs with column hints, reading NULL cells as empty strings', () => {
    const serializer = new LegacyJsonSerializer().asString('id').asInteger('code').asFloat('f2').asDate('dt');
    const q = legacyQuery(['A', 'B', 'CODE', 'DT', 'DT2', 'F1', 'F2', 'F3', 'F4', 'F5', 'ID', 'MISSING'], [
      { a: 1, b: null, code: null, dt: LOCAL, dt2: null, f1: 1, f2: 4.5, f3: 0.1 + 0.2, f4: 1e20, f5: 1 / 3, Id: 4 },
      { a: 2, B: 'y', CODE: '3' },
    ]);
    expect(serializer.serialize(q)).toBe(
      '[{"a":"1","b":"","code":"","dt":"2026-01-02T03:04:05","dt2":"","f1":"1","f2":4.5,"f3":"0.3","f4":"1E+020","f5":"0.333333333333","id":"4","missing":""},' +
        '{"a":"2","b":"y","code":3,"dt":"","dt2":"","f1":"","f2":"","f3":"","f4":"","f5":"","id":"","missing":""}]',
    );
  });

  it('excludes keys case-insensitively in structs and queries', () => {
    const serializer = new LegacyJsonSerializer().exclude('Secret');
    expect(serializer.serialize({ secret: 1, SECRET2: 2 })).toBe('{"secret2":"2"}');
    expect(serializer.serialize(legacyQuery(['SECRET', 'A'], [{ secret: 1, a: 2 }, { a: 3 }]))).toBe('[{"a":"2"},{"a":"3"}]');
  });

  it('keeps the first definition of a key and lets asAny keys inherit the parent hint', () => {
    const serializer = new LegacyJsonSerializer().asAny('k').asInteger('K').asInteger('n').asString('N');
    expect(serializer.serialize({ outer: { k: '5', n: '6' } })).toBe('{"outer":{"k":"5","n":6}}');
  });

  it('falls back to native serialization for values a hint cannot convert', () => {
    const serializer = new LegacyJsonSerializer().asDate('d').asUtcDate('u').asBoolean('b');
    expect(serializer.serialize({ d: 'x', u: 5, b: 'maybe' })).toBe('{"d":"x","u":5,"b":"maybe"}');
    expect(serializer.serialize({ f: () => 1, u: undefined, n: NaN })).toBe('{"f":null,"u":null,"n":null}');
  });

  it.each<[unknown, ErrorConstructor]>([
    [{ b: 1n }, TypeError],
    [new Date(NaN), RangeError],
  ])('rejects %s', (input, error) => {
    expect(() => new LegacyJsonSerializer().serialize(input)).toThrow(error);
  });
});

describe('CFML predicates', () => {
  it.each([
    ['12', true], [' 12', true], ['12 ', true], ['12\u0001', true], ['\u000112', true], ['\t12', true], ['+5', true],
    ['-5', true], ['.5', true], ['5.', true], ['1e5', true], ['1E+5', true], ['1e-5', true], ['00012', true],
    ['-.5', true], ['+.5e3', true], ['1e', false], ['0x1F', false], ['1d', false], ['1f', false], ['Infinity', false],
    ['NaN', false], ['--5', false], ['1 2', false], ['', false], [' ', false], ['1,000', false], ['$5', false],
    ['1.2.3', false], ['5\u00a0', false], ['\u00a05', false], ['5\u007f', false], ['1e308', true],
    ['1.7976931348623157e308', true], ['1e-400', true], ['1e10', true], ['1.8e308', false], ['1e309', false],
    ['-1e400', false],
  ])('cfIsNumeric(%j) is %s', (value, expected) => {
    expect(cfIsNumeric(value)).toBe(expected);
  });

  it.each<[unknown, boolean]>([[3, true], [NaN, false], [true, false], [LOCAL, false]])('cfIsNumeric(%s) is %s', (value, expected) => {
    expect(cfIsNumeric(value)).toBe(expected);
  });

  it.each<[string, string, boolean]>([
    ['1', '1', true], ['1.', '1', false], ['1.', '1.', true], ['1.', '1.0', false], ['1. ', '1', false], [' 1.', '1.', false],
    ['2.', '2', false], ['-1.', '-1', false], [' 1', '1', true], ['1 ', '1', true], ['1\u0001', '1', true], ['01', '1', true],
    ['1.0', '1', true], ['1e0', '1', true], ['1.e0', '1', true], ['+1', '1', true], ['.5', '0.5', true],
    ['1', '00000000000000000000000000000000001', true], ['1.', '00000000000000000000000000000000001', false],
    ['Update', 'update', true], ['abc', 'ABC', true], [' abc', 'abc', false],
  ])('cfEq(%j, %j) is %s', (a, b, expected) => {
    expect(cfEq(a, b)).toBe(expected);
  });

  it.each<[unknown, boolean]>([
    ['yes', true], ['YES', true], ['no', true], ['true', true], ['False', true], ['1', true], ['0', true], ['1.5', true],
    ['0.0', true], ['-1', true], [false, true], [2, true], [' yes', false], ['yes ', false], [' 1', false], ['on', false],
    ['off', false], ['y', false], ['', false], ['12\u0001', false], [Infinity, false], [LOCAL, false], ['1e308', true],
    ['1.7976931348623157e308', true], ['1e-400', true], ['1e10', true], ['1.8e308', false], ['1e309', false],
    ['-1e400', false],
  ])('cfIsBoolean(%j) is %s', (value, expected) => {
    expect(cfIsBoolean(value)).toBe(expected);
  });

  it.each<[unknown, boolean]>([
    ['YES', true], ['true', true], ['no', false], ['False', false], ['0.0', false], ['-1', true], [0, false], [7, true], [false, false],
  ])('cfToBoolean(%j) is %s', (value, expected) => {
    expect(cfToBoolean(value)).toBe(expected);
  });

  it('cfToBoolean rejects a value CFML cannot convert', () => {
    expect(() => cfToBoolean('maybe')).toThrow(TypeError);
  });

  it.each<[unknown, number]>([
    [' 1 ', 1], ['\t7\n', 7], ['12\u0001', 12], ['-.5', -0.5], ['1e1', 10], [3, 3], ['1e308', 1e308],
    ['1.7976931348623157e308', Number.MAX_VALUE], ['1e-400', 0], ['1e10', 1e10],
  ])('cfToNumber(%j) is %s', (value, expected) => {
    expect(cfToNumber(value)).toBe(expected);
  });

  it.each(['abc', '\u00a05', '1.8e308', '1e309', '-1e400'])('cfToNumber rejects %j, which CFML cannot convert', (value) => {
    expect(() => cfToNumber(value)).toThrow(TypeError);
  });

  it.each<[unknown, boolean]>([[LOCAL, true], [new Date(NaN), false], ['2026-01-02', false]])('cfIsDate(%j) is %s', (value, expected) => {
    expect(cfIsDate(value)).toBe(expected);
  });

  it.each([
    [1 / 1000000, '1E-006'], [1 / 100000, '1E-005'], [1 / 10000, '0.0001'], [1e12, '1000000000000'], [1e11, '100000000000'],
    [-1 / 3, '-0.333333333333'], [2.5 / 100000, '2.5E-005'], [185185183518, '185185183518'], [2 / 3, '0.666666666667'],
    [1e301, '1E+301'], [999999999999.5, '1000000000000'], [0.1 * 3, '0.3'], [(1 / 7) * 1000000, '142857.142857'],
    [3.6666666666666665, '3.66666666667'], [1e-7, '1E-007'], [1234567890123.5, '1.23456789012E+012'], [-0.5, '-0.5'],
    [2 ** 53, '9.00719925474E+015'],
  ])('cfNumberString(%d) is %s', (value, expected) => {
    expect(cfNumberString(value)).toBe(expected);
  });

  it.each<[string, string | undefined]>([
    ['int', 'integer'], ['TINYINT', 'integer'], ['integer', 'integer'], ['float', 'float'], ['Numeric', 'float'],
    ['double', 'float'], ['date', 'date'], ['DATETIME', 'date'], ['timestamp', 'date'], ['varchar', undefined],
  ])('entityPropertyHint(%s) is %s', (datatype, expected) => {
    expect(entityPropertyHint(datatype)).toBe(expected);
  });
});
