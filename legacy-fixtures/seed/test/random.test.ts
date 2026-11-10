// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, expect, it } from 'vitest';
import { createRandom, type SeedRandom } from '../src/random.js';

const SEED = 20260601;
const DRAWS = 2000;

const sample = (r: SeedRandom): unknown[] => [
  r.int32(),
  r.uint32(),
  r.double(),
  r.int(-50, 50),
  r.bool(0.3),
  r.pick(['a', 'b', 'c']),
  r.pickMany([1, 2, 3, 4, 5], 3),
  r.shuffle([1, 2, 3, 4, 5]),
  r.weighted([
    ['x', 1],
    ['y', 2],
  ]),
  r.hex(6),
  r.faker.person.fullName(),
  r.faker.internet.email(),
];

const draw = <T>(n: number, fn: () => T): T[] => Array.from({ length: n }, fn);

describe('createRandom', () => {
  it('labels the stream with the stringified seed', () => {
    expect(createRandom(SEED).label).toBe('20260601');
    expect(createRandom('tenant-a').label).toBe('tenant-a');
  });

  it('repeats the sequence for an equal seed', () => {
    expect(sample(createRandom(SEED))).toEqual(sample(createRandom(SEED)));
  });

  it('treats a number seed and its string as equal', () => {
    expect(sample(createRandom(SEED))).toEqual(sample(createRandom(String(SEED))));
  });

  it.each([
    [SEED, SEED + 1],
    ['tenant-a', 'tenant-b'],
  ])('differs between seeds %s and %s', (a, b) => {
    const first = sample(createRandom(a));
    const second = sample(createRandom(b));
    expect(first).not.toEqual(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[10]).not.toBe(second[10]);
  });

  it('keeps faker draws off the main stream', () => {
    const plain = createRandom(SEED);
    const withFaker = createRandom(SEED);
    withFaker.faker.person.fullName();
    withFaker.faker.string.uuid();
    expect(draw(5, () => withFaker.int32())).toEqual(draw(5, () => plain.int32()));
  });

  it('keeps main draws off faker', () => {
    const plain = createRandom(SEED);
    const drained = createRandom(SEED);
    draw(10, () => drained.double());
    expect(drained.faker.person.fullName()).toBe(plain.faker.person.fullName());
  });
});

describe('fork', () => {
  it('labels the child <label>/<child>', () => {
    expect(createRandom('s').fork('c').label).toBe('s/c');
    expect(createRandom('s').fork('c').fork('d').label).toBe('s/c/d');
  });

  it('equals a stream created from the child label', () => {
    expect(sample(createRandom(SEED).fork('people'))).toEqual(sample(createRandom(`${SEED}/people`)));
  });

  it('leaves the parent stream untouched', () => {
    const parent = createRandom(SEED);
    const fresh = createRandom(SEED);
    draw(10, () => parent.fork('child').int32());
    expect(draw(5, () => parent.int32())).toEqual(draw(5, () => fresh.int32()));
  });

  it('differs from the parent and from sibling forks', () => {
    const root = createRandom(SEED);
    const a = sample(root.fork('a'));
    expect(a).not.toEqual(sample(root.fork('b')));
    expect(a).not.toEqual(sample(createRandom(SEED)));
  });
});

