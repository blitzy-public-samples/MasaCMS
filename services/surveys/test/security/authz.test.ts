// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** In-process authorisation matrix of every surveys route: admitted subjects, denial envelopes, site and transport boundaries, deny by default. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  type Opt2RouteConfig,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, type EventEnvelope } from '@opt2/platform/events';
import { LEGACY_ERROR_MAP } from '@opt2/platform/legacy-compat';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TEST_PUSH_KEY,
  createCapturingPublisher,
  mintServiceToken,
  mintTasksInvokerToken,
  pushKeyQuery,
  pushTo,
  registryPayloads,
  testEnvelope,
  testVerifier,
  writeTestSecrets,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/fixture-envelope.js';
import { UNITS } from '../../src/repo/tables.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { LAUNCH_TASK_PATH } from '../../src/tasks/launch.js';
import {
  STATE_DIR_PREFIX,
  TEST_CLOCK,
  buildTestApp,
  createFakeTaskPort,
  createRecordingDb,
  headersFor,
  testEnv,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';

const SERVICE = 'surveys';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;

// Subject names of ROLE_SET, written out so every expectation below is literal.
const SYNTHETIC = [
  'timesheets.employee',
  'timesheets.primary-approver',
  'timesheets.secondary-approver',
  'finance.preparer',
  'finance.approver',
  'esignature.signer',
  'esignature.auditor',
  'reporting.exporter',
  'surveys.manager',
  'communications.sender',
] as const;

/** User subjects whose token names tenant-a, the site under test. */
const SITE_USERS = ['member', 'system-user', 'editor', 'site-admin', 's2', ...SYNTHETIC] as const;

const WORKLOADS = [
  'service:identity',
  'service:people',
  'service:programs-sites',
  'service:strategies-content',
  'service:communications',
  'service:reporting',
  'service:surveys',
  'service:timesheets',
  'service:finance',
  'service:e-signature',
  'service:stub',
  'service:gateway',
  'service:web',
  'service:migration',
  'service:operator',
  'service:pubsub-invoker',
  'service:tasks-invoker',
] as const;

const EVERYONE: readonly string[] = ['anonymous', ...SITE_USERS, 'other-tenant', ...WORKLOADS];

/** EVERYONE without `excluded`. */
function everyoneBut(...excluded: string[]): string[] {
  return EVERYONE.filter((name) => !excluded.includes(name));
}

/** Subjects that present no user token: auth.cfc requireLogin and a user-role `requires` answer them 401. */
const NO_USER: readonly string[] = ['anonymous', ...WORKLOADS];

/** Subjects that present no invocation credential on the service transport. */
const NO_INVOCATION: readonly string[] = ['anonymous', 'service:tasks-invoker', 'service:pubsub-invoker'];

/** One concrete request; each subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: 'GET' | 'POST';
  url: string;
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface Declared {
  transport: Transport;
  requires?: readonly string[];
  public?: true;
  /** `false` where the handler checks the site itself. */
  siteCheck?: false;
}

interface Expectation {
  declared: Declared;
  request: ProbeRequest;
  /** Subjects admitted: any status but 401, 403 and 5xx. */
  allow: readonly string[];
  /** Denied subjects answered 401; every other denied subject is answered 403. */
  deny401: readonly string[];
  /** Sends the probe as `subject` instead of injecting `request` with its credentials. */
  send?: (subject: RoleSubject, credentials: Record<string, string>) => Promise<InjectResponse>;
}

