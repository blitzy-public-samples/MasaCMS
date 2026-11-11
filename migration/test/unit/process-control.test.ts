// Unit tests for the fault process port: up.json reading, graceful restart and child runs, with fake processes only.
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logSanitizerPath } from '../../src/faults/log-sanitizer.js';
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

/** Fake `kill`: each pid answers probes until it receives SIGTERM, then is gone. */
function exitOnSigterm() {
  const terminated = new Set<number>();
  return vi.fn<KillFunction>((pid, signal) => {
    if (terminated.has(pid)) throw errnoError('ESRCH');
    if (signal === 'SIGTERM') terminated.add(pid);
    return true;
  });
}

/** One process of a fake `/proc`: its start time, child pids and the inodes of its socket descriptors. */
interface FakeProcess {
  startTime?: string;
  children?: number[];
  sockets?: string[];
}

/** A `/proc/<pid>/stat` line whose comm holds spaces and parentheses, as a real one may. */
function statLine(pid: number, startTime: string): string {
  // Fields 3 to 21 (state, ppid, pgrp, session, then zeros), then starttime (22) and two more.
  const fields = ['S', '1', `${pid}`, `${pid}`, ...Array<string>(15).fill('0')];
  return `${pid} (node (x) y) ${[...fields, startTime, '0', '0'].join(' ')}\n`;
}

function writeFakeProcess(procRoot: string, pid: number, spec: FakeProcess): void {
  const { startTime = '1000', children = [], sockets = [] } = spec;
  const dir = path.join(procRoot, `${pid}`);
  mkdirSync(path.join(dir, 'fd'), { recursive: true });
  mkdirSync(path.join(dir, 'task', `${pid}`), { recursive: true });
  writeFileSync(path.join(dir, 'stat'), statLine(pid, startTime));
  writeFileSync(path.join(dir, 'task', `${pid}`, 'children'), children.map((child) => `${child} `).join(''));
  symlinkSync('/dev/null', path.join(dir, 'fd', '0'));
  sockets.forEach((inode, index) => symlinkSync(`socket:[${inode}]`, path.join(dir, 'fd', `${index + 3}`)));
}

/** Writes a fake `/proc` under the state directory; `listen` maps socket inodes to the TCP port each listens on. */
function fakeProc(
  processes: Record<number, FakeProcess>,
  listen: Record<string, number>,
  { table = 'tcp', withTcp6 = true }: { table?: 'tcp' | 'tcp6'; withTcp6?: boolean } = {},
): string {
  const procRoot = path.join(stateDir, 'proc');
  mkdirSync(path.join(procRoot, 'net'), { recursive: true });
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const address = table === 'tcp' ? '0100007F' : '0'.repeat(32);
  const row = (index: number, local: string, remote: string, state: string, inode: string) =>
    `   ${index}: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  0  0 ${inode} 1 0 100 0 0 10 0\n`;
  const rows = Object.entries(listen).map(([inode, port], index) =>
    row(index, `${address}:${port.toString(16).toUpperCase().padStart(4, '0')}`, '00000000:0000', '0A', inode),
  );
  // Inode 7999 is a connection on port 8112, which never counts as listening on it.
  const connected = row(rows.length, `${address}:1FB0`, '0100007F:D431', '01', '7999');
  writeFileSync(path.join(procRoot, 'net', 'tcp'), header + (table === 'tcp' ? rows.join('') : '') + connected);
  if (withTcp6) writeFileSync(path.join(procRoot, 'net', 'tcp6'), header + (table === 'tcp6' ? rows.join('') : ''));
  for (const [pid, spec] of Object.entries(processes)) writeFakeProcess(procRoot, Number(pid), spec);
  return procRoot;
}

/** Fake `/proc` in which people (pid 4321, port 8112) and gateway (pid 1111, port 8100) own their ports. */
function ownedProc(): string {
  return fakeProc({ 4321: { sockets: ['7001'] }, 1111: { sockets: ['7002'] } }, { '7001': 8112, '7002': 8100 });
}

/** The log sanitizer's child, whose stdin pipe the restarted command writes into. */
class FakeSanitizer extends FakeChild {
  override pid: number | undefined = 7777;
  stdin: { destroy: ReturnType<typeof vi.fn> } | null = { destroy: vi.fn() };
}

