/** `@/lib/cfml`: `cfEq` compares values as given; `isCompactDisplay` applies the admin request scan before the same `eq`. */
import { describe, expect, it } from 'vitest';
import { cfEq, isCompactDisplay, scanCompactDisplay } from '@/lib/cfml';

// Oracle: legacy cUsers.listUsers renders the compact layout exactly where `scanned` is true. The admin scan drops NUL
// and trims, but re-serializes a padded lowercase `true` as JSON, so `cfEq` on the unscanned value differs there.
describe("rc.compactDisplay eq 'true'", () => {
  it.each<[value: string, given: boolean, scanned: boolean]>([
    [' TRUE', true, true],
    ['TRUE ', true, true],
    [' True', true, true],
    ['\tTRUE\n', true, true],
    ['TRUE\u0001', true, true],
    ['\u0001yes', true, true],
    [' YES', true, true],
    [' 1.0 ', true, true],
    ['tr\u0000ue', false, true],
    ['y\u0000es', false, true],
    [' true', true, false],
    ['true ', true, false],
    ['\ttrue', true, false],
    ['true\u0001', true, false],
    ['\u0001true', true, false],
    ['"true"', false, false],
    ['[true]', false, false],
    [' false', false, false],
    [' FALSE', false, false],
    ['\u00a0true', false, false],
    ['true\u007f', false, false],
    [' TRUE ,x', false, false],
  ])('%j: cfEq as given %s, isCompactDisplay after the scan %s', (value, given, scanned) => {
    expect(cfEq(value, 'true')).toBe(given);
    expect(isCompactDisplay(value)).toBe(scanned);
  });
});

// Oracle: the value legacy echoes in cArch.hist links, the cArch.edit hidden fields and secure()'s login redirect.
describe('scanCompactDisplay', () => {
  it.each<[value: string, scanned: string]>([
    ['true', 'true'],
    [' TRUE', 'TRUE'],
    ['\tTRUE\n', 'TRUE'],
    ['TRUE\u0001', 'TRUE'],
    ['tr\u0000ue', 'true'],
    ['\u0001yes', 'yes'],
    [' 1.0 ', '1.0'],
    [' 1e0', '1e0'],
    ['+1 ', '+1'],
    [' 1.', '1.'],
    [' true', '"YES"'],
    ['true ', '"YES"'],
    ['\u0001true', '"YES"'],
    ['\u000btrue', '"YES"'],
    ['\u0000 true', '"YES"'],
    [' false', '"NO"'],
    ['\u000bfalse', '"NO"'],
    ['abc ', 'abc'],
    [' tRue', 'tRue'],
    ['True ', 'True'],
    ['  ', ''],
    ['', ''],
    ['"true"', '"true"'],
    ['[true]', '[true]'],
    [' "x" ', '"x"'],
    ['\u00a0true', '\u00a0true'],
    ['\u007f', '\u007f'],
    ['tr\nue', 'tr\nue'],
  ])('%j as %j, which scans to itself and reads as the raw value does', (value, scanned) => {
    expect(scanCompactDisplay(value)).toBe(scanned);
    expect(scanCompactDisplay(scanned)).toBe(scanned);
    expect(isCompactDisplay(scanned)).toBe(isCompactDisplay(value));
  });
});
