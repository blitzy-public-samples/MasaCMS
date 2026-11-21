// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Every generated transition-table row driven through both day-action routes with `app.inject`, and the fixture-oracle report it feeds. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITE_POSITION_HEADER_LC, parseWritePosition } from '@opt2/platform/migration-kit';
import {
  generateTable,
  serializeTable,
  transitionError,
  transitionErrorEnvelope,
  type TransitionTableRow,
} from '@opt2/platform/state-machine';
import { TENANT_A } from '@opt2/platform/testing';
import { SERVICE_NAME } from '../../src/app.js';
import {
  TIMESHEET_ACTIONS,
  TIMESHEET_ROLES,
  TIMESHEET_STATES,
  timesheetsLifecycle,
  type TimesheetAction,
  type TimesheetRole,
  type TimesheetState,
} from '../../src/domain/lifecycle.transitions.js';
import { FIXTURE_ERROR_MAP, fixtureError, fixtureMethod, fixtureSuccess, type FixtureResponse } from '../../src/legacy/envelope.js';
import type { TimesheetDayRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { TEST_CLOCK, asOf, buildTestApp, headersFor, type RecordingDb, type TestApp } from '../helpers/app.js';
import { approvalActionRow, seedSheet, toSeed } from '../helpers/days.js';

const committedTable = readFileSync(new URL('../generated/transition-table.json', import.meta.url), 'utf8');
const rows = JSON.parse(committedTable) as TransitionTableRow[];
const unguarded = rows.filter((row) => row.guard === null);
const guarded = rows.filter((row) => row.guard === 'blackout');
const legalRows = rows.filter((row) => row.expectedStatus === 200);
const rejectedRows = rows.filter((row) => row.expectedStatus !== 200);

// Report vocabulary of each generated HTTP status, as scripts/export-transitions.ts writes it.
const REPORT_OUTCOMES = {
  200: { outcome: 'legal', status: '2xx' },
  403: { outcome: 'wrong-role', status: '403' },
  409: { outcome: 'illegal-state', status: '409' },
} as const;

/** One unguarded row of `opt2/reports/state-machines/timesheets.json`. */
interface ReportRow {
  from: string;
  action: string;
  role: string;
  outcome: string;
  status: string;
  to: string | null;
  error?: string;
}

/** `opt2/reports/state-machines/timesheets.json`; `generatedAt`, `provenance` and `blackout.appliesTo` belong to the committed file. */
interface TimesheetsReport {
  service: string;
  aggregate: string;
  states: string[];
  actions: string[];
  roles: string[];
  terminal: string[];
  blackout: { appliesTo: string; outcome: string; status: string; error: string };
  rows: ReportRow[];
}

const report = JSON.parse(
  readFileSync(new URL('../../../../opt2/reports/state-machines/timesheets.json', import.meta.url), 'utf8'),
) as TimesheetsReport;

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;
type Rejection = Parameters<typeof transitionErrorEnvelope>[0];

/** A legal action as the routes must answer it: the table row, the day after the transition and its audit row's id. */
interface Applied {
  row: TransitionTableRow;
  day: TimesheetDayRow;
  actionId: string;
}

/** One day-action route and the answers it gives. */
interface DayActionTarget {
  readonly title: string;
  url(dayId: string, action: string): string;
  expectApplied(res: Injected, applied: Applied): void;
  expectRejected(res: Injected, row: TransitionTableRow): void;
  expectNotFound(res: Injected, action: string): void;
}

/** `from|action|role` key of a table or report row. */
function rowKey(row: { from: string; action: string; role: string }): string {
  return `${row.from}|${row.action}|${row.role}`;
}

/** Number of rows per `|`-joined status and error code. */
function countOutcomes(list: readonly TransitionTableRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of list) {
    const key = `${row.expectedStatus}|${String(row.errorCode)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** One unguarded table row in the report's row form. */
function reportRowOf(row: TransitionTableRow): ReportRow {
  return {
    from: row.from,
    action: row.action,
    role: row.role,
    ...REPORT_OUTCOMES[row.expectedStatus],
    to: row.to,
    ...(row.errorCode === null ? {} : { error: row.errorCode }),
  };
}

/** Title of one row's route case. */
function caseTitle(row: TransitionTableRow): string {
  return `${row.from} ${row.action} as ${row.role}${row.guard === null ? '' : ` (${row.guard})`} → ${row.expectedStatus}`;
}

/** The runner's rejection of a non-200 row, as the routes' error handlers receive it. */
function rejectionOf(row: TransitionTableRow): Rejection {
  const error = transitionError(String(row.errorCode));
  return row.expectedStatus === 403 ? { outcome: 'forbidden', status: 403, error } : { outcome: 'illegal', status: 409, error };
}

/** The first legal row of `action`; every lifecycle action has one. */
function legalRowFor(action: string): TransitionTableRow {
  const row = legalRows.find((candidate) => candidate.action === action);
  if (row === undefined) throw new Error(`the transition table has no legal ${action} row`);
  return row;
}

/** `sub` claim of the user token in `headers.authorization`. */
function tokenSubject(headers: Readonly<Record<string, string>>): string {
  const [, payload = ''] = (headers.authorization ?? '').split('.');
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string }).sub;
}

/** A seeded `timesheet_day` work date as the contract's LocalDateTime: the seed stores local midnight. */
function workDateText(day: TimesheetDayRow): string {
  return `${asOf(day.work_date)}T00:00:00`;
}

/** The committed tenant-a row of day `dayId`. */
function storedDay(db: RecordingDb, dayId: string): TimesheetDayRow | undefined {
  return db.rowsOf('timesheet_day', TENANT_A.tenantId).find((day) => day.day_id === dayId);
}

/** Envelope context of a fixture day-action request sent without query or body. */
function fixtureCtx(action: string): { method: string; params: Record<string, unknown> } {
  return { method: fixtureMethod('days', action), params: {} };
}

/** Asserts the exact fixture response: status, every header the envelope sets, and the body bytes. */
function expectFixtureResponse(res: Injected, expected: FixtureResponse): void {
  expect(res.statusCode).toBe(expected.status);
  for (const [name, value] of Object.entries(expected.headers)) expect(res.headers[name.toLowerCase()]).toBe(value);
  expect(res.body).toBe(expected.body);
}

const V1_TARGET: DayActionTarget = {
  title: 'dayAction POST /v1/timesheets/days/{id}/{action}',
  url: (dayId, action) => `/v1/timesheets/days/${dayId}/${action}`,
  expectApplied(res, { row, day, actionId }) {
    expect(res.json()).toEqual({
      dayId: day.day_id,
      timesheetId: day.timesheet_id,
      action: row.action,
      fromState: row.from,
      toState: row.to,
      actionId,
      workDate: workDateText(day),
      hours: day.hours,
      blackout: false,
    });
  },
  expectRejected(res, row) {
    expect(res.json()).toEqual(transitionErrorEnvelope(rejectionOf(row), { method: fixtureMethod('days', row.action) }));
  },
  expectNotFound(res, action) {
    // The v1 route answers an unknown day with the fixture's notFound status, code and message.
    const { status, code, message } = FIXTURE_ERROR_MAP.notFound;
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ method: fixtureMethod('days', action), error: { code, message } });
  },
};

const FIXTURE_TARGET: DayActionTarget = {
  title: `fixtureDayAction POST ${FIXTURE_PREFIX}/days/{id}/{action}`,
  url: (dayId, action) => `${FIXTURE_PREFIX}/days/${dayId}/${action}`,
  expectApplied(res, { row, day }) {
    const data = {
      day_id: day.day_id,
      timesheet_id: day.timesheet_id,
      work_date: workDateText(day),
      hours: day.hours,
      state: row.to,
      isblackout: false,
    };
    expectFixtureResponse(res, fixtureSuccess(fixtureCtx(row.action), data));
  },
  expectRejected(res, row) {
    const ctx = fixtureCtx(row.action);
    expectFixtureResponse(res, row.expectedStatus === 403 ? fixtureError('forbidden', ctx) : fixtureError('conflict', ctx, String(row.errorCode)));
  },
  expectNotFound(res, action) {
    expectFixtureResponse(res, fixtureError('notFound', fixtureCtx(action)));
  },
};

describe('the transition table these cases are driven by', () => {
  it('is the current generation of timesheetsLifecycle, byte for byte', () => {
    expect(committedTable).toBe(serializeTable(generateTable(timesheetsLifecycle)));
  });

  it('holds every state, action and role once unguarded and once under the blackout guard', () => {
    const combinations = TIMESHEET_STATES.flatMap((from) =>
      TIMESHEET_ACTIONS.flatMap((action) => TIMESHEET_ROLES.map((role) => rowKey({ from, action, role }))),
    ).sort();
    expect(rows).toHaveLength(180);
    expect(rows.every((row) => row.service === timesheetsLifecycle.service)).toBe(true);
    expect(unguarded.map(rowKey).sort()).toEqual(combinations);
    expect(guarded.map(rowKey).sort()).toEqual(combinations);
  });

  it('answers 8 unguarded rows legal, 16 wrong-role and 66 illegal, and every blackout row 409 blackout', () => {
    expect(countOutcomes(unguarded)).toEqual({ '200|null': 8, '403|authorization': 16, '409|illegalTransition': 66 });
    expect(countOutcomes(guarded)).toEqual({ '409|blackout': 90 });
  });

  it('rejects every action on a terminal day with 409', () => {
    const terminal: readonly string[] = timesheetsLifecycle.terminal;
    const fromTerminal = rows.filter((row) => terminal.includes(row.from));
    expect(fromTerminal.length).toBeGreaterThan(0);
    expect(fromTerminal.every((row) => row.expectedStatus === 409)).toBe(true);
  });
});

describe('opt2/reports/state-machines/timesheets.json', () => {
  it('declares the lifecycle service, aggregate, states, actions, roles and terminal states', () => {
    const { service, aggregate, states, actions, roles, terminal } = report;
    expect({ service, aggregate, states, actions, roles, terminal }).toEqual({
      service: timesheetsLifecycle.service,
      aggregate: 'timesheet_day',
      states: [...TIMESHEET_STATES],
      actions: [...TIMESHEET_ACTIONS],
      roles: [...TIMESHEET_ROLES],
      terminal: [...timesheetsLifecycle.terminal],
    });
  });

  it('carries every unguarded table row in generator order', () => {
    const byKey = new Map(report.rows.map((row) => [rowKey(row), row]));
    expect(report.rows).toHaveLength(unguarded.length);
    expect(byKey.size).toBe(unguarded.length);
    for (const row of unguarded) expect(byKey.get(rowKey(row)), rowKey(row)).toEqual(reportRowOf(row));
    const generatorOrder = generateTable(timesheetsLifecycle).filter((row) => row.guard === null).map(rowKey);
    expect(report.rows.map(rowKey)).toEqual(generatorOrder);
  });

  it('states the blackout rule every guarded row answers', () => {
    const { appliesTo, ...rule } = report.blackout;
    const rules = new Set(guarded.map((row) => JSON.stringify({ ...REPORT_OUTCOMES[row.expectedStatus], error: row.errorCode })));
    expect([...rules]).toEqual([JSON.stringify(rule)]);
    expect(typeof appliesTo).toBe('string');
  });
});

describe.each([V1_TARGET, FIXTURE_TARGET].map((target) => [target.title, target] as const))('%s', (_title, target) => {
  let testApp: TestApp;
  const headersByRole = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    testApp = await buildTestApp();
    for (const role of TIMESHEET_ROLES) headersByRole.set(role, await headersFor({ roles: [role] }));
  });

  afterAll(async () => {
    await testApp?.app.close();
  });

  /** Headers of a tenant-a user holding `role` alone. */
  function headersOf(role: string): Record<string, string> {
    const headers = headersByRole.get(role);
    if (headers === undefined) throw new Error(`no token for role ${role}`);
    return headers;
  }

  /** Seeds one tenant-a sheet whose only day is in `row.from`, blacked out for a guarded row, then empties the write log. */
  function seedDay(row: TransitionTableRow): TimesheetDayRow {
    const seeded = seedSheet(TENANT_A, { states: [row.from as TimesheetState], blackoutDays: row.guard === null ? [] : [0] });
    testApp.db.seed(toSeed(seeded));
    testApp.db.clear();
    const [day] = seeded.days as [TimesheetDayRow];
    return day;
  }

  function post(dayId: string, row: TransitionTableRow): Promise<Injected> {
    return testApp.app.inject({ method: 'POST', url: target.url(dayId, row.action), headers: headersOf(row.role) });
  }

  it.each(legalRows.map((row) => [caseTitle(row), row] as const))('%s', async (_title, row) => {
    const { db } = testApp;
    const seeded = seedDay(row);
    const actor = tokenSubject(headersOf(row.role));
    const res = await post(seeded.day_id, row);

    expect(res.statusCode).toBe(row.expectedStatus);
    const day: TimesheetDayRow = { ...seeded, state: String(row.to), lastupdate: TEST_CLOCK.now(), lastupdatebyid: actor };
    expect(storedDay(db, seeded.day_id)).toEqual(day);

    const writes = db.writes;
    const business = writes.filter((write) => write.table !== 'changelog');
    expect(business.map((write) => [write.table, write.op])).toEqual([
      ['timesheet_day', 'update'],
      ['approval_action', 'insert'],
    ]);
    const [dayWrite, auditWrite] = business;
    expect(dayWrite?.row).toEqual(day);
    const actionId = String(auditWrite?.row.action_id);
    const audit = approvalActionRow(day, {
      action: row.action as TimesheetAction,
      role: row.role as TimesheetRole,
      from: row.from as TimesheetState,
      to: row.to as TimesheetState,
      actor,
    });
    expect(auditWrite?.row).toEqual({ ...audit, action_id: actionId });

    const changes = writes.filter((write) => write.table === 'changelog');
    expect(changes.map((write) => [write.row.table, write.row.op, write.row.origin, write.row.actor_user_id])).toEqual(
      business.map((write) => [write.table, write.op, 'target', actor]),
    );
    expect(new Set(writes.map((write) => write.xid))).toEqual(new Set([db.lastXid]));
    expect(new Set(writes.map((write) => write.tenantId))).toEqual(new Set([TENANT_A.tenantId]));
    expect(parseWritePosition(res.headers[WRITE_POSITION_HEADER_LC] as string | undefined)).toEqual(
      new Map([[SERVICE_NAME, db.lastXid]]),
    );

    target.expectApplied(res, { row, day, actionId });
  });

  it.each(rejectedRows.map((row) => [caseTitle(row), row] as const))('%s', async (_title, row) => {
    const { db } = testApp;
    const seeded = seedDay(row);
    const res = await post(seeded.day_id, row);

    expect(res.statusCode).toBe(row.expectedStatus);
    target.expectRejected(res, row);
    expect(db.writes).toEqual([]);
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
    expect(storedDay(db, seeded.day_id)).toEqual(seeded);
  });

  it.each(TIMESHEET_ACTIONS)('answers %s on an unknown day 404 without writing', async (action) => {
    const row = legalRowFor(action);
    const [missing] = seedSheet(TENANT_A, { states: [row.from as TimesheetState] }).days as [TimesheetDayRow];
    testApp.db.clear();
    const res = await post(missing.day_id, row);

    target.expectNotFound(res, action);
    expect(testApp.db.writes).toEqual([]);
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeUndefined();
    expect(storedDay(testApp.db, missing.day_id)).toBeUndefined();
  });
});
