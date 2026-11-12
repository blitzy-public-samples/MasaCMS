/** Credential and user-id login and logout of identity sessions, ported from Masa `userUtility.cfc`; a login never changes the session id. */
import { cfEq } from '@opt2/platform/legacy-compat';
import { DEFAULT_UMBRELLA_SITE_ID, formatCanonicalTimestamp, readGates, withGatedTenant } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  tenantForRegisteredSite,
  tenantIdForSite,
  withTenant,
  type RegistrySource,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import { hashNewPassword, verifyLegacyPassword, type LegacyPasswordConfig } from '../legacy/hash.js';
import { charKey, type IdentityRepository } from '../repo/repository.js';
import {
  CREDENTIAL,
  LOGIN_STATE,
  type CredentialRow,
  type GroupAccountRow,
  type LoginSnapshot,
  type LoginStateRow,
  type UserAccountRow,
} from '../repo/tables.js';
import { DEFAULT_ACCOUNT_SETTINGS, withOpenAccount } from './account-operations.js';
import { buildLoginSnapshot, type LoginRows, type MembershipGroup } from './roles.js';
import { applyLogin, endSession, locateSession, type AppliedSession, type EndedSession, type SessionMode } from './sessions.js';
import {
  DEFAULT_STRIKE_SETTINGS,
  addStrike,
  blockedUntil,
  clearStrikes,
  isBlocked,
  loadStrikes,
  type StrikeOptions,
  type StrikeSettings,
} from './strikes.js';

/** Masa login settings; the caller supplies the live configBean values. */
export interface LoginSettings {
  password: LegacyPasswordConfig;
  strikes: StrikeSettings;
}

/** Masa defaults: encrypted bcrypt passwords with Java enabled and four allowed strikes [legacy: core/mura/configBean.cfc:166-167,217-218]. */
export const DEFAULT_LOGIN_SETTINGS: Readonly<LoginSettings> = Object.freeze({
  password: DEFAULT_ACCOUNT_SETTINGS.password,
  strikes: DEFAULT_STRIKE_SETTINGS,
});

/** Dependencies of the login operations; `sleep` paces the closed-user wait and defaults to a timer. */
export interface LoginDeps {
  db: TenantDb;
  repo: IdentityRepository;
  clock: Clock;
  settings: LoginSettings;
  sleep?: (ms: number) => Promise<void>;
}

/** The session a login applies to: its id, the mode a new session takes and the requested legacy site id ('' for none). */
export interface LoginTarget {
  sessionId: string;
  mode: SessionMode;
  siteId: string;
}

/** A credential login of `sessionId` [legacy: core/mura/user/userUtility.cfc:179-184]. */
export interface LoginRequest extends LoginTarget {
  username: string;
  password: string;
}

/** A login of the account `userId` without a password check [legacy: core/mura/user/userUtility.cfc:261-263]. */
export interface LoginByUserIdRequest extends LoginTarget {
  userId: string;
}

/** `loginByQuery`'s account in its tenant; `credential` as the caller read it, else read in the login transaction. */
export interface LoginByQueryInput extends LoginTarget {
  tenantId: string;
  account: UserAccountRow;
  credential?: CredentialRow | null;
}

/** The login-time snapshot a login stored and the session it rebuilt. */
export interface LoginSuccess {
  snapshot: LoginSnapshot;
  session: AppliedSession;
}

/** A refused login: no matching account, a public account outside the site's public user pool, or a held strike block. */
export type LoginFailure = { ok: false; reason: 'invalid' | 'public-pool' } | { ok: false; reason: 'blocked'; blockedUntil: Date };

/** `login`'s answer; `hasDefaultPassword` is legacy's `session.hasdefaultpassword` for `admin`/`admin`. */
export type LoginResult = ({ ok: true; hasDefaultPassword: boolean } & LoginSuccess) | LoginFailure;

/** `loginByUserID`'s answer; it never takes a strike. */
export type LoginByUserIdResult = ({ ok: true } & LoginSuccess) | { ok: false; reason: 'invalid' | 'public-pool' };

/** The account whose stored credential the password matched, in its tenant; undefined for no match. */
export type LookupResult = { account: UserAccountRow; credential: CredentialRow | null; tenantId: string } | undefined;

