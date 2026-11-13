// cUsers.update (cusers.cfc 290-353) for its carried variants against identity's group and people's person contracts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { receiveRequestBody, type ReceivedBody, type RequestBody } from '@/lib/request-body';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { cusersGate } from '@/screens/cusers/gate';
import {
  EDIT_BEAN_SESSION_KEY,
  USER_BEAN_RC_KEY,
  addUserAction,
  updateActions,
  updateGroupAction,
  updateUserAction,
} from '@/screens/cusers/update';
import type { RedirectScreen, ScreenContext, SubmitResult } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const GROUP_ID = '6B000000-0000-0000-0000000000000010';
const USER_ID = '6B000000-0000-0000-0000000000000020';
const CSRF: Fields = { csrf_token: 'C'.repeat(32), csrf_token_expires: '260630150000000' };

const CREATE_GROUP = routeKey('POST', 'identity', '/v1/groups');
const UPDATE_GROUP = routeKey('PUT', 'identity', `/v1/groups/${GROUP_ID}`);
const UPDATE_USER = routeKey('POST', 'people', '/v1/users:update');
const ROUTE_USER = routeKey('GET', 'people', '/v1/users/route');

/** Edit Group form fields as editgroup.cfm posts them. */
const GROUP_FIELDS: Fields = { groupname: 'Editors', email: 'editors@example.test', isPublic: '0', type: '1', siteid: 'default' };

/** Edit User form fields as edituser.cfm posts them. */
const USER_FIELDS: Fields = {
  fname: 'Ada',
  lname: 'Lovelace',
  email: 'ada@example.test',
  usernameNoCache: 'ada',
  passwordNoCache: 'Secret-123',
  password2: 'Secret-123',
  type: '2',
  siteid: 'default',
  isPublic: '0',
};

const GROUP = { UserID: GROUP_ID, SiteID: 'default', Type: 1, GroupName: 'Editors', isPublic: 0 };
const PERSON = { UserID: USER_ID, SiteID: 'default', Type: 2, Fname: 'Ada', Lname: 'Lovelace' };

/** Validation errors in the owner's order, which is not alphabetical. */
const ERRORS = { username: 'The Username is already in use.', email: 'Please enter a valid email.' };

const GROUP_SAVED: FakeReply = { status: 200, body: { written: true, group: GROUP, errors: {} } };
const USER_SAVED: FakeReply = { status: 200, body: { written: true, errors: {} } };

const routed = (redirect: Readonly<Record<string, unknown>>): FakeReply => ({ status: 200, body: { redirect } });
const ROUTED_LISTUSERS = routed({ action: 'cUsers.listusers', params: { siteid: 'default', ispublic: '1' } });

/** `route()` without routeid or returnurl. */
const LISTUSERS: SubmitResult = { kind: 'redirect', action: 'cUsers.listusers', append: 'siteid,ispublic', path: './' };

/** The owner write a variant relays, as `[route key, method, service path]`. */
interface Write {
  readonly name: string;
  readonly screen: RedirectScreen;
  readonly route: string;
  readonly service: 'identity' | 'people';
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly fields: Fields;
  readonly saved: FakeReply;
  /** The query of the form's action URL. */
  readonly actionUrl: Fields;
}

const WRITES: readonly Write[] = [
  {
    name: 'a group Add',
    screen: updateGroupAction,
    route: CREATE_GROUP,
    service: 'identity',
    method: 'POST',
    path: '/v1/groups',
    fields: { ...GROUP_FIELDS, action: 'Add' },
    saved: GROUP_SAVED,
    actionUrl: { userid: GROUP_ID },
  },
  {
    name: 'a group Update',
    screen: updateGroupAction,
    route: UPDATE_GROUP,
    service: 'identity',
    method: 'PUT',
    path: `/v1/groups/${GROUP_ID}`,
    fields: { ...GROUP_FIELDS, action: 'Update' },
    saved: GROUP_SAVED,
    actionUrl: { userid: GROUP_ID },
  },
  {
    name: 'a user Add',
    screen: addUserAction,
    route: UPDATE_USER,
    service: 'people',
    method: 'POST',
    path: '/v1/users:update',
    fields: { ...USER_FIELDS, action: 'Add' },
    saved: USER_SAVED,
    actionUrl: { userid: USER_ID, routeid: '' },
  },
  {
    name: 'a user Update',
    screen: updateUserAction,
    route: UPDATE_USER,
    service: 'people',
    method: 'POST',
    path: '/v1/users:update',
    fields: { ...USER_FIELDS, action: 'Update' },
    saved: USER_SAVED,
    actionUrl: { userid: USER_ID, routeid: '' },
  },
];

