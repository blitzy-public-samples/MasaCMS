// Redirect-mode cUsers actions (cusers.cfc 174-176, 272-282, 290-398) over the identity and people fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { fw1RedirectTarget } from '@/lib/urls';
import { addToGroupAction } from '@/screens/cusers/addtogroup';
import { defaultAction } from '@/screens/cusers/default';
import { cusersGate, normaliseCusersRc } from '@/screens/cusers/gate';
import { removeFromGroupAction } from '@/screens/cusers/removefromgroup';
import { routeAction } from '@/screens/cusers/route';
import {
  EDIT_BEAN_SESSION_KEY,
  USER_BEAN_RC_KEY,
  addUserAction,
  updateGroupAction,
  updateUserAction,
  type UserUpdateResult,
} from '@/screens/cusers/update';
import { updateAddressAction } from '@/screens/cusers/updateaddress';
import type { RedirectScreen, SubmitResult } from '@/screens/registry';
import { CSRF_ADD_TO_GROUP, CSRF_EDIT_GROUP } from '../../fixtures/identity/csrf';
import { GROUP_IDS, defaultEditorGroup } from '../../fixtures/identity/groups';
import { ADDRESS_IDS } from '../../fixtures/people/address-edit';
import { NEW_USER_ID } from '../../fixtures/people/user-edit';
import { PERSON_IDS } from '../../fixtures/people/user-list';
import {
  duplicateUsernameResult,
  invalidEmailResult,
  missingEmailResult,
  passwordMismatchResult,
  routeToListUsersResult,
} from '../../fixtures/people/validation-errors';
import { USER_IDS } from '../../fixtures/session';
import { adminS2Request, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

type Fields = Readonly<Record<string, string>>;
type Fw1Redirect = Extract<SubmitResult, { kind: 'redirect' }>;

const SITE = 'tenant-a';
const GROUP_ID = GROUP_IDS.defaultEditor;
const NEW_GROUP_ID = '6A000000-0000-0000-0000000000000F01';
const MEMBER_ID = USER_IDS.qaEditor;

const ROUTE_PATH = '/v1/users/route';
const ROUTE_USER = routeKey('GET', 'people', ROUTE_PATH);
const GROUP_PATH: ServicePath = `/v1/groups/${GROUP_ID}`;
const USER_PATH = '/v1/users:update';
const ADDRESS_PATH = '/v1/users/addresses:update';
const MEMBERSHIP_PATH: ServicePath = `/v1/groups/${GROUP_ID}/members/${MEMBER_ID}`;

const RETURN_URL = './?muraAction=cUsers.listUsers&ispublic=0';

type CsrfPair = { readonly csrf_token: string; readonly csrf_token_expires: string };
const csrfOf = ({ csrf_token, csrf_token_expires }: CsrfPair): Fields => ({ csrf_token, csrf_token_expires });
const EDIT_GROUP_CSRF = csrfOf(CSRF_EDIT_GROUP);
const ADD_TO_GROUP_CSRF = csrfOf(CSRF_ADD_TO_GROUP);
/** The pair identity issues for a person's `userid` or `updateaddress<userid>` context. */
const ISSUED_CSRF: Fields = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };

const LISTUSERS: Fw1Redirect = { kind: 'redirect', action: 'cUsers.listusers', append: 'siteid,ispublic', path: './' };
const EDITGROUP: Fw1Redirect = { kind: 'redirect', action: 'cUsers.editgroup', append: 'siteid,userid', path: './' };
const EDIT_USER: Fw1Redirect = {
  kind: 'redirect',
  action: 'cUsers.edituser',
  preserve: 'siteid,userid,routeid',
  path: './',
};
const EDIT_PROFILE: Fw1Redirect = { kind: 'redirect', action: 'cEditProfile.edit', path: './' };
const MEMBERS: Fw1Redirect = { kind: 'redirect', action: 'cUsers.editGroupMembers', preserve: 'groupid,siteid' };

