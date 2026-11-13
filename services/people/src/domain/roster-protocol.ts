// The roster write protocol with people as coordinator: a durable intent, identity's prepare, the people commit,
// identity's commit and the finish, for every Type=2 save whose closure includes identity units (userManager.cfc:372-700).
import { setTimeout as timerSleep } from 'node:timers/promises';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError, cfEq, cfUuid, isCfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import {
  OperationBlockedError,
  endOperation,
  registerOperation,
  withGatedTenant,
  type MigrationHandlerOptions,
  type OperationStatus,
  type RepositoryRow,
  type TableDefinition,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { discardOperation, releaseOperation } from '@opt2/platform/outbox';
import { ServiceUnavailableError, type Clock } from '@opt2/platform/service-kit';
import { registeredTenants, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import type { PeopleEvents } from '../events/publish.js';
import type {
  AccountCommitRequest,
  AccountOperationState,
  AccountPrepareRequest,
  AccountView,
  ActingUser,
  CommitOutcome,
  IdentityCallOptions,
  IdentityClient,
  PrepareOutcome,
} from '../legacy/identity-client.js';
import {
  ID_WIDTH,
  LegacyStorageError,
  RosterLockTimeoutError,
  RosterOperationOpenError,
  createPeopleRepository,
  type PeopleRepository,
  type PersonInput,
  type RosterLockOptions,
  type RosterOperationOwner,
  type RosterOperationStatePatch,
} from '../repo/repository.js';
import {
  ADDRESS,
  EXTEND_DATA,
  INTEREST,
  PERSON,
  TAG,
  TRASH,
  type AddressRow,
  type ExtendDataRow,
  type InterestRow,
  type PeopleUnit,
  type PersonRow,
  type RosterOperationRow,
  type RosterState,
  type TagRow,
  type TrashRow,
} from '../repo/tables.js';
import {
  applyAddressInput,
  insertAddressInTx,
  primaryAddressFor,
  resolveAddressPoolSite,
  setPrimaryAddress,
  updateAddressInTx,
  type AddressValues,
} from './addresses.js';
import {
  EXTEND_CONFIG_DEFAULTS,
  assertNoFileAttributeWrites,
  extendSetData,
  extendedDataRequested,
  loadSubmittedAttributes,
  saveExtendedData,
  validateExtendedData,
  type ExtendConfig,
} from './extended-data.js';
import type { FaultHooks } from './faults.js';
import type { PersonFence, PersonFenceOptions, PersonsOpenOptions } from './person-fence.js';
import { writeInterests, writeTags } from './interests-tags.js';
import {
  applySuperUserRule,
  applyUserInput,
  auditActorFor,
  lastUpdateInfo,
  newUserValues,
  normaliseParams,
  resolveUserSite,
  restrictAdminInput,
  restrictProfileInput,
  splitUserValues,
  type AccountWrite,
  type PersonWrite,
  type UserValues,
} from './person.js';
import { PEOPLE_TRASH_ENABLED, takeOut } from './trash.js';
import { addressBeanValues, userBeanValues, type EntityExtendData } from './user-entity.js';
import {
  FM_ALLOWED_EXTENSIONS,
  FM_PUBLIC_ALLOWED_EXTENSIONS,
  hasErrors,
  mergeUserErrors,
  requestHasRestrictedFiles,
  validatePersonValues,
  type LegacyErrors,
} from './validation.js';

/** Longest a read or write of a user waits while an open roster operation keeps that user closed. */
export const USER_CLOSED_WAIT_MS = 10_000;

/** Budget, from the durable intent on, within which a request resolves identity's commit outcome. */
export const REQUEST_BUDGET_MS = 10_000;

/** Part of the request budget the people commit's fence wait leaves for the identity call after it, `:abort` or `:commit`. */
export const IDENTITY_CALL_RESERVE_MS = 1_000;

/** People units a roster operation writes; its `open_operation` registration keeps their gates from closing until it ends. */
export const PEOPLE_OPERATION_UNITS: readonly PeopleUnit[] = Object.freeze([
  PERSON.unit,
  ADDRESS.unit,
  INTEREST.unit,
  TAG.unit,
  EXTEND_DATA.unit,
  ...(PEOPLE_TRASH_ENABLED ? [TRASH.unit] : []),
]);

/** Identity units a roster operation writes; identity registers them in its own schema at prepare. */
export const IDENTITY_OPERATION_UNITS = Object.freeze(['identity.user_account', 'identity.credential', 'identity.login_state', 'identity.membership'] as const);

/** The carried entry points that run the protocol: `cusers.update` Add and Update, JSON API `user` save and `ceditprofile.update`. */
export type RosterKind = 'admin-add' | 'admin-update' | 'json-save' | 'profile-update';

/** One Type=2 save without a photo. */
export interface RosterInput {
  kind: RosterKind;
  /** The person's user-pool tenant, from the site registry of the token's tenant. */
  tenantId: string;
  claims: UserClaims;
  /** The logged-in session user whose names `LastUpdateBy` records; undefined when anonymous. */
  acting?: ActingUser;
  /** Request parameters keyed by lower-cased name (`normaliseParams`). */
  params: Map<string, unknown>;
  /** File parts of the request, field name to client file name. */
  postedFiles: Map<string, string>;
  requestId: string;
  /** The saving user's own identity session, logged in again at finish as the JSON API self-save does. */
  sessionReloginId?: string;
}

/** Legacy's outcome of the save: the saved bean, or its validation errors with the values the form re-renders. */
export type RosterResult = { ok: true; userId: string; values: UserValues } | { ok: false; errors: LegacyErrors; values: UserValues };

/** The `{photo}` branches are withheld and served by legacy; raised before any write. */
export class PhotoBranchError extends LegacyServiceUnavailableError {
  override readonly name: string = 'PhotoBranchError';

  constructor() {
    super('The photo branch of a user save is served by legacy', 'auto', 'photo-withheld');
  }
}

/** The user's rows the operation may touch, captured inside the people commit before its first write. */
export interface BeforeImage {
  existed: boolean;
  person?: PersonRow;
  addresses: AddressRow[];
  interests: InterestRow[];
  tags: TagRow[];
  extendData: ExtendDataRow[];
  trash?: TrashRow[];
}

/** Text of one resource-bundle key of a site. */
type PeopleMessages = NonNullable<Parameters<typeof mergeUserErrors>[1]>;

/** Waits `ms` milliseconds. */
type Sleep = (ms: number) => Promise<unknown>;

/** Collaborators of the protocol; `faults` are awaited at each step boundary. */
export interface RosterDeps {
  db: TenantDb;
  repo: PeopleRepository;
  events: PeopleEvents;
  identity: IdentityClient;
  clock: Clock;
  faults: FaultHooks;
  /** Defaults to `EXTEND_CONFIG_DEFAULTS`. */
  extendConfig?: ExtendConfig;
  /** Texts of the user's site bundle; defaults to `en`. */
  rb?: PeopleMessages;
  /** The request locale extended dates parse in; ACF's default when omitted. */
  locale?: string;
  /** Wait between closed-user and identity-state polls; defaults to a timer. */
  sleep?: Sleep;
}

/** Options of `awaitPersonOpen`; `selfOperationId` names the caller's own operation, which does not close the user to it. */
export interface PersonOpenOptions {
  clock: Clock;
  selfOperationId?: string;
  sleep?: Sleep;
}

const CLOSED_POLL_MS = 100;
/** `open_operation.kind` of a people roster operation. */
const OPERATION_KIND = 'roster-person';
/** `roster_operation.error` of a done operation whose identity `:finish` is not yet acknowledged. */
const FINISH_PENDING = 'finish-pending';
const STATUS_OF_STATE: Readonly<Record<RosterState, OperationStatus>> = Object.freeze({
  started: 'open',
  'people-committed': 'open',
  halted: 'open',
  done: 'done',
  'rolled-back': 'rolled-back',
});
const NO_EXTEND: EntityExtendData = Object.freeze({ data: {}, extendSetId: '' });

// awaitPersonOpen and rosterOperationStatus receive only a database handle, so they read through one repository per schema.
const repositories = new Map<string, PeopleRepository>();

function repositoryFor(schema: string): PeopleRepository {
  let repo = repositories.get(schema);
  if (repo === undefined) {
    repo = createPeopleRepository({ schema });
    repositories.set(schema, repo);
  }
  return repo;
}

/** A wait budget: elapsed time is the injected clock's or the sum of the waits, whichever is larger, so a frozen clock cannot stall it. */
interface Budget {
  remaining(): number;
  pause(ms: number): Promise<void>;
  /** Counts `ms` waited outside `pause`, as on a roster lock. */
  charge(ms: number): void;
}

function startBudget(clock: Clock, budgetMs: number, sleep: Sleep): Budget {
  const from = clock.now().getTime();
  let slept = 0;
  const remaining = (): number => budgetMs - Math.max(slept, clock.now().getTime() - from);
  return {
    remaining,
    async pause(ms) {
      const step = Math.max(0, Math.min(ms, remaining()));
      await sleep(step);
      slept += step;
    },
    charge(ms) {
      slept += ms;
    },
  };
}

/** The roster-lock wait `budget` leaves. */
function lockWait(budget: Budget): RosterLockOptions {
  return { timeoutMs: budget.remaining() };
}

/** `budget` as spent while only `reservedMs` of it remain; its waits count against `budget`. */
function reserving(budget: Budget, reservedMs: number): Budget {
  const remaining = (): number => budget.remaining() - reservedMs;
  return {
    remaining,
    pause: (ms) => budget.pause(Math.max(0, Math.min(ms, remaining()))),
    charge: (ms) => {
      budget.charge(ms);
    },
  };
}

/** The legacy 503 of a user an open roster operation keeps closed. */
function userClosed(userId: string, operationId?: string): OperationBlockedError {
  const holder = operationId === undefined ? 'An open roster operation' : `Roster operation ${operationId}`;
  return new OperationBlockedError([...PEOPLE_OPERATION_UNITS, ...IDENTITY_OPERATION_UNITS], `${holder} keeps user ${userId} closed`);
}

/** The legacy 503 of a roster lock its holders kept past the user-closed wait. */
function lockNotGranted(err: RosterLockTimeoutError): OperationBlockedError {
  const closed = new OperationBlockedError([...PEOPLE_OPERATION_UNITS, ...IDENTITY_OPERATION_UNITS], err.message);
  closed.cause = err;
  return closed;
}

/** An update of a user that is no person of the tenant, or whose account identity does not hold. */
function personUnknown(userId: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`User ${userId} is not a person of this tenant`, 'auto', 'person-unknown');
}

// One transaction binds one tenant, so a save whose pool rule lands in another tenant halts instead of diverging.
/** A save whose user pool resolves to a tenant other than the person's. */
function poolMove(userId: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`User ${userId} would move to another user pool's tenant`, 'auto', 'person-pool-move');
}

