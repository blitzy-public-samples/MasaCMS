// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** In-process authorisation matrix of every timesheets route, composed from createService and the package's own registrars. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  type Opt2RouteConfig,
  type RouteMatrixEntry,
  type Transport,
} from '@opt2/platform/auth';
import { buildPushBody, encodeEnvelope, registerConsumers, type EventEnvelope } from '@opt2/platform/events';
import { LEGACY_ERROR_MAP, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  closeGates,
  ensureUnitGates,
  openGates,
  registerMigrationHandlers,
  registerWritePositionHeader,
} from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  createService,
  fixedClock,
  loadEnv,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TEST_PUSH_KEY,
  authHeadersFor,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  pushKeyQuery,
  pushTo,
  registryPayloads,
  seedRegistry,
  subjectQueryFor,
  testEnvelope,
  testVerifier,
  type InjectResponse,
  type RoleSubject,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { TimesheetAction, TimesheetState } from '../../src/domain/lifecycle.transitions.js';
import { PERSON_ARCHIVED_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION, createConsumers } from '../../src/events/consumers.js';
import { PERSON_ARCHIVED_TOPIC } from '../../src/events/person-archived.js';
import { mappings, units } from '../../src/migration/mappings/index.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS, type TimesheetDayRow, type TimesheetRow } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { registerRoutes } from '../../src/routes/index.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

const SERVICE = 'timesheets';
const VERSION = '1.0.0';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const ON_SITE_A = `siteid=${SITE_A}`;
const P = FIXTURE_PREFIX;
const V1 = '/v1/timesheets';
const MIGRATION = '/internal/v1/migration';
const SITE_PUSH = `/internal/v1/events/${SITE_CHANGED_SUBSCRIPTION}`;
const ARCHIVE_PUSH = `/internal/v1/events/${PERSON_ARCHIVED_SUBSCRIPTION}`;
const EXPORT_READ = '/internal/v1/timesheets/sheet-status';
/** The running export job reporting confirms to the sheet status read the matrix probes. */
const EXPORT_ID = '7E57A0C7-0000-4000-8000000000000040';
const EXPORT_CLAIM = '2';
const EXPORT_SCOPE_PATH = `/internal/v1/exports/${EXPORT_ID}/source-scope`;
const SCOPE_LOOKUP = `reporting GET ${EXPORT_SCOPE_PATH}`;
const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const AS_OF = '2026-06-30';
const ACTOR_ID = '7E57A0C7-0000-4000-8000000000000001';
const PERSON = '7E57A0C7-0000-4000-8000000000000002';
const ARCHIVED_PERSON = '7E57A0C7-0000-4000-8000000000000003';
const SHEET_A = '7E57A0C7-0000-4000-8000000000000010';
const SHEET_B = '7E57A0C7-0000-4000-8000000000000020';
const SESSION_ID = '7E57A0C7-0000-4000-8000000000000030';
const UNKNOWN_DAY = '7E57A0C7-0000-4000-8000000000000099';
// The identity double answers every consume with `csrfVerdict`, valid by default, so admitted writes reach their handlers.
const CSRF_HEADERS = { 'x-csrf_token': 'AUTHZPROBETOKEN', 'x-csrf_token_expires': '260630120000000' } as const;
const METHOD_OVERRIDE = 'x-http-method-override';
const CONSUME = `${IDENTITY_SERVICE} POST ${CSRF_CONSUME_PATH}`;
const COMMENT = { comment: 'authz probe' };

const EMPLOYEE = 'timesheets.employee';
const PRIMARY = 'timesheets.primary-approver';
const SECONDARY = 'timesheets.secondary-approver';
const EXPORTER = 'reporting.exporter';
const TIMESHEET_ROLES: readonly string[] = [EMPLOYEE, PRIMARY, SECONDARY];
const STATUS_ROLES: readonly string[] = [EXPORTER, PRIMARY, SECONDARY];

// Subject names of ROLE_SET, written out so every expectation below is literal.
const SYNTHETIC = [
  EMPLOYEE,
  PRIMARY,
  SECONDARY,
  'finance.preparer',
  'finance.approver',
  'esignature.signer',
  'esignature.auditor',
  EXPORTER,
  'surveys.manager',
  'communications.sender',
] as const;

const WORKLOADS = [
  'service:identity',
  'service:people',
  'service:programs-sites',
  'service:strategies-content',
  'service:communications',
  'service:reporting',
  'service:surveys',
  'service:timesheets',
  'service:finance',
  'service:e-signature',
  'service:stub',
  'service:gateway',
  'service:web',
  'service:migration',
  'service:operator',
  'service:pubsub-invoker',
  'service:tasks-invoker',
] as const;

const EVERYONE: readonly string[] = ['anonymous', 'member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant', ...SYNTHETIC, ...WORKLOADS];

/** EVERYONE without `excluded`. */
function everyoneBut(...excluded: string[]): string[] {
  return EVERYONE.filter((name) => !excluded.includes(name));
}

/** Subjects without a user token: a route requiring user roles answers them 401. */
const NO_USER: readonly string[] = ['anonymous', ...WORKLOADS];

/** Subjects without an invocation credential: a service-transport route requiring workload roles answers them 401. */
const NO_INVOCATION: readonly string[] = ['anonymous', 'service:tasks-invoker', 'service:pubsub-invoker'];

/** Each lifecycle row: the action, a day state it is legal from, the one role it admits and the state it moves to. */
const WORKFLOW: ReadonlyArray<{ action: TimesheetAction; from: TimesheetState; role: string; to: TimesheetState }> = [
  { action: 'submit', from: 'DRAFT', role: EMPLOYEE, to: 'SUBMITTED' },
  { action: 'primary-approve', from: 'SUBMITTED', role: PRIMARY, to: 'PRIMARY_APPROVED' },
  { action: 'primary-approve', from: 'RESUBMITTED', role: PRIMARY, to: 'PRIMARY_APPROVED' },
  { action: 'secondary-approve', from: 'PRIMARY_APPROVED', role: SECONDARY, to: 'APPROVED' },
  { action: 'return', from: 'SUBMITTED', role: PRIMARY, to: 'RETURNED' },
  { action: 'return', from: 'RESUBMITTED', role: PRIMARY, to: 'RETURNED' },
  { action: 'return', from: 'PRIMARY_APPROVED', role: SECONDARY, to: 'RETURNED' },
  { action: 'resubmit', from: 'RETURNED', role: EMPLOYEE, to: 'RESUBMITTED' },
];

/** One concrete request; each subject's credentials are added when it is sent. */
interface ProbeRequest {
  method: 'GET' | 'POST';
  url: string;
  payload?: Record<string, unknown>;
  headers?: Readonly<Record<string, string>>;
}

/** A transport method and the X-HTTP-Method-Override sent beside it, if any. */
interface Tunnel {
  method: ProbeRequest['method'];
  override?: string;
}

