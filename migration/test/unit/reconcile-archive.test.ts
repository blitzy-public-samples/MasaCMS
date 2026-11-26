// Unit tests of the reconciliation archive: the committed baseline and difference records, the build, diff and reconstruct
// functions, and the runtime readers that must not consult it.
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import {
  ARCHIVE_DIR,
  ARCHIVE_GENERATED_BY,
  ArchiveError,
  REDACTION_RULE,
  applyOperations,
  buildArchive,
  buildRecord,
  diffJson,
  isDifferenceRecord,
  main,
  readArchive,
  reconstructPoint,
  redactReport,
  reportBytes,
  reportSha256,
  verifyArchive,
  writeArchive,
  type ArchiveDocument,
  type DifferenceRecord,
  type JsonObject,
  type JsonValue,
  type Operation,
} from '../../src/reconcile/archive.js';
import {
  RECONCILIATION_DIR,
  buildReport,
  buildUnitReport,
  regenerateSummary,
  reportTargetFor,
  resolvePoint,
  writeReconciliationReport,
} from '../../src/reconcile/report.js';
import { writeRollbackReport } from '../../src/rollback/index.js';
import { createMutableClock, createTestDirs, testEnv, type TestDirs } from '../helpers/env.js';
import { writeCutoverDir } from '../helpers/fixtures.js';

// Pass-through spies, so the reader tests can list every path read.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});

const PIN_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const RECONCILIATION = fileURLToPath(new URL('../../../opt2/reports/reconciliation/', import.meta.url));
const ARCHIVE = path.join(RECONCILIATION, ARCHIVE_DIR);
const BASELINE = 'after-fault-pubsub-redelivery';
const FAULTS = [
  'applier-killed-mid-batch',
  'duplicate-batch',
  'mssql-dropped-mid-extract',
  'service-restarted-mid-apply',
  'pubsub-redelivery',
  'window-import-interrupted',
  'forced-reinit',
];
const ARCHIVED = [
  'after-backfill',
  ...[1, 2, 3, 4, 6, 8].map((n) => `after-feed-${String(n)}`),
  ...FAULTS.map((fault) => `after-fault-${fault}`),
  'checkpoint',
  'post-cutover',
  'rollback-after',
].sort();

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-reconcile-archive-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Every string of `value` with the path it sits at. */
function strings(value: JsonValue, at: (string | number)[] = []): { at: (string | number)[]; text: string }[] {
  if (typeof value === 'string') return [{ at, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, [...at, i]));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => strings(item, [...at, key]));
  return [];
}

/** A small point report shaped as the reconcile writer's. */
function report(point: string, units: JsonValue[], extra: JsonObject = {}): JsonObject {
  return {
    sourceSha: PIN_SHA,
    generatedBy: 'migration/src/reconcile/',
    point,
    tableVersion: 'v0001',
    snapshotSeq: 1,
    units,
    summary: { units: units.length, differences: 0 },
    result: 'zero-difference',
    ...extra,
  };
}

function unit(name: string, rows: number): JsonObject {
  return { unit: name, tenantId: 't-1', legacy: { rowCount: rows, sha256: `${name}-${String(rows)}` }, differences: [] };
}