/** `err` when it already carries a legacy answer, else the legacy 503 of a failure at `step`. */
function asUnavailable(err: unknown, step: string): unknown {
  if (err instanceof LegacyServiceUnavailableError || err instanceof LegacyApiError || err instanceof LegacyStorageError) return err;
  const unavailable = new LegacyServiceUnavailableError(`Roster operation failed at ${step}`, 'auto', `roster-${step}`);
  unavailable.cause = err;
  return unavailable;
}

/** The legacy 503 of an identity call the request's budget no longer leaves time for. */
function budgetSpent(step: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`Roster operation budget spent before ${step}`, 'auto', 'roster-budget');
}

/** Options bounding the next identity call by the budget's remaining time; throws budgetSpent once none remains. */
function callOptions(budget: Budget, step: string): IdentityCallOptions {
  const timeoutMs = budget.remaining();
  if (timeoutMs <= 0) throw budgetSpent(step);
  return { timeoutMs };
}

/** A posted simple value as text; '' when absent or NULL. */
function paramText(params: ReadonlyMap<string, unknown>, key: string): string {
  const value = params.get(key);
  return value === undefined || value === null ? '' : String(value);
}

/** Throws PhotoBranchError for a posted `newFile` or a `removePhotoFile=true` (userManager.cfc:495-502, 650-652). */
function assertNoPhoto(params: ReadonlyMap<string, unknown>): void {
  const newFile = params.get('newfile');
  const remove = params.get('removephotofile');
  const posted = newFile !== undefined && newFile !== null && (typeof newFile !== 'string' || javaTrim(newFile) !== '');
  if (posted || remove === true || (typeof remove === 'string' && cfEq(remove, 'true'))) throw new PhotoBranchError();
}

