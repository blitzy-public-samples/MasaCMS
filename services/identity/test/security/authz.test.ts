/** In-process authorisation matrix of identity as its composition root builds it: every route × subject, the legacy handler gates, the site check, transport separation and deny by default. */
import { isDeepStrictEqual } from 'node:util';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  LOCAL_USER_TOKEN,
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  isServiceRole,
  moduleRole,
  renderAuthDenial,
  serviceRole,
  type DenialResponse,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, type EventEnvelope } from '@opt2/platform/events';
import {
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  LEGACY_ERROR_MAP,
  WWW_AUTHENTICATE,
  cfUuid,
  generateCsrfToken,
  legacyErrorResponse,
} from '@opt2/platform/legacy-compat';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  fixtureForSite,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushKeyQuery,
  registryPayloads,
  testEnvelope,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { SERVICE_NAME } from '../../src/app.js';
import { PERSON_CHANGED_TOPIC, PERSON_CONTACT_SUBSCRIPTION, type PersonChangedPayload } from '../../src/events/person-contact.js';
import { SWEEP_QUEUE, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { groupRow, sessionRow } from '../helpers/rows.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Headers = Record<string, string>;

const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;

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

/** Workloads whose invocation credential carries `service:<name>` alone. */
const PLAIN_WORKLOADS = [
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
] as const;

const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;

const REQUIRED_WORKLOADS = [
  'service:gateway',
  'service:people',
  'service:programs-sites',
  'service:strategies-content',
  'service:migration',
  'service:operator',
  'service:tasks-invoker',
  'service:pubsub-invoker',
] as const;

const USERS_MODULE = moduleRole('00000000000000000000000000000000008');
const SITE_MANAGER_MODULE = moduleRole('00000000000000000000000000000000000');

/** The cUsers conjunction subjects of tenant-a: the Users grant alone, and with the Site Manager grant. */
const MODULE_ONLY: RoleSubject = Object.freeze({ name: 'users-module', kind: 'user', roles: Object.freeze([Roles.systemUser, USERS_MODULE]) });
const MODULE_AND_SITE_MANAGER: RoleSubject = Object.freeze({
  name: 'users-and-site-manager',
  kind: 'user',
  roles: Object.freeze([Roles.systemUser, USERS_MODULE, SITE_MANAGER_MODULE]),
});

const SUBJECTS: readonly RoleSubject[] = Object.freeze([...ROLE_SET, MODULE_ONLY, MODULE_AND_SITE_MANAGER]);

/** What a subject presents: nothing, a user token beside the gateway's invocation credential, its own invocation credential, the tasks-invoker token, or the push key. */
type Credential = 'none' | 'user' | 'invocation' | 'tasks-token' | 'push-key';

interface SubjectRecord {
  credential: Credential;
  /** Roles the hooks compute: the user's roles and the invocation credential's roles. */
  roles: readonly string[];
  site?: string;
  tid?: string;
}

const GATEWAY_ROLE = serviceRole('gateway');

function throughGateway(userRoles: readonly string[], site: string = SITE_A): SubjectRecord {
  return { credential: 'user', roles: [...userRoles, GATEWAY_ROLE], site, tid: fixtureForSite(site)?.tenantId };
}

/** Every subject as headersFor presents it to identity, written out so each expected cell is literal. */
const RECORDS: Readonly<Record<string, SubjectRecord>> = Object.freeze({
  anonymous: { credential: 'none', roles: [] },
  member: throughGateway(['member']),
  'system-user': throughGateway(['system-user']),
  editor: throughGateway(['system-user']),
  'site-admin': throughGateway(['system-user', 'site-admin']),
  s2: throughGateway(['system-user', 's2']),
  'other-tenant': throughGateway(['system-user', 'site-admin'], SITE_B),
  ...Object.fromEntries(SYNTHETIC.map((role) => [role, throughGateway(['system-user', role])])),
  'users-module': throughGateway(['system-user', 'm:008']),
  'users-and-site-manager': throughGateway(['system-user', 'm:008', 'm:000']),
  ...Object.fromEntries(PLAIN_WORKLOADS.map((role) => [role, { credential: 'invocation', roles: [role] } satisfies SubjectRecord])),
  'service:migration': { credential: 'invocation', roles: ['service:migration', 'platform.migration'] },
  'service:operator': { credential: 'invocation', roles: ['service:operator', 'platform.operator'] },
  'service:pubsub-invoker': { credential: 'push-key', roles: [PUBSUB_INVOKER_ROLE] },
  'service:tasks-invoker': { credential: 'tasks-token', roles: [TASKS_INVOKER_ROLE] },
} satisfies Record<string, SubjectRecord>);

const tenantOfSite = (siteId: string): string | null => fixtureForSite(siteId)?.tenantId ?? null;

/** `tenant_registry` rows of the platform fixture sites, as the site.changed consumer stores them. */
const REGISTRY_ROWS = registryPayloads().map((site) => {
  const pool = (value: string | null | undefined): string => value ?? site.siteId;
  const contentPools = [site.contentPoolIds ?? [site.siteId]].flat();
  return {
    site_id: site.siteId,
    tenant_id: tenantOfSite(site.siteId),
    public_user_pool_id: pool(site.publicUserPoolId),
    private_user_pool_id: pool(site.privateUserPoolId),
    category_pool_id: pool(site.categoryPoolId),
    file_pool_id: pool(site.filePoolId),
    display_pool_id: pool(site.displayPoolId),
    content_pool_ids: contentPools,
    public_user_pool_tenant: tenantOfSite(pool(site.publicUserPoolId)),
    private_user_pool_tenant: tenantOfSite(pool(site.privateUserPoolId)),
    category_pool_tenant: tenantOfSite(pool(site.categoryPoolId)),
    file_pool_tenant: tenantOfSite(pool(site.filePoolId)),
    display_pool_tenant: tenantOfSite(pool(site.displayPoolId)),
    content_pool_tenants: contentPools.map(tenantOfSite),
    domains: site.domains ?? [],
  };
});

/** Answers the registry reads of `@opt2/platform/tenancy` from REGISTRY_ROWS, by their WHERE clause. */
function registryAnswer(sql: string, values: readonly unknown[]): Array<Record<string, unknown>> {
  const [first] = values;
  let rows = REGISTRY_ROWS;
  if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(sql)) rows = rows.filter((row) => row.site_id.toLowerCase() === String(first).toLowerCase());
  else if (/WHERE public_user_pool_tenant = \$1 OR private_user_pool_tenant = \$1/.test(sql)) {
    rows = rows.filter((row) => row.public_user_pool_tenant === first || row.private_user_pool_tenant === first);
  } else if (/WHERE tenant_id = \$1/.test(sql)) rows = rows.filter((row) => row.tenant_id === first);
  const pooled = /SELECT (\w+) AS pool_tenant/.exec(sql)?.[1];
  return rows.map((row) => (pooled === undefined ? { ...row } : { ...row, pool_tenant: (row as Record<string, unknown>)[pooled] }));
}

