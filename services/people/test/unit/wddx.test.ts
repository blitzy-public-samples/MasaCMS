import { describe, it, expect, afterAll } from 'vitest';
import { addressTrashValues, cfml2wddx, WDDX_STRUCT_OPEN, WddxNumber } from '../../src/legacy/wddx.js';
import type { AddressRow, AddressTrashInput, WddxStruct, WddxValue } from '../../src/legacy/wddx.js';

const SUITE_ZONE = 'America/New_York';
const previousZone = process.env.TZ;
process.env.TZ = SUITE_ZONE;

afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

const PACKET_HEADER = "<wddxPacket version='1.0'><header/><data>";
const PACKET_FOOTER = '</data></wddxPacket>';

/** Expected packet whose top-level struct holds `element` as its only var, V. */
function singleVarPacket(element: string): string {
  return `${PACKET_HEADER}<struct><var name='V'>${element}</var></struct>${PACKET_FOOTER}`;
}

/** Runs `run` with the process zone set to `zone`, then restores the suite zone. */
function withZone<T>(zone: string, run: () => T): T {
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    process.env.TZ = SUITE_ZONE;
  }
}

const keysOf = (s: WddxStruct): string[] => s.entries.map(([key]) => key);

/** The value of `key` in `s`; fails the test when the key is absent. */
function valueOf(s: WddxStruct, key: string): WddxValue {
  const entry = s.entries.find(([k]) => k === key);
  if (!entry) throw new Error(`Struct has no key '${key}'`);
  return entry[1];
}

const ADDRESS: AddressRow = {
  addressID: 'B2C4D6E8-1A3C-5E70-9B1D3F5A7C9E0B2D',
  userID: '7F3E9A21-C4B8-4D6E-A1F20B3C4D5E6F70',
  siteID: 'tenant-a',
  addressName: 'Home',
  address1: '12 Elm St.',
  address2: 'Unit <4> & "B"',
  city: '  Springfield\t',
  state: 'IL',
  zip: '62701',
  country: 'United States',
  phone: '217-555-0100',
  fax: null,
  isPrimary: 1,
  addressNotes: "Ring twice\r\nO'Hare side",
  addressURL: 'https://example.com/map?a=1&b=2',
  longitude: -89.650148,
  latitude: 39.781721,
  addressEmail: 'home@example.com',
  hours: 'Mon\u2013Fri 9\u201317',
};

const TRASH_INPUT: AddressTrashInput = {
  address: ADDRESS,
  extendedData: { extendSetId: 'C1D2E3F4-A5B6-4C7D-8E9F0A1B2C3D4E5F', data: [['preferredContact', 'Phone']] },
  deleteDateTime: new Date('2026-03-04T10:06:07.250Z'),
  deleteId: 'D4E5F6A7-B8C9-4DAE-BF0A1B2C3D4E5F60',
  instanceId: 'E5F6A7B8-C9DA-4EBF-80A1B2C3D4E5F607',
};

/** Builds a trash input for ADDRESS with the given column overrides and extended data. */
function trashInput(
  overrides: Partial<AddressRow> = {},
  extendedData: AddressTrashInput['extendedData'] = TRASH_INPUT.extendedData,
): AddressTrashInput {
  return { ...TRASH_INPUT, address: { ...ADDRESS, ...overrides }, extendedData };
}