/** Waits while another open roster operation keeps `userId` closed; throws OperationBlockedError (the legacy 503) after `USER_CLOSED_WAIT_MS`. */
export async function awaitPersonOpen(db: TenantDb, tenantId: string, userId: string, opts: PersonOpenOptions): Promise<void> {
  await awaitOpen(db, tenantId, userId, startBudget(opts.clock, USER_CLOSED_WAIT_MS, opts.sleep ?? timerSleep), opts.selfOperationId);
}

/** Waits on `budget` while an open roster operation other than `selfOperationId` keeps `userId` closed; throws the legacy 503 once it is spent. */
async function awaitOpen(db: TenantDb, tenantId: string, userId: string, budget: Budget, selfOperationId?: string): Promise<void> {
  const repo = repositoryFor(db.schema);
  for (;;) {
    const open = await withTenant(db, tenantId, (tx) => repo.findOpenRosterOperation(tx, userId));
    if (open === null || open.operation_id === selfOperationId) return;
    if (budget.remaining() <= 0) throw userClosed(userId, open.operation_id);
    await budget.pause(CLOSED_POLL_MS);
  }
}

/** Raised in a fenced transaction whose user an open roster operation keeps closed; `withPersonsOpen` waits it out, and unhandled it is the legacy 503. */
export class PersonClosedSignal extends OperationBlockedError {
  override readonly name: string = 'PersonClosedSignal';

  constructor(
    readonly userId: string,
    readonly operationId: string,
  ) {
    const closed = userClosed(userId, operationId);
    super(closed.units, closed.message);
  }
}

// The wait budget of each transaction runPersonsOpen runs, which bounds the roster locks its fences take.
const fenceBudgets = new WeakMap<TenantTx, Budget>();

/** The roster-lock wait of `tx`: what its runPersonsOpen budget leaves, unbounded outside one. */
function fenceWait(tx: TenantTx): RosterLockOptions {
  const budget = fenceBudgets.get(tx);
  return budget === undefined ? {} : lockWait(budget);
}

/** Share-locks `userIds` until `tx` ends, then throws PersonClosedSignal when another open roster operation keeps one closed; call it before the transaction's first read or write of them. */
export async function fencePersons(tx: TenantTx, userIds: readonly string[], opts: PersonFenceOptions = {}): Promise<void> {
  const repo = repositoryFor(tx.schema);
  await repo.lockRosterUsers(tx, userIds, 'shared', fenceWait(tx));
  const open = (await repo.findOpenRosterOperations(tx, userIds)).find((row) => row.operation_id !== opts.selfOperationId);
  if (open !== undefined) throw new PersonClosedSignal(open.user_id.replace(/ +$/, ''), open.operation_id);
}

/** Runs `fn` in one gated transaction of `tenantId`, its roster locks bounded by `budget`, again after each PersonClosedSignal; throws the legacy 503 once `budget` is spent. */
async function runPersonsOpen<T>(db: TenantDb, tenantId: string, fn: (tx: TenantTx) => Promise<T>, budget: Budget): Promise<T> {
  for (;;) {
    try {
      return await withGatedTenant(db, tenantId, (tx) => {
        fenceBudgets.set(tx, budget);
        return fn(tx);
      });
    } catch (err) {
      if (err instanceof RosterLockTimeoutError) {
        budget.charge(err.timeoutMs);
        if (budget.remaining() <= 0) throw lockNotGranted(err);
        continue;
      }
      if (!(err instanceof PersonClosedSignal)) throw err;
      if (budget.remaining() <= 0) throw userClosed(err.userId, err.operationId);
    }
    await budget.pause(CLOSED_POLL_MS);
  }
}

/** `runPersonsOpen` on a fresh `USER_CLOSED_WAIT_MS` budget: the legacy 503 once a closed user or a held roster lock outlasts it. */
export async function withPersonsOpen<T>(db: TenantDb, tenantId: string, fn: (tx: TenantTx) => Promise<T>, opts: PersonsOpenOptions): Promise<T> {
  return runPersonsOpen(db, tenantId, fn, startBudget(opts.clock, USER_CLOSED_WAIT_MS, opts.sleep ?? timerSleep));
}

/** The roster fence the address and archive saves take as their `fence` collaborator. */
export const personFence: PersonFence = Object.freeze({ fencePersons, withPersonsOpen });

/** Collaborators of `observePersons`; `sleep` waits between attempts and defaults to a timer. */
export interface PersonObserverDeps {
  db: TenantDb;
  repo: Pick<PeopleRepository, 'lockRosterUsers' | 'lockRosterTenant' | 'findOpenRosterOperations' | 'countRosterOperations'>;
  clock: Clock;
  sleep?: Sleep;
}

/** The people side of one observation attempt. */
export interface PersonObserver {
  /**
   * Runs `read` in one transaction of `tenantId` under the shared roster lock of `userIds`, or of the tenant when omitted,
   * and covers the users `covered` names in its result.
   */
  read<T>(tenantId: string, read: (tx: TenantTx) => Promise<T>, covered: (result: T) => readonly string[], userIds?: readonly string[]): Promise<T>;
}

/** Covered users of one observed people read and their operation count at that read. */
interface ObservedRead {
  tenantId: string;
  userIds: readonly string[];
  count: number;
}

/** A covered user whose operations changed since its read; `operationId` names one still open. */
interface ObservedChange {
  userId: string;
  operationId?: string;
}

/** The first covered user whose operations changed since `reads`, checked in one transaction per tenant; undefined when none did. */
async function changeSince(deps: PersonObserverDeps, reads: readonly ObservedRead[]): Promise<ObservedChange | undefined> {
  const byTenant = new Map<string, ObservedRead[]>();
  for (const read of reads) if (read.userIds.length > 0) byTenant.set(read.tenantId, [...(byTenant.get(read.tenantId) ?? []), read]);
  for (const [tenantId, tenantReads] of byTenant) {
    const change = await withTenant(deps.db, tenantId, async (tx): Promise<ObservedChange | undefined> => {
      for (const { userIds, count } of tenantReads) {
        const open = (await deps.repo.findOpenRosterOperations(tx, userIds))[0];
        if (open !== undefined) return { userId: open.user_id.replace(/ +$/, ''), operationId: open.operation_id };
        if ((await deps.repo.countRosterOperations(tx, userIds)) !== count) return { userId: userIds[0] ?? '' };
      }
      return undefined;
    });
    if (change !== undefined) return change;
  }
  return undefined;
}