/** What one request left behind, counted from a {@link Mark}. */
interface Effects {
  tenantTx: number;
  metadataTx: number;
  calls: string[];
  published: number;
  /** Whether any row of the schema, in any fixture tenant, changed. */
  written: boolean;
}

interface Mark {
  tenantTx: number;
  metadataTx: number;
  calls: number;
  published: number;
  fingerprint: string;
}

interface Probe {
  label: string;
  /** Builds the request, seeding any row it acts on; called once per subject. */
  request: () => ProbeRequest | Promise<ProbeRequest>;
  /** Subjects admitted: no 401, 403 or 5xx. */
  allow: readonly string[];
  /** Timesheet-role holders the auth hook admits and the lifecycle refuses: 403 after their token is consumed, nothing written. */
  lifecycleRefused?: readonly string[];
  /** Problems with an admitted answer and its effects. */
  checkAdmitted: (res: InjectResponse, effects: Effects) => string[];
  /** Sends the probe as `subject` instead of injecting the request with its credentials. */
  send?: (subject: RoleSubject, credentials: Record<string, string>, request: ProbeRequest) => Promise<InjectResponse>;
}

interface Declared {
  transport: Transport;
  requires?: readonly string[];
  public?: true;
}

interface Expectation {
  declared: Declared;
  /** Denied subjects answered 401; every other denied subject is answered 403. */
  deny401: readonly string[];
  probes: readonly Probe[];
}

interface ErrorBody {
  code: string;
  message: string;
}

function errorBody({ code, message }: ErrorBody): ErrorBody {
  return { code, message };
}

const FORBIDDEN = errorBody(LEGACY_ERROR_MAP.authorization);
const NOT_FOUND: ErrorBody = { code: 'invalid_request', message: 'Not Found' };
const INVALID_TOKENS = errorBody(LEGACY_ERROR_MAP.invalidTokens);

/** Error bodies a refusal may carry at each status. */
const DENIAL_ERRORS: Readonly<Record<401 | 403, readonly ErrorBody[]>> = {
  401: [LEGACY_ERROR_MAP.authorization, LEGACY_ERROR_MAP.invalidAccessToken].map(errorBody),
  403: [FORBIDDEN],
};

const NO_EFFECTS: Effects = { tenantTx: 0, metadataTx: 0, calls: [], published: 0, written: false };

let handle: ThrowawaySchema;
let repository: TimesheetsRepository;
let app: FastifyInstance;
let fingerprintSql = '';
let dayA = '';
const counts = { tenantTx: 0, metadataTx: 0 };
const calls: string[] = [];
const consumed: CsrfConsumeRequest[] = [];
const publisher = createCapturingPublisher();
/** Identity's answer to every consume call. */
let csrfVerdict: { status: number; valid: boolean } = { status: 200, valid: true };

const ENV = loadEnv(undefined, {
  PORT: '8118',
  OPT2_SERVICE_NAME: SERVICE,
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
  OPT2_TOKEN_ISSUER: 'opt2-local-identity',
  OPT2_TOKEN_AUDIENCE: 'opt2-local',
  TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

/** `db` with every transaction the routes open counted. */
function countingDb(db: TenantDb): TenantDb {
  const counted: TenantDb = {
    schema: db.schema,
    withTenant(tenantId, fn) {
      counts.tenantTx += 1;
      return db.withTenant(tenantId, fn);
    },
    withMetadata(fn, options) {
      counts.metadataTx += 1;
      return db.withMetadata(fn, options);
    },
    end: () => db.end(),
  };
  return Object.freeze(counted);
}

/** The timesheets service as its registrars compose it: service kit, routes, migration handlers and push consumers. */
async function composeApp(db: TenantDb): Promise<FastifyInstance> {
  const composed = await createService({
    name: SERVICE,
    version: VERSION,
    env: ENV,
    clock: CLOCK,
    verifierOverride: testVerifier(SERVICE),
    pool: db,
    logger: createLogger({ service: SERVICE, version: VERSION, env: 'local', destination: { write: () => undefined } }),
  });
  const repo = createTimesheetsRepository({ clock: CLOCK, schema: db.schema });
  registerWritePositionHeader(composed);
  registerRoutes(composed, { db, repository: repo, clock: CLOCK });
  registerMigrationHandlers(composed, { owner: SERVICE, repository: repo, mappings, units, db });
  registerConsumers(composed, { service: SERVICE, consumers: createConsumers({ repository: repo }), publisher, db });
  return composed;
}

/**
 * Reporting's confirmation of the running export job the matrix probes, and identity's consume verdict; any other service call is
 * a defect the matrix reports as a 5xx.
 */
function answer(request: ServiceRequest): ServiceResponse {
  calls.push(`${request.service} ${request.method} ${request.path}`);
  if (request.service === 'reporting' && request.method === 'GET' && request.path === EXPORT_SCOPE_PATH && request.userToken === null) {
    const scope = { exportId: EXPORT_ID, tenantId: TENANT_A.tenantId, siteId: SITE_A, source: 'timesheets.sheets', state: 'running', claim: EXPORT_CLAIM };
    return { status: 200, headers: {}, body: scope };
  }
  if (request.service !== IDENTITY_SERVICE || request.method !== 'POST' || request.path !== CSRF_CONSUME_PATH) {
    throw new Error(`timesheets calls no other service: ${request.method} ${request.service} ${request.path}`);
  }
  consumed.push(request.json as CsrfConsumeRequest);
  const { status, valid } = csrfVerdict;
  return { status, headers: {}, body: status === 200 ? { valid } : undefined };
}

/** Moves every timesheets gate to `state` through the holder compare-and-set. */
async function setGates(state: 'open' | 'legacy'): Promise<void> {
  await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'authz-test', allowLegacy: true });
  await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'authz-test', state });
}

function sheetRow(id: string, siteid: string, programId: number): Omit<TimesheetRow, 'tenant_id'> {
  return {
    timesheet_id: id,
    person_id: PERSON,
    siteid,
    period_start: new Date(2026, 5, 22),
    period_end: new Date(2026, 5, 28),
    due_date: new Date(2026, 6, 1),
    created: new Date(2026, 5, 21, 9, 0, 0),
    lastupdate: null,
    lastupdatebyid: null,
    legacy_program_id: programId,
  };
}

/** A fresh day in `state` on the tenant-a sheet; returns its id. */
async function seedDay(state: TimesheetState): Promise<string> {
  const dayId = cfUuid();
  const row: Omit<TimesheetDayRow, 'tenant_id'> = {
    day_id: dayId,
    timesheet_id: SHEET_A,
    work_date: new Date(2026, 5, 22),
    hours: '7.5000',
    state,
    lastupdate: null,
    lastupdatebyid: null,
    legacy_program_id: 1,
  };
  await handle.app.withTenant(TENANT_A.tenantId, (tx) => repository.insert(tx, 'timesheet_day', row));
  return dayId;
}

