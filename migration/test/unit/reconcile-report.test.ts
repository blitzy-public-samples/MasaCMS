// Unit tests for reconciliation points, the point report body and the regenerated summary.md.
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixedClock } from '@opt2/platform/service-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { Difference, ObjectComparison, RowComparison } from '../../src/reconcile/compare.js';
import {
  GENERATED_BY,
  MEASURES,
  RECONCILIATION_DIR,
  ReconcileUsageError,
  buildReport,
  buildUnitReport,
  regenerateSummary,
  renderSummary,
  reportTargetFor,
  resolvePoint,
  writeReconciliationReport,
  type FileStoreReport,
  type ReconcileReportContext,
  type SummaryRow,
  type UnitReport,
} from '../../src/reconcile/report.js';

const PIN_SHA = '696383140578f8dea3ece26f80cd7bfb370ddf0f';
const PLACEHOLDER_DIR = fileURLToPath(new URL('../../../opt2/reports/reconciliation/', import.meta.url));
const FIXED_AT = '2026-06-30T12:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const TENANT_A = '3f1c2d4e-5a6b-5c7d-8e9f-0a1b2c3d4e5f';
const TENANT_B = '7a8b9c0d-1e2f-5a3b-8c4d-5e6f7a8b9c0d';
const NOT_APPLICABLE: FileStoreReport = { store: null, status: 'not-applicable', haltedUnits: [] };
const CHANGED: Difference = { kind: 'changed', key: 's4:u001', column: 'Fname', legacy: 'Ann', target: 'Anne' };

const config = loadConfig();
const FAULTS = config.faults.map((fault) => fault.name);

function rows(over: Partial<RowComparison> = {}): RowComparison {
  return { legacyCount: 2, targetCount: 2, legacySha256: SHA_A, targetSha256: SHA_A, differences: [], differenceCount: 0, ...over };
}

function objects(over: Partial<ObjectComparison> = {}): ObjectComparison {
  return { legacyObjects: 1, targetObjects: 1, differences: [], differenceCount: 0, ...over };
}

function entry(unit: string, tenantId: string, over: Partial<RowComparison> = {}, files: ObjectComparison | null = null): UnitReport {
  return buildUnitReport({ unit, owner: unit.split('.')[0] ?? unit, legacyTable: `dbo.t${unit.split('.')[1] ?? unit}`, tenantId, rows: rows(over), files });
}

function reportFor(point: string, units: readonly UnitReport[], tableVersion: string | null = 'v0001') {
  return buildReport({ point: resolvePoint(config, point), tableVersion, snapshotSeq: 1, legacyDatabase: 'muradb_opt2_snap_1', units, fileStore: NOT_APPLICABLE });
}

