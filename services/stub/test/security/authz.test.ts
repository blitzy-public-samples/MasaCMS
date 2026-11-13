/** In-process authorisation matrix of every stub route: declarations, admitted subjects, tenant and transport boundaries. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  renderAuthDenial,
  type DenialResponse,
  type Role,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, type EventEnvelope } from '@opt2/platform/events';
import { baseEnvSchema, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { outboxSweepQueue } from '@opt2/platform/tasks';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TEST_PUSH_KEY,
  authHeadersFor,
  createCapturingPublisher,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushTo,
  registryPayloads,
  testEnvelope,
  testVerifier,
  writeTestSecrets,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import {
  NOTE_CREATED_SUBSCRIPTION,
  NOTE_CREATED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
} from '../../src/events/topics.js';
import {
  TEST_CLOCK,
  buildTestApp,
  createFakeTaskPort,
  createRecordingDb,
  testEnv,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';

const SERVICE = 'stub';
const SITE_A = TENANT_A.siteId;
const NOTE_ID = 'A0B1C2D3-E4F5-0617-2839ABCDEF012345';
const NOTE_CREATED = '2026-06-30 11:00:00.000';
const NOTE_ROW = { note_id: NOTE_ID, title: 'Seeded note', body: 'Seeded body', created: NOTE_CREATED, row_version: 1 };
const NOTE_PAYLOAD = { noteId: NOTE_ID, title: NOTE_ROW.title, body: NOTE_ROW.body, created: NOTE_CREATED, rowVersion: 1 };
const SWEEP_QUEUE = outboxSweepQueue(SERVICE);
const NOTE_PUSH_URL = `/internal/v1/events/${NOTE_CREATED_SUBSCRIPTION}`;
const SITE_PUSH_URL = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const NOTE_URL = `/opt2/stub/notes/${NOTE_ID}`;
const PROJECTION_URL = `${NOTE_URL}/projection`;
const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const WRONG_PUSH_KEY = 'opt2-wrong-push-key';
const DENIED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

const PUSH_SUBSCRIPTIONS: Readonly<Record<string, string>> = {
  [NOTE_PUSH_URL]: NOTE_CREATED_SUBSCRIPTION,
  [SITE_PUSH_URL]: SITE_CHANGED_SUBSCRIPTION,
};

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

const SYSTEM_USERS = ['system-user', 'editor', 'site-admin', 's2', 'other-tenant', ...SYNTHETIC] as const;
const USERS = ['member', ...SYSTEM_USERS] as const;
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
const EVERYONE: readonly string[] = ['anonymous', ...USERS, ...WORKLOADS];
const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;

function everyoneBut(...excluded: string[]): string[] {
  return EVERYONE.filter((name) => !excluded.includes(name));
}

type Method = 'GET' | 'POST' | 'DELETE';

/** A route's declaration and independently admitted subject names. */
interface ExpectedRoute {
  method: Method;
  url: string;
  transport: Transport;
  requires?: readonly Role[];
  public?: true;
  allow: readonly string[];
}

const READERS: readonly Role[] = [Roles.member, Roles.systemUser, Roles.siteAdmin, Roles.s2];
const MIGRATION_ONLY: readonly Role[] = [Roles.platformMigration];
const QUEUE_CONTROLLERS: readonly Role[] = [Roles.platformMigration, Roles.platformOperator];

