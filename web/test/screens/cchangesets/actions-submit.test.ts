// cChangesets rollback, delete and removeitem against legacy cchangesets.cfc: the owner's write, then FW/1's redirect.
import { describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { fw1RedirectTarget } from '@/lib/urls';
import { changesetDeleteScreen } from '@/screens/cchangesets/delete';
import { changesetRemoveItemScreen } from '@/screens/cchangesets/removeitem';
import { changesetRollbackScreen } from '@/screens/cchangesets/rollback';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;
type WriteRedirect = { circuit: string; action: string; params: Array<[string, string]> } | null;

const CHANGESET_ID = '7C1A2B3D-4E5F-4A6B-8C9D0E1F2A3B4C5D';
const CONTENTHIST_ID = '8D2B3C4E-5F6A-4B7C-9D0E1F2A3B4C5D6E';
const CHANGESET_PATH = `/v1/sites/default/changesets/${CHANGESET_ID}`;
const ROLLBACK_PATH: ServicePath = `${CHANGESET_PATH}/rollback`;
const DELETE_PATH: ServicePath = `${CHANGESET_PATH}/delete`;
const REMOVE_PATH: ServicePath = `${CHANGESET_PATH}/items/${CONTENTHIST_ID}/remove`;

const CSRF: Fields = {
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000014',
  csrf_token_expires: '260630150000000',
};
const STALE_CSRF: Fields = { ...CSRF, csrf_token: '00000000000000000000000000000000000000000000000000000000000000ff' };

/** FW/1 `redirect(action=<action>, append="changesetID,siteID", path="./")`. */
const idRedirect = (action: string): SubmitResult => ({
  kind: 'redirect',
  action,
  append: 'changesetID,siteID',
  path: './',
});
const EDIT_REDIRECT = idRedirect('cChangesets.edit');
const LIST_REDIRECT = idRedirect('cChangesets.list');
const ASSIGNMENTS_REDIRECT: SubmitResult = {
  kind: 'redirect',
  action: 'cChangesets.assignments',
  append: 'changesetID,siteID,keywords',
  path: './',
};

/** One post action: its `submit`, the owner's route and the redirect legacy's controller takes. */
interface ActionCase {
  readonly action: string;
  readonly submit: (ctx: ScreenContext) => Promise<SubmitResult>;
  readonly path: ServicePath;
  readonly operation: string;
  readonly rc: Fields;
  /** The redirect the owner's `AdminWriteResult` names. */
  readonly written: WriteRedirect;
  /** What `submit` answers for a 200 carrying `written`. */
  readonly result: SubmitResult;
}

const idParams = (): Array<[string, string]> => [
  ['changesetID', CHANGESET_ID],
  ['siteID', 'default'],
];

const ROLLBACK: ActionCase = {
  action: 'rollback',
  submit: changesetRollbackScreen.submit,
  path: ROLLBACK_PATH,
  operation: 'rollbackChangeset',
  rc: { changesetID: CHANGESET_ID },
  written: { circuit: 'cChangesets', action: 'edit', params: idParams() },
  result: EDIT_REDIRECT,
};

const ACTIONS: readonly ActionCase[] = [
  ROLLBACK,
  {
    action: 'delete',
    submit: changesetDeleteScreen.submit,
    path: DELETE_PATH,
    operation: 'deleteChangeset',
    rc: { changesetID: CHANGESET_ID },
    written: { circuit: 'cChangesets', action: 'list', params: idParams() },
    result: LIST_REDIRECT,
  },
  {
    action: 'removeitem',
    submit: changesetRemoveItemScreen.submit,
    path: REMOVE_PATH,
    operation: 'removeChangesetItem',
    rc: { changesetID: CHANGESET_ID, contentHistID: CONTENTHIST_ID, keywords: '' },
    written: { circuit: 'cChangesets', action: 'assignments', params: [...idParams(), ['keywords', '']] },
    result: {
      kind: 'redirect',
      action: 'cChangesets.assignments',
      path: './',
      queryString: `changesetID=${CHANGESET_ID}&siteID=default&keywords=`,
    },
  },
];

/** The owner's 200 `AdminWriteResult`. */
const writeResult = (saved: boolean, redirect: WriteRedirect): FakeReply => ({
  status: 200,
  body: { saved, errors: {}, redirect },
});

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

const requestFor = (action: string, rc: Fields): AdminRequest =>
  adminS2Request({ circuit: 'cChangesets', item: action, rc });

/** Every rc field, as the owner receives the relayed form. */
const formOf = (req: AdminRequest): Record<string, string> => Object.fromEntries(Object.entries(req.rc));

/** `req` without the rc fields named in `names`. */
function withoutRc(req: AdminRequest, ...names: readonly string[]): AdminRequest {
  const dropped = new Set(names.map((name) => name.toLowerCase()));
  const rc = Object.fromEntries(Object.entries(req.rc).filter(([name]) => !dropped.has(name.toLowerCase())));
  return { ...req, rc };
}

describe.each(ACTIONS)('cChangesets.$action', (c) => {
  const route = routeKey('POST', 'strategies-content', c.path);
  const tokenRequest = (): AdminRequest => requestFor(c.action, { ...c.rc, ...CSRF });

  it('posts every rc field with a valid token, then redirects as legacy', async () => {
    const gateway = fakeGatewayClient({ [route]: writeResult(true, c.written) });
    const req = tokenRequest();

    await expect(c.submit(contextFor(req, gateway))).resolves.toEqual(c.result);
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'POST', path: c.path, form: formOf(req) }]);
    expect(gateway.calls[0]?.form).toMatchObject({ ...c.rc, ...CSRF, siteid: 'default' });
  });

  it.each<{ token: string; csrf: Fields }>([
    { token: 'a stale token', csrf: STALE_CSRF },
    { token: 'no token', csrf: {} },
  ])('relays $token and still redirects when the owner skips the write', async ({ csrf }) => {
    const gateway = fakeGatewayClient({ [route]: writeResult(false, c.written) });
    const req = requestFor(c.action, { ...c.rc, ...csrf });

    await expect(c.submit(contextFor(req, gateway))).resolves.toEqual(c.result);
    expect(gateway.calls).toEqual([{ service: 'strategies-content', method: 'POST', path: c.path, form: formOf(req) }]);
  });

  it('errors before any call without rc.changesetid, as legacy does', async () => {
    const gateway = fakeGatewayClient({ [route]: writeResult(true, c.written) });

    await expect(c.submit(contextFor(withoutRc(tokenRequest(), 'changesetid'), gateway))).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(gateway.calls).toEqual([]);
  });

  it("passes the owner's Location through", async () => {
    const location = './?muraAction=cLogin.main&returnURL=x';
    const gateway = fakeGatewayClient({ [route]: { status: 302, headers: { location } } });

    await expect(c.submit(contextFor(tokenRequest(), gateway))).resolves.toEqual({ kind: 'location', location });
  });

  it.each([401, 403] as const)('raises GatewayDenialError on %i', async (status) => {
    const gateway = fakeGatewayClient({ [route]: { status, body: { error: 'denied' } } });

    const failure = c.submit(contextFor(tokenRequest(), gateway));
    await expect(failure).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(failure).rejects.toMatchObject({ service: 'strategies-content', operation: c.operation, status });
  });

  it('raises on a 500 from the owner', async () => {
    const gateway = fakeGatewayClient({ [route]: { status: 500, body: { error: 'boom' } } });

    await expect(c.submit(contextFor(tokenRequest(), gateway))).rejects.toThrow(`${c.operation} answered HTTP 500`);
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    ...[502, 503, 504].map((status) => ({
      outage: `a ${status} answer`,
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(route, { status, body: {} }),
    })),
  ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    await expect(c.submit(contextFor(tokenRequest(), gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('cChangesets.rollback', () => {
  it.each<{ answer: string; reply: FakeReply }>([
    { answer: '400', reply: { status: 400, body: { error: 'badRequest' } } },
    { answer: '404', reply: { status: 404, body: { error: 'notFound' } } },
  ])('redirects to edit on a $answer, as legacy does whether or not it ran', async ({ reply }) => {
    const gateway = fakeGatewayClient({ [routeKey('POST', 'strategies-content', ROLLBACK_PATH)]: reply });
    const req = requestFor('rollback', { ...ROLLBACK.rc, ...CSRF });

    await expect(ROLLBACK.submit(contextFor(req, gateway))).resolves.toEqual(EDIT_REDIRECT);
  });
});

describe('cChangesets.removeitem', () => {
  const route = routeKey('POST', 'strategies-content', REMOVE_PATH);
  const rc: Fields = { changesetID: CHANGESET_ID, contentHistID: CONTENTHIST_ID, keywords: 'a b&c', ...CSRF };
  // FW/1 redirect(action="cChangesets.assignments", append="changesetID,siteID,keywords", path="./") over that rc.
  const LEGACY_LOCATION =
    `./?muraAction=cChangesets.assignments&changesetID=${CHANGESET_ID}&siteID=default&keywords=a+b%26c`;

  it('keeps the declared redirect when the owner names none', async () => {
    const gateway = fakeGatewayClient({ [route]: writeResult(true, null) });

    await expect(changesetRemoveItemScreen.submit(contextFor(requestFor('removeitem', rc), gateway))).resolves.toEqual(
      ASSIGNMENTS_REDIRECT,
    );
    const append: Array<[string, string]> = [...idParams(), ['keywords', 'a b&c']];
    expect(fw1RedirectTarget({ action: 'cChangesets.assignments', append, path: './' })).toBe(LEGACY_LOCATION);
  });

  it("turns the owner's redirect into legacy's Location", async () => {
    const params: Array<[string, string]> = [...idParams(), ['keywords', 'a b&c']];
    const gateway = fakeGatewayClient({
      [route]: writeResult(true, { circuit: 'cChangesets', action: 'assignments', params }),
    });

    const result = await changesetRemoveItemScreen.submit(contextFor(requestFor('removeitem', rc), gateway));

    expect(result).toEqual({
      kind: 'redirect',
      action: 'cChangesets.assignments',
      path: './',
      queryString: `changesetID=${CHANGESET_ID}&siteID=default&keywords=a+b%26c`,
    });
    if (result.kind !== 'redirect') throw new TypeError('Expected an FW/1 redirect');
    expect(fw1RedirectTarget({ action: result.action, queryString: result.queryString, path: result.path })).toBe(
      LEGACY_LOCATION,
    );
  });
});
