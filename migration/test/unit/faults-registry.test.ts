// Unit tests for the in-process fault registry, its projector and window hooks, and the CLI's fault client.
import type { Logger } from '@opt2/platform/logging';
import { fixedClock, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type LoadedMigrationConfig } from '../../src/config.js';
import type { MigrationContext, ServiceCaller } from '../../src/context.js';
import type { MigrationEnv } from '../../src/env.js';
import type { WindowHooks } from '../../src/windows/index.js';
import {
  FaultCallError,
  FaultInjectedError,
  FaultParamsError,
  REGISTRY_FAULT_NAMES,
  UnknownFaultError,
  createFaultRegistry,
  remoteFaults,
  type FaultRegistryDeps,
} from '../../src/faults/registry.js';

type RegistryContext = Pick<MigrationContext, 'config' | 'clock' | 'logger' | 'env'>;

const CONFIG = loadConfig();
const NOW = '2026-06-30T08:15:00.000Z';
const WINDOW_A = '6A1B2C3D-4E5F-4061-7283940516273849';
const WINDOW_B = '7B2C3D4E-5F60-4172-8394051627384950';
const INFO = { owner: 'people', tenantId: '9a7c1d52-1f4e-5d3a-8b6c-2e4f6a8b0c1d' };
// Free text no redaction pattern masks, so it reaches a log only if interpolated there.
const FREE_TEXT = ['Jane', 'Doe', 'salary', '91250'].join(' ');

interface LogCall {
  level: string;
  args: unknown[];
}

/** Logger recording every call's arguments. */
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

/** A registry over the real config with fake sleep and exit, in `OPT2_ENV=env`. */
function registryIn(env: MigrationEnv['OPT2_ENV'] = 'local', overrides: { config?: LoadedMigrationConfig; deps?: FaultRegistryDeps } = {}) {
  const logger = capturingLogger();
  const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  const exit = vi.fn<(code: number) => void>();
  const ctx: RegistryContext = {
    config: overrides.config ?? CONFIG,
    clock: fixedClock(NOW),
    logger,
    env: { OPT2_ENV: env } as MigrationEnv,
  };
  const registry = createFaultRegistry(ctx, overrides.deps ?? { sleep, exit });
  return { registry, logger, sleep, exit };
}

const messages = (logger: { calls: LogCall[] }): unknown[] => logger.calls.map((call) => call.args[0]);

