/** Identity as its contract declares it: an in-process service client with identity's roster account-operation states. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Roles, moduleRole } from '@opt2/platform/auth';
import {
  apiUnavailableResponse,
  cfDateTimeFormat,
  javaTrim,
  legacyErrorResponse,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import { formatWritePosition, WRITE_POSITION_HEADER_LC } from '@opt2/platform/migration-kit';
import {
  currentRequestContext,
  decodeServiceBody,
  IDENTITY_SERVICE,
  SERVICE_CALL_TIMEOUT_MS,
  ServiceUnavailableError,
  systemClock,
  UnknownServiceError,
  type Clock,
  type CsrfConsumeRequest,
  type CsrfConsumeResponse,
  type FastifyInstance,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  ContractAssertionError,
  findOperation,
  registryPayloads,
  type ContractViolation,
} from '@opt2/platform/testing';
import {
  createIdentityClient,
  type AccountCommitRequest,
  type AccountCountRequest,
  type AccountOperation,
  type AccountOperationState,
  type AccountPrepareRequest,
  type AccountView,
  type AccountWhere,
  type AdminSessionState,
  type IdentityClient,
  type LegacyErrors,
  type SessionSite,
  type UsernameCandidateRequest,
} from '../../src/legacy/identity-client.js';

/** Identity's OpenAPI document as parsed from `services/identity/contracts/openapi.yaml`. */
export type IdentityContract = Readonly<Record<string, unknown>>;

const CONTRACT_URL = new URL('../../../identity/contracts/openapi.yaml', import.meta.url);
let contract: IdentityContract | undefined;

/** Identity's contract, read and parsed once. */
export function identityContract(): IdentityContract {
  contract ??= parse(readFileSync(CONTRACT_URL, 'utf8')) as IdentityContract;
  return contract;
}

/** Why a call or an answer departs from identity's contract. */
export type IdentityContractViolationReason = 'undeclared operation' | 'invalid request' | 'invalid request body' | 'invalid response';

/** A request people sent, or an answer the double built from seeded data, that identity's contract does not declare. */
export class IdentityContractViolation extends Error {
  override readonly name: string = 'IdentityContractViolation';

  constructor(
    readonly method: string,
    readonly path: string,
    readonly reason: IdentityContractViolationReason,
    readonly errors?: readonly ContractViolation[],
  ) {
    super([`identity contract violation (${reason}): ${method} ${path}`, ...(errors ?? []).map((e) => `${e.instancePath} ${e.message}`)].join('\n'));
  }
}

/** The fault and hold points: each roster step, the operation-state read, CSRF consume, and `read` for every other identity call. */
export type IdentityStep = 'prepare' | 'commit' | 'abort' | 'finish' | 'revert' | 'status' | 'read' | 'csrf';

/** `error` answers the legacy 503; `unreachable` rejects untouched; `lost-reply` applies the call, then rejects. */
export type FaultKind = 'error' | 'unreachable' | 'lost-reply';

/** A recorded operation's state; `unknown` is only ever an answer for an operation identity never prepared. */
export type DoubleOperationState = Exclude<AccountOperationState, 'unknown'>;

/** One roster account operation as identity records it. */
export interface DoubleOperation {
  readonly operationId: string;
  readonly userId: string;
  readonly kind: 'create' | 'update';
  readonly state: DoubleOperationState;
  /** The prepare body as people sent it. */
  readonly request: AccountPrepareRequest;
  /** The account a commit stores; for a create, the reserved `pending` account that no read lists before the commit. */
  readonly pending: AccountView;
  /** The memberships a commit stores; null leaves them as stored. */
  readonly pendingGroupIds: readonly string[] | null;
  /** Account and memberships at prepare; null for a create. */
  readonly before: { readonly account: AccountView; readonly groupIds: readonly string[] } | null;
  /** Decimal xid of the commit. */
  readonly xid?: string;
  /** The commit body, when people sent one. */
  readonly commitRequest?: AccountCommitRequest;
  /** Every state the operation took, in order. */
  readonly history: readonly DoubleOperationState[];
}

/** A group row in the contract's `SiteGroup` casing, with the optional `GroupListItem` columns `listGroups` adds. */
export interface DoubleGroup {
  UserID: string;
  GroupName: string | null;
  SiteID: string;
  isPublic: 0 | 1;
  Perm: number | null;
  Email?: string | null;
  LastLogin?: string | null;
  LastUpdate?: string | null;
  LastUpdateBy?: string | null;
  LastUpdateByID?: string | null;
}

/** `session.mura` in the contract's `SessionUser` casing. */
export interface DoubleSessionUser {
  isLoggedIn: boolean;
  userID: string;
  fname?: string;
  lname?: string;
  [field: string]: unknown;
}

/** An identity session `getCurrentSession` answers when the request's verified user token carries its id as `sid`. */
export interface DoubleSession {
  sessionId: string;
  user: DoubleSessionUser;
  /** Login-time roles; the token's roles when absent. */
  roles?: string[];
  /** The token's epoch when absent. */
  epoch?: number;
  blockLoginUntil?: string | null;
}

/** One identity request as people sent it, with the contract template it resolved to and the answer it received. */
export interface RecordedIdentityRequest {
  readonly method: ServiceRequest['method'];
  readonly path: string;
  readonly query: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  /** Lower-cased headers, `authorization` carrying the forwarded user token as the service client sends it. */
  readonly headers: Readonly<Record<string, string>>;
  /** The forwarded user token; null when none was sent. */
  readonly userToken: string | null;
  /** The contract's `paths` key; undefined for an undeclared operation. */
  template?: string;
  /** The contract's `operationId`; undefined for an undeclared operation. */
  operationId?: string;
  /** The answer delivered; undefined while pending or when the call was refused. */
  response?: ServiceResponse;
}

/** One CSRF consume people asked for and identity's verdict. */
export interface RecordedCsrfConsume {
  readonly request: CsrfConsumeRequest;
  readonly valid: boolean;
}

