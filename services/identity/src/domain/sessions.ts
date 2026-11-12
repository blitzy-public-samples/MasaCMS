/** Identity session state: anonymous sessions, login and re-login, adoption of legacy sessions, hydration reads and logout. */
import { randomBytes, randomUUID } from 'node:crypto';
import { cfIsBoolean, cfListToArray, cfToBoolean, cfUuid, sessionCookieStrings, type LegacyCookieConfig } from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, tenantIdForSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import type { IdentityRepository, SessionPatch } from '../repo/repository.js';
import type { LoginSnapshot, SessionMode, SessionRow, SessionState } from '../repo/tables.js';
import { clearClaims, importUsedTokens, locateSession, usedTokensFor, type LocatedSession } from './csrf.js';
import {
  ANONYMOUS_USER_STRUCT,
  snapshotOfUserStruct,
  userStructOf,
  type AnonymousUserStruct,
  type LegacyUserFields,
  type LegacyUserStruct,
} from './roles.js';

// The session lookup lives in csrf.ts, which session code imports, so the two modules never import each other.
export { locateSession, type LocatedSession } from './csrf.js';
export type { SessionMode } from '../repo/tables.js';

/** Dependencies of the session operations. */
export interface SessionDeps {
  db: TenantDb;
  repo: IdentityRepository;
  clock: Clock;
}

/** The bridge's `op=describe` output for one legacy session, as the contract's `LegacySessionDescription` carries it. */
export interface LegacySessionDescription {
  /** `session.mura` with `isLoggedIn` and `membershipIds`; keys match case-insensitively, as CFML struct keys do. */
  user: Readonly<Record<string, unknown>>;
  /** The login-time role list (`session.mura.memberships`) as items. */
  roles: readonly string[];
  /** `session.mura.csrfsecretkey`. */
  csrfSecretKey: string;
  /** Keys of `session.mura.csrfusedtokens`. */
  usedTokens: readonly string[];
}

/** Body of `/internal/v1/sessions:adopt`, the contract's `AdoptSessionRequest`. */
export interface LegacyDescribe {
  legacySessionId: string;
  /** The requested legacy site id. */
  siteId: string;
  describe: LegacySessionDescription;
}

/** Session cookie values of a target-primary session. */
export interface SessionTokens {
  cfid: string;
  cftoken: string;
  jsessionid: string;
}

/** Arguments of `ensureSession`; without `sessionId` a new session id and its cookie values are generated. */
export interface EnsureSessionRequest {
  sessionId?: string;
  mode: SessionMode;
}

/** An active session; `tokens` is present when `ensureSession` generated the session id. */
export interface EnsuredSession {
  sessionId: string;
  tenantId: string;
  csrfSecret: string;
  epoch: number;
  created: boolean;
  tokens?: SessionTokens;
}

/** A login of `snapshot` into `sessionId`; `tenantId` is the user's tenant and `mode` applies only to a new session. */
export interface LoginApplication {
  sessionId: string;
  tenantId: string;
  snapshot: LoginSnapshot;
  mode: SessionMode;
  siteId: string | null;
  /** Runs in the transaction that writes the session row; a throw rolls the login back. */
  after?: (tx: TenantTx) => Promise<unknown>;
}

/** The session a login rebuilt. */
export interface AppliedSession {
  sessionId: string;
  tenantId: string;
  epoch: number;
  csrfSecret: string;
  mode: SessionMode;
}

/** Gateway-side facts of an adoption; an absent `jarRef` keeps the stored one. */
export interface AdoptOptions {
  mode: SessionMode;
  jarRef?: string | null;
}

/** The identity session of an adopted legacy session. */
export interface AdoptedSession {
  sessionId: string;
  tenantId: string;
  epoch: number;
  mode: SessionMode;
}

/** Whether a session is active, with its epoch, mode, user and site; `mode` is null for an unknown session. */
export interface SessionStatus {
  epoch: number;
  state: SessionState;
  mode: SessionMode | null;
  userId: string;
  siteId: string;
}

type UsedToken = Awaited<ReturnType<typeof usedTokensFor>>[number];

/** What `op=hydrate` installs: the login-time snapshot as `session.mura` and role items, the CSRF secret and the used tokens. */
export interface SessionSnapshot {
  sessionId: string;
  epoch: number;
  loginSnapshot: Readonly<LoginSnapshot>;
  /** `session.mura` as `setUserStruct` sets it from the snapshot [legacy: core/mura/user/userUtility.cfc:765-801]. */
  user: Readonly<LegacyUserStruct> | Readonly<AnonymousUserStruct>;
  roles: string[];
  csrfSecret: string;
  usedTokens: UsedToken[];
}

