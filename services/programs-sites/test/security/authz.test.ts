/** In-process authorisation matrix of every programs-sites route: admitted subjects, tenant and transport boundaries, deny by default. */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, type EventEnvelope } from '@opt2/platform/events';
import { CSRF_CONSUME_PATH, baseEnvSchema, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { SITEMONITOR_QUEUE, outboxSweepQueue } from '@opt2/platform/tasks';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TEST_PUSH_KEY,
  createCapturingPublisher,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushTo,
  testEnvelope,
  testVerifier,
  writeTestSecrets,
  type InjectResponse,
  type RoleSubject,
  type TenantFixture,
} from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import {
  TEST_CLOCK,
  buildTestApp,
  createFakeTaskPort,
  createRecordingDb,
  headersFor,
  testEnv,
  type TestApp,
} from '../helpers/app.js';

const SERVICE = 'programs-sites';
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

/** User subjects holding `system-user` on tenant-a, the site under test: its private-pool admin users. */
const TENANT_A_PRIVATE_USERS = ['system-user', 'editor', 'site-admin', 's2', ...SYNTHETIC] as const;

const USERS = ['member', ...TENANT_A_PRIVATE_USERS, 'other-tenant'] as const;

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

/** EVERYONE without `excluded`. */
function everyoneBut(...excluded: string[]): string[] {
  return EVERYONE.filter((name) => !excluded.includes(name));
}

/** One concrete tenant-a request; each subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'PATCH';
  url: string;
  payload?: string | Record<string, unknown>;
  headers?: Record<string, string>;
}

/** A refusal the handler answers after its own reads rather than the auth hooks. */
interface HandlerDenial {
  status: 401 | 403;
  /** The exact legacy error, where the handler throws one. */
  error?: { code: string; message: string };
}

interface Probe {
  title: string;
  request: ProbeRequest;
  /** Subjects admitted: any status but 401 and 403. */
  allow: readonly string[];
  /** Subjects probed; every ROLE_SET subject when absent. */
  subjects?: readonly string[];
  /** Handler-level denials by subject; every other denial must come from the auth hooks, before any query. */
  denyCheck?: Readonly<Record<string, HandlerDenial>>;
  /** Service calls a handler-level denial still makes, as `<service> <METHOD> <path>`. */
  deniedCalls?: readonly string[];
  /** Sends the probe as `subject` instead of injecting `request` with its credentials. */
  send?: (subject: RoleSubject, credentials: Record<string, string>) => Promise<InjectResponse>;
}

interface Declared {
  transport: Transport;
  requires?: readonly string[];
  public?: true;
  /** `false` where the handler runs the site check itself. */
  siteCheck?: false;
}

interface Expected {
  declared: Declared;
  probes: readonly Probe[];
}

/** A row the recording database answers with. */
type StoredRow = Record<string, unknown>;

let t: TestApp;
let matrix: RouteMatrix;
let taskCount = 0;
let taskCallCount = 0;

const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const TOKEN_FIELDS = 'csrf_token=T&csrf_token_expires=E';
const SIZE_ID = 'C0FFEE00-0000-0000-0000000000000001';
const PUSH_URL = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const SWEEP_QUEUE = outboxSweepQueue(SERVICE);
const CSRF_CONSUME_CALL = `identity POST ${CSRF_CONSUME_PATH}`;

const INSUFFICIENT_PERMISSIONS: HandlerDenial = {
  status: 401,
  error: { code: 'invalid_request', message: 'Insufficient Account Permissions' },
};
const SITE_MISMATCH: HandlerDenial = { status: 403 };

/** The same handler denial for every named subject. */
function denials(names: readonly string[], denial: HandlerDenial): Record<string, HandlerDenial> {
  return Object.fromEntries(names.map((name) => [name, denial]));
}

/** Pool settings of the fixture sites: tenant-a pools its public users with umbrella, tenant-b owns every pool. */
const POOLS: Readonly<Record<string, { publicUser: string; other: string }>> = {
  [SITE_A]: { publicUser: 'umbrella', other: 'umbrella' },
  [SITE_B]: { publicUser: SITE_B, other: SITE_B },
};

const MIGRATIONS_DIR = new URL('../../db/migrations/', import.meta.url);

/** Columns of `programs_sites.site` as the service's migrations create it, with their SQL type. */
const SITE_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .flatMap((file) => {
    const body = /CREATE TABLE programs_sites\.site \(([\s\S]*?)\n\);/.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'))?.[1];
    if (body === undefined) return [];
    return [...body.matchAll(/^ {2}([a-z_][a-z0-9_]*) ([a-z]+)/gm)].flatMap(([, name, type]) =>
      name === undefined || type === undefined ? [] : [[name, type] as const],
    );
  });