const EXPECTED: readonly ExpectedRoute[] = [
  { method: 'GET', url: '/healthz', transport: 'service', public: true, allow: everyoneBut('service:tasks-invoker') },
  { method: 'POST', url: '/opt2/stub/notes', transport: 'service', requires: [Roles.systemUser], allow: SYSTEM_USERS },
  { method: 'GET', url: '/opt2/stub/notes', transport: 'service', requires: READERS, allow: USERS },
  { method: 'GET', url: '/opt2/stub/notes/:noteId', transport: 'service', requires: READERS, allow: USERS },
  { method: 'GET', url: '/opt2/stub/notes/:noteId/projection', transport: 'service', requires: READERS, allow: USERS },
  { method: 'DELETE', url: '/opt2/stub/notes/:noteId', transport: 'service', requires: [Roles.s2], allow: ['s2'] },
  { method: 'POST', url: '/internal/v1/migration/apply', transport: 'service', requires: MIGRATION_ONLY, allow: ['service:migration'] },
  { method: 'GET', url: '/internal/v1/migration/export', transport: 'service', requires: MIGRATION_ONLY, allow: ['service:migration'] },
  { method: 'GET', url: '/internal/v1/migration/changes', transport: 'service', requires: MIGRATION_ONLY, allow: ['service:migration'] },
  { method: 'GET', url: '/internal/v1/migration/position', transport: 'service', requires: MIGRATION_ONLY, allow: ['service:migration'] },
  { method: 'GET', url: '/internal/v1/migration/watermark', transport: 'service', requires: MIGRATION_ONLY, allow: ['service:migration'] },
  { method: 'POST', url: '/internal/v1/migration/watermark', transport: 'service', requires: MIGRATION_ONLY, allow: ['service:migration'] },
  { method: 'POST', url: '/internal/v1/migration/gate', transport: 'service', requires: MIGRATION_ONLY, allow: ['service:migration'] },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/pause', transport: 'service', requires: QUEUE_CONTROLLERS, allow: ['service:migration', 'service:operator'] },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/resume', transport: 'service', requires: QUEUE_CONTROLLERS, allow: ['service:migration', 'service:operator'] },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/ensure', transport: 'service', requires: QUEUE_CONTROLLERS, allow: ['service:migration', 'service:operator'] },
  { method: 'POST', url: '/internal/v1/outbox/sweep', transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE], allow: ['service:tasks-invoker'] },
  { method: 'POST', url: NOTE_PUSH_URL, transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE], allow: ['service:pubsub-invoker'] },
  { method: 'POST', url: SITE_PUSH_URL, transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE], allow: ['service:pubsub-invoker'] },
];

/** One concrete request; a subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: Method;
  url: string;
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Handler effects of one request, counted from `resetEffects`. */
interface Effects {
  statements: number;
  writes: number;
  published: number;
  tasks: number;
}

/** What one request answered and left behind. */
interface Outcome {
  status: number;
  body: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  effects: Effects;
}

const NO_EFFECTS: Effects = { statements: 0, writes: 0, published: 0, tasks: 0 };

let t: TestApp;
let matrix: RouteMatrix;
let taskCount = 0;

/** A RecordingDb holding the tenant-a note, and with `withProjection` its tenant-a projection. */
function seededDb(withProjection = false): RecordingDb {
  const projection = {
    note_id: NOTE_ID,
    title: NOTE_ROW.title,
    body: NOTE_ROW.body,
    created: NOTE_CREATED,
    aggregate_version: 1,
    apply_count: 1,
    last_event_id: randomUUID(),
    projected_at: NOTE_CREATED,
  };
  return createRecordingDb({
    notes: [{ tenantId: TENANT_A.tenantId, row: NOTE_ROW }],
    projections: withProjection ? [{ tenantId: TENANT_A.tenantId, row: projection }] : [],
  });
}

/** `<METHOD> <url>` of a route. */
function keyOf(route: Pick<ExpectedRoute, 'method' | 'url'> | Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

/** A declaration in comparable form: `requires` sorted, defaults dropped. */
function comparable(route: ExpectedRoute | RouteMatrixEntry): Record<string, unknown> {
  return {
    method: route.method,
    url: route.url,
    transport: route.transport,
    ...(route.requires === undefined ? {} : { requires: [...route.requires].sort() }),
    ...(route.public === true ? { public: true } : {}),
    ...('siteCheck' in route && route.siteCheck === false ? { siteCheck: false } : {}),
    ...('edge' in route && route.edge === true ? { edge: true } : {}),
  };
}

/** Comparable declarations ordered by method and url. */
function declarations(routes: ReadonlyArray<ExpectedRoute | RouteMatrixEntry>): Record<string, unknown>[] {
  return [...routes].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)).map(comparable);
}

