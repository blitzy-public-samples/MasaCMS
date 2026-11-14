// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Provider contract of timesheets: the app and contracts/openapi.yaml agree on metadata, routes, declarations, calls and every response shape. */
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { pushPath, topicOfSubscription } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  TENANT_A,
  TENANT_UMBRELLA,
  TEST_PUSH_KEY,
  assertResponseMatchesOpenApi,
  findOperation,
  pushTo,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
  type OpenApiOperation,
  type PushTarget,
} from '@opt2/platform/testing';
import type { TimesheetState } from '../../src/domain/lifecycle.transitions.js';
import { PERSON_ARCHIVED_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { TIMESHEETS_UNITS } from '../../src/repo/tables.js';
import { asOf, buildTestApp, createRecordingDb, headersFor, serviceHeaders, type TestApp } from '../helpers/app.js';
import { EFFECTIVE_FROM, SHARED_PERSON_ID, seedSheet, toSeed, type SeededSheet } from '../helpers/days.js';

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  'x-opt2-calls'?: unknown;
  paths: Record<string, Record<string, unknown>>;
}

interface ContractOperation {
  key: string;
  operation: OpenApiOperation;
}

type Ctx = TestApp & { seeded: SeededSheet };

type HttpMethod = 'GET' | 'POST';

interface CaseResult {
  method: HttpMethod;
  url: string;
  response: InjectResponse;
}

interface RequestOptions {
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
}

/** Credentials an operation's case presents, bound to the roles that operation declares. */
interface Principals {
  /** A user of `site` (tenant-a by default) holding `role`, which the operation must admit. */
  user(role: string, options?: RequestOptions & { site?: string }): Promise<RequestOptions>;
  /** The invocation credential of service `caller`, holding exactly the operation's `x-opt2-requires`. */
  service(caller: string, options?: RequestOptions): Promise<RequestOptions>;
}

type CaseRun = (ctx: Ctx, as: Principals) => Promise<CaseResult>;

const DOC = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
const TRANSPORTS: readonly unknown[] = ['service', 'pubsub-push', 'cloud-tasks'];
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const WRITE_POSITION = /^timesheets=\d+$/;
const WRITE_POSITION_HEADER = 'X-Opt2-Write-Position';
const METHOD_OVERRIDE = 'x-http-method-override';

const FX = '/legacy-fixtures/cfml/api.cfm/timesheets';
const V1 = '/v1/timesheets';
const MIGRATION = '/internal/v1/migration';
const EXPORT_READ = '/internal/v1/timesheets/sheet-status';
const ARCHIVE_PUSH = pushPath(PERSON_ARCHIVED_SUBSCRIPTION);
const SITE_PUSH = pushPath(SITE_CHANGED_SUBSCRIPTION);
const SITE = TENANT_A.siteId;
const TENANT = TENANT_A.tenantId;
const AS_OF = asOf();
const EMPLOYEE = Roles.timesheetsEmployee;
const PRIMARY = Roles.timesheetsPrimaryApprover;
const SECONDARY = Roles.timesheetsSecondaryApprover;
const EXPORTER = Roles.reportingExporter;
const [SHEET_UNIT, DAY_UNIT] = TIMESHEETS_UNITS;
const UNKNOWN_ID = cfUuid();
const EXPORT_ID = cfUuid();
const EXPORT_CLAIM = '2';
const GATE_HOLDER = 'timesheets-contract-holder';
const WATERMARK = {
  legacyTable: 'Program_1.timesheet',
  direction: 'forward',
  snapshotSeq: 1,
  backupLsn: '1',
  finishedAt: '2026-06-30 12:00:00',
} as const;

/** The seeded tenant-a sheet's days, by the role each plays in a case; the blackout day closes a DRAFT day. */
const DAY = { draft: 0, submitted: 1, primaryApproved: 2, approved: 3, blackout: 4 } as const;
const DAY_STATES = ['DRAFT', 'SUBMITTED', 'PRIMARY_APPROVED', 'APPROVED', 'DRAFT'] as const satisfies readonly TimesheetState[];
const WORK_DATES = [EFFECTIVE_FROM, '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19'] as const;