/** CSRF consume controls: every context valid and every token single-use by default. */
export interface CsrfControls {
  /** Validates only the listed contexts from now on, adding to earlier ones. */
  accept(...contexts: string[]): void;
  /** Makes every consume invalid. */
  rejectAll(): void;
  /** Every consume in order with its verdict. */
  consumed(): readonly RecordedCsrfConsume[];
  /** Back to the default mode, forgetting consumed tokens. */
  reset(): void;
}

/** A call held at a step until released. */
export interface IdentityHold {
  /** Resolves once the next call at the step has been recorded and validated. */
  readonly reached: Promise<void>;
  release(): void;
}

/** Options of {@link createIdentityDouble}. */
export interface IdentityDoubleOptions {
  /** First commit xid; 1000 by default. */
  xidStart?: bigint | number;
  /** Accounts present from the start and again after `clear()`. */
  accounts?: readonly AccountView[];
  /** Stamps `PasswordCreated` when a commit writes a credential; the system clock by default. */
  clock?: Clock;
  /** Longest a call waits while an open operation holds a user it reads or prepares, before the legacy 503; identity's 10 s by default. */
  closedWaitMs?: number;
}

/** The identity stand-in people's suites use instead of a running identity service. */
export interface IdentityDouble {
  /** Answers `service: 'identity'` calls, any other callee being an `UnknownServiceError`; identity's token and role checks are not modelled. */
  readonly client: ServiceClient;
  /** People's identity client over {@link IdentityDouble.client}. */
  readonly identityClient: IdentityClient;
  /** Every identity request people sent, answered or refused, in order. */
  readonly requests: readonly RecordedIdentityRequest[];
  /** Recorded operations keyed by operation id upper-cased without trailing spaces. */
  readonly operations: ReadonlyMap<string, DoubleOperation>;
  /** Active accounts keyed by user id upper-cased without trailing spaces. */
  readonly accounts: ReadonlyMap<string, AccountView>;
  /** Stored membership group ids keyed by user id upper-cased without trailing spaces. */
  readonly memberships: ReadonlyMap<string, readonly string[]>;
  readonly csrf: CsrfControls;
  /** Routes the app's identity calls to the double and every other callee to the client it replaces. */
  install(app: FastifyInstance): void;
  seedAccounts(...accounts: AccountView[]): void;
  seedGroups(...groups: DoubleGroup[]): void;
  /** Replaces the user's stored memberships. */
  seedMemberships(userId: string, groupIds: readonly string[]): void;
  seedSessions(...sessions: DoubleSession[]): void;
  /** The sites `listCurrentSessionSites` answers. */
  seedSessionSites(sites: readonly SessionSite[]): void;
  /** The `blockedUntil` `loadLoginBlock` answers for the user; null clears it. */
  setLoginBlock(userId: string, blockedUntil: string | null): void;
  /** Validation errors prepare answers for the user, unchanged; undefined clears them. */
  setPrepareErrors(userId: string, errors: LegacyErrors | undefined): void;
  /** The `kind` fault for the next `times` calls at `step` (1 by default; `Infinity` allowed). */
  failAt(step: IdentityStep, kind: FaultKind, options?: { times?: number }): void;
  /** Holds the next call at `step` once recorded and validated, until released. */
  holdAt(step: IdentityStep): IdentityHold;
  /** While on, every call is recorded and validated, then rejected with ServiceUnavailableError. */
  setUnreachable(on: boolean): void;
  /** Drops pending faults and releases every hold. */
  clearFaults(): void;
  /** Whether a prepared or committed operation keeps the user closed. */
  isUserClosed(userId: string): boolean;
  operation(operationId: string): DoubleOperation | undefined;
  account(userId: string): AccountView | undefined;
  /** Back to the state as created: seeded data, operations, requests, faults, CSRF mode and the xid counter. */
  clear(): void;
}

interface MutableOperation {
  operationId: string;
  userId: string;
  kind: 'create' | 'update';
  state: DoubleOperationState;
  request: AccountPrepareRequest;
  pending: AccountView;
  pendingGroupIds: string[] | null;
  before: { account: AccountView; groupIds: string[] } | null;
  /** Memberships at prepare, which a revert restores; a create's are normally none. */
  priorGroupIds: string[];
  /** Whether the commit writes a credential and so stamps `PasswordCreated`. */
  writesCredential: boolean;
  xid?: string;
  commitRequest?: AccountCommitRequest;
  history: DoubleOperationState[];
}

/** One answer before the double checks it against the contract. */
interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A dispatched call: its path parameters, first query values and body. */
interface Call {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
  /** The bound the service client puts on the call. */
  readonly timeoutMs: number;
}

type Handler = (call: Call) => Answer | Promise<Answer>;

interface StepSpec {
  from: DoubleOperationState;
  to: DoubleOperationState;
  /** States in which the step has already taken effect. */
  done: readonly DoubleOperationState[];
}

const COMMIT: StepSpec = { from: 'prepared', to: 'committed', done: ['committed', 'finished'] };
const ABORT: StepSpec = { from: 'prepared', to: 'aborted', done: ['aborted'] };
const FINISH: StepSpec = { from: 'committed', to: 'finished', done: ['finished'] };
const REVERT: StepSpec = { from: 'committed', to: 'reverted', done: ['reverted'] };

const OPEN_STATES: ReadonlySet<DoubleOperationState> = new Set<DoubleOperationState>(['prepared', 'committed']);
const ROLLED_BACK_STATES: ReadonlySet<DoubleOperationState> = new Set<DoubleOperationState>(['aborted', 'reverted']);

