/** Provider contract of identity: every registered route against contracts/openapi.yaml, the operations no route serves yet, and actual responses per operation. */
import { readFileSync } from 'node:fs';
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, transportForPath, type RouteMatrixEntry } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import { SYSTEM_TENANT_ID } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TEST_PUSH_KEY,
  assertResponseMatchesOpenApi,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  type InjectResponse,
} from '@opt2/platform/testing';
import { USER_ACCOUNT } from '../../src/repo/tables.js';
import { ADMIN_S2, ALL_ACTORS, EDITOR, MEMBER_B, SITE_ADMIN_A, sessionRow } from '../helpers/rows.js';
import {
  NOW,
  SITE_A,
  SUBJECT_SESSIONS,
  buildIdentityApp,
  cfId,
  credentialsFor,
  csrfFor,
  defaultSeed,
  relayedCredentials,
  subjectNamed,
  type IdentityTestApp,
  type SubjectSession,
} from '../helpers/service.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
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

/** One request against an operation and the status it must answer; `as` names the subject presenting credentials. */
interface Case {
  name: string;
  method: HttpMethod;
  url: string;
  as?: string;
  headers?: () => Promise<Headers>;
  payload?: string | Record<string, unknown>;
  status: number;
  verify?: (body: unknown, res: InjectResponse) => void | Promise<void>;
}

const DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as OpenApiDoc;
const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

const METHODS = ['get', 'post', 'put', 'delete'] as const;
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;

/** Operations the contract declares that no route function serves yet: migration-kit, managed push, outbox sweep and task-queue control. */
const PLANNED: readonly string[] = [
  'migrationApply',
  'migrationExport',
  'migrationChanges',
  'migrationPosition',
  'migrationWatermarkGet',
  'migrationWatermarkPost',
  'migrationGate',
  'pushSiteChanged',
  'pushPersonChanged',
  'outboxSweep',
  'pauseTaskQueue',
  'resumeTaskQueue',
  'ensureTaskQueue',
];

const ADMIN_GROUP = SITE_ADMIN_A.groups[0]?.userid ?? '';
const EDITOR_GROUP = EDITOR.groups[0]?.userid ?? '';
const USERS_MODULE = '00000000000000000000000000000000008';
const HOME = '00000000000000000000000000000000001';
const NEW_GROUP = cfId('A', 901);
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

