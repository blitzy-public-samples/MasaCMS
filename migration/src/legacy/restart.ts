import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import type { MigrationEnv } from '../env.js';

const OUTPUT_TAIL_BYTES = 8 * 1024;
const TERM_GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const DRAIN_MS = 1_000;
const GROUP_PROBE_MS = 100;

/** Signals `pid`, a negative pid addressing a process group; signal 0 only probes that it exists. */
export type SignalFunction = (pid: number, signal: NodeJS.Signals | 0) => unknown;

/** Budget of a supervised child and the bounds of terminating its process group. */
export interface SuperviseOptions {
  /** Budget after which the child's process group receives SIGTERM. */
  timeoutMs: number;
  /** Wait between SIGTERM and SIGKILL; defaults to 5000. */
  termGraceMs?: number;
  /** Wait after SIGKILL for the group to disappear; defaults to 2000. */
  killWaitMs?: number;
  /** Wait for the output streams to close once the child has exited or its group is gone; defaults to 1000. */
  drainMs?: number;
  /** Replaces `process.kill`. */
  kill?: SignalFunction;
}

/** How a supervised child ended; `exitCode` and `signal` stay null until observed. */
export type SupervisedEnd =
  | { timedOut: false; exitCode: number | null; signal: NodeJS.Signals | null }
  | {
      timedOut: true;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      /** False only when the process group outlived SIGKILL and the post-KILL wait. */
      groupGone: boolean;
    };

/** Options for one controlled legacy restart. */
export interface RestartOptions extends SuperviseOptions {
  /** Variables merged over `process.env` for the child. */
  extraEnv?: Record<string, string>;
  /** Replaces `node:child_process` `spawn`. */
  spawn?: typeof nodeSpawn;
}

/** Outcome of a restart command that exited 0. */
export interface LegacyRestartResult {
  exitCode: 0;
  durationMs: number;
}

/** Raised when `OPT2_LEGACY_RESTART_CMD` is unset or blank, so no restart can be run. */
export class RestartUnavailableError extends Error {
  override readonly name = 'RestartUnavailableError';

  constructor() {
    super('OPT2_LEGACY_RESTART_CMD is not set; no controlled legacy restart is available');
  }
}

/** Raised when the restart command cannot run, exits non-zero, is killed by a signal or exceeds its budget. */
export class LegacyRestartError extends Error {
  override readonly name = 'LegacyRestartError';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  /** Last 8 KiB of the command's combined stdout and stderr. */
  readonly outputTail: string;

  constructor(
    message: string,
    failure: Pick<LegacyRestartError, 'exitCode' | 'signal' | 'timedOut' | 'outputTail'>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.exitCode = failure.exitCode;
    this.signal = failure.signal;
    this.timedOut = failure.timedOut;
    this.outputTail = failure.outputTail;
  }
}

type FailureStatus = Pick<LegacyRestartError, 'exitCode' | 'signal' | 'timedOut'>;

const NOT_STARTED: FailureStatus = { exitCode: null, signal: null, timedOut: false };

/**
 * Waits for a child spawned with `detached: true`; past `timeoutMs` its process group gets SIGTERM, then SIGKILL,
 * and the promise settles once the group is gone or the post-KILL wait elapses. Rejects only with an early 'error'.
 */
