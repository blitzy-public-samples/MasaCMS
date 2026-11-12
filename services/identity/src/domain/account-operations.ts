/** Account side of the roster write protocol: an idempotent prepared → committed → finished (or aborted, reverted) operation that keeps its user closed while open. */
import { randomInt } from 'node:crypto';
import { setTimeout as timerSleep } from 'node:timers/promises';
import { LegacyApiError, cfEq, cfListToArray, javaTrim } from '@opt2/platform/legacy-compat';
import {
  OperationBlockedError,
  currentPosition,
  endOperation,
  registerOperation,
  withGatedTenant,
  type MigrationHandlerOptions,
  type OperationStatus,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { discardOperation, releaseOperation } from '@opt2/platform/outbox';
import type { Clock } from '@opt2/platform/service-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  tenantForRegisteredSite,
  tenantIdForSite,
  withTenant,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import type { IdentityEvents } from '../events/publish.js';
import { hashNewPassword, type LegacyPasswordConfig } from '../legacy/hash.js';
import { charKey, createIdentityRepository, type AccountOperationPatch, type IdentityRepository } from '../repo/repository.js';
import {
  CREDENTIAL,
  LOGIN_STATE,
  USER_ACCOUNT,
  type AccountOperationKind,
  type AccountOperationRow,
  type AccountOperationState,
  type GroupAccountRow,
  type LoginStateRow,
  type UserAccountRow,
} from '../repo/tables.js';
import { buildLoginSnapshot, type MembershipGroup } from './roles.js';
import { applyLogin, locateSession } from './sessions.js';

export { OperationBlockedError };

/** Units an account operation writes; its `open_operation` registration keeps their gates from closing until it ends. */
export const ACCOUNT_OPERATION_UNITS = ['identity.user_account', 'identity.credential', 'identity.login_state', 'identity.membership'] as const;

/** Longest a read or write of a user waits while an open account operation keeps that user closed. */
export const USER_CLOSED_WAIT_MS = 10_000;

const CLOSED_POLL_MS = 100;
const OPERATION_KIND = 'roster-account';
const UNIQUE_VIOLATION = '23505';
const ROLLED_BACK_STATES: ReadonlySet<AccountOperationState> = new Set<AccountOperationState>(['aborted', 'reverted']);
// getRandomPassword(12, 'alphanumeric', 'yes') draws from the lower-case, numeric and upper-case lists [legacy: core/mura/user/userUtility.cfc:700-722].
const ALPHA_LCASE = 'acegikmoqsuwybdfhjlnprtvxz';
const NUMERIC = '0246897531';
const RANDOM_CHARSET = `${ALPHA_LCASE}${NUMERIC}${ALPHA_LCASE.toUpperCase()}`;
const RANDOM_LENGTH = 12;
const STATUS_OF_STATE: Readonly<Record<AccountOperationState, OperationStatus>> = Object.freeze({
  prepared: 'open',
  committed: 'open',
  finished: 'done',
  aborted: 'rolled-back',
  reverted: 'rolled-back',
});

type Schemas = components['schemas'];

/** The contract's record of one account operation; `state` is `unknown` for an operation identity never prepared. */
export type AccountOperationView = Schemas['AccountOperation'];
/** The contract's state of an operation after abort, finish or revert. */
export type AccountOperationStep = Schemas['AccountOperationStep'];
/** The contract's commit answer; `writePosition` is the xid8 of identity's commit transaction. */
export type CommitResult = Schemas['AccountCommitResult'];
/** Field name to legacy validation message. */
export type LegacyErrors = Schemas['LegacyErrors'];

/** The identity-owned columns of a Type=2 save as posted; `Admin` is absent because neither `userDAO.create` nor `userDAO.update` writes it. */
export interface AccountChange {
  username: string;
  /** Plain password as posted; '' leaves an update's credential as stored and gives a create a random one. */
  password: string;
  s2: number;
  /** Written by a create only; `userDAO.update` leaves `Perm` as stored. */
  perm: number;
  inActive: number;
  isPublic: number;
  remoteID: string;
  /** Undefined keeps an update's stored value. */
  tablist?: string | null;
  /** The memberships to store; null leaves an update's memberships as stored. */
  groupIds: readonly string[] | null;
  /** `userManager.update`'s `updateGroups`; defaults to true. */
  updateGroups?: boolean;
  /** `userManager.update`'s `originID`: the membership delete spares groups of other sites [legacy: core/mura/user/userDAO.cfc:502-515]. */
  originID?: string;
  /** Posted `switchToPublic`/`switchToPrivate`, which pick the user pool and visibility [legacy: core/mura/user/userBean.cfc:227-239]. */
  switchToPublic?: boolean;
  switchToPrivate?: boolean;
}

/** A roster create or update of the account part; `requestSiteId` and `actorIsSuperUser` come from the verified user token. */
export interface PrepareInput {
  operationId: string;
  kind: AccountOperationKind;
  userId: string;
  /** Legacy site id of the request, whose user pools the account must belong to. */
  requestSiteId: string;
  /** The user pool site the caller derived for the account. */
  siteId: string;
  change: AccountChange;
  /** The token's `s2`. */
  actorIsSuperUser: boolean;
}

/** Person columns a re-login copies into the session snapshot. */
export interface PersonFields {
  fname: string | null;
  lname: string | null;
  email: string | null;
  company: string | null;
  subtype: string | null;
}

/** Legacy's re-login after a save: a self-save through the JSON API or `userBean.login()` [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2064-2071; core/mura/user/userBean.cfc:768-771]. */
export interface SessionEffects {
  reloginSessionId?: string;
  /** The saved person fields, which `identity.person_contact` holds only once the people event is released. */
  person?: PersonFields;
}

/** Masa password settings an account save reads [legacy: core/mura/configBean.cfc:167,217-218; core/templates/settings.template.cfm:116-117]. */
export interface AccountSettings {
  password: LegacyPasswordConfig;
  strongPasswords: boolean;
  strongPasswordRegex: string;
}

/** Masa defaults of the account save settings. */
export const DEFAULT_ACCOUNT_SETTINGS: Readonly<AccountSettings> = Object.freeze({
  password: Object.freeze({ encryptPasswords: true, bcryptPasswords: true, javaEnabled: true }),
  strongPasswords: false,
  strongPasswordRegex: '(?=^.{7,15}$)(?=.*\\d)(?![.\\n])(?=.*[a-zA-Z]).*$',
});

/** Resource-bundle keys of the account validation messages. */
export type AccountMessageKey = 'user.usernamevalidate' | 'user.passwordstrengthvalidate';

/** The text of `key` in the resource bundle of `siteId`. */
export type AccountMessages = (siteId: string, key: AccountMessageKey) => string;

/** The `en` texts [legacy: core/mura/resourceBundle/resources/en.properties:1800,1843]. */
export const EN_ACCOUNT_MESSAGES: Readonly<Record<AccountMessageKey, string>> = Object.freeze({
  'user.usernamevalidate': "The username '{1}' that you entered is being used by another user.",
  'user.passwordstrengthvalidate':
    'The Password you submitted must meet the following criteria: Passwords cannot be the same as the username, must be at least 7 characters long, and must contain 1 upper case, 1 lower case and 1 numeric character.',
});

/** Dependencies of the account operations. */
export interface AccountOperationDeps {
  db: TenantDb;
  repo: IdentityRepository;
  events: IdentityEvents;
  clock: Clock;
  /** Defaults to `DEFAULT_ACCOUNT_SETTINGS`. */
  settings?: AccountSettings;
  /** Defaults to the `en` texts. */
  rb?: AccountMessages;
  /** Wait between closed-user polls; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** The path user of a step; a step on another user's operation is a conflict. */
export interface StepInput {
  userId?: string;
}

/** A commit and the session effects people signals for it. */
export interface CommitInput extends StepInput {
  sessionEffects?: SessionEffects;
}

/** Prepare's answer: the prepared (or already recorded) operation, legacy validation errors, or a state that refuses the step. */
export type PrepareResult =
  | { outcome: 'prepared'; operation: AccountOperationView }
  | { outcome: 'invalid'; errors: LegacyErrors }
  | { outcome: 'conflict'; operation: AccountOperationView };

/** Commit's answer: the commit position, or a state that refuses the step. */
export type CommitOutcome = { outcome: 'committed'; result: CommitResult } | { outcome: 'conflict'; operation: AccountOperationView };

/** Abort's, finish's and revert's answer: the state after the step, or a state that refuses it. */
export type StepOutcome = { outcome: 'stepped'; step: AccountOperationStep } | { outcome: 'conflict'; operation: AccountOperationView };

/** Options of `awaitAccountOpen`; `selfOperationId` names the caller's own operation, which does not close the user to it. */
export interface AwaitAccountOpenOptions {
  sleep?: (ms: number) => Promise<void>;
  selfOperationId?: string;
}

/** The account columns a prepare reserves (create) or a commit writes (update). */
interface PendingAccount {
  username: string;
  s2: number;
  perm: number;
  inactive: number;
  ispublic: number;
  siteid: string;
  remoteid: string;
  tablist: string | null;
}

/** `account_operation.pending_change`: the change after legacy's save rules, the password hashed at prepare so no plain text reaches the row or its changelog. */
interface PendingChange {
  account: PendingAccount;
  /** The stored `Password` value; null leaves the credential as stored. */
  credential: { password: string | null } | null;
  /** Null leaves the memberships as stored. */
  memberships: { groupIds: string[]; originId: string | null } | null;
  sessionEffects?: SessionEffects;
}

/** `account_operation.before_values`: the user's identity rows at prepare; timestamps as ISO text. */
interface BeforeImage {
  account: Omit<UserAccountRow, 'tenant_id'> | null;
  credential: { password: string | null; passwordcreated: string | null } | null;
  lastlogin: string | null;
  groupIds: string[];
}

interface LocatedOperation {
  tenantId: string;
  row: AccountOperationRow;
}

interface StepSpec {
  from: AccountOperationState;
  to: AccountOperationState;
  /** States in which the step has already taken effect. */
  done: readonly AccountOperationState[];
}

/** How a step meets an operation: refused, already done, performed by this call, or still to run. */
type Judged =
  | { verdict: 'conflict'; operation: AccountOperationView }
  | { verdict: 'done' | 'performed'; row: AccountOperationRow }
  | { verdict: 'proceed'; located: LocatedOperation };

type Settled = Exclude<Judged, { verdict: 'proceed' }>;

/** The state change and writes of one step; `patch` runs in the step transaction before the state moves. */
interface StepEffect {
  patch?: (tx: TenantTx) => Promise<AccountOperationPatch>;
  apply: (tx: TenantTx, row: AccountOperationRow, ctx: WriteContext) => Promise<void>;
}

const COMMIT: StepSpec = { from: 'prepared', to: 'committed', done: ['committed', 'finished'] };
const ABORT: StepSpec = { from: 'prepared', to: 'aborted', done: ['aborted'] };
const FINISH: StepSpec = { from: 'committed', to: 'finished', done: ['finished'] };
const REVERT: StepSpec = { from: 'committed', to: 'reverted', done: ['reverted'] };

// operationStatus and awaitAccountOpen receive only a database handle, so they read through one repository per schema.
const repositories = new Map<string, IdentityRepository>();

function repositoryFor(schema: string): IdentityRepository {
  let repo = repositories.get(schema);
  if (repo === undefined) {
    repo = createIdentityRepository({ schema });
    repositories.set(schema, repo);
  }
  return repo;
}

function userClosed(userId: string, username: string): OperationBlockedError {
  return new OperationBlockedError([...ACCOUNT_OPERATION_UNITS], `Another open account operation holds user ${userId} or username '${username}'`);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/** CFML boolean of a numeric flag. */
function flag(value: number | null): boolean {
  return value !== null && value !== 0;
}

function isoOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function dateOf(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function withoutTenant(row: UserAccountRow): Omit<UserAccountRow, 'tenant_id'> {
  const { tenant_id: _tenant, ...columns } = row;
  return columns;
}

function sameUser(row: AccountOperationRow, userId: string | undefined): boolean {
  return userId === undefined || charKey(row.user_id) === charKey(userId);
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(charKey));
  const right = new Set(b.map(charKey));
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** Each distinct registered tenant, in site order. */
async function registeredTenantIds(db: TenantDb): Promise<string[]> {
  return [...new Set((await registeredTenants(db)).map((entry) => entry.tenantId))];
}

/** Resource-bundle `messageFormat` of one argument, which legacy splits as a comma list [legacy: core/mura/resourceBundle/resourceBundle.cfc:164-192]. */
function messageFormat(pattern: string, arg: string): string {
  const args = ['', ...cfListToArray(arg)];
  return pattern.replace(/\{(\d+)\}/g, (placeholder, index: string) => args[Number(index)] ?? placeholder);
}

/** `getRandomPassword(12, 'alphanumeric', 'yes')` [legacy: core/mura/user/userUtility.cfc:696-747]. */
export function randomPassword(): string {
  let password = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    password += RANDOM_CHARSET[randomInt(RANDOM_CHARSET.length)];
  }
  return password;
}

function parsePending(row: AccountOperationRow): PendingChange {
  if (row.pending_change === null) {
    throw new Error(`Account operation ${row.operation_id} has no recorded change`);
  }
  return JSON.parse(row.pending_change) as PendingChange;
}

function beforeOf(row: AccountOperationRow): BeforeImage {
  return row.before_values === null
    ? { account: null, credential: null, lastlogin: null, groupIds: [] }
    : (JSON.parse(row.before_values) as BeforeImage);
}

/** The contract view of a stored operation; the before-image omits the stored password. */
function viewOf(row: AccountOperationRow): AccountOperationView {
  const { account, credential, lastlogin, groupIds } = beforeOf(row);
  const before =
    account === null
      ? null
      : {
          account: {
            userid: account.userid,
            username: account.username,
            type: account.type,
            admin: account.admin,
            s2: account.s2,
            perm: account.perm,
            inactive: account.inactive,
            ispublic: account.ispublic,
            siteid: account.siteid,
            remoteid: account.remoteid,
            tablist: account.tablist,
            passwordcreated: credential?.passwordcreated ?? null,
            lastlogin,
          },
          groupIds,
        };
  return { operationId: row.operation_id, userId: row.user_id, kind: row.kind, state: row.state, before };
}

function unknownView(operationId: string, userId: string | undefined): AccountOperationView {
  return { operationId, userId: userId ?? '', state: 'unknown' };
}

function conflictOf(row: AccountOperationRow): Judged {
  return { verdict: 'conflict', operation: viewOf(row) };
}

/** The operation `operationId` in the first registered tenant holding it; undefined when identity never recorded it. */
async function locateOperation(deps: Pick<AccountOperationDeps, 'db' | 'repo'>, operationId: string): Promise<LocatedOperation | undefined> {
  const { db, repo } = deps;
  for (const tenantId of await registeredTenantIds(db)) {
    const row = await withTenant(db, tenantId, (tx) => repo.findAccountOperation(tx, operationId));
    if (row !== null) return { tenantId, row };
  }
  return undefined;
}

function judge(located: LocatedOperation | undefined, operationId: string, input: StepInput, spec: StepSpec): Judged {
  if (located === undefined) return { verdict: 'conflict', operation: unknownView(operationId, input.userId) };
  const { row } = located;
  if (!sameUser(row, input.userId)) return conflictOf(row);
  if (spec.done.includes(row.state)) return { verdict: 'done', row };
  return row.state === spec.from ? { verdict: 'proceed', located } : conflictOf(row);
}

/** Moves the operation from `spec.from` to `spec.to` and applies `effect` in one gated transaction of its tenant. */
async function runStep(deps: AccountOperationDeps, located: LocatedOperation, input: StepInput, spec: StepSpec, effect: StepEffect): Promise<Settled> {
  const { db, repo } = deps;
  const { tenantId, row } = located;
  return withGatedTenant(db, tenantId, async (tx): Promise<Settled> => {
    const ctx: WriteContext = { operationId: row.operation_id };
    const patch = effect.patch === undefined ? {} : await effect.patch(tx);
    if (!(await repo.setAccountOperationState(tx, row.operation_id, [spec.from], spec.to, patch, ctx))) {
      // A concurrent call moved the operation first; the state it left decides.
      const current = await repo.findAccountOperation(tx, row.operation_id);
      const again = judge(current === null ? undefined : { tenantId, row: current }, row.operation_id, input, spec);
      return again.verdict === 'proceed' ? { verdict: 'conflict', operation: viewOf(again.located.row) } : again;
    }
    await effect.apply(tx, row, ctx);
    return { verdict: 'performed', row: { ...row, ...patch, state: spec.to } };
  });
}

function stepOutcome(settled: Settled, state: AccountOperationStep['state']): StepOutcome {
  if (settled.verdict === 'conflict') return { outcome: 'conflict', operation: settled.operation };
  return { outcome: 'stepped', step: { operationId: settled.row.operation_id, userId: settled.row.user_id, state } };
}

async function commitOutcome(db: TenantDb, settled: Settled): Promise<CommitOutcome> {
  if (settled.verdict === 'conflict') return { outcome: 'conflict', operation: settled.operation };
  const { row } = settled;
  const writePosition = row.commit_xid ?? (await currentPosition(db));
  return { outcome: 'committed', result: { operationId: row.operation_id, userId: row.user_id, state: 'committed', writePosition } };
}

/** The pool site of the request site's private (`isPublic` 0) or public user pool; null for an unregistered site. */
async function userPoolSite(db: TenantDb, requestSiteId: string, isPublic: number): Promise<string | null> {
  const tenant = await tenantForRegisteredSite(db, requestSiteId);
  const entry = tenant === null ? null : await registryEntryForTenant(db, tenant);
  if (entry === null) return null;
  return isPublic === 0 ? entry.privateUserPoolId : entry.publicUserPoolId;
}

/** Whether another Type=2 account of any tenant, or another user's open operation, holds `username` [legacy: core/mura/user/userBean.cfc:411-424]. */
async function usernameHeld(deps: AccountOperationDeps, username: string, userId: string): Promise<boolean> {
  const { db, repo } = deps;
  for (const tenantId of await registeredTenantIds(db)) {
    const held = await withTenant(db, tenantId, async (tx) => {
      if (await repo.isUsernameTaken(tx, username, userId)) return true;
      const open = await repo.findOpenAccountOperation(tx, { username });
      return open !== null && !sameUser(open, userId);
    });
    if (held) return true;
  }
  return false;
}

/** The password and username errors of `userBean.validate`, in its order [legacy: core/mura/user/userBean.cfc:465-477]. */
async function validateAccount(
  deps: AccountOperationDeps,
  account: { userId: string; siteId: string; username: string; password: string },
): Promise<LegacyErrors> {
  const settings = deps.settings ?? DEFAULT_ACCOUNT_SETTINGS;
  const rb = deps.rb ?? ((_siteId: string, key: AccountMessageKey) => EN_ACCOUNT_MESSAGES[key]);
  const { userId, siteId, username, password } = account;
  const errors: LegacyErrors = {};
  if (password !== '' && settings.strongPasswords && (!new RegExp(settings.strongPasswordRegex).test(password) || cfEq(username, password))) {
    errors.password = rb(siteId, 'user.passwordstrengthvalidate');
  }
  if (username === '' || (await usernameHeld(deps, username, userId))) {
    errors.username = messageFormat(rb(siteId, 'user.usernamevalidate'), username);
  }
  return errors;
}

/** The user's identity rows before the change. */
async function readBeforeImage(repo: IdentityRepository, tx: TenantTx, userId: string): Promise<BeforeImage> {
  const account = await repo.findAccountById(tx, userId, { includePending: true });
  const credential = await repo.readCredential(tx, userId);
  const loginState = await repo.findByKey<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId });
  return {
    account: account === null ? null : withoutTenant(account),
    credential: credential === null ? null : { password: credential.password, passwordcreated: isoOf(credential.passwordcreated) },
    lastlogin: isoOf(loginState?.lastlogin ?? null),
    groupIds: await repo.membershipGroupIds(tx, userId),
  };
}

/** The membership part of the change: a create always stores its groups; an update only with `updateGroups` and a group list. */
function membershipChange(kind: AccountOperationKind, change: AccountChange): PendingChange['memberships'] {
  if (kind === 'create') return { groupIds: [...(change.groupIds ?? [])], originId: null };
  if (change.updateGroups === false || change.groupIds === null) return null;
  return { groupIds: [...change.groupIds], originId: change.originID === undefined || change.originID === '' ? null : change.originID };
}

/** The stored password of the change: a create's posted or random one, an update's only when posted [legacy: core/mura/user/userManager.cfc:614-616]. */
async function credentialChange(deps: AccountOperationDeps, kind: AccountOperationKind, password: string): Promise<PendingChange['credential']> {
  const cfg = (deps.settings ?? DEFAULT_ACCOUNT_SETTINGS).password;
  if (kind === 'create') return { password: await hashNewPassword(password === '' ? randomPassword() : password, cfg) };
  return password === '' ? null : { password: await hashNewPassword(password, cfg) };
}

function preparedAgain(row: AccountOperationRow, userId: string): PrepareResult {
  const operation = viewOf(row);
  return sameUser(row, userId) && !ROLLED_BACK_STATES.has(row.state) ? { outcome: 'prepared', operation } : { outcome: 'conflict', operation };
}

function findRecorded(deps: AccountOperationDeps, tenantId: string, operationId: string): Promise<AccountOperationRow | null> {
  return withTenant(deps.db, tenantId, (tx) => deps.repo.findAccountOperation(tx, operationId));
}

async function currentXid(tx: TenantTx): Promise<string> {
  const { rows } = await tx.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
  return (rows[0] as { xid: string }).xid;
}

/** The user's group ids whose group belongs to `originId`, the only memberships `deleteUserMemberships` then removes [legacy: core/mura/user/userDAO.cfc:502-515]. */
async function originGroupIds(deps: AccountOperationDeps, tenantId: string, userId: string, originId: string): Promise<string[]> {
  const { db, repo } = deps;
  const held = await withTenant(db, tenantId, (tx) => repo.membershipGroupIds(tx, userId));
  if (held.length === 0) return [];
  const groups = await withTenant(db, tenantIdForSite(originId), (tx) => repo.findGroupsByIds(tx, held));
  return groups.filter((group) => (group.siteid ?? '').toLowerCase() === originId.toLowerCase()).map((group) => group.userid);
}

/** The writes of `userDAO.create` or `userDAO.update` on identity's units, then the membership event, held under the operation. */
async function applyCommit(
  deps: AccountOperationDeps,
  tx: TenantTx,
  row: AccountOperationRow,
  pending: PendingChange,
  onlyGroupIds: readonly string[] | undefined,
  ctx: WriteContext,
): Promise<void> {
  const { repo, events, clock } = deps;
  const { account, credential, memberships } = pending;
  const userId = row.user_id;
  if (row.kind === 'create') {
    await repo.setAccountState(tx, userId, 'active', ctx);
    await repo.insertLoginState(tx, userId, ctx);
  } else {
    const { username, s2, inactive, ispublic, siteid, remoteid, tablist } = account;
    await repo.updateAccount(tx, userId, { username, type: 2, s2, inactive, ispublic, siteid, remoteid, tablist }, ctx);
  }
  if (credential !== null) {
    await repo.writeCredential(tx, userId, { password: credential.password, passwordcreated: clock.now() }, ctx);
  }
  if (memberships === null) return;
  await repo.replaceMemberships(tx, { userId, groupIds: memberships.groupIds, onlyGroupIds }, ctx);
  await repo.clearBadMemberships(tx, { userId, siteId: account.siteid, s2: account.s2, ispublic: account.ispublic }, ctx);
  const groupIds = await repo.membershipGroupIds(tx, userId);
  if (!sameIdSet(groupIds, beforeOf(row).groupIds)) {
    await events.publishMembershipChanged(tx, { userId, siteId: account.siteid, groupIds }, { operationId: row.operation_id });
  }
}

/** Restores the memberships to `groupIds`, touching only the rows that differ. */
async function restoreMemberships(repo: IdentityRepository, tx: TenantTx, userId: string, groupIds: readonly string[], ctx: WriteContext): Promise<void> {
  const keep = new Set(groupIds.map(charKey));
  const extra = (await repo.membershipGroupIds(tx, userId)).filter((id) => !keep.has(charKey(id)));
  await repo.replaceMemberships(tx, { userId, groupIds, onlyGroupIds: extra }, ctx);
}

/** Restores the account row and, when the commit wrote it, the credential an update changed. */
async function restoreUpdatedAccount(
  repo: IdentityRepository,
  tx: TenantTx,
  userId: string,
  before: BeforeImage,
  pending: PendingChange,
  ctx: WriteContext,
): Promise<void> {
  if (before.account !== null) {
    const { userid, ...columns } = before.account;
    await repo.update(tx, USER_ACCOUNT.table, { userid }, columns, ctx);
  }
  if (pending.credential === null) return;
  if (before.credential === null) {
    await repo.delete(tx, CREDENTIAL.table, { userid: userId }, ctx);
    return;
  }
  const { password, passwordcreated } = before.credential;
  await repo.upsert(tx, CREDENTIAL.table, { userid: userId, password, passwordcreated: dateOf(passwordcreated) }, ctx);
}

/** `loginByUserID`'s pool rule: a public account logs in only where its site's public user pool is its own site [legacy: core/mura/user/userUtility.cfc:281-283]. */
async function publicPoolAdmits(tx: TenantTx, account: UserAccountRow): Promise<boolean> {
  if (!flag(account.ispublic)) return true;
  const site = account.siteid ?? '';
  const entry = site === '' ? null : await registryEntryForTenant(tx, tenantIdForSite(site));
  return entry !== null && cfEq(entry.publicUserPoolId ?? '', site);
}

/** The member groups in id order, read in the user's tenant first and then in the other registered tenants; unknown ids drop out as legacy's subquery drops them. */
async function membershipGroups(
  deps: AccountOperationDeps,
  tenantId: string,
  groupIds: readonly string[],
  own: readonly GroupAccountRow[],
): Promise<MembershipGroup[]> {
  const { db, repo } = deps;
  const found = new Map(own.map((group) => [charKey(group.userid), group]));
  for (const other of await registeredTenantIds(db)) {
    const missing = groupIds.filter((id) => !found.has(charKey(id)));
    if (missing.length === 0) break;
    if (other === tenantId) continue;
    for (const group of await withTenant(db, other, (tx) => repo.findGroupsByIds(tx, missing))) {
      found.set(charKey(group.userid), group);
    }
  }
  return groupIds.flatMap((id) => {
    const group = found.get(charKey(id));
    return group === undefined ? [] : [{ groupId: group.userid, groupName: group.groupname, siteId: group.siteid, isPublic: group.ispublic }];
  });
}

/** Re-logs the session in from the saved rows as `loginByUserID` → `loginByQuery` do, without the plugin announcements [legacy: core/mura/user/userUtility.cfc:261-388]. */
async function relogin(deps: AccountOperationDeps, tenantId: string, userId: string, sessionId: string, person: PersonFields | undefined): Promise<void> {
  const { db, repo, clock } = deps;
  const session = await locateSession(deps, sessionId);
  if (session === undefined || session.row.state !== 'active') return;
  const read = await withGatedTenant(db, tenantId, async (tx) => {
    const account = await repo.findAccountById(tx, userId);
    if (account === null || flag(account.inactive) || !(await publicPoolAdmits(tx, account))) return null;
    const groupIds = await repo.membershipGroupIds(tx, userId);
    const own = await repo.findGroupsByIds(tx, groupIds);
    const credential = await repo.readCredential(tx, userId);
    // The snapshot carries the last login before this one.
    const loginState = await repo.findByKey<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId });
    const contact = person ?? (await repo.findPersonContact(tx, userId));
    await repo.touchLastLogin(tx, userId, clock.now());
    return { account, credential, loginState, contact, groupIds, own };
  });
  if (read === null) return;
  const groups = await membershipGroups(deps, tenantId, read.groupIds, read.own);
  const snapshot = buildLoginSnapshot({ account: read.account, credential: read.credential, loginState: read.loginState, contact: read.contact, groups });
  await applyLogin(deps, { sessionId, tenantId, snapshot, mode: session.row.mode, siteId: session.row.site_id });
}

