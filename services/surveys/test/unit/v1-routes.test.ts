// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `/v1/surveys` routes over a throwaway `surveys` schema: paged survey and response lists with their totals, batched schedule reads and `{data}` reads. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { TASK_PAGE_MAX } from '../../src/domain/tasks-list.js';
import type { components } from '../../src/generated/openapi.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/fixture-envelope.js';
import { TARGET_PAGE_DEFAULT, TARGET_PAGE_MAX } from '../../src/repo/queries.js';
import { createSurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { registerV1Routes } from '../../src/routes/v1.js';
import { createClientRecorder, defaultScheduledTasks } from '../helpers/app.js';

type Survey = components['schemas']['Survey'];
type SurveyResponse = components['schemas']['SurveyResponse'];
type SurveyTarget = components['schemas']['SurveyTarget'];
type Page<T> = { data: T[]; total: number };
type TargetPage = { data: SurveyTarget[]; next: string | null };
type TaskPage = { data: components['schemas']['ScheduledTaskView'][]; next: string | null };

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const T0 = new Date(2026, 5, 30, 9, 0, 0, 125);
const USER_ID = '11111111-2222-3333-4444555566667777';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const HASH = 'a'.repeat(64);
const MANAGER = [Roles.surveysManager, Roles.systemUser];
const SURVEY_COUNT = 60;
const RESPONSE_COUNT = 7;
const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const NOT_FOUND = { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message };

/** Local time `minutes` after T0. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/** CF-format id whose sort order follows `n`. */
function cfId(n: number): string {
  return `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
}

/** Surveys 1 to 60 of tenant-a, created in that order; every third one is scheduled with reminders 10, 2 and 1. */
const SURVEY_IDS = Array.from({ length: SURVEY_COUNT }, (_, i) => cfId(i + 1));
const SCHEDULED = SURVEY_IDS.filter((_, i) => (i + 1) % 3 === 0);
const RESPONDED = cfId(1);
const UNANSWERED = cfId(2);
/** Responses 1 to 7 of survey 1, in creation order. */
const RESPONSE_IDS = Array.from({ length: RESPONSE_COUNT }, (_, i) => cfId(500 + i + 1));
const TENANT_B_SURVEY = cfId(900);
/** Survey 4's targets as [id, site, group]: case variants of one site, NULL and empty groups, inserted out of target order. */
const TARGETED = cfId(4);
const TARGETS: readonly (readonly [number, string, string | null])[] = [
  [301, 'tenant-b', 'Zeta'],
  [302, 'Tenant-A', null],
  [303, 'tenant-a', 'beta'],
  [304, 'tenant-a', null],
  [305, 'TENANT-A', 'Alpha'],
  [306, 'tenant-a', ''],
  [307, 'tenant-b', null],
];
/** Survey 4's target ids by lower-cased site, group (a NULL group first) and id. */
const TARGET_ORDER = [302, 304, 306, 305, 303, 307, 301].map(cfId);
/** Survey 5 carries one target more than the largest page. */
const CROWDED = cfId(5);

const SURVEYS = `/v1/surveys?siteid=${TENANT_A.siteId}`;
const responsesOf = (surveyId: string): string => `/v1/surveys/${surveyId}/responses?siteid=${TENANT_A.siteId}`;
const targetsOf = (surveyId: string, query = ''): string => `/v1/surveys/${surveyId}/targets?siteid=${TENANT_A.siteId}${query}`;

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('surveys /v1 routes', () => {
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  const statements: string[] = [];
  let transactions = 0;

  /** Wraps `tx` so every statement text it runs is appended to `statements`. */
  function counting(tx: TenantTx): TenantTx {
    const query = ((text: string, values?: unknown[]) => {
      statements.push(text);
      return tx.query(text, values);
    }) as TenantTx['query'];
    return { ...tx, query };
  }

  async function insert(tx: TenantTx, table: string, row: Record<string, unknown>): Promise<void> {
    const columns = ['tenant_id', ...Object.keys(row)];
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }

  function insertSurvey(tx: TenantTx, surveyId: string, siteid: string, n: number, status: string): Promise<void> {
    return insert(tx, 'survey', { survey_id: surveyId, siteid, title: `Survey ${n}`, status, created: at(n), createdbyid: USER_ID });
  }

  async function seedTenantA(tx: TenantTx): Promise<void> {
    for (const [i, surveyId] of SURVEY_IDS.entries()) {
      const n = i + 1;
      const scheduled = SCHEDULED.includes(surveyId);
      await insertSurvey(tx, surveyId, TENANT_A.siteId, n, scheduled ? 'SCHEDULED' : 'DRAFT');
      if (!scheduled) continue;
      await insert(tx, 'survey_schedule', {
        schedule_id: cfId(1000 + n),
        survey_id: surveyId,
        launch_at: at(1000 + n),
        schedule_version: 1,
        task_name: `opt2-survey-${surveyId}-launch`,
        task_token_hash: HASH,
        created: at(n),
      });
      for (const ordinal of [10, 2, 1]) {
        await insert(tx, 'survey_reminder', {
          reminder_id: cfId(10_000 + n * 100 + ordinal),
          survey_id: surveyId,
          offset_minutes: ordinal * 60,
          remind_at: at(1000 + n + ordinal * 60),
          task_name: `opt2-survey-${surveyId}-reminder-${ordinal}`,
          task_token_hash: HASH,
          sent_at: ordinal === 1 ? at(1100 + n) : null,
        });
      }
    }
    for (const [targetId, siteid, groupName] of TARGETS) {
      await insert(tx, 'survey_target', { target_id: cfId(targetId), survey_id: TARGETED, siteid, group_name: groupName, created: at(targetId) });
    }
    await tx.query(
      `INSERT INTO ${handle.schema}.survey_target (tenant_id, target_id, survey_id, siteid, group_name, created)
       SELECT $1, lpad(n::text, 8, '0') || '-EEEE-BBBB-CCCCDDDDEEEEFFFF', $2, $3, 'Group ' || n, $4 FROM generate_series(1, $5::integer) AS n`,
      [tx.tenantId, CROWDED, TENANT_B.siteId, at(0), TARGET_PAGE_MAX + 1],
    );
    for (const [i, responseId] of [...RESPONSE_IDS.entries()].reverse()) {
      await insert(tx, 'survey_response', {
        response_id: responseId,
        survey_id: RESPONDED,
        siteid: TENANT_A.siteId,
        respondentsiteid: i % 2 === 0 ? TENANT_A.siteId : TENANT_B.siteId,
        respondent_user_id: USER_ID,
        answers: `{"q1":${i}}`,
        created: at(100 + i),
      });
    }
  }

  /** GETs `url` as a surveys manager of `tenant` through the gateway, checking the answer against the contract. */
  async function get(url: string, tenant: TenantFixture = TENANT_A) {
    const headers = {
      authorization: `Bearer ${await mintUserToken({ site: tenant.siteId, roles: MANAGER, sub: USER_ID })}`,
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'surveys' })}`,
    };
    const res = await app.inject({ method: 'GET', url, headers });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'surveys', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await handle.app.withTenant(TENANT_A.tenantId, seedTenantA);
    await handle.app.withTenant(TENANT_B.tenantId, (tx) => insertSurvey(tx, TENANT_B_SURVEY, TENANT_B.siteId, 1, 'DRAFT'));
    const clock = fixedClock(T0);
    const db: TenantDb = {
      schema: handle.app.schema,
      withTenant: (tenantId, fn) => {
        transactions += 1;
        return handle.app.withTenant(tenantId, (tx) => fn(counting(tx)));
      },
      withMetadata: (fn, options) => handle.app.withMetadata(fn, options),
      end: () => handle.app.end(),
    };
    app = await createService({
      name: 'surveys',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8117',
        OPT2_SERVICE_NAME: 'surveys',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      pool: handle.app,
      clock,
      verifierOverride: testVerifier('surveys'),
      logger: createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    await registerV1Routes(app, { db, repository: createSurveysRepository({ clock, schema: handle.schema }), clock });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  beforeEach(() => {
    statements.length = 0;
  });

  describe('GET /v1/surveys', () => {
    it("lists the first 50 of the site's surveys by creation time and id with the count of all of them by default", async () => {
      const res = await get(SURVEYS);

      expect(res.statusCode).toBe(200);
      const body = res.json() as Page<Survey>;
      expect(Object.keys(body)).toEqual(['data', 'total']);
      expect(body.data.map((survey) => survey.surveyId)).toEqual(SURVEY_IDS.slice(0, 50));
      expect(body.total).toBe(SURVEY_COUNT);
    });

    it.each<[string, string, string[]]>([
      ['the defaults for empty paging values', '&pageIndex=&itemsPerPage=', SURVEY_IDS.slice(0, 50)],
      ['a middle page', '&pageIndex=2&itemsPerPage=25', SURVEY_IDS.slice(25, 50)],
      ['a short last page', '&pageIndex=4&itemsPerPage=16', SURVEY_IDS.slice(48)],
      ['every survey on one page of the largest size', '&itemsPerPage=1000', SURVEY_IDS],
      ['no surveys for a page starting at the count', '&pageIndex=7&itemsPerPage=10', []],
      ['no surveys for a page far past the end', '&pageIndex=2147483647&itemsPerPage=1000', []],
    ])('lists %s with the count of every survey', async (_case, paging, expected) => {
      const res = await get(`${SURVEYS}${paging}`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: expected.map((surveyId) => expect.objectContaining({ surveyId })), total: SURVEY_COUNT });
    });

    it.each(['itemsPerPage=1001', 'itemsPerPage=0', 'pageIndex=abc', 'pageIndex=0', 'pageIndex=1.5'])(
      'answers invalidParameters for %s before reading anything',
      async (paging) => {
        const res = await get(`${SURVEYS}&${paging}`);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_PARAMETERS });
        expect(statements).toEqual([]);
      },
    );

    it('lists each survey with the schedule and ordinal-ordered reminders its detail reads', async () => {
      const listed = (await get(`${SURVEYS}&itemsPerPage=1000`)).json() as Page<Survey>;

      for (const survey of listed.data) {
        const detail = await get(`/v1/surveys/${survey.surveyId}?siteid=${TENANT_A.siteId}`);
        expect(detail.json()).toEqual({ data: survey });
      }
      const scheduled = listed.data.filter((survey) => survey.schedule !== null);
      expect(scheduled.map((survey) => survey.surveyId)).toEqual(SCHEDULED);
      expect(scheduled.map((survey) => survey.schedule?.reminders.map((reminder) => reminder.n))).toEqual(SCHEDULED.map(() => [1, 2, 10]));
      expect(listed.data.find((survey) => survey.surveyId === cfId(1))?.schedule).toBeNull();
    });

    it('reads the schedules and reminders of any page in one statement each, and of an empty page in none', async () => {
      const read = async (paging: string): Promise<string[]> => {
        statements.length = 0;
        expect((await get(`${SURVEYS}&${paging}`)).statusCode).toBe(200);
        return [...statements];
      };
      const byTable = (seen: string[], table: string): number => seen.filter((text) => new RegExp(`\\b${table}\\b`).test(text)).length;

      const small = await read('itemsPerPage=2');
      const large = await read('itemsPerPage=50');
      const empty = await read('pageIndex=99');

      expect(large).toHaveLength(small.length);
      for (const seen of [small, large]) {
        expect([byTable(seen, 'survey_schedule'), byTable(seen, 'survey_reminder')]).toEqual([1, 1]);
      }
      expect([byTable(empty, 'survey_schedule'), byTable(empty, 'survey_reminder')]).toEqual([0, 0]);
    });

    it("lists only the token tenant's surveys", async () => {
      const res = await get(`/v1/surveys?siteid=${TENANT_B.siteId}`, TENANT_B);

      expect(res.json()).toEqual({ data: [expect.objectContaining({ surveyId: TENANT_B_SURVEY, siteId: TENANT_B.siteId })], total: 1 });
    });
  });

  describe('GET /v1/surveys/{surveyId}/responses', () => {
    it.each<[string, string, string, string[], number]>([
      ['every response by default', RESPONDED, '', RESPONSE_IDS, RESPONSE_COUNT],
      ['a middle page', RESPONDED, '&pageIndex=2&itemsPerPage=3', RESPONSE_IDS.slice(3, 6), RESPONSE_COUNT],
      ['a short last page', RESPONDED, '&pageIndex=3&itemsPerPage=3', RESPONSE_IDS.slice(6), RESPONSE_COUNT],
      ['no responses past the end', RESPONDED, '&pageIndex=3&itemsPerPage=4', [], RESPONSE_COUNT],
      ['no responses of a survey without any', UNANSWERED, '&itemsPerPage=1000', [], 0],
    ])('lists %s by creation time and id with the count of all of them', async (_case, surveyId, paging, expected, total) => {
      const res = await get(`${responsesOf(surveyId)}${paging}`);

      expect(res.statusCode).toBe(200);
      const body = res.json() as Page<SurveyResponse>;
      expect(Object.keys(body)).toEqual(['data', 'total']);
      expect(body.data.map((response) => response.responseId)).toEqual(expected);
      expect(body.total).toBe(total);
    });

    it.each([
      ['an unknown survey', UNKNOWN_ID, ''],
      ['an unknown survey before invalid paging', UNKNOWN_ID, '&pageIndex=0'],
      ["another tenant's survey", TENANT_B_SURVEY, ''],
    ])('answers the fixture notFound for %s', async (_case, surveyId, paging) => {
      const res = await get(`${responsesOf(surveyId)}${paging}`);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ apiversion: 'v1', method: 'surveys.surveys.responses', error: NOT_FOUND });
    });

    it.each(['itemsPerPage=1001', 'pageIndex=abc', 'pageIndex=0'])('answers invalidParameters for %s', async (paging) => {
      const res = await get(`${responsesOf(RESPONDED)}&${paging}`);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_PARAMETERS });
    });
  });

  describe('GET /v1/surveys/{surveyId}/targets', () => {
    /** Every page of `surveyId`'s targets, `limit` at a time, following `next` until it is null. */
    async function walk(surveyId: string, limit: number): Promise<TargetPage[]> {
      const pages: TargetPage[] = [];
      let next: string | null = null;
      do {
        const after: string = next === null ? '' : `&after=${encodeURIComponent(next)}`;
        const res = await get(targetsOf(surveyId, `&limit=${String(limit)}${after}`));
        expect(res.statusCode, res.body).toBe(200);
        const page = res.json() as TargetPage;
        pages.push(page);
        next = page.next;
      } while (next !== null);
      return pages;
    }

    it('lists every target by lower-cased site, group and id, with a null next, when neither limit nor after is given', async () => {
      const res = await get(targetsOf(TARGETED));

      expect(res.statusCode).toBe(200);
      const body = res.json() as TargetPage;
      expect(Object.keys(body)).toEqual(['data', 'next']);
      expect(body.data.map((target) => target.targetId)).toEqual(TARGET_ORDER);
      expect(body.next).toBeNull();
      expect(body.data[0]).toEqual({ targetId: cfId(302), surveyId: TARGETED, siteId: 'Tenant-A', groupName: null, created: '2026-06-30T14:02:00.125' });
    });

    it.each([1, 2, 3, 6, 7, TARGET_PAGE_MAX])('walks pages of %i through next to the same list, each page read in one statement', async (limit) => {
      statements.length = 0;
      const pages = await walk(TARGETED, limit);

      expect(pages.flatMap((page) => page.data.map((target) => target.targetId))).toEqual(TARGET_ORDER);
      expect(pages).toHaveLength(Math.ceil(TARGETS.length / limit));
      expect(pages.every((page) => page.data.length <= limit)).toBe(true);
      expect(statements.filter((text) => /\bsurvey_target\b.*\bLIMIT\b/.test(text))).toHaveLength(pages.length);
    });

    it(`pages ${String(TARGET_PAGE_DEFAULT)} at a time when only after is given`, async () => {
      const first = (await get(targetsOf(CROWDED, '&limit=1'))).json() as TargetPage;
      const res = await get(targetsOf(CROWDED, `&after=${encodeURIComponent(first.next ?? '')}`));
      const whole = (await get(targetsOf(CROWDED))).json() as TargetPage;

      expect(res.statusCode).toBe(200);
      const page = res.json() as TargetPage;
      expect(page.data).toEqual(whole.data.slice(1, 1 + TARGET_PAGE_DEFAULT));
      expect(page.next).toEqual(expect.any(String));
    });

    it(`lists all ${String(TARGET_PAGE_MAX + 1)} targets of a survey from batches of ${String(TARGET_PAGE_MAX)}`, async () => {
      statements.length = 0;
      const res = await get(targetsOf(CROWDED));

      const body = res.json() as TargetPage;
      expect(body.data).toHaveLength(TARGET_PAGE_MAX + 1);
      expect(body.next).toBeNull();
      expect(statements.filter((text) => /\bsurvey_target\b.*\bLIMIT\b/.test(text))).toHaveLength(2);
    });

    it.each<[string, string, number, number]>([
      ['a survey without targets', RESPONDED, 0, 1],
      ['one batch of targets', TARGETED, TARGETS.length, 1],
      [`${String(TARGET_PAGE_MAX + 1)} targets, two batches`, CROWDED, TARGET_PAGE_MAX + 1, 2],
    ])('streams every target of %s byte for byte as the buffered answer, one transaction a batch', async (_case, surveyId, count, batches) => {
      const pages = await walk(surveyId, TARGET_PAGE_MAX);
      const expected = JSON.stringify({ data: pages.flatMap((page) => page.data), next: null });
      transactions = 0;

      const res = await get(targetsOf(surveyId));

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['content-length']).toBeUndefined();
      expect(res.rawPayload.equals(Buffer.from(expected, 'utf8'))).toBe(true);
      expect((res.json() as TargetPage).data).toHaveLength(count);
      expect(transactions).toBe(batches);
    });

    it.each([
      'limit=0',
      `limit=${String(TARGET_PAGE_MAX + 1)}`,
      'limit=abc',
      'limit=1.5',
      'limit=',
      'after=',
      'after=not-a-cursor',
      `after=${Buffer.from('{"site":"tenant-a"}').toString('base64url')}`,
      `after=${Buffer.from('["tenant-a",true,"alpha"]').toString('base64url')}`,
      `after=${Buffer.from('["tenant-a","true","alpha","id"]').toString('base64url')}`,
      `limit=2&after=${Buffer.from('null').toString('base64url')}`,
    ])('answers invalidParameters for %s before reading anything', async (query) => {
      statements.length = 0;
      const res = await get(targetsOf(TARGETED, `&${query}`));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_PARAMETERS });
      expect(statements).toEqual([]);
    });

    it.each([
      ['an unknown survey', UNKNOWN_ID, ''],
      ['an unknown survey, paged', UNKNOWN_ID, '&limit=2'],
      ["another tenant's survey", TENANT_B_SURVEY, '&limit=2'],
    ])('answers the fixture notFound for %s', async (_case, surveyId, query) => {
      const res = await get(targetsOf(surveyId, query));

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ apiversion: 'v1', method: 'surveys.surveys.targets', error: NOT_FOUND });
    });
  });

  it('reads the survey detail without reading its targets', async () => {
    statements.length = 0;
    const res = await get(`/v1/surveys/${TARGETED}?siteid=${TENANT_A.siteId}`);

    expect(res.statusCode).toBe(200);
    expect(statements.filter((text) => /\bsurvey_target\b/.test(text))).toEqual([]);
  });

  it.each([
    ['the survey detail', `/v1/surveys/${RESPONDED}?siteid=${TENANT_A.siteId}`, ['data']],
    ['the survey targets', targetsOf(RESPONDED), ['data', 'next']],
  ])('answers %s with exactly the keys %j', async (_case, url, keys) => {
    const res = await get(url);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object)).toEqual(keys);
  });

  describe('GET /v1/surveys/{surveyId}/tasks', () => {
    const TASKED = SCHEDULED[0] ?? '';
    /** A survey communications holds more tasks of than one page of 1000. */
    const CROWDED_TASKED = SCHEDULED[1] ?? '';
    const client = createClientRecorder({
      scheduledTasks: (surveyId) =>
        surveyId === UNANSWERED ? [] : defaultScheduledTasks(surveyId, { reminders: surveyId === CROWDED_TASKED ? TASK_PAGE_MAX + 500 : 4 }),
    });
    const tasksOf = (surveyId: string, query = ''): string => `/v1/surveys/${surveyId}/tasks?siteid=${TENANT_A.siteId}${query}`;

    /** The communications calls made since `before`, by their query. */
    const callsSince = (before: number) => client.requests.slice(before).map((req) => req.query);

    beforeAll(() => {
      client.install(app);
    });

    beforeEach(() => {
      client.reset();
    });

    it('lists every task in one bounded communications call, with a null next, when neither limit nor after is given', async () => {
      const before = client.requests.length;
      const res = await get(tasksOf(TASKED));

      expect(res.statusCode).toBe(200);
      const body = res.json() as TaskPage;
      expect(Object.keys(body)).toEqual(['data', 'next']);
      expect(body.data.map((task) => task.taskName)).toEqual(defaultScheduledTasks(TASKED, { reminders: 4 }).map((task) => task.taskName));
      expect(body.next).toBeNull();
      expect(callsSince(before)).toEqual([{ sourceType: 'survey', sourceId: TASKED, limit: String(TASK_PAGE_MAX) }]);
    });

    it.each<[string, string, number, number]>([
      ['a survey communications holds no task of', UNANSWERED, 0, 1],
      ['one page of tasks', TASKED, 5, 1],
      [`${String(TASK_PAGE_MAX + 501)} tasks, two pages`, CROWDED_TASKED, TASK_PAGE_MAX + 501, 2],
    ])('streams every task of %s byte for byte as the buffered answer, one communications call a page', async (_case, surveyId, count, pages) => {
      const walked: TaskPage[] = [];
      let next: string | null = null;
      do {
        const res = await get(tasksOf(surveyId, `&limit=${String(TASK_PAGE_MAX)}${next === null ? '' : `&after=${next}`}`));
        walked.push(res.json() as TaskPage);
        next = walked.at(-1)?.next ?? null;
      } while (next !== null && walked.length < 10);
      const expected = JSON.stringify({ data: walked.flatMap((page) => page.data), next: null });
      const before = client.requests.length;

      const res = await get(tasksOf(surveyId));

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(res.headers['content-length']).toBeUndefined();
      expect(res.rawPayload.equals(Buffer.from(expected, 'utf8'))).toBe(true);
      expect((res.json() as TaskPage).data).toHaveLength(count);
      expect(callsSince(before)).toEqual(
        Array.from({ length: pages }, (_, i) => ({ sourceType: 'survey', sourceId: surveyId, limit: String(TASK_PAGE_MAX), ...(i === 0 ? {} : { after: expect.any(String) }) })),
      );
    });

    it.each([1, 2, 3, 5])('walks pages of %i through next to the same list, forwarding each page to communications', async (limit) => {
      const whole = ((await get(tasksOf(TASKED))).json() as TaskPage).data;
      const before = client.requests.length;
      const pages: TaskPage[] = [];
      let next: string | null = null;
      do {
        const after: string = next === null ? '' : `&after=${next}`;
        const res = await get(tasksOf(TASKED, `&limit=${String(limit)}${after}`));
        expect(res.statusCode, res.body).toBe(200);
        pages.push(res.json() as TaskPage);
        next = pages.at(-1)?.next ?? null;
      } while (next !== null && pages.length < 10);

      expect(pages.flatMap((page) => page.data)).toEqual(whole);
      expect(pages).toHaveLength(Math.ceil(whole.length / limit));
      expect(callsSince(before).every((query) => query?.limit === String(limit))).toBe(true);
    });

    it("pages communications' default when only after is given", async () => {
      const first = (await get(tasksOf(TASKED, '&limit=1'))).json() as TaskPage;
      const before = client.requests.length;

      const res = await get(tasksOf(TASKED, `&after=${first.next ?? ''}`));

      expect(res.statusCode).toBe(200);
      expect((res.json() as TaskPage).data).toHaveLength(4);
      expect(callsSince(before)).toEqual([{ sourceType: 'survey', sourceId: TASKED, after: first.next }]);
    });

    it.each(['limit=0', `limit=${String(TASK_PAGE_MAX + 1)}`, 'limit=abc', 'limit=1.5', 'limit=', 'after=', 'after=a%2Bb', 'after=a.b'])(
      'answers invalidParameters for %s without calling communications',
      async (query) => {
        const before = client.requests.length;
        const res = await get(tasksOf(TASKED, `&${query}`));

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_PARAMETERS });
        expect(callsSince(before)).toEqual([]);
      },
    );

    it('answers invalidParameters for an after cursor communications refuses', async () => {
      const res = await get(tasksOf(TASKED, `&after=${Buffer.from('not json').toString('base64url')}`));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: INVALID_PARAMETERS });
    });

    it.each([
      ['an unknown survey, paged', UNKNOWN_ID],
      ["another tenant's survey, paged", TENANT_B_SURVEY],
    ])('answers the fixture notFound for %s without calling communications', async (_case, surveyId) => {
      const before = client.requests.length;
      const res = await get(tasksOf(surveyId, '&limit=2'));

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ apiversion: 'v1', method: 'surveys.surveys.tasks', error: NOT_FOUND });
      expect(callsSince(before)).toEqual([]);
    });
  });
});
