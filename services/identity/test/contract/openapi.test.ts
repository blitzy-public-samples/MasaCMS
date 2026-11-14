/** Provider contract of identity: the composition root's routes, the JSON API route keys and every operation's responses, legacy error shapes included, against contracts/openapi.yaml. */
import { readFileSync } from 'node:fs';
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, transportForPath, type RouteMatrixEntry } from '@opt2/platform/auth';
import { subscriptionName } from '@opt2/platform/events';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  WWW_AUTHENTICATE,
  normaliseRouteKey,
  routeKeyForRequest,
} from '@opt2/platform/legacy-compat';
import { SITE_CHANGED_TOPIC, SYSTEM_TENANT_ID } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushTo,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type CapturingPublisher,
  type InjectResponse,
  type TenantlessEnvelope,
} from '@opt2/platform/testing';
import { USER_CLOSED_WAIT_MS } from '../../src/domain/account-operations.js';
import { PERSON_CHANGED_TOPIC, PERSON_CONTACT_SUBSCRIPTION, type PersonChangedPayload } from '../../src/events/person-contact.js';
import { USER_ACCOUNT } from '../../src/repo/tables.js';
import { SWEEP_QUEUE, buildTestApp, type TestApp } from '../helpers/app.js';
import type { RecordingDb } from '../helpers/memory-repo.js';
import { ADMIN_S2, ALL_ACTORS, EDITOR, MEMBER_B, SITE_ADMIN_A, sessionRow } from '../helpers/rows.js';
import {
  NOW,
  REGISTRY_ROWS,
  SERVICE,
  SITE_A,
  SUBJECT_SESSIONS,
  buildIdentityApp,
  cfId,
  credentialsFor,
  csrfFor,
  defaultSeed,
  registryAnswer,
  relayedCredentials,
  subjectNamed,
  type IdentityTestApp,
  type SubjectSession,
} from '../helpers/service.js';

type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
type App = TestApp['app'];
type Operation = Record<string, unknown> & { operationId?: string };
type Headers = Record<string, string>;

interface OpenApiDoc {
  openapi: string;
  info: { version: string; 'x-source-sha'?: string };
  paths: Record<string, Record<string, unknown>>;
}

interface ContractOperation {
  method: HttpMethod;
  path: string;
  operationId: string;
  op: Operation;
}

/** An app under test with its recording database and, on the composition root, its capturing publisher. */
interface Harness {
  app: App;
  db: RecordingDb;
  publisher?: CapturingPublisher;
  close(): Promise<void>;
}

/** The composition root built by `buildApp`. */
interface RootHarness extends Harness {
  publisher: CapturingPublisher;
}

/** One request against an operation and the status it must answer; `as` names the subject presenting credentials, `push` delivers through `pushTo`. */
interface Case {
  name: string;
  method: HttpMethod;
  url: string;
  as?: string;
  headers?: () => Promise<Headers>;
  payload?: string | Record<string, unknown>;
  push?: { subscription: string; envelope: () => TenantlessEnvelope };
  /** Prepares the harness's database before the request, for answers PostgreSQL computes that the recording database cannot. */
  setup?: (db: RecordingDb) => void;
  status: number;
  verify?: (body: unknown, res: InjectResponse, harness: Harness) => void | Promise<void>;
}

/** A legacy error case, sent to an app of its own. */
interface ErrorCase extends Case {
  /** Runs on the composition root over an empty recording database rather than on the composed routes over the memory repository. */
  root?: true;
  /** Wall-clock bound of the request in ms. */
  withinMs?: number;
}

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'] as const;
const TRANSPORTS: readonly string[] = ['service', 'pubsub-push', 'cloud-tasks'];
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const QUIET_ENV = { LOG_LEVEL: 'error' } as const;
const REGISTRY_SQL = /FROM identity\.tenant_registry\b/;
const OPEN_OPERATION_SQL = /"identity"\."account_operation" WHERE tenant_id = \$1 AND state = ANY/;
const SITE_SUBSCRIPTION = subscriptionName(SERVICE, SITE_CHANGED_TOPIC);
const TPERMISSIONS_COLUMNS = ['ContentID', 'GroupID', 'SiteID', 'Type'].map((name) => ({ name, type: 's' }));
const SWEEP_TASK = { queue: SWEEP_QUEUE, name: `${SWEEP_QUEUE}-1782820800`, tenantId: null };

const ADMIN_GROUP = SITE_ADMIN_A.groups[0]?.userid ?? '';
const EDITOR_GROUP = EDITOR.groups[0]?.userid ?? '';
const USERS_MODULE = '00000000000000000000000000000000008';
const HOME = '00000000000000000000000000000000001';
const NEW_GROUP = cfId('A', 901);
const NATIVE_GROUP = cfId('A', 906);
const NEW_CLIENT = cfId('C', 902);
const NEW_USER = cfId('E', 903);
const OPERATION_ID = cfId('F', 904);
const ABORTED_OPERATION = cfId('F', 905);
const REVERTED_USER = cfId('E', 909);
const REVERTED_OPERATION = cfId('F', 909);
const UNKNOWN_ID = cfId('D', 999);

/** Extra sessions the stateful cases consume: anonymous ones for login, and signed-in ones ended or claimed by a case. */
const ANONYMOUS_LOGIN = { sessionId: 'S-login', csrfSecret: cfId('6', 1) };
const ANONYMOUS_CHALLENGE = { sessionId: 'S-login-mfa', csrfSecret: cfId('6', 2) };
const LOGOUT_SESSION = { sessionId: 'S-logout', csrfSecret: cfId('6', 3) };
const ENDED_SESSION = { sessionId: 'S-end', csrfSecret: cfId('6', 4) };

const EXTRA_SESSIONS = [
  sessionRow({ tenant_id: SYSTEM_TENANT_ID, session_id: ANONYMOUS_LOGIN.sessionId, site_id: SITE_A, csrf_secret: ANONYMOUS_LOGIN.csrfSecret }),
  sessionRow({ tenant_id: SYSTEM_TENANT_ID, session_id: ANONYMOUS_CHALLENGE.sessionId, site_id: SITE_A, csrf_secret: ANONYMOUS_CHALLENGE.csrfSecret }),
  ...[LOGOUT_SESSION, ENDED_SESSION].map(({ sessionId, csrfSecret }) =>
    sessionRow({ tenant_id: EDITOR.tenant.tenantId, session_id: sessionId, user_id: EDITOR.account.userid, csrf_secret: csrfSecret }),
  ),
];

/** The site admin's user name one strike past the allowed four, last tried two minutes before the clock: blocked for eight more. */
const BLOCKED_STRIKE = {
  tenant_id: SITE_ADMIN_A.tenant.tenantId,
  username: String(SITE_ADMIN_A.account.username),
  strikes: 5,
  lastattempt: new Date(NOW.getTime() - 2 * 60_000),
};
const BLOCKED_UNTIL = '2026-06-30T12:08:00.123';

/** The editor's photo, a file strategies-content stores; the member rows read its extension from there. */
const EDITOR_PHOTO = cfId('9', 1);
const CONTACTS = ALL_ACTORS.map(({ contact }) => (contact === EDITOR.contact ? { ...contact, photofileid: EDITOR_PHOTO } : contact));

/** Active Type=2 accounts stored in `tenantId` under pool site `siteId`: the pool a count reads. */
function activePoolAccounts(tenantId: string, siteId: string): number {
  return t.repo.rows(USER_ACCOUNT.table, tenantId).filter((row) => row.type === 2 && row.siteid === siteId && row.opt2_state === 'active').length;
}

function session(name: string): SubjectSession {
  const found = SUBJECT_SESSIONS[name];
  if (found === undefined) throw new TypeError(`No subject session ${name}`);
  return found;
}

