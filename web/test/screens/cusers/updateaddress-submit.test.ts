// cUsers.updateAddress against cusers.cfc updateAddress() (355-375) and the people updateAddress contract.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { receiveRequestBody, type ReceivedBody, type RequestBody } from '@/lib/request-body';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { cusersGate } from '@/screens/cusers/gate';
import { updateAddressAction } from '@/screens/cusers/updateaddress';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const UPDATE_PATH = '/v1/users/addresses:update';
const UPDATE_ROUTE = routeKey('POST', 'people', UPDATE_PATH);
const USER_ID = '5A000000-0000-0000-0000000000000010';
const ADDRESS_ID = '5A000000-0000-0000-0000000000000020';
const CSRF: Fields = { csrf_token: 'B'.repeat(32), csrf_token_expires: '260630150000000' };

/** The query of the Edit Address form's action URL. */
const ACTION_URL: Fields = { userid: USER_ID, routeid: '', siteid: 'default' };

/** Edit Address form fields as editaddress.cfm posts them. */
const ADDRESS_FIELDS: Fields = {
  addressName: 'Head Office',
  address1: '1 Main St',
  address2: '',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'US',
  phone: '555-0100',
  fax: '',
  addressURL: 'https://example.test/',
  addressEmail: 'office@example.test',
  hours: 'Mon-Fri 9-5',
  isPublic: '0',
};

/** people's `RouteResult` redirect, which legacy's controller issues whatever the write did. */
const ROUTE_REDIRECT = { action: 'cUsers.edituser', params: { siteid: 'default', userid: USER_ID } };

const WRITTEN: FakeReply = { status: 200, body: { redirect: ROUTE_REDIRECT, written: true } };

const EDIT_USER: SubmitResult = {
  kind: 'redirect',
  action: 'cUsers.edituser',
  preserve: 'siteid,userid,routeid',
  path: './',
};

const EDIT_PROFILE: SubmitResult = { kind: 'redirect', action: 'cEditProfile.edit', path: './' };

const received: ReceivedBody[] = [];
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(async () => {
  await Promise.all(received.splice(0).map((body) => body.dispose?.()));
  restoreEnv();
});

/** The admin's `cusers.updateaddress` request whose rc merges `url` and `form`. */
const updateRequest = (url: Fields, form: Fields = {}) =>
  adminS2Request({ circuit: 'cusers', item: 'updateaddress', rc: { ...url, ...form } });

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

/** `fields` as the browser posts the multipart Edit Address form, received by web, with the sent bytes. */
async function multipart(fields: Fields): Promise<{ body: ReceivedBody; bytes: Buffer; contentType: string }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const request = new Request('http://web.test/admin-actions/cusers/updateaddress', { method: 'POST', body: form });
  const bytes = Buffer.from(await request.clone().arrayBuffer());
  const contentType = request.headers.get('content-type') ?? '';
  const body = await receiveRequestBody(request);
  received.push(body);
  return { body, bytes, contentType };
}

/** The people calls a submit made. */
const peopleCalls = (gateway: FakeGatewayClient) => gateway.calls.filter((call) => call.service === 'people');

