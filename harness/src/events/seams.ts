// Event-seam checks: person archive -> timesheet blackouts (seam 1) and survey schedule -> scheduled tasks (seam 2).
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import {
  MAX_EXPORT_LIMIT,
  MIGRATION_PATH_PREFIX,
  decodeRow,
  formatCanonicalTimestamp,
  type CanonicalColumn,
  type ExportResponse,
  type ExportRow,
} from '@opt2/platform/migration-kit';
import { QUEUES } from '@opt2/platform/tasks';
import { tenantIdForSite } from '@opt2/platform/tenancy';

import { FIXTURES_UNAVAILABLE, readFixtureStatus, type FixtureStatus } from '../golden/catalogue.js';
import {
  DEFAULT_SITE,
  SEED_CONFIG_PATH,
  adminLogin,
  jsonApiLogin,
  jsonApiTokens,
  loadSecretStore,
  loadSeedStore,
  originBaseUrl,
  type LoginCredentials,
  type LoginResult,
  type SecretStore,
  type SeedStore,
} from '../golden/session.js';
import { createHttpSession, type FetchLike, type HttpResult, type HttpSession } from '../lib/http.js';
import { createHarnessInvoker, type HarnessInvoker } from '../lib/invocation.js';
import { repoPath, type EnvLike } from '../lib/paths.js';
import { localUrl, type PackageName } from '../repro/ports.js';
import { mintTraceparent } from './traces.js';

/** Default bound of {@link pollUntil}, in ms. */
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/** Default wait between {@link pollUntil} calls, in ms. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Reminder offsets seam 2 schedules by default, in seconds after the launch. */
export const DEFAULT_REMINDER_OFFSETS_S: readonly number[] = Object.freeze([86_400, 172_800]);

/** Site whose person and survey the seams use by default. */
export const DEFAULT_SEAM_SITE = 'tenant-a';

/** Bounds of {@link pollUntil}; unset values take the defaults above. */
export interface PollBounds {
  timeoutMs?: number;
  intervalMs?: number;
}

/** Collaborators of the seam checks; each defaults to the live local stack. */
export interface SeamDeps {
  env?: EnvLike;
  fetch?: FetchLike;
  /** Source of the `platform.migration` invocation credential; default a `migration` harness invoker. */
  invoker?: HarnessInvoker;
  secrets?: SecretStore;
  seed?: SeedStore;
  /** Base URL per package, overriding the loopback ports of `ports.env`. */
  serviceUrls?: Partial<Record<PackageName, string>>;
  /** Sites whose programs-sites rows form the registry; default the seed config's sites plus `default`. */
  siteIds?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  poll?: PollBounds;
  fixtures?: FixtureStatus;
}

/** Evidence of a seam skipped because the legacy fixtures are unavailable. */
export interface SkippedEvidence {
  reason: string | null;
}

/** Outcome of one seam check. */
export type SeamResult<E = unknown> =
  | { passed: boolean; skipped?: undefined; evidence: E }
  | { passed: false; skipped: typeof FIXTURES_UNAVAILABLE; evidence: SkippedEvidence };

/** Decoded rows of one unit's export, with each row's raw entry for checksums. */
export interface OwnerExport {
  /** Columns of the first table carrying the unit; empty when the owner exports no table for it. */
  columns: CanonicalColumn[];
  rows: Record<string, unknown>[];
  entries: ExportRow[];
}

/** One registered site; pool ids are lower-cased site ids. */
export interface RegistrySite {
  siteId: string;
  tenantId: string;
  publicUserPoolId: string;
  privateUserPoolId: string;
}

/** Outcome of {@link pollUntil}: the last value read, the calls made and whether the bound ran out first. */
export interface PollOutcome<T> {
  value: T;
  polls: number;
  elapsedMs: number;
  timedOut: boolean;
}

interface OwnershipUnit {
  unit: string;
}

interface ResolvedDeps extends SeamDeps {
  env: EnvLike;
  invoker: HarnessInvoker;
  secrets: SecretStore;
  seed: SeedStore;
  now: () => number;
}

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FIXTURE_API = '/legacy-fixtures/cfml/api.cfm';