/** Validates and records the account part of a roster create or update and closes the user; a create reserves a `pending` account [legacy: core/mura/user/userManager.cfc:404-447,563-588]. */
export async function prepareAccountOperation(deps: AccountOperationDeps, input: PrepareInput): Promise<PrepareResult> {
  const { db, repo } = deps;
  const { operationId, kind, userId, change } = input;
  const tenantId = tenantIdForSite(input.siteId);
  const recorded = await findRecorded(deps, tenantId, operationId);
  if (recorded !== null) return preparedAgain(recorded, userId);

  // userBean.set picks the pool before userManager forces S2 users private, so an S2 save keeps the pool its posted visibility chose.
  const poolIsPublic = change.switchToPublic === true ? 1 : change.switchToPrivate === true ? 0 : change.isPublic;
  const s2 = input.actorIsSuperUser ? change.s2 : 0;
  const siteId = await userPoolSite(db, input.requestSiteId, poolIsPublic);
  if (siteId === null || siteId.toLowerCase() !== input.siteId.toLowerCase()) {
    throw new LegacyApiError('badRequest');
  }

  await awaitAccountOpen(db, tenantId, userId, { sleep: deps.sleep });
  // bean.setValue trims every posted simple value.
  const username = javaTrim(change.username);
  const password = javaTrim(change.password);
  const errors = await validateAccount(deps, { userId, siteId, username, password });
  if (Object.keys(errors).length > 0) return { outcome: 'invalid', errors };

  const credential = await credentialChange(deps, kind, password);
  const memberships = membershipChange(kind, change);
  const units = [...ACCOUNT_OPERATION_UNITS];
  await registerOperation(db, { operationId, kind: OPERATION_KIND, units });
  try {
    return await withGatedTenant(db, tenantId, async (tx): Promise<PrepareResult> => {
      const ctx: WriteContext = { operationId };
      // An operation that committed after the wait above keeps the user closed; its account is not this change's before-image.
      if ((await repo.findOpenAccountOperation(tx, { userId })) !== null) throw userClosed(userId, username);
      const before = await readBeforeImage(repo, tx, userId);
      if ((kind === 'update') !== (before.account !== null)) throw new LegacyApiError('badRequest');
      const account: PendingAccount = {
        username,
        s2,
        perm: change.perm,
        inactive: change.inActive,
        ispublic: flag(s2) ? 0 : poolIsPublic,
        siteid: siteId,
        remoteid: javaTrim(change.remoteID),
        tablist: change.tablist === undefined ? (before.account?.tablist ?? null) : change.tablist === null ? null : javaTrim(change.tablist),
      };
      const pending: PendingChange = { account, credential, memberships };
      if (kind === 'create') {
        await repo.insertAccount(tx, { userid: userId, type: 2, ...account, opt2_state: 'pending' }, ctx);
      }
      const row = await repo.insertAccountOperation(
        tx,
        {
          operation_id: operationId,
          user_id: userId,
          kind,
          state: 'prepared',
          username,
          pending_change: JSON.stringify(pending),
          before_values: kind === 'create' ? null : JSON.stringify(before),
        },
        ctx,
      );
      return { outcome: 'prepared', operation: viewOf(row) };
    });
  } catch (err) {
    // A concurrent prepare of the same operation won; its row is the recorded result and its registration stays.
    const winner = await findRecorded(deps, tenantId, operationId);
    if (winner !== null) return preparedAgain(winner, userId);
    await endOperation(db, operationId);
    throw isUniqueViolation(err) ? userClosed(userId, username) : err;
  }
}

