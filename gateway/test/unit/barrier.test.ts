// Read-after-write barrier over the memory gateway store, and end to end through the composed gateway's dispatcher.
import { LegacyServiceUnavailableError, adminUnavailableResponse, apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER, formatWritePosition, parseWritePosition, type WritePositions } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { BarrierTimeoutError, PROJECTION_AWAIT_TIMEOUT_MS, createSessionBarrier, type SessionBarrier } from '../../src/dispatcher/barrier.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { BRIDGE_SESSION_PATH, type CreatedSession } from '../helpers/legacy-origin.js';
import { createMemoryGatewayDb, type MemoryGatewayDb } from '../helpers/memory-store.js';
import { cutoverTable, entry } from '../helpers/versions.js';

const SESSION = 's1';
const OTHER_SESSION = 's2';
const AWAIT_PATH = '/internal/v1/projection/await';

/** Owners the direct suites' version reverse-projects. */
const PROJECTED: ReadonlySet<string> = new Set(['identity', 'people', 'strategies-content']);

type Answer = (req: ServiceRequest) => Promise<ServiceResponse>;

const positions = (value: string): WritePositions => parseWritePosition(value);

/** Migration's 200 answer: every awaited position applied. */
const confirmed: Answer = async (req) => {
  const awaited = (req.json as { positions?: Record<string, string> }).positions ?? {};
  return { status: 200, headers: { 'content-type': 'application/json' }, body: { applied: true, positions: awaited } };
};

/** Migration's 503 answer once `timeoutMs` elapsed before every position was applied. */
const timedOut: Answer = async () => {
  const { headers, body } = apiUnavailableResponse();
  return { status: 503, headers, body: JSON.parse(body) as unknown };
};

/** Migration refused the connection, as the service client reports it. */
const unreachable: Answer = () =>
  Promise.reject(new ServiceUnavailableError('migration', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })));

/** A ServiceClient that records every call and answers it with `answer`. */
function stubClient(answer: Answer): ServiceClient & { calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const request = async (req: ServiceRequest): Promise<ServiceResponse> => {
    calls.push(req);
    return answer(req);
  };
  return { calls, request: request as ServiceClient['request'], close: async () => undefined };
}

const stores: MemoryGatewayDb[] = [];
let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  for (const db of stores.splice(0)) await db.end();
});

/** A barrier over a fresh memory gateway store whose migration answers through `answer`. */
function direct(answer: Answer = confirmed): { db: MemoryGatewayDb; client: ReturnType<typeof stubClient>; barrier: SessionBarrier } {
  const db = createMemoryGatewayDb();
  stores.push(db);
  const client = stubClient(answer);
  return { db, client, barrier: createSessionBarrier({ db, client, projectedOwners: () => PROJECTED }) };
}

/** The session's `gateway.session_barrier` rows as owner -> xid. */
function rowsOf(db: MemoryGatewayDb, sessionId: string): Record<string, string | null> {
  return Object.fromEntries(db.tables.session_barrier.filter((row) => row.session_id === sessionId).map((row) => [row.owner, row.xid]));
}

