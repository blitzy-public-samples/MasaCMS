// cusers.cfc route() (377-398) against legacy: people's routeUser clears the retained edit values, then the redirect.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { fw1RedirectTarget } from '@/lib/urls';
import { cusersGate } from '@/screens/cusers/gate';
import { cusersRoute, routeAction } from '@/screens/cusers/route';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { adminS2Request, makeAdminRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

type Fields = Readonly<Record<string, string>>;
type Fw1Redirect = Extract<SubmitResult, { kind: 'redirect' }>;

const PATH = '/v1/users/route';
const ROUTE = routeKey('GET', 'people', PATH);
const OPERATION = 'routeUser';
const GROUP_ID = GROUP_IDS.defaultEditor;
const USERS_MODULE = '00000000000000000000000000000000008';
const SITE_MODULE = '00000000000000000000000000000000000';

/** `fw.redirect(action='cUsers.listusers', append='siteid,ispublic', path='./')`. */
const LISTUSERS: Fw1Redirect = { kind: 'redirect', action: 'cUsers.listusers', append: 'siteid,ispublic', path: './' };

/** `fw.redirect(action='cUsers.editgroup', append='siteid,userid', path='./')`. */
const EDITGROUP: Fw1Redirect = { kind: 'redirect', action: 'cUsers.editgroup', append: 'siteid,userid', path: './' };

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

const s2 = (rc: Fields): AdminRequest => adminS2Request({ circuit: 'cUsers', item: 'route', rc });

/** qa_editor with Users and Site Manager module access, which passes the cUsers gate without being its admin. */
const usersEditor = (rc: Fields): AdminRequest =>
  makeAdminRequest(
    {
      circuit: 'cUsers',
      item: 'route',
      rc,
      user: { roles: [Roles.systemUser, moduleRole(USERS_MODULE), moduleRole(SITE_MODULE)] },
    },
    'qaEditor',
  );

const contextFor = (req: AdminRequest, reply: FakeReply): ScreenContext & { gateway: FakeGatewayClient } =>
  makeScreenContext({ req, gateway: fakeGatewayClient({ [ROUTE]: reply }) });

/** The people call route() makes for `query`. */
const routeCall = (query: Fields) => [{ service: 'people', method: 'GET', path: PATH, query }];

/** The `Location` FW/1 builds for `result` from the `append` keys of the request's rc after the action ran. */
function locationOf(result: Fw1Redirect, req: AdminRequest): string {
  const append = (result.append ?? '').split(',').flatMap((name) => {
    const value = req.rc[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return fw1RedirectTarget({ action: result.action, append, path: result.path });
}

describe('cUsers.route definition', () => {
  it('is the people-owned redirect action behind the cUsers gate', () => {
    expect(routeAction).toMatchObject({ circuit: 'cusers', action: 'route', mode: 'redirect', owner: 'people' });
    expect(routeAction.gate).toBe(cusersGate);
    expect(routeAction.variant).toBeUndefined();
  });
});

describe('cUsers.route submit', () => {
  // The S2 Locations are the legacy oracle's answers to the same rc.
  it.each<{ shape: string; req: () => AdminRequest; query: Fields; rc: Fields; location: string }>([
    {
      shape: 'no routeid or returnurl',
      req: () => s2({}),
      query: { siteid: 'default', ispublic: '1', routeid: '', returnurl: '' },
      rc: { siteid: 'default', ispublic: '1' },
      location: './?muraAction=cUsers.listusers&siteid=default&ispublic=1',
    },
    {
      shape: 'an S2 ispublic=0',
      req: () => s2({ ispublic: '0' }),
      query: { siteid: 'default', ispublic: '0', routeid: '', returnurl: '' },
      rc: { siteid: 'default', ispublic: '0' },
      location: './?muraAction=cUsers.listusers&siteid=default&ispublic=0',
    },
    {
      shape: 'an S2 ispublic=no, kept as sent',
      req: () => s2({ ispublic: 'no' }),
      query: { siteid: 'default', ispublic: 'no', routeid: '', returnurl: '' },
      rc: { siteid: 'default', ispublic: 'no' },
      location: './?muraAction=cUsers.listusers&siteid=default&ispublic=no',
    },
    {
      shape: 'a non-boolean ispublic',
      req: () => s2({ ispublic: 'maybe' }),
      query: { siteid: 'default', ispublic: '1', routeid: '', returnurl: '' },
      rc: { siteid: 'default', ispublic: '1' },
      location: './?muraAction=cUsers.listusers&siteid=default&ispublic=1',
    },
    {
      shape: 'ispublic=0 from a non-admin',
      req: () => usersEditor({ ispublic: '0' }),
      query: { siteid: 'default', ispublic: '1', routeid: '', returnurl: '' },
      rc: { siteid: 'default', ispublic: '1' },
      location: './?muraAction=cUsers.listusers&siteid=default&ispublic=1',
    },
    {
      shape: 'names in another case',
      req: () => s2({ SiteID: 'default', IsPublic: '0', RouteID: '', ReturnURL: '' }),
      query: { siteid: 'default', ispublic: '0', routeid: '', returnurl: '' },
      rc: { siteid: 'default', ispublic: '0' },
      location: './?muraAction=cUsers.listusers&siteid=default&ispublic=0',
    },
    {
      shape: "the site admin's session site",
      req: () => siteAdminRequest('tenant-a', { circuit: 'cUsers', item: 'route', rc: { ispublic: '0' } }),
      query: { siteid: 'tenant-a', ispublic: '0', routeid: '', returnurl: '' },
      rc: { siteid: 'tenant-a', ispublic: '0' },
      location: './?muraAction=cUsers.listusers&siteid=tenant-a&ispublic=0',
    },
  ])('redirects $shape to cUsers.listusers', async ({ req: makeReq, query, rc, location }) => {
    const req = makeReq();
    const ctx = contextFor(req, ROUTED_LISTUSERS);

    const result = await routeAction.submit(ctx);

    expect(result).toEqual(LISTUSERS);
    expect(ctx.gateway.calls).toEqual(routeCall(query));
    expect({ siteid: ctx.req.rc.siteid, ispublic: ctx.req.rc.ispublic }).toEqual(rc);
    expect(ctx.req.rc.muraAction).toBe(req.rc.muraAction);
    expect(locationOf(LISTUSERS, ctx.req)).toBe(location);
  });

  it.each<{ shape: string; rc: Fields; query: Fields }>([
    {
      shape: 'a routeid',
      rc: { routeid: GROUP_ID },
      query: { siteid: 'default', ispublic: '1', routeid: GROUP_ID, returnurl: '' },
    },
    {
      shape: 'a routeid over a different userid',
      rc: { routeid: GROUP_ID, userid: 'ABC' },
      query: { siteid: 'default', ispublic: '1', routeid: GROUP_ID, returnurl: '' },
    },
    {
      shape: 'a routeid beside a returnurl',
      rc: { routeid: GROUP_ID, returnurl: '/admin/' },
      query: { siteid: 'default', ispublic: '1', routeid: GROUP_ID, returnurl: '/admin/' },
    },
  ])('redirects $shape to the cUsers.editgroup of the routeid', async ({ rc, query }) => {
    const ctx = contextFor(s2(rc), ROUTED_EDITGROUP);

    const result = await routeAction.submit(ctx);

    expect(result).toEqual(EDITGROUP);
    expect(ctx.gateway.calls).toEqual(routeCall(query));
    expect({ siteid: ctx.req.rc.siteid, userid: ctx.req.rc.userid }).toEqual({ siteid: 'default', userid: GROUP_ID });
    expect(locationOf(EDITGROUP, ctx.req)).toBe(`./?muraAction=cUsers.editgroup&siteid=default&userid=${GROUP_ID}`);
  });

  it.each<{ returnurl: string; url: string }>([
    { returnurl: '/admin/?muraAction=cUsers.list', url: '/admin/?muraAction=cUsers.list' },
    { returnurl: '//evil.example/x', url: '/evil.example/x' },
  ])('goes to the return URL people sanitised from $returnurl', async ({ returnurl, url }) => {
    const req = s2({ returnurl });
    const ctx = contextFor(req, routed({ url }));

    await expect(routeAction.submit(ctx)).resolves.toEqual({ kind: 'location', location: url });
    expect(ctx.gateway.calls).toEqual(routeCall({ siteid: 'default', ispublic: '1', routeid: '', returnurl }));
    expect(ctx.req).toBe(req);
  });

  it('rejects an admin redirect answered for a return URL', async () => {
    const req = s2({ returnurl: '/admin/' });
    const ctx = contextFor(req, ROUTED_LISTUSERS);

    await expect(routeAction.submit(ctx)).rejects.toThrow(
      new TypeError('routeUser answered cUsers.listusers for a return URL'),
    );
    expect(ctx.req).toBe(req);
  });

  it.each([401, 403] as const)('raises GatewayDenialError on %i without touching rc', async (status) => {
    const req = s2({ routeid: GROUP_ID });
    const ctx = contextFor(req, { status, body: { error: 'denied' } });

    const failure = routeAction.submit(ctx);
    await expect(failure).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(failure).rejects.toMatchObject({ service: 'people', operation: OPERATION, status });
    expect(ctx.req).toBe(req);
  });

  it('raises on a 500 from people', async () => {
    const ctx = contextFor(s2({}), { status: 500, body: { error: 'boom' } });

    await expect(routeAction.submit(ctx)).rejects.toThrow(`${OPERATION} answered HTTP 500`);
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    {
      outage: 'a 503 answer',
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(ROUTE, { status: 503, body: {} }),
    },
  ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
    const ctx = contextFor(s2({}), ROUTED_LISTUSERS);
    arrange(ctx.gateway);

    await expect(routeAction.submit(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('cusersRoute', () => {
  it('omits an empty siteid from the people call and appends it empty', async () => {
    const ctx = contextFor(s2({}), ROUTED_LISTUSERS);

    const result = await cusersRoute(ctx, { siteid: '', ispublic: '1', routeid: '', returnurl: '' });

    expect(result).toEqual(LISTUSERS);
    expect(ctx.gateway.calls).toEqual(routeCall({ ispublic: '1', routeid: '', returnurl: '' }));
    expect(locationOf(LISTUSERS, ctx.req)).toBe('./?muraAction=cUsers.listusers&siteid=&ispublic=1');
  });
});
