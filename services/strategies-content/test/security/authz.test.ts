/** In-process authorisation matrix of every strategies-content route: declarations, admitted subjects, tenant and transport boundaries. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  renderAuthDenial,
  serviceRole,
  type DenialResponse,
  type Role,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, type EventEnvelope } from '@opt2/platform/events';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TEST_PUSH_KEY,
  authHeadersFor,
  fixtureForTenant,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  poolTenantExpectation,
  pushTo,
  registryPayloads,
  subjectSiteFor,
  testEnvelope,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import {
  GROUP_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_TOPIC,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
} from '../../src/events/consumers.js';
import { SERVICE, buildContentApp, serviceHeaders, userHeaders, type ContentTestApp } from '../helpers/app.js';

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const FILE_ID = 'B1C2D3E4-0001-4A5B-8C7D9E0F1A2B3C4D';
const GROUP_ID = 'A1B2C3D4-0001-4A5B-8C7D9E0F1A2B3C4D';
const USER_ID = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const OBJECT_BYTES = Buffer.from('strategies-content authz probe');
const OWN_QUEUE = 'content-scheduled-publish';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const WRONG_PUSH_KEY = 'opt2-wrong-push-key';
const DENIED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;

const pushUrl = (subscription: string): string => `/internal/v1/events/${subscription}`;

type Method = 'GET' | 'POST' | 'DELETE';

/** One registered route, its declaration, and how its probe answers once admitted. */
interface ExpectedRoute {
  method: Method;
  url: string;
  transport: Transport;
  requires?: readonly Role[];
  public?: true;
  /** The handler acts for a forwarded user token and refuses a caller that presents none. */
  actsForUser?: true;
  /** The probe supplies `siteid` tenant-a, which the site check compares with the user token's site. */
  probesSite?: true;
  /** Status of the probe once every check admits it. */
  admitted: number;
}

const HEADER_PROMPT_ROLES: readonly Role[] = [Roles.s2, Roles.siteAdmin, Roles.systemUser];
const MIGRATION_ONLY: readonly Role[] = [Roles.platformMigration];
const QUEUE_CONTROLLERS: readonly Role[] = [Roles.platformMigration, Roles.platformOperator];
const PUSH_INVOKER: readonly Role[] = [PUBSUB_INVOKER_ROLE];

const EXPECTED: readonly ExpectedRoute[] = [
  { method: 'GET', url: '/healthz', transport: 'service', public: true, admitted: 200 },
  {
    method: 'GET',
    url: '/v1/sites/:siteid/header-prompts',
    transport: 'service',
    requires: HEADER_PROMPT_ROLES,
    actsForUser: true,
    probesSite: true,
    admitted: 200,
  },
  {
    method: 'POST',
    url: '/internal/v1/files::lookup',
    transport: 'service',
    requires: [serviceRole('people'), serviceRole('identity')],
    actsForUser: true,
    admitted: 200,
  },
  { method: 'POST', url: '/internal/v1/migration/objects', transport: 'service', requires: MIGRATION_ONLY, admitted: 200 },
  { method: 'GET', url: '/internal/v1/migration/objects', transport: 'service', requires: MIGRATION_ONLY, admitted: 404 },
  { method: 'POST', url: '/internal/v1/migration/apply', transport: 'service', requires: MIGRATION_ONLY, admitted: 400 },
  { method: 'GET', url: '/internal/v1/migration/export', transport: 'service', requires: MIGRATION_ONLY, admitted: 200 },
  { method: 'GET', url: '/internal/v1/migration/changes', transport: 'service', requires: MIGRATION_ONLY, admitted: 200 },
  { method: 'GET', url: '/internal/v1/migration/position', transport: 'service', requires: MIGRATION_ONLY, admitted: 200 },
  { method: 'GET', url: '/internal/v1/migration/watermark', transport: 'service', requires: MIGRATION_ONLY, admitted: 200 },
  { method: 'POST', url: '/internal/v1/migration/watermark', transport: 'service', requires: MIGRATION_ONLY, admitted: 400 },
  { method: 'POST', url: '/internal/v1/migration/gate', transport: 'service', requires: MIGRATION_ONLY, admitted: 200 },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/pause', transport: 'service', requires: QUEUE_CONTROLLERS, admitted: 200 },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/resume', transport: 'service', requires: QUEUE_CONTROLLERS, admitted: 200 },
  // content-scheduled-publish, the only queue this service creates tasks on, is not a recurring chain.
  { method: 'POST', url: '/internal/v1/task-queues/:queue/ensure', transport: 'service', requires: QUEUE_CONTROLLERS, admitted: 400 },
  ...[SITE_CHANGED_SUBSCRIPTION, GROUP_CHANGED_SUBSCRIPTION, PERMISSION_CHANGED_SUBSCRIPTION, MEMBERSHIP_CHANGED_SUBSCRIPTION].map(
    (subscription): ExpectedRoute => ({ method: 'POST', url: pushUrl(subscription), transport: 'pubsub-push', requires: PUSH_INVOKER, admitted: 204 }),
  ),
];