// cfwddx of addressBean.getAllValues() at trashManager.cfc:227, keys in ACF struct iteration order.
const ADDRESS_TRASH_PACKET =
  "<wddxPacket version='1.0'><header/><data><struct>" +
  "<var name='ZIP'><string>62701</string></var>" +
  "<var name='ERRORS'><struct></struct></var>" +
  "<var name='EXTENDAUTOCOMPLETE'><boolean value='true'/></var>" +
  "<var name='PHONE'><string>217-555-0100</string></var>" +
  "<var name='LONGITUDE'><string>-89.650148</string></var>" +
  "<var name='STATE'><string>IL</string></var>" +
  "<var name='muraDeleteDateTime'><string>{ts '2026-03-04 05:06:07'}</string></var>" +
  "<var name='ADDOBJECTS'><array length='0'></array></var>" +
  "<var name='COUNTRY'><string>United States</string></var>" +
  "<var name='EXTENDDATATABLE'><string>tclassextenddatauseractivity</string></var>" +
  "<var name='ADDRESSID'><string>B2C4D6E8-1A3C-5E70-9B1D3F5A7C9E0B2D</string></var>" +
  "<var name='USERID'><string>7F3E9A21-C4B8-4D6E-A1F20B3C4D5E6F70</string></var>" +
  "<var name='ADDRESSNAME'><string>Home</string></var>" +
  "<var name='ADDRESSEMAIL'><string>home@example.com</string></var>" +
  "<var name='preferredContact'><string>Phone</string></var>" +
  "<var name='muraDeleteID'><string>D4E5F6A7-B8C9-4DAE-BF0A1B2C3D4E5F60</string></var>" +
  "<var name='ADDRESS1'><string>12 Elm St.</string></var>" +
  "<var name='INSTANCEID'><string>E5F6A7B8-C9DA-4EBF-80A1B2C3D4E5F607</string></var>" +
  "<var name='TYPE'><string>Address</string></var>" +
  "<var name='ADDRESS2'><string>Unit &lt;4&gt; &amp; \"B\"</string></var>" +
  "<var name='SUBTYPE'><string>Default</string></var>" +
  "<var name='ADDRESSURL'><string>https://example.com/map?a=1&amp;b=2</string></var>" +
  "<var name='SOURCEITERATOR'><string></string></var>" +
  "<var name='EXTENDSETID'><string>C1D2E3F4-A5B6-4C7D-8E9F0A1B2C3D4E5F</string></var>" +
  "<var name='REMOVEOBJECTS'><array length='0'></array></var>" +
  "<var name='SITEID'><string>tenant-a</string></var>" +
  "<var name='CITY'><string>Springfield</string></var>" +
  "<var name='HOURS'><string>Mon\u2013Fri 9\u201317</string></var>" +
  "<var name='ISPRIMARY'><string>1</string></var>" +
  "<var name='FROMMURACACHE'><boolean value='false'/></var>" +
  "<var name='FAX'><string></string></var>" +
  "<var name='ISNEW'><number>0.0</number></var>" +
  "<var name='ADDRESSNOTES'><string>Ring twice<char code='0d'/><char code='0a'/>O'Hare side</string></var>" +
  "<var name='LATITUDE'><string>39.781721</string></var>" +
  "<var name='EXTENDDATA'><string></string></var>" +
  '</struct></data></wddxPacket>';

const BEAN_KEY_ORDER = [
  'ZIP', 'ERRORS', 'EXTENDAUTOCOMPLETE', 'PHONE', 'LONGITUDE', 'STATE', 'muraDeleteDateTime', 'ADDOBJECTS', 'COUNTRY',
  'EXTENDDATATABLE', 'ADDRESSID', 'USERID', 'ADDRESSNAME', 'ADDRESSEMAIL', 'muraDeleteID', 'ADDRESS1', 'INSTANCEID', 'TYPE',
  'ADDRESS2', 'SUBTYPE', 'ADDRESSURL', 'SOURCEITERATOR', 'EXTENDSETID', 'REMOVEOBJECTS', 'SITEID', 'CITY', 'HOURS',
  'ISPRIMARY', 'FROMMURACACHE', 'FAX', 'ISNEW', 'ADDRESSNOTES', 'LATITUDE', 'EXTENDDATA',
];

describe('cfml2wddx packet framing', () => {
  it('opens with the packet header and the struct tag and closes the struct, data and packet', () => {
    const packet = cfml2wddx({ entries: [['SITEID', 'tenant-a']] });

    expect(WDDX_STRUCT_OPEN).toBe('<struct>');
    expect(packet.startsWith(PACKET_HEADER + WDDX_STRUCT_OPEN)).toBe(true);
    expect(packet.endsWith('</struct></data></wddxPacket>')).toBe(true);
    expect(packet).toBe(`${PACKET_HEADER}<struct><var name='SITEID'><string>tenant-a</string></var></struct>${PACKET_FOOTER}`);
  });

  it('writes an empty top-level struct as an empty struct element', () => {
    expect(cfml2wddx({ entries: [] })).toBe(`${PACKET_HEADER}<struct></struct>${PACKET_FOOTER}`);
  });
});

