// Unit tests for the fault process port: up.json reading, graceful restart and child runs, with fake processes only.
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProcessControlError,
  ProcessEntryError,
  createProcessControl,
  migrateCliPath,
  outboxCliPath,
  spawnChild,
  upJsonSchema,
  type KillFunction,
  type ProcessControlOptions,
  type SpawnChildOptions,
} from '../../src/faults/process-control.js';

let stateDir: string;

/** An up.json as up.sh writes it, with keys this port does not read. */
function upDoc() {
  return {
    ports: { gateway: 8100 },
    snapshot: 0,
    fixtures: { available: false },
    processes: {
      people: {
        pid: 4321,
        port: 8112,
        cwd: stateDir,
        command: ['node', 'dist/main.js'],
        env: { PORT: '8112', PG_USER: 'people_app' },
        log: 'people.log',
        startedAt: '2026-06-30T00:00:00.000Z',
      } as Record<string, unknown>,
      gateway: { pid: 1111, cwd: '/srv/gateway', command: 'node dist/main.js' } as Record<string, unknown>,
    },
  };
}

function writeUp(doc: unknown): void {
  writeFileSync(path.join(stateDir, 'up.json'), JSON.stringify(doc));
}

function readUp(): ReturnType<typeof upDoc> {
  return JSON.parse(readFileSync(path.join(stateDir, 'up.json'), 'utf8')) as ReturnType<typeof upDoc>;
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

/** Rejection reason of a promise that must reject. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => expect.unreachable('expected a rejection'),
    (reason: unknown) => reason,
  );
}

/** Child process surface the port drives. */
class FakeChild extends EventEmitter {
  pid: number | undefined = 5555;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly unref = vi.fn();
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);
}

function fakeSpawn(child = new FakeChild()) {
  const spawn = vi.fn<(...args: unknown[]) => ChildProcess>(() => child as unknown as ChildProcess);
  return { child, spawn, inject: spawn as unknown as NonNullable<ProcessControlOptions['spawn']> };
}

/** Fake `kill`: SIGTERM succeeds, and the process is gone after `aliveProbes` existence probes. */
function fakeKill(aliveProbes: number) {
  let probes = 0;
  return vi.fn<KillFunction>((_pid, signal) => {
    if (signal === 0 && probes++ >= aliveProbes) throw errnoError('ESRCH');
    return true;
  });
}

const healthy = vi.fn(async () => new Response('ok', { status: 200 }));
const noSleep = async (): Promise<void> => {};

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'opt2-process-control-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  vi.useRealTimers();
  healthy.mockClear();
});

describe('upJsonSchema', () => {
  it('keeps keys it does not read, at the top level and per entry', () => {
    writeUp(upDoc());
    const doc = upJsonSchema.parse(readUp());
    expect(doc).toMatchObject({ ports: { gateway: 8100 }, snapshot: 0, fixtures: { available: false } });
    expect(doc.processes.people).toMatchObject({ startedAt: '2026-06-30T00:00:00.000Z' });
  });

  it.each([
    ['pid 0', { pid: 0 }],
    ['a negative pid', { pid: -1 }],
    ['a relative cwd', { cwd: 'services/people' }],
    ['an empty argv', { command: [] }],
    ['a port above 65535', { port: 70_000 }],
  ])('rejects %s', (_label, change) => {
    const doc = upDoc();
    Object.assign(doc.processes.people, change);
    expect(upJsonSchema.safeParse(doc).success).toBe(false);
  });
});

