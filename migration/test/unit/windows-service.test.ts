// Unit tests for the window service over a throwaway `migration` schema: uncertain closes, the open deadline, cross-instance claims and log safety.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { serializeError, type Logger } from '@opt2/platform/logging';
import { GATE_WAIT_MS, MIGRATION_PATH_PREFIX, type ApplyRequest, type GatePhase, type GateRequest, type UnitGate } from '@opt2/platform/migration-kit';
import { SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError, systemClock, type Clock } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import type { QueryConfig, QueryResult } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { GateConflict, OwnerCallError, type DataOwner, type OwnersClient } from '../../src/owners/index.js';
import { loadUnitCatalog } from '../../src/owners/units.js';
import { ProjectionTimeoutError, type Projector } from '../../src/reverse/index.js';
import { WindowImportError, type ImportResult } from '../../src/windows/import.js';
import { acquireLeases, leasesOf } from '../../src/windows/leases.js';
import { WindowRefusedError, WindowStateError, createWindowService, type WindowService, type WindowServiceOptions } from '../../src/windows/service.js';
import { createGatewayDouble, type GatewayDouble } from '../helpers/gateway-double.js';

const imports = vi.hoisted(() => ({ importWindow: vi.fn() }));
vi.mock('../../src/windows/import.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/windows/import.js')>()),
  importWindow: imports.importWindow,
}));

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const GATE_PATH = `${MIGRATION_PATH_PREFIX}/gate`;
// v0002 makes both units target-authoritative, at two owners.
const TABLE_VERSION = 'v0002';
const FINANCE = 'finance.record';
const SURVEYS = 'surveys.survey';
const ROUTE_KEY = 'admin:cusers.update';
const NO_IMPORT: ImportResult = { rowsImported: 0, perOwner: {}, objectsTransferred: 0, objectsRemoved: [], touchedContent: false, writePositions: new Map() };
// The longest single call of a claimed operation: a claim is fenced once it outlasts no more than this.
const MAX_CALL_MS = GATE_WAIT_MS + SERVICE_CALL_TIMEOUT_MS;
// Values standing for rejected PII, a credential and an amount; the credential is assembled from parts.
const SENTINEL_EMAIL = `${['qa', 'sentinel'].join('.')}@example.test`;
const SENTINEL_PASSWORD = ['Pw', 'Sentinel', String(6 * 7), '!'].join('-');
const SENTINEL_AMOUNT = (987654.32).toFixed(2);
const SENTINELS = [SENTINEL_EMAIL, SENTINEL_PASSWORD, SENTINEL_AMOUNT];

type Windows = MigrationContext['config']['windows'];
type GateOp = GateRequest['op'];

interface GateCall {
  owner: DataOwner;
  req: GateRequest;
  options: { timeoutMs?: number } | undefined;
}

/** One injected answer: applied then lost, failed before applying, or slow and bounded by the call's timeout. */
type GateFault = { kind: 'lost-reply' } | { kind: 'fail'; error?: Error } | { kind: 'slow'; ms: number };

interface OwnersDouble {
  owners: OwnersClient;
  calls: GateCall[];
  applied: { owner: DataOwner; req: ApplyRequest }[];
  gate(unit: string): { state: 'open' | 'closed'; holderId: string | null; phase: GatePhase };
  closeAs(holderId: string, units: string[]): void;
  fault(owner: DataOwner, op: GateOp, fault: GateFault): void;
  opens(holderId: string): GateCall[];
}

