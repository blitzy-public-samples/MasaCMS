import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HARNESS_KEY_FILE,
  HARNESS_KEY_HEADER,
  HARNESS_KEY_VARIABLE,
  harnessKey,
  harnessKeyHeaders,
} from '../../src/lib/harness-key.js';

// Test value assembled at run time, not a secret.
const KEY = ['opt2', 'harness', 'unit', 'test'].join('-');

let root: string;
let env: Record<string, string>;
let keyFile: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-harness-key-'));
  env = { OPT2_STATE_DIR: root };
  keyFile = path.join(root, 'secrets', HARNESS_KEY_FILE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeKeyFile(content: string): Promise<void> {
  await mkdir(path.dirname(keyFile), { recursive: true });
  await writeFile(keyFile, content);
}

describe('harnessKey', () => {
  it('names the header, variable and secret file legacy-start.sh and Application.cfc use', () => {
    expect([HARNESS_KEY_HEADER, HARNESS_KEY_VARIABLE, HARNESS_KEY_FILE]).toEqual([
      'X-Opt2-Harness-Key',
      'OPT2_HARNESS_KEY',
      'harness-diagnostic-key',
    ]);
  });

  it('prefers the variable over the key file', async () => {
    await writeKeyFile('file-value');
    expect(harnessKey({ ...env, [HARNESS_KEY_VARIABLE]: KEY })).toBe(KEY);
  });

  it('reads the key file trimmed when the variable is unset or empty', async () => {
    await writeKeyFile(`  ${KEY}\n`);
    expect(harnessKey(env)).toBe(KEY);
    expect(harnessKey({ ...env, [HARNESS_KEY_VARIABLE]: '' })).toBe(KEY);
  });

  it.each<[string, string | undefined]>([
    ['missing', undefined],
    ['blank', ' \n'],
  ])('throws naming the variable and the file, never a value, when the file is %s', async (_label, content) => {
    if (content !== undefined) await writeKeyFile(content);
    expect(() => harnessKey(env)).toThrow(
      `no harness diagnostic key: ${HARNESS_KEY_VARIABLE} is unset and ${keyFile} is missing or empty; ` +
        'run `npm run repro:secrets` in harness/',
    );
  });

  it('rethrows a read failure other than a missing file', async () => {
    await mkdir(keyFile, { recursive: true });
    expect(() => harnessKey(env)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });
});

describe('harnessKeyHeaders', () => {
  it('carries the key in the X-Opt2-Harness-Key header', async () => {
    await writeKeyFile(KEY);
    expect(harnessKeyHeaders(env)).toEqual({ 'X-Opt2-Harness-Key': KEY });
  });
});