/**
 * Reads people's rows through `people`, then identity's through `identity` outside any transaction, again until no roster
 * operation on a covered user was open at or started after its read; throws OperationBlockedError (the legacy 503) after `USER_CLOSED_WAIT_MS`.
 */
export async function observePersons<P, R>(
  deps: PersonObserverDeps,
  people: (observer: PersonObserver) => Promise<P>,
  identity: (rows: P) => Promise<R>,
): Promise<R> {
  const { db, repo } = deps;
  const budget = startBudget(deps.clock, USER_CLOSED_WAIT_MS, deps.sleep ?? timerSleep);
  for (;;) {
    const reads: ObservedRead[] = [];
    const observer: PersonObserver = {
      read: (tenantId, read, covered, userIds) =>
        withTenant(db, tenantId, async (tx) => {
          if (userIds === undefined) await repo.lockRosterTenant(tx, 'shared', lockWait(budget));
          else await repo.lockRosterUsers(tx, userIds, 'shared', lockWait(budget));
          // The shared lock keeps operations from starting, not an open one from finishing during the read.
          const open = await repo.findOpenRosterOperations(tx, userIds);
          const result = await read(tx);
          const users = covered(result);
          for (const operation of open) {
            if ((await repo.countRosterOperations(tx, users, [operation.operation_id])) > 0) {
              throw new PersonClosedSignal(operation.user_id.replace(/ +$/, ''), operation.operation_id);
            }
          }
          reads.push({ tenantId, userIds: users, count: await repo.countRosterOperations(tx, users) });
          return result;
        }),
    };
    let change: ObservedChange | undefined;
    try {
      const result = await identity(await people(observer));
      change = await changeSince(deps, reads);
      if (change === undefined) return result;
    } catch (err) {
      if (err instanceof RosterLockTimeoutError) {
        budget.charge(err.timeoutMs);
        if (budget.remaining() <= 0) throw lockNotGranted(err);
        continue;
      }
      if (!(err instanceof PersonClosedSignal)) throw err;
      change = { userId: err.userId, operationId: err.operationId };
    }
    if (budget.remaining() <= 0) throw userClosed(change.userId, change.operationId);
    // A covered operation that started and ended in between leaves nothing to wait out.
    if (change.operationId !== undefined) await budget.pause(CLOSED_POLL_MS);
  }
}

/** The stored user an update starts from: people's rows and identity's account and memberships. */
interface StoredUser {
  person: PersonRow;
  account: AccountView;
  groupIds: string[];
  categoryIds: string[];
  extend: EntityExtendData;
}

/** A save shaped as `userBean.set` and `validate` leave it, before any write. */
interface ShapedSave {
  operation: 'create' | 'update';
  userId: string;
  /** The input after the controller restrictions; the address bean is set from it. */
  params: Map<string, unknown>;
  /** The bean after the pool and S2 rules. */
  values: UserValues;
  account: AccountWrite;
  person: PersonWrite;
  errors: { extended: Record<string, string>; people: LegacyErrors; restrictedFiles: boolean };
  saveExtended: boolean;
  /** A create's primary address; undefined for a user restored from the trash. */
  primaryAddress?: AddressValues;
  /** The posted address an update re-saves; '' for none. */
  addressId: string;
  addressPoolSite?: string;
}

/** The action `restrictAdminInput` voided: no write, the route re-routes with these values. */
interface VoidedSave {
  voided: true;
  userId: string;
  values: UserValues;
}

/**
 * People's rows of `userId` plus identity's account and, when `withMemberships`, its memberships; null when no person
 * row exists.
 */
async function loadStoredUser(deps: RosterDeps, tenantId: string, userId: string, withMemberships: boolean, budget: Budget): Promise<StoredUser | null> {
  const { repo } = deps;
  const config = deps.extendConfig ?? EXTEND_CONFIG_DEFAULTS;
  const local = await withTenant(deps.db, tenantId, async (tx) => {
    const person = await repo.findPerson(tx, userId);
    if (person === null) return null;
    const categoryIds = (await repo.listInterests(tx, person.userid)).map((row) => row.categoryid);
    // getAllValues builds the bean's extended data for its site, Type 2 and subtype (beanExtendable.cfc:139-151).
    const scope = { siteId: person.siteid ?? '', type: '2', subtype: person.subtype ?? '' };
    return { person, categoryIds, extend: await extendSetData(repo, tx, person.userid, scope, config) };
  });
  if (local === null) return null;
  const account = await deps.identity.readAccount(local.person.userid, callOptions(budget, 'shape'));
  if (account === undefined) throw personUnknown(userId);
  const groupIds = withMemberships ? await deps.identity.membershipGroupIds(local.person.userid, callOptions(budget, 'shape')) : [];
  return { ...local, account, groupIds };
}

/** The user a save writes, from the request alone: the session user, the posted `userid`, or a new id for a create. */
interface SaveTarget {
  userId: string;
  /** Create, or update a stored user; a JSON API save of a user no person row holds turns into a create. */
  operation: ShapedSave['operation'];
}

/** The save's target before any read; `restrictAdminInput` leaves `userid` as posted. */
function saveTarget(input: RosterInput): SaveTarget {
  if (input.kind === 'profile-update') return { userId: input.claims.sub, operation: 'update' };
  const posted = javaTrim(paramText(input.params, 'userid'));
  if (posted === '') return { userId: cfUuid(), operation: 'create' };
  return { userId: posted, operation: input.kind === 'admin-add' ? 'create' : 'update' };
}

