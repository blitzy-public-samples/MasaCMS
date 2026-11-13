// cusers.cfc addToGroup (272-277) against legacy: identity's CSRF-checked membership add, then cUsers route().
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { addToGroupAction } from '@/screens/cusers/addtogroup';
import { cusersGate } from '@/screens/cusers/gate';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { USER_IDS } from '../../fixtures/session';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;
type Fw1Redirect = Extract<SubmitResult, { kind: 'redirect' }>;

const USER_ID = USER_IDS.qaEditor;
const GROUP_ID = GROUP_IDS.defaultEditor;
const MEMBERSHIP_PATH: ServicePath = `/v1/groups/${GROUP_ID}/members/${USER_ID}`;
const MEMBERSHIP_ROUTE = routeKey('POST', 'identity', MEMBERSHIP_PATH);
const ROUTE_PATH = '/v1/users/route';
const PEOPLE_ROUTE = routeKey('GET', 'people', ROUTE_PATH);

const CSRF: Fields = { csrf_token: 'TESTCSRFTOKEN0000000000000000000', csrf_token_expires: '260630150000000' };

/** The rc of a request posting a membership with its CSRF pair. */
const ADD_RC: Fields = { userid: USER_ID, groupid: GROUP_ID, siteid: 'default', ...CSRF };

/** `fw.redirect(action='cUsers.listusers', append='siteid,ispublic', path='./')`. */
const LISTUSERS: Fw1Redirect = { kind: 'redirect', action: 'cUsers.listusers', append: 'siteid,ispublic', path: './' };

/** `fw.redirect(action='cUsers.editgroup', append='siteid,userid', path='./')`. */
const EDITGROUP: Fw1Redirect = { kind: 'redirect', action: 'cUsers.editgroup', append: 'siteid,userid', path: './' };

const WRITTEN: FakeReply = { status: 200, body: { written: true } };
const routed = (redirect: Readonly<Record<string, unknown>>): FakeReply => ({ status: 200, body: { redirect } });
const ROUTED_LISTUSERS = routed({ action: 'cUsers.listusers', params: { siteid: 'default', ispublic: '1' } });
const ROUTED_EDITGROUP = routed({ action: 'cUsers.editgroup', params: { siteid: 'default', userid: GROUP_ID } });

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

const requestFor = (rc: Fields): AdminRequest => adminS2Request({ circuit: 'cUsers', item: 'addToGroup', rc });