/** The epoch after `endSession`. */
export interface EndedSession {
  epoch: number;
}

/** Every column a rebuilt session row holds besides its id. */
type SessionValues = Required<
  Pick<SessionPatch, 'user_id' | 'site_id' | 'login_snapshot' | 'csrf_secret' | 'mode' | 'state' | 'jar_ref' | 'ended_at' | 'admin_state'>
> & { epoch: number };

/** The described user fields and role lists `setUserStruct` receives. */
type DescribedUser = LegacyUserFields & Pick<LegacyUserStruct, 'memberships' | 'membershipids'>;

const UNIQUE_VIOLATION = '23505';

/** The stored snapshot of a session without a user: the not-logged-in `session.mura` values [legacy: core/mura/user/userUtility.cfc:784-801]. */
export const ANONYMOUS_LOGIN_SNAPSHOT: Readonly<LoginSnapshot> = Object.freeze(snapshotOfUserStruct(ANONYMOUS_USER_STRUCT));

const ANONYMOUS_SNAPSHOT_TEXT = JSON.stringify(ANONYMOUS_LOGIN_SNAPSHOT);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/** The epoch after the next session effect; a new session starts at 1. */
function nextEpoch(row: SessionRow | undefined): number {
  return row === undefined ? 1 : Number(row.epoch) + 1;
}

/** The stored login snapshot of a row. */
function storedSnapshot(row: SessionRow): Readonly<LoginSnapshot> {
  return row.login_snapshot === null ? ANONYMOUS_LOGIN_SNAPSHOT : (JSON.parse(row.login_snapshot) as LoginSnapshot);
}

/** Admin-state key of the `session.mura` values set since the last login. */
const MURA_VALUES_KEY = 'mura';

/** `admin_state` JSON text without the post-login `session.mura` values, which a new user struct replaces. */
function withoutMuraValues(adminState: string | null): string | null {
  if (adminState === null) return null;
  const state = JSON.parse(adminState) as Record<string, unknown>;
  if (!Object.hasOwn(state, MURA_VALUES_KEY)) return adminState;
  delete state[MURA_VALUES_KEY];
  return JSON.stringify(state);
}

/** A struct value by key, matched case-insensitively as CFML struct keys are. */
function structValue(struct: Readonly<Record<string, unknown>>, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(struct)) if (name.toLowerCase() === wanted) return value;
  return undefined;
}

/** A simple struct value as CFML text; `fallback` for an absent or complex one. */
function structText(struct: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = structValue(struct, key);
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;
}

/** CFML `isBoolean(x) && x`, as the bridge reads `session.mura.isLoggedIn`. */
function cfFlag(value: unknown): boolean {
  return cfIsBoolean(value) && cfToBoolean(value);
}

/** The described `session.mura` user fields, absent ones taking the not-logged-in values, and its role lists. */
function describedUser(description: LegacySessionDescription): DescribedUser {
  const { user } = description;
  const text = (key: keyof LegacyUserFields): string => structText(user, key, ANONYMOUS_USER_STRUCT[key]);
  return {
    userID: text('userID'),
    username: text('username'),
    siteID: text('siteID'),
    subtype: text('subtype'),
    password: text('password'),
    fname: text('fname'),
    lname: text('lname'),
    email: text('email'),
    remoteID: text('remoteID'),
    company: text('company'),
    lastlogin: text('lastlogin'),
    passwordCreated: text('passwordCreated'),
    memberships: description.roles.join(','),
    membershipids: structText(user, 'membershipIds', ''),
  };
}

/** The values of a session without a user, with a fresh CSRF secret, as `setUserStruct()` leaves `session.mura` [legacy: core/mura/user/userUtility.cfc:761-763,784-801]. */
function anonymousValues(mode: SessionMode, epoch: number, jarRef: string | null): SessionValues {
  return {
    user_id: null,
    site_id: null,
    login_snapshot: ANONYMOUS_SNAPSHOT_TEXT,
    csrf_secret: cfUuid(),
    mode,
    state: 'active',
    jar_ref: jarRef,
    ended_at: null,
    admin_state: null,
    epoch,
  };
}

/** The ensured view of a stored session. */
function ensuredFrom(located: LocatedSession): EnsuredSession {
  const { row, tenantId } = located;
  return { sessionId: row.session_id, tenantId, csrfSecret: row.csrf_secret, epoch: Number(row.epoch), created: false };
}

