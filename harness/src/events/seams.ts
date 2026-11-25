// Event-seam check: a stub note created through the gateway is projected in each registry-derived destination tenant of
// its topic and nowhere else; owner-export, registry and polling helpers shared by the event checks.
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import {
  pushPath,
  readTopicSchema,
  subscriptionName,
  topicMeta,
  topicSchemaRelativePath,
  type TenantFanout,
} from '@opt2/platform/events';
import {
  GATE_WAIT_MS,
  MAX_EXPORT_LIMIT,
  MIGRATION_PATH_PREFIX,
  decodeRow,
  type CanonicalColumn,
  type ExportResponse,
  type ExportRow,
  type GateRequest,
  type GateResponse,
  type UnitGate,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';

import {
  DEFAULT_SITE,
  SEED_CONFIG_PATH,
  adminLogin,
  loadSecretStore,
  originBaseUrl,
  type LoginCredentials,
  type LoginResult,
  type SecretStore,
} from '../golden/session.js';
import { createHttpSession, type FetchLike, type HttpResult, type HttpSession } from '../lib/http.js';
import { createHarnessInvoker, type HarnessInvoker } from '../lib/invocation.js';
import { repoPath, type EnvLike } from '../lib/paths.js';
import { localUrl, type PackageName } from '../repro/ports.js';
import { capturedLogOffsets, mintTraceparent, readCapturedLogLines } from './traces.js';

/** Default bound of {@link pollUntil}, in ms. */
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/** Default wait between {@link pollUntil} calls, in ms. */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Site whose seeded system user creates the seam's note by default. */
export const DEFAULT_SEAM_SITE = 'tenant-a';

/** Topic the note seam carries: the stub's note event, which the stub itself consumes. */
export const NOTE_SEAM_TOPIC = 'stub.note.created.v1';

/** Unit the note seam's consumer writes: one projection row per note in each destination tenant. */
export const NOTE_PROJECTION_UNIT = 'stub.note_projection';

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
  /** Base URL per package, overriding the loopback ports of `ports.env`. */
  serviceUrls?: Partial<Record<PackageName, string>>;
  /** Sites whose programs-sites rows form the registry; default the seed config's sites plus `default`. */
  siteIds?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  poll?: PollBounds;
}

/** Outcome of one seam check. */
export interface SeamResult<E = unknown> {
  passed: boolean;
  evidence: E;
}

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
  now: () => number;
}

type Row = Record<string, unknown>;

const NOTES_PATH = '/opt2/stub/notes';
const POSITIVE_DIGITS = /^[1-9][0-9]*$/;

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
      // An empty or NULL user pool is the site's own id, as settingsBean reads it.
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

/** Why a tenant receives an event: its own site's tenant, or a user-pool fan-out. */
export type SeamReason = 'origin-tenant' | 'userPool';

/** A destination tenant the consumer derives for an event from the site registry. */
export interface SeamDestination {
  siteId: string;
  tenantId: string;
  reason: SeamReason;
}

/**
 * Destinations of an event of `siteId` under the topic's `fanout`: the site's own tenant, then, for a `userPool` fan-out,
 * every registered site whose public or private user pool is that site. Throws when the registry holds no `siteId`.
 */
export function fanoutDestinations(
  siteId: string,
  registry: readonly RegistrySite[],
  fanout: TenantFanout | null,
): SeamDestination[] {
  const site = siteId.toLowerCase();
  const own = registry.find((entry) => entry.siteId.toLowerCase() === site);
  if (own === undefined) throw new Error(`the site registry holds no ${siteId}`);
  const destinations: SeamDestination[] = [{ siteId: own.siteId, tenantId: own.tenantId, reason: 'origin-tenant' }];
  if (fanout !== 'userPool') return destinations;
  for (const entry of registry) {
    const known = destinations.some((destination) => destination.tenantId === entry.tenantId);
    if (!known && (entry.publicUserPoolId === site || entry.privateUserPoolId === site)) {
      destinations.push({ siteId: entry.siteId, tenantId: entry.tenantId, reason: 'userPool' });
    }
  }
  return destinations;
}

