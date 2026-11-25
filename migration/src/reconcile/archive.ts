// Committed reconciliation evidence as one full baseline report plus difference records against it; the runtime writer is untouched.
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, resolveReportsDir } from '../config.js';
import { readSourceSha, writeFileAtomic } from '../reports/index.js';
import { RECONCILIATION_DIR, renderSummary, type SummaryRow } from './report.js';

/** Subdirectory of `reconciliation/` holding the archived points. */
export const ARCHIVE_DIR = 'archive';

/** `generatedBy` of every difference record. */
export const ARCHIVE_GENERATED_BY = 'migration/src/reconcile/archive.ts';

/** Points that stay full at their runtime path, outside the archive. */
export const KEPT_IN_PLACE: readonly string[] = ['rollback-before'];

/** Rule of every redaction a record lists. */
export const REDACTION_RULE = 'absolute path made repository-relative';

/** A parsed JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

/** A parsed JSON object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Object key or array index. */
export type PathSegment = string | number;

/** One edit, applied in record order to the baseline report. */
export type Operation =
  | { op: 'set'; path: PathSegment[]; value: JsonValue }
  | { op: 'delete'; path: PathSegment[] }
  | { op: 'splice'; path: PathSegment[]; index: number; remove: number; insert: JsonValue[] };

/** A value replaced before archiving. */
export interface Redaction {
  path: PathSegment[];
  rule: string;
}

/** A point stored as the operations that turn the baseline report into its own. */
export interface DifferenceRecord {
  sourceSha: string;
  generatedBy: string;
  point: string;
  tableVersion: string | null;
  snapshotSeq: number | null;
  result: string;
  /** The baseline point the operations apply to. */
  base: string;
  /** SHA-256 of the reconstructed report's compact bytes. */
  sha256: string;
  redactions?: Redaction[];
  operations: Operation[];
}

/** One archive file: the full baseline report or a difference record. */
export type ArchiveDocument = JsonObject | DifferenceRecord;

/** A malformed, inconsistent or unreconstructible archive. */
export class ArchiveError extends Error {
  override readonly name = 'ArchiveError';
}

const ABSOLUTE_REPORT_PATH = /^\/(?:.*\/)?(opt2\/reports\/[^/].*)$/;

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `doc` is a difference record rather than a full report. */
export function isDifferenceRecord(doc: ArchiveDocument): doc is DifferenceRecord {
  return typeof doc.base === 'string' && Array.isArray(doc.operations);
}

/** The compact bytes a report file holds: `JSON.stringify` plus one newline. */
export function reportBytes(report: unknown): string {
  return `${JSON.stringify(report)}\n`;
}

/** SHA-256 hex of {@link reportBytes}. */
export function reportSha256(report: unknown): string {
  return createHash('sha256').update(reportBytes(report)).digest('hex');
}

const sizeOf = (ops: readonly Operation[]): number => JSON.stringify(ops).length;

/** Operations turning `base` into `target`; each subtree keeps the cheaper of its edits or one `set`. */
export function diffJson(base: JsonValue, target: JsonValue, at: PathSegment[] = []): Operation[] {
  if (JSON.stringify(base) === JSON.stringify(target)) return [];
  const replace: Operation[] = [{ op: 'set', path: at, value: target }];
  let ops: Operation[] | undefined;
  if (Array.isArray(base) && Array.isArray(target)) ops = diffArray(base, target, at);
  else if (isObject(base) && isObject(target)) ops = diffObject(base, target, at);
  return ops !== undefined && sizeOf(ops) < sizeOf(replace) ? ops : replace;
}

/** Per-key edits, or `undefined` when the target's key order cannot come from deletes and appended sets. */
function diffObject(base: JsonObject, target: JsonObject, at: PathSegment[]): Operation[] | undefined {
  const targetKeys = Object.keys(target);
  const kept = Object.keys(base).filter((key) => Object.hasOwn(target, key));
  const order = [...kept, ...targetKeys.filter((key) => !Object.hasOwn(base, key))];
  if (order.some((key, i) => key !== targetKeys[i])) return undefined;
  const ops: Operation[] = Object.keys(base)
    .filter((key) => !Object.hasOwn(target, key))
    .map((key): Operation => ({ op: 'delete', path: [...at, key] }));
  for (const key of targetKeys) {
    const value = target[key] as JsonValue;
    if (Object.hasOwn(base, key)) ops.push(...diffJson(base[key] as JsonValue, value, [...at, key]));
    else ops.push({ op: 'set', path: [...at, key], value });
  }
  return ops;
}

