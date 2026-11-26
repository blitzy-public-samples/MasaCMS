// Write windows over a throwaway `migration` schema: unit leases, owner gate compare-and-set, the window row, the fake
// legacy database, the requests each double received and the `windows.json` run log.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { canonicalTypeForSqlServer, decodeRow, type ApplyRequest, type CanonicalColumn, type GateRequest } from '@opt2/platform/migration-kit';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, assertResponseMatchesOpenApi, loadOpenApiDocument, mintServiceToken, pgAvailable, testVerifier } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';

import { loadConfig } from '../src/config.js';
import type { components } from '../src/generated/openapi.js';
import { RestartUnavailableError, type restartLegacy } from '../src/legacy/index.js';
import { loadUnitCatalog, type OwnersClient } from '../src/owners/index.js';
import { readLogEntries, type WindowLogEntry } from '../src/reports/index.js';
import { ProjectionTimeoutError, type Projector } from '../src/reverse/index.js';
import { buildApp } from '../src/server.js';
import {
  LEGACY_STEP_ROUTE_KEY,
  LeaseUnavailableError,
  STARTUP_WINDOW_HOLDER_ENV,
  WindowNotFoundError,
  WindowRefusedError,
  acquireLeases,
  createWindowService,
  holdersOf,
  leasesOf,
  releaseLeases,
  windowBatchId,
  type WindowHooks,
  type WindowService,
} from '../src/windows/index.js';

import { buildTestContext, withMigrationSchema, type MigrationSchemaHandle, type TestContext } from './helpers/context.js';
import { formatWireTime } from './helpers/bridge-double.js';
import type { MutableClock } from './helpers/env.js';
import { FIXTURE_CATALOG, TABLES, UNITS, V0001, V0002, fixtureGroups, imageSizeRow, userRow, type FixtureTableName } from './helpers/fixtures.js';
import { createGatewayDouble } from './helpers/gateway-double.js';
import { createOwnerDoubles, type OwnerDoubleState, type OwnerDoubles } from './helpers/owner-double.js';
import { PG_OWNER_ROWS_PATH, fetchPgOwnerRows, startPgOwner, type PgOwner } from './helpers/pg-owner.js';

type Schemas = components['schemas'];
type WindowOpenRequest = Schemas['WindowOpenRequest'];

const PG = await pgAvailable();
const CONFIG = loadConfig();
const { openBudgetMs, importRetryMs, gatewayLeaseMs } = CONFIG.windows;
const OPENAPI = loadOpenApiDocument(new URL('../contracts/openapi.yaml', import.meta.url), parse) as object;

/** A withheld roster variant: a legacy-write entry whose window spans both roster participants. */
const ROUTE = 'admin:cusers.update{type=2,action=delete}';
const PERSON = UNITS.person;
const ACCOUNT = UNITS.userAccount;
const CONTENT = UNITS.content;
const FILE = UNITS.file;
const ROSTER_UNITS = [ACCOUNT, PERSON];
const CONTENT_UNITS = [CONTENT, FILE];
/** The seeded `tenant-a` system user every roster window is scoped to. */
const ANA = String(userRow({ UserName: 'ana.editor', SiteID: 'tenant-a', Fname: 'Ana', Lname: 'Editor' }).UserID);
/** Legacy tables mirrored into the owners that export them, as a completed backfill leaves them. */
const MIRRORED: readonly (readonly [FixtureTableName, readonly string[]])[] = [
  ['tusers', ['identity', 'people']],
  ['tcontent', ['strategies-content']],
  ['tfiles', ['strategies-content']],
];
const VERSIONS = { v0001: V0001, v0002: V0002 } as const;
const MAX_DRIVE_STEPS = 20_000;

/** A sleep whose sleepers resolve only when stepped; each step moves the clock to the sleeper's due time. */
interface SteppedSleep {
  sleep(ms: number): Promise<void>;
  pending(): number;
  step(): void;
  /** Settles `work`, stepping the clock only while the code under test is asleep. */
  drive<T>(work: Promise<T>): Promise<T>;
}

function steppedSleep(clock: MutableClock): SteppedSleep {
  const sleepers: { due: number; resolve: () => void }[] = [];
  const step = (): void => {
    const next = sleepers.shift();
    if (next === undefined) throw new Error('No sleeper to step');
    if (next.due > clock.now().getTime()) clock.set(next.due);
    next.resolve();
  };
  return {
    sleep(ms) {
      return new Promise((resolve) => {
        sleepers.push({ due: clock.now().getTime() + Math.max(0, ms), resolve });
        sleepers.sort((a, b) => a.due - b.due);
      });
    },
    pending: () => sleepers.length,
    step,
    async drive(work) {
      let settled = false;
      const watched = work.finally(() => {
        settled = true;
      });
      watched.catch(() => undefined);
      for (let steps = 0; !settled; steps += 1) {
        if (steps > MAX_DRIVE_STEPS) throw new Error('drive: work did not settle');
        if (sleepers.length > 0) step();
        await delay(1);
      }
      return watched;
    },
  };
}

interface HarnessOptions {
  active?: keyof typeof VERSIONS;
  restart?: 'ok' | 'unavailable';
  hooks?: WindowHooks;
  owners?: OwnersClient;
  sites?: readonly string[];
}

/** One test's context, its window service and the ports injected into it. */
interface Harness {
  t: TestContext;
  service: WindowService;
  sleep: SteppedSleep;
  projector: { awaitProjection: Mock<Projector['awaitProjection']> };
  restart: Mock<typeof restartLegacy>;
}

let schema: MigrationSchemaHandle;
const harnesses: Harness[] = [];