/**
 * Session-scope values login sets [legacy: core/mura/user/userUtility.cfc:205,227,253]. They live in the session's admin state under
 * their legacy names, where the login page reads the block; `blockLoginUntil` is '' or a `YYYY-MM-DDTHH:MM:SS.mmm` local time.
 */
export const LOGIN_SESSION_KEYS = Object.freeze({ blockLoginUntil: 'blockLoginUntil', hasDefaultPassword: 'hasdefaultpassword' } as const);

const DEFAULT_SITE_ID = 'default';

type Candidate = NonNullable<LookupResult>;

type LoginByUserIdFailure = Extract<LoginByUserIdResult, { ok: false }>;

/** The rows `loginByQuery` reads, with the member groups the user's own tenant holds. */
interface LoginRead {
  rows: Omit<LoginRows, 'groups'>;
  groupIds: string[];
  own: GroupAccountRow[];
}

/** What the strike transaction of `login` decided; `stale` when the account or credential changed since the password check. */
type Decision =
  | { outcome: 'ok'; read: LoginRead }
  | { outcome: 'invalid' | 'public-pool' }
  | { outcome: 'blocked'; until: Date }
  | { outcome: 'stale' };

/** A password check: whether it matched and the credential then stored, an upgrade's own row included; `stale` when the credential changed before the upgrade. */
type Verification = { match: boolean; stored: CredentialRow | null } | 'stale';

/** CFML boolean of a numeric flag; NULL reads as false. */
function flag(value: number | null): boolean {
  return value !== null && value !== 0;
}

/** Legacy's `Type = 2 and inactive = 0` filter. */
function loginable(account: UserAccountRow): boolean {
  return account.type === 2 && account.inactive === 0;
}

/** The session's stored site id: the requested one, or none for ''. */
function sessionSite(siteId: string): string | null {
  return siteId === '' ? null : siteId;
}

/** Whether two reads of an account hold the same column values. */
function sameAccount(a: UserAccountRow, b: UserAccountRow): boolean {
  const columns = Object.keys(a) as Array<keyof UserAccountRow>;
  return columns.length === Object.keys(b).length && columns.every((column) => a[column] === b[column]);
}

/** Whether two reads of a credential hold the same stored password and password date. */
function sameCredential(a: CredentialRow | null, b: CredentialRow | null): boolean {
  if (a === null || b === null) return a === b;
  return a.password === b.password && a.passwordcreated?.getTime() === b.passwordcreated?.getTime();
}

/** The active account `userId` named `username` in the caller's transaction; undefined once renamed, deactivated or removed. */
async function accountNamed(repo: IdentityRepository, tx: TenantTx, username: string, userId: string): Promise<UserAccountRow | undefined> {
  const userKey = charKey(userId);
  return (await repo.findAccountsByUsername(tx, username)).find((row) => charKey(row.userid) === userKey);
}

/** The first active Type=2 account named `trim(username)`, by (site id, user id) across registered tenants [legacy: core/mura/user/userUtility.cfc:133-138]. */
async function firstAccountByUsername(deps: LoginDeps, username: string): Promise<{ tenantId: string; account: UserAccountRow } | undefined> {
  for (const { tenantId } of await registeredTenants(deps.db)) {
    const account = await withTenant(deps.db, tenantId, (tx) => deps.repo.findAccountByUsername(tx, username));
    if (account !== null) return { tenantId, account };
  }
  return undefined;
}

/** The account named `username` with its stored credential, read under the user's account fence once no open account operation keeps the user closed. */
async function credentialCandidate(deps: LoginDeps, username: string): Promise<Candidate | undefined> {
  const found = await firstAccountByUsername(deps, username);
  if (found === undefined) return undefined;
  const { tenantId } = found;
  const userId = found.account.userid;
  return withOpenAccount(
    deps.db,
    tenantId,
    userId,
    async (tx) => {
      const account = await accountNamed(deps.repo, tx, username, userId);
      return account === undefined ? undefined : { tenantId, account, credential: await deps.repo.readCredential(tx, account.userid) };
    },
    { sleep: deps.sleep },
  );
}

