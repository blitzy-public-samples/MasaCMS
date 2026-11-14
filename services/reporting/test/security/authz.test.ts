// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** In-process authorisation matrix of every reporting route: admitted subjects, denial envelopes and effects, transport, site, tenant, CSRF and signed-URL boundaries, deny by default. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { buildPushBody, encodeEnvelope } from '@opt2/platform/events';
import { LEGACY_ERROR_MAP } from '@opt2/platform/legacy-compat';
import { CSRF_CONSUME_PATH, IDENTITY_SERVICE, type FastifyInstance } from '@opt2/platform/service-kit';
import { QUEUES } from '@opt2/platform/tasks';
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
  testVerifier,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/envelope.js';
import { FIXTURE_PREFIX } from '../../src/legacy/index.js';
import { EXPORT_BUCKET, type ExportDefinitionRow, type ExportJobRow } from '../../src/repo/tables.js';
import {
  SERVICE,
  TEST_CLOCK,
  buildTestApp,
  createFakeTaskPort,
  headersFor,
  identityOf,
  queueRun,
  queuedRun,
  scopeUrl,
  seedDefinition,
  seedJob,
  siteChangedEnvelope,
  testEnv,
  type TestApp,
} from '../helpers/app.js';
import { createMemoryDb } from '../helpers/memory-db.js';

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const EXPORTER = 'reporting.exporter';

// Subject names of ROLE_SET, written out so every expectation below is literal.
const SYNTHETIC = [
  'timesheets.employee',
  'timesheets.primary-approver',
  'timesheets.secondary-approver',
  'finance.preparer',
  'finance.approver',
  'esignature.signer',
  'esignature.auditor',
  EXPORTER,
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

/** Subjects without a user token: a user-role `requires` answers them 401. */
const NO_USER: readonly string[] = ['anonymous', ...WORKLOADS];

/** Subjects without an invocation credential on the service transport. */
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
  /** The probe, built per subject so a write carries a CSRF token of that subject's session. */
  request: (subject: RoleSubject) => ProbeRequest;
  /** Subjects admitted: any status but 401, 403 and 5xx. */
  allow: readonly string[];
  /** Denied subjects answered 401; every other denied subject is answered 403. */
  deny401: readonly string[];
  /** Sends the probe as `subject` instead of injecting `request` with its credentials. */
  send?: (subject: RoleSubject, credentials: Record<string, string>) => Promise<InjectResponse>;
}

/** Request effects counted from a {@link mark}. */
interface Effects {
  transactions: number;
  writes: string[];
  tasks: number;
  calls: number;
  published: number;
  /** Storage puts and deletes. */
  stored: number;
}

type Mark = Omit<Effects, 'writes'>;

const NO_EFFECTS: Effects = { transactions: 0, writes: [], tasks: 0, calls: 0, published: 0, stored: 0 };

interface ErrorBody {
  code: string;
  message: string;
}

const errorBody = ({ code, message }: ErrorBody): ErrorBody => ({ code, message });

/** Error bodies a refusal may carry: the platform's legacy JSON API rows, or the fixture's own forbidden row. */
const DENIAL_ERRORS: Readonly<Record<401 | 403, readonly ErrorBody[]>> = {
  401: [LEGACY_ERROR_MAP.authorization, LEGACY_ERROR_MAP.invalidAccessToken, LEGACY_ERROR_MAP.accessTokenExpired].map(errorBody),
  403: [FIXTURE_ERROR_MAP.forbidden, LEGACY_ERROR_MAP.authorization].map(errorBody),
};

const FIXTURE_EXPORTS = `${FIXTURE_PREFIX}/exports`;
const V1_EXPORTS = '/v1/reporting/exports';
const ON_SITE_A = `siteid=${SITE_A}`;
const PUSH_URL = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const RUN_QUEUE = QUEUES['reporting-export-run'];

let t: TestApp;
let matrix: RouteMatrix;
let definitionA: ExportDefinitionRow;
let definitionB: ExportDefinitionRow;
let doneA: ExportJobRow;
let doneB: ExportJobRow;
let signedA: string;
let storedCount: () => number;