function doubles(t: TestContext): OwnerDoubles {
  if (t.owners === null) throw new Error('This context has no owner doubles');
  return t.owners;
}

function ownerOf(t: TestContext, unit: string): OwnerDoubleState {
  return doubles(t).owner(FIXTURE_CATALOG.ownerOf(unit));
}

/** Seeds the exporting owners with the legacy rows, so a window import sees only what legacy writes inside it. */
function mirrorLegacy(t: TestContext): void {
  for (const [table, owners] of MIRRORED) {
    const definition = TABLES[table];
    const columns: CanonicalColumn[] = definition.columns.map((column) => ({ name: column.name, ...canonicalTypeForSqlServer(column.type, { scale: column.scale }) }));
    const byTenant = new Map<string, Record<string, unknown>[]>([[tenantIdForSite('umbrella'), []]]);
    for (const row of t.legacy.rows(definition.qualified)) {
      const tenantId = tenantIdForSite(String(row.SiteID ?? row.siteID));
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), row]);
    }
    for (const owner of owners) for (const [tenantId, rows] of byTenant) doubles(t).owner(owner).seedRows(table, tenantId, rows, columns);
  }
}

/** Opens the gate of every unit the active fixture version makes `target`-authoritative. */
function openTargetGates(t: TestContext, active: keyof typeof VERSIONS): void {
  const authority = VERSIONS[active].groupAuthority;
  for (const group of fixtureGroups().groups) {
    if (authority[group.id] !== 'target') continue;
    for (const unit of group.units) ownerOf(t, unit).setGate(unit, { state: 'open', holderId: null, phase: 'quiet' });
  }
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const active = options.active ?? 'v0002';
  const sites = options.sites === undefined ? {} : { sites: options.sites };
  const t = await buildTestContext({
    env: { LOG_LEVEL: 'fatal' },
    migrationDb: schema.db,
    gateway: { active },
    legacySeed: sites,
    bridge: { files: {}, ...sites },
    ...(options.owners === undefined ? {} : { owners: options.owners }),
  });
  if (t.owners !== null) {
    mirrorLegacy(t);
    openTargetGates(t, active);
  }
  const sleep = steppedSleep(t.clock);
  const projector = { awaitProjection: vi.fn<Projector['awaitProjection']>(() => Promise.resolve({ positions: new Map(), waitedMs: 0 })) };
  const restart = vi.fn<typeof restartLegacy>(async (_env, opts) => {
    const holder = opts.extraEnv?.[STARTUP_WINDOW_HOLDER_ENV] ?? '';
    t.log.append('restart', 'run', { holder, leased: (await leasesOf(t.ctx, holder)).map((lease) => lease.unit) });
    if (options.restart === 'unavailable') throw new RestartUnavailableError();
    return { exitCode: 0, durationMs: 1 };
  });
  const service = createWindowService(t.ctx, { projector, restart, sleep: sleep.sleep, ...(options.hooks === undefined ? {} : { hooks: options.hooks }) });
  const built: Harness = { t, service, sleep, projector, restart };
  harnesses.push(built);
  return built;
}

function rosterRequest(requestId = cfUuid()): WindowOpenRequest {
  return { routeKey: ROUTE, units: [PERSON, ACCOUNT], scope: { keys: { userid: ANA } }, requestId };
}

interface StoredWindow {
  window_id: string;
  state: string;
  phase: string | null;
  kind: string;
  outcome: string | null;
  error: { kind: string; reason?: string } | null;
  phases: { phase: string; at: string }[];
  closed_gates: Record<string, string[]>;
  scope: unknown;
  route_key: string;
  attempts: number;
  rows_imported: number;
}

async function storedWindows(where = 'TRUE', values: unknown[] = []): Promise<StoredWindow[]> {
  const { rows } = await schema.db.withMetadata((tx) =>
    tx.query<StoredWindow>(
      `SELECT window_id, state, phase, kind, outcome, error, phases, closed_gates, scope, route_key, attempts, rows_imported
         FROM migration.write_window WHERE ${where} ORDER BY opened_at, window_id`,
      values,
    ),
  );
  return rows;
}

async function storedWindow(windowId: string): Promise<StoredWindow> {
  const [row] = await storedWindows('window_id = $1', [windowId]);
  if (row === undefined) throw new Error(`No stored window ${windowId}`);
  return row;
}

/** Resolves once no service instance holds a claim on the window, as after an open's deferred claim release. */
async function claimReleased(windowId: string): Promise<void> {
  await vi.waitFor(async () => {
    const { rows } = await schema.db.withMetadata((tx) =>
      tx.query<{ claimed_by: string | null }>('SELECT claimed_by FROM migration.write_window WHERE window_id = $1', [windowId]),
    );
    expect(rows[0]?.claimed_by).toBeNull();
  });
}

async function allLeases(): Promise<{ unit: string; holder_id: string; kind: string }[]> {
  const { rows } = await schema.db.withMetadata((tx) =>
    tx.query<{ unit: string; holder_id: string; kind: string }>('SELECT unit, holder_id, kind FROM migration.unit_lease ORDER BY unit'),
  );
  return rows;
}

function gate(t: TestContext, unit: string): { state: string; holderId: string | null; phase: string } {
  const found = ownerOf(t, unit).gates.get(unit);
  if (found === undefined) throw new Error(`No gate ${unit}`);
  return { state: found.state, holderId: found.holderId, phase: found.phase };
}

