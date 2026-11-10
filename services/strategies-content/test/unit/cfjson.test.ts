// Fidelity suite for the mura.json encode (core/mura/json.cfc:215-295) and ACF serializeJSON ports.
import { legacyQuery } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import {
  acfSerializeJson,
  cfJsStringFormat,
  cfToString,
  muraJsonEncode,
  type CfQuery,
  type CfSimpleValue,
} from '../../src/legacy/cfjson.js';

// Local-time dates, so the expected texts hold in every process time zone.
const JUNE_30 = new Date(2026, 5, 30, 13, 4, 5);
const INVALID_DATE = new Date(Number.NaN);
const HOME_ID = '00000000000000000000000000000000001';
const CONTENT_ID = '6F1F7F0C-0A1B-4C2D-9E3F405162738495';

class Bean {}

describe('cfJsStringFormat', () => {
  it.each<[string, string]>([
    ['"', '\\"'],
    ["'", "\\'"],
    ['\\', '\\\\'],
    ['\n', '\\n'],
    ['\t', '\\t'],
    ['\r', '\\r'],
    ['\f', '\\f'],
    ['\b', '\\b'],
  ])('escapes %j as %j', (input, expected) => {
    expect(cfJsStringFormat(`a${input}b`)).toBe(`a${expected}b`);
  });

  it('leaves slash, non-ASCII, other control characters and DEL unchanged', () => {
    expect(cfJsStringFormat('a/é\u0001\u007f')).toBe('a/é\u0001\u007f');
  });

  it('escapes every occurrence in a mixed string', () => {
    expect(cfJsStringFormat('He said "it\'s" at C:\\temp\r\n')).toBe('He said \\"it\\\'s\\" at C:\\\\temp\\r\\n');
  });
});

describe('cfToString', () => {
  it.each<[CfSimpleValue, string]>([
    ['abc', 'abc'],
    ['007', '007'],
    [42, '42'],
    [-3, '-3'],
    [1.5, '1.5'],
    [-2.5, '-2.5'],
    [1 / 3, '0.333333333333'],
    [0.0001, '0.0001'],
    [0.00001, '1E-005'],
    [999999999999.5, '1000000000000'],
    [1e20, '1E+020'],
    [true, 'true'],
    [false, 'false'],
    [JUNE_30, "{ts '2026-06-30 13:04:05'}"],
  ])('renders %j as %j', (value, expected) => {
    expect(cfToString(value)).toBe(expected);
  });
});

