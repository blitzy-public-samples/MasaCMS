/** Consumer contract of people's identity client: every request it sends and every answer it reads, against identity's OpenAPI contract. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER_LC, parseWritePosition } from '@opt2/platform/migration-kit';
import {
  ServiceUnavailableError,
  currentRequestContext,
  newRequestContext,
  runWithRequestContext,
  type RequestContextStore,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  ContractAssertionError,
  TENANT_A,
  TENANT_UMBRELLA,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  findOperation,
} from '@opt2/platform/testing';
import {
  createIdentityClient,
  type AccountOperationState,
  type AccountPrepareRequest,
  type AccountView,
  type ActingUser,
  type CommitOutcome,
  type GroupSummary,
  type IdentityClient,
  type PrepareOutcome,
  type UserGroupRow,
} from '../../src/legacy/identity-client.js';
import { TEST_CLOCK, buildTestApp, userHeaders, type TestApp } from '../helpers/app.js';
import {
  DEFAULT_PEOPLE_SEED,
  SITE_ADMIN_A,
  SITE_ADMIN_A_PERSON,
  SYSTEM_USER_A_PERSON,
  TENANT_A_SYSTEM_USERS,
  accountFor,
  accountsForSeed,
} from '../helpers/fixtures.js';
import { IdentityContractViolation, createIdentityDouble, type DoubleGroup, type IdentityDouble } from '../helpers/identity-double.js';

interface IdentityDoc {
  info: { title: string };
  components: {
    headers: Record<string, { schema: { pattern: string } }>;
    schemas: Record<string, { enum?: string[] }>;
  };
}

const IDENTITY_DOC = parse(readFileSync(new URL('../../../identity/contracts/openapi.yaml', import.meta.url), 'utf8')) as IdentityDoc;
const PEOPLE_DOC = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as { 'x-opt2-calls': string[] };

// A contract without the header schema yields a pattern that matches no value.
const WRITE_POSITION_PATTERN = new RegExp(IDENTITY_DOC.components.headers.XOpt2WritePosition?.schema.pattern ?? '(?!)');
const OPERATION_STATES: readonly string[] = IDENTITY_DOC.components.schemas.AccountOperationState?.enum ?? [];

const SESSION_ID = 'identity-client-contract-session';
const BLOCKED_UNTIL = '2026-06-30T09:30:00.000';

const ADMIN_GROUP: DoubleGroup = { UserID: cfUuid(), GroupName: 'Admin', SiteID: TENANT_A.siteId, isPublic: 0, Perm: 0 };
const MEMBERS_GROUP: DoubleGroup = { UserID: cfUuid(), GroupName: 'Members', SiteID: TENANT_UMBRELLA.siteId, isPublic: 1, Perm: 0 };

/** One identity call as people's client made it, with the answer or the rejection it got. */
interface Exchange {
  readonly request: ServiceRequest;
  response?: ServiceResponse;
  error?: unknown;
}

/** Forwards every call to `inner` and records each request with its response or error, in call order. */
function recordingClient(inner: ServiceClient): { client: ServiceClient; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const client: ServiceClient = {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      const exchange: Exchange = { request: req };
      exchanges.push(exchange);
      try {
        const response = await inner.request<T>(req);
        exchange.response = response;
        return response;
      } catch (error) {
        exchange.error = error;
        throw error;
      }
    },
    close: () => inner.close(),
  };
  return { client, exchanges };
}

/** The identity contract's `paths` key serving the request. */
function templatePathOf(request: ServiceRequest): string {
  return findOperation(IDENTITY_DOC, request.method, request.path).template;
}

/** The identity contract's `operationId` of the request. */
function operationIdOf({ request }: Exchange): string | undefined {
  return findOperation(IDENTITY_DOC, request.method, request.path).operation.operationId;
}

/** The query parameters the service client puts on the wire; undefined values are skipped. */
function wireQuery(query: ServiceRequest['query']): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(query ?? {}).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
}

