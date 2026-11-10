// Unit tests for the controlled legacy restart, using fake child processes in place of a shell.
import { spawn as moduleSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LegacyRestartError,
  RestartUnavailableError,
  restartLegacy,
  type RestartOptions,
} from '../../src/legacy/restart.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const COMMAND = 'harness/repro/lib/legacy-start.sh restart';
const TAIL_BYTES = 8 * 1024;

/** Child process surface `restartLegacy` drives: output streams, lifecycle events and `kill`. */
class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);
}

/** Injected `spawn` that records each call and returns `child`. */
function fakeSpawn(child = new FakeChild()) {
  const spawn = vi.fn<(command: string, options: SpawnOptions) => ChildProcess>(() => child as unknown as ChildProcess);
  return { child, spawn, inject: spawn as unknown as NonNullable<RestartOptions['spawn']> };
}

/** Awaits a restart that must fail and returns its `LegacyRestartError`. */
async function failureOf(pending: Promise<unknown>): Promise<LegacyRestartError> {
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LegacyRestartError);
  return error as LegacyRestartError;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(moduleSpawn).mockReset();
});

describe('restartLegacy availability', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', ' \t '],
  ])('rejects with RestartUnavailableError and spawns nothing when the command is %s', async (_label, command) => {
    const fake = fakeSpawn();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: command }, { timeoutMs: 1_000, spawn: fake.inject });
    const error = await pending.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RestartUnavailableError);
    expect(error).toMatchObject({
      name: 'RestartUnavailableError',
      message: 'OPT2_LEGACY_RESTART_CMD is not set; no controlled legacy restart is available',
    });
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(moduleSpawn).not.toHaveBeenCalled();
  });
});

describe('restartLegacy success', () => {
  it('runs the command once through the shell with extraEnv over process.env and resolves on exit 0', async () => {
    vi.stubEnv('OPT2_TEST_RESTART_INHERITED', 'from-process');
    vi.stubEnv('OPT2_TEST_RESTART_OVERRIDDEN', 'from-process');
    const fake = fakeSpawn();

    const pending = restartLegacy(
      { OPT2_LEGACY_RESTART_CMD: COMMAND },
      {
        timeoutMs: 60_000,
        spawn: fake.inject,
        extraEnv: { OPT2_TEST_RESTART_OVERRIDDEN: 'from-extra', MURA_PING: 'false' },
      },
    );
    fake.child.stdout.emit('data', Buffer.from('ColdFusion started\n'));
    fake.child.emit('close', 0, null);
    const result = await pending;

    expect(result).toEqual({ exitCode: 0, durationMs: expect.any(Number) });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    const [command, options] = fake.spawn.mock.calls[0] ?? [];
    expect(command).toBe(COMMAND);
    expect(options).toMatchObject({ shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(options?.env).toEqual({
      ...process.env,
      OPT2_TEST_RESTART_INHERITED: 'from-process',
      OPT2_TEST_RESTART_OVERRIDDEN: 'from-extra',
      MURA_PING: 'false',
    });
    expect(fake.child.kill).not.toHaveBeenCalled();
  });

  it('passes process.env unchanged when no extraEnv is given', async () => {
    const fake = fakeSpawn();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 60_000, spawn: fake.inject });
    fake.child.emit('close', 0, null);
    await pending;

    expect(fake.spawn.mock.calls[0]?.[1].env).toEqual({ ...process.env });
  });

  it('uses node:child_process spawn when none is injected', async () => {
    const child = new FakeChild();
    vi.mocked(moduleSpawn).mockReturnValue(child as unknown as ReturnType<typeof moduleSpawn>);

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 60_000 });
    child.emit('close', 0, null);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(moduleSpawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(moduleSpawn).mock.calls[0]?.[0]).toBe(COMMAND);
  });

  it('clears the timeout on exit, so the elapsed budget never kills the child', async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 5_000, spawn: fake.inject });
    fake.child.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.child.kill).not.toHaveBeenCalled();
  });
});