/** The anonymous tenant-a session whose CSRF secret the group.save checks validate against. */
const ANONYMOUS_SESSION = sessionRow({ session_id: 'S-authz-anonymous' });

/** A stored Type=1 group of tenant-a's private pool, the only group the recording database answers. */
const STORED_GROUP = groupRow({ groupname: 'Authz Stored' });

/** One concrete tenant-a request; each subject's credentials are added when it is sent. */
interface Probe {
  method: Method;
  url: string;
  payload?: string | Record<string, unknown>;
  headers?: Headers;
  /** The `siteid` the request supplies anywhere (path, query or body). */
  siteid?: string;
}

/** One registered route: its declaration, the legacy gates its handler adds, and its probe. */
interface Row {
  transport: Transport;
  allow: 'public' | readonly string[];
  /** Who compares a supplied `siteid` with the token's site: the hooks by default, the handler, or nobody. */
  siteCheck?: false | 'handler';
  /** The handler acts for the verified user token and refuses a caller without one with 401. */
  actsForUser?: true;
  /** The cUsers `before()` conjunction: S2, a site admin, or the Users and Site Manager grants together. */
  cusers?: true;
  /** Legacy gate the declaration reproduces. */
  source?: string;
  probe: Probe;
}

const FORM: Headers = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded' });
const SITE_QUERY = `siteid=${SITE_A}`;
// The extended-attribute group save stays on legacy, so identity refuses it before reading any session or row.
const WITHHELD_SAVE = 'extendSetID=probe';
const GROUP_ID = cfUuid();
const USER_ID = cfUuid();
const CLIENT_ID = cfUuid();
const OPERATION_ID = cfUuid();
const UNKNOWN_SESSION = 'S-authz-unknown';
const HOME = '00000000000000000000000000000000001';
const USERS_MODULE_ID = '00000000000000000000000000000000008';
const SITE_SUBSCRIPTION = 'identity.programs-sites.site.changed.v1';

const GATEWAY_ONLY = ['service:gateway'] as const;
const PEOPLE_ONLY = ['service:people'] as const;
const MIGRATION_ONLY = ['platform.migration'] as const;
const QUEUE_CONTROL = ['platform.migration', 'platform.operator'] as const;
const CUSERS_ROLES = ['s2', 'site-admin', 'm:008'] as const;
const CPERM_ROLES = ['s2', 'site-admin'] as const;
const CWEBSERVICE_ROLES = ['s2'] as const;
const SESSION_SITES_ROLES = ['system-user', 's2'] as const;
/** The CSRF-hook callers `consumeCsrfToken` declares, in contract order. */
const CONSUME_CALLERS = [
  'service:people',
  'service:programs-sites',
  'service:strategies-content',
  'service:identity',
  'service:gateway',
  'service:communications',
  'service:finance',
  'service:reporting',
  'service:surveys',
  'service:timesheets',
] as const;

function service(allow: Row['allow'], probe: Probe, extra: Omit<Partial<Row>, 'transport' | 'allow' | 'probe'> = {}): Row {
  return { transport: 'service', allow, probe, ...extra };
}

/** A catch-all JSON API route, probed with the withheld `group.save{extdata}` key identity answers with the legacy 404. */
function jsonApi(family: 'json' | 'ajax' | 'rest', method: Method, lead: '' | '/index.cfm'): Row {
  const url = `${lead}/_api/${family}/v1/${SITE_A}/?method=save&entityname=group&${WITHHELD_SAVE}`;
  return service('public', { method, url, siteid: SITE_A }, { siteCheck: 'handler', source: 'jsonApiUtility.cfc:398-412' });
}

function cusers(probe: Probe): Row {
  return service(CUSERS_ROLES, { ...probe, siteid: SITE_A }, { cusers: true, source: 'cusers.cfc:90-124' });
}

function cperm(probe: Probe): Row {
  return service(CPERM_ROLES, { ...probe, siteid: SITE_A }, { source: 'cperm.cfc:78-81' });
}

function cwebservice(probe: Probe): Row {
  return service(CWEBSERVICE_ROLES, { ...probe, siteid: SITE_A }, { source: 'cwebservice.cfc:80-88' });
}

const operationUrl = (action?: string): string =>
  `/internal/v1/accounts/${USER_ID}/operations/${OPERATION_ID}${action === undefined ? '' : `:${action}`}`;

const PERSON_PAYLOAD: PersonChangedPayload = {
  userId: USER_ID,
  siteId: SITE_A,
  deleted: false,
  groupName: null,
  fname: 'Authz',
  lname: 'Probe',
  email: 'authz.probe@example.test',
  company: null,
  jobTitle: null,
  mobilePhone: null,
  website: null,
  subType: 'Default',
  ext: null,
  contactForm: null,
  subscribe: 0,
  notes: null,
  description: null,
  interests: null,
  keepPrivate: 0,
  photoFileId: null,
  imName: null,
  imService: null,
  tags: null,
  created: null,
  lastUpdate: null,
  lastUpdateBy: null,
  lastUpdateById: null,
};

/** The registry payload of a platform fixture site; throws for a site the fixtures do not hold. */
function fixtureSitePayload(siteId: string): ReturnType<typeof registryPayloads>[number] {
  const found = registryPayloads().find((site) => site.siteId === siteId);
  if (found === undefined) throw new TypeError(`No fixture site ${siteId}`);
  return found;
}

const SITE_PAYLOAD = fixtureSitePayload(SITE_A);

function pushBody(subscription: string, envelope: EventEnvelope): Record<string, unknown> {
  return { ...buildPushBody({ data: encodeEnvelope(envelope), messageId: cfUuid(), subscription }) };
}

function push(subscription: string, envelope: EventEnvelope): Row {
  return {
    transport: 'pubsub-push',
    allow: [PUBSUB_INVOKER_ROLE],
    probe: { method: 'POST', url: `/internal/v1/events/${subscription}`, payload: pushBody(subscription, envelope) },
  };
}

