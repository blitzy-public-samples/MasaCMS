// Unit tests for reload windows and the start-up guard freeze, lock and runner, over a gateway double and a loopback legacy.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import { GatewayWaitTimeoutError, loadVersion, type CutoverEntry } from '../../src/cutover/index.js';
import { loadUnitCatalog, type Unit } from '../../src/owners/units.js';
import type { StartupGuardRunner } from '../../src/reverse/projector.js';
import type { WindowLifecycle } from '../../src/windows/legacy-steps.js';
import {
  RELOAD_ROUTE_KEY,
  RELOAD_WINDOW_KIND,
  StartupGuardBusyError,
  contentUnits,
  createStartupGuardRunner,
  drainExclusions,
  freezeLegacyBound,
  reloadKey,
  runReloadWindowWith,
  sendReloadRequest,
  tryGuardLock,
  unfreezeLegacyBound,
  withGuardLock,
  type FrozenRoutes,
  type GuardRunnerContext,
  type ReloadWindowResult,
} from '../../src/windows/reload.js';
import { createCallLog, createGatewayDouble, type CallLog, type GatewayDoubleOptions } from '../helpers/gateway-double.js';

const CONFIG = loadConfig();
const CATALOG = loadUnitCatalog(CONFIG.paths.tableOwnership);
const VERSION = 'v0099';
const WINDOW_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const BUDGET = { timeoutMs: CONFIG.transition.freezeAckTimeoutMs, intervalMs: 250 };

const entry = (route: string, state: CutoverEntry['state'], kind: CutoverEntry['kind'], units: string[]): CutoverEntry => ({
  route,
  owningService: 'strategies-content',
  tableVersion: VERSION,
  state,
  kind,
  group: null,
  units,
  disposition: state === 'target' ? 'carry' : 'legacy-served',
});

const ENTRIES = [
  entry('admin:carch.list', 'legacy', 'read', ['content.content']),
  entry('reload:application', 'legacy', 'legacy-write', ['content.content']),
  entry('admin:cusers.update{type=2,action=delete}', 'legacy', 'legacy-write', ['identity.user_account', 'people.person']),
  entry('page:render', 'legacy', 'legacy-write', ['reporting.session_tracking']),
  entry('admin:csettings.list', 'target', 'read', ['programs_sites.site']),
];
const LEGACY_BOUND = ENTRIES.filter((item) => item.state === 'legacy')
  .map((item) => item.route)
  .sort();

let cutoverDir: string;
let legacy: Server;
let legacyOrigin: string;
let closedOrigin: string;
const received: { method: string | undefined; url: string | undefined }[] = [];
let legacyStatus = 200;
let legacyLocation: string | undefined;

beforeAll(async () => {
  cutoverDir = mkdtempSync(path.join(os.tmpdir(), 'windows-reload-'));
  mkdirSync(path.join(cutoverDir, 'versions'));
  writeFileSync(
    path.join(cutoverDir, 'versions', `${VERSION}.json`),
    JSON.stringify({ tableVersion: VERSION, previous: null, groupAuthority: {}, rollbackRefs: [], entries: ENTRIES }),
  );

  legacy = createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    res.writeHead(legacyStatus, legacyLocation === undefined ? {} : { location: legacyLocation });
    res.end('<html>reloaded</html>');
  });
  await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));
  legacyOrigin = `http://127.0.0.1:${String((legacy.address() as AddressInfo).port)}`;

  // A port that was just released refuses connections, standing in for a legacy origin that is down.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedOrigin = `http://127.0.0.1:${String((probe.address() as AddressInfo).port)}`;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  legacy.closeAllConnections();
  await new Promise<void>((resolve) => legacy.close(() => resolve()));
  rmSync(cutoverDir, { recursive: true, force: true });
});

beforeEach(() => {
  received.length = 0;
  legacyStatus = 200;
  legacyLocation = undefined;
});

const config = (): MigrationContext['config'] => ({ ...CONFIG, paths: { ...CONFIG.paths, cutoverDir } });

const env = (overrides: Partial<MigrationContext['env']> = {}): MigrationContext['env'] =>
  ({ LEGACY_ORIGIN: legacyOrigin, MURA_APPRELOADKEY: undefined, ...overrides }) as MigrationContext['env'];