/** Sorted `requires` of the registered route, or undefined when it is public or absent. */
function declaredRequires(method: Method, url: string): string[] | undefined {
  const route = matrix.routes.find((entry) => entry.method === method && entry.url === url);
  return route?.requires === undefined ? undefined : [...route.requires].sort();
}

function subjectNamed(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return subject;
}

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Record<string, string>> }>();

// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `authHeadersFor(subject)` on tenant-a, reused across probes while its tokens are fresh. */
function credentialsOf(subject: RoleSubject): Promise<Record<string, string>> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = authHeadersFor(subject, { site: SITE_A, audience: SERVICE });
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

async function tasksInvokerCredentials(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
}

/** A user token of tenant-a claiming both managed invoker roles and s2. */
async function invokerClaimingUserToken(): Promise<Record<string, string>> {
  const token = await mintUserToken({
    sub: 'test-transport-probe',
    tid: TENANT_A.tenantId,
    site: SITE_A,
    roles: [PUBSUB_INVOKER_ROLE, TASKS_INVOKER_ROLE, Roles.s2],
  });
  return { authorization: `Bearer ${token}` };
}

/** A contract-valid envelope of the topic `subscription` consumes: the seeded tenant-a note, or the tenant-a site. */
function envelopeFor(subscription: string): EventEnvelope {
  if (subscription === NOTE_CREATED_SUBSCRIPTION) {
    return testEnvelope({
      topic: NOTE_CREATED_TOPIC,
      tenantId: TENANT_A.tenantId,
      aggregateId: NOTE_ID,
      aggregateVersion: 1,
      payload: NOTE_PAYLOAD,
    });
  }
  const site = registryPayloads().find((payload) => payload.siteId === SITE_A);
  if (site === undefined) throw new TypeError(`registryPayloads has no ${SITE_A} payload`);
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload: site });
}

/** The Pub/Sub push body of `envelope`, as delivered without the push key. */
function pushBodyOf(envelope: EventEnvelope, subscription: string): Record<string, unknown> {
  return { ...buildPushBody({ data: encodeEnvelope(envelope), messageId: randomUUID(), subscription }) };
}

/** A push delivery to `subscription` without the push key. */
function pushRequest(subscription: string): ProbeRequest {
  return {
    method: 'POST',
    url: `/internal/v1/events/${subscription}`,
    headers: JSON_HEADERS,
    payload: pushBodyOf(envelopeFor(subscription), subscription),
  };
}

function withPushKey(request: ProbeRequest): ProbeRequest {
  return { ...request, url: `${request.url}?key=${TEST_PUSH_KEY}` };
}

/** A tenant-less Cloud Tasks body on `queue`, named for the clock's current slot. */
function systemTaskBody(queue: string): Record<string, unknown> {
  return { queue, name: `${queue}-${Math.floor(TEST_CLOCK.now().getTime() / 1000)}`, tenantId: null, payload: {} };
}

/** The request a route's row is probed with: tenant-a note and the stub's own sweep queue in its path. */
function probeRequest(route: ExpectedRoute): ProbeRequest {
  const url = route.url.replace(':noteId', NOTE_ID).replace(':queue', SWEEP_QUEUE);
  if (route.method !== 'POST') return { method: route.method, url };
  const payload =
    route.url === '/opt2/stub/notes'
      ? { title: 'Authz probe', body: 'Probe body' }
      : route.url === '/internal/v1/outbox/sweep'
        ? systemTaskBody(SWEEP_QUEUE)
        : {};
  return { method: 'POST', url, headers: JSON_HEADERS, payload };
}

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

/** Empties the recordings and snapshots the task port before a probe. */
function resetEffects(): void {
  t.db.clear();
  t.publisher.clear();
  taskCount = t.taskPort.tasks.length;
}