/** Contract operation ids with their own fault and hold step; every other identity operation is a `read`. */
const STEP_OF_OPERATION: Readonly<Record<string, IdentityStep>> = Object.freeze({
  prepareAccountOperation: 'prepare',
  commitAccountOperation: 'commit',
  abortAccountOperation: 'abort',
  finishAccountOperation: 'finish',
  revertAccountOperation: 'revert',
  getAccountOperation: 'status',
  consumeCsrfToken: 'csrf',
});

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
/** Identity's user-closed wait (`USER_CLOSED_WAIT_MS`). */
const USER_CLOSED_WAIT_MS = 10_000;
const DEFAULT_XID_START = 1000n;
/** Default and largest `limit` of `listGroups`. */
const GROUP_PAGE_LIMIT = 1000;
const CFML_FALSE: ReadonlySet<string> = new Set(['0', 'false', 'no']);

/** A char(35) id as identity compares it: case-insensitive, trailing spaces ignored. */
function charKey(id: string): string {
  return id.replace(/ +$/, '').toUpperCase();
}

function sameUser(operation: MutableOperation, userId: string): boolean {
  return charKey(operation.userId) === charKey(userId);
}

/** A Date as the contract's `LocalTimestamp`, in the legacy server's zone, as identity formats it. */
function localTimestamp(value: Date): string {
  return cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss.lll').replace(' ', 'T');
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Answer {
  return { status, body, headers };
}

/** A legacy-compat response as the service client decodes it: lower-cased headers, parsed JSON body. */
function legacyAnswer(response: SerializedLegacyResponse): Answer {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value;
  return { status: response.status, headers, body: decodeServiceBody(Buffer.from(response.body, 'utf8'), headers['content-type'], IDENTITY_SERVICE) };
}

const unavailable = (): Answer => legacyAnswer(apiUnavailableResponse());
const notFound = (): Answer => legacyAnswer(legacyErrorResponse('invalidMethodCall', { mura404: true }));
const badRequest = (): Answer => legacyAnswer(legacyErrorResponse('badRequest'));
const forbidden = (): Answer => ({ ...legacyAnswer(legacyErrorResponse('authorization')), status: 403 });

const USERS_MODULE = moduleRole('00000000000000000000000000000000008');
const SITE_MANAGER_MODULE = moduleRole('00000000000000000000000000000000000');

/** Identity's cUsers gate of the forwarded user token: S2, a site admin, or the Users and Site Manager grants together. */
function cusersCaller(): boolean {
  const roles = currentRequestContext()?.user?.roles ?? [];
  return roles.includes(Roles.s2) || roles.includes(Roles.siteAdmin) || (roles.includes(USERS_MODULE) && roles.includes(SITE_MANAGER_MODULE));
}

/** The ServiceUnavailableError the service client raises for a refused, reset or timed-out call. */
function refused(code: 'ECONNREFUSED' | 'ECONNRESET' | 'ETIMEDOUT'): ServiceUnavailableError {
  return new ServiceUnavailableError(IDENTITY_SERVICE, Object.assign(new Error(`${code} (identity double)`), { code }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Path parameters of `path` under the contract `template`, URI-decoded. */
function pathParams(template: string, path: string): Record<string, string> {
  const names: string[] = [];
  const source = template
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const name = /^\{([^}]+)\}$/.exec(part)?.[1];
      if (name === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(name);
      return '([^/]+)';
    })
    .join('');
  const match = new RegExp(`^${source}$`).exec(path.replace(/\?.*$/s, '')) ?? [];
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]));
}

/** The first value of each query parameter. */
function firstValues(query: ServiceRequest['query']): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(query ?? {})) values[name] = Array.isArray(value) ? value[0] : value;
  return values;
}

/** The body the service client sends and the content type it sets for it. */
function wireBody(req: ServiceRequest): { body: unknown; contentType: string | undefined } {
  if (req.json !== undefined) return { body: req.json, contentType: 'application/json' };
  if (req.form !== undefined) return { body: req.form, contentType: 'application/x-www-form-urlencoded' };
  const declared = Object.entries(req.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  return { body: req.body, contentType: declared };
}

/** Lower-cased request headers with `authorization` set from the forwarded user token, as the service client sends them. */
function wireHeaders(req: ServiceRequest, userToken: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) headers[name.toLowerCase()] = value;
  if (typeof userToken === 'string') headers.authorization = `Bearer ${userToken}`;
  else if (userToken === null) delete headers.authorization;
  return headers;
}

/** Runs a platform contract assertion, raising its findings as an IdentityContractViolation. */
function asViolation<T>(method: string, path: string, reason: (errors: readonly ContractViolation[]) => IdentityContractViolationReason, check: () => T): T {
  try {
    return check();
  } catch (err) {
    if (err instanceof ContractAssertionError) throw new IdentityContractViolation(method, path, reason(err.errors), err.errors);
    throw err;
  }
}

/** `invalid request body` when every finding is in the body, else `invalid request`. */
function requestReason(errors: readonly ContractViolation[]): IdentityContractViolationReason {
  return errors.length > 0 && errors.every((error) => error.instancePath.startsWith('body')) ? 'invalid request body' : 'invalid request';
}

/** An account view in the contract's `AccountRecord` casing. */
function accountRecord(view: AccountView): Record<string, unknown> {
  return {
    UserID: view.userId,
    SiteID: view.siteId,
    UserName: view.username,
    Type: view.type,
    Admin: view.admin,
    S2: view.s2,
    Perm: view.perm,
    InActive: view.inactive,
    isPublic: view.isPublic,
    remoteID: view.remoteId,
    PasswordCreated: view.passwordCreated,
    LastLogin: view.lastLogin,
    tablist: view.tablist,
  };
}

/** An account view as identity's before-image columns. */
function beforeColumns(view: AccountView): Record<string, unknown> {
  return {
    userid: view.userId,
    username: view.username,
    type: view.type,
    admin: view.admin,
    s2: view.s2,
    perm: view.perm,
    inactive: view.inactive,
    ispublic: view.isPublic,
    siteid: view.siteId,
    remoteid: view.remoteId,
    tablist: view.tablist,
    passwordcreated: view.passwordCreated,
    lastlogin: view.lastLogin,
  };
}