/** Whether the target is write-authoritative for `identity.credential` and no window or transition holds it. */
async function credentialUnitOpen(db: TenantDb): Promise<boolean> {
  const [gate] = await readGates(db, [CREDENTIAL.unit]);
  return gate?.state === 'open';
}

/**
 * Checks `password` against the candidate's stored value, rewriting a CFMX_COMPAT hash as bcrypt while the credential unit is open
 * and the stored credential is still the one checked [legacy: core/mura/user/userUtility.cfc:140-173].
 */
async function verifyPassword(deps: LoginDeps, candidate: Candidate, password: string): Promise<Verification> {
  const { db, repo, clock, settings } = deps;
  const checked = candidate.credential;
  const check = await verifyLegacyPassword(password, checked?.password, settings.password);
  // The upgrade belongs to no cut-over group: while legacy holds the credential unit, legacy's own login performs it.
  if (!check.needsUpgrade || !(await credentialUnitOpen(db))) return { match: check.match, stored: checked };
  const hashed = await hashNewPassword(password, settings.password);
  const userId = candidate.account.userid;
  // The exclusive fence makes the compare and the write one step against every other fenced writer of the user.
  const upgraded = await withOpenAccount(
    db,
    candidate.tenantId,
    userId,
    async (tx) =>
      sameCredential(await repo.readCredential(tx, userId), checked)
        ? repo.writeCredential(tx, userId, { password: hashed, passwordcreated: clock.now() })
        : null,
    { sleep: deps.sleep, exclusive: true },
  );
  return upgraded === null ? 'stale' : { match: check.match, stored: upgraded };
}

/** `getSite(siteId).getPublicUserPoolID()`; an empty or unregistered site id reads the `default` site [legacy: core/mura/settings/settingsManager.cfc:537-566]. */
async function publicUserPoolOf(db: RegistrySource, siteId: string): Promise<string | null> {
  const tenantId = (siteId === '' ? null : await tenantForRegisteredSite(db, siteId)) ?? (await tenantForRegisteredSite(db, DEFAULT_SITE_ID));
  const entry = tenantId === null ? null : await registryEntryForTenant(db, tenantId);
  return entry === null ? null : (entry.publicUserPoolId ?? entry.siteId);
}

/** Whether `account` may log in on `siteId`: a public account only where its own site is that site's public user pool [legacy: core/mura/user/userUtility.cfc:281-283]. */
async function publicPoolAdmits(db: RegistrySource, account: UserAccountRow, siteId: string): Promise<boolean> {
  if (!flag(account.ispublic)) return true;
  const pool = await publicUserPoolOf(db, siteId);
  return pool !== null && cfEq(pool, account.siteid ?? '');
}

/**
 * Tenant of the strike row of `username`, as the `tuserstrikes` mapping places it: that of the Type=2 account with the trimmed name
 * (an inactive one included), else the umbrella's.
 */
async function strikeTenant(deps: LoginDeps, username: string, candidate: Candidate | undefined): Promise<string> {
  if (candidate !== undefined) return candidate.tenantId;
  for (const { tenantId } of await registeredTenants(deps.db)) {
    if (await withTenant(deps.db, tenantId, (tx) => deps.repo.isUsernameTaken(tx, username, ''))) return tenantId;
  }
  return tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID);
}

/** Reads the login rows of `account` and stamps its last login now, in the caller's gated transaction [legacy: core/mura/user/userUtility.cfc:315-318,366-369]. */
async function readAndTouch(
  deps: Pick<LoginDeps, 'repo' | 'clock'>,
  tx: TenantTx,
  account: UserAccountRow,
  credential: CredentialRow | null | undefined,
): Promise<LoginRead> {
  const { repo, clock } = deps;
  const userId = account.userid;
  const groupIds = await repo.membershipGroupIds(tx, userId);
  const own = await repo.findGroupsByIds(tx, groupIds);
  // The snapshot carries the last login before this one.
  const loginState = await repo.findByKey<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId });
  const contact = await repo.findPersonContact(tx, userId);
  const stored = credential === undefined ? await repo.readCredential(tx, userId) : credential;
  await repo.touchLastLogin(tx, userId, clock.now());
  return { rows: { account, credential: stored, loginState, contact }, groupIds, own };
}