/** Every registered route, keyed `<METHOD> <fastify url>` as collectRouteMatrix reports it. */
const EXPECTED: Readonly<Record<string, Row>> = {
  'DELETE /_api/ajax/v1*': jsonApi('ajax', 'DELETE', ''),
  'GET /_api/ajax/v1*': jsonApi('ajax', 'GET', ''),
  'POST /_api/ajax/v1*': jsonApi('ajax', 'POST', ''),
  'PUT /_api/ajax/v1*': jsonApi('ajax', 'PUT', ''),
  'DELETE /_api/json/v1*': jsonApi('json', 'DELETE', ''),
  'GET /_api/json/v1*': jsonApi('json', 'GET', ''),
  'POST /_api/json/v1*': jsonApi('json', 'POST', ''),
  'PUT /_api/json/v1*': jsonApi('json', 'PUT', ''),
  'DELETE /_api/rest/v1*': jsonApi('rest', 'DELETE', ''),
  'GET /_api/rest/v1*': jsonApi('rest', 'GET', ''),
  'POST /_api/rest/v1*': jsonApi('rest', 'POST', ''),
  'PUT /_api/rest/v1*': jsonApi('rest', 'PUT', ''),
  'DELETE /index.cfm/_api/ajax/v1*': jsonApi('ajax', 'DELETE', '/index.cfm'),
  'GET /index.cfm/_api/ajax/v1*': jsonApi('ajax', 'GET', '/index.cfm'),
  'POST /index.cfm/_api/ajax/v1*': jsonApi('ajax', 'POST', '/index.cfm'),
  'PUT /index.cfm/_api/ajax/v1*': jsonApi('ajax', 'PUT', '/index.cfm'),
  'DELETE /index.cfm/_api/json/v1*': jsonApi('json', 'DELETE', '/index.cfm'),
  'GET /index.cfm/_api/json/v1*': jsonApi('json', 'GET', '/index.cfm'),
  'POST /index.cfm/_api/json/v1*': jsonApi('json', 'POST', '/index.cfm'),
  'PUT /index.cfm/_api/json/v1*': jsonApi('json', 'PUT', '/index.cfm'),
  'DELETE /index.cfm/_api/rest/v1*': jsonApi('rest', 'DELETE', '/index.cfm'),
  'GET /index.cfm/_api/rest/v1*': jsonApi('rest', 'GET', '/index.cfm'),
  'POST /index.cfm/_api/rest/v1*': jsonApi('rest', 'POST', '/index.cfm'),
  'PUT /index.cfm/_api/rest/v1*': jsonApi('rest', 'PUT', '/index.cfm'),
  'GET /.well-known/jwks.json': service('public', { method: 'GET', url: '/.well-known/jwks.json' }),
  'GET /healthz': service('public', { method: 'GET', url: '/healthz' }),

  'POST /internal/v1/tokens': service(GATEWAY_ONLY, {
    method: 'POST',
    url: '/internal/v1/tokens',
    payload: { sessionId: UNKNOWN_SESSION, siteId: SITE_A },
    siteid: SITE_A,
  }),
  'POST /internal/v1/authenticate': service(GATEWAY_ONLY, {
    method: 'POST',
    url: '/internal/v1/authenticate',
    payload: { method: 'GET', path: `/_api/rest/v1/${SITE_A}/group`, headers: {}, query: {} },
  }),
  'POST /internal/v1/sessions::adopt': service(GATEWAY_ONLY, {
    method: 'POST',
    url: '/internal/v1/sessions:adopt',
    payload: {
      legacySessionId: 'L-authz-adopt',
      siteId: SITE_A,
      describe: { user: { isLoggedIn: false, userID: '' }, roles: [], csrfSecretKey: cfUuid(), usedTokens: [] },
    },
    siteid: SITE_A,
  }),
  'GET /internal/v1/sessions/:sid/state': service(GATEWAY_ONLY, { method: 'GET', url: `/internal/v1/sessions/${UNKNOWN_SESSION}/state` }),
  'GET /internal/v1/sessions/:sid/snapshot': service(GATEWAY_ONLY, { method: 'GET', url: `/internal/v1/sessions/${UNKNOWN_SESSION}/snapshot` }),
  'GET /internal/v1/sessions/:sid/admin-site': service(GATEWAY_ONLY, { method: 'GET', url: `/internal/v1/sessions/${UNKNOWN_SESSION}/admin-site` }),
  'POST /internal/v1/sessions/:sid(.+)::end': service(GATEWAY_ONLY, {
    method: 'POST',
    url: `/internal/v1/sessions/${UNKNOWN_SESSION}:end`,
    payload: { reason: 'logout' },
  }),
  'POST /internal/v1/csrf/claims': service(GATEWAY_ONLY, {
    method: 'POST',
    url: '/internal/v1/csrf/claims',
    payload: { sessionId: UNKNOWN_SESSION, token: 'T-authz', expires: '260630150000123', context: 'authz' },
  }),
  'POST /internal/v1/csrf/claims::settle': service(GATEWAY_ONLY, {
    method: 'POST',
    url: '/internal/v1/csrf/claims:settle',
    payload: { sessionId: UNKNOWN_SESSION, consumed: [], released: [] },
  }),
  // An incomplete body answers 400 before the handler, which needs the caller's relayed session.
  'POST /internal/v1/csrf/consume': service(CONSUME_CALLERS, { method: 'POST', url: '/internal/v1/csrf/consume', payload: {} }),

  'GET /internal/v1/accounts/:userId': service(PEOPLE_ONLY, { method: 'GET', url: `/internal/v1/accounts/${USER_ID}` }, { actsForUser: true }),
  'POST /internal/v1/accounts/:userId/login-block': service(PEOPLE_ONLY, { method: 'POST', url: `/internal/v1/accounts/${USER_ID}/login-block`, payload: {} }),
  'POST /internal/v1/accounts::lookup': service(PEOPLE_ONLY, { method: 'POST', url: '/internal/v1/accounts:lookup', payload: {} }),
  'POST /internal/v1/accounts::lookup-all-sites': service(PEOPLE_ONLY, { method: 'POST', url: '/internal/v1/accounts:lookup-all-sites', payload: {} }),
  'POST /internal/v1/accounts::count': service(PEOPLE_ONLY, { method: 'POST', url: '/internal/v1/accounts:count', payload: {} }),
  'POST /internal/v1/accounts::username-candidates': service(PEOPLE_ONLY, { method: 'POST', url: '/internal/v1/accounts:username-candidates', payload: {} }),
  'POST /internal/v1/accounts::memberships': service(PEOPLE_ONLY, { method: 'POST', url: '/internal/v1/accounts:memberships', payload: {} }),
  'GET /internal/v1/groups': service(PEOPLE_ONLY, { method: 'GET', url: '/internal/v1/groups?ispublic=2' }),
  'GET /internal/v1/accounts/:userId/operations/:operationId': service(PEOPLE_ONLY, { method: 'GET', url: operationUrl() }),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::prepare': service(
    PEOPLE_ONLY,
    { method: 'POST', url: operationUrl('prepare'), payload: {} },
    { siteCheck: false },
  ),
  // An unknown operation answers 409 once admitted.
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::commit': service(PEOPLE_ONLY, { method: 'POST', url: operationUrl('commit') }),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::abort': service(PEOPLE_ONLY, { method: 'POST', url: operationUrl('abort') }),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::finish': service(PEOPLE_ONLY, { method: 'POST', url: operationUrl('finish') }),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::revert': service(PEOPLE_ONLY, { method: 'POST', url: operationUrl('revert') }),

  'POST /internal/v1/migration/apply': service(MIGRATION_ONLY, { method: 'POST', url: '/internal/v1/migration/apply', payload: {} }),
  'GET /internal/v1/migration/export': service(MIGRATION_ONLY, { method: 'GET', url: '/internal/v1/migration/export' }),
  'GET /internal/v1/migration/changes': service(MIGRATION_ONLY, { method: 'GET', url: '/internal/v1/migration/changes' }),
  'GET /internal/v1/migration/position': service(MIGRATION_ONLY, { method: 'GET', url: '/internal/v1/migration/position' }),
  'GET /internal/v1/migration/watermark': service(MIGRATION_ONLY, { method: 'GET', url: '/internal/v1/migration/watermark' }),
  'POST /internal/v1/migration/watermark': service(MIGRATION_ONLY, { method: 'POST', url: '/internal/v1/migration/watermark', payload: {} }),
  'POST /internal/v1/migration/gate': service(MIGRATION_ONLY, { method: 'POST', url: '/internal/v1/migration/gate', payload: {} }),

  'POST /internal/v1/task-queues/:queue/pause': service(QUEUE_CONTROL, { method: 'POST', url: `/internal/v1/task-queues/${SWEEP_QUEUE}/pause` }),
  'POST /internal/v1/task-queues/:queue/resume': service(QUEUE_CONTROL, { method: 'POST', url: `/internal/v1/task-queues/${SWEEP_QUEUE}/resume` }),
  'POST /internal/v1/task-queues/:queue/ensure': service(QUEUE_CONTROL, { method: 'POST', url: `/internal/v1/task-queues/${SWEEP_QUEUE}/ensure` }),
  'POST /internal/v1/outbox/sweep': {
    transport: 'cloud-tasks',
    allow: [TASKS_INVOKER_ROLE],
    probe: {
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      payload: { queue: SWEEP_QUEUE, name: `${SWEEP_QUEUE}-authz-probe`, tenantId: null, payload: null },
    },
  },
  'POST /internal/v1/events/identity.programs-sites.site.changed.v1': push(
    SITE_SUBSCRIPTION,
    testEnvelope({ topic: 'programs-sites.site.changed.v1', tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload: SITE_PAYLOAD }),
  ),
  'POST /internal/v1/events/identity.people.person.changed.v1': push(
    PERSON_CONTACT_SUBSCRIPTION,
    testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: USER_ID, payload: PERSON_PAYLOAD }),
  ),

  'GET /v1/groups': cusers({ method: 'GET', url: `/v1/groups?${SITE_QUERY}` }),
  'POST /v1/groups': cusers({ method: 'POST', url: `/v1/groups?${SITE_QUERY}`, headers: FORM, payload: `userid=${GROUP_ID}&groupname=Authz&${WITHHELD_SAVE}` }),
  'GET /v1/groups/:groupId': cusers({ method: 'GET', url: `/v1/groups/${GROUP_ID}?${SITE_QUERY}` }),
  'PUT /v1/groups/:groupId': cusers({ method: 'PUT', url: `/v1/groups/${GROUP_ID}?${SITE_QUERY}`, headers: FORM, payload: `groupname=Authz&${WITHHELD_SAVE}` }),
  'GET /v1/groups/:groupId/members': cusers({ method: 'GET', url: `/v1/groups/${GROUP_ID}/members?${SITE_QUERY}` }),
  'GET /v1/groups/:groupId/members.csv': cusers({ method: 'GET', url: `/v1/groups/${GROUP_ID}/members.csv?${SITE_QUERY}` }),
  'POST /v1/groups/:groupId/members/:userId': cusers({ method: 'POST', url: `/v1/groups/${GROUP_ID}/members/${USER_ID}?${SITE_QUERY}` }),
  'DELETE /v1/groups/:groupId/members/:userId': cusers({ method: 'DELETE', url: `/v1/groups/${GROUP_ID}/members/${USER_ID}?${SITE_QUERY}` }),
  'GET /v1/users/:userId/memberships': cusers({ method: 'GET', url: `/v1/users/${USER_ID}/memberships?${SITE_QUERY}` }),

  'GET /v1/permissions/content/:contentId': cperm({ method: 'GET', url: `/v1/permissions/content/${HOME}?${SITE_QUERY}` }),
  'GET /v1/permissions/modules/:moduleId': cperm({ method: 'GET', url: `/v1/permissions/modules/${USERS_MODULE_ID}?${SITE_QUERY}` }),
  'PUT /v1/permissions/modules/:moduleId': cperm({
    method: 'PUT',
    url: `/v1/permissions/modules/${USERS_MODULE_ID}?${SITE_QUERY}`,
    headers: FORM,
    payload: `groupid=${GROUP_ID}`,
  }),
  'GET /v1/permissions/reverse-lookup': service('public', { method: 'GET', url: `/v1/permissions/reverse-lookup?${SITE_QUERY}`, siteid: SITE_A }, { actsForUser: true }),

  'GET /v1/oauth-clients': cwebservice({ method: 'GET', url: `/v1/oauth-clients?${SITE_QUERY}` }),
  'GET /v1/oauth-clients/:clientId': cwebservice({ method: 'GET', url: `/v1/oauth-clients/${CLIENT_ID}?${SITE_QUERY}` }),
  'PUT /v1/oauth-clients/:clientId': cwebservice({
    method: 'PUT',
    url: `/v1/oauth-clients/${CLIENT_ID}?${SITE_QUERY}`,
    payload: { siteid: SITE_A, name: 'Authz client', granttype: 'client_credentials' },
  }),
  'DELETE /v1/oauth-clients/:clientId': cwebservice({ method: 'DELETE', url: `/v1/oauth-clients/${CLIENT_ID}?${SITE_QUERY}` }),

  'GET /v1/sessions/current': service('public', { method: 'GET', url: `/v1/sessions/current?${SITE_QUERY}`, siteid: SITE_A }),
  'GET /v1/sessions/current/sites': service(SESSION_SITES_ROLES, { method: 'GET', url: `/v1/sessions/current/sites?${SITE_QUERY}`, siteid: SITE_A }),
  'GET /v1/sessions/current/admin-state': service(
    'public',
    { method: 'GET', url: `/v1/sessions/current/admin-state?${SITE_QUERY}`, siteid: SITE_A },
    { actsForUser: true },
  ),
  // A body the contract refuses answers 400 before the handler, which needs a stored session.
  'POST /v1/sessions/current/admin-state': service('public', { method: 'POST', url: '/v1/sessions/current/admin-state', payload: { topID: {} } }, { siteCheck: false }),
  'POST /v1/sessions/login': service('public', { method: 'POST', url: '/v1/sessions/login', headers: FORM, payload: 'username=authz&password=authz' }),
  'POST /v1/sessions/logout': service('public', { method: 'POST', url: '/v1/sessions/logout' }),
  'POST /v1/csrf/tokens': service('public', { method: 'POST', url: '/v1/csrf/tokens', payload: { contexts: [] } }),
  'POST /v1/login-mail': service('public', { method: 'POST', url: '/v1/login-mail', payload: { email: 'nobody@example.test' } }),
};

