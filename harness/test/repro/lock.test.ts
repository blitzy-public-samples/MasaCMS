// Unit suite for harness/repro/lib/lock.sh, driven through bash with a sandbox HOME and fake checkout paths.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoPath } from '../../src/lib/paths.js';

const REPRO_DIR = repoPath('harness/repro');
const DOWN_SH = repoPath('harness/repro/down.sh');
// $1 repro directory, $2 fake checkout, $3 script; the script also sees PRELUDE as $CHILD_PRELUDE for child commands.
const PRELUDE = 'set -euo pipefail; source "$1/lib/common.sh"; REPO=$2; source "$1/lib/lock.sh"; eval "$3"';
const LOCK_VARIABLES = ['OPT2_LOCK_FLOCK_HELD', 'OPT2_LOCK_WAIT', 'OPT2_COMMON_SH_LOADED', 'OPT2_PRISTINE_DIR'];
const TICKET = /^\d{20}-\d+-\d+$/;
const IGNORED_NOTE = 'opt2: ignoring OPT2_LOCK_FLOCK_HELD: no parent OPT-2 command holds the per-command flock';

interface Result {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface Holder {
  pid: number;
  release: () => Promise<Result>;
}

let home: string;
let children: ChildProcess[];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'opt2-lock-'));
  children = [];
});

afterEach(async () => {
  await Promise.all(
    children
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => new Promise((resolve) => child.once('close', resolve).kill('SIGKILL'))),
  );
  rmSync(home, { recursive: true, force: true });
});

const lockDir = (): string => path.join(home, '.opt2');
const lockFile = (): string => path.join(lockDir(), 'run.lock');
const flockFile = (): string => path.join(lockDir(), 'run.lock.flock');
const stateDir = (checkout: string): string => path.join(home, 'state', checkout.replaceAll('/', '_'));
const queueDir = (): string => path.join(lockDir(), 'run.queue');
const readLock = (): Record<string, unknown> => JSON.parse(readFileSync(lockFile(), 'utf8')) as Record<string, unknown>;
const tickets = (): string[] =>
  existsSync(queueDir()) ? readdirSync(queueDir()).filter((name) => TICKET.test(name)) : [];

/** Environment of one command: the sandbox HOME, the checkout's own state directory, no inherited lock variables. */
function commandEnv(checkout: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, OPT2_STATE_DIR: stateDir(checkout), CHILD_PRELUDE: PRELUDE };
  for (const name of LOCK_VARIABLES) delete env[name];
  return { ...env, ...extra };
}

/** Spawns a tracked process and collects its output until it closes. */
function launch(command: string, args: string[], env: NodeJS.ProcessEnv, stdin: 'ignore' | 'pipe'): {
  child: ChildProcess;
  output: () => string;
  done: Promise<Result>;
} {
  const child = spawn(command, args, { env, stdio: [stdin, 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Result>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, output: () => stdout, done };
}

/** Runs <script> in bash after common.sh, REPO=<checkout> and lock.sh. */
function run(checkout: string, script: string, extra: Record<string, string> = {}): Promise<Result> {
  return launch('bash', ['-c', PRELUDE, '_', REPRO_DIR, checkout, script], commandEnv(checkout, extra), 'ignore').done;
}

/** Runs <script>, then keeps the shell (and any flock it took) until released. */
async function hold(checkout: string, script: string, extra: Record<string, string> = {}): Promise<Holder> {
  const held = launch(
    'bash',
    ['-c', PRELUDE, '_', REPRO_DIR, checkout, `${script}; echo ready; read -r _ || true`],
    commandEnv(checkout, extra),
    'pipe',
  );
  let exited = false;
  void held.done.then(() => (exited = true));
  await until(() => exited || held.output().includes('ready\n'));
  if (!held.output().includes('ready\n')) {
    throw new Error(`holder ${checkout} exited before it was ready: ${(await held.done).stderr}`);
  }
  return {
    pid: held.child.pid ?? 0,
    release: () => {
      held.child.stdin?.end();
      return held.done;
    },
  };
}

/** Polls <check> every 50 ms for up to 15 s. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached within 15 s');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Starts a process that keeps <checkout>'s stack live through its up.json. */
function liveStack(checkout: string): ChildProcess {
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(sleeper);
  mkdirSync(stateDir(checkout), { recursive: true });
  writeFileSync(path.join(stateDir(checkout), 'up.json'), JSON.stringify({ processes: { gateway: { pid: sleeper.pid } } }));
  return sleeper;
}

/** Kills a live-stack process and waits for it to go. */
function stop(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve) => child.once('close', resolve).kill('SIGKILL'));
}

