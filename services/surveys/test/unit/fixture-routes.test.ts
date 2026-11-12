// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The surveys fixture routes over a throwaway `surveys` schema: declarations, api.cfm check order, method override, envelopes and every route's answer. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createOutbox, resetOutboxRuntimes } from '@opt2/platform/outbox';
import { ensureUnitGates, sha256Hex } from '@opt2/platform/migration-kit';
import {
  IDENTITY_SERVICE,
  createService,
  fixedClock,
  loadEnv,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { siteForTenant, tenantForRegisteredSite, tenantIdForSite, withMetadata } from '@opt2/platform/tenancy';
import {
  createCapturingPublisher,
  createThrowawaySchema,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledValidator } from '../../src/events/survey-scheduled.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/fixture-envelope.js';
import type { ScheduledTaskRecord } from '../../src/legacy/tasks-view.js';
import { createSurveysRepository, type SurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';
import { FIXTURE_BASE, registerFixtureRoutes } from '../../src/routes/fixture.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9);
const MANAGER_ID = '11111111-2222-3333-4444555566667777';
const RESPONDENT_ID = '22222222-3333-4444-5555666677778888';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const TOKEN = 'launch-token-1';
const JSON_HEADERS = { 'content-type': 'application/json' };
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
const SITE_A = '?siteid=tenant-a';
const UNREGISTERED_TENANT_SITE = 'ghost';

const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const AUTHORIZATION = { code: 'invalid_request', message: 'Insufficient Account Permissions' };
const INVALID_TOKENS = { code: 'invalid_request', message: 'Invalid CSRF tokens' };
const FORBIDDEN = { code: FIXTURE_ERROR_MAP.forbidden.code, message: FIXTURE_ERROR_MAP.forbidden.message };
const NOT_FOUND = { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message };
const CONFLICT = { code: FIXTURE_ERROR_MAP.conflict.code, message: FIXTURE_ERROR_MAP.conflict.message };

type Method = 'GET' | 'POST';

const silentLogger = () => createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: () => undefined } });

