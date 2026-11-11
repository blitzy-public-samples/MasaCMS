import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { open, readFile, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { z } from '@opt2/platform/service-kit';

import { superviseChild, type SuperviseOptions } from '../legacy/restart.js';
import { upJsonPath } from '../paths.js';
import { LOG_SANITIZER_SECRETS_ENV, logSanitizerPath, secretValues } from './log-sanitizer.js';
import { listeningOwner, processStartTime } from './proc-identity.js';

const OUTPUT_TAIL_BYTES = 8 * 1024;
const STOP_POLL_MS = 100;
const HEALTH_POLL_MS = 250;

/** One process `harness/repro/up.sh` started; an array `command` is an argv, a string runs through a shell. */
export interface UpProcessEntry {
  pid: number;
  port?: number;
  cwd: string;
  command: string | string[];
  env?: Record<string, string>;
  log?: string;
}

// `.loose()` (zod 4's passthrough) keeps every key up.sh writes, so a rewrite of up.json changes only the pid.
const entrySchema = z
  .object({
    // Positive only: signalling pid 0 or a negative pid would reach a whole process group.
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65_535).optional(),
    cwd: z.string().refine((value) => path.isAbsolute(value), 'must be an absolute path'),
    command: z.union([z.string().min(1), z.tuple([z.string().min(1)], z.string())]),
    env: z.record(z.string(), z.string()).optional(),
    log: z.string().min(1).optional(),
  })
  .loose();

/** Schema of `${OPT2_STATE_DIR}/up.json`, keyed by package name under `processes`; other keys are kept as written. */
export const upJsonSchema = z.object({ processes: z.record(z.string(), entrySchema) }).loose();

/** Parsed `up.json`. */
export type UpJson = z.output<typeof upJsonSchema>;

type ParsedEntry = z.output<typeof entrySchema>;

/** Field of an up.json entry that an operation needs. */
export type ProcessEntryField = 'port' | 'env';

/** The named process is not in up.json (`field` undefined), or its entry lacks `field`. */
export class ProcessEntryError extends Error {
  // `name` stays the error class, as on every error here, so the process name is `processName`.
  override readonly name = 'ProcessEntryError';
  readonly processName: string;
  readonly field: ProcessEntryField | undefined;

  constructor(processName: string, file: string, field?: ProcessEntryField) {
    super(
      field === undefined
        ? `No process "${processName}" in ${file}`
        : `Process "${processName}" in ${file} records no ${field}`,
    );
    this.processName = processName;
    this.field = field;
  }
}

/** Step of a restart or health check. */
export type ProcessControlStep = 'stop' | 'start' | 'health';

/** A stop, start or health step that failed for the named process. */
export class ProcessControlError extends Error {
  override readonly name = 'ProcessControlError';
  readonly processName: string;
  readonly step: ProcessControlStep;

  constructor(processName: string, step: ProcessControlStep, message: string, cause?: unknown) {
    super(`${processName} ${step}: ${message}`, cause === undefined ? undefined : { cause });
    this.processName = processName;
    this.step = step;
  }
}

/** Result of a child run; the tails are the last 8 KiB of each stream. */
export interface ChildOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
}

/** Signals `pid`; signal 0 only probes that it exists. */
export type KillFunction = (pid: number, signal: NodeJS.Signals | 0) => unknown;

/** Options of {@link createProcessControl}; the functions replace their Node defaults and `procRoot` `/proc`. */
export interface ProcessControlOptions {
  stateDir: string;
  spawn?: typeof nodeSpawn;
  kill?: KillFunction;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  procRoot?: string;
}

/** Budgets of one restart; `healthTimeoutMs` defaults to `timeoutMs`. */
export interface ProcessRestartOptions {
  timeoutMs: number;
  healthTimeoutMs?: number;
}

/** Outcome of one restart. */
export interface ProcessRestartResult {
  name: string;
  oldPid: number;
  newPid: number;
  stoppedMs: number;
  healthyMs: number;
}

/** Budget and poll interval of a health wait; `intervalMs` defaults to 250. */
export interface WaitHealthyOptions {
  timeoutMs: number;
  intervalMs?: number;
}