const received: ReceivedBody[] = [];
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(async () => {
  await Promise.all(received.splice(0).map((body) => body.dispose?.()));
  restoreEnv();
});

/** The S2 admin's `cusers.update` request whose rc merges `url` and `form`. */
const updateRequest = (url: Fields, form: Fields = {}): AdminRequest =>
  adminS2Request({ circuit: 'cusers', item: 'update', rc: { ...url, ...form } });

// Built by hand: the registry's shell hooks import every circuit, and submit reads only req, gateway and body.
/** The handlers' ScreenContext for `req` over `gateway`, with `body` when the request carried one. */
function contextFor(req: AdminRequest, gateway: FakeGatewayClient, body?: RequestBody): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
    body,
  };
}

/** `fields` as the browser posts a multipart edit form, received by web, with the sent bytes. */
async function multipart(fields: Fields): Promise<{ body: ReceivedBody; bytes: Buffer; contentType: string }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const request = new Request('http://web.test/admin-actions/cusers/update', { method: 'POST', body: form });
  const bytes = Buffer.from(await request.clone().arrayBuffer());
  const contentType = request.headers.get('content-type') ?? '';
  const body = await receiveRequestBody(request);
  received.push(body);
  return { body, bytes, contentType };
}

/** The calls a submit made to the owners' write routes. */
const ownerCalls = (gateway: FakeGatewayClient) => gateway.calls.filter((call) => call.path !== '/v1/users/route');

describe('cUsers.update definitions', () => {
  it.each<{ screen: RedirectScreen; key: string; owner: string }>([
    { screen: updateGroupAction, key: 'admin:cusers.update{type=1}', owner: 'identity' },
    { screen: addUserAction, key: 'admin:cusers.update{type=2,action=add}', owner: 'people' },
    { screen: updateUserAction, key: 'admin:cusers.update{type=2,action=update}', owner: 'people' },
  ])('$key is a redirect action of $owner behind the cUsers gate', ({ screen, key, owner }) => {
    expect(screen).toMatchObject({ circuit: 'cusers', action: 'update', mode: 'redirect', owner });
    expect(`admin:${screen.circuit}.${screen.action}{${screen.variant?.key ?? ''}}`).toBe(key);
    expect(screen.gate).toBe(cusersGate);
  });

  it('carries exactly the three inventoried variants', () => {
    expect(updateActions).toEqual([updateGroupAction, addUserAction, updateUserAction]);
  });

  it.each<{ rc: Fields; matched: readonly RedirectScreen[] }>([
    { rc: { type: '1' }, matched: [updateGroupAction] },
    { rc: { type: '1', action: 'Update' }, matched: [updateGroupAction] },
    { rc: { Type: '1.0', action: 'Add' }, matched: [updateGroupAction] },
    { rc: { type: '2', action: 'Add' }, matched: [addUserAction] },
    { rc: { TYPE: '2', ACTION: 'update' }, matched: [updateUserAction] },
    { rc: { type: '2', action: 'ADD', newFile: '' }, matched: [addUserAction] },
    { rc: { type: '2', action: 'Delete' }, matched: [] },
    { rc: { type: '2' }, matched: [] },
    { rc: { type: '0', action: 'Add' }, matched: [] },
    { rc: { action: 'Update' }, matched: [] },
  ])('selects $matched.length variant(s) for $rc', ({ rc, matched }) => {
    expect(updateActions.filter((screen) => screen.variant?.matches(rc))).toEqual(matched);
  });

  it('reads a request context case-insensitively', () => {
    const req = updateRequest({ TYPE: '2' }, { Action: 'update' });

    expect(updateActions.filter((screen) => screen.variant?.matches(req.rc))).toEqual([updateUserAction]);
  });
});