/** The error `run` throws, or undefined. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFaultRegistry: set, clear and active', () => {
  it('arms faults with defaults applied, lists them by name, and disarms them', () => {
    const { registry, logger } = registryIn();
    expect(registry.active()).toEqual([]);

    const delay = registry.set('projector-delay');
    const window = registry.set('window-import-interrupted', { windowId: WINDOW_A });
    expect(delay).toEqual({ name: 'projector-delay', params: { delayMs: 3000 }, since: NOW });
    expect(window).toEqual({ name: 'window-import-interrupted', params: { windowId: WINDOW_A }, since: NOW });
    registry.set('projector-crash', { point: 'after-legacy-commit' });
    expect(registry.active().map((fault) => fault.name)).toEqual([...REGISTRY_FAULT_NAMES].sort());

    expect(registry.set('projector-delay', { delayMs: 50 }).params).toEqual({ delayMs: 50 });
    expect(registry.active()).toHaveLength(3);

    expect(registry.clear('projector-delay')).toBe(true);
    expect(registry.clear('projector-delay')).toBe(false);
    expect(registry.active().map((fault) => fault.name)).toEqual(['projector-crash', 'window-import-interrupted']);
    registry.set('window-import-interrupted');
    expect(messages(logger)).toEqual([
      'fault set projector-delay delayMs=3000',
      `fault set window-import-interrupted window ${WINDOW_A}`,
      'fault set projector-crash point=after-legacy-commit afterBatches=1',
      'fault set projector-delay delayMs=50',
      'fault cleared projector-delay',
      'fault set window-import-interrupted every window',
    ]);
  });

  it.each(['set', 'clear'] as const)('%s rejects an unknown name with UnknownFaultError (404)', (method) => {
    const { registry } = registryIn();
    const error = thrown(() => registry[method]('applier-killed-mid-batch'));
    expect(error).toBeInstanceOf(UnknownFaultError);
    expect(error).toMatchObject({ fault: 'applier-killed-mid-batch', statusCode: 404, name: 'UnknownFaultError' });
    expect((error as Error).message).toContain(REGISTRY_FAULT_NAMES.join(', '));
  });

  it.each([
    ['projector-delay', { delayMs: -1 }, 'delayMs'],
    ['projector-delay', { delayMs: 1.5 }, 'delayMs'],
    ['projector-delay', { delay: 10 }, '(root)'],
    ['projector-delay', 'fast', '(root)'],
    ['projector-crash', {}, 'point'],
    ['projector-crash', { point: 'before-legacy-commit' }, 'point'],
    ['projector-crash', { point: 'after-legacy-commit', afterBatches: 0 }, 'afterBatches'],
    ['window-import-interrupted', { windowId: '' }, 'windowId'],
    ['window-import-interrupted', { windowId: 7 }, 'windowId'],
    ['window-import-interrupted', { windowId: WINDOW_A.toLowerCase() }, 'windowId'],
    ['window-import-interrupted', { windowId: `${WINDOW_A} ${FREE_TEXT}` }, 'windowId'],
    ['window-import-interrupted', { windowId: FREE_TEXT }, 'windowId'],
  ])('set %s with %j fails with FaultParamsError (400) naming %s', (name, params, path) => {
    const { registry, logger } = registryIn();
    const error = thrown(() => registry.set(name, params));
    expect(error).toBeInstanceOf(FaultParamsError);
    expect(error).toMatchObject({ fault: name, statusCode: 400 });
    expect((error as FaultParamsError).issues.some((issue) => issue.startsWith(`${path}:`))).toBe(true);
    expect((error as FaultParamsError).message).not.toContain(FREE_TEXT);
    expect(registry.active()).toEqual([]);
    expect(logger.calls).toEqual([]);
  });

  it('refuses projector-crash outside OPT2_ENV=local, even with valid parameters', () => {
    const { registry } = registryIn('cloud');
    expect(() => registry.set('projector-crash', { point: 'after-legacy-commit' })).toThrow(
      expect.objectContaining({ fault: 'projector-crash', statusCode: 400, issues: ['local only (OPT2_ENV=cloud)'] }),
    );
    expect(registry.active()).toEqual([]);
    expect(registry.set('projector-delay').name).toBe('projector-delay');
  });

  it('fails to build without a configured projector-delay default', () => {
    const config = { ...CONFIG, faults: CONFIG.faults.filter((fault) => fault.name !== 'projector-delay') } as LoadedMigrationConfig;
    expect(() => registryIn('local', { config })).toThrow(/defaultDelayMs for projector-delay/);
  });
});

describe('projectorHooks', () => {
  it.each([
    [{}, 3000],
    [{ delayMs: 0 }, 0],
    [{ delayMs: 1500 }, 1500],
  ])('beforeBatch sleeps while projector-delay is armed with %j, for %i ms', async (params, expected) => {
    const { registry, sleep } = registryIn();
    const hooks = registry.projectorHooks();
    await hooks.beforeBatch?.();
    expect(sleep).not.toHaveBeenCalled();

    registry.set('projector-delay', params);
    await hooks.beforeBatch?.();
    expect(sleep).toHaveBeenCalledExactlyOnceWith(expected);

    registry.clear('projector-delay');
    await hooks.beforeBatch?.();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(registry.projectorHooks()).toBe(hooks);
  });

  it('beforeBatch uses the real timer by default', async () => {
    const { registry } = registryIn('local', { deps: {} });
    registry.set('projector-delay', { delayMs: 1 });
    await expect(registry.projectorHooks().beforeBatch?.()).resolves.toBeUndefined();
  });

  it('afterLegacyCommit exits with 137 at the configured batch only, counting a batch once across its parts', async () => {
    const { registry, exit, logger } = registryIn();
    const commit = (batchId: string) => registry.projectorHooks().afterLegacyCommit?.({ ...INFO, batchId });

    await commit('batch-0');
    registry.set('projector-crash', { point: 'after-legacy-commit', afterBatches: 2 });
    await commit('batch-1');
    await commit('batch-1');
    expect(exit).not.toHaveBeenCalled();
    await commit('batch-2');
    expect(exit).toHaveBeenCalledExactlyOnceWith(137);
    await commit('batch-2');
    await commit('batch-3');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(messages(logger)).toContain(`fault projector-crash exiting after the legacy commit of batch batch-2`);

    registry.set('projector-crash', { point: 'after-legacy-commit' });
    await commit('batch-4');
    expect(exit).toHaveBeenCalledTimes(2);

    registry.clear('projector-crash');
    await commit('batch-5');
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it('afterLegacyCommit calls process.exit by default', async () => {
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { registry } = registryIn('local', { deps: {} });
    registry.set('projector-crash', { point: 'after-legacy-commit' });
    await registry.projectorHooks().afterLegacyCommit?.({ ...INFO, batchId: 'batch-1' });
    expect(processExit).toHaveBeenCalledExactlyOnceWith(137);
  });
});

describe('windowHooks', () => {
  /** The record fields the hook reads, as the window service passes them. */
  const windowRecord = (windowId: string) => ({ windowId }) as Parameters<NonNullable<WindowHooks['beforeImport']>>[0];

  it('beforeImport throws FaultInjectedError for every window while armed without a windowId', async () => {
    const { registry } = registryIn();
    const hooks = registry.windowHooks();
    await expect(hooks.beforeImport?.(windowRecord(WINDOW_A), 1)).resolves.toBeUndefined();

    registry.set('window-import-interrupted');
    for (const windowId of [WINDOW_A, WINDOW_B]) {
      const attempt = hooks.beforeImport?.(windowRecord(windowId), 1);
      await expect(attempt).rejects.toBeInstanceOf(FaultInjectedError);
      await expect(attempt).rejects.toMatchObject({ fault: 'window-import-interrupted', name: 'FaultInjectedError' });
    }

    registry.clear('window-import-interrupted');
    await expect(hooks.beforeImport?.(windowRecord(WINDOW_A), 2)).resolves.toBeUndefined();
    expect(registry.windowHooks()).toBe(hooks);
  });

  it('beforeImport throws only for the armed windowId', async () => {
    const { registry } = registryIn();
    registry.set('window-import-interrupted', { windowId: WINDOW_A });
    const hooks = registry.windowHooks();
    await expect(hooks.beforeImport?.(windowRecord(WINDOW_A), 1)).rejects.toBeInstanceOf(FaultInjectedError);
    await expect(hooks.beforeImport?.(windowRecord(WINDOW_B), 1)).resolves.toBeUndefined();
    expect(new FaultInjectedError('window-import-interrupted')).not.toHaveProperty('statusCode');
  });
});

