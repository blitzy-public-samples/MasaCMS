// Fidelity suite for the WDDX port; every expected packet and struct order was captured from ACF 2023 (Masa 7.6.1, server TZ UTC).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cfStruct,
  cfml2wddx,
  wddx2cfml,
  WddxDate,
  WddxNumber,
  wddxNumber,
  wddxStruct,
  wddxStructGet,
  type WddxQuery,
  type WddxStruct,
  type WddxValue,
} from '../../src/domain/wddx.js';

const packet = (inner: string): string => `<wddxPacket version='1.0'><header/><data>${inner}</data></wddxPacket>`;
const n = (text: string): WddxNumber => new WddxNumber(text);
const q = (columns: string[], rows: Record<string, WddxValue>[]): WddxQuery => ({ kind: 'query', columns, rows });
const at = (...parts: [number, number, number, number, number, number, number?]): WddxDate => new WddxDate(new Date(...parts));

const FORM_CREATE =
  "<wddxPacket version='1.0'><header/><data>" +
  "<struct><var name='responseid'><string>C33981F1-CE76-D22E-93A50AB350491D41</string></var>" +
  "<var name='color'><string>red</string></var>" +
  "<var name='fieldnames'><string>name,Email,comments,color</string></var>" +
  "<var name='comments'><string>l1<char code='0d'/><char code='0a'/>l2<char code='09'/>&amp;&lt;&gt;'\"é</string></var>" +
  "<var name='Email'><string>b@x.com</string></var>" +
  "<var name='name'><string>Bob &lt;nonoscript&gt;x&lt;/noscript&gt;</string></var>" +
  "</struct></data></wddxPacket>";

const FORM_UPDATE =
  "<wddxPacket version='1.0'><header/><data>" +
  "<struct><var name='responseid'><string>C33981F1-CE76-D22E-93A50AB350491D41</string></var>" +
  "<var name='fieldnames'><string>name,Email,comments,color</string></var>" +
  "<var name='comments'><string>c2</string></var><var name='Email'><string>b2@x.com</string></var>" +
  "<var name='name'><string>Bobby</string></var></struct></data></wddxPacket>";

const CHANGESET_TRASH =
  "<wddxPacket version='1.0'><header/><data><struct><var name='ERRORS'><struct></struct></var>" +
  "<var name='muraDeleteDateTime'><string>{ts '2026-11-10 18:29:32'}</string></var>" +
  "<var name='ADDOBJECTS'><array length='0'></array></var>" +
  "<var name='CREATED'><dateTime>2026-11-10T18:29:32+00:00</dateTime></var>" +
  "<var name='LASTUPDATE'><dateTime>2026-11-10T18:29:32+00:00</dateTime></var>" +
  "<var name='PUBLISHED'><number>0.0</number></var>" +
  "<var name='DESCRIPTION'><string>desc<char code='0a'/>line2</string></var>" +
  "<var name='CLOSEDATE'><string></string></var>" +
  "<var name='muraDeleteID'><string>C33986A8-0364-2330-D256B6987181DD66</string></var>" +
  "<var name='INSTANCEID'><string>C339864D-D81C-35A4-F1D36655E0F6B90D</string></var>" +
  "<var name='LASTUPDATEBYID'><string></string></var>" +
  "<var name='CHANGESETID'><string>C339851E-F35C-D931-94E0F789891A922C</string></var>" +
  "<var name='PUBLISHDATE'><string></string></var><var name='CATEGORYID'><string></string></var>" +
  "<var name='REMOVEOBJECTS'><array length='0'></array></var>" +
  "<var name='SITEID'><string>default</string></var>" +
  "<var name='NAME'><string>Blitzy CS &lt;1&gt; &amp; co</string></var>" +
  "<var name='REMOTEID'><string></string></var><var name='REMOTESOURCEURL'><string></string></var>" +
  "<var name='REMOTEPUBDATE'><string></string></var>" +
  "<var name='FROMMURACACHE'><boolean value='false'/></var>" +
  "<var name='LASTUPDATEBY'><string></string></var><var name='ISNEW'><string>0</string></var>" +
  "<var name='TAGS'><string></string></var></struct></data></wddxPacket>";