/** The `x-opt2-tenant-fanout` that {@link NOTE_SEAM_TOPIC}'s schema declares, null when it declares none. */
export function noteSeamFanout(): TenantFanout | null {
  return topicMeta(readTopicSchema(repoPath(topicSchemaRelativePath(NOTE_SEAM_TOPIC)))).fanout ?? null;
}

/** Idempotency columns of one `stub.note_projection` row. */
export interface NoteProjection {
  applyCount: number;
  aggregateVersion: number;
  lastEventId: string;
}

/** `noteId`'s {@link NOTE_PROJECTION_UNIT} rows in the tenant, read from the stub's export, one entry per row. */
export async function readNoteProjections(tenantId: string, noteId: string, deps: SeamDeps = {}): Promise<NoteProjection[]> {
  const { rows } = await readOwnerExport({ service: 'stub', unit: NOTE_PROJECTION_UNIT, tenantId }, deps);
  const note = idKey(noteId);
  return rows
    .filter((row) => idKey(text(row, 'note_id')) === note)
    .map((row) => ({
      applyCount: Number(text(row, 'apply_count')),
      aggregateVersion: Number(text(row, 'aggregate_version')),
      lastEventId: text(row, 'last_event_id').toLowerCase(),
    }));
}

/** `matched` once one projection of `rowVersion` was applied once, `pending` before any, else `broken`, which no later delivery repairs. */
function projectionState(rows: readonly NoteProjection[], rowVersion: number): 'matched' | 'pending' | 'broken' {
  const [row] = rows;
  if (row === undefined) return 'pending';
  return rows.length === 1 && row.applyCount === 1 && row.aggregateVersion === rowVersion ? 'matched' : 'broken';
}

/** Pool a seam note is created in: the registered public user pool of the creator's site. */
export type NotePool = 'public';

/** Unit of the note rows only the envelope tenant's re-check reads; its gate interrupts a delivery between destinations. */
export const NOTE_UNIT = 'stub.note';

/** Default bounds of an interrupted seam's waits for the non-2xx push answer and for the redelivery. */
export const DEFAULT_REDELIVERY_POLL: Required<PollBounds> = { timeoutMs: GATE_WAIT_MS + 90_000, intervalMs: 2_000 };

const GATED_UNITS: readonly string[] = [NOTE_UNIT, NOTE_PROJECTION_UNIT];
const GATE_PATH = `${MIGRATION_PATH_PREFIX}/gate`;
const POSITION_PATH = `${MIGRATION_PATH_PREFIX}/position`;
const NOTE_PUSH_ROUTE = pushPath(subscriptionName('stub', NOTE_SEAM_TOPIC));
const COMPLETED_MESSAGE = 'request completed';

/** Options of {@link runNoteSeam}; unset fields take the seeded defaults. */
export type NoteSeamOptions = SeamDeps & {
  /** Site whose user creates the note; default {@link DEFAULT_SEAM_SITE}. */
  siteId?: string;
  /** Default the seeded system user of `siteId`. */
  credentials?: LoginCredentials;
  /** `public` creates the note in the tenant of `siteId`'s registered public user pool, which fans it out to the sites sharing it. */
  pool?: NotePool;
  /** Interrupts the first delivery after the fan-out destinations applied it and before the note's tenant did; see {@link FanoutInterruption}. */
  interrupt?: boolean;
  /** Reader of the stub's push answers to an interrupted delivery; default {@link stubDeliveryLog}. */
  deliveryLog?: DeliveryLog;
  /** Bounds of the interrupted delivery's waits; default {@link DEFAULT_REDELIVERY_POLL}. */
  redeliveryPoll?: PollBounds;
};

/** The note's projection rows in one destination tenant. */
export interface NoteSeamDestination extends SeamDestination {
  projections: NoteProjection[];
}

/** A registered tenant outside the destinations, with the note's projection rows found there. */
export interface NoteSeamOtherTenant {
  siteId: string;
  tenantId: string;
  projectionRows: number;
}

