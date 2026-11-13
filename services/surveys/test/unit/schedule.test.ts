// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The fixture schedule route as the seam-2 producer, over the recording database: its one gated transaction, the flushed `surveys.survey.scheduled.v1` envelope, the fixture answer and the refusals. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTopicSchema } from '@opt2/platform/events';
import { GATE_WAIT_MS, WRITE_POSITION_HEADER } from '@opt2/platform/migration-kit';
import { TENANT_A, assertEventMatches } from '@opt2/platform/testing';
import { SURVEY_SCHEDULED_TOPIC } from '../../src/events/survey-scheduled.js';
import { FIXTURE_ERROR_MAP, fixtureMethod } from '../../src/legacy/fixture-envelope.js';
import { OWNER } from '../../src/repo/repository.js';
import { SURVEY_SCHEDULE } from '../../src/repo/tables.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { TEST_CLOCK, buildTestApp, headersFor, type RecordedTransaction, type TestApp } from '../helpers/app.js';

const payloadSchema = readTopicSchema(new URL('../../contracts/events/surveys.survey.scheduled.v1.json', import.meta.url));

const SITE = TENANT_A.siteId;
const OTHER_SITE = 'tenant-b';
const MANAGER = 'surveys.manager';
const TITLE = 'Quarterly pulse';
const PANEL = 'Survey Panel';
const LAUNCH_AT = '2026-07-01T09:00:00';
const REMINDERS = [{ offsetMinutes: 60 }, { offsetMinutes: 1440 }];
/** TEST_CLOCK's local time as the fixture writes timestamps. */
const BUSINESS_NOW = '2026-06-30T12:00:00';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
// The client recorder's identity answers every CSRF consume as valid.
const WRITE_HEADERS = { 'content-type': 'application/json', 'x-csrf_token': 'SCHEDULE-TOKEN', 'x-csrf_token_expires': '260630120000000' };
const LEGACY_UNAVAILABLE = { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } };
const WRITE_STATEMENT = /^(INSERT INTO|UPDATE|DELETE FROM) "?\w+"?\."?(\w+)"?/;