let ownershipUnits: readonly OwnershipUnit[] | undefined;

/** Unit id `<schema>.<table>` as `opt2/table-ownership.json` assigns it; throws naming the unit when it is unassigned. */
export function unitFor(schema: string, table: string): string {
  ownershipUnits ??= (
    JSON.parse(readFileSync(repoPath('opt2', 'table-ownership.json'), 'utf8')) as { units: OwnershipUnit[] }
  ).units;
  const unit = `${schema}.${table}`;
  if (!ownershipUnits.some((entry) => entry.unit === unit)) {
    throw new Error(`opt2/table-ownership.json assigns no unit ${unit}`);
  }
  return unit;
}

function asRecord(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : undefined;
}

/** Column `name` of a row, matched ignoring case as SQL Server matches column names. */
function field(row: Row | undefined, name: string): unknown {
  if (row === undefined) return undefined;
  if (Object.hasOwn(row, name)) return row[name];
  const lower = name.toLowerCase();
  const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : row[key];
}

/** String column `name`, '' when absent or not a string. */
function text(row: Row | undefined, name: string): string {
  const value = field(row, name);
  return typeof value === 'string' ? value : '';
}

/** Comparison form of a CF UUID: `char(35)` padding dropped and case folded, as SQL Server compares it. */
function idKey(id: string): string {
  return id.trimEnd().toUpperCase();
}

/** Canonical `t` text of a `yyyy-mm-dd` date or a wall-clock time, so times compare as strings. */
function wallClock(value: string): string {
  return formatCanonicalTimestamp(DATE_ONLY.test(value) ? `${value}T00:00:00` : value);
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => field(asRecord(current), key), value);
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Parsed JSON body of `result`, else its text. */
function responseBody(result: HttpResult): unknown {
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.text;
  }
}

function serviceUrl(service: PackageName, deps: SeamDeps): string {
  return deps.serviceUrls?.[service] ?? localUrl(service);
}

async function withInvoker(deps: SeamDeps): Promise<SeamDeps & { invoker: HarnessInvoker }> {
  return deps.invoker === undefined
    ? { ...deps, invoker: await createHarnessInvoker({ caller: 'migration', env: deps.env }) }
    : { ...deps, invoker: deps.invoker };
}

async function resolveDeps(deps: SeamDeps): Promise<ResolvedDeps> {
  const env = deps.env ?? process.env;
  return {
    ...(await withInvoker({ ...deps, env })),
    env,
    secrets: deps.secrets ?? loadSecretStore(env),
    seed: deps.seed ?? loadSeedStore(env),
    now: deps.now ?? Date.now,
  };
}

/**
 * Every page of the owner's `GET /internal/v1/migration/export` for `unit`, called as `platform.migration`, rows
 * decoded over their table's columns. Throws with the status and body on a non-2xx answer.
 */
export async function readOwnerExport(
  target: { service: PackageName; unit: string; tenantId?: string },
  deps: SeamDeps = {},
): Promise<OwnerExport> {
  const { invoker } = await withInvoker(deps);
  const session = createHttpSession({ baseUrl: serviceUrl(target.service, deps), fetch: deps.fetch });
  const out: OwnerExport = { columns: [], rows: [], entries: [] };
  let after: string | null = null;
  do {
    const url = new URL(`${MIGRATION_PATH_PREFIX}/export`, session.baseUrl);
    url.searchParams.set('unit', target.unit);
    if (target.tenantId !== undefined) url.searchParams.set('tenantId', target.tenantId);
    url.searchParams.set('limit', String(MAX_EXPORT_LIMIT));
    if (after !== null) url.searchParams.set('after', after);
    const headers = await invoker.headersFor({ callee: target.service, url: url.href });
    const result = await session.get(url.href, { headers });
    if (!isSuccess(result.status)) {
      throw new Error(`${target.service} export of ${target.unit} answered ${result.status}: ${result.text}`);
    }
    const page = result.json<ExportResponse>();
    for (const table of page.tables.filter((candidate) => candidate.unit === target.unit)) {
      if (out.columns.length === 0) out.columns = table.columns;
      for (const entry of table.rows) {
        out.rows.push(decodeRow(table.columns, entry.row));
        out.entries.push(entry);
      }
    }
    after = page.next;
  } while (after !== null);
  return out;
}