/** Gate requests the owner doubles received naming `holderId`, in call order, as `<owner>:<op>` with each request. */
function gateCallsOf(t: TestContext, holderId: string): { call: string; req: GateRequest }[] {
  return t.log.entries
    .filter((entry) => entry.component.startsWith('owner:') && entry.op.startsWith('gate.') && (entry.args as GateRequest).holderId === holderId)
    .map((entry) => ({ call: `${entry.component.slice('owner:'.length)}:${entry.op.slice('gate.'.length)}`, req: entry.args as GateRequest }));
}

function applyCalls(t: TestContext): { owner: string; req: ApplyRequest }[] {
  return doubles(t)
    .owners()
    .flatMap((owner) =>
      doubles(t)
        .owner(owner)
        .calls.filter((call) => call.method === 'apply')
        .map((call) => ({ owner, req: call.args[0] as ApplyRequest })),
    );
}

/** Position in the shared call log of the first entry of `component` and `op`, or -1. */
function logIndex(t: TestContext, component: string, op: string): number {
  return t.log.indexOf(component, op);
}

async function writeLegacyFname(t: TestContext, userId: string, fname: string): Promise<void> {
  const pool = await t.legacy.live();
  await pool.request().input('fname', fname).input('id', userId).query('UPDATE [dbo].[tusers] SET [Fname] = @fname WHERE [UserID] = @id');
}

async function refusalOf(work: Promise<unknown>): Promise<WindowRefusedError> {
  const error: unknown = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(WindowRefusedError);
  return error as WindowRefusedError;
}

beforeAll(async () => {
  if (!PG) return;
  const handle = await withMigrationSchema();
  if (handle === null) throw new Error('PostgreSQL answered the probe but not the schema creation');
  schema = handle;
});

afterAll(async () => {
  await schema?.drop();
});

beforeEach(async () => {
  if (!PG) return;
  await schema.db.withMetadata(async (tx) => {
    await tx.query('DELETE FROM migration.unit_lease');
    await tx.query('DELETE FROM migration.write_window');
  });
});

afterEach(async () => {
  for (const { service, t } of harnesses.splice(0)) {
    await service.stop();
    await t.close();
  }
});

