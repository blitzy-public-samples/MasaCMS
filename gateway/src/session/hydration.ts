// Hydration of a session's legacy ColdFusion session from identity's login snapshot, before its legacy-bound requests.
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import type { BridgeCallOptions, BridgeClient, HydrateBody } from './bridge-client.js';
import type { IdentityClient, SessionSnapshot } from './identity-client.js';
import { absorbLegacySetCookies, isDeletedJarCookie, type JarCookies, type JarRow, type LegacyJar } from './jar.js';

/** Waits until legacy holds the owners' current writes; rejects (legacy-shaped 503) when the wait times out. */
export interface HydrationBarrier {
  awaitOwners(owners: string[]): Promise<void>;
}

/** Owners whose writes to the user's legacy `tusers` row `op=hydrate` relies on. */
export const HYDRATION_OWNERS = ['identity', 'people'] as const;

/** Per-request facts forwarded to the bridge: the browser's `User-Agent`, which keeps Masa's session timeout. */
export type HydrationCall = Pick<BridgeCallOptions, 'userAgent'>;

/** Keeps a session's legacy ColdFusion session at identity's login snapshot. */
export interface Hydrator {
  /** The jar row, hydrated at `epoch` or later; undefined when identity reports the session missing or ended. */
  ensureHydrated(sessionId: string, epoch: number, call?: HydrationCall): Promise<JarRow | undefined>;
}

/** Dependencies of {@link createHydrator}. */
export interface HydratorOptions {
  identity: Pick<IdentityClient, 'snapshot'>;
  bridge: Pick<BridgeClient, 'hydrate'>;
  jar: Pick<LegacyJar, 'get' | 'upsert'>;
  barrier: HydrationBarrier;
  /** Stamps the used-token entries; defaults to the system clock. */
  clock?: Clock;
}

/** Bridge wire time in the legacy server's zone, the space-separated form the bridge parses. */
const WIRE_TIME_MASK = 'yyyy-MM-dd HH:nn:ss.lll';

/** True when the row's legacy session already holds identity's snapshot at `epoch` or later; epochs only grow. */
function isCurrent(row: JarRow | undefined, epoch: number): row is JarRow {
  return row?.mode === 'target-primary' && row.hydratedEpoch !== null && row.hydratedEpoch >= epoch;
}

/** A struct value by key, matched case-insensitively as CFML struct keys are. */
function structValue(struct: Readonly<Record<string, unknown>>, key: string): unknown {
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(struct)) if (name.toLowerCase() === wanted) return value;
  return undefined;
}

/** A simple value as text; `fallback` for an absent or complex one. */
function text(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
}

/** The `op=hydrate` body for identity's snapshot; each used token is stamped `usedAt`. */
function hydrateBody(snapshot: SessionSnapshot, usedAt: string): HydrateBody {
  const { user, roles } = snapshot.loginSnapshot;
  // Absent keys take describe's logged-out defaults.
  const field = (key: string, fallback = ''): string => text(structValue(user, key), fallback);
  return {
    snapshot: {
      // Only the describe keys: a stored `groupID` would override `membershipIds` in setUserStruct.
      user: {
        userID: field('userID'),
        username: field('username'),
        siteID: field('siteID'),
        subtype: field('subtype', 'Default'),
        password: field('password'),
        fname: field('fname'),
        lname: field('lname'),
        email: field('email'),
        remoteID: field('remoteID'),
        company: field('company'),
        lastlogin: field('lastlogin'),
        passwordCreated: field('passwordCreated'),
      },
      memberships: roles.join(','),
      membershipIds: field('membershipIds'),
    },
    csrfSecretKey: snapshot.csrfSecretKey,
    // Identity keeps only the token keys; the hydration time keeps each entry at least as long as legacy's 3 h purge.
    usedTokens: snapshot.usedTokens.map((token) => ({ token, usedAt })),
  };
}

/** The jar's live session cookies and the legacy session id the bridge checks them against. */
function attachedSession(row: JarRow | undefined, now: Date): { cookies: JarCookies; legacySessionId?: string } {
  // Cookies of an unknown session id would fail the bridge's sid check, so ColdFusion starts a new session instead.
  if (row === undefined || row.legacySessionId === null) return { cookies: {} };
  const cookies: JarCookies = {};
  for (const [key, cookie] of Object.entries(row.cookies)) if (!isDeletedJarCookie(cookie, now)) cookies[key] = cookie;
  return Object.keys(cookies).length > 0 ? { cookies, legacySessionId: row.legacySessionId } : { cookies };
}

/** Creates a hydrator; concurrent calls for one session share a single hydration. */
export function createHydrator(opts: HydratorOptions): Hydrator {
  const { identity, bridge, jar, barrier } = opts;
  const clock = opts.clock ?? systemClock;
  const running = new Map<string, Promise<JarRow | undefined>>();

  /** Installs identity's current snapshot in the session's legacy session and records it in the jar. */
  async function hydrate(sessionId: string, call: HydrationCall): Promise<JarRow | undefined> {
    // The user's rows must reach legacy before op=hydrate installs them.
    await barrier.awaitOwners([...HYDRATION_OWNERS]);
    const snapshot = await identity.snapshot(sessionId);
    if (snapshot === undefined) return undefined;
    // Read after the waits, so the cookies sent are the jar's current ones.
    const row = await jar.get(sessionId);
    const now = clock.now();
    const attached = attachedSession(row, now);
    const result = await bridge.hydrate(attached.cookies, hydrateBody(snapshot, cfDateTimeFormat(now, WIRE_TIME_MASK)), {
      ...call,
      legacySessionId: attached.legacySessionId,
    });
    // The upsert merges cookies in SQL, so only those ColdFusion set are written and the rest keep their stored values.
    const { sessionCookies } = absorbLegacySetCookies(result.setCookies);
    return jar.upsert({
      sessionId,
      legacySessionId: result.body.sessionId || (row?.legacySessionId ?? null),
      cookies: sessionCookies,
      mode: 'target-primary',
      // The epoch actually installed, which may differ from the caller's when a login raced the state check.
      hydratedEpoch: snapshot.epoch,
    });
  }

  async function ensureHydrated(sessionId: string, epoch: number, call: HydrationCall = {}): Promise<JarRow | undefined> {
    const row = await jar.get(sessionId);
    if (isCurrent(row, epoch)) return row;
    const pending = running.get(sessionId);
    if (pending !== undefined) {
      const joined = await pending;
      // A hydration that began before a newer login may have installed the older snapshot.
      return joined === undefined || isCurrent(joined, epoch) ? joined : ensureHydrated(sessionId, epoch, call);
    }
    const started: Promise<JarRow | undefined> = hydrate(sessionId, call).finally(() => {
      if (running.get(sessionId) === started) running.delete(sessionId);
    });
    running.set(sessionId, started);
    return started;
  }

  return { ensureHydrated };
}