const CATEGORY_RECORDSET =
  "<recordset rowCount='1' fieldNames='CONTENTHISTID,CATEGORYID,CONTENTID,ISFEATURE,ORDERNO,SITEID," +
  "FEATURESTART,FEATURESTOP,NAME,FILENAME,PARENTID,PATH' type='coldfusion.sql.QueryTable'>" +
  "<field name='CONTENTHISTID'><string>C339BB4E-EED0-9264-D6C1AD2014BC2286</string></field>" +
  "<field name='CATEGORYID'><string>C339B7C5-CBBE-3F56-00EF4E1445AB55C9</string></field>" +
  "<field name='CONTENTID'><string>C339BAFE-95EE-011C-0DD3CD59E2BA0A3B</string></field>" +
  "<field name='ISFEATURE'><number>0.0</number></field>" +
  "<field name='ORDERNO'><number>0.0</number></field>" +
  "<field name='SITEID'><string>default</string></field><field name='FEATURESTART'><null/></field>" +
  "<field name='FEATURESTOP'><null/></field><field name='NAME'><string>Blitzy Cat</string></field>" +
  "<field name='FILENAME'><string>blitzy-cat1</string></field><field name='PARENTID'><null/></field>" +
  "<field name='PATH'><string>C339B7C5-CBBE-3F56-00EF4E1445AB55C9</string></field></recordset>";

// [label, keys assigned in order, key order in the captured packet]
const STRUCT_ORDERS: Array<[string, string[], string[]]> = [
  [
    'case collision',
    [
      'abc', 'Zed', 'ABC', 'zED', 'q',
    ],
    [
      'q', 'abc', 'Zed',
    ],
  ],
  [
    'tryPresize on a ninth bin node',
    [
      'KN', 'KCTL', 'KGEJB', 'KZHSC', 'KNPSL', 'KSAUP', 'KITJT', 'KBXSU', 'KUACW',
    ],
    [
      'KZHSC', 'KUACW', 'KGEJB', 'KNPSL', 'KBXSU', 'KITJT', 'KN', 'KSAUP', 'KCTL',
    ],
  ],
  [
    'tree bins through resizes',
    [
      'KDNUQID', 'KSFGRID', 'KHYRRID', 'KWQDSID', 'KLJPSID', 'KACBTID', 'KPUMTID', 'KENYTID', 'KTFKUID', 'KIYVUID',
      'KXQHVID', 'KMJTVID', 'KBCFWID', 'KQUQWID', 'KFNCXID', 'KUFOXID', 'KJYZXID', 'KYQLYID', 'KNJXYID', 'KCCJZID',
      'KRUUZID', 'KGNGAJD', 'KVFSAJD', 'KKYDBJD', 'KZQPBJD', 'KOJBCJD', 'KDCNCJD', 'KSUYCJD', 'KHNKDJD', 'KWFWDJD',
      'KRAQM', 'KYLZW', 'KWAKCB', 'KPETDB', 'KHXQNB', 'KKQGGD', 'KDUPHD', 'KUMJOD', 'KQJIIF', 'KEGBDG', 'KEZEMH',
      'KQVPAI', 'KDIXHM', 'KEBFUN', 'KVMAZZF', 'KKFMZZF', 'KZXXZZF', 'KOQJAAG', 'KDJVAAG', 'KSBHBAG', 'KHUSBAG',
      'KWMECAG', 'KLFQCAG', 'KAYBDAG', 'KPQNDAG', 'KEJZDAG', 'KTBLEAG', 'KIUWEAG', 'KXMIFAG', 'KMFUFAG', 'KBYFGAG',
      'KQQRGAG', 'KFJDHAG', 'KUBPHAG', 'KJUAIAG', 'KYMMIAG', 'KNFYIAG', 'KCYJJAG', 'KRQVJAG', 'KGJHKAG', 'KVBTKAG',
      'KKUELAG', 'KZMQLAG', 'KOFCMAG',
    ],
    [
      'KGNGAJD', 'KQQRGAG', 'KGJHKAG', 'KENYTID', 'KQUQWID', 'KDIXHM', 'KEZEMH', 'KEGBDG', 'KRAQM', 'KYLZW',
      'KWAKCB', 'KKQGGD', 'KQJIIF', 'KKFMZZF', 'KBYFGAG', 'KDJVAAG', 'KXQHVID', 'KBCFWID', 'KUFOXID', 'KLFQCAG',
      'KJUAIAG', 'KDNUQID', 'KSBHBAG', 'KHYRRID', 'KWQDSID', 'KSFGRID', 'KACBTID', 'KCYJJAG', 'KLJPSID', 'KKUELAG',
      'KMFUFAG', 'KKYDBJD', 'KIYVUID', 'KAYBDAG', 'KTBLEAG', 'KTFKUID', 'KWFWDJD', 'KZQPBJD', 'KCCJZID', 'KOFCMAG',
      'KOQJAAG', 'KEBFUN', 'KQVPAI', 'KPETDB', 'KHXQNB', 'KDUPHD', 'KUMJOD', 'KYMMIAG', 'KOJBCJD', 'KZMQLAG',
      'KMJTVID', 'KHNKDJD', 'KRQVJAG', 'KPUMTID', 'KSUYCJD', 'KYQLYID', 'KFJDHAG', 'KWMECAG', 'KDCNCJD', 'KNFYIAG',
      'KHUSBAG', 'KVBTKAG', 'KNJXYID', 'KEJZDAG', 'KIUWEAG', 'KUBPHAG', 'KFNCXID', 'KVFSAJD', 'KVMAZZF', 'KRUUZID',
      'KPQNDAG', 'KJYZXID', 'KXMIFAG', 'KZXXZZF',
    ],
  ],
  [
    'treeifyBin on replacing an eighth node',
    [
      'KOPWO', 'KFIQV', 'KCQAHC', 'KAFLMC', 'KFQMQC', 'KDFXVC', 'KWIGXC', 'KRMXED', 'krmxed', 'KXVLTZNB', 'KMOXTZNB',
      'KBHJUZNB', 'KQZUUZNB', 'KFSGVZNB', 'KUKSVZNB', 'KJDEWZNB', 'KYVPWZNB', 'KNOBXZNB', 'KCHNXZNB',
    ],
    [
      'KQZUUZNB', 'KDFXVC', 'KAFLMC', 'KOPWO', 'KMOXTZNB', 'KWIGXC', 'KNOBXZNB', 'KCHNXZNB', 'KYVPWZNB', 'KXVLTZNB',
      'KCQAHC', 'KFIQV', 'KRMXED', 'KUKSVZNB', 'KBHJUZNB', 'KFQMQC', 'KJDEWZNB', 'KFSGVZNB',
    ],
  ],
];

