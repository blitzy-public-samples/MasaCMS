// Unit tests of the migration service's composition root: service wiring, background loops and suspension, close order, failed
// builds and the listener; the composed services are doubles, so only `server.ts` itself is under test.
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import path from 'node:path';

import { EnvValidationError, fixedClock, type FastifyInstance } from '@opt2/platform/service-kit';
import { reconcileRecurringQueues, type ReconcileResult } from '@opt2/platform/tasks';
import { testVerifier } from '@opt2/platform/testing';
import { MemorySpanExporter, flushTracing, shutdownTracing, startTracing } from '@opt2/platform/tracing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMigrationContext } from '../../src/context.js';
import { CutoverDataError, loadGroups, loadVersion, type CutoverVersion, type GroupsFile } from '../../src/cutover/index.js';
import { UnsupportedLegacyDatabaseError, loadMigrationServerEnv, type MigrationEnv } from '../../src/env.js';
import type { BridgeClient, LegacyDb, SchedulerDescription } from '../../src/legacy/index.js';
import type { OwnersClient } from '../../src/owners/index.js';
import { createProjector } from '../../src/reverse/index.js';
import { defaultSiteMonitorRecord, type SiteMonitorRecord } from '../../src/scheduler/index.js';
import { buildApp, startServer, type BuildAppOptions } from '../../src/server.js';
import { createTransitionService } from '../../src/transition/index.js';
import { createWindowService, type WindowServiceOptions } from '../../src/windows/index.js';
import { createTestDirs, testEnv, testEnvSource, type TestDirs } from '../helpers/env.js';
import { createGatewayDouble } from '../helpers/gateway-double.js';
import { memoryMigrationDb } from '../helpers/route-app.js';

/** Shared state of the module doubles: the event order, the suspension flag and the site-monitor record. */
const h = vi.hoisted(() => ({
  events: [] as string[],
  suspended: false,
  monitor: null as unknown,
  resumeWindowsFailure: undefined as Error | undefined,
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  // Loop budgets of a few milliseconds, so a suite observes many iterations without fake timers.
  const fast = Object.freeze({ ...actual.loadConfig(), background: Object.freeze({ bridgePollMs: 15, tasksReconcileMs: 20 }) });
  return { ...actual, loadConfig: () => fast };
});

vi.mock('@opt2/platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tasks')>();
  return {
    ...actual,
    reconcileRecurringQueues: vi.fn(() => {
      h.events.push('reconcile');
      return Promise.resolve([]);
    }),
  };
});

vi.mock('../../src/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/env.js')>();
  return { ...actual, loadMigrationServerEnv: vi.fn(actual.loadMigrationServerEnv) };
});

vi.mock('../../src/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/context.js')>();
  return {
    ...actual,
    createMigrationContext: vi.fn(async (options: Parameters<typeof actual.createMigrationContext>[0]) => {
      const ctx = await actual.createMigrationContext(options);
      return Object.freeze({
        ...ctx,
        close: async () => {
          h.events.push('ctx.close');
          await ctx.close();
        },
      });
    }),
  };
});

vi.mock('../../src/reverse/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/reverse/index.js')>();
  return {
    ...actual,
    createProjector: vi.fn(() => ({
      start: vi.fn(() => {
        h.events.push('projector.start');
      }),
      stop: vi.fn(() => {
        h.events.push('projector.stop');
        return Promise.resolve();
      }),
      runOnce: vi.fn(),
      awaitProjection: vi.fn(),
    })),
  };
});

vi.mock('../../src/windows/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/windows/index.js')>();
  return {
    ...actual,
    createWindowService: vi.fn(() => ({
      open: vi.fn(),
      complete: vi.fn(),
      get: vi.fn(),
      resolve: vi.fn(),
      runLegacyStep: vi.fn(),
      runReloadWindow: vi.fn(),
      runRecoveryPass: vi.fn(),
      resumeWindows: vi.fn(() => {
        h.events.push('windows.resume');
        return h.resumeWindowsFailure === undefined ? Promise.resolve() : Promise.reject(h.resumeWindowsFailure);
      }),
      startImportRetryLoop: vi.fn(() => {
        h.events.push('retry.start');
        return {
          stop: () => {
            h.events.push('retry.stop');
            return Promise.resolve();
          },
        };
      }),
      stop: vi.fn(() => {
        h.events.push('windows.stop');
        return Promise.resolve();
      }),
    })),
  };
});

