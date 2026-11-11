// Per-session re-check of identity's session state, at most once per second, dropping cached tokens on an epoch change.
import type { Clock } from '@opt2/platform/service-kit';
import type { IdentityClient, SessionState } from './identity-client.js';
import type { TokenCache } from './token-cache.js';

/** Minimum interval between two identity state reads of one session. */
export const STATE_CHECK_INTERVAL_MS = 1000;

/** How long the last observed state of an unchecked session is kept: the longest user-token lifetime, one hour. */
export const STATE_MEMO_RETENTION_MS = 60 * 60 * 1000;

// Identity's SessionState carries no session mode; callers take it from the active cut-over version (`sessionModeFor`).
/** Identity's state of a session, and whether its epoch differs from the one observed before. */
export interface SessionStateCheck extends SessionState {
  epochChanged: boolean;
  /** The epoch observed before this check, present when it changed. */
  previousEpoch?: number;
}

/** Bounded re-check of gateway sessions against identity. */
export interface SessionStateChecker {
  /** The session's state, read from identity at most once per interval; identity reports an unknown session as ended. */
  check(sessionId: string): Promise<SessionStateCheck>;
  /** Forgets the session's observed state, and keeps an in-flight read of it from being recorded. */
  forget(sessionId: string): void;
}

/** Dependencies of {@link createSessionStateChecker}. */
export interface SessionStateCheckerOptions {
  identity: Pick<IdentityClient, 'state'>;
  clock: Clock;
  tokenCache: Pick<TokenCache, 'drop'>;
}

interface Observed {
  state: SessionState;
  /** When the identity read that returned `state` was issued, in epoch milliseconds. */
  checkedAt: number;
}

/** Creates a checker with an empty in-memory memo. */
export function createSessionStateChecker(opts: SessionStateCheckerOptions): SessionStateChecker {
  const { identity, clock, tokenCache } = opts;
  // Recording re-inserts the key, so the least recently read sessions sit at the head of the map.
  const observed = new Map<string, Observed>();
  const pending = new Map<string, Promise<SessionStateCheck>>();

  /** Removes sessions not read for the retention period, so sessions that never return do not accumulate. */
  function pruneIdle(now: number): void {
    for (const [sessionId, entry] of observed) {
      if (now - entry.checkedAt < STATE_MEMO_RETENTION_MS) return;
      observed.delete(sessionId);
    }
  }

  /** Records identity's answer and compares its epoch with the previous observation. */
  function record(sessionId: string, state: SessionState, checkedAt: number): SessionStateCheck {
    const previous = observed.get(sessionId);
    observed.delete(sessionId);
    observed.set(sessionId, { state, checkedAt });
    if (previous === undefined || previous.state.epoch === state.epoch) return { ...state, epochChanged: false };
    tokenCache.drop(sessionId);
    return { ...state, epochChanged: true, previousEpoch: previous.state.epoch };
  }

  /** One identity read shared by every concurrent check of the session. */
  function read(sessionId: string, checkedAt: number): Promise<SessionStateCheck> {
    const request: Promise<SessionStateCheck> = identity.state(sessionId).then(
      (state) => {
        // A forget() replaced this read, so its answer goes to its callers only and never into the memo.
        if (pending.get(sessionId) !== request) return { ...state, epochChanged: false };
        pending.delete(sessionId);
        return record(sessionId, state, checkedAt);
      },
      (error: unknown) => {
        if (pending.get(sessionId) === request) pending.delete(sessionId);
        throw error;
      },
    );
    pending.set(sessionId, request);
    return request;
  }

  return {
    async check(sessionId) {
      const now = clock.now().getTime();
      pruneIdle(now);
      const entry = observed.get(sessionId);
      if (entry !== undefined) {
        const age = now - entry.checkedAt;
        // A clock stepped back never extends the memo.
        if (age >= 0 && age < STATE_CHECK_INTERVAL_MS) return { ...entry.state, epochChanged: false };
      }
      return pending.get(sessionId) ?? read(sessionId, now);
    },

    forget(sessionId) {
      observed.delete(sessionId);
      pending.delete(sessionId);
    },
  };
}
