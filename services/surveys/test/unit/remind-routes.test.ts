// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `markReminderSent` and the fixture remind callback over a throwaway `surveys` schema: answers, check order, auth, isolation and gates. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, sha256Hex } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { siteForTenant, tenantForRegisteredSite, tenantIdForSite, withMetadata } from '@opt2/platform/tenancy';
import {
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { FIXTURE_REMIND_PATH, REMINDER_SENT_PATH, registerRemindRoutes } from '../../src/routes/remind.js';
import { createSurveysRepository, reminderTaskName, type SurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9);
const LAUNCH_AT = new Date(2026, 6, 1, 9, 0, 0);
const TOKEN = 'task-token-1';
const USER_ID = '11111111-2222-3333-4444555566667777';
const JSON_HEADERS = { 'content-type': 'application/json' };
const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const SENT_AT = '2026-07-01T10:00:02.500';
const UNREGISTERED_TENANT_SITE = 'ghost';

type ReminderState = { task_name: string; sent_at: Date | null };

const available = await pgAvailable();

describe.skipIf(!available)('remind routes', () => {
  let handle: ThrowawaySchema;
  let repository: SurveysRepository;
  let app: FastifyInstance;
  let stateDir: string;
  let surveyId: string;

  function admin(sql: string, params: unknown[] = []): Promise<unknown> {
    return withMetadata(handle.app, (tx) => tx.query(sql.replaceAll('$schema', handle.schema), params));
  }

  function reminders(): Promise<ReminderState[]> {
    return handle.app.withTenant(TENANT_A, async (tx) => {
      const sql = `SELECT task_name, sent_at FROM ${handle.schema}.survey_reminder WHERE survey_id = $1 ORDER BY length(task_name), task_name`;
      return (await tx.query<ReminderState>(sql, [surveyId])).rows;
    });
  }

  async function nothingSent(): Promise<boolean> {
    return (await reminders()).every((reminder) => reminder.sent_at === null);
  }

  async function serviceHeaders(caller: string): Promise<Record<string, string>> {
    return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: 'surveys' })}` };
  }

  function sentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { tenantId: TENANT_A, siteId: 'tenant-a', taskName: reminderTaskName(surveyId, 1), scheduleVersion: 1, sentAt: SENT_AT, ...overrides };
  }

  async function postSent(n: string | number, body: unknown, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: `/internal/v1/surveys/${surveyId}/reminders/${n}/sent`,
      headers: { ...(headers ?? (await serviceHeaders('communications'))), ...JSON_HEADERS },
      payload: JSON.stringify(body),
    });
  }

  function remind(method: 'GET' | 'POST', query: string, opts: { id?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    return app.inject({
      method,
      url: `/legacy-fixtures/cfml/api.cfm/surveys/surveys/${opts.id ?? surveyId}/remind?${query}`,
      headers: { ...opts.headers, ...(opts.body === undefined ? {} : JSON_HEADERS) },
      payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), 'opt2-surveys-remind-routes-'));
    await writeTestSecrets(stateDir);
    handle = await createThrowawaySchema({ service: 'surveys', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repository = createSurveysRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
    for (const site of ['tenant-a', 'tenant-b']) {
      await admin('INSERT INTO $schema.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, $3)', [
        site,
        tenantIdForSite(site),
        NOW,
      ]);
    }
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
      verifierOverride: testVerifier('surveys'),
      logger: createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    const db = handle.app;
    await registerRemindRoutes(app, {
      db,
      repository,
      siteLookup: {
        // `ghost` stands for a site the registry drops between the site check and the tenant lookup.
        registeredSite: async (site) => {
          if (site === UNREGISTERED_TENANT_SITE) return site;
          const tenant = await tenantForRegisteredSite(db, site);
          return tenant === null ? undefined : ((await siteForTenant(db, tenant)) ?? undefined);
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
    await rm(stateDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await admin("UPDATE $schema.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'");
    surveyId = await handle.app.withTenant(TENANT_A, async (tx) => {
      const survey = await repository.insertSurvey(tx, { siteId: 'tenant-a', title: 'Pulse', createdById: USER_ID });
      await repository.upsertSchedule(tx, survey.survey_id, { launchAt: LAUNCH_AT, taskTokenHash: sha256Hex(TOKEN) });
      const offsets = [60, 120].map((minutes) => ({
        offsetMinutes: minutes,
        remindAt: new Date(LAUNCH_AT.getTime() + minutes * 60_000),
        taskTokenHash: sha256Hex(TOKEN),
      }));
      await repository.replaceReminders(tx, survey.survey_id, offsets);
      return survey.survey_id;
    });
  });

  it('declares the contract operations', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url !== '/healthz');
    expect(routes).toEqual([
      { method: 'POST', url: REMINDER_SENT_PATH, transport: 'service', requires: ['service:communications'], siteCheck: true },
      { method: 'GET', url: FIXTURE_REMIND_PATH, transport: 'service', public: true, siteCheck: false },
      { method: 'POST', url: FIXTURE_REMIND_PATH, transport: 'service', public: true, siteCheck: false },
    ]);
  });

  describe('markReminderSent', () => {
    it('stamps the reported time once, then answers applied false', async () => {
      const first = await postSent(1, sentBody());
      expect([first.statusCode, first.json()]).toEqual([200, { applied: true }]);
      expect((await reminders()).map((reminder) => reminder.sent_at)).toEqual([new Date(2026, 6, 1, 10, 0, 2, 500), null]);

      const again = await postSent(1, sentBody({ sentAt: '2026-07-01T11:00:00.000' }));
      expect([again.statusCode, again.json()]).toEqual([200, { applied: false }]);
      expect((await reminders())[0]?.sent_at).toEqual(new Date(2026, 6, 1, 10, 0, 2, 500));
    });

    it('answers applied false without a write for an older schedule version', async () => {
      await handle.app.withTenant(TENANT_A, (tx) => repository.upsertSchedule(tx, surveyId, { launchAt: LAUNCH_AT, taskTokenHash: sha256Hex(TOKEN) }));
      const res = await postSent(2, sentBody({ taskName: reminderTaskName(surveyId, 2), scheduleVersion: 1 }));
      expect([res.statusCode, res.json()]).toEqual([200, { applied: false }]);
      expect(await nothingSent()).toBe(true);
    });

    it.each<[string, (id: string) => Record<string, unknown>, number]>([
      ['another tenant', () => ({ tenantId: TENANT_B }), 1],
      ['another site', () => ({ siteId: 'tenant-b' }), 1],
      ['a task name of another ordinal', (id) => ({ taskName: reminderTaskName(id, 2) }), 1],
      ['an ordinal the survey lacks', (id) => ({ taskName: reminderTaskName(id, 7) }), 7],
    ])('answers the legacy 404 and writes nothing for %s', async (_label, overrides, n) => {
      const res = await postSent(n, sentBody(overrides(surveyId)));
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
      expect(await nothingSent()).toBe(true);
    });

    it.each<[string, string, Record<string, unknown>]>([
      ['a missing field', '1', { scheduleVersion: undefined }],
      ['an extra field', '1', { extra: 1 }],
      ['a rolled-over date', '1', { sentAt: '2026-02-30T10:00:00.000' }],
      ['a time without milliseconds', '1', { sentAt: '2026-07-01T10:00:02' }],
      ['version 0', '1', { scheduleVersion: 0 }],
      ['a malformed tenant', '1', { tenantId: 'not-a-uuid' }],
      ['ordinal 0', '0', {}],
      ['a zero-padded ordinal', '01', {}],
      ['a non-numeric ordinal', 'x', {}],
    ])('answers invalidParameters for %s', async (_label, n, overrides) => {
      const res = await postSent(n, sentBody(overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toEqual({ message: 'Invalid parameters', code: 'invalid_request' });
      expect(await nothingSent()).toBe(true);
    });

    it('refuses every caller but communications before the handler', async () => {
      const userToken = { authorization: `Bearer ${await mintUserToken({ sub: USER_ID, site: 'tenant-a', roles: [Roles.surveysManager] })}` };
      const tasksInvoker = { authorization: `Bearer ${await mintServiceToken({ caller: 'tasks-invoker', audience: 'surveys' })}` };
      const callers: Array<[Record<string, string>, number]> = [
        [{}, 401],
        [userToken, 401],
        [tasksInvoker, 401],
        [await serviceHeaders('tasks-invoker'), 401],
        [await serviceHeaders('pubsub-invoker'), 401],
        [await serviceHeaders('people'), 403],
        [{ ...userToken, ...(await serviceHeaders('people')) }, 403],
      ];
      for (const [headers, status] of callers) {
        expect((await postSent(1, sentBody(), headers)).statusCode).toBe(status);
      }
      expect(await nothingSent()).toBe(true);
    });

    it('answers the legacy 503 while the reminder unit is not target-authoritative', async () => {
      await admin("UPDATE $schema.unit_gate SET state = 'legacy' WHERE unit = 'surveys.survey_reminder'");
      expect((await postSent(1, sentBody())).statusCode).toBe(503);
    });
  });

  describe('fixture remind callback', () => {
    it('stamps the reminder once and answers its fixture row, by GET or POST and with any id case', async () => {
      const res = await remind('GET', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=2`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        apiversion: 'v1',
        method: 'surveys.surveys.remind',
        data: {
          reminder_id: expect.stringMatching(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/),
          survey_id: surveyId,
          offset_minutes: 120,
          remind_at: '2026-07-01T11:00:00',
          task_name: reminderTaskName(surveyId, 2),
          sent_at: '2026-06-30T14:05:09',
        },
      });

      const again = await remind('POST', `opt2TaskToken=${TOKEN}`, { id: surveyId.toLowerCase(), body: { siteid: 'tenant-a', reminder: 2 } });
      expect([again.statusCode, again.json().data]).toEqual([200, res.json().data]);
      expect((await reminders()).map((reminder) => reminder.sent_at)).toEqual([null, NOW]);
    });

    it.each<[string, string, number, string]>([
      ['an unknown site', 'siteid=nowhere&opt2TaskToken=x&reminder=1', 400, 'Invalid parameters'],
      ['a site the registry no longer holds', `siteid=${UNREGISTERED_TENANT_SITE}&opt2TaskToken=${TOKEN}&reminder=1`, 400, 'Invalid parameters'],
      ['a wrong token', 'siteid=tenant-a&opt2TaskToken=nope&reminder=1', 403, 'Insufficient Account Permissions'],
      ['no token', 'siteid=tenant-a&reminder=1', 403, 'Insufficient Account Permissions'],
      ['a repeated token', `siteid=tenant-a&opt2TaskToken=${TOKEN}&opt2TaskToken=${TOKEN}&reminder=1`, 403, 'Insufficient Account Permissions'],
      ['a survey of another site', `siteid=tenant-b&opt2TaskToken=${TOKEN}&reminder=1`, 403, 'Insufficient Account Permissions'],
      ['ordinal 0 after the token check', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=0`, 400, 'Invalid parameters'],
      ['no ordinal', `siteid=tenant-a&opt2TaskToken=${TOKEN}`, 400, 'Invalid parameters'],
      ['a signed non-ASCII ordinal', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=-%D9%A3`, 400, 'Invalid parameters'],
      ['a non-ASCII ordinal, which ACF int() fails on', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=%D9%A3`, 500, 'Unhandled Exception'],
      ['an ordinal the survey lacks', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=9`, 404, 'Not Found'],
    ])('answers the fixture error for %s', async (_label, query, status, message) => {
      const res = await remind('GET', query);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toMatchObject({ method: 'surveys.surveys.remind', error: { message } });
      expect(await nothingSent()).toBe(true);
    });

    it('reads the token from the url only and answers notFound for another overriding method', async () => {
      expect((await remind('POST', 'siteid=tenant-a&reminder=1', { body: { opt2TaskToken: TOKEN } })).statusCode).toBe(403);
      const override = await remind('GET', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=1`, { headers: { 'x-http-method-override': 'DELETE' } });
      expect([override.statusCode, override.json().error.message]).toEqual([404, 'Not Found']);
      expect(await nothingSent()).toBe(true);
    });

    it('answers forbidden for a user token of another site', async () => {
      const token = await mintUserToken({ sub: USER_ID, site: 'tenant-b', roles: [Roles.member] });
      const res = await remind('GET', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=1`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
    });

    it('answers the legacy 503 while the reminder unit is not target-authoritative', async () => {
      await admin("UPDATE $schema.unit_gate SET state = 'legacy' WHERE unit = 'surveys.survey_reminder'");
      expect((await remind('GET', `siteid=tenant-a&opt2TaskToken=${TOKEN}&reminder=1`)).statusCode).toBe(503);
    });
  });
});
