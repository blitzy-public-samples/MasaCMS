import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { config } from '../proxy';
import { IDENTITY_ACCEPT_ENCODING } from '@/lib/accept-encoding';

describe('next.config', () => {
  it('never compresses responses', () => {
    expect(nextConfig.compress).toBe(false);
  });

  it('sends Content-Encoding: identity on the proxied pages when Accept-Encoding negotiates it', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((rule) => rule.source)).toEqual(config.matcher);
    for (const rule of rules) {
      expect(rule.has).toEqual([{ type: 'header', key: 'accept-encoding', value: IDENTITY_ACCEPT_ENCODING }]);
      expect(rule.missing).toBeUndefined();
      expect(rule.headers).toEqual([{ key: 'Content-Encoding', value: 'identity' }]);
    }
  });

  // Next matches a `has` value as `new RegExp(`^${value}$`)` against the request header.
  it.each<[string, boolean]>([
    ['identity', true],
    ['gzip, identity;q=0.5', true],
    ['gzip, deflate', false],
    ['identity;q=0', false],
  ])('the Accept-Encoding condition matches %j: %s', (acceptEncoding, expected) => {
    expect(new RegExp(`^${IDENTITY_ACCEPT_ENCODING}$`).test(acceptEncoding)).toBe(expected);
  });
});
