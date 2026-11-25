// Committed reconciliation evidence as one full baseline report plus difference records; the runtime writer is untouched.
import { createHash } from 'node:crypto';
import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, resolveReportsDir } from '../config.js';
import { readSourceSha, writeFileAtomic } from '../reports/index.js';
import { RECONCILIATION_DIR } from './report.js';

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

/** One edit, applied in record order to the base report. */
export type Operation =
  | { op: 'set'; path: PathSegment[]; value: JsonValue }
  | { op: 'delete'; path: PathSegment[] }
  | { op: 'splice'; path: PathSegment[]; index: number; remove: number; insert: JsonValue[] }
  | { op: 'order'; path: PathSegment[]; keys: string[] };

/** A value replaced before archiving. */
export interface Redaction {
  path: PathSegment[];
  rule: string;
}

/** A point stored as the operations that turn its base point's report into its own. */
export interface DifferenceRecord {
  sourceSha: string;
  generatedBy: string;
  point: string;
  tableVersion: string | null;
  snapshotSeq: number | null;
  result: string;
  /** Point whose reconstructed report the operations apply to. */
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

/** Hunks whose pairings cost more cells than this align positionally. */
const ALIGN_LIMIT = 4096;
/** Arrays whose common-subsequence table exceeds this many cells diff as one hunk. */
const LCS_LIMIT = 4_000_000;
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

function diffObject(base: JsonObject, target: JsonObject, at: PathSegment[]): Operation[] {
  const ops: Operation[] = [];
  const baseKeys = Object.keys(base);
  const targetKeys = Object.keys(target);
  for (const key of baseKeys) if (!Object.hasOwn(target, key)) ops.push({ op: 'delete', path: [...at, key] });
  for (const key of targetKeys) {
    const value = target[key] as JsonValue;
    if (Object.hasOwn(base, key)) ops.push(...diffJson(base[key] as JsonValue, value, [...at, key]));
    else ops.push({ op: 'set', path: [...at, key], value });
  }
  const order = [...baseKeys.filter((key) => Object.hasOwn(target, key)), ...targetKeys.filter((key) => !Object.hasOwn(base, key))];
  if (order.some((key, i) => key !== targetKeys[i])) ops.push({ op: 'order', path: at, keys: targetKeys });
  return ops;
}

/** Index pairs of a longest common subsequence of `a` and `b`. */
function commonPairs(a: readonly number[], b: readonly number[]): [number, number][] {
  const width = b.length + 1;
  if ((a.length + 1) * width > LCS_LIMIT) return [];
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

/** Alignment step inside a hunk: pair `a` with `b`, delete `a`, or insert `b`. */
type Step = { kind: 'pair'; a: number; b: number } | { kind: 'delete' } | { kind: 'insert'; b: number };

/** Cheapest alignment of `base[a0, a1)` with `target[b0, b1)`; large hunks pair positionally. */
function alignHunk(base: readonly JsonValue[], target: readonly JsonValue[], a0: number, a1: number, b0: number, b1: number): Step[] {
  const rows = a1 - a0;
  const cols = b1 - b0;
  if (rows * cols > ALIGN_LIMIT || rows === 0 || cols === 0) {
    const paired = Math.min(rows, cols);
    return [
      ...Array.from({ length: paired }, (_, k): Step => ({ kind: 'pair', a: a0 + k, b: b0 + k })),
      ...Array.from({ length: rows - paired }, (): Step => ({ kind: 'delete' })),
      ...Array.from({ length: cols - paired }, (_, k): Step => ({ kind: 'insert', b: b0 + paired + k })),
    ];
  }
  const width = cols + 1;
  const cost = new Float64Array((rows + 1) * width);
  const choice = new Uint8Array((rows + 1) * width);
  const at = (i: number, j: number): number => cost[i * width + j] ?? 0;
  for (let i = rows; i >= 0; i--) {
    for (let j = cols; j >= 0; j--) {
      if (i === rows && j === cols) continue;
      let best = Infinity;
      let pick = 0;
      if (i < rows && j < cols) {
        const pair = sizeOf(diffJson(base[a0 + i] as JsonValue, target[b0 + j] as JsonValue)) + at(i + 1, j + 1);
        if (pair < best) [best, pick] = [pair, 1];
      }
      if (i < rows && 1 + at(i + 1, j) < best) [best, pick] = [1 + at(i + 1, j), 2];
      if (j < cols) {
        const insert = JSON.stringify(target[b0 + j]).length + 1 + at(i, j + 1);
        if (insert < best) [best, pick] = [insert, 3];
      }
      cost[i * width + j] = best;
      choice[i * width + j] = pick;
    }
  }
  const steps: Step[] = [];
  for (let i = 0, j = 0; i < rows || j < cols; ) {
    const pick = choice[i * width + j];
    if (pick === 1) {
      steps.push({ kind: 'pair', a: a0 + i++, b: b0 + j++ });
    } else if (pick === 2) {
      steps.push({ kind: 'delete' });
      i++;
    } else {
      steps.push({ kind: 'insert', b: b0 + j++ });
    }
  }
  return steps;
}

function diffArray(base: readonly JsonValue[], target: readonly JsonValue[], at: PathSegment[]): Operation[] {
  const ids = new Map<string, number>();
  const idOf = (value: JsonValue): number => {
    const text = JSON.stringify(value);
    const known = ids.get(text);
    if (known !== undefined) return known;
    ids.set(text, ids.size);
    return ids.size - 1;
  };
  const a = base.map(idOf);
  const b = target.map(idOf);
  const anchors = [...commonPairs(a, b), [a.length, b.length] as [number, number]];
  const ops: Operation[] = [];
  let pos = 0;
  let a0 = 0;
  let b0 = 0;
  for (const [a1, b1] of anchors) {
    let remove = 0;
    let insert: JsonValue[] = [];
    const flush = (): void => {
      if (remove === 0 && insert.length === 0) return;
      ops.push({ op: 'splice', path: at, index: pos, remove, insert });
      pos += insert.length;
      [remove, insert] = [0, []];
    };
    for (const step of alignHunk(base, target, a0, a1, b0, b1)) {
      if (step.kind === 'delete') remove += 1;
      else if (step.kind === 'insert') insert.push(target[step.b] as JsonValue);
      else {
        flush();
        ops.push(...diffJson(base[step.a] as JsonValue, target[step.b] as JsonValue, [...at, pos]));
        pos += 1;
      }
    }
    flush();
    pos += 1;
    [a0, b0] = [a1 + 1, b1 + 1];
  }
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
  if (op.op === 'set' && op.path.length === 0) return structuredClone(op.value);
  if (op.op === 'splice' || op.op === 'order') {
    const node = valueAt(root, op.path);
    if (op.op === 'splice' && Array.isArray(node) && op.index >= 0 && op.remove >= 0 && op.index + op.remove <= node.length) {
      node.splice(op.index, op.remove, ...structuredClone(op.insert));
      return root;
    }
    if (op.op === 'order' && isObject(node) && op.keys.length === Object.keys(node).length && op.keys.every((key) => Object.hasOwn(node, key))) {
      const entries = op.keys.map((key) => [key, node[key] as JsonValue] as const);
      for (const key of op.keys) delete node[key];
      for (const [key, value] of entries) node[key] = value;
      return root;
    }
    throw new ArchiveError(`Cannot ${op.op} at ${JSON.stringify(op.path)}`);
  }
  const parent = valueAt(root, op.path.slice(0, -1));
  const last = op.path.at(-1);
  if (op.op === 'set' && Array.isArray(parent) && typeof last === 'number' && last >= 0 && last < parent.length) parent[last] = structuredClone(op.value);
  else if (op.op === 'set' && isObject(parent) && typeof last === 'string') parent[last] = structuredClone(op.value);
  else if (op.op === 'delete' && isObject(parent) && typeof last === 'string' && Object.hasOwn(parent, last)) delete parent[last];
  else throw new ArchiveError(`Cannot ${op.op} at ${JSON.stringify(op.path)}`);
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

/** Directed edge of the base graph; `below` is the edge it stands for one contraction level down. */
interface Edge {
  from: number;
  to: number;
  weight: number;
  below?: Edge;
}

/** First cycle among the chosen in-edges, as its nodes, or `null`. */
function findCycle(chosen: readonly (Edge | undefined)[], root: number): number[] | null {
  const walkOf = new Map<number, number>();
  for (let start = 0; start < chosen.length; start++) {
    const walk: number[] = [];
    let node = start;
    for (let edge = chosen[node]; node !== root && edge !== undefined && !walkOf.has(node); edge = chosen[node]) {
      walkOf.set(node, start);
      walk.push(node);
      node = edge.from;
    }
    if (walkOf.get(node) === start && node !== root) return walk.slice(walk.indexOf(node));
  }
  return null;
}

/** Minimum-weight spanning arborescence rooted at `root` (Chu-Liu/Edmonds) over `nodes` nodes. */
function minArborescence(nodes: number, root: number, edges: readonly Edge[]): Edge[] {
  const chosen = new Array<Edge | undefined>(nodes);
  for (const edge of edges) {
    const current = chosen[edge.to];
    if (edge.to !== root && edge.from !== edge.to && (current === undefined || edge.weight < current.weight)) chosen[edge.to] = edge;
  }
  const cycle = findCycle(chosen, root);
  if (cycle === null) return chosen.filter((edge): edge is Edge => edge !== undefined);
  const inCycle = new Set(cycle);
  const merged = nodes;
  const contracted: Edge[] = [];
  for (const edge of edges) {
    const fromIn = inCycle.has(edge.from);
    const toIn = inCycle.has(edge.to);
    if (fromIn && toIn) continue;
    const weight = toIn ? edge.weight - (chosen[edge.to] as Edge).weight : edge.weight;
    contracted.push({ from: fromIn ? merged : edge.from, to: toIn ? merged : edge.to, weight, below: edge });
  }
  const picked = minArborescence(nodes + 1, root, contracted).map((edge) => edge.below as Edge);
  const entry = picked.find((edge) => inCycle.has(edge.to)) as Edge;
  return [...picked, ...cycle.filter((node) => node !== entry.to).map((node) => chosen[node] as Edge)];
}

/** The archive of a set of points: the baseline, and each record's base. */
export interface ArchivePlan {
  baseline: string;
  bases: Record<string, string>;
}

/**
 * Archives `reports` (point name to full report): redacts each, then stores the baseline whose records total fewest bytes in
 * full and every other point as a record against the base a minimum arborescence assigns it; ties go to the earlier name.
 */
export function buildArchive(reports: Readonly<Record<string, JsonObject>>, sourceSha: string): { plan: ArchivePlan; documents: Record<string, ArchiveDocument> } {
  const names = Object.keys(reports).sort();
  if (names.length === 0) throw new ArchiveError('No reports to archive');
  const redacted = names.map((name) => {
    const entry = redactReport(reports[name] as JsonObject);
    if (entry.report.point !== name) throw new ArchiveError(`${name}.json records point ${JSON.stringify(entry.report.point)}`);
    return entry;
  });
  const records = new Map<string, DifferenceRecord>();
  const edges: Edge[] = [];
  names.forEach((base, from) => {
    redacted.forEach(({ report, redactions }, to) => {
      if (from === to) return;
      const record = buildRecord({ report, base, baseReport: (redacted[from] as (typeof redacted)[number]).report, sourceSha, redactions });
      records.set(`${String(from)}>${String(to)}`, record);
      edges.push({ from, to, weight: reportBytes(record).length });
    });
  });
  let best: { root: number; weight: number; tree: Edge[] } | undefined;
  names.forEach((_, root) => {
    const tree = minArborescence(names.length, root, edges);
    const weight = tree.reduce((sum, edge) => sum + edge.weight, 0);
    if (best === undefined || weight < best.weight) best = { root, weight, tree };
  });
  const { root, tree } = best as NonNullable<typeof best>;
  const baseline = names[root] as string;
  const documents: Record<string, ArchiveDocument> = { [baseline]: (redacted[root] as (typeof redacted)[number]).report };
  const bases: Record<string, string> = {};
  for (const edge of tree) {
    const point = names[edge.to] as string;
    bases[point] = names[edge.from] as string;
    documents[point] = records.get(`${String(edge.from)}>${String(edge.to)}`) as DifferenceRecord;
  }
  return { plan: { baseline, bases }, documents };
}

/** Shared, cached reconstruction; callers clone before handing a report out. */
function rebuild(archive: ReadonlyMap<string, ArchiveDocument>, point: string, cache: Map<string, JsonObject>, chain: readonly string[]): JsonObject {
  const cached = cache.get(point);
  if (cached !== undefined) return cached;
  if (chain.includes(point)) throw new ArchiveError(`Base cycle: ${[...chain, point].join(' -> ')}`);
  const doc = archive.get(point);
  if (doc === undefined) throw new ArchiveError(`No archived point ${point}`);
  let report: JsonObject;
  if (isDifferenceRecord(doc)) {
    const base = rebuild(archive, doc.base, cache, [...chain, point]);
    let rebuilt: JsonValue;
    try {
      rebuilt = applyOperations(base, doc.operations);
    } catch (error) {
      throw new ArchiveError(`${point}: ${(error as Error).message}`);
    }
    if (!isObject(rebuilt) || reportSha256(rebuilt) !== doc.sha256) throw new ArchiveError(`${point}: reconstructed report does not match sha256 ${doc.sha256}`);
    report = rebuilt;
  } else {
    report = doc;
  }
  if (report.point !== point) throw new ArchiveError(`${point}: report records point ${JSON.stringify(report.point)}`);
  cache.set(point, report);
  return report;
}

/** The full report of `point`, rebuilt through its chain of bases and checked against each record's SHA-256. */
export function reconstructPoint(archive: ReadonlyMap<string, ArchiveDocument>, point: string): JsonObject {
  return structuredClone(rebuild(archive, point, new Map(), []));
}

/** One verified archived point. */
export interface VerifiedPoint {
  point: string;
  base: string | null;
  sha256: string;
  result: string | null;
}

/**
 * Reconstructs every point and checks one full baseline exists, every file and report carries `sourceSha`, and each record's
 * identity fields equal its report's.
 * @throws ArchiveError listing every problem.
 */
export function verifyArchive(archive: ReadonlyMap<string, ArchiveDocument>, sourceSha: string): { baseline: string; points: VerifiedPoint[] } {
  const problems: string[] = [];
  const cache = new Map<string, JsonObject>();
  const points: VerifiedPoint[] = [];
  const baselines = [...archive].filter(([, doc]) => !isDifferenceRecord(doc)).map(([name]) => name);
  if (baselines.length !== 1) problems.push(`Expected one full baseline, found ${String(baselines.length)}: ${baselines.join(', ')}`);
  for (const [point, doc] of [...archive].sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      const report = rebuild(archive, point, cache, []);
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

/** Archives every full point report of `sourceDir` but {@link KEPT_IN_PLACE} into `archiveDir`, removing stale archive files. */
export async function writeArchive(sourceDir: string, archiveDir: string, sourceSha: string): Promise<ArchivePlan> {
  const reports = Object.fromEntries([...(await readJsonDir(sourceDir))].filter(([name]) => !KEPT_IN_PLACE.includes(name)));
  const { plan, documents } = buildArchive(reports, sourceSha);
  for (const [point, doc] of Object.entries(documents)) await writeFileAtomic(path.join(archiveDir, `${point}.json`), reportBytes(doc));
  for (const stale of [...(await readJsonDir(archiveDir)).keys()].filter((name) => !Object.hasOwn(documents, name))) {
    await unlink(path.join(archiveDir, `${stale}.json`));
  }
  verifyArchive(await readArchive(archiveDir), sourceSha);
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
    out(`${JSON.stringify(await writeArchive(first, second ?? defaultDir, sourceSha))}\n`);
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
