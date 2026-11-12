/** Pure reconciliation core: counts, checksums and capped difference lists of legacy against target rows and objects. */
import { Buffer } from 'node:buffer';

import { compareEncodings, decodeRow, sha256Hex, tableChecksum } from '@opt2/platform/migration-kit';
import type { CanonicalColumn, CanonicalValue, ChecksumEntry } from '@opt2/platform/migration-kit';

import { diffKeyedStreams, diffMultisetStreams } from '../diff/index.js';
import type { KeyedChange, MultisetChange, RowSource } from '../diff/index.js';
import type { CanonicalRow } from '../extract/index.js';

/** Differences kept in one list; the total is always counted in full. */
export const DIFFERENCE_LIMIT = 100;

/** Longest value a difference embeds as is; longer values are replaced by their SHA-256. */
const RENDER_LIMIT = 1024;

/** What one difference records. */
export type DifferenceKind =
  | 'changed'
  | 'missing-in-target'
  | 'extra-in-target'
  | 'object-missing-in-target'
  | 'object-extra-in-target'
  | 'object-mismatch';

/**
 * One difference. `key` is the encoded row key, the row's SHA-256 for keyless tables, or the object key; `column` is
 * the changed column or object field, null for whole rows and objects; `occurrences` counts identical keyless rows or
 * duplicated object keys.
 */
export interface Difference {
  kind: DifferenceKind;
  key: string;
  column: string | null;
  legacy: string | null;
  target: string | null;
  occurrences?: number;
}

/** A capped difference list with its full total. */
export interface DifferenceList {
  differences: Difference[];
  differenceCount: number;
}

/** One stored object of a file unit, keyed `<tenant>/<fileID><variant>.<ext>`. */
export interface ObjectEntry {
  key: string;
  size: number;
  sha256: string;
  orphan?: boolean;
}

/** Row measures of one unit table and tenant on both sides. */
export interface RowComparison extends DifferenceList {
  legacyCount: number;
  targetCount: number;
  legacySha256: string;
  targetSha256: string;
}

/** Object-manifest measures of one file unit and tenant on both sides. */
export interface ObjectComparison extends DifferenceList {
  legacyObjects: number;
  targetObjects: number;
}

/** Both sides of one unit table and tenant, encoded over the same `columns` and in `compareCanonicalRows` order. */
export interface CompareRowsInput {
  keyed: boolean;
  columns: readonly CanonicalColumn[];
  legacy: RowSource<CanonicalRow>;
  target: RowSource<CanonicalRow>;
  limit?: number;
}

/** Accumulates differences, keeping the first `limit` and counting all. */
class Collector {
  private readonly list: Difference[] = [];
  private count = 0;

  constructor(private readonly limit: number) {}

  add(difference: Difference): void {
    this.count += 1;
    if (this.list.length < this.limit) this.list.push(difference);
  }

  result(): DifferenceList {
    return { differences: this.list, differenceCount: this.count };
  }
}

/** Returns `value` unchanged up to 1,024 characters, otherwise `sha256:<hex> (<n> chars)`; null stays null. */
export function renderValue(value: string | null): string | null {
  if (value === null || value.length <= RENDER_LIMIT) return value;
  return `sha256:${sha256Hex(value)} (${String(value.length)} chars)`;
}

/** Canonical value text of a decoded column: lowercase hex for binary values. */
function valueText(value: CanonicalValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  return Buffer.isBuffer(value) ? value.toString('hex') : value;
}

/** Passes `source` through while recording each row's checksum entry. */
async function* tap(source: RowSource<CanonicalRow>, keyed: boolean, entries: ChecksumEntry[]): AsyncGenerator<CanonicalRow, void, undefined> {
  for await (const row of source) {
    entries.push(keyed ? { key: row.key, row: row.encoding } : { row: row.encoding });
    yield row;
  }
}

function addKeyedChange(change: KeyedChange, columns: readonly CanonicalColumn[], out: Collector): void {
  switch (change.op) {
    case 'delete':
      out.add({ kind: 'missing-in-target', key: change.key, column: null, legacy: renderValue(change.before.encoding), target: null });
      return;
    case 'insert':
      out.add({ kind: 'extra-in-target', key: change.key, column: null, legacy: null, target: renderValue(change.after.encoding) });
      return;
    case 'update': {
      const legacy = decodeRow(columns, change.before.encoding);
      const target = decodeRow(columns, change.after.encoding);
      for (const column of change.columns) {
        out.add({
          kind: 'changed',
          key: change.key,
          column,
          legacy: renderValue(valueText(legacy[column])),
          target: renderValue(valueText(target[column])),
        });
      }
    }
  }
}

function addMultisetChange(change: MultisetChange, out: Collector): void {
  // The key equals the row's legacy_row_hash: SHA-256 of its whole-row encoding.
  const key = sha256Hex(change.encoding);
  const value = renderValue(change.encoding);
  if (change.removed > 0) out.add({ kind: 'missing-in-target', key, column: null, legacy: value, target: null, occurrences: change.removed });
  if (change.added > 0) out.add({ kind: 'extra-in-target', key, column: null, legacy: null, target: value, occurrences: change.added });
}

/**
 * Diffs legacy (before) against target (after) and measures both sides; keyed tables by key, keyless tables as
 * multisets. Out-of-order input rejects with `DiffOrderError`.
 */
