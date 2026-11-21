import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REPO_ROOT, repoPath } from '../../src/lib/paths.js';
import { startProcess } from '../../src/performance/run.js';
import { readUpState, writeUpState } from '../../src/repro/up-state.js';
import { databaseToolCalls, SANDBOX_DATABASE_ENV, writeDatabaseToolStubs } from './database-sandbox.js';

const DOWN_SH = repoPath('harness', 'repro', 'down.sh');
const UP_SH = repoPath('harness', 'repro', 'up.sh');
const TEST_ALL_SH = repoPath('harness', 'repro', 'test-all.sh');
const COMMON_SH = repoPath('harness', 'repro', 'lib', 'common.sh');
const LOCK_SH = repoPath('harness', 'repro', 'lib', 'lock.sh');
const PROCESSES_SH = repoPath('harness', 'repro', 'lib', 'processes.sh');

/** A process this suite started, identified by its pid and start time. */
interface Spawned {
  pid: number;
  startTime: string;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let root: string;
let home: string;
let stateDir: string;
let pristineDir: string;
let recordedDir: string;
let elsewhere: string;
let stubBin: string;
let toolLog: string;
const spawned: Spawned[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-processes-stop-'));
  home = path.join(root, 'home');
  stateDir = path.join(root, 'state');
  pristineDir = path.join(root, 'pristine');
  recordedDir = path.join(root, 'service');
  elsewhere = path.join(root, 'elsewhere');
  stubBin = path.join(root, 'stub-bin');
  toolLog = path.join(root, 'database-tools.log');
  for (const dir of [home, stateDir, pristineDir, recordedDir, elsewhere, stubBin]) mkdirSync(dir, { recursive: true });
  writeDatabaseToolStubs(stubBin, toolLog);
});

afterEach(async () => {
  for (const proc of spawned.splice(0)) {
    if (runningAs(proc)) process.kill(proc.pid, 'SIGKILL');
  }
  await rm(root, { recursive: true, force: true });
});

/** Fields of `/proc/<pid>/stat` from field 3 on, or undefined once the process is gone. */
function statFields(pid: number): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
}

/** Start time of `pid` (field 22 of its stat), or undefined once it is gone. */
function startTimeOf(pid: number): string | undefined {
  return statFields(pid)?.[19];
}

/** Whether `proc` still runs as the process this suite started, not as a zombie or a reused pid. */
function runningAs(proc: Spawned): boolean {
  const fields = statFields(proc.pid);
  return fields !== undefined && fields[0] !== 'Z' && fields[19] === proc.startTime;
}

/** Records `pid` for the afterEach clean-up; returns its identity. */
function track(pid: number | undefined): Spawned {
  const startTime = pid === undefined ? undefined : startTimeOf(pid);
  if (pid === undefined || startTime === undefined) throw new Error('the spawned process is not running');
  const proc = { pid, startTime };
  spawned.push(proc);
  return proc;
}

/** The environment process_env gives target process `name` of this suite's state directory. */
function contract(name: string): NodeJS.ProcessEnv {
  return { OPT2_SERVICE_NAME: name, OPT2_STATE_DIR: stateDir };
}

/** Starts `sleep 300` leading its own session in `cwd` with PATH plus `env`. */
function startSleep(cwd: string, env: NodeJS.ProcessEnv = {}): Spawned {
  const child = spawn('sleep', ['300'], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return track(child.pid);
}

/** Starts a session whose leader exits at once, leaving `sleep 300` with PATH plus `env` in it; returns both pids. */
async function startOrphan(env: NodeJS.ProcessEnv): Promise<{ leader: number; orphan: Spawned }> {
  const child = spawn('bash', ['-c', 'sleep 300 </dev/null >/dev/null 2>&1 & printf "%s\\n" "$!"'], {
    cwd: recordedDir,
    env: { PATH: process.env.PATH, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  if (child.pid === undefined) throw new Error('bash did not start');
  return { leader: child.pid, orphan: track(Number(stdout.trim())) };
}

/** Runs `bash <script>` with the isolated HOME, state and pristine directories, sandbox databases and tool stubs. */
async function runBash(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPT2_STATE_DIR: stateDir,
    OPT2_PRISTINE_DIR: pristineDir,
    ...SANDBOX_DATABASE_ENV,
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    ...env,
  };
  for (const name of ['OPT2_LOCK_FLOCK_HELD', 'OPT2_LOCK_WAIT', 'OPT2_LOCK_DIR', 'OPT2_PORTS_FILE', 'OPT2_CF_SERVER_NAME']) {
    delete childEnv[name];
  }
  const child = spawn('bash', args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve(status));
  });
  return { code, stdout, stderr };
}

/** Runs `script` under errexit in bash after sourcing common.sh and processes.sh. */
function runLib(script: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return runBash(['-c', `set -euo pipefail\nsource "$0"\nsource "$1"\n${script}`, COMMON_SH, PROCESSES_SH], env);
}

/** Runs `script` under errexit in bash after sourcing common.sh and lock.sh alone, as clean-checkout-proof.sh does. */
function runLockLib(script: string): Promise<Run> {
  return runBash(['-c', `set -euo pipefail\nsource "$0"\nsource "$1"\n${script}`, COMMON_SH, LOCK_SH]);
}

/** The tooling.json entries. */
function readTooling(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(stateDir, 'tooling.json'), 'utf8')) as Record<string, unknown>;
}

