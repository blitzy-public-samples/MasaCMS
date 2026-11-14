// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets fixture envelope, error mapping and row projections against legacy-fixtures/cfml/lib/envelope.cfc and modules/timesheets.cfc. */
import { describe, expect, it, vi } from 'vitest';
import { AuthDenial } from '@opt2/platform/auth';
import {
  etag,
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { GateClosedError, UnitNotAuthoritativeError } from '@opt2/platform/migration-kit';
import type { FastifyRequest } from '@opt2/platform/service-kit';
import { TransitionRejectedError, decide } from '@opt2/platform/state-machine';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import type { DayActionResult } from '../../src/domain/day-action.js';
import { timesheetsLifecycle, type TimesheetAction, type TimesheetState } from '../../src/domain/lifecycle.transitions.js';
import type { SheetStatusResult } from '../../src/domain/sheet-status.js';
import {
  FIXTURE_ERROR_MAP,
  FIXTURE_HINTS,
  FIXTURE_MODULE,
  FixtureApiError,
  fixtureContext,
  fixtureDayAction,
  fixtureError,
  fixtureList,
  fixtureMethod,
  fixtureSuccess,
  toFixtureError,
  type FixtureContext,
  type FixtureErrorType,
  type FixturePaging,
} from '../../src/legacy/envelope.js';
import { dayActionResult, dayRow, sheetRow, statusRow, type LegalDayActionResult } from '../../src/legacy/serialize.js';
import type { ApprovalActionRow, TimesheetDayRow, TimesheetRow } from '../../src/repo/tables.js';

const TENANT_ID = tenantIdForSite('tenant-a');
const SHEET_ID = '0A1B2C3D-4E5F-6A7B-8C9D0E1F2A3B4C5D';
const PERSON_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const DAY_ID = '11111111-2222-3333-4444555566667777';
const DAY_ID_2 = '22222222-3333-4444-5555666677778888';
const ACTION_ID = '99999999-8888-7777-6666555544443333';
// Params a request may carry; envelope.cfc never echoes them, because suppressAPIParams defaults to true.
const ECHO_PARAMS = { siteid: 'tenant-a', method: 'timesheets.days', asOf: '2026-07-07', filePath: 'a/b', csrf_token: 'T' };
const CTX: FixtureContext = { method: 'timesheets.days.submit', params: ECHO_PARAMS };
const TARGET_ONLY = ['tenant_id', 'legacy_program_id', 'row_version'];

// `variables.errorMap` of envelope.cfc.
const ENVELOPE_CFC_ERROR_MAP = {
  authorization: { status: 401, code: 'invalid_request', message: 'Insufficient Account Permissions' },
  invalidParameters: { status: 400, code: 'invalid_request', message: 'Invalid parameters' },
  invalidMethodCall: { status: 400, code: 'invalid_request', message: 'Invalid method call' },
  badRequest: { status: 400, code: 'invalid_request', message: 'Bad Request' },
  invalidTokens: { status: 400, code: 'invalid_request', message: 'Invalid CSRF tokens' },
  forbidden: { status: 403, code: 'invalid_request', message: 'Insufficient Account Permissions' },
  notFound: { status: 404, code: 'invalid_request', message: 'Not Found' },
  conflict: { status: 409, code: 'invalid_request', message: 'Conflict' },
  server_error: { status: 500, code: 'server_error', message: 'Unhandled Exception' },
} as const satisfies Record<string, { status: number; code: string; message: string }>;
type EnvelopeErrorType = keyof typeof ENVELOPE_CFC_ERROR_MAP;
const ENVELOPE_ERROR_ROWS = Object.entries(ENVELOPE_CFC_ERROR_MAP) as [EnvelopeErrorType, (typeof ENVELOPE_CFC_ERROR_MAP)[EnvelopeErrorType]][];

const successBody = (method: string, data: string): string => `{"apiversion":"v1","method":"${method}","data":${data}}`;
const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

/** Asserts envelope.cfc respond(): status, exact body, and only the JSON content type and ETag = hash(body) headers. */
function expectFixtureResponse(res: SerializedLegacyResponse, status: number, body: string): void {
  expect(res.status).toBe(status);
  expect(res.body).toBe(body);
  expect(res.headers).toStrictEqual({ 'Content-Type': LEGACY_JSON_CONTENT_TYPE, ETag: etag(body) });
  expect(res.headers['ETag']).toMatch(/^[0-9A-F]{64}$/);
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The rejection the timesheets lifecycle throws for `action` on `state` by `roles`, with the blackout guard as given. */
function rejection(state: TimesheetState, action: TimesheetAction, roles: readonly string[], blackout = false): TransitionRejectedError {
  const decision = decide(timesheetsLifecycle, { state, action, roles, guards: { blackout } });
  if (decision.outcome === 'ok') throw new Error(`${action} on ${state} is legal`);
  return new TransitionRejectedError(decision);
}

const day = (overrides: Partial<TimesheetDayRow> = {}): TimesheetDayRow => ({
  tenant_id: TENANT_ID,
  day_id: DAY_ID,
  timesheet_id: SHEET_ID,
  work_date: new Date(2026, 5, 29, 0, 0, 0),
  hours: '8.0000',
  state: 'SUBMITTED',
  lastupdate: new Date(2026, 5, 30, 9, 15, 0, 997),
  lastupdatebyid: PERSON_ID,
  legacy_program_id: 1,
  ...overrides,
});

const sheet = (overrides: Partial<TimesheetRow> = {}): TimesheetRow => ({
  tenant_id: TENANT_ID,
  timesheet_id: SHEET_ID,
  person_id: PERSON_ID,
  siteid: 'tenant-a',
  period_start: new Date(2026, 5, 29),
  period_end: new Date(2026, 6, 5),
  due_date: new Date(2026, 6, 6),
  created: new Date(2026, 5, 28, 23, 59, 59, 500),
  lastupdate: null,
  lastupdatebyid: null,
  legacy_program_id: 1,
  ...overrides,
});

const STATUS: SheetStatusResult = { status: 'PARTIALLY_APPROVED', overdue: true, dayCount: 3, blackoutCount: 1, approvedCount: 1 };

const legal = (overrides: Partial<TimesheetDayRow> = {}): LegalDayActionResult => {
  const approvalAction: ApprovalActionRow = {
    tenant_id: TENANT_ID,
    action_id: ACTION_ID,
    day_id: DAY_ID,
    action: 'primary-approve',
    role: 'timesheets.primary-approver',
    from_state: 'SUBMITTED',
    to_state: 'PRIMARY_APPROVED',
    actor_user_id: PERSON_ID,
    comment: null,
    created: new Date(2026, 5, 30, 9, 15, 0),
    legacy_program_id: 1,
  };
  return { outcome: 'legal', day: day({ state: 'PRIMARY_APPROVED', ...overrides }), approvalAction, to: 'PRIMARY_APPROVED' };
};

describe('fixtureMethod', () => {
  it.each<[string, string | undefined, string]>([
    ['sheets', undefined, 'timesheets.sheets'],
    ['Sheets', 'Status', 'timesheets.sheets.status'],
    ['days', '', 'timesheets.days'],
    ['days', 'primary-approve', 'timesheets.days.primary-approve'],
    ['DAYS', 'Secondary-Approve', 'timesheets.days.secondary-approve'],
  ])('names resource %s with action %j as %s', (resource, action, method) => {
    expect(fixtureMethod(resource, action)).toBe(method);
  });

  it('prefixes the timesheets module', () => {
    expect(FIXTURE_MODULE).toBe('timesheets');
  });
});

describe('fixtureContext', () => {
  const query = { siteid: 'tenant-a', AsOf: '2026-07-07' };

  it.each<[string, string, unknown, Record<string, unknown>]>([
    [
      'a JSON object body, simple values as strings',
      'application/json; charset=utf-8',
      { comment: 'Looks right', asOf: '2026-07-08', count: 2, note: null },
      { siteid: 'tenant-a', comment: 'Looks right', asOf: '2026-07-08', count: '2', note: '' },
    ],
    [
      'a JSON object body, booleans and numbers as CFML toString text',
      'application/json',
      { comment: true, approved: false, hours: 1e20, rate: 1.5 },
      { ...query, comment: 'YES', approved: 'NO', hours: '1E+020', rate: '1.5' },
    ],
    ['a form body, repeated keys joined', 'application/x-www-form-urlencoded', { comment: ['a', 'b'] }, { ...query, comment: 'a,b' }],
    ['a JSON array body, ignored', 'application/json', ['x'], query],
  ])('pairs the api.cfm method with url then %s, later keys winning ignoring case', (_label, contentType, body, params) => {
    const request = { query, body, headers: { 'content-type': contentType } } as unknown as FastifyRequest;

    expect(fixtureContext(request, 'days', 'return')).toStrictEqual({ method: 'timesheets.days.return', params });
  });
});

describe('fixture error map', () => {
  it.each(ENVELOPE_ERROR_ROWS)('holds the envelope.cfc %s row, frozen', (type, row) => {
    expect(FIXTURE_ERROR_MAP[type]).toStrictEqual(row);
    expect(Object.isFrozen(FIXTURE_ERROR_MAP[type])).toBe(true);
  });

  it('keeps every JSON API row, which token denials answer with, and is frozen', () => {
    for (const [type, row] of Object.entries(LEGACY_ERROR_MAP)) expect(FIXTURE_ERROR_MAP[type as FixtureErrorType]).toBe(row);
    expect(Object.isFrozen(FIXTURE_ERROR_MAP)).toBe(true);
  });
});

describe('FIXTURE_HINTS', () => {
  it('registers the envelope.cfc fixture hints after the JSON API chain, in its call order', () => {
    expect(FIXTURE_HINTS).toEqual([
      ...[
        'version', 'seq', 'record_count', 'day_count', 'blackout_count', 'approved_count', 'size_bytes', 'offset_minutes',
        'offsetminutes', 'schedule_version', 'inserted', 'total', 'blackouts', 'program_id', 'entries', 'brokenat',
      ].map((key) => ({ key, hint: 'integer' })),
      ...['overdue', 'valid', 'isblackout'].map((key) => ({ key, hint: 'boolean' })),
    ]);
    expect(Object.isFrozen(FIXTURE_HINTS)).toBe(true);
  });

  it('serializes hinted keys as envelope.cfc does, other simple values as strings and keys lower-cased', () => {
    const data = { Day_Count: '3', blackout_count: 0, overdue: 'yes', isblackout: 0, hours: '8.0000', pageindex: '2', State: 'DRAFT', seq: 4 };

    expectFixtureResponse(
      fixtureSuccess({ method: 'timesheets.sheets', params: {} }, data),
      200,
      successBody(
        'timesheets.sheets',
        '{"day_count":3,"blackout_count":0,"overdue":true,"isblackout":false,"hours":"8.0000","pageindex":2,"state":"DRAFT","seq":4}',
      ),
    );
  });
});

describe('FixtureApiError', () => {
  it.each<[FixtureErrorType, string | undefined, string]>([
    ['notFound', undefined, ''],
    ['invalidParameters', '', ''],
    ['conflict', 'blackout', 'blackout'],
  ])('raises %s with message %j as %j', (type, message, expected) => {
    const error = message === undefined ? new FixtureApiError(type) : new FixtureApiError(type, message);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LegacyApiError);
    expect(error.name).toBe('FixtureApiError');
    expect(error.type).toBe(type);
    expect(error.message).toBe(expected);
  });
});

describe('fixtureSuccess', () => {
  const status = { timesheet_id: SHEET_ID, status: 'SUBMITTED', overdue: false, day_count: 2 };
  const statusJson = `"timesheet_id":"${SHEET_ID}","status":"SUBMITTED","overdue":false,"day_count":2`;

  it.each<[Record<string, unknown>, unknown, string]>([
    [ECHO_PARAMS, status, successBody('timesheets.sheets.status', `{${statusJson}}`)],
    [{ useDataNamespace: 'true' }, status, successBody('timesheets.sheets.status', `{${statusJson}}`)],
    [{ useDataNamespace: 'maybe' }, status, successBody('timesheets.sheets.status', `{${statusJson}}`)],
    [{ useDataNamespace: '' }, status, successBody('timesheets.sheets.status', `{${statusJson}}`)],
    [{ useDataNamespace: 'false' }, status, `{"apiversion":"v1","method":"timesheets.sheets.status",${statusJson}}`],
    [{ USEDATANAMESPACE: 'no' }, status, `{"apiversion":"v1","method":"timesheets.sheets.status",${statusJson}}`],
    [{ useDataNamespace: 'false' }, [status], successBody('timesheets.sheets.status', `[{${statusJson}}]`)],
    [{ useDataNamespace: 'false' }, { method: 'other', state: 'APPROVED' }, '{"apiversion":"v1","method":"other","state":"APPROVED"}'],
  ])('answers 200 without params for params %j and data %j', (params, data, body) => {
    expectFixtureResponse(fixtureSuccess({ method: 'timesheets.sheets.status', params }, data), 200, body);
  });

  it('answers {} as data when the route gives none, at the status the caller names', () => {
    expectFixtureResponse(fixtureSuccess({ method: 'timesheets.sheets', params: {} }), 200, successBody('timesheets.sheets', '{}'));
    expectFixtureResponse(fixtureSuccess({ method: 'timesheets.sheets', params: {} }, {}, 201), 201, successBody('timesheets.sheets', '{}'));
  });
});

describe('fixtureList', () => {
  const rowA = { timesheet_id: 'S1', day_count: 1 };
  const rowB = { timesheet_id: 'S2', day_count: 3 };
  const rowsJson = '{"timesheet_id":"S1","day_count":1},{"timesheet_id":"S2","day_count":3}';

  it.each<[string, unknown[], FixturePaging, string]>([
    ['a first page', [rowA, rowB], { total: 3, pageIndex: 1, itemsPerPage: 2 }, `[${rowsJson}],"startindex":1,"endindex":2,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":1`],
    ['a last partial page', [rowB], { total: 3, pageIndex: 2, itemsPerPage: 2 }, '[{"timesheet_id":"S2","day_count":3}],"startindex":3,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":2'],
    ['a page past the total', [rowA], { total: 3, pageIndex: 5, itemsPerPage: 2 }, '[],"startindex":9,"endindex":3,"itemsperpage":2,"totalitems":3,"totalpages":2,"pageindex":5'],
    ['an empty list', [], { total: 0, pageIndex: 1, itemsPerPage: 50 }, '[],"startindex":1,"endindex":0,"itemsperpage":50,"totalitems":0,"totalpages":0,"pageindex":1'],
  ])('answers %s as envelope.cfc listResponse() of a queryPage() result', (_label, items, paging, listJson) => {
    expectFixtureResponse(
      fixtureList({ method: 'timesheets.sheets', params: ECHO_PARAMS }, items, paging),
      200,
      successBody('timesheets.sheets', `{"items":${listJson}}`),
    );
  });
});

describe('fixtureError', () => {
  it.each(ENVELOPE_ERROR_ROWS)('answers %s at its envelope.cfc status, code before message', (type, { status, code, message }) => {
    expectFixtureResponse(fixtureError(type, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each<[string | undefined, string]>([
    [undefined, 'Conflict'],
    ['', 'Conflict'],
    ['blackout', 'blackout'],
  ])('answers message %j as %j', (message, expected) => {
    expectFixtureResponse(fixtureError('conflict', CTX, message), 409, errorBody(CTX.method, 'invalid_request', expected));
  });
});

describe('toFixtureError', () => {
  it.each<[string, unknown, number, string, string]>([
    ['a fixture notFound', new FixtureApiError('notFound'), 404, 'invalid_request', 'Not Found'],
    ['a fixture invalidParameters', new FixtureApiError('invalidParameters'), 400, 'invalid_request', 'Invalid parameters'],
    ['a fixture conflict with a message', new FixtureApiError('conflict', 'illegalTransition'), 409, 'invalid_request', 'illegalTransition'],
    ['an illegal-state transition', rejection('APPROVED', 'submit', ['timesheets.employee']), 409, 'invalid_request', 'illegalTransition'],
    ['an action no row allows from the state', rejection('DRAFT', 'secondary-approve', ['timesheets.secondary-approver']), 409, 'invalid_request', 'illegalTransition'],
    ['a transition on a blacked-out day', rejection('DRAFT', 'submit', ['timesheets.employee'], true), 409, 'invalid_request', 'blackout'],
    ['a wrong-role transition', rejection('DRAFT', 'submit', ['timesheets.primary-approver']), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['an unauthenticated denial', AuthDenial.unauthenticated('missing-credential'), 401, 'invalid_request', 'Insufficient Account Permissions'],
    ['an invalid token denial', AuthDenial.invalidToken(), 401, 'invalid_token', 'Invalid Access Token'],
    ['an expired token denial', AuthDenial.expiredToken(), 401, 'invalid_token', 'Access Token Expired'],
    ['a role denial', AuthDenial.forbidden(), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a site mismatch', AuthDenial.siteMismatch(), 403, 'invalid_request', 'Insufficient Account Permissions'],
    ['a legacy invalidTokens error', new LegacyApiError('invalidTokens'), 400, 'invalid_request', 'Invalid CSRF tokens'],
    ['a legacy badRequest error', new LegacyApiError('badRequest'), 400, 'invalid_request', 'Bad Request'],
    ['a legacy error of a fixture-only type', new LegacyApiError('notFound'), 404, 'invalid_request', 'Not Found'],
    ['a legacy error of an unmapped type', new LegacyApiError('invalid_token'), 500, 'server_error', 'Unhandled Exception'],
    ['a legacy error typed as a prototype key', new LegacyApiError('toString'), 500, 'server_error', 'Unhandled Exception'],
    ['an unexpected Error', new Error('connection reset'), 500, 'server_error', 'Unhandled Exception'],
    ['a thrown string', 'boom', 500, 'server_error', 'Unhandled Exception'],
    ['undefined', undefined, 500, 'server_error', 'Unhandled Exception'],
  ])('answers %s with the fixture error envelope and no WWW-Authenticate', (_label, err, status, code, message) => {
    expectFixtureResponse(toFixtureError(err, CTX), status, errorBody(CTX.method, code, message));
  });

  it.each([
    new LegacyServiceUnavailableError(),
    new GateClosedError(['timesheets.timesheet_day']),
    new UnitNotAuthoritativeError(['timesheets.approval_action']),
  ])('rethrows %s for the service-kit legacy 503', (err) => {
    expect(thrownBy(() => toFixtureError(err, CTX))).toBe(err);
  });
});

describe('fixtureDayAction', () => {
  it('answers a legal action with the projection of its result', () => {
    const result = legal();
    const project = vi.fn(dayActionResult);
    const ctx: FixtureContext = { method: 'timesheets.days.primary-approve', params: ECHO_PARAMS };

    expectFixtureResponse(
      fixtureDayAction(ctx, result, project),
      200,
      successBody(
        ctx.method,
        `{"day_id":"${DAY_ID}","timesheet_id":"${SHEET_ID}","work_date":"2026-06-29T00:00:00","hours":"8.0000","state":"PRIMARY_APPROVED","isblackout":false}`,
      ),
    );
    expect(project).toHaveBeenCalledExactlyOnceWith(result);
  });

  it('answers a missing day with the fixture 404 without projecting', () => {
    const project = vi.fn(dayActionResult);
    const result: DayActionResult = { outcome: 'not-found' };

    expectFixtureResponse(fixtureDayAction(CTX, result, project), 404, errorBody(CTX.method, 'invalid_request', 'Not Found'));
    expect(project).not.toHaveBeenCalled();
  });
});

describe('dayRow', () => {
  it.each(['8.0000', '0.0000', '0.2500', '23.9999', '-1.5000', '999999999999999.9999'])('keeps the stored four-decimal hours %s as text', (hours) => {
    expect(dayRow({ day: day({ hours }), blackout: false }).hours).toBe(hours);
  });

  it.each<[Date, string]>([
    [new Date(2026, 5, 29, 0, 0, 0), '2026-06-29T00:00:00'],
    [new Date(2026, 0, 2, 23, 59, 59, 999), '2026-01-02T23:59:59'],
    [new Date(1753, 0, 1, 7, 5, 9), '1753-01-01T07:05:09'],
  ])('renders work date %s as the fixture datetime text %s', (workDate, text) => {
    expect(dayRow({ day: day({ work_date: workDate }), blackout: true }).work_date).toBe(text);
  });

  it('projects exactly the findDays columns and the blackout flag, never a target-only column', () => {
    const stored = { ...day(), row_version: '7' } as TimesheetDayRow;

    for (const blackout of [true, false]) {
      const row = dayRow({ day: stored, blackout });
      expect(row).toStrictEqual({
        day_id: DAY_ID,
        timesheet_id: SHEET_ID,
        work_date: '2026-06-29T00:00:00',
        hours: '8.0000',
        state: 'SUBMITTED',
        isblackout: blackout,
      });
      expect(Object.keys(row)).toEqual(['day_id', 'timesheet_id', 'work_date', 'hours', 'state', 'isblackout']);
      expect(Object.keys(row).filter((key) => TARGET_ONLY.includes(key))).toEqual([]);
    }
  });
});

describe('statusRow', () => {
  it('projects the derived status onto the usp_timesheet_status columns in procedure order', () => {
    const row = statusRow({ sheet: sheet(), status: STATUS });

    expect(row).toStrictEqual({
      timesheet_id: SHEET_ID,
      status: 'PARTIALLY_APPROVED',
      overdue: true,
      day_count: 3,
      blackout_count: 1,
      approved_count: 1,
    });
    expect(Object.keys(row)).toEqual(['timesheet_id', 'status', 'overdue', 'day_count', 'blackout_count', 'approved_count']);
  });
});

describe('sheetRow', () => {
  const days = [
    { day: day({ state: 'APPROVED' }), blackout: false },
    { day: day({ day_id: DAY_ID_2, work_date: new Date(2026, 5, 30), hours: '7.5000', state: 'DRAFT' }), blackout: true },
  ];
  const daysJson =
    `[{"day_id":"${DAY_ID}","timesheet_id":"${SHEET_ID}","work_date":"2026-06-29T00:00:00","hours":"8.0000","state":"APPROVED","isblackout":false},` +
    `{"day_id":"${DAY_ID_2}","timesheet_id":"${SHEET_ID}","work_date":"2026-06-30T00:00:00","hours":"7.5000","state":"DRAFT","isblackout":true}]`;

  it.each<[string, Partial<TimesheetRow>, string, string]>([
    ['a never-updated sheet, NULL columns as empty text', {}, '', ''],
    ['an updated sheet', { lastupdate: new Date(2026, 6, 1, 14, 30, 5, 250), lastupdatebyid: PERSON_ID }, '2026-07-01T14:30:05', PERSON_ID],
  ])('serializes %s as the fixture sheet detail', (_label, overrides, lastupdate, lastupdatebyid) => {
    const detail = sheetRow({ sheet: { ...sheet(overrides), row_version: '3' } as TimesheetRow, status: STATUS, days });

    expect(Object.keys(detail)).toEqual([
      'timesheet_id', 'person_id', 'siteid', 'period_start', 'period_end', 'due_date', 'created', 'lastupdate', 'lastupdatebyid',
      'status', 'overdue', 'day_count', 'blackout_count', 'approved_count', 'days',
    ]);
    expect(Object.keys(detail).filter((key) => TARGET_ONLY.includes(key))).toEqual([]);
    expectFixtureResponse(
      fixtureSuccess({ method: 'timesheets.sheets', params: { siteid: 'tenant-a', asOf: '2026-07-07' } }, detail),
      200,
      successBody(
        'timesheets.sheets',
        `{"timesheet_id":"${SHEET_ID}","person_id":"${PERSON_ID}","siteid":"tenant-a","period_start":"2026-06-29T00:00:00",` +
          `"period_end":"2026-07-05T00:00:00","due_date":"2026-07-06T00:00:00","created":"2026-06-28T23:59:59",` +
          `"lastupdate":"${lastupdate}","lastupdatebyid":"${lastupdatebyid}","status":"PARTIALLY_APPROVED","overdue":true,` +
          `"day_count":3,"blackout_count":1,"approved_count":1,"days":${daysJson}}`,
      ),
    );
  });

  it('answers a sheet without days with an empty days array', () => {
    expect(sheetRow({ sheet: sheet(), status: { ...STATUS, dayCount: 0, blackoutCount: 0, approvedCount: 0 }, days: [] }).days).toEqual([]);
  });
});

describe('dayActionResult', () => {
  it('re-reads the acted-on day without a blackout, which the guard would have rejected', () => {
    expect(dayActionResult(legal({ hours: '0.5000' }))).toStrictEqual({
      day_id: DAY_ID,
      timesheet_id: SHEET_ID,
      work_date: '2026-06-29T00:00:00',
      hours: '0.5000',
      state: 'PRIMARY_APPROVED',
      isblackout: false,
    });
  });
});
