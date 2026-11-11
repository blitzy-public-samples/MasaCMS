import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../src/lib/paths.js';
import { pinSchema, readPin, type Pin } from '../../src/lib/pin.js';
import {
  readJson,
  sortKeysDeep,
  stableStringify,
  writeJsonReport,
  writeMarkdown,
  type ReportOptions,
} from '../../src/lib/report.js';

// The writers go through `node:fs/promises`; wrapping writeFile, rename and rm lets a test fail one step of the swap.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const OTHER_SHA = `${SHA.slice(0, -1)}e`;
const FIXED_AT = '2026-01-02T03:04:05.000Z';
const FIXED: ReportOptions = { generatedBy: 'harness/test', clock: () => new Date(FIXED_AT) };
// Synthetic value, assembled at run time so no credential-shaped literal sits in the source.
const SECRET = ['Qz', 'r7', 'Wv', 'k3', 'Jx', 'p9'].join('');

/** 4-code-unit slices of SECRET that occur in `text`. */
function leaked(text: string): string[] {
  return Array.from({ length: SECRET.length - 3 }, (_, i) => SECRET.slice(i, i + 4)).filter((slice) => text.includes(slice));
}

let root: string;
let serial = 0;

/** Absolute path of `name` inside `subdirs` of a fresh, not yet created directory under the temp root. */
function target(name: string, ...subdirs: string[]): string {
  serial += 1;
  return path.join(root, String(serial), ...subdirs, name);
}

/** Writes `text` to a fresh temp file named `name`; returns its absolute path. */
async function fixture(name: string, text: string): Promise<string> {
  const file = target(name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}

/** Matches the temp path a writer stages `file` in: hidden, in the same directory, tagged with the pid and a UUID. */
function tempPathOf(file: string): RegExp {
  const prefix = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.`);
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\\.tmp$`);
}

/** Pin source returning the committed pin with `sha` as both `sha` and `sourceSha`. */
function pinWith(sha: string): () => Pin {
  return () => ({ ...readPin(), sha, sourceSha: sha });
}

/** Whether `key` is a canonical array index, which JavaScript enumerates ahead of every other key. */
function isArrayIndex(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === key;
}

/** Own-key lists of every object within `value`, in traversal order. */
function keyLists(value: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(value)) {
    for (const item of value) keyLists(item, out);
  } else if (value !== null && typeof value === 'object') {
    out.push(Object.keys(value));
    for (const child of Object.values(value)) keyLists(child, out);
  }
  return out;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-report-writers-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stableStringify', () => {
  it('sorts keys at every depth, keeps array order and indents by two spaces with one trailing newline', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: true, y: null }, 1], c: 'x' } })).toBe(
      [
        '{',
        '  "a": {',
        '    "c": "x",',
        '    "d": [',
        '      3,',
        '      {',
        '        "y": null,',
        '        "z": true',
        '      },',
        '      1',
        '    ]',
        '  },',
        '  "b": 1',
        '}',
        '',
      ].join('\n'),
    );
  });

  it.each<[string, unknown, string]>([
    ['a number', 42, '42\n'],
    ['a string', 'x', '"x"\n'],
    ['null', null, 'null\n'],
    ['an empty array', [], '[]\n'],
    ['an empty object', {}, '{}\n'],
  ])('renders %s on one line ending in a single newline', (_label, value, expected) => {
    expect(stableStringify(value)).toBe(expected);
  });

  it('renders Dates as ISO strings, drops undefined properties and keeps undefined array items as null', () => {
    expect(stableStringify({ kept: [undefined], gone: undefined, at: new Date(FIXED_AT) })).toBe(
      `{\n  "at": "${FIXED_AT}",\n  "kept": [\n    null\n  ]\n}\n`,
    );
  });

  it('orders names by code unit after the integer-like keys JavaScript enumerates first', () => {
    expect(stableStringify({ b: 0, 10: 0, a: 0, 2: 0, B: 0 })).toBe(
      '{\n  "2": 0,\n  "10": 0,\n  "B": 0,\n  "a": 0,\n  "b": 0\n}\n',
    );
  });

  it('keeps a "__proto__" key as data without replacing the prototype', () => {
    const input: unknown = JSON.parse('{"z":1,"__proto__":{"polluted":true}}');
    const sorted = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(sorted)).toBe(Object.prototype);
    expect(Object.keys(sorted)).toEqual(['__proto__', 'z']);
    expect(stableStringify(input)).toBe('{\n  "__proto__": {\n    "polluted": true\n  },\n  "z": 1\n}\n');
  });

  it('is unchanged by a JSON round trip for any JSON value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = stableStringify(value);
        expect(stableStringify(JSON.parse(text))).toBe(text);
        expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
      }),
    );
  });

  it('emits the non-index keys of every object in code-unit order for any JSON value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        for (const keys of keyLists(JSON.parse(stableStringify(value)))) {
          const names = keys.filter((key) => !isArrayIndex(key));
          expect(names).toEqual([...names].sort());
        }
      }),
    );
  });

  it('is independent of key insertion order for any dictionary', () => {
    const reordered = fc.dictionary(fc.string(), fc.jsonValue()).chain((dict) => {
      const entries = Object.entries(dict);
      return fc.shuffledSubarray(entries, { minLength: entries.length }).map((order) => ({ entries, order }));
    });
    fc.assert(
      fc.property(reordered, ({ entries, order }) => {
        expect(stableStringify(Object.fromEntries(order))).toBe(stableStringify(Object.fromEntries(entries)));
      }),
    );
  });
});

