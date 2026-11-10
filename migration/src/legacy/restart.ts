import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

import type { MigrationEnv } from '../env.js';

const OUTPUT_TAIL_BYTES = 8 * 1024;

/** Options for one controlled legacy restart. */
export interface RestartOptions {
  /** Budget for the whole restart; the child receives SIGTERM when it elapses. */
  timeoutMs: number;
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

  return new Promise<LegacyRestartResult>((resolve, reject) => {
    let tail = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const collect = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const joined = Buffer.concat([tail, bytes.subarray(Math.max(0, bytes.length - OUTPUT_TAIL_BYTES))]);
      tail = joined.subarray(Math.max(0, joined.length - OUTPUT_TAIL_BYTES));
    };

    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };

    const fail = (message: string, status: FailureStatus, cause?: unknown): void => {
      settle(() => {
        const failure = { ...status, outputTail: tail.toString('utf8') };
        reject(new LegacyRestartError(message, failure, cause === undefined ? undefined : { cause }));
      });
    };

    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.extraEnv },
      });
    } catch (error) {
      fail('Legacy restart command could not be started', NOT_STARTED, error);
      return;
    }

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    // `on`, not `once`: a later 'error' (for example a failed kill) without a listener would crash the process.
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === undefined ? '' : ` (${error.code})`;
      fail(`Legacy restart command could not be run${code}`, NOT_STARTED, error);
    });
    // 'close', not 'exit': 'exit' can fire before the last stdout and stderr reads, truncating the tail.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        settle(() => resolve({ exitCode: 0, durationMs: Math.round(performance.now() - startedAt) }));
      } else if (signal !== null) {
        fail(`Legacy restart command was terminated by ${signal}`, { exitCode: code, signal, timedOut: false });
      } else {
        fail(`Legacy restart command exited with code ${code}`, { exitCode: code, signal: null, timedOut: false });
      }
    });

    timer = setTimeout(() => {
      // Settled before the kill, so an 'error' the kill may emit cannot reclassify the timeout.
      fail(`Legacy restart command did not finish within ${options.timeoutMs} ms; sent SIGTERM`, {
        exitCode: null,
        signal: null,
        timedOut: true,
      });
      child.kill('SIGTERM');
    }, options.timeoutMs);
  });
}