/** Services the helper app's doubles stand for: identity's CSRF consume and reporting's export scope lookup. */
const IDENTITY = 'identity';
const REPORTING = 'reporting';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every operation of `doc`, keyed `METHOD template`. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      return isRecord(operation) ? [{ key: `${method.toUpperCase()} ${path}`, operation: operation as OpenApiOperation }] : [];
    }),
  );
}

/** A Fastify route pattern in contract form, `:name` as `{name}`. */
function toTemplate(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Registered routes without the HEAD mirrors Fastify exposes for GET routes the contract declares no HEAD for. */
function declaredRoutes(routes: readonly RouteMatrixEntry[], doc: OpenApiDoc): RouteMatrixEntry[] {
  const contractKeys = new Set(contractOperations(doc).map(({ key }) => key));
  return routes.filter(
    (route) =>
      !(
        route.method === 'HEAD' &&
        routes.some((other) => other.method === 'GET' && other.url === route.url) &&
        !contractKeys.has(`HEAD ${toTemplate(route.url)}`)
      ),
  );
}

/** An auth declaration in comparable form: roles sorted, the public flag a boolean. */
function declaration(requires: unknown, isPublic: unknown, transport: unknown): Record<string, unknown> {
  return { requires: Array.isArray(requires) ? [...(requires as string[])].sort() : [], public: isPublic === true, transport };
}

/** Sorted `METHOD template` keys of the registered routes. */
function routeKeys(routes: readonly RouteMatrixEntry[], doc: OpenApiDoc): string[] {
  return declaredRoutes(routes, doc)
    .map((route) => `${route.method} ${toTemplate(route.url)}`)
    .sort();
}

/** Sorted `METHOD template` keys of the contract operations. */
function operationKeys(doc: OpenApiDoc): string[] {
  return contractOperations(doc)
    .map(({ key }) => key)
    .sort();
}

const OPERATIONS = new Map(contractOperations(DOC).map(({ operation }) => [operation.operationId ?? '', operation]));
const OPERATION_IDS = [...OPERATIONS.keys()];

/** The `x-opt2-requires` roles of `operationId`; empty for a public operation. */
function requiresOf(operationId: string): string[] {
  const requires = OPERATIONS.get(operationId)?.['x-opt2-requires'];
  return Array.isArray(requires) ? (requires as string[]) : [];
}

/** The node a local `$ref` chain ends at. */
function resolved(node: unknown): unknown {
  let current = node;
  while (isRecord(current) && typeof current.$ref === 'string') {
    current = current.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>((parent, segment) => (isRecord(parent) ? parent[segment] : undefined), DOC);
  }
  return current;
}

/** Whether the operation serving `method path` declares the write-position header on `status`. */
function declaresWritePosition(method: string, path: string, status: number): boolean {
  const { operation } = findOperation(DOC, method, path);
  const response = resolved(operation.responses?.[String(status)]);
  return isRecord(response) && isRecord(response.headers) && WRITE_POSITION_HEADER in response.headers;
}

/** The request path of `url`, without its query. */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url;
}

/** Validates `response` against the operation of `method url`: JSON bodies parsed, others as text, a 204 as no content. */
function assertContract(method: string, url: string, response: InjectResponse): void {
  const path = pathOf(url);
  if (response.statusCode === 204) {
    expect(response.body).toBe('');
    assertResponseMatchesOpenApi(DOC, { method, path, status: 204, contentType: undefined, body: undefined });
    return;
  }
  const contentType = response.headers['content-type'];
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType);
  const body: unknown = json ? JSON.parse(response.payload) : response.body;
  assertResponseMatchesOpenApi(DOC, { method, path, status: response.statusCode, contentType, body });
}

/** Asserts that `method url` resolves to the contract operation `operationId`. */
function expectOperation(operationId: string, method: string, url: string): void {
  expect(findOperation(DOC, method, pathOf(url)).operation.operationId).toBe(operationId);
}

/** Credentials for `operationId`'s case, each checked against or taken from its declared roles. */
function principalsFor(operationId: string): Principals {
  return {
    async user(role, { site = SITE, ...options } = {}) {
      expect(requiresOf(operationId)).toContain(role);
      return { ...options, headers: { ...(await headersFor({ roles: [role], site })), ...options.headers } };
    },
    async service(caller, options = {}) {
      const roles = requiresOf(operationId);
      expect(roles.length).toBeGreaterThan(0);
      return { ...options, headers: { ...(await serviceHeaders(caller, roles)), ...options.headers } };
    },
  };
}