/** Writes a run lock for <checkout> whose pid has exited. */
function staleLock(checkout: string): void {
  const { pid } = spawnSync('true');
  mkdirSync(lockDir(), { recursive: true, mode: 0o700 });
  const record = { checkout, stateDir: stateDir(checkout), pid, command: 'up', acquiredAt: '2026-01-01T00:00:00.000Z' };
  writeFileSync(lockFile(), `${JSON.stringify(record)}\n`);
}

/** Claims a stack for /x/a, then leaves its teardown failed or killed halfway. */
async function brokenTeardown(mode: 'failed' | 'killed'): Promise<void> {
  expect((await run('/x/a', 'lock_acquire up; lock_claim_stack')).status).toBe(0);
  const script =
    mode === 'failed'
      ? 'lock_acquire down; lock_teardown_begin; lock_teardown_failed database-restore muraWRM-mapping'
      : 'lock_acquire down; lock_teardown_begin; kill -9 $$';
  await run('/x/a', script);
  expect(readLock()).toMatchObject({ checkout: '/x/a', teardown: { state: mode === 'failed' ? 'failed' : 'running' } });
}

describe('lock_acquire refusal', () => {
  it('refuses another checkout while a command holds the flock, then while its stack is live', async () => {
    const a = await hold('/x/a', 'lock_acquire up; lock_claim_stack');
    const busy = await run('/x/b', 'lock_acquire up');
    expect(busy.status).toBe(1);
    expect(busy.stderr).toMatch(new RegExp(`another OPT-2 command is running: /x/a \\(command up, pid ${a.pid},`));

    liveStack('/x/a');
    await a.release();
    const held = await run('/x/b', 'lock_acquire up');
    expect(held.status).toBe(1);
    expect(held.stderr).toContain(`the live OPT-2 stack of /x/a (command up, pid ${a.pid},`);
    expect(held.stderr).toContain('run /x/a/harness/repro/down.sh first');
  });

  it.each([
    { label: '1', value: (): string => '1' },
    { label: 'a value no command wrote', value: (): string => 'f0e1d2c3-0000-4000-8000-000000000000' },
    {
      label: "the holder's own token, outside its process tree",
      value: (): string => String((JSON.parse(readFileSync(flockFile(), 'utf8')) as { token?: unknown }).token),
    },
  ])('ignores an inherited OPT2_LOCK_FLOCK_HELD of $label while another command holds the flock', async ({ value }) => {
    await hold('/x/a', 'lock_acquire test-all');
    const result = await run('/x/b', 'lock_acquire test-all', { OPT2_LOCK_FLOCK_HELD: value() });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(IGNORED_NOTE);
    expect(result.stderr).toContain('another OPT-2 command is running: /x/a (command test-all,');
  });

  it("runs a child command under its parent's flock", async () => {
    const result = await run(
      '/x/a',
      'lock_acquire clean-checkout-proof; parent=$OPT2_LOCK_FLOCK_HELD; ' +
        'bash -c "$CHILD_PRELUDE" _ "$1" "$2" \'lock_acquire up; echo "child $OPT2_LOCK_FLOCK_HELD"\'; echo "parent $parent"',
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(IGNORED_NOTE);
    const token = /^parent (\S+)$/m.exec(result.stdout)?.[1];
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.stdout).toContain(`child ${token}`);
  });

  const secret = randomBytes(16).toString('hex');
  it.each([
    { label: 'a plain wrapper', prefix: [] as string[] },
    { label: 'a wrapper whose arguments carry a secret', prefix: ['env', `FAKE_PASSWORD=${secret}`] },
  ])('names the flock holders, not their arguments, when its recorded command has exited: $label', async ({ prefix }) => {
    expect((await run('/x/a', 'lock_acquire test-all')).status).toBe(0);
    const script = 'echo ready; read -r _ || true';
    const wrapper = launch('flock', [flockFile(), ...prefix, 'bash', '-c', script], { ...process.env, HOME: home }, 'pipe');
    await until(() => wrapper.output().includes('ready\n'));
    const result = await run('/x/b', 'lock_acquire test-all');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${flockFile()} is held by pid `);
    expect(result.stderr).toContain(`pid ${wrapper.child.pid} (flock, cwd ${realpathSync(process.cwd())})`);
    expect(result.stderr).toContain('not by an OPT-2 command (the last one recorded, /x/a (command test-all,');
    expect(result.stderr).not.toContain(script);
    expect(result.stderr).not.toContain(secret);
    wrapper.child.stdin?.end();
    await wrapper.done;
  });

  it.each(['-1', '1.5', 'soon', '1234567890'])('rejects OPT2_LOCK_WAIT=%s', async (wait) => {
    const result = await run('/x/a', 'lock_acquire up', { OPT2_LOCK_WAIT: wait });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`OPT2_LOCK_WAIT must be a whole number of seconds (at most 9 digits), got '${wait}'`);
  });
});

describe('the claimant queue', () => {
  it('admits queued claimants first come, first served once the stack is free', async () => {
    const stack = liveStack('/x/a');
    expect((await run('/x/a', 'lock_acquire up; lock_claim_stack')).status).toBe(0);
    const stamp = 'echo "acquired $(date +%s%N)"; lock_claim_stack';
    const first = run('/x/w1', `lock_acquire up; ${stamp}; sleep 2; echo "exits $(date +%s%N)"`, { OPT2_LOCK_WAIT: '25' });
    await until(() => tickets().length === 1);
    const second = run('/x/w2', `lock_acquire up; ${stamp}`, { OPT2_LOCK_WAIT: '25' });
    await until(() => tickets().length === 2);
    await stop(stack);

    const [w1, w2] = await Promise.all([first, second]);
    expect([w1.status, w2.status]).toEqual([0, 0]);
    const time = (result: Result, word: string): bigint =>
      BigInt(new RegExp(`^${word} (\\d+)$`, 'm').exec(result.stdout)?.[1] ?? '0');
    expect(time(w2, 'acquired')).toBeGreaterThan(time(w1, 'exits'));
    expect(w2.stderr).toContain('opt2: clearing stale run lock of /x/w1');
    expect(readLock()).toMatchObject({ checkout: '/x/w2', command: 'up' });
    expect(tickets()).toEqual([]);
  });

  it('refuses at the deadline with the reason and removes its ticket', async () => {
    liveStack('/x/a');
    expect((await run('/x/a', 'lock_acquire up; lock_claim_stack')).status).toBe(0);
    const result = await run('/x/b', 'lock_acquire up', { OPT2_LOCK_WAIT: '2' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/the live OPT-2 stack of \/x\/a \(command up, .*\(waited [2-9]s, OPT2_LOCK_WAIT=2\)$/m);
    expect(tickets()).toEqual([]);
  });

  it('refuses an immediate claimant while another is queued', async () => {
    liveStack('/x/a');
    expect((await run('/x/a', 'lock_acquire up; lock_claim_stack')).status).toBe(0);
    void run('/x/w1', 'lock_acquire up', { OPT2_LOCK_WAIT: '25' });
    await until(() => tickets().length === 1);
    const result = await run('/x/c', 'lock_acquire up');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /1 claimant\(s\) queued for the OPT-2 stack ahead of this one, first \/x\/w1 \(command up, pid \d+, since .*\)/,
    );
    expect(result.stderr).toContain('; set OPT2_LOCK_WAIT=<seconds> to queue behind them');
  });

  it.each(['test-all', 'down', 'clean-checkout-proof'])(
    "never holds %s of the checkout whose live stack holds the run lock behind the queue",
    async (command) => {
      liveStack('/x/a');
      expect((await run('/x/a', 'lock_acquire up; lock_claim_stack')).status).toBe(0);
      void run('/x/w1', 'lock_acquire up', { OPT2_LOCK_WAIT: '25' });
      await until(() => tickets().length === 1);
      const result = await run('/x/a', `lock_acquire ${command}`);
      expect(result.status).toBe(0);
    },
  );

  it.each([
    { label: 'an exited process', ticket: (): string => `${spawnSync('true').pid}-1` },
    { label: 'a pid now running another process', ticket: (): string => `${process.pid}-1` },
  ])('prunes the ticket of $label', async ({ ticket }) => {
    const name = `${String(Date.now() * 1_000_000).padStart(20, '0')}-${ticket()}`;
    mkdirSync(path.join(lockDir(), 'run.queue'), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(lockDir(), 'run.queue', name), '{}\n');
    const result = await run('/x/c', 'lock_acquire up');
    expect(result.status).toBe(0);
    expect(tickets()).toEqual([]);
  });
});

describe('teardown recovery', () => {
  it.each([
    { mode: 'failed' as const, reason: ') did not finish; failed steps: database-restore, muraWRM-mapping: run /x/a/' },
    { mode: 'killed' as const, reason: ') did not finish: run /x/a/' },
  ])('holds the stack of a $mode teardown against other checkouts', async ({ mode, reason }) => {
    await brokenTeardown(mode);
    for (const command of ['up', 'down', 'clean-checkout-proof']) {
      const result = await run('/x/b', `lock_acquire ${command}`, { OPT2_LOCK_WAIT: command === 'up' ? '1' : '0' });
      expect(result.status, command).toBe(1);
      expect(result.stderr, command).toMatch(/the OPT-2 stack of \/x\/a needs recovery: its down\.sh \(pid \d+, since /);
      expect(result.stderr, command).toContain(`${reason}harness/repro/down.sh`);
    }
  });

  it.each(['up', 'test-all', 'clean-checkout-proof'])('refuses %s in the checkout whose teardown failed', async (command) => {
    await brokenTeardown('failed');
    const result = await run('/x/a', `lock_acquire ${command}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the OPT-2 stack of /x/a needs recovery');
  });

  it('lets down.sh of that checkout retry and release the lock', async () => {
    await brokenTeardown('killed');
    const result = await run('/x/a', 'lock_acquire down; lock_teardown_begin; lock_release');
    expect(result.status).toBe(0);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('takes over a stale record of another checkout when a teardown begins', async () => {
    staleLock('/x/other');
    const result = await run('/x/a', 'lock_acquire down; lock_teardown_begin; echo "pid $$"');
    expect(result.status).toBe(0);
    const pid = Number(/^pid (\d+)$/m.exec(result.stdout)?.[1]);
    expect(readLock()).toMatchObject({ checkout: '/x/a', command: 'down', pid, teardown: { pid, state: 'running' } });
  });
});

describe('run lock record', () => {
  it('is written by lock_claim_stack only, and a refused rerun leaves it alone', async () => {
    expect((await run('/x/a', 'lock_acquire up')).status).toBe(0);
    expect(existsSync(lockFile())).toBe(false);

    const claimed = await run('/x/a', 'lock_acquire up; lock_claim_stack; echo "pid $$"');
    const pid = Number(/^pid (\d+)$/m.exec(claimed.stdout)?.[1]);
    const record = readLock();
    expect(record).toMatchObject({ checkout: '/x/a', stateDir: stateDir('/x/a'), pid, command: 'up' });
    expect(statSync(lockFile()).mode & 0o777).toBe(0o600);

    liveStack('/x/a');
    expect((await run('/x/a', 'lock_acquire up; exit 1')).status).toBe(1);
    expect(readLock()).toEqual(record);
    const other = await run('/x/b', 'lock_acquire up');
    expect(other.stderr).toContain(`the live OPT-2 stack of /x/a (command up, pid ${pid},`);
  });

  it.each(['test-all', 'down'])("leaves another checkout's stale record to %s", async (command) => {
    staleLock('/x/other');
    const before = readFileSync(lockFile(), 'utf8');
    expect((await run('/x/a', `lock_acquire ${command}`)).status).toBe(0);
    expect(readFileSync(lockFile(), 'utf8')).toBe(before);
  });

  it.each([
    { state: 'absent', setup: async (): Promise<void> => {}, error: null },
    { state: 'a stale record of another checkout', setup: async (): Promise<void> => staleLock('/x/other'), error: null },
    {
      state: "this checkout's record",
      setup: async (): Promise<void> => void (await run('/x/a', 'lock_acquire up; lock_claim_stack')),
      error: "still records this checkout's stack",
    },
    {
      state: "another checkout's live stack",
      setup: async (): Promise<void> => {
        liveStack('/x/other');
        await run('/x/other', 'lock_acquire up; lock_claim_stack');
      },
      error: 'the live OPT-2 stack of /x/other',
    },
  ])('lock_assert_stack_free with $state', async ({ setup, error }) => {
    await setup();
    const result = await run('/x/a', 'lock_assert_stack_free');
    expect(result.status).toBe(error === null ? 0 : 1);
    if (error !== null) expect(result.stderr).toContain(error);
  });
});

describe('down.sh with nothing to tear down', () => {
  it.each([
    {
      label: "another checkout's command holds the flock over its live stack",
      setup: async (): Promise<void> => void (await hold('/x/other', 'lock_acquire up; lock_claim_stack')),
    },
    { label: 'another checkout left a stale run lock', setup: async (): Promise<void> => staleLock('/x/other') },
  ])('exits 0 before the lock when $label', async ({ setup }) => {
    await setup();
    const before = readFileSync(lockFile(), 'utf8');
    const env = commandEnv('/x/none', {
      OPT2_STATE_DIR: path.join(home, 'empty-state'),
      OPT2_PRISTINE_DIR: path.join(home, 'pristine'),
    });
    const down = await launch(DOWN_SH, [], env, 'ignore').done;
    expect(down.status).toBe(0);
    expect(down.stdout).toContain(`OPT-2 stack down: nothing running for ${realpathSync(repoPath())}`);
    expect(readFileSync(lockFile(), 'utf8')).toBe(before);
  });
});