/** Writes tooling.json with one started `otelcol` entry for `pid`, with `startTime` when given. */
function writeStartedOtelcol(pid: number, startTime: string | undefined): void {
  const entry = { state: 'started', pid, ...(startTime === undefined ? {} : { startTime }) };
  writeFileSync(path.join(stateDir, 'tooling.json'), `${JSON.stringify({ otelcol: entry })}\n`);
}

/** The text of `script`'s top-level function `name`, from its `name() {` line to the `}` line that closes it. */
function scriptFunction(script: string, name: string): string {
  const file = path.basename(script);
  const lines = readFileSync(script, 'utf8').split('\n');
  const start = lines.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${file} defines no function ${name}`);
  for (let end = start + 1; end < lines.length; end += 1) {
    if (lines[end] !== '}') continue;
    const text = lines.slice(start, end + 1).join('\n');
    // A `}` line of an embedded JavaScript block leaves its quote open, which bash -n rejects.
    if (spawnSync('bash', ['-n', '-c', text]).status === 0) return text;
  }
  throw new Error(`${file}'s function ${name} is never closed`);
}

/** The text of up.sh's top-level function `name`. */
function upShFunction(name: string): string {
  return scriptFunction(UP_SH, name);
}

/** up.sh's first top-level assignment line of each variable in `names`, its initial value. */
function upShGlobals(names: string[]): string {
  const lines = readFileSync(UP_SH, 'utf8').split('\n');
  return names
    .map((name) => {
      const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
      if (line === undefined) throw new Error(`up.sh never assigns ${name}`);
      return line;
    })
    .join('\n');
}

/** Pids of live processes whose environment holds this suite's OPT2_STATE_DIR. */
function processesOfStateDir(): number[] {
  const want = `OPT2_STATE_DIR=${stateDir}`;
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(want) && statFields(pid)?.[0] !== 'Z';
      } catch {
        return false;
      }
    });
}

/** Writes up.json with a `stub` entry for `pid` in `cwd`, with `startTime` when given, plus `others` with their own. */
function writeUpJson(pid: number, cwd: string, startTime?: string, others: Record<string, Spawned> = {}): void {
  const entry = (id: number, start?: string) => ({
    pid: id,
    cwd,
    command: ['node', 'dist/main.js'],
    ...(start === undefined ? {} : { startTime: start }),
  });
  const processes = { stub: entry(pid, startTime) } as Record<string, ReturnType<typeof entry>>;
  for (const [name, proc] of Object.entries(others)) processes[name] = entry(proc.pid, proc.startTime);
  writeFileSync(path.join(stateDir, 'up.json'), `${JSON.stringify({ processes })}\n`, { mode: 0o600 });
}

