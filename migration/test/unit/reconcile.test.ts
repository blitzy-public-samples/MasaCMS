// Reconciliation over the shared test doubles: zero difference only when every measure agrees, point names, and reports stamped with the pinned SHA.
import { Buffer } from 'node:buffer';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { compareEncodings, decodeRow, encodeKey, encodeRow, sha256Hex, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { CanonicalRow } from '../../src/extract/index.js';
import {
  DIFFERENCE_LIMIT,
  GENERATED_BY,
  MEASURES,
  RECONCILIATION_DIR,
  ReconcileUsageError,
  buildReport,
  buildUnitReport,
  compareObjects,
  compareRows,
  createTenantResolver,
  describeUnitTable,
  isZeroDifference,
  readLegacyUnitRows,
  reconcileUnits,
  renderValue,
  resolvePoint,
  writeReconciliationReport,
  type Difference,
  type DifferenceKind,
  type FileStoreReport,
  type ObjectComparison,
  type ObjectEntry,
  type ReconcileReport,
  type ResolvedPoint,
  type RowComparison,
  type UnitReport,
} from '../../src/reconcile/index.js';
import { buildTestContext, type TestContext } from '../helpers/context.js';
import { TEST_SOURCE_SHA } from '../helpers/env.js';
import type { Row } from '../helpers/fake-legacy-db.js';
import { TABLES, UNITS } from '../helpers/fixtures.js';
import type { OwnerDoubles } from '../helpers/owner-double.js';

const config = loadConfig();

/** The committed summary, whose modification time no test may change. */
const COMMITTED_SUMMARY = path.join(config.paths.reportsDir, RECONCILIATION_DIR, 'summary.md');
const committedSummaryMtime = (await stat(COMMITTED_SUMMARY)).mtimeMs;

const KEY = ['sizeID'];
const COLUMNS: CanonicalColumn[] = [
  { name: 'sizeID', type: 's' },
  { name: 'siteID', type: 's' },
  { name: 'name', type: 's' },
  { name: 'width', type: 'i' },
  { name: 'preview', type: 'b' },
];
const MEMBER_COLUMNS: CanonicalColumn[] = [
  { name: 'MLID', type: 's' },
  { name: 'Email', type: 's' },
];

const TENANT_X = '1d4b6a0e-0000-5000-8000-00000000000a';
const TENANT_Y = '1d4b6a0e-0000-5000-8000-00000000000b';
const SHA_1 = '1'.repeat(64);
const SHA_2 = '2'.repeat(64);
const SHA_3 = '3'.repeat(64);
const NO_FILE_STORE: FileStoreReport = { store: null, status: 'not-applicable', haltedUnits: [] };

/** A keyed image-size row in `compareCanonicalRows` order by its id. */
function size(id: string, overrides: Record<string, unknown> = {}): CanonicalRow {
  const values = { sizeID: id, siteID: 'tenant-a', name: `Size ${id}`, width: '100', preview: Buffer.from([0xab, 0x01]), ...overrides };
  const encoding = encodeRow(COLUMNS, values);
  return { table: 'dbo.timagesizes', key: encodeKey(COLUMNS, KEY, values), keyValues: [id], encoding, row: decodeRow(COLUMNS, encoding) };
}

/** A keyless mailing-list member row, keyed by its encoding. */
function member(email: string): CanonicalRow {
  const encoding = encodeRow(MEMBER_COLUMNS, { MLID: 'ML01', Email: email });
  return { table: 'dbo.tmailinglistmembers', key: encoding, keyValues: [], encoding, row: decodeRow(MEMBER_COLUMNS, encoding) };
}

const byEncoding = (rows: readonly CanonicalRow[]): CanonicalRow[] => [...rows].sort((a, b) => compareEncodings(a.encoding, b.encoding));
const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `S${String(index + 1).padStart(3, '0')}`);

const S1 = size('S001');
const S2 = size('S002');
const S3 = size('S003');
const ALL = [S1, S2, S3];
const A = member('a@example.test');
const B = member('b@example.test');

