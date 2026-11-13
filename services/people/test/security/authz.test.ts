/** In-process authorisation matrix of every people route: declarations, admitted subjects, transport and tenant boundaries, deny by default. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  moduleRole,
  type Opt2RouteConfig,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, pushPath, type EventEnvelope } from '@opt2/platform/events';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import { OUTBOX_SWEEP_PATH, QUEUE_CONTROL_PREFIX } from '@opt2/platform/tasks';
import { createService, type FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  TEST_PUSH_KEY,
  authHeadersFor,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  pushTo,
  registryPayloads,
  subjectQueryFor,
  subjectSiteFor,
  testEnvelope,
  testVerifier,
  writeTestSecrets,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { createFaultHooks } from '../../src/domain/faults.js';
import { GROUP_NAME_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { GROUP_CHANGED_TOPIC, SITE_CHANGED_TOPIC, type GroupChangedPayload } from '../../src/events/topics.js';
import { PEOPLE_MAPPINGS } from '../../src/migration/mappings/index.js';
import { createPeopleRepository } from '../../src/repo/repository.js';
import type { AddressRow, PersonRow } from '../../src/repo/tables.js';
import { registerAdminDownloadRoutes } from '../../src/routes/admin-downloads.js';
import { registerAdminProfileRoutes } from '../../src/routes/admin-profile.js';
import { registerAdminUserRoutes } from '../../src/routes/admin-users.js';
import { PEOPLE_SWEEP_QUEUE } from '../../src/tasks/port.js';
import { accountFor, addressRow, personRow, seedPeople, type PeopleSeed } from '../helpers/fixtures.js';
import { buildPeopleRouteApp, createIdentityDouble, peopleEnv, silentLogger, type PeopleRouteApp } from '../helpers/route-app.js';

const SERVICE = 'people';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const ON_SITE_A = `siteid=${SITE_A}`;
const USERS_MODULE = moduleRole('00000000000000000000000000000000008');
const SITE_MANAGER_MODULE = moduleRole('00000000000000000000000000000000000');

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

/** System users of tenant-a holding a module grant: both grants the cUsers gate takes in place of admin, or the Users grant alone. */
const MODULE_SUBJECTS: readonly RoleSubject[] = Object.freeze([
  Object.freeze({ name: 'users-module', kind: 'user', roles: Object.freeze([Roles.systemUser, USERS_MODULE, SITE_MANAGER_MODULE]) }),
  Object.freeze({ name: 'users-module-only', kind: 'user', roles: Object.freeze([Roles.systemUser, USERS_MODULE]) }),
] satisfies RoleSubject[]);

const SUBJECTS: readonly RoleSubject[] = [...ROLE_SET, ...MODULE_SUBJECTS];

const USERS: readonly string[] = [
  'member',
  'system-user',
  'editor',
  'site-admin',
  's2',
  ...SYNTHETIC,
  'users-module',
  'users-module-only',
  'other-tenant',
];

const EVERYONE: readonly string[] = ['anonymous', ...USERS, ...WORKLOADS];

const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;

/** Without a user token a user-role route answers 401, whatever workload calls it. */
const NO_USER: readonly string[] = ['anonymous', ...WORKLOADS];

/** Subjects presenting no invocation credential on the service transport. */
const NO_INVOCATION: readonly string[] = ['anonymous', 'service:pubsub-invoker', 'service:tasks-invoker'];

/** The cUsers gate's admin or both-module callers, on their own site. */
const CUSERS_ADMITTED: readonly string[] = ['site-admin', 's2', 'users-module'];

/** EVERYONE without `excluded`. */
function everyoneBut(...excluded: string[]): string[] {
  return EVERYONE.filter((name) => !excluded.includes(name));
}

interface Declared {
  transport: Transport;
  requires?: readonly string[];
  public?: true;
  /** `false` where the handler runs the site check itself. */
  siteCheck?: false;
}

/** One request; each subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: 'GET' | 'POST';
  url: string;
  form?: Readonly<Record<string, string>>;
  json?: unknown;
}

interface Expectation {
  declared: Declared;
  /** The tenant-a request `send` makes, where it is one fixed request. */
  request?: ProbeRequest;
  send: (subject: RoleSubject) => Promise<InjectResponse>;
  /** Subjects admitted with a 2xx answer; every other subject is refused. */
  allow: readonly string[];
  /** Refused subjects answered 401; the rest are answered 403. */
  deny401: readonly string[];
}

interface Effects {
  transactions: number;
  identityCalls: number;
  serviceCalls: number;
  published: number;
}

const NO_EFFECTS: Effects = Object.freeze({ transactions: 0, identityCalls: 0, serviceCalls: 0, published: 0 });

interface ErrorBody {
  code: string;
  message: string;
}

function errorBody({ code, message }: ErrorBody): ErrorBody {
  return { code, message };
}

/** Error bodies a refusal may carry: the legacy JSON API rows of the auth denials. */
const DENIAL_ERRORS: Readonly<Record<401 | 403, readonly ErrorBody[]>> = {
  401: [LEGACY_ERROR_MAP.authorization, LEGACY_ERROR_MAP.invalidAccessToken, LEGACY_ERROR_MAP.accessTokenExpired].map(errorBody),
  403: [LEGACY_ERROR_MAP.authorization].map(errorBody),
};