/** One digest per table of the throwaway schema, read under each fixture tenant. */
async function fingerprint(): Promise<string> {
  const digests: string[] = [];
  for (const tenant of TENANT_LIST) {
    const { rows } = await handle.app.withTenant(tenant.tenantId, (tx) => tx.query<{ t: string; h: string }>(fingerprintSql));
    digests.push(...rows.map(({ t, h }) => `${tenant.key}.${t}=${h}`));
  }
  return digests.join(' ');
}

async function mark(): Promise<Mark> {
  return { ...counts, calls: calls.length, published: publisher.published.length + publisher.raw.length, fingerprint: await fingerprint() };
}

async function effectsSince(from: Mark): Promise<Effects> {
  return {
    tenantTx: counts.tenantTx - from.tenantTx,
    metadataTx: counts.metadataTx - from.metadataTx,
    calls: calls.slice(from.calls),
    published: publisher.published.length + publisher.raw.length - from.published,
    written: (await fingerprint()) !== from.fingerprint,
  };
}

/** Injects `request` with `credentials`, appending `query` to its url. */
function inject(request: ProbeRequest, credentials: Record<string, string>, query: Record<string, string> = {}): Promise<InjectResponse> {
  const extra = new URLSearchParams(query).toString();
  const url = extra === '' ? request.url : `${request.url}${request.url.includes('?') ? '&' : '?'}${extra}`;
  return app.inject({
    method: request.method,
    url,
    headers: { ...request.headers, ...credentials },
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  });
}

/** Status, error body and effects of `request` sent with `credentials`. */
async function outcomeOf(
  request: ProbeRequest,
  credentials: Record<string, string>,
): Promise<{ status: number; error: ErrorBody | undefined; effects: Effects }> {
  const before = await mark();
  const res = await inject(request, credentials);
  return { status: res.statusCode, error: errorOf(res), effects: await effectsSince(before) };
}