/** Applies a prepared change in one identity transaction whose events stay held until finish [legacy: core/mura/user/userDAO.cfc:300-355,404-480,502-616,873-893]. */
export async function commitAccountOperation(deps: AccountOperationDeps, operationId: string, input: CommitInput = {}): Promise<CommitOutcome> {
  const judged = judge(await locateOperation(deps, operationId), operationId, input, COMMIT);
  if (judged.verdict !== 'proceed') return commitOutcome(deps.db, judged);
  const { tenantId, row } = judged.located;
  const pending = parsePending(row);
  const originId = pending.memberships?.originId ?? null;
  const onlyGroupIds = originId === null ? undefined : await originGroupIds(deps, tenantId, row.user_id, originId);
  const recordedChange: PendingChange = input.sessionEffects === undefined ? pending : { ...pending, sessionEffects: input.sessionEffects };
  const settled = await runStep(deps, judged.located, input, COMMIT, {
    patch: async (tx) => ({ commit_xid: await currentXid(tx), pending_change: JSON.stringify(recordedChange) }),
    apply: (tx, current, ctx) => applyCommit(deps, tx, current, pending, onlyGroupIds, ctx),
  });
  return commitOutcome(deps.db, settled);
}

/** Discards a prepared change, deletes a `pending` account and reopens the user; an operation never recorded only loses a stale registration. */
export async function abortAccountOperation(deps: AccountOperationDeps, operationId: string, input: StepInput = {}): Promise<StepOutcome> {
  const located = await locateOperation(deps, operationId);
  // A prepare that died between registering and recording leaves only its registration.
  if (located === undefined) await endOperation(deps.db, operationId);
  const judged = judge(located, operationId, input, ABORT);
  if (judged.verdict !== 'proceed') return stepOutcome(judged, 'aborted');
  const { repo } = deps;
  const settled = await runStep(deps, judged.located, input, ABORT, {
    patch: async () => ({ pending_change: null }),
    apply: async (tx, row, ctx) => {
      const account = await repo.findAccountById(tx, row.user_id, { includePending: true });
      if (account?.opt2_state === 'pending') await repo.deleteAccount(tx, row.user_id, ctx);
      await discardOperation(tx, row.operation_id);
      await endOperation(tx, row.operation_id);
    },
  });
  return stepOutcome(settled, 'aborted');
}

