// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * `listExportSheetStatus`, reporting's System read of an export job's sheet status rows, through app.inject over a throwaway
 * `timesheets` schema and a reporting double: the tenant comes from this service's registry once reporting confirms the stored
 * job, never from the caller.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, createService, fixedClock, loadEnv, type FastifyInstance, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS, type TimesheetDayRow, type TimesheetRow } from '../../src/repo/tables.js';
import { EXPORT_SHEET_STATUS_PATH } from '../../src/routes/export-reads.js';
import { registerRoutes } from '../../src/routes/index.js';
import { recordingDb } from '../helpers/recording-db.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const AS_OF = '2026-06-30';
const EXPORT_ID = '7E57A0C7-1111-4000-8000000000000001';
const OTHER_EXPORT_ID = '7E57A0C7-1111-4000-8000000000000002';
const CLAIM = '2';
const PERSON = '7E57A0C7-1111-4000-8000000000000003';
const SCOPE_PATH = `/internal/v1/exports/${EXPORT_ID}/source-scope`;
const FORBIDDEN = { code: LEGACY_ERROR_MAP.authorization.code, message: LEGACY_ERROR_MAP.authorization.message };

/** Reporting's answer to a scope lookup: a status and body, or an error the service client throws. */
type ScopeAnswer = { status: number; body?: unknown } | Error;

/** Reporting's answer for its job EXPORT_ID of tenant-a, running under CLAIM and reading the timesheets, with `overrides`. */
function confirmed(overrides: Record<string, unknown> = {}): ScopeAnswer {
  return {
    status: 200,
    body: { exportId: EXPORT_ID, tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, source: 'timesheets.sheets', state: 'running', claim: CLAIM, ...overrides },
  };
}

/** The export read of tenant-a's job EXPORT_ID under CLAIM as of AS_OF, page 1 of 2 rows, `query` overriding or, empty, dropping a parameter. */
function readUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ exportId: EXPORT_ID, siteId: TENANT_A.siteId, claim: CLAIM, asOf: AS_OF, pageIndex: '1', itemsPerPage: '2', ...query });
  for (const [name, value] of Object.entries(query)) if (value === '') params.delete(name);
  return `${EXPORT_SHEET_STATUS_PATH}?${params.toString()}`;
}