/** Injects one request into the app under test. */
async function send(ctx: TestApp, method: HttpMethod, url: string, { headers = {}, payload }: RequestOptions = {}): Promise<CaseResult> {
  const response = await ctx.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  return { method, url, response };
}

/** Options sent with `X-HTTP-Method-Override: <method>`. */
function overriding(method: HttpMethod): RequestOptions {
  return { headers: { [METHOD_OVERRIDE]: method } };
}

/** The seeded day id playing `role`. */
function dayId(ctx: Ctx, role: keyof typeof DAY): string {
  const day = ctx.seeded.days[DAY[role]];
  if (day === undefined) throw new RangeError(`the seeded sheet has no ${role} day`);
  return day.day_id;
}

/** `<prefix>/sheets/<seeded sheet id><suffix>`. */
function sheetUrl(ctx: Ctx, prefix: string, suffix = ''): string {
  return `${prefix}/sheets/${ctx.seeded.sheet.timesheet_id}${suffix}`;
}

/** `<prefix>/days/<day id>/<action>`. */
function dayUrl(ctx: Ctx, prefix: string, role: keyof typeof DAY, action: string): string {
  return `${prefix}/days/${dayId(ctx, role)}/${action}`;
}

/** `url` scoped to tenant-a by the fixture's `siteid` parameter. */
function inSite(url: string, site = SITE): string {
  return `${url}${url.includes('?') ? '&' : '?'}siteid=${site}`;
}

/** The parsed JSON body of a 200 answer. */
function jsonOf<T>(response: InjectResponse): T {
  expect(response.statusCode, response.body).toBe(200);
  return JSON.parse(response.payload) as T;
}

/** A push target that delivers pushTo's request without its push key, presenting `headers` instead. */
function keylessPushTarget(app: TestApp['app'], headers: Record<string, string>): PushTarget {
  const inject = (opts: { method: HttpMethod; url: string; payload: object }): Promise<InjectResponse> => {
    const url = opts.url.replace(`?key=${encodeURIComponent(TEST_PUSH_KEY)}`, '');
    expect(url).toBe(SITE_PUSH);
    return app.inject({ method: opts.method, url, headers, payload: opts.payload });
  };
  return { inject: inject as unknown as PushTarget['inject'] };
}

/** The tenant-a `programs-sites.site.changed.v1` envelope at `aggregateVersion`, above the seeded registry's version 1. */
function siteChangedEnvelope(aggregateVersion: number): ReturnType<typeof testEnvelope> {
  const payload = registryPayloads().find((entry) => entry.siteId === SITE);
  if (payload === undefined) throw new RangeError(`registryPayloads() has no ${SITE} entry`);
  return testEnvelope({ topic: topicOfSubscription(SITE_CHANGED_SUBSCRIPTION), tenantId: TENANT, aggregateId: SITE, aggregateVersion, payload });
}

/** A fresh app over a recording db holding one tenant-a sheet of {@link SHARED_PERSON_ID} with a day per {@link DAY} role. */
async function freshCtx(): Promise<Ctx> {
  const seeded = seedSheet(TENANT_A, { personId: SHARED_PERSON_ID, states: DAY_STATES, workDates: WORK_DATES, blackoutDays: [DAY.blackout] });
  const t = await buildTestApp({ db: createRecordingDb(toSeed(seeded)) });
  return Object.assign(t, { seeded });
}

/** Services the app called while `ctx` served its requests. */
function servicesCalled(ctx: Ctx): string[] {
  return [...(ctx.csrf.calls.length > 0 ? [IDENTITY] : []), ...(ctx.reporting.lookups.length > 0 ? [REPORTING] : [])];
}