describe('cusers.updateaddress', () => {
  it('is the people-owned redirect action behind the cUsers gate', () => {
    expect(updateAddressAction).toMatchObject({
      circuit: 'cusers',
      action: 'updateaddress',
      mode: 'redirect',
      owner: 'people',
    });
    expect(updateAddressAction.gate).toBe(cusersGate);
  });

  it.each<{ action: string; form: Fields }>([
    { action: 'Add', form: { action: 'Add', addressID: '', isPrimary: '1' } },
    { action: 'Update', form: { action: 'Update', addressID: ADDRESS_ID } },
    { action: 'Delete', form: { action: 'Delete', addressID: ADDRESS_ID } },
  ])('relays a multipart $action body byte for byte with the action URL fields', async ({ form }) => {
    const fields = { ...ADDRESS_FIELDS, ...form, ...CSRF };
    const upload = await multipart(fields);
    let relayed: { bytes: Buffer; contentType?: string } | undefined;
    const gateway = fakeGatewayClient({
      [UPDATE_ROUTE]: (request) => {
        relayed = { bytes: request.bytes, contentType: request.headers['content-type'] };
        return WRITTEN;
      },
    });
    const ctx = contextFor(updateRequest(ACTION_URL, fields), gateway, upload.body.body);

    await expect(updateAddressAction.submit(ctx)).resolves.toEqual(EDIT_USER);
    expect(peopleCalls(gateway)).toEqual([
      {
        service: 'people',
        method: 'POST',
        path: UPDATE_PATH,
        query: ACTION_URL,
        headers: { 'content-type': upload.contentType, 'content-length': String(upload.bytes.length) },
      },
    ]);
    expect(relayed?.contentType).toBe(upload.contentType);
    expect(relayed?.bytes.equals(upload.bytes)).toBe(true);
  });

  it.each<{ via: string; url: Fields; form: Fields }>([
    { via: 'the Edit User delete link (GET)', url: { action: 'delete', addressID: ADDRESS_ID, ...CSRF }, form: {} },
    { via: 'a URL-encoded Add', url: {}, form: { ...ADDRESS_FIELDS, action: 'Add', ...CSRF } },
    { via: 'a URL-encoded Update', url: {}, form: { ...ADDRESS_FIELDS, action: 'Update', addressID: ADDRESS_ID, ...CSRF } },
  ])('posts every rc field URL-encoded for $via', async ({ url, form }) => {
    const gateway = fakeGatewayClient({ [UPDATE_ROUTE]: WRITTEN });
    const req = updateRequest({ ...ACTION_URL, ...url }, form);

    await expect(updateAddressAction.submit(contextFor(req, gateway))).resolves.toEqual(EDIT_USER);
    expect(peopleCalls(gateway)).toEqual([
      { service: 'people', method: 'POST', path: UPDATE_PATH, form: Object.fromEntries(Object.entries(req.rc)) },
    ]);
    expect(peopleCalls(gateway)[0]?.form).toMatchObject({ ...ACTION_URL, ...url, ...form });
  });

  it.each<{ routeid: Fields; result: SubmitResult }>([
    { routeid: { routeid: 'editprofile' }, result: EDIT_PROFILE },
    { routeid: { routeID: 'EditProfile' }, result: EDIT_PROFILE },
    { routeid: { routeid: '' }, result: EDIT_USER },
    { routeid: { routeid: 'adManager' }, result: EDIT_USER },
    { routeid: {}, result: EDIT_USER },
  ])('redirects for routeid $routeid', async ({ routeid, result }) => {
    const gateway = fakeGatewayClient({ [UPDATE_ROUTE]: WRITTEN });
    const req = updateRequest({ userid: USER_ID, siteid: 'default', ...routeid }, { action: 'Update', ...CSRF });

    await expect(updateAddressAction.submit(contextFor(req, gateway))).resolves.toEqual(result);
  });

  it('still redirects when people rejected the token and wrote nothing', async () => {
    const gateway = fakeGatewayClient({ [UPDATE_ROUTE]: { status: 200, body: { redirect: ROUTE_REDIRECT, written: false } } });
    const req = updateRequest(ACTION_URL, { action: 'Update', addressID: ADDRESS_ID, csrf_token: 'stale' });

    await expect(updateAddressAction.submit(contextFor(req, gateway))).resolves.toEqual(EDIT_USER);
    expect(peopleCalls(gateway)).toHaveLength(1);
  });

  it.each<{ answer: string; reply?: FakeReply; error: new (...args: never[]) => Error }>([
    { answer: 'no answer', error: GatewayUnavailableError },
    { answer: 'HTTP 503', reply: { status: 503 }, error: GatewayUnavailableError },
    { answer: 'HTTP 403', reply: { status: 403 }, error: GatewayDenialError },
    { answer: 'HTTP 400', reply: { status: 400, body: {} }, error: Error },
  ])('propagates $answer from people without redirecting', async ({ reply, error }) => {
    const gateway = fakeGatewayClient(reply === undefined ? {} : { [UPDATE_ROUTE]: reply });
    if (reply === undefined) gateway.failWith();
    const req = updateRequest(ACTION_URL, { action: 'Update', addressID: ADDRESS_ID, ...CSRF });

    await expect(updateAddressAction.submit(contextFor(req, gateway))).rejects.toBeInstanceOf(error);
  });
});
