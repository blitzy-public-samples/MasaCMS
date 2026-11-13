/** In-process authorisation matrix of every identity route: admitted subjects, CSRF arbitration callers, transport, session and tenant boundaries, and deny by default. */
import { isDeepStrictEqual } from 'node:util';
import { generateKeyPair, SignJWT, decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  INVOCATION_HEADER,
  LOCAL_USER_TOKEN,
  Roles,
  UndeclaredRouteError,
  collectRouteMatrix,
  type RouteMatrix,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import {
  ROLE_SET,
  SERVICE_CALLERS,
  TENANT_A,
  TEST_PUSH_KEY,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  type InjectResponse,
  type RoleSubject,
} from '@opt2/platform/testing';
import { EDITOR, SITE_ADMIN_A, sessionRow } from '../helpers/rows.js';
import {
  SITE_A,
  SUBJECTS,
  SUBJECT_SESSIONS,
  buildIdentityApp,
  cfId,
  credentialsFor,
  csrfFor,
  defaultSeed,
  relayedCredentials,
  subjectNamed,
  type Effects,
  type IdentityTestApp,
  type SubjectSession,
} from '../helpers/service.js';

type Headers = Record<string, string>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One concrete tenant-a request. */
interface ProbeRequest {
  method: Method;
  url: string;
  payload?: string | Record<string, unknown>;
  headers?: Headers;
}

/** A refusal the handler answers after its own checks rather than the auth hooks. */
interface HandlerDenial {
  status: 401 | 403;
}

/** Subjects whose call raises legacy's unhandled exception before any access check, and the `method` its 500 envelope reports. */
interface Raised {
  subjects: readonly string[];
  method: string;
}

interface Probe {
  title: string;
  /** The request, or the request a subject sends, where its body names the subject's own session or ids. */
  request: ProbeRequest | ((subject: RoleSubject) => ProbeRequest);
  /** Subjects admitted: any status but 401, 403 and the unhandled-exception 500. */
  allow: readonly string[];
  /** Handler-level denials by subject; every other denial must come from the auth hooks, before any statement. */
  denyCheck?: Readonly<Record<string, HandlerDenial>>;
  /** Subjects answered with legacy's unhandled-exception 500, which may read but leaves no other effect. */
  raises?: Raised;
  /** Credentials a subject presents instead of its own, e.g. a workload relaying a user token. */
  credentials?: (subject: RoleSubject) => Promise<Headers>;
}

interface Declared {
  transport: Transport;
  requires?: readonly string[];
  public?: true;
  siteCheck?: false;
}

interface Expected {
  declared: Declared;
  probes: readonly Probe[];
}

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

/** User subjects whose token holds `system-user`: every user but the public-pool member. */
const SYSTEM_USERS = ['system-user', 'editor', 'site-admin', 's2', 'other-tenant', ...SYNTHETIC, 'users-module', 'users-and-site-manager'] as const;

const USERS = ['member', ...SYSTEM_USERS] as const;

const MANAGED = ['service:pubsub-invoker', 'service:tasks-invoker'] as const;

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
  ...MANAGED,
] as const;

const EVERYONE: readonly string[] = ['anonymous', ...USERS, ...WORKLOADS];

/** User subjects every route is probed with besides the synthetic and service roles listed above. */
const MINIMUM_SUBJECTS = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'] as const;

/** The callers `consumeCsrfToken` admits: the five original callers, then the five synthetic services with fixture CSRF hooks. */
const CONSUME_CALLERS = [
  'people',
  'programs-sites',
  'strategies-content',
  'identity',
  'gateway',
  'communications',
  'finance',
  'reporting',
  'surveys',
  'timesheets',
] as const;

function everyoneBut(...excluded: string[]): string[] {
  return EVERYONE.filter((name) => !excluded.includes(name));
}

function denials(names: readonly string[], denial: HandlerDenial): Record<string, HandlerDenial> {
  return Object.fromEntries(names.map((name) => [name, denial]));
}

/** Workloads that present no user token: their call reaches a handler that needs one only on a public route. */
const USERLESS = ['anonymous', ...WORKLOADS.filter((name) => name !== 'service:tasks-invoker')];

/** Public on the service transport: a managed tasks token is still verified, and refused, as a user token. */
const PUBLIC_ADMITTED = everyoneBut('service:tasks-invoker');

/** Every user arrives with the gateway's invocation credential, so a gateway-only route admits them beside the gateway. */
const THROUGH_GATEWAY = [...USERS, 'service:gateway'];

const UNAUTHENTICATED: HandlerDenial = { status: 401 };
const FORBIDDEN: HandlerDenial = { status: 403 };

const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const EDITOR_GROUP = EDITOR.groups[0]?.userid ?? '';
const ADMIN_GROUP = SITE_ADMIN_A.groups[0]?.userid ?? '';
const USERS_MODULE = '00000000000000000000000000000000008';
const HOME = '00000000000000000000000000000000001';
const MATRIX_CLIENT = cfId('C', 701);
const MATRIX_USER = cfId('E', 701);
const UNKNOWN_OPERATION = cfId('F', 799);
const ENDED_SESSION = 'S-authz-ended';
const LOGOUT_SESSION = 'S-authz-logout';
const CLAIM_SESSION = 'S-authz-claim';

const ENDED_ROW = sessionRow({
  tenant_id: EDITOR.tenant.tenantId,
  session_id: ENDED_SESSION,
  user_id: EDITOR.account.userid,
  state: 'ended',
  csrf_secret: cfId('6', 701),
});

let t: IdentityTestApp;
let matrix: RouteMatrix;

const credentialCache = new Map<string, { mintedAt: number; headers: Promise<Headers> }>();

// User tokens live 300 s; re-minting after 120 s keeps a slow run from presenting an expired one.
const CREDENTIAL_REUSE_MS = 120_000;

/** `factory()` under `key`, reused while fresh. */
function cached(key: string, factory: () => Promise<Headers>): Promise<Headers> {
  const hit = credentialCache.get(key);
  if (hit !== undefined && Date.now() - hit.mintedAt < CREDENTIAL_REUSE_MS) return hit.headers;
  const headers = factory();
  credentialCache.set(key, { mintedAt: Date.now(), headers });
  return headers;
}

