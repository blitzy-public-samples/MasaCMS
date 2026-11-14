// Roster write protocol under process loss: people or identity killed at each step boundary of a cusers.update save.
import { randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { adminUnavailableResponse } from '@opt2/platform/legacy-compat';
import {
  MAX_CHANGES_LIMIT,
  MIGRATION_PATH_PREFIX,
  type ChangesResponse,
  type OperationStatus,
  type PositionResponse,
} from '@opt2/platform/migration-kit';
import { TENANT_A } from '@opt2/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FAULT_ENV, FAULT_PREFIX, ROSTER_STEPS, type RosterStep } from '../../../services/people/src/domain/faults.js';
import { pollUntil, readOwnerExport, unitFor } from '../../src/events/seams.js';
import { fetchFormTokens, type FormTokens } from '../../src/golden/session.js';
import { HttpRequestError, createHttpSession, type HttpResult, type HttpSession } from '../../src/lib/http.js';
import { createReadOnlyMssql, type ReadOnlyMssql } from '../../src/lib/mssql.js';
import { credentialsFor, gatewaySession, loginAdmin } from '../helpers/admin-login.js';
import { resetMailpit } from '../helpers/mailpit.js';
import {
  killService,
  migrationInvoker,
  migrationUrl,
  operatorInvoker,
  readStack,
  requireTableVersion,
  restartService,
  serviceUrl,
  startService,
  waitHealthy,
  withRestoredServices,
  type ServiceName,
} from '../helpers/stack.js';

/** Age past which the people outbox sweep resolves an open operation (services/people/src/domain/roster-recovery.ts). */
const RECOVERY_THRESHOLD_MS = 30_000;
/** People's in-request budget from the durable intent on (services/people/src/domain/roster-protocol.ts). */
const REQUEST_BUDGET_MS = 10_000;
/** Interval of the self-rescheduling `people-outbox-sweep` task that runs recovery. */
const SWEEP_INTERVAL_MS = 60_000;
const RECOVERY_WAIT_MS = RECOVERY_THRESHOLD_MS + SWEEP_INTERVAL_MS + 30_000;
// People's budget can outlast the gateway's 10 s forward timeout, so a killed identity stays down until it is spent.
const IDENTITY_DOWN_MS = REQUEST_BUDGET_MS + 5_000;
const WITHHELD_HOLD_MS = 15_000;
/** Deadline of one proxied identity exchange, well past people's request budget. */
const EXCHANGE_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 300_000;
const READER_INTERVAL_MS = 250;
const READER_TIMEOUT_MS = 15_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const MIGRATION_CALL_TIMEOUT_MS = 30_000;
const RECOVERY_POLL_MS = 2_000;
const LEGACY_POLL = { timeoutMs: 30_000, intervalMs: 1_000 } as const;
const FIRE_WAIT_MS = 30_000;
/** How long the migration service's `projector-hold` fault holds a roster operation's joint batch transaction open. */
const PROJECTOR_HOLD_MS = 5_000;
const HOLD_POLL_MS = 100;
/** Bound on the two holds of a 'new' case once recovery has closed the operation on both sides. */
const HOLD_WAIT_MS = LEGACY_POLL.timeoutMs + 2 * PROJECTOR_HOLD_MS;

const SITE = TENANT_A.siteId;
const PARTICIPANTS = ['people', 'identity'] as const satisfies readonly ServiceName[];
const SITE_ADMIN_REF = `\${user:${SITE}:site-admin}`;
const S2_REF = '${secret:admin}';
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
const LEGACY_USER_SQL = 'SELECT Fname, Lname, Email, UserName, InActive, Type, SiteID FROM tusers WHERE UserID = @userId';
// NOLOCK sees an open transaction's uncommitted image. READPAST counts the row only while no writer holds it locked; it
// reads the clustered key, which every write of the row locks, since a narrower index may carry UserID unlocked.
const HELD_USER_SQL =
  'SELECT h.Fname, h.Lname, h.Email, h.UserName, h.InActive, h.Type, h.SiteID, ' +
  '(SELECT COUNT(*) FROM tusers WITH (READPAST, INDEX(PK_tusers)) WHERE UserID = @userId) AS visible ' +
  'FROM (SELECT 1 AS probe) AS p LEFT JOIN tusers AS h WITH (NOLOCK) ON h.UserID = @userId';
const CHECKPOINT_SQL =
  'SELECT owner, CONVERT(varchar(20), cursor_xid) AS cursor_xid, CONVERT(varchar(20), cursor_seq) AS cursor_seq, batch_id ' +
  'FROM opt2_sync.projector_checkpoint WHERE tenant_id = @tenantId AND owner IN (@people, @identity)';
const PROJECTOR_HOLD_PATH = '/internal/v1/faults/projector-hold';
const ACCOUNT_STEP_PATH = /^\/internal\/v1\/accounts\/([^/]+)\/operations\/([^/]+?):(prepare|commit|abort|finish|revert)$/;

type Participant = (typeof PARTICIPANTS)[number];
type CaseKind = 'create' | 'edit';
type FinalState = 'old' | 'new';
type ExpectedResponse = '503' | 'success-or-503';
type IdentityFault = 'before-prepare' | 'after-prepare-withheld' | 'after-commit-lost' | 'before-finish';
type AccountStep = 'prepare' | 'commit' | 'finish';
/** What one read of the user showed. */
type Observed = 'old' | 'new' | 'absent' | 'wait' | 'mixed';

/** Expected outcome of one case and the `resolveOperation` row that recovery takes. */
interface Expectation {
  kind: CaseKind;
  response: ExpectedResponse;
  final: FinalState;
  recovery: string;
}

/** One fault case: the participant killed and where. */
type RosterCase = Expectation &
  ({ killed: 'people'; step: RosterStep; slug: string } | { killed: 'identity'; fault: IdentityFault; slug: string });

const PEOPLE_CASES: Record<RosterStep, Expectation> = {
  'after-start': { kind: 'create', response: '503', final: 'old', recovery: ':abort with nothing prepared, rolled-back' },
  'after-prepare': { kind: 'edit', response: '503', final: 'old', recovery: ':abort prepared' },
  'after-people-commit': { kind: 'edit', response: '503', final: 'old', recovery: 'restore before-image, :abort' },
  // Old, not rolled forward: resolveOperation rolls forward only from `done` or an identity `finished`, so a
  // committed identity under a `people-committed` operation is reverted, which keeps a 503 a total rejection.
  'after-identity-commit': {
    kind: 'create',
    response: '503',
    final: 'old',
    recovery: 'identity committed but people not done: :revert and restore before-image',
  },
  'after-done': { kind: 'edit', response: '503', final: 'new', recovery: 'repeat lost :finish' },
};

const IDENTITY_FAULTS: readonly IdentityFault[] = ['before-prepare', 'after-prepare-withheld', 'after-commit-lost', 'before-finish'];

const IDENTITY_CASES: Record<IdentityFault, Expectation> = {
  'before-prepare': { kind: 'create', response: '503', final: 'old', recovery: ':abort' },
  'after-prepare-withheld': { kind: 'edit', response: '503', final: 'old', recovery: 'restore before-image, :abort' },
  'after-commit-lost': {
    kind: 'edit',
    response: '503',
    final: 'old',
    recovery: 'identity unreachable within the 10 s budget, :revert both sides',
  },
  'before-finish': { kind: 'create', response: 'success-or-503', final: 'new', recovery: 'repeat lost :finish' },
};

/** The account step whose request triggers each identity fault. */
const FAULT_TRIGGER: Record<IdentityFault, AccountStep> = {
  'before-prepare': 'prepare',
  'after-prepare-withheld': 'prepare',
  'after-commit-lost': 'commit',
  'before-finish': 'finish',
};

const CASES: readonly RosterCase[] = [
  ...ROSTER_STEPS.map((step): RosterCase => ({ killed: 'people', step, slug: `p-${step.replace(/^after-/, '')}`, ...PEOPLE_CASES[step] })),
  ...IDENTITY_FAULTS.map((fault): RosterCase => ({ killed: 'identity', fault, slug: `i-${fault}`, ...IDENTITY_CASES[fault] })),
];

/** One version of the user as the form posts it. */
interface Version {
  fname: string;
  lname: string;
  email: string;
  username: string;
  inactive: number;
}

/** The values a case starts from (`null` for a create) and posts. */
interface CaseValues {
  old: Version | null;
  new: Version;
}

type PersonPart = Record<'fname' | 'lname' | 'email', string>;
type AccountPart = Record<'username' | 'inactive', string>;

/** The person and account columns one read saw; `null` where that participant's columns are missing. */
interface Observation {
  person: PersonPart | null;
  account: AccountPart | null;
}

/** One classified read of the concurrent reader. */
interface ReaderRecord {
  path: 'json-api' | 'legacy-sql';
  at: string;
  observed: Observed;
  detail: string;
}

/** The posting form of the user editor. */
interface UserForm {
  userId: string;
  tokens: FormTokens;
}

/** An identity fault the proxy carried out. */
interface FiredFault {
  mode: IdentityFault;
  operationId: string;
}

/** The proxy's armed fault, the case signal scoping it and the settlers of its `arm` promise. */
interface ArmedFault {
  mode: IdentityFault;
  userId: string;
  signal: AbortSignal;
  resolve(f: FiredFault): void;
  reject(e: Error): void;
}

/** Forwarding proxy in front of identity with one armed, one-shot fault. */
interface IdentityProxy {
  readonly url: string;
  /** Arms `mode` for `userId`; `signal` disarms it, or ends its exchange and downstream hold once fired. */
  arm(mode: IdentityFault, userId: string, signal: AbortSignal): Promise<FiredFault>;
  disarm(): void;
  /** Stops listening and ends every exchange in flight. */
  close(): Promise<void>;
}

/** A changelog position `(xid, seq)`. */
type Position = readonly [xid: bigint, seq: bigint];

/** Parameters of the migration service's `projector-hold` fault. */
interface ProjectorHold {
  point: 'first-change' | 'between-participants';
  holdMs: number;
  fail: boolean;
}

/** What the two holds of a 'new' case's joint batch showed in legacy. */
interface HoldEvidence {
  /** The user's row as the failing hold's open transaction had it. */
  failingHeld: Observed;
  /** Whether the commit re-arm landed while the failing hold still ran. */
  rearmedDuringHold: boolean;
  /** A committed read issued during the failing hold, returned once it rolled back. */
  afterRollback: Observed;
  checkpointsAfterRollback: Record<Participant, Position>;
  /** A committed read issued during the committing hold, returned once it committed. */
  afterCommit: Observed;
}

/** Operation statuses of one participant and the target state of the user, as one recovery poll read them. */
interface RecoveryState {
  people: Map<string, OperationStatus>;
  identity: Map<string, OperationStatus>;
  target: Observed | 'unread';
  error?: string;
}

const ABSENT: Observation = Object.freeze({ person: null, account: null });

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Field `name` of `record`, matched ignoring case as SQL Server and CFML match names. */
function field(record: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(record, name)) return record[name];
  const lower = name.toLowerCase();
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : record[key];
}