/** Checks each request against its identity operation, and each answer against that operation's declared responses. */
function assertExchangesMatchContract(exchanges: readonly Exchange[]): void {
  for (const { request, response } of exchanges) {
    expect(request.service).toBe('identity');
    const { operation } = findOperation(IDENTITY_DOC, request.method, request.path);
    const requestBody = operation.requestBody as { required?: boolean } | undefined;
    if (request.json !== undefined) expect(requestBody, `${request.method} ${request.path} declares a body`).toBeDefined();
    if (requestBody?.required === true) expect(request.json, `${request.method} ${request.path} sends its body`).toBeDefined();
    assertRequestMatchesOpenApi(IDENTITY_DOC, {
      method: request.method,
      path: request.path,
      query: wireQuery(request.query),
      ...(request.json === undefined ? {} : { contentType: 'application/json', body: request.json }),
    });
    if (response === undefined) continue;
    const contentType = response.headers['content-type'];
    assertResponseMatchesOpenApi(IDENTITY_DOC, { method: request.method, path: templatePathOf(request), status: response.status, contentType, body: response.body });
    const position = response.headers[WRITE_POSITION_HEADER_LC];
    for (const value of position === undefined ? [] : [position].flat()) expect(value).toMatch(WRITE_POSITION_PATTERN);
  }
}

/** The identity double over people's seed, its groups and memberships, and people's client over a recorder of it. */
interface Subject {
  readonly double: IdentityDouble;
  readonly identity: IdentityClient;
  readonly exchanges: Exchange[];
}

function seededSubject(): Subject {
  const double = createIdentityDouble({ clock: TEST_CLOCK });
  double.seedAccounts(...accountsForSeed(DEFAULT_PEOPLE_SEED));
  double.seedGroups(ADMIN_GROUP, MEMBERS_GROUP);
  double.seedMemberships(SITE_ADMIN_A_PERSON.userid, [ADMIN_GROUP.UserID]);
  double.seedMemberships(SYSTEM_USER_A_PERSON.userid, [MEMBERS_GROUP.UserID]);
  const { client, exchanges } = recordingClient(double.client);
  return { double, identity: createIdentityClient(client), exchanges };
}

