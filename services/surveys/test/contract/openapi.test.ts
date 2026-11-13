// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Provider contract of surveys: every registered route against contracts/openapi.yaml, and every response shape per operation. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, collectRouteMatrix, type RouteMatrixEntry } from '@opt2/platform/auth';
import { sha256Hex } from '@opt2/platform/migration-kit';
import {
  TENANT_A,
  TENANT_B,
  assertResponseMatchesOpenApi,
  findOperation,
  mintServiceToken,
  mintTasksInvokerToken,
  pushTo,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type InjectResponse,
  type TenantlessEnvelope,
} from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

type HttpMethod = 'GET' | 'POST';
type Payload = Record<string, unknown>;
type OperationObject = Record<string, unknown> & { operationId?: string };

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
}

interface ContractOperation {
  method: string;
  path: string;
  operationId: string | undefined;
  op: OperationObject;
}

interface RouteSetDiff {
  undeclared: string[];
  unregistered: string[];
}

/** The auth declaration of one route, as the matrix records it and as the contract's `x-opt2-*` keys state it. */
interface Declaration {
  transport: unknown;
  requires: string[];
  public: boolean;
  siteCheck: boolean;
}

/** What a case seeds before its request: nothing, a DRAFT survey, or that survey SCHEDULED with one reminder and a known task token. */
type SeedLevel = 'none' | 'draft' | 'scheduled';

/** Ids the app assigned to what the case seeded; `surveyId` is the empty string when nothing was seeded. */
interface Seeded {
  surveyId: string;
}

/** A response as `sendCase` hands it to a case: the inject response and its body, JSON-parsed when JSON. */
interface Answer {
  res: InjectResponse;
  body: unknown;
}

/** One request against an operation; `as` names the ROLE_SET subject presenting credentials, `push` delivers through `pushTo`. */
interface Case {
  name: string;
  method: HttpMethod;
  url: string | ((seeded: Seeded) => string);
  as?: string;
  site?: string;
  headers?: Record<string, string> | (() => Promise<Record<string, string>>);
  payload?: Payload | ((seeded: Seeded) => Payload);
  push?: () => TenantlessEnvelope;
  seed?: SeedLevel;
  setup?: (ctx: TestApp, seeded: Seeded) => void | Promise<void>;
  status: number;
  verify?: (answer: Answer, ctx: TestApp, seeded: Seeded) => void;
}

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };

const DOC = load(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(await readFile(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const FIXTURE = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const PUSH_PATH = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const MANAGER = 'surveys.manager';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000000' };
const TASK_TOKEN = 'contract-task-token';
const LAUNCH_AT = '2026-07-01T09:00:00';
const SWEEP_QUEUE = 'surveys-outbox-sweep';
const LAUNCH_QUEUE = 'surveys-launch';
const SURVEY_UNIT = 'surveys.survey';
const SURVEY_LEGACY_TABLE = 'synthetic.survey';
const SURVEY_LEGACY_COLUMNS = [
  { name: 'survey_id', type: 's' },
  { name: 'siteID', type: 's' },
  { name: 'title', type: 's' },
  { name: 'status', type: 's' },
  { name: 'created', type: 't' },
  { name: 'createdByID', type: 's' },
  { name: 'lastUpdate', type: 't' },
  { name: 'lastUpdateByID', type: 's' },
  { name: 'launched_at', type: 't' },
];

/** Masa UserIDs, CF UUIDs as the contract types every stored user id, of the user subjects the cases present. */
const USER_IDS: Readonly<Record<string, string>> = {
  [MANAGER]: '11111111-2222-3333-4444555566667777',
  'system-user': '22222222-3333-4444-5555666677778888',
  s2: '33333333-4444-5555-6666777788889999',
};
const FIXTURE_FORBIDDEN = { code: 'invalid_request', message: 'Insufficient Account Permissions' };
const FIXTURE_NOT_FOUND = { code: 'invalid_request', message: 'Not Found' };
const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const UNAVAILABLE = { code: 'server_error', message: 'Unhandled Exception' };

/** One entry per operation of `doc`, its method upper-cased. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const op = item[method] as OperationObject | undefined;
      return op === undefined ? [] : [{ method: method.toUpperCase(), path, operationId: op.operationId, op }];
    }),
  );
}

/** A Fastify route pattern in contract form: `:name` as `{name}`. */
function toOpenApiPath(fastifyUrl: string): string {
  return fastifyUrl.replace(/:([A-Za-z_]\w*)/g, '{$1}');
}

/** `METHOD path` key of a registered route. */
function routeKey(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${toOpenApiPath(route.url)}`;
}

/** `METHOD path` key of a contract operation. */
function operationKey(operation: Pick<ContractOperation, 'method' | 'path'>): string {
  return `${operation.method} ${operation.path}`;
}

/** Routes the contract does not declare, and operations no route serves, each sorted. */
function diffRouteSets(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): RouteSetDiff {
  const registered = new Set(routes.map(routeKey));
  const declared = new Set(operations.map(operationKey));
  return {
    undeclared: [...registered].filter((key) => !declared.has(key)).sort(),
    unregistered: [...declared].filter((key) => !registered.has(key)).sort(),
  };
}

function routeDeclaration(route: RouteMatrixEntry): Declaration {
  return {
    transport: route.transport,
    requires: [...(route.requires ?? [])].sort(),
    public: route.public === true,
    siteCheck: route.siteCheck,
  };
}

function operationDeclaration(op: OperationObject): Declaration {
  return {
    transport: op['x-opt2-transport'],
    requires: [...((op['x-opt2-requires'] as string[] | undefined) ?? [])].sort(),
    public: op['x-opt2-public'] === true,
    siteCheck: op['x-opt2-site-check'] !== false,
  };
}

/** `<route key>: <registered> != <contract>` for each registered route whose declaration differs from its operation's. */
function declarationMismatches(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): string[] {
  const byKey = new Map(operations.map((operation) => [operationKey(operation), operation.op]));
  return routes.flatMap((route) => {
    const op = byKey.get(routeKey(route));
    if (op === undefined) return [];
    const registered = JSON.stringify(routeDeclaration(route));
    const contracted = JSON.stringify(operationDeclaration(op));
    return registered === contracted ? [] : [`${routeKey(route)}: ${registered} != ${contracted}`];
  });
}

/** Headers presenting the ROLE_SET subject `name` for `site`, with its USER_IDS entry as the Masa UserID. */
function subjectHeaders(name: string, site: string = SITE_A): Promise<Record<string, string>> {
  return headersFor(name, { site, sub: USER_IDS[name] });
}

/** Headers of the surveys manager, plus the CSRF fields every fixture write checks. */
async function managerHeaders(): Promise<Record<string, string>> {
  return { ...(await subjectHeaders(MANAGER)), ...CSRF_HEADERS };
}

/** Sends a seeding request and returns its parsed body; fails the case unless it answers 200. */
async function seedRequest(ctx: TestApp, method: HttpMethod, url: string, payload: Record<string, unknown>): Promise<unknown> {
  const res = await ctx.app.inject({ method, url, headers: await managerHeaders(), payload });
  expect(res.statusCode, `seeding ${method} ${url}: ${res.body}`).toBe(200);
  return res.json();
}

/**
 * Creates a tenant-a survey through the fixture create route and, for `scheduled`, schedules it through the fixture
 * schedule route with one 30-minute reminder, then stores the hash of TASK_TOKEN as the schedule's task token.
 */
async function seedSurvey(ctx: TestApp, level: SeedLevel): Promise<Seeded> {
  if (level === 'none') return { surveyId: '' };
  const created = (await seedRequest(ctx, 'POST', `${FIXTURE}?siteid=${SITE_A}`, { title: 'Contract survey' })) as {
    data: { survey_id: string };
  };
  const surveyId = created.data.survey_id;
  if (level === 'scheduled') {
    await seedRequest(ctx, 'POST', `${FIXTURE}/${surveyId}/schedule?siteid=${SITE_A}`, {
      launchAt: LAUNCH_AT,
      reminders: [{ offsetMinutes: 30 }],
    });
    // The schedule keeps only a random token's hash, so the callbacks' token is set to one the cases know.
    await ctx.db.withTenant(TENANT_A.tenantId, (tx) =>
      tx.query('UPDATE surveys.survey_schedule SET task_token_hash = $1 WHERE survey_id = $2', [sha256Hex(TASK_TOKEN), surveyId]),
    );
  }
  ctx.publisher.clear();
  return { surveyId };
}

/** Fixture URL of the seeded survey's `tail`, with `query`. */
function fixtureUrl(tail: string, query = `siteid=${SITE_A}`): (seeded: Seeded) => string {
  return ({ surveyId }) => `${FIXTURE}/${surveyId}${tail}?${query}`;
}

/** `/v1/surveys` URL of the seeded survey's `tail` for tenant-a. */
function v1Url(tail = ''): (seeded: Seeded) => string {
  return ({ surveyId }) => `/v1/surveys/${surveyId}${tail}?siteid=${SITE_A}`;
}

/** Query of an anonymous fixture task callback presenting TASK_TOKEN. */
const CALLBACK_QUERY = `siteid=${SITE_A}&opt2TaskToken=${TASK_TOKEN}`;

/** Wire body of the seeded survey's `surveys-launch` task, naming `tenantId`. */
function launchTask(seeded: Seeded, tenantId: string = TENANT_A.tenantId): Record<string, unknown> {
  return {
    queue: LAUNCH_QUEUE,
    name: `opt2-survey-${seeded.surveyId}-launch`,
    tenantId,
    payload: { surveyId: seeded.surveyId, siteId: SITE_A, scheduleVersion: 1 },
  };
}

/** Body of communications' `markReminderSent` call for reminder `n` of the seeded survey. */
function reminderSent(seeded: Seeded, n = 1): Record<string, unknown> {
  return {
    tenantId: TENANT_A.tenantId,
    siteId: SITE_A,
    taskName: `opt2-survey-${seeded.surveyId}-reminder-${String(n)}`,
    scheduleVersion: 1,
    sentAt: '2026-07-01T09:30:00.000',
  };
}

/** Wire body of a tenant-less `surveys-outbox-sweep` chain task. */
const SWEEP_TASK = { queue: SWEEP_QUEUE, name: `${SWEEP_QUEUE}-1782820800`, tenantId: null };

/** Domains the tenant-a site carries after the delivery `siteChangedEnvelope` builds. */
const CHANGED_DOMAINS = [`${SITE_A}.opt2.test`, `surveys.${SITE_A}.opt2.test`];

/** A version-2 `programs-sites.site.changed.v1` delivery of tenant-a with a second domain. */
function siteChangedEnvelope() {
  const payload = registryPayloads().find((candidate) => candidate.siteId === SITE_A);
  return testEnvelope({
    topic: 'programs-sites.site.changed.v1',
    tenantId: TENANT_A.tenantId,
    aggregateId: SITE_A,
    aggregateVersion: 2,
    payload: { ...payload, domains: CHANGED_DOMAINS },
  });
}

/** Sends `c` to the app, asserts its status, then validates the response against the operation it addresses. */
async function sendCase(ctx: TestApp, c: Case, seeded: Seeded): Promise<Answer> {
  const url = typeof c.url === 'function' ? c.url(seeded) : c.url;
  const payload = typeof c.payload === 'function' ? c.payload(seeded) : c.payload;
  const headers = typeof c.headers === 'function' ? await c.headers() : c.headers;
  const res =
    c.push === undefined
      ? await ctx.app.inject({
          method: c.method,
          url,
          headers: { ...(c.as === undefined ? {} : await subjectHeaders(c.as, c.site)), ...headers },
          ...(payload === undefined ? {} : { payload }),
        })
      : await pushTo(ctx.app, SITE_CHANGED_SUBSCRIPTION, c.push());
  const path = url.split('?')[0] ?? url;
  const { operation } = findOperation(DOC, c.method, path);
  const contentType = res.headers['content-type'];
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) && res.body !== '';
  const body: unknown = json ? JSON.parse(res.body) : res.body;
  expect(res.statusCode, `${operation.operationId ?? path}: ${res.body}`).toBe(c.status);
  assertResponseMatchesOpenApi(DOC, { method: c.method, path, status: res.statusCode, contentType, body });
  return { res, body };
}

/** The parsed body as a record, for property checks. */
function record(body: unknown): Record<string, unknown> {
  expect(body).toBeTypeOf('object');
  return body as Record<string, unknown>;
}

/** The `data` member of a parsed envelope or `{data}` body. */
function dataOf(body: unknown): Record<string, unknown> {
  return record(record(body).data);
}

/** The stored status of the seeded survey. */
function storedStatus(ctx: TestApp, seeded: Seeded): unknown {
  return ctx.db.rows('survey').find((row) => row.survey_id === seeded.surveyId)?.status;
}

/** Launches the seeded scheduled survey through the anonymous fixture launch callback. */
async function launchThroughCallback(ctx: TestApp, seeded: Seeded): Promise<void> {
  const res = await ctx.app.inject({ method: 'GET', url: fixtureUrl('/launch', CALLBACK_QUERY)(seeded) });
  expect(res.statusCode, res.body).toBe(200);
}

/** Stores one tenant-a response to the seeded survey through the fixture respond route. */
async function respondThroughFixture(ctx: TestApp, seeded: Seeded): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: fixtureUrl('/responses')(seeded),
    headers: { ...(await subjectHeaders('system-user')), ...CSRF_HEADERS },
    payload: { answers: 'seeded answers' },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const CASES: Record<string, Case[]> = {
  fixtureListSurveys: [
    {
      name: 'lists the tenant-a surveys for the surveys manager',
      method: 'GET',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      as: MANAGER,
      seed: 'draft',
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({ totalitems: 1, items: [{ survey_id: surveyId, siteid: SITE_A, status: 'DRAFT' }] });
      },
    },
    {
      name: 'answers an anonymous caller with the fixture authorization 401',
      method: 'GET',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      status: 401,
      verify: ({ body }) => expect(record(body).error).toEqual(FIXTURE_FORBIDDEN),
    },
    {
      name: 'refuses a siteid other than the token site as forbidden',
      method: 'GET',
      url: `${FIXTURE}?siteid=${SITE_B}`,
      as: MANAGER,
      status: 403,
      verify: ({ body }) => expect(record(body).error).toEqual(FIXTURE_FORBIDDEN),
    },
    {
      name: 'refuses a system user outside the surveys.manager role group as forbidden',
      method: 'GET',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      as: 'system-user',
      status: 403,
    },
    {
      name: 'answers an unknown site as invalidParameters before the login check',
      method: 'GET',
      url: `${FIXTURE}?siteid=nowhere`,
      status: 400,
      verify: ({ body }) => expect(record(body).error).toEqual(INVALID_PARAMETERS),
    },
    {
      name: 'answers a method override the path does not dispatch on as notFound',
      method: 'GET',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      as: MANAGER,
      headers: { 'x-http-method-override': 'DELETE' },
      status: 404,
      verify: ({ body }) => expect(record(body).error).toEqual(FIXTURE_NOT_FOUND),
    },
  ],
  fixtureCreateSurvey: [
    {
      name: 'creates a DRAFT survey for the surveys manager',
      method: 'POST',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { title: 'Created survey' },
      status: 200,
      verify: ({ body, res }, ctx) => {
        expect(dataOf(body)).toMatchObject({ siteid: SITE_A, title: 'Created survey', status: 'DRAFT', schedule: {}, reminders: [] });
        expect(ctx.db.rows('survey')).toHaveLength(1);
        expect(res.headers['x-opt2-write-position']).toBeDefined();
      },
    },
    {
      name: 'answers a blank title as invalidParameters and writes nothing',
      method: 'POST',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { title: '  ' },
      status: 400,
      verify: ({ body }, ctx) => {
        expect(record(body).error).toEqual(INVALID_PARAMETERS);
        expect(ctx.db.rows('survey')).toEqual([]);
      },
    },
    {
      name: 'answers a CSRF token identity refuses as invalidTokens and writes nothing',
      method: 'POST',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { title: 'Refused survey' },
      setup: (ctx) => ctx.client.csrfValid(false),
      status: 400,
      verify: ({ body }, ctx) => {
        expect(record(body).error).toEqual({ code: 'invalid_request', message: 'Invalid CSRF tokens' });
        expect(ctx.db.rows('survey')).toEqual([]);
      },
    },
    {
      name: 'answers the legacy 503 while the survey unit is legacy-authoritative and writes nothing',
      method: 'POST',
      url: `${FIXTURE}?siteid=${SITE_A}`,
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { title: 'Gated survey' },
      setup: (ctx) => ctx.db.setGate(SURVEY_UNIT, 'legacy'),
      status: 503,
      verify: ({ body }, ctx) => {
        expect(record(body).error).toEqual(UNAVAILABLE);
        expect(ctx.db.rows('survey')).toEqual([]);
      },
    },
  ],
  fixtureGetSurvey: [
    {
      name: 'reads the seeded survey detail',
      method: 'GET',
      url: fixtureUrl(''),
      as: MANAGER,
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({ survey_id: surveyId, status: 'SCHEDULED', schedule: { schedule_version: 1 } });
        expect(dataOf(body).reminders).toHaveLength(1);
      },
    },
    {
      name: 'answers an unknown survey id as notFound',
      method: 'GET',
      url: `${FIXTURE}/${UNKNOWN_ID}?siteid=${SITE_A}`,
      as: MANAGER,
      status: 404,
      verify: ({ body }) => expect(record(body).error).toEqual(FIXTURE_NOT_FOUND),
    },
  ],
  fixtureScheduleSurvey: [
    {
      name: 'schedules the seeded survey with one reminder and announces the schedule',
      method: 'POST',
      url: fixtureUrl('/schedule'),
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { launchAt: LAUNCH_AT, reminders: [{ offsetMinutes: 60 }] },
      seed: 'draft',
      status: 200,
      verify: ({ body }, ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({
          status: 'SCHEDULED',
          schedule: { survey_id: surveyId, launch_at: LAUNCH_AT, schedule_version: 1, task_name: `opt2-survey-${surveyId}-launch` },
          reminders: [{ offset_minutes: 60, remind_at: '2026-07-01T10:00:00', task_name: `opt2-survey-${surveyId}-reminder-1` }],
        });
        expect(ctx.publisher.published.map(({ topic }) => topic)).toEqual(['surveys.survey.scheduled.v1']);
      },
    },
    {
      name: 'answers a schedule without launchAt as invalidParameters',
      method: 'POST',
      url: fixtureUrl('/schedule'),
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { reminders: [] },
      seed: 'draft',
      status: 400,
      verify: ({ body }) => expect(record(body).error).toEqual(INVALID_PARAMETERS),
    },
    {
      name: 'answers a reschedule of a launched survey as conflict',
      method: 'POST',
      url: fixtureUrl('/schedule'),
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { launchAt: LAUNCH_AT },
      seed: 'scheduled',
      setup: launchThroughCallback,
      status: 409,
      verify: ({ body }) => expect(record(body).error).toEqual({ code: 'invalid_request', message: 'Conflict' }),
    },
  ],
  fixtureBulkTargetSurvey: [
    {
      name: 'adds the distinct targets the survey lacks',
      method: 'POST',
      url: fixtureUrl('/targets/bulk'),
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: { targets: [{ siteID: SITE_B }, { siteID: SITE_B.toUpperCase() }] },
      seed: 'draft',
      status: 200,
      verify: ({ body }) => expect(dataOf(body)).toEqual({ inserted: 1, total: 1 }),
    },
    {
      name: 'answers a call without targets as invalidParameters',
      method: 'POST',
      url: fixtureUrl('/targets/bulk'),
      as: MANAGER,
      headers: CSRF_HEADERS,
      payload: {},
      seed: 'draft',
      status: 400,
      verify: ({ body }) => expect(record(body).error).toEqual(INVALID_PARAMETERS),
    },
  ],
  fixtureListSurveyResponses: [
    {
      name: 'lists the stored responses of the seeded survey',
      method: 'GET',
      url: fixtureUrl('/responses'),
      as: MANAGER,
      seed: 'draft',
      setup: respondThroughFixture,
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({ totalitems: 1, items: [{ survey_id: surveyId, answers: 'seeded answers' }] });
      },
    },
    {
      name: 'answers an unknown survey id as notFound',
      method: 'GET',
      url: `${FIXTURE}/${UNKNOWN_ID}/responses?siteid=${SITE_A}`,
      as: MANAGER,
      status: 404,
      verify: ({ body }) => expect(record(body).error).toEqual(FIXTURE_NOT_FOUND),
    },
  ],
  fixtureSubmitSurveyResponse: [
    {
      name: 'stores the answers of a tenant-a system user',
      method: 'POST',
      url: fixtureUrl('/responses'),
      as: 'system-user',
      headers: CSRF_HEADERS,
      payload: { answers: 'yes' },
      seed: 'draft',
      status: 200,
      verify: ({ body }, ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({ survey_id: surveyId, siteid: SITE_A, respondentsiteid: SITE_A, answers: 'yes' });
        expect(ctx.db.rows('survey_response')).toHaveLength(1);
      },
    },
    {
      name: 'answers empty answers as invalidParameters',
      method: 'POST',
      url: fixtureUrl('/responses'),
      as: 'system-user',
      headers: CSRF_HEADERS,
      payload: { answers: '' },
      seed: 'draft',
      status: 400,
      verify: ({ body }) => expect(record(body).error).toEqual(INVALID_PARAMETERS),
    },
    {
      name: 'refuses a respondent whose token is for another site as forbidden',
      method: 'POST',
      url: fixtureUrl('/responses', `siteid=${SITE_B}`),
      as: 'system-user',
      headers: CSRF_HEADERS,
      payload: { answers: 'elsewhere' },
      seed: 'draft',
      status: 403,
      verify: ({ body }) => expect(record(body).error).toEqual(FIXTURE_FORBIDDEN),
    },
  ],
  fixtureListSurveyTasks: [
    {
      name: 'lists the launch and reminder tasks communications holds',
      method: 'GET',
      url: fixtureUrl('/tasks'),
      as: MANAGER,
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(dataOf(body).items).toContainEqual(
          expect.objectContaining({ taskname: `opt2-survey-${surveyId}-launch`, kind: 'launch', offsetminutes: 0 }),
        );
      },
    },
    {
      name: 'answers the legacy 503 when communications is unreachable',
      method: 'GET',
      url: fixtureUrl('/tasks'),
      as: MANAGER,
      seed: 'scheduled',
      setup: (ctx) => ctx.client.unavailable(),
      status: 503,
      verify: ({ body }) => expect(record(body).error).toEqual(UNAVAILABLE),
    },
  ],
  fixtureLaunchCallback: [
    {
      name: 'launches the scheduled survey for a task run presenting its task token',
      method: 'GET',
      url: fixtureUrl('/launch', CALLBACK_QUERY),
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, ctx, seeded) => {
        expect(dataOf(body)).toMatchObject({ survey_id: seeded.surveyId, status: 'LAUNCHED' });
        expect(storedStatus(ctx, seeded)).toBe('LAUNCHED');
      },
    },
    {
      name: 'refuses a task run without the task token as forbidden and leaves the survey scheduled',
      method: 'GET',
      url: fixtureUrl('/launch'),
      seed: 'scheduled',
      status: 403,
      verify: ({ body }, ctx, seeded) => {
        expect(record(body).error).toEqual(FIXTURE_FORBIDDEN);
        expect(storedStatus(ctx, seeded)).toBe('SCHEDULED');
      },
    },
  ],
  fixtureLaunchCallbackPost: [
    {
      name: 'launches the scheduled survey for a POST task run presenting its task token',
      method: 'POST',
      url: fixtureUrl('/launch', CALLBACK_QUERY),
      payload: {},
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, ctx, seeded) => {
        expect(dataOf(body)).toMatchObject({ survey_id: seeded.surveyId, status: 'LAUNCHED' });
        expect(storedStatus(ctx, seeded)).toBe('LAUNCHED');
      },
    },
  ],
  fixtureRemindCallback: [
    {
      name: 'stamps the first reminder for a task run presenting its task token',
      method: 'GET',
      url: fixtureUrl('/remind', `${CALLBACK_QUERY}&reminder=1`),
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        const reminder = dataOf(body);
        expect(reminder).toMatchObject({ survey_id: surveyId, offset_minutes: 30, task_name: `opt2-survey-${surveyId}-reminder-1` });
        expect(reminder.sent_at).not.toBe('');
      },
    },
    {
      name: 'answers a reminder ordinal the survey lacks as notFound',
      method: 'GET',
      url: fixtureUrl('/remind', `${CALLBACK_QUERY}&reminder=2`),
      seed: 'scheduled',
      status: 404,
      verify: ({ body }) => expect(record(body).error).toEqual(FIXTURE_NOT_FOUND),
    },
    {
      name: 'answers a reminder ordinal below 1 as invalidParameters',
      method: 'GET',
      url: fixtureUrl('/remind', `${CALLBACK_QUERY}&reminder=0`),
      seed: 'scheduled',
      status: 400,
      verify: ({ body }) => expect(record(body).error).toEqual(INVALID_PARAMETERS),
    },
  ],
  fixtureRemindCallbackPost: [
    {
      name: 'stamps the reminder the POST body names for a task run presenting its task token',
      method: 'POST',
      url: fixtureUrl('/remind', CALLBACK_QUERY),
      payload: { reminder: 1 },
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({ survey_id: surveyId, task_name: `opt2-survey-${surveyId}-reminder-1` });
      },
    },
  ],
  listSurveys: [
    {
      name: 'lists the tenant-a surveys with their schedules for the surveys manager',
      method: 'GET',
      url: `/v1/surveys?siteid=${SITE_A}`,
      as: MANAGER,
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(record(body)).toMatchObject({ total: 1, data: [{ surveyId, siteId: SITE_A, status: 'SCHEDULED', schedule: { scheduleVersion: 1 } }] });
      },
    },
    {
      name: 'refuses an anonymous caller with the legacy 401 envelope',
      method: 'GET',
      url: `/v1/surveys?siteid=${SITE_A}`,
      status: 401,
      verify: ({ body }) => expect(record(body).error).toMatchObject({ code: 'invalid_request' }),
    },
    {
      name: 'refuses a system user without the surveys.manager role with the legacy 403',
      method: 'GET',
      url: `/v1/surveys?siteid=${SITE_A}`,
      as: 'system-user',
      status: 403,
    },
    {
      name: 'refuses a siteid other than the token site with the legacy 403',
      method: 'GET',
      url: `/v1/surveys?siteid=${SITE_B}`,
      as: MANAGER,
      status: 403,
    },
  ],
  getSurvey: [
    {
      name: 'reads the seeded survey with its schedule',
      method: 'GET',
      url: v1Url(),
      as: MANAGER,
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({
          surveyId,
          status: 'SCHEDULED',
          launchedAt: null,
          schedule: { launchTaskName: `opt2-survey-${surveyId}-launch`, reminders: [{ n: 1, offsetMinutes: 30, sentAt: null }] },
        });
      },
    },
    {
      name: 'answers an unknown survey id with 404',
      method: 'GET',
      url: `/v1/surveys/${UNKNOWN_ID}?siteid=${SITE_A}`,
      as: MANAGER,
      status: 404,
    },
  ],
  scheduleSurvey: [
    {
      name: 'schedules the seeded survey and announces the schedule version',
      method: 'POST',
      url: v1Url('/schedule'),
      as: MANAGER,
      payload: { launchAt: LAUNCH_AT, reminders: [{ offsetMinutes: 15 }, { offsetMinutes: 45 }] },
      seed: 'draft',
      status: 200,
      verify: ({ body }, ctx, { surveyId }) => {
        expect(dataOf(body)).toMatchObject({ surveyId, launchAt: `${LAUNCH_AT}.000`, scheduleVersion: 1 });
        expect(dataOf(body).reminders).toHaveLength(2);
        expect(ctx.publisher.published.map(({ topic }) => topic)).toEqual(['surveys.survey.scheduled.v1']);
      },
    },
    {
      name: 'answers a body outside ScheduleRequest as invalidParameters',
      method: 'POST',
      url: v1Url('/schedule'),
      as: MANAGER,
      payload: { launchAt: LAUNCH_AT, title: 'not a schedule field' },
      seed: 'draft',
      status: 400,
      verify: ({ body }) => expect(record(body).error).toMatchObject({ code: 'invalid_request' }),
    },
  ],
  listSurveyTargets: [
    {
      name: 'lists the seeded survey targets',
      method: 'GET',
      url: v1Url('/targets'),
      as: MANAGER,
      seed: 'draft',
      setup: async (ctx, seeded) => {
        const res = await ctx.app.inject({
          method: 'POST',
          url: v1Url('/targets/bulk')(seeded),
          headers: await subjectHeaders(MANAGER),
          payload: { targets: [{ siteId: SITE_B, groupName: 'Staff' }] },
        });
        expect(res.statusCode, res.body).toBe(200);
      },
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(record(body).data).toEqual([expect.objectContaining({ surveyId, siteId: SITE_B, groupName: 'Staff' })]);
      },
    },
  ],
  bulkTargetSurvey: [
    {
      name: 'adds the distinct targets the survey lacks',
      method: 'POST',
      url: v1Url('/targets/bulk'),
      as: MANAGER,
      payload: { targets: [{ siteId: SITE_B, groupName: null }, { siteId: SITE_B }] },
      seed: 'draft',
      status: 200,
      verify: ({ body }) => expect(dataOf(body)).toEqual({ inserted: 1, total: 1 }),
    },
  ],
  listSurveyResponses: [
    {
      name: 'lists the stored responses of the seeded survey',
      method: 'GET',
      url: v1Url('/responses'),
      as: MANAGER,
      seed: 'draft',
      setup: respondThroughFixture,
      status: 200,
      verify: ({ body }, _ctx, { surveyId }) => {
        expect(record(body)).toMatchObject({ total: 1, data: [{ surveyId, respondentSiteId: SITE_A, answers: 'seeded answers' }] });
      },
    },
  ],
  listSurveyTasks: [
    {
      name: 'lists the tasks of the current schedule version communications holds',
      method: 'GET',
      url: v1Url('/tasks'),
      as: MANAGER,
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, ctx) => {
        expect(record(body).data).not.toEqual([]);
        expect(ctx.client.requests.map(({ service }) => service)).toContain('communications');
      },
    },
    {
      name: 'answers the legacy 503 when communications is unreachable',
      method: 'GET',
      url: v1Url('/tasks'),
      as: MANAGER,
      seed: 'scheduled',
      setup: (ctx) => ctx.client.unavailable(),
      status: 503,
      verify: ({ body }) => expect(record(body).error).toEqual(UNAVAILABLE),
    },
  ],
  launchSurveyTask: [
    {
      name: 'launches the scheduled survey once for the tasks invoker',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/tasks/surveys/${surveyId}/launch`,
      as: 'service:tasks-invoker',
      payload: (seeded) => launchTask(seeded),
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, ctx, seeded) => {
        expect(record(body)).toEqual({ applied: true, status: 'LAUNCHED' });
        expect(storedStatus(ctx, seeded)).toBe('LAUNCHED');
      },
    },
    {
      name: 'answers a task naming a tenant the survey is not visible under as badRequest',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/tasks/surveys/${surveyId}/launch`,
      as: 'service:tasks-invoker',
      payload: (seeded) => launchTask(seeded, TENANT_B.tenantId),
      seed: 'scheduled',
      status: 400,
      verify: (_answer, ctx, seeded) => expect(storedStatus(ctx, seeded)).toBe('SCHEDULED'),
    },
    {
      name: 'refuses a service invocation credential on the cloud-tasks route before the handler',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/tasks/surveys/${surveyId}/launch`,
      headers: async () => ({ authorization: `Bearer ${await mintServiceToken({ caller: 'communications', audience: 'surveys' })}` }),
      payload: (seeded) => launchTask(seeded),
      seed: 'scheduled',
      status: 401,
      verify: (_answer, ctx, seeded) => expect(storedStatus(ctx, seeded)).toBe('SCHEDULED'),
    },
  ],
  markReminderSent: [
    {
      name: 'stamps the first reminder once for communications',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/surveys/${surveyId}/reminders/1/sent`,
      as: 'service:communications',
      payload: (seeded) => reminderSent(seeded),
      seed: 'scheduled',
      status: 200,
      verify: ({ body }, ctx) => {
        expect(record(body)).toEqual({ applied: true });
        expect(ctx.db.rows('survey_reminder').map((row) => row.sent_at)).not.toContain(null);
      },
    },
    {
      name: 'answers a reminder the survey lacks with the legacy 404',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/surveys/${surveyId}/reminders/2/sent`,
      as: 'service:communications',
      payload: (seeded) => reminderSent(seeded, 2),
      seed: 'scheduled',
      status: 404,
    },
    {
      name: 'answers a body without sentAt as invalidParameters',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/surveys/${surveyId}/reminders/1/sent`,
      as: 'service:communications',
      payload: (seeded) => ({ ...reminderSent(seeded), sentAt: undefined }),
      seed: 'scheduled',
      status: 400,
    },
    {
      name: 'refuses a tasks-invoker credential on the service route with the legacy 401',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/surveys/${surveyId}/reminders/1/sent`,
      headers: async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintTasksInvokerToken({ audience: 'surveys' })}` }),
      payload: (seeded) => reminderSent(seeded),
      seed: 'scheduled',
      status: 401,
      verify: (_answer, ctx) => expect(ctx.db.rows('survey_reminder').map((row) => row.sent_at)).toEqual([null]),
    },
    {
      name: 'refuses a service caller other than communications with the legacy 403',
      method: 'POST',
      url: ({ surveyId }) => `/internal/v1/surveys/${surveyId}/reminders/1/sent`,
      as: 'service:migration',
      payload: (seeded) => reminderSent(seeded),
      seed: 'scheduled',
      status: 403,
      verify: (_answer, ctx) => expect(ctx.db.rows('survey_reminder').map((row) => row.sent_at)).toEqual([null]),
    },
  ],
  migrationApply: [
    {
      name: 'applies a zero-row synthetic.survey batch for the migration service',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: { batchId: 'contract-1', origin: 'backfill', legacyTable: SURVEY_LEGACY_TABLE, siteId: SITE_A, columns: SURVEY_LEGACY_COLUMNS, rows: [] },
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ batchId: 'contract-1', duplicate: false, applied: 0, skipped: 0 }),
    },
    {
      name: 'answers a batch whose columns omit a mapped column as invalidParameters',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: {
        batchId: 'contract-2',
        origin: 'backfill',
        legacyTable: SURVEY_LEGACY_TABLE,
        siteId: SITE_A,
        columns: SURVEY_LEGACY_COLUMNS.slice(0, 1),
        rows: [],
      },
      status: 400,
    },
    {
      name: 'refuses the migration apply route to an s2 user with the legacy 403',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 's2',
      payload: { batchId: 'contract-3', origin: 'backfill', legacyTable: SURVEY_LEGACY_TABLE, siteId: SITE_A, columns: SURVEY_LEGACY_COLUMNS, rows: [] },
      status: 403,
    },
  ],
  migrationExport: [
    {
      name: 'exports the tenant-a surveys in canonical legacy form',
      method: 'GET',
      url: `/internal/v1/migration/export?unit=${SURVEY_UNIT}&siteId=${SITE_A}`,
      as: 'service:migration',
      seed: 'draft',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ unit: SURVEY_UNIT, tenantId: TENANT_A.tenantId }),
    },
    {
      name: 'answers an export without a unit as invalidParameters',
      method: 'GET',
      url: `/internal/v1/migration/export?siteId=${SITE_A}`,
      as: 'service:migration',
      status: 400,
    },
  ],
  migrationChanges: [
    {
      name: 'reads the tenant-a changelog after the start cursor',
      method: 'GET',
      url: `/internal/v1/migration/changes?siteId=${SITE_A}`,
      as: 'service:migration',
      seed: 'draft',
      status: 200,
      verify: ({ body }) => expect(Array.isArray(record(body).rows)).toBe(true),
    },
    {
      name: 'refuses a service credential addressed to another service with the legacy 401',
      method: 'GET',
      url: `/internal/v1/migration/changes?siteId=${SITE_A}`,
      headers: async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'migration', audience: 'people' })}` }),
      status: 401,
    },
  ],
  migrationPosition: [
    {
      name: 'reports the write position and drain counts of surveys',
      method: 'GET',
      url: '/internal/v1/migration/position',
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body).owner).toBe('surveys'),
    },
  ],
  migrationGetWatermark: [
    {
      name: 'lists the synthetic.survey forward watermarks',
      method: 'GET',
      url: `/internal/v1/migration/watermark?legacyTable=${SURVEY_LEGACY_TABLE}&direction=forward`,
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(body).toEqual([]),
    },
  ],
  migrationPutWatermark: [
    {
      name: 'records a forward synthetic.survey watermark',
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      as: 'service:migration',
      payload: { legacyTable: SURVEY_LEGACY_TABLE, direction: 'forward', snapshotSeq: 1, backupLsn: '42', finishedAt: '2026-06-30 12:00:00' },
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ legacyTable: SURVEY_LEGACY_TABLE, direction: 'forward' }),
    },
    {
      name: 'answers a watermark with an unknown direction as invalidParameters',
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      as: 'service:migration',
      payload: { legacyTable: SURVEY_LEGACY_TABLE, direction: 'sideways', finishedAt: '2026-06-30 12:00:00' },
      status: 400,
    },
  ],
  migrationGate: [
    {
      name: 'reads the survey unit gate',
      method: 'POST',
      url: '/internal/v1/migration/gate',
      as: 'service:migration',
      payload: { op: 'status', units: [SURVEY_UNIT] },
      status: 200,
      verify: ({ body }) => expect(record(body).units).toEqual([{ unit: SURVEY_UNIT, state: 'open', holderId: null, phase: 'quiet' }]),
    },
    {
      name: 'refuses to reopen a gate another holder closed as gate-conflict',
      method: 'POST',
      url: '/internal/v1/migration/gate',
      as: 'service:migration',
      payload: { op: 'open', units: [SURVEY_UNIT], holderId: 'contract-holder' },
      setup: (ctx) => ctx.db.setGate(SURVEY_UNIT, 'closed', 'quiet', 'other-holder'),
      status: 409,
      verify: ({ body }) => expect(record(body)).toEqual({ error: 'gate-conflict', units: [SURVEY_UNIT] }),
    },
  ],
  outboxSweep: [
    {
      name: 'creates the next sweep task, then sweeps every registered tenant',
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      as: 'service:tasks-invoker',
      payload: SWEEP_TASK,
      status: 200,
      verify: ({ body }, ctx) => {
        expect(record(body)).toMatchObject({ failed: 0, tenants: registryPayloads().length });
        expect(ctx.taskPort.tasks.filter(({ queue }) => queue === SWEEP_QUEUE).length).toBeGreaterThan(1);
      },
    },
    {
      name: 'refuses a user token on the cloud-tasks sweep route before the handler',
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      as: MANAGER,
      payload: SWEEP_TASK,
      status: 401,
      verify: (_answer, ctx) => expect(ctx.taskPort.tasks.filter(({ queue }) => queue === SWEEP_QUEUE)).toHaveLength(1),
    },
  ],
  consumeSiteChanged: [
    {
      name: 'applies a newer site.changed delivery to the tenant registry and acks it',
      method: 'POST',
      url: PUSH_PATH,
      push: siteChangedEnvelope,
      status: 204,
      verify: (_answer, ctx) => {
        expect(ctx.db.rows('tenant_registry').find((row) => row.site_id === SITE_A)).toMatchObject({ domains: CHANGED_DOMAINS });
        expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toEqual([]);
      },
    },
    {
      name: 'dead-letters and acks a delivery without a tenant',
      method: 'POST',
      url: PUSH_PATH,
      push: () => withoutTenant(siteChangedEnvelope()),
      status: 204,
      verify: (_answer, ctx) => expect(ctx.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toHaveLength(1),
    },
  ],
  pauseTaskQueue: [
    {
      name: 'pauses the outbox-sweep queue for the operator',
      method: 'POST',
      url: `/internal/v1/task-queues/${SWEEP_QUEUE}/pause`,
      as: 'service:operator',
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ queue: SWEEP_QUEUE, service: 'surveys', paused: true }),
    },
    {
      name: 'answers a queue surveys does not create tasks on as invalidParameters',
      method: 'POST',
      url: `/internal/v1/task-queues/${LAUNCH_QUEUE}/pause`,
      as: 'service:operator',
      status: 400,
    },
  ],
  resumeTaskQueue: [
    {
      name: 'resumes the outbox-sweep queue for the migration service',
      method: 'POST',
      url: `/internal/v1/task-queues/${SWEEP_QUEUE}/resume`,
      as: 'service:migration',
      status: 200,
      verify: ({ body }) => expect(record(body)).toEqual({ queue: SWEEP_QUEUE, service: 'surveys', paused: false }),
    },
  ],
  ensureTaskQueue: [
    {
      name: 'finds the live outbox-sweep chain task for the operator',
      method: 'POST',
      url: `/internal/v1/task-queues/${SWEEP_QUEUE}/ensure`,
      as: 'service:operator',
      status: 200,
      verify: ({ body }) => expect(record(body)).toMatchObject({ queue: SWEEP_QUEUE, ensured: { created: false, reason: 'live' } }),
    },
  ],
  healthz: [
    {
      name: 'answers the liveness probe anonymously',
      method: 'GET',
      url: '/healthz',
      status: 200,
      verify: ({ body }) => expect(body).toEqual({ status: 'ok' }),
    },
  ],
};

