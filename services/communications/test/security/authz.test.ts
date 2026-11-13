// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** In-process authorisation matrix of every communications route: admitted subjects, denial envelopes, site and transport boundaries, deny by default. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  TASKS_INVOKER_ROLE,
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
import { taskWireBody, type CreateTaskInput } from '@opt2/platform/tasks';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TEST_PUSH_KEY,
  createCapturingPublisher,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushKeyQuery,
  pushTo,
  testVerifier,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { LOGIN_MAIL_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION, SURVEY_SCHEDULED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC } from '../../src/events/login-mail.js';
import { SURVEY_SCHEDULED_TOPIC } from '../../src/events/survey-scheduled.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/fixture-envelope.js';
import type { ScheduledTaskRow } from '../../src/repo/tables.js';
import { ADOPT_PATH, CANCEL_ADOPTED_PATH } from '../../src/routes/adoption.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { SCHEDULED_TASKS_PATH } from '../../src/routes/scheduled-tasks.js';
import { REMINDER_TASK_PATH } from '../../src/tasks/reminder.js';
import {
  TEST_CLOCK,
  buildTestApp,
  createFakeDeliveryStatus,
  createFakeMailTransport,
  createFakeSenderAddress,
  createFakeTaskPort,
  createRecordingDb,
  headersFor,
  testEnv,
  type TestApp,
} from '../helpers/app.js';
import { SAMPLE_IDS, envelopeFor, loginMailPayload, siteChangedPayload, surveyScheduledPayload } from '../helpers/payloads.js';

const SERVICE = 'communications';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const SENDER = 'communications.sender';

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
  SENDER,
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
const NO_INVOCATION: readonly string[] = ['anonymous', TASKS_INVOKER_ROLE, PUBSUB_INVOKER_ROLE];

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
  /** The probe, or a function building it from what `beforeAll` seeded. */
  request: ProbeRequest | (() => ProbeRequest);
  /** Subjects admitted: any status but 401, 403 and 5xx. */
  allow: readonly string[];
  /** Denied subjects answered 401; every other denied subject is answered 403. */
  deny401: readonly string[];
  /** Sends the probe as `subject` instead of injecting `request` with its credentials. */
  send?: (subject: RoleSubject, credentials: Record<string, string>) => Promise<InjectResponse>;
}

const SURVEY_ID = SAMPLE_IDS.surveyId;
const SWEEP_QUEUE = 'communications-outbox-sweep';
const REMINDER_QUEUE = 'communications-reminders';
const ON_SITE_A = `siteid=${SITE_A}`;
// The client recorder answers identity's CSRF consume with valid: true, so admitted fixture and /v1 writes reach their handlers.
const CSRF_HEADERS = { 'x-csrf_token': 'authz-probe-token', 'x-csrf_token_expires': '260630120000000' } as const;
const TEMPLATE_BODY = { name: 'Authz probe', subject: 'Probe subject', bodyText: 'Probe body' };
const MESSAGE_BODY = { to: 'member1@tenant-a.example', subject: 'Probe subject', bodyText: 'Probe body' };

const FIXTURE_ROUTE: Declared = { transport: 'service', public: true, siteCheck: false };
const SENDER_ROUTE: Declared = { transport: 'service', requires: [SENDER] };
const TASK_ROUTE: Declared = { transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE] };
const PUSH_ROUTE: Declared = { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] };

/** Id of the message `beforeAll` sent, which the detail probes read. */
let messageId = '';
/** The reminder task the survey schedule `beforeAll` delivered created on `communications-reminders`. */
let reminderTask: CreateTaskInput | undefined;

/** A fixture route of auth.cfc requireAny('communications.sender'), which grants no S2 bypass. */
function fixtureSenderRoute(request: ProbeRequest | (() => ProbeRequest)): Expectation {
  return { declared: FIXTURE_ROUTE, request, allow: [SENDER], deny401: NO_USER };
}

/** A `/v1/` route for communications.sender alone. */
function senderRoute(request: ProbeRequest | (() => ProbeRequest)): Expectation {
  return { declared: SENDER_ROUTE, request, allow: [SENDER], deny401: NO_USER };
}

/** A migration-kit or scheduler hand-off route for the migration workload alone. */
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
function taskRoute(request: ProbeRequest | (() => ProbeRequest)): Expectation {
  return { declared: TASK_ROUTE, request, allow: [TASKS_INVOKER_ROLE], deny401: everyoneBut(TASKS_INVOKER_ROLE) };
}