const routed = (redirect: Readonly<Record<string, unknown>>): FakeReply => ({ status: 200, body: { redirect } });
const ROUTED_LISTUSERS: FakeReply = { status: 200, body: routeToListUsersResult };
const ROUTED_EDITGROUP = routed({ action: 'cUsers.editgroup', params: { siteid: 'default', userid: GROUP_ID } });
const GROUP_SAVED: FakeReply = { status: 200, body: { written: true, group: defaultEditorGroup, errors: {} } };
const USER_SAVED: FakeReply = { status: 200, body: { written: true, errors: {} } };
const WRITTEN: FakeReply = { status: 200, body: { written: true } };

/** A session holding the edit bean an earlier failed save retained, which `route()` has people clear. */
const RETAINED_SESSION = {
  muraValues: {
    [EDIT_BEAN_SESSION_KEY]: { userBean: duplicateUsernameResult.userBean, errors: duplicateUsernameResult.errors },
  },
};

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** The tenant-a site admin's `cusers.<item>` with `rc` posted. */
const siteAdmin = (item: string, rc: Fields, session: AdminRequestPartial['session'] = {}): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cusers', item, rc, session });

/** The S2 admin's `cusers.<item>` on `default` with `rc` posted. */
const s2Admin = (item: string, rc: Fields): AdminRequest => adminS2Request({ circuit: 'cusers', item, rc });

const contextFor = (req: AdminRequest, routes: FakeRouteTable = {}) =>
  makeScreenContext({ req, gateway: fakeGatewayClient(routes) });

const callsTo = (gateway: FakeGatewayClient, path: string) => gateway.calls.filter((call) => call.path === path);

/** The people `routeUser` call `route()` makes for `query`. */
const routeCall = (query: Fields) => ({ service: 'people', method: 'GET', path: ROUTE_PATH, query });

