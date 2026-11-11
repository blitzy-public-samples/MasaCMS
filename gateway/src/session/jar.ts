// Legacy ColdFusion session cookies kept per identity session in gateway.legacy_jar, and their Set-Cookie translation.
import {
  LEGACY_SESSION_COOKIE_NAMES,
  parseCookieHeader,
  parseSetCookie,
  setCookieLegacy,
} from '@opt2/platform/legacy-compat';
import { withMetadata, type MetadataTx, type TenantDb } from '@opt2/platform/tenancy';
import type { SessionMode } from './mode.js';

/** Upper-case legacy session cookie name: `CFID`, `CFTOKEN` or `JSESSIONID`. */
export type LegacySessionCookieName = (typeof LEGACY_SESSION_COOKIE_NAMES)[number];

/** One legacy session cookie; `attributes` is the raw Set-Cookie tail after `NAME=value;`, kept verbatim. */
export interface JarCookie {
  /** Name as legacy sent it. */
  name: string;
  value: string;
  attributes: string;
}

/** Jar cookies keyed by their upper-case name, so a later cookie of any case replaces the earlier one. */
export type JarCookies = Record<string, JarCookie>;

/** One `gateway.legacy_jar` row. */
export interface JarRow {
  /** Identity session id. */
  sessionId: string;
  /** ColdFusion `session.sessionid` as `session.cfm?op=describe` reports it. */
  legacySessionId: string | null;
  cookies: JarCookies;
  mode: SessionMode;
  hydratedEpoch: number | null;
  updatedAt: Date;
}

/** Input of {@link LegacyJar.upsert}: `cookies` merge into the stored ones, every other field replaces its column. */
export interface JarUpsert {
  sessionId: string;
  legacySessionId: string | null;
  cookies: JarCookies;
  mode: SessionMode;
  hydratedEpoch: number | null;
}

/** Reads and writes of `gateway.legacy_jar`; each write first takes the advisory locks {@link LegacyJar} describes. */
export interface JarStatements {
  /** The jar of an identity session, or undefined when it has none. */
  get(sessionId: string): Promise<JarRow | undefined>;
  /** The jar holding a ColdFusion session, or undefined when none does. */
  findByLegacySessionId(legacySessionId: string): Promise<JarRow | undefined>;
  /** Creates or updates a jar and returns the stored row; cookies absent from `input` keep their stored entries. */
  upsert(input: JarUpsert): Promise<JarRow>;
  /** Records the session epoch the legacy session was last hydrated at; false when the jar does not exist. */
  setHydratedEpoch(sessionId: string, epoch: number): Promise<boolean>;
  /** Removes a jar; false when it did not exist. */
  drop(sessionId: string): Promise<boolean>;
  /**
   * Maps `input.legacySessionId` to `input.sessionId` alone: the jar of `previousSessionId` and any other holder of
   * that legacy session are removed, their barrier positions move to `input.sessionId`, then `input` is upserted.
   */
  rebind(input: JarUpsert, previousSessionId?: string): Promise<JarRow>;
}

/** Jar statements of a session's locked section, which may also take one ColdFusion session's lock. */
export interface LockedJar extends JarStatements {
  /** Takes the ColdFusion session's lock until the section ends. */
  lockNative(legacySessionId: string): Promise<void>;
}

/**
 * Store of `gateway.legacy_jar`. A row's own state is written under its session's lock; every `op=hydrate` or `op=end`
 * of a ColdFusion session, and every rebind to it, holds that ColdFusion session's lock. A transaction takes at most
 * one session lock and one ColdFusion session lock, the session's first; any other order throws.
 */
export interface LegacyJar extends JarStatements {
  /**
   * Runs `fn` in one transaction holding the session's advisory lock; commits when `fn` resolves, rolls back when it
   * throws. Inside `fn` only `locked` may be used: a top-level write for the same session would wait on this lock.
   */
  withSessionLock<T>(sessionId: string, fn: (locked: LockedJar) => Promise<T>): Promise<T>;
  /** As {@link withSessionLock}, holding only the ColdFusion session's lock; `locked.rebind` takes no previous. */
  withNativeLock<T>(legacySessionId: string, fn: (locked: JarStatements) => Promise<T>): Promise<T>;
}