/** One concrete request; a subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: Method;
  url: string;
  payload?: Record<string, unknown> | Buffer;
  headers?: Record<string, string>;
}

/** Handler effects of one request: statements on the pool, published messages and task-port calls. */
interface Effects {
  statements: number;
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

const NO_EFFECTS: Effects = { statements: 0, published: 0, tasks: 0 };

let t: ContentTestApp;
let matrix: RouteMatrix;

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

function subjectNamed(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return subject;
}

/** The EXPECTED row of `method` and `url`; throws TypeError when there is none. */
function routeOf(method: Method, url: string): ExpectedRoute {
  const route = EXPECTED.find((candidate) => candidate.method === method && candidate.url === url);
  if (route === undefined) throw new TypeError(`EXPECTED has no ${method} ${url}`);
  return route;
}

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Record<string, string>> }>();

// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `authHeadersFor(subject)` on tenant-a, reused across probes while its tokens are fresh. */
function credentialsOf(subject: RoleSubject): Promise<Record<string, string>> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = authHeadersFor(subject, { site: SITE_A, audience: SERVICE, sub: USER_ID });
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

async function tasksInvokerCredentials(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
}

/** A user token of tenant-a claiming both managed invoker roles and s2. */
async function invokerClaimingUserToken(): Promise<Record<string, string>> {
  const token = await mintUserToken({ sub: USER_ID, site: SITE_A, roles: [PUBSUB_INVOKER_ROLE, TASKS_INVOKER_ROLE, Roles.s2] });
  return { authorization: `Bearer ${token}` };
}

/** A fresh contract-valid tenant-a envelope of the topic `subscription` consumes. */
function envelopeFor(subscription: string): EventEnvelope {
  const tenantId = TENANT_A.tenantId;
  switch (subscription) {
    case SITE_CHANGED_SUBSCRIPTION: {
      const site = registryPayloads().find((payload) => payload.siteId === SITE_A);
      if (site === undefined) throw new TypeError(`registryPayloads has no ${SITE_A} payload`);
      return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId, aggregateId: SITE_A, payload: site });
    }
    case GROUP_CHANGED_SUBSCRIPTION:
      return testEnvelope({
        topic: GROUP_CHANGED_TOPIC,
        tenantId,
        aggregateId: GROUP_ID,
        payload: { groupId: GROUP_ID, siteId: SITE_A, groupName: 'Content Editors', type: 1, isPublic: 0, poolTenantId: tenantId, deleted: false },
      });
    case PERMISSION_CHANGED_SUBSCRIPTION:
      return testEnvelope({
        topic: PERMISSION_CHANGED_TOPIC,
        tenantId,
        aggregateType: 'group',
        aggregateId: GROUP_ID,
        payload: { groupId: GROUP_ID, siteId: SITE_A, rows: [{ contentId: '00000000000000000000000000000000001', siteId: SITE_A, type: 'Editor' }] },
      });
    case MEMBERSHIP_CHANGED_SUBSCRIPTION:
      return testEnvelope({
        topic: MEMBERSHIP_CHANGED_TOPIC,
        tenantId,
        aggregateType: 'user',
        aggregateId: USER_ID,
        payload: { userId: USER_ID, siteId: SITE_A, groupIds: [GROUP_ID] },
      });
    default:
      throw new TypeError(`No envelope for subscription ${subscription}`);
  }
}

/** The push subscription a push row delivers to; throws TypeError for any other row. */
function subscriptionOf(route: ExpectedRoute): string {
  if (route.transport !== 'pubsub-push') throw new TypeError(`${keyOf(route)} is not a push route`);
  return route.url.slice(pushUrl('').length);
}

