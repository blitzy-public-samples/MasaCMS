// Reconciliation points, the point report body and the aggregate `summary.md`, written under the reports directory.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveReportsDir, type MigrationConfig } from '../config.js';
import type { MigrationContext } from '../context.js';
import { readJsonReport, resolveReportTarget, writeJsonReport, writeMarkdownReport, type ReportTarget } from '../reports/index.js';
import { DIFFERENCE_LIMIT, isZeroDifference, mergeDifferences, type Difference, type ObjectComparison, type RowComparison } from './compare.js';

/** Reports subdirectory holding one JSON report per point and `summary.md`. */
export const RECONCILIATION_DIR = 'reconciliation';

/** `generatedBy` of every reconciliation report. */
export const GENERATED_BY = 'migration/src/reconcile/';

/** The zero-tolerance measures every point compares. */
export const MEASURES = ['rowCount', 'sha256', 'differences', 'fileManifest'] as const;

/** One reconciliation measure. */
export type Measure = (typeof MEASURES)[number];

/** Legacy side of a point: a read-only snapshot copy or the live legacy database. */
export type LegacySource = 'snapshot' | 'live';

/** Family of a reconciliation point name. */
export type PointKind = 'after-backfill' | 'after-feed' | 'after-fault' | 'post-cutover' | 'rollback-before' | 'rollback-after';

/** A validated point name with its legacy source and the cut-over version expected to be active. */
export interface ResolvedPoint {
  name: string;
  kind: PointKind;
  feedN?: number;
  fault?: string;
  legacySource: LegacySource;
  expectedTableVersion: string;
  rollback: boolean;
}

/** An unknown point or another invalid reconcile request; the CLI exits 2 on it. */
export class ReconcileUsageError extends Error {
  override readonly name = 'ReconcileUsageError';
  readonly exitCode = 2;
}

const SUMMARY_FILE = 'summary.md';
const PENDING = 'pending-run';
const ZERO_DIFFERENCE = 'zero-difference';
const FEED_POINT = /^after-feed-([1-9]\d*)$/;
const FAULT_PREFIX = 'after-fault-';
const EXACT_KINDS: ReadonlySet<string> = new Set<PointKind>(['after-backfill', 'post-cutover', 'rollback-before', 'rollback-after']);
const TAIL_POINTS = ['post-cutover', 'rollback-before', 'rollback-after'];

/** `config.reconciliationPoints` spelling of each kind. */
const PATTERN_OF: Readonly<Record<PointKind, string>> = {
  'after-backfill': 'after-backfill',
  'after-feed': 'after-feed-{n}',
  'after-fault': 'after-fault-{fault}',
  'post-cutover': 'post-cutover',
  'rollback-before': 'rollback-before',
  'rollback-after': 'rollback-after',
};

// `config.reconciliationPoints` lists point names only, so the version and legacy source of each kind are fixed here,
// equal to the committed placeholder reports.
const POINT_DEFAULTS: Readonly<Record<PointKind, { expectedTableVersion: string; legacySource: LegacySource }>> = {
  'after-backfill': { expectedTableVersion: 'v0001', legacySource: 'snapshot' },
  'after-feed': { expectedTableVersion: 'v0001', legacySource: 'snapshot' },
  'after-fault': { expectedTableVersion: 'v0001', legacySource: 'snapshot' },
  'post-cutover': { expectedTableVersion: 'v0002', legacySource: 'live' },
  'rollback-before': { expectedTableVersion: 'v0002', legacySource: 'live' },
  'rollback-after': { expectedTableVersion: 'v0003', legacySource: 'live' },
};

/** Faults reconciled against the live database: an interrupted window import resumes against what legacy committed. */
const LIVE_FAULTS: ReadonlySet<string> = new Set(['window-import-interrupted']);

type PointConfig = Pick<MigrationConfig, 'faults' | 'reconciliationPoints'>;

/** Kind and parameters of `name`, or `undefined` when it names no point of `config`. */
function matchPoint(config: PointConfig, name: string): Pick<ResolvedPoint, 'kind' | 'feedN' | 'fault'> | undefined {
  if (EXACT_KINDS.has(name)) return { kind: name as PointKind };
  const feed = FEED_POINT.exec(name);
  if (feed !== null) {
    const feedN = Number(feed[1]);
    return Number.isSafeInteger(feedN) ? { kind: 'after-feed', feedN } : undefined;
  }
  if (name.startsWith(FAULT_PREFIX)) {
    const fault = name.slice(FAULT_PREFIX.length);
    if (config.faults.some((entry) => entry.name === fault)) return { kind: 'after-fault', fault };
  }
  return undefined;
}

