import { describe, it, expect } from 'vitest';
import {
  newRequestContext,
  runWithRequestContext,
  ServiceUnavailableError,
  type RequestContextStore,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  createIdentityClient,
  IDENTITY_READ_GAPS,
  IdentityReadNotProvidedError,
  photoFileExt,
  type AccountPrepareRequest,
  type IdentityClient,
} from '../../src/legacy/identity-client.js';

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
    await expect(failure).rejects.toThrow(`prepareAccountOperation HTTP_${status}`);
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
    expect(Object.fromEntries(store.writePositions)).toEqual({ identity: '9007199254740993', people: '4' });
  });

  it('commits outside a request context without recording positions', async () => {
    const { identity } = identityWith({ status: 200, body: COMMITTED, headers: { 'x-opt2-write-position': 'identity=3' } });
    await expect(identity.commit(USER_ID, OPERATION_ID)).resolves.toEqual(COMMITTED);
  });

  it.each([409, 503])('fails closed when commit answers %i', async (status) => {
    const { identity } = identityWith({ status, body: { ...PREPARED, state: 'aborted' } });
    await expect(identity.commit(USER_ID, OPERATION_ID)).rejects.toThrow(`commitAccountOperation HTTP_${status}`);
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
    await expect(runWithRequestContext(store, () => identity.abort(USER_ID, OPERATION_ID))).rejects.toThrow(
      'abortAccountOperation HTTP_503',
    );
    expect(store.writePositions.get('identity')).toBe('40');
  });

  it('propagates a transport failure of the service client as ServiceUnavailableError', async () => {
    const timeout = new ServiceUnavailableError('identity', Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const { client } = stubClient([], timeout);
    await expect(createIdentityClient(client).operationState(USER_ID, OPERATION_ID)).rejects.toBe(timeout);
  });
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
    const { identity, requests } = identityWith({ status: 200, body: { items: [full, sparse] } });
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
      { service: 'identity', method: 'GET', path: '/v1/groups', query: { siteid: 'tenant-a', ispublic: '0' } },
    ]);
  });

  it.each([403, 503])('fails closed when a read answers %i', async (status) => {
    const { identity } = identityWith({ status });
    await expect(identity.userGroups('tenant-a', 1)).rejects.toThrow(`listGroups HTTP_${status}`);
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

  const gapCalls: Record<string, (identity: IdentityClient) => Promise<unknown>> = {
    readAccount: (identity) => identity.readAccount(USER_ID),
    readAccounts: (identity) => identity.readAccounts([USER_ID]),
    siteGroups: (identity) => identity.siteGroups('tenant-a', 0),
  };

  it.each(IDENTITY_READ_GAPS.filter((gap) => gap.method !== 'photoFileExt').map((gap) => [gap.method, gap] as const))(
    '%s fails closed without calling identity',
    async (method, gap) => {
      const { identity, requests } = identityWith();
      const call = gapCalls[method];
      expect(call).toBeDefined();
      const failure = call?.(identity);
      await expect(failure).rejects.toBeInstanceOf(IdentityReadNotProvidedError);
      await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(failure).rejects.toMatchObject({ gap, service: 'identity', name: 'IdentityReadNotProvidedError' });
      expect(requests).toEqual([]);
    },
  );

  it('lists every gap with its legacy source', () => {
    expect(IDENTITY_READ_GAPS.map((gap) => gap.method)).toEqual(['readAccount', 'readAccounts', 'siteGroups', 'photoFileExt']);
    expect(IDENTITY_READ_GAPS.find((gap) => gap.method === 'photoFileExt')?.legacySource).toBe('core/mura/user/userDAO.cfc:78');
    expect(Object.isFrozen(IDENTITY_READ_GAPS)).toBe(true);
  });

  it.each([undefined, null, 'F1'])('answers an empty photo extension for %s', async (photoFileId) => {
    await expect(photoFileExt(photoFileId)).resolves.toBe('');
  });
});