/** Effects since `resetEffects`. */
function effectsAfter(): Effects {
  return {
    statements: t.db.queries.length,
    writes: t.db.writes.length,
    published: t.publisher.published.length + t.publisher.raw.length,
    tasks: t.taskPort.tasks.length - taskCount,
  };
}

/** Sends one probe on the main app and records its answer and effects. */
async function outcomeOf(send: () => Promise<InjectResponse>): Promise<Outcome> {
  resetEffects();
  const res = await send();
  const sentUrl = new URL(res.raw.req.url ?? '/', 'http://stub.test');
  const headers = Object.fromEntries(Object.entries(res.headers).map(([name, value]) => [name, String(value)]));
  return {
    status: res.statusCode,
    body: res.body,
    headers,
    query: Object.fromEntries(sentUrl.searchParams),
    effects: effectsAfter(),
  };
}

function parsedBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `body` is a legacy JSON API error envelope (jsonApiUtility.cfc:1318-1340); `params` is left out when the request had none. */
function isErrorEnvelope(body: unknown): boolean {
  if (!isRecord(body) || !isRecord(body.error) || !(body.params === undefined || isRecord(body.params))) return false;
  const { apiversion, method, error } = body;
  return (
    typeof apiversion === 'string' && typeof method === 'string' && typeof error.code === 'string' && typeof error.message === 'string'
  );
}

const DENIAL_KINDS: readonly AuthDenial[] = [
  AuthDenial.unauthenticated('missing-credential'),
  AuthDenial.invalidToken(),
  AuthDenial.expiredToken(),
  AuthDenial.forbidden(),
];

/** Every response `renderAuthDenial` gives a request with `query` at `status`. */
function renderedDenials(status: number, query: Record<string, string>): DenialResponse[] {
  const request = { query } as unknown as Parameters<typeof renderAuthDenial>[1];
  return DENIAL_KINDS.filter((denial) => denial.statusCode === status).map((denial) => renderAuthDenial(denial, request));
}

/** Every way `outcome` departs from a hook-level refusal: 401 or 403, the exact rendered envelope and headers, no handler effect. */
function denialProblems(outcome: Outcome, at: string): string[] {
  if (!DENIED_STATUSES.has(outcome.status)) return [`${at}: expected 401 or 403, got ${outcome.status} ${outcome.body.slice(0, 160)}`];
  const problems: string[] = [];
  if (!isErrorEnvelope(parsedBody(outcome.body))) {
    problems.push(`${at}: denial is not the legacy error envelope: ${outcome.body.slice(0, 160)}`);
  }
  const rendered = renderedDenials(outcome.status, outcome.query).find((response) => response.body === outcome.body);
  if (rendered === undefined) {
    problems.push(`${at}: body is not one renderAuthDenial builds: ${outcome.body.slice(0, 160)}`);
  } else {
    for (const [name, value] of Object.entries(rendered.headers)) {
      const sent = outcome.headers[name.toLowerCase()];
      if (sent !== value) problems.push(`${at}: header ${name} is ${sent}, not ${value}`);
    }
  }
  if (JSON.stringify(outcome.effects) !== JSON.stringify(NO_EFFECTS)) {
    problems.push(`${at}: denial left effects ${JSON.stringify(outcome.effects)}`);
  }
  return problems;
}


/** One route × credential cell of the matrix. */
interface Cell {
  method: Method;
  url: string;
  subject: string;
  /** Whether the cell must be admitted: any status but 401 and 403. */
  allow: boolean;
  send: () => Promise<InjectResponse>;
}

/** A refused cell that expected admission, or an admitted one that expected refusal. */
interface Mismatch {
  method: Method;
  url: string;
  subject: string;
  status: number;
}

/** Subjects that present no credential at all, which must answer 401. */
const PRESENTS_NOTHING: ReadonlySet<string> = new Set(['anonymous', 'no-key']);