const SURVEY_ID = '5A17E000-0000-4000-8000000000000001';
const LAUNCH_TASK_NAME = `opt2-survey-${SURVEY_ID}-launch`;
const REMINDER_TASK_NAME = `opt2-survey-${SURVEY_ID}-reminder-1`;
// No probe carries a task token, so the stored hashes only need to exist.
const UNMATCHED_TOKEN_HASH = '0'.repeat(64);
const SWEEP_QUEUE = 'surveys-outbox-sweep';
const PUSH_URL = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const ON_SITE_A = `siteid=${SITE_A}`;
const FIXTURE_SURVEY = `${FIXTURE_BASE}/${SURVEY_ID}`;
const V1_SURVEY = `/v1/surveys/${SURVEY_ID}`;
// The client recorder answers identity's CSRF consume with valid: true, so admitted fixture writes reach their handlers.
const CSRF_HEADERS = { 'x-csrf_token': 'authz-probe-token', 'x-csrf_token_expires': '260630120000000' } as const;
const LAUNCH_AT = '2026-07-01T09:00:00';

const FIXTURE_ROUTE: Declared = { transport: 'service', public: true, siteCheck: false };
const MANAGER_ROUTE: Declared = { transport: 'service', requires: ['surveys.manager'] };
const TASK_ROUTE: Declared = { transport: 'cloud-tasks', requires: ['service:tasks-invoker'] };

/** A fixture route of auth.cfc requireAny('surveys.manager'), which grants no S2 bypass. */
function fixtureManagerRoute(request: ProbeRequest): Expectation {
  return { declared: FIXTURE_ROUTE, request, allow: ['surveys.manager'], deny401: NO_USER };
}

/** A fixture ACF task callback: only a task token admits, and no subject carries one. */
function fixtureCallback(request: ProbeRequest): Expectation {
  // A tasks-invoker token in Authorization is verified, and refused, as a user token before the handler runs.
  return { declared: FIXTURE_ROUTE, request, allow: [], deny401: ['service:tasks-invoker'] };
}

/** A `/v1/surveys` route for surveys.manager alone. */
function managerRoute(request: ProbeRequest): Expectation {
  return { declared: MANAGER_ROUTE, request, allow: ['surveys.manager'], deny401: NO_USER };
}

/** A migration-kit route for the migration workload alone. */
function migrationRoute(request: ProbeRequest): Expectation {
  return {
    declared: { transport: 'service', requires: ['platform.migration'] },
    request,
    allow: ['service:migration'],
    deny401: NO_INVOCATION,
  };
}

/** A queue-control route on this service's own outbox sweep queue. */
function queueControl(op: 'pause' | 'resume' | 'ensure'): Expectation {
  return {
    declared: { transport: 'service', requires: ['platform.migration', 'platform.operator'] },
    request: { method: 'POST', url: `/internal/v1/task-queues/${SWEEP_QUEUE}/${op}` },
    allow: ['service:migration', 'service:operator'],
    deny401: NO_INVOCATION,
  };
}

/** A managed Cloud Tasks route for the tasks invoker alone. */
function taskRoute(request: ProbeRequest): Expectation {
  return { declared: TASK_ROUTE, request, allow: ['service:tasks-invoker'], deny401: everyoneBut('service:tasks-invoker') };
}

const SCHEDULE_BODY = { launchAt: LAUNCH_AT, reminders: [{ offsetMinutes: 60 }] };

const FIXTURE_LIST: ProbeRequest = { method: 'GET', url: `${FIXTURE_BASE}?${ON_SITE_A}` };
const FIXTURE_SCHEDULE: ProbeRequest = {
  method: 'POST',
  url: `${FIXTURE_SURVEY}/schedule?${ON_SITE_A}`,
  headers: CSRF_HEADERS,
  payload: SCHEDULE_BODY,
};
const V1_LIST: ProbeRequest = { method: 'GET', url: `/v1/surveys?${ON_SITE_A}` };
const V1_SCHEDULE: ProbeRequest = { method: 'POST', url: `${V1_SURVEY}/schedule?${ON_SITE_A}`, headers: CSRF_HEADERS, payload: SCHEDULE_BODY };
const V1_BULK_TARGET: ProbeRequest = {
  method: 'POST',
  url: `${V1_SURVEY}/targets/bulk?${ON_SITE_A}`,
  headers: CSRF_HEADERS,
  payload: { targets: [{ siteId: SITE_B }] },
};
const MIGRATION_POSITION: ProbeRequest = { method: 'GET', url: '/internal/v1/migration/position' };
const LAUNCH_TASK: ProbeRequest = {
  method: 'POST',
  url: LAUNCH_TASK_PATH.replace(':surveyId', SURVEY_ID),
  payload: {
    queue: 'surveys-launch',
    name: LAUNCH_TASK_NAME,
    tenantId: TENANT_A.tenantId,
    payload: { surveyId: SURVEY_ID, siteId: SITE_A, scheduleVersion: 1 },
  },
};
const SWEEP: ProbeRequest = {
  method: 'POST',
  url: '/internal/v1/outbox/sweep',
  payload: { queue: SWEEP_QUEUE, name: `${SWEEP_QUEUE}-authz-probe`, tenantId: null, payload: null },
};

