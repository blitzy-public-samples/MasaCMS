// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `/v1/timesheets` routes through `app.inject` against a throwaway `timesheets` schema and an identity CSRF double, each answer checked against contracts/openapi.yaml. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  createService,
  fixedClock,
  loadEnv,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
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
import type { TimesheetAction, TimesheetState } from '../../src/domain/lifecycle.transitions.js';
import type { components } from '../../src/generated/openapi.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS, type ApprovalActionRow, type BlackoutRow, type TimesheetDayRow, type TimesheetRow } from '../../src/repo/tables.js';
import { allowedActions, timesheetsV1Plugin } from '../../src/routes/v1.js';
import { recordingDb, statementsOn } from '../helpers/recording-db.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const SHEETS = '/v1/timesheets/sheets';
const DAYS = '/v1/timesheets/days';
const SHEET_STATUS = '/v1/timesheets/sheet-status';
const EMPLOYEE = [Roles.systemUser, Roles.timesheetsEmployee];
const PRIMARY = [Roles.systemUser, Roles.timesheetsPrimaryApprover];
const SECONDARY = [Roles.systemUser, Roles.timesheetsSecondaryApprover];
const EXPORTER = [Roles.systemUser, Roles.reportingExporter];
const USER_ID = '11111111-2222-3333-4444555566667777';
const PERSON = 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000';
const OTHER_PERSON = 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0001';
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const PAGED_SHEETS = 1001;
const SESSION_ID = '0F1E2D3C-4B5A-6978-8796A5B4C3D2E1F0';
const CSRF_EXPIRES = '260630120000123';

type New<R> = Omit<R, 'tenant_id'>;
type Injected = Awaited<ReturnType<FastifyInstance['inject']>>;
type Schemas = components['schemas'];
type ErrorBody = Schemas['LegacyErrorEnvelope'];

/** An injected answer, its body already validated against the contract as `T`; `text` is the body as sent. */
interface Answer<T = ErrorBody> {
  status: number;
  body: T;
  text: string;
  headers: Record<string, unknown>;
}

/** One gateway call: user `roles` on `site` (null sends no user token) and extra roles on the invocation credential. */
interface Call {
  roles?: readonly string[] | null;
  site?: string;
  payload?: Record<string, unknown>;
  invocationRoles?: string[];
  /** CSRF request headers; a POST otherwise sends a fresh pair issued for the day id in its path. */
  csrf?: Readonly<Record<string, string>>;
}

/** The exact v1 error body the route's own error paths send. */
const v1Error = (method: string, code: string, message: string): string =>
  `{"apiversion":"v1","method":"${method}","error":{"code":"${code}","message":"${message}"}}`;

