// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * Fixture day-action answers through `app.inject` over the recording db, as legacy-fixtures/cfml/lib/envelope.cfc and modules/timesheets.cfc
 * write them. The envelope and projection functions' own cases live in legacy-envelope-direct.test.ts and are not repeated here.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_JSON_CONTENT_TYPE, apiUnavailableResponse, etag, legacyHeaders } from '@opt2/platform/legacy-compat';
import { GATE_WAIT_MS } from '@opt2/platform/migration-kit';
import { TRANSITION_ERROR_CODES } from '@opt2/platform/state-machine';
import { TENANT_A } from '@opt2/platform/testing';
import type { TimesheetAction, TimesheetRole } from '../../src/domain/lifecycle.transitions.js';
import { FIXTURE_ERROR_MAP, fixtureOutcomeReason, type FixtureErrorType } from '../../src/legacy/envelope.js';
import { TIMESHEET_DAY, type TimesheetDayRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { buildTestApp, createRecordingDb, headersFor, type RecordingDb, type TestApp } from '../helpers/app.js';
import { dayRow as dayFixtureRow, seedSheet, timesheetRow, toSeed } from '../helpers/days.js';

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;
/** The seeded open DRAFT day, the seeded blacked-out DRAFT day, or a day no tenant holds. */
type DayTarget = 'open' | 'blackedOut' | 'missing';

const EMPLOYEE: TimesheetRole = 'timesheets.employee';
const PRIMARY_APPROVER: TimesheetRole = 'timesheets.primary-approver';
const MISSING_DAY_ID = '00000000-0000-0000-0000000000000000';
// Faked wall-clock advance per real tick: a 30 s gate budget runs out in well under a second of test time.
const CLOCK_STEP_MS = 100;

/** `headers` with lower-cased names, as `app.inject` reports response headers. */
function lowerCased(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** Asserts what every fixture answer carries: the JSON content type, the ETag of its exact body and the legacy headers. */
function expectLegacyWire(res: Injected): void {
  expect(res.headers).toMatchObject(lowerCased({ 'Content-Type': LEGACY_JSON_CONTENT_TYPE, ETag: etag(res.body), ...legacyHeaders() }));
}

/** Exact body envelope.cfc fail() writes for `type`: code before message, the type's default message unless `message` is given. */
function fixtureErrorBody(method: string, type: FixtureErrorType, message?: string): string {
  const { code, message: fallback } = FIXTURE_ERROR_MAP[type];
  return JSON.stringify({ apiversion: 'v1', method, error: { code, message: message ?? fallback } });
}

/** Awaits `pending` while moving the faked wall clock ahead each real millisecond, so a gate wait spends its budget at once. */
async function withHurriedClock<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  const ticker = (async () => {
    while (!settled) {
      vi.setSystemTime(Date.now() + CLOCK_STEP_MS);
      await sleep(1);
    }
  })();
  try {
    return await pending;
  } finally {
    settled = true;
    await ticker;
  }
}

describe('timesheets fixture day-action envelope', () => {
  let db: RecordingDb;
  let app: TestApp['app'];
  let dayIds: Record<DayTarget, string>;

  beforeEach(async () => {
    const seeded = seedSheet(TENANT_A, { states: ['DRAFT', 'DRAFT'], blackoutDays: [1] });
    const [open, blackedOut] = seeded.days as [TimesheetDayRow, TimesheetDayRow];
    dayIds = { open: open.day_id, blackedOut: blackedOut.day_id, missing: MISSING_DAY_ID };
    db = createRecordingDb(toSeed(seeded));
    ({ app } = await buildTestApp({ db }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  /** POSTs `action` on day `dayId` as a tenant-a system user holding `role`, with valid CSRF headers. */
  async function act(dayId: string, action: TimesheetAction, role: TimesheetRole): Promise<Injected> {
    return app.inject({ method: 'POST', url: `${FIXTURE_PREFIX}/days/${dayId}/${action}`, headers: await headersFor(role) });
  }

  it.each(['0.0000', '7.5000', '12.2500'])('answers a legal submit with the re-read day, its stored hours %s as four-decimal text', async (hours) => {
    const sheet = timesheetRow({ tenant: TENANT_A });
    const day = dayFixtureRow(sheet, { workDate: '2026-06-08', hours });
    db.seed(toSeed({ sheet, days: [day], blackouts: [] }));

    const res = await act(day.day_id, 'submit', EMPLOYEE);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(
      JSON.stringify({
        apiversion: 'v1',
        method: 'timesheets.days.submit',
        data: { day_id: day.day_id, timesheet_id: sheet.timesheet_id, work_date: '2026-06-08T00:00:00', hours, state: 'SUBMITTED', isblackout: false },
      }),
    );
    expectLegacyWire(res);
    expect(db.rowsOf('timesheet_day', TENANT_A.tenantId).find((row) => row.day_id === day.day_id)?.state).toBe('SUBMITTED');
  });

  it.each<[string, DayTarget, TimesheetAction, TimesheetRole, number, FixtureErrorType, string | undefined]>([
    ['a wrong-role action as forbidden', 'open', 'submit', PRIMARY_APPROVER, 403, 'forbidden', undefined],
    ['an illegal-state action as a conflict naming illegalTransition', 'open', 'resubmit', EMPLOYEE, 409, 'conflict', TRANSITION_ERROR_CODES.illegal],
    ['an action on a blacked-out day as a conflict naming blackout', 'blackedOut', 'submit', EMPLOYEE, 409, 'conflict', 'blackout'],
    ['an unknown day as notFound', 'missing', 'submit', EMPLOYEE, 404, 'notFound', undefined],
  ])('answers %s in the fixture error envelope, writing nothing', async (_label, target, action, role, status, type, message) => {
    const res = await act(dayIds[target], action, role);

    expect(res.statusCode).toBe(status);
    expect(res.body).toBe(fixtureErrorBody(`timesheets.days.${action}`, type, message));
    expectLegacyWire(res);
    expect(db.writes).toEqual([]);
  });

  it('answers a write still held by a closed gate after its wait budget with the legacy 503, writing nothing', async () => {
    db.setGate(TIMESHEET_DAY.unit, 'closed');
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = Date.now();

    const res = await withHurriedClock(act(dayIds.open, 'submit', EMPLOYEE));

    const expected = apiUnavailableResponse();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(GATE_WAIT_MS);
    expect([res.statusCode, res.body]).toEqual([expected.status, expected.body]);
    expect(res.headers).toMatchObject(lowerCased(expected.headers));
    expect(db.writes).toEqual([]);
  });
});

describe('fixtureOutcomeReason', () => {
  it.each([new Error('boom'), 'boom', undefined])('names %j, which no fixture rule recognises, server_error', (err) => {
    expect(fixtureOutcomeReason(err)).toBe('server_error');
  });
});
