// Unit tests for the source-pin reader and the JSON and Markdown report writers.
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SourcePinError, readSourcePin, readSourceSha, resetSourcePinCache } from '../../src/reports/source-pin.js';
import {
  ReportPathError,
  ensureSourceShaLine,
  readJsonReport,
  reportFilePath,
  resolveReportTarget,
  writeFileAtomic,
  writeJsonReport,
  writeMarkdownReport,
  type ReportClock,
  type ReportTarget,
} from '../../src/reports/write-report.js';

// Pass-through spies, so single tests can fail one write or one temp-file removal.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), unlink: vi.fn(actual.unlink) };
});

const PIN_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const PIN_SUBJECT = 'Increase version to 7.6.1 in package files and configuration';
const OTHER_SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO_PIN_FILE = fileURLToPath(new URL('../../../opt2/source-pin.json', import.meta.url));
const FIXED_AT = '2026-01-02T03:04:05.678Z';

const tempDirs: string[] = [];

/** Clock that always returns `iso`. */
function fixedClock(iso: string): ReportClock {
  return { now: () => new Date(iso) };
}

/** Fresh directory under the OS temp directory, removed after the test. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-migration-reports-'));
  tempDirs.push(dir);
  return dir;
}

/** Report target over a fresh temp directory with the given SHA. */
async function makeTarget(sourceSha = PIN_SHA): Promise<ReportTarget> {
  return { reportsDir: await makeTempDir(), sourceSha };
}

/** A complete pin record with `overrides` applied. */
function pinRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: PIN_SHA,
    subject: PIN_SUBJECT,
    repository: 'https://example.invalid/masa.git',
    confirmedAt: '2026-01-01T00:00:00Z',
    confirmCommand: 'check-pin --confirm',
    sourceSha: PIN_SHA,
    ...overrides,
  };
}

/** Writes `text` as `source-pin.json` in `dir` and returns its path. */
async function writePinFile(dir: string, text: string): Promise<string> {
  const file = path.join(dir, 'source-pin.json');
  await writeFile(file, text, 'utf8');
  return file;
}

/** The error `fn` throws; fails the test when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** Report target whose reports directory `reports/` does not exist yet inside a fresh temp directory. */
async function makeNestedTarget(): Promise<{ base: string; target: ReportTarget }> {
  const base = await makeTempDir();
  return { base, target: { reportsDir: path.join(base, 'reports'), sourceSha: PIN_SHA } };
}

