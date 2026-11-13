// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey create, list and detail on the fixture routes, then the `surveys-launch` task route: outcomes, tenant re-check, gate and credential. */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ERROR_MAP, isCfUuid } from '@opt2/platform/legacy-compat';
import { GATE_WAIT_MS } from '@opt2/platform/migration-kit';
import { TaskTenantMismatchError, taskWireBody, type TaskWireBody } from '@opt2/platform/tasks';
import { TENANT_A, TENANT_B, mintTasksInvokerToken } from '@opt2/platform/testing';
import { SURVEY_STATUS } from '../../src/domain/surveys.js';
import { LAUNCH_TASK_PATH, type LaunchTaskResult } from '../../src/tasks/launch.js';
import { buildTestApp, headersFor, type RecordingDb, type TestApp } from '../helpers/app.js';

const FIXTURE_SURVEYS = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const MANAGER = 'surveys.manager';
const LAUNCH_QUEUE = 'surveys-launch';
const SURVEY_UNIT = 'surveys.survey';
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const UNKNOWN_SURVEY_ID = '00000000-0000-0000-0000000000000000';
const LAUNCH_AT = '2026-07-01T09:00:00';
const REOPEN_AFTER_MS = 300;
// envelope.cfc's notFound row, which the fixture answers for an unknown survey.
const FIXTURE_NOT_FOUND = { code: 'invalid_request', message: 'Not Found' };

type FixtureSurvey = {
  survey_id: string;
  siteid: string;
  title: string;
  status: string;
  created: string;
  createdbyid: string;
  lastupdate: string;
  lastupdatebyid: string;
  launched_at: string;
};
type FixtureDetail = FixtureSurvey & { schedule: Record<string, unknown>; reminders: unknown[]; targets: unknown[] };
type FixtureList = {
  items: FixtureSurvey[];
  startindex: number;
  endindex: number;
  itemsperpage: number;
  totalitems: number;
  totalpages: number;
  pageindex: number;
};
type Envelope<T> = { data: T };
type ErrorEnvelope = { error: { code: string; message: string } };
type InjectRequest = { method: 'POST'; url: string; headers: Record<string, string>; payload: TaskWireBody };

/** Committed transactions that wrote a changelog row, the audit record every gated write leaves. */
function writeTransactions(db: RecordingDb) {
  return db.transactions.filter((tx) => tx.committed && tx.statements.some((statement) => /^INSERT INTO \S*changelog\b/i.test(statement.text)));
}

/** Stored changelog rows of the `survey` table. */
function surveyChangelog(db: RecordingDb) {
  return db.rows('changelog').filter((row) => row.table === 'survey');
}

function storedSurvey(db: RecordingDb, surveyId: string): Record<string, unknown> | undefined {
  return db.rows('survey').find((row) => row.survey_id === surveyId);
}

/**
 * Runs `start` with only Date faked, stepping it 1 s per real 25 ms until the call settles, so a 30 s gate budget elapses in
 * about a second while the gate polls and the database run in real time; `elapsedMs` is the faked time the call took.
 */
async function underSteppedDate<T>(start: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const started = Date.now();
    let settled = false;
    const pending = start().finally(() => {
      settled = true;
    });
    while (!settled) {
      await sleep(25);
      vi.setSystemTime(Date.now() + 1_000);
    }
    return { result: await pending, elapsedMs: Date.now() - started };
  } finally {
    vi.useRealTimers();
  }
}