/** Restores the identity rows a committed change wrote, from the before-image recorded at prepare, and reopens the user. */
export async function revertAccountOperation(deps: AccountOperationDeps, operationId: string, input: StepInput = {}): Promise<StepOutcome> {
  const judged = judge(await locateOperation(deps, operationId), operationId, input, REVERT);
  if (judged.verdict !== 'proceed') return stepOutcome(judged, 'reverted');
  const { repo } = deps;
  const settled = await runStep(deps, judged.located, input, REVERT, {
    apply: async (tx, row, ctx) => {
      const before = beforeOf(row);
      const pending = parsePending(row);
      if (pending.memberships !== null) await restoreMemberships(repo, tx, row.user_id, before.groupIds, ctx);
      if (row.kind === 'create') await repo.deleteAccount(tx, row.user_id, ctx);
      else await restoreUpdatedAccount(repo, tx, row.user_id, before, pending, ctx);
      await discardOperation(tx, row.operation_id);
      await endOperation(tx, row.operation_id);
    },
  });
  return stepOutcome(settled, 'reverted');
}

/** Completes a committed operation: releases its held events, reopens the user, then performs a signalled re-login. */
export async function finishAccountOperation(deps: AccountOperationDeps, operationId: string, input: StepInput = {}): Promise<StepOutcome> {
  const judged = judge(await locateOperation(deps, operationId), operationId, input, FINISH);
  if (judged.verdict !== 'proceed') return stepOutcome(judged, 'finished');
  const settled = await runStep(deps, judged.located, input, FINISH, {
    apply: async (tx, row) => {
      await releaseOperation(tx, row.operation_id);
      await endOperation(tx, row.operation_id);
    },
  });
  if (settled.verdict === 'performed') {
    const effects = parsePending(settled.row).sessionEffects;
    if (effects?.reloginSessionId !== undefined) {
      await relogin(deps, judged.located.tenantId, settled.row.user_id, effects.reloginSessionId, effects.person);
    }
  }
  return stepOutcome(settled, 'finished');
}

