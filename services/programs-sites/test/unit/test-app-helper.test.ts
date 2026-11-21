/** `buildTestApp` cleanup: a failed build closes the app it built, removes only the state directory it created, and rethrows its error. */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvValidationError } from '@opt2/platform/service-kit';
import { buildTestApp, createFakeTaskPort, type FakeTaskPort, type TestAppOptions } from '../helpers/app.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const STATE_DIR_PREFIX = 'opt2-programs-sites-';
const READY_FAILURE = /^injected task creation failure: /;

/** State directories `testEnv` created that still exist. */
function helperStateDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith(STATE_DIR_PREFIX))
    .sort();
}

/** A task port whose every create throws, so the app's onReady task-chain creation rejects `ready()`. */
function failingTaskPort(): FakeTaskPort {
  const port = createFakeTaskPort();
  port.failCreate(() => true);
  return port;
}

const ops = (port: FakeTaskPort): string[] => port.calls.map((call) => call.op);

describe('buildTestApp', () => {
  let dirsBefore: string[];
  let sigtermListeners: number;
  let previousTmpdir: string | undefined;
  let tmpRoot: string;

  /** A state directory the caller owns, outside the helper's prefix. */
  const callerStateDir = (): string => mkdtempSync(path.join(tmpdir(), 'opt2-caller-state-'));

  beforeEach(() => {
    vi.mocked(rmSync).mockReset();
    // A private TMPDIR keeps other files' concurrent helper directories out of helperStateDirs(); each file runs in its own worker.
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'test-app-helper-'));
    previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    dirsBefore = helperStateDirs();
    sigtermListeners = process.listenerCount('SIGTERM');
  });

  afterEach(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('closes the app and removes its state directory when ready() rejects, leaving the injected task port open', async () => {
    const taskPort = failingTaskPort();

    await expect(buildTestApp({ taskPort })).rejects.toThrow(READY_FAILURE);

    expect(ops(taskPort)).toContain('create');
    expect(ops(taskPort)).not.toContain('close');
    expect(helperStateDirs()).toEqual(dirsBefore);
    // createService removes its SIGTERM listener only when the app closes.
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);

    const later = await buildTestApp();
    try {
      expect((await later.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      await later.app.close();
    }
    expect(helperStateDirs()).toEqual(dirsBefore);
  });

  it.each<{ stage: string; options: TestAppOptions; error: typeof EnvValidationError | typeof TypeError }>([
    { stage: 'loadEnv rejects the environment', options: { envOverrides: { PORT: 'not-a-port' } }, error: EnvValidationError },
    {
      stage: 'a fake rejects its options',
      options: { clientHandlers: { identity: { 'not a route key': () => ({ status: 200, headers: {}, body: {} }) } } },
      error: TypeError,
    },
  ])('removes its state directory and rethrows when $stage', async ({ options, error }) => {
    await expect(buildTestApp(options)).rejects.toBeInstanceOf(error);

    expect(helperStateDirs()).toEqual(dirsBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it.each<{ stage: string; options: () => TestAppOptions; error: RegExp | typeof EnvValidationError }>([
    { stage: 'loadEnv rejects the environment', options: () => ({ envOverrides: { PORT: 'not-a-port' } }), error: EnvValidationError },
    { stage: 'ready() rejects', options: () => ({ taskPort: failingTaskPort() }), error: READY_FAILURE },
  ])('leaves a caller-provided state directory in place when $stage', async ({ options, error }) => {
    const stateDir = callerStateDir();
    const built = options();

    await expect(buildTestApp({ ...built, envOverrides: { ...built.envOverrides, OPT2_STATE_DIR: stateDir } })).rejects.toThrow(error);

    expect(existsSync(stateDir)).toBe(true);
    expect(helperStateDirs()).toEqual(dirsBefore);
  });

  it('rethrows the build error when removing the state directory fails, and still removes it', async () => {
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: injected removal failure'), { code: 'EBUSY' });
    });

    await expect(buildTestApp({ taskPort: failingTaskPort() })).rejects.toThrow(READY_FAILURE);

    const removed = vi.mocked(rmSync).mock.calls.map(([target]) => String(target));
    expect(removed).toHaveLength(2);
    expect(new Set(removed).size).toBe(1);
    expect(path.basename(removed[0] ?? '')).toMatch(new RegExp(`^${STATE_DIR_PREFIX}`));
    expect(helperStateDirs()).toEqual(dirsBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it('returns a ready app whose close removes the state directory it created', async () => {
    const { app, env, taskPort } = await buildTestApp();
    const stateDir = env.OPT2_STATE_DIR ?? '';

    expect(path.basename(stateDir)).toMatch(new RegExp(`^${STATE_DIR_PREFIX}`));
    expect(existsSync(stateDir)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

    await app.close();

    expect(existsSync(stateDir)).toBe(false);
    expect(helperStateDirs()).toEqual(dirsBefore);
    expect(ops(taskPort)).not.toContain('close');
  });
});