/** Text form of a column or JSON value; null for SQL NULL or a missing field. */
function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/** Comparison form of a CF UUID: `char(35)` padding dropped and case folded. */
function idKey(id: string): string {
  return id.trimEnd().toUpperCase();
}

/** People's person columns of `record`; null when it carries none of them. */
function personOf(record: Record<string, unknown>): PersonPart | null {
  const [fname, lname, email] = ['fname', 'lname', 'email'].map((name) => textOf(field(record, name)));
  if (fname === null && lname === null && email === null) return null;
  return { fname: fname ?? '', lname: lname ?? '', email: email ?? '' };
}

/** Identity's account columns of `record`; null unless it carries a username, InActive and Type 2. */
function accountOf(record: Record<string, unknown>): AccountPart | null {
  const username = textOf(field(record, 'username'));
  const inactive = textOf(field(record, 'inactive'));
  if (username === null || username === '' || inactive === null || textOf(field(record, 'type')) !== '2') return null;
  return { username, inactive };
}

function observationOf(record: Record<string, unknown>): Observation {
  return { person: personOf(record), account: accountOf(record) };
}

function matches<K extends keyof Version>(part: Record<K, string>, version: Version, keys: readonly K[]): boolean {
  return keys.every((key) => part[key] === String(version[key]));
}