/** Route families of surveys and the declaration every route of the family carries. */
const FAMILIES: ReadonlyArray<{ family: string; prefix: string; count: number; declaration: Omit<Declaration, 'siteCheck'> }> = [
  { family: 'fixture', prefix: FIXTURE, count: 12, declaration: { transport: 'service', requires: [], public: true } },
  { family: '/v1/surveys', prefix: '/v1/surveys', count: 7, declaration: { transport: 'service', requires: [MANAGER], public: false } },
  {
    family: 'launch task',
    prefix: '/internal/v1/tasks/surveys/',
    count: 1,
    declaration: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'], public: false },
  },
  {
    family: 'reminder-sent callback',
    prefix: '/internal/v1/surveys/',
    count: 1,
    declaration: { transport: 'service', requires: ['service:communications'], public: false },
  },
  {
    family: 'migration-kit',
    prefix: '/internal/v1/migration/',
    count: 7,
    declaration: { transport: 'service', requires: ['platform.migration'], public: false },
  },
  {
    family: 'outbox sweep',
    prefix: '/internal/v1/outbox/sweep',
    count: 1,
    declaration: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'], public: false },
  },
  {
    family: 'task-queue control',
    prefix: '/internal/v1/task-queues/',
    count: 3,
    declaration: { transport: 'service', requires: ['platform.migration', 'platform.operator'], public: false },
  },
  {
    family: 'site.changed push',
    prefix: PUSH_PATH,
    count: 1,
    declaration: { transport: 'pubsub-push', requires: ['service:pubsub-invoker'], public: false },
  },
  { family: 'health', prefix: '/healthz', count: 1, declaration: { transport: 'service', requires: [], public: true } },
];