/** One 2xx request per contract operation, keyed by `operationId`. */
const cases: Record<string, CaseRun> = {
  fixtureListSheets: async (ctx, as) => send(ctx, 'GET', inSite(`${FX}/sheets?asOf=${AS_OF}`), await as.user(EMPLOYEE)),
  fixtureListSheetsByPost: async (ctx, as) =>
    send(ctx, 'POST', inSite(`${FX}/sheets?asOf=${AS_OF}&pageIndex=1&itemsPerPage=10`), await as.user(PRIMARY, overriding('GET'))),
  fixtureGetSheet: async (ctx, as) => send(ctx, 'GET', inSite(sheetUrl(ctx, FX)), await as.user(SECONDARY)),
  fixtureGetSheetByPost: async (ctx, as) => send(ctx, 'POST', inSite(sheetUrl(ctx, FX)), await as.user(EMPLOYEE, overriding('GET'))),
  fixtureGetSheetStatus: async (ctx, as) => send(ctx, 'GET', inSite(sheetUrl(ctx, FX, `/status?asOf=${AS_OF}`)), await as.user(PRIMARY)),
  fixtureGetSheetStatusByPost: async (ctx, as) =>
    send(ctx, 'POST', inSite(sheetUrl(ctx, FX, `/status?asOf=${AS_OF}`)), await as.user(SECONDARY, overriding('GET'))),
  fixtureDayAction: async (ctx, as) => send(ctx, 'POST', inSite(dayUrl(ctx, FX, 'draft', 'submit')), await as.user(EMPLOYEE)),
  fixtureDayActionByGet: async (ctx, as) =>
    send(ctx, 'GET', inSite(dayUrl(ctx, FX, 'submitted', 'primary-approve')), await as.user(PRIMARY, overriding('POST'))),
  listSheets: async (ctx, as) => send(ctx, 'GET', `${V1}/sheets?asOf=${AS_OF}`, await as.user(EMPLOYEE)),
  getSheet: async (ctx, as) => send(ctx, 'GET', sheetUrl(ctx, V1, `?asOf=${AS_OF}`), await as.user(SECONDARY)),
  dayAction: async (ctx, as) =>
    send(ctx, 'POST', dayUrl(ctx, V1, 'submitted', 'primary-approve'), await as.user(PRIMARY, { payload: { comment: 'contract approval' } })),
  listSheetStatus: async (ctx, as) => send(ctx, 'GET', `${V1}/sheet-status?asOf=${AS_OF}`, await as.user(EXPORTER)),
  listExportSheetStatus: async (ctx, as) => {
    ctx.reporting.answer({
      status: 200,
      body: { exportId: EXPORT_ID, tenantId: TENANT, siteId: SITE, source: 'timesheets.sheets', state: 'running', claim: EXPORT_CLAIM },
    });
    const query = `exportId=${EXPORT_ID}&siteId=${SITE}&claim=${EXPORT_CLAIM}&asOf=${AS_OF}&pageIndex=1&itemsPerPage=50`;
    return send(ctx, 'GET', `${EXPORT_READ}?${query}`, await as.service(REPORTING));
  },
  pushPersonArchived: async (ctx) => {
    const payload = {
      personId: SHARED_PERSON_ID,
      siteId: TENANT_UMBRELLA.siteId,
      effectiveFrom: `${EFFECTIVE_FROM} 00:00:00.000`,
      archiveId: cfUuid(),
      archivedAt: `${AS_OF} 09:30:00.000`,
    };
    const envelope = testEnvelope({
      topic: topicOfSubscription(PERSON_ARCHIVED_SUBSCRIPTION),
      tenantId: TENANT_UMBRELLA.tenantId,
      aggregateId: SHARED_PERSON_ID,
      payload,
    });
    const response = await pushTo(ctx.app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);
    expect(ctx.publisher.deadLetters(PERSON_ARCHIVED_SUBSCRIPTION)).toEqual([]);
    const blackedOut = ctx.db.rowsOf('blackout', TENANT).filter((row) => row.archive_id === payload.archiveId).map((row) => row.day_id);
    expect(blackedOut.sort()).toEqual([dayId(ctx, 'draft'), dayId(ctx, 'submitted'), dayId(ctx, 'primaryApproved')].sort());
    return { method: 'POST', url: ARCHIVE_PUSH, response };
  },
  pushSiteChanged: async (ctx) => {
    const response = await pushTo(ctx.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(2));
    expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toEqual([]);
    return { method: 'POST', url: SITE_PUSH, response };
  },
  migrationApply: async (ctx, as) => {
    const exported = await send(ctx, 'GET', `${MIGRATION}/export?unit=${SHEET_UNIT}&tenantId=${TENANT}`, await as.service('migration'));
    const [table] = jsonOf<{ tables: { columns: unknown[]; rows: { row: string }[] }[] }>(exported.response).tables;
    expect(table?.rows).toHaveLength(1);
    const batch = {
      batchId: `timesheets-contract-apply-${cfUuid()}`,
      origin: 'backfill',
      legacyTable: WATERMARK.legacyTable,
      tenantId: TENANT,
      columns: table?.columns ?? [],
      rows: (table?.rows ?? []).map(({ row }) => ({ op: 'upsert', row })),
    };
    return send(ctx, 'POST', `${MIGRATION}/apply`, await as.service('migration', { payload: batch }));
  },
  migrationExport: async (ctx, as) => send(ctx, 'GET', `${MIGRATION}/export?unit=${SHEET_UNIT}&tenantId=${TENANT}`, await as.service('migration')),
  migrationChanges: async (ctx, as) => send(ctx, 'GET', `${MIGRATION}/changes?tenantId=${TENANT}&after=0:0`, await as.service('migration')),
  migrationPosition: async (ctx, as) => send(ctx, 'GET', `${MIGRATION}/position`, await as.service('migration')),
  migrationGetWatermark: async (ctx, as) => {
    jsonOf((await send(ctx, 'POST', `${MIGRATION}/watermark`, await as.service('migration', { payload: { ...WATERMARK } }))).response);
    const query = `legacyTable=${WATERMARK.legacyTable}&direction=${WATERMARK.direction}`;
    const result = await send(ctx, 'GET', `${MIGRATION}/watermark?${query}`, await as.service('migration'));
    expect(jsonOf<unknown[]>(result.response)).toHaveLength(1);
    return result;
  },
  migrationSetWatermark: async (ctx, as) =>
    send(ctx, 'POST', `${MIGRATION}/watermark`, await as.service('migration', { payload: { ...WATERMARK } })),
  migrationGate: async (ctx, as) => {
    const payload = { op: 'close', units: [SHEET_UNIT], holderId: GATE_HOLDER, phase: 'quiet' };
    const result = await send(ctx, 'POST', `${MIGRATION}/gate`, await as.service('migration', { payload }));
    expect(jsonOf<{ units: unknown[] }>(result.response).units).toEqual([
      expect.objectContaining({ unit: SHEET_UNIT, state: 'closed', holderId: GATE_HOLDER, phase: 'quiet' }),
    ]);
    return result;
  },
  healthz: async (ctx) => send(ctx, 'GET', '/healthz'),
};