afterEach(async () => {
  resetSourcePinCache();
  vi.mocked(writeFile).mockReset();
  vi.mocked(unlink).mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readSourcePin', () => {
  it('reads the repository pin file', () => {
    const pin = readSourcePin(REPO_PIN_FILE);
    expect(pin).toMatchObject({ sha: PIN_SHA, subject: PIN_SUBJECT, sourceSha: PIN_SHA });
    for (const key of ['repository', 'confirmedAt', 'confirmCommand'] as const) {
      expect(typeof pin[key]).toBe('string');
    }
    expect(readSourceSha(REPO_PIN_FILE)).toBe(PIN_SHA);
  });

  it('returns a frozen record', async () => {
    const file = await writePinFile(await makeTempDir(), JSON.stringify(pinRecord()));
    const pin = readSourcePin(file);
    expect(Object.isFrozen(pin)).toBe(true);
    expect(() => {
      pin.sha = OTHER_SHA;
    }).toThrow(TypeError);
  });

  it('memoises by resolved path until the cache is reset', async () => {
    const file = await writePinFile(await makeTempDir(), JSON.stringify(pinRecord()));
    const first = readSourcePin(file);
    await writePinFile(path.dirname(file), JSON.stringify(pinRecord({ sha: OTHER_SHA, sourceSha: OTHER_SHA })));

    expect(readSourcePin(path.relative(process.cwd(), file))).toBe(first);
    expect(readSourceSha(file)).toBe(PIN_SHA);

    resetSourcePinCache();
    expect(readSourceSha(file)).toBe(OTHER_SHA);
  });

  it('does not memoise a failed read', async () => {
    const file = await writePinFile(await makeTempDir(), '{');
    expect(() => readSourcePin(file)).toThrow(SourcePinError);
    await writePinFile(path.dirname(file), JSON.stringify(pinRecord()));
    expect(readSourceSha(file)).toBe(PIN_SHA);
  });

  it.each([
    { label: 'a missing file', make: (dir: string) => path.join(dir, 'absent.json'), code: 'ENOENT' },
    { label: 'a directory', make: (dir: string) => dir, code: 'EISDIR' },
  ])('rejects $label as missing or unreadable', async ({ make, code }) => {
    const file = make(await makeTempDir());
    const error = thrownBy(() => readSourcePin(file));
    expect(error).toBeInstanceOf(SourcePinError);
    expect(error).toMatchObject({ name: 'SourcePinError', message: `Source pin ${file}: missing or unreadable file` });
    expect((error as SourcePinError).cause).toMatchObject({ code });
  });

  it('rejects invalid JSON and keeps the parse error as its cause', async () => {
    const file = await writePinFile(await makeTempDir(), '{"sha": ');
    const error = thrownBy(() => readSourcePin(file));
    expect(error).toBeInstanceOf(SourcePinError);
    expect((error as SourcePinError).message).toBe(`Source pin ${file}: invalid JSON`);
    expect((error as SourcePinError).cause).toBeInstanceOf(SyntaxError);
  });

  const malformed = (shown: string): string => `malformed sha ${shown}, expected 40 lowercase hex digits`;
  it.each([
    { label: 'a null document', text: 'null', reason: malformed('undefined') },
    { label: 'an array document', text: '[]', reason: malformed('undefined') },
    { label: 'a missing sha', text: JSON.stringify(pinRecord({ sha: undefined })), reason: malformed('undefined') },
    { label: 'a numeric sha', text: JSON.stringify(pinRecord({ sha: 42 })), reason: malformed('42') },
    {
      label: 'an upper-case sha',
      text: JSON.stringify(pinRecord({ sha: PIN_SHA.toUpperCase() })),
      reason: malformed(JSON.stringify(PIN_SHA.toUpperCase())),
    },
    {
      label: 'a 39-digit sha',
      text: JSON.stringify(pinRecord({ sha: PIN_SHA.slice(1) })),
      reason: malformed(JSON.stringify(PIN_SHA.slice(1))),
    },
    {
      label: 'a sha with surrounding whitespace',
      text: JSON.stringify(pinRecord({ sha: ` ${PIN_SHA}` })),
      reason: malformed(JSON.stringify(` ${PIN_SHA}`)),
    },
    {
      label: 'a missing sourceSha',
      text: JSON.stringify(pinRecord({ sourceSha: undefined })),
      reason: `sha ${PIN_SHA} does not match sourceSha undefined`,
    },
    {
      label: 'a different sourceSha',
      text: JSON.stringify(pinRecord({ sourceSha: OTHER_SHA })),
      reason: `sha ${PIN_SHA} does not match sourceSha "${OTHER_SHA}"`,
    },
  ])('rejects $label', async ({ text, reason }) => {
    const file = await writePinFile(await makeTempDir(), text);
    const error = thrownBy(() => readSourcePin(file));
    expect(error).toBeInstanceOf(SourcePinError);
    expect((error as SourcePinError).message).toBe(`Source pin ${file}: ${reason}`);
    expect(() => readSourceSha(file)).toThrow(SourcePinError);
  });
});

describe('resolveReportTarget', () => {
  it('resolves the reports directory and reads the SHA from the pin file', async () => {
    const dir = await makeTempDir();
    const target = resolveReportTarget({ reportsDir: path.relative(process.cwd(), dir), sourceShaFile: REPO_PIN_FILE });
    expect(target).toEqual({ reportsDir: dir, sourceSha: PIN_SHA });
  });

  it('propagates a pin error', async () => {
    const dir = await makeTempDir();
    expect(() => resolveReportTarget({ reportsDir: dir, sourceShaFile: path.join(dir, 'absent.json') })).toThrow(
      SourcePinError,
    );
  });
});

