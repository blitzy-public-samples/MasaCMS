// The ccomments moderation, edit and list actions against ccomments.cfc: their strategies-content calls and answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import {
  CCOMMENTS_PRESERVE,
  ccommentsApprove,
  ccommentsDelete,
  ccommentsMarkAsSpam,
  ccommentsPurgeDeletedComments,
  ccommentsUnapprove,
} from '@/screens/ccomments/actions';
import { ccommentsBulkEdit, ccommentsSingleEdit } from '@/screens/ccomments/ajax';
import { ccommentsLoadComments } from '@/screens/ccomments/loadcomments';
import { CCOMMENTS_OWNER, ccommentsGate } from '@/screens/ccomments/shared';
import type { FragmentScreen, PageRedirect, RedirectScreen, ScreenContext, SubmitResult } from '@/screens/registry';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry imports every circuit; the context helper reads only its shell hooks, which these screens never use.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: {} }) }));

type Fields = Readonly<Record<string, string>>;
type WriteRedirect = { circuit: string; action: string; params: Array<[string, string]> } | null;

const SITE = 'tenant-a';
const COMMENT_ID = 'A0000000-0000-0000-0000000000000001';
const OTHER_ID = 'B0000000-0000-0000-0000000000000002';
const COMMENTS_PATH = `/v1/sites/${SITE}/comments`;
const AJAX_PATH = '/v1/raw/ccomments/ajax';
const LOAD_PATH = '/v1/raw/ccomments/loadcomments';
const VIEW_TYPE = 'text/html;charset=UTF-8';
const POSTED: Fields = { commentid: COMMENT_ID, isapproved: '1', csrf_token: 'T' };
const BULK_RC: Fields = { bulkedit: 'approve', ckupdate: `${COMMENT_ID},${OTHER_ID}` };
const SINGLE_RC: Fields = { commentid: COMMENT_ID, updateaction: 'unspam' };
const LIST_RC: Fields = { commentStatus: 'pending', sortBy: 'entered', pageNo: '1' };

/** One moderation action, its contract operation and the service path it writes for {@link SITE}. */
interface ActionCase {
  readonly screen: RedirectScreen;
  readonly action: string;
  readonly operation: string;
  readonly path: ServicePath;
}

const commentPath = (write: string): ServicePath => `${COMMENTS_PATH}/${COMMENT_ID}/${write}`;

const APPROVE: ActionCase = {
  screen: ccommentsApprove,
  action: 'approve',
  operation: 'approveComment',
  path: commentPath('approve'),
};

const COMMENT_ACTIONS: readonly ActionCase[] = [
  APPROVE,
  { screen: ccommentsUnapprove, action: 'unapprove', operation: 'unapproveComment', path: commentPath('unapprove') },
  { screen: ccommentsDelete, action: 'delete', operation: 'deleteComment', path: commentPath('delete') },
  { screen: ccommentsMarkAsSpam, action: 'markasspam', operation: 'markCommentSpam', path: commentPath('spam') },
];

const PURGE: ActionCase = {
  screen: ccommentsPurgeDeletedComments,
  action: 'purgedeletedcomments',
  operation: 'purgeDeletedComments',
  path: `${COMMENTS_PATH}/purge-deleted`,
};

const ACTIONS: readonly ActionCase[] = [...COMMENT_ACTIONS, PURGE];

/** One fragment action, the request fields it sends and the service calls it makes for {@link SITE}. */
interface FragmentCase {
  readonly screen: Pick<FragmentScreen<undefined>, 'render'>;
  readonly action: string;
  readonly rc: Fields;
  /** The write the action runs before its view, if any. */
  readonly routes: FakeRouteTable;
  readonly viewPath: ServicePath;
  readonly calls: ReadonlyArray<Partial<FakeCall>>;
}

/** FW/1 `redirect(action='cComments.default', preserve='processed,isapproved,siteid', path='./')`. */
const managerRedirect = (processed: string): PageRedirect => ({
  kind: 'redirect',
  action: 'cComments.default',
  preserve: 'processed,isapproved,siteid',
  path: './',
  rc: { processed },
});

/** The owner's 200 `AdminWriteResult`. */
const written = (saved: boolean, redirect: WriteRedirect = null): FakeReply => ({
  status: 200,
  body: { saved, errors: {}, redirect },
});