/** User-token and gateway-invocation headers of a `roles` holder on `site`. */
async function userHeaders(roles: readonly string[], site: string = SITE_A): Promise<Record<string, string>> {
  const [user, gateway] = await Promise.all([
    mintUserToken({ sub: ACTOR_ID, sid: SESSION_ID, site, roles: ['system-user', ...roles] }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${gateway}` };
}

/** The `error` object of a legacy envelope response, or undefined when the body is not one. */
function errorOf(res: InjectResponse): ErrorBody | undefined {
  let body: unknown;
  try {
    body = JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : undefined;
}

function snippet(res: InjectResponse): string {
  return `${String(res.statusCode)} ${res.body.slice(0, 200)}`;
}

/** An admitted read: 200, nothing written, no token consumed. */
function readAnswered(res: InjectResponse, effects: Effects): string[] {
  const problems: string[] = [];
  if (res.statusCode !== 200) problems.push(`expected 200, got ${snippet(res)}`);
  if (effects.written || effects.calls.length > 0) problems.push(`a read left effects ${JSON.stringify(effects)}`);
  return problems;
}

/** An admitted export read: 200 once reporting confirms the job's scope, nothing written and no token consumed. */
function exportReadAnswered(res: InjectResponse, effects: Effects): string[] {
  const problems: string[] = [];
  if (res.statusCode !== 200) problems.push(`expected 200, got ${snippet(res)}`);
  if (effects.written || !isDeepStrictEqual(effects.calls, [SCOPE_LOOKUP])) problems.push(`an export read left effects ${JSON.stringify(effects)}`);
  return problems;
}

/** An admitted migration read: any status below 500 the matrix allows, nothing written. */
function migrationRead(_res: InjectResponse, effects: Effects): string[] {
  return effects.written ? ['a migration read wrote'] : [];
}

/** An admitted push: acknowledged and applied, never dead-lettered. */
function pushApplied(res: InjectResponse, effects: Effects): string[] {
  const problems: string[] = [];
  if (res.statusCode < 200 || res.statusCode > 299) problems.push(`expected an ack, got ${snippet(res)}`);
  if (effects.published > 0) problems.push(`the delivery was dead-lettered: ${JSON.stringify(publisher.raw.at(-1)?.topic)}`);
  return problems;
}

function noCheck(): string[] {
  return [];
}

/** An admitted request whose effective method is not its route's: notFound, with no transaction, consume, publish or write. */
function notFoundUntouched(res: InjectResponse, effects: Effects): string[] {
  const outcome = { status: res.statusCode, error: errorOf(res), effects };
  return isDeepStrictEqual(outcome, { status: 404, error: NOT_FOUND, effects: NO_EFFECTS })
    ? []
    : [`expected notFound with no effect, got ${JSON.stringify(outcome)} ${snippet(res)}`];
}

const PLAIN_GET: Tunnel = { method: 'GET' };
const PLAIN_POST: Tunnel = { method: 'POST' };
/** The tunnels legacy clients use for a fixture read by POST and a fixture write by GET. */
const READ_BY_POST: Tunnel = { method: 'POST', override: 'GET' };
const WRITE_BY_GET: Tunnel = { method: 'GET', override: 'POST' };

/** The tunnel's X-HTTP-Method-Override header; none without an override. */
function overrideHeaders({ override }: Tunnel): Readonly<Record<string, string>> {
  return override === undefined ? {} : { [METHOD_OVERRIDE]: override };
}

/** CSRF_HEADERS with the tunnel's override, when it sends one. */
function tunnelHeaders(tunnel: Tunnel): Readonly<Record<string, string>> {
  return { ...CSRF_HEADERS, ...overrideHeaders(tunnel) };
}

/** Label suffix naming the tunnel's override; none without one. */
function tunnelLabel({ override }: Tunnel): string {
  if (override === undefined) return '';
  return override === '' ? ', empty override' : `, override ${override}`;
}

/** A user-facing read admitted for `allow`, sent by `tunnel` with a CSRF pair that must not be consumed. */
function userRead(label: string, url: string, allow: readonly string[] = TIMESHEET_ROLES, tunnel: Tunnel = PLAIN_GET): Probe {
  return {
    label: `${label}${tunnelLabel(tunnel)}`,
    request: () => ({ method: tunnel.method, url, headers: tunnelHeaders(tunnel) }),
    allow,
    checkAdmitted: readAnswered,
  };
}

/** A fixture read sent by a tunnel that answers another effective method: every timesheets role admitted, then notFound. */
function readMismatch(label: string, url: string, tunnel: Tunnel): Probe {
  return {
    label: `${label}${tunnelLabel(tunnel)}, notFound`,
    request: () => ({ method: tunnel.method, url, headers: tunnelHeaders(tunnel) }),
    allow: TIMESHEET_ROLES,
    checkAdmitted: notFoundUntouched,
  };
}

/** A tenant-a day action request sent by `tunnel`, its comment in the body of a POST. */
function dayRequest(base: string, dayId: string, action: string, tunnel: Tunnel): ProbeRequest {
  return {
    method: tunnel.method,
    url: `${base}/${dayId}/${action}?${ON_SITE_A}`,
    headers: tunnelHeaders(tunnel),
    ...(tunnel.method === 'POST' ? { payload: COMMENT } : {}),
  };
}

/** A submit of a fresh DRAFT day sent by a tunnel that answers another effective method: notFound, the day left untouched. */
function dayMismatch(tunnel: Tunnel): Probe {
  return {
    label: `submit from DRAFT${tunnelLabel(tunnel)}, notFound`,
    request: async () => dayRequest(`${P}/days`, await seedDay('DRAFT'), 'submit', tunnel),
    allow: TIMESHEET_ROLES,
    checkAdmitted: notFoundUntouched,
  };
}

/** One probe per lifecycle row of `rows`, sent by `tunnel` on a fresh tenant-a day; `stateOf` reads the day's new state from the answer. */
function workflowProbes(base: string, stateOf: (body: unknown) => unknown, tunnel: Tunnel = PLAIN_POST, rows = WORKFLOW): Probe[] {
  return rows.map(({ action, from, role, to }) => ({
    label: `${action} from ${from}${tunnelLabel(tunnel)}`,
    request: async (): Promise<ProbeRequest> => dayRequest(base, await seedDay(from), action, tunnel),
    allow: [role],
    lifecycleRefused: TIMESHEET_ROLES.filter((held) => held !== role),
    checkAdmitted: (res, effects) => {
      const problems: string[] = [];
      if (res.statusCode !== 200 || stateOf(res.json()) !== to) problems.push(`expected 200 moving the day to ${to}, got ${snippet(res)}`);
      if (!effects.written || !isDeepStrictEqual(effects.calls, [CONSUME])) problems.push(`expected one consume and a write, got ${JSON.stringify(effects)}`);
      return problems;
    },
  }));
}

/** A contract-valid `programs-sites.site.changed.v1` envelope of tenant-a, its payload the fixture registry's. */
function siteChangedEnvelope(): EventEnvelope {
  const payload = registryPayloads().find((candidate) => candidate.siteId === SITE_A);
  if (payload === undefined) throw new TypeError(`registryPayloads has no ${SITE_A} payload`);
  return testEnvelope({ topic: 'programs-sites.site.changed.v1', tenantId: TENANT_A.tenantId, aggregateId: SITE_A, payload });
}

/** A `people.person.archived.v1` envelope of tenant-a for a person without timesheet days. */
function personArchivedEnvelope(): EventEnvelope {
  return testEnvelope({
    topic: PERSON_ARCHIVED_TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: ARCHIVED_PERSON,
    payload: {
      personId: ARCHIVED_PERSON,
      siteId: SITE_A,
      effectiveFrom: '2026-06-15 00:00:00.000',
      archiveId: cfUuid(),
      archivedAt: '2026-06-15 09:30:00.000',
    },
  });
}

/** A push body as Pub/Sub sends it, without the push key in the url. */
function pushRequest(url: string, subscription: string, envelope: EventEnvelope): ProbeRequest {
  const body = buildPushBody({ data: encodeEnvelope(envelope), messageId: randomUUID(), subscription });
  return { method: 'POST', url, payload: { ...body } };
}

/** A push route's probe: the invoker delivers through the local push key, everyone else with only its own credentials. */
function pushProbe(url: string, subscription: string, envelope: () => EventEnvelope): Probe {
  return {
    label: 'delivery',
    request: () => pushRequest(url, subscription, envelope()),
    allow: [PUBSUB_INVOKER_ROLE],
    checkAdmitted: pushApplied,
    send: (subject, credentials, request) =>
      subject.name === PUBSUB_INVOKER_ROLE ? pushTo(app, subscription, envelope()) : inject(request, credentials),
  };
}

/** A migration-kit route for the migration workload alone. */
function migrationRoute(request: ProbeRequest): Expectation {
  return {
    declared: { transport: 'service', requires: ['platform.migration'] },
    deny401: NO_INVOCATION,
    probes: [{ label: 'call', request: () => request, allow: ['service:migration'], checkAdmitted: request.method === 'GET' ? migrationRead : noCheck }],
  };
}

const FIXTURE_DAY_STATE = (body: unknown): unknown => (body as { data?: { state?: unknown } }).data?.state;
const V1_DAY_STATE = (body: unknown): unknown => (body as { toState?: unknown }).toState;
const TIMESHEET_ROUTE: Declared = { transport: 'service', requires: TIMESHEET_ROLES };
const FIXTURE_LIST = `${P}/sheets?${ON_SITE_A}&asOf=${AS_OF}`;
const FIXTURE_DETAIL = `${P}/sheets/${SHEET_A}?${ON_SITE_A}`;
const FIXTURE_STATUS = `${P}/sheets/${SHEET_A}/status?${ON_SITE_A}`;

/** Probes of a fixture read sent by GET: answered with no or an empty override, notFound overridden to POST. */
function readByGet(label: string, url: string): Probe[] {
  return [
    userRead(label, url),
    userRead(label, url, TIMESHEET_ROLES, { method: 'GET', override: '' }),
    readMismatch(label, url, { method: 'GET', override: 'POST' }),
  ];
}

/** Probes of a fixture read sent by POST: answered overridden to GET, notFound with no or an empty override. */
function readByPost(label: string, url: string): Probe[] {
  return [
    userRead(label, url, TIMESHEET_ROLES, READ_BY_POST),
    readMismatch(label, url, PLAIN_POST),
    readMismatch(label, url, { method: 'POST', override: '' }),
  ];
}

/** Every route the composition registers, keyed `<METHOD> <fastify url>`, with its declaration and tenant-a probes. */
const EXPECTED: Readonly<Record<string, Expectation>> = {
  'GET /healthz': {
    declared: { transport: 'service', public: true },
    // A tasks-invoker token in Authorization is verified, and refused, as a user token.
    deny401: ['service:tasks-invoker'],
    probes: [{ label: 'liveness', request: () => ({ method: 'GET', url: '/healthz' }), allow: everyoneBut('service:tasks-invoker'), checkAdmitted: readAnswered }],
  },
  [`POST ${ARCHIVE_PUSH}`]: {
    declared: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
    deny401: everyoneBut(PUBSUB_INVOKER_ROLE),
    probes: [pushProbe(ARCHIVE_PUSH, PERSON_ARCHIVED_SUBSCRIPTION, personArchivedEnvelope)],
  },
  [`POST ${SITE_PUSH}`]: {
    declared: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
    deny401: everyoneBut(PUBSUB_INVOKER_ROLE),
    probes: [pushProbe(SITE_PUSH, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope)],
  },
  [`POST ${MIGRATION}/apply`]: migrationRoute({ method: 'POST', url: `${MIGRATION}/apply`, payload: {} }),
  [`GET ${MIGRATION}/changes`]: migrationRoute({ method: 'GET', url: `${MIGRATION}/changes?tenantId=${TENANT_A.tenantId}` }),
  [`GET ${MIGRATION}/export`]: migrationRoute({ method: 'GET', url: `${MIGRATION}/export?unit=timesheets.timesheet&tenantId=${TENANT_A.tenantId}` }),
  [`POST ${MIGRATION}/gate`]: migrationRoute({ method: 'POST', url: `${MIGRATION}/gate`, payload: {} }),
  [`GET ${MIGRATION}/position`]: migrationRoute({ method: 'GET', url: `${MIGRATION}/position` }),
  [`GET ${MIGRATION}/watermark`]: migrationRoute({ method: 'GET', url: `${MIGRATION}/watermark` }),
  [`POST ${MIGRATION}/watermark`]: migrationRoute({ method: 'POST', url: `${MIGRATION}/watermark`, payload: {} }),
  [`POST ${P}/days/:id/:action`]: {
    declared: TIMESHEET_ROUTE,
    deny401: NO_USER,
    probes: [
      ...workflowProbes(`${P}/days`, FIXTURE_DAY_STATE),
      ...workflowProbes(`${P}/days`, FIXTURE_DAY_STATE, { method: 'POST', override: '' }, WORKFLOW.slice(0, 1)),
      dayMismatch({ method: 'POST', override: 'GET' }),
    ],
  },
  [`GET ${P}/days/:id/:action`]: {
    declared: TIMESHEET_ROUTE,
    deny401: NO_USER,
    probes: [
      ...workflowProbes(`${P}/days`, FIXTURE_DAY_STATE, WRITE_BY_GET),
      dayMismatch(PLAIN_GET),
      dayMismatch({ method: 'GET', override: '' }),
    ],
  },
  [`GET ${P}/sheets`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: readByGet('list', FIXTURE_LIST) },
  [`POST ${P}/sheets`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: readByPost('list', FIXTURE_LIST) },
  [`GET ${P}/sheets/:id`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: readByGet('detail', FIXTURE_DETAIL) },
  [`POST ${P}/sheets/:id`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: readByPost('detail', FIXTURE_DETAIL) },
  [`GET ${P}/sheets/:id/status`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: readByGet('status', FIXTURE_STATUS) },
  [`POST ${P}/sheets/:id/status`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: readByPost('status', FIXTURE_STATUS) },
  [`POST ${V1}/days/:id/:action`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: workflowProbes(`${V1}/days`, V1_DAY_STATE) },
  [`GET ${V1}/sheet-status`]: {
    declared: { transport: 'service', requires: STATUS_ROLES },
    deny401: NO_USER,
    probes: [userRead('status rows', `${V1}/sheet-status?${ON_SITE_A}&asOf=${AS_OF}`, STATUS_ROLES)],
  },
  [`GET ${V1}/sheets`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: [userRead('list', `${V1}/sheets?${ON_SITE_A}&asOf=${AS_OF}`)] },
  // Reporting's export runs act as System: the sheet status read admits its workload credential alone, for the job reporting confirms.
  [`GET ${EXPORT_READ}`]: {
    declared: { transport: 'service', requires: ['service:reporting'] },
    deny401: NO_INVOCATION,
    probes: [
      {
        label: 'export status rows',
        request: () => ({
          method: 'GET',
          url: `${EXPORT_READ}?exportId=${EXPORT_ID}&siteId=${SITE_A}&claim=${EXPORT_CLAIM}&asOf=${AS_OF}&pageIndex=1&itemsPerPage=50`,
        }),
        allow: ['service:reporting'],
        checkAdmitted: exportReadAnswered,
      },
    ],
  },
  [`GET ${V1}/sheets/:id`]: { declared: TIMESHEET_ROUTE, deny401: NO_USER, probes: [userRead('detail', `${V1}/sheets/${SHEET_A}?${ON_SITE_A}`)] },
};

/** What an auth-hook refusal leaves: nothing, except the fixture renderer's registry read behind a 403. */
function hookDenialEffects(url: string, status: number): Effects {
  return { ...NO_EFFECTS, metadataTx: url.startsWith(P) && status === 403 ? 1 : 0 };
}

/** Every way one probe sent as one subject departs from its expectation. */
async function mismatchesOf(key: string, entry: Expectation, probe: Probe, subject: RoleSubject): Promise<string[]> {
  const request = await probe.request();
  const credentials = await authHeadersFor(subject, { audience: SERVICE, site: SITE_A, sub: ACTOR_ID });
  const before = await mark();
  const res = probe.send === undefined ? await inject(request, credentials, subjectQueryFor(subject)) : await probe.send(subject, credentials, request);
  const effects = await effectsSince(before);
  const at = `${key} ${probe.label} as ${subject.name}`;
  const denied = res.statusCode === 401 || res.statusCode === 403;

  if (probe.allow.includes(subject.name)) {
    if (denied || res.statusCode >= 500) return [`${at}: expected admission, got ${snippet(res)}`];
    return probe.checkAdmitted(res, effects).map((problem) => `${at}: ${problem}`);
  }
  if (probe.lifecycleRefused?.includes(subject.name) === true) {
    const outcome = { status: res.statusCode, error: errorOf(res), calls: effects.calls, published: effects.published, written: effects.written };
    const expected = { status: 403, error: FORBIDDEN, calls: [CONSUME], published: 0, written: false };
    return isDeepStrictEqual(outcome, expected) ? [] : [`${at}: expected the lifecycle's 403, got ${JSON.stringify(outcome)} ${snippet(res)}`];
  }
  const problems: string[] = [];
  const status = entry.deny401.includes(subject.name) ? 401 : 403;
  if (res.statusCode !== status) problems.push(`${at}: expected ${String(status)}, got ${snippet(res)}`);
  const error = errorOf(res);
  if (error === undefined || !DENIAL_ERRORS[status].some((allowed) => isDeepStrictEqual(allowed, error))) {
    problems.push(`${at}: unexpected denial body ${res.body.slice(0, 200)}`);
  }
  if (!isDeepStrictEqual(effects, hookDenialEffects(request.url, status))) problems.push(`${at}: denial left effects ${JSON.stringify(effects)}`);
  return problems;
}

/** `<METHOD> <url>` of a route. */
function keyOf(route: Pick<RouteMatrixEntry, 'method' | 'url'>): string {
  return `${route.method} ${route.url}`;
}

/** A declaration in comparable form: `requires` sorted, defaults dropped. */
function comparable(declared: { transport?: unknown; requires?: unknown; public?: unknown }): Record<string, unknown> {
  return {
    transport: declared.transport,
    ...(Array.isArray(declared.requires) ? { requires: [...(declared.requires as string[])].sort() } : {}),
    ...(declared.public === true ? { public: true } : {}),
  };
}

const HTTP_METHODS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

/** Every operation contracts/openapi.yaml declares, keyed as Fastify registers it. */
function contractDeclarations(): Record<string, Record<string, unknown>> {
  const declared: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(OPENAPI.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      declared[`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`] = comparable({
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
        public: operation['x-opt2-public'],
      });
    }
  }
  return declared;
}

const available = await pgAvailable();

describe.skipIf(!available)('timesheets authorisation', () => {
  /** Releases what beforeAll acquired, most recent first, including after a failed setup. */
  const releases: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    releases.unshift(() => handle.drop());
    await ensureUnitGates(handle.app, TIMESHEETS_UNITS);
    await seedRegistry(handle.app);
    repository = createTimesheetsRepository({ clock: CLOCK, schema: handle.schema });
    app = await composeApp(countingDb(handle.app));
    releases.unshift(() => app.opt2.shutdown());
    await app.ready();
    vi.spyOn(app.opt2.client, 'request').mockImplementation((request: ServiceRequest) => Promise.resolve(answer(request)));
    await setGates('open');

    const { rows } = await handle.adminPool.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
      [handle.schema],
    );
    fingerprintSql = rows
      .map(({ tablename }) => `SELECT '${tablename}' AS t, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${handle.schema}.${tablename} x`)
      .join(' UNION ALL ');
    fingerprintSql = `SELECT t, h FROM (${fingerprintSql}) f ORDER BY t`;

    await handle.app.withTenant(TENANT_A.tenantId, (tx) => repository.insert(tx, 'timesheet', sheetRow(SHEET_A, SITE_A, 1)));
    await handle.app.withTenant(TENANT_B.tenantId, (tx) => repository.insert(tx, 'timesheet', sheetRow(SHEET_B, SITE_B, 2)));
    dayA = await seedDay('DRAFT');
  });

  afterAll(async () => {
    for (const release of releases) await release();
  });

  beforeEach(() => {
    csrfVerdict = { status: 200, valid: true };
  });

  describe('route declarations', () => {
    it('registers exactly the expected routes, each once', () => {
      const registered = collectRouteMatrix(app).routes.map(keyOf);
      const expected = Object.keys(EXPECTED);
      expect({
        missing: registered.filter((key) => !expected.includes(key)),
        extra: expected.filter((key) => !registered.includes(key)),
        duplicated: registered.filter((key, index) => registered.indexOf(key) !== index),
      }).toEqual({ missing: [], extra: [], duplicated: [] });
    });

    it('declares each route with its expected transport, roles and public flag, site-checked', () => {
      const routes = collectRouteMatrix(app).routes;
      expect(Object.fromEntries(routes.map((route) => [keyOf(route), comparable(route)]))).toEqual(
        Object.fromEntries(Object.entries(EXPECTED).map(([key, entry]) => [key, comparable(entry.declared)])),
      );
      expect(routes.filter((route) => !route.siteCheck).map(keyOf)).toEqual([]);
    });

    it('declares every route exactly as contracts/openapi.yaml does', () => {
      expect(Object.fromEntries(collectRouteMatrix(app).routes.map((route) => [keyOf(route), comparable(route)]))).toEqual(contractDeclarations());
    });

    it('probes exactly the ROLE_SET subjects, naming only them', () => {
      expect(ROLE_SET.map((subject) => subject.name).sort()).toEqual([...EVERYONE].sort());
      const named = Object.values(EXPECTED).flatMap((entry) => [
        ...entry.deny401,
        ...entry.probes.flatMap((probe) => [...probe.allow, ...(probe.lifecycleRefused ?? [])]),
      ]);
      const overlapping = Object.entries(EXPECTED).flatMap(([key, entry]) =>
        entry.probes.flatMap((probe) => probe.allow.filter((name) => entry.deny401.includes(name)).map((name) => `${key}: ${name}`)),
      );
      expect({ unknown: named.filter((name) => !EVERYONE.includes(name)), overlapping }).toEqual({ unknown: [], overlapping: [] });
    });
  });

  describe('route admission', () => {
    for (const [key, entry] of Object.entries(EXPECTED)) {
      for (const probe of entry.probes) {
        it(`admits exactly the expected subjects on ${key} (${probe.label}), and denials leave no effect`, async () => {
          const mismatches: string[] = [];
          for (const subject of ROLE_SET) mismatches.push(...(await mismatchesOf(key, entry, probe, subject)));
          expect(mismatches).toEqual([]);
        });
      }
    }
  });

  describe('CSRF on day actions', () => {
    const routes: ReadonlyArray<[string, string, Tunnel]> = [
      ['fixture', `${P}/days`, PLAIN_POST],
      ['tunnelled fixture', `${P}/days`, WRITE_BY_GET],
      ['/v1', `${V1}/days`, PLAIN_POST],
    ];

    /** A tenant-a `action` of `dayId` sent by `tunnel`, with the CSRF pair unless `csrf` is false. */
    const dayAction = (base: string, tunnel: Tunnel, dayId: string, action: string, csrf = true): ProbeRequest => ({
      method: tunnel.method,
      url: `${base}/${dayId}/${action}?${ON_SITE_A}`,
      headers: csrf ? tunnelHeaders(tunnel) : overrideHeaders(tunnel),
    });

    it.each(routes)('has identity consume the %s pair in the token session for the day id as sent, before the write', async (_label, base, tunnel) => {
      const dayId = (await seedDay('DRAFT')).toLowerCase();
      const before = consumed.length;
      const outcome = await outcomeOf(dayAction(base, tunnel, dayId, 'submit'), await userHeaders([EMPLOYEE]));
      expect([outcome.status, outcome.effects.written]).toEqual([200, true]);
      expect(consumed.slice(before)).toEqual([
        { sessionId: SESSION_ID, token: CSRF_HEADERS['x-csrf_token'], expires: CSRF_HEADERS['x-csrf_token_expires'], context: dayId },
      ]);
    });

    it.each(routes)('refuses a %s write without a token, consuming and writing nothing', async (_label, base, tunnel) => {
      const outcome = await outcomeOf(dayAction(base, tunnel, await seedDay('DRAFT'), 'submit', false), await userHeaders([EMPLOYEE]));
      expect({ status: outcome.status, error: outcome.error, calls: outcome.effects.calls, written: outcome.effects.written }).toEqual({
        status: 400,
        error: INVALID_TOKENS,
        calls: [],
        written: false,
      });
    });

    it.each(routes)('refuses a %s write whose token identity rejects, writing nothing', async (_label, base, tunnel) => {
      csrfVerdict = { status: 200, valid: false };
      const outcome = await outcomeOf(dayAction(base, tunnel, await seedDay('DRAFT'), 'submit'), await userHeaders([EMPLOYEE]));
      expect({ status: outcome.status, error: outcome.error, calls: outcome.effects.calls, written: outcome.effects.written }).toEqual({
        status: 400,
        error: INVALID_TOKENS,
        calls: [CONSUME],
        written: false,
      });
    });

    it.each(routes)('fails a %s write closed when identity cannot consume the token', async (_label, base, tunnel) => {
      csrfVerdict = { status: 503, valid: false };
      const outcome = await outcomeOf(dayAction(base, tunnel, await seedDay('DRAFT'), 'submit'), await userHeaders([EMPLOYEE]));
      expect({ status: outcome.status, calls: outcome.effects.calls, written: outcome.effects.written }).toEqual({ status: 503, calls: [CONSUME], written: false });
    });

    it.each(routes)('consumes no %s token for an action the lifecycle does not name', async (_label, base, tunnel) => {
      const outcome = await outcomeOf(dayAction(base, tunnel, dayA, 'approve'), await userHeaders([EMPLOYEE]));
      expect({ status: outcome.status, error: outcome.error, effects: { ...outcome.effects, tenantTx: 0, metadataTx: 0 } }).toEqual({
        status: 404,
        error: NOT_FOUND,
        effects: NO_EFFECTS,
      });
    });
  });

  describe('site boundary', () => {
    /** A tenant-a request of each user route, sent by a holder of a role the route admits. */
    const requests = (): Array<[string, ProbeRequest, string]> => [
      ['fixture list', { method: 'GET', url: `${P}/sheets` }, EMPLOYEE],
      ['fixture detail', { method: 'GET', url: `${P}/sheets/${SHEET_A}` }, EMPLOYEE],
      ['fixture status', { method: 'GET', url: `${P}/sheets/${SHEET_A}/status` }, EMPLOYEE],
      ['fixture day action', { method: 'POST', url: `${P}/days/${dayA}/submit`, headers: CSRF_HEADERS }, EMPLOYEE],
      ['fixture list by POST', { method: 'POST', url: `${P}/sheets`, headers: overrideHeaders(READ_BY_POST) }, EMPLOYEE],
      ['fixture detail by POST', { method: 'POST', url: `${P}/sheets/${SHEET_A}`, headers: overrideHeaders(READ_BY_POST) }, EMPLOYEE],
      ['fixture status by POST', { method: 'POST', url: `${P}/sheets/${SHEET_A}/status`, headers: overrideHeaders(READ_BY_POST) }, EMPLOYEE],
      ['fixture day action by GET', { method: 'GET', url: `${P}/days/${dayA}/submit`, headers: tunnelHeaders(WRITE_BY_GET) }, EMPLOYEE],
      ['/v1 list', { method: 'GET', url: `${V1}/sheets` }, EMPLOYEE],
      ['/v1 detail', { method: 'GET', url: `${V1}/sheets/${SHEET_A}` }, EMPLOYEE],
      ['/v1 sheet status', { method: 'GET', url: `${V1}/sheet-status` }, EXPORTER],
      ['/v1 day action', { method: 'POST', url: `${V1}/days/${dayA}/submit`, headers: CSRF_HEADERS }, EMPLOYEE],
    ];

    it.each<[string, string]>([
      ['another site', `siteid=${SITE_B}`],
      ['another site in upper case beside its own', `siteid=${SITE_A}&siteid=${SITE_B.toUpperCase()}`],
    ])('refuses a tenant-a token naming %s on every user route before any read, consume or write', async (_label, query) => {
      for (const [label, request, role] of requests()) {
        const outcome = await outcomeOf({ ...request, url: `${request.url}?${query}` }, await userHeaders([role]));
        expect({ label, ...outcome }).toEqual({ label, status: 403, error: FORBIDDEN, effects: NO_EFFECTS });
      }
    });

    it('refuses a siteid of another site carried in a POST body', async () => {
      for (const [label, request, role] of requests().filter(([, { method }]) => method === 'POST')) {
        const outcome = await outcomeOf({ ...request, payload: { ...COMMENT, siteid: SITE_B } }, await userHeaders([role]));
        expect({ label, ...outcome }).toEqual({ label, status: 403, error: FORBIDDEN, effects: NO_EFFECTS });
      }
    });

    it('refuses a tenant-b token naming tenant-a, so no token selects another tenant', async () => {
      for (const [label, request, role] of requests()) {
        const outcome = await outcomeOf({ ...request, url: `${request.url}?${ON_SITE_A}` }, await userHeaders([role], SITE_B));
        expect({ label, ...outcome }).toEqual({ label, status: 403, error: FORBIDDEN, effects: NO_EFFECTS });
      }
    });
  });

  describe('tenant boundary', () => {
    it.each<[string, string, Tunnel]>([
      ['fixture detail', `${P}/sheets/${SHEET_A}`, PLAIN_GET],
      ['fixture detail by POST', `${P}/sheets/${SHEET_A}`, READ_BY_POST],
      ['fixture status', `${P}/sheets/${SHEET_A}/status`, PLAIN_GET],
      ['fixture status by POST', `${P}/sheets/${SHEET_A}/status`, READ_BY_POST],
      ['/v1 detail', `${V1}/sheets/${SHEET_A}`, PLAIN_GET],
    ])("answers a tenant-b employee's %s of a tenant-a sheet notFound", async (_label, url, tunnel) => {
      const outcome = await outcomeOf({ method: tunnel.method, url, headers: overrideHeaders(tunnel) }, await userHeaders([EMPLOYEE], SITE_B));
      expect({ status: outcome.status, error: outcome.error, written: outcome.effects.written }).toEqual({ status: 404, error: NOT_FOUND, written: false });
    });

    it.each<[string, string, Tunnel]>([
      ['fixture', `${P}/days`, PLAIN_POST],
      ['tunnelled fixture', `${P}/days`, WRITE_BY_GET],
      ['/v1', `${V1}/days`, PLAIN_POST],
    ])("answers a tenant-b employee's %s submit of a tenant-a day notFound, leaving it unchanged", async (_label, base, tunnel) => {
      const outcome = await outcomeOf({ method: tunnel.method, url: `${base}/${dayA}/submit`, headers: tunnelHeaders(tunnel) }, await userHeaders([EMPLOYEE], SITE_B));
      expect({ status: outcome.status, error: outcome.error, written: outcome.effects.written }).toEqual({ status: 404, error: NOT_FOUND, written: false });
    });

    const fixtureIds = (body: unknown): unknown[] => (body as { data: { items: Array<{ timesheet_id: string }> } }).data.items.map((item) => item.timesheet_id);
    const v1Ids = (body: unknown): unknown[] => (body as { items: Array<{ timesheetId: string }> }).items.map((item) => item.timesheetId);

    it.each<[string, string, Tunnel, string, (body: unknown) => unknown[]]>([
      ['fixture list', `${P}/sheets`, PLAIN_GET, EMPLOYEE, fixtureIds],
      ['fixture list by POST', `${P}/sheets`, READ_BY_POST, EMPLOYEE, fixtureIds],
      ['/v1 list', `${V1}/sheets`, PLAIN_GET, EMPLOYEE, v1Ids],
      ['/v1 sheet status', `${V1}/sheet-status`, PLAIN_GET, EXPORTER, v1Ids],
    ])('lists only the tenant-b sheets on the tenant-b %s', async (_label, url, tunnel, role, idsOf) => {
      const res = await inject({ method: tunnel.method, url, headers: overrideHeaders(tunnel) }, await userHeaders([role], SITE_B));
      expect([res.statusCode, idsOf(res.json())]).toEqual([200, [SHEET_B]]);
    });
  });

  describe('transport separation', () => {
    /** A read and a day action of each user transport: fixture, tunnelled fixture and /v1. */
    const userRoutes = (): ProbeRequest[] => [
      { method: 'GET', url: `${P}/sheets?${ON_SITE_A}` },
      { method: 'POST', url: `${P}/days/${dayA}/submit?${ON_SITE_A}`, headers: CSRF_HEADERS },
      { method: 'POST', url: `${P}/sheets?${ON_SITE_A}`, headers: overrideHeaders(READ_BY_POST) },
      { method: 'GET', url: `${P}/days/${dayA}/submit?${ON_SITE_A}`, headers: tunnelHeaders(WRITE_BY_GET) },
      { method: 'GET', url: `${V1}/sheets?${ON_SITE_A}` },
      { method: 'POST', url: `${V1}/days/${dayA}/submit?${ON_SITE_A}`, headers: CSRF_HEADERS },
    ];
    /** userRoutes and a migration route. */
    const serviceRoutes = (): ProbeRequest[] => [...userRoutes(), { method: 'GET', url: `${MIGRATION}/position` }];
    const pushes = (): ProbeRequest[] => [
      pushRequest(SITE_PUSH, SITE_CHANGED_SUBSCRIPTION, siteChangedEnvelope()),
      pushRequest(ARCHIVE_PUSH, PERSON_ARCHIVED_SUBSCRIPTION, personArchivedEnvelope()),
    ];
    const withPushKey = (request: ProbeRequest, key: string = TEST_PUSH_KEY): ProbeRequest => ({
      ...request,
      url: `${request.url}${request.url.includes('?') ? '&' : '?'}${pushKeyQuery(key)}`,
    });

    async function expectRefused(requests: readonly ProbeRequest[], credentials: Record<string, string>, status = 401): Promise<void> {
      for (const request of requests) {
        const { status: got, effects } = await outcomeOf(request, credentials);
        expect({ url: request.url, status: got, effects }).toEqual({ url: request.url, status, effects: NO_EFFECTS });
      }
    }

    it.each([EMPLOYEE, 's2'])('refuses the %s user token on the push routes, even beside the push key', async (role) => {
      const credentials = await userHeaders([role]);
      await expectRefused([...pushes(), ...pushes().map((request) => withPushKey(request))], credentials);
    });

    it('refuses a wrong push key on the push routes', async () => {
      await expectRefused(pushes().map((request) => withPushKey(request, `${TEST_PUSH_KEY}-wrong`)), {});
    });

    it('refuses a tasks-invoker token on the service routes, with or without the gateway invocation credential', async () => {
      const tasks = `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`;
      const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
      await expectRefused(serviceRoutes(), { authorization: tasks });
      await expectRefused(serviceRoutes(), { authorization: tasks, [INVOCATION_HEADER]: gateway });
    });

    it('refuses the push key on the service routes, alone or beside the gateway invocation credential', async () => {
      const gateway = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`;
      await expectRefused(serviceRoutes().map((request) => withPushKey(request)), {});
      await expectRefused(userRoutes().map((request) => withPushKey(request)), { [INVOCATION_HEADER]: gateway });
    });

    it('refuses a user token sent without, or with a misaddressed, invocation credential', async () => {
      const { authorization = '' } = await userHeaders([EMPLOYEE]);
      const misaddressed = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'finance' })}`;
      await expectRefused(userRoutes(), { authorization });
      await expectRefused(userRoutes(), { authorization, [INVOCATION_HEADER]: misaddressed });
    });

    it.each<[string, ProbeRequest, number]>([
      ['the fixture list', { method: 'GET', url: `${P}/sheets` }, 401],
      ['a fixture day action', { method: 'POST', url: `${P}/days/${UNKNOWN_DAY}/submit`, headers: CSRF_HEADERS }, 401],
      ['the fixture list by POST', { method: 'POST', url: `${P}/sheets`, headers: overrideHeaders(READ_BY_POST) }, 401],
      ['a fixture day action by GET', { method: 'GET', url: `${P}/days/${UNKNOWN_DAY}/submit`, headers: tunnelHeaders(WRITE_BY_GET) }, 401],
      ['the /v1 list', { method: 'GET', url: `${V1}/sheets` }, 403],
      ['a /v1 day action', { method: 'POST', url: `${V1}/days/${UNKNOWN_DAY}/submit`, headers: CSRF_HEADERS }, 403],
      ['/v1 sheet status', { method: 'GET', url: `${V1}/sheet-status` }, 403],
    ])('refuses %s to a workload credential carrying the user role without a user token', async (_label, request, status) => {
      const role = request.url.endsWith('sheet-status') ? EXPORTER : EMPLOYEE;
      const workload = `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE, roles: [role] })}`;
      await expectRefused([request], { [INVOCATION_HEADER]: workload }, status);
    });
  });

  describe('deny by default at start-up', () => {
    it.each<[string, string, Opt2RouteConfig | undefined]>([
      ['declares no config.opt2', `${V1}/__undeclared`, undefined],
      ['declares an empty requires list', `${V1}/__empty`, { requires: [] }],
      ['declares both requires and public', `${P}/__both`, { requires: [EMPLOYEE], public: true }],
      ['is a public push route', '/internal/v1/events/timesheets.__public', { public: true, transport: 'pubsub-push' }],
      ['declares the service transport on a push path', '/internal/v1/events/timesheets.__service', { transport: 'service', requires: [EMPLOYEE] }],
    ])('fails start-up of the composed service when a route %s', async (_label, url, opt2) => {
      let composed: FastifyInstance | undefined;
      try {
        const startUp = (async () => {
          composed = await composeApp(handle.app);
          composed.get(url, opt2 === undefined ? {} : { config: { opt2 } }, () => Promise.resolve({}));
          await composed.ready();
        })();
        await expect(startUp).rejects.toBeInstanceOf(UndeclaredRouteError);
      } finally {
        await composed?.close().catch(() => undefined);
      }
    });
  });
});
