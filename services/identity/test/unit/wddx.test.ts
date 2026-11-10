import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cfml2wddx, WDDX_STRUCT_OPEN, WddxNumber, WddxRecordset } from '../../src/legacy/wddx.js';
import type { WddxStruct, WddxValue } from '../../src/legacy/wddx.js';

const PACKET_HEADER = "<wddxPacket version='1.0'><header/><data>";
const PACKET_FOOTER = '</data></wddxPacket>';

const GROUP_VALUES = {
  USERID: '6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9',
  GROUPNAME: 'Editors & <Authors>',
  TYPE: new WddxNumber('1'),
  SITEID: 'tenant-a',
  ISPUBLIC: new WddxNumber('0'),
  INACTIVE: new WddxNumber('0'),
  EMAIL: '',
  NOTES: 'Line one\r\nLine two\tend',
  S2: false,
  LASTUPDATE: new Date('2026-06-30T14:05:09.000Z'),
  ERRORS: {},
} satisfies WddxStruct;

const EXPECTED_PACKET =
  "<wddxPacket version='1.0'><header/><data><struct>" +
  "<var name='USERID'><string>6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9</string></var>" +
  "<var name='GROUPNAME'><string>Editors &amp; &lt;Authors&gt;</string></var>" +
  "<var name='TYPE'><number>1</number></var>" +
  "<var name='SITEID'><string>tenant-a</string></var>" +
  "<var name='ISPUBLIC'><number>0</number></var>" +
  "<var name='INACTIVE'><number>0</number></var>" +
  "<var name='EMAIL'><string></string></var>" +
  "<var name='NOTES'><string>Line one<char code='0d'/><char code='0a'/>Line two<char code='09'/>end</string></var>" +
  "<var name='S2'><boolean value='false'/></var>" +
  "<var name='LASTUPDATE'><dateTime>2026-06-30T14:05:09+00:00</dateTime></var>" +
  "<var name='ERRORS'><struct></struct></var>" +
  '</struct></data></wddxPacket>';

let previousZone: string | undefined;

/** Sets the process time zone back to `zone`, unsetting TZ when `zone` is undefined. */
function restoreZone(zone: string | undefined): void {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
}

/** Runs `run` with the process time zone set to `zone`, then restores the suite's zone. */
function withZone<T>(zone: string, run: () => T): T {
  const suiteZone = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    restoreZone(suiteZone);
  }
}

/** Expected packet holding `element` as the only var, V, of the top-level struct. */
function singleVarPacket(element: string): string {
  return `${PACKET_HEADER}<struct><var name='V'>${element}</var></struct>${PACKET_FOOTER}`;
}