/** The value `promise` rejects with; fails the test when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('createSessionBarrier over the memory gateway store', () => {
  it.each([
    ['identity=100,people=7', 'identity=90,people=12', { identity: '100', people: '12' }],
    ['people=99', 'people=100', { people: '100' }],
    ['people=100', 'people=99', { people: '100' }],
  ])('record of %s then %s keeps the numerically highest xid per owner', async (first, second, expected) => {
    const { db, client, barrier } = direct();
    await barrier.record(SESSION, positions(first));
    await barrier.record(SESSION, positions(second));
    expect(rowsOf(db, SESSION)).toEqual(expected);
    expect(client.calls).toEqual([]);
  });

  it('awaitForSession posts the merged positions with the 5 s bound to migration, then drops them', async () => {
    const { db, client, barrier } = direct();
    await barrier.record(SESSION, positions('identity=100,people=7'));
    await barrier.record(SESSION, positions('identity=90,people=12'));
    await barrier.awaitForSession(SESSION);
    expect(PROJECTION_AWAIT_TIMEOUT_MS).toBe(5000);
    expect(client.calls).toEqual([
      {
        service: 'migration',
        method: 'POST',
        path: AWAIT_PATH,
        json: { positions: { identity: '100', people: '12' }, timeoutMs: 5000 },
        userToken: null,
      },
    ]);
    expect(rowsOf(db, SESSION)).toEqual({});
  });

  it('awaitForSession asks migration nothing for a session without rows and leaves other sessions alone', async () => {
    const { db, client, barrier } = direct();
    await barrier.record(OTHER_SESSION, positions('people=5'));
    await barrier.awaitForSession(SESSION);
    expect(client.calls).toEqual([]);
    expect(rowsOf(db, OTHER_SESSION)).toEqual({ people: '5' });
  });

  it.each<[string, string, Record<string, string>]>([
    ['a higher xid of an awaited owner', 'people=15', { people: '15' }],
    ['a first position of an owner not awaited', 'strategies-content=3', { 'strategies-content': '3' }],
    ['a lower xid of an awaited owner', 'people=11', {}],
  ])('awaitForSession drops only confirmed positions when %s is recorded during the await', async (_name, during, kept) => {
    const meanwhile: { record?: () => Promise<void> } = {};
    const { db, client, barrier } = direct(async (req) => {
      const record = meanwhile.record;
      meanwhile.record = undefined;
      await record?.();
      return confirmed(req);
    });
    await barrier.record(SESSION, positions('identity=100,people=12'));
    meanwhile.record = () => barrier.record(SESSION, positions(during));
    await barrier.awaitForSession(SESSION);
    expect(rowsOf(db, SESSION)).toEqual(kept);
    expect(client.calls[0]?.json).toEqual({ positions: { identity: '100', people: '12' }, timeoutMs: 5000 });

    // The next legacy-bound request awaits exactly what the first await left.
    await barrier.awaitForSession(SESSION);
    const next = Object.keys(kept).length === 0 ? [] : [{ positions: kept, timeoutMs: 5000 }];
    expect(client.calls.slice(1).map((call) => call.json)).toEqual(next);
    expect(rowsOf(db, SESSION)).toEqual({});
  });

  it.each([
    ['a 503 timeout answer', timedOut],
    ['an unreachable migration', unreachable],
  ])('awaitForSession rejects %s as a legacy-unavailable BarrierTimeoutError and keeps every row', async (_name, answer) => {
    const { db, barrier } = direct(answer);
    await barrier.record(SESSION, positions('identity=100,people=12'));
    const error = await rejectionOf(barrier.awaitForSession(SESSION));
    expect(error).toBeInstanceOf(BarrierTimeoutError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ awaited: 'identity=100,people=12', reason: 'barrier-timeout' });
    expect(rowsOf(db, SESSION)).toEqual({ identity: '100', people: '12' });
  });

  it('awaitOwners posts the owners with the 5 s bound and touches no session row', async () => {
    const { db, client, barrier } = direct();
    await barrier.awaitOwners(['identity', 'people']);
    expect(client.calls).toEqual([
      { service: 'migration', method: 'POST', path: AWAIT_PATH, json: { owners: ['identity', 'people'], timeoutMs: 5000 }, userToken: null },
    ]);
    expect(db.queries).toEqual([]);
  });
});

const ROSTER_GROUP = 'grp:identity.user_account';
const ARCHIVE_URL = '/legacy-fixtures/cfml/api.cfm/people/persons/1001/archive';
const DASHBOARD_URL = '/admin/?muraAction=cDashboard.main';
const WRITE_POSITION = WRITE_POSITION_HEADER.toLowerCase();

/**
 * One target group writing identity and people units, so both owners are reverse-projected; no login group, so sessions
 * stay legacy-primary. Admin target actions reach web, so the people-served fixture archive route carries the write.
 */
const FIXTURE = cutoverTable({
  tableVersion: 'v0002',
  entries: [
    entry({
      route: 'admin:cusers.update{type=2,action=update}',
      kind: 'write',
      state: 'target',
      owningService: 'people',
      units: ['identity.user_account', 'people.person'],
      group: ROSTER_GROUP,
    }),
    entry({
      route: 'fixture:people/persons/{id}/archive@post',
      kind: 'write',
      state: 'target',
      owningService: 'people',
      units: ['people.person_archive'],
      group: ROSTER_GROUP,
    }),
    entry({ route: 'admin:cdashboard.main', kind: 'read', state: 'legacy', owningService: 'reporting', disposition: 'legacy-served' }),
  ],
});

/** The composed gateway over the fixture; an unconfirmed await answers 503 after 25 ms instead of 5 s. */
async function startGateway(): Promise<TestGateway> {
  gateway = await buildTestGateway({ version: FIXTURE, services: ['people'], migration: { neverAnswerAfterMs: 25 } });
  return gateway;
}

/** A logged-in legacy session of `userId`, as the browser holds it in legacy-primary mode. */
function legacyLogin(g: TestGateway, userId: string): CreatedSession {
  return g.legacy.createSession({ user: { userID: userId, username: userId, siteID: 'default' }, isLoggedIn: true });
}

function archive(g: TestGateway, browser: CreatedSession) {
  return g.app.inject({
    method: 'POST',
    url: ARCHIVE_URL,
    headers: { cookie: browser.cookieHeader, 'content-type': 'application/json' },
    payload: { effectiveFrom: '2026-07-01' },
  });
}