/** Runs the case of `operationId`, checking that its request reaches that operation. */
async function runCase(ctx: Ctx, operationId: string): Promise<CaseResult> {
  const run = cases[operationId];
  if (run === undefined) throw new Error(`no response case for ${operationId}`);
  const result = await run(ctx, principalsFor(operationId));
  expectOperation(operationId, result.method, result.url);
  return result;
}

interface ErrorCase {
  title: string;
  operationId: string;
  status: number;
  /** `error.message` the answer carries. */
  message: string;
  run: CaseRun;
}

/** One documented error answer per family, with the status and error message it must carry. */
const errorCases: readonly ErrorCase[] = [
  {
    title: 'fixture notFound for an unknown sheet',
    operationId: 'fixtureGetSheet',
    status: 404,
    message: 'Not Found',
    run: async (ctx, as) => send(ctx, 'GET', inSite(`${FX}/sheets/${UNKNOWN_ID}`), await as.user(EMPLOYEE)),
  },
  {
    title: 'fixture forbidden for a role the action does not admit',
    operationId: 'fixtureDayAction',
    status: 403,
    message: 'Insufficient Account Permissions',
    run: async (ctx, as) => send(ctx, 'POST', inSite(dayUrl(ctx, FX, 'submitted', 'primary-approve')), await as.user(EMPLOYEE)),
  },
  {
    title: 'fixture blackout conflict for an action on a blackout day',
    operationId: 'fixtureDayAction',
    status: 409,
    message: 'blackout',
    run: async (ctx, as) => send(ctx, 'POST', inSite(dayUrl(ctx, FX, 'blackout', 'submit')), await as.user(EMPLOYEE)),
  },
  {
    title: 'fixture illegalTransition conflict for submit on an APPROVED day',
    operationId: 'fixtureDayAction',
    status: 409,
    message: 'illegalTransition',
    run: async (ctx, as) => send(ctx, 'POST', inSite(dayUrl(ctx, FX, 'approved', 'submit')), await as.user(EMPLOYEE)),
  },
  {
    title: 'fixture invalidParameters for a site without a program',
    operationId: 'fixtureListSheets',
    status: 400,
    message: 'Invalid parameters',
    run: async (ctx, as) =>
      send(ctx, 'GET', inSite(`${FX}/sheets?asOf=${AS_OF}`, TENANT_UMBRELLA.siteId), await as.user(EMPLOYEE, { site: TENANT_UMBRELLA.siteId })),
  },
  {
    title: 'v1 forbidden for a role the action does not admit',
    operationId: 'dayAction',
    status: 403,
    message: 'Insufficient Account Permissions',
    run: async (ctx, as) => send(ctx, 'POST', dayUrl(ctx, V1, 'submitted', 'primary-approve'), await as.user(EMPLOYEE)),
  },
  {
    title: 'v1 notFound for an unknown sheet',
    operationId: 'getSheet',
    status: 404,
    message: 'Not Found',
    run: async (ctx, as) => send(ctx, 'GET', `${V1}/sheets/${UNKNOWN_ID}`, await as.user(PRIMARY)),
  },
  {
    title: 'v1 blackout conflict for an action on a blackout day',
    operationId: 'dayAction',
    status: 409,
    message: 'blackout',
    run: async (ctx, as) => send(ctx, 'POST', dayUrl(ctx, V1, 'blackout', 'submit'), await as.user(EMPLOYEE)),
  },
  {
    title: 'v1 illegalTransition conflict for submit on an APPROVED day',
    operationId: 'dayAction',
    status: 409,
    message: 'illegalTransition',
    run: async (ctx, as) => send(ctx, 'POST', dayUrl(ctx, V1, 'approved', 'submit'), await as.user(EMPLOYEE)),
  },
  {
    title: 'the legacy 503 for a fixture day action while its unit is legacy-authoritative',
    operationId: 'fixtureDayAction',
    status: 503,
    message: 'Unhandled Exception',
    run: async (ctx, as) => {
      ctx.db.setGate(DAY_UNIT, 'legacy');
      return send(ctx, 'POST', inSite(dayUrl(ctx, FX, 'draft', 'submit')), await as.user(EMPLOYEE));
    },
  },
  {
    title: 'the legacy 503 for a v1 day action while its unit is legacy-authoritative',
    operationId: 'dayAction',
    status: 503,
    message: 'Unhandled Exception',
    run: async (ctx, as) => {
      ctx.db.setGate(DAY_UNIT, 'legacy');
      return send(ctx, 'POST', dayUrl(ctx, V1, 'submitted', 'primary-approve'), await as.user(PRIMARY));
    },
  },
];

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect(DOC.info.version).toBe('1.0.0');
    expect(DOC.info['x-source-sha']).toBe(PIN.sha);
  });

  it('lists each called service once in x-opt2-calls', () => {
    const calls = DOC['x-opt2-calls'];
    expect(Array.isArray(calls) && calls.every((service) => typeof service === 'string')).toBe(true);
    expect(new Set(calls as string[]).size).toBe((calls as string[]).length);
  });

  it('gives every operation a unique operationId, exactly one of x-opt2-requires and x-opt2-public, and a transport', () => {
    const ids = contractOperations(DOC).map(({ operation }) => operation.operationId ?? '');
    expect(ids.filter((id, index) => id === '' || ids.indexOf(id) !== index)).toEqual([]);
    const malformed = contractOperations(DOC).filter(({ operation }) => {
      const requires = operation['x-opt2-requires'];
      const validRoles = Array.isArray(requires) && requires.length > 0 && requires.every((role) => typeof role === 'string');
      const declaresOne = 'x-opt2-requires' in operation ? validRoles && !('x-opt2-public' in operation) : operation['x-opt2-public'] === true;
      return !declaresOne || !TRANSPORTS.includes(operation['x-opt2-transport']);
    });
    expect(malformed.map(({ key }) => key)).toEqual([]);
  });
});

