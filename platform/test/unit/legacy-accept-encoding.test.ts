// Tests of the container's `identity` content negotiation.
import { describe, expect, it } from 'vitest';
import { negotiatesIdentityEncoding } from '../../src/legacy-compat/index.js';

describe('negotiatesIdentityEncoding', () => {
  it.each<[string | null | undefined, boolean]>([
    ['identity', true],
    ['identity, gzip', true],
    ['gzip, identity', true],
    ['*', true],
    ['identity;q=0.001', true],
    ['identity ;q=1', true],
    ['gzip;q=0.5, identity;q=0.1', true],
    ['*, gzip;q=0', true],
    ['IDENTITY', false],
    ['gzip, deflate, br', false],
    ['', false],
    [null, false],
    [undefined, false],
    ['identity;q=0', false],
    ['identity;q=0.000', false],
    ['gzip;q=0, identity;q=0', false],
  ])('reads %j as negotiating identity: %s', (value, expected) => {
    expect(negotiatesIdentityEncoding(value)).toBe(expected);
  });
});