/** A push route for the Pub/Sub invoker alone, delivering `envelope` on `subscription`. */
function pushRoute(subscription: string, envelope: () => EventEnvelope): Expectation {
  const url = `/internal/v1/events/${subscription}`;
  return {
    declared: PUSH_ROUTE,
    request: { method: 'POST', url },
    allow: [PUBSUB_INVOKER_ROLE],
    deny401: everyoneBut(PUBSUB_INVOKER_ROLE),
    send: (subject, credentials) =>
      subject.name === PUBSUB_INVOKER_ROLE ? pushTo(t.app, subscription, envelope()) : inject(pushWithoutKey(subscription, envelope()), credentials),
  };
}

const FIXTURE_TEMPLATES = `${FIXTURE_PREFIX}/templates?${ON_SITE_A}`;
const FIXTURE_MESSAGES = `${FIXTURE_PREFIX}/messages?${ON_SITE_A}`;
const V1_TEMPLATES: ProbeRequest = { method: 'GET', url: `/v1/templates?${ON_SITE_A}` };
const V1_SEND: ProbeRequest = { method: 'POST', url: `/v1/messages?${ON_SITE_A}`, headers: CSRF_HEADERS, payload: MESSAGE_BODY };
const V1_STORE: ProbeRequest = { method: 'POST', url: `/v1/templates?${ON_SITE_A}`, headers: CSRF_HEADERS, payload: TEMPLATE_BODY };
const FIXTURE_LIST: ProbeRequest = { method: 'GET', url: FIXTURE_TEMPLATES };
const FIXTURE_SEND: ProbeRequest = { method: 'POST', url: FIXTURE_MESSAGES, headers: CSRF_HEADERS, payload: MESSAGE_BODY };
const MIGRATION_POSITION: ProbeRequest = { method: 'GET', url: '/internal/v1/migration/position' };
const SCHEDULED_TASKS: ProbeRequest = { method: 'GET', url: `${SCHEDULED_TASKS_PATH}?sourceType=survey&sourceId=${SURVEY_ID}` };
const SWEEP: ProbeRequest = {
  method: 'POST',
  url: '/internal/v1/outbox/sweep',
  payload: { queue: SWEEP_QUEUE, name: `${SWEEP_QUEUE}-authz-probe`, tenantId: null, payload: null },
};

const SUPERSEDED_TASK_ID = 'E5F6A7B8-0005-4000-8000000000000005';
const SUPERSEDED_SURVEY_ID = 'F6A7B8C9-0006-4000-8000000000000006';
const SEEDED_AT = TEST_CLOCK.now();

/** A tenant-a reminder a later schedule version superseded; its queue task is already deleted, so no sweep recovery touches it. */
const SUPERSEDED_REMINDER = {
  tenant_id: TENANT_A.tenantId,
  scheduled_task_id: SUPERSEDED_TASK_ID,
  task_name: `opt2-survey-${SUPERSEDED_SURVEY_ID}-reminder-1`,
  queue: REMINDER_QUEUE,
  queue_task_name: `opt2-survey-${SUPERSEDED_SURVEY_ID}-reminder-1-v1`,
  kind: 'survey-reminder',
  source_type: 'survey',
  source_id: SUPERSEDED_SURVEY_ID,
  reminder_n: 1,
  schedule_time: SEEDED_AT,
  status: 'superseded',
  target_route: REMINDER_TASK_PATH.replace(':scheduledTaskId', SUPERSEDED_TASK_ID),
  schedule_version: 1,
  origin: 'event',
  enqueued_at: SEEDED_AT,
  dequeued_at: SEEDED_AT,
  created_at: SEEDED_AT,
  updated_at: SEEDED_AT,
} satisfies ScheduledTaskRow;

/** The superseded reminder's task as Cloud Tasks delivers it. */
const SUPERSEDED_DELIVERY: ProbeRequest = {
  method: 'POST',
  url: SUPERSEDED_REMINDER.target_route,
  payload: {
    queue: REMINDER_QUEUE,
    name: SUPERSEDED_REMINDER.queue_task_name,
    tenantId: TENANT_A.tenantId,
    payload: { scheduledTaskId: SUPERSEDED_TASK_ID, surveyId: SUPERSEDED_SURVEY_ID, n: 1, scheduleVersion: 1 },
  },
};

