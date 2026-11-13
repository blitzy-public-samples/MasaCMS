import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import {
  newRequestContext,
  runWithRequestContext,
  ServiceUnavailableError,
  type RequestContextStore,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, findOperation } from '@opt2/platform/testing';
import {
  createIdentityClient,
  type AccountCommitRequest,
  type AccountCountRequest,
  type AccountPrepareRequest,
  type AccountWhere,
  type IdentityCallOptions,
  type IdentityClient,
  type UsernameCandidateRequest,
} from '../../src/legacy/identity-client.js';

const IDENTITY_CONTRACT = parse(readFileSync(new URL('../../../identity/contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const USER_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const OPERATION_ID = '0F1E2D3C-4B5A-6978-8796A5B4C3D2E1F0';
const OPERATION_BASE = `/internal/v1/accounts/${USER_ID}/operations/${OPERATION_ID}`;

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

/** A service client that records each request and answers from `replies` in order, or rejects with `failure`. */
function stubClient(replies: Reply[], failure?: Error): { client: ServiceClient; requests: ServiceRequest[] } {
  const requests: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      requests.push(req);
      if (failure !== undefined) return Promise.reject(failure);
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`unexpected request ${req.method} ${req.path}`);
      return Promise.resolve({ status: reply.status, headers: reply.headers ?? {}, body: reply.body as T });
    },
    close: () => Promise.resolve(),
  };
  return { client, requests };
}

function identityWith(...replies: Reply[]): { identity: IdentityClient; requests: ServiceRequest[] } {
  const { client, requests } = stubClient(replies);
  return { identity: createIdentityClient(client), requests };
}

/** The fields of the ServiceUnavailableError raised when identity's `operationId` answers `status`. */
function unavailableFrom(operationId: string, status: number): object {
  return {
    service: 'identity',
    message: `Service identity unavailable (HTTP_${status})`,
    cause: { code: `HTTP_${status}`, message: `identity ${operationId} answered HTTP ${status}` },
  };
}


async function inContext<T>(fn: () => Promise<T>): Promise<{ result: T; store: RequestContextStore }> {
  const store = newRequestContext();
  const result = await runWithRequestContext(store, fn);
  return { result, store };
}

const CHANGE: AccountPrepareRequest = {
  kind: 'update',
  siteId: 'tenant-a',
  account: { UserName: 'jdoe', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 },
  groupIds: [],
};

const PREPARED = { operationId: OPERATION_ID, userId: USER_ID, kind: 'update', state: 'prepared', before: null };
const COMMITTED = { operationId: OPERATION_ID, userId: USER_ID, state: 'committed', writePosition: '9007199254740993' };

