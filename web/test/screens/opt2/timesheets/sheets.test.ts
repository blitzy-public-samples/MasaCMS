// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
// The timesheets sheet list inside the shell over the timesheets fixtures: DOM snapshot, service calls, roles, errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { Opt2ScreenDefinition } from '@/screens/registry';
import { timesheetsScreens } from '@/screens/opt2/timesheets';
import { SHEETS_PER_PAGE, loadSheets, sheetsBody } from '@/screens/opt2/timesheets/sheets';
import {
  TIMESHEETS_AS_OF,
  TIMESHEET_IDS,
  timesheetSheets,
  timesheetsAnswersByRole,
} from '../../../fixtures/opt2/timesheets';
import { makeAdminRequest, opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRoute } from '../../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SHEETS_ROUTE = routeKey('GET', 'timesheets', '/v1/timesheets/sheets');
const SITE = 'tenant-a';
const NOACCESS = '/admin/?muraAction=cMessage.noaccess';

function sheetsScreen(): Opt2ScreenDefinition {
  const def = timesheetsScreens.find(({ screen }) => screen === 'sheets');
  if (def === undefined) throw new TypeError('timesheets/sheets is not registered');
  return def;
}

const employeeRequest = (rc: Record<string, string> = {}): AdminRequest =>
  opt2RoleRequest(Roles.timesheetsEmployee, { rc: { siteid: SITE, ...rc } });

/** The timesheets calls the gateway received, as `METHOD path` with their query. */
const timesheetsCalls = (gateway: FakeGatewayClient) =>
  gateway.calls
    .filter(({ service }) => service === 'timesheets')
    .map(({ method, path, query }) => ({ method, path, query }));

const sheetHref = (id: string): string =>
  `/opt2/admin/timesheets/sheet?siteid=${SITE}&asOf=${TIMESHEETS_AS_OF}&timesheetid=${id}`;

/** A list answer of `total` sheets holding the fixture rows. */
const listOf = (total: number): FakeRoute => ({ status: 200, body: { items: timesheetSheets, total } });

