// The App Router adapters of the admin and synthetic-module trees: segment config and delegation to their handler.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { handleAdminAction, handleAdminPage, handleAdminRaw, handleOpt2Action, handleOpt2Page } from '@/lib/handlers';
import * as adminPage from '../../app/admin/[circuit]/[action]/route';
import * as adminActions from '../../app/admin-actions/[circuit]/[action]/route';
import * as adminRaw from '../../app/admin-raw/[circuit]/[action]/route';
import * as opt2Page from '../../app/opt2/admin/[module]/[screen]/route';
import * as opt2Actions from '../../app/opt2/admin-actions/[module]/[action]/route';
import { WEB_TEST_ORIGIN, routeParams } from '../helpers/requests';

vi.mock('@/lib/handlers', () => ({
  handleAdminAction: vi.fn(),
  handleAdminPage: vi.fn(),
  handleAdminRaw: vi.fn(),
  handleOpt2Action: vi.fn(),
  handleOpt2Page: vi.fn(),
}));

const actionHandler = vi.mocked(handleAdminAction);
const pageHandler = vi.mocked(handleAdminPage);
const rawHandler = vi.mocked(handleAdminRaw);
const opt2Handler = vi.mocked(handleOpt2Action);
const opt2PageHandler = vi.mocked(handleOpt2Page);

/** HTTP methods an App Router route module may export as handlers. */
const ROUTE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  { tree: 'admin-actions', route: adminActions, handler: actionHandler, other: rawHandler },
  { tree: 'admin-raw', route: adminRaw, handler: rawHandler, other: actionHandler },
])('$tree route', ({ tree, route, handler, other }) => {
  it('renders dynamically on the Node.js runtime', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });

  it.each(['GET', 'POST'] as const)(
    '%s returns the handler response for the request and awaited params',
    async (method) => {
      const request = new Request(`${WEB_TEST_ORIGIN}/${tree}/cusers/update`, { method });
      const params = { circuit: 'cusers', action: 'update' };
      const response = new Response('legacy body', { status: 302 });
      handler.mockResolvedValueOnce(response);

      await expect(route[method](request, routeParams(params))).resolves.toBe(response);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toBe(request);
      expect(handler.mock.calls[0]?.[1]).toBe(params);
      expect(other).not.toHaveBeenCalled();
    },
  );
});

describe('opt2/admin-actions route', () => {
  it('renders dynamically on the Node.js runtime', () => {
    expect(opt2Actions.dynamic).toBe('force-dynamic');
    expect(opt2Actions.runtime).toBe('nodejs');
  });

  it('exports every route method, so Next answers none of them itself', () => {
    expect(ROUTE_METHODS.filter((method) => method in opt2Actions)).toEqual([...ROUTE_METHODS]);
  });

  it.each([
    { method: 'GET', body: LEGACY_ERROR_PAGE_HTML },
    { method: 'PUT', body: LEGACY_ERROR_PAGE_HTML },
    { method: 'PATCH', body: LEGACY_ERROR_PAGE_HTML },
    { method: 'DELETE', body: LEGACY_ERROR_PAGE_HTML },
    { method: 'OPTIONS', body: LEGACY_ERROR_PAGE_HTML },
    { method: 'HEAD', body: null },
  ] as const)(
    '$method answers 405 with Allow: POST and the legacy error page without running an action',
    async ({ method, body }) => {
      const request = new Request(`${WEB_TEST_ORIGIN}/opt2/admin-actions/finance/submit?siteid=tenant-a`, { method });

      const response = await opt2Actions[method](request);

      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('generator')).toBe('Masa CMS 7.6.1');
      expect(response.headers.get('strict-transport-security')).toBe('max-age=1200');
      expect(response.headers.get('content-type')).toBe('text/html;charset=UTF-8');
      expect(response.body === null ? null : await response.text()).toBe(body);
      expect(opt2Handler).not.toHaveBeenCalled();
    },
  );

  it('POST returns handleOpt2Action response for the request and awaited params', async () => {
    const request = new Request(`${WEB_TEST_ORIGIN}/opt2/admin-actions/communications/send`, { method: 'POST' });
    const params = { module: 'communications', action: 'send' };
    const response = new Response(null, { status: 302 });
    opt2Handler.mockResolvedValueOnce(response);

    await expect(opt2Actions.POST(request, routeParams(params))).resolves.toBe(response);
    expect(opt2Handler.mock.calls).toEqual([[request, params]]);
    expect(actionHandler).not.toHaveBeenCalled();
  });
});

const PAGE_PARAMS = { circuit: 'cusers', action: 'list' };
const OPT2_PARAMS = { module: 'timesheets', screen: 'sheets' };

describe.each([
  {
    path: '/admin/cusers/list',
    route: adminPage,
    handler: pageHandler,
    params: PAGE_PARAMS,
    methods: ['GET', 'POST'] as const,
    call: (method: 'GET' | 'POST', request: Request) => adminPage[method](request, routeParams(PAGE_PARAMS)),
  },
  {
    path: '/opt2/admin/timesheets/sheets',
    route: opt2Page,
    handler: opt2PageHandler,
    params: OPT2_PARAMS,
    methods: ['GET'] as const,
    call: (_method: 'GET' | 'POST', request: Request) => opt2Page.GET(request, routeParams(OPT2_PARAMS)),
  },
])('$path page route', ({ path, route, handler, params, methods, call }) => {
  it(`renders dynamically on the Node.js runtime and serves ${methods.join(' and ')} only`, () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
    expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name))).toEqual([...methods]);
  });

  it.each(methods)('%s returns the handler response for the request and awaited params', async (method) => {
    const request = new Request(`${WEB_TEST_ORIGIN}${path}`, { method });
    const response = new Response('legacy document', { status: 200 });
    handler.mockResolvedValueOnce(response);

    await expect(call(method, request)).resolves.toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe(request);
    expect(handler.mock.calls[0]?.[1]).toBe(params);
    const others = [actionHandler, rawHandler, pageHandler, opt2PageHandler, opt2Handler];
    for (const other of others.filter((h) => h !== handler)) {
      expect(other).not.toHaveBeenCalled();
    }
  });
});
