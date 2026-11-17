// Claim deadlines and renewals of the window and transition services over a throwaway `migration` schema.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger, type Logger } from '@opt2/platform/logging';
import { GATE_WAIT_MS } from '@opt2/platform/migration-kit';
import { SERVICE_CALL_TIMEOUT_MS, createService, loadEnv, systemClock, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantDbFromPool, type MetadataTx, type Pool, type QueryConfig, type QueryResult, type TenantDb } from '@opt2/platform/tenancy';
import { createThrowawaySchema, mintServiceToken, pgAvailable, testVerifier, type ThrowawaySchema } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { loadUnitCatalog } from '../../src/owners/units.js';
import { registerWindowRoutes } from '../../src/routes/windows.js';
import { createTransitionService, type TransitionService } from '../../src/transition/service.js';
import type { StepDeps, TransitionPlan, TransitionRecord, TransitionStepNumber } from '../../src/transition/steps.js';
import type { ImportResult } from '../../src/windows/import.js';
import { WindowNotFoundError, WindowRefusedError, WindowStateError, createWindowService, type WindowService } from '../../src/windows/service.js';
import { createGatewayDouble, type GatewayDouble } from '../helpers/gateway-double.js';
import { createOwnerDoubles, type OwnerDoubles } from '../helpers/owner-double.js';

const m = vi.hoisted(() => ({ importWindow: vi.fn(), planTransition: vi.fn(), runTransitionStep: vi.fn() }));
vi.mock('../../src/windows/import.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/windows/import.js')>()),
  importWindow: m.importWindow,
}));
vi.mock('../../src/transition/steps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/transition/steps.js')>()),
  planTransition: m.planTransition,
  runTransitionStep: m.runTransitionStep,
}));

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
// v0002 makes the unit target-authoritative.
const TABLE_VERSION = 'v0002';
const FINANCE = 'finance.record';
const ROUTE_KEY = 'admin:cusers.update';
const NO_IMPORT: ImportResult = { rowsImported: 0, perOwner: {}, objectsTransferred: 0, objectsRemoved: [], touchedContent: false, writePositions: new Map() };
/** Claim wait of the services under test; each database step it bounds stays well above one step's latency under load. */
const BUDGET_MS = 2000;
/** An open budget no test outlasts, so no claim renewal comes due. */
const LONG_BUDGET_MS = 600_000;
/** A claim's lifetime under {@link LONG_BUDGET_MS}: one budget plus one longest call. */
const LONG_CLAIM_LIFETIME_MS = LONG_BUDGET_MS + GATE_WAIT_MS + SERVICE_CALL_TIMEOUT_MS;
/** What a lapsing claim has left once its holder's writes start meeting a locked row. */
const VALIDITY_LEFT_MS = 300;
/** Server-side lock bound the cut cases impose, well inside every signal it races, so PostgreSQL ends the wait first (55P03). */
const CUT_LOCK_MS = 100;
/** A lock still held after this long is released, so an unbounded wait fails its assertions instead of hanging. */
const SAFETY_MS = 60_000;
/** Open budget of the renewal tests; a claim is renewed every third of it. */
const RENEW_BUDGET_MS = 3000;
const RENEW_MS = Math.floor(RENEW_BUDGET_MS / 3);
/** A claim's lifetime under {@link RENEW_BUDGET_MS}. */
const RENEW_CLAIM_LIFETIME_MS = RENEW_BUDGET_MS + GATE_WAIT_MS + SERVICE_CALL_TIMEOUT_MS;
const PLAN: TransitionPlan = {
  from: 'v0001',
  to: 'v0002',
  setT: ['people.person'],
  toTarget: ['people.person'],
  toLegacy: [],
  heldLegacy: [],
  entriesChanged: [
    {
      route: 'admin:cusers.update{type=2,action=add}',
      from: 'legacy',
      to: 'target',
      entry: { route: 'admin:cusers.update{type=2,action=add}', owningService: 'people', tableVersion: 'v0002', state: 'target', kind: 'write', units: ['people.person'], disposition: 'carry' },
    },
  ],
  legacyWriteEntries: ['page:doaction=updateprofile'],
  frozenRoutes: ['admin:cusers.update{type=2,action=add}'],
  owners: ['people'],
  siteMonitorEntryMoves: false,
  siteMonitorUnits: [],
  contentToTarget: false,
  exportJobsWriteT: false,
  returnsToLegacy: false,
};

type Windows = MigrationContext['config']['windows'];
type CapturingLogger = Logger & { calls: { level: string; args: unknown[] }[] };

/** Logger recording every call's arguments as passed. */
function capturingLogger(): CapturingLogger {
  const calls: { level: string; args: unknown[] }[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push({ level, args });
    };
  const logger = {
    level: 'trace',
    calls,
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    child: () => logger,
    isLevelEnabled: () => true,
    flush: (cb?: (err?: Error) => void) => cb?.(),
  };
  return logger as unknown as CapturingLogger;
}

