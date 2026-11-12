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
import { StartupGuardFrozenError } from '../../src/legacy/index.js';
import { loadUnitCatalog } from '../../src/owners/units.js';
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
function fakeLegacy(rows: () => number, log?: CallLog): MigrationContext['legacy'] {
  const pool = {
    request: () => ({
      query: async () => {
        log?.append('legacy', 'count');
        return { recordset: [{ n: rows() }] };
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
    const units = [{ id: 'people.person' }, { id: 'content.file' }, { id: 'content.content' }, { id: 'contents.other' }];
    const catalog = { units: () => units as ReturnType<typeof CATALOG.units> };
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

  function runnerHarness(opts: { rows?: number; reload?: () => Promise<ReloadWindowResult>; commit?: () => Promise<void> } = {}) {
    const log = createCallLog();
    const gateway = gatewayDouble({ log });
    const commit = vi.fn(opts.commit ?? (async () => log.append('caller', 'commit')));
    const reload = vi.fn(
      opts.reload ??
        (async () => {
          log.append('caller', 'reload');
          return RELOADED;
        }),
    );
    const runner = createStartupGuardRunner({ gateway, config: config(), legacy: fakeLegacy(() => 0) }, reload);
    const scope = fakeLegacy(() => opts.rows ?? 0);
    return { log, gateway, commit, reload, runner, scope: async () => (await scope.live()) as unknown as Parameters<typeof runner.run>[1] };
  }

  it('fits the projector runner', () => {
    const projectorRunner: StartupGuardRunner = runnerHarness().runner;
    expect(typeof projectorRunner.run).toBe('function');
  });

  it('only commits when the scope has no matching row', async () => {
    const { runner, commit, reload, gateway, scope } = runnerHarness({ rows: 0 });
    await expect(runner.run(commit, await scope())).resolves.toEqual({ guarded: false, count: 0 });
    expect(commit).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(gateway.calls).toEqual([]);
  });

  it('freezes, commits, reloads and unfreezes in order when the scope has matching rows', async () => {
    const { runner, commit, log, gateway, scope } = runnerHarness({ rows: 3 });
    await expect(runner.run(commit, await scope())).resolves.toEqual({ guarded: true, count: 3, reload: RELOADED });
    const ops = log.ops().filter((op) => ['freeze', 'commit', 'reload', 'unfreeze'].includes(op));
    expect(ops).toEqual(['freeze', 'commit', 'reload', 'unfreeze']);
    expect(gateway.frozen.size).toBe(0);
  });

  it('runs the guard sequence when the caller found the rows', async () => {
    const { runner, commit, log } = runnerHarness();
    await expect(runner.run(commit)).resolves.toEqual({ guarded: true, count: null, reload: RELOADED });
    expect(log.ops()).toContain('reload');
  });

  it('unfreezes and rethrows when the commit fails', async () => {
    const failure = new Error('commit failed');
    const { runner, commit, gateway, reload } = runnerHarness({ commit: async () => Promise.reject(failure) });
    await expect(runner.run(commit)).rejects.toBe(failure);
    expect(reload).not.toHaveBeenCalled();
    expect(gateway.frozen.size).toBe(0);
  });

  it.each([
    ['the reload window fails', async () => Promise.reject(new Error('reload window refused')), undefined],
    ['rows still match after the reload', async () => ({ ...RELOADED, startupRowsRemaining: 2 }), 2],
  ])('keeps the freeze after commit when %s', async (_label, reload, remaining) => {
    const { runner, commit, gateway } = runnerHarness({ reload });
    const error = await runner.run(commit).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupGuardFrozenError);
    expect((error as StartupGuardFrozenError).remaining).toBe(remaining);
    expect(commit).toHaveBeenCalledOnce();
    expect([...gateway.frozen].sort()).toEqual(LEGACY_BOUND);
  });

  it('never overlaps two guard sequences', async () => {
    const events: string[] = [];
    let release = (): void => undefined;
    const slow = runnerHarness({
      reload: async () => {
        events.push('slow:reload');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        events.push('slow:done');
        return RELOADED;
      },
    });
    const fast = runnerHarness({
      reload: async () => {
        events.push('fast:reload');
        return RELOADED;
      },
    });
    const first = slow.runner.run(async () => {
      events.push('slow:commit');
    });
    const second = fast.runner.run(async () => {
      events.push('fast:commit');
    });
    await vi.waitFor(() => expect(events).toContain('slow:reload'));
    await expect(tryGuardLock(async () => 'probe')).resolves.toEqual({ ran: false });
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['slow:commit', 'slow:reload', 'slow:done', 'fast:commit', 'fast:reload']);
  });

  it('refuses a scope with matching rows while another guard sequence holds the lock', async () => {
    let release = (): void => undefined;
    const held = withGuardLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { runner, commit, scope } = runnerHarness({ rows: 1 });
    const error = await runner.run(commit, await scope()).catch((caught: unknown) => caught);
    release();
    await held;
    expect(error).toBeInstanceOf(StartupGuardBusyError);
    expect((error as StartupGuardBusyError).count).toBe(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