/** Writes the run lock of a dead `up` command of this checkout, with `overrides` applied; returns its path. */
function writeRunLock(overrides: Record<string, unknown> = {}): string {
  const file = path.join(home, '.opt2', 'run.lock');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = { checkout: realpathSync(REPO_ROOT), stateDir, pid: 2147483647, command: 'up', ...overrides };
  writeFileSync(file, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
  return file;
}

/** Asserts that down.sh completed its teardown: up.json archived, tooling.json removed, run lock released. */
function expectTornDown(run: Run): void {
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain('run lock: released');
  expect(existsSync(path.join(stateDir, 'up.json'))).toBe(false);
  expect(existsSync(path.join(stateDir, 'tooling.json'))).toBe(false);
  expect(existsSync(path.join(home, '.opt2', 'run.lock'))).toBe(false);
}

describe('tooling_record', () => {
  it('records the start time of the pid it is given', async () => {
    const proc = startSleep(elsewhere);

    const run = await runLib(`tooling_record otelcol started ${proc.pid}`);

    expect(run.code, run.stderr).toBe(0);
    expect(readTooling().otelcol).toMatchObject({ state: 'started', pid: proc.pid, startTime: proc.startTime });
  });

  it.each([
    { label: 'its own start time', recorded: (actual: string): string | undefined => actual, kept: true },
    { label: 'another start time', recorded: (actual: string): string | undefined => `${actual}0`, kept: false },
    { label: 'no start time', recorded: (): string | undefined => undefined, kept: true },
  ])('a reused record keeps the started entry of a running pid with $label: $kept', async ({ recorded, kept }) => {
    const proc = startSleep(elsewhere);
    writeStartedOtelcol(proc.pid, recorded(proc.startTime));

    const run = await runLib('tooling_record otelcol reused');

    expect(run.code, run.stderr).toBe(0);
    const expected = kept ? { state: 'started', pid: proc.pid } : { state: 'reused', pid: null };
    expect(readTooling().otelcol).toMatchObject(expected);
  });
});

describe('down.sh and the tooling up.sh started', () => {
  it.each([
    { label: 'no recorded start time', recorded: (): string | undefined => undefined, stopped: false },
    { label: 'another start time', recorded: (actual: string): string | undefined => `${actual}0`, stopped: false },
    { label: 'its own start time', recorded: (actual: string): string | undefined => actual, stopped: true },
  ])('a running otelcol pid with $label is stopped: $stopped', async ({ recorded, stopped }) => {
    const proc = startSleep(elsewhere);
    writeStartedOtelcol(proc.pid, recorded(proc.startTime));

    const run = await runBash([DOWN_SH]);

    expectTornDown(run);
    if (stopped) {
      expect(run.stdout).toContain(`tooling: stopped otelcol (pid ${proc.pid}); already gone none; left running none;`);
      expect(runningAs(proc)).toBe(false);
    } else {
      expect(run.stdout).toContain(`tooling: stopped none; already gone none; left running otelcol (pid ${proc.pid});`);
      expect(run.stderr).toContain(`pid ${proc.pid} recorded for otelcol is not the process up.sh started`);
      expect(runningAs(proc)).toBe(true);
    }
  });

  it('reports a started tool whose recorded pid has exited as already gone', async () => {
    const proc = startSleep(elsewhere);
    process.kill(proc.pid, 'SIGKILL');
    await expect.poll(() => runningAs(proc)).toBe(false);
    writeStartedOtelcol(proc.pid, proc.startTime);

    const run = await runBash([DOWN_SH]);

    expectTornDown(run);
    expect(run.stdout).toContain('tooling: stopped none; already gone otelcol; left running none;');
  });
});

describe('down.sh and the recorded target processes', () => {
  it.each([
    { label: 'its own start time, elsewhere and without the contract', own: true, inRecordedDir: false, stopped: true },
    { label: 'its own start time, with the contract in the recorded directory', own: true, inRecordedDir: true, stopped: true },
    { label: 'another start time, with the contract in the recorded directory', own: false, inRecordedDir: true, stopped: false },
  ])('a live recorded pid with $label is stopped: $stopped', async ({ own, inRecordedDir, stopped }) => {
    const proc = inRecordedDir ? startSleep(recordedDir, contract('stub')) : startSleep(elsewhere);
    const recorded = own ? proc.startTime : `${proc.startTime}0`;
    writeUpJson(proc.pid, recordedDir, recorded);

    const run = await runBash([DOWN_SH]);

    expectTornDown(run);
    if (stopped) {
      expect(run.stdout).toContain(`target processes: stopped stub (pid ${proc.pid}); already gone none`);
      expect(runningAs(proc)).toBe(false);
    } else {
      expect(run.stdout).toContain('target processes left running, pid reused: stub');
      expect(run.stderr).toContain(
        `pid ${proc.pid} recorded for stub is not the process up.sh started ` +
          `(start time ${proc.startTime}, recorded ${recorded}); left running`,
      );
      expect(runningAs(proc)).toBe(true);
    }
  });

  it.each([
    { label: 'with the contract in the recorded directory', inRecordedDir: true },
    { label: 'elsewhere and without the contract', inRecordedDir: false },
  ])('a live recorded pid with no start time, $label, fails teardown and keeps ownership', async ({ inRecordedDir }) => {
    const proc = inRecordedDir ? startSleep(recordedDir, contract('stub')) : startSleep(elsewhere);
    const web = startSleep(recordedDir, contract('web'));
    const otelcol = startSleep(elsewhere);
    writeUpJson(proc.pid, recordedDir, undefined, { web });
    writeStartedOtelcol(otelcol.pid, otelcol.startTime);
    const lock = writeRunLock();

    const run = await runBash([DOWN_SH]);

    expect(run.code, run.stderr).toBe(1);
    expect(run.stderr).toContain(
      `pid ${proc.pid} recorded for stub cannot be verified (no start time recorded); left running`,
    );
    expect(run.stderr).toContain(
      `opt2: no start time is recorded for stub (pid ${proc.pid}) in ${stateDir}/up.json, so down.sh cannot tell it ` +
        'from another process; up.json, tooling.json and the run lock are kept.',
    );
    expect(run.stderr).not.toContain('step 2:');
    expect(run.stdout).not.toContain('run lock: released');
    expect(runningAs(proc)).toBe(true);
    expect(runningAs(web)).toBe(false);
    expect(runningAs(otelcol)).toBe(true);
    expect(existsSync(path.join(stateDir, 'up.json'))).toBe(true);
    expect(existsSync(path.join(stateDir, 'tooling.json'))).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });

  it.each([
    { label: 'carries the environment contract', env: () => contract('stub'), stopped: true },
    {
      label: 'carries it with a trailing slash on the state directory',
      env: () => ({ ...contract('stub'), OPT2_STATE_DIR: `${stateDir}/` }),
      stopped: true,
    },
    {
      label: 'carries it through a symlink to the state directory',
      env: () => {
        const link = path.join(root, 'state-link');
        symlinkSync(stateDir, link);
        return { ...contract('stub'), OPT2_STATE_DIR: link };
      },
      stopped: true,
    },
    { label: 'lacks its service name', env: () => ({ OPT2_STATE_DIR: stateDir }), stopped: false },
  ])('an orphan of an exited recorded leader that $label is stopped: $stopped', async ({ env, stopped }) => {
    const { leader, orphan } = await startOrphan(env());
    writeUpJson(leader, recordedDir);

    const run = await runBash([DOWN_SH]);

    expectTornDown(run);
    if (stopped) {
      expect(run.stdout).toContain(`target processes: stopped stub (exited pid ${leader}: 1 orphaned member(s))`);
      expect(runningAs(orphan)).toBe(false);
    } else {
      expect(run.stdout).toContain('target processes: stopped none; already gone stub');
      expect(run.stderr).toContain(
        `pid(s) ${orphan.pid} in the session of exited pid ${leader} do not carry OPT2_SERVICE_NAME=stub`,
      );
      expect(runningAs(orphan)).toBe(true);
    }
  });
});

describe('down.sh and the OPT-2 databases', () => {
  it('lists the snapshot databases and probes PostgreSQL of the sandbox settings through the stubs only', async () => {
    const { MURA_DBHOST, MURA_DBPORT, MURA_DBUSERNAME, MURA_DATABASE, PG_HOST, PG_PORT } = SANDBOX_DATABASE_ENV;
    const probed = existsSync(repoPath('migration', 'dist', 'db-bootstrap', 'cli.js'));
    writeFileSync(path.join(stateDir, 'tooling.json'), '{}\n');

    const run = await runBash([DOWN_SH]);

    expectTornDown(run);
    const like = `${MURA_DATABASE.replaceAll('_', '[_]')}[_]opt2[_]snap[_]%`;
    const listing = expect.arrayContaining([
      'sqlcmd',
      `${MURA_DBHOST},${MURA_DBPORT}`,
      MURA_DBUSERNAME,
      'master',
      expect.stringContaining(`LIKE N'${like}'`),
    ]);
    const probe = ['pg_isready', '-q', '-h', PG_HOST, '-p', PG_PORT];
    expect(databaseToolCalls(toolLog)).toEqual([listing, listing, ...(probed ? [probe] : [])]);
    expect(run.stdout).toContain('snapshots: dropped none; backups deleted: none');
    expect(run.stdout).toContain(
      probed
        ? `target schemas and roles: not dropped, PostgreSQL does not answer on ${PG_HOST}:${PG_PORT}`
        : 'target schemas and roles: none dropped',
    );
  });
});

describe('up.sh launch when up.json cannot record the process', () => {
  it.each([
    { label: 'still runs', seconds: '300', message: /opt2: up\.sh stopped web \(pid \d+\) because it could not record it/ },
    { label: 'has exited', seconds: '0', message: /opt2: web \(pid \d+\), which up\.sh could not record in .*, has already/ },
  ])('stops the unrecorded child that $label and reports it', async ({ seconds, message }) => {
    const script = [
      upShGlobals(['CURRENT_STEP', 'STARTED_ANYTHING', 'UNRECORDED_NAME', 'UNRECORDED_PID']),
      ...['on_exit', 'write_up_state', 'record_process', 'launch'].map(upShFunction),
      `process_command() { printf '%s\\n' sleep ${seconds}; }`,
      '_opt2_require_built() { :; }',
      'harness_run() { return 1; }',
      'PROCESS_TIMEOUT_S=5',
      'trap on_exit EXIT',
      'launch web',
    ].join('\n');

    const run = await runLib(script, { OPT2_SERVICE_URLS: '{}' });
    const leaked = processesOfStateDir();
    for (const pid of leaked) {
      const startTime = startTimeOf(pid);
      if (startTime !== undefined) spawned.push({ pid, startTime });
    }

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`opt2: cannot update ${stateDir}/up.json`);
    expect(run.stderr).toContain('opt2: up.sh failed at step');
    expect(run.stderr).toMatch(message);
    expect(leaked).toEqual([]);
  });
});

