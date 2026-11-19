// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** JSON text control characters as the fixture's ACF isJSON and deserializeJSON read them (oracle probe of legacy-fixtures/cfml/modules/surveys.cfc). */
import { describe, expect, it } from 'vitest';
import { cfJsonControls } from '../../src/legacy/cf-json.js';

describe('cfJsonControls', () => {
  it.each<[string, string, unknown]>([
    ['NULs, controls and spaces at its edges, which Java trims', '\u0000\u0001 [1] \u0000', [1]],
    ['a NUL after the closing bracket', '[]\u0000', []],
    ['a NUL and a C0 control inside a key', '[{"x\u0000\u0001":5}]', [{ 'x\u0000\u0001': 5 }]],
    ['raw tab, CR, LF and unit separator inside a value', '["a\tb\r\nc\u001f"]', ['a\tb\r\nc\u001f']],
    ['an escaped quote before a NUL inside a value', '["a\\"\u0000"]', ['a"\u0000']],
    ['an escaped backslash ending a value, then a control inside the next', '["a\\\\","\u0001"]', ['a\\', '\u0001']],
    ['an escaped NUL', '["\\u0000"]', ['\u0000']],
    ['a tab between tokens', '[\t{"offsetMinutes":5}]', [{ offsetMinutes: 5 }]],
  ])('reads text with %s as deserializeJSON does', (_case, text, expected) => {
    expect(JSON.parse(cfJsonControls(text))).toEqual(expected);
  });

  it.each<[string, string]>([
    ['a NUL between tokens', '[\u0000{"offsetMinutes":5}]'],
    ['a NUL before a closing brace', '[{"offsetMinutes":5\u0000}]'],
    ['a leading DEL, which Java does not trim', '\u007f[1]'],
    ['only NULs', '\u0000\u0000'],
  ])('leaves text with %s unparseable, as isJSON refuses it', (_case, text) => {
    expect(() => JSON.parse(cfJsonControls(text))).toThrow(SyntaxError);
  });
});
