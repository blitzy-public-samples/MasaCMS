/** Multiset diff of two encoding-ordered keyless-table streams into added and removed occurrences per distinct row. */
import { compareEncodings, diffMultiset } from '@opt2/platform/migration-kit';
import type { MultisetDelta } from '@opt2/platform/migration-kit';

import type { CanonicalRow } from '../extract/index.js';
import { orderedReader } from './keyed.js';
import type { OrderedReader, RowSource } from './keyed.js';

const LABEL_LIMIT = 120;

/**
 * One distinct row whose occurrence count differs between the inputs. `row` is an `after` occurrence when
 * `added > 0`, else a `before` one, so the caller can insert or delete one occurrence by value without decoding.
 */
export interface MultisetChange {
  encoding: string;
  added: number;
  removed: number;
  row: CanonicalRow;
}

/** Adjacent occurrences of one distinct encoding in one input. */
interface Run {
  encoding: string;
  count: number;
  row: CanonicalRow;
}

function compareRows(a: CanonicalRow, b: CanonicalRow): number {
  return compareEncodings(a.encoding, b.encoding);
}

function describe(row: CanonicalRow): string {
  return row.encoding.length <= LABEL_LIMIT ? row.encoding : `${row.encoding.slice(0, LABEL_LIMIT - 1)}…`;
}

/** Returns a function yielding `reader`'s runs in order, holding one row of lookahead; `undefined` once exhausted. */
function runReader(reader: OrderedReader<CanonicalRow>): () => Promise<Run | undefined> {
  let head: CanonicalRow | undefined;
  let primed = false;
  return async () => {
    if (!primed) {
      primed = true;
      head = await reader.next();
    }
    const first = head;
    if (first === undefined) return undefined;
    let count = 1;
    for (head = await reader.next(); head !== undefined && compareRows(first, head) === 0; head = await reader.next()) count += 1;
    return { encoding: first.encoding, count, row: first };
  };
}

function* occurrences(encoding: string, count: number): Generator<string, void, undefined> {
  for (let index = 0; index < count; index++) yield encoding;
}

function total(deltas: readonly MultisetDelta[]): number {
  return deltas.reduce((sum, delta) => sum + delta.count, 0);
}

function changeOf(old: Run, now: Run): MultisetChange | undefined {
  const delta = diffMultiset(occurrences(old.encoding, old.count), occurrences(now.encoding, now.count));
  const added = total(delta.added);
  const removed = total(delta.removed);
  if (added === 0 && removed === 0) return undefined;
  return { encoding: now.encoding, added, removed, row: added > 0 ? now.row : old.row };
}

function removal(old: Run): MultisetChange {
  return { encoding: old.encoding, added: 0, removed: old.count, row: old.row };
}

function addition(now: Run): MultisetChange {
  return { encoding: now.encoding, added: now.count, removed: 0, row: now.row };
}

/**
 * Merges two streams of one keyless table, each in `compareEncodings` order with equal encodings adjacent, into the
 * occurrence changes that turn `before` into `after`. Holds one row per side and closes both inputs when it ends,
 * fails or is returned early.
 */
export async function* diffMultisetStreams(
  before: RowSource<CanonicalRow>,
  after: RowSource<CanonicalRow>,
): AsyncGenerator<MultisetChange> {
  const left = orderedReader(before, { side: 'before', compare: compareRows, strict: false, describe });
  const right = orderedReader(after, { side: 'after', compare: compareRows, strict: false, describe });
  try {
    const nextOld = runReader(left);
    const nextNew = runReader(right);
    let old = await nextOld();
    let now = await nextNew();
    while (old !== undefined && now !== undefined) {
      const order = compareEncodings(old.encoding, now.encoding);
      if (order < 0) {
        yield removal(old);
        old = await nextOld();
      } else if (order > 0) {
        yield addition(now);
        now = await nextNew();
      } else {
        const change = changeOf(old, now);
        if (change !== undefined) yield change;
        old = await nextOld();
        now = await nextNew();
      }
    }
    for (; old !== undefined; old = await nextOld()) yield removal(old);
    for (; now !== undefined; now = await nextNew()) yield addition(now);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}