/** Site ids the registry is read for: `deps.siteIds`, else the seed config's sites plus the installed `default`. */
function registrySiteIds(deps: SeamDeps): readonly string[] {
  if (deps.siteIds !== undefined) return deps.siteIds;
  const config = JSON.parse(readFileSync(SEED_CONFIG_PATH, 'utf8')) as { sites?: Record<string, unknown> };
  return [...new Set([DEFAULT_SITE, ...Object.keys(config.sites ?? {})].map((site) => site.toLowerCase()))];
}

/**
 * The site registry from programs-sites' site-unit exports. Every `tsettings` row is its own site's tenant, so the
 * owner is read once per site tenant.
 */
export async function siteRegistry(deps: SeamDeps = {}): Promise<RegistrySite[]> {
  const resolved = await withInvoker(deps);
  const unit = unitFor('programs_sites', 'site');
  const sites: RegistrySite[] = [];
  for (const candidate of registrySiteIds(resolved)) {
    const { rows } = await readOwnerExport(
      { service: 'programs-sites', unit, tenantId: tenantIdForSite(candidate) },
      resolved,
    );
    for (const row of rows) {
      const siteId = text(row, 'SiteID');
      // An empty or NULL user pool is the site's own id, as usp_person_archived_blackout and settingsBean read it.
      const pool = (column: string): string => (text(row, column) || siteId).toLowerCase();
      sites.push({
        siteId,
        tenantId: tenantIdForSite(siteId),
        publicUserPoolId: pool('publicUserPoolID'),
        privateUserPoolId: pool('privateUserPoolID'),
      });
    }
  }
  return sites;
}

/** Calls `fn` until `done` holds for its value or `deps.poll.timeoutMs` has passed, sleeping the interval between calls. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  deps: Pick<SeamDeps, 'now' | 'sleep' | 'poll'> = {},
): Promise<PollOutcome<T>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const timeoutMs = deps.poll?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = deps.poll?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const start = now();
  for (let polls = 1; ; polls += 1) {
    const value = await fn();
    const elapsedMs = now() - start;
    if (done(value)) return { value, polls, elapsedMs, timedOut: false };
    if (elapsedMs >= timeoutMs) return { value, polls, elapsedMs, timedOut: true };
    await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
  }
}

/** Whether `day` is open under `usp_apply_blackout`: not `APPROVED`, case-folded as the collation compares, and dated on or after `effectiveFrom`. */
export function isOpenDay(day: Row, effectiveFrom: string): boolean {
  const state = field(day, 'state');
  return (
    typeof state === 'string' &&
    state.trimEnd().toUpperCase() !== 'APPROVED' &&
    wallClock(text(day, 'work_date')) >= wallClock(effectiveFrom)
  );
}

function skippedResult(status: FixtureStatus): SeamResult<never> {
  return { passed: false, skipped: FIXTURES_UNAVAILABLE, evidence: { reason: status.reason } };
}

/** Username and password of the seeded `role` account of `site`. */
function seededCredentials(secrets: SecretStore, site: string, role: string): LoginCredentials {
  const username = secrets.username(site, role);
  return { username, password: secrets.secret(`seed:${username}`) };
}

function assertLoggedIn(login: LoginResult, via: string, username: string): void {
  if (!login.ok) {
    throw new Error(`${via} login as ${username} through the gateway failed (status ${login.result.status})`);
  }
}

function gatewaySession(deps: ResolvedDeps): HttpSession {
  return createHttpSession({ baseUrl: originBaseUrl('gateway', deps.env), fetch: deps.fetch });
}

/** A person to archive: Masa `UserID` and the site whose user pools hold it. */
export interface SeamPerson {
  userId: string;
  siteId: string;
}