describe('sortKeysDeep', () => {
  it('returns new objects and arrays with sorted keys and leaves the input untouched', () => {
    const input = { b: { d: 1, c: [{ f: 1, e: 2 }] }, a: [2, 1] };
    const before = structuredClone(input);
    const sorted = sortKeysDeep(input) as typeof input;
    expect(sorted).not.toBe(input);
    expect(sorted.a).not.toBe(input.a);
    expect(sorted.b).not.toBe(input.b);
    expect(sorted.b.c[0]).not.toBe(input.b.c[0]);
    expect(Object.keys(sorted)).toEqual(['a', 'b']);
    expect(Object.keys(sorted.b)).toEqual(['c', 'd']);
    expect(Object.keys(sorted.b.c[0] ?? {})).toEqual(['e', 'f']);
    expect(sorted.a).toEqual([2, 1]);
    expect(input).toStrictEqual(before);
    expect(Object.keys(input)).toEqual(['b', 'a']);
    expect(Object.keys(input.b)).toEqual(['d', 'c']);
  });

  it('copies an array element by element in its original order', () => {
    const input = [3, 'a', null, [2, 1], { y: 1, x: 2 }];
    const sorted = sortKeysDeep(input);
    expect(sorted).not.toBe(input);
    expect(sorted).toEqual([3, 'a', null, [2, 1], { x: 2, y: 1 }]);
  });

  it('sorts the keys of a null-prototype object', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: 2 });
    expect(Object.keys(sortKeysDeep(bare) as object)).toEqual(['a', 'b']);
  });

  class Sample {
    b = 1;
    a = 2;
  }

  it.each<[string, unknown]>([
    ['zero', 0],
    ['a negative fraction', -1.5],
    ['a string', 'text'],
    ['true', true],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
    ['a Map', new Map([['b', 1], ['a', 2]])],
    ['a class instance', new Sample()],
  ])('returns %s itself', (_label, value) => {
    expect(sortKeysDeep(value)).toBe(value);
  });
});