/** Reporting's workload credential addressed to timesheets, as its export runs send it. */
async function reportingHeaders(): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'reporting', audience: 'timesheets' })}` };
}

const available = await pgAvailable();

describe.skipIf(!available)('timesheets export sheet status read', () => {
  let handle: ThrowawaySchema;
  let repository: TimesheetsRepository;
  let app: FastifyInstance;
  /** Statements the routes ran in tenant transactions. */
  const statements: string[] = [];
  /** Scope lookups reporting received. */
  const lookups: ServiceRequest[] = [];
  let scopeAnswer: ScopeAnswer = confirmed();
  /** Tenant-a sheets in period order. */
  const sheetsA = [cfUuid(), cfUuid(), cfUuid()];
  const sheetB = cfUuid();

  /** Reporting's scope lookup, answered with `scopeAnswer`; any other service call rejects. */
  function reporting<T>(request: ServiceRequest): Promise<ServiceResponse<T>> {
    if (request.service !== 'reporting' || request.method !== 'GET' || !/^\/internal\/v1\/exports\/[^/]+\/source-scope$/.test(request.path)) {
      return Promise.reject(new Error(`the export read calls no other service: ${request.method} ${request.service} ${request.path}`));
    }
    lookups.push(request);
    if (scopeAnswer instanceof Error) return Promise.reject(scopeAnswer);
    return Promise.resolve({ status: scopeAnswer.status, headers: { 'content-type': 'application/json' }, body: scopeAnswer.body as T });
  }

  function sheet(id: string, siteid: string, periodStart: Date, programId: number): Omit<TimesheetRow, 'tenant_id'> {
    return {
      timesheet_id: id,
      person_id: PERSON,
      siteid,
      period_start: periodStart,
      period_end: new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate() + 6),
      due_date: new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate() + 9),
      created: new Date(2026, 4, 31, 9, 0, 0),
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: programId,
    };
  }

  function day(timesheetId: string, workDate: Date, state: string, programId: number): Omit<TimesheetDayRow, 'tenant_id'> {
    return { day_id: cfUuid(), timesheet_id: timesheetId, work_date: workDate, hours: '7.5000', state, lastupdate: null, lastupdatebyid: null, legacy_program_id: programId };
  }

  /** Sends `url` with `headers`, returning the answer, the tenant statements it ran and the lookups it made. */
  async function send(url: string, headers: Record<string, string>) {
    const [ran, looked] = [statements.length, lookups.length];
    const res = await app.inject({ method: 'GET', url, headers });
    return { res, tenantStatements: statements.slice(ran), lookups: lookups.slice(looked) };
  }

  /** Validates `res` against `listExportSheetStatus` in the timesheets contract. */
  function assertContract(res: Awaited<ReturnType<FastifyInstance['inject']>>): void {
    assertResponseMatchesOpenApi(OPENAPI, {
      method: 'GET',
      path: EXPORT_SHEET_STATUS_PATH,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body: res.body,
    });
  }

  const errorOf = (res: Awaited<ReturnType<FastifyInstance['inject']>>): unknown => (JSON.parse(res.body) as { error?: unknown }).error;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'timesheets', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, TIMESHEETS_UNITS);
    await seedRegistry(handle.app);
    app = await createService({
      name: 'timesheets',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8118',
        OPT2_SERVICE_NAME: 'timesheets',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      clock: CLOCK,
      verifierOverride: testVerifier('timesheets'),
      pool: handle.app,
      logger: createLogger({ service: 'timesheets', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerWritePositionHeader(app);
    repository = createTimesheetsRepository({ clock: CLOCK, schema: handle.schema });
    registerRoutes(app, { db: recordingDb(handle.app, statements), repository, clock: CLOCK });
    await app.ready();
    vi.spyOn(app.opt2.client, 'request').mockImplementation(reporting);
    await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'reporting-system-test', allowLegacy: true });
    await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'reporting-system-test', state: 'open' });

    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      for (const [index, id] of sheetsA.entries()) await repository.insert(tx, 'timesheet', sheet(id, TENANT_A.siteId, new Date(2026, 5, 1 + 7 * index), 1));
      await repository.insert(tx, 'timesheet_day', day(sheetsA[0] as string, new Date(2026, 5, 1), 'APPROVED', 1));
      await repository.insert(tx, 'timesheet_day', day(sheetsA[1] as string, new Date(2026, 5, 8), 'SUBMITTED', 1));
    });
    await handle.app.withTenant(TENANT_B.tenantId, (tx) => repository.insert(tx, 'timesheet', sheet(sheetB, TENANT_B.siteId, new Date(2026, 5, 1), 2)));
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  beforeEach(() => {
    scopeAnswer = confirmed();
  });

  describe('a confirmed export scope', () => {
    it.each([
      ['the job site', TENANT_A.siteId],
      ['the job site in another case', TENANT_A.siteId.toUpperCase()],
    ])(
      "answers the registry tenant's rows as the sheet status list pages them, after one scope lookup sending %s and no user token",
      async (_case, siteId) => {
        const { res, tenantStatements, lookups: made } = await send(readUrl({ siteId }), await reportingHeaders());

        expect(res.statusCode, res.body).toBe(200);
        assertContract(res);
        const [user, gateway] = await Promise.all([
          mintUserToken({ sub: PERSON, site: TENANT_A.siteId, roles: [Roles.systemUser, Roles.reportingExporter] }),
          mintServiceToken({ caller: 'gateway', audience: 'timesheets' }),
        ]);
        const listed = await app.inject({
          url: `/v1/timesheets/sheet-status?asOf=${AS_OF}&pageIndex=1&itemsPerPage=2`,
          headers: { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${gateway}` },
        });
        expect(listed.statusCode, listed.body).toBe(200);
        const body = JSON.parse(res.body) as { items: Array<{ timesheetId: string }>; total: number };
        expect(body.items).toStrictEqual((JSON.parse(listed.body) as { items: unknown[] }).items);
        expect([body.items.map((item) => item.timesheetId), body.total]).toStrictEqual([sheetsA.slice(0, 2), sheetsA.length]);
        expect(tenantStatements.length).toBeGreaterThan(0);
        expect(tenantStatements.filter((sql) => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql))).toStrictEqual([]);
        expect(made).toStrictEqual([{ service: 'reporting', method: 'GET', path: SCOPE_PATH, query: { siteId }, userToken: null }]);
      },
    );

    it('answers the last page and the count of every sheet', async () => {
      const { res } = await send(readUrl({ pageIndex: '2' }), await reportingHeaders());

      expect(res.statusCode, res.body).toBe(200);
      const body = JSON.parse(res.body) as { items: Array<{ timesheetId: string }>; total: number };
      expect([body.items.map((item) => item.timesheetId), body.total]).toStrictEqual([sheetsA.slice(2), sheetsA.length]);
    });
  });

  describe('an export scope reporting does not confirm', () => {
    it.each<[string, ScopeAnswer]>([
      ['another job', confirmed({ exportId: OTHER_EXPORT_ID })],
      ['the job under another tenant', confirmed({ tenantId: TENANT_B.tenantId })],
      ['the job on another site', confirmed({ siteId: TENANT_B.siteId })],
      ['a job reading the finance records', confirmed({ source: 'finance.records' })],
      ['a queued job', confirmed({ state: 'queued' })],
      ['a done job', confirmed({ state: 'done' })],
      ['a failed job', confirmed({ state: 'failed' })],
      ['a job its run has since reclaimed', confirmed({ claim: '3' })],
      ["reporting's notFound", { status: 404, body: { error: { code: 'invalid_request', message: 'Not Found' } } }],
      ["reporting's refusal", { status: 403, body: { error: FORBIDDEN } }],
      ['a body that is no scope', { status: 200, body: null }],
    ])('refuses %s with 403 before any tenant statement', async (_case, answer) => {
      scopeAnswer = answer;

      const { res, tenantStatements, lookups: made } = await send(readUrl(), await reportingHeaders());

      expect([res.statusCode, errorOf(res)]).toStrictEqual([403, FORBIDDEN]);
      assertContract(res);
      expect({ tenantStatements, lookups: made.length }).toStrictEqual({ tenantStatements: [], lookups: 1 });
    });

    it("refuses a tenant-b site reporting confirms only for tenant-a's job, reading neither tenant", async () => {
      const { res, tenantStatements, lookups: made } = await send(readUrl({ siteId: TENANT_B.siteId }), await reportingHeaders());

      expect([res.statusCode, errorOf(res)]).toStrictEqual([403, FORBIDDEN]);
      expect({ tenantStatements, lookups: made.map((lookup) => lookup.query) }).toStrictEqual({ tenantStatements: [], lookups: [{ siteId: TENANT_B.siteId }] });
    });

    it('refuses a site the registry does not hold without asking reporting', async () => {
      const { res, tenantStatements, lookups: made } = await send(readUrl({ siteId: 'no-such-site' }), await reportingHeaders());

      expect([res.statusCode, errorOf(res)]).toStrictEqual([403, FORBIDDEN]);
      expect({ tenantStatements, lookups: made }).toStrictEqual({ tenantStatements: [], lookups: [] });
    });

    it.each<[string, ScopeAnswer]>([
      ['answers 503', { status: 503, body: { error: { code: 'server_error', message: 'Service Unavailable' } } }],
      ['answers 500', { status: 500 }],
      ['cannot be reached', new ServiceUnavailableError('reporting', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))],
    ])('answers the legacy 503 when reporting %s, before any tenant statement', async (_case, answer) => {
      scopeAnswer = answer;

      const { res, tenantStatements } = await send(readUrl(), await reportingHeaders());

      expect(res.statusCode, res.body).toBe(503);
      assertContract(res);
      expect(tenantStatements).toStrictEqual([]);
    });
  });

  describe('credentials and parameters', () => {
    it.each<[string, () => Promise<Record<string, string>>, number]>([
      [
        "an exporter's user token through the gateway",
        async () => ({
          authorization: `Bearer ${await mintUserToken({ sub: PERSON, site: TENANT_A.siteId, roles: [Roles.systemUser, Roles.reportingExporter] })}`,
          [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'timesheets' })}`,
        }),
        403,
      ],
      ["the finance workload's credential", async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'finance', audience: 'timesheets' })}` }), 403],
      [
        'the gateway credential carrying the exporter role',
        async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'timesheets', roles: [Roles.reportingExporter] })}` }),
        403,
      ],
      ["reporting's credential addressed to finance", async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'reporting', audience: 'finance' })}` }), 401],
      ['a tasks-invoker token', async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'timesheets' })}` }), 401],
      ['no credential', () => Promise.resolve({}), 401],
    ])('refuses %s before any lookup or tenant statement', async (_case, headers, status) => {
      const { res, tenantStatements, lookups: made } = await send(readUrl(), await headers());

      expect(res.statusCode, res.body).toBe(status);
      expect({ tenantStatements, lookups: made }).toStrictEqual({ tenantStatements: [], lookups: [] });
    });

    it.each([
      ['no claim', { claim: '' }],
      ['no asOf', { asOf: '' }],
      ['a non-calendar asOf', { asOf: '2026-02-30' }],
      ['a malformed job id', { exportId: 'not-a-job' }],
      ['a page of 0', { pageIndex: '0' }],
      ['a page size above 1000', { itemsPerPage: '1001' }],
    ])('answers 400 to %s before any lookup', async (_case, query) => {
      const { res, tenantStatements, lookups: made } = await send(readUrl(query), await reportingHeaders());

      expect(res.statusCode, res.body).toBe(400);
      assertContract(res);
      expect({ tenantStatements, lookups: made }).toStrictEqual({ tenantStatements: [], lookups: [] });
    });
  });
});