function presented(subject: RoleSubject): Promise<Headers> {
  return cached(subject.name, () => credentialsFor(subject));
}

function session(name: string): SubjectSession {
  const found = SUBJECT_SESSIONS[name];
  if (found === undefined) throw new TypeError(`No subject session ${name}`);
  return found;
}

function isManaged(subject: RoleSubject): boolean {
  return (MANAGED as readonly string[]).includes(subject.name);
}

/** A user subject's own credentials; a workload's invocation credential relaying the token of subject `relayed`'s session. */
function relaying(relayed: string): (subject: RoleSubject) => Promise<Headers> {
  return (subject) => {
    if (subject.kind !== 'service' || isManaged(subject) || subject.caller === undefined) return presented(subject);
    const caller = subject.caller;
    return cached(`${caller}>${relayed}`, () => relayedCredentials(caller, session(relayed), subjectNamed(relayed).roles));
  };
}

/** The session a subject's call acts in: its own as a user, `fallback`'s as a relaying workload. */
function actingSession(subject: RoleSubject, fallback: string): SubjectSession {
  return SUBJECT_SESSIONS[subject.name] ?? session(fallback);
}

/** The X-csrf_token headers of the token the subject's session issues for `context`; none without a session. */
function csrfHeaders(subject: RoleSubject, context: string, laterMs = 0): Headers {
  const own = SUBJECT_SESSIONS[subject.name];
  if (own === undefined) return {};
  const { token, expires } = csrfFor(own, context, laterMs);
  return { [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: expires };
}

/** A stable per-subject number, so per-subject ids never collide. */
function indexOf(subject: RoleSubject): number {
  return SUBJECTS.indexOf(subject) + 1;
}

function probe(title: string, request: Probe['request'], allow: readonly string[], extra: Partial<Probe> = {}): Probe {
  return { title, request, allow, ...extra };
}

const S2_ADMIN_OR_USERS: Declared = { transport: 'service', requires: ['s2', 'site-admin', 'm:008'] };
const S2_OR_SITE_ADMIN: Declared = { transport: 'service', requires: ['s2', 'site-admin'] };
const S2_ONLY: Declared = { transport: 'service', requires: ['s2'] };
const GATEWAY_ONLY: Declared = { transport: 'service', requires: ['service:gateway'] };
const PEOPLE_ONLY: Declared = { transport: 'service', requires: ['service:people'] };
const PUBLIC: Declared = { transport: 'service', public: true };
const JSON_API: Declared = { transport: 'service', public: true, siteCheck: false };

/** cUsers gate: the hooks admit S2, site admins and the Users grant; the handler also wants Site Manager beside a lone Users grant. */
const CUSERS_ADMITTED = ['s2', 'site-admin', 'other-tenant', 'users-and-site-manager'];
const CUSERS_DENIALS = { 'users-module': FORBIDDEN };

/** A cUsers route probe; other-tenant administers its own tenant, since no request names a site. */
function cusersRoute(request: Probe['request']): Expected {
  return { declared: S2_ADMIN_OR_USERS, probes: [probe('cUsers', request, CUSERS_ADMITTED, { denyCheck: CUSERS_DENIALS })] };
}

function gatewayRoute(request: Probe['request'], allow: readonly string[] = THROUGH_GATEWAY): Expected {
  return { declared: GATEWAY_ONLY, probes: [probe('gateway', request, allow)] };
}

/** A roster or account-read route: people relays the s2 user's tenant-a token; everyone else presents its own credentials. */
function peopleRoute(request: ProbeRequest, declared: Declared = PEOPLE_ONLY): Expected {
  return { declared, probes: [probe('people', request, ['service:people'], { credentials: relaying('s2') })] };
}

/** A public route whose handler needs a user token relayed with an invocation credential. */
function relayedUserRoute(request: Probe['request'], declared: Declared = PUBLIC): Expected {
  return { declared, probes: [probe('relayed user', request, USERS, { denyCheck: denials(USERLESS, UNAUTHENTICATED) })] };
}

const INSUFFICIENT = denials(['anonymous', 'member', 'system-user', 'editor', ...SYNTHETIC, ...WORKLOADS.filter((name) => name !== 'service:tasks-invoker')], UNAUTHENTICATED);

/** Users whose tenant-a token reaches a REST method; another site's token is refused first. */
const REST_CALLERS = USERS.filter((name) => name !== 'other-tenant');

/** A REST call without an exchanged user token gets the Basic challenge, and a token of another site the site check. */
const REST_DENIALS = { ...denials(USERLESS, UNAUTHENTICATED), 'other-tenant': FORBIDDEN };

/** The JSON API route of `family` and `method` behind `prefix`: a public read, and a read that needs the Users module. */
function jsonApiRoute(family: 'json' | 'ajax' | 'rest', method: Method, prefix: '' | '/index.cfm'): Expected {
  const base = `${prefix}/_api/${family}/v1/${SITE_A}`;
  const properties: ProbeRequest = { method, url: `${base}/group/properties` };
  const findAll: ProbeRequest = { method, url: `${base}?method=findAll&entityname=group` };
  if (family === 'rest') {
    // REST is sessionless, so the event of the registered site raises before either read checks access.
    return {
      declared: JSON_API,
      probes: [
        probe(`${method} ${family} findProperties`, properties, [], { denyCheck: REST_DENIALS, raises: { subjects: REST_CALLERS, method: 'findProperties' } }),
        probe(`${method} ${family} group.findAll`, findAll, [], { denyCheck: REST_DENIALS, raises: { subjects: REST_CALLERS, method: 'findAll' } }),
      ],
    };
  }
  const publicRead = probe(`${method} ${family} findProperties`, properties, everyoneBut('other-tenant', 'service:tasks-invoker'), {
    denyCheck: { 'other-tenant': FORBIDDEN },
  });
  const usersRead = probe(`${method} ${family} group.findAll`, findAll, ['s2', 'site-admin', 'users-module', 'users-and-site-manager'], {
    denyCheck: { ...INSUFFICIENT, 'other-tenant': FORBIDDEN },
  });
  return { declared: JSON_API, probes: [publicRead, usersRead] };
}

const PREPARE_ACCOUNT = { UserName: 'authz_matrix_user', Password: 'Authz12345', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 };
const operationUrl = (action?: string): string =>
  `/internal/v1/accounts/${MATRIX_USER}/operations/${UNKNOWN_OPERATION}${action === undefined ? '' : `:${action}`}`;

/** Every registered route, keyed `<METHOD> <fastify url>`, with its declaration and tenant-a probes. */
const EXPECTED: Readonly<Record<string, Expected>> = {
  ...Object.fromEntries(
    (['', '/index.cfm'] as const).flatMap((prefix) =>
      (['ajax', 'json', 'rest'] as const).flatMap((family) =>
        (['DELETE', 'GET', 'POST', 'PUT'] as const).map((method) => [`${method} ${prefix}/_api/${family}/v1*`, jsonApiRoute(family, method, prefix)]),
      ),
    ),
  ),
  'GET /.well-known/jwks.json': { declared: PUBLIC, probes: [probe('jwks', { method: 'GET', url: '/.well-known/jwks.json' }, PUBLIC_ADMITTED)] },
  'GET /healthz': { declared: PUBLIC, probes: [probe('healthz', { method: 'GET', url: '/healthz' }, PUBLIC_ADMITTED)] },
  'POST /internal/v1/accounts::lookup': peopleRoute({ method: 'POST', url: '/internal/v1/accounts:lookup', payload: { userIds: [EDITOR.account.userid] } }),
  // The relayed token carries the s2 claim the all-sites reads require.
  'POST /internal/v1/accounts::lookup-all-sites': peopleRoute({ method: 'POST', url: '/internal/v1/accounts:lookup-all-sites', payload: { userIds: [EDITOR.account.userid] } }),
  'POST /internal/v1/accounts::count': peopleRoute({ method: 'POST', url: '/internal/v1/accounts:count', payload: { scope: 'pool', publicPool: true } }),
  'POST /internal/v1/accounts::username-candidates': peopleRoute({
    method: 'POST',
    url: '/internal/v1/accounts:username-candidates',
    payload: { publicPool: false, pattern: 'qa%', limit: 10 },
  }),
  'POST /internal/v1/accounts::memberships': peopleRoute({ method: 'POST', url: '/internal/v1/accounts:memberships', payload: { userIds: [EDITOR.account.userid] } }),
  'GET /internal/v1/accounts/:userId': peopleRoute({ method: 'GET', url: `/internal/v1/accounts/${EDITOR.account.userid}` }),
  'POST /internal/v1/accounts/:userId/login-block': peopleRoute({
    method: 'POST',
    url: `/internal/v1/accounts/${EDITOR.account.userid}/login-block`,
    payload: { removeBlock: false },
  }),
  'GET /internal/v1/accounts/:userId/operations/:operationId': peopleRoute({ method: 'GET', url: operationUrl() }),
  // An unknown operation answers 409 after authorisation, so every admitted step is visible without a stored operation.
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::abort': peopleRoute({ method: 'POST', url: operationUrl('abort') }),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::commit': peopleRoute({ method: 'POST', url: operationUrl('commit') }),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::finish': peopleRoute({ method: 'POST', url: operationUrl('finish') }),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::prepare': peopleRoute(
    { method: 'POST', url: operationUrl('prepare'), payload: { kind: 'create', siteId: SITE_A, account: PREPARE_ACCOUNT, groupIds: [] } },
    { ...PEOPLE_ONLY, siteCheck: false },
  ),
  'POST /internal/v1/accounts/:userId/operations/:operationId(.+)::revert': peopleRoute({ method: 'POST', url: operationUrl('revert') }),
  'POST /internal/v1/authenticate': gatewayRoute({
    method: 'POST',
    url: '/internal/v1/authenticate',
    payload: { method: 'GET', path: `/_api/rest/v1/${SITE_A}/group`, headers: {}, query: {} },
  }),
  'POST /internal/v1/csrf/claims': gatewayRoute((subject) => ({
    method: 'POST',
    url: '/internal/v1/csrf/claims',
    payload: { sessionId: CLAIM_SESSION, token: `T-${indexOf(subject)}`, expires: '260630150000123', context: 'authz.claim' },
  })),
  'POST /internal/v1/csrf/claims::settle': gatewayRoute({
    method: 'POST',
    url: '/internal/v1/csrf/claims:settle',
    payload: { sessionId: CLAIM_SESSION, consumed: [], released: [] },
  }),
  'POST /internal/v1/csrf/consume': {
    declared: { transport: 'service', requires: CONSUME_CALLERS.map((name) => `service:${name}`) },
    probes: [
      probe(
        'consume',
        (subject) => {
          const acting = actingSession(subject, 'editor');
          return { method: 'POST', url: '/internal/v1/csrf/consume', payload: { sessionId: acting.sessionId, ...csrfFor(acting, 'authz.consume'), context: 'authz.consume' } };
        },
        [...USERS, ...CONSUME_CALLERS.map((name) => `service:${name}`)],
        { credentials: relaying('editor') },
      ),
    ],
  },
  'GET /internal/v1/groups': peopleRoute({ method: 'GET', url: '/internal/v1/groups?ispublic=0' }),
  'POST /internal/v1/sessions::adopt': gatewayRoute(
    (subject) => ({
      method: 'POST',
      url: '/internal/v1/sessions:adopt',
      payload: {
        legacySessionId: `L-authz-${indexOf(subject)}`,
        siteId: SITE_A,
        describe: { user: { isLoggedIn: false, userID: '' }, roles: [], csrfSecretKey: cfId('7', indexOf(subject)), usedTokens: [] },
      },
    }),
    // The body's siteId is held to the user token's site.
    THROUGH_GATEWAY.filter((name) => name !== 'other-tenant'),
  ),
  'POST /internal/v1/sessions/:sid(.+)::end': gatewayRoute({ method: 'POST', url: '/internal/v1/sessions/S-authz-unknown:end', payload: { reason: 'logout' } }),
  'GET /internal/v1/sessions/:sid/admin-site': gatewayRoute({ method: 'GET', url: '/internal/v1/sessions/S-s2/admin-site' }),
  'GET /internal/v1/sessions/:sid/snapshot': gatewayRoute({ method: 'GET', url: '/internal/v1/sessions/S-s2/snapshot' }),
  'GET /internal/v1/sessions/:sid/state': gatewayRoute({ method: 'GET', url: '/internal/v1/sessions/S-s2/state' }),
  // A minted token carries every role of its session, so only the gateway mints; reporting's export runs act as System.
  'POST /internal/v1/tokens': gatewayRoute(
    { method: 'POST', url: '/internal/v1/tokens', payload: { sessionId: 'S-s2', siteId: SITE_A } },
    // The body's siteId is held to the user token's site.
    THROUGH_GATEWAY.filter((name) => name !== 'other-tenant'),
  ),
  'POST /v1/csrf/tokens': relayedUserRoute({ method: 'POST', url: '/v1/csrf/tokens', payload: { contexts: ['authz'] } }),
  'GET /v1/groups': cusersRoute({ method: 'GET', url: '/v1/groups' }),
  'POST /v1/groups': cusersRoute((subject) => {
    const userId = cfId('B', indexOf(subject));
    return { method: 'POST', url: '/v1/groups', headers: { ...FORM, ...csrfHeaders(subject, userId) }, payload: `userid=${userId}&groupname=Authz%20${indexOf(subject)}&ispublic=0` };
  }),
  'GET /v1/groups/:groupId': cusersRoute({ method: 'GET', url: `/v1/groups/${ADMIN_GROUP}` }),
  'PUT /v1/groups/:groupId': cusersRoute((subject) => ({
    method: 'PUT',
    url: `/v1/groups/${EDITOR_GROUP}`,
    headers: { ...FORM, ...csrfHeaders(subject, EDITOR_GROUP) },
    payload: 'groupname=Editor&ispublic=0',
  })),
  'GET /v1/groups/:groupId/members': cusersRoute({ method: 'GET', url: `/v1/groups/${EDITOR_GROUP}/members` }),
  'GET /v1/groups/:groupId/members.csv': cusersRoute({ method: 'GET', url: `/v1/groups/${EDITOR_GROUP}/members.csv` }),
  'DELETE /v1/groups/:groupId/members/:userId': cusersRoute({ method: 'DELETE', url: `/v1/groups/${ADMIN_GROUP}/members/${SITE_ADMIN_A.account.userid}` }),
  'POST /v1/groups/:groupId/members/:userId': cusersRoute((subject) => ({
    method: 'POST',
    url: `/v1/groups/${EDITOR_GROUP}/members/${SITE_ADMIN_A.account.userid}`,
    headers: csrfHeaders(subject, `${SITE_ADMIN_A.account.userid}${EDITOR_GROUP}addtogroup`),
  })),
  'POST /v1/login-mail': { declared: PUBLIC, probes: [probe('login-mail', { method: 'POST', url: '/v1/login-mail', payload: { email: 'nobody@example.test' } }, PUBLIC_ADMITTED)] },
  'GET /v1/oauth-clients': { declared: S2_ONLY, probes: [probe('list', { method: 'GET', url: '/v1/oauth-clients' }, ['s2'])] },
  'DELETE /v1/oauth-clients/:clientId': {
    declared: S2_ONLY,
    probes: [probe('delete', (subject) => ({ method: 'DELETE', url: `/v1/oauth-clients/${MATRIX_CLIENT}`, headers: csrfHeaders(subject, MATRIX_CLIENT, 1_000) }), ['s2'])],
  },
  'GET /v1/oauth-clients/:clientId': { declared: S2_ONLY, probes: [probe('read', { method: 'GET', url: `/v1/oauth-clients/${MATRIX_CLIENT}` }, ['s2'])] },
  'PUT /v1/oauth-clients/:clientId': {
    declared: S2_ONLY,
    probes: [
      probe(
        'save',
        (subject) => ({
          method: 'PUT',
          url: `/v1/oauth-clients/${MATRIX_CLIENT}`,
          headers: csrfHeaders(subject, MATRIX_CLIENT),
          payload: { siteid: SITE_A, name: 'Authz client', granttype: 'client_credentials' },
        }),
        ['s2'],
      ),
    ],
  },
  'GET /v1/permissions/content/:contentId': { declared: S2_OR_SITE_ADMIN, probes: [probe('content', { method: 'GET', url: `/v1/permissions/content/${HOME}` }, ['s2', 'site-admin', 'other-tenant'])] },
  'GET /v1/permissions/modules/:moduleId': { declared: S2_OR_SITE_ADMIN, probes: [probe('module', { method: 'GET', url: `/v1/permissions/modules/${USERS_MODULE}` }, ['s2', 'site-admin', 'other-tenant'])] },
  'PUT /v1/permissions/modules/:moduleId': {
    declared: S2_OR_SITE_ADMIN,
    probes: [
      probe(
        'module save',
        (subject) => ({
          method: 'PUT',
          url: `/v1/permissions/modules/${USERS_MODULE}`,
          headers: { ...FORM, ...csrfHeaders(subject, USERS_MODULE) },
          payload: `groupid=${EDITOR_GROUP}&moduleid=${USERS_MODULE}`,
        }),
        ['s2', 'site-admin', 'other-tenant'],
      ),
    ],
  },
  'GET /v1/permissions/reverse-lookup': relayedUserRoute({ method: 'GET', url: '/v1/permissions/reverse-lookup' }),
  'GET /v1/sessions/current': { declared: PUBLIC, probes: [probe('current', { method: 'GET', url: '/v1/sessions/current' }, PUBLIC_ADMITTED)] },
  'GET /v1/sessions/current/admin-state': relayedUserRoute({ method: 'GET', url: '/v1/sessions/current/admin-state' }),
  'POST /v1/sessions/current/admin-state': relayedUserRoute({ method: 'POST', url: '/v1/sessions/current/admin-state', payload: { topID: HOME } }, { ...PUBLIC, siteCheck: false }),
  'GET /v1/sessions/current/sites': {
    declared: { transport: 'service', requires: ['system-user', 's2'] },
    probes: [probe('sites', { method: 'GET', url: '/v1/sessions/current/sites' }, SYSTEM_USERS)],
  },
  'POST /v1/sessions/login': {
    declared: PUBLIC,
    probes: [probe('login without a token', { method: 'POST', url: '/v1/sessions/login', headers: FORM, payload: 'username=x&password=y' }, PUBLIC_ADMITTED)],
  },
  'POST /v1/sessions/logout': {
    declared: PUBLIC,
    probes: [
      probe('logout', { method: 'POST', url: '/v1/sessions/logout' }, PUBLIC_ADMITTED, {
        // Users log out a session minted for the probe alone, so their seeded sessions stay signed in.
        credentials: (subject) =>
          subject.kind === 'user'
            ? cached(`${subject.name}>logout`, () => relayedCredentials('gateway', { ...session(subject.name), sessionId: LOGOUT_SESSION }, subject.roles))
            : presented(subject),
      }),
    ],
  },
  'GET /v1/users/:userId/memberships': cusersRoute({ method: 'GET', url: `/v1/users/${EDITOR.account.userid}/memberships` }),
};

const NO_EFFECTS: Effects = { statements: 0, writes: 0, repoWrites: 0, events: 0, relayed: 0, calls: 0, fetches: 0 };

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

function parsedBody(res: InjectResponse): unknown {
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether `body` is a legacy JSON API error envelope. */
function isErrorEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { error } = body as { error?: { code?: unknown; message?: unknown } };
  return typeof error?.code === 'string' && typeof error.message === 'string';
}

async function inject(request: ProbeRequest, credentials: Headers): Promise<InjectResponse> {
  const { method, url, payload, headers } = request;
  return t.app.inject({ method, url, headers: { ...headers, ...credentials }, ...(payload === undefined ? {} : { payload }) });
}

/** How an answer of legacy's unhandled exception departs from its exact 500 envelope with no effect beyond reads. */
function raisedMismatches(at: string, res: InjectResponse, effects: Effects, method: string): string[] {
  const problems: string[] = [];
  const envelope = { apiversion: 'v1', method, error: { message: 'Unhandled Exception', code: 'server_error' } };
  if (res.statusCode !== 500 || !isDeepStrictEqual(parsedBody(res), envelope)) {
    problems.push(`${at}: expected the unhandled-exception 500 of ${method}, got ${res.statusCode} ${res.body.slice(0, 160)}`);
  }
  if (!isDeepStrictEqual(effects, { ...NO_EFFECTS, statements: effects.statements })) problems.push(`${at}: the 500 left effects ${JSON.stringify(effects)}`);
  return problems;
}

/** Every way one probe sent as one subject departs from its expectation. */
async function mismatchesOf(item: Probe, subject: RoleSubject): Promise<string[]> {
  const request = typeof item.request === 'function' ? item.request(subject) : item.request;
  const credentials = await (item.credentials ?? presented)(subject);
  t.resetEffects();
  const res = await inject(request, credentials);
  const effects = t.effects();
  const at = `${item.title} ${request.method} ${request.url} as ${subject.name}`;
  if (res.statusCode === 404) return [`${at}: 404, so the probe missed its route`];
  if (item.raises?.subjects.includes(subject.name) === true) return raisedMismatches(at, res, effects, item.raises.method);
  const admitted = res.statusCode !== 401 && res.statusCode !== 403;
  const shouldAdmit = item.allow.includes(subject.name);
  if (admitted !== shouldAdmit) return [`${at}: expected ${shouldAdmit ? 'admission' : 'denial'}, got ${res.statusCode} ${res.body.slice(0, 160)}`];
  // An admission the handler then answers with an unhandled exception proves nothing; a fail-closed 503 is a designed answer.
  if (admitted) return res.statusCode === 500 ? [`${at}: admitted, then failed with ${res.statusCode} ${res.body.slice(0, 160)}`] : [];

  const problems: string[] = [];
  if (!isErrorEnvelope(parsedBody(res))) problems.push(`${at}: denial is not the legacy error envelope: ${res.body.slice(0, 160)}`);
  if (subject.kind === 'anonymous' && res.statusCode !== 401) problems.push(`${at}: no credential must answer 401, got ${res.statusCode}`);
  const handler = item.denyCheck?.[subject.name];
  if (handler !== undefined && res.statusCode !== handler.status) problems.push(`${at}: expected handler ${handler.status}, got ${res.statusCode}`);
  // A hook-level denial runs no statement; a handler-level one may read, but writes, publishes, relays and calls nothing.
  const expected: Effects = handler === undefined ? NO_EFFECTS : { ...NO_EFFECTS, statements: effects.statements };
  if (JSON.stringify(effects) !== JSON.stringify(expected)) problems.push(`${at}: denial left effects ${JSON.stringify(effects)}`);
  return problems;
}

/** Status of `request` with `credentials` and the effects it left; reads count only with `reads`, as a hook-level denial must leave none. */
async function outcomeOf(request: ProbeRequest, credentials: Headers, opts: { reads?: boolean } = {}): Promise<{ status: number; effects: Partial<Effects> }> {
  t.resetEffects();
  const res = await inject(request, credentials);
  const { statements, ...effects } = t.effects();
  return { status: res.statusCode, effects: opts.reads === true ? { statements, ...effects } : effects };
}

/** Effects of a handler-level refusal, reads aside. */
const QUIET: Partial<Effects> = { writes: 0, repoWrites: 0, events: 0, relayed: 0, calls: 0, fetches: 0 };

const READS = { reads: true } as const;

beforeAll(async () => {
  t = await buildIdentityApp(defaultSeed({ sessions: [ENDED_ROW] }));
  matrix = collectRouteMatrix(t.app);
});

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  t.resetEffects();
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

  it('probes the full platform subject set plus the Users module grant identity declares', () => {
    const names = ROLE_SET.map((subject) => subject.name);
    expect(names).toEqual(expect.arrayContaining([...MINIMUM_SUBJECTS, ...SYNTHETIC]));
    expect(SUBJECTS.map((subject) => subject.name).sort()).toEqual([...EVERYONE].sort());
    const declaredRoles = new Set(matrix.routes.flatMap((route) => route.requires ?? []));
    const presentedRoles = new Set(SUBJECTS.flatMap((subject) => subject.roles));
    expect([...declaredRoles].filter((role) => !presentedRoles.has(role))).toEqual([]);
  });

  it('names only known subjects in the expectations', () => {
    const named = Object.values(EXPECTED).flatMap((entry) =>
      entry.probes.flatMap((item) => [...item.allow, ...Object.keys(item.denyCheck ?? {}), ...(item.raises?.subjects ?? [])]),
    );
    expect(named.filter((name) => !EVERYONE.includes(name))).toEqual([]);
  });
});

