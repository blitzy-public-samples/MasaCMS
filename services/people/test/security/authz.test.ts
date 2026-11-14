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
  isServiceRole,
  moduleRole,
  renderAuthDenial,
  rolesForService,
  serviceRole,
  type DenialResponse,
  type Opt2RouteConfig,
  type RouteMatrixEntry,
} from '@opt2/platform/auth';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import { createService } from '@opt2/platform/service-kit';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TEST_PUSH_KEY,
  authHeadersFor,
  fixtureForSite,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushKeyQuery,
  pushTo,
  registryPayloads,
  subjectQueryFor,
  subjectSiteFor,
  testEnvelope,
  testVerifier,
  type InjectResponse,
  type PushTarget,
  type RoleSubject,
  type TenantlessEnvelope,
} from '@opt2/platform/testing';
import { SERVICE_NAME } from '../../src/app.js';
import { GROUP_NAME_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { AdminDenial, CUSERS_ROUTE_REQUIRES, PROFILE_ROUTE_REQUIRES, requireCusersAccess, requireLoggedIn } from '../../src/routes/access.js';
import { buildTestApp, testEnv, type TestApp } from '../helpers/app.js';
import type { IdentityDouble } from '../helpers/identity-double.js';
import {
  ADMIN_S2,
  DEFAULT_SITE,
  EDITOR,
  EDITOR_USER,
  MEMBER_POOLED,
  MODULE_008_ONLY,
  MODULE_008_ONLY_PERSON,
  MODULE_USER_A,
  MODULE_USER_A_PERSON,
  POOLED_MEMBER_PERSON,
  S2_USER,
  SITE_ADMIN_A,
  SITE_ADMIN_A_PERSON,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  accountFor,
  personRow,
  type TestActor,
} from '../helpers/fixtures.js';

type Headers = Record<string, string>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const ON_SITE_A = `siteid=${SITE_A}`;
const SWEEP_QUEUE = 'people-outbox-sweep';
const FORM: Headers = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded' });
const CSRF_FIELDS = 'csrf_token=TOKEN&csrf_token_expires=260630130000000';
const ADVANCED_SEARCH_FORM =
  'param=1&paramField1=tusers.lname%5Evarchar&paramRelationship1=and&paramCriteria1=Target&paramCondition1=Contains';
/** A user id no seeded person holds. */
const STRANGER_ID = cfUuid();

const CUSERS = [Roles.s2, Roles.siteAdmin, moduleRole('00000000000000000000000000000000008')];
const PROFILE = [Roles.systemUser, Roles.member, Roles.s2, Roles.siteAdmin];
const MIGRATION = [Roles.platformMigration];
const QUEUE_CONTROL = [Roles.platformMigration, Roles.platformOperator];

/** Every route people registers, as collectRouteMatrix reports it. */
const EXPECTED_ROUTES: readonly RouteMatrixEntry[] = [
  { method: 'DELETE', url: '/_api/ajax/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/_api/ajax/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'POST', url: '/_api/ajax/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'PUT', url: '/_api/ajax/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'DELETE', url: '/_api/ajax/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/_api/ajax/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'POST', url: '/_api/ajax/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'PUT', url: '/_api/ajax/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'DELETE', url: '/_api/json/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/_api/json/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'POST', url: '/_api/json/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'PUT', url: '/_api/json/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'DELETE', url: '/_api/json/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/_api/json/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'POST', url: '/_api/json/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'PUT', url: '/_api/json/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'DELETE', url: '/_api/rest/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/_api/rest/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'POST', url: '/_api/rest/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'PUT', url: '/_api/rest/v1', transport: 'service', public: true, siteCheck: false },
  { method: 'DELETE', url: '/_api/rest/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/_api/rest/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'POST', url: '/_api/rest/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'PUT', url: '/_api/rest/v1/*', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/healthz', transport: 'service', public: true, siteCheck: true },
  { method: 'POST', url: '/internal/v1/events/people.identity.group.changed.v1', transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE], siteCheck: true },
  { method: 'POST', url: '/internal/v1/events/people.programs-sites.site.changed.v1', transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE], siteCheck: true },
  { method: 'POST', url: '/internal/v1/migration/apply', transport: 'service', requires: MIGRATION, siteCheck: true },
  { method: 'GET', url: '/internal/v1/migration/changes', transport: 'service', requires: MIGRATION, siteCheck: true },
  { method: 'GET', url: '/internal/v1/migration/export', transport: 'service', requires: MIGRATION, siteCheck: true },
  { method: 'POST', url: '/internal/v1/migration/gate', transport: 'service', requires: MIGRATION, siteCheck: true },
  { method: 'GET', url: '/internal/v1/migration/position', transport: 'service', requires: MIGRATION, siteCheck: true },
  { method: 'GET', url: '/internal/v1/migration/watermark', transport: 'service', requires: MIGRATION, siteCheck: true },
  { method: 'POST', url: '/internal/v1/migration/watermark', transport: 'service', requires: MIGRATION, siteCheck: true },
  { method: 'POST', url: '/internal/v1/outbox/sweep', transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE], siteCheck: true },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/ensure', transport: 'service', requires: QUEUE_CONTROL, siteCheck: true },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/pause', transport: 'service', requires: QUEUE_CONTROL, siteCheck: true },
  { method: 'POST', url: '/internal/v1/task-queues/:queue/resume', transport: 'service', requires: QUEUE_CONTROL, siteCheck: true },
  { method: 'GET', url: '/internal/v1/users/current', transport: 'service', requires: [serviceRole('identity')], siteCheck: true },
  { method: 'GET', url: '/internal/v1/users/pool-user', transport: 'service', requires: [serviceRole('e-signature')], siteCheck: true },
  { method: 'GET', url: '/legacy-fixtures/cfml/api.cfm/people/persons/:userId/archive', transport: 'service', public: true, siteCheck: false },
  { method: 'POST', url: '/legacy-fixtures/cfml/api.cfm/people/persons/:userId/archive', transport: 'service', public: true, siteCheck: false },
  { method: 'GET', url: '/v1/profile', transport: 'service', requires: PROFILE, siteCheck: true },
  { method: 'POST', url: '/v1/profile::update', transport: 'service', requires: PROFILE, siteCheck: false },
  { method: 'GET', url: '/v1/users', transport: 'service', requires: CUSERS, siteCheck: false },
  { method: 'POST', url: '/v1/users::update', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/address', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'POST', url: '/v1/users/addresses::update', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/advanced-search', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'POST', url: '/v1/users/advanced-search', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/advanced-search.csv', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/download', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/edit', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/groups', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/route', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v1/users/search', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v2/users', transport: 'service', requires: CUSERS, siteCheck: false },
  { method: 'GET', url: '/v2/users/advanced-search', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'POST', url: '/v2/users/advanced-search', transport: 'service', requires: CUSERS, siteCheck: true },
  { method: 'GET', url: '/v2/users/search', transport: 'service', requires: CUSERS, siteCheck: true },
];

/**
 * `siteCheck: false` routes that still hold a supplied `siteid` to the token's site, in the handler before any effect: the
 * users lists, whose `siteid=all` only S2 may send.
 */