/** Owners' gate endpoint with the platform's holder compare-and-set semantics and injected faults, and a recording apply. */
function ownersDouble(): OwnersDouble {
  const gates = new Map<string, { state: 'open' | 'closed'; holderId: string | null; phase: GatePhase }>();
  const faults = new Map<string, GateFault[]>();
  const calls: GateCall[] = [];
  const applied: { owner: DataOwner; req: ApplyRequest }[] = [];
  const gateOf = (unit: string): { state: 'open' | 'closed'; holderId: string | null; phase: GatePhase } =>
    gates.get(unit) ?? { state: 'open', holderId: null, phase: 'quiet' };
  const conflict = (owner: DataOwner, units: string[]): GateConflict => new GateConflict(owner, { error: 'gate-conflict', units });

  function apply(owner: DataOwner, req: GateRequest): UnitGate[] {
    const units = req.units ?? [...gates.keys()];
    if (req.op === 'close') {
      const refused = units.filter((unit) => gateOf(unit).state === 'closed' && gateOf(unit).holderId !== req.holderId);
      if (refused.length > 0) throw conflict(owner, refused);
      for (const unit of units) gates.set(unit, { state: 'closed', holderId: req.holderId, phase: req.phase ?? 'quiet' });
    } else if (req.op === 'phase') {
      const refused = units.filter((unit) => gateOf(unit).holderId !== req.holderId);
      if (refused.length > 0) throw conflict(owner, refused);
      for (const unit of units) gates.set(unit, { ...gateOf(unit), phase: req.phase });
    } else if (req.op === 'open') {
      for (const unit of units) if (gateOf(unit).holderId === req.holderId) gates.set(unit, { state: 'open', holderId: null, phase: 'quiet' });
      const refused = units.filter((unit) => gateOf(unit).state !== 'open' || gateOf(unit).holderId !== null);
      if (refused.length > 0) throw conflict(owner, refused);
    }
    return units.map((unit) => ({ unit, ...gateOf(unit) }));
  }

  const owners = {
    async gate(owner: DataOwner, req: GateRequest, options?: { timeoutMs?: number }) {
      calls.push({ owner, req: structuredClone(req), options });
      const fault = faults.get(`${owner}:${req.op}`)?.shift();
      if (fault?.kind === 'fail') throw fault.error ?? new OwnerCallError(owner, 'POST', GATE_PATH, 503, { error: 'unavailable' });
      if (fault?.kind === 'slow') {
        const bound = options?.timeoutMs;
        if (bound !== undefined && bound < fault.ms) {
          await delay(bound);
          throw new ServiceUnavailableError(owner, new Error('call bound passed'));
        }
        await delay(fault.ms);
      }
      const units = apply(owner, req);
      if (fault?.kind === 'lost-reply') throw new ServiceUnavailableError(owner, new Error('reply lost'));
      return { units };
    },
    apply(owner: DataOwner, req: ApplyRequest) {
      applied.push({ owner, req: structuredClone(req) });
      return Promise.resolve({ batchId: req.batchId, duplicate: false, applied: req.rows.length, skipped: 0, writePositions: new Map() });
    },
  } as unknown as OwnersClient;

  return {
    owners,
    calls,
    applied,
    gate: gateOf,
    closeAs(holderId, units) {
      for (const unit of units) gates.set(unit, { state: 'closed', holderId, phase: 'quiet' });
    },
    fault(owner, op, fault) {
      faults.set(`${owner}:${op}`, [...(faults.get(`${owner}:${op}`) ?? []), fault]);
    },
    opens: (holderId) => calls.filter((call) => call.req.op === 'open' && call.req.holderId === holderId),
  };
}

interface LogCall {
  level: string;
  args: unknown[];
}

/** Logger recording every call's arguments as passed. */
function capturingLogger(): Logger & { calls: LogCall[] } {
  const calls: LogCall[] = [];
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
  return logger as unknown as Logger & { calls: LogCall[] };
}

/** Every string reachable from `value`, including an error's message, stack and cause. */
function textsOf(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null || seen.has(value)) return [];
  seen.add(value);
  const own = Object.values(value as Record<string, unknown>);
  const extra = value instanceof Error ? [value.message, value.stack, value.cause] : [];
  return [...own, ...extra].flatMap((item) => textsOf(item, seen));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

const pg = await pgAvailable();

