/** `windows1252Text` against the values Masa's SQL Server stores for text it binds as `cf_sql_varchar`. */
import { describe, expect, it } from 'vitest';
import { windows1252Text } from '../../src/legacy-compat/index.js';

const CP1252_HIGH = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

describe('windows1252Text', () => {
  it.each([
    ['ASCII and controls below 0x80', 'Plain ~!@#$%^&*() \u0000\t\u001f\u007f', 'Plain ~!@#$%^&*() \u0000\t\u001f\u007f'],
    ['Latin-1 0xA0-0xFF', '\u00a0¡ ü é ÿ', '\u00a0¡ ü é ÿ'],
    ['the 27 Windows-1252 characters of 0x80-0x9F', CP1252_HIGH, CP1252_HIGH],
    ['C1 controls, the five undefined bytes included', '\u0080\u0081\u008d\u008f\u0090\u009d\u009f', '???????'],
    ['U+0100', 'Ā', '?'],
    ['BMP characters outside the code page', '✓ 日本', '? ??'],
    ['an astral character, one ? per UTF-16 code unit', '😀', '??'],
    ['lone surrogates', '\ud83d|\ude00', '?|?'],
    ['the oracle feed name', 'QA cp üé – ✓ 日本 😀 end', 'QA cp üé – ? ?? ?? end'],
    ['the oracle category name', 'Cat ü 😀', 'Cat ü ??'],
    ['the empty string', '', ''],
  ])('stores %s as legacy does', (_label, text, stored) => {
    expect(windows1252Text(text)).toBe(stored);
    expect(windows1252Text(text)).toHaveLength(text.length);
  });
});
