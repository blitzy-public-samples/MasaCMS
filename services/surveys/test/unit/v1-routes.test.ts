// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The `/v1/surveys` routes over a throwaway `surveys` schema: paged survey and response lists with their totals, batched schedule reads and `{data}` reads. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import type { components } from '../../src/generated/openapi.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/fixture-envelope.js';
import { createSurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { registerV1Routes } from '../../src/routes/v1.js';

type Survey = components['schemas']['Survey'];
type SurveyResponse = components['schemas']['SurveyResponse'];
type Page<T> = { data: T[]; total: number };

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

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

const SURVEYS = `/v1/surveys?siteid=${TENANT_A.siteId}`;
const responsesOf = (surveyId: string): string => `/v1/surveys/${surveyId}/responses?siteid=${TENANT_A.siteId}`;

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('surveys /v1 routes', () => {
  let handle: ThrowawaySchema;
  let app: FastifyInstance;
  const statements: string[] = [];

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
      withTenant: (tenantId, fn) => handle.app.withTenant(tenantId, (tx) => fn(counting(tx))),
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

  it.each([
    ['the survey detail', `/v1/surveys/${RESPONDED}?siteid=${TENANT_A.siteId}`],
    ['the survey targets', `/v1/surveys/${RESPONDED}/targets?siteid=${TENANT_A.siteId}`],
  ])('answers %s as {data} alone', async (_case, url) => {
    const res = await get(url);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object)).toEqual(['data']);
  });
});