describe('route admission', () => {
  for (const [key, entry] of Object.entries(EXPECTED)) {
    it(`admits exactly the expected subjects on ${key}, and denials leave no handler effect`, { timeout: 120_000 }, async () => {
      const mismatches: string[] = [];
      for (const item of entry.probes) {
        for (const subject of SUBJECTS) mismatches.push(...(await mismatchesOf(item, subject)));
      }
      expect(mismatches).toEqual([]);
    });
  }
});

describe('CSRF arbitration callers', () => {
  const consumeBody = (context: string) => ({ sessionId: 'S-editor', ...csrfFor(session('editor'), context), context });

  it('consumeCsrfToken admits exactly the five original callers and communications, finance, reporting, surveys and timesheets', async () => {
    const statuses: Record<string, number> = {};
    for (const caller of SERVICE_CALLERS) {
      const subject = subjectNamed(`service:${caller}`);
      const credentials = await relaying('editor')(subject);
      statuses[caller] = (await outcomeOf({ method: 'POST', url: '/internal/v1/csrf/consume', payload: consumeBody(`authz.callers.${caller}`) }, credentials)).status;
    }
    const admitted = Object.entries(statuses).filter(([, status]) => status === 200).map(([caller]) => caller);
    expect(admitted.sort()).toEqual([...CONSUME_CALLERS].sort());
    expect(Object.fromEntries(Object.entries(statuses).filter(([caller]) => !admitted.includes(caller)))).toEqual({
      'e-signature': 403,
      stub: 403,
      web: 403,
      migration: 403,
      operator: 403,
      'pubsub-invoker': 401,
      'tasks-invoker': 401,
    });
  });

  it.each([
    ['claimCsrfToken', '/internal/v1/csrf/claims', { sessionId: CLAIM_SESSION, token: 'T-callers', expires: '260630150000123', context: 'authz.claim' }],
    ['settleCsrfClaims', '/internal/v1/csrf/claims:settle', { sessionId: CLAIM_SESSION, consumed: ['T-callers'], released: [] }],
  ])('%s admits no workload but the gateway, and no user token without its invocation credential', async (_name, url, payload) => {
    const statuses: Record<string, number> = {};
    for (const caller of SERVICE_CALLERS) {
      statuses[caller] = (await outcomeOf({ method: 'POST', url, payload }, await presented(subjectNamed(`service:${caller}`)))).status;
    }
    expect(Object.entries(statuses).filter(([, status]) => status === 200).map(([caller]) => caller)).toEqual(['gateway']);
    const userOnly = { authorization: (await presented(subjectNamed('s2'))).authorization ?? '' };
    expect(await outcomeOf({ method: 'POST', url, payload }, userOnly, READS)).toEqual({ status: 401, effects: NO_EFFECTS });
  });
});

