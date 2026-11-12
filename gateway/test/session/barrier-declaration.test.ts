// Edge dispatch and the relay over the session barrier against PostgreSQL: a target write's declaration guards later legacy reads.
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import replyFrom from '@fastify/reply-from';
import Fastify from 'fastify';
import type { ServiceIdentity, UserClaims } from '@opt2/platform/auth';
import type { RouteKeyResult } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  LEGACY_POST_LIMIT_BYTES,
  createService,
  loadEnv,
  systemClock,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
} from '@opt2/platform/service-kit';
import { withMetadata, type QueryConfig, type QueryResultRow, type TenantDb } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, testVerifier, type ThrowawaySchema } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CutoverEntry, RoutingIndex } from '../../src/cutover/types.js';
import { createSessionBarrier } from '../../src/dispatcher/barrier.js';
import { registerEdgeRoute, type DispatcherDeps } from '../../src/dispatcher/dispatch.js';
import { failContextFor } from '../../src/dispatcher/fail-closed.js';
import type { LegacyDestination, MatchOutcome, TargetDestination } from '../../src/dispatcher/match.js';
import { relayHandler, type RelayDeps } from '../../src/dispatcher/relay.js';
import type { SessionResolution } from '../../src/session/resolve.js';
import { sendBytes, startHttpDouble, type HttpDouble } from '../helpers/http-double.js';

const SILENT = createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
const SESSION_ID = 'S1';
const COOKIE = { cookie: `JSESSIONID=${SESSION_ID}` };
const WRITE_ENTRY: CutoverEntry = {
  route: 'api:content.save',
  kind: 'write',
  state: 'target',
  owningService: 'people',
  tableVersion: 'v0002',
  units: [],
  disposition: 'carry',
} as unknown as CutoverEntry;
const READ_ENTRY: CutoverEntry = { ...WRITE_ENTRY, route: 'page:render', kind: 'read', state: 'legacy' };

/** v0002 with the identity login group target-authoritative, so sessions are target-primary. */
const INDEX: RoutingIndex = {
  table: { tableVersion: 'v0002' } as RoutingIndex['table'],
  entryFor: () => undefined,
  matchKeys: [] as unknown as RoutingIndex['matchKeys'],
  unitAuthority: () => 'legacy',
  groupOf: () => undefined,
  groupAuthority: () => 'legacy',
  loginGroupAuthority: () => 'target',
};

const SESSION: SessionResolution = {
  kind: 'session',
  sessionId: SESSION_ID,
  epoch: 3,
  mode: 'target-primary',
  legacyCookies: {},
  setCookies: [],
};

interface Gateway {
  app: FastifyInstance;
  legacy: HttpDouble;
  svc: HttpDouble;
  /** Bodies of the projection awaits migration received. */
  awaits: unknown[];
  /** Whether migration confirms projection awaits; false answers HTTP 503. */
  confirm: { value: boolean };
  /** Whether the barrier's position upsert fails. */
  failRecord: { value: boolean };
}