function as(subject: string): () => Promise<Headers> {
  return () => credentialsFor(subjectNamed(subject));
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
const IMPLEMENTED = OPERATIONS.filter((operation) => !PLANNED.includes(operation.operationId));

/** The Fastify patterns an operation is served under: its declared `x-opt2-fastify-path`, one or a list, else the template with `:name` params. */
function fastifyPathsOf(operation: ContractOperation): string[] {
  const declaredPath = operation.op['x-opt2-fastify-path'] as string | string[] | undefined;
  if (declaredPath === undefined) return [operation.path.replace(/\{(\w+)\}/g, ':$1')];
  return typeof declaredPath === 'string' ? [declaredPath] : [...declaredPath];
}

/** `METHOD pattern` of every route an operation is served under. */
function routeKeysOf(operation: ContractOperation): string[] {
  return fastifyPathsOf(operation).map((path) => `${operation.method} ${path}`);
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

function routeKey(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
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

let t: IdentityTestApp;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  t = await buildIdentityApp(defaultSeed({ sessions: EXTRA_SESSIONS, strikes: [BLOCKED_STRIKE], personContacts: CONTACTS }));
  t.content.files.set(EDITOR_PHOTO, 'jpg');
  jwks = (await t.app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json<JSONWebKeySet>();
});

afterAll(async () => {
  await t?.close();
});

/** Sends `c`, asserts its status, validates the response against the operation it addresses and returns the parsed body. */
async function sendCase(c: Case): Promise<void> {
  const headers = { ...(c.as === undefined ? {} : await credentialsFor(subjectNamed(c.as))), ...(c.headers === undefined ? {} : await c.headers()) };
  const res = await t.app.inject({ method: c.method, url: c.url, headers, ...(c.payload === undefined ? {} : { payload: c.payload }) });
  const contentType = res.headers['content-type'];
  const body: unknown = typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType) && res.body !== '' ? JSON.parse(res.body) : res.body;
  expect(res.statusCode, res.body.slice(0, 400)).toBe(c.status);
  assertResponseMatchesOpenApi(DOC, { method: c.method, path: c.url.split('?')[0] ?? c.url, status: res.statusCode, contentType, body });
  await c.verify?.(body, res);
}

describe('contract document', () => {
  it('carries the pinned source SHA, OpenAPI 3.1.0 and version 1.0.0', () => {
    expect([DOC.openapi, DOC.info.version, DOC.info['x-source-sha']]).toEqual(['3.1.0', '1.0.0', PIN.sha]);
  });

  it('declares on every operation the transport its path takes and exactly one of x-opt2-requires and x-opt2-public', () => {
    const problems = OPERATIONS.flatMap(({ method, path, op }) => {
      const requires = op['x-opt2-requires'];
      const isPublic = op['x-opt2-public'] === true;
      const found: string[] = [];
      if (op['x-opt2-transport'] !== transportForPath(path)) found.push(`${method} ${path}: transport ${String(op['x-opt2-transport'])}`);
      if ((requires === undefined) === !isPublic) found.push(`${method} ${path}: requires and public`);
      if (requires !== undefined && !(Array.isArray(requires) && requires.length > 0)) found.push(`${method} ${path}: empty requires`);
      return found;
    });
    expect(problems).toEqual([]);
  });
});

describe('registered routes', () => {
  it('serve every implemented operation at its Fastify path with the declaration the contract states', () => {
    const routes = collectRouteMatrix(t.app).routes;
    const byKey = new Map(routes.map((route) => [routeKey(route), declared(route)]));
    const mismatches = IMPLEMENTED.flatMap((operation) =>
      routeKeysOf(operation).flatMap((key) => {
        const actual = byKey.get(key);
        if (actual === undefined) return [`${operation.operationId}: no route ${key}`];
        return JSON.stringify(actual) === JSON.stringify(contractDeclaration(operation)) ? [] : [`${operation.operationId} ${key}: ${JSON.stringify(actual)}`];
      }),
    );
    expect(mismatches).toEqual([]);
  });

  it('are each a contract operation', () => {
    const served = new Set(IMPLEMENTED.flatMap(routeKeysOf));
    expect(collectRouteMatrix(t.app).routes.map(routeKey).filter((key) => !served.has(key))).toEqual([]);
  });

  it('leave exactly the planned operations unserved', () => {
    const registered = new Set(collectRouteMatrix(t.app).routes.map(routeKey));
    const unserved = OPERATIONS.filter((operation) => !routeKeysOf(operation).every((key) => registered.has(key))).map((operation) => operation.operationId);
    expect(unserved.sort()).toEqual([...PLANNED].sort());
  });

  it('answer every planned operation with the fail-closed 404 and no effect, whatever credential its path takes', async () => {
    const outcomes: string[] = [];
    for (const operation of OPERATIONS.filter((candidate) => PLANNED.includes(candidate.operationId))) {
      const url = operation.path.replace('{queue}', 'identity-outbox-sweep');
      const transport = operation.op['x-opt2-transport'];
      const headers: Headers =
        transport === 'cloud-tasks'
          ? { authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'identity' })}` }
          : transport === 'pubsub-push'
            ? {}
            : await credentialsFor(subjectNamed('service:migration'));
      t.resetEffects();
      const res = await t.app.inject({
        method: operation.method,
        url: transport === 'pubsub-push' ? `${url}?key=${TEST_PUSH_KEY}` : url,
        headers,
        ...(operation.method === 'POST' ? { payload: {} } : {}),
      });
      outcomes.push(`${operation.operationId} ${res.statusCode} ${JSON.stringify(t.effects())}`);
    }
    const quiet = JSON.stringify({ statements: 0, writes: 0, repoWrites: 0, events: 0, relayed: 0, calls: 0, fetches: 0 });
    expect(outcomes.sort()).toEqual(PLANNED.map((id) => `${id} 404 ${quiet}`).sort());
  });
});

describe('responses', () => {
  it('cover every implemented operation', () => {
    expect(Object.keys(CASES).sort()).toEqual(IMPLEMENTED.map((operation) => operation.operationId).sort());
  });

  for (const operation of IMPLEMENTED) {
    for (const c of CASES[operation.operationId] ?? []) {
      it(`${operation.operationId}: ${c.name}`, async () => {
        await sendCase(c);
      });
    }
  }
});
