// Legacy's session timeout as the gateway reads it, and jar activity recorded from the session state checks.
import { serializeError } from '@opt2/platform/logging';
import type { Clock } from '@opt2/platform/service-kit';
import type { LegacyJar } from './jar.js';
import type { SessionStateChecker } from './state-check.js';

/** Masa's `sessionTimeout` in minutes when unset [legacy: core/appcfc/applicationSettings.cfm:310-311]. */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 180;

/** Least time between two activity writes of one session's jar by one instance; identity throttles its own to the same interval. */
export const JAR_ACTIVITY_INTERVAL_MS = 60_000;

/** Masa's `sessionTimeout` minutes from its setting: unset, blank, or below 1 gives 180 [legacy: core/appcfc/applicationSettings.cfm:310-311]. */
export function sessionTimeoutMinutes(setting: string | undefined): number {
  const minutes = setting === undefined || setting.trim() === '' ? Number.NaN : Number(setting);
  return minutes >= 1 ? minutes : DEFAULT_SESSION_TIMEOUT_MINUTES;
}

/**
 * Idle time after which a jar is purged: identity ends a session one interval past the timeout, and the jar, whose
 * activity may lag one more interval, outlives it.
 */
export function jarIdleLimitMs(timeoutMinutes: number): number {
  return timeoutMinutes * 60_000 + 2 * JAR_ACTIVITY_INTERVAL_MS;
}

/** Receives a failed activity write. */
export interface JarActivityLogger {
  warn(obj: object, msg: string): void;
}

/** Dependencies of {@link trackJarActivity}. */
export interface JarActivityOptions {
  states: SessionStateChecker;
  jar: Pick<LegacyJar, 'markActive'>;
  clock: Clock;
  logger: JarActivityLogger;
}

/** `states`, with each check that finds the session active also recording its jar's activity, at most once per interval. */
export function trackJarActivity(opts: JarActivityOptions): SessionStateChecker {
  const { states, jar, clock, logger } = opts;
  // Recording re-inserts the key, so the sessions written longest ago sit at the head of the map.
  const written = new Map<string, number>();

  /** Forgets sessions written an interval or more ago, whose next active check writes again anyway. */
  function pruneDue(now: number): void {
    for (const [sessionId, at] of written) {
      if (now - at < JAR_ACTIVITY_INTERVAL_MS) return;
      written.delete(sessionId);
    }
  }

  async function recordActivity(sessionId: string): Promise<void> {
    const now = clock.now().getTime();
    pruneDue(now);
    const last = written.get(sessionId);
    // A clock stepped back never extends the interval.
    if (last !== undefined && now - last >= 0 && now - last < JAR_ACTIVITY_INTERVAL_MS) return;
    written.delete(sessionId);
    written.set(sessionId, now);
    try {
      await jar.markActive(sessionId);
    } catch (error) {
      // The request does not depend on it; the session's next active check writes again.
      if (written.get(sessionId) === now) written.delete(sessionId);
      logger.warn({ error: serializeError(error) }, 'legacy jar activity write failed');
    }
  }

  return {
    async check(sessionId) {
      const check = await states.check(sessionId);
      if (check.state === 'active') await recordActivity(sessionId);
      return check;
    },

    forget(sessionId) {
      written.delete(sessionId);
      states.forget(sessionId);
    },
  };
}