/** Number of non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

beforeAll(() => {
  previousZone = process.env.TZ;
  process.env.TZ = 'UTC';
});

afterAll(() => {
  restoreZone(previousZone);
});

describe('cfml2wddx group bean packet', () => {
  it('serializes a group getAllValues() struct to the exact ACF packet', () => {
    expect(cfml2wddx(GROUP_VALUES)).toBe(EXPECTED_PACKET);
  });

  it('opens with the packet header followed by the top-level struct and closes the packet', () => {
    const packet = cfml2wddx(GROUP_VALUES);

    expect(packet.startsWith(PACKET_HEADER + WDDX_STRUCT_OPEN)).toBe(true);
    expect(packet.endsWith(`</struct>${PACKET_FOOTER}`)).toBe(true);
  });

  it('opens one struct element per CFML struct, top-level and nested', () => {
    expect(WDDX_STRUCT_OPEN).toBe('<struct>');
    expect(occurrences(cfml2wddx({ SITEID: 'tenant-a', TYPE: new WddxNumber('1') }), WDDX_STRUCT_OPEN)).toBe(1);
    expect(occurrences(cfml2wddx(GROUP_VALUES), WDDX_STRUCT_OPEN)).toBe(2);
  });

  it('writes the group keys in the order getAllValues() returned them', () => {
    const packet = cfml2wddx(GROUP_VALUES);
    const positions = Object.keys(GROUP_VALUES).map((key) => packet.indexOf(`<var name='${key}'>`));

    expect(positions.every((position) => position > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('cfml2wddx string escaping', () => {
  it.each([
    { name: 'plain text', value: 'plain text', expected: 'plain text' },
    { name: 'an ampersand', value: 'Editors & Authors', expected: 'Editors &amp; Authors' },
    { name: 'angle brackets', value: '<b>bold</b>', expected: '&lt;b&gt;bold&lt;/b&gt;' },
    { name: 'quotes, which element text keeps raw', value: `O'Brien "Jr"`, expected: `O'Brien "Jr"` },
    { name: 'NUL and unit separator', value: '\u0000\u001f', expected: "<char code='00'/><char code='1f'/>" },
    { name: 'a line feed', value: 'a\nb', expected: "a<char code='0a'/>b" },
    { name: 'DEL, which stays raw', value: 'x\u007fy', expected: 'x\u007fy' },
    { name: 'a Latin-1 letter', value: 'caf\u00e9', expected: 'caf&#xe9;' },
    { name: 'a BMP symbol', value: '\u20ac5', expected: '&#x20ac;5' },
    { name: 'a surrogate pair, one reference per unit', value: '\ud83d\ude00', expected: '&#xd83d;&#xde00;' },
  ])('escapes $name in string values', ({ value, expected }) => {
    expect(cfml2wddx({ V: value })).toBe(singleVarPacket(`<string>${expected}</string>`));
  });

  it.each([
    { name: 'an apostrophe', key: "O'K", expected: 'O&apos;K' },
    { name: 'double quotes', key: 'say "hi"', expected: 'say &quot;hi&quot;' },
    { name: 'markup characters', key: 'a&b<c>', expected: 'a&amp;b&lt;c&gt;' },
    { name: 'a tab', key: 'tab\there', expected: "tab<char code='09'/>here" },
    { name: 'a non-ASCII letter', key: 'n\u00e9', expected: 'n&#xe9;' },
  ])('escapes $name in var name attributes', ({ key, expected }) => {
    expect(cfml2wddx({ [key]: 'x' })).toBe(
      `${PACKET_HEADER}<struct><var name='${expected}'><string>x</string></var></struct>${PACKET_FOOTER}`,
    );
  });
});

describe('cfml2wddx numbers', () => {
  it.each(['1.50', '007', '1.0E-4', '-0.0', '12345678901234567890'])(
    'keeps the lexical form of WddxNumber %s',
    (text) => {
      expect(cfml2wddx({ V: new WddxNumber(text) })).toBe(singleVarPacket(`<number>${text}</number>`));
    },
  );

  it.each([
    { value: 1, expected: '1.0' },
    { value: -2, expected: '-2.0' },
    { value: 0.5, expected: '0.5' },
    { value: 0.001, expected: '0.001' },
    { value: 9_999_999, expected: '9999999.0' },
    { value: 1_234_567.5, expected: '1234567.5' },
    { value: 1e7, expected: '1.0E7' },
    { value: 12_345_678, expected: '1.2345678E7' },
    { value: 1e-4, expected: '1.0E-4' },
    { value: 1.5e-7, expected: '1.5E-7' },
    { value: -1e21, expected: '-1.0E21' },
    { value: 0, expected: '0.0' },
    { value: -0, expected: '-0.0' },
    { value: Number.NaN, expected: 'NaN' },
    { value: Number.POSITIVE_INFINITY, expected: 'Infinity' },
    { value: Number.NEGATIVE_INFINITY, expected: '-Infinity' },
  ])('writes a JS number as Java Double.toString $expected', ({ value, expected }) => {
    expect(cfml2wddx({ V: value })).toBe(singleVarPacket(`<number>${expected}</number>`));
  });
});

describe('cfml2wddx booleans, empty values and containers', () => {
  it.each<{ name: string; value: WddxValue; expected: string }>([
    { name: 'true', value: true, expected: "<boolean value='true'/>" },
    { name: 'false', value: false, expected: "<boolean value='false'/>" },
    { name: 'an empty string', value: '', expected: '<string></string>' },
    { name: 'null', value: null, expected: '<string></string>' },
    { name: 'undefined', value: undefined, expected: '<string></string>' },
    { name: 'an empty struct', value: {}, expected: '<struct></struct>' },
    { name: 'an empty Map', value: new Map<string, WddxValue>(), expected: '<struct></struct>' },
    { name: 'an empty array', value: [], expected: "<array length='0'></array>" },
  ])('writes $name', ({ value, expected }) => {
    expect(cfml2wddx({ V: value })).toBe(singleVarPacket(expected));
  });

  it('writes arrays with their length and nested elements in order', () => {
    const value: WddxValue = ['a', new WddxNumber('2'), [true], { K: null }];

    expect(cfml2wddx({ V: value })).toBe(
      singleVarPacket(
        "<array length='4'><string>a</string><number>2</number><array length='1'><boolean value='true'/></array>" +
          "<struct><var name='K'><string></string></var></struct></array>",
      ),
    );
  });

  it('writes a null-prototype object as a struct', () => {
    const value = Object.assign(Object.create(null) as Record<string, WddxValue>, { A: 'x' });

    expect(cfml2wddx(value)).toBe(`${PACKET_HEADER}<struct><var name='A'><string>x</string></var></struct>${PACKET_FOOTER}`);
  });
});

describe('cfml2wddx recordsets', () => {
  it.each([
    {
      name: 'rows column by column, null cells as empty strings',
      value: new WddxRecordset(['ADDRESSID', 'CITY'], [['A1', 'Paris & Co'], ['A2', null]]),
      expected:
        "<recordset rowCount='2' fieldNames='ADDRESSID,CITY' type='coldfusion.sql.QueryTable'>" +
        "<field name='ADDRESSID'><string>A1</string><string>A2</string></field>" +
        "<field name='CITY'><string>Paris &amp; Co</string><string></string></field></recordset>",
    },
    {
      name: 'an empty query with its columns',
      value: new WddxRecordset(['ADDRESSID', 'CITY']),
      expected:
        "<recordset rowCount='0' fieldNames='ADDRESSID,CITY' type='coldfusion.sql.QueryTable'>" +
        "<field name='ADDRESSID'></field><field name='CITY'></field></recordset>",
    },
    {
      name: 'a short row with the missing cell as an empty string',
      value: new WddxRecordset(['A', 'B'], [['x']]),
      expected:
        "<recordset rowCount='1' fieldNames='A,B' type='coldfusion.sql.QueryTable'>" +
        "<field name='A'><string>x</string></field><field name='B'><string></string></field></recordset>",
    },
    {
      name: 'fieldNames verbatim and each field name attribute-escaped',
      value: new WddxRecordset(["O'K"], [[new WddxNumber('3')]]),
      expected:
        "<recordset rowCount='1' fieldNames='O'K' type='coldfusion.sql.QueryTable'>" +
        "<field name='O&apos;K'><number>3</number></field></recordset>",
    },
  ])('writes $name', ({ value, expected }) => {
    expect(cfml2wddx({ V: value })).toBe(singleVarPacket(expected));
  });
});

describe('cfml2wddx dateTime', () => {
  it.each([
    { zone: 'UTC', iso: '2027-01-02T03:04:05.006Z', expected: '2027-01-02T03:04:05+00:00' },
    { zone: 'Asia/Kolkata', iso: '2026-06-30T14:05:09Z', expected: '2026-06-30T19:35:09+05:30' },
    { zone: 'America/New_York', iso: '2026-01-15T12:00:00Z', expected: '2026-01-15T07:00:00-05:00' },
    { zone: 'America/New_York', iso: '2026-07-15T12:00:00Z', expected: '2026-07-15T08:00:00-04:00' },
    { zone: 'America/St_Johns', iso: '2026-01-15T12:00:00Z', expected: '2026-01-15T08:30:00-03:30' },
    { zone: 'Pacific/Kiritimati', iso: '2026-12-31T12:00:00Z', expected: '2027-01-01T02:00:00+14:00' },
  ])('writes $iso in $zone as $expected', ({ zone, iso, expected }) => {
    const packet = withZone(zone, () => cfml2wddx({ V: new Date(iso) }));

    expect(packet).toBe(singleVarPacket(`<dateTime>${expected}</dateTime>`));
  });

  it('rejects an invalid Date with a RangeError', () => {
    expect(() => cfml2wddx({ V: new Date(Number.NaN) })).toThrow(RangeError);
  });
});

describe('cfml2wddx key order', () => {
  it('writes plain-object keys in insertion order', () => {
    expect(cfml2wddx({ ZETA: 'z', ALPHA: 'a', MID: 'm' })).toBe(
      `${PACKET_HEADER}<struct><var name='ZETA'><string>z</string></var><var name='ALPHA'><string>a</string></var>` +
        `<var name='MID'><string>m</string></var></struct>${PACKET_FOOTER}`,
    );
  });

  it('writes Map entries in insertion order, integer-like keys included', () => {
    const values = new Map<string, WddxValue>([
      ['2', 'b'],
      ['1', 'a'],
      ['KEY', 'k'],
    ]);

    expect(cfml2wddx(values)).toBe(
      `${PACKET_HEADER}<struct><var name='2'><string>b</string></var><var name='1'><string>a</string></var>` +
        `<var name='KEY'><string>k</string></var></struct>${PACKET_FOOTER}`,
    );
  });

  it('lists integer-like plain-object keys first, as JavaScript enumerates them', () => {
    expect(cfml2wddx({ KEY: 'k', '2': 'b', '1': 'a' })).toBe(
      `${PACKET_HEADER}<struct><var name='1'><string>a</string></var><var name='2'><string>b</string></var>` +
        `<var name='KEY'><string>k</string></var></struct>${PACKET_FOOTER}`,
    );
  });
});

describe('cfml2wddx unsupported values', () => {
  it.each<{ name: string; value: unknown; label: string }>([
    { name: 'a class instance', value: new (class Widget {})(), label: 'Widget' },
    { name: 'an anonymous class instance', value: new (class {})(), label: 'object' },
    { name: 'a Set', value: new Set<string>(), label: 'Set' },
    { name: 'an object without a constructor', value: Object.create(Object.create(null) as object), label: 'object' },
    { name: 'a function', value: () => 1, label: 'function' },
    { name: 'a bigint', value: 1n, label: 'bigint' },
    { name: 'a symbol', value: Symbol('s'), label: 'symbol' },
  ])('throws a TypeError naming $label for $name', ({ value, label }) => {
    const serialize = (): string => cfml2wddx({ V: [value as WddxValue] });

    expect(serialize).toThrow(TypeError);
    expect(serialize).toThrow(`Cannot serialize ${label} as WDDX`);
  });
});