/** A push delivery to `subscription` without the push key. */
function pushRequest(subscription: string): ProbeRequest {
  const body = buildPushBody({ data: encodeEnvelope(envelopeFor(subscription)), messageId: randomUUID(), subscription });
  return { method: 'POST', url: pushUrl(subscription), headers: JSON_HEADERS, payload: { ...body } };
}

function withPushKey(request: ProbeRequest): ProbeRequest {
  return { ...request, url: `${request.url}${request.url.includes('?') ? '&' : '?'}key=${TEST_PUSH_KEY}` };
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The request each non-push row is probed with: tenant-a ids and this service's own queue. */
const PROBES: Readonly<Record<string, () => ProbeRequest>> = {
  'GET /healthz': () => ({ method: 'GET', url: '/healthz' }),
  'GET /v1/sites/:siteid/header-prompts': () => ({ method: 'GET', url: `/v1/sites/${SITE_A}/header-prompts` }),
  'POST /internal/v1/files::lookup': () => ({
    method: 'POST',
    url: '/internal/v1/files:lookup',
    headers: JSON_HEADERS,
    payload: { fileIds: [FILE_ID] },
  }),
  'POST /internal/v1/migration/objects': () => ({
    method: 'POST',
    url: `/internal/v1/migration/objects?${new URLSearchParams({
      tenantId: TENANT_A.tenantId,
      fileId: FILE_ID,
      variant: '',
      ext: 'png',
      contentType: 'image/png',
      sha256: sha256(OBJECT_BYTES),
    }).toString()}`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: OBJECT_BYTES,
  }),
  'GET /internal/v1/migration/objects': () => ({
    method: 'GET',
    url: `/internal/v1/migration/objects?key=${encodeURIComponent(`${TENANT_A.tenantId}/${FILE_ID}.png`)}`,
  }),
  'POST /internal/v1/migration/apply': () => ({ method: 'POST', url: '/internal/v1/migration/apply', headers: JSON_HEADERS, payload: {} }),
  'GET /internal/v1/migration/export': () => ({
    method: 'GET',
    url: `/internal/v1/migration/export?unit=content.file&tenantId=${TENANT_A.tenantId}`,
  }),
  'GET /internal/v1/migration/changes': () => ({ method: 'GET', url: `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}` }),
  'GET /internal/v1/migration/position': () => ({ method: 'GET', url: '/internal/v1/migration/position' }),
  'GET /internal/v1/migration/watermark': () => ({ method: 'GET', url: '/internal/v1/migration/watermark' }),
  'POST /internal/v1/migration/watermark': () => ({ method: 'POST', url: '/internal/v1/migration/watermark', headers: JSON_HEADERS, payload: {} }),
  'POST /internal/v1/migration/gate': () => ({
    method: 'POST',
    url: '/internal/v1/migration/gate',
    headers: JSON_HEADERS,
    payload: { op: 'status', units: ['content.file'] },
  }),
  'POST /internal/v1/task-queues/:queue/pause': () => ({ method: 'POST', url: `/internal/v1/task-queues/${OWN_QUEUE}/pause`, headers: JSON_HEADERS, payload: {} }),
  'POST /internal/v1/task-queues/:queue/resume': () => ({ method: 'POST', url: `/internal/v1/task-queues/${OWN_QUEUE}/resume`, headers: JSON_HEADERS, payload: {} }),
  'POST /internal/v1/task-queues/:queue/ensure': () => ({ method: 'POST', url: `/internal/v1/task-queues/${OWN_QUEUE}/ensure`, headers: JSON_HEADERS, payload: {} }),
};

/** The request a row is probed with. */
function probeRequest(route: ExpectedRoute): ProbeRequest {
  if (route.transport === 'pubsub-push') return pushRequest(subscriptionOf(route));
  const probe = PROBES[keyOf(route)];
  if (probe === undefined) throw new TypeError(`No probe for ${keyOf(route)}`);
  return probe();
}

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

/** Sends one probe and records its answer and effects. */
async function outcomeOf(send: () => Promise<InjectResponse>): Promise<Outcome> {
  t.db.clear();
  t.publisher.clear();
  t.taskPort.calls.length = 0;
  const res = await send();
  const sentUrl = new URL(res.raw.req.url ?? '/', 'http://strategies-content.test');
  const headers = Object.fromEntries(Object.entries(res.headers).map(([name, value]) => [name, String(value)]));
  return {
    status: res.statusCode,
    body: res.body,
    headers,
    query: Object.fromEntries(sentUrl.searchParams),
    effects: {
      statements: t.db.statements.length,
      published: t.publisher.published.length + t.publisher.raw.length,
      tasks: t.taskPort.calls.length,
    },
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
  return typeof apiversion === 'string' && typeof method === 'string' && typeof error.code === 'string' && typeof error.message === 'string';
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

/** Every way `outcome` departs from a refusal before any handler work: 401 or 403, the exact rendered envelope and headers, no effect. */
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
  /** Status the cell must answer when admitted; undefined when it must be refused. */
  admitted: number | undefined;
  send: () => Promise<InjectResponse>;
}

/** Subjects that present no credential at all, which must answer 401. */
const PRESENTS_NOTHING: ReadonlySet<string> = new Set(['anonymous', 'no-key']);

/** Roles the route's transport verifies from what `subject` presents; null when the transport refuses the credential itself. */
function verifiedRoles(route: ExpectedRoute, subject: RoleSubject): readonly Role[] | null {
  const invoker = (role: Role): readonly Role[] => (subject.roles.includes(role) ? [role] : []);
  switch (route.transport) {
    case 'pubsub-push':
      return invoker(PUBSUB_INVOKER_ROLE);
    case 'cloud-tasks':
      return invoker(TASKS_INVOKER_ROLE);
    case 'service':
      // authHeadersFor sends the tasks invoker's token in Authorization, which this transport verifies as a user token,
      // so it is refused even on a public route.
      if (subject.roles.includes(TASKS_INVOKER_ROLE)) return null;
      // The push invoker's only credential is the push key, so it presents nothing here.
      if (subject.roles.includes(PUBSUB_INVOKER_ROLE)) return [];
      // A user's call arrives with the gateway's invocation credential.
      return subject.kind === 'user' ? [...subject.roles, serviceRole('gateway')] : subject.roles;
  }
}

/** Whether every check admits `subject`: the transport, the route's roles, the handler's user and the token's site. */
function admits(route: ExpectedRoute, subject: RoleSubject): boolean {
  const roles = verifiedRoles(route, subject);
  if (roles === null || !(route.public === true || hasAnyRole(roles, route.requires ?? []))) return false;
  if (route.actsForUser === true && subject.kind !== 'user') return false;
  return route.probesSite !== true || subject.kind !== 'user' || subjectSiteFor(subject, SITE_A) === SITE_A;
}

/** Sends `route`'s probe as `subject`, with the credential the route's transport takes from that subject. */
function sendAs(route: ExpectedRoute, subject: RoleSubject): () => Promise<InjectResponse> {
  if (route.transport === 'pubsub-push') {
    const subscription = subscriptionOf(route);
    if (subject.roles.includes(PUBSUB_INVOKER_ROLE)) return () => pushTo(t.app, subscription, envelopeFor(subscription));
  }
  return async () => inject(probeRequest(route), await credentialsOf(subject));
}

function cellOf(route: ExpectedRoute, subject: string, allow: boolean, send: () => Promise<InjectResponse>): Cell {
  return { method: route.method, url: route.url, subject, admitted: allow ? route.admitted : undefined, send };
}

const PUSH_ROUTES = EXPECTED.filter((route) => route.transport === 'pubsub-push');
const LOOKUP = routeOf('POST', '/internal/v1/files::lookup');
const PEOPLE_USER = { sub: USER_ID, roles: [Roles.systemUser] } as const;

/** Credentials outside ROLE_SET: push keys on every push route, and people or identity forwarding a user token to the file lookup. */
const EXTRA_CELLS: readonly Cell[] = [
  ...PUSH_ROUTES.flatMap((route) => {
    const subscription = subscriptionOf(route);
    return [
      cellOf(route, 'push-key', true, () => pushTo(t.app, subscription, envelopeFor(subscription))),
      cellOf(route, 'push-key-wrong', false, () => pushTo(t.app, subscription, envelopeFor(subscription), { key: WRONG_PUSH_KEY })),
      cellOf(route, 'no-key', false, () => inject(pushRequest(subscription), {})),
    ];
  }),
  ...['people', 'identity'].flatMap((caller) => [
    cellOf(LOOKUP, `${serviceRole(caller)} for a tenant-a user`, true, async () =>
      inject(probeRequest(LOOKUP), await serviceHeaders(caller, { ...PEOPLE_USER, site: SITE_A })),
    ),
    cellOf(LOOKUP, `${serviceRole(caller)} for a tenant-b user`, true, async () =>
      inject(probeRequest(LOOKUP), await serviceHeaders(caller, { ...PEOPLE_USER, site: SITE_B })),
    ),
    cellOf(LOOKUP, `${serviceRole(caller)} for a tenant-b user naming tenant-a`, false, async () => {
      const request = probeRequest(LOOKUP);
      return inject({ ...request, url: `${request.url}?siteid=${SITE_A}` }, await serviceHeaders(caller, { ...PEOPLE_USER, site: SITE_B }));
    }),
  ]),
];

const CELLS: readonly Cell[] = [
  ...EXPECTED.flatMap((route) => ROLE_SET.map((subject) => cellOf(route, subject.name, admits(route, subject), sendAs(route, subject)))),
  ...EXTRA_CELLS,
];

function titleOf(cell: Pick<Cell, 'method' | 'url' | 'subject'>): string {
  return `${cell.method} ${cell.url} as ${cell.subject}`;
}

const outcomes = new Map<string, Outcome>();
const unexpectedAllows: string[] = [];
const unexpectedDenies: string[] = [];

/** Every way a probed cell departs from its expectation. */
function verdictOf(cell: Cell): string[] {
  const at = titleOf(cell);
  const outcome = outcomes.get(at);
  if (outcome === undefined) return [`${at}: not probed`];
  if (cell.admitted !== undefined) {
    return outcome.status === cell.admitted ? [] : [`${at}: expected ${cell.admitted}, got ${outcome.status} ${outcome.body.slice(0, 160)}`];
  }
  const problems = denialProblems(outcome, at);
  if (PRESENTS_NOTHING.has(cell.subject) && outcome.status !== 401) {
    problems.push(`${at}: no credential must answer 401, got ${outcome.status}`);
  }
  return problems;
}

beforeAll(async () => {
  t = await buildContentApp();
  matrix = collectRouteMatrix(t.app);
});

afterAll(async () => {
  await t?.close();
});

describe('route declarations', () => {
  it('declared routes equal the expected table', () => {
    expect(declarations(matrix.routes)).toEqual(declarations(EXPECTED));
  });

  it('ROLE_SET holds the minimum subjects, every synthetic role and every service caller', () => {
    expect(ROLE_SET.map((subject) => subject.name)).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS]));
    expect(subjectNamed('other-tenant').crossTenant).toBe(true);
    expect(ROLE_SET.filter((subject) => subject.kind === 'service').map((subject) => subject.name)).toEqual(
      expect.arrayContaining([serviceRole('people'), serviceRole('migration'), serviceRole('operator'), PUBSUB_INVOKER_ROLE, TASKS_INVOKER_ROLE]),
    );
  });
});