/** Local process port over the up.json record. */
export interface ProcessControl {
  /** The named entry; throws {@link ProcessEntryError} when it is absent. */
  entry(name: string): UpProcessEntry;
  /** `process.env` with the entry's recorded `env` merged over it. */
  envOf(name: string): NodeJS.ProcessEnv;
  /** SIGTERMs the process once verified to own its port, starts its command again and waits for `/healthz`. */
  restart(name: string, options: ProcessRestartOptions): Promise<ProcessRestartResult>;
  /** Milliseconds until `http://127.0.0.1:<port>/healthz` answered 200. */
  waitHealthy(name: string, options: WaitHealthyOptions): Promise<number>;
}

/** An up.json document with the entry one call reads. */
interface LocatedEntry {
  file: string;
  doc: UpJson;
  entry: ParsedEntry;
}

/** A process as verified before it is signalled; the same pid with another start time is a different process. */
interface VerifiedProcess {
  pid: number;
  startTime: string;
}

/** Pending up.json rewrites by canonical file path, shared by every control so that rewrites never interleave. */
const upJsonWrites = new Map<string, Promise<void>>();

/** Runs `task` after every task queued earlier under `key`; the key is dropped once its queue drains. */
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (upJsonWrites.get(key) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  upJsonWrites.set(key, settled);
  try {
    return await run;
  } finally {
    if (upJsonWrites.get(key) === settled) upJsonWrites.delete(key);
  }
}

