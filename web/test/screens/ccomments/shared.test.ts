// The ccomments controller gate, site default and strategies-content relay against ccomments.cfc before() and secure().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, moduleRole, type Role } from '@opt2/platform/auth';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import {
  CCOMMENTS_OWNER,
  COMMENTS_MODULE_ID,
  CONTENT_MODULE_ID,
  ccommentsGate,
  commentsSiteId,
  relayCommentsRaw,
} from '@/screens/ccomments/shared';
import type { RawBody } from '@/screens/registry';
import { CCOMMENTS_PATHS, COMMENT_IDS, loadCommentsRelay } from '../../fixtures/strategies-content/comments';
import { adminS2Request, anonymousRequest, makeAdminRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

const MANAGER = { circuit: 'ccomments', item: 'default' } as const;
const LOAD = routeKey('GET', CCOMMENTS_OWNER, CCOMMENTS_PATHS.loadComments);
const PAGE = routeKey('GET', CCOMMENTS_OWNER, CCOMMENTS_PATHS.loadCommentsPage);
const PAGE_TYPE = 'text/html; charset=utf-8';
const PAGE_BODY = '<dd class="comment"><p>First &lt;b&gt;post</p></dd>';
const MISSING_BODY = '<h1>Not Found</h1>';

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** qa_editor on the Comments Manager with its token's roles replaced by `roles`. */
const editorWith = (...roles: Role[]): AdminRequest =>
  makeAdminRequest({ ...MANAGER, user: { roles } }, SUBJECTS.qaEditor);

/** The gate's decision for `req` and how often it called `secure()`. */
async function decide(req: AdminRequest): Promise<{ decision: GateDecision; secureCalls: number }> {
  const spy = vi.fn(() => secure(req));
  const decision = await ccommentsGate(req, { secure: spy });
  return { decision, secureCalls: spy.mock.calls.length };
}

/** `req` whose rc holds no `siteid` in any case. */
const withoutSiteId = (req: AdminRequest): AdminRequest => ({
  ...req,
  rc: Object.fromEntries(Object.entries(req.rc).filter(([name]) => name.toLowerCase() !== 'siteid')),
});

/** The RawBody of a relayed answer with `body` as its bytes. */
const rawOf = (status: number, contentType: string, body: string): RawBody => ({
  status,
  contentType,
  body: Buffer.from(body),
});

describe('constants', () => {
  it('names the legacy modules and the owner', () => {
    expect({ COMMENTS_MODULE_ID, CONTENT_MODULE_ID, CCOMMENTS_OWNER }).toEqual({
      COMMENTS_MODULE_ID: '00000000000000000000000000000000015',
      CONTENT_MODULE_ID: '00000000000000000000000000000000000',
      CCOMMENTS_OWNER: 'strategies-content',
    });
  });
});

describe('ccommentsGate', () => {
  it.each<[string, () => AdminRequest]>([
    ['S2', () => adminS2Request(MANAGER)],
    ['a tenant-a site admin', () => siteAdminRequest('tenant-a', MANAGER)],
    [
      'comments and content module access',
      () => editorWith(Roles.systemUser, moduleRole(COMMENTS_MODULE_ID), moduleRole(CONTENT_MODULE_ID)),
    ],
  ])('allows %s', async (_name, request) => {
    expect(await decide(request())).toEqual({ decision: { kind: 'allow' }, secureCalls: 0 });
  });

  it.each<[string, () => AdminRequest]>([
    ['comments module access alone', () => editorWith(Roles.systemUser, moduleRole(COMMENTS_MODULE_ID))],
    ['content module access alone', () => editorWith(Roles.systemUser, moduleRole(CONTENT_MODULE_ID))],
    ['a system user without either', () => editorWith(Roles.systemUser)],
    ['anonymous', () => anonymousRequest(MANAGER)],
    [
      'privileges claimed in rc',
      () => anonymousRequest({ ...MANAGER, rc: { s2: '1', roles: 's2', memberships: 'S2' } }),
    ],
  ])('secures %s', async (_name, request) => {
    const req = request();
    expect(await decide(req)).toEqual({ decision: secure(req), secureCalls: 1 });
  });

  it('sends anonymous users to cLogin.main with a return URL', async () => {
    const { decision } = await decide(anonymousRequest(MANAGER));
    expect(decision).toMatchObject({ kind: 'redirect' });
    expect(decision.kind === 'redirect' ? decision.location : '').toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
  });
});

describe('commentsSiteId', () => {
  it('reads rc.siteid', () => {
    expect(commentsSiteId(adminS2Request({ rc: { siteid: 'tenant-b' } }))).toBe('tenant-b');
  });

  it.each<[string, () => AdminRequest]>([
    ['absent', () => withoutSiteId(adminS2Request({ session: { siteid: 'tenant-a' } }))],
    ['empty', () => adminS2Request({ session: { siteid: 'tenant-a' }, rc: { siteid: '' } })],
  ])('falls back to the session site when rc.siteid is %s', (_name, request) => {
    const req = request();
    expect(req.session.siteid).toBe('tenant-a');
    expect(commentsSiteId(req)).toBe('tenant-a');
  });
});

describe('relayCommentsRaw', () => {
  it('relays the loadcomments view unwrapped', async () => {
    const ctx = makeScreenContext({
      req: adminS2Request({ circuit: 'ccomments', item: 'loadcomments' }),
      gateway: fakeGatewayClient({ [LOAD]: loadCommentsRelay }),
    });

    const result = await relayCommentsRaw(ctx, 'loadcomments');

    expect(result).toEqual(
      rawOf(loadCommentsRelay.status, loadCommentsRelay.headers['content-type'], loadCommentsRelay.body),
    );
    expect(Object.keys(result).sort()).toEqual(['body', 'contentType', 'status']);
    expect(ctx.gateway.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${CCOMMENTS_PATHS.loadComments}`,
    ]);
  });

  it('selects the view path by action and forwards rc unchanged', async () => {
    const req = adminS2Request({
      circuit: 'ccomments',
      item: 'loadcommentspage',
      rc: { siteid: 'tenant-b', commentID: COMMENT_IDS.pending, sortDirection: 'asc', _: '1782810000000' },
    });
    const ctx = makeScreenContext({
      req,
      gateway: fakeGatewayClient({ [PAGE]: { status: 200, headers: { 'content-type': PAGE_TYPE }, body: PAGE_BODY } }),
    });

    expect(await relayCommentsRaw(ctx, 'loadcommentspage')).toEqual(rawOf(200, PAGE_TYPE, PAGE_BODY));
    expect(ctx.gateway.calls).toEqual([
      {
        service: CCOMMENTS_OWNER,
        method: 'GET',
        path: CCOMMENTS_PATHS.loadCommentsPage,
        query: { ...req.rc },
      },
    ]);
  });

  it('keeps a non-200 status', async () => {
    const type = loadCommentsRelay.headers['content-type'];
    const ctx = makeScreenContext({
      req: adminS2Request({ circuit: 'ccomments', item: 'loadcomments' }),
      gateway: fakeGatewayClient({ [LOAD]: { status: 404, headers: { 'content-type': type }, body: MISSING_BODY } }),
    });

    expect(await relayCommentsRaw(ctx, 'loadcomments')).toEqual(rawOf(404, type, MISSING_BODY));
  });
});
