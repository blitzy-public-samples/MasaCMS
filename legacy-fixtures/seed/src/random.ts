// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import seedrandom from 'seedrandom';
import { Faker, en, base } from '@faker-js/faker';

/** Deterministic random stream; every value it yields derives from its label. */
export interface SeedRandom {
  /** Seed string of this stream. */
  readonly label: string;
  /** Signed 32-bit integer. */
  int32(): number;
  /** Unsigned 32-bit integer. */
  uint32(): number;
  /** Float in [0, 1). */
  double(): number;
  /** Integer in [min, max], both bounds inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** One element; throws on an empty array. */
  pick<T>(arr: readonly T[]): T;
  /** `n` elements from distinct positions, in draw order. */
  pickMany<T>(arr: readonly T[], n: number): T[];
  /** Shuffled copy; the input is left unchanged. */
  shuffle<T>(arr: readonly T[]): T[];
  /** One value, chosen with probability proportional to its weight. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** `n` bytes taken from little-endian `uint32()` words. */
  bytes(n: number): Buffer;
  /** Lowercase hex of `bytes(n)`, `2n` characters. */
  hex(n: number): string;
  /** Independent stream labelled `<label>/<child label>`; drawing from it leaves this stream untouched. */
  fork(label: string): SeedRandom;
  /** English faker seeded from a separate stream, so its draws do not consume this one. */
  readonly faker: Faker;
}

function swap<T>(arr: T[], i: number, j: number): void {
  const held = arr[i] as T;
  arr[i] = arr[j] as T;
  arr[j] = held;
}

/** Creates the stream for `seed`; equal seeds yield identical sequences, faker included. */
export function createRandom(seed: number | string): SeedRandom {
  const label = String(seed);
  const prng = seedrandom(label);
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seedrandom(`${label}#faker`).int32() >>> 0);

  const int32 = (): number => prng.int32();
  const uint32 = (): number => int32() >>> 0;
  const double = (): number => prng.double();

  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`int(${min}, ${max}): bounds must be safe integers with min <= max`);
    }
    return min + Math.floor(double() * (max - min + 1));
  };

  const bool = (p = 0.5): boolean => double() < p;

  const pick = <T>(arr: readonly T[]): T => {
    if (arr.length === 0) throw new RangeError('pick: array is empty');
    return arr[int(0, arr.length - 1)] as T;
  };

  const pickMany = <T>(arr: readonly T[], n: number): T[] => {
    if (!Number.isInteger(n) || n < 0 || n > arr.length) {
      throw new RangeError(`pickMany: n must be an integer in [0, ${arr.length}], got ${n}`);
    }
    const pool = arr.slice();
    for (let i = 0; i < n; i += 1) swap(pool, i, int(i, pool.length - 1));
    return pool.slice(0, n);
  };

  const shuffle = <T>(arr: readonly T[]): T[] => {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i -= 1) swap(out, i, int(0, i));
    return out;
  };

  const weighted = <T>(entries: readonly (readonly [T, number])[]): T => {
    let total = 0;
    for (const [, weight] of entries) {
      if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`weighted: invalid weight ${weight}`);
      total += weight;
    }
    if (!Number.isFinite(total) || total <= 0) throw new RangeError('weighted: total weight must be positive and finite');
    const target = double() * total;
    let reached = 0;
    let chosen: T | undefined;
    for (const [value, weight] of entries) {
      if (weight === 0) continue;
      chosen = value;
      reached += weight;
      if (target < reached) break;
    }
    // A positive total guarantees one positive-weight entry; floating-point rounding falls back to the last of them.
    return chosen as T;
  };

  const bytes = (n: number): Buffer => {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bytes: invalid length ${n}`);
    const words = Buffer.alloc(Math.ceil(n / 4) * 4);
    for (let offset = 0; offset < words.length; offset += 4) words.writeUInt32LE(uint32(), offset);
    return words.subarray(0, n);
  };

  const hex = (n: number): string => bytes(n).toString('hex');

  const fork = (child: string): SeedRandom => createRandom(`${label}/${child}`);

  return { label, int32, uint32, double, int, bool, pick, pickMany, shuffle, weighted, bytes, hex, fork, faker };
}