/** The context the redirect handler builds, without the shell, which a redirect action never renders. */
function contextFor(rc: Fields, gateway: FakeGatewayClient): ScreenContext {
  const req = requestFor(rc);
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

const gatewayWith = (membership: FakeReply, route: FakeReply = ROUTED_LISTUSERS): FakeGatewayClient =>
  fakeGatewayClient({ [MEMBERSHIP_ROUTE]: membership, [PEOPLE_ROUTE]: route });

/** The identity add call for `form`. */
const addCall = (form: Fields) => ({ service: 'identity', method: 'POST', path: MEMBERSHIP_PATH, form });

/** The people route() call for `query`. */
const routeCall = (query: Fields) => ({ service: 'people', method: 'GET', path: ROUTE_PATH, query });

const LISTUSERS_QUERY: Fields = { siteid: 'default', ispublic: '1', routeid: '', returnurl: '' };

describe('cUsers.addToGroup definition', () => {
  it('is the identity-owned redirect action behind the cUsers gate', () => {
    expect(addToGroupAction).toMatchObject({
      circuit: 'cusers',
      action: 'addtogroup',
      mode: 'redirect',
      owner: 'identity',
    });
    expect(addToGroupAction.gate).toBe(cusersGate);
    expect(addToGroupAction.variant).toBeUndefined();
  });
});

describe('cUsers.addToGroup submit', () => {
  it.each<{ shape: string; rc: Fields; form: Fields }>([
    { shape: 'a POST carrying a CSRF pair', rc: ADD_RC, form: { siteid: 'default', ...CSRF } },
    {
      shape: 'names in another case',
      rc: { UserID: USER_ID, GroupID: GROUP_ID, SiteID: 'default', CSRF_Token: CSRF.csrf_token ?? '' },
      form: { siteid: 'default', csrf_token: CSRF.csrf_token ?? '' },
    },
    { shape: 'a GET without a token', rc: { userid: USER_ID, groupid: GROUP_ID }, form: { siteid: 'default' } },
  ])('forwards the ids, site and CSRF fields of $shape unchanged, then routes', async ({ rc, form }) => {
    const gateway = gatewayWith(WRITTEN);

    await expect(addToGroupAction.submit(contextFor(rc, gateway))).resolves.toEqual(LISTUSERS);
    expect(gateway.calls).toEqual([addCall(form), routeCall(LISTUSERS_QUERY)]);
  });

  it.each<{ answer: string; reply: FakeReply }>([
    { answer: 'an invalid token, which adds nothing', reply: { status: 200, body: { written: false } } },
    {
      answer: 'an id identity rejects (400)',
      reply: { status: 400, body: { error: { type: 'invalidParameters', message: 'Invalid parameters' } } },
    },
  ])('routes as legacy on $answer', async ({ reply }) => {
    const gateway = gatewayWith(reply);

    await expect(addToGroupAction.submit(contextFor(ADD_RC, gateway))).resolves.toEqual(LISTUSERS);
    expect(gateway.calls).toEqual([addCall({ siteid: 'default', ...CSRF }), routeCall(LISTUSERS_QUERY)]);
  });

  it.each<{ missing: string; rc: Fields }>([
    { missing: 'no userid', rc: { groupid: GROUP_ID, siteid: 'default', ...CSRF } },
    { missing: 'no groupid', rc: { userid: USER_ID, siteid: 'default', ...CSRF } },
  ])('routes without an identity call for $missing', async ({ rc }) => {
    const gateway = gatewayWith(WRITTEN);

    await expect(addToGroupAction.submit(contextFor(rc, gateway))).resolves.toEqual(LISTUSERS);
    expect(gateway.calls).toEqual([routeCall(LISTUSERS_QUERY)]);
  });
});

describe('cUsers.addToGroup routing', () => {
  it('redirects to the cUsers.editgroup of a routeid', async () => {
    const gateway = gatewayWith(WRITTEN, ROUTED_EDITGROUP);
    const ctx = contextFor({ ...ADD_RC, routeid: GROUP_ID }, gateway);

    await expect(addToGroupAction.submit(ctx)).resolves.toEqual(EDITGROUP);
    expect(gateway.calls.at(-1)).toEqual(routeCall({ ...LISTUSERS_QUERY, routeid: GROUP_ID }));
    expect({ siteid: ctx.req.rc.siteid, userid: ctx.req.rc.userid }).toEqual({ siteid: 'default', userid: GROUP_ID });
  });

  it('goes to the return URL people sanitised', async () => {
    const returnurl = '//evil.example/x';
    const gateway = gatewayWith(WRITTEN, routed({ url: '/evil.example/x' }));

    await expect(addToGroupAction.submit(contextFor({ ...ADD_RC, returnurl }, gateway))).resolves.toEqual({
      kind: 'location',
      location: '/evil.example/x',
    });
    expect(gateway.calls.at(-1)).toEqual(routeCall({ ...LISTUSERS_QUERY, returnurl }));
  });
});

describe('cUsers.addToGroup failures', () => {
  it.each([401, 403] as const)('raises GatewayDenialError on %i without routing', async (status) => {
    const gateway = gatewayWith({ status, body: { error: 'denied' } });

    const failure = addToGroupAction.submit(contextFor(ADD_RC, gateway));
    await expect(failure).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(failure).rejects.toMatchObject({ service: 'identity', operation: 'addGroupMember', status });
    expect(gateway.calls).toHaveLength(1);
  });

  it('raises on a 500 from identity', async () => {
    const gateway = gatewayWith({ status: 500, body: { error: 'boom' } });

    await expect(addToGroupAction.submit(contextFor(ADD_RC, gateway))).rejects.toThrow(
      'addGroupMember answered HTTP 500',
    );
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    ...[502, 503, 504].map((status) => ({
      outage: `a ${status} answer from identity`,
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(MEMBERSHIP_ROUTE, { status, body: {} }),
    })),
    {
      outage: 'a 503 answer from people',
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(PEOPLE_ROUTE, { status: 503, body: {} }),
    },
  ])('propagates GatewayUnavailableError (legacy 503) on $outage', async ({ arrange }) => {
    const gateway = gatewayWith(WRITTEN);
    arrange(gateway);

    await expect(addToGroupAction.submit(contextFor(ADD_RC, gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