describe('restartLegacy failures', () => {
  it('rejects a non-zero exit with its code and an output tail ending with stderr', async () => {
    const fake = fakeSpawn();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 60_000, spawn: fake.inject });
    fake.child.stdout.emit('data', Buffer.from('stopping ColdFusion\n'));
    fake.child.stderr.emit('data', 'box: server failed to start\n');
    fake.child.emit('close', 3, null);
    const error = await failureOf(pending);

    expect(error).toMatchObject({
      name: 'LegacyRestartError',
      message: 'Legacy restart command exited with code 3',
      exitCode: 3,
      signal: null,
      timedOut: false,
      outputTail: 'stopping ColdFusion\nbox: server failed to start\n',
    });
    expect(error.cause).toBeUndefined();
  });

  it('keeps only the last 8 KiB of combined output across chunks of any size', async () => {
    const fake = fakeSpawn();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 60_000, spawn: fake.inject });
    fake.child.stdout.emit('data', Buffer.from(`${'a'.repeat(TAIL_BYTES + 500)}stdout-end\n`));
    fake.child.stdout.emit('data', Buffer.from('b'.repeat(4_000)));
    fake.child.stderr.emit('data', 'stderr-end\n');
    fake.child.emit('close', 1, null);
    const { outputTail } = await failureOf(pending);

    expect(Buffer.byteLength(outputTail)).toBe(TAIL_BYTES);
    expect(outputTail.endsWith(`${'b'.repeat(4_000)}stderr-end\n`)).toBe(true);
    expect(outputTail.startsWith('a')).toBe(true);
    expect(outputTail).toContain('stdout-end\n');
  });

  it('rejects an exit by signal with the signal and no exit code', async () => {
    const fake = fakeSpawn();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 60_000, spawn: fake.inject });
    fake.child.stderr.emit('data', 'Killed\n');
    fake.child.emit('close', null, 'SIGKILL');

    expect(await failureOf(pending)).toMatchObject({
      message: 'Legacy restart command was terminated by SIGKILL',
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: false,
      outputTail: 'Killed\n',
    });
  });

  it.each([
    ['names the errno code', 'ENOENT', 'Legacy restart command could not be run (ENOENT)'],
    ['omits a missing errno code', undefined, 'Legacy restart command could not be run'],
  ])('rejects a child error event and %s', async (_label, code, message) => {
    const fake = fakeSpawn();
    const spawnError: NodeJS.ErrnoException = Object.assign(new Error('spawn /bin/sh ENOENT'), { code });

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 60_000, spawn: fake.inject });
    fake.child.emit('error', spawnError);
    fake.child.emit('close', -2, null);
    const error = await failureOf(pending);

    expect(error).toMatchObject({ message, exitCode: null, signal: null, timedOut: false, outputTail: '' });
    expect(error.cause).toBe(spawnError);
  });

  it('rejects when spawn throws, without arming the timeout', async () => {
    vi.useFakeTimers();
    const thrown = new TypeError('The argument "options.cwd" is invalid');
    const spawn = vi.fn(() => {
      throw thrown;
    });

    const error = await failureOf(
      restartLegacy(
        { OPT2_LEGACY_RESTART_CMD: COMMAND },
        { timeoutMs: 1_000, spawn: spawn as unknown as NonNullable<RestartOptions['spawn']> },
      ),
    );

    expect(error).toMatchObject({
      message: 'Legacy restart command could not be started',
      exitCode: null,
      signal: null,
      timedOut: false,
      outputTail: '',
    });
    expect(error.cause).toBe(thrown);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('restartLegacy timeout', () => {
  it('sends SIGTERM once the budget elapses and rejects as timed out with the output so far', async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 5_000, spawn: fake.inject });
    const failure = failureOf(pending);
    fake.child.stdout.emit('data', Buffer.from('waiting for ColdFusion\n'));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.child.kill).toHaveBeenCalledTimes(1);
    expect(fake.child.kill).toHaveBeenCalledWith('SIGTERM');
    fake.child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    fake.child.emit('close', null, 'SIGTERM');

    expect(await failure).toMatchObject({
      message: 'Legacy restart command did not finish within 5000 ms; sent SIGTERM',
      exitCode: null,
      signal: null,
      timedOut: true,
      outputTail: 'waiting for ColdFusion\n',
    });
  });
});