/** The EXPECTED row of `method` and `url`; throws TypeError when there is none. */
function routeOf(method: Method, url: string): ExpectedRoute {
  const route = EXPECTED.find((candidate) => candidate.method === method && candidate.url === url);
  if (route === undefined) throw new TypeError(`EXPECTED has no ${method} ${url}`);
  return route;
}

/** The push subscription a push row delivers to; throws TypeError for any other row. */
function subscriptionOf(route: ExpectedRoute): string {
  const subscription = PUSH_SUBSCRIPTIONS[route.url];
  if (subscription === undefined) throw new TypeError(`${keyOf(route)} is not a push route`);
  return subscription;
}

/** Sends `route`'s probe as `subject`, with the credential the route's transport takes from that subject. */
function sendAs(route: ExpectedRoute, subject: RoleSubject): () => Promise<InjectResponse> {
  if (route.transport === 'pubsub-push') {
    const subscription = subscriptionOf(route);
    if (subject.roles.includes(PUBSUB_INVOKER_ROLE)) return () => pushTo(t.app, subscription, envelopeFor(subscription));
    return async () => inject(pushRequest(subscription), await credentialsOf(subject));
  }
  if (route.transport === 'cloud-tasks' && subject.roles.includes(TASKS_INVOKER_ROLE)) {
    return async () => inject(probeRequest(route), await tasksInvokerCredentials());
  }
  return async () => inject(probeRequest(route), await credentialsOf(subject));
}

function cellOf(route: ExpectedRoute, subject: string, allow: boolean, send: () => Promise<InjectResponse>): Cell {
  return { method: route.method, url: route.url, subject, allow, send };
}

const PUSH_ROUTES = EXPECTED.filter((route) => route.transport === 'pubsub-push');
const TASK_ROUTES = EXPECTED.filter((route) => route.transport === 'cloud-tasks');

/** Managed-transport credentials outside ROLE_SET: a positive cell on every push and task route, and refused push keys. */
const EXTRA_CELLS: readonly Cell[] = [
  ...PUSH_ROUTES.flatMap((route) => {
    const subscription = subscriptionOf(route);
    return [
      cellOf(route, 'push-key', true, () => pushTo(t.app, subscription, envelopeFor(subscription))),
      cellOf(route, 'push-key-wrong', false, () => pushTo(t.app, subscription, envelopeFor(subscription), { key: WRONG_PUSH_KEY })),
      cellOf(route, 'no-key', false, () => inject(pushRequest(subscription), {})),
    ];
  }),
  ...TASK_ROUTES.map((route) =>
    cellOf(route, 'tasks-invoker', true, async () => inject(probeRequest(route), await tasksInvokerCredentials())),
  ),
];

const CELLS: readonly Cell[] = [
  ...EXPECTED.flatMap((route) =>
    ROLE_SET.map((subject) => cellOf(route, subject.name, route.allow.includes(subject.name), sendAs(route, subject))),
  ),
  ...EXTRA_CELLS,
];

function titleOf(cell: Pick<Cell, 'method' | 'url' | 'subject'>): string {
  return `${cell.method} ${cell.url} as ${cell.subject}`;
}

const outcomes = new Map<string, Outcome>();
const unexpectedAllows: Mismatch[] = [];
const unexpectedDenies: Mismatch[] = [];

/** Every way a probed cell departs from its expectation. */
function verdictOf(cell: Cell): string[] {
  const at = titleOf(cell);
  const outcome = outcomes.get(at);
  if (outcome === undefined) return [`${at}: not probed`];
  if (cell.allow) {
    return DENIED_STATUSES.has(outcome.status) ? [`${at}: expected admission, got ${outcome.status} ${outcome.body.slice(0, 160)}`] : [];
  }
  const problems = denialProblems(outcome, at);
  if (PRESENTS_NOTHING.has(cell.subject) && outcome.status !== 401) {
    problems.push(`${at}: no credential must answer 401, got ${outcome.status}`);
  }
  return problems;
}

beforeAll(async () => {
  t = await buildTestApp({ db: seededDb() });
  matrix = collectRouteMatrix(t.app);
});

afterAll(async () => {
  await t?.app.close();
});