/** Under the intent: the controller restrictions, the bean values, the pool and S2 rules and people's validation, reading only. */
async function shapeSave(deps: RosterDeps, input: RosterInput, target: SaveTarget, budget: Budget): Promise<ShapedSave | VoidedSave> {
  const { claims, tenantId } = input;
  let params = input.params;
  let voided = false;
  if (input.kind === 'admin-add' || input.kind === 'admin-update') {
    const posted = paramText(params, 'userid');
    const targetAccount = isCfUuid(posted) ? await deps.identity.readAccount(posted, callOptions(budget, 'shape')) : undefined;
    const restricted = restrictAdminInput(params, { actorIsSuperUser: claims.s2, targetIsS2: (targetAccount?.s2 ?? 0) !== 0 });
    params = restricted.input;
    voided = cfEq(restricted.action, 'invalid');
  }

  let { userId, operation } = target;
  let stored: StoredUser | null = null;
  if (operation === 'update') {
    // A profile save writes no memberships (updateGroups=false), and identity lists them only to cUsers callers, which
    // a profile's own user need not be.
    stored = await loadStoredUser(deps, tenantId, userId, input.kind !== 'profile-update', budget);
    if (stored === null) {
      // userManager.save creates a user no tusers row holds; the admin and profile updates read a stored one.
      if (input.kind !== 'json-save') throw personUnknown(userId);
      operation = 'create';
    } else {
      userId = stored.person.userid;
    }
  }
  if (input.kind === 'profile-update' && stored !== null) {
    params = restrictProfileInput(params, { userId, siteId: stored.account.siteId });
  }
  // `tfiles.fileExt` belongs to strategies-content, and a save without a photo neither reads nor writes it.
  const base = stored === null ? newUserValues(deps.clock) : userBeanValues({ ...stored, photoFileExt: '' }, deps.clock);
  if (voided) return { voided: true, userId, values: base };

  const set = applyUserInput(base, params);
  const site = await resolveUserSite(deps.db, claims.tid, params, set);
  if (site.poolTenantId !== tenantId) throw poolMove(userId);
  const pooled: UserValues = { ...set, userid: userId, siteid: site.siteId, ispublic: site.isPublic };
  const values = applySuperUserRule(pooled, claims.s2);
  // splitUserValues takes the values before the S2 rule: identity applies it from the token, and isPublic must stay the pool's.
  const controls = operation === 'update' ? { updateGroups: input.kind !== 'profile-update', poolSwitch: site.poolSwitch } : { poolSwitch: site.poolSwitch };
  const { person, account } = splitUserValues(pooled, controls);
  return {
    operation,
    userId,
    params,
    values,
    account,
    person,
    ...(await validateSave(deps, input, params, values, operation)),
    addressId: operation === 'update' ? javaTrim(values.addressid) : '',
  };
}

/** People's part of `userBean.validate` and `requestHasRestrictedFiles`, the File-attribute refusal and the address pool site. */
async function validateSave(
  deps: RosterDeps,
  input: RosterInput,
  params: ReadonlyMap<string, unknown>,
  values: UserValues,
  operation: ShapedSave['operation'],
): Promise<Pick<ShapedSave, 'errors' | 'saveExtended' | 'primaryAddress' | 'addressPoolSite'>> {
  const { repo } = deps;
  const config = deps.extendConfig ?? EXTEND_CONFIG_DEFAULTS;
  const data = normaliseParams(values);
  const siteId = values.siteid;
  return withTenant(deps.db, input.tenantId, async (tx) => {
    const extended =
      siteId === ''
        ? {}
        : validateExtendedData(await loadSubmittedAttributes(repo, tx, values.extendsetid, siteId, { forSave: false }), data, config, deps.locale, deps.rb);
    const saveExtended = extendedDataRequested(data, { requireNonEmptySetIds: true });
    if (saveExtended) {
      const attributes = await loadSubmittedAttributes(repo, tx, values.extendsetid, siteId, { forSave: true });
      assertNoFileAttributeWrites(attributes, data, await repo.listExtendData(tx, [values.userid]));
    }
    const fileAttributeNames = new Set(
      (await repo.listExtendAttributes(tx, { siteId })).flatMap((row) => (row.type === 'File' && row.name !== null ? [row.name] : [])),
    );
    const restrictedFiles = requestHasRestrictedFiles(data, {
      allowedExtensions: operation === 'create' ? FM_ALLOWED_EXTENSIONS : FM_PUBLIC_ALLOWED_EXTENSIONS,
      fileAttributeNames,
      postedFiles: input.postedFiles,
    });
    const addressPoolSite = await resolveAddressPoolSite(tx, input.claims.tid, params);
    const primaryAddress = operation === 'create' ? primaryAddressFor(values.userid, params, addressPoolSite) : undefined;
    return {
      errors: { extended, people: validatePersonValues(values, deps.rb), restrictedFiles },
      saveExtended,
      ...(primaryAddress === undefined ? {} : { primaryAddress }),
      ...(addressPoolSite === undefined ? {} : { addressPoolSite }),
    };
  });
}

/** `roster_operation.payload`: the account and person changes; the plain password stays out, as identity hashes it at prepare. */
function payloadOf(shaped: ShapedSave): string {
  const { Password: password, ...account } = shaped.account.account;
  return JSON.stringify({
    operation: shaped.operation,
    ...shaped.account,
    account: { ...account, passwordChanged: password !== undefined },
    person: shaped.person,
  });
}

/** Step 1: commits the operation in state `started` with an empty payload, waiting out another open operation or its roster locks' holders once, within `USER_CLOSED_WAIT_MS`. */
async function recordIntent(deps: RosterDeps, input: RosterInput, userId: string, write: WriteContext): Promise<RosterOperationRow> {
  const intent = { kind: input.kind, userId, payload: '{}' };
  const budget = startBudget(deps.clock, USER_CLOSED_WAIT_MS, deps.sleep ?? timerSleep);
  for (let waited = false; ; waited = true) {
    try {
      return await withTenant(deps.db, input.tenantId, (tx) => deps.repo.insertRosterOperation(tx, intent, write, lockWait(budget)));
    } catch (err) {
      if (err instanceof RosterLockTimeoutError) budget.charge(err.timeoutMs);
      else if (!(err instanceof RosterOperationOpenError)) throw err;
      if (waited) throw userClosed(userId);
    }
    await awaitOpen(deps.db, input.tenantId, userId, budget);
  }
}

/** Shapes the save under its intent and records the payload; a failed or voided save closes the operation `rolled-back`. */
async function shapeUnderIntent(
  deps: RosterDeps,
  input: RosterInput,
  target: SaveTarget,
  operationId: string,
  budget: Budget,
  write: WriteContext,
): Promise<ShapedSave | VoidedSave> {
  const rollBack = (error: string): Promise<void> =>
    guarded('shape', () => closeOperation(deps, input.tenantId, operationId, { state: 'rolled-back', error }, write));
  let shaped: ShapedSave | VoidedSave;
  try {
    shaped = await shapeSave(deps, input, target, budget);
    if (!('voided' in shaped)) {
      const payload = payloadOf(shaped);
      await guarded('shape', () => withTenant(deps.db, input.tenantId, (tx) => deps.repo.setRosterOperationState(tx, operationId, { state: 'started', payload }, write)));
    }
  } catch (err) {
    await rollBack('shape');
    throw err;
  }
  if ('voided' in shaped) await rollBack('voided');
  return shaped;
}