let t: TestApp;
let matrix: RouteMatrix;

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

/** A contract-valid `programs-sites.site.changed.v1` envelope of tenant-a, its payload the fixture registry's. */
function siteChangedEnvelope(): EventEnvelope {
  const payload = registryPayloads().find((candidate) => candidate.siteId === SITE_A);
  if (payload === undefined) throw new TypeError(`registryPayloads has no ${SITE_A} payload`);
  return testEnvelope({ topic: 'programs-sites.site.changed.v1', tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload });
}

/** The site.changed push as Pub/Sub sends it, without the push key in the URL. */
function pushWithoutKey(): ProbeRequest {
  const envelope = siteChangedEnvelope();
  const body = buildPushBody({ data: encodeEnvelope(envelope), messageId: randomUUID(), subscription: SITE_CHANGED_SUBSCRIPTION });
  return { method: 'POST', url: PUSH_URL, payload: { ...body } };
}

/** Delivers the site.changed push as `subject`: the invoker through the local push key, everyone else with only its own credentials. */
function sendPush(subject: RoleSubject, credentials: Record<string, string>): Promise<InjectResponse> {
  if (subject.name === PUBSUB_INVOKER_ROLE) return pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope());
  return inject(pushWithoutKey(), credentials);
}

/** `request` with the local push key added to its query. */
function withPushKey(request: ProbeRequest, key: string = TEST_PUSH_KEY): ProbeRequest {
  return { ...request, url: `${request.url}${request.url.includes('?') ? '&' : '?'}${pushKeyQuery(key)}` };
}