/** End position of each log a {@link DeliveryLog} reads. */
export type LogMark = Readonly<Record<string, number>>;

/** One answer the stub logged to a push delivery on its note subscription. */
export interface DeliveryAnswer {
  statusCode: number;
  latencyMs: number | null;
}

/** The stub's answers to push deliveries of one event, read from its process log. */
export interface DeliveryLog {
  /** The log's end now; a read from it sees only lines written later. */
  mark(): LogMark;
  /** Answers to deliveries of `eventId` logged after `from`, in log order. */
  answers(eventId: string, from: LogMark): DeliveryAnswer[];
}

/** The note's projections per destination site, and the tenants holding an inbox receipt of its event, read once. */
export interface NoteStateRead {
  projections: Record<string, NoteProjection[]>;
  receipts: string[];
}

/** Calls one wait made, the ms it took and whether its bound ran out. */
export interface WaitSummary {
  polls: number;
  elapsedMs: number;
  timedOut: boolean;
}

/**
 * An interrupted note delivery. `stub.note_projection` is gated closed across the create, so no destination applies the first
 * delivery yet. `stub.note` is then put in a write window's executing phase, which blocks the note read that only the envelope
 * tenant's re-check makes, and `stub.note_projection` reopens: the fan-out destinations apply, the envelope tenant waits out its
 * gate budget and the push is answered non-2xx. Once `stub.note` reopens, Pub/Sub redelivers the whole fan-out and only the
 * envelope tenant, which holds no receipt, applies it.
 */
export interface FanoutInterruption {
  holderId: string;
  /** The two gates before the seam changed them, and after it reopened them. */
  gatesBefore: UnitGate[];
  gatesAfter: UnitGate[];
  eventId: string | null;
  /** The fan-out destinations applying the first delivery while the envelope tenant's note reads were blocked. */
  fanoutApplied: WaitSummary & { state: NoteStateRead | null };
  /** Answers logged after the fan-out destinations had applied, read until one is non-2xx. */
  interruptedAnswers: WaitSummary & { answers: DeliveryAnswer[] };
  /** State after that answer, before `stub.note` reopened. */
  betweenAttempts: NoteStateRead | null;
  /** The redelivery applying the event in every destination. */
  recovered: (WaitSummary & { state: NoteStateRead }) | null;
  /** Every answer logged for the event since the create. */
  answers: DeliveryAnswer[];
  /** Why the interruption or its recovery is not as required; empty when it is. */
  problems: string[];
}

/** Evidence of the note seam; `traceId` selects the create's trace in the collector export. */
export interface NoteSeamEvidence {
  /** Site of the note's creator. */
  siteId: string;
  pool: NotePool | null;
  /** Site whose tenant stores the note: `siteId`, or its public user-pool site. */
  noteSiteId: string;
  noteId: string | null;
  rowVersion: number | null;
  traceId: string;
  create: { status: number; body: unknown };
  fanout: TenantFanout | null;
  destinations: NoteSeamDestination[];
  otherTenants: NoteSeamOtherTenant[];
  polls: number;
  elapsedMs: number;
  timedOut: boolean;
  interruption?: FanoutInterruption;
}

/** {@link DeliveryLog} over the stub log `up.json` records: its `request completed` lines of the note push route. */
export function stubDeliveryLog(env: EnvLike = process.env): DeliveryLog {
  const packages = ['stub'];
  return {
    mark: () => capturedLogOffsets({ env, packages }),
    answers(eventId, from) {
      const wanted = eventId.toLowerCase();
      const answers: DeliveryAnswer[] = [];
      for (const { line } of readCapturedLogLines({ env, packages, fromOffsets: from })) {
        if (!line.includes(COMPLETED_MESSAGE)) continue;
        let record: Row | undefined;
        try {
          record = asRecord(JSON.parse(line));
        } catch {
          // A process may write a line that is not JSON, such as a crash trace; it answers no delivery.
          continue;
        }
        const logged = text(record, 'eventId').toLowerCase();
        const statusCode = field(record, 'statusCode');
        const latencyMs = field(record, 'latencyMs');
        if (field(record, 'message') !== COMPLETED_MESSAGE || field(record, 'route') !== NOTE_PUSH_ROUTE) continue;
        if (logged !== wanted || typeof statusCode !== 'number') continue;
        answers.push({ statusCode, latencyMs: typeof latencyMs === 'number' ? latencyMs : null });
      }
      return answers;
    },
  };
}