interface Call {
  method: Method;
  url: string;
  roles?: string[];
  site?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const available = await pgAvailable();

describe.skipIf(!available)('surveys fixture routes', () => {
  let handle: ThrowawaySchema;
  let repository: SurveysRepository;
  let app: FastifyInstance;
  let stateDir: string;
  let csrfValid: boolean;
  let communications: (req: ServiceRequest) => ServiceResponse;
  let calls: ServiceRequest[];
  let publisher: CapturingPublisher;

  function admin(sql: string, params: unknown[] = []): Promise<unknown> {
    return withMetadata(handle.app, (tx) => tx.query(sql.replaceAll('$schema', handle.schema), params));
  }

  function tenantA(sql: string, params: unknown[] = []): Promise<unknown> {
    return handle.app.withTenant(tenantIdForSite('tenant-a'), (tx) => tx.query(sql.replaceAll('$schema', handle.schema), params));
  }

  async function inject({ method, url, roles, site = 'tenant-a', body, headers = {} }: Call) {
    const auth: Record<string, string> =
      roles === undefined ? {} : { authorization: `Bearer ${await mintUserToken({ site, roles, sub: roles.includes(Roles.surveysManager) ? MANAGER_ID : RESPONDENT_ID })}` };
    return app.inject({
      method,
      url,
      headers: { ...auth, ...CSRF_HEADERS, ...(body === undefined ? {} : JSON_HEADERS), ...headers },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const asManager = (call: Omit<Call, 'roles'>) => inject({ ...call, roles: [Roles.surveysManager, Roles.systemUser] });

  async function createSurvey(title = 'Survey'): Promise<string> {
    const res = await asManager({ method: 'POST', url: `${FIXTURE_BASE}${SITE_A}`, body: { title } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { data: { survey_id: string } }).data.survey_id;
  }

  function record(surveyId: string, n: number | null, over: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
    const launch = n === null;
    return {
      taskName: `opt2-survey-${surveyId}-${launch ? 'launch' : `reminder-${n}`}`,
      kind: launch ? 'survey-launch' : 'survey-reminder',
      n,
      targetRoute: `/internal/v1/tasks/surveys/${surveyId}/launch`,
      scheduleTime: '2026-07-01T09:00:00.000',
      status: 'scheduled',
      scheduleVersion: 1,
      queue: launch ? 'surveys-launch' : 'communications-reminders',
      ...over,
    };
  }

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'opt2-surveys-fixture-routes-'));
    await writeTestSecrets(stateDir);
    handle = await createThrowawaySchema({ service: 'surveys', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const clock = fixedClock(NOW);
    repository = createSurveysRepository({ clock, schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
    for (const site of ['tenant-a', 'tenant-b', 'umbrella']) {
      await admin('INSERT INTO $schema.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, $3)', [
        site,
        tenantIdForSite(site),
        NOW,
      ]);
    }
    const db = handle.app;
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
        OPT2_STATE_DIR: stateDir,
        TZ: 'UTC',
      }),
      pool: db,
      clock,
      verifierOverride: testVerifier('surveys'),
      logger: silentLogger(),
    });
    await registerFixtureRoutes(app, {
      db,
      repository,
      clock,
      siteLookup: {
        registeredSite: async (site) => {
          // `ghost` stands for a site the registry drops between the site check and the tenant lookup.
          if (site === UNREGISTERED_TENANT_SITE) return site;
          const tenant = await tenantForRegisteredSite(db, site);
          return tenant === null ? undefined : ((await siteForTenant(db, tenant)) ?? undefined);
        },
      },
    });
    await app.ready();
    publisher = createCapturingPublisher();
    createOutbox({
      service: 'surveys',
      db,
      publisher,
      logger: silentLogger(),
      clock,
      payloadValidators: { [SURVEY_SCHEDULED_TOPIC]: surveyScheduledValidator },
    });
    vi.spyOn(app.opt2.client, 'request').mockImplementation((async (req: ServiceRequest) => {
      calls.push(req);
      if (req.service === IDENTITY_SERVICE) return { status: 200, headers: {}, body: { valid: csrfValid } };
      return communications(req);
    }) as typeof app.opt2.client.request);
  });

  afterAll(async () => {
    resetOutboxRuntimes();
    await app?.close();
    await handle?.drop();
    await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await admin("UPDATE $schema.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'");
    csrfValid = true;
    calls = [];
    communications = () => ({ status: 200, headers: {}, body: { items: [] } });
  });

  it('declares exactly the contract operations, each public with the site checked in the handler', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(FIXTURE_BASE));
    const declared = { transport: 'service', public: true, siteCheck: false };
    expect(routes.map(({ method, url, ...declaration }) => [`${method} ${url.slice(FIXTURE_BASE.length)}`, declaration])).toEqual(
      expect.arrayContaining(
        [
          'GET ',
          'POST ',
          'GET /:id',
          'POST /:id/schedule',
          'POST /:id/targets/bulk',
          'GET /:id/responses',
          'POST /:id/responses',
          'GET /:id/tasks',
          'GET /:id/launch',
          'POST /:id/launch',
        ].map((key) => [key, declared]),
      ),
    );
    expect(routes).toHaveLength(10);
  });

  describe('api.cfm check order', () => {
    it.each<[string, Call, number, object]>([
      ['an unknown site before login', { method: 'GET', url: `${FIXTURE_BASE}?siteid=nowhere` }, 400, INVALID_PARAMETERS],
      ['login after the site', { method: 'GET', url: `${FIXTURE_BASE}${SITE_A}` }, 401, AUTHORIZATION],
      ['another site than the token', { method: 'GET', url: `${FIXTURE_BASE}?siteid=tenant-b`, roles: [Roles.surveysManager] }, 403, FORBIDDEN],
      ['the manager role group', { method: 'GET', url: `${FIXTURE_BASE}${SITE_A}`, roles: [Roles.systemUser, Roles.s2] }, 403, FORBIDDEN],
      ['the role before existence', { method: 'GET', url: `${FIXTURE_BASE}/${UNKNOWN_ID}${SITE_A}`, roles: [Roles.systemUser] }, 403, FORBIDDEN],
      ['an undeclared override after the site', { method: 'GET', url: `${FIXTURE_BASE}${SITE_A}`, headers: { 'x-http-method-override': 'delete' } }, 404, NOT_FOUND],
      ['the site before an undeclared override', { method: 'GET', url: `${FIXTURE_BASE}?siteid=nowhere`, headers: { 'x-http-method-override': 'delete' } }, 400, INVALID_PARAMETERS],
      ['site membership of a respondent', { method: 'POST', url: `${FIXTURE_BASE}/${UNKNOWN_ID}/responses${SITE_A}`, roles: [Roles.surveysManager], body: { answers: 'a' } }, 403, FORBIDDEN],
    ])('checks %s', async (_case, call, status, error) => {
      const res = await inject(call);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ apiversion: 'v1', method: 'surveys.surveys' + (call.url.includes('/responses') ? '.responses' : ''), error });
    });

