// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { MASA_DEFAULT_MODULE_ID, MASA_HOME_CONTENT_ID, cfUuidFrom, formatCfUuid, stableId } from '../src/ids.js';
import { createRandom, type SeedRandom } from '../src/random.js';

const CF_UPPER = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

const ids = (rng: SeedRandom, n: number): string[] => Array.from({ length: n }, () => cfUuidFrom(rng));

/** Stream whose uint32() yields `words` in order. */
const fixedWords = (words: readonly number[]): SeedRandom => {
  let i = 0;
  return { uint32: () => words[i++] as number } as unknown as SeedRandom;
};

describe('formatCfUuid', () => {
  it('groups 32 hex characters 8-4-4-16 in uppercase', () => {
    expect(formatCfUuid('0123456789abcdef0123456789ABCDEF')).toBe('01234567-89AB-CDEF-0123456789ABCDEF');
  });

  it.each([
    ['xyz'],
    [''],
    ['0123456789abcdef0123456789abcde'],
    ['0123456789abcdef0123456789abcdef0'],
    ['0123456789abcdef0123456789abcdeg'],
    ['01234567-89ab-cdef-0123456789abcdef'],
  ])('throws for %j', (input) => {
    expect(() => formatCfUuid(input)).toThrow(RangeError);
  });
});

describe('cfUuidFrom', () => {
  it('yields a 35-character uppercase CF UUID the platform accepts', () => {
    const id = cfUuidFrom(createRandom(1));
    expect(id).toHaveLength(35);
    expect(id).toMatch(CF_UPPER);
    expect(isCfUuid(id)).toBe(true);
  });

  it('repeats the id sequence for an equal seed and differs between seeds', () => {
    const first = ids(createRandom(20260601), 50);
    expect(ids(createRandom(20260601), 50)).toEqual(first);
    expect(ids(createRandom(20260602), 50)).not.toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it('zero-pads each of the four words to eight hex characters', () => {
    expect(cfUuidFrom(fixedWords([0, 1, 0xabc, 0xffffffff]))).toBe('00000000-0000-0001-00000ABCFFFFFFFF');
  });

  it('consumes exactly four uint32 words', () => {
    const drawn = createRandom(7);
    cfUuidFrom(drawn);
    const skipped = createRandom(7);
    for (let i = 0; i < 4; i += 1) skipped.uint32();
    expect(drawn.uint32()).toBe(skipped.uint32());
  });
});

describe('stableId', () => {
  it('is the uppercase first 128 bits of SHA-256 over NUL-joined parts', () => {
    const digest = createHash('sha256').update('a\u00001').digest('hex').slice(0, 32);
    expect(stableId('a', 1)).toBe(formatCfUuid(digest));
    expect(isCfUuid(stableId('a', 1))).toBe(true);
    expect(stableId('a', 1)).toMatch(CF_UPPER);
  });

  it('is stable for equal parts and treats a number like its string', () => {
    expect(stableId('a', 1)).toBe(stableId('a', 1));
    expect(stableId('a', 1)).toBe(stableId('a', '1'));
  });

  it.each([
    [['a', 1], ['a', 2]],
    [['ab', 'c'], ['a', 'bc']],
    [['a'], ['a', '']],
  ])('differs between %j and %j', (left, right) => {
    expect(stableId(...left)).not.toBe(stableId(...right));
  });
});

describe('Masa fixed ids', () => {
  it.each([
    [MASA_HOME_CONTENT_ID, '00000000000000000000000000000000001'],
    [MASA_DEFAULT_MODULE_ID, '00000000000000000000000000000000000'],
  ])('%s is the 35-character Masa id', (actual, expected) => {
    expect(actual).toBe(expected);
    expect(actual).toHaveLength(35);
  });
});