/** Writes `values` as the session's whole state in `tenantId`, dropping its CSRF claims and moving a row of another tenant; `after` runs in the write. */
async function rebuildSession(
  deps: SessionDeps,
  sessionId: string,
  located: LocatedSession | undefined,
  tenantId: string,
  values: SessionValues,
  after?: (tx: TenantTx) => Promise<unknown>,
): Promise<void> {
  const { db, repo } = deps;
  const sameTenant = located?.tenantId === tenantId;
  if (located !== undefined && !sameTenant) {
    await withTenant(db, located.tenantId, async (tx) => {
      await clearClaims(repo, tx, sessionId);
      await repo.deleteSession(tx, sessionId);
    });
  }
  await withTenant(db, tenantId, async (tx) => {
    let updated: SessionRow | null = null;
    if (sameTenant) {
      await clearClaims(repo, tx, sessionId);
      updated = await repo.updateSession(tx, sessionId, values);
    }
    // Also covers a row deleted since it was located.
    if (updated === null) await repo.insertSession(tx, { session_id: sessionId, ...values });
    if (after !== undefined) await after(tx);
  });
}

/** Inserts an active anonymous session `sessionId` under `SYSTEM_TENANT_ID`; a concurrent insert of the same id is returned instead. */
async function insertAnonymous(deps: SessionDeps, sessionId: string, mode: SessionMode): Promise<EnsuredSession> {
  const values = anonymousValues(mode, nextEpoch(undefined), null);
  try {
    await withTenant(deps.db, SYSTEM_TENANT_ID, (tx) => deps.repo.insertSession(tx, { session_id: sessionId, ...values }));
  } catch (err) {
    // Parallel first requests of one browser session race to create it; legacy lets them share the session.
    const located = isUniqueViolation(err) ? await locateSession(deps, sessionId) : undefined;
    if (located === undefined) throw err;
    return ensuredFrom(located);
  }
  return { sessionId, tenantId: SYSTEM_TENANT_ID, csrfSecret: values.csrf_secret, epoch: values.epoch, created: true };
}

/** Fresh target-primary cookie values: a v4 UUID `CFID`, `CFTOKEN` 0 and 32 uppercase hex characters of `JSESSIONID`. */
export function newSessionTokens(): SessionTokens {
  return { cfid: randomUUID(), cftoken: '0', jsessionid: randomBytes(16).toString('hex').toUpperCase() };
}

/** The active session `sessionId`, created anonymous when absent and reactivated anonymous when ended; the id never changes. */
export async function ensureSession(deps: SessionDeps, request: EnsureSessionRequest): Promise<EnsuredSession> {
  if (request.sessionId === undefined) {
    const tokens = newSessionTokens();
    return { ...(await insertAnonymous(deps, tokens.jsessionid, request.mode)), tokens };
  }
  const { sessionId, mode } = request;
  const located = await locateSession(deps, sessionId);
  if (located === undefined) return insertAnonymous(deps, sessionId, mode);
  if (located.row.state === 'active') return ensuredFrom(located);
  const values = anonymousValues(mode, nextEpoch(located.row), located.row.jar_ref);
  await rebuildSession(deps, sessionId, located, SYSTEM_TENANT_ID, values);
  return { sessionId, tenantId: SYSTEM_TENANT_ID, csrfSecret: values.csrf_secret, epoch: values.epoch, created: false };
}

/** Logs `snapshot` into the session as `setUserStruct` does: fresh CSRF secret, no used tokens, next epoch, same id [legacy: core/mura/user/userUtility.cfc:749-783]. */
export async function applyLogin(deps: SessionDeps, login: LoginApplication): Promise<AppliedSession> {
  const { sessionId, tenantId, snapshot } = login;
  const located = await locateSession(deps, sessionId);
  const prior = located?.row;
  const values: SessionValues = {
    user_id: snapshot.userid,
    site_id: login.siteId,
    login_snapshot: JSON.stringify(snapshot),
    csrf_secret: cfUuid(),
    mode: prior?.mode ?? login.mode,
    state: 'active',
    jar_ref: prior?.jar_ref ?? null,
    ended_at: null,
    // setUserStruct replaces session.mura, post-login values included; the other session-scope values stay.
    admin_state: withoutMuraValues(prior?.admin_state ?? null),
    epoch: nextEpoch(prior),
  };
  await rebuildSession(deps, sessionId, located, tenantId, values, login.after);
  return { sessionId, tenantId, epoch: values.epoch, csrfSecret: values.csrf_secret, mode: values.mode };
}