const ADMITTED = 'admitted' as const;
type Outcome = typeof ADMITTED | AuthDenial;

/** Whether the cUsers `before()` gate admits `roles` [legacy: admin/core/controllers/cusers.cfc:90-124]. */
function cusersAdmits(roles: readonly string[]): boolean {
  return roles.includes(Roles.s2) || roles.includes(Roles.siteAdmin) || (roles.includes(USERS_MODULE) && roles.includes(SITE_MANAGER_MODULE));
}

/** The answer `record` is owed on `row`: admission, or the denial of the auth hooks or of the row's handler gate. */
function expectedOutcome(row: Row, record: SubjectRecord): Outcome {
  const { credential, roles } = record;
  const isPublic = row.allow === 'public';
  const holdsRole = row.allow === 'public' || row.allow.some((role) => roles.includes(role));
  if (row.transport !== 'service') {
    const accepted = row.transport === 'pubsub-push' ? credential === 'push-key' : credential === 'tasks-token';
    return accepted && holdsRole ? ADMITTED : AuthDenial.unauthenticated('wrong-scheme');
  }
  // The tasks token is no invocation credential, and on a public route it fails verification as a user token.
  if (credential === 'tasks-token') return isPublic ? AuthDenial.invalidToken() : AuthDenial.unauthenticated('missing-credential');
  if (credential === 'none' || credential === 'push-key') {
    return isPublic && row.actsForUser !== true ? ADMITTED : AuthDenial.unauthenticated('missing-credential');
  }
  const user = credential === 'user';
  if (!holdsRole) {
    const workloadOnly = row.allow !== 'public' && row.allow.every((role) => isServiceRole(role));
    return user || workloadOnly ? AuthDenial.forbidden() : AuthDenial.unauthenticated('missing-credential');
  }
  if (user && row.siteCheck !== false && row.probe.siteid !== undefined && row.probe.siteid !== record.site) return AuthDenial.siteMismatch();
  if (!user && row.actsForUser === true) return AuthDenial.unauthenticated('missing-credential');
  if (row.cusers === true && !cusersAdmits(roles)) return AuthDenial.forbidden();
  return ADMITTED;
}