describe('cUsers.update relay', () => {
  it.each(WRITES)('relays $name as multipart bytes unchanged with the action URL fields', async (write) => {
    const fields = { ...write.fields, ...CSRF };
    const upload = await multipart(fields);
    let relayed: { bytes: Buffer; contentType?: string } | undefined;
    const gateway = fakeGatewayClient({
      [write.route]: (request) => {
        relayed = { bytes: request.bytes, contentType: request.headers['content-type'] };
        return write.saved;
      },
      [ROUTE_USER]: ROUTED_LISTUSERS,
    });
    const ctx = contextFor(updateRequest(write.actionUrl, fields), gateway, upload.body.body);

    await expect(write.screen.submit(ctx)).resolves.toEqual(LISTUSERS);
    expect(ownerCalls(gateway)).toEqual([
      {
        service: write.service,
        method: write.method,
        path: write.path,
        query: write.actionUrl,
        headers: { 'content-type': upload.contentType, 'content-length': String(upload.bytes.length) },
      },
    ]);
    expect(relayed?.contentType).toBe(upload.contentType);
    expect(relayed?.bytes.equals(upload.bytes)).toBe(true);
    expect(relayed?.bytes.toString('utf8')).toContain(CSRF.csrf_token);
  });

  it.each(WRITES)('posts every rc field URL-encoded for $name without a multipart body', async (write) => {
    const gateway = fakeGatewayClient({ [write.route]: write.saved, [ROUTE_USER]: ROUTED_LISTUSERS });
    const req = updateRequest(write.actionUrl, { ...write.fields, ...CSRF });

    await expect(write.screen.submit(contextFor(req, gateway))).resolves.toEqual(LISTUSERS);
    expect(ownerCalls(gateway)).toEqual([
      { service: write.service, method: write.method, path: write.path, form: Object.fromEntries(Object.entries(req.rc)) },
    ]);
    expect(ownerCalls(gateway)[0]?.form).toMatchObject({ ...write.actionUrl, ...write.fields, ...CSRF });
  });

  it.each(['Delete', 'invalid', ''])('writes nothing and fails for a group action %j', async (action) => {
    const gateway = fakeGatewayClient();
    const req = updateRequest({ userid: GROUP_ID }, { ...GROUP_FIELDS, action, ...CSRF });

    await expect(updateGroupAction.submit(contextFor(req, gateway))).rejects.toThrow(/no group write/);
    expect(gateway.calls).toEqual([]);
  });

  it('fails without a group action', async () => {
    const gateway = fakeGatewayClient();
    const req = updateRequest({ userid: GROUP_ID }, { ...GROUP_FIELDS, ...CSRF });

    await expect(updateGroupAction.submit(contextFor(req, gateway))).rejects.toThrow(/no group write for action ''/);
    expect(gateway.calls).toEqual([]);
  });
});