describe('timesheets app against the contract', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await freshCtx();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('registers exactly the contract operations', () => {
    expect(routeKeys(collectRouteMatrix(ctx.app).routes, DOC)).toEqual(operationKeys(DOC));
  });

  it('notices a route missing from the app and an operation missing from the contract', () => {
    const { routes } = collectRouteMatrix(ctx.app);
    const withoutHealth = structuredClone(DOC);
    delete withoutHealth.paths['/healthz']?.get;
    expect(routeKeys(routes, withoutHealth)).not.toEqual(operationKeys(withoutHealth));
    expect(routeKeys(routes.filter((route) => route.url !== '/healthz'), DOC)).not.toEqual(operationKeys(DOC));
  });

  it('declares each route with the contract roles, public flag and transport', () => {
    const routes = declaredRoutes(collectRouteMatrix(ctx.app).routes, DOC);
    const actual = Object.fromEntries(
      routes.map((route) => [`${route.method} ${toTemplate(route.url)}`, declaration(route.requires, route.public, route.transport)]),
    );
    const contracted = Object.fromEntries(
      routes.map((route) => {
        const { template, operation } = findOperation(DOC, route.method, toTemplate(route.url));
        expect(template).toBe(toTemplate(route.url));
        return [`${route.method} ${template}`, declaration(operation['x-opt2-requires'], operation['x-opt2-public'], operation['x-opt2-transport'])];
      }),
    );
    expect(actual).toEqual(contracted);

    const migration = Object.entries(actual).filter(([key]) => key.split(' ')[1]?.startsWith(`${MIGRATION}/`));
    expect(migration).toHaveLength(7);
    for (const [, declared] of migration) expect(declared).toEqual(declaration(['platform.migration'], undefined, 'service'));
    for (const push of [ARCHIVE_PUSH, SITE_PUSH]) {
      expect(actual[`POST ${push}`]).toEqual(declaration(['service:pubsub-invoker'], undefined, 'pubsub-push'));
    }
    expect(actual[`GET ${EXPORT_READ}`]).toEqual(declaration(['service:reporting'], undefined, 'service'));
    expect(actual['GET /healthz']).toEqual(declaration(undefined, true, 'service'));
  });

  it('has exactly one response case per contract operation', () => {
    expect(Object.keys(cases).sort()).toEqual([...OPERATION_IDS].sort());
  });

  it.each(OPERATION_IDS)('%s answers 2xx in its contract shape', async (operationId) => {
    const { method, url, response } = await runCase(ctx, operationId);
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    assertContract(method, url, response);
    if (declaresWritePosition(method, pathOf(url), response.statusCode)) {
      expect(response.headers['x-opt2-write-position']).toMatch(WRITE_POSITION);
    }
  });

  it.each(errorCases)('answers $title with $status in its contract shape', async ({ operationId, status, message, run }) => {
    const { method, url, response } = await run(ctx, principalsFor(operationId));
    expectOperation(operationId, method, url);
    expect(response.statusCode, response.body).toBe(status);
    assertContract(method, url, response);
    expect((JSON.parse(response.payload) as { error: { message: string } }).error.message).toBe(message);
    expect(ctx.db.writes).toEqual([]);
  });

  it('refuses a push delivery that presents a user token instead of the push key', async () => {
    const target = keylessPushTarget(ctx.app, await headersFor({ roles: [EMPLOYEE] }));
    const response = await pushTo(target, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(3));
    expect([401, 403]).toContain(response.statusCode);
    assertContract('POST', SITE_PUSH, response);
    expect(ctx.db.queries).toEqual([]);
  });

  it('refuses a migration call that presents only a user token', async () => {
    const { authorization } = await headersFor({ roles: [EMPLOYEE] });
    const result = await send(ctx, 'GET', `${MIGRATION}/position`, { headers: { authorization: authorization ?? '' } });
    expect([401, 403]).toContain(result.response.statusCode);
    assertContract(result.method, result.url, result.response);
    expect(ctx.db.queries).toEqual([]);
  });
});

describe('timesheets service calls', () => {
  it('calls exactly the services x-opt2-calls declares', async () => {
    const declared = new Set(DOC['x-opt2-calls'] as string[]);
    const called = new Set<string>();
    for (const operationId of OPERATION_IDS) {
      const ctx = await freshCtx();
      try {
        await runCase(ctx, operationId);
        for (const service of servicesCalled(ctx)) {
          expect(declared, `${operationId} calls ${service}`).toContain(service);
          called.add(service);
        }
      } finally {
        await ctx.app.close();
      }
    }
    expect([...called].sort()).toEqual([...declared].sort());
  });
});