function compareKeyed(legacy: readonly CanonicalRow[], target: readonly CanonicalRow[]): Promise<RowComparison> {
  return compareRows({ keyed: true, columns: COLUMNS, legacy, target });
}

describe('compareRows and isZeroDifference', () => {
  it('measures identical keyed rows as zero difference with equal counts and SHA-256', async () => {
    const rows = await compareKeyed(ALL, ALL.map((row) => ({ ...row })));

    expect(rows).toMatchObject({ legacyCount: 3, targetCount: 3, differences: [], differenceCount: 0 });
    expect(rows.legacySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.targetSha256).toBe(rows.legacySha256);
    expect(isZeroDifference(rows)).toBe(true);
  });

  it.each<{ name: string; target: CanonicalRow[]; counts: [number, number]; kind: DifferenceKind; difference: Partial<Difference> }>([
    {
      name: 'an extra target row',
      target: [...ALL, size('S004')],
      counts: [3, 4],
      kind: 'extra-in-target',
      difference: { key: size('S004').key, column: null, legacy: null, target: size('S004').encoding },
    },
    {
      name: 'a changed column value',
      target: [S1, size('S002', { name: 'Thumbnail' }), S3],
      counts: [3, 3],
      kind: 'changed',
      difference: { key: S2.key, column: 'name', legacy: 'Size S002', target: 'Thumbnail' },
    },
    {
      name: 'a missing target row',
      target: [S1, S3],
      counts: [3, 2],
      kind: 'missing-in-target',
      difference: { key: S2.key, column: null, legacy: S2.encoding, target: null },
    },
  ])('detects $name alone as one $kind difference with differing SHA-256', async ({ target, counts, kind, difference }) => {
    const rows = await compareKeyed(ALL, target);

    expect([rows.legacyCount, rows.targetCount]).toEqual(counts);
    expect(rows.targetSha256).not.toBe(rows.legacySha256);
    expect(rows.differenceCount).toBe(1);
    expect(rows.differences).toEqual([{ kind, ...difference }]);
    expect(isZeroDifference(rows)).toBe(false);
  });

  it('compares keyless rows as multisets, counting the occurrences each side lacks', async () => {
    const rows = await compareRows({ keyed: false, columns: MEMBER_COLUMNS, legacy: byEncoding([A, A, B]), target: byEncoding([B, A, B]) });

    expect(rows).toMatchObject({ legacyCount: 3, targetCount: 3, differenceCount: 2 });
    expect(rows.targetSha256).not.toBe(rows.legacySha256);
    expect(rows.differences).toEqual([
      { kind: 'missing-in-target', key: sha256Hex(A.encoding), column: null, legacy: A.encoding, target: null, occurrences: 1 },
      { kind: 'extra-in-target', key: sha256Hex(B.encoding), column: null, legacy: null, target: B.encoding, occurrences: 1 },
    ]);
  });

  it('caps the difference list at DIFFERENCE_LIMIT while counting every difference', async () => {
    const extra = ids(DIFFERENCE_LIMIT + 50).map((id) => size(id));

    const rows = await compareKeyed([], extra);

    expect(DIFFERENCE_LIMIT).toBe(100);
    expect(rows.differenceCount).toBe(150);
    expect(rows.differences).toHaveLength(100);
    expect(rows.differences.map((difference) => difference.key)).toEqual(extra.slice(0, 100).map((row) => row.key));
  });

  const zeroRows: RowComparison = { legacyCount: 2, targetCount: 2, legacySha256: SHA_1, targetSha256: SHA_1, differences: [], differenceCount: 0 };
  const zeroObjects: ObjectComparison = { legacyObjects: 1, targetObjects: 1, differences: [], differenceCount: 0 };

  it('is zero difference when every measure agrees, with or without an object manifest', () => {
    expect(isZeroDifference(zeroRows, zeroObjects)).toBe(true);
    expect(isZeroDifference(zeroRows, null)).toBe(true);
  });

  it.each<[string, string, RowComparison, ObjectComparison]>([
    ['rowCount', 'target count', { ...zeroRows, targetCount: 3 }, zeroObjects],
    ['sha256', 'target checksum', { ...zeroRows, targetSha256: SHA_2 }, zeroObjects],
    ['differences', 'difference count', { ...zeroRows, differenceCount: 1 }, zeroObjects],
    ['fileManifest', 'object count', zeroRows, { ...zeroObjects, targetObjects: 2 }],
    ['fileManifest', 'object difference count', zeroRows, { ...zeroObjects, differenceCount: 1 }],
  ])('is not zero difference when only %s disagrees (%s)', (measure, _field, rows, objects) => {
    expect(MEASURES).toContain(measure);
    expect(isZeroDifference(rows, objects)).toBe(false);
  });
});