/** The stored reminder's task as Cloud Tasks delivers it: its target path and wire body. */
function reminderTaskRequest(): ProbeRequest {
  if (reminderTask === undefined) throw new TypeError('beforeAll created no reminder task');
  return { method: 'POST', url: new URL(reminderTask.url).pathname, payload: { ...taskWireBody(reminderTask) } };
}

let t: TestApp;
let matrix: RouteMatrix;

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

function requestOf(entry: Expectation): ProbeRequest {
  return typeof entry.request === 'function' ? entry.request() : entry.request;
}

/** A contract-valid tenant-a `programs-sites.site.changed.v1` envelope, its payload the fixture registry's. */
function siteChangedEnvelope(): EventEnvelope {
  return envelopeFor('programs-sites.site.changed.v1', siteChangedPayload(SITE_A));
}

/** A forgot-password `identity.login-mail.requested.v1` envelope with a fresh message id, so each delivery is a new mail. */
function loginMailEnvelope(): EventEnvelope {
  const id = randomUUID().toUpperCase();
  return envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId: `${id.slice(0, 23)}${id.slice(24)}` }));
}

/** Version 1 of the sample survey's schedule as `surveys.survey.scheduled.v1`. */
function surveyScheduledEnvelope(): EventEnvelope {
  return envelopeFor(SURVEY_SCHEDULED_TOPIC, surveyScheduledPayload(1));
}

/** The push of `envelope` on `subscription` as Pub/Sub sends it, without the push key in the URL. */
function pushWithoutKey(subscription: string, envelope: EventEnvelope = siteChangedEnvelope()): ProbeRequest {
  const body = buildPushBody({ data: encodeEnvelope(envelope), messageId: randomUUID(), subscription });
  return { method: 'POST', url: `/internal/v1/events/${subscription}`, payload: { ...body } };
}

/** `request` with the local push key added to its query. */
function withPushKey(request: ProbeRequest, key: string = TEST_PUSH_KEY): ProbeRequest {
  return { ...request, url: `${request.url}${request.url.includes('?') ? '&' : '?'}${pushKeyQuery(key)}` };
}

/** Sends the scheduled-task listing as surveys sends it: a workload's invocation credential beside the forwarded tenant-a user token. */
async function sendScheduledTasks(subject: RoleSubject, credentials: Record<string, string>): Promise<InjectResponse> {
  const forwards = subject.kind === 'service' && subject.name !== TASKS_INVOKER_ROLE && subject.name !== PUBSUB_INVOKER_ROLE;
  if (!forwards) return inject(SCHEDULED_TASKS, credentials);
  const userToken = await mintUserToken({ sub: SAMPLE_IDS.userId, site: SITE_A, roles: ['system-user', 'surveys.manager'] });
  return inject(SCHEDULED_TASKS, { ...credentials, authorization: `Bearer ${userToken}` });
}