const savedTz = process.env.TZ;
const useZone = (zone: string | undefined): void => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
};
beforeAll(() => useZone('UTC'));
afterAll(() => useZone(savedTz));

describe('cfml2wddx writes ACF 2023 bytes', () => {
  it.each<[string, WddxValue, string]>([
    ['plain string', 'hello', '<string>hello</string>'],
    ['entities in text, quotes as is', 'a<b&c>d\'e"f', '<string>a&lt;b&amp;c&gt;d\'e"f</string>'],
    [
      'control units as lowercase char codes, DEL as is',
      'a\r\n\t\u0001\u001f\u007fz',
      "<string>a<char code='0d'/><char code='0a'/><char code='09'/><char code='01'/><char code='1f'/>\u007fz</string>",
    ],
    ['non-ASCII as is', 'é€\u0080\u00a0\u00ff\u0100x\u{1F600}y', '<string>é€\u0080\u00a0\u00ff\u0100x\u{1F600}y</string>'],
    ['empty string', '', '<string></string>'],
    ['padded string', '  pad  ', '<string>  pad  </string>'],
    ['CDATA terminator', ']]>', '<string>]]&gt;</string>'],
    ['numeric string stays a string', '12345678901234', '<string>12345678901234</string>'],
    ['number lexical form', n('1.0'), '<number>1.0</number>'],
    ['booleans', [true, false], "<array length='2'><boolean value='true'/><boolean value='false'/></array>"],
    ['date-time without milliseconds', at(2026, 0, 5, 3, 4, 5, 999), '<dateTime>2026-01-05T03:04:05+00:00</dateTime>'],
    ['Java nulls', [null, wddxStruct([['k', null]])], "<array length='2'><null/><struct><var name='k'><null/></var></struct></array>"],
    [
      'nested arrays and structs',
      [n('1.0'), 'a', [n('2.0')], wddxStruct([]), wddxStruct([['inner', wddxStruct([['deep', []]])]])],
      "<array length='5'><number>1.0</number><string>a</string><array length='1'><number>2.0</number></array><struct></struct>" +
        "<struct><var name='inner'><struct><var name='deep'><array length='0'></array></var></struct></var></struct></array>",
    ],
    [
      'struct entries in given order with key casing kept',
      wddxStruct([['ContentID', 'x'], ['title', 'y']]),
      "<struct><var name='ContentID'><string>x</string></var><var name='title'><string>y</string></var></struct>",
    ],
    [
      'escaped var names',
      cfStruct([["a'b", '1'], ['a<b', '2'], ['a&b', '3'], ['a"b', '4']]),
      "<struct><var name='a&quot;b'><string>4</string></var><var name='a&lt;b'><string>2</string></var>" +
        "<var name='a&apos;b'><string>1</string></var><var name='a&amp;b'><string>3</string></var></struct>",
    ],
    [
      'control units inside a var name',
      cfStruct([['a\nb', '1'], ['é', '2'], ['x>y', '3']]),
      "<struct><var name='x&gt;y'><string>3</string></var><var name='a<char code='0a'/>b'><string>1</string></var>" +
        "<var name='é'><string>2</string></var></struct>",
    ],
    [
      'query columns field by field',
      q(['contentID', 'Name'], [{ contentID: 'a', Name: 'b' }, { contentID: 'c', Name: 'd' }]),
      "<recordset rowCount='2' fieldNames='contentID,Name' type='coldfusion.sql.QueryTable'><field name='contentID'>" +
        "<string>a</string><string>c</string></field><field name='Name'><string>b</string><string>d</string></field></recordset>",
    ],
    [
      'empty query',
      q(['categoryID', 'name'], []),
      "<recordset rowCount='0' fieldNames='categoryID,name' type='coldfusion.sql.QueryTable'><field name='categoryID'></field>" +
        "<field name='name'></field></recordset>",
    ],
    [
      'database query cells',
      q(['A', 'B', 'C', 'D', 'E', 'F'], [{ A: null, B: n('1.0'), C: n('1.5'), D: at(2026, 5, 30, 13, 5, 9, 123), E: true, F: wddxNumber(12.34) }]),
      "<recordset rowCount='1' fieldNames='A,B,C,D,E,F' type='coldfusion.sql.QueryTable'><field name='A'><null/></field>" +
        "<field name='B'><number>1.0</number></field><field name='C'><number>1.5</number></field><field name='D'>" +
        "<dateTime>2026-06-30T13:05:09+00:00</dateTime></field><field name='E'><boolean value='true'/></field>" +
        "<field name='F'><number>12.34</number></field></recordset>",
    ],
    [
      'fieldNames verbatim, field names escaped',
      q(['A&B', "IT'S", 'L<T'], [{ 'A&B': n('1.0'), "IT'S": n('2.0'), 'L<T': n('3.0') }]),
      "<recordset rowCount='1' fieldNames='A&B,IT'S,L<T' type='coldfusion.sql.QueryTable'><field name='A&amp;B'>" +
        "<number>1.0</number></field><field name='IT&apos;S'><number>2.0</number></field><field name='L&lt;T'>" +
        '<number>3.0</number></field></recordset>',
    ],
  ])('%s', (_label, value, inner) => {
    expect(cfml2wddx(value)).toBe(packet(inner));
  });

  it('writes NUL as char code 00', () => {
    expect(cfml2wddx('a\u0000b')).toBe(packet("<string>a<char code='00'/>b</string>"));
  });

  it('rejects a query row without a declared column', () => {
    expect(() => cfml2wddx(q(['A', 'constructor'], [{ A: 'x' }]))).toThrow(TypeError);
  });
});