describe('compareObjects', () => {
  const object = (key: string, bytes: number, sha256: string, orphan?: boolean): ObjectEntry => ({ key, size: bytes, sha256, ...(orphan === undefined ? {} : { orphan }) });
  const LEGACY = [object('t/F1.jpg', 10, SHA_1), object('t/F2.pdf', 20, SHA_2), object('t/F3.txt', 5, SHA_3, true)];
  const TARGET = LEGACY.map(({ key, size: bytes, sha256 }) => object(key, bytes, sha256));

  it('finds no difference between equal manifests, orphans included', () => {
    expect(compareObjects(LEGACY, TARGET)).toEqual({ legacyObjects: 3, targetObjects: 3, differences: [], differenceCount: 0 });
  });

  it.each<[string, ObjectEntry[], Difference]>([
    [
      'a missing object',
      TARGET.filter((entry) => entry.key !== 't/F2.pdf'),
      { kind: 'object-missing-in-target', key: 't/F2.pdf', column: null, legacy: SHA_2, target: null },
    ],
    [
      'a size mismatch',
      TARGET.map((entry) => (entry.key === 't/F1.jpg' ? { ...entry, size: 11 } : entry)),
      { kind: 'object-mismatch', key: 't/F1.jpg', column: 'size', legacy: '10', target: '11' },
    ],
    [
      'a SHA-256 mismatch',
      TARGET.map((entry) => (entry.key === 't/F2.pdf' ? { ...entry, sha256: SHA_1 } : entry)),
      { kind: 'object-mismatch', key: 't/F2.pdf', column: 'sha256', legacy: SHA_2, target: SHA_1 },
    ],
    ['a missing orphan object', TARGET.slice(0, 2), { kind: 'object-missing-in-target', key: 't/F3.txt', column: null, legacy: SHA_3, target: null }],
  ])('reports %s as one difference', (_case, target, difference) => {
    const objects = compareObjects(LEGACY, target);

    expect(objects.differenceCount).toBe(1);
    expect(objects.differences).toEqual([difference]);
  });
});

describe('renderValue', () => {
  it.each<[string, string | null, string | null]>([
    ['NULL', null, null],
    ['an empty string', '', ''],
    ['a 1,024-character value', 'x'.repeat(1024), 'x'.repeat(1024)],
    ['a longer value', 'x'.repeat(1025), `sha256:${sha256Hex('x'.repeat(1025))} (1025 chars)`],
  ])('renders %s distinctly', (_case, value, rendered) => {
    expect(renderValue(value)).toBe(rendered);
  });

  it('keeps NULL, empty string and binary values apart in a changed-column difference', async () => {
    const legacy = [size('S001', { name: null, preview: Buffer.from([0xab, 0x01]) })];
    const target = [size('S001', { name: '', preview: Buffer.from([0xab, 0x02]) })];

    const rows = await compareKeyed(legacy, target);

    expect(rows.differences).toEqual([
      { kind: 'changed', key: S1.key, column: 'name', legacy: null, target: '' },
      { kind: 'changed', key: S1.key, column: 'preview', legacy: 'ab01', target: 'ab02' },
    ]);
  });
});

