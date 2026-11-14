// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets fixture routes through `app.inject` against a throwaway `timesheets` schema, compared with legacy-fixtures/cfml/modules/timesheets.cfc. */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthDenial, INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { cfHash, cfUuid } from '@opt2/platform/legacy-compat';
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { FixtureApiError } from '../../src/legacy/envelope.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS, type ApprovalActionRow, type TimesheetDayRow, type TimesheetRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX, parseFixtureAsOf, resolveFixtureProgram, timesheetsFixturePlugin } from '../../src/routes/fixture.js';
import { recordingDb, statementsOn } from '../helpers/recording-db.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const P = FIXTURE_PREFIX;
const EMPLOYEE = [Roles.systemUser, Roles.timesheetsEmployee];
const PRIMARY = [Roles.systemUser, Roles.timesheetsPrimaryApprover];
const SECONDARY = [Roles.systemUser, Roles.timesheetsSecondaryApprover];
const FIXTURE_ROLES = [Roles.timesheetsEmployee, Roles.timesheetsPrimaryApprover, Roles.timesheetsSecondaryApprover];
const USER_ID = '11111111-2222-3333-4444555566667777';
const PERSON = 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000';
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const GOOD_TOKEN = 'VALIDCSRFTOKEN';
const CSRF = { 'x-csrf_token': GOOD_TOKEN, 'x-csrf_token_expires': '991231235959000' };

type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;
type New<R> = Omit<R, 'tenant_id'>;

const errorBody = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

describe('parseFixtureAsOf', () => {
  it.each<[unknown, string | undefined]>([
    [undefined, '2026-06-30'],
    [null, '2026-06-30'],
    ['2026-06-30', '2026-06-30'],
    ['2024-02-29', '2024-02-29'],
    ['1753-01-01', '1753-01-01'],
    ['2023-02-29', undefined],
    ['2026-13-01', undefined],
    ['2026-00-10', undefined],
    ['2026-06-00', undefined],
    ['1752-12-31', undefined],
    ['2026-6-30', undefined],
    ['', undefined],
    ['2026-06-30T00:00:00', undefined],
    [20260630, undefined],
    [{ asOf: '2026-06-30' }, undefined],
  ])('reads %j as timesheets.cfc asOfParam does', (raw, asOf) => {
    const expected = asOf === undefined ? { ok: false, message: 'Invalid parameters' } : { ok: true, asOf };
    expect(parseFixtureAsOf(raw, CLOCK)).toEqual(expected);
  });
});

