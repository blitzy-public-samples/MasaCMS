import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cfListFirst,
  cfListGetAt,
  cfListLen,
  cfListRest,
  cfListToArray,
  convertToUtfText,
  decodeLikePropertyResourceBundle,
  decodeUtf8Replacing,
  hasConvertMarker,
  loadBundleText,
  parseJavaProperties,
  PropertiesSyntaxError,
  readLegacyLines,
} from '@/lib/resource-bundles/properties';
import {
  cf2Java,
  createResourceBundles,
  isSupportedLocale,
  messageFormat,
  MessageFormatError,
  rbFor,
  rbKey,
  ResourceBundleLoadError,
  siteRbFor,
  type BundleData,
  type BundleDir,
  type GeneratedBundles,
  type RbLookup,
} from '@/lib/resource-bundles/rb';
import { fixtureBundles } from '../fixtures/resource-bundles/generated-bundles';

const here = import.meta.dirname ?? __dirname;
const fixturePath = (file: string): string => path.resolve(here, '../fixtures/resource-bundles', file);
const readFixture = (file: string): string => readFileSync(fixturePath(file), 'utf8');
const readFixtureBytes = (file: string): Uint8Array => new Uint8Array(readFileSync(fixturePath(file)));
const asObject = (map: ReadonlyMap<string, string>): Record<string, string> => Object.fromEntries(map);

const MALFORMED_UNICODE = 'Malformed \\uxxxx encoding.';

const JAVA_SYNTAX_AS_JAVA = {
  'esc.euro': '€ 5',
  'esc.zh': '中文',
  'colon.key': 'colon value',
  'space.key': 'space value',
  'ws.key': 'padded value',
  'cont.value': 'first second tail=end',
  'esc.a=b': 'escaped equals',
  'esc.a:b': 'escaped colon',
  'dup.key': 'second',
  'eq.double': '=b',
  'eq.trailing': '',
  'strip*me$Key': 'stripped',
};

const JAVA_SYNTAX_AS_LEGACY = {
  'bang.comment': 'kept by the line reader',
  'esc.euro': '\\u20ac 5',
  'esc.zh': '\\u4e2d\\u6587',
  'ws.key': ' padded value',
  'cont.value': 'first \\',
  tail: 'end',
  'esc.a': 'b=escaped equals',
  'esc.ab': 'escaped colon',
  'dup.key': 'second',
  'eq.double': 'b',
  stripmekey: 'stripped',
};

const CONVERTED_TEXT =
  'Zeta.upper=Änderung\r\n' +
  'alpha.colon=Doppelpunkt\r\n' +
  'approvalchains.add=Hinzufügen\r\n' +
  'approvalchains.approve=Bestätigen\r\n' +
  'beta.cont=erste zweite\r\n' +
  'dup.key=zwei\r\n' +
  'esc.a=b=gleich\r\n' +
  'euro.sign=€\r\n';

const CONVERTED_AS_LEGACY = {
  'zeta.upper': 'Änderung',
  'alpha.colon': 'Doppelpunkt',
  'approvalchains.add': 'Hinzufügen',
  'approvalchains.approve': 'Bestätigen',
  'beta.cont': 'erste zweite',
  'dup.key': 'zwei',
  'esc.a': 'b=gleich',
  'euro.sign': '€',
};

