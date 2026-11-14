/** Masa's default scriptProtect scan of the url scope, against the values the legacy oracle's favorites templates echoed. */
import { describe, expect, it } from 'vitest';
import { UrlScanError, scanUrlScope } from '../../src/domain/url-scan.js';

/** The value the scan leaves in field `name` when it alone is sent. */
function scanned(value: string, name = 'favoritename'): string | undefined {
  return scanUrlScope(new Map([[name, value]])).get(name);
}

describe('scanUrlScope', () => {
  it.each([
    ['<script>x</script>y', '[INVALID]y'],
    ['<SCRIPT src=x>', '[INVALID]'],
    ['x<iframe>', 'x[INVALID]'],
    ['<b>ok</b>', '<b>ok</b>'],
    ['a onclick b', 'a [INVALID] b'],
    ['a javascript:b', 'a [INVALID]b'],
    ['a.cookie', 'a[INVALID]'],
    ['\u2019q\u201cw\u2014e\u2026', `'q"w--e...`],
    ['\uFFFDz', "'z"],
    ['x\u2019', "x'"],
    [' \u2019 ', "'"],
    ['   ', ''],
    ['  12 ', '12'],
    ['yes ', 'yes'],
    ['true', 'true'],
    [' false ', '"NO"'],
    ['-', '-'],
    ['1.0', '1.0'],
    ['a\u0000b', 'ab'],
  ])('leaves %j as %j', (value, expected) => {
    expect(scanned(value)).toBe(expected);
  });

  it.each([
    ['[1, 2]', '[1,2]'],
    ['{"a": 1}', '{"a":1}'],
    ['"abc"', '"abc"'],
    ['"  "', '""'],
    ['[]', '[]'],
    ['{}', '{}'],
    ['{"a":null}', '{"a":null}'],
    ['[1.50, 1e3, 10000000000000000000000, "x\u2019 ", ["  y"]]', `[1.5,1000.0,1.0E22,"x'",["y"]]`],
    ['{"B":"\u2019 ", "c":[" z"]}', '{"B":"\u2019 ","c":[" z"]}'],
    ['"a\\u00e9\\/\\t"', '"a\u00e9/"'],
    ['["onclick"]', '["[INVALID]"]'],
    ['"<script>"', '"[INVALID]"'],
    ['"a<script>b"', '"a[INVALID]b"'],
    [
      '[2147483647, 2147483648, 9223372036854775807, 9223372036854775808, -0, 0.1, 100.0, 1e-5, 0.001, 12345678.9, 1.0E7, 9999999.0]',
      '[2147483647,2147483648,9223372036854775807,9.223372036854776E18,0,0.1,100.0,1.0E-5,0.001,1.23456789E7,1.0E7,9999999.0]',
    ],
    ['["12", "yes", "1.50", true, false, 12, " no "]', '["12","yes","1.50",true,false,12,"no"]'],
    ['"12"', '"12"'],
    ['"yes"', '"yes"'],
    ['{"a":1.50,"b":"\u2019","C":[1.0],"d":true,"e":"12"}', '{"a":1.5,"b":"\u2019","C":[1.0],"d":true,"e":"12"}'],
    ['"x\\u0001y\\u007f\\u2028"', '"x\\u0001y\\u007f\u2028"'],
    ['"\\u201c"', '"\\""'],
    ['{"a":{"b":[null]}}', '{"a":{"b":[null]}}'],
    ['[{"a":" x "}]', '[{"a":" x "}]'],
    ['[01]', '[1]'],
    ['[00]', '[0]'],
    ['[-01.50]', '[-1.5]'],
    ['{"a":1,"a":2}', '{"a":2}'],
    ['{"a":1,"b":2,"a":3}', '{"a":3,"b":2}'],
    ['[true, "x"] ', '[true,"x"]'],
    [' [1] ', '[1]'],
    ['[-1.5e2, 1E+2]', '[-150.0,100.0]'],
    ['"\\ud83d\\ude00"', '"\u{1F600}"'],
    ['[0.5, 1e21, 1e-7, 123456789012345678901234567890]', '[0.5,1.0E21,1.0E-7,1.2345678901234568E29]'],
    ['"a\tb"', '"a\\tb"'],
    ['[-9223372036854775808, -9223372036854775809]', '[-9223372036854775808,-9.223372036854776E18]'],
    ['[-0.0]', '[-0.0]'],
    ['{"":1}', '{"":1}'],
    ['[123.456e2]', '[12345.6]'],
    ['["[1, 2]"]', '["[1,2]"]'],
  ])('reads the JSON text %j and writes it back as %j', (value, expected) => {
    expect(scanned(value)).toBe(expected);
  });

  it.each(["'a'", '{a:1}', '[1,]', '["a",]', '[NaN]', '[Infinity]', '[1 2]', '"abc', '{"k":"v"}x', '[1.7976931348623157e309]', '[1.]', '[.5]', '[+1]', '[1e400]', '"\\x"', '"\\u12"', '[tru]', '{"a" 1}', '{"a":1 "b":2}', '{1:2}'])(
    'leaves %j, which is no JSON ColdFusion reads, as sent',
    (value) => {
      expect(scanned(value)).toBe(value);
    },
  );

  it.each(['null', '[null]', '[[null]]', ' null '])('fails on %j, whose null the scan cannot read', (value) => {
    expect(() => scanned(value)).toThrow(UrlScanError);
  });

  it('drops names ColdFusion cannot hold, removes &amp; from names, leaves the exception fields unfiltered and files a filtered value under the alphanumeric name', () => {
    const scope = scanUrlScope(
      new Map([
        ['1abc', 'x'],
        ['a b', 'x'],
        ['url.x', 'x'],
        ['', 'x'],
        ['amp;userid', 'ABC'],
        ['body', ' <script>x</script> '],
        ['user-name', ' <script>x</script> onload '],
      ]),
    );
    expect(Object.fromEntries(scope)).toEqual({
      userid: 'ABC',
      body: ' <script>x</script> ',
      'user-name': '<script>x</script> onload',
      // The tag filter's result is replaced by the word filter's of the unfiltered value, as the oracle answered for `favorite-Name`.
      username: '<script>x</script> [INVALID]',
    });
  });
});