const HANDLER_SITE_BOUND: ReadonlySet<string> = new Set(['GET /v1/users', 'GET /v2/users']);

/** Routes whose handler refuses an admitted workload without a user token with 401 before any effect: e-signature's pool-user read. */
const HANDLER_USER_BOUND: ReadonlySet<string> = new Set(['GET /internal/v1/users/pool-user']);

function tenantOfSite(siteId: string): string {
  if (siteId === DEFAULT_SITE.siteId) return DEFAULT_SITE.tenantId;
  const fixture = fixtureForSite(siteId);
  if (fixture === undefined) throw new TypeError(`No tenant fixture for site ${siteId}`);
  return fixture.tenantId;
}

const DEFAULT_SITE_PAYLOAD = {
  siteId: DEFAULT_SITE.siteId,
  publicUserPoolId: DEFAULT_SITE.siteId,
  privateUserPoolId: DEFAULT_SITE.siteId,
  categoryPoolId: DEFAULT_SITE.siteId,
  filePoolId: DEFAULT_SITE.siteId,
  displayPoolId: DEFAULT_SITE.siteId,
  contentPoolIds: [DEFAULT_SITE.siteId],
  domains: ['localhost'],
};

/** `people.tenant_registry` rows of the fixture sites and the installed `default` site, as the site consumer stores them. */
const REGISTRY_ROWS = [...registryPayloads(), DEFAULT_SITE_PAYLOAD].map((site) => {
  const pool = (id: string | null | undefined): string | null => (id === undefined || id === null ? null : tenantOfSite(id));
  const contentPoolIds = typeof site.contentPoolIds === 'string' ? [site.contentPoolIds] : (site.contentPoolIds ?? []);
  return {
    site_id: site.siteId,
    tenant_id: tenantOfSite(site.siteId),
    public_user_pool_id: site.publicUserPoolId,
    private_user_pool_id: site.privateUserPoolId,
    category_pool_id: site.categoryPoolId,
    file_pool_id: site.filePoolId,
    display_pool_id: site.displayPoolId,
    content_pool_ids: contentPoolIds,
    public_user_pool_tenant: pool(site.publicUserPoolId),
    private_user_pool_tenant: pool(site.privateUserPoolId),
    category_pool_tenant: pool(site.categoryPoolId),
    file_pool_tenant: pool(site.filePoolId),
    display_pool_tenant: pool(site.displayPoolId),
    content_pool_tenants: contentPoolIds.map((id) => tenantOfSite(id)),
    domains: site.domains,
    aggregate_version: '1',
    updated_at: new Date('2026-06-30T12:00:00'),
  };
});

/** Answers the registry reads people makes: by site, by user-pool tenant, by tenant, and the pool-tenant projections. */
function registryAnswer(text: string, values: readonly unknown[]): Record<string, unknown>[] {
  const [first] = values;
  let rows = REGISTRY_ROWS;
  if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(text)) {
    rows = rows.filter((row) => row.site_id.toLowerCase() === String(first).toLowerCase());
  } else if (/WHERE public_user_pool_tenant = \$1 OR private_user_pool_tenant = \$1/.test(text)) {
    rows = rows.filter((row) => row.public_user_pool_tenant === first || row.private_user_pool_tenant === first);
  } else if (/WHERE tenant_id = \$1/.test(text)) {
    rows = rows.filter((row) => row.tenant_id === first);
  }
  const pooled = /SELECT (\w+) AS pool_tenant/.exec(text)?.[1];
  return rows.map((row) => (pooled === undefined ? { ...row } : { ...row, pool_tenant: (row as Record<string, unknown>)[pooled] }));
}

const ROSTER_OPERATION_COLUMNS = [
  'tenant_id',
  'operation_id',
  'kind',
  'user_id',
  'payload',
  'before_image',
  'identity_xid',
  'state',
  'error',
  'started_at',
  'updated_at',
  'identity_unreachable_since',
  'claimed_by',
] as const;

/** Each user subject's own Masa `UserID`, so identity's contract accepts the account reads its requests cause. */
const SUBJECT_SUBS: ReadonlyMap<string, string> = new Map(ROLE_SET.filter((subject) => subject.kind === 'user').map((subject) => [subject.name, cfUuid()]));

/** A person and account per user subject (the member pooled in umbrella), plus the fixture actors. */
const PERSONS = [
  ...[...SUBJECT_SUBS].map(([name, userid]) =>
    personRow({ userid, siteid: name === Roles.member ? 'umbrella' : subjectSiteFor(subjectNamed(name), SITE_A) }),
  ),
  S2_USER,
  EDITOR_USER,
  SITE_ADMIN_A_PERSON,
  MODULE_USER_A_PERSON,
  MODULE_008_ONLY_PERSON,
  SYSTEM_USER_A_PERSON,
  POOLED_MEMBER_PERSON,
];

/** Answers person reads with the seeded person whose id and tenant the statement binds. */
function personAnswer(_text: string, values: readonly unknown[]): Record<string, unknown>[] {
  const bound = JSON.stringify(values).toUpperCase();
  return PERSONS.filter((person) => bound.includes(person.userid.toUpperCase()) && values.includes(person.tenant_id)).map((person) => ({ ...person }));
}

let t: TestApp;
let identity: IdentityDouble;

beforeAll(async () => {
  t = await buildTestApp({ env: testEnv({ LOG_LEVEL: 'error' }) });
  identity = t.identity;
  t.db.respond(/FROM "?people"?\."?tenant_registry"?\b/, registryAnswer);
  t.db.respond(/FROM "?people"?\."?person"? /, personAnswer);
  // The recording database answers other inserts with no row; a roster operation needs its stored row back to proceed.
  t.db.respond(/^INSERT INTO "people"\."roster_operation"/, (_text, values) => [
    Object.fromEntries(ROSTER_OPERATION_COLUMNS.map((column, index) => [column, values[index]])),
  ]);
  identity.seedAccounts(...PERSONS.map((person) => accountFor(person, person.siteid === 'umbrella' ? { isPublic: 1 } : {})));
});

afterAll(async () => {
  await t.close();
});

/** Credentials a request presents: headers, and the push key the emulator carries in the query. */
interface Credential {
  headers: Headers;
  query: string;
}

const NO_CREDENTIAL: Credential = Object.freeze({ headers: {}, query: '' });

const credentialCache = new Map<string, { mintedAt: number; credential: Promise<Credential> }>();

// User tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

function credentialOf(subject: RoleSubject): Promise<Credential> {
  const hit = credentialCache.get(subject.name);
  if (hit !== undefined && Date.now() - hit.mintedAt < CREDENTIAL_REUSE_MS) return hit.credential;
  const sub = SUBJECT_SUBS.get(subject.name);
  const credential = authHeadersFor(subject, { site: SITE_A, audience: SERVICE_NAME, ...(sub === undefined ? {} : { sub }) }).then((headers) => ({
    headers,
    query: new URLSearchParams(subjectQueryFor(subject)).toString(),
  }));
  credentialCache.set(subject.name, { mintedAt: Date.now(), credential });
  return credential;
}