describe('resolvePoint', () => {
  it.each<[string, Partial<ResolvedPoint>]>([
    ['after-backfill', { kind: 'after-backfill', legacySource: 'snapshot', expectedTableVersion: 'v0001', rollback: false }],
    ['after-feed-3', { kind: 'after-feed', feedN: 3, legacySource: 'snapshot', expectedTableVersion: 'v0001', rollback: false }],
    ['after-fault-duplicate-batch', { kind: 'after-fault', fault: 'duplicate-batch', legacySource: 'snapshot', expectedTableVersion: 'v0001', rollback: false }],
    ['after-fault-window-import-interrupted', { kind: 'after-fault', fault: 'window-import-interrupted', legacySource: 'live', expectedTableVersion: 'v0001', rollback: false }],
    ['post-cutover', { kind: 'post-cutover', legacySource: 'live', expectedTableVersion: 'v0002', rollback: false }],
    ['rollback-before', { kind: 'rollback-before', legacySource: 'live', expectedTableVersion: 'v0002', rollback: true }],
    ['rollback-after', { kind: 'rollback-after', legacySource: 'live', expectedTableVersion: 'v0003', rollback: true }],
  ])('resolves %s', (name, expected) => {
    expect(resolvePoint(config, name)).toEqual({ name, ...expected });
  });

  it('accepts an after-fault point for every configured fault', () => {
    expect(config.faults.length).toBeGreaterThan(0);
    for (const { name } of config.faults) expect(resolvePoint(config, `after-fault-${name}`)).toMatchObject({ kind: 'after-fault', fault: name });
  });

  it.each(['after-fault-unknown', 'after-feed-x', 'after-feed-0', 'nonsense'])('rejects %s with ReconcileUsageError naming the valid points', (name) => {
    expect(() => resolvePoint(config, name)).toThrow(ReconcileUsageError);
    expect(() => resolvePoint(config, name)).toThrow(/valid points: after-backfill, after-feed-<n> \(n >= 1\), after-fault-<fault>/);
  });

  it('rejects a point whose pattern the configuration does not enable', () => {
    const narrowed = { faults: config.faults, reconciliationPoints: ['after-backfill'] };

    expect(resolvePoint(narrowed, 'after-backfill').kind).toBe('after-backfill');
    expect(() => resolvePoint(narrowed, 'post-cutover')).toThrow(ReconcileUsageError);
  });
});

/** A unit entry of the image-size unit in `tenantId` comparing `legacy` with `target`. */
async function imageSizeEntry(tenantId: string, legacy: readonly CanonicalRow[], target: readonly CanonicalRow[]): Promise<UnitReport> {
  const rows = await compareKeyed(legacy, target);
  return buildUnitReport({ unit: UNITS.imageSize, owner: 'programs-sites', legacyTable: 'timagesizes', tenantId, rows });
}

function reportOf(point: string, units: readonly UnitReport[], fileStore: FileStoreReport = NO_FILE_STORE): ReconcileReport {
  return buildReport({ point: resolvePoint(config, point), tableVersion: 'v0001', snapshotSeq: 0, legacyDatabase: 'masa_test_opt2_snap_0', units, fileStore });
}

describe('buildReport', () => {
  it('is zero-difference with zero tolerance over the four measures when every unit is zero', async () => {
    const report = reportOf('after-backfill', [await imageSizeEntry(TENANT_Y, [S3], [S3]), await imageSizeEntry(TENANT_X, ALL, ALL)]);

    expect(report).toMatchObject({
      point: 'after-backfill',
      expectedTableVersion: 'v0001',
      tableVersion: 'v0001',
      tableVersionMatches: true,
      legacySource: 'snapshot',
      tolerance: 0,
      result: 'zero-difference',
      summary: { units: 1, tenants: 2, unitsWithDifferences: 0, differences: 0, haltedUnits: 0 },
    });
    expect(report.measures).toEqual([...MEASURES]);
    expect(report.measures).toEqual(['rowCount', 'sha256', 'differences', 'fileManifest']);
    expect(report.units.map((entry) => entry.tenantId)).toEqual([TENANT_X, TENANT_Y]);
  });

  it('is difference when any unit differs', async () => {
    const report = reportOf('after-backfill', [await imageSizeEntry(TENANT_X, ALL, ALL), await imageSizeEntry(TENANT_Y, [S3], [])]);

    expect(report.result).toBe('difference');
    expect(report.summary).toMatchObject({ unitsWithDifferences: 1, differences: 1 });
  });

  it('records a halted file store without letting its uncompared units affect the result', async () => {
    const halted: FileStoreReport = { store: 's3', status: 'halted', reason: 'the legacy file store is s3, not fileDir', haltedUnits: [UNITS.fileObject] };

    const report = reportOf('post-cutover', [await imageSizeEntry(TENANT_X, ALL, ALL)], halted);

    expect(report).toMatchObject({ result: 'zero-difference', fileStore: halted, legacySource: 'live', tableVersionMatches: false });
    expect(report.summary.haltedUnits).toBe(1);
  });
});