describe('reportFilePath', () => {
  const root = path.join(os.tmpdir(), 'opt2-reports-root');

  it.each([
    ['report.json', 'report.json'],
    ['reconciliation/after-backfill.json', 'reconciliation/after-backfill.json'],
    ['./state-machines/finance.json', 'state-machines/finance.json'],
    ['a/../b.md', 'b.md'],
    ['..notes.md', '..notes.md'],
  ])('resolves %s inside the reports directory', (relPath, expected) => {
    expect(reportFilePath(root, relPath)).toBe(path.join(root, expected));
  });

  it('resolves a relative reports directory against the working directory', () => {
    expect(reportFilePath('reports', 'x.json')).toBe(path.resolve('reports', 'x.json'));
  });

  it('rejects an absolute report path', () => {
    const error = thrownBy(() => reportFilePath(root, '/etc/passwd'));
    expect(error).toBeInstanceOf(ReportPathError);
    expect(error).toMatchObject({ name: 'ReportPathError', message: 'Report path must be relative, got "/etc/passwd"' });
  });

  it.each(['', '.', 'a/..', '..', '../x.json', 'a/../../x.json', '../opt2-reports-root-sibling/x.json'])(
    'rejects %j as not naming a file inside the reports directory',
    (relPath) => {
      const error = thrownBy(() => reportFilePath(root, relPath));
      expect(error).toBeInstanceOf(ReportPathError);
      expect((error as ReportPathError).message).toBe(`Report path "${relPath}" does not name a file inside ${root}`);
    },
  );
});