/** Creates or updates the identity session of a described legacy session; a changed CSRF secret means legacy logged in or out since. */
export async function adoptLegacySession(deps: SessionDeps, describe: LegacyDescribe, opts: AdoptOptions): Promise<AdoptedSession> {
  const { db, repo, clock } = deps;
  const { legacySessionId: sessionId, describe: description } = describe;
  const loggedIn = cfFlag(structValue(description.user, 'isLoggedIn'));
  const user = loggedIn ? describedUser(description) : ANONYMOUS_USER_STRUCT;
  const tenantId = loggedIn ? tenantIdForSite(user.siteID) : SYSTEM_TENANT_ID;
  // The contract carries token keys only; stamping them now keeps each at least as long as legacy's purge would.
  const usedAt = clock.now();
  const usedTokens = description.usedTokens.map((token) => ({ token, usedAt }));
  const located = await locateSession(deps, sessionId);
  const jarRef = opts.jarRef === undefined ? (located?.row.jar_ref ?? null) : opts.jarRef;

  if (
    located !== undefined &&
    located.tenantId === tenantId &&
    located.row.state === 'active' &&
    located.row.csrf_secret === description.csrfSecretKey
  ) {
    await withTenant(db, tenantId, async (tx) => {
      await repo.updateSession(tx, sessionId, { mode: opts.mode, jar_ref: jarRef });
      await importUsedTokens(repo, tx, sessionId, usedTokens);
    });
    return { sessionId, tenantId, epoch: Number(located.row.epoch), mode: opts.mode };
  }

  const values: SessionValues = {
    user_id: loggedIn ? user.userID : null,
    site_id: describe.siteId,
    login_snapshot: JSON.stringify(snapshotOfUserStruct(user)),
    csrf_secret: description.csrfSecretKey,
    mode: opts.mode,
    state: 'active',
    jar_ref: jarRef,
    ended_at: null,
    admin_state: withoutMuraValues(located?.row.admin_state ?? null),
    epoch: nextEpoch(located?.row),
  };
  await rebuildSession(deps, sessionId, located, tenantId, values, (tx) => importUsedTokens(repo, tx, sessionId, usedTokens));
  return { sessionId, tenantId, epoch: values.epoch, mode: opts.mode };
}

/** The session's state, epoch, mode, user and site; an unknown session reads as ended with epoch 0. */
export async function sessionState(deps: SessionDeps, sessionId: string): Promise<SessionStatus> {
  const located = await locateSession(deps, sessionId);
  if (located === undefined) return { epoch: 0, state: 'ended', mode: null, userId: '', siteId: '' };
  const { row } = located;
  return { epoch: Number(row.epoch), state: row.state, mode: row.mode, userId: row.user_id ?? '', siteId: row.site_id ?? '' };
}

/** The login-time snapshot, CSRF secret and used tokens `op=hydrate` installs; undefined when the session is unknown or ended. */
export async function sessionSnapshot(deps: SessionDeps, sessionId: string): Promise<SessionSnapshot | undefined> {
  const { db, repo, clock } = deps;
  const located = await locateSession(deps, sessionId);
  if (located === undefined || located.row.state !== 'active') return undefined;
  const { row, tenantId } = located;
  const usedTokens = await withTenant(db, tenantId, (tx) => usedTokensFor(repo, tx, sessionId, clock.now()));
  const loginSnapshot = storedSnapshot(row);
  return {
    sessionId,
    epoch: Number(row.epoch),
    loginSnapshot,
    user: row.user_id === null ? ANONYMOUS_USER_STRUCT : userStructOf(loginSnapshot),
    roles: cfListToArray(loginSnapshot.roleList),
    csrfSecret: row.csrf_secret,
    usedTokens,
  };
}

/** Ends the session as logout clears its scope, keeping the id; an ended session is unchanged [legacy: core/mura/login/loginManager.cfc:476-516]. */
export async function endSession(deps: SessionDeps, sessionId: string): Promise<EndedSession> {
  const located = await locateSession(deps, sessionId);
  if (located === undefined) return { epoch: 0 };
  const { row, tenantId } = located;
  if (row.state === 'ended') return { epoch: Number(row.epoch) };
  // The gateway drops the legacy cookie jar after ending, so its reference goes too.
  const values: SessionValues = { ...anonymousValues(row.mode, nextEpoch(row), null), state: 'ended', ended_at: deps.clock.now() };
  await rebuildSession(deps, sessionId, located, tenantId, values);
  return { epoch: values.epoch };
}

/** `Set-Cookie` values of the session cookies `CFID`, `CFTOKEN` and `JSESSIONID` with their legacy attributes [legacy: core/mura/utility.cfc:708-735]. */
export function sessionCookies(tokens: SessionTokens, cfg: LegacyCookieConfig, now?: Date): string[] {
  return sessionCookieStrings({ CFID: tokens.cfid, CFTOKEN: tokens.cftoken, jsessionid: tokens.jsessionid }, cfg, now);
}