describe('writeJsonReport', () => {
  it('stamps the pinned sourceSha, generatedBy and generatedAt and writes stable JSON', async () => {
    const file = target('stamped.json');
    const result = await writeJsonReport(file, { z: [2, 1], a: { y: 1, x: 2 } }, FIXED);
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(readPin().sha).toBe(SHA);
    expect(parsed).toEqual({
      a: { x: 2, y: 1 },
      z: [2, 1],
      sourceSha: readPin().sha,
      generatedBy: 'harness/test',
      generatedAt: FIXED_AT,
    });
    expect(raw).toBe(stableStringify(parsed));
    expect(result).toEqual({ path: file, body: parsed });
  });

  it('accepts a body that already carries the pinned sourceSha', async () => {
    const file = target('same-sha.json');
    await writeJsonReport(file, { sourceSha: SHA, n: 1 }, FIXED);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      n: 1,
      sourceSha: SHA,
      generatedBy: 'harness/test',
      generatedAt: FIXED_AT,
    });
  });

  it.each<[string, Record<string, unknown>, ReportOptions, string, string]>([
    [
      'the body over the options',
      { generatedBy: 'body-script', generatedAt: '2020-05-05T00:00:00.000Z' },
      { generatedBy: 'option-script', clock: () => new Date(FIXED_AT) },
      'body-script',
      '2020-05-05T00:00:00.000Z',
    ],
    ['the options when the body has neither', {}, FIXED, 'harness/test', FIXED_AT],
  ])('takes generatedBy and generatedAt from %s', async (_label, body, opts, generatedBy, generatedAt) => {
    const file = target('caller.json');
    await writeJsonReport(file, body, opts);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sourceSha: SHA, generatedBy, generatedAt });
  });

  it('stamps generatedAt from the system clock when neither body nor options supply it', async () => {
    const before = Date.now();
    const { body } = await writeJsonReport(target('clock.json'), {}, { generatedBy: 'harness/test' });
    const at = String(body.generatedAt);
    expect(new Date(at).toISOString()).toBe(at);
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(at)).toBeLessThanOrEqual(Date.now());
  });

  it.each<[string, string[], string]>([
    [
      'the running script relative to the repository root',
      [path.join(REPO_ROOT, 'harness', 'src', 'reporting', 'speed.ts')],
      'harness/src/reporting/speed.ts',
    ],
    ['"harness" when the running script is the repository root', [REPO_ROOT], 'harness'],
    ['"harness" when the script argument is empty', [''], 'harness'],
    ['"harness" when there is no script argument', [], 'harness'],
  ])('defaults generatedBy to %s', async (_label, script, expected) => {
    const saved = process.argv;
    process.argv = [saved[0] ?? process.execPath, ...script];
    try {
      const { body } = await writeJsonReport(target('by.json'), {}, { clock: () => new Date(FIXED_AT) });
      expect(body.generatedBy).toBe(expected);
    } finally {
      process.argv = saved;
    }
  });

  it.each<[string, unknown]>([
    ['another SHA', OTHER_SHA],
    ['the uppercase pinned SHA', SHA.toUpperCase()],
    ['an empty string', ''],
    ['null', null],
  ])('refuses a body whose sourceSha is %s and writes nothing', async (_label, sourceSha) => {
    const file = target('conflict.json', 'never');
    await expect(writeJsonReport(file, { sourceSha }, FIXED)).rejects.toThrow(
      `${file}: body.sourceSha ${JSON.stringify(sourceSha)} differs from the pinned SHA ${SHA}`,
    );
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  it('stamps and checks against an injected pin', async () => {
    const pin = pinWith(OTHER_SHA);
    const { body } = await writeJsonReport(target('injected.json'), {}, { ...FIXED, pin });
    expect(body.sourceSha).toBe(OTHER_SHA);
    const refused = target('refused.json');
    await expect(writeJsonReport(refused, { sourceSha: SHA }, { ...FIXED, pin })).rejects.toThrow(
      `differs from the pinned SHA ${OTHER_SHA}`,
    );
    expect(existsSync(refused)).toBe(false);
  });

  it('creates missing parent directories and resolves a relative path against the repository root', async () => {
    const file = target('relative.json', 'a', 'b');
    const result = await writeJsonReport(path.relative(REPO_ROOT, file), {}, FIXED);
    expect(result.path).toBe(file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(result.body);
  });

  it('writes byte-identical files for the same body in any key order under a fixed clock', async () => {
    const first = target('first.json');
    const second = target('second.json');
    await writeJsonReport(first, { b: [1, { d: 1, c: 2 }], a: 'x' }, FIXED);
    const bytes = await readFile(first);
    await writeJsonReport(first, { b: [1, { d: 1, c: 2 }], a: 'x' }, FIXED);
    await writeJsonReport(second, { a: 'x', b: [1, { c: 2, d: 1 }] }, FIXED);
    expect((await readFile(first)).equals(bytes)).toBe(true);
    expect((await readFile(second)).equals(bytes)).toBe(true);
  });
});

describe('writeMarkdown', () => {
  it('writes the title, the pinned Source SHA line, a blank line and the lines, and returns the path', async () => {
    const file = target('doc.md');
    expect(await writeMarkdown(file, 'Speed report', ['| a | b |', '|---|---|'])).toBe(file);
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines[0]).toBe('# Speed report');
    expect(lines[1]).toBe(`Source SHA: ${readPin().sha}`);
    expect(lines.slice(2)).toEqual(['', '| a | b |', '|---|---|', '']);
  });

  it.each<[string, string[], string]>([
    ['no lines', [], `# T\nSource SHA: ${SHA}\n`],
    ['trailing empty lines', ['a', '', ''], `# T\nSource SHA: ${SHA}\n\na\n`],
    ['a last line ending in newlines', ['a\n\n'], `# T\nSource SHA: ${SHA}\n\na\n`],
    ['inner blank lines', ['a', '', 'b'], `# T\nSource SHA: ${SHA}\n\na\n\nb\n`],
  ])('ends in exactly one newline with %s', async (_label, lines, expected) => {
    const file = target('end.md');
    await writeMarkdown(file, 'T', lines);
    expect(await readFile(file, 'utf8')).toBe(expected);
  });

  it('writes the Source SHA of an injected pin', async () => {
    const file = target('injected.md');
    await writeMarkdown(file, 'T', ['a'], { pin: pinWith(OTHER_SHA) });
    expect(await readFile(file, 'utf8')).toBe(`# T\nSource SHA: ${OTHER_SHA}\n\na\n`);
  });

  it('creates missing parent directories and resolves a relative path against the repository root', async () => {
    const file = target('relative.md', 'a', 'b');
    expect(await writeMarkdown(path.relative(REPO_ROOT, file), 'T', ['a'])).toBe(file);
    expect(await readFile(file, 'utf8')).toBe(`# T\nSource SHA: ${SHA}\n\na\n`);
  });
});

