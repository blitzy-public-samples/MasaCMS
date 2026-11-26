// Unit tests for the cFeed helpers beyond common-helpers.test.ts: error markup and CFML flags.
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { cfTruthy, displayErrors, yesNoFormat, type CfFlag } from '@/screens/cfeed/common';

describe('displayErrors', () => {
  it('breaks after a message a siteID key follows, not after the last message', () => {
    const markup = displayErrors({ name: 'A', siteID: 'default', maxItems: 'B' });
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe('A <br> B ');
  });
});

describe('cfTruthy and yesNoFormat', () => {
  it.each<[CfFlag, boolean]>([
    ['-1', true],
    ['0.5', true],
    ['-0', false],
    ['0.00', false],
  ])('reads the numeric string %j as %s', (value, expected) => {
    expect(cfTruthy(value)).toBe(expected);
    expect(yesNoFormat(value)).toBe(expected ? 'Yes' : 'No');
  });

  it('throws for an untrimmed numeric string, which ACF isBoolean rejects', () => {
    expect(() => cfTruthy(' 1')).toThrow(TypeError);
    expect(() => yesNoFormat(' 1')).toThrow(TypeError);
  });
});
