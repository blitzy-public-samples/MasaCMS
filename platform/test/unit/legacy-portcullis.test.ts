import { describe, expect, it } from 'vitest';
import { acfStructKeyOrder, readAcfJson, serializeAcfJson, UNREADABLE_JSON } from '../../src/legacy-compat/acf-json.js';
import {
  PORTCULLIS_EXCEPTION_FIELDS,
  PORTCULLIS_INVALID_MARKER,
  PORTCULLIS_TAG_FILTER,
  isPortcullisException,
  portcullisName,
  portcullisScan,
  type PortcullisInput,
} from '../../src/legacy-compat/index.js';
import { javaDoubleToString } from '../../src/legacy-compat/java-double.js';

/** The scope a scan leaves, later entries winning as the params merge lets them. */
function scanned(inputs: PortcullisInput[]): Record<string, unknown> {
  return Object.fromEntries(portcullisScan(inputs).entries);
}

// Each expected value is what Masa's start-up scan left in the form scope of the ACF 2023 oracle for that posted value.
const VALUE_CASES: ReadonlyArray<readonly [sent: string, scanned: string]> = [
  ["<script>alert('xss')</script>' OR 1=1--", "[INVALID]' OR 1=1--"],
  ["<script>alert(1)</script>Aaliyah", "[INVALID]Aaliyah"],
  ["Frami<img src=x onerror=alert(1)>", "Frami<img src=x [INVALID]=alert(1)>"],
  ["javascript:alert(1)", "[INVALID]alert(1)"],
  ["<script>a\nb</script>", "[INVALID]a\nb[INVALID]"],
  ["<script>a\rb</script>", "[INVALID]"],
  ["<formation>", "[INVALID]"],
  ["<scr<script>ipt>x", "<scr[INVALID]ipt>x"],
  ["<b>bold</b>", "<b>bold</b>"],
  [":expression", "[INVALID]ession"],
  ["String.fromCharCode", "[INVALID]fromCharCode"],
  ["substring.x", "sub[INVALID]x"],
  ["<SCRIPT>x</SCRIPT>", "[INVALID]"],
  ["ONLOAD=1", "[INVALID]=1"],
  ["<script", "<script"],
  ["<script/>", "[INVALID]"],
  ["</script >", "[INVALID]"],
  ["<script>a</script>b<script>c", "[INVALID]b[INVALID]c"],
  ["<scriptx>y</scriptz>", "[INVALID]"],
  ["<iframe src=x>", "[INVALID]"],
  ["<frameset><frame>", "[INVALID][INVALID]"],
  ["<style>a{}</style>", "[INVALID]"],
  ["<xss>", "[INVALID]"],
  ["<marqueexyz>", "[INVALID]"],
  ["< script>", "< script>"],
  ["<scr\nipt>", "<scr\nipt>"],
  ["<script\n>x</script>", "<script\n>x[INVALID]"],
  ["<script>x</script\n>", "[INVALID]x</script\n>"],
  ["<meta\r\n>", "<meta\r\n>"],
  ["onClic\u212a=1", "[INVALID]=1"],
  ["<\u017fcript>x", "[INVALID]x"],
  ["q\u017fs", "[INVALID]"],
  ["javascr\u0130pt:x", "javascr\u0130pt:x"],
  ["<\u0130frame>", "<\u0130frame>"],
  [" padded ", "padded"],
  ["a\u0000b", "ab"],
  ["\t x \u000b", "x"],
  [" \u00a0x\u00a0 ", "\u00a0x\u00a0"],
  ["\u3000x\u3000", "\u3000x\u3000"],
  ["a\ufffdb", "a'b"],
  ["\u2018x\u2019 \u201cy\u201d a\u2014b\u2015c\u2026", "'x' \"y\" a--b--c..."],
  [" 1 ", "1"],
  ["+3", "+3"],
  ["-", "-"],
  ["", ""],
  [" true ", "\"YES\""],
  [" false ", "\"NO\""],
  ["\" q \"", "\"q\""],
  [" [ ] ", "[]"],
  ["[[\" a \"]]", "[[\"a\"]]"],
  ["[\" \u2019 \"]", "[\"'\"]"],
  ["{\"b\":\" x \",\"a\":1,\"c\":\"1\"}", "{\"a\":1,\"b\":\" x \",\"c\":\"1\"}"],
  ["{\"A\":1,\"a\":2}", "{\"A\":2}"],
  ["{\"zz\":1,\"a\":2,\"m\":3,\"bb\":4}", "{\"zz\":1,\"bb\":4,\"a\":2,\"m\":3}"],
  ["[-0]", "[0]"],
  ["[01]", "[1]"],
  ["[-.5]", "[-0.5]"],
  ["[1.50]", "[1.5]"],
  ["[1E2]", "[100.0]"],
  ["[1e-7]", "[1.0E-7]"],
  ["[0.000001]", "[1.0E-6]"],
  ["[1.0]", "[1.0]"],
  ["[9223372036854775808]", "[9.223372036854776E18]"],
  ["[-1.0e+2]", "[-100.0]"],
  ["[2e23]", "[1.9999999999999998E23]"],
  ["[1e-400]", "[0.0]"],
  ["{a:1}", "{a:1}"],
  ["['a']", "['a']"],
  ["[1,]", "[1,]"],
  ["[.5]", "[.5]"],
  ["[1.]", "[1.]"],
  ["{\"a\":1,}", "{\"a\":1,}"],
  ["1 2", "1 2"],
  ["[TRUE]", "[TRUE]"],
  ["[undefined]", "[undefined]"],
  ["\"a\" \"b\"", "\"a\" \"b\""],
  ["[1.7976931348623157e309]", "[1.7976931348623157e309]"],
  ["[1E400]", "[1E400]"],
  ["[1e]", "\"[1e]\""],
  ["{\"a\":1e}", "\"{\\\"a\\\":1e}\""],
  ["1e", "1e"],
  ["1e+", "\"1e+\""],
  ["-.5e+", "\"-.5e+\""],
  ["[\"[ 1 ]\"]", "[\"[1]\"]"],
  ["[\" true \"]", "[\"\\\"YES\\\"\"]"],
  ["[\"[1e]\"]", "[\"\\\"[1e]\\\"\"]"],
  ["[1,\"a\",true,[\" b \"]]", "[1,\"a\",true,[\"b\"]]"],
  ["[{\"b\":\" x \",\"a\":1}]", "[{\"a\":1,\"b\":\" x \"}]"],
  ["{\"x\":[1,null]}", "{\"x\":[1,null]}"],
  ["{\"x\":null}", "{\"x\":null}"],
  ["[{\"a\":null}]", "[{\"a\":null}]"],
  ["\" null \"", "\"null\""],
  ["NULL", "NULL"],
  ["[\"a\\u0001b\"]", "[\"a\\u0001b\"]"],
  ["[\"\\b\\f\\n\\r\"]", "[\"\"]"],
  ["[\"a\\/b\"]", "[\"a/b\"]"],
  ["[\"\\u00E9x\"]", "[\"\u00e9x\"]"],
  ["[\"\\uD83D\\uDE00\"]", "[\"\ud83d\ude00\"]"],
  ["[\"\\'\"]", "[\"'\"]"],
  ["[\"\\v\"]", "[\"\\v\"]"],
  ["[\"\\x\"]", "[\"\\x\"]"],
  ["[\"\\u12\"]", "[\"\\u12\"]"],
  ["[\"a\nb\"]", "[\"a\\nb\"]"],
  ["\u000b[ 2 ]", "[2]"],
  ["[\u000b1]", "[\u000b1]"],
  ["[\b1]", "[1]"],
  ["[\f1]", "[1]"],
  ["[\"<script>\"]", "[\"[INVALID]\"]"],
  ["{\"t\":\"<b>\"}", "{\"t\":\"<b>\"}"],
  ["[\" yes \"]", "[\"yes\"]"],
  ["[\"1\"]", "[\"1\"]"],
  [
    "{\"siteid\":0,\"title\":1,\"name\":2,\"zz\":3,\"a\":4,\"m\":5,\"bb\":6,\"body\":7,\"contentid\":8,\"parentid\":9,\"type\":10,\"subtype\":11,\"filename\":12,\"summary\":13,\"x\":14}",
    "{\"zz\":3,\"bb\":6,\"contentid\":8,\"subtype\":11,\"a\":4,\"siteid\":0,\"m\":5,\"name\":2,\"parentid\":9,\"summary\":13,\"x\":14,\"title\":1,\"body\":7,\"type\":10,\"filename\":12}",
  ],
];

