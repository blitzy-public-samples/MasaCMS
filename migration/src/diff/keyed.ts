/** Keyed merge-join diff of two key-ordered canonical row streams into inserts, deletes and column-scoped updates. */
import { changedColumns } from '@opt2/platform/migration-kit';
import type { CanonicalColumn } from '@opt2/platform/migration-kit';

import { compareCanonicalRows } from '../extract/index.js';
import type { CanonicalRow } from '../extract/index.js';

const LABEL_LIMIT = 120;

/** Items of one diff input: async iterables from the extractor, plain iterables in tests. */
export type RowSource<T> = AsyncIterable<T> | Iterable<T>;

/** The snapshot a diff input comes from. */
export type DiffSide = 'before' | 'after';

function clip(text: string): string {
  return text.length <= LABEL_LIMIT ? text : `${text.slice(0, LABEL_LIMIT)}…`;
}

/** A diff input yielded an item sorting before its predecessor, or, on a strict reader, equal to it. */
export class DiffOrderError extends Error {
  readonly code = 'diffOrder';
  readonly side: DiffSide;
  readonly previous: string;
  readonly current: string;

  constructor(details: { side: DiffSide; previous: string; current: string; repeated: boolean }) {
    super(`${details.side} input is out of order: ${clip(details.current)} ${details.repeated ? 'repeats' : 'follows'} ${clip(details.previous)}`);
    this.name = 'DiffOrderError';
    this.side = details.side;
    this.previous = details.previous;
    this.current = details.current;
  }
}

/** Sequential reader over one diff input that rejects items out of `compare` order. */
export interface OrderedReader<T> {
  /** The next item, or `undefined` once the input is exhausted or closed. */
  next(): Promise<T | undefined>;
  /** Releases the input through its iterator's `return`; later calls do nothing. */
  close(): Promise<void>;
}

/**
 * Reads `source` once, holding only the previous item. Throws `DiffOrderError` when `compare(previous, current) > 0`,
 * or when it is 0 and `strict` is set; `describe` labels both items in the error.
 */
export function orderedReader<T>(
  source: RowSource<T>,
  opts: { side: DiffSide; compare: (a: T, b: T) => number; strict: boolean; describe: (item: T) => string },
): OrderedReader<T> {
  const iterator: AsyncIterator<T> | Iterator<T> = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  let previous: { item: T } | undefined;
  let done = false;
  let closed = false;
  return {
    async next() {
      if (done) return undefined;
      const result = await iterator.next();
      if (result.done === true) {
        done = true;
        return undefined;
      }
      const current = result.value;
      if (previous !== undefined) {
        const order = opts.compare(previous.item, current);
        if (order > 0 || (opts.strict && order === 0)) {
          throw new DiffOrderError({ side: opts.side, previous: opts.describe(previous.item), current: opts.describe(current), repeated: order === 0 });
        }
      }
      previous = { item: current };
      return current;
    },
    async close() {
      if (closed) return;
      closed = true;
      done = true;
      previous = undefined;
      await iterator.return?.();
    },
  };
}

/** Options of a keyed diff. */
export interface KeyedDiffOptions {
  /** Encoded columns of both inputs, in catalog order. */
  columns: readonly CanonicalColumn[];
  /** Restricts update columns to these names, matched case-insensitively; inserts and deletes are unaffected. */
  writableColumns?: ReadonlySet<string> | readonly string[];
}

/** One row difference; an update's `key` is the before row's and `columns` lists its changed columns in catalog order. */
export type KeyedChange =
  | { op: 'insert'; key: CanonicalRow['key']; after: CanonicalRow }
  | { op: 'delete'; key: CanonicalRow['key']; before: CanonicalRow }
  | { op: 'update'; key: CanonicalRow['key']; before: CanonicalRow; after: CanonicalRow; columns: string[] };

function updateOf(
  before: CanonicalRow,
  after: CanonicalRow,
  columns: readonly CanonicalColumn[],
  writable: ReadonlySet<string> | undefined,
): KeyedChange | undefined {
  if (before.encoding === after.encoding) return undefined;
  const changed = changedColumns(columns, before.row, after.row);
  const scoped = writable === undefined ? changed : changed.filter((name) => writable.has(name.toLowerCase()));
  return scoped.length === 0 ? undefined : { op: 'update', key: before.key, before, after, columns: scoped };
}

/**
 * Merges two key-ordered streams of one table (`compareCanonicalRows` order, keys unique per side) into the changes
 * that turn `before` into `after`. Holds one row per side and closes both inputs when it ends, fails or is returned early.
 */
export async function* diffKeyedStreams(
  before: RowSource<CanonicalRow>,
  after: RowSource<CanonicalRow>,
  options: KeyedDiffOptions,
): AsyncGenerator<KeyedChange> {
  const writable = options.writableColumns === undefined ? undefined : new Set(Array.from(options.writableColumns, (name) => name.toLowerCase()));
  const describe = (row: CanonicalRow): string => row.key;
  const left = orderedReader(before, { side: 'before', compare: compareCanonicalRows, strict: true, describe });
  const right = orderedReader(after, { side: 'after', compare: compareCanonicalRows, strict: true, describe });
  try {
    let old = await left.next();
    let next = await right.next();
    while (old !== undefined && next !== undefined) {
      const order = compareCanonicalRows(old, next);
      if (order < 0) {
        yield { op: 'delete', key: old.key, before: old };
        old = await left.next();
      } else if (order > 0) {
        yield { op: 'insert', key: next.key, after: next };
        next = await right.next();
      } else {
        const change = updateOf(old, next, options.columns, writable);
        if (change !== undefined) yield change;
        old = await left.next();
        next = await right.next();
      }
    }
    for (; old !== undefined; old = await left.next()) yield { op: 'delete', key: old.key, before: old };
    for (; next !== undefined; next = await right.next()) yield { op: 'insert', key: next.key, after: next };
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}