describe('cfStruct orders keys as ACF iterates a structNew()', () => {
  it.each(STRUCT_ORDERS)('%s', (_label, keys, order) => {
    expect(cfStruct(keys.map((key): [string, WddxValue] => [key, 'v'])).entries.map(([key]) => key)).toEqual(order);
  });

  it('keeps the first casing and place of a repeated key and takes the later value', () => {
    expect(cfStruct([['abc', '1'], ['q', '2'], ['ABC', '3']]).entries).toEqual([['q', '2'], ['abc', '3']]);
  });

  it('orders mixed-case dot and bracket keys as captured', () => {
    expect(cfml2wddx(cfStruct([['ABC', n('1.0')], ['MixedKey', '2'], ['lower', 'x']]))).toBe(
      packet(
        "<struct><var name='ABC'><number>1.0</number></var><var name='lower'><string>x</string></var>" +
          "<var name='MixedKey'><string>2</string></var></struct>",
      ),
    );
  });
});

describe('Masa packets recorded from legacy', () => {
  it('form response create: dataCollectionManager.update assignments, _default field renamed', () => {
    const info = cfStruct([
      ['fieldnames', ''],
      ['responseid', 'C33981F1-CE76-D22E-93A50AB350491D41'],
      ['fieldnames', 'name'],
      ['name', 'Bob <nonoscript>x</noscript>'],
      ['fieldnames', 'name,Email'],
      ['Email', 'b@x.com'],
      ['fieldnames', 'name,Email,comments'],
      ['comments', 'l1\r\nl2\t&<>\'"é'],
      ['fieldnames', 'name,Email,comments,color'],
      ['color', 'red'],
    ]);
    expect(cfml2wddx(info)).toBe(FORM_CREATE);
  });

  it('form response update keeps the stored field list', () => {
    const info = cfStruct([
      ['fieldnames', ''],
      ['responseid', 'C33981F1-CE76-D22E-93A50AB350491D41'],
      ['fieldnames', 'name,Email,comments,color'],
      ['name', 'Bobby'],
      ['Email', 'b2@x.com'],
      ['comments', 'c2'],
    ]);
    expect(cfml2wddx(info)).toBe(FORM_UPDATE);
  });

  it('change-set trash entry (changesetBean.getAllValues)', () => {
    const deleted = at(2026, 10, 10, 18, 29, 32);
    const values = wddxStruct([
      ['ERRORS', wddxStruct([])],
      ['muraDeleteDateTime', "{ts '2026-11-10 18:29:32'}"],
      ['ADDOBJECTS', []],
      ['CREATED', deleted],
      ['LASTUPDATE', deleted],
      ['PUBLISHED', wddxNumber(0)],
      ['DESCRIPTION', 'desc\nline2'],
      ['CLOSEDATE', ''],
      ['muraDeleteID', 'C33986A8-0364-2330-D256B6987181DD66'],
      ['INSTANCEID', 'C339864D-D81C-35A4-F1D36655E0F6B90D'],
      ['LASTUPDATEBYID', ''],
      ['CHANGESETID', 'C339851E-F35C-D931-94E0F789891A922C'],
      ['PUBLISHDATE', ''],
      ['CATEGORYID', ''],
      ['REMOVEOBJECTS', []],
      ['SITEID', 'default'],
      ['NAME', 'Blitzy CS <1> & co'],
      ['REMOTEID', ''],
      ['REMOTESOURCEURL', ''],
      ['REMOTEPUBDATE', ''],
      ['FROMMURACACHE', false],
      ['LASTUPDATEBY', ''],
      ['ISNEW', '0'],
      ['TAGS', ''],
    ]);
    expect(cfml2wddx(values)).toBe(CHANGESET_TRASH);
  });

  it('content trash categoriesFromMuraTrash query', () => {
    const query = q(
      ['CONTENTHISTID', 'CATEGORYID', 'CONTENTID', 'ISFEATURE', 'ORDERNO', 'SITEID', 'FEATURESTART', 'FEATURESTOP', 'NAME', 'FILENAME', 'PARENTID', 'PATH'],
      [
        {
          CONTENTHISTID: 'C339BB4E-EED0-9264-D6C1AD2014BC2286',
          CATEGORYID: 'C339B7C5-CBBE-3F56-00EF4E1445AB55C9',
          CONTENTID: 'C339BAFE-95EE-011C-0DD3CD59E2BA0A3B',
          ISFEATURE: wddxNumber(0),
          ORDERNO: wddxNumber(0),
          SITEID: 'default',
          FEATURESTART: null,
          FEATURESTOP: null,
          NAME: 'Blitzy Cat',
          FILENAME: 'blitzy-cat1',
          PARENTID: null,
          PATH: 'C339B7C5-CBBE-3F56-00EF4E1445AB55C9',
        },
      ],
    );
    expect(cfml2wddx(query)).toBe(packet(CATEGORY_RECORDSET));
  });
});