/** Raw `Set-Cookie` values of a legacy response split into jar cookies and the rest. */
export interface AbsorbedSetCookies {
  sessionCookies: JarCookies;
  /** Every other `Set-Cookie` value, unchanged and in order. */
  otherSetCookies: string[];
}

const TABLE = 'legacy_jar';
const BARRIER_TABLE = 'session_barrier';
const COLUMNS = 'session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at';
const LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

interface JarRecord {
  session_id: string;
  legacy_session_id: string | null;
  cookies: JarCookies;
  mode: SessionMode;
  // pg returns bigint columns as strings.
  hydrated_epoch: string | null;
  updated_at: Date;
}

/** Upper-case name of a legacy session cookie in any case, or undefined for any other cookie. */
function sessionCookieName(name: string): LegacySessionCookieName | undefined {
  const upper = name.toUpperCase();
  return LEGACY_SESSION_COOKIE_NAMES.find((candidate) => candidate === upper);
}

/** The raw text after the first `;` of a Set-Cookie value, or '' when it has none. */
function attributeTail(setCookie: string): string {
  const semicolon = setCookie.indexOf(';');
  return semicolon < 0 ? '' : setCookie.slice(semicolon + 1);
}

/** True when a browser holding the cookie drops it: an empty value or an `expires` at or before `now`. */
export function isDeletedJarCookie(cookie: JarCookie, now: Date = new Date()): boolean {
  if (cookie.value === '') return true;
  const { attributes } = parseSetCookie(`${cookie.name}=;${cookie.attributes}`);
  const expires = attributes.find(([name, value]) => name.toLowerCase() === 'expires' && value !== true)?.[1];
  // An unparseable date gives NaN, which compares false: the cookie lives for the session, as in the browser.
  return typeof expires === 'string' && Date.parse(expires) <= now.getTime();
}

/** Splits legacy `Set-Cookie` values: CFID, CFTOKEN and JSESSIONID in any case go to the jar, the rest pass through. */
export function absorbLegacySetCookies(setCookies: readonly string[]): AbsorbedSetCookies {
  const sessionCookies: JarCookies = {};
  const otherSetCookies: string[] = [];
  for (const setCookie of setCookies) {
    const parsed = parseSetCookie(setCookie);
    const key = sessionCookieName(parsed.name);
    if (key === undefined) otherSetCookies.push(setCookie);
    // A later value for the same cookie replaces the earlier one, as it does in the browser.
    else sessionCookies[key] = { name: parsed.name, value: parsed.value, attributes: attributeTail(setCookie) };
  }
  return { sessionCookies, otherSetCookies };
}

/** The issued value for `name`, matched case-insensitively. */
function issuedValue(issued: Readonly<Record<string, string>>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(issued)) if (key.toUpperCase() === upper) return value;
  return undefined;
}

/**
 * Target `Set-Cookie` values for absorbed legacy cookies: each issued target value under the legacy name and attributes.
 * A legacy deletion becomes a deletion of the target cookie; a cookie with no issued value is not emitted.
 */
export function targetSetCookiesFrom(
  jarCookies: JarCookies,
  issued: Readonly<Record<string, string>>,
  now: Date = new Date(),
): string[] {
  const out: string[] = [];
  for (const cookie of Object.values(jarCookies)) {
    if (isDeletedJarCookie(cookie, now)) {
      out.push(`${cookie.name}=;${cookie.attributes}`);
      continue;
    }
    // In target-primary mode the browser never receives a legacy value, so a name identity did not issue is left out.
    const value = issuedValue(issued, cookie.name);
    if (value !== undefined) out.push(`${cookie.name}=${value};${cookie.attributes}`);
  }
  return out;
}