describe.each<[string, string, (file: string) => Promise<unknown>, string]>([
  [
    'writeJsonReport',
    'atomic.json',
    (file) => writeJsonReport(file, { n: 1 }, FIXED),
    stableStringify({ n: 1, sourceSha: SHA, generatedBy: 'harness/test', generatedAt: FIXED_AT }),
  ],
  ['writeMarkdown', 'atomic.md', (file) => writeMarkdown(file, 'T', ['a']), `# T\nSource SHA: ${SHA}\n\na\n`],
])('%s replaces its destination through a sibling temp file', (_writer, name, write, bytes) => {
  const failure = new Error('injected failure');

  /** Clears recorded calls and any one-off failure a test left unconsumed; the pass-throughs stay. */
  function resetFs(): void {
    vi.mocked(writeFile).mockReset();
    vi.mocked(rename).mockReset();
    vi.mocked(rm).mockReset();
  }

  beforeEach(resetFs);
  afterEach(resetFs);

  it('leaves only the destination, holding the exact bytes, after a write', async () => {
    const file = target(name);
    await write(file);
    expect(await readdir(path.dirname(file))).toEqual([name]);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('writes a new exclusive temp file beside an existing destination and renames it over that file', async () => {
    const file = await fixture(name, 'prior');
    const before = await stat(file);
    await write(file);
    expect(vi.mocked(rename).mock.calls).toEqual([[expect.stringMatching(tempPathOf(file)), file]]);
    const tmp = vi.mocked(rename).mock.calls[0]?.[0];
    expect(vi.mocked(writeFile).mock.calls.at(-1)).toEqual([tmp, bytes, { encoding: 'utf8', flag: 'wx' }]);
    expect((await stat(file)).ino).not.toBe(before.ino);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    expect(await readdir(path.dirname(file))).toEqual([name]);
  });

  it.each<[string, () => void]>([
    ['the rename', () => vi.mocked(rename).mockRejectedValueOnce(failure)],
    [
      'writing the temp file',
      () =>
        vi.mocked(writeFile).mockImplementationOnce(async (tmp, _text, options) => {
          const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
          await actual.writeFile(tmp, 'part', options);
          throw failure;
        }),
    ],
  ])('keeps the prior destination, removes the temp file and rethrows when %s fails', async (_step, inject) => {
    const file = await fixture(name, 'prior');
    inject();
    await expect(write(file)).rejects.toBe(failure);
    expect(await readFile(file, 'utf8')).toBe('prior');
    expect(await readdir(path.dirname(file))).toEqual([name]);
  });

  it('rejects with the original and the cleanup failure when the temp file cannot be removed', async () => {
    const file = await fixture(name, 'prior');
    const cleanup = new Error('injected cleanup failure');
    vi.mocked(rename).mockRejectedValueOnce(failure);
    vi.mocked(rm).mockRejectedValueOnce(cleanup);
    const err: unknown = await write(file).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    const tmp = String(vi.mocked(rename).mock.calls[0]?.[0]);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toEqual([failure, cleanup]);
    expect((err as AggregateError).errors[0]).toBe(failure);
    expect((err as AggregateError).message).toBe(`${file}: write failed and ${tmp} could not be removed`);
    expect(await readFile(file, 'utf8')).toBe('prior');
  });
});

describe('readJson', () => {
  const schema = z.object({ name: z.string(), count: z.number().int() });

  it('returns the parsed value when no schema is given', async () => {
    const value = { b: [1, null, 'x'], a: { c: true } };
    expect(await readJson(await fixture('plain.json', JSON.stringify(value)))).toEqual(value);
  });

  it('returns the schema output for a valid file', async () => {
    const file = await fixture('valid.json', '{"name":"n","count":2,"extra":true}');
    expect(await readJson(file, schema)).toEqual({ name: 'n', count: 2 });
  });

  it('throws an Error naming the file and the failing field when the content fails the schema', async () => {
    const file = await fixture('invalid.json', '{"name":1,"count":2}');
    const error: unknown = await readJson(file, schema).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`${file}: does not match its schema`);
    expect((error as Error).message).toContain('→ at name');
  });

  it.each<[string, string | undefined, string]>([
    ['is missing', undefined, 'cannot be read'],
    ['holds malformed JSON', '{"name":', 'is not valid JSON'],
    ['holds malformed JSON quoting a token', `{"token": ${SECRET}}`, 'is not valid JSON: Unexpected token in JSON'],
  ])('throws an Error naming the file when it %s', async (_label, text, reason) => {
    const file = text === undefined ? target('absent.json') : await fixture('malformed.json', text);
    const error: unknown = await readJson(file).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`${file}: ${reason}`);
    expect(leaked((error as Error).message)).toEqual([]);
  });

  it('resolves a relative path against the repository root', async () => {
    expect(await readJson('opt2/source-pin.json', pinSchema)).toEqual(readPin());
  });
});
