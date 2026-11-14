// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { load } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { secure } from '@/lib/access-gate';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '@/screens/registry';
import { canUse, noAccessUrl, OPT2_LABEL_KEYS, type Opt2LabelName } from '@/screens/opt2/shared';
import { timesheetsActions, timesheetsScreens } from '@/screens/opt2/timesheets';
import { SHEETS_PER_PAGE } from '@/screens/opt2/timesheets/sheets';
import { loadShellData, renderAdminDocument, serializeAdminDocument } from '@/shell/document';
import {
  TIMESHEETS_AS_OF,
  TIMESHEET_IDS,
  timesheetDetailByRole,
  timesheetSheets,
  timesheetsAnswersByRole,
} from '../../fixtures/opt2/timesheets';
import { opt2RoleRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeRouteTable } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SITE = 'tenant-a';
const SHEETS_ROUTE = routeKey('GET', 'timesheets', '/v1/timesheets/sheets');
const LANDING = `/opt2/admin/timesheets/sheets?siteid=${SITE}`;

const LEGACY_CLASS_NAMES: ReadonlySet<string> = new Set([
  'mura-header',
  'nav-module-specific',
  'mura-table-grid',
  'btn',
  'alert',
  'var-width',
  'help-block-empty',
  'mura-control-group',
  'mura-primary',
  'mura-actions',
  'form-actions',
  'pagination',
  'active',
]);
const LEGACY_CLASS_PATTERNS: readonly RegExp[] = [/^block(-|$)/, /^btn-/, /^alert-/];

const isLegacyClass = (name: string): boolean =>
  LEGACY_CLASS_NAMES.has(name) || LEGACY_CLASS_PATTERNS.some((pattern) => pattern.test(name));

/** Class tokens of `#mura-content` and its descendants, leaving the shell's own classes out. */
function moduleClasses(page: string): string[] {
  const $ = load(page);
  return $('#mura-content')
    .find('*')
    .addBack()
    .toArray()
    .flatMap((element) => ($(element).attr('class') ?? '').split(/\s+/))
    .filter((name) => name !== '');
}

function screen(name: string): Opt2ScreenDefinition {
  const def = timesheetsScreens.find((candidate) => candidate.screen === name);
  if (def === undefined) throw new TypeError(`timesheets/${name} is not registered`);
  return def;
}

function dayAction(): Opt2ActionDefinition {
  const def = timesheetsActions.find(({ action }) => action === 'day-action');
  if (def === undefined) throw new TypeError('timesheets/day-action is not registered');
  return def;
}

const requestAs = (role: Role, rc: Record<string, string> = {}): AdminRequest =>
  opt2RoleRequest(role, { rc: { siteid: SITE, asOf: TIMESHEETS_AS_OF, ...rc } });

async function screenPage(name: string, req: AdminRequest, routes: FakeRouteTable): Promise<string> {
  const page = await renderScreenPage(screen(name), makeScreenContext({ req, gateway: fakeGatewayClient(routes) }));
  if (page.kind !== 'document') throw new Error(`timesheets/${name} redirected to ${page.location}`);
  return page.html;
}

/** The page the handlers answer for a re-rendered day action: its view inside the shell. */
async function rejectedActionPage(req: AdminRequest, routes: FakeRouteTable): Promise<string> {
  const ctx = makeScreenContext({ req, gateway: fakeGatewayClient(routes) });
  const result = await dayAction().submit(ctx);
  if (result.kind !== 'render') throw new Error(`expected a re-render, got ${result.kind}`);
  const shell = await loadShellData(ctx.req, { gateway: ctx.gateway, csrf: ctx.csrf, rb: ctx.rb, now: ctx.now });
  return serializeAdminDocument(renderAdminDocument(ctx.req, result.view, ctx.hooks, shell));
}

const listOf = (items: typeof timesheetSheets, total: number): FakeRouteTable => ({
  [SHEETS_ROUTE]: { status: 200, body: { items, total } },
});

const PAGES: ReadonlyArray<{ name: string; heading: string; render: () => Promise<string> }> = [
  {
    name: 'sheet list',
    heading: 'Timesheets',
    render: () => screenPage('sheets', requestAs(Roles.timesheetsEmployee), timesheetsAnswersByRole.employee),
  },
  {
    name: 'paged sheet list',
    heading: 'Timesheets',
    render: () =>
      screenPage(
        'sheets',
        requestAs(Roles.timesheetsEmployee, { pageIndex: '2' }),
        listOf(timesheetSheets, SHEETS_PER_PAGE * 3),
      ),
  },
  {
    name: 'empty sheet list',
    heading: 'Timesheets',
    render: () => screenPage('sheets', requestAs(Roles.timesheetsSecondaryApprover), listOf([], 0)),
  },
  {
    name: 'sheet detail',
    heading: 'Timesheet',
    render: () =>
      screenPage(
        'sheet',
        requestAs(Roles.timesheetsPrimaryApprover, { timesheetid: TIMESHEET_IDS.sheetReturned }),
        timesheetsAnswersByRole.primaryApprover,
      ),
  },
  {
    name: 'missing sheet',
    heading: 'Timesheet',
    render: () => screenPage('sheet', requestAs(Roles.timesheetsEmployee), timesheetsAnswersByRole.employee),
  },
  {
    name: 'rejected day action',
    heading: 'Timesheet',
    render: () =>
      rejectedActionPage(
        requestAs(Roles.timesheetsEmployee, {
          timesheetid: TIMESHEET_IDS.sheetReturned,
          dayid: TIMESHEET_IDS.dayBlackout,
          dayaction: 'submit',
        }),
        timesheetsAnswersByRole.employee,
      ),
  },
];