/** Options of {@link runSeam1}; unset subject fields take the seeded defaults. */
export type Seam1Options = SeamDeps & {
  person?: SeamPerson;
  /** `yyyy-mm-dd`; default the seed business date. */
  effectiveFrom?: string;
  credentials?: LoginCredentials;
};

/** Why a tenant receives the archive's blackouts. */
export type Seam1Reason = 'person-tenant' | 'userPool';

/** Expected and observed blackouts of the person in one destination tenant. */
export interface Seam1Destination {
  siteId: string;
  tenantId: string;
  reason: Seam1Reason;
  expectedDayIds: string[];
  /** Blackout day ids the person held before the archive. */
  preexistingDayIds: string[];
  blackoutDayIds: string[];
}

/** A registered tenant outside the fan-out, with the person's blackout rows found there. */
export interface Seam1OtherTenant {
  siteId: string;
  tenantId: string;
  blackoutRows: number;
}

/** Evidence of seam 1; `traceId` selects the archive's trace in the collector export. */
export interface Seam1Evidence {
  personId: string;
  siteId: string;
  effectiveFrom: string;
  traceId: string;
  archive: { status: number; body: unknown };
  destinations: Seam1Destination[];
  otherTenants: Seam1OtherTenant[];
  polls: number;
  elapsedMs: number;
  timedOut: boolean;
}

interface TenantTimesheets {
  sheets: Row[];
  days: Row[];
}

async function readTimesheets(tenantId: string, deps: SeamDeps): Promise<TenantTimesheets> {
  const sheets = await readOwnerExport({ service: 'timesheets', unit: unitFor('timesheets', 'timesheet'), tenantId }, deps);
  const days = await readOwnerExport({ service: 'timesheets', unit: unitFor('timesheets', 'timesheet_day'), tenantId }, deps);
  return { sheets: sheets.rows, days: days.rows };
}

/** Person id of every sheet in `data`, by sheet id. */
function sheetOwners(data: TenantTimesheets): Map<string, string> {
  return new Map(data.sheets.map((sheet) => [idKey(text(sheet, 'timesheet_id')), idKey(text(sheet, 'person_id'))]));
}

/** Ids of `personId`'s open days in `data`, sorted. */
function openDayIds(data: TenantTimesheets, personId: string, effectiveFrom: string): string[] {
  const owners = sheetOwners(data);
  const person = idKey(personId);
  return data.days
    .filter((day) => owners.get(idKey(text(day, 'timesheet_id'))) === person && isOpenDay(day, effectiveFrom))
    .map((day) => idKey(text(day, 'day_id')))
    .sort();
}

/** Day ids of `personId`'s blackout rows in the tenant, sorted, one entry per row. */
async function personBlackoutDayIds(tenantId: string, personId: string, deps: SeamDeps): Promise<string[]> {
  const { rows } = await readOwnerExport({ service: 'timesheets', unit: unitFor('timesheets', 'blackout'), tenantId }, deps);
  const person = idKey(personId);
  return rows
    .filter((row) => idKey(text(row, 'person_id')) === person)
    .map((row) => idKey(text(row, 'day_id')))
    .sort();
}

/** `matched` when `actual` holds each expected day once; `broken` on a duplicate or an unexpected day, which no later delivery removes. */
function blackoutState(expected: readonly string[], actual: readonly string[]): 'matched' | 'pending' | 'broken' {
  const want = new Set(expected);
  if (new Set(actual).size !== actual.length || actual.some((id) => !want.has(id))) return 'broken';
  return actual.length === want.size ? 'matched' : 'pending';
}

/**
 * First person, in sheet key order, with open days on or after `effectiveFrom` in the default site's timesheets, outside
 * `reserved.rehearsal` and without an archive record; the site is the seeded user's.
 */
