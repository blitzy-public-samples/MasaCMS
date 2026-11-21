/** Source of the current time, injected wherever code reads the clock. */
export interface Clock {
  now(): Date;
}

/** Clock backed by the host's system time. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** Clock frozen at one instant; each call returns a fresh Date. Throws TypeError when `at` is not a valid date. */
export function fixedClock(at: Date | string | number): Clock {
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`Invalid date for fixedClock: ${String(at)}`);
  }
  return { now: () => new Date(ms) };
}

/** Structural check that a value exposes a callable `now`. */
export function isClock(value: unknown): value is Clock {
  return typeof value === 'object' && value !== null && typeof (value as { now?: unknown }).now === 'function';
}