describe.skipIf(!PG)('write windows (skipped without PostgreSQL: PG_* unset)', () => {
  describe('overlapping windows on shared units', () => {
    it('serialises a second window at lease acquisition until the first closes, without touching its gates', async () => {
      const { t, service, sleep, projector } = await harness();
      const a = await service.open(rosterRequest());
      expect(a).toEqual({ windowId: a.windowId, state: 'open', phase: 'executing' });
      expect(await leasesOf(t.ctx, a.windowId)).toEqual(ROSTER_UNITS.map((unit) => expect.objectContaining({ unit, holderId: a.windowId, kind: 'window' })));
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'closed', holderId: a.windowId, phase: 'executing' });
      expect(projector.awaitProjection).toHaveBeenCalledWith({ owners: ['identity', 'people'], timeoutMs: openBudgetMs });

      const b = service.open({ ...rosterRequest(), units: [ACCOUNT, PERSON] });
      await vi.waitFor(() => expect(sleep.pending()).toBe(1));
      const [waiting] = await storedWindows("state = 'opening'");
      expect(waiting?.route_key).toBe(ROUTE);
      const bId = String(waiting?.window_id);
      expect(gateCallsOf(t, bId)).toEqual([]);
      expect(Object.fromEntries(await holdersOf(t.ctx, ROSTER_UNITS))).toEqual({ [ACCOUNT]: a.windowId, [PERSON]: a.windowId });
      for (const unit of ROSTER_UNITS) expect(gate(t, unit).holderId).toBe(a.windowId);

      await expect(service.complete(a.windowId, { forwarded: true, legacyStatus: 302 })).resolves.toEqual({ state: 'closed' });
      const opened = await sleep.drive(b);
      expect(opened.windowId).toBe(bId);
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'closed', holderId: bId, phase: 'executing' });
      await expect(service.complete(bId, { forwarded: true })).resolves.toEqual({ state: 'closed' });

      expect(Object.fromEntries((await storedWindows()).map((row) => [row.window_id, [row.state, row.outcome]]))).toEqual({
        [a.windowId]: ['closed', 'imported'],
        [bId]: ['closed', 'imported'],
      });
      expect(await allLeases()).toEqual([]);
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      expect(applyCalls(t)).toEqual([]);
    });

    it('refuses a second window whose budget ends before the first closes, leaving no lease or gate of its own', async () => {
      const { t, service, sleep } = await harness();
      const a = await service.open(rosterRequest());
      const openedAt = t.clock.now().getTime();

      const refused = await refusalOf(sleep.drive(service.open(rosterRequest())));
      expect(refused).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(refused.reason).toBe('lease-unavailable');
      expect(refused.cause).toBeInstanceOf(LeaseUnavailableError);
      expect((refused.cause as LeaseUnavailableError).conflictingHolders).toEqual([a.windowId]);
      expect(t.clock.now().getTime() - openedAt).toBe(openBudgetMs);

      expect(gateCallsOf(t, refused.windowId)).toEqual([]);
      expect(await storedWindow(refused.windowId)).toEqual(expect.objectContaining({ state: 'failed', outcome: 'aborted', error: expect.objectContaining({ kind: 'refused', reason: 'lease-unavailable' }) }));
      expect((await allLeases()).map((lease) => lease.holder_id)).toEqual([a.windowId, a.windowId]);
      for (const unit of ROSTER_UNITS) expect(gate(t, unit).holderId).toBe(a.windowId);
      await expect(service.complete(a.windowId, { forwarded: true })).resolves.toEqual({ state: 'closed' });
    });

    it('opens a window on disjoint units while another executes, without waiting', async () => {
      const { t, service, sleep } = await harness();
      const a = await service.open(rosterRequest());
      const c = await service.open({ routeKey: 'admin:carch.update{upload=image}', units: [CONTENT], scope: { keys: { siteid: 'tenant-a' } }, requestId: cfUuid() });

      expect(sleep.pending()).toBe(0);
      expect(c.phase).toBe('executing');
      expect(gate(t, CONTENT)).toEqual({ state: 'closed', holderId: c.windowId, phase: 'executing' });
      expect(Object.fromEntries(await holdersOf(t.ctx, [...ROSTER_UNITS, CONTENT]))).toEqual({ [ACCOUNT]: a.windowId, [PERSON]: a.windowId, [CONTENT]: c.windowId });
      await expect(service.complete(c.windowId, { forwarded: true })).resolves.toEqual({ state: 'closed' });
      await expect(service.complete(a.windowId, { forwarded: true })).resolves.toEqual({ state: 'closed' });
      expect(gate(t, CONTENT)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
    });
  });

  describe('a transition racing a window', () => {
    it('refuses a window while a transition holds its units, and opens one once the transition releases them', async () => {
      const { t, service, sleep } = await harness();
      const transitionId = cfUuid();
      await acquireLeases(t.ctx, { units: [PERSON], holderId: transitionId, kind: 'transition', budgetMs: openBudgetMs });

      const refused = await refusalOf(sleep.drive(service.open({ ...rosterRequest(), units: [PERSON] })));
      expect(refused.reason).toBe('lease-unavailable');
      expect((refused.cause as LeaseUnavailableError).conflictingHolders).toEqual([transitionId]);
      expect(gate(t, PERSON)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      expect(await allLeases()).toEqual([{ unit: PERSON, holder_id: transitionId, kind: 'transition' }]);

      await expect(releaseLeases(t.ctx, transitionId)).resolves.toBe(1);
      const opened = await service.open({ ...rosterRequest(), units: [PERSON] });
      expect(gate(t, PERSON).holderId).toBe(opened.windowId);
      await expect(service.complete(opened.windowId, { forwarded: true })).resolves.toEqual({ state: 'closed' });
    });

    it('keeps a transition from leasing units of an executing window until the window closes', async () => {
      const { t, service, sleep } = await harness();
      const window = await service.open({ ...rosterRequest(), units: [PERSON] });
      const order: string[] = [];
      const transitionId = cfUuid();
      const leasing = acquireLeases(t.ctx, { units: [PERSON], holderId: transitionId, kind: 'transition', budgetMs: openBudgetMs, sleep: sleep.sleep }).then((rows) => {
        order.push('transition-leased');
        return rows;
      });
      await vi.waitFor(() => expect(sleep.pending()).toBe(1));
      expect(Object.fromEntries(await holdersOf(t.ctx, [PERSON]))).toEqual({ [PERSON]: window.windowId });

      await service.complete(window.windowId, { forwarded: true });
      order.push('window-closed');
      const leased = await sleep.drive(leasing);

      expect(order).toEqual(['window-closed', 'transition-leased']);
      expect(leased).toEqual([expect.objectContaining({ unit: PERSON, holderId: transitionId, kind: 'transition' })]);
      expect(gate(t, PERSON)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      await releaseLeases(t.ctx, transitionId);
    });
  });

  describe('an open that cannot complete', () => {
    it('reopens by holder compare-and-set what it closed and releases its leases when an owner is down, before legacy runs anything', async () => {
      const { t, service } = await harness();
      // Owners close in sorted order, so identity closes before people is found down.
      ownerOf(t, PERSON).failNext('gate', 'down');

      const refused = await refusalOf(service.open(rosterRequest()));
      expect(refused.reason).toBe('owner-unavailable');
      expect(gateCallsOf(t, refused.windowId).map(({ call }) => call)).toEqual([
        'identity:close',
        'people:close',
        'identity:open',
        'people:open',
      ]);
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      expect(await allLeases()).toEqual([]);
      expect(await storedWindow(refused.windowId)).toEqual(expect.objectContaining({ state: 'failed', outcome: 'aborted', closed_gates: {} }));
      await expect(service.get(refused.windowId)).resolves.toEqual(expect.objectContaining({ state: 'aborted', outcome: 'aborted' }));
      expect(t.bridge?.calls).toEqual([]);
      expect(t.legacy.statements).toEqual([]);
    });

    it('never takes over a gate another holder closed', async () => {
      const { t, service } = await harness();
      const foreign = cfUuid();
      ownerOf(t, PERSON).setGate(PERSON, { state: 'closed', holderId: foreign, phase: 'executing' });

      const refused = await refusalOf(service.open(rosterRequest()));
      expect(refused.reason).toBe('gate-conflict');
      expect(gate(t, PERSON)).toEqual({ state: 'closed', holderId: foreign, phase: 'executing' });
      expect(gate(t, ACCOUNT)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      expect(await allLeases()).toEqual([]);
    });

    it.each([
      { name: 'answers after the open budget', reason: 'budget-exceeded', fails: false },
      { name: 'times out at the open budget', reason: 'projection-timeout', fails: true },
    ])('refuses the open and gives everything back when the projection $name', async ({ reason, fails }) => {
      const { t, service, sleep, projector } = await harness();
      projector.awaitProjection.mockImplementation(async ({ timeoutMs = 0 }) => {
        await sleep.sleep(fails ? timeoutMs : timeoutMs + 1);
        if (fails) throw new ProjectionTimeoutError([{ owner: 'people', xid: '100', tenantsBehind: [TENANT_A.tenantId] }], timeoutMs);
        return { positions: new Map(), waitedMs: timeoutMs + 1 };
      });
      const openedAt = t.clock.now().getTime();

      const refused = await refusalOf(sleep.drive(service.open(rosterRequest())));
      expect(refused.reason).toBe(reason);
      expect(t.clock.now().getTime() - openedAt).toBeGreaterThanOrEqual(openBudgetMs);
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      expect(gateCallsOf(t, refused.windowId).filter(({ req }) => req.op === 'phase')).toEqual([]);
      expect(await allLeases()).toEqual([]);
      expect((await storedWindow(refused.windowId)).state).toBe('failed');
    });
  });

  describe('an import that fails after legacy committed', () => {
    it('leaves the window and its gates import-pending, then the retry loop imports it once into the owner', async () => {
      const { t, service, sleep } = await harness();
      const opened = await service.open(rosterRequest());
      await writeLegacyFname(t, ANA, 'Anabel');
      const people = ownerOf(t, PERSON);
      people.failNext('apply', 'refuse');

      await expect(service.complete(opened.windowId, { forwarded: true, legacyStatus: 302 })).resolves.toEqual({ state: 'import-pending' });
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'closed', holderId: opened.windowId, phase: 'import-pending' });
      expect((await leasesOf(t.ctx, opened.windowId)).map((lease) => lease.unit)).toEqual(ROSTER_UNITS);
      expect(await storedWindow(opened.windowId)).toEqual(
        expect.objectContaining({ state: 'import-pending', phase: 'import-pending', attempts: 1, error: expect.objectContaining({ kind: 'import-failed' }) }),
      );
      expect(people.batches).toEqual([]);

      const loop = service.startImportRetryLoop();
      try {
        await vi.waitFor(() => expect(sleep.pending()).toBe(1));
        const retryAt = t.clock.now().getTime() + importRetryMs;
        sleep.step();
        expect(t.clock.now().getTime()).toBe(retryAt);
        await vi.waitFor(async () => expect((await storedWindow(opened.windowId)).state).toBe('closed'));
      } finally {
        await loop.stop();
      }

      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      expect(await allLeases()).toEqual([]);
      expect(people.calls.filter((call) => call.method === 'apply')).toHaveLength(2);
      expect(people.batches).toHaveLength(1);
      const [batch] = people.batches;
      expect(batch).toEqual(expect.objectContaining({ origin: 'legacy-window', holderId: opened.windowId, batchId: windowBatchId(opened.windowId, 2, 'people', 'tusers', 0) }));
      expect(batch?.rows).toHaveLength(1);
      expect(decodeRow(batch?.columns ?? [], batch?.rows[0]?.row ?? '')).toEqual(expect.objectContaining({ UserID: ANA, Fname: 'Anabel' }));
      expect(ownerOf(t, ACCOUNT).batches).toEqual([]);
      expect(await storedWindow(opened.windowId)).toEqual(expect.objectContaining({ outcome: 'imported', rows_imported: 1, attempts: 2 }));
    });

    it('makes a target read of an import-pending unit wait and answer 503, never the superseded value, until the import lands', async () => {
      const owner: PgOwner = await startPgOwner({ owner: 'programs-sites' });
      try {
        const legacyRow = imageSizeRow();
        const sizeId = String(legacyRow.sizeID);
        await owner.openGates();
        await owner.write((tx, repo) =>
          repo.upsert(tx, 'image_size', { sizeid: sizeId, siteid: legacyRow.siteID, name: legacyRow.name, height: legacyRow.height, width: legacyRow.width }),
        );
        let interrupted = false;
        const { t, service } = await harness({
          owners: owner.ownersClient,
          sites: ['umbrella', 'tenant-a', 'tenant-b'],
          hooks: {
            beforeImport: async (_window, attempt) => {
              if (attempt !== 1) return;
              interrupted = true;
              throw new Error('import interrupted after legacy committed');
            },
          },
        });
        const read = () =>
          fetchPgOwnerRows<{ rows?: { height: string }[] }>(owner.owner, `${owner.url}${PG_OWNER_ROWS_PATH}/image_size?tenantId=${TENANT_A.tenantId}&budgetMs=100`);
        expect((await read()).body.rows?.map((row) => row.height)).toEqual([legacyRow.height]);

        const opened = await service.open({ routeKey: 'admin:csettings.updatesite{action=delete}', units: [UNITS.imageSize], scope: { keys: { siteid: 'tenant-a' } }, requestId: cfUuid() });
        const pool = await t.legacy.live();
        await pool.request().input('height', '150').input('id', sizeId).query('UPDATE [dbo].[timagesizes] SET [height] = @height WHERE [sizeID] = @id');
        await expect(service.complete(opened.windowId, { forwarded: true })).resolves.toEqual({ state: 'import-pending' });
        expect(interrupted).toBe(true);

        const blocked = await read();
        expect(blocked.status).toBe(503);
        expect(blocked.body.rows).toBeUndefined();
        expect(JSON.stringify(blocked.body)).not.toContain(`"height":"${String(legacyRow.height)}"`);

        await service.runRecoveryPass();
        expect((await storedWindow(opened.windowId)).state).toBe('closed');
        expect((await read()).body.rows?.map((row) => row.height)).toEqual(['150']);
      } finally {
        await owner.close();
      }
    });
  });

  describe('an import retried while one owner is unreachable', () => {
    it('counts and persists every attempt, marks the reachable owner import-pending, then closes once the owner answers', async () => {
      const { t, service } = await harness();
      const warn = vi.spyOn(t.ctx.logger, 'warn');
      const opened = await service.open(rosterRequest());
      await writeLegacyFname(t, ANA, 'Anabel');
      // identity sorts before people, so a phase change stopping at the first failing owner would never reach people.
      const identity = ownerOf(t, ACCOUNT);
      identity.failAlways('gate', 'down');

      await expect(service.complete(opened.windowId, { forwarded: true, legacyStatus: 302 })).resolves.toEqual({ state: 'import-pending' });
      for (const attempt of [1, 2, 3]) {
        if (attempt > 1) await service.runRecoveryPass();
        expect(await storedWindow(opened.windowId)).toEqual(
          expect.objectContaining({ state: 'import-pending', phase: 'import-pending', attempts: attempt, error: expect.objectContaining({ kind: 'import-failed', attempt }) }),
        );
        expect(warn).toHaveBeenLastCalledWith(expect.anything(), `Window ${opened.windowId} import attempt ${String(attempt)} failed and is retried`);
        expect(warn).toHaveBeenCalledWith(
          { error: expect.objectContaining({ message: expect.stringContaining('identity') }) },
          `Window ${opened.windowId} could not mark its gates import-pending; they stay closed`,
        );
        expect(gate(t, PERSON)).toEqual({ state: 'closed', holderId: opened.windowId, phase: 'import-pending' });
        expect(gate(t, ACCOUNT)).toEqual({ state: 'closed', holderId: opened.windowId, phase: 'executing' });
      }
      expect(ownerOf(t, PERSON).batches).toEqual([]);

      identity.clearFailures();
      await service.runRecoveryPass();

      expect(await storedWindow(opened.windowId)).toEqual(expect.objectContaining({ state: 'closed', outcome: 'imported', attempts: 4, rows_imported: 1 }));
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
      expect(ownerOf(t, PERSON).batches.map((batch) => batch.batchId)).toEqual([windowBatchId(opened.windowId, 4, 'people', 'tusers', 0)]);
      expect(await allLeases()).toEqual([]);
    });
  });

  describe('a gateway lost mid-window', () => {
    const MINUTE = 60_000;

    it('imports and reopens nothing while the legacy write is held, then imports only after the controlled restart', async () => {
      const { t, service, restart } = await harness({ restart: 'ok' });
      const request = rosterRequest();
      const opened = await service.open(request);
      await claimReleased(opened.windowId);
      const openedAt = t.clock.now().getTime();
      // A live gateway instance still holds the legacy write, so lease expiry extends the lease instead of restarting legacy.
      t.gateway.addInflight({ instance: 'gw-1', requestId: request.requestId, route: ROUTE, side: 'legacy', startedAt: openedAt });
      await writeLegacyFname(t, ANA, 'Anabel');

      for (let minute = 1; minute <= 3; minute += 1) {
        t.clock.advance(MINUTE);
        await service.runRecoveryPass();
        expect(applyCalls(t)).toEqual([]);
        expect(gateCallsOf(t, opened.windowId).filter(({ req }) => req.op === 'open')).toEqual([]);
        expect((await leasesOf(t.ctx, opened.windowId)).map((lease) => lease.unit)).toEqual(ROSTER_UNITS);
        expect(restart).not.toHaveBeenCalled();
      }
      const held = await storedWindow(opened.windowId);
      expect(held).toEqual(expect.objectContaining({ state: 'open', phase: 'executing' }));
      expect(held.phases.map((event) => event.phase)).toContain('lease-extended');

      t.gateway.killInstance('gw-1');
      t.clock.advance(MINUTE);
      await service.runRecoveryPass();

      expect(restart).toHaveBeenCalledTimes(1);
      expect(restart.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ timeoutMs: gatewayLeaseMs, extraEnv: { [STARTUP_WINDOW_HOLDER_ENV]: opened.windowId } }));
      const restarted = logIndex(t, 'restart', 'run');
      expect(t.log.entries[restarted]?.args).toEqual({ holder: opened.windowId, leased: [CONTENT, FILE, ACCOUNT, PERSON].sort() });
      const contentClosed = logIndex(t, 'owner:strategies-content', 'gate.close');
      const cleared = logIndex(t, 'gateway', 'clearOrphans');
      const applied = logIndex(t, 'owner:people', 'apply');
      const reopened = t.log.entries.findIndex((entry) => entry.op === 'gate.open');
      expect(contentClosed).toBeGreaterThanOrEqual(0);
      expect([contentClosed, restarted, cleared, applied, reopened]).toEqual([...[contentClosed, restarted, cleared, applied, reopened]].sort((a, b) => a - b));
      expect(new Set([contentClosed, restarted, cleared, applied, reopened]).size).toBe(5);
      expect(t.gateway.calls.find((call) => call.op === 'clearOrphans')?.args).toEqual({
        side: 'legacy',
        evidence: { kind: 'legacy-restart', holderId: opened.windowId, at: new Date(openedAt + 4 * MINUTE).toISOString() },
      });
      expect(t.gateway.inflightRows()).toEqual([]);

      expect(await storedWindow(opened.windowId)).toEqual(expect.objectContaining({ state: 'closed', outcome: 'imported', rows_imported: 1 }));
      expect(ownerOf(t, PERSON).batches.map((batch) => batch.origin)).toEqual(['legacy-window']);
      expect(await allLeases()).toEqual([]);
      for (const unit of [...ROSTER_UNITS, ...CONTENT_UNITS]) expect(gate(t, unit)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
    });

    it('stays import-pending with its gates closed without a restart command, until an operator resolves it', async () => {
      const { t, service, restart } = await harness({ restart: 'unavailable' });
      const opened = await service.open(rosterRequest());
      await claimReleased(opened.windowId);
      await writeLegacyFname(t, ANA, 'Anabel');

      for (let minute = 1; minute <= 3; minute += 1) {
        t.clock.advance(MINUTE);
        await service.runRecoveryPass();
        expect(applyCalls(t)).toEqual([]);
        expect(gateCallsOf(t, opened.windowId).filter(({ req }) => req.op === 'open')).toEqual([]);
      }
      expect(restart).toHaveBeenCalledTimes(1);
      expect(await storedWindow(opened.windowId)).toEqual(
        expect.objectContaining({ state: 'import-pending', phase: 'import-pending', error: expect.objectContaining({ kind: 'awaiting-evidence', reason: 'restart-unavailable' }) }),
      );
      for (const unit of ROSTER_UNITS) expect(gate(t, unit)).toEqual({ state: 'closed', holderId: opened.windowId, phase: 'import-pending' });
      for (const unit of CONTENT_UNITS) expect(gate(t, unit)).toEqual({ state: 'closed', holderId: opened.windowId, phase: 'import-pending' });
      expect((await leasesOf(t.ctx, opened.windowId)).map((lease) => lease.unit)).toEqual([ACCOUNT, CONTENT, FILE, PERSON].sort());
      expect(t.gateway.calls.filter((call) => call.op === 'clearOrphans')).toEqual([]);

      const resolved = await service.resolve(opened.windowId, { actor: 'operator' });
      expect(resolved).toEqual(expect.objectContaining({ windowId: opened.windowId, state: 'closed', outcome: 'resolved' }));
      expect(ownerOf(t, PERSON).batches.map((batch) => batch.origin)).toEqual(['legacy-window']);
      expect(await storedWindow(opened.windowId)).toEqual(expect.objectContaining({ state: 'resolved', outcome: 'resolved' }));
      expect(await allLeases()).toEqual([]);
      for (const unit of [...ROSTER_UNITS, ...CONTENT_UNITS]) expect(gate(t, unit)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
    });

    it('rejects a lookup of an unknown window', async () => {
      const { service } = await harness();
      const unknown = cfUuid();
      await expect(service.get(unknown)).rejects.toEqual(new WindowNotFoundError(unknown));
    });
  });

  describe('legacy site-monitor steps', () => {
    it('runs a step that writes a target-authoritative unit inside a window scoped to its site', async () => {
      const { t, service } = await harness();
      const theTime = formatWireTime(t.clock.now());
      const lastMonitored = formatWireTime(new Date(t.clock.now().getTime() - 60_000));

      const result = await service.runLegacyStep({ step: 'sendReminders', siteId: 'tenant-a', theTime, lastMonitored, units: [CONTENT] });

      expect(result.windowState).toBe('closed');
      const windowId = String(result.response.windowId);
      expect(await storedWindow(windowId)).toEqual(
        expect.objectContaining({ kind: 'legacy-step', route_key: LEGACY_STEP_ROUTE_KEY, scope: { keys: { siteid: 'tenant-a' } }, state: 'closed', outcome: 'imported' }),
      );
      const jobs = t.bridge?.calls.filter((call) => call.file === 'jobs') ?? [];
      expect(jobs.map((call) => [call.op, call.query.theTime, call.query.lastMonitored, call.query.siteid])).toEqual([
        ['jobs.sendReminders', theTime, lastMonitored, 'tenant-a'],
      ]);
      const closed = logIndex(t, 'owner:strategies-content', 'gate.close');
      const ran = logIndex(t, 'bridge', 'jobs.sendReminders');
      const reopened = logIndex(t, 'owner:strategies-content', 'gate.open');
      expect(closed).toBeLessThan(ran);
      expect(ran).toBeLessThan(reopened);
      expect(gate(t, CONTENT)).toEqual({ state: 'open', holderId: null, phase: 'quiet' });
    });

    it('runs a step that writes only legacy-authoritative units straight through the bridge, with no window', async () => {
      const { t, service } = await harness();
      const theTime = formatWireTime(t.clock.now());

      const result = await service.runLegacyStep({ step: 'sendReminders', siteId: 'tenant-a', theTime, lastMonitored: theTime, units: [UNITS.mailingList] });

      expect(result.windowState).toBeUndefined();
      expect(result.response.windowId).toBeUndefined();
      expect(t.bridge?.calls.filter((call) => call.file === 'jobs')).toHaveLength(1);
      expect(await storedWindows()).toEqual([]);
      expect(await allLeases()).toEqual([]);
    });
  });

  describe('the windows.json run log', () => {
    it('is written only when the service stops, recording each window once with its route, units, scope, phase times, rows imported and outcome', async () => {
      const { t, service, sleep } = await harness();
      const closed = await service.open(rosterRequest());
      await writeLegacyFname(t, ANA, 'Anabel');
      const refused = await refusalOf(sleep.drive(service.open(rosterRequest())));
      await service.complete(closed.windowId, { forwarded: true, legacyStatus: 302 });
      await expect(readFile(path.join(t.dirs.reportsDir, 'windows.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await service.stop();

      const entries = await readLogEntries<WindowLogEntry>(t.dirs.reportsDir, 'windows.json');
      const outcomes = new Map([
        [closed.windowId, 'closed'],
        [refused.windowId, 'aborted-503'],
      ]);
      // Row order: opened_at, then window_id.
      expect(entries.map((entry) => [entry.windowId, entry.outcome])).toEqual((await storedWindows()).map((row) => [row.window_id, outcomes.get(row.window_id)]));
      const done = entries.find((entry) => entry.windowId === closed.windowId);
      const aborted = entries.find((entry) => entry.windowId === refused.windowId);
      expect(done).toEqual(
        expect.objectContaining({ kind: 'request', routeKey: ROUTE, units: ROSTER_UNITS, scope: { userid: ANA }, rowsImported: { people: 1 }, durationMs: expect.any(Number) }),
      );
      expect(done?.phases.map((phase) => phase.phase)).toEqual(['quiet', 'executing', 'importing', 'closed']);
      for (const phase of done?.phases ?? []) expect(Number.isNaN(Date.parse(phase.at))).toBe(false);
      expect(aborted?.phases).toEqual([]);
      const doc = JSON.parse(await readFile(path.join(t.dirs.reportsDir, 'windows.json'), 'utf8')) as { summary: { count: number; byOutcome: Record<string, number> } };
      expect(doc.summary).toEqual(expect.objectContaining({ count: 2, byOutcome: { closed: 1, 'aborted-503': 1 } }));
    });
  });

  describe('the window routes of the composed service', () => {
    const REAL_CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
    // Under the committed v0002 identity's redirects are target-authoritative; class-extension sets, with no carry writer, stay legacy-authoritative in every version.
    const TARGET_UNIT = 'identity.redirect';
    const LEGACY_UNIT = 'content.extend_set';

    let app: FastifyInstance | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    async function composed(h: Harness): Promise<{ app: FastifyInstance; identity: OwnerDoubleState }> {
      const owners = createOwnerDoubles(REAL_CATALOG, { owners: ['identity'], log: h.t.log });
      const identity = owners.owner('identity');
      identity.setGate(TARGET_UNIT, { state: 'open', holderId: null, phase: 'quiet' });
      app = await buildApp({
        env: h.t.ctx.env,
        clock: h.t.clock,
        verifierOverride: testVerifier('migration'),
        db: schema.db,
        legacy: h.t.legacy,
        owners: owners.client,
        gateway: createGatewayDouble({ active: 'v0002' }),
        startBackground: false,
      });
      return { app, identity };
    }

    async function call(target: FastifyInstance, caller: 'gateway' | 'operator', method: 'GET' | 'POST', url: string, payload?: unknown) {
      const headers: Record<string, string> = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}` };
      const res = await target.inject({
        method,
        url,
        headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
      return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
    }

    it('opens, reads and completes a window over HTTP with contract bodies', async () => {
      const h = await harness();
      const { app: target } = await composed(h);

      const opened = await call(target, 'gateway', 'POST', '/internal/v1/windows', {
        routeKey: 'admin:cextend.saveextendsetsort',
        units: [LEGACY_UNIT],
        scope: { keys: { siteid: 'tenant-a' } },
        requestId: cfUuid(),
      });
      expect(opened.status).toBe(201);
      expect(opened.body).toEqual({ windowId: expect.any(String), state: 'open', phase: 'executing' });
      const windowId = String(opened.body.windowId);

      const read = await call(target, 'gateway', 'GET', `/internal/v1/windows/${windowId}`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual(expect.objectContaining({ windowId, state: 'open', units: [LEGACY_UNIT], outcome: 'pending' }));

      const completed = await call(target, 'gateway', 'POST', `/internal/v1/windows/${windowId}:complete`, { forwarded: true, legacyStatus: 200 });
      expect(completed).toEqual({ status: 200, body: { state: 'closed' } });
      expect(await allLeases()).toEqual([]);
    });

    it('answers a refused open with the legacy 503 before legacy executes anything', async () => {
      const h = await harness();
      const { app: target, identity } = await composed(h);
      identity.failNext('gate', 'down');

      const refused = await call(target, 'gateway', 'POST', '/internal/v1/windows', {
        routeKey: 'admin:cusers.update',
        units: [TARGET_UNIT],
        scope: { keys: { siteid: 'tenant-a' } },
        requestId: cfUuid(),
      });

      expect(refused.status).toBe(503);
      expect(refused.body).toEqual(expect.objectContaining({ error: expect.any(Object) }));
      expect(identity.gates.get(TARGET_UNIT)).toEqual(expect.objectContaining({ state: 'open', holderId: null }));
      expect(await allLeases()).toEqual([]);
      expect((await storedWindows()).map((row) => row.state)).toEqual(['failed']);
      expect(h.t.bridge?.calls).toEqual([]);
      expect(h.t.legacy.statements).toEqual([]);
    });

    it('resolves an import-pending window for the platform operator and answers 404 for an unknown one', async () => {
      // No unit is target-authoritative under the fixture v0001, so the composed service, which reads the committed catalog, resolves without an import.
      const h = await harness({ active: 'v0001', restart: 'unavailable' });
      const opened = await h.service.open(rosterRequest());
      await claimReleased(opened.windowId);
      h.t.clock.advance(gatewayLeaseMs);
      await h.service.runRecoveryPass();
      expect((await storedWindow(opened.windowId)).state).toBe('import-pending');
      const { app: target } = await composed(h);

      const resolved = await call(target, 'operator', 'POST', `/internal/v1/windows/${opened.windowId}:resolve`);
      expect(resolved.status).toBe(200);
      expect(resolved.body).toEqual(expect.objectContaining({ windowId: opened.windowId, state: 'closed', outcome: 'resolved' }));
      expect(await allLeases()).toEqual([]);

      const unknown = cfUuid();
      expect((await call(target, 'operator', 'POST', `/internal/v1/windows/${unknown}:resolve`)).status).toBe(404);
      expect((await call(target, 'gateway', 'GET', `/internal/v1/windows/${unknown}`)).status).toBe(404);
    });
  });
});