describe('the start time recorded with a target process', () => {
  it.each([
    { label: 'up.sh launch started', respawn: false },
    { label: 'startProcess respawned', respawn: true },
  ])('is the one of the process $label, which down.sh then stops', async ({ respawn }) => {
    const env = { OPT2_STATE_DIR: stateDir };
    const script = [
      upShGlobals(['CURRENT_STEP', 'STARTED_ANYTHING', 'UNRECORDED_NAME', 'UNRECORDED_PID']),
      ...['on_exit', 'write_up_state', 'record_process', 'launch'].map(upShFunction),
      `process_command() { printf '%s\\n' sleep 300; }`,
      '_opt2_require_built() { :; }',
      'wait_healthy() { :; }',
      'PROCESS_TIMEOUT_S=5',
      'trap on_exit EXIT',
      'launch web',
    ].join('\n');
    const launched = await runLib(script, { OPT2_SERVICE_URLS: '{}' });
    expect(launched.code, launched.stderr).toBe(0);
    const entry = readUpState({ env }).processes.web;
    if (entry === undefined) throw new Error('up.json records no web process');
    let proc = track(entry.pid);
    expect(entry.startTime).toBe(proc.startTime);

    if (respawn) {
      process.kill(proc.pid, 'SIGKILL');
      await expect.poll(() => runningAs(proc)).toBe(false);
      const pid = await startProcess('web', entry, {
        spawn: (command, args, options) => spawn(command, args, options),
        writeUpState: (patch) => writeUpState(patch, { env }),
      });
      proc = track(pid);
      expect(readUpState({ env }).processes.web).toMatchObject({ pid, startTime: proc.startTime });
    }

    const run = await runBash([DOWN_SH]);

    expectTornDown(run);
    expect(run.stdout).toContain(`target processes: stopped web (pid ${proc.pid}); already gone none`);
    expect(runningAs(proc)).toBe(false);
  });
});