describe('remoteFaults', () => {
  /** A context whose `operator` client answers `answer` and records each request. */
  function answering(answer: Pick<ServiceResponse, 'status' | 'body'>) {
    const calls: ServiceRequest[] = [];
    const callers: ServiceCaller[] = [];
    const client: ServiceClient = {
      request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
        calls.push(req);
        return Promise.resolve({ headers: {}, ...answer } as ServiceResponse<T>);
      },
      close: () => Promise.resolve(),
    };
    const ctx: Pick<MigrationContext, 'env' | 'clientAs'> = {
      env: { OPT2_ENV: 'local' } as MigrationEnv,
      clientAs: (caller) => {
        callers.push(caller);
        return client;
      },
    };
    return { remote: remoteFaults(ctx), calls, callers };
  }

  it('sends faultSet as PUT with the FaultRequest body and faultClear as DELETE, as operator without a user token', async () => {
    const { remote, calls, callers } = answering({ status: 204, body: undefined });
    await expect(remote.set('projector-delay', { delayMs: 3000 })).resolves.toBeUndefined();
    await remote.set('window-import-interrupted');
    await expect(remote.clear('projector-delay')).resolves.toBeUndefined();

    expect(callers).toEqual(['operator', 'operator', 'operator']);
    expect(calls).toEqual([
      { service: 'migration', method: 'PUT', path: '/internal/v1/faults/projector-delay', json: { params: { delayMs: 3000 } }, userToken: null },
      { service: 'migration', method: 'PUT', path: '/internal/v1/faults/window-import-interrupted', json: { params: {} }, userToken: null },
      { service: 'migration', method: 'DELETE', path: '/internal/v1/faults/projector-delay', json: undefined, userToken: null },
    ]);
  });

  it.each([
    ['set', 'faultSet', 400],
    ['set', 'faultSet', 404],
    ['clear', 'faultClear', 404],
    ['clear', 'faultClear', 503],
  ] as const)('%s throws FaultCallError when %s answers HTTP %i', async (method, operation, status) => {
    const body = { apiversion: 'v1', method: 'faults', error: { type: 'x', message: 'refused' } };
    const { remote, calls } = answering({ status, body });
    const call = method === 'set' ? remote.set('projector-delay') : remote.clear('projector-delay');
    await expect(call).rejects.toBeInstanceOf(FaultCallError);
    await expect(call).rejects.toMatchObject({ operation, status, body, message: `Migration ${operation} answered HTTP ${String(status)}` });
    expect(calls).toHaveLength(1);
  });
});