describe('route declarations', () => {
  it('declared routes equal the expected table', () => {
    expect(declarations(matrix.routes)).toEqual(declarations(EXPECTED));
  });

  it('DELETE /opt2/stub/notes/:noteId requires [s2]', () => {
    expect(declaredRequires('DELETE', '/opt2/stub/notes/:noteId')).toEqual([Roles.s2]);
  });

  it('POST /opt2/stub/notes requires [system-user]', () => {
    expect(declaredRequires('POST', '/opt2/stub/notes')).toEqual([Roles.systemUser]);
  });

  it.each(['/opt2/stub/notes', '/opt2/stub/notes/:noteId', '/opt2/stub/notes/:noteId/projection'])(
    'GET %s requires member, system-user, site-admin and s2',
    (url) => {
      expect(declaredRequires('GET', url)).toEqual([Roles.member, Roles.systemUser, Roles.siteAdmin, Roles.s2].sort());
    },
  );

  it('every /internal/v1/migration/* route requires [platform.migration]', () => {
    const routes = matrix.routes.filter((route) => route.url.startsWith('/internal/v1/migration/'));
    expect(routes).toHaveLength(7);
    expect(routes.map((route) => route.requires)).toEqual(routes.map(() => [Roles.platformMigration]));
  });

  it('every task-queue route requires platform.migration and platform.operator', () => {
    const routes = matrix.routes.filter((route) => route.url.startsWith('/internal/v1/task-queues/'));
    expect(routes).toHaveLength(3);
    expect(routes.map((route) => [...(route.requires ?? [])].sort())).toEqual(
      routes.map(() => [Roles.platformMigration, Roles.platformOperator].sort()),
    );
  });

  it('ROLE_SET holds the minimum subjects, with other-tenant minted for another tenant', () => {
    expect(ROLE_SET.map((subject) => subject.name)).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS]));
    expect(subjectNamed('other-tenant').crossTenant).toBe(true);
  });

  it('literal subjects equal ROLE_SET', () => {
    expect([...EVERYONE].sort()).toEqual(ROLE_SET.map((subject) => subject.name).sort());
  });

  it('names only ROLE_SET subjects in allow lists', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    expect(EXPECTED.flatMap((route) => route.allow.filter((name) => !names.includes(name)))).toEqual([]);
  });
});

describe('route admission', () => {
  beforeAll(async () => {
    for (const cell of CELLS) {
      const outcome = await outcomeOf(cell.send);
      outcomes.set(titleOf(cell), outcome);
      const admitted = !DENIED_STATUSES.has(outcome.status);
      const mismatch: Mismatch = { method: cell.method, url: cell.url, subject: cell.subject, status: outcome.status };
      if (admitted && !cell.allow) unexpectedAllows.push(mismatch);
      if (!admitted && cell.allow) unexpectedDenies.push(mismatch);
    }
  }, 300_000);

  it('probes each route once per ROLE_SET subject and managed credential', () => {
    const titles = CELLS.map(titleOf);
    expect(new Set(titles).size).toBe(titles.length);
    expect(EXTRA_CELLS).toHaveLength(7);
    expect(CELLS).toHaveLength(EXPECTED.length * ROLE_SET.length + EXTRA_CELLS.length);
  });

  it.each(CELLS.map((cell) => [cell.method, cell.url, cell.subject, cell] as const))('%s %s as %s', (_method, _url, _subject, cell) => {
    expect(verdictOf(cell)).toEqual([]);
  });

  it('zero unexpected allows and denies', () => {
    expect({ unexpectedAllows, unexpectedDenies }).toEqual({ unexpectedAllows: [], unexpectedDenies: [] });
  });
});


