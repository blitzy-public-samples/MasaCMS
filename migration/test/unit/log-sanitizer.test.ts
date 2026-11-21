// Unit tests for the log sanitizer that masks a restarted process's output on its way to the log file.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LOG_SANITIZER_SECRETS_ENV,
  MAX_PENDING_LINE,
  createLineSanitizer,
  logSanitizerPath,
  sanitizeLine,
  sanitizeStream,
  secretValues,
  takeSecrets,
} from '../../src/faults/log-sanitizer.js';

const REDACTED = '[REDACTED]';
const TRUNCATED = ' [truncated]';

/** Non-secret stand-in for a credential value, assembled at run time. */
function sentinel(n: number): string {
  return ['sentinel', 'value', `${n}`].join('-');
}

/** Non-secret stand-in for a credential shorter than 8 characters, assembled at run time. */
const short = ['ma', 'ple'].join('');

describe('secretValues', () => {
  it('collects every distinct non-empty value under credential names from every env, short ones included', () => {
    const multiLine = `${sentinel(4)}\n${sentinel(5)}`;
    const values = secretValues(
      { PG_PASSWORD: sentinel(1), PORT: '8112', OPT2_SHORT_TOKEN: short, UNSET_SECRET: undefined, EMPTY_KEY: '' },
      undefined,
      { OPT2_BRIDGE_HMAC_KEY: sentinel(2), OTHER_PASSWORD: sentinel(1), OPT2_PLAIN: sentinel(3), PEM_KEY: multiLine },
    );
    expect(values.sort()).toEqual([short, sentinel(1), sentinel(2), multiLine].sort());
  });

  it.each([
    ['PG_PASSWORD', true],
    ['MURA_DBPASSWORD', true],
    ['CFCONFIG_ADMINPASSWORD', true],
    ['MURA_APPRELOADKEY', true],
    ['OPT2_BRIDGE_HMAC_KEY', true],
    ['AWS_SECRET_ACCESS_KEY', true],
    ['OPT2_PUSH_TOKENS', true],
    ['DB_PWD', true],
    ['LEGACY_PASSWD', true],
    ['opt2_api_secret', true],
    ['TOKENIZERS_PARALLELISM', false],
    ['OPT2_TOKEN_ISSUER', false],
    ['OPT2_TOKEN_AUDIENCE', false],
    ['AWS_ACCESS_KEY_ID', false],
    ['KEYBOARD_LAYOUT', false],
    ['PWD', false],
    ['OLDPWD', false],
  ])('treats %s as credential-named: %s', (name, selected) => {
    expect(secretValues({ [name]: sentinel(1) })).toEqual(selected ? [sentinel(1)] : []);
  });

  it.each(['true', 'false', 'null', 'FALSE', 'Null'])('skips the JSON literal %s under a credential name', (value) => {
    expect(secretValues({ OPT2_FLAG_TOKEN: value, OPT2_NEAR_TOKEN: `${value}s` })).toEqual([`${value}s`]);
  });
});

describe('takeSecrets', () => {
  it('returns the handed-over list and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [LOG_SANITIZER_SECRETS_ENV]: JSON.stringify([sentinel(1)]), KEEP: 'x' };
    expect(takeSecrets(env)).toEqual([sentinel(1)]);
    expect(env).toEqual({ KEEP: 'x' });
  });

  it('returns no secrets when none were handed over', () => {
    expect(takeSecrets({})).toEqual([]);
  });

  it.each(['{"a":"b"}', '[1]', '"x"'])('rejects %s, which is not a JSON array of strings', (raw) => {
    expect(() => takeSecrets({ [LOG_SANITIZER_SECRETS_ENV]: raw })).toThrow(/must be a JSON array of strings/);
  });
});

describe('sanitizeLine', () => {
  it('masks exact secret values and credential patterns', () => {
    expect(sanitizeLine(`raw ${sentinel(1)} and password=${sentinel(2)}`, [sentinel(1)])).toBe(
      `raw ${REDACTED} and password=${REDACTED}`,
    );
  });

  it.each([
    [
      'a short secret printed as a word',
      `database rejected credential ${short}`,
      [short],
      `database rejected credential ${REDACTED}`,
    ],
    ['a short secret between punctuation', `(${short}).`, [short], `(${REDACTED}).`],
    [
      'no short secret inside a longer word',
      `${short}s x${short} ${short}_1 ${short}9`,
      [short],
      `${short}s x${short} ${short}_1 ${short}9`,
    ],
    ['a long secret inside a longer word', `pre${sentinel(1)}post`, [sentinel(1)], `pre${REDACTED}post`],
    ['overlapping secrets as one', `${sentinel(1)}-tail`, [sentinel(1), 'value-1-tail'], REDACTED],
    [
      'a short secret inside a longer secret and on its own',
      `${sentinel(1)} value`,
      [sentinel(1), 'value'],
      `${REDACTED} ${REDACTED}`,
    ],
  ])('masks %s', (_label, line, secrets, expected) => {
    expect(sanitizeLine(line, secrets)).toBe(expected);
  });
});

