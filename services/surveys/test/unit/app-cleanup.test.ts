// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of surveys: a build that fails after createService closes what it opened and rethrows the failure. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPublisher } from '@opt2/platform/events';
import { REDACTED, createLogger } from '@opt2/platform/logging';
import { createService, type BaseEnv } from '@opt2/platform/service-kit';
import { UnknownTaskTargetError } from '@opt2/platform/tasks';
import { createCapturingPublisher, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { createSurveysTaskPort } from '../../src/tasks/port.js';
import { TEST_CLOCK, createFakeTaskPort, createRecordingDb, testEnv, type FakeTaskPort } from '../helpers/app.js';

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
  return { ...actual, createSurveysTaskPort: vi.fn(actual.createSurveysTaskPort) };
});

const actual = await vi.importActual<typeof import('@opt2/platform/service-kit')>('@opt2/platform/service-kit');
const FRAMES = expect.stringMatching(/^Error: \[REDACTED\]\n\s+at \S/);

/** Spies on what one build opened through its own factories, and the lines its logger wrote. */
interface OwnResources {
  dbEnd: MockInstance;
  publisherClose: MockInstance;
  taskPort: FakeTaskPort;
  clientClose: MockInstance[];
  logError: MockInstance[];
  lines: string[];
}

/**
 * Makes buildApp's next build open a RecordingDb in place of its pool, a capturing publisher and, unless `taskPortFailure`
 * rejects its creation, a fake task port, all as its own; `clientCloseFailure` rejects the service client's close.
 */
function ownResources(opts: { taskPortFailure?: Error; clientCloseFailure?: unknown } = {}): OwnResources {
  const db = createRecordingDb({ clock: TEST_CLOCK });
  const publisher = createCapturingPublisher();
  const taskPort = createFakeTaskPort();
  const own: OwnResources = {
    dbEnd: vi.spyOn(db, 'end'),
    publisherClose: vi.spyOn(publisher, 'close'),
    taskPort,
    clientClose: [],
    logError: [],
    lines: [],
  };
  vi.mocked(createService).mockImplementationOnce(async (options) => {
    const logger = createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: (line: string) => void own.lines.push(line) } });
    own.logError.push(vi.spyOn(logger, 'error'));
    // buildApp injected no pool, so it owns the one createService opens.
    const app = await actual.createService({ ...options, schema: undefined, pool: db, logger });
    const clientClose = vi.spyOn(app.opt2.client, 'close');
    if (opts.clientCloseFailure !== undefined) clientClose.mockRejectedValueOnce(opts.clientCloseFailure);
    own.clientClose.push(clientClose);
    return app;
  });
  vi.mocked(createPublisher).mockReturnValueOnce(publisher);
  if (opts.taskPortFailure === undefined) vi.mocked(createSurveysTaskPort).mockResolvedValueOnce(taskPort);
  else vi.mocked(createSurveysTaskPort).mockRejectedValueOnce(opts.taskPortFailure);
  return own;
}

describe('surveys buildApp failing after createService', () => {
  let stateDir: string;
  let env: BaseEnv;

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'opt2-surveys-cleanup-'));
    await writeTestSecrets(stateDir);
    env = await testEnv({ OPT2_STATE_DIR: stateDir });
  });

  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const build = (overrides: Partial<BaseEnv> = {}) =>
    buildApp({ env: { ...env, ...overrides }, clock: TEST_CLOCK, verifierOverride: testVerifier() });

  it.each<[string, Error | undefined, Partial<BaseEnv>, string | typeof UnknownTaskTargetError, boolean]>([
    ['its task port fails to build', new Error('task port failed'), {}, 'task port failed', false],
    // A map the process schema refuses, handed to buildApp directly.
    ['a registration after the task port throws', undefined, { OPT2_SERVICE_URLS: {} }, UnknownTaskTargetError, true],
  ])('closes its app, client, pool, publisher and task port when %s', async (_case, taskPortFailure, overrides, rethrown, taskPortBuilt) => {
    const sigterm = process.listenerCount('SIGTERM');
    const own = ownResources({ taskPortFailure });

    await expect(build(overrides)).rejects.toThrow(rethrown);
    expect(own.clientClose.map((spy) => spy.mock.calls.length)).toStrictEqual([1]);
    expect(own.dbEnd).toHaveBeenCalledTimes(1);
    expect(own.publisherClose).toHaveBeenCalledTimes(1);
    expect(own.taskPort.closed).toBe(taskPortBuilt);
    // The app's close removed the kit's SIGTERM handler.
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
    expect(own.logError.map((spy) => spy.mock.calls.length)).toStrictEqual([0]);
  });

  it('logs a cleanup step that fails as a serialized error and still runs the next one', async () => {
    const own = ownResources({ taskPortFailure: new Error('task port failed'), clientCloseFailure: new Error('close of row@example.com failed') });

    await expect(build()).rejects.toThrow('task port failed');
    expect(own.logError.map((spy) => spy.mock.calls)).toStrictEqual([[[{ error: { type: 'Error', message: REDACTED, stack: FRAMES } }, 'start-up cleanup failed']]]);
    expect(own.dbEnd).toHaveBeenCalledTimes(1);
    expect(own.lines.join('\n')).not.toContain('row@example.com');
  });
});
