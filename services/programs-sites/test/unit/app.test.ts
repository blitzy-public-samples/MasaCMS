/** Composition root of programs-sites: its process environment, the default publisher's emulator check and cleanup of a start-up that fails part way. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublisher } from '@opt2/platform/events';
import { SAFE_ERROR_TEXT } from '@opt2/platform/logging';
import { EnvValidationError, createService, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createCapturingPublisher, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { buildApp, programsSitesEnvSchema, type BuildAppOptions } from '../../src/app.js';
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
  return loadEnv(programsSitesEnvSchema, testEnv({ OPT2_STATE_DIR: stateDir, PUBSUB_EMULATOR_HOST: EMULATOR_HOST, ...overrides }));
}

/** testEnv's OPT2_SERVICE_URLS without the `dropped` callees. */
function serviceUrlsWithout(...dropped: string[]): string {
  const urls = JSON.parse(testEnv({ OPT2_STATE_DIR: undefined }).OPT2_SERVICE_URLS ?? '{}') as Record<string, string>;
  return JSON.stringify(Object.fromEntries(Object.entries(urls).filter(([service]) => !dropped.includes(service))));
}

/** The safe text of the EnvValidationError the process schema throws for testEnv with `overrides`. */
function refusalOf(overrides: Readonly<Record<string, string | undefined>>): string {
  try {
    loadEnv(programsSitesEnvSchema, testEnv({ OPT2_STATE_DIR: stateDir, ...overrides }));
  } catch (err) {
    expect(err).toBeInstanceOf(EnvValidationError);
    return (err as EnvValidationError)[SAFE_ERROR_TEXT];
  }
  throw new Error('programsSitesEnvSchema accepted the environment');
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

describe('programsSitesEnvSchema', () => {
  it.each<readonly [string, Readonly<Record<string, string | undefined>>, string]>([
    ['a foreign OPT2_SERVICE_NAME', { OPT2_SERVICE_NAME: 'people' }, 'people: invalid environment (OPT2_SERVICE_NAME: must be programs-sites)'],
    ...['programs-sites', 'identity', 'strategies-content'].map((callee) => [
      `no OPT2_SERVICE_URLS.${callee}`,
      { OPT2_SERVICE_URLS: serviceUrlsWithout(callee) },
      `programs-sites: invalid environment (OPT2_SERVICE_URLS.${callee}: is required)`,
    ] as const),
    [
      'no OPT2_SERVICE_URLS',
      { OPT2_SERVICE_URLS: undefined },
      'programs-sites: invalid environment (OPT2_SERVICE_URLS.programs-sites: is required; OPT2_SERVICE_URLS.identity: is required; ' +
        'OPT2_SERVICE_URLS.strategies-content: is required)',
    ],
    [
      'migration in neither OPT2_MIGRATION_URL nor the map',
      { OPT2_SERVICE_URLS: serviceUrlsWithout('migration'), OPT2_MIGRATION_URL: undefined },
      'programs-sites: invalid environment (OPT2_MIGRATION_URL: is required (or OPT2_SERVICE_URLS.migration))',
    ],
    ['no OPT2_DB_AUTH', { OPT2_DB_AUTH: undefined }, 'programs-sites: invalid environment (OPT2_DB_AUTH: is required)'],
    ['no PG_DATABASE', { PG_DATABASE: undefined }, 'programs-sites: invalid environment (PG_DATABASE: is required)'],
  ])('refuses %s, naming each missing requirement', (_case, overrides, safeText) => {
    expect(refusalOf(overrides)).toBe(safeText);
  });

  it.each([
    ['OPT2_MIGRATION_URL alone', { OPT2_SERVICE_URLS: serviceUrlsWithout('migration') }],
    ['its map entry alone', { OPT2_MIGRATION_URL: undefined }],
  ])('accepts migration named by %s', (_case, overrides) => {
    expect(loadEnv(programsSitesEnvSchema, testEnv({ OPT2_STATE_DIR: stateDir, ...overrides })).OPT2_SERVICE_NAME).toBe('programs-sites');
  });

  it('is what buildApp parses process.env with when it is given no env', async () => {
    for (const [key, value] of Object.entries(testEnv({ OPT2_STATE_DIR: stateDir, OPT2_SERVICE_NAME: 'people' }))) vi.stubEnv(key, value);
    try {
      await expect(buildApp()).rejects.toThrow('people: invalid environment\n  OPT2_SERVICE_NAME: must be programs-sites');
      expect(createService).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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