describe('resolvePoint', () => {
  it.each([
    ['after-backfill', 'after-backfill', 'v0001', 'snapshot', false],
    ['after-feed-1', 'after-feed', 'v0001', 'snapshot', false],
    ['after-feed-12', 'after-feed', 'v0001', 'snapshot', false],
    ['after-fault-applier-killed-mid-batch', 'after-fault', 'v0001', 'snapshot', false],
    ['after-fault-duplicate-batch', 'after-fault', 'v0001', 'snapshot', false],
    ['after-fault-mssql-dropped-mid-extract', 'after-fault', 'v0001', 'snapshot', false],
    ['after-fault-service-restarted-mid-apply', 'after-fault', 'v0001', 'snapshot', false],
    ['after-fault-pubsub-redelivery', 'after-fault', 'v0001', 'snapshot', false],
    ['after-fault-window-import-interrupted', 'after-fault', 'v0001', 'live', false],
    ['post-cutover', 'post-cutover', 'v0002', 'live', false],
    ['rollback-before', 'rollback-before', 'v0002', 'live', true],
    ['rollback-after', 'rollback-after', 'v0003', 'live', true],
  ] as const)('resolves %s', (name, kind, expectedTableVersion, legacySource, rollback) => {
    expect(resolvePoint(config, name)).toMatchObject({ name, kind, expectedTableVersion, legacySource, rollback });
  });

  it('records the feed number and the fault id', () => {
    expect(resolvePoint(config, 'after-feed-12').feedN).toBe(12);
    expect(resolvePoint(config, 'after-fault-duplicate-batch').fault).toBe('duplicate-batch');
  });

  it('matches the committed placeholder of every point it accepts', async () => {
    const files = (await readdir(PLACEHOLDER_DIR)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(11);
    for (const file of files) {
      const placeholder = JSON.parse(await readFile(path.join(PLACEHOLDER_DIR, file), 'utf8')) as Record<string, unknown>;
      const point = resolvePoint(config, path.basename(file, '.json'));
      expect([point.name, point.expectedTableVersion, point.legacySource]).toEqual([
        placeholder.point,
        placeholder.expectedTableVersion,
        placeholder.legacySource,
      ]);
    }
  });

  it.each(['after-fault-unknown', 'after-feed-0', 'after-feed-01', 'after-feed-', 'after-feed-1.5', 'after-feed-99999999999999999999', 'unknown', ''])('rejects %j', (name) => {
    let error: unknown;
    try {
      resolvePoint(config, name);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ReconcileUsageError);
    expect(error).toMatchObject({ name: 'ReconcileUsageError', exitCode: 2 });
    expect((error as Error).message).toContain(`"${name}"`);
    expect((error as Error).message).toContain('after-feed-<n> (n >= 1)');
    expect((error as Error).message).toContain('window-import-interrupted');
  });

  it('rejects a point kind the configuration does not list', () => {
    const narrowed = { faults: config.faults, reconciliationPoints: ['after-backfill'] };
    expect(resolvePoint(narrowed, 'after-backfill').kind).toBe('after-backfill');
    expect(() => resolvePoint(narrowed, 'post-cutover')).toThrow(/valid points: after-backfill$/);
  });
});

describe('buildUnitReport', () => {
  it('carries the same values in the nested and flat measures', () => {
    const unit = buildUnitReport({
      unit: 'people.person',
      owner: 'people',
      legacyTable: 'dbo.tusers',
      tenantId: TENANT_A,
      rows: rows({ targetCount: 3, targetSha256: SHA_B }),
      excludedColumns: ['tablist'],
    });
    expect(unit).toMatchObject({
      status: 'compared',
      legacy: { rowCount: 2, sha256: SHA_A },
      target: { rowCount: 3, sha256: SHA_B },
      legacyCount: 2,
      targetCount: 3,
      legacySha256: SHA_A,
      targetSha256: SHA_B,
      excludedColumns: ['tablist'],
      files: null,
      orphans: [],
      orphanCount: 0,
    });
  });

  it('appends object differences after row differences and caps listed orphans', () => {
    const objectDifference: Difference = { kind: 'object-mismatch', key: `${TENANT_A}/f1.png`, column: 'sha256', legacy: SHA_A, target: SHA_B };
    const files = objects({ differences: [objectDifference], differenceCount: 1 });
    const orphans = Array.from({ length: 150 }, (_, index) => `s3:o${String(index).padStart(3, '0')}`);
    const unit = buildUnitReport({
      unit: 'content.file',
      owner: 'strategies-content',
      legacyTable: 'dbo.tfiles',
      tenantId: TENANT_A,
      rows: rows({ differences: [CHANGED], differenceCount: 1 }),
      files,
      orphans,
    });
    expect(unit.differences).toEqual([CHANGED, objectDifference]);
    expect(unit.differenceCount).toBe(2);
    expect(unit.files).toBe(files);
    expect(unit.orphans).toEqual(orphans.slice(0, 100));
    expect(unit.orphanCount).toBe(150);
    expect(buildUnitReport({ unit: 'content.file', owner: 'x', legacyTable: null, tenantId: TENANT_A, rows: rows(), orphans: ['k'], orphanCount: 7 }).orphanCount).toBe(7);
  });
});

describe('buildReport', () => {
  it('reports zero difference when every entry agrees, with entries sorted by unit, table and tenant', () => {
    const report = reportFor('after-backfill', [entry('people.person', TENANT_B), entry('identity.user_account', TENANT_A), entry('people.person', TENANT_A)]);
    expect(report.result).toBe('zero-difference');
    expect(report.units.map((unit) => `${unit.unit}/${unit.tenantId}`)).toEqual([
      `identity.user_account/${TENANT_A}`,
      `people.person/${TENANT_A}`,
      `people.person/${TENANT_B}`,
    ]);
    expect(report).toMatchObject({
      point: 'after-backfill',
      expectedTableVersion: 'v0001',
      tableVersion: 'v0001',
      tableVersionMatches: true,
      snapshotSeq: 1,
      legacySource: 'snapshot',
      legacyDatabase: 'muradb_opt2_snap_1',
      tolerance: 0,
      measures: [...MEASURES],
      summary: { units: 2, tenants: 2, unitsWithDifferences: 0, differences: 0, orphans: 0, haltedUnits: 0 },
    });
  });

  it.each<[string, Partial<RowComparison>, ObjectComparison | null]>([
    ['a changed field', { differences: [CHANGED], differenceCount: 1 }, null],
    ['a count mismatch', { targetCount: 1 }, null],
    ['a checksum mismatch', { targetSha256: SHA_B }, null],
    ['an object-manifest mismatch', {}, objects({ targetObjects: 0 })],
  ])('reports a difference for %s', (_label, over, files) => {
    const report = reportFor('after-feed-1', [entry('people.person', TENANT_A), entry('people.person', TENANT_B, over, files), entry('identity.credential', TENANT_A)]);
    expect(report.result).toBe('difference');
    expect(report.summary.unitsWithDifferences).toBe(1);
    expect(report.summary.units).toBe(2);
  });

  it('records a table-version mismatch, a legacy-source override and halted file units without changing the result', () => {
    const fileStore: FileStoreReport = { store: 's3', status: 'halted', reason: 'file store is s3, not fileDir', haltedUnits: ['content.file_object'] };
    const report = buildReport({
      point: resolvePoint(config, 'post-cutover'),
      legacySource: 'snapshot',
      tableVersion: 'v0001',
      snapshotSeq: null,
      legacyDatabase: 'muradb',
      units: [entry('people.person', TENANT_A)],
      fileStore,
    });
    expect(report).toMatchObject({ tableVersionMatches: false, legacySource: 'snapshot', result: 'zero-difference', fileStore });
    expect(report.summary.haltedUnits).toBe(1);
    expect(reportFor('after-backfill', [], null)).toMatchObject({ tableVersionMatches: false, result: 'zero-difference', summary: { units: 0, orphans: 0 } });
  });

  it('lists skipped unit tables sorted by unit and table, counts their units and leaves the result to the compared entries', () => {
    const reason = 'fixtures unavailable: Mailpit unavailable';
    const skippedUnits = [
      { unit: 'timesheets.blackout', legacyTable: 'Program_N.blackout', reason },
      { unit: 'people.person_archive', legacyTable: 'synthetic.person_archive', reason },
      { unit: 'finance.split', legacyTable: 'synthetic.b', reason },
      { unit: 'finance.split', legacyTable: 'synthetic.a', reason },
    ];
    const build = (units: readonly UnitReport[]) =>
      buildReport({ point: resolvePoint(config, 'rollback-before'), tableVersion: 'v0002', snapshotSeq: null, legacyDatabase: 'muradb', units, skippedUnits, fileStore: NOT_APPLICABLE });

    const report = build([entry('people.person', TENANT_A)]);

    expect(report.skippedUnits.map((skipped) => `${skipped.unit}|${skipped.legacyTable}`)).toEqual([
      'finance.split|synthetic.a',
      'finance.split|synthetic.b',
      'people.person_archive|synthetic.person_archive',
      'timesheets.blackout|Program_N.blackout',
    ]);
    expect(report.skippedUnits[0]).not.toBe(skippedUnits[3]);
    expect(report.summary).toEqual({ units: 1, tenants: 1, unitsWithDifferences: 0, differences: 0, orphans: 0, haltedUnits: 0, skippedUnits: 3 });
    expect(report.result).toBe('zero-difference');
    expect(build([entry('people.person', TENANT_A, { targetCount: 1 })]).result).toBe('difference');
    expect(reportFor('post-cutover', []).skippedUnits).toEqual([]);
  });
});

describe('writing reports', () => {
  let reportsDir: string;
  let ctx: ReconcileReportContext;

  beforeEach(async () => {
    reportsDir = await mkdtemp(path.join(os.tmpdir(), 'reconcile-report-'));
    ctx = { config, env: { OPT2_REPORTS_DIR: reportsDir }, clock: fixedClock(FIXED_AT) };
  });

  afterEach(async () => {
    await rm(reportsDir, { recursive: true, force: true });
  });

  it('resolves the report target from OPT2_REPORTS_DIR or the configured directory with the pinned SHA', () => {
    expect(reportTargetFor(ctx)).toEqual({ reportsDir, sourceSha: PIN_SHA });
    expect(reportTargetFor({ config, env: {} }).reportsDir).toBe(config.paths.reportsDir);
  });

  it('writes the point report with the head fields first and regenerates the summary', async () => {
    const report = reportFor('rollback-before', [entry('people.person', TENANT_A)], 'v0002');
    const file = await writeReconciliationReport(ctx, report);
    expect(file).toBe(path.join(reportsDir, RECONCILIATION_DIR, 'rollback-before.json'));

    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([
      'sourceSha', 'generatedBy', 'generatedAt', 'status', 'point', 'expectedTableVersion', 'tableVersion', 'tableVersionMatches',
      'snapshotSeq', 'legacySource', 'legacyDatabase', 'tolerance', 'measures', 'units', 'skippedUnits', 'summary', 'fileStore', 'result',
    ]);
    expect(written).toMatchObject({ sourceSha: PIN_SHA, generatedBy: GENERATED_BY, generatedAt: FIXED_AT, status: 'generated', result: 'zero-difference' });
    expect(written.units).toEqual(report.units);

    const summary = await readFile(path.join(reportsDir, RECONCILIATION_DIR, 'summary.md'), 'utf8');
    expect(summary).toContain(`Source SHA: ${PIN_SHA}`);
    expect(summary).toContain('Zero difference at every point: yes');
    expect(summary).toContain('| rollback-before | [rollback-before.json](rollback-before.json) | v0002 | 1 | 0 | 0 | zero-difference |');
  });

  it('lists every JSON file of the directory in point order, placeholders as pending-run', async () => {
    const dir = path.join(reportsDir, RECONCILIATION_DIR);
    await mkdir(dir, { recursive: true });
    for (const file of await readdir(PLACEHOLDER_DIR)) await copyFile(path.join(PLACEHOLDER_DIR, file), path.join(dir, file));
    await writeFile(path.join(dir, 'adhoc-check.json'), '{"note":"manual"}\n');
    await writeFile(path.join(dir, '.after-feed-3.json.1.tmp'), '{');

    await writeReconciliationReport(ctx, reportFor('after-feed-2', [entry('people.person', TENANT_A, { differences: [CHANGED], differenceCount: 1 })]));
    await writeReconciliationReport(ctx, reportFor('after-backfill', [entry('people.person', TENANT_A)]));

    const summary = await readFile(path.join(dir, 'summary.md'), 'utf8');
    const points = summary
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Point'))
      .map((line) => line.split(' | ')[0]?.slice(2));
    expect(points).toEqual([
      'after-backfill',
      'after-feed-1',
      'after-feed-2',
      ...FAULTS.filter((fault) => !['projector-delay', 'forced-reinit'].includes(fault)).map((fault) => `after-fault-${fault}`),
      'post-cutover',
      'rollback-before',
      'rollback-after',
      'adhoc-check',
    ]);
    expect(summary).toContain('Zero difference at every point: no');
    expect(summary).toContain('| after-feed-1 | [after-feed-1.json](after-feed-1.json) | pending-run | pending-run | pending-run | pending-run | pending-run |');
    expect(summary).toContain('| after-feed-2 | [after-feed-2.json](after-feed-2.json) | v0001 | 1 | 1 | 0 | difference |');
    expect(summary).toContain('| adhoc-check | [adhoc-check.json](adhoc-check.json) | none | none | none | none | missing |');
    expect(summary.startsWith(`# Reconciliation summary\n\nSource SHA: ${PIN_SHA}\nStatus: generated\nGenerated by: ${GENERATED_BY}\n`)).toBe(true);
    expect(await regenerateSummary(reportTargetFor(ctx), config)).toBe(path.join(dir, 'summary.md'));
  });
});

describe('renderSummary', () => {
  const row = (point: string, result: string, over: Partial<SummaryRow> = {}): SummaryRow => ({
    point,
    file: `${point}.json`,
    tableVersion: 'v0001',
    expectedTableVersion: 'v0001',
    units: 1,
    unitsWithDifferences: result === 'difference' ? 1 : 0,
    orphans: 0,
    result,
    ...over,
  });

  it.each([
    ['yes', [row('after-backfill', 'zero-difference'), row('post-cutover', 'zero-difference')]],
    ['no', [row('after-backfill', 'zero-difference'), row('post-cutover', 'difference'), row('rollback-after', 'pending-run')]],
    ['pending', [row('after-backfill', 'zero-difference'), row('post-cutover', 'pending-run')]],
    ['pending', []],
  ] as const)('gives the verdict %s', (verdict, rows) => {
    expect(renderSummary(rows, PIN_SHA)).toContain(`Zero difference at every point: ${verdict}\n`);
  });

  it('orders faults by the given fault list, names a version mismatch and escapes pipes', () => {
    const markdown = renderSummary(
      [
        row('after-fault-b', 'zero-difference'),
        row('rollback-after', 'zero-difference', { tableVersion: 'v0002', expectedTableVersion: 'v0003' }),
        row('a|b', 'zero-difference'),
        row('after-fault-a', 'zero-difference'),
      ],
      PIN_SHA,
      ['b', 'a'],
    );
    const lines = markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Point'));
    expect(lines.map((line) => line.split(' | ')[0])).toEqual(['| after-fault-b', '| after-fault-a', '| rollback-after', '| a\\|b']);
    expect(lines[2]).toContain('| v0002 (expected v0003) |');
    expect(lines[3]).toContain('[a\\|b.json](a%7Cb.json)');
  });
});