/** The recorded operation for people's recovery; `unknown` when identity never recorded it or it belongs to another user. */
export async function accountOperationStatus(
  deps: Pick<AccountOperationDeps, 'db' | 'repo'>,
  operationId: string,
  input: StepInput = {},
): Promise<AccountOperationView> {
  const located = await locateOperation(deps, operationId);
  return located === undefined || !sameUser(located.row, input.userId) ? unknownView(operationId, input.userId) : viewOf(located.row);
}

/** Migration-handler statuses of account operations: open while prepared or committed, done once finished, rolled back once aborted or reverted. */
export const operationStatus: NonNullable<MigrationHandlerOptions['operationStatus']> = async (db, operationIds) => {
  const repo = repositoryFor(db.schema);
  const statuses: Record<string, OperationStatus> = {};
  const pending = new Set(operationIds);
  for (const tenantId of await registeredTenantIds(db)) {
    if (pending.size === 0) break;
    await withTenant(db, tenantId, async (tx) => {
      for (const operationId of [...pending]) {
        const row = await repo.findAccountOperation(tx, operationId);
        if (row === null) continue;
        statuses[operationId] = STATUS_OF_STATE[row.state];
        pending.delete(operationId);
      }
    });
  }
  return statuses;
};

/** Waits while another open account operation keeps `userId` closed; throws OperationBlockedError (the legacy 503) after `USER_CLOSED_WAIT_MS`. */
export async function awaitAccountOpen(db: TenantDb, tenantId: string, userId: string, opts: AwaitAccountOpenOptions = {}): Promise<void> {
  const repo = repositoryFor(db.schema);
  const sleep = opts.sleep ?? timerSleep;
  // The wait is the sum of the sleeps, not clock time, so a frozen injected clock cannot stall it.
  for (let waited = 0; ; ) {
    const open = await withTenant(db, tenantId, (tx) => repo.findOpenAccountOperation(tx, { userId }));
    if (open === null || open.operation_id === opts.selfOperationId) return;
    if (waited >= USER_CLOSED_WAIT_MS) {
      throw new OperationBlockedError([...ACCOUNT_OPERATION_UNITS], `Account operation ${open.operation_id} keeps user ${userId} closed`);
    }
    const step = Math.min(CLOSED_POLL_MS, USER_CLOSED_WAIT_MS - waited);
    await sleep(step);
    waited += step;
  }
}