/** The double's user pools: an account belongs to the public pool when its `isPublic` is 1, else to the private pool. */
function inPool(view: AccountView, publicPool: boolean): boolean {
  return (view.isPublic === 1) === publicPool;
}

/** Whether `where` admits the account, a NULL column matching no given value. */
function admitted(view: AccountView, where: AccountWhere | undefined, groupIdsOf: (userId: string) => readonly string[]): boolean {
  if (where === undefined) return true;
  const equal = (value: number | null, expected: number | undefined): boolean => expected === undefined || (value !== null && value === expected);
  return (
    equal(view.isPublic, where.isPublic) &&
    equal(view.s2, where.s2) &&
    equal(view.inactive, where.inActive) &&
    (where.excludeS2Users !== true || (view.s2 !== null && view.s2 !== 1)) &&
    (where.siteIds === undefined || where.siteIds.some((siteId) => charKey(siteId) === charKey(view.siteId))) &&
    (where.unassigned !== true || groupIdsOf(view.userId).length === 0)
  );
}

/** `value COLLATE "C" ILIKE pattern ESCAPE ''`: `%` any run, `_` one character, only ASCII letters folding case. */
function ilikeC(pattern: string): (value: string) => boolean {
  const lower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const source = [...lower(pattern)]
    .map((char) => (char === '%' ? '[\\s\\S]*' : char === '_' ? '[\\s\\S]' : char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')))
    .join('');
  const regex = new RegExp(`^${source}$`, 'u');
  return (value) => regex.test(lower(value));
}

/** `readMembershipIDs`' `order by tusers.groupname`: NULL names first, then names ignoring case, ties by id. */
function byGroupName(a: DoubleGroup, b: DoubleGroup): number {
  const left = a.GroupName?.toLowerCase() ?? null;
  const right = b.GroupName?.toLowerCase() ?? null;
  if (left !== right) return left === null ? -1 : right === null ? 1 : left < right ? -1 : 1;
  return charKey(a.UserID) < charKey(b.UserID) ? -1 : charKey(a.UserID) > charKey(b.UserID) ? 1 : 0;
}

/** Legacy's group order: `Perm` descending with NULLs last, then group name with NULLs first, ignoring case. */
function byPermThenName(a: DoubleGroup, b: DoubleGroup): number {
  if (a.Perm !== b.Perm) return a.Perm === null ? 1 : b.Perm === null ? -1 : b.Perm - a.Perm;
  if (a.GroupName === null || b.GroupName === null) return a.GroupName === b.GroupName ? 0 : a.GroupName === null ? -1 : 1;
  return a.GroupName.toLowerCase().localeCompare(b.GroupName.toLowerCase());
}

const REGISTRY = registryPayloads();

/** The pool site of `siteId`'s public or private user pool in the fixture registry; an unregistered site pools to itself. */
function userPoolSite(siteId: string, isPublic: 0 | 1): string {
  const entry = REGISTRY.find((candidate) => charKey(candidate.siteId) === charKey(siteId));
  const pool = isPublic === 1 ? entry?.publicUserPoolId : entry?.privateUserPoolId;
  return pool === null || pool === undefined || pool === '' ? siteId : pool;
}

/** CFML boolean of a query flag as identity reads `ispublic`: a non-boolean value reads as 1. */
function poolFlag(value: string | undefined): 0 | 1 {
  return value !== undefined && CFML_FALSE.has(value.trim().toLowerCase()) ? 0 : 1;
}

/** The anonymous session struct identity answers without a user token. */
function anonymousSession(): Record<string, unknown> {
  return { sessionId: null, epoch: null, user: { isLoggedIn: false, userID: '' }, roles: [], mfaPending: false, blockLoginUntil: null };
}

/** Creates an identity double; nothing is shared between doubles. */
export function createIdentityDouble(options: IdentityDoubleOptions = {}): IdentityDouble {
  const clock = options.clock ?? systemClock;
  const closedWaitMs = options.closedWaitMs ?? USER_CLOSED_WAIT_MS;
  const xidStart = BigInt(options.xidStart ?? DEFAULT_XID_START);

  const accounts = new Map<string, AccountView>();
  const groups = new Map<string, DoubleGroup>();
  const memberships = new Map<string, string[]>();
  const operations = new Map<string, MutableOperation>();
  const prepareErrors = new Map<string, LegacyErrors>();
  const sessions = new Map<string, DoubleSession>();
  const adminStates = new Map<string, AdminSessionState>();
  const loginBlocks = new Map<string, string>();
  let sessionSites: SessionSite[] = [];
  const requests: RecordedIdentityRequest[] = [];
  const faults: Array<{ step: IdentityStep; kind: FaultKind; remaining: number }> = [];
  const holds: Array<{ step: IdentityStep; reached: () => void; gate: Promise<void>; release: () => void }> = [];
  /** Releases of holds a call is waiting on. */
  const heldReleases = new Set<() => void>();
  /** Re-checks of calls waiting for a closed user to open. */
  const openWaiters = new Set<() => void>();
  let unreachable = false;
  let nextXid = xidStart;
  let csrfMode: 'all' | 'allow' | 'reject' = 'all';
  const csrfContexts = new Set<string>();
  const csrfUsed = new Set<string>();
  const csrfLog: RecordedCsrfConsume[] = [];

  function seedAccounts(...views: AccountView[]): void {
    for (const view of views) accounts.set(charKey(view.userId), { ...view });
  }

  const groupIdsOf = (userId: string): readonly string[] => memberships.get(charKey(userId)) ?? [];

  /** The active Type=2 account of `userId`; groups and `pending` reservations are never listed. */
  function listedAccount(userId: string): AccountView | undefined {
    const view = accounts.get(charKey(userId));
    return view?.type === 2 ? view : undefined;
  }

  /** Every seeded active account: account reads do not resolve the token site's user pools. */
  function listedAccounts(): AccountView[] {
    return [...accounts.values()].filter((view) => view.type === 2);
  }

  /** Whether an open operation other than `self` (an operation key) holds the user `userKey`. */
  function holdsUser(userKey: string, self?: string): boolean {
    for (const [key, operation] of operations) {
      if (key !== self && OPEN_STATES.has(operation.state) && charKey(operation.userId) === userKey) return true;
    }
    return false;
  }

  function isUserClosed(userId: string): boolean {
    return holdsUser(charKey(userId));
  }

  function notifyOpened(): void {
    for (const check of [...openWaiters]) check();
  }

  /** Waits while an open operation other than `self` holds any of `userIds`; false once identity's wait ends, a timeout once the client's does. */
  async function awaitOpen(userIds: readonly string[], call: Call, self?: string): Promise<boolean> {
    const keys = [...new Set(userIds.map(charKey))];
    const closed = (): boolean => keys.some((key) => holdsUser(key, self));
    if (!closed()) return true;
    const waitMs = Math.min(closedWaitMs, call.timeoutMs);
    const opened =
      waitMs > 0 &&
      (await new Promise<boolean>((resolve) => {
        const settle = (value: boolean): void => {
          clearTimeout(timer);
          openWaiters.delete(check);
          resolve(value);
        };
        const check = (): void => {
          if (!closed()) settle(true);
        };
        const timer = setTimeout(() => settle(false), waitMs);
        openWaiters.add(check);
      }));
    if (opened) return true;
    if (call.timeoutMs < closedWaitMs) throw refused('ETIMEDOUT');
    return false;
  }

  function advance(operation: MutableOperation, state: DoubleOperationState): void {
    operation.state = state;
    operation.history.push(state);
    if (!OPEN_STATES.has(state)) notifyOpened();
  }

  function viewOf(operation: MutableOperation): AccountOperation {
    const { before } = operation;
    return {
      operationId: operation.operationId,
      userId: operation.userId,
      kind: operation.kind,
      state: operation.state,
      before: before === null ? null : { account: beforeColumns(before.account), groupIds: [...before.groupIds] },
    };
  }

  /** How a step meets the operation of the path: refused with the view to answer, already done, or to perform. */
  function judge(params: Call['params'], spec: StepSpec): { verdict: 'conflict'; view: AccountOperation } | { verdict: 'done' | 'proceed'; operation: MutableOperation } {
    const userId = params.userId ?? '';
    const operationId = params.operationId ?? '';
    const operation = operations.get(charKey(operationId));
    if (operation === undefined) return { verdict: 'conflict', view: { operationId, userId, state: 'unknown' } };
    if (!sameUser(operation, userId) || (!spec.done.includes(operation.state) && operation.state !== spec.from)) {
      return { verdict: 'conflict', view: viewOf(operation) };
    }
    return { verdict: spec.done.includes(operation.state) ? 'done' : 'proceed', operation };
  }

  /** abort, finish or revert: the stepped state, 409 with the operation when its state refuses the step. */
  function stepAnswer(params: Call['params'], spec: StepSpec, effect: (operation: MutableOperation) => void): Answer {
    const judged = judge(params, spec);
    if (judged.verdict === 'conflict') return json(judged.view, 409);
    const { operation } = judged;
    if (judged.verdict === 'proceed') {
      effect(operation);
      advance(operation, spec.to);
    }
    return json({ operationId: operation.operationId, userId: operation.userId, state: spec.to });
  }

  /** A repeated prepare: the recorded operation, or 409 when it belongs to another user or was rolled back. */
  function preparedAgain(operation: MutableOperation, userId: string): Answer {
    return json(viewOf(operation), sameUser(operation, userId) && !ROLLED_BACK_STATES.has(operation.state) ? 200 : 409);
  }

  /** Memberships after the change: a create's groups; an update's unless `updateGroups` is false, replacing only `originID`'s groups when given. */
  function membershipsAfter(userId: string, change: AccountPrepareRequest): string[] | null {
    if (change.kind === 'update' && change.updateGroups === false) return null;
    const origin = change.kind === 'update' ? (change.originID ?? '') : '';
    const kept =
      origin === ''
        ? []
        : groupIdsOf(userId).filter((groupId) => {
            const group = groups.get(charKey(groupId));
            return group === undefined || charKey(group.SiteID) !== charKey(origin);
          });
    const stored = new Map<string, string>();
    for (const groupId of [...kept, ...change.groupIds]) {
      if (!stored.has(charKey(groupId))) stored.set(charKey(groupId), groupId);
    }
    return [...stored.values()];
  }

  /** The account a commit stores, after identity's save rules: trimmed values, S2 users private, an update's `Perm` and `Admin` as stored. */
  function pendingAccount(userId: string, change: AccountPrepareRequest, stored: AccountView | undefined): AccountView {
    const { account } = change;
    const s2 = account.S2 ?? 0;
    const poolIsPublic = change.switchToPublic === true ? 1 : change.switchToPrivate === true ? 0 : account.isPublic;
    const tablist = account.tablist === undefined ? (stored?.tablist ?? null) : account.tablist === null ? null : javaTrim(account.tablist) || null;
    return {
      userId: stored?.userId ?? userId,
      siteId: change.siteId,
      username: javaTrim(account.UserName),
      s2,
      isPublic: s2 !== 0 ? 0 : poolIsPublic,
      inactive: account.InActive,
      type: 2,
      perm: stored === undefined ? account.Perm : stored.perm,
      admin: stored?.admin ?? null,
      remoteId: javaTrim(account.remoteID),
      lastLogin: stored?.lastLogin ?? null,
      passwordCreated: stored?.passwordCreated ?? null,
      tablist,
    };
  }

  /** Applies the prepared change and returns the commit's xid. */
  function applyCommit(operation: MutableOperation, request: AccountCommitRequest | undefined): string {
    const xid = nextXid.toString();
    nextXid += 1n;
    operation.xid = xid;
    if (request !== undefined) operation.commitRequest = request;
    const key = charKey(operation.userId);
    const passwordCreated = operation.writesCredential ? localTimestamp(clock.now()) : operation.pending.passwordCreated;
    accounts.set(key, { ...operation.pending, passwordCreated });
    if (operation.pendingGroupIds !== null) memberships.set(key, [...operation.pendingGroupIds]);
    advance(operation, 'committed');
    return xid;
  }

  /** Restores the account and, when the commit wrote them, the memberships recorded at prepare. */
  function applyRevert(operation: MutableOperation): void {
    const key = charKey(operation.userId);
    if (operation.before === null) accounts.delete(key);
    else accounts.set(key, { ...operation.before.account });
    if (operation.pendingGroupIds === null) return;
    if (operation.priorGroupIds.length === 0) memberships.delete(key);
    else memberships.set(key, [...operation.priorGroupIds]);
  }

  /** The site's groups of the public (1) or private (0) user pool, legacy-ordered; every site's without a site. */
  function siteGroups(siteId: string | undefined, isPublic: 0 | 1): DoubleGroup[] {
    const site = siteId ?? currentRequestContext()?.site;
    const pool = site === undefined ? undefined : charKey(userPoolSite(site, isPublic));
    return [...groups.values()].filter((group) => group.isPublic === isPublic && (pool === undefined || charKey(group.SiteID) === pool)).sort(byPermThenName);
  }

  /** Members of the group; null when it has none. */
  function memberCount(groupId: string): number | null {
    const key = charKey(groupId);
    const count = [...memberships.values()].filter((groupIds) => groupIds.some((id) => charKey(id) === key)).length;
    return count === 0 ? null : count;
  }

  /** The current session: the seeded one of the verified token's `sid`, else the token's logged-in claims, else anonymous. */
  function currentSession(): Record<string, unknown> {
    const claims = currentRequestContext()?.user;
    if (claims === undefined) return anonymousSession();
    const seeded = sessions.get(claims.sid);
    if (seeded === undefined) {
      const user: DoubleSessionUser = { isLoggedIn: true, userID: claims.sub, siteID: claims.site };
      return { sessionId: claims.sid, epoch: claims.epoch, user, roles: [...claims.roles], mfaPending: false, blockLoginUntil: null };
    }
    return {
      sessionId: seeded.sessionId,
      epoch: seeded.epoch ?? claims.epoch,
      user: { ...seeded.user },
      roles: [...(seeded.roles ?? claims.roles)],
      mfaPending: false,
      blockLoginUntil: seeded.blockLoginUntil ?? null,
    };
  }

  /** Admin session-scope values are kept per verified token `sid`. */
  const adminStateKey = (): string => currentRequestContext()?.user?.sid ?? '';

  async function lookupAccounts(call: Call): Promise<Answer> {
    const { userIds, where } = call.body as { userIds: string[]; where?: AccountWhere };
    if (!(await awaitOpen(userIds, call))) return unavailable();
    const items = userIds.flatMap((userId) => {
      const view = listedAccount(userId);
      return view !== undefined && admitted(view, where, groupIdsOf) ? [accountRecord(view)] : [];
    });
    return json({ items });
  }

  /** One handler per contract operation people calls, keyed by its `operationId`. */
  const handlers: Readonly<Record<string, Handler>> = {
    async prepareAccountOperation(call) {
      const userId = call.params.userId ?? '';
      const operationId = call.params.operationId ?? '';
      const key = charKey(operationId);
      const change = call.body as AccountPrepareRequest;
      const recorded = operations.get(key);
      if (recorded !== undefined) return preparedAgain(recorded, userId);
      if (!(await awaitOpen([userId], call, key))) return unavailable();
      // A concurrent prepare of the same operation may have recorded it during the wait.
      const raced = operations.get(key);
      if (raced !== undefined) return preparedAgain(raced, userId);
      const errors = prepareErrors.get(charKey(userId));
      if (errors !== undefined) return json(errors, 400);
      const stored = listedAccount(userId);
      if ((change.kind === 'update') !== (stored !== undefined)) return badRequest();
      const priorGroupIds = [...groupIdsOf(userId)];
      const operation: MutableOperation = {
        operationId,
        userId,
        kind: change.kind,
        state: 'prepared',
        request: change,
        pending: pendingAccount(userId, change, stored),
        pendingGroupIds: membershipsAfter(userId, change),
        before: stored === undefined ? null : { account: { ...stored }, groupIds: priorGroupIds },
        priorGroupIds,
        writesCredential: change.kind === 'create' || javaTrim(change.account.Password ?? '') !== '',
        history: ['prepared'],
      };
      operations.set(key, operation);
      return json(viewOf(operation));
    },

    commitAccountOperation(call) {
      const judged = judge(call.params, COMMIT);
      if (judged.verdict === 'conflict') return json(judged.view, 409);
      const { operation } = judged;
      // A committed or finished operation always holds its commit xid.
      const xid = judged.verdict === 'proceed' ? applyCommit(operation, call.body as AccountCommitRequest | undefined) : (operation.xid as string);
      const result = { operationId: operation.operationId, userId: operation.userId, state: 'committed', writePosition: xid };
      return json(result, 200, { [WRITE_POSITION_HEADER_LC]: formatWritePosition({ [IDENTITY_SERVICE]: xid }) });
    },

    abortAccountOperation: (call) => stepAnswer(call.params, ABORT, () => undefined),

    finishAccountOperation: (call) => stepAnswer(call.params, FINISH, () => undefined),

    revertAccountOperation: (call) => stepAnswer(call.params, REVERT, applyRevert),

    getAccountOperation(call) {
      const userId = call.params.userId ?? '';
      const operationId = call.params.operationId ?? '';
      const operation = operations.get(charKey(operationId));
      // The contract declares no not-found answer: an operation identity never recorded, or another user's, reads as `unknown`.
      return json(operation !== undefined && sameUser(operation, userId) ? viewOf(operation) : { operationId, userId, state: 'unknown' });
    },

    async getAccount(call) {
      const userId = call.params.userId ?? '';
      if (!(await awaitOpen([userId], call))) return unavailable();
      const view = listedAccount(userId);
      return view === undefined ? notFound() : json(accountRecord(view));
    },

    lookupAccounts,

    lookupAccountsAllSites: lookupAccounts,

    async countAccounts(call) {
      const request = call.body as AccountCountRequest;
      const inScope = (): AccountView[] =>
        listedAccounts().filter((view) => (request.scope !== 'pool' || inPool(view, request.publicPool === true)) && admitted(view, request.where, groupIdsOf));
      if (!(await awaitOpen(inScope().map((view) => view.userId), call))) return unavailable();
      return json({ count: inScope().length });
    },

    async lookupUsernameCandidates(call) {
      const request = call.body as UsernameCandidateRequest;
      const like = ilikeC(request.pattern);
      const matched = (): Array<{ userId: string; username: string }> =>
        listedAccounts()
          .filter((view) => inPool(view, request.publicPool) && admitted(view, request.where, groupIdsOf))
          .flatMap(({ userId, username }) => (username !== null && like(username) ? [{ userId, username }] : []))
          .sort((a, b) => (charKey(a.userId) < charKey(b.userId) ? -1 : charKey(a.userId) > charKey(b.userId) ? 1 : 0));
      if (!(await awaitOpen(matched().map(({ userId }) => userId), call))) return unavailable();
      const found = matched();
      return json({ items: found.slice(0, request.limit), complete: found.length <= request.limit });
    },

    async lookupMemberships(call) {
      const { userIds } = call.body as { userIds: string[] };
      if (!(await awaitOpen(userIds, call))) return unavailable();
      return json({ items: userIds.map((userId) => ({ userId, groupIds: [...groupIdsOf(userId)] })) });
    },

    // `readMembershipIDs` inner-joins the groups: a held id naming no seeded group is left out.
    async getAccountMemberships(call) {
      const userId = call.params.userId ?? '';
      if (!(await awaitOpen([userId], call))) return unavailable();
      const held = groupIdsOf(userId).flatMap((groupId) => {
        const group = groups.get(charKey(groupId));
        return group === undefined ? [] : [group];
      });
      return json({ groupIds: held.sort(byGroupName).map((group) => group.UserID) });
    },

    async listUserMemberships(call) {
      if (!cusersCaller()) return forbidden();
      const userId = call.params.userId ?? '';
      if (!(await awaitOpen([userId], call))) return unavailable();
      const summary = ({ UserID, GroupName }: DoubleGroup): Record<string, unknown> => ({ UserID, GroupName });
      return json({
        privateGroups: siteGroups(call.query.siteid, 0).map(summary),
        publicGroups: siteGroups(call.query.siteid, 1).map(summary),
        groupIds: [...groupIdsOf(userId)],
      });
    },

    listSiteGroups(call) {
      const items = siteGroups(call.query.siteid, call.query.ispublic === '1' ? 1 : 0).map(({ UserID, GroupName, SiteID, isPublic, Perm }) => ({
        UserID,
        GroupName,
        SiteID,
        isPublic,
        Perm,
      }));
      return json({ items });
    },

    listGroups(call) {
      const listed = siteGroups(call.query.siteid, poolFlag(call.query.ispublic));
      const offset = Number(call.query.offset ?? '0');
      const page = listed.slice(offset, offset + Number(call.query.limit ?? String(GROUP_PAGE_LIMIT)));
      const items = page.map((group) => ({
        UserID: group.UserID,
        Email: group.Email ?? null,
        GroupName: group.GroupName,
        Type: 1,
        LastLogin: group.LastLogin ?? null,
        LastUpdate: group.LastUpdate ?? null,
        LastUpdateBy: group.LastUpdateBy ?? null,
        LastUpdateByID: group.LastUpdateByID ?? null,
        Counter: memberCount(group.UserID),
        Perm: group.Perm,
        isPublic: group.isPublic,
      }));
      const next = offset + page.length;
      return json({ items, total: listed.length, nextOffset: next < listed.length ? next : null });
    },

    getCurrentSession: () => json(currentSession()),

    getAdminSessionState: () => json(adminStates.get(adminStateKey()) ?? {}),

    saveAdminSessionState(call) {
      const key = adminStateKey();
      const merged: AdminSessionState = { ...(adminStates.get(key) ?? {}), ...(call.body as AdminSessionState) };
      adminStates.set(key, merged);
      return json(merged);
    },

    listCurrentSessionSites: () => json({ sites: sessionSites.map((site) => ({ ...site })) }),

    async loadLoginBlock(call) {
      const userId = call.params.userId ?? '';
      if (!(await awaitOpen([userId], call))) return unavailable();
      if (listedAccount(userId) === undefined) return notFound();
      const key = charKey(userId);
      if ((call.body as { removeBlock: boolean }).removeBlock) loginBlocks.delete(key);
      return json({ blockedUntil: loginBlocks.get(key) ?? null });
    },

    consumeCsrfToken(call) {
      const request = call.body as CsrfConsumeRequest;
      const claim = JSON.stringify([request.sessionId, request.token]);
      const admitted = csrfMode === 'all' || (csrfMode === 'allow' && csrfContexts.has(request.context));
      const valid = admitted && !csrfUsed.has(claim);
      if (valid) csrfUsed.add(claim);
      csrfLog.push({ request: { ...request }, valid });
      const verdict: CsrfConsumeResponse = { valid };
      return json(verdict);
    },
  };

  /** Holds the call while a hold waits at `step`, until it is released. */
  async function holdFor(step: IdentityStep): Promise<void> {
    const index = holds.findIndex((candidate) => candidate.step === step);
    const hold = holds[index];
    if (hold === undefined) return;
    holds.splice(index, 1);
    heldReleases.add(hold.release);
    hold.reached();
    await hold.gate;
    heldReleases.delete(hold.release);
  }

  function takeFault(step: IdentityStep): FaultKind | undefined {
    const fault = faults.find((candidate) => candidate.step === step && candidate.remaining > 0);
    if (fault === undefined) return undefined;
    fault.remaining -= 1;
    return fault.kind;
  }

  /** The answer as the service client returns it, once identity's contract declares it for the request. */
  function delivered(req: ServiceRequest, answer: Answer): ServiceResponse {
    const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE, ...answer.headers };
    const response = { method: req.method, path: req.path, status: answer.status, contentType: headers['content-type'], body: answer.body };
    asViolation(req.method, req.path, () => 'invalid response', () => assertResponseMatchesOpenApi(identityContract(), response));
    return { status: answer.status, headers, body: structuredClone(answer.body) };
  }

  async function request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (req.service !== IDENTITY_SERVICE) throw new UnknownServiceError(req.service);
    const userToken = req.userToken === undefined ? currentRequestContext()?.userToken : req.userToken;
    const { body, contentType } = wireBody(req);
    const headers = wireHeaders(req, userToken);
    const record: RecordedIdentityRequest = { method: req.method, path: req.path, query: { ...req.query }, body, headers, userToken: userToken ?? null };
    // Recorded before any fault, so a suite sees every call people attempted, refused ones included.
    requests.push(record);

    const doc = identityContract();
    const { template, operation } = asViolation(req.method, req.path, () => 'undeclared operation', () => findOperation(doc, req.method, req.path));
    record.template = template;
    record.operationId = operation.operationId;
    // The platform's request assertion checks path, query and body together, so a drifted id or query parameter fails like a drifted body.
    const query = Object.fromEntries(Object.entries(req.query ?? {}).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
    asViolation(req.method, req.path, requestReason, () => assertRequestMatchesOpenApi(doc, { method: req.method, path: req.path, query, headers, contentType, body }));
    const operationId = operation.operationId ?? '';
    const handler = handlers[operationId];
    if (handler === undefined) throw new Error(`The identity double does not serve ${req.method} ${template} (${operationId})`);

    const step = STEP_OF_OPERATION[operationId] ?? 'read';
    await holdFor(step);
    if (unreachable) throw refused('ECONNREFUSED');
    const fault = takeFault(step);
    if (fault === 'unreachable') throw refused('ECONNREFUSED');
    const call: Call = { params: pathParams(template, req.path), query: firstValues(req.query), body, timeoutMs: req.timeoutMs ?? SERVICE_CALL_TIMEOUT_MS };
    const response = delivered(req, fault === 'error' ? unavailable() : await handler(call));
    if (fault === 'lost-reply') throw refused('ECONNRESET');
    record.response = response;
    return response as ServiceResponse<T>;
  }

  const client: ServiceClient = { request, close: () => Promise.resolve() };

  const csrf: CsrfControls = {
    accept(...contexts) {
      csrfMode = 'allow';
      for (const context of contexts) csrfContexts.add(context);
    },
    rejectAll() {
      csrfMode = 'reject';
    },
    consumed: () => [...csrfLog],
    reset() {
      csrfMode = 'all';
      csrfContexts.clear();
      csrfUsed.clear();
      csrfLog.length = 0;
    },
  };

  function clearFaults(): void {
    faults.length = 0;
    for (const hold of holds.splice(0)) hold.release();
    for (const release of [...heldReleases]) release();
  }

  function clear(): void {
    for (const store of [accounts, groups, memberships, operations, prepareErrors, sessions, adminStates, loginBlocks]) store.clear();
    sessionSites = [];
    requests.length = 0;
    clearFaults();
    unreachable = false;
    nextXid = xidStart;
    csrf.reset();
    seedAccounts(...(options.accounts ?? []));
    // Calls waiting on a cleared operation see their users open.
    notifyOpened();
  }

  seedAccounts(...(options.accounts ?? []));

  return {
    client,
    identityClient: createIdentityClient(client),
    requests,
    operations,
    accounts,
    memberships,
    csrf,
    install(app) {
      // The runtime is frozen, so the client it holds is patched in place. Other callees (people also calls strategies-content) keep
      // the replaced client, which still raises UnknownServiceError for a callee without a configured URL.
      const target = app.opt2.client;
      const prior: ServiceClient = { request: target.request.bind(target), close: target.close.bind(target) };
      Object.assign(target, {
        request: <T>(req: ServiceRequest): Promise<ServiceResponse<T>> => (req.service === IDENTITY_SERVICE ? request<T>(req) : prior.request<T>(req)),
        close: async (): Promise<void> => {
          await client.close();
          await prior.close();
        },
      });
    },
    seedAccounts,
    seedGroups(...seeded) {
      for (const group of seeded) groups.set(charKey(group.UserID), { ...group });
    },
    seedMemberships(userId, groupIds) {
      memberships.set(charKey(userId), [...groupIds]);
    },
    seedSessions(...seeded) {
      for (const session of seeded) sessions.set(session.sessionId, { ...session, user: { ...session.user } });
    },
    seedSessionSites(sites) {
      sessionSites = sites.map((site) => ({ ...site }));
    },
    setLoginBlock(userId, blockedUntil) {
      if (blockedUntil === null) loginBlocks.delete(charKey(userId));
      else loginBlocks.set(charKey(userId), blockedUntil);
    },
    setPrepareErrors(userId, errors) {
      if (errors === undefined) prepareErrors.delete(charKey(userId));
      else prepareErrors.set(charKey(userId), { ...errors });
    },
    failAt(step, kind, { times = 1 } = {}) {
      faults.push({ step, kind, remaining: times });
    },
    holdAt(step) {
      const reached = deferred();
      const gate = deferred();
      holds.push({ step, reached: reached.resolve, gate: gate.promise, release: gate.resolve });
      return { reached: reached.promise, release: gate.resolve };
    },
    setUnreachable(on) {
      unreachable = on;
    },
    clearFaults,
    isUserClosed,
    operation: (operationId) => operations.get(charKey(operationId)),
    account: (userId) => accounts.get(charKey(userId)),
    clear,
  };
}
