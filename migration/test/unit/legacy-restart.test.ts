// Unit tests for the controlled legacy restart, using fake child processes in place of a shell.
import { spawn as moduleSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LegacyRestartError,
  RestartUnavailableError,
  restartLegacy,
  superviseChild,
  type RestartOptions,
  type SignalFunction,
  type SuperviseOptions,
} from '../../src/legacy/restart.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const COMMAND = 'harness/repro/lib/legacy-start.sh restart';
const TAIL_BYTES = 8 * 1024;
const GROUP = -4242;

/** Output stream surface: data events and `destroy`. */
class FakeStream extends EventEmitter {
  readonly destroy = vi.fn();
}

/** Child process surface the supervision drives: output streams, lifecycle events and `kill`. */
class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

/** Fake group `kill`: every signal reaches the group until `diesOn` was sent, after which it answers ESRCH. */
function fakeGroup(diesOn?: NodeJS.Signals) {
  let present = true;
  return vi.fn<SignalFunction>((_pid, signal) => {
    if (!present) throw errnoError('ESRCH');
    if (signal === diesOn) present = false;
    return true;
  });
}

/** Non-probe signals the fake `kill` received, as `[pid, signal]`. */
function sent(kill: ReturnType<typeof fakeGroup>): unknown[][] {
  return kill.mock.calls.filter(([, signal]) => signal !== 0);
}

/** Tracks whether `pending` has settled. */
function track(pending: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  const done = (): void => {
    state.settled = true;
  };
  pending.then(done, done);
  return state;
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
  vi.restoreAllMocks();
});

