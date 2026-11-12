/** Identity session state: anonymous sessions, login and re-login, adoption of legacy sessions, hydration reads and logout. */
import { randomUUID } from 'node:crypto';
import {
  cfIsBoolean,
  cfListToArray,
  cfToBoolean,
  cfUuid,
  jsessionidForSessionId,
  sessionCookieStrings,
  type LegacyCookieConfig,
} from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
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

/** An active session and the tenant holding its row; `tokens` is present when `ensureSession` generated the session id. */
export interface EnsuredSession {
  sessionId: string;
  tenantId: string;
  csrfSecret: string;
  epoch: number;
  created: boolean;
  tokens?: SessionTokens;
}

/** A login of `snapshot` into `sessionId`; `mode` applies only to a new session. */
export interface LoginApplication {
  sessionId: string;
  snapshot: LoginSnapshot;
  mode: SessionMode;
  siteId: string | null;
  /** Runs in the transaction that writes the session row; a throw rolls the login back. */
  after?: (tx: TenantTx) => Promise<unknown>;
}

/** The session a login rebuilt and the tenant holding its row. */
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

/** The identity session of an adopted legacy session and the tenant holding its row. */
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

/** One session effect: `known` may answer from the located row without a lock, `locked` runs on the row locked in the tenant holding it, `absent` when no row exists. */
interface SessionEffect<T> {
  known?(located: LocatedSession): T | undefined;
  locked(tx: TenantTx, prior: SessionRow): Promise<T>;
  absent(): Promise<T>;
}

/** A rebuilt session's written values and the tenant holding its row. */
interface RebuiltSession {
  tenantId: string;
  values: SessionValues;
}

const UNIQUE_VIOLATION = '23505';

/** `lockSession` found no row: the effect runs as for an absent session. */
const NO_ROW = Symbol('no session row');

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

/** The ensured view of a stored session of `tenantId`. */
function ensuredFrom(row: SessionRow, tenantId: string): EnsuredSession {
  return { sessionId: row.session_id, tenantId, csrfSecret: row.csrf_secret, epoch: Number(row.epoch), created: false };
}

/** The values of `snapshot` logged into a session at `siteId`: fresh CSRF secret, next epoch, the prior mode (else `mode`), jar and admin state. */
function loginValues(prior: SessionRow | undefined, snapshot: LoginSnapshot, siteId: string | null, mode: SessionMode): SessionValues {
  return {
    user_id: snapshot.userid,
    site_id: siteId,
    login_snapshot: JSON.stringify(snapshot),
    csrf_secret: cfUuid(),
    mode: prior?.mode ?? mode,
    state: 'active',
    jar_ref: prior?.jar_ref ?? null,
    ended_at: null,
    // setUserStruct replaces session.mura, post-login values included; the other session-scope values stay.
    admin_state: withoutMuraValues(prior?.admin_state ?? null),
    epoch: nextEpoch(prior),
  };
}

/** Runs `effect` as `known` answers the located row, else on its row locked FOR UPDATE in its tenant, else as `absent`, once more after a concurrent create. */
async function sessionEffect<T>(deps: SessionDeps, sessionId: string, effect: SessionEffect<T>): Promise<T> {
  const { db, repo } = deps;
  let retried = false;
  for (;;) {
    const located = await locateSession(deps, sessionId);
    if (located !== undefined) {
      const known = effect.known?.(located);
      if (known !== undefined) return known;
      const outcome = await withTenant(db, located.tenantId, async (tx): Promise<T | typeof NO_ROW> => {
        const prior = await repo.lockSession(tx, sessionId, 'update');
        return prior === null ? NO_ROW : effect.locked(tx, prior);
      });
      if (outcome !== NO_ROW) return outcome;
    }
    try {
      return await effect.absent();
    } catch (err) {
      if (retried || !isUniqueViolation(err)) throw err;
      retried = true;
    }
  }
}

/** Inserts the session under `SYSTEM_TENANT_ID` with `values`; `after` runs in the same transaction. */
async function insertSession(deps: SessionDeps, sessionId: string, values: SessionValues, after?: (tx: TenantTx) => Promise<unknown>): Promise<void> {
  await withTenant(deps.db, SYSTEM_TENANT_ID, async (tx) => {
    await deps.repo.insertSession(tx, { session_id: sessionId, ...values });
    if (after !== undefined) await after(tx);
  });
}

/** Writes `values` as the locked session's whole state in place, dropping its CSRF claims; `after` runs in the same transaction. */
async function rewriteSession(
  repo: IdentityRepository,
  tx: TenantTx,
  sessionId: string,
  values: SessionValues,
  after?: (tx: TenantTx) => Promise<unknown>,
): Promise<void> {
  await clearClaims(repo, tx, sessionId);
  await repo.updateSession(tx, sessionId, values);
  if (after !== undefined) await after(tx);
}