describe('createLineSanitizer', () => {
  it('masks a secret split across chunks once its line completes', () => {
    const lines = createLineSanitizer([sentinel(1)]);
    expect(lines.push(`first ${sentinel(1).slice(0, 6)}`)).toBe('');
    expect(lines.push(`${sentinel(1).slice(6)} done\nsecond`)).toBe(`first ${REDACTED} done\n`);
    expect(lines.push(' line\n')).toBe('second line\n');
  });

  it('masks a credential pattern split across chunks', () => {
    const lines = createLineSanitizer([]);
    expect(lines.push('password=senti')).toBe('');
    expect(lines.push('nel\r\n')).toBe(`password=${REDACTED}\r\n`);
  });

  it('masks the longest secret first, so a secret containing another is masked whole', () => {
    const longer = `${sentinel(1)}-extended`;
    const lines = createLineSanitizer([sentinel(1), longer]);
    expect(lines.push(`${longer} ${sentinel(1)}\n`)).toBe(`${REDACTED} ${REDACTED}\n`);
  });

  it('masks each line of a multi-line secret value, short lines as whole tokens', () => {
    const lines = createLineSanitizer([`${sentinel(1)}\r\n${short}\n\n${sentinel(2)}\n`]);
    expect(lines.push(`begin ${sentinel(1)}\r\n${short}\n${sentinel(2).slice(0, 5)}`)).toBe(
      `begin ${REDACTED}\r\n${REDACTED}\n`,
    );
    expect(lines.push(`${sentinel(2).slice(5)}\n${short}leaf\n\n`)).toBe(`${REDACTED}\n${short}leaf\n\n`);
  });

  const quoted = ['sentinel', '"quoted"', 'back\\slash'].join('-');
  const tabbed = ['sentinel', 'value'].join('\t');
  const shortQuoted = ['m', 'p'].join('"');
  it.each([
    ['a long secret with quotes and a backslash', quoted, `rejected ${quoted}`, `rejected ${REDACTED}`],
    ['a long secret with a control character', tabbed, `bad ${tabbed}`, `bad ${REDACTED}`],
    ['a short secret with a quote as a whole token', shortQuoted, `code ${shortQuoted} end`, `code ${REDACTED} end`],
    ['no short secret with a quote inside a longer word', shortQuoted, `code x${shortQuoted}`, `code x${shortQuoted}`],
  ])('masks the JSON-escaped form, keeping the line valid JSON: %s', (_label, secret, message, expected) => {
    const lines = createLineSanitizer([secret]);
    expect(lines.push(`${JSON.stringify({ level: 50, msg: message })}\n`)).toBe(
      `${JSON.stringify({ level: 50, msg: expected })}\n`,
    );
    expect(lines.push(`raw ${secret} end\n`)).toBe(`raw ${REDACTED} end\n`);
  });

  it('keeps a pino line with false byte-identical when TOKENIZERS_PARALLELISM=false, and masks a logged password', () => {
    const lines = createLineSanitizer(secretValues({ TOKENIZERS_PARALLELISM: 'false', OPT2_TEST_PASSWORD: sentinel(1) }));
    const flag = '{"level":30,"traceSampled":false,"msg":"ok"}\n';
    const leak = `{"level":50,"traceSampled":false,"msg":"rejected ${sentinel(1)}"}\n`;

    const masked = lines.push(`${flag}${leak}`);

    expect(masked).toBe(`${flag}{"level":50,"traceSampled":false,"msg":"rejected ${REDACTED}"}\n`);
    expect(masked.trimEnd().split('\n').map((line) => JSON.parse(line) as unknown)).toHaveLength(2);
  });

  const endingSecret = ['sentinel', 'value', 'sentinel'].join('-');

  it('keeps a line of 65,537 characters whole under the default cap and masks the secret that ends it', () => {
    const lines = createLineSanitizer([endingSecret]);
    expect(MAX_PENDING_LINE).toBe(1024 * 1024);
    expect(lines.push(`${'x'.repeat(65_537)}${endingSecret}`)).toBe('');
    expect(lines.push('\n')).toBe(`${'x'.repeat(65_537)}${REDACTED}\n`);
  });

  const cutAtCap = 'password=senti'.length - 1;
  it.each([
    ['a credential value cut by the cap', cutAtCap, [], ['password=senti', 'nel\n'], [TRUNCATED, '\n']],
    [
      'a credential pair cut by the cap after earlier words, then the next line',
      16,
      [],
      ['note pass', 'word=senti', 'nel tail\nnext password=x\n'],
      ['', `note${TRUNCATED}`, `\nnext password=${REDACTED}\n`],
    ],
    [
      'a complete secret that ends the line just past the cap',
      65_536,
      [endingSecret],
      [`${'x'.repeat(65_537)}${endingSecret}`, '\n'],
      [TRUNCATED, '\n'],
    ],
    [
      'a complete secret before the cut',
      16,
      [sentinel(1)],
      [`head ${sentinel(1)} tail`, ' more\n'],
      [`head ${REDACTED}${TRUNCATED}`, '\n'],
    ],
    [
      'the begun part of a secret containing a space',
      16,
      [`${sentinel(1)} ${sentinel(2)}`],
      [`note ${sentinel(1)} ${sentinel(2).slice(0, 4)}`, '\n'],
      [`note${TRUNCATED}`, '\n'],
    ],
    [
      'every later chunk of the truncated line, then the next line',
      16,
      [sentinel(1)],
      [
        `keep ${'x'.repeat(20)}`,
        sentinel(1).slice(0, 5),
        `${sentinel(1).slice(5)} more`,
        '\nafter ',
        `${sentinel(1)}\n`,
      ],
      [`keep${TRUNCATED}`, '', '', '\n', `after ${REDACTED}\n`],
    ],
  ])('truncates an overlong line at its last whitespace: %s', (_label, cap, secrets, chunks, outputs) => {
    const lines = createLineSanitizer(secrets, cap);
    expect(chunks.map((chunk) => lines.push(chunk))).toEqual(outputs);
    expect(lines.end()).toBe('');
  });

  it('emits nothing more at the end of input when the last line was truncated', () => {
    const lines = createLineSanitizer([], 16);
    expect(lines.push('x'.repeat(20))).toBe(TRUNCATED);
    expect(lines.push('more')).toBe('');
    expect(lines.end()).toBe('');
    expect(lines.push('fresh\n')).toBe('fresh\n');
  });

  it('masks and flushes the partial line left at the end', () => {
    const lines = createLineSanitizer([sentinel(1)]);
    expect(lines.push(`tail ${sentinel(1)}`)).toBe('');
    expect(lines.end()).toBe(`tail ${REDACTED}`);
    expect(lines.end()).toBe('');
  });
});