/** The member groups in id order, found in the user's tenant first and then in the other registered tenants; unknown ids drop out [legacy: core/mura/user/userUtility.cfc:315-318]. */
async function memberGroups(deps: LoginDeps, tenantId: string, read: LoginRead): Promise<MembershipGroup[]> {
  const found = new Map(read.own.map((group) => [charKey(group.userid), group]));
  for (const { tenantId: other } of await registeredTenants(deps.db)) {
    const missing = read.groupIds.filter((id) => !found.has(charKey(id)));
    if (missing.length === 0) break;
    if (other === tenantId) continue;
    for (const group of await withTenant(deps.db, other, (tx) => deps.repo.findGroupsByIds(tx, missing))) {
      found.set(charKey(group.userid), group);
    }
  }
  return read.groupIds.flatMap((id) => {
    const group = found.get(charKey(id));
    return group === undefined ? [] : [{ groupId: group.userid, groupName: group.groupname, siteId: group.siteid, isPublic: group.ispublic }];
  });
}

/** Builds the login snapshot from the read rows and logs it into the session, keeping its id [legacy: core/mura/user/userUtility.cfc:320-388]. */
async function completeLogin(deps: LoginDeps, tenantId: string, read: LoginRead, target: LoginTarget): Promise<LoginSuccess> {
  const groups = await memberGroups(deps, tenantId, read);
  const snapshot = buildLoginSnapshot({ ...read.rows, groups });
  const session = await applyLogin(deps, { sessionId: target.sessionId, snapshot, mode: target.mode, siteId: sessionSite(target.siteId) });
  return { snapshot, session };
}

/** Merges login's session-scope values into the admin state of `sessionId` in `tenantId`. */
async function recordSessionValues(deps: LoginDeps, tenantId: string, sessionId: string, values: Readonly<Record<string, unknown>>): Promise<void> {
  await withTenant(deps.db, tenantId, (tx) => deps.repo.mergeSessionAdminState(tx, sessionId, values));
}

/** The account matching `username` and `password`, after any legacy-hash upgrade; undefined for no match [legacy: core/mura/user/userUtility.cfc:108-177]. */
export async function lookupByCredentials(deps: LoginDeps, username: string, password: string): Promise<LookupResult> {
  const candidate = await credentialCandidate(deps, username);
  if (candidate === undefined) return undefined;
  const verification = await verifyPassword(deps, candidate, password);
  // The credential changed after it was read, so the lookup starts again from the stored rows.
  if (verification === 'stale') return lookupByCredentials(deps, username, password);
  return verification.match ? candidate : undefined;
}