/** Calls the stub's `POST /internal/v1/migration/gate` as `platform.migration`; throws with the status and body on a non-2xx answer. */
async function stubGate(request: GateRequest, deps: SeamDeps): Promise<UnitGate[]> {
  const { invoker } = await withInvoker(deps);
  const session = createHttpSession({ baseUrl: serviceUrl('stub', deps), fetch: deps.fetch });
  const url = new URL(GATE_PATH, session.baseUrl).href;
  const headers = await invoker.headersFor({ callee: 'stub', url });
  const result = await session.post(url, { headers, json: request });
  if (!isSuccess(result.status)) {
    throw new Error(`stub gate ${request.op} of ${(request.units ?? []).join(', ')} answered ${result.status}: ${result.text}`);
  }
  return result.json<GateResponse>().units;
}

/** Tenants holding a stub inbox receipt of `eventId`, lower-cased and sorted, from the stub's migration position. */
export async function readNoteReceipts(eventId: string, deps: SeamDeps = {}): Promise<string[]> {
  const { invoker } = await withInvoker(deps);
  const session = createHttpSession({ baseUrl: serviceUrl('stub', deps), fetch: deps.fetch });
  const url = new URL(POSITION_PATH, session.baseUrl);
  url.searchParams.set('eventIds', eventId);
  const headers = await invoker.headersFor({ callee: 'stub', url: url.href });
  const result = await session.get(url.href, { headers });
  if (!isSuccess(result.status)) throw new Error(`stub migration position answered ${result.status}: ${result.text}`);
  const { inbox } = result.json<{ inbox: { receipts?: Record<string, string[]> } | null }>();
  if (inbox === null) throw new Error(`stub migration position lacks its inbox: ${result.text}`);
  return (inbox.receipts?.[eventId.toLowerCase()] ?? []).map((tenantId) => tenantId.toLowerCase()).sort();
}

/** The site of `siteId`'s registered public user pool; throws when the registry holds no `siteId`. */
function publicUserPoolSite(siteId: string, registry: readonly RegistrySite[]): string {
  const own = registry.find((entry) => entry.siteId.toLowerCase() === siteId.toLowerCase());
  if (own === undefined) throw new Error(`the site registry holds no ${siteId}`);
  return own.publicUserPoolId;
}

/** `noteId`'s projections in each of `targets`, keyed by site. */
async function destinationProjections(
  targets: readonly SeamDestination[],
  noteId: string,
  deps: SeamDeps,
): Promise<Record<string, NoteProjection[]>> {
  const projections: Record<string, NoteProjection[]> = {};
  for (const target of targets) projections[target.siteId] = await readNoteProjections(target.tenantId, noteId, deps);
  return projections;
}

/** {@link destinationProjections} with the receipts of `eventId`. */
async function readNoteState(targets: readonly SeamDestination[], noteId: string, eventId: string, deps: SeamDeps): Promise<NoteStateRead> {
  return { projections: await destinationProjections(targets, noteId, deps), receipts: await readNoteReceipts(eventId, deps) };
}

function waitOf<T>(outcome: PollOutcome<T>): WaitSummary {
  return { polls: outcome.polls, elapsedMs: outcome.elapsedMs, timedOut: outcome.timedOut };
}

/** What one run of the seam needs once the note's destinations are known. */
interface SeamRun {
  ctx: ResolvedDeps;
  options: NoteSeamOptions;
  targets: SeamDestination[];
  others: RegistrySite[];
  traceId: string;
  create(): Promise<HttpResult>;
  evidenceOf(result: HttpResult): NoteSeamEvidence;
}

