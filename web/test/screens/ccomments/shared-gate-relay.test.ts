// The ccomments gate, site default and strategies-content relay against ccomments.cfc and the service contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { secure, type GateDecision } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import type { ScreenContext } from '@/screens/registry';
import {
  CCOMMENTS_OWNER,
  COMMENTS_MODULE_ID,
  CONTENT_MODULE_ID,
  ccommentsGate,
  commentsSiteId,
  relayCommentsRaw,
} from '@/screens/ccomments/shared';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRouteTable } from '../../helpers/fake-gateway';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';

const LOAD = routeKey('GET', 'strategies-content', '/v1/raw/ccomments/loadcomments');
const PAGE = routeKey('GET', 'strategies-content', '/v1/raw/ccomments/loadcommentspage');
const PAGE_POST = routeKey('POST', 'strategies-content', '/v1/raw/ccomments/loadcommentspage');
const AJAX = routeKey('GET', 'strategies-content', '/v1/raw/ccomments/ajax');
const BULK = routeKey('POST', 'strategies-content', '/v1/sites/default/comments/bulk');
const FRAGMENT_TYPE = 'text/html;charset=UTF-8';
const AJAX_TYPE = 'text/html;charset=utf-8';
const ID_A = 'A0000000-0000-0000-0000000000000001';
const ID_B = 'B0000000-0000-0000-0000000000000002';
const EDIT = routeKey('POST', 'strategies-content', `/v1/sites/default/comments/${ID_A}`);
const WRITTEN = { status: 200, body: { saved: true, errors: {}, redirect: null } };
const AJAX_REPLY = { status: 200, headers: { 'content-type': AJAX_TYPE }, body: '' };
const fragment = (body: string, status = 200) => ({ status, headers: { 'content-type': FRAGMENT_TYPE }, body });

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
  const decision = await ccommentsGate(req, { secure: spy });
  return { decision, secureCalls: spy.mock.calls.length };
}

/** qa_editor holding exactly `roles`. */
const editorWith = (...roles: string[]): AdminRequest =>
  makeAdminRequest({ circuit: 'ccomments', item: 'loadcomments', user: { roles } }, 'qaEditor');

/** An S2 request carrying `rc` and `headers`, over a gateway answering `routes`; the relay reads no csrf, rb or hooks. */
function relayContext(
  rc: Readonly<Record<string, string>>,
  routes: FakeRouteTable,
  headers?: Headers,
): { gateway: FakeGatewayClient; ctx: ScreenContext } {
  const gateway = fakeGatewayClient(routes);
  const req = adminS2Request({ circuit: 'ccomments', item: 'loadcomments', rc, ...(headers ? { headers } : {}) });
  const ctx = { req, gateway, csrf: {}, rb: {}, hooks: {}, now: new Date(0) } as unknown as ScreenContext;
  return { gateway, ctx };
}

describe('constants', () => {
  it('names the legacy modules and the owner', () => {
    expect([COMMENTS_MODULE_ID, CONTENT_MODULE_ID, CCOMMENTS_OWNER]).toEqual([
      '00000000000000000000000000000000015',
      '00000000000000000000000000000000000',
      'strategies-content',
    ]);
  });
});