/** Rebuilds the session from `build` of its locked prior row, inserting it under `SYSTEM_TENANT_ID` when absent; `after` runs in the write. */
function rebuildSession(
  deps: SessionDeps,
  sessionId: string,
  build: (prior: SessionRow | undefined) => SessionValues,
  after?: (tx: TenantTx) => Promise<unknown>,
): Promise<RebuiltSession> {
  return sessionEffect(deps, sessionId, {
    async locked(tx, prior) {
      const values = build(prior);
      await rewriteSession(deps.repo, tx, sessionId, values, after);
      return { tenantId: tx.tenantId, values };
    },
    async absent() {
      const values = build(undefined);
      await insertSession(deps, sessionId, values, after);
      return { tenantId: SYSTEM_TENANT_ID, values };
    },
  });
}

/** Inserts an active anonymous session `sessionId` under `SYSTEM_TENANT_ID`. */
async function insertAnonymous(deps: SessionDeps, sessionId: string, mode: SessionMode): Promise<EnsuredSession> {
  const values = anonymousValues(mode, nextEpoch(undefined), null);
  await insertSession(deps, sessionId, values);
  return { sessionId, tenantId: SYSTEM_TENANT_ID, csrfSecret: values.csrf_secret, epoch: values.epoch, created: true };
}

/** Target-primary cookie values of session `sessionId`: a fresh v4 UUID `CFID`, `CFTOKEN` 0 and the `JSESSIONID` naming the session. */
export function newSessionTokens(sessionId: string): SessionTokens {
  return { cfid: randomUUID(), cftoken: '0', jsessionid: jsessionidForSessionId(sessionId) };
}

/** The active session `sessionId`, created anonymous when absent and reactivated anonymous when ended; the id never changes. */
export async function ensureSession(deps: SessionDeps, request: EnsureSessionRequest): Promise<EnsuredSession> {
  if (request.sessionId === undefined) {
    const sessionId = cfUuid();
    return { ...(await insertAnonymous(deps, sessionId, request.mode)), tokens: newSessionTokens(sessionId) };
  }
  const { sessionId, mode } = request;
  return sessionEffect(deps, sessionId, {
    known: ({ row, tenantId }) => (row.state === 'active' ? ensuredFrom(row, tenantId) : undefined),
    async locked(tx, prior) {
      // A concurrent request may have reactivated the row since it was located ended.
      if (prior.state === 'active') return ensuredFrom(prior, tx.tenantId);
      const values = anonymousValues(mode, nextEpoch(prior), prior.jar_ref);
      await rewriteSession(deps.repo, tx, sessionId, values);
      return { sessionId, tenantId: tx.tenantId, csrfSecret: values.csrf_secret, epoch: values.epoch, created: false };
    },
    absent: () => insertAnonymous(deps, sessionId, mode),
  });
}

/** Logs `snapshot` into the session as `setUserStruct` does: fresh CSRF secret, no used tokens, next epoch, same id [legacy: core/mura/user/userUtility.cfc:749-783]. */
export async function applyLogin(deps: SessionDeps, login: LoginApplication): Promise<AppliedSession> {
  const { sessionId, snapshot } = login;
  const { tenantId, values } = await rebuildSession(deps, sessionId, (prior) => loginValues(prior, snapshot, login.siteId, login.mode), login.after);
  return { sessionId, tenantId, epoch: values.epoch, csrfSecret: values.csrf_secret, mode: values.mode };
}

/** Re-logs `snapshot` into the session at its stored site as `applyLogin` does, only while it is active at `epoch`; undefined leaves an ended, unknown or since-changed session unchanged. */
export function applyRelogin(deps: SessionDeps, relogin: Pick<LoginApplication, 'sessionId' | 'snapshot'> & { epoch: number }): Promise<AppliedSession | undefined> {
  const { sessionId, snapshot, epoch } = relogin;
  return sessionEffect<AppliedSession | undefined>(deps, sessionId, {
    async locked(tx, prior) {
      if (prior.state !== 'active' || Number(prior.epoch) !== epoch) return undefined;
      const values = loginValues(prior, snapshot, prior.site_id, prior.mode);
      await rewriteSession(deps.repo, tx, sessionId, values);
      return { sessionId, tenantId: tx.tenantId, epoch: values.epoch, csrfSecret: values.csrf_secret, mode: values.mode };
    },
    absent: async () => undefined,
  });
}