// Each expected scope is the url scope the ACF 2023 oracle's scan left for those query parameters.
const SCOPE_CASES: ReadonlyArray<readonly [sent: Array<[string, string]>, scope: Record<string, string>]> = [
  [[["x-y", "<script>1</script>"]], {"x-y": "<script>1</script>", "xy": "<script>1</script>"}],
  [[["m.n", "onload"]], {"m.n": "onload", "mn": "[INVALID]"}],
  [[["q-r-s", " <b>x</b> "]], {"q-r-s": "<b>x</b>", "qrs": "<b>x</b>"}],
  [[["xy", "a"], ["x-y", "b"]], {"x-y": "b", "xy": "b"}],
  [[["XY", "a"], ["x-y", "b"]], {"XY": "b", "x-y": "b"}],
  [[["x", "1"], ["amp;x", "2"]], {"x": "2"}],
  [[["X", "1"], ["amp;x", "2"]], {"X": "2"}],
  [[["&amp;k", "7"], ["amp;k", "8"]], {"k": "8"}],
  [[["amp;amp;q", "1"], ["AMP;r", "2"]], {"q": "1", "r": "2"}],
  [[["amp;1x", "y"], ["amp;form.", "x"]], {"1x": "y", "form": "x", "form.": "x"}],
  [[["_a", "1"], ["a b", "2"], ["1x", "3"], ["url.x", "4"], ["Form.q", "5"], ["urlx.y", "6"]], {"urlx.y": "6", "urlxy": "6"}],
  [[["body", "<script>x</script>"], ["a", "<script>"], ["list", " <b> "], ["\u017f", "<script>x</script>"], ["\u0131", "<script>"], ["body2", "a\u0000b"]], {"a": "<script>", "body": "<script>x</script>", "body2": "ab", "list": " <b> ", "\u017f": "<script>x</script>"}],
  [[["bodyHtml", "<script>x</script>"], ["siteid", " <script> "], ["title", "onclick"], ["name", "String.x"]], {"bodyHtml": "[INVALID]", "name": "[INVALID]x", "siteid": "[INVALID]", "title": "[INVALID]"}],
  [[["bo-dy", " onload "], ["body", "kept"]], {"bo-dy": "onload", "body": "[INVALID]"}],
];

