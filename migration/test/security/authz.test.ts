// In-process authorisation matrix of every route the migration registrars declare: declarations, admitted subjects with no
// unexpected allow, effect-free denials, transport separation and deny-by-default start-up.
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
  type Opt2RouteConfig,
  type Role,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TEST_PUSH_KEY,
  authHeadersFor,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SERVICE, buildRouteApp, memoryMigrationDb, type Effects, type RouteApp } from '../helpers/route-app.js';

const SITE_A = TENANT_A.siteId;
const DENIED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const NO_EFFECTS: Effects = { transactions: 0, statements: 0, serviceCalls: 0, bridgeCalls: 0, legacyReads: 0, faultToggles: 0 };

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

const USERS = ['member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant', ...SYNTHETIC] as const;
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

/** Every user arrives with the gateway's invocation credential, so a gateway route admits them beside the gateway. */
const THROUGH_GATEWAY: readonly string[] = [...USERS, 'service:gateway'];

/** Public on the service transport: a managed tasks token is still verified, and refused, as a user token. */
const PUBLIC_ADMITTED = EVERYONE.filter((name) => name !== 'service:tasks-invoker');

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A route's declaration and independently admitted subject names. */
interface ExpectedRoute {
  method: Method;
  url: string;
  transport: Transport;
  requires?: readonly Role[];
  public?: true;
  siteCheck?: false;
  allow: readonly string[];
  /** Status of an admitted request; 200 when absent. */
  admitted?: number;
}

const OPERATOR_ONLY: readonly Role[] = [Roles.platformOperator];

const EXPECTED: readonly ExpectedRoute[] = [
  { method: 'GET', url: '/healthz', transport: 'service', public: true, allow: PUBLIC_ADMITTED },
  {
    method: 'GET',
    url: '/internal/v1/authority',
    transport: 'service',
    requires: ['service:programs-sites', 'service:gateway', Roles.platformOperator],
    allow: [...THROUGH_GATEWAY, 'service:programs-sites', 'service:operator'],
  },
  { method: 'POST', url: '/internal/v1/background::resume', transport: 'service', requires: OPERATOR_ONLY, allow: ['service:operator'] },
  { method: 'POST', url: '/internal/v1/background::suspend', transport: 'service', requires: OPERATOR_ONLY, allow: ['service:operator'] },
  { method: 'PUT', url: '/internal/v1/faults/:name', transport: 'service', requires: OPERATOR_ONLY, allow: ['service:operator'], admitted: 204 },
  { method: 'DELETE', url: '/internal/v1/faults/:name', transport: 'service', requires: OPERATOR_ONLY, allow: ['service:operator'], admitted: 204 },
  { method: 'POST', url: '/internal/v1/legacy-steps', transport: 'service', requires: ['service:programs-sites'], siteCheck: false, allow: ['service:programs-sites'] },
  { method: 'POST', url: '/internal/v1/projection/await', transport: 'service', requires: ['service:gateway'], allow: THROUGH_GATEWAY },
  { method: 'GET', url: '/internal/v1/scheduler/state', transport: 'service', requires: OPERATOR_ONLY, allow: ['service:operator'] },
  { method: 'POST', url: '/internal/v1/scheduler/state::import', transport: 'service', requires: OPERATOR_ONLY, allow: ['service:operator'] },
];

const SUSPENSION = { suspended: true, since: null, reason: 'authz matrix', pushConfigs: {}, pausedQueues: [], pausedTasks: [] };

/** Valid input of each route, so an admitted request reaches its handler and answers its admitted status. */
const PROBE_INPUT: Readonly<Record<string, { url?: string; query?: string; payload?: unknown }>> = {
  'PUT /internal/v1/faults/:name': { url: '/internal/v1/faults/projector-delay', payload: { params: { delayMs: 3000 } } },
  'DELETE /internal/v1/faults/:name': { url: '/internal/v1/faults/projector-delay' },
  'GET /internal/v1/authority': { query: '?units=people.person_archive,people.person' },
  'POST /internal/v1/projection/await': { payload: { positions: { people: '100' }, timeoutMs: 2000 } },
  'POST /internal/v1/scheduler/state::import': { payload: { nativeTasks: [], ping: false } },
  'POST /internal/v1/background::suspend': { payload: SUSPENSION },
  // A step with no migration unit runs on the bridge double without a window; the deadline lies ahead of the whole run.
  'POST /internal/v1/legacy-steps': {
    payload: {
      step: 'purgeDisplayWindow',
      theTime: '2026-06-30 12:00:00.000',
      lastMonitored: '2026-06-30 11:45:00.000',
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  },
};

/** One concrete request; the subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: Method;
  url: string;
  payload?: unknown;
}

function keyOf(route: Pick<ExpectedRoute | RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

function probeOf(route: ExpectedRoute): ProbeRequest {
  const input = PROBE_INPUT[keyOf(route)] ?? {};
  return { method: route.method, url: `${input.url ?? route.url.replace(/::/g, ':')}${input.query ?? ''}`, payload: input.payload };
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

function declarations(routes: ReadonlyArray<ExpectedRoute | RouteMatrixEntry>): Record<string, unknown>[] {
  return [...routes].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)).map(comparable);
}

let t: RouteApp;

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Record<string, string>> }>();

// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `authHeadersFor(subject)` on tenant-a, reused while its tokens are fresh. */
function credentialsOf(subject: RoleSubject): Promise<Record<string, string>> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = authHeadersFor(subject, { site: SITE_A, audience: SERVICE });
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload } = request;
  const headers = { ...credentials, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) };
  return t.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