describe('muraJsonEncode', () => {
  describe('arrays', () => {
    it.each<[string, unknown[], string]>([
      ['an empty array', [], '[]'],
      ['mixed simple elements', [1, 'a', true], '[1,"a","true"]'],
      ['nested arrays', [[1, 2], [], [['x']]], '[[1,2],[],[["x"]]]'],
      ['null and undefined elements, dropping them', [1, null, undefined, 2], '[1,2]'],
      ['an element that fails to encode, dropping it', [1, INVALID_DATE, 2], '[1,2]'],
    ])('encodes %s', (_name, value, expected) => {
      expect(muraJsonEncode(value)).toBe(expected);
    });
  });

  describe('structs', () => {
    it.each<[string, Record<string, unknown>, string]>([
      ['an empty struct as {}', {}, '{}'],
      ['a prototype-less empty struct as {}', Object.create(null) as Record<string, unknown>, '{}'],
      ['keys lower-cased', { ContentID: CONTENT_ID, SiteID: 'default' }, `{"contentid":"${CONTENT_ID}","siteid":"default"}`],
      [
        'nested structs and arrays of structs in insertion order',
        { Outer: { Inner: { Leaf: 1 } }, List: [{ A: 'x' }] },
        '{"outer":{"inner":{"leaf":1}},"list":[{"a":"x"}]}',
      ],
      ['keys without escaping', { 'a"b': 1 }, '{"a"b":1}'],
      ['a null member as ""', { Notes: null }, '{"notes":""}'],
      ['a failing member with the previous member\'s encoding', { First: 1, Bad: INVALID_DATE }, '{"first":1,"bad":1}'],
      ['a failing first member with no value', { Bad: INVALID_DATE, Next: 'x' }, '{"bad":,"next":"x"}'],
    ])('encodes %s', (_name, value, expected) => {
      expect(muraJsonEncode(value)).toBe(expected);
    });
  });

  describe('simple values', () => {
    it.each<CfSimpleValue>(['42', '007', '1.50', '-3', ' 12', '1e3', '.5', HOME_ID])(
      'emits numeric string %j unquoted as given',
      (value) => {
        expect(muraJsonEncode(value)).toBe(value);
      },
    );

    it.each<[number, string]>([
      [42, '42'],
      [-3, '-3'],
      [1 / 3, '0.333333333333'],
      [1e20, '1E+020'],
    ])('emits number %j unquoted as CFML prints it', (value, expected) => {
      expect(muraJsonEncode(value)).toBe(expected);
    });

    it.each<[CfSimpleValue | null | undefined, string]>([
      ['abc', '"abc"'],
      ['', '""'],
      ['12abc', '"12abc"'],
      ['1e309', '"1e309"'],
      [CONTENT_ID, `"${CONTENT_ID}"`],
      ['it\'s "x"\n', '"it\\\'s \\"x\\"\\n"'],
      [true, '"true"'],
      [false, '"false"'],
      [JUNE_30, '"{ts \\\'2026-06-30 13:04:05\\\'}"'],
      [null, '""'],
      [undefined, '""'],
    ])('quotes non-numeric %j as %s', (value, expected) => {
      expect(muraJsonEncode(value)).toBe(expected);
    });
  });

  it.each<[string, unknown]>([
    ['a class instance', new Bean()],
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
  ])('encodes %s as unknown-obj', (_name, value) => {
    expect(muraJsonEncode(value)).toBe('unknown-obj');
  });

  it.each<[string, unknown]>([
    ['a function', () => 1],
    ['a bigint', 10n],
    ['a symbol', Symbol('s')],
  ])('encodes %s as unknown', (_name, value) => {
    expect(muraJsonEncode(value)).toBe('unknown');
  });

  describe('queries', () => {
    it('encodes recordcount, columnlist and data with ACF upper-cased, sorted column names', () => {
      // ACF query.columnList is upper-cased and sorted, so columns given as SITEID,SITE encode as SITE,SITEID.
      const sites: CfQuery = legacyQuery(
        ['SITEID', 'SITE'],
        [
          { siteid: 'default', site: 'Default' },
          { SITEID: 'tenant-a', Site: 'Tenant A' },
        ],
      );
      expect(muraJsonEncode(sites)).toBe(
        '{"recordcount":2,"columnlist":"SITE,SITEID","data":{"SITE":["Default","Tenant A"],"SITEID":["default","tenant-a"]}}',
      );
    });

    it('sorts columns by code unit', () => {
      expect(muraJsonEncode(legacyQuery(['_u', 'zeta', 'B_X', 'bz', 'b1', 'b', 'a'], []))).toBe(
        '{"recordcount":0,"columnlist":"A,B,B1,BZ,B_X,ZETA,_U","data":{"A":[],"B":[],"B1":[],"BZ":[],"B_X":[],"ZETA":[],"_U":[]}}',
      );
    });

    it('encodes datetime cells as timestamp text, numeric cells raw and null or missing cells as ""', () => {
      const stats = legacyQuery(
        ['created', 'views'],
        [
          { CREATED: JUNE_30, Views: 3 },
          { created: new Date(2026, 5, 30, 13, 4, 5, 120), views: '007' },
          { created: new Date(2026, 5, 30, 13, 4, 5, 5), views: null },
          {},
        ],
      );
      expect(muraJsonEncode(stats)).toBe(
        '{"recordcount":4,"columnlist":"CREATED,VIEWS","data":{' +
          '"CREATED":["2026-06-30 13:04:05.0","2026-06-30 13:04:05.12","2026-06-30 13:04:05.005",""],' +
          '"VIEWS":[3,007,"",""]}}',
      );
    });

    it('encodes a query without columns', () => {
      expect(muraJsonEncode(legacyQuery([], []))).toBe('{"recordcount":0,"columnlist":"","data":{}}');
    });

    it('encodes a query nested in a struct', () => {
      expect(muraJsonEncode({ Rs: legacyQuery(['id'], [{ id: 'x' }]) })).toBe(
        '{"rs":{"recordcount":1,"columnlist":"ID","data":{"ID":["x"]}}}',
      );
    });
  });

  it.each<[string, unknown, string]>([
    [
      'cnav.searchsitedata',
      [
        { id: 'default', value: 'Default' },
        { id: 'tenant-a', value: 'Tenant A' },
      ],
      '[{"id":"default","value":"Default"},{"id":"tenant-a","value":"Tenant A"}]',
    ],
    [
      'carch.loadsitemanager',
      { html: '<ul id="mura-nodes">\n\t<li class=\'x\'>A/B</li>\n</ul>', perm: 'editor', sortBy: 'orderno' },
      '{"html":"<ul id=\\"mura-nodes\\">\\n\\t<li class=\\\'x\\\'>A/B</li>\\n</ul>","perm":"editor","sortby":"orderno"}',
    ],
    [
      'commentsProxy.getContentStats',
      { contentID: HOME_ID, siteID: 'default', views: 12, rating: '3.5', comments: 0 },
      `{"contentid":${HOME_ID},"siteid":"default","views":12,"rating":3.5,"comments":0}`,
    ],
  ])('reproduces the %s body', (_name, value, expected) => {
    expect(muraJsonEncode(value)).toBe(expected);
  });
});