export function superviseChild(child: ChildProcess, options: SuperviseOptions): Promise<SupervisedEnd> {
  const kill: SignalFunction = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const termGraceMs = options.termGraceMs ?? TERM_GRACE_MS;
  const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
  const drainMs = options.drainMs ?? DRAIN_MS;

  return new Promise<SupervisedEnd>((resolve, reject) => {
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let closed = false;
    let settled = false;
    let timedOut = false;
    let groupGone = false;
    let drain: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let killWait: NodeJS.Timeout | undefined;
    let probe: NodeJS.Timeout | undefined;

    const stopTermination = (): void => {
      clearInterval(probe);
      clearTimeout(grace);
      clearTimeout(killWait);
    };

    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      clearTimeout(drain);
      stopTermination();
      outcome();
    };

    const end = (): void => {
      settle(() => {
        // Releases pipes that a surviving descendant still holds open.
        if (!closed) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        resolve(timedOut ? { timedOut, exitCode, signal, groupGone } : { timedOut, exitCode, signal });
      });
    };

    const endAfterDrain = (): void => {
      if (closed) end();
      else drain = setTimeout(end, drainMs);
    };

    /** Signals the child's process group; false once the group no longer exists. */
    const signalGroup = (groupSignal: NodeJS.Signals | 0): boolean => {
      if (child.pid === undefined) return false;
      try {
        kill(-child.pid, groupSignal);
        return true;
      } catch (error) {
        // Only ESRCH proves the group is gone; any other failure leaves settlement to the bounded waits.
        return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
      }
    };

    const groupEnded = (): void => {
      groupGone = true;
      stopTermination();
      endAfterDrain();
    };

    const terminate = (): void => {
      timedOut = true;
      if (!signalGroup('SIGTERM')) return groupEnded();
      probe = setInterval(() => {
        if (!signalGroup(0)) groupEnded();
      }, GROUP_PROBE_MS);
      grace = setTimeout(() => {
        if (!signalGroup('SIGKILL')) return groupEnded();
        killWait = setTimeout(() => (signalGroup(0) ? end() : groupEnded()), killWaitMs);
      }, termGraceMs);
    };

    // `on`, not `once`: a later 'error' without a listener would crash this process.
    child.on('error', (error) => {
      if (!timedOut) settle(() => reject(error));
    });
    child.on('exit', (code: number | null, exitSignal: NodeJS.Signals | null) => {
      exitCode = code;
      signal = exitSignal;
      if (timedOut) return;
      // The command finished within its budget; descendants it left running are not signalled.
      clearTimeout(budget);
      endAfterDrain();
    });
    // 'close' follows the last stdout and stderr reads, so output tails are complete.
    child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
      closed = true;
      exitCode = code;
      signal = closeSignal;
      if (!timedOut || groupGone) end();
    });
    const budget = setTimeout(terminate, options.timeoutMs);
  });
}

/**
 * Runs `OPT2_LEGACY_RESTART_CMD` through the shell and resolves once it exits 0 within `options.timeoutMs`.
 * Success means every legacy request that was running before the restart has ended.
 */
export async function restartLegacy(
  env: Pick<MigrationEnv, 'OPT2_LEGACY_RESTART_CMD'>,
  options: RestartOptions,
): Promise<LegacyRestartResult> {
  const command = env.OPT2_LEGACY_RESTART_CMD;
  if (command === undefined || command.trim() === '') throw new RestartUnavailableError();
  const spawn = options.spawn ?? nodeSpawn;
  const startedAt = performance.now();
  let tail = Buffer.alloc(0);

  const collect = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const joined = Buffer.concat([tail, bytes.subarray(Math.max(0, bytes.length - OUTPUT_TAIL_BYTES))]);
    tail = joined.subarray(Math.max(0, joined.length - OUTPUT_TAIL_BYTES));
  };

  const failure = (message: string, status: FailureStatus, cause?: unknown): LegacyRestartError =>
    new LegacyRestartError(
      message,
      { ...status, outputTail: tail.toString('utf8') },
      cause === undefined ? undefined : { cause },
    );

  let child: ChildProcess;
  try {
    // Detached, so the command leads its own process group and a timeout can end every process it started.
    child = spawn(command, {
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.extraEnv },
    });
  } catch (error) {
    throw failure('Legacy restart command could not be started', NOT_STARTED, error);
  }

  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let ended: SupervisedEnd;
  try {
    ended = await superviseChild(child, options);
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    const code = errno === undefined ? '' : ` (${errno})`;
    throw failure(`Legacy restart command could not be run${code}`, NOT_STARTED, error);
  }

  const { exitCode, signal } = ended;
  if (ended.timedOut) {
    const group = ended.groupGone
      ? 'its process group was terminated'
      : 'its process group was still present after SIGKILL';
    throw failure(`Legacy restart command did not finish within ${options.timeoutMs} ms; ${group}`, {
      exitCode,
      signal,
      timedOut: true,
    });
  }
  if (exitCode === 0) return { exitCode: 0, durationMs: Math.round(performance.now() - startedAt) };
  if (signal !== null) {
    throw failure(`Legacy restart command was terminated by ${signal}`, { exitCode, signal, timedOut: false });
  }
  throw failure(`Legacy restart command exited with code ${exitCode}`, { exitCode, signal: null, timedOut: false });
}