function subjectNamed(name: string): RoleSubject {
  const found = ROLE_SET.find((subject) => subject.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return found;
}

/** A people actor's user token beside the gateway's invocation credential; `tid` replaces the tenant its site gives. */
async function actorCredential(actor: TestActor, overrides: { tid?: string } = {}): Promise<Credential> {
  const [userToken, gatewayToken] = await Promise.all([
    mintUserToken({ sub: actor.sub, site: actor.site, roles: actor.roles, s2: actor.s2, ...(overrides.tid === undefined ? {} : { tid: overrides.tid }) }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE_NAME }),
  ]);
  return { headers: { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${gatewayToken}` }, query: '' };
}

interface Probe {
  method: HttpMethod;
  url: string;
  payload?: string | Record<string, unknown>;
  headers?: Headers;
  /** The request names tenant-a in `siteid`, so a token of another site is held to the site check. */
  site?: true;
}

/** A request's response and every effect it had: statements, writes, identity calls, publishes and created tasks. */
interface ProbeResult {
  res: InjectResponse;
  statements: number;
  writes: number;
  identityCalls: string[];
  published: number;
  tasks: number;
}

function withQuery(url: string, query: string): string {
  return query === '' ? url : `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

function publishedCount(): number {
  return t.publisher.published.length + t.publisher.raw.length;
}

/** Sends `request` with `credential` and records its effects; the recording database is emptied first. */
async function probe(request: Probe, credential: Credential = NO_CREDENTIAL): Promise<ProbeResult> {
  t.db.clear();
  const identityBefore = identity.requests.length;
  const publishedBefore = publishedCount();
  const tasksBefore = t.taskPort.tasks.length;
  const { method, url, payload, headers } = request;
  const res = await t.app.inject({
    method,
    url: withQuery(url, credential.query),
    headers: { ...headers, ...credential.headers },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    res,
    statements: t.db.statements().length,
    writes: t.db.writes().length,
    identityCalls: identity.requests.slice(identityBefore).map((call) => `${call.method} ${call.path}`),
    published: publishedCount() - publishedBefore,
    tasks: t.taskPort.tasks.length - tasksBefore,
  };
}

interface ErrorEnvelope {
  apiversion?: unknown;
  method?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function errorEnvelope(res: InjectResponse): ErrorEnvelope | undefined {
  try {
    const body: unknown = JSON.parse(res.body);
    return typeof body === 'object' && body !== null ? (body as ErrorEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

const AUTH_DENIAL_ROWS = [LEGACY_ERROR_MAP.authorization, LEGACY_ERROR_MAP.invalidAccessToken, LEGACY_ERROR_MAP.accessTokenExpired];
/** The `error` member of a JSON API authorization refusal. */
const AUTHORIZATION_ERROR = Object.freeze({ message: LEGACY_ERROR_MAP.authorization.message, code: LEGACY_ERROR_MAP.authorization.code });

/** Whether the request had no effect at all: no statement, identity call, publish or task. */
function effectFree(result: ProbeResult): boolean {
  return result.statements === 0 && result.writes === 0 && result.identityCalls.length === 0 && result.published === 0 && result.tasks === 0;
}

/** Whether nothing was written, sent to identity, published or queued; a registry read may have happened. */
function writeFree(result: ProbeResult): boolean {
  return result.writes === 0 && result.identityCalls.length === 0 && result.published === 0 && result.tasks === 0;
}

/** A 401 or 403 in the legacy envelope with an auth denial's code and message, answered before any effect. */
function isHookDenial(result: ProbeResult): boolean {
  const { statusCode } = result.res;
  if (statusCode !== 401 && statusCode !== 403) return false;
  const body = errorEnvelope(result.res);
  const matchesRow = AUTH_DENIAL_ROWS.some((row) => body?.error?.code === row.code && body.error.message === row.message);
  return body?.apiversion === 'v1' && matchesRow && effectFree(result);
}

type DenialRequest = Parameters<typeof renderAuthDenial>[1];

/** The response the platform renders `denial` with for `url`; renderAuthDenial reads only the request's query. */
function denialResponse(denial: AuthDenial, url: string): DenialResponse {
  const query = Object.fromEntries(new URL(url, 'http://people.test').searchParams);
  return renderAuthDenial(denial, { query } as unknown as DenialRequest);
}

/** Whether `result` is exactly the platform's rendering of `denial`, with no effect. */
function isDenialOf(result: ProbeResult, denial: AuthDenial, url: string): boolean {
  const expected = denialResponse(denial, url);
  return result.res.statusCode === expected.status && result.res.body === expected.body && effectFree(result);
}

/** A compact description of a result for assertion messages. */
function describeResult(result: ProbeResult): string {
  const { res, statements, writes, identityCalls, published, tasks } = result;
  return JSON.stringify({ status: res.statusCode, statements, writes, identityCalls, published, tasks, body: res.body.slice(0, 300) });
}

function routeKey(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

/** tenant-a's registry state, which the registry already holds. */
function siteChangedEnvelope(): TenantlessEnvelope {
  const site = registryPayloads().find((payload) => payload.siteId === SITE_A);
  if (site === undefined) throw new Error('no tenant-a registry fixture');
  return testEnvelope({ topic: 'programs-sites.site.changed.v1', tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload: site });
}

/** A new private-pool group of tenant-a at version 1. */
function groupChangedEnvelope(): TenantlessEnvelope {
  const groupId = cfUuid();
  const payload = { groupId, siteId: SITE_A, groupName: 'Probe Group', type: 1, isPublic: 0, poolTenantId: TENANT_A.tenantId, deleted: false };
  return testEnvelope({ topic: 'identity.group.changed.v1', tenantId: TENANT_A.tenantId, aggregateId: groupId, aggregateType: 'group', payload });
}

/** The push delivery pushTo sends for `envelope`, without its push key, so each subject presents its own credential. */
async function pushProbe(subscription: string, envelope: TenantlessEnvelope): Promise<Probe> {
  let captured: Probe | undefined;
  const recorder: PushTarget = {
    inject: ((options: { url: string; payload: Record<string, unknown> }) => {
      captured = { method: 'POST', url: options.url.split('?')[0] ?? options.url, payload: options.payload };
      return Promise.resolve(undefined);
    }) as unknown as PushTarget['inject'],
  };
  await pushTo(recorder, subscription, envelope);
  if (captured === undefined) throw new Error(`pushTo sent no delivery to ${subscription}`);
  return captured;
}

const SWEEP_PROBE: Probe = Object.freeze({
  method: 'POST',
  url: '/internal/v1/outbox/sweep',
  payload: { queue: SWEEP_QUEUE, name: `${SWEEP_QUEUE}-authz-probe`, tenantId: null, payload: null },
});

const CURRENT_USER_URL =
  `/internal/v1/users/current?${ON_SITE_A}` +
  `&endpoint=${encodeURIComponent(`http://localhost:8080/index.cfm/_api/json/v1/${SITE_A}`)}` +
  `&adminpath=${encodeURIComponent('http://localhost:8080/admin')}`;

const PROFILE_READ: Probe = Object.freeze({ method: 'GET', url: `/v1/profile?${ON_SITE_A}`, site: true });

const get = (url: string, site = true): Probe => ({ method: 'GET', url, ...(site ? { site: true } : {}) });
const postForm = (url: string, payload: string, site = true): Probe => ({ method: 'POST', url, payload, headers: FORM, ...(site ? { site: true } : {}) });
const control = (op: string): Probe => ({ method: 'POST', url: `/internal/v1/task-queues/${SWEEP_QUEUE}/${op}`, payload: {} });

/** Requests an unknown API method or entity, which the JSON API answers 400 or 404 itself, never by an authorization check. */
function jsonApiProbes(): Record<string, () => Probe> {
  const probes: Record<string, () => Probe> = {};
  for (const family of ['ajax', 'json', 'rest']) {
    for (const method of ['DELETE', 'GET', 'POST', 'PUT'] as const) {
      probes[`${method} /_api/${family}/v1`] = () => ({ method, url: `/_api/${family}/v1?${ON_SITE_A}` });
      probes[`${method} /_api/${family}/v1/*`] = () => ({ method, url: `/_api/${family}/v1/${SITE_A}/notanentity` });
    }
  }
  return probes;
}

/** One deterministic request per registered route; a fixture route names an unregistered site, which api.cfm refuses first. */
const PROBES: Readonly<Record<string, () => Probe | Promise<Probe>>> = {
  ...jsonApiProbes(),
  'GET /healthz': () => get('/healthz', false),
  'POST /internal/v1/events/people.identity.group.changed.v1': () => pushProbe(GROUP_NAME_SUBSCRIPTION, groupChangedEnvelope()),
  'POST /internal/v1/events/people.programs-sites.site.changed.v1': () => pushProbe(SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope()),
  // The migration probes send input the handlers' schemas refuse, answered 400 before any statement; the watermark read lists none.
  'POST /internal/v1/migration/apply': () => ({ method: 'POST', url: '/internal/v1/migration/apply', payload: {} }),
  'GET /internal/v1/migration/changes': () => get('/internal/v1/migration/changes?probe=1', false),
  'GET /internal/v1/migration/export': () => get('/internal/v1/migration/export?probe=1', false),
  'POST /internal/v1/migration/gate': () => ({ method: 'POST', url: '/internal/v1/migration/gate', payload: {} }),
  'GET /internal/v1/migration/position': () => get('/internal/v1/migration/position?probe=1', false),
  'GET /internal/v1/migration/watermark': () => get('/internal/v1/migration/watermark', false),
  'POST /internal/v1/migration/watermark': () => ({ method: 'POST', url: '/internal/v1/migration/watermark', payload: {} }),
  'POST /internal/v1/outbox/sweep': () => SWEEP_PROBE,
  'POST /internal/v1/task-queues/:queue/ensure': () => control('ensure'),
  'POST /internal/v1/task-queues/:queue/pause': () => control('pause'),
  'POST /internal/v1/task-queues/:queue/resume': () => control('resume'),
  'GET /internal/v1/users/current': () => get(CURRENT_USER_URL),
  'GET /internal/v1/users/pool-user': () => get(`/internal/v1/users/pool-user?${ON_SITE_A}&userid=${STRANGER_ID}`),
  'GET /legacy-fixtures/cfml/api.cfm/people/persons/:userId/archive': () =>
    get(`/legacy-fixtures/cfml/api.cfm/people/persons/${STRANGER_ID}/archive?siteid=notasite`, false),
  'POST /legacy-fixtures/cfml/api.cfm/people/persons/:userId/archive': () =>
    postForm(`/legacy-fixtures/cfml/api.cfm/people/persons/${STRANGER_ID}/archive?siteid=notasite`, 'effectiveFrom=2026-07-01', false),
  'GET /v1/profile': () => PROFILE_READ,
  // The withheld extended-data branch answers 503 before the CSRF check or any write.
  'POST /v1/profile::update': () => postForm('/v1/profile:update', 'extendSetID=probe', false),
  'GET /v1/users': () => get(`/v1/users?${ON_SITE_A}&ispublic=0`),
  // The withheld roster delete answers 503 before the CSRF check or any write.
  'POST /v1/users::update': () => postForm(`/v1/users:update?${ON_SITE_A}`, `userid=${STRANGER_ID}&type=2&action=Delete`),
  'GET /v1/users/address': () => get(`/v1/users/address?${ON_SITE_A}&userid=${STRANGER_ID}&addressid=${STRANGER_ID}`),
  // Without a CSRF pair the address save only skips its write.
  'POST /v1/users/addresses::update': () => postForm(`/v1/users/addresses:update?${ON_SITE_A}`, `userid=${STRANGER_ID}&address1=Probe`),
  'GET /v1/users/advanced-search': () => get(`/v1/users/advanced-search?${ON_SITE_A}&ispublic=0`),
  'POST /v1/users/advanced-search': () => postForm(`/v1/users/advanced-search?${ON_SITE_A}&ispublic=0`, ADVANCED_SEARCH_FORM),
  'GET /v1/users/advanced-search.csv': () => get(`/v1/users/advanced-search.csv?${ON_SITE_A}&ispublic=0`),
  'GET /v1/users/download': () => get(`/v1/users/download?${ON_SITE_A}&ispublic=0`),
  'GET /v1/users/edit': () => get(`/v1/users/edit?${ON_SITE_A}&ispublic=0&userid=${STRANGER_ID}`),
  'GET /v1/users/groups': () => get(`/v1/users/groups?${ON_SITE_A}&ispublic=0`),
  'GET /v1/users/route': () => get(`/v1/users/route?${ON_SITE_A}&ispublic=0`),
  'GET /v1/users/search': () => get(`/v1/users/search?${ON_SITE_A}&ispublic=0&search=Target`),
  'GET /v2/users': () => get(`/v2/users?${ON_SITE_A}&ispublic=0`),
  'GET /v2/users/advanced-search': () => get(`/v2/users/advanced-search?${ON_SITE_A}&ispublic=0`),
  'POST /v2/users/advanced-search': () => postForm(`/v2/users/advanced-search?${ON_SITE_A}&ispublic=0`, ADVANCED_SEARCH_FORM),
  'GET /v2/users/search': () => get(`/v2/users/search?${ON_SITE_A}&ispublic=0&search=Target`),
};

async function probeFor(key: string): Promise<Probe> {
  const build = PROBES[key];
  if (build === undefined) throw new TypeError(`No probe for ${key}`);
  return build();
}

type Outcome = { kind: 'reached' } | { kind: 'denied'; status: 401 | 403 };

const REACHED: Outcome = Object.freeze({ kind: 'reached' });
const DENIED_401: Outcome = Object.freeze({ kind: 'denied', status: 401 });
const DENIED_403: Outcome = Object.freeze({ kind: 'denied', status: 403 });

/** What a subject's credential is on the wire: nothing, a user token beside the gateway's, a workload token, the push key or a tasks token. */
type Presented = 'none' | 'user' | 'workload' | 'push-key' | 'tasks';

function presentedBy(subject: RoleSubject): Presented {
  if (subject.kind === 'anonymous') return 'none';
  if (subject.kind === 'user') return 'user';
  if (subject.caller === 'pubsub-invoker') return 'push-key';
  if (subject.caller === 'tasks-invoker') return 'tasks';
  return 'workload';
}

const GATEWAY_ROLES = rolesForService('gateway');

/** The auth hooks' verdict for `subject` on `entry`, derived from the literal table only. */
function expectedOutcome(entry: RouteMatrixEntry, request: Probe, subject: RoleSubject): Outcome {
  const presented = presentedBy(subject);
  if (entry.transport === 'pubsub-push') return presented === 'push-key' ? REACHED : DENIED_401;
  if (entry.transport === 'cloud-tasks') return presented === 'tasks' ? REACHED : DENIED_401;
  // The service transport verifies a bearer in Authorization as a user token, so a managed-delivery token fails, public routes included.
  if (presented === 'tasks') return DENIED_401;
  if (entry.requires !== undefined) {
    const roles =
      presented === 'user'
        ? [...subject.roles.filter((role) => !isServiceRole(role)), ...GATEWAY_ROLES]
        : presented === 'workload'
          ? [...subject.roles]
          : [];
    if (!hasAnyRole(roles, entry.requires)) {
      if (presented === 'none' || presented === 'push-key') return DENIED_401;
      if (presented === 'workload' && entry.requires.some((role) => !isServiceRole(role))) return DENIED_401;
      return DENIED_403;
    }
  }
  if (presented !== 'user' && HANDLER_USER_BOUND.has(routeKey(entry))) return DENIED_401;
  const siteBound = request.site === true && (entry.siteCheck || HANDLER_SITE_BOUND.has(routeKey(entry)));
  if (presented === 'user' && siteBound && subjectSiteFor(subject, SITE_A) !== SITE_A) return DENIED_403;
  return REACHED;
}

function observedOutcome(result: ProbeResult): Outcome {
  if (!isHookDenial(result)) return REACHED;
  return result.res.statusCode === 401 ? DENIED_401 : DENIED_403;
}

function sortedRoutes(routes: readonly RouteMatrixEntry[]): RouteMatrixEntry[] {
  return routes
    .map((route) => (route.requires === undefined ? { ...route } : { ...route, requires: [...route.requires].sort() }))
    .sort((a, b) => a.url.localeCompare(b.url, 'en') || a.method.localeCompare(b.method, 'en'));
}

describe('declared routes', () => {
  it('registers exactly the literal route table, with each transport, role list, public flag and site check', () => {
    expect(sortedRoutes(collectRouteMatrix(t.app).routes)).toEqual(sortedRoutes(EXPECTED_ROUTES));
  });

  it('has one probe per route of the table', () => {
    expect(Object.keys(PROBES).sort()).toEqual(EXPECTED_ROUTES.map(routeKey).sort());
  });

  it('guards the cUsers and cEditProfile role lists the routes declare', () => {
    expect([...CUSERS_ROUTE_REQUIRES]).toEqual(CUSERS);
    expect([...PROFILE_ROUTE_REQUIRES]).toEqual(PROFILE);
  });

  it('probes every user role, the synthetic roles, other-tenant and each workload of the matrix', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    const required = [
      'anonymous',
      Roles.member,
      Roles.systemUser,
      'editor',
      Roles.siteAdmin,
      Roles.s2,
      'other-tenant',
      Roles.timesheetsEmployee,
      Roles.timesheetsPrimaryApprover,
      Roles.timesheetsSecondaryApprover,
      Roles.financePreparer,
      Roles.financeApprover,
      Roles.esignatureSigner,
      Roles.esignatureAuditor,
      Roles.reportingExporter,
      Roles.surveysManager,
      Roles.communicationsSender,
      serviceRole('gateway'),
      serviceRole('identity'),
      PUBSUB_INVOKER_ROLE,
      TASKS_INVOKER_ROLE,
    ];
    expect(required.filter((name) => !names.includes(name))).toEqual([]);
    const presentedRoles = ROLE_SET.flatMap((subject) => subject.roles);
    expect([Roles.platformMigration, Roles.platformOperator].filter((role) => !presentedRoles.includes(role))).toEqual([]);
    expect(subjectSiteFor(subjectNamed('other-tenant'), SITE_A)).toBe(SITE_B);
  });
});

describe('route × subject matrix', () => {
  for (const entry of EXPECTED_ROUTES) {
    const key = routeKey(entry);
    it(`${key} admits exactly the subjects its declaration admits, and refuses the others before any effect`, async () => {
      const mismatches: Array<{ subject: string; expected: Outcome; observed: Outcome; result: string }> = [];
      for (const subject of ROLE_SET) {
        const request = await probeFor(key);
        const result = await probe(request, await credentialOf(subject));
        const expected = expectedOutcome(entry, request, subject);
        const observed = observedOutcome(result);
        if (JSON.stringify(expected) !== JSON.stringify(observed)) {
          mismatches.push({ subject: subject.name, expected, observed, result: describeResult(result) });
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});

type GateRequest = Parameters<typeof requireCusersAccess>[0];

/** The parts of a request the admin gates read: the verified user, the headers and the query. */
function gateRequest(user: { sub: string; roles: readonly string[] } | undefined, headers: Headers = {}, query: Headers = {}): GateRequest {
  return { opt2Auth: { user, roles: user?.roles ?? [], transport: 'service' }, headers, query } as unknown as GateRequest;
}

/** The status and redirect of a gate's denial; fails when the gate admitted the caller. */
function adminDenialOf(value: unknown): { status: number; redirect: unknown } {
  expect(value).toBeInstanceOf(AdminDenial);
  const denial = value as AdminDenial;
  return { status: denial.statusCode, redirect: denial.redirect };
}

/** `actor` with its token minted for tenant-a, the site every gate probe names. */
function onSiteA(actor: TestActor): TestActor {
  return { ...actor, site: SITE_A };
}

describe('cUsers gate: the site Admin group, S2, or the Users and core module grants together', () => {
  const routes = ['GET /v1/users', 'GET /v1/users/edit', 'POST /v1/users::update', 'GET /v1/users/download'];
  // The roster delete is withheld, so its admitted callers get the legacy-shaped 503 instead of a write.
  const admittedStatus = (key: string): number => (key.startsWith('POST') ? 503 : 200);

  it.each(routes)('lets the site admin, S2 and the Users plus core module user through on %s', async (key) => {
    for (const actor of [SITE_ADMIN_A, onSiteA(ADMIN_S2), MODULE_USER_A]) {
      const result = await probe(await probeFor(key), await actorCredential(actor));
      expect(result.res.statusCode, `${actor.sub}: ${describeResult(result)}`).toBe(admittedStatus(key));
    }
  });

  it.each(routes)('sends m:008 without m:000 back from the handler on %s, Referer or not, before any effect', async (key) => {
    expect(hasAnyRole(MODULE_008_ONLY.roles, CUSERS_ROUTE_REQUIRES)).toBe(true);
    const request = await probeFor(key);
    const credential = await actorCredential(MODULE_008_ONLY);
    const plain = await probe(request, credential);
    const referred = await probe({ ...request, headers: { ...request.headers, referer: 'http://localhost:8080/admin/?muraAction=cDashboard.main' } }, credential);
    for (const result of [plain, referred]) {
      expect(isDenialOf(result, AuthDenial.forbidden(), request.url), describeResult(result)).toBe(true);
    }
  });

  it.each(routes)('refuses the editor and a plain system user at the hook on %s', async (key) => {
    for (const actor of [onSiteA(EDITOR), SYSTEM_USER_A]) {
      expect(hasAnyRole(actor.roles, CUSERS_ROUTE_REQUIRES)).toBe(false);
      const request = await probeFor(key);
      const result = await probe(request, await actorCredential(actor));
      expect(isDenialOf(result, AuthDenial.forbidden(), request.url), describeResult(result)).toBe(true);
    }
  });

  it("answers a logged-in caller it refuses with utility.backUp(): the Referer, else './'", () => {
    const referer = 'http://localhost:8080/admin/?muraAction=cDashboard.main';
    expect(adminDenialOf(requireCusersAccess(gateRequest(MODULE_008_ONLY, { referer })))).toEqual({ status: 403, redirect: { url: referer } });
    expect(adminDenialOf(requireCusersAccess(gateRequest(MODULE_008_ONLY)))).toEqual({ status: 403, redirect: { url: './' } });
  });

  it('sends a caller who is not logged in to cLogin.main, keeping a simple compactDisplay', () => {
    for (const user of [undefined, { sub: '', roles: [] }]) {
      expect(adminDenialOf(requireCusersAccess(gateRequest(user, {}, { compactDisplay: 'true' })))).toEqual({
        status: 401,
        redirect: { action: 'cLogin.main', params: { compactDisplay: 'true' } },
      });
    }
  });

  it('returns the claims of the Users plus core module user and of the site admin', () => {
    for (const actor of [MODULE_USER_A, SITE_ADMIN_A]) {
      expect(requireCusersAccess(gateRequest(actor))).not.toBeInstanceOf(AdminDenial);
    }
  });
});

describe('cEditProfile gate: any logged-in user, acting only on themselves', () => {
  it.each([
    ['a tenant-a system user', SYSTEM_USER_A],
    ['a pooled public member', MEMBER_POOLED],
  ])('lets %s read and post the profile', async (_label, actor) => {
    const credential = await actorCredential(actor);
    const read = await probe(PROFILE_READ, credential);
    expect(read.res.statusCode, describeResult(read)).toBe(200);
    const save = await probe(await probeFor('POST /v1/profile::update'), credential);
    // The withheld extended-data branch answers 503 once the gate has let the caller through.
    expect(save.res.statusCode, describeResult(save)).toBe(503);
  });

  it('refuses an anonymous caller at the hook with 401 before any effect', async () => {
    const result = await probe(PROFILE_READ);
    expect(isDenialOf(result, AuthDenial.unauthenticated('missing-credential'), PROFILE_READ.url), describeResult(result)).toBe(true);
    const save = await probeFor('POST /v1/profile::update');
    const saved = await probe(save);
    expect(isDenialOf(saved, AuthDenial.unauthenticated('missing-credential'), save.url), describeResult(saved)).toBe(true);
  });

  it('sends the anonymous principal to cLogin.main', () => {
    expect(adminDenialOf(requireLoggedIn(gateRequest({ sub: '', roles: [] })))).toEqual({
      status: 401,
      redirect: { action: 'cLogin.main', params: {} },
    });
  });

  it('saves only the token subject, whatever userid and siteid the form posts', async () => {
    const form = `userid=${STRANGER_ID}&siteid=${SITE_B}&fname=Changed&${CSRF_FIELDS}`;
    const result = await probe(postForm('/v1/profile:update', form, false), await actorCredential(SYSTEM_USER_A));
    expect(result.res.statusCode, describeResult(result)).toBe(200);
    const accountCalls = result.identityCalls.filter((call) => call.includes('/accounts/'));
    expect(accountCalls.length).toBeGreaterThan(0);
    expect(accountCalls.filter((call) => !call.includes(SYSTEM_USER_A.sub))).toEqual([]);
    expect(result.identityCalls.filter((call) => call.includes(STRANGER_ID))).toEqual([]);
    const operation = t.db.writes().find((statement) => statement.text.startsWith('INSERT INTO "people"."roster_operation"'));
    expect(operation?.values[ROSTER_OPERATION_COLUMNS.indexOf('user_id')]).toBe(SYSTEM_USER_A.sub);
  });
});

describe('JSON API user and address: AllowAccess needs the Users module, AllowAction also takes the own record', () => {
  const read = (entity: string, id: string): Probe => get(`/_api/json/v1/${SITE_A}/${entity}/${id}`, false);

  function isFindOneRefusal(result: ProbeResult): boolean {
    const body = JSON.stringify({ apiversion: 'v1', method: 'findOne', error: AUTHORIZATION_ERROR });
    return result.res.statusCode === 401 && result.res.body === body && writeFree(result);
  }

  it.each(['user', 'address'])('refuses another %s record to anonymous and system-user callers with 401, never data', async (entity) => {
    for (const credential of [NO_CREDENTIAL, await actorCredential(SYSTEM_USER_A)]) {
      const result = await probe(read(entity, STRANGER_ID), credential);
      expect(isFindOneRefusal(result), describeResult(result)).toBe(true);
    }
  });

  it.each(['user', 'address'])('serves a %s record to the Users module grant alone, unlike cUsers', async (entity) => {
    const result = await probe(read(entity, STRANGER_ID), await actorCredential(MODULE_008_ONLY));
    expect(result.res.statusCode, describeResult(result)).toBe(200);
    expect(writeFree(result)).toBe(true);
  });

  // Legacy AllowAccess lets an own id past its user, group and address clause, then still requires the Users module of a
  // non-public entity (jsonApiUtility.cfc:1714-1736); self access exists only in AllowAction.
  it('refuses a member without the Users module its own user record, as legacy AllowAccess does', async () => {
    const result = await probe(read('user', MEMBER_POOLED.sub), await actorCredential(MEMBER_POOLED));
    expect(isFindOneRefusal(result), describeResult(result)).toBe(true);
  });

  it('refuses an anonymous save without CSRF tokens with invalidTokens before any write', async () => {
    const result = await probe(postForm(`/_api/json/v1/${SITE_A}/user`, 'fname=Probe', false));
    const { code, message } = LEGACY_ERROR_MAP.invalidTokens;
    expect(result.res.statusCode, describeResult(result)).toBe(400);
    expect(errorEnvelope(result.res)).toEqual({ apiversion: 'v1', method: 'save', error: { message, code } });
    expect(writeFree(result)).toBe(true);
  });

  it('refuses an anonymous save on the sessionless REST family with 401 and a Basic challenge before any write', async () => {
    const result = await probe(postForm(`/_api/rest/v1/${SITE_A}/user`, 'fname=Probe', false));
    expect(result.res.statusCode, describeResult(result)).toBe(401);
    expect(result.res.headers['www-authenticate']).toBe('Basic');
    expect(errorEnvelope(result.res)?.error).toEqual(AUTHORIZATION_ERROR);
    expect(writeFree(result)).toBe(true);
  });

  it.each([
    ['a member saving another user', 'user', MEMBER_POOLED],
    ['a system user saving another user address', 'address', SYSTEM_USER_A],
  ])('refuses %s with 401 after the CSRF check, before any write or identity prepare', async (_label, entity, actor) => {
    const form = `userid=${STRANGER_ID}&addressid=${STRANGER_ID}&fname=Probe&address1=Probe&${CSRF_FIELDS}`;
    const result = await probe(postForm(`/_api/json/v1/${SITE_A}/${entity}`, form, false), await actorCredential(actor));
    expect(result.res.statusCode, describeResult(result)).toBe(401);
    expect(errorEnvelope(result.res)?.error).toEqual(AUTHORIZATION_ERROR);
    expect({ writes: result.writes, identityCalls: result.identityCalls, published: result.published }).toEqual({
      writes: 0,
      identityCalls: ['POST /internal/v1/csrf/consume'],
      published: 0,
    });
  });

  it("lets a member's save of its own user record past AllowAction into the roster operation", async () => {
    const form = `userid=${MEMBER_POOLED.sub}&fname=Probe&${CSRF_FIELDS}`;
    const result = await probe(postForm(`/_api/json/v1/${SITE_A}/user`, form, false), await actorCredential(MEMBER_POOLED));
    expect(result.res.statusCode, describeResult(result)).not.toBe(401);
    const operation = t.db.writes().find((statement) => statement.text.startsWith('INSERT INTO "people"."roster_operation"'));
    expect(operation?.values[ROSTER_OPERATION_COLUMNS.indexOf('user_id')]).toBe(MEMBER_POOLED.sub);
    const ownPrepare = (call: string): boolean => call.startsWith(`POST /internal/v1/accounts/${MEMBER_POOLED.sub}/operations/`) && call.endsWith(':prepare');
    expect(result.identityCalls.some(ownPrepare), describeResult(result)).toBe(true);
  });
});

describe('fixture archive gate: site, login, site admin, then the person', () => {
  const archiveUrl = `/legacy-fixtures/cfml/api.cfm/people/persons/${STRANGER_ID}/archive?${ON_SITE_A}`;
  const archive = (fields = ''): Probe => postForm(archiveUrl, `effectiveFrom=2026-07-01${fields}`, false);
  // envelope.cfc orders code before message and keeps api.cfm's method.
  const fixtureRefusal = (message: string): unknown => ({ apiversion: 'v1', method: 'people.persons.archive', error: { code: 'invalid_request', message } });

  function archivedNothing(result: ProbeResult): boolean {
    return result.writes === 0 && result.published === 0 && result.tasks === 0;
  }

  it('refuses an anonymous archive with the fixture authorization envelope', async () => {
    const result = await probe(archive());
    expect(result.res.statusCode, describeResult(result)).toBe(401);
    expect(result.res.body).toBe(JSON.stringify(fixtureRefusal('Insufficient Account Permissions')));
    expect(archivedNothing(result) && result.identityCalls.length === 0).toBe(true);
  });

  it('refuses a logged-in user outside the site Admin group with the fixture forbidden envelope', async () => {
    const result = await probe(archive(`&${CSRF_FIELDS}`), await actorCredential(SYSTEM_USER_A));
    expect(result.res.statusCode, describeResult(result)).toBe(403);
    expect(result.res.body).toBe(JSON.stringify(fixtureRefusal('Insufficient Account Permissions')));
    expect(archivedNothing(result) && result.identityCalls.length === 0).toBe(true);
  });

  it.each([
    ['read', (): Probe => get(archiveUrl, false)],
    ['archive', (): Probe => archive(`&${CSRF_FIELDS}`)],
  ])('lets the site admin through to the person lookup on the %s, which finds no one', async (_label, request) => {
    const result = await probe(request(), await actorCredential(SITE_ADMIN_A));
    expect(result.res.statusCode, describeResult(result)).toBe(404);
    expect(result.res.body).toBe(JSON.stringify(fixtureRefusal('Not Found')));
    expect(archivedNothing(result)).toBe(true);
  });
});

describe("site binding: a supplied siteid must be the token's site, never compared with its tenant", () => {
  it.each([
    ['the hook-checked user search', `/v1/users/search?siteid=${SITE_B}&ispublic=0&search=Target`],
    ['the handler-checked users list', `/v1/users?siteid=${SITE_B}&ispublic=0`],
    ['the handler-checked v2 users list', `/v2/users?siteid=${SITE_B}&ispublic=0`],
    ['the profile read', `/v1/profile?siteid=${SITE_B}`],
  ])('refuses tenant-b on %s to a tenant-a site admin with 403 before any effect', async (_label, url) => {
    const result = await probe(get(url), await actorCredential(SITE_ADMIN_A));
    expect(isDenialOf(result, AuthDenial.siteMismatch(), url), describeResult(result)).toBe(true);
  });

  it('refuses a tenant-b API site to a tenant-a site admin with 403 after the registry read, before any write', async () => {
    const result = await probe(get(`/_api/json/v1/${SITE_B}/user/${STRANGER_ID}`, false), await actorCredential(SITE_ADMIN_A));
    expect(result.res.statusCode, describeResult(result)).toBe(403);
    expect(errorEnvelope(result.res)?.error).toEqual(AUTHORIZATION_ERROR);
    expect(writeFree(result)).toBe(true);
  });

  it.each([
    ['the hook-checked user search', `/v1/users/search?${ON_SITE_A}&ispublic=0&search=Target`],
    ['the handler-checked users list', `/v1/users?${ON_SITE_A}&ispublic=0`],
  ])("admits a tenant-a token whose tid is tenant-b's on %s with siteid=tenant-a", async (_label, url) => {
    const result = await probe(get(url), await actorCredential(SITE_ADMIN_A, { tid: TENANT_B.tenantId }));
    expect(result.res.statusCode, describeResult(result)).toBe(200);
  });

  it('lists siteid=all for S2 only', async () => {
    const url = '/v1/users?siteid=all&ispublic=0';
    const s2 = await probe(get(url), await actorCredential(onSiteA(ADMIN_S2)));
    expect(s2.res.statusCode, describeResult(s2)).toBe(200);
    const siteAdmin = await probe(get(url), await actorCredential(SITE_ADMIN_A));
    expect(isDenialOf(siteAdmin, AuthDenial.siteMismatch(), url), describeResult(siteAdmin)).toBe(true);
  });
});

describe('transport separation: each transport accepts only its own credential', () => {
  const header = (name: string, token: string): Credential => ({ headers: { [name]: `Bearer ${token}` }, query: '' });
  const pushKey = (key: string = TEST_PUSH_KEY): Credential => ({ headers: {}, query: pushKeyQuery(key) });
  const tasksToken = async (): Promise<Credential> => header('authorization', await mintTasksInvokerToken({ audience: SERVICE_NAME }));
  const workload = async (caller: string): Promise<Credential> => header(INVOCATION_HEADER, await mintServiceToken({ caller, audience: SERVICE_NAME }));
  const s2User = (): Promise<Credential> => credentialOf(subjectNamed(Roles.s2));

  function expectRefused(result: ProbeResult, status: 401 | 403): void {
    expect(isHookDenial(result) && result.res.statusCode === status, describeResult(result)).toBe(true);
  }

  describe.each([
    ['site', SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope],
    ['group', GROUP_NAME_SUBSCRIPTION, groupChangedEnvelope],
  ])('the %s push', (_label, subscription, envelope) => {
    it('accepts the push key', async () => {
      const result = await probe(await pushProbe(subscription, envelope()), pushKey());
      expect(result.res.statusCode >= 200 && result.res.statusCode < 300, describeResult(result)).toBe(true);
    });

    it.each<[string, () => Promise<Credential>]>([
      ['no key', () => Promise.resolve(NO_CREDENTIAL)],
      ['a wrong key', () => Promise.resolve(pushKey(`${TEST_PUSH_KEY}-wrong`))],
      ['a user token in Authorization', s2User],
      ['a user token in Authorization beside the push key', async () => ({ ...(await s2User()), query: pushKeyQuery() })],
      ['a service token in the invocation header', () => workload('gateway')],
      ['a tasks-invoker token', tasksToken],
    ])('refuses %s with 401 before any effect', async (_label, credential) => {
      expectRefused(await probe(await pushProbe(subscription, envelope()), await credential()), 401);
    });
  });

  it('accepts the tasks-invoker token on the outbox sweep', async () => {
    const result = await probe(SWEEP_PROBE, await tasksToken());
    expect(result.res.statusCode, describeResult(result)).toBe(200);
  });

  it.each<[string, () => Promise<Credential>]>([
    ['an s2 user token', s2User],
    ['a gateway invocation token', () => workload('gateway')],
    ['the push key', () => Promise.resolve(pushKey())],
    ['a tasks-invoker token addressed to identity', async () => header('authorization', await mintTasksInvokerToken({ audience: 'identity' }))],
  ])('refuses %s on the outbox sweep with 401 before any effect', async (_label, credential) => {
    expectRefused(await probe(SWEEP_PROBE, await credential()), 401);
  });

  it('admits the migration workload on every migration route', async () => {
    const credential = await workload('migration');
    for (const key of EXPECTED_ROUTES.map(routeKey).filter((candidate) => candidate.includes('/internal/v1/migration/'))) {
      const result = await probe(await probeFor(key), credential);
      expect(isHookDenial(result), `${key}: ${describeResult(result)}`).toBe(false);
    }
  });

  it.each<[string, () => Promise<Credential>, 401 | 403]>([
    ['the operator workload', () => workload('operator'), 403],
    ['the gateway workload', () => workload('gateway'), 403],
    ['an s2 user token beside the gateway credential', s2User, 403],
    ['a tasks-invoker token', tasksToken, 401],
    ['the migration workload addressed to identity', async () => header(INVOCATION_HEADER, await mintServiceToken({ caller: 'migration', audience: 'identity' })), 401],
  ])('refuses %s on a migration route', async (_label, credential, status) => {
    expectRefused(await probe(await probeFor('POST /internal/v1/migration/apply'), await credential()), status);
  });

  it.each(['migration', 'operator'])('lets the %s workload pause and resume the sweep queue', async (caller) => {
    const credential = await workload(caller);
    for (const op of ['pause', 'resume']) {
      const result = await probe(control(op), credential);
      expect(result.res.statusCode, describeResult(result)).toBe(200);
    }
  });

  it.each<[string, () => Promise<Credential>, 401 | 403]>([
    ['the gateway workload', () => workload('gateway'), 403],
    ['an s2 user token beside the gateway credential', s2User, 403],
    ['a site-admin user token beside the gateway credential', () => credentialOf(subjectNamed(Roles.siteAdmin)), 403],
    ['a tasks-invoker token', tasksToken, 401],
  ])('refuses %s on queue control', async (_label, credential, status) => {
    expectRefused(await probe(control('pause'), await credential()), status);
  });

  const siteAdminToken = (claims: Partial<Parameters<typeof mintUserToken>[0]> = {}): Promise<string> =>
    mintUserToken({ sub: SITE_ADMIN_A.sub, site: SITE_A, roles: SITE_ADMIN_A.roles, ...claims });
  const besideGateway = async (userToken: string): Promise<Credential> => ({
    headers: { authorization: `Bearer ${userToken}`, ...(await workload('gateway')).headers },
    query: '',
  });

  describe.each(['GET /v1/users', 'GET /v1/users/groups', 'POST /v1/users::update', 'GET /v1/profile'])('the user route %s', (key) => {
    it.each<[string, () => Promise<Credential>]>([
      ['a tasks-invoker token in Authorization', tasksToken],
      ['a tasks-invoker token beside the gateway credential', async () => ({ headers: { ...(await tasksToken()).headers, ...(await workload('gateway')).headers }, query: '' })],
      ['the push key', () => Promise.resolve(pushKey())],
      ['the push key beside the gateway credential', async () => ({ ...(await workload('gateway')), query: pushKeyQuery() })],
      ['a user token without an invocation credential', async () => header('authorization', await siteAdminToken())],
      ['a user token beside a gateway credential addressed to identity', async () => ({
        headers: { authorization: `Bearer ${await siteAdminToken()}`, [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}` },
        query: '',
      })],
      ['a user token of another issuer', async () => besideGateway(await siteAdminToken({ iss: 'opt2-other-issuer' }))],
      ['a user token for another audience', async () => besideGateway(await siteAdminToken({ aud: 'opt2-other' }))],
      ['an expired user token', async () => besideGateway(await siteAdminToken({ exp: Math.floor(Date.now() / 1000) - 60 }))],
      ['Basic credentials beside the gateway credential', async () => ({ headers: { authorization: 'Basic YWRtaW46YWRtaW4=', ...(await workload('gateway')).headers }, query: '' })],
    ])('refuses %s with 401 before any effect', async (_label, credential) => {
      expectRefused(await probe(await probeFor(key), await credential()), 401);
    });
  });
});

describe('deny by default at start-up', () => {
  it.each<[string, Opt2RouteConfig | undefined]>([
    ['declares no config.opt2', undefined],
    ['declares neither requires nor public', { transport: 'service' }],
    ['declares both requires and public', { requires: [Roles.s2], public: true }],
    ['declares an empty requires list', { requires: [] }],
  ])('fails start-up for a route that %s', async (_label, opt2) => {
    const app = await createService({ name: 'people-undeclared', version: '0.0.0', env: testEnv({ LOG_LEVEL: 'error' }, t.stateDir), verifierOverride: testVerifier() });
    try {
      const startUp = (async () => {
        await app.register(async (scope) => {
          scope.get('/undeclared', opt2 === undefined ? {} : { config: { opt2 } }, async () => ({}));
        });
        await app.ready();
      })();
      await expect(startUp).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