/** Every registered route, keyed `<METHOD> <fastify url>`, with its declaration, tenant-a probe and admitted subjects. */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  'GET /healthz': {
    declared: { transport: 'service', public: true },
    request: { method: 'GET', url: '/healthz' },
    // A tasks-invoker token in Authorization is verified, and refused, as a user token.
    allow: everyoneBut('service:tasks-invoker'),
    deny401: ['service:tasks-invoker'],
  },
  'POST /internal/v1/events/surveys.programs-sites.site.changed.v1': {
    declared: { transport: 'pubsub-push', requires: ['service:pubsub-invoker'] },
    request: { method: 'POST', url: PUSH_URL },
    allow: ['service:pubsub-invoker'],
    deny401: everyoneBut('service:pubsub-invoker'),
    send: sendPush,
  },
  'POST /internal/v1/migration/apply': migrationRoute({ method: 'POST', url: '/internal/v1/migration/apply', payload: {} }),
  'GET /internal/v1/migration/changes': migrationRoute({
    method: 'GET',
    url: `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`,
  }),
  'GET /internal/v1/migration/export': migrationRoute({
    method: 'GET',
    url: `/internal/v1/migration/export?unit=surveys.survey&tenantId=${TENANT_A.tenantId}`,
  }),
  'POST /internal/v1/migration/gate': migrationRoute({ method: 'POST', url: '/internal/v1/migration/gate', payload: {} }),
  'GET /internal/v1/migration/position': migrationRoute(MIGRATION_POSITION),
  'GET /internal/v1/migration/watermark': migrationRoute({ method: 'GET', url: '/internal/v1/migration/watermark' }),
  'POST /internal/v1/migration/watermark': migrationRoute({ method: 'POST', url: '/internal/v1/migration/watermark', payload: {} }),
  'POST /internal/v1/outbox/sweep': taskRoute(SWEEP),
  'POST /internal/v1/surveys/:surveyId/reminders/:n/sent': {
    declared: { transport: 'service', requires: ['service:communications'] },
    request: {
      method: 'POST',
      url: `/internal/v1/surveys/${SURVEY_ID}/reminders/1/sent`,
      payload: {
        tenantId: TENANT_A.tenantId,
        siteId: SITE_A,
        taskName: REMINDER_TASK_NAME,
        scheduleVersion: 1,
        sentAt: '2026-07-01T10:00:00.000',
      },
    },
    allow: ['service:communications'],
    deny401: NO_INVOCATION,
  },
  'POST /internal/v1/task-queues/:queue/ensure': queueControl('ensure'),
  'POST /internal/v1/task-queues/:queue/pause': queueControl('pause'),
  'POST /internal/v1/task-queues/:queue/resume': queueControl('resume'),
  'POST /internal/v1/tasks/surveys/:surveyId/launch': taskRoute(LAUNCH_TASK),
  'GET /legacy-fixtures/cfml/api.cfm/surveys/surveys': fixtureManagerRoute(FIXTURE_LIST),
  'POST /legacy-fixtures/cfml/api.cfm/surveys/surveys': fixtureManagerRoute({
    method: 'POST',
    url: `${FIXTURE_BASE}?${ON_SITE_A}`,
    headers: CSRF_HEADERS,
    payload: { title: 'Authz probe survey' },
  }),
  'GET /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id': fixtureManagerRoute({ method: 'GET', url: `${FIXTURE_SURVEY}?${ON_SITE_A}` }),
  'GET /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/launch': fixtureCallback({
    method: 'GET',
    url: `${FIXTURE_SURVEY}/launch?${ON_SITE_A}`,
  }),
  'POST /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/launch': fixtureCallback({
    method: 'POST',
    url: `${FIXTURE_SURVEY}/launch?${ON_SITE_A}`,
  }),
  'GET /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/remind': fixtureCallback({
    method: 'GET',
    url: `${FIXTURE_SURVEY}/remind?${ON_SITE_A}&reminder=1`,
  }),
  'POST /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/remind': fixtureCallback({
    method: 'POST',
    url: `${FIXTURE_SURVEY}/remind?${ON_SITE_A}&reminder=1`,
  }),
  'GET /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/responses': fixtureManagerRoute({
    method: 'GET',
    url: `${FIXTURE_SURVEY}/responses?${ON_SITE_A}`,
  }),
  // surveys.cfc createResponse: any logged-in member of the request site, then its CSRF token.
  'POST /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/responses': {
    declared: FIXTURE_ROUTE,
    request: {
      method: 'POST',
      url: `${FIXTURE_SURVEY}/responses?${ON_SITE_A}`,
      headers: CSRF_HEADERS,
      payload: { answers: '{"q1":"yes"}' },
    },
    allow: SITE_USERS,
    deny401: NO_USER,
  },
  'POST /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/schedule': fixtureManagerRoute(FIXTURE_SCHEDULE),
  'POST /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/targets/bulk': fixtureManagerRoute({
    method: 'POST',
    url: `${FIXTURE_SURVEY}/targets/bulk?${ON_SITE_A}`,
    headers: CSRF_HEADERS,
    payload: { targets: [{ siteID: SITE_B }] },
  }),
  'GET /legacy-fixtures/cfml/api.cfm/surveys/surveys/:id/tasks': fixtureManagerRoute({
    method: 'GET',
    url: `${FIXTURE_SURVEY}/tasks?${ON_SITE_A}`,
  }),
  // The contract declares no /v1 create or answer: surveys are created and answered through the fixture routes.
  'GET /v1/surveys': managerRoute(V1_LIST),
  'GET /v1/surveys/:surveyId': managerRoute({ method: 'GET', url: `${V1_SURVEY}?${ON_SITE_A}` }),
  'GET /v1/surveys/:surveyId/responses': managerRoute({ method: 'GET', url: `${V1_SURVEY}/responses?${ON_SITE_A}` }),
  'POST /v1/surveys/:surveyId/schedule': managerRoute(V1_SCHEDULE),
  'GET /v1/surveys/:surveyId/targets': managerRoute({ method: 'GET', url: `${V1_SURVEY}/targets?${ON_SITE_A}` }),
  'POST /v1/surveys/:surveyId/targets/bulk': managerRoute(V1_BULK_TARGET),
  'GET /v1/surveys/:surveyId/tasks': managerRoute({ method: 'GET', url: `${V1_SURVEY}/tasks?${ON_SITE_A}` }),
};

