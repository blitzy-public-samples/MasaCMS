// Legacy ColdFusion session cookies kept per identity session in gateway.legacy_jar, and their Set-Cookie translation.
import {
  LEGACY_SESSION_COOKIE_NAMES,
  parseCookieHeader,
  parseSetCookie,
  setCookieLegacy,
} from '@opt2/platform/legacy-compat';
import { withMetadata, type TenantDb } from '@opt2/platform/tenancy';
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

/** Store of `gateway.legacy_jar`. */
export interface LegacyJar {
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
}

/** Raw `Set-Cookie` values of a legacy response split into jar cookies and the rest. */
export interface AbsorbedSetCookies {
  sessionCookies: JarCookies;
  /** Every other `Set-Cookie` value, unchanged and in order. */
  otherSetCookies: string[];
}

const TABLE = 'legacy_jar';
const COLUMNS = 'session_id, legacy_session_id, cookies, mode, hydrated_epoch, updated_at';

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

/** Creates the jar store over the gateway's database handle; SQL is qualified by the handle's schema (`gateway`). */
export function createLegacyJar(db: TenantDb): LegacyJar {
  // Qualified by the handle's schema, as platform grants are, rather than a literal `gateway.`, so a throwaway schema is read.
  /** Runs one statement against `<schema>.legacy_jar`; `sql` receives the qualified table name. */
  function run(sql: (table: string) => string, values: unknown[]) {
    return withMetadata(db, (tx) => tx.query<JarRecord>(sql(`${tx.schema}.${TABLE}`), values));
  }

  async function first(sql: (table: string) => string, values: unknown[]): Promise<JarRow | undefined> {
    const record = (await run(sql, values)).rows[0];
    return record === undefined ? undefined : toRow(record);
  }

  async function changed(sql: (table: string) => string, values: unknown[]): Promise<boolean> {
    return ((await run(sql, values)).rowCount ?? 0) > 0;
  }

  return {
    get: (sessionId) => first((t) => `SELECT ${COLUMNS} FROM ${t} WHERE session_id = $1`, [sessionId]),

    findByLegacySessionId: (legacySessionId) =>
      first((t) => `SELECT ${COLUMNS} FROM ${t} WHERE legacy_session_id = $1`, [legacySessionId]),

    async upsert(input) {
      const row = await first(
        (t) =>
          `INSERT INTO ${t} AS jar (${COLUMNS}) VALUES ($1, $2, $3::jsonb, $4, $5, now())
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
    },

    setHydratedEpoch: (sessionId, epoch) =>
      changed((t) => `UPDATE ${t} SET hydrated_epoch = $2, updated_at = now() WHERE session_id = $1`, [sessionId, epoch]),

    drop: (sessionId) => changed((t) => `DELETE FROM ${t} WHERE session_id = $1`, [sessionId]),
  };
}