describe('writeJsonReport', () => {
  it('writes the head keys first, then the body keys in order, as pretty JSON with a trailing newline', async () => {
    const target = await makeTarget();
    const result = await writeJsonReport(
      target,
      'reconciliation/after-backfill.json',
      { tables: ['tusers', 'tcontent'], difference: 0 },
      { clock: fixedClock(FIXED_AT), generatedBy: 'opt2-migrate reconcile' },
    );

    const file = path.join(target.reportsDir, 'reconciliation', 'after-backfill.json');
    expect(result.path).toBe(file);
    expect(Object.keys(result.report)).toEqual(['sourceSha', 'generatedBy', 'generatedAt', 'status', 'tables', 'difference']);
    expect(result.report).toEqual({
      sourceSha: PIN_SHA,
      generatedBy: 'opt2-migrate reconcile',
      generatedAt: FIXED_AT,
      status: 'generated',
      tables: ['tusers', 'tcontent'],
      difference: 0,
    });
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(result.report, null, 2)}\n`);
    expect(await readdir(path.dirname(file))).toEqual(['after-backfill.json']);
  });

  it.each([
    { label: 'neither option nor body sets them', body: {}, opts: {}, generatedBy: undefined, status: 'generated' },
    {
      label: 'only the body sets them',
      body: { status: 'pass', generatedBy: 'body-run' },
      opts: {},
      generatedBy: 'body-run',
      status: 'pass',
    },
    {
      label: 'options and body both set them',
      body: { status: 'pass', generatedBy: 'body-run' },
      opts: { status: 'fail', generatedBy: 'option-run' },
      generatedBy: 'option-run',
      status: 'fail',
    },
  ])('takes generatedBy and status from the options, then the body, when $label', async ({ body, opts, generatedBy, status }) => {
    const { report } = await writeJsonReport(await makeTarget(), 'r.json', { ...body, rows: 1 }, { ...opts, clock: fixedClock(FIXED_AT) });
    const head = generatedBy === undefined ? ['sourceSha', 'generatedAt', 'status'] : ['sourceSha', 'generatedBy', 'generatedAt', 'status'];
    expect(Object.keys(report)).toEqual([...head, 'rows']);
    expect(report.generatedBy).toBe(generatedBy);
    expect(report.status).toBe(status);
  });

  it('replaces sourceSha and generatedAt supplied in the body', async () => {
    const { report } = await writeJsonReport(
      await makeTarget(),
      'r.json',
      { sourceSha: OTHER_SHA, rows: 2, generatedAt: '1999-01-01T00:00:00.000Z' },
      { clock: fixedClock(FIXED_AT) },
    );
    expect(report).toEqual({ sourceSha: PIN_SHA, generatedAt: FIXED_AT, status: 'generated', rows: 2 });
    expect(Object.keys(report)).toEqual(['sourceSha', 'generatedAt', 'status', 'rows']);
  });

  it('stamps the current time when no clock is given', async () => {
    const before = Date.now();
    const { report } = await writeJsonReport(await makeTarget(), 'r.json', {});
    const after = Date.now();
    const stamped = Date.parse(String(report.generatedAt));
    expect(new Date(stamped).toISOString()).toBe(report.generatedAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('keeps a __proto__ body key as data', async () => {
    const target = await makeTarget();
    const body = JSON.parse('{"__proto__": {"polluted": true}, "rows": 1}') as Record<string, unknown>;
    const { path: file, report } = await writeJsonReport(target, 'r.json', body, { clock: fixedClock(FIXED_AT) });

    expect(Object.getPrototypeOf(report)).toBe(Object.prototype);
    expect(Object.hasOwn(report, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['sourceSha', 'generatedAt', 'status', '__proto__', 'rows']);
  });

  it('replaces an existing report and leaves no temp file', async () => {
    const target = await makeTarget();
    await writeJsonReport(target, 'r.json', { rows: 1 }, { clock: fixedClock(FIXED_AT) });
    const { path: file } = await writeJsonReport(target, 'r.json', { rows: 2 }, { clock: fixedClock(FIXED_AT) });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ rows: 2 });
    expect(await readdir(target.reportsDir)).toEqual(['r.json']);
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  it.each([
    ['a BigInt', { rows: 1n }],
    ['a circular reference', circular],
  ])('throws on %s before touching any file', async (_label, body) => {
    const target = await makeTarget();
    await expect(writeJsonReport(target, 'nested/r.json', body)).rejects.toThrow(TypeError);
    expect(await readdir(target.reportsDir)).toEqual([]);
  });

  it.each(['/abs/r.json', '../escape.json', ''])('rejects the report path %j without writing', async (relPath) => {
    const { base, target } = await makeNestedTarget();
    await expect(writeJsonReport(target, relPath, {})).rejects.toThrow(ReportPathError);
    expect(await readdir(base)).toEqual([]);
  });
});

describe('readJsonReport', () => {
  it('reads back a written report', async () => {
    const target = await makeTarget();
    const { report } = await writeJsonReport(target, 'reconciliation/r.json', { rows: 3 }, { clock: fixedClock(FIXED_AT) });
    const read = await readJsonReport<{ sourceSha: string; rows: number }>(target.reportsDir, 'reconciliation/r.json');
    expect(read).toEqual(report);
    expect(read?.rows).toBe(3);
  });

  it.each(['absent.json', 'absent-dir/absent.json'])('returns undefined for the missing report %s', async (relPath) => {
    expect(await readJsonReport((await makeTarget()).reportsDir, relPath)).toBeUndefined();
  });

  it('propagates invalid JSON', async () => {
    const { reportsDir } = await makeTarget();
    await writeFile(path.join(reportsDir, 'bad.json'), '{"rows": ', 'utf8');
    await expect(readJsonReport(reportsDir, 'bad.json')).rejects.toThrow(SyntaxError);
  });

  it('propagates read errors other than a missing file', async () => {
    const { reportsDir } = await makeTarget();
    await mkdir(path.join(reportsDir, 'a-directory.json'));
    await expect(readJsonReport(reportsDir, 'a-directory.json')).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it.each(['/etc/hostname', '../r.json'])('rejects the report path %j', async (relPath) => {
    await expect(readJsonReport((await makeTarget()).reportsDir, relPath)).rejects.toThrow(ReportPathError);
  });
});

describe('ensureSourceShaLine', () => {
  const line = `Source SHA: ${PIN_SHA}`;

  it.each([
    ['replaces an existing line', '# Title\n\nSource SHA: old\n\nBody\n', `# Title\n\n${line}\n\nBody\n`],
    ['replaces every existing line', 'Source SHA: a\ntext\nSource SHA: b\n', `${line}\ntext\n${line}\n`],
    ['replaces an empty value', 'Source SHA:\n', `${line}\n`],
    ['inserts after the first heading', '# Title\nBody\n## Next\n', `# Title\n\n${line}\n\nBody\n## Next\n`],
    ['drops blank lines between heading and body', '# Title\n\n\nBody', `# Title\n\n${line}\n\nBody\n`],
    ['keeps text before the first heading', 'intro\n## Heading\nBody', `intro\n## Heading\n\n${line}\n\nBody\n`],
    ['inserts after a level-6 heading', '###### Deep\nBody', `###### Deep\n\n${line}\n\nBody\n`],
    ['appends to a heading with no body', '# Title', `# Title\n\n${line}\n`],
    ['appends to a heading followed only by blank lines', '# Title\n\n\n', `# Title\n\n${line}\n`],
    ['prepends without a heading and drops leading blank lines', '\n\nBody\nMore\n', `${line}\n\nBody\nMore\n`],
    ['treats 7 hashes and a hash without a space as text', '####### seven\n#tag\n', `${line}\n\n####### seven\n#tag\n`],
    ['ignores a mention that does not start the line', 'See Source SHA: x\n', `${line}\n\nSee Source SHA: x\n`],
    ['returns only the line for empty text', '', `${line}\n`],
    ['returns only the line for blank text', '  \n\t\n', `${line}\n`],
    ['converts CRLF to LF', '# T\r\nBody\r\n', `# T\n\n${line}\n\nBody\n`],
    ['collapses trailing newlines to one', '# T\n\nSource SHA: x\n\n\n\n', `# T\n\n${line}\n`],
    ['adds a missing trailing newline', 'Source SHA: x', `${line}\n`],
  ])('%s', (_label, markdown, expected) => {
    expect(ensureSourceShaLine(markdown, PIN_SHA)).toBe(expected);
    expect(ensureSourceShaLine(expected, PIN_SHA)).toBe(expected);
  });
});