describe('writeReconciliationReport', () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  const summaryRows = (markdown: string): string[] => markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Point |'));

  it('writes the point report under the reports directory with the pinned SHA first and regenerates summary.md', async () => {
    t = await buildTestContext({ bridge: false });
    const reconciliationDir = path.join(t.dirs.reportsDir, RECONCILIATION_DIR);

    const written = await writeReconciliationReport(t.ctx, reportOf('after-backfill', [await imageSizeEntry(TENANT_X, ALL, ALL)]));

    expect(written).toBe(path.join(reconciliationDir, 'after-backfill.json'));
    const json = JSON.parse(await readFile(written, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(json).slice(0, 4)).toEqual(['sourceSha', 'generatedBy', 'generatedAt', 'status']);
    expect(json).toMatchObject({
      sourceSha: TEST_SOURCE_SHA,
      generatedBy: GENERATED_BY,
      generatedAt: t.clock.now().toISOString(),
      status: 'generated',
      point: 'after-backfill',
      result: 'zero-difference',
      tolerance: 0,
    });
    expect(GENERATED_BY).toBe('migration/src/reconcile/');

    const first = await readFile(path.join(reconciliationDir, 'summary.md'), 'utf8');
    expect(first.split(`Source SHA: ${TEST_SOURCE_SHA}`)).toHaveLength(2);
    expect(summaryRows(first)).toEqual([expect.stringMatching(/^\| after-backfill \| \[after-backfill\.json\]\(after-backfill\.json\) \| v0001 \|.*\| zero-difference \|$/)]);

    await writeReconciliationReport(t.ctx, reportOf('post-cutover', [await imageSizeEntry(TENANT_X, ALL, [S1])]));

    const second = await readFile(path.join(reconciliationDir, 'summary.md'), 'utf8');
    expect(second.split(`Source SHA: ${TEST_SOURCE_SHA}`)).toHaveLength(2);
    expect(summaryRows(second).map((row) => row.split(' | ')[0])).toEqual(['| after-backfill', '| post-cutover']);
    expect(summaryRows(second)[1]).toMatch(/\| difference \|$/);
    expect((await readdir(reconciliationDir)).sort()).toEqual(['after-backfill.json', 'post-cutover.json', 'summary.md']);
  });

  it('leaves the committed reconciliation reports untouched', async () => {
    expect((await stat(COMMITTED_SUMMARY)).mtimeMs).toBe(committedSummaryMtime);
  });
});