vi.mock('../../src/transition/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/transition/index.js')>();
  return {
    ...actual,
    createTransitionService: vi.fn(() => ({
      start: vi.fn(),
      get: vi.fn(),
      resume: vi.fn(() => {
        h.events.push('transitions.resume');
        return Promise.resolve(null);
      }),
      stop: vi.fn(() => {
        h.events.push('transitions.stop');
        return Promise.resolve();
      }),
    })),
  };
});

vi.mock('../../src/quiesce/background.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/quiesce/background.js')>();
  return {
    ...actual,
    createBackgroundState: vi.fn(() => ({
      isSuspended: vi.fn(() => {
        h.events.push('suspended?');
        return Promise.resolve(h.suspended);
      }),
      get: vi.fn(() => Promise.resolve(actual.defaultBackgroundRecord())),
      suspend: vi.fn(),
      resume: vi.fn(),
    })),
  };
});

vi.mock('../../src/scheduler/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scheduler/index.js')>();
  return { ...actual, readSchedulerKey: vi.fn(() => Promise.resolve(h.monitor)) };
});

const NOW = new Date('2026-06-30T12:00:00.000Z');
const DESCRIPTION: SchedulerDescription = {
  ping: false,
  siteMonitorTask: '/index.cfm/_api/sitemonitor/',
  tasks: [],
  serverTime: '2026-06-30 12:00:00',
};

const describeCalls = vi.fn(() => {
  h.events.push('bridge.describe');
  return Promise.resolve(DESCRIPTION);
});
const bridge = { schedulerDescribe: describeCalls } as unknown as BridgeClient;
const refuse = (): Promise<never> => Promise.reject(new Error('the server suites never reach legacy SQL Server'));
const legacy: LegacyDb = { live: refuse, database: refuse, transaction: refuse, close: () => Promise.resolve() } as unknown as LegacyDb;

let dirs: TestDirs;
let env: MigrationEnv;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  dirs = await createTestDirs();
  env = testEnv({ dirs, LOG_LEVEL: 'fatal' });
});

afterAll(async () => {
  await dirs.cleanup();
});