const view = (markup: string): FakeReply => ({ status: 200, headers: { 'content-type': VIEW_TYPE }, body: markup });

const post = (path: ServicePath): string => routeKey('POST', 'strategies-content', path);

/** The tenant-a site admin sending `rc` to `cComments.<action>`. */
const requestFor = (action: string, rc: Fields): AdminRequest =>
  siteAdminRequest(SITE, { circuit: 'cComments', item: action, rc });

const contextFor = (req: AdminRequest, routes: FakeRouteTable = {}): ScreenContext & { gateway: FakeGatewayClient } =>
  makeScreenContext({ req, gateway: fakeGatewayClient(routes) });

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('moderation actions', () => {
  it('preserves processed, isapproved and siteid', () => {
    expect(CCOMMENTS_PRESERVE).toEqual(['processed', 'isapproved', 'siteid']);
  });

  it.each(ACTIONS)('declares $action', ({ screen, action }) => {
    expect(screen).toMatchObject({
      circuit: 'ccomments',
      action,
      mode: 'redirect',
      owner: CCOMMENTS_OWNER,
      gate: ccommentsGate,
    });
    expect(Object.isFrozen(screen)).toBe(true);
  });

  it.each(ACTIONS.flatMap((entry) => [true, false].map((saved) => ({ ...entry, saved }))))(
    'posts $action fields unchanged and redirects with processed=$saved',
    async ({ screen, action, path, saved }) => {
      const req = requestFor(action, POSTED);
      const ctx = contextFor(req, { [post(path)]: written(saved) });

      expect(await screen.submit(ctx)).toEqual(managerRedirect(String(saved)));
      expect(ctx.gateway.calls).toEqual([
        { service: 'strategies-content', method: 'POST', path, form: Object.fromEntries(Object.entries(req.rc)) },
      ]);
      expect(ctx.gateway.calls[0]?.form).toMatchObject({ ...POSTED, siteid: SITE });
    },
  );

  it.each([
    ['tenant-b', 'tenant-b'],
    ['', 'default'],
  ])('addresses rc.siteid %j as site %j', async (siteid, expected) => {
    const path: ServicePath = `/v1/sites/${expected}/comments/${COMMENT_ID}/approve`;
    const req = adminS2Request({ circuit: 'cComments', item: 'approve', rc: { commentid: COMMENT_ID, siteid } });
    const ctx = contextFor(req, { [post(path)]: written(true) });

    expect(await ccommentsApprove.submit(ctx)).toEqual(managerRedirect('true'));
    expect(ctx.gateway.calls.map((call) => call.path)).toEqual([path]);
  });

  it.each(COMMENT_ACTIONS)('writes nothing for $action without a commentid', async ({ screen, action, path }) => {
    const ctx = contextFor(requestFor(action, { isapproved: '0' }), { [post(path)]: written(true) });

    expect(await screen.submit(ctx)).toEqual(managerRedirect('false'));
    expect(ctx.gateway.calls).toEqual([]);
  });

  it('purges without a commentid', async () => {
    const ctx = contextFor(requestFor(PURGE.action, {}), { [post(PURGE.path)]: written(true) });

    expect(await PURGE.screen.submit(ctx)).toEqual(managerRedirect('true'));
    expect(ctx.gateway.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${PURGE.path}`]);
  });

  it.each<{ name: string; redirect: NonNullable<WriteRedirect>; result: SubmitResult }>([
    {
      name: 'with its parameters encoded',
      redirect: {
        circuit: 'cComments',
        action: 'default',
        params: [
          ['siteid', SITE],
          ['isapproved', '1'],
          ['keywords', 'a b&c'],
        ],
      },
      result: { ...managerRedirect('true'), queryString: 'siteid=tenant-a&isapproved=1&keywords=a+b%26c' },
    },
    {
      name: 'without parameters',
      redirect: { circuit: 'cMessage', action: 'noaccess', params: [] },
      result: { ...managerRedirect('true'), action: 'cMessage.noaccess' },
    },
  ])('follows the service redirect $name', async ({ redirect, result }) => {
    const ctx = contextFor(requestFor(APPROVE.action, POSTED), { [post(APPROVE.path)]: written(true, redirect) });

    expect(await APPROVE.screen.submit(ctx)).toEqual(result);
  });

  it('passes a service Location through', async () => {
    const location = './?muraAction=cLogin.main&returnURL=%2Fadmin%2F';
    const ctx = contextFor(requestFor(APPROVE.action, POSTED), {
      [post(APPROVE.path)]: { status: 302, headers: { location } },
    });

    expect(await APPROVE.screen.submit(ctx)).toEqual({ kind: 'location', location });
  });

  it.each(ACTIONS)('names $operation when $action is refused', async ({ screen, action, operation, path }) => {
    const ctx = contextFor(requestFor(action, POSTED), { [post(path)]: { status: 403, body: {} } });

    const error = await screen.submit(ctx).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'strategies-content', operation, status: 403 });
  });

  it.each([400, 404])('fails on HTTP %i', async (status) => {
    const ctx = contextFor(requestFor(APPROVE.action, POSTED), { [post(APPROVE.path)]: { status, body: {} } });

    await expect(APPROVE.screen.submit(ctx)).rejects.toMatchObject({
      name: 'Error',
      message: `approveComment answered HTTP ${status}`,
    });
  });

  it.each(
    ACTIONS.flatMap((entry) => [
      { ...entry, outage: 'a refused connection', status: undefined, routes: {}, refuse: true },
      { ...entry, outage: 'HTTP 503', status: 503, routes: { [post(entry.path)]: { status: 503 } }, refuse: false },
    ]),
  )('rejects $action on $outage', async ({ screen, action, status, routes, refuse }) => {
    const ctx = contextFor(requestFor(action, POSTED), routes);
    if (refuse) ctx.gateway.failWith();

    const error = await screen.submit(ctx).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'strategies-content', status });
  });
});

describe('edit and list fragments', () => {
  it.each([
    { screen: ccommentsBulkEdit, action: 'bulkedit' },
    { screen: ccommentsSingleEdit, action: 'singleedit' },
    { screen: ccommentsLoadComments, action: 'loadcomments' },
  ])('declares $action', ({ screen, action }) => {
    expect(screen).toMatchObject({
      circuit: 'ccomments',
      action,
      mode: 'fragment',
      owner: CCOMMENTS_OWNER,
      gate: ccommentsGate,
    });
    expect(screen.load).toBeUndefined();
    expect(Object.isFrozen(screen)).toBe(true);
  });

  it.each<FragmentCase>([
    {
      screen: ccommentsBulkEdit,
      action: 'bulkEdit',
      rc: BULK_RC,
      routes: { [post(`${COMMENTS_PATH}/bulk`)]: written(true) },
      viewPath: AJAX_PATH,
      calls: [
        { method: 'POST', path: `${COMMENTS_PATH}/bulk`, form: BULK_RC },
        { method: 'GET', path: AJAX_PATH, query: { siteid: SITE } },
      ],
    },
    {
      screen: ccommentsSingleEdit,
      action: 'singleEdit',
      rc: SINGLE_RC,
      routes: { [post(`${COMMENTS_PATH}/${COMMENT_ID}`)]: written(false) },
      viewPath: AJAX_PATH,
      calls: [
        { method: 'POST', path: `${COMMENTS_PATH}/${COMMENT_ID}`, form: SINGLE_RC },
        { method: 'GET', path: AJAX_PATH, query: { siteid: SITE } },
      ],
    },
    {
      screen: ccommentsLoadComments,
      action: 'loadComments',
      rc: LIST_RC,
      routes: {},
      viewPath: LOAD_PATH,
      calls: [{ method: 'GET', path: LOAD_PATH, query: { siteid: SITE, ...LIST_RC } }],
    },
  ])('relays $action from strategies-content', async ({ screen, action, rc, routes, viewPath, calls }) => {
    const markup = `<div class="mura-table-grid">${action} &lt;b&gt;</div>`;
    const ctx = contextFor(requestFor(action, rc), {
      ...routes,
      [routeKey('GET', 'strategies-content', viewPath)]: view(markup),
    });

    expect(await screen.render(ctx, undefined)).toEqual({
      status: 200,
      contentType: VIEW_TYPE,
      body: Buffer.from(markup),
    });
    expect(ctx.gateway.calls).toMatchObject(calls);
    expect(ctx.gateway.calls.map((call) => [call.service, call.form?.siteid])).toEqual(
      calls.map(() => ['strategies-content', undefined]),
    );
  });
});