describe('sanitizeStream', () => {
  it('masks byte chunks, keeping a multi-byte character split across chunks whole', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on('data', (chunk: Buffer) => written.push(chunk));
    const done = sanitizeStream(input, output, [sentinel(1)]);
    const text = Buffer.from(`caf\u00e9 ${sentinel(1)}\nend`);
    input.write(text.subarray(0, 4));
    input.write(text.subarray(4, 12));
    input.end(text.subarray(12));
    await done;
    expect(Buffer.concat(written).toString('utf8')).toBe(`caf\u00e9 ${REDACTED}\nend`);
  });
});

describe('log sanitizer process', () => {
  it('logSanitizerPath is this module itself', () => {
    expect(logSanitizerPath()).toBe(fileURLToPath(new URL('../../src/faults/log-sanitizer.ts', import.meta.url)));
  });

  it('runs as the entry module: masks stdin onto stdout with the secrets from its environment', async () => {
    const child = spawn(process.execPath, [logSanitizerPath()], {
      env: { [LOG_SANITIZER_SECRETS_ENV]: JSON.stringify([sentinel(1)]) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.write(`raw ${sentinel(1)}\npassword=${sentinel(2)}\n`);
    child.stdin.end('partial');

    const [exitCode] = (await once(child, 'close')) as [number | null];

    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
    expect(exitCode).toBe(0);
    expect(Buffer.concat(stdout).toString('utf8')).toBe(`raw ${REDACTED}\npassword=${REDACTED}\npartial`);
  });
});