describe('route admission', () => {
  beforeAll(async () => {
    for (const cell of CELLS) {
      const outcome = await outcomeOf(cell.send);
      outcomes.set(titleOf(cell), outcome);
      const denied = DENIED_STATUSES.has(outcome.status);
      if (!denied && cell.admitted === undefined) unexpectedAllows.push(`${titleOf(cell)}: ${outcome.status}`);
      if (denied && cell.admitted !== undefined) unexpectedDenies.push(`${titleOf(cell)}: ${outcome.status}`);
    }
  }, 300_000);

  it('probes each route once per ROLE_SET subject and extra credential', () => {
    const titles = CELLS.map(titleOf);
    expect(new Set(titles).size).toBe(titles.length);
    expect(CELLS).toHaveLength(EXPECTED.length * ROLE_SET.length + EXTRA_CELLS.length);
  });

  it('admits at least one credential and refuses at least one on every route', () => {
    const coverage = EXPECTED.map((route) => {
      const cells = CELLS.filter((cell) => cell.method === route.method && cell.url === route.url);
      return { route: keyOf(route), admitted: cells.some((cell) => cell.admitted !== undefined), refused: cells.some((cell) => cell.admitted === undefined) };
    });
    expect(coverage).toEqual(EXPECTED.map((route) => ({ route: keyOf(route), admitted: true, refused: true })));
  });

  it.each(CELLS.map((cell) => [cell.method, cell.url, cell.subject, cell] as const))('%s %s as %s', (_method, _url, _subject, cell) => {
    expect(verdictOf(cell)).toEqual([]);
  });

  it('zero unexpected allows and denies', () => {
    expect({ unexpectedAllows, unexpectedDenies }).toEqual({ unexpectedAllows: [], unexpectedDenies: [] });
  });
});

