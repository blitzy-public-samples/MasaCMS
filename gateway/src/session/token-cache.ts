// Per-instance cache of identity-minted, site-scoped user tokens, keyed by session and legacy site id.
import type { Clock } from '@opt2/platform/service-kit';
import type { IdentityClient } from './identity-client.js';

/** Legacy `siteid` fallback when a request names no site (contentServer.cfc handleAPIRequest). */
export const DEFAULT_SITE_ID = 'default';

/** Site-scoped user tokens of gateway sessions. */
export interface TokenCache {
  /** The session's token for `siteId` (absent: `default`); identity mints one unless an unexpired token of `epoch` is cached. */
  get(sessionId: string, siteId: string | undefined, epoch: number): Promise<string>;
  /** Forgets every cached and in-flight token of the session. */
  drop(sessionId: string): void;
}

/** Dependencies of {@link createTokenCache}. */
export interface TokenCacheOptions {
  identity: IdentityClient;
  clock: Clock;
}

interface CachedToken {
  token: string;
  /** Expiry in epoch milliseconds. */
  expiresAt: number;
  epoch: number;
}

interface PendingMint {
  epoch: number;
  promise: Promise<string>;
}

const KEY_SEPARATOR = '\u0000';

function cacheKey(sessionId: string, siteId: string): string {
  return `${sessionId}${KEY_SEPARATOR}${siteId}`;
}

/** Creates an empty in-memory token cache. */
export function createTokenCache(opts: TokenCacheOptions): TokenCache {
  const { identity, clock } = opts;
  // Identity gives every token one lifetime, so insertion order is expiry order; storing re-inserts the key.
  const cached = new Map<string, CachedToken>();
  const pending = new Map<string, PendingMint>();

  /** Removes the expired entries at the head of the cache, so sessions that never return do not accumulate. */
  function pruneExpired(now: number): void {
    for (const [key, entry] of cached) {
      if (entry.expiresAt > now) return;
      cached.delete(key);
    }
  }

  // Entries carry the caller's epoch: the gateway's session-state check, not identity's reply, decides staleness.
  function mint(key: string, sessionId: string, siteId: string, epoch: number): Promise<string> {
    const record: PendingMint = {
      epoch,
      promise: identity.mintToken({ sessionId, siteId }).then(
        (minted) => {
          // A drop or a newer-epoch mint replaced this record, so its token must not repopulate the cache.
          if (pending.get(key) === record) {
            pending.delete(key);
            cached.delete(key);
            cached.set(key, { token: minted.token, expiresAt: minted.expiresAt * 1000, epoch });
          }
          return minted.token;
        },
        (error: unknown) => {
          if (pending.get(key) === record) pending.delete(key);
          throw error;
        },
      ),
    };
    pending.set(key, record);
    return record.promise;
  }

  return {
    async get(sessionId, siteId, epoch) {
      // An empty siteid names no site, so it falls back like an absent one, as legacy's siteExists check does.
      const site = siteId || DEFAULT_SITE_ID;
      const key = cacheKey(sessionId, site);
      const now = clock.now().getTime();
      pruneExpired(now);
      const entry = cached.get(key);
      if (entry !== undefined && entry.epoch === epoch && now < entry.expiresAt) return entry.token;
      const inFlight = pending.get(key);
      if (inFlight !== undefined && inFlight.epoch === epoch) return inFlight.promise;
      return mint(key, sessionId, site, epoch);
    },

    drop(sessionId) {
      const prefix = `${sessionId}${KEY_SEPARATOR}`;
      for (const key of cached.keys()) if (key.startsWith(prefix)) cached.delete(key);
      for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
    },
  };
}