const DEFINITIONS = [
  ...timesheetsScreens.map((def) => ({ key: `screen ${def.screen}`, def })),
  ...timesheetsActions.map((def) => ({ key: `action ${def.action}`, def })),
];

/** `holder`'s request also naming `claimed` in its parameters, posted fields and an `X-OPT2-Roles` header. */
function claimingRequest(holder: Role, claimed: readonly Role[]): AdminRequest {
  const listed = claimed.join(',');
  const req = opt2RoleRequest(holder, {
    rc: { siteid: SITE, roles: listed, role: claimed[0] ?? '', opt2Roles: listed },
  });
  const headers = new Headers(req.headers);
  headers.set('x-opt2-roles', listed);
  return { ...req, headers };
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('timesheets screens in the shell', () => {
  it.each(PAGES)('renders the $name under the active OPT-2 group in legacy admin classes', async (testCase) => {
    const markup = await testCase.render();
    const $ = load(markup);

    expect($('#mura-content > .mura-header > h1').text()).toBe(testCase.heading);
    expect($('#admin-nav-opt2').attr('class')).toBe('open');
    expect($('#admin-nav-opt2 > a').attr('class')).toBe('nav-submenu active');
    expect($('#admin-nav-opt2 > ul a.active').toArray().map((link) => $(link).attr('href'))).toEqual([LANDING]);
    const classes = moduleClasses(markup);
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.filter((name) => !isLegacyClass(name))).toEqual([]);
  });
});

describe('timesheets labels', () => {
  const rb = rbFor('fr');
  /** Catalogue label `name` in French, as DOM text. */
  const fr = (name: Opt2LabelName): string => load(rb.rbKey(OPT2_LABEL_KEYS[name]), null, false).text();
  const flag = (on: boolean): string => fr(on ? 'Yes' : 'No');
  const detail = timesheetDetailByRole.employee;

  it.each([
    {
      name: 'sheets',
      req: () => requestAs(Roles.timesheetsEmployee, { pageIndex: '2' }),
      routes: listOf(timesheetSheets, SHEETS_PER_PAGE * 3),
      flagColumns: [4],
      expected: () => ({
        headers: [['Period', 'Person', fr('Due Date'), fr('Status'), 'Overdue']],
        flags: [timesheetSheets.map(({ overdue }) => flag(overdue))],
        buttons: [],
        links: ['Previous', fr('Next')],
      }),
    },
    {
      name: 'sheet',
      req: () => requestAs(Roles.timesheetsEmployee, { timesheetid: TIMESHEET_IDS.sheetReturned }),
      routes: timesheetsAnswersByRole.employee,
      flagColumns: [4, 3],
      expected: () => ({
        headers: [
          ['Person', 'Period', fr('Due Date'), fr('Status'), 'Overdue'],
          ['Work Date', fr('Hours'), fr('State'), 'Blackout', fr('Actions')],
        ],
        flags: [[flag(detail.overdue)], detail.days.map(({ blackout }) => flag(blackout))],
        buttons: [fr('Submit'), 'Resubmit'],
        links: ['Timesheets'],
      }),
    },
  ])('renders timesheets/$name with the bundle labels of the session locale', async (testCase) => {
    const def = screen(testCase.name);
    const ctx = makeScreenContext({ req: testCase.req(), gateway: fakeGatewayClient(testCase.routes), rb });

    const model = fragmentModel(toString((await def.render(ctx, await def.load(ctx))).body));

    expect({
      headers: model.tables.map(({ headers }) => headers),
      flags: model.tables.map(({ rows }, table) => rows.map((row) => row[testCase.flagColumns[table] ?? -1])),
      buttons: model.buttons.map(({ text }) => text),
      links: model.links.filter(({ href }) => !href.includes('timesheetid=')).map(({ text }) => text),
    }).toEqual(testCase.expected());
  });
});

describe('timesheets roles', () => {
  it.each(DEFINITIONS)('grants $key nothing for role names claimed outside the token', async ({ def }) => {
    const claimant = claimingRequest(Roles.financePreparer, def.roles);
    const holder = claimingRequest(Roles.timesheetsEmployee, def.roles);
    const gate = async (req: AdminRequest) => def.gate?.(req, { secure: () => secure(req) });

    expect(canUse(claimant, def.roles)).toBe(false);
    expect(await gate(claimant)).toEqual({ kind: 'redirect', location: noAccessUrl() });
    expect(canUse(holder, def.roles)).toBe(true);
    expect(await gate(holder)).toEqual({ kind: 'allow' });
  });

  it('reads no timesheets data for a claimed role', async () => {
    const gateway = fakeGatewayClient(timesheetsAnswersByRole.employee);
    const req = claimingRequest(Roles.financePreparer, screen('sheets').roles);

    const page = await renderScreenPage(screen('sheets'), makeScreenContext({ req, gateway }));

    expect(page).toEqual({ kind: 'redirect', location: noAccessUrl() });
    expect(gateway.calls.filter(({ service }) => service === 'timesheets')).toEqual([]);
  });
});