/** Credentials of an anonymous identity session as the gateway relays it: a role-less user token naming the session. */
async function anonymousSession(sessionId: string): Promise<Headers> {
  const [user, gateway] = await Promise.all([
    mintUserToken({ sub: '', sid: sessionId, site: SITE_A, roles: [] }),
    mintServiceToken({ caller: 'gateway', audience: 'identity' }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${gateway}` };
}

/** The subject's credentials with the CSRF token for `context`, issued `laterMs` after the clock, in the `X-csrf_token` headers. */
async function withCsrfHeaders(subject: string, context: string, laterMs = 0): Promise<Headers> {
  const { token, expires } = csrfFor(session(subject), context, laterMs);
  return { ...(await credentialsFor(subjectNamed(subject))), [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: expires };
}

/** Form fields of a CSRF token issued under `secret` for `context`. */
function csrfFields(secret: string, context: string): string {
  const { token, expires } = csrfFor({ csrfSecret: secret }, context);
  return `${CSRF_FIELD_TOKEN}=${encodeURIComponent(token)}&${CSRF_FIELD_EXPIRES}=${encodeURIComponent(expires)}`;
}

/** `fields` as a browser's multipart body, each a text part, with its content type. */
function multipartPost(fields: Readonly<Record<string, string>>): { contentType: string; payload: string } {
  const boundary = '----opt2ContractBoundary';
  const parts = Object.entries(fields).map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: `${parts.join('')}--${boundary}--\r\n` };
}

/** `caller` relaying the user token of subject `subject`'s session. */
function relay(caller: string, subject: string, roles: readonly string[] = subjectNamed(subject).roles): () => Promise<Headers> {
  return () => relayedCredentials(caller, session(subject), roles);
}

function record(body: unknown): Record<string, unknown> {
  expect(body).toBeTypeOf('object');
  return body as Record<string, unknown>;
}

/** One entry per operation of `doc`. */
function contractOperations(doc: OpenApiDoc): ContractOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const op = item[method] as Operation | undefined;
      return op === undefined ? [] : [{ method: method.toUpperCase() as HttpMethod, path, operationId: op.operationId ?? '', op }];
    }),
  );
}

const OPERATIONS = contractOperations(DOC);

/** A Fastify route pattern in contract path form: `::` is a literal colon, `:name` and its `(regex)` become `{name}`, and a trailing wildcard stays, as `x-opt2-fastify-path` names wildcard routes. */
function toOpenApiPath(fastifyUrl: string): string {
  const literalColon = '\u0000';
  return fastifyUrl
    .replaceAll('::', literalColon)
    .replace(/:([A-Za-z_]\w*)(?:\([^)]*\))?/g, '{$1}')
    .replaceAll(literalColon, ':');
}

/** `METHOD path` keys an operation is served under: its `x-opt2-fastify-path` patterns, one or a list, in contract form, else its template. */
function operationRouteKeys({ method, path, op }: ContractOperation): string[] {
  const fastifyPath = op['x-opt2-fastify-path'] as string | string[] | undefined;
  const paths = fastifyPath === undefined ? [path] : [fastifyPath].flat().map(toOpenApiPath);
  return paths.map((served) => `${method} ${served}`);
}

/** `METHOD path` key of a registered route, in contract form. */
function routeKey(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${toOpenApiPath(route.url)}`;
}

/** Registered routes the contract describes: Fastify's automatic HEAD twins of GET routes drop unless the contract declares a `head` operation. */
function servedRoutes(app: App): RouteMatrixEntry[] {
  const declaresHead = OPERATIONS.some(({ method }) => method === 'HEAD');
  return collectRouteMatrix(app).routes.filter((route) => route.method !== 'HEAD' || declaresHead);
}

/** Registered routes the contract does not declare, and operations with a route nothing registers, each sorted. */
function diffRouteSets(routes: readonly RouteMatrixEntry[], operations: readonly ContractOperation[]): { undeclared: string[]; unregistered: string[] } {
  const registered = new Set(routes.map(routeKey));
  const declaredKeys = new Set(operations.flatMap(operationRouteKeys));
  return {
    undeclared: [...registered].filter((key) => !declaredKeys.has(key)).sort(),
    unregistered: operations
      .flatMap((operation) => operationRouteKeys(operation).filter((key) => !registered.has(key)).map((key) => `${operation.operationId} (${key})`))
      .sort(),
  };
}

/** A declaration in comparable form. */
function declared(entry: { transport: unknown; requires?: unknown; public?: unknown }): Record<string, unknown> {
  return {
    transport: entry.transport,
    ...(Array.isArray(entry.requires) ? { requires: [...(entry.requires as string[])].sort() } : {}),
    ...(entry.public === true ? { public: true } : {}),
  };
}

function contractDeclaration(operation: ContractOperation): Record<string, unknown> {
  return declared({ transport: operation.op['x-opt2-transport'], requires: operation.op['x-opt2-requires'], public: operation.op['x-opt2-public'] });
}

/** JSON API request shapes, one per path form, each naming a method identity serves. */
function jsonApiShapes(family: 'json' | 'ajax' | 'rest'): Record<'Root' | 'Segment' | 'Item' | 'Suffix', string> {
  return {
    Root: `/_api/${family}/v1/${SITE_A}?method=findCurrentUser`,
    Segment: `/_api/${family}/v1/${SITE_A}/findCurrentUser`,
    Item: `/_api/${family}/v1/${SITE_A}/group/properties`,
    Suffix: `/_api/${family}/v1/${SITE_A}/group/${ADMIN_GROUP}/permissions`,
  };
}

/** The `method` each shape's request reports in legacy's envelope; the `<id>/permissions` path keeps the `invalid` it starts with. */
const REPORTED_METHOD: Readonly<Record<'Root' | 'Segment' | 'Item' | 'Suffix', string>> = {
  Root: 'findCurrentUser',
  Segment: 'findCurrentUser',
  Item: 'findProperties',
  Suffix: 'invalid',
};

/** Legacy's unhandled-exception envelope for `method`. */
function serverError(method: string): Record<string, unknown> {
  return { apiversion: 'v1', method, error: { message: 'Unhandled Exception', code: 'server_error' } };
}

/** The JSON API cases of one family, shape and method: a served answer, and the legacy refusals that path form gives. */
function jsonApiCases(family: 'json' | 'ajax' | 'rest', shape: 'Root' | 'Segment' | 'Item' | 'Suffix', method: HttpMethod): Case[] {
  const url = jsonApiShapes(family)[shape];
  const rest = family === 'rest';
  const cases: Case[] = [
    // REST is sessionless: a request whose credentials the gateway exchanged reaches its method, whose event of a registered site raises.
    rest
      ? {
          name: `answers ${method} ${url} as s2 with the unhandled exception of its sessionless event`,
          method,
          url,
          as: 's2',
          status: 500,
          verify: (body) => expect(body).toEqual(serverError(REPORTED_METHOD[shape])),
        }
      : { name: `serves ${method} ${url} as s2`, method, url, as: 's2', status: 200, verify: (body) => expect(record(body).apiversion).toBe('v1') },
    { name: `refuses ${method} ${url} for a token of another site`, method, url, as: 'other-tenant', status: 403 },
  ];
  if (rest) cases.push({ name: `refuses ${method} ${url} without credentials`, method, url, status: 401 });
  else cases.push({ name: `serves ${method} ${url} anonymously`, method, url, status: 200 });
  if (shape === 'Segment') {
    cases.push({ name: `answers ${method} on an unregistered site with invalidParameters`, method, url: `/_api/${family}/v1/ghost/group`, status: 400 });
    cases.push({ name: `answers ${method} on an entity identity does not own with the 404 envelope`, method, url: `/_api/${family}/v1/${SITE_A}/content`, as: 's2', status: 404 });
  }
  if (shape === 'Root' && !rest) {
    cases.push({ name: `answers ${method} generateCSRFTokens without a context with server_error`, method, url: `/_api/${family}/v1/${SITE_A}?method=generateCSRFTokens`, status: 500 });
  }
  return cases;
}

const JSON_API_CASES: Record<string, Case[]> = Object.fromEntries(
  (['json', 'ajax', 'rest'] as const).flatMap((family) =>
    (['Root', 'Segment', 'Item', 'Suffix'] as const).flatMap((shape) =>
      (['GET', 'POST', 'PUT', 'DELETE'] as const).map((method) => [
        `${family}${shape}${method.charAt(0)}${method.slice(1).toLowerCase()}`,
        jsonApiCases(family, shape, method),
      ]),
    ),
  ),
);

const PREPARE_BODY = {
  kind: 'create',
  siteId: SITE_A,
  account: { UserName: 'gates_new_user', Password: 'Gates12345', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 },
  groupIds: [],
};

const operationUrl = (userId: string, operationId: string, action?: string): string =>
  `/internal/v1/accounts/${userId}/operations/${operationId}${action === undefined ? '' : `:${action}`}`;

const NATIVE_GROUP_CSRF = csrfFor(session('site-admin'), NATIVE_GROUP);
/** The new group's Edit Group form as the browser posts it, its `userid` in the action URL only. */
const NATIVE_GROUP_FIELDS: Readonly<Record<string, string>> = {
  isPublic: '0',
  groupname: 'Natives',
  email: '',
  tablist: '',
  action: 'add',
  type: '1',
  contact: '0',
  siteid: SITE_A,
  returnurl: '',
  subtype: 'Default',
  [CSRF_FIELD_TOKEN]: NATIVE_GROUP_CSRF.token,
  [CSRF_FIELD_EXPIRES]: NATIVE_GROUP_CSRF.expires,
};
const NATIVE_GROUP_POST = multipartPost(NATIVE_GROUP_FIELDS);
const NATIVE_GROUP_URL = `/v1/groups?userid=${NATIVE_GROUP}`;

const CASES: Record<string, Case[]> = {
  ...JSON_API_CASES,
  getCurrentSession: [
    {
      name: 'describes the signed-in s2 session',
      method: 'GET',
      url: '/v1/sessions/current',
      as: 's2',
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ sessionId: 'S-s2', user: { isLoggedIn: true, userID: ADMIN_S2.account.userid } }),
    },
    { name: 'describes no session for an anonymous caller', method: 'GET', url: '/v1/sessions/current', status: 200, verify: (body) => expect(record(body).sessionId).toBeNull() },
    {
      name: 'refuses an expired user token with accessTokenExpired',
      method: 'GET',
      url: '/v1/sessions/current',
      headers: async () => ({
        authorization: `Bearer ${await mintUserToken({ sub: EDITOR.account.userid, sid: 'S-editor', site: SITE_A, roles: [Roles.systemUser], iat: 1_700_000_000, exp: 1_700_000_300 })}`,
      }),
      status: 401,
    },
  ],
  listCurrentSessionSites: [
    {
      name: 'lists every registered site for s2',
      method: 'GET',
      url: '/v1/sessions/current/sites',
      as: 's2',
      status: 200,
      verify: (body) => expect((record(body).sites as Array<{ siteID: string }>).map((site) => site.siteID)).toContain(SITE_A),
    },
    { name: 'refuses a caller without credentials', method: 'GET', url: '/v1/sessions/current/sites', status: 401 },
    { name: 'refuses a public-pool member', method: 'GET', url: '/v1/sessions/current/sites', as: 'member', status: 403 },
  ],
  getAdminSessionState: [
    { name: 'reads the editor session admin state', method: 'GET', url: '/v1/sessions/current/admin-state', as: 'editor', status: 200 },
    { name: 'refuses a caller without a relayed user token', method: 'GET', url: '/v1/sessions/current/admin-state', status: 401 },
  ],
  saveAdminSessionState: [
    {
      name: 'merges admin values into the editor session',
      method: 'POST',
      url: '/v1/sessions/current/admin-state',
      as: 'editor',
      payload: { siteid: SITE_A, topID: HOME },
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ siteid: SITE_A, topID: HOME }),
    },
    { name: 'refuses an admin value of the wrong type', method: 'POST', url: '/v1/sessions/current/admin-state', as: 'editor', payload: { topID: { nested: true } }, status: 400 },
    { name: 'refuses a caller without a relayed user token', method: 'POST', url: '/v1/sessions/current/admin-state', payload: { siteid: SITE_A }, status: 401 },
  ],
  login: [
    {
      name: 'answers csrf-invalid for a login without a token',
      method: 'POST',
      url: '/v1/sessions/login',
      headers: () => anonymousSession(ANONYMOUS_LOGIN.sessionId).then((h) => ({ ...h, ...FORM })),
      payload: `username=qa_editor&password=x&isAdminLogin=true`,
      status: 200,
      verify: (body) => expect(record(body).outcome).toBe('csrf-invalid'),
    },
    {
      name: 'logs the anonymous session in with valid credentials and token',
      method: 'POST',
      url: '/v1/sessions/login',
      headers: () => anonymousSession(ANONYMOUS_LOGIN.sessionId).then((h) => ({ ...h, ...FORM })),
      payload: `username=${EDITOR.account.username}&password=${EDITOR.plainPassword}&isAdminLogin=true&${csrfFields(ANONYMOUS_LOGIN.csrfSecret, 'login')}`,
      status: 200,
      verify: (body) => expect(record(body).outcome).toBe('success'),
    },
    { name: 'refuses a structured form value', method: 'POST', url: '/v1/sessions/login', payload: { username: { nested: true } }, status: 400 },
    {
      name: 'fails an MFA challenge attempt as legacy fails it',
      method: 'POST',
      url: '/v1/sessions/login',
      headers: () => anonymousSession(ANONYMOUS_CHALLENGE.sessionId).then((h) => ({ ...h, ...FORM })),
      payload: `attemptChallenge=true&${csrfFields(ANONYMOUS_CHALLENGE.csrfSecret, 'login')}`,
      status: 500,
    },
  ],
  logout: [
    { name: 'answers an anonymous logout with the home redirect', method: 'POST', url: '/v1/sessions/logout', status: 200 },
    {
      name: 'ends a signed-in session',
      method: 'POST',
      url: '/v1/sessions/logout',
      headers: () => relayedCredentials('gateway', { ...session('editor'), sessionId: LOGOUT_SESSION.sessionId }, [Roles.systemUser]),
      status: 200,
      verify: (body) => expect(record(body)).toEqual({ redirect: { action: 'home.redirect', params: {} } }),
    },
  ],
  issueCsrfTokens: [
    {
      name: 'issues one token per context',
      method: 'POST',
      url: '/v1/csrf/tokens',
      as: 'editor',
      payload: { contexts: ['cusers.update'] },
      status: 200,
      verify: (body) => expect(record(body).tokens).toEqual([expect.objectContaining({ context: 'cusers.update', ...{ csrf_token: csrfFor(session('editor'), 'cusers.update').token } })]),
    },
    { name: 'refuses an empty context list', method: 'POST', url: '/v1/csrf/tokens', as: 'editor', payload: { contexts: [] }, status: 400 },
    { name: 'refuses a caller without a session', method: 'POST', url: '/v1/csrf/tokens', payload: { contexts: ['x'] }, status: 401 },
  ],
  requestLoginMail: [
    {
      name: 'answers messagesent for a known address',
      method: 'POST',
      url: '/v1/login-mail',
      payload: { email: EDITOR.contact.email ?? '', siteid: SITE_A },
      status: 200,
      verify: (body) => expect(body).toEqual({ status: 'messagesent' }),
    },
    { name: 'refuses a request without an email', method: 'POST', url: '/v1/login-mail', payload: { siteid: SITE_A }, status: 400 },
  ],
  listGroups: [
    {
      name: 'lists the private-pool groups of tenant-a for s2',
      method: 'GET',
      url: '/v1/groups?ispublic=0',
      as: 's2',
      status: 200,
      verify: (body) => expect((record(body).items as Array<{ UserID: string }>).map((item) => item.UserID)).toContain(ADMIN_GROUP),
    },
    { name: 'refuses a caller without credentials', method: 'GET', url: '/v1/groups', status: 401 },
    { name: 'refuses a public-pool member', method: 'GET', url: '/v1/groups', as: 'member', status: 403 },
    { name: 'refuses a siteid other than the token site', method: 'GET', url: '/v1/groups?siteid=tenant-b', as: 's2', status: 403 },
  ],
  createGroup: [
    {
      name: 'creates a group with a valid token',
      method: 'POST',
      url: '/v1/groups',
      as: 'site-admin',
      headers: async () => FORM,
      payload: `userid=${NEW_GROUP}&groupname=Gates&ispublic=0&siteid=${SITE_A}&${csrfFields(session('site-admin').csrfSecret, NEW_GROUP)}`,
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ written: true, group: { UserID: NEW_GROUP, GroupName: 'Gates' } }),
    },
    {
      name: 'creates a group from the native multipart form, its id in the action-URL query',
      method: 'POST',
      url: NATIVE_GROUP_URL,
      as: 'site-admin',
      headers: () => Promise.resolve({ 'content-type': NATIVE_GROUP_POST.contentType }),
      payload: NATIVE_GROUP_POST.payload,
      status: 200,
      verify: (body) => {
        const request = { method: 'POST', path: NATIVE_GROUP_URL, contentType: NATIVE_GROUP_POST.contentType, body: NATIVE_GROUP_FIELDS };
        assertRequestMatchesOpenApi(DOC, request);
        expect(record(body)).toMatchObject({ written: true, group: { UserID: NATIVE_GROUP, GroupName: 'Natives' } });
      },
    },
    { name: 'refuses a posted id that is no CF UUID', method: 'POST', url: '/v1/groups', as: 's2', headers: async () => FORM, payload: 'userid=nope&groupname=x', status: 400 },
  ],
  getGroup: [
    {
      name: 'reads a stored group',
      method: 'GET',
      url: `/v1/groups/${ADMIN_GROUP}`,
      as: 's2',
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ isNew: false, group: { UserID: ADMIN_GROUP } }),
    },
    { name: 'reads an unknown id as a new group', method: 'GET', url: `/v1/groups/${UNKNOWN_ID}`, as: 's2', status: 200, verify: (body) => expect(record(body).isNew).toBe(true) },
    { name: 'refuses a malformed group id', method: 'GET', url: '/v1/groups/not-an-id', as: 's2', status: 400 },
  ],
  updateGroup: [
    {
      name: 'updates a group with a valid token',
      method: 'PUT',
      url: `/v1/groups/${EDITOR_GROUP}`,
      as: 's2',
      headers: async () => FORM,
      payload: `groupname=Editor&ispublic=0&siteid=${SITE_A}&${csrfFields(session('s2').csrfSecret, EDITOR_GROUP)}`,
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ written: true }),
    },
    { name: 'refuses the withheld photo variant', method: 'PUT', url: `/v1/groups/${EDITOR_GROUP}`, as: 's2', headers: async () => FORM, payload: 'groupname=Editor&newFile=photo.png', status: 400 },
  ],
  listGroupMembers: [
    {
      name: 'lists the members of the Editor group, with the photo extension strategies-content stores',
      method: 'GET',
      url: `/v1/groups/${EDITOR_GROUP}/members`,
      as: 's2',
      status: 200,
      verify: (body) =>
        expect(record(body).items).toEqual(expect.arrayContaining([expect.objectContaining({ userID: EDITOR.account.userid, PhotoFileID: EDITOR_PHOTO, photoFileExt: 'jpg' })])),
    },
    { name: 'refuses a caller holding only the Users grant', method: 'GET', url: `/v1/groups/${EDITOR_GROUP}/members`, as: 'users-module', status: 403 },
  ],
  downloadGroupMembers: [
    {
      name: 'downloads the members CSV',
      method: 'GET',
      url: `/v1/groups/${EDITOR_GROUP}/members.csv`,
      as: 'users-and-site-manager',
      status: 200,
      verify: (_body, res) => expect(String(res.headers['content-type'])).toMatch(/^text\/csv/),
    },
    { name: 'refuses a malformed group id', method: 'GET', url: '/v1/groups/x/members.csv', as: 's2', status: 400 },
  ],
  addGroupMember: [
    {
      name: 'adds a member with a valid token',
      method: 'POST',
      url: `/v1/groups/${EDITOR_GROUP}/members/${SITE_ADMIN_A.account.userid}`,
      headers: () => withCsrfHeaders('s2', `${SITE_ADMIN_A.account.userid}${EDITOR_GROUP}addtogroup`),
      status: 200,
      verify: (body) => expect(body).toEqual({ written: true }),
    },
    {
      name: 'writes nothing without a token',
      method: 'POST',
      url: `/v1/groups/${EDITOR_GROUP}/members/${ADMIN_S2.account.userid}`,
      as: 's2',
      status: 200,
      verify: (body) => expect(body).toEqual({ written: false }),
    },
  ],
  removeGroupMember: [
    {
      name: 'removes a member without a token, as legacy checks none',
      method: 'DELETE',
      url: `/v1/groups/${EDITOR_GROUP}/members/${SITE_ADMIN_A.account.userid}`,
      as: 's2',
      status: 200,
      verify: (body) => expect(body).toEqual({ written: true }),
    },
    { name: 'refuses a malformed user id', method: 'DELETE', url: `/v1/groups/${EDITOR_GROUP}/members/x`, as: 's2', status: 400 },
  ],
  listUserMemberships: [
    {
      name: "lists the editor's group ids and the site's pool groups",
      method: 'GET',
      url: `/v1/users/${EDITOR.account.userid}/memberships`,
      as: 'site-admin',
      status: 200,
      verify: (body) => expect(record(body).groupIds).toContain(EDITOR_GROUP),
    },
    { name: 'refuses a system user without a Users grant', method: 'GET', url: `/v1/users/${EDITOR.account.userid}/memberships`, as: 'system-user', status: 403 },
  ],
  getContentPermissions: [
    { name: 'reads the group verdicts of the home node', method: 'GET', url: `/v1/permissions/content/${HOME}`, as: 's2', status: 200, verify: (body) => expect(record(body).contentId).toBe(HOME) },
    { name: 'refuses a content id of the wrong length', method: 'GET', url: '/v1/permissions/content/short', as: 's2', status: 400 },
    { name: 'refuses an editor', method: 'GET', url: `/v1/permissions/content/${HOME}`, as: 'editor', status: 403 },
  ],
  getModulePermissions: [
    { name: 'reads the Users module grants', method: 'GET', url: `/v1/permissions/modules/${USERS_MODULE}`, as: 'site-admin', status: 200, verify: (body) => expect(record(body).moduleId).toBe(USERS_MODULE) },
    { name: 'refuses a caller without credentials', method: 'GET', url: `/v1/permissions/modules/${USERS_MODULE}`, status: 401 },
  ],
  updateModulePermissions: [
    {
      name: 'grants the Users module to the Editor group with a valid token',
      method: 'PUT',
      url: `/v1/permissions/modules/${USERS_MODULE}`,
      as: 's2',
      headers: async () => FORM,
      payload: `groupid=${EDITOR_GROUP}&moduleid=${USERS_MODULE}&${csrfFields(session('s2').csrfSecret, USERS_MODULE)}`,
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ written: true, redirect: { action: 'cUsers.list' } }),
    },
    { name: 'refuses a group id that is no CF UUID', method: 'PUT', url: `/v1/permissions/modules/${USERS_MODULE}`, as: 's2', payload: { groupid: ['x'] }, status: 400 },
  ],
  getReversePermLookUp: [
    { name: 'answers the lookup for a signed-in session', method: 'GET', url: '/v1/permissions/reverse-lookup', as: 'editor', status: 200, verify: (body) => expect(record(body)).toHaveProperty('granted') },
    { name: 'refuses a caller without credentials', method: 'GET', url: '/v1/permissions/reverse-lookup', status: 401 },
  ],
  listOAuthClients: [
    { name: 'lists the tenant-a clients for s2', method: 'GET', url: '/v1/oauth-clients', as: 's2', status: 200, verify: (body) => expect(record(body).items).toBeInstanceOf(Array) },
    { name: 'refuses a site admin', method: 'GET', url: '/v1/oauth-clients', as: 'site-admin', status: 403 },
  ],
  getOAuthClient: [
    { name: 'reads an unknown id as a new client', method: 'GET', url: `/v1/oauth-clients/${UNKNOWN_ID}`, as: 's2', status: 200, verify: (body) => expect(record(body).exists).toBe(false) },
    { name: 'refuses a malformed client id', method: 'GET', url: '/v1/oauth-clients/nope', as: 's2', status: 400 },
  ],
  saveOAuthClient: [
    {
      name: 'saves a client with a valid token',
      method: 'PUT',
      url: `/v1/oauth-clients/${NEW_CLIENT}`,
      headers: () => withCsrfHeaders('s2', NEW_CLIENT),
      payload: { siteid: SITE_A, name: 'Gates client', granttype: 'client_credentials' },
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ written: true, client: { clientid: NEW_CLIENT } }),
    },
    { name: 'refuses an unknown grant type', method: 'PUT', url: `/v1/oauth-clients/${NEW_CLIENT}`, as: 's2', payload: { siteid: SITE_A, granttype: 'nope' }, status: 400 },
  ],
  deleteOAuthClient: [
    {
      name: 'deletes the saved client with a valid token',
      method: 'DELETE',
      url: `/v1/oauth-clients/${NEW_CLIENT}`,
      // The save consumed the token issued at the clock's instant for this context.
      headers: () => withCsrfHeaders('s2', NEW_CLIENT, 1_000),
      status: 200,
      verify: (body) => expect(body).toEqual({ written: true }),
    },
    { name: 'refuses a system user', method: 'DELETE', url: `/v1/oauth-clients/${NEW_CLIENT}`, as: 'system-user', status: 403 },
  ],
  getJwks: [
    {
      name: 'publishes the local signing key',
      method: 'GET',
      url: '/.well-known/jwks.json',
      status: 200,
      verify: (body) => expect((record(body).keys as unknown[]).length).toBe(1),
    },
  ],
  healthz: [{ name: 'answers ok', method: 'GET', url: '/healthz', status: 200, verify: (body) => expect(body).toEqual({ status: 'ok' }) }],
  mintUserToken: [
    {
      name: "mints the s2 session's tenant-a token, verifiable against the JWKS",
      method: 'POST',
      url: '/internal/v1/tokens',
      as: 'service:gateway',
      payload: { sessionId: 'S-s2', siteId: SITE_A },
      status: 200,
      verify: async (body) => {
        const minted = record(body) as { token: string; claims: { sid: string; site: string; roles: string[] } };
        expect(minted.claims).toMatchObject({ sid: 'S-s2', site: SITE_A });
        expect(minted.claims.roles).toContain(Roles.s2);
        const verified = jwtVerify(minted.token, createLocalJWKSet(jwks), { issuer: 'opt2-local-identity', audience: 'opt2-local', currentDate: NOW });
        await expect(verified).resolves.toBeDefined();
      },
    },
    { name: 'refuses a body without a site', method: 'POST', url: '/internal/v1/tokens', as: 'service:gateway', payload: { sessionId: 'S-s2' }, status: 400 },
    { name: 'refuses a caller other than the gateway', method: 'POST', url: '/internal/v1/tokens', as: 'service:people', payload: { sessionId: 'S-s2', siteId: SITE_A }, status: 403 },
    { name: 'refuses reporting, whose export runs act as System', method: 'POST', url: '/internal/v1/tokens', as: 'service:reporting', payload: { sessionId: 'S-s2', siteId: SITE_A }, status: 403 },
    { name: 'refuses a call without an invocation credential', method: 'POST', url: '/internal/v1/tokens', payload: { sessionId: 'S-s2', siteId: SITE_A }, status: 401 },
  ],
  authenticateRequest: [
    {
      name: 'answers a REST request without credentials with the legacy refusal',
      method: 'POST',
      url: '/internal/v1/authenticate',
      as: 'service:gateway',
      payload: { method: 'GET', path: `/_api/rest/v1/${SITE_A}/group`, siteId: SITE_A, headers: {}, query: {} },
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ outcome: 'denied', sessionId: null, legacyResponse: { status: 401 } }),
    },
    { name: 'refuses a request description without a path', method: 'POST', url: '/internal/v1/authenticate', as: 'service:gateway', payload: { method: 'GET', headers: {}, query: {} }, status: 400 },
  ],
  adoptSession: [
    {
      name: 'adopts a described legacy session',
      method: 'POST',
      url: '/internal/v1/sessions:adopt',
      as: 'service:gateway',
      payload: {
        legacySessionId: 'L-gates-1',
        siteId: SITE_A,
        describe: { user: { isLoggedIn: false, userID: '' }, roles: [], csrfSecretKey: cfId('7', 1), usedTokens: [] },
      },
      status: 200,
      verify: (body) => expect(record(body).setCookie).toBeInstanceOf(Array),
    },
    { name: 'refuses an adopt without the description', method: 'POST', url: '/internal/v1/sessions:adopt', as: 'service:gateway', payload: { legacySessionId: 'L-x', siteId: SITE_A }, status: 400 },
  ],
  getSessionState: [
    { name: 'reports the s2 session active', method: 'GET', url: '/internal/v1/sessions/S-s2/state', as: 'service:gateway', status: 200, verify: (body) => expect(record(body).state).toBe('active') },
    { name: 'refuses a caller other than the gateway', method: 'GET', url: '/internal/v1/sessions/S-s2/state', as: 'service:web', status: 403 },
  ],
  getSessionAdminSite: [
    { name: "reports the session's selected site", method: 'GET', url: '/internal/v1/sessions/S-s2/admin-site', as: 'service:gateway', status: 200, verify: (body) => expect(record(body)).toHaveProperty('siteId') },
  ],
  getSessionSnapshot: [
    {
      name: 'returns the login snapshot of the s2 session',
      method: 'GET',
      url: '/internal/v1/sessions/S-s2/snapshot',
      as: 'service:gateway',
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ sessionId: 'S-s2', csrfSecretKey: session('s2').csrfSecret }),
    },
    { name: 'answers an unknown session with the 404 envelope', method: 'GET', url: '/internal/v1/sessions/S-unknown/snapshot', as: 'service:gateway', status: 404 },
  ],
  endSession: [
    {
      name: 'ends a session at logout',
      method: 'POST',
      url: `/internal/v1/sessions/${ENDED_SESSION.sessionId}:end`,
      as: 'service:gateway',
      payload: { reason: 'logout' },
      status: 200,
      verify: (body) => expect(record(body).ended).toBe(true),
    },
    { name: 'refuses a reason the contract does not name', method: 'POST', url: `/internal/v1/sessions/${ENDED_SESSION.sessionId}:end`, as: 'service:gateway', payload: { reason: 'nope' }, status: 400 },
  ],
  consumeCsrfToken: [
    {
      name: "consumes a valid token of the relayed user's session once",
      method: 'POST',
      url: '/internal/v1/csrf/consume',
      headers: relay('people', 'editor'),
      payload: { sessionId: 'S-editor', ...csrfFor(session('editor'), 'contract.consume'), context: 'contract.consume' },
      status: 200,
      verify: (body) => expect(body).toEqual({ valid: true }),
    },
    ...(['programs-sites', 'strategies-content'] as const).map(
      (caller): Case => ({
        name: `consumes a valid token for CSRF consumer ${caller}`,
        method: 'POST',
        url: '/internal/v1/csrf/consume',
        headers: relay(caller, 'editor'),
        payload: { sessionId: 'S-editor', ...csrfFor(session('editor'), `contract.consume.${caller}`), context: `contract.consume.${caller}` },
        status: 200,
        verify: (body) => expect(body).toEqual({ valid: true }),
      }),
    ),
    {
      name: 'refuses a session other than the relayed one',
      method: 'POST',
      url: '/internal/v1/csrf/consume',
      headers: relay('people', 'editor'),
      payload: { sessionId: 'S-s2', ...csrfFor(session('s2'), 'contract.consume'), context: 'contract.consume' },
      status: 403,
    },
    {
      name: 'refuses a consume without a relayed user token',
      method: 'POST',
      url: '/internal/v1/csrf/consume',
      as: 'service:people',
      payload: { sessionId: 'S-editor', token: 'T', expires: 'E', context: 'c' },
      status: 401,
    },
    { name: 'refuses a body without a context', method: 'POST', url: '/internal/v1/csrf/consume', headers: relay('people', 'editor'), payload: { sessionId: 'S-editor', token: 'T', expires: 'E' }, status: 400 },
  ],
  claimCsrfToken: [
    {
      name: 'takes a pending-legacy claim for a validating legacy request',
      method: 'POST',
      url: '/internal/v1/csrf/claims',
      as: 'service:gateway',
      payload: { sessionId: 'S-system-user', ...csrfFor(session('system-user'), 'contract.claim'), context: 'contract.claim' },
      status: 200,
      verify: (body) => expect(body).toEqual({ state: 'pending-legacy' }),
    },
    { name: 'refuses a claim without an expiry', method: 'POST', url: '/internal/v1/csrf/claims', as: 'service:gateway', payload: { sessionId: 'S-x', token: 'T', context: 'c' }, status: 400 },
  ],
  settleCsrfClaims: [
    {
      name: 'settles the consumed claim as used',
      method: 'POST',
      url: '/internal/v1/csrf/claims:settle',
      as: 'service:gateway',
      payload: { sessionId: 'S-system-user', consumed: [csrfFor(session('system-user'), 'contract.claim').token], released: [] },
      status: 200,
      verify: (body) => expect(body).toEqual({ used: 1, released: 0 }),
    },
    { name: 'refuses a settle without the released list', method: 'POST', url: '/internal/v1/csrf/claims:settle', as: 'service:gateway', payload: { sessionId: 'S-x', consumed: [] }, status: 400 },
  ],
  getAccountOperation: [
    {
      name: 'reads an operation identity never recorded as unknown',
      method: 'GET',
      url: operationUrl(NEW_USER, UNKNOWN_ID),
      headers: relay('people', 's2'),
      status: 200,
      verify: (body) => expect(record(body).state).toBe('unknown'),
    },
    { name: 'refuses a caller other than people', method: 'GET', url: operationUrl(NEW_USER, UNKNOWN_ID), as: 'service:gateway', status: 403 },
  ],
  prepareAccountOperation: [
    {
      name: 'prepares a roster create',
      method: 'POST',
      url: operationUrl(NEW_USER, OPERATION_ID, 'prepare'),
      headers: relay('people', 's2'),
      payload: PREPARE_BODY,
      status: 200,
      verify: (body) => expect(record(body).state).toBe('prepared'),
    },
    {
      name: 'answers a repeated prepare of the operation for another user with 409',
      method: 'POST',
      url: operationUrl(cfId('E', 906), OPERATION_ID, 'prepare'),
      headers: relay('people', 's2'),
      payload: { ...PREPARE_BODY, account: { ...PREPARE_BODY.account, UserName: 'gates_other_user' } },
      status: 409,
    },
    {
      name: 'prepares a second roster create, which a revert undoes',
      method: 'POST',
      url: operationUrl(REVERTED_USER, REVERTED_OPERATION, 'prepare'),
      headers: relay('people', 's2'),
      payload: { ...PREPARE_BODY, account: { ...PREPARE_BODY.account, UserName: 'gates_reverted_user' } },
      status: 200,
    },
    {
      name: 'prepares a roster update of an existing user',
      method: 'POST',
      url: operationUrl(EDITOR.account.userid, ABORTED_OPERATION, 'prepare'),
      headers: relay('people', 's2'),
      payload: { ...PREPARE_BODY, kind: 'update', account: { ...PREPARE_BODY.account, UserName: EDITOR.account.username } },
      status: 200,
    },
    {
      name: "answers a username already in the pool with legacy's validation errors",
      method: 'POST',
      url: operationUrl(cfId('E', 907), cfId('F', 907), 'prepare'),
      headers: relay('people', 's2'),
      payload: { ...PREPARE_BODY, account: { ...PREPARE_BODY.account, UserName: EDITOR.account.username } },
      status: 400,
    },
    {
      name: 'refuses a prepare body without the account',
      method: 'POST',
      url: operationUrl(NEW_USER, cfId('F', 908), 'prepare'),
      headers: relay('people', 's2'),
      payload: { kind: 'create', siteId: SITE_A, groupIds: [] },
      status: 400,
    },
  ],
  commitAccountOperation: [
    {
      name: 'commits the prepared create',
      method: 'POST',
      url: operationUrl(NEW_USER, OPERATION_ID, 'commit'),
      headers: relay('people', 's2'),
      status: 200,
      verify: (body) => expect(record(body).state).toBe('committed'),
    },
    {
      name: 'commits the second create',
      method: 'POST',
      url: operationUrl(REVERTED_USER, REVERTED_OPERATION, 'commit'),
      headers: relay('people', 's2'),
      status: 200,
    },
    { name: 'answers a commit of an unknown operation with 409', method: 'POST', url: operationUrl(NEW_USER, UNKNOWN_ID, 'commit'), headers: relay('people', 's2'), status: 409 },
  ],
  finishAccountOperation: [
    {
      name: 'finishes the committed create',
      method: 'POST',
      url: operationUrl(NEW_USER, OPERATION_ID, 'finish'),
      headers: relay('people', 's2'),
      status: 200,
      verify: (body) => expect(record(body).state).toBe('finished'),
    },
  ],
  abortAccountOperation: [
    {
      name: 'aborts a prepared update',
      method: 'POST',
      url: operationUrl(EDITOR.account.userid, ABORTED_OPERATION, 'abort'),
      headers: relay('people', 's2'),
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ operationId: ABORTED_OPERATION, state: 'aborted' }),
    },
  ],
  revertAccountOperation: [
    {
      name: 'reverts the committed second create',
      method: 'POST',
      url: operationUrl(REVERTED_USER, REVERTED_OPERATION, 'revert'),
      headers: relay('people', 's2'),
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ operationId: REVERTED_OPERATION, userId: REVERTED_USER }),
    },
    { name: 'answers a revert of an operation that never committed with 409', method: 'POST', url: operationUrl(NEW_USER, UNKNOWN_ID, 'revert'), headers: relay('people', 's2'), status: 409 },
  ],
  getAccount: [
    {
      name: "reads the editor's account record",
      method: 'GET',
      url: `/internal/v1/accounts/${EDITOR.account.userid}`,
      headers: relay('people', 'editor'),
      status: 200,
      verify: (body) => expect(JSON.stringify(body)).toContain(EDITOR.account.userid),
    },
    { name: 'answers an unknown user with the 404 envelope', method: 'GET', url: `/internal/v1/accounts/${UNKNOWN_ID}`, headers: relay('people', 'editor'), status: 404 },
  ],
  lookupAccounts: [
    {
      name: 'looks up the editor among unknown ids',
      method: 'POST',
      url: '/internal/v1/accounts:lookup',
      headers: relay('people', 'editor'),
      payload: { userIds: [EDITOR.account.userid, UNKNOWN_ID] },
      status: 200,
      verify: (body) => expect((record(body).items as unknown[]).length).toBe(1),
    },
    { name: 'refuses an empty id list', method: 'POST', url: '/internal/v1/accounts:lookup', headers: relay('people', 'editor'), payload: { userIds: [] }, status: 400 },
  ],
  lookupAccountsAllSites: [
    {
      name: 'looks up accounts stored under every registered site for an S2 user, in request order',
      method: 'POST',
      url: '/internal/v1/accounts:lookup-all-sites',
      headers: relay('people', 's2'),
      payload: { userIds: [MEMBER_B.account.userid, ADMIN_S2.account.userid, UNKNOWN_ID, EDITOR.account.userid] },
      status: 200,
      verify: (body) =>
        expect((record(body).items as Array<{ UserID: string }>).map((item) => item.UserID)).toEqual([
          MEMBER_B.account.userid,
          ADMIN_S2.account.userid,
          EDITOR.account.userid,
        ]),
    },
    {
      name: 'refuses a user token without the s2 claim',
      method: 'POST',
      url: '/internal/v1/accounts:lookup-all-sites',
      headers: relay('people', 'editor'),
      payload: { userIds: [EDITOR.account.userid] },
      status: 403,
    },
  ],
  countAccounts: [
    {
      name: "counts the active accounts of tenant-a's private pool",
      method: 'POST',
      url: '/internal/v1/accounts:count',
      headers: relay('people', 'editor'),
      payload: { scope: 'pool', publicPool: false },
      status: 200,
      verify: (body) => expect(body).toEqual({ count: activePoolAccounts(TENANT_A.tenantId, SITE_A) }),
    },
    { name: 'refuses an all-sites count for a user token without the s2 claim', method: 'POST', url: '/internal/v1/accounts:count', headers: relay('people', 'editor'), payload: { scope: 'all-sites' }, status: 403 },
    { name: 'refuses a pool count without publicPool', method: 'POST', url: '/internal/v1/accounts:count', headers: relay('people', 'editor'), payload: { scope: 'pool' }, status: 400 },
  ],
  lookupUsernameCandidates: [
    {
      name: 'lists the private-pool accounts whose user name matches, folding ASCII case',
      method: 'POST',
      url: '/internal/v1/accounts:username-candidates',
      headers: relay('people', 'editor'),
      payload: { publicPool: false, pattern: 'QA_%', limit: 10 },
      status: 200,
      verify: (body) => expect(body).toEqual({ items: [{ userId: EDITOR.account.userid, username: EDITOR.account.username }], complete: true }),
    },
    {
      name: 'answers more matches than the limit as incomplete',
      method: 'POST',
      url: '/internal/v1/accounts:username-candidates',
      headers: relay('people', 'editor'),
      payload: { publicPool: false, pattern: 'synthetic%', limit: 1 },
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ items: [{ username: expect.stringMatching(/^synthetic_/) as unknown }], complete: false }),
    },
    {
      name: 'refuses a limit below one',
      method: 'POST',
      url: '/internal/v1/accounts:username-candidates',
      headers: relay('people', 'editor'),
      payload: { publicPool: false, pattern: '%', limit: 0 },
      status: 400,
    },
  ],
  lookupMemberships: [
    {
      name: "reads the editor's membership rows and none for an unknown user",
      method: 'POST',
      url: '/internal/v1/accounts:memberships',
      headers: relay('people', 'editor'),
      payload: { userIds: [EDITOR.account.userid, UNKNOWN_ID] },
      status: 200,
      verify: (body) =>
        expect(body).toEqual({
          items: [
            { userId: EDITOR.account.userid, groupIds: [EDITOR_GROUP] },
            { userId: UNKNOWN_ID, groupIds: [] },
          ],
        }),
    },
    { name: 'refuses an empty id list', method: 'POST', url: '/internal/v1/accounts:memberships', headers: relay('people', 'editor'), payload: { userIds: [] }, status: 400 },
  ],
  loadLoginBlock: [
    {
      name: "reads the editor's user name as unblocked",
      method: 'POST',
      url: `/internal/v1/accounts/${EDITOR.account.userid}/login-block`,
      headers: relay('people', 'editor'),
      payload: { removeBlock: false },
      status: 200,
      verify: (body) => expect(body).toEqual({ blockedUntil: null }),
    },
    {
      name: 'reads the end of the block of a user name past the allowed strikes',
      method: 'POST',
      url: `/internal/v1/accounts/${SITE_ADMIN_A.account.userid}/login-block`,
      headers: relay('people', 'editor'),
      payload: { removeBlock: false },
      status: 200,
      verify: (body) => expect(body).toEqual({ blockedUntil: BLOCKED_UNTIL }),
    },
    {
      name: 'clears the block on removeBlock',
      method: 'POST',
      url: `/internal/v1/accounts/${SITE_ADMIN_A.account.userid}/login-block`,
      headers: relay('people', 'editor'),
      payload: { removeBlock: true },
      status: 200,
      verify: (body) => expect(body).toEqual({ blockedUntil: null }),
    },
    {
      name: 'answers an unknown user with the 404 envelope',
      method: 'POST',
      url: `/internal/v1/accounts/${UNKNOWN_ID}/login-block`,
      headers: relay('people', 'editor'),
      payload: { removeBlock: false },
      status: 404,
    },
    {
      name: 'refuses a body without removeBlock',
      method: 'POST',
      url: `/internal/v1/accounts/${EDITOR.account.userid}/login-block`,
      headers: relay('people', 'editor'),
      payload: {},
      status: 400,
    },
  ],
  listSiteGroups: [
    {
      name: "lists tenant-a's private-pool groups",
      method: 'GET',
      url: '/internal/v1/groups?ispublic=0',
      headers: relay('people', 'editor'),
      status: 200,
      verify: (body) => expect(JSON.stringify(body)).toContain(ADMIN_GROUP),
    },
    { name: 'refuses a list without ispublic', method: 'GET', url: '/internal/v1/groups', headers: relay('people', 'editor'), status: 400 },
  ],
};

