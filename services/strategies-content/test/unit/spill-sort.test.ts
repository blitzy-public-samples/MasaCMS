/** SpillSort: windows of the order Array.prototype.sort gives, items past the budget spilled and merged back, temporary files removed. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpillSort } from '../../src/routes/jsonapi/spill-sort.js';

/** One sorted item: a key and its push position, which breaks ties. */
interface Item {
  key: number | string;
  position: number;
}

const byKey = (a: Item, b: Item): number => {
  const diff = typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : String(a.key).localeCompare(String(b.key));
  return diff !== 0 ? diff : a.position - b.position;
};

/** A sort of items whose estimated size is one byte per key character, spilling past `budget`. */
function sortOf(budget: number, compare: (a: Item, b: Item) => number = byKey): SpillSort<Item> {
  return new SpillSort<Item>({
    compare,
    encode: (item) => JSON.stringify(item),
    decode: (line) => JSON.parse(line) as Item,
    size: (item) => String(item.key).length,
    budget,
  });
}

/** Pushes `items` in `batch`-sized batches, settling after each. */
async function pushAll(sort: SpillSort<Item>, items: readonly Item[], batch: number): Promise<void> {
  for (let from = 0; from < items.length; from += batch) {
    for (const item of items.slice(from, from + batch)) sort.push(item);
    await sort.settle();
  }
}

/** Deterministic pseudo-random keys with many ties. */
function itemsOf(count: number, text: boolean): Item[] {
  let seed = 7;
  return Array.from({ length: count }, (_, position) => {
    seed = (seed * 48271) % 2147483647;
    const key = seed % 97;
    return { key: text ? `k${String(key).padStart(3, '0')}\n"\u{1F600}\uD800` : key, position };
  });
}

let root: string;
let previous: string | undefined;

beforeEach(async () => {
  previous = process.env['TMPDIR'];
  root = await mkdtemp(path.join(tmpdir(), 'spill-sort-test-'));
  process.env['TMPDIR'] = root;
});

afterEach(async () => {
  if (previous === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = previous;
  await rm(root, { recursive: true, force: true });
});

describe('SpillSort', () => {
  it.each<[string, number, number, boolean, number, number]>([
    ['held whole, the first page', 2000, 1_000_000, false, 0, 10],
    ['spilled numbers, the first page', 2000, 300, false, 0, 10],
    ['spilled numbers, a middle page', 2000, 300, false, 995, 1010],
    ['spilled numbers, the last page', 2000, 300, false, 1990, 2010],
    ['spilled numbers, every item', 2000, 300, false, 0, 2000],
    ['spilled text with line breaks, quotes and surrogates, a middle page', 1500, 900, true, 700, 720],
    ['spilled numbers, no item', 2000, 300, false, 0, 0],
  ])('answers %s as Array.prototype.sort orders every item', async (_label, count, budget, text, from, to) => {
    const items = itemsOf(count, text);
    const sort = sortOf(budget);
    await pushAll(sort, items, 64);
    const spilled = await readdir(root);
    expect(spilled).toHaveLength(budget < count * 5 ? 1 : 0);
    expect(await sort.window(from, to, true)).toEqual([...items].sort(byKey).slice(from, to));
    await sort.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it('sorts every spilled item in memory, in push order, for a comparator that is not consistent', async () => {
    // NaN keys make the comparator inconsistent, so only Array.prototype.sort over the push order gives its answer.
    const items = itemsOf(1200, false).map((item, i) => (i % 7 === 0 ? { ...item, key: Number.NaN } : item));
    const nanCompare = (a: Item, b: Item): number => {
      const diff = Number(a.key) - Number(b.key);
      return diff !== 0 ? diff : a.position - b.position;
    };
    const encoded = new SpillSort<Item>({
      compare: nanCompare,
      encode: (item) => JSON.stringify({ key: String(item.key), position: item.position }),
      decode: (line) => {
        const { key, position } = JSON.parse(line) as { key: string; position: number };
        return { key: Number(key), position };
      },
      size: () => 4,
      budget: 400,
    });
    await pushAll(encoded, items, 50);
    expect(await readdir(root)).toHaveLength(1);
    const expected = [...items].sort(nanCompare);
    expect(await encoded.window(0, items.length, false)).toEqual(expected);
    await encoded.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it.each<[string, number]>([
    ['sorting a spilled run', 7],
    ['merging the runs', 1500],
  ])('raises what the comparator raises while %s, and dispose removes the files', async (_label, raisingAt) => {
    const items = itemsOf(2000, false);
    const raising = (a: Item, b: Item): number => {
      if (a.position === raisingAt && b.position !== raisingAt && b.key === a.key) throw new TypeError('Complex object types cannot be converted to simple values.');
      if (b.position === raisingAt && a.position !== raisingAt && a.key === b.key) throw new TypeError('Complex object types cannot be converted to simple values.');
      return byKey(a, b);
    };
    const sort = sortOf(300, raising);
    await pushAll(sort, items, 64);
    await expect(sort.window(0, 1, true)).rejects.toThrow('Complex object types cannot be converted to simple values.');
    expect(await readdir(root)).toHaveLength(1);
    await sort.dispose();
    await sort.dispose();
    expect(await readdir(root)).toEqual([]);
  });

  it('creates no file while the items fit the budget', async () => {
    const sort = sortOf(1_000_000);
    await pushAll(sort, itemsOf(500, true), 100);
    expect(await sort.window(0, 3, true)).toHaveLength(3);
    expect(await readdir(root)).toEqual([]);
    await sort.dispose();
  });
});