/** The screen body's model for `req` over `gateway`. */
async function bodyModel(req: AdminRequest, gateway: FakeGatewayClient): Promise<DomModel> {
  const ctx = makeScreenContext({ req, gateway });
  return fragmentModel(toString(sheetsBody(ctx, await loadSheets(ctx))));
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('timesheets sheet list', () => {
  it('renders the status and overdue flag of every sheet as of asOf (DOM snapshot)', async () => {
    const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);

    const model = await bodyModel(employeeRequest({ asOf: TIMESHEETS_AS_OF }), gateway);

    expect(model).toEqual<DomModel>({
      title: '',
      headings: ['Timesheets'],
      labels: [],
      controls: [],
      buttons: [],
      links: [
        { href: sheetHref(TIMESHEET_IDS.sheetApproved), text: '2026-06-08 - 2026-06-14' },
        { href: sheetHref(TIMESHEET_IDS.sheetDraft), text: '2026-06-15 - 2026-06-21' },
        { href: sheetHref(TIMESHEET_IDS.sheetReturned), text: '2026-06-22 - 2026-06-28' },
        { href: sheetHref(TIMESHEET_IDS.sheetSubmitted), text: '2026-06-22 - 2026-06-28' },
        { href: sheetHref(TIMESHEET_IDS.sheetPartiallyApproved), text: '2026-06-22 - 2026-06-28' },
      ],
      tables: [
        {
          headers: ['Period', 'Person', 'Due Date', 'Status', 'Overdue'],
          rows: [
            ['2026-06-08 - 2026-06-14', TIMESHEET_IDS.employee, '2026-06-19', 'APPROVED', 'No'],
            ['2026-06-15 - 2026-06-21', TIMESHEET_IDS.employee, '2026-06-26', 'DRAFT', 'Yes'],
            ['2026-06-22 - 2026-06-28', TIMESHEET_IDS.employee, '2026-07-03', 'RETURNED', 'No'],
            ['2026-06-22 - 2026-06-28', TIMESHEET_IDS.secondEmployee, '2026-07-03', 'SUBMITTED', 'No'],
            ['2026-06-22 - 2026-06-28', TIMESHEET_IDS.thirdEmployee, '2026-07-03', 'PARTIALLY_APPROVED', 'No'],
          ],
        },
      ],
      alerts: [],
    });
    expect(timesheetsCalls(gateway)).toEqual([
      {
        method: 'GET',
        path: '/v1/timesheets/sheets',
        query: { asOf: TIMESHEETS_AS_OF, pageIndex: '1', itemsPerPage: String(SHEETS_PER_PAGE) },
      },
    ]);
  });

  it('renders inside the shell with the OPT-2 timesheets entry active, from legacy admin classes only', async () => {
    const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);
    const ctx = makeScreenContext({ req: employeeRequest(), gateway });

    const page = await renderScreenPage(sheetsScreen(), ctx);

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    expect(page.html).toContain('<div class="mura-header"><h1>Timesheets</h1></div>');
    expect(page.html).toContain('<table class="mura-table-grid">');
    expect(page.html).toMatch(/<a class="active" href="\/opt2\/admin\/timesheets\/sheets\?siteid=tenant-a">/);
  });

  it('leaves asOf to the service when the request has none', async () => {
    const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);

    const model = await bodyModel(employeeRequest(), gateway);

    expect(timesheetsCalls(gateway)[0]?.query).toEqual({ pageIndex: '1', itemsPerPage: String(SHEETS_PER_PAGE) });
    expect(model.links[0]?.href).toBe(
      `/opt2/admin/timesheets/sheet?siteid=${SITE}&timesheetid=${TIMESHEET_IDS.sheetApproved}`,
    );
  });

  it.each([
    { pageIndex: '3', sent: '3' },
    { pageIndex: '0', sent: '1' },
    { pageIndex: '-2', sent: '1' },
    { pageIndex: '1.5', sent: '1' },
    { pageIndex: 'x', sent: '1' },
  ])('asks for page $sent when pageIndex is $pageIndex', async ({ pageIndex, sent }) => {
    const gateway = fakeGatewayClient({ [SHEETS_ROUTE]: listOf(500) });

    await bodyModel(employeeRequest({ pageIndex }), gateway);

    expect(timesheetsCalls(gateway)[0]?.query?.pageIndex).toBe(sent);
  });

  it.each([
    { pageIndex: '1', total: 120, page: 'Page 1 of 3', links: [['Next', '2']] },
    { pageIndex: '2', total: 120, page: 'Page 2 of 3', links: [['Previous', '1'], ['Next', '3']] },
    { pageIndex: '3', total: 101, page: 'Page 3 of 3', links: [['Previous', '2']] },
  ])('pages through $total sheets from page $pageIndex', async ({ pageIndex, total, page, links }) => {
    const gateway = fakeGatewayClient({ [SHEETS_ROUTE]: listOf(total) });
    const ctx = makeScreenContext({ req: employeeRequest({ pageIndex }), gateway });

    const markup = toString(sheetsBody(ctx, await loadSheets(ctx)));
    const model = fragmentModel(markup);

    expect(markup).toContain(`<li class="active"><span>${page}</span></li>`);
    expect(model.links.slice(timesheetSheets.length)).toEqual(
      links.map(([text, index]) => ({ href: `/opt2/admin/timesheets/sheets?siteid=${SITE}&pageIndex=${index}`, text })),
    );
  });

  it('shows no pager when every sheet fits on one page, and the empty message without sheets', async () => {
    const full = fakeGatewayClient({ [SHEETS_ROUTE]: listOf(SHEETS_PER_PAGE) });
    const empty = fakeGatewayClient({ [SHEETS_ROUTE]: { status: 200, body: { items: [], total: 0 } } });
    const fullCtx = makeScreenContext({ req: employeeRequest(), gateway: full });
    const emptyCtx = makeScreenContext({ req: employeeRequest(), gateway: empty });

    expect(toString(sheetsBody(fullCtx, await loadSheets(fullCtx)))).not.toContain('pagination');
    expect(toString(sheetsBody(emptyCtx, await loadSheets(emptyCtx)))).toBe(
      '<div class="mura-header"><h1>Timesheets</h1></div>' +
        '<div class="block block-constrain"><div class="block block-bordered"><div class="block-content">' +
        '<div class="help-block-empty">No timesheets.</div></div></div></div>',
    );
  });

  it('encodes service values as text', async () => {
    const hostile = { ...timesheetSheets[0], personId: '<script>alert(1)</script>' };
    const gateway = fakeGatewayClient({ [SHEETS_ROUTE]: { status: 200, body: { items: [hostile], total: 1 } } });
    const ctx = makeScreenContext({ req: employeeRequest(), gateway });

    const markup = toString(sheetsBody(ctx, await loadSheets(ctx)));

    expect(markup).not.toContain('<script>');
    expect(fragmentModel(markup).tables[0]?.rows[0]?.[1]).toBe('<script>alert(1)</script>');
  });

  it.each<Role>([Roles.timesheetsEmployee, Roles.timesheetsPrimaryApprover, Roles.timesheetsSecondaryApprover])(
    'serves %s',
    async (role) => {
      const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);
      const ctx = makeScreenContext({ req: opt2RoleRequest(role), gateway });

      expect((await renderScreenPage(sheetsScreen(), ctx)).kind).toBe('document');
      expect(timesheetsCalls(gateway).map(({ path }) => path)).toEqual(['/v1/timesheets/sheets']);
    },
  );

  it.each([
    { who: 'a user without a timesheets role', req: () => makeAdminRequest({}, 'systemUser'), to: NOACCESS },
    { who: 'an S2 admin without a timesheets role', req: () => makeAdminRequest({}, 'admin'), to: NOACCESS },
    {
      who: 'an anonymous user',
      req: () => makeAdminRequest({}, 'anonymous'),
      to: expect.stringContaining('cLogin.main'),
    },
  ])('sends $who away without calling timesheets', async ({ req, to }) => {
    const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);

    const page = await renderScreenPage(sheetsScreen(), makeScreenContext({ req: req(), gateway }));

    expect(page).toEqual({ kind: 'redirect', location: to });
    expect(timesheetsCalls(gateway)).toEqual([]);
  });

  it.each([
    { status: 403, to: NOACCESS },
    { status: 401, to: '/admin/?muraAction=clogin.logout' },
  ])('answers a timesheets $status with the access gate redirect', async ({ status, to }) => {
    const gateway = fakeGatewayClient({ [SHEETS_ROUTE]: { status, body: { error: { code: 'authorization' } } } });

    const page = await renderScreenPage(sheetsScreen(), makeScreenContext({ req: employeeRequest(), gateway }));

    expect(page).toEqual({ kind: 'redirect', location: to });
  });

  it('fails closed when timesheets is unavailable, and fails on any other error status', async () => {
    const down = fakeGatewayClient({ [SHEETS_ROUTE]: { status: 503, body: 'down' } });
    const invalid = fakeGatewayClient({
      [SHEETS_ROUTE]: { status: 400, body: { error: { code: 'invalid_request' } } },
    });

    await expect(loadSheets(makeScreenContext({ req: employeeRequest(), gateway: down }))).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
    await expect(loadSheets(makeScreenContext({ req: employeeRequest(), gateway: invalid }))).rejects.toThrow(
      'listSheets answered HTTP 400',
    );
  });
});