describe('cfml2wddx strings', () => {
  it.each([
    { name: 'plain text', value: 'Springfield', expected: 'Springfield' },
    { name: 'an empty string', value: '', expected: '' },
    { name: 'markup characters', value: 'a<b>&c', expected: 'a&lt;b&gt;&amp;c' },
    { name: 'quotes, which element text keeps raw', value: `O'Hare "B"`, expected: `O'Hare "B"` },
    { name: 'NUL and unit separator', value: '\u0000\u001f', expected: "<char code='00'/><char code='1f'/>" },
    { name: 'tab, carriage return and line feed', value: 'a\t\r\nb', expected: "a<char code='09'/><char code='0d'/><char code='0a'/>b" },
    { name: 'space and DEL, which stay raw', value: ' \u007f ', expected: ' \u007f ' },
    { name: 'non-ASCII units, which stay raw', value: 'caf\u00e9 \u2013 \ud83d\ude00', expected: 'caf\u00e9 \u2013 \ud83d\ude00' },
  ])('escapes $name in element text', ({ value, expected }) => {
    expect(cfml2wddx({ entries: [['V', value]] })).toBe(singleVarPacket(`<string>${expected}</string>`));
  });

  it.each([
    { name: 'an apostrophe', key: "O'K", expected: 'O&apos;K' },
    { name: 'double quotes', key: 'say "hi"', expected: 'say &quot;hi&quot;' },
    { name: 'markup characters', key: 'a&b<c>', expected: 'a&amp;b&lt;c&gt;' },
    { name: 'a tab', key: 'tab\there', expected: "tab<char code='09'/>here" },
  ])('escapes $name in var name attributes', ({ key, expected }) => {
    expect(cfml2wddx({ entries: [[key, 'x']] })).toBe(
      `${PACKET_HEADER}<struct><var name='${expected}'><string>x</string></var></struct>${PACKET_FOOTER}`,
    );
  });
});

describe('cfml2wddx numbers', () => {
  it.each(['0', '1', '0.0', '-12.50'])('keeps the lexical form of WddxNumber %s', (text) => {
    expect(cfml2wddx({ entries: [['V', new WddxNumber(text)]] })).toBe(singleVarPacket(`<number>${text}</number>`));
  });

  it.each([
    { value: 0, expected: '0.0' },
    { value: -0, expected: '-0.0' },
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
    { value: Number.NaN, expected: 'NaN' },
    { value: Number.POSITIVE_INFINITY, expected: 'Infinity' },
    { value: Number.NEGATIVE_INFINITY, expected: '-Infinity' },
  ])('writes the JS number $value as Java Double.toString $expected', ({ value, expected }) => {
    expect(cfml2wddx({ entries: [['V', value]] })).toBe(singleVarPacket(`<number>${expected}</number>`));
  });
});

describe('cfml2wddx booleans, null and dates', () => {
  it.each([
    { value: true, expected: "<boolean value='true'/>" },
    { value: false, expected: "<boolean value='false'/>" },
  ])('writes $value as a boolean element', ({ value, expected }) => {
    expect(cfml2wddx({ entries: [['V', value]] })).toBe(singleVarPacket(expected));
  });

  it('writes a null member as a null element', () => {
    expect(cfml2wddx({ entries: [['V', null]] })).toBe(singleVarPacket('<null/>'));
  });

  it.each([
    { zone: SUITE_ZONE, iso: '2026-01-15T12:00:00Z', expected: '2026-01-15T07:00:00-05:00' },
    { zone: SUITE_ZONE, iso: '2026-07-15T12:00:00Z', expected: '2026-07-15T08:00:00-04:00' },
    { zone: 'Asia/Kolkata', iso: '2026-06-30T14:05:09Z', expected: '2026-06-30T19:35:09+05:30' },
    { zone: 'UTC', iso: '2027-01-02T03:04:05.006Z', expected: '2027-01-02T03:04:05+00:00' },
    { zone: 'America/St_Johns', iso: '2026-01-15T12:00:00Z', expected: '2026-01-15T08:30:00-03:30' },
  ])('writes $iso in $zone as the dateTime $expected', ({ zone, iso, expected }) => {
    const packet = withZone(zone, () => cfml2wddx({ entries: [['V', new Date(iso)]] }));

    expect(packet).toBe(singleVarPacket(`<dateTime>${expected}</dateTime>`));
  });

  it('rejects an invalid Date with a RangeError', () => {
    expect(() => cfml2wddx({ entries: [['V', new Date(Number.NaN)]] })).toThrow(RangeError);
  });
});