/** The version whose `keys` columns `part` holds, if any. */
function versionOf<K extends keyof Version>(part: Record<K, string>, keys: readonly K[], values: CaseValues): FinalState | undefined {
  if (matches(part, values.new, keys)) return 'new';
  return values.old !== null && matches(part, values.old, keys) ? 'old' : undefined;
}

/** `old` or `new` when both participants' columns show that version, `absent` when neither has the user, else `mixed`. */
function classify(observation: Observation, values: CaseValues): Observed {
  const { person, account } = observation;
  if (person === null && account === null) return 'absent';
  if (person === null || account === null) return 'mixed';
  const personVersion = versionOf(person, ['fname', 'lname', 'email'], values);
  const accountVersion = versionOf(account, ['username', 'inactive'], values);
  return personVersion !== undefined && personVersion === accountVersion ? personVersion : 'mixed';
}

/** The class of a case's user before its save: its old values, which a create does not have. */
function beforeClass(c: RosterCase): Observed {
  return c.kind === 'create' ? 'absent' : 'old';
}

/** The class a case's user ends in: its new values, or its old ones. */
function expectedClass(c: RosterCase): Observed {
  return c.final === 'new' ? 'new' : beforeClass(c);
}

function headerText(result: HttpResult, name: string): string {
  const value = result.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** Value of query parameter `name`, matched ignoring case as FW/1 reads the URL scope. */
function queryParam(url: URL, name: string): string | undefined {
  const lower = name.toLowerCase();
  return [...url.searchParams].find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** Legacy's success answer of a roster save: `route()`'s 302 to the users list its `returnurl` names. */
function isLegacySuccess(result: HttpResult): boolean {
  const location = headerText(result, 'location');
  if (result.status !== 302 || location === '' || !URL.canParse(location, result.url)) return false;
  return queryParam(new URL(location, result.url), 'muraAction')?.toLowerCase() === 'cusers.listusers';
}

/** The legacy admin 503: the error page the gateway and web render when an owner is unavailable. */
function isLegacy503(result: HttpResult): boolean {
  const page = adminUnavailableResponse();
  return result.status === 503 && result.text === page.body && headerText(result, 'content-type').toLowerCase().startsWith('text/html');
}

function describeResponse(result: HttpResult): string {
  const location = headerText(result, 'location');
  return `HTTP ${result.status}${location === '' ? '' : ` to ${location}`}`;
}

/** Fresh old and new values of one case; an edit changes person and account columns at once. */
function caseValues(c: RosterCase): CaseValues {
  const tag = `${c.slug}-${randomBytes(3).toString('hex')}`;
  const version = (suffix: string, inactive: number): Version => {
    const username = `e2e-roster-${tag}${suffix}`;
    return { fname: `Fn-${tag}${suffix}`, lname: `Ln-${tag}${suffix}`, email: `${username}@e2e.opt2.test`, username, inactive };
  };
  return c.kind === 'create' ? { old: null, new: version('', 0) } : { old: version('', 0), new: version('-ed', 1) };
}

function randomPassword(): string {
  return `Rp1!${randomBytes(12).toString('base64url')}`;
}

function titleOf(c: RosterCase): string {
  const point = c.killed === 'people' ? `people killed ${c.step}` : `identity killed ${c.fault}`;
  const answer = c.response === '503' ? 'answers 503' : 'answers success or 503';
  const outcome =
    c.final === 'new'
      ? 'both sides hold the new values'
      : c.kind === 'create'
        ? 'neither side holds the user'
        : 'both sides keep the old values';
  return `${point}: ${c.kind} ${answer} and ${outcome} (recovery: ${c.recovery})`;
}

/** Fresh gateway session logged in through the admin login form as `ref`. */
async function adminSession(ref: string): Promise<HttpSession> {
  const session = gatewaySession();
  await loginAdmin(session, credentialsFor(ref));
  return session;
}

/** The user editor's `form1` for `userId`, or for a new user; its action URL carries the id the save uses. */
async function openUserForm(writer: HttpSession, userId?: string): Promise<UserForm> {
  const query = new URLSearchParams({ muraAction: 'cUsers.edituser', siteid: SITE, type: '2', userid: userId ?? '' });
  const tokens = await fetchFormTokens(writer, `/admin/?${query.toString()}`, 'form[name=form1]');
  const formUserId = queryParam(new URL(tokens.action, writer.baseUrl), 'userid');
  if (formUserId === undefined || formUserId === '') {
    throw new Error(`the user editor form posts to ${tokens.action} without a userid`);
  }
  if (userId !== undefined && idKey(formUserId) !== idKey(userId)) {
    throw new Error(`the user editor form for ${userId} posts for user ${formUserId}`);
  }
  return { userId: formUserId, tokens };
}

/** The browser's multipart `cUsers.update` post of `version`, without a photo, redirects left unfollowed. */
function submitUser(writer: HttpSession, form: UserForm, version: Version, kind: CaseKind): Promise<HttpResult> {
  const password = randomPassword();
  const fields: Record<string, string> = {
    siteid: SITE,
    type: '2',
    action: kind === 'create' ? 'Add' : 'Update',
    fname: version.fname,
    lname: version.lname,
    email: version.email,
    usernameNoCache: version.username,
    ...(kind === 'create' ? { passwordNoCache: password, password2: password } : {}),
    isPublic: '0',
    InActive: String(version.inactive),
    subtype: 'Default',
    contact: '0',
    ContactForm: '',
    returnurl: form.tokens.fields.returnurl ?? '',
    csrf_token: form.tokens.token,
    csrf_token_expires: form.tokens.expires,
  };
  return writer.post(form.tokens.action, { multipart: { fields }, followRedirects: false, timeoutMs: SUBMIT_TIMEOUT_MS });
}

/** The `tusers` row of `userId`, person and account columns read in one statement. */
async function legacyObservation(sql: ReadOnlyMssql, userId: string): Promise<Observation> {
  const rows = await sql.readOnlyQuery<Record<string, unknown>>(LEGACY_USER_SQL, { userId });
  if (rows.length > 1) throw new Error(`tusers holds ${rows.length} rows for UserID ${userId}`);
  const [row] = rows;
  return row === undefined ? ABSENT : observationOf(row);
}

/** Polls legacy until the user's row classifies as `expected`; returns the last class read. */
async function awaitLegacy(sql: ReadOnlyMssql, userId: string, values: CaseValues, expected: Observed): Promise<Observed> {
  const outcome = await pollUntil(
    async () => classify(await legacyObservation(sql, userId), values),
    (observed) => observed === expected,
    { poll: LEGACY_POLL },
  );
  return outcome.value;
}

/** The user's `tusers` row as an open writer has it, and how many rows of the user no writer holds locked. */
async function heldObservation(sql: ReadOnlyMssql, userId: string): Promise<{ observation: Observation; visible: number }> {
  const [row] = await sql.readOnlyQuery<Record<string, unknown>>(HELD_USER_SQL, { userId });
  if (row === undefined) throw new Error(`the held-image read of UserID ${userId} returned no row`);
  return { observation: observationOf(row), visible: Number(field(row, 'visible')) };
}

/** Polls until an open transaction holds the user's row locked with an image other than `before`; returns its class. */
async function awaitHeldRow(sql: ReadOnlyMssql, userId: string, values: CaseValues, before: Observed, signal: AbortSignal): Promise<Observed> {
  for (;;) {
    signal.throwIfAborted();
    const { observation, visible } = await heldObservation(sql, userId);
    const observed = classify(observation, values);
    if (observed !== before && visible === 0) return observed;
    await delay(HOLD_POLL_MS, undefined, { signal });
  }
}

function comparePositions(a: Position, b: Position): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

function formatPosition([xid, seq]: Position): string {
  return `${xid}:${seq}`;
}

function describePositions(positions: Record<Participant, Position>): string {
  return PARTICIPANTS.map((p) => `${p}=${formatPosition(positions[p])}`).join(', ');
}

function describeRows(rows: Record<Participant, readonly Position[]>): string {
  return PARTICIPANTS.map((p) => `${p}: ${rows[p].map(formatPosition).join(' ') || 'none'}`).join('; ');
}

/** Both participants' committed tenant-a projector checkpoints in legacy; `0:0` for one never written. */
async function legacyCheckpoints(sql: ReadOnlyMssql): Promise<Record<Participant, Position>> {
  const rows = await sql.readOnlyQuery<{ owner: string; cursor_xid: string; cursor_seq: string }>(CHECKPOINT_SQL, {
    tenantId: TENANT_A.tenantId,
    people: 'people',
    identity: 'identity',
  });
  const of = (owner: Participant): Position => {
    const row = rows.find((candidate) => candidate.owner === owner);
    return row === undefined ? [0n, 0n] : [BigInt(row.cursor_xid), BigInt(row.cursor_seq)];
  };
  return { people: of('people'), identity: of('identity') };
}

/** Whether every participant's checkpoint is at or after its last row in `rows`; one without rows needs none. */
function checkpointsPass(checkpoints: Record<Participant, Position>, rows: Record<Participant, readonly Position[]>): boolean {
  return PARTICIPANTS.every((p) => {
    const last = rows[p].at(-1);
    return last === undefined || comparePositions(checkpoints[p], last) >= 0;
  });
}

/** The JSON API `user` entity of `userId` read in the S2 session; 'wait' for an unavailable owner or a timeout. */
async function entityObservation(reader: HttpSession, userId: string): Promise<Observation | 'wait'> {
  let result: HttpResult;
  try {
    result = await reader.get(`/_api/json/v1/${SITE}/user/${encodeURIComponent(userId)}`, { timeoutMs: READER_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof HttpRequestError) return 'wait';
    throw err;
  }
  if (UNAVAILABLE_STATUSES.has(result.status)) return 'wait';
  if (result.status === 404) return ABSENT;
  const data = result.status === 200 ? asRecord(asRecord(result.json())?.data) : undefined;
  if (data === undefined) throw new Error(`the JSON API user read answered HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  return textOf(field(data, 'isnew')) === '1' ? ABSENT : observationOf(data);
}

/** Starts the JSON API and legacy SQL readers of `userId`; `stop` ends both and returns every classified read. */
function startReader(reader: HttpSession, sql: ReadOnlyMssql, userId: string, values: CaseValues): { stop(): Promise<ReaderRecord[]> } {
  const records: ReaderRecord[] = [];
  let running = true;
  const loop = async (path: ReaderRecord['path'], read: () => Promise<Observation | 'wait'>): Promise<void> => {
    try {
      while (running) {
        const observation = await read();
        const observed = observation === 'wait' ? 'wait' : classify(observation, values);
        records.push({ path, at: new Date().toISOString(), observed, detail: JSON.stringify(observation) });
        await delay(READER_INTERVAL_MS);
      }
    } catch (err) {
      // A failed path stops the other one too; its error surfaces at stop().
      running = false;
      throw err;
    }
  };
  const loops = Promise.allSettled([
    loop('json-api', () => entityObservation(reader, userId)),
    loop('legacy-sql', () => legacyObservation(sql, userId)),
  ]);
  return {
    async stop(): Promise<ReaderRecord[]> {
      running = false;
      const failures = (await loops).flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []));
      if (failures.length > 0) throw new AggregateError(failures, 'the concurrent reader failed');
      return records;
    },
  };
}

/** Reads that break all-old-or-all-new: a mix, an edited user gone, or a version the case does not end in seen or left. */
function readerViolations(records: readonly ReaderRecord[], c: RosterCase): ReaderRecord[] {
  const final = expectedClass(c);
  const violations: ReaderRecord[] = [];
  for (const path of ['json-api', 'legacy-sql'] as const) {
    let sawNew = false;
    for (const record of records.filter((r) => r.path === path && r.observed !== 'wait')) {
      const regressed = sawNew && record.observed !== 'new';
      const unfinished = record.observed === 'new' && final !== 'new';
      if (record.observed === 'mixed' || (c.kind === 'edit' && record.observed === 'absent') || regressed || unfinished) {
        violations.push(record);
      }
      sawNew ||= record.observed === 'new';
    }
  }
  return violations;
}

/** GET of the owner's `/internal/v1/migration/<path>` as `platform.migration`; throws on any answer but 200. */
async function migrationGet<T>(service: Participant, path: string, query: Record<string, string> = {}): Promise<T> {
  const base = serviceUrl(service);
  const url = new URL(`${MIGRATION_PATH_PREFIX}/${path}`, base);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers = await (await migrationInvoker()).headersFor({ callee: service, url: url.href });
  const result = await createHttpSession({ baseUrl: base }).get(url.href, { headers, timeoutMs: MIGRATION_CALL_TIMEOUT_MS });
  if (result.status !== 200) throw new Error(`${service} migration ${path} answered HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  return result.json<T>();
}

/** Changelog cursor just past every transaction `service` had assigned an id to when this was called. */
async function cursorAfterNow(service: Participant): Promise<string> {
  const { position } = await migrationGet<PositionResponse>(service, 'position');
  return `${BigInt(position) + 1n}:0`;
}

/**
 * Status of every operation whose tenant-a changelog rows after `after` touch `userId` (every operation when omitted),
 * as the owner's migration changes feed reports it.
 */
async function operationsOf(service: Participant, after: string, userId?: string): Promise<Map<string, OperationStatus>> {
  const needle = userId === undefined ? undefined : idKey(userId);
  const statuses = new Map<string, OperationStatus>();
  for await (const page of changePages(service, after)) {
    for (const row of page.rows) {
      const { operationId } = row;
      if (operationId === null) continue;
      const touches = needle === undefined || [row.key, row.before, row.after].some((text) => text?.toUpperCase().includes(needle));
      const status = page.operations[operationId];
      if (touches && status !== undefined) statuses.set(idKey(operationId), status);
    }
  }
  return statuses;
}

/** The owner's tenant-a migration changes feed after `after`, page by page. */
async function* changePages(service: Participant, after: string): AsyncGenerator<ChangesResponse> {
  for (let cursor = after; ; ) {
    const page = await migrationGet<ChangesResponse>(service, 'changes', {
      tenantId: TENANT_A.tenantId,
      after: cursor,
      limit: String(MAX_CHANGES_LIMIT),
    });
    yield page;
    if (page.complete) return;
    cursor = page.cursor;
  }
}

/** Positions of the owner's changelog rows after `after` that belong to operation `operationKey` and project to legacy. */
async function projectableRowsOf(service: Participant, after: string, operationKey: string): Promise<Position[]> {
  const positions: Position[] = [];
  for await (const page of changePages(service, after)) {
    for (const row of page.rows) {
      if (row.operationId === null || idKey(row.operationId) !== operationKey || row.legacy.length === 0) continue;
      positions.push([BigInt(row.xid), BigInt(row.seq)]);
    }
  }
  return positions.sort(comparePositions);
}

/** The user's rows in people's person and identity's user_account exports of tenant-a, as one observation. */
async function targetObservation(userId: string): Promise<Observation> {
  const deps = { invoker: await migrationInvoker() };
  const own = (rows: readonly Record<string, unknown>[]): Record<string, unknown> | undefined =>
    rows.find((row) => idKey(textOf(field(row, 'UserID')) ?? '') === idKey(userId));
  const people = await readOwnerExport({ service: 'people', unit: unitFor('people', 'person'), tenantId: TENANT_A.tenantId }, deps);
  const identity = await readOwnerExport(
    { service: 'identity', unit: unitFor('identity', 'user_account'), tenantId: TENANT_A.tenantId },
    deps,
  );
  const person = own(people.rows);
  const account = own(identity.rows);
  return { person: person === undefined ? null : personOf(person), account: account === undefined ? null : accountOf(account) };
}

function isOpen(statuses: ReadonlyMap<string, OperationStatus>): boolean {
  return [...statuses.values()].includes('open');
}

/** One recovery poll: both participants' operation statuses for the user, then, once all are closed, the target state. */
async function recoveryState(userId: string, since: Record<Participant, string>, values: CaseValues): Promise<RecoveryState> {
  const state: RecoveryState = { people: new Map(), identity: new Map(), target: 'unread' };
  try {
    state.people = await operationsOf('people', since.people, userId);
    state.identity = await operationsOf('identity', since.identity, userId);
    if (state.people.size > 0 && !isOpen(state.people) && !isOpen(state.identity)) {
      state.target = classify(await targetObservation(userId), values);
    }
  } catch (err) {
    // A participant still starting answers nothing; the next poll reads it again.
    state.error = err instanceof Error ? err.message : String(err);
  }
  return state;
}

function isRecovered(state: RecoveryState): boolean {
  return state.error === undefined && state.target !== 'unread' && state.target !== 'mixed';
}

function describeState(state: RecoveryState): string {
  return JSON.stringify({ people: Object.fromEntries(state.people), identity: Object.fromEntries(state.identity), target: state.target, error: state.error });
}

/** Whether `name` answers HTTP on its port at all. */
async function isServing(name: ServiceName): Promise<boolean> {
  try {
    const response = await fetch(`${serviceUrl(name)}/healthz`, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** People's recorded `OPT2_SERVICE_URLS` with identity replaced by `proxyUrl`. */
function serviceUrlsVia(proxyUrl: string): string {
  const recorded = readStack().processes.people?.env?.OPT2_SERVICE_URLS ?? process.env.OPT2_SERVICE_URLS;
  if (recorded === undefined || recorded === '') throw new Error('up.json records no OPT2_SERVICE_URLS for people');
  return JSON.stringify({ ...(JSON.parse(recorded) as Record<string, string>), identity: proxyUrl });
}

/** `scope` with the deadline of one identity exchange added. */
function exchangeSignal(scope: AbortSignal): AbortSignal {
  return AbortSignal.any([scope, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)]);
}

/** The error of an exchange `signal` ended: its deadline passed, or its case or the proxy was cancelled. */
function exchangeAborted(req: IncomingMessage, signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  const what = reason instanceof DOMException && reason.name === 'TimeoutError' ? `passed its ${EXCHANGE_TIMEOUT_MS} ms deadline` : 'was cancelled';
  return new Error(`the identity exchange ${req.method ?? ''} ${req.url ?? ''} ${what}`, { cause: reason });
}

/** The upstream request of `req` to identity, headers and body passed through as received; `signal` destroys it. */
function upstreamRequest(req: IncomingMessage, signal: AbortSignal, onResponse: (upstream: IncomingMessage) => void): ClientRequest {
  const target = new URL(serviceUrl('identity'));
  const out = httpRequest(
    { hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.rawHeaders, agent: false, signal },
    onResponse,
  );
  req.pipe(out);
  return out;
}

/** Streams `req` to identity and its reply back; either side failing or going away, or `scope` aborting, ends both. */
function passThrough(req: IncomingMessage, res: ServerResponse, scope: AbortSignal): void {
  let upstream: IncomingMessage | undefined;
  const out = upstreamRequest(req, exchangeSignal(scope), (reply) => {
    upstream = reply;
    reply.on('error', () => req.socket.destroy());
    res.writeHead(reply.statusCode ?? 502, reply.statusMessage, reply.rawHeaders);
    reply.pipe(res);
  });
  out.on('error', () => req.socket.destroy());
  res.on('close', () => {
    if (res.writableFinished) return;
    out.destroy();
    upstream?.destroy();
  });
}

/**
 * Sends `req` to identity and reads its whole reply, which the client never receives. Rejects, destroying the upstream
 * exchange, once `scope` aborts, the exchange deadline passes or the client goes away first.
 */
function exchangeWithheld(req: IncomingMessage, scope: AbortSignal): Promise<void> {
  const signal = exchangeSignal(scope);
  const { socket } = req;
  return new Promise((resolve, reject) => {
    let settled = false;
    let out: ClientRequest | undefined;
    let upstream: IncomingMessage | undefined;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.off('close', onClientClose);
      if (error === undefined) {
        resolve();
        return;
      }
      out?.destroy();
      upstream?.destroy();
      reject(error);
    };
    const onAbort = (): void => settle(exchangeAborted(req, signal));
    const onClientClose = (): void => settle(new Error(`people closed the identity exchange ${req.method ?? ''} ${req.url ?? ''} before identity answered`));
    if (signal.aborted) {
      onAbort();
      return;
    }
    if (socket.destroyed) {
      onClientClose();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('close', onClientClose);
    out = upstreamRequest(req, signal, (reply) => {
      upstream = reply;
      reply.on('error', (err) => settle(err));
      reply.once('end', () => settle());
      reply.resume();
    });
    out.on('error', (err) => settle(err));
  });
}

/** Keeps people's connection open for `WITHHELD_HOLD_MS`, or until `signal` aborts, then drops it. */
function holdDownstream(req: IncomingMessage, signal: AbortSignal): void {
  const { socket } = req;
  if (socket.destroyed) return;
  if (signal.aborted) {
    socket.destroy();
    return;
  }
  const drop = (): void => {
    socket.destroy();
  };
  const timer = setTimeout(drop, WITHHELD_HOLD_MS);
  signal.addEventListener('abort', drop, { once: true });
  socket.once('close', () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', drop);
  });
}

/**
 * Carries out `mode` on the request that triggered it; identity is dead before the client learns anything. `signal`
 * ends the fault's exchange and downstream hold; a fault fired after it aborted rejects.
 */
async function fireFault(mode: IdentityFault, req: IncomingMessage, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error(`identity fault ${mode} fired after its case was cancelled`, { cause: signal.reason });
  switch (mode) {
    case 'before-prepare':
    case 'before-finish':
      await killService('identity');
      req.socket.destroy();
      return;
    case 'after-prepare-withheld':
      await exchangeWithheld(req, signal);
      await killService('identity');
      holdDownstream(req, signal);
      return;
    case 'after-commit-lost':
      await exchangeWithheld(req, signal);
      await killService('identity');
      req.socket.destroy();
      return;
    default: {
      const unhandled: never = mode;
      throw new Error(`unhandled identity fault ${String(unhandled)}`);
    }
  }
}

/** The user, operation and step of an account-operation request, or undefined for any other request. */
function accountStepOf(req: IncomingMessage): { userId: string; operationId: string; step: string } | undefined {
  if (req.method !== 'POST') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://identity-proxy.invalid').pathname);
  } catch {
    return undefined;
  }
  const match = ACCOUNT_STEP_PATH.exec(path);
  if (match === null) return undefined;
  const [, userId = '', operationId = '', step = ''] = match;
  return { userId, operationId, step };
}

/** Starts the identity proxy on an ephemeral loopback port. */
async function startIdentityProxy(): Promise<IdentityProxy> {
  const lifetime = new AbortController();
  let armed: ArmedFault | undefined;
  const server: Server = createServer((req, res) => {
    const account = accountStepOf(req);
    const fault = armed;
    if (account === undefined || fault === undefined || idKey(account.userId) !== idKey(fault.userId) || account.step !== FAULT_TRIGGER[fault.mode]) {
      passThrough(req, res, lifetime.signal);
      return;
    }
    armed = undefined;
    fireFault(fault.mode, req, fault.signal).then(
      () => fault.resolve({ mode: fault.mode, operationId: account.operationId }),
      (err: unknown) => {
        req.socket.destroy();
        fault.reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    arm(mode, userId, signal) {
      if (armed !== undefined) throw new Error(`identity proxy fault ${armed.mode} is still armed`);
      const scope = AbortSignal.any([signal, lifetime.signal]);
      let entry!: ArmedFault;
      const fired = new Promise<FiredFault>((resolve, reject) => {
        entry = { mode, userId, signal: scope, resolve, reject };
      });
      armed = entry;
      scope.addEventListener(
        'abort',
        () => {
          if (armed !== entry) return;
          armed = undefined;
          entry.reject(new Error(`identity proxy fault ${mode} was cancelled before it fired`, { cause: scope.reason }));
        },
        { once: true },
      );
      // Awaited after the request; a fault that never fires is reported there, not as an unhandled rejection.
      fired.catch(() => undefined);
      return fired;
    },
    disarm() {
      const pending = armed;
      armed = undefined;
      pending?.reject(new Error(`identity proxy fault ${pending.mode} never fired for user ${pending.userId}`));
    },
    close() {
      lifetime.abort(new Error('the identity proxy closed'));
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((err) => (err === undefined ? resolve() : reject(err))));
    },
  };
}

/** `promise`, or a rejection naming `what` once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error(`${what} did not happen within ${ms} ms`)), { once: true })),
  ]);
}

/** Arms (PUT with `params`) or clears (DELETE) the migration service's `projector-hold` fault as `platform.operator`. */
async function projectorHoldCall(method: 'PUT' | 'DELETE', params?: ProjectorHold, signal?: AbortSignal): Promise<void> {
  const base = migrationUrl();
  const headers = await (await operatorInvoker()).headersFor({ callee: 'migration', url: `${base}${PROJECTOR_HOLD_PATH}` });
  const result = await createHttpSession({ baseUrl: base }).request({
    method,
    path: PROJECTOR_HOLD_PATH,
    headers,
    ...(params === undefined ? {} : { json: { params } }),
    followRedirects: false,
    timeoutMs: MIGRATION_CALL_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.status !== 204) {
    throw new Error(`migration ${method === 'PUT' ? 'faultSet' : 'faultClear'} projector-hold answered HTTP ${result.status}: ${result.text.slice(0, 500)}`);
  }
}

/**
 * The projector hold a case runs under. A 'new' case's joint batch fails once between the participants, then commits;
 * an 'old' case refuses every batch that would write any operation change.
 */
function holdFor(c: RosterCase): ProjectorHold {
  return c.final === 'new'
    ? { point: 'between-participants', holdMs: PROJECTOR_HOLD_MS, fail: true }
    : { point: 'first-change', holdMs: 0, fail: true };
}

/**
 * Watches the two holds of a 'new' case's joint batch. A hold keeps one participant's change uncommitted, so a
 * committed read issued during it returns only once the batch rolls back or commits both.
 */
async function watchHolds(sql: ReadOnlyMssql, userId: string, values: CaseValues, before: Observed, signal: AbortSignal): Promise<HoldEvidence> {
  const failingHeld = await awaitHeldRow(sql, userId, values, before, signal);
  let readSettled = false;
  const blockedRead = legacyObservation(sql, userId).finally(() => {
    readSettled = true;
  });
  // Awaited below; this only keeps a rejection during the re-arm from going unhandled.
  blockedRead.catch(() => undefined);
  await projectorHoldCall('PUT', { point: 'between-participants', holdMs: PROJECTOR_HOLD_MS, fail: false }, signal);
  const rearmedDuringHold = !readSettled;
  const afterRollback = classify(await blockedRead, values);
  const checkpointsAfterRollback = await legacyCheckpoints(sql);
  await awaitHeldRow(sql, userId, values, before, signal);
  const afterCommit = classify(await legacyObservation(sql, userId), values);
  return { failingHeld, rearmedDuringHold, afterRollback, checkpointsAfterRollback, afterCommit };
}

/** The case's operation key: the proxied operation, else the one operation people records for the user. */
function caseOperation(state: RecoveryState, userId: string, proxied: string | undefined): string {
  if (proxied !== undefined) return idKey(proxied);
  const keys = [...state.people.keys()];
  expect(keys, `people operations recorded for ${userId}`).toHaveLength(1);
  return keys[0] ?? '';
}

/** Checks legacy's record of the operation: both participants rolled back then committed together ('new'), or none written ('old'). */
async function expectLegacyAtomic(
  c: RosterCase,
  sql: ReadOnlyMssql,
  userId: string,
  operationKey: string,
  since: Record<Participant, string>,
  watch: Promise<HoldEvidence> | undefined,
): Promise<void> {
  const label = `user ${userId}, operation ${operationKey}`;
  const rows: Record<Participant, Position[]> = {
    people: await projectableRowsOf('people', since.people, operationKey),
    identity: await projectableRowsOf('identity', since.identity, operationKey),
  };
  if (watch === undefined) {
    const passed = await pollUntil(() => legacyCheckpoints(sql), (checkpoints) => checkpointsPass(checkpoints, rows), { poll: LEGACY_POLL });
    expect(
      passed.timedOut,
      `${label}: checkpoints ${describePositions(passed.value)} reach the operation's projectable rows (${describeRows(rows)}) with no batch writing them`,
    ).toBe(false);
    return;
  }
  for (const p of PARTICIPANTS) expect(rows[p].length, `${label}: ${p} changelog rows projecting to legacy`).toBeGreaterThan(0);
  const evidence = await within(watch, HOLD_WAIT_MS, `the two projector holds of ${label}`);
  if (c.kind === 'edit') expect(evidence.failingHeld, `${label}: uncommitted tusers row while held between the participants`).toBe('mixed');
  expect(evidence.rearmedDuringHold, `${label}: the commit re-arm landed during the failing hold`).toBe(true);
  expect(evidence.afterRollback, `${label}: committed tusers row read during the failing hold`).toBe(beforeClass(c));
  for (const p of PARTICIPANTS) {
    const checkpoint = evidence.checkpointsAfterRollback[p];
    const [first] = rows[p];
    expect(
      first !== undefined && comparePositions(checkpoint, first) < 0,
      `${label}: ${p} checkpoint ${formatPosition(checkpoint)} after the rollback is before its first projectable row (${describeRows(rows)})`,
    ).toBe(true);
  }
  expect(evidence.afterCommit, `${label}: committed tusers row read during the committing hold`).toBe('new');
  const committed = await legacyCheckpoints(sql);
  expect(
    checkpointsPass(committed, rows),
    `${label}: checkpoints ${describePositions(committed)} after the commit reach the projectable rows (${describeRows(rows)})`,
  ).toBe(true);
}

/** Creates the user an edit case changes, fault-free, and waits until legacy holds it. */
async function createBaseUser(writer: HttpSession, sql: ReadOnlyMssql, base: Version, values: CaseValues): Promise<string> {
  const form = await openUserForm(writer);
  const result = await submitUser(writer, form, base, 'create');
  if (!isLegacySuccess(result)) throw new Error(`the base roster create of ${form.userId} answered ${describeResponse(result)}`);
  const legacy = await awaitLegacy(sql, form.userId, values, 'old');
  if (legacy !== 'old') throw new Error(`legacy shows the base user ${form.userId} as ${legacy}`);
  return form.userId;
}

/** Posts the save while the case's participant dies, then brings it back; returns the answer and the proxied operation. */
async function sendUnderFault(
  c: RosterCase,
  proxy: IdentityProxy,
  writer: HttpSession,
  form: UserForm,
  values: CaseValues,
  signal: AbortSignal,
): Promise<{ response: HttpResult; operationId?: string }> {
  if (c.killed === 'people') {
    const response = await submitUser(writer, form, values.new, c.kind);
    expect(await isServing('people'), `people killed itself at ${c.step}; the save answered ${describeResponse(response)}`).toBe(false);
    await startService('people');
    await waitHealthy('people');
    return { response };
  }
  const fired = proxy.arm(c.fault, form.userId, signal);
  const sentAt = performance.now();
  let response: HttpResult;
  try {
    response = await submitUser(writer, form, values.new, c.kind);
  } finally {
    proxy.disarm();
  }
  const fault = await within(fired, FIRE_WAIT_MS, `identity fault ${c.fault}`);
  await delay(Math.max(0, sentAt + IDENTITY_DOWN_MS - performance.now()));
  await startService('identity');
  await waitHealthy('identity');
  return { response, operationId: fault.operationId };
}

/**
 * One case: fault, response, recovery, both sides' final state, legacy's record of the operation and what the concurrent
 * reader saw meanwhile. `testSignal` aborts on the test's timeout; the case's proxy exchanges and holds end with the case.
 */
async function runCase(c: RosterCase, proxy: IdentityProxy, sql: ReadOnlyMssql, testSignal: AbortSignal): Promise<void> {
  const ended = new AbortController();
  try {
    await runCaseIn(c, proxy, sql, AbortSignal.any([testSignal, ended.signal]));
  } finally {
    ended.abort(new Error(`roster case ${c.slug} ended`));
  }
}

/** {@link runCase} under `signal`, the case's cancellation. */
async function runCaseIn(c: RosterCase, proxy: IdentityProxy, sql: ReadOnlyMssql, signal: AbortSignal): Promise<void> {
  const values = caseValues(c);
  const final = expectedClass(c);
  await withRestoredServices(PARTICIPANTS, async () => {
    if (c.killed === 'identity') await restartService('people', { extraEnv: { OPT2_SERVICE_URLS: serviceUrlsVia(proxy.url) } });
    const writer = await adminSession(SITE_ADMIN_REF);
    const baseUserId = values.old === null ? undefined : await createBaseUser(writer, sql, values.old, values);
    if (c.killed === 'people') await restartService('people', { extraEnv: { [FAULT_ENV]: `${FAULT_PREFIX}${c.step}` } });
    const since: Record<Participant, string> = { people: await cursorAfterNow('people'), identity: await cursorAfterNow('identity') };
    const form = await openUserForm(writer, baseUserId);
    const { userId } = form;
    const reader = startReader(await adminSession(S2_REF), sql, userId, values);
    // Stopped and settled before the fault is cleared, so the watcher cannot re-arm it after the case.
    const watching = new AbortController();
    let watch: Promise<HoldEvidence> | undefined;
    let readerError: unknown;
    let clearError: unknown;
    let records: ReaderRecord[] = [];
    try {
      await projectorHoldCall('PUT', holdFor(c), signal);
      if (final === 'new') {
        watch = watchHolds(sql, userId, values, beforeClass(c), AbortSignal.any([signal, watching.signal]));
        // Awaited in expectLegacyAtomic; this only keeps an early rejection from going unhandled.
        watch.catch(() => undefined);
      }
      const { response, operationId } = await sendUnderFault(c, proxy, writer, form, values, signal);
      const success = isLegacySuccess(response);
      expect.soft(success || isLegacy503(response), `${describeResponse(response)} is legacy's success or its admin 503`).toBe(true);
      if (c.response === '503') expect.soft(isLegacy503(response), `${describeResponse(response)} is the admin 503`).toBe(true);

      const recovery = await pollUntil(() => recoveryState(userId, since, values), isRecovered, {
        poll: { timeoutMs: RECOVERY_WAIT_MS, intervalMs: RECOVERY_POLL_MS },
      });
      const state = recovery.value;
      expect(recovery.timedOut, `recovery of ${userId} within ${RECOVERY_WAIT_MS} ms; last: ${describeState(state)}`).toBe(false);
      if (operationId !== undefined) {
        expect([...state.people.keys()], `people records the proxied operation ${operationId}`).toContain(idKey(operationId));
      }
      expect(state.target, `people and identity exports of ${userId}`).toBe(final);
      if (success) expect(state.target, 'a success answer leaves the new values').toBe('new');
      await expectLegacyAtomic(c, sql, userId, caseOperation(state, userId, operationId), since, watch);
      expect(await awaitLegacy(sql, userId, values, final), `legacy tusers row of ${userId} after reverse projection`).toBe(final);
    } finally {
      watching.abort(new Error(`roster case ${c.slug} ended`));
      await watch?.catch(() => undefined);
      try {
        records = await reader.stop();
      } catch (err) {
        readerError = err;
      }
      try {
        await projectorHoldCall('DELETE');
      } catch (err) {
        clearError = err;
      }
    }
    if (readerError !== undefined) throw readerError;
    if (clearError !== undefined) throw clearError;
    expect(new Set(records.map((record) => record.path)), 'both reader paths observed the user').toEqual(new Set(['json-api', 'legacy-sql']));
    expect(readerViolations(records, c), 'reads that saw neither all-old nor all-new').toEqual([]);
  });
}

describe('roster write protocol under process loss', () => {
  let proxy: IdentityProxy | undefined;
  let sql: ReadOnlyMssql | undefined;
  let suiteSince: Record<Participant, string> | undefined;

  beforeAll(async () => {
    readStack();
    await requireTableVersion('v0002');
    sql = await createReadOnlyMssql();
    proxy = await startIdentityProxy();
    suiteSince = { people: await cursorAfterNow('people'), identity: await cursorAfterNow('identity') };
  });

  afterAll(async () => {
    try {
      if (suiteSince !== undefined) {
        for (const service of PARTICIPANTS) {
          const { outbox } = await migrationGet<PositionResponse>(service, 'position');
          expect(outbox?.held ?? 0, `${service} outbox rows held by an open operation`).toBe(0);
          const open = [...(await operationsOf(service, suiteSince[service])).entries()].filter(([, status]) => status === 'open');
          expect(open, `${service} operations left open or halted`).toEqual([]);
        }
        await resetMailpit();
      }
    } finally {
      await proxy?.close();
      await sql?.close();
    }
  });

  for (const c of CASES) {
    it(titleOf(c), { timeout: CASE_TIMEOUT_MS }, async ({ signal }) => {
      if (proxy === undefined || sql === undefined) throw new Error('the suite set-up did not finish');
      await runCase(c, proxy, sql, signal);
    });
  }
});