/** Common prefix and suffix kept, the middle paired by position, and one `splice` for the surplus. */
function diffArray(base: readonly JsonValue[], target: readonly JsonValue[], at: PathSegment[]): Operation[] {
  const baseText = base.map((value) => JSON.stringify(value));
  const targetText = target.map((value) => JSON.stringify(value));
  const shorter = Math.min(base.length, target.length);
  let start = 0;
  while (start < shorter && baseText[start] === targetText[start]) start++;
  let end = 0;
  while (end < shorter - start && baseText[base.length - 1 - end] === targetText[target.length - 1 - end]) end++;
  const paired = shorter - start - end;
  const ops: Operation[] = [];
  for (let i = start; i < start + paired; i++) ops.push(...diffJson(base[i] as JsonValue, target[i] as JsonValue, [...at, i]));
  const index = start + paired;
  const remove = base.length - end - index;
  const insert = target.slice(index, target.length - end);
  if (remove > 0 || insert.length > 0) ops.push({ op: 'splice', path: at, index, remove, insert });
  return ops;
}

/** The value at `at` under `root`; throws when a segment does not resolve. */
function valueAt(root: JsonValue, at: readonly PathSegment[]): JsonValue {
  let node = root;
  for (const segment of at) {
    if (Array.isArray(node) && typeof segment === 'number' && segment >= 0 && segment < node.length) node = node[segment] as JsonValue;
    else if (isObject(node) && typeof segment === 'string' && Object.hasOwn(node, segment)) node = node[segment] as JsonValue;
    else throw new ArchiveError(`No value at ${JSON.stringify(at)}`);
  }
  return node;
}

function applyOne(root: JsonValue, op: Operation): JsonValue {
  const fail = (): never => {
    throw new ArchiveError(`Cannot ${String((op as { op?: unknown }).op)} at ${JSON.stringify(op.path)}`);
  };
  if (!Array.isArray(op.path)) return fail();
  if (op.op === 'set' && op.path.length === 0) return structuredClone(op.value);
  if (op.op === 'splice') {
    const node = valueAt(root, op.path);
    const { index, remove, insert } = op;
    if (!Array.isArray(node) || !Array.isArray(insert) || !Number.isInteger(index) || !Number.isInteger(remove)) return fail();
    if (index < 0 || remove < 0 || index + remove > node.length) return fail();
    node.splice(index, remove, ...structuredClone(insert));
    return root;
  }
  if (op.op !== 'set' && op.op !== 'delete') return fail();
  const parent = valueAt(root, op.path.slice(0, -1));
  const last = op.path.at(-1);
  if (op.op === 'set' && Array.isArray(parent) && typeof last === 'number' && last >= 0 && last < parent.length) parent[last] = structuredClone(op.value);
  else if (op.op === 'set' && isObject(parent) && typeof last === 'string') parent[last] = structuredClone(op.value);
  else if (op.op === 'delete' && isObject(parent) && typeof last === 'string' && Object.hasOwn(parent, last)) delete parent[last];
  else fail();
  return root;
}

/** `base` with `ops` applied in order; `base` itself is not modified. */
export function applyOperations(base: JsonValue, ops: readonly Operation[]): JsonValue {
  return ops.reduce(applyOne, structuredClone(base));
}

/** `report` with every absolute path into `opt2/reports/` cut to its repository-relative form, and where each was. */
export function redactReport(report: JsonObject): { report: JsonObject; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  const visit = (value: JsonValue, at: PathSegment[]): JsonValue => {
    if (typeof value === 'string') {
      const relative = ABSOLUTE_REPORT_PATH.exec(value)?.[1];
      if (relative === undefined) return value;
      redactions.push({ path: at, rule: REDACTION_RULE });
      return relative;
    }
    if (Array.isArray(value)) return value.map((item, i) => visit(item, [...at, i]));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...at, key])]));
    return value;
  };
  return { report: visit(report, []) as JsonObject, redactions };
}

