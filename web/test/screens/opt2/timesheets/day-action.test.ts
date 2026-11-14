// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
// The timesheets day-action post over the timesheets fixtures: service call, CSRF relay, redirect, roles, errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, type Role } from '@opt2/platform/auth';
import { runGate } from '@/lib/access-gate';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { Opt2ActionDefinition, SubmitResult } from '@/screens/registry';
import { timesheetsActions } from '@/screens/opt2/timesheets';
import {
  TIMESHEETS_AS_OF,
  TIMESHEET_IDS,
  dayActionBlackout,
  timesheetsAnswersByRole,
} from '../../../fixtures/opt2/timesheets';
import { makeAdminRequest, opt2RoleRequest } from '../../../helpers/admin-request';
import { fragmentModel } from '../../../helpers/dom-model';
import { useTestEnv } from '../../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeRouteTable,
} from '../../../helpers/fake-gateway';
import { formWithCsrf } from '../../../helpers/requests';
import { FIXED_CSRF, makeScreenContext } from '../../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SITE = 'tenant-a';
const SHEET_URL =
  `/opt2/admin/timesheets/sheet?siteid=${SITE}&asOf=${TIMESHEETS_AS_OF}&timesheetid=${TIMESHEET_IDS.sheetReturned}`;
const dayRoute = (dayId: string, action: string): string =>
  routeKey('POST', 'timesheets', `/v1/timesheets/days/${dayId}/${action}`);

function dayAction(): Opt2ActionDefinition {
  const def = timesheetsActions.find(({ action }) => action === 'day-action');
  if (def === undefined) throw new TypeError('timesheets/day-action is not registered');
  return def;
}

/** A day-action post by `role` with the fixed CSRF pair, plus `fields` laid over the default sheet and day. */
const actionRequest = (role: Role, fields: Record<string, string>, csrf = true): AdminRequest => {
  const posted = { timesheetid: TIMESHEET_IDS.sheetReturned, ...fields };
  return opt2RoleRequest(role, {
    rc: { siteid: SITE, asOf: TIMESHEETS_AS_OF, ...(csrf ? formWithCsrf(posted, FIXED_CSRF) : posted) },
  });
};

async function submit(
  req: AdminRequest,
  routes: FakeRouteTable,
): Promise<{ result: SubmitResult; gateway: FakeGatewayClient }> {
  const gateway = fakeGatewayClient(routes);
  return { result: await dayAction().submit(makeScreenContext({ req, gateway })), gateway };
}

/** The timesheets calls, as `METHOD path`. */
const timesheetsCalls = (gateway: FakeGatewayClient): string[] =>
  gateway.calls.filter(({ service }) => service === 'timesheets').map(({ method, path }) => `${method} ${path}`);