describe('committed reconciliation archive', () => {
  let archive: Map<string, ArchiveDocument>;

  beforeEach(async () => {
    archive = await readArchive(ARCHIVE);
  });

  it('holds one full baseline and a difference record for every other archived point', () => {
    expect([...archive.keys()]).toEqual(ARCHIVED);
    const verified = verifyArchive(archive, PIN_SHA);
    expect(verified.baseline).toBe(BASELINE);
    expect(verified.points.map((entry) => entry.point)).toEqual(ARCHIVED);
    for (const [point, doc] of archive) {
      expect(isDifferenceRecord(doc)).toBe(point !== BASELINE);
      expect(doc).toMatchObject(point === BASELINE ? { sourceSha: PIN_SHA, point } : { sourceSha: PIN_SHA, generatedBy: ARCHIVE_GENERATED_BY, point });
    }
  });

  it.each(ARCHIVED)('reconstructs %s at zero difference with its recorded identity and sha256', async (point) => {
    const doc = archive.get(point) as ArchiveDocument;
    const rebuilt = reconstructPoint(archive, point);
    expect(rebuilt).toMatchObject({ sourceSha: PIN_SHA, point, result: 'zero-difference', summary: { differences: 0, unitsWithDifferences: 0 } });
    if (isDifferenceRecord(doc)) {
      expect(reportSha256(rebuilt)).toBe(doc.sha256);
      expect(doc).toMatchObject({ tableVersion: rebuilt.tableVersion, snapshotSeq: rebuilt.snapshotSeq, result: rebuilt.result });
      for (const redaction of doc.redactions ?? []) {
        expect(redaction.rule).toBe(REDACTION_RULE);
        expect(strings(rebuilt).find((entry) => JSON.stringify(entry.at) === JSON.stringify(redaction.path))?.text).toMatch(/^opt2\/reports\/reconciliation\/[a-z0-9-]+\.json$/);
      }
    } else {
      expect(await readFile(path.join(ARCHIVE, `${point}.json`), 'utf8')).toBe(reportBytes(rebuilt));
    }
    expect(strings(rebuilt).filter((entry) => entry.text.startsWith('/'))).toEqual([]);
  });

  it('records only units of the configured data owners at every point', async () => {
    const config = loadConfig();
    const schemas = new Set(config.dataOwners.map((owner) => config.owners[owner].schema));
    const before = JSON.parse(await readFile(path.join(RECONCILIATION, 'rollback-before.json'), 'utf8')) as JsonObject;
    for (const doc of [before, ...ARCHIVED.map((point) => reconstructPoint(archive, point))]) {
      const entries = [...(doc.units as JsonObject[]), ...(doc.emptyUnits as JsonObject[]), ...(doc.skippedUnits as JsonObject[])];
      expect(entries.map((entry) => entry.unit as string).filter((unit) => !schemas.has(unit.slice(0, unit.indexOf('.'))))).toEqual([]);
    }
  });

  it('keeps rollback-before.json in full at its runtime path, at zero difference', async () => {
    const before = JSON.parse(await readFile(path.join(RECONCILIATION, 'rollback-before.json'), 'utf8')) as JsonObject;
    expect(isDifferenceRecord(before)).toBe(false);
    expect(before).toMatchObject({ sourceSha: PIN_SHA, point: 'rollback-before', tableVersion: 'v0002', result: 'zero-difference', summary: { differences: 0 } });
    expect(Array.isArray(before.units)).toBe(true);
  });

  it('links every summary.md row to an existing report whose values it states', async () => {
    const summary = await readFile(path.join(RECONCILIATION, 'summary.md'), 'utf8');
    expect(summary).toContain(`Source SHA: ${PIN_SHA}\n`);
    const rows = summary.split('\n').filter((line) => /^\| [a-z]/.test(line) && !line.startsWith('| Point'));
    expect(rows.length).toBeGreaterThan(0);
    for (const line of rows) {
      const [point = '', link = '', tableVersion, units, differences, orphans, result] = line.slice(2, -2).split(' | ');
      const file = /^\[([^\]]+)\]\(\1\)$/.exec(link)?.[1] ?? '';
      expect([`${point}.json`, `${ARCHIVE_DIR}/${point}.json`]).toContain(file);
      const doc = file.startsWith(`${ARCHIVE_DIR}/`) ? reconstructPoint(archive, point) : (JSON.parse(await readFile(path.join(RECONCILIATION, file), 'utf8')) as JsonObject);
      const counts = doc.summary as JsonObject;
      expect([tableVersion, units, differences, orphans, result]).toEqual([
        doc.tableVersion,
        String(counts.units),
        String(counts.unitsWithDifferences),
        String(counts.orphans),
        doc.result,
      ]);
    }
  });
});