/** Messages `logger` logged at `level`. */
function messages(logger: CapturingLogger, level: string): unknown[] {
  return logger.calls.filter((call) => call.level === level).map((call) => call.args.find((arg) => typeof arg === 'string'));
}

/** Clock that stands still until `advance` moves it. */
function manualClock(start = Date.now()): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await condition()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** `fn`'s rejection and the real milliseconds it took to settle; `undefined` when it resolved. */
async function timed(fn: () => Promise<unknown>): Promise<{ error: unknown; elapsedMs: number }> {
  const startedAt = Date.now();
  const error = await fn().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return { error, elapsedMs: Date.now() - startedAt };
}

const pgUp = await pgAvailable();

describe.skipIf(!pgUp)('window claim deadlines against PostgreSQL', () => {
  let schema: ThrowawaySchema;
  let db: TenantDb;
  let lockPool: Pool;
  let reportsDir: string;
  let owners: OwnerDoubles;
  let gateway: GatewayDouble;
  let services: (WindowService | TransitionService)[];
  let unlocks: (() => Promise<void>)[];
  let apps: FastifyInstance[];

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'migration', migrationsDir: MIGRATIONS_DIR });
    db = schema.app;
    lockPool = schema.connect('app', { max: 2 });
    reportsDir = mkdtempSync(path.join(os.tmpdir(), 'windows-claim-deadline-'));
  });

  afterAll(async () => {
    await schema?.drop();
    if (reportsDir !== undefined) rmSync(reportsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    m.importWindow.mockReset();
    m.importWindow.mockResolvedValue(NO_IMPORT);
    owners = createOwnerDoubles(CATALOG, { owners: ['finance'], gates: { [FINANCE]: { state: 'open' } } });
    gateway = createGatewayDouble({ active: TABLE_VERSION });
    services = [];
    unlocks = [];
    apps = [];
    await db.withMetadata(async (tx) => {
      await tx.query(`DELETE FROM ${tx.schema}.write_window`);
      await tx.query(`DELETE FROM ${tx.schema}.unit_lease`);
      await tx.query(`DELETE FROM ${tx.schema}.transition`);
    });
    m.planTransition.mockReset();
    m.planTransition.mockImplementation((_ctx: unknown, to: string) => Promise.resolve({ ...PLAN, to }));
    m.runTransitionStep.mockReset();
  });

  afterEach(async () => {
    await Promise.all(unlocks.map((unlock) => unlock()));
    await Promise.allSettled(apps.map((app) => app.opt2.shutdown()));
    await Promise.allSettled(services.map((service) => service.stop()));
  });

  /** One migration instance over the shared owners and gateway. */
  function windowService(opts: { windows?: Partial<Windows>; db?: TenantDb; clock?: Clock } = {}): { service: WindowService; logger: CapturingLogger } {
    const logger = capturingLogger();
    const ctx = {
      env: { OPT2_REPORTS_DIR: reportsDir },
      config: { ...CONFIG, windows: { ...CONFIG.windows, ...opts.windows } },
      clock: opts.clock ?? systemClock,
      logger,
      db: opts.db ?? db,
      legacy: { live: () => Promise.reject(new Error('no legacy database in this suite')) },
      catalog: CATALOG,
      owners: owners.client,
      gateway,
    } as unknown as MigrationContext;
    const service = createWindowService(ctx, { projector: { awaitProjection: () => Promise.resolve({ positions: new Map(), waitedMs: 0 }) } });
    services.push(service);
    return { service, logger };
  }

  /** The window routes over `service` in a migration service app answering through the platform error handler. */
  async function windowRoutes(service: WindowService): Promise<FastifyInstance> {
    const app = await createService({
      name: 'migration',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8102',
        OPT2_SERVICE_NAME: 'migration',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('migration'),
      logger: createLogger({ service: 'migration', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    apps.push(app);
    registerWindowRoutes(app, { windows: service });
    await app.ready();
    return app;
  }

  /** One transition service instance over `tdb`, renewing its claim every {@link RENEW_MS}; `windows` overrides other window settings. */
  function transitionService(tdb: TenantDb, opts: { clock?: Clock; logger?: CapturingLogger; windows?: Partial<Windows> } = {}): TransitionService {
    const ctx = {
      env: { OPT2_REPORTS_DIR: reportsDir },
      config: { ...CONFIG, windows: { ...CONFIG.windows, openBudgetMs: RENEW_BUDGET_MS, ...opts.windows } },
      clock: opts.clock ?? systemClock,
      logger: opts.logger ?? capturingLogger(),
      db: tdb,
      legacy: { live: () => Promise.resolve({}) },
      gateway: { status: () => Promise.resolve({ tableVersion: 'v0001', epoch: 1 }) },
    } as unknown as MigrationContext;
    const service = createTransitionService(ctx, {
      projector: { awaitProjection: () => Promise.resolve({ positions: new Map(), waitedMs: 0 }) },
      windows: { get: () => Promise.reject(new Error('no windows in this suite')) },
      scheduler: {} as never,
      startupGuard: {
        ensureEmpty: () => Promise.resolve({ initialCount: 0, reloaded: false, finalCount: 0 }),
        recover: () => Promise.resolve({ initialCount: 0, reloaded: true, finalCount: 0 }),
      },
    });
    services.push(service);
    return service;
  }

  /** The suite's pool, counting claim extensions of `idColumn`'s rows once `start` is called and holding the first counted until `release`. */
  function stalledRenewals(idColumn: 'window_id' | 'transition_id') {
    const renewal = `SET claim_expires_at = GREATEST(claim_expires_at, $3) WHERE ${idColumn} = $1`;
    let counting = false;
    let count = 0;
    const stalled = deferred();
    const released = deferred();
    const hooked: TenantDb = {
      schema: db.schema,
      withTenant: (tenantId, fn, options) => db.withTenant(tenantId, fn, options),
      withMetadata: (fn, options) =>
        db.withMetadata((tx) => {
          const query = async (text: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => {
            if (counting && (typeof text === 'string' ? text : text.text).includes(renewal)) {
              count += 1;
              if (count === 1) {
                stalled.resolve();
                await released.promise;
              }
            }
            return tx.query(text, values);
          };
          return fn({ ...tx, query } as MetadataTx);
        }, options),
      end: () => db.end(),
    };
    return {
      db: hooked,
      start: () => {
        counting = true;
      },
      stalled: stalled.promise,
      release: released.resolve,
      count: () => count,
    };
  }

  /** A TenantDb over a pool of one connection of its own. */
  const singleConnectionDb = (): { pool: Pool; db: TenantDb } => {
    const pool = schema.connect('app', { max: 1 });
    return { pool, db: tenantDbFromPool(pool, { schema: schema.schema }) };
  };

  const openRequest = () => ({ routeKey: ROUTE_KEY, units: [FINANCE], scope: { table: true as const }, requestId: cfUuid() });

  /** An open window whose claim its opener has released; a frozen clock keeps host load from spending the open's budget. */
  async function openWindow(): Promise<string> {
    const { service } = windowService({ clock: manualClock() });
    const { windowId } = await service.open(openRequest());
    await service.stop();
    return windowId;
  }

  /**
   * Holds the window's, or with `table` the transition's, row locked FOR UPDATE from another session until `unlock`, at the
   * latest after {@link SAFETY_MS}; `waiters` counts the backends waiting on that session's lock.
   */
  async function lockRow(id: string, table: 'write_window' | 'transition' = 'write_window'): Promise<{ unlock(): Promise<void>; held(): boolean; waiters(): Promise<number> }> {
    const client = await lockPool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await client.query(`SELECT 1 FROM ${schema.schema}.${table} WHERE ${table === 'transition' ? 'transition_id' : 'window_id'} = $1 FOR UPDATE`, [id]);
    let released: Promise<void> | undefined;
    const unlock = (): Promise<void> =>
      (released ??= client.query('ROLLBACK').then(
        () => client.release(),
        (error: Error) => client.release(error),
      ));
    setTimeout(() => void unlock(), SAFETY_MS).unref();
    unlocks.push(unlock);
    const waiters = async (): Promise<number> => {
      const result = await lockPool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))`,
        [rows[0]?.pid],
      );
      return result.rows[0]?.waiting ?? 0;
    };
    return { unlock, held: () => released === undefined, waiters };
  }

  /** Kind of a window-row write by its SQL: the record's write, a claim extension or the release; other SQL as is. */
  function statementKind(sql: string): string {
    if (sql.includes('SET state = $2')) return 'write';
    if (sql.includes('SET claim_expires_at = GREATEST(claim_expires_at, $3)')) return 'extension';
    if (sql.includes('SET claimed_by = NULL')) return 'release';
    return sql;
  }

  /**
   * `base` recording each lock bound the window service sets, in ms, and with `cutToMs` setting that instead, so the
   * server-side bound ends a lock wait before the signal racing it aborts; `endedKinds` lists, in order, the
   * {@link statementKind} of each statement the bound ended. `before` runs ahead of every statement.
   */
  function lockBoundDb(base: TenantDb, opts: { cutToMs?: number; before?: (sql: string, values?: unknown[]) => Promise<void> } = {}) {
    const bounds: number[] = [];
    const endedKinds: string[] = [];
    const hooked: TenantDb = {
      schema: base.schema,
      withTenant: (tenantId, fn, options) => base.withTenant(tenantId, fn, options),
      withMetadata: (fn, options) =>
        base.withMetadata((tx) => {
          const query = async (text: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => {
            const sql = typeof text === 'string' ? text : text.text;
            await opts.before?.(sql, values);
            const bound = sql.includes("set_config('lock_timeout'");
            if (bound) bounds.push(Number.parseInt(String(values?.[0]), 10));
            try {
              return await tx.query(text, bound && opts.cutToMs !== undefined ? [`${String(opts.cutToMs)}ms`] : values);
            } catch (error) {
              if ((error as { code?: unknown }).code === '55P03') endedKinds.push(statementKind(sql));
              throw error;
            }
          };
          return fn({ ...tx, query } as MetadataTx);
        }, options),
      end: () => base.end(),
    };
    return { db: hooked, bounds, endedKinds, ended: () => endedKinds.length };
  }

  /** Types of the errors `logger` logged, except with any of `exceptMessages`. */
  function loggedErrorTypes(logger: CapturingLogger, ...exceptMessages: string[]): unknown[] {
    return logger.calls
      .filter((call) => !exceptMessages.some((message) => call.args.includes(message)))
      .flatMap((call) => call.args.flatMap((arg) => (typeof arg === 'object' && arg !== null && 'error' in arg ? [(arg.error as { type?: unknown }).type] : [])));
  }

  async function rowOf(windowId: string): Promise<{ state: string; phase: string | null; claimed_by: string | null }> {
    const { rows } = await db.withMetadata((tx) =>
      tx.query<{ state: string; phase: string | null; claimed_by: string | null }>(
        `SELECT state, phase, claimed_by FROM ${tx.schema}.write_window WHERE window_id = $1`,
        [windowId],
      ),
    );
    if (rows[0] === undefined) throw new Error(`no row for window ${windowId}`);
    return rows[0];
  }

  async function claimOf(id: string): Promise<{ state: string; claimed_by: string | null }> {
    const { rows } = await db.withMetadata((tx) =>
      tx.query<{ state: string; claimed_by: string | null }>(`SELECT state, claimed_by FROM ${tx.schema}.transition WHERE transition_id = $1`, [id]),
    );
    if (rows[0] === undefined) throw new Error(`no row for transition ${id}`);
    return rows[0];
  }

  /** An opening row a dead instance left without closing anything, its claim expired. */
  async function seedOpening(): Promise<string> {
    const windowId = cfUuid();
    const at = new Date();
    await db.withMetadata((tx) =>
      tx.query(
        `INSERT INTO ${tx.schema}.write_window (window_id, route_key, units, scope, kind, state, phases, opened_at, updated_at, claimed_by, claim_expires_at)
         VALUES ($1, $2, $3::text[], $4::jsonb, 'request', 'opening', $5::jsonb, $6, $6, 'dead-instance', $7)`,
        [windowId, ROUTE_KEY, [FINANCE], JSON.stringify({ table: true }), JSON.stringify([{ phase: 'opened', at: at.toISOString() }]), at, new Date(at.getTime() - 1000)],
      ),
    );
    return windowId;
  }

  const claimActions = [
    ['complete', (service: WindowService, windowId: string) => service.complete(windowId, { forwarded: true, legacyStatus: 200 })],
    ['resolve', (service: WindowService, windowId: string) => service.resolve(windowId)],
  ] as const;

  it.each(claimActions)('refuses to %s once its claim wait meets a row another session keeps locked, and frees its connection and backend', async (action, run) => {
    const windowId = await openWindow();
    // One pooled connection: the cut-off claim must give it back for the reads that follow.
    const single = singleConnectionDb();
    const bound = lockBoundDb(single.db);
    const { service } = windowService({ windows: { openBudgetMs: BUDGET_MS }, db: bound.db });
    const reader = windowService({ db: single.db, clock: manualClock() }).service;
    const lock = await lockRow(windowId);

    const answer = timed(() => run(service, windowId));
    await waitFor(async () => (await lock.waiters()) === 1, 'the claim to wait on the locked row');
    const { error, elapsedMs } = await answer;
    const answeredWhileLocked = lock.held();
    // The server-side bound, set from what the claim's signal had left, ends the backend's wait just after the abort.
    await waitFor(async () => (await lock.waiters()) === 0, 'no backend to wait on the locked row');
    const freedWhileLocked = lock.held();
    const view = await reader.get(windowId);
    const readWhileLocked = lock.held();
    await lock.unlock();

    expect(error).toBeInstanceOf(WindowStateError);
    expect(error).toMatchObject({ windowId, state: 'open', action, statusCode: 409 });
    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 25);
    expect(elapsedMs).toBeLessThan(2 * BUDGET_MS);
    // The claim's lock bound is what its signal had left of the budget.
    expect(bound.bounds[0]).toBeGreaterThan(BUDGET_MS / 2);
    expect(bound.bounds[0]).toBeLessThanOrEqual(BUDGET_MS);
    expect(answeredWhileLocked).toBe(true);
    expect(freedWhileLocked).toBe(true);
    expect(view).toMatchObject({ windowId, state: 'open' });
    expect(readWhileLocked).toBe(true);
    expect(m.importWindow).not.toHaveBeenCalled();
    expect(await rowOf(windowId)).toMatchObject({ state: 'open', claimed_by: null });
  });

  it.each(claimActions)('refuses to %s as at its deadline when the server-side lock bound ends its claim wait first', async (action, run) => {
    const windowId = await openWindow();
    const bound = lockBoundDb(db, { cutToMs: CUT_LOCK_MS });
    const { service } = windowService({ windows: { openBudgetMs: BUDGET_MS }, db: bound.db });
    const lock = await lockRow(windowId);

    const { error, elapsedMs } = await timed(() => run(service, windowId));
    const waitingAfter = await lock.waiters();
    const answeredWhileLocked = lock.held();
    await lock.unlock();

    expect(error).toBeInstanceOf(WindowStateError);
    expect(error).toMatchObject({ windowId, state: 'open', action, statusCode: 409 });
    expect(bound.ended()).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(CUT_LOCK_MS - 25);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(waitingAfter).toBe(0);
    expect(answeredWhileLocked).toBe(true);
    expect(await rowOf(windowId)).toMatchObject({ state: 'open', claimed_by: null });
  });

  it('gives up a recovery claim the deadline cuts off at a locked row, which the next pass recovers', async () => {
    const windowId = await seedOpening();
    const { service, logger } = windowService({ windows: { openBudgetMs: BUDGET_MS } });
    const lock = await lockRow(windowId);

    const { error, elapsedMs } = await timed(() => service.runRecoveryPass());
    const answeredWhileLocked = lock.held();
    const row = await rowOf(windowId);
    await lock.unlock();

    expect(error).toBeUndefined();
    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 25);
    expect(answeredWhileLocked).toBe(true);
    expect(row).toMatchObject({ state: 'opening', claimed_by: 'dead-instance' });
    expect(messages(logger, 'warn')).toContain(`Recovery of window ${windowId} failed; retried next pass`);
    await windowService({ clock: manualClock() }).service.runRecoveryPass();
    expect(await rowOf(windowId)).toMatchObject({ state: 'failed', claimed_by: null });
  });

  it('fails a read whose pooled connection does not come within one open budget', async () => {
    const windowId = await openWindow();
    const single = singleConnectionDb();
    const { service } = windowService({ windows: { openBudgetMs: BUDGET_MS }, db: single.db });
    const held = await single.pool.connect();

    const { error, elapsedMs } = await timed(() => service.get(windowId));
    held.release();

    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 25);
    await expect(windowService({ db: single.db }).service.get(windowId)).resolves.toMatchObject({ windowId, state: 'open' });
  });

  it.each(claimActions)('refuses to %s as unavailable within one budget, over the service and its route, while the only pooled connection stays held', async (action, run) => {
    const windowId = await openWindow();
    const single = singleConnectionDb();
    const { service } = windowService({ windows: { openBudgetMs: BUDGET_MS }, db: single.db });
    const app = await windowRoutes(service);
    const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'operator', audience: 'migration' })}` };
    const held = await single.pool.connect();

    let direct: Awaited<ReturnType<typeof timed>>;
    let routed: { status: number; body: unknown; elapsedMs: number };
    let heldAtAnswers: boolean;
    try {
      direct = await timed(() => run(service, windowId));
      const startedAt = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: `/internal/v1/windows/${windowId}:${action}`,
        ...(action === 'complete'
          ? { headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ forwarded: true, legacyStatus: 200 }) }
          : { headers }),
      });
      routed = { status: res.statusCode, body: res.json(), elapsedMs: Date.now() - startedAt };
      heldAtAnswers = single.pool.totalCount === 1 && single.pool.idleCount === 0;
    } finally {
      held.release();
    }
    // pg-pool keeps an abandoned checkout queued until a connection frees, then gets the connection straight back.
    await waitFor(() => Promise.resolve(single.pool.waitingCount === 0 && single.pool.idleCount === single.pool.totalCount), 'the abandoned checkouts to drain');

    expect(direct.error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(direct.error).toMatchObject({
      message: `Write window ${windowId} could not be read within the open budget of ${String(BUDGET_MS)} ms; cannot ${action}`,
      surface: 'auto',
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    });
    expect(direct.elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 25);
    expect(direct.elapsedMs).toBeLessThan(1.5 * BUDGET_MS);
    // The contract declares no 503 for these operations, as for every database outage, so the answer is checked without it.
    expect(routed.status).toBe(503);
    expect(routed.body).toEqual({ apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } });
    expect(routed.elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 25);
    expect(routed.elapsedMs).toBeLessThan(1.5 * BUDGET_MS);
    expect(heldAtAnswers).toBe(true);
    expect(m.importWindow).not.toHaveBeenCalled();
    expect(await rowOf(windowId)).toMatchObject({ state: 'open', claimed_by: null });
  });

  it.each(claimActions)('refuses to %s an id that names no window as not found', async (_action, run) => {
    const { service } = windowService({ windows: { openBudgetMs: BUDGET_MS } });
    const unknown = cfUuid();

    const { error, elapsedMs } = await timed(() => run(service, unknown));

    expect(error).toBeInstanceOf(WindowNotFoundError);
    expect(error).toMatchObject({ windowId: unknown, statusCode: 404 });
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it.each([
    { endedBy: 'its signal', cutToMs: undefined, validityLeftMs: VALIDITY_LEFT_MS, minEnded: 0 },
    // Validity well beyond the cut, so the bound ends each wait before its signal aborts.
    { endedBy: 'the server-side lock bound', cutToMs: CUT_LOCK_MS, validityLeftMs: BUDGET_MS, minEnded: 3 },
  ])('gives up the writes and the release of a claim that lapses while another session keeps its row locked, ended by $endedBy', async ({ cutToMs, validityLeftMs, minEnded }) => {
    // A frozen clock under a budget no test outlasts: no renewal comes due, and the lapse is the advance below.
    const clock = manualClock();
    const bound = lockBoundDb(db, { cutToMs });
    const { service, logger } = windowService({ windows: { openBudgetMs: LONG_BUDGET_MS }, clock, db: bound.db });
    const { windowId } = await service.open(openRequest());
    let lock: Awaited<ReturnType<typeof lockRow>> | undefined;
    m.importWindow.mockImplementationOnce(async () => {
      lock = await lockRow(windowId);
      clock.advance(LONG_CLAIM_LIFETIME_MS - validityLeftMs);
      return NO_IMPORT;
    });

    let answer: unknown;
    const { error } = await timed(async () => {
      answer = await service.complete(windowId, { forwarded: true, legacyStatus: 200 });
    });
    const answeredWhileLocked = lock?.held();
    const row = await rowOf(windowId);
    await waitFor(async () => (await lock?.waiters()) === 0, 'no backend to wait on the locked row');
    const freedWhileLocked = lock?.held();

    const releaseFailed = `Releasing the claim on window ${windowId} failed; it lapses at its expiry`;
    expect(error).toBeUndefined();
    expect(answer).toEqual({ state: 'import-pending' });
    expect(answeredWhileLocked).toBe(true);
    // Nothing the holder wrote after the lock committed, and its claim is left to lapse.
    expect(row).toMatchObject({ state: 'open', phase: 'importing' });
    expect(row.claimed_by).not.toBeNull();
    expect(messages(logger, 'warn')).toContain(releaseFailed);
    // keepClaim and persist refuse as on a lapsed claim, whichever ended their waits.
    expect(new Set(loggedErrorTypes(logger, releaseFailed))).toEqual(new Set(['WindowStateError']));
    expect(bound.ended()).toBeGreaterThanOrEqual(minEnded);
    expect(bound.bounds.at(-1)).toBeLessThanOrEqual(validityLeftMs);
    expect(freedWhileLocked).toBe(true);
  });

  it('refuses an open as over budget when the server-side lock bound ends a write of its row, and gives up its claim', async () => {
    let locked: { windowId: string; lock: Awaited<ReturnType<typeof lockRow>> } | undefined;
    const bound = lockBoundDb(db, {
      cutToMs: CUT_LOCK_MS,
      // The first write after the insert meets the row locked.
      before: async (sql, values) => {
        if (locked === undefined && sql.includes('SET state = $2')) {
          const windowId = String(values?.[0]);
          locked = { windowId, lock: await lockRow(windowId) };
        }
      },
    });
    const { service, logger } = windowService({ windows: { openBudgetMs: BUDGET_MS }, db: bound.db });

    const { error, elapsedMs } = await timed(() => service.open(openRequest()));
    if (locked === undefined) throw new Error('the open wrote no row after its insert');
    const { windowId, lock } = locked;
    const answeredWhileLocked = lock.held();
    const releaseFailed = `Releasing the claim on window ${windowId} failed; it lapses at its expiry`;
    // A renewal due while the row stays locked, as under host load, ends at the bound too.
    const renewalFailed = `Renewing the claim on window ${windowId} failed`;
    await waitFor(() => Promise.resolve(messages(logger, 'warn').includes(releaseFailed)), 'the deferred release');
    const waitingAfter = await lock.waiters();
    const row = await rowOf(windowId);
    const renewalsEnded = messages(logger, 'warn').filter((message) => message === renewalFailed).length;

    expect(error).toBeInstanceOf(WindowRefusedError);
    expect(error).toMatchObject({ windowId, reason: 'budget-exceeded' });
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(answeredWhileLocked).toBe(true);
    // The write, the give-back's claim extension and the release each ended at the bound; any further extension was a renewal's.
    expect(bound.endedKinds.filter((kind) => kind !== 'extension')).toEqual(['write', 'release']);
    expect(bound.endedKinds.filter((kind) => kind === 'extension')).toHaveLength(1 + renewalsEnded);
    expect(messages(logger, 'error')).toContain(`Recording the refusal of window ${windowId} failed`);
    expect(new Set(loggedErrorTypes(logger, releaseFailed, renewalFailed))).toEqual(new Set(['WindowStateError', 'BudgetExceededError']));
    expect(waitingAfter).toBe(0);
    expect(lock.held()).toBe(true);
    expect(row).toMatchObject({ state: 'opening' });
  });

  it('keeps one window claim renewal in flight while it stalls, and tears down after only that one', async () => {
    const windowId = await openWindow();
    const stall = stalledRenewals('window_id');
    const { service } = windowService({ windows: { openBudgetMs: RENEW_BUDGET_MS }, db: stall.db, clock: manualClock() });
    const proceed = deferred();
    m.importWindow.mockImplementationOnce(async () => {
      stall.start();
      await proceed.promise;
      return NO_IMPORT;
    });

    const completing = service.complete(windowId, { forwarded: true, legacyStatus: 200 });
    await stall.stalled;
    await delay(RENEW_MS * 4);
    proceed.resolve();
    await waitFor(async () => (await rowOf(windowId)).state === 'closed', 'the window to close');
    const settledBeforeRelease = await Promise.race([completing.then(() => true), delay(RENEW_MS * 2).then(() => false)]);
    const claimedBeforeRelease = (await rowOf(windowId)).claimed_by;
    stall.release();

    await expect(completing).resolves.toEqual({ state: 'closed' });
    expect(settledBeforeRelease).toBe(false);
    expect(claimedBeforeRelease).not.toBeNull();
    // Besides the stalled renewal, only the finish's own claim extension ran.
    expect(stall.count()).toBe(2);
    expect(await rowOf(windowId)).toMatchObject({ state: 'closed', claimed_by: null });
  });

  it('keeps one transition claim renewal in flight while it stalls, and gives the claim back after only that one', async () => {
    const stall = stalledRenewals('transition_id');
    const proceed = deferred();
    m.runTransitionStep.mockImplementation(async (_deps: StepDeps, record: TransitionRecord, step: TransitionStepNumber) => {
      if (step === 1) {
        stall.start();
        await proceed.promise;
      }
      return { plan: step === 1 ? { ...PLAN, to: record.to } : record.plan, progress: { ...record.progress } };
    });
    const transitions = transitionService(stall.db);

    const { transitionId } = await transitions.start({ to: 'v0002' });
    await stall.stalled;
    await delay(RENEW_MS * 4);
    proceed.resolve();
    await waitFor(async () => (await claimOf(transitionId)).state === 'completed', 'the transition to complete');
    await delay(RENEW_MS * 2);
    const claimedBeforeRelease = (await claimOf(transitionId)).claimed_by;
    stall.release();
    await transitions.stop();

    expect(claimedBeforeRelease).not.toBeNull();
    expect(stall.count()).toBe(1);
    expect(await claimOf(transitionId)).toMatchObject({ state: 'completed', claimed_by: null });
  });

  it.each([
    { endedBy: 'its signal', cutToMs: undefined, validityLeftMs: VALIDITY_LEFT_MS, minBoundMs: 1, minEnded: 0 },
    // Validity well beyond the cut, so the bound ends the wait before the signal aborts.
    { endedBy: 'the server-side lock bound', cutToMs: CUT_LOCK_MS, validityLeftMs: BUDGET_MS, minBoundMs: BUDGET_MS / 2, minEnded: 1 },
  ])(
    'keeps driving a transition whose claim renewal meets its row locked by another session, ended by $endedBy, and frees the backend',
    async ({ cutToMs, validityLeftMs, minBoundMs, minEnded }) => {
      // A frozen clock: the lapse is the advance below, and only the renewal timer runs in real time.
      const clock = manualClock();
      const logger = capturingLogger();
      const bound = lockBoundDb(db, { cutToMs });
      let boundsAtLapse = -1;
      let freedWhileLocked: boolean | undefined;
      m.runTransitionStep.mockImplementation(async (_deps: StepDeps, record: TransitionRecord, step: TransitionStepNumber) => {
        if (step === 1) {
          const lock = await lockRow(record.transitionId, 'transition');
          clock.advance(RENEW_CLAIM_LIFETIME_MS - validityLeftMs);
          boundsAtLapse = bound.bounds.length;
          const renewalFailed = `Renewing the claim on transition ${record.transitionId} failed`;
          await waitFor(() => Promise.resolve(messages(logger, 'warn').includes(renewalFailed)), 'the renewal to fail');
          await waitFor(async () => (await lock.waiters()) === 0, 'no backend to wait on the locked row');
          freedWhileLocked = lock.held();
          await lock.unlock();
        }
        return { plan: step === 1 ? { ...PLAN, to: record.to } : record.plan, progress: { ...record.progress } };
      });
      const transitions = transitionService(bound.db, { clock, logger, windows: { importRetryMs: LONG_BUDGET_MS } });

      const { transitionId } = await transitions.start({ to: 'v0002' });
      await waitFor(async () => (await claimOf(transitionId)).state === 'completed', 'the transition to complete');
      await transitions.stop();

      // The renewal's lock bound is what its fence had left, not a claim lifetime.
      expect(bound.bounds[boundsAtLapse]).toBeGreaterThanOrEqual(minBoundMs);
      expect(bound.bounds[boundsAtLapse]).toBeLessThanOrEqual(validityLeftMs);
      expect(bound.endedKinds.filter((kind) => kind === 'extension').length).toBeGreaterThanOrEqual(minEnded);
      expect(freedWhileLocked).toBe(true);
      // A renewal cut off at the client or by the bound leaves the fence untaken, so the drive goes on.
      expect(messages(logger, 'warn')).not.toContain(`Transition ${transitionId} is no longer claimed by this instance; its next effect is refused`);
      expect(m.runTransitionStep.mock.calls.map((call) => call[2])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await claimOf(transitionId)).toMatchObject({ state: 'completed', claimed_by: null });
    },
  );

  it('gives up the release of a lapsing transition claim when the server-side lock bound ends its wait on a row another session keeps locked', async () => {
    const clock = manualClock();
    const logger = capturingLogger();
    const bound = lockBoundDb(db, { cutToMs: CUT_LOCK_MS });
    let lock: Awaited<ReturnType<typeof lockRow>> | undefined;
    m.runTransitionStep.mockImplementation(async (deps: StepDeps, record: TransitionRecord) => {
      lock = await lockRow(record.transitionId, 'transition');
      // Less validity left than one more call needs, so the next port call is refused and the drive ends.
      clock.advance(RENEW_CLAIM_LIFETIME_MS - BUDGET_MS);
      await deps.ctx.gateway.status();
      return { plan: record.plan, progress: { ...record.progress } };
    });
    const transitions = transitionService(bound.db, { clock, logger, windows: { importRetryMs: LONG_BUDGET_MS } });

    const { transitionId } = await transitions.start({ to: 'v0002' });
    const releaseFailed = `Releasing the claim on transition ${transitionId} failed; it lapses at its expiry`;
    await waitFor(() => Promise.resolve(messages(logger, 'warn').includes(releaseFailed)), 'the release to fail');
    if (lock === undefined) throw new Error('the drive locked no row');
    const waitingAfter = await lock.waiters();
    const answeredWhileLocked = lock.held();
    const row = await claimOf(transitionId);
    await lock.unlock();
    await transitions.stop();

    expect(messages(logger, 'warn')).toContain(`Transition ${transitionId} is no longer claimed by this instance, which stops driving it`);
    // The release ended at its lock bound, which is what the lapsing fence had left; any other statement it ended was a renewal.
    expect(bound.endedKinds.filter((kind) => kind !== 'extension')).toEqual(['release']);
    expect(bound.bounds.at(-1)).toBeGreaterThan(BUDGET_MS / 2);
    expect(bound.bounds.at(-1)).toBeLessThanOrEqual(BUDGET_MS);
    expect(answeredWhileLocked).toBe(true);
    expect(waitingAfter).toBe(0);
    // The claim is left to lapse at its expiry.
    expect(row.claimed_by).not.toBeNull();
  });

  it('gives up the release of a lapsing transition claim at its deadline while the only pooled connection stays held', async () => {
    const clock = manualClock();
    const logger = capturingLogger();
    const single = singleConnectionDb();
    let releaseHeld: (() => void) | undefined;
    m.runTransitionStep.mockImplementation(async (deps: StepDeps, record: TransitionRecord) => {
      const held = await single.pool.connect();
      releaseHeld = () => held.release();
      clock.advance(RENEW_CLAIM_LIFETIME_MS - VALIDITY_LEFT_MS);
      await deps.ctx.gateway.status();
      return { plan: record.plan, progress: { ...record.progress } };
    });
    const transitions = transitionService(single.db, { clock, logger, windows: { importRetryMs: LONG_BUDGET_MS } });

    const { transitionId } = await transitions.start({ to: 'v0002' });
    const releaseFailed = `Releasing the claim on transition ${transitionId} failed; it lapses at its expiry`;
    let heldAtRelease: boolean;
    try {
      await waitFor(() => Promise.resolve(messages(logger, 'warn').includes(releaseFailed)), 'the release to fail');
      heldAtRelease = single.pool.totalCount === 1 && single.pool.idleCount === 0;
    } finally {
      releaseHeld?.();
    }
    await waitFor(() => Promise.resolve(single.pool.waitingCount === 0 && single.pool.idleCount === single.pool.totalCount), 'the abandoned checkouts to drain');
    const row = await claimOf(transitionId);
    await transitions.stop();

    expect(heldAtRelease).toBe(true);
    // No statement of the release had begun, so only its deadline signal could end the wait.
    expect(logger.calls.find((call) => call.args.includes(releaseFailed))?.args[0]).toMatchObject({ error: { type: 'TimeoutError' } });
    expect(row.claimed_by).not.toBeNull();
  });
});