const textOrNull = (value: JsonValue | undefined): string | null => (typeof value === 'string' ? value : null);
const countOrNull = (value: JsonValue | undefined): number | null => (typeof value === 'number' ? value : null);

/** The identity fields a record copies from its report. */
function identityOf(report: JsonObject): Pick<DifferenceRecord, 'generatedBy' | 'point' | 'tableVersion' | 'snapshotSeq' | 'result'> {
  return {
    generatedBy: ARCHIVE_GENERATED_BY,
    point: textOrNull(report.point) ?? 'missing',
    tableVersion: textOrNull(report.tableVersion),
    snapshotSeq: countOrNull(report.snapshotSeq),
    result: textOrNull(report.result) ?? 'missing',
  };
}

/** The record storing `report` as operations on `baseReport` of point `base`. */
export function buildRecord(args: {
  report: JsonObject;
  base: string;
  baseReport: JsonObject;
  sourceSha: string;
  redactions?: readonly Redaction[];
}): DifferenceRecord {
  const { report } = args;
  return {
    sourceSha: args.sourceSha,
    ...identityOf(report),
    base: args.base,
    sha256: reportSha256(report),
    ...(args.redactions !== undefined && args.redactions.length > 0 ? { redactions: [...args.redactions] } : {}),
    operations: diffJson(args.baseReport, report),
  };
}

/** The archive of a set of points: the point stored in full, and the redactions of every point that had any. */
export interface ArchivePlan {
  baseline: string;
  redactions: Record<string, Redaction[]>;
}

/**
 * Archives `reports` (point name to full report): redacts each, stores in full the baseline whose records against it total
 * fewest bytes (ties go to the earlier name), and every other point as a record against it.
 */
export function buildArchive(reports: Readonly<Record<string, JsonObject>>, sourceSha: string): { plan: ArchivePlan; documents: Record<string, ArchiveDocument> } {
  const names = Object.keys(reports).sort();
  if (names.length === 0) throw new ArchiveError('No reports to archive');
  const redacted = new Map(
    names.map((name) => {
      const entry = redactReport(reports[name] as JsonObject);
      if (entry.report.point !== name) throw new ArchiveError(`${name}.json records point ${JSON.stringify(entry.report.point)}`);
      return [name, entry] as const;
    }),
  );
  let best: { baseline: string; bytes: number; records: Record<string, DifferenceRecord> } | undefined;
  for (const [baseline, { report: baseReport }] of redacted) {
    const records = Object.fromEntries(
      [...redacted].filter(([name]) => name !== baseline).map(([name, entry]) => [name, buildRecord({ ...entry, base: baseline, baseReport, sourceSha })]),
    );
    const bytes = Object.values(records).reduce((sum, record) => sum + Buffer.byteLength(reportBytes(record)), 0);
    if (best === undefined || bytes < best.bytes) best = { baseline, bytes, records };
  }
  const { baseline, records } = best as NonNullable<typeof best>;
  const redactions = Object.fromEntries([...redacted].filter(([, entry]) => entry.redactions.length > 0).map(([name, entry]) => [name, entry.redactions]));
  return { plan: { baseline, redactions }, documents: { [baseline]: (redacted.get(baseline) as { report: JsonObject }).report, ...records } };
}

/** The full report of `point`: a copy of the baseline, or the baseline with the record's operations applied and its SHA-256 checked. */
export function reconstructPoint(archive: ReadonlyMap<string, ArchiveDocument>, point: string): JsonObject {
  const doc = archive.get(point);
  if (doc === undefined) throw new ArchiveError(`No archived point ${point}`);
  let report: JsonValue;
  if (isDifferenceRecord(doc)) {
    const base = archive.get(doc.base);
    if (base === undefined) throw new ArchiveError(`No archived point ${doc.base}`);
    if (isDifferenceRecord(base)) throw new ArchiveError(`${point}: base ${doc.base} is a difference record, not the full baseline`);
    try {
      report = applyOperations(base, doc.operations);
    } catch (error) {
      throw new ArchiveError(`${point}: ${(error as Error).message}`);
    }
    if (!isObject(report) || reportSha256(report) !== doc.sha256) throw new ArchiveError(`${point}: reconstructed report does not match sha256 ${doc.sha256}`);
  } else {
    report = structuredClone(doc);
  }
  if (report.point !== point) throw new ArchiveError(`${point}: report records point ${JSON.stringify(report.point)}`);
  return report;
}