/** `Cookie` header pairs of the jar's live session cookies for a request to legacy; '' when there are none. */
export function legacyCookieHeader(jarCookies: JarCookies, now: Date = new Date()): string {
  return Object.values(jarCookies)
    .filter((cookie) => !isDeletedJarCookie(cookie, now))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/** `Set-Cookie` values that hand the browser the jar's legacy cookies back, with their stored attributes. */
export function legacySetCookiesFrom(jarCookies: JarCookies): string[] {
  return Object.values(jarCookies).map((cookie) => `${cookie.name}=${cookie.value};${cookie.attributes}`);
}

/**
 * Jar cookies for the legacy session cookies of a request `Cookie` header.
 * Name and attributes come from the live `observed` entry of the same cookie, else from setCookieLegacy defaults.
 */
export function requestSessionCookies(
  cookieHeader: string | undefined,
  observed: JarCookies = {},
  now: Date = new Date(),
): JarCookies {
  const cookies = parseCookieHeader(cookieHeader);
  const out: JarCookies = {};
  for (const name of LEGACY_SESSION_COOKIE_NAMES) {
    const value = cookies.get(name);
    if (value === undefined) continue;
    const seen = observed[name];
    // A deletion's attributes describe the removal, not a live cookie, so they are not reused.
    out[name] =
      seen !== undefined && !isDeletedJarCookie(seen, now)
        ? { name: seen.name, value, attributes: seen.attributes }
        : { name, value, attributes: attributeTail(setCookieLegacy({ name, value: '' })) };
  }
  return out;
}

/** True when describing kept the session `sent` names: ColdFusion set no session cookie to another value. */
export function keptSession(sent: JarCookies, observed: JarCookies): boolean {
  return (
    Object.keys(sent).length > 0 && Object.entries(observed).every(([key, cookie]) => sent[key]?.value === cookie.value)
  );
}

function toRow(record: JarRecord): JarRow {
  return {
    sessionId: record.session_id,
    legacySessionId: record.legacy_session_id,
    cookies: record.cookies,
    mode: record.mode,
    hydratedEpoch: record.hydrated_epoch === null ? null : Number(record.hydrated_epoch),
    updatedAt: record.updated_at,
  };
}

/** Jar statements of one transaction, plus the session lock they take. */
interface TxStatements extends LockedJar {
  /** Takes the transaction-scoped advisory lock of an identity session. */
  lockSession: (sessionId: string) => Promise<void>;
}

/** The jar statements on one metadata transaction. */
function statementsOn(tx: MetadataTx): TxStatements {
  // Qualified by the handle's schema, as platform grants are, rather than a literal `gateway.`, so a throwaway schema is read.
  const table = `${tx.schema}.${TABLE}`;
  const barrier = `${tx.schema}.${BARRIER_TABLE}`;
  // One of each kind, session first, so no transaction waits for a lock while holding one another waits behind.
  const held: { session?: string; native?: string } = {};

  async function lockSession(sessionId: string): Promise<void> {
    if (held.session === sessionId) return;
    if (held.session !== undefined) {
      throw new Error(`jar lock order: session ${sessionId} requested while holding session ${held.session}`);
    }
    if (held.native !== undefined) {
      throw new Error(`jar lock order: session ${sessionId} requested after native session ${held.native}`);
    }
    await tx.query(LOCK_SQL, [`${table}:${sessionId}`]);
    held.session = sessionId;
  }

  async function lockNative(legacySessionId: string): Promise<void> {
    if (held.native === legacySessionId) return;
    if (held.native !== undefined) {
      throw new Error(
        `jar lock order: native session ${legacySessionId} requested while holding native session ${held.native}`,
      );
    }
    await tx.query(LOCK_SQL, [`${table}.native:${legacySessionId}`]);
    held.native = legacySessionId;
  }

  async function first(sql: string, values: unknown[]): Promise<JarRow | undefined> {
    const record = (await tx.query<JarRecord>(sql, values)).rows[0];
    return record === undefined ? undefined : toRow(record);
  }

  async function changed(sql: string, values: unknown[]): Promise<boolean> {
    return ((await tx.query(sql, values)).rowCount ?? 0) > 0;
  }

  async function write(input: JarUpsert): Promise<JarRow> {
    const row = await first(
      `INSERT INTO ${table} AS jar (${COLUMNS}) VALUES ($1, $2, $3::jsonb, $4, $5, now())
       ON CONFLICT (session_id) DO UPDATE SET
         legacy_session_id = EXCLUDED.legacy_session_id,
         cookies = jar.cookies || EXCLUDED.cookies,
         mode = EXCLUDED.mode,
         hydrated_epoch = EXCLUDED.hydrated_epoch,
         updated_at = EXCLUDED.updated_at
       RETURNING ${COLUMNS}`,
      [input.sessionId, input.legacySessionId, JSON.stringify(input.cookies), input.mode, input.hydratedEpoch],
    );
    // INSERT … ON CONFLICT DO UPDATE … RETURNING always returns the written row.
    return row as JarRow;
  }

  return {
    lockSession,
    lockNative,

    get: (sessionId) => first(`SELECT ${COLUMNS} FROM ${table} WHERE session_id = $1`, [sessionId]),

    findByLegacySessionId: (legacySessionId) =>
      first(`SELECT ${COLUMNS} FROM ${table} WHERE legacy_session_id = $1`, [legacySessionId]),

    async upsert(input) {
      await lockSession(input.sessionId);
      return write(input);
    },

    async setHydratedEpoch(sessionId, epoch) {
      await lockSession(sessionId);
      return changed(`UPDATE ${table} SET hydrated_epoch = $2, updated_at = now() WHERE session_id = $1`, [
        sessionId,
        epoch,
      ]);
    },

    async drop(sessionId) {
      await lockSession(sessionId);
      return changed(`DELETE FROM ${table} WHERE session_id = $1`, [sessionId]);
    },

    async rebind(input, previousSessionId) {
      // The holders of the legacy session are guarded by its lock, which their hydrations and logouts hold too.
      if (previousSessionId !== undefined) await lockSession(previousSessionId);
      if (input.legacySessionId !== null) await lockNative(input.legacySessionId);
      const { rows } = await tx.query<{ session_id: string }>(
        `DELETE FROM ${table} WHERE session_id <> $1 AND (session_id = $2 OR legacy_session_id = $3)
         RETURNING session_id`,
        [input.sessionId, previousSessionId ?? null, input.legacySessionId],
      );
      const replaced = rows.map((row) => row.session_id);
      if (replaced.length > 0) {
        // The replaced sessions' unapplied write positions still bind the legacy session's next requests; one
        // statement moves exactly the positions it deletes.
        await tx.query(
          `WITH moved AS (DELETE FROM ${barrier} WHERE session_id = ANY($2::text[]) RETURNING owner, xid, recorded_at)
           INSERT INTO ${barrier} AS b (session_id, owner, xid, recorded_at)
           SELECT $1, owner, max(xid), max(recorded_at) FROM moved GROUP BY owner
           ON CONFLICT (session_id, owner) DO UPDATE SET
             xid = GREATEST(b.xid, EXCLUDED.xid),
             recorded_at = GREATEST(b.recorded_at, EXCLUDED.recorded_at)`,
          [input.sessionId, replaced],
        );
      }
      return write(input);
    },
  };
}

/** Creates the jar store over the gateway's database handle; SQL is qualified by the handle's schema (`gateway`). */
export function createLegacyJar(db: TenantDb): LegacyJar {
  /** Runs `fn` on the jar statements of one metadata transaction. */
  function inTransaction<T>(fn: (statements: TxStatements) => Promise<T>): Promise<T> {
    return withMetadata(db, (tx) => fn(statementsOn(tx)));
  }

  return {
    get: (sessionId) => inTransaction((s) => s.get(sessionId)),
    findByLegacySessionId: (legacySessionId) => inTransaction((s) => s.findByLegacySessionId(legacySessionId)),
    upsert: (input) => inTransaction((s) => s.upsert(input)),
    setHydratedEpoch: (sessionId, epoch) => inTransaction((s) => s.setHydratedEpoch(sessionId, epoch)),
    drop: (sessionId) => inTransaction((s) => s.drop(sessionId)),
    rebind: (input, previousSessionId) => inTransaction((s) => s.rebind(input, previousSessionId)),

    withSessionLock: (sessionId, fn) =>
      inTransaction(async ({ lockSession, ...locked }) => {
        await lockSession(sessionId);
        return fn(locked);
      }),

    withNativeLock: (legacySessionId, fn) =>
      inTransaction(async (statements) => {
        await statements.lockNative(legacySessionId);
        return fn(statements);
      }),
  };
}