async function defaultPerson(
  deps: ResolvedDeps,
  effectiveFrom: string,
  timesheetsOf: (tenantId: string) => Promise<TenantTimesheets>,
): Promise<SeamPerson> {
  const reserved = field(asRecord(deps.seed.select({ as: 'rehearsal', source: 'reserved', path: 'reserved.rehearsal' })), 'persons');
  const excluded = new Set((Array.isArray(reserved) ? reserved : []).map((id) => idKey(String(id))));
  const tenantId = tenantIdForSite(DEFAULT_SEAM_SITE);
  // Archive records exist only on the target: GS-PE-03 and earlier seam runs write them, the seed writes none.
  const archives = await readOwnerExport({ service: 'people', unit: unitFor('people', 'person_archive'), tenantId }, deps);
  for (const row of archives.rows) excluded.add(idKey(text(row, 'person_id')));
  const data = await timesheetsOf(tenantId);
  const owners = sheetOwners(data);
  const open = new Set<string>();
  for (const day of data.days) {
    const owner = owners.get(idKey(text(day, 'timesheet_id')));
    if (owner !== undefined && isOpenDay(day, effectiveFrom)) open.add(owner);
  }
  const userId = data.sheets.map((sheet) => text(sheet, 'person_id')).find((id) => open.has(idKey(id)) && !excluded.has(idKey(id)));
  if (userId === undefined) {
    throw new Error(
      `no ${DEFAULT_SEAM_SITE} person outside reserved.rehearsal and without an archive has open timesheet days on or after ${effectiveFrom}`,
    );
  }
  const user = asRecord(deps.seed.select({ as: 'person', source: 'dataset', path: 'masa.users', where: { userID: userId } }));
  return { userId, siteId: text(user, 'siteID') };
}

/** Seam 1 check: archives a person through the gateway and compares the blackouts of each registry-derived tenant. */
export async function runSeam1(deps: Seam1Options = {}): Promise<SeamResult<Seam1Evidence>> {
  const fixtures = deps.fixtures ?? readFixtureStatus(deps.env);
  if (!fixtures.available) return skippedResult(fixtures);
  const ctx = await resolveDeps(deps);
  const effectiveFrom = deps.effectiveFrom ?? ctx.seed.businessDate();
  // One read per tenant per run, shared by the default-person search and the destination expectations.
  const timesheets = new Map<string, TenantTimesheets>();
  const timesheetsOf = async (tenantId: string): Promise<TenantTimesheets> => {
    const known = timesheets.get(tenantId);
    if (known !== undefined) return known;
    const read = await readTimesheets(tenantId, ctx);
    timesheets.set(tenantId, read);
    return read;
  };

  const registry = await siteRegistry(ctx);
  const person = deps.person ?? (await defaultPerson(ctx, effectiveFrom, timesheetsOf));
  const personSite = person.siteId.toLowerCase();
  const reasons = new Map<string, { siteId: string; reason: Seam1Reason }>([
    [tenantIdForSite(person.siteId), { siteId: person.siteId, reason: 'person-tenant' }],
  ]);
  for (const site of registry) {
    if (!reasons.has(site.tenantId) && (site.publicUserPoolId === personSite || site.privateUserPoolId === personSite)) {
      reasons.set(site.tenantId, { siteId: site.siteId, reason: 'userPool' });
    }
  }
  const others = registry.filter((site) => !reasons.has(site.tenantId));

  const destinations: Seam1Destination[] = [];
  for (const [tenantId, { siteId, reason }] of reasons) {
    const open = openDayIds(await timesheetsOf(tenantId), person.userId, effectiveFrom);
    const preexistingDayIds = await personBlackoutDayIds(tenantId, person.userId, ctx);
    // usp_apply_blackout adds rows only for days without one, so earlier blackouts stay beside the new ones.
    const expectedDayIds = [...new Set([...open, ...preexistingDayIds])].sort();
    destinations.push({ siteId, tenantId, reason, expectedDayIds, preexistingDayIds, blackoutDayIds: preexistingDayIds });
  }

  const credentials = deps.credentials ?? seededCredentials(ctx.secrets, person.siteId, 'site-admin');
  const session = gatewaySession(ctx);
  assertLoggedIn(await adminLogin(session, credentials), 'admin', credentials.username);
  const { traceparent, traceId } = mintTraceparent();
  const result = await session.post(`${FIXTURE_API}/people/persons/${encodeURIComponent(person.userId)}/archive`, {
    query: { siteid: person.siteId },
    headers: { ...(await jsonApiTokens(session, person.siteId, person.userId)), traceparent },
    json: { effectiveFrom },
  });
  const evidence: Seam1Evidence = {
    personId: person.userId,
    siteId: person.siteId,
    effectiveFrom,
    traceId,
    archive: { status: result.status, body: responseBody(result) },
    destinations,
    otherTenants: [],
    polls: 0,
    elapsedMs: 0,
    timedOut: false,
  };
  if (!isSuccess(result.status)) return { passed: false, evidence };

  const poll = await pollUntil(
    () => Promise.all(destinations.map((destination) => personBlackoutDayIds(destination.tenantId, person.userId, ctx))),
    (observed) => destinations.every((destination, i) => blackoutState(destination.expectedDayIds, observed[i] ?? []) !== 'pending'),
    ctx,
  );
  evidence.destinations = destinations.map((destination, i) => ({ ...destination, blackoutDayIds: poll.value[i] ?? [] }));
  for (const site of others) {
    const rows = await personBlackoutDayIds(site.tenantId, person.userId, ctx);
    evidence.otherTenants.push({ siteId: site.siteId, tenantId: site.tenantId, blackoutRows: rows.length });
  }
  Object.assign(evidence, { polls: poll.polls, elapsedMs: poll.elapsedMs, timedOut: poll.timedOut });
  const passed =
    !poll.timedOut &&
    evidence.destinations.every((destination) => blackoutState(destination.expectedDayIds, destination.blackoutDayIds) === 'matched') &&
    evidence.otherTenants.every((tenant) => tenant.blackoutRows === 0);
  return { passed, evidence };
}