describe.skipIf(!pg)('window service against PostgreSQL', () => {
  let schema: ThrowawaySchema;
  let db: TenantDb;
  let reportsDir: string;

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'migration', migrationsDir: MIGRATIONS_DIR });
    db = schema.app;
    reportsDir = mkdtempSync(path.join(os.tmpdir(), 'windows-service-'));
  });

  afterAll(async () => {
    await schema?.drop();
    if (reportsDir !== undefined) rmSync(reportsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    imports.importWindow.mockReset();
    imports.importWindow.mockResolvedValue(NO_IMPORT);
    await db.withMetadata(async (tx) => {
      await tx.query(`DELETE FROM ${tx.schema}.write_window`);
      await tx.query(`DELETE FROM ${tx.schema}.unit_lease`);
    });
  });

  interface Harness {
    ctx: MigrationContext;
    service: WindowService;
    logger: Logger & { calls: LogCall[] };
  }

  /** A service instance over the shared schema, owners and gateway; each call is one more migration instance. */
  function instance(
    owners: OwnersDouble,
    gateway: GatewayDouble,
    opts: {
      windows?: Partial<Windows>;
      projector?: Pick<Projector, 'awaitProjection'>;
      restart?: WindowServiceOptions['restart'];
      sleep?: WindowServiceOptions['sleep'];
      clock?: Clock;
      db?: TenantDb;
    } = {},
  ): Harness {
    const logger = capturingLogger();
    const ctx = {
      env: { OPT2_REPORTS_DIR: reportsDir },
      config: { ...CONFIG, windows: { ...CONFIG.windows, ...opts.windows } },
      clock: opts.clock ?? systemClock,
      logger,
      db: opts.db ?? db,
      legacy: { live: () => Promise.reject(new Error('no legacy database in this suite')) },
      bridge: {},
      catalog: CATALOG,
      owners: owners.owners,
      gateway,
      client: {},
      clientAs: () => {
        throw new Error('no service clients in this suite');
      },
      close: () => Promise.resolve(),
    } as unknown as MigrationContext;
    const projector = opts.projector ?? { awaitProjection: () => Promise.resolve({ positions: new Map(), waitedMs: 0 }) };
    const { restart, sleep } = opts;
    return {
      ctx,
      logger,
      service: createWindowService(ctx, { projector, ...(restart === undefined ? {} : { restart }), ...(sleep === undefined ? {} : { sleep }) }),
    };
  }

  const gatewayDouble = (): GatewayDouble => createGatewayDouble({ active: TABLE_VERSION });

  /** The suite's pool with `hook` around every statement of its metadata transactions. */
  function hookedDb(hook: (sql: string, run: () => Promise<QueryResult>) => Promise<QueryResult>): TenantDb {
    return {
      schema: db.schema,
      withTenant: (tenantId, fn) => db.withTenant(tenantId, fn),
      withMetadata: (fn, options) =>
        db.withMetadata((tx) => {
          const query = (text: string | QueryConfig, values?: unknown[]): Promise<QueryResult> =>
            hook(typeof text === 'string' ? text : text.text, () => tx.query(text, values));
          return fn({ ...tx, query } as MetadataTx);
        }, options),
      end: () => db.end(),
    };
  }

  const openRequest = (units: string[]) => ({ routeKey: ROUTE_KEY, units, scope: { table: true as const }, requestId: cfUuid() });

  /** A one-row window import batch. */
  const applyBatch = (windowId: string, batchId: string): ApplyRequest => ({
    batchId,
    origin: 'legacy-window',
    legacyTable: 'tfinance',
    columns: [{ name: 'id', type: 's' }],
    holderId: windowId,
    rows: [{ op: 'upsert', row: batchId }],
  });

  interface Row {
    state: string;
    phase: string | null;
    closed_gates: Record<string, string[]>;
    closing_gates: Record<string, string[]>;
    claimed_by: string | null;
    phases: { phase: string }[];
  }

  async function rowOf(windowId: string): Promise<Row> {
    const { rows } = await db.withMetadata((tx) =>
      tx.query<Row>(`SELECT state, phase, closed_gates, closing_gates, claimed_by, phases FROM ${tx.schema}.write_window WHERE window_id = $1`, [windowId]),
    );
    if (rows[0] === undefined) throw new Error(`no row for window ${windowId}`);
    return rows[0];
  }

  async function setClaim(windowId: string, claimedBy: string, expiresInMs: number): Promise<void> {
    await db.withMetadata((tx) =>
      tx.query(`UPDATE ${tx.schema}.write_window SET claimed_by = $2, claim_expires_at = $3 WHERE window_id = $1`, [
        windowId,
        claimedBy,
        new Date(Date.now() + expiresInMs),
      ]),
    );
  }

  /** An opening row left by a dead instance that persisted close intents for `units`, with the units leased, at `clock`'s time. */
  async function seedOpening(units: string[], claimExpiresInMs: number, clock: Clock = systemClock): Promise<string> {
    const windowId = cfUuid();
    const at = clock.now();
    await db.withMetadata((tx) =>
      tx.query(
        `INSERT INTO ${tx.schema}.write_window (window_id, route_key, units, scope, kind, state, closing_gates, phases, opened_at, updated_at, claimed_by, claim_expires_at)
         VALUES ($1, $2, $3::text[], $4::jsonb, 'request', 'opening', $5::jsonb, $6::jsonb, $7, $7, 'dead-instance', $8)`,
        [
          windowId,
          ROUTE_KEY,
          units,
          JSON.stringify({ table: true }),
          JSON.stringify({ finance: units }),
          JSON.stringify([{ phase: 'opened', at: at.toISOString() }]),
          at,
          new Date(at.getTime() + claimExpiresInMs),
        ],
      ),
    );
    await acquireLeases({ db, clock }, { units, holderId: windowId, kind: 'window', budgetMs: 100 });
    return windowId;
  }

  const heldUnits = async (windowId: string): Promise<string[]> => (await leasesOf({ db }, windowId)).map((lease) => lease.unit);

  async function refusalOf(pending: Promise<unknown>): Promise<WindowRefusedError> {
    const error = await pending.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WindowRefusedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    return error as WindowRefusedError;
  }

  it.each([
    ['its only owner', [FINANCE], 'finance' as DataOwner],
    ['its second owner', [FINANCE, SURVEYS], 'surveys' as DataOwner],
  ])('keeps a close whose answer was lost at %s, with the leases, until the owner reopens it', async (_label, units, lost) => {
    const owners = ownersDouble();
    owners.fault(lost, 'close', { kind: 'lost-reply' });
    owners.fault(lost, 'open', { kind: 'fail' });
    const { service } = instance(owners, gatewayDouble());

    const refusal = await refusalOf(service.open(openRequest(units)));
    const { windowId } = refusal;
    const lostUnits = units.filter((unit) => CATALOG.ownerOf(unit) === lost);
    // The claim is released after the answer.
    await service.stop();

    expect(refusal.reason).toBe('owner-unavailable');
    const kept = await rowOf(windowId);
    expect(kept).toMatchObject({ state: 'opening', closing_gates: { [lost]: lostUnits }, closed_gates: {}, claimed_by: null });
    expect(await heldUnits(windowId)).toEqual(units);
    for (const unit of lostUnits) expect(owners.gate(unit)).toMatchObject({ state: 'closed', holderId: windowId });

    await service.runRecoveryPass();

    expect(await rowOf(windowId)).toMatchObject({ state: 'failed', closing_gates: {}, closed_gates: {}, claimed_by: null });
    expect(await heldUnits(windowId)).toEqual([]);
    for (const unit of units) expect(owners.gate(unit)).toMatchObject({ state: 'open', holderId: null });
  });

  it.each([
    ['its close had committed', true, 'runRecoveryPass' as const],
    ['its close never arrived', false, 'resumeWindows' as const],
  ])('gives back an opening a dead instance left after persisting its close intent when %s', async (_label, committed, entry) => {
    const owners = ownersDouble();
    const windowId = await seedOpening([FINANCE], -1000);
    if (committed) owners.closeAs(windowId, [FINANCE]);
    const { service } = instance(owners, gatewayDouble());

    await service[entry]();

    expect(owners.opens(windowId).map((call) => call.req.units)).toEqual([[FINANCE]]);
    expect(owners.gate(FINANCE)).toMatchObject({ state: 'open', holderId: null });
    expect(await rowOf(windowId)).toMatchObject({ state: 'failed', closing_gates: {}, claimed_by: null });
    expect(await heldUnits(windowId)).toEqual([]);
  });

  it.each([
    ['owner phase call', 'phase' as const],
    ['projection wait', 'projection' as const],
  ])('refuses an open whose %s outlasts the budget and gives everything back', async (_label, slow) => {
    // The budget also aborts each database step in real time, so it stays well above one step's latency.
    const budgetMs = 1000;
    const owners = ownersDouble();
    if (slow === 'phase') owners.fault('finance', 'phase', { kind: 'slow', ms: 5000 });
    const projectionBudgets: number[] = [];
    let slowStageAt = Number.NaN;
    const projector: Pick<Projector, 'awaitProjection'> = {
      async awaitProjection(req) {
        slowStageAt = Date.now();
        projectionBudgets.push(req.timeoutMs ?? Number.POSITIVE_INFINITY);
        if (slow !== 'projection') return { positions: new Map(), waitedMs: 0 };
        await delay(req.timeoutMs ?? 5000);
        throw new ProjectionTimeoutError([], req.timeoutMs ?? 5000);
      },
    };
    // A frozen clock leaves the whole budget to the slow step, however long the stages before it take.
    const { service } = instance(owners, gatewayDouble(), { windows: { openBudgetMs: budgetMs }, projector, clock: manualClock() });

    const refusal = await refusalOf(service.open(openRequest([FINANCE, SURVEYS])));

    // From the projection wait on; uncapped, either slow step takes 5000 ms.
    expect(Date.now() - slowStageAt).toBeLessThan(2500);
    const bounded = owners.calls.filter((call) => call.options !== undefined);
    expect(bounded.map((call) => call.req.op)).toEqual(slow === 'phase' ? ['close', 'close', 'phase'] : ['close', 'close']);
    for (const call of bounded) {
      expect(call.options?.timeoutMs).toBeGreaterThan(0);
      expect(call.options?.timeoutMs).toBeLessThanOrEqual(budgetMs);
      if (call.req.op === 'close') expect(call.req.timeoutMs).toBeLessThan(call.options?.timeoutMs ?? 0);
    }
    for (const timeoutMs of projectionBudgets) expect(timeoutMs).toBeLessThanOrEqual(budgetMs);
    for (const unit of [FINANCE, SURVEYS]) expect(owners.gate(unit)).toMatchObject({ state: 'open', holderId: null });
    expect(await heldUnits(refusal.windowId)).toEqual([]);
    expect(await rowOf(refusal.windowId)).toMatchObject({ state: 'failed', closing_gates: {}, closed_gates: {} });
  });

  it('answers an open within its budget while its claim release lags, and runs the next complete after the release', async () => {
    const budgetMs = 1000;
    const releaseDelayMs = budgetMs + 500;
    const releasedAt: number[] = [];
    const slowRelease = hookedDb(async (sql, run) => {
      if (!sql.includes('SET claimed_by = NULL')) return run();
      await delay(releaseDelayMs);
      const result = await run();
      releasedAt.push(Date.now());
      return result;
    });
    let importedAt = Number.NaN;
    imports.importWindow.mockImplementationOnce(() => {
      importedAt = Date.now();
      return Promise.resolve(NO_IMPORT);
    });
    // A frozen clock keeps host load from spending the logical budget; the release still lags in real time.
    const { service } = instance(ownersDouble(), gatewayDouble(), { windows: { openBudgetMs: budgetMs }, db: slowRelease, clock: manualClock() });

    const startedAt = Date.now();
    const opened = await service.open(openRequest([FINANCE]));
    const answeredAt = Date.now();

    expect(opened).toMatchObject({ state: 'open', phase: 'executing' });
    expect(answeredAt - startedAt).toBeLessThan(releaseDelayMs);
    await expect(service.complete(opened.windowId, { forwarded: true, legacyStatus: 200 })).resolves.toEqual({ state: 'closed' });
    expect(releasedAt[0]).toBeGreaterThan(answeredAt);
    expect(importedAt).toBeGreaterThanOrEqual(releasedAt[0] ?? Number.POSITIVE_INFINITY);
    expect(await rowOf(opened.windowId)).toMatchObject({ state: 'closed', claimed_by: null });
  });

  it('leaves an opening another live instance holds alone and lets it open', async () => {
    const owners = ownersDouble();
    const gateway = gatewayDouble();
    const projected = deferred();
    const awaited = deferred();
    const a = instance(owners, gateway, {
      projector: {
        async awaitProjection() {
          awaited.resolve();
          await projected.promise;
          return { positions: new Map(), waitedMs: 0 };
        },
      },
    });
    const b = instance(owners, gateway);

    const opening = a.service.open(openRequest([FINANCE]));
    await awaited.promise;
    const windowId = owners.calls[0]?.req.holderId ?? '';
    await b.service.resumeWindows();
    await b.service.runRecoveryPass();

    expect(owners.opens(windowId)).toEqual([]);
    expect(owners.gate(FINANCE)).toMatchObject({ state: 'closed', holderId: windowId });
    expect((await rowOf(windowId)).state).toBe('opening');
    projected.resolve();
    await expect(opening).resolves.toEqual({ windowId, state: 'open', phase: 'executing' });
    await a.service.stop();
    expect(await rowOf(windowId)).toMatchObject({ state: 'open', claimed_by: null });
  });

  it('takes over an opening only once its dead claimant’s claim has expired', async () => {
    const owners = ownersDouble();
    const clock = manualClock();
    const claimMs = 250;
    const windowId = await seedOpening([FINANCE], claimMs, clock);
    owners.closeAs(windowId, [FINANCE]);
    const { service } = instance(owners, gatewayDouble(), { clock });

    await service.runRecoveryPass();
    expect(await rowOf(windowId)).toMatchObject({ state: 'opening', claimed_by: 'dead-instance' });
    expect(owners.opens(windowId)).toEqual([]);

    clock.advance(claimMs + 1);
    await service.runRecoveryPass();
    expect(await rowOf(windowId)).toMatchObject({ state: 'failed', claimed_by: null });
    expect(owners.gate(FINANCE)).toMatchObject({ state: 'open', holderId: null });
    expect(await heldUnits(windowId)).toEqual([]);
  });

  it('finishes once when another instance’s recovery pass meets a complete in progress', async () => {
    const owners = ownersDouble();
    const gateway = gatewayDouble();
    const a = instance(owners, gateway);
    const b = instance(owners, gateway);
    const { windowId } = await a.service.open(openRequest([FINANCE, SURVEYS]));
    const importing = deferred();
    const imported = deferred();
    imports.importWindow.mockImplementationOnce(async () => {
      importing.resolve();
      await imported.promise;
      return NO_IMPORT;
    });

    const completing = a.service.complete(windowId, { forwarded: true, legacyStatus: 200 });
    await importing.promise;
    expect((await rowOf(windowId)).phase).toBe('importing');
    await b.service.runRecoveryPass();
    imported.resolve();

    await expect(completing).resolves.toEqual({ state: 'closed' });
    await b.service.runRecoveryPass();
    expect(imports.importWindow).toHaveBeenCalledTimes(1);
    expect(owners.opens(windowId).map((call) => call.owner).sort()).toEqual(['finance', 'surveys']);
    expect(await rowOf(windowId)).toMatchObject({ state: 'closed', claimed_by: null });
  });

  it('completes nothing more while another instance’s recovery holds the window, then reports it closed', async () => {
    const owners = ownersDouble();
    const gateway = gatewayDouble();
    const restarting = deferred();
    const restarted = deferred();
    const polled = deferred();
    // The shared clock moves only when advanced: the lease expires on demand and the complete's claim wait never runs out.
    const clock = manualClock();
    const a = instance(owners, gateway, {
      clock,
      sleep: async (ms) => {
        polled.resolve();
        await delay(ms);
      },
    });
    const b = instance(owners, gateway, {
      clock,
      restart: async () => {
        restarting.resolve();
        await restarted.promise;
        return { exitCode: 0, durationMs: 1 };
      },
    });
    const { windowId } = await a.service.open(openRequest([FINANCE]));
    clock.advance(CONFIG.windows.gatewayLeaseMs + 1);

    const recovering = b.service.runRecoveryPass();
    await restarting.promise;
    const completing = a.service.complete(windowId, { forwarded: true, legacyStatus: 200 });
    await polled.promise;
    restarted.resolve();
    await recovering;
    const importsByRecovery = imports.importWindow.mock.calls.length;

    await expect(completing).resolves.toEqual({ state: 'closed' });
    expect(importsByRecovery).toBeGreaterThan(0);
    expect(imports.importWindow).toHaveBeenCalledTimes(importsByRecovery);
    const row = await rowOf(windowId);
    expect(row.state).toBe('closed');
    expect(row.phases.map((event) => event.phase)).toContain('restart-evidence');
    expect(row.phases.map((event) => event.phase)).not.toContain('completed');
  });

  it.each([
    ['complete', (service: WindowService, windowId: string) => service.complete(windowId, { forwarded: true })],
    ['resolve', (service: WindowService, windowId: string) => service.resolve(windowId)],
  ])('refuses to %s a window another live instance keeps claimed past its claim wait', async (action, run) => {
    const owners = ownersDouble();
    const gateway = gatewayDouble();
    const a = instance(owners, gateway);
    // The open budget bounds the action's claim wait.
    const b = instance(owners, gateway, { windows: { openBudgetMs: 300 } });
    const { windowId } = await a.service.open(openRequest([FINANCE]));
    await setClaim(windowId, 'live-instance', 60_000);

    const error = await run(b.service, windowId).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(WindowStateError);
    expect(error).toMatchObject({ windowId, state: 'open', action });
    expect(imports.importWindow).not.toHaveBeenCalled();
    expect(await rowOf(windowId)).toMatchObject({ state: 'open', claimed_by: 'live-instance' });
  });

  it.each([
    [
      'an open during its projection wait',
      'opening',
      async (owners: OwnersDouble): Promise<string> => {
        const projected = deferred();
        const awaited = deferred();
        const a = instance(owners, gatewayDouble(), {
          projector: {
            async awaitProjection() {
              awaited.resolve();
              await projected.promise;
              return { positions: new Map(), waitedMs: 0 };
            },
          },
        });
        const opening = a.service.open(openRequest([FINANCE]));
        await awaited.promise;
        const windowId = owners.calls[0]?.req.holderId ?? '';
        await setClaim(windowId, 'usurper', 60_000);
        projected.resolve();
        await expect(opening).rejects.toBeInstanceOf(WindowStateError);
        return windowId;
      },
    ],
    [
      'a complete during its import',
      'open',
      async (owners: OwnersDouble): Promise<string> => {
        const a = instance(owners, gatewayDouble());
        const { windowId } = await a.service.open(openRequest([FINANCE]));
        const importing = deferred();
        const imported = deferred();
        imports.importWindow.mockImplementationOnce(async () => {
          importing.resolve();
          await imported.promise;
          return NO_IMPORT;
        });
        const completing = a.service.complete(windowId, { forwarded: true, legacyStatus: 200 });
        await importing.promise;
        await setClaim(windowId, 'usurper', 60_000);
        imported.resolve();
        await expect(completing).resolves.toEqual({ state: 'import-pending' });
        return windowId;
      },
    ],
  ])('neither reopens nor releases after losing its claim in %s', async (_label, state, provoke) => {
    const owners = ownersDouble();

    const windowId = await provoke(owners);

    expect(owners.opens(windowId)).toEqual([]);
    expect(owners.gate(FINANCE)).toMatchObject({ state: 'closed', holderId: windowId });
    expect(await heldUnits(windowId)).toEqual([FINANCE]);
    expect(await rowOf(windowId)).toMatchObject({ state, claimed_by: 'usurper' });
  });

  /**
   * Instance `a` completes a window on `FINANCE` whose import applies only after `proceed`, and every renewal of its claim
   * fails meanwhile; `b` shares its owners, gateway and clock. Resolves once a renewal failed.
   */
  async function lapsedImport() {
    // A third of this budget is the renewal interval, so renewals run while the import waits.
    const budgetMs = 900;
    const owners = ownersDouble();
    const gateway = gatewayDouble();
    const clock = manualClock();
    const statements: string[] = [];
    let renewalsFail = false;
    const renewalFailed = deferred();
    const aDb = hookedDb((sql, run) => {
      statements.push(sql);
      if (!renewalsFail || !sql.includes('SET claim_expires_at = GREATEST')) return run();
      renewalFailed.resolve();
      return Promise.reject(new Error('renewal refused'));
    });
    const a = instance(owners, gateway, { clock, db: aDb, windows: { openBudgetMs: budgetMs } });
    const b = instance(owners, gateway, { clock });
    const { windowId } = await a.service.open(openRequest([FINANCE]));
    const importing = deferred();
    const proceed = deferred();
    // What `a`'s apply came to: 'applied', or the error refusing it.
    const applyOutcome = deferred<unknown>();
    imports.importWindow.mockImplementationOnce(async (ctx: MigrationContext) => {
      importing.resolve();
      await proceed.promise;
      const outcome = await ctx.owners.apply('finance', applyBatch(windowId, 'a')).then(
        () => 'applied',
        (error: unknown) => error,
      );
      applyOutcome.resolve(outcome);
      if (outcome !== 'applied') throw outcome;
      return NO_IMPORT;
    });
    const completing = a.service.complete(windowId, { forwarded: true, legacyStatus: 200 });
    await importing.promise;
    renewalsFail = true;
    await renewalFailed.promise;
    return { owners, clock, statements, b, windowId, completing, proceed, applyOutcome, budgetMs };
  }

  const leaseStatements = (statements: string[]): string[] => statements.filter((sql) => sql.includes('unit_lease'));

  it('refuses every effect of a holder whose claim lapsed once another instance took its window over at expiry', async () => {
    const { owners, clock, statements, b, windowId, completing, proceed, applyOutcome, budgetMs } = await lapsedImport();
    imports.importWindow.mockImplementationOnce(async (ctx: MigrationContext) => {
      await ctx.owners.apply('finance', applyBatch(windowId, 'b'));
      return NO_IMPORT;
    });

    // Past `a`'s fence threshold, then past its claim's expiry.
    clock.advance(budgetMs + 1);
    clock.advance(MAX_CALL_MS);
    await b.service.runRecoveryPass();

    expect(await rowOf(windowId)).toMatchObject({ state: 'closed', claimed_by: null });
    expect(owners.gate(FINANCE)).toMatchObject({ state: 'open', holderId: null });
    const callsAtTakeover = owners.calls.length;
    const statementsAtTakeover = statements.length;
    proceed.resolve();

    expect(await applyOutcome.promise).toBeInstanceOf(WindowStateError);
    await expect(completing).resolves.toEqual({ state: 'import-pending' });
    expect(owners.applied.map((entry) => entry.req.batchId)).toEqual(['b']);
    expect(owners.calls.slice(callsAtTakeover)).toEqual([]);
    expect(leaseStatements(statements.slice(statementsAtTakeover))).toEqual([]);
    expect(await rowOf(windowId)).toMatchObject({ state: 'closed', claimed_by: null });
  });

  it('keeps a lapsed but unexpired claim from another instance while its holder issues no further effect', async () => {
    const { owners, clock, statements, b, windowId, completing, proceed, applyOutcome, budgetMs } = await lapsedImport();
    const holder = (await rowOf(windowId)).claimed_by;

    // Past `a`'s fence threshold, before its claim's expiry.
    clock.advance(budgetMs + 1);
    await b.service.runRecoveryPass();

    expect(holder).not.toBeNull();
    expect(await rowOf(windowId)).toMatchObject({ state: 'open', phase: 'importing', claimed_by: holder });
    expect(imports.importWindow).toHaveBeenCalledTimes(1);
    const callsAtLapse = owners.calls.length;
    const statementsAtLapse = statements.length;
    proceed.resolve();

    expect(await applyOutcome.promise).toBeInstanceOf(WindowStateError);
    await expect(completing).resolves.toEqual({ state: 'import-pending' });
    expect(owners.applied).toEqual([]);
    expect(owners.calls.slice(callsAtLapse)).toEqual([]);
    expect(leaseStatements(statements.slice(statementsAtLapse))).toEqual([]);
    expect(owners.gate(FINANCE)).toMatchObject({ state: 'closed', holderId: windowId });
    expect(await heldUnits(windowId)).toEqual([FINANCE]);
    expect(await rowOf(windowId)).toMatchObject({ state: 'import-pending', claimed_by: null });
  });

  it('extends its claim over a recovery restart before starting it', async () => {
    const owners = ownersDouble();
    const gateway = gatewayDouble();
    const clock = manualClock();
    let claimedUntil: Date | null = null;
    const a = instance(owners, gateway, { clock });
    const b = instance(owners, gateway, {
      clock,
      restart: async () => {
        const { rows } = await db.withMetadata((tx) =>
          tx.query<{ claim_expires_at: Date | null }>(`SELECT claim_expires_at FROM ${tx.schema}.write_window WHERE window_id = $1`, [windowId]),
        );
        claimedUntil = rows[0]?.claim_expires_at ?? null;
        return { exitCode: 0, durationMs: 1 };
      },
    });
    const { windowId } = await a.service.open(openRequest([FINANCE]));
    await a.service.stop();
    clock.advance(CONFIG.windows.gatewayLeaseMs + 1);
    const restartFrom = clock.now().getTime();

    await b.service.runRecoveryPass();

    expect((claimedUntil as Date | null)?.getTime()).toBe(restartFrom + CONFIG.windows.gatewayLeaseMs + CONFIG.windows.openBudgetMs + MAX_CALL_MS);
    expect(await rowOf(windowId)).toMatchObject({ state: 'closed', claimed_by: null });
  });

  const sentinelBody = { error: 'rejected', email: SENTINEL_EMAIL, password: SENTINEL_PASSWORD, amount: SENTINEL_AMOUNT };

  it.each([
    [
      'an owner answer body during an open',
      async (owners: OwnersDouble, service: WindowService): Promise<Error[]> => {
        const closeError = new OwnerCallError('finance', 'POST', GATE_PATH, 503, sentinelBody);
        const openError = new OwnerCallError('finance', 'POST', GATE_PATH, 503, sentinelBody, `Owner refused ${SENTINEL_EMAIL}`);
        owners.fault('finance', 'close', { kind: 'fail', error: closeError });
        owners.fault('finance', 'open', { kind: 'fail', error: openError });
        await refusalOf(service.open(openRequest([FINANCE])));
        return [closeError, openError];
      },
    ],
    [
      'a gate conflict body during a give-back',
      async (owners: OwnersDouble, service: WindowService): Promise<Error[]> => {
        const closeError = new OwnerCallError('finance', 'POST', GATE_PATH, 503, sentinelBody);
        owners.fault('finance', 'close', { kind: 'fail', error: closeError });
        owners.fault('finance', 'open', { kind: 'fail', error: new GateConflict('finance', { error: 'gate-conflict', units: [FINANCE, SENTINEL_EMAIL] }) });
        await refusalOf(service.open(openRequest([FINANCE])));
        return [closeError];
      },
    ],
    [
      'an import failure cause during a complete',
      async (_owners: OwnersDouble, service: WindowService): Promise<Error[]> => {
        const { windowId } = await service.open(openRequest([FINANCE]));
        const importError = new WindowImportError(windowId, `Apply of ${SENTINEL_EMAIL} for ${SENTINEL_AMOUNT} failed`, {
          owner: 'finance',
          table: 'tfinance',
          cause: new Error(`password=${SENTINEL_PASSWORD} amount=${SENTINEL_AMOUNT}`),
        });
        imports.importWindow.mockRejectedValueOnce(importError);
        await expect(service.complete(windowId, { forwarded: true, legacyStatus: 200 })).resolves.toEqual({ state: 'import-pending' });
        return [importError];
      },
    ],
  ])('logs %s only as a sanitized error record', async (_label, provoke) => {
    const owners = ownersDouble();
    const { service, logger } = instance(owners, gatewayDouble());

    const errors = await provoke(owners, service);

    const logged = logger.calls.flatMap((call) => {
      const fields = call.args[0];
      return typeof fields === 'object' && fields !== null && 'error' in fields ? [(fields as { error: unknown }).error] : [];
    });
    expect(logged.length).toBeGreaterThanOrEqual(errors.length);
    for (const call of logger.calls) {
      const texts = textsOf(call.args).join('\n');
      for (const sentinel of SENTINELS) expect(texts).not.toContain(sentinel);
    }
    for (const record of logged) {
      expect(record).not.toBeInstanceOf(Error);
      expect(Object.keys(record as object).every((key) => ['type', 'message', 'stack'].includes(key))).toBe(true);
    }
    for (const error of errors) expect(logged).toContainEqual(serializeError(error));
  });
});