/** Legacy database whose live pool counts `rows()` matching rows, appending `count` to `log` on each count. */
function fakeLegacy(rows: () => number | Promise<number>, log?: CallLog): MigrationContext['legacy'] {
  const pool = {
    request: () => ({
      query: async () => {
        log?.append('legacy', 'count');
        return { recordset: [{ n: await rows() }] };
      },
    }),
  };
  return { live: async () => pool } as unknown as MigrationContext['legacy'];
}

/** Clock and sleep under which each poll pause advances time at once. */
function instantTime() {
  let now = Date.parse('2026-06-30T12:00:00.000Z');
  return {
    clock: { now: () => new Date(now) },
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function gatewayDouble(opts: GatewayDoubleOptions = {}) {
  return createGatewayDouble({ active: VERSION, epoch: 5, ...instantTime(), ...opts });
}

function lifecycleFake(log?: CallLog, overrides: Partial<WindowLifecycle> = {}) {
  const open = vi.fn<WindowLifecycle['open']>(
    overrides.open ??
      (async (request, opts) => {
        log?.append('window', 'open', { request, opts });
        return { windowId: WINDOW_ID, state: 'open', phase: 'executing' };
      }),
  );
  const complete = vi.fn<WindowLifecycle['complete']>(
    overrides.complete ??
      (async (windowId, request) => {
        log?.append('window', 'complete', { windowId, request });
        return { state: 'closed' };
      }),
  );
  return { open, complete, lifecycle: { open, complete } satisfies WindowLifecycle };
}

describe('reloadKey', () => {
  it.each([
    ['the configured Masa default', undefined, 'appreload'],
    ['MURA_APPRELOADKEY, which Masa reads over its settings', 'FIXTURE-reloadkey', 'FIXTURE-reloadkey'],
  ])('uses %s', (_label, variable, expected) => {
    expect(reloadKey(CONFIG, { MURA_APPRELOADKEY: variable })).toBe(expected);
  });
});

describe('contentUnits', () => {
  it('returns the sorted content units of the catalog', () => {
    const units: readonly Unit[] = [
      { id: 'people.person', owner: 'people', schema: 'people', legacyTables: ['tusers'] },
      { id: 'content.file', owner: 'strategies-content', schema: 'content', legacyTables: ['tfiles'] },
      { id: 'content.content', owner: 'strategies-content', schema: 'content', legacyTables: ['tcontent'] },
      { id: 'contents.other', owner: 'strategies-content', schema: 'contents', legacyTables: [] },
    ];
    const catalog = { units: () => units };
    expect(contentUnits(catalog)).toEqual(['content.content', 'content.file']);
  });

  it('covers the strategies-content units of the ownership file', () => {
    const owned = CATALOG.unitsOfOwner('strategies-content').map((unit) => unit.id);
    expect(contentUnits(CATALOG)).toEqual([...owned].sort());
    expect(owned.length).toBeGreaterThan(0);
  });
});

describe('sendReloadRequest', () => {
  it('sends one GET of /?appreload without a method parameter and returns any status', async () => {
    legacyStatus = 500;
    await expect(sendReloadRequest({ env: env(), config: CONFIG })).resolves.toEqual({ status: 500 });
    expect(received).toEqual([{ method: 'GET', url: '/?appreload' }]);
    expect(new URL(received[0]?.url ?? '', legacyOrigin).searchParams.has('method')).toBe(false);
  });

  it('encodes the environment key and does not follow a redirect into a second reload', async () => {
    legacyStatus = 301;
    legacyLocation = `${legacyOrigin}/?FIXTURE%20key`;
    await expect(sendReloadRequest({ env: env({ MURA_APPRELOADKEY: 'FIXTURE key' }), config: CONFIG })).resolves.toEqual({ status: 301 });
    expect(received).toEqual([{ method: 'GET', url: '/?FIXTURE%20key' }]);
  });

  it('throws when legacy cannot be reached', async () => {
    await expect(sendReloadRequest({ env: env({ LEGACY_ORIGIN: closedOrigin }), config: CONFIG })).rejects.toThrow();
  });
});

describe('runReloadWindowWith', () => {
  it('opens a reload window on every content unit, reloads, completes it and counts the rows left', async () => {
    const log = createCallLog();
    const { lifecycle, open, complete } = lifecycleFake(log);
    const ctx = { env: env(), config: CONFIG, catalog: CATALOG, legacy: fakeLegacy(() => 0, log) };

    await expect(runReloadWindowWith(ctx, lifecycle)).resolves.toEqual({
      windowId: WINDOW_ID,
      legacyStatus: 200,
      windowState: 'closed',
      startupRowsRemaining: 0,
    } satisfies ReloadWindowResult);
    expect(open).toHaveBeenCalledWith(
      { routeKey: RELOAD_ROUTE_KEY, units: contentUnits(CATALOG), scope: { table: true }, requestId: expect.any(String) },
      { kind: RELOAD_WINDOW_KIND },
    );
    expect(RELOAD_WINDOW_KIND).toBe('reload');
    expect(complete).toHaveBeenCalledWith(WINDOW_ID, { forwarded: true, legacyStatus: 200 });
    expect(received).toHaveLength(1);
    expect(log.ops()).toEqual(['open', 'complete', 'count']);
  });

  it('reports the rows still matching and the window state the completion returned', async () => {
    const { lifecycle } = lifecycleFake(undefined, { complete: async () => ({ state: 'import-pending' }) });
    const ctx = { env: env(), config: CONFIG, catalog: CATALOG, legacy: fakeLegacy(() => 4) };
    await expect(runReloadWindowWith(ctx, lifecycle)).resolves.toMatchObject({ windowState: 'import-pending', startupRowsRemaining: 4 });
  });

  it('sends nothing when the window is refused', async () => {
    const refusal = new Error('window refused');
    const { lifecycle, complete } = lifecycleFake(undefined, { open: async () => Promise.reject(refusal) });
    const ctx = { env: env(), config: CONFIG, catalog: CATALOG, legacy: fakeLegacy(() => 0) };
    await expect(runReloadWindowWith(ctx, lifecycle)).rejects.toBe(refusal);
    expect(received).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('completes the window after a transport failure, then rethrows it', async () => {
    const { lifecycle, complete } = lifecycleFake();
    const ctx = { env: env({ LEGACY_ORIGIN: closedOrigin }), config: CONFIG, catalog: CATALOG, legacy: fakeLegacy(() => 0) };
    await expect(runReloadWindowWith(ctx, lifecycle)).rejects.toThrow();
    expect(complete).toHaveBeenCalledWith(WINDOW_ID, { forwarded: true });
  });

  it('throws both failures when the transport and the completion fail', async () => {
    const completion = new Error('complete failed');
    const { lifecycle } = lifecycleFake(undefined, { complete: async () => Promise.reject(completion) });
    const ctx = { env: env({ LEGACY_ORIGIN: closedOrigin }), config: CONFIG, catalog: CATALOG, legacy: fakeLegacy(() => 0) };
    const error = await runReloadWindowWith(ctx, lifecycle).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[1]).toBe(completion);
  });

  it('rethrows a completion failure after a successful reload', async () => {
    const completion = new Error('complete failed');
    const { lifecycle } = lifecycleFake(undefined, { complete: async () => Promise.reject(completion) });
    const ctx = { env: env(), config: CONFIG, catalog: CATALOG, legacy: fakeLegacy(() => 0) };
    await expect(runReloadWindowWith(ctx, lifecycle)).rejects.toBe(completion);
  });
});

describe('freezeLegacyBound', () => {
  it('freezes exactly the legacy-bound entries of the active version and drains all but the excepted ones', async () => {
    const gateway = gatewayDouble();
    const frozen = await freezeLegacyBound({ gateway, config: config() }, { exceptRoutes: ['reload:application'] });

    expect(frozen).toEqual({ routes: LEGACY_BOUND, epoch: 6 });
    expect([...gateway.frozen].sort()).toEqual(LEGACY_BOUND);
    expect(gateway.calls).toEqual([
      { op: 'status', args: undefined },
      { op: 'freeze', args: { routes: LEGACY_BOUND } },
      { op: 'awaitEpoch', args: { epoch: 6, budget: BUDGET } },
      { op: 'awaitInflightDrained', args: { routes: LEGACY_BOUND.filter((route) => route !== 'reload:application'), budget: BUDGET } },
    ]);
  });

  it('does not wait for an in-flight request on an excepted route', async () => {
    const gateway = gatewayDouble();
    gateway.addInflight({ instance: 'gw-1', requestId: 'r-own', route: 'reload:application', side: 'legacy', startedAt: 0 });
    await expect(freezeLegacyBound({ gateway, config: config() }, { exceptRoutes: ['reload:application'] })).resolves.toMatchObject({
      routes: LEGACY_BOUND,
    });
  });

  it('leaves routes another holder froze to it, while still draining them', async () => {
    const gateway = gatewayDouble();
    await gateway.freeze(['admin:carch.list']);
    gateway.calls.length = 0;

    const frozen = await freezeLegacyBound({ gateway, config: config() });
    expect(frozen.routes).toEqual(LEGACY_BOUND.filter((route) => route !== 'admin:carch.list'));
    expect(gateway.calls.at(-1)).toEqual({ op: 'awaitInflightDrained', args: { routes: LEGACY_BOUND, budget: BUDGET } });

    await unfreezeLegacyBound({ gateway, config: config() }, frozen);
    expect([...gateway.frozen]).toEqual(['admin:carch.list']);
  });

  it('calls no freeze when every legacy-bound entry is already frozen', async () => {
    const gateway = gatewayDouble();
    await gateway.freeze(LEGACY_BOUND);
    gateway.calls.length = 0;
    await expect(freezeLegacyBound({ gateway, config: config() })).resolves.toEqual({ routes: [], epoch: 6 });
    expect(gateway.calls.map((call) => call.op)).toEqual(['status', 'awaitEpoch', 'awaitInflightDrained']);
  });

  it('freezes nothing before a version is active', async () => {
    const gateway = gatewayDouble({ active: null });
    await expect(freezeLegacyBound({ gateway, config: config() })).resolves.toEqual({ routes: [], epoch: 5 });
    expect(gateway.calls.map((call) => call.op)).toEqual(['status']);
  });

  it('unfreezes what it froze when the in-flight drain times out', async () => {
    const gateway = gatewayDouble();
    gateway.addInflight({ instance: 'gw-1', requestId: 'r-1', route: 'admin:carch.list', side: 'legacy', startedAt: 0 });
    await expect(freezeLegacyBound({ gateway, config: config() })).rejects.toBeInstanceOf(GatewayWaitTimeoutError);
    expect(gateway.frozen.size).toBe(0);
    expect(gateway.calls.at(-1)).toEqual({ op: 'unfreeze', args: { routes: LEGACY_BOUND } });
  });

  it('unfreezes what it froze when an instance never acknowledges the freeze', async () => {
    const gateway = gatewayDouble({ instances: ['gw-1', 'gw-2'], manualAck: ['gw-2'] });
    const error = await freezeLegacyBound({ gateway, config: config() }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'epoch', epoch: 6 });
    expect(gateway.frozen.size).toBe(0);
  });

  it('keeps an already-frozen set untouched when its wait fails', async () => {
    const gateway = gatewayDouble();
    await gateway.freeze(LEGACY_BOUND);
    gateway.addInflight({ instance: 'gw-1', requestId: 'r-1', route: 'page:render', side: 'legacy', startedAt: 0 });
    await expect(freezeLegacyBound({ gateway, config: config() })).rejects.toBeInstanceOf(GatewayWaitTimeoutError);
    expect([...gateway.frozen].sort()).toEqual(LEGACY_BOUND);
  });

  it('throws both failures when unfreezing after a failed wait fails', async () => {
    const gateway = gatewayDouble();
    gateway.addInflight({ instance: 'gw-1', requestId: 'r-1', route: 'admin:carch.list', side: 'legacy', startedAt: 0 });
    const unfreezeFailure = new Error('gateway down');
    gateway.failNext('unfreeze', unfreezeFailure);
    const error = await freezeLegacyBound({ gateway, config: config() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBeInstanceOf(GatewayWaitTimeoutError);
    expect((error as AggregateError).errors[1]).toBe(unfreezeFailure);
  });

  it.each([
    { name: 'the legacy-bound routes of the active version', active: VERSION, routes: LEGACY_BOUND, frozenEpoch: 6 },
    { name: 'no route before a version is active', active: null, routes: [], frozenEpoch: 5 },
  ])('hands beforeFreeze $name, with the epoch before the freeze, before freezing anything', async ({ active, routes, frozenEpoch }) => {
    const gateway = gatewayDouble({ active });
    const recorded: { planned: FrozenRoutes; ops: string[] }[] = [];
    const beforeFreeze = async (planned: FrozenRoutes): Promise<void> => {
      recorded.push({ planned, ops: gateway.calls.map((call) => call.op) });
    };
    await expect(freezeLegacyBound({ gateway, config: config() }, { beforeFreeze })).resolves.toEqual({ routes, epoch: frozenEpoch });
    expect(recorded).toEqual([{ planned: { routes, epoch: 5 }, ops: ['status'] }]);
  });

  it('freezes nothing and rethrows when beforeFreeze fails', async () => {
    const gateway = gatewayDouble();
    const failure = new Error('freeze record failed');
    await expect(freezeLegacyBound({ gateway, config: config() }, { beforeFreeze: async () => Promise.reject(failure) })).rejects.toBe(failure);
    expect(gateway.calls.map((call) => call.op)).toEqual(['status']);
    expect(gateway.frozen.size).toBe(0);
  });
});

describe('unfreezeLegacyBound', () => {
  it('unfreezes the frozen routes and waits for their epoch', async () => {
    const gateway = gatewayDouble();
    const frozen = await freezeLegacyBound({ gateway, config: config() });
    gateway.calls.length = 0;
    await unfreezeLegacyBound({ gateway, config: config() }, frozen);
    expect(gateway.calls).toEqual([
      { op: 'unfreeze', args: { routes: LEGACY_BOUND } },
      { op: 'awaitEpoch', args: { epoch: 7, budget: BUDGET } },
    ]);
    expect(gateway.frozen.size).toBe(0);
  });

  it('calls nothing for an empty freeze', async () => {
    const gateway = gatewayDouble();
    await unfreezeLegacyBound({ gateway, config: config() }, { routes: [], epoch: 5 });
    expect(gateway.calls).toEqual([]);
  });
});

describe('drainExclusions', () => {
  it("names the window's own route and the legacy-write entries touching its leased units", () => {
    const version = loadVersion(cutoverDir, VERSION);
    expect(drainExclusions(version, 'admin:cusers.update{type=2,action=delete}', ['content.content', 'people.person'])).toEqual([
      'admin:cusers.update{type=2,action=delete}',
      'reload:application',
    ]);
    expect(drainExclusions(version, 'sitemonitor:run', [])).toEqual(['sitemonitor:run']);
  });
});

describe('guard lock', () => {
  it('serialises holders and refuses a try while held', async () => {
    const events: string[] = [];
    let release = (): void => undefined;
    const first = withGuardLock(async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push('first:end');
      return 1;
    });
    const second = withGuardLock(async () => {
      events.push('second');
      return 2;
    });
    await expect(tryGuardLock(async () => 3)).resolves.toEqual({ ran: false });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
    await expect(tryGuardLock(async () => 3)).resolves.toEqual({ ran: true, value: 3 });
  });

  it('releases the lock after a holder rejects', async () => {
    const failure = new Error('holder failed');
    await expect(withGuardLock(async () => Promise.reject(failure))).rejects.toBe(failure);
    await expect(tryGuardLock(async () => 'next')).resolves.toEqual({ ran: true, value: 'next' });
  });
});

describe('createStartupGuardRunner', () => {
  const RELOADED: ReloadWindowResult = { windowId: WINDOW_ID, legacyStatus: 200, windowState: 'closed', startupRowsRemaining: 0 };
  const GUARD_STEPS: ReadonlySet<string> = new Set(['freeze', 'commit', 'reload', 'count', 'unfreeze', 'sleep']);

  interface RunnerOptions {
    /** Matching rows the caller's scope counts. */
    rows?: number;
    /** Live predicate counts, one per count in order, then 0. */
    liveCounts?: number[];
    /** Answers each live predicate count instead of `liveCounts`. */
    liveCount?: () => Promise<number>;
    /** Result of the reload window by attempt, numbered from 1; `RELOADED` by default. */
    reload?: (attempt: number) => Promise<ReloadWindowResult>;
    commit?: () => Promise<void>;
    /** Runs during each retry pause. */
    onSleep?: () => Promise<void>;
    /** Log shared with another runner's harness. */
    log?: CallLog;
    /** Gateway shared with another runner's harness. */
    gateway?: ReturnType<typeof gatewayDouble>;
  }

  /** A promise resolved by `open`. */
  function latch() {
    let open = (): void => undefined;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      opened,
      open: () => {
        open();
      },
    };
  }

  function runnerHarness(opts: RunnerOptions = {}) {
    const log = opts.log ?? createCallLog();
    const gateway = opts.gateway ?? gatewayDouble({ log });
    const commit = vi.fn(opts.commit ?? (async () => log.append('caller', 'commit')));
    let attempts = 0;
    const reload = vi.fn(async () => {
      attempts += 1;
      log.append('caller', 'reload');
      return opts.reload === undefined ? RELOADED : opts.reload(attempts);
    });
    const liveCounts = [...(opts.liveCounts ?? [])];
    const warn = vi.fn();
    const sleeps: { ms: number; frozen: string[] }[] = [];
    const ctx: GuardRunnerContext = {
      gateway,
      config: config(),
      legacy: fakeLegacy(opts.liveCount ?? (() => liveCounts.shift() ?? 0), log),
      logger: { warn } as unknown as GuardRunnerContext['logger'],
    };
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push({ ms, frozen: [...gateway.frozen].sort() });
      log.append('runner', 'sleep');
      await opts.onSleep?.();
    };
    const runner = createStartupGuardRunner(ctx, reload, { sleep });
    const scope = fakeLegacy(() => opts.rows ?? 0);
    return {
      log,
      gateway,
      commit,
      reload,
      runner,
      warn,
      sleeps,
      /** The guard's steps in call order. */
      steps: () => log.ops().filter((op) => GUARD_STEPS.has(op)),
      scope: async () => (await scope.live()) as unknown as Parameters<typeof runner.run>[1],
    };
  }

  it('fits the projector runner', () => {
    const projectorRunner: StartupGuardRunner = runnerHarness().runner;
    expect(typeof projectorRunner.run).toBe('function');
  });

  it('only commits when the scope has no matching row', async () => {
    const { runner, commit, reload, gateway, scope } = runnerHarness({ rows: 0 });
    await expect(runner.run(commit, await scope())).resolves.toEqual({ guarded: false, count: 0 });
    await runner.settled();
    expect(commit).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(gateway.calls).toEqual([]);
  });

  it.each([
    ['a caller that found the rows', undefined, { guarded: true, count: null }],
    ['a scope with matching rows', 3, { guarded: true, count: 3 }],
  ])('returns once %s has committed under the freeze, then reloads, counts and unfreezes without it', async (_label, rows, outcome) => {
    const reloading = latch();
    const h = runnerHarness({
      rows,
      reload: async () => {
        await reloading.opened;
        return RELOADED;
      },
    });
    await expect(h.runner.run(h.commit, rows === undefined ? undefined : await h.scope())).resolves.toEqual(outcome);
    expect(h.steps()).toEqual(['freeze', 'commit', 'reload']);
    expect([...h.gateway.frozen].sort()).toEqual(LEGACY_BOUND);

    reloading.open();
    await h.runner.settled();
    expect(h.steps()).toEqual(['freeze', 'commit', 'reload', 'count', 'unfreeze']);
    expect(h.gateway.frozen.size).toBe(0);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a caller that found the rows', undefined, null],
    ['a scope with matching rows', 2, 2],
  ])('lets %s join the held freeze while its reload runs, and counts that commit before unfreezing', async (_label, rows, count) => {
    const reloading = latch();
    const h = runnerHarness({
      rows,
      reload: async () => {
        await reloading.opened;
        return RELOADED;
      },
    });
    await h.runner.run(h.commit);
    await expect(h.runner.run(h.commit, rows === undefined ? undefined : await h.scope())).resolves.toEqual({ guarded: true, count });
    expect(h.steps()).toEqual(['freeze', 'commit', 'reload', 'commit']);

    reloading.open();
    await h.runner.settled();
    expect(h.steps()).toEqual(['freeze', 'commit', 'reload', 'commit', 'count', 'unfreeze']);
    expect(h.gateway.calls.filter((call) => call.op === 'freeze')).toHaveLength(1);
    expect(h.gateway.frozen.size).toBe(0);
  });

  it.each<[string, RunnerOptions, ((h: ReturnType<typeof runnerHarness>) => void) | undefined, string[]]>([
    [
      'the reload window is refused',
      { reload: async (attempt) => (attempt === 1 ? Promise.reject(new Error('reload window refused')) : RELOADED) },
      undefined,
      ['freeze', 'commit', 'reload', 'sleep', 'reload', 'count', 'unfreeze'],
    ],
    ['rows still match after the reload', { liveCounts: [2] }, undefined, ['freeze', 'commit', 'reload', 'count', 'sleep', 'reload', 'count', 'unfreeze']],
    [
      'unfreezing fails',
      {},
      (h) => {
        h.gateway.failNext('unfreeze', new Error('gateway down'));
      },
      ['freeze', 'commit', 'reload', 'count', 'unfreeze', 'sleep', 'reload', 'count', 'unfreeze'],
    ],
  ])('keeps the freeze and retries at the import-retry cadence when %s', async (_label, opts, setup, steps) => {
    const h = runnerHarness(opts);
    setup?.(h);
    await h.runner.run(h.commit);
    await h.runner.settled();
    expect(h.steps()).toEqual(steps);
    expect(h.sleeps).toEqual([{ ms: CONFIG.windows.importRetryMs, frozen: LEGACY_BOUND }]);
    expect(h.warn).toHaveBeenCalledOnce();
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.gateway.frozen.size).toBe(0);
  });

  it('freezes again for a commit made after an unfreeze whose answer was lost, and lifts both', async () => {
    let duringSleep = (): Promise<void> => Promise.resolve();
    const h = runnerHarness({ onSleep: () => duringSleep() });
    const unfreeze = h.gateway.unfreeze.bind(h.gateway);
    h.gateway.unfreeze = async (routes) => {
      h.gateway.unfreeze = unfreeze;
      await unfreeze(routes);
      throw new Error('unfreeze answer lost');
    };
    duringSleep = async () => {
      duringSleep = () => Promise.resolve();
      await h.runner.run(h.commit);
    };

    await h.runner.run(h.commit);
    await h.runner.settled();
    expect(h.steps()).toEqual(['freeze', 'commit', 'reload', 'count', 'unfreeze', 'sleep', 'freeze', 'commit', 'reload', 'count', 'unfreeze']);
    expect(h.sleeps).toEqual([{ ms: CONFIG.windows.importRetryMs, frozen: [] }]);
    expect(h.gateway.frozen.size).toBe(0);
  });

  it('unfreezes and rethrows when the commit fails', async () => {
    const failure = new Error('commit failed');
    const { runner, commit, gateway, reload } = runnerHarness({ commit: async () => Promise.reject(failure) });
    await expect(runner.run(commit)).rejects.toBe(failure);
    await runner.settled();
    expect(reload).not.toHaveBeenCalled();
    expect(gateway.frozen.size).toBe(0);
  });

  it('throws both failures when unfreezing after a failed commit fails', async () => {
    const failure = new Error('commit failed');
    const unfreezeFailure = new Error('gateway down');
    const { runner, commit, gateway, reload } = runnerHarness({ commit: async () => Promise.reject(failure) });
    gateway.failNext('unfreeze', unfreezeFailure);
    const error = await runner.run(commit).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([failure, unfreezeFailure]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("never interleaves two runners' freezes and commits", async () => {
    const log = createCallLog();
    const committing = latch();
    const slow = runnerHarness({
      log,
      commit: async () => {
        log.append('slow', 'commit');
        await committing.opened;
      },
    });
    const fast = runnerHarness({ log, commit: () => Promise.resolve(log.append('fast', 'commit')) });
    const first = slow.runner.run(slow.commit);
    await vi.waitFor(() => expect(log.ops()).toContain('commit'));
    const second = fast.runner.run(fast.commit);
    await expect(tryGuardLock(() => Promise.resolve('probe'))).resolves.toEqual({ ran: false });
    expect(log.ops('fast')).toEqual([]);

    committing.open();
    await Promise.all([first, second]);
    await Promise.all([slow.runner.settled(), fast.runner.settled()]);
    expect(log.indexOf('slow', 'commit')).toBeLessThan(log.indexOf('fast', 'commit'));
    expect(slow.gateway.frozen.size + fast.gateway.frozen.size).toBe(0);
  });

  it("keeps another runner's freeze and commit out of the span between its final count and unfreeze", async () => {
    const log = createCallLog();
    const counting = latch();
    const first = runnerHarness({
      log,
      liveCount: async () => {
        await counting.opened;
        return 0;
      },
    });
    await first.runner.run(first.commit);
    await vi.waitFor(() => expect(first.steps()).toEqual(['freeze', 'commit', 'reload', 'count']));
    const second = runnerHarness({ log });
    const late = second.runner.run(second.commit);
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.steps()).toEqual(['freeze', 'commit', 'reload', 'count']);

    counting.open();
    await late;
    await Promise.all([first.runner.settled(), second.runner.settled()]);
    expect(first.steps()).toEqual(['freeze', 'commit', 'reload', 'count', 'unfreeze', 'freeze', 'commit', 'reload', 'count', 'unfreeze']);
  });

  it.each([
    ['a caller that found the rows', undefined, { guarded: true, count: null }],
    ['a scope with matching rows', 1, { guarded: true, count: 1 }],
  ])('lets %s join the freeze another runner on the same gateway holds, and freezes again for a commit after it lifts', async (_label, rows, outcome) => {
    const log = createCallLog();
    let live = 0;
    const liveCount = () => Promise.resolve(live);
    const commit = async () => {
      log.append('caller', 'commit');
      live = 1;
    };
    const reloads = [latch(), latch()] as const;
    // The first reload window converts only the rows committed before it, so the joined commit's row needs a second one.
    const first = runnerHarness({
      log,
      liveCount,
      commit,
      reload: async (attempt) => {
        await reloads[0].opened;
        if (attempt > 1) live = 0;
        return RELOADED;
      },
    });
    const second = runnerHarness({
      log,
      liveCount,
      commit,
      rows,
      gateway: first.gateway,
      reload: async () => {
        await reloads[1].opened;
        live = 0;
        return RELOADED;
      },
    });
    const gateway = first.gateway;

    await first.runner.run(first.commit);
    await expect(second.runner.run(second.commit, rows === undefined ? undefined : await second.scope())).resolves.toEqual(outcome);
    expect([...gateway.frozen].sort()).toEqual(LEGACY_BOUND);

    reloads[0].open();
    await first.runner.settled();
    expect(gateway.frozen.size).toBe(0);
    await second.runner.run(second.commit);
    expect(live).toBe(1);
    expect([...gateway.frozen].sort()).toEqual(LEGACY_BOUND);

    reloads[1].open();
    await Promise.all([first.runner.settled(), second.runner.settled()]);
    expect(first.steps()).toEqual([
      ...['freeze', 'commit', 'reload', 'commit', 'count', 'sleep', 'reload', 'count', 'unfreeze'],
      ...['freeze', 'commit', 'reload', 'count', 'unfreeze'],
    ]);
    expect(first.sleeps).toEqual([{ ms: CONFIG.windows.importRetryMs, frozen: LEGACY_BOUND }]);
    expect(gateway.calls.filter((call) => call.op === 'freeze' || call.op === 'unfreeze')).toEqual(
      ['freeze', 'unfreeze', 'freeze', 'unfreeze'].map((op) => ({ op, args: { routes: LEGACY_BOUND } })),
    );
    expect(first.reload).toHaveBeenCalledTimes(2);
    expect(second.reload).toHaveBeenCalledOnce();
    expect(gateway.frozen.size).toBe(0);
  });

  it.each([
    ['another guard sequence holds the lock', 'lock'],
    ['a commit joining the held freeze runs', 'join'],
  ])('refuses a scope with matching rows while %s', async (_label, holder) => {
    const released = latch();
    const reloading = latch();
    const h = runnerHarness({
      rows: 1,
      reload: async () => {
        await reloading.opened;
        return RELOADED;
      },
    });
    let held: Promise<unknown>;
    if (holder === 'lock') held = withGuardLock(() => released.opened);
    else {
      await h.runner.run(h.commit);
      held = h.runner.run(() => released.opened);
    }
    const commit = vi.fn(() => Promise.resolve());
    const error = await h.runner.run(commit, await h.scope()).catch((caught: unknown) => caught);
    released.open();
    reloading.open();
    await Promise.all([held, h.runner.settled()]);
    expect(error).toBeInstanceOf(StartupGuardBusyError);
    expect((error as StartupGuardBusyError).count).toBe(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