/** Options of {@link runSeam2}; unset subject fields take the seeded defaults. */
export type Seam2Options = SeamDeps & {
  surveyId?: string;
  siteId?: string;
  /** Wall-clock launch time `YYYY-MM-DDTHH:MM:SS` in the legacy server's zone. */
  launchAt?: string;
  /** Whole minutes, in seconds after the launch. */
  reminderOffsetsS?: readonly number[];
  credentials?: LoginCredentials;
};

/** One `communications.scheduled_task` row of the survey's schedule version, its time as an offset from the launch. */
export interface Seam2Row {
  name: string;
  kind: string;
  queue: string;
  offsetS: number;
  status: string;
}

/** One task of the fixture task list; `listed` because the list holds only tasks whose ACF task exists. */
export interface Seam2Task {
  name: string;
  queue: string;
  status: 'listed';
}

/** Evidence of seam 2. */
export interface Seam2Evidence {
  surveyId: string;
  siteId: string;
  tenantId: string;
  launchAt: string;
  scheduleVersion: number | null;
  schedule: { status: number; body: unknown };
  rows: Seam2Row[];
  /** Row count per queue. */
  queueCounts: Record<string, number>;
  taskList: Seam2Task[];
  mismatches: string[];
  polls: number;
  elapsedMs: number;
  timedOut: boolean;
}

const LAUNCH_QUEUE = QUEUES['surveys-launch'].name;
const REMINDER_QUEUE = QUEUES['communications-reminders'].name;

/** Queue of each `scheduled_task.kind`. */
const ROW_KIND_QUEUES: Readonly<Record<string, string>> = Object.freeze({
  'survey-launch': LAUNCH_QUEUE,
  'survey-reminder': REMINDER_QUEUE,
});

// The fixture task list names no queue: a launch task runs on surveys-launch and a reminder on communications-reminders.
const FIXTURE_KIND_QUEUES: Readonly<Record<string, string>> = Object.freeze({
  launch: LAUNCH_QUEUE,
  reminder: REMINDER_QUEUE,
});

/** `survey_id` of the default site's first seeded DRAFT survey; the seed schedules every other status. */
function defaultSurvey(seed: SeedStore, siteId: string): string {
  const where = { siteID: siteId, status: 'DRAFT' };
  return text(asRecord(seed.select({ as: 'survey', source: 'dataset', path: 'fixtures.synthetic.survey', where })), 'survey_id');
}