describe('allowedActions', () => {
  const [employee, primary, secondary] = [Roles.timesheetsEmployee, Roles.timesheetsPrimaryApprover, Roles.timesheetsSecondaryApprover];

  it.each<[TimesheetState, readonly string[], boolean, TimesheetAction[]]>([
    ['DRAFT', [employee], false, ['submit']],
    ['DRAFT', [primary, secondary], false, []],
    ['SUBMITTED', [primary], false, ['primary-approve', 'return']],
    ['RESUBMITTED', [primary], false, ['primary-approve', 'return']],
    ['SUBMITTED', [employee, secondary], false, []],
    ['PRIMARY_APPROVED', [secondary], false, ['secondary-approve', 'return']],
    ['PRIMARY_APPROVED', [employee, primary], false, []],
    ['RETURNED', [employee], false, ['resubmit']],
    ['RETURNED', [primary, secondary], false, []],
    ['APPROVED', [employee, primary, secondary], false, []],
    ['SUBMITTED', [employee, primary, secondary], false, ['primary-approve', 'return']],
    ['DRAFT', [employee], true, []],
    ['PRIMARY_APPROVED', [secondary], true, []],
    ['DRAFT', [], false, []],
    ['DRAFT', [Roles.systemUser, Roles.reportingExporter], false, []],
  ])('gives a %s day with roles %j and blackout %s the actions %j', (state, roles, blackout, expected) => {
    expect(allowedActions(state, roles, blackout)).toEqual(expected);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('timesheets /v1 routes', () => {
  let handle: ThrowawaySchema;
  let repository: TimesheetsRepository;
  let app: FastifyInstance;
  const statements: string[] = [];
  const logLines: string[] = [];
  /** The sheet page whose read fails inside its transaction, as a database error would; undefined fails none. */
  let failingSheetPage: number | undefined;
  /** Context identity issued each token for; a token is valid for that context alone. */
  const issued = new Map<string, string>();
  /** `token context` keys identity has consumed in the test session. */
  const consumed = new Set<string>();
  /** Every consume call the routes made, in order. */
  const consumeCalls: CsrfConsumeRequest[] = [];
  let identityStatus = 200;

  /** Identity's consume verdict: valid once per token and context, for the context the token was issued for. */
  function consume(request: ServiceRequest): ServiceResponse {
    if (request.service !== IDENTITY_SERVICE || request.method !== 'POST' || request.path !== CSRF_CONSUME_PATH) {
      throw new Error(`the timesheets /v1 routes call no other service: ${request.method} ${request.service} ${request.path}`);
    }
    const call = request.json as CsrfConsumeRequest;
    consumeCalls.push(call);
    const key = `${call.token} ${call.context}`;
    const valid = identityStatus === 200 && call.sessionId === SESSION_ID && issued.get(call.token) === call.context && !consumed.has(key);
    if (valid) consumed.add(key);
    return { status: identityStatus, headers: {}, body: identityStatus === 200 ? { valid } : undefined };
  }

  /** A fresh CSRF pair identity issued for `context`, as the sheet screen renders one per day form. */
  function issueCsrf(context: string): Record<string, string> {
    const token = `V1ROUTES${String(issued.size + 1).padStart(24, '0')}`;
    issued.set(token, context);
    return { 'x-csrf_token': token, 'x-csrf_token_expires': CSRF_EXPIRES };
  }

  /** Seeded tenant-a sheets in period order; `returned` belongs to another site of the same tenant. */
  const sheets = { approved: cfUuid(), submitted: cfUuid(), first: cfUuid(), partial: cfUuid(), returned: cfUuid(), empty: cfUuid() };
  const days = {
    approvedOnly: cfUuid(),
    approvedBlackout: cfUuid(),
    submittedOnly: cfUuid(),
    resubmitted: cfUuid(),
    draft: cfUuid(),
    submitted: cfUuid(),
    blackedOut: cfUuid(),
    approved: cfUuid(),
    primaryApproved: cfUuid(),
    returned: cfUuid(),
  };
  /** Umbrella sheets, one more than a sheet-status page holds, in period order. */
  const paged = Array.from({ length: PAGED_SHEETS }, () => cfUuid());
  /** One day on the first umbrella sheet, blacked out, and one on the last, so each sheet-status page reads days and blackouts. */
  const pagedDays = { first: cfUuid(), last: cfUuid() };
  /** The status rows of `paged` as of today. */
  const pagedRows = paged.map((timesheetId, index) => {
    const start = new Date(2024, 0, 1 + index);
    const row = {
      timesheetId,
      siteId: TENANT_UMBRELLA.siteId,
      personId: PERSON,
      periodStart: `${String(start.getFullYear())}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}T00:00:00`,
      status: 'DRAFT',
      overdue: false,
      dayCount: 0,
      blackoutCount: 0,
      approvedCount: 0,
    };
    if (index === 0) return { ...row, dayCount: 1, blackoutCount: 1 };
    return index === PAGED_SHEETS - 1 ? { ...row, status: 'SUBMITTED', dayCount: 1 } : row;
  });

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
      verifierOverride: testVerifier('timesheets'),
      pool: handle.app,
      logger: createLogger({ service: 'timesheets', version: '1.0.0', env: 'local', destination: { write: (line: string) => void logLines.push(line) } }),
    });
    registerWritePositionHeader(app);
    repository = createTimesheetsRepository({ clock: CLOCK, schema: handle.schema });
    const routeRepository: TimesheetsRepository = {
      ...repository,
      async listSheets(tx, filter) {
        if (filter.pageIndex === failingSheetPage) await tx.query('SELECT 1 / 0');
        return repository.listSheets(tx, filter);
      },
    };
    await app.register(timesheetsV1Plugin, { db: recordingDb(handle.app, statements), repository: routeRepository, clock: CLOCK });
    await app.ready();
    vi.spyOn(app.opt2.client, 'request').mockImplementation((request: ServiceRequest) => Promise.resolve(consume(request)));
    await setGates('open');

    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await repository.insert(tx, 'timesheet', sheet(sheets.approved, new Date(2026, 4, 18), new Date(2026, 4, 27)));
      await repository.insert(tx, 'timesheet', sheet(sheets.submitted, new Date(2026, 4, 25), new Date(2026, 5, 3)));
      await repository.insert(tx, 'timesheet', sheet(sheets.first, new Date(2026, 5, 1), new Date(2026, 5, 10)));
      await repository.insert(tx, 'timesheet', {
        ...sheet(sheets.partial, new Date(2026, 5, 8), new Date(2026, 5, 17)),
        lastupdate: new Date(2026, 5, 9, 17, 45, 30),
        lastupdatebyid: USER_ID,
      });
      await repository.insert(tx, 'timesheet', {
        ...sheet(sheets.returned, new Date(2026, 5, 15), new Date(2026, 5, 24)),
        siteid: 'tenant-b',
        person_id: OTHER_PERSON,
      });
      await repository.insert(tx, 'timesheet', sheet(sheets.empty, new Date(2026, 5, 22), new Date(2026, 6, 1)));
      await repository.insert(tx, 'timesheet_day', day(days.approvedOnly, sheets.approved, new Date(2026, 4, 18), 'APPROVED'));
      await repository.insert(tx, 'timesheet_day', day(days.approvedBlackout, sheets.approved, new Date(2026, 4, 19), 'DRAFT'));
      await repository.insert(tx, 'timesheet_day', day(days.submittedOnly, sheets.submitted, new Date(2026, 4, 25), 'SUBMITTED'));
      await repository.insert(tx, 'timesheet_day', day(days.resubmitted, sheets.submitted, new Date(2026, 4, 26), 'RESUBMITTED'));
      await repository.insert(tx, 'timesheet_day', day(days.draft, sheets.first, new Date(2026, 5, 1), 'DRAFT'));
      await repository.insert(tx, 'timesheet_day', {
        ...day(days.submitted, sheets.first, new Date(2026, 5, 2), 'SUBMITTED'),
        hours: '8.2500',
        lastupdate: new Date(2026, 5, 2, 16, 30, 0),
        lastupdatebyid: USER_ID,
      });
      await repository.insert(tx, 'timesheet_day', day(days.blackedOut, sheets.first, new Date(2026, 5, 3), 'DRAFT'));
      await repository.insert(tx, 'timesheet_day', day(days.approved, sheets.partial, new Date(2026, 5, 8), 'APPROVED'));
      await repository.insert(tx, 'timesheet_day', day(days.primaryApproved, sheets.partial, new Date(2026, 5, 9), 'PRIMARY_APPROVED'));
      await repository.insert(tx, 'timesheet_day', day(days.returned, sheets.returned, new Date(2026, 5, 15), 'RETURNED'));
      await repository.insert(tx, 'blackout', blackout(days.blackedOut));
      await repository.insert(tx, 'blackout', blackout(days.approvedBlackout));
    });
    await handle.app.withTenant(TENANT_UMBRELLA.tenantId, async (tx) => {
      await repository.insertAbsent(
        tx,
        'timesheet',
        paged.map((id, index) => ({ ...sheet(id, new Date(2024, 0, 1 + index), new Date(2024, 0, 10 + index), 3), siteid: TENANT_UMBRELLA.siteId })),
        ['timesheet_id'],
      );
      await repository.insert(tx, 'timesheet_day', day(pagedDays.first, paged[0] as string, new Date(2024, 0, 1), 'DRAFT', 3));
      await repository.insert(tx, 'timesheet_day', day(pagedDays.last, paged[PAGED_SHEETS - 1] as string, new Date(2026, 8, 27), 'SUBMITTED', 3));
      await repository.insert(tx, 'blackout', blackout(pagedDays.first, 3));
    });
  });

  afterAll(async () => {
    await app?.opt2.shutdown();
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    consumeCalls.length = 0;
    identityStatus = 200;
  });

  /** Moves every timesheets gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'v1-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'v1-routes-test', state });
  }

  function sheet(id: string, periodStart: Date, dueDate: Date, programId = 1): New<TimesheetRow> {
    return {
      timesheet_id: id,
      person_id: PERSON,
      siteid: programId === 1 ? 'tenant-a' : 'tenant-b',
      period_start: periodStart,
      period_end: new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate() + 6),
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

  function blackout(dayId: string, programId = 1): New<BlackoutRow> {
    return { blackout_id: cfUuid(), day_id: dayId, person_id: PERSON, archive_id: null, reason: 'person-archived', created: NOW, legacy_program_id: programId };
  }

  /** A fresh tenant-b sheet holding one day in `state`, blacked out when `blackedOut`; returns the day and sheet ids. */
  async function seedTenantBDay(state: string, blackedOut = false): Promise<{ dayId: string; sheetId: string }> {
    const [sheetId, dayId] = [cfUuid(), cfUuid()];
    await handle.app.withTenant(TENANT_B.tenantId, async (tx) => {
      await repository.insert(tx, 'timesheet', sheet(sheetId, new Date(2026, 5, 15), new Date(2026, 5, 24), 2));
      await repository.insert(tx, 'timesheet_day', day(dayId, sheetId, new Date(2026, 5, 15), state, 2));
      if (blackedOut) await repository.insert(tx, 'blackout', blackout(dayId, 2));
    });
    return { dayId, sheetId };
  }

  /** The tenant-b day's stored row and its approval actions. */
  function storedDay(dayId: string): Promise<{ day: TimesheetDayRow | undefined; actions: ApprovalActionRow[] }> {
    return handle.app.withTenant(TENANT_B.tenantId, async (tx) => ({
      day: (await tx.query<TimesheetDayRow>(`SELECT * FROM ${handle.schema}.timesheet_day WHERE day_id = $1`, [dayId])).rows[0],
      actions: (await tx.query<ApprovalActionRow>(`SELECT * FROM ${handle.schema}.approval_action WHERE day_id = $1`, [dayId])).rows,
    }));
  }

  /** Validates an injected response against the contract operation of `method` and `url`. */
  function checked<T = ErrorBody>(method: 'GET' | 'POST', url: string, res: Injected): Answer<T> {
    assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return { status: res.statusCode, body: res.json<T>(), text: res.body, headers: res.headers };
  }

  /** Injects one gateway call with a user token and the gateway's invocation credential, checked against the contract. */
  async function call<T = ErrorBody>(method: 'GET' | 'POST', url: string, request: Call = {}): Promise<Answer<T>> {
    const { roles = PRIMARY, site = TENANT_A.siteId, payload, invocationRoles } = request;
    const invocation = await mintServiceToken({ caller: 'gateway', audience: 'timesheets', ...(invocationRoles === undefined ? {} : { roles: invocationRoles }) });
    const csrf = request.csrf ?? (method === 'POST' ? issueCsrf(new URL(url, 'http://timesheets.test').pathname.split('/')[4] ?? '') : {});
    const headers: Record<string, string> = { [INVOCATION_HEADER]: `Bearer ${invocation}`, ...csrf };
    if (roles !== null) headers.authorization = `Bearer ${await mintUserToken({ sub: USER_ID, site, roles, sid: SESSION_ID })}`;
    return checked<T>(method, url, await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) }));
  }

  /** A day action as `roles` on tenant-b, with `csrf` instead of a fresh pair for the day when given. */
  function act<T = ErrorBody>(
    dayId: string,
    action: string,
    roles: readonly string[],
    payload?: Record<string, unknown>,
    csrf?: Readonly<Record<string, string>>,
  ): Promise<Answer<T>> {
    return call<T>('POST', `${DAYS}/${dayId}/${action}`, { roles, site: TENANT_B.siteId, payload, ...(csrf === undefined ? {} : { csrf }) });
  }

  const timesheet = {
    approved: {
      timesheetId: sheets.approved,
      siteId: 'tenant-a',
      personId: PERSON,
      periodStart: '2026-05-18T00:00:00',
      periodEnd: '2026-05-24T00:00:00',
      dueDate: '2026-05-27T00:00:00',
      created: '2026-05-31T09:00:00',
      lastUpdate: null,
      lastUpdateById: null,
      status: 'APPROVED',
      overdue: false,
    },
    submitted: {
      timesheetId: sheets.submitted,
      siteId: 'tenant-a',
      personId: PERSON,
      periodStart: '2026-05-25T00:00:00',
      periodEnd: '2026-05-31T00:00:00',
      dueDate: '2026-06-03T00:00:00',
      created: '2026-05-31T09:00:00',
      lastUpdate: null,
      lastUpdateById: null,
      status: 'SUBMITTED',
      overdue: false,
    },
    first: {
      timesheetId: sheets.first,
      siteId: 'tenant-a',
      personId: PERSON,
      periodStart: '2026-06-01T00:00:00',
      periodEnd: '2026-06-07T00:00:00',
      dueDate: '2026-06-10T00:00:00',
      created: '2026-05-31T09:00:00',
      lastUpdate: null,
      lastUpdateById: null,
      status: 'DRAFT',
      overdue: true,
    },
    partial: {
      timesheetId: sheets.partial,
      siteId: 'tenant-a',
      personId: PERSON,
      periodStart: '2026-06-08T00:00:00',
      periodEnd: '2026-06-14T00:00:00',
      dueDate: '2026-06-17T00:00:00',
      created: '2026-05-31T09:00:00',
      lastUpdate: '2026-06-09T17:45:30',
      lastUpdateById: USER_ID,
      status: 'PARTIALLY_APPROVED',
      overdue: false,
    },
    returned: {
      timesheetId: sheets.returned,
      siteId: 'tenant-b',
      personId: OTHER_PERSON,
      periodStart: '2026-06-15T00:00:00',
      periodEnd: '2026-06-21T00:00:00',
      dueDate: '2026-06-24T00:00:00',
      created: '2026-05-31T09:00:00',
      lastUpdate: null,
      lastUpdateById: null,
      status: 'RETURNED',
      overdue: false,
    },
    empty: {
      timesheetId: sheets.empty,
      siteId: 'tenant-a',
      personId: PERSON,
      periodStart: '2026-06-22T00:00:00',
      periodEnd: '2026-06-28T00:00:00',
      dueDate: '2026-07-01T00:00:00',
      created: '2026-05-31T09:00:00',
      lastUpdate: null,
      lastUpdateById: null,
      status: 'DRAFT',
      overdue: false,
    },
  };

  const statusRow = {
    approved: { timesheetId: sheets.approved, siteId: 'tenant-a', personId: PERSON, periodStart: '2026-05-18T00:00:00', status: 'APPROVED', overdue: false, dayCount: 2, blackoutCount: 1, approvedCount: 1 },
    submitted: { timesheetId: sheets.submitted, siteId: 'tenant-a', personId: PERSON, periodStart: '2026-05-25T00:00:00', status: 'SUBMITTED', overdue: false, dayCount: 2, blackoutCount: 0, approvedCount: 0 },
    first: { timesheetId: sheets.first, siteId: 'tenant-a', personId: PERSON, periodStart: '2026-06-01T00:00:00', status: 'DRAFT', overdue: true, dayCount: 3, blackoutCount: 1, approvedCount: 0 },
    partial: { timesheetId: sheets.partial, siteId: 'tenant-a', personId: PERSON, periodStart: '2026-06-08T00:00:00', status: 'PARTIALLY_APPROVED', overdue: false, dayCount: 2, blackoutCount: 0, approvedCount: 1 },
    returned: { timesheetId: sheets.returned, siteId: 'tenant-b', personId: OTHER_PERSON, periodStart: '2026-06-15T00:00:00', status: 'RETURNED', overdue: false, dayCount: 1, blackoutCount: 0, approvedCount: 0 },
    empty: { timesheetId: sheets.empty, siteId: 'tenant-a', personId: PERSON, periodStart: '2026-06-22T00:00:00', status: 'DRAFT', overdue: false, dayCount: 0, blackoutCount: 0, approvedCount: 0 },
  };

  it('declares exactly the contract /v1 operations with their requires and transport', () => {
    const routes = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/v1/'));
    expect(routes.map((route) => `${route.method} ${route.url}`)).toEqual([
      `POST ${DAYS}/:id/:action`,
      `GET ${SHEET_STATUS}`,
      `GET ${SHEETS}`,
      `GET ${SHEETS}/:id`,
    ]);
    for (const route of routes) {
      const operation = OPENAPI.paths[route.url.replace(/:(\w+)/g, '{$1}')]?.[route.method.toLowerCase()];
      expect([route.transport, route.requires]).toEqual([operation?.['x-opt2-transport'], operation?.['x-opt2-requires']]);
    }
  });

  describe('listSheets', () => {
    it('lists every sheet of the tenant in period order with status and overdue as of today, and the count of all', async () => {
      const res = await call('GET', SHEETS, { roles: EMPLOYEE });
      expect([res.status, res.body]).toEqual([
        200,
        { items: [timesheet.approved, timesheet.submitted, timesheet.first, timesheet.partial, timesheet.returned, timesheet.empty], total: 6 },
      ]);
    });

    it.each<[string, string, boolean]>([
      ['on its due date', '2026-06-10', false],
      ['the day after its due date', '2026-06-11', true],
      ['before its period', '2026-05-01', false],
    ])('flags the drafted sheet overdue %s only when asOf follows the due date', async (_case, asOf, overdue) => {
      const res = await call<Schemas['TimesheetList']>('GET', `${SHEETS}?asOf=${asOf}`, { roles: SECONDARY });
      expect(res.body.items).toEqual([timesheet.approved, timesheet.submitted, { ...timesheet.first, overdue }, timesheet.partial, timesheet.returned, timesheet.empty]);
    });

    it.each<[string, string, string[], number]>([
      ['a middle page', '?pageIndex=2&itemsPerPage=2', [sheets.first, sheets.partial], 6],
      ['a one-item page', '?pageIndex=2&itemsPerPage=1', [sheets.submitted], 6],
      ['the last page', '?pageIndex=3&itemsPerPage=2', [sheets.returned, sheets.empty], 6],
      ['a page past the end', '?pageIndex=4&itemsPerPage=2', [], 6],
      ['the largest page index', `?pageIndex=${Number.MAX_SAFE_INTEGER}`, [], 6],
    ])('pages: %s', async (_case, query, ids, total) => {
      const res = await call<Schemas['TimesheetList']>('GET', `${SHEETS}${query}`);
      expect([res.status, res.body.items.map((item) => item.timesheetId), res.body.total]).toEqual([200, ids, total]);
    });

    it('pages a tenant holding more sheets than the largest page', async () => {
      const res = await call<Schemas['TimesheetList']>('GET', `${SHEETS}?pageIndex=2&itemsPerPage=1000`, { site: TENANT_UMBRELLA.siteId });
      expect([res.status, res.body.items.map((item) => item.timesheetId), res.body.total]).toEqual([200, [paged[1000]], PAGED_SHEETS]);
    });

    it.each([
      'asOf=2026-02-30',
      'asOf=1752-12-31',
      'asOf=',
      'asOf=2026-6-30',
      'asOf=2026-06-30T00:00:00',
      'asOf=2026-06-01&asOf=2026-06-02',
      'pageIndex=0',
      'pageIndex=x',
      `pageIndex=${Number.MAX_SAFE_INTEGER + 1}`,
      'itemsPerPage=0',
      'itemsPerPage=1001',
      'itemsPerPage=1.5',
    ])('refuses the query %s as invalidParameters', async (query) => {
      const res = await call('GET', `${SHEETS}?${query}`);
      expect([res.status, JSON.stringify(res.body)]).toEqual([400, v1Error('timesheets.sheets', 'invalid_request', 'Invalid parameters')]);
    });
  });

  describe('getSheet', () => {
    it('reads a sheet with its days in work date order, matching the id ignoring case', async () => {
      const res = await call('GET', `${SHEETS}/${sheets.first.toLowerCase()}`);
      expect([res.status, res.body]).toEqual([
        200,
        {
          ...timesheet.first,
          days: [
            {
              dayId: days.draft,
              timesheetId: sheets.first,
              workDate: '2026-06-01T00:00:00',
              hours: '7.5000',
              state: 'DRAFT',
              blackout: false,
              lastUpdate: null,
              lastUpdateById: null,
              allowedActions: [],
            },
            {
              dayId: days.submitted,
              timesheetId: sheets.first,
              workDate: '2026-06-02T00:00:00',
              hours: '8.2500',
              state: 'SUBMITTED',
              blackout: false,
              lastUpdate: '2026-06-02T16:30:00',
              lastUpdateById: USER_ID,
              allowedActions: ['primary-approve', 'return'],
            },
            {
              dayId: days.blackedOut,
              timesheetId: sheets.first,
              workDate: '2026-06-03T00:00:00',
              hours: '7.5000',
              state: 'DRAFT',
              blackout: true,
              lastUpdate: null,
              lastUpdateById: null,
              allowedActions: [],
            },
          ],
        },
      ]);
    });

    it.each<[string, readonly string[], string, Array<[string, TimesheetAction[]]>]>([
      ['the employee', EMPLOYEE, sheets.first, [[days.draft, ['submit']], [days.submitted, []], [days.blackedOut, []]]],
      ['the secondary approver', SECONDARY, sheets.partial, [[days.approved, []], [days.primaryApproved, ['secondary-approve', 'return']]]],
      ['the primary approver', PRIMARY, sheets.partial, [[days.approved, []], [days.primaryApproved, []]]],
      ['the employee', EMPLOYEE, sheets.returned, [[days.returned, ['resubmit']]]],
      ['the primary approver', PRIMARY, sheets.submitted, [[days.submittedOnly, ['primary-approve', 'return']], [days.resubmitted, ['primary-approve', 'return']]]],
      ['the employee', EMPLOYEE, sheets.approved, [[days.approvedOnly, []], [days.approvedBlackout, []]]],
    ])('gives %s the allowed actions of each day', async (_case, roles, sheetId, expected) => {
      const res = await call<Schemas['TimesheetDetail']>('GET', `${SHEETS}/${sheetId}`, { roles });
      expect(res.body.days.map(({ dayId, allowedActions: actions }) => [dayId, actions])).toEqual(expected);
    });

    it('derives the status fields as of asOf and reads a sheet without days', async () => {
      expect((await call<Schemas['TimesheetDetail']>('GET', `${SHEETS}/${sheets.first}?asOf=2026-06-10`)).body).toMatchObject({ status: 'DRAFT', overdue: false });
      expect((await call<Schemas['TimesheetDetail']>('GET', `${SHEETS}/${sheets.empty}`)).body).toEqual({ ...timesheet.empty, days: [] });
    });

    it.each<[string, () => Promise<Answer>, number, string]>([
      ['an unknown sheet', () => call('GET', `${SHEETS}/${MISSING_ID}`), 404, 'Not Found'],
      ['an id that is not a CF UUID', () => call('GET', `${SHEETS}/not-a-sheet`), 404, 'Not Found'],
      ['an id longer than a CF UUID', () => call('GET', `${SHEETS}/${sheets.first}0`), 404, 'Not Found'],
      ['a sheet of another tenant', () => call('GET', `${SHEETS}/${sheets.first}`, { site: TENANT_B.siteId }), 404, 'Not Found'],
      ['a non-calendar asOf, before the lookup', () => call('GET', `${SHEETS}/${MISSING_ID}?asOf=2026-02-30`), 400, 'Invalid parameters'],
    ])('fails on %s', async (_case, send, status, message) => {
      const res = await send();
      expect([res.status, JSON.stringify(res.body)]).toEqual([status, v1Error('timesheets.sheets', 'invalid_request', message)]);
    });
  });

  describe('dayAction', () => {
    it.each<[TimesheetAction, readonly string[], TimesheetState, TimesheetState, string]>([
      ['submit', EMPLOYEE, 'DRAFT', 'SUBMITTED', Roles.timesheetsEmployee],
      ['primary-approve', PRIMARY, 'SUBMITTED', 'PRIMARY_APPROVED', Roles.timesheetsPrimaryApprover],
      ['primary-approve', PRIMARY, 'RESUBMITTED', 'PRIMARY_APPROVED', Roles.timesheetsPrimaryApprover],
      ['secondary-approve', SECONDARY, 'PRIMARY_APPROVED', 'APPROVED', Roles.timesheetsSecondaryApprover],
      ['return', PRIMARY, 'SUBMITTED', 'RETURNED', Roles.timesheetsPrimaryApprover],
      ['return', PRIMARY, 'RESUBMITTED', 'RETURNED', Roles.timesheetsPrimaryApprover],
      ['return', SECONDARY, 'PRIMARY_APPROVED', 'RETURNED', Roles.timesheetsSecondaryApprover],
      ['resubmit', EMPLOYEE, 'RETURNED', 'RESUBMITTED', Roles.timesheetsEmployee],
    ])('applies %s as %j from %s to %s and records the approval action', async (action, roles, from, to, actingRole) => {
      const { dayId, sheetId } = await seedTenantBDay(from);
      const res = await act<Schemas['DayActionResult']>(dayId.toLowerCase(), action, roles, { comment: 'checked' });
      const stored = await storedDay(dayId);
      expect([res.status, res.body]).toEqual([
        200,
        {
          dayId,
          timesheetId: sheetId,
          action,
          fromState: from,
          toState: to,
          actionId: stored.actions[0]?.action_id,
          workDate: '2026-06-15T00:00:00',
          hours: '7.5000',
          blackout: false,
        },
      ]);
      expect(res.headers['x-opt2-write-position']).toMatch(/^timesheets=\d+$/);
      expect([stored.day?.state, stored.day?.lastupdate, stored.day?.lastupdatebyid]).toEqual([to, NOW, USER_ID]);
      expect(stored.actions.map((row) => [row.action, row.role, row.from_state, row.to_state, row.actor_user_id, row.comment, row.created])).toEqual([
        [action, actingRole, from, to, USER_ID, 'checked', NOW],
      ]);
    });

    it.each<[string, Record<string, unknown> | undefined]>([
      ['no body', undefined],
      ['a body without a comment', {}],
      ['an empty comment', { comment: '' }],
    ])('stores the comment of %s as NULL', async (_case, payload) => {
      const { dayId } = await seedTenantBDay('DRAFT');
      expect((await act(dayId, 'submit', EMPLOYEE, payload)).status).toBe(200);
      expect((await storedDay(dayId)).actions.map(({ comment }) => comment)).toEqual([null]);
    });

    it.each<[string, TimesheetState, boolean, (dayId: string) => Promise<Answer>, number, string, string]>([
      ['a role that may not take the action', 'DRAFT', false, (id) => act(id, 'submit', PRIMARY), 403, 'timesheets.days.submit', 'Insufficient Account Permissions'],
      ['an illegal transition', 'DRAFT', false, (id) => act(id, 'resubmit', EMPLOYEE), 409, 'timesheets.days.resubmit', 'illegalTransition'],
      ['a terminal day', 'APPROVED', false, (id) => act(id, 'return', SECONDARY), 409, 'timesheets.days.return', 'illegalTransition'],
      ['a blacked-out day', 'DRAFT', true, (id) => act(id, 'submit', EMPLOYEE), 409, 'timesheets.days.submit', 'blackout'],
      ['a blacked-out day and a role that may not act', 'DRAFT', true, (id) => act(id, 'submit', PRIMARY), 409, 'timesheets.days.submit', 'blackout'],
      ['a blacked-out day the role could otherwise act on', 'PRIMARY_APPROVED', true, (id) => act(id, 'return', SECONDARY), 409, 'timesheets.days.return', 'blackout'],
      ['an action the lifecycle does not name', 'DRAFT', false, (id) => act(id, 'approve', EMPLOYEE), 404, 'timesheets.days.approve', 'Not Found'],
      ['an action not in lower case', 'DRAFT', false, (id) => act(id, 'Submit', EMPLOYEE), 404, 'timesheets.days.submit', 'Not Found'],
      ['a comment that is not a string', 'DRAFT', false, (id) => act(id, 'submit', EMPLOYEE, { comment: 5 }), 400, 'timesheets.days.submit', 'Invalid parameters'],
      ['a null comment', 'DRAFT', false, (id) => act(id, 'submit', EMPLOYEE, { comment: null }), 400, 'timesheets.days.submit', 'Invalid parameters'],
      ['an unknown day', 'DRAFT', false, () => act(MISSING_ID, 'submit', EMPLOYEE), 404, 'timesheets.days.submit', 'Not Found'],
      ['an id that is not a CF UUID', 'DRAFT', false, () => act('not-a-day', 'submit', EMPLOYEE), 404, 'timesheets.days.submit', 'Not Found'],
      ['a day of another tenant', 'DRAFT', false, () => act(days.draft, 'submit', EMPLOYEE), 404, 'timesheets.days.submit', 'Not Found'],
    ])('fails on %s, leaving the day unchanged and reporting no write position', async (_case, state, blackedOut, send, status, method, message) => {
      const { dayId } = await seedTenantBDay(state, blackedOut);
      const res = await send(dayId);
      expect([res.status, JSON.stringify(res.body)]).toEqual([status, v1Error(method, 'invalid_request', message)]);
      expect(res.headers['x-opt2-write-position']).toBeUndefined();
      expect(await storedDay(dayId)).toMatchObject({ day: { state, lastupdate: null }, actions: [] });
    });

    it('fails a write closed with the legacy 503 while the timesheets units are legacy-authoritative', async () => {
      const { dayId } = await seedTenantBDay('DRAFT');
      await setGates('legacy');
      const res = await act(dayId, 'submit', EMPLOYEE);
      await setGates('open');
      expect([res.status, res.body.error]).toEqual([503, { message: 'Unhandled Exception', code: 'server_error' }]);
      expect(res.headers['x-opt2-write-position']).toBeUndefined();
      expect(await storedDay(dayId)).toMatchObject({ day: { state: 'DRAFT' }, actions: [] });
    });

    it("has identity consume the pair for the day id as sent, in the token's session, before the write", async () => {
      const { dayId } = await seedTenantBDay('DRAFT');
      const csrf = issueCsrf(dayId.toLowerCase());

      const res = await act(dayId.toLowerCase(), 'submit', EMPLOYEE, undefined, csrf);

      expect(res.status).toBe(200);
      expect(consumeCalls).toEqual([{ sessionId: SESSION_ID, token: csrf['x-csrf_token'], expires: CSRF_EXPIRES, context: dayId.toLowerCase() }]);
    });

    it.each<[string, () => Record<string, string>, number]>([
      ['no token', () => ({}), 0],
      ['a token without its expiry', () => ({ 'x-csrf_token': issueCsrf('')['x-csrf_token'] ?? '' }), 0],
      ["another day's token", () => issueCsrf(MISSING_ID), 1],
    ])('answers %s with invalidTokens before the comment check, leaving the day unchanged', async (_case, csrf, calls) => {
      const { dayId } = await seedTenantBDay('DRAFT');

      const res = await act(dayId, 'submit', EMPLOYEE, { comment: 5 }, csrf());

      expect([res.status, JSON.stringify(res.body)]).toEqual([400, v1Error('timesheets.days.submit', 'invalid_request', 'Invalid CSRF tokens')]);
      expect(consumeCalls).toHaveLength(calls);
      expect(await storedDay(dayId)).toMatchObject({ day: { state: 'DRAFT', lastupdate: null }, actions: [] });
    });

    it('consumes no token for an action the lifecycle does not name', async () => {
      const { dayId } = await seedTenantBDay('DRAFT');

      expect((await act(dayId, 'approve', EMPLOYEE)).status).toBe(404);
      expect(consumeCalls).toEqual([]);
    });

    it('accepts a token once and answers its replay with invalidTokens', async () => {
      const { dayId } = await seedTenantBDay('DRAFT');
      const csrf = issueCsrf(dayId);

      const first = await act(dayId, 'submit', EMPLOYEE, undefined, csrf);
      const replay = await act(dayId, 'primary-approve', PRIMARY, undefined, csrf);

      expect([first.status, replay.status]).toEqual([200, 400]);
      expect(JSON.stringify(replay.body)).toBe(v1Error('timesheets.days.primary-approve', 'invalid_request', 'Invalid CSRF tokens'));
      expect((await storedDay(dayId)).actions.map(({ action }) => action)).toEqual(['submit']);
    });

    it('answers the legacy 503 and writes nothing when identity cannot consume the token', async () => {
      const { dayId } = await seedTenantBDay('DRAFT');
      identityStatus = 503;

      const res = await act(dayId, 'submit', EMPLOYEE);

      expect(res.status).toBe(503);
      expect(await storedDay(dayId)).toMatchObject({ day: { state: 'DRAFT' }, actions: [] });
    });

    it('consumes no CSRF token on a sheet read, even one sent with it', async () => {
      expect((await call('GET', `${SHEETS}/${sheets.first}`, { csrf: issueCsrf(sheets.first) })).status).toBe(200);
      expect(consumeCalls).toEqual([]);
    });
  });

  describe('listSheetStatus', () => {
    it.each<[string, readonly string[]]>([
      ['the exporter', EXPORTER],
      ['the primary approver', PRIMARY],
      ['the secondary approver', SECONDARY],
    ])('lists the status row of every tenant sheet as of today for %s', async (_case, roles) => {
      const res = await call('GET', SHEET_STATUS, { roles });
      const items = [statusRow.approved, statusRow.submitted, statusRow.first, statusRow.partial, statusRow.returned, statusRow.empty];
      expect([res.status, res.headers['content-type'], res.text]).toEqual([200, 'application/json; charset=utf-8', JSON.stringify({ items })]);
    });

    it('lists every row of a tenant holding more sheets than a page, unpaged and without total', async () => {
      const res = await call('GET', SHEET_STATUS, { roles: EXPORTER, site: TENANT_UMBRELLA.siteId });
      expect([res.status, res.headers['content-type'], res.text]).toEqual([200, 'application/json; charset=utf-8', JSON.stringify({ items: pagedRows })]);
    });

    it.each<[string, boolean]>([
      ['2026-06-10', false],
      ['2026-06-11', true],
    ])('derives overdue as of %s', async (asOf, overdue) => {
      const res = await call<Schemas['SheetStatusList']>('GET', `${SHEET_STATUS}?asOf=${asOf}`, { roles: EXPORTER });
      expect(res.body.items).toEqual([statusRow.approved, statusRow.submitted, { ...statusRow.first, overdue }, statusRow.partial, statusRow.returned, statusRow.empty]);
    });

    it.each<[string, string, string, string[], number]>([
      ['a middle page', '?pageIndex=2&itemsPerPage=2', TENANT_A.siteId, [sheets.first, sheets.partial], 6],
      ['the last page', '?pageIndex=3&itemsPerPage=2', TENANT_A.siteId, [sheets.returned, sheets.empty], 6],
      ['a page past the end', '?pageIndex=4&itemsPerPage=2', TENANT_A.siteId, [], 6],
      ['the largest page index', `?pageIndex=${Number.MAX_SAFE_INTEGER}`, TENANT_A.siteId, [], 6],
      ['the first page when only itemsPerPage is given', '?itemsPerPage=2', TENANT_A.siteId, [sheets.approved, sheets.submitted], 6],
      ['the first full page of a tenant holding more sheets than it', '?pageIndex=1', TENANT_UMBRELLA.siteId, paged.slice(0, 1000), PAGED_SHEETS],
      ['the second full page of that tenant', '?pageIndex=2', TENANT_UMBRELLA.siteId, paged.slice(1000), PAGED_SHEETS],
    ])('pages: %s', async (_case, query, site, ids, total) => {
      const res = await call<Schemas['SheetStatusList']>('GET', `${SHEET_STATUS}${query}`, { roles: EXPORTER, site });
      expect([res.status, res.body.items.map((row) => row.timesheetId), res.body.total]).toEqual([200, ids, total]);
    });

    it('answers the rows of a page in the shape of the full list', async () => {
      const middle = await call<Schemas['SheetStatusList']>('GET', `${SHEET_STATUS}?pageIndex=2&itemsPerPage=2`, { roles: EXPORTER });
      expect(middle.body).toEqual({ items: [statusRow.first, statusRow.partial], total: 6 });
      const pages = await Promise.all(
        ['?itemsPerPage=1000', '?pageIndex=2'].map((query) => call<Schemas['SheetStatusList']>('GET', `${SHEET_STATUS}${query}`, { roles: EXPORTER, site: TENANT_UMBRELLA.siteId })),
      );
      expect(pages.map(({ body }) => body)).toEqual([
        { items: pagedRows.slice(0, 1000), total: PAGED_SHEETS },
        { items: pagedRows.slice(1000), total: PAGED_SHEETS },
      ]);
      expect(pagedRows[PAGED_SHEETS - 1]).toMatchObject({ periodStart: '2026-09-27T00:00:00', status: 'SUBMITTED' });
    });

    it.each([
      'asOf=2026-02-30',
      'pageIndex=0',
      'pageIndex=x',
      `pageIndex=${Number.MAX_SAFE_INTEGER + 1}`,
      'itemsPerPage=0',
      'itemsPerPage=1001',
      'itemsPerPage=1.5',
    ])('refuses the query %s as invalidParameters', async (query) => {
      const res = await call('GET', `${SHEET_STATUS}?${query}`, { roles: EXPORTER });
      expect([res.status, JSON.stringify(res.body)]).toEqual([400, v1Error('timesheets.sheet-status', 'invalid_request', 'Invalid parameters')]);
    });
  });

  describe('page reads', () => {
    it.each<[string, string, string, readonly string[], number, [number, number]]>([
      ['the sheet list of tenant-a', SHEETS, TENANT_A.siteId, PRIMARY, 6, [1, 1]],
      ['a full sheet list page', `${SHEETS}?itemsPerPage=1000`, TENANT_UMBRELLA.siteId, PRIMARY, 1000, [1, 1]],
      ['a sheet list page past the end', `${SHEETS}?pageIndex=2`, TENANT_A.siteId, PRIMARY, 0, [0, 0]],
      ['the sheet status of tenant-a', SHEET_STATUS, TENANT_A.siteId, EXPORTER, 6, [1, 1]],
      ['a full sheet status page', `${SHEET_STATUS}?itemsPerPage=1000`, TENANT_UMBRELLA.siteId, EXPORTER, 1000, [1, 1]],
      ['each page of the unpaged sheet status of a tenant spanning two pages', SHEET_STATUS, TENANT_UMBRELLA.siteId, EXPORTER, PAGED_SHEETS, [2, 2]],
    ])('reads the days and then the blackouts of %s in at most one query each', async (_case, url, site, roles, items, [dayReads, blackoutReads]) => {
      statements.length = 0;
      const res = await call<{ items: unknown[] }>('GET', url, { site, roles });
      expect([res.status, res.body.items.length]).toEqual([200, items]);
      expect([statementsOn(statements, 'timesheet_day'), statementsOn(statements, 'blackout')]).toEqual([dayReads, blackoutReads]);
    });
  });

  describe('unpaged sheet status failures', () => {
    /** The exporter's unpaged sheet-status read of the umbrella tenant with page `page` failing in its transaction. */
    async function readFailing(page: number): Promise<Injected> {
      const invocation = await mintServiceToken({ caller: 'gateway', audience: 'timesheets' });
      const user = await mintUserToken({ sub: USER_ID, site: TENANT_UMBRELLA.siteId, roles: EXPORTER });
      failingSheetPage = page;
      try {
        return await app.inject({ url: SHEET_STATUS, headers: { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` } });
      } finally {
        failingSheetPage = undefined;
      }
    }

    it('answers a failing first page as the v1 500 before any row is sent', async () => {
      const res = checked('GET', SHEET_STATUS, await readFailing(1));
      expect([res.status, res.body.error]).toEqual([500, { message: 'Unhandled Exception', code: 'server_error' }]);
    });

    it('cuts the response short on a failing later page, logs it and holds no connection', async () => {
      logLines.length = 0;
      await expect(readFailing(2)).rejects.toMatchObject({ code: 'LIGHT_ECONNRESET' });
      expect(handle.appPool.idleCount).toBe(handle.appPool.totalCount);
      const logged = logLines.map((line) => JSON.parse(line) as Record<string, unknown>).find((record) => record.message === 'sheet status stream failed');
      expect(logged).toMatchObject({ severity: 'ERROR', error: { message: 'PostgreSQL error 22012' } });
      const next = await call('GET', SHEET_STATUS, { roles: EXPORTER, site: TENANT_UMBRELLA.siteId });
      expect([next.status, next.text]).toEqual([200, JSON.stringify({ items: pagedRows })]);
    });
  });

  describe('authorisation', () => {
    it.each<[string, () => Promise<Answer>, number, Record<string, string>]>([
      ['no credential', async () => checked('GET', SHEETS, await app.inject({ url: SHEETS })), 401, { message: 'Insufficient Account Permissions', code: 'invalid_request' }],
      ['the exporter on the sheet list', () => call('GET', SHEETS, { roles: EXPORTER }), 403, { message: 'Insufficient Account Permissions', code: 'invalid_request' }],
      ['the exporter on a day action', () => call('POST', `${DAYS}/${MISSING_ID}/submit`, { roles: EXPORTER }), 403, { message: 'Insufficient Account Permissions', code: 'invalid_request' }],
      ['the employee on sheet status', () => call('GET', SHEET_STATUS, { roles: EMPLOYEE }), 403, { message: 'Insufficient Account Permissions', code: 'invalid_request' }],
      ['a siteid other than the token site', () => call('GET', `${SHEETS}?siteid=${TENANT_B.siteId}`), 403, { message: 'Insufficient Account Permissions', code: 'invalid_request' }],
    ])('denies %s before the handler runs', async (_case, send, status, error) => {
      const res = await send();
      expect([res.status, res.body.error]).toEqual([status, error]);
      expect(consumeCalls).toEqual([]);
    });

    it('answers a rejected user token with invalid_token and the bearer challenge', async () => {
      const invocation = await mintServiceToken({ caller: 'gateway', audience: 'timesheets' });
      const res = checked(
        'GET',
        SHEETS,
        await app.inject({ url: SHEETS, headers: { authorization: 'Bearer not-a-token', [INVOCATION_HEADER]: `Bearer ${invocation}` } }),
      );
      expect([res.status, res.body.error, res.headers['www-authenticate']]).toEqual([
        401,
        { message: 'Invalid Access Token', code: 'invalid_token' },
        'Bearer error="invalid_access_token"',
      ]);
    });

    it.each<[string, string, 'GET' | 'POST', string, string]>([
      ['the sheet list', SHEETS, 'GET', Roles.timesheetsEmployee, 'timesheets.sheets'],
      ['a day action', `${DAYS}/${MISSING_ID}/submit`, 'POST', Roles.timesheetsEmployee, 'timesheets.days.submit'],
      ['sheet status', SHEET_STATUS, 'GET', Roles.reportingExporter, 'timesheets.sheet-status'],
    ])('refuses %s to a workload credential holding the role without a user token', async (_case, url, method, role, envelopeMethod) => {
      const res = await call(method, url, { roles: null, invocationRoles: [role] });
      expect([res.status, JSON.stringify(res.body)]).toEqual([403, v1Error(envelopeMethod, 'invalid_request', 'Insufficient Account Permissions')]);
      expect(consumeCalls).toEqual([]);
    });
  });

  describe('outcome log lines', () => {
    it.each<[string, (dayId: string) => Promise<Answer>, number, string | null]>([
      ['a write without a CSRF token', (id) => act(id, 'submit', EMPLOYEE, undefined, {}), 400, 'request rejected: invalidTokens'],
      ['a role that may not take the action', (id) => act(id, 'submit', PRIMARY), 403, 'request denied: forbidden'],
      ['an illegal transition', (id) => act(id, 'resubmit', EMPLOYEE), 409, null],
      ['a comment that is not a string', (id) => act(id, 'submit', EMPLOYEE, { comment: 5 }), 400, 'request rejected: invalidParameters'],
      ['a comment PostgreSQL cannot store', (id) => act(id, 'submit', EMPLOYEE, { comment: 'reason-probe\u0000comment' }), 400, 'request rejected: 22021'],
      ['an asOf that is not a date', () => call('GET', `${SHEETS}?asOf=reason-probe`), 400, 'request rejected: invalidParameters'],
      ['a page outside the query schema', () => call('GET', `${SHEET_STATUS}?pageIndex=0`, { roles: EXPORTER }), 400, 'request rejected: FST_ERR_VALIDATION'],
      [
        'a workload credential without a user token',
        () => call('GET', SHEETS, { roles: null, invocationRoles: [Roles.timesheetsEmployee] }),
        403,
        'request denied: missing-credential',
      ],
      ['no credential', async () => checked('GET', SHEETS, await app.inject({ url: SHEETS })), 401, 'request denied: missing-credential'],
      ['a siteid other than the token site', () => call('GET', `${SHEETS}?siteid=${TENANT_B.siteId}`), 403, 'request denied: site-mismatch'],
      ['an action the lifecycle does not name', (id) => act(id, 'approve', EMPLOYEE), 404, null],
      ['an unknown day', () => act(MISSING_ID, 'submit', EMPLOYEE), 404, null],
    ])('logs %s with its fixed reason, if any, ahead of the completion line, leaving the day unchanged', async (_case, send, status, warning) => {
      const { dayId } = await seedTenantBDay('DRAFT');
      const before = logLines.length;

      const res = await send(dayId);
      const lines = logLines.slice(before).map((text) => JSON.parse(text) as Record<string, unknown>);

      expect(res.status).toBe(status);
      expect(lines.filter(({ severity, message }) => severity === 'WARNING' || message === 'request completed').map(({ severity, message }) => [severity, message])).toStrictEqual([
        ...(warning === null ? [] : [['WARNING', warning]]),
        ['INFO', 'request completed'],
      ]);
      expect(lines.filter(({ severity }) => severity === 'ERROR')).toEqual([]);
      for (const line of lines) expect(validateLogRecord(line).errors).toStrictEqual([]);
      expect(JSON.stringify(lines)).not.toMatch(/reason-probe|invalid byte sequence|0x00/);
      expect(await storedDay(dayId)).toMatchObject({ day: { state: 'DRAFT', lastupdate: null }, actions: [] });
    });
  });
});