// Each expected text is Double.toString on Java 17, which ACF 2023 prints deserialized JSON doubles with.
const DOUBLE_CASES: ReadonlyArray<readonly [value: number, text: string]> = [
  [0.0, "0.0"],
  [-0, "-0.0"],
  [1.0, "1.0"],
  [-1.0, "-1.0"],
  [100.0, "100.0"],
  [0.5, "0.5"],
  [2.5, "2.5"],
  [0.1, "0.1"],
  [0.3, "0.3"],
  [4.35, "4.35"],
  [0.3333333333333333, "0.3333333333333333"],
  [0.6666666666666666, "0.6666666666666666"],
  [10000000.0, "1.0E7"],
  [9999999.999, "9999999.999"],
  [0.001, "0.001"],
  [0.0001, "1.0E-4"],
  [0.001234, "0.001234"],
  [123456789.123, "1.23456789123E8"],
  [1000000000000000.0, "1.0E15"],
  [1e+16, "1.0E16"],
  [9007199254740992.0, "9.007199254740992E15"],
  [9007199254740994.0, "9.007199254740994E15"],
  [9.223372036854776e+18, "9.223372036854776E18"],
  [1e+21, "1.0E21"],
  [1e+22, "1.0E22"],
  [1e+23, "9.999999999999999E22"],
  [2e+23, "1.9999999999999998E23"],
  [5e-324, "4.9E-324"],
  [1e-323, "1.0E-323"],
  [2.2250738585072014e-308, "2.2250738585072014E-308"],
  [1.7976931348623157e+308, "1.7976931348623157E308"],
  [1.5e+300, "1.5E300"],
  [3e-300, "3.0E-300"],
  [1e-06, "1.0E-6"],
  [1e-07, "1.0E-7"],
  [7e-10, "7.0E-10"],
  [1.23e-18, "1.23E-18"],
  [1e-05, "1.0E-5"],
  [65536.5, "65536.5"],
  [3.0517578125e-05, "3.0517578125E-5"],
  [0.125, "0.125"],
  [8589973000.0, "8.589973E9"],
  [10000000000.0, "1.0E10"],
  [99999999999.99998, "9.999999999999998E10"],
  [1.0000000000000002, "1.0000000000000002"],
  [0.30000000000000004, "0.30000000000000004"],
  [1e+300, "1.0E300"],
  [123456789.0, "1.23456789E8"],
  [1.5e-323, "1.5E-323"],
  [1.7e-07, "1.7E-7"],
  [4503599627370498.0, "4.503599627370498E15"],
  [8687909.647460938, "8687909.647460938"],
  [7.443321375082289e+18, "7.4433213750822892E18"],
  [0.0032451738708638373, "0.0032451738708638373"],
  [1000000000000004.8, "1.0000000000000048E15"],
  [1.0000000000000047e+18, "1.00000000000000474E18"],
  [1.000000000000008e+308, "1.000000000000008E308"],
  [4.25e-28, "4.25E-28"],
  [5226854.7216796875, "5226854.7216796875"],
  [Number.NaN, 'NaN'],
  [Number.POSITIVE_INFINITY, 'Infinity'],
  [Number.NEGATIVE_INFINITY, '-Infinity'],
];