/** Creates or updates the identity session of a described legacy session; a changed CSRF secret means legacy logged in or out since. */
export async function adoptLegacySession(deps: SessionDeps, describe: LegacyDescribe, opts: AdoptOptions): Promise<AdoptedSession> {
  const { repo, clock } = deps;
  const { legacySessionId: sessionId, describe: description } = describe;
  const loggedIn = cfFlag(structValue(description.user, 'isLoggedIn'));
  const user = loggedIn ? describedUser(description) : ANONYMOUS_USER_STRUCT;
  // The contract carries token keys only; stamping them now keeps each at least as long as legacy's purge would.
  const usedAt = clock.now();
  const usedTokens = description.usedTokens.map((token) => ({ token, usedAt }));
  const importTokens = (tx: TenantTx): Promise<number> => importUsedTokens(repo, tx, sessionId, usedTokens);
  const jarRefOf = (prior: SessionRow | undefined): string | null => (opts.jarRef === undefined ? (prior?.jar_ref ?? null) : opts.jarRef);
  const valuesOf = (prior: SessionRow | undefined): SessionValues => ({
    user_id: loggedIn ? user.userID : null,
    site_id: describe.siteId,
    login_snapshot: JSON.stringify(snapshotOfUserStruct(user)),
    csrf_secret: description.csrfSecretKey,
    mode: opts.mode,
    state: 'active',
    jar_ref: jarRefOf(prior),
    ended_at: null,
    admin_state: withoutMuraValues(prior?.admin_state ?? null),
    epoch: nextEpoch(prior),
  });
  const adopted = (tenantId: string, epoch: number): AdoptedSession => ({ sessionId, tenantId, epoch, mode: opts.mode });

  return sessionEffect(deps, sessionId, {
    async locked(tx, prior) {
      if (prior.state === 'active' && prior.csrf_secret === description.csrfSecretKey) {
        await repo.updateSession(tx, sessionId, { mode: opts.mode, jar_ref: jarRefOf(prior) });
        await importTokens(tx);
        return adopted(tx.tenantId, Number(prior.epoch));
      }
      const values = valuesOf(prior);
      await rewriteSession(repo, tx, sessionId, values, importTokens);
      return adopted(tx.tenantId, values.epoch);
    },
    async absent() {
      const values = valuesOf(undefined);
      await insertSession(deps, sessionId, values, importTokens);
      return adopted(SYSTEM_TENANT_ID, values.epoch);
    },
  });
}

/** The session's state, epoch, mode, user and site; an unknown session reads as ended with epoch 0. */
export async function sessionState(deps: SessionDeps, sessionId: string): Promise<SessionStatus> {
  const located = await locateSession(deps, sessionId);
  if (located === undefined) return { epoch: 0, state: 'ended', mode: null, userId: '', siteId: '' };
  const { row } = located;
  return { epoch: Number(row.epoch), state: row.state, mode: row.mode, userId: row.user_id ?? '', siteId: row.site_id ?? '' };
}

/** The admin site the session selected (`session.siteid` in its admin state); empty when none is stored or the session is unknown or ended. */
export async function sessionAdminSite(deps: SessionDeps, sessionId: string): Promise<string> {
  const row = (await locateSession(deps, sessionId))?.row;
  if (row === undefined || row.state !== 'active' || row.admin_state === null) return '';
  const { siteid } = JSON.parse(row.admin_state) as Record<string, unknown>;
  return typeof siteid === 'string' ? siteid : '';
}

/** The login-time snapshot, CSRF secret and used tokens `op=hydrate` installs; undefined when the session is unknown or ended. */
export async function sessionSnapshot(deps: SessionDeps, sessionId: string): Promise<SessionSnapshot | undefined> {
  const { db, repo, clock } = deps;
  const located = await locateSession(deps, sessionId);
  if (located === undefined) return undefined;
  // The shared lock holds off session effects, so the row and its used tokens come from one epoch.
  const read = await withTenant(db, located.tenantId, async (tx) => {
    const row = await repo.lockSession(tx, sessionId, 'share');
    return row === null || row.state !== 'active' ? undefined : { row, usedTokens: await usedTokensFor(repo, tx, sessionId, clock.now()) };
  });
  if (read === undefined) return undefined;
  const { row, usedTokens } = read;
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
export function endSession(deps: SessionDeps, sessionId: string): Promise<EndedSession> {
  return sessionEffect(deps, sessionId, {
    async locked(tx, prior) {
      if (prior.state === 'ended') return { epoch: Number(prior.epoch) };
      // The gateway drops the legacy cookie jar after ending, so its reference goes too.
      const values: SessionValues = { ...anonymousValues(prior.mode, nextEpoch(prior), null), state: 'ended', ended_at: deps.clock.now() };
      await rewriteSession(deps.repo, tx, sessionId, values);
      return { epoch: values.epoch };
    },
    absent: async () => ({ epoch: 0 }),
  });
}

/** `Set-Cookie` values of the session cookies `CFID`, `CFTOKEN` and `JSESSIONID` with their legacy attributes [legacy: core/mura/utility.cfc:708-735]. */
export function sessionCookies(tokens: SessionTokens, cfg: LegacyCookieConfig, now?: Date): string[] {
  return sessionCookieStrings({ CFID: tokens.cfid, CFTOKEN: tokens.cftoken, jsessionid: tokens.jsessionid }, cfg, now);
}