function labelOf(outcome: Outcome): string {
  return outcome === ADMITTED ? 'admitted' : `denied ${outcome.statusCode}`;
}

function withQuery(url: string, query: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** The URL `record` requests: the push invoker's key travels in the query, as the emulator's push endpoint carries it. */
function urlFor(probe: Probe, record: SubjectRecord): string {
  return record.credential === 'push-key' ? withQuery(probe.url, pushKeyQuery()) : probe.url;
}

type DenialRequest = Parameters<typeof renderAuthDenial>[1];

/** The response the platform renders `denial` with for a request to `url`; renderAuthDenial reads only the request's query. */
function denialResponse(denial: AuthDenial, url: string): DenialResponse {
  const query = Object.fromEntries(new URL(url, 'http://identity.test').searchParams);
  return renderAuthDenial(denial, { query } as unknown as DenialRequest);
}

let t: TestApp;
let matrix: RouteMatrix;

/** Recorded handler effects: committed writes, memory-repository writes, publishes, service calls and created tasks. */
interface Effects {
  writes: number;
  repoWrites: number;
  published: number;
  calls: number;
  tasks: number;
}

function effects(): Effects {
  return {
    writes: t.db.writes().length,
    repoWrites: t.repo.writes().length,
    published: t.publisher.published.length + t.publisher.raw.length,
    calls: t.client.requests.length,
    tasks: t.taskPort.tasks.size,
  };
}

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Headers> }>();

// User tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

function credentialsOf(subject: RoleSubject): Promise<Headers> {
  const hit = credentialCache.get(subject.name);
  if (hit !== undefined && Date.now() - hit.mintedAt < CREDENTIAL_REUSE_MS) return hit.headers;
  const headers = headersFor(subject);
  credentialCache.set(subject.name, { mintedAt: Date.now(), headers });
  return headers;
}

function subjectNamed(name: string): RoleSubject {
  const found = SUBJECTS.find((subject) => subject.name === name);
  if (found === undefined) throw new TypeError(`No subject named ${name}`);
  return found;
}

function rowAt(key: string): Row {
  const row = EXPECTED[key];
  if (row === undefined) throw new TypeError(`No expected row ${key}`);
  return row;
}