describe('portcullisScan of one value', () => {
  it.each(VALUE_CASES)('leaves %j as %j', (sent, want) => {
    expect(portcullisScan([['q1', sent]])).toStrictEqual({ entries: [['q1', want]], failed: false });
  });

  it.each([
    [`<script>${'a'.repeat(99_992)}`, `[INVALID]${'a'.repeat(99_992)}`],
    [`<script>${'a'.repeat(99_993)}`, `<script>${'a'.repeat(99_993)}`],
    [`x\uFFFD${'a'.repeat(99_999)}`, `x\uFFFD${'a'.repeat(99_999)}`],
    [` x\uFFFD${'a'.repeat(99_998)} `, `x'${'a'.repeat(99_998)}`],
    [`<xss/>${'a'.repeat(99_989)}<xss>`, `[INVALID]${'a'.repeat(99_989)}<xss>`],
  ])('filters only values of up to 100000 characters, as ACF regex functions do (case %#)', (sent, want) => {
    expect(scanned([['q1', sent]])).toStrictEqual({ q1: want });
  });
});

describe('portcullisScan of a scope', () => {
  it.each(SCOPE_CASES)('leaves %j as %j', (sent, want) => {
    expect(scanned(sent)).toStrictEqual(want);
  });

  it.each([
    ['q1', 'null'],
    ['q1', ' null '],
    ['q1', '[null]'],
    ['q1', '[1,[null]]'],
    ['q1', '["null"]'],
    ['q1', '[" null "]'],
    ['x-y', 'null'],
    ['amp;=', 'x'],
    ['amp;-', 'x'],
  ])('fails as legacy does on %s=%s, keeping only the name and NUL fixes', (key, value) => {
    const scope = portcullisScan([[key, `${value}\0`], ['other', ' <script> ']]);
    expect(scope.failed).toBe(true);
    expect(Object.fromEntries(scope.entries)).toStrictEqual({ [portcullisName(key) as string]: value, other: ' <script> ' });
  });

  it('scans a scope whose nulls the scan does not reach', () => {
    expect(
      portcullisScan([
        ['body', 'null'],
        ['list', '[null]'],
        ['q1', '{"a":null}'],
        ['q2', '[{"a":null}]'],
        ['q3', 'NULL'],
      ]).failed,
    ).toBe(false);
  });

  // Each flag follows repeated requests to the ACF 2023 oracle: true where the value, spelling or fault varied between identical requests or runs.
  it.each<[string, Array<[string, string]>, boolean, boolean]>([
    ['an array nested 255 levels, which the oracle scanned', [['q', `${'['.repeat(255)}${']'.repeat(255)}`]], false, false],
    ['an array nested 256 levels, near which the oracle failed at 510 to 579 levels between runs', [['q', `${'['.repeat(256)}${']'.repeat(256)}`]], true, true],
    ['a struct nested 600 levels, which the oracle scanned', [['q', `${'{"a":'.repeat(600)}1${'}'.repeat(600)}`]], false, false],
    ['an exception field nesting an array 600 levels, which the scan never reads', [['body', `${'['.repeat(600)}${']'.repeat(600)}`]], false, false],
    ['two names stripped onto one, values differing', [['a-b', 'one'], ['a.b', 'two']], false, true],
    ['two names stripped onto a plain name', [['ab', 'z'], ['a-b', 'one'], ['a.b', 'two']], false, true],
    ['two names stripped onto one, spellings differing', [['a-B', 'x'], ['A.b', 'x']], false, true],
    ['two names renamed onto one, values differing', [['amp;xy', 'one'], ['xyamp;', 'two']], false, true],
    ['two names renamed onto a plain name', [['xy', 'zero'], ['amp;xy', 'one'], ['xyamp;', 'two']], false, true],
    ['two names renamed onto one, spellings differing', [['amp;xY', 'one'], ['Xyamp;', 'one']], false, true],
    ['two names renamed onto one, one of them faulting', [['amp;xy', 'null'], ['xyamp;', 'ok']], false, true],
    ['two names stripped onto one, equal', [['a-b', 'x'], ['a.b', 'x']], false, false],
    ['a stripped name over a plain one', [['foo', 'x'], ['f-oo', '<script>y</script>']], false, false],
    ['a plain name under a stripped one', [['f-oo', 'x'], ['foo', '<script>y</script>']], false, false],
    ['a renamed name over a plain one', [['xy', 'zero'], ['amp;xy', 'one']], false, false],
    ['names stripped onto one beside a fault, which always fails', [['a-b', '1'], ['a.b', '2'], ['z', 'null']], true, false],
  ])('reports whether the runtime decides %s', (_label, inputs, failed, runtimeDecided) => {
    const scope = portcullisScan(inputs);
    expect({ failed: scope.failed, runtimeDecided: scope.runtimeDecided === true }).toStrictEqual({ failed, runtimeDecided });
  });

  it.each<[Array<[string, string]>, Record<string, string>]>([
    [[['foo', 'x'], ['f-oo', '<script>y</script>']], { foo: '<script>y</script>', 'f-oo': '<script>y</script>' }],
    [[['f-oo', 'x'], ['foo', '<script>y</script>']], { foo: 'x', 'f-oo': 'x' }],
    [[['foo', 'x'], ['f-oo', 'onclick']], { foo: '[INVALID]', 'f-oo': 'onclick' }],
  ])('leaves a plain name the word pass of the stripped one, as the oracle did on every request: %j', (inputs, scope) => {
    expect(scanned(inputs)).toStrictEqual(scope);
  });

  it('fails on JSON nested deeply enough to exhaust the stack, far past every depth at which the oracle failed', () => {
    const scope = portcullisScan([['q1', `${'['.repeat(100_000)}${']'.repeat(100_000)}`]]);
    expect([scope.failed, scope.runtimeDecided]).toStrictEqual([true, undefined]);
  });

  it('keeps opaque and non-text values as sent while their names follow the scan', () => {
    const struct = { a: '<script>' };
    expect(
      portcullisScan([
        ['up-load', ' <script>a.png ', true],
        ['a b', 'dropped.png', true],
        ['json', struct],
      ]),
    ).toStrictEqual({
      entries: [
        ['up-load', ' <script>a.png '],
        ['json', struct],
        ['upload', ' <script>a.png '],
      ],
      failed: false,
    });
    expect(portcullisScan([['amp;-', 'a.png', true]]).failed).toBe(true);
  });
});