/** Request effects counted from a {@link mark}. */
interface Effects {
  transactions: number;
  /** Write statements of the transactions run since the mark. */
  writes: string[];
  tasks: number;
  calls: number;
  published: number;
}

interface Mark {
  transactions: number;
  tasks: number;
  calls: number;
  published: number;
}

const NO_EFFECTS: Effects = { transactions: 0, writes: [], tasks: 0, calls: 0, published: 0 };

const WRITE_STATEMENT = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\S+(?:\s+AS\s+\S+)?\s+SET)\b/i;

function mark(): Mark {
  return {
    transactions: t.db.transactions.length,
    tasks: t.taskPort.tasks.length,
    calls: t.client.requests.length,
    published: t.publisher.published.length + t.publisher.raw.length,
  };
}

function effectsSince(from: Mark): Effects {
  const transactions = t.db.transactions.slice(from.transactions);
  return {
    transactions: transactions.length,
    writes: transactions.flatMap((tx) => tx.statements.map((statement) => statement.text).filter((text) => WRITE_STATEMENT.test(text))),
    tasks: t.taskPort.tasks.length - from.tasks,
    calls: t.client.requests.length - from.calls,
    published: t.publisher.published.length + t.publisher.raw.length - from.published,
  };
}

/** Effects a refused request may leave: a fixture route's own site and survey reads, nothing else. */
function deniedEffects(declared: Declared, effects: Effects): Effects {
  return declared.public === true ? { ...NO_EFFECTS, transactions: effects.transactions } : NO_EFFECTS;
}

interface ErrorBody {
  code: string;
  message: string;
}

function errorBody({ code, message }: ErrorBody): ErrorBody {
  return { code, message };
}

/** Error bodies a refusal may carry: the platform's legacy JSON API rows, or the fixture's own forbidden row. */
const DENIAL_ERRORS: Readonly<Record<401 | 403, readonly ErrorBody[]>> = {
  401: [LEGACY_ERROR_MAP.authorization, LEGACY_ERROR_MAP.invalidAccessToken, LEGACY_ERROR_MAP.accessTokenExpired].map(errorBody),
  403: [FIXTURE_ERROR_MAP.forbidden, LEGACY_ERROR_MAP.authorization].map(errorBody),
};

/** The `error` object of a legacy envelope response, or undefined when the body is not one. */
function errorOf(res: InjectResponse): ErrorBody | undefined {
  let body: unknown;
  try {
    body = JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: unknown };
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : undefined;
}