/**
 * Midnight after the business date while that is still ahead of the clock, else one day after now. Communications
 * moves a past schedule time to the moment it plans the task, which would erase the offsets this seam compares.
 */
function defaultLaunchAt(businessDate: string, nowMs: number): string {
  const nextDay = new Date(Date.parse(`${businessDate}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  const fromBusinessDate = `${nextDay}T00:00:00`;
  if (wallClock(fromBusinessDate) > formatCanonicalTimestamp(new Date(nowMs))) return fromBusinessDate;
  return formatCanonicalTimestamp(new Date(Math.floor(nowMs / 1000) * 1000 + DAY_MS)).slice(0, 19);
}

/** Seconds from `launchAt` to `time`, both zone-less wall-clock values. */
function offsetSeconds(time: string, launchAt: string): number {
  return (Date.parse(`${wallClock(time)}Z`) - Date.parse(`${wallClock(launchAt)}Z`)) / 1000;
}

/** The survey's rows of schedule version `version` (every version when it is unknown). */
function surveyRows(exported: OwnerExport, surveyId: string, version: number | null, launchAt: string): Seam2Row[] {
  const survey = idKey(surveyId);
  return exported.rows
    .filter(
      (row) =>
        text(row, 'source_type') === 'survey' &&
        idKey(text(row, 'source_id')) === survey &&
        (version === null || Number(field(row, 'schedule_version')) === version),
    )
    .map((row) => ({
      name: text(row, 'task_name'),
      kind: text(row, 'kind'),
      queue: text(row, 'queue'),
      offsetS: offsetSeconds(text(row, 'schedule_time'), launchAt),
      status: text(row, 'status'),
    }));
}

/** Differences of `rows` from one launch at offset 0 on its queue and one reminder per offset on its queue. */
function taskMismatches(rows: readonly Seam2Row[], offsetsS: readonly number[]): string[] {
  const mismatches: string[] = [];
  const launches = rows.filter((row) => row.kind === 'survey-launch');
  if (launches.length !== 1) mismatches.push(`expected 1 survey-launch task, found ${launches.length}`);
  for (const row of rows) {
    const queue = ROW_KIND_QUEUES[row.kind];
    if (queue === undefined) mismatches.push(`${row.name}: unexpected kind ${row.kind}`);
    else if (row.queue !== queue) mismatches.push(`${row.name}: ${row.kind} on queue ${row.queue}, expected ${queue}`);
  }
  for (const row of launches) {
    if (row.offsetS !== 0) mismatches.push(`${row.name}: launch at offset ${row.offsetS} s, expected 0 s`);
  }
  const byNumber = (a: number, b: number): number => a - b;
  const found = rows.filter((row) => row.kind === 'survey-reminder').map((row) => row.offsetS).sort(byNumber);
  const expected = [...offsetsS].sort(byNumber);
  if (found.join() !== expected.join()) {
    mismatches.push(`survey-reminder offsets [${found.join(', ')}] s, expected [${expected.join(', ')}] s`);
  }
  return mismatches;
}

/** Tasks of a fixture `…/tasks` envelope. */
function fixtureTasks(body: unknown): Seam2Task[] {
  const items = valueAt(body, ['data', 'items']);
  return (Array.isArray(items) ? items : []).map((item) => {
    const task = asRecord(item);
    const kind = text(task, 'kind');
    return { name: text(task, 'taskname'), queue: FIXTURE_KIND_QUEUES[kind] ?? `unknown kind ${kind}`, status: 'listed' };
  });
}

/** Task names and queues present on only one side of rows and task list. */
function listMismatches(rows: readonly Seam2Row[], tasks: readonly Seam2Task[]): string[] {
  const key = (task: { name: string; queue: string }): string => `${task.name} on ${task.queue}`;
  const fromRows = new Set(rows.map(key));
  const fromList = new Set(tasks.map(key));
  return [
    ...[...fromRows].filter((entry) => !fromList.has(entry)).map((entry) => `task list lacks ${entry}`),
    ...[...fromList].filter((entry) => !fromRows.has(entry)).map((entry) => `task list holds ${entry}, absent from scheduled_task`),
  ];
}

/** Seam 2 check: schedules a survey through the gateway and compares communications' task rows and the fixture task list. */
export async function runSeam2(deps: Seam2Options = {}): Promise<SeamResult<Seam2Evidence>> {
  const fixtures = deps.fixtures ?? readFixtureStatus(deps.env);
  if (!fixtures.available) return skippedResult(fixtures);
  const offsetsS = deps.reminderOffsetsS ?? DEFAULT_REMINDER_OFFSETS_S;
  if (!offsetsS.every((offset) => Number.isInteger(offset / 60) && offset >= 0)) {
    throw new RangeError(`reminderOffsetsS must be non-negative whole minutes, got [${offsetsS.join(', ')}]`);
  }
  const ctx = await resolveDeps(deps);
  const siteId = deps.siteId ?? DEFAULT_SEAM_SITE;
  const surveyId = deps.surveyId ?? defaultSurvey(ctx.seed, siteId);
  const launchAt = deps.launchAt ?? defaultLaunchAt(ctx.seed.businessDate(), ctx.now());
  const tenantId = tenantIdForSite(siteId);
  const credentials = deps.credentials ?? seededCredentials(ctx.secrets, siteId, 'surveys.manager');

  const session = gatewaySession(ctx);
  assertLoggedIn(await jsonApiLogin(session, { site: siteId, ...credentials }), 'JSON API', credentials.username);
  const surveyPath = `${FIXTURE_API}/surveys/surveys/${encodeURIComponent(surveyId)}`;
  const result = await session.post(`${surveyPath}/schedule`, {
    query: { siteid: siteId },
    headers: await jsonApiTokens(session, siteId, surveyId),
    json: { launchAt, reminders: offsetsS.map((offset) => ({ offsetMinutes: offset / 60 })) },
  });
  const body = responseBody(result);
  const version = valueAt(body, ['data', 'schedule', 'schedule_version']);
  const evidence: Seam2Evidence = {
    surveyId,
    siteId,
    tenantId,
    launchAt,
    scheduleVersion: typeof version === 'number' && Number.isInteger(version) ? version : null,
    schedule: { status: result.status, body },
    rows: [],
    queueCounts: {},
    taskList: [],
    mismatches: [],
    polls: 0,
    elapsedMs: 0,
    timedOut: false,
  };
  if (!isSuccess(result.status)) {
    evidence.mismatches.push(`schedule answered ${result.status}`);
    return { passed: false, evidence };
  }
  if (evidence.scheduleVersion === null) evidence.mismatches.push('schedule response carries no data.schedule.schedule_version');

  const unit = unitFor('communications', 'scheduled_task');
  const expectedRows = offsetsS.length + 1;
  // An export without a table for the unit cannot fill later, so it ends the wait at once.
  const poll = await pollUntil(
    () => readOwnerExport({ service: 'communications', unit, tenantId }, ctx),
    (exported) =>
      exported.columns.length === 0 ||
      surveyRows(exported, surveyId, evidence.scheduleVersion, launchAt).length >= expectedRows,
    ctx,
  );
  if (poll.value.columns.length === 0) evidence.mismatches.push(`communications export carries no table for unit ${unit}`);
  evidence.rows = surveyRows(poll.value, surveyId, evidence.scheduleVersion, launchAt);
  for (const row of evidence.rows) evidence.queueCounts[row.queue] = (evidence.queueCounts[row.queue] ?? 0) + 1;
  evidence.mismatches.push(...taskMismatches(evidence.rows, offsetsS));

  const tasks = await session.get(`${surveyPath}/tasks`, { query: { siteid: siteId } });
  if (isSuccess(tasks.status)) evidence.taskList = fixtureTasks(responseBody(tasks));
  else evidence.mismatches.push(`task list answered ${tasks.status}`);
  evidence.mismatches.push(...listMismatches(evidence.rows, evidence.taskList));
  Object.assign(evidence, { polls: poll.polls, elapsedMs: poll.elapsedMs, timedOut: poll.timedOut });
  return { passed: !poll.timedOut && evidence.mismatches.length === 0, evidence };
}

