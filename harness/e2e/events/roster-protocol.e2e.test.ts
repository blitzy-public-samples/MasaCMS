// Roster write protocol under process loss: people or identity killed at each step boundary of a cusers.update save.
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
const CASE_TIMEOUT_MS = 300_000;
const READER_INTERVAL_MS = 250;
const READER_TIMEOUT_MS = 15_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const MIGRATION_CALL_TIMEOUT_MS = 30_000;
const RECOVERY_POLL_MS = 2_000;
const LEGACY_POLL = { timeoutMs: 30_000, intervalMs: 1_000 } as const;
const FIRE_WAIT_MS = 30_000;

const SITE = TENANT_A.siteId;
const PARTICIPANTS = ['people', 'identity'] as const satisfies readonly ServiceName[];
const SITE_ADMIN_REF = `\${user:${SITE}:site-admin}`;
const S2_REF = '${secret:admin}';
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
const LEGACY_USER_SQL = 'SELECT Fname, Lname, Email, UserName, InActive, Type, SiteID FROM tusers WHERE UserID = @userId';
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

/** Forwarding proxy in front of identity with one armed, one-shot fault. */
interface IdentityProxy {
  readonly url: string;
  arm(mode: IdentityFault, userId: string): Promise<FiredFault>;
  disarm(): void;
  close(): Promise<void>;
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

/** The class a case's user ends in: its new values, or its old ones, which a create does not have. */
function expectedClass(c: RosterCase): Observed {
  if (c.final === 'new') return 'new';
  return c.kind === 'create' ? 'absent' : 'old';
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
  for (let cursor = after; ; ) {
    const page = await migrationGet<ChangesResponse>(service, 'changes', {
      tenantId: TENANT_A.tenantId,
      after: cursor,
      limit: String(MAX_CHANGES_LIMIT),
    });
    for (const row of page.rows) {
      const { operationId } = row;
      if (operationId === null) continue;
      const touches = needle === undefined || [row.key, row.before, row.after].some((text) => text?.toUpperCase().includes(needle));
      const status = page.operations[operationId];
      if (touches && status !== undefined) statuses.set(idKey(operationId), status);
    }
    if (page.complete) return statuses;
    cursor = page.cursor;
  }
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

/** The upstream request of `req` to identity, headers and body passed through as received. */
function upstreamRequest(req: IncomingMessage, onResponse: (upstream: IncomingMessage) => void): ReturnType<typeof httpRequest> {
  const target = new URL(serviceUrl('identity'));
  const out = httpRequest(
    { hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.rawHeaders, agent: false },
    onResponse,
  );
  req.pipe(out);
  return out;
}

/** Streams `req` to identity and its reply back; an unreachable identity drops the client connection. */
function passThrough(req: IncomingMessage, res: ServerResponse): void {
  const out = upstreamRequest(req, (upstream) => {
    res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.rawHeaders);
    upstream.pipe(res);
  });
  out.on('error', () => req.socket.destroy());
}

/** Sends `req` to identity and reads its whole reply, which the client never receives. */
function exchangeWithheld(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = upstreamRequest(req, (upstream) => {
      upstream.on('error', reject);
      upstream.on('end', () => resolve());
      upstream.resume();
    });
    out.on('error', reject);
  });
}

/** Carries out `mode` on the request that triggered it; identity is dead before the client learns anything. */
async function fireFault(mode: IdentityFault, req: IncomingMessage): Promise<void> {
  switch (mode) {
    case 'before-prepare':
    case 'before-finish':
      await killService('identity');
      req.socket.destroy();
      return;
    case 'after-prepare-withheld': {
      await exchangeWithheld(req);
      await killService('identity');
      const timer = setTimeout(() => req.socket.destroy(), WITHHELD_HOLD_MS);
      req.socket.once('close', () => clearTimeout(timer));
      return;
    }
    case 'after-commit-lost':
      await exchangeWithheld(req);
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
  let armed: { mode: IdentityFault; userId: string; resolve(f: FiredFault): void; reject(e: Error): void } | undefined;
  const server: Server = createServer((req, res) => {
    const account = accountStepOf(req);
    const fault = armed;
    if (account === undefined || fault === undefined || idKey(account.userId) !== idKey(fault.userId) || account.step !== FAULT_TRIGGER[fault.mode]) {
      passThrough(req, res);
      return;
    }
    armed = undefined;
    fireFault(fault.mode, req).then(
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
    arm(mode, userId) {
      if (armed !== undefined) throw new Error(`identity proxy fault ${armed.mode} is still armed`);
      const fired = new Promise<FiredFault>((resolve, reject) => {
        armed = { mode, userId, resolve, reject };
      });
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
): Promise<{ response: HttpResult; operationId?: string }> {
  if (c.killed === 'people') {
    const response = await submitUser(writer, form, values.new, c.kind);
    expect(await isServing('people'), `people killed itself at ${c.step}; the save answered ${describeResponse(response)}`).toBe(false);
    await startService('people');
    await waitHealthy('people');
    return { response };
  }
  const fired = proxy.arm(c.fault, form.userId);
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

/** One case: fault, response, recovery, both sides' final state and what the concurrent reader saw meanwhile. */
async function runCase(c: RosterCase, proxy: IdentityProxy, sql: ReadOnlyMssql): Promise<void> {
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
    let readerError: unknown;
    let records: ReaderRecord[] = [];
    try {
      const { response, operationId } = await sendUnderFault(c, proxy, writer, form, values);
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
      expect(await awaitLegacy(sql, userId, values, final), `legacy tusers row of ${userId} after reverse projection`).toBe(final);
    } finally {
      try {
        records = await reader.stop();
      } catch (err) {
        readerError = err;
      }
    }
    if (readerError !== undefined) throw readerError;
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
    it(titleOf(c), { timeout: CASE_TIMEOUT_MS }, async () => {
      if (proxy === undefined || sql === undefined) throw new Error('the suite set-up did not finish');
      await runCase(c, proxy, sql);
    });
  }
});