describe('acfSerializeJson', () => {
  it('upper-cases struct keys as ACF does for dot-notation keys (carch.update errors)', () => {
    expect(acfSerializeJson({ titleconflict: 'Title not unique', filemissing: 'File missing' })).toBe(
      '{"TITLECONFLICT":"Title not unique","FILEMISSING":"File missing"}',
    );
  });

  it.each<[boolean, string]>([
    [false, '{"CONTENT1":{"TITLE":"Required"}}'],
    [true, '{"content1":{"title":"Required"}}'],
  ])('with preserveKeyCase %j serializes nested errors as %s', (preserveKeyCase, expected) => {
    expect(acfSerializeJson({ content1: { title: 'Required' } }, { preserveKeyCase })).toBe(expected);
  });

  it('serializes an empty struct as {}', () => {
    expect(acfSerializeJson({})).toBe('{}');
  });

  it.each<[string, string]>([
    ['007', '"007"'],
    ['1.50', '"1.50"'],
    ['', '""'],
    ['a"b\'c\\d/é', '"a\\"b\'c\\\\d/é"'],
    ['\n\r\t\f\b', '"\\n\\r\\t\\f\\b"'],
    ['\u0001\u001f\u007f', '"\\u0001\\u001f\\u007f"'],
  ])('quotes string %j as %s', (value, expected) => {
    expect(acfSerializeJson(value)).toBe(expected);
  });

  it.each<[number, string]>([
    [5, '5'],
    [-3, '-3'],
    [0, '0'],
    [2e7, '20000000'],
    [-0.5, '-0.5'],
    [0.001, '0.001'],
    [1 / 3, '0.3333333333333333'],
    [12345678.9, '1.23456789E7'],
    [1e20, '1.0E20'],
    [1e-4, '1.0E-4'],
    [1.5e-7, '1.5E-7'],
    [Number.NaN, 'null'],
    [Number.POSITIVE_INFINITY, 'null'],
  ])('emits number %j as %s', (value, expected) => {
    expect(acfSerializeJson(value)).toBe(expected);
  });

  it.each<[unknown, string]>([
    [true, 'true'],
    [false, 'false'],
    [null, 'null'],
    [undefined, 'null'],
    [JUNE_30, '"June, 30 2026 13:04:05"'],
  ])('serializes %j as %s', (value, expected) => {
    expect(acfSerializeJson(value)).toBe(expected);
  });

  it('serializes arrays, nested arrays and holes as null', () => {
    const sparse: number[] = [1];
    sparse[2] = 3;
    expect(acfSerializeJson([[], [1, 'a', [true, null]], sparse])).toBe('[[],[1,"a",[true,null]],[1,null,3]]');
  });

  it('serializes a query as COLUMNS and DATA rows in query column order', () => {
    const sites = legacyQuery(
      ['siteid', 'Site', 'created'],
      [
        { SITEID: 'default', site: 'Default', created: JUNE_30 },
        { siteid: 'tenant-a', site: null, created: null },
      ],
    );
    expect(acfSerializeJson(sites)).toBe(
      '{"COLUMNS":["SITEID","SITE","CREATED"],"DATA":[["default","Default","June, 30 2026 13:04:05"],["tenant-a",null,null]]}',
    );
  });

  it.each<[string, unknown]>([
    ['class instance', new Bean()],
    ['class instance', new Map()],
    ['function', () => 1],
    ['bigint', 10n],
  ])('throws for a %s, which has no CFML form', (kind, value) => {
    expect(() => acfSerializeJson(value)).toThrow(new TypeError(`serializeJSON has no CFML form for a ${kind}`));
  });
});