const INTEGER_TYPES: ReadonlySet<string> = new Set(['smallint', 'integer', 'bigint']);

/** The stored `programs_sites.site` row of a fixture site: integer settings 0, other unset columns NULL, as backfilled Masa defaults. */
function siteRow(fixture: TenantFixture, orderno: number): StoredRow {
  const pools = POOLS[fixture.siteId] ?? { publicUser: fixture.siteId, other: fixture.siteId };
  return {
    ...Object.fromEntries(SITE_COLUMNS.map(([name, type]) => [name, INTEGER_TYPES.has(type) ? 0 : null])),
    tenant_id: fixture.tenantId,
    siteid: fixture.siteId,
    site: `Site ${fixture.siteId}`,
    domain: `${fixture.siteId}.example.test`,
    orderno,
    baseid: `BA5E0000-0000-0000-00000000000${orderno}`,
    row_version: '1',
    publicuserpoolid: pools.publicUser,
    privateuserpoolid: fixture.siteId,
    displaypoolid: pools.other,
    filepoolid: pools.other,
    categorypoolid: pools.other,
    contentpoolid: fixture.siteId,
    sitelocale: '',
  };
}

const SITES: readonly StoredRow[] = [siteRow(TENANT_A, 1), siteRow(TENANT_B, 2)];

/** The `tenant_registry` row of a fixture site. */
function registryRow(fixture: TenantFixture): StoredRow {
  const pools = POOLS[fixture.siteId] ?? { publicUser: fixture.siteId, other: fixture.siteId };
  const tenantOf = (siteId: string): string | null => TENANT_LIST.find((candidate) => candidate.siteId === siteId)?.tenantId ?? null;
  return {
    site_id: fixture.siteId,
    tenant_id: fixture.tenantId,
    public_user_pool_id: pools.publicUser,
    private_user_pool_id: fixture.siteId,
    category_pool_id: pools.other,
    file_pool_id: pools.other,
    display_pool_id: pools.other,
    content_pool_ids: [fixture.siteId],
    public_user_pool_tenant: tenantOf(pools.publicUser),
    private_user_pool_tenant: fixture.tenantId,
    category_pool_tenant: tenantOf(pools.other),
    file_pool_tenant: tenantOf(pools.other),
    display_pool_tenant: tenantOf(pools.other),
    content_pool_tenants: [fixture.tenantId],
    domains: [`${fixture.siteId}.example.test`],
    aggregate_version: '1',
    updated_at: TEST_CLOCK.now(),
  };
}

const REGISTRY: readonly StoredRow[] = [registryRow(TENANT_A), registryRow(TENANT_B)];

/** Answers the registry reads of the platform tenancy helpers from REGISTRY. */
function registryAnswer(params: unknown[], sql: string): StoredRow[] {
  if (/lower\(site_id\) = lower\(\$1\)/i.test(sql)) {
    return REGISTRY.filter((row) => row.site_id === String(params[0]).toLowerCase());
  }
  if (/WHERE tenant_id = \$1/i.test(sql)) return REGISTRY.filter((row) => row.tenant_id === params[0]);
  return [...REGISTRY];
}

/** Answers a `programs_sites.site` read: the tenant's rows, narrowed to the site id a keyed read binds. */
function siteAnswer(params: unknown[]): StoredRow[] {
  const [tenantId, siteId] = params;
  return SITES.filter(
    (row) => row.tenant_id === tenantId && (typeof siteId !== 'string' || siteId.toLowerCase() === row.siteid),
  );
}

/** Handler effects since the last `resetEffects`. */
interface Effects {
  statements: number;
  writes: number;
  published: number;
  tasks: number;
  taskCalls: number;
  calls: number;
}

/** Empties the recordings and snapshots the task port before a probe. */
function resetEffects(): void {
  t.db.clear();
  t.publisher.clear();
  t.client.clear();
  taskCount = t.taskPort.tasks().length;
  taskCallCount = t.taskPort.calls.length;
}

/** Effects since `resetEffects`; service calls named in `tolerated` are not counted. */
function effectsAfter(tolerated: readonly string[] = []): Effects {
  const calls = t.client.requests.filter(
    (call) => !tolerated.includes(`${call.service} ${call.method} ${call.path.split('?', 1)[0] ?? ''}`),
  );
  return {
    statements: t.db.statements().length,
    writes: t.db.writes().length,
    published: t.publisher.published.length + t.publisher.raw.length,
    tasks: t.taskPort.tasks().length - taskCount,
    taskCalls: t.taskPort.calls.length - taskCallCount,
    calls: calls.length,
  };
}

const NO_EFFECTS: Effects = { statements: 0, writes: 0, published: 0, tasks: 0, taskCalls: 0, calls: 0 };

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Record<string, string>> }>();

// Tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `headersFor(subject)`, reused across probes while its tokens are fresh. */
function credentialsOf(subject: RoleSubject): Promise<Record<string, string>> {
  const cached = credentialCache.get(subject.name);
  if (cached !== undefined && Date.now() - cached.mintedAt < CREDENTIAL_REUSE_MS) return cached.headers;
  const headers = headersFor(subject);
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

function subjectNamed(name: string): RoleSubject {
  const subject = ROLE_SET.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return subject;
}

/** Credentials of a user token minted for `fixture`'s site and presented through the gateway. */
async function userCredentials(fixture: TenantFixture, roles: readonly string[]): Promise<Record<string, string>> {
  const [userToken, gatewayToken] = await Promise.all([
    mintUserToken({ sub: `test-boundary-${roles.join('-')}`, site: fixture.siteId, tid: fixture.tenantId, roles }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${gatewayToken}` };
}

function inject(request: ProbeRequest, credentials: Record<string, string>): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

/** A contract-valid `programs-sites.site.changed.v1` envelope of tenant-a. */
function siteChangedEnvelope(): EventEnvelope {
  return testEnvelope({
    topic: 'programs-sites.site.changed.v1',
    tenantId: TENANT_A.tenantId,
    aggregateId: SITE_A,
    payload: {
      siteId: SITE_A,
      publicUserPoolId: 'umbrella',
      privateUserPoolId: SITE_A,
      categoryPoolId: 'umbrella',
      filePoolId: 'umbrella',
      displayPoolId: 'umbrella',
      contentPoolIds: [SITE_A],
      domains: [`${SITE_A}.example.test`],
    },
  });
}

/** The Pub/Sub push body of `envelope`, as delivered without the push key. */
function pushBodyOf(envelope: EventEnvelope): Record<string, unknown> {
  return { ...buildPushBody({ data: encodeEnvelope(envelope), messageId: randomUUID(), subscription: SITE_CHANGED_SUBSCRIPTION }) };
}

/** A tenant-less Cloud Tasks body on `queue`. */
function systemTaskBody(queue: string): Record<string, unknown> {
  return { queue, name: `${queue}-authz-probe`, tenantId: null, payload: null };
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** A probe of `request` with the given admitted subjects and options. */
function probe(title: string, request: ProbeRequest, allow: readonly string[], extra: Partial<Probe> = {}): Probe {
  return { title, request, allow, ...extra };
}

const MIGRATION_ONLY = ['service:migration'] as const;
const QUEUE_CONTROLLERS = ['service:migration', 'service:operator'] as const;

/** Public on the service transport: a managed tasks token is still verified, and refused, as a user token. */
const PUBLIC_ADMITTED = everyoneBut('service:tasks-invoker');

/** JSON API `site` reads: public, but a token of another site is refused once the handler resolves the site. */
const JSON_API_READERS = everyoneBut('other-tenant', 'service:tasks-invoker');

type JsonApiMode = 'json' | 'ajax' | 'rest';

const JSON_API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'] as const;

/** A JSON API `site` read through `method` under `lead`: a three-segment site path is findOne under any verb (jsonApiUtility.cfc:399). */
function jsonApiRead(mode: JsonApiMode, method: ProbeRequest['method'], lead: string): Probe {
  const url = `${lead}/_api/${mode}/v1/${SITE_A}/site/${SITE_A}`;
  return probe(`${method} ${lead}${mode} site read`, { method, url }, JSON_API_READERS, {
    denyCheck: { 'other-tenant': SITE_MISMATCH },
  });
}

/** The verb's own `site` write on the entity path, where the verb has one. */
function jsonApiWrites(mode: JsonApiMode, method: ProbeRequest['method'], lead: string): Probe[] {
  const url = `${lead}/_api/${mode}/v1/${SITE_A}/site`;
  if (method === 'POST' && mode === 'json') {
    // jsonApiUtility.cfc:1980: a session-managed save consumes the CSRF token before allowAction runs.
    const request: ProbeRequest = { method, url, headers: FORM, payload: `${TOKEN_FIELDS}&domain=${SITE_A}.example.test` };
    return [
      probe(`${lead}json site.save with a valid CSRF token`, request, ['s2'], {
        subjects: ['s2', 'site-admin'],
        denyCheck: { 'site-admin': INSUFFICIENT_PERMISSIONS },
        deniedCalls: [CSRF_CONSUME_CALL],
      }),
    ];
  }
  if (method === 'POST' && mode === 'rest') {
    // jsonApiUtility.cfc:1800-1806, 1998-1999: allowAction('site') is isSuperUser; REST is sessionless, so no CSRF check precedes it.
    return [
      probe(`${lead}rest site.save`, { ...REST_SAVE, url }, ['s2'], {
        denyCheck: {
          ...denials(everyoneBut('s2', 'other-tenant', 'service:tasks-invoker'), INSUFFICIENT_PERMISSIONS),
          'other-tenant': SITE_MISMATCH,
        },
      }),
    ];
  }
  if (method === 'DELETE') {
    // jsonApiUtility.cfc:3317-3325: a stored site needs allowAction before any CSRF check; the S2 call then fails, deleting nothing.
    return [
      probe(`${lead}${mode} site.delete`, { method, url, headers: FORM, payload: TOKEN_FIELDS }, ['s2'], {
        denyCheck: {
          ...denials(everyoneBut('s2', 'other-tenant', 'service:tasks-invoker'), INSUFFICIENT_PERMISSIONS),
          'other-tenant': SITE_MISMATCH,
        },
      }),
    ];
  }
  return [];
}

/** Every JSON API route of the `site` entity, with and without the front controller, keyed as registered. */
function jsonApiRoutes(): Record<string, Expected> {
  const routes: Record<string, Expected> = {};
  for (const lead of ['', '/index.cfm']) {
    for (const mode of ['json', 'ajax', 'rest'] as const) {
      for (const method of JSON_API_METHODS) {
        // jsonApiUtility.cfc:69-73: `site` is a public entity.
        routes[`${method} ${lead}/_api/${mode}/v1*`] = {
          declared: JSON_API_ENTITY,
          probes: [jsonApiRead(mode, method, lead), ...jsonApiWrites(mode, method, lead)],
        };
      }
    }
  }
  return routes;
}

/** The public site-monitor run at `url`. */
function siteMonitorRun(method: ProbeRequest['method'], url: string): Expected {
  // contentServer.cfc:669-747: unauthenticated in legacy, a reported pre-existing weakness.
  return {
    declared: { transport: 'service', public: true, siteCheck: false },
    probes: [probe(`${method} ${url}`, { method, url }, PUBLIC_ADMITTED)],
  };
}

/** A route of the migration-kit or cursor hand-off surface, for the migration workload alone. */
function migrationRoute(request: ProbeRequest): Expected {
  return {
    declared: { transport: 'service', requires: ['platform.migration'] },
    probes: [probe(`${request.method} ${request.url}`, request, MIGRATION_ONLY)],
  };
}

/** A queue-control route on this service's own outbox sweep queue. */
function queueControl(op: 'pause' | 'resume' | 'ensure'): Expected {
  return {
    declared: { transport: 'service', requires: ['platform.migration', 'platform.operator'] },
    probes: [probe(`${op} ${SWEEP_QUEUE}`, { method: 'POST', url: `/internal/v1/task-queues/${SWEEP_QUEUE}/${op}` }, QUEUE_CONTROLLERS)],
  };
}

/** A managed Cloud Tasks route, for the tasks invoker alone. */
function taskRoute(url: string, queue: string): Expected {
  return {
    declared: { transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE] },
    probes: [
      probe(`POST ${url}`, { method: 'POST', url, headers: JSON_HEADERS, payload: systemTaskBody(queue) }, ['service:tasks-invoker']),
    ],
  };
}

/** Delivers the site.changed push as `subject`: the invoker through the local push key, everyone else with only its own credentials. */
function sendPush(subject: RoleSubject, credentials: Record<string, string>): Promise<InjectResponse> {
  const envelope = siteChangedEnvelope();
  if (subject.name === PUBSUB_INVOKER_ROLE) return pushTo(t.app, SITE_CHANGED_SUBSCRIPTION, envelope);
  return inject({ method: 'POST', url: PUSH_URL, headers: JSON_HEADERS, payload: pushBodyOf(envelope) }, credentials);
}

const JSON_API_ENTITY: Declared = { transport: 'service', public: true, siteCheck: false };
const S2_OR_SITE_ADMIN: Declared = { transport: 'service', requires: ['s2', 'site-admin'] };
const PRIVATE_ADMIN: Declared = { transport: 'service', requires: ['s2', 'site-admin', 'system-user'] };
const SIZE_URL = `/v1/sites/${SITE_A}/image-sizes/${SIZE_ID}`;

const SITE_READ: ProbeRequest = { method: 'GET', url: `/v1/sites/${SITE_A}` };
const SITE_UPDATE: ProbeRequest = {
  method: 'POST',
  url: `/v1/sites/${SITE_A}/update`,
  headers: FORM,
  payload: `siteid=${SITE_A}&action=Update&site=Site%20${SITE_A}&${TOKEN_FIELDS}`,
};
const IMAGE_SIZES_READ: ProbeRequest = { method: 'GET', url: `/v1/sites/${SITE_A}/image-sizes` };
const JSON_API_READ: ProbeRequest = { method: 'GET', url: `/_api/json/v1/${SITE_A}/site` };
const REST_SAVE: ProbeRequest = {
  method: 'POST',
  url: `/_api/rest/v1/${SITE_A}/site`,
  headers: FORM,
  payload: `domain=${SITE_A}.example.test`,
};

/** Every registered route, keyed `<METHOD> <fastify url>`, with its declaration and tenant-a probes. */
const EXPECTED: Readonly<Record<string, Expected>> = {
  ...jsonApiRoutes(),
  'DELETE /_api/sitemonitor*': siteMonitorRun('DELETE', '/_api/sitemonitor/'),
  'GET /_api/sitemonitor*': siteMonitorRun('GET', '/_api/sitemonitor/'),
  'HEAD /_api/sitemonitor*': siteMonitorRun('HEAD', '/_api/sitemonitor/'),
  'OPTIONS /_api/sitemonitor*': siteMonitorRun('OPTIONS', '/_api/sitemonitor/'),
  'PATCH /_api/sitemonitor*': siteMonitorRun('PATCH', '/_api/sitemonitor/'),
  'POST /_api/sitemonitor*': siteMonitorRun('POST', '/_api/sitemonitor/'),
  'PUT /_api/sitemonitor*': siteMonitorRun('PUT', '/_api/sitemonitor/'),
  'GET /healthz': {
    declared: { transport: 'service', public: true },
    probes: [probe('GET /healthz', { method: 'GET', url: '/healthz' }, PUBLIC_ADMITTED)],
  },
  'DELETE /index.cfm/_api/sitemonitor*': siteMonitorRun('DELETE', '/index.cfm/_api/sitemonitor/'),
  'GET /index.cfm/_api/sitemonitor*': siteMonitorRun('GET', '/index.cfm/_api/sitemonitor/'),
  'HEAD /index.cfm/_api/sitemonitor*': siteMonitorRun('HEAD', '/index.cfm/_api/sitemonitor/'),
  'OPTIONS /index.cfm/_api/sitemonitor*': siteMonitorRun('OPTIONS', '/index.cfm/_api/sitemonitor/'),
  'PATCH /index.cfm/_api/sitemonitor*': siteMonitorRun('PATCH', '/index.cfm/_api/sitemonitor/'),
  'POST /index.cfm/_api/sitemonitor*': siteMonitorRun('POST', '/index.cfm/_api/sitemonitor/'),
  'PUT /index.cfm/_api/sitemonitor*': siteMonitorRun('PUT', '/index.cfm/_api/sitemonitor/'),
  'POST /internal/v1/events/programs-sites.programs-sites.site.changed.v1': {
    declared: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
    probes: [probe('site.changed push', { method: 'POST', url: PUSH_URL }, ['service:pubsub-invoker'], { send: sendPush })],
  },
  'POST /internal/v1/jobs/sitemonitor': taskRoute('/internal/v1/jobs/sitemonitor', SITEMONITOR_QUEUE),
  'POST /internal/v1/migration/apply': migrationRoute({
    method: 'POST',
    url: '/internal/v1/migration/apply',
    headers: JSON_HEADERS,
    payload: {},
  }),
  'GET /internal/v1/migration/changes': migrationRoute({
    method: 'GET',
    url: `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}`,
  }),
  'GET /internal/v1/migration/export': migrationRoute({
    method: 'GET',
    url: `/internal/v1/migration/export?unit=programs_sites.site&tenantId=${TENANT_A.tenantId}`,
  }),
  'POST /internal/v1/migration/gate': migrationRoute({
    method: 'POST',
    url: '/internal/v1/migration/gate',
    headers: JSON_HEADERS,
    payload: {},
  }),
  'GET /internal/v1/migration/position': migrationRoute({ method: 'GET', url: '/internal/v1/migration/position' }),
  'GET /internal/v1/migration/watermark': migrationRoute({ method: 'GET', url: '/internal/v1/migration/watermark' }),
  'POST /internal/v1/migration/watermark': migrationRoute({
    method: 'POST',
    url: '/internal/v1/migration/watermark',
    headers: JSON_HEADERS,
    payload: {},
  }),
  'POST /internal/v1/outbox/sweep': taskRoute('/internal/v1/outbox/sweep', SWEEP_QUEUE),
  'GET /internal/v1/sitemonitor/state': migrationRoute({ method: 'GET', url: '/internal/v1/sitemonitor/state' }),
  'PUT /internal/v1/sitemonitor/state': migrationRoute({
    method: 'PUT',
    url: '/internal/v1/sitemonitor/state',
    headers: JSON_HEADERS,
    payload: { lastMonitored: '2026-06-30T11:45:00.000' },
  }),
  'POST /internal/v1/task-queues/:queue/ensure': queueControl('ensure'),
  'POST /internal/v1/task-queues/:queue/pause': queueControl('pause'),
  'POST /internal/v1/task-queues/:queue/resume': queueControl('resume'),
  // utility.sanitizeHref's domains for the gateway; every user request arrives with the gateway's invocation credential,
  // and a user token naming another site than the request's siteid is refused.
  'GET /v1/href-domains': {
    declared: { transport: 'service', requires: ['service:gateway'] },
    probes: [
      probe('GET /v1/href-domains', { method: 'GET', url: `/v1/href-domains?siteid=${SITE_A}` }, [
        'member',
        ...TENANT_A_PRIVATE_USERS,
        'service:gateway',
      ]),
    ],
  },
  // csettings.cfc:84-94: `list` is excluded from the site Admin grant, so only S2 lists sites.
  'GET /v1/sites': {
    declared: { transport: 'service', requires: ['s2'] },
    probes: [probe('GET /v1/sites', { method: 'GET', url: '/v1/sites' }, ['s2'])],
  },
  // csettings.cfc:84-94: Admin of the site's private user pool, or S2.
  'GET /v1/sites/:siteId': {
    declared: S2_OR_SITE_ADMIN,
    probes: [probe('GET site', SITE_READ, ['s2', 'site-admin'])],
  },
  'GET /v1/sites/:siteId/image-sizes': {
    declared: S2_OR_SITE_ADMIN,
    probes: [probe('list image sizes', IMAGE_SIZES_READ, ['s2', 'site-admin'])],
  },
  'DELETE /v1/sites/:siteId/image-sizes/:sizeId': {
    declared: S2_OR_SITE_ADMIN,
    probes: [probe('delete image size', { method: 'DELETE', url: SIZE_URL }, ['s2', 'site-admin'])],
  },
  'GET /v1/sites/:siteId/image-sizes/:sizeId': {
    declared: S2_OR_SITE_ADMIN,
    probes: [probe('get image size', { method: 'GET', url: SIZE_URL }, ['s2', 'site-admin'])],
  },
  'PUT /v1/sites/:siteId/image-sizes/:sizeId': {
    declared: S2_OR_SITE_ADMIN,
    probes: [
      probe('save image size', { method: 'PUT', url: SIZE_URL, headers: FORM, payload: 'name=probe&height=100&width=100' }, [
        's2',
        'site-admin',
      ]),
    ],
  },
  // nav.cfm:119-207: the admin layout reads the site for every private-pool admin user.
  'GET /v1/sites/:siteId/shell': {
    declared: PRIVATE_ADMIN,
    probes: [probe('GET shell site', { method: 'GET', url: `/v1/sites/${SITE_A}/shell` }, TENANT_A_PRIVATE_USERS)],
  },
  // filetools.cfm:37: the user form reads a pooled user's site for its photo URL, for the same private-pool admin users.
  'GET /v1/sites/:siteId/user-pool-sites': {
    declared: PRIVATE_ADMIN,
    probes: [probe('GET user pool sites', { method: 'GET', url: `/v1/sites/${SITE_A}/user-pool-sites` }, TENANT_A_PRIVATE_USERS)],
  },
  // csettings.cfc:170-225 behind the same before() gate.
  'POST /v1/sites/:siteId/update': {
    declared: S2_OR_SITE_ADMIN,
    probes: [probe('update site', SITE_UPDATE, ['s2', 'site-admin'])],
  },
  // csettings.cfc:108-111: the order save is the `list` branch, so S2 only.
  'POST /v1/sites/order': {
    declared: { transport: 'service', requires: ['s2'] },
    probes: [
      probe(
        'save site order',
        { method: 'POST', url: '/v1/sites/order', headers: FORM, payload: `orderid=${SITE_A}&orderno=1&${TOKEN_FIELDS}` },
        ['s2'],
      ),
    ],
  },
  // settingsManager.getUserSites for any private-pool admin user; the route reads no siteid, so other-tenant lists its own.
  'GET /v1/user-sites': {
    declared: PRIVATE_ADMIN,
    probes: [probe('GET /v1/user-sites', { method: 'GET', url: '/v1/user-sites' }, [...TENANT_A_PRIVATE_USERS, 'other-tenant'])],
  },
};

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

function parsedBody(res: InjectResponse): unknown {
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether `body` is a legacy JSON API error envelope. */
function isErrorEnvelope(body: unknown): body is { error: { code: string; message: string } } {
  if (typeof body !== 'object' || body === null) return false;
  const { error } = body as { error?: unknown };
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string';
}

/** Every way one probe sent as one subject departs from its expectation. */
async function mismatchesOf(item: Probe, subject: RoleSubject): Promise<string[]> {
  resetEffects();
  const credentials = await credentialsOf(subject);
  const res = item.send === undefined ? await inject(item.request, credentials) : await item.send(subject, credentials);
  const at = `${item.title} as ${subject.name}`;
  if (res.statusCode === 404) return [`${at}: 404, so the probe missed its route`];
  const admitted = res.statusCode !== 401 && res.statusCode !== 403;
  const shouldAdmit = item.allow.includes(subject.name);
  if (admitted !== shouldAdmit) {
    return [`${at}: expected ${shouldAdmit ? 'admission' : 'denial'}, got ${res.statusCode} ${res.body.slice(0, 160)}`];
  }
  if (admitted) return [];

  const problems: string[] = [];
  const body = parsedBody(res);
  // A JSON API HEAD denial carries the error envelope's headers alone; other HEAD routes leave the body to Node, which never sends it.
  const head = item.request.method === 'HEAD' && /^(?:\/index\.cfm)?\/_api\/(?:json|ajax|rest)\/v1/i.test(item.request.url);
  if (head && res.body !== '') problems.push(`${at}: a HEAD denial has a body: ${res.body.slice(0, 160)}`);
  if (!head && !isErrorEnvelope(body)) problems.push(`${at}: denial is not the legacy error envelope: ${res.body.slice(0, 160)}`);
  if (subject.kind === 'anonymous' && res.statusCode !== 401) problems.push(`${at}: no credential must answer 401, got ${res.statusCode}`);
  const handler = item.denyCheck?.[subject.name];
  if (handler !== undefined) {
    if (res.statusCode !== handler.status) problems.push(`${at}: expected ${handler.status}, got ${res.statusCode}`);
    const { error } = handler;
    if (error !== undefined && isErrorEnvelope(body) && (body.error.code !== error.code || body.error.message !== error.message)) {
      problems.push(`${at}: expected error ${JSON.stringify(error)}, got ${JSON.stringify(body.error)}`);
    }
  }
  // A hook-level denial runs no query; a handler-level one may read, but writes and calls nothing.
  const effects = effectsAfter(handler === undefined ? [] : (item.deniedCalls ?? []));
  const expected: Effects = handler === undefined ? NO_EFFECTS : { ...NO_EFFECTS, statements: effects.statements };
  if (JSON.stringify(effects) !== JSON.stringify(expected)) problems.push(`${at}: denial left effects ${JSON.stringify(effects)}`);
  return problems;
}

/** Status of `request` sent with `credentials`, with the writes, publishes, tasks and service calls it left. */
async function outcomeOf(
  request: ProbeRequest,
  credentials: Record<string, string>,
): Promise<{ status: number; effects: Omit<Effects, 'statements'> }> {
  resetEffects();
  const res = await inject(request, credentials);
  const { statements: _reads, ...effects } = effectsAfter();
  return { status: res.statusCode, effects };
}

const QUIET: Omit<Effects, 'statements'> = { writes: 0, published: 0, tasks: 0, taskCalls: 0, calls: 0 };

const SESSION_SITES = { status: 200, headers: {}, body: { sites: [{ siteID: SITE_A, site: `Site ${SITE_A}` }] } };

beforeAll(async () => {
  t = await buildTestApp();
  matrix = collectRouteMatrix(t.app);
  t.db.respond(/^SELECT .+ FROM "?programs_sites"?\."?tenant_registry\b/i, registryAnswer);
  t.db.respond(/^SELECT \* FROM "?programs_sites"?\."?site\b/i, siteAnswer);
  t.db.respond(/^SELECT to_regclass\(/i, [{ outbox: false, inbox: false }]);
  t.client.csrfValid(true);
  t.client.on('identity', 'GET', '/v1/sessions/current/sites', () => SESSION_SITES);
});

afterAll(async () => {
  await t?.app.close();
});

beforeEach(() => {
  resetEffects();
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

  it('probes the full ROLE_SET subject set', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    expect(names).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS]));
    expect([...names].sort()).toEqual([...EVERYONE].sort());
  });

  it('names only ROLE_SET subjects in the expectations', () => {
    const named = Object.values(EXPECTED).flatMap((entry) =>
      entry.probes.flatMap((item) => [...item.allow, ...(item.subjects ?? []), ...Object.keys(item.denyCheck ?? {})]),
    );
    expect(named.filter((name) => !ROLE_SET.some((subject) => subject.name === name))).toEqual([]);
  });
});

describe('route admission', () => {
  for (const [key, entry] of Object.entries(EXPECTED)) {
    it(`admits exactly the expected subjects on ${key}, and denials leave no handler effect`, { timeout: 120_000 }, async () => {
      const mismatches: string[] = [];
      for (const item of entry.probes) {
        const subjects = item.subjects === undefined ? ROLE_SET : item.subjects.map(subjectNamed);
        for (const subject of subjects) mismatches.push(...(await mismatchesOf(item, subject)));
      }
      expect(mismatches).toEqual([]);
    });
  }
});

describe('tenant boundary', () => {
  const tenantARequests: readonly ProbeRequest[] = [SITE_READ, SITE_UPDATE, IMAGE_SIZES_READ, JSON_API_READ, REST_SAVE];

  it.each([
    ['a tenant-b site-admin', ['site-admin']],
    ['an s2 user whose token names site tenant-b', ['system-user', 's2']],
  ])('refuses %s on every tenant-a site route without handler effect', async (_label, roles) => {
    const credentials = await userCredentials(TENANT_B, roles);
    for (const request of tenantARequests) {
      expect({ url: request.url, ...(await outcomeOf(request, credentials)) }).toEqual({ url: request.url, status: 403, effects: QUIET });
    }
  });

  it('refuses a tenant-a site-admin on tenant-b and admits it on tenant-a', async () => {
    const credentials = await userCredentials(TENANT_A, ['system-user', 'site-admin']);
    expect(await outcomeOf({ method: 'GET', url: `/v1/sites/${SITE_B}` }, credentials)).toEqual({ status: 403, effects: QUIET });
    expect((await outcomeOf(SITE_READ, credentials)).status).toBe(200);
  });
});

describe('transport separation', () => {
  const pushWithoutKey = (): ProbeRequest => ({
    method: 'POST',
    url: PUSH_URL,
    headers: JSON_HEADERS,
    payload: pushBodyOf(siteChangedEnvelope()),
  });
  const sitemonitorTask: ProbeRequest = {
    method: 'POST',
    url: '/internal/v1/jobs/sitemonitor',
    headers: JSON_HEADERS,
    payload: systemTaskBody(SITEMONITOR_QUEUE),
  };
  const sweepTask: ProbeRequest = {
    method: 'POST',
    url: '/internal/v1/outbox/sweep',
    headers: JSON_HEADERS,
    payload: systemTaskBody(SWEEP_QUEUE),
  };
  const withPushKey = (request: ProbeRequest): ProbeRequest => ({ ...request, url: `${request.url}?key=${TEST_PUSH_KEY}` });

  it('refuses a user token on the push and task routes', async () => {
    const credentials = await credentialsOf(subjectNamed('s2'));
    for (const request of [pushWithoutKey(), sitemonitorTask, sweepTask]) {
      expect({ url: request.url, ...(await outcomeOf(request, credentials)) }).toEqual({ url: request.url, status: 401, effects: QUIET });
    }
  });

  it('refuses a tasks-invoker token on user routes, with or without the gateway invocation credential', async () => {
    const tasksToken = `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`;
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const presented: Record<string, string>[] = [
      { authorization: tasksToken },
      { authorization: tasksToken, [INVOCATION_HEADER]: gatewayToken },
    ];
    for (const credentials of presented) {
      for (const request of [SITE_READ, REST_SAVE]) {
        expect({ url: request.url, ...(await outcomeOf(request, credentials)) }).toEqual({ url: request.url, status: 401, effects: QUIET });
      }
    }
  });

  it('refuses the push key on a user route', async () => {
    const gatewayToken = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
    const sitesWithKey = withPushKey({ method: 'GET', url: '/v1/sites' });
    const presented: Record<string, string>[] = [{}, { [INVOCATION_HEADER]: gatewayToken }];
    for (const credentials of presented) {
      expect(await outcomeOf(sitesWithKey, credentials)).toEqual({ status: 401, effects: QUIET });
    }
  });

  it('refuses the push key on task routes and a tasks-invoker token on the push route', async () => {
    for (const request of [withPushKey(sitemonitorTask), withPushKey(sweepTask)]) {
      expect({ url: request.url, ...(await outcomeOf(request, {})) }).toEqual({ url: request.url, status: 401, effects: QUIET });
    }
    const tasksToken = { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` };
    for (const request of [pushWithoutKey(), withPushKey(pushWithoutKey())]) {
      expect({ url: request.url, ...(await outcomeOf(request, tasksToken)) }).toEqual({ url: request.url, status: 401, effects: QUIET });
    }
  });
});

describe('deny by default at start-up', () => {
  it('fails start-up of the buildApp instance when a route declares no config.opt2', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-authz-'));
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
      app.register(async (child) => {
        child.get('/v1/opt2-undeclared-probe', async () => ({}));
      });
      await expect(app.ready()).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await app?.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
