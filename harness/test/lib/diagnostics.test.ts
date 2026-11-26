import { REDACTED } from '@opt2/platform/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  MIN_SECRET_LENGTH,
  UNEXPECTED_TOKEN,
  jsonSyntaxDetail,
  safeDiagnostic,
  safeSummary,
} from '../../src/lib/diagnostics.js';
import type { EnvLike } from '../../src/lib/paths.js';

// Synthetic values, assembled at run time so no credential-shaped literal sits in the source.
const SECRET = ['Qz', 'r7', 'Wv', 'k3', 'Jx', 'p9'].join('');
const BEARER = ['ab', 'Cd', '3f', 'Gh', '5j'].join('.');

/** Every 4-code-unit slice of `text`. */
function slices(text: string): string[] {
  return Array.from({ length: Math.max(text.length - 3, 0) }, (_, i) => text.slice(i, i + 4));
}

/** Slices of SECRET and BEARER that occur in `text`. */
function leaked(text: string): string[] {
  return [...slices(SECRET), ...slices(BEARER)].filter((slice) => text.includes(slice));
}

/** The error `parse` raises for `text`; fails the test when it parses. */
function thrownBy(parse: (text: string) => unknown, text: string): Error {
  try {
    parse(text);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the parse to throw');
}

/** The error JSON.parse raises for `text`. */
function parseError(text: string): Error {
  return thrownBy(JSON.parse, text);
}

/** The YAMLParseError yaml raises for `text`, whose message ends in a code frame quoting it. */
function yamlError(text: string): Error {
  return thrownBy(parseYaml, text);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('jsonSyntaxDetail', () => {
  it.each<[string, string, string]>([
    ['an unexpected token V8 quotes with context', `{"PG_PASSWORD": ${SECRET}}`, UNEXPECTED_TOKEN],
    ['an unexpected token V8 quotes whole', SECRET, UNEXPECTED_TOKEN],
    ['an input V8 quotes without a token', 'undefined', UNEXPECTED_TOKEN],
    ['a missing separator', '{"a": 1 "b"}', "Expected ',' or '}' after property value in JSON at line 1 column 9"],
    ['a missing colon on the second line', '{\n"a" 1}', "Expected ':' after property name in JSON at line 2 column 5"],
    ['a truncated document', `{"token": "${SECRET}`, 'Unterminated string in JSON at line 1 column 24'],
    ['an empty document', '', 'Unexpected end of JSON input'],
    ['a raw control character', '{"a":"x\ny"}', 'Bad control character in string literal in JSON at line 1 column 8'],
    ['trailing text', `{"k":"v"} ${SECRET}`, 'Unexpected non-whitespace character after JSON at line 1 column 11'],
  ])('describes %s by kind and location, quoting none of the input', (_label, text, expected) => {
    const detail = jsonSyntaxDetail(parseError(text));
    expect(detail).toBe(expected);
    expect(slices(text).filter((slice) => detail.includes(slice))).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ['a position without line and column', new SyntaxError('Unexpected number in JSON at position 7'), 'Unexpected number in JSON at position 7'],
    ['an error of another form', new SyntaxError(`cannot parse ${SECRET}`), UNEXPECTED_TOKEN],
    ['a thrown non-Error', SECRET, UNEXPECTED_TOKEN],
  ])('reports %s without echoing it', (_label, err, expected) => {
    expect(jsonSyntaxDetail(err)).toBe(expected);
  });
});

describe('safeDiagnostic', () => {
  const excerpt = parseError(`{"PG_PASSWORD": ${SECRET}}`).message;
  const plain = 'harness/src/repro/up-state.ts: exit code 3, --patch-file /tmp/p.json cannot be read: ENOENT';

  it.each<[string, string, EnvLike, string]>([
    ['an env secret, inside a path too', `login failed for ${SECRET} under /srv/${SECRET}/x`, { OPT2_TEST_PASSWORD: SECRET }, `login failed for ${REDACTED} under /srv/${REDACTED}/x`],
    ['the JSON-escaped form of an env secret', JSON.stringify({ v: `${SECRET}"q` }), { APP_SECRET: `${SECRET}"q` }, `{"v":"${REDACTED}"}`],
    ['the longer of two overlapping env secrets first', `got ${SECRET}`, { A_TOKEN: SECRET, B_TOKEN: SECRET.slice(0, 8) }, `got ${REDACTED}`],
    ['an env secret of exactly the minimum length', 'got abc123', { X_TOKEN: 'abc123'.slice(0, MIN_SECRET_LENGTH) }, `got ${REDACTED}`],
    ['an env secret below the minimum length', 'got abc12', { X_TOKEN: 'abc12' }, 'got abc12'],
    ['a secret-named *_FILE variable, which holds a location', 'cannot read /srv/keys/signing.pem', { OPT2_KEY_FILE: '/srv/keys/signing.pem' }, 'cannot read /srv/keys/signing.pem'],
    ['PWD, the working directory', 'in /srv/workdir', { PWD: '/srv/workdir' }, 'in /srv/workdir'],
    ['a V8 excerpt, keeping the path prefix', `/x/up.json: is not valid JSON: ${excerpt}`, {}, `/x/up.json: is not valid JSON: ${UNEXPECTED_TOKEN}`],
    ['a V8 excerpt in a stack', `SyntaxError: ${excerpt}\n    at JSON.parse (<anonymous>)`, {}, `SyntaxError: ${UNEXPECTED_TOKEN}\n    at JSON.parse (<anonymous>)`],
    ['a Bearer credential', `request failed: Bearer ${BEARER}`, {}, `request failed: Bearer ${REDACTED}`],
    ['an Authorization header', `sent Authorization: Basic ${SECRET}`, {}, `sent Authorization: ${REDACTED}`],
    ['URL userinfo', `connect postgres://app:${SECRET}@127.0.0.1:5432/db failed`, {}, `connect postgres://${REDACTED}@127.0.0.1:5432/db failed`],
    ['a --password value', `spawn sqlcmd -U sa --password ${SECRET} -C`, {}, `spawn sqlcmd -U sa --password ${REDACTED} -C`],
    ['a quoted --token value', `run --token '${SECRET} x' --name alpha`, {}, `run --token '${REDACTED}' --name alpha`],
    ['a password= pair', `login password=${SECRET} refused`, {}, `login password=${REDACTED} refused`],
    ['a secret-named location flag', 'run --key-file /srv/k.pem', {}, 'run --key-file /srv/k.pem'],
    ['a parseArgs message naming a secret flag', "Option '--password <value>' argument missing", {}, "Option '--password <value>' argument missing"],
    ['plain text', plain, { OPT2_TEST_PASSWORD: SECRET }, plain],
  ])('masks %s, idempotently', (_label, text, env, expected) => {
    const safe = safeDiagnostic(text, env);
    expect(safe).toBe(expected);
    expect(safeDiagnostic(safe, env)).toBe(safe);
  });

  it.each<[string, string, string]>([
    ['an unclosed flow sequence', `key: [unclosed ${SECRET}\n`, 'Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1'],
    ['an unterminated quoted scalar', `a: 1\nb: "open ${SECRET}\n`, 'Missing closing "quote at line 3, column 1'],
    ['a duplicate key', `k: ${SECRET}\nk: dup\n`, 'Map keys must be unique at line 2, column 1'],
    ['a nested compact mapping', `a: b: ${SECRET}\n`, 'Nested mappings are not allowed in compact mappings at line 1, column 4'],
    ['a source line shaped like a stack frame', `${SECRET}:\n    at ${SECRET}\n  x: [\n`, 'Implicit keys need to be on a single line at line 2, column 5'],
  ])('keeps only the location of a yaml frame quoting %s', (_label, doc, location) => {
    const { message, stack = '' } = yamlError(doc);
    const frames = stack.slice(`YAMLParseError: ${message}`.length);
    const cutShort = message.slice(0, message.lastIndexOf('\n', message.lastIndexOf('^')));
    const cases: [string, string][] = [
      [message, location],
      [`/x/f.yaml is not valid YAML: ${message}`, `/x/f.yaml is not valid YAML: ${location}`],
      [stack, `YAMLParseError: ${location}${frames}`],
      [cutShort, location],
      [`Error: ${cutShort}${frames}`, `Error: ${location}${frames}`],
    ];
    for (const [text, expected] of cases) {
      const safe = safeDiagnostic(text, {});
      expect(safe).toBe(expected);
      expect(safeDiagnostic(safe, {})).toBe(safe);
      expect(leaked(safe)).toEqual([]);
    }
  });

  it('masks the secret-named values of process.env by default', () => {
    vi.stubEnv('OPT2_TEST_PASSWORD', SECRET);
    expect(safeDiagnostic(`got ${SECRET}`)).toBe(`got ${REDACTED}`);
  });

  it.each<[string, () => string]>([
    ['a text that is not a string', () => safeDiagnostic(42 as unknown as string, {})],
    [
      'an env that cannot be enumerated',
      () =>
        safeDiagnostic(
          'text',
          new Proxy({}, {
            ownKeys: () => {
              throw new Error('unreadable');
            },
          }),
        ),
    ],
  ])('returns REDACTED instead of throwing for %s', (_label, call) => {
    expect(call()).toBe(REDACTED);
  });
});

describe('safeSummary', () => {
  const env = { OPT2_TEST_PASSWORD: SECRET };

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'a check-pin finding quoting a V8 excerpt',
      { findings: [{ path: 'opt2/x.json', problem: { kind: 'unparseable', error: parseError(`{"token": ${SECRET}}`).message } }] },
      { findings: [{ path: 'opt2/x.json', problem: { kind: 'unparseable', error: UNEXPECTED_TOKEN } }] },
    ],
    [
      'a scan error quoting a tool tail',
      { verdict: 'error', error: `gitleaks exited 2: fatal: auth Bearer ${BEARER} refused` },
      { verdict: 'error', error: `gitleaks exited 2: fatal: auth Bearer ${REDACTED} refused` },
    ],
    [
      'a check-deck finding quoting a page error',
      { sections: 16, findings: [{ check: 'render-error', detail: `page error: login password=${BEARER} refused` }] },
      { sections: 16, findings: [{ check: 'render-error', detail: `page error: login password=${REDACTED} refused` }] },
    ],
    [
      'a yaml frame under an ordinary key',
      { notes: [yamlError(`k: ${BEARER}\nk: dup\n`).message] },
      { notes: ['Map keys must be unique at line 2, column 1'] },
    ],
    [
      'env secret values in every string and key',
      { dsn: `postgres://app:${SECRET}@db`, nested: [{ note: SECRET, count: 2 }, SECRET, null], [SECRET]: true },
      { dsn: `postgres://app:${REDACTED}@db`, nested: [{ note: REDACTED, count: 2 }, REDACTED, null], [REDACTED]: true },
    ],
  ])('masks %s without changing its input', (_label, summary, expected) => {
    const before = structuredClone(summary);
    const masked = safeSummary(summary, env);
    expect(masked).toEqual(expected);
    expect(summary).toEqual(before);
    expect(leaked(JSON.stringify(masked))).toEqual([]);
  });

  it.each<[string, boolean]>([
    ['error', true],
    ['Errors', true],
    ['message', true],
    ['reason', true],
    ['details', true],
    ['diagnostics', true],
    ['stderr', true],
    ['stdout', true],
    ['cause', true],
    ['stderrTail', true],
    ['errorMessage', true],
    ['pageErrors', true],
    ['routeKey', false],
    ['key', false],
    ['token', false],
    ['note', false],
  ])('treats strings at any depth under %s as diagnostics: %s', (key, diagnostic) => {
    const text = `login password=${BEARER} refused`;
    const expected = diagnostic ? `login password=${REDACTED} refused` : text;
    expect(safeSummary({ [key]: text }, {})).toEqual({ [key]: expected });
    expect(safeSummary({ [key]: [{ inner: [text] }] }, {})).toEqual({ [key]: [{ inner: [expected] }] });
  });

  it('copies only the parts that change', () => {
    const same = { routeKey: 'GET /x?key=1', key: 'abc', token: 'kept', list: [1, 'two'] };
    expect(safeSummary(same, env)).toBe(same);
    const masked = safeSummary({ same, note: SECRET }, env);
    expect(masked).toEqual({ same, note: REDACTED });
    expect(masked.same).toBe(same);
  });

  it('keeps non-plain objects and cycles as they are', () => {
    const when = new Date(0);
    const cyclic: Record<string, unknown> = { note: SECRET };
    cyclic.self = cyclic;

    const masked = safeSummary({ when, cyclic }, env);

    expect(masked.when).toBe(when);
    expect((masked.cyclic as Record<string, unknown>).note).toBe(REDACTED);
    expect((masked.cyclic as Record<string, unknown>).self).toBe(cyclic);
    expect(() => JSON.stringify(masked)).toThrow(/circular/);
  });
});