const live = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!live)('a target write declared in gateway.session_barrier against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'gateway',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, (tx) => tx.query(`DELETE FROM ${handle.schema}.session_barrier`));
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  /** The session's barrier rows. */
  async function barrierRows(): Promise<Array<{ owner: string; xid: string | null; pending: number }>> {
    const { rows } = await withMetadata(handle.app, (tx) =>
      tx.query<{ owner: string; xid: string | null; pending: number }>(
        `SELECT owner, xid::text AS xid, pending FROM ${handle.schema}.session_barrier WHERE session_id = $1 ORDER BY owner`,
        [SESSION_ID],
      ),
    );
    return rows;
  }

  /** A gateway whose `/write` is a target write to people and every other path a legacy read, over the real barrier. */
  async function startGateway(): Promise<Gateway> {
    const legacy = await startHttpDouble((_req, res) => sendBytes(res, 200, 'legacy-body'));
    const svc = await startHttpDouble((_req, res) => sendBytes(res, 201, 'committed', { 'x-opt2-write-position': 'people=42' }));
    const awaits: unknown[] = [];
    const confirm = { value: true };
    const failRecord = { value: false };
    const migration = {
      request: async (req: ServiceRequest) => {
        awaits.push(req.json);
        return { status: confirm.value ? 200 : 503, headers: {}, body: {} };
      },
      close: async () => undefined,
    } as unknown as ServiceClient;
    // Fails only the position upsert, as a database that rejects the record after the write committed.
    const db: TenantDb = {
      ...handle.app,
      withMetadata: (fn) =>
        handle.app.withMetadata((tx) =>
          fn({
            ...tx,
            query<R extends QueryResultRow>(sql: string | QueryConfig, values?: unknown[]) {
              const text = typeof sql === 'string' ? sql : sql.text;
              if (failRecord.value && text.includes('SELECT $1, p.owner, p.xid')) return Promise.reject(new Error('INSERT failed'));
              return tx.query<R>(sql, values);
            },
          }),
        ),
    };
    const app = await createService({
      name: 'gateway',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8100',
        OPT2_SERVICE_NAME: 'gateway',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('gateway'),
      logger: SILENT,
    });
    const outcomeFor = (url: string): MatchOutcome => {
      const write = url.startsWith('/write');
      const entry = write ? WRITE_ENTRY : READ_ENTRY;
      const family = write ? 'api' : 'page';
      const result: RouteKeyResult = { key: entry.route, baseKey: entry.route, family, httpMethod: 'GET', params: {}, siteId: 'default' };
      const destination: TargetDestination | LegacyDestination = write
        ? { kind: 'target' as const, service: 'people', serviceUrl: svc.url, path: url, isWeb: false }
        : { kind: 'legacy' as const };
      return { result, entry, destination, failContext: failContextFor(result, url) };
    };
    const barrier = createSessionBarrier({ db, client: migration });
    const deps: DispatcherDeps = {
      matcher: { match: async (request) => outcomeFor(request.url) },
      state: {
        active: () => INDEX,
        readEpochForWrite: async () => ({ epoch: 1, index: INDEX }),
        isFrozen: () => false,
        waitUnfrozen: async () => true,
      },
      inflight: { register: async () => undefined, remove: async () => true },
      windows: {
        open: async () => ({ windowId: 'W1' }),
        complete: async () => ({ state: 'closed' as const }),
        scope: () => ({ table: true as const }),
      },
      barrier,
      resolver: {
        resolveSession: async () => SESSION,
        resolveLegacyBound: async () => SESSION,
        adoptAfterLegacy: async () => SESSION,
      },
      tokenCache: { get: async () => 'user-token-1' },
      identity: { adminSite: () => Promise.reject(new Error('unexpected identity call')) },
      stateCheck: {
        check: async () => ({ state: 'active' as const, epoch: 3, userId: 'U', siteId: 'default', epochChanged: false }),
      },
      hydrator: {
        ensureHydrated: async () => ({
          sessionId: SESSION_ID,
          legacySessionId: 'L-1',
          cookies: {},
          mode: 'target-primary' as const,
          hydratedEpoch: 3,
          updatedAt: new Date(),
        }),
      },
      csrf: { beforeLegacy: async () => undefined, afterLegacy: async () => undefined },
      invalidation: {
        afterTargetLogout: async () => undefined,
        beforeLegacyLogout: async () => undefined,
        afterLegacyLogout: async () => undefined,
        completePending: async () => undefined,
        afterLegacyLogin: async () => undefined,
      } as unknown as DispatcherDeps['invalidation'],
      facts: { get: () => undefined, routes: () => [] },
      auth: app.opt2.auth,
      relay: { env: { OPT2_SERVICE_URLS: {} }, invocation: app.opt2.auth.invocationMinter, barrier, sessionMode: () => 'target-primary' },
      legacyOrigin: legacy.url,
      clock: systemClock,
    };
    await app.register(replyFrom);
    await app.register(async (edge) => {
      edge.removeAllContentTypeParsers();
      edge.addContentTypeParser<Buffer>('*', { parseAs: 'buffer', bodyLimit: LEGACY_POST_LIMIT_BYTES }, (_request, body, done) =>
        done(null, body),
      );
      registerEdgeRoute(edge, deps);
    });
    await app.ready();
    closers.push(async () => {
      await app.opt2.shutdown();
      await Promise.all([legacy.close(), svc.close()]);
    });
    return { app, legacy, svc, awaits, confirm, failRecord };
  }

  it('keeps a committed write whose position and confirmation both failed guarding every later legacy read', async () => {
    const gw = await startGateway();
    gw.failRecord.value = true;
    gw.confirm.value = false;
    const write = await gw.app.inject({ method: 'POST', url: '/write', headers: COOKIE, payload: 'title=x' });
    expect(gw.svc.requests).toHaveLength(1);
    expect(write.statusCode).toBe(503);
    const declaration = [{ owner: 'people', xid: null, pending: 1 }];
    expect(await barrierRows()).toEqual(declaration);

    const reads: Array<[number, string]> = [];
    for (const confirmed of [false, true, false, true]) {
      gw.confirm.value = confirmed;
      const read = await gw.app.inject({ method: 'GET', url: '/page', headers: COOKIE });
      reads.push([read.statusCode, read.statusCode === 200 ? read.body : '']);
      expect(await barrierRows()).toEqual(declaration);
    }
    expect(reads).toEqual([
      [503, ''],
      [200, 'legacy-body'],
      [503, ''],
      [200, 'legacy-body'],
    ]);
    expect(gw.legacy.requests).toHaveLength(2);
    expect(gw.awaits).toEqual([
      { positions: { people: '42' }, timeoutMs: 5000 },
      ...Array.from({ length: 4 }, () => ({ owners: ['people'], timeoutMs: 5000 })),
    ]);
  });

  it.each([
    ['records its position', false, true, 201, [{ owner: 'people', xid: '42', pending: 0 }], 200, [{ positions: { people: '42' }, timeoutMs: 5000 }]],
    ['records nothing but legacy confirms its position', true, true, 201, [], 200, [{ positions: { people: '42' }, timeoutMs: 5000 }]],
    [
      'neither records nor confirms its position',
      true,
      false,
      503,
      [{ owner: 'people', xid: null, pending: 1 }],
      503,
      [
        { positions: { people: '42' }, timeoutMs: 5000 },
        { owners: ['people'], timeoutMs: 5000 },
      ],
    ],
  ] as const)(
    'leaves the declaration in place through a legacy read during the write, which then %s',
    async (_label, failRecord, confirm, writeStatus, after, nextStatus, laterAwaits) => {
      const gw = await startGateway();
      const during: unknown[] = [];
      gw.svc.setHandler(async (_req, res) => {
        const read = await gw.app.inject({ method: 'GET', url: '/page', headers: COOKIE });
        during.push(read.statusCode, await barrierRows());
        gw.failRecord.value = failRecord;
        gw.confirm.value = confirm;
        sendBytes(res, 201, 'committed', { 'x-opt2-write-position': 'people=42' });
      });
      const write = await gw.app.inject({ method: 'POST', url: '/write', headers: COOKIE, payload: 'title=x' });
      expect(during).toEqual([200, [{ owner: 'people', xid: null, pending: 1 }]]);
      expect(write.statusCode).toBe(writeStatus);
      expect(await barrierRows()).toEqual(after);

      const next = await gw.app.inject({ method: 'GET', url: '/page', headers: COOKIE });
      expect(next.statusCode).toBe(nextStatus);
      expect(gw.awaits).toEqual([{ owners: ['people'], timeoutMs: 5000 }, ...laterAwaits]);
    },
  );

  /** A gateway serving only web's relay to `serviceUrl` for session S1, over the real barrier. */
  async function startRelay(serviceUrl: string): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    await app.register(replyFrom);
    const deps: RelayDeps = {
      env: { OPT2_SERVICE_URLS: { people: serviceUrl } },
      invocation: { headersFor: async () => ({}) },
      barrier: createSessionBarrier({ db: handle.app, client: {} as ServiceClient }),
      sessionMode: () => 'target-primary',
    };
    const auth = { userToken: 'user-token-1', user: { sid: SESSION_ID } as UserClaims, caller: { name: 'web', roles: [] } as unknown as ServiceIdentity };
    app.all('/*', (request, reply) => relayHandler(request, reply, { service: 'people', path: request.url, auth }, deps));
    await app.ready();
    closers.push(() => app.close());
    return app;
  }

  it.each([
    ['POST', [{ owner: 'people', xid: null, pending: 1 }]],
    ['GET', []],
  ] as const)('declares a relayed %s while the service handles it, then releases it for a response without a position', async (method, during) => {
    const seen: unknown[] = [];
    const svc = await startHttpDouble(async (_req, res) => {
      seen.push(await barrierRows());
      sendBytes(res, 200, 'ok');
    });
    closers.push(() => svc.close());
    const app = await startRelay(svc.url);
    const res = await app.inject({ method, url: '/v1/users' });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([during]);
    expect(await barrierRows()).toEqual([]);
  });

  it('releases the declaration of a relayed write the service never received', async () => {
    const closed = await startHttpDouble((_req, res) => sendBytes(res, 200, 'never'));
    await closed.close();
    const app = await startRelay(closed.url);
    const res = await app.inject({ method: 'POST', url: '/v1/users' });
    expect(res.statusCode).toBe(503);
    await vi.waitFor(async () => expect(await barrierRows()).toEqual([]));
  });

  it('records a committed write in place of its declaration, so the next legacy read awaits its exact position', async () => {
    const gw = await startGateway();
    const write = await gw.app.inject({ method: 'POST', url: '/write', headers: COOKIE, payload: 'title=x' });
    expect(write.statusCode).toBe(201);
    expect(await barrierRows()).toEqual([{ owner: 'people', xid: '42', pending: 0 }]);
    gw.svc.setHandler((_req, res) => sendBytes(res, 422, 'invalid'));
    const rejected = await gw.app.inject({ method: 'POST', url: '/write', headers: COOKIE, payload: 'title=' });
    expect(rejected.statusCode).toBe(422);
    expect(await barrierRows()).toEqual([{ owner: 'people', xid: '42', pending: 0 }]);

    const read = await gw.app.inject({ method: 'GET', url: '/page', headers: COOKIE });
    expect(read.statusCode).toBe(200);
    expect(gw.awaits).toEqual([{ positions: { people: '42' }, timeoutMs: 5000 }]);
    await vi.waitFor(async () => expect(await barrierRows()).toEqual([]));
  });
});