describe('diffJson and applyOperations', () => {
  it.each<[string, JsonValue, JsonValue]>([
    ['equal documents', { a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }],
    ['a changed scalar', { a: 1, b: 'x' }, { a: 2, b: 'x' }],
    ['an added and a removed key', { a: 1, b: 2 }, { a: 1, c: 3 }],
    ['reordered keys', { a: 1, b: 2, c: 3 }, { c: 3, a: 1, b: 2 }],
    ['a key added before existing ones', { b: 2 }, { a: 1, b: 2 }],
    ['array inserts, deletes and changed elements', [unit('a', 1), unit('b', 2), unit('c', 3), unit('d', 4)], [unit('a', 1), unit('b', 5), unit('x', 9), unit('d', 4), unit('e', 1)]],
    ['an emptied array', [1, 2, 3], []],
    ['a filled array', [], [{ a: 1 }]],
    ['a type change', { a: [1, 2] }, { a: { 0: 1 } }],
    ['a replaced root', [1], 'text'],
    ['null against an object', null, { a: null }],
  ])('round-trips %s byte for byte', (_name, base, target) => {
    const before = reportBytes(base);
    const ops = diffJson(base, target);
    expect(reportBytes(applyOperations(base, ops))).toBe(reportBytes(target));
    expect(reportBytes(base)).toBe(before);
    if (reportBytes(base) === reportBytes(target)) expect(ops).toEqual([]);
  });

  it('keeps unchanged array elements out of the operations', () => {
    const base = report('p', [unit('a', 1), unit('b', 2), unit('c', 3)]);
    const target = report('p', [unit('a', 1), unit('c', 3)]);
    expect(diffJson(base, target)).toEqual([
      { op: 'splice', path: ['units'], index: 1, remove: 1, insert: [] },
      { op: 'set', path: ['summary', 'units'], value: 2 },
    ]);
  });

  it.each<[string, JsonValue, Operation]>([
    ['a set below a missing key', { a: 1 }, { op: 'set', path: ['b', 'c'], value: 1 }],
    ['a set past the end of an array', [1], { op: 'set', path: [1], value: 2 }],
    ['a delete of a missing key', { a: 1 }, { op: 'delete', path: ['b'] }],
    ['a delete of an array element', [1], { op: 'delete', path: [0] }],
    ['a splice past the end', [1], { op: 'splice', path: [], index: 1, remove: 1, insert: [] }],
    ['a splice of an object', { a: 1 }, { op: 'splice', path: [], index: 0, remove: 0, insert: [] }],
    ['an unknown operation', { a: 1 }, { op: 'order', path: [], keys: ['a'] } as unknown as Operation],
  ])('rejects %s', (_name, base, op) => {
    expect(() => applyOperations(base, [op])).toThrow(ArchiveError);
  });
});

describe('redactReport', () => {
  it('cuts absolute report paths to their repository-relative form and lists where', () => {
    const doc = { a: { reportPath: '/srv/x/opt2/reports/opt2/reports/reconciliation/after-feed-3.json' }, b: ['opt2/reports/r.json', '/opt2/reports/r.json', '/etc/hosts', 7] };
    expect(redactReport(doc)).toEqual({
      report: { a: { reportPath: 'opt2/reports/reconciliation/after-feed-3.json' }, b: ['opt2/reports/r.json', 'opt2/reports/r.json', '/etc/hosts', 7] },
      redactions: [
        { path: ['a', 'reportPath'], rule: REDACTION_RULE },
        { path: ['b', 1], rule: REDACTION_RULE },
      ],
    });
  });
});