/** Site whose user pool stores a user subject's person: tenant-a's public pool for the member, the token's site otherwise. */
function personSiteOf(subject: RoleSubject): string {
  return subject.name === Roles.member ? TENANT_UMBRELLA.siteId : subjectSiteFor(subject, SITE_A);
}

/** The person each user subject's token names. */
const PERSONS: ReadonlyMap<string, PersonRow> = new Map(
  SUBJECTS.filter((subject) => subject.kind === 'user').map((subject) => {
    const site = personSiteOf(subject);
    const local = subject.name.replace(/[^a-z0-9]+/g, '_');
    return [subject.name, Object.freeze(personRow({ siteid: site, fname: 'Probe', lname: subject.name, email: `${local}@${site}.opt2.test` }))];
  }),
);

/** A tenant-a system user no subject is, with a primary address, for the tenant-boundary reads. */
const TARGET: PersonRow = Object.freeze(personRow({ siteid: SITE_A, fname: 'Tara', lname: 'Target', email: 'target@tenant-a.opt2.test' }));
const TARGET_ADDRESS: AddressRow = Object.freeze(addressRow({ tenant_id: TARGET.tenant_id, userid: TARGET.userid, siteid: SITE_A, isprimary: 1 }));

/** The persons and addresses keyed by the tenant that stores them. */
function seedOf(persons: readonly PersonRow[], addresses: readonly AddressRow[]): PeopleSeed {
  const tenants = [...new Set(persons.map((person) => person.tenant_id))];
  return Object.fromEntries(
    tenants.map((tenantId) => [
      tenantId,
      { persons: persons.filter((row) => row.tenant_id === tenantId), addresses: addresses.filter((row) => row.tenant_id === tenantId) },
    ]),
  );
}

function subjectNamed(name: string): RoleSubject {
  const subject = SUBJECTS.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new TypeError(`No subject ${name}`);
  return subject;
}

/** `subject`'s credentials, its user token naming its own person. */
function credentialsOf(subject: RoleSubject): Promise<Record<string, string>> {
  return authHeadersFor(subject, { audience: SERVICE, site: SITE_A, sub: PERSONS.get(subject.name)?.userid });
}

function asCredentials(name: string): Promise<Record<string, string>> {
  return credentialsOf(subjectNamed(name));
}

