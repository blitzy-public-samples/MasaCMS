/** Composition root of programs-sites: the default publisher's emulator check and cleanup of a start-up that fails part way. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublisher } from '@opt2/platform/events';
import { baseEnvSchema, createService, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createCapturingPublisher, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { registerSiteMonitorRoutes } from '../../src/routes/index.js';
import { createProgramsSitesTaskPort } from '../../src/tasks/port.js';
import { TEST_CLOCK, createFakeTaskPort, createRecordingDb, testEnv } from '../helpers/app.js';

vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  return { ...actual, createService: vi.fn(actual.createService) };
});

vi.mock('@opt2/platform/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/events')>();
  return { ...actual, createPublisher: vi.fn(actual.createPublisher) };
});

vi.mock('../../src/tasks/port.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tasks/port.js')>();
  return { ...actual, createProgramsSitesTaskPort: vi.fn(actual.createProgramsSitesTaskPort) };
});

vi.mock('../../src/routes/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/index.js')>();
  return { ...actual, registerSiteMonitorRoutes: vi.fn(actual.registerSiteMonitorRoutes) };
});

const EMULATOR_HOST = '127.0.0.1:9';

let stateDir: string;

beforeAll(async () => {
  // Outside test/helpers/app.ts's state-directory prefix, so suites counting that helper's directories never see this one.
  stateDir = mkdtempSync(path.join(tmpdir(), 'opt2-ps-app-test-'));
  await writeTestSecrets(stateDir);
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Restores each mocked factory to the real one and drops queued one-off results.
  vi.resetAllMocks();
});

function envWith(overrides: Readonly<Record<string, string | undefined>> = {}): BaseEnv {
  return loadEnv(baseEnvSchema, testEnv({ OPT2_STATE_DIR: stateDir, PUBSUB_EMULATOR_HOST: EMULATOR_HOST, ...overrides }));
}

function build(options: BuildAppOptions): Promise<FastifyInstance> {
  return buildApp({ env: envWith(), clock: TEST_CLOCK, verifierOverride: testVerifier(), ...options });
}

/** Makes the site-monitor routes register a plugin that Fastify rejects with `failure`. */
function failRoutePlugin(failure: Error): void {
  vi.mocked(registerSiteMonitorRoutes).mockImplementationOnce(async (app) => {
    await app.register((_instance, _opts, done) => {
      done(failure);
    });
  });
}

/** Where `buildApp` fails, whether its own task port exists by then, and how the failure is injected. */
const FAILURES = [
  ['its task port', false, (failure: Error) => void vi.mocked(createProgramsSitesTaskPort).mockRejectedValueOnce(failure)],
  ['a route plugin Fastify rejects', true, failRoutePlugin],
] as const;

describe('programs-sites buildApp publisher environment', () => {
  it('rejects a local start-up without PUBSUB_EMULATOR_HOST before createService acquires anything', async () => {
    const sigterm = process.listenerCount('SIGTERM');

    await expect(
      buildApp({ env: envWith({ PUBSUB_EMULATOR_HOST: undefined }), clock: TEST_CLOCK, verifierOverride: testVerifier() }),
    ).rejects.toThrow('programs-sites: invalid environment\n  PUBSUB_EMULATOR_HOST: is required when OPT2_ENV=local');
    expect(createService).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });

  it.each([
    ['its own publisher on the configured emulator', false, [[expect.objectContaining({ projectId: 'opt2-local', emulatorHost: EMULATOR_HOST })]]],
    ['an injected publisher without an emulator host', true, []],
  ])('starts with %s', async (_case, inject, publisherCalls) => {
    const app = await buildApp({
      env: envWith(inject ? { PUBSUB_EMULATOR_HOST: undefined } : {}),
      clock: TEST_CLOCK,
      verifierOverride: testVerifier(),
      db: createRecordingDb(),
      taskPort: createFakeTaskPort(),
      publisher: inject ? createCapturingPublisher() : undefined,
    });
    try {
      await app.ready();
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect(vi.mocked(createPublisher).mock.calls).toEqual(publisherCalls);
    } finally {
      await app.close();
    }
  });
});

describe.each(FAILURES)('programs-sites buildApp failing at %s', (_where, portAcquired, failAt) => {
  it.each([
    ['closes what it created', false],
    ['leaves what was injected open', true],
  ])('%s, keeps the injected pool, removes its SIGTERM listener and rethrows the failure', async (_case, inject) => {
    const failure = new Error('start-up step failed');
    const db = createRecordingDb();
    const dbEnd = vi.spyOn(db, 'end');
    const publisher = createCapturingPublisher();
    const publisherClose = vi.spyOn(publisher, 'close');
    const taskPort = createFakeTaskPort();
    const taskPortClose = vi.spyOn(taskPort, 'close');
    // Instances not injected come from buildApp's own factories, which here return these.
    if (!inject) vi.mocked(createPublisher).mockReturnValueOnce(publisher);
    if (!inject && portAcquired) vi.mocked(createProgramsSitesTaskPort).mockResolvedValueOnce(taskPort);
    failAt(failure);
    const sigterm = process.listenerCount('SIGTERM');

    await expect(
      build({ db, ...(inject ? { publisher } : {}), ...(inject && portAcquired ? { taskPort } : {}) }),
    ).rejects.toBe(failure);
    expect(publisherClose).toHaveBeenCalledTimes(inject ? 0 : 1);
    expect(taskPortClose).toHaveBeenCalledTimes(!inject && portAcquired ? 1 : 0);
    expect(dbEnd).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });
});

describe('programs-sites buildApp cleanup that fails', () => {
  it('still closes its task port, removes its SIGTERM listener and rethrows the start-up failure', async () => {
    const failure = new Error('route registration failed');
    const publisher = createCapturingPublisher();
    vi.spyOn(publisher, 'close').mockRejectedValueOnce(new Error('publisher close failed'));
    const taskPort = createFakeTaskPort();
    const taskPortClose = vi.spyOn(taskPort, 'close');
    vi.mocked(createPublisher).mockReturnValueOnce(publisher);
    vi.mocked(createProgramsSitesTaskPort).mockResolvedValueOnce(taskPort);
    failRoutePlugin(failure);
    const sigterm = process.listenerCount('SIGTERM');

    await expect(build({ db: createRecordingDb() })).rejects.toBe(failure);
    expect(taskPortClose).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });
});

describe('programs-sites buildApp on its own pool', () => {
  it('ends the pool createService opened when start-up fails', async () => {
    const failure = new Error('task port construction failed');
    vi.mocked(createProgramsSitesTaskPort).mockRejectedValueOnce(failure);

    await expect(build({ publisher: createCapturingPublisher() })).rejects.toBe(failure);
    const app = (await vi.mocked(createService).mock.results[0]?.value) as FastifyInstance | undefined;
    expect(app?.opt2.db).toBeDefined();
    // pg refuses a second end, so this rejection shows that buildApp's cleanup already ended the pool.
    await expect(app?.opt2.db?.end()).rejects.toThrow('Called end on pool more than once');
  });
});