/** The re-rendered body of a `render` outcome. */
function renderedBody(result: SubmitResult): string {
  if (result.kind !== 'render') throw new Error(`expected a re-render, got ${result.kind}`);
  expect(result.view.opt2Module).toBe('timesheets');
  return toString(result.view.body);
}

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('timesheets day-action', () => {
  it('sends the action with the posted CSRF pair as headers, then redirects to the sheet', async () => {
    const req = actionRequest(Roles.timesheetsPrimaryApprover, {
      dayid: TIMESHEET_IDS.daySubmitted,
      dayaction: 'primary-approve',
    });

    const { result, gateway } = await submit(req, timesheetsAnswersByRole.primaryApprover);

    expect(result).toEqual({ kind: 'location', location: SHEET_URL });
    expect(gateway.calls.filter(({ service }) => service === 'timesheets')).toEqual([
      {
        service: 'timesheets',
        method: 'POST',
        path: `/v1/timesheets/days/${TIMESHEET_IDS.daySubmitted}/primary-approve`,
        headers: { 'x-csrf_token': FIXED_CSRF.token, 'x-csrf_token_expires': FIXED_CSRF.expires },
      },
    ]);
  });

  it('sends no CSRF headers when the post carries no token', async () => {
    const req = actionRequest(
      Roles.timesheetsPrimaryApprover,
      { dayid: TIMESHEET_IDS.daySubmitted, dayaction: 'primary-approve' },
      false,
    );

    const { gateway } = await submit(req, timesheetsAnswersByRole.primaryApprover);

    expect(gateway.calls.find(({ service }) => service === 'timesheets')?.headers).toBeUndefined();
  });

  it('re-renders the sheet with the blackout rejection in an alert', async () => {
    const req = actionRequest(Roles.timesheetsEmployee, { dayid: TIMESHEET_IDS.dayBlackout, dayaction: 'submit' });

    const { result, gateway } = await submit(req, timesheetsAnswersByRole.employee);

    const model = fragmentModel(renderedBody(result));
    expect(model.alerts).toEqual([{ text: dayActionBlackout.body.error.message, className: 'alert alert-error' }]);
    expect(model.headings).toEqual(['Timesheet']);
    expect(model.buttons.map(({ text }) => text)).toEqual(['Submit', 'Resubmit']);
    expect(timesheetsCalls(gateway)).toEqual([
      `POST /v1/timesheets/days/${TIMESHEET_IDS.dayBlackout}/submit`,
      `GET /v1/timesheets/sheets/${TIMESHEET_IDS.sheetReturned}`,
    ]);
  });

  it.each([
    { status: 400, message: 'Invalid parameters' },
    { status: 403, message: 'Forbidden' },
    { status: 404, message: 'Not Found' },
    { status: 409, message: 'illegalTransition' },
  ])('re-renders the sheet with the $status error message', async ({ status, message }) => {
    const req = actionRequest(Roles.timesheetsEmployee, { dayid: TIMESHEET_IDS.daySubmitted, dayaction: 'submit' });
    const routes = {
      ...timesheetsAnswersByRole.employee,
      [dayRoute(TIMESHEET_IDS.daySubmitted, 'submit')]: {
        status,
        body: { apiversion: 'v1', method: 'timesheets.days.submit', error: { code: 'invalid_request', message } },
      },
    };

    const { result } = await submit(req, routes);

    expect(fragmentModel(renderedBody(result)).alerts).toEqual([{ text: message, className: 'alert alert-error' }]);
  });

  it.each([
    { what: 'an action name it does not know', dayid: TIMESHEET_IDS.dayDraft, dayaction: 'approve' },
    { what: 'an empty day id', dayid: '', dayaction: 'submit' },
  ])('leaves $what to the service and shows its 404', async ({ dayid, dayaction }) => {
    const req = actionRequest(Roles.timesheetsEmployee, { dayid, dayaction });

    const { result, gateway } = await submit(req, timesheetsAnswersByRole.employee);

    expect(timesheetsCalls(gateway)[0]).toBe(`POST /v1/timesheets/days/${dayid}/${dayaction}`);
    expect(fragmentModel(renderedBody(result)).alerts).toEqual([{ text: 'Not Found', className: 'alert alert-error' }]);
  });

  it('returns to the sheet list without a sheet id, on success and on a rejection', async () => {
    const legal = actionRequest(Roles.timesheetsPrimaryApprover, {
      timesheetid: '',
      dayid: TIMESHEET_IDS.daySubmitted,
      dayaction: 'primary-approve',
    });
    const blackout = actionRequest(Roles.timesheetsEmployee, {
      timesheetid: '',
      dayid: TIMESHEET_IDS.dayBlackout,
      dayaction: 'submit',
    });

    const done = await submit(legal, timesheetsAnswersByRole.primaryApprover);
    const rejected = await submit(blackout, timesheetsAnswersByRole.employee);

    expect(done.result).toEqual({
      kind: 'location',
      location: `/opt2/admin/timesheets/sheets?siteid=${SITE}&asOf=${TIMESHEETS_AS_OF}`,
    });
    const model = fragmentModel(renderedBody(rejected.result));
    expect(model.headings).toEqual(['Timesheets']);
    expect(model.alerts).toEqual([{ text: 'blackout', className: 'alert alert-error' }]);
    expect(timesheetsCalls(rejected.gateway)).toEqual([
      `POST /v1/timesheets/days/${TIMESHEET_IDS.dayBlackout}/submit`,
      'GET /v1/timesheets/sheets',
    ]);
  });

  it.each([
    { status: 401, error: GatewayDenialError },
    { status: 503, error: GatewayUnavailableError },
    { status: 500, error: Error },
  ])('throws $error.name on a timesheets $status', async ({ status, error }) => {
    const req = actionRequest(Roles.timesheetsEmployee, { dayid: TIMESHEET_IDS.dayDraft, dayaction: 'submit' });
    const routes = { [dayRoute(TIMESHEET_IDS.dayDraft, 'submit')]: { status, body: { error: { code: 'x' } } } };

    await expect(submit(req, routes)).rejects.toBeInstanceOf(error);
  });

  it.each([
    {
      who: 'a user without a timesheets role',
      req: () => makeAdminRequest({}, 'systemUser'),
      to: '/admin/?muraAction=cMessage.noaccess',
    },
    {
      who: 'an anonymous user',
      req: () => makeAdminRequest({}, 'anonymous'),
      to: expect.stringContaining('cLogin.main'),
    },
  ])('gates $who away before any write', async ({ req, to }) => {
    expect(await runGate(req(), dayAction().gate)).toEqual({ kind: 'redirect', location: to });
  });

  it.each<Role>([Roles.timesheetsEmployee, Roles.timesheetsPrimaryApprover, Roles.timesheetsSecondaryApprover])(
    'lets %s through to the service, which decides the action',
    async (role) => {
      expect(await runGate(opt2RoleRequest(role), dayAction().gate)).toEqual({ kind: 'allow' });
    },
  );
});