describe('entry and envOf', () => {
  it.each(['nobody', 'constructor', 'toString'])('entry(%j) throws ProcessEntryError without a field', (name) => {
    writeUp(upDoc());
    const control = createProcessControl({ stateDir });
    const error = (() => {
      try {
        control.entry(name);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ProcessEntryError);
    expect(error).toMatchObject({ processName: name, field: undefined });
  });

  it('re-reads up.json on every call', () => {
    writeUp(upDoc());
    const control = createProcessControl({ stateDir });
    expect(control.entry('people').pid).toBe(4321);
    const changed = upDoc();
    changed.processes.people.pid = 9999;
    writeUp(changed);
    expect(control.entry('people').pid).toBe(9999);
  });

  it('names the file when up.json does not match the schema', () => {
    writeUp({ processes: { people: { pid: 'x' } } });
    expect(() => createProcessControl({ stateDir }).entry('people')).toThrow(/^Invalid .*up\.json/);
  });

  it('requires an absolute state directory when a call reads up.json', () => {
    const control = createProcessControl({ stateDir: 'relative/state' });
    expect(() => control.entry('people')).toThrow(/absolute/);
  });

  it('envOf merges the recorded env over process.env', () => {
    writeUp(upDoc());
    const env = createProcessControl({ stateDir }).envOf('people');
    expect(env).toMatchObject({ PORT: '8112', PG_USER: 'people_app', PATH: process.env.PATH });
  });

  it('envOf throws ProcessEntryError(env) when the entry records no env', () => {
    writeUp(upDoc());
    expect(() => createProcessControl({ stateDir }).envOf('gateway')).toThrow(
      expect.objectContaining({ name: 'ProcessEntryError', processName: 'gateway', field: 'env' }),
    );
  });
});

describe('restart', () => {
  it('stops with SIGTERM, waits for ESRCH, respawns detached, waits for /healthz and records the new pid', async () => {
    writeUp(upDoc());
    const kill = fakeKill(2);
    const { child, spawn, inject } = fakeSpawn();
    const fetch = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const control = createProcessControl({ stateDir, kill, spawn: inject, fetch: fetch as never, sleep: noSleep });

    const result = await control.restart('people', { timeoutMs: 5_000 });

    expect(result).toMatchObject({ name: 'people', oldPid: 4321, newPid: 5555 });
    expect(result.stoppedMs).toBeGreaterThanOrEqual(0);
    expect(result.healthyMs).toBeGreaterThanOrEqual(0);
    expect(kill.mock.calls).toEqual([
      [4321, 'SIGTERM'],
      [4321, 0],
      [4321, 0],
      [4321, 0],
    ]);
    const [exe, args, options] = spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect([exe, args]).toEqual(['node', ['dist/main.js']]);
    expect(options).toMatchObject({ cwd: stateDir, detached: true, env: { PORT: '8112', PG_USER: 'people_app' } });
    expect(options.shell).toBeUndefined();
    expect(options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8112/healthz', expect.anything());
    expect(fetch).toHaveBeenCalledTimes(2);

    const written = readUp();
    const expected = upDoc();
    expected.processes.people.pid = 5555;
    expect(written).toEqual(expected);
    expect(readdirSync(stateDir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('runs a string command through a shell and ignores output without a log', async () => {
    const doc = upDoc();
    Object.assign(doc.processes.gateway, { port: 8100 });
    writeUp(doc);
    const { spawn, inject } = fakeSpawn();
    const control = createProcessControl({ stateDir, kill: fakeKill(0), spawn: inject, fetch: healthy as never });

    await control.restart('gateway', { timeoutMs: 1_000 });

    const [command, options] = spawn.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe('node dist/main.js');
    expect(options).toMatchObject({ shell: true, stdio: 'ignore', cwd: '/srv/gateway', detached: true });
  });

  it('treats ESRCH on SIGTERM as already exited', async () => {
    writeUp(upDoc());
    const kill = vi.fn<KillFunction>(() => {
      throw errnoError('ESRCH');
    });
    const control = createProcessControl({ stateDir, kill, spawn: fakeSpawn().inject, fetch: healthy as never });

    await expect(control.restart('people', { timeoutMs: 1_000 })).resolves.toMatchObject({ newPid: 5555 });
    expect(kill.mock.calls).toEqual([
      [4321, 'SIGTERM'],
      [4321, 0],
    ]);
  });

  it('throws ProcessControlError(stop) without SIGKILL or respawn when the process outlives the budget', async () => {
    writeUp(upDoc());
    const kill = vi.fn<KillFunction>(() => true);
    const { spawn, inject } = fakeSpawn();
    const control = createProcessControl({ stateDir, kill, spawn: inject, sleep: noSleep });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 20 }));

    expect(error).toBeInstanceOf(ProcessControlError);
    expect(error).toMatchObject({ processName: 'people', step: 'stop' });
    expect(kill.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(readUp().processes.people.pid).toBe(4321);
  });

  it('throws ProcessControlError(stop) carrying the cause when the pid cannot be signalled', async () => {
    writeUp(upDoc());
    const denied = errnoError('EPERM');
    const control = createProcessControl({
      stateDir,
      kill: () => {
        throw denied;
      },
    });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 20 }));

    expect(error).toMatchObject({ step: 'stop', cause: denied });
  });

  it('throws ProcessEntryError(port) before signalling a process without a port', async () => {
    writeUp(upDoc());
    const kill = vi.fn<KillFunction>(() => true);

    const error = await rejectionOf(createProcessControl({ stateDir, kill }).restart('gateway', { timeoutMs: 20 }));

    expect(error).toMatchObject({ name: 'ProcessEntryError', field: 'port' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('throws ProcessControlError(start) when the start command cannot be spawned', async () => {
    writeUp(upDoc());
    const child = new FakeChild();
    child.pid = undefined;
    const spawn = fakeSpawn(child);
    spawn.spawn.mockImplementation(() => {
      setImmediate(() => child.emit('error', errnoError('ENOENT')));
      return child as unknown as ChildProcess;
    });
    const control = createProcessControl({ stateDir, kill: fakeKill(0), spawn: spawn.inject });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 20 }));

    expect(error).toMatchObject({ step: 'start', cause: expect.objectContaining({ code: 'ENOENT' }) });
  });

  it('records the new pid even when the new process never turns healthy', async () => {
    writeUp(upDoc());
    const unhealthy = vi.fn(async () => new Response('down', { status: 503 }));
    const control = createProcessControl({
      stateDir,
      kill: fakeKill(0),
      spawn: fakeSpawn().inject,
      fetch: unhealthy as never,
      sleep: noSleep,
    });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 1_000, healthTimeoutMs: 20 }));

    expect(error).toMatchObject({ step: 'health' });
    expect(readUp().processes.people.pid).toBe(5555);
  });
});

