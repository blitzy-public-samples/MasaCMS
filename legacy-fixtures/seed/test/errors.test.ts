// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { ServiceUnavailableError, UnknownServiceError } from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';
import { failureText, idText, nameText, parseJson, printable, printableMessage } from '../src/errors.js';

const SENTINEL = 'zelda.sentinel@example.com';

describe('failureText', () => {
  it.each<[string, unknown, string]>([
    ['a printable error on one line', printable(new RangeError('Site tenant-b\n  needs 10 groups')), 'Site tenant-b needs 10 groups'],
    ['a usage error with the help pointer', printable(new Error('seed.config.json is not valid JSON'), { usage: true }), 'seed.config.json is not valid JSON (see --help)'],
    ['a Node system error', Object.assign(new Error("ENOENT: no such file or directory, open '/x'"), { code: 'ENOENT', syscall: 'open', errno: -2 }), "ENOENT: no such file or directory, open '/x'"],
    ['an unknown service', new UnknownServiceError('people'), 'No URL is configured for service people'],
    ['an unavailable service', new ServiceUnavailableError('people', Object.assign(new Error(SENTINEL), { code: 'ECONNRESET' })), 'Service people unavailable (ECONNRESET)'],
    ['an unmarked error as its class', new TypeError(SENTINEL), 'TypeError'],
    ['an unmarked error with its upper-case code', Object.assign(new Error(SENTINEL), { code: 'ERR_INVALID_ARG_TYPE' }), 'Error ERR_INVALID_ARG_TYPE'],
    ['an unmarked error without a free-text code', Object.assign(new Error(SENTINEL), { code: SENTINEL }), 'Error'],
    ['an error whose name is not an identifier as Error', Object.assign(new Error(SENTINEL), { name: 'Zelda Sentinel' }), 'Error'],
    ['a thrown string as its kind', SENTINEL, 'string'],
    ['a thrown undefined as nothing', undefined, 'nothing'],
  ])('gives %s', (_label, err, text) => {
    expect(failureText(err)).toBe(text);
  });

  it('withholds the message of anything unmarked from printableMessage', () => {
    expect([printableMessage(new Error(SENTINEL)), printableMessage(SENTINEL)]).toEqual([undefined, undefined]);
  });

  it('keeps the class, message and equality of a marked error', () => {
    const marked = printable(new RangeError('chunkRows must be a positive integer, got 0'));
    expect(marked).toBeInstanceOf(RangeError);
    expect(marked).toEqual(new RangeError('chunkRows must be a positive integer, got 0'));
    expect(Object.keys(marked)).toEqual([]);
  });
});

describe('parseJson', () => {
  it.each<[string, string, string]>([
    ['text the parser quotes', `{"email":${SENTINEL}}`, 'f.json is not valid JSON'],
    ['text broken at a known place', `{"email":"${SENTINEL}" x`, 'f.json is not valid JSON at line 1 column 39'],
    ['empty text', '', 'f.json is not valid JSON'],
  ])('throws a printable SyntaxError naming the file, never the text, for %s', (_label, text, message) => {
    let thrown: unknown;
    try {
      parseJson(text, 'f.json');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect([(thrown as Error).message, (thrown as Error).cause, printableMessage(thrown)]).toEqual([message, undefined, message]);
  });

  it('returns the parsed value', () => {
    expect(parseJson('{"seed":1}', 'f.json')).toEqual({ seed: 1 });
  });
});

describe('identifier text', () => {
  it.each<[unknown, string]>([
    ['9678B200-EEB1-5DDC-DEB98A399FCE1AA4', '"9678B200-EEB1-5DDC-DEB98A399FCE1AA4"'],
    [42, '42'],
    ['Zelda', '<string>'],
    [1.5, '<number>'],
    [null, '<null>'],
    [undefined, '<nothing>'],
  ])('idText(%j) is %s', (value, text) => {
    expect(idText(value)).toBe(text);
  });

  it.each([
    ['synthetic.survey', 'synthetic.survey'],
    ['Program_1.timesheet', 'Program_1.timesheet'],
    [SENTINEL, '<name>'],
    ['Zelda Sentinel', '<name>'],
  ])('nameText(%j) is %s', (name, text) => {
    expect(nameText(name)).toBe(text);
  });
});