/** The `name` entry of the up.json `text` read from `file`, validated against {@link upJsonSchema}. */
function locate(file: string, text: string, name: string): LocatedEntry {
  const parsed = upJsonSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid ${file}: ${z.prettifyError(parsed.error)}`);
  const doc = parsed.data;
  const entry = Object.hasOwn(doc.processes, name) ? doc.processes[name] : undefined;
  if (entry === undefined) throw new ProcessEntryError(name, file);
  return { file, doc, entry };
}

/** Replaces `file` with `text` through a sibling created exclusively with mode 0600 and renamed over it. */
async function replaceFile(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // A fresh file takes `mode`, and up.json must stay private: recorded env values may hold role passwords.
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Process control over `${stateDir}/up.json`, which is re-read on every call. */
export function createProcessControl(options: ProcessControlOptions): ProcessControl {
  const spawn = options.spawn ?? nodeSpawn;
  const kill: KillFunction = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const procRoot = options.procRoot ?? '/proc';

  /** Synchronous read, for the accessors that return values. */
  function find(name: string): LocatedEntry {
    const file = upJsonPath(options.stateDir);
    return locate(file, readFileSync(file, 'utf8'), name);
  }

  async function findAsync(name: string): Promise<LocatedEntry> {
    const file = upJsonPath(options.stateDir);
    return locate(file, await readFile(file, 'utf8'), name);
  }

  /** Sends `signal` to `pid`; false when the process no longer exists. */
  function signalPid(name: string, pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
      kill(pid, signal);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return false;
      throw new ProcessControlError(name, 'stop', `cannot signal pid ${pid}`, error);
    }
  }

  async function startTimeOf(name: string, pid: number): Promise<string | undefined> {
    try {
      return await processStartTime(procRoot, pid);
    } catch (error) {
      throw new ProcessControlError(name, 'stop', `cannot read the identity of pid ${pid} under ${procRoot}`, error);
    }
  }

  /** The recorded process and, when another member of its tree holds the port, that holder; empty once it is gone. */
  async function verifiedTargets(name: string, pid: number, port: number): Promise<VerifiedProcess[]> {
    const startTime = await startTimeOf(name, pid);
    if (startTime === undefined) {
      // A pid that answers while procRoot has no entry for it cannot be identified, so it is never signalled.
      if (signalPid(name, pid, 0)) {
        throw new ProcessControlError(name, 'stop', `pid ${pid} is not listed under ${procRoot}; cannot verify it`);
      }
      return [];
    }
    let holder: number | undefined;
    try {
      holder = await listeningOwner(procRoot, pid, port);
    } catch (error) {
      const message = `cannot verify under ${procRoot} that pid ${pid} owns port ${port}`;
      throw new ProcessControlError(name, 'stop', message, error);
    }
    if (holder === undefined) {
      throw new ProcessControlError(name, 'stop', `pid ${pid} does not own port ${port}; the up.json record is stale`);
    }
    const root = { pid, startTime };
    const holderStart = holder === pid ? undefined : await startTimeOf(name, holder);
    return holderStart === undefined ? [root] : [root, { pid: holder, startTime: holderStart }];
  }

  /** First target still running as the process that was verified; a reused pid has another start time. */
  async function firstRunning(name: string, targets: VerifiedProcess[]): Promise<VerifiedProcess | undefined> {
    for (const target of targets) {
      if (signalPid(name, target.pid, 0) && (await startTimeOf(name, target.pid)) === target.startTime) return target;
    }
    return undefined;
  }

  async function stop(name: string, pid: number, port: number, timeoutMs: number): Promise<number> {
    const startedAt = performance.now();
    const targets = await verifiedTargets(name, pid, port);
    // Re-checked right before each signal, so SIGTERM reaches only a process whose identity was verified.
    for (const target of targets) {
      if ((await firstRunning(name, [target])) !== undefined) signalPid(name, target.pid, 'SIGTERM');
    }
    for (;;) {
      const running = await firstRunning(name, targets);
      if (running === undefined) return Math.round(performance.now() - startedAt);
      const remaining = timeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        throw new ProcessControlError(name, 'stop', `pid ${running.pid} still running ${timeoutMs} ms after SIGTERM`);
      }
      await sleep(Math.min(STOP_POLL_MS, remaining));
    }
  }

  /** Runs `run`, mapping a throw or an asynchronous spawn error to ProcessControlError(start). */
  async function spawned(
    name: string,
    what: string,
    run: () => ChildProcess,
  ): Promise<{ child: ChildProcess; pid: number }> {
    let child: ChildProcess;
    try {
      child = run();
    } catch (error) {
      throw new ProcessControlError(name, 'start', `cannot run ${what}`, error);
    }
    const pid = child.pid;
    if (pid === undefined) {
      const [error] = (await once(child, 'error')) as [unknown];
      throw new ProcessControlError(name, 'start', `${what} could not be spawned`, error);
    }
    return { child, pid };
  }

  async function launch(name: string, entry: ParsedEntry, options: SpawnOptions): Promise<number> {
    const { child, pid } = await spawned(name, 'the start command', () =>
      typeof entry.command === 'string'
        ? spawn(entry.command, { ...options, shell: true })
        : spawn(entry.command[0], entry.command.slice(1), options),
    );
    child.unref();
    return pid;
  }

  /** Starts the command writing into a pipe that a detached log sanitizer masks into the log descriptor `logFd`. */
  async function launchLogged(name: string, entry: ParsedEntry, options: SpawnOptions, logFd: number): Promise<number> {
    const { child: sanitizer } = await spawned(name, 'the log sanitizer', () =>
      spawn(process.execPath, [logSanitizerPath()], {
        detached: true,
        stdio: ['pipe', logFd, logFd],
        // In the environment, which only the same user can read, and not in argv.
        env: { [LOG_SANITIZER_SECRETS_ENV]: JSON.stringify(secretValues(process.env, entry.env)) },
      }),
    );
    const input = sanitizer.stdin;
    try {
      if (input === null) throw new ProcessControlError(name, 'start', 'the log sanitizer has no input pipe');
      return await launch(name, entry, { ...options, stdio: ['ignore', input, input] });
    } catch (error) {
      sanitizer.kill('SIGTERM');
      throw error;
    } finally {
      // The command holds its own end of the pipe, so the sanitizer reads until the command exits.
      input?.destroy();
      sanitizer.unref();
    }
  }

  async function start(name: string, entry: ParsedEntry): Promise<number> {
    const env = { ...process.env, ...entry.env };
    const options: SpawnOptions = { cwd: entry.cwd, env, detached: true, stdio: 'ignore' };
    if (entry.log === undefined) return launch(name, entry, options);
    let log: FileHandle;
    try {
      log = await open(path.resolve(entry.cwd, entry.log), 'a', 0o600);
    } catch (error) {
      throw new ProcessControlError(name, 'start', 'cannot run the start command', error);
    }
    try {
      return await launchLogged(name, entry, options, log.fd);
    } finally {
      // Each child holds its own copy of the descriptor.
      await log.close();
    }
  }

  async function pollHealth(name: string, port: number, timeoutMs: number, intervalMs: number): Promise<number> {
    const url = `http://127.0.0.1:${port}/healthz`;
    const startedAt = performance.now();
    let lastFailure: unknown;
    for (;;) {
      const remaining = timeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        throw new ProcessControlError(name, 'health', `${url} did not answer 200 within ${timeoutMs} ms`, lastFailure);
      }
      try {
        // Bounded per attempt, so a process that accepts but never answers cannot outlast the budget.
        const response = await fetchFn(url, { signal: AbortSignal.timeout(Math.ceil(remaining)) });
        await response.body?.cancel();
        if (response.status === 200) return Math.round(performance.now() - startedAt);
        lastFailure = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastFailure = error;
      }
      await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (performance.now() - startedAt))));
    }
  }

  /** Replaces the entry's pid, re-read in up.json's write queue so that concurrent restarts keep each other's pids. */
  async function recordPid(name: string, pid: number): Promise<void> {
    const file = upJsonPath(options.stateDir);
    const key = path.join(await realpath(path.dirname(file)), path.basename(file));
    await serialized(key, async () => {
      const { doc, entry } = await findAsync(name);
      const next: UpJson = { ...doc, processes: { ...doc.processes, [name]: { ...entry, pid } } };
      await replaceFile(file, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  return {
    entry: (name) => find(name).entry,

    envOf(name) {
      const { file, entry } = find(name);
      if (entry.env === undefined) throw new ProcessEntryError(name, file, 'env');
      return { ...process.env, ...entry.env };
    },

    async restart(name, { timeoutMs, healthTimeoutMs = timeoutMs }) {
      const { file, entry } = await findAsync(name);
      // Checked before SIGTERM, so a process whose health cannot be checked is never stopped.
      if (entry.port === undefined) throw new ProcessEntryError(name, file, 'port');
      const stoppedMs = await stop(name, entry.pid, entry.port, timeoutMs);
      const newPid = await start(name, entry);
      // Recorded before the health wait, so up.json names the running process even when it never turns healthy.
      await recordPid(name, newPid);
      const healthyMs = await pollHealth(name, entry.port, healthTimeoutMs, HEALTH_POLL_MS);
      return { name, oldPid: entry.pid, newPid, stoppedMs, healthyMs };
    },

    async waitHealthy(name, { timeoutMs, intervalMs = HEALTH_POLL_MS }) {
      const { file, entry } = await findAsync(name);
      if (entry.port === undefined) throw new ProcessEntryError(name, file, 'port');
      return pollHealth(name, entry.port, timeoutMs, intervalMs);
    },
  };
}

/** Options of {@link spawnChild}; `env` is passed to the child exactly as given. */
export interface SpawnChildOptions extends SuperviseOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  spawn?: typeof nodeSpawn;
}

/** Runs `command` without a shell in its own process group and resolves with its outcome, whatever the exit code. */
export async function spawnChild(
  command: string,
  args: readonly string[],
  options: SpawnChildOptions,
): Promise<ChildOutcome> {
  const spawn = options.spawn ?? nodeSpawn;
  const stdout = outputTail();
  const stderr = outputTail();
  // Detached, so a timeout terminates the child's whole process group.
  const child = spawn(command, args, {
    env: options.env,
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', stdout.push);
  child.stderr.on('data', stderr.push);
  const { exitCode, signal, timedOut } = await superviseChild(child, options);
  return { exitCode, signal, timedOut, stdoutTail: stdout.text(), stderrTail: stderr.text() };
}

/** Path of the `opt2-migrate` CLI beside this package's `src`/`dist` root. */
export function migrateCliPath(): string {
  return fileURLToPath(new URL('../cli.js', import.meta.url));
}

/** Path of the platform's `opt2-outbox` CLI, next to the resolved `@opt2/platform/outbox` entry. */
export function outboxCliPath(): string {
  const outboxEntry = createRequire(import.meta.url).resolve('@opt2/platform/outbox');
  return path.join(path.dirname(outboxEntry), 'cli.js');
}

/** Keeps the last 8 KiB written to a stream. */
function outputTail(): { push: (chunk: Buffer | string) => void; text: () => string } {
  let kept = Buffer.alloc(0);
  return {
    push: (chunk) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const joined = Buffer.concat([kept, bytes.subarray(Math.max(0, bytes.length - OUTPUT_TAIL_BYTES))]);
      kept = joined.subarray(Math.max(0, joined.length - OUTPUT_TAIL_BYTES));
    },
    text: () => kept.toString('utf8'),
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}