/** What one request answered and left behind. */
interface Outcome {
  status: number;
  body: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  effects: Effects;
}

/** Sends one request with reachable boundaries and records its answer and effects. */
async function outcomeOf(send: () => Promise<InjectResponse>): Promise<Outcome> {
  t.state.checkpoints = t.state.sites.map((site) => ({ owner: 'people', tenantId: tenantIdForSite(site), appliedHorizon: '200' }));
  t.resetEffects();
  const res = await send();
  const sentUrl = new URL(res.raw.req.url ?? '/', 'http://migration.test');
  return {
    status: res.statusCode,
    body: res.body,
    headers: Object.fromEntries(Object.entries(res.headers).map(([name, value]) => [name, String(value)])),
    query: Object.fromEntries(sentUrl.searchParams),
    effects: t.effects(),
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

/** Whether `body` is a legacy JSON API error envelope (jsonApiUtility.cfc:1318-1340). */
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

/** Every way `outcome` departs from a hook-level refusal: 401 or 403, the exact rendered envelope and headers, no effect. */
function denialProblems(outcome: Outcome, at: string): string[] {
  if (!DENIED_STATUSES.has(outcome.status)) return [`${at}: expected 401 or 403, got ${outcome.status} ${outcome.body.slice(0, 160)}`];
  const problems: string[] = [];
  if (!isErrorEnvelope(parsedBody(outcome.body))) problems.push(`${at}: denial is not the legacy error envelope: ${outcome.body.slice(0, 160)}`);
  const rendered = renderedDenials(outcome.status, outcome.query).find((response) => response.body === outcome.body);
  if (rendered === undefined) {
    problems.push(`${at}: body is not one renderAuthDenial builds: ${outcome.body.slice(0, 160)}`);
  } else {
    for (const [name, value] of Object.entries(rendered.headers)) {
      const sent = outcome.headers[name.toLowerCase()];
      if (sent !== value) problems.push(`${at}: header ${name} is ${sent}, not ${value}`);
    }
  }
  if (JSON.stringify(outcome.effects) !== JSON.stringify(NO_EFFECTS)) problems.push(`${at}: denial left effects ${JSON.stringify(outcome.effects)}`);
  return problems;
}

/** One route × credential cell of the matrix. */
interface Cell {
  route: ExpectedRoute;
  subject: string;
  allow: boolean;
  send: () => Promise<InjectResponse>;
}

const CELLS: readonly Cell[] = EXPECTED.flatMap((route) =>
  ROLE_SET.map((subject) => ({
    route,
    subject: subject.name,
    allow: route.allow.includes(subject.name),
    send: async () => inject(probeOf(route), await credentialsOf(subject)),
  })),
);

beforeAll(async () => {
  t = await buildRouteApp({ db: memoryMigrationDb().db });
});

afterAll(async () => {
  await t?.close();
});

describe('route declarations', () => {
  it('declared routes equal the expected table', () => {
    expect(declarations(collectRouteMatrix(t.app).routes)).toEqual(declarations(EXPECTED));
  });

  it('the matrix probes every subject the platform role set defines: anonymous, each user kind, each synthetic and service role', () => {
    expect(ROLE_SET.map((subject) => subject.name).sort()).toEqual([...EVERYONE].sort());
  });
});

describe('role matrix', () => {
  it.each(CELLS.map((cell) => ({ ...cell, title: `${keyOf(cell.route)} as ${cell.subject}` })))('$title', async ({ route, subject, allow, send }) => {
    const outcome = await outcomeOf(send);
    const at = `${keyOf(route)} as ${subject}`;
    if (allow) {
      expect({ at, status: outcome.status }).toEqual({ at, status: route.admitted ?? 200 });
      // An admitted request reaches its handler, so the effect counters that prove denials effect-free do count.
      if (route.url !== '/healthz') expect(outcome.effects).not.toEqual(NO_EFFECTS);
      return;
    }
    expect(denialProblems(outcome, at)).toEqual([]);
    if (subject === 'anonymous') expect(outcome.status).toBe(401);
  });
});

/** A user token of tenant-a claiming the workload roles migration routes require. */
function workloadClaimingUserToken(): Promise<string> {
  return mintUserToken({
    sub: 'test-workload-claim',
    tid: TENANT_A.tenantId,
    site: SITE_A,
    roles: [Roles.platformOperator, Roles.platformMigration, 'service:gateway', 'service:programs-sites', Roles.s2],
  });
}

async function gatewayInvocation(): Promise<string> {
  return `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
}

const SERVICE_ROUTES = EXPECTED.filter((route) => route.public !== true);
/** Routes the gateway's own invocation credential does not open, so a user token's claimed roles are all that could. */
const NOT_GATEWAY_ROUTES = EXPECTED.filter((route) => route.public !== true && !route.allow.includes('service:gateway'));

/** Credentials that must be refused before any handler runs, each on the routes it is presented to. */
const REFUSALS: ReadonlyArray<{ title: string; routes: readonly ExpectedRoute[]; status: number; credentials: () => Promise<Record<string, string>>; query?: string }> = [
  { title: 'the local push key alone', routes: SERVICE_ROUTES, status: 401, credentials: () => Promise.resolve({}), query: `key=${TEST_PUSH_KEY}` },
  {
    title: 'a tasks-invoker token beside the gateway invocation credential',
    routes: EXPECTED,
    status: 401,
    credentials: async () => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`, [INVOCATION_HEADER]: await gatewayInvocation() }),
  },
  {
    title: 'a user token without an invocation credential',
    routes: EXPECTED,
    status: 401,
    credentials: async () => ({ authorization: `Bearer ${await workloadClaimingUserToken()}` }),
  },
  {
    title: 'a user token claiming workload roles beside the gateway invocation credential',
    routes: NOT_GATEWAY_ROUTES,
    status: 403,
    credentials: async () => ({ authorization: `Bearer ${await workloadClaimingUserToken()}`, [INVOCATION_HEADER]: await gatewayInvocation() }),
  },
  {
    title: "the operator's service token addressed to the gateway",
    routes: EXPECTED,
    status: 401,
    credentials: async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'operator', audience: 'gateway' })}` }),
  },
  {
    title: 'a pubsub-invoker invocation credential, the managed push scheme',
    routes: SERVICE_ROUTES,
    status: 401,
    credentials: async () => ({
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'pubsub-invoker', audience: SERVICE, roles: [PUBSUB_INVOKER_ROLE] })}`,
    }),
  },
  {
    title: 'a tasks-invoker invocation credential, the managed task scheme',
    routes: SERVICE_ROUTES,
    status: 401,
    credentials: async () => ({
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'tasks-invoker', audience: SERVICE, roles: [TASKS_INVOKER_ROLE] })}`,
    }),
  },
];

describe('transport separation and caller-supplied conclusions', () => {
  it.each(
    REFUSALS.flatMap(({ title, routes, status, credentials, query }) =>
      routes.map((route) => ({ title: `${keyOf(route)} refuses ${title}`, route, status, credentials, query })),
    ),
  )('$title', async ({ title, route, status, credentials, query }) => {
    const probe = probeOf(route);
    const url = query === undefined ? probe.url : `${probe.url}${probe.url.includes('?') ? '&' : '?'}${query}`;
    const presented = await credentials();
    const outcome = await outcomeOf(() => inject({ ...probe, url }, presented));
    expect({ status: outcome.status, problems: denialProblems(outcome, title) }).toEqual({ status, problems: [] });
  });
});

describe('deny by default at start-up', () => {
  const handler = (): Promise<Record<string, never>> => Promise.resolve({});

  it.each<[string, (app: FastifyInstance) => unknown]>([
    ['no config.opt2', (app) => app.get('/internal/v1/undeclared', handler)],
    ['an empty requires list', (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [] } } }, handler)],
    [
      'both requires and public',
      (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [Roles.platformOperator], public: true } as unknown as Opt2RouteConfig } }, handler),
    ],
    [
      'an unknown transport',
      (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [Roles.platformOperator], transport: 'bogus' } as unknown as Opt2RouteConfig } }, handler),
    ],
    [
      'the cloud-tasks transport on a service path',
      (app) => app.get('/internal/v1/undeclared', { config: { opt2: { requires: [TASKS_INVOKER_ROLE], transport: 'cloud-tasks' } } }, handler),
    ],
  ])('fails start-up of the composed registrars plus a route with %s', async (_label, declare) => {
    await expect(buildRouteApp({ db: memoryMigrationDb().db, extraRoutes: declare })).rejects.toBeInstanceOf(UndeclaredRouteError);
  });
});
