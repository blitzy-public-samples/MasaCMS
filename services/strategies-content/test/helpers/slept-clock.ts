/** A faked Date that moves only by the `node:timers/promises` sleeps of the code under test, as the unit-gate poll takes them. */
import { vi } from 'vitest';

type TimersPromises = typeof import('node:timers/promises');

let stepping = false;

/** `node:timers/promises` whose `setTimeout`, inside `underSleptClock`, moves the fake clock by its delay and resolves on the next turn. */
export function sleptTimersPromises(actual: TimersPromises): TimersPromises {
  const setTimeout: TimersPromises['setTimeout'] = (delay, value, options) => {
    if (!stepping) return actual.setTimeout(delay, value, options);
    vi.setSystemTime(Date.now() + (delay ?? 1));
    return actual.setImmediate(value, options);
  };
  return { ...actual, setTimeout };
}

/** Runs `send` with Date faked; `elapsedMs` is the sum of its sleeps, however many turns its other work takes. Needs `sleptTimersPromises` mocked in. */
export async function underSleptClock<R>(send: () => Promise<R>): Promise<{ result: R; elapsedMs: number }> {
  vi.useFakeTimers({ toFake: ['Date'] });
  stepping = true;
  try {
    const started = Date.now();
    const result = await send();
    return { result, elapsedMs: Date.now() - started };
  } finally {
    stepping = false;
    vi.useRealTimers();
  }
}