describe('contract document', () => {
  it('is OpenAPI 3.1.0 version 1.0.0 at the pinned source SHA', () => {
    expect(DOC.openapi).toBe('3.1.0');
    expect(DOC.info.version).toBe('1.0.0');
    expect(DOC.info['x-source-sha']).toBe(PIN.sha);
  });

  it('gives every operation a unique operationId', () => {
    const ids = contractOperations(DOC).map(({ operationId }) => operationId);
    expect(ids.filter((id) => typeof id !== 'string' || id === '')).toEqual([]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });
});

describe('route declarations', () => {
  let ctx: TestApp;
  let routes: RouteMatrixEntry[];

  beforeAll(async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();
    routes = collectRouteMatrix(ctx.app).routes;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('registers exactly the contract operations', () => {
    const { undeclared, unregistered } = diffRouteSets(routes, contractOperations(DOC));
    expect(undeclared, 'registered but undeclared in contracts/openapi.yaml').toEqual([]);
    expect(unregistered, 'declared in contracts/openapi.yaml but unregistered').toEqual([]);
  });

  it("declares each route with its operation's roles, public flag, transport and site check", () => {
    expect(declarationMismatches(routes, contractOperations(DOC))).toEqual([]);
  });

  it.each(FAMILIES)('serves the $family family under one declaration', ({ prefix, count, declaration }) => {
    const family = routes.filter((route) => route.url.startsWith(prefix));
    expect(family).toHaveLength(count);
    for (const route of family) {
      expect(routeDeclaration(route), routeKey(route)).toMatchObject({ ...declaration, requires: [...declaration.requires].sort() });
    }
  });

  it('assigns every route to exactly one family', () => {
    expect(FAMILIES.reduce((sum, { count }) => sum + count, 0)).toBe(routes.length);
  });

  it('names the drifting route when an operation, a route or a role differs', () => {
    const trimmed = structuredClone(DOC);
    delete (trimmed.paths['/healthz'] as Record<string, unknown>).get;
    expect(diffRouteSets(routes, contractOperations(trimmed))).toEqual({ undeclared: ['GET /healthz'], unregistered: [] });

    const withoutHealth = routes.filter((route) => route.url !== '/healthz');
    expect(diffRouteSets(withoutHealth, contractOperations(DOC))).toEqual({ undeclared: [], unregistered: ['GET /healthz'] });

    const extra: RouteMatrixEntry = { method: 'GET', url: '/v1/surveys/:surveyId/extra', transport: 'service', requires: [MANAGER], siteCheck: true };
    expect(diffRouteSets([...routes, extra], contractOperations(DOC))).toEqual({
      undeclared: ['GET /v1/surveys/{surveyId}/extra'],
      unregistered: [],
    });

    const relabelled = structuredClone(DOC);
    (relabelled.paths['/v1/surveys'] as Record<string, OperationObject>).get = {
      ...((relabelled.paths['/v1/surveys'] as Record<string, OperationObject>).get as OperationObject),
      'x-opt2-requires': ['s2'],
    };
    expect(declarationMismatches(routes, contractOperations(relabelled))).toEqual([expect.stringMatching(/^GET \/v1\/surveys: /)]);
  });
});

describe('responses', () => {
  it('cover every contract operation with at least one case and a 2xx answer', () => {
    const ids = contractOperations(DOC).map(({ operationId }) => operationId ?? '');
    expect(Object.keys(CASES).sort()).toEqual([...ids].sort());
    const withoutSuccess = Object.entries(CASES).filter(([, cases]) => !cases.some(({ status }) => status >= 200 && status < 300));
    expect(withoutSuccess.map(([id]) => id)).toEqual([]);
  });

  let ctx: TestApp | undefined;

  afterEach(async () => {
    await ctx?.app.close();
    ctx = undefined;
  });

  const rows = Object.entries(CASES).flatMap(([operationId, cases]) => cases.map((c) => ({ operationId, title: `${c.name} (${String(c.status)})`, c })));

  it.each(rows)('$operationId $title', async ({ c }) => {
    const built = await buildTestApp();
    ctx = built;
    const seeded = await seedSurvey(built, c.seed ?? 'none');
    await c.setup?.(built, seeded);
    const answer = await sendCase(built, c, seeded);
    c.verify?.(answer, built, seeded);
  });
});