describe('ccommentsGate', () => {
  it.each<[string, () => AdminRequest]>([
    ['S2', () => adminS2Request({ circuit: 'ccomments', item: 'loadcomments' })],
    ['a site admin', () => siteAdminRequest('tenant-a', { circuit: 'ccomments', item: 'loadcomments' })],
    [
      'comments and content module access',
      () => editorWith(Roles.systemUser, moduleRole(COMMENTS_MODULE_ID), moduleRole(CONTENT_MODULE_ID)),
    ],
  ])('allows %s', async (_name, request) => {
    expect(await gate(request())).toEqual({ decision: { kind: 'allow' }, secureCalls: 0 });
  });

  it.each<[string, () => AdminRequest]>([
    ['comments module access alone', () => editorWith(Roles.systemUser, moduleRole(COMMENTS_MODULE_ID))],
    ['content module access alone', () => editorRequest({ circuit: 'ccomments', item: 'loadcomments' })],
    ['anonymous', () => anonymousRequest({ circuit: 'ccomments', item: 'loadcomments' })],
    ['privileges claimed in rc', () => editorRequest({ rc: { s2: '1', roles: 's2', memberships: 'S2' } })],
    [
      'comments and content module access granted for a site the token does not serve',
      () =>
        makeAdminRequest(
          {
            circuit: 'ccomments',
            item: 'loadcomments',
            rc: { siteid: 'tenant-b' },
            user: { roles: [Roles.systemUser, moduleRole(COMMENTS_MODULE_ID), moduleRole(CONTENT_MODULE_ID)] },
          },
          'qaEditor',
        ),
    ],
  ])('secures %s', async (_name, request) => {
    const req = request();
    const { decision, secureCalls } = await gate(req);
    expect(decision).toEqual(secure(req));
    expect(secureCalls).toBe(1);
  });

  it.each(REQUESTED_SITE_CASES)('admits $who only when it administers that site', async ({ request, administers }) => {
    const req = request({ circuit: 'ccomments', item: 'loadcomments' });
    expect(await gate(req)).toEqual(
      administers ? { decision: { kind: 'allow' }, secureCalls: 0 } : { decision: secure(req), secureCalls: 1 },
    );
  });

  it('sends anonymous users to cLogin.main', async () => {
    const { decision } = await gate(anonymousRequest({ circuit: 'ccomments', item: 'loadcomments' }));
    expect(decision).toMatchObject({ kind: 'redirect', location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/) });
  });

  it('sends logged-in users back', async () => {
    const referer = 'http://localhost/admin/?muraAction=cComments.default';
    expect((await gate(editorRequest({ headers: new Headers({ referer }) }))).decision).toEqual({
      kind: 'redirect',
      location: referer,
    });
    expect((await gate(editorRequest())).decision).toEqual({ kind: 'redirect', location: './' });
  });
});

describe('commentsSiteId', () => {
  it.each([
    ['tenant-b', 'tenant-b'],
    ['', 'default'],
  ])('reads rc.siteid %j as %j', (siteid, expected) => {
    expect(commentsSiteId(adminS2Request({ rc: { siteid } }))).toBe(expected);
  });
});