describe('cfml2wddx arrays and nested structs', () => {
  it('writes an empty array with length 0', () => {
    expect(cfml2wddx({ entries: [['V', []]] })).toBe(singleVarPacket("<array length='0'></array>"));
  });

  it('writes array items in order with their length, nesting arrays and structs', () => {
    const value: WddxValue = ['a', new WddxNumber('2'), [true], { entries: [['K', null]] }];

    expect(cfml2wddx({ entries: [['V', value]] })).toBe(
      singleVarPacket(
        "<array length='4'><string>a</string><number>2</number><array length='1'><boolean value='true'/></array>" +
          "<struct><var name='K'><null/></var></struct></array>",
      ),
    );
  });

  it('writes nested struct entries in the order given, keys as given', () => {
    const values: WddxStruct = {
      entries: [
        ['outer', { entries: [['Zeta', 'z'], ['ALPHA', new WddxNumber('1')]] }],
        ['EMPTY', { entries: [] }],
      ],
    };

    expect(cfml2wddx(values)).toBe(
      `${PACKET_HEADER}<struct><var name='outer'><struct><var name='Zeta'><string>z</string></var>` +
        `<var name='ALPHA'><number>1</number></var></struct></var><var name='EMPTY'><struct></struct></var></struct>${PACKET_FOOTER}`,
    );
  });
});

describe('cfml2wddx unsupported values', () => {
  it.each<{ name: string; value: unknown; label: string }>([
    { name: 'a class instance', value: new (class Widget { readonly kind = 'widget'; })(), label: 'Widget' },
    { name: 'an anonymous class instance', value: new (class { readonly kind = 'anonymous'; })(), label: 'object' },
    { name: 'a Map', value: new Map<string, string>(), label: 'Map' },
    { name: 'a plain object without entries', value: { V: 'x' }, label: 'Object' },
    { name: 'an object whose entries is not an array', value: { entries: 'x' }, label: 'Object' },
    { name: 'a null-prototype object', value: Object.create(null) as object, label: 'object' },
    { name: 'undefined', value: undefined, label: 'undefined' },
    { name: 'a function', value: () => 1, label: 'function' },
    { name: 'a bigint', value: 1n, label: 'bigint' },
    { name: 'a symbol', value: Symbol('s'), label: 'symbol' },
  ])('throws a TypeError naming $label for $name', ({ value, label }) => {
    const serialize = (): string => cfml2wddx({ entries: [['V', [value as WddxValue]]] });

    expect(serialize).toThrow(TypeError);
    expect(serialize).toThrow(`Cannot serialize ${label} as WDDX`);
  });
});

describe('addressTrashValues packet', () => {
  it('serializes a deleted address with extended data to the ACF trash packet byte for byte', () => {
    expect(cfml2wddx(addressTrashValues(TRASH_INPUT))).toBe(ADDRESS_TRASH_PACKET);
  });

  it('returns the same key order on repeated calls', () => {
    const first = keysOf(addressTrashValues(TRASH_INPUT));
    const second = keysOf(addressTrashValues(TRASH_INPUT));

    expect(second).toEqual(first);
    expect(first).toEqual([...BEAN_KEY_ORDER.slice(0, 14), 'preferredContact', ...BEAN_KEY_ORDER.slice(14)]);
  });

  it('omits extended attributes and the set id without extended data, keeping every bean key', () => {
    const values = addressTrashValues(trashInput({}, { extendSetId: 'C1D2E3F4-A5B6-4C7D-8E9F0A1B2C3D4E5F', data: [] }));

    expect(keysOf(values)).toEqual(BEAN_KEY_ORDER);
    expect(valueOf(values, 'EXTENDSETID')).toBe('');
    expect(valueOf(values, 'EXTENDDATA')).toBe('');
  });

  it.each([
    { name: 'a repeated set id once', extendSetId: 'S1,S2,S1', expected: 'S1,S2' },
    { name: 'empty list items dropped', extendSetId: ',S1,,S2,', expected: 'S1,S2' },
  ])('lists $name in EXTENDSETID', ({ extendSetId, expected }) => {
    const values = addressTrashValues(trashInput({}, { extendSetId, data: [['preferredContact', 'Phone']] }));

    expect(valueOf(values, 'EXTENDSETID')).toBe(expected);
  });

  it.each([
    { name: 'December, outside DST', iso: '2026-12-01T17:30:45Z', expected: "{ts '2026-12-01 12:30:45'}" },
    { name: 'July, inside DST', iso: '2026-07-15T12:00:00Z', expected: "{ts '2026-07-15 08:00:00'}" },
  ])('writes the delete time in $name as its CFML timestamp text in the process zone', ({ iso, expected }) => {
    const values = addressTrashValues({ ...TRASH_INPUT, deleteDateTime: new Date(iso) });

    expect(valueOf(values, 'muraDeleteDateTime')).toBe(expected);
  });
});