describe('unrelated user roles', () => {
  const SERVICE_ROUTES = EXPECTED.filter((route) => route.transport === 'service' && route.requires !== undefined);
  const WORKLOAD_ROUTES = SERVICE_ROUTES.filter(
    (route) => route.url.startsWith('/internal/v1/migration/') || route.url.startsWith('/internal/v1/task-queues/'),
  );
  const NEAR_MISSES: readonly (readonly string[])[] = [
    [],
    ['unrelated'],
    ['system-user-x'],
    ['s2 '],
    ['S2'],
    ['site-admin.extra'],
    ['service:'],
    ['platform.'],
  ];
  const WORKLOAD_CLAIMS: readonly (readonly string[])[] = [
    ['platform.migration'],
    ['platform.operator'],
    ['service:migration'],
    ['service:operator'],
  ];
  const CASES = [
    ...SERVICE_ROUTES.flatMap((route) => NEAR_MISSES.map((roles) => ({ route, roles }))),
    ...WORKLOAD_ROUTES.flatMap((route) => WORKLOAD_CLAIMS.map((roles) => ({ route, roles }))),
  ].map(({ route, roles }) => ({ method: route.method, url: route.url, claim: JSON.stringify(roles), route, roles }));

  it.each(CASES)('$method $url refuses user roles $claim', async ({ route, roles, claim }) => {
    const userToken = await mintUserToken({ sub: 'test-unrelated-roles', tid: TENANT_A.tenantId, site: SITE_A, roles });
    const invocationToken = await mintServiceToken({ caller: 'gateway', audience: SERVICE });
    const outcome = await outcomeOf(() =>
      inject(probeRequest(route), {
        authorization: `Bearer ${userToken}`,
        [INVOCATION_HEADER]: `Bearer ${invocationToken}`,
      }),
    );
    expect({ status: outcome.status, problems: denialProblems(outcome, `${keyOf(route)} user roles ${claim}`) }).toEqual({
      status: 403,
      problems: [],
    });
  });
});

/** `data` of a legacy success envelope. */
function dataOf(body: unknown): unknown {
  return isRecord(body) ? body.data : undefined;
}

/** `noteid` of every item of a note list envelope. */
function noteIdsOf(body: unknown): unknown[] {
  const data = dataOf(body);
  const items = isRecord(data) ? data.items : undefined;
  return Array.isArray(items) ? items.map((item: unknown) => (isRecord(item) ? item.noteid : undefined)) : [];
}

describe('tenant visibility', () => {
  let v: TestApp;

  beforeAll(async () => {
    // Its own app and store: the matrix's s2 delete removes the seeded note from the main one.
    v = await buildTestApp({ db: seededDb(true) });
  });

  afterAll(async () => {
    await v?.app.close();
  });

  /** Status, parsed body and transaction tenants of one GET on the visibility app. */
  async function readAs(subject: string, url: string): Promise<{ status: number; body: unknown; tenants: string[] }> {
    const headers = await credentialsOf(subjectNamed(subject));
    v.db.clear();
    const res = await v.app.inject({ method: 'GET', url, headers });
    const tenants = new Set(v.db.queries.flatMap((query) => (query.tenantId === null ? [] : [query.tenantId.toLowerCase()])));
    return { status: res.statusCode, body: parsedBody(res.body), tenants: [...tenants] };
  }

  it.each([NOTE_URL, PROJECTION_URL])('GET %s as site-admin', async (url) => {
    const read = await readAs('site-admin', url);
    expect(read.status).toBe(200);
    expect(dataOf(read.body)).toMatchObject({ noteid: NOTE_ID });
  });

  it.each([NOTE_URL, PROJECTION_URL])('GET %s as other-tenant', async (url) => {
    const read = await readAs('other-tenant', url);
    expect({ status: read.status, envelope: isErrorEnvelope(read.body), tenants: read.tenants }).toEqual({
      status: 404,
      envelope: true,
      tenants: [TENANT_B.tenantId.toLowerCase()],
    });
  });

  it('GET /opt2/stub/notes as site-admin and other-tenant', async () => {
    const own = await readAs('site-admin', '/opt2/stub/notes');
    expect(own.status).toBe(200);
    expect(noteIdsOf(own.body)).toContain(NOTE_ID);
    const other = await readAs('other-tenant', '/opt2/stub/notes');
    expect({ status: other.status, seeded: noteIdsOf(other.body).includes(NOTE_ID), tenants: other.tenants }).toEqual({
      status: 200,
      seeded: false,
      tenants: [TENANT_B.tenantId.toLowerCase()],
    });
  });
});