/** Fake spawn for an entry with a log: the sanitizer first, then the command. */
function fakeLoggedSpawn(service = new FakeChild(), sanitizer = new FakeSanitizer()) {
  const spawn = vi
    .fn<(...args: unknown[]) => ChildProcess>()
    .mockImplementationOnce(() => sanitizer as unknown as ChildProcess)
    .mockImplementationOnce(() => service as unknown as ChildProcess);
  return { sanitizer, service, spawn, inject: spawn as unknown as NonNullable<ProcessControlOptions['spawn']> };
}

/** `child` as Node returns it when the executable cannot be spawned: no pid, then an 'error' event. */
function failedSpawn(child: FakeChild, code: string): ChildProcess {
  child.pid = undefined;
  setImmediate(() => child.emit('error', errnoError(code)));
  return child as unknown as ChildProcess;
}

/** Non-secret stand-in for a credential value, assembled at run time. */
function sentinel(n: number): string {
  return ['sentinel', 'value', `${n}`].join('-');
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
    const { sanitizer, service, spawn, inject } = fakeLoggedSpawn();
    const fetch = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const procRoot = ownedProc();
    const control = createProcessControl({
      stateDir,
      procRoot,
      kill,
      spawn: inject,
      fetch: fetch as never,
      sleep: noSleep,
    });

    const result = await control.restart('people', { timeoutMs: 5_000 });

    expect(result).toMatchObject({ name: 'people', oldPid: 4321, newPid: 5555 });
    expect(result.stoppedMs).toBeGreaterThanOrEqual(0);
    expect(result.healthyMs).toBeGreaterThanOrEqual(0);
    expect(kill.mock.calls).toEqual([
      [4321, 0],
      [4321, 'SIGTERM'],
      [4321, 0],
      [4321, 0],
    ]);
    expect(spawn).toHaveBeenCalledTimes(2);
    const [filter, filterArgs, filterOptions] = spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect([filter, filterArgs]).toEqual([process.execPath, [logSanitizerPath()]]);
    expect(filterOptions).toMatchObject({ detached: true, stdio: ['pipe', expect.any(Number), expect.any(Number)] });
    const [exe, args, options] = spawn.mock.calls[1] as [string, string[], Record<string, unknown>];
    expect([exe, args]).toEqual(['node', ['dist/main.js']]);
    expect(options).toMatchObject({ cwd: stateDir, detached: true, env: { PORT: '8112', PG_USER: 'people_app' } });
    expect(options.shell).toBeUndefined();
    expect(options.stdio).toEqual(['ignore', sanitizer.stdin, sanitizer.stdin]);
    expect(sanitizer.stdin?.destroy).toHaveBeenCalledOnce();
    expect(sanitizer.unref).toHaveBeenCalledOnce();
    expect(sanitizer.kill).not.toHaveBeenCalled();
    expect(service.unref).toHaveBeenCalledOnce();
    expect(statSync(path.join(stateDir, 'people.log')).mode & 0o777).toBe(0o600);
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
    const control = createProcessControl({
      stateDir,
      procRoot: ownedProc(),
      kill: fakeKill(1),
      spawn: inject,
      fetch: healthy as never,
    });

    await control.restart('gateway', { timeoutMs: 1_000 });

    const [command, options] = spawn.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe('node dist/main.js');
    expect(options).toMatchObject({ shell: true, stdio: 'ignore', cwd: '/srv/gateway', detached: true });
  });

  it('treats ESRCH on SIGTERM as already exited', async () => {
    writeUp(upDoc());
    let exited = false;
    const kill = vi.fn<KillFunction>((_pid, signal) => {
      exited ||= signal === 'SIGTERM';
      if (exited) throw errnoError('ESRCH');
      return true;
    });
    const spawn = fakeLoggedSpawn().inject;
    const control = createProcessControl({ stateDir, procRoot: ownedProc(), kill, spawn, fetch: healthy as never });

    await expect(control.restart('people', { timeoutMs: 1_000 })).resolves.toMatchObject({ newPid: 5555 });
    expect(kill.mock.calls).toEqual([
      [4321, 0],
      [4321, 'SIGTERM'],
      [4321, 0],
    ]);
  });

  it('throws ProcessControlError(stop) without SIGKILL or respawn when the process outlives the budget', async () => {
    writeUp(upDoc());
    const kill = vi.fn<KillFunction>(() => true);
    const { spawn, inject } = fakeSpawn();
    const control = createProcessControl({ stateDir, procRoot: ownedProc(), kill, spawn: inject, sleep: noSleep });

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
      procRoot: ownedProc(),
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

    const control = createProcessControl({ stateDir, procRoot: ownedProc(), kill });

    const error = await rejectionOf(control.restart('gateway', { timeoutMs: 20 }));

    expect(error).toMatchObject({ name: 'ProcessEntryError', field: 'port' });
    expect(kill).not.toHaveBeenCalled();
  });

  /** The spawn results of one start, in call order, built from the sanitizer and command children. */
  type SpawnSteps = (sanitizer: FakeSanitizer, service: FakeChild) => (() => ChildProcess)[];

  it.each<[string, SpawnSteps, string, unknown, boolean]>([
    [
      'the start command cannot be spawned',
      (sanitizer, service) => [() => sanitizer as unknown as ChildProcess, () => failedSpawn(service, 'ENOENT')],
      'the start command could not be spawned',
      expect.objectContaining({ code: 'ENOENT' }),
      true,
    ],
    [
      'the log sanitizer cannot be spawned',
      (sanitizer) => [() => failedSpawn(sanitizer, 'EAGAIN')],
      'the log sanitizer could not be spawned',
      expect.objectContaining({ code: 'EAGAIN' }),
      false,
    ],
    [
      'spawning the log sanitizer throws',
      () => [
        () => {
          throw errnoError('EMFILE');
        },
      ],
      'cannot run the log sanitizer',
      expect.objectContaining({ code: 'EMFILE' }),
      false,
    ],
    [
      'the log sanitizer has no input pipe',
      (sanitizer) => {
        sanitizer.stdin = null;
        return [() => sanitizer as unknown as ChildProcess];
      },
      'the log sanitizer has no input pipe',
      undefined,
      true,
    ],
  ])('throws ProcessControlError(start) when %s', async (_label, steps, message, cause, killsSanitizer) => {
    writeUp(upDoc());
    const sanitizer = new FakeSanitizer();
    const spawn = vi.fn<(...args: unknown[]) => ChildProcess>();
    const implementations = steps(sanitizer, new FakeChild());
    for (const implementation of implementations) spawn.mockImplementationOnce(implementation);
    const control = createProcessControl({ stateDir, procRoot: ownedProc(), kill: fakeKill(1), spawn: spawn as never });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 20 }));

    expect(error).toBeInstanceOf(ProcessControlError);
    expect(error).toMatchObject({ step: 'start', message: `people start: ${message}` });
    expect((error as Error).cause).toEqual(cause);
    expect(spawn).toHaveBeenCalledTimes(implementations.length);
    // A sanitizer already running is terminated rather than left orphaned.
    expect(sanitizer.kill.mock.calls).toEqual(killsSanitizer ? [['SIGTERM']] : []);
    expect(readUp().processes.people.pid).toBe(4321);
  });

  it('throws ProcessControlError(start) without spawning when the log cannot be opened', async () => {
    const doc = upDoc();
    doc.processes.people.log = 'missing/people.log';
    writeUp(doc);
    const { spawn, inject } = fakeLoggedSpawn();
    const control = createProcessControl({ stateDir, procRoot: ownedProc(), kill: fakeKill(1), spawn: inject });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 20 }));

    expect(error).toMatchObject({ step: 'start', message: 'people start: cannot run the start command' });
    expect(error).toMatchObject({ cause: expect.objectContaining({ code: 'ENOENT' }) });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('hands the log sanitizer only the secret values, through its environment', async () => {
    const doc = upDoc();
    Object.assign(doc.processes.people, { env: { PORT: '8112', PG_PASSWORD: sentinel(1), PG_USER: 'people_app' } });
    writeUp(doc);
    // Only sentinels remain under secret-looking names, so no real credential reaches an assertion.
    for (const name of Object.keys(process.env)) {
      if (/PASSWORD|PASSWD|PWD|SECRET|KEY|TOKEN/i.test(name)) vi.stubEnv(name, undefined);
    }
    const short = ['ma', 'ple'].join('');
    vi.stubEnv('OPT2_TEST_SECRET', sentinel(2));
    vi.stubEnv('OPT2_SHORT_TOKEN', short);
    vi.stubEnv('OPT2_FLAG_TOKEN', 'false');
    vi.stubEnv('TOKENIZERS_PARALLELISM', 'false');
    vi.stubEnv('OPT2_PLAIN_SETTING', sentinel(3));
    const { spawn, inject } = fakeLoggedSpawn();
    const control = createProcessControl({
      stateDir,
      procRoot: ownedProc(),
      kill: fakeKill(1),
      spawn: inject,
      fetch: healthy as never,
    });
    try {
      await control.restart('people', { timeoutMs: 1_000 });
    } finally {
      vi.unstubAllEnvs();
    }

    const [, args, options] = spawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(args).toEqual([logSanitizerPath()]);
    expect(Object.keys(options.env)).toEqual(['OPT2_LOG_SANITIZER_SECRETS']);
    const secrets = JSON.parse(options.env.OPT2_LOG_SANITIZER_SECRETS ?? '') as string[];
    expect(secrets.sort()).toEqual([short, sentinel(1), sentinel(2)].sort());
  });

  it('records the new pid even when the new process never turns healthy', async () => {
    writeUp(upDoc());
    const unhealthy = vi.fn(async () => new Response('down', { status: 503 }));
    const control = createProcessControl({
      stateDir,
      procRoot: ownedProc(),
      kill: fakeKill(1),
      spawn: fakeLoggedSpawn().inject,
      fetch: unhealthy as never,
      sleep: noSleep,
    });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 1_000, healthTimeoutMs: 20 }));

    expect(error).toMatchObject({ step: 'health' });
    expect(readUp().processes.people.pid).toBe(5555);
  });

  it('keeps up.json at mode 0600 under umask 022 and leaves no temporary file', async () => {
    writeUp(upDoc());
    chmodSync(path.join(stateDir, 'up.json'), 0o600);
    const control = createProcessControl({
      stateDir,
      procRoot: ownedProc(),
      kill: fakeKill(1),
      spawn: fakeLoggedSpawn().inject,
      fetch: healthy as never,
    });
    const previous = process.umask(0o022);
    try {
      await control.restart('people', { timeoutMs: 1_000 });
    } finally {
      process.umask(previous);
    }

    expect(statSync(path.join(stateDir, 'up.json')).mode & 0o777).toBe(0o600);
    expect(readUp().processes.people.pid).toBe(5555);
    expect(readdirSync(stateDir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps both new pids when two controls restart entries of one up.json concurrently', async () => {
    const doc = upDoc();
    Object.assign(doc.processes.gateway, { port: 8100 });
    writeUp(doc);
    const gatewayChild = new FakeChild();
    gatewayChild.pid = 6666;
    const procRoot = ownedProc();
    const controlOf = (spawn: NonNullable<ProcessControlOptions['spawn']>) =>
      createProcessControl({ stateDir, procRoot, kill: exitOnSigterm(), spawn, fetch: healthy as never });

    await Promise.all([
      controlOf(fakeLoggedSpawn().inject).restart('people', { timeoutMs: 1_000 }),
      controlOf(fakeSpawn(gatewayChild).inject).restart('gateway', { timeoutMs: 1_000 }),
    ]);

    doc.processes.people.pid = 5555;
    doc.processes.gateway.pid = 6666;
    expect(readUp()).toEqual(doc);
  });

  it.each<[string, Record<number, FakeProcess>, Record<string, number>, { withTcp6?: boolean }]>([
    [
      'another process listens on the port',
      { 4321: { sockets: ['7999'] }, 9999: { sockets: ['7001'] } },
      { 7001: 8112 },
      {},
    ],
    ['nothing listens on the port', { 4321: { sockets: ['7999'] } }, {}, { withTcp6: false }],
    [
      'only a process nine generations below listens on it',
      Object.fromEntries(
        Array.from({ length: 10 }, (_, generation) => [
          4321 + generation,
          generation === 9 ? { sockets: ['7001'] } : { children: [4322 + generation] },
        ]),
      ),
      { 7001: 8112 },
      {},
    ],
  ])('rejects a stale record without signalling or respawning when %s', async (_label, processes, listen, tables) => {
    writeUp(upDoc());
    const kill = vi.fn<KillFunction>(() => true);
    const { spawn, inject } = fakeSpawn();
    const procRoot = fakeProc(processes, listen, tables);
    const control = createProcessControl({ stateDir, procRoot, kill, spawn: inject });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 1_000 }));

    expect(error).toBeInstanceOf(ProcessControlError);
    expect(error).toMatchObject({
      step: 'stop',
      message: 'people stop: pid 4321 does not own port 8112; the up.json record is stale',
    });
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(readUp().processes.people.pid).toBe(4321);
  });

  it('accepts a port held by a descendant and stops it and the recorded process with SIGTERM', async () => {
    const doc = upDoc();
    Object.assign(doc.processes.gateway, { port: 8100 });
    writeUp(doc);
    const processes = { 1111: { children: [1112] }, 1112: { startTime: '1001', sockets: ['7002'] } };
    const procRoot = fakeProc(processes, { 7002: 8100 }, { table: 'tcp6' });
    const kill = exitOnSigterm();
    const spawn = fakeSpawn().inject;
    const control = createProcessControl({ stateDir, procRoot, kill, spawn, fetch: healthy as never });

    const result = control.restart('gateway', { timeoutMs: 1_000 });

    await expect(result).resolves.toMatchObject({ oldPid: 1111, newPid: 5555 });
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [1111, 'SIGTERM'],
      [1112, 'SIGTERM'],
    ]);
  });

  it('starts the command without signalling when the recorded pid is already gone', async () => {
    writeUp(upDoc());
    const kill = fakeKill(0);
    const { spawn, inject } = fakeLoggedSpawn();
    const procRoot = fakeProc({}, {});
    const control = createProcessControl({ stateDir, procRoot, kill, spawn: inject, fetch: healthy as never });

    const result = control.restart('people', { timeoutMs: 1_000 });

    await expect(result).resolves.toMatchObject({ oldPid: 4321, newPid: 5555 });
    expect(kill.mock.calls).toEqual([[4321, 0]]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('refuses to signal a pid that answers while procRoot has no entry for it', async () => {
    writeUp(upDoc());
    const kill = vi.fn<KillFunction>(() => true);
    const { spawn, inject } = fakeSpawn();
    const control = createProcessControl({ stateDir, procRoot: fakeProc({}, {}), kill, spawn: inject });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 1_000 }));

    expect(error).toMatchObject({ step: 'stop', message: expect.stringContaining('pid 4321 is not listed under') });
    expect(kill.mock.calls).toEqual([[4321, 0]]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each<[string, number, unknown[][]]>([
    ['before SIGTERM, never signalling the new holder of the pid', 1, [[4321, 0], [4321, 0]]],
    ['while waiting for the exit', 2, [[4321, 0], [4321, 'SIGTERM'], [4321, 0]]],
  ])('ends the stop when the start time changes %s', async (_label, changeAtProbe, calls) => {
    writeUp(upDoc());
    const procRoot = ownedProc();
    let probes = 0;
    const kill = vi.fn<KillFunction>((pid, signal) => {
      if (signal === 0 && ++probes === changeAtProbe) {
        writeFileSync(path.join(procRoot, `${pid}`, 'stat'), statLine(pid, '2000'));
      }
      return true;
    });
    const sleep = vi.fn(noSleep);
    const { spawn, inject } = fakeLoggedSpawn();
    const control = createProcessControl({ stateDir, procRoot, kill, spawn: inject, fetch: healthy as never, sleep });

    await expect(control.restart('people', { timeoutMs: 1_000 })).resolves.toMatchObject({ newPid: 5555 });
    expect(kill.mock.calls).toEqual(calls);
    expect(sleep).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each<[string, (procRoot: string) => void, Record<string, unknown>]>([
    ['its TCP table is missing', (procRoot) => rmSync(path.join(procRoot, 'net', 'tcp')), { code: 'ENOENT' }],
    [
      'a descriptor table cannot be listed',
      (procRoot) => {
        rmSync(path.join(procRoot, '4321', 'fd'), { recursive: true });
        writeFileSync(path.join(procRoot, '4321', 'fd'), '');
      },
      { code: 'ENOTDIR' },
    ],
    [
      'a stat entry records no start time',
      (procRoot) => writeFileSync(path.join(procRoot, '4321', 'stat'), '4321 (node) S 1\n'),
      { message: expect.stringContaining('records no start time') },
    ],
  ])('fails closed without signalling when %s', async (_label, damage, cause) => {
    writeUp(upDoc());
    const procRoot = ownedProc();
    damage(procRoot);
    const kill = vi.fn<KillFunction>(() => true);
    const { spawn, inject } = fakeSpawn();
    const control = createProcessControl({ stateDir, procRoot, kill, spawn: inject });

    const error = await rejectionOf(control.restart('people', { timeoutMs: 1_000 }));

    expect(error).toBeInstanceOf(ProcessControlError);
    expect(error).toMatchObject({ step: 'stop', cause: expect.objectContaining(cause) });
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
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
  const GROUP = -5555;

  /** FakeChild whose streams record `destroy`, which supervision calls when 'close' never comes. */
  function drainableChild() {
    const child = new FakeChild();
    const destroyed = { stdout: vi.fn(), stderr: vi.fn() };
    Object.assign(child.stdout, { destroy: destroyed.stdout });
    Object.assign(child.stderr, { destroy: destroyed.stderr });
    return { child, destroyed };
  }

  /** Fake group `kill`: every signal reaches the group until `diesOn` was sent, after which it answers ESRCH. */
  function groupKill(diesOn?: NodeJS.Signals) {
    let present = true;
    return vi.fn<KillFunction>((_pid, signal) => {
      if (!present) throw errnoError('ESRCH');
      if (signal === diesOn) present = false;
      return true;
    });
  }

  function run(child: FakeChild, options: Partial<SpawnChildOptions> = {}) {
    const { spawn, inject } = fakeSpawn(child);
    const kill = groupKill();
    const pending = spawnChild('/usr/bin/node', ['dist/cli.js', 'feed'], {
      env: { ONLY: 'this' },
      timeoutMs: 1_000,
      spawn: inject,
      kill,
      ...options,
    });
    return { spawn, kill, pending };
  }

  it('passes the env exactly and spawns without a shell in its own process group', async () => {
    const child = new FakeChild();
    const { spawn, kill, pending } = run(child, { cwd: '/srv/migration' });
    child.emit('close', 0, null);
    await pending;
    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', ['dist/cli.js', 'feed'], {
      env: { ONLY: 'this' },
      cwd: '/srv/migration',
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(kill).not.toHaveBeenCalled();
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

  it('escalates a TERM-ignoring child to SIGKILL on its group and resolves timedOut with the exit seen', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const kill = groupKill('SIGKILL');
    const { pending } = run(child, { timeoutMs: 500, kill });

    await vi.advanceTimersByTimeAsync(500);
    expect(kill).toHaveBeenCalledWith(GROUP, 'SIGTERM');
    child.stdout.emit('data', 'still running');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).toHaveBeenCalledWith(GROUP, 'SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toEqual({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      stdoutTail: 'still running',
      stderrTail: '',
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('resolves timedOut with no exit status once the post-KILL wait elapses for a group that never ends', async () => {
    vi.useFakeTimers();
    const { child, destroyed } = drainableChild();
    const { kill, pending } = run(child, { timeoutMs: 500 });

    await vi.advanceTimersByTimeAsync(500 + 5_000 + 2_000);

    await expect(pending).resolves.toMatchObject({ exitCode: null, signal: null, timedOut: true });
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [GROUP, 'SIGTERM'],
      [GROUP, 'SIGKILL'],
    ]);
    expect(destroyed.stdout).toHaveBeenCalledTimes(1);
    expect(destroyed.stderr).toHaveBeenCalledTimes(1);
  });

  it('resolves with the exit status 1 s after an exit that close never follows, without signalling', async () => {
    vi.useFakeTimers();
    const { child, destroyed } = drainableChild();
    const { kill, pending } = run(child);

    child.stdout.emit('data', 'done');
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdoutTail: 'done',
      stderrTail: '',
    });
    expect(destroyed.stdout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill).not.toHaveBeenCalled();
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

  it('outboxCliPath is the opt2-outbox CLI module beside the @opt2/platform/outbox entry', () => {
    expect(outboxCliPath().endsWith(path.join('dist', 'outbox', 'cli.js'))).toBe(true);
  });
});