/** The `Location` FW/1 builds for `result` from the `append` keys of `req.rc` after the action ran. */
function locationOf(result: SubmitResult, req: AdminRequest): string {
  if (result.kind !== 'redirect') throw new TypeError(`Not an FW/1 redirect: ${result.kind}`);
  const append = (result.append ?? '').split(',').flatMap((name) => {
    const value = req.rc[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return fw1RedirectTarget({ action: result.action, append, queryString: result.queryString, path: result.path });
}

describe('cUsers redirect-mode definitions', () => {
  it.each<{ screen: RedirectScreen; action: string; owner: string }>([
    { screen: defaultAction, action: 'default', owner: 'people' },
    { screen: routeAction, action: 'route', owner: 'people' },
    { screen: updateGroupAction, action: 'update', owner: 'identity' },
    { screen: addUserAction, action: 'update', owner: 'people' },
    { screen: updateUserAction, action: 'update', owner: 'people' },
    { screen: updateAddressAction, action: 'updateaddress', owner: 'people' },
    { screen: addToGroupAction, action: 'addtogroup', owner: 'identity' },
    { screen: removeFromGroupAction, action: 'removefromgroup', owner: 'identity' },
  ])('cusers.$action of $owner is a redirect action behind the cUsers gate', ({ screen, action, owner }) => {
    expect(screen).toMatchObject({ circuit: 'cusers', action, mode: 'redirect', owner });
    expect(screen.gate).toBe(cusersGate);
  });
});

describe('cUsers.default', () => {
  it.each<{ shape: string; req: () => AdminRequest; siteid: string }>([
    { shape: "the request's site", req: () => siteAdmin('default', {}), siteid: SITE },
    { shape: 'the session site for an empty siteid', req: () => siteAdmin('default', { siteid: '' }), siteid: SITE },
    {
      shape: 'default without a request or session site',
      req: () => adminS2Request({ circuit: 'cusers', item: 'default', rc: { siteid: '' }, session: { siteid: '' } }),
      siteid: 'default',
    },
  ])('redirects to cUsers.list of $shape without a service call', async ({ req, siteid }) => {
    const ctx = contextFor(req());

    const result = await defaultAction.submit(ctx);

    expect(result).toEqual({ kind: 'redirect', action: 'cUsers.list', path: './', queryString: `siteid=${siteid}` });
    expect(locationOf(result, ctx.req)).toBe(`./?muraAction=cUsers.list&siteid=${siteid}`);
    expect(ctx.gateway.calls).toEqual([]);
  });
});

describe('cUsers.route', () => {
  const routedEditGroup = routed({ action: 'cUsers.editgroup', params: { siteid: SITE, userid: GROUP_ID } });

  it.each<{ returnurl: string; location: string }>([
    { returnurl: RETURN_URL, location: RETURN_URL },
    { returnurl: '//evil.example/x', location: '/evil.example/x' },
  ])('goes to the return URL people sanitised from $returnurl', async ({ returnurl, location }) => {
    const req = siteAdmin('route', { returnurl }, RETAINED_SESSION);
    const ctx = contextFor(req, { [ROUTE_USER]: routed({ url: location }) });

    await expect(routeAction.submit(ctx)).resolves.toEqual({ kind: 'location', location });
    expect(ctx.gateway.calls).toEqual([routeCall({ siteid: SITE, ispublic: '1', routeid: '', returnurl })]);
    expect(ctx.req).toBe(req);
    expect(ctx.req.sessionWrites.muraValues).toBeUndefined();
  });

  it('redirects to cUsers.listusers without a routeid or returnurl', async () => {
    const ctx = contextFor(siteAdmin('route', { ispublic: '0' }, RETAINED_SESSION), { [ROUTE_USER]: ROUTED_LISTUSERS });

    const result = await routeAction.submit(ctx);

    expect(result).toEqual(LISTUSERS);
    expect(ctx.gateway.calls).toEqual([routeCall({ siteid: SITE, ispublic: '0', routeid: '', returnurl: '' })]);
    expect(locationOf(result, ctx.req)).toBe(`./?muraAction=cUsers.listusers&siteid=${SITE}&ispublic=0`);
    expect(ctx.req.sessionWrites.muraValues).toBeUndefined();
  });

  it('redirects to the cUsers.editgroup of the routeid', async () => {
    const ctx = contextFor(siteAdmin('route', { routeid: GROUP_ID, returnurl: RETURN_URL }, RETAINED_SESSION), {
      [ROUTE_USER]: routedEditGroup,
    });

    const result = await routeAction.submit(ctx);

    expect(result).toEqual(EDITGROUP);
    expect(ctx.req.rc.userid).toBe(GROUP_ID);
    expect(ctx.gateway.calls).toEqual([
      routeCall({ siteid: SITE, ispublic: '1', routeid: GROUP_ID, returnurl: RETURN_URL }),
    ]);
    expect(locationOf(result, ctx.req)).toBe(`./?muraAction=cUsers.editgroup&siteid=${SITE}&userid=${GROUP_ID}`);
    expect(ctx.req.sessionWrites.muraValues).toBeUndefined();
  });
});

/** One carried group write: the posted `action`, the form's `userid` and its CSRF pair, and identity's route. */
interface GroupWrite {
  readonly action: string;
  readonly userid: string;
  readonly csrf: Fields;
  readonly method: 'POST' | 'PUT';
  readonly path: ServicePath;
}

const GROUP_WRITES: readonly GroupWrite[] = [
  { action: 'Update', userid: GROUP_ID, csrf: EDIT_GROUP_CSRF, method: 'PUT', path: GROUP_PATH },
  { action: 'Add', userid: NEW_GROUP_ID, csrf: ISSUED_CSRF, method: 'POST', path: '/v1/groups' },
];

/** The Edit Group form of the S2 admin on `default`, with its action URL's `userid` and the CSRF pair. */
const groupPost = ({ action, userid, csrf }: Pick<GroupWrite, 'action' | 'userid' | 'csrf'>): Fields => ({
  action,
  type: '1',
  userid,
  groupname: 'Editor',
  email: 'editors@example.com',
  isPublic: '0',
  siteid: 'default',
  returnurl: RETURN_URL,
  ...csrf,
});

describe('cUsers.update{type=1}', () => {
  it.each(GROUP_WRITES)('relays a group $action to identity, then goes to the returnurl', async (write) => {
    const posted = groupPost(write);
    const ctx = contextFor(s2Admin('update', posted), {
      [routeKey(write.method, 'identity', write.path)]: GROUP_SAVED,
      [ROUTE_USER]: routed({ url: RETURN_URL }),
    });

    await expect(updateGroupAction.submit(ctx)).resolves.toEqual({ kind: 'location', location: RETURN_URL });
    expect(ctx.gateway.calls.map(({ service, method, path }) => [service, method, path])).toEqual([
      ['identity', write.method, write.path],
      ['people', 'GET', ROUTE_PATH],
    ]);
    expect(ctx.gateway.calls[0]?.form).toMatchObject(posted);
    expect(ctx.gateway.calls[1]).toEqual(
      routeCall({ siteid: 'default', ispublic: '0', routeid: '', returnurl: RETURN_URL }),
    );
  });

  it.each(GROUP_WRITES)('re-opens the group form with identity errors after a failed $action', async (write) => {
    const errors = { groupname: "The 'Group Name' field is required." };
    const failed = { written: false, group: defaultEditorGroup, errors };
    const ctx = contextFor(s2Admin('update', groupPost(write)), {
      [routeKey(write.method, 'identity', write.path)]: { status: 200, body: failed },
    });

    await expect(updateGroupAction.submit(ctx)).resolves.toEqual({
      kind: 'redirect',
      action: 'cUsers.editgroup',
      preserve: 'all',
      path: './',
      rc: { siteid: 'default', [USER_BEAN_RC_KEY]: JSON.stringify(failed) },
    });
    expect(callsTo(ctx.gateway, ROUTE_PATH)).toEqual([]);
    expect(ctx.req.sessionWrites.muraValues).toBeUndefined();
  });

  // The registry keeps `type=1,action=delete` on legacy (its closure reaches strategies-content's files) and identity
  // has no group delete, so the carried variant refuses it rather than routing as legacy's line 343 does.
  it('refuses a group Delete without calling identity', async () => {
    const ctx = contextFor(s2Admin('update', groupPost({ action: 'Delete', userid: GROUP_ID, csrf: EDIT_GROUP_CSRF })));

    await expect(updateGroupAction.submit(ctx)).rejects.toThrow("no group write for action 'Delete'");
    expect(ctx.gateway.calls).toEqual([]);
  });
});

/** One carried person write: its variant, the posted `action` and the form's `userid`. */
interface UserWrite {
  readonly screen: RedirectScreen;
  readonly action: string;
  readonly userid: string;
}

const USER_WRITES: readonly UserWrite[] = [
  { screen: addUserAction, action: 'Add', userid: NEW_USER_ID },
  { screen: updateUserAction, action: 'Update', userid: PERSON_IDS.janeSmith },
];

const UPDATE_USER = routeKey('POST', 'people', USER_PATH);

/** The Edit User form of a tenant-a System User, with its action URL's `userid` and `routeid` and the CSRF pair. */
const userPost = ({ action, userid }: Pick<UserWrite, 'action' | 'userid'>): Fields => ({
  action,
  type: '2',
  userid,
  routeid: '',
  fname: 'Jordan',
  lname: 'Smith',
  email: 'jordan_smith@example.com',
  usernameNoCache: 'jordan_smith',
  passwordNoCache: 'Secret-123',
  password2: 'Secret-123',
  isPublic: '0',
  siteid: SITE,
  ...ISSUED_CSRF,
});

const FAILURES: ReadonlyArray<readonly [string, UserUpdateResult]> = [
  ['a duplicate username', duplicateUsernameResult],
  ['a missing email', missingEmailResult],
  ['mismatched passwords', passwordMismatchResult],
  ['an invalid email', invalidEmailResult],
];

describe('cUsers.update{type=2}', () => {
  it.each(USER_WRITES)('relays a person $action to people, then routes to cUsers.listusers', async (write) => {
    const posted = userPost(write);
    const ctx = contextFor(siteAdmin('update', posted), { [UPDATE_USER]: USER_SAVED, [ROUTE_USER]: ROUTED_LISTUSERS });

    const result = await write.screen.submit(ctx);

    expect(result).toEqual(LISTUSERS);
    expect(ctx.gateway.calls.map(({ path }) => path)).toEqual([USER_PATH, ROUTE_PATH]);
    expect(ctx.gateway.calls[0]).toMatchObject({ service: 'people', method: 'POST', form: posted });
    expect(ctx.gateway.calls[1]).toEqual(routeCall({ siteid: SITE, ispublic: '0', routeid: '', returnurl: '' }));
    expect(locationOf(result, ctx.req)).toBe(`./?muraAction=cUsers.listusers&siteid=${SITE}&ispublic=0`);
  });

  describe.each(USER_WRITES)('a failed person $action', (write) => {
    it.each(FAILURES)('re-opens cUsers.edituser with the retained bean for %s', async (_failure, failed) => {
      const ctx = contextFor(siteAdmin('update', userPost(write)), { [UPDATE_USER]: { status: 200, body: failed } });

      await expect(write.screen.submit(ctx)).resolves.toEqual({
        kind: 'redirect',
        action: 'cUsers.edituser',
        preserve: 'all',
        path: './',
        rc: { siteid: SITE, [USER_BEAN_RC_KEY]: JSON.stringify(failed) },
      });
      const retained = { userBean: failed.userBean, errors: failed.errors };
      expect(ctx.req.sessionWrites.muraValues).toEqual({ [EDIT_BEAN_SESSION_KEY]: retained });
      expect((ctx.req.session.mura as Readonly<Record<string, unknown>>)[EDIT_BEAN_SESSION_KEY]).toEqual(retained);
      expect(callsTo(ctx.gateway, ROUTE_PATH)).toEqual([]);
    });
  });

  // people's restrictAdminInput drops a posted `s2` unless the token is S2 (cusers.cfc 97-99, 295-296), so web relays
  // the post as received; the S2 flag comes from the verified token, never from rc.
  it.each<{ who: string; requestFor: (rc: Fields) => AdminRequest; kept: string | undefined }>([
    { who: 'a site admin', requestFor: (rc) => siteAdmin('update', rc), kept: undefined },
    { who: 'the S2 admin', requestFor: (rc) => s2Admin('update', rc), kept: '1' },
  ])('leaves an s2 posted by $who to the token, relaying it for people', async ({ requestFor, kept }) => {
    const req = requestFor({ ...userPost({ action: 'Update', userid: PERSON_IDS.janeSmith }), s2: '1' });
    const ctx = contextFor(req, { [UPDATE_USER]: USER_SAVED, [ROUTE_USER]: ROUTED_LISTUSERS });

    await expect(updateUserAction.submit(ctx)).resolves.toEqual(LISTUSERS);
    expect(req.isS2).toBe(kept !== undefined);
    expect(normaliseCusersRc(req).s2).toBe(kept);
    expect(callsTo(ctx.gateway, USER_PATH)[0]?.form).toMatchObject({ s2: '1' });
  });

  it('rejects with GatewayUnavailableError, the legacy 503, when people is unavailable', async () => {
    const ctx = contextFor(siteAdmin('update', userPost({ action: 'Update', userid: PERSON_IDS.janeSmith })), {
      [ROUTE_USER]: ROUTED_LISTUSERS,
    });
    ctx.gateway.failWith();

    const failure = updateUserAction.submit(ctx);

    await expect(failure).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(failure).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(failure).rejects.toMatchObject({ service: 'people' });
    expect(ctx.gateway.calls.map(({ path }) => path)).toEqual([USER_PATH]);
  });
});

/** The Edit Address form of Jane Smith in tenant-a, with its action URL fields and the CSRF pair. */
const addressPost = (action: string, routeid: string): Fields => ({
  action,
  userid: PERSON_IDS.janeSmith,
  routeid,
  siteid: SITE,
  addressID: action === 'Add' ? '' : ADDRESS_IDS.janeSmithHome,
  addressName: 'Home',
  address1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'US',
  isPrimary: '1',
  ...ISSUED_CSRF,
});

const ADDRESS_WRITTEN: FakeReply = {
  status: 200,
  body: {
    redirect: { action: 'cUsers.edituser', params: { siteid: SITE, userid: PERSON_IDS.janeSmith } },
    written: true,
  },
};

describe('cUsers.updateAddress', () => {
  // `action=Delete` stays on legacy (the registry's not-built list), so only Update and Add are submitted.
  it.each<{ action: string; routeid: string; result: Fw1Redirect }>([
    { action: 'Update', routeid: '', result: EDIT_USER },
    { action: 'Add', routeid: GROUP_ID, result: EDIT_USER },
    { action: 'Update', routeid: 'editprofile', result: EDIT_PROFILE },
  ])('relays an address $action to people, then redirects for routeid "$routeid"', async (write) => {
    const posted = addressPost(write.action, write.routeid);
    const ctx = contextFor(siteAdmin('updateAddress', posted), {
      [routeKey('POST', 'people', ADDRESS_PATH)]: ADDRESS_WRITTEN,
    });

    await expect(updateAddressAction.submit(ctx)).resolves.toEqual(write.result);
    expect(ctx.gateway.calls).toHaveLength(1);
    expect(ctx.gateway.calls[0]).toMatchObject({ service: 'people', method: 'POST', path: ADDRESS_PATH, form: posted });
  });
});

describe('cUsers.addToGroup', () => {
  const posted: Fields = { userid: MEMBER_ID, groupid: GROUP_ID, siteid: 'default', ...ADD_TO_GROUP_CSRF };

  it.each<{ routeid: string; reply: FakeReply; result: Fw1Redirect; location: string }>([
    {
      routeid: '',
      reply: routed({ action: 'cUsers.listusers', params: { siteid: 'default', ispublic: '1' } }),
      result: LISTUSERS,
      location: './?muraAction=cUsers.listusers&siteid=default&ispublic=1',
    },
    {
      routeid: GROUP_ID,
      reply: ROUTED_EDITGROUP,
      result: EDITGROUP,
      location: `./?muraAction=cUsers.editgroup&siteid=default&userid=${GROUP_ID}`,
    },
  ])('adds the membership through identity, then routes for routeid "$routeid"', async (shape) => {
    const { routeid, reply, result, location } = shape;
    const ctx = contextFor(s2Admin('addToGroup', { ...posted, routeid }), {
      [routeKey('POST', 'identity', MEMBERSHIP_PATH)]: WRITTEN,
      [ROUTE_USER]: reply,
    });

    const answer = await addToGroupAction.submit(ctx);

    expect(answer).toEqual(result);
    expect(ctx.gateway.calls).toEqual([
      { service: 'identity', method: 'POST', path: MEMBERSHIP_PATH, form: { siteid: 'default', ...ADD_TO_GROUP_CSRF } },
      routeCall({ siteid: 'default', ispublic: '1', routeid, returnurl: '' }),
    ]);
    expect(locationOf(answer, ctx.req)).toBe(location);
  });
});

describe('cUsers.removeFromGroup', () => {
  it('removes the membership through identity without a CSRF pair, then returns to the members', async () => {
    const rc: Fields = { userid: MEMBER_ID, groupid: GROUP_ID, routeid: GROUP_ID, siteid: 'default' };
    const ctx = contextFor(s2Admin('removeFromGroup', rc), {
      [routeKey('DELETE', 'identity', MEMBERSHIP_PATH)]: WRITTEN,
    });

    await expect(removeFromGroupAction.submit(ctx)).resolves.toEqual(MEMBERS);
    expect(ctx.req.rc.csrf_token).toBeUndefined();
    expect(ctx.gateway.calls).toEqual([{ service: 'identity', method: 'DELETE', path: MEMBERSHIP_PATH }]);
  });
});