function inject(probe: Probe, credentials: Headers, url: string = probe.url): Promise<InjectResponse> {
  const { method, payload, headers } = probe;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

/** A user token of `claims` presented beside the gateway's invocation credential. */
async function userCredentials(claims: Parameters<typeof mintUserToken>[0]): Promise<Headers> {
  const [userToken, gatewayToken] = await Promise.all([mintUserToken(claims), mintServiceToken({ caller: 'gateway', audience: SERVICE_NAME })]);
  return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${gatewayToken}` };
}

/** Workload `caller` relaying a tenant-a user token of session `sid`. */
async function relayedCredentials(caller: string, sid: string, sub: string = USER_ID): Promise<Headers> {
  const [userToken, invocation] = await Promise.all([
    mintUserToken({ sub, sid, site: SITE_A, roles: [Roles.systemUser] }),
    mintServiceToken({ caller, audience: SERVICE_NAME }),
  ]);
  return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
}

/** How a response departs from `denial` rendered for `url` with no effect beyond `before`; empty when it matches. */
function denialMismatch(res: InjectResponse, denial: AuthDenial, url: string, before: Effects): Record<string, unknown> {
  const owed = denialResponse(denial, url);
  const actual = { status: res.statusCode, body: res.body, challenge: res.headers['www-authenticate'], effects: effects() };
  const wanted = { status: owed.status, body: owed.body, challenge: owed.headers['WWW-Authenticate'], effects: before };
  return isDeepStrictEqual(actual, wanted) ? {} : { actual, wanted };
}

/** How one route × subject cell departs from its expected outcome; undefined when it matches. */
async function cellMismatch(key: string, row: Row, subject: RoleSubject): Promise<string | undefined> {
  const record = RECORDS[subject.name];
  if (record === undefined) return `${key} · ${subject.name} · no subject record`;
  const expected = expectedOutcome(row, record);
  const url = urlFor(row.probe, record);
  const credentials = await credentialsOf(subject);
  const before = effects();
  const res = await inject(row.probe, credentials, url);
  const at = `${key} · ${subject.name} · expected ${labelOf(expected)} · got ${res.statusCode}`;
  if (expected === ADMITTED) {
    const refused = res.statusCode === 401 || res.statusCode === 403 || res.statusCode >= 500;
    return refused ? `${at} ${res.body.slice(0, 200)}` : undefined;
  }
  const mismatch = denialMismatch(res, expected, url, before);
  if (Object.keys(mismatch).length === 0) return undefined;
  const owed = denialResponse(expected, url);
  return `${at} ${res.body.slice(0, 200)} · owed ${owed.status} ${owed.body.slice(0, 200)} · effects ${JSON.stringify({ before, after: effects() })}`;
}

function keyOf(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

/** A registered route's declaration in comparable form. */
function declarationOf(route: RouteMatrixEntry): Record<string, unknown> {
  return {
    transport: route.transport,
    allow: route.public === true ? 'public' : [...(route.requires ?? [])].sort(),
    siteCheck: route.siteCheck,
    ...(route.edge === true ? { edge: true } : {}),
  };
}

function declaredBy(row: Row): Record<string, unknown> {
  return { transport: row.transport, allow: row.allow === 'public' ? 'public' : [...row.allow].sort(), siteCheck: row.siteCheck === undefined };
}

const rolesClaim = (claims: Record<string, unknown> | undefined): string[] =>
  Array.isArray(claims?.roles) ? claims.roles.filter((role): role is string => typeof role === 'string') : [];

/** The record `headers` amount to, read back from the tokens they carry; headerless service subjects are the push invoker. */
function observedRecord(subject: RoleSubject, headers: Headers): SubjectRecord {
  const bearer = headers.authorization?.replace(/^Bearer /, '');
  const invocation = headers[INVOCATION_HEADER]?.replace(/^Bearer /, '');
  const service = invocation === undefined ? undefined : decodeJwt(invocation);
  if (bearer !== undefined && service !== undefined) {
    const user = decodeJwt(bearer);
    return { credential: 'user', roles: [...rolesClaim(user), ...rolesClaim(service)].sort(), site: String(user.site), tid: String(user.tid) };
  }
  if (service !== undefined) return { credential: 'invocation', roles: rolesClaim(service).sort() };
  if (bearer !== undefined) return { credential: decodeJwt(bearer).sub === TASKS_INVOKER_ROLE ? 'tasks-token' : 'none', roles: [TASKS_INVOKER_ROLE] };
  return subject.kind === 'service' ? { credential: 'push-key', roles: [PUBSUB_INVOKER_ROLE] } : { credential: 'none', roles: [] };
}

beforeAll(async () => {
  t = await buildTestApp();
  t.db.respond(/FROM "?identity"?\."?tenant_registry"?\b/, registryAnswer);
  t.db.respond(/FROM "?identity"?\."?session"?\s/, (_sql, values) =>
    values.includes(ANONYMOUS_SESSION.session_id) && values.includes(ANONYMOUS_SESSION.tenant_id) ? [{ ...ANONYMOUS_SESSION }] : [],
  );
  t.db.respond(/FROM "?identity"?\."?group_account"?\s/, (_sql, values) =>
    values.includes(STORED_GROUP.tenant_id) && JSON.stringify(values).includes(STORED_GROUP.userid) ? [{ ...STORED_GROUP }] : [],
  );
  await t.app.ready();
  matrix = collectRouteMatrix(t.app);
});

afterAll(async () => {
  await t?.app.close();
});

describe('route table', () => {
  it('expected table covers exactly the routes collectRouteMatrix returns', () => {
    const registered = matrix.routes.map(keyOf);
    const listed = Object.keys(EXPECTED);
    expect({
      missing: registered.filter((key) => !listed.includes(key)),
      extra: listed.filter((key) => !registered.includes(key)),
      duplicated: registered.filter((key, index) => registered.indexOf(key) !== index),
    }).toEqual({ missing: [], extra: [], duplicated: [] });
  });

  it("declares each route with the table's transport, roles and site check", () => {
    const actual = Object.fromEntries(matrix.routes.map((route) => [keyOf(route), declarationOf(route)]));
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([key, row]) => [key, declaredBy(row)]));
    expect(actual).toEqual(expected);
  });
});

describe('subjects', () => {
  it('probes the user archetypes, every synthetic role and the workloads of the platform subject set', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    expect(names).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS, ...SYNTHETIC, ...REQUIRED_WORKLOADS]));
    const presented = new Set(SUBJECTS.flatMap((subject) => RECORDS[subject.name]?.roles ?? []));
    expect(['platform.migration', 'platform.operator'].filter((role) => !presented.has(role))).toEqual([]);
  });

  it('presents every role a route requires through some subject', () => {
    const presented = new Set(SUBJECTS.flatMap((subject) => RECORDS[subject.name]?.roles ?? []));
    const required = [...new Set(matrix.routes.flatMap((route) => route.requires ?? []))];
    expect(required.filter((role) => !presented.has(role))).toEqual([]);
  });

  it('models each subject with the credentials headersFor presents', async () => {
    const observed: Record<string, SubjectRecord> = {};
    const modelled: Record<string, SubjectRecord> = {};
    for (const subject of SUBJECTS) {
      observed[subject.name] = observedRecord(subject, await credentialsOf(subject));
      const record = RECORDS[subject.name];
      if (record !== undefined) modelled[subject.name] = { ...record, roles: [...record.roles].sort() };
    }
    expect(observed).toEqual(modelled);
  });
});

const mismatches: string[] = [];
let cellsRun = 0;

describe.each(Object.entries(EXPECTED))('%s', (key, row) => {
  const cells = SUBJECTS.map((subject) => {
    const record = RECORDS[subject.name];
    return { subject, title: `${key} · ${subject.name} · ${record === undefined ? 'unmodelled' : labelOf(expectedOutcome(row, record))}` };
  });

  it.each(cells)('$title', async ({ subject }) => {
    cellsRun += 1;
    const mismatch = await cellMismatch(key, row, subject);
    if (mismatch !== undefined) mismatches.push(mismatch);
    expect(mismatch).toBeUndefined();
  });
});

describe('route admission', () => {
  it('runs every route × subject cell with zero unexpected allows and zero unexpected denies', () => {
    expect(cellsRun).toBe(Object.keys(EXPECTED).length * SUBJECTS.length);
    expect(mismatches).toEqual([]);
  });
});

describe('cUsers before() gate (cusers.cfc:90-124)', () => {
  it.each(['GET /v1/groups', 'POST /v1/groups'])(
    'refuses a lone Users grant on %s in the legacy envelope, and admits the Users and Site Manager grants, site admins and S2',
    async (key) => {
      const row = rowAt(key);
      const before = effects();
      const refused = await inject(row.probe, await credentialsOf(MODULE_ONLY));
      expect(denialMismatch(refused, AuthDenial.forbidden(), row.probe.url, before)).toEqual({});

      const statuses: number[] = [];
      for (const subject of [MODULE_AND_SITE_MANAGER, subjectNamed('site-admin'), subjectNamed('s2')]) {
        statuses.push((await inject(row.probe, await credentialsOf(subject))).statusCode);
      }
      expect(statuses.filter((status) => status === 401 || status === 403)).toEqual([]);
    },
  );
});

describe('anonymous group.save on the JSON API (jsonApiUtility.cfc:1903-2035)', () => {
  const anonymous = (): Promise<Headers> => userCredentials({ sub: '', sid: ANONYMOUS_SESSION.session_id, site: SITE_A, roles: [] });
  const envelope = (type: keyof typeof LEGACY_ERROR_MAP): Record<string, unknown> => {
    const { message, code } = LEGACY_ERROR_MAP[type];
    return { apiversion: 'v1', method: 'save', error: { message, code } };
  };
  const tablesWrittenSince = (from: number): string[] => t.db.writes().slice(from).map((write) => write.table);

  // A new group keeps the bean type 2 once a non-admin's type is stripped, which identity refuses as EX-GROUP-USER-RECORD;
  // a stored Type=1 group reaches allowAction, which legacy denies anonymous callers (bean.cfc:1353-1355).
  it('answers a stored group save carrying a valid CSRF token with 401 authorization, consuming the token and writing no group', async () => {
    const csrf = generateCsrfToken({ context: STORED_GROUP.userid, secret: ANONYMOUS_SESSION.csrf_secret, now: t.clock.now() });
    const before = effects();
    const res = await t.app.inject({
      method: 'POST',
      url: `/_api/json/v1/${SITE_A}/group/${STORED_GROUP.userid}`,
      headers: { ...(await anonymous()), ...FORM, [CSRF_HEADER_TOKEN]: csrf.token, [CSRF_HEADER_EXPIRES]: csrf.expires },
      payload: 'groupname=Mine',
    });
    expect([res.statusCode, res.json()]).toEqual([401, envelope('authorization')]);
    expect(tablesWrittenSince(before.writes).filter((table) => table !== 'identity.csrf_claim' && table !== 'identity.changelog')).toEqual([]);
    expect([t.repo.writes().length, t.publisher.published.length + t.publisher.raw.length]).toEqual([before.repoWrites, before.published]);
  });

  it('answers a JSON-mode save without CSRF tokens with 400 invalidTokens before authorization, with no effect', async () => {
    const before = effects();
    const res = await t.app.inject({ method: 'POST', url: `/_api/json/v1/${SITE_A}/group/`, headers: { ...(await anonymous()), ...FORM }, payload: 'groupname=Mine' });
    expect([res.statusCode, res.json(), effects()]).toEqual([400, envelope('invalidTokens'), before]);
  });

  it('answers a REST save without credentials with the Basic challenge, with no effect', async () => {
    const before = effects();
    const res = await t.app.inject({ method: 'POST', url: `/_api/rest/v1/${SITE_A}/group/`, headers: FORM, payload: 'groupname=Mine' });
    const owed = legacyErrorResponse('authorization', { method: 'Not Available', wwwAuthenticate: WWW_AUTHENTICATE.basic });
    expect([res.statusCode, res.body, res.headers['www-authenticate'], effects()]).toEqual([401, owed.body, WWW_AUTHENTICATE.basic, before]);
  });
});

describe("site check compares the token's site, never its tenant", () => {
  const routes = ['GET /v1/groups', 'GET /_api/json/v1*'] as const;
  const s2Roles = [Roles.systemUser, Roles.s2];

  it.each(routes)('refuses a tenant-b site token carrying the tenant-a tenant on %s, with no effect', async (key) => {
    const { probe } = rowAt(key);
    const credentials = await userCredentials({ sub: 'test-site-check', site: SITE_B, tid: TENANT_A.tenantId, roles: s2Roles });
    const before = effects();
    expect(denialMismatch(await inject(probe, credentials), AuthDenial.siteMismatch(), probe.url, before)).toEqual({});
  });

  it.each(routes)('admits a tenant-a site token carrying the tenant-b tenant on %s past the site check', async (key) => {
    const { probe } = rowAt(key);
    const credentials = await userCredentials({ sub: 'test-site-check', site: SITE_A, tid: TENANT_B.tenantId, roles: s2Roles });
    expect([401, 403]).not.toContain((await inject(probe, credentials)).statusCode);
  });
});

describe('transport separation', () => {
  const MANAGED_ROUTES = [
    'POST /internal/v1/events/identity.programs-sites.site.changed.v1',
    'POST /internal/v1/events/identity.people.person.changed.v1',
    'POST /internal/v1/outbox/sweep',
  ] as const;
  const refusal = AuthDenial.unauthenticated('wrong-scheme');

  it.each(MANAGED_ROUTES)('refuses a user token with the gateway invocation credential on %s, with no inbox write, sweep or successor task', async (key) => {
    const { probe } = rowAt(key);
    const before = effects();
    expect(denialMismatch(await inject(probe, await credentialsOf(subjectNamed('s2'))), refusal, probe.url, before)).toEqual({});
  });

  it.each(['POST /internal/v1/tokens', 'GET /v1/groups'])('refuses the tasks-invoker token and the push key on the service route %s', async (key) => {
    const { probe } = rowAt(key);
    const tasks = { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE_NAME })}` };
    for (const [credentials, url] of [
      [tasks, probe.url],
      [{}, withQuery(probe.url, pushKeyQuery())],
    ] as const) {
      const before = effects();
      expect({ url, ...denialMismatch(await inject(probe, credentials, url), refusal, url, before) }).toEqual({ url });
    }
  });

  it('refuses the tasks-invoker token on the push routes and the push key on the sweep route', async () => {
    const tasks = { authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE_NAME })}` };
    const problems: Record<string, unknown>[] = [];
    for (const key of MANAGED_ROUTES) {
      const { probe } = rowAt(key);
      const [credentials, url] = key.endsWith('/sweep') ? [{}, withQuery(probe.url, pushKeyQuery())] : [tasks, probe.url];
      const before = effects();
      const mismatch = denialMismatch(await inject(probe, credentials, url), refusal, url, before);
      if (Object.keys(mismatch).length > 0) problems.push({ key, ...mismatch });
    }
    expect(problems).toEqual([]);
  });

  it('refuses every role-declared internal service route called with its workload credential outside X-Serverless-Authorization', async () => {
    const problems: Record<string, unknown>[] = [];
    const internal = Object.entries(EXPECTED).filter(([key, row]) => row.transport === 'service' && row.allow !== 'public' && key.includes(' /internal/v1/'));
    expect(internal.length).toBeGreaterThan(0);
    for (const [key, row] of internal) {
      const workload = SUBJECTS.find((subject) => {
        const record = RECORDS[subject.name];
        return record?.credential === 'invocation' && row.allow !== 'public' && row.allow.some((role) => record.roles.includes(role));
      });
      if (workload === undefined) throw new TypeError(`No workload admitted on ${key}`);
      const { [INVOCATION_HEADER]: invocation = '', ...rest } = await credentialsOf(workload);
      for (const credentials of [rest, { ...rest, authorization: invocation }]) {
        const before = effects();
        const mismatch = denialMismatch(await inject(row.probe, credentials), AuthDenial.unauthenticated('missing-credential'), row.probe.url, before);
        if (Object.keys(mismatch).length > 0) problems.push({ key, moved: 'authorization' in credentials, ...mismatch });
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('user and invocation credentials', () => {
  const routes: readonly Probe[] = [rowAt('GET /v1/sessions/current').probe, rowAt('GET /v1/oauth-clients').probe];

  it.each([
    ['of another issuer', { iss: 'https://securetoken.google.com/opt2' }, AuthDenial.invalidToken()],
    ['for another audience', { aud: 'opt2-cloud' }, AuthDenial.invalidToken()],
    ['that expired', { iat: 1_700_000_000, exp: 1_700_000_300 }, AuthDenial.expiredToken()],
  ])('refuses a user token %s with the bearer challenge on public and role-declared routes alike', async (_label, claims, denial) => {
    const credentials = await userCredentials({ sub: 'test-foreign', site: SITE_A, roles: [Roles.systemUser, Roles.s2], ...claims });
    for (const probe of routes) {
      const before = effects();
      expect({ url: probe.url, ...denialMismatch(await inject(probe, credentials), denial, probe.url, before) }).toEqual({ url: probe.url });
    }
  });

  it('refuses an invocation credential addressed to another callee', async () => {
    const { probe } = rowAt('POST /internal/v1/tokens');
    const credentials = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'people' })}` };
    const before = effects();
    expect(denialMismatch(await inject(probe, credentials), AuthDenial.unauthenticated('invalid-credential'), probe.url, before)).toEqual({});
  });

  it('refuses Basic credentials, which the gateway exchanges and never forwards', async () => {
    const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE_NAME })}`;
    const credentials = { authorization: 'Basic YXV0aHo6YXV0aHo=', [INVOCATION_HEADER]: gateway };
    for (const probe of [...routes, rowAt('GET /_api/json/v1*').probe]) {
      const before = effects();
      expect({ url: probe.url, ...denialMismatch(await inject(probe, credentials), AuthDenial.unauthenticated('wrong-scheme'), probe.url, before) }).toEqual({
        url: probe.url,
      });
    }
  });

  it('names the local issuer and audience the matrix tokens carry', async () => {
    const { authorization = '' } = await credentialsOf(subjectNamed('s2'));
    const claims = decodeJwt(authorization.replace(/^Bearer /, ''));
    expect([claims.iss, claims.aud]).toEqual([LOCAL_USER_TOKEN.issuer, LOCAL_USER_TOKEN.audience]);
  });
});

describe('session boundaries', () => {
  const RELAYED_SESSION = 'S-authz-relayed';
  const OTHER_SESSION = 'S-authz-other';

  it.each(CONSUME_CALLERS.filter((role) => role !== GATEWAY_ROLE))(
    'refuses %s consuming a token for a session other than the relayed one, with no effect',
    async (role) => {
      const credentials = await relayedCredentials(role.slice('service:'.length), RELAYED_SESSION);
      const probe: Probe = {
        method: 'POST',
        url: '/internal/v1/csrf/consume',
        payload: { sessionId: OTHER_SESSION, token: 'T-authz', expires: '260630150000123', context: 'authz' },
      };
      const before = effects();
      expect(denialMismatch(await inject(probe, credentials), AuthDenial.forbidden(), probe.url, before)).toEqual({});
    },
  );

  it("refuses a roster commit carrying session effects for another session of the user, with no effect", async () => {
    const credentials = await relayedCredentials('people', RELAYED_SESSION);
    const probe: Probe = { method: 'POST', url: operationUrl('commit'), payload: { sessionEffects: { reloginSessionId: OTHER_SESSION } } };
    const before = effects();
    expect(denialMismatch(await inject(probe, credentials), AuthDenial.forbidden(), probe.url, before)).toEqual({});
  });
});

describe('unknown routes fail closed', () => {
  const UNKNOWN: readonly Probe[] = [
    { method: 'GET', url: '/v1/nosuch' },
    { method: 'POST', url: '/internal/v1/nosuch', payload: {} },
    { method: 'GET', url: '/internal/v1/accounts' },
    { method: 'POST', url: '/internal/v1/events/identity.nosuch.topic.v1', payload: {} },
    { method: 'POST', url: '/internal/v1/tasks/nosuch', payload: {} },
    { method: 'POST', url: '/internal/v1/jobs/nosuch', payload: {} },
    { method: 'DELETE', url: `/v1/groups/${GROUP_ID}` },
    { method: 'PUT', url: '/internal/v1/csrf/consume', payload: {} },
    { method: 'GET', url: '/internal/v1/tokens' },
    { method: 'POST', url: '/v1/sessions/current' },
  ];

  it.each(['anonymous', 's2', 'service:gateway', 'service:migration', 'service:people', 'service:pubsub-invoker'])(
    'answers %s on every undeclared route or method with the legacy 404, with no effect',
    async (name) => {
      const subject = subjectNamed(name);
      const record = RECORDS[name];
      if (record === undefined) throw new TypeError(`No subject record ${name}`);
      const problems: string[] = [];
      for (const probe of UNKNOWN) {
        const before = effects();
        const res = await inject(probe, await credentialsOf(subject), urlFor(probe, record));
        const body = res.json<{ error?: { code?: unknown; message?: unknown } }>();
        const envelope = typeof body.error?.code === 'string' && typeof body.error.message === 'string';
        if (res.statusCode !== 404 || !envelope || !isDeepStrictEqual(effects(), before)) problems.push(`${probe.method} ${probe.url}: ${res.statusCode}`);
      }
      expect(problems).toEqual([]);
    },
  );

  it('exposes no HEAD route beside the GET routes', async () => {
    const statuses: number[] = [];
    for (const url of ['/v1/sessions/current', '/healthz', '/.well-known/jwks.json']) statuses.push((await t.app.inject({ method: 'HEAD', url })).statusCode);
    expect(statuses).toEqual([404, 404, 404]);
  });
});

describe('deny by default at start-up', () => {
  it.each<[string, (app: TestApp['app']) => void]>([
    ['a route without config.opt2', (app) => app.get('/opt2-undeclared-probe', async () => ({}))],
    ['a route declaring neither requires nor public', (app) => app.get('/opt2-undeclared-probe', { config: { opt2: { transport: 'service' } } }, async () => ({}))],
    ['a route declaring both roles and public', (app) => app.get('/opt2-both-probe', { config: { opt2: { requires: ['s2'], public: true } } }, async () => ({}))],
    ['an empty role list', (app) => app.get('/opt2-empty-probe', { config: { opt2: { requires: [] } } }, async () => ({}))],
    [
      'a push route on the service transport',
      (app) => app.post('/internal/v1/events/identity.opt2-probe', { config: { opt2: { transport: 'service', requires: [PUBSUB_INVOKER_ROLE] } } }, async () => ({})),
    ],
    ['a public task route', (app) => app.post('/internal/v1/tasks/opt2-probe', { config: { opt2: { transport: 'cloud-tasks', public: true } } }, async () => ({}))],
  ])('fails start-up of the composed identity service for %s', async (_label, register) => {
    const built = await buildTestApp();
    try {
      built.app.register(async (child) => {
        register(child);
      });
      await expect(built.app.ready()).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await built.app.close();
    }
  });
});
