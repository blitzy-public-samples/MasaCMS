import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIN_PATH, PinError, pinSchema, pinnedSha, readPin } from '../../src/lib/pin.js';
import type { Pin } from '../../src/lib/pin.js';

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const SUBJECT = 'Increase version to 7.6.1 in package files and configuration';
const OTHER_SHA = `${SHA.slice(0, -1)}e`;

const BASE: Pin = {
  sha: SHA,
  subject: SUBJECT,
  repository: 'fixture',
  confirmedAt: '2026-06-01T00:00:00.000Z',
  confirmCommand: 'harness/src/reporting/check-pin.ts --confirm',
};

type Overrides = Partial<Record<keyof Pin, string | undefined>>;

let root: string;
let written = 0;

/** Writes `BASE` with `overrides` applied as a pin file in `dir`; a key set to undefined is omitted. Returns its path. */
async function writePin(dir: string, overrides: Overrides): Promise<string> {
  const record: Record<string, unknown> = { ...BASE, ...overrides };
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) delete record[key];
  }
  written += 1;
  const file = path.join(dir, `pin-${written}.json`);
  await writeFile(file, JSON.stringify(record), 'utf8');
  return file;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-pin-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('PIN_PATH', () => {
  it('points at the existing opt2/source-pin.json', async () => {
    expect(PIN_PATH.endsWith(path.join('opt2', 'source-pin.json'))).toBe(true);
    expect((await stat(PIN_PATH)).isFile()).toBe(true);
  });

  it('holds exactly the five pin fields', async () => {
    const record = JSON.parse(await readFile(PIN_PATH, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual(['sha', 'subject', 'repository', 'confirmedAt', 'confirmCommand']);
  });
});

describe('readPin', () => {
  it('reads the committed pin', () => {
    const pin = readPin();
    expect(pin.sha).toBe(SHA);
    expect(pin.subject).toBe(SUBJECT);
    expect(pin.repository).not.toBe('');
    expect(pin.confirmCommand).not.toBe('');
    expect(Number.isNaN(Date.parse(pin.confirmedAt))).toBe(false);
  });

  it('reads a valid five-field pin from another path field for field', async () => {
    expect(readPin({ path: await writePin(root, {}) })).toEqual(BASE);
  });

  it('tolerates an unknown key and returns the five pin fields', async () => {
    const file = path.join(root, 'extra-key.json');
    await writeFile(file, JSON.stringify({ ...BASE, sourceSha: OTHER_SHA }), 'utf8');
    expect(readPin({ path: file })).toEqual(BASE);
  });

  it.each<[string, Overrides]>([
    ['the SHA is uppercase', { sha: SHA.toUpperCase() }],
    ['the SHA has 39 characters', { sha: SHA.slice(0, 39) }],
    ['the SHA ends with LF', { sha: `${SHA}\n` }],
    ['the SHA ends with CR', { sha: `${SHA}\r` }],
    ['the SHA ends with CRLF', { sha: `${SHA}\r\n` }],
    ['the SHA ends with U+2028', { sha: `${SHA}\u2028` }],
    ['the SHA ends with U+2029', { sha: `${SHA}\u2029` }],
    ['subject is missing', { subject: undefined }],
  ])('throws PinError when %s', async (_label, overrides) => {
    const file = await writePin(root, overrides);
    expect(() => readPin({ path: file })).toThrow(PinError);
  });

  it('throws PinError for malformed JSON', async () => {
    const file = path.join(root, 'malformed.json');
    await writeFile(file, '{', 'utf8');
    expect(() => readPin({ path: file })).toThrow(PinError);
    expect(() => readPin({ path: file })).toThrow(/is not valid JSON/);
  });

  it('throws PinError for a missing file', () => {
    const file = path.join(root, 'absent.json');
    expect(() => readPin({ path: file })).toThrow(PinError);
    expect(() => readPin({ path: file })).toThrow(/cannot be read/);
  });
});

describe('pinnedSha', () => {
  it('returns the committed pin SHA', () => {
    expect(pinnedSha()).toBe(readPin().sha);
    expect(pinnedSha()).toBe(SHA);
  });

  it('honours the path option', async () => {
    const file = await writePin(root, { sha: OTHER_SHA });
    expect(pinnedSha({ path: file })).toBe(OTHER_SHA);
  });
});

describe('pinSchema', () => {
  it('accepts a valid record and rejects uppercase hex', () => {
    expect(pinSchema.safeParse(BASE).success).toBe(true);
    expect(pinSchema.safeParse({ ...BASE, sha: SHA.toUpperCase() }).success).toBe(false);
  });
});