describe('wddx2cfml', () => {
  it.each([
    ['form create', FORM_CREATE],
    ['form update', FORM_UPDATE],
    ['change-set trash', CHANGESET_TRASH],
    ['category recordset', packet(CATEGORY_RECORDSET)],
    ['strings and chars', packet("<array length='2'><string>a<char code='0d'/>&amp;\u00a0</string><string></string></array>")],
    ['scalars', packet("<array length='4'><number>-1.2345678E7</number><boolean value='false'/><null/><dateTime>2026-06-30T13:05:09+00:00</dateTime></array>")],
  ])('re-encodes the %s packet byte for byte', (_label, text) => {
    expect(cfml2wddx(wddx2cfml(text))).toBe(text);
  });

  it('keeps packet key casing, looked up case-insensitively', () => {
    const form = wddx2cfml(FORM_CREATE) as WddxStruct;
    expect(form.entries.map(([key]) => key)).toEqual(['responseid', 'color', 'fieldnames', 'comments', 'Email', 'name']);
    expect(wddxStructGet(form, 'EMAIL')).toBe('b@x.com');
    expect(wddxStructGet(form, 'FieldNames')).toBe('name,Email,comments,color');
    expect(wddxStructGet(form, 'missing')).toBeUndefined();
    expect(wddxStructGet(wddxStruct([['K', null]]), 'k')).toBeNull();
  });

  it('reads a query with NULL cells', () => {
    const query = wddx2cfml(packet(CATEGORY_RECORDSET)) as WddxQuery;
    expect(query.columns).toHaveLength(12);
    expect(query.rows).toHaveLength(1);
    expect(query.rows[0]?.FEATURESTART).toBeNull();
    expect(query.rows[0]?.ORDERNO).toEqual(n('0.0'));
  });

  it.each<[number, WddxValue]>([
    [0, 'a<b&c>d\r\n\t'],
    [1, n('1.50')],
    [2, [true, false, null, '']],
    [3, at(2026, 5, 30, 13, 5, 9)],
    [4, wddxStruct([['ContentID', 'x'], ['title', wddxStruct([['Deep', [n('0'), n('-3')]]])]])],
    [5, q(['A', 'b'], [{ A: '1', b: null }, { A: n('2.0'), b: wddxStruct([]) }])],
    [6, q([], [])],
  ])('round-trips sample %i', (_i, value) => {
    expect(wddx2cfml(cfml2wddx(value))).toEqual(value);
  });

  it.each<[string, string, WddxValue]>([
    ['upper-case char codes', packet("<string>a<char code='0A'/>b</string>"), 'a\nb'],
    [
      'whitespace between elements',
      "<wddxPacket version='1.0'>  <header/> <data> <struct> <var name='A'> <string> x </string> </var> </struct> </data></wddxPacket>\n",
      wddxStruct([['A', ' x ']]),
    ],
    ['a header with content', "<wddxPacket version='1.0'><header><comment>hi</comment></header><data><string>c</string></data></wddxPacket>", 'c'],
    ['several data values (the last wins)', packet('<string>a</string><string>b</string>'), 'b'],
    ['a padded number', packet('<number> 1.5 </number>'), n('1.5')],
    ['character references', packet('<string>&#233;&#x41;&apos;&quot;</string>'), 'éA\'"'],
    ['double-quoted attributes and empty forms', '<wddxPacket version="1.0"><header></header><data><string/></data></wddxPacket>', ''],
    ['a wrong array length', packet("<array length='3'><string>x</string></array>"), ['x']],
    ['open-close null and boolean', packet("<array length='2'><null></null><boolean value='true'></boolean></array>"), [null, true]],
    ['an empty array tag', packet('<array/>'), []],
    [
      'short fields and case-insensitive field names',
      packet(
        "<recordset rowCount='2' fieldNames='A,B'><field name='a'><string>1</string></field>" +
          "<field name='B'><string>x</string><string>y</string></field></recordset>",
      ),
      q(['A', 'B'], [{ A: '1', B: 'x' }, { A: null, B: 'y' }]),
    ],
    ['a query without columns', packet("<recordset rowCount='1' fieldNames=''/>"), q([], [{}])],
  ])('tolerates %s', (_label, text, expected) => {
    expect(wddx2cfml(text)).toEqual(expected);
  });

  it('reads date-time offsets, unpadded and rolled-over fields, and local time', () => {
    const read = (text: string): string => (wddx2cfml(packet(`<dateTime>${text}</dateTime>`)) as WddxDate).value.toISOString();
    expect(read('2026-06-30T13:05:09+00:00')).toBe('2026-06-30T13:05:09.000Z');
    expect(read('2026-06-30T09:05:09-04:00')).toBe('2026-06-30T13:05:09.000Z');
    expect(read('2026-06-30T18:35:09+0530')).toBe('2026-06-30T13:05:09.000Z');
    expect(read('2026-13-40T10:00:00+00:00')).toBe('2027-02-09T10:00:00.000Z');
    expect(read('2026-6-3T1:2:3')).toBe(new Date(2026, 5, 3, 1, 2, 3).toISOString());
  });

  it.each([
    ['text outside a packet', 'not a packet'],
    ['a truncated packet', "<wddxPacket version='1.0'><header/><data><string>x</string>"],
    ['an unterminated entity', packet('<string>a &amp b</string>')],
    ['an out-of-range character reference', packet('<string>&#x110000;</string>')],
    ['markup inside a string', packet('<string>a<b/></string>')],
    ['an unterminated string', "<wddxPacket version='1.0'><header/><data><string>abc"],
    ['a non-numeric number', packet('<number>abc</number>')],
    ['a number without its end tag', packet('<number>1')],
    ['an unterminated number', "<wddxPacket version='1.0'><header/><data><number>1"],
    ['an empty number', packet('<number/>')],
    ['a non-ISO date-time', packet('<dateTime>yesterday</dateTime>')],
    ['a yes/no boolean', packet("<boolean value='yes'/>")],
    ['a boolean without a value', packet('<boolean/>')],
    ['an unsupported element', packet('<binary>AA==</binary>')],
    ['markup inside an attribute', packet("<struct><var name='a<char code='0a'/>b'><string>1</string></var></struct>")],
    ['a struct member that is not a var', packet("<struct><item name='a'><string>1</string></item></struct>")],
    ['an unclosed var', packet("<struct><var name='a'><string>1</string></struct>")],
    ['a non-numeric rowCount', packet("<recordset rowCount='x' fieldNames='A'></recordset>")],
    ['a declared column without a field', packet("<recordset rowCount='1' fieldNames='A,B'><field name='A'><string>1</string></field></recordset>")],
    ['a field without a declared column', packet("<recordset rowCount='1' fieldNames='A'><field name='C'><string>2</string></field></recordset>")],
    ['an unclosed header', "<wddxPacket version='1.0'><header><comment>x</comment><data><string>c</string></data></wddxPacket>"],
    ['empty data', "<wddxPacket version='1.0'><header/><data/></wddxPacket>"],
    ['trailing content', `${packet('<string>c</string>')}trailing`],
    ['another root element', "<packet version='1.0'><header/><data><string>c</string></data></packet>"],
  ])('rejects %s', (_label, text) => {
    expect(() => wddx2cfml(text)).toThrow(new Error('Invalid WDDX packet'));
  });
});