/** Every registered route, keyed `<METHOD> <fastify url>`, with its declaration, tenant-a probe and admitted subjects. */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  'GET /healthz': {
    declared: { transport: 'service', public: true },
    request: { method: 'GET', url: '/healthz' },
    // A tasks-invoker token in Authorization is verified, and refused, as a user token.
    allow: everyoneBut(TASKS_INVOKER_ROLE),
    deny401: [TASKS_INVOKER_ROLE],
  },
  'POST /internal/v1/events/communications.identity.login-mail.requested.v1': pushRoute(LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope),
  'POST /internal/v1/events/communications.programs-sites.site.changed.v1': pushRoute(SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope),
  'POST /internal/v1/events/communications.surveys.survey.scheduled.v1': pushRoute(SURVEY_SCHEDULED_SUBSCRIPTION, surveyScheduledEnvelope),
  'POST /internal/v1/migration/adopt-scheduled-tasks': migrationRoute({ method: 'POST', url: ADOPT_PATH, payload: { tasks: [] } }),
  'POST /internal/v1/migration/apply': migrationRoute({ method: 'POST', url: '/internal/v1/migration/apply', payload: {} }),
  'POST /internal/v1/migration/cancel-adopted-scheduled-tasks': migrationRoute({ method: 'POST', url: CANCEL_ADOPTED_PATH, payload: {} }),
  'GET /internal/v1/migration/changes': migrationRoute({
    method: 'GET',
    url: `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`,
  }),
  'GET /internal/v1/migration/export': migrationRoute({
    method: 'GET',
    url: `/internal/v1/migration/export?unit=communications.message_template&tenantId=${TENANT_A.tenantId}`,
  }),
  'POST /internal/v1/migration/gate': migrationRoute({ method: 'POST', url: '/internal/v1/migration/gate', payload: {} }),
  'GET /internal/v1/migration/position': migrationRoute(MIGRATION_POSITION),
  'GET /internal/v1/migration/watermark': migrationRoute({ method: 'GET', url: '/internal/v1/migration/watermark' }),
  'POST /internal/v1/migration/watermark': migrationRoute({ method: 'POST', url: '/internal/v1/migration/watermark', payload: {} }),
  'POST /internal/v1/outbox/sweep': taskRoute(SWEEP),
  // Surveys alone, and only with the end user's token forwarded, whose tenant the listing reads.
  'GET /internal/v1/scheduled-tasks': {
    declared: { transport: 'service', requires: ['service:surveys'] },
    request: SCHEDULED_TASKS,
    allow: ['service:surveys'],
    deny401: NO_INVOCATION,
    send: sendScheduledTasks,
  },
  'POST /internal/v1/task-queues/:queue/ensure': queueControl('ensure'),
  'POST /internal/v1/task-queues/:queue/pause': queueControl('pause'),
  'POST /internal/v1/task-queues/:queue/resume': queueControl('resume'),
  'POST /internal/v1/tasks/reminders/:scheduledTaskId': taskRoute(reminderTaskRequest),
  'GET /legacy-fixtures/cfml/api.cfm/communications/messages': fixtureSenderRoute({ method: 'GET', url: FIXTURE_MESSAGES }),
  'POST /legacy-fixtures/cfml/api.cfm/communications/messages': fixtureSenderRoute(FIXTURE_SEND),
  'GET /legacy-fixtures/cfml/api.cfm/communications/messages/:id': fixtureSenderRoute(() => ({
    method: 'GET',
    url: `${FIXTURE_PREFIX}/messages/${messageId}?${ON_SITE_A}`,
  })),
  'GET /legacy-fixtures/cfml/api.cfm/communications/templates': fixtureSenderRoute(FIXTURE_LIST),
  'POST /legacy-fixtures/cfml/api.cfm/communications/templates': fixtureSenderRoute({
    method: 'POST',
    url: FIXTURE_TEMPLATES,
    headers: CSRF_HEADERS,
    payload: TEMPLATE_BODY,
  }),
  'GET /v1/messages': senderRoute({ method: 'GET', url: `/v1/messages?${ON_SITE_A}` }),
  'POST /v1/messages': senderRoute(V1_SEND),
  'GET /v1/messages/:messageId': senderRoute(() => ({ method: 'GET', url: `/v1/messages/${messageId}?${ON_SITE_A}` })),
  'GET /v1/templates': senderRoute(V1_TEMPLATES),
  'POST /v1/templates': senderRoute(V1_STORE),
};

/** Request effects counted from a {@link mark}. */
interface Effects {
  transactions: number;
  /** Write statements of the transactions run since the mark. */
  writes: string[];
  tasks: number;
  /** Queue tasks deleted since the mark. */
  deleted: number;
  calls: number;
  published: number;
  mails: number;
}

type Mark = Omit<Effects, 'writes'>;

const NO_EFFECTS: Effects = { transactions: 0, writes: [], tasks: 0, deleted: 0, calls: 0, published: 0, mails: 0 };

const WRITE_STATEMENT = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\S+(?:\s+AS\s+\S+)?\s+SET)\b/i;

function mark(): Mark {
  return {
    transactions: t.db.transactions.length,
    tasks: t.taskPort.tasks.length,
    deleted: t.taskPort.deleted.length,
    calls: t.client.requests.length,
    published: t.publisher.published.length + t.publisher.raw.length,
    mails: t.mail.sent.length,
  };
}

function effectsSince(from: Mark): Effects {
  const transactions = t.db.transactions.slice(from.transactions);
  return {
    transactions: transactions.length,
    writes: transactions.flatMap((tx) => tx.statements.map((statement) => statement.text).filter((text) => WRITE_STATEMENT.test(text))),
    tasks: t.taskPort.tasks.length - from.tasks,
    deleted: t.taskPort.deleted.length - from.deleted,
    calls: t.client.requests.length - from.calls,
    published: t.publisher.published.length + t.publisher.raw.length - from.published,
    mails: t.mail.sent.length - from.mails,
  };
}

/** Effects a refused request may leave: a fixture route's own site lookup, nothing else. */
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
  const res = entry.send === undefined ? await inject(requestOf(entry), credentials) : await entry.send(subject, credentials);
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

