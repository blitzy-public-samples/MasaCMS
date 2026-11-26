/** Same-row commit order of changelog rows: within one row `seq` follows commit order, while the cursor's `(xid, seq)` need not. */
import type { ChangeOp, ChangeOrigin } from './ddl.js';

/** The changelog fields that decide whether one row must reach legacy before another. */
export interface OrderedChange {
  seq: string;
  table: string;
  op: ChangeOp;
  key: string;
  before: string | null;
  after: string | null;
  origin: ChangeOrigin;
}

function rowKey(table: string, text: string): string {
  return `${table}\u0000${text}`;
}

function append<K>(map: Map<K, number[]>, key: K, index: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [index]);
  else list.push(index);
}

/** True for a row whose writes the projector applies; only these order one another. */
function projected(row: OrderedChange): boolean {
  return row.origin === 'target';
}

/** True when `row` removes or changes the row an update's after-image left, so it pairs with that update. */
function removes(row: OrderedChange): row is OrderedChange & { before: string } {
  return row.op !== 'insert' && row.before !== null;
}

/**
 * For each row, the index of the last row after it that must be applied before it, or its own index when none.
 * A target row precedes a later-seq target row of its table that shares its key, or, being an update, whose before-image
 * is its after-image (a keyless row's re-insertion, a key change).
 */
export function predecessorEnds(rows: readonly OrderedChange[]): number[] {
  const ends = rows.map((_, index) => index);
  const seqs = rows.map((row) => BigInt(row.seq));
  const byKey = new Map<string, number[]>();
  const updatesByAfter = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (!projected(row)) return;
    append(byKey, rowKey(row.table, row.key), index);
    if (row.op === 'update' && row.after !== null) append(updatesByAfter, rowKey(row.table, row.after), index);
  });
  for (const indexes of byKey.values()) {
    // suffixMin[k] is the lowest seq from indexes[k] on, so it never decreases with k and admits a binary search.
    const suffixMin = new Array<bigint>(indexes.length);
    for (let k = indexes.length - 1; k >= 0; k -= 1) {
      const seq = seqs[indexes[k] as number] as bigint;
      const next = suffixMin[k + 1];
      suffixMin[k] = next !== undefined && next < seq ? next : seq;
    }
    indexes.forEach((index, k) => {
      const seq = seqs[index] as bigint;
      let found = -1;
      for (let lo = k + 1, hi = indexes.length - 1; lo <= hi; ) {
        const mid = (lo + hi) >> 1;
        if ((suffixMin[mid] as bigint) < seq) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (found >= 0) ends[index] = Math.max(ends[index] as number, indexes[found] as number);
    });
  }
  rows.forEach((row, index) => {
    if (!projected(row) || !removes(row)) return;
    const updates = updatesByAfter.get(rowKey(row.table, row.before)) ?? [];
    for (let k = updates.length - 1; k >= 0 && (updates[k] as number) > index; k -= 1) {
      const update = updates[k] as number;
      if ((seqs[update] as bigint) < (seqs[index] as bigint)) {
        ends[index] = Math.max(ends[index] as number, update);
        break;
      }
    }
  });
  return ends;
}

/** The smallest prefix end at or after `from` whose rows need no row after it, given {@link predecessorEnds}. */
export function closedEndFrom(ends: readonly number[], from: number): number {
  let end = from;
  for (let index = 0; index <= end; index += 1) end = Math.max(end, ends[index] as number);
  return end;
}

/** The largest prefix end before `before` whose rows need no row after it and that `boundary` accepts; -1 when none. */
export function lastClosedEnd(ends: readonly number[], before: number, boundary: (end: number) => boolean = () => true): number {
  let reach = -1;
  let last = -1;
  for (let index = 0; index < before; index += 1) {
    reach = Math.max(reach, ends[index] as number);
    if (reach <= index && boundary(index)) last = index;
  }
  return last;
}

/**
 * `items` in their given order, except that the target rows of each set linked as one row (shared key, or an update's
 * after-image another row removes), within one `scopeOf` (owner and tenant), take that set's positions in seq order.
 */
export function commitOrder<T>(items: readonly T[], changeOf: (item: T) => OrderedChange, scopeOf: (item: T) => string = () => ''): T[] {
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    for (let at = index; parent[at] !== root; ) {
      const next = parent[at] as number;
      parent[at] = root;
      at = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const [rootA, rootB] = [find(a), find(b)];
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };
  const firstByKey = new Map<string, number>();
  const updatesByAfter = new Map<string, number[]>();
  items.forEach((item, index) => {
    const row = changeOf(item);
    if (!projected(row)) return;
    const key = rowKey(scopeOf(item), rowKey(row.table, row.key));
    const first = firstByKey.get(key);
    if (first === undefined) firstByKey.set(key, index);
    else union(first, index);
    if (row.op === 'update' && row.after !== null) append(updatesByAfter, rowKey(scopeOf(item), rowKey(row.table, row.after)), index);
  });
  items.forEach((item, index) => {
    const row = changeOf(item);
    if (!projected(row) || !removes(row)) return;
    for (const update of updatesByAfter.get(rowKey(scopeOf(item), rowKey(row.table, row.before))) ?? []) union(update, index);
  });
  const groups = new Map<number, number[]>();
  for (let index = 0; index < items.length; index += 1) append(groups, find(index), index);
  const ordered = [...items];
  for (const slots of groups.values()) {
    if (slots.length < 2) continue;
    const bySeq = [...slots].sort((a, b) => {
      const left = BigInt(changeOf(items[a] as T).seq);
      const right = BigInt(changeOf(items[b] as T).seq);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    slots.forEach((slot, k) => {
      ordered[slot] = items[bySeq[k] as number] as T;
    });
  }
  return ordered;
}