describe('waitHealthy', () => {
  it('polls at intervalMs until /healthz answers 200 and returns the elapsed milliseconds', async () => {
    writeUp(upDoc());
    const sleep = vi.fn(noSleep);
    const fetch = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const control = createProcessControl({ stateDir, fetch: fetch as never, sleep });

    const elapsed = await control.waitHealthy('people', { timeoutMs: 10_000, intervalMs: 40 });

    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const [ms] of sleep.mock.calls as unknown as [number][]) expect(ms).toBeLessThanOrEqual(40);
  });

  it('throws ProcessControlError(health) with the last failure once the budget is spent', async () => {
    writeUp(upDoc());
    const control = createProcessControl({
      stateDir,
      fetch: (async () => new Response('', { status: 503 })) as never,
      sleep: noSleep,
    });

    const error = await rejectionOf(control.waitHealthy('people', { timeoutMs: 20 }));

    expect(error).toBeInstanceOf(ProcessControlError);
    expect(error).toMatchObject({ step: 'health', cause: expect.objectContaining({ message: 'HTTP 503' }) });
  });

  it('throws ProcessEntryError(port) for an entry without a port', async () => {
    writeUp(upDoc());
    const error = await rejectionOf(createProcessControl({ stateDir }).waitHealthy('gateway', { timeoutMs: 20 }));
    expect(error).toMatchObject({ name: 'ProcessEntryError', field: 'port' });
  });
});

describe('spawnChild', () => {
  function run(child: FakeChild, options: Partial<SpawnChildOptions> = {}) {
    const { spawn, inject } = fakeSpawn(child);
    const pending = spawnChild('/usr/bin/node', ['dist/cli.js', 'feed'], {
      env: { ONLY: 'this' },
      timeoutMs: 1_000,
      spawn: inject,
      ...options,
    });
    return { spawn, pending };
  }

  it('passes the env exactly and spawns without a shell', async () => {
    const child = new FakeChild();
    const { spawn, pending } = run(child, { cwd: '/srv/migration' });
    child.emit('close', 0, null);
    await pending;
    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', ['dist/cli.js', 'feed'], {
      env: { ONLY: 'this' },
      cwd: '/srv/migration',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('resolves exit 137 without throwing and keeps the last 8 KiB of each stream', async () => {
    const child = new FakeChild();
    const { pending } = run(child);
    child.stdout.emit('data', Buffer.from('a'.repeat(20_000)));
    child.stdout.emit('data', 'END');
    child.stderr.emit('data', 'killed by fault hook');
    child.emit('close', 137, null);

    const outcome = await pending;

    expect(outcome).toMatchObject({ exitCode: 137, signal: null, timedOut: false, stderrTail: 'killed by fault hook' });
    expect(outcome.stdoutTail).toHaveLength(8 * 1024);
    expect(outcome.stdoutTail.endsWith('END')).toBe(true);
  });

  it('sends SIGTERM when the budget elapses and reports timedOut', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { pending } = run(child, { timeoutMs: 500 });

    vi.advanceTimersByTime(500);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');

    await expect(pending).resolves.toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: true });
  });

  it('rejects when the executable cannot be spawned', async () => {
    const child = new FakeChild();
    const { pending } = run(child);
    const missing = errnoError('ENOENT');
    child.emit('error', missing);
    child.emit('close', -2, null);
    await expect(pending).rejects.toBe(missing);
  });
});

describe('CLI paths', () => {
  it('migrateCliPath resolves cli.js at the package root of this module tree', () => {
    expect(migrateCliPath()).toBe(fileURLToPath(new URL('../../src/cli.js', import.meta.url)));
  });

  it('outboxCliPath is the opt2-outbox bin beside the @opt2/platform/outbox entry', () => {
    expect(outboxCliPath().endsWith(path.join('dist', 'outbox', 'cli.js'))).toBe(true);
  });
});
