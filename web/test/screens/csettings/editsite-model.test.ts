import { describe, expect, it } from 'vitest';
import { toString, type SafeHtml } from '@/lib/html';
import { cfEq, cfListFind, checked, selected } from '@/screens/csettings/editsite/model';

describe('csettings.editsite model helpers', () => {
  it.each<[unknown, unknown, boolean]>([
    [1, '1', true],
    ['true', 1, true],
    ['None', 'none', true],
    ['', 0, false],
    ['yes', 1, true],
    ['no', 0, true],
    ['false', 1, false],
    ['true', 2, false],
    [true, 1, true],
    [' 1', 1, true],
    ['1.0', '1', true],
    ['1.', '1', false],
    [' abc', 'abc', false],
    ['yes', 'true', false],
    [null, '', true],
    [3, 4, false],
  ])('cfEq(%j, %j) is %s both ways', (a, b, expected) => {
    expect(cfEq(a, b)).toBe(expected);
    expect(cfEq(b, a)).toBe(expected);
  });

  it.each<[string, string, string, boolean]>([
    ['a,b', 'b', ',', true],
    ['a,b', 'c', ',', false],
    ['A,b', 'a', ',', false],
    [',a,,b,', 'b', ',', true],
    ['a,,b', '', ',', false],
    ['a,b', 'a,b', ',', false],
    ['a^b', 'b', '^', true],
    ['a;b,c', 'c', ';,', true],
  ])('cfListFind(%j, %j, %j) is %s', (list, value, delim, expected) => {
    expect(cfListFind(list, value, delim)).toBe(expected);
  });

  it('cfListFind delimits on commas by default', () => {
    expect(cfListFind('a^b', 'b')).toBe(false);
    expect(cfListFind('tenant-a,umbrella', 'umbrella')).toBe(true);
  });

  it.each<[string, (cond: boolean) => SafeHtml, boolean, string]>([
    ['checked', checked, true, ' checked'],
    ['checked', checked, false, ''],
    ['selected', selected, true, ' selected'],
    ['selected', selected, false, ''],
  ])('%s(%s) renders the attribute token', (_name, helper, cond, expected) => {
    expect(toString(helper(cond))).toBe(expected);
  });
});