describe('buildArchive', () => {
  const units = [unit('a', 1), unit('b', 2), unit('c', 3), unit('d', 4)];
  const reports: Record<string, JsonObject> = {
    p1: report('p1', units),
    p2: report('p2', [...units, unit('e', 5)]),
    p3: report('p3', [...units, unit('e', 5)], { feed: { startedAt: 'x' } }),
    p4: report('p4', [unit('z', 9)], { fault: { name: 'f', reportPath: '/w/opt2/reports/reconciliation/p1.json' } }),
  };

  /** Bytes of every record against `baseline`. */
  function recordBytes(baseline: string): number {
    const baseReport = redactReport(reports[baseline] as JsonObject).report;
    return Object.keys(reports)
      .filter((name) => name !== baseline)
      .reduce((sum, name) => sum + Buffer.byteLength(reportBytes(buildRecord({ ...redactReport(reports[name] as JsonObject), base: baseline, baseReport, sourceSha: PIN_SHA }))), 0);
  }

  it('stores the baseline whose records total fewest bytes in full and every other point as a record against it', () => {
    const { plan, documents } = buildArchive(reports, PIN_SHA);
    const archive = new Map(Object.entries(documents));
    expect(recordBytes(plan.baseline)).toBe(Math.min(...Object.keys(reports).map(recordBytes)));
    expect(isDifferenceRecord(documents[plan.baseline] as ArchiveDocument)).toBe(false);
    for (const point of Object.keys(reports).filter((name) => name !== plan.baseline)) expect((documents[point] as DifferenceRecord).base).toBe(plan.baseline);
    for (const point of Object.keys(reports)) expect(reconstructPoint(archive, point)).toEqual(redactReport(reports[point] as JsonObject).report);
    expect(documents.p4).toMatchObject({ redactions: [{ path: ['fault', 'reportPath'], rule: REDACTION_RULE }] });
    expect(reconstructPoint(archive, 'p4').fault).toEqual({ name: 'f', reportPath: 'opt2/reports/reconciliation/p1.json' });
    expect(verifyArchive(archive, PIN_SHA)).toMatchObject({ baseline: plan.baseline });
  });

  it('lists the redactions of every point that had any, the baseline included', () => {
    const fault = (point: string): JsonObject => ({ fault: { name: 'f', reportPath: `/w/opt2/reports/reconciliation/${point}.json` } });
    const { plan, documents } = buildArchive({ q1: report('q1', units, fault('q1')), q2: report('q2', units, fault('q2')), q3: report('q3', [unit('z', 9)]) }, PIN_SHA);
    const redactions = [{ path: ['fault', 'reportPath'], rule: REDACTION_RULE }];
    expect(plan).toEqual({ baseline: 'q1', redactions: { q1: redactions, q2: redactions } });
    expect(documents.q1).toMatchObject({ fault: { reportPath: 'opt2/reports/reconciliation/q1.json' } });
    expect(documents.q2).toMatchObject({ base: 'q1', redactions });
  });

  it.each<[string, Record<string, JsonObject>, RegExp]>([
    ['no reports', {}, /No reports to archive/],
    ['a report naming another point', { p1: report('p9', []) }, /p1\.json records point "p9"/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => buildArchive(input, PIN_SHA)).toThrow(message);
  });
});

describe('reconstructPoint and verifyArchive', () => {
  const base = report('base', [unit('a', 1)]);
  const record = (over: Partial<DifferenceRecord> = {}): DifferenceRecord => ({
    ...buildRecord({ report: report('next', [unit('a', 2)]), base: 'base', baseReport: base, sourceSha: PIN_SHA }),
    ...over,
  });
  const archiveOf = (...entries: [string, ArchiveDocument][]): Map<string, ArchiveDocument> => new Map(entries);

  it('returns a copy the caller may change', () => {
    const archive = archiveOf(['base', base], ['next', record()]);
    const first = reconstructPoint(archive, 'next');
    first.point = 'changed';
    expect(reconstructPoint(archive, 'next').point).toBe('next');
  });

  it.each<[string, Map<string, ArchiveDocument>, string, RegExp]>([
    ['a missing point', archiveOf(['base', base]), 'next', /No archived point next/],
    ['a missing base', archiveOf(['next', record()]), 'next', /No archived point base/],
    ['a base that is a difference record', archiveOf(['base', base], ['next', record()], ['other', record({ base: 'next' })]), 'other', /other: base next is a difference record/],
    ['a tampered sha256', archiveOf(['base', base], ['next', record({ sha256: '0'.repeat(64) })]), 'next', /does not match sha256/],
    ['an inapplicable operation', archiveOf(['base', base], ['next', record({ operations: [{ op: 'delete', path: ['nope'] }] })]), 'next', /^next: Cannot delete/],
    ['a report naming another point', archiveOf(['next', report('base', [])]), 'next', /records point "base"/],
  ])('rejects %s', (_name, archive, point, message) => {
    expect(() => reconstructPoint(archive, point)).toThrow(message);
  });

  it.each<[string, Map<string, ArchiveDocument>, RegExp]>([
    ['two baselines', archiveOf(['base', base], ['next', report('next', [])]), /one full baseline, found 2/],
    ['a foreign sourceSha', archiveOf(['base', base], ['next', record({ sourceSha: 'f'.repeat(40) })]), /next: sourceSha is not/],
    ['an identity unlike the report', archiveOf(['base', base], ['next', record({ snapshotSeq: 9 })]), /next: snapshotSeq 9 differs from 1/],
    ['an unreconstructible record', archiveOf(['base', base], ['next', record({ base: 'gone' })]), /No archived point gone/],
    ['a record whose base is not the baseline', archiveOf(['base', base], ['next', record()], ['other', record({ base: 'next' })]), /other: base next is not the baseline base/],
  ])('verifyArchive rejects %s', (_name, archive, message) => {
    expect(() => verifyArchive(archive, PIN_SHA)).toThrow(message);
  });
});