beforeAll(async () => {
  t = await buildTestApp({ db: createRecordingDb({ scheduled_task: [SUPERSEDED_REMINDER] }) });
  // A sent message for the detail probes, and the sample survey's schedule for the listing and reminder-task probes.
  const sent = await t.app.inject({ method: 'POST', url: V1_SEND.url, headers: { ...CSRF_HEADERS, ...(await headersFor(SENDER)) }, payload: MESSAGE_BODY });
  expect(sent.statusCode, sent.body).toBe(200);
  messageId = (sent.json() as { data: { message_id: string } }).data.message_id;
  const scheduled = await pushTo(t.app, SURVEY_SCHEDULED_SUBSCRIPTION, surveyScheduledEnvelope());
  expect(scheduled.statusCode, scheduled.body).toBe(204);
  reminderTask = t.taskPort.byQueue(REMINDER_QUEUE)[0];
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
    ['the stored reminder task', reminderTaskRequest],
    ['the outbox sweep', () => SWEEP],
  ])('answers %s 2xx for the local tasks-invoker token', async (_label, request) => {
    // The local Cloud Tasks scheme verifies the token's audience against the callee's service name.
    const res = await inject(request(), { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(200);
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('answers a superseded reminder task 2xx without calling surveys or sending mail', async () => {
    const before = mark();
    const res = await inject(SUPERSEDED_DELIVERY, { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` });
    const effects = effectsSince(before);
    expect({ status: res.statusCode, body: res.json() as unknown, effects: { ...effects, transactions: 0 } }).toEqual({
      status: 200,
      body: { status: 'superseded' },
      effects: NO_EFFECTS,
    });
  });

  it.each([
    ['site.changed', SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope],
    ['login-mail.requested', LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope],
    ['survey.scheduled', SURVEY_SCHEDULED_SUBSCRIPTION, surveyScheduledEnvelope],
  ] as const)('acks a %s push carrying the local push key', async (_label, subscription, envelope) => {
    const res = await pushTo(t.app, subscription, envelope());
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(200);
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('refuses the surveys workload on the scheduled-task listing without a forwarded user token', async () => {
    const outcome = await outcomeOf(SCHEDULED_TASKS, await headersFor('service:surveys'));
    expect({ status: outcome.status, effects: outcome.effects }).toEqual({ status: 401, effects: NO_EFFECTS });
  });
});

describe('transport separation', () => {
  it.each(['s2', SENDER])('refuses the %s user token on the push and task routes, even beside the push key', async (name) => {
    const credentials = await headersFor(name, { site: SITE_A });
    const push = pushWithoutKey(SITE_CHANGED_SUBSCRIPTION);
    for (const request of [push, withPushKey(push), reminderTaskRequest(), withPushKey(reminderTaskRequest()), SWEEP]) {
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
      for (const request of [
        V1_TEMPLATES,
        V1_SEND,
        MIGRATION_POSITION,
        FIXTURE_LIST,
        FIXTURE_SEND,
        pushWithoutKey(LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope()),
      ]) {
        const { status, effects } = await outcomeOf(request, credentials);
        expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
      }
    }
  });

  it('refuses a tasks-invoker token addressed to another service on the task routes', async () => {
    const credentials = { authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'surveys' })}` };
    for (const request of [reminderTaskRequest(), SWEEP]) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
    }
  });

  it('refuses the push key on a user route and on the outbox sweep', async () => {
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const probes: [ProbeRequest, Record<string, string>][] = [
      [withPushKey(V1_TEMPLATES), {}],
      [withPushKey(V1_TEMPLATES), { [INVOCATION_HEADER]: gatewayToken }],
      [withPushKey(V1_SEND), {}],
      [withPushKey(SWEEP), {}],
    ];
    for (const [request, credentials] of probes) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
    }
  });

  it('answers the push key on a fixture route as an anonymous caller', async () => {
    const { status, error, effects } = await outcomeOf(withPushKey(FIXTURE_SEND), {});
    expect({ status, error, effects: { ...effects, transactions: 0 } }).toEqual({
      status: 401,
      error: errorBody(LEGACY_ERROR_MAP.authorization),
      effects: NO_EFFECTS,
    });
  });

  it('refuses a wrong push key on the push routes', async () => {
    for (const [subscription, envelope] of [
      [SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope()],
      [LOGIN_MAIL_SUBSCRIPTION, loginMailEnvelope()],
      [SURVEY_SCHEDULED_SUBSCRIPTION, surveyScheduledEnvelope()],
    ] as const) {
      const before = mark();
      const res = await pushTo(t.app, subscription, envelope, { key: `${TEST_PUSH_KEY}-wrong` });
      expect({ subscription, status: res.statusCode, effects: effectsSince(before) }).toEqual({ subscription, status: 401, effects: NO_EFFECTS });
    }
  });
});

describe('site boundary', () => {
  const toSiteB = (request: ProbeRequest): ProbeRequest => ({ ...request, url: request.url.replace(ON_SITE_A, `siteid=${SITE_B}`) });

  it.each([V1_TEMPLATES, V1_SEND])('refuses a tenant-a sender token sent with siteid=tenant-b on $method $url', async (request) => {
    const outcome = await outcomeOf(toSiteB(request), await headersFor(SENDER, { site: SITE_A }));
    expect(outcome).toEqual({ status: 403, error: errorBody(LEGACY_ERROR_MAP.authorization), effects: NO_EFFECTS });
  });

  it('refuses a tenant-a sender token whose POST /v1/messages body names siteid=tenant-b', async () => {
    const request: ProbeRequest = { ...V1_SEND, url: '/v1/messages', payload: { ...MESSAGE_BODY, siteid: SITE_B } };
    const outcome = await outcomeOf(request, await headersFor(SENDER, { site: SITE_A }));
    expect(outcome).toEqual({ status: 403, error: errorBody(LEGACY_ERROR_MAP.authorization), effects: NO_EFFECTS });
  });

  it.each([FIXTURE_LIST, FIXTURE_SEND])('refuses a tenant-a sender token sent with siteid=tenant-b on fixture $method $url', async (request) => {
    const { status, error, effects } = await outcomeOf(toSiteB(request), await headersFor(SENDER, { site: SITE_A }));
    expect({ status, error, effects: { ...effects, transactions: 0 } }).toEqual({
      status: 403,
      error: errorBody(FIXTURE_ERROR_MAP.forbidden),
      effects: NO_EFFECTS,
    });
  });
});

describe('CSRF on /v1 writes', () => {
  it.each([V1_STORE, V1_SEND])('refuses a sender write without a CSRF token on $method $url, consuming and writing nothing', async (request) => {
    const outcome = await outcomeOf({ ...request, headers: {} }, await headersFor(SENDER, { site: SITE_A }));
    expect(outcome).toEqual({ status: 400, error: errorBody(LEGACY_ERROR_MAP.invalidTokens), effects: NO_EFFECTS });
  });

  it.each([V1_STORE, V1_SEND])('refuses a sender write whose token identity rejects on $method $url, writing nothing', async (request) => {
    t.client.csrfValid(false);
    try {
      const outcome = await outcomeOf(request, await headersFor(SENDER, { site: SITE_A }));
      expect(outcome).toEqual({ status: 400, error: errorBody(LEGACY_ERROR_MAP.invalidTokens), effects: { ...NO_EFFECTS, calls: 1 } });
    } finally {
      t.client.csrfValid(true);
    }
  });
});

describe('deny by default at start-up', () => {
  it.each<[string, string, Opt2RouteConfig | undefined]>([
    ['declares no config.opt2', '/v1/messages/__undeclared', undefined],
    ['declares neither requires nor public', '/v1/templates/__unlisted', { transport: 'service' }],
    ['is a public managed route', '/internal/v1/tasks/x', { public: true, transport: 'cloud-tasks' }],
    ['declares the service transport on a task path', '/internal/v1/tasks/y', { transport: 'service', requires: [SENDER] }],
  ])('fails start-up of the buildApp instance when a route %s', async (_label, url, opt2) => {
    let app: FastifyInstance | undefined;
    try {
      const built = await buildApp({
        env: await testEnv(),
        clock: TEST_CLOCK,
        verifierOverride: testVerifier(),
        db: createRecordingDb({}, { clock: TEST_CLOCK }),
        publisher: createCapturingPublisher(),
        taskPort: createFakeTaskPort(),
        mailTransport: createFakeMailTransport(),
        deliveryStatus: createFakeDeliveryStatus(),
        senderAddress: createFakeSenderAddress(),
      });
      app = built;
      const startUp = (async () => {
        built.get(url, opt2 === undefined ? {} : { config: { opt2 } }, async () => ({}));
        await built.ready();
      })();
      await expect(startUp).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await app?.close().catch(() => undefined);
    }
  });
});