describe('integer draws', () => {
  it('int32 is a signed 32-bit integer', () => {
    const r = createRandom(SEED);
    const values = draw(DRAWS, () => r.int32());
    expect(values.every((v) => Number.isInteger(v) && v >= -(2 ** 31) && v <= 2 ** 31 - 1)).toBe(true);
    expect(values.some((v) => v < 0)).toBe(true);
  });

  it('uint32 is the unsigned view of int32', () => {
    const r = createRandom(SEED);
    const twin = createRandom(SEED);
    const values = draw(DRAWS, () => r.uint32());
    expect(values).toEqual(draw(DRAWS, () => twin.int32() >>> 0));
    expect(values.every((v) => Number.isInteger(v) && v >= 0 && v <= 2 ** 32 - 1)).toBe(true);
    expect(values.some((v) => v > 2 ** 31 - 1)).toBe(true);
  });

  it('double is in [0, 1)', () => {
    const r = createRandom(SEED);
    const values = draw(DRAWS, () => r.double());
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBe(DRAWS);
  });

  it.each([
    [1, 6],
    [-3, 3],
    [0, 1],
    [5, 5],
  ])('int(%d, %d) stays inside and reaches both bounds', (min, max) => {
    const r = createRandom(SEED);
    const values = draw(DRAWS, () => r.int(min, max));
    expect(values.every((v) => Number.isInteger(v) && v >= min && v <= max)).toBe(true);
    expect(new Set(values).size).toBe(max - min + 1);
  });

  it('int accepts the full safe-integer range', () => {
    const r = createRandom(SEED);
    const values = draw(DRAWS, () => r.int(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    expect(values.every((v) => Number.isSafeInteger(v))).toBe(true);
  });

  it.each([
    [2, 1],
    [0.5, 1],
    [0, 1.5],
    [Number.NaN, 1],
    [0, Number.POSITIVE_INFINITY],
    [0, 2 ** 53],
  ])('int(%d, %d) throws', (min, max) => {
    expect(() => createRandom(SEED).int(min, max)).toThrow(
      new RangeError(`int(${min}, ${max}): bounds must be safe integers with min <= max`),
    );
  });
});

describe('bool', () => {
  it.each([
    [0, 0],
    [1, DRAWS],
  ])('bool(%d) is true %d times', (p, expected) => {
    const r = createRandom(SEED);
    expect(draw(DRAWS, () => r.bool(p)).filter(Boolean)).toHaveLength(expected);
  });

  it.each([
    [undefined, 0.5],
    [0.2, 0.2],
    [0.9, 0.9],
  ])('bool(%s) is true at a rate near %s', (p, rate) => {
    const r = createRandom(SEED);
    const trues = draw(DRAWS, () => r.bool(p)).filter(Boolean).length;
    expect(Math.abs(trues / DRAWS - rate)).toBeLessThan(0.05);
  });
});

describe('pick', () => {
  it('returns every element over many draws, nothing else', () => {
    const r = createRandom(SEED);
    const items = ['a', 'b', 'c', 'd'] as const;
    const values = draw(DRAWS, () => r.pick(items));
    expect(new Set(values)).toEqual(new Set(items));
  });

  it('returns the only element', () => {
    expect(createRandom(SEED).pick(['only'])).toBe('only');
  });

  it('throws on an empty array', () => {
    expect(() => createRandom(SEED).pick([])).toThrow(new RangeError('pick: array is empty'));
  });
});

describe('pickMany', () => {
  const items = Object.freeze([10, 20, 30, 40, 50, 60]);

  it.each([0, 1, 3, 6])('returns %d distinct elements of the input', (n) => {
    const r = createRandom(SEED);
    const picked = r.pickMany(items, n);
    expect(picked).toHaveLength(n);
    expect(new Set(picked).size).toBe(n);
    expect(picked.every((v) => items.includes(v))).toBe(true);
  });

  it('picks from distinct positions when values repeat', () => {
    const picked = createRandom(SEED).pickMany(['x', 'x', 'y'], 3);
    expect([...picked].sort()).toEqual(['x', 'x', 'y']);
  });

  it('varies the selection across draws', () => {
    const r = createRandom(SEED);
    const seen = new Set(draw(50, () => r.pickMany(items, 2).join(',')));
    expect(seen.size).toBeGreaterThan(10);
  });

  it.each([-1, 7, 1.5, Number.NaN])('throws for n = %d', (n) => {
    expect(() => createRandom(SEED).pickMany(items, n)).toThrow(
      new RangeError(`pickMany: n must be an integer in [0, 6], got ${n}`),
    );
  });
});

describe('shuffle', () => {
  it('returns a permutation and leaves the input unchanged', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = createRandom(SEED).shuffle(input);
    expect(out).not.toBe(input);
    expect([...out].sort((a, b) => a - b)).toEqual([...input]);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it.each([[[]], [[42]]])('copies %j unchanged', (input: number[]) => {
    const out = createRandom(SEED).shuffle(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('reaches every ordering of three elements', () => {
    const r = createRandom(SEED);
    const orders = new Set(draw(300, () => r.shuffle(['a', 'b', 'c']).join('')));
    expect(orders.size).toBe(6);
  });
});

describe('weighted', () => {
  it('chooses in proportion to weight', () => {
    const r = createRandom(SEED);
    const values = draw(DRAWS, () =>
      r.weighted([
        ['low', 1],
        ['high', 3],
      ]),
    );
    const high = values.filter((v) => v === 'high').length / DRAWS;
    expect(Math.abs(high - 0.75)).toBeLessThan(0.05);
  });

  it('never chooses a zero-weight entry', () => {
    const r = createRandom(SEED);
    const entries = [
      ['zero-first', 0],
      ['a', 1],
      ['zero-mid', 0],
      ['b', 1],
      ['zero-last', 0],
    ] as const;
    expect(new Set(draw(DRAWS, () => r.weighted(entries)))).toEqual(new Set(['a', 'b']));
  });

  it('returns the only positive-weight entry', () => {
    expect(
      createRandom(SEED).weighted([
        ['none', 0],
        ['all', 0.25],
      ]),
    ).toBe('all');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('throws for weight %d', (weight) => {
    expect(() =>
      createRandom(SEED).weighted([
        ['ok', 1],
        ['bad', weight],
      ]),
    ).toThrow(new RangeError(`weighted: invalid weight ${weight}`));
  });

  it.each([
    ['empty', []],
    ['all zero', [['a', 0], ['b', 0]]],
    ['overflowing', [['a', Number.MAX_VALUE], ['b', Number.MAX_VALUE]]],
  ] as [string, [string, number][]][])('throws for %s entries', (_name, entries) => {
    expect(() => createRandom(SEED).weighted(entries)).toThrow(
      new RangeError('weighted: total weight must be positive and finite'),
    );
  });
});

describe('bytes and hex', () => {
  it.each([0, 1, 3, 4, 5, 8, 33])('bytes(%d) has that length', (n) => {
    expect(createRandom(SEED).bytes(n)).toHaveLength(n);
  });

  it('takes bytes from little-endian uint32 words', () => {
    const twin = createRandom(SEED);
    const words = Buffer.alloc(8);
    words.writeUInt32LE(twin.uint32(), 0);
    words.writeUInt32LE(twin.uint32(), 4);
    expect(createRandom(SEED).bytes(6)).toEqual(words.subarray(0, 6));
  });

  it('consumes whole words per call', () => {
    const r = createRandom(SEED);
    const twin = createRandom(SEED);
    r.bytes(5);
    twin.uint32();
    twin.uint32();
    expect(r.uint32()).toBe(twin.uint32());
  });

  it('bytes(0) consumes nothing', () => {
    const r = createRandom(SEED);
    r.bytes(0);
    expect(r.int32()).toBe(createRandom(SEED).int32());
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])('bytes(%d) throws', (n) => {
    expect(() => createRandom(SEED).bytes(n)).toThrow(new RangeError(`bytes: invalid length ${n}`));
  });

  it.each([0, 1, 16])('hex(%d) is the lowercase hex of the same bytes', (n) => {
    const text = createRandom(SEED).hex(n);
    expect(text).toHaveLength(2 * n);
    expect(text).toMatch(/^[0-9a-f]*$/);
    expect(text).toBe(createRandom(SEED).bytes(n).toString('hex'));
  });
});
