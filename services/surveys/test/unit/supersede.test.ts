// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** A reschedule supersedes the first schedule: its launch task and reminder callbacks answer 2xx without writing. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queueDefinition, targetUrl, taskWireBody } from '@opt2/platform/tasks';
import { TENANT_A, TENANT_B, mintTasksInvokerToken, mintUserToken } from '@opt2/platform/testing';
import { launchTaskName, reminderTaskName } from '../../src/domain/schedule.js';
import { SURVEY_SCHEDULED_TOPIC, type writeSurveyScheduled } from '../../src/events/survey-scheduled.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type RecordedTransaction, type TestApp } from '../helpers/app.js';

type ScheduledEnvelope = NonNullable<Awaited<ReturnType<typeof writeSurveyScheduled>>>;

/** The fixture survey detail fields these cases read. */
interface FixtureDetail {
  survey_id: string;
  status: string;
  schedule: { schedule_version: number };
  reminders: { reminder_id: string; offset_minutes: number; task_name: string; sent_at: string }[];
}

const SITE = TENANT_A.siteId;
const MANAGER = 'surveys.manager';
const COMMUNICATIONS = 'service:communications';
const JSON_HEADERS = { 'content-type': 'application/json' };
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
const FIRST_SCHEDULE = { launchAt: '2026-07-01T09:00:00', reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 120 }] };
const SECOND_SCHEDULE = {
  launchAt: '2026-07-02T10:30:00',
  reminders: [{ offsetMinutes: 30 }, { offsetMinutes: 90 }, { offsetMinutes: 240 }],
};
const SECOND_OFFSETS = [30, 90, 240];
const SENT_AT = '2026-07-02T11:00:02.500';
const WRITE_STATEMENT = /^(INSERT|UPDATE|DELETE)\b/i;
const LAUNCH_QUEUE = queueDefinition('surveys-launch');