describe('properties.ts', () => {
  describe('parseJavaProperties (java.util.Properties)', () => {
    const java = parseJavaProperties(readFixture('java-syntax.properties'));

    it('decodes \\uXXXX escapes', () => {
      expect(java.get('esc.euro')).toBe('€ 5');
      expect(java.get('esc.zh')).toBe('中文');
    });

    it('joins backslash continuations and drops the next line’s leading whitespace', () => {
      expect(java.get('cont.value')).toBe('first second tail=end');
    });

    it('accepts =, : and whitespace as separators', () => {
      expect(java.get('colon.key')).toBe('colon value');
      expect(java.get('space.key')).toBe('space value');
      expect(java.get('ws.key')).toBe('padded value');
    });

    it('skips # and ! comment lines', () => {
      expect([...java.keys()].filter((key) => key.includes('comment'))).toEqual([]);
    });

    it('keeps escaped separators in the key', () => {
      expect(java.get('esc.a=b')).toBe('escaped equals');
      expect(java.get('esc.a:b')).toBe('escaped colon');
    });

    it('keeps the last value of a duplicate key', () => {
      expect(java.get('dup.key')).toBe('second');
    });

    it('reads eq.double==b as =b and eq.trailing= as empty', () => {
      expect(java.get('eq.double')).toBe('=b');
      expect(java.get('eq.trailing')).toBe('');
    });

    it.each<[string, string, Record<string, string>]>([
      ['trailing value whitespace kept', 'k = v  ', { k: 'v  ' }],
      ['tab separator', 'tab.key\tvalue', { 'tab.key': 'value' }],
      ['key without value', 'lonely', { lonely: '' }],
      ['\\t \\n \\r \\f and \\\\ escapes', 'k=a\\tb\\nc\\rd\\fe\\\\f\\qg', { k: 'a\tb\nc\rd\fe\\fqg' }],
      ['CRLF and CR line ends', 'a=1\r\nb=2\rc=3', { a: '1', b: '2', c: '3' }],
      ['continuation over CRLF', 'a=1 \\\r\n   2\r\nb=3', { a: '1 2', b: '3' }],
      ['blank lines and indented comments', '\n\n  # c\n\t! d\nk=v', { k: 'v' }],
      ['comment at end of input', 'k=v\n# end', { k: 'v' }],
      ['trailing backslash at end of input', 'k=v\\', { k: 'v' }],
      ['line ending at end of input after a backslash', 'k=v\\\n', { k: 'v' }],
    ])('%s', (_name, text, expected) => {
      expect(asObject(parseJavaProperties(text))).toEqual(expected);
    });
  });

  describe('readLegacyLines (resourceBundle.cfc LoadResourceBundle)', () => {
    const legacy = readLegacyLines(readFixture('java-syntax.properties'));

    it('skips only lines starting with #', () => {
      expect(legacy.has('hash.comment')).toBe(false);
      expect(legacy.get('bang.comment')).toBe('kept by the line reader');
    });

    it("uses a line only when listLen(line,'=') > 1", () => {
      expect(legacy.has('eq.trailing')).toBe(false);
      expect(legacy.has('colon.key')).toBe(false);
      expect(legacy.has('space.key')).toBe(false);
    });

    it('strips key characters outside [a-zA-Z0-9_\\-.] and lower-cases', () => {
      expect(legacy.get('stripmekey')).toBe('stripped');
      expect(asObject(readLegacyLines('Mixed.CASE_k-1=v'))).toEqual({ 'mixed.case_k-1': 'v' });
    });

    it("takes listRest(line,'=') as the value, ignoring empty elements", () => {
      expect(legacy.get('eq.double')).toBe('b');
      expect(legacy.get('esc.a')).toBe('b=escaped equals');
      expect(legacy.get('ws.key')).toBe(' padded value');
    });

    it('splits lines as BufferedReader.readLine', () => {
      expect(asObject(readLegacyLines('a=1\r\nb=2\rc=3\n'))).toEqual({ a: '1', b: '2', c: '3' });
    });

    it('reads java-syntax.properties differently from parseJavaProperties', () => {
      const text = readFixture('java-syntax.properties');
      expect(asObject(parseJavaProperties(text))).toEqual(JAVA_SYNTAX_AS_JAVA);
      expect(asObject(readLegacyLines(text))).toEqual(JAVA_SYNTAX_AS_LEGACY);
    });
  });

  describe('convert switch (LoadResourceBundle, convertToUTF)', () => {
    it.each<[string, boolean]>([
      ['java-syntax.properties', false],
      ['converted.properties', true],
      ['malformed.properties', true],
      ['site-override/en.properties', false],
    ])('hasConvertMarker(%s) is %s for text and bytes', (file, expected) => {
      expect(hasConvertMarker(readFixture(file))).toBe(expected);
      expect(hasConvertMarker(readFixtureBytes(file))).toBe(expected);
    });

    it.each<[string, boolean]>([
      ['a=\\u00e4', true],
      ['a=\\U00e4', false],
      ['a=\\u20ac', false],
      ['a=\\u0', false],
      ['a=u00e4', false],
    ])('hasConvertMarker(%j) is %s (case-sensitive find)', (text, expected) => {
      expect(hasConvertMarker(text)).toBe(expected);
      expect(hasConvertMarker(new TextEncoder().encode(text))).toBe(expected);
    });

    it('convertToUtfText writes case-sensitively sorted key=value CRLF lines', () => {
      expect(convertToUtfText(readFixture('converted.properties'))).toBe(CONVERTED_TEXT);
    });

    it('convertToUtfText writes ? for an unpaired surrogate, as fileWrite UTF-8 does', () => {
      expect(convertToUtfText('a=\\ud800x\nb=\\udc00')).toBe('a=?x\r\nb=?\r\n');
    });

    it('loadBundleText re-reads the converted text with the line reader', () => {
      const bundle = loadBundleText(readFixture('converted.properties'));
      expect(asObject(bundle)).toEqual(CONVERTED_AS_LEGACY);
      expect([...bundle.keys()][0]).toBe('zeta.upper');
    });

    it('loadBundleText uses the line reader when the marker is absent', () => {
      expect(asObject(loadBundleText(readFixture('java-syntax.properties')))).toEqual(JAVA_SYNTAX_AS_LEGACY);
    });

    it.each(['java-syntax.properties', 'converted.properties', 'site-override/en.properties'])(
      'loadBundleText gives equal maps for bytes and text of %s',
      (file) => {
        expect(asObject(loadBundleText(readFixtureBytes(file)))).toEqual(asObject(loadBundleText(readFixture(file))));
      },
    );

    it.each<[string, (input: string) => unknown]>([
      ['parseJavaProperties', parseJavaProperties],
      ['convertToUtfText', convertToUtfText],
      ['loadBundleText', loadBundleText],
    ])('%s throws PropertiesSyntaxError on malformed.properties', (_name, load) => {
      const text = readFixture('malformed.properties');
      expect(() => load(text)).toThrow(PropertiesSyntaxError);
      expect(() => load(text)).toThrow(MALFORMED_UNICODE);
    });

    it('loadBundleText throws PropertiesSyntaxError on malformed.properties bytes', () => {
      expect(() => loadBundleText(readFixtureBytes('malformed.properties'))).toThrow(MALFORMED_UNICODE);
    });

    it('loadBundleText(site-override/en.properties) is exactly the override', () => {
      expect(asObject(loadBundleText(readFixture('site-override/en.properties')))).toEqual({
        'global.mycustomkey': 'success',
        'layout.help': 'Site Help',
      });
    });
  });

  describe('decoders', () => {
    it('decodeUtf8Replacing replaces invalid UTF-8 with U+FFFD', () => {
      expect(decodeUtf8Replacing(Uint8Array.of(0x61, 0xff, 0x62))).toBe('a\uFFFDb');
      expect(decodeUtf8Replacing(Uint8Array.of(0x61, 0xed, 0xa0, 0x80, 0x62))).toBe('a\uFFFDb');
      expect(decodeUtf8Replacing(Uint8Array.of(0xed, 0xbf, 0x41))).toBe('\uFFFDA');
    });

    it('decodeLikePropertyResourceBundle decodes valid UTF-8', () => {
      expect(decodeLikePropertyResourceBundle(new TextEncoder().encode('Grüße € 中文 𝄞'))).toBe('Grüße € 中文 𝄞');
    });

    it.each<[string, number[]]>([
      ['a non-UTF-8 byte', [0x47, 0x72, 0xfc, 0x65]],
      ['a missing continuation byte', [0xc3, 0x41]],
      ['an overlong sequence', [0xe0, 0x80, 0x80]],
      ['an encoded surrogate', [0xed, 0xa0, 0x80]],
      ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
      ['an invalid lead byte', [0xf8, 0x41]],
    ])('decodeLikePropertyResourceBundle falls back to ISO-8859-1 on %s', (_name, bytes) => {
      expect(decodeLikePropertyResourceBundle(Uint8Array.from(bytes))).toBe(String.fromCharCode(...bytes));
    });

    it('decodeLikePropertyResourceBundle throws on UTF-8 cut off at end of input', () => {
      expect(() => decodeLikePropertyResourceBundle(Uint8Array.of(0x61, 0xe2, 0x82))).toThrow(PropertiesSyntaxError);
      expect(() => decodeLikePropertyResourceBundle(Uint8Array.of(0x61, 0xe2, 0x82))).toThrow('Input length = 2');
    });

    it('both decoders keep a byte-order mark', () => {
      const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61);
      expect(decodeLikePropertyResourceBundle(bytes)).toBe('\uFEFFa');
      expect(decodeUtf8Replacing(bytes)).toBe('\uFEFFa');
    });
  });

  describe('CFML list helpers', () => {
    it.each<[string, () => unknown, unknown]>([
      ["cfListLen('a,,b', ',')", () => cfListLen('a,,b', ','), 2],
      ["cfListLen('', ',')", () => cfListLen('', ','), 0],
      ["cfListLen('a=b:c', '=:')", () => cfListLen('a=b:c', '=:'), 3],
      ["cfListFirst('en_US', '_')", () => cfListFirst('en_US', '_'), 'en'],
      ["cfListFirst(',,', ',')", () => cfListFirst(',,', ','), ''],
      ["cfListRest('a==b', '=')", () => cfListRest('a==b', '='), 'b'],
      ["cfListRest('a', '=')", () => cfListRest('a', '='), ''],
      ["cfListRest('', '=')", () => cfListRest('', '='), ''],
      ["cfListGetAt('en_US_x', 2, '_')", () => cfListGetAt('en_US_x', 2, '_'), 'US'],
      ["cfListToArray(',a,,b,', ',')", () => cfListToArray(',a,,b,', ','), ['a', 'b']],
      ["cfListToArray('x, y')", () => cfListToArray('x, y'), ['x', ' y']],
    ])('%s', (_expression, run, expected) => {
      expect(run()).toEqual(expected);
    });

    it('cfListGetAt throws for a position outside the list', () => {
      expect(() => cfListGetAt('a,b', 3)).toThrow(RangeError);
      expect(() => cfListGetAt('a,b', 0)).toThrow(RangeError);
    });
  });
});