describe('superviseChild', () => {
  function supervise(kill: SignalFunction, options: Partial<SuperviseOptions> = {}, child = new FakeChild()) {
    const pending = superviseChild(child as unknown as ChildProcess, { timeoutMs: 1_000, kill, ...options });
    return { child, pending, state: track(pending) };
  }

  it('sends SIGTERM, then SIGKILL after a 5 s grace, to the group and settles once it is gone', async () => {
    vi.useFakeTimers();
    const kill = fakeGroup('SIGKILL');
    const { child, pending, state } = supervise(kill);

    await vi.advanceTimersByTimeAsync(999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(kill)).toEqual([[GROUP, 'SIGTERM']]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent(kill)).toEqual([[GROUP, 'SIGTERM']]);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(kill)).toEqual([
      [GROUP, 'SIGTERM'],
      [GROUP, 'SIGKILL'],
    ]);
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ timedOut: true, exitCode: null, signal: 'SIGKILL', groupGone: true });
    expect(kill.mock.calls.every(([pid]) => pid === GROUP)).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never sends SIGKILL when the group ends during the grace period', async () => {
    vi.useFakeTimers();
    const kill = fakeGroup('SIGTERM');
    const { child, pending } = supervise(kill);

    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('exit', null, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toEqual({ timedOut: true, exitCode: null, signal: 'SIGTERM', groupGone: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent(kill)).toEqual([[GROUP, 'SIGTERM']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['every signal is delivered', () => true],
    [
      'every signal fails with EPERM',
      () => {
        throw errnoError('EPERM');
      },
    ],
    [
      'kill throws a non-errno value',
      () => {
        throw new TypeError('not a pid');
      },
    ],
  ])('settles after the 2 s post-KILL wait when the group outlives SIGKILL and %s', async (_label, behaviour) => {
    vi.useFakeTimers();
    const kill = vi.fn<SignalFunction>(behaviour);
    const { child, pending, state } = supervise(kill);

    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 1_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ timedOut: true, exitCode: null, signal: null, groupGone: false });
    expect(sent(kill)).toEqual([
      [GROUP, 'SIGTERM'],
      [GROUP, 'SIGKILL'],
    ]);
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['SIGTERM answers ESRCH', 4242, [[GROUP, 'SIGTERM']]],
    ['the child has no pid', undefined, []],
  ])('treats the group as gone when %s and settles after the 1 s drain bound', async (_label, pid, signals) => {
    vi.useFakeTimers();
    const kill = vi.fn<SignalFunction>(() => {
      throw errnoError('ESRCH');
    });
    const child = new FakeChild();
    child.pid = pid;
    const { pending, state } = supervise(kill, {}, child);

    await vi.advanceTimersByTimeAsync(1_000 + 999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ timedOut: true, exitCode: null, signal: null, groupGone: true });
    expect(kill.mock.calls).toEqual(signals);
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles on a close that arrives after the group is gone, with its exit status', async () => {
    vi.useFakeTimers();
    const kill = vi.fn<SignalFunction>(() => {
      throw errnoError('ESRCH');
    });
    const { child, pending } = supervise(kill);

    await vi.advanceTimersByTimeAsync(1_500);
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ timedOut: true, exitCode: 0, signal: null, groupGone: true });
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves on close after exit without ever signalling the group', async () => {
    vi.useFakeTimers();
    const kill = fakeGroup();
    const { child, pending } = supervise(kill);

    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ timedOut: false, exitCode: 0, signal: null });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kill).not.toHaveBeenCalled();
    expect(child.stdout.destroy).not.toHaveBeenCalled();
  });

  it('resolves with the exit status 1 s after an exit that close never follows, leaving the group alone', async () => {
    vi.useFakeTimers();
    const kill = fakeGroup();
    const { child, pending, state } = supervise(kill, { timeoutMs: 500 });

    await vi.advanceTimersByTimeAsync(200);
    child.emit('exit', 3, null);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ timedOut: false, exitCode: 3, signal: null });
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours overridden grace, post-KILL and drain bounds', async () => {
    vi.useFakeTimers();
    const kill = fakeGroup('SIGKILL');
    const { pending, state } = supervise(kill, { timeoutMs: 100, termGraceMs: 250, killWaitMs: 30, drainMs: 10 });

    await vi.advanceTimersByTimeAsync(100 + 249);
    expect(sent(kill)).toEqual([[GROUP, 'SIGTERM']]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(kill)).toEqual([
      [GROUP, 'SIGTERM'],
      [GROUP, 'SIGKILL'],
    ]);
    await vi.advanceTimersByTimeAsync(30 + 9);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ timedOut: true, exitCode: null, signal: null, groupGone: true });
  });

  it('rejects with an error raised before the budget elapses, without signalling', async () => {
    vi.useFakeTimers();
    const kill = fakeGroup();
    const { child, pending } = supervise(kill);
    const spawnError = errnoError('ENOENT');

    child.emit('error', spawnError);
    child.emit('close', -2, null);

    await expect(pending).rejects.toBe(spawnError);
    expect(vi.getTimerCount()).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it('signals through process.kill when no kill is injected', async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });
    const child = new FakeChild();
    const pending = superviseChild(child as unknown as ChildProcess, { timeoutMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    child.emit('close', null, 'SIGTERM');

    await expect(pending).resolves.toMatchObject({ timedOut: true, groupGone: true });
    expect(processKill.mock.calls).toEqual([[GROUP, 'SIGTERM']]);
  });
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
    expect(options).toMatchObject({ shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const kill = fakeGroup();

    const pending = restartLegacy({ OPT2_LEGACY_RESTART_CMD: COMMAND }, { timeoutMs: 60_000, kill });
    child.emit('close', 0, null);

    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(moduleSpawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(moduleSpawn).mock.calls[0]?.[0]).toBe(COMMAND);
    expect(kill).not.toHaveBeenCalled();
  });

  it('clears the timeout on exit, so the elapsed budget never signals the group', async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const kill = fakeGroup();

    const pending = restartLegacy(
      { OPT2_LEGACY_RESTART_CMD: COMMAND },
      { timeoutMs: 5_000, spawn: fake.inject, kill },
    );
    fake.child.emit('exit', 0, null);
    fake.child.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill).not.toHaveBeenCalled();
    expect(fake.child.kill).not.toHaveBeenCalled();
  });

  it('resolves after the drain bound when a descendant keeps the output open, leaving its group running', async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const kill = fakeGroup();

    const pending = restartLegacy(
      { OPT2_LEGACY_RESTART_CMD: COMMAND },
      { timeoutMs: 60_000, spawn: fake.inject, kill },
    );
    const state = track(pending);
    fake.child.stdout.emit('data', 'ColdFusion started\n');
    fake.child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ exitCode: 0, durationMs: expect.any(Number) });
    expect(fake.child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(fake.child.stderr.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(kill).not.toHaveBeenCalled();
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
  it('terminates the process group TERM then KILL and rejects as timed out only once the group is gone', async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const kill = fakeGroup('SIGKILL');

    const pending = restartLegacy(
      { OPT2_LEGACY_RESTART_CMD: COMMAND },
      { timeoutMs: 5_000, spawn: fake.inject, kill },
    );
    const state = track(pending);
    const failure = failureOf(pending);
    fake.child.stdout.emit('data', Buffer.from('waiting for ColdFusion\n'));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sent(kill)).toEqual([[GROUP, 'SIGTERM']]);
    // An 'error' during termination cannot reclassify the timeout.
    fake.child.emit('error', errnoError('EPERM'));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent(kill)).toEqual([
      [GROUP, 'SIGTERM'],
      [GROUP, 'SIGKILL'],
    ]);
    fake.child.emit('exit', null, 'SIGKILL');
    fake.child.emit('close', null, 'SIGKILL');
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);

    expect(await failure).toMatchObject({
      message: 'Legacy restart command did not finish within 5000 ms; its process group was terminated',
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      outputTail: 'waiting for ColdFusion\n',
    });
    expect(fake.child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects naming a group still present after SIGKILL once the post-KILL wait elapses', async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const kill = fakeGroup();

    const pending = restartLegacy(
      { OPT2_LEGACY_RESTART_CMD: COMMAND },
      { timeoutMs: 5_000, spawn: fake.inject, kill },
    );
    const failure = failureOf(pending);
    await vi.advanceTimersByTimeAsync(5_000 + 5_000 + 2_000);

    expect(await failure).toMatchObject({
      message:
        'Legacy restart command did not finish within 5000 ms; its process group was still present after SIGKILL',
      exitCode: null,
      signal: null,
      timedOut: true,
    });
    expect(fake.child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never reports success for an exit 0 observed after the budget elapsed', async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const kill = fakeGroup('SIGTERM');

    const pending = restartLegacy(
      { OPT2_LEGACY_RESTART_CMD: COMMAND },
      { timeoutMs: 5_000, spawn: fake.inject, kill },
    );
    const failure = failureOf(pending);
    await vi.advanceTimersByTimeAsync(5_000);
    fake.child.emit('exit', 0, null);
    fake.child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(100);

    expect(await failure).toMatchObject({ exitCode: 0, signal: null, timedOut: true });
    expect(sent(kill)).toEqual([[GROUP, 'SIGTERM']]);
  });
});