/** The tenant-a `programs-sites.site.changed.v1` delivery of the platform fixture registry. */
function siteChangedEnvelope() {
  const payload = registryPayloads().find(({ siteId }) => siteId === SITE_A);
  if (payload === undefined) throw new TypeError(`registryPayloads has no ${SITE_A} entry`);
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: SITE_A, aggregateVersion: 1, payload });
}

/** The editor's `people.person.changed.v1` state, every field the contact consumer stores set. */
function personChangedEnvelope() {
  const { account, contact } = EDITOR;
  const payload: PersonChangedPayload = {
    userId: account.userid,
    siteId: SITE_A,
    deleted: false,
    groupName: null,
    fname: contact.fname ?? null,
    lname: contact.lname ?? null,
    email: contact.email ?? null,
    company: contact.company ?? null,
    jobTitle: 'Editor',
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
    created: '2026-06-30 11:59:00.000',
    lastUpdate: '2026-06-30 12:00:00.000',
    lastUpdateBy: 'Admin User',
    lastUpdateById: ADMIN_S2.account.userid,
  };
  return testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: account.userid, aggregateVersion: 1, payload });
}

/** Committed writes of the harness's database to `table`. */
function writesTo(harness: Harness, table: string): number {
  return harness.db.writes().filter((write) => write.table === table).length;
}