function dashboard(g: TestGateway, browser: CreatedSession) {
  return g.app.inject({ method: 'GET', url: DASHBOARD_URL, headers: { cookie: browser.cookieHeader } });
}

/** The identity session the gateway adopted for `browser`'s legacy session. */
function identitySessionOf(g: TestGateway, browser: CreatedSession): string {
  const found = [...g.identity.sessions.values()].find((session) => session.legacySessionId === browser.session.legacySessionId);
  if (found === undefined) throw new Error(`no identity session adopted ${browser.session.legacySessionId}`);
  return found.sessionId;
}

/** Barrier rows of `sessionId` in the composed gateway's memory store. */
function barrierRows(g: TestGateway, sessionId: string): Record<string, string | null> {
  if (g.memory === undefined) throw new Error('the test gateway runs over a memory store');
  return rowsOf(g.memory, sessionId);
}

/** Page requests legacy received, bridge calls excepted. */
function pages(g: TestGateway): string[] {
  return g.legacy.requests.filter((req) => req.path !== BRIDGE_SESSION_PATH).map((req) => req.url);
}

describe('the read-after-write barrier through the dispatcher', () => {
  it('strips the write position from the client response and records both owners for the session', async () => {
    const g = await startGateway();
    const browser = legacyLogin(g, 'USER-A');
    g.targets.people?.setWritePosition(formatWritePosition({ identity: '100', people: '7' }));
    const res = await archive(g, browser);
    expect(res.statusCode).toBe(200);
    expect(res.headers[WRITE_POSITION]).toBeUndefined();
    expect(g.targets.people?.requests.map((req) => req.path)).toEqual([ARCHIVE_URL]);
    expect(barrierRows(g, identitySessionOf(g, browser))).toEqual({ identity: '100', people: '7' });
    expect(g.migration.awaits).toEqual([]);
  });

  it("awaits the session's positions in migration before legacy receives its next page", async () => {
    const g = await startGateway();
    const browser = legacyLogin(g, 'USER-A');
    const awaitsSeenByLegacy: number[] = [];
    g.legacy.setResponse(() => {
      awaitsSeenByLegacy.push(g.migration.awaits.length);
      return {};
    });
    g.targets.people?.setWritePosition(formatWritePosition({ identity: '100', people: '7' }));
    expect((await archive(g, browser)).statusCode).toBe(200);

    const res = await dashboard(g, browser);
    expect(res.statusCode).toBe(200);
    expect(g.migration.awaits.map((call) => call.body)).toEqual([{ positions: { identity: '100', people: '7' }, timeoutMs: 5000 }]);
    expect(awaitsSeenByLegacy).toEqual([1]);
    expect(pages(g)).toEqual([DASHBOARD_URL]);
    expect(barrierRows(g, identitySessionOf(g, browser))).toEqual({});
  });

  it('barrier timeout answers the legacy 503 and never calls legacy', async () => {
    const g = await startGateway();
    const browser = legacyLogin(g, 'USER-A');
    g.targets.people?.setWritePosition(formatWritePosition({ identity: '100', people: '7' }));
    expect((await archive(g, browser)).statusCode).toBe(200);
    g.migration.setAwait('never');

    const res = await dashboard(g, browser);
    const expected = adminUnavailableResponse();
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toBe(expected.headers['Content-Type']);
    expect(res.body).toBe(expected.body);
    expect(g.migration.awaits).toHaveLength(1);
    expect(pages(g)).toEqual([]);
    expect(barrierRows(g, identitySessionOf(g, browser))).toEqual({ identity: '100', people: '7' });
  });

  it("a legacy-bound request of another session awaits nothing and leaves the writer's positions", async () => {
    const g = await startGateway();
    const writer = legacyLogin(g, 'USER-A');
    const reader = legacyLogin(g, 'USER-B');
    g.targets.people?.setWritePosition(formatWritePosition({ identity: '100', people: '7' }));
    expect((await archive(g, writer)).statusCode).toBe(200);
    // The reader's own write commits nothing to await, so its session is mapped without barrier rows.
    g.targets.people?.setWritePosition();
    expect((await archive(g, reader)).statusCode).toBe(200);

    const res = await dashboard(g, reader);
    expect(res.statusCode).toBe(200);
    expect(g.migration.awaits).toEqual([]);
    expect(pages(g)).toEqual([DASHBOARD_URL]);
    expect(barrierRows(g, identitySessionOf(g, reader))).toEqual({});
    expect(barrierRows(g, identitySessionOf(g, writer))).toEqual({ identity: '100', people: '7' });
  });
});