/** Runs `fn` in the request context of tenant-a's site administrator signed in under `SESSION_ID`. */
function inSiteAdminSession<T>(fn: () => Promise<T>): Promise<T> {
  const store: RequestContextStore = newRequestContext({ clock: TEST_CLOCK });
  store.user = {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: SITE_ADMIN_A.sub,
    sid: SESSION_ID,
    tid: TENANT_A.tenantId,
    site: SITE_ADMIN_A.site,
    roles: [...SITE_ADMIN_A.roles],
    s2: SITE_ADMIN_A.s2,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
  store.site = SITE_ADMIN_A.site;
  store.tenantId = TENANT_A.tenantId;
  return runWithRequestContext(store, fn);
}

/** An update of the person's stored account that keeps its columns and sets `groupIds`. */
function updateOf(account: AccountView, groupIds: readonly string[]): AccountPrepareRequest {
  return {
    kind: 'update',
    siteId: account.siteId,
    account: { UserName: account.username ?? '', Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2 },
    groupIds: [...groupIds],
  };
}

const UPDATE = updateOf(accountFor(SYSTEM_USER_A_PERSON), [MEMBERS_GROUP.UserID]);

type RosterStep = 'prepare' | 'commit' | 'abort' | 'finish' | 'revert';

/** Takes the operation through `steps` in order. */
async function stepThrough(identity: IdentityClient, userId: string, operationId: string, steps: readonly RosterStep[], change = UPDATE): Promise<void> {
  for (const step of steps) {
    if (step === 'prepare') await identity.prepare(userId, operationId, change);
    else if (step === 'commit') await identity.commit(userId, operationId);
    else await identity[step](userId, operationId);
  }
}

/** What one case works with: the subject, the seeded user it addresses and a fresh operation id. */
interface CaseContext extends Subject {
  readonly userId: string;
  readonly operationId: string;
}

/** One client method: the identity operations its call sends, in order, and what it resolves to. */
interface ClientCase {
  readonly operations: readonly string[];
  /** Brings identity to the state the call needs. */
  readonly arrange?: (ctx: CaseContext) => Promise<unknown>;
  readonly act: (ctx: CaseContext) => Promise<unknown>;
  readonly expected: (ctx: CaseContext) => unknown;
}

const SYSTEM_USER_ACCOUNT = accountFor(SYSTEM_USER_A_PERSON);
const SITE_ADMIN_ACCOUNT = accountFor(SITE_ADMIN_A_PERSON);
const SITE_ADMIN_USER: ActingUser = { userId: SITE_ADMIN_A_PERSON.userid, fname: SITE_ADMIN_A_PERSON.fname ?? '', lname: SITE_ADMIN_A_PERSON.lname ?? '' };

const CASES = {
  prepare: {
    operations: ['prepareAccountOperation'],
    act: ({ identity, userId, operationId }) => identity.prepare(userId, operationId, UPDATE),
    expected: ({ userId, operationId }) => expect.objectContaining({ ok: true, operationId, userId, kind: 'update', state: 'prepared' }),
  },
  commit: {
    operations: ['commitAccountOperation'],
    arrange: ({ identity, userId, operationId }) => stepThrough(identity, userId, operationId, ['prepare']),
    act: ({ identity, userId, operationId }) => identity.commit(userId, operationId),
    expected: ({ userId, operationId }): CommitOutcome => ({ operationId, userId, state: 'committed', writePosition: expect.stringMatching(/^[0-9]+$/) as string }),
  },
  abort: {
    operations: ['abortAccountOperation'],
    arrange: ({ identity, userId, operationId }) => stepThrough(identity, userId, operationId, ['prepare']),
    act: ({ identity, userId, operationId }) => identity.abort(userId, operationId),
    expected: () => undefined,
  },
  finish: {
    operations: ['finishAccountOperation'],
    arrange: ({ identity, userId, operationId }) => stepThrough(identity, userId, operationId, ['prepare', 'commit']),
    act: ({ identity, userId, operationId }) => identity.finish(userId, operationId),
    expected: () => undefined,
  },
  revert: {
    operations: ['revertAccountOperation'],
    arrange: ({ identity, userId, operationId }) => stepThrough(identity, userId, operationId, ['prepare', 'commit']),
    act: ({ identity, userId, operationId }) => identity.revert(userId, operationId),
    expected: () => undefined,
  },
  operationState: {
    operations: ['getAccountOperation'],
    arrange: ({ identity, userId, operationId }) => stepThrough(identity, userId, operationId, ['prepare']),
    act: ({ identity, userId, operationId }) => identity.operationState(userId, operationId),
    expected: (): AccountOperationState => 'prepared',
  },
  readAccount: {
    operations: ['getAccount'],
    act: ({ identity, userId }) => identity.readAccount(userId),
    expected: (): AccountView => SYSTEM_USER_ACCOUNT,
  },
  readAccounts: {
    operations: ['lookupAccounts'],
    act: ({ identity, userId }) => identity.readAccounts([userId, SITE_ADMIN_ACCOUNT.userId]),
    expected: ({ userId }) => new Map([[userId, SYSTEM_USER_ACCOUNT], [SITE_ADMIN_ACCOUNT.userId, SITE_ADMIN_ACCOUNT]]),
  },
  readAccountsAllSites: {
    operations: ['lookupAccountsAllSites'],
    act: ({ identity, userId }) => identity.readAccountsAllSites([userId, SITE_ADMIN_ACCOUNT.userId], { inActive: 0 }),
    expected: ({ userId }) => new Map([[userId, SYSTEM_USER_ACCOUNT], [SITE_ADMIN_ACCOUNT.userId, SITE_ADMIN_ACCOUNT]]),
  },
  countAccounts: {
    operations: ['countAccounts'],
    act: ({ identity }) => identity.countAccounts({ scope: 'pool', publicPool: false, where: { siteIds: [TENANT_A.siteId] } }),
    expected: () => TENANT_A_SYSTEM_USERS.length,
  },
  usernameCandidates: {
    operations: ['lookupUsernameCandidates'],
    act: ({ identity }) => identity.usernameCandidates({ publicPool: false, pattern: 'site_admin%', where: { siteIds: [TENANT_A.siteId] }, limit: 10 }),
    expected: () => ({ items: [{ userId: SITE_ADMIN_ACCOUNT.userId, username: SITE_ADMIN_ACCOUNT.username }], complete: true }),
  },
  lookupMemberships: {
    operations: ['lookupMemberships'],
    act: ({ identity, userId }) => identity.lookupMemberships([userId, SITE_ADMIN_ACCOUNT.userId]),
    expected: ({ userId }) => new Map([[userId, [MEMBERS_GROUP.UserID]], [SITE_ADMIN_ACCOUNT.userId, [ADMIN_GROUP.UserID]]]),
  },
  userMemberships: {
    operations: ['listUserMemberships'],
    act: ({ identity, userId }) => identity.userMemberships(userId, TENANT_A.siteId),
    expected: () => ({
      privateGroups: [{ UserID: ADMIN_GROUP.UserID, GroupName: ADMIN_GROUP.GroupName }],
      publicGroups: [{ UserID: MEMBERS_GROUP.UserID, GroupName: MEMBERS_GROUP.GroupName }],
      groupIds: [MEMBERS_GROUP.UserID],
    }),
  },
  membershipGroupIds: {
    operations: ['getAccountMemberships'],
    act: ({ identity, userId }) => identity.membershipGroupIds(userId),
    expected: () => [MEMBERS_GROUP.UserID],
  },
  siteGroups: {
    operations: ['listSiteGroups'],
    act: ({ identity }) => identity.siteGroups(TENANT_A.siteId, 0),
    expected: (): GroupSummary[] => [{ groupId: ADMIN_GROUP.UserID, groupName: ADMIN_GROUP.GroupName, siteId: TENANT_A.siteId, isPublic: 0, perm: 0 }],
  },
  userGroups: {
    operations: ['listGroups'],
    act: ({ identity }) => identity.userGroups(TENANT_A.siteId, 1),
    expected: (): UserGroupRow[] => [
      {
        userId: MEMBERS_GROUP.UserID,
        email: null,
        groupName: MEMBERS_GROUP.GroupName,
        type: 1,
        lastLogin: null,
        lastUpdate: null,
        lastUpdateBy: null,
        lastUpdateById: null,
        counter: 1,
        perm: 0,
        isPublic: 1,
      },
    ],
  },
  actingUser: {
    operations: ['getCurrentSession'],
    arrange: async ({ double }) => {
      double.seedSessions({ sessionId: SESSION_ID, user: { isLoggedIn: true, userID: SITE_ADMIN_USER.userId, fname: SITE_ADMIN_USER.fname, lname: SITE_ADMIN_USER.lname } });
    },
    act: ({ identity }) => identity.actingUser(SESSION_ID),
    expected: (): ActingUser => SITE_ADMIN_USER,
  },
  adminSessionState: {
    operations: ['getAdminSessionState'],
    arrange: ({ identity }) => identity.saveAdminSessionState({ keywords: 'sasha' }),
    act: ({ identity }) => identity.adminSessionState(),
    expected: () => ({ keywords: 'sasha' }),
  },
  saveAdminSessionState: {
    operations: ['saveAdminSessionState'],
    arrange: ({ identity }) => identity.saveAdminSessionState({ keywords: 'sasha' }),
    act: ({ identity }) => identity.saveAdminSessionState({ siteid: TENANT_A.siteId }),
    expected: () => ({ keywords: 'sasha', siteid: TENANT_A.siteId }),
  },
  sessionSites: {
    operations: ['listCurrentSessionSites'],
    arrange: async ({ double }) => {
      double.seedSessionSites([{ siteID: TENANT_A.siteId, site: 'Tenant A' }]);
    },
    act: ({ identity }) => identity.sessionSites(),
    expected: () => [{ siteID: TENANT_A.siteId, site: 'Tenant A' }],
  },
  loginBlock: {
    operations: ['loadLoginBlock'],
    arrange: async ({ double, userId }) => {
      double.setLoginBlock(userId, BLOCKED_UNTIL);
    },
    act: ({ identity, userId }) => identity.loginBlock(userId, false),
    expected: () => BLOCKED_UNTIL,
  },
} satisfies Record<keyof IdentityClient, ClientCase>;

type ClientMethod = keyof typeof CASES;

/** A case context addressing the seeded tenant-a system user with a fresh operation id. */
function caseContext(subject: Subject): CaseContext {
  return { ...subject, userId: SYSTEM_USER_A_PERSON.userid, operationId: cfUuid() };
}

/** Runs the method's case in the site administrator's session and returns its result and the calls its act made. */
async function runCase(name: ClientMethod, subject: Subject): Promise<{ result: unknown; acted: Exchange[]; ctx: CaseContext }> {
  const spec: ClientCase = CASES[name];
  const ctx = caseContext(subject);
  return inSiteAdminSession(async () => {
    await spec.arrange?.(ctx);
    const start = subject.exchanges.length;
    const result = await spec.act(ctx);
    return { result, acted: subject.exchanges.slice(start), ctx };
  });
}

/** The names of the function-valued members of a client people creates. */
function clientMethods(identity: IdentityClient): string[] {
  return Object.entries(identity)
    .filter(([, member]) => typeof member === 'function')
    .map(([name]) => name)
    .sort();
}

let subject: Subject;

beforeEach(() => {
  subject = seededSubject();
});

describe("requests people's identity client sends", () => {
  it('has a case for every method of the client', () => {
    expect(clientMethods(subject.identity)).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.keys(CASES) as ClientMethod[])('%s sends only operations identity declares and resolves to the identity data', async (name) => {
    const { result, acted, ctx } = await runCase(name, subject);
    expect(acted.map(operationIdOf)).toEqual(CASES[name].operations);
    expect(result).toEqual(CASES[name].expected(ctx));
    expect(subject.exchanges.filter((exchange) => exchange.error !== undefined)).toEqual([]);
    assertExchangesMatchContract(subject.exchanges);
  });

  it.each([
    ['prepare', 'POST', ':prepare'],
    ['commit', 'POST', ':commit'],
    ['abort', 'POST', ':abort'],
    ['finish', 'POST', ':finish'],
    ['revert', 'POST', ':revert'],
    ['operationState', 'GET', ''],
  ] as const)('sends %s as %s to the declared account-operation path', async (name, method, suffix) => {
    const { acted, ctx } = await runCase(name, subject);
    expect(acted).toHaveLength(1);
    const [{ request }] = acted as [Exchange];
    expect({ method: request.method, path: request.path }).toEqual({
      method,
      path: `/internal/v1/accounts/${ctx.userId}/operations/${ctx.operationId}${suffix}`,
    });
    expect(templatePathOf(request)).toBe(`/internal/v1/accounts/{userId}/operations/{operationId}${suffix}`);
  });

  it.each([
    ['an undeclared path', { method: 'GET', path: `/internal/v1/accounts/${SYSTEM_USER_A_PERSON.userid}/password` }, 'undeclared operation'],
    ['a step verb as a path segment', { method: 'POST', path: `/internal/v1/accounts/${SYSTEM_USER_A_PERSON.userid}/operations/${cfUuid()}/commit` }, 'undeclared operation'],
    [
      'a prepare body without its account',
      { method: 'POST', path: `/internal/v1/accounts/${SYSTEM_USER_A_PERSON.userid}/operations/${cfUuid()}:prepare`, json: { kind: 'update', siteId: TENANT_A.siteId, groupIds: [] } },
      'invalid request body',
    ],
  ] as const)('the identity double refuses %s', async (_case, call, reason) => {
    const sent = subject.double.client.request({ service: 'identity', ...call });
    await expect(sent).rejects.toBeInstanceOf(IdentityContractViolation);
    await expect(sent).rejects.toMatchObject({ reason });
  });
});

describe("identity's answers as people's client reads them", () => {
  it("returns identity's legacy validation errors unchanged, in identity's key order", async () => {
    const errors = {
      username: `The username '${SYSTEM_USER_ACCOUNT.username ?? ''}' that you entered is being used by another user.`,
      password: 'The Password you submitted must meet the following criteria: Passwords cannot be the same as the username.',
    };
    subject.double.setPrepareErrors(SYSTEM_USER_A_PERSON.userid, errors);
    const outcome: PrepareOutcome = await inSiteAdminSession(() => subject.identity.prepare(SYSTEM_USER_A_PERSON.userid, cfUuid(), UPDATE));
    expect(outcome).toEqual({ ok: false, errors });
    expect(outcome.ok ? [] : Object.keys(outcome.errors)).toEqual(['username', 'password']);
    expect(subject.exchanges.map((exchange) => exchange.response?.status)).toEqual([400]);
    assertExchangesMatchContract(subject.exchanges);
  });

  it("feeds identity's commit position into the request's write positions", async () => {
    const userId = SYSTEM_USER_A_PERSON.userid;
    const operationId = cfUuid();
    const { outcome, recorded } = await inSiteAdminSession(async () => {
      await subject.identity.prepare(userId, operationId, UPDATE);
      const committed: CommitOutcome = await subject.identity.commit(userId, operationId);
      return { outcome: committed, recorded: currentRequestContext()?.writePositions.get('identity') };
    });
    expect(outcome.writePosition).toMatch(/^[0-9]+$/);
    const commit = subject.exchanges.find((exchange) => operationIdOf(exchange) === 'commitAccountOperation');
    const header = commit?.response?.headers[WRITE_POSITION_HEADER_LC];
    expect(parseWritePosition(header)).toEqual(new Map([['identity', outcome.writePosition]]));
    expect(recorded).toBe(outcome.writePosition);
    assertExchangesMatchContract(subject.exchanges);
  });

  it.each([
    ['without writePosition', (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'writePosition'))],
    ['with a numeric writePosition', (body: Record<string, unknown>) => ({ ...body, writePosition: Number(body.writePosition) })],
  ])("identity's contract refuses a commit answer %s", async (_case, mutate) => {
    const { acted } = await runCase('commit', subject);
    const [{ request, response }] = acted as [Exchange];
    const body = mutate(response?.body as Record<string, unknown>);
    expect(() =>
      assertResponseMatchesOpenApi(IDENTITY_DOC, { method: request.method, path: templatePathOf(request), status: 200, contentType: 'application/json', body }),
    ).toThrow(ContractAssertionError);
  });

  it('reads every operation state identity reports', async () => {
    const flows: ReadonlyArray<readonly [readonly RosterStep[], AccountOperationState | undefined]> = [
      [[], undefined],
      [['prepare'], 'prepared'],
      [['prepare', 'commit'], 'committed'],
      [['prepare', 'commit', 'finish'], 'finished'],
      [['prepare', 'abort'], 'aborted'],
      [['prepare', 'commit', 'revert'], 'reverted'],
    ];
    // One user per flow, so an operation a flow leaves open closes no later flow's user.
    const persons = TENANT_A_SYSTEM_USERS.slice(0, flows.length);
    const states = await inSiteAdminSession(async () => {
      const read: Array<AccountOperationState | undefined> = [];
      for (const [index, [steps]] of flows.entries()) {
        const account = accountFor(persons[index] ?? SYSTEM_USER_A_PERSON);
        const operationId = cfUuid();
        await stepThrough(subject.identity, account.userId, operationId, steps, updateOf(account, []));
        read.push(await subject.identity.operationState(account.userId, operationId));
      }
      return read;
    });
    expect(states).toEqual(flows.map(([, state]) => state));
    const reported = subject.exchanges
      .filter((exchange) => operationIdOf(exchange) === 'getAccountOperation')
      .map((exchange) => (exchange.response?.body as { state: string }).state);
    expect(new Set(reported)).toEqual(new Set(OPERATION_STATES));
    assertExchangesMatchContract(subject.exchanges);
  });

  it('leaves a commit whose answer was lost readable as committed', async () => {
    const userId = SYSTEM_USER_A_PERSON.userid;
    const operationId = cfUuid();
    const { state, recorded } = await inSiteAdminSession(async () => {
      await subject.identity.prepare(userId, operationId, UPDATE);
      subject.double.failAt('commit', 'lost-reply');
      await expect(subject.identity.commit(userId, operationId)).rejects.toBeInstanceOf(ServiceUnavailableError);
      return { state: await subject.identity.operationState(userId, operationId), recorded: currentRequestContext()?.writePositions.has('identity') };
    });
    expect(state).toBe('committed');
    expect(recorded).toBe(false);
    const commit = subject.exchanges.find((exchange) => operationIdOf(exchange) === 'commitAccountOperation');
    expect(commit?.response).toBeUndefined();
    expect(commit?.error).toBeInstanceOf(ServiceUnavailableError);
    assertExchangesMatchContract(subject.exchanges);
  });
});

describe('identity unavailable', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.close();
    testApp = undefined;
  });

  it.each(['prepare', 'commit', 'abort', 'finish', 'revert', 'operationState', 'readAccount'] as const)(
    '%s rejects with the legacy 503 error after sending a declared request',
    async (name) => {
      subject.double.setUnreachable(true);
      const spec: ClientCase = CASES[name];
      const ctx = caseContext(subject);
      const failure = inSiteAdminSession(() => spec.act(ctx));
      await expect(failure).rejects.toBeInstanceOf(ServiceUnavailableError);
      await expect(failure).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
      expect(subject.exchanges.map(operationIdOf)).toEqual(spec.operations);
      assertExchangesMatchContract(subject.exchanges);
    },
  );

  it("answers a people request that reads identity with people's declared legacy 503", async () => {
    testApp = await buildTestApp();
    testApp.identity.setUnreachable(true);
    // The cUsers group list reads identity before any people row, so the recording database needs no seeded data.
    const res = await testApp.app.inject({
      method: 'GET',
      url: `/v1/users/groups?siteid=${TENANT_A.siteId}&ispublic=0`,
      headers: await userHeaders(SITE_ADMIN_A),
    });
    expect(res.statusCode).toBe(503);
    assertResponseMatchesOpenApi(PEOPLE_DOC, { method: 'GET', path: '/v1/users/groups', status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    expect(testApp.identity.requests.map((request) => request.operationId)).toContain('listGroups');
  });
});

describe('declared callees', () => {
  it('names identity as the service it is checked against', () => {
    expect(IDENTITY_DOC.info.title).toBe('identity');
    // People also declares strategies-content, which its content client calls; this suite pins only identity's entry.
    expect(PEOPLE_DOC['x-opt2-calls']).toContain('identity');
  });

  it('sends every call of every client method to identity alone', async () => {
    const services = new Set<string>();
    for (const name of Object.keys(CASES) as ClientMethod[]) {
      const fresh = seededSubject();
      await runCase(name, fresh);
      for (const { request } of fresh.exchanges) services.add(request.service);
    }
    expect(services).toEqual(new Set(['identity']));
  });
});

