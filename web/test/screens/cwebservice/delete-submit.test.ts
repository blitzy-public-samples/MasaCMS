// cwebservice.delete against legacy cwebservice.cfc delete(): identity deletes the client, then FW/1 redirects.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { submitDelete } from '@/screens/cwebservice/delete';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { CSRF_CWEBSERVICE } from '../../fixtures/identity/csrf';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

const CLIENT_ID = CSRF_CWEBSERVICE.context;
const DELETE_PATH = `/v1/oauth-clients/${CLIENT_ID}` as const;
const DELETE_ROUTE = routeKey('DELETE', 'identity', DELETE_PATH);

const CSRF_RC = {
  csrf_token: CSRF_CWEBSERVICE.csrf_token,
  csrf_token_expires: CSRF_CWEBSERVICE.csrf_token_expires,
} as const;

const LIST_REDIRECT: SubmitResult = { kind: 'redirect', action: 'cwebservice.list', append: 'siteid', path: './' };

const DELETED: FakeReply = { status: 200, body: { written: true } };

function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

/** The admin's `cwebservice.delete` request for `CLIENT_ID` with `rc` laid over it. */
function deleteRequest(rc: Readonly<Record<string, string>> = {}): AdminRequest {
  return adminS2Request({ circuit: 'cwebservice', item: 'delete', rc: { clientid: CLIENT_ID, ...rc } });
}

/** `req` without the rc fields named in `names`. */
function withoutRc(req: AdminRequest, ...names: readonly string[]): AdminRequest {
  const dropped = new Set(names.map((name) => name.toLowerCase()));
  const rc = Object.fromEntries(Object.entries(req.rc).filter(([name]) => !dropped.has(name.toLowerCase())));
  return { ...req, rc };
}

describe('cwebservice.delete', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('deletes through identity with the CSRF fields as the form, then redirects to the list', async () => {
    let body: string | undefined;
    const gateway = fakeGatewayClient({
      [DELETE_ROUTE]: (request) => {
        body = request.body;
        return DELETED;
      },
    });

    const result = await submitDelete(contextFor(deleteRequest(CSRF_RC), gateway));

    expect(result).toEqual(LIST_REDIRECT);
    expect(gateway.calls).toEqual([
      { service: 'identity', method: 'DELETE', path: DELETE_PATH, query: { siteid: 'default' }, form: CSRF_RC },
    ]);
    expect(body).toBe(`csrf_token=${CSRF_RC.csrf_token}&csrf_token_expires=${CSRF_RC.csrf_token_expires}`);
  });

  it.each<{ fields: string; rc: Record<string, string>; form: Record<string, string> }>([
    { fields: 'no CSRF field', rc: {}, form: {} },
    { fields: 'only the token', rc: { csrf_token: CSRF_RC.csrf_token }, form: { csrf_token: CSRF_RC.csrf_token } },
    {
      fields: 'only the expiry',
      rc: { csrf_token_expires: CSRF_RC.csrf_token_expires },
      form: { csrf_token_expires: CSRF_RC.csrf_token_expires },
    },
    {
      fields: 'empty CSRF fields',
      rc: { csrf_token: '', csrf_token_expires: '' },
      form: { csrf_token: '', csrf_token_expires: '' },
    },
  ])('sends only the CSRF fields rc carries, with $fields', async ({ rc, form }) => {
    const gateway = fakeGatewayClient({ [DELETE_ROUTE]: DELETED });

    await expect(submitDelete(contextFor(deleteRequest(rc), gateway))).resolves.toEqual(LIST_REDIRECT);
    expect(gateway.calls).toEqual([
      { service: 'identity', method: 'DELETE', path: DELETE_PATH, query: { siteid: 'default' }, form },
    ]);
  });

  it.each([
    { siteid: 'tenant-a', req: () => deleteRequest({ ...CSRF_RC, siteid: 'tenant-a' }), query: { siteid: 'tenant-a' } },
    { siteid: 'empty', req: () => deleteRequest({ ...CSRF_RC, siteid: '' }), query: undefined },
    { siteid: 'absent', req: () => withoutRc(deleteRequest(CSRF_RC), 'siteid'), query: undefined },
  ])('sends rc.siteid as the query only when it is not empty ($siteid)', async ({ req, query }) => {
    const gateway = fakeGatewayClient({ [DELETE_ROUTE]: DELETED });

    await expect(submitDelete(contextFor(req(), gateway))).resolves.toEqual(LIST_REDIRECT);
    expect(gateway.calls).toEqual([
      {
        service: 'identity',
        method: 'DELETE',
        path: DELETE_PATH,
        ...(query === undefined ? {} : { query }),
        form: CSRF_RC,
      },
    ]);
  });

  it('deletes under an empty client id when rc carries none', async () => {
    const gateway = fakeGatewayClient();

    const result = await submitDelete(contextFor(withoutRc(deleteRequest(CSRF_RC), 'clientid'), gateway));

    expect(result).toEqual(LIST_REDIRECT);
    expect(gateway.calls).toEqual([
      {
        service: 'identity',
        method: 'DELETE',
        path: '/v1/oauth-clients/',
        query: { siteid: 'default' },
        form: CSRF_RC,
      },
    ]);
  });

  it.each([
    { answer: '200 written', reply: DELETED },
    { answer: '200 not written', reply: { status: 200, body: { written: false } } },
    { answer: '400', reply: { status: 400, body: { error: 'invalid' } } },
    { answer: '401', reply: { status: 401, body: { error: 'invalidAccessToken' } } },
    { answer: '403', reply: { status: 403, body: {} } },
    { answer: '404', reply: { status: 404 } },
    { answer: '500', reply: { status: 500, body: 'boom' } },
  ])('redirects to the list whatever identity answers ($answer)', async ({ reply }) => {
    const gateway = fakeGatewayClient({ [DELETE_ROUTE]: reply });

    await expect(submitDelete(contextFor(deleteRequest(CSRF_RC), gateway))).resolves.toEqual(LIST_REDIRECT);
    expect(gateway.calls).toHaveLength(1);
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    ...[502, 503, 504].map((status) => ({
      outage: `a ${status} answer`,
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(DELETE_ROUTE, { status, body: {} }),
    })),
  ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    await expect(submitDelete(contextFor(deleteRequest(CSRF_RC), gateway))).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });
});