/** Moves the operation to its final state and ends its `open_operation` registration in one transaction. */
async function closeOperation(
  deps: Pick<RosterDeps, 'db' | 'repo'>,
  tenantId: string,
  operationId: string,
  patch: RosterOperationStatePatch,
  write: WriteContext,
): Promise<void> {
  await withTenant(deps.db, tenantId, async (tx) => {
    await deps.repo.setRosterOperationState(tx, operationId, patch, write);
    await endOperation(tx, operationId);
  });
}

/** The rows of `userId` the people commit may touch, read in its transaction before the first write. */
async function captureBeforeImage(repo: PeopleRepository, tx: TenantTx, shaped: ShapedSave): Promise<BeforeImage> {
  const { userId } = shaped;
  const person = await repo.findPerson(tx, userId);
  const addresses = await repo.listAddresses(tx, userId);
  // A posted addressid of another user's address moves that address to this user (userManager.cfc:450-454, 504-506).
  const posted = shaped.addressId === '' ? null : await repo.findAddress(tx, shaped.addressId);
  if (posted !== null && !addresses.some((row) => row.addressid === posted.addressid)) addresses.push(posted);
  const trash = shaped.operation === 'create' && shaped.params.has('frommuratrash') ? await repo.findByKey<TrashRow>(tx, TRASH.table, { objectid: userId }) : null;
  return {
    existed: person !== null,
    ...(person === null ? {} : { person }),
    addresses,
    interests: await repo.listInterests(tx, userId),
    tags: await repo.listTags(tx, userId),
    extendData: await repo.listExtendData(tx, [userId]),
    ...(trash === null ? {} : { trash: [trash] }),
  };
}

/** Row-locks every address the update writes, then (row locks before roster locks, as address saves take them) exclusively locks the posted address's other owner; throws PersonClosedSignal while an open operation keeps it closed. */
async function fenceMovedAddress(repo: PeopleRepository, tx: TenantTx, shaped: ShapedSave, operationId: string): Promise<void> {
  if (shaped.addressId === '') return;
  const { primaryaddressid } = shaped.values;
  await repo.lockAddresses(tx, primaryaddressid === '' ? [shaped.addressId] : [shaped.addressId, primaryaddressid], shaped.userId);
  const owner = ((await repo.findAddress(tx, shaped.addressId))?.userid ?? '').replace(/ +$/, '');
  if (owner === '' || owner === shaped.userId.replace(/ +$/, '')) return;
  await repo.lockRosterUsers(tx, [owner], 'exclusive', fenceWait(tx));
  const open = (await repo.findOpenRosterOperations(tx, [owner])).find((row) => row.operation_id !== operationId);
  if (open !== undefined) throw new PersonClosedSignal(open.user_id.replace(/ +$/, ''), open.operation_id);
}

/** Step 3: people's writes of `userManager.update`/`create` in one fenced, gated transaction, the held person event and state `people-committed`; fence waits draw on `budget`. */
async function commitPeople(
  deps: RosterDeps,
  input: RosterInput,
  shaped: ShapedSave,
  operationId: string,
  budget: Budget,
  write: WriteContext,
): Promise<{ operation: RosterOperationRow; person: PersonRow; audit: { lastupdateby: string; lastupdatebyid: string } }> {
  const { repo } = deps;
  const { userId, values } = shaped;
  const audit = lastUpdateInfo(auditActorFor(input.claims, input.acting), { userid: userId, fname: values.fname, lname: values.lname });
  const columns: PersonInput = { ...shaped.person, ...audit, userid: userId, siteid: values.siteid };
  const data = normaliseParams(values);
  const config = deps.extendConfig ?? EXTEND_CONFIG_DEFAULTS;
  const commit = async (tx: TenantTx) => {
    await fenceMovedAddress(repo, tx, shaped, operationId);
    const before = await captureBeforeImage(repo, tx, shaped);
    if (shaped.saveExtended) {
      await saveExtendedData(repo, tx, userId, data, { siteId: values.siteid, config, write, ...(deps.locale === undefined ? {} : { locale: deps.locale }) });
    }
    let person: PersonRow | null;
    if (shaped.operation === 'create') {
      person = await repo.insertPerson(tx, columns, write);
      await writeInterests(repo, tx, userId, values.categoryid, { updateInterests: true }, write);
      await writeTags(repo, tx, values, write);
      await takeOut(repo, tx, userId, shaped.params, { write });
      if (shaped.primaryAddress !== undefined) await insertAddressInTx(repo, tx, shaped.primaryAddress, write);
    } else {
      const stored = shaped.addressId === '' ? null : await repo.findAddress(tx, shaped.addressId);
      if (stored !== null) {
        const address = applyAddressInput(addressBeanValues({ address: stored, extend: NO_EXTEND }), shaped.params, shaped.addressPoolSite);
        await updateAddressInTx(repo, tx, address, write);
      }
      person = await repo.updatePerson(tx, userId, columns, write);
      if (person === null) throw personUnknown(userId);
      await writeInterests(repo, tx, userId, values.categoryid, { updateInterests: true }, write);
      if (values.primaryaddressid !== '') await setPrimaryAddress(repo, tx, userId, values.primaryaddressid, write);
      await writeTags(repo, tx, values, write);
    }
    await deps.events.publishPersonChanged(tx, person, { operationId });
    const operation = await repo.setRosterOperationState(tx, operationId, { state: 'people-committed', beforeImage: JSON.stringify(before) }, write);
    if (operation === null) throw new Error(`Roster operation ${operationId} is missing from its tenant`);
    return { operation, person, audit };
  };
  return runPersonsOpen(deps.db, input.tenantId, commit, reserving(budget, IDENTITY_CALL_RESERVE_MS));
}

/**
 * Identity's state of the operation, asked again while identity is unreachable and the budget lasts; once it is spent,
 * throws the last failure, `cause` when no call fit.
 */
async function identityState(deps: RosterDeps, userId: string, operationId: string, budget: Budget, cause: unknown): Promise<AccountOperationState | undefined> {
  let failure = cause;
  for (;;) {
    const timeoutMs = budget.remaining();
    if (timeoutMs <= 0) throw failure;
    try {
      return await deps.identity.operationState(userId, operationId, { timeoutMs });
    } catch (err) {
      if (!(err instanceof ServiceUnavailableError)) throw err;
      failure = err;
    }
    await budget.pause(CLOSED_POLL_MS);
  }
}