describe('relayCommentsRaw', () => {
  it('relays loadcomments bytes over GET with the request fields', async () => {
    const body = '<table class="mura-table-grid"><td>&lt;b&gt;x</td></table>';
    const fields = { commentStatus: 'approved', sortBy: 'name', pageNo: '2', cacheid: '0.25', _: '17', csrf_token: 'T' };
    const { gateway, ctx } = relayContext(fields, { [LOAD]: fragment(body) });

    const result = await relayCommentsRaw(ctx, 'loadcomments');

    expect(result).toEqual({ status: 200, contentType: FRAGMENT_TYPE, body: Buffer.from(body) });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({
      service: 'strategies-content',
      method: 'GET',
      path: '/v1/raw/ccomments/loadcomments',
      query: { siteid: 'default', ...fields },
    });
    expect(gateway.calls[0]?.form).toBeUndefined();
  });

  it.each([
    ['tenant-b', 'tenant-b'],
    ['', 'default'],
  ])('sends rc.siteid %j as siteid %j', async (siteid, expected) => {
    const { gateway, ctx } = relayContext({ siteid }, { [LOAD]: fragment('x') });
    await relayCommentsRaw(ctx, 'loadcomments');
    expect(gateway.calls[0]?.query?.siteid).toBe(expected);
  });

  it('selects the view path by action', async () => {
    const { gateway, ctx } = relayContext({ contentID: 'C1' }, { [PAGE]: fragment('<div id="commentsPage"></div>') });
    await relayCommentsRaw(ctx, 'loadcommentspage');
    expect(gateway.calls.map((call) => call.path)).toEqual(['/v1/raw/ccomments/loadcommentspage']);
  });

  it('relays a request with a body as a POST, status unchanged', async () => {
    const fields = { contentID: 'C1', commentID: ID_A, upperID: '', sortDirection: 'desc' };
    const { gateway, ctx } = relayContext(
      fields,
      { [PAGE_POST]: fragment('gone', 404) },
      new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
    );

    expect(await relayCommentsRaw(ctx, 'loadcommentspage')).toEqual({
      status: 404,
      contentType: FRAGMENT_TYPE,
      body: Buffer.from('gone'),
    });
    expect(gateway.calls[0]).toMatchObject({ method: 'POST', query: { siteid: 'default' }, form: fields });
    expect(gateway.calls[0]?.form?.siteid).toBeUndefined();
  });

  it('runs bulkedit through its write, then returns the ajax view', async () => {
    const fields = { bulkedit: 'approve', ckUpdate: `${ID_A},${ID_B}`, cacheid: '0.5' };
    const { gateway, ctx } = relayContext(fields, { [BULK]: WRITTEN, [AJAX]: AJAX_REPLY });

    expect(await relayCommentsRaw(ctx, 'bulkedit')).toEqual({ status: 200, contentType: AJAX_TYPE, body: Buffer.alloc(0) });
    expect(gateway.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/sites/default/comments/bulk',
      'GET /v1/raw/ccomments/ajax',
    ]);
    expect(gateway.calls[0]?.form).toMatchObject(fields);
    expect(gateway.calls[1]?.query).toEqual({ siteid: 'default' });
  });

  it('returns the ajax view after a failed singleedit', async () => {
    const fields = { commentid: ID_A, updateaction: 'unspam' };
    const { gateway, ctx } = relayContext(fields, { [EDIT]: { status: 404, body: { error: 'x' } }, [AJAX]: AJAX_REPLY });

    expect(await relayCommentsRaw(ctx, 'singleedit')).toEqual({ status: 200, contentType: AJAX_TYPE, body: Buffer.alloc(0) });
    expect(gateway.calls[0]).toMatchObject({ method: 'POST', path: `/v1/sites/default/comments/${ID_A}`, form: fields });
  });

  it('stops at a refused edit', async () => {
    const { gateway, ctx } = relayContext({ commentid: ID_A }, { [EDIT]: { status: 403, body: {} }, [AJAX]: AJAX_REPLY });
    await expect(relayCommentsRaw(ctx, 'singleedit')).rejects.toMatchObject({ name: 'GatewayDenialError', status: 403 });
    expect(gateway.calls).toHaveLength(1);
  });

  it('turns a refused view into GatewayDenialError', async () => {
    const { ctx } = relayContext({}, { [LOAD]: { status: 401, body: {} } });
    await expect(relayCommentsRaw(ctx, 'loadcomments')).rejects.toBeInstanceOf(GatewayDenialError);
  });

  it('propagates unavailability', async () => {
    const down = relayContext({}, { [LOAD]: fragment('x', 503) });
    await expect(relayCommentsRaw(down.ctx, 'loadcomments')).rejects.toBeInstanceOf(GatewayUnavailableError);
    const refused = relayContext({}, {});
    refused.gateway.failWith();
    await expect(relayCommentsRaw(refused.ctx, 'bulkedit')).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('passes service cookies through', async () => {
    const { ctx } = relayContext({}, { [LOAD]: { ...fragment('x'), setCookies: ['a=1'] } });
    expect(await relayCommentsRaw(ctx, 'loadcomments')).toMatchObject({ setCookies: ['a=1'] });
  });

  it('rejects an answer without a content type', async () => {
    const { ctx } = relayContext({}, { [LOAD]: { status: 200, body: 'x' } });
    await expect(relayCommentsRaw(ctx, 'loadcomments')).rejects.toBeInstanceOf(TypeError);
  });
});
