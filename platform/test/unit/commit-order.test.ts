import { describe, expect, it } from 'vitest';
import { closedEndFrom, commitOrder, lastClosedEnd, predecessorEnds, type OrderedChange } from '../../src/migration-kit/index.js';

/** A target update of `key` in table `t` at `seq`, its images `before` and `after`. */
function change(seq: number, key: string, extra: Partial<OrderedChange> = {}): OrderedChange {
  return { seq: String(seq), table: 't', op: 'update', key, before: `${key}-before-${seq}`, after: `${key}-after-${seq}`, origin: 'target', ...extra };
}

/** predecessorEnds by brute force over every pair, for comparison. */
function referenceEnds(rows: readonly OrderedChange[]): number[] {
  return rows.map((later, index) => {
    let end = index;
    rows.forEach((earlier, at) => {
      const linked =
        earlier.key === later.key || (earlier.op === 'update' && later.op !== 'insert' && later.before !== null && earlier.after === later.before);
      const both = earlier.origin === 'target' && later.origin === 'target' && earlier.table === later.table;
      if (at > index && both && linked && BigInt(earlier.seq) < BigInt(later.seq)) end = Math.max(end, at);
    });
    return end;
  });
}

describe('predecessorEnds', () => {
  it.each<[string, OrderedChange[], number[]]>([
    ['rows in seq order need nothing later', [change(1, 'a'), change(2, 'a'), change(3, 'b')], [0, 1, 2]],
    // The committed-last row of a lower xid comes first in the cursor yet carries the higher seq.
    ['a row whose key reappears later with a lower seq needs that row', [change(20, 'a'), change(30, 'b'), change(10, 'a')], [2, 1, 2]],
    ['the last of several lower-seq rows of the key counts', [change(50, 'a'), change(10, 'a'), change(40, 'a'), change(60, 'a')], [2, 1, 2, 3]],
    ['a later row of the key with a higher seq is not needed', [change(10, 'a'), change(20, 'a')], [0, 1]],
    [
      'a keyless delete needs the earlier-seq update whose after-image it removes',
      [change(20, 'y', { op: 'delete', before: 'Y#1', after: null }), change(10, 'x', { after: 'Y#1' })],
      [1, 1],
    ],
    [
      'an insert never pairs with an update by image',
      [change(20, 'y', { op: 'insert', before: null, after: 'Y#1' }), change(10, 'x', { after: 'Y#1' })],
      [0, 1],
    ],
    ['rows of other origins order nothing', [change(20, 'a'), change(10, 'a', { origin: 'legacy-window' })], [0, 1]],
    ['a target row ignores a lower-seq row of another origin', [change(20, 'a', { origin: 'backfill' }), change(10, 'a')], [0, 1]],
    ['the same key in another table is another row', [change(20, 'a'), change(10, 'a', { table: 'u' })], [0, 1]],
  ])('%s', (_label, rows, expected) => {
    expect(predecessorEnds(rows)).toEqual(expected);
    expect(referenceEnds(rows)).toEqual(expected);
  });

  it('matches the pairwise reference over interleaved keys and seqs', () => {
    // A fixed permutation of 60 seqs over three keys, with every fifth row a keyless removal of an earlier update's image.
    const rows = Array.from({ length: 60 }, (_, i): OrderedChange => {
      const seq = ((i * 37) % 60) + 1;
      const key = `k${i % 3}`;
      return i % 5 === 4 ? change(seq, `r${i}`, { op: 'delete', before: `k${(i + 1) % 3}-after-${((((i + 7) % 60) * 37) % 60) + 1}`, after: null }) : change(seq, key);
    });
    expect(predecessorEnds(rows)).toEqual(referenceEnds(rows));
  });
});

describe('closed prefix ends', () => {
  const ends = [2, 1, 2, 5, 4, 5, 6];

  it.each<[number, number]>([
    [0, 2],
    [2, 2],
    [3, 5],
    [6, 6],
  ])('closes a prefix from %i at %i', (from, expected) => {
    expect(closedEndFrom(ends, from)).toBe(expected);
  });

  it.each<[number, number]>([
    [7, 6],
    [6, 5],
    [5, 2],
    [2, -1],
  ])('finds the last closed end before %i at %i', (before, expected) => {
    expect(lastClosedEnd(ends, before)).toBe(expected);
  });

  it('skips closed ends the boundary rejects', () => {
    expect(lastClosedEnd(ends, 7, (end) => end !== 6 && end !== 5)).toBe(2);
  });
});

describe('commitOrder', () => {
  const scopeOf = (item: { scope: string }): string => item.scope;
  const rowOf = (item: { row: OrderedChange }): OrderedChange => item.row;

  it('puts each row set in seq order within its own positions and leaves the other rows in place', () => {
    const items = [
      { id: 'a30', scope: 's', row: change(30, 'a') },
      { id: 'b5', scope: 's', row: change(5, 'b') },
      { id: 'a10', scope: 's', row: change(10, 'a') },
      { id: 'c1', scope: 's', row: change(1, 'c') },
      { id: 'a20', scope: 's', row: change(20, 'a') },
    ];
    expect(commitOrder(items, rowOf, scopeOf).map((item) => item.id)).toEqual(['a10', 'b5', 'a20', 'c1', 'a30']);
  });

  it('links a keyless removal to the update that left its image', () => {
    const items = [
      { id: 'delete', scope: 's', row: change(20, 'y', { op: 'delete', before: 'Y#1', after: null }) },
      { id: 'other', scope: 's', row: change(15, 'z') },
      { id: 'update', scope: 's', row: change(10, 'x', { after: 'Y#1' }) },
    ];
    expect(commitOrder(items, rowOf, scopeOf).map((item) => item.id)).toEqual(['update', 'other', 'delete']);
  });

  it('keeps rows of other scopes and other origins in their given order', () => {
    const items = [
      { id: 'tenant-1', scope: 't1', row: change(30, 'a') },
      { id: 'tenant-2', scope: 't2', row: change(10, 'a') },
      { id: 'window', scope: 't1', row: change(20, 'a', { origin: 'legacy-window' }) },
    ];
    expect(commitOrder(items, rowOf, scopeOf).map((item) => item.id)).toEqual(['tenant-1', 'tenant-2', 'window']);
  });
});