describe('reconcileUnits over the fake legacy database and the owner doubles', () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  function doubles(context: TestContext): OwnerDoubles {
    if (context.owners === null) throw new Error('the test context was built without owner doubles');
    return context.owners;
  }

  /** A seeded context whose gateway reports `v0001`, the version the after-backfill point expects. */
  async function seededContext(): Promise<TestContext> {
    t = await buildTestContext({ legacySeed: true, bridge: false, gateway: { active: 'v0001' } });
    return t;
  }

  /** Seeds the image-size owner with every legacy `timagesizes` row, edited by `edit`, in the tenant the resolver gives it. */
  async function exportImageSizes(context: TestContext, edit: (row: Row) => Row = (row) => row): Promise<CanonicalColumn[]> {
    const database = context.ctx.env.MURA_DATABASE;
    const shape = await describeUnitTable(context.ctx, { unit: UNITS.imageSize, legacyTable: 'timagesizes', database });
    const tenants = await createTenantResolver(context.ctx, { database });
    const owner = doubles(context).owner(shape.owner);
    for (const row of context.legacy.rows(TABLES.timagesizes.qualified)) {
      owner.seedRows('timagesizes', tenants.resolve('timagesizes', row).tenantId, [edit(row)], shape.columns);
    }
    return shape.columns;
  }

  function reconcileImageSizes(context: TestContext): Promise<ReconcileReport> {
    return reconcileUnits(context.ctx, { point: 'after-backfill', units: [UNITS.imageSize], database: context.ctx.env.MURA_DATABASE });
  }

  it('returns a zero-difference report for an owner exporting the legacy rows, and writes nothing', async () => {
    const context = await seededContext();
    await exportImageSizes(context);

    const report = await reconcileImageSizes(context);

    expect(report).toMatchObject({
      point: 'after-backfill',
      tableVersion: 'v0001',
      tableVersionMatches: true,
      legacySource: 'snapshot',
      legacyDatabase: 'masa_test',
      result: 'zero-difference',
      summary: { units: 1, tenants: 2, unitsWithDifferences: 0, differences: 0 },
      fileStore: NO_FILE_STORE,
    });
    for (const entry of report.units) {
      expect(entry).toMatchObject({ unit: UNITS.imageSize, owner: 'programs-sites', legacyCount: 1, targetCount: 1, differenceCount: 0 });
      expect(entry.targetSha256).toBe(entry.legacySha256);
    }
    expect(await readdir(context.dirs.reportsDir)).toEqual([]);
  });

  it('reports one changed field when the owner exports one altered value', async () => {
    const context = await seededContext();
    const thumbnail = context.legacy.rows(TABLES.timagesizes.qualified).find((row) => row.name === 'thumbnail');
    expect(thumbnail).toBeDefined();
    const columns = await exportImageSizes(context, (row) => (row.name === 'thumbnail' ? { ...row, width: '640' } : row));

    const report = await reconcileImageSizes(context);

    expect(report.result).toBe('difference');
    expect(report.summary).toMatchObject({ unitsWithDifferences: 1, differences: 1 });
    const differing = report.units.filter((entry) => entry.differenceCount > 0);
    expect(differing).toHaveLength(1);
    expect(differing[0]?.differences).toEqual([
      { kind: 'changed', key: encodeKey(columns, KEY, thumbnail ?? {}), column: 'width', legacy: '100', target: '640' },
    ]);
    expect(differing[0]?.targetSha256).not.toBe(differing[0]?.legacySha256);
  });

  // compareRows rejects unsorted input, so order independence is shown here, where both sides are sorted before comparing.
  it('finds no difference in a keyless table whose owner holds the same multiset in another order', async () => {
    const context = await seededContext();
    const database = context.ctx.env.MURA_DATABASE;
    const legacyTable = 'tmailinglistmembers';
    const shape = await describeUnitTable(context.ctx, { unit: UNITS.mailingListMember, legacyTable, database });
    const legacy = await readLegacyUnitRows(context.ctx, shape, { database, tenants: await createTenantResolver(context.ctx, { database }) });
    try {
      for (const tenantId of legacy.tenants) {
        const rows: CanonicalRow[] = [];
        for await (const row of legacy.rows(tenantId)) rows.push(row);
        doubles(context).owner(shape.owner).seedRows(legacyTable, tenantId, rows.reverse().map((row) => ({ ...row.row })), shape.columns);
      }
    } finally {
      await legacy.dispose();
    }

    const report = await reconcileUnits(context.ctx, { point: 'after-backfill', units: [UNITS.mailingListMember], database });

    expect(shape.keyed).toBe(false);
    expect(report.result).toBe('zero-difference');
    expect(report.units.map((entry) => [entry.legacyCount, entry.targetCount])).toEqual([[4, 4]]);
  });
});