describe('addressTrashValues column values', () => {
  it('trims text columns as CFML trim does and writes SQL NULL text columns as empty strings', () => {
    const values = addressTrashValues(trashInput({ userID: null, siteID: null, city: '\u0000 \t\r\n', zip: ' 62701 ' }));

    expect(valueOf(values, 'USERID')).toBe('');
    expect(valueOf(values, 'SITEID')).toBe('');
    expect(valueOf(values, 'CITY')).toBe('');
    expect(valueOf(values, 'ZIP')).toBe('62701');
  });

  it.each([
    { value: 1, expected: '1' },
    { value: -7, expected: '-7' },
    { value: 999_999_999_999, expected: '999999999999' },
    { value: 0.5, expected: '0.5' },
    { value: 0.000123, expected: '0.000123' },
    { value: 0.00012345678901235, expected: '0.000123456789012' },
    { value: -89.650148, expected: '-89.650148' },
    { value: 100_000_000_000.5, expected: '100000000000' },
    { value: 100_000_000_001.5, expected: '100000000002' },
    { value: 1e12, expected: '1E+012' },
    { value: 1_000_000_000_015, expected: '1.00000000002E+012' },
    { value: 1.5e15, expected: '1.5E+015' },
    { value: 9_007_199_254_740_992, expected: '9.00719925474E+015' },
    { value: 1e16, expected: '1E+016' },
    { value: 0.0000123, expected: '1.23E-005' },
    { value: -2.5e-7, expected: '-2.5E-007' },
    { value: 999_999_999_999_999, expected: '1E+015' },
    { value: 123_456_789_012_345, expected: '1.23456789012E+014' },
    { value: 1e-310, expected: '1E-310' },
  ])('writes the numeric column value $value as the ACF string $expected', ({ value, expected }) => {
    const values = addressTrashValues(trashInput({ isPrimary: value, longitude: value, latitude: value }));

    expect(valueOf(values, 'ISPRIMARY')).toBe(expected);
    expect(valueOf(values, 'LONGITUDE')).toBe(expected);
    expect(valueOf(values, 'LATITUDE')).toBe(expected);
  });

  it('keeps the init number 0 for SQL NULL numeric columns', () => {
    const packet = cfml2wddx(addressTrashValues(trashInput({ isPrimary: null, longitude: null, latitude: null })));

    for (const key of ['ISPRIMARY', 'LONGITUDE', 'LATITUDE']) {
      expect(packet).toContain(`<var name='${key}'><number>0.0</number></var>`);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-finite numeric column value %s with a RangeError',
    (value) => {
      expect(() => addressTrashValues(trashInput({ longitude: value }))).toThrow(
        new RangeError(`A legacy numeric column cannot hold ${String(value)}`),
      );
    },
  );
});

describe('addressTrashValues extended data', () => {
  it('appends extended attributes without overwriting bean keys; a repeated name keeps its first casing and last value', () => {
    const values = addressTrashValues(
      trashInput({}, { extendSetId: 'S1', data: [['City', 'Shelbyville'], ['favColor', 'red'], ['FAVCOLOR', 'blue']] }),
    );
    const favColorAt = BEAN_KEY_ORDER.indexOf('FROMMURACACHE');

    expect(keysOf(values)).toEqual([...BEAN_KEY_ORDER.slice(0, favColorAt), 'favColor', ...BEAN_KEY_ORDER.slice(favColorAt)]);
    expect(valueOf(values, 'CITY')).toBe('Springfield');
    expect(valueOf(values, 'favColor')).toBe('blue');
  });

  it('writes a Date-valued extended attribute as a dateTime in the process zone', () => {
    const packet = cfml2wddx(
      addressTrashValues(trashInput({}, { extendSetId: 'S1', data: [['lastVisit', new Date('2026-07-15T12:00:00Z')]] })),
    );

    expect(packet).toContain("<var name='lastVisit'><dateTime>2026-07-15T08:00:00-04:00</dateTime></var>");
  });

  it('rejects a ninth extended attribute name in one hash bin with a RangeError', () => {
    // Every name below has the String.hashCode 1983072004.
    const names = ['ABABABAB', 'ABABABB#', 'ABABB#AB', 'ABABB#B#', 'ABB#ABAB', 'ABB#ABB#', 'ABB#B#AB', 'ABB#B#B#', 'B#ABABAB'];
    const data = names.map((name) => [name, 'x'] as const);

    expect(() => addressTrashValues(trashInput({}, { extendSetId: 'S1', data }))).toThrow(
      new RangeError("Struct key 'B#ABABAB' would treeify its hash bin"),
    );
  });
});