/** Every way one probe sent as one subject departs from its expectation. */
async function mismatchesOf(key: string, entry: Expectation, subject: RoleSubject): Promise<string[]> {
  const credentials = await headersFor(subject, { site: SITE_A });
  const before = mark();
  const res = entry.send === undefined ? await inject(entry.request, credentials) : await entry.send(subject, credentials);
  const at = `${key} as ${subject.name}`;
  const admitted = res.statusCode !== 401 && res.statusCode !== 403;
  const shouldAdmit = entry.allow.includes(subject.name);
  if (admitted !== shouldAdmit) {
    return [`${at}: expected ${shouldAdmit ? 'admission' : 'denial'}, got ${res.statusCode} ${res.body.slice(0, 200)}`];
  }
  if (admitted) return res.statusCode >= 500 ? [`${at}: admitted request failed with ${res.statusCode} ${res.body.slice(0, 200)}`] : [];

  const problems: string[] = [];
  const status = entry.deny401.includes(subject.name) ? 401 : 403;
  if (res.statusCode !== status) problems.push(`${at}: expected ${status}, got ${res.statusCode} ${res.body.slice(0, 200)}`);
  const error = errorOf(res);
  if (error === undefined) {
    problems.push(`${at}: denial is not a legacy error envelope: ${res.body.slice(0, 200)}`);
  } else if (!DENIAL_ERRORS[res.statusCode as 401 | 403].some((allowed) => isDeepStrictEqual(allowed, error))) {
    problems.push(`${at}: unexpected denial error ${JSON.stringify(error)}`);
  }
  const effects = effectsSince(before);
  if (!isDeepStrictEqual(effects, deniedEffects(entry.declared, effects))) {
    problems.push(`${at}: denial left effects ${JSON.stringify(effects)}`);
  }
  return problems;
}

/** Status, error body and effects of `request` sent with `credentials`. */
async function outcomeOf(
  request: ProbeRequest,
  credentials: Record<string, string>,
): Promise<{ status: number; error: ErrorBody | undefined; effects: Effects }> {
  const before = mark();
  const res = await inject(request, credentials);
  return { status: res.statusCode, error: errorOf(res), effects: effectsSince(before) };
}

/** `<METHOD> <url>` of a route. */
function keyOf(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

/** A declaration in comparable form: `requires` sorted, defaults dropped. */
function comparable(declared: Declared | RouteMatrixEntry): Record<string, unknown> {
  return {
    transport: declared.transport,
    ...(declared.requires === undefined ? {} : { requires: [...declared.requires].sort() }),
    ...(declared.public === true ? { public: true } : {}),
    ...(declared.siteCheck === false ? { siteCheck: false } : {}),
    ...('edge' in declared && declared.edge === true ? { edge: true } : {}),
  };
}

/** The seeded database: tenant-a's survey with its launch schedule and reminder 1, every unit gate open. */
function seededDb(): RecordingDb {
  const created = TEST_CLOCK.now();
  const launchAt = new Date(created.getTime() + 24 * 60 * 60 * 1000);
  const tenant = { tenant_id: TENANT_A.tenantId, survey_id: SURVEY_ID };
  return createRecordingDb({
    clock: TEST_CLOCK,
    gates: Object.fromEntries(UNITS.map((unit) => [unit, { state: 'open' as const }])),
    rows: {
      survey: [
        {
          ...tenant,
          siteid: SITE_A,
          title: 'Authz probe survey',
          status: 'SCHEDULED',
          created,
          createdbyid: '5A17E000-0000-4000-8000000000000002',
        },
      ],
      survey_schedule: [
        {
          ...tenant,
          schedule_id: '5A17E000-0000-4000-8000000000000003',
          launch_at: launchAt,
          schedule_version: 1,
          task_name: LAUNCH_TASK_NAME,
          task_token_hash: UNMATCHED_TOKEN_HASH,
          created,
          row_version: 1,
        },
      ],
      survey_reminder: [
        {
          ...tenant,
          reminder_id: '5A17E000-0000-4000-8000000000000004',
          offset_minutes: 60,
          remind_at: new Date(launchAt.getTime() + 60 * 60 * 1000),
          task_name: REMINDER_TASK_NAME,
          task_token_hash: UNMATCHED_TOKEN_HASH,
          sent_at: null,
        },
      ],
    },
  });
}

beforeAll(async () => {
  t = await buildTestApp({ db: seededDb() });
  matrix = collectRouteMatrix(t.app);
});

afterAll(async () => {
  await t?.app.close();
});

describe('route declarations', () => {
  it('lists every registered route exactly once in the expectations', () => {
    const registered = matrix.routes.map(keyOf);
    const expected = Object.keys(EXPECTED);
    expect({
      missing: registered.filter((key) => !expected.includes(key)),
      extra: expected.filter((key) => !registered.includes(key)),
      duplicated: registered.filter((key, index) => registered.indexOf(key) !== index),
    }).toEqual({ missing: [], extra: [], duplicated: [] });
  });

  it('declares each route with its expected transport, roles, public flag and site check', () => {
    const actual = Object.fromEntries(matrix.routes.map((route) => [keyOf(route), comparable(route)]));
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([key, entry]) => [key, comparable(entry.declared)]));
    expect(actual).toEqual(expected);
  });

  it('probes exactly the ROLE_SET subjects', () => {
    expect(ROLE_SET.map((subject) => subject.name).sort()).toEqual([...EVERYONE].sort());
  });

  it('names only ROLE_SET subjects, and never one both admitted and answered 401', () => {
    const named = Object.values(EXPECTED).flatMap((entry) => [...entry.allow, ...entry.deny401]);
    const overlapping = Object.entries(EXPECTED).flatMap(([key, entry]) =>
      entry.allow.filter((name) => entry.deny401.includes(name)).map((name) => `${key}: ${name}`),
    );
    expect({ unknown: named.filter((name) => !EVERYONE.includes(name)), overlapping }).toEqual({ unknown: [], overlapping: [] });
  });
});

