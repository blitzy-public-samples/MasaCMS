// Controlled legacy restart through the legacy barrel: a run past its budget whose process group is gone at SIGKILL.
// legacy-restart.test.ts covers availability, exit 0, non-zero exits, signals, spawn errors and the other timeout
// paths, so those cases are not repeated here.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LegacyRestartError, restartLegacy, type RestartOptions, type SignalFunction } from '../../src/legacy/index.js';

const COMMAND = 'harness/repro/lib/legacy-start.sh restart';
const PID = 4242;
const TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 5_000;
const DRAIN_MS = 1_000;
const OUTPUT = 'waiting for ColdFusion\n';

/** Output stream surface: data events and `destroy`. */
class FakeStream extends EventEmitter {
  readonly destroy = vi.fn();
}

/** Child process surface the restart drives: output streams, lifecycle events, `kill` and `pid`. */
class FakeChild extends EventEmitter {
  readonly pid = PID;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);
}

/** Group `kill` that delivers SIGTERM and every probe, then finds the group gone (ESRCH) when SIGKILL is sent. */
function groupGoneAtKill() {
  return vi.fn<SignalFunction>((_pid, signal) => {
    if (signal === 'SIGKILL') throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    return true;
  });
}

interface GoneAtKillCase {
  label: string;
  /** Signal of a `close` observed during the grace period; null when the output never closes. */
  closeSignal: NodeJS.Signals | null;
  /** Wait between the SIGKILL attempt and settlement. */
  settleAfterKillMs: number;
  /** `destroy` calls per output stream. */
  streamsDestroyed: number;
}

const GONE_AT_KILL: GoneAtKillCase[] = [
  {
    label: 'the command closed during the grace period',
    closeSignal: 'SIGTERM',
    settleAfterKillMs: 0,
    streamsDestroyed: 0,
  },
  { label: 'the output never closes', closeSignal: null, settleAfterKillMs: DRAIN_MS, streamsDestroyed: 1 },
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('restartLegacy past its budget', () => {
  it.each(GONE_AT_KILL)(
    'rejects as timed out, never as evidence, when the process group is gone at SIGKILL and $label',
    async ({ closeSignal, settleAfterKillMs, streamsDestroyed }) => {
      vi.useFakeTimers();
      const child = new FakeChild();
      const spawn = vi.fn<(command: string, options: SpawnOptions) => ChildProcess>(
        () => child as unknown as ChildProcess,
      );
      const kill = groupGoneAtKill();

      const outcome = restartLegacy(
        { OPT2_LEGACY_RESTART_CMD: COMMAND },
        { timeoutMs: TIMEOUT_MS, spawn: spawn as unknown as NonNullable<RestartOptions['spawn']>, kill },
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      child.stdout.emit('data', Buffer.from(OUTPUT));

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      if (closeSignal !== null) {
        child.emit('exit', null, closeSignal);
        child.emit('close', null, closeSignal);
      }
      await vi.advanceTimersByTimeAsync(TERM_GRACE_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      if (settleAfterKillMs > 0) {
        await vi.advanceTimersByTimeAsync(settleAfterKillMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      const error = await outcome;

      expect(error).toBeInstanceOf(LegacyRestartError);
      expect(error).toMatchObject({
        name: 'LegacyRestartError',
        message: `Legacy restart command did not finish within ${String(TIMEOUT_MS)} ms; its process group was terminated`,
        exitCode: null,
        signal: closeSignal,
        timedOut: true,
        outputTail: OUTPUT,
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      // Termination signals the command's whole process group through `kill`, never the shell alone.
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [-PID, 'SIGTERM'],
        [-PID, 'SIGKILL'],
      ]);
      expect(kill.mock.calls.every(([pid]) => pid === -PID)).toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.stdout.destroy).toHaveBeenCalledTimes(streamsDestroyed);
      expect(child.stderr.destroy).toHaveBeenCalledTimes(streamsDestroyed);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
