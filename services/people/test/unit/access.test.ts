/** cusers.cfc `before()` scrubbing of `ispublic` and `unassigned` over values admin start-up's Portcullis scan has cleaned. */
import { describe, expect, it } from 'vitest';
import { Roles, type UserClaims } from '@opt2/platform/auth';
import { normaliseCusersParams } from '../../src/routes/access.js';

const SITE = 'tenant-a';

/** Verified claims of a user of `SITE` holding `roles`. */
function claimsWith(roles: string[]): UserClaims {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: 'A0000000-0000-0000-0000000000000001',
    sid: 'S-1',
    tid: '00000000-0000-0000-0000-000000000000',
    site: SITE,
    roles,
    s2: false,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
}

const SITE_ADMIN = claimsWith([Roles.siteAdmin, Roles.systemUser]);
const EDITOR = claimsWith([Roles.systemUser]);

// Oracle: cUsers.listUsers on legacy echoes the scrubbed rc.ispublic in its search form and lists that pool.
describe('normaliseCusersParams scrubbing', () => {
  it.each<[sent: string, kept: string]>([
    ['no', 'no'],
    ['false', 'false'],
    ['YES', 'YES'],
    [' no', 'no'],
    ['\tFALSE\n', 'FALSE'],
    [' fALSE', 'fALSE'],
    [' True', 'True'],
    ['TRUE\u0001', 'TRUE'],
    ['no\u0000', 'no'],
    ['fa\u0000lse', 'false'],
    [' 0 ', '0'],
    [' 1.0', '1.0'],
    ['1.', '1.'],
    [' -0', '-0'],
    ['+0', '+0'],
    ['.0', '.0'],
    ['0e5', '0e5'],
    // The scan re-serializes these as JSON, padded lowercase literals as "YES" or "NO", and none is then a boolean.
    [' true', '1'],
    [' false', '1'],
    ['false\u0001', '1'],
    ['\u0001false', '1'],
    ['"0"', '1'],
    ['[0]', '1'],
    [' null', '1'],
    ['0x', '1'],
    ['\u007fno', '1'],
    ['\u00a0no', '1'],
    ['abc', '1'],
    ['', '1'],
  ])('keeps ispublic %j of an admin as %j', (sent, kept) => {
    const ctx = normaliseCusersParams({ ispublic: sent }, SITE_ADMIN);
    expect(ctx.ispublic).toBe(kept);
    expect(ctx.params.ispublic).toBe(kept);
  });

  it.each([' FALSE ', '0', ' no'])('scrubs ispublic %j of a non-admin to 1', (sent) => {
    expect(normaliseCusersParams({ ispublic: sent }, EDITOR).ispublic).toBe('1');
  });

  it.each<[sent: string, kept: string, link: 0 | 1]>([
    [' yes', 'yes', 0],
    [' TRUE', 'TRUE', 0],
    [' FALSE ', 'FALSE', 1],
    [' 1 ', '1', 0],
    ['no', 'no', 1],
    [' true', '0', 1],
    [' false', '0', 1],
    ['"1"', '0', 1],
    ['abc', '0', 1],
  ])('keeps unassigned %j as %j with unassignedlink %d', (sent, kept, link) => {
    const ctx = normaliseCusersParams({ unassigned: sent }, EDITOR);
    expect([ctx.unassigned, ctx.unassignedlink]).toEqual([kept, link]);
  });
});