export async function compareRows(input: CompareRowsInput): Promise<RowComparison> {
  const out = new Collector(input.limit ?? DIFFERENCE_LIMIT);
  const legacyEntries: ChecksumEntry[] = [];
  const targetEntries: ChecksumEntry[] = [];
  const legacy = tap(input.legacy, input.keyed, legacyEntries);
  const target = tap(input.target, input.keyed, targetEntries);
  if (input.keyed) {
    for await (const change of diffKeyedStreams(legacy, target, { columns: input.columns })) addKeyedChange(change, input.columns, out);
  } else {
    for await (const change of diffMultisetStreams(legacy, target)) addMultisetChange(change, out);
  }
  const legacySum = tableChecksum(legacyEntries);
  const targetSum = tableChecksum(targetEntries);
  return {
    legacyCount: legacySum.count,
    targetCount: targetSum.count,
    legacySha256: legacySum.sha256,
    targetSha256: targetSum.sha256,
    ...out.result(),
  };
}

function compareObjectEntries(a: ObjectEntry, b: ObjectEntry): number {
  return compareEncodings(a.sha256, b.sha256) || a.size - b.size;
}

function sameObject(a: ObjectEntry, b: ObjectEntry): boolean {
  return a.sha256 === b.sha256 && a.size === b.size;
}

function indexByKey(entries: readonly ObjectEntry[]): Map<string, ObjectEntry[]> {
  const index = new Map<string, ObjectEntry[]>();
  for (const entry of entries) {
    const list = index.get(entry.key);
    if (list === undefined) index.set(entry.key, [entry]);
    else list.push(entry);
  }
  return index;
}

/** Records unpaired objects of one side, one difference per distinct content, counted when the key is duplicated. */
function addUnpaired(
  key: string,
  unpaired: readonly ObjectEntry[],
  kind: 'object-missing-in-target' | 'object-extra-in-target',
  duplicated: boolean,
  out: Collector,
): void {
  const sorted = [...unpaired].sort(compareObjectEntries);
  for (let start = 0; start < sorted.length;) {
    const first = sorted[start] as ObjectEntry;
    let end = start + 1;
    while (end < sorted.length && sameObject(first, sorted[end] as ObjectEntry)) end += 1;
    const difference: Difference = kind === 'object-missing-in-target'
      ? { kind, key, column: null, legacy: first.sha256, target: null }
      : { kind, key, column: null, legacy: null, target: first.sha256 };
    if (duplicated) difference.occurrences = end - start;
    out.add(difference);
    start = end;
  }
}

function compareObjectKey(key: string, legacy: readonly ObjectEntry[], target: readonly ObjectEntry[], out: Collector): void {
  const remaining = [...target];
  const unmatched: ObjectEntry[] = [];
  for (const entry of legacy) {
    const match = remaining.findIndex((candidate) => sameObject(entry, candidate));
    if (match >= 0) remaining.splice(match, 1);
    else unmatched.push(entry);
  }
  unmatched.sort(compareObjectEntries);
  remaining.sort(compareObjectEntries);
  const paired = Math.min(unmatched.length, remaining.length);
  for (let index = 0; index < paired; index++) {
    const was = unmatched[index] as ObjectEntry;
    const now = remaining[index] as ObjectEntry;
    if (was.size !== now.size) out.add({ kind: 'object-mismatch', key, column: 'size', legacy: String(was.size), target: String(now.size) });
    if (was.sha256 !== now.sha256) out.add({ kind: 'object-mismatch', key, column: 'sha256', legacy: was.sha256, target: now.sha256 });
  }
  addUnpaired(key, unmatched.slice(paired), 'object-missing-in-target', legacy.length > 1, out);
  addUnpaired(key, remaining.slice(paired), 'object-extra-in-target', target.length > 1, out);
}

/** Compares two object manifests by key: one equal-size, equal-hash target object per legacy object. */
export function compareObjects(legacy: readonly ObjectEntry[], target: readonly ObjectEntry[], limit: number = DIFFERENCE_LIMIT): ObjectComparison {
  const out = new Collector(limit);
  const legacyIndex = indexByKey(legacy);
  const targetIndex = indexByKey(target);
  const keys = [...new Set([...legacyIndex.keys(), ...targetIndex.keys()])].sort(compareEncodings);
  for (const key of keys) compareObjectKey(key, legacyIndex.get(key) ?? [], targetIndex.get(key) ?? [], out);
  return { legacyObjects: legacy.length, targetObjects: target.length, ...out.result() };
}

/** Concatenates difference lists in order, keeping the first `limit` entries and summing their totals. */
export function mergeDifferences(limit: number, ...parts: readonly DifferenceList[]): DifferenceList {
  return {
    differences: parts.flatMap((part) => part.differences).slice(0, limit),
    differenceCount: parts.reduce((sum, part) => sum + part.differenceCount, 0),
  };
}

/** True when both sides have equal counts and checksums and no difference, objects included when given. */
export function isZeroDifference(rows: RowComparison, objects?: ObjectComparison | null): boolean {
  const rowsEqual = rows.legacyCount === rows.targetCount && rows.legacySha256 === rows.targetSha256 && rows.differenceCount === 0;
  if (objects === undefined || objects === null) return rowsEqual;
  return rowsEqual && objects.differenceCount === 0 && objects.legacyObjects === objects.targetObjects;
}