describe('writeMarkdownReport', () => {
  it('writes the markdown with its Source SHA line ensured', async () => {
    const target = await makeTarget();
    const result = await writeMarkdownReport(target, 'reconciliation/summary.md', '# Summary\r\nAll zero.');
    const expected = `# Summary\n\nSource SHA: ${PIN_SHA}\n\nAll zero.\n`;
    expect(result).toEqual({ path: path.join(target.reportsDir, 'reconciliation', 'summary.md'), text: expected });
    expect(await readFile(result.path, 'utf8')).toBe(expected);
  });

  it.each(['/abs/summary.md', '../summary.md'])('rejects the report path %j without writing', async (relPath) => {
    const { base, target } = await makeNestedTarget();
    await expect(writeMarkdownReport(target, relPath, '# x')).rejects.toThrow(ReportPathError);
    expect(await readdir(base)).toEqual([]);
  });
});

describe('writeFileAtomic', () => {
  const tempName = (base: string): RegExp => new RegExp(`^\\.${base.replaceAll('.', '\\.')}\\.${process.pid}\\.[0-9a-f-]{36}\\.tmp$`);

  it('creates missing parent directories and leaves only the target file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'a', 'b', 'c.txt');
    await writeFileAtomic(file, 'first');
    await writeFileAtomic(file, 'second');
    expect(await readFile(file, 'utf8')).toBe('second');
    expect(await readdir(path.dirname(file))).toEqual(['c.txt']);
  });

  it('removes the temp file and rethrows when the rename fails', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'taken');
    await mkdir(file);
    const error = await writeFileAtomic(file, 'x').catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ code: 'EISDIR', syscall: 'rename' });
    expect(await readdir(dir)).toEqual(['taken']);
  });

  it('rethrows the write error when no temp file was created', async () => {
    const dir = await makeTempDir();
    const failure = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    vi.mocked(writeFile).mockRejectedValueOnce(failure);

    await expect(writeFileAtomic(path.join(dir, 'report.json'), 'x')).rejects.toBe(failure);
    expect(vi.mocked(unlink)).toHaveBeenCalledTimes(1);
    const [[removed]] = vi.mocked(unlink).mock.calls as [[string]];
    expect(path.dirname(removed)).toBe(dir);
    expect(path.basename(removed)).toMatch(tempName('report.json'));
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports both errors when the temp file cannot be removed', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'taken');
    await mkdir(file);
    const cleanupFailure = Object.assign(new Error('busy'), { code: 'EBUSY' });
    vi.mocked(unlink).mockRejectedValueOnce(cleanupFailure);

    const error = await writeFileAtomic(file, 'x').catch((e: unknown) => e);
    expect(vi.mocked(unlink)).toHaveBeenCalledTimes(1);
    const [[temp]] = vi.mocked(unlink).mock.calls as [[string]];
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(`Writing ${file} failed and ${temp} was not removed`);
    expect((error as AggregateError).errors).toEqual([expect.objectContaining({ code: 'EISDIR' }), cleanupFailure]);
    expect((await readdir(dir)).sort()).toEqual([path.basename(temp), 'taken'].sort());
  });
});
