// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
// The timesheets sheet detail over the timesheets fixtures: DOM snapshot, per-role day actions, CSRF, roles, errors.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { Opt2ScreenDefinition } from '@/screens/registry';
import { timesheetsScreens } from '@/screens/opt2/timesheets';
import { loadSheet, sheetBody } from '@/screens/opt2/timesheets/sheet';
import { TIMESHEETS_AS_OF, TIMESHEET_IDS, timesheetsAnswersByRole } from '../../../fixtures/opt2/timesheets';
import { makeAdminRequest, opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel, type DomControl, type DomModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeRouteTable,
} from '../../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type RoleKey = keyof typeof timesheetsAnswersByRole;

const SITE = 'tenant-a';
const SHEET_ROUTE = routeKey('GET', 'timesheets', `/v1/timesheets/sheets/${TIMESHEET_IDS.sheetReturned}`);
const ACTION_URL = `/opt2/admin-actions/timesheets/day-action?siteid=${SITE}&asOf=${TIMESHEETS_AS_OF}`;
const LIST_URL = `/opt2/admin/timesheets/sheets?siteid=${SITE}&asOf=${TIMESHEETS_AS_OF}`;

const ROLE_OF: Readonly<Record<RoleKey, Role>> = {
  employee: Roles.timesheetsEmployee,
  primaryApprover: Roles.timesheetsPrimaryApprover,
  secondaryApprover: Roles.timesheetsSecondaryApprover,
};

function sheetScreen(): Opt2ScreenDefinition {
  const def = timesheetsScreens.find(({ screen }) => screen === 'sheet');
  if (def === undefined) throw new TypeError('timesheets/sheet is not registered');
  return def;
}

const sheetRequest = (role: Role): AdminRequest =>
  opt2RoleRequest(role, { rc: { siteid: SITE, timesheetid: TIMESHEET_IDS.sheetReturned, asOf: TIMESHEETS_AS_OF } });

const hidden = (name: string, value: string): DomControl => ({
  tag: 'input',
  name,
  type: 'hidden',
  value,
  checked: false,
  selected: [],
  options: [],
});

/** The hidden fields of one day action form. */
const formControls = (dayId: string, action: string): DomControl[] => [
  hidden('timesheetid', TIMESHEET_IDS.sheetReturned),
  hidden('dayid', dayId),
  hidden('dayaction', action),
  hidden('csrf_token', FIXED_CSRF.token),
  hidden('csrf_token_expires', FIXED_CSRF.expires),
];

/** Days of the returned sheet as rendered rows, with `actions` as each day's action cell text. */
const dayRows = (actions: Readonly<Record<string, string>>): string[][] =>
  [
    ['2026-06-22', '8.0000', 'DRAFT', 'No', TIMESHEET_IDS.dayDraft],
    ['2026-06-23', '8.0000', 'SUBMITTED', 'No', TIMESHEET_IDS.daySubmitted],
    ['2026-06-24', '7.5000', 'RESUBMITTED', 'No', TIMESHEET_IDS.dayResubmitted],
    ['2026-06-25', '8.0000', 'PRIMARY_APPROVED', 'No', TIMESHEET_IDS.dayPrimaryApproved],
    ['2026-06-26', '6.0000', 'APPROVED', 'No', TIMESHEET_IDS.dayApproved],
    ['2026-06-27', '4.0000', 'RETURNED', 'No', TIMESHEET_IDS.dayReturned],
    ['2026-06-28', '0.0000', 'DRAFT', 'Yes', TIMESHEET_IDS.dayBlackout],
  ].map(([date = '', hours = '', state = '', blackout = '', dayId = '']) => [
    date,
    hours,
    state,
    blackout,
    actions[dayId] ?? '',
  ]);

/** Each role's day actions on the returned sheet, as the fixture's `allowedActions` give them. */
const ROLE_CASES: ReadonlyArray<{ role: RoleKey; forms: ReadonlyArray<readonly [string, string, string]> }> = [
  {
    role: 'employee',
    forms: [
      [TIMESHEET_IDS.dayDraft, 'submit', 'Submit'],
      [TIMESHEET_IDS.dayReturned, 'resubmit', 'Resubmit'],
    ],
  },
  {
    role: 'primaryApprover',
    forms: [
      [TIMESHEET_IDS.daySubmitted, 'primary-approve', 'Primary Approve'],
      [TIMESHEET_IDS.daySubmitted, 'return', 'Return'],
      [TIMESHEET_IDS.dayResubmitted, 'primary-approve', 'Primary Approve'],
      [TIMESHEET_IDS.dayResubmitted, 'return', 'Return'],
    ],
  },
  {
    role: 'secondaryApprover',
    forms: [
      [TIMESHEET_IDS.dayPrimaryApproved, 'secondary-approve', 'Secondary Approve'],
      [TIMESHEET_IDS.dayPrimaryApproved, 'return', 'Return'],
    ],
  },
];