describe('transport separation', () => {
  const sweep = (): ProbeRequest => probeRequest(routeOf('POST', '/internal/v1/outbox/sweep'));
  const noCredential = async (): Promise<Record<string, string>> => ({});
  const pubsubServiceToken = async (): Promise<Record<string, string>> => ({
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'pubsub-invoker', audience: SERVICE, roles: [PUBSUB_INVOKER_ROLE] })}`,
  });

  const CASES: ReadonlyArray<{ title: string; request: () => ProbeRequest; credentials: () => Promise<Record<string, string>> }> = [
    ...[NOTE_CREATED_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION].flatMap((subscription) => [
      { title: `user token on push ${subscription}`, request: () => pushRequest(subscription), credentials: invokerClaimingUserToken },
      {
        title: `pubsub-invoker service token on push ${subscription}`,
        request: () => pushRequest(subscription),
        credentials: pubsubServiceToken,
      },
    ]),
    { title: 'user token on POST /internal/v1/outbox/sweep', request: sweep, credentials: invokerClaimingUserToken },
    { title: 'push key on POST /internal/v1/outbox/sweep', request: () => withPushKey(sweep()), credentials: noCredential },
    {
      title: 'tasks-invoker token on POST /opt2/stub/notes',
      request: () => probeRequest(routeOf('POST', '/opt2/stub/notes')),
      credentials: tasksInvokerCredentials,
    },
    {
      title: 'tasks-invoker token on POST /internal/v1/migration/apply',
      request: () => probeRequest(routeOf('POST', '/internal/v1/migration/apply')),
      credentials: tasksInvokerCredentials,
    },
    {
      title: 'push key on GET /opt2/stub/notes',
      request: () => withPushKey(probeRequest(routeOf('GET', '/opt2/stub/notes'))),
      credentials: noCredential,
    },
    {
      title: 'push key on POST /internal/v1/migration/gate',
      request: () => withPushKey(probeRequest(routeOf('POST', '/internal/v1/migration/gate'))),
      credentials: noCredential,
    },
  ];

  it.each(CASES)('refuses $title', async ({ title, request, credentials }) => {
    const presented = await credentials();
    const outcome = await outcomeOf(() => inject(request(), presented));
    expect(denialProblems(outcome, title)).toEqual([]);
  });
});

describe('deny by default at start-up', () => {
  /** Builds a not-yet-ready stub app, lets `declare` add a route and awaits `ready`; the app and its state directory are always removed. */
  async function startWith(declare: (app: FastifyInstance) => unknown): Promise<void> {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-stub-authz-'));
    let app: FastifyInstance | undefined;
    try {
      await writeTestSecrets(stateDir);
      app = await buildApp({
        env: loadEnv(baseEnvSchema, testEnv({ OPT2_STATE_DIR: stateDir })),
        clock: TEST_CLOCK,
        verifierOverride: testVerifier(),
        db: createRecordingDb(),
        publisher: createCapturingPublisher(),
        taskPort: createFakeTaskPort(),
      });
      declare(app);
      await app.ready();
    } finally {
      await app?.close().catch(() => undefined);
      await rm(stateDir, { recursive: true, force: true });
    }
  }

  it.each<[string, (app: FastifyInstance) => unknown]>([
    ['no config.opt2', (app) => app.get('/opt2/stub/undeclared', async () => ({}))],
    ['an empty requires list', (app) => app.get('/opt2/stub/undeclared', { config: { opt2: { requires: [] } } }, async () => ({}))],
  ])('fails start-up for a route with %s', async (_label, declare) => {
    await expect(startWith(declare)).rejects.toBeInstanceOf(UndeclaredRouteError);
  });
});