const tasksInvoker = async (): Promise<Headers> => ({ authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}` });
const queueUrl = (queue: string, action: 'pause' | 'resume' | 'ensure'): string => `/internal/v1/task-queues/${queue}/${action}`;

/** Cases of the operations only the composition root registers, through the platform's migration, push, sweep and queue registrars. */
const ROOT_CASES: Record<string, Case[]> = {
  migrationApply: [
    {
      name: 'applies a zero-row tpermissions batch for the migration service',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: { batchId: 'contract-1', origin: 'backfill', legacyTable: 'tpermissions', siteId: SITE_A, columns: TPERMISSIONS_COLUMNS, rows: [] },
      status: 200,
      verify: (body) => expect(body).toEqual({ batchId: 'contract-1', duplicate: false, applied: 0, skipped: 0 }),
    },
    {
      name: 'rejects a batch whose columns omit an owned column',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 'service:migration',
      payload: { batchId: 'contract-2', origin: 'backfill', legacyTable: 'tpermissions', siteId: SITE_A, columns: TPERMISSIONS_COLUMNS.slice(0, 1), rows: [] },
      status: 400,
    },
    {
      name: 'refuses a user token without platform.migration',
      method: 'POST',
      url: '/internal/v1/migration/apply',
      as: 's2',
      payload: { batchId: 'contract-3', origin: 'backfill', legacyTable: 'tpermissions', siteId: SITE_A, columns: TPERMISSIONS_COLUMNS, rows: [] },
      status: 403,
    },
  ],
  migrationExport: [
    {
      name: 'exports the tenant-a permissions in canonical legacy form',
      method: 'GET',
      url: `/internal/v1/migration/export?unit=identity.permission&siteId=${SITE_A}`,
      as: 'service:migration',
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ unit: 'identity.permission', tenantId: TENANT_A.tenantId }),
    },
  ],
  migrationChanges: [
    {
      name: 'reads an empty changelog page of tenant-a',
      method: 'GET',
      url: `/internal/v1/migration/changes?siteId=${SITE_A}`,
      as: 'service:migration',
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ rows: [], complete: true }),
    },
  ],
  migrationPosition: [
    {
      name: 'reports the write position and drain counts',
      method: 'GET',
      url: '/internal/v1/migration/position',
      as: 'service:migration',
      status: 200,
      verify: (body) => expect(record(body).owner).toBe(SERVICE),
    },
  ],
  migrationWatermarkGet: [
    {
      name: 'lists the tpermissions watermarks',
      method: 'GET',
      url: '/internal/v1/migration/watermark?legacyTable=tpermissions&direction=forward',
      as: 'service:migration',
      status: 200,
      verify: (body) => expect(body).toEqual([]),
    },
  ],
  migrationWatermarkPost: [
    {
      name: 'records a forward tpermissions watermark',
      method: 'POST',
      url: '/internal/v1/migration/watermark',
      as: 'service:migration',
      payload: { legacyTable: 'tpermissions', direction: 'forward', snapshotSeq: 1, backupLsn: '42', finishedAt: '2026-06-30 12:00:00' },
      // RETURNING formats finished_at with to_char, as PostgreSQL would for the posted time.
      setup: (db) =>
        db.respond(/^INSERT INTO "identity"\."migration_watermark"/, (_sql, values) => [
          { legacy_table: values[0], direction: values[1], snapshot_seq: String(values[2]), backup_lsn: values[3], finished_at: '2026-06-30T12:00:00.000' },
        ]),
      status: 200,
      verify: (body) =>
        expect(body).toEqual({ legacyTable: 'tpermissions', direction: 'forward', snapshotSeq: 1, backupLsn: '42', finishedAt: '2026-06-30T12:00:00.000' }),
    },
  ],
  migrationGate: [
    {
      name: 'reads the gate of identity.permission',
      method: 'POST',
      url: '/internal/v1/migration/gate',
      as: 'service:migration',
      payload: { op: 'status', units: ['identity.permission'] },
      status: 200,
      verify: (body) => expect(record(body).units).toEqual([{ unit: 'identity.permission', state: 'open', holderId: null, phase: 'quiet' }]),
    },
  ],
  pushSiteChanged: [
    {
      name: 'applies a site.changed delivery to the tenant registry and acks it',
      method: 'POST',
      url: `/internal/v1/events/${SITE_SUBSCRIPTION}`,
      push: { subscription: SITE_SUBSCRIPTION, envelope: siteChangedEnvelope },
      status: 204,
      verify: (_body, _res, harness) => {
        expect(writesTo(harness, 'identity.tenant_registry')).toBeGreaterThan(0);
        expect(harness.publisher?.deadLetters(SITE_SUBSCRIPTION)).toEqual([]);
      },
    },
    {
      name: 'dead-letters and acks a delivery without a tenant',
      method: 'POST',
      url: `/internal/v1/events/${SITE_SUBSCRIPTION}`,
      push: { subscription: SITE_SUBSCRIPTION, envelope: () => withoutTenant(siteChangedEnvelope()) },
      status: 204,
      verify: (_body, _res, harness) => {
        expect(harness.publisher?.deadLetters(SITE_SUBSCRIPTION)).toHaveLength(1);
        expect(writesTo(harness, 'identity.tenant_registry')).toBe(0);
      },
    },
  ],
  pushPersonChanged: [
    {
      name: "stores the editor's contact from a person.changed delivery and acks it",
      method: 'POST',
      url: `/internal/v1/events/${PERSON_CONTACT_SUBSCRIPTION}`,
      push: { subscription: PERSON_CONTACT_SUBSCRIPTION, envelope: personChangedEnvelope },
      status: 204,
      verify: (_body, _res, harness) => {
        expect(writesTo(harness, 'identity.person_contact')).toBeGreaterThan(0);
        expect(harness.publisher?.deadLetters(PERSON_CONTACT_SUBSCRIPTION)).toEqual([]);
      },
    },
  ],
  outboxSweep: [
    {
      name: 'creates the next sweep task, then sweeps every registered tenant',
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      headers: tasksInvoker,
      payload: SWEEP_TASK,
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ failed: 0, tenants: REGISTRY_ROWS.length }),
    },
    { name: 'refuses a user token on the cloud-tasks route', method: 'POST', url: '/internal/v1/outbox/sweep', as: 's2', payload: SWEEP_TASK, status: 401 },
  ],
  pauseTaskQueue: [
    {
      name: 'pauses the outbox-sweep queue for the operator',
      method: 'POST',
      url: queueUrl(SWEEP_QUEUE, 'pause'),
      as: 'service:operator',
      status: 200,
      verify: (body) => expect(body).toEqual({ queue: SWEEP_QUEUE, service: SERVICE, paused: true, running: 0 }),
    },
  ],
  resumeTaskQueue: [
    {
      name: 'resumes the outbox-sweep queue for the migration service',
      method: 'POST',
      url: queueUrl(SWEEP_QUEUE, 'resume'),
      as: 'service:migration',
      status: 200,
      verify: (body) => expect(body).toEqual({ queue: SWEEP_QUEUE, service: SERVICE, paused: false }),
    },
  ],
  ensureTaskQueue: [
    {
      name: 'finds the live outbox-sweep chain task',
      method: 'POST',
      url: queueUrl(SWEEP_QUEUE, 'ensure'),
      as: 'service:operator',
      status: 200,
      verify: (body) => expect(record(body)).toMatchObject({ queue: SWEEP_QUEUE, ensured: { created: false, reason: 'live' } }),
    },
    { name: 'rejects a queue identity runs no chain on', method: 'POST', url: queueUrl('surveys-launch', 'ensure'), as: 'service:operator', status: 400 },
  ],
};

/** A JSON API request as `routeKeyForRequest` reads it. */
interface KeyedRequest {
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, string>;
  payload?: string;
}

const keyedGet = (path: string, query: Record<string, string> = {}): KeyedRequest => ({ method: 'GET', path, query });

/** The request under JSON API path `base` that legacy keys to `body`: the entity route of a group operation, the REST credential path, else the `method` parameter. */
function keyedRequest(base: string, body: string): KeyedRequest {
  const group = `${base}/group`;
  const forms: Readonly<Record<string, KeyedRequest>> = {
    'group.findall': keyedGet(group),
    'group.findmany': keyedGet(group, { id: `${ADMIN_GROUP},${EDITOR_GROUP}` }),
    'group.findnew': keyedGet(`${group}/new`),
    'group.findone': keyedGet(`${group}/${ADMIN_GROUP}`),
    'group.findpermissions': keyedGet(`${group}/${ADMIN_GROUP}/permissions`),
    'group.findproperties': keyedGet(`${group}/properties`),
    'group.findquery': keyedGet(group, { groupname: 'Admin' }),
    'group.save': { method: 'POST', path: group, query: {} },
    'group.validate': keyedGet(`${base}/validate`, { entityname: 'group', data: '{}' }),
    oauth: keyedGet(`${base}/oauth`),
    oauth2: keyedGet(`${base}/oauth2`),
    tokeninfo: keyedGet(`${base}/tokeninfo`, { access_token: 'unknown', client_id: 'unknown' }),
  };
  const form = forms[body];
  if (form !== undefined) return form;
  if (body.includes('.')) throw new TypeError(`No request form keys the entity operation ${body}`);
  return keyedGet(base, { method: body });
}

function keyedUrl({ path, query }: KeyedRequest): string {
  const search = new URLSearchParams(query).toString();
  return search === '' ? path : `${path}?${search}`;
}

/** Whether `res` is legacy-api's answer to a route key identity does not serve: the `mura404` invalidMethodCall envelope. */
function isUnservedAnswer(res: InjectResponse): boolean {
  if (res.statusCode !== 404) return false;
  const body = JSON.parse(res.body) as { error?: { code?: string; message?: string } };
  return body.error?.code === 'invalid_request' && body.error.message === 'Invalid method call';
}

/** JSON API operations: those under `/_api/`. */
const WIRE_OPERATIONS = OPERATIONS.filter(({ path }) => path.startsWith('/_api/'));

const routeKeysOf = ({ op }: ContractOperation): string[] => (op['x-opt2-route-keys'] as string[] | undefined) ?? [];

/** Each declared route key with the base path of every family whose operations declare it. */
const SERVED_KEY_ROWS = [
  ...new Map(
    WIRE_OPERATIONS.flatMap((operation) => {
      const family = operation.path.split('/')[2] ?? '';
      const base = `/_api/${family}/v1/${SITE_A}`;
      return routeKeysOf(operation).map((key): [string, { key: string; base: string }] => [`${key} ${base}`, { key, base }]);
    }),
  ).values(),
];

/** Keys identity does not serve, each with a request keyed to it; the photo variant of a served key included. */
const UNSERVED_REQUESTS: ReadonlyArray<{ key: string; baseKey: string; request: KeyedRequest }> = [
  { key: 'api:user.save', baseKey: 'api:user.save', request: { method: 'POST', path: `/_api/json/v1/${SITE_A}/user`, query: {} } },
  { key: 'api:content.findone', baseKey: 'api:content.findone', request: keyedGet(`/_api/json/v1/${SITE_A}/content/${HOME}`) },
  {
    key: 'api:group.save{photo}',
    baseKey: 'api:group.save',
    request: { method: 'POST', path: `/_api/json/v1/${SITE_A}/group`, query: {}, payload: 'groupname=Gates&type=1&newFile=photo.png' },
  },
];

/** Headers of the s2 subject posting a form with the CSRF token of `context`. */
const csrfForm = (context: string) => (): Promise<Headers> => withCsrfHeaders('s2', context).then((headers) => ({ ...headers, ...FORM }));

/** Legacy error shapes, each on an app of its own. */
const ERROR_CASES: ErrorCase[] = [
  {
    name: '400 invalidTokens for a browser-mode group save without CSRF tokens',
    method: 'POST',
    url: `/_api/json/v1/${SITE_A}/group`,
    as: 's2',
    headers: async () => FORM,
    payload: 'groupname=Gates&type=1&ispublic=0',
    status: 400,
    verify: (body) => expect(body).toMatchObject({ apiversion: 'v1', method: 'save', error: { code: 'invalid_request', message: 'Invalid CSRF tokens' } }),
  },
  {
    name: '401 invalid_token with its WWW-Authenticate challenge for a REST request with an unknown bearer token',
    method: 'GET',
    url: '/_api/rest/v1/default/group/properties',
    headers: async () => ({
      authorization: 'Bearer not-a-user-token',
      [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
    }),
    status: 401,
    verify: (body, res) => {
      expect(body).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_token', message: 'Invalid Access Token' } });
      expect(Object.values(WWW_AUTHENTICATE)).toContain(res.headers['www-authenticate']);
    },
  },
  {
    name: '403 deny by default of a /v1 admin route for an editor, as the legacy envelope',
    method: 'GET',
    url: '/v1/groups',
    as: 'editor',
    status: 403,
    verify: (body) => expect(body).toEqual({ apiversion: 'v1', method: 'invalid', error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } }),
  },
  {
    name: '403 with the validation errors in data for a group save marked as spam',
    method: 'POST',
    url: `/_api/json/v1/${SITE_A}/group`,
    headers: csrfForm('new'),
    payload: 'groupname=Spam&type=1&ispublic=0&passedProtect=false',
    status: 403,
    verify: (body) => expect(record(record(body).data).errors).toHaveProperty('spam'),
  },
  {
    name: '404 envelope for a JSON API key identity does not serve',
    method: 'GET',
    url: `/_api/json/v1/${SITE_A}/content/${HOME}`,
    as: 's2',
    status: 404,
    verify: (body) => expect(body).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid method call' } }),
  },
  {
    name: '200 ended, the answer the contract declares instead of a 404, for the state of an unknown session',
    method: 'GET',
    url: '/internal/v1/sessions/S-unknown/state',
    as: 'service:gateway',
    status: 200,
    verify: (body) => expect(record(body)).toMatchObject({ state: 'ended', epoch: 0 }),
  },
  {
    name: '200 from the composition root for a group read the database answers',
    root: true,
    method: 'GET',
    url: `/_api/json/v1/${SITE_A}/group/${ADMIN_GROUP}`,
    as: 's2',
    status: 200,
  },
  {
    name: '500 server_error for the same group read failing with an unexpected database error',
    root: true,
    setup: (db) =>
      db.respond(/"identity"\."group_account"/, () => {
        throw new Error('forced read failure');
      }),
    method: 'GET',
    url: `/_api/json/v1/${SITE_A}/group/${ADMIN_GROUP}`,
    as: 's2',
    status: 500,
    verify: (body) => expect(body).toEqual(serverError('findOne')),
  },
  {
    name: '503 legacy envelope for a JSON API group save while identity.group_account is legacy-authoritative',
    setup: (db) => db.setGate('identity.group_account', 'legacy'),
    method: 'POST',
    url: `/_api/json/v1/${SITE_A}/group`,
    headers: csrfForm('new'),
    payload: 'groupname=Gates&type=1&ispublic=0',
    status: 503,
    verify: (body) => expect(body).toMatchObject({ apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } }),
  },
  {
    name: '503 legacy envelope for an admin group create while identity.group_account is legacy-authoritative',
    setup: (db) => db.setGate('identity.group_account', 'legacy'),
    method: 'POST',
    url: '/v1/groups',
    as: 'site-admin',
    headers: async () => FORM,
    payload: `userid=${NEW_GROUP}&groupname=Gates&ispublic=0&siteid=${SITE_A}&${csrfFields(session('site-admin').csrfSecret, NEW_GROUP)}`,
    status: 503,
    verify: (body) => expect(body).toMatchObject({ apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } }),
  },
  {
    name: '503 legacy envelope once the closed-user budget runs out, for an add to group of a user an open account operation holds',
    setup: (db) =>
      db.respond(OPEN_OPERATION_SQL, [
        { tenant_id: SITE_ADMIN_A.tenant.tenantId, operation_id: cfId('F', 990), user_id: SITE_ADMIN_A.account.userid, kind: 'update', state: 'prepared' },
      ]),
    method: 'POST',
    url: `/v1/groups/${EDITOR_GROUP}/members/${SITE_ADMIN_A.account.userid}`,
    headers: () => withCsrfHeaders('s2', `${SITE_ADMIN_A.account.userid}${EDITOR_GROUP}addtogroup`),
    status: 503,
    // The composed routes wait on an injected sleep, so the budget elapses without wall-clock time.
    withinMs: USER_CLOSED_WAIT_MS,
    verify: (body, _res, harness) => {
      expect(body).toMatchObject({ apiversion: 'v1', error: { message: 'Unhandled Exception', code: 'server_error' } });
      expect(harness.db.statements().filter(({ sql }) => OPEN_OPERATION_SQL.test(sql)).length).toBeGreaterThan(1);
    },
  },
];

/** The composition root over the test fakes, its tenant registry answered from REGISTRY_ROWS, ready. */
async function rootHarness(): Promise<RootHarness> {
  const built = await buildTestApp({ env: QUIET_ENV });
  built.db.respond(REGISTRY_SQL, registryAnswer);
  await built.app.ready();
  return { app: built.app, db: built.db, publisher: built.publisher, close: () => built.app.close() };
}

let t: IdentityTestApp;
let root: RootHarness;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  t = await buildIdentityApp(defaultSeed({ sessions: EXTRA_SESSIONS, strikes: [BLOCKED_STRIKE], personContacts: CONTACTS }));
  t.content.files.set(EDITOR_PHOTO, 'jpg');
  jwks = (await t.app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json<JSONWebKeySet>();
  root = await rootHarness();
});

afterAll(async () => {
  await t?.close();
  await root?.close();
});

/** Prepares `harness` for `c`, sends it, asserts its status, validates the response against the operation it addresses, then runs its checks. */
async function sendCase(harness: Harness, c: Case): Promise<void> {
  c.setup?.(harness.db);
  const headers = { ...(c.as === undefined ? {} : await credentialsFor(subjectNamed(c.as))), ...(c.headers === undefined ? {} : await c.headers()) };
  const res =
    c.push === undefined
      ? await harness.app.inject({ method: c.method, url: c.url, headers, ...(c.payload === undefined ? {} : { payload: c.payload }) })
      : await pushTo(harness.app, c.push.subscription, c.push.envelope());
  const contentType = res.headers['content-type'];
  const json = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) && res.body !== '';
  const body: unknown = json ? JSON.parse(res.body) : res.body === '' ? undefined : res.body;
  expect(res.statusCode, res.body.slice(0, 400)).toBe(c.status);
  assertResponseMatchesOpenApi(DOC, { method: c.method, path: c.url.split('?')[0] ?? c.url, status: res.statusCode, contentType, body });
  await c.verify?.(body, res, harness);
}

describe('contract document', () => {
  it('carries the pinned source SHA, OpenAPI 3.1.0 and version 1.0.0', () => {
    expect([DOC.openapi, DOC.info.version, DOC.info['x-source-sha']]).toEqual(['3.1.0', '1.0.0', PIN.sha]);
  });

  it('gives every operation a unique operationId', () => {
    const ids = OPERATIONS.map(({ operationId }) => operationId);
    expect(ids.filter((id) => id === '')).toEqual([]);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('declares on every operation the transport its path takes and exactly one of x-opt2-requires and x-opt2-public', () => {
    const problems = OPERATIONS.flatMap(({ method, path, op }) => {
      const requires = op['x-opt2-requires'];
      const isPublic = op['x-opt2-public'] === true;
      const found: string[] = [];
      if (!TRANSPORTS.includes(String(op['x-opt2-transport']))) found.push(`${method} ${path}: unknown transport ${String(op['x-opt2-transport'])}`);
      if (op['x-opt2-transport'] !== transportForPath(path)) found.push(`${method} ${path}: transport ${String(op['x-opt2-transport'])}`);
      if ((requires === undefined) === !isPublic) found.push(`${method} ${path}: requires and public`);
      if (requires !== undefined && !(Array.isArray(requires) && requires.length > 0)) found.push(`${method} ${path}: empty requires`);
      return found;
    });
    expect(problems).toEqual([]);
  });
});

describe('toOpenApiPath', () => {
  it.each([
    ['/internal/v1/sessions::adopt', '/internal/v1/sessions:adopt'],
    ['/internal/v1/sessions/:sid(.+)::end', '/internal/v1/sessions/{sid}:end'],
    ['/internal/v1/csrf/claims::settle', '/internal/v1/csrf/claims:settle'],
    ...['prepare', 'commit', 'abort', 'finish', 'revert'].map((step) => [
      `/internal/v1/accounts/:userId/operations/:operationId(.+)::${step}`,
      `/internal/v1/accounts/{userId}/operations/{operationId}:${step}`,
    ]),
    ['/v1/groups/:groupId/members/:userId', '/v1/groups/{groupId}/members/{userId}'],
    ['/_api/json/v1*', '/_api/json/v1*'],
  ])('maps %s to %s', (fastifyUrl, openApiPath) => {
    expect(toOpenApiPath(fastifyUrl)).toBe(openApiPath);
  });
});

describe('registered routes of the composition root', () => {
  it('are exactly the contract operations', () => {
    expect(diffRouteSets(servedRoutes(root.app), OPERATIONS)).toEqual({ undeclared: [], unregistered: [] });
  });

  it('each declare the transport, roles and public flag of every operation they serve', () => {
    const mismatches = servedRoutes(root.app).flatMap((route) =>
      OPERATIONS.filter((operation) => operationRouteKeys(operation).includes(routeKey(route)))
        .filter((operation) => JSON.stringify(contractDeclaration(operation)) !== JSON.stringify(declared(route)))
        .map((operation) => `${operation.operationId} ${routeKey(route)}: ${JSON.stringify(declared(route))}`),
    );
    expect(mismatches).toEqual([]);
  });

  it('take the transport their path implies, push routes for the Pub/Sub invoker and the sweep for the tasks invoker', () => {
    const routes = servedRoutes(root.app);
    expect(routes.filter((route) => route.transport !== transportForPath(route.url)).map(routeKey)).toEqual([]);
    const managed = routes.filter(({ url }) => url.startsWith('/internal/v1/events/') || url === '/internal/v1/outbox/sweep');
    expect(managed.map(({ url, transport, requires }) => ({ url, transport, requires }))).toEqual(
      managed.map(({ url }) =>
        url === '/internal/v1/outbox/sweep'
          ? { url, transport: 'cloud-tasks', requires: ['service:tasks-invoker'] }
          : { url, transport: 'pubsub-push', requires: ['service:pubsub-invoker'] },
      ),
    );
    expect(managed.map(({ url }) => url).sort()).toEqual(
      [`/internal/v1/events/${PERSON_CONTACT_SUBSCRIPTION}`, `/internal/v1/events/${SITE_SUBSCRIPTION}`, '/internal/v1/outbox/sweep'].sort(),
    );
  });

  it('report a removed operation, a missing route and an extra route by name', () => {
    const routes = servedRoutes(root.app);
    const trimmed = structuredClone(DOC);
    delete trimmed.paths['/healthz']?.get;
    expect(diffRouteSets(routes, contractOperations(trimmed))).toEqual({ undeclared: ['GET /healthz'], unregistered: [] });

    const withoutHealth = routes.filter(({ url }) => url !== '/healthz');
    expect(diffRouteSets(withoutHealth, OPERATIONS)).toEqual({ undeclared: [], unregistered: ['healthz (GET /healthz)'] });

    const extra: RouteMatrixEntry = { method: 'GET', url: '/v1/groups/:groupId/extra', transport: 'service', requires: [Roles.s2], siteCheck: true };
    expect(diffRouteSets([...routes, extra], OPERATIONS)).toEqual({ undeclared: ['GET /v1/groups/{groupId}/extra'], unregistered: [] });
  });
});

describe('JSON API route keys', () => {
  let keyed: IdentityTestApp;

  beforeAll(async () => {
    keyed = await buildIdentityApp(defaultSeed());
  });

  afterAll(async () => {
    await keyed?.close();
  });

  it('are declared on every /_api/ operation and on no other', () => {
    expect(WIRE_OPERATIONS.filter((operation) => routeKeysOf(operation).length === 0).map(({ operationId }) => operationId)).toEqual([]);
    expect(OPERATIONS.filter((operation) => !WIRE_OPERATIONS.includes(operation) && operation.op['x-opt2-route-keys'] !== undefined).map(({ operationId }) => operationId)).toEqual(
      [],
    );
  });

  it('are canonical, carry no photo variant and address only the group entity', () => {
    const keys = [...new Set(WIRE_OPERATIONS.flatMap(routeKeysOf))];
    const malformed = keys.filter((key) => key !== normaliseRouteKey(key) || !/^(?:api|rest):[a-z0-9_.!-]+(?:\{[a-z0-9_=,]+\})?$/.test(key));
    const photo = keys.filter((key) => key.includes('{photo}'));
    const foreign = keys.filter((key) => {
      const body = key.slice(key.indexOf(':') + 1);
      return body.includes('.') && !body.startsWith('group.');
    });
    expect({ malformed, photo, foreign }).toEqual({ malformed: [], photo: [], foreign: [] });
  });

  it.each(SERVED_KEY_ROWS)('serves $key under $base', async ({ key, base }) => {
    const request = keyedRequest(base, key.slice(key.indexOf(':') + 1));
    expect(routeKeyForRequest({ method: request.method, path: request.path, query: request.query, headers: {} }).key).toBe(key);
    const res = await keyed.app.inject({ method: request.method, url: keyedUrl(request), headers: await credentialsFor(subjectNamed('s2')) });
    expect(isUnservedAnswer(res), `${String(res.statusCode)} ${res.body.slice(0, 300)}`).toBe(false);
  });

  it.each(UNSERVED_REQUESTS)('answers $key with the legacy 404 envelope', async ({ key, baseKey, request }) => {
    expect(WIRE_OPERATIONS.flatMap(routeKeysOf)).not.toContain(key);
    expect(routeKeyForRequest({ method: request.method, path: request.path, query: request.query, headers: {} }).key).toBe(baseKey);
    const res = await keyed.app.inject({
      method: request.method,
      url: keyedUrl(request),
      headers: { ...(await credentialsFor(subjectNamed('s2'))), ...(request.payload === undefined ? {} : FORM) },
      ...(request.payload === undefined ? {} : { payload: request.payload }),
    });
    expect(isUnservedAnswer(res), `${String(res.statusCode)} ${res.body.slice(0, 300)}`).toBe(true);
  });
});

describe('responses', () => {
  it('cover every contract operation exactly once', () => {
    const covered = [...Object.keys(CASES), ...Object.keys(ROOT_CASES)].sort();
    expect(covered).toEqual(OPERATIONS.map(({ operationId }) => operationId).sort());
  });

  for (const operation of OPERATIONS) {
    for (const c of CASES[operation.operationId] ?? []) {
      it(`${operation.operationId}: ${c.name}`, async () => {
        await sendCase(t, c);
      });
    }
  }
});

describe('responses of the composition root', () => {
  beforeEach(() => {
    // clear() also drops responders, so the registry answer is installed again.
    root.db.clear();
    root.db.respond(REGISTRY_SQL, registryAnswer);
    root.publisher.clear();
  });

  for (const operation of OPERATIONS) {
    for (const c of ROOT_CASES[operation.operationId] ?? []) {
      it(`${operation.operationId}: ${c.name}`, async () => {
        await sendCase(root, c);
      });
    }
  }
});

describe('legacy error shapes', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it.each(ERROR_CASES.map((c) => ({ title: c.name, c })))('$title', async ({ c }) => {
    harness = c.root === true ? await rootHarness() : await buildIdentityApp(defaultSeed());
    const started = performance.now();
    await sendCase(harness, c);
    if (c.withinMs !== undefined) expect(performance.now() - started).toBeLessThan(c.withinMs);
  });
});