/** The commit body: the saving user's own session, logged in again from the saved person at finish. */
function commitRequest(input: RosterInput, person: PersonRow): AccountCommitRequest | undefined {
  if (input.sessionReloginId === undefined) return undefined;
  const { fname, lname, email, company, subtype } = person;
  return { sessionEffects: { reloginSessionId: input.sessionReloginId, person: { fname, lname, email, company, subtype } } };
}

/** Step 5 after `done`: identity's `:finish`, then the operation leaves `finish-pending` and its registration ends. */
async function finishOperation(deps: RosterDeps, tenantId: string, userId: string, operationId: string, budget: Budget, write: WriteContext): Promise<void> {
  try {
    await deps.faults.at('after-done');
    await deps.identity.finish(userId, operationId, callOptions(budget, 'finish'));
    await closeOperation(deps, tenantId, operationId, { state: 'done', error: null }, write);
  } catch {
    // The change is complete on both sides, so the save succeeds; recovery repeats the `finish-pending` operation's `:finish`.
  }
}

/** Runs `fn`, answering its failure with the legacy 503 of `step` unless the error carries its own legacy answer. */
async function guarded<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asUnavailable(err, step);
  }
}

/**
 * Runs one Type=2 save under the roster write protocol. Returns legacy's validation outcome as `ok: false`; throws the
 * legacy 503 for a rejected save, which leaves no change on either side once any open step is recovered.
 */
export async function runRosterOperation(deps: RosterDeps, input: RosterInput): Promise<RosterResult> {
  assertNoPhoto(input.params);
  const { tenantId, claims } = input;
  const target = saveTarget(input);
  // No stored person has a wider id, so the admin and profile updates refuse it as they refuse an unknown person, before any intent.
  if (target.operation === 'update' && input.kind !== 'json-save' && target.userId.length > ID_WIDTH) throw personUnknown(target.userId);
  const base: WriteContext = { origin: 'target', actorUserId: claims.sub, requestId: input.requestId };

  const operationId = (await recordIntent(deps, input, target.userId, base)).operation_id;
  const budget = startBudget(deps.clock, REQUEST_BUDGET_MS, deps.sleep ?? timerSleep);
  const write: WriteContext = { ...base, operationId };
  const shaped = await shapeUnderIntent(deps, input, target, operationId, budget, write);
  if ('voided' in shaped) return { ok: true, userId: shaped.userId, values: shaped.values };
  const { userId } = shaped;
  try {
    // Only people's units: this schema holds no identity gates, and identity registers its own units at prepare.
    await registerOperation(deps.db, { operationId, kind: OPERATION_KIND, units: PEOPLE_OPERATION_UNITS });
  } catch (err) {
    await guarded('register', () => closeOperation(deps, tenantId, operationId, { state: 'rolled-back', error: 'units-blocked' }, write));
    throw err;
  }
  // Until identity's answer is known, a failure leaves the operation `started` for recovery's `:abort`.
  await guarded('after-start', () => deps.faults.at('after-start'));
  const prepareTimeoutMs = budget.remaining();
  if (prepareTimeoutMs <= 0) {
    await guarded('prepare', () => closeOperation(deps, tenantId, operationId, { state: 'rolled-back', error: 'request-budget' }, write));
    throw budgetSpent('prepare');
  }
  const change: AccountPrepareRequest = { kind: shaped.operation, ...shaped.account };
  const prepared = await guarded('prepare', () => deps.identity.prepare(userId, operationId, change, { timeoutMs: prepareTimeoutMs }));

  const errors = mergeUserErrors({ ...shaped.errors, identity: prepared.ok ? {} : prepared.errors, siteId: shaped.values.siteid }, deps.rb);
  if (hasErrors(errors)) {
    await guarded('validation', async () => {
      if (prepared.ok) await deps.identity.abort(userId, operationId, callOptions(budget, 'abort'));
      await closeOperation(deps, tenantId, operationId, { state: 'rolled-back', error: 'validation' }, write);
    });
    return { ok: false, errors, values: { ...shaped.values, errors } };
  }

  let committed: Awaited<ReturnType<typeof commitPeople>>;
  try {
    await deps.faults.at('after-prepare');
    committed = await commitPeople(deps, input, shaped, operationId, budget, write);
  } catch (err) {
    await guarded('people-commit', async () => {
      await deps.identity.abort(userId, operationId, callOptions(budget, 'abort'));
      await closeOperation(deps, tenantId, operationId, { state: 'rolled-back', error: 'people-commit' }, write);
    });
    throw asUnavailable(err, 'people-commit');
  }

  const commitBody = commitRequest(input, committed.person);
  let commit: CommitOutcome;
  try {
    await deps.faults.at('after-people-commit');
    commit = await deps.identity.commit(userId, operationId, commitBody, callOptions(budget, 'identity-commit'));
  } catch (err) {
    // Unreachable past the budget, the operation stays `people-committed` and the user closed until recovery.
    const state = await guarded('identity-commit', () => identityState(deps, userId, operationId, budget, err));
    if (state !== 'committed' && state !== 'finished') {
      await guarded('identity-commit', async () => {
        await restoreBeforeImage(deps, tenantId, committed.operation);
        if (state === 'prepared') await deps.identity.abort(userId, operationId, callOptions(budget, 'abort'));
        await closeOperation(deps, tenantId, operationId, { state: 'rolled-back', error: 'identity-commit' }, write);
      });
      throw asUnavailable(err, 'identity-commit');
    }
    // A committed operation's commit answers its recorded position again; unanswered, recovery reverts both sides.
    commit = await guarded('identity-commit', () => deps.identity.commit(userId, operationId, commitBody, callOptions(budget, 'identity-commit')));
  }
  // A failure past identity's commit leaves `people-committed` with identity committed, which recovery reverts on both sides.
  await guarded('after-identity-commit', () => deps.faults.at('after-identity-commit'));

  await guarded('done', () =>
    withTenant(deps.db, tenantId, async (tx) => {
      await deps.repo.setRosterOperationState(tx, operationId, { state: 'done', error: FINISH_PENDING, identityXid: commit.writePosition }, write);
      await releaseOperation(tx, operationId);
    }),
  );
  await finishOperation(deps, tenantId, userId, operationId, budget, write);
  return { ok: true, userId, values: { ...shaped.values, ...committed.audit, isnew: 0, errors: {} } };
}