describe('transport boundaries', () => {
  /** Every route whose declaration requires roles, sent with a valid tenant-a request. */
  const ROLE_ROUTES = Object.entries(EXPECTED).filter(([, entry]) => entry.declared.requires !== undefined);

  const requestOf = (entry: Expected, subject: RoleSubject): ProbeRequest => {
    const first = entry.probes[0];
    if (first === undefined) throw new TypeError('An expectation without probes');
    return typeof first.request === 'function' ? first.request(subject) : first.request;
  };

  it('refuses a user token without the invocation credential on every role-declared route, before any statement', async () => {
    const s2 = subjectNamed('s2');
    const userOnly = { authorization: (await presented(s2)).authorization ?? '' };
    const outcomes = [];
    for (const [key, entry] of ROLE_ROUTES) {
      t.resetEffects();
      const res = await inject(requestOf(entry, s2), userOnly);
      outcomes.push({ key, status: res.statusCode, effects: t.effects() });
    }
    expect(outcomes.filter((outcome) => outcome.status !== 401 || JSON.stringify(outcome.effects) !== JSON.stringify(NO_EFFECTS))).toEqual([]);
  });

  it('refuses a managed tasks-invoker token on every service route, with or without the gateway invocation credential', async () => {
    const tasks = `Bearer ${await mintTasksInvokerToken({ audience: 'identity' })}`;
    const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}`;
    const problems: string[] = [];
    const presentations: Headers[] = [{ authorization: tasks }, { authorization: tasks, [INVOCATION_HEADER]: gateway }];
    for (const credentials of presentations) {
      for (const [key, entry] of Object.entries(EXPECTED)) {
        const outcome = await outcomeOf(requestOf(entry, subjectNamed('s2')), credentials, READS);
        if (outcome.status !== 401 || JSON.stringify(outcome.effects) !== JSON.stringify(NO_EFFECTS)) problems.push(`${key}: ${JSON.stringify(outcome)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('refuses the local push key in place of an invocation credential on every role-declared route', async () => {
    const problems: string[] = [];
    for (const [key, entry] of ROLE_ROUTES) {
      const request = requestOf(entry, subjectNamed('service:gateway'));
      const url = `${request.url}${request.url.includes('?') ? '&' : '?'}key=${TEST_PUSH_KEY}`;
      const outcome = await outcomeOf({ ...request, url }, {}, READS);
      if (outcome.status !== 401 || JSON.stringify(outcome.effects) !== JSON.stringify(NO_EFFECTS)) problems.push(`${key}: ${JSON.stringify(outcome)}`);
    }
    expect(problems).toEqual([]);
  });

  it.each([
    ['addressed to another callee', () => mintServiceToken({ caller: 'gateway', audience: 'people' })],
    ['signed by a key other than the local signer', async () => foreignToken({ sub: 'service:gateway', roles: ['service:gateway'], iss: 'opt2-local-service', aud: 'identity' })],
  ])('refuses a gateway invocation credential %s', async (_label, mint) => {
    const request: ProbeRequest = { method: 'POST', url: '/internal/v1/tokens', payload: { sessionId: 'S-s2', siteId: SITE_A } };
    expect(await outcomeOf(request, { [INVOCATION_HEADER]: `Bearer ${await mint()}` }, READS)).toEqual({ status: 401, effects: NO_EFFECTS });
  });

  it.each([
    ['of another issuer', { iss: 'https://securetoken.google.com/opt2' }],
    ['for another audience', { aud: 'opt2-cloud' }],
    ['that expired', { iat: 1_700_000_000, exp: 1_700_000_300 }],
  ])('refuses a user token %s with the bearer challenge, on public and role-declared routes alike', async (_label, claims) => {
    const token = await mintUserToken({ sub: session('s2').userId, sid: 'S-s2', site: SITE_A, roles: [Roles.systemUser, Roles.s2], ...claims });
    const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}`;
    for (const request of [{ method: 'GET', url: '/v1/sessions/current' }, { method: 'GET', url: '/v1/oauth-clients' }] as const) {
      t.resetEffects();
      const res = await inject(request, { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: gateway });
      expect([request.url, res.statusCode, String(res.headers['www-authenticate'])]).toEqual([request.url, 401, expect.stringMatching(/^Bearer /)]);
      expect(t.effects()).toEqual(NO_EFFECTS);
    }
  });

  it('refuses a user token signed by a key other than identity’s', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await foreignToken({
      sub: session('s2').userId,
      sid: 'S-s2',
      tid: TENANT_A.tenantId,
      site: SITE_A,
      roles: [Roles.s2],
      s2: true,
      epoch: 0,
      iss: LOCAL_USER_TOKEN.issuer,
      aud: LOCAL_USER_TOKEN.audience,
      iat: now,
      exp: now + 300,
    });
    const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}`;
    expect(await outcomeOf({ method: 'GET', url: '/v1/oauth-clients' }, { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: gateway }, READS)).toEqual({ status: 401, effects: NO_EFFECTS });
  });

  it('refuses Basic credentials, which the gateway exchanges and never forwards', async () => {
    const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}`;
    for (const url of ['/v1/sessions/current', '/v1/oauth-clients', `/_api/json/v1/${SITE_A}/group/properties`]) {
      expect({ url, ...(await outcomeOf({ method: 'GET', url }, { authorization: 'Basic YWRtaW46YWRtaW4=', [INVOCATION_HEADER]: gateway }, READS)) }).toEqual({ url, status: 401, effects: NO_EFFECTS });
    }
  });
});

/** A JWT of `claims` signed by a freshly generated RS256 key that identity has never published. */
async function foreignToken(claims: Record<string, unknown>): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256');
  const { iat, exp, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(rest)
    .setProtectedHeader({ alg: 'RS256', kid: 'foreign' })
    .setIssuedAt(typeof iat === 'number' ? iat : now)
    .setExpirationTime(typeof exp === 'number' ? exp : now + 300)
    .sign(privateKey);
}

describe('session boundaries', () => {
  it.each(CONSUME_CALLERS)('refuses %s consuming for a session other than the relayed one, before the ledger or the legacy relay', async (caller) => {
    const credentials = await relaying('editor')(subjectNamed(`service:${caller}`));
    const payload = { sessionId: 'S-s2', ...csrfFor(session('s2'), `authz.other.${caller}`), context: `authz.other.${caller}` };
    const outcome = await outcomeOf({ method: 'POST', url: '/internal/v1/csrf/consume', payload }, credentials, READS);
    expect(outcome).toEqual({ status: 403, effects: NO_EFFECTS });
  });

  it('consumes a token only once for its session, relaying it to legacy the first time', async () => {
    const credentials = await relaying('editor')(subjectNamed('service:surveys'));
    const payload = { sessionId: 'S-editor', ...csrfFor(session('editor'), 'authz.once'), context: 'authz.once' };
    t.resetEffects();
    const first = await inject({ method: 'POST', url: '/internal/v1/csrf/consume', payload }, credentials);
    const relayedFirst = t.effects().relayed;
    const second = await inject({ method: 'POST', url: '/internal/v1/csrf/consume', payload }, credentials);
    expect([first.json(), relayedFirst, second.json(), t.effects().relayed]).toEqual([{ valid: true }, 1, { valid: false }, 1]);
  });

  it('refuses session-bound writes for a token whose session has ended, without writing', async () => {
    const ended = await relayedCredentials('gateway', { ...session('s2'), sessionId: ENDED_SESSION }, subjectNamed('s2').roles);
    const userId = cfId('B', 777);
    const requests: ProbeRequest[] = [
      { method: 'POST', url: '/v1/sessions/current/admin-state', payload: { topID: HOME } },
      { method: 'POST', url: '/v1/csrf/tokens', payload: { contexts: ['authz'] } },
      { method: 'POST', url: '/v1/groups', headers: FORM, payload: `userid=${userId}&groupname=Ended&ispublic=0` },
    ];
    for (const request of requests) expect({ url: request.url, ...(await outcomeOf(request, ended)) }).toEqual({ url: request.url, status: 401, effects: QUIET });
  });

  it('mints an ended session a token without roles', async () => {
    const res = await inject({ method: 'POST', url: '/internal/v1/tokens', payload: { sessionId: ENDED_SESSION, siteId: SITE_A } }, await presented(subjectNamed('service:gateway')));
    expect(res.statusCode).toBe(200);
    const claims = decodeJwt(res.json<{ token: string }>().token);
    expect([claims.sid, claims.sub, claims.roles, claims.s2]).toEqual([ENDED_SESSION, '', [], false]);
  });

  it("refuses a roster commit carrying session effects for another user's session", async () => {
    const credentials = await relaying('s2')(subjectNamed('service:people'));
    const payload = { sessionEffects: { reloginSessionId: 'S-editor' } };
    const url = `/internal/v1/accounts/${EDITOR.account.userid}/operations/${UNKNOWN_OPERATION}:commit`;
    expect(await outcomeOf({ method: 'POST', url, payload }, credentials, READS)).toEqual({ status: 403, effects: NO_EFFECTS });
  });
});

describe('tenant boundary', () => {
  it.each<[string, ProbeRequest, string]>([
    ['cUsers group list', { method: 'GET', url: '/v1/groups?siteid=tenant-b' }, 's2'],
    ['content permissions', { method: 'GET', url: `/v1/permissions/content/${HOME}?siteid=tenant-b` }, 's2'],
    ['OAuth client list', { method: 'GET', url: '/v1/oauth-clients?siteid=tenant-b' }, 's2'],
    ['JSON API group list', { method: 'GET', url: '/_api/json/v1/tenant-b/group' }, 's2'],
    ['token mint', { method: 'POST', url: '/internal/v1/tokens', payload: { sessionId: 'S-s2', siteId: 'tenant-b' } }, 's2'],
  ])('refuses a tenant-a token naming tenant-b on the %s, before any statement', async (_label, request, subject) => {
    t.resetEffects();
    const res = await inject(request, await presented(subjectNamed(subject)));
    expect([res.statusCode, t.effects()]).toEqual([403, request.url.startsWith('/_api/') ? { ...NO_EFFECTS, statements: t.effects().statements } : NO_EFFECTS]);
  });

  it("refuses people's account reads for a siteid other than the relayed token's site", async () => {
    const credentials = await relaying('editor')(subjectNamed('service:people'));
    expect(await outcomeOf({ method: 'GET', url: '/internal/v1/groups?ispublic=0&siteid=tenant-b' }, credentials, READS)).toEqual({ status: 403, effects: NO_EFFECTS });
  });

  it("keeps a tenant-b site admin's group and grant writes out of tenant-a", async () => {
    const other = subjectNamed('other-tenant');
    const credentials = await presented(other);
    const userId = cfId('B', 778);
    const writes: ProbeRequest[] = [
      { method: 'POST', url: '/v1/groups', headers: { ...FORM, ...csrfHeaders(other, userId) }, payload: `userid=${userId}&groupname=Other&ispublic=0` },
      { method: 'PUT', url: `/v1/permissions/modules/${USERS_MODULE}`, headers: { ...FORM, ...csrfHeaders(other, USERS_MODULE, 2_000) }, payload: `groupid=${EDITOR_GROUP}&moduleid=${USERS_MODULE}` },
    ];
    const touched: string[] = [];
    for (const request of writes) {
      t.resetEffects();
      const res = await inject(request, credentials);
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
      touched.push(...t.repo.writes().map((write) => write.tenantId), ...t.outboxEvents().map((envelope) => envelope.tenantId));
    }
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((tenantId) => tenantId === TENANT_A.tenantId)).toEqual([]);
  });
});

describe('unknown routes fail closed', () => {
  const UNKNOWN: readonly ProbeRequest[] = [
    { method: 'GET', url: '/v1/nosuch' },
    { method: 'POST', url: '/internal/v1/nosuch', payload: {} },
    { method: 'GET', url: '/internal/v1/accounts' },
    { method: 'POST', url: '/internal/v1/events/identity.nosuch.topic.v1', payload: {} },
    { method: 'POST', url: '/internal/v1/tasks/nosuch', payload: {} },
    { method: 'POST', url: '/internal/v1/jobs/nosuch', payload: {} },
    { method: 'DELETE', url: `/v1/groups/${EDITOR_GROUP}` },
    { method: 'PUT', url: '/internal/v1/csrf/consume', payload: {} },
    { method: 'GET', url: '/internal/v1/tokens' },
    { method: 'POST', url: '/v1/sessions/current' },
  ];

  it.each(['anonymous', 's2', 'service:gateway', 'service:migration', 'service:people'])(
    'answers %s on every undeclared route or method with the legacy 404, before any statement',
    async (name) => {
      const problems: string[] = [];
      for (const request of UNKNOWN) {
        t.resetEffects();
        const url = request.url.startsWith('/internal/v1/events/') ? `${request.url}?key=${TEST_PUSH_KEY}` : request.url;
        const res = await inject({ ...request, url }, await presented(subjectNamed(name)));
        if (res.statusCode !== 404 || !isErrorEnvelope(parsedBody(res)) || JSON.stringify(t.effects()) !== JSON.stringify(NO_EFFECTS)) {
          problems.push(`${request.method} ${request.url}: ${res.statusCode} ${JSON.stringify(t.effects())}`);
        }
      }
      expect(problems).toEqual([]);
    },
  );

  it('exposes no HEAD route beside the GET routes', async () => {
    for (const url of ['/v1/sessions/current', '/healthz', '/.well-known/jwks.json']) {
      expect((await t.app.inject({ method: 'HEAD', url })).statusCode).toBe(404);
    }
  });
});

describe('deny by default at start-up', () => {
  it.each<[string, (app: IdentityTestApp['app']) => void]>([
    ['a route without config.opt2', (app) => app.get('/v1/opt2-undeclared-probe', async () => ({}))],
    ['a route declaring both roles and public', (app) => app.get('/v1/opt2-both-probe', { config: { opt2: { requires: ['s2'], public: true } } }, async () => ({}))],
    ['an empty role list', (app) => app.get('/v1/opt2-empty-probe', { config: { opt2: { requires: [] } } }, async () => ({}))],
    [
      'a push route on the service transport',
      (app) => app.post('/internal/v1/events/identity.opt2-probe', { config: { opt2: { transport: 'service', requires: ['service:pubsub-invoker'] } } }, async () => ({})),
    ],
    ['a public task route', (app) => app.post('/internal/v1/tasks/opt2-probe', { config: { opt2: { transport: 'cloud-tasks', public: true } } }, async () => ({}))],
  ])('fails start-up of the composed identity service for %s', async (_label, register) => {
    const composed = await buildIdentityApp(defaultSeed(), { ready: false });
    try {
      composed.app.register(async (child) => {
        register(child);
      });
      await expect(composed.app.ready()).rejects.toBeInstanceOf(UndeclaredRouteError);
    } finally {
      await composed.close();
    }
  });
});