/** Human-readable list of the point names `config` accepts. */
function validPoints(config: PointConfig): string {
  const faults = config.faults.map((fault) => fault.name).join(' | ');
  return config.reconciliationPoints
    .map((pattern) => {
      if (pattern === PATTERN_OF['after-feed']) return 'after-feed-<n> (n >= 1)';
      if (pattern === PATTERN_OF['after-fault']) return `after-fault-<fault> (<fault>: ${faults})`;
      return pattern;
    })
    .join(', ');
}

/**
 * Resolves `name` against the points `config.reconciliationPoints` enables and the faults `config.faults` lists.
 * @throws ReconcileUsageError naming the valid points when `name` matches none.
 */
export function resolvePoint(config: PointConfig, name: string): ResolvedPoint {
  const match = matchPoint(config, name);
  if (match === undefined || !config.reconciliationPoints.includes(PATTERN_OF[match.kind])) {
    throw new ReconcileUsageError(`Unknown reconciliation point "${name}"; valid points: ${validPoints(config)}`);
  }
  const defaults = POINT_DEFAULTS[match.kind];
  const live = match.fault !== undefined && LIVE_FAULTS.has(match.fault);
  return {
    name,
    ...match,
    legacySource: live ? 'live' : defaults.legacySource,
    expectedTableVersion: defaults.expectedTableVersion,
    rollback: match.kind === 'rollback-before' || match.kind === 'rollback-after',
  };
}

/** Row count and checksum of one side of a unit entry. */
export interface SideMeasures {
  rowCount: number;
  sha256: string;
}

/**
 * One unit, legacy table and tenant compared. `legacy`/`target` and the flat `legacyCount`, `targetCount`,
 * `legacySha256`, `targetSha256` carry the same values; `differences` lists row then object differences.
 */
export interface UnitReport {
  unit: string;
  owner: string;
  legacyTable: string | null;
  tenantId: string;
  status: 'compared';
  legacy: SideMeasures;
  target: SideMeasures;
  legacyCount: number;
  targetCount: number;
  legacySha256: string;
  targetSha256: string;
  differenceCount: number;
  differences: Difference[];
  excludedColumns: string[];
  files: ObjectComparison | null;
  orphans: string[];
  orphanCount: number;
}

/** Inputs of {@link buildUnitReport}. */
export interface UnitReportInput {
  unit: string;
  owner: string;
  legacyTable: string | null;
  tenantId: string;
  rows: RowComparison;
  /** Object-manifest comparison of a file unit; its differences follow the row differences. */
  files?: ObjectComparison | null;
  excludedColumns?: readonly string[];
  /** Keys of legacy rows without a resolvable parent; the first {@link DIFFERENCE_LIMIT} are listed. */
  orphans?: readonly string[];
  /** Total orphans when `orphans` is already capped; defaults to `orphans.length`. */
  orphanCount?: number;
}

/** Builds one unit entry from its row comparison and, for file units, its object comparison. */
export function buildUnitReport(input: UnitReportInput): UnitReport {
  const { rows } = input;
  const files = input.files ?? null;
  const merged = files === null ? rows : mergeDifferences(DIFFERENCE_LIMIT, rows, files);
  const orphans = input.orphans ?? [];
  return {
    unit: input.unit,
    owner: input.owner,
    legacyTable: input.legacyTable,
    tenantId: input.tenantId,
    status: 'compared',
    legacy: { rowCount: rows.legacyCount, sha256: rows.legacySha256 },
    target: { rowCount: rows.targetCount, sha256: rows.targetSha256 },
    legacyCount: rows.legacyCount,
    targetCount: rows.targetCount,
    legacySha256: rows.legacySha256,
    targetSha256: rows.targetSha256,
    differenceCount: merged.differenceCount,
    differences: [...merged.differences],
    excludedColumns: [...(input.excludedColumns ?? [])],
    files,
    orphans: orphans.slice(0, DIFFERENCE_LIMIT),
    orphanCount: input.orphanCount ?? orphans.length,
  };
}

/** File-store state of a point: compared, halted for a store other than `fileDir` (its units never move), or no file unit. */
export interface FileStoreReport {
  store: string | null;
  status: 'compared' | 'halted' | 'not-applicable';
  reason?: string;
  haltedUnits: string[];
}

/** Counts over a point's unit entries. */
export interface ReconcileSummary {
  units: number;
  tenants: number;
  unitsWithDifferences: number;
  differences: number;
  orphans: number;
  haltedUnits: number;
}

