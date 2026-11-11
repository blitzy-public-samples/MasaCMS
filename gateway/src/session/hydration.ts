// Hydration of a session's legacy ColdFusion session from identity's login snapshot, before its legacy-bound requests.
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import type { BridgeCallOptions, BridgeClient, HydrateBody } from './bridge-client.js';
import type { IdentityClient, SessionSnapshot } from './identity-client.js';
import {
  absorbLegacySetCookies,
  isDeletedJarCookie,
  keptSession,
  legacyCookieHeader,
  type JarCookies,
  type JarRow,
  type LegacyJar,
} from './jar.js';

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
  /**
   * The jar row, hydrated at `epoch` or later into a ColdFusion session that still holds it; undefined when identity
   * reports the session missing or ended.
   */
  ensureHydrated(sessionId: string, epoch: number, call?: HydrationCall): Promise<JarRow | undefined>;
}

/** Dependencies of {@link createHydrator}. */
export interface HydratorOptions {
  identity: Pick<IdentityClient, 'snapshot'>;
  bridge: Pick<BridgeClient, 'describe' | 'hydrate'>;
  jar: Pick<LegacyJar, 'get' | 'withSessionLock'>;
  barrier: HydrationBarrier;
  /** Stamps the used-token entries and judges cookie expiry; defaults to the system clock. */
  clock?: Clock;
}

/** What `op=describe` finds behind a jar row's live cookies. */
interface Attachment {
  /** The row probed; undefined when the session has no jar. */
  row: JarRow | undefined;
  /** ColdFusion still holds the row's own legacy session. */
  attached: boolean;
  /** That session is also still logged in, so a hydration in it stands. */
  live: boolean;
  /** Cookies of the legacy session to hydrate into; none lets ColdFusion start one. */
  cookies: JarCookies;
  /** That session's id, signed as the bridge's `sid`. */
  legacySessionId?: string;
  /** Session cookies ColdFusion set while describing. */
  observed: JarCookies;
}

/** Bridge wire time in the legacy server's zone, the space-separated form the bridge parses. */
const WIRE_TIME_MASK = 'yyyy-MM-dd HH:nn:ss.lll';

/** True when the row records a target-primary hydration at `epoch` or later; epochs only grow. */
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

/** The jar cookies a browser would still send at `now`. */
function liveCookies(row: JarRow | undefined, now: Date): JarCookies {
  const cookies: JarCookies = {};
  for (const [key, cookie] of Object.entries(row?.cookies ?? {})) {
    if (!isDeletedJarCookie(cookie, now)) cookies[key] = cookie;
  }
  return cookies;
}

/** True when `row` is the same jar version, legacy session and live cookie values that `probed` described. */
function unchangedSince(probed: Attachment, row: JarRow | undefined, now: Date): boolean {
  const before = probed.row;
  return (
    before?.updatedAt.getTime() === row?.updatedAt.getTime() &&
    before?.legacySessionId === row?.legacySessionId &&
    legacyCookieHeader(before?.cookies ?? {}, now) === legacyCookieHeader(row?.cookies ?? {}, now)
  );
}

/** Creates a hydrator; concurrent calls for one session share one hydration, across instances through the jar lock. */
export function createHydrator(opts: HydratorOptions): Hydrator {
  const { identity, bridge, jar, barrier } = opts;
  const clock = opts.clock ?? systemClock;
  const running = new Map<string, Promise<JarRow | undefined>>();

  /** Describes the row's legacy session: whether ColdFusion still holds it logged in, and where to hydrate if not. */
  async function probe(row: JarRow | undefined, call: HydrationCall): Promise<Attachment> {
    const cookies = liveCookies(row, clock.now());
    if (row === undefined || Object.keys(cookies).length === 0) {
      return { row, attached: false, live: false, cookies: {}, observed: {} };
    }
    const described = await bridge.describe(cookies, call);
    const observed = absorbLegacySetCookies(described.setCookies).sessionCookies;
    const { sessionId, isLoggedIn } = described.body;
    const attached = keptSession(cookies, observed) && sessionId === row.legacySessionId;
    // Hydration goes into the session describe found or started, so the bridge's sid matches and none is orphaned.
    const target = { cookies: { ...cookies, ...observed }, legacySessionId: sessionId, observed };
    return { row, attached, live: attached && isLoggedIn, ...target };
  }

  /** Installs identity's current snapshot in the session's legacy session and records it, under its jar lock. */
  async function hydrate(
    sessionId: string,
    epoch: number,
    call: HydrationCall,
    probed: Attachment | undefined,
  ): Promise<JarRow | undefined> {
    // The user's rows must reach legacy before op=hydrate installs them; awaited before the lock holds a connection.
    await barrier.awaitOwners([...HYDRATION_OWNERS]);
    return jar.withSessionLock(sessionId, async (locked) => {
      // Read under the lock, so a hydration, rebind or logout that finished meanwhile is seen.
      let row = await locked.get(sessionId);
      if (row?.legacySessionId) {
        await locked.lockNative(row.legacySessionId);
        // A rebind holding that lock may have moved the legacy session to another jar and removed this one.
        row = await locked.get(sessionId);
      }
      const now = clock.now();
      const attachment = probed !== undefined && unchangedSince(probed, row, now) ? probed : await probe(row, call);
      if (isCurrent(row, epoch) && attachment.live) return row;
      // Read under the lock, so a logout that ended the session first leaves nothing to recreate.
      const snapshot = await identity.snapshot(sessionId);
      if (snapshot === undefined) return undefined;
      const body = hydrateBody(snapshot, cfDateTimeFormat(now, WIRE_TIME_MASK));
      if (body.snapshot.user.userID === '') {
        // An anonymous session has no login to install (the bridge refuses an empty userID); its attachment stands.
        if (attachment.attached && isCurrent(row, snapshot.epoch)) return row;
        return locked.upsert({
          sessionId,
          legacySessionId: attachment.legacySessionId ?? null,
          cookies: attachment.observed,
          mode: 'target-primary',
          hydratedEpoch: snapshot.epoch,
        });
      }
      const result = await bridge.hydrate(attachment.cookies, body, {
        ...call,
        legacySessionId: attachment.legacySessionId,
      });
      // The upsert merges cookies in SQL, so only those ColdFusion set are written; the rest keep their stored values.
      const { sessionCookies } = absorbLegacySetCookies(result.setCookies);
      return locked.upsert({
        sessionId,
        legacySessionId: result.body.sessionId || attachment.legacySessionId || null,
        cookies: { ...attachment.observed, ...sessionCookies },
        mode: 'target-primary',
        // The epoch actually installed, which may differ from the caller's when a login raced the state check.
        hydratedEpoch: snapshot.epoch,
      });
    });
  }

  async function ensureHydrated(sessionId: string, epoch: number, call: HydrationCall = {}): Promise<JarRow | undefined> {
    const row = await jar.get(sessionId);
    // The epoch alone does not prove ColdFusion still holds the session: a timeout or restart drops it unannounced.
    const probed = isCurrent(row, epoch) ? await probe(row, call) : undefined;
    if (probed?.live === true) return row;
    const pending = running.get(sessionId);
    if (pending !== undefined) {
      const joined = await pending;
      // A hydration that began before a newer login may have installed the older snapshot.
      return joined === undefined || isCurrent(joined, epoch) ? joined : ensureHydrated(sessionId, epoch, call);
    }
    const started: Promise<JarRow | undefined> = hydrate(sessionId, epoch, call, probed).finally(() => {
      if (running.get(sessionId) === started) running.delete(sessionId);
    });
    running.set(sessionId, started);
    return started;
  }

  return { ensureHydrated };
}