function subject(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject ${name}`);
  return found;
}

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

/** CSRF headers identity accepts once for the empty collection context in `subject`'s session. */
function csrfFor(who: Pick<RoleSubject, 'name'>): Record<string, string> {
  return { ...t.client.issueCsrf(identityOf(who).sid, '') };
}

function mark(): Mark {
  return {
    transactions: t.db.transactions.length,
    tasks: t.tasks.calls.length,
    calls: t.client.requests.length,
    published: t.publisher.published.length + t.publisher.raw.length,
    stored: storedCount(),
  };
}

function effectsSince(from: Mark): Effects {
  const transactions = t.db.transactions.slice(from.transactions);
  return {
    transactions: transactions.length,
    writes: transactions.filter((tx) => tx.outcome === 'commit').flatMap((tx) => tx.writes),
    tasks: t.tasks.calls.length - from.tasks,
    calls: t.client.requests.length - from.calls,
    published: t.publisher.published.length + t.publisher.raw.length - from.published,
    stored: storedCount() - from.stored,
  };
}

/** The `error` object of a legacy envelope response, or undefined when the body is not one. */
function errorOf(res: InjectResponse): ErrorBody | undefined {
  let body: unknown;
  try {
    body = JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : undefined;
}

/** Status, error body and effects of `request` sent with `credentials`. */
async function outcomeOf(request: ProbeRequest, credentials: Record<string, string>) {
  const before = mark();
  const res = await inject(request, credentials);
  return { status: res.statusCode, error: errorOf(res), effects: effectsSince(before) };
}

/** A contract-valid site.changed push body of tenant-a, as Pub/Sub sends it, without the push key. */
function pushWithoutKey(): ProbeRequest {
  const body = buildPushBody({ data: encodeEnvelope(siteChangedEnvelope(SITE_A)), messageId: randomUUID(), subscription: SITE_CHANGED_SUBSCRIPTION });
  return { method: 'POST', url: PUSH_URL, payload: { ...body } };
}

function withPushKey(request: ProbeRequest, key: string = TEST_PUSH_KEY): ProbeRequest {
  return { ...request, url: `${request.url}${request.url.includes('?') ? '&' : '?'}${pushKeyQuery(key)}` };
}

/** Delivers the push as `subject`: the invoker through the local push key, everyone else with only its own credentials. */
function sendPush(who: RoleSubject, credentials: Record<string, string>): Promise<InjectResponse> {
  if (who.name === PUBSUB_INVOKER_ROLE) return pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(SITE_A));
  return inject(pushWithoutKey(), credentials);
}

/** The queued run task of `job` as the task adapters deliver its wire body, naming `tenantId`. */
function runTask(job: Pick<ExportJobRow, 'job_id'>, tenantId: string = TENANT_A.tenantId): ProbeRequest {
  return {
    method: 'POST',
    url: RUN_QUEUE.targetPath.replace('{exportId}', job.job_id),
    payload: { ...queuedRun(t, job.job_id), tenantId },
  };
}

const fixed = (request: ProbeRequest) => (): ProbeRequest => request;

const EXPORTER_ROUTE: Declared = { transport: 'service', requires: [EXPORTER] };
const FIXTURE_ROUTE: Declared = { transport: 'service', requires: [EXPORTER], siteCheck: false };

function exporterRoute(declared: Declared, request: Expectation['request']): Expectation {
  return { declared, request, allow: [EXPORTER], deny401: NO_USER };
}

function migrationRoute(request: ProbeRequest): Expectation {
  return {
    declared: { transport: 'service', requires: ['platform.migration'] },
    request: fixed(request),
    allow: ['service:migration'],
    deny401: NO_INVOCATION,
  };
}

function queueControl(op: 'pause' | 'resume' | 'ensure'): Expectation {
  return {
    declared: { transport: 'service', requires: ['platform.migration', 'platform.operator'] },
    request: fixed({ method: 'POST', url: `/internal/v1/task-queues/${RUN_QUEUE.name}/${op}` }),
    allow: ['service:migration', 'service:operator'],
    deny401: NO_INVOCATION,
  };
}

const createBody = (): Record<string, unknown> => ({ definitionId: definitionA.definition_id, format: 'csv' });

/** Every registered route, keyed `<METHOD> <fastify url>`, with its declaration, tenant-a probe and admitted subjects. */
function expectations(): Readonly<Record<string, Expectation>> {
  return {
    'GET /healthz': {
      declared: { transport: 'service', public: true },
      request: fixed({ method: 'GET', url: '/healthz' }),
      // A tasks-invoker token in Authorization is verified, and refused, as a user token.
      allow: everyoneBut('service:tasks-invoker'),
      deny401: ['service:tasks-invoker'],
    },
    [`POST ${PUSH_URL}`]: {
      declared: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
      request: fixed({ method: 'POST', url: PUSH_URL }),
      allow: [PUBSUB_INVOKER_ROLE],
      deny401: everyoneBut(PUBSUB_INVOKER_ROLE),
      send: sendPush,
    },
    'POST /internal/v1/migration/apply': migrationRoute({ method: 'POST', url: '/internal/v1/migration/apply', payload: {} }),
    'GET /internal/v1/migration/changes': migrationRoute({ method: 'GET', url: `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}` }),
    'GET /internal/v1/migration/export': migrationRoute({
      method: 'GET',
      url: `/internal/v1/migration/export?unit=reporting.export_job&tenantId=${TENANT_A.tenantId}`,
    }),
    'POST /internal/v1/migration/gate': migrationRoute({ method: 'POST', url: '/internal/v1/migration/gate', payload: { op: 'status' } }),
    'GET /internal/v1/migration/position': migrationRoute({ method: 'GET', url: '/internal/v1/migration/position' }),
    'GET /internal/v1/migration/watermark': migrationRoute({ method: 'GET', url: '/internal/v1/migration/watermark' }),
    'POST /internal/v1/migration/watermark': migrationRoute({ method: 'POST', url: '/internal/v1/migration/watermark', payload: {} }),
    'POST /internal/v1/task-queues/:queue/ensure': queueControl('ensure'),
    'POST /internal/v1/task-queues/:queue/pause': queueControl('pause'),
    'POST /internal/v1/task-queues/:queue/resume': queueControl('resume'),
    'POST /internal/v1/tasks/exports/:exportId/run': {
      declared: { transport: 'cloud-tasks', requires: ['service:tasks-invoker'] },
      request: () => runTask(doneA),
      allow: ['service:tasks-invoker'],
      deny401: everyoneBut('service:tasks-invoker'),
    },
    [`GET ${FIXTURE_EXPORTS}`]: exporterRoute(FIXTURE_ROUTE, fixed({ method: 'GET', url: `${FIXTURE_EXPORTS}?${ON_SITE_A}` })),
    [`POST ${FIXTURE_EXPORTS}`]: exporterRoute(FIXTURE_ROUTE, (who) => ({
      method: 'POST',
      url: `${FIXTURE_EXPORTS}?${ON_SITE_A}`,
      headers: csrfFor(who),
      payload: createBody(),
    })),
    [`GET ${FIXTURE_EXPORTS}/:id`]: exporterRoute(FIXTURE_ROUTE, () => ({ method: 'GET', url: `${FIXTURE_EXPORTS}/${doneA.job_id}?${ON_SITE_A}` })),
    [`GET ${FIXTURE_EXPORTS}/:id/download`]: exporterRoute(FIXTURE_ROUTE, () => ({
      method: 'GET',
      url: `${FIXTURE_EXPORTS}/${doneA.job_id}/download?${ON_SITE_A}`,
    })),
    // Only the export source producers' workloads may read a job's scope, which the scope route itself then narrows to its source.
    'GET /internal/v1/exports/:exportId/source-scope': {
      declared: { transport: 'service', requires: ['service:finance', 'service:timesheets'] },
      request: () => ({ method: 'GET', url: scopeUrl(doneA.job_id, SITE_A) }),
      allow: ['service:finance', 'service:timesheets'],
      deny401: NO_INVOCATION,
    },
    'GET /opt2/files/reporting-exports/:tenantId/:objectName': {
      declared: { transport: 'service', public: true },
      request: () => ({ method: 'GET', url: signedA }),
      // The signature is the credential; a tasks-invoker token in Authorization is refused as a user token.
      allow: everyoneBut('service:tasks-invoker'),
      deny401: ['service:tasks-invoker'],
    },
    [`GET ${V1_EXPORTS}`]: exporterRoute(EXPORTER_ROUTE, fixed({ method: 'GET', url: `${V1_EXPORTS}?${ON_SITE_A}` })),
    [`POST ${V1_EXPORTS}`]: exporterRoute(EXPORTER_ROUTE, (who) => ({
      method: 'POST',
      url: `${V1_EXPORTS}?${ON_SITE_A}`,
      headers: csrfFor(who),
      payload: createBody(),
    })),
    [`GET ${V1_EXPORTS}/:id`]: exporterRoute(EXPORTER_ROUTE, () => ({ method: 'GET', url: `${V1_EXPORTS}/${doneA.job_id}?${ON_SITE_A}` })),
    [`GET ${V1_EXPORTS}/:id/download-url`]: exporterRoute(EXPORTER_ROUTE, () => ({
      method: 'GET',
      url: `${V1_EXPORTS}/${doneA.job_id}/download-url?${ON_SITE_A}`,
    })),
  };
}

/** Every way one probe sent as one subject departs from its expectation. */
async function mismatchesOf(key: string, entry: Expectation, who: RoleSubject): Promise<string[]> {
  const credentials = await headersFor(who, SITE_A);
  const before = mark();
  const res = entry.send === undefined ? await inject(entry.request(who), credentials) : await entry.send(who, credentials);
  const at = `${key} as ${who.name}`;
  const admitted = res.statusCode !== 401 && res.statusCode !== 403;
  const shouldAdmit = entry.allow.includes(who.name);
  if (admitted !== shouldAdmit) {
    return [`${at}: expected ${shouldAdmit ? 'admission' : 'denial'}, got ${res.statusCode} ${res.body.slice(0, 200)}`];
  }
  if (admitted) return res.statusCode >= 500 ? [`${at}: admitted request failed with ${res.statusCode} ${res.body.slice(0, 200)}`] : [];

  const problems: string[] = [];
  const status = entry.deny401.includes(who.name) ? 401 : 403;
  if (res.statusCode !== status) problems.push(`${at}: expected ${status}, got ${res.statusCode} ${res.body.slice(0, 200)}`);
  const error = errorOf(res);
  if (error === undefined) {
    problems.push(`${at}: denial is not a legacy error envelope: ${res.body.slice(0, 200)}`);
  } else if (!DENIAL_ERRORS[res.statusCode as 401 | 403].some((allowed) => isDeepStrictEqual(allowed, error))) {
    problems.push(`${at}: unexpected denial error ${JSON.stringify(error)}`);
  }
  const effects = effectsSince(before);
  if (!isDeepStrictEqual(effects, NO_EFFECTS)) problems.push(`${at}: denial left effects ${JSON.stringify(effects)}`);
  return problems;
}

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
  };
}

beforeAll(async () => {
  t = await buildTestApp();
  const puts = vi.spyOn(t.storage, 'put');
  const deletes = vi.spyOn(t.storage, 'delete');
  storedCount = () => puts.mock.calls.length + deletes.mock.calls.length;
  matrix = collectRouteMatrix(t.app);
  definitionA = seedDefinition(t.db, SITE_A);
  definitionB = seedDefinition(t.db, SITE_B);
  doneA = await seedJob(t, definitionA, 'done');
  doneB = await seedJob(t, definitionB, 'done');
  await queueRun(t, doneA);
  signedA = await t.storage.signedUrl(EXPORT_BUCKET, doneA.object_key ?? '', { expiresS: 900 });
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.client.reset();
});

describe('route declarations', () => {
  it('lists every registered route exactly once in the expectations', () => {
    const registered = matrix.routes.map(keyOf);
    const expected = Object.keys(expectations());
    expect({
      missing: registered.filter((key) => !expected.includes(key)),
      extra: expected.filter((key) => !registered.includes(key)),
      duplicated: registered.filter((key, index) => registered.indexOf(key) !== index),
    }).toEqual({ missing: [], extra: [], duplicated: [] });
  });

  it('declares each route with its expected transport, roles, public flag and site check', () => {
    const actual = Object.fromEntries(matrix.routes.map((route) => [keyOf(route), comparable(route)]));
    const expected = Object.fromEntries(Object.entries(expectations()).map(([key, entry]) => [key, comparable(entry.declared)]));
    expect(actual).toEqual(expected);
  });

  it('probes exactly the ROLE_SET subjects', () => {
    expect(ROLE_SET.map((who) => who.name).sort()).toEqual([...EVERYONE].sort());
  });

  it('names only ROLE_SET subjects, and never one both admitted and answered 401', () => {
    const entries = Object.entries(expectations());
    const named = entries.flatMap(([, entry]) => [...entry.allow, ...entry.deny401]);
    const overlapping = entries.flatMap(([key, entry]) => entry.allow.filter((name) => entry.deny401.includes(name)).map((name) => `${key}: ${name}`));
    expect({ unknown: named.filter((name) => !EVERYONE.includes(name)), overlapping }).toEqual({ unknown: [], overlapping: [] });
  });
});

describe('route admission', () => {
  it.each(Object.keys(expectations()))('admits exactly the expected subjects on %s, and denials leave no effect', async (key) => {
    const entry = expectations()[key];
    if (entry === undefined) throw new TypeError(`no expectation for ${key}`);
    const mismatches: string[] = [];
    for (const who of ROLE_SET) mismatches.push(...(await mismatchesOf(key, entry, who)));
    expect(mismatches).toEqual([]);
  });
});

describe('managed credentials', () => {
  it('answers the run task 200 for the local tasks-invoker token addressed to reporting', async () => {
    const res = await inject(runTask(doneA), { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` });
    expect({ status: res.statusCode, body: res.json<unknown>() }).toEqual({ status: 200, body: { jobId: doneA.job_id, state: 'done' } });
  });

  it('acks a site.changed push carrying the local push key', async () => {
    expect((await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(SITE_A))).statusCode).toBe(204);
  });

  it('refuses a tasks-invoker token addressed to another service, running nothing', async () => {
    const outcome = await outcomeOf(runTask(doneA), { authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'finance' })}` });
    expect(outcome).toEqual({ status: 401, error: errorBody(LEGACY_ERROR_MAP.authorization), effects: NO_EFFECTS });
  });

  it('refuses a wrong push key, applying nothing', async () => {
    const before = mark();
    const res = await pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope(SITE_A), { key: `${TEST_PUSH_KEY}-wrong` });
    expect({ status: res.statusCode, effects: effectsSince(before) }).toEqual({ status: 401, effects: NO_EFFECTS });
  });
});

describe('transport separation', () => {
  it.each(['s2', EXPORTER])('refuses the %s user token on the push and task routes, even beside the push key', async (name) => {
    const credentials = await headersFor(subject(name), SITE_A);
    for (const request of [pushWithoutKey(), withPushKey(pushWithoutKey()), runTask(doneA), withPushKey(runTask(doneA))]) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
    }
  });

  it('refuses a tasks-invoker token on service and push routes, with or without the gateway invocation credential', async () => {
    const tasksToken = `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`;
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const probes: ProbeRequest[] = [
      { method: 'GET', url: `${V1_EXPORTS}?${ON_SITE_A}` },
      { method: 'POST', url: `${V1_EXPORTS}?${ON_SITE_A}`, payload: createBody() },
      { method: 'GET', url: `${FIXTURE_EXPORTS}?${ON_SITE_A}` },
      { method: 'GET', url: '/internal/v1/migration/position' },
      { method: 'POST', url: `/internal/v1/task-queues/${RUN_QUEUE.name}/pause` },
      pushWithoutKey(),
    ];
    const presented: Record<string, string>[] = [{ authorization: tasksToken }, { authorization: tasksToken, [INVOCATION_HEADER]: gatewayToken }];
    for (const credentials of presented) {
      for (const request of probes) {
        const { status, effects } = await outcomeOf(request, credentials);
        expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
      }
    }
  });

  it('refuses an exporter user token presented without an invocation credential on /v1 and fixture routes', async () => {
    const credentials = await headersFor(subject(EXPORTER), SITE_A);
    const userOnly = Object.fromEntries(Object.entries(credentials).filter(([name]) => name !== INVOCATION_HEADER));
    const probes: ProbeRequest[] = [
      { method: 'GET', url: `${V1_EXPORTS}?${ON_SITE_A}` },
      { method: 'POST', url: `${V1_EXPORTS}?${ON_SITE_A}`, headers: csrfFor(subject(EXPORTER)), payload: createBody() },
      { method: 'GET', url: `${V1_EXPORTS}/${doneA.job_id}/download-url?${ON_SITE_A}` },
      { method: 'GET', url: `${FIXTURE_EXPORTS}/${doneA.job_id}/download?${ON_SITE_A}` },
      { method: 'POST', url: `${FIXTURE_EXPORTS}?${ON_SITE_A}`, headers: csrfFor(subject(EXPORTER)), payload: createBody() },
    ];
    for (const request of probes) {
      const at = `${request.method} ${request.url}`;
      expect({ at, ...(await outcomeOf(request, userOnly)) }).toEqual({
        at,
        status: 401,
        error: errorBody(LEGACY_ERROR_MAP.authorization),
        effects: NO_EFFECTS,
      });
    }
  });

  it('refuses the push key on user, migration and task routes', async () => {
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const probes: [ProbeRequest, Record<string, string>][] = [
      [withPushKey({ method: 'GET', url: `${V1_EXPORTS}?${ON_SITE_A}` }), {}],
      [withPushKey({ method: 'GET', url: `${V1_EXPORTS}?${ON_SITE_A}` }), { [INVOCATION_HEADER]: gatewayToken }],
      [withPushKey({ method: 'GET', url: '/internal/v1/migration/position' }), {}],
      [withPushKey(runTask(doneA)), {}],
    ];
    for (const [request, credentials] of probes) {
      const { status, effects } = await outcomeOf(request, credentials);
      expect({ url: request.url, status, effects }).toEqual({ url: request.url, status: 401, effects: NO_EFFECTS });
    }
  });
});

describe('site boundary', () => {
  const toSiteB = (request: ProbeRequest): ProbeRequest => ({ ...request, url: request.url.replace(ON_SITE_A, `siteid=${SITE_B}`) });

  it.each<[string, () => ProbeRequest]>([
    ['the job list', () => ({ method: 'GET', url: `${V1_EXPORTS}?${ON_SITE_A}` })],
    ['a create', () => ({ method: 'POST', url: `${V1_EXPORTS}?${ON_SITE_A}`, headers: csrfFor(subject(EXPORTER)), payload: createBody() })],
    ['a job read', () => ({ method: 'GET', url: `${V1_EXPORTS}/${doneA.job_id}?${ON_SITE_A}` })],
    ['a download URL', () => ({ method: 'GET', url: `${V1_EXPORTS}/${doneA.job_id}/download-url?${ON_SITE_A}` })],
  ])('refuses a tenant-a exporter sending siteid=tenant-b on /v1 %s, before any read, token use or write', async (_label, request) => {
    const outcome = await outcomeOf(toSiteB(request()), await headersFor(subject(EXPORTER), SITE_A));
    expect(outcome).toEqual({ status: 403, error: errorBody(LEGACY_ERROR_MAP.authorization), effects: NO_EFFECTS });
  });

  it('refuses a /v1 create whose JSON body names siteid=tenant-b, consuming no token', async () => {
    const request: ProbeRequest = {
      method: 'POST',
      url: V1_EXPORTS,
      headers: csrfFor(subject(EXPORTER)),
      payload: { ...createBody(), siteid: SITE_B },
    };
    const outcome = await outcomeOf(request, await headersFor(subject(EXPORTER), SITE_A));
    expect(outcome).toEqual({ status: 403, error: errorBody(LEGACY_ERROR_MAP.authorization), effects: NO_EFFECTS });
  });

  it.each<[string, () => ProbeRequest]>([
    ['the job list', () => ({ method: 'GET', url: `${FIXTURE_EXPORTS}?${ON_SITE_A}` })],
    ['a create', () => ({ method: 'POST', url: `${FIXTURE_EXPORTS}?${ON_SITE_A}`, headers: csrfFor(subject(EXPORTER)), payload: createBody() })],
    ['a job read', () => ({ method: 'GET', url: `${FIXTURE_EXPORTS}/${doneA.job_id}?${ON_SITE_A}` })],
    ['a download', () => ({ method: 'GET', url: `${FIXTURE_EXPORTS}/${doneA.job_id}/download?${ON_SITE_A}` })],
  ])('answers a tenant-a exporter sending siteid=tenant-b on fixture %s with forbidden, reading only the registry', async (_label, request) => {
    // auth.cfc resolveSite reads the site before it compares it with the session's; that registry read is the only effect.
    const outcome = await outcomeOf(toSiteB(request()), await headersFor(subject(EXPORTER), SITE_A));
    expect(outcome).toEqual({ status: 403, error: errorBody(FIXTURE_ERROR_MAP.forbidden), effects: { ...NO_EFFECTS, transactions: 1 } });
  });
});

describe('tenant isolation', () => {
  it.each<[string, () => ProbeRequest]>([
    ['/v1 job read', () => ({ method: 'GET', url: `${V1_EXPORTS}/${doneA.job_id}?siteid=${SITE_B}` })],
    ['/v1 download URL', () => ({ method: 'GET', url: `${V1_EXPORTS}/${doneA.job_id}/download-url?siteid=${SITE_B}` })],
    ['fixture job read', () => ({ method: 'GET', url: `${FIXTURE_EXPORTS}/${doneA.job_id}?siteid=${SITE_B}` })],
    ['fixture download', () => ({ method: 'GET', url: `${FIXTURE_EXPORTS}/${doneA.job_id}/download?siteid=${SITE_B}` })],
  ])("answers a tenant-b exporter's %s of a tenant-a job as not found, writing nothing", async (_label, request) => {
    const { status, effects } = await outcomeOf(request(), await headersFor(subject(EXPORTER), SITE_B));
    expect({ status, writes: effects.writes, calls: effects.calls, tasks: effects.tasks }).toEqual({ status: 404, writes: [], calls: 0, tasks: 0 });
  });

  it.each([
    ['/v1', `${V1_EXPORTS}?siteid=${SITE_B}`, (body: { data: Array<{ job_id: string }> }) => body.data],
    ['fixture', `${FIXTURE_EXPORTS}?siteid=${SITE_B}`, (body: { data: { items: Array<{ job_id: string }> } }) => body.data.items],
  ] as const)("lists only tenant-b's jobs to a tenant-b exporter on the %s list", async (_label, url, itemsOf) => {
    const res = await inject({ method: 'GET', url }, await headersFor(subject(EXPORTER), SITE_B));
    const ids = (itemsOf as (body: unknown) => Array<{ job_id: string }>)(res.json()).map((job) => job.job_id);
    expect({ status: res.statusCode, hasOwn: ids.includes(doneB.job_id), hasForeign: ids.includes(doneA.job_id) }).toEqual({
      status: 200,
      hasOwn: true,
      hasForeign: false,
    });
  });

  it("refuses a tenant-b create naming tenant-a's definition as not found, queueing nothing", async () => {
    const request: ProbeRequest = { method: 'POST', url: `${V1_EXPORTS}?siteid=${SITE_B}`, headers: csrfFor(subject(EXPORTER)), payload: createBody() };
    const { status, effects } = await outcomeOf(request, await headersFor(subject(EXPORTER), SITE_B));
    expect({ status, writes: effects.writes, tasks: effects.tasks }).toEqual({ status: 404, writes: [], tasks: 0 });
  });

  it("refuses a run task whose body names tenant-b for tenant-a's job, running nothing", async () => {
    const credentials = { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
    const { status, error, effects } = await outcomeOf(runTask(doneA, TENANT_B.tenantId), credentials);
    expect({ status, error, writes: effects.writes, calls: effects.calls }).toEqual({
      status: 400,
      error: errorBody(LEGACY_ERROR_MAP.badRequest),
      writes: [],
      calls: 0,
    });
  });

  it("refuses a signed export URL re-pointed at another tenant's object", async () => {
    const forged = signedA.replace(TENANT_A.tenantId, TENANT_B.tenantId).replace(doneA.job_id, doneB.job_id);
    const res = await inject({ method: 'GET', url: forged }, {});
    expect(res.statusCode).toBe(403);
  });
});

describe('signed export URLs', () => {
  /** Subjects whose credentials the file route verifies; a tasks-invoker token is refused first as a user token. */
  const verified = (): RoleSubject[] => everyoneBut('service:tasks-invoker').map(subject);

  /** `signedA` with its query edited by `edit`. */
  const edited = (edit: (params: URLSearchParams) => void): string => {
    const url = new URL(signedA, 'http://reporting.local');
    edit(url.searchParams);
    return `${url.pathname}${url.search}`;
  };

  const flip = (hex: string): string => `${hex.startsWith('0') ? '1' : '0'}${hex.slice(1)}`;

  it('serves the stored export bytes to a valid signature whoever presents it', async () => {
    const bytes = await t.storage.get(EXPORT_BUCKET, doneA.object_key ?? '');
    const mismatches: string[] = [];
    for (const who of verified()) {
      const res = await inject({ method: 'GET', url: signedA }, await headersFor(who, SITE_A));
      if (res.statusCode !== 200 || !res.rawPayload.equals(bytes)) mismatches.push(`${who.name}: ${res.statusCode} ${res.body.slice(0, 200)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it.each<[string, () => string | Promise<string>]>([
    ['a flipped sig character', () => edited((params) => params.set('sig', flip(params.get('sig') ?? '')))],
    ['no sig', () => edited((params) => params.delete('sig'))],
    ['no expires', () => edited((params) => params.delete('expires'))],
    [
      'a signature for another bucket',
      async () => (await t.storage.signedUrl('finance-attachments', doneA.object_key ?? '')).replace('/finance-attachments/', `/${EXPORT_BUCKET}/`),
    ],
    ['an expired signature', () => t.storage.signedUrl(EXPORT_BUCKET, doneA.object_key ?? '', { expiresS: -1 })],
  ])('answers 403 to a URL with %s for every verified subject, serving and storing nothing', async (_label, urlFor) => {
    const url = await urlFor();
    const refused = { status: 403, error: errorBody(LEGACY_ERROR_MAP.authorization), effects: NO_EFFECTS };
    const mismatches: string[] = [];
    for (const who of verified()) {
      const outcome = await outcomeOf({ method: 'GET', url }, await headersFor(who, SITE_A));
      if (!isDeepStrictEqual(outcome, refused)) mismatches.push(`${who.name}: ${JSON.stringify(outcome)}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe('CSRF on writes', () => {
  // api.cfm resolves the fixture site, one registry read, before reporting.cfc checks the token; /v1 checks it first.
  const WRITES = [
    ['/v1', V1_EXPORTS, 0],
    ['fixture', FIXTURE_EXPORTS, 1],
  ] as const;

  /** A create of `path` by the tenant-a exporter carrying `csrf`. */
  const create = (path: string, csrf: Record<string, string>): ProbeRequest => ({
    method: 'POST',
    url: `${path}?${ON_SITE_A}`,
    headers: csrf,
    payload: createBody(),
  });

  it.each(WRITES)('has identity consume the token for the empty context of the caller session before the %s create queues', async (_label, path) => {
    const csrf = csrfFor(subject(EXPORTER));
    const before = mark();
    const res = await inject(create(path, csrf), await headersFor(subject(EXPORTER), SITE_A));
    expect(res.statusCode).toBe(200);
    expect(t.client.requests.slice(before.calls, before.calls + 1)).toEqual([
      {
        service: IDENTITY_SERVICE,
        method: 'POST',
        path: CSRF_CONSUME_PATH,
        json: { sessionId: identityOf(subject(EXPORTER)).sid, token: csrf['x-csrf_token'], expires: csrf['x-csrf_token_expires'], context: '' },
      },
    ]);
    expect(effectsSince(before).tasks).toBeGreaterThan(0);
  });

  it.each(
    WRITES.flatMap(([label, path, siteReads]) => [
      [label, 'no token', path, siteReads, () => ({}), 0],
      [label, 'a token without its expiry', path, siteReads, () => ({ 'x-csrf_token': csrfFor(subject(EXPORTER))['x-csrf_token'] ?? '' }), 0],
      [label, "a job's token", path, siteReads, () => ({ ...t.client.issueCsrf(identityOf(subject(EXPORTER)).sid, doneA.job_id) }), 1],
      [label, "another session's token", path, siteReads, () => csrfFor(subject('s2')), 1],
    ] as const),
  )('refuses the %s create with %s as invalidTokens, writing and queueing nothing', async (_label, _case, path, siteReads, csrf, consumeCalls) => {
    const outcome = await outcomeOf(create(path, csrf()), await headersFor(subject(EXPORTER), SITE_A));
    expect(outcome).toEqual({
      status: 400,
      error: errorBody(LEGACY_ERROR_MAP.invalidTokens),
      effects: { ...NO_EFFECTS, transactions: siteReads, calls: consumeCalls },
    });
  });

  it.each(WRITES)('accepts a token once and refuses its replay on the %s create', async (_label, path, siteReads) => {
    const csrf = csrfFor(subject(EXPORTER));
    const credentials = await headersFor(subject(EXPORTER), SITE_A);
    const first = await inject(create(path, csrf), credentials);
    const replay = await outcomeOf(create(path, csrf), credentials);
    expect({ first: first.statusCode, replay }).toEqual({
      first: 200,
      replay: { status: 400, error: errorBody(LEGACY_ERROR_MAP.invalidTokens), effects: { ...NO_EFFECTS, transactions: siteReads, calls: 1 } },
    });
  });

  it.each(WRITES)('answers the legacy 503 and writes nothing when identity cannot consume the %s token', async (_label, path, siteReads) => {
    t.client.answer(IDENTITY_SERVICE, CSRF_CONSUME_PATH, () => ({ status: 503, headers: {}, body: undefined }));
    const { status, effects } = await outcomeOf(create(path, csrfFor(subject(EXPORTER))), await headersFor(subject(EXPORTER), SITE_A));
    expect({ status, effects }).toEqual({ status: 503, effects: { ...NO_EFFECTS, transactions: siteReads, calls: 1 } });
  });

  it.each([
    ['/v1 list', `${V1_EXPORTS}?${ON_SITE_A}`],
    ['fixture list', `${FIXTURE_EXPORTS}?${ON_SITE_A}`],
    ['/v1 job read', `${V1_EXPORTS}/${'{job}'}?${ON_SITE_A}`],
  ])('consumes no token sent with the %s', async (_label, url) => {
    const before = mark();
    const res = await inject(
      { method: 'GET', url: url.replace('{job}', doneA.job_id), headers: csrfFor(subject(EXPORTER)) },
      await headersFor(subject(EXPORTER), SITE_A),
    );
    expect({ status: res.statusCode, calls: effectsSince(before).calls }).toEqual({ status: 200, calls: 0 });
  });
});

describe('deny by default at start-up', () => {
  it.each<[string, string, Opt2RouteConfig | undefined]>([
    ['declares no config.opt2', '/v1/reporting/__undeclared', undefined],
    ['declares neither roles nor public', '/v1/reporting/__empty', {}],
    ['declares both roles and public', '/v1/reporting/__both', { public: true, requires: [EXPORTER] }],
    ['declares an empty role list', '/v1/reporting/__none', { requires: [] }],
    ['is a public managed task route', '/internal/v1/tasks/__public', { public: true, transport: 'cloud-tasks' }],
    ['declares the service transport on a task path', '/internal/v1/tasks/__service', { transport: 'service', requires: [EXPORTER] }],
    ['declares the push transport on a user path', '/v1/reporting/__push', { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] }],
  ])('fails start-up of the buildApp instance when a route %s', async (_label, url, opt2) => {
    let app: FastifyInstance | undefined;
    try {
      const built = await buildApp({
        env: testEnv(t.app.opt2.env.OPT2_STATE_DIR),
        clock: TEST_CLOCK,
        verifierOverride: testVerifier(SERVICE),
        db: createMemoryDb({ now: () => TEST_CLOCK.now() }),
        publisher: createCapturingPublisher(),
        storage: t.storage,
        tasks: createFakeTaskPort(),
      });
      app = built;
      const startUp = (async () => {
        built.get(url, opt2 === undefined ? {} : { config: { opt2 } }, () => ({}));
        await built.ready();
      })();
      await expect(startUp).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await app?.close().catch(() => undefined);
    }
  });
});