describe('route admission', () => {
  for (const [key, entry] of Object.entries(EXPECTED)) {
    it(`admits exactly the expected subjects on ${key}, and denials leave no effect`, async () => {
      const mismatches: string[] = [];
      for (const subject of ROLE_SET) mismatches.push(...(await mismatchesOf(key, entry, subject)));
      expect(mismatches).toEqual([]);
    });
  }
});

describe('managed credentials', () => {
  it.each([
    ['the launch task', LAUNCH_TASK],
    ['the outbox sweep', SWEEP],
  ])('answers %s 2xx for the local tasks-invoker token', async (_label, request) => {
    // The local Cloud Tasks scheme verifies the token's audience against the callee's service name;
    // managedAudience (the service URL plus path) is the audience of the cloud OIDC token only.
    const res = await inject(request, { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(200);
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('acks a site.changed push carrying the local push key', async () => {
    const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope());
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(200);
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('answers GET /healthz without credentials', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('transport separation', () => {
  it.each(['s2', 'surveys.manager'])('refuses the %s user token on the push and task routes, even beside the push key', async (name) => {
    const credentials = await headersFor(name, { site: SITE_A });
    for (const request of [pushWithoutKey(), withPushKey(pushWithoutKey()), LAUNCH_TASK, withPushKey(LAUNCH_TASK), SWEEP]) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
    }
  });

  it('refuses a tasks-invoker token on service and push routes, with or without the gateway invocation credential', async () => {
    const tasksToken = `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`;
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const presented: Record<string, string>[] = [
      { authorization: tasksToken },
      { authorization: tasksToken, [INVOCATION_HEADER]: gatewayToken },
    ];
    for (const credentials of presented) {
      for (const request of [V1_LIST, MIGRATION_POSITION, FIXTURE_LIST, FIXTURE_SCHEDULE, pushWithoutKey()]) {
        const { status, effects } = await outcomeOf(request, credentials);
        expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
      }
    }
  });

  it('refuses a tasks-invoker token addressed to another service on the task routes', async () => {
    const credentials = { authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'communications' })}` };
    for (const request of [LAUNCH_TASK, SWEEP]) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
    }
  });

  it('refuses the push key on a user route and on the outbox sweep', async () => {
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const probes: [ProbeRequest, Record<string, string>][] = [
      [withPushKey(V1_LIST), {}],
      [withPushKey(V1_LIST), { [INVOCATION_HEADER]: gatewayToken }],
      [withPushKey(SWEEP), {}],
    ];
    for (const [request, credentials] of probes) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
    }
  });

  it('refuses a wrong push key on the push route', async () => {
    const before = mark();
    const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(), { key: `${TEST_PUSH_KEY}-wrong` });
    expect({ status: res.statusCode, effects: effectsSince(before) }).toEqual({ status: 401, effects: NO_EFFECTS });
  });
});

describe('site boundary', () => {
  const toSiteB = (request: ProbeRequest): ProbeRequest => ({ ...request, url: request.url.replace(ON_SITE_A, `siteid=${SITE_B}`) });

  it.each([V1_LIST, V1_SCHEDULE])('refuses a tenant-a surveys.manager token sent with siteid=tenant-b on $method $url', async (request) => {
    const outcome = await outcomeOf(toSiteB(request), await headersFor('surveys.manager', { site: SITE_A }));
    expect(outcome).toEqual({ status: 403, error: errorBody(LEGACY_ERROR_MAP.authorization), effects: NO_EFFECTS });
  });

  it.each([FIXTURE_LIST, FIXTURE_SCHEDULE])('refuses a tenant-a surveys.manager token sent with siteid=tenant-b on fixture $method $url', async (request) => {
    const { status, error, effects } = await outcomeOf(toSiteB(request), await headersFor('surveys.manager', { site: SITE_A }));
    expect({ status, error, effects: { ...effects, transactions: 0 } }).toEqual({
      status: 403,
      error: errorBody(FIXTURE_ERROR_MAP.forbidden),
      effects: NO_EFFECTS,
    });
  });
});

describe('CSRF on /v1 writes', () => {
  it.each([V1_SCHEDULE, V1_BULK_TARGET])('refuses a manager write without a CSRF token on $method $url, consuming and writing nothing', async (request) => {
    const outcome = await outcomeOf({ ...request, headers: {} }, await headersFor('surveys.manager', { site: SITE_A }));
    expect(outcome).toEqual({ status: 400, error: errorBody(LEGACY_ERROR_MAP.invalidTokens), effects: NO_EFFECTS });
  });

  it.each([V1_SCHEDULE, V1_BULK_TARGET])('refuses a manager write whose token identity rejects on $method $url, writing nothing', async (request) => {
    t.client.csrfValid(false);
    try {
      const outcome = await outcomeOf(request, await headersFor('surveys.manager', { site: SITE_A }));
      expect(outcome).toEqual({ status: 400, error: errorBody(LEGACY_ERROR_MAP.invalidTokens), effects: { ...NO_EFFECTS, calls: 1 } });
    } finally {
      t.client.csrfValid(true);
    }
  });
});

describe('deny by default at start-up', () => {
  it.each<[string, string, Opt2RouteConfig | undefined]>([
    ['declares no config.opt2', '/v1/surveys/__undeclared', undefined],
    ['is a public managed route', '/internal/v1/tasks/x', { public: true, transport: 'cloud-tasks' }],
    ['declares the service transport on a task path', '/internal/v1/tasks/y', { transport: 'service', requires: ['surveys.manager'] }],
  ])('fails start-up of the buildApp instance when a route %s', async (_label, url, opt2) => {
    const stateDir = await mkdtemp(join(tmpdir(), STATE_DIR_PREFIX));
    let app: FastifyInstance | undefined;
    try {
      await writeTestSecrets(stateDir);
      const built = await buildApp({
        env: await testEnv({ OPT2_STATE_DIR: stateDir }),
        clock: TEST_CLOCK,
        verifierOverride: testVerifier(),
        db: createRecordingDb({ clock: TEST_CLOCK }),
        publisher: createCapturingPublisher(),
        taskPort: createFakeTaskPort(),
      });
      app = built;
      const startUp = (async () => {
        built.get(url, opt2 === undefined ? {} : { config: { opt2 } }, async () => ({}));
        await built.ready();
      })();
      await expect(startUp).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await app?.close().catch(() => undefined);
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
