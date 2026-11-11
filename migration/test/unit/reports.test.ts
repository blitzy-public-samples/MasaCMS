// Unit tests for the source-pin reader, the JSON and Markdown report writers, report redaction and the run logs.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REDACTED } from '@opt2/platform/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RUN_LOGS,
  TRANSITION_STEP_NAMES,
  WINDOW_FLAG_THRESHOLD_MS,
  appendLogEntry,
  readLogEntries,
  summariseWindows,
  upsertLogEntry,
  type RunLogFile,
  type TransitionLogEntry,
  type WindowLogEntry,
} from '../../src/reports/append-log.js';
import { projectReportValue, redactReportMarkdown, redactReportText } from '../../src/reports/redact.js';
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
const REPO_REPORTS_DIR = fileURLToPath(new URL('../../../opt2/reports/', import.meta.url));
const REPO_GROUPS_FILE = fileURLToPath(new URL('../../../gateway/cutover/groups.json', import.meta.url));
const PLACEHOLDER_JSON = [
  'migration-order.json',
  'transitions.json',
  'windows.json',
  ...readdirSync(path.join(REPO_REPORTS_DIR, 'reconciliation'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `reconciliation/${name}`),
];
const FIXED_AT = '2026-01-02T03:04:05.678Z';

// Synthetic credential-shaped values, assembled at run time so secret scanners do not match the source.
const EMAIL = ['qa.reviewer', 'example.com'].join('@');
const TOKEN = ['oat', '7f3c', '91ab', 'e2d4'].join('-');
const JWT_LIKE = [`eyJ${'hbGciOiJub25lIn0'}`, `eyJ${'zdWIiOiJxYSJ9'}`, 'c2ln'].join('.');
const PASSWORD = ['Synthetic', 'Pass', '42'].join('-');
const PASSWORD_HASH = createHash('md5').update(PASSWORD).digest('hex').toUpperCase();
const RAW_SECRETS = [EMAIL, TOKEN, JWT_LIKE, PASSWORD, PASSWORD_HASH, PASSWORD_HASH.toLowerCase()];
const TABLE_SHA = createHash('sha256').update('tusers').digest('hex');
const FLAG_ROUTE = 'cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=flag';
const ABORT_REASON = `reconcile failed for ${EMAIL}: Bearer ${TOKEN} rejected, jwt ${JWT_LIKE}, password=${PASSWORD}`;
const MASKED_ABORT_REASON = `reconcile failed for ${REDACTED}: Bearer ${REDACTED} rejected, jwt ${REDACTED}, password=${REDACTED}`;
const DIFFERENCE = {
  kind: 'changed',
  key: `s${TOKEN.length}:${TOKEN}`,
  column: 'Password',
  legacy: PASSWORD_HASH,
  target: PASSWORD_HASH.toLowerCase(),
  occurrences: 1,
};

/** The digest the projection writes in place of a raw string. */
function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')} (${[...text].length} chars)`;
}

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
    expect(pin).toMatchObject({ sha: PIN_SHA, subject: PIN_SUBJECT });
    for (const key of ['repository', 'confirmedAt', 'confirmCommand'] as const) {
      expect(typeof pin[key]).toBe('string');
    }
    expect(readSourceSha(REPO_PIN_FILE)).toBe(PIN_SHA);
  });

  it('reads sha from a five-field record and ignores an extra sourceSha key', async () => {
    const dir = await makeTempDir();
    expect(readSourceSha(await writePinFile(dir, JSON.stringify(pinRecord())))).toBe(PIN_SHA);
    resetSourcePinCache();
    expect(readSourceSha(await writePinFile(dir, JSON.stringify(pinRecord({ sourceSha: OTHER_SHA }))))).toBe(PIN_SHA);
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
    await writePinFile(path.dirname(file), JSON.stringify(pinRecord({ sha: OTHER_SHA })));

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
      label: 'a sha with a trailing LF',
      text: JSON.stringify(pinRecord({ sha: `${PIN_SHA}\n` })),
      reason: malformed(JSON.stringify(`${PIN_SHA}\n`)),
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
    {
      label: 'the selected values carry an email and a password, which are digested',
      body: { status: `fail password=${PASSWORD}`, generatedBy: 'body-run' },
      opts: { generatedBy: `opt2-migrate run by ${EMAIL}` },
      generatedBy: digestOf(`opt2-migrate run by ${EMAIL}`),
      status: digestOf(`fail password=${PASSWORD}`),
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

  it('writes and returns the redacted body, leaving the caller object unchanged', async () => {
    const target = await makeTarget();
    const body = {
      reconciliation: { differences: [DIFFERENCE] },
      abortReason: ABORT_REASON,
      units: [{ unit: 'identity.credential', legacy: { rowCount: 3, sha256: TABLE_SHA } }],
    };
    const before = structuredClone(body);
    const { path: file, report } = await writeJsonReport(target, 'reconciliation/after-fault-x.json', body, {
      clock: fixedClock(FIXED_AT),
    });

    const text = await readFile(file, 'utf8');
    expect(body).toEqual(before);
    expect(text).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(Object.keys(report)).toEqual(['sourceSha', 'generatedAt', 'status', 'reconciliation', 'abortReason', 'units']);
    expect(report).toMatchObject({
      sourceSha: PIN_SHA,
      abortReason: MASKED_ABORT_REASON,
      units: [{ unit: 'identity.credential', legacy: { rowCount: 3, sha256: TABLE_SHA } }],
    });
    for (const secret of RAW_SECRETS) expect(text).not.toContain(secret);
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

  it('redacts the markdown and keeps its Source SHA line', async () => {
    const target = await makeTarget();
    const markdown = `# Rehearsal\n\nSource SHA: stale\n\nOperator ${EMAIL} used Bearer ${TOKEN} today.\nThe duplicate key value is (${TOKEN}).\n`;
    const expected = `# Rehearsal\n\nSource SHA: ${PIN_SHA}\n\nOperator ${REDACTED} used Bearer ${REDACTED} today.\nThe duplicate key value is (${REDACTED}).\n`;
    const result = await writeMarkdownReport(target, 'rollback-rehearsal.md', markdown);
    expect(result.text).toBe(expected);
    expect(await readFile(result.path, 'utf8')).toBe(expected);
  });

  it.each([
    [
      'values beside credential- and personal-named key cells',
      `| Field | Before |\n| --- | --- |\n| Password | ${PASSWORD} |\n| FirstName | Avery |\n| Rows | 2 |`,
      `| Field | Before |\n| --- | --- |\n| Password | ${REDACTED} |\n| FirstName | ${REDACTED} |\n| Rows | 2 |`,
    ],
    [
      'every body cell under a personal-named header, keeping the other columns',
      '| Id | Email | Rows |\n|---|:-:|--:|\n| 1 | avery.quinn | 3 |\n| 2 |  | 4 |',
      `| Id | Email | Rows |\n|---|:-:|--:|\n| 1 | ${REDACTED} | 3 |\n| 2 |  | 4 |`,
    ],
    [
      'headers written with emphasis, backticks or spaces, and rows without outer pipes',
      '**Phone number** | `Display name` | _note_\n--- | --- | ---\n202-555-0148 | Avery Quinn | kept',
      `**Phone number** | \`Display name\` | _note_\n--- | --- | ---\n${REDACTED} | ${REDACTED} | kept`,
    ],
    [
      'an escaped pipe as part of its cell, up to the blank line ending the table',
      `| Note | Password |\n|---|---|\n| a \\| b | ${PASSWORD} |\n\n| c | kept |`,
      `| Note | Password |\n|---|---|\n| a \\| b | ${REDACTED} |\n\n| c | kept |`,
    ],
  ])('masks pipe-table %s, idempotently', async (_label, table, masked) => {
    expect(redactReportMarkdown(table)).toBe(masked);
    expect(redactReportMarkdown(masked)).toBe(masked);
    const { text } = await writeMarkdownReport(await makeTarget(), 'r.md', `# Report\n\n${table}\n`);
    expect(text).toBe(`# Report\n\nSource SHA: ${PIN_SHA}\n\n${masked}\n`);
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

describe('run logs', () => {
  const HEAD = ['sourceSha', 'generatedBy', 'generatedAt', 'status'];

  /** A window entry with `overrides` applied. */
  function windowEntry(windowId: string, overrides: Partial<WindowLogEntry> = {}): WindowLogEntry {
    return {
      windowId,
      holderId: `holder-${windowId}`,
      kind: 'request',
      routeKey: 'cusers.update{type=2,action=Delete}',
      units: ['people.person', 'identity.user_account'],
      scope: { siteid: 'tenant-a', userid: windowId },
      phases: [{ phase: 'quiet', at: FIXED_AT }],
      ...overrides,
    };
  }

  /** The parsed JSON file `relPath` under `dir`. */
  async function readDoc(dir: string, relPath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(dir, relPath), 'utf8')) as Record<string, unknown>;
  }

  /** Window ids of `windows.json` under `reportsDir`, in file order. */
  async function windowIds(reportsDir: string): Promise<string[]> {
    return (await readLogEntries<WindowLogEntry>(reportsDir, 'windows.json')).map((entry) => entry.windowId);
  }

  /** Temp files left in `dir`. */
  async function tempFiles(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
  }

  it('names the transition steps of the committed transitions placeholder, in order', async () => {
    const placeholder = await readDoc(REPO_REPORTS_DIR, 'transitions.json');
    expect([...TRANSITION_STEP_NAMES]).toEqual(placeholder.steps);
  });

  it.each(['windows.json', 'transitions.json'] as const)(
    'records into the committed %s placeholder, keeping its other keys',
    async (file) => {
      const target = await makeTarget(OTHER_SHA);
      await copyFile(path.join(REPO_REPORTS_DIR, file), path.join(target.reportsDir, file));
      const placeholder = await readDoc(target.reportsDir, file);
      const { collectionKey, idKey = '', generatedBy } = RUN_LOGS[file];
      const replacement = { [idKey]: 'id-1', revision: 2 };

      await appendLogEntry(target, file, { [idKey]: 'id-1', revision: 1 });
      await upsertLogEntry(target, file, idKey, replacement, { clock: fixedClock(FIXED_AT) });

      const doc = await readDoc(target.reportsDir, file);
      const rest = (report: Record<string, unknown>): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(report).filter(([key]) => !HEAD.includes(key) && key !== collectionKey && key !== 'summary'),
        );
      expect(Object.keys(doc)).toEqual(Object.keys(placeholder));
      expect(doc).toMatchObject({ sourceSha: OTHER_SHA, generatedBy, generatedAt: FIXED_AT, status: 'recorded' });
      expect(doc[collectionKey]).toEqual([replacement]);
      expect(rest(doc)).toEqual(rest(placeholder));
    },
  );

  it('creates windows.json with the flag threshold and a summary', async () => {
    const target = await makeTarget();
    const entry = windowEntry('W1');
    await appendLogEntry(target, 'windows.json', entry, { clock: fixedClock(FIXED_AT) });

    const doc = await readDoc(target.reportsDir, 'windows.json');
    expect(Object.keys(doc)).toEqual([...HEAD, 'flagThresholdMs', 'windows', 'summary']);
    expect(doc).toMatchObject({
      generatedBy: 'migration/src/windows/',
      status: 'recorded',
      flagThresholdMs: WINDOW_FLAG_THRESHOLD_MS,
      windows: [entry],
      summary: { count: 1, byOutcome: { open: 1 }, overThreshold: 0 },
    });
  });

  it('keeps all 50 concurrent appends in call order and leaves no temp file', async () => {
    const target = await makeTarget();
    const ids = Array.from({ length: 50 }, (_, i) => `W${i}`);
    await Promise.all(ids.map((id) => appendLogEntry(target, 'windows.json', windowEntry(id))));

    expect(await windowIds(target.reportsDir)).toEqual(ids);
    expect((await readDoc(target.reportsDir, 'windows.json')).summary).toMatchObject({ count: 50 });
    expect(await tempFiles(target.reportsDir)).toEqual([]);
  });

  it('upserts concurrently by id while readers always parse, replacing an entry in place without merging', async () => {
    const target = await makeTarget();
    const ids = Array.from({ length: 20 }, (_, i) => `W${i}`);
    await Promise.all(
      ids.flatMap((id) => [
        upsertLogEntry(target, 'windows.json', 'windowId', windowEntry(id, { durationMs: 1 })),
        readLogEntries(target.reportsDir, 'windows.json'),
      ]),
    );
    const replacement = windowEntry('W7', { outcome: 'closed' });
    await upsertLogEntry(target, 'windows.json', 'windowId', replacement);

    const entries = await readLogEntries<WindowLogEntry>(target.reportsDir, 'windows.json');
    expect(entries.map((entry) => entry.windowId)).toEqual(ids);
    expect(entries[7]).toEqual(replacement);
  });

  it.each([
    { file: 'windows.json', idKey: 'windowId', id: `W:${EMAIL}`, written: digestOf(`W:${EMAIL}`) },
    { file: 'other.json', idKey: 'key', id: 's2:k1', written: digestOf('s2:k1') },
  ])('upserts $file in place by a $idKey the projection alters', async ({ file, idKey, id, written }) => {
    const target = await makeTarget();
    await appendLogEntry(target, file, { [idKey]: 'first', revision: 0 });
    await upsertLogEntry(target, file, idKey, { [idKey]: id, revision: 1 });
    await appendLogEntry(target, file, { [idKey]: 'last', revision: 2 });
    await upsertLogEntry(target, file, idKey, { [idKey]: id, revision: 3 });

    const entries = await readLogEntries<Record<string, unknown>>(target.reportsDir, file);
    expect(entries.map((entry) => entry.revision)).toEqual([0, 3, 2]);
    expect(entries[1]?.[idKey]).toBe(written);
  });

  it.each([
    {
      file: 'windows.json',
      idKey: 'windowId',
      entry: (id: string, durationMs: number): Record<string, unknown> => ({ ...windowEntry(id), durationMs }),
    },
    {
      file: 'transitions.json',
      idKey: 'transitionId',
      entry: (id: string, durationMs: number): Record<string, unknown> => ({
        transitionId: id,
        from: 'v0001',
        to: 'v0002',
        startedAt: FIXED_AT,
        setT: ['identity.credential'],
        entriesChanged: [],
        legacyWriteEntries: [],
        steps: [],
        durationMs,
      }),
    },
  ] as const)('keeps two $idKey values differing only in an email apart, each upserted in place', async ({ file, idKey, entry }) => {
    const target = await makeTarget();
    const [one = '', two = ''] = ['user-one', 'user-two'].map((user) => `X:${[user, 'example.test'].join('@')}`);
    await upsertLogEntry(target, file, idKey, entry(one, 1));
    await upsertLogEntry(target, file, idKey, entry(two, 1));
    await upsertLogEntry(target, file, idKey, entry(one, 2));

    const entries = await readLogEntries<Record<string, unknown>>(target.reportsDir, file);
    expect(entries.map((stored) => [stored[idKey], stored.durationMs])).toEqual([
      [digestOf(one), 2],
      [digestOf(two), 1],
    ]);
    expect(await readFile(path.join(target.reportsDir, file), 'utf8')).not.toContain('example.test');
  });

  it.each([
    [4000, 0],
    [5000, 0],
    [5001, 1],
    [6000, 1],
  ])('flags a window of %i ms only above the threshold (%i)', (durationMs, flagged) => {
    expect(summariseWindows([windowEntry('W', { durationMs })]).overThreshold).toBe(flagged);
  });

  it('counts windows by outcome, as open while it is unset', () => {
    const summary = summariseWindows([
      windowEntry('A'),
      windowEntry('B', { outcome: 'closed' }),
      windowEntry('C', { outcome: 'closed' }),
      windowEntry('D', { outcome: 'aborted-503' }),
    ]);
    expect(summary).toEqual({ count: 4, byOutcome: { open: 1, closed: 2, 'aborted-503': 1 }, overThreshold: 0 });
  });

  it("summarises with the file's own flag threshold", async () => {
    const target = await makeTarget();
    await writeFile(path.join(target.reportsDir, 'windows.json'), JSON.stringify({ flagThresholdMs: 3000 }), 'utf8');
    await appendLogEntry(target, 'windows.json', windowEntry('W', { durationMs: 4000 }));

    expect(await readDoc(target.reportsDir, 'windows.json')).toMatchObject({
      flagThresholdMs: 3000,
      summary: { count: 1, overThreshold: 1 },
    });
  });

  it('records an unknown log under entries and keeps its own generatedBy', async () => {
    const target = await makeTarget();
    const existing = { generatedBy: 'tool', status: 'pending-run', extra: 1 };
    await writeFile(path.join(target.reportsDir, 'other.json'), JSON.stringify(existing), 'utf8');
    await appendLogEntry(target, 'other.json', { id: 1 });

    const doc = await readDoc(target.reportsDir, 'other.json');
    expect(Object.keys(doc)).toEqual([...HEAD, 'extra', 'entries']);
    expect(doc).toMatchObject({ generatedBy: 'tool', status: 'recorded', extra: 1, entries: [{ id: 1 }] });
    expect(await readLogEntries(target.reportsDir, 'other.json')).toEqual([{ id: 1 }]);
  });

  it.each<RunLogFile | string>(['windows.json', 'transitions.json', 'other.json'])(
    'reads no entries from a missing %s',
    async (file) => {
      expect(await readLogEntries((await makeTarget()).reportsDir, file)).toEqual([]);
    },
  );

  it('rejects only the call that meets invalid JSON, and appends once the file is fixed', async () => {
    const target = await makeTarget();
    const file = path.join(target.reportsDir, 'windows.json');
    await writeFile(file, '{"windows": [', 'utf8');

    await expect(appendLogEntry(target, 'windows.json', windowEntry('bad'))).rejects.toThrow(SyntaxError);
    expect(await readFile(file, 'utf8')).toBe('{"windows": [');
    expect(await tempFiles(target.reportsDir)).toEqual([]);

    await writeFile(file, JSON.stringify({ windows: [windowEntry('kept')] }), 'utf8');
    await appendLogEntry(target, 'windows.json', windowEntry('next'));
    expect(await windowIds(target.reportsDir)).toEqual(['kept', 'next']);
  });

  it('runs a queued call after the call ahead of it fails', async () => {
    const target = await makeTarget();
    const failing: ReportClock = {
      now: () => {
        throw new Error('clock failed');
      },
    };
    const first = appendLogEntry(target, 'windows.json', windowEntry('first'), { clock: failing });
    const second = appendLogEntry(target, 'windows.json', windowEntry('second'));

    await expect(first).rejects.toThrow('clock failed');
    await second;
    expect(await windowIds(target.reportsDir)).toEqual(['second']);
    expect(await tempFiles(target.reportsDir)).toEqual([]);
  });

  it('records a transition redacted and leaves it unchanged by later appends', async () => {
    const target = await makeTarget();
    await copyFile(path.join(REPO_REPORTS_DIR, 'transitions.json'), path.join(target.reportsDir, 'transitions.json'));
    const placeholder = await readDoc(target.reportsDir, 'transitions.json');
    const transition = (transitionId: string, overrides: Partial<TransitionLogEntry> = {}): TransitionLogEntry => ({
      transitionId,
      from: 'v0001',
      to: 'v0002',
      startedAt: FIXED_AT,
      setT: ['identity.credential'],
      entriesChanged: [FLAG_ROUTE],
      legacyWriteEntries: [FLAG_ROUTE],
      steps: [{ step: 6, name: 'final-state-and-reconcile', startedAt: FIXED_AT, result: ABORT_REASON }],
      ...overrides,
    });
    const reconciliation = { differences: [DIFFERENCE], rowsImported: { 'identity.credential': 3 } };

    await appendLogEntry(target, 'transitions.json', transition('T1', { outcome: 'aborted', abortReason: ABORT_REASON, reconciliation }));
    const [recorded] = (await readDoc(target.reportsDir, 'transitions.json')).transitions as unknown[];
    await appendLogEntry(target, 'transitions.json', transition('T2'));

    const doc = await readDoc(target.reportsDir, 'transitions.json');
    expect(doc.transitions).toEqual([recorded, expect.objectContaining({ transitionId: 'T2' })]);
    expect(doc.planned).toEqual(placeholder.planned);
    expect(recorded).toMatchObject({
      abortReason: MASKED_ABORT_REASON,
      entriesChanged: [FLAG_ROUTE],
      legacyWriteEntries: [FLAG_ROUTE],
      steps: [{ result: MASKED_ABORT_REASON }],
      reconciliation: {
        differences: [{ kind: 'changed', key: digestOf(DIFFERENCE.key), column: 'Password', occurrences: 1 }],
        rowsImported: { 'identity.credential': 3 },
      },
    });
    const text = await readFile(path.join(target.reportsDir, 'transitions.json'), 'utf8');
    for (const secret of RAW_SECRETS) expect(text).not.toContain(secret);
  });
});

describe('projectReportValue', () => {
  const projectionCases = [
    {
      label: 'masks every non-null value of a credential-named field, whatever its type',
      input: {
        PasswordHash: PASSWORD_HASH,
        passwordCreated: FIXED_AT,
        accessTokenHash: TABLE_SHA,
        tokenCount: 4,
        newPassword: PASSWORD,
        apiKey: 7,
        'x-auth-token': TOKEN,
        session_id: 's-1',
        passwordSalt: 'salt',
        cookies: ['a=1'],
        credentials: { user: 'u' },
        secretKey: TOKEN,
        signingKey: TOKEN,
        hmacKey: TOKEN,
        bridgeHmacKey: TOKEN,
        OPT2_BRIDGE_HMAC_KEY: TOKEN,
        encryptionKey: TOKEN,
        sharedKey: TOKEN,
        pushKey: TOKEN,
        masterKey: TOKEN,
        clientKey: TOKEN,
        privateKeys: [TOKEN],
        password: null,
        hasPasswordSet: true,
      },
      expected: {
        PasswordHash: REDACTED,
        passwordCreated: REDACTED,
        accessTokenHash: REDACTED,
        tokenCount: REDACTED,
        newPassword: REDACTED,
        apiKey: REDACTED,
        'x-auth-token': REDACTED,
        session_id: REDACTED,
        passwordSalt: REDACTED,
        cookies: REDACTED,
        credentials: REDACTED,
        secretKey: REDACTED,
        signingKey: REDACTED,
        hmacKey: REDACTED,
        bridgeHmacKey: REDACTED,
        OPT2_BRIDGE_HMAC_KEY: REDACTED,
        encryptionKey: REDACTED,
        sharedKey: REDACTED,
        pushKey: REDACTED,
        masterKey: REDACTED,
        clientKey: REDACTED,
        privateKeys: REDACTED,
        password: null,
        hasPasswordSet: REDACTED,
      },
    },
    {
      label: 'masks no key name that names no credential: a route key is kept, other unknown strings digested',
      input: { key: 'W1', idKey: 'windowId', routeKey: FLAG_ROUTE, primaryKey: ['UserID'], sortKey: 'lastUpdate', orderingKey: 'tenant-a' },
      expected: {
        key: digestOf('W1'),
        idKey: digestOf('windowId'),
        routeKey: FLAG_ROUTE,
        primaryKey: [digestOf('UserID')],
        sortKey: digestOf('lastUpdate'),
        orderingKey: digestOf('tenant-a'),
      },
    },
    {
      label: 'keeps counts under dotted unit ids and unknown names',
      input: {
        rowsImported: { 'identity.credential': 3, 'identity.user_address': 1, 'people.person': 2 },
        byOutcome: { 'aborted-503': 1 },
        durationMs: 12,
        ok: false,
      },
      expected: {
        rowsImported: { 'identity.credential': 3, 'identity.user_address': 1, 'people.person': 2 },
        byOutcome: { 'aborted-503': 1 },
        durationMs: 12,
        ok: false,
      },
    },
    {
      label: 'digests the key and values of a difference, keeping its kind, column and count',
      input: DIFFERENCE,
      expected: {
        kind: 'changed',
        key: digestOf(DIFFERENCE.key),
        column: 'Password',
        legacy: digestOf(DIFFERENCE.legacy),
        target: digestOf(DIFFERENCE.target),
        occurrences: 1,
      },
    },
    {
      label: 'keeps the row counts and hashes of a unit report',
      input: {
        unit: 'identity.credential',
        legacySha256: TABLE_SHA,
        legacy: { rowCount: 3, sha256: TABLE_SHA },
        target: { rowCount: 3, manifestSha256: TABLE_SHA },
      },
      expected: {
        unit: 'identity.credential',
        legacySha256: TABLE_SHA,
        legacy: { rowCount: 3, sha256: TABLE_SHA },
        target: { rowCount: 3, manifestSha256: TABLE_SHA },
      },
    },
    {
      label: 'digests strings, dates and bytes anywhere under a raw-value field',
      input: {
        before: { UserName: 'qa_member', tags: ['x'], Password: PASSWORD, LastLogin: new Date(FIXED_AT), size: 3 },
        row: Buffer.from('abc'),
      },
      expected: {
        before: { UserName: digestOf('qa_member'), tags: [digestOf('x')], Password: REDACTED, LastLogin: digestOf(FIXED_AT), size: 3 },
        row: `sha256:${createHash('sha256').update('abc').digest('hex')} (3 bytes)`,
      },
    },
    {
      label: 'keeps only hash-shaped hash-named strings, digests and the placeholder under a raw-value field',
      input: {
        row: { rowHash: TABLE_SHA, sourceSha: PIN_SHA, checksum: 'c1', manifestHash: TABLE_SHA, note: digestOf('x'), masked: REDACTED },
      },
      expected: {
        row: {
          rowHash: TABLE_SHA,
          sourceSha: PIN_SHA,
          checksum: digestOf('c1'),
          manifestHash: digestOf(TABLE_SHA),
          note: digestOf('x'),
          masked: REDACTED,
        },
      },
    },
    {
      label: 'redacts email, bearer, JWT and password text in free-text fields',
      input: { abortReason: ABORT_REASON, steps: [{ step: 6, result: ABORT_REASON }] },
      expected: { abortReason: MASKED_ABORT_REASON, steps: [{ step: 6, result: MASKED_ABORT_REASON }] },
    },
    {
      label: 'masks database value echoes in free-text fields',
      input: { error: `Cannot insert duplicate key in object 'dbo.toauthtokens'. The duplicate key value is (${TOKEN}).` },
      expected: { error: `Cannot insert duplicate key in object 'dbo.toauthtokens'. The duplicate key value is (${REDACTED}).` },
    },
    {
      label: 'keeps route keys under route fields and redacts their query values elsewhere',
      input: {
        routeKey: FLAG_ROUTE,
        entriesChanged: [FLAG_ROUTE, 'admin:cusers.update{type=2,action=add}'],
        legacyWriteEntries: [FLAG_ROUTE],
        route: 'not a route key?token=abc',
        note: `moved ${FLAG_ROUTE}`,
      },
      expected: {
        routeKey: FLAG_ROUTE,
        entriesChanged: [FLAG_ROUTE, 'admin:cusers.update{type=2,action=add}'],
        legacyWriteEntries: [FLAG_ROUTE],
        route: digestOf('not a route key?token=abc'),
        note: `moved ${FLAG_ROUTE.replace('=flag', `=${REDACTED}`)}`,
      },
    },
    {
      label: 'masks a credential hash held under a raw-value field',
      input: {
        differences: [{ column: 'PasswordHash', before: { PasswordHash: PASSWORD_HASH, rowCount: 1 }, after: { PasswordHash: 'changed' } }],
      },
      expected: {
        differences: [{ column: 'PasswordHash', before: { PasswordHash: REDACTED, rowCount: 1 }, after: { PasswordHash: REDACTED } }],
      },
    },
    {
      label: 'digests personal values, numbers and flags included, and treats an object beneath one as raw data',
      input: {
        orphanDetails: [
          {
            firstName: 'Avery',
            lastName: 'Quinn',
            phone: '202-555-0148',
            email: EMAIL,
            zip: 12345,
            isEmailVerified: true,
            address: { street: 'Main', houseNumber: 5 },
          },
        ],
      },
      expected: {
        orphanDetails: [
          {
            firstName: digestOf('Avery'),
            lastName: digestOf('Quinn'),
            phone: digestOf('202-555-0148'),
            email: digestOf(EMAIL),
            zip: digestOf('12345'),
            isEmailVerified: digestOf('true'),
            address: { street: digestOf('Main'), houseNumber: 5 },
          },
        ],
      },
    },
    {
      label: 'digests unknown strings at any depth and keeps their numbers, flags and nulls',
      input: { extra: { label: 'Avery', nested: [{ caption: 'Quinn', count: 2, ok: true, none: null }] } },
      expected: { extra: { label: digestOf('Avery'), nested: [{ caption: digestOf('Quinn'), count: 2, ok: true, none: null }] } },
    },
    {
      label: 'digests a URL or a token-bearing key under a route field and keeps a cut-over route key',
      input: {
        route: `https://localhost/reset?token=${TOKEN}`,
        routeKey: 'admin:cusers.update{type=2,action=update}',
        entryPoints: [`api:/reset?token=${TOKEN}`, FLAG_ROUTE],
        appliesTo: ['cusers.update{type=2,action=Delete}', `cusers.update?email=${EMAIL}`],
      },
      expected: {
        route: digestOf(`https://localhost/reset?token=${TOKEN}`),
        routeKey: 'admin:cusers.update{type=2,action=update}',
        entryPoints: [digestOf(`api:/reset?token=${TOKEN}`), FLAG_ROUTE],
        appliesTo: ['cusers.update{type=2,action=Delete}', digestOf(`cusers.update?email=${EMAIL}`)],
      },
    },
    {
      label: 'keeps identifiers redaction leaves unchanged and digests the others',
      input: {
        windowId: `W:${EMAIL}`,
        holderId: 'transition:T1',
        tenantId: 'tenant-a',
        scope: { siteid: 'default', userid: EMAIL, contentid: '00000000000000000000000000000001' },
        column: 'Password',
        units: ['identity.credential', `Bearer ${TOKEN}`],
      },
      expected: {
        windowId: digestOf(`W:${EMAIL}`),
        holderId: 'transition:T1',
        tenantId: 'tenant-a',
        scope: { siteid: 'default', userid: digestOf(EMAIL), contentid: '00000000000000000000000000000001' },
        column: 'Password',
        units: ['identity.credential', digestOf(`Bearer ${TOKEN}`)],
      },
    },
    {
      label: 'keeps kebab-case step and fault names and digests every other name',
      input: {
        steps: [{ step: 6, name: 'final-state-and-reconcile' }],
        faults: [{ name: 'applier-killed-mid-batch' }],
        owner: { name: 'Avery Quinn' },
      },
      expected: {
        steps: [{ step: 6, name: 'final-state-and-reconcile' }],
        faults: [{ name: 'applier-killed-mid-batch' }],
        owner: { name: digestOf('Avery Quinn') },
      },
    },
    {
      label: 'keeps hash-shaped hash-named values outside raw data and digests the rest',
      input: { sourceSha: PIN_SHA, targetSha256: digestOf('x'), legacyRowHash: TABLE_SHA, manifestHash: TABLE_SHA, sha256: 'pending' },
      expected: {
        sourceSha: PIN_SHA,
        targetSha256: digestOf('x'),
        legacyRowHash: TABLE_SHA,
        manifestHash: digestOf(TABLE_SHA),
        sha256: digestOf('pending'),
      },
    },
  ];

  it.each(projectionCases)('$label', ({ input, expected }) => {
    expect(projectReportValue(input)).toEqual(expected);
  });

  it('masks a top-level value by the property name it is held under', () => {
    expect(projectReportValue(PASSWORD, 'password')).toBe(REDACTED);
    expect(projectReportValue(TOKEN, 'key')).toBe(digestOf(TOKEN));
    expect(projectReportValue('a\u{1F600}', 'value')).toMatch(/^sha256:[0-9a-f]{64} \(2 chars\)$/);
    expect(projectReportValue(ABORT_REASON, 'abortReason')).toBe(MASKED_ABORT_REASON);
    expect(projectReportValue(ABORT_REASON)).toBe(digestOf(ABORT_REASON));
  });

  it('is idempotent and leaves no raw secret', () => {
    const document = Object.fromEntries(projectionCases.map(({ input }, index) => [`case${index}`, input]));
    const once = projectReportValue(document);
    expect(projectReportValue(once)).toEqual(once);
    const text = JSON.stringify(once);
    for (const secret of RAW_SECRETS) expect(text).not.toContain(secret);
  });

  it('serialises non-sensitive values as JSON.stringify does', () => {
    const input = {
      at: new Date(FIXED_AT),
      skipped: undefined,
      fn: () => 1,
      list: [undefined, () => 1, Symbol('s'), 1, true],
      nonFinite: [Number.NaN, Number.POSITIVE_INFINITY],
      boxed: [new Number(2), new Boolean(false)],
      status: new String('s'),
      custom: { toJSON: (key: string) => ({ kind: key }) },
      map: new Map([['a', 1]]),
    };
    const projected = projectReportValue(input);
    expect(projected).toEqual(JSON.parse(JSON.stringify(input)));
    expect(Object.keys(projected as object)).toEqual(Object.keys(JSON.parse(JSON.stringify(input)) as object));
    expect(projectReportValue(undefined)).toBeUndefined();
    const shared = { n: 1 };
    expect(projectReportValue({ a: shared, b: [shared] })).toEqual({ a: { n: 1 }, b: [{ n: 1 }] });
  });

  const selfList: unknown[] = [];
  selfList.push(selfList);
  const selfRow: Record<string, unknown> = {};
  selfRow.row = selfRow;
  it.each([
    ['a nested BigInt', { a: [{ b: 1n }] }],
    ['a BigInt under a credential field', { password: 1n }],
    ['a circular array', { list: selfList }],
    ['a circular object under a raw-value field', { row: selfRow }],
    ['a circular object under a credential field', { secret: selfRow }],
  ])('throws a TypeError on %s', (_label, value) => {
    expect(() => projectReportValue(value)).toThrow(TypeError);
  });

  const unitReport = {
    unit: 'identity.credential',
    owner: 'identity',
    legacyTable: 'tusers',
    tenantId: 'tenant-a',
    status: 'difference',
    legacy: { rowCount: 3, sha256: TABLE_SHA },
    target: { rowCount: 3, sha256: TABLE_SHA },
    legacyCount: 3,
    targetCount: 3,
    legacySha256: TABLE_SHA,
    targetSha256: TABLE_SHA,
    differenceCount: 1,
    differences: [DIFFERENCE],
    excludedColumns: ['PasswordCreated'],
    files: { legacyObjects: 0, targetObjects: 0, differences: 0, differenceCount: 0 },
    orphans: ['tusersmemb'],
    orphanCount: 1,
  };
  const reconcileReport = {
    point: 'after-fault-duplicate-batch',
    expectedTableVersion: 'v0001',
    tableVersion: 'v0001',
    tableVersionMatches: true,
    snapshotSeq: 4,
    legacySource: 'snapshot',
    legacyDatabase: 'muradb',
    tolerance: 0,
    measures: ['rowCount', 'sha256', 'differences', 'fileManifest'],
    units: [unitReport],
    summary: { units: 1, tenants: 2, unitsWithDifferences: 1, differences: 1, orphans: 1, haltedUnits: 0 },
    fileStore: { store: 'filesystem', status: 'zero-difference', reason: 'no file units', haltedUnits: [] },
    result: 'zero-difference',
  };
  const migrationOrder = {
    basis: { relations: 'legacy-inventory.json relations[]', kinds: ['DAO join'], foreignKeysDeclared: 0, cyclePolicy: 'second pass' },
    expectedHead: { provenance: 'planning', tables: ['tsettings', 'people children'] },
    order: [{ position: 1, table: 'tusers', schema: 'identity', owner: 'identity', parents: ['tsettings'], tenantFrom: 'SiteID' }],
    brokenCycles: [{ tables: ['tcontent'], backReferenceColumn: 'ParentID', patchedInSecondPass: true }],
  };
  const projectedDifference = projectReportValue(DIFFERENCE);
  it.each([
    {
      label: 'a reconcile report',
      input: reconcileReport,
      expected: { ...reconcileReport, units: [{ ...unitReport, differences: [projectedDifference] }] },
    },
    { label: 'a migration order', input: migrationOrder, expected: migrationOrder },
  ])('keeps the identifiers, counts and hashes of $label', ({ input, expected }) => {
    expect(projectReportValue(input)).toEqual(expected);
  });
});

describe('committed report placeholders', () => {
  it.each(PLACEHOLDER_JSON)('project %s unchanged', async (file) => {
    const doc: unknown = JSON.parse(await readFile(path.join(REPO_REPORTS_DIR, file), 'utf8'));
    expect(projectReportValue(doc)).toEqual(doc);
  });

  it.each(['reconciliation/summary.md', 'rollback-rehearsal.md'])('redact the Markdown %s unchanged', async (file) => {
    const markdown = await readFile(path.join(REPO_REPORTS_DIR, file), 'utf8');
    expect(redactReportMarkdown(markdown)).toBe(markdown);
  });

  it('keep every cut-over write entry of groups.json under routeKey', async () => {
    const { groups } = JSON.parse(await readFile(REPO_GROUPS_FILE, 'utf8')) as { groups: { writeEntries: string[] }[] };
    const routes = groups.flatMap((group) => group.writeEntries);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.map((routeKey) => projectReportValue(routeKey, 'routeKey'))).toEqual(routes);
  });
});

describe('redactReportText', () => {
  it.each([
    [
      'a SQL Server duplicate key value',
      `Violation of PRIMARY KEY constraint 'PK_toauthtokens'. The duplicate key value is (${TOKEN}). The statement has been terminated.`,
      `Violation of PRIMARY KEY constraint 'PK_toauthtokens'. The duplicate key value is (${REDACTED}). The statement has been terminated.`,
    ],
    [
      'a SQL Server truncated value',
      "String or binary data would be truncated in table 'muradb.dbo.tusers', column 'UserName'. Truncated value: 'qa_member'.",
      `String or binary data would be truncated in table 'muradb.dbo.tusers', column 'UserName'. Truncated value: '${REDACTED}'.`,
    ],
    [
      'a SQL Server conversion value',
      "Conversion failed when converting the nvarchar value 'qa_member' to data type int.",
      `Conversion failed when converting the nvarchar value '${REDACTED}' to data type int.`,
    ],
    [
      'a PostgreSQL key value',
      'duplicate key value violates unique constraint "user_account_site_username" Key (site_id, username)=(tenant-a, qa_member) already exists.',
      `duplicate key value violates unique constraint "user_account_site_username" Key (site_id, username)=(${REDACTED}) already exists.`,
    ],
    [
      'a PostgreSQL expression key value',
      `Key (lower(email::text))=(${EMAIL}) already exists.`,
      `Key (lower(email::text))=(${REDACTED}) already exists.`,
    ],
    [
      'a PostgreSQL failing row',
      `new row for relation "credential" violates check constraint "c" Failing row contains (u-1, ${PASSWORD}, null).`,
      `new row for relation "credential" violates check constraint "c" Failing row contains (${REDACTED}).`,
    ],
    [
      'an unterminated value only to the end of its line',
      'The duplicate key value is (qa_member\nnext (line) kept',
      `The duplicate key value is (${REDACTED}\nnext (line) kept`,
    ],
    [
      'credentials, tokens and email addresses',
      ABORT_REASON,
      MASKED_ABORT_REASON,
    ],
    [
      'a PostgreSQL invalid input value',
      'insert failed: invalid input syntax for type integer: "202-555-0148" in column phone',
      `insert failed: invalid input syntax for type integer: "${REDACTED}" in column phone`,
    ],
    [
      'a PostgreSQL invalid input value of a multi-word type',
      `invalid input syntax for type timestamp with time zone: "${TOKEN}"`,
      `invalid input syntax for type timestamp with time zone: "${REDACTED}"`,
    ],
    [
      'a PostgreSQL invalid enum value',
      'invalid input value for enum people.person_status: "Avery"',
      `invalid input value for enum people.person_status: "${REDACTED}"`,
    ],
    [
      'a PostgreSQL out-of-range field value',
      'date/time field value out of range: "1990-13-45"',
      `date/time field value out of range: "${REDACTED}"`,
    ],
    [
      'a PostgreSQL malformed literal',
      `malformed array literal: "{${TOKEN}"`,
      `malformed array literal: "${REDACTED}"`,
    ],
    [
      'a PostgreSQL out-of-range value',
      'value "2026055501480" is out of range for type integer',
      `value "${REDACTED}" is out of range for type integer`,
    ],
    [
      'a PostgreSQL invalid formatting value',
      'invalid value "Avery" for "YYYY" in to_date',
      `invalid value "${REDACTED}" for "YYYY" in to_date`,
    ],
    [
      'a PostgreSQL syntax error token',
      `syntax error at or near "${TOKEN}" at character 15`,
      `syntax error at or near "${REDACTED}" at character 15`,
    ],
    [
      'a SQL Server syntax error token',
      `Incorrect syntax near '${TOKEN}'.`,
      `Incorrect syntax near '${REDACTED}'.`,
    ],
    [
      'a SQL Server unclosed string',
      `Unclosed quotation mark after the character string '${PASSWORD}'.`,
      `Unclosed quotation mark after the character string '${REDACTED}'.`,
    ],
  ])('masks %s, idempotently', (_label, text, expected) => {
    expect(redactReportText(text)).toBe(expected);
    expect(redactReportText(expected)).toBe(expected);
  });

  const repeated = (echo: string): string => echo.repeat(Math.ceil(1_000_000 / echo.length));
  it.each([
    ['duplicate key value is (', `duplicate key value is (${REDACTED}`],
    ["Truncated value: '", `Truncated value: '${REDACTED}'`],
    ['Failing row contains (', `Failing row contains (${REDACTED}`],
    ['Key (', repeated('Key (')],
    ['invalid input syntax for type integer: "', `invalid input syntax for type integer: "${REDACTED}"`],
    ['value "', repeated('value "')],
    ['invalid value "', `invalid value "${REDACTED}`],
    ['at or near "', `at or near "${REDACTED}"`],
    ["near '", `near '${REDACTED}'`],
  ])('scans a 1 MB line of repeated %j echoes in linear time', (echo, expected) => {
    const started = performance.now();
    expect(redactReportText(repeated(echo))).toBe(expected);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('redactReportMarkdown', () => {
  it.each([
    ['a 1 MB table', `| Email | n |\n|---|---|\n${'| avery | 1 |\n'.repeat(80_000)}`, 80_000],
    ['a 1 MB row of pipes', `| Email |\n|---|\n${'|'.repeat(1_000_000)}\n`, 0],
  ])('masks %s in linear time', (_label, markdown, masked) => {
    const started = performance.now();
    const text = redactReportMarkdown(markdown);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(text.split(REDACTED).length - 1).toBe(masked);
  });
});