describe('reschedule supersession', () => {
  let t: TestApp;
  let surveyId: string;
  let firstReminderIds: string[];
  let rescheduled: FixtureDetail;

  async function postAsManager(url: string, body: unknown) {
    return t.app.inject({
      method: 'POST',
      url,
      headers: { ...(await headersFor(MANAGER)), ...CSRF_HEADERS, ...JSON_HEADERS },
      payload: JSON.stringify(body),
    });
  }

  async function schedule(body: unknown): Promise<FixtureDetail> {
    const res = await postAsManager(`${FIXTURE_BASE}/${surveyId}/schedule?siteid=${SITE}`, body);
    expect(res.statusCode).toBe(200);
    return res.json<{ data: FixtureDetail }>().data;
  }

  /** Transactions started after `mark` that ran any INSERT, UPDATE or DELETE, committed or not. */
  function writesSince(mark: number): RecordedTransaction[] {
    return t.db.transactions.slice(mark).filter((tx) => tx.statements.some((statement) => WRITE_STATEMENT.test(statement.text)));
  }

  function storedSurvey(): Record<string, unknown> | undefined {
    return t.db.rows('survey').find((row) => row.survey_id === surveyId);
  }

  function storedReminders(): Record<string, unknown>[] {
    return t.db.rows('survey_reminder').filter((row) => row.survey_id === surveyId);
  }

  function scheduledEnvelopes(): ScheduledEnvelope[] {
    return t.publisher.published
      .filter(({ topic, envelope }) => topic === SURVEY_SCHEDULED_TOPIC && envelope.aggregateId === surveyId)
      .map(({ envelope }) => envelope as ScheduledEnvelope);
  }

  /** Delivers the `surveys-launch` task communications would have created for `scheduleVersion`. */
  async function deliverLaunchTask(scheduleVersion: number) {
    const url = new URL(targetUrl(LAUNCH_QUEUE, t.env.OPT2_SERVICE_URLS, { surveyId }));
    const body = taskWireBody({
      queue: LAUNCH_QUEUE.name,
      name: launchTaskName(surveyId),
      scheduleTime: t.clock.now(),
      url: url.href,
      deadlineS: LAUNCH_QUEUE.deadlineS,
      tenantId: TENANT_A.tenantId,
      body: { surveyId, siteId: SITE, scheduleVersion },
    });
    const token = await mintTasksInvokerToken({ audience: t.env.OPT2_SERVICE_NAME });
    return t.app.inject({
      method: 'POST',
      url: url.pathname,
      headers: { authorization: `Bearer ${token}`, ...JSON_HEADERS },
      payload: JSON.stringify(body),
    });
  }

  /** Posts communications' `markReminderSent` for reminder `n` at schedule version 2 unless `overrides` say otherwise. */
  async function postReminderSent(n: number, overrides: Record<string, unknown> = {}, headers?: Record<string, string>) {
    const body = {
      tenantId: TENANT_A.tenantId,
      siteId: SITE,
      taskName: reminderTaskName(surveyId, n),
      scheduleVersion: 2,
      sentAt: SENT_AT,
      ...overrides,
    };
    return t.app.inject({
      method: 'POST',
      url: `/internal/v1/surveys/${surveyId}/reminders/${String(n)}/sent`,
      headers: { ...(headers ?? (await headersFor(COMMUNICATIONS))), ...JSON_HEADERS },
      payload: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    t = await buildTestApp();
    const created = await postAsManager(`${FIXTURE_BASE}?siteid=${SITE}`, { title: 'Pulse' });
    expect(created.statusCode).toBe(200);
    surveyId = created.json<{ data: FixtureDetail }>().data.survey_id;
    firstReminderIds = (await schedule(FIRST_SCHEDULE)).reminders.map((reminder) => reminder.reminder_id);
    rescheduled = await schedule(SECOND_SCHEDULE);
  });

  afterEach(async () => {
    await t.app.close();
  });

  describe('surveys.survey.scheduled.v1', () => {
    it('announces the reschedule as a second envelope of the same aggregate at a higher version', () => {
      const envelopes = scheduledEnvelopes();
      expect(envelopes).toHaveLength(2);
      const [first, second] = envelopes as [ScheduledEnvelope, ScheduledEnvelope];
      expect(second.aggregateId).toBe(first.aggregateId);
      expect(second.aggregateVersion).toBeGreaterThan(first.aggregateVersion);
      expect(second.eventId).not.toBe(first.eventId);
      expect([first.payload.scheduleVersion, second.payload.scheduleVersion]).toEqual([1, 2]);
      expect(second.tenantId).toBe(TENANT_A.tenantId);
      expect(second.payload).toMatchObject({
        surveyId,
        siteId: SITE,
        launchAt: '2026-07-02T10:30:00.000',
        launchTaskName: launchTaskName(surveyId),
        reminders: SECOND_OFFSETS.map((offsetMinutes, index) => ({
          n: index + 1,
          offsetMinutes,
          taskName: reminderTaskName(surveyId, index + 1),
        })),
      });
    });

    it('replaces the first schedule reminders instead of appending to them', () => {
      expect(rescheduled.schedule.schedule_version).toBe(2);
      expect(rescheduled.reminders.map((reminder) => reminder.offset_minutes)).toEqual(SECOND_OFFSETS);
      const stored = storedReminders();
      expect(stored.map((row) => row.offset_minutes)).toEqual(SECOND_OFFSETS);
      expect(stored.map((row) => row.task_name)).toEqual(SECOND_OFFSETS.map((_, index) => reminderTaskName(surveyId, index + 1)));
      expect(stored.filter((row) => firstReminderIds.includes(String(row.reminder_id)))).toEqual([]);
    });
  });

  describe('surveys-launch task', () => {
    it('answers a task of the first schedule applied false and leaves the survey SCHEDULED without a write', async () => {
      const mark = t.db.transactions.length;
      const res = await deliverLaunchTask(1);
      expect([res.statusCode, res.json()]).toEqual([200, { applied: false, status: 'SCHEDULED' }]);
      expect(writesSince(mark)).toEqual([]);
      expect(storedSurvey()).toMatchObject({ status: 'SCHEDULED', launched_at: null });
    });

    it('launches the survey on the task of the current schedule', async () => {
      const mark = t.db.transactions.length;
      const res = await deliverLaunchTask(2);
      expect([res.statusCode, res.json()]).toEqual([200, { applied: true, status: 'LAUNCHED' }]);
      expect(writesSince(mark).map((tx) => tx.tenantId)).toEqual([TENANT_A.tenantId]);
      expect(storedSurvey()).toMatchObject({ status: 'LAUNCHED' });
    });

    it('keeps a late task of the first schedule superseded after the current launch', async () => {
      expect((await deliverLaunchTask(2)).statusCode).toBe(200);
      const mark = t.db.transactions.length;
      const late = await deliverLaunchTask(1);
      expect([late.statusCode, late.json()]).toEqual([200, { applied: false, status: 'LAUNCHED' }]);
      expect(writesSince(mark)).toEqual([]);
    });
  });

  describe('markReminderSent', () => {
    it('answers a callback of the first schedule applied false without stamping the reminder', async () => {
      const mark = t.db.transactions.length;
      const res = await postReminderSent(1, { scheduleVersion: 1 });
      expect([res.statusCode, res.json()]).toEqual([200, { applied: false }]);
      expect(writesSince(mark)).toEqual([]);
      expect(storedReminders().map((row) => row.sent_at)).toEqual([null, null, null]);
    });

    it('stamps the current schedule reminder in one tenant-a write with its changelog row', async () => {
      const mark = t.db.transactions.length;
      const changelogBefore = t.db.rows('changelog').length;
      const res = await postReminderSent(1);
      expect([res.statusCode, res.json()]).toEqual([200, { applied: true }]);

      const writes = writesSince(mark);
      expect(writes.map((tx) => [tx.tenantId, tx.committed])).toEqual([[TENANT_A.tenantId, true]]);
      const written = writes[0]?.statements.filter((statement) => WRITE_STATEMENT.test(statement.text)).map((statement) => statement.text);
      expect(written).toEqual([expect.stringMatching(/^UPDATE "surveys"\."survey_reminder"/), expect.stringMatching(/^INSERT INTO "surveys"\."changelog"/)]);

      const changelog = t.db.rows('changelog');
      expect(changelog).toHaveLength(changelogBefore + 1);
      expect(changelog.at(-1)).toMatchObject({ tenant_id: TENANT_A.tenantId, table: 'survey_reminder', op: 'update' });
      expect(storedReminders().map((row) => row.sent_at)).toEqual([new Date(SENT_AT), null, null]);
    });

    it('answers a repeat of the current callback applied false without a write', async () => {
      expect((await postReminderSent(1)).json()).toEqual({ applied: true });
      const mark = t.db.transactions.length;
      const repeat = await postReminderSent(1, { sentAt: '2026-07-02T12:00:00.000' });
      expect([repeat.statusCode, repeat.json()]).toEqual([200, { applied: false }]);
      expect(writesSince(mark)).toEqual([]);
      expect(storedReminders()[0]?.sent_at).toEqual(new Date(SENT_AT));
    });

    it.each<[string, number, Record<string, unknown>]>([
      ['a reminder ordinal the current schedule lacks', 4, {}],
      ["another tenant's id, under which the survey is invisible", 1, { tenantId: TENANT_B.tenantId }],
    ])('answers the legacy 404 without a write for %s', async (_label, n, overrides) => {
      const mark = t.db.transactions.length;
      const res = await postReminderSent(n, overrides);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
      expect(writesSince(mark)).toEqual([]);
      expect(storedReminders().map((row) => row.sent_at)).toEqual([null, null, null]);
    });

    it('refuses user credentials, so only communications can record a sent reminder', async () => {
      const userToken = await mintUserToken({ sub: 'test-surveys.manager', site: SITE, roles: [MANAGER] });
      const refusals: Array<[Record<string, string>, number]> = [
        [{ authorization: `Bearer ${userToken}` }, 401],
        [await headersFor(MANAGER), 403],
      ];
      const mark = t.db.transactions.length;
      for (const [headers, status] of refusals) {
        expect((await postReminderSent(1, {}, headers)).statusCode).toBe(status);
      }
      expect(writesSince(mark)).toEqual([]);
      expect(storedReminders().map((row) => row.sent_at)).toEqual([null, null, null]);
    });
  });
});