/** `<verb> <table>` counts of the statements of `tx` that write a table, e.g. `{ 'INSERT outbox': 1 }`. */
function writeCounts(tx: RecordedTransaction): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { text } of tx.statements) {
    const match = WRITE_STATEMENT.exec(text);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const key = `${match[1].split(' ')[0] ?? ''} ${match[2]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** Whether `tx` writes anything besides the outbox `published_at` stamp of the in-request flush. */
function writesBusinessRows(tx: RecordedTransaction): boolean {
  return Object.keys(writeCounts(tx)).some((key) => key !== 'UPDATE outbox');
}

describe(`POST ${FIXTURE_BASE}/{id}/schedule`, () => {
  let t: TestApp;
  let manager: Record<string, string>;
  let surveyId: string;
  let createdSurvey: Record<string, unknown>;
  let txStart: number;
  let taskStart: number;

  function post(url: string, headers: Record<string, string>, body: unknown) {
    return t.app.inject({ method: 'POST', url: `${url}?siteid=${SITE}`, headers: { ...headers, ...WRITE_HEADERS }, payload: JSON.stringify(body) });
  }

  function schedule(headers: Record<string, string> = manager, body: unknown = { launchAt: LAUNCH_AT, reminders: REMINDERS }) {
    return post(`${FIXTURE_BASE}/${surveyId}/schedule`, headers, body);
  }

  /** Marks the current end of the transaction log, publisher and task port, so assertions see only what follows. */
  function observeFromHere(): void {
    // db.clear() would also empty the seeded survey, so later requests are observed from this offset instead.
    txStart = t.db.transactions.length;
    taskStart = t.taskPort.tasks.length;
    t.publisher.clear();
  }

  function transactionsSinceStart(): readonly RecordedTransaction[] {
    return t.db.transactions.slice(txStart);
  }

  function businessTransactions(): RecordedTransaction[] {
    return transactionsSinceStart().filter((tx) => tx.committed && writesBusinessRows(tx));
  }

  /** The xid of the request's own write, from its `X-Opt2-Write-Position: surveys=<xid>` header. */
  function writtenXid(res: { headers: Record<string, unknown> }): string {
    const position = String(res.headers[WRITE_POSITION_HEADER.toLowerCase()]);
    expect(position).toMatch(/^surveys=\d+$/);
    return position.slice(`${OWNER}=`.length);
  }

  function changesOf(xid: string): [unknown, unknown][] {
    return t.db
      .rows('changelog')
      .filter((row) => row.xid === xid)
      .map((row) => [row.table, row.op]);
  }

  beforeEach(async () => {
    t = await buildTestApp();
    manager = await headersFor(MANAGER, { site: SITE });
    const created = await post(FIXTURE_BASE, manager, { title: TITLE });
    expect(created.statusCode).toBe(200);
    const { schedule: noSchedule, reminders, targets, ...survey } = (created.json() as { data: Record<string, unknown> }).data;
    expect({ status: survey.status, schedule: noSchedule, reminders, targets }).toEqual({ status: 'DRAFT', schedule: {}, reminders: [], targets: [] });
    createdSurvey = survey;
    surveyId = String(survey.survey_id);
    const targeted = await post(`${FIXTURE_BASE}/${surveyId}/targets/bulk`, manager, {
      targets: [{ siteID: OTHER_SITE }, { siteID: SITE, groupName: PANEL }],
    });
    expect(targeted.json()).toMatchObject({ data: { inserted: 2, total: 2 } });
    observeFromHere();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await t.app.close();
  });

  it('writes the schedule, both reminders, the SCHEDULED status, their changelog rows and one outbox row in one tenant transaction', async () => {
    expect(t.db.rows('survey_schedule')).toEqual([]);

    const res = await schedule();

    expect(res.statusCode).toBe(200);
    const business = businessTransactions();
    expect(business).toHaveLength(1);
    expect(business[0]?.tenantId).toBe(TENANT_A.tenantId);
    expect(writeCounts(business[0] as RecordedTransaction)).toEqual({
      'INSERT survey_schedule': 1,
      'INSERT survey_reminder': 2,
      'UPDATE survey': 1,
      'INSERT changelog': 4,
      'INSERT outbox': 1,
    });
    expect(t.db.rows('survey_schedule')).toEqual([
      expect.objectContaining({
        tenant_id: TENANT_A.tenantId,
        survey_id: surveyId,
        launch_at: new Date(2026, 6, 1, 9, 0, 0),
        schedule_version: 1,
        task_name: `opt2-survey-${surveyId}-launch`,
        row_version: '1',
      }),
    ]);
    expect(t.db.rows('survey_reminder').map(({ offset_minutes, remind_at, task_name, sent_at }) => ({ offset_minutes, remind_at, task_name, sent_at }))).toEqual([
      { offset_minutes: 60, remind_at: new Date(2026, 6, 1, 10, 0, 0), task_name: `opt2-survey-${surveyId}-reminder-1`, sent_at: null },
      { offset_minutes: 1440, remind_at: new Date(2026, 6, 2, 9, 0, 0), task_name: `opt2-survey-${surveyId}-reminder-2`, sent_at: null },
    ]);
    expect(t.db.rows('survey')).toEqual([expect.objectContaining({ survey_id: surveyId, status: 'SCHEDULED' })]);
    expect(changesOf(writtenXid(res))).toEqual([
      ['survey_schedule', 'insert'],
      ['survey_reminder', 'insert'],
      ['survey_reminder', 'insert'],
      ['survey', 'update'],
    ]);
    expect(t.db.rows('outbox')).toEqual([expect.objectContaining({ tenant_id: TENANT_A.tenantId, topic: SURVEY_SCHEDULED_TOPIC, kind: 'process' })]);
  });

  it('publishes one contract-valid surveys.survey.scheduled.v1 envelope, flushed before the answer', async () => {
    await schedule();

    expect(t.publisher.published.map((entry) => entry.topic)).toEqual([SURVEY_SCHEDULED_TOPIC]);
    const envelope = t.publisher.published[0]?.envelope;
    const [stored] = t.db.rows('survey_schedule');
    expect(envelope).toMatchObject({
      eventType: 'surveys.survey.scheduled',
      schemaVersion: '1.0.0',
      tenantId: TENANT_A.tenantId,
      occurredAt: TEST_CLOCK.now().toISOString(),
      producer: OWNER,
      aggregateType: 'survey-schedule',
      aggregateId: surveyId,
      aggregateVersion: Number(stored?.row_version),
    });
    expect(envelope?.payload).toEqual({
      surveyId,
      siteId: SITE,
      scheduleVersion: 1,
      launchAt: `${LAUNCH_AT}.000`,
      launchTaskName: `opt2-survey-${surveyId}-launch`,
      reminders: [
        { n: 1, offsetMinutes: 60, taskName: `opt2-survey-${surveyId}-reminder-1` },
        { n: 2, offsetMinutes: 1440, taskName: `opt2-survey-${surveyId}-reminder-2` },
      ],
      targets: [
        { siteId: SITE, groupName: PANEL },
        { siteId: OTHER_SITE, groupName: null },
      ],
    });
    expect(() => assertEventMatches(undefined, payloadSchema, envelope)).not.toThrow();
    // The fake task port never runs the outbox sweep, so only the in-request flush can have stamped the row.
    expect(t.db.rows('outbox')).toEqual([expect.objectContaining({ event_id: envelope?.eventId, published_at: TEST_CLOCK.now() })]);
  });

  it('answers the fixture survey detail with its write position and creates no task itself', async () => {
    const res = await schedule();

    expect(res.statusCode).toBe(200);
    expect(fixtureMethod('surveys', 'schedule')).toBe('surveys.surveys.schedule');
    const [stored] = t.db.rows('survey_schedule');
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: fixtureMethod('surveys', 'schedule'),
      data: {
        ...createdSurvey,
        status: 'SCHEDULED',
        schedule: {
          schedule_id: stored?.schedule_id,
          survey_id: surveyId,
          launch_at: LAUNCH_AT,
          schedule_version: 1,
          task_name: `opt2-survey-${surveyId}-launch`,
          created: BUSINESS_NOW,
        },
        reminders: [
          {
            reminder_id: expect.stringMatching(CF_UUID),
            survey_id: surveyId,
            offset_minutes: 60,
            remind_at: '2026-07-01T10:00:00',
            task_name: `opt2-survey-${surveyId}-reminder-1`,
            sent_at: '',
          },
          {
            reminder_id: expect.stringMatching(CF_UUID),
            survey_id: surveyId,
            offset_minutes: 1440,
            remind_at: '2026-07-02T09:00:00',
            task_name: `opt2-survey-${surveyId}-reminder-2`,
            sent_at: '',
          },
        ],
        // A whole-site target's NULL group reads as the empty string, as envelope.cfc rows() gives it.
        targets: [
          { target_id: expect.stringMatching(CF_UUID), survey_id: surveyId, siteid: SITE, group_name: PANEL, created: BUSINESS_NOW },
          { target_id: expect.stringMatching(CF_UUID), survey_id: surveyId, siteid: OTHER_SITE, group_name: '', created: BUSINESS_NOW },
        ],
      },
    });
    expect(changesOf(writtenXid(res))).not.toEqual([]);
    expect(t.taskPort.tasks.slice(taskStart)).toEqual([]);
    expect(t.client.requests.filter((req) => req.service === 'communications')).toEqual([]);
  });

  it('replaces the reminders on a reschedule and raises schedule_version and row_version by exactly one', async () => {
    expect((await schedule()).statusCode).toBe(200);
    const [first] = t.db.rows('survey_schedule');
    observeFromHere();

    const res = await schedule(manager, { launchAt: '2026-07-02T08:30:00', reminders: [{ offsetMinutes: 30 }] });

    expect(res.statusCode).toBe(200);
    const business = businessTransactions();
    expect(business).toHaveLength(1);
    expect(writeCounts(business[0] as RecordedTransaction)).toEqual({
      'UPDATE survey_schedule': 1,
      'DELETE survey_reminder': 2,
      'INSERT survey_reminder': 1,
      'INSERT changelog': 4,
      'INSERT outbox': 1,
    });
    expect(changesOf(writtenXid(res))).toEqual([
      ['survey_schedule', 'update'],
      ['survey_reminder', 'delete'],
      ['survey_reminder', 'delete'],
      ['survey_reminder', 'insert'],
    ]);
    const [second] = t.db.rows('survey_schedule');
    expect(second).toMatchObject({
      schedule_id: first?.schedule_id,
      created: first?.created,
      launch_at: new Date(2026, 6, 2, 8, 30, 0),
      schedule_version: Number(first?.schedule_version) + 1,
      row_version: String(Number(first?.row_version) + 1),
    });
    expect(t.db.rows('survey_reminder').map((row) => row.task_name)).toEqual([`opt2-survey-${surveyId}-reminder-1`]);
    expect(t.publisher.published.map(({ envelope }) => [envelope.aggregateVersion, envelope.payload])).toEqual([
      [
        2,
        expect.objectContaining({
          scheduleVersion: 2,
          launchAt: '2026-07-02T08:30:00.000',
          reminders: [{ n: 1, offsetMinutes: 30, taskName: `opt2-survey-${surveyId}-reminder-1` }],
        }),
      ],
    ]);
  });

  it('refuses a caller without the surveys.manager role with the fixture forbidden error before any tenant transaction', async () => {
    const res = await schedule(await headersFor('member', { site: SITE }));

    expect(res.statusCode).toBe(403);
    const { code, message } = FIXTURE_ERROR_MAP.forbidden;
    expect(res.json()).toEqual({ apiversion: 'v1', method: fixtureMethod('surveys', 'schedule'), error: { code, message } });
    expect(transactionsSinceStart().filter((tx) => tx.tenantId !== null || Object.keys(writeCounts(tx)).length > 0)).toEqual([]);
    expect(t.publisher.published).toEqual([]);
  });

  it('answers the legacy 503 and writes nothing while the schedule unit gate stays closed', async () => {
    t.db.setGate(SURVEY_SCHEDULE.unit, 'closed');
    // The gate budget runs on wall-clock Date: once the gated tenant transaction has fixed its deadline, jumping the
    // clock past GATE_WAIT_MS spends the 30 s wait at once.
    vi.useFakeTimers({ toFake: ['Date'] });
    const pending = schedule();
    await vi.waitFor(() => expect(transactionsSinceStart().some((tx) => tx.tenantId === TENANT_A.tenantId)).toBe(true), { interval: 1 });
    vi.setSystemTime(Date.now() + GATE_WAIT_MS);

    const res = await pending;

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(LEGACY_UNAVAILABLE);
    expect(businessTransactions()).toEqual([]);
    expect(t.db.rows('outbox')).toEqual([]);
    expect(t.db.rows('survey_schedule')).toEqual([]);
    expect(t.db.rows('survey')).toEqual([expect.objectContaining({ survey_id: surveyId, status: 'DRAFT' })]);
    expect(t.publisher.published).toEqual([]);
  });
});