describe('surveys fixture CRUD and the surveys-launch task', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
  });

  afterEach(async () => {
    await t.app.close();
  });

  async function asManager(method: 'GET' | 'POST', url: string, opts: { site?: string; body?: unknown } = {}) {
    const site = opts.site ?? TENANT_A.siteId;
    const auth = await headersFor(MANAGER, { site });
    const query = `${url.includes('?') ? '&' : '?'}siteid=${site}`;
    return t.app.inject({
      method,
      url: `${url}${query}`,
      headers: { ...auth, ...CSRF_HEADERS, ...(opts.body === undefined ? {} : JSON_HEADERS) },
      payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  async function createSurvey(title = 'Quarterly pulse'): Promise<FixtureDetail> {
    const res = await asManager('POST', FIXTURE_SURVEYS, { body: { title } });
    expect(res.statusCode).toBe(200);
    return (res.json() as Envelope<FixtureDetail>).data;
  }

  async function scheduleSurvey(surveyId: string): Promise<FixtureDetail> {
    const res = await asManager('POST', `${FIXTURE_SURVEYS}/${surveyId}/schedule`, {
      body: { launchAt: LAUNCH_AT, reminders: [{ offsetMinutes: 60 }] },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as Envelope<FixtureDetail>).data;
  }

  /** The `surveys-launch` task communications creates for the survey, as Cloud Tasks delivers it with the tasks-invoker credential. */
  async function launchRequest(
    surveyId: string,
    { tenantId, scheduleVersion }: { tenantId: string; scheduleVersion: number },
  ): Promise<InjectRequest> {
    const path = LAUNCH_TASK_PATH.replace(':surveyId', surveyId);
    const token = await mintTasksInvokerToken({ audience: t.env.OPT2_SERVICE_NAME });
    const payload = taskWireBody({
      queue: LAUNCH_QUEUE,
      name: `opt2-survey-${surveyId}-launch`,
      scheduleTime: t.clock.now(),
      url: `${t.env.OPT2_SERVICE_URLS[t.env.OPT2_SERVICE_NAME] ?? ''}${path}`,
      deadlineS: 600,
      tenantId,
      body: { surveyId, siteId: TENANT_A.siteId, scheduleVersion },
    });
    return { method: 'POST', url: path, headers: { authorization: `Bearer ${token}` }, payload };
  }

  async function scheduledSurvey(): Promise<{ surveyId: string; scheduleVersion: number }> {
    const created = await createSurvey();
    const scheduled = await scheduleSurvey(created.survey_id);
    return { surveyId: created.survey_id, scheduleVersion: scheduled.schedule.schedule_version as number };
  }

  describe('fixture survey collection', () => {
    it('creates a DRAFT survey of the token site with a CF UUID in one audited tenant-a transaction', async () => {
      const before = writeTransactions(t.db).length;

      const created = await createSurvey('Quarterly pulse');

      expect(isCfUuid(created.survey_id)).toBe(true);
      expect(created.survey_id).toHaveLength(35);
      expect(created).toEqual({
        survey_id: created.survey_id,
        siteid: TENANT_A.siteId,
        title: 'Quarterly pulse',
        status: SURVEY_STATUS.DRAFT,
        created: '2026-06-30T12:00:00',
        createdbyid: `test-${MANAGER}`,
        lastupdate: '',
        lastupdatebyid: '',
        launched_at: '',
        schedule: {},
        reminders: [],
        targets: [],
      });
      const writes = writeTransactions(t.db).slice(before);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.tenantId).toBe(TENANT_A.tenantId);
      expect(surveyChangelog(t.db)).toEqual([expect.objectContaining({ tenant_id: TENANT_A.tenantId, op: 'insert' })]);
      expect(storedSurvey(t.db, created.survey_id)).toMatchObject({ tenant_id: TENANT_A.tenantId, status: SURVEY_STATUS.DRAFT });
    });

    it("lists the site's surveys in the fixture paging struct, and none of them to a tenant-b manager", async () => {
      const created = await createSurvey();

      const listed = await asManager('GET', FIXTURE_SURVEYS);
      expect(listed.statusCode).toBe(200);
      const page = (listed.json() as Envelope<FixtureList>).data;
      expect(page).toEqual({
        items: [expect.objectContaining({ survey_id: created.survey_id, siteid: TENANT_A.siteId, status: SURVEY_STATUS.DRAFT })],
        startindex: 1,
        endindex: 1,
        itemsperpage: 50,
        totalitems: 1,
        totalpages: 1,
        pageindex: 1,
      });

      const other = await asManager('GET', FIXTURE_SURVEYS, { site: TENANT_B.siteId });
      expect(other.statusCode).toBe(200);
      expect((other.json() as Envelope<FixtureList>).data).toMatchObject({ items: [], totalitems: 0 });
    });

    it('answers the survey detail with schedule, reminders and targets, and notFound for an unknown id', async () => {
      const created = await createSurvey();

      const found = await asManager('GET', `${FIXTURE_SURVEYS}/${created.survey_id}`);
      expect(found.statusCode).toBe(200);
      expect((found.json() as Envelope<FixtureDetail>).data).toEqual(created);

      const missing = await asManager('GET', `${FIXTURE_SURVEYS}/${UNKNOWN_SURVEY_ID}`);
      expect(missing.statusCode).toBe(404);
      expect((missing.json() as ErrorEnvelope).error).toEqual(FIXTURE_NOT_FOUND);
    });

    it('schedules the survey at version 1 with its reminder, leaving it SCHEDULED and not yet launched', async () => {
      const created = await createSurvey();

      const scheduled = await scheduleSurvey(created.survey_id);

      expect(scheduled).toMatchObject({ survey_id: created.survey_id, status: SURVEY_STATUS.SCHEDULED, launched_at: '' });
      expect(scheduled.schedule).toMatchObject({
        survey_id: created.survey_id,
        launch_at: LAUNCH_AT,
        schedule_version: 1,
        task_name: `opt2-survey-${created.survey_id}-launch`,
      });
      expect(scheduled.reminders).toEqual([expect.objectContaining({ offset_minutes: 60, remind_at: '2026-07-01T10:00:00', sent_at: '' })]);
      expect(t.db.rows('survey_schedule')).toEqual([
        expect.objectContaining({ tenant_id: TENANT_A.tenantId, survey_id: created.survey_id, schedule_version: 1 }),
      ]);
    });
  });

  describe('surveys-launch task route', () => {
    it('launches the scheduled survey at the current schedule version in one audited tenant-a transaction', async () => {
      const { surveyId, scheduleVersion } = await scheduledSurvey();
      const writesBefore = writeTransactions(t.db).length;
      const changelogBefore = surveyChangelog(t.db).length;

      const res = await t.app.inject(await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion }));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ applied: true, status: SURVEY_STATUS.LAUNCHED } satisfies LaunchTaskResult);
      expect(storedSurvey(t.db, surveyId)).toMatchObject({ status: SURVEY_STATUS.LAUNCHED, launched_at: t.clock.now() });
      const writes = writeTransactions(t.db).slice(writesBefore);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.tenantId).toBe(TENANT_A.tenantId);
      expect(surveyChangelog(t.db).slice(changelogBefore)).toEqual([
        expect.objectContaining({ tenant_id: TENANT_A.tenantId, op: 'update' }),
      ]);
    });

    it('answers a repeated launch with the stored LAUNCHED status and writes nothing', async () => {
      const { surveyId, scheduleVersion } = await scheduledSurvey();
      const first = await t.app.inject(await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion }));
      expect(first.statusCode).toBe(200);
      const writesBefore = writeTransactions(t.db).length;

      const repeat = await t.app.inject(await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion }));

      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toEqual({ applied: false, status: SURVEY_STATUS.LAUNCHED } satisfies LaunchTaskResult);
      expect(writeTransactions(t.db)).toHaveLength(writesBefore);
    });

    it('answers a task of an older schedule version with the stored status and writes nothing', async () => {
      const { surveyId, scheduleVersion } = await scheduledSurvey();
      const rescheduled = await scheduleSurvey(surveyId);
      expect(rescheduled.schedule.schedule_version).toBe(scheduleVersion + 1);
      const writesBefore = writeTransactions(t.db).length;

      const res = await t.app.inject(await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion }));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ applied: false, status: SURVEY_STATUS.SCHEDULED } satisfies LaunchTaskResult);
      expect(writeTransactions(t.db)).toHaveLength(writesBefore);
      expect(storedSurvey(t.db, surveyId)).toMatchObject({ status: SURVEY_STATUS.SCHEDULED, launched_at: null });
    });

    it.each<[string, (surveyId: string, scheduleVersion: number) => Promise<InjectRequest>]>([
      ['a body naming tenant-b for a tenant-a survey', (id, scheduleVersion) => launchRequest(id, { tenantId: TENANT_B.tenantId, scheduleVersion })],
      [
        'a task URL naming another survey than its payload',
        async (id, scheduleVersion) => ({
          ...(await launchRequest(id, { tenantId: TENANT_A.tenantId, scheduleVersion })),
          url: LAUNCH_TASK_PATH.replace(':surveyId', UNKNOWN_SURVEY_ID),
        }),
      ],
      ['a payload outside LaunchPayload', (id) => launchRequest(id, { tenantId: TENANT_A.tenantId, scheduleVersion: 0 })],
    ])("refuses %s as the platform's task tenant mismatch", async (_name, buildRequest) => {
      const { surveyId, scheduleVersion } = await scheduledSurvey();
      const writesBefore = writeTransactions(t.db).length;
      const mismatch = new TaskTenantMismatchError(TENANT_A.tenantId, `opt2-survey-${surveyId}-launch`);

      const res = await t.app.inject(await buildRequest(surveyId, scheduleVersion));

      const spec = LEGACY_ERROR_MAP[mismatch.type];
      expect(res.statusCode).toBe(spec.status);
      expect((res.json() as ErrorEnvelope).error).toEqual({ message: spec.message, code: spec.code });
      expect(writeTransactions(t.db)).toHaveLength(writesBefore);
      expect(storedSurvey(t.db, surveyId)).toMatchObject({ status: SURVEY_STATUS.SCHEDULED, launched_at: null });
    });

    it('waits out a closed survey gate for the gate budget, answers the legacy 503 and launches on the retry after it reopens', async () => {
      const { surveyId, scheduleVersion } = await scheduledSurvey();
      const writesBefore = writeTransactions(t.db).length;
      t.db.setGate(SURVEY_UNIT, 'closed');
      const request = await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion });

      const { result: blocked, elapsedMs } = await underSteppedDate(() => t.app.inject(request));

      expect(elapsedMs).toBeGreaterThanOrEqual(GATE_WAIT_MS);
      expect(blocked.statusCode).toBe(503);
      expect((blocked.json() as ErrorEnvelope).error).toEqual({
        message: LEGACY_ERROR_MAP.server_error.message,
        code: LEGACY_ERROR_MAP.server_error.code,
      });
      expect(writeTransactions(t.db)).toHaveLength(writesBefore);
      expect(storedSurvey(t.db, surveyId)).toMatchObject({ status: SURVEY_STATUS.SCHEDULED, launched_at: null });

      t.db.setGate(SURVEY_UNIT, 'open');
      const retried = await t.app.inject(await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion }));

      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual({ applied: true, status: SURVEY_STATUS.LAUNCHED } satisfies LaunchTaskResult);
      expect(writeTransactions(t.db)).toHaveLength(writesBefore + 1);
    });

    it('lets a launch waiting on a closed survey gate proceed once the gate reopens within the budget', async () => {
      const { surveyId, scheduleVersion } = await scheduledSurvey();
      t.db.setGate(SURVEY_UNIT, 'closed');
      let settled = false;
      const pending = t.app
        .inject(await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion }))
        .finally(() => {
          settled = true;
        });

      await sleep(REOPEN_AFTER_MS);
      expect(settled).toBe(false);
      t.db.setGate(SURVEY_UNIT, 'open');
      const res = await pending;

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ applied: true, status: SURVEY_STATUS.LAUNCHED } satisfies LaunchTaskResult);
      expect(storedSurvey(t.db, surveyId)).toMatchObject({ status: SURVEY_STATUS.LAUNCHED });
    });

    it.each<[string, () => Promise<Record<string, string>>]>([
      ['no credential', async () => ({})],
      ['a surveys.manager user token', () => headersFor(MANAGER)],
    ])('refuses %s with 401 before the handler runs', async (_name, credential) => {
      const { surveyId, scheduleVersion } = await scheduledSurvey();
      const transactionsBefore = t.db.transactions.length;
      const request = await launchRequest(surveyId, { tenantId: TENANT_A.tenantId, scheduleVersion });

      const res = await t.app.inject({ ...request, headers: await credential() });

      expect(res.statusCode).toBe(401);
      expect(t.db.transactions).toHaveLength(transactionsBefore);
      expect(storedSurvey(t.db, surveyId)).toMatchObject({ status: SURVEY_STATUS.SCHEDULED, launched_at: null });
    });
  });
});