beforeEach(() => {
  h.events.length = 0;
  h.suspended = false;
  h.monitor = null;
  h.resumeWindowsFailure = undefined;
  vi.clearAllMocks();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Build options with every external port a double; `overrides` replaces any of them. */
function options(overrides: BuildAppOptions = {}): BuildAppOptions {
  return {
    env,
    clock: fixedClock(NOW),
    verifierOverride: testVerifier('migration'),
    db: memoryMigrationDb().db,
    legacy,
    owners: {} as OwnersClient,
    gateway: createGatewayDouble(),
    bridge,
    ...overrides,
  };
}

/** Builds and keeps the app for `afterEach` to close. */
async function build(overrides: BuildAppOptions = {}): Promise<FastifyInstance> {
  app = await buildApp(options(overrides));
  return app;
}

const count = (event: string): number => h.events.filter((entry) => entry === event).length;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The options `server.ts` passed to the mocked window service. */
function windowOptions(): WindowServiceOptions {
  return vi.mocked(createWindowService).mock.calls.at(-1)?.[1] as WindowServiceOptions;
}

const CUTOVER_GROUPS: GroupsFile = { sourceSha: 'x', groups: [{ id: 'grp:a', units: ['a.one'], writeEntries: [], hasCarryWrite: false }] };
const CUTOVER_V0001: CutoverVersion = {
  tableVersion: 'v0001',
  previous: null,
  sourceSha: 'x',
  createdAt: NOW.toISOString(),
  groupAuthority: { 'grp:a': 'legacy' },
  rollbackRefs: [],
  entries: [],
};

/** Writes `files` into a fresh cut-over directory and points the next built context's configuration at it. */
async function nextContextCutover(files: Record<string, string>): Promise<{ cutoverDir: string; groupsFile: string }> {
  const cutoverDir = await mkdtemp(path.join(dirs.stateDir, 'cutover-'));
  await mkdir(path.join(cutoverDir, 'versions'));
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(cutoverDir, rel), text);
  const paths = { cutoverDir, groupsFile: path.join(cutoverDir, 'groups.json') };
  const actual = await vi.importActual<typeof import('../../src/context.js')>('../../src/context.js');
  vi.mocked(createMigrationContext).mockImplementationOnce(async (contextOptions) => {
    const ctx = await actual.createMigrationContext(contextOptions);
    return Object.freeze({
      ...ctx,
      config: { ...ctx.config, paths: { ...ctx.config.paths, ...paths } },
      close: async () => {
        h.events.push('ctx.close');
        await ctx.close();
      },
    });
  });
  return paths;
}

describe('buildApp composition', () => {
  it('builds the projector with the fault hooks and the shared start-up guard runner, and transitions with their own guard', async () => {
    await build({ startBackground: false });

    const [, projectorOptions] = vi.mocked(createProjector).mock.calls[0] ?? [];
    expect(projectorOptions?.hooks).toEqual(expect.objectContaining({ beforeFirstRead: expect.any(Function), afterLegacyCommit: expect.any(Function) }));
    expect(projectorOptions?.startupGuard).toEqual(expect.objectContaining({ run: expect.any(Function), settled: expect.any(Function) }));
    expect(windowOptions().hooks).toEqual(expect.objectContaining({ beforeImport: expect.any(Function) }));

    const [, transitionOptions] = vi.mocked(createTransitionService).mock.calls[0] ?? [];
    expect(Object.keys(transitionOptions ?? {}).sort()).toEqual(['projector', 'scheduler', 'windows']);
    expect(transitionOptions?.projector).toBe(vi.mocked(createProjector).mock.results[0]?.value);
    expect(transitionOptions?.windows).toBe(vi.mocked(createWindowService).mock.results[0]?.value);
  });

  it('pauses the window retry loop through shouldRun while background work is suspended', async () => {
    await build({ startBackground: false });
    const { shouldRun } = windowOptions();

    await expect(shouldRun?.()).resolves.toBe(true);
    h.suspended = true;
    await expect(shouldRun?.()).resolves.toBe(false);
  });

  it('refuses a MySQL legacy source before creating the app or the context', async () => {
    const mysql = testEnv({ dirs, LOG_LEVEL: 'fatal', MURA_DBTYPE: 'mysql' });

    await expect(buildApp(options({ env: mysql }))).rejects.toBeInstanceOf(UnsupportedLegacyDatabaseError);
    expect(createMigrationContext).not.toHaveBeenCalled();
  });

  it('loads its default environment with the service schema and refuses it before creating the app or the context', async () => {
    const sigtermListeners = process.listenerCount('SIGTERM');
    const refused = new EnvValidationError(['OPT2_SERVICE_NAME: must be migration'], 'web');
    vi.mocked(loadMigrationServerEnv).mockImplementationOnce(() => {
      throw refused;
    });

    await expect(buildApp(options({ env: undefined }))).rejects.toBe(refused);
    expect(loadMigrationServerEnv).toHaveBeenCalledWith();
    expect(createMigrationContext).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('closes the created app when the context cannot be built, and rethrows', async () => {
    const sigtermListeners = process.listenerCount('SIGTERM');
    vi.mocked(createMigrationContext).mockRejectedValueOnce(new Error('context refused'));

    await expect(buildApp(options())).rejects.toThrow('context refused');
    // createService adds a SIGTERM listener that only the app's close removes.
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('preloads the configured cut-over directory, so its versions and groups load without their files once built', async () => {
    const paths = await nextContextCutover({
      'groups.json': JSON.stringify(CUTOVER_GROUPS),
      'versions/v0001.json': JSON.stringify(CUTOVER_V0001),
    });
    await build({ startBackground: false });
    await rm(paths.cutoverDir, { recursive: true, force: true });

    expect(loadVersion(paths.cutoverDir, 'v0001')).toEqual(CUTOVER_V0001);
    expect(loadGroups(paths.groupsFile)).toEqual(CUTOVER_GROUPS);
  });

  it('closes what it built and rethrows when a committed cut-over version contradicts its file name', async () => {
    const sigtermListeners = process.listenerCount('SIGTERM');
    await nextContextCutover({ 'groups.json': JSON.stringify(CUTOVER_GROUPS), 'versions/v0002.json': JSON.stringify(CUTOVER_V0001) });

    await expect(buildApp(options())).rejects.toBeInstanceOf(CutoverDataError);
    expect(h.events).toContain('ctx.close');
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });
});

describe('background loops', () => {
  it('start nothing without startBackground, and the close still stops the services, then the context', async () => {
    await build({ startBackground: false });
    await pause(80);

    expect(h.events).toEqual([]);
    await app?.close();
    app = undefined;
    expect(h.events).toEqual(['windows.stop', 'transitions.stop', 'ctx.close']);
  });

  it('start the projector, window recovery before its retry loop, the transition resume and both timed loops on ready', async () => {
    await build();
    await vi.waitFor(() => {
      expect(count('bridge.describe')).toBeGreaterThanOrEqual(2);
      expect(count('reconcile')).toBeGreaterThanOrEqual(2);
    });

    expect(count('projector.start')).toBe(1);
    expect(count('windows.resume')).toBe(1);
    expect(count('transitions.resume')).toBe(1);
    expect(count('retry.start')).toBe(1);
    expect(h.events.indexOf('windows.resume')).toBeLessThan(h.events.indexOf('retry.start'));
    expect(reconcileRecurringQueues).toHaveBeenCalledWith(expect.anything(), {
      serviceUrls: env.OPT2_SERVICE_URLS,
      withSiteMonitor: false,
      includeLocalOnly: true,
    });
  });

  it.each<[string, Partial<SiteMonitorRecord> | null, boolean]>([
    ['no record', null, false],
    ['a native task still on legacy', { nativeExisted: true, state: 'legacy' }, false],
    ['a handed-off native task', { nativeExisted: true, state: 'target' }, true],
    ['a handed-off task whose trigger a restoration disabled', { nativeExisted: true, state: 'target', targetTriggerDisabled: true }, false],
    ['no native task', { nativeExisted: false, state: 'target' }, false],
  ])('reconcile the site-monitor chain for %s: %s', async (_title, monitor, withSiteMonitor) => {
    h.monitor = monitor === null ? null : { ...defaultSiteMonitorRecord(NOW), ...monitor };
    await build();
    await vi.waitFor(() => expect(count('reconcile')).toBeGreaterThanOrEqual(1));

    expect(reconcileRecurringQueues).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ withSiteMonitor }));
  });

  it('skip every iteration while suspended and resume once the suspension is lifted', async () => {
    h.suspended = true;
    await build();
    await vi.waitFor(() => expect(count('suspended?')).toBeGreaterThanOrEqual(6));

    expect(count('bridge.describe')).toBe(0);
    expect(count('reconcile')).toBe(0);
    // Projection and start-up recovery are not loop iterations of the suspension.
    expect(count('projector.start')).toBe(1);
    expect(count('retry.start')).toBe(1);

    h.suspended = false;
    await vi.waitFor(() => {
      expect(count('bridge.describe')).toBeGreaterThanOrEqual(1);
      expect(count('reconcile')).toBeGreaterThanOrEqual(1);
    });
  });

  it('log a failed iteration and keep running, for a bridge failure and for chains not ensured', async () => {
    describeCalls.mockRejectedValueOnce(new Error('bridge down'));
    const notEnsured: ReconcileResult[] = [{ queue: 'people-outbox-sweep', service: 'people', ok: false, error: 'HTTP 503' }];
    vi.mocked(reconcileRecurringQueues).mockResolvedValueOnce(notEnsured);
    await build();

    await vi.waitFor(() => {
      expect(describeCalls.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(vi.mocked(reconcileRecurringQueues).mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('start the import retry loop even when window recovery fails at start-up', async () => {
    h.resumeWindowsFailure = new Error('migration schema unavailable');
    await build();

    await vi.waitFor(() => expect(count('retry.start')).toBe(1));
  });

  it('stop before the server closes, ahead of the services and the context, and never run after the close', async () => {
    await build();
    await vi.waitFor(() => expect(count('bridge.describe')).toBeGreaterThanOrEqual(1));

    h.events.length = 0;
    await app?.close();
    app = undefined;
    const closing = h.events.filter((event) => event !== 'suspended?' && event !== 'bridge.describe' && event !== 'reconcile');
    expect(closing).toEqual(['retry.stop', 'projector.stop', 'windows.stop', 'transitions.stop', 'ctx.close']);

    const after = h.events.length;
    await pause(80);
    expect(h.events.length).toBe(after);
  });
});

describe('background loop tracing', () => {
  const exporter = new MemorySpanExporter();
  /** `traceparent` of each bridge call the double received. */
  const received: (string | undefined)[] = [];
  const double = createHttpServer((request, response) => {
    received.push(request.headers.traceparent as string | undefined);
    request.resume();
    response.end('{}');
  });
  let base = '';

  beforeAll(async () => {
    double.listen(0, '127.0.0.1');
    await once(double, 'listening');
    base = `http://127.0.0.1:${String((double.address() as AddressInfo).port)}`;
    await startTracing({ serviceName: 'migration-server-test', version: '1.0.0', exporter });
  });

  afterAll(async () => {
    await shutdownTracing();
    double.closeAllConnections();
    double.close();
    await once(double, 'close');
  });

  it('runs each iteration in its own unsampled trace, whose calls carry traceparent flags 00 and export no span', async () => {
    const traced = {
      schedulerDescribe: async () => {
        await (await fetch(`${base}/legacy-bridge/scheduler.cfm`)).text();
        return DESCRIPTION;
      },
    } as unknown as BridgeClient;
    await build({ bridge: traced });
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    await app?.close();
    app = undefined;
    await flushTracing();

    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(new Set(received.map((traceparent) => traceparent?.split('-')[3]))).toStrictEqual(new Set(['00']));
    expect(new Set(received.map((traceparent) => traceparent?.split('-')[1])).size).toBe(received.length);
  });
});

/** A loopback port nothing listens on once it resolves. */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

/** The service map of the kept stack, the gateway and the four migrated services, each at a closed loopback port. */
const KEPT_SERVICE_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  ['gateway', 'identity', 'people', 'programs-sites', 'strategies-content'].map((name) => [name, 'http://127.0.0.1:1']),
);

describe('startServer', () => {
  it('starts from an environment whose service map names only the gateway and the four migrated services', async () => {
    const port = await freePort();
    const source = { ...testEnvSource({ dirs, LOG_LEVEL: 'fatal', PORT: String(port) }), OPT2_SERVICE_URLS: JSON.stringify(KEPT_SERVICE_URLS) };
    const kept = loadMigrationServerEnv(source);
    vi.mocked(loadMigrationServerEnv).mockReturnValueOnce(kept);

    const server = await startServer();
    try {
      expect(Object.keys(kept.OPT2_SERVICE_URLS).sort()).toEqual(Object.keys(KEPT_SERVICE_URLS).sort());
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await server.opt2.shutdown();
    }
  });

  it('listens on PORT with background work started, serving the health check', async () => {
    const port = await freePort();
    vi.mocked(loadMigrationServerEnv).mockReturnValueOnce(testEnv({ dirs, LOG_LEVEL: 'fatal', PORT: String(port) }));

    const server = await startServer();
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      expect(count('projector.start')).toBe(1);
    } finally {
      await server.opt2.shutdown();
    }
  });

  it('shuts the built app down and rethrows when the port is taken', async () => {
    const blocker: Server = createServer();
    blocker.listen(0, '0.0.0.0');
    await once(blocker, 'listening');
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    const sigtermListeners = process.listenerCount('SIGTERM');
    vi.mocked(loadMigrationServerEnv).mockReturnValueOnce(testEnv({ dirs, LOG_LEVEL: 'fatal', PORT: String(address.port) }));

    try {
      await expect(startServer()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(h.events).toContain('ctx.close');
      expect(h.events.indexOf('projector.stop')).toBeLessThan(h.events.indexOf('ctx.close'));
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    } finally {
      blocker.close();
      await once(blocker, 'close');
    }
  });
});