describe('roster protocol calls', () => {
  it('prepares with the change as JSON on the :prepare path and returns the operation', async () => {
    const { identity, requests } = identityWith({ status: 200, body: PREPARED });
    await expect(identity.prepare(USER_ID, OPERATION_ID, CHANGE)).resolves.toEqual({ ok: true, ...PREPARED });
    expect(requests).toEqual([
      { service: 'identity', method: 'POST', path: `${OPERATION_BASE}:prepare`, json: CHANGE },
    ]);
  });

  it("returns identity's validation errors unchanged, key order included", async () => {
    const errors = {
      username: "The username 'jdoe' that you entered is being used by another user.",
      password: 'The Password you submitted must meet the following criteria: Passwords cannot be the same as the username, must be at least 7 characters long, and must contain 1 upper case, 1 lower case and 1 numeric character.',
    };
    const { identity } = identityWith({ status: 400, body: errors });
    const outcome = await identity.prepare(USER_ID, OPERATION_ID, CHANGE);
    expect(outcome).toEqual({ ok: false, errors });
    expect(outcome.ok === false && outcome.errors).toBe(errors);
    expect(outcome.ok === false && Object.keys(outcome.errors)).toEqual(['username', 'password']);
  });

  it.each([
    ['a malformed-body envelope', 400, { apiversion: 'v1', method: 'invalid', error: { message: 'Bad Request', code: 'invalid_request' } }],
    ['a conflict', 409, { ...PREPARED, state: 'aborted' }],
    ['a closed user', 503, { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } }],
  ])('fails closed on %s', async (_case, status, body) => {
    const { identity } = identityWith({ status, body });
    const failure = identity.prepare(USER_ID, OPERATION_ID, CHANGE);
    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject(unavailableFrom('prepareAccountOperation', status));
  });

  it('commits on the :commit path and records both the header and the reply position for identity', async () => {
    const { identity, requests } = identityWith({
      status: 200,
      body: COMMITTED,
      headers: { 'x-opt2-write-position': ['identity=12', 'people=4'] },
    });
    const { result, store } = await inContext(() => identity.commit(USER_ID, OPERATION_ID));
    expect(result).toEqual(COMMITTED);
    expect(requests[0]).toEqual({ service: 'identity', method: 'POST', path: `${OPERATION_BASE}:commit` });
    expect(requests[0]).not.toHaveProperty('json');
    expect(Object.fromEntries(store.writePositions)).toEqual({ identity: '9007199254740993', people: '4' });
  });

  it.each<[string, AccountCommitRequest]>([
    ['an empty request', {}],
    ['a self-save re-login', { sessionEffects: { reloginSessionId: 'S-1' } }],
    [
      'a self-save re-login with the saved person fields',
      { sessionEffects: { reloginSessionId: 'S-1', person: { fname: 'Jo', lname: 'Doe', email: null, company: '', subtype: 'Default' } } },
    ],
  ])('commits with %s as the contract body', async (_case, request) => {
    const { identity, requests } = identityWith({ status: 200, body: COMMITTED });
    await expect(identity.commit(USER_ID, OPERATION_ID, request)).resolves.toEqual(COMMITTED);
    expect(requests).toEqual([{ service: 'identity', method: 'POST', path: `${OPERATION_BASE}:commit`, json: request }]);
    assertIdentityRequestBody(requests[0]);
  });

  it('prepares with the tablist, membership controls and pool switches as the contract body', async () => {
    const change: AccountPrepareRequest = {
      ...CHANGE,
      account: { ...CHANGE.account, tablist: 'Basic' },
      updateGroups: false,
      originID: 'tenant-a',
      switchToPublic: true,
      switchToPrivate: false,
    };
    const { identity, requests } = identityWith({ status: 200, body: PREPARED });
    await identity.prepare(USER_ID, OPERATION_ID, change);
    expect(requests[0]?.json).toBe(change);
    assertIdentityRequestBody(requests[0]);
  });

  it('commits outside a request context without recording positions', async () => {
    const { identity } = identityWith({ status: 200, body: COMMITTED, headers: { 'x-opt2-write-position': 'identity=3' } });
    await expect(identity.commit(USER_ID, OPERATION_ID)).resolves.toEqual(COMMITTED);
  });

  it.each([409, 503])('fails closed when commit answers %i', async (status) => {
    const { identity } = identityWith({ status, body: { ...PREPARED, state: 'aborted' } });
    await expect(identity.commit(USER_ID, OPERATION_ID)).rejects.toMatchObject(unavailableFrom('commitAccountOperation', status));
  });

  it.each(['abort', 'finish', 'revert'] as const)('posts %s on its :verb path and resolves on 200', async (verb) => {
    const { identity, requests } = identityWith({
      status: 200,
      body: { operationId: OPERATION_ID, userId: USER_ID, state: `${verb}ed` },
      headers: { 'x-opt2-write-position': 'identity=21' },
    });
    const { result, store } = await inContext(() => identity[verb](USER_ID, OPERATION_ID));
    expect(result).toBeUndefined();
    expect(requests).toEqual([{ service: 'identity', method: 'POST', path: `${OPERATION_BASE}:${verb}` }]);
    expect(store.writePositions.get('identity')).toBe('21');
  });

  it.each([
    ['abort', 'unknown', true],
    ['revert', 'unknown', true],
    ['finish', 'unknown', false],
    ['abort', 'committed', false],
    ['revert', 'prepared', false],
  ] as const)('%s with a 409 for an operation in state %s resolves: %s', async (verb, state, resolves) => {
    const { identity } = identityWith({ status: 409, body: { operationId: OPERATION_ID, userId: USER_ID, state } });
    const outcome = identity[verb](USER_ID, OPERATION_ID);
    if (resolves) await expect(outcome).resolves.toBeUndefined();
    else await expect(outcome).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it.each([
    ['prepared', 'prepared'],
    ['committed', 'committed'],
    ['reverted', 'reverted'],
    ['unknown', undefined],
  ] as const)('reads operation state %s as %s', async (state, expected) => {
    const { identity, requests } = identityWith({ status: 200, body: { operationId: OPERATION_ID, userId: USER_ID, state } });
    await expect(identity.operationState(USER_ID, OPERATION_ID)).resolves.toBe(expected);
    expect(requests).toEqual([{ service: 'identity', method: 'GET', path: OPERATION_BASE }]);
  });

  it('encodes the ids but never the :verb suffix', async () => {
    const { identity, requests } = identityWith({ status: 200, body: { operationId: 'a/b', userId: 'c d', state: 'finished' } });
    await identity.finish('c d', 'a/b');
    expect(requests[0]?.path).toBe('/internal/v1/accounts/c%20d/operations/a%2Fb:finish');
  });

  it('records the write positions of error answers too', async () => {
    const { identity } = identityWith({ status: 503, headers: { 'x-opt2-write-position': 'identity=40' } });
    const store = newRequestContext();
    await expect(runWithRequestContext(store, () => identity.abort(USER_ID, OPERATION_ID))).rejects.toMatchObject(
      unavailableFrom('abortAccountOperation', 503),
    );
    expect(store.writePositions.get('identity')).toBe('40');
  });

  it('propagates a transport failure of the service client as ServiceUnavailableError', async () => {
    const timeout = new ServiceUnavailableError('identity', Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const { client } = stubClient([], timeout);
    await expect(createIdentityClient(client).operationState(USER_ID, OPERATION_ID)).rejects.toBe(timeout);
  });

  type BoundedCall = (identity: IdentityClient, options?: IdentityCallOptions) => Promise<unknown>;
  const step = (state: string): Reply => ({ status: 200, body: { operationId: OPERATION_ID, userId: USER_ID, state } });
  const bounded: [string, BoundedCall, Reply][] = [
    ['prepare', (identity, options) => identity.prepare(USER_ID, OPERATION_ID, CHANGE, options), { status: 200, body: PREPARED }],
    ['commit', (identity, options) => identity.commit(USER_ID, OPERATION_ID, undefined, options), { status: 200, body: COMMITTED }],
    ['abort', (identity, options) => identity.abort(USER_ID, OPERATION_ID, options), step('aborted')],
    ['finish', (identity, options) => identity.finish(USER_ID, OPERATION_ID, options), step('finished')],
    ['revert', (identity, options) => identity.revert(USER_ID, OPERATION_ID, options), step('reverted')],
    ['operationState', (identity, options) => identity.operationState(USER_ID, OPERATION_ID, options), step('prepared')],
    ['readAccount', (identity, options) => identity.readAccount(USER_ID, options), { status: 404 }],
    ['membershipGroupIds', (identity, options) => identity.membershipGroupIds(USER_ID, options), { status: 200, body: { privateGroups: [], publicGroups: [], groupIds: [] } }],
  ];
  const bounds: [IdentityCallOptions | undefined, number | undefined][] = [
    [{ timeoutMs: 1_234 }, 1_234],
    [{}, undefined],
    [undefined, undefined],
  ];

  it.each(bounded.flatMap(([name, call, reply]) => bounds.map(([options, timeoutMs]) => [name, JSON.stringify(options), call, reply, options, timeoutMs] as const)))(
    '%s with options %s bounds its service request by that timeout only',
    async (_name, _label, call, reply, options, timeoutMs) => {
      const { identity, requests } = identityWith(reply);
      await call(identity, options);
      expect(requests).toHaveLength(1);
      if (timeoutMs === undefined) expect(requests[0]).not.toHaveProperty('timeoutMs');
      else expect(requests[0]?.timeoutMs).toBe(timeoutMs);
    },
  );
});

describe('identity reads', () => {
  const memberships = {
    privateGroups: [{ UserID: 'G1', GroupName: 'Admin' }],
    publicGroups: [{ UserID: 'G2', GroupName: 'Members' }],
    groupIds: ['G2', 'G1'],
  };

  it('reads the user memberships for a site', async () => {
    const { identity, requests } = identityWith({ status: 200, body: memberships });
    await expect(identity.userMemberships(USER_ID, 'tenant-a')).resolves.toEqual(memberships);
    expect(requests).toEqual([
      { service: 'identity', method: 'GET', path: `/v1/users/${USER_ID}/memberships`, query: { siteid: 'tenant-a' } },
    ]);
  });

  it("lists membership group ids in identity's order, for the token's site", async () => {
    const { identity, requests } = identityWith({ status: 200, body: memberships });
    await expect(identity.membershipGroupIds(USER_ID)).resolves.toEqual(['G2', 'G1']);
    expect(requests[0]?.query).toEqual({ siteid: undefined });
  });

  it('maps the cusers.list group rows, absent columns as NULL', async () => {
    const full = {
      UserID: 'G1',
      Email: 'a@example.com',
      GroupName: 'Admin',
      Type: 1,
      LastLogin: '2026-06-01 10:00:00',
      LastUpdate: '2026-06-02 11:00:00',
      LastUpdateBy: 'Ada Admin',
      LastUpdateByID: 'U1',
      Counter: 3,
      Perm: 1,
      isPublic: 0,
    };
    const sparse = { UserID: 'G2', GroupName: 'Editors', Counter: null, Perm: 0, isPublic: 0 };
    const reply = { status: 200, body: { items: [full, sparse], total: 2, nextOffset: null } };
    const { identity, requests } = identityWith(reply);
    await expect(identity.userGroups('tenant-a', 0)).resolves.toEqual([
      {
        userId: 'G1',
        email: 'a@example.com',
        groupName: 'Admin',
        type: 1,
        lastLogin: '2026-06-01 10:00:00',
        lastUpdate: '2026-06-02 11:00:00',
        lastUpdateBy: 'Ada Admin',
        lastUpdateById: 'U1',
        counter: 3,
        perm: 1,
        isPublic: 0,
      },
      {
        userId: 'G2',
        email: null,
        groupName: 'Editors',
        type: null,
        lastLogin: null,
        lastUpdate: null,
        lastUpdateBy: null,
        lastUpdateById: null,
        counter: null,
        perm: 0,
        isPublic: 0,
      },
    ]);
    expect(requests).toEqual([
      { service: 'identity', method: 'GET', path: '/v1/groups', query: { siteid: 'tenant-a', ispublic: '0', offset: '0' } },
    ]);
  });

  it('follows nextOffset through every page of the group list and returns the rows in page order', async () => {
    const groupId = (n: number): string => `6A000000-0000-0000-${String(n).padStart(16, '0')}`;
    const row = (n: number) => ({ UserID: groupId(n), GroupName: `Group ${n}`, Counter: null, Perm: 0, isPublic: 1 });
    const replies = [
      { status: 200, body: { items: Array.from({ length: 1000 }, (_, n) => row(n)), total: 2001, nextOffset: 1000 } },
      { status: 200, body: { items: Array.from({ length: 1000 }, (_, n) => row(1000 + n)), total: 2001, nextOffset: 2000 } },
      { status: 200, body: { items: [row(2000)], total: 2001, nextOffset: null } },
    ];
    const { identity, requests } = identityWith(...replies);

    const rows = await identity.userGroups('tenant-a', 1);

    expect(rows.map((group) => group.userId)).toEqual(Array.from({ length: 2001 }, (_, n) => groupId(n)));
    expect(requests.map((req) => req.query)).toEqual(['0', '1000', '2000'].map((offset) => ({ siteid: 'tenant-a', ispublic: '1', offset })));
    replies.forEach((reply, n) => assertIdentityReply(requests[n], reply));
  });

  it.each([403, 503])('fails closed when a read answers %i', async (status) => {
    const { identity } = identityWith({ status });
    await expect(identity.userGroups('tenant-a', 1)).rejects.toMatchObject(unavailableFrom('listGroups', status));
  });

  it('fails closed when a later page answers 503, returning no partial list', async () => {
    const first = { UserID: '6A000000-0000-0000-0000000000000001', GroupName: 'First', Counter: null, Perm: 0, isPublic: 1 };
    const { identity, requests } = identityWith({ status: 200, body: { items: [first], total: 2, nextOffset: 1 } }, { status: 503 });
    await expect(identity.userGroups('tenant-a', 1)).rejects.toMatchObject(unavailableFrom('listGroups', 503));
    expect(requests.map((req) => req.query?.offset)).toEqual(['0', '1']);
  });

  const session = (sessionId: string | null, user: Record<string, unknown>) => ({
    sessionId,
    epoch: 1,
    user,
    roles: [],
    mfaPending: false,
    blockLoginUntil: null,
  });

  it.each([
    ['the logged-in session', session('S1', { isLoggedIn: true, userID: 'U1', fname: 'Ada', lname: 'Admin' }), { userId: 'U1', fname: 'Ada', lname: 'Admin' }],
    ['a session without names', session('S1', { isLoggedIn: true, userID: 'U1' }), { userId: 'U1', fname: '', lname: '' }],
    ['another session', session('S2', { isLoggedIn: true, userID: 'U2', fname: 'Bo', lname: 'B' }), undefined],
    ['an anonymous session', session(null, { isLoggedIn: false, userID: '' }), undefined],
    ['a logged-out session', session('S1', { isLoggedIn: false, userID: '' }), undefined],
  ])('reads the acting user of %s', async (_case, body, expected) => {
    const { identity, requests } = identityWith({ status: 200, body });
    await expect(identity.actingUser('S1')).resolves.toEqual(expected);
    expect(requests).toEqual([{ service: 'identity', method: 'GET', path: '/v1/sessions/current' }]);
  });

});

/** Checks a stub reply against the identity operation the request called. */
function assertIdentityReply(req: ServiceRequest | undefined, reply: Reply): void {
  if (req === undefined) throw new Error('identity was not called');
  const { method, path } = req;
  assertResponseMatchesOpenApi(IDENTITY_CONTRACT, { method, path, status: reply.status, contentType: 'application/json', body: reply.body });
}

/** Checks a request's JSON body against the `requestBody` of the identity operation it calls. */
function assertIdentityRequestBody(req: ServiceRequest | undefined): void {
  if (req === undefined) throw new Error('identity was not called');
  const { template, operation } = findOperation(IDENTITY_CONTRACT, req.method, req.path);
  // The request body object has a response object's `content` shape, so the response checker validates it.
  const probe = { ...IDENTITY_CONTRACT, paths: { [template]: { [req.method.toLowerCase()]: { responses: { '200': operation['requestBody'] } } } } };
  assertResponseMatchesOpenApi(probe, { method: req.method, path: req.path, status: 200, contentType: 'application/json', body: req.json });
}

describe('login block', () => {
  it.each([
    { removeBlock: false, blockedUntil: '2026-06-30T09:30:00.000' },
    { removeBlock: true, blockedUntil: null },
  ])('loads the block with removeBlock=$removeBlock and records the write position', async ({ removeBlock, blockedUntil }) => {
    const reply = { status: 200, body: { blockedUntil }, headers: { 'x-opt2-write-position': 'identity=37' } };
    const { identity, requests } = identityWith(reply);
    const { result, store } = await inContext(() => identity.loginBlock(USER_ID, removeBlock));
    expect(result).toBe(blockedUntil);
    expect(requests).toEqual([{
      service: 'identity', method: 'POST', path: `/internal/v1/accounts/${USER_ID}/login-block`, json: { removeBlock },
    }]);
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
    expect(store.writePositions.get('identity')).toBe('37');
  });

  it('returns null for an account that is gone', async () => {
    const reply = { status: 404, body: { apiversion: 'v1', method: 'invalid', error: { message: 'Not Found', code: 'invalid_request' } } };
    const { identity, requests } = identityWith(reply);
    await expect(identity.loginBlock(USER_ID, false)).resolves.toBeNull();
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
  });

  it.each([
    [400, 'Bad Request', 'invalid_request'],
    [401, 'Unauthorized', 'invalid_request'],
    [403, 'Forbidden', 'invalid_request'],
    [503, 'Unhandled Exception', 'server_error'],
  ])('fails closed on HTTP %i', async (status, message, code) => {
    const reply = { status, body: { apiversion: 'v1', method: 'invalid', error: { message, code } } };
    const { identity, requests } = identityWith(reply);
    const failure = identity.loginBlock(USER_ID, true);
    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject(unavailableFrom('loadLoginBlock', status));
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
  });

  it('fails closed on an unexpected status', async () => {
    const { identity } = identityWith({ status: 502 });
    const failure = identity.loginBlock(USER_ID, false);
    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject(unavailableFrom('loadLoginBlock', 502));
  });
});

describe('account and site-group reads', () => {
  const OTHER_ID = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
  const MISSING_ID = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
  const GROUP_ID = 'D1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
  const OTHER_GROUP_ID = 'E1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

  const record = {
    UserID: USER_ID,
    SiteID: 'tenant-a',
    UserName: 'jdoe',
    Type: 2,
    Admin: null,
    S2: 0,
    Perm: 0,
    InActive: 0,
    isPublic: 0,
    remoteID: null,
    PasswordCreated: '2026-06-01T09:15:00.000',
    LastLogin: null,
    tablist: null,
  };
  const view = {
    userId: USER_ID,
    siteId: 'tenant-a',
    username: 'jdoe',
    s2: 0,
    isPublic: 0,
    inactive: 0,
    type: 2,
    perm: 0,
    admin: null,
    remoteId: null,
    lastLogin: null,
    passwordCreated: '2026-06-01T09:15:00.000',
    tablist: null,
  };
  const otherRecord = {
    ...record,
    UserID: OTHER_ID,
    SiteID: 'umbrella',
    UserName: 'member',
    Admin: 0,
    S2: 1,
    Perm: 1,
    InActive: 1,
    isPublic: 1,
    remoteID: 'R-9',
    PasswordCreated: null,
    LastLogin: '2026-06-30T09:15:00.000',
    tablist: 'Basic,Publishing',
  };
  const otherView = {
    userId: OTHER_ID,
    siteId: 'umbrella',
    username: 'member',
    s2: 1,
    isPublic: 1,
    inactive: 1,
    type: 2,
    perm: 1,
    admin: 0,
    remoteId: 'R-9',
    lastLogin: '2026-06-30T09:15:00.000',
    passwordCreated: null,
    tablist: 'Basic,Publishing',
  };
  const groups = [
    { UserID: GROUP_ID, GroupName: 'Admin', SiteID: 'tenant-a', isPublic: 0, Perm: 1 },
    { UserID: OTHER_GROUP_ID, GroupName: null, SiteID: 'tenant-a', isPublic: 0, Perm: null },
  ];
  const notFound = { apiversion: 'v1', method: 'invalid', error: { message: 'Not Found', code: 'invalid_request' } };
  const errorBodies: Record<number, unknown> = {
    403: { apiversion: 'v1', method: 'invalid', error: { message: 'Insufficient Account Permissions', code: 'invalid_request' } },
    503: { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } },
  };

  it('reads one account on getAccount and maps its columns', async () => {
    const reply = { status: 200, body: record };
    const { identity, requests } = identityWith(reply);
    await expect(identity.readAccount(USER_ID)).resolves.toEqual(view);
    expect(requests).toEqual([{ service: 'identity', method: 'GET', path: `/internal/v1/accounts/${USER_ID}` }]);
    assertIdentityReply(requests[0], reply);
  });

  it('reads an account identity does not find (404) as undefined', async () => {
    const reply = { status: 404, body: notFound };
    const { identity, requests } = identityWith(reply);
    await expect(identity.readAccount(MISSING_ID)).resolves.toBeUndefined();
    assertIdentityReply(requests[0], reply);
  });

  type Lookup = (identity: IdentityClient, userIds: readonly string[]) => Promise<Map<string, unknown>>;
  const accountLookups: [string, string, Lookup][] = [
    ['readAccounts', '/internal/v1/accounts:lookup', (identity, userIds) => identity.readAccounts(userIds)],
    ['readAccountsAllSites', '/internal/v1/accounts:lookup-all-sites', (identity, userIds) => identity.readAccountsAllSites(userIds)],
  ];
  const membershipLookup: [string, string, Lookup] = [
    'lookupMemberships',
    '/internal/v1/accounts:memberships',
    (identity, userIds) => identity.lookupMemberships(userIds),
  ];

  it.each(accountLookups)('%s reads many accounts in one call on %s, each id once, keyed by user id', async (_method, path, lookup) => {
    const reply = { status: 200, body: { items: [record, otherRecord] } };
    const { identity, requests } = identityWith(reply);
    const accounts = await lookup(identity, [USER_ID, OTHER_ID, MISSING_ID, USER_ID]);
    expect([...accounts]).toEqual([
      [USER_ID, view],
      [OTHER_ID, otherView],
    ]);
    expect(requests).toEqual([{ service: 'identity', method: 'POST', path, json: { userIds: [USER_ID, OTHER_ID, MISSING_ID] } }]);
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
  });

  it('reads many users’ stored group ids in one lookupMemberships call, keyed by the requested id', async () => {
    const lower = OTHER_ID.toLowerCase();
    const reply = {
      status: 200,
      body: {
        items: [
          { userId: USER_ID, groupIds: [GROUP_ID, OTHER_GROUP_ID] },
          { userId: lower, groupIds: [] },
        ],
      },
    };
    const { identity, requests } = identityWith(reply);
    const memberships = await identity.lookupMemberships([USER_ID, lower, USER_ID]);
    expect([...memberships]).toEqual([
      [USER_ID, [GROUP_ID, OTHER_GROUP_ID]],
      [lower, []],
    ]);
    expect(requests).toEqual([{ service: 'identity', method: 'POST', path: '/internal/v1/accounts:memberships', json: { userIds: [USER_ID, lower] } }]);
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
  });

  it.each([...accountLookups, membershipLookup])('%s splits the distinct ids into calls of at most 1000 on %s', async (method, path, lookup) => {
    const ids = Array.from({ length: 2501 }, (_, n) => `${n.toString(16).toUpperCase().padStart(8, '0')}-0000-0000-0000000000000000`);
    const chunks = [ids.slice(0, 1000), ids.slice(1000, 2000), ids.slice(2000)];
    const item = (id: string): unknown => (method === 'lookupMemberships' ? { userId: id, groupIds: [GROUP_ID] } : { ...record, UserID: id });
    const replies = chunks.map((chunk) => ({ status: 200, body: { items: chunk.map(item) } }));
    const { identity, requests } = identityWith(...replies);
    const found = await lookup(identity, [...ids, ids[0] as string]);
    expect(requests.map((req) => [req.path, (req.json as { userIds: string[] }).userIds])).toEqual(chunks.map((chunk) => [path, chunk]));
    requests.forEach((req, index) => {
      assertIdentityRequestBody(req);
      assertIdentityReply(req, replies[index] as Reply);
    });
    expect([...found.keys()]).toEqual(ids);
  });

  it.each([...accountLookups, membershipLookup])('%s reads an empty id list as an empty map without calling identity', async (_method, _path, lookup) => {
    const { identity, requests } = identityWith();
    await expect(lookup(identity, [])).resolves.toEqual(new Map());
    expect(requests).toEqual([]);
  });

  const WHERE: AccountWhere = { isPublic: 0, s2: 0, excludeS2Users: true, inActive: 1, siteIds: ['tenant-a', 'umbrella'], unassigned: true };
  const filteredLookups: [string, string, Lookup][] = [
    ['readAccounts', '/internal/v1/accounts:lookup', (identity, userIds) => identity.readAccounts(userIds, WHERE)],
    ['readAccountsAllSites', '/internal/v1/accounts:lookup-all-sites', (identity, userIds) => identity.readAccountsAllSites(userIds, WHERE)],
  ];

  it.each(filteredLookups)('%s sends the account predicates with every chunk on %s', async (_method, path, lookup) => {
    const ids = Array.from({ length: 1001 }, (_, n) => `${n.toString(16).toUpperCase().padStart(8, '0')}-0000-0000-0000000000000000`);
    const replies = [{ status: 200, body: { items: [{ ...record, UserID: ids[0] }] } }, { status: 200, body: { items: [] } }];
    const { identity, requests } = identityWith(...replies);
    expect([...(await lookup(identity, ids)).keys()]).toEqual([ids[0]]);
    expect(requests).toEqual([
      { service: 'identity', method: 'POST', path, json: { userIds: ids.slice(0, 1000), where: WHERE } },
      { service: 'identity', method: 'POST', path, json: { userIds: ids.slice(1000), where: WHERE } },
    ]);
    requests.forEach((req, index) => {
      assertIdentityRequestBody(req);
      assertIdentityReply(req, replies[index] as Reply);
    });
  });

  it.each<[string, AccountCountRequest]>([
    ['a pool', { scope: 'pool', publicPool: true, where: { isPublic: 1 } }],
    ['the token tenant', { scope: 'tenant', where: { unassigned: true } }],
    ['every site', { scope: 'all-sites', where: { excludeS2Users: true } }],
    ['a pool without predicates', { scope: 'pool', publicPool: false }],
  ])('counts the accounts of %s on countAccounts', async (_label, request) => {
    const reply = { status: 200, body: { count: 2001 } };
    const { identity, requests } = identityWith(reply);
    await expect(identity.countAccounts(request)).resolves.toBe(2001);
    expect(requests).toEqual([{ service: 'identity', method: 'POST', path: '/internal/v1/accounts:count', json: request }]);
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
  });

  it.each([true, false])('lists the username candidates with complete=%s on lookupUsernameCandidates', async (complete) => {
    const request: UsernameCandidateRequest = { publicPool: false, pattern: '%doe%', where: { isPublic: 0, s2: 0 }, limit: 5000 };
    const items = [
      { userId: USER_ID, username: 'jdoe' },
      { userId: OTHER_ID, username: 'DOEr' },
    ];
    const reply = { status: 200, body: { items, complete } };
    const { identity, requests } = identityWith(reply);
    await expect(identity.usernameCandidates(request)).resolves.toEqual({ items, complete });
    expect(requests).toEqual([{ service: 'identity', method: 'POST', path: '/internal/v1/accounts:username-candidates', json: request }]);
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
  });

  it.each([0, 1])('lists the site groups of pool visibility %i on listSiteGroups', async (isPublic) => {
    const items = groups.map((group) => ({ ...group, isPublic }));
    const reply = { status: 200, body: { items } };
    const { identity, requests } = identityWith(reply);
    await expect(identity.siteGroups('tenant-a', isPublic)).resolves.toEqual([
      { groupId: GROUP_ID, groupName: 'Admin', siteId: 'tenant-a', isPublic, perm: 1 },
      { groupId: OTHER_GROUP_ID, groupName: null, siteId: 'tenant-a', isPublic, perm: null },
    ]);
    expect(requests).toEqual([
      { service: 'identity', method: 'GET', path: '/internal/v1/groups', query: { siteid: 'tenant-a', ispublic: String(isPublic) } },
    ]);
    assertIdentityReply(requests[0], reply);
  });

  type Read = (identity: IdentityClient) => Promise<unknown>;
  const reads = [
    ['readAccount', 'getAccount', ((identity) => identity.readAccount(USER_ID)) as Read, record],
    ['readAccounts', 'lookupAccounts', ((identity) => identity.readAccounts([USER_ID])) as Read, { items: [record] }],
    ['readAccountsAllSites', 'lookupAccountsAllSites', ((identity) => identity.readAccountsAllSites([USER_ID])) as Read, { items: [record] }],
    ['lookupMemberships', 'lookupMemberships', ((identity) => identity.lookupMemberships([USER_ID])) as Read, { items: [{ userId: USER_ID, groupIds: [] }] }],
    ['siteGroups', 'listSiteGroups', ((identity) => identity.siteGroups('tenant-a', 0)) as Read, { items: groups }],
    ['countAccounts', 'countAccounts', ((identity) => identity.countAccounts({ scope: 'tenant' })) as Read, { count: 0 }],
    [
      'usernameCandidates',
      'lookupUsernameCandidates',
      ((identity) => identity.usernameCandidates({ publicPool: true, pattern: '%a%', limit: 1 })) as Read,
      { items: [], complete: true },
    ],
  ] as const;

  it.each(reads.flatMap(([method, operationId, call]) => [403, 503].map((status) => [method, status, operationId, call] as const)))(
    '%s fails closed when identity answers %i',
    async (_method, status, operationId, call) => {
      const reply = { status, body: errorBodies[status] };
      const { identity, requests } = identityWith(reply);
      const failure = call(identity);
      await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(failure).rejects.toMatchObject(unavailableFrom(operationId, status));
      assertIdentityReply(requests[0], reply);
    },
  );

  it.each(reads)("%s records identity's write positions in the request context", async (_method, _operationId, call, body) => {
    const { identity } = identityWith({ status: 200, body, headers: { 'x-opt2-write-position': 'identity=7' } });
    const { store } = await inContext(() => call(identity));
    expect(store.writePositions.get('identity')).toBe('7');
  });
});

describe('admin session reads and writes', () => {
  const state = {
    paramArray: [{ Field: 'tusers.lname^varchar', Relationship: 'and', Criteria: 'Doe', Condition: 'Contains' }],
    paramCount: 1,
    paramCircuit: 'cUsers',
    inActive: '0',
    membersOnly: 'false',
    visitorStatus: 'All',
    mura: { editBean: { userBean: {}, errors: {} } },
  };
  const sites = { sites: [{ siteID: 'default', site: 'Default' }, { siteID: 'tenant-a', site: 'Tenant A' }] };

  it("reads the forwarded session's admin state", async () => {
    const reply = { status: 200, body: state };
    const { identity, requests } = identityWith(reply);
    await expect(identity.adminSessionState()).resolves.toEqual(state);
    expect(requests).toEqual([{ service: 'identity', method: 'GET', path: '/v1/sessions/current/admin-state' }]);
    assertIdentityReply(requests[0], reply);
  });

  it('stores the given keys as JSON and returns the merged values, recording the write position', async () => {
    const saved = { mura: {} };
    const reply = { status: 200, body: { ...state, ...saved }, headers: { 'x-opt2-write-position': 'identity=31' } };
    const { identity, requests } = identityWith(reply);
    const { result, store } = await inContext(() => identity.saveAdminSessionState(saved));
    expect(result).toEqual({ ...state, mura: {} });
    expect(requests).toEqual([{ service: 'identity', method: 'POST', path: '/v1/sessions/current/admin-state', json: saved }]);
    assertIdentityRequestBody(requests[0]);
    assertIdentityReply(requests[0], reply);
    expect(store.writePositions.get('identity')).toBe('31');
  });

  it("lists the session's site selector in identity's order", async () => {
    const reply = { status: 200, body: sites };
    const { identity, requests } = identityWith(reply);
    await expect(identity.sessionSites()).resolves.toEqual(sites.sites);
    expect(requests).toEqual([{ service: 'identity', method: 'GET', path: '/v1/sessions/current/sites' }]);
    assertIdentityReply(requests[0], reply);
  });

  it.each([
    ['adminSessionState', 'getAdminSessionState', (identity: IdentityClient) => identity.adminSessionState()],
    ['saveAdminSessionState', 'saveAdminSessionState', (identity: IdentityClient) => identity.saveAdminSessionState({ mura: {} })],
    ['sessionSites', 'listCurrentSessionSites', (identity: IdentityClient) => identity.sessionSites()],
  ])('%s fails closed when identity answers 401', async (_method, operationId, call) => {
    const { identity } = identityWith({ status: 401 });
    const failure = call(identity);
    await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(failure).rejects.toMatchObject(unavailableFrom(operationId, 401));
  });
});
