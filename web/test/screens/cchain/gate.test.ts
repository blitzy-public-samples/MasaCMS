// The cchain before() gate of admin/core/controllers/cchain.cfc: S2 or the private-pool Admin of getSite(rc.siteid).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { cchainGate } from '@/screens/cchain';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';

const LIST = { circuit: 'cchain', item: 'list' } as const;
const ALLOW: GateDecision = { kind: 'allow' };

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The gate's decision for `req`, with how often it called `secure()`. */
async function gate(req: AdminRequest): Promise<{ decision: GateDecision; secureCalls: number }> {
  const spy = vi.fn(() => secure(req));
  const decision = await cchainGate(req, { secure: spy });
  return { decision, secureCalls: spy.mock.calls.length };
}

describe('cchainGate', () => {
  it.each<[string, () => AdminRequest, boolean]>([
    ['the S2 admin', () => adminS2Request(LIST), true],
    ['the tenant-a site admin', () => siteAdminRequest('tenant-a', LIST), true],
    ['the editor with Site Manager access', () => editorRequest(LIST), false],
    [
      'an editor whose rc claims S2 and Admin',
      () => editorRequest({ ...LIST, rc: { s2: '1', isSiteAdmin: 'true', memberships: 'S2,Admin;default;0' } }),
      false,
    ],
    [
      'a tenant-a system user',
      () => makeAdminRequest({ ...LIST, session: { siteid: 'tenant-a' } }, 'systemUser'),
      false,
    ],
    ['an anonymous user', () => anonymousRequest(LIST), false],
  ])('answers %s', async (_who, request, allowed) => {
    const req = request();
    expect(await gate(req)).toEqual(
      allowed ? { decision: ALLOW, secureCalls: 0 } : { decision: secure(req), secureCalls: 1 },
    );
  });

  it.each(REQUESTED_SITE_CASES)('admits $who only when it administers that site', async ({ request, administers }) => {
    const req = request(LIST);
    expect(await gate(req)).toEqual(
      administers ? { decision: ALLOW, secureCalls: 0 } : { decision: secure(req), secureCalls: 1 },
    );
  });
});