describe('transport separation', () => {
  const noCredential = async (): Promise<Record<string, string>> => ({});
  const pubsubServiceToken = async (): Promise<Record<string, string>> => ({
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'pubsub-invoker', audience: SERVICE, roles: [PUBSUB_INVOKER_ROLE] })}`,
  });
  const probe = (method: Method, url: string) => (): ProbeRequest => probeRequest(routeOf(method, url));

  const CASES: ReadonlyArray<{ title: string; request: () => ProbeRequest; credentials: () => Promise<Record<string, string>> }> = [
    ...PUSH_ROUTES.flatMap((route) => [
      { title: `user token on push ${route.url}`, request: () => pushRequest(subscriptionOf(route)), credentials: invokerClaimingUserToken },
      { title: `pubsub-invoker service token on push ${route.url}`, request: () => pushRequest(subscriptionOf(route)), credentials: pubsubServiceToken },
      { title: `tasks-invoker token on push ${route.url}`, request: () => pushRequest(subscriptionOf(route)), credentials: tasksInvokerCredentials },
    ]),
    ...(
      [
        ['GET', '/v1/sites/:siteid/header-prompts'],
        ['POST', '/internal/v1/files::lookup'],
        ['POST', '/internal/v1/migration/objects'],
        ['POST', '/internal/v1/migration/apply'],
        ['POST', '/internal/v1/task-queues/:queue/pause'],
      ] as const
    ).flatMap(([method, url]) => [
      { title: `tasks-invoker token on ${method} ${url}`, request: probe(method, url), credentials: tasksInvokerCredentials },
      { title: `push key on ${method} ${url}`, request: () => withPushKey(probe(method, url)()), credentials: noCredential },
      { title: `invoker-claiming user token alone on ${method} ${url}`, request: probe(method, url), credentials: invokerClaimingUserToken },
    ]),
  ];

  it.each(CASES)('refuses $title', async ({ title, request, credentials }) => {
    const presented = await credentials();
    const outcome = await outcomeOf(() => inject(request(), presented));
    expect(denialProblems(outcome, title)).toEqual([]);
  });
});

describe('tenant boundaries', () => {
  /** Status and the tenants of every tenant transaction one request ran. */
  async function tenantsOf(send: () => Promise<InjectResponse>): Promise<{ status: number; tenants: string[] }> {
    const outcome = await outcomeOf(send);
    const tenants = new Set(t.db.statements.flatMap((statement) => (statement.tenantId === null ? [] : [statement.tenantId.toLowerCase()])));
    return { status: outcome.status, tenants: [...tenants].sort() };
  }

  /** The file-pool tenants of the public and private user pools of fixture `tenantId`, as the photo lookup reads them. */
  function photoFileTenants(tenantId: string): string[] {
    const fixture = fixtureForTenant(tenantId);
    if (fixture === undefined) throw new TypeError(`No tenant fixture for ${tenantId}`);
    const pools = (['publicUser', 'privateUser'] as const).map((kind) => {
      const userPool = fixtureForTenant(poolTenantExpectation(fixture, kind));
      if (userPool === undefined) throw new TypeError(`No fixture for the ${kind} pool of ${fixture.siteId}`);
      return poolTenantExpectation(userPool, 'file');
    });
    return [...new Set(pools)].sort();
  }

  it.each([
    ['an S2 user of tenant-a reads tenant-b', [Roles.s2], SITE_A, SITE_B, ''],
    ['a site admin of tenant-b reads tenant-a', [Roles.systemUser, Roles.siteAdmin], SITE_B, SITE_A, ''],
    ['a system user of tenant-a names tenant-b in the query', [Roles.systemUser], SITE_A, SITE_A, `?siteid=${SITE_B}`],
  ])('refuses getHeaderPrompts when %s', async (title, roles, tokenSite, pathSite, query) => {
    const headers = await userHeaders({ sub: USER_ID, site: tokenSite, roles });
    const outcome = await outcomeOf(() => t.app.inject({ method: 'GET', url: `/v1/sites/${pathSite}/header-prompts${query}`, headers }));
    expect(outcome.status).toBe(403);
    expect(denialProblems(outcome, title)).toEqual([]);
  });

  it.each([
    ['a site admin', [Roles.systemUser, Roles.siteAdmin], [TENANT_B.tenantId]],
    ['a system user, whose groups sit in its private user pool', [Roles.systemUser], [TENANT_B.tenantId, poolTenantExpectation(TENANT_B, 'privateUser')]],
  ])('getHeaderPrompts of tenant-b as %s runs only in tenant-b and its pool', async (_label, roles, expected) => {
    const headers = await userHeaders({ sub: USER_ID, site: SITE_B, roles });
    const read = await tenantsOf(() => t.app.inject({ method: 'GET', url: `/v1/sites/${SITE_B}/header-prompts`, headers }));
    expect(read).toEqual({ status: 200, tenants: [...new Set(expected.map((id) => id.toLowerCase()))].sort() });
  });

  it.each([TENANT_A, TENANT_B])('the file lookup for a $siteId user reads only that site’s photo file pools', async (fixture) => {
    const headers = await serviceHeaders('people', { ...PEOPLE_USER, site: fixture.siteId });
    const read = await tenantsOf(() => inject(probeRequest(LOOKUP), headers));
    expect(read).toEqual({ status: 200, tenants: photoFileTenants(fixture.tenantId) });
  });

  it('dead-letters a site delivery whose envelope tenant is not the site’s, writing nothing', async () => {
    const site = envelopeFor(SITE_CHANGED_SUBSCRIPTION);
    const outcome = await outcomeOf(() => pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, { ...site, tenantId: TENANT_B.tenantId }));
    expect(outcome.status).toBe(204);
    expect(t.db.statements.filter((statement) => /^INSERT INTO "?content"?\."?tenant_registry"?/i.test(statement.sql))).toEqual([]);
    expect(t.publisher.deadLetters(SITE_CHANGED_SUBSCRIPTION)).toHaveLength(1);
  });
});

describe('undeclared routes', () => {
  it.each<[string, (app: FastifyInstance) => unknown]>([
    ['no config.opt2', (app) => app.get('/v1/sites/:siteid/undeclared', async () => ({}))],
    ['an empty requires list', (app) => app.get('/v1/sites/:siteid/undeclared', { config: { opt2: { requires: [] } } }, async () => ({}))],
    [
      'both requires and public',
      (app) => app.get('/v1/sites/:siteid/undeclared', { config: { opt2: { requires: [Roles.s2], public: true } } }, async () => ({})),
    ],
    [
      'a push path on the service transport',
      (app) => app.post(pushUrl('strategies-content.undeclared.v1'), { config: { opt2: { requires: [PUBSUB_INVOKER_ROLE] } } }, async () => ({})),
    ],
  ])('fails start-up for a route with %s', async (_label, declare) => {
    await expect(buildContentApp({ declare })).rejects.toBeInstanceOf(UndeclaredRouteError);
  });

  it.each([
    ['GET', '/v1/sites/tenant-a/undeclared', 's2'],
    ['GET', '/internal/v1/undeclared', 'service:migration'],
    ['DELETE', '/internal/v1/migration/objects', 'service:migration'],
    ['POST', '/v1/sites/tenant-a/header-prompts', 's2'],
    ['GET', '/v1/sites/tenant-a/undeclared', 'anonymous'],
  ] as const)('answers %s %s as %s with the legacy 404 and no effect', async (method, url, subject) => {
    const outcome = await outcomeOf(async () => t.app.inject({ method, url, headers: await credentialsOf(subjectNamed(subject)) }));
    expect({ status: outcome.status, envelope: isErrorEnvelope(parsedBody(outcome.body)), effects: outcome.effects }).toEqual({
      status: 404,
      envelope: true,
      effects: NO_EFFECTS,
    });
  });
});