    it('answers the CSRF failure of a write with invalidTokens before the title check', async () => {
      csrfValid = false;
      const res = await asManager({ method: 'POST', url: `${FIXTURE_BASE}${SITE_A}`, body: { title: '' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ method: 'surveys.surveys', error: INVALID_TOKENS });
      expect(calls).toEqual([expect.objectContaining({ service: IDENTITY_SERVICE, json: expect.objectContaining({ context: '' }) })]);
    });
  });

  it('creates, reads and lists surveys in the fixture envelope, params suppressed as Masa suppresses them', async () => {
    const res = await asManager({ method: 'POST', url: `${FIXTURE_BASE}${SITE_A}&method=ignored`, body: { Title: 'First' } });
    expect(res.statusCode).toBe(200);
    const created = res.json() as { data: { survey_id: string } };
    expect(created).toEqual({
      apiversion: 'v1',
      method: 'surveys.surveys',
      data: {
        survey_id: expect.stringMatching(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/),
        siteid: 'tenant-a',
        title: 'First',
        status: 'DRAFT',
        created: '2026-06-30T14:05:09',
        createdbyid: MANAGER_ID,
        lastupdate: '',
        lastupdatebyid: '',
        launched_at: '',
        schedule: {},
        reminders: [],
        targets: [],
      },
    });
    const id = created.data.survey_id;

    const detail = await asManager({ method: 'GET', url: `${FIXTURE_BASE}/${id.toLowerCase()}${SITE_A}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ method: 'surveys.surveys', data: { survey_id: id, schedule: {} } });

    const listed = await asManager({ method: 'GET', url: `${FIXTURE_BASE}${SITE_A}&itemsPerPage=1000` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      method: 'surveys.surveys',
      data: { startindex: 1, itemsperpage: 1000, pageindex: 1, items: expect.arrayContaining([expect.objectContaining({ survey_id: id })]) },
    });
    expect((listed.json() as { data: { items: object[] } }).data.items[0]).not.toHaveProperty('schedule');

    const badPage = await asManager({ method: 'GET', url: `${FIXTURE_BASE}${SITE_A}&pageIndex=0` });
    expect(badPage.statusCode).toBe(400);
    expect(badPage.json()).toMatchObject({ error: INVALID_PARAMETERS });
  });

  it('dispatches on X-HTTP-Method-Override to the path\'s other declared method', async () => {
    const id = await createSurvey('Override');
    const listed = await asManager({ method: 'POST', url: `${FIXTURE_BASE}${SITE_A}`, headers: { 'x-http-method-override': 'GET' } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ data: { totalitems: expect.any(Number) } });

    const responses = await asManager({ method: 'POST', url: `${FIXTURE_BASE}/${id}/responses${SITE_A}`, headers: { 'x-http-method-override': 'get' } });
    expect(responses.statusCode).toBe(200);
    expect(responses.json()).toMatchObject({ method: 'surveys.surveys.responses', data: { items: [], totalitems: 0 } });

    const scheduleAsGet = await asManager({ method: 'POST', url: `${FIXTURE_BASE}/${id}/schedule${SITE_A}`, headers: { 'x-http-method-override': 'GET' } });
    expect(scheduleAsGet.statusCode).toBe(404);
    expect(scheduleAsGet.json()).toMatchObject({ method: 'surveys.surveys.schedule', error: NOT_FOUND });
  });

  it('answers notFound for a survey outside the tenant on every per-survey route', async () => {
    const id = await createSurvey('Tenant A only');
    const asB = { roles: [Roles.surveysManager, Roles.systemUser], site: 'tenant-b' };
    for (const [method, tail, body] of [
      ['GET', '', undefined],
      ['POST', '/schedule', { launchAt: '2026-07-01T09:00:00' }],
      ['POST', '/targets/bulk', { targets: [{ siteID: 'tenant-a' }] }],
      ['GET', '/responses', undefined],
      ['GET', '/tasks', undefined],
    ] as const) {
      const res = await inject({ method, url: `${FIXTURE_BASE}/${id}${tail}?siteid=tenant-b`, body, ...asB });
      expect(res.statusCode, `${method} ${tail}`).toBe(404);
      expect(res.json()).toMatchObject({ error: NOT_FOUND });
    }
    expect(calls.filter((call) => call.service !== IDENTITY_SERVICE)).toEqual([]);
  });

  it('schedules a survey, lists its tasks from communications and refuses a reschedule once launched', async () => {
    const id = await createSurvey('Scheduled');
    calls = [];
    publisher.clear();
    const res = await asManager({
      method: 'POST',
      url: `${FIXTURE_BASE}/${id}/schedule${SITE_A}`,
      body: { launchAt: '2026-07-01T09:00:00', reminders: [{ offsetMinutes: 1440 }, { offsetMinutes: '30' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      method: 'surveys.surveys.schedule',
      data: {
        status: 'SCHEDULED',
        schedule: { survey_id: id, launch_at: '2026-07-01T09:00:00', schedule_version: 1, task_name: `opt2-survey-${id}-launch` },
        reminders: [
          { offset_minutes: 1440, remind_at: '2026-07-02T09:00:00', task_name: `opt2-survey-${id}-reminder-1`, sent_at: '' },
          { offset_minutes: 30, remind_at: '2026-07-01T09:30:00', task_name: `opt2-survey-${id}-reminder-2`, sent_at: '' },
        ],
      },
    });
    expect(calls).toEqual([expect.objectContaining({ service: IDENTITY_SERVICE, json: expect.objectContaining({ context: id }) })]);
    // The scheduled event is flushed in the request, before the response.
    expect(publisher.published.filter(({ topic }) => topic === SURVEY_SCHEDULED_TOPIC)).toEqual([
      expect.objectContaining({ envelope: expect.objectContaining({ aggregateId: id, tenantId: tenantIdForSite('tenant-a') }) }),
    ]);

    communications = () => ({ status: 200, headers: {}, body: { items: [record(id, 1), record(id, null), record(id, 2)] } });
    const tasks = await asManager({ method: 'GET', url: `${FIXTURE_BASE}/${id}/tasks${SITE_A}` });
    expect(tasks.statusCode).toBe(200);
    const route = `${FIXTURE_BASE}/${id}`;
    expect(tasks.json()).toMatchObject({
      method: 'surveys.surveys.tasks',
      data: {
        items: [
          { taskname: `opt2-survey-${id}-launch`, kind: 'launch', route: `${route}/launch`, offsetminutes: 0 },
          { taskname: `opt2-survey-${id}-reminder-2`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 30 },
          { taskname: `opt2-survey-${id}-reminder-1`, kind: 'reminder', route: `${route}/remind`, offsetminutes: 1440 },
        ],
        totalitems: 3,
      },
    });

    communications = () => ({ status: 500, headers: {}, body: undefined });
    const unavailable = await asManager({ method: 'GET', url: `${FIXTURE_BASE}/${id}/tasks${SITE_A}` });
    expect(unavailable.statusCode).toBe(503);

    await tenantA("UPDATE $schema.survey SET status = 'LAUNCHED', launched_at = $2 WHERE survey_id = $1", [id, NOW]);
    const conflict = await asManager({ method: 'POST', url: `${FIXTURE_BASE}/${id}/schedule${SITE_A}`, body: { launchAt: '2026-07-01T09:00:00' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ method: 'surveys.surveys.schedule', error: CONFLICT });
  });

  it('bulk-targets a survey and lets a targeted site respond under the survey\'s site', async () => {
    const id = await createSurvey('Targeted');
    const bulk = await asManager({
      method: 'POST',
      url: `${FIXTURE_BASE}/${id}/targets/bulk${SITE_A}`,
      body: { targets: [{ siteID: 'tenant-b' }, { siteID: 'TENANT-B' }, { siteID: 'umbrella', groupName: 'Staff' }] },
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json()).toMatchObject({ method: 'surveys.surveys.targets.bulk', data: { inserted: 2, total: 2 } });

    const own = await inject({ method: 'POST', url: `${FIXTURE_BASE}/${id}/responses${SITE_A}`, roles: [Roles.systemUser], body: { answers: 'own' } });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      method: 'surveys.surveys.responses',
      data: { survey_id: id, siteid: 'tenant-a', respondentsiteid: 'tenant-a', respondent_user_id: RESPONDENT_ID, answers: 'own', created: '2026-06-30T14:05:09' },
    });

    const other = await inject({
      method: 'POST',
      url: `${FIXTURE_BASE}/${id}/responses?siteid=tenant-b`,
      roles: [Roles.member],
      site: 'tenant-b',
      body: { answers: 'other' },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ data: { siteid: 'tenant-a', respondentsiteid: 'tenant-b', answers: 'other' } });

    const empty = await inject({ method: 'POST', url: `${FIXTURE_BASE}/${id}/responses${SITE_A}`, roles: [Roles.systemUser], body: { answers: '' } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: INVALID_PARAMETERS });

    const listed = await asManager({ method: 'GET', url: `${FIXTURE_BASE}/${id}/responses${SITE_A}&itemsPerPage=1` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      // Both responses share the fixed clock's `created`, so the page's one item is either of them.
      data: { items: [expect.objectContaining({ survey_id: id, siteid: 'tenant-a' })], totalitems: 2, totalpages: 2, endindex: 1 },
    });

    const detail = await asManager({ method: 'GET', url: `${FIXTURE_BASE}/${id}${SITE_A}` });
    expect((detail.json() as { data: { targets: unknown[] } }).data.targets).toEqual([
      { target_id: expect.any(String), survey_id: id, siteid: 'tenant-b', group_name: '', created: '2026-06-30T14:05:09' },
      { target_id: expect.any(String), survey_id: id, siteid: 'umbrella', group_name: 'Staff', created: '2026-06-30T14:05:09' },
    ]);
  });

  describe('launch task callback', () => {
    async function scheduled(): Promise<string> {
      const id = await createSurvey('Launch');
      const res = await asManager({ method: 'POST', url: `${FIXTURE_BASE}/${id}/schedule${SITE_A}`, body: { launchAt: '2026-07-01T09:00:00' } });
      expect(res.statusCode).toBe(200);
      await tenantA('UPDATE $schema.survey_schedule SET task_token_hash = $2 WHERE survey_id = $1', [id, sha256Hex(TOKEN)]);
      return id;
    }

    it.each<[string, string, Record<string, string>]>([
      ['no task token', '', {}],
      ['another task token', '&opt2TaskToken=wrong', {}],
      ['a token outside the query', '', { 'x-opt2tasktoken': TOKEN }],
    ])('answers forbidden with %s and leaves the survey scheduled', async (_case, query, headers) => {
      const id = await scheduled();
      const res = await inject({ method: 'GET', url: `${FIXTURE_BASE}/${id}/launch${SITE_A}${query}`, headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ method: 'surveys.surveys.launch', error: FORBIDDEN });
      const detail = await asManager({ method: 'GET', url: `${FIXTURE_BASE}/${id}${SITE_A}` });
      expect(detail.json()).toMatchObject({ data: { status: 'SCHEDULED', launched_at: '' } });
    });

    it('launches once by GET with the task token and answers a repeat POST with the same row', async () => {
      const id = await scheduled();
      const first = await inject({ method: 'GET', url: `${FIXTURE_BASE}/${id.toLowerCase()}/launch${SITE_A}&OPT2TASKTOKEN=${TOKEN}` });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({
        apiversion: 'v1',
        method: 'surveys.surveys.launch',
        data: expect.objectContaining({ survey_id: id, status: 'LAUNCHED', launched_at: '2026-06-30T14:05:09' }),
      });
      const repeat = await inject({ method: 'POST', url: `${FIXTURE_BASE}/${id}/launch${SITE_A}&opt2TaskToken=${TOKEN}`, body: {} });
      expect(repeat.statusCode).toBe(200);
      expect((repeat.json() as { data: unknown }).data).toEqual((first.json() as { data: unknown }).data);
    });

    it.each<[string, string, Record<string, string>, number, object]>([
      ['an unknown site', '?siteid=nowhere', {}, 400, INVALID_PARAMETERS],
      ['a site without a registered tenant', `?siteid=${UNREGISTERED_TENANT_SITE}`, {}, 400, INVALID_PARAMETERS],
      ['an undeclared override', SITE_A, { 'x-http-method-override': 'PUT' }, 404, NOT_FOUND],
      ['a survey of another site', '?siteid=tenant-b', {}, 403, FORBIDDEN],
    ])('answers %s as the fixture does', async (_case, query, headers, status, error) => {
      const id = await scheduled();
      const res = await inject({ method: 'GET', url: `${FIXTURE_BASE}/${id}/launch${query}&opt2TaskToken=${TOKEN}`, headers });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ method: 'surveys.surveys.launch', error });
    });
  });
});