/** One verified archived point. */
export interface VerifiedPoint {
  point: string;
  base: string | null;
  sha256: string;
  result: string | null;
}

/**
 * Reconstructs every point and checks one full baseline exists, every record's `base` names it, every file and report carries
 * `sourceSha`, and each record's identity fields equal its report's.
 * @throws ArchiveError listing every problem.
 */
export function verifyArchive(archive: ReadonlyMap<string, ArchiveDocument>, sourceSha: string): { baseline: string; points: VerifiedPoint[] } {
  const problems: string[] = [];
  const points: VerifiedPoint[] = [];
  const baselines = [...archive].filter(([, doc]) => !isDifferenceRecord(doc)).map(([name]) => name);
  if (baselines.length !== 1) problems.push(`Expected one full baseline, found ${String(baselines.length)}: ${baselines.join(', ')}`);
  for (const [point, doc] of [...archive].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isDifferenceRecord(doc) && baselines.length === 1 && doc.base !== baselines[0]) {
      problems.push(`${point}: base ${doc.base} is not the baseline ${String(baselines[0])}`);
    }
    try {
      const report = reconstructPoint(archive, point);
      if (doc.sourceSha !== sourceSha || report.sourceSha !== sourceSha) problems.push(`${point}: sourceSha is not ${sourceSha}`);
      if (isDifferenceRecord(doc)) {
        const expected = identityOf(report);
        for (const key of ['generatedBy', 'point', 'tableVersion', 'snapshotSeq', 'result'] as const) {
          if (doc[key] !== expected[key]) problems.push(`${point}: ${key} ${JSON.stringify(doc[key])} differs from ${JSON.stringify(expected[key])}`);
        }
      }
      points.push({ point, base: isDifferenceRecord(doc) ? doc.base : null, sha256: reportSha256(report), result: textOrNull(report.result) });
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (problems.length > 0) throw new ArchiveError(problems.join('\n'));
  return { baseline: baselines[0] as string, points };
}

/** Every `*.json` file of `dir`, keyed by name without `.json`. */
async function readJsonDir(dir: string): Promise<Map<string, JsonObject>> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
  const docs = new Map<string, JsonObject>();
  for (const name of names) docs.set(path.basename(name, '.json'), JSON.parse(await readFile(path.join(dir, name), 'utf8')) as JsonObject);
  return docs;
}

/** The archive files of `dir`. */
export async function readArchive(dir: string): Promise<Map<string, ArchiveDocument>> {
  return readJsonDir(dir);
}

const SUMMARY_FILE = 'summary.md';

/** `summary.md` as the runtime writer renders `sources`, with archived points linked into the archive and the Archive paragraph. */
function archiveSummary(sources: ReadonlyMap<string, JsonObject>, plan: ArchivePlan, sourceSha: string, faults: readonly string[]): string {
  const rows = [...sources].map(([name, report]): SummaryRow => {
    const counts = isObject(report.summary) ? report.summary : {};
    return {
      point: textOrNull(report.point) ?? name,
      file: `${name}.json`,
      tableVersion: textOrNull(report.tableVersion),
      expectedTableVersion: textOrNull(report.expectedTableVersion),
      units: countOrNull(counts.units),
      unitsWithDifferences: countOrNull(counts.unitsWithDifferences),
      orphans: countOrNull(counts.orphans),
      result: textOrNull(report.result) ?? 'missing',
    };
  });
  const links = [...sources.keys()]
    .filter((name) => !KEPT_IN_PLACE.includes(name))
    .map((name) => {
      const href = encodeURIComponent(`${name}.json`);
      return [`| [${name}.json](${href}) |`, `| [${ARCHIVE_DIR}/${name}.json](${ARCHIVE_DIR}/${href}) |`] as const;
    });
  const lines = renderSummary(rows, sourceSha, faults)
    .split('\n')
    .map((line) => links.reduce((text, [from, to]) => text.replace(from, to), line));
  const kept = KEPT_IN_PLACE.map((name) => `\`${name}\``).join(', ');
  const redactions = plan.redactions[plan.baseline] ?? [];
  const redacted = redactions.length === 0 ? '' : ` The baseline's redactions: ${redactions.map((entry) => `\`${JSON.stringify(entry.path)}\` (${entry.rule})`).join(', ')}.`;
  const verdict = lines.findIndex((line) => line.startsWith('Zero difference at every point: '));
  if (verdict < 0) throw new ArchiveError('Rendered summary.md has no verdict line');
  lines.splice(
    verdict + 2,
    0,
    `Archive: [\`${ARCHIVE_DIR}/\`](${ARCHIVE_DIR}/) holds every point but ${kept} as one full baseline report (\`${plan.baseline}.json\`) plus difference records that \`${ARCHIVE_GENERATED_BY}\` reconstructs.${redacted}`,
    '',
  );
  return lines.join('\n');
}