describe('resolveFixtureProgram', () => {
  it.each<[Record<string, unknown>, string, { siteId: string; programId: number }]>([
    [{}, 'tenant-a', { siteId: 'tenant-a', programId: 1 }],
    [{ siteid: '' }, 'TENANT-B', { siteId: 'tenant-b', programId: 2 }],
    [{ SiteID: 'Tenant-A' }, 'tenant-a', { siteId: 'tenant-a', programId: 1 }],
  ])('maps params %j with token site %s to its canonical program site', (params, site, expected) => {
    expect(resolveFixtureProgram(params, { site })).toEqual(expected);
  });

  it('refuses a site other than the token site, and a site without a program', () => {
    expect(() => resolveFixtureProgram({ siteid: 'tenant-b' }, { site: 'tenant-a' })).toThrow(AuthDenial);
    expect(() => resolveFixtureProgram({}, { site: '' })).toThrow(AuthDenial);
    expect(() => resolveFixtureProgram({}, { site: 'default' })).toThrow(FixtureApiError);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('timesheets fixture routes', () => {
  let handle: ThrowawaySchema;
  let repository: TimesheetsRepository;
  let identity: http.Server;
  let app: FastifyInstance;
  const consumed: Array<{ sessionId: string; token: string; context: string }> = [];
  const logLines: string[] = [];
  const errorSpies: { mock: { calls: unknown[][] } }[] = [];
  const statements: string[] = [];

  /** Seeded tenant-a sheets: two of tenant-a's site and one of another site in the same tenant. */
  const sheets = { june1: cfUuid(), june8: cfUuid(), foreign: cfUuid() };
  const days = { draft: cfUuid(), submitted: cfUuid(), approved: cfUuid(), blackedOut: cfUuid(), later: cfUuid() };

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'timesheets', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, TIMESHEETS_UNITS);
    await seedRegistry(handle.app);
    identity = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const consume = JSON.parse(Buffer.concat(chunks).toString('utf8')) as (typeof consumed)[number];
        consumed.push(consume);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ valid: consume.token === GOOD_TOKEN }));
      });
    });
    await new Promise<void>((resolve) => identity.listen(0, '127.0.0.1', resolve));
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
        OPT2_SERVICE_URLS: JSON.stringify({ identity: `http://127.0.0.1:${(identity.address() as AddressInfo).port}` }),
        TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
      verifierOverride: testVerifier('timesheets'),
      pool: handle.app,
      logger: createLogger({ service: 'timesheets', version: '1.0.0', env: 'local', destination: { write: (line: string) => void logLines.push(line) } }),
    });
    registerWritePositionHeader(app);
    app.addHook('onRequest', async (request) => {
      errorSpies.push(vi.spyOn(request.log, 'error'));
    });
    repository = createTimesheetsRepository({ clock: CLOCK, schema: handle.schema });
    await app.register(timesheetsFixturePlugin, { db: recordingDb(handle.app, statements), repository, clock: CLOCK });
    await app.ready();
    await setGates('open');

    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await repository.insert(tx, 'timesheet', sheet(sheets.june1, new Date(2026, 5, 1), new Date(2026, 5, 10)));
      await repository.insert(tx, 'timesheet', sheet(sheets.june8, new Date(2026, 5, 8), new Date(2026, 5, 17)));
      await repository.insert(tx, 'timesheet', { ...sheet(sheets.foreign, new Date(2026, 5, 1), new Date(2026, 5, 10)), siteid: 'tenant-b' });
      await repository.insert(tx, 'timesheet_day', day(days.draft, sheets.june1, new Date(2026, 5, 1), 'DRAFT'));
      await repository.insert(tx, 'timesheet_day', day(days.submitted, sheets.june1, new Date(2026, 5, 2), 'SUBMITTED'));
      await repository.insert(tx, 'timesheet_day', day(days.blackedOut, sheets.june1, new Date(2026, 5, 3), 'DRAFT'));
      await repository.insert(tx, 'timesheet_day', day(days.approved, sheets.june8, new Date(2026, 5, 8), 'APPROVED'));
      await repository.insert(tx, 'blackout', blackout(days.blackedOut));
    });
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await new Promise((resolve) => identity?.close(resolve));
    await handle?.drop();
  });

  beforeEach(async () => {
    consumed.length = 0;
    await setGates('open');
  });

  /** Moves every timesheets gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'fixture-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'fixture-routes-test', state });
  }

  function sheet(id: string, periodStart: Date, dueDate: Date, programId = 1): New<TimesheetRow> {
    return {
      timesheet_id: id,
      person_id: PERSON,
      siteid: programId === 1 ? 'tenant-a' : 'tenant-b',
      period_start: periodStart,
      period_end: new Date(periodStart.getTime() + 6 * 86_400_000),
      due_date: dueDate,
      created: new Date(2026, 4, 31, 9, 0, 0),
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: programId,
    };
  }

  function day(id: string, timesheetId: string, workDate: Date, state: string, programId = 1): New<TimesheetDayRow> {
    return { day_id: id, timesheet_id: timesheetId, work_date: workDate, hours: '7.5000', state, lastupdate: null, lastupdatebyid: null, legacy_program_id: programId };
  }

  function blackout(dayId: string, programId = 1) {
    return { blackout_id: cfUuid(), day_id: dayId, person_id: PERSON, archive_id: null, reason: 'person-archived', created: NOW, legacy_program_id: programId };
  }

  /** A fresh tenant-b sheet holding one day in `state`, blacked out when `blackedOut`; returns the day id. */
  async function seedTenantBDay(state: string, { blackedOut = false, siteid = 'tenant-b' } = {}): Promise<string> {
    const [sheetId, dayId] = [cfUuid(), cfUuid()];
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      await repository.insert(tx, 'timesheet', { ...sheet(sheetId, new Date(2026, 5, 15), new Date(2026, 5, 24), 2), siteid });
      await repository.insert(tx, 'timesheet_day', day(dayId, sheetId, new Date(2026, 5, 15), state, 2));
      if (blackedOut) await repository.insert(tx, 'blackout', blackout(dayId, 2));
    });
    return dayId;
  }

  /** The day's stored state and its approval actions in tenant B. */
  function storedDay(dayId: string): Promise<{ state: string | undefined; actions: ApprovalActionRow[] }> {
    return handle.app.withTenant(TENANT_B.tenantId, async (tx) => ({
      state: (await tx.query<{ state: string }>(`SELECT state FROM ${handle.schema}.timesheet_day WHERE day_id = $1`, [dayId])).rows[0]?.state,
      actions: (await tx.query<ApprovalActionRow>(`SELECT * FROM ${handle.schema}.approval_action WHERE day_id = $1`, [dayId])).rows,
    }));
  }

  /** A user token for `roles` on `site` plus the gateway's invocation credential. */
  async function headersFor(roles: readonly string[], site: string = TENANT_A.siteId): Promise<Record<string, string>> {
    const [token, invocation] = await Promise.all([
      mintUserToken({ sub: USER_ID, site, roles }),
      mintServiceToken({ caller: 'gateway', audience: 'timesheets' }),
    ]);
    return { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
  }

  /** A GET as `roles` on tenant-a. */
  async function get(url: string, roles: readonly string[] = PRIMARY, site: string = TENANT_A.siteId): Promise<Injected> {
    return app.inject({ url: `${P}${url}`, headers: await headersFor(roles, site) });
  }

  /** A JSON-body day action as `roles` on tenant-b, with a valid CSRF token unless `csrf` is false. */
  async function act(dayId: string, action: string, roles: readonly string[], payload?: Record<string, unknown>, csrf = true): Promise<Injected> {
    const headers = { ...(await headersFor(roles, TENANT_B.siteId)), ...(csrf ? CSRF : {}) };
    return app.inject({ method: 'POST', url: `${P}/days/${dayId}/${action}`, headers, ...(payload === undefined ? {} : { payload }) });
  }

  /** A `method` call of `url` with `X-HTTP-Method-Override: override` (none when undefined), checked against the contract. */
  async function overridden(
    method: 'GET' | 'POST',
    url: string,
    override: string | undefined,
    { roles = PRIMARY, site = TENANT_A.siteId }: { roles?: readonly string[]; site?: string } = {},
  ): Promise<Injected> {
    const headers = { ...(await headersFor(roles, site)), ...CSRF, ...(override === undefined ? {} : { 'x-http-method-override': override }) };
    const res = await app.inject({ method, url: `${P}${url}`, headers });
    assertResponseMatchesOpenApi(OPENAPI, { method, path: `${P}${url}`, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  it('declares the four contract routes for GET and POST with the fixture roles on the service transport, site-checked', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith(P));
    expect(routes.map(({ method, url, requires, transport, siteCheck }) => [method, url.slice(P.length), requires, transport, siteCheck])).toEqual([
      ['GET', '/days/:id/:action', FIXTURE_ROLES, 'service', true],
      ['POST', '/days/:id/:action', FIXTURE_ROLES, 'service', true],
      ['GET', '/sheets', FIXTURE_ROLES, 'service', true],
      ['POST', '/sheets', FIXTURE_ROLES, 'service', true],
      ['GET', '/sheets/:id', FIXTURE_ROLES, 'service', true],
      ['POST', '/sheets/:id', FIXTURE_ROLES, 'service', true],
      ['GET', '/sheets/:id/status', FIXTURE_ROLES, 'service', true],
      ['POST', '/sheets/:id/status', FIXTURE_ROLES, 'service', true],
    ]);
  });

  it.each<[string, () => Promise<Injected>, number, string]>([
    ['no credential', () => app.inject({ url: `${P}/sheets` }), 401, errorBody('timesheets.sheets', 'invalid_request', 'Insufficient Account Permissions')],
    [
      'a role-less user on a day action',
      async () => app.inject({ method: 'POST', url: `${P}/days/${MISSING_ID}/Submit`, headers: await headersFor([Roles.member]) }),
      403,
      errorBody('timesheets.days.submit', 'invalid_request', 'Insufficient Account Permissions'),
    ],
    [
      'a siteid other than the token site',
      () => get(`/sheets/${MISSING_ID}/status?siteid=${TENANT_B.siteId}`),
      403,
      errorBody('timesheets.sheets.status', 'invalid_request', 'Insufficient Account Permissions'),
    ],
    [
      'a role-less user of an unregistered site',
      () => get('/sheets', [Roles.member], 'retired-site'),
      400,
      errorBody('timesheets.sheets', 'invalid_request', 'Invalid parameters'),
    ],
  ])('answers %s in the fixture error envelope', async (_case, send, status, body) => {
    const res = await send();
    expect([res.statusCode, res.body]).toEqual([status, body]);
    expect(res.headers.etag).toBe(cfHash(res.body));
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('answers a rejected user token with the fixture-shaped invalid_token envelope and no challenge', async () => {
    const invocation = (await headersFor(EMPLOYEE))[INVOCATION_HEADER] ?? '';
    const res = await app.inject({ url: `${P}/sheets`, headers: { authorization: 'Bearer not-a-token', [INVOCATION_HEADER]: invocation } });
    expect([res.statusCode, res.body]).toEqual([401, errorBody('timesheets.sheets', 'invalid_token', 'Invalid Access Token')]);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('lists the site sheets in period order with status, overdue and counts, today when asOf is absent', async () => {
    const june1 = { timesheet_id: sheets.june1, status: 'DRAFT', overdue: true, day_count: 3, blackout_count: 1, approved_count: 0 };
    const june8 = { timesheet_id: sheets.june8, status: 'APPROVED', overdue: false, day_count: 1, blackout_count: 0, approved_count: 1 };
    const paging = { startindex: 1, endindex: 2, itemsperpage: 50, totalitems: 2, totalpages: 1, pageindex: 1 };
    const res = await get('/sheets', EMPLOYEE);
    expect([res.statusCode, res.json()]).toEqual([200, { apiversion: 'v1', method: 'timesheets.sheets', data: { items: [june1, june8], ...paging } }]);
    expect(res.headers.etag).toBe(cfHash(res.body));

    expect((await get('/sheets?asOf=2026-06-10')).json().data.items[0]).toEqual({ ...june1, overdue: false });
    expect((await get('/sheets?pageIndex=2&itemsPerPage=1')).json().data).toEqual({
      items: [june8],
      startindex: 2,
      endindex: 2,
      itemsperpage: 1,
      totalitems: 2,
      totalpages: 2,
      pageindex: 2,
    });
    expect((await get('/sheets?pageIndex=3&itemsPerPage=1')).json().data).toMatchObject({ items: [], startindex: 3, endindex: 2, pageindex: 3 });
    expect((await get('/sheets?useDataNamespace=false')).json()).toMatchObject({ method: 'timesheets.sheets', items: [june1, june8], totalitems: 2 });
  });

  it.each<[string, string, number, [number, number]]>([
    ['a page of two sheets', '/sheets', 2, [1, 1]],
    ['a page of one sheet', '/sheets?pageIndex=2&itemsPerPage=1', 1, [1, 1]],
    ['a page past the end', '/sheets?pageIndex=3&itemsPerPage=1', 0, [0, 0]],
  ])('reads the days and then the blackouts of %s in at most one query each', async (_case, url, items, [dayReads, blackoutReads]) => {
    statements.length = 0;
    const res = await get(url);
    expect([res.statusCode, res.json().data.items.length]).toEqual([200, items]);
    expect([statementsOn(statements, 'timesheet_day'), statementsOn(statements, 'blackout')]).toEqual([dayReads, blackoutReads]);
  });

  it('reads a sheet with its status fields and days, matching the id ignoring case, and its status row', async () => {
    const res = await get(`/sheets/${sheets.june1.toLowerCase()}?asOf=2026-06-30`);
    expect([res.statusCode, res.json()]).toEqual([
      200,
      {
        apiversion: 'v1',
        method: 'timesheets.sheets',
        data: {
          timesheet_id: sheets.june1,
          person_id: PERSON,
          siteid: 'tenant-a',
          period_start: '2026-06-01T00:00:00',
          period_end: '2026-06-07T00:00:00',
          due_date: '2026-06-10T00:00:00',
          created: '2026-05-31T09:00:00',
          lastupdate: '',
          lastupdatebyid: '',
          status: 'DRAFT',
          overdue: true,
          day_count: 3,
          blackout_count: 1,
          approved_count: 0,
          days: [
            { day_id: days.draft, timesheet_id: sheets.june1, work_date: '2026-06-01T00:00:00', hours: '7.5000', state: 'DRAFT', isblackout: false },
            { day_id: days.submitted, timesheet_id: sheets.june1, work_date: '2026-06-02T00:00:00', hours: '7.5000', state: 'SUBMITTED', isblackout: false },
            { day_id: days.blackedOut, timesheet_id: sheets.june1, work_date: '2026-06-03T00:00:00', hours: '7.5000', state: 'DRAFT', isblackout: true },
          ],
        },
      },
    ]);
    const status = await get(`/sheets/${sheets.june8}/status?asOf=2026-06-30`, SECONDARY);
    expect([status.statusCode, status.json()]).toEqual([
      200,
      {
        apiversion: 'v1',
        method: 'timesheets.sheets.status',
        data: { timesheet_id: sheets.june8, status: 'APPROVED', overdue: false, day_count: 1, blackout_count: 0, approved_count: 1 },
      },
    ]);
  });

  it.each<[string, () => Promise<Injected>, number, string, string]>([
    ['program: a site without a program', () => get('/sheets', EMPLOYEE, TENANT_UMBRELLA.siteId), 400, 'timesheets.sheets', 'Invalid parameters'],
    ['existence: an unknown sheet', () => get(`/sheets/${MISSING_ID}`), 404, 'timesheets.sheets', 'Not Found'],
    ['existence: a sheet of another site in the tenant', () => get(`/sheets/${sheets.foreign}`), 404, 'timesheets.sheets', 'Not Found'],
    ['existence: a sheet of another tenant', () => get(`/sheets/${sheets.june1}/status`, PRIMARY, TENANT_B.siteId), 404, 'timesheets.sheets.status', 'Not Found'],
    ['existence before validation', () => get(`/sheets/${MISSING_ID}/status?asOf=2026-02-30`), 404, 'timesheets.sheets.status', 'Not Found'],
    ['validation: a non-calendar asOf', () => get(`/sheets/${sheets.june1}/status?asOf=2026-02-30`), 400, 'timesheets.sheets.status', 'Invalid parameters'],
    ['validation: an asOf before 1753', () => get('/sheets?asOf=1752-12-31'), 400, 'timesheets.sheets', 'Invalid parameters'],
    ['validation: an empty asOf', () => get(`/sheets/${sheets.june1}?asOf=`), 400, 'timesheets.sheets', 'Invalid parameters'],
    ['validation: a zero page index', () => get('/sheets?pageIndex=0'), 400, 'timesheets.sheets', 'Invalid parameters'],
    ['validation: a page size over 1000', () => get('/sheets?itemsPerPage=1001'), 400, 'timesheets.sheets', 'Invalid parameters'],
    ['validation: a decimal page size', () => get('/sheets?itemsPerPage=1.5'), 400, 'timesheets.sheets', 'Invalid parameters'],
    ['validation: non-ASCII digits outside the bounds', () => get('/sheets?itemsPerPage=%D9%A1'), 400, 'timesheets.sheets', 'Invalid parameters'],
    ['validation: non-ASCII digits inside the bounds', () => get('/sheets?pageIndex=1%D9%A1'), 500, 'timesheets.sheets', 'Unhandled Exception'],
  ])('fails a read on %s alone', async (_case, send, status, method, message) => {
    const res = await send();
    expect([res.statusCode, res.body]).toEqual([status, errorBody(method, status === 500 ? 'server_error' : 'invalid_request', message)]);
  });

  it('logs an unhandled exception once, as a serialized error record without its message', async () => {
    const before = logLines.length;
    errorSpies.length = 0;
    expect((await get('/sheets?pageIndex=1%D9%A1')).statusCode).toBe(500);
    const record = { type: 'Error', message: REDACTED, stack: expect.stringMatching(/^Error: \[REDACTED\]\n\s+at \S/) };
    const calls = errorSpies.flatMap((spy) => spy.mock.calls).filter((call) => call[1] === 'unhandled fixture exception');
    expect(calls).toStrictEqual([[{ error: record }, 'unhandled fixture exception']]);
    const lines = logLines.slice(before).filter((line) => line.includes('unhandled fixture exception'));
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as { error?: unknown }).error).toStrictEqual(record);
    expect(lines[0]).not.toContain('non-ASCII digits');
  });

  it.each<[string, readonly string[], string, string]>([
    ['submit', EMPLOYEE, 'DRAFT', 'SUBMITTED'],
    ['primary-approve', PRIMARY, 'SUBMITTED', 'PRIMARY_APPROVED'],
    ['secondary-approve', SECONDARY, 'PRIMARY_APPROVED', 'APPROVED'],
    ['return', PRIMARY, 'RESUBMITTED', 'RETURNED'],
    ['return', SECONDARY, 'PRIMARY_APPROVED', 'RETURNED'],
    ['resubmit', EMPLOYEE, 'RETURNED', 'RESUBMITTED'],
  ])('applies %s as %j from %s and answers the re-read day', async (action, roles, from, to) => {
    const dayId = await seedTenantBDay(from);
    const res = await act(dayId.toLowerCase(), action.toUpperCase(), roles, { comment: 'checked' });
    expect([res.statusCode, res.json()]).toEqual([
      200,
      {
        apiversion: 'v1',
        method: `timesheets.days.${action}`,
        data: { day_id: dayId, timesheet_id: expect.any(String), work_date: '2026-06-15T00:00:00', hours: '7.5000', state: to, isblackout: false },
      },
    ]);
    expect(res.headers['x-opt2-write-position']).toMatch(/^timesheets=\d+$/);
    expect(consumed.map(({ token, context }) => [token, context])).toEqual([[GOOD_TOKEN, dayId.toLowerCase()]]);
    const stored = await storedDay(dayId);
    expect(stored.state).toBe(to);
    expect(stored.actions.map(({ action: done, from_state, to_state, comment, actor_user_id }) => [done, from_state, to_state, comment, actor_user_id])).toEqual([
      [action, from, to, 'checked', USER_ID],
    ]);
  });

  it('stores an absent comment as NULL', async () => {
    const dayId = await seedTenantBDay('DRAFT');
    expect((await act(dayId, 'submit', EMPLOYEE)).statusCode).toBe(200);
    expect((await storedDay(dayId)).actions.map(({ comment }) => comment)).toEqual([null]);
  });

  it.each<[unknown, string]>([
    [true, 'YES'],
    [false, 'NO'],
    [15, '15'],
  ])('stores a JSON %j comment as CFML toString text %s', async (comment, text) => {
    const dayId = await seedTenantBDay('DRAFT');
    expect((await act(dayId, 'submit', EMPLOYEE, { comment })).statusCode).toBe(200);
    expect((await storedDay(dayId)).actions.map((action) => action.comment)).toEqual([text]);
  });

  it.each<[string, (dayId: string) => Promise<Injected>, number, string, string]>([
    ['path: an unknown action', (id) => act(id, 'approve', EMPLOYEE), 404, 'timesheets.days.approve', 'Not Found'],
    ['csrf: a write without a token', (id) => act(id, 'submit', EMPLOYEE, undefined, false), 400, 'timesheets.days.submit', 'Invalid CSRF tokens'],
    ['csrf: a GET overridden to POST without a token', async (id) => {
      const headers = { ...(await headersFor(EMPLOYEE, TENANT_B.siteId)), 'x-http-method-override': 'POST' };
      return app.inject({ method: 'GET', url: `${P}/days/${id}/submit`, headers });
    }, 400, 'timesheets.days.submit', 'Invalid CSRF tokens'],
    ['program: a site without a program', async (id) => {
      const headers = { ...(await headersFor(EMPLOYEE, TENANT_UMBRELLA.siteId)), ...CSRF };
      return app.inject({ method: 'POST', url: `${P}/days/${id}/submit`, headers });
    }, 400, 'timesheets.days.submit', 'Invalid parameters'],
    ['existence: an unknown day', () => act(MISSING_ID, 'submit', EMPLOYEE, { comment: ['not', 'simple'] }), 404, 'timesheets.days.submit', 'Not Found'],
    ['validation: a comment that is not simple', (id) => act(id, 'submit', EMPLOYEE, { comment: { text: 'x' } }), 400, 'timesheets.days.submit', 'Invalid parameters'],
    ['storage: a comment PostgreSQL cannot store', (id) => act(id, 'submit', EMPLOYEE, { comment: 'checked\u0000' }), 400, 'timesheets.days.submit', 'Invalid parameters'],
    ['state: an illegal transition', (id) => act(id, 'resubmit', EMPLOYEE), 409, 'timesheets.days.resubmit', 'illegalTransition'],
    ['state: a role that may not take the action', (id) => act(id, 'submit', PRIMARY), 403, 'timesheets.days.submit', 'Insufficient Account Permissions'],
  ])('fails a day action on %s alone, leaving the day unchanged', async (_case, send, status, method, message) => {
    const dayId = await seedTenantBDay('DRAFT');
    const res = await send(dayId);
    expect([res.statusCode, res.body]).toEqual([status, errorBody(method, 'invalid_request', message)]);
    expect(await storedDay(dayId)).toEqual({ state: 'DRAFT', actions: [] });
  });

  it.each<[string, (dayId: string) => Promise<Injected>, number, string | null]>([
    ['a comment PostgreSQL cannot store', (id) => act(id, 'submit', EMPLOYEE, { comment: 'nul-probe\u0000comment' }), 400, 'request rejected: 22021'],
    ['a NUL sheet id PostgreSQL cannot look up', () => get('/sheets/nul-probe%00'), 400, 'request rejected: 22021'],
    ['no credential', () => app.inject({ url: `${P}/sheets` }), 401, 'request denied: missing-credential'],
    [
      'no credential on a NUL comment',
      (id) => app.inject({ method: 'POST', url: `${P}/days/${id}/submit`, headers: CSRF, payload: { comment: 'nul-probe\u0000comment' } }),
      401,
      'request denied: missing-credential',
    ],
    ['a role-less user of an unregistered site', () => get('/sheets', [Roles.member], 'retired-site'), 400, 'request rejected: invalidParameters'],
    ['a write without a CSRF token', (id) => act(id, 'submit', EMPLOYEE, undefined, false), 400, 'request rejected: invalidTokens'],
    ['a comment that is not simple', (id) => act(id, 'submit', EMPLOYEE, { comment: { text: 'x' } }), 400, 'request rejected: invalidParameters'],
    ['a role that may not take the action', (id) => act(id, 'submit', PRIMARY), 403, 'request denied: forbidden'],
    ['an unknown day', () => act(MISSING_ID, 'submit', EMPLOYEE), 404, null],
    ['an unhandled exception', () => get('/sheets?pageIndex=1%D9%A1'), 500, null],
  ])('logs %s with its fixed reason, if any, ahead of the completion line, leaving the day unchanged', async (_case, send, status, warning) => {
    const dayId = await seedTenantBDay('DRAFT');
    const before = logLines.length;
    const res = await send(dayId);
    const lines = logLines.slice(before).map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(res.statusCode).toBe(status);
    expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
      ...(warning === null ? [] : [['WARNING', warning]]),
      ['INFO', 'request completed'],
    ]);
    expect(lines.filter(({ severity }) => severity === 'ERROR')).toHaveLength(status === 500 ? 1 : 0);
    for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
    expect(`${JSON.stringify(lines)}${res.body}`).not.toMatch(/nul-probe|invalid byte sequence|0x00/);
    expect(await storedDay(dayId)).toEqual({ state: 'DRAFT', actions: [] });
  });

  it('consumes no token for an unknown action, and answers notFound for a day of another site in the tenant', async () => {
    const dayId = await seedTenantBDay('DRAFT');
    expect((await act(dayId, 'archive', EMPLOYEE)).statusCode).toBe(404);
    expect(consumed).toEqual([]);
    const foreign = await seedTenantBDay('DRAFT', { siteid: 'tenant-a' });
    expect((await act(foreign, 'submit', EMPLOYEE)).body).toBe(errorBody('timesheets.days.submit', 'invalid_request', 'Not Found'));
  });

  it.each<[string, 'GET' | 'POST', string | undefined]>([
    ['/sheets', 'POST', 'GET'],
    ['/sheets', 'POST', 'get'],
    ['/sheets', 'GET', ''],
    [`/sheets/${sheets.june1}?asOf=2026-06-30`, 'POST', 'GET'],
    [`/sheets/${sheets.june8}/status?asOf=2026-06-30`, 'POST', 'Get'],
  ])('answers %s by %s with X-HTTP-Method-Override %j as its GET', async (url, method, override) => {
    const plain = await get(url);
    const res = await overridden(method, url, override);
    expect([res.statusCode, res.body, res.headers.etag]).toEqual([200, plain.body, plain.headers.etag]);
  });

  it.each<[string, 'GET' | 'POST', string | undefined, string]>([
    ['/sheets', 'GET', 'DELETE', 'timesheets.sheets'],
    ['/sheets', 'GET', 'put', 'timesheets.sheets'],
    ['/sheets', 'POST', undefined, 'timesheets.sheets'],
    [`/sheets/${sheets.june1}`, 'POST', '', 'timesheets.sheets'],
    [`/sheets/${sheets.june1}/status`, 'GET', 'HEAD', 'timesheets.sheets.status'],
  ])('answers %s by %s with X-HTTP-Method-Override %j notFound', async (url, method, override, envelopeMethod) => {
    const res = await overridden(method, url, override);
    expect([res.statusCode, res.body]).toEqual([404, errorBody(envelopeMethod, 'invalid_request', 'Not Found')]);
  });

  it.each<['GET' | 'POST', string | undefined]>([
    ['POST', 'GET'],
    ['POST', 'get'],
    ['POST', 'DELETE'],
    ['GET', undefined],
    ['GET', ''],
    ['GET', 'PUT'],
  ])('answers a day action by %s with X-HTTP-Method-Override %j notFound, writing nothing and consuming no token', async (method, override) => {
    const dayId = await seedTenantBDay('DRAFT');
    const res = await overridden(method, `/days/${dayId}/submit`, override, { roles: EMPLOYEE, site: TENANT_B.siteId });
    expect([res.statusCode, res.body]).toEqual([404, errorBody('timesheets.days.submit', 'invalid_request', 'Not Found')]);
    expect(await storedDay(dayId)).toEqual({ state: 'DRAFT', actions: [] });
    expect(consumed).toEqual([]);
  });

  it.each<['GET' | 'POST', string | undefined]>([
    ['GET', 'POST'],
    ['GET', 'post'],
    ['POST', ''],
  ])('applies a day action by %s with X-HTTP-Method-Override %j, consuming its token', async (method, override) => {
    const dayId = await seedTenantBDay('DRAFT');
    const res = await overridden(method, `/days/${dayId}/submit?comment=checked`, override, { roles: EMPLOYEE, site: TENANT_B.siteId });
    expect([res.statusCode, res.json().data.state]).toEqual([200, 'SUBMITTED']);
    expect(res.headers['x-opt2-write-position']).toMatch(/^timesheets=\d+$/);
    expect(consumed.map(({ token, context }) => [token, context])).toEqual([[GOOD_TOKEN, dayId]]);
    const stored = await storedDay(dayId);
    expect([stored.state, stored.actions.map(({ action, comment }) => [action, comment])]).toEqual(['SUBMITTED', [['submit', 'checked']]]);
  });

  it('rejects any action on a blackout day with 409 blackout', async () => {
    const dayId = await seedTenantBDay('DRAFT', { blackedOut: true });
    const res = await act(dayId, 'submit', EMPLOYEE);
    expect([res.statusCode, res.body]).toEqual([409, errorBody('timesheets.days.submit', 'invalid_request', 'blackout')]);
    expect((await storedDay(dayId)).state).toBe('DRAFT');
  });

  it('fails a write closed with the legacy 503 while the timesheets units are legacy-authoritative', async () => {
    const dayId = await seedTenantBDay('DRAFT');
    await setGates('legacy');
    const res = await act(dayId, 'submit', EMPLOYEE);
    expect(res.statusCode).toBe(503);
    expect(res.json().method).not.toBe('timesheets.days.submit');
    await setGates('open');
    expect((await storedDay(dayId)).state).toBe('DRAFT');
  });
});