/** Projections of the note in every registered tenant outside the destinations. */
async function outsideTenants(run: SeamRun, noteId: string): Promise<NoteSeamOtherTenant[]> {
  const out: NoteSeamOtherTenant[] = [];
  for (const site of run.others) {
    const rows = await readNoteProjections(site.tenantId, noteId, run.ctx);
    out.push({ siteId: site.siteId, tenantId: site.tenantId, projectionRows: rows.length });
  }
  return out;
}

/** Creates the note and waits for its first delivery to reach every destination. */
async function deliveredSeam(run: SeamRun): Promise<SeamResult<NoteSeamEvidence>> {
  const { ctx, targets } = run;
  const evidence = run.evidenceOf(await run.create());
  const { noteId, rowVersion } = evidence;
  if (!isSuccess(evidence.create.status) || noteId === null || rowVersion === null) return { passed: false, evidence };

  const poll = await pollUntil(
    () => Promise.all(targets.map((target) => readNoteProjections(target.tenantId, noteId, ctx))),
    (observed) => targets.every((_, i) => projectionState(observed[i] ?? [], rowVersion) !== 'pending'),
    ctx,
  );
  evidence.destinations = targets.map((target, i) => ({ ...target, projections: poll.value[i] ?? [] }));
  evidence.otherTenants = await outsideTenants(run, noteId);
  Object.assign(evidence, waitOf(poll));
  const passed =
    !poll.timedOut &&
    evidence.destinations.every((destination) => projectionState(destination.projections, rowVersion) === 'matched') &&
    evidence.otherTenants.every((tenant) => tenant.projectionRows === 0);
  return { passed, evidence };
}