/** The gateway's invocation credential addressed to `audience`. */
async function gatewayInvocation(audience = SERVICE): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience })}` };
}

/** A tenant-a site-admin user token in `Authorization`, with `claims` overriding its issuer, audience or expiry. */
async function siteAdminToken(claims: { iss?: string; aud?: string; exp?: number } = {}): Promise<Record<string, string>> {
  const token = await mintUserToken({ sub: PERSONS.get('site-admin')?.userid ?? 'site-admin', site: SITE_A, roles: [Roles.systemUser, Roles.siteAdmin], ...claims });
  return { authorization: `Bearer ${token}` };
}

let t: PeopleRouteApp;

/** Sends `request` with `credentials` and the `query` additions. */
function inject(request: ProbeRequest, credentials: Record<string, string>, query: Record<string, string> = {}): Promise<InjectResponse> {
  const extra = new URLSearchParams(query).toString();
  const url = extra === '' ? request.url : `${request.url}${request.url.includes('?') ? '&' : '?'}${extra}`;
  if (request.form !== undefined) {
    const headers = { ...credentials, 'content-type': 'application/x-www-form-urlencoded' };
    return t.app.inject({ method: request.method, url, headers, payload: new URLSearchParams(request.form).toString() });
  }
  if (request.json !== undefined) return t.app.inject({ method: request.method, url, headers: credentials, payload: request.json as object });
  return t.app.inject({ method: request.method, url, headers: credentials });
}

/** Sends a fresh `request()` with each subject's credentials and query. */
function probe(request: ProbeRequest | (() => ProbeRequest)): Expectation['send'] {
  return async (subject) => inject(typeof request === 'function' ? request() : request, await credentialsOf(subject), subjectQueryFor(subject));
}

function mark(): Effects {
  return {
    transactions: t.db.transactions,
    identityCalls: t.identity.calls.length,
    serviceCalls: t.serviceCalls.length,
    published: t.publisher.published.length + t.publisher.raw.length,
  };
}

function effectsSince(from: Effects): Effects {
  const now = mark();
  return {
    transactions: now.transactions - from.transactions,
    identityCalls: now.identityCalls - from.identityCalls,
    serviceCalls: now.serviceCalls - from.serviceCalls,
    published: now.published - from.published,
  };
}

/** The `error` of a legacy envelope response, or undefined when the body is not one. */
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

/** Status, error and effects of one request. */
async function outcomeOf(send: () => Promise<InjectResponse>): Promise<{ status: number; error: ErrorBody | undefined; effects: Effects }> {
  const before = mark();
  const res = await send();
  return { status: res.statusCode, error: errorOf(res), effects: effectsSince(before) };
}

/** Whether `outcome` is a refusal at `status` with a legacy auth error that reached no data, identity or service. */
function isCleanRefusal(outcome: { status: number; error: ErrorBody | undefined; effects: Effects }, status: 401 | 403): boolean {
  return (
    outcome.status === status &&
    outcome.error !== undefined &&
    DENIAL_ERRORS[status].some((allowed) => isDeepStrictEqual(allowed, outcome.error)) &&
    isDeepStrictEqual(outcome.effects, NO_EFFECTS)
  );
}

/** Every way one probe sent as one subject departs from its expectation. */
async function mismatchesOf(key: string, entry: Expectation, subject: RoleSubject): Promise<string[]> {
  const before = mark();
  const res = await entry.send(subject);
  const at = `${key} as ${subject.name}`;
  const admitted = res.statusCode !== 401 && res.statusCode !== 403;
  const shouldAdmit = entry.allow.includes(subject.name);
  if (admitted !== shouldAdmit) {
    return [`${at}: expected ${shouldAdmit ? 'admission' : 'denial'}, got ${res.statusCode} ${res.body.slice(0, 200)}`];
  }
  if (admitted) return res.statusCode >= 200 && res.statusCode < 300 ? [] : [`${at}: admitted request answered ${res.statusCode} ${res.body.slice(0, 200)}`];

  const problems: string[] = [];
  const status = entry.deny401.includes(subject.name) ? 401 : 403;
  if (res.statusCode !== status) problems.push(`${at}: expected ${status}, got ${res.statusCode}`);
  const error = errorOf(res);
  if (error === undefined || !DENIAL_ERRORS[res.statusCode as 401 | 403].some((allowed) => isDeepStrictEqual(allowed, error))) {
    problems.push(`${at}: denial is not a legacy auth error: ${res.body.slice(0, 200)}`);
  }
  const effects = effectsSince(before);
  if (!isDeepStrictEqual(effects, NO_EFFECTS)) problems.push(`${at}: denial left effects ${JSON.stringify(effects)}`);
  return problems;
}

const CUSERS: Declared = { transport: 'service', requires: ['s2', 'site-admin', 'm:008'] };
const PROFILE: Declared = { transport: 'service', requires: ['system-user', 'member', 's2', 'site-admin'] };
const MIGRATION: Declared = { transport: 'service', requires: ['platform.migration'] };
const QUEUE_CONTROL: Declared = { transport: 'service', requires: ['platform.migration', 'platform.operator'] };

/** A cUsers read: admin or both module grants on the token's site. */
function cusersRoute(request: ProbeRequest, declared: Declared = CUSERS): Expectation {
  return { declared, request, send: probe(request), allow: CUSERS_ADMITTED, deny401: NO_USER };
}

function migrationRoute(request: ProbeRequest | (() => ProbeRequest)): Expectation {
  return { declared: MIGRATION, send: probe(request), allow: ['service:migration'], deny401: NO_INVOCATION };
}

function queueControlRoute(op: string): Expectation {
  const request: ProbeRequest = { method: 'POST', url: `${QUEUE_CONTROL_PREFIX}/${PEOPLE_SWEEP_QUEUE}/${op}`, json: {} };
  return { declared: QUEUE_CONTROL, send: probe(request), allow: ['service:migration', 'service:operator'], deny401: NO_INVOCATION };
}

/** tenant-a's current registry state, which the seeded registry already holds. */
function siteChangedEnvelope(): EventEnvelope {
  const site = registryPayloads().find((payload) => payload.siteId === SITE_A);
  if (site === undefined) throw new Error('no tenant-a registry fixture');
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: site.siteId, payload: site });
}

/** A new private-pool group of tenant-a at version 1. */
function groupChangedEnvelope(): EventEnvelope {
  const groupId = cfUuid();
  const payload: GroupChangedPayload = {
    groupId,
    siteId: SITE_A,
    groupName: 'Probe Group',
    type: 1,
    isPublic: 0,
    poolTenantId: TENANT_A.tenantId,
    deleted: false,
  };
  return testEnvelope({ topic: GROUP_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: groupId, aggregateType: 'group', payload });
}

/** The push of `envelope` to `subscription` without the push key. */
function pushRequest(subscription: string, envelope: EventEnvelope): ProbeRequest {
  return {
    method: 'POST',
    url: pushPath(subscription),
    json: buildPushBody({ data: encodeEnvelope(envelope), messageId: randomUUID(), subscription }),
  };
}

function pushRoute(subscription: string, envelope: () => EventEnvelope): Expectation {
  return {
    declared: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
    send: async (subject) =>
      subject.name === PUBSUB_INVOKER_ROLE
        ? pushTo(t.app, subscription, envelope())
        : inject(pushRequest(subscription, envelope()), await credentialsOf(subject)),
    allow: [PUBSUB_INVOKER_ROLE],
    deny401: everyoneBut(PUBSUB_INVOKER_ROLE),
  };
}

/** A tenant-less sweep delivery outside the slot chain, which the chain still answers. */
const SWEEP: ProbeRequest = {
  method: 'POST',
  url: OUTBOX_SWEEP_PATH,
  json: { queue: PEOPLE_SWEEP_QUEUE, name: `${PEOPLE_SWEEP_QUEUE}-authz-probe`, tenantId: null, payload: null },
};

/** A profile save of the session user with a CSRF pair; the posted `siteid` is legacy's pool site field, never a scope. */
const PROFILE_FORM: Readonly<Record<string, string>> = Object.freeze({
  csrf_token: 'TOKEN',
  csrf_token_expires: '260630130000000',
  siteid: SITE_A,
  fname: 'Probe',
  lname: 'Saved',
  email: 'probe.saved@tenant-a.opt2.test',
  jobtitle: 'Analyst',
});

/** An empty batch of the first people mapping without a split or program fold. */
function applyRequest(): ProbeRequest {
  const mapping = PEOPLE_MAPPINGS.find((candidate) => candidate.split === undefined && candidate.fold === undefined);
  if (mapping === undefined) throw new Error('no unsplit people mapping');
  return {
    method: 'POST',
    url: '/internal/v1/migration/apply',
    json: { batchId: randomUUID(), origin: 'backfill', legacyTable: mapping.legacyTable, tenantId: TENANT_A.tenantId, columns: mapping.legacyColumns, rows: [] },
  };
}

const PROFILE_READ: ProbeRequest = { method: 'GET', url: `/v1/profile?${ON_SITE_A}` };

const ADVANCED_SEARCH_FORM: Readonly<Record<string, string>> = Object.freeze({
  param: '1',
  paramField1: 'tusers.lname^varchar',
  paramRelationship1: 'and',
  paramCriteria1: 'Target',
  paramCondition1: 'Contains',
});

/** Identity's `findCurrentUser` read of tenant-a, with the JSON API's link bases. */
const CURRENT_USER: ProbeRequest = {
  method: 'GET',
  url: `/internal/v1/users/current?${ON_SITE_A}&endpoint=${encodeURIComponent(`http://localhost:8080/index.cfm/_api/json/v1/${SITE_A}`)}&adminpath=${encodeURIComponent('http://localhost:8080/admin')}`,
};

/** Every registered route, keyed `<METHOD> <fastify url>`, with its declaration, tenant-a probe and admitted subjects. */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  'GET /healthz': {
    declared: { transport: 'service', public: true },
    send: probe({ method: 'GET', url: '/healthz' }),
    // A tasks-invoker token in Authorization is verified, and refused, as a user token.
    allow: everyoneBut(TASKS_INVOKER_ROLE),
    deny401: [TASKS_INVOKER_ROLE],
  },
  'POST /internal/v1/events/people.identity.group.changed.v1': pushRoute(GROUP_NAME_SUBSCRIPTION, groupChangedEnvelope),
  'POST /internal/v1/events/people.programs-sites.site.changed.v1': pushRoute(SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope),
  'POST /internal/v1/migration/apply': migrationRoute(applyRequest),
  'GET /internal/v1/migration/changes': migrationRoute({ method: 'GET', url: `/internal/v1/migration/changes?tenantId=${TENANT_A.tenantId}&limit=1` }),
  'GET /internal/v1/migration/export': migrationRoute({
    method: 'GET',
    url: `/internal/v1/migration/export?unit=people.person&tenantId=${TENANT_A.tenantId}&limit=1`,
  }),
  'POST /internal/v1/migration/gate': migrationRoute({ method: 'POST', url: '/internal/v1/migration/gate', json: { op: 'status' } }),
  'GET /internal/v1/migration/position': migrationRoute({ method: 'GET', url: '/internal/v1/migration/position' }),
  'GET /internal/v1/migration/watermark': migrationRoute({ method: 'GET', url: '/internal/v1/migration/watermark' }),
  'POST /internal/v1/migration/watermark': migrationRoute({
    method: 'POST',
    url: '/internal/v1/migration/watermark',
    json: { legacyTable: 'tusers', direction: 'forward', finishedAt: '2026-06-30T12:00:00.000' },
  }),
  'POST /internal/v1/outbox/sweep': {
    declared: { transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE] },
    send: probe(SWEEP),
    allow: [TASKS_INVOKER_ROLE],
    deny401: everyoneBut(TASKS_INVOKER_ROLE),
  },
  'POST /internal/v1/task-queues/:queue/ensure': queueControlRoute('ensure'),
  'POST /internal/v1/task-queues/:queue/pause': queueControlRoute('pause'),
  'POST /internal/v1/task-queues/:queue/resume': queueControlRoute('resume'),
  'GET /internal/v1/users/current': {
    declared: { transport: 'service', requires: ['service:identity'] },
    // Left out of the site-scoped probes: a user token reaches it only beside identity's credential, probed in the tenant boundary.
    send: probe(CURRENT_USER),
    allow: ['service:identity'],
    deny401: NO_INVOCATION,
  },
  'GET /v1/profile': {
    declared: PROFILE,
    request: PROFILE_READ,
    send: probe(PROFILE_READ),
    // The tenant-b token is refused tenant-a's siteid.
    allow: USERS.filter((name) => name !== 'other-tenant'),
    deny401: NO_USER,
  },
  'POST /v1/profile::update': {
    declared: { ...PROFILE, siteCheck: false },
    send: probe({ method: 'POST', url: '/v1/profile:update', form: PROFILE_FORM }),
    // Each user saves only its own person, so the posted siteid refuses no one.
    allow: USERS,
    deny401: NO_USER,
  },
  'GET /v1/users': cusersRoute({ method: 'GET', url: `/v1/users?${ON_SITE_A}&ispublic=0` }, { ...CUSERS, siteCheck: false }),
  'GET /v1/users/address': cusersRoute({
    method: 'GET',
    url: `/v1/users/address?${ON_SITE_A}&userid=${TARGET.userid}&addressid=${TARGET_ADDRESS.addressid}`,
  }),
  'GET /v1/users/advanced-search': cusersRoute({ method: 'GET', url: `/v1/users/advanced-search?${ON_SITE_A}&ispublic=0` }),
  'POST /v1/users/advanced-search': cusersRoute({ method: 'POST', url: `/v1/users/advanced-search?${ON_SITE_A}&ispublic=0`, form: ADVANCED_SEARCH_FORM }),
  'GET /v1/users/advanced-search.csv': cusersRoute({ method: 'GET', url: `/v1/users/advanced-search.csv?${ON_SITE_A}&ispublic=0` }),
  'GET /v1/users/download': cusersRoute({ method: 'GET', url: `/v1/users/download?${ON_SITE_A}&ispublic=0` }),
  'GET /v1/users/edit': cusersRoute({ method: 'GET', url: `/v1/users/edit?${ON_SITE_A}&ispublic=0&userid=${TARGET.userid}` }),
  'GET /v1/users/groups': cusersRoute({ method: 'GET', url: `/v1/users/groups?${ON_SITE_A}&ispublic=0` }),
  'GET /v1/users/route': cusersRoute({ method: 'GET', url: `/v1/users/route?${ON_SITE_A}&ispublic=0` }),
  'GET /v1/users/search': cusersRoute({ method: 'GET', url: `/v1/users/search?${ON_SITE_A}&ispublic=0&search=Target` }),
  'GET /v2/users': cusersRoute({ method: 'GET', url: `/v2/users?${ON_SITE_A}&ispublic=0` }, { ...CUSERS, siteCheck: false }),
  'GET /v2/users/advanced-search': cusersRoute({ method: 'GET', url: `/v2/users/advanced-search?${ON_SITE_A}&ispublic=0` }),
  'POST /v2/users/advanced-search': cusersRoute({ method: 'POST', url: `/v2/users/advanced-search?${ON_SITE_A}&ispublic=0`, form: ADVANCED_SEARCH_FORM }),
  'GET /v2/users/search': cusersRoute({ method: 'GET', url: `/v2/users/search?${ON_SITE_A}&ispublic=0&search=Target` }),
};

/** Whether `key` is a cUsers or profile route of the user transport, under `/v1` or `/v2`. */
function isUserRoute(key: string): boolean {
  return / \/v[12]\//.test(key);
}

/** `<METHOD> <url>` of a route. */
function keyOf(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

/** A declaration in comparable form: `requires` sorted, defaults dropped; `withSiteCheck` false leaves the site check out. */
function comparable(declared: Declared | RouteMatrixEntry, withSiteCheck = true): Record<string, unknown> {
  return {
    transport: declared.transport,
    ...(declared.requires === undefined ? {} : { requires: [...declared.requires].sort() }),
    ...(declared.public === true ? { public: true } : {}),
    ...(withSiteCheck && declared.siteCheck === false ? { siteCheck: false } : {}),
  };
}

interface ContractOperation {
  'x-opt2-transport'?: Transport;
  'x-opt2-requires'?: string[];
  'x-opt2-public'?: boolean;
  'x-opt2-fastify-path'?: string;
}

const HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

/** The contract's declaration of every operation, keyed by method and the Fastify path it is served under. */
function contractDeclarations(): Map<string, Record<string, unknown>> {
  const contract = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, ContractOperation>>;
  };
  const declarations = new Map<string, Record<string, unknown>>();
  for (const [route, operations] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.has(method)) continue;
      const url = operation['x-opt2-fastify-path'] ?? route.replace(/\{([^}]+)\}/g, ':$1');
      const declared: Declared = {
        transport: operation['x-opt2-transport'] ?? 'service',
        ...(operation['x-opt2-requires'] === undefined ? {} : { requires: operation['x-opt2-requires'] }),
        ...(operation['x-opt2-public'] === true ? { public: true as const } : {}),
      };
      declarations.set(`${method.toUpperCase()} ${url}`, comparable(declared, false));
    }
  }
  return declarations;
}

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('people routes over PostgreSQL', () => {
  let matrix: RouteMatrix;

  beforeAll(async () => {
    t = await buildPeopleRouteApp();
    const persons = [...PERSONS.values(), TARGET];
    await seedPeople(t.handle.app, seedOf(persons, [TARGET_ADDRESS]), { clock: t.clock });
    t.identity.seedAccounts(
      persons.map((person) => accountFor(person, { isPublic: person === PERSONS.get('member') ? 1 : 0, s2: person === PERSONS.get('s2') ? 1 : 0 })),
    );
    matrix = collectRouteMatrix(t.app);
  });

  afterAll(async () => {
    await t?.close();
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

    it("declares each route as the contract's x-opt2-transport, x-opt2-requires and x-opt2-public do", () => {
      const contract = contractDeclarations();
      const actual = Object.fromEntries(matrix.routes.map((route) => [keyOf(route), comparable(route, false)]));
      const declared = Object.fromEntries(matrix.routes.map((route) => [keyOf(route), contract.get(keyOf(route)) ?? 'not in the contract']));
      expect(actual).toEqual(declared);
    });

    it('probes ROLE_SET, with the minimum subjects and other-tenant minted for another tenant, plus the module-grant users', () => {
      expect(SUBJECTS.map((subject) => subject.name).sort()).toEqual([...EVERYONE].sort());
      expect(MINIMUM_SUBJECTS.filter((name) => !ROLE_SET.some((subject) => subject.name === name))).toEqual([]);
      expect(subjectSiteFor(subjectNamed('other-tenant'), SITE_A)).toBe(SITE_B);
    });

    it('names only probed subjects, and never one both admitted and answered 401', () => {
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
        for (const subject of SUBJECTS) mismatches.push(...(await mismatchesOf(key, entry, subject)));
        expect(mismatches).toEqual([]);
      });
    }
  });

  describe('transport separation', () => {
    const groupsUrl: ProbeRequest = { method: 'GET', url: `/v1/users/groups?${ON_SITE_A}&ispublic=0` };
    const positionUrl: ProbeRequest = { method: 'GET', url: '/internal/v1/migration/position' };
    const pauseUrl: ProbeRequest = { method: 'POST', url: `${QUEUE_CONTROL_PREFIX}/${PEOPLE_SWEEP_QUEUE}/pause`, json: {} };
    const sitePush = (): ProbeRequest => pushRequest(SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope());
    const groupPush = (): ProbeRequest => pushRequest(GROUP_NAME_SUBSCRIPTION, groupChangedEnvelope());
    const withKey = { key: TEST_PUSH_KEY };
    const tasksToken = async (audience = SERVICE) => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience })}` });

    it.each<[string, () => ProbeRequest, () => Promise<Record<string, string>>, Record<string, string>]>([
      ['an s2 user token on the site push', sitePush, () => asCredentials('s2'), {}],
      ['an s2 user token beside the push key on the site push', sitePush, () => asCredentials('s2'), withKey],
      ['a site-admin user token beside the push key on the group push', groupPush, () => asCredentials('site-admin'), withKey],
      ['an s2 user token on the outbox sweep', () => SWEEP, () => asCredentials('s2'), {}],
      ['a tasks-invoker token on a cUsers read', () => groupsUrl, () => tasksToken(), {}],
      ['a tasks-invoker token beside the gateway credential on a cUsers read', () => groupsUrl, async () => ({ ...(await tasksToken()), ...(await gatewayInvocation()) }), {}],
      ['a tasks-invoker token beside the gateway credential on the profile read', () => PROFILE_READ, async () => ({ ...(await tasksToken()), ...(await gatewayInvocation()) }), {}],
      ['a tasks-invoker token on a migration read', () => positionUrl, () => tasksToken(), {}],
      ['a tasks-invoker token on queue control', () => pauseUrl, () => tasksToken(), {}],
      ['a tasks-invoker token beside the push key on the site push', sitePush, () => tasksToken(), withKey],
      ['a tasks-invoker token addressed to another service on the outbox sweep', () => SWEEP, () => tasksToken('identity'), {}],
      ['the push key on a cUsers read', () => groupsUrl, async () => ({}), withKey],
      ['the push key beside the gateway credential on a cUsers read', () => groupsUrl, () => gatewayInvocation(), withKey],
      ['the push key on the outbox sweep', () => SWEEP, async () => ({}), withKey],
      ['a wrong push key on the site push', sitePush, async () => ({}), { key: `${TEST_PUSH_KEY}-wrong` }],
      ['a wrong push key on the group push', groupPush, async () => ({}), { key: `${TEST_PUSH_KEY}-wrong` }],
      ['a site-admin user token without an invocation credential on a cUsers read', () => groupsUrl, () => siteAdminToken(), {}],
      ['a site-admin user token without an invocation credential on the profile read', () => PROFILE_READ, () => siteAdminToken(), {}],
      ['a site-admin user token beside a gateway credential addressed to identity', () => groupsUrl, async () => ({ ...(await siteAdminToken()), ...(await gatewayInvocation('identity')) }), {}],
      ['a site-admin user token of another issuer', () => groupsUrl, async () => ({ ...(await siteAdminToken({ iss: 'opt2-other-issuer' })), ...(await gatewayInvocation()) }), {}],
      ['a site-admin user token for another audience', () => groupsUrl, async () => ({ ...(await siteAdminToken({ aud: 'opt2-other' })), ...(await gatewayInvocation()) }), {}],
      [
        'an expired site-admin user token',
        () => groupsUrl,
        async () => ({ ...(await siteAdminToken({ exp: Math.floor(Date.now() / 1000) - 60 })), ...(await gatewayInvocation()) }),
        {},
      ],
      ['Basic credentials beside the gateway credential on a cUsers read', () => groupsUrl, async () => ({ authorization: 'Basic YWRtaW46YWRtaW4=', ...(await gatewayInvocation()) }), {}],
      [
        'the migration workload addressed to another service on a migration read',
        () => positionUrl,
        async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'migration', audience: 'identity', roles: [Roles.platformMigration] })}` }),
        {},
      ],
    ])('refuses %s with 401 before any effect', async (_label, request, credentials, query) => {
      const presented = await credentials();
      const outcome = await outcomeOf(() => inject(request(), presented, query));
      expect(isCleanRefusal(outcome, 401), JSON.stringify(outcome)).toBe(true);
    });
  });

  describe('tenant boundary', () => {
    const siteScoped = Object.entries(EXPECTED).flatMap(([key, entry]) =>
      entry.request?.url.includes(ON_SITE_A) === true ? [[key, entry.request] as const] : [],
    );

    it('probes every user route with a tenant-a siteid except the profile save, which never scopes by it', () => {
      const userRoutes = Object.keys(EXPECTED).filter(isUserRoute);
      expect(userRoutes.filter((key) => !siteScoped.some(([scoped]) => scoped === key))).toEqual(['POST /v1/profile::update']);
    });

    it.each(siteScoped)('refuses tenant-a s2 and site-admin tokens sent with siteid=tenant-b on %s', async (_key, request) => {
      const toSiteB: ProbeRequest = { ...request, url: request.url.replace(ON_SITE_A, `siteid=${SITE_B}`) };
      for (const name of ['s2', 'site-admin']) {
        const credentials = await asCredentials(name);
        const outcome = await outcomeOf(() => inject(toSiteB, credentials));
        expect(isCleanRefusal(outcome, 403), `${name}: ${JSON.stringify(outcome)}`).toBe(true);
      }
    });

    it.each<[string, ProbeRequest]>([
      ['in the form body', { method: 'POST', url: '/v1/users/advanced-search?ispublic=0', form: { ...ADVANCED_SEARCH_FORM, siteid: SITE_B } }],
      ['spelled SiteID', { method: 'GET', url: `/v1/users/groups?SiteID=${SITE_B}&ispublic=0` }],
      ['spelled SiteID on the handler-checked users list', { method: 'GET', url: `/v1/users?SiteID=${SITE_B}&ispublic=0` }],
      ['spelled SiteID on the handler-checked v2 users list', { method: 'GET', url: `/v2/users?SiteID=${SITE_B}&ispublic=0` }],
    ])('refuses a tenant-b siteid %s to a tenant-a site-admin', async (_label, request) => {
      const outcome = await outcomeOf(async () => inject(request, await asCredentials('site-admin')));
      expect(isCleanRefusal(outcome, 403), JSON.stringify(outcome)).toBe(true);
    });

    it.each<[string, string, string, number]>([
      ['lists every site for S2 with siteid=all', 's2', `/v1/users?siteid=all&ispublic=0`, 200],
      ['refuses siteid=all on the users list to a site-admin', 'site-admin', `/v1/users?siteid=all&ispublic=0`, 403],
      ['lists a page of every site for S2 with siteid=all on v2', 's2', `/v2/users?siteid=all&ispublic=0`, 200],
      ['refuses siteid=all on the v2 users list to a site-admin', 'site-admin', `/v2/users?siteid=all&ispublic=0`, 403],
      ['refuses siteid=all on the group list to S2', 's2', `/v1/users/groups?siteid=all&ispublic=0`, 403],
      ['refuses siteid=all on the users download to S2', 's2', `/v1/users/download?siteid=all&ispublic=0`, 403],
    ])('%s', async (_label, name, url, status) => {
      const outcome = await outcomeOf(async () => inject({ method: 'GET', url }, await asCredentials(name)));
      if (status === 200) expect(outcome.status, JSON.stringify(outcome)).toBe(200);
      else expect(isCleanRefusal(outcome, 403), JSON.stringify(outcome)).toBe(true);
    });

    it.each<[string, string, (res: InjectResponse) => boolean]>([
      ['the users list', '/v1/users?ispublic=0', (res) => (res.json() as { items: { UserID: string }[] }).items.some((row) => row.UserID === TARGET.userid)],
      ['the search', '/v1/users/search?ispublic=0&search=Target', (res) => (res.json() as { items: { UserID: string }[] }).items.some((row) => row.UserID === TARGET.userid)],
      ['the v2 users page', '/v2/users?ispublic=0', (res) => (res.json() as { items: { UserID: string }[] }).items.some((row) => row.UserID === TARGET.userid)],
      ['the v2 search page', '/v2/users/search?ispublic=0&search=Target', (res) => (res.json() as { items: { UserID: string }[] }).items.some((row) => row.UserID === TARGET.userid)],
      ['the advanced-search download', '/v1/users/advanced-search.csv?ispublic=0', (res) => res.body.includes(TARGET.email ?? '')],
      ['the users download', '/v1/users/download?ispublic=0', (res) => res.body.includes(TARGET.email ?? '')],
      [
        'the Edit User read',
        `/v1/users/edit?ispublic=0&userid=${TARGET.userid}`,
        (res) => (res.json() as { isNew: boolean; user: { UserID: string } }).user.UserID === TARGET.userid,
      ],
      [
        'the Edit Address read',
        `/v1/users/address?userid=${TARGET.userid}&addressid=${TARGET_ADDRESS.addressid}`,
        (res) => !(res.json() as { isNew: boolean }).isNew,
      ],
    ])("shows the tenant-a person in %s to tenant-a's site-admin and never to tenant-b's", async (_label, url, showsTarget) => {
      const own = await inject({ method: 'GET', url }, await asCredentials('site-admin'));
      const other = await inject({ method: 'GET', url }, await asCredentials('other-tenant'));
      expect({ own: own.statusCode, other: other.statusCode }).toEqual({ own: 200, other: 200 });
      expect({ own: showsTarget(own), other: showsTarget(other) }).toEqual({ own: true, other: false });
    });

    /** `name`'s user token beside identity's invocation credential, as identity forwards it to the current-user read. */
    async function identityForwarding(name: string): Promise<Record<string, string>> {
      const { authorization = '' } = await asCredentials(name);
      return { ...(await asCredentials('service:identity')), authorization };
    }

    it("reads the forwarded token's own person on identity's tenant-a current-user read for tenant-a's site-admin", async () => {
      const res = await inject(CURRENT_USER, await identityForwarding('site-admin'));
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as { data: { userid: string; isnew: number } }).data).toMatchObject({ userid: PERSONS.get('site-admin')?.userid, isnew: 0 });
    });

    it("refuses identity's tenant-a current-user read forwarding tenant-b's site-admin token with 403 before any effect", async () => {
      const credentials = await identityForwarding('other-tenant');
      const outcome = await outcomeOf(() => inject(CURRENT_USER, credentials));
      expect(isCleanRefusal(outcome, 403), JSON.stringify(outcome)).toBe(true);
    });

    it("saves a tenant-b user's own profile, never the tenant-a person its post names", async () => {
      const person = PERSONS.get('other-tenant');
      if (person === undefined) throw new Error('no other-tenant person');
      const form = { ...PROFILE_FORM, userid: TARGET.userid, siteid: SITE_A, fname: 'Crossed' };
      const res = await inject({ method: 'POST', url: '/v1/profile:update', form }, await asCredentials('other-tenant'));
      expect(res.statusCode, res.body).toBe(200);
      const firstName = (tenantId: string, userId: string) =>
        withTenant(t.handle.app, tenantId, async (tx) => (await t.repository.findPerson(tx, userId))?.fname ?? null);
      expect({ own: await firstName(person.tenant_id, person.userid), target: await firstName(TARGET.tenant_id, TARGET.userid) }).toEqual({
        own: 'Crossed',
        target: TARGET.fname,
      });
    });
  });
});

describe('deny by default at start-up', () => {
  let stateDir: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-people-authz-startup-'));
    await writeTestSecrets(stateDir);
  });

  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /** A database no start-up path may open. */
  const closedDb: TenantDb = {
    schema: SERVICE,
    withTenant: () => Promise.reject(new Error('start-up opened a tenant transaction')),
    withMetadata: () => Promise.reject(new Error('start-up opened a metadata transaction')),
    end: () => Promise.resolve(),
  };

  /** People's cUsers, download and profile routes on a bare service, which needs no database to start. */
  async function peopleApp(): Promise<FastifyInstance> {
    const app = await createService({ name: SERVICE, version: '1.0.0', env: peopleEnv(stateDir), verifierOverride: testVerifier(SERVICE), logger: silentLogger() });
    const repository = createPeopleRepository();
    const identity = createIdentityDouble(closedDb);
    const clock = app.opt2.clock;
    await registerAdminUserRoutes(app, { db: closedDb, repository, identity, clock });
    await registerAdminDownloadRoutes(app, { search: { db: closedDb, repo: repository, identity }, searchCriteria: { read: () => Promise.resolve(undefined) } });
    const roster = { db: closedDb, repo: repository, events: createPeopleEvents(repository), identity, clock, faults: createFaultHooks({}, {}) };
    await registerAdminProfileRoutes(app, { roster });
    return app;
  }

  it("starts with people's own routes, each declared", async () => {
    const app = await peopleApp();
    try {
      await app.ready();
      expect(collectRouteMatrix(app).routes.map(keyOf).sort()).toEqual(
        Object.keys(EXPECTED)
          .filter((key) => key === 'GET /healthz' || key === 'GET /internal/v1/users/current' || isUserRoute(key))
          .sort(),
      );
    } finally {
      await app.close();
    }
  });

  it.each<[string, string, Opt2RouteConfig | undefined]>([
    ['declares no config.opt2', '/v1/users/__undeclared', undefined],
    ['declares neither requires nor public', '/v1/users/__unlisted', { transport: 'service' }],
    ['declares both requires and public', '/v1/users/__both', { requires: [Roles.s2], public: true }],
    ['declares an empty requires', '/v1/users/__empty', { requires: [] }],
    ['is a public push route', '/internal/v1/events/people.programs-sites.site.removed.v1', { transport: 'pubsub-push', public: true }],
    ['declares the service transport on a task path', '/internal/v1/tasks/people-probe', { transport: 'service', requires: [TASKS_INVOKER_ROLE] }],
    ['declares the cloud-tasks transport on a user path', '/v1/users/__task', { transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE] }],
  ])('fails start-up when a route beside them %s', async (_label, url, opt2) => {
    const app = await peopleApp();
    try {
      const startUp = (async () => {
        app.get(url, opt2 === undefined ? {} : { config: { opt2 } }, async () => ({}));
        await app.ready();
      })();
      await expect(startUp).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