describe('now_iso', () => {
  it.each([45, 5, 999])('prints a clock at %i ms with three-digit milliseconds', async (ms) => {
    const realDate = spawnSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'date'),
      `#!/bin/sh\nexec ${realDate} -d @1700000000.${String(ms).padStart(3, '0')} "$@"\n`,
      { mode: 0o755 },
    );

    const run = await runLib('now_iso', { PATH: `${bin}:${process.env.PATH ?? ''}` });

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`${new Date(1_700_000_000_000 + ms).toISOString()}\n`);
  });
});

/** Which start time a record holds for a process: its own, another one, or none. */
type RecordedStart = 'own' | 'other' | 'none';

/** The start time a `kind` record holds for `proc`. */
function recordedStart(kind: RecordedStart, proc: Spawned): string | undefined {
  if (kind === 'own') return proc.startTime;
  return kind === 'other' ? `${proc.startTime}0` : undefined;
}

describe('lock_holder_live', () => {
  it.each<{ where: 'the lock' | 'up.json'; start: RecordedStart; live: boolean }>([
    { where: 'the lock', start: 'own', live: true },
    { where: 'the lock', start: 'other', live: false },
    { where: 'the lock', start: 'none', live: true },
    { where: 'up.json', start: 'own', live: true },
    { where: 'up.json', start: 'other', live: false },
    { where: 'up.json', start: 'none', live: true },
  ])('counts a running pid in $where with start time $start as live: $live', async ({ where, start, live }) => {
    const proc = startSleep(elsewhere);
    const startTime = recordedStart(start, proc);
    if (where === 'the lock') {
      writeRunLock({ pid: proc.pid, ...(startTime === undefined ? {} : { startTime }) });
    } else {
      writeRunLock();
      writeUpJson(proc.pid, recordedDir, startTime);
    }

    const run = await runLockLib('if lock_holder_live; then echo live; else echo stale; fi');

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(live ? 'live\n' : 'stale\n');
  });
});