/** The model a role's sheet detail renders: summary, days and one post form per allowed day action. */
function expectedModel(forms: ReadonlyArray<readonly [string, string, string]>): DomModel {
  const actions: Record<string, string> = {};
  for (const [dayId, , label] of forms) {
    actions[dayId] = actions[dayId] === undefined ? label : `${actions[dayId]} ${label}`;
  }
  return {
    title: '',
    headings: ['Timesheet'],
    labels: [],
    controls: forms.flatMap(([dayId, action]) => formControls(dayId, action)),
    buttons: forms.map(([, , label]) => ({ text: label, type: 'submit', hasOnclick: false })),
    links: [{ href: LIST_URL, text: 'Timesheets' }],
    tables: [
      {
        headers: ['Person', 'Period', 'Due Date', 'Status', 'Overdue'],
        rows: [[TIMESHEET_IDS.employee, '2026-06-22 - 2026-06-28', '2026-07-03', 'RETURNED', 'No']],
      },
      { headers: ['Work Date', 'Hours', 'State', 'Blackout', 'Actions'], rows: dayRows(actions) },
    ],
    alerts: [],
  };
}

async function renderBody(role: Role, routes: FakeRouteTable): Promise<{ markup: string; gateway: FakeGatewayClient }> {
  const gateway = fakeGatewayClient(routes);
  const ctx = makeScreenContext({ req: sheetRequest(role), gateway });
  return { markup: toString(sheetBody(ctx, await loadSheet(ctx))), gateway };
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('timesheets sheet detail', () => {
  it.each(ROLE_CASES)('offers $role exactly the day actions timesheets allows (DOM snapshot)', async (roleCase) => {
    const { role, forms } = roleCase;
    const { markup, gateway } = await renderBody(ROLE_OF[role], timesheetsAnswersByRole[role]);

    expect(fragmentModel(markup)).toEqual(expectedModel(forms));
    const $ = cheerio.load(markup, null, false);
    expect($('form').toArray().map((form) => [$(form).attr('method'), $(form).attr('action')])).toEqual(
      forms.map(() => ['post', ACTION_URL]),
    );
    expect(gateway.calls.filter(({ service }) => service === 'timesheets')).toEqual([
      {
        service: 'timesheets',
        method: 'GET',
        path: `/v1/timesheets/sheets/${TIMESHEET_IDS.sheetReturned}`,
        query: { asOf: TIMESHEETS_AS_OF },
      },
    ]);
    // One identity call for the days with an action, each form carrying the pair of its own day id.
    const csrfCalls = gateway.calls.filter(({ service, path }) => service === 'identity' && path === '/v1/csrf/tokens');
    expect(csrfCalls.map(({ json }) => json)).toEqual([{ contexts: [...new Set(forms.map(([dayId]) => dayId))] }]);
  });

  it('asks identity for no CSRF pair when the caller may act on no day', async () => {
    const detail = timesheetsAnswersByRole.employee[SHEET_ROUTE];
    if (detail === undefined || typeof detail === 'function') throw new TypeError('fixture detail route missing');
    const body = detail.body as { days: Array<{ allowedActions: string[] }> };
    const noActions = { ...body, days: body.days.map((day) => ({ ...day, allowedActions: [] })) };

    const { markup, gateway } = await renderBody(Roles.timesheetsEmployee, {
      [SHEET_ROUTE]: { status: 200, body: noActions },
    });

    expect(fragmentModel(markup).buttons).toEqual([]);
    expect(gateway.calls.some(({ service, path }) => service === 'identity' && path === '/v1/csrf/tokens')).toBe(false);
  });

  it('renders inside the shell with the OPT-2 timesheets entry active', async () => {
    const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);

    const ctx = makeScreenContext({ req: sheetRequest(Roles.timesheetsEmployee), gateway });

    const page = await renderScreenPage(sheetScreen(), ctx);

    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
    expect(page.html).toContain('<div class="mura-header"><h1>Timesheet</h1>');
    expect(page.html).toMatch(/<a class="active" href="\/opt2\/admin\/timesheets\/sheets\?siteid=tenant-a">/);
  });

  it.each([
    { who: 'a user without a timesheets role', req: () => makeAdminRequest({}, 'systemUser') },
    { who: 'an S2 admin without a timesheets role', req: () => makeAdminRequest({}, 'admin') },
  ])('sends $who to cMessage.noaccess without calling timesheets', async ({ req }) => {
    const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);

    const page = await renderScreenPage(sheetScreen(), makeScreenContext({ req: req(), gateway }));

    expect(page).toEqual({ kind: 'redirect', location: '/admin/?muraAction=cMessage.noaccess' });
    expect(gateway.calls.filter(({ service }) => service === 'timesheets')).toEqual([]);
  });

  it('answers a timesheets 403 with cMessage.noaccess and fails on a sheet outside the tenant', async () => {
    const denied = fakeGatewayClient({ [SHEET_ROUTE]: { status: 403, body: { error: { code: 'authorization' } } } });
    const missing = fakeGatewayClient({ [SHEET_ROUTE]: { status: 404, body: { error: { message: 'Not Found' } } } });

    const page = await renderScreenPage(
      sheetScreen(),
      makeScreenContext({ req: sheetRequest(Roles.timesheetsEmployee), gateway: denied }),
    );

    expect(page).toEqual({ kind: 'redirect', location: '/admin/?muraAction=cMessage.noaccess' });
    await expect(
      loadSheet(makeScreenContext({ req: sheetRequest(Roles.timesheetsEmployee), gateway: missing })),
    ).rejects.toThrow('getSheet answered HTTP 404');
  });
});