/** `row` with its timestamp columns, which JSON carries as ISO text, back as Dates. */
function revived<R>(table: Pick<TableDefinition, 'columns'>, row: Record<string, unknown>): R {
  const values: Record<string, unknown> = { ...row };
  for (const { name, type } of table.columns) {
    const value = values[name];
    if (type === 't' && typeof value === 'string') values[name] = new Date(value);
  }
  return values as R;
}

/** The before-image stored with a `people-committed` operation. */
function parseBeforeImage(text: string): BeforeImage {
  const image = JSON.parse(text) as BeforeImage;
  const rows = <R>(table: Pick<TableDefinition, 'columns'>, list: readonly unknown[]): R[] => list.map((row) => revived<R>(table, row as Record<string, unknown>));
  return {
    existed: image.existed,
    ...(image.person === undefined ? {} : { person: revived<PersonRow>(PERSON, image.person) }),
    addresses: rows<AddressRow>(ADDRESS, image.addresses),
    interests: rows<InterestRow>(INTEREST, image.interests),
    tags: rows<TagRow>(TAG, image.tags),
    extendData: rows<ExtendDataRow>(EXTEND_DATA, image.extendData),
    ...(image.trash === undefined ? {} : { trash: rows<TrashRow>(TRASH, image.trash) }),
  };
}

/** A stored row without the `tenant_id` the repository fills from the transaction. */
function withoutTenant(row: RepositoryRow): RepositoryRow {
  const { tenant_id: _tenant, ...columns } = row;
  return columns;
}

/** Puts `table` back to `before`: every current or captured key is deleted, then each captured row is inserted as stored. */
async function restoreRows(
  repo: PeopleRepository,
  tx: TenantTx,
  table: Pick<TableDefinition, 'table' | 'key'>,
  current: readonly RepositoryRow[],
  before: readonly RepositoryRow[],
  write: WriteContext,
): Promise<void> {
  const keyColumns = table.key;
  if (keyColumns === null) throw new TypeError(`${table.table} has no key to restore rows by`);
  const keys = new Map<string, RepositoryRow>();
  for (const row of [...current, ...before]) {
    const key = Object.fromEntries(keyColumns.map((column) => [column, row[column]]));
    keys.set(JSON.stringify(key), key);
  }
  for (const key of keys.values()) await repo.delete(tx, table.table, key, write);
  for (const row of before) await repo.insert(tx, table.table, withoutTenant(row), write);
}

/** Puts the person row back to its before values one `row_version` on, or removes the row a create inserted. */
async function restorePerson(repo: PeopleRepository, tx: TenantTx, userId: string, before: PersonRow | undefined, write: WriteContext): Promise<void> {
  const current = await repo.findPerson(tx, userId);
  if (before === undefined) {
    if (current !== null) await repo.delete(tx, PERSON.table, { userid: current.userid }, write);
    return;
  }
  const { tenant_id: _tenant, ...columns } = before;
  const version = BigInt(current?.row_version ?? before.row_version) + 1n;
  await repo.upsert(tx, PERSON.table, { ...columns, userid: current?.userid ?? before.userid, row_version: String(version) }, write);
}

/**
 * Restores, in `tx`, the rows a `people-committed` operation wrote from its before-image and discards its held outbox rows
 * under the operation's id; throws RosterOperationClaimedError, restoring nothing, unless the locked operation is still in
 * `operation.state` and held by `owner` (default its request), which keeps the user closed to every other writer.
 */
export async function restoreBeforeImageInTx(repo: PeopleRepository, tx: TenantTx, operation: RosterOperationRow, owner: RosterOperationOwner = {}): Promise<void> {
  const operationId = operation.operation_id;
  const held = await repo.holdRosterOperation(tx, operationId, operation.state, owner);
  if (held === null) throw new Error(`Roster operation ${operationId} is missing from its tenant`);
  const userId = held.user_id.replace(/ +$/, '');
  const before = held.before_image === null ? null : parseBeforeImage(held.before_image);
  if (before !== null) {
    const write: WriteContext = { origin: 'target', operationId };
    await restoreRows(repo, tx, EXTEND_DATA, await repo.listExtendData(tx, [userId]), before.extendData, write);
    await restoreRows(repo, tx, ADDRESS, await repo.listAddresses(tx, userId), before.addresses, write);
    await restoreRows(repo, tx, INTEREST, await repo.listInterests(tx, userId), before.interests, write);
    await restoreRows(repo, tx, TAG, await repo.listTags(tx, userId), before.tags, write);
    // The operation only deletes trash rows, so only captured rows that are gone are written back.
    for (const row of before.trash ?? []) {
      if ((await repo.findByKey(tx, TRASH.table, { objectid: row.objectid })) === null) await repo.insert(tx, TRASH.table, withoutTenant(row), write);
    }
    await restorePerson(repo, tx, userId, before.person, write);
  }
  await discardOperation(tx, operationId);
}

/** `restoreBeforeImageInTx` in its own gated transaction. */
export async function restoreBeforeImage(
  deps: Pick<RosterDeps, 'db' | 'repo'>,
  tenantId: string,
  operation: RosterOperationRow,
  owner: RosterOperationOwner = {},
): Promise<void> {
  await withGatedTenant(deps.db, tenantId, (tx) => restoreBeforeImageInTx(deps.repo, tx, operation, owner));
}

/** Migration-handler statuses of roster operations: open while started, people-committed or halted, done once done, rolled back once rolled back. */
export const rosterOperationStatus: NonNullable<MigrationHandlerOptions['operationStatus']> = async (db, operationIds) => {
  const repo = repositoryFor(db.schema);
  const statuses: Record<string, OperationStatus> = {};
  const pending = new Set(operationIds);
  const tenants = new Set((await registeredTenants(db)).map((entry) => entry.tenantId));
  for (const tenantId of tenants) {
    if (pending.size === 0) break;
    await withTenant(db, tenantId, async (tx) => {
      for (const operationId of [...pending]) {
        const row = await repo.findRosterOperation(tx, operationId);
        if (row === null) continue;
        statuses[operationId] = STATUS_OF_STATE[row.state];
        pending.delete(operationId);
      }
    });
  }
  return statuses;
};