describe('writeArchive and main', () => {
  async function sourceDir(extra: JsonObject = {}): Promise<string> {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.json'), reportBytes(report('a', [unit('a', 1), unit('b', 2)], extra)));
    await writeFile(path.join(dir, 'b.json'), reportBytes(report('b', [unit('a', 1), unit('b', 3)])));
    await writeFile(path.join(dir, 'rollback-before.json'), reportBytes(report('rollback-before', [])));
    return dir;
  }

  it('archives every point but those kept in place and removes stale archive files', async () => {
    const source = await sourceDir();
    const target = path.join(await tempDir(), 'archive');
    await mkdir(target);
    await writeFile(path.join(target, 'stale.json'), '{}\n');
    const plan = await writeArchive(source, target, PIN_SHA, []);
    expect((await readdir(target)).sort()).toEqual(['a.json', 'b.json']);
    expect(plan).toEqual({ baseline: 'a', redactions: {} });
  });

  it('writes the kept reports and summary.md beside the archive and removes the archived points there', async () => {
    const source = await sourceDir({ fault: { name: 'f', reportPath: '/w/opt2/reports/reconciliation/b.json' } });
    const parent = await tempDir();
    await writeFile(path.join(parent, 'b.json'), '{}\n');
    await writeFile(path.join(parent, 'rollback-before.json'), '{}\n');
    await writeArchive(source, path.join(parent, ARCHIVE_DIR), PIN_SHA, []);
    expect((await readdir(parent)).sort()).toEqual([ARCHIVE_DIR, 'rollback-before.json', 'summary.md']);
    expect(await readFile(path.join(parent, 'rollback-before.json'), 'utf8')).toBe(await readFile(path.join(source, 'rollback-before.json'), 'utf8'));
    expect((await readFile(path.join(parent, 'summary.md'), 'utf8')).split('\n')).toEqual([
      '# Reconciliation summary',
      '',
      `Source SHA: ${PIN_SHA}`,
      'Status: generated',
      'Generated by: migration/src/reconcile/',
      '',
      'Zero difference at every point: yes',
      '',
      `Archive: [\`archive/\`](archive/) holds every point but \`rollback-before\` as one full baseline report (\`a.json\`) plus difference records that \`${ARCHIVE_GENERATED_BY}\` reconstructs. The baseline's redactions: \`["fault","reportPath"]\` (${REDACTION_RULE}).`,
      '',
      '| Point | Report | Table version | Units | Differences | Orphans | Result |',
      '|---|---|---|---|---|---|---|',
      '| rollback-before | [rollback-before.json](rollback-before.json) | v0001 | 0 | none | none | zero-difference |',
      '| a | [archive/a.json](archive/a.json) | v0001 | 2 | none | none | zero-difference |',
      '| b | [archive/b.json](archive/b.json) | v0001 | 2 | none | none | zero-difference |',
      '',
    ]);
  });

  it('rejects a source directory without the reports kept in place', async () => {
    const source = await sourceDir();
    await rm(path.join(source, 'rollback-before.json'));
    await expect(writeArchive(source, path.join(await tempDir(), ARCHIVE_DIR), PIN_SHA, [])).rejects.toThrow(/has no rollback-before\.json/);
  });

  it.each<[string, string, JsonObject, string]>([
    ['a kept report with a foreign sourceSha', 'rollback-before', { sourceSha: 'f'.repeat(40) }, `rollback-before: sourceSha is not ${PIN_SHA}`],
    ['a kept report naming another point', 'rollback-before', { point: 'rollback-after' }, 'rollback-before: report records point "rollback-after"'],
    ['an archived report with a foreign sourceSha', 'b', { sourceSha: 'f'.repeat(40) }, `b: sourceSha is not ${PIN_SHA}`],
  ])('rejects %s before writing anything', async (_name, point, over, message) => {
    const source = await sourceDir();
    await writeFile(path.join(source, `${point}.json`), reportBytes(report(point, [], over)));
    const parent = await tempDir();
    const error: unknown = await writeArchive(source, path.join(parent, ARCHIVE_DIR), PIN_SHA, []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).message).toBe(message);
    expect(await readdir(parent)).toEqual([]);
  });

  it('builds, verifies and shows through the CLI', async () => {
    const source = await sourceDir();
    const target = path.join(await tempDir(), 'archive');
    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    expect(await main(['build', source, target], out)).toBe(0);
    expect(await main(['verify', target], out)).toBe(0);
    expect(await main(['show', 'b', target], out)).toBe(0);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ baseline: 'a', redactions: {} });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ baseline: 'a', points: [{ point: 'a', base: null }, { point: 'b', base: 'a' }] });
    expect(lines[2]).toBe(await readFile(path.join(source, 'b.json'), 'utf8'));
  });

  it('verifies the committed archive by default and exits 2 on a usage error', async () => {
    vi.stubEnv('OPT2_REPORTS_DIR', '');
    const lines: string[] = [];
    expect(
      await main(['verify'], (line) => {
        lines.push(line);
      }),
    ).toBe(0);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ baseline: BASELINE });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await main(['show'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('usage: archive.ts build'));
  });
});

