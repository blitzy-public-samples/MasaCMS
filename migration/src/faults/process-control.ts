import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { z } from '@opt2/platform/service-kit';

import { upJsonPath } from '../paths.js';

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

/** Options of {@link createProcessControl}; the functions replace their Node defaults. */
export interface ProcessControlOptions {
  stateDir: string;
  spawn?: typeof nodeSpawn;
  kill?: KillFunction;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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
  /** Stops the process with SIGTERM, starts its command again and waits for `/healthz`. */
  restart(name: string, options: ProcessRestartOptions): Promise<ProcessRestartResult>;
  /** Milliseconds until `http://127.0.0.1:<port>/healthz` answered 200. */
  waitHealthy(name: string, options: WaitHealthyOptions): Promise<number>;
}

/** Process control over `${stateDir}/up.json`, which is re-read on every call. */
export function createProcessControl(options: ProcessControlOptions): ProcessControl {
  const spawn = options.spawn ?? nodeSpawn;
  const kill: KillFunction = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));

  function load(): { file: string; doc: UpJson } {
    const file = upJsonPath(options.stateDir);
    const parsed = upJsonSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error(`Invalid ${file}: ${z.prettifyError(parsed.error)}`);
    return { file, doc: parsed.data };
  }

  function find(name: string): { file: string; doc: UpJson; entry: ParsedEntry } {
    const { file, doc } = load();
    const entry = Object.hasOwn(doc.processes, name) ? doc.processes[name] : undefined;
    if (entry === undefined) throw new ProcessEntryError(name, file);
    return { file, doc, entry };
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

  async function stop(name: string, pid: number, timeoutMs: number): Promise<number> {
    const startedAt = performance.now();
    signalPid(name, pid, 'SIGTERM');
    while (signalPid(name, pid, 0)) {
      const remaining = timeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        throw new ProcessControlError(name, 'stop', `pid ${pid} still running ${timeoutMs} ms after SIGTERM`);
      }
      await sleep(Math.min(STOP_POLL_MS, remaining));
    }
    return Math.round(performance.now() - startedAt);
  }

  async function start(name: string, entry: ParsedEntry): Promise<number> {
    let logFd: number | undefined;
    let child: ChildProcess;
    try {
      logFd = entry.log === undefined ? undefined : openSync(path.resolve(entry.cwd, entry.log), 'a');
      const stdio: StdioOptions = logFd === undefined ? 'ignore' : ['ignore', logFd, logFd];
      const spawnOptions: SpawnOptions = { cwd: entry.cwd, env: { ...process.env, ...entry.env }, detached: true, stdio };
      child =
        typeof entry.command === 'string'
          ? spawn(entry.command, { ...spawnOptions, shell: true })
          : spawn(entry.command[0], entry.command.slice(1), spawnOptions);
    } catch (error) {
      throw new ProcessControlError(name, 'start', 'cannot run the start command', error);
    } finally {
      // The child holds its own copy of the descriptor.
      if (logFd !== undefined) closeSync(logFd);
    }
    const pid = child.pid;
    if (pid === undefined) {
      const [error] = (await once(child, 'error')) as [unknown];
      throw new ProcessControlError(name, 'start', 'the start command could not be spawned', error);
    }
    child.unref();
    return pid;
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

  /** Replaces the entry's pid by writing a temporary file and renaming it over up.json. */
  async function recordPid(name: string, pid: number): Promise<void> {
    const { file, doc, entry } = find(name);
    const next: UpJson = { ...doc, processes: { ...doc.processes, [name]: { ...entry, pid } } };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  return {
    entry: (name) => find(name).entry,

    envOf(name) {
      const { file, entry } = find(name);
      if (entry.env === undefined) throw new ProcessEntryError(name, file, 'env');
      return { ...process.env, ...entry.env };
    },

    async restart(name, { timeoutMs, healthTimeoutMs = timeoutMs }) {
      const { file, entry } = find(name);
      // Checked before SIGTERM, so a process whose health cannot be checked is never stopped.
      if (entry.port === undefined) throw new ProcessEntryError(name, file, 'port');
      const stoppedMs = await stop(name, entry.pid, timeoutMs);
      const newPid = await start(name, entry);
      // Recorded before the health wait, so up.json names the running process even when it never turns healthy.
      await recordPid(name, newPid);
      const healthyMs = await pollHealth(name, entry.port, healthTimeoutMs, HEALTH_POLL_MS);
      return { name, oldPid: entry.pid, newPid, stoppedMs, healthyMs };
    },

    async waitHealthy(name, { timeoutMs, intervalMs = HEALTH_POLL_MS }) {
      const { file, entry } = find(name);
      if (entry.port === undefined) throw new ProcessEntryError(name, file, 'port');
      return pollHealth(name, entry.port, timeoutMs, intervalMs);
    },
  };
}

/** Options of {@link spawnChild}; `env` is passed to the child exactly as given. */
export interface SpawnChildOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs: number;
  spawn?: typeof nodeSpawn;
}

/** Runs `command` without a shell and resolves with its outcome, whatever the exit code; SIGTERM on timeout. */
export function spawnChild(command: string, args: readonly string[], options: SpawnChildOptions): Promise<ChildOutcome> {
  const spawn = options.spawn ?? nodeSpawn;
  return new Promise<ChildOutcome>((resolve, reject) => {
    const stdout = outputTail();
    const stderr = outputTail();
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    // `on`, not `once`: a later 'error' (a failed kill) without a listener would crash this process.
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    // 'close', not 'exit', so the tails hold the last output.
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdoutTail: stdout.text(), stderrTail: stderr.text() });
    });
  });
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
