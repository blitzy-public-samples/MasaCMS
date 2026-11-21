// cusers.cfc removeFromGroup (279-282) against legacy: identity's membership delete, then FW/1's preserving redirect.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { fw1RedirectTarget } from '@/lib/urls';
import { cusersGate } from '@/screens/cusers/gate';
import { removeFromGroupAction } from '@/screens/cusers/removefromgroup';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { USER_IDS } from '../../fixtures/session';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const USER_ID = USER_IDS.qaEditor;
const GROUP_ID = GROUP_IDS.defaultEditor;
const MEMBERSHIP_PATH: ServicePath = `/v1/groups/${GROUP_ID}/members/${USER_ID}`;
const MEMBERSHIP_ROUTE = routeKey('DELETE', 'identity', MEMBERSHIP_PATH);

/** The rc of the `inc/dsp_users_list` remove link on the group's members screen. */
const LINK_RC: Fields = { userid: USER_ID, routeid: GROUP_ID, groupid: GROUP_ID, siteid: 'default' };

/** `fw.redirect(action='cUsers.editGroupMembers', preserve='groupid,siteid')`. */
const MEMBERS_REDIRECT: Extract<SubmitResult, { kind: 'redirect' }> = {
  kind: 'redirect',
  action: 'cUsers.editGroupMembers',
  preserve: 'groupid,siteid',
};

const WRITTEN: FakeReply = { status: 200, body: { written: true } };

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

const requestFor = (rc: Fields): AdminRequest => adminS2Request({ circuit: 'cUsers', item: 'removeFromGroup', rc });

/** The context the redirect handler builds, without the shell, which a redirect action never renders. */
function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

const submit = (rc: Fields, gateway: FakeGatewayClient): Promise<SubmitResult> =>
  removeFromGroupAction.submit(contextFor(requestFor(rc), gateway));

describe('cUsers.removeFromGroup definition', () => {
  it('is the identity-owned redirect action behind the cUsers gate', () => {
    expect(removeFromGroupAction).toMatchObject({
      circuit: 'cusers',
      action: 'removefromgroup',
      mode: 'redirect',
      owner: 'identity',
    });
    expect(removeFromGroupAction.gate).toBe(cusersGate);
    expect(removeFromGroupAction.variant).toBeUndefined();
  });
});

describe('cUsers.removeFromGroup submit', () => {
  it.each<{ shape: string; rc: Fields }>([
    { shape: 'the members-list GET link', rc: LINK_RC },
    {
      shape: 'a POST carrying a CSRF pair',
      rc: { ...LINK_RC, csrf_token: 'TESTCSRFTOKEN0000000000000000000', csrf_token_expires: '260630150000000' },
    },
    { shape: 'names in another case', rc: { UserID: USER_ID, GroupID: GROUP_ID, SiteID: 'default' } },
  ])('deletes the membership of $shape with no CSRF token, then redirects as legacy', async ({ rc }) => {
    const gateway = fakeGatewayClient({ [MEMBERSHIP_ROUTE]: WRITTEN });

    await expect(submit(rc, gateway)).resolves.toEqual(MEMBERS_REDIRECT);
    expect(gateway.calls).toEqual([{ service: 'identity', method: 'DELETE', path: MEMBERSHIP_PATH }]);
  });

  it.each<{ answer: string; reply: FakeReply }>([
    { answer: 'no membership removed', reply: { status: 200, body: { written: false } } },
    {
      answer: 'an id identity rejects (400)',
      reply: { status: 400, body: { error: { type: 'invalidParameters', message: 'Invalid parameters' } } },
    },
  ])('redirects as legacy on $answer', async ({ reply }) => {
    const gateway = fakeGatewayClient({ [MEMBERSHIP_ROUTE]: reply });

    await expect(submit(LINK_RC, gateway)).resolves.toEqual(MEMBERS_REDIRECT);
    expect(gateway.calls).toEqual([{ service: 'identity', method: 'DELETE', path: MEMBERSHIP_PATH }]);
  });

  it.each<{ missing: string; rc: Fields }>([
    { missing: 'no userid', rc: { groupid: GROUP_ID, siteid: 'default' } },
    { missing: 'no groupid', rc: { userid: USER_ID, siteid: 'default' } },
    { missing: 'an empty userid', rc: { ...LINK_RC, userid: '' } },
  ])("redirects without a call for $missing, whose legacy delete matches no row", async ({ rc }) => {
    const gateway = fakeGatewayClient({ [MEMBERSHIP_ROUTE]: WRITTEN });

    await expect(submit(rc, gateway)).resolves.toEqual(MEMBERS_REDIRECT);
    expect(gateway.calls).toEqual([]);
  });

  it.each([401, 403] as const)('raises GatewayDenialError on %i', async (status) => {
    const gateway = fakeGatewayClient({ [MEMBERSHIP_ROUTE]: { status, body: { error: 'denied' } } });

    const failure = submit(LINK_RC, gateway);
    await expect(failure).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(failure).rejects.toMatchObject({ service: 'identity', operation: 'removeGroupMember', status });
  });

  it('raises on a 500 from identity', async () => {
    const gateway = fakeGatewayClient({ [MEMBERSHIP_ROUTE]: { status: 500, body: { error: 'boom' } } });

    await expect(submit(LINK_RC, gateway)).rejects.toThrow('removeGroupMember answered HTTP 500');
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    ...[502, 503, 504].map((status) => ({
      outage: `a ${status} answer`,
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(MEMBERSHIP_ROUTE, { status, body: {} }),
    })),
  ])('propagates GatewayUnavailableError (legacy 503) on $outage', async ({ arrange }) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    await expect(submit(LINK_RC, gateway)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('cUsers.removeFromGroup redirect target', () => {
  // Captured from the Location of the legacy action on a per-clone instance, preserve key 1.
  it("matches legacy's Location with FW/1's default path", () => {
    expect(fw1RedirectTarget({ action: MEMBERS_REDIRECT.action, preserveKey: 1 })).toBe(
      '/admin/index.cfm?muraAction=cUsers.editGroupMembers&fw1pk=1',
    );
  });
});