/**
 * Archives every point report of `sourceDir` but {@link KEPT_IN_PLACE} into `archiveDir`, removing stale archive files, then
 * writes the kept reports and `summary.md` (rows in `faults` order) beside it and removes the archived points' copies there.
 * @throws ArchiveError, before anything is written, when a report's `point` is not its file name, its `sourceSha` is not
 * `sourceSha`, or the archive does not verify.
 */
export async function writeArchive(sourceDir: string, archiveDir: string, sourceSha: string, faults: readonly string[]): Promise<ArchivePlan> {
  const sources = await readJsonDir(sourceDir);
  const missing = KEPT_IN_PLACE.filter((name) => !sources.has(name));
  if (missing.length > 0) throw new ArchiveError(`${sourceDir} has no ${missing.map((name) => `${name}.json`).join(', ')}`);
  for (const name of KEPT_IN_PLACE) verifyArchive(new Map([[name, sources.get(name) as JsonObject]]), sourceSha);
  const { plan, documents } = buildArchive(Object.fromEntries([...sources].filter(([name]) => !KEPT_IN_PLACE.includes(name))), sourceSha);
  verifyArchive(new Map(Object.entries(documents)), sourceSha);
  for (const [point, doc] of Object.entries(documents)) await writeFileAtomic(path.join(archiveDir, `${point}.json`), reportBytes(doc));
  for (const stale of [...(await readJsonDir(archiveDir)).keys()].filter((name) => !Object.hasOwn(documents, name))) {
    await unlink(path.join(archiveDir, `${stale}.json`));
  }
  const dir = path.dirname(archiveDir);
  for (const name of KEPT_IN_PLACE) await writeFileAtomic(path.join(dir, `${name}.json`), reportBytes(sources.get(name)));
  for (const point of Object.keys(documents)) await rm(path.join(dir, `${point}.json`), { force: true });
  await writeFileAtomic(path.join(dir, SUMMARY_FILE), archiveSummary(sources, plan, sourceSha, faults));
  return plan;
}

const USAGE = 'archive.ts build <source-dir> [archive-dir] | verify [archive-dir] | show <point> [archive-dir]';

/** CLI: `build`, `verify` or `show`; the archive directory defaults to the reports directory's. Returns the exit code. */
export async function main(argv: readonly string[], out: (line: string) => void = (line) => process.stdout.write(line)): Promise<number> {
  const config = loadConfig();
  const sourceSha = readSourceSha(config.paths.sourcePin);
  const [command, first, second] = argv;
  const defaultDir = path.join(resolveReportsDir(config, process.env), RECONCILIATION_DIR, ARCHIVE_DIR);
  if (command === 'build' && first !== undefined) {
    const faults = config.faults.map((fault) => fault.name);
    out(`${JSON.stringify(await writeArchive(first, second ?? defaultDir, sourceSha, faults))}\n`);
    return 0;
  }
  if (command === 'verify' && second === undefined) {
    out(`${JSON.stringify(verifyArchive(await readArchive(first ?? defaultDir), sourceSha))}\n`);
    return 0;
  }
  if (command === 'show' && first !== undefined) {
    out(reportBytes(reconstructPoint(await readArchive(second ?? defaultDir), first)));
    return 0;
  }
  process.stderr.write(`usage: ${USAGE}\n`);
  return 2;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
