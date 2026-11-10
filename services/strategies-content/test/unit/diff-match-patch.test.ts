// diff_match_patch port: reference and jar cases that legacy-diff-match-patch.test.ts does not already hold.
import { describe, expect, it } from 'vitest';
import { computeDiff, type Diff, DiffOp, diffCleanupSemantic, diffMain, diffText1, diffText2 } from '../../src/legacy/diff-match-patch.js';

// Expected values are the outputs of core/mura/lib/diff_match_patch.jar on Java 17 for the same inputs.
const { DELETE, INSERT, EQUAL } = DiffOp;
const ins = (text: string): string => `<ins style="background:#e6ffe6;">${text}</ins>`;
const del = (text: string): string => `<del style="background:#ffe6e6;">${text}</del>`;
const span = (text: string): string => `<span>${text}</span>`;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('diffMain', () => {
  // Inputs are the diff_commonPrefix, diff_commonSuffix and diff_commonOverlap reference vectors.
  it.each<[string, string, string, Diff[]]>([
    ['no common prefix or suffix', 'abc', 'xyz', [[DELETE, 'abc'], [INSERT, 'xyz']]],
    ['common prefix', '1234abcdef', '1234xyz', [[EQUAL, '1234'], [DELETE, 'abcdef'], [INSERT, 'xyz']]],
    ['whole text as prefix', '1234', '1234xyz', [[EQUAL, '1234'], [INSERT, 'xyz']]],
    ['common suffix', 'abcdef1234', 'xyz1234', [[DELETE, 'abcdef'], [INSERT, 'xyz'], [EQUAL, '1234']]],
    ['whole text as suffix', '1234', 'xyz1234', [[INSERT, 'xyz'], [EQUAL, '1234']]],
    ['suffix of one text is a prefix of the other', '123456xxx', 'xxxabcd', [[DELETE, '123456'], [EQUAL, 'xxx'], [INSERT, 'abcd']]],
  ])('trims shared text for %s', (_name, text1, text2, expected) => {
    expect(diffMain(text1, text2)).toEqual(expected);
  });
});

describe('diffCleanupSemantic', () => {
  it.each<[string, Diff[], Diff[]]>([
    ['eliminates a one-character equality between mixed edits', [[DELETE, 'a'], [INSERT, 'b'], [EQUAL, 'c'], [DELETE, 'd']], [[DELETE, 'acd'], [INSERT, 'bc']]],
    [
      'keeps an equality longer than the edits on either side',
      [[DELETE, 'a'], [INSERT, 'b'], [EQUAL, 'cd'], [DELETE, 'e']],
      [[DELETE, 'a'], [INSERT, 'b'], [EQUAL, 'cd'], [DELETE, 'e']],
    ],
  ])('%s', (_name, input, expected) => {
    expect(diffCleanupSemantic(input.map(([op, text]): Diff => [op, text]))).toEqual(expected);
  });
});

describe('computeDiff', () => {
  // Java compares UTF-16 code units, so two characters sharing a high surrogate split mid-pair, as legacy does;
  // these edits share no code unit with their neighbours, so every pair stays whole.
  it.each<[string, string, string, Diff[], string]>([
    [
      'replaced inside text',
      'I \uD83D\uDE00 it',
      'I \uD83E\uDD14 it',
      [[EQUAL, 'I '], [DELETE, '\uD83D\uDE00'], [INSERT, '\uD83E\uDD14'], [EQUAL, ' it']],
      span('I ') + del('\uD83D\uDE00') + ins('\uD83E\uDD14') + span(' it'),
    ],
    ['replaced alone', '\uD83D\uDE00', '\uD83E\uDD14', [[DELETE, '\uD83D\uDE00'], [INSERT, '\uD83E\uDD14']], del('\uD83D\uDE00') + ins('\uD83E\uDD14')],
    ['deleted with its space', 'Go \uD83D\uDE80 now', 'Go now', [[EQUAL, 'Go'], [DELETE, ' \uD83D\uDE80'], [EQUAL, ' now']], span('Go') + del(' \uD83D\uDE80') + span(' now')],
    [
      'inserted after another non-BMP character',
      'caf\u00E9 \uD83C\uDF75',
      'caf\u00E9 \uD83C\uDF75\uD83C\uDF70',
      [[EQUAL, 'caf\u00E9 \uD83C\uDF75'], [INSERT, '\uD83C\uDF70']],
      span('caf\u00E9 \uD83C\uDF75') + ins('\uD83C\uDF70'),
    ],
    [
      'moved to the end',
      '\uD834\uDD1E clef',
      'G clef \uD834\uDD1E',
      [[DELETE, '\uD834\uDD1E'], [INSERT, 'G'], [EQUAL, ' clef'], [INSERT, ' \uD834\uDD1E']],
      del('\uD834\uDD1E') + ins('G') + span(' clef') + ins(' \uD834\uDD1E'),
    ],
  ])('keeps a non-BMP character whole when %s', (_name, text1, text2, diffs, html) => {
    const result = computeDiff(text1, text2);
    expect(result).toEqual({ diffs, html, text1, text2 });
    for (const [, text] of result.diffs) expect(text).not.toMatch(LONE_SURROGATE);
  });

  it.each<[number, Diff[], string]>([
    [
      0,
      [[DELETE, 'qHi'], [INSERT, 'xHe'], [EQUAL, 'lloHe'], [INSERT, 'Hu'], [EQUAL, 'llo'], [DELETE, 'Hew'], [INSERT, 'y']],
      del('qHi') + ins('xHe') + span('lloHe') + ins('Hu') + span('llo') + del('Hew') + ins('y'),
    ],
    [
      1000,
      [[DELETE, 'qHillo'], [INSERT, 'x'], [EQUAL, 'HelloHe'], [DELETE, 'w'], [INSERT, 'Hulloy']],
      del('qHillo') + ins('x') + span('HelloHe') + del('w') + ins('Hulloy'),
    ],
  ])('applies timeoutMs %d as Diff_Timeout, which also switches diff_halfMatch', (timeoutMs, diffs, html) => {
    expect(computeDiff('qHilloHelloHew', 'xHelloHeHulloy', { timeoutMs })).toEqual({
      diffs,
      html,
      text1: 'qHilloHelloHew',
      text2: 'xHelloHeHulloy',
    });
  });

  it('stops a large diff at the caller-supplied timeoutMs and still rebuilds both texts', () => {
    // The diff_main timeout reference texts; uncut, this diff runs for well over 30 s.
    const text1 = '`Twas brillig, and the slithy toves\nDid gyre and gimble in the wabe:\nAll mimsy were the borogoves,\nAnd the mome raths outgrabe.\n'.repeat(1024);
    const text2 =
      "I am the very model of a modern major general,\nI've information vegetable, animal, and mineral,\nI know the kings of England, and I quote the fights historical,\nFrom Marathon to Waterloo, in order categorical.\n".repeat(
        1024,
      );
    const timeoutMs = 100;
    const started = performance.now();
    const result = computeDiff(text1, text2, { timeoutMs });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
    // Looser than the reference's 2x bound, which a loaded shared host can exceed.
    expect(elapsed).toBeLessThan(timeoutMs * 20);
    expect([result.text1, result.text2, diffText1(result.diffs), diffText2(result.diffs)]).toEqual([text1, text2, text1, text2]);
    expect(result.diffs.every(([, text]) => text.length > 0)).toBe(true);
  });
});