describe('lock_acquire up, then lock_claim_stack, and another checkout', () => {
  it.each<{ start: RecordedStart; cleared: boolean }>([
    { start: 'other', cleared: true },
    { start: 'own', cleared: false },
  ])('whose lock pid runs with start time $start clears the lock: $cleared', async ({ start, cleared }) => {
    const proc = startSleep(elsewhere);
    const other = { checkout: path.join(root, 'other'), pid: proc.pid, startTime: recordedStart(start, proc) };
    const file = writeRunLock({ ...other, acquiredAt: '2026-01-01T00:00:00.000Z' });

    const run = await runLockLib(
      'lock_acquire up\nlock_claim_stack\nprintf "%s %s\\n" "$$" "$(_opt2_proc_start_time "$$")"',
    );

    const lock = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (cleared) {
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toContain(`opt2: clearing stale run lock of ${other.checkout}`);
      const [pid, startTime] = run.stdout.trim().split(' ');
      expect(lock).toMatchObject({ checkout: realpathSync(REPO_ROOT), stateDir, pid: Number(pid), startTime });
    } else {
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `opt2: the live OPT-2 stack of ${other.checkout} (command up, pid ${proc.pid}, ` +
          `since 2026-01-01T00:00:00.000Z) holds ${file}; run ${other.checkout}/harness/repro/down.sh first`,
      );
      expect(lock).toMatchObject(other);
    }
  });
});

describe("test-all.sh's require_stack", () => {
  it.each<{ start: RecordedStart; accepted: boolean }>([
    { start: 'own', accepted: true },
    { start: 'other', accepted: false },
    { start: 'none', accepted: true },
  ])('accepts a running gateway pid with start time $start: $accepted', async ({ start, accepted }) => {
    const proc = startSleep(elsewhere);
    const startTime = recordedStart(start, proc);
    const gateway = {
      pid: proc.pid,
      cwd: recordedDir,
      command: ['node', 'dist/main.js'],
      ...(startTime === undefined ? {} : { startTime }),
    };
    const up = { startedAt: '2026-01-01T00:00:00Z', processes: { gateway } };
    writeFileSync(path.join(stateDir, 'up.json'), `${JSON.stringify(up)}\n`, { mode: 0o600 });
    const script = [
      'UP_FILE="$OPT2_STATE_DIR/up.json"',
      scriptFunction(TEST_ALL_SH, 'require_stack'),
      'require_stack',
      'printf "stack %s\\n" "$STACK_STARTED_AT"',
    ].join('\n');

    const run = await runLib(script);

    if (accepted) {
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toBe('stack 2026-01-01T00:00:00Z\n');
    } else {
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(
        `opt2: the gateway (pid ${proc.pid}) recorded in ${stateDir}/up.json is not running: run harness/repro/up.sh first`,
      );
    }
  });
});