describe('runtime readers beside the committed archive', () => {
  const config = loadConfig();
  const GENERATED_AT = '2026-06-30T12:00:00.000Z';
  const ARCHIVE_SEGMENT = `${path.sep}${RECONCILIATION_DIR}${path.sep}${ARCHIVE_DIR}`;
  const created: TestDirs[] = [];

  afterEach(async () => {
    await Promise.all(created.splice(0).map((dirs) => dirs.cleanup()));
  });

  /** A fresh runtime report of `point`, one compared unit at zero difference. */
  function runtimeReport(point: string, tableVersion: string) {
    const rows = { legacyCount: 1, targetCount: 1, legacySha256: 'a'.repeat(64), targetSha256: 'a'.repeat(64), differences: [], differenceCount: 0 };
    return buildReport({
      point: resolvePoint(config, point),
      startedAt: GENERATED_AT,
      tableVersion,
      snapshotSeq: 7,
      legacyDatabase: 'muradb',
      units: [buildUnitReport({ unit: 'people.person', owner: 'people', legacyTable: 'dbo.tusers', tenantId: 't-1', rows })],
      fileStore: { store: null, status: 'not-applicable', haltedUnits: [] },
    });
  }

  /** Test dirs whose reports hold the committed rollback-before.json and, when `archived`, a copy of the committed archive. */
  async function layout(archived: boolean): Promise<TestDirs> {
    const dirs = await createTestDirs();
    created.push(dirs);
    const dir = path.join(dirs.reportsDir, RECONCILIATION_DIR);
    await mkdir(dir, { recursive: true });
    await cp(path.join(RECONCILIATION, 'rollback-before.json'), path.join(dir, 'rollback-before.json'));
    if (archived) await cp(ARCHIVE, path.join(dir, ARCHIVE_DIR), { recursive: true });
    return dirs;
  }

  /** Every path `readFile` and `readdir` were called with since the last clear. */
  function pathsRead(): string[] {
    return [...vi.mocked(readFile).mock.calls, ...vi.mocked(readdir).mock.calls].map(([file]) => String(file));
  }

  /** Runs `read` over a layout with and one without the archive; returns both outputs and the paths read. */
  async function bothLayouts(read: (dirs: TestDirs) => Promise<string>): Promise<{ outputs: string[]; read: string[]; archived: TestDirs }> {
    const outputs: string[] = [];
    const seen: string[] = [];
    let archived: TestDirs | undefined;
    for (const withArchive of [true, false]) {
      const dirs = await layout(withArchive);
      if (withArchive) archived = dirs;
      vi.mocked(readFile).mockClear();
      vi.mocked(readdir).mockClear();
      outputs.push(await read(dirs));
      seen.push(...pathsRead());
    }
    return { outputs, read: seen, archived: archived as TestDirs };
  }

  it.each([
    ['a clean checkout', false, ['rollback-before']],
    ['fresh runtime reports', true, ['after-backfill', 'rollback-before']],
  ] as const)('regenerate summary.md from the top-level reports only, in %s', async (_name, fresh, points) => {
    const { outputs, read, archived } = await bothLayouts(async (dirs) => {
      const ctx = { config, env: { OPT2_REPORTS_DIR: dirs.reportsDir }, clock: createMutableClock(GENERATED_AT) };
      if (fresh) await writeReconciliationReport(ctx, runtimeReport('after-backfill', 'v0001'));
      return readFile(await regenerateSummary(reportTargetFor(ctx), config), 'utf8');
    });
    expect(outputs[0]).toBe(outputs[1]);
    const summary = outputs[0] ?? '';
    const rows = summary.split('\n').filter((line) => /^\| [a-z]/.test(line) && !line.startsWith('| Point'));
    expect(rows.map((line) => line.split(' | ')[0]?.slice(2))).toEqual(points);
    if (fresh) expect(summary).toContain('| after-backfill | [after-backfill.json](after-backfill.json) | v0001 | 1 | 0 | 0 | zero-difference |');
    expect(read.filter((file) => file.endsWith(`${path.sep}rollback-before.json`)).length).toBeGreaterThanOrEqual(2);
    expect(read.filter((file) => file.includes(ARCHIVE_SEGMENT))).toEqual([]);
    expect(await readArchive(path.join(archived.reportsDir, RECONCILIATION_DIR, ARCHIVE_DIR))).toEqual(await readArchive(ARCHIVE));
  });

  it.each([
    ['a clean checkout', false],
    ['fresh runtime reports', true],
  ] as const)('read the rollback reconciliations from the top-level reports only, in %s', async (_name, fresh) => {
    const committed = JSON.parse(await readFile(path.join(RECONCILIATION, 'rollback-before.json'), 'utf8')) as JsonObject;
    const counts = committed.summary as JsonObject;
    const after = runtimeReport('rollback-after', 'v0003');
    const { outputs, read } = await bothLayouts(async (dirs) => {
      const cutover = await writeCutoverDir({ dir: path.join(dirs.stateDir, 'cutover') });
      const ctx = {
        env: testEnv({ dirs }),
        config: { ...config, paths: { ...config.paths, cutoverDir: cutover.cutoverDir, groupsFile: cutover.groupsFile } },
        clock: createMutableClock(GENERATED_AT),
      };
      if (fresh) await writeReconciliationReport(ctx, after);
      return readFile((await writeRollbackReport(ctx)).reportPath, 'utf8');
    });
    expect(outputs[0]).toBe(outputs[1]);
    const lines = (outputs[0] ?? '').split('\n');
    const row = (point: string, cells: readonly unknown[]): string =>
      `| ${point} | [reconciliation/${point}.json](reconciliation/${point}.json) | ${cells.map(String).join(' | ')} |`;
    expect(lines).toContain(row('rollback-before', [committed.tableVersion, counts.units, counts.unitsWithDifferences, committed.result]));
    expect(lines).toContain(row('rollback-after', fresh ? ['v0003', 1, 0, 'zero-difference'] : ['not-run', 'not-run', 'not-run', 'not-run']));
    expect(read.filter((file) => file.endsWith(`${path.sep}rollback-before.json`)).length).toBeGreaterThanOrEqual(2);
    expect(read.filter((file) => file.includes(ARCHIVE_SEGMENT))).toEqual([]);
  });
});