describe('cUsers.update outcome', () => {
  it.each<{ shape: string; url: Fields; route: FakeReply; query: Fields; result: SubmitResult }>([
    {
      shape: 'neither routeid nor returnurl',
      url: {},
      route: ROUTED_LISTUSERS,
      query: { siteid: 'default', ispublic: '0', routeid: '', returnurl: '' },
      result: LISTUSERS,
    },
    {
      shape: 'a returnurl',
      url: { returnurl: '/admin/?muraAction=cUsers.list' },
      route: routed({ url: '/admin/?muraAction=cUsers.list' }),
      query: { siteid: 'default', ispublic: '0', routeid: '', returnurl: '/admin/?muraAction=cUsers.list' },
      result: { kind: 'location', location: '/admin/?muraAction=cUsers.list' },
    },
    {
      shape: 'a routeid',
      url: { routeid: GROUP_ID },
      route: routed({ action: 'cUsers.editgroup', params: { siteid: 'default', userid: GROUP_ID } }),
      query: { siteid: 'default', ispublic: '0', routeid: GROUP_ID, returnurl: '' },
      result: { kind: 'redirect', action: 'cUsers.editgroup', append: 'siteid,userid', path: './' },
    },
  ])('routes a saved write with $shape', async ({ url, route, query, result }) => {
    for (const write of WRITES) {
      const gateway = fakeGatewayClient({ [write.route]: write.saved, [ROUTE_USER]: route });
      const req = updateRequest({ ...write.actionUrl, ...url }, { ...write.fields, ...CSRF });

      await expect(write.screen.submit(contextFor(req, gateway))).resolves.toEqual(result);
      expect(gateway.calls.filter((call) => call.path === '/v1/users/route')).toEqual([
        { service: 'people', method: 'GET', path: '/v1/users/route', query },
      ]);
    }
  });

  it('routes with the siteid before() resolves when none was posted', async () => {
    const gateway = fakeGatewayClient({ [UPDATE_USER]: USER_SAVED, [ROUTE_USER]: ROUTED_LISTUSERS });
    const req = updateRequest({ userid: USER_ID }, { ...USER_FIELDS, siteid: '', action: 'Add', ...CSRF });

    await expect(addUserAction.submit(contextFor(req, gateway))).resolves.toEqual(LISTUSERS);
    expect(gateway.calls.at(-1)?.query).toMatchObject({ siteid: 'default' });
  });

  it.each(['Add', 'Update'])('re-opens the group form after a failed %s, preserving identity result', async (action) => {
    const failed = { written: false, group: GROUP, errors: ERRORS };
    const write = action === 'Add' ? CREATE_GROUP : UPDATE_GROUP;
    const gateway = fakeGatewayClient({ [write]: { status: 200, body: failed } });
    const req = updateRequest({ userid: GROUP_ID }, { ...GROUP_FIELDS, siteid: '', action, ...CSRF });

    const result = await updateGroupAction.submit(contextFor(req, gateway));

    expect(result).toEqual({
      kind: 'redirect',
      action: 'cUsers.editgroup',
      preserve: 'all',
      path: './',
      rc: { siteid: 'default', [USER_BEAN_RC_KEY]: JSON.stringify(failed) },
    });
    const preserved = JSON.parse((result as { rc: Fields }).rc[USER_BEAN_RC_KEY] ?? '') as typeof failed;
    expect(Object.keys(preserved.errors)).toEqual(['username', 'email']);
    expect(gateway.calls.map((call) => call.path)).not.toContain('/v1/users/route');
    expect(req.sessionWrites.muraValues).toBeUndefined();
  });

  it.each([addUserAction, updateUserAction])('re-opens the user form and retains the bean for $variant.key', async (screen) => {
    const failed = { written: false, errors: ERRORS, userBean: PERSON };
    const gateway = fakeGatewayClient({ [UPDATE_USER]: { status: 200, body: failed } });
    const action = screen === addUserAction ? 'Add' : 'Update';
    const req = updateRequest({ userid: USER_ID, routeid: '' }, { ...USER_FIELDS, action, ...CSRF });
    const ctx = contextFor(req, gateway);

    await expect(screen.submit(ctx)).resolves.toEqual({
      kind: 'redirect',
      action: 'cUsers.edituser',
      preserve: 'all',
      path: './',
      rc: { siteid: 'default', [USER_BEAN_RC_KEY]: JSON.stringify(failed) },
    });
    const retained = { userBean: PERSON, errors: ERRORS };
    expect(ctx.req.sessionWrites.muraValues).toEqual({ [EDIT_BEAN_SESSION_KEY]: retained });
    expect((ctx.req.session.mura as Readonly<Record<string, unknown>>)[EDIT_BEAN_SESSION_KEY]).toEqual(retained);
    expect(gateway.calls.map((call) => call.path)).toEqual(['/v1/users:update']);
  });

  it.each<{ answer: string; reply?: FakeReply; error: new (...args: never[]) => Error }>([
    { answer: 'no answer', error: GatewayUnavailableError },
    { answer: 'HTTP 503', reply: { status: 503 }, error: GatewayUnavailableError },
    { answer: 'HTTP 403', reply: { status: 403 }, error: GatewayDenialError },
    { answer: 'HTTP 500 for a rejected token', reply: { status: 500, body: {} }, error: Error },
  ])('propagates $answer from the owner without routing', async ({ reply, error }) => {
    for (const write of WRITES) {
      const gateway = fakeGatewayClient(reply === undefined ? {} : { [write.route]: reply });
      if (reply === undefined) gateway.failWith();
      const req = updateRequest(write.actionUrl, { ...write.fields, ...CSRF });

      await expect(write.screen.submit(contextFor(req, gateway))).rejects.toBeInstanceOf(error);
      expect(gateway.calls.map((call) => call.path)).toEqual([write.path]);
    }
  });

  it('propagates people unavailability while routing a saved write', async () => {
    const gateway = fakeGatewayClient({ [CREATE_GROUP]: GROUP_SAVED, [ROUTE_USER]: { status: 503 } });
    const req = updateRequest({ userid: GROUP_ID }, { ...GROUP_FIELDS, action: 'Add', ...CSRF });

    await expect(updateGroupAction.submit(contextFor(req, gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});