describe('wddxNumber writes Java Double.toString', () => {
  it.each([
    [1, '1.0'],
    [1.5, '1.5'],
    [0, '0.0'],
    [-0, '-0.0'],
    [-3, '-3.0'],
    [9999999, '9999999.0'],
    [12345678, '1.2345678E7'],
    [0.001, '0.001'],
    [0.0001, '1.0E-4'],
    [12.34, '12.34'],
    [1e21, '1.0E21'],
    [-2.5e-7, '-2.5E-7'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('%d -> %s', (value, text) => {
    expect(wddxNumber(value).text).toBe(text);
  });
});

describe('date-times carry the process zone offset', () => {
  afterEach(() => useZone('UTC'));

  it.each([
    ['America/New_York', '2026-06-30T09:05:09-04:00', '2026-01-05T22:04:05-05:00'],
    ['Asia/Kolkata', '2026-06-30T18:35:09+05:30', '2026-01-06T08:34:05+05:30'],
  ])('%s', (zone, summer, winter) => {
    useZone(zone);
    const june = new WddxDate(new Date(Date.UTC(2026, 5, 30, 13, 5, 9)));
    expect(cfml2wddx(june)).toBe(packet(`<dateTime>${summer}</dateTime>`));
    expect(cfml2wddx(new WddxDate(new Date(Date.UTC(2026, 0, 6, 3, 4, 5))))).toBe(packet(`<dateTime>${winter}</dateTime>`));
    expect((wddx2cfml(cfml2wddx(june)) as WddxDate).value.getTime()).toBe(june.value.getTime());
  });
});