function isOpenUnheld(gate: UnitGate): boolean {
  return gate.state === 'open' && gate.holderId === null && gate.phase === 'quiet';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The interrupted delivery's steps between the seam's gate check and its gate restore; each unmet step adds to `interruption.problems`. */
async function interruptAndRecover(run: SeamRun, interruption: FanoutInterruption, log: DeliveryLog): Promise<NoteSeamEvidence> {
  const { ctx, options, targets } = run;
  const { holderId, problems } = interruption;
  const redelivery = { ...ctx, poll: options.redeliveryPoll ?? DEFAULT_REDELIVERY_POLL };
  const origin = targets[0] as SeamDestination;
  const originTenant = origin.tenantId.toLowerCase();
  const fanoutTargets = targets.filter((target) => target.reason === 'userPool');
  const tenantIds = targets.map((target) => target.tenantId.toLowerCase()).sort();
  const projectionsIn = (state: NoteStateRead, site: SeamDestination): NoteProjection[] => state.projections[site.siteId] ?? [];

  await stubGate({ op: 'close', units: [NOTE_PROJECTION_UNIT], holderId }, ctx);
  const evidence = run.evidenceOf(await run.create());
  evidence.interruption = interruption;
  const { noteId, rowVersion } = evidence;
  if (!isSuccess(evidence.create.status) || noteId === null || rowVersion === null) {
    problems.push(`the note create answered ${evidence.create.status} without a saved note`);
    return evidence;
  }
  await stubGate({ op: 'close', units: [NOTE_UNIT], holderId, phase: 'executing' }, ctx);
  await stubGate({ op: 'open', units: [NOTE_PROJECTION_UNIT], holderId, state: 'open' }, ctx);

  const applied = await pollUntil(
    () => destinationProjections(targets, noteId, ctx),
    (projections) => fanoutTargets.every((site) => projectionState(projections[site.siteId] ?? [], rowVersion) !== 'pending'),
    redelivery,
  );
  const eventId = fanoutTargets.map((site) => applied.value[site.siteId]?.[0]?.lastEventId).find((id) => id !== undefined) ?? null;
  interruption.eventId = eventId;
  const appliedState = { projections: applied.value, receipts: eventId === null ? [] : await readNoteReceipts(eventId, ctx) };
  interruption.fanoutApplied = { ...waitOf(applied), state: appliedState };
  if (applied.timedOut || eventId === null) {
    problems.push(`no fan-out destination applied the first delivery within ${applied.elapsedMs} ms`);
  }
  for (const site of fanoutTargets) {
    if (projectionState(projectionsIn(appliedState, site), rowVersion) !== 'matched') {
      problems.push(`${site.siteId} did not apply the first delivery once`);
    }
  }
  if (projectionsIn(appliedState, origin).length > 0 || appliedState.receipts.includes(originTenant)) {
    problems.push(`${origin.siteId} applied the first delivery although its note reads were blocked`);
  }
  if (problems.length > 0 || eventId === null) return evidence;

  const since = log.mark();
  const answered = await pollUntil(
    async () => log.answers(eventId, since),
    (answers) => answers.some((answer) => !isSuccess(answer.statusCode)),
    redelivery,
  );
  interruption.interruptedAnswers = { ...waitOf(answered), answers: answered.value };
  if (answered.timedOut) {
    problems.push(`the stub logged no non-2xx answer to the interrupted delivery within ${answered.elapsedMs} ms`);
  }
  const between = await readNoteState(targets, noteId, eventId, ctx);
  interruption.betweenAttempts = between;
  if (projectionsIn(between, origin).length > 0 || between.receipts.includes(originTenant)) {
    problems.push(`${origin.siteId} applied the event before its note reads were unblocked`);
  }
  if (fanoutTargets.some((site) => projectionState(projectionsIn(between, site), rowVersion) !== 'matched')) {
    problems.push('a fan-out destination changed its projection between the delivery attempts');
  }
  if (problems.length > 0) return evidence;

  await stubGate({ op: 'open', units: [NOTE_UNIT], holderId, state: 'open' }, ctx);
  const recovered = await pollUntil(
    () => readNoteState(targets, noteId, eventId, ctx),
    (state) =>
      targets.every((site) => projectionState(projectionsIn(state, site), rowVersion) !== 'pending') &&
      tenantIds.every((tenantId) => state.receipts.includes(tenantId)),
    redelivery,
  );
  interruption.recovered = { ...waitOf(recovered), state: recovered.value };
  if (recovered.timedOut) problems.push(`the redelivery did not reach every destination within ${recovered.elapsedMs} ms`);
  for (const site of targets) {
    const rows = projectionsIn(recovered.value, site);
    if (projectionState(rows, rowVersion) !== 'matched' || rows[0]?.lastEventId !== eventId) {
      problems.push(`${site.siteId} holds ${JSON.stringify(rows)}, not event ${eventId} applied once`);
    }
  }
  if (JSON.stringify(recovered.value.receipts) !== JSON.stringify(tenantIds)) {
    problems.push(`receipts of ${eventId} are in ${JSON.stringify(recovered.value.receipts)}, not exactly ${JSON.stringify(tenantIds)}`);
  }
  evidence.destinations = targets.map((target) => ({ ...target, projections: projectionsIn(recovered.value, target) }));
  evidence.otherTenants = await outsideTenants(run, noteId);
  Object.assign(evidence, waitOf(recovered));
  for (const tenant of evidence.otherTenants.filter((other) => other.projectionRows > 0)) {
    problems.push(`${tenant.siteId}, outside the destinations, holds ${tenant.projectionRows} projection rows`);
  }
  return evidence;
}

/**
 * Creates the note with its first delivery interrupted between destinations, then waits for the redelivery; see
 * {@link FanoutInterruption}. The gates it closed reopen whatever fails, and must end open, unheld and quiet.
 */
async function interruptedSeam(run: SeamRun): Promise<SeamResult<NoteSeamEvidence>> {
  const { ctx, options, traceId } = run;
  const log = options.deliveryLog ?? stubDeliveryLog(ctx.env);
  const holderId = `note-seam-${traceId}`;
  const gatesBefore = await stubGate({ op: 'status', units: [...GATED_UNITS] }, ctx);
  if (gatesBefore.filter(isOpenUnheld).length !== GATED_UNITS.length) {
    throw new Error(`the stub gates of ${GATED_UNITS.join(', ')} must be open, unheld and quiet before the seam; read ${JSON.stringify(gatesBefore)}`);
  }
  const interruption: FanoutInterruption = {
    holderId,
    gatesBefore,
    gatesAfter: [],
    eventId: null,
    fanoutApplied: { polls: 0, elapsedMs: 0, timedOut: false, state: null },
    interruptedAnswers: { polls: 0, elapsedMs: 0, timedOut: false, answers: [] },
    betweenAttempts: null,
    recovered: null,
    answers: [],
    problems: [],
  };
  const from = log.mark();
  // Reopens only the gates this seam holds; null once every gated unit is open, unheld and quiet again.
  const reopen = async (): Promise<string | null> => {
    try {
      interruption.gatesAfter = await stubGate({ op: 'open', units: [...GATED_UNITS], holderId, state: 'open' }, ctx);
    } catch (err) {
      return `the stub gates did not reopen: ${errorText(err)}`;
    }
    const restored = interruption.gatesAfter.filter(isOpenUnheld).length === GATED_UNITS.length;
    return restored ? null : `the stub gates are ${JSON.stringify(interruption.gatesAfter)} after the seam, not open, unheld and quiet`;
  };

  let evidence: NoteSeamEvidence;
  try {
    evidence = await interruptAndRecover(run, interruption, log);
  } catch (err) {
    const unrestored = await reopen();
    if (unrestored !== null) throw new Error(`${errorText(err)}; ${unrestored}`, { cause: err });
    throw err;
  }
  const unrestored = await reopen();
  if (unrestored !== null) interruption.problems.push(unrestored);
  if (interruption.eventId !== null) interruption.answers = log.answers(interruption.eventId, from);
  return { passed: interruption.problems.length === 0, evidence };
}

/**
 * Note seam check: creates a note through the gateway, then requires its projection applied once in each registry-derived
 * destination tenant and absent from every other registered tenant; with `interrupt`, through an interrupted first delivery.
 */
export async function runNoteSeam(deps: NoteSeamOptions = {}): Promise<SeamResult<NoteSeamEvidence>> {
  const ctx = await resolveDeps(deps);
  const siteId = deps.siteId ?? DEFAULT_SEAM_SITE;
  const pool = deps.pool ?? null;
  const fanout = noteSeamFanout();
  const registry = await siteRegistry(ctx);
  const noteSiteId = pool === null ? siteId : publicUserPoolSite(siteId, registry);
  const targets = fanoutDestinations(noteSiteId, registry, fanout);
  const others = registry.filter((site) => !targets.some((target) => target.tenantId === site.tenantId));
  if (deps.interrupt === true && !targets.some((target) => target.reason === 'userPool')) {
    throw new Error(`a note of ${noteSiteId} has no user-pool fan-out destination, so its delivery cannot be interrupted between destinations`);
  }

  const credentials = deps.credentials ?? seededCredentials(ctx.secrets, siteId, 'system-user');
  const session = gatewaySession(ctx);
  assertLoggedIn(await adminLogin(session, credentials), 'admin', credentials.username);
  const { traceparent, traceId } = mintTraceparent();
  const run: SeamRun = {
    ctx,
    options: deps,
    targets,
    others,
    traceId,
    create: () =>
      session.post(NOTES_PATH, {
        query: { siteid: siteId },
        headers: { traceparent },
        json: { title: `Note seam ${traceId}`, body: 'Event seam evidence.', ...(pool === null ? {} : { pool }) },
      }),
    evidenceOf(result) {
      const body = responseBody(result);
      const data = asRecord(field(asRecord(body), 'data'));
      const rowVersionText = text(data, 'rowversion');
      return {
        siteId,
        pool,
        noteSiteId,
        noteId: text(data, 'noteid') || null,
        rowVersion: POSITIVE_DIGITS.test(rowVersionText) ? Number(rowVersionText) : null,
        traceId,
        create: { status: result.status, body },
        fanout,
        destinations: targets.map((target) => ({ ...target, projections: [] })),
        otherTenants: [],
        polls: 0,
        elapsedMs: 0,
        timedOut: false,
      };
    },
  };
  return deps.interrupt === true ? interruptedSeam(run) : deliveredSeam(run);
}