describe('Portcullis names and settings', () => {
  it.each([
    ['amp;x', 'x'],
    ['AMP;amp;x', 'x'],
    ['a&amp;b', 'ab'],
    ['urlx.y', 'urlx.y'],
    ['\u017fx', '\u017fx'],
    ['&amp;x', undefined],
    ['_a', undefined],
    ['a b', undefined],
    ['1x', undefined],
    ['URL.x', undefined],
    ['.form.x', undefined],
    ['', undefined],
    ['\u0131', undefined],
  ])('keeps the name %j as %j', (name, want) => {
    expect(portcullisName(name)).toBe(want);
  });

  it.each([
    ['a', true],
    ['S', true],
    ['\u017f', true],
    ['Content', true],
    ['edit', true],
    ['objectlist7', true],
    ['bodyHtml', false],
    ['siteid', false],
    ['title', false],
    ['', false],
  ])('reads %j as an exception field: %s', (name, want) => {
    expect(isPortcullisException(name)).toBe(want);
  });

  it('carries the Portcullis and configBean settings Masa scans with', () => {
    expect(PORTCULLIS_INVALID_MARKER).toBe('[INVALID]');
    expect(PORTCULLIS_TAG_FILTER.join(',')).toBe(
      'script,object,applet,embed,form,input,layer,ilayer,frame,iframe,frameset,param,meta,base,style,xss,marquee',
    );
    expect(PORTCULLIS_EXCEPTION_FIELDS.join(',')).toBe(
      'body,source,params,objectlist1,objectlist2,objectlist3,objectlist4,objectlist5,objectlist6,objectlist7,contenteditfield,content',
    );
  });
});

describe('ACF JSON round trip', () => {
  it('tells JSON, unreadable JSON and other text apart', () => {
    expect(readAcfJson(' [1, -0, 1.5] ')).toStrictEqual([1n, 0n, 1.5]);
    expect(readAcfJson('[1e]')).toBe(UNREADABLE_JSON);
    expect(readAcfJson('1e')).toBeUndefined();
    expect(readAcfJson('[1E400]')).toBeUndefined();
  });

  it('serializes a struct in ACF key order with its first spelling of each key', () => {
    const struct = readAcfJson('{"b":[true,null],"A":"x","a":{"c":-1.0}}');
    if (struct === undefined || struct === UNREADABLE_JSON) throw new Error('expected JSON');
    expect(serializeAcfJson(struct)).toBe('{"A":{"c":-1.0},"b":[true,null]}');
    expect(acfStructKeyOrder(['zz', 'a', 'm', 'bb', 'A'])).toStrictEqual(['zz', 'bb', 'a', 'm']);
  });
});

describe('javaDoubleToString', () => {
  it.each(DOUBLE_CASES)('prints %d as %s', (value, text) => {
    expect(javaDoubleToString(value)).toBe(text);
  });
});