/** Verdict of a point; `gateway/src/cutover/validate.ts` accepts rollback evidence only when it is `zero-difference`. */
export type ReconcileResult = 'zero-difference' | 'difference';

/** Body of `reconciliation/<point>.json`; `writeJsonReport` prepends `sourceSha`, `generatedBy`, `generatedAt` and `status`. */
export interface ReconcileReport {
  point: string;
  expectedTableVersion: string;
  tableVersion: string | null;
  tableVersionMatches: boolean;
  snapshotSeq: number | null;
  legacySource: LegacySource;
  legacyDatabase: string;
  tolerance: 0;
  measures: Measure[];
  units: UnitReport[];
  summary: ReconcileSummary;
  fileStore: FileStoreReport;
  result: ReconcileResult;
}

/** Inputs of {@link buildReport}; `legacySource` overrides the point's own. */
export interface BuildReportInput {
  point: ResolvedPoint;
  legacySource?: LegacySource;
  tableVersion: string | null;
  snapshotSeq: number | null;
  legacyDatabase: string;
  units: readonly UnitReport[];
  fileStore: FileStoreReport;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareUnitReports(a: UnitReport, b: UnitReport): number {
  return compareText(a.unit, b.unit) || compareText(a.legacyTable ?? '', b.legacyTable ?? '') || compareText(a.tenantId, b.tenantId);
}

/** True when the entry's counts, checksums, difference list and object manifest all agree. */
function isZeroEntry(entry: UnitReport): boolean {
  return isZeroDifference(entry, entry.files);
}

/** Assembles a point report: entries sorted by unit, legacy table and tenant; halted file units leave `result` unaffected. */
export function buildReport(input: BuildReportInput): ReconcileReport {
  const units = [...input.units].sort(compareUnitReports);
  const differing = units.filter((entry) => !isZeroEntry(entry));
  return {
    point: input.point.name,
    expectedTableVersion: input.point.expectedTableVersion,
    tableVersion: input.tableVersion,
    tableVersionMatches: input.tableVersion === input.point.expectedTableVersion,
    snapshotSeq: input.snapshotSeq,
    legacySource: input.legacySource ?? input.point.legacySource,
    legacyDatabase: input.legacyDatabase,
    tolerance: 0,
    measures: [...MEASURES],
    units,
    summary: {
      units: new Set(units.map((entry) => entry.unit)).size,
      tenants: new Set(units.map((entry) => entry.tenantId)).size,
      unitsWithDifferences: new Set(differing.map((entry) => entry.unit)).size,
      differences: units.reduce((sum, entry) => sum + entry.differenceCount, 0),
      orphans: units.reduce((sum, entry) => sum + entry.orphanCount, 0),
      haltedUnits: input.fileStore.haltedUnits.length,
    },
    fileStore: input.fileStore,
    result: differing.length === 0 ? 'zero-difference' : 'difference',
  };
}

/** What writing a point report needs from the migration context. */
export type ReconcileReportContext = Pick<MigrationContext, 'clock'> & {
  readonly config: Pick<MigrationContext['config'], 'paths' | 'faults'>;
  readonly env: Pick<MigrationContext['env'], 'OPT2_REPORTS_DIR'>;
};

/** Report target: `OPT2_REPORTS_DIR` or the configured reports directory, stamped with the SHA of `opt2/source-pin.json`. */
export function reportTargetFor(ctx: Pick<ReconcileReportContext, 'config' | 'env'>): ReportTarget {
  return resolveReportTarget({ reportsDir: resolveReportsDir(ctx.config, ctx.env), sourceShaFile: ctx.config.paths.sourcePin });
}

/** Writes `reconciliation/<point>.json`, regenerates `summary.md` and returns the report's absolute path. */
export async function writeReconciliationReport(ctx: ReconcileReportContext, report: ReconcileReport): Promise<string> {
  const target = reportTargetFor(ctx);
  const written = await writeJsonReport(target, `${RECONCILIATION_DIR}/${report.point}.json`, { ...report }, {
    clock: ctx.clock,
    generatedBy: GENERATED_BY,
    status: 'generated',
  });
  await regenerateSummary(target, ctx.config);
  return written.path;
}

/** One `summary.md` row, read from one JSON file of the reconciliation directory. */
export interface SummaryRow {
  point: string;
  file: string;
  tableVersion: string | null;
  expectedTableVersion: string | null;
  units: number | null;
  unitsWithDifferences: number | null;
  orphans: number | null;
  result: string;
}

/** The fields of a stored report the summary reads; placeholders and foreign files may lack any of them. */
interface StoredReport {
  point?: unknown;
  tableVersion?: unknown;
  expectedTableVersion?: unknown;
  summary?: { units?: unknown; unitsWithDifferences?: unknown; orphans?: unknown } | null;
  result?: unknown;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const countOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function summaryRow(file: string, report: StoredReport): SummaryRow {
  return {
    point: textOrNull(report.point) ?? path.basename(file, '.json'),
    file,
    tableVersion: textOrNull(report.tableVersion),
    expectedTableVersion: textOrNull(report.expectedTableVersion),
    units: countOrNull(report.summary?.units),
    unitsWithDifferences: countOrNull(report.summary?.unitsWithDifferences),
    orphans: countOrNull(report.summary?.orphans),
    result: textOrNull(report.result) ?? 'missing',
  };
}

/** Regenerates `reconciliation/summary.md` from every JSON report in the directory and returns its absolute path. */
export async function regenerateSummary(target: ReportTarget, config: Pick<MigrationConfig, 'faults'>): Promise<string> {
  const names = (await readdir(path.join(target.reportsDir, RECONCILIATION_DIR))).filter(
    (name) => name.endsWith('.json') && !name.startsWith('.'),
  );
  const rows: SummaryRow[] = [];
  for (const name of names) {
    const report = await readJsonReport<StoredReport>(target.reportsDir, `${RECONCILIATION_DIR}/${name}`);
    if (report !== undefined) rows.push(summaryRow(name, report));
  }
  const markdown = renderSummary(rows, target.sourceSha, config.faults.map((fault) => fault.name));
  return (await writeMarkdownReport(target, `${RECONCILIATION_DIR}/${SUMMARY_FILE}`, markdown)).path;
}

/** Sort rank of a point: backfill, feeds by number, faults in configured order, cut-over, rollback, then the rest. */
function rankOf(point: string, faults: readonly string[]): [number, number] {
  if (point === 'after-backfill') return [0, 0];
  const feed = FEED_POINT.exec(point);
  if (feed !== null) return [1, Number(feed[1])];
  if (point.startsWith(FAULT_PREFIX)) {
    const index = faults.indexOf(point.slice(FAULT_PREFIX.length));
    if (index >= 0) return [2, index];
  }
  const tail = TAIL_POINTS.indexOf(point);
  return tail >= 0 ? [3 + tail, 0] : [3 + TAIL_POINTS.length, 0];
}

/** Table cell text: pipes escaped and line breaks collapsed, so a value cannot split the row. */
function cell(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

function countCell(value: number | null): string {
  return value === null ? 'none' : String(value);
}

function versionCell(row: SummaryRow): string {
  if (row.tableVersion === null) return 'none';
  const mismatch = row.expectedTableVersion !== null && row.expectedTableVersion !== row.tableVersion;
  return mismatch ? `${row.tableVersion} (expected ${row.expectedTableVersion})` : row.tableVersion;
}

function renderRow(row: SummaryRow): string {
  const link = `[${cell(row.file)}](${encodeURIComponent(row.file)})`;
  const values =
    row.result === PENDING
      ? [PENDING, PENDING, PENDING, PENDING, PENDING]
      : [versionCell(row), countCell(row.units), countCell(row.unitsWithDifferences), countCell(row.orphans), row.result];
  return `| ${[cell(row.point), link, ...values.map(cell)].join(' | ')} |`;
}

/** `yes` when every point is zero-difference, `no` when any differs, otherwise `pending`. */
function passVerdict(rows: readonly SummaryRow[]): 'yes' | 'no' | 'pending' {
  if (rows.some((row) => row.result === 'difference')) return 'no';
  return rows.length > 0 && rows.every((row) => row.result === ZERO_DIFFERENCE) ? 'yes' : 'pending';
}

/** Renders `summary.md` with rows in point order; `faults` gives the order of `after-fault-<fault>` rows. */
export function renderSummary(rows: readonly SummaryRow[], sha: string, faults: readonly string[] = []): string {
  const ordered = [...rows].sort((a, b) => {
    const [groupA, indexA] = rankOf(a.point, faults);
    const [groupB, indexB] = rankOf(b.point, faults);
    return groupA - groupB || indexA - indexB || compareText(a.file, b.file);
  });
  return [
    '# Reconciliation summary',
    '',
    `Source SHA: ${sha}`,
    'Status: generated',
    `Generated by: ${GENERATED_BY}`,
    '',
    `Zero difference at every point: ${passVerdict(ordered)}`,
    '',
    '| Point | Report | Table version | Units | Differences | Orphans | Result |',
    '|---|---|---|---|---|---|---|',
    ...ordered.map(renderRow),
    '',
  ].join('\n');
}