/** Logs the session in by username and password under the strike rules, without plugin events or lockdown [legacy: core/mura/user/userUtility.cfc:179-259]. */
export async function login(deps: LoginDeps, request: LoginRequest): Promise<LoginResult> {
  const { db, repo, clock, settings } = deps;
  const { username, password, siteId, sessionId } = request;
  const candidate = await credentialCandidate(deps, username);
  const verification = candidate === undefined ? undefined : await verifyPassword(deps, candidate, password);
  // The credential changed after it was read, so the login starts again from the stored rows.
  if (verification === 'stale') return login(deps, request);
  const matched = verification?.match === true ? candidate : undefined;
  const poolRejects = matched !== undefined && flag(matched.account.ispublic) && (siteId === '' || !(await publicPoolAdmits(db, matched.account, siteId)));
  const tenantId = await strikeTenant(deps, username, candidate);
  const options: StrikeOptions = { settings: settings.strikes, clock };

  // `fresh` is the matched account as the deciding transaction read it.
  const decide = async (tx: TenantTx, fresh: UserAccountRow | undefined): Promise<Decision> => {
    const strikes = await loadStrikes(repo, tx, username, options);
    const blocked = isBlocked(strikes, settings.strikes);
    if (matched !== undefined && fresh !== undefined && !blocked) {
      if (poolRejects) {
        await addStrike(repo, tx, strikes, options);
        return { outcome: 'public-pool' };
      }
      // The snapshot carries the credential the lookup checked, before any upgrade, as loginByQuery(rsUser) does.
      const read = await readAndTouch(deps, tx, fresh, matched.credential);
      await clearStrikes(repo, tx, strikes, options);
      return { outcome: 'ok', read };
    }
    if (blocked) return { outcome: 'blocked', until: blockedUntil(strikes, settings.strikes, clock) };
    await addStrike(repo, tx, strikes, options);
    return { outcome: 'invalid' };
  };
  const decision =
    candidate === undefined || verification === undefined
      ? await withGatedTenant(db, tenantId, (tx) => decide(tx, undefined))
      : await withOpenAccount(
          db,
          tenantId,
          candidate.account.userid,
          async (tx): Promise<Decision> => {
            const account = await accountNamed(repo, tx, username, candidate.account.userid);
            const unchanged =
              account !== undefined &&
              sameAccount(account, candidate.account) &&
              sameCredential(await repo.readCredential(tx, account.userid), verification.stored);
            return unchanged ? decide(tx, account) : { outcome: 'stale' };
          },
          { sleep: deps.sleep },
        );
  // The account or credential changed after the password check, so the login starts again from the stored rows.
  if (decision.outcome === 'stale') return login(deps, request);

  if (decision.outcome === 'ok') {
    const success = await completeLogin(deps, tenantId, decision.read, request);
    const hasDefaultPassword = cfEq(password, 'admin') && cfEq(username, 'admin');
    const values: Record<string, unknown> = { [LOGIN_SESSION_KEYS.blockLoginUntil]: '' };
    if (hasDefaultPassword) values[LOGIN_SESSION_KEYS.hasDefaultPassword] = true;
    await recordSessionValues(deps, success.session.tenantId, sessionId, values);
    return { ok: true, ...success, hasDefaultPassword };
  }
  if (decision.outcome === 'blocked') {
    const located = await locateSession(deps, sessionId);
    if (located !== undefined) {
      await recordSessionValues(deps, located.tenantId, sessionId, { [LOGIN_SESSION_KEYS.blockLoginUntil]: formatCanonicalTimestamp(decision.until) });
    }
    return { ok: false, reason: 'blocked', blockedUntil: decision.until };
  }
  return { ok: false, reason: decision.outcome };
}

/** Logs the session in as the account `userId`, refusing a public account outside the site's public user pool [legacy: core/mura/user/userUtility.cfc:261-304]. */
export async function loginByUserID(deps: LoginDeps, request: LoginByUserIdRequest): Promise<LoginByUserIdResult> {
  const { db, repo } = deps;
  let found: { tenantId: string; account: UserAccountRow } | undefined;
  for (const { tenantId } of await registeredTenants(db)) {
    const account = await withTenant(db, tenantId, (tx) => repo.findAccountById(tx, request.userId));
    if (account !== null && loginable(account)) {
      found = { tenantId, account };
      break;
    }
  }
  if (found === undefined) return { ok: false, reason: 'invalid' };
  const { tenantId } = found;
  const read = await withOpenAccount(
    db,
    tenantId,
    found.account.userid,
    async (tx): Promise<LoginRead | LoginByUserIdFailure> => {
      const account = await repo.findAccountById(tx, request.userId);
      if (account === null || !loginable(account)) return { ok: false, reason: 'invalid' };
      if (!(await publicPoolAdmits(tx, account, request.siteId))) return { ok: false, reason: 'public-pool' };
      return readAndTouch(deps, tx, account, undefined);
    },
    { sleep: deps.sleep },
  );
  if ('ok' in read) return read;
  return { ok: true, ...(await completeLogin(deps, tenantId, read, request)) };
}

/** Stamps the last login, builds the login-time snapshot from memberships and person contact under the user's account fence, and logs it into the session [legacy: core/mura/user/userUtility.cfc:306-388]. */
export async function loginByQuery(deps: LoginDeps, input: LoginByQueryInput): Promise<LoginSuccess> {
  const read = await withOpenAccount(deps.db, input.tenantId, input.account.userid, (tx) => readAndTouch(deps, tx, input.account, input.credential), {
    sleep: deps.sleep,
  });
  return completeLogin(deps, input.tenantId, read, input);
}

/** Ends the session's logged-in state and bumps its epoch, keeping its id [legacy: core/mura/login/loginManager.cfc:476-516]. */
export function logout(deps: LoginDeps, sessionId: string): Promise<EndedSession> {
  return endSession(deps, sessionId);
}