describe('rb.ts', () => {
  const b = createResourceBundles(fixtureBundles);
  const en: RbLookup = b.rbFor('en_US');
  const de: RbLookup = b.rbFor('de_DE');
  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  describe('admin chain (resourceBundleFactory getKeyValue 120-148)', () => {
    it('reads en for en_US, which has no en_US file', () => {
      expect(en.locale).toBe('en_US');
      expect(en.rbKey('layout.addgroup')).toBe('Add Group');
      expect(en.rbKey('sitemanager.addfolder')).toBe('Folder');
    });

    it('reads de for de_DE', () => {
      expect(de.rbKey('layout.users')).toBe('Benutzer');
      expect(de.rbKey('layout.adduser')).toBe('Benutzer hinzuf&uuml;gen');
    });

    it('falls back to en_US for a key only in en', () => {
      expect(de.rbKey('layout.addgroup')).toBe('Add Group');
      expect(de.rbKey('user.address')).toBe('Address');
    });

    it('answers <key>_missing when no bundle holds the key', () => {
      expect(en.rbKey('no.such.key')).toBe('no.such.key_missing');
      expect(de.rbKey('no.such.key')).toBe('no.such.key_missing');
    });

    it('matches keys case-insensitively and keeps the caller’s key in _missing', () => {
      expect(en.rbKey('Layout.HELP')).toBe('Help');
      expect(en.rbKey('No.Such.Key')).toBe('No.Such.Key_missing');
    });

    it('reads a locale file before its language file', () => {
      const regional = createResourceBundles({
        admin: {
          dir: 'admin',
          files: {
            en: { entries: [['colour', 'Color'], ['only.en', 'English']] },
            en_GB: { entries: [['colour', 'Colour']] },
          },
        },
        coreAssets: null,
        global: null,
      });
      expect(regional.rbFor('en_GB').rbKey('colour')).toBe('Colour');
      expect(regional.rbFor('en_GB').rbKey('only.en')).toBe('English');
      expect(regional.rbFor('en_US').rbKey('colour')).toBe('Color');
    });

    it("un-doubles '' in values (resourceBundle getKeyValue)", () => {
      const quoted = createResourceBundles({
        admin: { dir: 'admin', files: { en: { entries: [['k', "it''s"]] } } },
        coreAssets: null,
        global: null,
      });
      expect(quoted.rbFor('en_US').rbKey('k')).toBe("it's");
      expect(quoted.siteRbFor('en_US').rbKey('k')).toBe("it's");
    });

    it('throws ResourceBundleLoadError for a bundle Java cannot parse (fr)', () => {
      const fr = b.rbFor('fr_FR');
      expect(() => fr.rbKey('layout.addgroup')).toThrow(ResourceBundleLoadError);
      expect(thrown(() => fr.rbKey('layout.addgroup'))).toMatchObject({
        name: 'ResourceBundleLoadError',
        message: MALFORMED_UNICODE,
        dir: 'core/mura/resourceBundle/resources',
        file: 'fr.properties',
      });
      expect(() => fr.messageFormat('{1}', 'x')).toThrow(ResourceBundleLoadError);
      expect(() => b.siteRbFor('fr_FR').rbKey('layout.help')).toThrow(ResourceBundleLoadError);
    });
  });

  describe('site chain (resource_bundles → core_assets → admin)', () => {
    const site: RbLookup = b.siteRbFor('en_US');

    it('lets the site override win over admin', () => {
      expect(site.rbKey('layout.help')).toBe('Site Help');
      expect(en.rbKey('layout.help')).toBe('Help');
    });

    it('reaches the core-assets bundle, which the admin chain lacks', () => {
      expect(site.rbKey('calendar.agendaweek')).toBe('Agenda Week');
      expect(en.rbKey('calendar.agendaweek')).toBe('calendar.agendaweek_missing');
    });

    it('reads site-only keys', () => {
      expect(site.rbKey('global.mycustomkey')).toBe('success');
    });

    it('falls through to admin, then to _missing', () => {
      expect(site.rbKey('sitemanager.addcontent')).toBe('Add Content');
      expect(site.rbKey('no.such.key')).toBe('no.such.key_missing');
    });

    it('runs the parent chain, with its en_US step, before its own en_US step (factory 122-141)', () => {
      expect(b.siteRbFor('de_DE').rbKey('layout.help')).toBe('Hilfe');
      const adminDe: BundleData = { entries: [['layout.users', 'Benutzer']] };
      const admin: BundleDir = { ...fixtureBundles.admin, files: { ...fixtureBundles.admin.files, de: adminDe } };
      const withoutDeHelp: GeneratedBundles = { ...fixtureBundles, admin };
      expect(createResourceBundles(withoutDeHelp).siteRbFor('de_DE').rbKey('layout.help')).toBe('Help');
    });

    it('reaches its own en_US step for keys no parent holds', () => {
      expect(b.siteRbFor('de_DE').rbKey('global.mycustomkey')).toBe('success');
      expect(b.siteRbFor('de_DE').rbKey('calendar.agendaweek')).toBe('Agenda Week');
      expect(b.siteRbFor('de_DE').rbKey('no.such.key')).toBe('no.such.key_missing');
    });

    it('skips an absent core-assets or global layer', () => {
      const noCoreAssets = createResourceBundles({ ...fixtureBundles, coreAssets: null }).siteRbFor('en_US');
      expect(noCoreAssets.rbKey('layout.help')).toBe('Site Help');
      expect(noCoreAssets.rbKey('calendar.agendaweek')).toBe('calendar.agendaweek_missing');
      const noGlobal = createResourceBundles({ ...fixtureBundles, global: null }).siteRbFor('en_US');
      expect(noGlobal.rbKey('layout.help')).toBe('Help');
      expect(noGlobal.rbKey('calendar.agendaweek')).toBe('Agenda Week');
    });

    it.each<[string, string]>([
      ['en_US', 'layout.help'],
      ['de_DE', 'layout.help'],
      ['de_DE', 'layout.addgroup'],
      ['en_US', 'no.such.key'],
    ])('rbKey(%s, %s) agrees with rbFor().rbKey() on the fixture and default instances', (locale, key) => {
      expect(b.rbKey(locale, key)).toBe(b.rbFor(locale).rbKey(key));
      expect(rbKey(locale, key)).toBe(rbFor(locale).rbKey(key));
    });
  });

  describe('messageFormat (resourceBundle.cfc 164-192)', () => {
    it('prepends a dummy element, so {0} is empty and {1} is the first argument', () => {
      expect(messageFormat('[{0}] Last {1} Days', '7', 'en_US')).toBe('[] Last 7 Days');
      expect(en.messageFormat(en.rbKey('opt2test.pattern'), '7')).toBe('[] Last 7 Days');
    });

    it('splits a string argument as a CFML comma list', () => {
      expect(messageFormat('{1} commented on {2}', 'Ann,Home', 'en_US')).toBe('Ann commented on Home');
      expect(messageFormat('{1} commented on {2}', ',Ann,,Home,', 'en_US')).toBe('Ann commented on Home');
    });

    it('uses an array argument as is', () => {
      expect(messageFormat('{1} commented on {2}', ['Ann,Lee', 'Home'], 'en_US')).toBe('Ann,Lee commented on Home');
    });

    it('doubles apostrophes so they stay literal', () => {
      expect(messageFormat("The email address '{1}' is not a valid format.", 'a@b.test', 'en_US')).toBe(
        "The email address 'a@b.test' is not a valid format.",
      );
    });

    it.each<[string, string, Parameters<typeof messageFormat>[1], string, string]>([
      ['a missing argument', '{1} of {2}', 'a', 'en_US', 'a of {2}'],
      ['a null argument', '{1}', [null], 'en_US', 'null'],
      ['an unformatted number', '{1}', [1234.5], 'en_US', '1,234.5'],
      ['a number element', '{1,number} items', '1234.5', 'en_US', '1,234.5 items'],
      ['a number element', '{1,number}', '1234.5', 'de_DE', '1.234,5'],
      ['an integer element, half-even', '{1,NUMBER,integer}', '2.5', 'en_US', '2'],
      ['a numeric argument', '{1,number}', 7, 'en_US', '7'],
      ['Thai digits', '{1,number}', '12', 'th_TH_TH', '๑๒'],
      ['an unknown locale as the root locale', '{1,number}', '1234.5', 'xx', '1,234.5'],
      ['Java 17 grouping', '{1,number}', '1234567', 'de_CH', '1’234’567'],
      ['a single grouping size', '{1,number}', '1234567', 'hi_IN', '1,234,567'],
      ['an element left open by a nested brace, dropped', 'a{1{', 'x', 'en_US', 'a'],
    ])('formats %s: %j', (_name, pattern, args, locale, expected) => {
      expect(messageFormat(pattern, args, locale)).toBe(expected);
    });

    it.each<[string, Parameters<typeof messageFormat>[1]]>([
      ['{1', 'x'],
      ['{x}', 'a'],
      ['{-1}', 'a'],
      ['{10000}', 'a'],
      ['{1{}}', 'a'],
      ['{1,foo}', 'a'],
      ['{1,date}', 'a'],
      ['{1,number}', 'abc'],
      ['{1, number}', '5'],
      ['{2,number}', 'a'],
    ])('throws MessageFormatError for %j with %j', (pattern, args) => {
      expect(() => messageFormat(pattern, args, 'en_US')).toThrow(MessageFormatError);
    });
  });

  describe('cf2Java and isSupportedLocale (factory 157-643, 713-719)', () => {
    it.each<[string, string]>([
      ['English (US)', 'en_US'],
      ['german (standard)', 'de_DE'],
      [' English (UK) ', 'en_GB'],
      ['thai', 'vi_VN'],
      ['korean (south korea)', 'ko_KY'],
      ['chinese', 'ch_CN'],
      ['SPANISH (ARGENTINA)', 'es_BO'],
      ['de_DE', 'de_DE'],
    ])('cf2Java(%j) is %s', (cflocale, expected) => {
      expect(cf2Java(cflocale)).toBe(expected);
    });

    it('resolves Server through the server locale', () => {
      expect(cf2Java('Server', 'English (US)')).toBe('en_US');
      expect(cf2Java('server', 'German (Standard)')).toBe('de_DE');
    });

    it('answers the server locale for an empty name', () => {
      expect(cf2Java('', 'German (Standard)')).toBe('German (Standard)');
      expect(cf2Java('  ', 'English (US)')).toBe('English (US)');
    });

    it.each<[string, boolean]>([
      ['English (US)', true],
      ['Arabic (Oman)', false],
      ['de_DE', true],
      ['xx', false],
      ['en_US_x', false],
    ])('isSupportedLocale(%j) is %s', (locale, expected) => {
      expect(isSupportedLocale(locale)).toBe(expected);
    });
  });
});

describe('default instance over the generated legacy bundles', () => {
  const legacyValue = (file: string, key: string): string | undefined => {
    const source = readFileSync(path.resolve(here, '../../..', file), 'utf8');
    const line = source.split(/\r\n|\r|\n/).find((candidate) => candidate.startsWith(`${key}=`));
    return line?.slice(key.length + 1);
  };

  it('rbFor(en_US) reads dashboard.search from core/mura/resourceBundle/resources/en.properties', () => {
    const expected = legacyValue('core/mura/resourceBundle/resources/en.properties', 'dashboard.search');
    expect(expected).toBe('Search');
    expect(rbFor('en_US').rbKey('dashboard.search')).toBe(expected);
  });

  it('siteRbFor(en_US) reads global.mycustomkey from resource_bundles/en.properties', () => {
    const expected = legacyValue('resource_bundles/en.properties', 'global.mycustomkey');
    expect(expected).toBe('success');
    expect(siteRbFor('en_US').rbKey('global.mycustomkey')).toBe(expected);
  });
});

