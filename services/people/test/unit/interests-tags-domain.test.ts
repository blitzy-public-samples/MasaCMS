/** Interest and tag rows of a user save: the legacy comma-list rules. */
import { describe, expect, it } from 'vitest';
import { interestRowsFor, tagRowsFor } from '../../src/domain/interests-tags.js';

describe('interestRowsFor', () => {
  it.each<[string, string, string[]]>([
    ['an empty list', '', []],
    ['empty items skipped', ',a,,b,', ['a', 'b']],
    ['exact repeats collapsed to the first', 'a,b,a,b', ['a', 'b']],
    ['items kept untrimmed and case-sensitive', 'a, a,A', ['a', ' a', 'A']],
  ])('inserts %s', (_label, list, expected) => {
    expect(interestRowsFor('U-1', list)).toStrictEqual(expected.map((categoryid) => ({ userid: 'U-1', categoryid })));
  });
});

describe('tagRowsFor', () => {
  it.each<[string, string, string[]]>([
    ['an empty list', '', []],
    ['each item trimmed of spaces and control characters', ' red ,\tblue\n', ['red', 'blue']],
    ['blank items dropped', 'a,, ,\t,b', ['a', 'b']],
    ['duplicates kept in list order', 'red,blue,red', ['red', 'blue', 'red']],
    ['a non-breaking space kept, as CFML trim keeps it', '\u00a0x\u00a0', ['\u00a0x\u00a0']],
  ])('inserts %s', (_label, list, expected) => {
    expect(tagRowsFor('U-1', 'site-1', list)).toStrictEqual(expected.map((tag) => ({ userid: 'U-1', siteid: 'site-1', tag })));
  });
});
